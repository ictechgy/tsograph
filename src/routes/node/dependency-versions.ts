/**
 * 프로젝트 루트의 `package.json`과 잠금 파일에서 의존성의 주 버전을 읽는다.
 *
 * 경로 문법이 주 버전마다 다른 프레임워크(Express 4의 path-to-regexp 0.1과 Express 5의 8, @koa/router 13의 6과 14의 8)는
 * 설치된 주 버전을 알아야 한다. 잠금 파일(프로젝트 루트의 `package-lock.json`·`npm-shrinkwrap.json`·`pnpm-lock.yaml`·
 * `yarn.lock`·`bun.lock`)의 최상위 설치 버전을 먼저 보고, 없으면 `package.json` 범위가 한 주 버전에만 걸릴 때 그 값을 쓴다.
 * 그 밖(태그·`*`·여러 주 버전에 걸친 범위)은 모른다고 보고 호출자가 limitation으로 알린다.
 */

import { parse as parseYaml } from 'yaml';

import type { CommandFileSystem } from '../../cli/file-system.ts';
import { lookupEntry } from '../project-scan.ts';
import { readTextFile } from '../text-file.ts';

/** 잠금 파일·package.json 최대 크기(바이트)다. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;

/** 의존성 섹션 이름이다. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** 프로젝트 루트에서 읽는 잠금 파일 이름이다(이 순서로 근거를 모은다). */
const LOCKFILE_NAMES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock'] as const;

/**
 * 잠금 파일 하나에서 패키지 이름의 최상위 설치 버전 목록을 찾는 조회 함수다.
 *
 * npm·pnpm·yarn 잠금 파일은 한 번만 파싱·스캔해 만들고 이름마다 조회만 한다. 프레임워크마다 처음부터 다시 파싱하면
 * 수 MiB pnpm 잠금 파일에서 확인할 프레임워크 수만큼(최대 5번) YAML 파싱 시간이 곱해진다.
 */
type LockfileIndex = (name: string) => readonly string[];

/** yarn 잠금 파일 항목 하나(머리 줄의 키 목록과 그 아래 첫 `version` 값)다. */
interface YarnEntry {
  /** 앞 따옴표를 뗀 키(`<이름>@<범위>…`) */
  readonly keys: readonly string[];
  /** 설치 버전 */
  readonly version: string;
}

/**
 * 루트 package.json 상태다. `unusable`은 파일은 있는데 선언을 읽지 못한 경우(깨진 JSON, UTF-8 아님, 크기 상한 초과,
 * symlink)다 — 없는 것과 달리 프레임워크를 감지하지 못한 이유를 limitation으로 알려야 한다.
 */
export type ManifestState = 'absent' | 'parsed' | 'unusable';

/** 읽은 프로젝트 의존성이다. */
export interface ProjectDependencies {
  /** 루트 package.json 상태 */
  readonly manifest: ManifestState;
  /** 선언한 이름 → 범위 문자열 */
  readonly declared: ReadonlyMap<string, string>;
  /** 이름 → 확정한 주 버전(잠금 파일 우선). 모르면 없다. */
  majorOf(name: string): number | undefined;
}

/**
 * 프로젝트 루트의 의존성을 읽는다. symlink인 파일은 따라가지 않는다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @returns 의존성
 */
export async function readProjectDependencies(fileSystem: CommandFileSystem, project: string): Promise<ProjectDependencies> {
  const manifest = await readManifest(fileSystem, project);
  const declared = manifest.declared ?? new Map<string, string>();
  const lockfiles: LockfileIndex[] = [];
  for (const name of LOCKFILE_NAMES) {
    const text = await readRootFile(fileSystem, project, name);
    if (text !== undefined) lockfiles.push(lazyLockfileIndex(name, text));
  }
  const cache = new Map<string, number | undefined>();
  return {
    manifest: manifest.state,
    declared,
    majorOf: (name) => {
      if (!cache.has(name)) cache.set(name, decideMajor(name, declared.get(name), lockfiles));
      return cache.get(name);
    },
  };
}

/**
 * 루트 package.json을 읽어 상태와 선언 범위를 돌려준다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @returns 상태와 선언 범위(읽지 못했으면 undefined)
 */
async function readManifest(fileSystem: CommandFileSystem, project: string): Promise<{ state: ManifestState; declared: Map<string, string> | undefined }> {
  if ((await lookupEntry(fileSystem, project, 'package.json')).kind === 'absent') return { state: 'absent', declared: undefined };
  const text = await readRootFile(fileSystem, project, 'package.json');
  const declared = text === undefined ? undefined : declaredRanges(text);
  return { state: declared === undefined ? 'unusable' : 'parsed', declared };
}

