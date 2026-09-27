/**
 * 합성 fixture(`fixtures/graph/next-prisma`)로 호출 그래프의 간선 종류·해석 공백·진입점·결정성과,
 * routes·schema `symbol.usr`와의 id 일치를 검증한다.
 */

import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { runSchemaCommand } from '../cli/schema-command.ts';
import { buildCallGraph, projectSpecifierMatcher } from './build-graph.ts';
import { computeGraphRevision } from './graph-document.ts';
import type { CallGraph } from './graph-model.ts';
import { traverse } from './traversal.ts';

const fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url));
const graphFixture = realpathSync(`${fixtures}graph/next-prisma`);
const fileSystem = createNodeFileSystem();
const graph = await buildCallGraph(graphFixture, fileSystem);

/**
 * 그래프 간선을 `from -> to kinds` 문자열로 줄인다.
 *
 * @param target 그래프
 * @returns 간선 문자열 집합
 */
function edgeLines(target: CallGraph): Set<string> {
  return new Set(target.edges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kinds.join(',')}`));
}

/**
 * 명령 출력의 사실에서 `symbol.usr`를 모은다.
 *
 * @param output 명령 표준 출력
 * @returns usr 목록
 */
function usrsOf(output: string): string[] {
  const document = JSON.parse(output) as { facts: { symbol?: { usr?: string } }[] };
  return document.facts.flatMap((fact) => (fact.symbol?.usr === undefined ? [] : [fact.symbol.usr]));
}

test('간선 종류: 호출·new·콜백·참조·JSX·별칭·초기값과 모듈 사이 해석', () => {
  const lines = edgeLines(graph);
  const expected = [
    // 재내보내기 배럴(`export { createJob as addJob }`)·기본 내보내기·경로 별칭을 넘는 호출
    'src/app/api/jobs/route.ts#GET -> src/lib/jobs.ts#listJobs call',
    'src/app/api/jobs/route.ts#GET -> src/lib/jobs.ts#countJobs call',
    'src/app/api/jobs/route.ts#POST -> src/lib/jobs.ts#createJob call',
    'src/app/api/jobs/route.ts#POST -> src/lib/hof.ts#withAuth call',
    'src/app/api/jobs/route.ts#POST -> src/lib/repository.ts#saveProven call',
    // 함수를 인자로 넘김
    'src/app/api/jobs/route.ts#GET -> src/lib/jobs.ts#formatJob callback',
    // 생성자·필드 초기값·암묵 super
    'src/lib/repository.ts#saveProven -> src/lib/repository.ts#JobStore.constructor new',
    'src/lib/repository.ts#JobStore.constructor -> src/lib/repository.ts#JobStore.log initializer',
    'src/lib/repository.ts#JobStore.log -> src/lib/repository.ts#createLog call',
    'src/lib/repository.ts#Plain -> src/lib/repository.ts#Base initializer',
    // 증명한 인터페이스 구현(const 초기값 new)과 union의 두 구현
    'src/lib/repository.ts#saveProven -> src/lib/repository.ts#JobStore.save call',
    'src/lib/repository.ts#saveUnion -> src/lib/repository.ts#JobStore.save call',
    'src/lib/repository.ts#saveUnion -> src/lib/repository.ts#MemoryStore.save call',
    // JSX 컴포넌트와 JSX 속성 참조
    'src/app/jobs/page.tsx#JobsPage -> src/components/job-list.tsx#JobList jsx',
    'src/app/jobs/page.tsx#JobsPage -> src/app/jobs/actions.ts#createJobAction reference',
    // export 노드의 별칭: 재내보내기·지역 별칭·구조 분해, `export *` 배럴을 넘는 객체 속성 함수
    'src/app/api/jobs/[id]/route.ts#GET -> src/app/api/jobs/[id]/impl.ts#GET alias',
    'src/app/api/jobs/[id]/route.ts#DELETE -> src/app/api/jobs/[id]/route.ts#remove alias',
    'src/app/api/auth/[...nextauth]/route.ts#POST -> src/auth.ts#handlers.POST alias',
    'src/app/api/jobs/[id]/impl.ts#GET -> src/lib/companies.ts#companyQueries.byId call',
    // `const { heavy } = await import(...)`
    'src/app/api/jobs/[id]/route.ts#remove -> src/lib/lazy.ts#heavy call',
    // 순환과 모듈 초기값, JS 파일
    'src/lib/cycle.ts#isEven -> src/lib/cycle.ts#isOdd call',
    'src/lib/cycle.ts#isOdd -> src/lib/cycle.ts#isEven call',
    'src/lib/warm.ts#<module> -> src/lib/warm.ts#warmed initializer',
    'src/lib/warm.ts#warmed -> src/lib/warm.ts#warm call',
    'src/lib/legacy.js#legacyLabel -> src/lib/jobs.ts#formatJob call',
  ];
  for (const line of expected) assert.ok(lines.has(line), line);
  // 재정의 메서드는 증명하지 못해 잇지 않는다.
  assert.ok(!lines.has('src/lib/repository.ts#runBase -> src/lib/repository.ts#Derived.run call'));
  assert.ok(lines.has('src/lib/repository.ts#runBase -> src/lib/repository.ts#Base.run call'));
});

test('잇지 못한 호출은 이유별로 세고 추측하지 않는다', () => {
  assert.deepEqual(graph.statistics.calls.unresolved, {
    parameter: 1, interface: 1, untyped: 1, computed: 1, indirect: 1, 'unresolved-import': 1,
  });
  assert.equal(graph.statistics.calls.missingDependencies, 1);
  assert.ok(graph.statistics.calls.external > 0);
  assert.equal(graph.statistics.files, 25);
  assert.deepEqual(graph.limitations, [
    'unresolved-calls: 6 call(s) could not be linked to a project declaration and were not guessed (parameter: 1, interface: 1, untyped: 1, computed: 1, indirect: 1, unresolved-import: 1)',
    'candidate-dispatch: 1 call(s) whose receiver flows could not all be proven are linked to every project class or object that implements or is assignable to the receiver type (followed only with --dispatch candidates); these edges over-approximate',
    'missing-dependencies: 1 call(s) go through packages whose type declarations could not be resolved (dependencies not installed or untyped); they are treated as external',
    'overridden-methods: 1 call(s) target methods that subclasses override; only the statically resolved declaration is linked',
    'non-http-entries: 3 symbol(s) are entry points without a route-decl fact (middleware: 1, page: 1, server-action: 1); isthmus cannot reach them through the http join',
    'entry-points: 1 vercel.json cron path(s) match no GET route handler',
  ]);
  // `saveVia(store: Store)`는 프로젝트 안 호출자가 없는 내보낸 함수라 흐름을 증명하지 못한다: bound 없음, candidate 둘.
  assert.deepEqual(graph.statistics.calls.dispatch, { bound: 0, boundPartial: 0, candidate: 1, candidatePartial: 0, overBudget: 0 });
  assert.deepEqual(graph.edges.filter((edge) => edge.evidence !== 'direct').map((edge) => `${edge.from} -> ${edge.to} ${edge.evidence}`), [
    'src/lib/repository.ts#saveVia -> src/lib/repository.ts#JobStore.save candidate',
    'src/lib/repository.ts#saveVia -> src/lib/repository.ts#MemoryStore.save candidate',
  ]);
  assert.deepEqual(graph.nodes.find((node) => node.id === 'src/lib/repository.ts#saveVia')?.unresolvedCalls, { direct: 1, bound: 1 });
  const byMode = graph.limitationsByMode!;
  assert.deepEqual(byMode.direct.slice(0, 2), [graph.limitations[0], graph.limitations[2]]);
  assert.deepEqual(byMode.bound.slice(0, 2), [graph.limitations[0], graph.limitations[2]]);
  assert.deepEqual(byMode.candidates.slice(0, 3), [
    'unresolved-calls: 5 call(s) could not be linked to a project declaration and were not guessed (parameter: 1, untyped: 1, computed: 1, indirect: 1, unresolved-import: 1)',
    'candidate-dispatch: 1 call(s) whose receiver flows could not all be proven are linked to every project class or object that implements or is assignable to the receiver type; these edges over-approximate',
    graph.limitations[2],
  ]);
  // 의존성·lib 선언은 노드가 아니다.
  assert.ok(graph.nodes.every((node) => !node.id.includes('node_modules') && !node.location.path.endsWith('.d.ts')));
});

test('진입점: route 핸들러·cron·페이지·서버 액션·미들웨어', () => {
  const entries = Object.fromEntries(graph.nodes.filter((node) => node.entries !== undefined).map((node) => [node.id, node.entries!.join(',')]));
  assert.deepEqual(entries, {
    'src/app/api/auth/[...nextauth]/route.ts#GET': 'route-handler',
    'src/app/api/auth/[...nextauth]/route.ts#POST': 'route-handler',
    'src/app/api/cron/cleanup/route.ts#GET': 'route-handler,scheduled',
    'src/app/api/docs/[[...slug]]/route.ts#GET': 'route-handler',
    'src/app/api/health/route.ts#GET': 'route-handler',
    'src/app/api/jobs/[id]/route.ts#DELETE': 'route-handler',
    'src/app/api/jobs/[id]/route.ts#GET': 'route-handler',
    'src/app/api/jobs/route.ts#GET': 'route-handler',
    'src/app/api/jobs/route.ts#POST': 'route-handler',
    'src/app/jobs/actions.ts#createJobAction': 'server-action',
    'src/app/jobs/page.tsx#JobsPage': 'page',
    'src/proxy.ts#proxy': 'middleware',
  });
});

test('같은 입력의 그래프와 graphRevision은 같다', async () => {
  const again = await buildCallGraph(graphFixture, fileSystem);
  assert.deepEqual(again, graph);
  assert.equal(computeGraphRevision(again), computeGraphRevision(graph));
  assert.match(computeGraphRevision(graph), /^sha256:[0-9a-f]{64}$/u);
});

test('모든 route-decl·소스 relation-use usr는 그래프 노드이고, 선언 사실 usr는 노드가 아니다(모든 fixture)', async () => {
  const environment = { fileSystem, toolVersion: '0.0.0-test', now: () => new Date(0) };
  const projects = ['graph/next-prisma', 'next/app-router', 'next/pages-api', 'schema/prisma-app'].map((name) => realpathSync(`${fixtures}${name}`));
  for (const project of projects) {
    const nodes = new Set((await buildCallGraph(project, fileSystem)).nodes.map((node) => node.id));
    const routes = usrsOf((await runRoutesCommand(['--role', 'server', '--project', project, '--include-tests'], environment)).standardOutput);
    const relations = usrsOf((await runSchemaCommand(['--project', project], environment)).standardOutput);
    assert.ok(routes.length + relations.length > 0, project);
    const isDeclarationId = (usr: string): boolean => /#(?:model|typedsql):/u.test(usr);
    for (const usr of [...routes, ...relations.filter((usr) => !isDeclarationId(usr))]) assert.ok(nodes.has(usr), `${project}: ${usr}`);
    for (const usr of relations.filter(isDeclarationId)) assert.ok(!nodes.has(usr), `${project}: ${usr}`);
  }
});

test('route 핸들러 reach 집합과 relation-use usr로 route가 닿는 테이블을 구한다', async () => {
  const environment = { fileSystem, toolVersion: '0.0.0-test', now: () => new Date(0) };
  const routeDocument = JSON.parse((await runRoutesCommand(['--role', 'server', '--project', graphFixture], environment)).standardOutput) as {
    facts: { method: string; channel: string; symbol: { usr: string } }[];
  };
  const relationDocument = JSON.parse((await runSchemaCommand(['--project', graphFixture], environment)).standardOutput) as {
    facts: { channel: string; method?: string; symbol?: { usr?: string } }[];
  };
  const handlers = [...new Set(routeDocument.facts.map((fact) => fact.symbol.usr))];
  const result = traverse(graph, { rootIds: handlers, direction: 'dependencies', maxDepth: 128, maxReached: 100_000, dispatch: 'bound' });
  const tables = handlers.map((handler, index) => {
    const reach = new Set([handler, ...result.reached.filter((entry) => entry.roots.includes(index)).map((entry) => entry.id)]);
    const touched = relationDocument.facts.filter((fact) => fact.method === undefined && fact.symbol?.usr !== undefined && reach.has(fact.symbol.usr));
    return `${handler} ${[...new Set(touched.map((fact) => fact.channel))].sort().join(',')}`;
  });
  assert.deepEqual(tables, [
    'src/app/api/auth/[...nextauth]/route.ts#GET ',
    'src/app/api/auth/[...nextauth]/route.ts#POST AuditLog',
    'src/app/api/cron/cleanup/route.ts#GET jobs',
    'src/app/api/docs/[[...slug]]/route.ts#GET ',
    'src/app/api/health/route.ts#GET ',
    'src/app/api/jobs/route.ts#GET jobs',
    'src/app/api/jobs/route.ts#POST AuditLog,jobs',
    'src/app/api/jobs/[id]/route.ts#DELETE Company',
    'src/app/api/jobs/[id]/route.ts#GET Company',
  ]);
});

test('프로젝트 import 판정: 상대·절대 경로와 paths 패턴', () => {
  const matches = projectSpecifierMatcher({ paths: { '@/*': ['./src/*'], '~lib': ['./lib/index.ts'], 'x*.gen': ['./gen/*'] } });
  assert.deepEqual(['./a', '../b', '/abs', '@/lib/db', '~lib', 'xa.gen', 'react', '@scope/pkg', '~lib/deep', 'x.ge'].map(matches), [
    true, true, true, true, true, true, false, false, false, false,
  ]);
  assert.equal(projectSpecifierMatcher({})('next/server'), false);
});
