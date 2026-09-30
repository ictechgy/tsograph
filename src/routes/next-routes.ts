/**
 * Next.js 프로젝트에서 라우트 선언 후보를 모은다(App Router route handler, Pages Router API route).
 *
 * 확인한 Next.js 16.2.7 동작:
 * - route handler 파일은 `app` 아래 `route.<pageExtension>`이다(`server/lib/find-page-file.js`의
 *   `createValidFileMatcher`). 핸들러 method는 `GET`·`HEAD`·`OPTIONS`·`POST`·`PUT`·`DELETE`·`PATCH`
 *   (`server/web/http.js`의 `HTTP_METHODS`)이고, 내보낸 이름으로 고른다. `HEAD`(GET이 있을 때)와
 *   `OPTIONS`는 내보내지 않아도 Next가 자동으로 구현한다 — 계약대로 decl로 내지 않고 소비자의
 *   `head-as-get`·`options-any` 규칙에 맡긴다.
 * - Pages Router는 `pages/api` 아래의 `pageExtensions` 파일 전부(와 `pages/api.<ext>`)가 API route다
 *   (`lib/is-api-route.js`, API Routes 문서). 핸들러가 모든 method를 받으므로 method는 `ANY`다.
 *   `.d.ts`는 라우트가 아니다(`build/route-discovery.js`).
 */

import type ts from 'typescript';

import type { CommandFileSystem } from '../cli/file-system.ts';
import type { RouteDeclMethod } from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import { collectModuleExports, type ModuleExports } from './module-exports.ts';
import { DEFAULT_PAGE_EXTENSIONS, type NextRouteConfig } from './next-config.ts';
import { type NextRouter, type RoutePath, toRoutePath } from './next-path.ts';
import {
  createScanGaps,
  listEntries,
  locateRouterDirectories,
  lookupEntry,
  type RouterDirectories,
  type ScanGaps,
  walkFiles,
} from './project-scan.ts';
import { parseSource, scriptKindOf, type SourcePosition } from './source-file.ts';
import { readTextFile } from './text-file.ts';
import { exportBindingId } from '../graph/symbol-ids.ts';

/** App Router route handler가 받을 수 있는 method다(`next/dist/server/web/http.js`). */
export const APP_ROUTE_METHODS: readonly RouteDeclMethod[] = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE', 'PATCH'];

/** route 파일 하나의 최대 크기(바이트)다. 넘으면 읽지 않고 센다. */
export const MAX_ROUTE_FILE_BYTES = 8 * 1024 * 1024;

/** 정적으로 찾은 라우트 선언 하나(경로 규칙 적용 전)다. */
export interface DeclaredRoute {
  readonly path: Extract<RoutePath, { kind: 'template' } | { kind: 'dynamic' }>;
  readonly method: RouteDeclMethod;
  /** 프로젝트 기준 POSIX 파일 경로 */
  readonly file: string;
  /** Next가 호출하는 내보낸 이름(`GET`, Pages Router는 `default`) */
  readonly exportName: string;
  /**
   * 핸들러의 tsograph 그래프 id(`symbol.usr`, `src/graph/symbol-ids.ts`). CommonJS 내보내기는 그래프가
   * 이름 있는 노드를 만들지 않아 undefined다.
   */
  readonly usr: string | undefined;
  readonly position: SourcePosition;
  readonly testSource: boolean;
}

/** 추출 중 센 공백이다. */
export interface RouteGaps extends ScanGaps {
  unmodeledFiles: number;
  invalidSegmentFiles: number;
  dynamicPathFiles: number;
  unreadableFiles: number;
  unparsedFiles: number;
  syntaxErrorFiles: number;
  unresolvedExportFiles: number;
  pagesWithoutDefaultExport: number;
}

/** 추출 결과다. */
export interface NextRoutesResult {
  readonly routes: readonly DeclaredRoute[];
  readonly gaps: RouteGaps;
  readonly routerDirectories: RouterDirectories;
  /** framework가 만드는 경로의 근거(메타데이터 파일 수, proxy/middleware 파일, public·static 존재) */
  readonly frameworkSources: FrameworkSources;
}

