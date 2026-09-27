import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { CallGraph } from '../graph/graph-model.ts';
import { createNodeFileSystem } from './file-system.ts';
import { type GraphEnvironment, graphUsage, impactUsage, reachUsage, render, runGraphCommand, runImpactCommand, runReachCommand } from './graph-command.ts';
import { runCli } from './run-cli.ts';

const fixture = realpathSync(fileURLToPath(new URL('../../fixtures/graph/next-prisma/', import.meta.url)));
const fixedNow = new Date('2026-09-27T00:00:00.000Z');

/**
 * 실행 환경을 만든다.
 *
 * @param overrides 바꿀 필드
 * @returns 실행 환경
 */
function environment(overrides: Partial<GraphEnvironment> = {}): GraphEnvironment {
  return { fileSystem: createNodeFileSystem(), toolVersion: '9.9.9', now: () => fixedNow, ...overrides };
}

/** 노드 셋·간선 둘의 작은 그래프다(주입용). */
const tinyGraph: CallGraph = {
  nodes: ['a.ts#a', 'a.ts#b', 'a.ts#page'].map((id) => ({
    id, kind: 'function', location: { path: 'a.ts', line: 1, column: 1 }, ...(id === 'a.ts#page' ? { entries: ['page' as const] } : {}),
  })),
  edges: [{ from: 'a.ts#a', to: 'a.ts#b', kinds: ['call'] }, { from: 'a.ts#page', to: 'a.ts#b', kinds: ['jsx'] }],
  limitations: ['unresolved-calls: 1 call(s) could not be linked to a project declaration and were not guessed (parameter: 1)', 'non-http-entries: 1 symbol(s) are entry points without a route-decl fact (page: 1); isthmus cannot reach them through the http join'],
  statistics: { files: 1, calls: { resolved: 2, external: 0, missingDependencies: 0, unresolved: { parameter: 1, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 } } },
};

test('--generated-at은 시각을 고정하고 잘못된 값은 64다', async () => {
  const env = environment({ now: () => new Date('2030-01-01T00:00:00.000Z'), buildGraph: async () => tinyGraph });
  const fixed = JSON.parse((await runReachCommand(['--project', '.', '--generated-at', '2026-01-02T03:04:05Z', 'a.ts#a'], env)).standardOutput);
  assert.equal(fixed.generatedAt, '2026-01-02T03:04:05.000Z');
  const snapshot = JSON.parse((await runGraphCommand(['--project', '.', '--generated-at', '2026-01-02T03:04:05.123Z'], env)).standardOutput);
  assert.equal(snapshot.generatedAt, '2026-01-02T03:04:05.123Z');
  for (const value of ['2026-02-30T00:00:00Z', 'yesterday', '2026-01-02T03:04:05+09:00']) {
    assert.equal((await runReachCommand(['--project', '.', '--generated-at', value, 'a.ts#a'], env)).exitCode, 64, value);
    assert.equal((await runGraphCommand(['--project', '.', '--generated-at', value], env)).exitCode, 64, value);
  }
  assert.equal((await runReachCommand(['--project', '.', '--max-depth', '129', 'a.ts#a'], env)).exitCode, 64);
  assert.equal((await runReachCommand(['--project', '.', '--max-reached', '100001', 'a.ts#a'], env)).exitCode, 64);
});

test('graph는 결정적인 스냅샷과 graphRevision을 낸다', async () => {
  const first = await runGraphCommand(['--project', fixture, '--format', 'json'], environment());
  assert.equal(first.exitCode, 0, first.standardError);
  const second = await runGraphCommand(['--project', fixture], environment());
  assert.equal(first.standardOutput, second.standardOutput);
  const document = JSON.parse(first.standardOutput);
  assert.equal(document.format, 'tsograph-graph');
  assert.equal(document.version, 1);
  assert.equal(document.platform, 'js');
  assert.equal(document.project, fixture);
  assert.equal(document.generatedAt, '2026-09-27T00:00:00.000Z');
  assert.match(document.graphRevision, /^sha256:[0-9a-f]{64}$/u);
  assert.ok(document.nodes.some((node: { id: string }) => node.id === 'src/lib/jobs.ts#listJobs'));
  assert.equal(document.revision, undefined);
});