/**
 * 루트의 일반 파일 하나를 텍스트로 읽는다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param name 파일 이름
 * @returns 텍스트 또는 undefined
 */
async function readRootFile(fileSystem: CommandFileSystem, project: string, name: string): Promise<string | undefined> {
  if ((await lookupEntry(fileSystem, project, name)).kind !== 'file') return undefined;
  const read = await readTextFile(fileSystem, `${project}/${name}`, MAX_MANIFEST_BYTES);
  return read.kind === 'text' ? read.text : undefined;
}

/**
 * package.json 텍스트에서 선언 범위를 모은다.
 *
 * @param text package.json 텍스트
 * @returns 이름 → 범위, 깨진 JSON이면 undefined
 */
export function declaredRanges(text: string): Map<string, string> | undefined {
  const ranges = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 깨진 package.json은 선언을 알 수 없다는 뜻이다. 호출자가 `unusable` 상태로 limitation을 낸다.
    return undefined;
  }
  for (const field of DEPENDENCY_FIELDS) {
    const section = isRecord(parsed) ? parsed[field] : undefined;
    if (!isRecord(section)) continue;
    for (const [name, range] of Object.entries(section)) {
      if (typeof range === 'string' && !ranges.has(name)) ranges.set(name, range);
    }
  }
  return ranges;
}

/**
 * 처음 조회할 때 잠금 파일을 한 번만 색인하는 조회 함수를 만든다.
 *
 * 프레임워크를 하나도 확인하지 않는 프로젝트(Next 전용 등)는 잠금 파일을 파싱하지 않는다(예전처럼 조회할 때만 파싱한다).
 *
 * @param file 파일 이름
 * @param text 텍스트
 * @returns 조회 함수
 */
function lazyLockfileIndex(file: string, text: string): LockfileIndex {
  let index: LockfileIndex | undefined;
  return (name) => (index ??= indexLockfile(file, text))(name);
}

/**
 * 주 버전을 정한다: 잠금 파일의 최상위 버전들이 한 주 버전이면 그 값, 아니면 선언 범위의 주 버전.
 *
 * @param name 패키지 이름
 * @param range 선언 범위
 * @param lockfiles 잠금 파일별 조회 함수
 * @returns 주 버전 또는 undefined
 */
function decideMajor(name: string, range: string | undefined, lockfiles: readonly LockfileIndex[]): number | undefined {
  const majors = new Set(lockfiles.flatMap((lookup) => lookup(name)).map(majorOfVersion).filter((major) => major !== undefined));
  if (majors.size === 1) return [...majors][0];
  if (majors.size > 1) return undefined;
  return range === undefined ? undefined : majorOfRange(range);
}

/**
 * semver 문자열의 주 버전이다.
 *
 * @param version 버전
 * @returns 주 버전 또는 undefined
 */
function majorOfVersion(version: string): number | undefined {
  const match = /^v?(\d+)\.\d+\.\d+/u.exec(version.trim());
  return match === null ? undefined : Number(match[1]);
}

/**
 * 범위가 한 주 버전에만 걸리면 그 값이다(`4.1.0`·`^4.1.0`·`~4.1.0`·`4.x`·`4`·`>=4.0.0 <5`).
 *
 * @param range 범위
 * @returns 주 버전 또는 undefined
 */
