import assert from 'node:assert/strict';
import { test } from 'node:test';

import { computeGraphRevision, createGraphSnapshot } from './graph-document.ts';
import type { CallGraph } from './graph-model.ts';
import {
  MAX_SAVED_GRAPH_EDGES,
  MAX_SAVED_GRAPH_JSON_VALUES,
  MAX_SAVED_GRAPH_LIMITATIONS,
  MAX_SAVED_GRAPH_NODES,
  SavedGraphError,
  parseSavedGraphSnapshot,
} from './saved-graph.ts';

const graph: CallGraph = {
  nodes: [
    { id: 'src/a.ts#a', kind: 'function', location: { path: 'src/a.ts', line: 1, column: 1 },
      entries: ['page'], unresolvedCalls: { direct: 2, bound: 1 } },
    { id: 'src/a.ts#b', kind: 'method', location: { path: 'src/a.ts', line: 2, column: 3 } },
  ],
  edges: [{ from: 'src/a.ts#a', to: 'src/a.ts#b', kinds: ['call'], evidence: 'direct' }],
  limitations: ['snapshot-wide: original graph limitation'],
  limitationsByMode: {
    direct: ['direct-only: original mode limitation'],
    bound: ['bound-only: original mode limitation'],
    candidates: ['candidate-only: original mode limitation'],
  },
  statistics: {
    files: 1,
    calls: {
      resolved: 1, external: 0, missingDependencies: 0,
      unresolved: { parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 },
      dispatch: { bound: 0, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 },
    },
  },
};

function snapshot(): Record<string, unknown> {
  return structuredClone(createGraphSnapshot(graph, {
    toolVersion: '1.2.3', generatedAt: new Date('2026-10-09T00:00:00.000Z'),
    project: '/work/project', revision: 'a'.repeat(40),
  })) as unknown as Record<string, unknown>;
}

function parse(document: Record<string, unknown>): ReturnType<typeof parseSavedGraphSnapshot> {
  return parseSavedGraphSnapshot(JSON.stringify(document));
}

function expectCode(source: string, code: SavedGraphError['code']): void {
  assert.throws(() => parseSavedGraphSnapshot(source),
    (error: unknown) => error instanceof SavedGraphError && error.code === code);
}

test('저장 그래프 parser는 v1 그래프와 provenance를 보존하고 원래 revision을 다시 검증한다', () => {
  const legacy = snapshot();
  delete legacy.limitationsByMode;
  const parsed = parse(legacy);
  assert.equal(parsed.project, '/work/project');
  assert.equal(parsed.revision, 'a'.repeat(40));
  assert.equal(parsed.toolVersion, '1.2.3');
  assert.equal(parsed.generatedAt, '2026-10-09T00:00:00.000Z');
  assert.equal(parsed.graphRevision, computeGraphRevision(parsed.graph));
  assert.deepEqual(parsed.graph.nodes, graph.nodes);
  assert.deepEqual(parsed.graph.edges, graph.edges);
  assert.deepEqual(parsed.graph.limitations, graph.limitations);
  for (const mode of ['direct', 'bound', 'candidates'] as const) {
    assert.deepEqual(parsed.graph.limitationsByMode[mode].slice(0, -1), graph.limitations);
    assert.match(parsed.graph.limitationsByMode[mode].at(-1)!, /^saved-graph-mode-limitations:/u);
  }
});

test('선택적인 limitationsByMode가 있으면 mode별 원문을 그대로 사용한다', () => {
  const document = snapshot();
  document.limitationsByMode = graph.limitationsByMode;
  const parsed = parse(document);
  assert.deepEqual(parsed.graph.limitationsByMode, graph.limitationsByMode);
  assert.ok(Object.values(parsed.graph.limitationsByMode).flat()
    .every((line) => !line.startsWith('saved-graph-mode-limitations:')));
});

