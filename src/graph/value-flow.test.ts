/**
 * 값 흐름 분석(`value-flow.ts`)의 식·선언 종류별 규칙을 한 합성 프로젝트의 탐침 함수들로 검증한다.
 * 탐침마다 bound 대상이 기대와 같아야 하고, 증명하지 못하는 경우("none")에는 bound 간선이 없어야 한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { buildFileIndex, type FlowIndex } from './flow-index.ts';
import type { CallGraph } from './graph-model.ts';
import { type FlowPolicy, ValueFlow } from './value-flow.ts';

/**
 * 임시 프로젝트의 그래프를 만든다.
 *
 * @param files 상대 경로 → 내용
 * @returns 그래프
 */
async function graphOf(files: Record<string, string>): Promise<CallGraph> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-flow-')));
  try {
    const all = { 'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }', ...files };
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, createNodeFileSystem());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REMOTE = 'src/store.ts#RemoteStore.find';
const LOCAL = 'src/store.ts#LocalStore.find';

/** 탐침 코드와 기대(bound 대상 id 목록, 또는 bound가 없어야 하면 'none')다. */
const probes: readonly (readonly [from: string, expected: readonly string[] | 'none', code: string])[] = [
  ['p01', [REMOTE], 'class Config01 { static store01: Store = new RemoteStore(); }\nexport function p01() { return Config01.store01.find("x"); }'],
  ['p02', [LOCAL], 'export function p02() { return registry.store.find("x"); }'],
  ['p03', [LOCAL], 'function pick03(): Store | null { return null; }\nconst s03: Store = pick03() ?? new LocalStore();\nexport function p03() { return s03.find("x"); }'],
  ['p04', [REMOTE], 'declare const n04: number;\nconst s04: Store = (n04, new RemoteStore());\nexport function p04() { return s04.find("x"); }'],
  ['p05', [REMOTE], 'const bag05: { store05: Store } = { store05: new RemoteStore() };\nexport function p05() { return bag05["store05"].find("x"); }'],
  ['p06', [LOCAL], 'const base06 = { store: new LocalStore() as Store };\nconst full06 = { ...base06, extra: 1 };\nexport function p06() { return full06.store.find("x"); }'],
  ['p07', 'none', 'const key07 = "store" as string;\nconst bag07 = { [key07]: new RemoteStore() } as unknown as { store: Store };\nexport function p07() { return bag07.store.find("x"); }'],
  ['p08', 'none', 'const bag08 = { get store(): Store { return new RemoteStore(); } };\nexport function p08() { return bag08.store.find("x"); }'],
  ['p09', 'none', 'const stores09: Store[] = [new RemoteStore()];\nexport function p09() { for (const s of stores09) s.find("x"); }'],
  ['p11', 'none', 'declare const external11: Store;\nexport function p11() { return external11.find("x"); }'],
  ['p12', 'none', 'const [first12] = [new RemoteStore() as Store];\nexport function p12() { return first12.find("x"); }'],
  ['take13', 'none', 'function take13(...stores: Store[]) { return stores[0]!.find("x"); }\nexport const p13 = () => take13(new RemoteStore());'],
  ['take14', 'none', 'function take14(a: string, store: Store) { return store.find(a); }\nconst args14: [string, Store] = ["x", new RemoteStore()];\nexport const p14 = () => take14(...args14);'],
  ['take15', [LOCAL], 'function take15(this: void, store: Store) { return store.find("x"); }\nexport const p15 = () => take15(new LocalStore());'],
  ['p17', ['src/main.ts#make17', 'src/main.ts#reset17'], 'let make17 = (): Store => new RemoteStore();\nexport function reset17() { make17 = () => new LocalStore(); }\nexport function p17() { return make17().find("x"); }'],
  ['H18.run', 'none', 'function tag18(_value: undefined, _context: unknown) {}\nclass H18 { @tag18 store: Store = new RemoteStore(); run() { return this.store.find("x"); } }\nexport const h18 = new H18();'],
  ['H19.run', 'none', 'class H19 { declare store: Store; run() { return this.store.find("x"); } }\nexport const h19 = new H19();'],
  ['H20.run', 'none', 'class H20 { constructor(private readonly store: Store) {} static make() { return new this(new RemoteStore()); } run() { return this.store.find("x"); } }\nexport const h20 = new H20(new LocalStore());'],
  ['K21.run', [REMOTE], 'const K21 = class { constructor(private readonly store21: Store) {} run() { return this.store21.find("x"); } };\nexport const k21 = new K21(new RemoteStore());'],
  ['p21b', ['src/main.ts#make21b.find'], 'function make21b(): Store { return new (class implements Store { find(id: string) { return id; } })(); }\nconst s21b = make21b();\nexport function p21b() { return s21b.find("x"); }'],
  ['H22.run', 'none', 'class H22 { static store: Store = new RemoteStore(); static run() { return this.store.find("x"); } }\nexport const r22 = () => H22.run();'],
  ['obj23.run', 'none', 'export const obj23 = { store: new RemoteStore() as Store, run() { return this.store.find("x"); } };'],
  ['tag24', 'none', 'function tag24(parts: TemplateStringsArray, store: Store) { return store.find(parts[0]!); }\nexport const p24 = () => tag24`x${new RemoteStore()}`;'],
  ['H25.run', [LOCAL], 'class H25 { static label = "x"; constructor(private readonly store: Store) {} run() { return this.store.find(H25.label); } }\nconst h25 = new H25(new LocalStore());\nexport const is25 = h25 instanceof H25 && typeof H25 === "function";'],
  ['H26.run', 'none', 'class H26 { constructor(private readonly store: Store) {} run() { return this.store.find("x"); } }\nexport const h26 = new H26(new LocalStore());\nexport const ctor26 = H26;'],
  ['B27.run', [REMOTE], 'class B27 { constructor(protected readonly store27: Store) {} run() { return this.store27.find("x"); } }\nclass C27 extends B27 { constructor() { const make = () => new RemoteStore(); super(make()); } }\nexport const c27 = new C27();'],
  ['p28', 'none', 'class F28 { make(): Store { return new RemoteStore(); } }\nclass G28 extends F28 { override make(): Store { return new LocalStore(); } }\nfunction pickF28(): F28 { return new G28(); }\nconst f28: F28 = pickF28();\nexport function p28() { return f28.make().find("x"); }'],
  ['p29', [LOCAL], 'interface Factory29 { make(): Store }\nconst factory29: Factory29 = { make: () => new LocalStore() };\nexport function p29() { return factory29.make().find("x"); }'],
  ['p30', [REMOTE], 'function wrap30<T>(value: T): T { return value; }\nconst s30: Store = wrap30(new RemoteStore());\nexport function p30() { return s30.find("x"); }'],
  ['p31', [LOCAL, REMOTE], 'const deps31: { store: Store } = { store: new RemoteStore() };\nexport function swap31() { deps31.store = new LocalStore(); }\nexport function p31() { return deps31.store.find("x"); }'],
  // 서로 대입될 수 없는 명목 클래스(비공개 멤버)끼리는 다른 클래스의 같은 이름 필드 쓰기가 닿지 않는다.
  ['H32.run', [LOCAL], 'class Other32 { private readonly tag32 = 1; s32: Store = new RemoteStore(); }\nconst o32 = new Other32();\nexport function write32() { o32.s32 = new RemoteStore(); }\nclass H32 { private readonly mark32 = 2; s32: Store = new LocalStore(); run() { return this.s32.find("x"); } }\nexport const h32 = new H32();'],
  ['take33', 'none', 'function take33(store: Store) { return store.find("x"); }\nexport const p33 = () => take33.call(null, new RemoteStore());'],
  ['p35', [REMOTE], 'let s35: Store | undefined;\nexport function init35() { s35 ||= new RemoteStore(); }\nexport function p35() { return s35!.find("x"); }'],
  ['p36', 'none', 'let s36: Store = new RemoteStore();\nexport function set36(o: { s: Store }) { ({ s: s36 } = o); }\nexport function p36() { return s36.find("x"); }'],
  ['p37', 'none', 'let s37: Store = new RemoteStore();\nexport function set37(list: Store[]) { for (s37 of list) break; }\nexport function p37() { return s37.find("x"); }'],
  ['p38', [LOCAL], 'const s38: Store = void 0 ?? new LocalStore();\nexport function p38() { return s38.find("x"); }'],
  ['p39', 'none', 'function make39(): Store { return Math.random() > 0.5 ? new RemoteStore() : ([] as unknown as Store); }\nconst s39 = make39();\nexport function p39() { return s39.find("x"); }'],
  ['p40', [LOCAL], 'async function build40(): Promise<Store> { return new LocalStore(); }\nexport async function p40() { const store = await build40(); return store.find("x"); }'],
  ['p41', 'none', 'function* gen41(): Generator<number, Store> { yield 1; return new RemoteStore(); }\nexport function p41() { const s: Store = gen41() as unknown as Store; return s.find("x"); }'],
  // 별칭 300단 사슬은 질의 깊이 예산(256)을 넘는다: 추측하지 않고 모름으로 둔다.
  ['p42', 'none', `const chain0: Store = new LocalStore();\n${Array.from({ length: 300 }, (_, index) => `const chain${index + 1}: Store = chain${index};`).join('\n')}\nexport function p42() { return chain300.find("x"); }`],
];

