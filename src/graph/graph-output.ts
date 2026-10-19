/** 저장 그래프의 JSON/NDJSON을 전체 문서 문자열 없이 순서대로 내보낸다. */
import type { BridgeLocation } from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import type { GraphSnapshotDocument } from './graph-document.ts';
import type { DispatchMode, GraphEdge, GraphNode, UnresolvedCallCounts } from './graph-model.ts';

/** 그래프 전용 형식이며 bridge-facts의 크기 계약은 바꾸지 않는다. */
export type GraphOutputFormat = 'json' | 'ndjson';

/** 한 write가 끝날 때까지 다음 조각을 만들지 않는 출력 경계다. */
export type GraphOutputSink = (chunk: string) => Promise<void>;

/** 목적지 오류만 구분해 직렬화 결함을 잘못된 입력으로 숨기지 않는다. */
export class GraphOutputWriteError extends Error {
  constructor(cause: unknown) {
    super('graph output could not be written', { cause });
    this.name = 'GraphOutputWriteError';
  }
}

/** write 하나에 담는 UTF-16 문자 수 상한이다(한 단위가 UTF-8 최대 3 byte라 64 KiB 아래다). */
const WRITE_CHARS = 16 * 1024;

/** 스냅샷 배열을 복사하거나 stringify하지 않고 JSON 조각(레코드는 하나씩) 또는 한 줄씩 생성한다. */
export function* graphOutputChunks(document: GraphSnapshotDocument, format: GraphOutputFormat): Generator<string> {
  if (format === 'json') {
    yield* readableDocument(document);
    yield '\n';
    return;
  }
  const { nodes, edges, ...header } = document;
  yield compactSorted({ ...header, format: 'tsograph-graph-ndjson', record: 'header', nodeCount: nodes.length, edgeCount: edges.length }) + '\n';
  for (const node of nodes) yield `{"node":${nodeText(node, COMPACT)},"record":"node"}\n`;
  for (const edge of edges) yield `{"edge":${edgeText(edge, COMPACT)},"record":"edge"}\n`;
}

/** 작은 출력 조각만 모으며 backpressure와 쓰기 실패를 호출자에게 돌려준다. */
export async function writeGraphOutput(document: GraphSnapshotDocument, format: GraphOutputFormat, sink: GraphOutputSink): Promise<void> {
  let pending = '';
  for (const chunk of graphOutputChunks(document, format)) {
    // 보수적 문자 예산으로 각 write를 64 KiB 아래에 묶는다. 예산보다 짧은 조각(레코드 대부분)은 나누지 않아
    // 조각마다 분할 generator를 만들지 않는다.
    for (const part of chunk.length > WRITE_CHARS ? boundedStringParts(chunk) : [chunk]) {
      if (pending.length + part.length > WRITE_CHARS && pending !== '') {
        await writeChunk(sink, pending);
        pending = '';
      }
      pending += part;
    }
  }
  if (pending !== '') await writeChunk(sink, pending);
}

/** 긴 문자열 token·NDJSON 행을 surrogate pair를 자르지 않는 조각으로 나눈다. */
function* boundedStringParts(value: string): Generator<string> {
  for (let start = 0; start < value.length;) {
    let end = Math.min(start + WRITE_CHARS, value.length);
    const last = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    yield value.slice(start, end);
    start = end;
  }
}

/** 생성기 오류는 바깥으로 전파하고 쓰기 경계의 오류만 명시 타입으로 감싼다. */
async function writeChunk(sink: GraphOutputSink, chunk: string): Promise<void> {
  try { await sink(chunk); }
  catch (error) { throw new GraphOutputWriteError(error); }
}

/**
 * 스냅샷 문서를 정렬 JSON(두 칸 들여쓰기)으로 낸다. 최상위 `nodes`·`edges` 배열은 레코드 하나를 한 조각으로 내고,
 * 나머지 값은 범용 순회로 낸다(레코드마다 토큰 단위 중첩 generator를 거치지 않게 한다).
 */
function* readableDocument(document: GraphSnapshotDocument): Generator<string> {
  const object = document as unknown as Readonly<Record<string, unknown>>;
  const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort(compareStrings);
  yield '{';
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!;
    yield (index === 0 ? '\n' : ',\n') + '  ' + JSON.stringify(key) + ': ';
    if (key === 'nodes') yield* readableRecords(document.nodes, nodeText);
    else if (key === 'edges') yield* readableRecords(document.edges, edgeText);
    else yield* readableValue(object[key], 1);
  }
  yield '\n}';
}

/** 최상위 레코드 배열(깊이 1)을 원소 하나씩 정렬 JSON 들여쓰기로 낸다. */
function* readableRecords<T>(records: readonly T[], render: (record: T, layout: RecordLayout) => string): Generator<string> {
  if (records.length === 0) {
    yield '[]';
    return;
  }
  for (let index = 0; index < records.length; index++) yield (index === 0 ? '[\n    ' : ',\n    ') + render(records[index]!, READABLE);
  yield '\n  ]';
}

/** 제품 값의 알려진 깊이만 순회하고 기존 정렬 JSON의 들여쓰기를 보존한다. */
function* readableValue(value: unknown, depth: number): Generator<string> {
  if (Array.isArray(value)) {
    yield '[';
    for (let index = 0; index < value.length; index++) {
      yield (index === 0 ? '\n' : ',\n') + '  '.repeat(depth + 1);
      yield* readableValue(value[index], depth + 1);
    }
    if (value.length > 0) yield '\n' + '  '.repeat(depth);
    yield ']';
  } else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).filter((key) => object[key] !== undefined).sort(compareStrings);
    yield '{';
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      yield (index === 0 ? '\n' : ',\n') + '  '.repeat(depth + 1) + JSON.stringify(key) + ': ';
      yield* readableValue(object[key], depth + 1);
    }
    if (keys.length > 0) yield '\n' + '  '.repeat(depth);
    yield '}';
  } else {
    yield JSON.stringify(value) ?? 'null';
  }
}

