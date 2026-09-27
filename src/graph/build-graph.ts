/**
 * 프로젝트 하나의 호출 그래프를 만든다.
 *
 * 단계: 라우트 추출(진입점·라우트 파일) → 소스 파일 모으기(schema와 같은 걷기 규칙, Prisma 생성 클라이언트
 * 제외, 라우트 파일 추가) → Program/TypeChecker → 1단계 노드(선언·export 노드) → 재정의 표 → 2단계 간선
 * (호출·참조·클래스 암묵 간선·export 별칭) → 진입점 표식 → limitation 조립.
 *
 * 노드 파일은 프로젝트 안 소스뿐이다. `node_modules`·lib·생성 코드의 선언은 노드가 되지 않고 그리로
 * 가는 호출은 외부로 센다.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import ts from 'typescript';

import type { CommandFileSystem } from '../cli/file-system.ts';
import type { RouteDeclFact } from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import { DEFAULT_PAGE_EXTENSIONS } from '../routes/next-config.ts';
import { extractNextRoutes, type NextRoutesResult } from '../routes/next-routes.ts';
import { loadNextRouteConfig, readNextVersionStatus } from '../routes/project-config.ts';
import { createRouteDocument } from '../routes/route-document.ts';
import { collectProjectFiles, type ProjectFiles } from '../schema/project-files.ts';
import { MAX_SOURCE_BYTES, ProjectReader } from '../schema/project-reader.ts';
import { loadPrismaProject } from '../schema/prisma-project.ts';
import { isSourceFileName } from '../schema/source-module.ts';
import { addClassEdges, addOverrides } from './class-relations.ts';
import { collectFileEdges, type EdgeGaps } from './edge-collector.ts';
import { markEntryPoints } from './entry-points.ts';
import { linkExportNodes, type PendingExport, registerExportNodes } from './export-nodes.ts';
import {
  type CallGraph,
  type CallStatistics,
  type GraphNode,
  GraphStore,
  UNRESOLVED_REASONS,
} from './graph-model.ts';
import { collectFileNodes } from './node-collector.ts';
import { createGraphProgram, type ProgramConfigStatus } from './program.ts';
import { TargetResolver } from './target-resolver.ts';

/** `vercel.json` 최대 크기(바이트)다. */
const MAX_VERCEL_CONFIG_BYTES = 1024 * 1024;

/** 선언 파일 이름 패턴이다(루트 파일로만 넣고 노드는 만들지 않는다). */
const declarationFileName = /\.d\.[cm]?ts$/u;

/** 모은 입력 파일이다. */
interface GraphInputs {
  /** 노드 파일(프로젝트 기준 경로 → 절대 경로), 정렬 */
  readonly sources: ReadonlyMap<string, string>;
  /** 루트로만 넣는 선언 파일 절대 경로 */
  readonly declarations: readonly string[];
  readonly walk: ProjectFiles;
  readonly oversized: number;
}

/** 라우트 쪽 입력이다. */
interface RouteInputs {
  readonly extraction: NextRoutesResult;
  readonly facts: readonly RouteDeclFact[];
  readonly pageExtensions: readonly string[];
}

/** limitation을 만드는 데 필요한 계수다. */
interface GraphCounts {
  readonly calls: CallStatistics;
  readonly gaps: EdgeGaps;
  readonly config: ProgramConfigStatus;
  readonly inputs: GraphInputs;
  readonly parseErrors: number;
  readonly unresolvedExports: number;
  readonly unmatchedCrons: number;
  readonly cronConfigUnreadable: boolean;
  readonly routeFactsTruncated: boolean;
}

/**
 * 호출 그래프를 만든다.
 *
 * @param project 프로젝트 realpath
 * @param fileSystem 라우트 추출용 파일 시스템
 * @returns 그래프
 */
export async function buildCallGraph(project: string, fileSystem: CommandFileSystem): Promise<CallGraph> {
  const routes = await loadRouteInputs(project, fileSystem);
  const inputs = collectGraphInputs(project, routes.extraction);
  const { program, checker, status } = createGraphProgram(project, [...inputs.sources.values(), ...inputs.declarations]);
  const files = nodeFiles(program, inputs.sources);
  const analysis = analyzeFiles(program, checker, files);
  const crons = readCronPaths(project);
  const unmatchedCrons = markEntryPoints(analysis.store, files, {
    routeFacts: routes.facts,
    cronPaths: crons.paths,
    appDirectory: routes.extraction.routerDirectories.appDirectory,
    pagesDirectory: routes.extraction.routerDirectories.pagesDirectory,
    pageExtensions: routes.pageExtensions,
  });
  const nodes = analysis.store.nodes();
  const limitations = buildLimitations(nodes, {
    ...analysis, config: status, inputs, parseErrors: countParseErrors(files), unmatchedCrons,
    cronConfigUnreadable: crons.unreadable, routeFactsTruncated: routes.facts.length === 0 && routes.extraction.routes.length > 0,
  });
  return { nodes, edges: analysis.store.edges(), limitations, statistics: { files: files.size, calls: analysis.calls } };
}