/** 탐침이 쓰는 인터페이스·구현과 네임스페이스로 읽는 모듈이다. */
const support = {
  'src/store.ts': [
    'export interface Store { find(id: string): string; }',
    'export class RemoteStore implements Store { find(id: string) { return id; } }',
    'export class LocalStore implements Store { find(id: string) { return id; } }',
  ].join('\n'),
  'src/registry.ts': 'import { LocalStore, type Store } from "./store";\nexport let store: Store = new LocalStore();\n',
};

test('값 흐름 규칙: 탐침별 bound 대상', async () => {
  const header = 'import { LocalStore, RemoteStore, type Store } from "./store";\nimport * as registry from "./registry";\n';
  const graph = await graphOf({ ...support, 'src/main.ts': header + probes.map(([, , code]) => code).join('\n') + '\n' });
  const failures: string[] = [];
  for (const [from, expected] of probes) {
    const id = `src/main.ts#${from}`;
    const bound = graph.edges.filter((edge) => edge.from === id && edge.evidence === 'bound').map((edge) => edge.to);
    const wanted = expected === 'none' ? [] : [...expected];
    if (JSON.stringify(bound) !== JSON.stringify(wanted)) failures.push(`${from}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(bound)}`);
    const isPending = graph.nodes.find((node) => node.id === id)?.unresolvedCalls?.direct !== undefined;
    if (!isPending) failures.push(`${from}: expected an interface call counted in direct mode`);
  }
  assert.deepEqual(failures, []);
});

