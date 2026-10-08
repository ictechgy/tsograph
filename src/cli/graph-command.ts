/**
 * `tsograph graph`·`reach`·`impact` — TypeScript/JavaScript 호출 그래프와 그 순회다.
 *
 * - `graph`: 그래프 스냅샷(`tsograph-graph` v1, `graphRevision` = 내용 해시)을 낸다. 간선마다 근거
 *   (`direct`·`bound`·`candidate`)를 싣는다.
 * - `reach <id>...`: root에서 정방향(`dependencies`)으로 닿는 심볼을 isthmus `language-traversal` v1로 낸다.
 * - `impact <id>...`: root에 닿는 심볼(역방향 `dependents`)을 같은 형식으로 낸다.
 * - reach·impact의 `--dispatch direct|bound|candidates`(기본 bound)는 따라갈 간선 근거 범위다.
 *
 * 그래프 노드가 아닌 root id가 있으면 cartograph·kartograph처럼 아는 root로 문서를 내고 그 id를 계약대로
 * `root-not-found`로 기록한 뒤 64로 끝난다(표준 오류에 목록). 프로젝트를 읽지 못하거나 출력이 상한을 넘으면 2다.
 * 분석 대상 코드는 실행하지 않는다(TypeScript 컴파일러 API로 읽기만 한다).
 */

import { isAbsolute, relative } from 'node:path';
import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { encodeSortedJsonWithinLimit } from '../exchange/sorted-json.ts';
import { buildCallGraph, type GraphBuildOptions } from '../graph/build-graph.ts';
import { readGitRevision } from '../graph/git-revision.ts';
import { computeGraphRevision, createGraphSnapshot, type DocumentHeader } from '../graph/graph-document.ts';
import { DISPATCH_MODES, type CallGraph, type DispatchMode } from '../graph/graph-model.ts';
import { graphOutputChunks, GraphOutputWriteError, writeGraphOutput, type GraphOutputSink } from '../graph/graph-output.ts';
import { GraphProjectInputError } from '../graph/program.ts';
import { EMPTY_TRAVERSAL_RESULT, remapRootIndices, resolveRoots, type RootResolution, type UnresolvedRootKind } from '../graph/root-resolution.ts';
import { createTraversalDocument } from '../graph/traversal-document.ts';
import { MAX_TRAVERSAL_DEPTH, traverse, type TraversalDirection, type TraversalResult } from '../graph/traversal.ts';
import {
  MAX_SAVED_GRAPH_BYTES,
  SavedGraphError,
  parseSavedGraphSnapshot,
} from '../graph/saved-graph.ts';
import { type CommandResult, inputFailure, success, usageFailure, usageFailureWithOutput } from './command-result.ts';
import type { CommandFileSystem } from './file-system.ts';
import { MAX_OUTPUT_LENGTH } from './openapi-command.ts';
import { parseArguments } from './parse-arguments.ts';

/** 기본 최대 도달 노드 수다. */
export const DEFAULT_MAX_REACHED = 100_000;

/** 한 번에 받는 최대 root 수다. */
export const MAX_ROOT_IDS = 10_000;

/** reach·impact의 기본 디스패치 모드다. */
export const DEFAULT_DISPATCH: DispatchMode = 'bound';

/** 모르는 id를 오류 문구에 싣는 최대 개수다. */
const MAX_LISTED_UNKNOWN_IDS = 20;

/** graph 명령 사용법이다. */
export const graphUsage = `Usage: tsograph graph --project <root> [--tsconfig <file>] [--workspace <root>] [--generated-at <timestamp>] [--format json|ndjson]

Build the TypeScript/JavaScript call graph of the project (TypeScript compiler API over the
project's tsconfig/jsconfig) and write a tsograph-graph v1 snapshot: nodes (functions, methods,
constructors, classes, module scopes, export aliases) with entry-point marks and per-mode unresolved
call counts, edges (call, new, callback, reference, jsx, alias, initializer) with their evidence
(direct, bound, candidate), statistics, and graphRevision (content hash).

Options:
  --project <root>            Project root; node ids are relative to it (required)
  --tsconfig <file>           Config file relative to --project; its options use the config directory
  --workspace <root>         Own sources below this enclosing workspace; ids are relative to it
  --generated-at <timestamp>  Fixed generatedAt (YYYY-MM-DDTHH:mm:ss.sssZ) for byte-identical output
  --format json|ndjson        Graph output format; the process streams graph records

Exit codes: 0 success, 2 input/output failure, 64 usage error.
Stream failures may leave partial graph output; discard it whenever the exit code is 2.
`;

