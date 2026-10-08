/**
 * 프로젝트 하나의 호출 그래프를 만든다.
 *
 * 단계: 라우트 추출(진입점·라우트 파일) → 소스 파일 모으기(schema와 같은 걷기 규칙, Prisma 생성 클라이언트
 * 제외, 라우트 파일 추가) → Program/TypeChecker → 1단계 노드(선언·export 노드) → 재정의 표 → 2단계 간선
 * (호출·참조·클래스 암묵 간선·export 별칭) → 진입점 표식 → 디스패치(bound·candidate 간선) → limitation 조립.
 *
 * 노드 파일은 프로젝트 안 소스뿐이다. `node_modules`·lib·생성 코드의 선언은 노드가 되지 않고 그리로
 * 가는 호출은 외부로 센다.
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import ts from 'typescript';

import type { CommandFileSystem } from '../cli/file-system.ts';
import { isSafeIdentifier, type RouteDeclFact } from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import { DEFAULT_PAGE_EXTENSIONS } from '../routes/next-config.ts';
import { emptyNextRoutesResult, isTestSourcePath, type NextRoutesResult } from '../routes/next-routes.ts';
import { extractProjectRoutes } from '../routes/project-routes.ts';
import { createRouteDocument } from '../routes/route-document.ts';
import { collectProjectFiles, type ProjectFiles } from '../schema/project-files.ts';
import { MAX_SOURCE_BYTES, ProjectReader } from '../schema/project-reader.ts';
import { loadPrismaProject } from '../schema/prisma-project.ts';
import { isSourceFileName } from '../schema/source-module.ts';
import { addClassEdges, addOverrides } from './class-relations.ts';
import { createModuleResolver, importsTestSources, resolveDispatch } from './dispatch.ts';
import { collectFileEdges, type EdgeGaps, type PendingDispatch } from './edge-collector.ts';
import { createEffectManifest, effectEmitPolicy, selectEffectManifest } from './effect-inventory.ts';
import { type EntryInput, isFrameworkFile, markEntryPoints } from './entry-points.ts';
import { linkExportNodes, type PendingExport, registerExportNodes } from './export-nodes.ts';
import { buildFileIndex, type FlowIndex, mergeFlowIndexes } from './flow-index.ts';
import {
  type CallGraph,
  type CallStatistics,
  DISPATCH_MODES,
  type DispatchMode,
  type GraphNode,
  GraphStore,
  UNRESOLVED_REASONS,
  type UnresolvedReason,
} from './graph-model.ts';
import { collectFileNodes } from './node-collector.ts';
import { createGraphProgram, GraphProjectInputError, type ProgramConfigStatus } from './program.ts';
import { TargetResolver } from './target-resolver.ts';

/** `vercel.json` 최대 크기(바이트)다. */
const MAX_VERCEL_CONFIG_BYTES = 1024 * 1024;

/** `package.json` 최대 크기(바이트)다. */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

/** limitation 한 줄에 싣는 parse-error 파일 수 상한이다. */
const MAX_PARSE_ERROR_FILES = 10;

/** 패키지를 스캔 밖 코드가 가져다 쓰는 공개 패키지로 보게 하는 `package.json` 필드다. */
const PUBLIC_ENTRY_FIELDS: readonly string[] = ['main', 'module', 'exports', 'bin', 'types', 'typings', 'browser'];

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
  readonly flowIndex: FlowIndex;
  readonly calls: CallStatistics;
  readonly gaps: EdgeGaps;
  readonly config: ProgramConfigStatus;
  readonly inputs: GraphInputs;
  readonly parseErrorFiles: readonly string[];
  readonly unresolvedExports: number;
  readonly unmatchedCrons: number;
  readonly cronConfigUnreadable: boolean;
  readonly routeFactsTruncated: boolean;
  /** bound의 열린 프로그램 판정 이유(없으면 닫힌 프로그램) */
  readonly openProgram: OpenProgramReason | undefined;
}

/** bound 디스패치가 내보낸 선언을 스캔 밖에서 부를 수 있다고 보는 이유다. */
type OpenProgramReason = 'public-package' | 'unreadable-manifest' | 'incomplete-scan';

/**
 * 호출 그래프를 만든다.
 *
 * @param project 프로젝트 realpath
 * @param fileSystem 라우트 추출용 파일 시스템
 * @returns 그래프
 */
