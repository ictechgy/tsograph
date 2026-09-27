/**
 * 인터페이스로 주입한 의존성의 bound·candidate 디스패치를 합성 fixture(`fixtures/graph/di-dispatch`)와
 * 임시 프로젝트로 검증한다: deps 객체·생성자 매개변수·팩터리·기본 매개변수·모듈 싱글턴 주입, 여러 조립 지점의
 * 여러 구현, 흐름을 증명하지 못하는 자리(호출자 없는 내보낸 함수·선언만 있는 함수·새어 나간 함수·진입점
 * 매개변수·공개 패키지·몽키 패치·반사적 쓰기·데코레이터), 모드별 미해석 계수, reach 문서의 evidence·
 * unresolvedCalls·dispatch, 결정성.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runReachCommand } from '../cli/graph-command.ts';
import { buildCallGraph } from './build-graph.ts';
import { computeGraphRevision } from './graph-document.ts';
import type { CallGraph } from './graph-model.ts';

const fixture = realpathSync(fileURLToPath(new URL('../../fixtures/graph/di-dispatch/', import.meta.url)));
const fileSystem = createNodeFileSystem();
const graph = await buildCallGraph(fixture, fileSystem);

/**
 * 근거가 direct가 아닌 간선을 `from -> to evidence` 문자열로 줄인다.
 *
 * @param target 그래프
 * @returns 간선 문자열(정렬 순서 그대로)
 */
function dispatchEdges(target: CallGraph): string[] {
  return target.edges.filter((edge) => edge.evidence !== 'direct').map((edge) => `${edge.from} -> ${edge.to} ${edge.evidence}`);
}

/**
 * 임시 프로젝트의 그래프를 만든다. tsconfig가 없으면 strict 기본값을 넣는다.
 *
 * @param files 상대 경로 → 내용
 * @returns 그래프
 */
async function graphOf(files: Record<string, string>): Promise<CallGraph> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-dispatch-')));
  try {
    const all = { 'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }', ...files };
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, fileSystem);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 임시 프로젝트들이 공유하는 인터페이스와 구현 두 개다. */
const storeModule = [
  'export interface Store { find(id: string): string; }',
  'export class RemoteStore implements Store { find(id: string) { return remote(id); } }',
  'export class LocalStore implements Store { find(id: string) { return id; } }',
  'function remote(id: string) { return id; }',
].join('\n');

test('fixture: 주입 방식별 bound 간선과 증명하지 못한 호출의 candidate 간선', () => {
  assert.deepEqual(dispatchEdges(graph), [
    // 진입점 매개변수(기본값이 있어도 프레임워크가 채운다)
    'src/app/api/items/route.ts#PATCH -> src/lib/store.ts#MemoryItemStore.findItem candidate',
    'src/app/api/items/route.ts#PATCH -> src/lib/store.ts#SqlItemStore.findItem candidate',
    // 인터페이스 타입 const에 담긴 팩터리 반환값(객체 리터럴의 화살표 멤버)
    'src/app/api/items/route.ts#PUT -> src/lib/lookup.ts#createLookup.run bound',
    // 기본 매개변수 DI
    'src/lib/defaults.ts#countItems -> src/lib/store.ts#MemoryItemStore.findItem bound',
    // deps 객체 주입: 두 조립 지점의 두 구현이 모두 이어진다
    'src/lib/handler.ts#ItemHandler.get -> src/lib/store.ts#MemoryItemStore.findItem bound',
    'src/lib/handler.ts#ItemHandler.get -> src/lib/store.ts#SqlItemStore.findItem bound',
    // 팩터리 매개변수의 deps 객체
    'src/lib/lookup.ts#createLookup.run -> src/lib/store.ts#SqlItemStore.findItem bound',
    // 호출자가 모두 프로젝트 안인 내보낸 함수
    'src/lib/open.ts#lookupAnywhere -> src/lib/store.ts#SqlItemStore.findItem bound',
    // 선언만 있는 함수의 반환값, 호출자 없는 내보낸 함수, 값으로 새어 나간 함수
    'src/lib/open.ts#lookupExternal -> src/lib/store.ts#MemoryItemStore.findItem candidate',
    'src/lib/open.ts#lookupExternal -> src/lib/store.ts#SqlItemStore.findItem candidate',
    'src/lib/open.ts#lookupUncalled -> src/lib/store.ts#MemoryItemStore.findItem candidate',
    'src/lib/open.ts#lookupUncalled -> src/lib/store.ts#SqlItemStore.findItem candidate',
    'src/lib/open.ts#viaCallback -> src/lib/store.ts#MemoryItemStore.saveItem candidate',
    'src/lib/open.ts#viaCallback -> src/lib/store.ts#SqlItemStore.saveItem candidate',
    // 생성자 매개변수 주입, 모듈 싱글턴(팩터리 반환값)
    'src/lib/service.ts#ItemService.save -> src/lib/store.ts#SqlItemStore.saveItem bound',
    'src/lib/singleton.ts#readSingleton -> src/lib/store.ts#SqlItemStore.findItem bound',
  ]);
  assert.deepEqual(graph.statistics.calls.dispatch, { bound: 7, boundPartial: 0, candidate: 4, candidatePartial: 0 });
  assert.equal(graph.statistics.calls.unresolved.interface, 11);
});

