/**
 * 호출 그래프용 TypeScript Program과 TypeChecker를 만든다.
 *
 * 프로젝트 루트의 `tsconfig.json`(없으면 `jsconfig.json`)을 컴파일러 API로 읽어 `paths`·`baseUrl`·
 * `moduleResolution`·`jsx`·`lib`를 그대로 쓴다. 설정이 없으면 번들러 해석 기본값을 쓴다. 분석 대상
 * 코드는 실행하지 않고(emit 없음), 진단도 계산하지 않는다 — 심볼 해석만 필요하기 때문이다.
 *
 * 명시 files/include/exclude가 있으면 그 설정의 진입 파일을 쓰고, 없으면 호출자가 준 프로젝트 소스를 보탠다.
 * import 의존성은 진입 파일과 별개다. tsconfig가 고르는 파일은 걷기 정책(경계 안, 제외 디렉터리·symlink 밖)을 통과한 것만 쓴다
 * (`config-roots.ts`). `allowJs`를 켜서 JS 파일도 같은 checker로 해석한다.
 *
 * compiler host의 현재 디렉터리는 실행 위치가 아니라 프로젝트 루트다. 설정이 없으면 TypeScript가 자동 타입 루트
 * (`node_modules/@types`)를 그 디렉터리와 조상에서 찾으므로, 실행 위치와 무관하게 tsconfig가 루트에 있을 때와 같다.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import ts from 'typescript';

import { readBoundedConfigText } from './bounded-config-reader.ts';
import { ConfigRootBoundary, type ConfigRootGaps, type ScanBoundary } from './config-roots.ts';
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

/**
 * Program을 만들면서 센 설정 공백이다. 설정 루트 경계의 공백({@link ConfigRootGaps}: 경계 밖이라 쓰지 않은 include·`files`
 * 항목 수, 걷기가 건너뛰는 디렉터리·symlink라 쓰지 않은 이름 항목 수, include 열거의 항목 상한 도달)도 싣는다.
 */