/** reach·impact 공통 옵션 설명이다. */
const traversalOptions = `Options:
  --project <root>            Build and traverse the project call graph (one input mode is required)
  --tsconfig <file>           Explicit compiler config (live --project input only)
  --workspace <root>         Enclosing workspace source boundary (live --project input only)
  --graph-file <path>         Traverse an existing tsograph-graph v1 file without reading project sources
  --max-depth <n>             Stop after n edges from the roots (1-${MAX_TRAVERSAL_DEPTH}, default ${MAX_TRAVERSAL_DEPTH})
  --max-reached <n>           Emit at most n reached symbols (default and maximum: ${DEFAULT_MAX_REACHED})
  --dispatch <mode>           Edges to follow: direct (proven by the checker), bound (direct plus
                              deferred interface/callable calls whose every observed receiver or
                              callable flow is a project implementation/declaration), candidates
                              (bound plus every assignable interface implementation).
                              Default: ${DEFAULT_DISPATCH}
  --entry-points              Include observed entry-point kinds on root/reached symbols (requires
                              an isthmus consumer supporting symbol.entries; omitted by default).
  --generated-at <timestamp>  Fixed generatedAt (YYYY-MM-DDTHH:mm:ss.sssZ) for byte-identical output
  --format json               Output format (json is the only format)

Ids are graph node ids (<path>#<declaration path>), the same strings as symbol.usr in
tsograph routes and schema output. Ids that are not graph nodes (typos, or the #model:/#typedsql:
declaration ids of tsograph schema) are kept in the document as roots without symbol, reported as
root-not-found (truncated), and listed on stderr; the document is still written and the exit code is 64.

Exit codes: 0 success, 2 unreadable project or oversized output, 64 usage error or root-not-found
(the document is written only for root-not-found).
`;

/** reach 명령 사용법이다. */
export const reachUsage = `Usage: tsograph reach (--project <root> | --graph-file <path>) [--max-depth <n>] [--max-reached <n>] [--dispatch <mode>] [--entry-points] [--generated-at <timestamp>] [--format json] <id>...

Write the symbols reachable from the given roots (direction "dependencies") as an isthmus
language-traversal v1 document.

${traversalOptions}`;

/** impact 명령 사용법이다. */
export const impactUsage = `Usage: tsograph impact (--project <root> | --graph-file <path>) [--max-depth <n>] [--max-reached <n>] [--dispatch <mode>] [--entry-points] [--generated-at <timestamp>] [--format json] <id>...

Write the symbols that reach the given roots (direction "dependents") as an isthmus
language-traversal v1 document.

${traversalOptions}`;

/** 그래프 명령의 실행 환경이다. */
export interface GraphEnvironment {
  readonly fileSystem: CommandFileSystem;
  readonly toolVersion: string;
  readonly now: () => Date;
  /** 그래프 생성기(테스트 주입용). 기본은 실제 생성기다. */
  readonly buildGraph?: (project: string, fileSystem: CommandFileSystem, options?: GraphBuildOptions) => Promise<CallGraph>;
  /** 프로세스는 backpressure를 기다리는 sink를 주며 in-memory 호출자는 기존 결과 문자열을 받는다. */
  readonly graphOutput?: GraphOutputSink;
}

/**
 * graph 명령을 실행한다.
 *
 * @param arguments_ `graph` 뒤의 인자
 * @param environment 실행 환경
 * @returns 프로세스 경계에 쓸 결과
 */
