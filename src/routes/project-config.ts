/**
 * 프로젝트 루트의 `next.config.*`와 `package.json`을 읽는다.
 *
 * 설정 파일은 Next.js와 같은 우선순위로 첫 파일 하나만 읽는다. `package.json`에서는 선언된
 * `next` 버전 범위만 본다 — tsograph가 확인한 Next 동작(16.x)과 다른 주 버전이면 소비자가
 * 알 수 있게 limitation으로 알린다.
 */

import type { CommandFileSystem } from '../cli/file-system.ts';
import { DEFAULT_NEXT_ROUTE_CONFIG, NEXT_CONFIG_FILE_NAMES, type NextRouteConfig, readNextRouteConfig, unresolvedConfig } from './next-config.ts';
import { pathKind } from './project-scan.ts';
import { parseSource, scriptKindOf } from './source-file.ts';
import { readTextFile } from './text-file.ts';

/** 설정 파일·package.json의 최대 크기(바이트)다. */
export const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

/** tsograph가 동작을 확인한 Next.js 주 버전이다. */
export const VERIFIED_NEXT_MAJOR = 16;

/** 선언된 Next 버전 판정이다. */
export type NextVersionStatus =
  | { readonly kind: 'verified' }
  /** package.json이 없거나 읽을 수 없거나 next 의존성이 없다. */
  | { readonly kind: 'undeclared' }
  /** 확인한 주 버전과 다르거나 범위를 해석하지 못했다. 값은 싣지 않는다(임의 문자열). */
  | { readonly kind: 'unverified' };

/**
 * Next 설정 파일을 찾아 라우트 설정을 읽는다. 없으면 Next 기본값이다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @returns 라우트 설정
 */
export async function loadNextRouteConfig(fileSystem: CommandFileSystem, project: string): Promise<NextRouteConfig> {
  for (const fileName of NEXT_CONFIG_FILE_NAMES) {
    if (await pathKind(fileSystem, `${project}/${fileName}`) !== 'file') continue;
    const read = await readTextFile(fileSystem, `${project}/${fileName}`, MAX_CONFIG_FILE_BYTES);
    if (read.kind === 'failure') return unresolvedConfig(fileName, 'unreadable', 0);
    const parsed = parseSource(fileName, read.text, scriptKindOf(fileName)!);
    return readNextRouteConfig(fileName, parsed.sourceFile, parsed.hasSyntaxErrors);
  }
  return DEFAULT_NEXT_ROUTE_CONFIG;
}

/**
 * package.json에 선언된 `next` 버전 범위를 판정한다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @returns 판정
 */
export async function readNextVersionStatus(fileSystem: CommandFileSystem, project: string): Promise<NextVersionStatus> {
  const read = await readTextFile(fileSystem, `${project}/package.json`, MAX_CONFIG_FILE_BYTES);
  if (read.kind === 'failure') return { kind: 'undeclared' };
  const range = declaredNextRange(read.text);
  if (range === undefined) return { kind: 'undeclared' };
  return isVerifiedRange(range) ? { kind: 'verified' } : { kind: 'unverified' };
}

/**
 * package.json 텍스트에서 `next` 의존성 범위를 꺼낸다.
 *
 * @param text package.json 텍스트
 * @returns 범위 문자열 또는 undefined
 */
function declaredNextRange(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 깨진 package.json은 "선언 없음"과 같게 보고 limitation으로 알린다.
    return undefined;
  }
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const section = isRecord(parsed) ? parsed[field] : undefined;
    const range = isRecord(section) ? section['next'] : undefined;
    if (typeof range === 'string') return range;
  }
  return undefined;
}

/**
 * 버전 범위가 확인한 주 버전 하나에만 걸리는지 본다.
 *
 * `16.2.7`·`^16.1.0`·`~16.2.0`·`>=16.0.0 <17` 같은 흔한 형태만 인정하고, `latest`·태그·`*`·
 * 여러 주 버전에 걸치는 범위는 인정하지 않는다(안전한 쪽).
 *
 * @param range 범위 문자열
 * @returns 확인한 주 버전 범위면 true
 */
function isVerifiedRange(range: string): boolean {
  const single = /^[\^~=v]?\s*(\d+)\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/u.exec(range.trim());
  if (single !== null) return Number(single[1]) === VERIFIED_NEXT_MAJOR;
  const bounded = /^>=\s*(\d+)\.\d+(?:\.\d+)?\s+<\s*(\d+)(?:\.0){0,2}$/u.exec(range.trim());
  return bounded !== null && Number(bounded[1]) === VERIFIED_NEXT_MAJOR && Number(bounded[2]) === VERIFIED_NEXT_MAJOR + 1;
}

/**
 * 값이 JSON 객체인지 확인한다.
 *
 * @param value 값
 * @returns 객체면 true
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
