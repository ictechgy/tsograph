/**
 * 값 흐름 분석(`value-flow.ts`)의 식·선언 종류별 규칙을 한 합성 프로젝트의 탐침 함수들로 검증한다.
 * 탐침마다 bound 대상이 기대와 같아야 하고, 증명하지 못하는 경우("none")에는 bound 간선이 없어야 한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import type { CallGraph } from './graph-model.ts';

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
  ['p17', 'none', 'let make17 = (): Store => new RemoteStore();\nexport function reset17() { make17 = () => new LocalStore(); }\nexport function p17() { return make17().find("x"); }'],
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
  ['p32', [LOCAL], 'class Other32 { store: Store = new RemoteStore(); }\nconst o32 = new Other32();\nexport function write32() { o32.store = new RemoteStore(); }\nconst d32: { store: Store } = { store: new LocalStore() };\nexport function p32() { return d32.store.find("x"); }'],
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
    'src/main.ts': 'import { lookup } from "./service";\nimport { RemoteStore } from "./store";\nexport const run = () => lookup(new RemoteStore());\n',
    'src/service.test.ts': [
      'import { lookup } from "./service";',
      'import type { Store } from "./store";',
      'declare function mockFn(): (id: string) => string;',
      'const fake: Store = { find: mockFn() };',
      'export const check = () => lookup(fake);',
      'export const direct = () => fake.find("b");',
    ].join('\n'),
  };
  const graph = await graphOf(files);
  const lines = graph.edges.filter((edge) => edge.evidence !== 'direct').map((edge) => `${edge.from} -> ${edge.to} ${edge.evidence}`);
  assert.deepEqual(lines, [
    `src/service.test.ts#direct -> ${LOCAL} candidate`,
    `src/service.test.ts#direct -> ${REMOTE} candidate`,
    `src/service.ts#lookup -> ${REMOTE} bound`,
  ]);
  // 테스트가 아닌 파일이 테스트 소스를 불러오면 둘을 나눌 수 없어 전체 흐름으로 구한다(목 때문에 bound 없음).
  const mixed = await graphOf({ ...files, 'src/wire.ts': 'import { check } from "./service.test";\nexport const wired = check;\n' });
  assert.deepEqual(mixed.edges.filter((edge) => edge.evidence === 'bound'), []);
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
