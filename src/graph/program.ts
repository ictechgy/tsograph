/**
 * 호출 그래프용 TypeScript Program과 TypeChecker를 만든다.
 *
 * 프로젝트 루트의 `tsconfig.json`(없으면 `jsconfig.json`)을 컴파일러 API로 읽어 `paths`·`baseUrl`·
 * `moduleResolution`·`jsx`·`lib`를 그대로 쓴다. 설정이 없으면 번들러 해석 기본값을 쓴다. 분석 대상
 * 코드는 실행하지 않고(emit 없음), 진단도 계산하지 않는다 — 심볼 해석만 필요하기 때문이다.
 *
 * 루트 파일은 tsconfig가 고른 파일과 호출자가 준 프로젝트 소스(설정이 빠뜨린 스크립트·라우트 포함)의
 * 합집합이다. `allowJs`를 켜서 JS 파일도 같은 checker로 해석한다.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import ts from 'typescript';

import { readBoundedConfigText } from './bounded-config-reader.ts';
import { MAX_SOURCE_BYTES } from '../schema/project-reader.ts';
import { parseWithinSyntaxDepth, TOO_DEEP } from '../schema/syntax-depth.ts';
import { sdkSourceFileCache } from './sdk-source-file-cache.ts';

/** 설정 파일 이름이다(tsconfig 우선). */
const configNames = ['tsconfig.json', 'jsconfig.json'] as const;

/** 명시 입력의 알려진 실패만 CLI가 안전한 원인별 메시지로 변환한다. */
export class GraphProjectInputError extends Error {
  readonly code: 'config-file' | 'config-parse' | 'workspace';
  constructor(code: 'config-file' | 'config-parse' | 'workspace') {
    super(code === 'config-file' ? 'explicit compiler config and its extends must be readable JSON files within 1 MiB'
      : code === 'config-parse' ? 'explicit compiler config could not be parsed'
        : 'workspace must be a readable directory containing the selected project');
    this.name = 'GraphProjectInputError';
    this.code = code;
  }
}

/** 설정이 없을 때 쓰는 기본 컴파일러 옵션이다. 번들러 해석은 확장자 생략과 `.js`→`.ts`를 모두 받는다. */
const defaultOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  esModuleInterop: true,
  resolveJsonModule: true,
};

/** Program을 만들면서 센 설정 공백이다. */
export interface ProgramConfigStatus {
  /** 읽은 설정 파일 이름(`tsconfig.json`·`jsconfig.json`) 또는 undefined(기본값 사용) */
  readonly configName: string | undefined;
  /** 설정 파일을 읽거나 해석하지 못했는지 여부다(이때 기본 옵션을 쓴다). */
  readonly configUnreadable: boolean;
  /** compiler host가 크기 상한 때문에 읽지 못한 고유 입력 수다. */
  readonly oversizedCompilerInputs?: number;
  /**
   * 구문 중첩이 상한을 넘거나 파싱이 호출 스택을 넘겨 compiler host가 뺀 입력 중 호출자가 준 소스가 아닌 것(설정이 고른
   * 파일·전이 import·선언·패키지)의 고유 수다. 호출자가 준 소스는 {@link GraphProgram.deeplyNestedSources}에 있다.
   */
  readonly deeplyNestedCompilerInputs?: number;
}

/** 만든 Program과 checker, 설정 상태다. */
export interface GraphProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly status: ProgramConfigStatus;
  /**
   * 호출자가 준 소스 중 구문 중첩이 상한을 넘거나 파싱이 호출 스택을 넘겨 Program에서 뺀 것의 절대 경로다. 읽지 못한
   * 소스와 원인이 달라 호출자가 따로 센다.
   */
  readonly deeplyNestedSources: ReadonlySet<string>;
}

/**
 * Program을 만든다.
 *
 * @param root 프로젝트 realpath
 * @param sourcePaths 루트로 넣을 프로젝트 소스 절대 경로(선언 파일 포함 가능)
 * @param createProgram TypeScript Program factory (기본값은 `ts.createProgram`)
 * @param explicitConfig root 기준 상대 경로나 절대 경로로 고른 compiler config
 * @returns Program·checker·설정 상태
 */
