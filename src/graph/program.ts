/**
 * 호출 그래프용 TypeScript Program과 TypeChecker를 만든다.
 *
 * 프로젝트 루트의 `tsconfig.json`(없으면 `jsconfig.json`)을 컴파일러 API로 읽어 `paths`·`baseUrl`·
 * `moduleResolution`·`jsx`·`lib`를 그대로 쓴다. 설정이 없으면 번들러 해석 기본값을 쓴다. 분석 대상
 * 코드는 실행하지 않고(emit 없음), 진단도 계산하지 않는다 — 심볼 해석만 필요하기 때문이다.
 *
 * 명시 files/include/exclude가 있으면 그 설정의 진입 파일을 쓰고, 없으면 호출자가 준 프로젝트 소스를 보탠다.
 * import 의존성은 진입 파일과 별개다. tsconfig가 고르는 파일은 걷기 정책(경계 안, 제외 디렉터리·symlink 밖)을 통과한 것만 쓴다
 * (`config-roots.ts`). `allowJs`를 켜서 JS 파일도 같은 checker로 해석한다.
 *
 * compiler host의 현재 디렉터리는 실행 위치가 아니라 프로젝트 루트다. 설정이 없으면 TypeScript가 자동 타입 루트
 * (`node_modules/@types`)를 그 디렉터리와 조상에서 찾으므로, 실행 위치와 무관하게 tsconfig가 루트에 있을 때와 같다.
 */

import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import ts from 'typescript';

import { readBoundedConfigText } from './bounded-config-reader.ts';
import { ConfigRootBoundary, type ConfigRootGaps, type ScanBoundary } from './config-roots.ts';
import { MAX_SOURCE_BYTES } from '../schema/project-reader.ts';
import { parseWithinSyntaxDepth, TOO_DEEP } from '../schema/syntax-depth.ts';
import { sdkSourceFileCache } from './sdk-source-file-cache.ts';
import { StaticPnp, hasPnpScope, type PnpIssue } from './static-pnp.ts';
import { gitignoreEntryFilter } from '../scan/gitignore.ts';

/** 설정 파일 이름이다(tsconfig 우선). */
const configNames = ['tsconfig.json', 'jsconfig.json'] as const;

/** 명시 입력의 알려진 실패만 CLI가 안전한 원인별 메시지로 변환한다. */
export class GraphProjectInputError extends Error {
  readonly code: 'config-file' | 'config-parse' | 'workspace';
  constructor(code: 'config-file' | 'config-parse' | 'workspace') {
    super(code === 'config-file' ? 'explicit compiler config and its extends must be readable JSON files within 1 MiB'
      : code === 'config-parse' ? 'explicit compiler config could not be parsed'
        : 'workspace must be a readable directory containing the selected project');
    this.name = 'GraphProjectInputError';
    this.code = code;
  }
}

/** 설정이 없을 때 쓰는 기본 컴파일러 옵션이다. 번들러 해석은 확장자 생략과 `.js`→`.ts`를 모두 받는다. */
const defaultOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
  resolveJsonModule: true,
};

/**
 * Program을 만들면서 센 설정 공백이다. 설정 루트 경계의 공백({@link ConfigRootGaps}: 경계 밖이라 쓰지 않은 include·`files`
 * 항목 수, 걷기가 건너뛰는 디렉터리·symlink라 쓰지 않은 이름 항목 수, include 열거의 항목 상한 도달)도 싣는다.
 */
export interface ProgramConfigStatus extends ConfigRootGaps {
  /** 정적 PnP 해석의 실제 거부 원인이다. loader-only는 정적 데이터가 없는 경우다. */
  readonly pnpIssues?: readonly PnpIssue[];
  readonly pnpLoaderOnly?: boolean;
  readonly staticPnp?: boolean;
  /** 서로 다른 타입 의미의 설정을 분리한 Program 수와 검증하지 못한 경계 import 수다. */
  readonly compilerContexts?: number;
  readonly contextBoundaryImports?: number;
  readonly contextBudgetExceeded?: boolean;
  /** 큰 순차 계획에서는 타입 오류 의미를 보존하며 TS 문서 전용 JSDoc AST만 만들지 않는다. */
  readonly compactDocumentation?: boolean;
  /** 설정 진입 범위 밖 후보 수와 그중 import 의존성으로 읽은 수다. */
  readonly excludedSourceRoots?: number;
  readonly importedOutsideRoots?: number;
  /** 서로 다른 설정 소유권으로 해석을 보류한 소스 수다. 위치는 프로젝트 기준으로 제한해 남긴다. */
  readonly conflictingConfigSources?: readonly string[];
  readonly conflictingConfigSourceCount?: number;
  readonly configOwnershipIncomplete?: boolean;
  readonly skippedLoaderEntries?: number;
  /** 읽은 설정 파일 이름(`tsconfig.json`·`jsconfig.json`) 또는 undefined(기본값 사용) */
  readonly configName: string | undefined;
  /** 설정 파일을 읽거나 해석하지 못했는지 여부다(이때 기본 옵션을 쓴다). */
  readonly configUnreadable: boolean;
  /** compiler host가 크기 상한 때문에 읽지 못한 고유 입력 수다. */
  readonly oversizedCompilerInputs?: number;
  /**
   * 구문 중첩이 상한을 넘거나 파싱이 호출 스택을 넘겨 compiler host가 뺀 입력 중 호출자가 준 소스가 아닌 것(설정이 고른
   * 파일·전이 import·선언·패키지)의 고유 수다. 호출자가 준 소스는 {@link GraphProgram.deeplyNestedSources}에 있다.
   */
  readonly deeplyNestedCompilerInputs?: number;
}

