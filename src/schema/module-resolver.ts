/**
 * import 지정자를 프로젝트 안 소스 파일로 해석한다.
 *
 * TypeScript 컴파일러의 모듈 해석(`ts.resolveModuleName`)에 가장 가까운 tsconfig(jsconfig)의
 * `paths`·`baseUrl`·`moduleResolution`을 넘긴다. 파일 시스템 접근은 프로젝트 루트 안으로
 * 제한하고, 결과가 스캔한 파일 집합 밖(의존성 패키지 등)이면 해석하지 않은 것으로 본다 —
 * 모르는 모듈을 추측해 클라이언트 출처로 잇지 않기 위해서다. 설정·package.json은 링크를 따라간
 * 실제 경로가 루트 안인 일반 파일만 1 MiB까지 읽는다. 실제 경로가 루트 밖인 파일은 어휘적으로 밖인
 * 경로와 같이 없는 파일로 본다.
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import { MAX_GRAPH_CONFIG_BYTES, readBoundedConfigText } from '../graph/bounded-config-reader.ts';

/** tsconfig 하나에서 읽은 해석 설정이다. */
interface ResolutionConfig {
  readonly options: ts.CompilerOptions;
  /** `paths`의 기준 디렉터리(baseUrl 또는 tsconfig 디렉터리)다. */
  readonly pathsBase: string;
}

/** tsconfig가 없을 때 쓰는 기본 설정이다. 번들러 해석은 확장자 생략과 `.js`→`.ts`를 모두 받는다. */
const defaultOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
};

/** 해석기가 읽는 설정 파일 이름이다(가까운 것 우선, 같은 디렉터리면 tsconfig 우선). */
const configNames = ['tsconfig.json', 'jsconfig.json'] as const;

/** 해석 호스트가 묻는 경로의 종류다. `none`은 없음·특수 파일·stat 실패, `outside`는 루트 밖(stat하지 않음)이다. */
type PathKind = 'file' | 'directory' | 'none' | 'outside';

/** 링크를 따라간 실제 경로가 루트 기준 어디인지다. `unknown`은 루트나 파일의 실제 경로를 구하지 못한 경우다. */
type RealLocation = 'inside' | 'outside' | 'unknown';

/**
 * TypeScript 캐시의 경로 정규화다. 대소문자를 바꾸지 않는다 — 해석 결과를 스캔한 경로와 그대로 비교하기 때문이다.
 *
 * @param fileName 경로
 * @returns 같은 경로
 */
const keepFileName = (fileName: string): string => fileName;

/** 프로젝트 안 모듈 해석기다. */
export class ModuleResolver {
  /** 프로젝트 realpath다. */
  private readonly root: string;
  /**
   * 루트의 OS realpath다. 읽을 파일의 실제 경로와 같은 함수로 구해 대소문자 무시 파일 시스템에서도 표기를 맞춘다.
   * 구하지 못하면 undefined이고, 그때는 어떤 파일도 루트 안이라고 확인할 수 없어 읽지 않는다.
   */
  private readonly realRoot: string | undefined;
  /** 스캔한 소스 파일 절대 경로 집합이다. */
  private readonly sourceFiles: ReadonlySet<string>;
  /** 디렉터리 → 해석 설정 캐시다. */
  private readonly configCache = new Map<string, ResolutionConfig>();
  /** (디렉터리, 지정자) → 해석 결과 캐시다. */
  private readonly resolutionCache = new Map<string, string | undefined>();
  /**
   * 해석마다 이어 쓰는 package.json 정보 캐시다. 같은 package.json을 디렉터리마다 다시 읽고 파싱하지 않게 한다.
   * package.json 내용은 tsconfig 옵션과 무관해 범위끼리 함께 써도 해석 결과가 섞이지 않는다.
   */
  private readonly packageJsonCache: ts.PackageJsonInfoCache;
  /** 경로 → 종류 캐시다. 한 실행 동안 파일 시스템이 바뀌지 않는다고 보고 같은 경로를 다시 stat하지 않는다. */
  private readonly pathKinds = new Map<string, PathKind>();
  /** 모듈 해석용 호스트다. 해석마다 새로 만들지 않는다. 프로젝트 루트 밖은 없는 것으로 본다. */
  private readonly moduleHost: ts.ModuleResolutionHost = {
    fileExists: (file) => this.fileExists(file),
    readFile: (file) => this.readFile(file),
    directoryExists: (directory) => this.kindOf(directory) === 'directory',
    realpath: (file) => file,
  };
  /**
   * 루트 안의 파일을 상한·권한·실제 경로 확인 실패 때문에 읽지 않은 누적 횟수다. 설정 하나를 파싱하는 동안 늘면
   * 그 설정을 센다. 실제 경로가 루트 밖인 파일은 없는 파일로 보므로 세지 않는다.
   */
  private refusedReads = 0;
  /** 읽지 못한 tsconfig 수다. */
  unreadableConfigs = 0;

