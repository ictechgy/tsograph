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

/** 읽은 프로젝트 의존성이다. */
export interface ProjectDependencies {
  /** package.json을 읽었는지 */
  readonly manifestRead: boolean;
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
  const manifest = await readRootFile(fileSystem, project, 'package.json');
  const declared = manifest === undefined ? new Map<string, string>() : declaredRanges(manifest);
  const lockfiles: [string, string][] = [];
  for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) {
    const text = await readRootFile(fileSystem, project, name);
    if (text !== undefined) lockfiles.push([name, text]);
  }
  const cache = new Map<string, number | undefined>();
  return {
    manifestRead: manifest !== undefined,
    declared,
    majorOf: (name) => {
      if (!cache.has(name)) cache.set(name, decideMajor(name, declared.get(name), lockfiles));
      return cache.get(name);
    },
  };
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
 * package.json 텍스트에서 선언 범위를 모은다. 깨진 JSON은 빈 목록이다.
 *
 * @param text package.json 텍스트
 * @returns 이름 → 범위
 */
export function declaredRanges(text: string): Map<string, string> {
  const ranges = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 깨진 package.json은 선언이 없는 것과 같게 보고 호출자가 limitation으로 알린다.
    return ranges;
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
 * 주 버전을 정한다: 잠금 파일의 최상위 버전들이 한 주 버전이면 그 값, 아니면 선언 범위의 주 버전.
 *
 * @param name 패키지 이름
 * @param range 선언 범위
 * @param lockfiles (파일 이름, 텍스트) 목록
 * @returns 주 버전 또는 undefined
 */
function decideMajor(name: string, range: string | undefined, lockfiles: readonly [string, string][]): number | undefined {
  const majors = new Set(lockfiles.flatMap(([file, text]) => lockedVersions(file, text, name)).map(majorOfVersion).filter((major) => major !== undefined));
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
  if (file === 'package-lock.json' || file === 'npm-shrinkwrap.json') return npmVersions(text, name);
  if (file === 'pnpm-lock.yaml') return pnpmVersions(text, name);
  if (file === 'yarn.lock') return yarnVersions(text, name);
  return bunVersions(text, name);
}

/**
 * npm 잠금 파일(v2+ `packages["node_modules/<name>"]`, v1 `dependencies`)의 버전이다.
 *
 * @param text 텍스트
 * @param name 패키지 이름
 * @returns 버전 목록
 */
function npmVersions(text: string, name: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 깨진 잠금 파일은 근거로 쓰지 않는다(package.json 범위로 판단한다).
    return [];
  }
  const document = isRecord(parsed) ? parsed : {};
  const packages = isRecord(document['packages']) ? document['packages'] : {};
  const entry = packages[`node_modules/${name}`];
  if (isRecord(entry) && typeof entry['version'] === 'string') return [entry['version']];
  const dependencies = isRecord(document['dependencies']) ? document['dependencies'] : {};
  const legacy = dependencies[name];
  return isRecord(legacy) && typeof legacy['version'] === 'string' ? [legacy['version']] : [];
}

/**
 * pnpm 잠금 파일의 루트 importer(v6+) 또는 최상위 `dependencies`(v5) 버전이다.
 *
 * @param text 텍스트
 * @param name 패키지 이름
 * @returns 버전 목록
 */
function pnpmVersions(text: string, name: string): string[] {
  let parsed: unknown;
  try {
    parsed = parseYaml(text, { maxAliasCount: 100 });
  } catch {
    // 깨진 잠금 파일은 근거로 쓰지 않는다.
    return [];
  }
  const document = isRecord(parsed) ? parsed : {};
  const importers = isRecord(document['importers']) ? document['importers'] : {};
  const root = isRecord(importers['.']) ? importers['.'] : document;
  const versions: string[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const section = isRecord(root[field]) ? root[field] : {};
    const entry = section[name];
    const version = isRecord(entry) ? entry['version'] : entry;
    if (typeof version === 'string') versions.push(version.replace(/\(.*$/u, ''));
  }
  return versions;
}

/**
 * yarn 잠금 파일(classic `version "x"`, berry `version: x`)에서 그 이름의 항목 버전을 모두 읽는다.
 *
 * @param text 텍스트
 * @param name 패키지 이름
 * @returns 버전 목록
 */
function yarnVersions(text: string, name: string): string[] {
  const versions: string[] = [];
  let inEntry = false;
  for (const line of text.split('\n')) {
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('#')) {
      inEntry = line.replace(/^"/u, '').split(/,\s*/u).some((key) => key.replace(/^"/u, '').startsWith(`${name}@`));
      continue;
    }
    const version = /^ {2}version:? "?([^"\s]+)"?/u.exec(line);
    if (inEntry && version !== null) {
      versions.push(version[1]!);
      inEntry = false;
    }
  }
  return versions;
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