/** NDJSON 머리는 한 행만 정렬·문자열화하고 그래프 전체를 행에 담지 않는다. */
function compactSorted(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item === null || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => compareStrings(a, b)).map(([key, child]) => [key, sort(child)]));
  };
  return JSON.stringify(sort(value));
}

/** 배열·객체 하나의 공백이다: 첫 원소 앞, 원소 사이, 닫는 괄호 앞. */
interface Spacing {
  readonly first: string;
  readonly between: string;
  readonly last: string;
}

/** 고정 키 순서 레코드의 공백 규칙이다(레코드 객체와 그 안의 배열·객체). */
interface RecordLayout {
  readonly colon: string;
  readonly record: Spacing;
  readonly inner: Spacing;
}

/** NDJSON 행이다(공백 없음, `JSON.stringify`와 같다). */
const COMPACT: RecordLayout = { colon: ':', record: { first: '', between: ',', last: '' }, inner: { first: '', between: ',', last: '' } };

/** JSON 문서의 `nodes`·`edges` 원소(깊이 2)다(`readableValue`와 같은 들여쓰기). */
const READABLE: RecordLayout = {
  colon: ': ',
  record: { first: '\n      ', between: ',\n      ', last: '\n    ' },
  inner: { first: '\n        ', between: ',\n        ', last: '\n      ' },
};

/** `unresolvedCalls` 키의 정렬 JSON 순서다(모드가 늘면 graph-output 테스트의 전 필드 표본이 바이트 차이로 알린다). */
const UNRESOLVED_KEYS = ['bound', 'candidates', 'direct'] as const satisfies readonly DispatchMode[];

/**
 * 노드를 정렬 JSON 키 순서(entries, id, kind, location, unresolvedCalls)로 직렬화한다. 레코드마다 키를 열거·정렬하던
 * 범용 경로 대신 정해진 필드를 바로 잇는다. 문자열만 `JSON.stringify`로 이스케이프하고, 정수 위치·계수는 그대로 쓴다
 * (`JSON.stringify`와 같은 표기다). 필드가 늘면 graph-output 테스트의 전 필드 표본이 타입 검사에서 멈춘다.
 *
 * @param node 노드
 * @param layout 공백 규칙
 * @returns JSON 텍스트
 */
function nodeText(node: GraphNode, layout: RecordLayout): string {
  const { colon, record } = layout;
  let text = '{' + record.first;
  if (node.entries !== undefined) text += `"entries"${colon}${stringsText(node.entries, layout.inner)}${record.between}`;
  text += `"id"${colon}${JSON.stringify(node.id)}${record.between}"kind"${colon}${JSON.stringify(node.kind)}`;
  text += `${record.between}"location"${colon}${locationText(node.location, layout)}`;
  if (node.unresolvedCalls !== undefined) text += `${record.between}"unresolvedCalls"${colon}${countsText(node.unresolvedCalls, layout)}`;
  return text + record.last + '}';
}

/**
 * 간선을 정렬 JSON 키 순서(evidence, from, kinds, to)로 직렬화한다.
 *
 * @param edge 간선
 * @param layout 공백 규칙
 * @returns JSON 텍스트
 */
function edgeText(edge: GraphEdge, layout: RecordLayout): string {
  const { colon, record } = layout;
  return `{${record.first}"evidence"${colon}${JSON.stringify(edge.evidence)}${record.between}"from"${colon}${JSON.stringify(edge.from)}`
    + `${record.between}"kinds"${colon}${stringsText(edge.kinds, layout.inner)}${record.between}"to"${colon}${JSON.stringify(edge.to)}${record.last}}`;
}

/**
 * 위치를 정렬 JSON 키 순서(column, line, path)로 직렬화한다.
 *
 * @param location 위치
 * @param layout 공백 규칙
 * @returns JSON 텍스트
 */
function locationText(location: BridgeLocation, layout: RecordLayout): string {
  const { colon, inner } = layout;
  return `{${inner.first}"column"${colon}${location.column}${inner.between}"line"${colon}${location.line}`
    + `${inner.between}"path"${colon}${JSON.stringify(location.path)}${inner.last}}`;
}

/**
 * 모드별 미해석 호출 수를 정렬 JSON 키 순서로 직렬화한다. 값이 없는 모드는 뺀다.
 *
 * @param counts 모드별 계수
 * @param layout 공백 규칙
 * @returns JSON 텍스트
 */
function countsText(counts: UnresolvedCallCounts, layout: RecordLayout): string {
  const { colon, inner } = layout;
  const parts: string[] = [];
  for (const mode of UNRESOLVED_KEYS) {
    const value = counts[mode];
    if (value !== undefined) parts.push(`${JSON.stringify(mode)}${colon}${value}`);
  }
  return parts.length === 0 ? '{}' : `{${inner.first}${parts.join(inner.between)}${inner.last}}`;
}

/**
 * 문자열 배열을 직렬화한다.
 *
 * @param values 문자열
 * @param spacing 공백
 * @returns JSON 텍스트
 */
function stringsText(values: readonly string[], spacing: Spacing): string {
  if (values.length === 0) return '[]';
  return `[${spacing.first}${values.map((value) => JSON.stringify(value)).join(spacing.between)}${spacing.last}]`;
}
