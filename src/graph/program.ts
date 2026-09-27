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
import { join, resolve } from 'node:path';

import ts from 'typescript';

/** 설정 파일 이름이다(tsconfig 우선). */
const configNames = ['tsconfig.json', 'jsconfig.json'] as const;

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
}

/** 만든 Program과 checker, 설정 상태다. */
export interface GraphProgram {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly status: ProgramConfigStatus;
}

/**
 * Program을 만든다.
 *
 * @param root 프로젝트 realpath
 * @param sourcePaths 루트로 넣을 프로젝트 소스 절대 경로(선언 파일 포함 가능)
 * @returns Program·checker·설정 상태
 */
export function createGraphProgram(root: string, sourcePaths: readonly string[]): GraphProgram {
  const config = readProjectConfig(root);
  const options = analysisOptions(config.options);
  const rootNames = [...new Set([...config.fileNames, ...sourcePaths].map((path) => resolve(path)))].sort();
  const host = ts.createCompilerHost(options, true);
  const program = ts.createProgram({ rootNames, options, host });
  return { program, checker: program.getTypeChecker(), status: config.status };
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
 * @returns 옵션·루트 파일·상태
 */
function readProjectConfig(root: string): ProjectConfig {
  const configName = configNames.find((name) => existsSync(join(root, name)));
  if (configName === undefined) return { options: defaultOptions, fileNames: [], status: { configName, configUnreadable: false } };
  const path = join(root, configName);
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error !== undefined) return unreadableConfig(configName);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, configName === 'jsconfig.json' ? { allowJs: true } : undefined, path);
  // "include 결과 없음"(18003)은 호출자가 소스를 따로 넣으므로 문제가 아니다. 그 밖의 오류는 기본값으로 떨어진다.
  if (parsed.errors.some((error) => error.code !== 18003 && error.category === ts.DiagnosticCategory.Error)) {
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