/** 만든 Program과 checker, 설정 상태다. */
export interface GraphProgram {
  /** 이 Program의 checker로 결과를 낼 소스다. 다른 Program의 AST와 섞지 않는다. */
  readonly ownedSources?: ReadonlySet<string>;
  /** 진입 범위에서 제외되어 의존성으로도 읽지 않은 소스다. 읽기 실패와 구분한다. */
  readonly excludedSources: ReadonlySet<string>;
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly status: ProgramConfigStatus;
  /**
   * 호출자가 준 소스 중 구문 중첩이 상한을 넘거나 파싱이 호출 스택을 넘겨 Program에서 뺀 것의 절대 경로다. 읽지 못한
   * 소스와 원인이 달라 호출자가 따로 센다.
   */
  readonly deeplyNestedSources: ReadonlySet<string>;
}

/**
 * Program을 만든다.
 *
 * @param root 프로젝트 realpath
 * @param sourcePaths 루트로 넣을 프로젝트 소스 절대 경로(선언 파일 포함 가능)
 * @param createProgram TypeScript Program factory (기본값은 `ts.createProgram`)
 * @param explicitConfig root 기준 상대 경로나 절대 경로로 고른 compiler config. CLI는 realpath가 `--project` 안인 1 MiB 이하
 *   일반 파일인지 먼저 확인하고 받은 값을 그대로 넘긴다(`cli/project-paths.ts`). 상대 옵션의 기준은 이 경로의 디렉터리다
 *   (`tsc -p`처럼 링크를 풀지 않는다).
 * @param boundary 설정이 고르는 루트 파일이 머물 걷기 경계(기본은 root, 추가 제외 디렉터리 없음)
 * @returns Program·checker·설정 상태
 */
