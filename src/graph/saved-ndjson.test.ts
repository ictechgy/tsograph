/** 스트리밍 내보내기를 다시 읽을 때 truncation·변조를 숨기지 않는지 검증한다. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGraphSnapshot } from './graph-document.ts';
import { graphOutputChunks } from './graph-output.ts';
import type { CallGraph } from './graph-model.ts';
import { parseSavedGraphInput, SavedGraphError } from './saved-graph.ts';

const graph: CallGraph = {
  nodes: [
    { id: 'a.ts#one', kind: 'function', location: { path: 'a.ts', line: 1, column: 1 } },
    { id: 'a.ts#two', kind: 'function', location: { path: 'a.ts', line: 2, column: 1 } },
  ],
  edges: [{ from: 'a.ts#one', to: 'a.ts#two', kinds: ['call'], evidence: 'direct' }],
  limitations: [], limitationsByMode: { direct: [], bound: [], candidates: [] },
  statistics: { files: 1, calls: { resolved: 1, external: 0, missingDependencies: 0,
    unresolved: { parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 },
    dispatch: { bound: 0, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 } } },
};
const snapshot = createGraphSnapshot(graph, { project: '/work/demo', toolVersion: '1.0.0',
  generatedAt: new Date('2026-10-11T00:00:00Z'), revision: undefined });
const lines = [...graphOutputChunks(snapshot, 'ndjson')].map((line) => line.trimEnd());

test('JSON and NDJSON restore identical graph and captured provenance', () => {
  const expected = parseSavedGraphInput(JSON.stringify(snapshot, null, 2));
  for (const text of [lines.join('\n'), lines.join('\r\n') + '\r\n', lines.join('\n') + '\n']) {
    assert.deepEqual(parseSavedGraphInput(text), expected);
  }
  assert.deepEqual(parseSavedGraphInput(JSON.stringify(snapshot)), expected);
});

test('an empty NDJSON snapshot is valid without a trailing newline', () => {
  const empty = createGraphSnapshot({ ...graph, nodes: [], edges: [] }, { project: '/empty', toolVersion: '1',
    generatedAt: new Date('2026-10-11T00:00:00Z'), revision: undefined });
  assert.deepEqual(parseSavedGraphInput([...graphOutputChunks(empty, 'ndjson')].join('').trim()).graph.nodes, []);
});

test('partial, extra, reordered, duplicate or malformed records fail closed', () => {
  const header = JSON.parse(lines[0]!);
  const variants = [
    lines.slice(0, -1), [lines[0]!], [...lines, lines[3]!],
    [lines[0]!, lines[3]!, lines[1]!, lines[2]!],
    [lines[0]!, lines[1]!, lines[1]!, lines[3]!],
    [lines[0]!, 'null'], [lines[0]!, '{}'], [lines[0]!, ''],
    [lines[0]!, '{"record":"node","record":"edge"}'],
    [JSON.stringify({ ...header, record: 'bad' }), ...lines.slice(1)],
    [JSON.stringify({ ...header, nodeCount: -1 }), ...lines.slice(1)],
    [JSON.stringify({ ...header, edgeCount: 2_000_001 }), ...lines.slice(1)],
    [JSON.stringify({ ...header, unexpected: true }), ...lines.slice(1)],
    [lines[0]!, JSON.stringify({ ...JSON.parse(lines[1]!), extra: true }), ...lines.slice(2)],
    [lines[0]!, ...lines.slice(1, 3), '{"record":"edge","edge":'],
    [lines[0]!, ...lines.slice(1, 3), JSON.stringify({ record: 'edge', edge: { ...graph.edges[0], to: 'missing.ts#x' } })],
    [lines[0]!.replace('"record":"header"', '"record":"header","record":"header"'), ...lines.slice(1)],
  ];
  for (const records of variants) {
    assert.throws(() => parseSavedGraphInput(records.join('\n')), SavedGraphError);
  }
});

test('NDJSON preserves content-hash checking', () => {
  const header = JSON.parse(lines[0]!);
  const text = [JSON.stringify({ ...header, graphRevision: 'sha256:' + '0'.repeat(64) }), ...lines.slice(1)].join('\n');
  assert.throws(() => parseSavedGraphInput(text), (error: unknown) => error instanceof SavedGraphError && error.code === 'revision-mismatch');
});

test('format detection rejects excessive nesting before allocating parsed JSON', () => {
  const original = JSON.parse;
  let calls = 0;
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => { if (args[0].length > 1000) calls++; return original(...args); };
  try {
    const nested = '['.repeat(50_000) + '0' + ']'.repeat(50_000);
    assert.throws(() => parseSavedGraphInput(nested),
      (error: unknown) => error instanceof SavedGraphError && error.code === 'too-deep');
    assert.equal(calls, 0);
    assert.throws(() => parseSavedGraphInput('{"format":"tsograph-graph-ndjson","extra":' + nested + '}\n'),
      (error: unknown) => error instanceof SavedGraphError && error.code === 'too-deep');
    assert.equal(calls, 0);
  } finally { JSON.parse = original; }
});