/** 파일 라우트 밖에서 framework가 응답하는 경로의 근거다. */
export interface FrameworkSources {
  readonly metadataFiles: number;
  /** 프로젝트 기준 proxy·middleware 파일 경로(정렬) */
  readonly proxyFiles: readonly string[];
  readonly hasPublicFiles: boolean;
  /** 루트 `static/`(구 규칙, `/static` 아래로 제공)이 파일을 내놓을 수 있으면 true */
  readonly hasLegacyStaticFiles: boolean;
}

/** 추출 입력이다. */
export interface NextRoutesInput {
  readonly fileSystem: CommandFileSystem;
  readonly project: string;
  readonly config: NextRouteConfig;
  readonly includeTests: boolean;
}

/** 라우트 파일 하나의 처리 문맥이다. */
interface RouteFileContext {
  readonly input: NextRoutesInput;
  readonly gaps: RouteGaps;
  readonly pageExtensions: readonly string[];
}

/**
 * 프로젝트의 라우트 선언 후보를 모은다.
 *
 * @param input 파일 시스템·프로젝트·설정·테스트 포함 여부
 * @returns 선언 후보와 공백
 */
export async function extractNextRoutes(input: NextRoutesInput): Promise<NextRoutesResult> {
  const gaps = createRouteGaps();
  const pageExtensions = input.config.pageExtensions.kind === 'known' ? input.config.pageExtensions.value : DEFAULT_PAGE_EXTENSIONS;
  const context: RouteFileContext = { input, gaps, pageExtensions };
  const routerDirectories = await locateRouterDirectories(input.fileSystem, input.project);
  const appFiles = routerDirectories.appDirectory === undefined
    ? []
    : await walkFiles(input.fileSystem, input.project, routerDirectories.appDirectory, gaps, { skipName: (name) => name.startsWith('_') });
  const routes: DeclaredRoute[] = [];
  for (const file of appFiles.filter((path) => isAppRouteFile(path, pageExtensions))) {
    routes.push(...await appRouteDeclarations(context, routerDirectories.appDirectory!, file));
  }
  for (const file of await pagesApiFiles(context, routerDirectories.pagesDirectory)) {
    routes.push(...await pagesApiDeclarations(context, routerDirectories.pagesDirectory!, file));
  }
  const frameworkSources = await collectFrameworkSources(context, routerDirectories, appFiles);
  return { routes, gaps, routerDirectories, frameworkSources };
}

/**
 * Next.js를 스캔하지 않은 프로젝트(Node 백엔드만 감지)의 빈 추출 결과다. `graph`가 진입점·라우트 파일 입력으로 쓴다.
 *
 * @returns 빈 결과
 */
export function emptyNextRoutesResult(): NextRoutesResult {
  return {
    routes: [],
    gaps: createRouteGaps(),
    routerDirectories: { appDirectory: undefined, pagesDirectory: undefined, symlinkedLocations: [] },
    frameworkSources: { metadataFiles: 0, proxyFiles: [], hasPublicFiles: false, hasLegacyStaticFiles: false },
  };
}

/**
 * 0으로 시작하는 공백 계수기를 만든다.
 *
 * @returns 계수기
 */
function createRouteGaps(): RouteGaps {
  return {
    ...createScanGaps(),
    unmodeledFiles: 0,
    invalidSegmentFiles: 0,
    dynamicPathFiles: 0,
    unreadableFiles: 0,
    unparsedFiles: 0,
    syntaxErrorFiles: 0,
    unresolvedExportFiles: 0,
    pagesWithoutDefaultExport: 0,
  };
}

/**
 * 파일이 route handler(`route.<ext>`)인지 확인한다.
 *
 * @param path 프로젝트 기준 경로
 * @param pageExtensions 페이지 확장자
 * @returns route 파일이면 true
 */
function isAppRouteFile(path: string, pageExtensions: readonly string[]): boolean {
  const name = baseName(path);
  return pageExtensions.some((extension) => name === `route.${extension}`);
}

/**
 * App Router route 파일 하나에서 method별 선언을 만든다.
 *
 * @param context 처리 문맥
 * @param appDirectory 프로젝트 기준 app 디렉터리
 * @param file 프로젝트 기준 route 파일 경로
 * @returns 선언 목록
 */
