import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallGraph } from '../graph/graph-model.ts';
import { createTraversalDocument } from '../graph/traversal-document.ts';
import { createNodeFileSystem } from './file-system.ts';
import { type GraphEnvironment, graphUsage, impactUsage, reachUsage, render, runGraphCommand, runImpactCommand, runReachCommand } from './graph-command.ts';
import { runCli } from './run-cli.ts';

const fixture = realpathSync(fileURLToPath(new URL('../../fixtures/graph/next-prisma/', import.meta.url)));
const fixedNow = new Date('2026-09-27T00:00:00.000Z');

test('들여쓰기만 출력 상한을 넘으면 사실을 보존한 압축 JSON으로 출력한다', () => {
  const document = { z: [{ b: 2, a: 1 }, { b: 4, a: 3 }], a: '경로' };
  const result = render(document, 65);
  assert.equal(result.exitCode, 0, result.standardError);
  assert.deepEqual(JSON.parse(result.standardOutput), document);
  assert.ok(result.standardOutput.length <= 65);
  assert.ok(result.standardOutput.endsWith('\n'));
  assert.equal(render(document, 20).exitCode, 2);
});

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
  edges: [{ from: 'a.ts#a', to: 'a.ts#b', kinds: ['call'], evidence: 'direct' }, { from: 'a.ts#page', to: 'a.ts#b', kinds: ['jsx'], evidence: 'direct' }],
  limitations: ['unresolved-calls: 1 call(s) could not be linked to a project declaration and were not guessed (parameter: 1)', 'non-http-entries: 1 symbol(s) are entry points without a route-decl fact (page: 1); isthmus cannot reach them through the http join'],
  limitationsByMode: Object.fromEntries(['direct', 'bound', 'candidates'].map((mode) => [mode, [
    'unresolved-calls: 1 call(s) could not be linked to a project declaration and were not guessed (parameter: 1)',
    'non-http-entries: 1 symbol(s) are entry points without a route-decl fact (page: 1); isthmus cannot reach them through the http join',
  ]])) as unknown as CallGraph['limitationsByMode'],
  statistics: { files: 1, calls: { resolved: 2, external: 0, missingDependencies: 0, unresolved: { parameter: 1, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 }, dispatch: { bound: 0, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 } } },
};

test('graph streams JSON or NDJSON with backpressure and reports sink failures without leaking input', async () => {
  for (const format of ['json', 'ndjson']) {
    const chunks: string[] = [];
    const result = await runGraphCommand(['--project', '.', '--format', format], environment({
      buildGraph: async () => tinyGraph,
      graphOutput: async (chunk) => { await Promise.resolve(); chunks.push(chunk); },
    }));
    assert.equal(result.exitCode, 0, result.standardError);
    assert.equal(result.standardOutput, '');
    const output = chunks.join('');
    if (format === 'json') assert.equal(JSON.parse(output).nodes.length, 3);
    else assert.equal(output.trim().split('\n').map((line) => JSON.parse(line)).filter((row) => row.record === 'node').length, 3);
  }
  const failed = await runGraphCommand(['--project', '.'], environment({ buildGraph: async () => tinyGraph,
    graphOutput: async () => { throw new Error('/secret/output/path'); } }));
  assert.equal(failed.exitCode, 2);
  assert.match(failed.standardError, /graph output/);
  assert.ok(!failed.standardError.includes('/secret'));
});

test('explicit config and workspace are passed only to live graph inputs', async () => {
  let received: unknown;
  const result = await runGraphCommand(['--project', '.', '--tsconfig', 'config/check.json', '--workspace', '.'], environment({
    buildGraph: async (_project, _fs, options) => { received = options; return tinyGraph; },
  }));
  assert.equal(result.exitCode, 0, result.standardError);
  assert.deepEqual(received, { tsconfig: 'config/check.json', workspace: '.' });
  const failed = await runReachCommand(['--graph-file', 'file.json', '--tsconfig', 'config.json', 'a.ts#a'], environment());
  assert.equal(failed.exitCode, 64);
});