test('테스트 소스의 목은 운영 호출의 bound를 막지 않고, 테스트 안의 호출은 전체 흐름으로 구한다', async () => {
  const files = {
    ...support,
    'src/service.ts': 'import type { Store } from "./store";\nexport function lookup(store: Store) { return store.find("a"); }\n',
    'src/main.ts': [
      'import { lookup } from "./service";',
      'import { RemoteStore } from "./store";',
      'function first() { return "first"; }',
      'export const box = { callback: first };',
      'export const runDirect = () => box.callback();',
      'export const run = () => lookup(new RemoteStore());',
    ].join('\n'),
    'src/service.test.ts': [
      'import { lookup } from "./service";',
      'import { box } from "./main";',
      'import type { Store } from "./store";',
      'declare function mockFn(): (id: string) => string;',
      'function mock() { return "mock"; }',
      'box.callback = mock;',
      'const fake: Store = { find: mockFn() };',
      'export const check = () => lookup(fake);',
      'export const direct = () => fake.find("b");',
      'export const callBox = () => box.callback();',
    ].join('\n'),
  };
  const graph = await graphOf(files);
  const lines = graph.edges.filter((edge) => edge.evidence !== 'direct').map((edge) => `${edge.from} -> ${edge.to} ${edge.evidence}`);
  assert.deepEqual(lines, [
    'src/service.test.ts#callBox -> src/main.ts#first bound',
    'src/service.test.ts#callBox -> src/service.test.ts#mock bound',
    `src/service.test.ts#direct -> ${LOCAL} candidate`,
    `src/service.test.ts#direct -> ${REMOTE} candidate`,
    `src/service.ts#lookup -> ${REMOTE} bound`,
  ]);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#runDirect' && edge.kinds.includes('call')).map((edge) => [edge.to, edge.evidence]), [
    ['src/main.ts#first', 'direct'],
  ]);
  // 테스트가 아닌 파일이 테스트 소스를 불러오면 둘을 나눌 수 없어 전체 흐름으로 구한다(목 때문에 bound 없음).
  for (const wire of [
    'import { check } from "./service.test";\nexport const wired = check;\n',
    'declare const flag: boolean;\nexport const wired = () => import(flag ? "./service.test" : "./main");\n',
  ]) {
    const mixed = await graphOf({ ...files, 'src/wire.ts': wire });
    assert.deepEqual(mixed.edges.filter((edge) => edge.from === 'src/service.ts#lookup' && edge.evidence === 'bound'), [], wire);
  }
});

test('동적 import는 고를 수 있는 문자열 모듈만 열고, 문자열이 아니면 모든 내보내기를 연다', async () => {
  const files = {
    ...support,
    'src/a.ts': 'import type { Store } from "./store";\nexport function useA(store: Store) { return store.find("a"); }\n',
    'src/b.ts': 'import type { Store } from "./store";\nexport function useB(store: Store) { return store.find("b"); }\n',
    'src/main.ts': [
      'import { useA } from "./a";',
      'import { useB } from "./b";',
      'import { RemoteStore } from "./store";',
      'export const run = () => [useA(new RemoteStore()), useB(new RemoteStore())];',
      'declare const flag: boolean;',
      'export const later = () => import(flag ? "./a" : "./missing");',
    ].join('\n'),
  };
  const bound = (graph: CallGraph): string[] => graph.edges.filter((edge) => edge.evidence === 'bound').map((edge) => edge.from);
  assert.deepEqual(bound(await graphOf(files)), ['src/b.ts#useB']);
  const opaque = await graphOf({ ...files, 'src/load.ts': 'declare const name: string;\nexport const load = () => import(name);\n' });
  assert.deepEqual(bound(opaque), []);
  const globbed = await graphOf({ ...files, 'src/load.ts': 'declare global { interface ImportMeta { glob(pattern: string): unknown } }\nexport const load = () => import.meta.glob("./*.ts");\n' });
  assert.deepEqual(bound(globbed), []);
});

