/** 저장 그래프의 JSON/NDJSON을 전체 문서 문자열 없이 순서대로 내보낸다. */
import { compareStrings } from '../exchange/sorted-json.ts';
import type { GraphSnapshotDocument } from './graph-document.ts';

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

/** 스냅샷 배열을 복사하거나 stringify하지 않고 JSON token 또는 한 줄씩 생성한다. */
export function* graphOutputChunks(document: GraphSnapshotDocument, format: GraphOutputFormat): Generator<string> {
  if (format === 'json') {
    yield* readableValue(document, 0);
    yield '\n';
    return;
  }
  const { nodes, edges, ...header } = document;
  yield compactSorted({ ...header, format: 'tsograph-graph-ndjson', record: 'header', nodeCount: nodes.length, edgeCount: edges.length }) + '\n';
  for (const node of nodes) yield compactSorted({ record: 'node', node }) + '\n';
  for (const edge of edges) yield compactSorted({ record: 'edge', edge }) + '\n';
}

/** 작은 출력 조각만 모으며 backpressure와 쓰기 실패를 호출자에게 돌려준다. */
export async function writeGraphOutput(document: GraphSnapshotDocument, format: GraphOutputFormat, sink: GraphOutputSink): Promise<void> {
  let pending = '';
  for (const chunk of graphOutputChunks(document, format)) {
    if (pending.length + chunk.length > 64 * 1024 && pending !== '') {
      await writeChunk(sink, pending);
      pending = '';
    }
    pending += chunk;
  }
  if (pending !== '') await writeChunk(sink, pending);
}

/** 생성기 오류는 바깥으로 전파하고 쓰기 경계의 오류만 명시 타입으로 감싼다. */
async function writeChunk(sink: GraphOutputSink, chunk: string): Promise<void> {
  try { await sink(chunk); }
  catch (error) { throw new GraphOutputWriteError(error); }
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

/** NDJSON은 한 행만 정렬·문자열화하고 그래프 전체를 행에 담지 않는다. */
function compactSorted(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item === null || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => compareStrings(a, b)).map(([key, child]) => [key, sort(child)]));
  };
  return JSON.stringify(sort(value));
}