test('reach는 language-traversal v1(dependencies)을 낸다', async () => {
  const result = await runReachCommand(['--project', fixture, 'src/app/api/jobs/route.ts#POST', 'src/app/api/health/route.ts#GET', 'src/app/api/jobs/route.ts#POST'], environment());
  assert.equal(result.exitCode, 0, result.standardError);
  const document = JSON.parse(result.standardOutput);
  assert.equal(document.format, 'language-traversal');
  assert.equal(document.version, 1);
  assert.deepEqual(document.tool, { name: 'tsograph', version: '9.9.9' });
  assert.equal(document.direction, 'dependencies');
  assert.equal(document.truncated, false);
  assert.equal(document.truncationReasons, undefined);
  assert.deepEqual(document.roots.map((root: { id: string }) => root.id), ['src/app/api/jobs/route.ts#POST', 'src/app/api/health/route.ts#GET']);
  assert.deepEqual(document.roots[0].symbol, { usr: 'src/app/api/jobs/route.ts#POST', qualifiedName: 'src/app/api/jobs/route.ts#POST' });
  const audit = document.reached.find((entry: { symbol: { usr: string } }) => entry.symbol.usr === 'src/lib/audit.ts#audit');
  assert.deepEqual(audit, {
    symbol: {
      usr: 'src/lib/audit.ts#audit', qualifiedName: 'src/lib/audit.ts#audit', kind: 'function',
      location: { path: 'src/lib/audit.ts', line: 3, column: 23 },
    },
    via: 'src/lib/jobs.ts#createJob', depth: 2, roots: [0], relationships: ['call'],
  });
  assert.ok(document.limitations.some((line: string) => line.startsWith('unresolved-calls:')));
  assert.ok(!document.limitations.some((line: string) => line.startsWith('non-http-entries:')));
});

test('impact는 dependents 방향이고 비HTTP 진입점을 이 문서 범위로 센다', async () => {
  const result = await runImpactCommand(['--project', fixture, '--max-depth', '2', 'src/lib/jobs.ts#createJob'], environment());
  const document = JSON.parse(result.standardOutput);
  assert.equal(document.direction, 'dependents');
  assert.deepEqual(document.reached.map((entry: { symbol: { usr: string }; depth: number }) => `${entry.depth} ${entry.symbol.usr}`), [
    '1 src/app/api/jobs/route.ts#POST',
    '1 src/app/jobs/actions.ts#createJobAction',
    '1 src/lib/index.ts#addJob',
    '2 src/app/api/jobs/route.ts#<module>',
    '2 src/app/jobs/page.tsx#JobsPage',
  ]);
  assert.equal(document.truncated, false);
  assert.deepEqual(document.limitations.filter((line: string) => line.startsWith('non-http-entries:')), [
    'non-http-entries: 2 symbol(s) are entry points without a route-decl fact (page: 1, server-action: 1); isthmus cannot reach them through the http join',
  ]);
  const cut = JSON.parse((await runImpactCommand(['--project', fixture, '--max-depth', '1', '--max-reached', '1', 'src/lib/jobs.ts#createJob'], environment())).standardOutput);
  assert.equal(cut.truncated, true);
  assert.deepEqual(cut.truncationReasons, ['depth', 'max-reached']);
});

test('root이기도 한 도우미는 다른 root 인덱스만 달고 reached에 나온다', async () => {
  const result = await runReachCommand(['--project', fixture, 'src/app/api/jobs/route.ts#POST', 'src/lib/jobs.ts#createJob'], environment());
  const document = JSON.parse(result.standardOutput);
  const byUsr = new Map(document.reached.map((entry: { symbol: { usr: string } }) => [entry.symbol.usr, entry]));
  assert.deepEqual(byUsr.get('src/lib/jobs.ts#createJob'), {
    symbol: { usr: 'src/lib/jobs.ts#createJob', qualifiedName: 'src/lib/jobs.ts#createJob', kind: 'function', location: { path: 'src/lib/jobs.ts', line: 8, column: 23 } },
    via: 'src/app/api/jobs/route.ts#POST', depth: 1, roots: [0], relationships: ['call'],
  });
  const audit = byUsr.get('src/lib/audit.ts#audit') as { via: string; depth: number; roots: number[] };
  assert.deepEqual([audit.via, audit.depth, audit.roots], ['src/lib/jobs.ts#createJob', 1, [0, 1]]);
  assert.ok(!byUsr.has('src/app/api/jobs/route.ts#POST'));
});

