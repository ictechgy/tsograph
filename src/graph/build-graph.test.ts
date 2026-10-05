/**
 * 합성 fixture(`fixtures/graph/next-prisma`)로 호출 그래프의 간선 종류·해석 공백·진입점·결정성과,
 * routes·schema `symbol.usr`와의 id 일치를 검증한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { runSchemaCommand } from '../cli/schema-command.ts';
import { buildCallGraph, projectSpecifierMatcher } from './build-graph.ts';
import { createModuleResolver } from './dispatch.ts';
import { createEffectManifest, effectEmitPolicy, selectEffectManifest } from './effect-inventory.ts';
import { buildFileIndex, mergeFlowIndexes } from './flow-index.ts';
import { computeGraphRevision } from './graph-document.ts';
import type { CallGraph } from './graph-model.ts';
import { createGraphProgram } from './program.ts';
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
    'src/app/api/jobs/route.ts#POST -> src/lib/hof.ts#withAuth call',
    // 인라인 콜백(`withAuth(async (request) => …)`)은 자기 노드이고, 담은 노드가 `contains`로 잇는다.
    'src/app/api/jobs/route.ts#POST -> src/app/api/jobs/route.ts#POST.withAuth() contains',
    'src/app/api/jobs/route.ts#POST.withAuth() -> src/lib/jobs.ts#createJob call',
    'src/app/api/jobs/route.ts#POST.withAuth() -> src/lib/repository.ts#saveProven call',
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
    'bound-dispatch: 3 call(s) through deferred interface/callable sites are linked by bound edges (followed by reach/impact with --dispatch bound, the default): every observed receiver or callable value within the scanned project is a project implementation or callable declaration; reflective or computed-key writes and values from outside the scan keep affected flows unknown',
    'candidate-dispatch: 1 call(s) whose receiver flows could not all be proven are linked to every project class or object that implements or is assignable to the receiver type (followed only with --dispatch candidates); these edges over-approximate',
    'missing-dependencies: 1 call(s) go through packages whose type declarations could not be resolved (dependencies not installed or untyped); they are treated as external',
    'overridden-methods: 1 call(s) target methods that subclasses override; only the statically resolved declaration is linked',
    'non-http-entries: 3 symbol(s) are entry points without a route-decl fact (middleware: 1, page: 1, server-action: 1); isthmus cannot reach them through the http join',
    'entry-points: 1 vercel.json cron path(s) match no GET route handler',
  ]);
  // `saveVia(store: Store)`는 프로젝트 안 호출자가 없는 내보낸 함수라 흐름을 증명하지 못한다: bound 없음, candidate 둘.
  assert.deepEqual(graph.statistics.calls.dispatch, { bound: 3, boundPartial: 0, candidate: 1, candidatePartial: 0, overBudget: 0 });
  assert.deepEqual(graph.edges.filter((edge) => edge.evidence !== 'direct').map((edge) => `${edge.from} -> ${edge.to} ${edge.evidence}`), [
    'src/lib/hof.ts#chooseLater -> src/lib/hof.ts#formatA bound',
    'src/lib/hof.ts#chooseLater -> src/lib/hof.ts#formatB bound',
    'src/lib/hof.ts#pick -> src/lib/hof.ts#formatA bound',
    'src/lib/hof.ts#pick -> src/lib/hof.ts#formatB bound',
    'src/lib/hof.ts#withAuth -> src/app/api/jobs/route.ts#POST.withAuth() bound',
    'src/lib/repository.ts#saveVia -> src/lib/repository.ts#JobStore.save candidate',
    'src/lib/repository.ts#saveVia -> src/lib/repository.ts#MemoryStore.save candidate',
  ]);
  assert.deepEqual(graph.nodes.find((node) => node.id === 'src/lib/repository.ts#saveVia')?.unresolvedCalls, { direct: 1, bound: 1 });
  const byMode = graph.limitationsByMode!;
  assert.deepEqual(byMode.direct.slice(0, 2), [graph.limitations[0], graph.limitations[3]]);
  assert.deepEqual(byMode.bound.slice(0, 2), [
    'unresolved-calls: 3 call(s) could not be linked to a project declaration and were not guessed (interface: 1, untyped: 1, unresolved-import: 1)',
    'bound-dispatch: 3 call(s) through deferred interface/callable sites are linked by bound edges: every observed receiver or callable value within the scanned project is a project implementation or callable declaration; reflective or computed-key writes and values from outside the scan keep affected flows unknown',
  ]);
  assert.deepEqual(byMode.candidates.slice(0, 4), [
    'unresolved-calls: 2 call(s) could not be linked to a project declaration and were not guessed (untyped: 1, unresolved-import: 1)',
    'bound-dispatch: 3 call(s) through deferred interface/callable sites are linked by bound edges: every observed receiver or callable value within the scanned project is a project implementation or callable declaration; reflective or computed-key writes and values from outside the scan keep affected flows unknown',
    'candidate-dispatch: 1 call(s) whose receiver flows could not all be proven are linked to every project class or object that implements or is assignable to the receiver type; these edges over-approximate',
    graph.limitations[3],
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
  const projects = ['graph/next-prisma', 'graph/hono-d1-inline', 'graph/express-pg-inline', 'next/app-router', 'next/pages-api', 'node/hono-app',
    'node/express4-app', 'schema/prisma-app', 'schema/drizzle-d1-app'].map((name) => realpathSync(`${fixtures}${name}`));
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

/**
 * route 핸들러마다 reach 집합(핸들러 포함)에 든 relation-use의 테이블을 구한다(isthmus trace의 route → 테이블 사슬).
 *
 * @param project 프로젝트 루트
 * @param target 그 프로젝트의 그래프
 * @returns `<핸들러 usr> <테이블,…>` 목록
 */