/** 리뷰 반례 프로젝트: `withCache()`가 다른 구현을 돌려주는 인터페이스다. */
const cachingStore = [
  'export interface Store { find(id: string): string; withCache(): Store; }',
  'export class LocalStore implements Store { find(id: string) { return id; } withCache(): Store { return new CachedStore(); } }',
  'export class RemoteStore implements Store { find(id: string) { return id; } withCache(): Store { return this; } }',
  'export class CachedStore implements Store { find(id: string) { return id; } withCache(): Store { return this; } }',
].join('\n');

const CACHED = 'src/store.ts#CachedStore.find';

test('리뷰 반례: 순환·구조적 쓰기·반사적 쓰기·배럴·mixin·데코레이터·bind·let 별칭·namespace 변수', async () => {
  const main = [
    'import { LocalStore, RemoteStore, type Store } from "./store";',
    'import { handle7 } from "./impl";',
    'interface Node1 { s1: Store; next?: Node1 }',
    'const n1: Node1 = { s1: new LocalStore() };',
    'const n2: Node1 = { s1: new RemoteStore(), next: n1 };',
    'let cur1: Node1 = n2;',
    'export function advance1() { cur1 = cur1.next!; }',
    'export function p1() { return cur1.s1.find("x"); }',
    'class Holder2 { s2: Store = new LocalStore(); upgrade() { this.s2 = this.s2.withCache(); } run() { return this.s2.find("x"); } }',
    'export const h2 = new Holder2();',
    'function wrap3(s: Store, n: number): Store { return n > 0 ? wrap3(s.withCache(), n - 1) : s; }',
    'const w3: Store = wrap3(new LocalStore(), 2);',
    'export function p3() { return w3.find("x"); }',
    'class Box4 { s4: Store = new LocalStore(); run() { return this.s4.find("x"); } }',
    'class Other4 { s4: Store = new LocalStore(); }',
    'export const b4 = new Box4();',
    'export function swap4() { const o: Other4 = b4; o.s4 = new RemoteStore(); }',
    'interface Factory5 { make(): Store }',
    'const f5: Factory5 = { make: () => new LocalStore() };',
    'Object.assign(f5, { make: () => new RemoteStore() });',
    'const s5: Store = f5.make();',
    'export function p5() { return s5.find("x"); }',
    'class F6 { make(): Store { return new LocalStore(); } }',
    'const f6 = new F6();',
    'Object.assign(f6, { make: () => new RemoteStore() });',
    'const s6: Store = f6.make();',
    'export function p6() { return s6.find("x"); }',
    'export const r7 = () => handle7(new LocalStore());',
    'export const later7 = async () => { const m = await import("./index7"); return m.handle7(new RemoteStore()); };',
    'function Mixin8<T extends new (...args: any[]) => object>(Base: T) { return class extends Base {}; }',
    'class H8 { s8: Store = new LocalStore(); run() { return this.s8.find("x"); } }',
    'class Sub8 extends Mixin8(H8) { s8: Store = new RemoteStore(); }',
    'export const x8 = [new H8(), new Sub8()];',
    'function swap9(value: unknown, _context: ClassMethodDecoratorContext) { return value as () => Store; }',
    'class F9 { @swap9 make(): Store { return new LocalStore(); } }',
    'const s9: Store = new F9().make();',
    'export function p9() { return s9.find("x"); }',
    'class H10 { s10: Store = new LocalStore(); run10() { return this.s10.find("x"); } }',
    'const h10 = new H10();',
    'export const bound10 = h10.run10.bind({ s10: new RemoteStore() });',
    'let impl11 = (id: string) => id;',
    'export function reset11() { impl11 = (id: string) => `${id}!`; }',
    'function make11(): Store { return { find: impl11, withCache: () => new LocalStore() }; }',
    'const s11 = make11();',
    'export function p11() { return s11.find("x"); }',
    'const impl12 = (id: string) => id;',
    'function make12(): Store { return { find: impl12, withCache: () => new LocalStore() }; }',
    'const s12 = make12();',
    'export function p12() { return s12.find("x"); }',
    'namespace N13 { export let s13: Store = new LocalStore(); }',
    'export function set13() { N13.s13 = new RemoteStore(); }',
    'export function p13() { return N13.s13.find("x"); }',
    'class B14 { s14: Store = new LocalStore(); run() { return this.s14.find("x"); } }',
    'class Sub14 extends B14 { extra14 = 1; }',
    'export const k14 = new Sub14();',
    'export function write14(s: Sub14) { s.s14 = new RemoteStore(); }',
    'class B15 { s15: Store = new LocalStore(); run() { return this.s15.find("x"); } }',
    'class Sub15 extends B15 { extra15 = 1; swap() { this.s15 = new RemoteStore(); } }',
    'export const k15 = [new B15(), new Sub15()];',
    'class B16 { constructor(public s16: Store) {} run() { return this.s16.find("x"); } }',
    'class Sub16 extends B16 { extra16 = 1; }',
    'export const k16 = new B16(new LocalStore());',
    'export function write16(s: Sub16) { s.s16 = new RemoteStore(); }',
    'class B17 { make17(): Store { return new LocalStore(); } }',
    'class Sub17 extends B17 { extra17 = 1; }',
    'export function patch17(x: Sub17) { x.make17 = () => new RemoteStore(); }',
    'const s17: Store = new B17().make17();',
    'export function p17() { return s17.find("x"); }',
    'class H18 { s18: Store = new LocalStore(); run() { return this.s18.find("x"); } }',
    'class Special18 extends H18 { extra18 = 1; }',
    'const specials18: Special18[] = [];',
    'export function write18(h: H18) { const view: H18[] = specials18; view.push(h); specials18[0]!.s18 = new RemoteStore(); }',
    'export const h18 = new H18();',
    'class H19 { s19: Store = new LocalStore(); run() { return this.s19.find("x"); } }',
    'class Special19 extends H19 { extra19 = 1; }',
    'interface Handler19 { handle(s: H19): void }',
    'const handler19: Handler19 = { handle(s: Special19) { s.s19 = new RemoteStore(); } };',
    'export function call19() { handler19.handle(new H19()); }',
    'class B20 { s20: Store = new LocalStore(); run20() { return this.s20.find("x"); } }',
    'class Sub20 extends B20 { extra20 = 1; }',
    'const sub20 = new Sub20();',
    'export const b20 = sub20.run20.bind({ s20: new RemoteStore(), extra20: 2 });',
    'class H21 { s21: Store = new LocalStore(); run21() { return this.s21.find("x"); } }',
    'const h21 = new H21();',
    'let run21: () => string = () => "";',
    'export function detach21() { ({ run21: run21 } = h21); return run21.call({ s21: new RemoteStore() }); }',
    'class A22 { #tag22 = 1; s22: Store = new LocalStore(); run22() { return this.s22.find("x"); } }',
    'class B22 { #tag22 = 2; s22: Store = new LocalStore(); b22 = 1; }',
    'const bs22: B22[] = [];',
    'export function mix22() { const view: object[] = bs22; view.push(new A22()); bs22[0]!.s22 = new RemoteStore(); }',
    'class A23 { #tag23 = 1; s23: Store = new LocalStore(); run23() { return this.s23.find("x"); } }',
    'class B23 { #tag23 = 2; s23: Store = new LocalStore(); }',
    'interface Sink23 { take(x: object): void }',
    'const sink23: Sink23 = { take(x: B23) { x.s23 = new RemoteStore(); } };',
    'export function mix23() { sink23.take(new A23()); }',
    'class Root24 { #id24 = 0; }',
    'class A24 extends Root24 { s24: Store = new LocalStore(); run24() { return this.s24.find("x"); } }',
    'class B24 extends Root24 { s24: Store = new LocalStore(); b24 = 1; }',
    'const bs24: B24[] = [];',
    'export function mix24() { const roots: Root24[] = bs24; roots.push(new A24()); bs24[0]!.s24 = new RemoteStore(); }',
    'class A25 { #tag25 = 1; s25: Store = new LocalStore(); run25() { return this.s25.find("x"); } }',
    'class B25 { #tag25 = 2; s25: Store = new LocalStore(); run25() { return "b"; } }',
    'const bs25: B25[] = [];',
    'export function mix25() { const view: object[] = bs25; view.push(new A25()); return bs25[0]!.run25.call({ s25: new RemoteStore() }); }',
    'class H26 { s26: Store = new LocalStore(); run26() { return this.s26.find("x"); } }',
    'export const h26 = new H26();',
    'const other26 = { s26: new LocalStore() as Store };',
    'export function write26() { other26.s26 = new RemoteStore(); }',
    'declare function setTimeout(callback: () => void, delay: number): unknown;',
    'class Poller27 { s27: Store = new LocalStore(); tick27(): void { this.s27.find("x"); setTimeout(this.tick27.bind(this), 1000); } }',
    'export const poller27 = new Poller27();',
    'class Pair28 { s28: Store = new LocalStore(); run28(): unknown { const other = this.stop28; return [other, this.s28.find("x")]; } stop28(): unknown { return this.run28; } }',
    'export const pair28 = new Pair28();',
  ].join('\n');
  const graph = await graphOf({
    'src/store.ts': cachingStore,
    'src/impl.ts': 'import type { Store } from "./store";\nexport function handle7(s: Store) { return s.find("x"); }\n',
    'src/index7.ts': 'export * from "./impl";\n',
    'src/main.ts': main,
  });
  const bound = (from: string): string[] => graph.edges.filter((edge) => edge.from === from && edge.evidence === 'bound').map((edge) => edge.to);
  const expectations: [string, string[]][] = [
    ['src/main.ts#p1', [LOCAL, REMOTE]],
    ['src/main.ts#Holder2.run', [CACHED, LOCAL]],
    ['src/main.ts#p3', [CACHED, LOCAL]],
    ['src/main.ts#Box4.run', [LOCAL, REMOTE]],
    ['src/main.ts#p5', []],
    ['src/main.ts#p6', []],
    ['src/impl.ts#handle7', []],
    ['src/main.ts#H8.run', []],
    ['src/main.ts#p9', []],
    ['src/main.ts#H10.run10', []],
    ['src/main.ts#p11', []],
    ['src/main.ts#p12', ['src/main.ts#impl12']],
    ['src/main.ts#p13', [LOCAL, REMOTE]],
    // 재검증 반례: 하위 클래스 타입 수신자로 쓴 상속 필드·매개변수 속성, 배열 공변성, 메서드 매개변수 이변성,
    // 하위 클래스를 거쳐 떼어 낸 메서드, 대입 구조 분해로 떼어 낸 메서드.
    ['src/main.ts#B14.run', [LOCAL, REMOTE]],
    ['src/main.ts#B15.run', [LOCAL, REMOTE]],
    ['src/main.ts#B16.run', [LOCAL, REMOTE]],
    ['src/main.ts#p17', []],
    ['src/main.ts#H18.run', [LOCAL, REMOTE]],
    ['src/main.ts#H19.run', [LOCAL, REMOTE]],
    ['src/main.ts#B20.run20', []],
    ['src/main.ts#H21.run21', []],
    // 명목 클래스끼리도 공통 상위 타입을 거친 공변성·이변성으로 섞일 수 있다(수신자 흐름으로만 가른다).
    ['src/main.ts#A22.run22', [LOCAL, REMOTE]],
    ['src/main.ts#A23.run23', [LOCAL, REMOTE]],
    ['src/main.ts#A24.run24', [LOCAL, REMOTE]],
    ['src/main.ts#A25.run25', []],
    // 수신자 흐름이 값을 담지 않음이 증명되면 같은 이름 쓰기는 닿지 않는다.
    ['src/main.ts#H26.run26', [LOCAL]],
    // 메서드가 자기 자신·서로를 읽어도(폴링의 `this.tick.bind(this)`) 무한 재귀 없이 모름으로 끝난다.
    ['src/main.ts#Poller27.tick27', []],
    ['src/main.ts#Pair28.run28', []],
  ];
  assert.deepEqual(expectations.map(([from]) => [from, bound(from)]), expectations);
  assert.deepEqual(bound('src/main.ts#Holder2.upgrade'), ['src/store.ts#CachedStore.withCache', 'src/store.ts#LocalStore.withCache']);
});

