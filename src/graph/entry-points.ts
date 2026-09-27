/**
 * 그래프 노드에 진입점 표식을 단다.
 *
 * - `route-handler`: `routes`가 낸 route-decl의 `symbol.usr`(HTTP 진입점, isthmus가 이어 준다).
 * - `scheduled`: `vercel.json`의 `crons[].path`와 맞는 GET·ANY route-decl 핸들러(Vercel은 cron을 GET으로 부른다).
 * - `server-action`: `'use server'` 파일의 내보내기, 본문이 `'use server'`로 시작하는 함수.
 * - `page`: App Router 특수 파일(`page`·`layout`·`template`·`default`·`error`·`not-found` …)의 기본 내보내기와
 *   `generateMetadata` 같은 서버 함수, Pages Router 페이지의 기본 내보내기와 `getServerSideProps` 등.
 * - `metadata-route`: `sitemap`·`robots`·`manifest`·아이콘·Open Graph 이미지 파일의 기본 내보내기.
 * - `middleware`: `proxy.<ext>`·`middleware.<ext>`의 `proxy`·`middleware`·기본 내보내기.
 * - `instrumentation`: `instrumentation.<ext>`의 `register`·`onRequestError`.
 *
 * `route-handler` 밖의 진입점은 route-decl 사실이 없으므로 isthmus trace가 http 경계로 잇지 못한다.
 * reach·impact 문서는 이런 진입점을 `non-http-entries:` limitation으로 알린다.
 */

import ts from 'typescript';

import type { RouteDeclFact } from '../exchange/bridge-facts.ts';
import { collectModuleExports } from '../routes/module-exports.ts';
import type { EntryKind, GraphStore } from './graph-model.ts';
import { exportBindingId, scopeIdOf } from './symbol-ids.ts';

/** App Router에서 페이지를 그리는 특수 파일 이름이다(Next.js 16 file conventions). */
const APP_PAGE_FILES: ReadonlySet<string> = new Set([
  'page', 'layout', 'template', 'default', 'error', 'global-error', 'not-found', 'global-not-found', 'loading', 'forbidden', 'unauthorized',
]);

/** 메타데이터 라우트 파일 이름 패턴이다. */
const METADATA_FILE = /^(?:sitemap|robots|manifest|icon\d*|apple-icon\d*|opengraph-image\d*|twitter-image\d*)$/u;

/** 페이지 파일이 내보내는 서버 함수 이름이다. */
const PAGE_SERVER_EXPORTS: ReadonlySet<string> = new Set([
  'generateMetadata', 'generateStaticParams', 'generateViewport', 'generateImageMetadata', 'generateSitemaps',
  'getServerSideProps', 'getStaticProps', 'getStaticPaths', 'getInitialProps',
]);

/** 진입점 표식 입력이다. */
export interface EntryInput {
  /** routes가 낸 route-decl 사실(테스트 소스 제외) */
  readonly routeFacts: readonly RouteDeclFact[];
  /** `vercel.json`의 cron 경로 */
  readonly cronPaths: readonly string[];
  /** 프로젝트 기준 app·pages 디렉터리 */
  readonly appDirectory: string | undefined;
  readonly pagesDirectory: string | undefined;
  /** 페이지 확장자 */
  readonly pageExtensions: readonly string[];
}

/**
 * 진입점을 표시한다.
 *
 * @param store 그래프 저장소
 * @param files 노드 파일(프로젝트 기준 경로 → 파일)
 * @param input 표식 입력
 * @returns 어떤 핸들러와도 맞지 않은 cron 경로 수
 */
export function markEntryPoints(store: GraphStore, files: ReadonlyMap<string, ts.SourceFile>, input: EntryInput): number {
  for (const fact of input.routeFacts) {
    if (fact.symbol.usr !== undefined) store.markEntry(fact.symbol.usr, 'route-handler');
  }
  const unmatchedCrons = input.cronPaths.filter((path) => !markScheduled(store, input.routeFacts, path)).length;
  for (const [path, sourceFile] of files) markFileEntries(store, path, sourceFile, input);
  return unmatchedCrons;
}

/**
 * cron 경로와 맞는 GET·ANY 핸들러에 `scheduled`를 단다.
 *
 * @param store 그래프 저장소
 * @param facts route-decl 사실
 * @param cronPath cron 경로
 * @returns 하나라도 맞았으면 true
 */