export function createGraphProgram(
  root: string,
  sourcePaths: readonly string[],
  createProgram: typeof ts.createProgram = ts.createProgram,
  explicitConfig?: string,
  boundary: ScanBoundary = { root, excludedDirectories: new Set() },
  context?: CompilerContext,
): GraphProgram {
  const entries = context?.entries ?? prepareProgramEntries(root, sourcePaths, explicitConfig, boundary);
  const { candidates, ownership } = entries;
  const config = context?.config ?? entries.config;
  const contextKey = context?.keys.get(config) ?? semanticOptionsKey(config.options);
  const rootNames = context === undefined ? entries.rootNames : entries.rootNames.filter(path => {
    const owner = ownership.owners.get(resolve(path));
    return owner === undefined || context.keys.get(owner) === contextKey;
  });
  const options = analysisOptions(config.options);
  const pnp = new StaticPnp(root, boundary.root);
  if (pnp.active && options.typeRoots === undefined) options.typeRoots = [...(pnp.typeRoots(join(dirname(config.path ?? join(root, 'tsconfig.json')), 'inferred.ts')) ?? [])];
  const candidateSet = new Set(candidates);
  const roots = new Set(rootNames.map(sourceEntryKey));
  const allNonRoots = candidates.filter((path) => !roots.has(sourceEntryKey(path)));
  const nonRoots = allNonRoots.filter(path => context === undefined || context.ownedSources.has(path));
  const host = ts.createCompilerHost(options, true);
  // JS JSDoc과 타입 오류에 필요한 TS @link/@see는 유지한다. 일반 Program의 ParseAll
  // 계약은 바꾸지 않으며, 서로 다른 checker가 프로젝트 AST를 공유하지도 않는다.
  if (context?.compactDocumentation === true) host.jsDocParsingMode = ts.JSDocParsingMode.ParseForTypeErrors;
  // 설정이 없거나 읽지 못하면 TypeScript는 자동 타입 루트를 host의 현재 디렉터리와 그 조상의 `node_modules/@types`에서
  // 찾는다. 실행 위치 대신 프로젝트 루트를 주어 tsconfig가 루트에 있을 때와 같은 타입을 쓴다. 설정이 있으면 TypeScript가
  // 설정 디렉터리를 쓰고, 루트·import·옵션 경로는 모두 절대 경로라 다른 해석은 바뀌지 않는다.
  host.getCurrentDirectory = () => root;
  const oversized = new Set<string>();
  // tsconfig 루트·전이 import·선언·package.json 모두 같은 bounded reader를 거친다.
  // 수집 단계에서 제외한 파일이 compiler host를 통해 다시 무제한 읽히지 않게 한다.
  const requestedSources = new Set<string>();
  const readInput = boundedInputReader((fileName) => oversized.add(fileName));
  host.readFile = (fileName) => {
    const absolute = resolve(fileName);
    if (candidateSet.has(absolute)) requestedSources.add(absolute);
    return readInput(fileName);
  };
  Object.assign(host, pnp.wrapHost(host));
  if (pnp.active) host.resolveTypeReferenceDirectiveReferences = (references, file, _redirected, sourceOptions, source) => references.map(reference => {
    const name = typeof reference === 'string' ? reference : reference.fileName;
    const mode = typeof reference === 'string' ? source?.impliedNodeFormat : reference.resolutionMode ?? source?.impliedNodeFormat;
    return pnp.resolveType(name, file, sourceOptions, host, mode);
  });
  // 다른 설정 소유 소스에 선택한 한 설정의 alias를 적용하면 잘못된 직접 간선이 생긴다. 지원하지 않는
  // 소유권은 import를 미해결로 남긴다. 로더나 설정의 코드를 실행하지 않는다.
  const conflicts = context === undefined ? ownership.blocked : ownership.ambiguous;
  const blocked = conflicts;
  const boundaryImports = new Set<string>();
  const boundaryTargets = new Map<string, string>();
  const choices = new Map<string, Map<string, ts.ResolvedModuleFull | undefined>>();
  const choiceModes = new Map<string, ts.ResolutionMode>();
  const resolveModule = (name: string, containingFile: string, mode?: ts.ResolutionMode, resolutionHost: ts.ModuleResolutionHost = host): ts.ResolvedModuleFull | undefined => {
    const absolute = resolve(containingFile);
    if (blocked.has(absolute)) return undefined;
    const sourceOptions = context === undefined ? options : analysisOptions(ownership.owners.get(absolute)?.options ?? config.options);
    let refused = false;
    const boundedHost: ts.ModuleResolutionHost = { ...resolutionHost, readFile: file => {
      const text = resolutionHost.readFile(file);
      if (text === undefined && resolutionHost.fileExists(file)) refused = true;
      return text;
    } };
    const resolved = pnp.resolveModule(name, containingFile, sourceOptions, boundedHost, mode);
    if (refused) return undefined;
    const target = resolved === undefined ? undefined : ownership.owners.get(resolve(resolved.resolvedFileName));
    if (context !== undefined && resolved !== undefined && (ownership.ambiguous.has(resolve(resolved.resolvedFileName))
      || (target !== undefined && context.keys.get(target) !== contextKey))) {
      boundaryImports.add(`${absolute}\u0000${name}`);
      boundaryTargets.set(`${absolute}\u0000${name}`, resolve(resolved.resolvedFileName));
      return undefined;
    }
    return resolved;
  };
  if (context !== undefined || blocked.size > 0 || pnp.active) host.resolveModuleNameLiterals = (literals, file, _redirected, _options, source) => literals.map(literal => {
    const sourceOptions = context === undefined ? options : analysisOptions(ownership.owners.get(resolve(file))?.options ?? config.options);
    const mode = ts.getModeForUsageLocation(source, literal, sourceOptions);
    const resolvedModule = resolveModule(literal.text, file, mode);
    const key = resolve(file) + '\u0000' + literal.text;
    choiceModes.set(key, mode);
    const targets = choices.get(key) ?? new Map<string, ts.ResolvedModuleFull | undefined>();
    targets.set(resolvedModule?.resolvedFileName ?? '', resolvedModule);
    choices.set(key, targets);
    return { resolvedModule };
  });
  const deeplyNested = new Set<string>();
  // triple-slash/type reference는 module resolver를 거치지 않는다. 다른 문맥의 source universe를
  // getSourceFile 경계에서도 막아 checker 통계에서 resolved 후 사라지는 거짓 호출을 만들지 않는다.
  if (context !== undefined) {
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, ...args) => {
      const owner = ownership.owners.get(resolve(fileName));
      if (owner !== undefined && context.keys.get(owner) !== contextKey) {
        boundaryImports.add(`reference\u0000${resolve(fileName)}`);
        return undefined;
      }
      return getSourceFile(fileName, ...args);
    };
  }
  // SDK 캐시보다 먼저 감싸 프로젝트·의존성 입력만 깊이를 잰다(번들 lib는 캐시가 따로 만든다).
  limitSyntaxDepth(host, (fileName) => deeplyNested.add(fileName));
  const cacheLease = sdkSourceFileCache.install(host, options);
  let primaryFailed = false;
  try {
    const program = createProgram({ rootNames, options, host });
    blockedConfigImports.set(program, blocked);
    if (context !== undefined || pnp.active) programResolvers.set(program, (specifier, file, resolutionHost) => {
      const key = resolve(file) + '\u0000' + specifier;
      const targets = choices.get(key);
      // require/import 조건이 같은 파일에서 갈리면 보조 해석은 임의 조건을 선택하지 않는다.
      // 호출자의 bounded host를 그대로 사용해 거부 계수와 package.json 상한을 우회하지 않는다.
      return targets !== undefined && targets.size > 1 ? undefined : resolveModule(specifier, file, choiceModes.get(key), resolutionHost);
    });
    unresolvedModuleTargets.set(program, boundaryTargets);
    const checker = program.getTypeChecker();
    const excludedSources = new Set(allNonRoots.filter((path) => !requestedSources.has(path) && program.getSourceFile(path) === undefined));
    const importedOutsideRoots = nonRoots.filter((path) => program.getSourceFile(path) !== undefined).length;
    const sources = new Set(sourcePaths.map((path) => resolve(path)));
    const deeplyNestedSources = new Set([...deeplyNested].filter((path) => sources.has(path)));
    const otherDeeplyNested = deeplyNested.size - deeplyNestedSources.size;
    return {
      program, checker, deeplyNestedSources, excludedSources,
      ...(context === undefined ? {} : { ownedSources: context.ownedSources }), status: {
        ...ownershipStatus(config, ownership), ...(oversized.size > 0 ? { oversizedCompilerInputs: oversized.size } : {}),
        ...(nonRoots.length > 0 ? { excludedSourceRoots: nonRoots.length, importedOutsideRoots } : {}),
        ...(conflicts.size > 0 ? { conflictingConfigSourceCount: conflicts.size,
          conflictingConfigSources: [...conflicts].map((path) => relative(boundary.root, path).replaceAll('\\', '/')).sort().slice(0, 10) } : {}),
        ...(context === undefined ? {} : { compilerContexts: context.count, contextBoundaryImports: boundaryImports.size,
          ...(context.compactDocumentation ? { compactDocumentation: true } : {}) }),
        ...(ownership.incomplete ? { configOwnershipIncomplete: true } : {}),
        ...(otherDeeplyNested > 0 ? { deeplyNestedCompilerInputs: otherDeeplyNested } : {}),
        ...(pnp.active ? { staticPnp: true, pnpIssues: pnp.issues } : {}),
        ...(pnp.loaderOnly ? { pnpLoaderOnly: true } : {}),
      },
    };
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (primaryFailed) {
      try {
        cacheLease.release();
      } catch {
        // 원래 Program/checker 오류를 cleanup 오류로 가리지 않는다.
      }
    } else {
      cacheLease.release();
    }
  }
}

