/**
 * Next.js 프로젝트에서 라우트에 관련된 파일 위치를 모은다.
 *
 * 확인한 Next.js 16.2.7 규칙:
 * - `app`·`pages`는 프로젝트 루트를 먼저, 없으면 `src/`를 본다(`lib/find-pages-dir.js`의 `findDir`).
 * - proxy·middleware 파일은 `app`/`pages`의 부모(루트 또는 `src`)에 `proxy.<ext>`·`middleware.<ext>`로
 *   둔다(`build/index.js`의 탐지 정규식, ext는 `pageExtensions`).
 * - `public/`은 루트에 둔다(`src` 폴더 문서).
 *
 * Next의 디렉터리 스캔은 symlink를 따라가지만, 여기서는 트리 안이든 최상위 후보(`app`·`src`·
 * `pages`·`public`·`next.config.*`·`package.json`)든 symlink를 따라가지 않고 세기만 한다 — 저장소 밖을
 * 읽거나 순환하지 않기 위해서다. 항목 수·깊이에 상한을 두고 넘으면 잘랐다고 알린다.
 */

import type { CommandFileSystem } from '../cli/file-system.ts';
import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';

/** 스캔하는 디렉터리 항목 총수 상한이다. */
export const MAX_SCANNED_ENTRIES = 200_000;

/** 스캔하는 디렉터리 깊이 상한이다. */
export const MAX_SCAN_DEPTH = 64;

/** 스캔 중 센 공백이다. */
export interface ScanGaps {
  /** 따라가지 않은 symlink 수 */
  symlinks: number;
  /** 읽지 못한 디렉터리 수 */
  unreadableDirectories: number;
  /** 교환 형식이 금지하는 문자가 든 이름이라 건너뛴 항목 수 */
  unsafeNames: number;
  /** 항목·깊이 상한으로 스캔을 잘랐으면 true */
  truncated: boolean;
  /** 지금까지 본 항목 수 */
  scannedEntries: number;
}

/** 파일 라우터 디렉터리 위치다(프로젝트 루트 기준 POSIX 경로). */
export interface RouterDirectories {
  readonly appDirectory: string | undefined;
  readonly pagesDirectory: string | undefined;
  /** Next가 골랐을 최상위 위치 중 symlink라 따라가지 않은 경로(정렬, 중복 없음) */
  readonly symlinkedLocations: readonly string[];
}

/** 디렉터리 걷기 선택이다. */
export interface WalkOptions {
  /** true를 돌려주는 이름의 파일·디렉터리는 건너뛴다(App Router의 `_` 규칙). */
  readonly skipName?: (name: string) => boolean;
}

/**
 * 프로젝트 기준 경로 하나의 종류다. 어느 구성 요소도 symlink를 따라가지 않는다.
 *
 * - `symlink`: 어떤 구성 요소가 풀리는 symlink다(`symlinkPath`가 그 구성 요소까지의 경로).
 * - `dangling`: 끊어진 symlink다. Next의 `existsSync`처럼 없는 것으로 본다.
 */
export type EntryLookup =
  | { readonly kind: 'file' | 'directory' | 'other' | 'dangling' | 'absent' }
  | { readonly kind: 'symlink'; readonly symlinkPath: string };

/**
 * 새 공백 계수기를 만든다.
 *
 * @returns 0으로 시작하는 계수기
 */
export function createScanGaps(): ScanGaps {
  return { symlinks: 0, unreadableDirectories: 0, unsafeNames: 0, truncated: false, scannedEntries: 0 };
}

/**
 * `app`·`pages` 디렉터리를 찾는다. 루트가 `src/`보다 우선한다.
 *
 * 최상위 후보(`app`, `src`, `src/app` …)가 symlink면 내부 symlink와 같은 규칙으로 따라가지 않는다.
 * `stat`은 마지막 symlink를 따라가므로 부모 디렉터리 목록(`lstat` 의미)으로 종류를 본다. Next는
 * symlink 후보도 존재하는 것으로 골라 `src/`로 내려가지 않으므로, 여기서도 그 자리에서 멈추고
 * 경로를 limitation용으로 남긴다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @returns 찾은 디렉터리와 따라가지 않은 symlink 위치
 */
export async function locateRouterDirectories(fileSystem: CommandFileSystem, project: string): Promise<RouterDirectories> {
  const symlinked = new Set<string>();
  const appDirectory = await firstDirectory(fileSystem, project, ['app', 'src/app'], symlinked);
  const pagesDirectory = await firstDirectory(fileSystem, project, ['pages', 'src/pages'], symlinked);
  return { appDirectory, pagesDirectory, symlinkedLocations: [...symlinked].sort(compareStrings) };
}

/**
 * 후보 중 Next가 고를 첫 디렉터리를 돌려준다. symlink 후보에서는 따라가지 않고 멈춘다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param candidates 프로젝트 기준 후보 경로
 * @param symlinked 따라가지 않은 symlink 경로(갱신)
 * @returns 찾은 후보 또는 undefined
 */
async function firstDirectory(
  fileSystem: CommandFileSystem,
  project: string,
  candidates: readonly string[],
  symlinked: Set<string>,
): Promise<string | undefined> {
  for (const candidate of candidates) {
    const entry = await lookupEntry(fileSystem, project, candidate);
    if (entry.kind === 'directory') return candidate;
    if (entry.kind === 'symlink') {
      symlinked.add(entry.symlinkPath);
      return undefined;
    }
  }
  return undefined;
}