async function routeTables(project: string, target: CallGraph): Promise<string[]> {
  const environment = { fileSystem, toolVersion: '0.0.0-test', now: () => new Date(0) };
  const routeDocument = JSON.parse((await runRoutesCommand(['--role', 'server', '--project', project], environment)).standardOutput) as {
    facts: { method: string; channel: string; symbol: { usr: string } }[];
  };
  const relationDocument = JSON.parse((await runSchemaCommand(['--project', project], environment)).standardOutput) as {
    facts: { channel: string; method?: string; symbol?: { usr?: string } }[];
  };
  const handlers = [...new Set(routeDocument.facts.map((fact) => fact.symbol.usr))];
  const result = traverse(target, { rootIds: handlers, direction: 'dependencies', maxDepth: 128, maxReached: 100_000, dispatch: 'bound' });
  return handlers.map((handler, index) => {
    const reach = new Set([handler, ...result.reached.filter((entry) => entry.roots.includes(index)).map((entry) => entry.id)]);
    const touched = relationDocument.facts.filter((fact) => fact.method === undefined && fact.symbol?.usr !== undefined && reach.has(fact.symbol.usr));
    return `${handler} ${[...new Set(touched.map((fact) => fact.channel))].sort().join(',')}`;
  });
}

test('인라인 핸들러(Hono·Express): route usr가 핸들러 노드이고, 안의 relation-use가 같은 id라 route가 제 테이블에만 닿는다', async () => {
  const hono = realpathSync(`${fixtures}graph/hono-d1-inline`);
  const honoGraph = await buildCallGraph(hono, fileSystem);
  assert.deepEqual(await routeTables(hono, honoGraph), [
    'src/admin.ts#admin.….get("/audit") audit_log',
    'src/index.ts#<module>.app.get("/health") ',
    'src/index.ts#<module>.app.post("/posts") posts',
    'src/index.ts#<module>.app.get("/users") users',
  ]);
  const lines = edgeLines(honoGraph);
  assert.ok(lines.has('src/index.ts#<module> -> src/index.ts#<module>.app.get("/users") contains'));
  assert.ok(lines.has('src/index.ts#<module>.app.post("/posts") -> src/db.ts#insertPost call'));
  assert.ok(lines.has('src/admin.ts#admin -> src/admin.ts#admin.….get("/audit") contains'));
  assert.ok(honoGraph.nodes.find((node) => node.id === 'src/index.ts#<module>.app.get("/users")')?.entries?.includes('route-handler'));
  const express = realpathSync(`${fixtures}graph/express-pg-inline`);
  assert.deepEqual(await routeTables(express, await buildCallGraph(express, fileSystem)), [
    'src/app.ts#<module>.router.get("/customers") customers',
    'src/app.ts#<module>.app.get("/orders") orders',
    'src/app.ts#<module>.app.delete("/orders/:id") order_items',
  ]);
});

