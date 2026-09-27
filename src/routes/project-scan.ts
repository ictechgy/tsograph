/**
 * Next.js 프로젝트에서 라우트에 관련된 파일 위치를 모은다.
 *
 * 확인한 Next.js 16.2.7 규칙:
 * - `app`·`pages`는 프로젝트 루트를 먼저, 없으면 `src/`를 본다(`lib/find-pages-dir.js`의 `findDir`).
 * - proxy·middleware 파일은 `app`/`pages`의 부모(루트 또는 `src`)에 `proxy.<ext>`·`middleware.<ext>`로
 *   둔다(`build/index.js`의 탐지 정규식, ext는 `pageExtensions`).
 * - `public/`은 루트에 둔다(`src` 폴더 문서).
 *
 * Next의 디렉터리 스캔은 symlink를 따라가지만, 여기서는 따라가지 않고 개수만 센다 — 저장소 밖을
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
}

/** 디렉터리 걷기 선택이다. */
export interface WalkOptions {
  /** true를 돌려주는 이름의 파일·디렉터리는 건너뛴다(App Router의 `_` 규칙). */
  readonly skipName?: (name: string) => boolean;
}

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
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @returns 찾은 디렉터리
 */
export async function locateRouterDirectories(fileSystem: CommandFileSystem, project: string): Promise<RouterDirectories> {
  return {
    appDirectory: await firstDirectory(fileSystem, project, ['app', 'src/app']),
    pagesDirectory: await firstDirectory(fileSystem, project, ['pages', 'src/pages']),
  };
}

/**
 * 후보 중 처음 존재하는 디렉터리를 돌려준다.
 *
 * @param fileSystem 파일 시스템
 * @param project 프로젝트 realpath
 * @param candidates 프로젝트 기준 후보 경로
 * @returns 찾은 후보 또는 undefined
 */
async function firstDirectory(fileSystem: CommandFileSystem, project: string, candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await pathKind(fileSystem, `${project}/${candidate}`) === 'directory') return candidate;
  }
  return undefined;
}

/**
 * 경로 종류를 구한다. 없거나 읽을 수 없으면 undefined다.
 *
 * @param fileSystem 파일 시스템
 * @param path 절대 경로
 * @returns 종류 또는 undefined
 */
export async function pathKind(fileSystem: CommandFileSystem, path: string): Promise<'file' | 'directory' | 'other' | undefined> {
  try {
    return (await fileSystem.status(path)).kind;
  } catch {
    // 없는 경로는 정상 신호다(후보 탐색). 권한 문제도 "없음"으로 보고 호출자가 공백을 센다.
    return undefined;
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