/**
 * 프로젝트 기준 경로의 종류를 부모 디렉터리 목록으로 구한다(symlink를 따라가지 않는다).
 *
 * symlink가 풀리는지만 realpath로 확인하고 그 대상은 읽지 않는다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param relativePath 프로젝트 기준 POSIX 경로
 * @returns 경로 종류
 */
export async function lookupEntry(fileSystem: CommandFileSystem, project: string, relativePath: string): Promise<EntryLookup> {
  const parts = relativePath.split('/');
  for (let index = 0; index < parts.length; index++) {
    const parent = [project, ...parts.slice(0, index)].join('/');
    const kind = await childKind(fileSystem, parent, parts[index]!);
    const path = parts.slice(0, index + 1).join('/');
    if (kind === 'symlink') return await isResolvable(fileSystem, `${project}/${path}`) ? { kind: 'symlink', symlinkPath: path } : { kind: 'dangling' };
    if (kind === undefined || (index < parts.length - 1 && kind !== 'directory')) return { kind: 'absent' };
    if (index === parts.length - 1) return { kind };
  }
  /* node:coverage ignore next */
  return { kind: 'absent' };
}

/**
 * 디렉터리 목록에서 이름 하나의 종류를 찾는다.
 *
 * @param fileSystem 파일 시스템
 * @param directory 절대 경로
 * @param name 찾을 이름
 * @returns 항목 종류, 없거나 목록을 읽지 못하면 undefined
 */
async function childKind(fileSystem: CommandFileSystem, directory: string, name: string) {
  try {
    return (await fileSystem.listDirectory(directory)).find((entry) => entry.name === name)?.kind;
  } catch {
    // 목록을 읽지 못한 부모는 "없음"으로 본다(후보 탐색). 라우터 트리 안의 실패는 walk가 센다.
    return undefined;
  }
}

/**
 * symlink가 존재하는 대상으로 풀리는지 확인한다(대상 내용은 읽지 않는다).
 *
 * @param fileSystem 파일 시스템
 * @param path 절대 경로
 * @returns 풀리면 true
 */
async function isResolvable(fileSystem: CommandFileSystem, path: string): Promise<boolean> {
  try {
    await fileSystem.realPath(path);
    return true;
  } catch {
    // 끊어진 symlink는 Next의 existsSync처럼 없는 것으로 본다.
    return false;
  }
}

/**
 * 디렉터리 아래 파일을 깊이 우선으로 모은다. symlink는 따라가지 않는다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param directory 프로젝트 기준 시작 디렉터리
 * @param gaps 공백 계수기(갱신)
 * @param options 건너뛸 이름
 * @returns 프로젝트 기준 파일 경로(코드 단위 순서)
 */
export async function walkFiles(
  fileSystem: CommandFileSystem,
  project: string,
  directory: string,
  gaps: ScanGaps,
  options: WalkOptions = {},
): Promise<string[]> {
  const files: string[] = [];
  await walkDirectory(fileSystem, project, directory, 0, gaps, options, files);
  return files.sort(compareStrings);
}

/**
 * 디렉터리 하나를 읽고 하위로 내려간다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param directory 프로젝트 기준 디렉터리
 * @param depth 현재 깊이
 * @param gaps 공백 계수기(갱신)
 * @param options 건너뛸 이름
 * @param files 모은 파일(갱신)
 */
async function walkDirectory(
  fileSystem: CommandFileSystem,
  project: string,
  directory: string,
  depth: number,
  gaps: ScanGaps,
  options: WalkOptions,
  files: string[],
): Promise<void> {
  if (depth > MAX_SCAN_DEPTH) {
    gaps.truncated = true;
    return;
  }
  const entries = await listEntries(fileSystem, `${project}/${directory}`, gaps);
  for (const entry of entries) {
    if (gaps.scannedEntries >= MAX_SCANNED_ENTRIES) {
      gaps.truncated = true;
      return;
    }
    gaps.scannedEntries += 1;
    if (options.skipName?.(entry.name) === true) continue;
    const path = `${directory}/${entry.name}`;
    if (entry.kind === 'symlink') gaps.symlinks += 1;
    if (entry.kind === 'file') files.push(path);
    if (entry.kind === 'directory') await walkDirectory(fileSystem, project, path, depth + 1, gaps, options, files);
  }
}

/**
 * 디렉터리 항목을 이름 순으로 읽는다. 실패하면 빈 목록과 공백 계수다.
 *
 * 교환 형식이 금지하는 문자(제어 문자 등)가 든 이름은 문서 경로에 실을 수 없어 세고 뺀다.
 *
 * @param fileSystem 파일 시스템
 * @param path 절대 경로
 * @param gaps 공백 계수기(갱신)
 * @returns 이름 순 항목
 */
export async function listEntries(fileSystem: CommandFileSystem, path: string, gaps: ScanGaps) {
  try {
    const entries = await fileSystem.listDirectory(path);
    const safe = entries.filter((entry) => isSafeIdentifier(entry.name));
    gaps.unsafeNames += entries.length - safe.length;
    return safe.sort((left, right) => compareStrings(left.name, right.name));
  } catch {
    // 읽지 못한 디렉터리는 조용히 비우지 않고 route-coverage 공백으로 센다.
    gaps.unreadableDirectories += 1;
    return [];
  }
}
