/** 전체 문서 문자열 없이 그래프 행을 내보내는 계약을 검증한다. */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { BridgeLocation } from '../exchange/bridge-facts.ts';
import { encodeSortedJson } from '../exchange/sorted-json.ts';
import { createGraphSnapshot } from './graph-document.ts';
import type { CallGraph, GraphEdge, GraphNode, UnresolvedCallCounts } from './graph-model.ts';
import { graphOutputChunks, writeGraphOutput, GraphOutputWriteError } from './graph-output.ts';

const graph: CallGraph = {
  nodes: [{ id: 'src/a.ts#load', kind: 'function', location: { path: 'src/a.ts', line: 1, column: 1 } }],
  edges: [], limitations: ['limited'], limitationsByMode: { direct: ['direct-limit'], bound: [], candidates: [] },
  statistics: { files: 1, calls: { resolved: 0, external: 0, missingDependencies: 0,
    unresolved: { parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 },
    dispatch: { bound: 0, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 } } },
};
const document = createGraphSnapshot(graph, { project: 'demo', toolVersion: '1.0.0', generatedAt: new Date('2026-01-01T00:00:00Z'), revision: undefined });

test('streamed JSON preserves readable sorted snapshot bytes', () => {
  assert.equal([...graphOutputChunks(document, 'json')].join(''), encodeSortedJson(document));
});

test('NDJSON has header and independent node and edge records', () => {
  const withEdge = { ...document, edges: [{ from: graph.nodes[0]!.id, to: graph.nodes[0]!.id, kinds: ['call' as const], evidence: 'direct' as const }] };
  const records = [...graphOutputChunks(withEdge, 'ndjson')].map((line) => JSON.parse(line));
  assert.equal(records[0].format, 'tsograph-graph-ndjson');
  assert.equal(records[0].nodeCount, 1);
  assert.equal(records[0].edgeCount, 1);
  assert.equal(records[0].nodes, undefined);
  assert.deepEqual(records[1], { record: 'node', node: graph.nodes[0] });
  assert.deepEqual(records[2], { record: 'edge', edge: withEdge.edges[0] });
});

test('writer awaits each chunk and propagates output failures', async () => {
  let active = false;
  const chunks: string[] = [];
  await writeGraphOutput(document, 'json', async (chunk) => {
    assert.equal(active, false); active = true;
    await Promise.resolve(); chunks.push(chunk); active = false;
  });
  assert.equal(chunks.join(''), encodeSortedJson(document));
  const failure = new Error('sink closed');
  await assert.rejects(writeGraphOutput(document, 'json', async () => { throw failure; }),
    (error: unknown) => error instanceof GraphOutputWriteError && error.cause === failure);
});

test('serialization defects are not classified as destination failures', async () => {
  const invalid = { ...document, statistics: { ...document.statistics, files: 1n } } as unknown as typeof document;
  await assert.rejects(writeGraphOutput(invalid, 'json', async () => {}),
    (error: unknown) => error instanceof TypeError && !(error instanceof GraphOutputWriteError));
});

test('records are lazy and the document arrays are never serialized together', () => {
  let accessed = 0;
  const nodes = new Proxy(document.nodes, { get(target, name, receiver) {
    if (name === '0') accessed++;
    if (name === 'toJSON') throw new Error('whole array serialization');
    return Reflect.get(target, name, receiver);
  } });
  const iterator = graphOutputChunks({ ...document, nodes }, 'json');
  iterator.next();
  assert.equal(accessed, 0);
  const output = [...iterator].join('');
  assert.ok(output.includes('src/a.ts#load'));
  assert.equal(accessed, 1);
});

test('streamed graph can exceed the exchange String limit using bounded writes', async () => {
  const nodes = Array.from({ length: 9000 }, (_, index) => ({ ...graph.nodes[0]!, id: `src/a.ts#${index}-${'x'.repeat(2048)}` }));
  let bytes = 0;
  let largest = 0;
  await writeGraphOutput({ ...document, nodes }, 'json', async (chunk) => {
    bytes += Buffer.byteLength(chunk); largest = Math.max(largest, chunk.length);
  });
  assert.ok(bytes > 16 * 1024 * 1024);
  assert.ok(largest <= 64 * 1024);
});