export async function runGraphCommand(arguments_: readonly string[], environment: GraphEnvironment): Promise<CommandResult> {
  const parsed = parseArguments(arguments_, ['--project', '--format', '--generated-at', '--tsconfig', '--workspace'], ['--help']);
  if (parsed?.booleanFlags.has('--help') === true) return success(graphUsage);
  const generatedAt = parseTimestamp(parsed?.valueFlags.get('--generated-at'));
  const problem = parsed === undefined ? 'unknown, repeated, or empty option.'
    : parsed.positionals.length > 0 ? 'graph takes no positional arguments; pass the root with --project.'
      : generatedAt === null ? '--generated-at takes a UTC timestamp such as 2026-09-27T00:00:00.000Z.'
        : !['json', 'ndjson'].includes(parsed.valueFlags.get('--format') ?? 'json') ? '--format takes json or ndjson.'
          : (parsed.valueFlags.has('--project') ? undefined : '--project <root> is required.');
  if (problem !== undefined) return usageFailure(`tsograph: ${problem}\n${graphUsage}`);
  const loaded = await loadGraph(parsed!.valueFlags.get('--project')!, withClock(environment, generatedAt ?? undefined), buildOptions(parsed!.valueFlags));
  if ('exitCode' in loaded) return loaded;
  const document = createGraphSnapshot(loaded.graph, loaded.header);
  const format = parsed!.valueFlags.get('--format') === 'ndjson' ? 'ndjson' : 'json';
  if (environment.graphOutput !== undefined) {
    try { await writeGraphOutput(document, format, environment.graphOutput); return success(''); }
    catch (error) {
      if (error instanceof GraphOutputWriteError) return inputFailure('graph output could not be written; check the destination and discard any partial output.');
      throw error;
    }
  }
  if (format === 'json') return render(document);
  let output = '';
  for (const chunk of graphOutputChunks(document, format)) {
    if (output.length + chunk.length > MAX_OUTPUT_LENGTH) return inputFailure('in-memory graph output exceeds its size limit; use the CLI streaming output.');
    output += chunk;
  }
  return success(output);
}

/**
 * reach 명령을 실행한다.
 *
 * @param arguments_ `reach` 뒤의 인자
 * @param environment 실행 환경
 * @returns 프로세스 경계에 쓸 결과
 */
export function runReachCommand(arguments_: readonly string[], environment: GraphEnvironment): Promise<CommandResult> {
  return runTraversalCommand(arguments_, environment, 'dependencies', reachUsage);
}

/**
 * impact 명령을 실행한다.
 *
 * @param arguments_ `impact` 뒤의 인자
 * @param environment 실행 환경
 * @returns 프로세스 경계에 쓸 결과
 */
export function runImpactCommand(arguments_: readonly string[], environment: GraphEnvironment): Promise<CommandResult> {
  return runTraversalCommand(arguments_, environment, 'dependents', impactUsage);
}

/** 검증한 순회 인자다. */
interface TraversalArguments {
  readonly input: { readonly kind: 'project' | 'saved-graph'; readonly path: string };
  readonly rootIds: readonly string[];
  readonly maxDepth: number;
  readonly maxReached: number;
  readonly dispatch: DispatchMode;
  readonly generatedAt: Date | undefined;
  readonly entryPoints: boolean;
  readonly buildOptions: GraphBuildOptions;
}

/**
 * reach·impact 공통 흐름이다.
 *
 * @param arguments_ 명령 뒤의 인자
 * @param environment 실행 환경
 * @param direction 순회 방향
 * @param usage 사용법
 * @returns 프로세스 경계에 쓸 결과
 */
async function runTraversalCommand(
  arguments_: readonly string[],
  environment: GraphEnvironment,
  direction: TraversalDirection,
  usage: string,
): Promise<CommandResult> {
  const parsed = parseTraversalArguments(arguments_);
  if (parsed === 'help') return success(usage);
  if (typeof parsed === 'string') return usageFailure(`tsograph: ${parsed}\n${usage}`);
  const loaded = await loadTraversalInput(parsed.input, withClock(environment, parsed.generatedAt), parsed.buildOptions);
  if ('exitCode' in loaded) return loaded;
  const roots = resolveRoots(parsed.rootIds, new Set(loaded.graph.nodes.map((node) => node.id)));
  const rendered = render(createTraversalDocument({
    graph: loaded.graph,
    graphRevision: loaded.graphRevision,
    header: loaded.header,
    direction,
    dispatch: parsed.dispatch,
    entryPoints: parsed.entryPoints,
    roots,
    result: traverseResolvedRoots(loaded.graph, parsed, direction, roots),
  }));
  if (rendered.exitCode !== 0 || roots.unresolved.size === 0) return rendered;
  return usageFailureWithOutput(rendered.standardOutput, unresolvedRootsMessage(roots.unresolved));
}

/**
 * 그래프 노드인 root만으로 순회하고 root 인덱스를 요청 순서로 옮긴다. 해석한 root가 없으면 빈 결과다.
 *
 * @param graph 호출 그래프
 * @param parsed 검증한 순회 인자
 * @param direction 순회 방향
 * @param roots root 대조 결과
 * @returns 요청 순서의 인덱스를 쓰는 순회 결과
 */