test('GLM 지적: 파일 안 namespace·문자열 원소 접근 참조, 호출 없는 함수, 되풀이한 var, #비공개·계산된 필드', async () => {
  const main = [
    'import { LocalStore, RemoteStore, type Store } from "./store";',
    // S1: `new App.Repo(...)`·`App["load"](...)`가 참조로 잡혀야 기본값만 흐른다고 보지 않는다.
    'namespace App {',
    '  export class Repo { constructor(private readonly s: Store = new LocalStore()) {} run() { return this.s.find("x"); } }',
    '  export function load(s: Store = new LocalStore()) { return s.find("y"); }',
    '}',
    'export const repo1 = new App.Repo(new RemoteStore());',
    'export const loaded1 = App["load"](new RemoteStore());',
    // S1: `Extend(Lib.Service)`로 새어 나간 클래스의 this는 모름이다.
    'namespace Lib { export class Service { s2: Store = new LocalStore(); run2() { return this.s2.find("z"); } } }',
    'function Extend2<T extends new (...args: any[]) => object>(Base: T) { return class extends Base {}; }',
    'export const Extended2 = Extend2(Lib.Service);',
    'export const service2 = new Lib.Service();',
    // S1: 계산된 키로 읽힌 네임스페이스의 멤버는 호출자를 다 볼 수 없다.
    'namespace Dyn { export function use3(s: Store) { return s.find("w"); } }',
    'declare const key3: "use3";',
    'export const r3 = () => Dyn.use3(new LocalStore());',
    'export const d3 = () => Dyn[key3](new RemoteStore());',
    // S1 fail-closed: 색인된 호출이 없는 함수는 기본값만 흐른다고 추측하지 않는다.
    'function lonely4(s: Store = new LocalStore()) { return s.find("v"); }',
    'export const keep4 = typeof lonely4;',
    // S2: 되풀이한 var 선언은 모든 초기값을 합친다.
    'var dup5: Store = new LocalStore();',
    'var dup5: Store = new RemoteStore();',
    'export function p5() { return dup5.find("u"); }',
    // 확인: #비공개 필드와 계산된 이름 필드.
    'class Priv6 { #s6: Store = new LocalStore(); run6() { return this.#s6.find("t"); } swap6() { this.#s6 = new RemoteStore(); } }',
    'export const priv6 = new Priv6();',
    'const key7 = "s7";',
    'class Comp7 { [key7]: Store = new LocalStore(); run7() { return this[key7].find("s"); } }',
    'export const comp7 = new Comp7();',
  ].join('\n');
  const graph = await graphOf({ 'src/store.ts': cachingStore, 'src/main.ts': main });
  const bound = (from: string): string[] => graph.edges.filter((edge) => edge.from === from && edge.evidence === 'bound').map((edge) => edge.to);
  const expectations: [string, string[]][] = [
    // 네임스페이스는 심볼 id의 이름 조각이 아니다(schema `qualifiedName` 규칙).
    ['src/main.ts#Repo.run', [LOCAL, REMOTE]],
    ['src/main.ts#load', [LOCAL, REMOTE]],
    ['src/main.ts#Service.run2', []],
    ['src/main.ts#use3', []],
    ['src/main.ts#lonely4', []],
    ['src/main.ts#p5', [LOCAL, REMOTE]],
    ['src/main.ts#Priv6.run6', [LOCAL, REMOTE]],
    ['src/main.ts#Comp7.run7', []],
  ];
  assert.deepEqual(expectations.map(([from]) => [from, bound(from)]), expectations);
});