/** 노드·간선 분석 결과다. */
interface FileAnalysis {
  readonly store: GraphStore;
  readonly calls: CallStatistics;
  readonly gaps: EdgeGaps;
  readonly unresolvedExports: number;
}

/**
 * 노드 파일을 두 단계로 분석한다: 노드(선언·export 노드)와 재정의 표 → 간선(호출·참조·클래스·별칭).
 *
 * @param program Program
 * @param checker TypeChecker
 * @param files 노드 파일
 * @returns 저장소와 계수
 */
function analyzeFiles(program: ts.Program, checker: ts.TypeChecker, files: ReadonlyMap<string, ts.SourceFile>): FileAnalysis {
  const store = new GraphStore();
  const classes = new Map([...files].map(([path, sourceFile]) => [path, collectFileNodes(store, path, sourceFile).classes]));
  const pendingExports: PendingExport[] = [...files].flatMap(([path, sourceFile]) => registerExportNodes(store, path, sourceFile));
  const pathByFile = new Map([...files].map(([path, sourceFile]) => [sourceFile, path]));
  const resolver = new TargetResolver(checker, store, (sourceFile) => pathByFile.get(sourceFile), projectSpecifierMatcher(program.getCompilerOptions()));
  const overrides = new Map<string, string[]>();
  for (const [path, declarations] of classes) declarations.forEach((declaration) => addOverrides(overrides, checker, resolver, path, declaration));
  const calls = createCallStatistics();
  const gaps: EdgeGaps = { partial: {}, overriddenCalls: 0 };
  for (const [path, sourceFile] of files) {
    collectFileEdges({ checker, store, resolver, overrides, calls, gaps }, path, sourceFile);
    classes.get(path)!.forEach((declaration) => addClassEdges(store, resolver, path, declaration));
  }
  return { store, calls, gaps, unresolvedExports: linkExportNodes(store, checker, resolver, pendingExports) };
}

/**
 * Next.js 라우트를 추출한다(테스트 소스 제외, routes 명령과 같은 규칙).
 *
 * @param project 프로젝트 realpath
 * @param fileSystem 파일 시스템
 * @returns 추출 결과·route-decl 사실·페이지 확장자
 */
async function loadRouteInputs(project: string, fileSystem: CommandFileSystem): Promise<RouteInputs> {
  const config = await loadNextRouteConfig(fileSystem, project);
  const extraction = await extractNextRoutes({ fileSystem, project, config, includeTests: false });
  const versionStatus = await readNextVersionStatus(fileSystem, project);
  const pageExtensions = config.pageExtensions.kind === 'known' ? config.pageExtensions.value : DEFAULT_PAGE_EXTENSIONS;
  let facts: readonly RouteDeclFact[] = [];
  try {
    facts = createRouteDocument({
      extraction, config, versionStatus, project, service: undefined, includeTests: false, toolVersion: '', generatedAt: new Date(0),
    }).facts;
  } catch {
    // 사실 상한 초과면 진입점 표식 없이 계속하고 limitation으로 알린다(buildLimitations의 routeFactsTruncated).
    facts = [];
  }
  return { extraction, facts, pageExtensions };
}

/**
 * 노드 파일과 루트 선언 파일을 모은다. schema와 같은 걷기 규칙이고 Prisma 생성 클라이언트는 뺀다.
 * 걷기 규칙이 건너뛰는 이름(`build/` 등) 아래의 라우트 파일도 넣는다.
 *
 * @param project 프로젝트 realpath
 * @param extraction 라우트 추출 결과
 * @returns 입력 파일
 */
function collectGraphInputs(project: string, extraction: NextRoutesResult): GraphInputs {
  const generated = new Set(loadPrismaProject(project, new ProjectReader()).outputDirectories);
  const walk = collectProjectFiles(project, {
    includeFile: (name) => isSourceFileName(name) || declarationFileName.test(name),
    excludedDirectories: generated,
  });
  const sources = new Map<string, string>();
  const declarations: string[] = [];
  let oversized = 0;
  const candidates = [...walk.files, ...extraction.routes.map((route): [string, string] => [route.file, join(project, route.file)])];
  for (const [path, absolute] of candidates) {
    if (declarationFileName.test(path)) {
      declarations.push(absolute);
    } else if (!sources.has(path)) {
      if (isOversized(absolute)) oversized++;
      else sources.set(path, absolute);
    }
  }
  const sorted = new Map([...sources].sort(([left], [right]) => compareStrings(left, right)));
  return { sources: sorted, declarations, walk, oversized };
}