/** Program과 Next convention이 같은 설정 진입 목록을 쓴다. import 의존성 폐쇄는 이 목록과 별개다. */
function prepareProgramEntries(root: string, sourcePaths: readonly string[], explicitConfig: string | undefined, boundary: ScanBoundary, confinedConfigs = false) {
  const acceptsEntry = boundary.acceptsEntry ?? gitignoreEntryFilter(boundary.root);
  boundary = { ...boundary, configVisits: { visited: 0 }, ...(acceptsEntry === undefined ? {} : { acceptsEntry }) };
  const config = readProjectConfig(root, boundary, explicitConfig, confinedConfigs);
  const candidates = [...new Set(sourcePaths.map((path) => resolve(path)))];
  const ownership = configOwnership(root, config, candidates, boundary, explicitConfig !== undefined, confinedConfigs);
  const candidateSet = new Set(candidates);
  // 가장 가까운 소유 설정의 진입 범위를 따른다. 제외된 파일도 import 의존성이면 host가 읽는다.
  const rootNames = [...new Set([...config.fileNames, ...ownership.referenceRoots].filter(path => !candidateSet.has(path)).concat(candidates.filter(path => {
    if (ownership.incomplete) return !hasTypeScriptSibling(path, candidateSet);
    if (ownership.ambiguous.has(path) && ownership.referenceRoots.includes(path)) return true;
    const owner = ownership.owners.get(path) ?? config;
    return owner.scoped ? owner.fileNames.includes(path) : !hasTypeScriptSibling(path, candidateSet);
  })))].filter(path => boundary.acceptsEntry?.(path) !== false).sort();
  return { config, candidates, ownership, rootNames };
}

/** AST를 공유하지 않는 타입 의미별 Program 실행 계획이다. 경로 별칭은 각 파일의 소유 설정으로 해석한다. */
interface CompilerContext {
  readonly keys: ReadonlyMap<ProjectConfig, string>;
  readonly entries: ReturnType<typeof prepareProgramEntries>;
  readonly config: ProjectConfig;
  readonly ownedSources: ReadonlySet<string>;
  readonly count: number;
  readonly compactDocumentation: boolean;
}

/** 같은 타입 의미는 한 checker를 쓰고, 다른 의미는 순차 Program으로 분리해 Node/Symbol을 교환하지 않는다. */
export function* createGraphPrograms(root: string, sourcePaths: readonly string[], explicitConfig?: string,
  boundary: ScanBoundary = { root, excludedDirectories: new Set() }): Generator<GraphProgram> {
  const entries = prepareProgramEntries(root, sourcePaths, explicitConfig, boundary);
  const keys = compilerContextKeys(entries, hasPnpScope(root, boundary.root));
  const groups = new Map<string, { config: ProjectConfig; sources: Set<string> }>();
  for (const path of entries.candidates) {
    const config = entries.ownership.owners.get(path) ?? entries.config;
    const key = keys.get(config)!;
    const group = groups.get(key) ?? { config, sources: new Set<string>() };
    group.sources.add(path);
    groups.set(key, group);
  }
  if (groups.size === 0) groups.set(semanticOptionsKey(entries.config.options), { config: entries.config, sources: new Set() });
  // 총 문맥 수는 동시에 살아 있는 checker 수가 아니다. 전체 계획을 이유로 모든 호출을
  // 버리지 않고 기존 소유권·ambient 경계를 유지한 채 하나씩 처리한다. 큰 계획은 타입
  // 오류를 보존하는 JSDoc 모드로 문서 전용 AST의 보유 비용을 줄인다.
  const compactDocumentation = groups.size > 16 || (groups.size > 1 && groups.size * entries.candidates.length > 200_000);
  for (const group of groups.values()) yield createGraphProgram(root, sourcePaths, ts.createProgram, explicitConfig, boundary,
    { entries, keys, config: group.config, ownedSources: group.sources, count: groups.size, compactDocumentation });
}

/** 같은 옵션이라도 global/ambient source universe가 다르면 checker를 합치지 않는다.
 * 명시 types:[]와 전부 external-module인 유계 입력에서만 별칭이 다른 설정의 공유를 허용한다. */
function compilerContextKeys(entries: ReturnType<typeof prepareProgramEntries>, pnpScope = false): ReadonlyMap<ProjectConfig, string> {
  const configs = [...new Set([entries.config, ...entries.ownership.owners.values()])];
  const keys = new Map<ProjectConfig, string>();
  for (const [index, config] of configs.entries()) {
    const sources = [...entries.ownership.owners].filter(([, owner]) => owner === config).map(([path]) => path);
    const isolated = configs.length > 1 && (pnpScope || config.options.types?.length !== 0
      || sources.some(path => !isModuleOnly(path, config.options, entries.ownership.owners)));
    keys.set(config, semanticOptionsKey(config.options) + (isolated ? `\u0000global-universe:${index}` : ''));
  }
  return keys;
}

function isModuleOnly(path: string, options: ts.CompilerOptions, owners: ReadonlyMap<string, ProjectConfig>): boolean {
  const read = readBoundedConfigText(path, MAX_SOURCE_BYTES);
  if (!read.ok) return false;
  const source = parseWithinSyntaxDepth(() => ts.createSourceFile(path, read.text, ts.ScriptTarget.Latest, true));
  if (source === TOO_DEEP || !ts.isExternalModule(source)) return false;
  let augmentation = source.referencedFiles.length > 0 || source.typeReferenceDirectives.length > 0
    || source.libReferenceDirectives.length > 0 || source.hasNoDefaultLib;
  const visit = (node: ts.Node): void => {
    if (ts.isModuleDeclaration(node)) augmentation = true;
    if (!augmentation) ts.forEachChild(node, visit);
  };
  visit(source);
  if (augmentation) return false;
  // 스캔 밖 의존성의 global augmentation도 공유 checker로 다른 앱에 유출하지 않는다.
  const host = createBoundedResolutionHost(() => {});
  // 한 모드의 미해결은 실제 import/require 조건의 입력 부재를 증명하지 않는다.
  // 가능한 세 모드를 모두 대조해 실제 모드를 빠뜨리지 않되, 전부 없는 의존성 때문에
  // 검증된 프로젝트 내부 reference 연결까지 불필요하게 나누지 않는다.
  const modes: readonly ts.ResolutionMode[] = [undefined, ts.ModuleKind.ESNext, ts.ModuleKind.CommonJS];
  return ts.preProcessFile(read.text, true, true).importedFiles.every(imported => modes.every(mode => {
    const target = ts.resolveModuleName(imported.fileName, path, analysisOptions(options), host, undefined, undefined, mode).resolvedModule;
    return target === undefined || owners.has(resolve(target.resolvedFileName));
  }));
}