export interface ProgramConfigStatus extends ConfigRootGaps {
  /** 설정 진입 범위 밖 후보 수와 그중 import 의존성으로 읽은 수다. */
  readonly excludedSourceRoots?: number;
  readonly importedOutsideRoots?: number;
  /** 서로 다른 설정 소유권으로 해석을 보류한 소스 수다. 위치는 프로젝트 기준으로 제한해 남긴다. */
  readonly conflictingConfigSources?: readonly string[];
  readonly conflictingConfigSourceCount?: number;
  readonly configOwnershipIncomplete?: boolean;
  readonly skippedLoaderEntries?: number;
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
  /** 진입 범위에서 제외되어 의존성으로도 읽지 않은 소스다. 읽기 실패와 구분한다. */
  readonly excludedSources: ReadonlySet<string>;
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
 * @param explicitConfig root 기준 상대 경로나 절대 경로로 고른 compiler config. CLI는 realpath가 `--project` 안인 1 MiB 이하
 *   일반 파일인지 먼저 확인하고 받은 값을 그대로 넘긴다(`cli/project-paths.ts`). 상대 옵션의 기준은 이 경로의 디렉터리다
 *   (`tsc -p`처럼 링크를 풀지 않는다).
 * @param boundary 설정이 고르는 루트 파일이 머물 걷기 경계(기본은 root, 추가 제외 디렉터리 없음)
 * @returns Program·checker·설정 상태
 */
export function createGraphProgram(
  root: string,
  sourcePaths: readonly string[],
  createProgram: typeof ts.createProgram = ts.createProgram,
  explicitConfig?: string,
  boundary: ScanBoundary = { root, excludedDirectories: new Set() },
): GraphProgram {
  const { config, candidates, ownership, rootNames } = prepareProgramEntries(root, sourcePaths, explicitConfig, boundary);
  const options = analysisOptions(config.options);
  const candidateSet = new Set(candidates);
  const roots = new Set(rootNames);
  const nonRoots = candidates.filter((path) => !roots.has(path));
  const host = ts.createCompilerHost(options, true);
  // 설정이 없거나 읽지 못하면 TypeScript는 자동 타입 루트를 host의 현재 디렉터리와 그 조상의 `node_modules/@types`에서
  // 찾는다. 실행 위치 대신 프로젝트 루트를 주어 tsconfig가 루트에 있을 때와 같은 타입을 쓴다. 설정이 있으면 TypeScript가
  // 설정 디렉터리를 쓰고, 루트·import·옵션 경로는 모두 절대 경로라 다른 해석은 바뀌지 않는다.
  host.getCurrentDirectory = () => root;
  const oversized = new Set<string>();
  // tsconfig 루트·전이 import·선언·package.json 모두 같은 bounded reader를 거친다.
  // 수집 단계에서 제외한 파일이 compiler host를 통해 다시 무제한 읽히지 않게 한다.
  const requestedSources = new Set<string>();
  const readInput = boundedInputReader((fileName) => oversized.add(fileName));
  host.readFile = (fileName) => {
    const absolute = resolve(fileName);
    if (candidateSet.has(absolute)) requestedSources.add(absolute);
    return readInput(fileName);
  };
  // 다른 설정 소유 소스에 선택한 한 설정의 alias를 적용하면 잘못된 직접 간선이 생긴다. 지원하지 않는
  // 소유권은 import를 미해결로 남긴다. 로더나 설정의 코드를 실행하지 않는다.
  if (ownership.blocked.size > 0) {
    host.resolveModuleNames = (names, containingFile) => names.map((name) => ownership.blocked.has(resolve(containingFile))
      ? undefined : ts.resolveModuleName(name, containingFile, options, host).resolvedModule);
  }
  const deeplyNested = new Set<string>();
  // SDK 캐시보다 먼저 감싸 프로젝트·의존성 입력만 깊이를 잰다(번들 lib는 캐시가 따로 만든다).
  limitSyntaxDepth(host, (fileName) => deeplyNested.add(fileName));
  const cacheLease = sdkSourceFileCache.install(host, options);
  let primaryFailed = false;
  try {
    const program = createProgram({ rootNames, options, host });
    blockedConfigImports.set(program, ownership.blocked);
    const checker = program.getTypeChecker();
    const excludedSources = new Set(nonRoots.filter((path) => !requestedSources.has(path) && program.getSourceFile(path) === undefined));
    const importedOutsideRoots = nonRoots.filter((path) => program.getSourceFile(path) !== undefined).length;
    const sources = new Set(sourcePaths.map((path) => resolve(path)));
    const deeplyNestedSources = new Set([...deeplyNested].filter((path) => sources.has(path)));
    const otherDeeplyNested = deeplyNested.size - deeplyNestedSources.size;
    return {
      program, checker, deeplyNestedSources, excludedSources, status: {
        ...config.status, ...(oversized.size > 0 ? { oversizedCompilerInputs: oversized.size } : {}),
        ...(nonRoots.length > 0 ? { excludedSourceRoots: nonRoots.length, importedOutsideRoots } : {}),
        ...(ownership.blocked.size > 0 ? { conflictingConfigSourceCount: ownership.blocked.size,
          conflictingConfigSources: [...ownership.blocked].map((path) => relative(boundary.root, path).replaceAll('\\', '/')).sort().slice(0, 10) } : {}),
        ...(ownership.incomplete ? { configOwnershipIncomplete: true } : {}),
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

/** Program과 Next convention이 같은 설정 진입 목록을 쓴다. import 의존성 폐쇄는 이 목록과 별개다. */
function prepareProgramEntries(root: string, sourcePaths: readonly string[], explicitConfig: string | undefined, boundary: ScanBoundary) {
  const config = readProjectConfig(root, boundary, explicitConfig);
  const candidates = [...new Set(sourcePaths.map((path) => resolve(path)))];
  const ownership = configOwnership(root, config, candidates, boundary, explicitConfig !== undefined);
  const candidateSet = new Set(candidates);
  const rootNames = [...new Set([...config.fileNames, ...ownership.referenceRoots,
    ...(config.scoped ? [] : candidates.filter((path) => !hasTypeScriptSibling(path, candidateSet)))].map((path) => resolve(path)))].sort();
  return { config, candidates, ownership, rootNames };
}

/** compiler를 만들거나 소스를 실행하지 않고 Next convention에 허용할 진입 파일과 설정 공백을 돌려준다. */
export function selectSourceEntryFiles(root: string, candidates: readonly string[], explicitConfig?: string,
  boundary: ScanBoundary = { root, excludedDirectories: new Set() }): { files: ReadonlySet<string>; status: ProgramConfigStatus } {
  const { config, ownership, rootNames } = prepareProgramEntries(root, candidates, explicitConfig, boundary);
  return { files: new Set(rootNames), status: { ...config.status,
    ...(ownership.incomplete ? { configOwnershipIncomplete: true } : {}),
  } };
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
  readonly path?: string;
  readonly scoped?: boolean;
  readonly references?: readonly string[];
}

/**
 * 프로젝트 루트의 설정 파일을 읽는다. 없거나 읽지 못하면 기본 옵션이다. 설정이 고른 루트 파일은 걷기 경계로 거른다.
 *
 * @param root 프로젝트 realpath
 * @param boundary 설정 루트 파일이 머물 걷기 경계
 * @param explicitConfig 자동 탐색 대신 사용할 root 기준 상대 경로나 절대 경로
 * @returns 옵션·루트 파일·상태
 */
function readProjectConfig(root: string, boundary: ScanBoundary, explicitConfig?: string): ProjectConfig {
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
  const read = ts.readConfigFile(path.replaceAll('\\', '/'), readFile);
  if (read.error !== undefined) {
    if (explicitConfig !== undefined) {
      throw new GraphProjectInputError(boundedReadFailed ? 'config-file' : 'config-parse');
    }
    return { ...unreadableConfig(configName), path };
  }
  // include 글롭은 경계 필터가 걷기 정책 안에서만 펼친다(`ts.sys.readDirectory`는 상한 없이 링크·빌드 산출물까지 연다).
  const roots = new ConfigRootBoundary(boundary);
  const host: ts.ParseConfigHost = { ...ts.sys, readFile, readDirectory: roots.readDirectory };
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    host,
    dirname(path),
    configName === 'jsconfig.json' ? { allowJs: true } : undefined,
    path,
  );
  // "include 결과 없음"(18003)은 호출자가 소스를 따로 넣으므로 문제가 아니다. 그 밖의 오류는 기본값으로 떨어진다.
  if (parsed.errors.some((error) => error.code !== 18003 && error.code !== 18002 && error.category === ts.DiagnosticCategory.Error)) {
    if (explicitConfig !== undefined) {
      throw new GraphProjectInputError(boundedReadFailed ? 'config-file' : 'config-parse');
    }
    return { ...unreadableConfig(configName), path };
  }
  return { options: parsed.options, fileNames: roots.admit(parsed.fileNames).map((file) => resolve(file)), path,
    scoped: ['files', 'include', 'exclude'].some((key) => Object.hasOwn(parsed.raw as object, key)),
    references: parsed.projectReferences?.map((reference) => ts.resolveProjectReferencePath(reference)) ?? [],
    status: { configName, configUnreadable: false, ...roots.gaps() } };
}

/**
 * 설정 루트 경계가 남긴 공백을 원인 문장으로 만든다. 접두사는 문서마다 다르므로 호출자가 붙인다(graph `graph-config:`,
 * routes·navigation은 각 coverage 접두사). 같은 Program 공백을 본 문서들이 같은 말로 알리게 하려고 한곳에 둔다.
 *
 * @param status Program 설정 상태
 * @param affected 불완전할 수 있는 결과(예: `calls`, `route registrations`)
 * @returns 원인 문장(공백이 없으면 빈 목록)
 */
export function configRootGaps(status: ProgramConfigStatus, affected: string): string[] {
  const gaps: string[] = [];
  if ((status.skippedLoaderEntries ?? 0) > 0) gaps.push(`source-scope: ${status.skippedLoaderEntries} PnP loader file(s) were excluded from source entries; loader execution and PnP zip dependency resolution are not performed`);
  if ((status.excludedSourceRoots ?? 0) > 0) {
    gaps.push(`source-scope: ${status.excludedSourceRoots} scanned candidate(s) were not entry files selected by files/include/exclude or TypeScript sibling precedence; `
      + `${status.importedOutsideRoots ?? 0} were retained as imported dependencies; excluded entry files may contain additional ${affected}`);
  }
  if ((status.conflictingConfigSourceCount ?? 0) > 0) {
    gaps.push(`config-conflict: ${status.conflictingConfigSourceCount} source(s) have different or ambiguous compiler-config ownership; `
      + `their imports were left unresolved instead of applying another project's aliases; ${affected} may be incomplete; `
      + `files: ${JSON.stringify(status.conflictingConfigSources ?? [])}; omitted: ${status.conflictingConfigSourceCount! - (status.conflictingConfigSources?.length ?? 0)}`);
  }
  if (status.configOwnershipIncomplete === true) gaps.push(`config-ownership: referenced or nearest configs could not all be read within the scan boundary and 128-config budget; ${affected} may be incomplete`);
  const outside = status.outsideConfigRoots ?? 0;
  if (outside > 0) {
    gaps.push(`${outside} include pattern(s) or files entr(ies) of ${status.configName} point outside the scanned root and were not used as root files; `
      + `type resolution and ${affected} may be incomplete (analyze a root that contains them)`);
  }
  const excluded = status.excludedConfigRoots ?? 0;
  if (excluded > 0) {
    gaps.push(`${excluded} files entr(ies) or wildcard-free include path(s) of ${status.configName} name paths in directories the scan skips `
      + `or through symbolic links and were not used as root files; type resolution and ${affected} may be incomplete `
      + '(import or reference them from a project source instead)');
  }
  if (status.configRootsTruncated === true) {
    gaps.push(`include patterns of ${status.configName} reached the directory entry limit; later matches were not used as root files; `
      + `type resolution and ${affected} may be incomplete`);
  }
  return gaps;
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

/** 같은 stem의 TypeScript 소스가 있으면 남아 있는 JavaScript 산출물을 진입 파일로 중복 등록하지 않는다. */
function hasTypeScriptSibling(path: string, sources: ReadonlySet<string>): boolean {
  if (!/\.[cm]?jsx?$/u.test(path)) return false;
  const stem = path.replace(/\.[cm]?jsx?$/u, '');
  const extensions = path.endsWith('.mjs') ? ['.mts'] : path.endsWith('.cjs') ? ['.cts'] : ['.ts', '.tsx'];
  return extensions.some((extension) => sources.has(stem + extension));
}

/** Program 밖의 보조 module resolver도 동일한 소유권 보류를 지킨다. */
const blockedConfigImports = new WeakMap<ts.Program, ReadonlySet<string>>();
export function configImportIsBlocked(program: ts.Program, fileName: string): boolean {
  return blockedConfigImports.get(program)?.has(resolve(fileName)) === true;
}

interface ConfigOwnership {
  readonly blocked: ReadonlySet<string>;
  readonly referenceRoots: readonly string[];
  readonly incomplete: boolean;
}

/**
 * 한 Program이 서로 다른 앱 설정을 섞지 않도록 nearest config와 명시 project reference 소유권을 비교한다.
 * 전체 다중 Program 컴파일을 흉내 내지 않는다. 해석 옵션이 다르거나 읽지 못한 소유권은 import를 보류한다.
 */
function configOwnership(
  root: string, selected: ProjectConfig, sources: readonly string[], boundary: ScanBoundary, explicit: boolean,
): ConfigOwnership {
  const cache = new Map<string, ProjectConfig>();
  if (selected.path !== undefined) cache.set(resolve(selected.path), selected);
  const blocked = new Set<string>();
  let incomplete = false;
  const inside = (path: string) => {
    const offset = relative(boundary.root, path);
    return !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..\\') && !offset.startsWith('../');
  };
  const read = (path: string): ProjectConfig | undefined => {
    const absolute = resolve(path);
    if (cache.has(absolute)) return cache.get(absolute);
    if (!inside(absolute) || cache.size >= 128) { incomplete = true; return undefined; }
    let config: ProjectConfig;
    try { config = readProjectConfig(dirname(absolute), boundary, absolute); }
    catch { config = unreadableConfig(basename(absolute)); incomplete = true; }
    cache.set(absolute, config);
    return config;
  };
  const referenced = new Map<string, ProjectConfig[]>();
  const referenceRoots = new Set<string>();
  const pending = [...(selected.references ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = resolve(pending.pop()!);
    if (visited.has(path)) continue;
    visited.add(path);
    if (visited.size > 128) { incomplete = true; break; }
    const config = read(path);
    if (config === undefined || config.status.configUnreadable) { sources.forEach((source) => blocked.add(source)); continue; }
    for (const source of config.fileNames) {
      referenceRoots.add(source);
      const owners = referenced.get(source) ?? [];
      owners.push(config);
      referenced.set(source, owners);
    }
    pending.push(...(config.references ?? []));
  }
  const byDirectory = new Map<string, ProjectConfig | undefined>();
  const nearest = (directory: string): ProjectConfig | undefined => {
    if (byDirectory.has(directory)) return byDirectory.get(directory);
    if (!inside(directory)) return undefined;
    if (explicit && resolve(directory) === resolve(root)) { byDirectory.set(directory, selected); return selected; }
    const name = configNames.find((candidate) => existsSync(join(directory, candidate)));
    const owner = name === undefined ? nearest(dirname(directory)) : read(join(directory, name));
    byDirectory.set(directory, owner);
    return owner;
  };
  const selectedKey = resolutionOptionsKey(selected.options);
  for (const source of sources) {
    const owners = [...(referenced.get(source) ?? [])];
    const owner = nearest(dirname(source));
    if (owner !== undefined) owners.push(owner);
    if (owners.some((config) => config !== selected && (config.status.configUnreadable || resolutionOptionsKey(config.options) !== selectedKey))) blocked.add(source);
  }
  if (incomplete) sources.forEach((source) => blocked.add(source));
  return { blocked, referenceRoots: [...referenceRoots], incomplete };
}

/** 설정 위치만 달라도 같은 유효 해석 옵션이면 충돌로 만들지 않는다. 설정 AST는 비교에 포함하지 않는다. */
function resolutionOptionsKey(options: ts.CompilerOptions): string {
  const normalized = analysisOptions(options);
  delete normalized.configFile;
  delete normalized.configFilePath;
  return JSON.stringify(Object.fromEntries(Object.entries(normalized).sort(([a], [b]) => a.localeCompare(b))));
}