test('fixture: 노드별 미해석 계수는 모드마다 다르다', () => {
  const counts = Object.fromEntries(graph.nodes.filter((node) => node.unresolvedCalls !== undefined).map((node) => [node.id, node.unresolvedCalls]));
  assert.deepEqual(counts['src/lib/handler.ts#ItemHandler.get'], { direct: 1 });
  assert.deepEqual(counts['src/lib/open.ts#lookupUncalled'], { direct: 1, bound: 1 });
  assert.deepEqual(counts['src/app/api/items/route.ts#PATCH'], { direct: 1, bound: 1 });
  assert.equal(counts['src/lib/store.ts#SqlItemStore.findItem'], undefined);
});

test('fixture: reach는 모드별로 간선을 따르고 evidence·unresolvedCalls·dispatch를 싣는다', async () => {
  const environment = { fileSystem, toolVersion: '0.0.0-test', now: () => new Date(0) };
  const roots = ['src/app/api/items/route.ts#GET', 'src/app/api/items/route.ts#PATCH', 'src/app/api/lookup/route.ts#GET'];
  const documents = Object.fromEntries(await Promise.all(['direct', 'bound', 'candidates'].map(async (mode) => {
    const result = await runReachCommand(['--project', fixture, '--dispatch', mode, ...roots], environment);
    assert.equal(result.exitCode, 0, result.standardError);
    return [mode, JSON.parse(result.standardOutput)] as const;
  })));
  type Row = { symbol: { usr: string }; roots: number[]; evidence: string; unresolvedCalls?: number };
  const rowOf = (mode: string, usr: string): Row | undefined => documents[mode].reached.find((row: Row) => row.symbol.usr === usr);
  const query = 'src/lib/store.ts#SqlClient.query';
  assert.equal(rowOf('direct', query), undefined);
  assert.deepEqual([rowOf('bound', query)?.roots, rowOf('bound', query)?.evidence], [[0, 2], 'bound']);
  // candidates에서는 PATCH(1)도 닿고, 그 root는 candidate 간선으로만 닿으므로 하한은 candidate다.
  assert.deepEqual([rowOf('candidates', query)?.roots, rowOf('candidates', query)?.evidence], [[0, 1, 2], 'candidate']);
  assert.equal(rowOf('bound', 'src/compose.ts#primaryHandler'), undefined);
  assert.deepEqual(documents.direct.reached.map((row: Row) => row.evidence).filter((evidence: string) => evidence !== 'direct'), []);
  assert.deepEqual(documents.bound.roots.map((root: { unresolvedCalls?: number }) => root.unresolvedCalls), [undefined, 1, undefined]);
  assert.deepEqual(documents.direct.roots.map((root: { unresolvedCalls?: number }) => root.unresolvedCalls), [undefined, 1, undefined]);
  assert.deepEqual(documents.candidates.roots.map((root: { unresolvedCalls?: number }) => root.unresolvedCalls), [undefined, undefined, undefined]);
  assert.equal(rowOf('direct', 'src/lib/handler.ts#ItemHandler.get')?.unresolvedCalls, 1);
  assert.equal(rowOf('bound', 'src/lib/handler.ts#ItemHandler.get')?.unresolvedCalls, undefined);
  assert.deepEqual(['direct', 'bound', 'candidates'].map((mode) => documents[mode].dispatch), ['direct', 'bound', 'candidates']);
  assert.ok(!documents.direct.limitations.some((line: string) => line.startsWith('bound-dispatch:')));
  assert.ok(documents.bound.limitations.some((line: string) => line.startsWith('bound-dispatch: 7 call(s)')));
  assert.ok(!documents.bound.limitations.some((line: string) => line.startsWith('candidate-dispatch:')));
  assert.ok(documents.candidates.limitations.some((line: string) => line.startsWith('candidate-dispatch: 4 call(s)')));
  assert.equal(new Set(Object.values(documents).map((document) => document.graphRevision)).size, 1);
  // 다른 root에서 닿은 root는 roots[]와 reached[]에 같은 unresolvedCalls를 싣는다(계약 검사 항목).
  const overlap = JSON.parse((await runReachCommand(['--project', fixture, '--dispatch', 'direct', roots[0]!, 'src/lib/handler.ts#ItemHandler.get'], environment)).standardOutput);
  const reachedRoot = overlap.reached.find((row: Row) => row.symbol.usr === 'src/lib/handler.ts#ItemHandler.get');
  assert.deepEqual([overlap.roots[1].unresolvedCalls, reachedRoot.unresolvedCalls, reachedRoot.roots], [1, 1, [0]]);
});