export function majorOfRange(range: string): number | undefined {
  const trimmed = range.trim().replace(/^npm:[^@]+@/u, '');
  const single = /^[\^~=v]?\s*(\d+)(?:\.(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?)?$/u.exec(trimmed);
  if (single !== null && !(trimmed.startsWith('^') && single[1] === '0')) return Number(single[1]);
  const bounded = /^>=\s*(\d+)\.\d+(?:\.\d+)?\s+<\s*(\d+)(?:\.0){0,2}$/u.exec(trimmed);
  if (bounded !== null && Number(bounded[2]) === Number(bounded[1]) + 1) return Number(bounded[1]);
  return undefined;
}

/**
 * 잠금 파일에서 패키지의 최상위 설치 버전을 뽑는다.
 *
 * @param file 파일 이름
 * @param text 텍스트
 * @param name 패키지 이름
 * @returns 버전 목록
 */
export function lockedVersions(file: string, text: string, name: string): string[] {
  return [...indexLockfile(file, text)(name)];
}

/**
 * 잠금 파일을 형식에 맞게 한 번 파싱·스캔해 이름별 조회 함수를 만든다.
 *
 * bun 텍스트 잠금 파일은 파싱하지 않고 지금처럼 이름마다 리터럴로 시작하는 정규식으로 찾는다. 모든 이름을 한 번에 모으는
 * 범용 정규식보다 빠르기 때문이다(4 MiB 파일에서 이름 5개 약 1 ms 대 범용 1회 약 20 ms).
 *
 * @param file 파일 이름
 * @param text 텍스트
 * @returns 조회 함수
 */
function indexLockfile(file: string, text: string): LockfileIndex {
  if (file === 'package-lock.json' || file === 'npm-shrinkwrap.json') return npmIndex(text);
  if (file === 'pnpm-lock.yaml') return pnpmIndex(text);
  if (file === 'yarn.lock') return yarnIndex(text);
  return (name) => bunVersions(text, name);
}

/**
 * npm 잠금 파일(v2+ `packages["node_modules/<name>"]`, v1 `dependencies`)의 조회 함수다.
 *
 * @param text 텍스트
 * @returns 조회 함수
 */
function npmIndex(text: string): LockfileIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 깨진 잠금 파일은 근거로 쓰지 않는다(package.json 범위로 판단한다).
    return () => [];
  }
  const document = isRecord(parsed) ? parsed : {};
  const packages = isRecord(document['packages']) ? document['packages'] : {};
  const dependencies = isRecord(document['dependencies']) ? document['dependencies'] : {};
  return (name) => {
    const entry = packages[`node_modules/${name}`];
    if (isRecord(entry) && typeof entry['version'] === 'string') return [entry['version']];
    const legacy = dependencies[name];
    return isRecord(legacy) && typeof legacy['version'] === 'string' ? [legacy['version']] : [];
  };
}

/**
 * pnpm 잠금 파일의 루트 importer(v6+) 또는 최상위 `dependencies`(v5) 조회 함수다. 의존성 섹션 네 개만 남겨
 * `packages`·`snapshots` 같은 큰 부분은 파싱 뒤 버린다.
 *
 * @param text 텍스트
 * @returns 조회 함수
 */
function pnpmIndex(text: string): LockfileIndex {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { maxAliasCount: 100 });
  } catch {
    // 깨진 잠금 파일은 근거로 쓰지 않는다.
    return () => [];
  }
  const document = isRecord(parsed) ? parsed : {};
  const importers = isRecord(document['importers']) ? document['importers'] : {};
  const root = isRecord(importers['.']) ? importers['.'] : document;
  const sections = DEPENDENCY_FIELDS.map((field) => root[field]).filter(isRecord);
  return (name) => sections.flatMap((section) => {
    const entry = section[name];
    const version = isRecord(entry) ? entry['version'] : entry;
    return typeof version === 'string' ? [version.replace(/\(.*$/u, '')] : [];
  });
}

/**
 * yarn 잠금 파일(classic `version "x"`, berry `version: x`)의 조회 함수다. 텍스트는 한 번만 줄로 나눠 항목(머리 줄 키와
 * 첫 `version` 값)을 모으고, 이름마다 키가 `<이름>@`로 시작하는 항목의 버전을 파일 순서대로 돌려준다.
 *
 * @param text 텍스트
 * @returns 조회 함수
 */
function yarnIndex(text: string): LockfileIndex {
  const entries: YarnEntry[] = [];
  let keys: readonly string[] | undefined;
  for (const line of text.split('\n')) {
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
      keys = line.replace(/^"/u, '').split(/,\s*/u).map((key) => key.replace(/^"/u, ''));
      continue;
    }
    if (keys === undefined) continue;
    const version = /^ {2}version:? "?([^"\s]+)"?/u.exec(line);
    if (version === null) continue;
    entries.push({ keys, version: version[1]! });
    keys = undefined;
  }
  return (name) => {
    const prefix = `${name}@`;
    return entries.filter((entry) => entry.keys.some((key) => key.startsWith(prefix))).map((entry) => entry.version);
  };
}

/**
 * bun 텍스트 잠금 파일의 `"<name>": ["<name>@x.y.z", …]` 항목이다.
 *
 * @param text 텍스트
 * @param name 패키지 이름
 * @returns 버전 목록
 */
function bunVersions(text: string, name: string): string[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&');
  const pattern = new RegExp(`"${escaped}": \\["${escaped}@(\\d+\\.\\d+\\.\\d+[^"]*)"`, 'gu');
  return [...text.matchAll(pattern)].map((match) => match[1]!);
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