test('explicit input failures keep actionable reasons and internal builder failures remain internal', async () => {
  const invalid = await runGraphCommand(['--project', fixture, '--tsconfig', 'missing.json'], environment());
  assert.equal(invalid.exitCode, 2);
  assert.match(invalid.standardError, /explicit compiler config and its extends must be readable JSON files within 1 MiB/);
  await assert.rejects(runGraphCommand(['--project', '.'], environment({ buildGraph: async () => { throw new TypeError('internal'); } })), TypeError);
  const fake = { ...createNodeFileSystem(), realPath: async (path: string) => path === 'workspace' ? '/work/unsafe\n' : '/work/project',
    status: async () => ({ kind: 'directory' as const, size: 0, modifiedAt: fixedNow }) };
  let builds = 0;
  const unsafe = await runGraphCommand(['--project', 'project', '--workspace', 'workspace'], environment({ fileSystem: fake,
    buildGraph: async () => { builds++; return tinyGraph; } }));
  assert.equal(unsafe.exitCode, 2);
  assert.match(unsafe.standardError, /workspace path contains/);
  assert.equal(builds, 0);
});

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
    via: 'src/lib/jobs.ts#createJob', depth: 3, roots: [0], relationships: ['call'], evidence: 'direct',
  });
  // POST는 인라인 콜백(`withAuth(async …)`)을 `contains`로 담는다.
  const callback = document.reached.find((entry: { symbol: { usr: string } }) => entry.symbol.usr === 'src/app/api/jobs/route.ts#POST.withAuth()');
  assert.deepEqual([callback.via, callback.depth, callback.relationships], ['src/app/api/jobs/route.ts#POST', 1, ['contains']]);
  assert.equal(document.dispatch, 'bound');
  assert.ok(document.limitations.some((line: string) => line.startsWith('unresolved-calls:')));
  assert.ok(!document.limitations.some((line: string) => line.startsWith('non-http-entries:')));
});

test('impact는 dependents 방향이고 비HTTP 진입점을 이 문서 범위로 센다', async () => {
  const result = await runImpactCommand(['--project', fixture, '--max-depth', '3', 'src/lib/jobs.ts#createJob'], environment());
  const document = JSON.parse(result.standardOutput);
  assert.equal(document.direction, 'dependents');
  assert.deepEqual(document.reached.map((entry: { symbol: { usr: string }; depth: number }) => `${entry.depth} ${entry.symbol.usr}`), [
    '1 src/app/api/jobs/route.ts#POST.withAuth()',
    '1 src/app/jobs/actions.ts#createJobAction',
    '1 src/lib/index.ts#addJob',
    '2 src/app/api/jobs/route.ts#POST',
    '2 src/app/jobs/page.tsx#JobsPage',
    '2 src/lib/hof.ts#withAuth',
    '3 src/app/api/jobs/route.ts#<module>',
  ]);
  assert.equal(document.reached.find((entry: { symbol: { usr: string } }) => entry.symbol.usr === 'src/lib/hof.ts#withAuth')?.evidence, 'bound');
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
    via: 'src/app/api/jobs/route.ts#POST.withAuth()', depth: 2, roots: [0], relationships: ['call'], evidence: 'direct',
  });
  const audit = byUsr.get('src/lib/audit.ts#audit') as { via: string; depth: number; roots: number[] };
  assert.deepEqual([audit.via, audit.depth, audit.roots], ['src/lib/jobs.ts#createJob', 1, [0, 1]]);
  assert.ok(!byUsr.has('src/app/api/jobs/route.ts#POST'));
});

test('--entry-points는 실제 페이지·액션 표식을 내고 기본 순회는 옛 소비자와 호환된다', async () => {
  const args = ['--project', fixture, '--max-depth', '3', 'src/lib/jobs.ts#createJob'];
  const legacy = JSON.parse((await runImpactCommand(args, environment())).standardOutput);
  assert.ok(legacy.reached.every((row: any) => row.symbol.entries === undefined));
  const result = await runImpactCommand([...args, '--entry-points'], environment());
  assert.equal(result.exitCode, 0, result.standardError);
  const marked = JSON.parse(result.standardOutput);
  assert.deepEqual(marked.reached.filter((row: any) => row.symbol.entries).map((row: any) => [row.symbol.usr, row.symbol.entries]), [
    ['src/app/jobs/actions.ts#createJobAction', ['server-action']],
    ['src/app/api/jobs/route.ts#POST', ['route-handler']],
    ['src/app/jobs/page.tsx#JobsPage', ['page']],
  ]);
  const reached = await runReachCommand(['--project', fixture, '--entry-points', 'src/app/jobs/page.tsx#JobsPage'], environment());
  assert.equal(reached.exitCode, 0, reached.standardError);
  const root = JSON.parse(reached.standardOutput).roots[0];
  assert.deepEqual(root.symbol.entries, ['page']);
  assert.equal(root.symbol.location.path, 'src/app/jobs/page.tsx');
  const plain = await runReachCommand(['--project', fixture, 'src/app/jobs/page.tsx#JobsPage'], environment());
  assert.equal(plain.exitCode, 0, plain.standardError);
  assert.deepEqual(JSON.parse(plain.standardOutput).roots[0].symbol, {
    usr: 'src/app/jobs/page.tsx#JobsPage', qualifiedName: 'src/app/jobs/page.tsx#JobsPage',
  });
});