test('GLM 지적 C1: 흐름 재귀가 깊어도 예산으로 끝나 모름이 되고 dispatch-budget으로 알린다', async () => {
  const chain = Array.from({ length: 240 }, (_, index) => `const c${index + 1}: Store = c${index} ?? c${index};`).join('\n');
  const graph = await graphOf({
    'src/store.ts': cachingStore,
    'src/main.ts': `import { LocalStore, type Store } from "./store";\nconst c0: Store = new LocalStore();\n${chain}\nexport function p() { return c240.find("x"); }\n`,
  });
  assert.deepEqual(graph.edges.filter((edge) => edge.evidence === 'bound'), []);
  assert.equal(graph.statistics.calls.dispatch.overBudget, 1);
  assert.ok(graph.limitations.some((line) => line.startsWith('dispatch-budget: 1 deferred interface/callable call(s) exceeded the flow-analysis budget')));
});

test('GLM 지적 C1: 질의 안의 스택 초과(RangeError)는 모름으로 바꾸고, 다른 예외는 그대로 던진다', () => {
  const host = ts.createCompilerHost({ strict: true });
  const source = 'interface S { f(): void }\nclass A implements S { f() {} }\nconst a: S = new A();\nexport const x = a;\n';
  const original = host.getSourceFile;
  host.getSourceFile = (name, version) => (name === 'main.ts' ? ts.createSourceFile(name, source, version, true) : original.call(host, name, version));
  const program = ts.createProgram({ rootNames: ['main.ts'], options: { strict: true, noLib: true }, host });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile('main.ts')!;
  const receiver = (file.statements[3] as ts.VariableStatement).declarationList.declarations[0]!.initializer!;
  const policy = (failure: Error): FlowPolicy => ({
    isProjectFile: () => {
      throw failure;
    },
    isOpenCallable: () => false,
    isOverridden: () => false,
    openProperties: false,
  });
  const index = buildFileIndex(checker, file, () => undefined);
  const flow = new ValueFlow(checker, index, policy(new RangeError('Maximum call stack size exceeded')));
  assert.equal(flow.valuesOf(receiver), null);
  assert.equal(flow.budgetExceededQueries(), 1);
  assert.throws(() => new ValueFlow(checker, index, policy(new TypeError('bug'))).valuesOf(receiver), TypeError);
});

