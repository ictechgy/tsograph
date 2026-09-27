/**
 * import 지정자를 프로젝트 안 소스 파일로 해석한다.
 *
 * TypeScript 컴파일러의 모듈 해석(`ts.resolveModuleName`)에 가장 가까운 tsconfig(jsconfig)의
 * `paths`·`baseUrl`·`moduleResolution`을 넘긴다. 파일 시스템 접근은 프로젝트 루트 안으로
 * 제한하고, 결과가 스캔한 파일 집합 밖(의존성 패키지 등)이면 해석하지 않은 것으로 본다 —
 * 모르는 모듈을 추측해 클라이언트 출처로 잇지 않기 위해서다.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

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

/** 프로젝트 안 모듈 해석기다. */
export class ModuleResolver {
  /** 프로젝트 realpath다. */
  private readonly root: string;
  /** 스캔한 소스 파일 절대 경로 집합이다. */
  private readonly sourceFiles: ReadonlySet<string>;
  /** 디렉터리 → 해석 설정 캐시다. */
  private readonly configCache = new Map<string, ResolutionConfig>();
  /** (디렉터리, 지정자) → 해석 결과 캐시다. */
  private readonly resolutionCache = new Map<string, string | undefined>();
  /** 읽지 못한 tsconfig 수다. */
  unreadableConfigs = 0;

  /**
   * @param root 프로젝트 realpath
   * @param sourceFiles 스캔한 소스 파일 절대 경로 집합
   */
  constructor(root: string, sourceFiles: ReadonlySet<string>) {
    this.root = root;
    this.sourceFiles = sourceFiles;
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
   * 캐시 없이 해석한다.
   *
   * @param specifier import 지정자
   * @param importer 가져오는 파일 절대 경로
   * @returns 소스 파일 절대 경로 또는 undefined
   */
  private resolveUncached(specifier: string, importer: string): string | undefined {
    const config = this.configFor(dirname(importer));
    const result = ts.resolveModuleName(specifier, importer, config.options, this.moduleHost());
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
   * @param path 설정 파일 절대 경로
   * @returns 해석 설정. 읽지 못하면 undefined(계수에 남긴다)
   */
  private parseConfig(path: string): ResolutionConfig | undefined {
    const read = ts.readConfigFile(path, (file) => this.readFile(file));
    if (read.error !== undefined) {
      this.unreadableConfigs++;
      return undefined;
    }
    const parsed = ts.parseJsonConfigFileContent(read.config, this.configHost(), dirname(path));
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
   * 모듈 해석용 호스트다. 프로젝트 루트 밖은 없는 것으로 본다.
   *
   * @returns 해석 호스트
   */
  private moduleHost(): ts.ModuleResolutionHost {
    return {
      fileExists: (file) => this.fileExists(file),
      readFile: (file) => this.readFile(file),
      directoryExists: (directory) => this.isInside(directory) && isDirectory(directory),
      realpath: (file) => file,
    };
  }

  /**
   * 루트 안의 파일이 있는지 본다.
   *
   * @param file 경로
   * @returns 있으면 true
   */
  private fileExists(file: string): boolean {
    return this.isInside(file) && isFile(file);
  }

  /**
   * 루트 안의 파일을 읽는다.
   *
   * @param file 경로
   * @returns 내용 또는 undefined
   */
  private readFile(file: string): string | undefined {
    if (!this.fileExists(file)) return undefined;
    try {
      return readFileSync(file, 'utf8');
    } catch {
      // 해석 중 읽기 실패는 "해석 못 함"으로 이어지고 호출자가 미해석으로 센다.
      return undefined;
    }
  }

  /**
   * 경로가 프로젝트 루트 안인지 본다.
   *
   * @param path 경로
   * @returns 안이면 true
   */
  private isInside(path: string): boolean {
    const offset = relative(this.root, resolve(path));
    return offset === '' || (!isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`));
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
 * 일반 파일인지 본다.
 *
 * @param path 경로
 * @returns 파일이면 true
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    // 없는 경로는 파일이 아니다.
    return false;
  }
}

/**
 * 디렉터리인지 본다.
 *
 * @param path 경로
 * @returns 디렉터리면 true
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // 없는 경로는 디렉터리가 아니다.
    return false;
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