test('실제 cron 핸들러의 두 진입점 종류는 정렬된 목록으로 전달한다', async () => {
  const id = 'src/app/api/cron/cleanup/route.ts#GET';
  const result = await runReachCommand(['--project', fixture, '--entry-points', id], environment());
  assert.equal(result.exitCode, 0, result.standardError);
  const marked = JSON.parse(result.standardOutput);
  assert.deepEqual(marked.roots[0].symbol.entries, ['route-handler', 'scheduled']);
  assert.ok(marked.reached.every((row: any) => row.symbol.entries === undefined ||
    row.symbol.entries.every((value: string, index: number, all: string[]) => index === 0 || all[index - 1]! < value)));
});

test('root이기도 한 진입점의 표식은 두 항목에서 같고 해석하지 못한 root는 표식을 지어내지 않는다', async () => {
  const env = environment({ buildGraph: async () => tinyGraph });
  const result = await runImpactCommand(['--project', '.', '--entry-points', 'a.ts#b', 'a.ts#page', 'missing'], env);
  assert.equal(result.exitCode, 64);
  const marked = JSON.parse(result.standardOutput);
  assert.deepEqual(marked.roots[1].symbol.entries, ['page']);
  assert.deepEqual(marked.reached.find((row: any) => row.symbol.usr === 'a.ts#page').symbol.entries, ['page']);
  assert.deepEqual(marked.roots[2], { id: 'missing' });
  assert.equal((await runGraphCommand(['--project', '.', '--entry-points'], env)).exitCode, 64);
});

