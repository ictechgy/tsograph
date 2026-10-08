/**
 * 디스크에 저장한 `tsograph-graph` v1을 실행 없이 다시 읽는 엄격한 parser다.
 *
 * 스냅샷은 신뢰 경계다. JSON 크기·깊이·값 수와 그래프 collection을 제한하고, 닫힌 schema와
 * 참조 무결성을 확인한 뒤 기존 `computeGraphRevision`으로 내용 신원을 다시 계산한다.
 */

import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { scanJsonNumberToken } from '../exchange/json-number-token.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import { computeGraphRevision } from './graph-document.ts';
import {
  DISPATCH_MODES,
  EDGE_EVIDENCE_ORDER,
  type CallGraph,
  type DispatchMode,
  type EdgeEvidence,
  type EdgeKind,
  type EntryKind,
  type GraphEdge,
  type GraphNode,
  type GraphStatistics,
  INDIRECT_SITE_KINDS,
  type NodeKind,
  UNRESOLVED_REASONS,
} from './graph-model.ts';

/** 독립 그래프 스냅샷 입력의 바이트 상한이다. */
export const MAX_SAVED_GRAPH_BYTES = 128 * 1024 * 1024;
/** 한 스냅샷의 노드 상한이다. */
export const MAX_SAVED_GRAPH_NODES = 500_000;
/** 한 스냅샷의 간선 상한이다. */
export const MAX_SAVED_GRAPH_EDGES = 2_000_000;
/** snapshot 또는 한 mode의 limitation 상한이다. */
export const MAX_SAVED_GRAPH_LIMITATIONS = 10_000;

/**
 * collection 상한의 가장 넓은 v1 모양을 lexical scanner가 먼저 거부하지 않게 하는 값 수 상한이다.
 *
 * node는 위치·entry·unresolvedCalls를 모두 가질 때 최대 20값, edge는 8종류를 모두 가질 때
 * 최대 13값이며, 전역+세 mode limitation과 문서 머리 여유를 더한다.
 */
export const MAX_SAVED_GRAPH_JSON_VALUES = 256
  + MAX_SAVED_GRAPH_NODES * 20
  + MAX_SAVED_GRAPH_EDGES * 13
  + MAX_SAVED_GRAPH_LIMITATIONS * (1 + DISPATCH_MODES.length);

const MAX_JSON_DEPTH = 32;
const MAX_ID_LENGTH = 8_192;
const MAX_PROVENANCE_LENGTH = 8_192;
const MAX_LIMITATION_LENGTH = 16_384;

const NODE_KINDS = new Set<NodeKind>([
  'module', 'function', 'method', 'constructor', 'accessor', 'class', 'variable', 'field', 'export',
]);
const EDGE_KINDS = new Set<EdgeKind>([
  'call', 'new', 'callback', 'reference', 'jsx', 'alias', 'initializer', 'contains',
]);
const ENTRY_KINDS = new Set<EntryKind>([
  'route-handler', 'scheduled', 'server-action', 'page', 'metadata-route', 'middleware', 'instrumentation',
]);
const EVIDENCE = new Set<EdgeEvidence>(EDGE_EVIDENCE_ORDER);

/** 옛 v1에 mode별 limitation이 없을 때 순회 문서에 붙이는 정직한 한계다. */
export const SAVED_GRAPH_MODE_LIMITATION = 'saved-graph-mode-limitations: the graph snapshot does not contain '
  + 'per-dispatch limitations; snapshot-wide limitations are preserved for every dispatch mode, and mode-specific '
  + 'gaps cannot be reconstructed without rebuilding the analyzed sources';

/** 파싱한 그래프와 스냅샷 provenance다. */
export interface ParsedSavedGraph {
  readonly graph: CallGraph;
  readonly graphRevision: string;
  readonly toolVersion: string;
  readonly generatedAt: string;
  readonly project: string;
  readonly revision?: string;
}

/** 원문이나 파일 경로를 포함하지 않는 저장 그래프 오류다. */
export class SavedGraphError extends Error {
  readonly code: SavedGraphErrorCode;

  constructor(code: SavedGraphErrorCode) {
    super(savedGraphMessage(code));
    this.name = 'SavedGraphError';
    this.code = code;
  }
}

