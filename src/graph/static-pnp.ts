/** Yarn 정적 metadata와 ZIP에만 의존하는 compiler filesystem/resolution adapter다. */
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';
import { readBoundedFileBytes } from './bounded-config-reader.ts';
import { parsePnpJson } from './pnp-json.ts';
import { parseInlinePnp } from './pnp-inline.ts';
import { PNP_ZIP_LIMITS, readPnpZip, type PnpZip } from './pnp-zip.ts';

/** compiler 문맥 하나의 metadata·archive·전체 해제 byte 상한이다. */
export const PNP_LIMITS = { metadataBytes: 4 * 1024 * 1024, packages: 10_000, dependencies: 100_000,
  archives: 32, archiveBytes: 128 * 1024 * 1024, expandedBytes: 64 * 1024 * 1024 } as const;

const STANDARD_SDK_IGNORE = "(^(?:\\.yarn\\/sdks(?:\\/(?!\\.{1,2}(?:\\/|$))(?:(?:(?!(?:^|\\/)\\.{1,2}(?:\\/|$)).)*?)|$))$)";

type Dependency = string | readonly [string, string] | null;
interface Package { name: string | null; reference: string | null; location: string; dependencies: Map<string, Dependency>; discard: boolean }
interface Manifest { packages: Map<string, Package>; lookup: Map<string, Package[]>; fallback: Map<string, Dependency>; exclusions: Set<string>; enabledFallback: boolean }

/** 알려진 실패 code만 한계에 싣고 프로젝트 경로나 metadata 원문은 노출하지 않는다. */
export type PnpIssue = 'metadata-invalid' | 'ignore-pattern-unsupported' | 'ambiguous-owner' | 'outside-boundary'
  | 'archive-invalid' | 'archive-budget' | 'input-unreadable' | 'missing-dependency' | 'locator-mismatch';

/** loader 실행 없이 metadata가 있는 프로젝트의 소스/타입 읽기를 준비한다. */
export class StaticPnp {
  readonly issues: PnpIssue[] = [];
  readonly active: boolean;
  readonly loaderOnly: boolean;
  private readonly boundary: string;
  private readonly folder: string;
  private readonly sdk = realpathSync(dirname(ts.getDefaultLibFilePath({})));
  private manifest: Manifest | undefined;
  private ignoreSdk = false;
  private readonly aliases = new Map<string, string>();
  private readonly aliasDirectories = new Set<string>();
  private readonly resolutions = new Map<string, string>();
  private readonly archives = new Map<string, PnpZip | undefined>();
  private archiveBytes = 0;
  private expandedBytes = 0;

  constructor(root: string, boundary = root) {
    this.boundary = realpathSync(boundary);
    const folder = manifestFolder(realpathSync(root), this.boundary);
    this.folder = folder ?? realpathSync(root);
    this.active = folder !== undefined;
    this.loaderOnly = false;
    if (!this.active) return;
    const separateData = existsSync(join(this.folder, '.pnp.data.json'));
    try {
      const path = join(this.folder, separateData ? '.pnp.data.json' : '.pnp.cjs');
      const physical = this.confined(path);
      if (physical === undefined || lstatSync(path).isSymbolicLink()) throw new Error();
      const read = readBoundedFileBytes(physical, PNP_LIMITS.metadataBytes, { noFollow: true });
      if (this.confined(path) !== physical) throw new Error();
      if (!read.ok) throw new Error();
      const text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
      const parsed = separateData ? parsePnpJson(text) : parseInlinePnp(text);
      if (!record(parsed)) throw new Error();
      this.ignoreSdk = parsed['ignorePatternData'] === STANDARD_SDK_IGNORE;
      if (parsed['ignorePatternData'] !== undefined && parsed['ignorePatternData'] !== null && !this.ignoreSdk) {
        this.note('ignore-pattern-unsupported'); return;
      }
      this.manifest = parseManifest(parsed, this.folder);
    } catch { this.loaderOnly = !separateData; this.note('metadata-invalid'); }
  }