test('모르는 id는 문서에 root-not-found로 남기고 64로 끝나며 표준 오류에 목록을 알린다', async () => {
  const ids = Array.from({ length: 22 }, (_, index) => `x.ts#missing${index}`);
  const result = await runReachCommand(['--project', '.', ...ids, 'a.ts#a'], environment({ buildGraph: async () => tinyGraph }));
  assert.equal(result.exitCode, 64);
  assert.match(result.standardError, /22 root id\(s\) are not graph nodes/u);
  assert.match(result.standardError, /x\.ts#missing19 \(unknown id\)\n {2}… and 2 more/u);
  assert.doesNotMatch(result.standardError, /a\.ts#a/u);
  const document = JSON.parse(result.standardOutput);
  assert.equal(document.roots.length, 23);
  assert.deepEqual(document.roots[22], { id: 'a.ts#a', symbol: { usr: 'a.ts#a', qualifiedName: 'a.ts#a' } });
  assert.deepEqual(document.reached.map((entry: { symbol: { usr: string }; roots: number[] }) => [entry.symbol.usr, entry.roots]), [['a.ts#b', [22]]]);
});

/** 스키마 선언 id다. schema가 선언 쪽 relation-use에 싣는, 그래프 노드가 아닌 usr다. */
const modelId = 'prisma/schema.prisma#model:Job';

test('선언 id·모르는 id가 섞여도 아는 root로 문서를 내고 인덱스는 요청 순서를 따른다', async () => {
  const known = ['src/app/api/jobs/route.ts#POST', 'src/lib/jobs.ts#createJob'];
  const requested = [modelId, known[0]!, 'src/nope.ts#missing', 'prisma/sql/x.sql#typedsql:x', known[1]!];
  const result = await runReachCommand(['--project', fixture, ...requested], environment());
  assert.equal(result.exitCode, 64);
  assert.match(result.standardError, /^tsograph: 3 root id\(s\) are not graph nodes;/u);
  assert.match(result.standardError, /prisma\/schema\.prisma#model:Job \(schema declaration id; never a graph node\)\n {2}src\/nope\.ts#missing \(unknown id\)\n {2}prisma\/sql\/x\.sql#typedsql:x \(schema declaration id; never a graph node\)\n$/u);
  const document = JSON.parse(result.standardOutput);
  assert.deepEqual(document.roots.map((root: { id: string; symbol?: unknown }) => [root.id, root.symbol !== undefined]), requested.map((id) => [id, known.includes(id)]));
  assert.equal(document.truncated, true);
  assert.deepEqual(document.truncationReasons, ['root-not-found']);
  assert.deepEqual(document.limitations.filter((line: string) => line.startsWith('root-not-found:')), [
    "root-not-found: 3 requested root(s) are not graph nodes and are listed without symbol: 2 Prisma schema/TypedSQL declaration id(s) (#model:, #typedsql:), which are declaration-side relation-use ids and never graph nodes, so no traversal reaches them; leave them out of traversal roots; 1 unknown id(s); pass graph node ids from 'tsograph graph --project <root>'",
  ]);
  const baseline = JSON.parse((await runReachCommand(['--project', fixture, ...known], environment())).standardOutput);
  const toRequested = [1, 4];
  assert.deepEqual(document.reached, baseline.reached.map((entry: { roots: number[] }) => ({ ...entry, roots: entry.roots.map((index) => toRequested[index]) })));
  assert.deepEqual(document.limitations.filter((line: string) => !line.startsWith('root-not-found:')), baseline.limitations);
});

test('모르는 id만 받으면 빈 도달 목록의 문서를 내고 64로 끝난다', async () => {
  const result = await runImpactCommand(['--project', fixture, '--max-depth', '1', modelId], environment());
  assert.equal(result.exitCode, 64);
  const document = JSON.parse(result.standardOutput);
  assert.deepEqual(document.roots, [{ id: modelId }]);
  assert.deepEqual(document.reached, []);
  assert.equal(document.truncated, true);
  assert.deepEqual(document.truncationReasons, ['root-not-found']);
  assert.ok(document.limitations.some((line: string) => line.startsWith('root-not-found: 1 requested root(s) are not graph nodes and are listed without symbol: 1 Prisma schema/TypedSQL declaration id(s)')));
  assert.ok(!document.limitations.some((line: string) => line.includes('unknown id(s)')));
});

test('깊이 잘림과 root-not-found는 정렬된 이유로 함께 실린다', async () => {
  const result = await runImpactCommand(['--project', fixture, '--max-depth', '1', 'src/lib/jobs.ts#createJob', 'src/nope.ts#missing'], environment());
  assert.equal(result.exitCode, 64);
  const document = JSON.parse(result.standardOutput);
  assert.deepEqual(document.truncationReasons, ['depth', 'root-not-found']);
  assert.ok(document.limitations.includes("root-not-found: 1 requested root(s) are not graph nodes and are listed without symbol: 1 unknown id(s); pass graph node ids from 'tsograph graph --project <root>'"));
});

test('root-not-found 문서도 출력 상한을 넘으면 문서 없이 2다', async () => {
  const hugeRoots = Array.from({ length: 10_000 }, (_, index) => `x.ts#${'m'.repeat(1_700)}${index}`);
  const result = await runReachCommand(['--project', '.', ...hugeRoots], environment({ buildGraph: async () => tinyGraph }));
  assert.equal(result.exitCode, 2);
  assert.equal(result.standardOutput, '');
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
    ['--project', '.', '--max-reached', 'x', 'a'], ['--project', '.', 'bad\u0001id'], ['--bogus'], ['--project', '.', '--dispatch', 'all', 'a.ts#a'],
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

test('unresolvedCalls 상한(1,000,000)을 넘으면 상한으로 싣고 limitation으로 알린다(스냅샷은 정확한 수)', async () => {
  const heavy: CallGraph = {
    ...tinyGraph,
    nodes: tinyGraph.nodes.map((node) => (node.id === 'a.ts#b' ? { ...node, unresolvedCalls: { direct: 2_000_000, bound: 2_000_000 } } : node)),
  };
  const env = environment({ buildGraph: async () => heavy });
  const document = JSON.parse((await runReachCommand(['--project', '.', 'a.ts#a'], env)).standardOutput);
  assert.equal(document.reached[0].unresolvedCalls, 1_000_000);
  assert.ok(document.limitations.includes('unresolved-calls-capped: 1 symbol(s) have more than 1000000 unresolved call sites; unresolvedCalls reports 1000000 for them (the graph snapshot keeps the exact counts)'));
  const snapshot = JSON.parse((await runGraphCommand(['--project', '.'], env)).standardOutput);
  assert.equal(snapshot.nodes.find((node: { id: string }) => node.id === 'a.ts#b').unresolvedCalls.bound, 2_000_000);
  const direct = JSON.parse((await runReachCommand(['--project', '.', '--dispatch', 'candidates', 'a.ts#a'], env)).standardOutput);
  assert.equal(direct.reached[0].unresolvedCalls, undefined);
  assert.ok(!direct.limitations.some((line: string) => line.startsWith('unresolved-calls-capped:')));
});

test('근거 등급을 근사한 문서는 evidence-approximated limitation을 싣는다', () => {
  const document = createTraversalDocument({
    graph: tinyGraph, graphRevision: 'sha256:0', direction: 'dependencies', dispatch: 'candidates',
    roots: { requestedIds: ['a.ts#a'], resolvedIds: ['a.ts#a'], unresolved: new Map() },
    header: { toolVersion: '0', generatedAt: fixedNow, project: '/work/x', revision: undefined },
    result: { reached: [], truncationReasons: [], rootsTruncated: false, evidenceApproximated: true },
  });
  assert.ok(document.limitations.some((line) => line.startsWith('evidence-approximated: ')));
});

test('저장한 실제 그래프는 소스를 지운 뒤에도 재빌드 없이 reach와 impact를 순회한다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-saved-graph-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022"},"include":["src"]}');
    writeFileSync(join(root, 'src/index.ts'), 'export function start() { return finish(); }\nexport function finish() { return 1; }\n');
    const snapshotResult = await runGraphCommand(['--project', root], environment());
    assert.equal(snapshotResult.exitCode, 0, snapshotResult.standardError);
    const graphFile = join(root, 'graph.json');
    writeFileSync(graphFile, snapshotResult.standardOutput);
    rmSync(join(root, 'src'), { recursive: true });

    let builds = 0;
    const savedEnvironment = environment({ buildGraph: async () => { builds++; throw new Error('must not build'); } });
    const reach = await runReachCommand(['--graph-file', graphFile, 'src/index.ts#start'], savedEnvironment);
    assert.equal(reach.exitCode, 0, reach.standardError);
    const reached = JSON.parse(reach.standardOutput);
    assert.deepEqual(reached.reached.map((row: { symbol: { usr: string } }) => row.symbol.usr), ['src/index.ts#finish']);
    assert.equal(reached.project, root);
    assert.equal('revision' in reached, false);
    assert.equal(reached.graphRevision, JSON.parse(snapshotResult.standardOutput).graphRevision);
    assert.ok(!reached.limitations.some((line: string) => line.startsWith('saved-graph-mode-limitations:')));

    const legacy = JSON.parse(snapshotResult.standardOutput);
    delete legacy.limitationsByMode;
    writeFileSync(graphFile, JSON.stringify(legacy));
    const legacyReach = await runReachCommand(['--graph-file', graphFile, 'src/index.ts#start'], savedEnvironment);
    assert.ok(JSON.parse(legacyReach.standardOutput).limitations.some((line: string) => line.startsWith('saved-graph-mode-limitations:')));

    const impact = await runImpactCommand(['--graph-file', graphFile, 'src/index.ts#finish'], savedEnvironment);
    assert.equal(impact.exitCode, 0, impact.standardError);
    assert.deepEqual(JSON.parse(impact.standardOutput).reached
      .map((row: { symbol: { usr: string } }) => row.symbol.usr), ['src/index.ts#start']);
    assert.equal(builds, 0);

    const enhanced = JSON.parse(snapshotResult.standardOutput);
    enhanced.revision = 'a'.repeat(40);
    enhanced.limitations = ['snapshot-wide: retained'];
    enhanced.limitationsByMode = {
      direct: ['snapshot-wide: retained', 'direct-only: retained'],
      bound: ['snapshot-wide: retained', 'bound-only: retained'],
      candidates: ['snapshot-wide: retained', 'candidate-only: retained'],
    };
    writeFileSync(graphFile, JSON.stringify(enhanced));
    const candidate = await runReachCommand(
      ['--graph-file', graphFile, '--dispatch', 'candidates', 'src/index.ts#start'], savedEnvironment,
    );
    assert.equal(candidate.exitCode, 0, candidate.standardError);
    const candidateDocument = JSON.parse(candidate.standardOutput);
    assert.equal(candidateDocument.revision, 'a'.repeat(40));
    assert.deepEqual(candidateDocument.limitations,
      ['snapshot-wide: retained', 'candidate-only: retained',
        `saved-graph-input: built by tsograph ${enhanced.tool.version} at ${enhanced.generatedAt}; sources were not re-read; graphRevision verifies topology, not limitation, location or statistics integrity`]);

    const missing = await runReachCommand(['--graph-file', graphFile, 'src/index.ts#missing'], savedEnvironment);
    assert.equal(missing.exitCode, 64);
    assert.deepEqual(JSON.parse(missing.standardOutput).roots, [{ id: 'src/index.ts#missing' }]);

    const exclusive = await runReachCommand(
      ['--project', root, '--graph-file', graphFile, 'src/index.ts#start'], savedEnvironment,
    );
    assert.equal(exclusive.exitCode, 64);
    assert.equal(exclusive.standardOutput, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('저장 그래프의 endpoint·revision·duplicate·UTF-8·크기·읽기 실패는 문서 없이 2다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-invalid-saved-graph-')));
  try {
    const result = await runGraphCommand(['--project', root], environment({ buildGraph: async () => tinyGraph }));
    assert.equal(result.exitCode, 0, result.standardError);
    const base = JSON.parse(result.standardOutput);
    const cases: [string, (document: any) => void, RegExp][] = [
      ['endpoint.json', (document) => { document.edges[0].to = 'a.ts#missing'; }, /endpoint/u],
      ['revision.json', (document) => { document.graphRevision = `sha256:${'0'.repeat(64)}`; }, /graphRevision/u],
      ['duplicate.json', (document) => { document.nodes.push(structuredClone(document.nodes[0])); }, /duplicate/u],
      ['schema.json', (document) => { document.extra = true; }, /tsograph-graph version 1/u],
    ];
    for (const [name, mutate, diagnostic] of cases) {
      const document = structuredClone(base);
      mutate(document);
      const path = join(root, name);
      writeFileSync(path, JSON.stringify(document));
      const loaded = await runReachCommand(['--graph-file', path, 'a.ts#a'], environment());
      assert.equal(loaded.exitCode, 2, name);
      assert.equal(loaded.standardOutput, '', name);
      assert.match(loaded.standardError, diagnostic, name);
      assert.doesNotMatch(loaded.standardError, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
    }

    const invalidUtf8 = join(root, 'invalid-utf8.json');
    writeFileSync(invalidUtf8, new Uint8Array([0xff]));
    const utf8 = await runReachCommand(['--graph-file', invalidUtf8, 'a.ts#a'], environment());
    assert.equal(utf8.exitCode, 2);
    assert.equal(utf8.standardOutput, '');
    assert.match(utf8.standardError, /UTF-8/u);

    const unreadable = await runReachCommand(['--graph-file', join(root, 'missing.json'), 'a.ts#a'], environment());
    assert.equal(unreadable.exitCode, 2);
    assert.equal(unreadable.standardOutput, '');
    assert.match(unreadable.standardError, /readable saved graph file/u);

    let read = false;
    const bounded = environment({ fileSystem: {
      ...createNodeFileSystem(),
      realPath: async () => '/virtual/graph.json',
      status: async () => ({ kind: 'file' as const, size: 128 * 1024 * 1024 + 1, modifiedAt: fixedNow }),
      readBytes: async () => { read = true; return new Uint8Array(); },
    } });
    const oversized = await runReachCommand(['--graph-file', 'graph.json', 'a.ts#a'], bounded);
    assert.equal(oversized.exitCode, 2);
    assert.equal(oversized.standardOutput, '');
    assert.match(oversized.standardError, /134217728 bytes/u);
    assert.equal(read, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
