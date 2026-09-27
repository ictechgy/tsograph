/**
 * Prisma CLI(7.8.0)의 스키마 해석 규칙대로 스키마 파일을 찾는다.
 *
 * 근거(`@prisma/internals@7.8.0`·`@prisma/config@7.8.0`):
 *
 * - 기준 디렉터리마다 설정 파일(`prisma.config.*`, `.config/prisma.*`, `.config/prisma.config.*`)을 찾고,
 *   `schema`가 있으면 설정 파일 디렉터리 기준 경로를 쓴다. 디렉터리면 그 아래 `.prisma` 파일을
 *   재귀로 모두 읽는다(다중 파일 스키마).
 * - 없으면 `<기준>/schema.prisma`, 그다음 `<기준>/prisma/schema.prisma` 한 파일이다.
 * - package.json의 `"prisma": { "schema" }`는 7.x가 읽지 않는다. 6.x 이하로 확인된 경우에만 쓴다.
 *
 * 기준 디렉터리는 프로젝트 루트, 설정 파일이 있는 디렉터리, Prisma에 의존하는 package.json이 있는
 * 디렉터리다(모노레포 패키지). 설정 값이 리터럴이 아니면 추측하지 않고 limitation으로 알린다.
 */

import { readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { compareStrings } from '../exchange/sorted-json.ts';
import { PRISMA_CONFIG_CANDIDATES, readPrismaConfig, type ConfigValue } from './prisma-config.ts';
import { type ObservedVersion, parseVersion } from './prisma-version.ts';
import { pathKind, type ProjectReader } from './project-reader.ts';

/** 찾은 스키마 루트 하나다. */
export interface SchemaRoot {
  /** 스키마 파일 절대 경로 목록(정렬됨)이다. */
  readonly files: readonly string[];
  /** 스키마 루트 디렉터리(단일 파일이면 그 디렉터리, 폴더면 폴더)다. */
  readonly rootDirectory: string;
  /** 설정의 TypedSQL 경로(절대) 또는 기본값을 쓰라는 undefined, 읽지 못하면 'unresolved'다. */
  readonly typedSqlDirectory: string | 'unresolved' | undefined;
}

/** 스키마 탐색 결과와 공백 계수다. */
export interface SchemaLocation {
  readonly roots: readonly SchemaRoot[];
  /** 설정 값이 리터럴이 아니어서 읽지 못한 설정 파일 수다. */
  readonly unresolvedConfigs: number;
  /** 설정·package.json이 가리켰지만 없는 스키마 경로 수다. */
  readonly missingSchemas: number;
  /** 스키마 폴더 안에서 따라가지 않은 심볼릭 링크 수다. */
  readonly skippedSymlinks: number;
}

/** 탐색 입력이다. */
export interface LocateInput {
  readonly root: string;
  /** 프로젝트에서 찾은 설정 파일·package.json 절대 경로다. */
  readonly configFiles: readonly string[];
  readonly packageFiles: readonly string[];
  readonly observedVersions: readonly ObservedVersion[];
  readonly reader: ProjectReader;
}

/**
 * 스키마 루트를 찾는다.
 *
 * @param input 탐색 입력
 * @returns 스키마 루트와 계수
 */
export function locatePrismaSchemas(input: LocateInput): SchemaLocation {
  const state = { unresolvedConfigs: 0, missingSchemas: 0, skippedSymlinks: 0 };
  const roots = new Map<string, SchemaRoot>();
  for (const base of baseDirectories(input)) {
    const root = locateInBase(base, input, state);
    if (root !== undefined && !roots.has(root.rootDirectory + '\u0000' + root.files.join('\u0000'))) {
      roots.set(root.rootDirectory + '\u0000' + root.files.join('\u0000'), root);
    }
  }
  return { roots: [...roots.values()], ...state };
}

/** 탐색 중 누적하는 계수다. */
interface LocateState {
  unresolvedConfigs: number;
  missingSchemas: number;
  skippedSymlinks: number;
}

/**
 * 기준 디렉터리 목록을 만든다(정렬, 중복 없음).
 *
 * @param input 탐색 입력
 * @returns 절대 디렉터리 목록
 */
function baseDirectories(input: LocateInput): string[] {
  const bases = new Set<string>([input.root]);
  for (const config of input.configFiles) {
    const directory = dirname(config);
    bases.add(directory.endsWith('/.config') ? dirname(directory) : directory);
  }
  for (const packageFile of input.packageFiles) {
    if (dependsOnPrisma(packageFile, input.reader)) bases.add(dirname(packageFile));
  }
  return [...bases].sort(compareStrings);
}

/**
 * package.json이 Prisma에 의존하는지 본다.
 *
 * @param path package.json 절대 경로
 * @param reader 파일 읽기 도우미
 * @returns 의존하면 true
 */
function dependsOnPrisma(path: string, reader: ProjectReader): boolean {
  const manifest = readManifest(path, reader);
  return ['dependencies', 'devDependencies'].some((section) => {
    const entries = manifest?.[section];
    return isRecord(entries) && ('prisma' in entries || '@prisma/client' in entries);
  });
}

/**
 * 기준 디렉터리 하나에서 스키마를 찾는다.
 *
 * @param base 기준 디렉터리
 * @param input 탐색 입력
 * @param state 계수(갱신된다)
 * @returns 스키마 루트 또는 undefined
 */
function locateInBase(base: string, input: LocateInput, state: LocateState): SchemaRoot | undefined {
  const configPath = PRISMA_CONFIG_CANDIDATES.map((candidate) => join(base, candidate))
    .find((candidate) => pathKind(candidate) === 'file');
  if (configPath !== undefined) {
    const text = input.reader.read(configPath)?.text;
    const config = text === undefined ? undefined : readPrismaConfig(configPath, text);
    if (config === undefined || config.schema.kind === 'unresolved') {
      state.unresolvedConfigs++;
      return undefined;
    }
    const typedSql = typedSqlDirectory(config.typedSqlPath, dirname(configPath));
    if (config.schema.kind === 'literal') return schemaAt(resolve(dirname(configPath), config.schema.value), typedSql, state);
    return defaultSchema(base, typedSql, input, state);
  }
  return defaultSchema(base, undefined, input, state);
}

/**
 * TypedSQL 경로 설정을 절대 경로로 바꾼다.
 *
 * @param value 설정 값
 * @param configDirectory 설정 파일 디렉터리
 * @returns 절대 경로, 기본값(undefined), 또는 'unresolved'
 */
function typedSqlDirectory(value: ConfigValue, configDirectory: string): string | 'unresolved' | undefined {
  if (value.kind === 'literal') return resolve(configDirectory, value.value);
  return value.kind === 'unresolved' ? 'unresolved' : undefined;
}

/**
 * 설정에 schema가 없을 때의 스키마를 찾는다: (6.x 이하면) package.json, 그다음 기본 위치.
 *
 * @param base 기준 디렉터리
 * @param typedSql TypedSQL 경로 설정
 * @param input 탐색 입력
 * @param state 계수(갱신된다)
 * @returns 스키마 루트 또는 undefined
 */
function defaultSchema(
  base: string,
  typedSql: string | 'unresolved' | undefined,
  input: LocateInput,
  state: LocateState,
): SchemaRoot | undefined {
  const manifestSchema = legacyManifestSchema(base, input);
  if (manifestSchema !== undefined) return schemaAt(resolve(base, manifestSchema), typedSql, state);
  for (const candidate of [join(base, 'schema.prisma'), join(base, 'prisma', 'schema.prisma')]) {
    if (pathKind(candidate) === 'file') return { files: [candidate], rootDirectory: dirname(candidate), typedSqlDirectory: typedSql };
  }
  return undefined;
}

/**
 * 6.x 이하가 읽던 package.json `prisma.schema` 값을 돌려준다. 7.x 이상으로 확인됐거나 버전을 모르면
 * 쓰지 않는다(7.x는 이 필드를 무시한다).
 *
 * @param base 기준 디렉터리
 * @param input 탐색 입력
 * @returns 상대 경로 또는 undefined
 */
function legacyManifestSchema(base: string, input: LocateInput): string | undefined {
  const majors = input.observedVersions
    .filter((entry) => entry.packageName !== '@prisma/orm-family-sql')
    .map((entry) => parseVersion(entry.version)?.major);
  if (majors.length === 0 || majors.some((major) => major === undefined || major >= 7)) return undefined;
  const manifest = readManifest(join(base, 'package.json'), input.reader);
  const prisma = manifest?.prisma;
  return isRecord(prisma) && typeof prisma.schema === 'string' ? prisma.schema : undefined;
}

/**
 * 설정·package.json이 가리킨 경로의 스키마를 읽는다.
 *
 * @param path 절대 경로(파일 또는 폴더)
 * @param typedSql TypedSQL 경로 설정
 * @param state 계수(갱신된다)
 * @returns 스키마 루트 또는 undefined(없으면 계수)
 */
function schemaAt(path: string, typedSql: string | 'unresolved' | undefined, state: LocateState): SchemaRoot | undefined {
  const kind = pathKind(path);
  if (kind === 'file') return { files: [path], rootDirectory: dirname(path), typedSqlDirectory: typedSql };
  if (kind === 'directory') {
    const files = prismaFilesUnder(path, state);
    if (files.length > 0) return { files, rootDirectory: path, typedSqlDirectory: typedSql };
  }
  state.missingSchemas++;
  return undefined;
}

/** 스키마 폴더 재귀 탐색의 항목 상한이다. */
const MAX_SCHEMA_DIRECTORY_ENTRIES = 10_000;

/**
 * 폴더 아래 `.prisma` 파일을 재귀로 모은다. 심볼릭 링크는 따라가지 않고 센다.
 *
 * @param directory 절대 경로
 * @param state 계수(갱신된다)
 * @returns 정렬된 절대 경로 목록
 */
function prismaFilesUnder(directory: string, state: LocateState): string[] {
  const files: string[] = [];
  const pending = [directory];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_SCHEMA_DIRECTORY_ENTRIES) {
    const current = pending.pop()!;
    for (const name of safeReaddir(current)) {
      visited++;
      const path = join(current, name);
      const stats = safeLstat(path);
      if (stats === undefined) continue;
      if (stats.isSymbolicLink()) state.skippedSymlinks++;
      else if (stats.isDirectory()) pending.push(path);
      else if (stats.isFile() && name.endsWith('.prisma')) files.push(path);
    }
  }
  return files.sort(compareStrings);
}

/**
 * 디렉터리를 읽는다. 실패하면 빈 목록이다.
 *
 * @param directory 절대 경로
 * @returns 항목 이름
 */
function safeReaddir(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    // 읽지 못한 하위 폴더는 스키마 파일이 없는 것으로 보되, 부모가 있으면 다른 파일은 읽는다.
    return [];
  }
}

/**
 * lstat을 구한다. 실패하면 undefined다.
 *
 * @param path 절대 경로
 * @returns 상태 또는 undefined
 */
function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    // 사이에 사라진 항목은 건너뛴다.
    return undefined;
  }
}

/**
 * package.json을 읽어 객체로 돌려준다.
 *
 * @param path 절대 경로
 * @param reader 파일 읽기 도우미
 * @returns 객체 또는 undefined
 */
export function readManifest(path: string, reader: ProjectReader): Record<string, unknown> | undefined {
  if (pathKind(path) !== 'file') return undefined;
  const text = reader.read(path)?.text;
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // 깨진 package.json은 Prisma 의존의 근거가 아니다.
    return undefined;
  }
}

/**
 * JSON 객체인지 본다.
 *
 * @param value 값
 * @returns 객체면 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