/** 모든 선택 필드를 채운 노드다. 노드·위치·계수 타입에 필드가 늘면 타입 검사가 이 표본도 늘리게 한다. */
const fullNode = {
  entries: ['page', 'route-handler'],
  id: 'src/a "b"\\c.ts#run\u2028😀',
  kind: 'method',
  location: { column: 7, line: 12, path: 'src/a "b"\\c.ts' } satisfies Required<BridgeLocation>,
  unresolvedCalls: { direct: 3, bound: 2, candidates: 1 } satisfies Required<UnresolvedCallCounts>,
} satisfies Required<GraphNode>;
/** 모든 필드를 채운 간선이다. */
const fullEdge = { evidence: 'bound', from: fullNode.id, kinds: ['call', 'reference'], to: 'src/a.ts#load' } satisfies Required<GraphEdge>;
/** 선택 필드가 없거나 비었거나 일부만 찬 노드다. */
const partialNodes: GraphNode[] = [
  { id: 'src/a.ts#bare', kind: 'function', location: { path: 'src/a.ts', line: 1, column: 1 } },
  { id: 'src/a.ts#empty', kind: 'class', location: { path: 'src/a.ts', line: 2, column: 3 }, entries: [], unresolvedCalls: {} },
  { id: 'src/a.ts#some', kind: 'export', location: { path: 'src/a.ts', line: 4, column: 5 }, unresolvedCalls: { direct: 1 } },
];
/** 노드·간선 레코드 표본을 담은 문서다. */
const recordSample = { ...document, nodes: [fullNode, ...partialNodes], edges: [fullEdge, { from: 'a', to: 'b', kinds: ['call'], evidence: 'direct' }] } satisfies typeof document;

test('fixed-order node and edge records match the generic sorted JSON bytes', () => {
  assert.equal([...graphOutputChunks(recordSample, 'json')].join(''), encodeSortedJson(recordSample));
  const compact = (value: unknown): string => `${JSON.stringify(JSON.parse(encodeSortedJson(value)))}\n`;
  assert.deepEqual([...graphOutputChunks(recordSample, 'ndjson')].slice(1), [
    ...recordSample.nodes.map((node) => compact({ record: 'node', node })),
    ...recordSample.edges.map((edge) => compact({ record: 'edge', edge })),
  ]);
});

test('node and edge records are serialized without enumerating or sorting their keys', () => {
  let enumerations = 0;
  const watched = <T extends object>(value: T): T => new Proxy(value, {
    ownKeys(target) {
      enumerations++;
      return Reflect.ownKeys(target);
    },
  });
  const proxied = { ...recordSample, nodes: recordSample.nodes.map(watched), edges: recordSample.edges.map(watched) };
  for (const format of ['json', 'ndjson'] as const) {
    assert.equal([...graphOutputChunks(proxied, format)].join(''), [...graphOutputChunks(recordSample, format)].join(''));
  }
  assert.equal(enumerations, 0);
});

test('JSON output yields one chunk per node and edge record', () => {
  const chunks = (count: number): number => [...graphOutputChunks({
    ...document,
    nodes: Array.from({ length: count }, (_, index) => ({ ...fullNode, id: `n${index}` })),
    edges: Array.from({ length: count }, (_, index) => ({ ...fullEdge, from: `n${index}` })),
  }, 'json')].length;
  // 레코드가 는 만큼만 조각이 는다(토큰 단위로 내면 레코드마다 조각 수십 개).
  assert.equal(chunks(20) - chunks(10), 20);
});

test('records longer than one write are split without breaking surrogate pairs', async () => {
  // 앞 글자 수의 홀짝이 다른 두 노드라 어느 형식에서든 한쪽은 16K 경계가 surrogate pair 가운데에 걸린다.
  const large = { ...document, nodes: [{ ...fullNode, id: '😀'.repeat(12_000) }, { ...fullNode, id: `x${'😀'.repeat(12_000)}` }] };
  for (const format of ['json', 'ndjson'] as const) {
    const writes: string[] = [];
    await writeGraphOutput(large, format, async (chunk) => {
      writes.push(chunk);
    });
    for (const chunk of writes) {
      const last = chunk.charCodeAt(chunk.length - 1);
      assert.ok(Buffer.byteLength(chunk) <= 64 * 1024 && !(last >= 0xd800 && last <= 0xdbff), format);
    }
    assert.ok(writes.length > 4, format);
    assert.equal(writes.join(''), [...graphOutputChunks(large, format)].join(''));
  }
  assert.equal([...graphOutputChunks(large, 'json')].join(''), encodeSortedJson(large));
});

test('oversized Unicode tokens and NDJSON records use bounded UTF-8 writes without corruption', async () => {
  const large = { ...document, limitations: ['가'.repeat(65_535) + '😀'.repeat(20_000)] };
  for (const format of ['json', 'ndjson'] as const) {
    const writes: Buffer[] = [];
    await writeGraphOutput(large, format, async (chunk) => {
      const bytes = Buffer.from(chunk, 'utf8');
      assert.ok(bytes.length <= 64 * 1024);
      writes.push(bytes);
    });
    assert.equal(Buffer.concat(writes).toString('utf8'), [...graphOutputChunks(large, format)].join(''));
  }
});