test('fixture: 같은 입력은 같은 그래프이고 graphRevision은 간선 근거를 덮는다', async () => {
  const again = await buildCallGraph(fixture, fileSystem);
  assert.deepEqual(again, graph);
  const flattened: CallGraph = { ...graph, edges: graph.edges.map((edge) => ({ ...edge, evidence: 'direct' as const })) };
  assert.notEqual(computeGraphRevision(flattened), computeGraphRevision(graph));
  const uncounted: CallGraph = { ...graph, nodes: graph.nodes.map(({ unresolvedCalls: _ignored, ...node }) => node) };
  assert.notEqual(computeGraphRevision(uncounted), computeGraphRevision(graph));
});

test('공개 패키지와 불완전 스캔에서는 내보낸 선언의 흐름을 증명하지 않는다', async () => {
  const files = {
    'src/store.ts': storeModule,
    'src/service.ts': 'import type { Store } from "./store";\nexport class Service { constructor(private readonly store: Store) {} run() { return this.store.find("a"); } }\n',
    'src/main.ts': 'import { Service } from "./service";\nimport { RemoteStore } from "./store";\nexport const run = () => new Service(new RemoteStore()).run();\n',
  };
  assert.deepEqual(dispatchEdges(await graphOf(files)), ['src/service.ts#Service.run -> src/store.ts#RemoteStore.find bound']);
  const published = await graphOf({ ...files, 'package.json': '{ "name": "lib", "exports": "./src/main.ts" }' });
  assert.deepEqual(dispatchEdges(published), [
    'src/service.ts#Service.run -> src/store.ts#LocalStore.find candidate',
    'src/service.ts#Service.run -> src/store.ts#RemoteStore.find candidate',
  ]);
  assert.ok(published.limitations.includes('bound-dispatch: package.json declares public entry points, so exported functions and classes and non-private properties are treated as reachable from unseen code and their flows are not bound'));
  const unreadable = await graphOf({ ...files, 'package.json': '{ "name": ' });
  assert.ok(unreadable.limitations.some((line) => line.startsWith('bound-dispatch: package.json could not be read')));
  assert.equal(dispatchEdges(unreadable).filter((line) => line.endsWith(' bound')).length, 0);
  assert.deepEqual(dispatchEdges(await graphOf({ ...files, 'package.json': '{ "name": "app", "private": true }' })).length, 1);
  const broken = await graphOf({ ...files, 'src/broken.ts': 'export const x = (;\n' });
  assert.ok(broken.limitations.some((line) => line.startsWith('bound-dispatch: the scan is incomplete')));
  assert.equal(dispatchEdges(broken).filter((line) => line.endsWith(' bound')).length, 0);
});