test('GLM 지적 S1: 색인이 참조를 빠뜨려도 완전성 검사가 "호출 없음"을 믿지 않아 기본값만으로 잇지 않는다', () => {
  const source = [
    'interface S { f(): void }',
    'class A implements S { f() {} }',
    'class B implements S { f() {} }',
    'function use(s: S = new A()) { return s; }',
    'use(new B());',
    'function unused(s: S = new A()) { return s; }',
    'export const probeUse = use;',
  ].join('\n');
  const host = ts.createCompilerHost({ strict: true });
  const original = host.getSourceFile;
  host.getSourceFile = (name, version) => (name === 'main.ts' ? ts.createSourceFile(name, source, version, true) : original.call(host, name, version));
  const program = ts.createProgram({ rootNames: ['main.ts'], options: { strict: true, noLib: true }, host });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile('main.ts')!;
  const policy: FlowPolicy = { isProjectFile: (sourceFile) => sourceFile === file, isOpenCallable: () => false, isOverridden: () => false, openProperties: false };
  const full = buildFileIndex(checker, file, () => undefined);
  const parameterOf = (index: number): ts.Identifier => ((file.statements[index] as ts.FunctionDeclaration).parameters[0]!.name as ts.Identifier);
  const useSymbol = checker.getSymbolAtLocation((file.statements[3] as ts.FunctionDeclaration).name!)!;
  // `use`의 참조를 모두 뺀 색인을 흉내 낸다(색인 공백). 완전성 검사가 빠진 참조 토큰을 찾아 모름으로 둔다.
  const damaged: FlowIndex = { ...full, references: new Map([...full.references].filter(([symbol]) => symbol !== useSymbol)) };
  const values = (index: FlowIndex, parameter: number): string[] | null => {
    const flow = new ValueFlow(checker, index, policy).valuesOf(parameterOf(parameter));
    return flow === null ? null : [...flow].map((value) => (value as ts.ClassDeclaration).name!.text).sort();
  };
  assert.equal(values(damaged, 3), null);
  // 참조가 정말 없는 함수는 완전성이 증명되어 기본값만 흐른다.
  assert.deepEqual(values(full, 5), ['A']);
});

