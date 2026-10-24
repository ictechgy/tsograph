/**
 * tsconfig/jsconfig의 `include`·`files`가 고르는 Program 루트 파일을 걷기 정책 안으로 묶는다.
 *
 * TypeScript 기본 열거(`ts.sys.readDirectory`)는 include 글롭을 개수·위치 상한 없이 펼치고 symlink를 따라간다. 그래서
 * 걷기가 일부러 건너뛰는 `build/`·`dist/`·`out/`·`coverage/`(include 없는 jsconfig의 기본 글롭도 연다)와 프로젝트 밖
 * 트리가 Program 루트가 된다. 로컬 번들이 Program을 수 배 느리게 하거나 4 MiB 상한에 걸려 bound 디스패치를 끄고,
 * 신뢰하지 않는 설정이 파일 시스템 루트를 include하면 전체를 열거한다.
 *
 * 글롭 규칙은 TypeScript 것(내부 `matchFiles`)을 그대로 쓰고, 그 함수가 보는 디렉터리 목록만 걷기 정책으로 바꾼다:
 * 경계(프로젝트, `--workspace`면 workspace) 밖, 걷기가 건너뛰는 이름(점 디렉터리·{@link isSkippedDirectory})과 호출자가 뺀
 * 디렉터리(Prisma 생성 출력) 아래, symlink는 열지 않는다. 방문 항목 수에는 걷기와 같은 상한을 둔다. `files`에 적은
 * 경로도 같은 정책으로 거른다. 경계 안의 일반 선언(`.d.ts`)은 그대로 루트가 된다 — Node 백엔드 걷기는 선언을 모으지
 * 않아 설정이 유일한 공급원이기 때문이다.
 *
 * 경계 밖을 가리켜 쓰지 않은 include 패턴·`files` 항목 수와 항목 상한에 걸린 사실은 호출자가 limitation으로 알린다.
 * 글롭이 제외 디렉터리·symlink 아래에서 고를 파일을 뺀 것은 걷기와 같은 정책이라 따로 알리지 않는다. 반면 이름으로
 * 적은 `files` 항목과 와일드카드 없는 include 경로가 그 정책에 막히면 센다 — 걷기는 사용자가 콕 집어 고른 경로를 다룬
 * 적이 없어 "걷기와 같다"는 근거가 맞지 않고, 막은 사실을 조용히 넘기지 않기 위해서다.
 */