test('몽키 패치·반사적 쓰기·데코레이터·동적 import·값으로 쓰인 네임스페이스는 흐름을 연다', async () => {
  const shared = { 'src/store.ts': storeModule };
  const patched = await graphOf({
    ...shared,
    'src/main.ts': 'import { RemoteStore, type Store } from "./store";\nconst store: Store = make();\nfunction make(): Store { const s = new RemoteStore(); s.find = () => "x"; return s; }\nexport const run = () => store.find("a");\n',
  });
  assert.deepEqual(dispatchEdges(patched).filter((line) => line.endsWith(' bound')), []);
  const reflective = await graphOf({
    ...shared,
    'src/main.ts': 'import { RemoteStore, type Store } from "./store";\nconst deps: { store: Store } = { store: new RemoteStore() };\nObject.assign(deps, load());\ndeclare function load(): object;\nexport const run = () => deps.store.find("a");\nexport const err = () => Object.assign(new Error("x"), { code: 1 });\n',
  });
  assert.deepEqual(dispatchEdges(reflective).filter((line) => line.endsWith(' bound')), []);
  const decorated = await graphOf({
    ...shared,
    'src/main.ts': 'import { RemoteStore, type Store } from "./store";\nfunction injectable<T>(value: T) { return value; }\n@injectable class Service { constructor(private readonly store: Store) {} run() { return this.store.find("a"); } }\nexport const run = () => new Service(new RemoteStore()).run();\n',
  });
  assert.deepEqual(dispatchEdges(decorated).filter((line) => line.endsWith(' bound')), []);
  const lazy = await graphOf({
    ...shared,
    'src/use.ts': 'import type { Store } from "./store";\nexport function use(store: Store) { return store.find("a"); }\n',
    'src/main.ts': 'import { RemoteStore } from "./store";\nimport { use } from "./use";\nexport const run = () => use(new RemoteStore());\nexport const later = () => import("./use");\n',
  });
  assert.deepEqual(dispatchEdges(lazy).filter((line) => line.endsWith(' bound')), []);
  const namespace = {
    ...shared,
    'src/use.ts': 'import type { Store } from "./store";\nexport function use(store: Store) { return store.find("a"); }\n',
    'src/main.ts': 'import { RemoteStore } from "./store";\nimport * as uses from "./use";\nexport const run = () => uses.use(new RemoteStore());\n',
  };
  assert.deepEqual(dispatchEdges(await graphOf(namespace)), ['src/use.ts#use -> src/store.ts#RemoteStore.find bound']);
  const escaped = await graphOf({ ...namespace, 'src/leak.ts': 'import * as uses from "./use";\nexport const all = uses;\n' });
  assert.deepEqual(dispatchEdges(escaped).filter((line) => line.endsWith(' bound')), []);
});

test('하위 클래스 생성·super 인자·this 필드·재대입 변수·구조 분해·getter·조건식·async 팩터리를 따라간다', async () => {
  const result = await graphOf({
    'src/store.ts': storeModule,
    'src/base.ts': [
      'import { LocalStore, RemoteStore, type Store } from "./store";',
      'export class Base { constructor(protected readonly store: Store) {} run() { return this.store.find("a"); } }',
      'export class Implicit extends Base {}',
      'export class Explicit extends Base { constructor() { super(new LocalStore()); } }',
      'export const made = [new Implicit(new RemoteStore()), new Explicit()];',
      'let current: Store = new RemoteStore();',
      'export function swap() { current = new LocalStore(); }',
      'export function readCurrent() { return current.find("b"); }',
      'function destructured({ store }: { store: Store }) { return store.find("c"); }',
      'export const viaDestructuring = () => destructured({ store: new RemoteStore() });',
      'class Holder { private readonly inner: Store = new LocalStore(); get store(): Store { return this.inner; } read() { return this.store.find("d"); } }',
      'export const holder = new Holder();',
      'declare const flag: boolean;',
      'const chosen: Store = flag ? new RemoteStore() : new LocalStore();',
      'export const readChosen = () => chosen.find("e");',
      'async function build(): Promise<Store> { return new RemoteStore(); }',
      'export async function readBuilt() { const store = await build(); return store.find("f"); }',
    ].join('\n'),
  });
  assert.deepEqual(dispatchEdges(result), [
    'src/base.ts#Base.run -> src/store.ts#LocalStore.find bound',
    'src/base.ts#Base.run -> src/store.ts#RemoteStore.find bound',
    'src/base.ts#Holder.read -> src/store.ts#LocalStore.find bound',
    'src/base.ts#destructured -> src/store.ts#RemoteStore.find bound',
    'src/base.ts#readBuilt -> src/store.ts#RemoteStore.find bound',
    'src/base.ts#readChosen -> src/store.ts#LocalStore.find bound',
    'src/base.ts#readChosen -> src/store.ts#RemoteStore.find bound',
    'src/base.ts#readCurrent -> src/store.ts#LocalStore.find bound',
    'src/base.ts#readCurrent -> src/store.ts#RemoteStore.find bound',
  ]);
});

