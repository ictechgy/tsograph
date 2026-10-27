import assert from 'node:assert/strict';
import { closeSync, constants, mkdtempSync, openSync, realpathSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createGraphSnapshot } from '../graph/graph-document.ts';
import type { CallGraph } from '../graph/graph-model.ts';
import { graphOutputChunks } from '../graph/graph-output.ts';
import { MAX_SAVED_GRAPH_BYTES, SAVED_GRAPH_STREAM_LIMITS } from '../graph/saved-graph.ts';
import { createNodeFileSystem } from './file-system.ts';
import { runImpactCommand, runReachCommand } from './graph-command.ts';

/** 파일 전체를 문자열로 만들지 않고 실제128MiB 초과 유효 NDJSON을 작성한다. */
test('큰 저장 NDJSON의 실제 reach/impact는 소스 재빌드 없이 입력 제한 안에서 동작한다', {
  skip: !constants.O_NOFOLLOW || !constants.O_NONBLOCK,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-large-saved-')));
  try {
    const nodes: CallGraph['nodes'] = Array.from({ length: 2049 }, (_, index) => ({
      id: `a.ts#f${String(index).padStart(4, '0')}`, kind: 'function',
      location: { path: 'a.ts', line: index + 1, column: 1 },
    }));
    const graph: CallGraph = { nodes,
      edges: [{ from: nodes[0]!.id, to: nodes[1]!.id, kinds: ['call'], evidence: 'direct' }],
      limitations: ['analysis-partial: synthetic retained limitation'],
      limitationsByMode: { direct: ['direct: retained'], bound: ['bound: retained'], candidates: ['candidates: retained'] },
      statistics: { files: 1, calls: { resolved: 1, external: 0, missingDependencies: 0,
        unresolved: { parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 },
        dispatch: { bound: 0, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 } } },
    };
    const now = new Date('2026-10-26T00:00:00.000Z');
    const document = createGraphSnapshot(graph, { toolVersion: '0.11.0', generatedAt: now, project: '/source/not-present', revision: undefined });
    const path = join(root, 'large.ndjson');
    const handle = openSync(path, 'w');
    try {
      const padding = Buffer.alloc(64 * 1024, 32);
      let first = true;
      for (const line of graphOutputChunks(document, 'ndjson')) {
        if (!first) writeSync(handle, padding);
        writeSync(handle, line);
        first = false;
      }
    } finally { closeSync(handle); }
    assert.ok(statSync(path).size > MAX_SAVED_GRAPH_BYTES);
    const environment = { fileSystem: createNodeFileSystem(), toolVersion: '0.11.0', now: () => now,
      buildGraph: async (): Promise<CallGraph> => { throw new Error('saved input must not build sources'); } };
    const reached = await runReachCommand(['--graph-file', path, nodes[0]!.id], environment);
    assert.equal(reached.exitCode, 0, reached.standardError);
    const reach = JSON.parse(reached.standardOutput);
    assert.deepEqual(reach.reached.map((row: { symbol: { usr: string } }) => row.symbol.usr), [nodes[1]!.id]);
    assert.equal(reach.graphRevision, document.graphRevision);
    assert.ok(reach.limitations.includes('bound: retained'));
    const impacted = await runImpactCommand(['--graph-file', path, nodes[1]!.id], environment);
    assert.equal(impacted.exitCode, 0, impacted.standardError);
    assert.deepEqual(JSON.parse(impacted.standardOutput).reached.map((row: { symbol: { usr: string } }) => row.symbol.usr), [nodes[0]!.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('큰 custom stream은 metadata 경로를 읽지 않고 EOF 뒤 오류·손상도 stdout 없이 실패한다', async () => {
  const now = new Date('2026-10-26T00:00:00.000Z');
  const graph: CallGraph = { nodes: [{ id: 'a.ts#root', kind: 'function', location: { path: 'a.ts', line: 1, column: 1 } }], edges: [],
    limitations: ['analysis-partial: retained'], limitationsByMode: { direct: ['partial: direct'], bound: ['partial: bound'], candidates: ['partial: candidates'] },
    statistics: { files: 1, calls: { resolved: 0, external: 0, missingDependencies: 0,
      unresolved: { parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 },
      dispatch: { bound: 0, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 } } } };
  const document = createGraphSnapshot(graph, { toolVersion: '0.11.0', generatedAt: now, project: '/metadata/never-read', revision: undefined });
  const text = [...graphOutputChunks(document, 'ndjson')].join('');
  let builds = 0, closed = 0;
  const paths: string[] = [];
  const environment = (mode: 'valid' | 'late-read' | 'invalid-utf8' | 'truncated' | 'json' | 'too-large') => ({
    toolVersion: '0.11.0', now: () => now,
    buildGraph: async (): Promise<CallGraph> => { builds++; throw new Error('must not build'); },
    fileSystem: {
      realPath: async (path: string) => { paths.push(path); assert.equal(path, 'snapshot.ndjson'); return '/virtual/snapshot.ndjson'; },
      status: async (path: string) => { paths.push(path); assert.equal(path, '/virtual/snapshot.ndjson'); return { kind: 'file' as const,
        size: mode === 'too-large' ? SAVED_GRAPH_STREAM_LIMITS.bytes + 1 : MAX_SAVED_GRAPH_BYTES + 1, modifiedAt: now }; },
      readBytes: async (): Promise<Uint8Array> => { throw new Error('large input must never use readBytes'); },
      listDirectory: async (): Promise<[]> => { throw new Error('must not list metadata directories'); },
      readChunks: async function* (path: string, limit: number): AsyncGenerator<Uint8Array> {
        paths.push(path); assert.equal(path, '/virtual/snapshot.ndjson'); assert.equal(limit, SAVED_GRAPH_STREAM_LIMITS.bytes);
        try {
          if (mode === 'invalid-utf8') yield new Uint8Array([0xff]);
          else yield Buffer.from(mode === 'truncated' ? text.slice(0, -8) : mode === 'json' ? JSON.stringify(document) : text);
          if (mode === 'late-read') throw new Error('SYNTHETIC_PRIVATE_INPUT');
        } finally { closed++; }
      },
    },
  });
  const valid = await runReachCommand(['--graph-file', 'snapshot.ndjson', 'a.ts#root'], environment('valid'));
  assert.equal(valid.exitCode, 0, valid.standardError);
  assert.equal(JSON.parse(valid.standardOutput).project, '/metadata/never-read');
  assert.ok(JSON.parse(valid.standardOutput).limitations.includes('partial: bound'));
  for (const mode of ['late-read', 'invalid-utf8', 'truncated', 'json', 'too-large'] as const) {
    const result = await runReachCommand(['--graph-file', 'snapshot.ndjson', 'a.ts#root'], environment(mode));
    assert.equal(result.exitCode, 2, mode); assert.equal(result.standardOutput, '', mode);
    assert.doesNotMatch(result.standardError, /SYNTHETIC_PRIVATE_INPUT|\/virtual|\/metadata/u);
  }
  assert.equal(builds, 0); assert.equal(closed, 5);
  assert.ok(paths.every(path => path === 'snapshot.ndjson' || path === '/virtual/snapshot.ndjson'));
});