/** 명시 설정은 선택한 프로젝트의 checker에 적용하며 workspace는 노드 소유 경계를 넓힌다. */
export interface GraphBuildOptions {
  readonly tsconfig?: string;
  readonly workspace?: string;
}

export async function buildCallGraph(project: string, fileSystem: CommandFileSystem, options: GraphBuildOptions = {}): Promise<CallGraph> {
  const selectedProject = project;
  const config = options.tsconfig;
  if (options.workspace !== undefined) {
    try {
      const workspace = realpathSync(options.workspace);
      const descendant = relative(workspace, realpathSync(project));
      if (descendant.split(/[\\/]/u)[0] === '..' || isAbsolute(descendant) || !statSync(workspace).isDirectory()) throw new GraphProjectInputError('workspace');
      project = workspace;
    } catch { throw new GraphProjectInputError('workspace'); }
  }
  const routes = await loadRouteInputs(project, fileSystem);
  const inputs = collectGraphInputs(project, routes.extraction);
  const { program, checker, status } = createGraphProgram(selectedProject, [...inputs.sources.values(), ...inputs.declarations], ts.createProgram, config);
  const files = nodeFiles(program, inputs.sources);
  const walk = inputs.walk;
  const coverageComplete = !status.configUnreadable && !walk.truncated && inputs.oversized === 0
    && walk.unreadableDirectories === 0 && walk.skippedSymlinks === 0;
  const analysis = analyzeFiles(program, checker, files, inputs.sources, coverageComplete);
  const crons = readCronPaths(project);
  const entryInput: EntryInput = {
    routeFacts: routes.facts,
    cronPaths: crons.paths,
    appDirectory: routes.extraction.routerDirectories.appDirectory,
    pagesDirectory: routes.extraction.routerDirectories.pagesDirectory,
    pageExtensions: routes.pageExtensions,
  };
  const unmatchedCrons = markEntryPoints(analysis.store, files, entryInput);
  const parseErrorFiles = collectParseErrorFiles(files);
  const openProgram = openProgramReason(project, inputs, parseErrorFiles.length);
  const frameworkFiles = new Set([...files.keys()].filter((path) => isFrameworkFile(path, entryInput)));
  resolveDispatch({ ...analysis, program, checker, files, openProgram: openProgram !== undefined, frameworkFiles });
  const nodes = analysis.store.nodes();
  const counts: GraphCounts = {
    ...analysis, config: status, inputs, parseErrorFiles, unmatchedCrons, openProgram,
    cronConfigUnreadable: crons.unreadable, routeFactsTruncated: routes.facts.length === 0 && routes.extraction.routes.length > 0,
  };
  const environmentLimits: string[] = [];
  if (options.workspace !== undefined) environmentLimits.push('workspace-config: owned sources and routes are scanned across the workspace; the graph checker uses the selected project config while server route discovery uses workspace-root configuration; separate package options are not merged');
  if (existsSync(join(project, '.pnp.cjs')) && !existsSync(join(project, 'node_modules'))) environmentLimits.push('pnp-dependencies: a PnP loader exists without node_modules; loaders are not executed and PnP-only dependency declarations may not resolve');
  const limitationsByMode = Object.fromEntries(DISPATCH_MODES.map((mode) => [mode, [...buildLimitations(nodes, counts, mode), ...environmentLimits]])) as Record<DispatchMode, string[]>;
  const limitations = [...buildLimitations(nodes, counts, 'snapshot'), ...environmentLimits];
  return { nodes, edges: analysis.store.edges(), limitations, limitationsByMode, statistics: { files: files.size, calls: analysis.calls } };
}

/**
 * bound 디스패치가 프로그램을 열린 것으로 봐야 하는 이유다: 공개 패키지(스캔 밖 코드가 내보낸 선언을
 * 가져다 쓴다)이거나, 스캔이 불완전해(건너뛴 파일·디렉터리·symlink, 구문 오류) 보지 못한 호출자가 있을 수 있다.
 *
 * @param project 프로젝트 realpath
 * @param inputs 입력 파일
 * @param parseErrors 구문 오류 파일 수
 * @returns 이유, 닫힌 프로그램이면 undefined
 */