async function appRouteDeclarations(context: RouteFileContext, appDirectory: string, file: string): Promise<DeclaredRoute[]> {
  const path = routePathOf(context.gaps, relativeSegments(appDirectory, file).slice(0, -1), 'app');
  const testSource = isTestSourcePath(file);
  if (path === undefined || (testSource && !context.input.includeTests)) return [];
  const exports = await readModuleExports(context, file);
  if (exports === undefined) return [];
  if (exports.module.exportStarCount + exports.module.commonJsCount > 0) context.gaps.unresolvedExportFiles += 1;
  const methods = exports.module.names.filter((exported) => APP_ROUTE_METHODS.includes(exported.name as RouteDeclMethod));
  if (path.kind === 'dynamic' && methods.length > 0) context.gaps.dynamicPathFiles += 1;
  return methods.map((exported) => ({
    path,
    method: exported.name as RouteDeclMethod,
    file,
    exportName: exported.name,
    usr: exportBindingId(file, exported.name, exported.node),
    position: exports.positionOf(exported.node),
    testSource,
  }));
}

/**
 * Pages Router API 파일 목록을 모은다: `pages/api.<ext>`와 `pages/api/**`.
 *
 * @param context 처리 문맥
 * @param pagesDirectory 프로젝트 기준 pages 디렉터리
 * @returns 프로젝트 기준 파일 경로(정렬)
 */
async function pagesApiFiles(context: RouteFileContext, pagesDirectory: string | undefined): Promise<string[]> {
  if (pagesDirectory === undefined) return [];
  const { fileSystem, project } = context.input;
  const rootEntries = await listEntries(fileSystem, `${project}/${pagesDirectory}`, context.gaps);
  // `api` 디렉터리나 `api.<ext>`가 symlink면 트리 안 symlink와 같이 따라가지 않고 센다.
  context.gaps.symlinks += rootEntries.filter((entry) => entry.kind === 'symlink'
    && (entry.name === 'api' || pageKeyOf(entry.name, context.pageExtensions) === 'api')).length;
  const candidates = rootEntries
    .filter((entry) => entry.kind === 'file' && pageKeyOf(entry.name, context.pageExtensions) === 'api')
    .map((entry) => `${pagesDirectory}/${entry.name}`);
  if (rootEntries.some((entry) => entry.kind === 'directory' && entry.name === 'api')) {
    candidates.push(...await walkFiles(fileSystem, project, `${pagesDirectory}/api`, context.gaps));
  }
  return candidates.filter((path) => pageKeyOf(baseName(path), context.pageExtensions) !== undefined);
}

/**
 * Pages Router API 파일 하나에서 `ANY` 선언을 만든다.
 *
 * @param context 처리 문맥
 * @param pagesDirectory 프로젝트 기준 pages 디렉터리
 * @param file 프로젝트 기준 파일 경로
 * @returns 선언(0개 또는 1개)
 */
async function pagesApiDeclarations(context: RouteFileContext, pagesDirectory: string, file: string): Promise<DeclaredRoute[]> {
  const segments = relativeSegments(pagesDirectory, file);
  segments[segments.length - 1] = pageKeyOf(segments.at(-1)!, context.pageExtensions)!;
  if (segments.length > 1 && segments.at(-1) === 'index') segments.pop();
  const path = routePathOf(context.gaps, segments, 'pages');
  const testSource = isTestSourcePath(file);
  if (path === undefined || (testSource && !context.input.includeTests)) return [];
  const exports = await readModuleExports(context, file);
  if (exports === undefined) return [];
  const handler = exports.module.defaultExport ?? exports.module.firstCommonJsExport;
  if (handler === undefined) {
    context.gaps.pagesWithoutDefaultExport += 1;
    return [];
  }
  if (path.kind === 'dynamic') context.gaps.dynamicPathFiles += 1;
  const usr = exports.module.defaultExport === undefined ? undefined : exportBindingId(file, 'default', handler);
  return [{ path, method: 'ANY', file, exportName: 'default', usr, position: exports.positionOf(handler), testSource }];
}

/**
 * 세그먼트를 경로로 바꾸고, 라우트가 아니거나 모델링하지 않는 경로를 센다.
 *
 * @param gaps 공백 계수기(갱신)
 * @param segments 라우터 루트 기준 세그먼트
 * @param router 파일 라우터 종류
 * @returns 템플릿·dynamic 경로 또는 undefined
 */