function markScheduled(store: GraphStore, facts: readonly RouteDeclFact[], cronPath: string): boolean {
  const matches = facts.filter((fact) => (fact.method === 'GET' || fact.method === 'ANY') && !fact.dynamic
    && fact.symbol.usr !== undefined && templateMatches(fact.channel, cronPath));
  for (const fact of matches) store.markEntry(fact.symbol.usr!, 'scheduled');
  return matches.length > 0;
}

/**
 * 정규 템플릿이 요청 경로와 맞는지 본다(`{}` 한 세그먼트, `{**}` 한 개 이상, 끝 슬래시 무시, 쿼리 제외).
 *
 * @param template 정규 경로 템플릿
 * @param requestPath 요청 경로
 * @returns 맞으면 true
 */
export function templateMatches(template: string, requestPath: string): boolean {
  const pattern = splitPath(template);
  const segments = splitPath(requestPath.split('?')[0]!);
  for (let index = 0; index < pattern.length; index++) {
    const segment = pattern[index]!;
    if (segment === '{**}') return segments.length > index;
    const actual = segments[index];
    if (actual === undefined || !segmentMatches(segment, actual)) return false;
  }
  return segments.length === pattern.length;
}

/**
 * 경로를 세그먼트로 나눈다. 앞뒤 슬래시 하나씩은 무시한다.
 *
 * @param path 경로
 * @returns 세그먼트
 */