function traverseResolvedRoots(graph: CallGraph, parsed: TraversalArguments, direction: TraversalDirection, roots: RootResolution): TraversalResult {
  if (roots.resolvedIds.length === 0) return EMPTY_TRAVERSAL_RESULT;
  const { maxDepth, maxReached, dispatch } = parsed;
  return remapRootIndices(traverse(graph, { rootIds: roots.resolvedIds, direction, maxDepth, maxReached, dispatch }), roots);
}

/**
 * reach·impact 인자를 검증한다. 같은 id가 여러 번 오면 처음 것만 남긴다(root 인덱스가 겹치지 않게).
 *
 * @param arguments_ 명령 뒤의 인자
 * @returns 검증한 인자, 'help', 또는 사용법 오류 이유
 */
function parseTraversalArguments(arguments_: readonly string[]): TraversalArguments | 'help' | string {
  const parsed = parseArguments(arguments_, [
    '--project', '--graph-file', '--format', '--max-depth', '--max-reached', '--dispatch', '--generated-at', '--tsconfig', '--workspace',
  ], ['--help', '--entry-points']);
  if (parsed === undefined) return 'unknown, repeated, or empty option.';
  if (parsed.booleanFlags.has('--help')) return 'help';
  const format = formatProblem(parsed.valueFlags.get('--format'));
  if (format !== undefined) return format;
  const project = parsed.valueFlags.get('--project');
  const graphFile = parsed.valueFlags.get('--graph-file');
  if (project === undefined && graphFile === undefined) return 'exactly one of --project <root> and --graph-file <path> is required.';
  if (project !== undefined && graphFile !== undefined) return '--project and --graph-file are mutually exclusive input modes.';
  if (graphFile !== undefined && (parsed.valueFlags.has('--tsconfig') || parsed.valueFlags.has('--workspace'))) return '--tsconfig and --workspace require live --project input.';
  const rootIds = [...new Set(parsed.positionals)];
  if (rootIds.length === 0) return 'at least one symbol id is required.';
  if (rootIds.length > MAX_ROOT_IDS) return `at most ${MAX_ROOT_IDS} symbol ids are accepted.`;
  if (!rootIds.every(isSafeIdentifier)) return 'symbol ids must not contain control characters.';
  const maxDepth = parsePositiveInteger(parsed.valueFlags.get('--max-depth'), MAX_TRAVERSAL_DEPTH);
  const maxReached = parsePositiveInteger(parsed.valueFlags.get('--max-reached'), DEFAULT_MAX_REACHED);
  if (maxDepth === null || maxReached === null) {
    return `--max-depth takes 1-${MAX_TRAVERSAL_DEPTH} and --max-reached takes 1-${DEFAULT_MAX_REACHED}.`;
  }
  const dispatch = parsed.valueFlags.get('--dispatch') ?? DEFAULT_DISPATCH;
  if (!(DISPATCH_MODES as readonly string[]).includes(dispatch)) return '--dispatch takes direct, bound, or candidates.';
  const generatedAt = parseTimestamp(parsed.valueFlags.get('--generated-at'));
  if (generatedAt === null) return '--generated-at takes a UTC timestamp such as 2026-09-27T00:00:00.000Z.';
  return {
    input: project === undefined
      ? { kind: 'saved-graph', path: graphFile! }
      : { kind: 'project', path: project },
    rootIds, maxDepth: maxDepth ?? MAX_TRAVERSAL_DEPTH, maxReached: maxReached ?? DEFAULT_MAX_REACHED,
    dispatch: dispatch as DispatchMode, generatedAt, entryPoints: parsed.booleanFlags.has('--entry-points'),
    buildOptions: buildOptions(parsed.valueFlags),
  };
}

/** 입력 모드에 해당하는 명시 옵션만 생성기에 전달한다. */
function buildOptions(flags: ReadonlyMap<string, string>): GraphBuildOptions {
  return {
    ...(flags.has('--tsconfig') ? { tsconfig: flags.get('--tsconfig')! } : {}),
    ...(flags.has('--workspace') ? { workspace: flags.get('--workspace')! } : {}),
  };
}

/**
 * `--format` 값을 검사한다.
 *
 * @param format `--format` 값
 * @returns 문제 문구 또는 undefined
 */
function formatProblem(format: string | undefined): string | undefined {
  return format === undefined || format === 'json' ? undefined : '--format supports only json.';
}

/**
 * 상한이 있는 양의 정수 옵션을 읽는다.
 *
 * @param value 옵션 값
 * @param maximum 최댓값
 * @returns 정수, 없으면 undefined, 잘못됐으면 null
 */