/**
 * 파일이 schema와 같은 크기 상한(4 MiB)을 넘는지 본다. 읽지 못하면 넘는 것으로 본다.
 *
 * @param absolute 절대 경로
 * @returns 넘으면 true
 */
function isOversized(absolute: string): boolean {
  try {
    return statSync(absolute).size > MAX_SOURCE_BYTES;
  } catch {
    // 사이에 사라졌거나 권한이 없는 파일은 노드 파일로 쓰지 않는다(크기 초과와 같은 계수로 알린다).
    return true;
  }
}

/**
 * Program의 소스 파일 중 노드 파일을 고른다.
 *
 * @param program Program
 * @param sources 노드 파일(프로젝트 기준 경로 → 절대 경로)
 * @returns 프로젝트 기준 경로 → 소스 파일(경로 순)
 */
function nodeFiles(program: ts.Program, sources: ReadonlyMap<string, string>): Map<string, ts.SourceFile> {
  const files = new Map<string, ts.SourceFile>();
  for (const [path, absolute] of sources) {
    const sourceFile = program.getSourceFile(resolve(absolute));
    if (sourceFile !== undefined) files.set(path, sourceFile);
  }
  return files;
}

/**
 * import 지정자가 프로젝트 모듈을 가리키는지 판정하는 함수를 만든다: 상대·절대 경로, tsconfig `paths` 패턴.
 *
 * @param options 컴파일러 옵션
 * @returns 판정 함수
 */
export function projectSpecifierMatcher(options: ts.CompilerOptions): (specifier: string) => boolean {
  const patterns = Object.keys(options.paths ?? {}).map((key) => {
    const star = key.indexOf('*');
    return star === -1 ? { prefix: key, suffix: '', exact: true } : { prefix: key.slice(0, star), suffix: key.slice(star + 1), exact: false };
  });
  return (specifier) => specifier.startsWith('.') || specifier.startsWith('/')
    || patterns.some((pattern) => (pattern.exact ? specifier === pattern.prefix
      : specifier.startsWith(pattern.prefix) && specifier.endsWith(pattern.suffix) && specifier.length >= pattern.prefix.length + pattern.suffix.length));
}

/**
 * 0으로 시작하는 호출 통계를 만든다.
 *
 * @returns 통계
 */
function createCallStatistics(): CallStatistics {
  return {
    resolved: 0,
    external: 0,
    missingDependencies: 0,
    unresolved: Object.fromEntries(UNRESOLVED_REASONS.map((reason) => [reason, 0])) as CallStatistics['unresolved'],
  };
}

/**
 * 구문 오류가 있는 노드 파일 수다.
 *
 * @param files 노드 파일
 * @returns 파일 수
 */