/** compiler를 만들거나 소스를 실행하지 않고 Next convention에 허용할 진입 파일과 설정 공백을 돌려준다. */
export function selectSourceEntryFiles(root: string, candidates: readonly string[], explicitConfig?: string,
  boundary: ScanBoundary = { root, excludedDirectories: new Set() }): { files: ReadonlySet<string>; status: ProgramConfigStatus } {
  const { config, ownership, rootNames } = prepareProgramEntries(root, candidates, explicitConfig, boundary);
  return { files: new Set(rootNames.map(sourceEntryKey)), status: { ...ownershipStatus(config, ownership),
    ...(ownership.incomplete ? { configOwnershipIncomplete: true } : {}),
  } };
}

/** 타입 추론을 하지 않는 persistence 바인더도 같은 소유권·진입 선택을 사용한다. */
export function sourceConfigPlan(root: string, sources: readonly string[]) {
  const entries = prepareProgramEntries(root, sources, undefined, { root, excludedDirectories: new Set() }, true);
  const { config, ownership, rootNames } = entries;
  const keys = compilerContextKeys(entries, hasPnpScope(root));
  const optionsFor = (path: string) => analysisOptions(ownership.owners.get(resolve(path))?.options ?? config.options);
  const status: ProgramConfigStatus = { ...ownershipStatus(config, ownership),
    ...(ownership.ambiguous.size > 0 ? { conflictingConfigSourceCount: ownership.ambiguous.size } : {}),
    ...(ownership.incomplete ? { configOwnershipIncomplete: true } : {}) };
  const unreadableConfigs = ownership.configs.filter(config => config.status.configUnreadable).length;
  return { entries: new Set(rootNames), optionsFor, status, unreadableConfigs,
    blocked: (path: string) => ownership.ambiguous.has(resolve(path)),
    compatible: (from: string, to: string) => keys.get(ownership.owners.get(resolve(from)) ?? config)
      === keys.get(ownership.owners.get(resolve(to)) ?? config) };
}

/** TypeScript host가 대소문자를 구분하지 않는 파일시스템에서만 entry 비교 키를 정규화한다. 표시 경로는 바꾸지 않는다. */
export function sourceEntryKey(path: string): string {
  return ts.sys.useCaseSensitiveFileNames ? path : path.toLowerCase();
}

/**
 * `ts.resolveModuleName`에 넘길 모듈 해석 host를 만든다. `ts.sys`와 같되 `readFile`은 compiler host와 같은
 * 4 MiB bounded reader다.
 *
 * `ts.sys.readFile`은 크기 상한 없이 파일 전체를 읽는다. 그대로 넘기면 Program이 상한 때문에 읽지 않은
 * package.json을 별도 해석이 통째로 읽고, 그 `main`·`exports`로 Program과 다른 파일을 고를 수 있다.
 *
 * @param onOversized 상한을 넘어 읽지 않은 파일의 절대 경로를 받는다
 * @returns 모듈 해석 host
 */
export function createBoundedResolutionHost(onOversized: (fileName: string) => void): ts.ModuleResolutionHost {
  return { ...ts.sys, readFile: boundedInputReader(onOversized) };
}

/**
 * compiler host와 모듈 해석 host가 함께 쓰는 bounded 입력 reader를 만든다.
 *
 * 상한을 넘은 파일은 읽지 않은 것(undefined)으로 두고 `onOversized`에 알린다. TypeScript는 읽지 못한 파일을
 * 없는 것으로 보고 계속하므로, 공백을 알리는 일은 호출자가 맡는다.
 *
 * @param onOversized 상한을 넘어 읽지 않은 파일의 절대 경로를 받는다
 * @returns `readFile` 구현
 */
function boundedInputReader(onOversized: (fileName: string) => void): (fileName: string) => string | undefined {
  return (fileName) => {
    const result = readBoundedConfigText(fileName, MAX_SOURCE_BYTES);
    if (result.ok) return result.text;
    if (result.reason === 'too-large') onOversized(resolve(fileName));
    return undefined;
  };
}

/**
 * compiler host가 만드는 SourceFile에 구문 깊이 상한을 건다.
 *
 * 상한을 넘거나 파싱이 호출 스택을 넘긴 파일은 없는 파일(undefined)로 돌려준다. 그래서 TypeScript 바인더·검사기와
 * tsograph 방문기가 그 파일을 걷지 않고, 그 파일을 가리키는 import는 풀리지 않은 모듈이 된다. 깊은 파일 하나 때문에
 * Program을 쓰는 명령 전체가 스택 초과로 끝나지 않게 하기 위해서다.
 *
 * @param host compiler host(`getSourceFile`을 바꾼다)
 * @param onTooDeep 뺀 입력의 절대 경로를 받는다
 */
