/**
 * 프로젝트 트리에서 스캔할 파일을 모은다.
 *
 * 심볼릭 링크는 따라가지 않고 개수만 센다 — 조인 루트 밖 트리가 사실에 섞이거나 순환하는
 * 것을 막기 위해서다. 의존성·생성물·도구 상태 디렉터리는 분석 대상의 코드가 아니므로 건너뛴다.
 * 교환 형식이 금지하는 문자(제어 문자·U+2028/U+2029·짝 없는 서러게이트)가 든 이름도 건너뛰고 센다 —
 * 그 경로를 실은 문서는 소비자가 통째로 거부하기 때문이다(Next 라우트 스캔 `routes/project-scan.ts`와 같은 판정).
 * 순서는 경로 코드 단위 순으로 정렬해 결정적으로 만든다.
 */

import { lstatSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
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
  /**
   * 따라가지 않은 심볼릭 링크의 절대 경로다(개수는 skippedSymlinks). 걷기 밖에서 조립한 경로를 판정하는
   * 단계(Prisma 스키마 탐색 등)가 같은 링크를 다시 만나도 두 번 세지 않게 한다.
   */
  readonly skippedSymlinkPaths: ReadonlySet<string>;
  /** 읽지 못한 디렉터리 수다. */
  readonly unreadableDirectories: number;
  /**
   * 교환 형식이 금지하는 문자가 든 이름이라 건너뛴 항목 수다. 걷기가 쓰려던 항목(포함 규칙을 통과한 파일, 내려갈
   * 디렉터리)만 센다. 디렉터리면 그 아래 전체가 빠진다 — 소비자는 이 값이 0보다 크면 스캔이 완전하다고 주장하지 않는다.
   */
  readonly unsafeNames: number;
  /** 항목 상한에 걸려 스캔을 멈췄는지 여부다. */
  readonly truncated: boolean;
  /** 실행용 PnP 로더는 소스 진입 파일이 아니다. 건너뛴 수만 남긴다. */
  readonly skippedLoaders?: number;
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
  const state = { visited: 0, skippedSymlinkPaths: new Set<string>(), unreadableDirectories: 0, unsafeNames: 0, truncated: false, skippedLoaders: 0 };
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
    skippedSymlinks: state.skippedSymlinkPaths.size,
    skippedSymlinkPaths: state.skippedSymlinkPaths,
    unreadableDirectories: state.unreadableDirectories,
    unsafeNames: state.unsafeNames,
    truncated: state.truncated,
    ...(state.skippedLoaders > 0 ? { skippedLoaders: state.skippedLoaders } : {}),
  };
}

/** 스캔 중 누적하는 계수다. */
interface WalkState {
  visited: number;
  /** 따라가지 않은 링크의 절대 경로다(항목마다 한 번만 방문하므로 크기가 곧 개수다). */
  skippedSymlinkPaths: Set<string>;
  unreadableDirectories: number;
  /** 금지 문자가 든 이름이라 건너뛴 항목 수다. */
  unsafeNames: number;
  truncated: boolean;
  skippedLoaders: number;
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
    state.skippedSymlinkPaths.add(path);
  } else if (stats.isDirectory()) {
    if (!isSkippedDirectory(name) && !options.excludedDirectories.has(path) && admitsName(name, state)) pending.push(path);
  } else if (stats.isFile() && isPnpLoader(name)) {
    state.skippedLoaders++;
  } else if (stats.isFile() && options.includeFile(name) && admitsName(name, state)) {
    found.push([name, path]);
  }
}

/**
 * 걷기가 쓰려는 항목(내려갈 디렉터리·모을 파일)의 이름을 문서 경로에 실을 수 있는지 본다. 실을 수 없으면 센다.
 *
 * 이름 하나라도 금지 문자가 있으면 그 아래 상대 경로 전체를 실을 수 없다. 이름 사이에는 구분자 '/'만 더하므로
 * 모든 이름이 안전하면 상대 경로도 안전하다. 어차피 쓰지 않는 항목(다른 확장자 파일·건너뛰는 디렉터리)은 세지
 * 않는다 — 분석과 무관한 이름 하나로 소비자가 스캔을 불완전하다고 보고하지 않게 하기 위해서다.
 *
 * @param name 항목 이름
 * @param state 계수(실을 수 없으면 `unsafeNames`가 늘어난다)
 * @returns 실을 수 있으면 true
 */
function admitsName(name: string, state: WalkState): boolean {
  if (isSafeIdentifier(name)) return true;
  state.unsafeNames++;
  return false;
}

/**
 * 이름으로 건너뛰는 디렉터리인지 본다. graph Program의 설정 루트 열거(`graph/config-roots.ts`)도 같은 판정을 써서
 * 걷기가 뺀 디렉터리를 tsconfig/jsconfig include가 다시 넣지 않게 한다.
 *
 * @param name 디렉터리 이름
 * @returns 건너뛰면 true
 */
export function isSkippedDirectory(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(name);
}

/** PnP 실행 로더는 선언·앱 소스가 아니므로 진입 파일에서 제외한다. 실행하지 않는다. */
export function isPnpLoader(name: string): boolean {
  return /^\.pnp\.(?:[cm]?js|loader\.mjs)$/u.test(name);
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
