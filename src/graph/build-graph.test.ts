/**
 * 합성 fixture(`fixtures/graph/next-prisma`)로 호출 그래프의 간선 종류·해석 공백·진입점·결정성과,
 * routes·schema `symbol.usr`와의 id 일치를 검증한다.
 */

import assert from 'node:assert/strict';
import { chmodSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { runSchemaCommand } from '../cli/schema-command.ts';
import { ambientTypesFreeConfig, linkToDevZero, makeFifo, runCliGuarded } from '../cli/testing.test.ts';
import { isSafeIdentifier } from '../exchange/bridge-facts.ts';
import { extractProjectRoutes, isProjectTestPath, projectTestSourceRule } from '../routes/project-routes.ts';
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
/** 변경하지 않는 공개 fixture의 graph 결과만 test module 안에서 공유한다. */
const immutableGraphResults = new Map<string, Promise<CallGraph>>();
/** 같은 고정 `schema --project` 명령의 출력만 test module 안에서 공유한다. */
const immutableSchemaResults = new Map<string, Promise<string>>();
/** 모든 cached CLI 호출이 같은 고정 환경을 관찰한다. */
const immutableCommandEnvironment = Object.freeze({ fileSystem, toolVersion: '0.0.0-test', now: () => new Date(0) });

/** 변경하지 않는 fixture의 완성된 graph만 재사용하고 fresh 검사에는 적용하지 않는다. */
function immutableGraph(project: string): Promise<CallGraph> {
  const existing = immutableGraphResults.get(project);
  if (existing !== undefined) return existing;
  const result = buildCallGraph(project, fileSystem);
  immutableGraphResults.set(project, result);
  return result;
}

/** 같은 고정 fixture와 인자의 schema 출력 문자열만 재사용한다. */
function immutableSchema(project: string): Promise<string> {
  const existing = immutableSchemaResults.get(project);
  if (existing !== undefined) return existing;
  const result = runSchemaCommand(['--project', project], immutableCommandEnvironment).then((command) => command.standardOutput);
  immutableSchemaResults.set(project, result);
  return result;
}

const graph = await immutableGraph(graphFixture);

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
  const projects = ['graph/next-prisma', 'graph/hono-d1-inline', 'graph/express-pg-inline', 'next/app-router', 'next/pages-api', 'node/hono-app',
    'node/express4-app', 'schema/prisma-app', 'schema/drizzle-d1-app'].map((name) => realpathSync(`${fixtures}${name}`));
  for (const project of projects) {
    const nodes = new Set((await immutableGraph(project)).nodes.map((node) => node.id));
    const routes = usrsOf((await runRoutesCommand(['--role', 'server', '--project', project, '--include-tests'], immutableCommandEnvironment)).standardOutput);
    const relations = usrsOf(await immutableSchema(project));
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
  const routeDocument = JSON.parse((await runRoutesCommand(['--role', 'server', '--project', project], immutableCommandEnvironment)).standardOutput) as {
    facts: { method: string; channel: string; symbol: { usr: string } }[];
  };
  const relationDocument = JSON.parse(await immutableSchema(project)) as {
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
  const honoGraph = await immutableGraph(hono);
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
  assert.deepEqual(await routeTables(express, await immutableGraph(express)), [
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

test('parse-error limitation은 안전한 상대 파일 10개와 생략 수만 싣는다', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-parse-error-files-')));
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{"private":true}');
    for (let index = 0; index < 12; index++) {
      writeFileSync(join(project, `src/bad${String(index).padStart(2, '0')}.ts`), 'export const = ;\n');
    }
    // Windows가 생성 자체를 금지하는 LF 대신 같은 교환 금지 문자 U+2028로 native 걷기를 검증한다.
    const unsafeName = process.platform === 'win32' ? 'bad\u2028unsafe.ts' : 'bad\nunsafe.ts';
    writeFileSync(join(project, 'src', unsafeName), 'export const = ;\n');
    const target = await buildCallGraph(project, fileSystem);
    const limitation = target.limitations.find((line) => line.startsWith('parse-errors:'));
    assert.equal(limitation,
      'parse-errors: 12 source file(s) have syntax errors; their calls may be incomplete; '
      + 'files: ["src/bad00.ts","src/bad01.ts","src/bad02.ts","src/bad03.ts","src/bad04.ts",'
      + '"src/bad05.ts","src/bad06.ts","src/bad07.ts","src/bad08.ts","src/bad09.ts"]; omitted: 2');
    assert.ok(!limitation?.includes(unsafeName));
    assert.ok(!limitation?.includes(project));
    assert.ok(target.limitations.includes(unsafeWalkNames(1)));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('indirect unresolved 통계는 관찰한 callee AST shape만 세분화한다', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-indirect-shapes-')));
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{"private":true}');
    writeFileSync(join(project, 'src/main.ts'), [
      'function first() { return 1; }',
      'function second() { return 2; }',
      'let identifier = first;',
      'identifier = second;',
      'const holder = { fn: first };',
      'holder.fn = second;',
      'holder["fn"] = first;',
      'export function run() { identifier(); holder.fn(); holder["fn"](); }',
      '',
    ].join('\n'));
    const target = await buildCallGraph(project, fileSystem);
    assert.equal(target.statistics.calls.unresolved.indirect, 3);
    assert.deepEqual(target.statistics.calls.indirectSites, {
      identifier: 1,
      property: 1,
      element: 1,
    });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

/** 읽지 못한 루트 vercel.json limitation이다. */
const unreadableCronConfig = 'entry-points: vercel.json could not be read as JSON within 1 MiB; scheduled entries are unknown';

/** 읽지 못한 루트 package.json 때문에 callable 흐름을 여는 limitation이다. */
const unreadableManifest = 'bound-dispatch: package.json could not be read as a JSON object within 1 MiB, so exported functions and classes and callable parameters are treated as reachable from unseen code and their flows are not bound';

/** callable 매개변수 공백이 있어 열린 프로그램 limitation이 실리는 소스다. */
const callableGapSource = 'export function run(callback: () => string) { return callback(); }\n';

test('FIFO·장치 링크인 루트 package.json·vercel.json은 기다리거나 끝없이 읽지 않고 기존 limitation으로 알린다', {
  skip: process.platform === 'win32',
}, async () => {
  const places = [makeFifo, linkToDevZero];
  const projects: string[] = [];
  try {
    for (const place of places) {
      const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-special-roots-')));
      projects.push(project);
      mkdirSync(join(project, 'src'));
      writeFileSync(join(project, 'src/main.ts'), callableGapSource);
      place(join(project, 'package.json'));
      place(join(project, 'vercel.json'));
    }
    // 두 특수 파일 종류의 프로젝트를 감시하는 자식 하나에서 차례로 분석한다.
    const { child, results } = await runCliGuarded(projects.map((project) => ['graph', '--project', project, '--generated-at', '2026-01-01T00:00:00.000Z']));
    assert.equal(child.stopped, undefined, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    for (const [index, place] of places.entries()) {
      const result = results[index];
      assert.ok(result !== undefined, place.name);
      assert.equal(result.exitCode, 0, `${place.name}: ${result.standardError}`);
      const { limitations } = JSON.parse(result.standardOutput) as { limitations: string[] };
      assert.ok(limitations.includes(unreadableCronConfig), place.name);
      assert.ok(limitations.includes(unreadableManifest), place.name);
    }
  } finally {
    for (const project of projects) rmSync(project, { recursive: true, force: true });
  }
});

test('루트 package.json·vercel.json symlink는 프로젝트 안 일반 파일을 가리켜도 따라가지 않는다', {
  skip: !constants.O_NOFOLLOW,
}, async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-linked-roots-')));
  try {
    mkdirSync(join(project, 'config'));
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'config/package.json'), '{"name":"lib","main":"src/main.ts"}');
    writeFileSync(join(project, 'config/vercel.json'), '{"crons":[{"path":"/api/jobs","schedule":"0 0 * * *"}]}');
    symlinkSync(join(project, 'config/package.json'), join(project, 'package.json'));
    symlinkSync(join(project, 'config/vercel.json'), join(project, 'vercel.json'));
    // 저장소 @types/node를 읽지 않는 설정이다(검사와 무관한 Program 비용, 이 절의 다른 테스트도 같다).
    writeFileSync(join(project, 'tsconfig.json'), ambientTypesFreeConfig);
    writeFileSync(join(project, 'src/main.ts'), callableGapSource);
    const target = await buildCallGraph(project, fileSystem);
    assert.ok(target.limitations.includes(unreadableCronConfig));
    assert.ok(target.limitations.includes(unreadableManifest));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('권한 때문에 읽지 못한 루트 vercel.json·package.json은 cron 없음·비공개로 숨기지 않는다', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-locked-roots-')));
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{"private":true}');
    writeFileSync(join(project, 'vercel.json'), '{"crons":[]}');
    writeFileSync(join(project, 'tsconfig.json'), ambientTypesFreeConfig);
    writeFileSync(join(project, 'src/main.ts'), callableGapSource);
    chmodSync(join(project, 'package.json'), 0o000);
    chmodSync(join(project, 'vercel.json'), 0o000);
    const target = await buildCallGraph(project, fileSystem);
    assert.ok(target.limitations.includes(unreadableCronConfig));
    assert.ok(target.limitations.includes(unreadableManifest));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

/**
 * 걷기가 건너뛴 금지 문자 이름의 limitation이다.
 *
 * @param count 건너뛴 이름 수
 * @returns limitation 문장
 */
function unsafeWalkNames(count: number): string {
  return `unsafe-names: ${count} file or directory name(s) contain characters the exchange format forbids and were skipped`;
}

/** 스캔이 불완전해 callable 흐름을 여는 limitation이다. */
const incompleteScanCallables = 'bound-dispatch: the scan is incomplete, so exported functions and classes and callable parameters are treated as reachable from unseen code and their flows are not bound';

test('금지 문자 이름의 파일·디렉터리는 노드로 만들지 않고 unsafe-names:와 불완전 스캔으로 알린다', {
  skip: process.platform === 'win32',
}, async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-unsafe-names-')));
  try {
    mkdirSync(join(project, 'src', 'dir\u{2028}x'), { recursive: true });
    writeFileSync(join(project, 'package.json'), '{"private":true}');
    writeFileSync(join(project, 'tsconfig.json'), ambientTypesFreeConfig);
    writeFileSync(join(project, 'src/main.ts'), callableGapSource);
    writeFileSync(join(project, 'src/a\u007fb.ts'), 'export function hidden() { return 1; }\n');
    writeFileSync(join(project, 'src/dir\u{2028}x/c.ts'), 'export function nested() { return 2; }\n');
    const target = await buildCallGraph(project, fileSystem);
    assert.deepEqual(target.nodes.filter((node) => !isSafeIdentifier(node.id) || !isSafeIdentifier(node.location.path)), []);
    assert.ok(target.nodes.some((node) => node.id === 'src/main.ts#run'));
    assert.ok(target.limitations.includes(unsafeWalkNames(2)));
    assert.ok(target.limitations.includes(incompleteScanCallables));
    assert.ok(target.limitations.some((line) => line.startsWith('effect-inventory: incomplete(coverage)')));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('컴파일러가 읽지 못한 소스는 노드 없이 건너뛰지 않고 unreadable-sources:와 불완전 스캔으로 알린다', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-compiler-unreadable-')));
  try {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{"private":true}');
    writeFileSync(join(project, 'tsconfig.json'), ambientTypesFreeConfig);
    writeFileSync(join(project, 'src/a.ts'), 'export interface Runner { run(): void }\n'
      + 'export class A implements Runner { run() { safe(); } }\nfunction safe() {}\n'
      + 'export function call(r: Runner) { r.run(); }\nexport function main() { call(new A()); }\n');
    // 읽지 못한 구현 B를 보지 못한 채 A.run만 관찰한 값으로 bound를 확정하면 안 된다.
    writeFileSync(join(project, 'src/b.ts'), "import { call, type Runner } from './a';\n"
      + 'export class B implements Runner { run() { danger(); } }\nfunction danger() {}\nexport function other() { call(new B()); }\n');
    chmodSync(join(project, 'src/b.ts'), 0o000);
    // TypeScript는 경로의 백슬래시를 구분자로 바꿔 읽으므로 이 이름(POSIX에서 쓸 수 있다)의 파일은 읽지 못한다.
    writeFileSync(join(project, 'src/back\\slash.ts'), 'export function back() { return 2; }\n');
    const target = await buildCallGraph(project, fileSystem);
    assert.deepEqual([...new Set(target.nodes.map((node) => node.location.path))], ['src/a.ts']);
    assert.deepEqual(target.edges.filter((edge) => edge.evidence === 'bound'), []);
    assert.ok(target.limitations.includes('unreadable-sources: 2 source file(s) could not be read by the compiler and were skipped'));
    assert.ok(target.limitations.includes('bound-dispatch: the scan is incomplete, so exported functions and classes and non-private properties are treated as reachable from unseen code and their flows are not bound'));
    assert.ok(target.limitations.some((line) => line.startsWith('effect-inventory: incomplete(coverage)')));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

/**
 * 합성 파일로 임시 프로젝트를 만들어 콜백에 넘기고 끝나면 지운다.
 *
 * @param files 프로젝트 기준 경로 → 내용
 * @param run 프로젝트 realpath를 받는 검사
 * @returns 검사 결과
 */
async function inSyntheticProject<T>(files: Readonly<Record<string, string>>, run: (project: string) => Promise<T>): Promise<T> {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-test-sources-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(project, path, '..'), { recursive: true });
      writeFileSync(join(project, path), content);
    }
    return await run(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

/** 운영 서비스다: 운영 코드만 보면 `persist`의 인터페이스 호출은 `SqlStore` 하나로만 흐른다. */
const persistService = [
  'export interface Store { save(value: string): void; }',
  'function write(value: string) { return value; }',
  'export class SqlStore implements Store { save(value: string) { write(value); } }',
  'export function persist(store: Store) { store.save("x"); }',
  'export function main() { persist(new SqlStore()); }',
].join('\n');

/** 프로젝트 구현이 없는 외부 목을 주입하는 테스트다. 운영 흐름에 섞이면 `persist`의 bound를 막는다. */
const externalMockTest = [
  'import { persist } from "../src/service";',
  'declare const vi: { fn(): (value: string) => void };',
  'export const check = () => persist({ save: vi.fn() });',
].join('\n');

/** 프로젝트 클래스 목을 주입하는 테스트다. 운영 흐름에 섞이면 production reach에 들어간다. */
const classMockTest = [
  'import { persist, type Store } from "../src/service";',
  'function recordCall(value: string) { return value; }',
  'class MockStore implements Store { save(value: string) { recordCall(value); } }',
  'export const check = () => persist(new MockStore());',
].join('\n');

/**
 * `persist`의 인터페이스 호출이 bound로 이어진 대상(정렬)이다.
 *
 * @param target 그래프
 * @returns 대상 id 목록
 */
function boundFromPersist(target: CallGraph): string[] {
  return target.edges.filter((edge) => edge.from === 'src/service.ts#persist' && edge.evidence === 'bound').map((edge) => edge.to).sort();
}

test('Node 백엔드를 감지하면 test/·tests/·e2e/ 아래 목은 운영 bound를 막지도 섞이지도 않는다(routes와 같은 테스트 규칙)', async () => {
  const express = JSON.stringify({ private: true, dependencies: { express: '4.21.2' } });
  for (const [path, mock] of [['test/service.ts', externalMockTest], ['test/service.ts', classMockTest], ['tests/service.ts', classMockTest], ['e2e/service.ts', externalMockTest]] as const) {
    const target = await inSyntheticProject({
      'package.json': express, 'tsconfig.json': ambientTypesFreeConfig, 'src/service.ts': persistService, [path]: mock,
    }, (project) => buildCallGraph(project, fileSystem));
    assert.deepEqual(boundFromPersist(target), ['src/service.ts#SqlStore.save'], path);
    const reached = traverse(target, {
      rootIds: ['src/service.ts#persist'], direction: 'dependencies', dispatch: 'bound', maxDepth: 8, maxReached: 100,
    }).reached.map((row) => row.id).sort();
    assert.deepEqual(reached, ['src/service.ts#SqlStore.save', 'src/service.ts#write'], path);
    // 테스트 안의 호출은 지금처럼 프로젝트 전체로 구한다: 테스트 함수에서 persist까지는 direct 간선이다.
    assert.ok(edgeLines(target).has(`${path}#check -> src/service.ts#persist call`), path);
  }
});

test('Node 백엔드를 감지하지 못한 프로젝트의 test/는 지금 규칙대로 운영 소스로 남는다', async () => {
  for (const [mock, expected] of [[externalMockTest, []], [classMockTest, ['src/service.ts#SqlStore.save', 'test/service.ts#MockStore.save']]] as const) {
    const target = await inSyntheticProject({
      'package.json': JSON.stringify({ private: true, dependencies: {} }), 'tsconfig.json': ambientTypesFreeConfig,
      'src/service.ts': persistService, 'test/service.ts': mock,
    }, (project) => buildCallGraph(project, fileSystem));
    assert.deepEqual(boundFromPersist(target), expected);
  }
});

test('Next 라우터 디렉터리 안의 test/ 폴더는 Node 백엔드를 감지해도 운영 소스다(app/api/test/route.ts는 /api/test)', async () => {
  const target = await inSyntheticProject({
    'package.json': JSON.stringify({ private: true, dependencies: { next: '16.2.7', express: '4.21.2' } }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/service.ts': persistService,
    'test/service.ts': externalMockTest,
    'app/api/test/route.ts': [
      'import { persist, type Store } from "../../../src/service";',
      'function audit(value: string) { return value; }',
      'class RouteStore implements Store { save(value: string) { audit(value); } }',
      'export function GET() { persist(new RouteStore()); return new Response("ok"); }',
    ].join('\n'),
  }, (project) => buildCallGraph(project, fileSystem));
  // route 파일의 구현은 운영 흐름이고, 라우터 디렉터리 밖 test/의 외부 목은 운영 흐름이 아니다.
  assert.deepEqual(boundFromPersist(target), ['app/api/test/route.ts#RouteStore.save', 'src/service.ts#SqlStore.save']);
  assert.deepEqual(target.nodes.find((node) => node.id === 'app/api/test/route.ts#GET')?.entries, ['route-handler']);
});

test('graph의 테스트 소스 판정은 routes가 route-decl에 다는 testSource와 같다(Next 라우터 디렉터리·Node 백엔드 소스)', async () => {
  /** Express 앱 하나가 경로 하나를 등록하는 소스다. */
  const expressApp = (path: string): string => `import express from "express";\nconst app = express();\napp.get("${path}", (req, res) => res.send("ok"));\nexport default app;\n`;
  await inSyntheticProject({
    'package.json': JSON.stringify({ private: true, dependencies: { next: '16.2.7', express: '4.21.2' } }),
    'tsconfig.json': ambientTypesFreeConfig,
    'app/api/test/route.ts': 'export async function GET() { return new Response("ok"); }\n',
    'pages/api/hello.test.ts': 'export default function handler(_request: unknown, response: { end(): void }) { response.end(); }\n',
    'src/server.ts': expressApp('/health'),
    'test/server.ts': expressApp('/fixture'),
    'e2e/app.ts': expressApp('/e2e'),
    'src/app.e2e.ts': expressApp('/suffix'),
  }, async (project) => {
    const result = await runRoutesCommand(['--role', 'server', '--project', project, '--include-tests'], immutableCommandEnvironment);
    assert.equal(result.exitCode, 0, result.standardError);
    const facts = (JSON.parse(result.standardOutput) as { facts: { testSource?: boolean; location: { path: string } }[] }).facts;
    const testSourceByPath = Object.fromEntries(facts.map((fact) => [fact.location.path, fact.testSource === true]));
    assert.deepEqual(testSourceByPath, {
      'app/api/test/route.ts': false,
      'e2e/app.ts': true,
      'pages/api/hello.test.ts': true,
      'src/app.e2e.ts': true,
      'src/server.ts': false,
      'test/server.ts': true,
    });
    const rule = projectTestSourceRule(await extractProjectRoutes(fileSystem, project, false));
    assert.deepEqual(rule, { nodeBackend: true, routerDirectories: ['app', 'pages'] });
    for (const [path, testSource] of Object.entries(testSourceByPath)) assert.equal(isProjectTestPath(path, rule), testSource, path);
  });
});

test('테스트 소스 판정: Next 라우터 디렉터리 안은 Next 규칙, 밖은 Node 백엔드를 감지했을 때만 Node 규칙', () => {
  const rules = {
    nodeWithRouters: { nodeBackend: true, routerDirectories: ['src/app', 'pages'] },
    nodeOnly: { nodeBackend: true, routerDirectories: [] },
    nextOnly: { nodeBackend: false, routerDirectories: ['app'] },
  };
  /** 경로마다 [nodeWithRouters, nodeOnly, nextOnly] 규칙의 기대 판정이다. */
  const cases: readonly (readonly [path: string, expected: readonly [boolean, boolean, boolean]])[] = [
    ['test/service.ts', [true, true, false]],
    ['tests/helpers/store.ts', [true, true, false]],
    ['e2e/app.ts', [true, true, false]],
    ['src/app.e2e.ts', [true, true, false]],
    ['test/app.e2e-spec.ts', [true, true, false]],
    ['src/service.test.ts', [true, true, true]],
    ['src/__mocks__/store.ts', [true, true, true]],
    ['src/app/api/test/route.ts', [false, true, false]],
    ['src/app/api/__tests__/route.ts', [true, true, true]],
    ['pages/test/index.ts', [false, true, false]],
    // 라우터 디렉터리는 경로 성분 단위로 맞춘다(`src/application`은 `src/app` 안이 아니다).
    ['src/application/test/store.ts', [true, true, false]],
    ['src/main.ts', [false, false, false]],
  ];
  for (const [path, expected] of cases) {
    assert.deepEqual([rules.nodeWithRouters, rules.nodeOnly, rules.nextOnly].map((rule) => isProjectTestPath(path, rule)), expected, path);
  }
});