function routePathOf(gaps: RouteGaps, segments: readonly string[], router: NextRouter): DeclaredRoute['path'] | undefined {
  const path = toRoutePath(segments, router);
  if (path.kind === 'unmodeled') gaps.unmodeledFiles += 1;
  if (path.kind === 'invalid') gaps.invalidSegmentFiles += 1;
  return path.kind === 'template' || path.kind === 'dynamic' ? path : undefined;
}

/** 파일 하나를 읽어 얻은 내보내기와 위치 변환기다. */
interface LoadedModule {
  readonly module: ModuleExports;
  readonly positionOf: (node: ts.Node) => SourcePosition;
}

/**
 * 파일을 읽고 파싱해 내보내기를 모은다. 읽거나 파싱할 수 없으면 센 뒤 undefined다.
 *
 * @param context 처리 문맥
 * @param file 프로젝트 기준 파일 경로
 * @returns 내보내기 또는 undefined
 */
async function readModuleExports(context: RouteFileContext, file: string): Promise<LoadedModule | undefined> {
  const scriptKind = scriptKindOf(file);
  if (scriptKind === undefined) {
    context.gaps.unparsedFiles += 1;
    return undefined;
  }
  const read = await readTextFile(context.input.fileSystem, `${context.input.project}/${file}`, MAX_ROUTE_FILE_BYTES);
  if (read.kind === 'failure') {
    context.gaps.unreadableFiles += 1;
    return undefined;
  }
  const parsed = parseSource(file, read.text, scriptKind);
  if (parsed.hasSyntaxErrors) context.gaps.syntaxErrorFiles += 1;
  return { module: collectModuleExports(parsed.sourceFile), positionOf: parsed.positionOf };
}

/**
 * 파일 이름에서 페이지 확장자를 떼어 페이지 키를 만든다. 긴 확장자부터 맞춘다(`page.ts` > `ts`).
 *
 * Next처럼 `ts`가 확장자에 있으면 `.d.ts`는 페이지가 아니다.
 *
 * @param name 파일 이름
 * @param pageExtensions 페이지 확장자
 * @returns 확장자를 뗀 이름, 페이지 파일이 아니면 undefined
 */
function pageKeyOf(name: string, pageExtensions: readonly string[]): string | undefined {
  if (name.endsWith('.d.ts') && pageExtensions.includes('ts')) return undefined;
  const extension = [...pageExtensions].sort((left, right) => right.length - left.length)
    .find((candidate) => name.endsWith(`.${candidate}`) && name.length > candidate.length + 1);
  return extension === undefined ? undefined : name.slice(0, -(extension.length + 1));
}

/**
 * 테스트 소스 경로인지 판정한다: `*.test.*`·`*.spec.*` 파일, `__tests__`·`__mocks__` 디렉터리.
 *
 * `test`·`tests` 폴더는 Next에서 실제 URL 세그먼트일 수 있어(`app/api/test/route.ts`) 쓰지 않는다.
 *
 * @param path 프로젝트 기준 경로
 * @returns 테스트 소스면 true
 */
export function isTestSourcePath(path: string): boolean {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((segment) => segment === '__tests__' || segment === '__mocks__')) return true;
  return /\.(?:test|spec)\.[^.]+$/u.test(segments.at(-1)!);
}

/**
 * 파일 라우트 밖 경로의 근거를 모은다.
 *
 * @param context 처리 문맥
 * @param directories 라우터 디렉터리
 * @param appFiles app 아래 파일(비공개 제외)
 * @returns 근거
 */
async function collectFrameworkSources(
  context: RouteFileContext,
  directories: RouterDirectories,
  appFiles: readonly string[],
): Promise<FrameworkSources> {
  const { fileSystem, project } = context.input;
  const metadataFiles = directories.appDirectory === undefined
    ? 0
    : appFiles.filter((file) => isMetadataFile(relativeSegments(directories.appDirectory!, file), context.pageExtensions)).length;
  const parents = [...new Set([directories.appDirectory, directories.pagesDirectory]
    .filter((directory) => directory !== undefined).map(parentOf))];
  const proxyFiles: string[] = [];
  for (const parent of parents) {
    const entries = await listEntries(fileSystem, parent === '' ? project : `${project}/${parent}`, context.gaps);
    // symlink인 proxy도 이름만 근거로 남긴다(대상은 읽지 않는다). limitation은 안전한 쪽이다.
    proxyFiles.push(...entries.filter((entry) => (entry.kind === 'file' || entry.kind === 'symlink') && isProxyFile(entry.name, context.pageExtensions))
      .map((entry) => (parent === '' ? entry.name : `${parent}/${entry.name}`)));
  }
  return {
    metadataFiles,
    proxyFiles: proxyFiles.sort(compareStrings),
    hasPublicFiles: await hasStaticFiles(context, 'public'),
    hasLegacyStaticFiles: await hasStaticFiles(context, 'static'),
  };
}