  /** TypeScript의 exports/typesVersions/import·require 조건을 synthetic node_modules 경유로 보존한다. */
  resolveModule(name: string, issuer: string, options: ts.CompilerOptions, host: ts.ModuleResolutionHost, mode?: ts.ResolutionMode): ts.ResolvedModuleFull | undefined {
    if (this.active && (name.length > 4_096 || issuer.length > 16_384)) { this.note('input-unreadable'); return undefined; }
    const wrapped = this.wrapHost(host);
    if (this.ignoreSdk && relative(this.folder, issuer).split(sep).join('/').startsWith('.yarn/sdks/')) return ts.resolveModuleName(name, issuer, options, wrapped, undefined, undefined, mode).resolvedModule;
    if (!this.active || name.startsWith('.') || name.startsWith('/') || name.startsWith('#') || name.startsWith('node:') || isAbsolute(name)) return ts.resolveModuleName(name, issuer, options, wrapped, undefined, undefined, mode).resolvedModule;
    // 프로젝트가 명시한 별칭은 PnP 의존성 표가 불완전해도 독립적으로 검증할 수 있다.
    if (options.paths !== undefined || options.baseUrl !== undefined) {
      const alias = ts.resolveModuleName(name, issuer, options, wrapped, undefined, undefined, mode).resolvedModule;
      if (alias !== undefined && alias.isExternalLibraryImport !== true && within(this.boundary, this.logical(alias.resolvedFileName))) return alias;
    }
    const ident = bareIdent(name);
    if (ident === undefined) return undefined;
    if (this.manifest === undefined) return undefined;
    const owner = this.owner(issuer);
    if (owner === undefined) return undefined;
    const target = this.dependency(owner, ident);
    if (target === undefined) {
      this.note('missing-dependency'); return undefined;
    }
    const entry = this.overlay(owner, ident, target);
    const result = ts.resolveModuleName(name, entry, options, wrapped, undefined, undefined, mode).resolvedModule;
    if (result === undefined) { this.note('missing-dependency'); return undefined; }
    const logical = this.logical(result.resolvedFileName);
    // TypeScript가 손상/누락된 overlay 뒤 실제 node_modules의 다른 버전으로 올라가면 채택하지 않는다.
    // 명시 paths/baseUrl의 프로젝트 alias는 원래 우선순위를 유지한다.
    if (result.isExternalLibraryImport === true && !within(target.location, logical)) { this.note('locator-mismatch'); return undefined; }
    const { packageId: _packageId, ...identity } = result;
    return { ...identity, resolvedFileName: logical };
  }

  /** 명시/삼중 슬래시 @types 조회에도 issuer의 의존성 신원을 사용한다. */
  resolveType(name: string, issuer: string, options: ts.CompilerOptions, host: ts.ModuleResolutionHost, mode?: ts.ResolutionMode): ts.ResolvedTypeReferenceDirectiveWithFailedLookupLocations {
    if (!this.active) return ts.resolveTypeReferenceDirective(name, issuer, options, host, undefined, undefined, mode);
    const wrapped = this.wrapHost(host);
    const localRoots = options.typeRoots?.filter(path => !this.reserved(path));
    if (localRoots !== undefined && localRoots.length > 0) {
      const local = ts.resolveTypeReferenceDirective(name, issuer, { ...options, typeRoots: localRoots }, wrapped, undefined, undefined, mode);
      const file = local.resolvedTypeReferenceDirective?.resolvedFileName;
      if (file !== undefined && localRoots.some(root => within(resolve(root), this.logical(file)))) return local;
    }
    const owner = this.owner(issuer), ident = name.startsWith('@types/') ? name : `@types/${name.replace(/^@([^/]+)\//u, '$1__')}`;
    const target = owner === undefined ? undefined : this.dependency(owner, ident);
    if (owner === undefined || target === undefined) { this.note('missing-dependency'); return { resolvedTypeReferenceDirective: undefined }; }
    const entry = this.overlay(owner, ident, target);
    const result = ts.resolveTypeReferenceDirective(name, entry, { ...options, typeRoots: [join(dirname(entry), 'node_modules', '@types')] }, wrapped, undefined, undefined, mode);
    const resolved = result.resolvedTypeReferenceDirective;
    if (resolved?.resolvedFileName === undefined) { this.note('missing-dependency'); return result; }
    if (!within(target.location, this.logical(resolved.resolvedFileName))) { this.note('locator-mismatch'); return { resolvedTypeReferenceDirective: undefined }; }
    const { packageId: _packageId, ...identity } = resolved;
    return { ...result, resolvedTypeReferenceDirective: { ...identity, resolvedFileName: this.logical(resolved.resolvedFileName) } };
  }

