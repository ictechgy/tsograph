/**
 * 프로젝트에서 Prisma 관련 입력(버전·스키마 파일·generator 출력·TypedSQL 파일)을 모은다.
 *
 * 추출의 첫 단계다. 파일 트리는 한 번만 걷고, 이후 단계는 이 결과만 본다.
 */

import { basename, dirname, join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';

import { compareStrings } from '../exchange/sorted-json.ts';
import { buildPrismaCatalog, type LoadedSchemaFile, type PrismaCatalog, stringProperty } from './prisma-catalog.ts';
import { locatePrismaSchemas, readManifest, type SchemaLocation } from './prisma-locate.ts';
import { parsePrismaSchema, type PrismaBlock } from './prisma-schema.ts';
import {
  decideNamingRules,
  LOCKFILE_NAMES,
  type NamingDecision,
  type ObservedVersion,
  type TrackedPackage,
  versionFromSpecifier,
  versionsFromLockfile,
} from './prisma-version.ts';
import { collectProjectFiles, type ProjectFiles, toPosixRelative } from './project-files.ts';
import { pathKind, type ProjectReader } from './project-reader.ts';
import { isSourceFileName } from './source-module.ts';
import { SourceText } from './source-text.ts';

/** 클라이언트 import를 추적하는 generator provider다. */
const clientGenerators: ReadonlySet<string> = new Set(['prisma-client-js', 'prisma-client']);

/** 모은 Prisma 입력이다. */
export interface PrismaProject {
  readonly walk: ProjectFiles;
  readonly naming: NamingDecision;
  readonly location: SchemaLocation;
  readonly schemaFiles: readonly LoadedSchemaFile[];
  readonly catalog: PrismaCatalog | undefined;
  /** generator output 절대 디렉터리다(소스 스캔에서 제외하고 import 출처로 쓴다). */
  readonly outputDirectories: readonly string[];
  /** TypedSQL `.sql` 파일 절대 경로다. */
  readonly typedSqlFiles: readonly string[];
  /** 프로젝트 안 Prisma 의존 흔적(package.json 의존 또는 버전 관측)이 있는지다. */
  readonly usesPrisma: boolean;
  readonly counts: PrismaProjectCounts;
}

/** 입력 단계의 공백 계수다. */
export interface PrismaProjectCounts {
  schemasOutsideProject: number;
  unresolvedGeneratorOutputs: number;
  unresolvedTypedSql: number;
}

/**
 * 프로젝트의 Prisma 입력을 모은다.
 *
 * @param root 프로젝트 realpath
 * @param reader 파일 읽기 도우미
 * @returns Prisma 입력
 */
export function loadPrismaProject(root: string, reader: ProjectReader): PrismaProject {
  const walk = collectProjectFiles(root, { includeFile: isInterestingFile, excludedDirectories: new Set() });
  const byName = (predicate: (name: string) => boolean): string[] =>
    [...walk.files.values()].filter((path) => predicate(basename(path)));
  const packageFiles = byName((name) => name === 'package.json');
  const observed = observeVersions(root, byName((name) => LOCKFILE_NAMES.includes(name)), packageFiles, reader);
  const naming = decideNamingRules(observed);
  const location = locatePrismaSchemas({
    root,
    configFiles: byName((name) => /^prisma\.config\.[cm]?[jt]s$/u.test(name)),
    packageFiles,
    observedVersions: observed,
    reader,
  });
  const counts: PrismaProjectCounts = { schemasOutsideProject: 0, unresolvedGeneratorOutputs: 0, unresolvedTypedSql: 0 };
  const schemaFiles = loadSchemaFiles(root, location, reader, counts);
  const catalog = schemaFiles.length === 0 ? undefined : buildPrismaCatalog(schemaFiles, naming.rules);
  const generators = generatorBlocks(root, schemaFiles);
  return {
    walk,
    naming,
    location,
    schemaFiles,
    catalog,
    outputDirectories: outputDirectories(generators, counts),
    typedSqlFiles: typedSqlFiles(root, location, generators, counts),
    usesPrisma: observed.length > 0 || packageFiles.some((path) => manifestUsesPrisma(path, reader)),
    counts,
  };
}

/**
 * 트리 탐색에서 모을 파일인지 본다. 선언 파일(`.d.ts`)은 소스로 파싱하지 않고, Cloudflare D1 바인딩 선언
 * (`wrangler types`가 만드는 `interface Env { DB: D1Database }`)을 찾을 때만 읽는다.
 *
 * @param name 파일 이름
 * @returns 모으면 true
 */
function isInterestingFile(name: string): boolean {
  return isSourceFileName(name) || isDeclarationFileName(name) || name === 'package.json' || LOCKFILE_NAMES.includes(name);
}

/**
 * 파일 이름이 TypeScript 선언 파일인지 본다.
 *
 * @param name 파일 이름
 * @returns 선언 파일이면 true
 */
export function isDeclarationFileName(name: string): boolean {
  return /\.d\.[cm]?ts$/u.test(name);
}

/**
 * 잠금 파일(없으면 package.json 명세)에서 Prisma 패키지 버전을 모은다.
 *
 * @param root 프로젝트 realpath
 * @param lockfiles 잠금 파일 절대 경로
 * @param packageFiles package.json 절대 경로
 * @param reader 파일 읽기 도우미
 * @returns 관찰 버전
 */
function observeVersions(root: string, lockfiles: readonly string[], packageFiles: readonly string[], reader: ProjectReader): ObservedVersion[] {
  const observed: ObservedVersion[] = [];
  for (const path of lockfiles) {
    const text = reader.read(path)?.text;
    if (text === undefined) continue;
    const source = toPosixRelative(root, path);
    for (const entry of versionsFromLockfile(basename(path), text)) observed.push({ ...entry, source });
  }
  if (observed.length > 0) return observed;
  for (const path of packageFiles) observed.push(...manifestVersions(root, path, reader));
  return observed;
}

/**
 * package.json 의존성 명세에서 버전을 뽑는다(잠금 파일이 없을 때만).
 *
 * @param root 프로젝트 realpath
 * @param path package.json 절대 경로
 * @param reader 파일 읽기 도우미
 * @returns 관찰 버전. 범위를 정할 수 없는 명세는 버전 없는 'unknown'으로 싣는다
 */
function manifestVersions(root: string, path: string, reader: ProjectReader): ObservedVersion[] {
  const manifest = readManifest(path, reader);
  const result: ObservedVersion[] = [];
  for (const section of ['dependencies', 'devDependencies']) {
    const entries = manifest?.[section];
    if (typeof entries !== 'object' || entries === null) continue;
    for (const name of ['prisma', '@prisma/client', '@prisma/orm-family-sql'] as const satisfies readonly TrackedPackage[]) {
      const specifier = (entries as Record<string, unknown>)[name];
      if (typeof specifier !== 'string') continue;
      result.push({ packageName: name, version: versionFromSpecifier(specifier) ?? specifier, source: toPosixRelative(root, path) });
    }
  }
  return result;
}

/**
 * package.json이 Prisma에 의존하는지 본다.
 *
 * @param path package.json 절대 경로
 * @param reader 파일 읽기 도우미
 * @returns 의존하면 true
 */
function manifestUsesPrisma(path: string, reader: ProjectReader): boolean {
  const manifest = readManifest(path, reader);
  return ['dependencies', 'devDependencies'].some((section) => {
    const entries = manifest?.[section];
    return typeof entries === 'object' && entries !== null
      && ['prisma', '@prisma/client', '@prisma/orm-family-sql'].some((name) => name in entries);
  });
}

/**
 * 스키마 파일을 읽고 파싱한다. 프로젝트 밖 파일은 위치를 표현할 수 없어 읽지 않고 센다.
 *
 * @param root 프로젝트 realpath
 * @param location 스키마 탐색 결과
 * @param reader 파일 읽기 도우미
 * @param counts 계수(갱신된다)
 * @returns 파싱한 스키마 파일(경로 순)
 */
function loadSchemaFiles(root: string, location: SchemaLocation, reader: ProjectReader, counts: PrismaProjectCounts): LoadedSchemaFile[] {
  const paths = [...new Set(location.roots.flatMap((schemaRoot) => schemaRoot.files))].sort(compareStrings);
  const files: LoadedSchemaFile[] = [];
  for (const path of paths) {
    const relative = toPosixRelative(root, path);
    if (relative.startsWith('../') || relative === '..') {
      counts.schemasOutsideProject++;
      continue;
    }
    const text = reader.read(path)?.text;
    if (text !== undefined) files.push({ path: relative, text: new SourceText(text), parsed: parsePrismaSchema(text) });
  }
  return files;
}

/** generator 블록과 그 파일의 절대 디렉터리다. */
interface GeneratorBlock {
  readonly block: PrismaBlock;
  readonly directory: string;
}

/**
 * 스키마 파일들의 generator 블록을 모은다.
 *
 * @param root 프로젝트 realpath
 * @param files 스키마 파일
 * @returns generator 블록
 */
function generatorBlocks(root: string, files: readonly LoadedSchemaFile[]): GeneratorBlock[] {
  return files.flatMap((file) => file.parsed.blocks
    .filter((block) => block.kind === 'generator')
    .map((block) => ({ block, directory: dirname(resolve(root, file.path)) })));
}

/**
 * 클라이언트 generator의 output 디렉터리를 절대 경로로 모은다(스키마 파일 기준 상대 경로).
 *
 * @param generators generator 블록
 * @param counts 계수(갱신된다)
 * @returns 절대 디렉터리(정렬, 중복 없음)
 */
function outputDirectories(generators: readonly GeneratorBlock[], counts: PrismaProjectCounts): string[] {
  const directories = new Set<string>();
  for (const { block, directory } of generators) {
    const provider = stringProperty(block, 'provider');
    if (provider === undefined || !clientGenerators.has(provider) || !block.properties.has('output')) continue;
    const output = stringProperty(block, 'output');
    if (output === undefined) counts.unresolvedGeneratorOutputs++;
    else directories.add(resolve(directory, output));
  }
  return [...directories].sort(compareStrings);
}

/**
 * TypedSQL이 켜진 경우의 `.sql` 파일을 모은다(설정 `typedSql.path` 또는 `<스키마 루트>/sql`, 최상위만).
 *
 * @param root 프로젝트 realpath
 * @param location 스키마 탐색 결과
 * @param generators generator 블록
 * @param counts 계수(갱신된다)
 * @returns `.sql` 파일 절대 경로(정렬)
 */
function typedSqlFiles(root: string, location: SchemaLocation, generators: readonly GeneratorBlock[], counts: PrismaProjectCounts): string[] {
  const enabled = generators.some(({ block }) => {
    const features = block.properties.get('previewFeatures');
    return features?.kind === 'list' && features.items.some((item) => item.kind === 'string' && item.value === 'typedSql');
  });
  if (!enabled) return [];
  const files = new Set<string>();
  for (const schemaRoot of location.roots) {
    if (schemaRoot.typedSqlDirectory === 'unresolved') {
      counts.unresolvedTypedSql++;
      continue;
    }
    const directory = schemaRoot.typedSqlDirectory ?? join(schemaRoot.rootDirectory, 'sql');
    for (const file of sqlFilesIn(directory)) if (!toPosixRelative(root, file).startsWith('..')) files.add(file);
  }
  return [...files].sort(compareStrings);
}

/**
 * 디렉터리 최상위의 `.sql` 파일이다.
 *
 * @param directory 절대 경로
 * @returns 파일 절대 경로
 */
function sqlFilesIn(directory: string): string[] {
  if (pathKind(directory) !== 'directory') return [];
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => join(directory, name))
      .filter((path) => pathKind(path) === 'file');
  } catch {
    // 읽지 못한 TypedSQL 디렉터리는 파일이 없는 것과 같게 본다(스키마 사실에는 영향이 없다).
    return [];
  }
}