function limitSyntaxDepth(host: ts.CompilerHost, onTooDeep: (fileName: string) => void): void {
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const sourceFile = parseWithinSyntaxDepth(() => original(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile));
    if (sourceFile !== TOO_DEEP) return sourceFile;
    onTooDeep(resolve(fileName));
    return undefined;
  };
}

/** 설정 파일에서 읽은 옵션·루트 파일·상태다. */
interface ProjectConfig {
  readonly options: ts.CompilerOptions;
  readonly fileNames: readonly string[];
  readonly status: ProgramConfigStatus;
  readonly path?: string;
  readonly scoped?: boolean;
  readonly references?: readonly string[];
}

/**
 * 프로젝트 루트의 설정 파일을 읽는다. 없거나 읽지 못하면 기본 옵션이다. 설정이 고른 루트 파일은 걷기 경계로 거른다.
 *
 * @param root 프로젝트 realpath
 * @param boundary 설정 루트 파일이 머물 걷기 경계
 * @param explicitConfig 자동 탐색 대신 사용할 root 기준 상대 경로나 절대 경로
 * @returns 옵션·루트 파일·상태
 */
function readProjectConfig(root: string, boundary: ScanBoundary, explicitConfig?: string, confined = false): ProjectConfig {
  const configName = explicitConfig === undefined ? configNames.find((name) => existsSync(join(root, name))) : basename(explicitConfig);
  if (configName === undefined) return { options: defaultOptions, fileNames: [], status: { configName, configUnreadable: false } };
  const path = explicitConfig === undefined ? join(root, configName) : resolve(root, explicitConfig);
  let boundedReadFailed = false;
  const readFile = (fileName: string): string | undefined => {
    // persistence의 기존 입력 경계는 standalone 분석에서도 실제 루트 밖 설정을 읽지 않는다.
    if (confined) {
      const inside = (root: string, path: string) => { const offset = relative(root, path); return !isAbsolute(offset) && offset !== '..' && !offset.startsWith('../') && !offset.startsWith('..\\'); };
      // Windows short/long 경로도 양쪽을 같은 OS 함수로 비교한다. 경계 자체를 완화하지 않는다.
      try { if (!inside(boundary.root, resolve(fileName)) || !inside(realpathSync.native(boundary.root), realpathSync.native(fileName))) { boundedReadFailed = true; return undefined; } }
      catch { boundedReadFailed = true; return undefined; }
    }
    const result = readBoundedConfigText(fileName);
    if (result.ok) return result.text;
    boundedReadFailed = true;
    return undefined;
  };
  const read = ts.readConfigFile(path.replaceAll('\\', '/'), readFile);
  if (read.error !== undefined) {
    if (explicitConfig !== undefined) {
      throw new GraphProjectInputError(boundedReadFailed ? 'config-file' : 'config-parse');
    }
    return { ...unreadableConfig(configName), path };
  }
  // include 글롭은 경계 필터가 걷기 정책 안에서만 펼친다(`ts.sys.readDirectory`는 상한 없이 링크·빌드 산출물까지 연다).
  const roots = new ConfigRootBoundary(boundary);
  const host: ts.ParseConfigHost = { ...ts.sys, readFile, readDirectory: roots.readDirectory };
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    host,
    dirname(path),
    configName === 'jsconfig.json' ? { allowJs: true } : undefined,
    path,
  );
  // "include 결과 없음"(18003)은 호출자가 소스를 따로 넣으므로 문제가 아니다. 그 밖의 오류는 기본값으로 떨어진다.
  const parseErrors = parsed.errors.filter(error => error.code !== 18003 && error.code !== 18002 && error.category === ts.DiagnosticCategory.Error);
  // persistence는 루트 밖 extends를 읽지 않고 로컬 명시 alias만 보존하던 동작을 유지한다.
  // 부분 설정임을 알리며 frozen capture의 거부 기록은 이 fallback으로 지워지지 않는다.
  const partialConfined = confined && boundedReadFailed && parseErrors.every(error => error.code === 6053 || error.code === 5083);
  if (parseErrors.length > 0 && !partialConfined) {
    if (explicitConfig !== undefined) {
      throw new GraphProjectInputError(boundedReadFailed ? 'config-file' : 'config-parse');
    }
    return { ...unreadableConfig(configName), path };
  }
  return { options: parsed.options, fileNames: roots.admit(parsed.fileNames).map((file) => resolve(file)), path,
    scoped: ['files', 'include', 'exclude'].some((key) => Object.hasOwn(parsed.raw as object, key)),
    references: parsed.projectReferences?.map((reference) => ts.resolveProjectReferencePath(reference)) ?? [],
    status: { configName, configUnreadable: partialConfined, ...roots.gaps() } };
}

/**
 * 설정 루트 경계가 남긴 공백을 원인 문장으로 만든다. 접두사는 문서마다 다르므로 호출자가 붙인다(graph `graph-config:`,
 * routes·navigation은 각 coverage 접두사). 같은 Program 공백을 본 문서들이 같은 말로 알리게 하려고 한곳에 둔다.
 *
 * @param status Program 설정 상태
 * @param affected 불완전할 수 있는 결과(예: `calls`, `route registrations`)
 * @returns 원인 문장(공백이 없으면 빈 목록)
 */