  /** 자동 ambient type은 분석 문맥의 package가 직접 접근할 수 있는 @types만 열거한다. */
  typeRoots(issuer: string): readonly string[] | undefined {
    if (!this.active || this.manifest === undefined) return undefined;
    const owner = this.owner(issuer);
    if (owner === undefined) return [];
    let entry: string | undefined;
    for (const name of owner.dependencies.keys()) {
      if (!name.startsWith('@types/')) continue;
      const target = this.dependency(owner, name);
      if (target !== undefined) entry = this.overlay(owner, name, target);
    }
    return entry === undefined ? [] : [join(dirname(entry), 'node_modules', '@types')];
  }

  /** CompilerHost·보조 resolver가 동일한 유계 ZIP 파일 시스템을 보게 한다. */
  wrapHost<T extends ts.ModuleResolutionHost>(host: T): T {
    if (!this.active) return host;
    const original = { ...host };
    return { ...original,
      readFile: (path: string) => {
        const logical = this.logical(path);
        const zip = this.zipPath(logical);
        if (zip !== undefined) {
          const bytes = this.archive(zip.archive)?.files.get(zip.entry);
          if (bytes === undefined) return undefined;
          try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { this.note('input-unreadable'); return undefined; }
        }
        if (logical !== path || resolveVirtual(logical) !== logical) return this.readPhysical(logical);
        if (this.reserved(path)) return undefined;
        if (!this.normalAllowed(path)) return undefined;
        return original.readFile(path);
      },
      fileExists: (path: string) => {
        const logical = this.logical(path), zip = this.zipPath(logical);
        if (zip !== undefined) return this.archive(zip.archive)?.files.has(zip.entry) === true;
        const physical = resolveVirtual(logical);
        if (physical === undefined || (logical === path && this.reserved(path))) return false;
        return logical !== path || physical !== logical ? this.confined(physical) !== undefined && original.fileExists(physical) : this.normalAllowed(path) && original.fileExists(path);
      },
      directoryExists: (path: string) => {
        if (this.aliasDirectories.has(resolve(path))) return true;
        const logical = this.logical(path), zip = this.zipPath(logical);
        if (zip !== undefined) return this.archive(zip.archive)?.directories.has(zip.entry.replace(/\/$/u, '')) === true;
        const physical = resolveVirtual(logical);
        if (physical === undefined || (logical === path && this.reserved(path))) return false;
        return logical !== path || physical !== logical ? this.confined(physical) !== undefined && original.directoryExists?.(physical) === true : this.normalAllowed(path, true) && original.directoryExists?.(path) === true;
      },
      realpath: (path: string) => {
        const logical = this.logical(path);
        return this.zipPath(logical) !== undefined || resolveVirtual(logical) !== logical ? logical : original.realpath?.(logical) ?? logical;
      },
      getDirectories: (path: string) => {
        const absolute = resolve(path), prefix = absolute + sep;
        if (this.aliasDirectories.has(absolute) && !this.aliases.has(absolute)) return [...new Set([...this.aliasDirectories].filter(item => item.startsWith(prefix) && !item.slice(prefix.length).includes(sep)).map(item => item.slice(prefix.length)))];
        const logical = this.logical(path), zip = this.zipPath(logical);
        if (zip !== undefined) {
          const prefix = zip.entry === '' ? '' : zip.entry + '/';
          return [...(this.archive(zip.archive)?.directories ?? [])].filter(item => item.startsWith(prefix) && item !== zip.entry && !item.slice(prefix.length).includes('/')).map(item => item.slice(prefix.length));
        }
        if (logical === path && this.reserved(path)) return [];
        const physical = resolveVirtual(logical);
        if (physical === undefined) return [];
        if (physical !== logical || logical !== path) {
          if (this.confined(physical) === undefined) return [];
        } else if (!this.normalAllowed(physical, true)) return [];
        return original.getDirectories?.(physical) ?? [];
      },
    };
  }

  /** 메모리 overlay의 미매핑 경로를 실제 프로젝트 파일로 열지 않는다. */
  private reserved(path: string): boolean { return within(join(this.folder, '.tsograph-pnp'), resolve(path)); }