import { type Dirent, lstatSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';
import { gitignoreEntryFilter } from '../scan/gitignore.ts';

import { isPnpLoader, isSkippedDirectory, MAX_VISITED_ENTRIES } from '../schema/project-files.ts';

/** 설정 루트 열거와 `files` 항목이 머물러야 하는 걷기 경계다. */
export interface ScanBoundary {
  /** 경계 realpath다. `--workspace`면 workspace, 아니면 프로젝트다. */
  readonly root: string;
  /** 선택적 소스 진입 정책이다. import 의존성 읽기는 별개다. */
  readonly acceptsEntry?: (absolute: string) => boolean;
  /** 호출자의 걷기가 따로 건너뛴 디렉터리 절대 경로다(Prisma 생성 클라이언트 출력 등). */
  readonly excludedDirectories: ReadonlySet<string>;
  /** 열거가 방문할 디렉터리 항목 수 상한이다. 생략하면 걷기와 같은 {@link MAX_VISITED_ENTRIES}다(테스트가 줄여 넣는다). */
  readonly maxVisitedEntries?: number;
  /** 하나의 소유권 계획에서 모든 config 열거가 함께 쓰는 예산이다. */
  readonly configVisits?: { visited: number };
}

/** 경계가 설정 루트에서 뺀 것 중 호출자가 알릴 공백이다. 공백이 없으면 속성을 두지 않는다. */
export interface ConfigRootGaps {
  /** 경계 밖을 가리켜 열거하지 않은 include 패턴과 버린 `files` 항목 수 */
  readonly outsideConfigRoots?: number;
  /**
   * 경계 안이지만 걷기가 건너뛰는 디렉터리 아래이거나 symlink를 거쳐 쓰지 않은, 이름으로 적은 `files` 항목과 와일드카드
   * 없는 include 경로 수
   */
  readonly excludedConfigRoots?: number;
  /** include 열거가 항목 상한에 걸려 멈췄으면 true */
  readonly configRootsTruncated?: true;
}

/** TypeScript `matchFiles`가 받는 디렉터리 목록이다. */
interface FileSystemEntries {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

/** TypeScript 5.9.3 내부 `matchFiles`의 호출 모양이다(공개 선언에는 없다). */
type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => FileSystemEntries,
  realpath: (path: string) => string,
) => string[];

/** 열지 않는 디렉터리의 목록이다. */
const noEntries: FileSystemEntries = { files: [], directories: [] };

/** TypeScript가 `matchFiles`를 내보내지 않을 때의 개발자용 오류 문구다(원인과 고칠 곳). */
const MISSING_MATCH_FILES = 'the installed TypeScript does not expose matchFiles; graph/config-roots.ts must be updated for this TypeScript version';

/**
 * 설정 파일 하나를 해석하는 동안 쓰는 경계 필터다. {@link readDirectory}를 `ts.ParseConfigHost`에 넣고, 해석이 끝나면
 * {@link admit}으로 최종 루트 파일을 거른 뒤 {@link gaps}로 알릴 공백을 읽는다.
 */
export class ConfigRootBoundary {
  readonly #root: string;
  readonly #acceptsEntry: ((absolute: string) => boolean) | undefined;
  readonly #excluded: ReadonlySet<string>;
  readonly #limit: number;
  readonly #shared: { visited: number } | undefined;
  /** 디렉터리 절대 경로 → 걷기 정책상 열 수 있는지(메모, 경계 루트는 처음부터 참) */
  readonly #directories = new Map<string, boolean>();
  /** 열거가 돌려준 파일이다. 정책을 통과한 디렉터리의 일반 파일이라 `files` 항목처럼 다시 검사하지 않는다. */
  readonly #enumerated = new Set<string>();
  #visited = 0;
  #outside = 0;
  /** 걷기 정책에 막힌, 이름으로 적은 `files` 항목·와일드카드 없는 include 경로 수 */
  #namedExcluded = 0;
  #truncated = false;

  /**
   * @param boundary 걷기 경계
   */
  constructor(boundary: ScanBoundary) {
    this.#root = resolve(boundary.root);
    this.#acceptsEntry = boundary.acceptsEntry ?? gitignoreEntryFilter(this.#root);
    this.#excluded = boundary.excludedDirectories;
    this.#limit = boundary.maxVisitedEntries ?? MAX_VISITED_ENTRIES;
    this.#shared = boundary.configVisits;
    this.#directories.set(this.#root, true);
  }

  /**
   * `ts.ParseConfigHost.readDirectory` 구현이다. 시작 디렉터리가 경계 밖인 include는 열거하지 않고 세며, 나머지는
   * TypeScript와 같은 규칙으로 맞추되 정책을 통과한 디렉터리 목록만 보여 준다.
   *
   * @param rootDir 설정 디렉터리
   * @param extensions 고를 확장자
   * @param excludes 설정의 exclude(없으면 TypeScript 기본값)
   * @param includes 설정의 include
   * @param depth 열거 깊이 상한(TypeScript가 정한다)
   * @returns 고른 파일 경로
   */
  readonly readDirectory = (
    rootDir: string,
    extensions: readonly string[],
    excludes: readonly string[] | undefined,
    includes: readonly string[],
    depth?: number,
  ): string[] => {
    const base = resolve(rootDir);
    const inside = includes.filter((include) => this.#keepsInclude(base, include));
    // 남은 include가 없으면 열거하지 않는다. include 목록이 비면 TypeScript는 모든 파일을 고르기 때문이다.
    if (inside.length === 0) return [];
    const files = typeScriptMatchFiles()(base, extensions, excludes, inside, ts.sys.useCaseSensitiveFileNames, this.#root, depth,
      (path) => this.#entries(path), (path) => path);
    for (const file of files) this.#enumerated.add(file);
    return files;
  };

  /**
   * 설정이 고른 루트 파일 중 정책을 통과한 것만 남긴다. 열거 결과는 그대로 두고 `files` 항목만 검사한다.
   *
   * @param fileNames TypeScript가 해석한 루트 파일(`files` 항목 + 열거 결과)
   * @returns 남긴 루트 파일(순서 유지)
   */
  admit(fileNames: readonly string[]): string[] {
    return fileNames.filter((fileName) => (this.#enumerated.has(fileName) || this.#admitsListedFile(fileName))
      && this.#acceptsEntry?.(fileName) !== false);
  }

  /**
   * 호출자가 알릴 공백이다.
   *
   * @returns 경계 밖 항목 수·정책에 막힌 이름 항목 수·상한 도달 여부(없으면 빈 객체)
   */
  gaps(): ConfigRootGaps {
    return {
      ...(this.#outside > 0 ? { outsideConfigRoots: this.#outside } : {}),
      ...(this.#namedExcluded > 0 ? { excludedConfigRoots: this.#namedExcluded } : {}),
      ...(this.#truncated ? { configRootsTruncated: true } : {}),
    };
  }

  /**
   * include 패턴이 경계 안에서 시작하는지 본다. 밖이면 센다.
   *
   * TypeScript처럼 `\`를 경로 구분자로 읽고(`normalizeSlashes`) `.`·`..`를 접은 절대 패턴으로 판정한다. 패턴이 경계 안이면
   * 열거 시작 경로(와일드카드 앞 리터럴 부분)도 경계 안이고, 패턴이 밖이면 시작 경로도 밖이라 와일드카드 위치를 따로 찾지
   * 않는다. 찾으면 오히려 틀린다: 경계 경로나 `${configDir}`로 치환된 설정 디렉터리에 든 `*`·`?`는 사용자가 쓴 글롭이
   * 아니다. TypeScript는 그 문자도 와일드카드로 읽어 그 조상부터 열거하려 하지만, 그 디렉터리는 {@link #entries}가 경계
   * 밖이라 열지 않고, 패턴이 뜻한 경계 안 파일은 설정 디렉터리 열거로 그대로 찾는다.
   *
   * 경계 안이고 경계 아래 부분에 와일드카드가 없으면 이름으로 적은 경로라 {@link #noteNamedInclude}로 정책을 본다.
   *
   * @param base 설정 디렉터리
   * @param include include 패턴(상대·절대)
   * @returns 열거하면 true
   */
  #keepsInclude(base: string, include: string): boolean {
    const pattern = resolve(base, include.replaceAll('\\', '/'));
    if (!isInside(this.#root, pattern)) {
      this.#outside++;
      return false;
    }
    if (!/[*?]/u.test(relative(this.#root, pattern))) this.#noteNamedInclude(pattern);
    return true;
  }

  /**
   * 와일드카드 없이 경로를 적은 include가 걷기 정책에 막히면 센다. 열거는 그대로 맡긴다({@link #entries}가 막힌
   * 디렉터리를 열지 않는다).
   *
   * TypeScript는 마지막 성분에 점이 있으면 그 경로의 파일 하나를, 없으면 그 디렉터리 아래 전체를 고른다
   * (`isImplicitGlob`). 그래서 파일 모양이면 부모 디렉터리를, 디렉터리 모양이면 그 디렉터리 자신을 정책으로 판정한다.
   * 없는 경로나 모양과 종류가 다른 항목(점이 든 디렉터리 이름 등)은 TypeScript도 아무것도 고르지 못하므로 세지 않는다.
   * symlink는 따라가지 않고 센다.
   *
   * @param path 정규화한 절대 include 경로(경계 안)
   */
  #noteNamedInclude(path: string): void {
    const kind = entryKind(path);
    const blocked = kind === 'link' || (basename(path).includes('.')
      ? kind === 'file' && !this.#admitsDirectory(dirname(path))
      : kind === 'directory' && !this.#admitsDirectory(path));
    if (blocked) this.#namedExcluded++;
  }

  /**
   * `matchFiles`가 여는 디렉터리의 목록이다. 정책 밖 디렉터리·상한 뒤에는 빈 목록이고, symlink·특수 파일과 건너뛰는
   * 디렉터리는 목록에서 뺀다.
   *
   * @param path 디렉터리 경로
   * @returns 파일·하위 디렉터리 이름
   */
  #entries(path: string): FileSystemEntries {
    const directory = resolve(this.#root, path);
    if (this.#truncated || !this.#admitsDirectory(directory)) return noEntries;
    if (this.#shared !== undefined && this.#shared.visited >= this.#limit) { this.#truncated = true; return noEntries; }
    const listed = listDirectory(directory);
    this.#visited += listed.length;
    if (this.#shared !== undefined) this.#shared.visited += listed.length;
    if (this.#visited > this.#limit || (this.#shared?.visited ?? 0) > this.#limit) {
      this.#truncated = true;
      return noEntries;
    }
    const files: string[] = [];
    const directories: string[] = [];
    for (const entry of listed) {
      if (entry.isFile() && !isPnpLoader(entry.name) && this.#acceptsEntry?.(join(directory, entry.name)) !== false) files.push(entry.name);
      else if (entry.isDirectory() && this.#admitsChild(directory, entry.name)) directories.push(entry.name);
    }
    return { files, directories };
  }

  /**
   * 목록에서 본 하위 디렉터리(링크가 아님)를 이름 규칙으로 판정하고 기억한다.
   *
   * @param directory 부모 디렉터리
   * @param name 하위 디렉터리 이름
   * @returns 열 수 있으면 true
   */
  #admitsChild(directory: string, name: string): boolean {
    const path = join(directory, name);
    const admitted = this.#admitsName(path, name);
    this.#directories.set(path, admitted);
    return admitted;
  }

  /**
   * 목록을 거치지 않고 닿은 디렉터리(include 시작 디렉터리, `files` 항목의 부모)를 판정한다. 경계 안이고, 부모가 열 수
   * 있고, 이름 규칙을 통과하며, symlink가 아닌 실제 디렉터리여야 한다.
   *
   * @param directory 디렉터리 절대 경로
   * @returns 열 수 있으면 true
   */
  #admitsDirectory(directory: string): boolean {
    const known = this.#directories.get(directory);
    if (known !== undefined) return known;
    const admitted = isInside(this.#root, directory) && this.#admitsDirectory(dirname(directory))
      && this.#admitsName(directory, basename(directory)) && entryKind(directory) === 'directory';
    this.#directories.set(directory, admitted);
    return admitted;
  }

  /**
   * 걷기와 같은 디렉터리 이름 규칙이다: 점 디렉터리·의존성·빌드 디렉터리와 호출자가 뺀 디렉터리는 열지 않는다.
   *
   * @param path 디렉터리 절대 경로
   * @param name 디렉터리 이름
   * @returns 열 수 있으면 true
   */
  #admitsName(path: string, name: string): boolean {
    return !isSkippedDirectory(name) && !this.#excluded.has(path) && this.#acceptsEntry?.(path) !== false;
  }

  /**
   * `files` 항목을 판정한다. 경계 밖이면 세고, 경계 안이면 부모 디렉터리가 정책을 통과한 일반 파일만 남긴다. 정책에
   * 막힌 일반 파일(제외 디렉터리·symlink 디렉터리 아래)과 symlink 항목도 센다. 없거나 디렉터리·특수 파일인 항목은
   * TypeScript도 소스로 읽지 못해 예전에도 루트가 되지 못했으므로 세지 않는다.
   *
   * @param fileName TypeScript가 절대 경로로 바꾼 항목
   * @returns 남기면 true
   */
  #admitsListedFile(fileName: string): boolean {
    const path = resolve(this.#root, fileName);
    if (!isInside(this.#root, path)) {
      this.#outside++;
      return false;
    }
    const kind = entryKind(path);
    if (kind === 'file' && !isPnpLoader(basename(path)) && this.#admitsDirectory(dirname(path))) return true;
    if (kind === 'file' || kind === 'link') this.#namedExcluded++;
    return false;
  }
}

/**
 * 경로가 디렉터리 자신이거나 그 아래인지 `path.relative`로 본다. 디렉터리가 `/`여도 맞게 판정한다.
 *
 * @param directory 디렉터리 절대 경로
 * @param path 경로
 * @returns 안이면 true
 */
function isInside(directory: string, path: string): boolean {
  const offset = relative(directory, path);
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`));
}

/**
 * 디렉터리 항목을 링크를 따라가지 않는 종류와 함께 읽는다.
 *
 * @param directory 디렉터리 절대 경로
 * @returns 항목(읽지 못하면 빈 목록)
 */
function listDirectory(directory: string): Dirent[] {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch {
    // 목록을 읽지 못한 디렉터리는 TypeScript 기본 열거처럼 비어 있는 것으로 본다. 같은 디렉터리는 걷기가 unreadable로 센다.
    return [];
  }
}

/**
 * 링크를 따라가지 않은 경로 종류다. 마지막 성분만 따라가지 않으므로 symlink 디렉터리 아래 항목은 대상의 종류다(그런
 * 조상은 {@link ConfigRootBoundary}의 디렉터리 판정이 거른다).
 *
 * @param path 경로
 * @returns 일반 파일·디렉터리·symlink·그 밖의 특수 파일, 없거나 확인할 수 없는 경로면 undefined
 */
function entryKind(path: string): 'file' | 'directory' | 'link' | 'other' | undefined {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    // 없거나 확인할 수 없는 경로는 루트로 쓰지도 열지도 않는다. TypeScript도 그런 경로에서 파일을 얻지 못한다.
    return undefined;
  }
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return stats.isSymbolicLink() ? 'link' : 'other';
}

/**
 * TypeScript 내부 `matchFiles`를 꺼낸다.
 *
 * 공개 `ts.sys.readDirectory`는 symlink를 따라가고 디렉터리 목록을 바꿀 수 없다. include·exclude 글롭 규칙(점 디렉터리와
 * `node_modules`의 암묵 제외, `.min.js` 처리, 확장자 우선순위 등)을 따로 구현하면 TypeScript와 어긋나 정상 설정의 루트가
 * 바뀔 수 있다. 그래서 의존성으로 고정한 TypeScript 5.9.3의 같은 함수에 목록 함수만 바꿔 넘긴다. 버전을 올려 함수가
 * 사라지면 조용히 기본 열거로 돌아가지 않고 멈춘다.
 *
 * @returns `matchFiles`
 */
function typeScriptMatchFiles(): MatchFiles {
  const candidate = (ts as unknown as { readonly matchFiles?: unknown }).matchFiles;
  // 고정한 5.9.3에는 늘 있다. 의존성 버전을 바꿨을 때만 닿는 방어다.
  /* node:coverage ignore next */
  if (typeof candidate !== 'function') throw new Error(MISSING_MATCH_FILES);
  return candidate as MatchFiles;
}