test('union 수신자의 인터페이스 부분만 bound로 잇고, 순환 흐름도 끝난다', async () => {
  const result = await graphOf({
    'src/store.ts': storeModule,
    'src/main.ts': [
      'import { LocalStore, RemoteStore, type Store } from "./store";',
      'class Direct { find(id: string) { return id; } }',
      'const either: Direct | Store = pick();',
      'function pick(): Direct | Store { return new RemoteStore(); }',
      'export const readEither = () => either.find("a");',
      'let a: Store = new LocalStore();',
      'let b: Store = a;',
      'export function rotate() { a = b; b = a; }',
      'export const readA = () => a.find("b");',
      'export { a as aliasA };',
    ].join('\n'),
  });
  const lines = result.edges.filter((edge) => edge.from.endsWith('readEither') || edge.from.endsWith('readA')).map((edge) => `${edge.from} -> ${edge.to} ${edge.evidence}`);
  assert.deepEqual(lines, [
    'src/main.ts#readA -> src/store.ts#LocalStore.find bound',
    'src/main.ts#readEither -> src/main.ts#Direct.find direct',
    'src/main.ts#readEither -> src/store.ts#RemoteStore.find bound',
  ]);
  assert.deepEqual(result.statistics.calls.dispatch, { bound: 1, boundPartial: 1, candidate: 0, candidatePartial: 0 });
});

test('진입점 별칭(export { h as GET })의 대상 함수 매개변수는 열린 자리다', async () => {
  const result = await graphOf({
    'package.json': '{ "dependencies": { "next": "16.2.7" } }',
    'src/store.ts': storeModule,
    'app/api/x/route.ts': [
      'import { LocalStore, type Store } from "../../../src/store";',
      'async function handle(request: Request, store: Store = new LocalStore()) { return new Response(store.find(request.url)); }',
      'export { handle as GET };',
    ].join('\n'),
  });
  assert.deepEqual(dispatchEdges(result), [
    'app/api/x/route.ts#handle -> src/store.ts#LocalStore.find candidate',
    'app/api/x/route.ts#handle -> src/store.ts#RemoteStore.find candidate',
  ]);
});

test('모듈 200개에 흩어진 주입 호출도 모두 bound로 잇고 예산 안에 끝난다', async () => {
  const count = 200;
  const files: Record<string, string> = { 'src/store.ts': storeModule };
  for (let index = 0; index < count; index++) {
    const previous = index === 0 ? '' : `import { handler${index - 1} } from "./handler${index - 1}";\n`;
    const chain = index === 0 ? '' : ` handler${index - 1}.handle();`;
    files[`src/handler${index}.ts`] = [
      'import { LocalStore, RemoteStore, type Store } from "./store";',
      previous,
      `export interface Deps${index} { store: Store; fallback?: Store }`,
      `export class Handler${index} {`,
      `  constructor(private readonly deps: Deps${index}) {}`,
      `  handle(): string {${chain} return this.deps.store.find("${index}"); }`,
      '}',
      `export const handler${index} = new Handler${index}({ store: ${index % 2 === 0 ? 'new RemoteStore()' : 'new LocalStore()'} });`,
    ].join('\n');
  }
  const started = performance.now();
  const result = await graphOf(files);
  const elapsed = performance.now() - started;
  assert.equal(result.statistics.calls.dispatch.bound, count);
  assert.equal(result.edges.filter((edge) => edge.evidence === 'bound').length, count);
  assert.ok(elapsed < 60_000, `took ${Math.round(elapsed)} ms`);
});