/** 호출자가 원인별 해결 방향을 유지할 수 있는 오류 종류다. */
export type SavedGraphErrorCode =
  | 'too-large' | 'invalid-json' | 'too-deep' | 'too-many-values' | 'duplicate-key'
  | 'invalid-schema' | 'invalid-provenance' | 'invalid-node' | 'duplicate-node'
  | 'invalid-edge' | 'missing-endpoint' | 'duplicate-edge' | 'invalid-statistics'
  | 'invalid-limitations' | 'revision-mismatch';

/**
 * JSON 텍스트를 bounded하게 읽고 완전한 `CallGraph`로 검증한다.
 *
 * @param text UTF-8에서 디코드한 스냅샷 텍스트
 * @returns 순회 가능한 그래프와 원본 provenance
 */
export function parseSavedGraphSnapshot(text: string): ParsedSavedGraph {
  if (Buffer.byteLength(text, 'utf8') > MAX_SAVED_GRAPH_BYTES) throw new SavedGraphError('too-large');
  new JsonLimitsScanner(text).scan();
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new SavedGraphError('invalid-json'); }
  return validateDocument(value);
}

/** 닫힌 v1 문서를 검증하고 runtime 모델로 다시 만든다. */
function validateDocument(value: unknown): ParsedSavedGraph {
  if (!isRecord(value) || value.format !== 'tsograph-graph' || value.version !== 1) {
    throw new SavedGraphError('invalid-schema');
  }
  assertKeys(value, [
    'format', 'version', 'tool', 'generatedAt', 'platform', 'project', 'revision', 'graphRevision',
    'nodes', 'edges', 'statistics', 'limitations', 'limitationsByMode',
  ], 'invalid-schema');
  const provenance = validateProvenance(value);
  const nodes = validateNodes(value.nodes);
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = validateEdges(value.edges, nodeIds);
  const statistics = validateStatistics(value.statistics);
  const limitations = validateLimitations(value.limitations);
  const limitationsByMode = value.limitationsByMode === undefined
    ? fallbackLimitations(limitations)
    : validateLimitationsByMode(value.limitationsByMode);
  const graph: CallGraph = { nodes, edges, statistics, limitations, limitationsByMode };
  if (computeGraphRevision(graph) !== provenance.graphRevision) throw new SavedGraphError('revision-mismatch');
  return {
    graph,
    graphRevision: provenance.graphRevision,
    toolVersion: provenance.toolVersion,
    generatedAt: provenance.generatedAt,
    project: provenance.project,
    ...(provenance.revision === undefined ? {} : { revision: provenance.revision }),
  };
}

/** 문서 생성 도구·시각·프로젝트·revision을 검증한다. */
function validateProvenance(value: Record<string, unknown>): {
  readonly toolVersion: string; readonly generatedAt: string; readonly project: string;
  readonly revision?: string; readonly graphRevision: string;
} {
  if (!isRecord(value.tool)) throw new SavedGraphError('invalid-provenance');
  assertKeys(value.tool, ['name', 'version'], 'invalid-provenance');
  const toolVersion = value.tool.version;
  const generatedAt = value.generatedAt;
  if (value.tool.name !== 'tsograph' || !safeString(toolVersion, 256)
    || value.platform !== 'js' || !validTimestamp(generatedAt)
    || !absoluteProjectRoot(value.project)) throw new SavedGraphError('invalid-provenance');
  if (value.revision !== undefined
    && (typeof value.revision !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value.revision))) {
    throw new SavedGraphError('invalid-provenance');
  }
  if (typeof value.graphRevision !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value.graphRevision)) {
    throw new SavedGraphError('invalid-provenance');
  }
  return {
    toolVersion,
    generatedAt,
    project: value.project,
    ...(value.revision === undefined ? {} : { revision: value.revision }),
    graphRevision: value.graphRevision,
  };
}

/** 노드 배열의 schema·정렬·중복을 검사한다. */
function validateNodes(value: unknown): GraphNode[] {
  if (!Array.isArray(value) || value.length > MAX_SAVED_GRAPH_NODES) throw new SavedGraphError('invalid-node');
  const nodes: GraphNode[] = [];
  const ids = new Set<string>();
  let previous: string | undefined;
  for (const raw of value) {
    const node = validateNode(raw);
    if (ids.has(node.id)) throw new SavedGraphError('duplicate-node');
    if (previous !== undefined && compareStrings(previous, node.id) >= 0) throw new SavedGraphError('invalid-node');
    ids.add(node.id);
    nodes.push(node);
    previous = node.id;
  }
  return nodes;
}