  /**
   * @param root 프로젝트 realpath
   * @param sourceFiles 스캔한 소스 파일 절대 경로 집합
   */
  constructor(root: string, sourceFiles: ReadonlySet<string>) {
    this.root = root;
    this.realRoot = realPathOf(root);
    this.sourceFiles = sourceFiles;
    this.packageJsonCache = ts.createModuleResolutionCache(root, keepFileName).getPackageJsonInfoCache();
  }

  /**
   * 지정자를 스캔한 소스 파일로 해석한다.
   *
   * @param specifier import 지정자
   * @param importer 가져오는 파일 절대 경로
   * @returns 소스 파일 절대 경로. 프로젝트 소스가 아니면 undefined
   */
  resolve(specifier: string, importer: string): string | undefined {
    const directory = dirname(importer);
    const key = `${directory}\u0000${specifier}`;
    if (this.resolutionCache.has(key)) return this.resolutionCache.get(key);
    const resolved = this.resolveUncached(specifier, importer);
    this.resolutionCache.set(key, resolved);
    return resolved;
  }

  /**
   * 지정자가 가리킬 수 있는 절대 경로 후보를 파일 존재와 무관하게 만든다.
   *
   * 생성 클라이언트 출력 디렉터리처럼 저장소에 커밋되지 않았을 수 있는 대상을 판정할 때 쓴다.
   * 상대 지정자와 tsconfig `paths` 치환만 다룬다.
   *
   * @param specifier import 지정자
   * @param importer 가져오는 파일 절대 경로
   * @returns 후보 절대 경로 목록
   */
  lexicalCandidates(specifier: string, importer: string): string[] {
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      return [resolve(dirname(importer), specifier)];
    }
    const config = this.configFor(dirname(importer));
    return pathsCandidates(specifier, config);
  }

  /**
   * (디렉터리, 지정자) 캐시 없이 해석한다.
   *
   * TypeScript 해석 캐시는 호출마다 새로 만들고 package.json 정보 캐시만 이어 쓴다. 해석 결과를 실행 내내 TypeScript
   * 캐시에 두면 결과마다 실패한 탐색 경로 목록까지 남아(합성 1만 파일에서 약 200 MB) 작은 힙에서 OOM이 나고,
   * 디렉터리별 결과는 이미 (디렉터리, 지정자) 캐시가 맡는다. 호출마다 새 캐시라 tsconfig 범위끼리 결과가 섞이지도 않는다.
   *
   * @param specifier import 지정자
   * @param importer 가져오는 파일 절대 경로
   * @returns 소스 파일 절대 경로 또는 undefined
   */
  private resolveUncached(specifier: string, importer: string): string | undefined {
    const config = this.configFor(dirname(importer));
    const cache = ts.createModuleResolutionCache(this.root, keepFileName, config.options, this.packageJsonCache);
    const result = ts.resolveModuleName(specifier, importer, config.options, this.moduleHost, cache);
    const file = result.resolvedModule?.resolvedFileName;
    if (file === undefined) return undefined;
    const absolute = resolve(file);
    return this.sourceFiles.has(absolute) ? absolute : undefined;
  }

  /**
   * 디렉터리에 적용되는 해석 설정을 찾는다(가장 가까운 설정 파일, 루트까지).
   *
   * @param directory 절대 디렉터리
   * @returns 해석 설정
   */
  private configFor(directory: string): ResolutionConfig {
    const cached = this.configCache.get(directory);
    if (cached !== undefined) return cached;
    const config = this.readConfigAt(directory)
      ?? (directory === this.root || !this.isInside(dirname(directory))
        ? { options: defaultOptions, pathsBase: this.root }
        : this.configFor(dirname(directory)));
    this.configCache.set(directory, config);
    return config;
  }

  /**
   * 디렉터리에 설정 파일이 있으면 읽는다.
   *
   * @param directory 절대 디렉터리
   * @returns 해석 설정 또는 undefined
   */
  private readConfigAt(directory: string): ResolutionConfig | undefined {
    for (const name of configNames) {
      const path = join(directory, name);
      if (!existsSync(path)) continue;
      return this.parseConfig(path) ?? { options: defaultOptions, pathsBase: directory };
    }
    return undefined;
  }

  /**
   * 설정 파일을 컴파일러 규칙(주석·끝 쉼표·`extends`)대로 읽는다. 파일 목록은 만들지 않는다.
   *
   * 본 파일이나 `extends` 사슬의 파일이 루트 안에 있는데 읽지 않았으면(상한 초과·권한·실제 경로 확인 실패)
   * 일부만 읽은 옵션을 쓰지 않고 읽지 못한 설정으로 센다 — limitation 문구대로 그 아래 import는 기본 해석을 쓴다.
   * 없는 `extends` 대상은 TypeScript 규칙대로 건너뛰고 나머지 옵션을 쓴다. 실제 경로가 루트 밖인 대상(pnpm
   * 워크스페이스 하위 패키지의 저장소 링크 등)도 어휘적으로 루트 위인 `extends`처럼 없는 대상이라 그것만
   * 건너뛴다. 본 파일이 루트 밖이면 내용을 읽을 수 없어 읽지 못한 설정으로 센다.
   *
   * @param path 설정 파일 절대 경로
   * @returns 해석 설정. 읽지 못하면 undefined(계수에 남긴다)
   */
  private parseConfig(path: string): ResolutionConfig | undefined {
    const refusedBefore = this.refusedReads;
    // 구문 오류 diagnostic도 TypeScript 내부의 '/' 파일 이름과 일치해야 한다(Windows 포함).
    const read = ts.readConfigFile(path.split(sep).join('/'), (file) => this.readFile(resolve(file)));
    const parsed = read.error === undefined ? ts.parseJsonConfigFileContent(read.config, this.configHost(), dirname(path)) : undefined;
    if (parsed === undefined || this.refusedReads !== refusedBefore) {
      this.unreadableConfigs++;
      return undefined;
    }
    const options: ts.CompilerOptions = { ...parsed.options, allowJs: true };
    if (options.moduleResolution === undefined) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    const pathsBase = options.baseUrl ?? (options as { pathsBasePath?: string }).pathsBasePath ?? dirname(path);
    return { options, pathsBase };
  }

  /**
   * 설정 파싱용 호스트다. 디렉터리 열거를 하지 않아 include 글롭을 펼치지 않는다.
   *
   * @returns 파싱 호스트
   */
  private configHost(): ts.ParseConfigHost {
    return {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: () => [],
      fileExists: (file) => this.fileExists(file),
      readFile: (file) => this.readFile(file),
    };
  }

  /**
   * 루트 안의 파일이 있는지 본다.
   *
   * @param file 경로
   * @returns 있으면 true
   */
  private fileExists(file: string): boolean {
    return this.kindOf(file) === 'file';
  }

  /**
   * 경로 종류를 실행에 한 번만 구한다. 루트 밖은 stat하지 않는다.
   *
   * @param path 경로
   * @returns 경로 종류
   */
  private kindOf(path: string): PathKind {
    let kind = this.pathKinds.get(path);
    if (kind === undefined) {
      kind = this.isInside(path) ? statKind(path) : 'outside';
      this.pathKinds.set(path, kind);
    }
    return kind;
  }

  /**
   * 루트 안의 파일을 읽는다.
   *
   * 링크를 따라간 실제 경로가 루트 밖이면 읽지 않고 없는 파일로 본다(읽기 거부로 세지 않는다). 어휘적으로 루트
   * 밖인 경로를 없는 것으로 보는 규칙과 같게 해, pnpm 워크스페이스 하위 패키지의 저장소 링크처럼 밖으로 가는
   * `extends`도 npm·yarn 호이스팅 때와 같이 그것만 건너뛰고 설정 자체의 `paths`·`baseUrl`은 남긴다. 경로 요소마다
   * 링크를 거부하지 않는 것은 pnpm `node_modules/<pkg>`처럼 루트 안을 가리키는 디렉터리 링크를 거친 `extends`·
   * package.json 해석을 지키기 위해서다. 읽기는 일반 파일 핸들에서 1 MiB+1 byte까지만 한다(설정 하나로 메모리를
   * 다 쓰지 않게). 실제 경로 확인과 열기 사이에 링크가 바뀌는 경쟁은 막지 않는다.
   *
   * @param file 경로
   * @returns 내용. 없거나 읽지 않았으면 undefined(TypeScript는 없는 파일로 보고, 호출자가 미해석으로 센다)
   */
  private readFile(file: string): string | undefined {
    if (!this.fileExists(file)) return undefined;
    const location = this.realLocationOf(file);
    if (location === 'outside') return undefined;
    const read = location === 'inside' ? readBoundedConfigText(file, MAX_GRAPH_CONFIG_BYTES) : undefined;
    if (read?.ok === true) return read.text;
    this.refusedReads++;
    return undefined;
  }

  /**
   * 링크를 따라간 실제 경로가 루트 안인지 본다.
   *
   * @param file 경로
   * @returns 루트 안·밖, 또는 루트나 파일의 실제 경로를 구하지 못했으면 `unknown`
   */
  private realLocationOf(file: string): RealLocation {
    const real = realPathOf(file);
    if (real === undefined || this.realRoot === undefined) return 'unknown';
    return isInsideDirectory(this.realRoot, real) ? 'inside' : 'outside';
  }

  /**
   * 경로가 프로젝트 루트 안인지 어휘적으로 본다.
   *
   * @param path 경로
   * @returns 안이면 true
   */
  private isInside(path: string): boolean {
    return isInsideDirectory(this.root, path);
  }
}