function openProgramReason(project: string, inputs: GraphInputs, parseErrors: number): OpenProgramReason | undefined {
  const manifest = readManifestEntry(project);
  if (manifest !== 'private') return manifest;
  const walk = inputs.walk;
  const incomplete = walk.truncated || inputs.oversized > 0 || walk.unreadableDirectories > 0 || walk.skippedSymlinks > 0 || parseErrors > 0;
  return incomplete ? 'incomplete-scan' : undefined;
}

/**
 * 프로젝트 루트 `package.json`이 공개 진입점 필드(main·module·exports·bin·types·typings·browser)를 선언했는지
 * 본다. 파일이 없으면 공개 표식도 없다. 있는데 1 MiB를 넘거나 JSON 객체로 읽지 못하면 판단할 수 없으므로
 * 열린 쪽으로 본다(추측하지 않는다).
 *
 * @param project 프로젝트 realpath
 * @returns 공개 패키지·판단 불가·비공개
 */
function readManifestEntry(project: string): 'public-package' | 'unreadable-manifest' | 'private' {
  const path = join(project, 'package.json');
  let text: string;
  try {
    if (statSync(path).size > MAX_PACKAGE_JSON_BYTES) return 'unreadable-manifest';
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // 없는 package.json은 공개 표식이 없다는 뜻이다. 그 밖의 읽기 실패(권한 등)는 판단할 수 없다.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'private' : 'unreadable-manifest';
  }
  try {
    const manifest: unknown = JSON.parse(text);
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return 'unreadable-manifest';
    return PUBLIC_ENTRY_FIELDS.some((field) => field in manifest) ? 'public-package' : 'private';
  } catch {
    // JSON이 아니면 공개 진입점을 알 수 없다 — 열린 쪽으로 본다.
    return 'unreadable-manifest';
  }
}