/** 노드 하나를 canonical field 순서의 값으로 복원한다. */
function validateNode(value: unknown): GraphNode {
  if (!isRecord(value)) throw new SavedGraphError('invalid-node');
  assertKeys(value, ['id', 'kind', 'location', 'entries', 'unresolvedCalls'], 'invalid-node');
  if (!validGraphId(value.id) || typeof value.kind !== 'string' || !NODE_KINDS.has(value.kind as NodeKind)) {
    throw new SavedGraphError('invalid-node');
  }
  const location = validateLocation(value.location);
  if (!(value.id as string).startsWith(`${location.path}#`)) throw new SavedGraphError('invalid-node');
  const entries = value.entries === undefined ? undefined
    : validateEnumArray(value.entries, ENTRY_KINDS, 'invalid-node');
  if (entries?.length === 0) throw new SavedGraphError('invalid-node');
  const unresolvedCalls = value.unresolvedCalls === undefined ? undefined
    : validateUnresolvedCalls(value.unresolvedCalls);
  return {
    id: value.id, kind: value.kind as NodeKind, location,
    ...(entries === undefined ? {} : { entries: entries as EntryKind[] }),
    ...(unresolvedCalls === undefined ? {} : { unresolvedCalls }),
  };
}

/** 프로젝트 상대 위치를 검증한다. */
function validateLocation(value: unknown): GraphNode['location'] {
  if (!isRecord(value)) throw new SavedGraphError('invalid-node');
  assertKeys(value, ['path', 'line', 'column'], 'invalid-node');
  if (!safeSourcePath(value.path) || !positiveInteger(value.line) || !positiveInteger(value.column)) {
    throw new SavedGraphError('invalid-node');
  }
  return { path: value.path, line: value.line, column: value.column };
}

/** 모드별 미해석 호출 수를 canonical 모드 순서로 복원한다. */
function validateUnresolvedCalls(value: unknown): NonNullable<GraphNode['unresolvedCalls']> {
  if (!isRecord(value)) throw new SavedGraphError('invalid-node');
  assertKeys(value, DISPATCH_MODES, 'invalid-node');
  const entries: [DispatchMode, number][] = [];
  for (const mode of DISPATCH_MODES) {
    const count = value[mode];
    if (count === undefined) continue;
    if (!positiveInteger(count)) throw new SavedGraphError('invalid-node');
    entries.push([mode, count]);
  }
  if (entries.length === 0) throw new SavedGraphError('invalid-node');
  const counts = Object.fromEntries(entries) as Partial<Record<DispatchMode, number>>;
  if ((counts.direct ?? 0) < (counts.bound ?? 0) || (counts.bound ?? 0) < (counts.candidates ?? 0)) {
    throw new SavedGraphError('invalid-node');
  }
  return counts;
}