test('모르는 id는 64이고 목록을 알린다', async () => {
  const ids = Array.from({ length: 22 }, (_, index) => `x.ts#missing${index}`);
  const result = await runReachCommand(['--project', '.', ...ids, 'a.ts#a'], environment({ buildGraph: async () => tinyGraph }));
  assert.equal(result.exitCode, 64);
  assert.match(result.standardError, /22 unknown symbol id\(s\)/u);
  assert.match(result.standardError, /x\.ts#missing19\n {2}… and 2 more/u);
  assert.doesNotMatch(result.standardError, /a\.ts#a/u);
});

test('주입 그래프: root 밖 진입점은 세지 않고 그래프 limitation은 싣는다', async () => {
  const result = await runReachCommand(['--project', '.', 'a.ts#a'], environment({ buildGraph: async () => tinyGraph }));
  const document = JSON.parse(result.standardOutput);
  assert.deepEqual(document.limitations, [tinyGraph.limitations[0]]);
  const page = JSON.parse((await runReachCommand(['--project', '.', 'a.ts#page'], environment({ buildGraph: async () => tinyGraph }))).standardOutput);
  assert.deepEqual(page.limitations, tinyGraph.limitations);
});

test('잘못된 호출은 64, 읽을 수 없는 프로젝트·과대 출력은 2다', async () => {
  const env = environment({ buildGraph: async () => tinyGraph });
  const reachCases = [[], ['a.ts#a'], ['--project', '.'], ['--project', '.', '--format', 'yaml', 'a'], ['--project', '.', '--max-depth', '0', 'a'],
    ['--project', '.', '--max-reached', 'x', 'a'], ['--project', '.', 'bad\u0001id'], ['--bogus'],
    ['--project', '.', ...Array.from({ length: 10_001 }, (_, index) => `i${index}`)]];
  for (const args of reachCases) assert.equal((await runReachCommand(args, env)).exitCode, 64, JSON.stringify(args).slice(0, 80));
  for (const args of [[], ['x'], ['--project', '.', '--format', 'yaml'], ['--nope']]) {
    assert.equal((await runGraphCommand(args, env)).exitCode, 64, JSON.stringify(args));
  }
  assert.equal((await runGraphCommand(['--help'], env)).standardOutput, graphUsage);
  assert.equal((await runReachCommand(['--help'], env)).standardOutput, reachUsage);
  assert.equal((await runImpactCommand(['--help'], env)).standardOutput, impactUsage);
  const missing = await runGraphCommand(['--project', '/nonexistent/tsograph-graph'], env);
  assert.equal(missing.exitCode, 2);
  assert.doesNotMatch(missing.standardError, /nonexistent/u);
  assert.equal((await runReachCommand(['--project', fileURLToPath(import.meta.url), 'a'], env)).exitCode, 2);
  const unsafe = await runGraphCommand(['--project', '.'], environment({
    fileSystem: { ...createNodeFileSystem(), realPath: async () => '/tmp/a\u0085b', status: async () => ({ kind: 'directory', size: 0, modifiedAt: fixedNow }) },
  }));
  assert.equal(unsafe.exitCode, 2);
  const tooLong = render({ text: 'x'.repeat(100) }, 50);
  assert.equal(tooLong.exitCode, 2);
  assert.match(tooLong.standardError, /--max-depth/u);
});

test('분배기가 graph·reach·impact와 도움말을 안다', async () => {
  const env = environment({ buildGraph: async () => tinyGraph });
  assert.match((await runCli(['--help'], env)).standardOutput, /reach {8}Symbols reachable/u);
  assert.match((await runCli(['help', 'impact'], env)).standardOutput, /^Usage: tsograph impact/u);
  assert.equal((await runCli(['graph', '--project', '.'], env)).exitCode, 0);
  assert.equal((await runCli(['reach', '--project', '.', 'a.ts#a'], env)).exitCode, 0);
  assert.equal((await runCli(['impact', '--project', '.', 'a.ts#b'], env)).exitCode, 0);
});