function countParseErrors(files: ReadonlyMap<string, ts.SourceFile>): number {
  return [...files.values()].filter((sourceFile) =>
    ((sourceFile as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0) > 0).length;
}

/** `vercel.json`에서 읽은 cron 경로다. */
interface CronPaths {
  readonly paths: readonly string[];
  /** 파일이 있지만 JSON으로 읽지 못했는지 여부 */
  readonly unreadable: boolean;
}

/**
 * `vercel.json`의 `crons[].path`를 읽는다(실행하지 않는 JSON 읽기). 없으면 빈 목록이다.
 *
 * @param project 프로젝트 realpath
 * @returns cron 경로와 읽기 실패 여부
 */
function readCronPaths(project: string): CronPaths {
  let text: string;
  try {
    const path = join(project, 'vercel.json');
    if (statSync(path).size > MAX_VERCEL_CONFIG_BYTES) return { paths: [], unreadable: true };
    text = readFileSync(path, 'utf8');
  } catch {
    // vercel.json이 없으면 cron도 없다.
    return { paths: [], unreadable: false };
  }
  try {
    const crons: unknown = (JSON.parse(text) as { crons?: unknown }).crons;
    const entries = Array.isArray(crons) ? crons : [];
    return { paths: entries.flatMap((entry) => (typeof entry?.path === 'string' ? [entry.path as string] : [])), unreadable: false };
  } catch {
    // JSON이 아니면 cron을 알 수 없다 — limitation으로 알린다.
    return { paths: [], unreadable: true };
  }
}

/**
 * 그래프 limitation을 만든다.
 *
 * @param nodes 출력 노드
 * @param counts 계수
 * @returns limitation 목록(고정 순서)
 */
function buildLimitations(nodes: readonly GraphNode[], counts: GraphCounts): string[] {
  return [...callLimitations(counts), ...inputLimitations(counts), ...entryLimitations(nodes, counts)];
}

/**
 * 호출 해석 limitation이다.
 *
 * @param counts 계수
 * @returns limitation 목록
 */
function callLimitations({ calls, gaps, unresolvedExports }: GraphCounts): string[] {
  const result: string[] = [];
  const unresolvedTotal = UNRESOLVED_REASONS.reduce((sum, reason) => sum + calls.unresolved[reason], 0);
  if (unresolvedTotal > 0) {
    const breakdown = UNRESOLVED_REASONS.filter((reason) => calls.unresolved[reason] > 0).map((reason) => `${reason}: ${calls.unresolved[reason]}`);
    result.push(`unresolved-calls: ${unresolvedTotal} call(s) could not be linked to a project declaration and were not guessed (${breakdown.join(', ')})`);
  }
  const partial = Object.entries(gaps.partial);
  if (partial.length > 0) {
    const total = partial.reduce((sum, [, count]) => sum + count, 0);
    result.push(`partial-dispatch: ${total} call(s) through union or interface types were linked only to the implementations tsograph could prove (${partial.map(([reason, count]) => `${reason}: ${count}`).join(', ')})`);
  }
  if (calls.missingDependencies > 0) {
    result.push(`missing-dependencies: ${calls.missingDependencies} call(s) go through packages whose type declarations could not be resolved (dependencies not installed or untyped); they are treated as external`);
  }
  if (gaps.overriddenCalls > 0) {
    result.push(`overridden-methods: ${gaps.overriddenCalls} call(s) target methods that subclasses override; only the statically resolved declaration is linked`);
  }
  if (unresolvedExports > 0) {
    result.push(`unresolved-export-aliases: ${unresolvedExports} export node(s) could not be linked to the declaration they re-export`);
  }
  return result;
}

/**
 * 입력·설정 limitation이다.
 *
 * @param counts 계수
 * @returns limitation 목록
 */
function inputLimitations({ config, inputs, parseErrors, cronConfigUnreadable, routeFactsTruncated }: GraphCounts): string[] {
  const result: string[] = [];
  if (config.configUnreadable) {
    result.push(`graph-config: ${config.configName} could not be parsed; default compiler options were used, so path aliases may not resolve`);
  }
  if (parseErrors > 0) result.push(`parse-errors: ${parseErrors} source file(s) have syntax errors; their calls may be incomplete`);
  if (inputs.oversized > 0) result.push(`oversized-sources: ${inputs.oversized} file(s) larger than 4 MiB were skipped`);
  if (inputs.walk.unreadableDirectories > 0) result.push(`unreadable-sources: ${inputs.walk.unreadableDirectories} directory entr(ies) could not be read and were skipped`);
  if (inputs.walk.skippedSymlinks > 0) result.push(`skipped-symlinks: ${inputs.walk.skippedSymlinks} symbolic link(s) were not followed`);
  if (inputs.walk.truncated) result.push('scan-truncated: the project tree exceeded the directory entry limit; later files were not scanned');
  if (cronConfigUnreadable) result.push('entry-points: vercel.json could not be read as JSON within 1 MiB; scheduled entries are unknown');
  if (routeFactsTruncated) result.push('entry-points: the project produces more route-decl facts than the routes limit; route handlers are not marked');
  return result;
}

/**
 * 진입점 limitation이다.
 *
 * @param nodes 출력 노드
 * @param counts 계수
 * @returns limitation 목록
 */
function entryLimitations(nodes: readonly GraphNode[], { unmatchedCrons }: GraphCounts): string[] {
  const result = nonHttpEntryLimitations(nodes);
  if (unmatchedCrons > 0) result.push(`entry-points: ${unmatchedCrons} vercel.json cron path(s) match no GET route handler`);
  return result;
}

/**
 * 노드 목록 중 HTTP route 핸들러가 아닌 진입점을 종류별로 센 limitation이다(reach·impact 문서도 쓴다).
 *
 * @param nodes 노드 목록
 * @returns limitation 목록(0 또는 1개)
 */
export function nonHttpEntryLimitations(nodes: readonly GraphNode[]): string[] {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const entries = node.entries ?? [];
    if (entries.length === 0 || entries.includes('route-handler')) continue;
    for (const entry of entries) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const total = nodes.filter((node) => (node.entries ?? []).length > 0 && !node.entries!.includes('route-handler')).length;
  const breakdown = [...counts].sort(([left], [right]) => compareStrings(left, right)).map(([entry, count]) => `${entry}: ${count}`);
  return [`non-http-entries: ${total} symbol(s) are entry points without a route-decl fact (${breakdown.join(', ')}); isthmus cannot reach them through the http join`];
}