function parsePositiveInteger(value: string | undefined, maximum: number): number | undefined | null {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,8}$/u.test(value)) return null;
  const parsed = Number(value);
  return parsed <= maximum ? parsed : null;
}

/**
 * `--generated-at` 값을 읽는다. 계약의 정규 형식(밀리초는 생략 가능, UTC `Z`)만 받는다.
 *
 * @param value 옵션 값
 * @returns 시각, 없으면 undefined, 잘못됐으면 null
 */
function parseTimestamp(value: string | undefined): Date | undefined | null {
  if (value === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return null;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) || instant.toISOString().slice(0, 19) !== value.slice(0, 19) ? null : instant;
}

/**
 * 고정 시각이 있으면 시계를 바꾼 환경을 만든다.
 *
 * @param environment 실행 환경
 * @param generatedAt 고정 시각
 * @returns 실행 환경
 */
function withClock(environment: GraphEnvironment, generatedAt: Date | undefined): GraphEnvironment {
  return generatedAt === undefined ? environment : { ...environment, now: () => generatedAt };
}

/** 해석하지 못한 root 종류별 표준 오류 꼬리표다. */
const UNRESOLVED_ROOT_LABELS: Record<UnresolvedRootKind, string> = {
  declaration: 'schema declaration id; never a graph node',
  unknown: 'unknown id',
};

/**
 * 해석하지 못한 root 안내 문구를 만든다. 제어 문자는 앞에서 걸렀고, 목록은 앞 20개만 싣는다.
 * 문서는 이미 표준 출력에 나가므로 무엇이 빠졌고 어떻게 고치는지만 알린다.
 *
 * @param unresolved 해석하지 못한 root id → 종류(요청 순서)
 * @returns 표준 오류 문구
 */
function unresolvedRootsMessage(unresolved: ReadonlyMap<string, UnresolvedRootKind>): string {
  const entries = [...unresolved];
  const listed = entries.slice(0, MAX_LISTED_UNKNOWN_IDS).map(([id, kind]) => `  ${id} (${UNRESOLVED_ROOT_LABELS[kind]})\n`).join('');
  const more = entries.length > MAX_LISTED_UNKNOWN_IDS ? `  … and ${entries.length - MAX_LISTED_UNKNOWN_IDS} more\n` : '';
  return `tsograph: ${entries.length} root id(s) are not graph nodes; the document lists them without symbol as root-not-found and traverses the other roots. `
    + `Pass graph node ids such as src/lib/jobs.ts#listJobs (see 'tsograph graph --project <root>'); #model:/#typedsql: ids are declaration-side facts that no traversal reaches:\n${listed}${more}`;
}

/** 읽은 그래프와 문서 머리다. */
interface LoadedGraph {
  readonly graph: CallGraph;
  readonly graphRevision: string;
  readonly header: DocumentHeader;
}

/** live 프로젝트 또는 저장 스냅샷 입력을 서로 섞지 않고 읽는다. */
async function loadTraversalInput(
  input: TraversalArguments['input'],
  environment: GraphEnvironment,
  options: GraphBuildOptions,
): Promise<LoadedGraph | CommandResult> {
  return input.kind === 'project'
    ? loadGraph(input.path, environment, options)
    : loadSavedGraph(input.path, environment);
}

/**
 * 프로젝트를 정규화하고 그래프를 만든다.
 *
 * @param projectArgument `--project` 값
 * @param environment 실행 환경
 * @returns 그래프와 머리, 또는 실패 결과
 */