test('인라인 콜백 id·contains 간선은 두 번 만들어도 같고, 무관한 수정에 흔들리지 않는다', async () => {
  const hono = realpathSync(`${fixtures}graph/hono-d1-inline`);
  const first = await buildCallGraph(hono, fileSystem);
  const second = await buildCallGraph(hono, fileSystem);
  assert.deepEqual(second, first);
  assert.equal(computeGraphRevision(second), computeGraphRevision(first));
  const ids = (target: CallGraph): string[] => target.nodes.map((node) => node.id).filter((id) => id.includes('('));
  assert.deepEqual(ids(first), [
    'src/admin.ts#admin.….get("/audit")',
    'src/index.ts#<module>.app.get("/health")',
    'src/index.ts#<module>.app.get("/users")',
    'src/index.ts#<module>.app.post("/posts")',
  ]);
});

test('contains 간선은 자기 id를 얻은 콜백에만 잇고, 계산된 이름 멤버 안 콜백은 담은 스코프에 남는다', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-contains-')));
  try {
    writeFileSync(join(project, 'package.json'), '{"name":"contains-probe","private":true}\n');
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'src/a.ts'), [
      'export function g() { return 1; }',
      'export function run(items: number[]) { return items.map(() => g()); }',
      "const key = 'k';",
      'export class C { [key]() { return [1].map(() => g()); } }',
      '',
    ].join('\n'));
    const target = await buildCallGraph(project, fileSystem);
    const lines = edgeLines(target);
    assert.ok(lines.has('src/a.ts#run -> src/a.ts#run.items.map() contains'));
    assert.ok(lines.has('src/a.ts#run.items.map() -> src/a.ts#g call'));
    assert.ok(lines.has('src/a.ts#<module> -> src/a.ts#g call'));
    assert.deepEqual(target.edges.filter((edge) => edge.kinds.includes('contains')).length, 1);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('route 핸들러 reach 집합과 relation-use usr로 route가 닿는 테이블을 구한다', async () => {
  const tables = await routeTables(graphFixture, graph);
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

test('실제 그래프의 inventory build-cap은 기존 간선을 보존하고 query exhaustion과 구분한다', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-inventory-')));
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{"private":true}');
    writeFileSync(join(project, 'src/main.ts'), 'function target() { return 1; } export function run() { return target(); }');
    const baseline = await buildCallGraph(project, fileSystem);
    assert.ok(edgeLines(baseline).has('src/main.ts#run -> src/main.ts#target call'));
    assert.ok(!baseline.limitations.some((limitation) => limitation.startsWith('effect-inventory:')));
    writeFileSync(join(project, 'src/padding.ts'), Array.from({ length: 26_000 }, (_, index) => `const v${index} = 1;`).join('\n'));
    const capped = await buildCallGraph(project, fileSystem);
    assert.ok(edgeLines(capped).has('src/main.ts#run -> src/main.ts#target call'));
    assert.ok(capped.limitations.some((limitation) => limitation.includes('effect-inventory: incomplete(build-cap)')));
    assert.equal(capped.statistics.calls.dispatch.overBudget, 0);
    for (const mode of ['direct', 'bound', 'candidates'] as const) {
      assert.equal(capped.limitationsByMode![mode].filter((limitation) => limitation.startsWith('effect-inventory:')).length, 1);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('실제 Program emit policy와 relative test view가 whole/production inventory를 독립적으로 닫는다', () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-__tests__-inventory-policy-')));
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{"private":true}');
    const relativeFiles = new Map([
      ['src/dep.ts', 'export interface Shape { value: number } export const dep = 1;'],
      ['src/main.ts', 'import { type Shape } from "./dep"; export { type Shape as PublicShape } from "./dep"; export const value = undefined;'],
      ['src/normal.ts', 'import { dep } from "./dep"; export const value = dep;'],
      ['src/main.test.ts', 'export const external = import("untyped-pkg");'],
    ]);
    for (const [path, text] of relativeFiles) writeFileSync(join(project, path), text);

    const inspect = (verbatimModuleSyntax: boolean) => {
      writeFileSync(join(project, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', verbatimModuleSyntax,
      } }));
      const absolutePaths = new Map([...relativeFiles.keys()].map((path) => [path, join(project, path)]));
      const { program, checker } = createGraphProgram(project, [...absolutePaths.values()]);
      const files = new Map([...absolutePaths].map(([path, absolute]) => [path, program.getSourceFile(absolute)!]));
      const expected = new Map([...absolutePaths].map(([path, absolute]) => [absolute, files.get(path)]));
      const resolveModule = createModuleResolver(program, checker);
      const policy = effectEmitPolicy(program.getCompilerOptions());
      const budget = { visited: 0, records: 0 };
      const wholeManifest = createEffectManifest(expected, 'whole', resolveModule, true, budget, checker, policy);
      const productionExpected = new Map([...absolutePaths]
        .filter(([path]) => !path.endsWith('.test.ts'))
        .map(([path, absolute]) => [absolute, files.get(path)]));
      const productionManifest = selectEffectManifest(wholeManifest, productionExpected, 'production');
      const indexes = new Map([...files].map(([path, file]) => [path,
        buildFileIndex(checker, file, resolveModule, budget, policy)]));
      const whole = mergeFlowIndexes(indexes.values(), wholeManifest).effectInventory!;
      const production = mergeFlowIndexes([...indexes]
        .filter(([path]) => !path.endsWith('.test.ts')).map(([, index]) => index), productionManifest).effectInventory!;
      return { files, indexes, whole, production };
    };

    const preserved = inspect(true);
    assert.deepEqual(preserved.indexes.get('src/main.ts')!.effectParts[0]!.moduleEdges.map((edge) => edge.specifier), ['./dep', './dep']);
    assert.deepEqual(preserved.indexes.get('src/normal.ts')!.effectParts[0]!.moduleEdges.map((edge) => edge.specifier), ['./dep']);
    assert.equal(preserved.whole.initialization, 'incomplete');
    assert.equal(preserved.production.initialization, 'complete');
    assert.equal(preserved.production.referenceAliases, 'complete');
    assert.equal(preserved.production.manifest.files.size, 3);

    const erased = inspect(false);
    assert.deepEqual(erased.indexes.get('src/main.ts')!.effectParts[0]!.moduleEdges, []);
    assert.deepEqual(erased.indexes.get('src/normal.ts')!.effectParts[0]!.moduleEdges.map((edge) => edge.specifier), ['./dep']);
    assert.equal(erased.production.initialization, 'complete');
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('읽을 수 없는 compiler config는 ordinary graph를 보존하되 inventory coverage를 열어 둔다', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-inventory-config-')));
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{"private":true}');
    writeFileSync(join(project, 'tsconfig.json'), '{ broken');
    writeFileSync(join(project, 'src/main.ts'), 'export const value = 1;');
    const target = await buildCallGraph(project, fileSystem);
    assert.ok(target.nodes.some((node) => node.id === 'src/main.ts#value'));
    assert.ok(target.limitations.some((limitation) => limitation.startsWith('graph-config: tsconfig.json could not be parsed;')));
    assert.ok(target.limitations.some((limitation) => limitation.includes('effect-inventory: incomplete(coverage)')));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