export function createGraphProgram(
  root: string,
  sourcePaths: readonly string[],
  createProgram: typeof ts.createProgram = ts.createProgram,
  explicitConfig?: string,
): GraphProgram {
  const config = readProjectConfig(root, explicitConfig);
  const options = analysisOptions(config.options);
  const rootNames = [...new Set([...config.fileNames, ...sourcePaths].map((path) => resolve(path)))].sort();
  const host = ts.createCompilerHost(options, true);
  const oversized = new Set<string>();
  // tsconfig 루트·전이 import·선언·package.json 모두 같은 bounded reader를 거친다.
  // 수집 단계에서 제외한 파일이 compiler host를 통해 다시 무제한 읽히지 않게 한다.
  host.readFile = boundedInputReader((fileName) => oversized.add(fileName));
  const deeplyNested = new Set<string>();
  // SDK 캐시보다 먼저 감싸 프로젝트·의존성 입력만 깊이를 잰다(번들 lib는 캐시가 따로 만든다).
  limitSyntaxDepth(host, (fileName) => deeplyNested.add(fileName));
  const cacheLease = sdkSourceFileCache.install(host, options);
  let primaryFailed = false;
  try {
    const program = createProgram({ rootNames, options, host });
    const checker = program.getTypeChecker();
    const sources = new Set(sourcePaths.map((path) => resolve(path)));
    const deeplyNestedSources = new Set([...deeplyNested].filter((path) => sources.has(path)));
    const otherDeeplyNested = deeplyNested.size - deeplyNestedSources.size;
    return {
      program, checker, deeplyNestedSources, status: {
        ...config.status, ...(oversized.size > 0 ? { oversizedCompilerInputs: oversized.size } : {}),
        ...(otherDeeplyNested > 0 ? { deeplyNestedCompilerInputs: otherDeeplyNested } : {}),
      },
    };
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (primaryFailed) {
      try {
        cacheLease.release();
      } catch {
        // 원래 Program/checker 오류를 cleanup 오류로 가리지 않는다.
      }
    } else {
      cacheLease.release();
    }
  }
}

/**
 * `ts.resolveModuleName`에 넘길 모듈 해석 host를 만든다. `ts.sys`와 같되 `readFile`은 compiler host와 같은
 * 4 MiB bounded reader다.
 *
 * `ts.sys.readFile`은 크기 상한 없이 파일 전체를 읽는다. 그대로 넘기면 Program이 상한 때문에 읽지 않은
 * package.json을 별도 해석이 통째로 읽고, 그 `main`·`exports`로 Program과 다른 파일을 고를 수 있다.
 *
 * @param onOversized 상한을 넘어 읽지 않은 파일의 절대 경로를 받는다
 * @returns 모듈 해석 host
 */
export function createBoundedResolutionHost(onOversized: (fileName: string) => void): ts.ModuleResolutionHost {
  return { ...ts.sys, readFile: boundedInputReader(onOversized) };
}

/**
 * compiler host와 모듈 해석 host가 함께 쓰는 bounded 입력 reader를 만든다.
 *
 * 상한을 넘은 파일은 읽지 않은 것(undefined)으로 두고 `onOversized`에 알린다. TypeScript는 읽지 못한 파일을
 * 없는 것으로 보고 계속하므로, 공백을 알리는 일은 호출자가 맡는다.
 *
 * @param onOversized 상한을 넘어 읽지 않은 파일의 절대 경로를 받는다
 * @returns `readFile` 구현
 */
function boundedInputReader(onOversized: (fileName: string) => void): (fileName: string) => string | undefined {
  return (fileName) => {
    const result = readBoundedConfigText(fileName, MAX_SOURCE_BYTES);
    if (result.ok) return result.text;
    if (result.reason === 'too-large') onOversized(resolve(fileName));
    return undefined;
  };
}