  /** archive 안 선언의 전이 상대 import도 workspace 밖 내용을 읽을 수 없다. 도구 SDK만 예외다. */
  private normalAllowed(path: string, directory = false): boolean {
    try {
      const physical = realpathSync(path);
      if (within(this.boundary, physical)) return true;
      if (directory ? physical === this.sdk || physical === dirname(this.sdk)
        : physical === join(dirname(this.sdk), 'package.json') || (dirname(physical) === this.sdk && /^lib(?:\..+)?\.d\.ts$/u.test(physical.slice(dirname(physical).length + 1)))) return true;
      // TypeScript의 조상 node_modules 존재 탐침은 정상 경로에서도 발생한다. 목록/내용을
      // 열지 않는 directory 탐침의 거부만으로 성공한 PnP 해석을 불완전하다고 표시하지 않는다.
      if (!directory) this.note('outside-boundary');
      return false;
    } catch { return within(this.boundary, resolve(path)); }
  }

  /** 같은 code를 한 번만 보존하고 출력 순서를 고정한다. */
  private note(issue: PnpIssue): void { if (!this.issues.includes(issue)) { this.issues.push(issue); this.issues.sort(); } }

  /** 가상 package 경로는 정체성을 유지하고 실제 ZIP 접근 때만 물리 위치로 해제한다. */
  private logical(path: string): string {
    const absolute = resolve(path);
    let ancestor = absolute;
    for (let depth = 0; depth < 128; depth++) {
      const target = this.aliases.get(ancestor);
      if (target !== undefined) return target + absolute.slice(ancestor.length);
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    return absolute;
  }

  /** 가장 긴 location을 선택하되 같은 위치의 서로 다른 의존성 표를 임의로 고르지 않는다. */
  private owner(path: string): Package | undefined {
    if (this.manifest === undefined) return undefined;
    const absolute = this.logical(path);
    let ancestor = dirname(absolute), best: Package[] = [];
    for (let depth = 0; depth < 128; depth++) {
      best = this.manifest.lookup.get(ancestor) ?? [];
      if (best.length > 0) break;
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (best.length > 1 && best.some(pkg => JSON.stringify([...pkg.dependencies].sort()) !== JSON.stringify([...best[0]!.dependencies].sort()))) {
      this.note('ambiguous-owner'); return undefined;
    }
    const named = best.filter(pkg => pkg.name !== null);
    if (named.length > 1) { this.note('ambiguous-owner'); return undefined; }
    return named[0] ?? best[0];
  }

  /** 빠진 peer·미등록 locator는 다른 버전으로 추측하지 않는다. */
  private dependency(owner: Package, ident: string): Package | undefined {
    const manifest = this.manifest!;
    let dependency = owner.dependencies.get(ident);
    if (dependency === undefined && ident === owner.name) return owner;
    if ((dependency === undefined || dependency === null) && manifest.enabledFallback && !manifest.exclusions.has(locator(owner.name, owner.reference))) {
      const topLevel = manifest.packages.get(locator(null, null))?.dependencies.get(ident);
      // 공식 fallback 순서에서 null도 정의된 값이다. 빠진 peer를 pool의 다른 버전으로 대체하지 않는다.
      dependency = topLevel === undefined ? manifest.fallback.get(ident) : topLevel;
    }
    if (dependency === undefined || dependency === null) return undefined;
    return manifest.packages.get(Array.isArray(dependency) ? locator(dependency[0], dependency[1]) : locator(ident, dependency as string));
  }

  /** 가짜 파일을 쓰지 않고 TypeScript가 package exports를 해석할 읽기 전용 경로만 만든다. */
  private overlay(owner: Package, ident: string, target: Package): string {
    const key = locator(owner.name, owner.reference);
    let base = this.resolutions.get(key);
    if (base === undefined) { base = join(this.folder, '.tsograph-pnp', String(this.resolutions.size)); this.resolutions.set(key, base); }
    const alias = join(base, 'node_modules', ident);
    this.aliases.set(alias, target.location);
    let directory = alias;
    while (directory !== this.folder && within(this.folder, directory)) { this.aliasDirectories.add(directory); directory = dirname(directory); }
    return join(base, 'issuer.ts');
  }

  /** ZIP 안 상대 경로를 OS에 넘기지 않고 물리 archive만 경계 검사한다. */
  private zipPath(path: string): { archive: string; entry: string } | undefined {
    const physical = resolveVirtual(path);
    if (physical === undefined) { this.note('outside-boundary'); return { archive: '', entry: '' }; }
    const match = /\.zip(?:[\\/]|$)/u.exec(physical);
    return match === null ? undefined : { archive: physical.slice(0, match.index + 4), entry: physical.slice(match.index + match[0].length).split(sep).join('/') };
  }

  /** archive 전체를 검증하기 전에는 선언을 하나도 공개하지 않는다. */
  private archive(path: string): PnpZip | undefined {
    if (this.archives.has(path)) return this.archives.get(path);
    if (this.archives.size >= PNP_LIMITS.archives) { this.note('archive-budget'); return undefined; }
    this.archives.set(path, undefined);
    const physical = this.confined(path);
    if (physical === undefined) { this.note('input-unreadable'); return undefined; }
    const read = readBoundedFileBytes(physical, Math.min(PNP_ZIP_LIMITS.archiveBytes, PNP_LIMITS.archiveBytes - this.archiveBytes), { noFollow: true });
    if (!read.ok || this.confined(path) !== physical) { this.note('input-unreadable'); return undefined; }
    this.archiveBytes += read.bytes.length;
    try {
      const zip = readPnpZip(read.bytes, PNP_LIMITS.expandedBytes - this.expandedBytes);
      this.expandedBytes += zip.expandedBytes;
      this.archives.set(path, zip);
      return zip;
    } catch { this.note('archive-invalid'); return undefined; }
  }

  /** package location·symlink가 선택 workspace 밖으로 나가면 읽지 않는다. */
  private confined(path: string): string | undefined {
    if (!within(this.boundary, path)) { this.note('outside-boundary'); return undefined; }
    try { const physical = realpathSync(path); if (within(this.boundary, physical)) return physical; }
    catch { return undefined; }
    this.note('outside-boundary'); return undefined;
  }

  private readPhysical(path: string): string | undefined {
    const physical = resolveVirtual(path);
    const real = physical === undefined ? undefined : this.confined(physical);
    if (real === undefined) return undefined;
    const read = readBoundedFileBytes(real, PNP_ZIP_LIMITS.fileBytes, { noFollow: true });
    if (!read.ok || this.confined(physical!) !== real) { this.note('input-unreadable'); return undefined; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(read.bytes); } catch { this.note('input-unreadable'); return undefined; }
  }
}

/** PnP가 활성인 경계에서는 아직 증명하지 못한 ZIP global augmentation 때문에 설정별 universe를 분리한다. */
export function hasPnpScope(root: string, boundary = root): boolean {
  return manifestFolder(realpathSync(root), realpathSync(boundary)) !== undefined;
}

/** 가장 가까운 manifest만 workspace 안에서 찾는다. loader의 bytes는 읽지 않는다. */
function manifestFolder(root: string, boundary: string): string | undefined {
  let folder = resolve(root);
  for (let depth = 0; depth < 128 && within(boundary, folder); depth++) {
    if (existsSync(join(folder, '.pnp.data.json')) || existsSync(join(folder, '.pnp.cjs'))) return folder;
    if (folder === boundary) break;
    folder = dirname(folder);
  }
  return undefined;
}

function within(root: string, path: string): boolean { const offset = relative(root, path); return !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function locator(name: string | null, reference: string | null): string { return JSON.stringify([name, reference]); }
function safeString(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4_096 && !/[\p{Cc}\p{Cf}\\]/u.test(value); }
function packageName(value: unknown): value is string { return safeString(value) && /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/u.test(value) && value !== '.' && value !== '..'; }
function bareIdent(name: string): string | undefined {
  if (name.startsWith('.') || name.startsWith('/') || name.startsWith('#') || name.includes(':') || name.includes('\\')) return undefined;
  const ident = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
  if (!packageName(ident) || name.split('/').some(part => part === '.' || part === '..' || part === '')) return undefined;
  return ident;
}

/** metadata의 tuple 중복·locator 참조를 검사해 불완전한 의존 표를 부분 채택하지 않는다. */
function parseManifest(value: Record<string, unknown>, folder: string): Manifest {
  const packages = new Map<string, Package>(), groups = value['packageRegistryData'];
  if (!Array.isArray(groups) || groups.length > PNP_LIMITS.packages) throw new Error();
  let dependencies = 0;
  const idents = new Set<string | null>();
  for (const group of groups) {
    if (!Array.isArray(group) || group.length !== 2 || !(group[0] === null || packageName(group[0])) || !Array.isArray(group[1]) || idents.has(group[0])) throw new Error();
    idents.add(group[0]);
    for (const entry of group[1]) {
      if (!Array.isArray(entry) || entry.length !== 2 || !(entry[0] === null || safeString(entry[0])) || (group[0] === null) !== (entry[0] === null) || !record(entry[1])) throw new Error();
      const key = locator(group[0], entry[0]), data = entry[1], location = data['packageLocation'];
      if (packages.has(key) || packages.size >= PNP_LIMITS.packages || !safeString(location)
        || (!location.startsWith('./') && !location.startsWith('../')) || !location.endsWith('/')
        || /[\p{Cc}\p{Cf}\\:]/u.test(location) || !Array.isArray(data['packageDependencies'])) throw new Error();
      const deps = dependencyMap(data['packageDependencies']);
      dependencies += deps.size;
      if (dependencies > PNP_LIMITS.dependencies || (data['discardFromLookup'] !== undefined && typeof data['discardFromLookup'] !== 'boolean')) throw new Error();
      packages.set(key, { name: group[0], reference: entry[0], location: resolve(folder, location), dependencies: deps, discard: data['discardFromLookup'] === true });
    }
  }
  const fallback = dependencyMap(value['fallbackPool'] ?? []), exclusions = new Set<string>();
  const exclusionList = value['fallbackExclusionList'] ?? [];
  if (!Array.isArray(exclusionList) || exclusionList.length > PNP_LIMITS.packages || (value['enableTopLevelFallback'] !== undefined && typeof value['enableTopLevelFallback'] !== 'boolean')) throw new Error();
  for (const group of exclusionList) {
    if (!Array.isArray(group) || group.length !== 2 || !packageName(group[0]) || !Array.isArray(group[1])) throw new Error();
    for (const ref of group[1]) { if (!safeString(ref)) throw new Error(); exclusions.add(locator(group[0], ref)); }
  }
  for (const deps of [...packages.values()].map(pkg => pkg.dependencies).concat([fallback])) for (const [name, dependency] of deps) if (dependency !== null
    && !packages.has(Array.isArray(dependency) ? locator(dependency[0], dependency[1]) : locator(name, dependency as string))) throw new Error();
  const lookup = new Map<string, Package[]>();
  for (const pkg of packages.values()) if (!pkg.discard) lookup.set(pkg.location, [...(lookup.get(pkg.location) ?? []), pkg]);
  return { packages, lookup, fallback, exclusions, enabledFallback: value['enableTopLevelFallback'] === true };
}

function dependencyMap(value: unknown): Map<string, Dependency> {
  if (!Array.isArray(value) || value.length > PNP_LIMITS.dependencies) throw new Error();
  const result = new Map<string, Dependency>();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || !packageName(pair[0]) || result.has(pair[0])) throw new Error();
    const ref = pair[1];
    if (!(ref === null || safeString(ref) || (Array.isArray(ref) && ref.length === 2 && packageName(ref[0]) && safeString(ref[1])))) throw new Error();
    result.set(pair[0], ref as Dependency);
  }
  return result;
}

/** Yarn __virtual__/hash/depth의 물리 사상을 유계 횟수만 적용하고 peer별 논리 경로는 보존한다. */
function resolveVirtual(path: string): string | undefined {
  let current = path;
  for (let count = 0; count < 8; count++) {
    const parts = current.split(sep), index = parts.indexOf('__virtual__');
    if (index < 0) return current;
    const hash = parts[index + 1], depth = parts[index + 2];
    if (hash === undefined || hash === '' || depth === undefined || !/^(?:0|[1-9][0-9]?)$/u.test(depth) || Number(depth) > 64 || Number(depth) >= index) return undefined;
    current = join(parts.slice(0, index - Number(depth)).join(sep) || sep, ...parts.slice(index + 3));
  }
  return undefined;
}
