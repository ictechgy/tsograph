/**
 * 프로젝트 트리에서 스캔할 파일을 모은다.
 *
 * 심볼릭 링크는 따라가지 않고 개수만 센다 — 조인 루트 밖 트리가 사실에 섞이거나 순환하는
 * 것을 막기 위해서다. 의존성·생성물·도구 상태 디렉터리는 분석 대상의 코드가 아니므로 건너뛴다.
 * 순서는 경로 코드 단위 순으로 정렬해 결정적으로 만든다.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { compareStrings } from '../exchange/sorted-json.ts';

/** 방문할 디렉터리 항목 수 상한이다. 거대한 트리에서 끝없이 돌지 않게 한다. */
export const MAX_VISITED_ENTRIES = 500_000;

/** 이름만으로 건너뛰는 디렉터리다(점으로 시작하는 디렉터리도 건너뛴다). */
export const SKIPPED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage',
]);

/** 모은 파일과 건너뛴 근거의 계수다. */
export interface ProjectFiles {
  /** 프로젝트 루트 기준 POSIX 상대 경로 → 절대 경로다. 정렬돼 있다. */
  readonly files: ReadonlyMap<string, string>;
  /** 따라가지 않은 심볼릭 링크 수다. */
  readonly skippedSymlinks: number;
  /** 읽지 못한 디렉터리 수다. */
  readonly unreadableDirectories: number;
  /** 항목 상한에 걸려 스캔을 멈췄는지 여부다. */
  readonly truncated: boolean;
}

/** 파일 모으기 옵션이다. */
export interface CollectOptions {
  /** 파일 이름으로 포함 여부를 정한다. */
  readonly includeFile: (name: string) => boolean;
  /** 추가로 건너뛸 절대 디렉터리 경로다(Prisma 생성 클라이언트 출력 등). */
  readonly excludedDirectories: ReadonlySet<string>;
}

/**
 * 프로젝트 루트 아래 파일을 모은다.
 *
 * @param root 프로젝트 realpath
 * @param options 포함·제외 규칙
 * @returns 정렬된 파일 목록과 계수
 */
export function collectProjectFiles(root: string, options: CollectOptions): ProjectFiles {
  const state = { visited: 0, skippedSymlinks: 0, unreadableDirectories: 0, truncated: false };
  const found: [string, string][] = [];
  const pending = [root];
  while (pending.length > 0 && !state.truncated) {
    const directory = pending.pop()!;
    for (const entry of readDirectory(directory, state)) {
      if (++state.visited > MAX_VISITED_ENTRIES) {
        state.truncated = true;
        break;
      }
      classifyEntry(join(directory, entry), entry, options, state, pending, found);
    }
  }
  found.forEach((pair) => { pair[0] = toPosixRelative(root, pair[1]); });
  found.sort(([left], [right]) => compareStrings(left, right));
  return {
    files: new Map(found),
    skippedSymlinks: state.skippedSymlinks,
    unreadableDirectories: state.unreadableDirectories,
    truncated: state.truncated,
  };
}

/** 스캔 중 누적하는 계수다. */
interface WalkState {
  visited: number;
  skippedSymlinks: number;
  unreadableDirectories: number;
  truncated: boolean;
}

/**
 * 디렉터리 항목 이름을 읽는다. 실패는 계수로 남긴다.
 *
 * @param directory 절대 경로
 * @param state 계수
 * @returns 정렬된 항목 이름
 */
function readDirectory(directory: string, state: WalkState): string[] {
  try {
    return readdirSync(directory).sort(compareStrings);
  } catch {
    // 권한 없음 등으로 못 읽은 디렉터리는 사실 대신 unreadable 계수로 보고한다.
    state.unreadableDirectories++;
    return [];
  }
}

/**
 * 항목 하나를 파일·디렉터리·링크로 나눠 처리한다.
 *
 * @param path 절대 경로
 * @param name 항목 이름
 * @param options 포함·제외 규칙
 * @param state 계수
 * @param pending 방문할 디렉터리 스택
 * @param found 모은 파일
 */
function classifyEntry(
  path: string,
  name: string,
  options: CollectOptions,
  state: WalkState,
  pending: string[],
  found: [string, string][],
): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    // 사이에 사라진 항목은 읽지 못한 디렉터리 항목으로 센다.
    state.unreadableDirectories++;
    return;
  }
  if (stats.isSymbolicLink()) {
    state.skippedSymlinks++;
  } else if (stats.isDirectory()) {
    if (!isSkippedDirectory(name) && !options.excludedDirectories.has(path)) pending.push(path);
  } else if (stats.isFile() && options.includeFile(name)) {
    found.push([name, path]);
  }
}

/**
 * 이름으로 건너뛰는 디렉터리인지 본다.
 *
 * @param name 디렉터리 이름
 * @returns 건너뛰면 true
 */
function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(name);
}

/**
 * 루트 기준 POSIX 상대 경로를 만든다.
 *
 * @param root 루트 절대 경로
 * @param path 대상 절대 경로
 * @returns 상대 경로
 */
export function toPosixRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}