/**
 * compiler host가 만드는 SourceFile에 구문 깊이 상한을 건다.
 *
 * 상한을 넘거나 파싱이 호출 스택을 넘긴 파일은 없는 파일(undefined)로 돌려준다. 그래서 TypeScript 바인더·검사기와
 * tsograph 방문기가 그 파일을 걷지 않고, 그 파일을 가리키는 import는 풀리지 않은 모듈이 된다. 깊은 파일 하나 때문에
 * Program을 쓰는 명령 전체가 스택 초과로 끝나지 않게 하기 위해서다.
 *
 * @param host compiler host(`getSourceFile`을 바꾼다)
 * @param onTooDeep 뺀 입력의 절대 경로를 받는다
 */
function limitSyntaxDepth(host: ts.CompilerHost, onTooDeep: (fileName: string) => void): void {
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const sourceFile = parseWithinSyntaxDepth(() => original(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile));
    if (sourceFile !== TOO_DEEP) return sourceFile;
    onTooDeep(resolve(fileName));
    return undefined;
  };
}

/** 설정 파일에서 읽은 옵션·루트 파일·상태다. */
interface ProjectConfig {
  readonly options: ts.CompilerOptions;
  readonly fileNames: readonly string[];
  readonly status: ProgramConfigStatus;
}

/**
 * 프로젝트 루트의 설정 파일을 읽는다. 없거나 읽지 못하면 기본 옵션이다.
 *
 * @param root 프로젝트 realpath
 * @param explicitConfig 자동 탐색 대신 사용할 root 기준 상대 경로나 절대 경로
 * @returns 옵션·루트 파일·상태
 */
function readProjectConfig(root: string, explicitConfig?: string): ProjectConfig {
  const configName = explicitConfig === undefined ? configNames.find((name) => existsSync(join(root, name))) : basename(explicitConfig);
  if (configName === undefined) return { options: defaultOptions, fileNames: [], status: { configName, configUnreadable: false } };
  const path = explicitConfig === undefined ? join(root, configName) : resolve(root, explicitConfig);
  let boundedReadFailed = false;
  const readFile = (fileName: string): string | undefined => {
    const result = readBoundedConfigText(fileName);
    if (result.ok) return result.text;
    boundedReadFailed = true;
    return undefined;
  };
  const read = ts.readConfigFile(path, readFile);
  if (read.error !== undefined) {
    if (explicitConfig !== undefined) {
      throw new GraphProjectInputError(boundedReadFailed ? 'config-file' : 'config-parse');
    }
    return unreadableConfig(configName);
  }
  const host: ts.ParseConfigHost = { ...ts.sys, readFile };
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    host,
    dirname(path),
    configName === 'jsconfig.json' ? { allowJs: true } : undefined,
    path,
  );
  // "include 결과 없음"(18003)은 호출자가 소스를 따로 넣으므로 문제가 아니다. 그 밖의 오류는 기본값으로 떨어진다.
  if (parsed.errors.some((error) => error.code !== 18003 && error.category === ts.DiagnosticCategory.Error)) {
    if (explicitConfig !== undefined) {
      throw new GraphProjectInputError(boundedReadFailed ? 'config-file' : 'config-parse');
    }
    return unreadableConfig(configName);
  }
  return { options: parsed.options, fileNames: parsed.fileNames, status: { configName, configUnreadable: false } };
}

/**
 * 읽지 못한 설정의 결과를 만든다.
 *
 * @param configName 설정 파일 이름
 * @returns 기본 옵션과 unreadable 상태
 */
function unreadableConfig(configName: string): ProjectConfig {
  return { options: defaultOptions, fileNames: [], status: { configName, configUnreadable: true } };
}

/**
 * 분석용으로 옵션을 조정한다: emit·증분 빌드·플러그인을 끄고 JS를 허용한다.
 *
 * @param options 설정의 옵션
 * @returns 분석용 옵션
 */
function analysisOptions(options: ts.CompilerOptions): ts.CompilerOptions {
  const adjusted: ts.CompilerOptions = { ...options, noEmit: true, allowJs: true, checkJs: false, skipLibCheck: true };
  for (const key of ['incremental', 'composite', 'tsBuildInfoFile', 'declaration', 'declarationMap', 'emitDeclarationOnly', 'plugins', 'outDir', 'outFile'] as const) {
    delete adjusted[key];
  }
  return adjusted;
}