async function loadGraph(projectArgument: string, environment: GraphEnvironment, options: GraphBuildOptions = {}): Promise<LoadedGraph | CommandResult> {
  let project: string;
  try {
    project = await environment.fileSystem.realPath(projectArgument);
    if ((await environment.fileSystem.status(project)).kind !== 'directory') throw new Error('not a directory');
  } catch {
    // 없음·권한·파일은 같은 해결 방향이라 한 문구로 알린다. 경로 원문은 싣지 않는다.
    return inputFailure('--project does not name a readable directory; pass the project root.');
  }
  if (!isSafeIdentifier(project)) {
    return inputFailure('the project path contains characters the exchange format forbids; rename or move the project.');
  }
  let graph: CallGraph;
  let identityRoot = project;
  if (options.workspace !== undefined) {
    try {
      identityRoot = await environment.fileSystem.realPath(options.workspace);
      if ((await environment.fileSystem.status(identityRoot)).kind !== 'directory') throw new GraphProjectInputError('workspace');
    } catch { return inputFailure(new GraphProjectInputError('workspace').message); }
    if (!isSafeIdentifier(identityRoot)) return inputFailure('the workspace path contains characters the exchange format forbids; rename or move the workspace.');
    const descendant = relative(identityRoot, project);
    if (descendant.split(/[\\/]/u)[0] === '..' || isAbsolute(descendant)) return inputFailure(new GraphProjectInputError('workspace').message);
  }
  try {
    graph = await (environment.buildGraph ?? buildCallGraph)(project, environment.fileSystem, options);
  } catch (error) {
    if (error instanceof GraphProjectInputError) return inputFailure(error.message);
    throw error;
  }
  return {
    graph,
    graphRevision: computeGraphRevision(graph),
    header: { toolVersion: environment.toolVersion, generatedAt: environment.now(), project: identityRoot, revision: readGitRevision(identityRoot) },
  };
}

/** 저장 그래프 파일만 bounded하게 읽고, 분석 소스나 환경 설정은 조회하지 않는다. */
async function loadSavedGraph(
  graphFileArgument: string,
  environment: GraphEnvironment,
): Promise<LoadedGraph | CommandResult> {
  let graphFile: string;
  let size: number;
  try {
    graphFile = await environment.fileSystem.realPath(graphFileArgument);
    const status = await environment.fileSystem.status(graphFile);
    if (status.kind !== 'file') throw new Error('not a file');
    size = status.size;
  } catch {
    return inputFailure('--graph-file does not name a readable saved graph file; pass an existing tsograph-graph v1 JSON file.');
  }
  if (size > MAX_SAVED_GRAPH_BYTES) {
    return inputFailure(`the saved graph exceeds ${MAX_SAVED_GRAPH_BYTES} bytes; produce a smaller graph snapshot.`);
  }
  let bytes: Uint8Array;
  try { bytes = await environment.fileSystem.readBytes(graphFile, MAX_SAVED_GRAPH_BYTES); }
  catch { return inputFailure('the saved graph file could not be read; check file permissions.'); }
  if (bytes.byteLength > MAX_SAVED_GRAPH_BYTES) {
    return inputFailure(`the saved graph exceeds ${MAX_SAVED_GRAPH_BYTES} bytes; produce a smaller graph snapshot.`);
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return inputFailure('the saved graph is not valid UTF-8; re-encode it as UTF-8 JSON.'); }
  try {
    const parsed = parseSavedGraphSnapshot(text);
    const provenance = `saved-graph-input: built by tsograph ${parsed.toolVersion} at ${parsed.generatedAt}; `
      + 'sources were not re-read; graphRevision verifies topology, not limitation, location or statistics integrity';
    const modeLimits = parsed.graph.limitationsByMode;
    return {
      graph: { ...parsed.graph, limitationsByMode: {
        direct: [...modeLimits.direct, provenance], bound: [...modeLimits.bound, provenance], candidates: [...modeLimits.candidates, provenance],
      } },
      graphRevision: parsed.graphRevision,
      header: {
        toolVersion: environment.toolVersion,
        generatedAt: environment.now(),
        project: parsed.project,
        revision: parsed.revision,
      },
    };
  } catch (error) {
    if (error instanceof SavedGraphError) return inputFailure(error.message);
    throw error;
  }
}

/**
 * 문서를 키 정렬 JSON으로 출력한다. isthmus 입력 상한(16 Mi 문자)을 넘으면 부분 문서 대신 2다.
 *
 * @param document 문서
 * @param maxLength 최대 길이(테스트 주입용)
 * @returns 성공 또는 실패 결과
 */
export function render(document: unknown, maxLength: number = MAX_OUTPUT_LENGTH): CommandResult {
  let text: string | undefined;
  try {
    text = encodeSortedJsonWithinLimit(document, maxLength);
  } catch (error) {
    /* node:coverage ignore next */
    if (!(error instanceof RangeError)) throw error;
    return outputTooLarge(maxLength);
  }
  return text === undefined ? outputTooLarge(maxLength) : success(text);
}

/**
 * 출력 길이 초과 실패를 만든다.
 *
 * @param maxLength 최대 길이
 * @returns 코드 2 결과
 */
function outputTooLarge(maxLength: number): CommandResult {
  return inputFailure(`the output document would exceed ${maxLength} characters; query fewer roots with reach/impact --max-depth/--max-reached or use a narrower --project.`);
}