test('GLM 2차 지적: 중첩 네임스페이스 계산된 읽기·구조 분해 별칭·기본 내보내기·축약 속성', async () => {
  const main = [
    'import { LocalStore, RemoteStore, type Store } from "./store";',
    'import * as helpers from "./helpers";',
    'import helperDefault from "./helpers-default";',
    // 1: 중첩 네임스페이스를 계산된 키로 읽으면 멤버 호출을 다 볼 수 없다.
    'namespace App1 { export namespace Repo { export function run1(s: Store = new LocalStore()) { return s.find("a"); } } }',
    'declare const key1: "run1";',
    'export const a1 = () => App1.Repo.run1(new LocalStore());',
    'export const b1 = () => App1.Repo[key1](new RemoteStore());',
    'declare const key1b: "run1b";',
    'export const c1 = () => helpers.sub[key1b](new RemoteStore());',
    'export const d1 = () => helpers.sub.run1b(new LocalStore());',
    'export const e1 = () => helperDefault.sub[key1b](new RemoteStore());',
    // 2: 구조 분해로 떼어 낸 네임스페이스 멤버를 부르면 호출 위치를 다 볼 수 없다.
    'namespace App2 { export namespace Repo { export function run2(s: Store = new LocalStore()) { return s.find("b"); } } }',
    'export const a2 = () => { const { run2 } = App2.Repo; return run2(new RemoteStore()); };',
    'namespace App3 { export function run3(s: Store = new LocalStore()) { return s.find("c"); } }',
    'export const a3 = () => { const { run3: r } = App3; return r(new RemoteStore()); };',
    'export const b3 = () => App3.run3(new LocalStore());',
    'namespace App4 { export function run4(s: Store = new LocalStore()) { return s.find("d"); } }',
    'export const a4 = () => ({ ...App4 }).run4(new RemoteStore());',
    'export const b4 = () => App4.run4(new LocalStore());',
    // 3: 축약 속성으로 새어 나간 함수.
    'function run5(s: Store = new LocalStore()) { return s.find("e"); }',
    'export const bag5 = { run5 };',
    'export const b5 = () => run5(new LocalStore());',
    // 엄격한 완전성: 참조가 없는 함수라도 이름이 같은 토큰이 선언 밖에 하나라도 있으면(무관한 구조 분해라도) 증명 실패다.
    'function spare6(s: Store = new LocalStore()) { return s.find("f"); }',
    'const other6 = { spare6: 1 };',
    'export const { spare6: picked6 } = other6;',
    // 이름이 같은 토큰이 선언뿐이면 참조 없음이 증명되어 기본값만 흐른다.
    'function spare7(s: Store = new LocalStore()) { return s.find("g"); }',
  ].join('\n');
  const graph = await graphOf({
    'src/store.ts': cachingStore,
    'src/helpers.ts': 'import { type Store } from "./store";\nexport namespace sub { export function run1b(s: Store) { return s.find("h"); } }\n',
    'src/helpers-default.ts': 'import * as h from "./helpers";\nexport default h;\n',
    'src/main.ts': main,
  });
  const bound = (from: string): string[] => graph.edges.filter((edge) => edge.from === from && edge.evidence === 'bound').map((edge) => edge.to);
  const expectations: [string, string[]][] = [
    ['src/main.ts#run1', []],
    ['src/helpers.ts#run1b', []],
    ['src/main.ts#run2', []],
    ['src/main.ts#run3', []],
    ['src/main.ts#run4', []],
    ['src/main.ts#run5', []],
    ['src/main.ts#spare6', []],
    ['src/main.ts#spare7', [LOCAL]],
  ];
  assert.deepEqual(expectations.map(([from]) => [from, bound(from)]), expectations);
});

test('GLM 2차 지적 3: export default f로 내보낸 함수는 가져온 쪽 이름의 호출로 잇고, 공개 패키지면 열린 자리다', async () => {
  const files = {
    'src/store.ts': cachingStore,
    'src/lib.ts': 'import { LocalStore, type Store } from "./store";\nfunction f6(s: Store = new LocalStore()) { return s.find("f"); }\nexport default f6;\n',
    'src/main.ts': 'import g from "./lib";\nimport { RemoteStore } from "./store";\nexport const a6 = () => g(new RemoteStore());\n',
  };
  const bound = (graph: CallGraph): string[] => graph.edges.filter((edge) => edge.evidence === 'bound').map((edge) => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(bound(await graphOf(files)), ['src/lib.ts#f6 -> src/store.ts#LocalStore.find', 'src/lib.ts#f6 -> src/store.ts#RemoteStore.find']);
  assert.deepEqual(bound(await graphOf({ ...files, 'package.json': '{ "name": "lib", "main": "src/lib.ts" }' })), []);
});