export function configRootGaps(status: ProgramConfigStatus, affected: string): string[] {
  const gaps: string[] = [];
  if (status.pnpLoaderOnly === true) gaps.push(`pnp-dependencies: only an executable PnP loader is available; provide static metadata to resolve dependency declarations; loaders are never executed; ${affected} may be incomplete`);
  if ((status.pnpIssues?.length ?? 0) > 0) gaps.push(`pnp-dependencies: static dependency inputs were refused (${status.pnpIssues!.join(', ')}); unresolved inputs may hide ${affected}; verify the static metadata, project boundary and ZIP budgets`);
  if ((status.contextBoundaryImports ?? 0) > 0) gaps.push(`config-context-boundary: ${status.contextBoundaryImports} import(s) cross separated type-checking contexts and remain unresolved; ${affected} may be incomplete`);
  if (status.contextBudgetExceeded === true) gaps.push(`config-context-budget: more than 16 type-checking contexts or 200000 source-context entries; imports remain unresolved and ${affected} may be incomplete`);
  if ((status.skippedLoaderEntries ?? 0) > 0) gaps.push(`source-scope: ${status.skippedLoaderEntries} PnP loader file(s) were excluded from source entries; loaders are never executed`);
  if ((status.excludedSourceRoots ?? 0) > 0) {
    gaps.push(`source-scope: ${status.excludedSourceRoots} scanned candidate(s) were not entry files selected by files/include/exclude or TypeScript sibling precedence; `
      + `${status.importedOutsideRoots ?? 0} were retained as imported dependencies; excluded entry files may contain additional ${affected}`);
  }
  if ((status.conflictingConfigSourceCount ?? 0) > 0) {
    gaps.push(`config-conflict: ${status.conflictingConfigSourceCount} source(s) have different or ambiguous compiler-config ownership; `
      + `their imports were left unresolved instead of applying another project's aliases; ${affected} may be incomplete; `
      + `files: ${JSON.stringify(status.conflictingConfigSources ?? [])}; omitted: ${status.conflictingConfigSourceCount! - (status.conflictingConfigSources?.length ?? 0)}`);
  }
  if (status.configOwnershipIncomplete === true) gaps.push(`config-ownership: referenced or nearest configs could not all be read within the scan boundary, 128-config budget and shared directory-entry budget; ${affected} may be incomplete`);
  const outside = status.outsideConfigRoots ?? 0;
  if (outside > 0) {
    gaps.push(`${outside} include pattern(s) or files entr(ies) of ${status.configName} point outside the scanned root and were not used as root files; `
      + `type resolution and ${affected} may be incomplete (analyze a root that contains them)`);
  }
  const excluded = status.excludedConfigRoots ?? 0;
  if (excluded > 0) {
    gaps.push(`${excluded} files entr(ies) or wildcard-free include path(s) of ${status.configName} name paths in directories the scan skips `
      + `or through symbolic links and were not used as root files; type resolution and ${affected} may be incomplete `
      + '(import or reference them from a project source instead)');
  }
  if (status.configRootsTruncated === true) {
    gaps.push(`include patterns of ${status.configName} reached the directory entry limit; later matches were not used as root files; `
      + `type resolution and ${affected} may be incomplete`);
  }
  return gaps;
}

/**
 * 읽지 못한 설정의 결과를 만든다.
 *
 * @param configName 설정 파일 이름
 * @returns 기본 옵션과 unreadable 상태
 */
function unreadableConfig(configName: string): ProjectConfig {
  return { options: defaultOptions, fileNames: [], status: { configName, configUnreadable: true } };
}

/**
 * 분석용으로 옵션을 조정한다: emit·증분 빌드·플러그인을 끄고 JS를 허용한다.
 *
 * @param options 설정의 옵션
 * @returns 분석용 옵션
 */
function analysisOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  const adjusted: ts.CompilerOptions = { ...options, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true };
  for (const key of ['incremental', 'composite', 'tsBuildInfoFile', 'declaration', 'declarationMap', 'emitDeclarationOnly', 'plugins', 'outDir', 'outFile'] as const) {
    delete adjusted[key];
  }
  return adjusted;
}

/** 같은 stem의 TypeScript 소스가 있으면 남아 있는 JavaScript 산출물을 진입 파일로 중복 등록하지 않는다. */
function hasTypeScriptSibling(path: string, sources: ReadonlySet<string>): boolean {
  if (!/\.[cm]?jsx?$/u.test(path)) return false;
  const stem = path.replace(/\.[cm]?jsx?$/u, '');
  const extensions = path.endsWith('.mjs') ? ['.mts'] : path.endsWith('.cjs') ? ['.cts'] : ['.ts', '.tsx'];
  return extensions.some((extension) => sources.has(stem + extension));
}

/** Program 밖의 보조 module resolver도 동일한 소유권 보류를 지킨다. */
const blockedConfigImports = new WeakMap<ts.Program, ReadonlySet<string>>();
const programResolvers = new WeakMap<ts.Program, (specifier: string, fileName: string, host: ts.ModuleResolutionHost) => ts.ResolvedModule | undefined>();
const unresolvedModuleTargets = new WeakMap<ts.Program, ReadonlyMap<string, string>>();

/** 이미 해석했으나 문맥 경계 때문에 거부한 경로만 후보 근거로 내준다. checker 신원은 노출하지 않는다. */
export function unresolvedProgramModuleTarget(program: ts.Program, specifier: string, fileName: string): string | undefined {
  return unresolvedModuleTargets.get(program)?.get(`${resolve(fileName)}\u0000${specifier}`);
}

/** 보조 해석도 Program과 같은 소유 설정·경계 거부를 적용한다. 결과가 없으면 다른 설정으로 재시도하지 않는다. */
export function resolveProgramModule(program: ts.Program, specifier: string, fileName: string,
  host: ts.ModuleResolutionHost): ts.ResolvedModule | undefined {
  if (configImportIsBlocked(program, fileName)) return undefined;
  const resolver = programResolvers.get(program);
  return resolver === undefined ? ts.resolveModuleName(specifier, fileName, program.getCompilerOptions(), host).resolvedModule
    : resolver(specifier, fileName, host);
}
export function configImportIsBlocked(program: ts.Program, fileName: string): boolean {
  return blockedConfigImports.get(program)?.has(resolve(fileName)) === true;
}

