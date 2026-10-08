/** 전체 문서 문자열 없이 그래프 행을 내보내는 계약을 검증한다. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeSortedJson } from '../exchange/sorted-json.ts';
import { createGraphSnapshot } from './graph-document.ts';
import type { CallGraph } from './graph-model.ts';
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