function splitPath(path: string): string[] {
  const trimmed = path.replace(/^\//u, '').replace(/\/$/u, '');
  return trimmed === '' ? [] : trimmed.split('/');
}

/**
 * 템플릿 세그먼트 하나가 실제 세그먼트와 맞는지 본다.
 *
 * @param segment 템플릿 세그먼트(`{}`·부분 `{}`·리터럴)
 * @param actual 실제 세그먼트
 * @returns 맞으면 true
 */
function segmentMatches(segment: string, actual: string): boolean {
  const hole = segment.indexOf('{}');
  if (hole === -1) return segment === actual;
  const prefix = segment.slice(0, hole);
  const suffix = segment.slice(hole + 2);
  return actual.length > prefix.length + suffix.length && actual.startsWith(prefix) && actual.endsWith(suffix);
}

/**
 * 파일 하나의 진입점(서버 액션·페이지·메타데이터·미들웨어·instrumentation)을 표시한다.
 *
 * @param store 그래프 저장소
 * @param path 프로젝트 기준 경로
 * @param sourceFile 파일
 * @param input 표식 입력
 */
function markFileEntries(store: GraphStore, path: string, sourceFile: ts.SourceFile, input: EntryInput): void {
  const exports = exportIds(path, sourceFile);
  if (hasDirective(sourceFile.statements, 'use server')) exports.forEach((id) => store.markEntry(id, 'server-action'));
  if (sourceFile.text.includes('use server')) markInlineServerActions(store, path, sourceFile);
  const role = fileRole(path, input);
  if (role === undefined) return;
  for (const [name, id] of exports) {
    if (role.names.has(name)) store.markEntry(id, role.entry);
  }
}

/** 특수 파일의 진입점 종류와 진입 내보내기 이름이다. */
interface FileRole {
  readonly entry: EntryKind;
  readonly names: ReadonlySet<string>;
}

/**
 * 파일이 Next.js 특수 파일이면 역할을 돌려준다.
 *
 * @param path 프로젝트 기준 경로
 * @param input 표식 입력
 * @returns 역할 또는 undefined
 */
function fileRole(path: string, input: EntryInput): FileRole | undefined {
  const slash = path.lastIndexOf('/');
  const directory = slash === -1 ? '' : path.slice(0, slash);
  const key = pageKey(path.slice(slash + 1), input.pageExtensions);
  if (key === undefined) return undefined;
  const pageNames = new Set(['default', ...PAGE_SERVER_EXPORTS]);
  if (input.appDirectory !== undefined && isWithin(path, input.appDirectory)) {
    if (APP_PAGE_FILES.has(key)) return { entry: 'page', names: pageNames };
    if (METADATA_FILE.test(key)) return { entry: 'metadata-route', names: pageNames };
    return undefined;
  }
  if (input.pagesDirectory !== undefined && isWithin(path, input.pagesDirectory) && !isPagesApi(path, input.pagesDirectory)) {
    return { entry: 'page', names: pageNames };
  }
  return conventionRole(directory, key, input);
}

/**
 * app·pages 옆의 규칙 파일(`proxy`·`middleware`·`instrumentation`) 역할이다.
 *
 * @param directory 파일의 디렉터리
 * @param key 확장자를 뗀 파일 이름
 * @param input 표식 입력
 * @returns 역할 또는 undefined
 */
function conventionRole(directory: string, key: string, input: EntryInput): FileRole | undefined {
  const parents = [input.appDirectory, input.pagesDirectory].filter((value) => value !== undefined).map(parentOf);
  if (!parents.includes(directory)) return undefined;
  if (key === 'proxy' || key === 'middleware') return { entry: 'middleware', names: new Set(['proxy', 'middleware', 'default']) };
  if (key === 'instrumentation') return { entry: 'instrumentation', names: new Set(['register', 'onRequestError']) };
  return undefined;
}

/**
 * 파일의 내보낸 이름 → 그래프 id다(`routes`와 같은 규칙).
 *
 * @param path 프로젝트 기준 경로
 * @param sourceFile 파일
 * @returns 이름 → id
 */
function exportIds(path: string, sourceFile: ts.SourceFile): Map<string, string> {
  const exports = collectModuleExports(sourceFile);
  const ids = new Map(exports.names.map((exported) => [exported.name, exportBindingId(path, exported.name, exported.node)]));
  if (exports.defaultExport !== undefined) ids.set('default', exportBindingId(path, 'default', exports.defaultExport));
  return ids;
}

/**
 * 본문이 `'use server'`로 시작하는 함수를 서버 액션으로 표시한다.
 *
 * @param store 그래프 저장소
 * @param path 프로젝트 기준 경로
 * @param sourceFile 파일
 */
function markInlineServerActions(store: GraphStore, path: string, sourceFile: ts.SourceFile): void {
  const visit = (node: ts.Node): void => {
    const body = (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node))
      ? node.body : undefined;
    if (body !== undefined && ts.isBlock(body) && hasDirective(body.statements, 'use server')) {
      store.markEntry(scopeIdOf(body, path), 'server-action');
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

/**
 * 문장 목록의 머리(지시어 프롤로그)에 지시어가 있는지 본다.
 *
 * @param statements 문장 목록
 * @param directive 지시어 텍스트
 * @returns 있으면 true
 */
function hasDirective(statements: readonly ts.Statement[], directive: string): boolean {
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) return false;
    if (statement.expression.text === directive) return true;
  }
  return false;
}

/**
 * 파일 이름에서 페이지 확장자를 뗀다(긴 확장자 우선).
 *
 * @param name 파일 이름
 * @param extensions 페이지 확장자
 * @returns 확장자를 뗀 이름 또는 undefined
 */
function pageKey(name: string, extensions: readonly string[]): string | undefined {
  const extension = [...extensions].sort((left, right) => right.length - left.length).find((candidate) => name.endsWith(`.${candidate}`));
  return extension === undefined ? undefined : name.slice(0, -(extension.length + 1));
}

/**
 * 경로가 디렉터리 아래인지 본다.
 *
 * @param path 프로젝트 기준 경로
 * @param directory 프로젝트 기준 디렉터리
 * @returns 아래면 true
 */
function isWithin(path: string, directory: string): boolean {
  return path.startsWith(`${directory}/`);
}

/**
 * Pages Router API 파일(`pages/api/**`, `pages/api.<ext>`)인지 본다.
 *
 * @param path 프로젝트 기준 경로
 * @param pagesDirectory 프로젝트 기준 pages 디렉터리
 * @returns API 파일이면 true
 */
function isPagesApi(path: string, pagesDirectory: string): boolean {
  const rest = path.slice(pagesDirectory.length + 1);
  return rest.startsWith('api/') || rest.startsWith('api.');
}

/**
 * 프로젝트 기준 경로의 부모다. 한 단계면 `''`다.
 *
 * @param path 경로
 * @returns 부모
 */
function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}