test('schema, provenance, node, edge, statistics와 limitation을 닫힌 형태로 검증한다', () => {
  const cases: [SavedGraphError['code'], (document: any) => void][] = [
    ['invalid-schema', (document) => { document.extra = true; }],
    ['invalid-provenance', (document) => { document.generatedAt = 'yesterday'; }],
    ['invalid-provenance', (document) => { document.tool.extra = true; }],
    ['invalid-provenance', (document) => { document.project = 'relative/project'; }],
    ['invalid-node', (document) => { document.nodes[0].kind = 'namespace'; }],
    ['invalid-node', (document) => { document.nodes[0].location.path = '../a.ts'; }],
    ['invalid-node', (document) => { document.nodes[0].unresolvedCalls.candidates = 3; }],
    ['duplicate-node', (document) => { document.nodes.splice(1, 0, structuredClone(document.nodes[0])); }],
    ['invalid-edge', (document) => { document.edges[0].evidence = 'maybe'; }],
    ['missing-endpoint', (document) => { document.edges[0].to = 'src/a.ts#missing'; }],
    ['duplicate-edge', (document) => { document.edges.push(structuredClone(document.edges[0])); }],
    ['invalid-statistics', (document) => { document.statistics.calls.resolved = -1; }],
    ['invalid-limitations', (document) => { document.limitations = ['same', 'same']; }],
  ];
  for (const [code, mutate] of cases) {
    const document: any = snapshot();
    mutate(document);
    expectCode(JSON.stringify(document), code);
  }
});

test('중복 JSON key, 깊이, collection 상한과 graphRevision 불일치를 거부한다', () => {
  expectCode('{"format":"tsograph-graph","format":"tsograph-graph"}', 'duplicate-key');
  expectCode(`${'['.repeat(40)}0${']'.repeat(40)}`, 'too-deep');
  const excessive = snapshot();
  excessive.limitations = Array.from({ length: MAX_SAVED_GRAPH_LIMITATIONS + 1 }, (_, index) => `limit-${index}`);
  expectCode(JSON.stringify(excessive), 'invalid-limitations');
  const wrongRevision = snapshot();
  wrongRevision.graphRevision = `sha256:${'0'.repeat(64)}`;
  expectCode(JSON.stringify(wrongRevision), 'revision-mismatch');
});

test('lexical 오류와 provenance hash 형식을 정확한 오류 종류로 분류한다', () => {
  expectCode('{"bad":"\\u12G4"}', 'invalid-json');
  expectCode('{"bad":"\\u123"}', 'invalid-json');
  const malformedRevision = snapshot();
  malformedRevision.graphRevision = 'sha256:not-a-digest';
  expectCode(JSON.stringify(malformedRevision), 'invalid-provenance');
});

test('source 위치는 Windows drive 표기도 프로젝트 상대 경로로 받지 않는다', () => {
  const document: any = snapshot();
  document.nodes[0].id = 'C:/src/a.ts#a';
  document.nodes[0].location.path = 'C:/src/a.ts';
  document.nodes[1].id = 'C:/src/a.ts#b';
  document.nodes[1].location.path = 'C:/src/a.ts';
  document.edges[0].from = document.nodes[0].id;
  document.edges[0].to = document.nodes[1].id;
  document.graphRevision = computeGraphRevision({
    ...graph,
    nodes: document.nodes,
    edges: document.edges,
  });
  expectCode(JSON.stringify(document), 'invalid-node');
});

test('JSON value 예산은 node·edge collection 상한의 최악 schema를 수용한다', () => {
  const minimum = MAX_SAVED_GRAPH_NODES * 20
    + MAX_SAVED_GRAPH_EDGES * 13
    + MAX_SAVED_GRAPH_LIMITATIONS * 4;
  assert.ok(MAX_SAVED_GRAPH_JSON_VALUES >= minimum);
});

test('선택적인 indirectSites 통계는 닫힌 양수 map이며 raw indirect 합계와 같다', () => {
  const document: any = snapshot();
  document.statistics.calls.unresolved.indirect = 3;
  document.statistics.calls.indirectSites = { identifier: 1, property: 1, element: 1 };
  const parsed = parse(document);
  assert.deepEqual(parsed.graph.statistics.calls.indirectSites,
    { identifier: 1, property: 1, element: 1 });

  for (const sites of [
    {},
    { identifier: 0 },
    { identifier: 4 },
    { framework: 3 },
  ]) {
    const invalid: any = snapshot();
    invalid.statistics.calls.unresolved.indirect = 3;
    invalid.statistics.calls.indirectSites = sites;
    expectCode(JSON.stringify(invalid), 'invalid-statistics');
  }
});