interface ConfigOwnership {
  readonly configs: readonly ProjectConfig[];
  readonly blocked: ReadonlySet<string>;
  readonly referenceRoots: readonly string[];
  readonly incomplete: boolean;
  readonly owners: ReadonlyMap<string, ProjectConfig>;
  readonly ambiguous: ReadonlySet<string>;
}

/** 가장 가까운 설정과 reference 소유권을 비교한다. 모호한 소유권의 import는 보류한다. */
function configOwnership(
  root: string, selected: ProjectConfig, sources: readonly string[], boundary: ScanBoundary, explicit: boolean, confinedConfigs = false,
): ConfigOwnership {
  const cache = new Map<string, ProjectConfig>();
  if (selected.path !== undefined) cache.set(resolve(selected.path), selected);
  const blocked = new Set<string>();
  const ambiguous = new Set<string>();
  const ownersBySource = new Map<string, ProjectConfig>();
  let incomplete = selected.status.configRootsTruncated === true;
  const inside = (path: string) => {
    const offset = relative(boundary.root, path);
    return !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..\\') && !offset.startsWith('../');
  };
  const read = (path: string): ProjectConfig | undefined => {
    const absolute = resolve(path);
    if (cache.has(absolute)) return cache.get(absolute);
    if (!inside(absolute) || cache.size >= 128) { incomplete = true; return undefined; }
    let config: ProjectConfig;
    try { config = readProjectConfig(dirname(absolute), boundary, absolute, confinedConfigs); }
    catch { config = unreadableConfig(basename(absolute)); incomplete = true; }
    cache.set(absolute, config);
    if (config.status.configRootsTruncated) incomplete = true;
    return config;
  };
  const referenced = new Map<string, ProjectConfig[]>();
  const referenceRoots = new Set<string>();
  const pending = [...(selected.references ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = resolve(pending.pop()!);
    if (visited.has(path)) continue;
    visited.add(path);
    if (visited.size > 128) { incomplete = true; break; }
    const config = read(path);
    if (config === undefined || config.status.configUnreadable) { sources.forEach((source) => blocked.add(source)); continue; }
    for (const source of config.fileNames) {
      referenceRoots.add(source);
      const owners = referenced.get(source) ?? [];
      owners.push(config);
      referenced.set(source, owners);
    }
    pending.push(...(config.references ?? []));
  }
  const byDirectory = new Map<string, ProjectConfig | undefined>();
  const nearest = (directory: string): ProjectConfig | undefined => {
    if (byDirectory.has(directory)) return byDirectory.get(directory);
    if (!inside(directory)) return undefined;
    if (explicit && resolve(directory) === resolve(root)) { byDirectory.set(directory, selected); return selected; }
    const name = configNames.find((candidate) => existsSync(join(directory, candidate)));
    const owner = name === undefined ? nearest(dirname(directory)) : read(join(directory, name));
    byDirectory.set(directory, owner);
    return owner;
  };
  const selectedKey = resolutionOptionsKey(selected.options);
  for (const source of new Set([...sources, ...selected.fileNames, ...referenceRoots])) {
    const owners = [...(referenced.get(source) ?? [])];
    const owner = nearest(dirname(source));
    if (owner !== undefined) owners.push(owner);
    if (owners.some((config) => config !== selected && (config.status.configUnreadable || resolutionOptionsKey(config.options) !== selectedKey))) blocked.add(source);
    const referenceOwners = referenced.get(source) ?? [];
    const explicitOwners = referenceOwners.length === 0 ? (owner === undefined ? [] : [owner])
      : [...referenceOwners, ...(owner !== undefined && owner.fileNames.includes(source) ? [owner] : [])];
    const unique = new Map(explicitOwners.map(config => [resolutionOptionsKey(config.options), config]));
    if (unique.size > 1 || explicitOwners.some(config => config !== selected && config.status.configUnreadable)) ambiguous.add(source);
    ownersBySource.set(source, unique.size === 1 ? [...unique.values()][0]! : selected);
  }
  if (incomplete) sources.forEach((source) => { blocked.add(source); ambiguous.add(source); });
  return { configs: [...new Set([selected, ...cache.values()])], blocked, referenceRoots: [...referenceRoots], incomplete, owners: ownersBySource, ambiguous };
}

/** 같은 의미 그룹의 대표 설정만 보고 다른 소유 설정의 준비 공백을 버리지 않는다. */
function ownershipStatus(selected: ProjectConfig, ownership: ConfigOwnership): ProgramConfigStatus {
  const statuses = ownership.configs.map(config => config.status);
  const outsideConfigRoots = statuses.reduce((sum, status) => sum + (status.outsideConfigRoots ?? 0), 0);
  const excludedConfigRoots = statuses.reduce((sum, status) => sum + (status.excludedConfigRoots ?? 0), 0);
  return { ...selected.status,
    configUnreadable: statuses.some(status => status.configUnreadable),
    ...(outsideConfigRoots > 0 ? { outsideConfigRoots } : {}),
    ...(excludedConfigRoots > 0 ? { excludedConfigRoots } : {}),
    ...(statuses.some(status => status.configRootsTruncated) ? { configRootsTruncated: true } : {}),
  };
}

/** 파일별 module 해석으로 분리 가능한 경로 옵션 외의 의미가 같을 때만 checker를 공유한다. */
function semanticOptionsKey(options: ts.CompilerOptions): string {
  const normalized = analysisOptions(options) as Record<string, unknown>;
  for (const key of ['configFile', 'configFilePath', 'baseUrl', 'paths', 'pathsBasePath']) delete normalized[key];
  return JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
}

/** 설정 위치만 달라도 같은 유효 해석 옵션이면 충돌로 만들지 않는다. 설정 AST는 비교에 포함하지 않는다. */
function resolutionOptionsKey(options: ts.CompilerOptions): string {
  const normalized = analysisOptions(options);
  delete normalized.configFile;
  delete normalized.configFilePath;
  return JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
}