/** 노드·간선 분석 결과다. */
interface FileAnalysis {
  readonly store: GraphStore;
  readonly resolver: TargetResolver;
  readonly productionResolver: TargetResolver;
  /** 모든 소스 파일 색인을 합친 direct 해석·전체 dispatch 공용 색인 */
  readonly flowIndex: FlowIndex;
  readonly productionFlowIndex: FlowIndex;
  readonly testPaths: ReadonlySet<string>;
  readonly separateTests: boolean;
  readonly overrides: ReadonlyMap<string, readonly string[]>;
  readonly pending: readonly PendingDispatch[];
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
 * @param expectedPaths 프로젝트 상대 경로 → authoritative 절대 입력 경로
 * @param coverageComplete 파일 걷기와 compiler 설정을 빠짐없이 해석했는지
 * @returns 저장소와 계수
 */
function analyzeFiles(program: ts.Program, checker: ts.TypeChecker, files: ReadonlyMap<string, ts.SourceFile>, expectedPaths: ReadonlyMap<string, string>, coverageComplete: boolean): FileAnalysis {
  const store = new GraphStore();
  const classes = new Map([...files].map(([path, sourceFile]) => [path, collectFileNodes(store, path, sourceFile).classes]));
  const pendingExports: PendingExport[] = [...files].flatMap(([path, sourceFile]) => registerExportNodes(store, path, sourceFile));
  const pathByFile = new Map([...files].map(([path, sourceFile]) => [sourceFile, path]));
  const resolveModule = createModuleResolver(program, checker);
  const testPaths = new Set([...files.keys()].filter(isTestSourcePath));
  const separateTests = testPaths.size > 0 && !importsTestSources(files, testPaths, resolveModule);
  const expectedFiles = new Map([...expectedPaths].map(([path, absolute]) => [absolute, files.get(path)]));
  const effectBudget = { visited: 0, records: 0 };
  const emitPolicy = effectEmitPolicy(program.getCompilerOptions());
  const wholeManifest = createEffectManifest(expectedFiles, 'whole', resolveModule, coverageComplete, effectBudget, checker, emitPolicy);
  const productionManifest = separateTests
    ? selectEffectManifest(wholeManifest, new Map([...expectedPaths]
      .filter(([path]) => !testPaths.has(path))
      .map(([path, absolute]) => [absolute, files.get(path)])), 'production')
    : wholeManifest;
  const flowIndexes = new Map([...files].map(([path, sourceFile]) => [path, buildFileIndex(checker, sourceFile, resolveModule, effectBudget, emitPolicy)]));
  const flowIndex = { ...mergeFlowIndexes(flowIndexes.values(), wholeManifest), proofProgram: program, proofDiagnostics: new Set<string>() };
  const productionFlowIndex = separateTests
    ? { ...mergeFlowIndexes([...flowIndexes].filter(([path]) => !testPaths.has(path)).map(([, index]) => index), productionManifest), proofProgram: program, proofDiagnostics: flowIndex.proofDiagnostics }
    : flowIndex;
  const resolver = new TargetResolver(
    checker,
    store,
    (sourceFile) => pathByFile.get(sourceFile),
    projectSpecifierMatcher(program.getCompilerOptions()),
    flowIndex,
    (sourceFile) => program.isSourceFileDefaultLibrary(sourceFile),
  );
  const productionResolver = separateTests
    ? new TargetResolver(
      checker,
      store,
      (sourceFile) => pathByFile.get(sourceFile),
      projectSpecifierMatcher(program.getCompilerOptions()),
      productionFlowIndex,
      (sourceFile) => program.isSourceFileDefaultLibrary(sourceFile),
    )
    : resolver;
  const overrides = new Map<string, string[]>();
  for (const [path, declarations] of classes) declarations.forEach((declaration) => addOverrides(overrides, checker, resolver, path, declaration));
  const calls = createCallStatistics();
  const gaps: EdgeGaps = { partial: {}, bound: {}, boundPartial: {}, candidate: {}, candidatePartial: {}, overriddenCalls: 0 };
  const pending: PendingDispatch[] = [];
  for (const [path, sourceFile] of files) {
    const edgeResolver = separateTests && !testPaths.has(path) ? productionResolver : resolver;
    collectFileEdges({ checker, store, resolver: edgeResolver, overrides, calls, gaps, pending }, path, sourceFile);
    classes.get(path)!.forEach((declaration) => addClassEdges(store, resolver, path, declaration));
  }
  return {
    store, resolver, productionResolver, flowIndex, productionFlowIndex, testPaths, separateTests,
    overrides, pending, calls, gaps,
    unresolvedExports: linkExportNodes(store, checker, (sourceFile) => {
      const path = pathByFile.get(sourceFile);
      return separateTests && path !== undefined && !testPaths.has(path) ? productionResolver : resolver;
    }, pendingExports),
  };
}

/**
 * 서버 라우트(Next.js·Node 백엔드)를 추출한다(테스트 소스 제외, routes 명령과 같은 규칙).
 *
 * @param project 프로젝트 realpath
 * @param fileSystem 파일 시스템
 * @returns 추출 결과·route-decl 사실·페이지 확장자
 */
async function loadRouteInputs(project: string, fileSystem: CommandFileSystem): Promise<RouteInputs> {
  const routes = await extractProjectRoutes(fileSystem, project, false);
  const extraction = routes.next?.extraction ?? emptyNextRoutesResult();
  const config = routes.next?.config;
  const pageExtensions = config?.pageExtensions.kind === 'known' ? config.pageExtensions.value : DEFAULT_PAGE_EXTENSIONS;
  let facts: readonly RouteDeclFact[] = [];
  try {
    facts = createRouteDocument({
      next: routes.next, node: routes.node, project, service: undefined, includeTests: false, toolVersion: '', generatedAt: new Date(0),
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
    dispatch: { bound: 0, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 },
  };
}

/**
 * 구문 오류가 있는 노드 파일의 프로젝트 상대 경로다.
 *
 * @param files 노드 파일
 * @returns 경로 순 파일 목록
 */
function collectParseErrorFiles(files: ReadonlyMap<string, ts.SourceFile>): string[] {
  return [...files].filter(([, sourceFile]) =>
    ((sourceFile as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0) > 0)
    .map(([path]) => path)
    .sort(compareStrings);
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
 * limitation을 만드는 관점이다: reach·impact 문서의 디스패치 모드, 또는 모든 간선을 싣는 스냅샷
 * (호출 계수는 direct 기준이고 bound·candidate 계수 줄을 함께 싣는다).
 */
type LimitationView = DispatchMode | 'snapshot';

/**
 * 그래프 limitation을 만든다.
 *
 * @param nodes 출력 노드
 * @param counts 계수
 * @param view 관점
 * @returns limitation 목록(고정 순서)
 */
function buildLimitations(nodes: readonly GraphNode[], counts: GraphCounts, view: LimitationView): string[] {
  const inventory = counts.flowIndex.effectInventory;
  const coverage = inventory?.enumeration === 'incomplete'
    ? [`effect-inventory: incomplete(${inventory.reasons.includes('build-cap') ? 'build-cap' : 'coverage'}); coverage cannot certify ambient safety.`] : [];
  return [...callLimitations(counts, view), ...inputLimitations(counts), ...entryLimitations(nodes, counts), ...coverage, ...[...counts.flowIndex.proofDiagnostics ?? []].sort()];
}

/** 관점에서 아직 잇지 못한 호출 공백을 이유별로 계산한다. */
function remainingDispatchGaps(
  calls: CallStatistics,
  gaps: EdgeGaps,
  view: LimitationView,
): { readonly unresolved: Record<UnresolvedReason, number>; readonly partial: Partial<Record<UnresolvedReason, number>> } {
  const unresolved = { ...calls.unresolved };
  const partial = { ...gaps.partial };
  for (const reason of UNRESOLVED_REASONS) {
    const linkedFull = view === 'bound' ? (gaps.bound[reason] ?? 0)
      : view === 'candidates' ? (gaps.bound[reason] ?? 0) + (gaps.candidate[reason] ?? 0) : 0;
    const linkedPartial = view === 'bound' ? (gaps.boundPartial[reason] ?? 0)
      : view === 'candidates' ? (gaps.boundPartial[reason] ?? 0) + (gaps.candidatePartial[reason] ?? 0) : 0;
    unresolved[reason] = Math.max(0, unresolved[reason] - linkedFull);
    if (partial[reason] !== undefined) partial[reason] = Math.max(0, partial[reason] - linkedPartial);
  }
  return { unresolved, partial };
}

/**
 * 호출 해석 limitation이다. `unresolved-calls:`·`partial-dispatch:`의 인터페이스 계수는 관점의 모드가 이은
 * 호출을 뺀 값이다.
 *
 * @param counts 계수
 * @param view 관점
 * @returns limitation 목록
 */
function callLimitations(counts: GraphCounts, view: LimitationView): string[] {
  const { calls, gaps, unresolvedExports } = counts;
  const result: string[] = [];
  const remaining = remainingDispatchGaps(calls, gaps, view);
  const unresolved = remaining.unresolved;
  const unresolvedTotal = UNRESOLVED_REASONS.reduce((sum, reason) => sum + unresolved[reason], 0);
  if (unresolvedTotal > 0) {
    const breakdown = UNRESOLVED_REASONS.filter((reason) => unresolved[reason] > 0).map((reason) => `${reason}: ${unresolved[reason]}`);
    result.push(`unresolved-calls: ${unresolvedTotal} call(s) could not be linked to a project declaration and were not guessed (${breakdown.join(', ')})`);
  }
  const partial = Object.entries(remaining.partial)
    .filter(([, count]) => count > 0);
  if (partial.length > 0) {
    const total = partial.reduce((sum, [, count]) => sum + count, 0);
    result.push(`partial-dispatch: ${total} call(s) through union or interface types were linked only to the implementations tsograph could prove (${partial.map(([reason, count]) => `${reason}: ${count}`).join(', ')})`);
  }
  result.push(...dispatchLimitations(counts, view));
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
 * bound·candidate 디스패치 limitation이다. direct 모드 문서에는 싣지 않는다.
 *
 * @param counts 계수
 * @param view 관점
 * @returns limitation 목록
 */
function dispatchLimitations({ calls, gaps, openProgram }: GraphCounts, view: LimitationView): string[] {
  if (view === 'direct') return [];
  const result: string[] = [];
  const { bound, boundPartial, candidate, candidatePartial } = calls.dispatch;
  const scope = view === 'snapshot' ? ' (followed by reach/impact with --dispatch bound, the default)' : '';
  if (bound + boundPartial > 0) {
    result.push(`bound-dispatch: ${bound + boundPartial} call(s) through deferred interface/callable sites are linked by bound edges${scope}: every observed receiver or callable value within the scanned project is a project implementation or callable declaration; reflective or computed-key writes and values from outside the scan keep affected flows unknown`);
  }
  const hasInterfaceGaps = calls.unresolved.interface + (gaps.partial.interface ?? 0) > 0;
  const callableReasons = ['parameter', 'computed', 'indirect'] as const;
  const hasCallableGaps = callableReasons.some((reason) => calls.unresolved[reason] > 0 || (gaps.partial[reason] ?? 0) > 0);
  if (openProgram !== undefined && (hasInterfaceGaps || hasCallableGaps)) {
    const reason = openProgram === 'public-package' ? 'package.json declares public entry points'
      : openProgram === 'unreadable-manifest' ? 'package.json could not be read as a JSON object within 1 MiB' : 'the scan is incomplete';
    result.push(hasInterfaceGaps
      ? `bound-dispatch: ${reason}, so exported functions and classes and non-private properties are treated as reachable from unseen code and their flows are not bound`
      : `bound-dispatch: ${reason}, so exported functions and classes and callable parameters are treated as reachable from unseen code and their flows are not bound`);
  }
  if (calls.dispatch.overBudget > 0) {
    result.push(`dispatch-budget: ${calls.dispatch.overBudget} deferred interface/callable call(s) exceeded the flow-analysis budget (steps, nesting, or stack); their flows count as unknown and they are not bound`);
  }
  if (view !== 'bound' && candidate + candidatePartial > 0) {
    const candidateScope = view === 'snapshot' ? ' (followed only with --dispatch candidates)' : '';
    result.push(`candidate-dispatch: ${candidate + candidatePartial} call(s) whose receiver flows could not all be proven are linked to every project class or object that implements or is assignable to the receiver type${candidateScope}; these edges over-approximate`);
  }
  return result;
}

/**
 * 입력·설정 limitation이다.
 *
 * @param counts 계수
 * @returns limitation 목록
 */
function inputLimitations({ config, inputs, parseErrorFiles, cronConfigUnreadable, routeFactsTruncated }: GraphCounts): string[] {
  const result: string[] = [];
  if (config.configUnreadable) {
    result.push(`graph-config: ${config.configName} could not be parsed; default compiler options were used, so path aliases may not resolve`);
  }
  if (parseErrorFiles.length > 0) {
    result.push(`parse-errors: ${parseErrorFiles.length} source file(s) have syntax errors; their calls may be incomplete`
      + parseErrorFileSuffix(parseErrorFiles));
  }
  if (inputs.oversized > 0) result.push(`oversized-sources: ${inputs.oversized} file(s) larger than 4 MiB were skipped`);
  if (inputs.walk.unreadableDirectories > 0) result.push(`unreadable-sources: ${inputs.walk.unreadableDirectories} directory entr(ies) could not be read and were skipped`);
  if (inputs.walk.skippedSymlinks > 0) result.push(`skipped-symlinks: ${inputs.walk.skippedSymlinks} symbolic link(s) were not followed`);
  if (inputs.walk.truncated) result.push('scan-truncated: the project tree exceeded the directory entry limit; later files were not scanned');
  if (cronConfigUnreadable) result.push('entry-points: vercel.json could not be read as JSON within 1 MiB; scheduled entries are unknown');
  if (routeFactsTruncated) result.push('entry-points: the project produces more route-decl facts than the routes limit; route handlers are not marked');
  return result;
}

/** 안전한 프로젝트 상대 parse-error 파일만 10개 싣고 나머지를 정확히 센다. */
function parseErrorFileSuffix(paths: readonly string[]): string {
  const safe = [...new Set(paths)].filter(isSafeDiagnosticPath).sort(compareStrings);
  const shown = safe.slice(0, MAX_PARSE_ERROR_FILES);
  return `; files: ${JSON.stringify(shown)}; omitted: ${new Set(paths).size - shown.length}`;
}

/** limitation에 그대로 실어도 source/절대 경로/control 문자가 새지 않는 경로인지 본다. */
function isSafeDiagnosticPath(path: string): boolean {
  return isSafeIdentifier(path) && !isAbsolute(path) && !/^[A-Za-z]:/u.test(path)
    && path.split(/[\\/]/u).every((part) => part.length > 0 && part !== '.' && part !== '..');
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