/** 간선 배열의 schema·endpoint·정렬·중복을 검사한다. */
function validateEdges(value: unknown, nodeIds: ReadonlySet<string>): GraphEdge[] {
  if (!Array.isArray(value) || value.length > MAX_SAVED_GRAPH_EDGES) throw new SavedGraphError('invalid-edge');
  const edges: GraphEdge[] = [];
  const keys = new Set<string>();
  let previous: GraphEdge | undefined;
  for (const raw of value) {
    const edge = validateEdge(raw);
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) throw new SavedGraphError('missing-endpoint');
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.evidence}`;
    if (keys.has(key)) throw new SavedGraphError('duplicate-edge');
    if (previous !== undefined && compareEdges(previous, edge) >= 0) throw new SavedGraphError('invalid-edge');
    keys.add(key);
    edges.push(edge);
    previous = edge;
  }
  return edges;
}

/** 간선 하나를 검증한다. */
function validateEdge(value: unknown): GraphEdge {
  if (!isRecord(value)) throw new SavedGraphError('invalid-edge');
  assertKeys(value, ['from', 'to', 'kinds', 'evidence'], 'invalid-edge');
  if (!validGraphId(value.from) || !validGraphId(value.to)
    || typeof value.evidence !== 'string' || !EVIDENCE.has(value.evidence as EdgeEvidence)) {
    throw new SavedGraphError('invalid-edge');
  }
  const kinds = validateEnumArray(value.kinds, EDGE_KINDS, 'invalid-edge');
  if (kinds.length === 0) throw new SavedGraphError('invalid-edge');
  return { from: value.from, to: value.to, kinds: kinds as EdgeKind[], evidence: value.evidence as EdgeEvidence };
}

/** 그래프 통계의 모든 count와 닫힌 key 집합을 검사한다. */
function validateStatistics(value: unknown): GraphStatistics {
  if (!isRecord(value)) throw new SavedGraphError('invalid-statistics');
  assertKeys(value, ['files', 'calls'], 'invalid-statistics');
  if (!nonNegativeInteger(value.files) || !isRecord(value.calls)) throw new SavedGraphError('invalid-statistics');
  const calls = value.calls;
  assertKeys(calls,
    ['resolved', 'external', 'missingDependencies', 'unresolved', 'indirectSites', 'dispatch'],
    'invalid-statistics');
  if (!nonNegativeInteger(calls.resolved) || !nonNegativeInteger(calls.external)
    || !nonNegativeInteger(calls.missingDependencies)
    || !isRecord(calls.unresolved) || !isRecord(calls.dispatch)) {
    throw new SavedGraphError('invalid-statistics');
  }
  const unresolvedCounts = calls.unresolved;
  const dispatchCounts = calls.dispatch;
  assertKeys(unresolvedCounts, UNRESOLVED_REASONS, 'invalid-statistics');
  assertKeys(dispatchCounts,
    ['bound', 'boundPartial', 'candidate', 'candidatePartial', 'overBudget'], 'invalid-statistics');
  if (!UNRESOLVED_REASONS.every((reason) => nonNegativeInteger(unresolvedCounts[reason]))) {
    throw new SavedGraphError('invalid-statistics');
  }
  const dispatchKeys = ['bound', 'boundPartial', 'candidate', 'candidatePartial', 'overBudget'] as const;
  if (!dispatchKeys.every((key) => nonNegativeInteger(dispatchCounts[key]))) {
    throw new SavedGraphError('invalid-statistics');
  }
  const unresolved = Object.fromEntries(
    UNRESOLVED_REASONS.map((reason) => [reason, unresolvedCounts[reason]]),
  ) as GraphStatistics['calls']['unresolved'];
  const dispatch = Object.fromEntries(
    dispatchKeys.map((key) => [key, dispatchCounts[key]]),
  ) as unknown as GraphStatistics['calls']['dispatch'];
  const indirectSites = calls.indirectSites === undefined
    ? undefined
    : validateIndirectSites(calls.indirectSites, unresolved.indirect);
  return {
    files: value.files,
    calls: {
      resolved: calls.resolved, external: calls.external,
      missingDependencies: calls.missingDependencies,
      unresolved,
      ...(indirectSites === undefined ? {} : { indirectSites }),
      dispatch,
    },
  };
}

/** 선택 통계는 알려진 shape의 양수만 담고 raw indirect 합계를 정확히 분할해야 한다. */
function validateIndirectSites(
  value: unknown,
  indirectCount: number,
): NonNullable<GraphStatistics['calls']['indirectSites']> {
  if (!isRecord(value)) throw new SavedGraphError('invalid-statistics');
  assertKeys(value, INDIRECT_SITE_KINDS, 'invalid-statistics');
  const entries = INDIRECT_SITE_KINDS.flatMap((kind) => {
    const count = value[kind];
    if (count === undefined) return [];
    if (!positiveInteger(count)) throw new SavedGraphError('invalid-statistics');
    return [[kind, count] as const];
  });
  if (entries.length === 0 || entries.reduce((sum, [, count]) => sum + count, 0) !== indirectCount) {
    throw new SavedGraphError('invalid-statistics');
  }
  return Object.fromEntries(entries);
}

/** mode별 limitation record를 검증한다. */
function validateLimitationsByMode(value: unknown): Readonly<Record<DispatchMode, readonly string[]>> {
  if (!isRecord(value)) throw new SavedGraphError('invalid-limitations');
  assertKeys(value, DISPATCH_MODES, 'invalid-limitations');
  if (!DISPATCH_MODES.every((mode) => value[mode] !== undefined)) throw new SavedGraphError('invalid-limitations');
  const result = Object.fromEntries(
    DISPATCH_MODES.map((mode) => [mode, validateLimitations(value[mode])]),
  ) as unknown as Readonly<Record<DispatchMode, readonly string[]>>;
  return result;
}

/** limitation 문자열 배열을 순서 그대로 보존하며 중복과 상한을 검사한다. */
function validateLimitations(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SAVED_GRAPH_LIMITATIONS) {
    throw new SavedGraphError('invalid-limitations');
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of value) {
    if (!safeString(line, MAX_LIMITATION_LENGTH) || seen.has(line)) throw new SavedGraphError('invalid-limitations');
    seen.add(line);
    result.push(line);
  }
  return result;
}

/** 옛 v1의 전역 limitation을 모든 mode에 보존하되 복원 불가능함을 명시한다. */
function fallbackLimitations(limitations: readonly string[]): Readonly<Record<DispatchMode, readonly string[]>> {
  const lines = limitations.includes(SAVED_GRAPH_MODE_LIMITATION)
    ? [...limitations]
    : [...limitations, SAVED_GRAPH_MODE_LIMITATION];
  const result = Object.fromEntries(
    DISPATCH_MODES.map((mode) => [mode, [...lines]]),
  ) as unknown as Readonly<Record<DispatchMode, readonly string[]>>;
  return result;
}

/** enum 문자열 배열의 정렬·중복·값을 검사한다. */
function validateEnumArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  code: SavedGraphErrorCode,
): T[] {
  if (!Array.isArray(value) || value.length > allowed.size) throw new SavedGraphError(code);
  const result: T[] = [];
  let previous: string | undefined;
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item as T)
      || previous !== undefined && compareStrings(previous, item) >= 0) throw new SavedGraphError(code);
    result.push(item as T);
    previous = item;
  }
  return result;
}

/** 간선의 저장 정렬 순서를 비교한다. */
function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return compareStrings(left.from, right.from) || compareStrings(left.to, right.to)
    || EDGE_EVIDENCE_ORDER.indexOf(left.evidence) - EDGE_EVIDENCE_ORDER.indexOf(right.evidence);
}

/** 객체가 닫힌 key 집합만 갖는지 검사한다. */
function assertKeys(value: Record<string, unknown>, allowed: readonly string[], code: SavedGraphErrorCode): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new SavedGraphError(code);
}

/** null/array가 아닌 JSON 객체인지 확인한다. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** graph node id의 기본 안전성과 길이를 확인한다. */
function validGraphId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_ID_LENGTH && isSafeIdentifier(value)
    && value.indexOf('#') > 0 && value.indexOf('#') < value.length - 1;
}

/** 프로젝트 상대 POSIX 경로인지 확인한다. */
function safeSourcePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH || !isSafeIdentifier(value)
    || value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/u.test(value)) return false;
  return value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

/** 안전한 길이 제한 문자열인지 확인한다. */
function safeString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length <= maximum && isSafeIdentifier(value);
}

/** POSIX·Windows에서 realpath가 낼 수 있는 절대 프로젝트 루트인지 확인한다. */
function absoluteProjectRoot(value: unknown): value is string {
  return safeString(value, MAX_PROVENANCE_LENGTH)
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\'));
}

/** 0 이상 안전 정수인지 확인한다. */
function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 1 이상 안전 정수인지 확인한다. */
function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

/** snapshot 생성 시각의 canonical UTC 형식인지 확인한다. */
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/** 저장 그래프 오류를 경로·원문 없는 해결 문구로 바꾼다. */
function savedGraphMessage(code: SavedGraphErrorCode): string {
  switch (code) {
    case 'too-large': return `the saved graph exceeds ${MAX_SAVED_GRAPH_BYTES} bytes; produce a smaller graph snapshot.`;
    case 'invalid-json': return 'the saved graph is not valid JSON; regenerate it with tsograph graph.';
    case 'too-deep': return `the saved graph exceeds the ${MAX_JSON_DEPTH}-level JSON depth limit; regenerate it with tsograph graph.`;
    case 'too-many-values': return 'the saved graph exceeds the bounded JSON value limit; produce a smaller graph snapshot.';
    case 'duplicate-key': return 'the saved graph contains a duplicate JSON key; regenerate it with tsograph graph.';
    case 'invalid-schema': return 'the saved graph does not match tsograph-graph version 1; regenerate it with tsograph graph.';
    case 'invalid-provenance': return 'the saved graph has invalid tool, timestamp, platform, project, or source revision provenance.';
    case 'invalid-node': return 'the saved graph contains an invalid or unsorted graph node.';
    case 'duplicate-node': return 'the saved graph contains a duplicate graph node id.';
    case 'invalid-edge': return 'the saved graph contains an invalid or unsorted graph edge.';
    case 'missing-endpoint': return 'the saved graph contains an edge endpoint that is not a declared graph node.';
    case 'duplicate-edge': return 'the saved graph contains a duplicate graph edge.';
    case 'invalid-statistics': return 'the saved graph contains invalid graph statistics or counts.';
    case 'invalid-limitations': return 'the saved graph contains invalid, duplicate, or excessive limitations.';
    case 'revision-mismatch': return 'the saved graph graphRevision does not match its nodes and edges; regenerate the snapshot.';
  }
}

/** JSON.parse 전에 깊이·값 수·중복 key를 제한한다. */
class JsonLimitsScanner {
  #index = 0;
  #values = 0;
  private readonly text: string;

  constructor(text: string) { this.text = text; }

  scan(): void {
    try {
      this.value(0);
      this.space();
      if (this.#index !== this.text.length) throw new SavedGraphError('invalid-json');
    } catch (error) {
      if (error instanceof SavedGraphError) throw error;
      throw new SavedGraphError('invalid-json');
    }
  }

  private value(depth: number): void {
    if (depth > MAX_JSON_DEPTH) throw new SavedGraphError('too-deep');
    if (++this.#values > MAX_SAVED_GRAPH_JSON_VALUES) throw new SavedGraphError('too-many-values');
    this.space();
    const token = this.text[this.#index];
    if (token === '{') { this.object(depth); return; }
    if (token === '[') { this.array(depth); return; }
    if (token === '"') { this.string(); return; }
    if (token === 't') { this.literal('true'); return; }
    if (token === 'f') { this.literal('false'); return; }
    if (token === 'n') { this.literal('null'); return; }
    if (token !== undefined && /[-0-9]/u.test(token)) { this.number(); return; }
    throw new SavedGraphError('invalid-json');
  }

  private object(depth: number): void {
    this.#index++;
    this.space();
    const keys = new Set<string>();
    if (this.text[this.#index] === '}') { this.#index++; return; }
    while (true) {
      this.space();
      if (this.text[this.#index] !== '"') throw new SavedGraphError('invalid-json');
      const key = this.stringValue();
      if (keys.has(key)) throw new SavedGraphError('duplicate-key');
      keys.add(key);
      this.space();
      if (this.text[this.#index++] !== ':') throw new SavedGraphError('invalid-json');
      this.value(depth + 1);
      this.space();
      const token = this.text[this.#index++];
      if (token === '}') return;
      if (token !== ',') throw new SavedGraphError('invalid-json');
    }
  }

  private array(depth: number): void {
    this.#index++;
    this.space();
    if (this.text[this.#index] === ']') { this.#index++; return; }
    while (true) {
      this.value(depth + 1);
      this.space();
      const token = this.text[this.#index++];
      if (token === ']') return;
      if (token !== ',') throw new SavedGraphError('invalid-json');
    }
  }

  private stringValue(): string {
    const start = this.#index;
    this.string();
    try {
      const value = JSON.parse(this.text.slice(start, this.#index)) as unknown;
      if (typeof value !== 'string') throw new Error();
      return value;
    } catch { throw new SavedGraphError('invalid-json'); }
  }

  private string(): void {
    if (this.text[this.#index++] !== '"') throw new SavedGraphError('invalid-json');
    while (this.#index < this.text.length) {
      const char = this.text[this.#index++];
      if (char === '"') return;
      if (char === '\\') {
        const escape = this.text[this.#index++];
        if (escape === 'u') {
          for (let offset = 0; offset < 4; offset++) {
            if (!isHexDigit(this.text[this.#index + offset])) throw new SavedGraphError('invalid-json');
          }
          this.#index += 4;
        } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          throw new SavedGraphError('invalid-json');
        }
      } else if (char !== undefined && char < ' ') throw new SavedGraphError('invalid-json');
    }
    throw new SavedGraphError('invalid-json');
  }

  private number(): void {
    const end = scanJsonNumberToken(this.text, this.#index);
    if (end === undefined) throw new SavedGraphError('invalid-json');
    this.#index = end;
  }

  private literal(value: string): void {
    if (this.text.slice(this.#index, this.#index + value.length) !== value) throw new SavedGraphError('invalid-json');
    this.#index += value.length;
  }

  private space(): void {
    while (/\s/u.test(this.text[this.#index] ?? '')) this.#index++;
  }
}

/** `\u` escape의 고정 네 자리를 검사한다. */
function isHexDigit(value: string | undefined): boolean {
  return value !== undefined && /[0-9A-Fa-f]/u.test(value);
}