/**
 * 경로가 디렉터리 자신이거나 그 아래인지 `path.relative`로 본다. 디렉터리가 `/`여도 맞게 판정한다.
 *
 * @param directory 디렉터리 절대 경로
 * @param path 경로
 * @returns 안이면 true
 */
function isInsideDirectory(directory: string, path: string): boolean {
  const offset = relative(directory, resolve(path));
  return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`));
}

/**
 * OS realpath를 구한다. CLI가 `--project`를 같은 native realpath로 정규화하므로 대소문자 표기가 맞는다.
 *
 * @param path 경로
 * @returns 실제 경로. 구하지 못하면(확인 뒤 사라진 경로 등) undefined
 */
function realPathOf(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    // 위치를 확인하지 못한 파일은 루트 안이라고 볼 수 없다. 호출자가 읽지 않은 것으로 다룬다.
    return undefined;
  }
}

/**
 * tsconfig `paths` 패턴을 치환한 후보 경로를 만든다.
 *
 * @param specifier import 지정자
 * @param config 해석 설정
 * @returns 후보 절대 경로 목록
 */
function pathsCandidates(specifier: string, config: ResolutionConfig): string[] {
  const candidates: string[] = [];
  for (const [pattern, targets] of Object.entries(config.options.paths ?? {})) {
    const captured = matchPathPattern(pattern, specifier);
    if (captured === undefined) continue;
    for (const target of targets) candidates.push(resolve(config.pathsBase, target.replace('*', captured)));
  }
  return candidates;
}

/**
 * `paths` 패턴(`*` 하나까지)과 지정자를 맞춘다.
 *
 * @param pattern 패턴
 * @param specifier 지정자
 * @returns `*`가 잡은 부분(없으면 빈 문자열). 맞지 않으면 undefined
 */
function matchPathPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return undefined;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/**
 * 경로 종류를 stat 한 번으로 구한다(링크는 따라간다).
 *
 * 없는 경로(ENOENT·ENOTDIR)는 예외 없이 판정한다. 해석 한 번이 존재를 수십 번 묻는데, 없는 경로마다 예외를
 * 만들고 잡는 비용이 해석 시간의 큰 몫이었기 때문이다.
 *
 * @param path 루트 안 경로
 * @returns 파일·디렉터리 또는 `none`
 */
function statKind(path: string): Exclude<PathKind, 'outside'> {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    if (stats?.isFile() === true) return 'file';
    return stats?.isDirectory() === true ? 'directory' : 'none';
  } catch {
    // 권한 없음·링크 순환처럼 stat하지 못한 경로는 파일도 디렉터리도 아니다.
    return 'none';
  }
}

/**
 * 경로가 디렉터리 자체이거나 그 아래인지 본다.
 *
 * @param path 대상 절대 경로
 * @param directory 디렉터리 절대 경로
 * @returns 안이면 true
 */
export function isWithinDirectory(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}