/**
 * 루트의 정적 파일 디렉터리가 파일을 내놓을 수 있는지 본다. symlink면 따라가지 않고 있는 것으로 본다.
 *
 * Next.js 16.2.7은 `public/`을 사이트 루트에, 폐기 예정인 구 규칙 `static/`을 `/static` 아래에 제공한다
 * (`server/lib/router-utils/filesystem.js`의 `publicFolderItems`·`legacyStaticFolderItems`, 둘 다 프로젝트
 * 루트 기준).
 *
 * @param context 처리 문맥
 * @param directory 프로젝트 루트 기준 디렉터리 이름
 * @returns 비어 있지 않은 디렉터리이거나 풀리는 symlink면 true
 */
async function hasStaticFiles(context: RouteFileContext, directory: 'public' | 'static'): Promise<boolean> {
  const { fileSystem, project } = context.input;
  const entry = await lookupEntry(fileSystem, project, directory);
  if (entry.kind === 'symlink') return true;
  return entry.kind === 'directory' && (await listEntries(fileSystem, `${project}/${directory}`, context.gaps)).length > 0;
}

/** 정적 메타데이터 이미지 파일 이름과 확장자다(`lib/metadata/is-metadata-route.js`). */
const metadataImagePattern = /^(?:icon|apple-icon|opengraph-image|twitter-image)\d*\.(?:ico|jpg|jpeg|png|svg|gif)$/u;

/** 루트에만 오는 정적 메타데이터 파일이다. */
const rootMetadataPattern = /^(?:favicon\.ico|robots\.txt|manifest\.json|manifest\.webmanifest)$/u;

/**
 * app 기준 세그먼트가 메타데이터 라우트 파일인지 판정한다(framework 경로 근거용 근사).
 *
 * 과대 판정은 limitation을 하나 더 낼 뿐이라 안전한 쪽이다.
 *
 * @param segments app 디렉터리 기준 세그먼트
 * @param pageExtensions 페이지 확장자
 * @returns 메타데이터 파일이면 true
 */
function isMetadataFile(segments: readonly string[], pageExtensions: readonly string[]): boolean {
  const name = segments.at(-1)!;
  const isRoot = segments.length === 1;
  if (isRoot && rootMetadataPattern.test(name)) return true;
  if (name === 'sitemap.xml' || metadataImagePattern.test(name)) return true;
  const key = pageKeyOf(name, pageExtensions);
  if (key === undefined) return false;
  if (isRoot && (key === 'robots' || key === 'manifest')) return true;
  return key === 'sitemap' || /^(?:icon|apple-icon|opengraph-image|twitter-image)\d*$/u.test(key);
}

/**
 * 파일 이름이 proxy·middleware 규칙 파일인지 확인한다.
 *
 * @param name 파일 이름
 * @param pageExtensions 페이지 확장자
 * @returns 규칙 파일이면 true
 */
function isProxyFile(name: string, pageExtensions: readonly string[]): boolean {
  return pageExtensions.some((extension) => name === `proxy.${extension}` || name === `middleware.${extension}`);
}

/**
 * 디렉터리 기준 상대 세그먼트를 만든다.
 *
 * @param directory 프로젝트 기준 디렉터리
 * @param file 그 아래 프로젝트 기준 파일 경로
 * @returns 세그먼트 목록(마지막은 파일 이름)
 */
function relativeSegments(directory: string, file: string): string[] {
  return file.slice(directory.length + 1).split('/');
}

/**
 * POSIX 경로의 마지막 이름이다.
 *
 * @param path 경로
 * @returns 마지막 이름
 */
function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * POSIX 상대 경로의 부모다. 한 단계면 `''`(프로젝트 루트)다.
 *
 * @param path 상대 경로
 * @returns 부모 경로
 */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}
