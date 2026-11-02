/**
 * native Map registry가 실제 bound graph의 반환 객체 흐름으로 이어지는지 검증한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';

const fileSystem = createNodeFileSystem();

async function graphOf(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-native-map-flow-')));
  try {
    const all = {
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "types": [], "lib": ["es2022"], "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
      ...files,
    };
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, fileSystem);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function boundTo(graph: Awaited<ReturnType<typeof graphOf>>, from: string): string[] {
  return graph.edges.filter((edge) => edge.from === `src/main.ts#${from}` && edge.evidence === 'bound').map((edge) => edge.to);
}

const shared = [
  'interface Service { run(): string; }',
  'class First implements Service { private readonly brand = true; run() { return "first"; } }',
  'class Second implements Service { private readonly brand = true; run() { return "second"; } }',
].join('\n');

test('Map get-backed const factory resolves returned object.run in the real graph', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      shared,
      'const registry = new Map<string, () => Service>();',
      'registry.set("service", () => new First());',
      'const make = registry.get("service");',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(graph, 'read'), ['src/main.ts#First.run']);
});

test('unknown Map keys union every possible factory and delete/clear retain possible values', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      shared,
      'declare const key: string;',
      'const registry = new Map<string, () => Service>();',
      'registry.set("first", () => new First());',
      'registry.set("second", () => new Second());',
      'registry.delete("first");',
      'registry.clear();',
      'const make = registry.get(key);',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(graph, 'read'), ['src/main.ts#First.run', 'src/main.ts#Second.run']);
});

test('conditional fallback unions Map makers while keys iterator remains opaque', async () => {
  const fallback = await graphOf({
    'src/main.ts': [
      shared,
      'declare const key: string;',
      'const registry = new Map<string, () => Service>();',
      'registry.set("first", () => new First());',
      'registry.set("second", () => new Second());',
      'const fallback = () => new Second();',
      'const make = registry.get(key) ?? fallback;',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(fallback, 'read'), ['src/main.ts#First.run', 'src/main.ts#Second.run']);

  const iterator = await graphOf({
    'src/main.ts': [
      shared,
      'const registry = new Map<string, () => Service>();',
      'registry.set("first", () => new First());',
      'const keys = registry.keys();',
      'export const read = () => keys.next().value.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(iterator, 'read'), []);
});

test('callable Map key iterator stays unknown instead of erasing a possible factory', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      shared,
      'declare const flag: boolean;',
      'const original = () => new First();',
      'const fallback = () => new Second();',
      'const registry = new Map<() => Service, null>();',
      'registry.set(original, null);',
      'const keys = registry.keys();',
      'const fromMap = keys.next().value;',
      'const make = flag ? fromMap : fallback;',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(graph, 'read'), []);
});

test('ordinary member calls bypass native Map descriptor collection on large files', async () => {
  const irrelevant = Array.from({ length: 20_050 }, (_, index) => `const unused${index} = ${index};`);
  const graph = await graphOf({
    'src/main.ts': [
      shared,
      'class Factory { make(): Service { return new First(); } }',
      ...irrelevant,
      'const factory = new Factory();',
      'const service = factory.make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(graph, 'read'), ['src/main.ts#First.run']);
});

test('Map flow prefilter matches the exact private top-level const zero-argument constructor contract', async () => {
  const parenthesized = await graphOf({
    'src/main.ts': [
      shared,
      'const registry = (new Map<string, () => Service>());',
      'registry.set("service", () => new First());',
      'const make = registry.get("service");',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(parenthesized, 'read'), ['src/main.ts#First.run']);

  const declarations = [
    'let registry = new Map<string, () => Service>();',
    'export const registry = new Map<string, () => Service>();',
    'const registry = new Map<string, () => Service>;',
    'const registry = new Map<string, () => Service>([["service", () => new First()]]);',
  ];
  for (const declaration of declarations) {
    const graph = await graphOf({
      'src/main.ts': [
        shared,
        declaration,
        'registry.set("service", () => new First());',
        'const make = registry.get("service");',
        'const service = make();',
        'export const read = () => service.run();',
      ].join('\n'),
    });
    assert.deepEqual(boundTo(graph, 'read'), [], declaration);
  }

  const nested = await graphOf({
    'src/main.ts': [
      shared,
      'function lookup() {',
      '  const registry = new Map<string, () => Service>();',
      '  registry.set("service", () => new First());',
      '  return registry.get("service");',
      '}',
      'const make = lookup();',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(nested, 'read'), []);
});

test('unknown maker, registry escape, Proxy context and fake Map declaration fail closed', async () => {
  const unknownMaker = await graphOf({
    'src/main.ts': [
      shared,
      'declare const maker: () => Service;',
      'const registry = new Map<string, () => Service>();',
      'registry.set("service", maker);',
      'const make = registry.get("service");',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(unknownMaker, 'read'), []);

  const escaped = await graphOf({
    'src/main.ts': [
      shared,
      'const registry = new Map<string, () => Service>();',
      'registry.set("service", () => new First());',
      'const alias = registry;',
      'const make = registry.get("service");',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(escaped, 'read'), []);

  const proxy = await graphOf({
    'src/main.ts': [
      shared,
      'declare const handler: ProxyHandler<object>;',
      'new Proxy(Map.prototype, handler);',
      'const registry = new Map<string, () => Service>();',
      'registry.set("service", () => new First());',
      'const make = registry.get("service");',
      'const service = make();',
      'export const read = () => service.run();',
    ].join('\n'),
  });
  assert.deepEqual(boundTo(proxy, 'read'), []);

  const fakeMap = await graphOf({
    'src/main.ts': [
      'declare const value: object;',
      'const registry = new Map<string, () => object>();',
      'registry.set("value", () => value);',
      'const make = registry.get("value");',
      'const result = make();',
      'export const read = () => result.toString();',
    ].join('\n'),
    'src/project-globals.d.ts': 'declare class Map<K = unknown, V = unknown> { constructor(); set(key: K, value: V): this; get(key: K): V | undefined; }\n',
  });
  assert.deepEqual(boundTo(fakeMap, 'read'), []);
});

/** native Map registry가 `First`만 담는 공통 꼬리다. 증명이 열리면 `read -> First.run`이 bound로 나온다. */
const registryTail = [
  'const registry = new Map<string, () => Service>();',
  'registry.set("service", () => new First());',
  'const make = registry.get("service");',
  'const service = make();',
  'export const read = () => service.run();',
].join('\n');

/** 증명이 닫혀 `read`가 두 구현 모두에 candidate로만 이어졌는지 확인한다. */
function assertClosedProof(graph: Awaited<ReturnType<typeof graphOf>>, label: string): void {
  assert.deepEqual(boundTo(graph, 'read'), [], label);
  const candidates = graph.edges.filter((edge) => edge.from === 'src/main.ts#read' && edge.evidence === 'candidate').map((edge) => edge.to);
  assert.deepEqual(candidates, ['src/main.ts#First.run', 'src/main.ts#Second.run'], label);
}

/** FlowIndex가 Object·Reflect 수신자로 인정하는 표기다(감싼 형태와 문자열 키 포함). */
const ownerSpellings = [
  'Object', 'Reflect', 'globalThis.Object', 'globalThis.Reflect',
  "globalThis['Object']", 'globalThis["Reflect"]', 'globalThis[`Object`]', '(Object)', 'Object as ObjectConstructor', 'globalThis.Reflect!',
];

test('zero-argument computed calls through Object or Reflect aliases close the native Map proof', async () => {
  // FlowIndex는 인자 없는 계산 호출을 reflective mutation으로 기록하지 않으므로 mutation guard의 alias 재검사가 닫는다.
  // 모든 수신자 표기의 alias, alias의 alias, let alias가 bare alias와 같이 bound 대신 보수적인 candidate로 남는다.
  const declarations = [
    ...ownerSpellings.map((owner) => `const owner = ${owner};`),
    "const first = globalThis['Object']; const owner = first;",
    'let owner = Reflect;',
  ];
  for (const declaration of declarations) {
    const graph = await graphOf({
      'src/main.ts': [shared, declaration, 'declare const member: "keys";', 'owner[member]();', registryTail].join('\n'),
    });
    assertClosedProof(graph, declaration);
  }
});

test('zero-argument computed calls on qualified or wrapped owners close the native Map proof', async () => {
  for (const owner of ownerSpellings) {
    const graph = await graphOf({
      'src/main.ts': [shared, 'declare const member: "keys";', `(${owner})[member]();`, registryTail].join('\n'),
    });
    assertClosedProof(graph, owner);
  }
});

test('cross-module Object or Reflect aliases that patch Map.prototype close the native Map proof', async () => {
  // FlowIndex의 alias 추적은 import를 따라가지 않으므로 guard의 alias 재검사만이 이 쓰기를 본다.
  // 그대로 열리면 실행 시 `read`가 `Second.run`을 부르는데도 bound `read -> First.run`이 나온다.
  const patchMap = "(Map.prototype, 'get', { value: () => () => new Second() });";
  const setMap = "(Map.prototype, 'get', () => () => new Second());";
  const cases: readonly [string, Record<string, string>][] = [
    ...ownerSpellings.filter((owner) => owner.includes('Object')).map((owner): [string, Record<string, string>] => [owner, {
      'src/owner.ts': `export const owner = ${owner};`,
      'src/main.ts': [`import { owner } from './owner';`, shared, `owner['defineProperty']${patchMap}`, registryTail].join('\n'),
    }]),
    ...ownerSpellings.filter((owner) => owner.includes('Reflect')).flatMap((owner): [string, Record<string, string>][] => [
      [`${owner} .set`, {
        'src/owner.ts': `export const owner = ${owner};`,
        'src/main.ts': [`import { owner } from './owner';`, shared, `owner.set${setMap}`, registryTail].join('\n'),
      }],
      [`${owner} ['set']`, {
        'src/owner.ts': `export const owner = ${owner};`,
        'src/main.ts': [`import { owner } from './owner';`, shared, `owner['set']${setMap}`, registryTail].join('\n'),
      }],
    ]),
    ['imported alias chain', {
      'src/owner.ts': 'export const first = Object;',
      'src/main.ts': [`import { first } from './owner';`, shared, 'const owner = first;', `owner['defineProperty']${patchMap}`, registryTail].join('\n'),
    }],
    ['namespace import member', {
      'src/owner.ts': 'export const owner = Object;',
      'src/main.ts': [`import * as owners from './owner';`, shared, `owners.owner['defineProperty']${patchMap}`, registryTail].join('\n'),
    }],
    ['namespace import member .set', {
      'src/owner.ts': 'export const reflect = Reflect;',
      'src/main.ts': [`import * as owners from './owner';`, shared, `owners.reflect.set${setMap}`, registryTail].join('\n'),
    }],
    ['namespace import string member .set', {
      'src/owner.ts': 'export const reflect = Reflect;',
      'src/main.ts': [`import * as owners from './owner';`, shared, `owners['reflect'].set${setMap}`, registryTail].join('\n'),
    }],
    ['imported alias destructuring', {
      'src/owner.ts': 'export const owner = Object;',
      'src/main.ts': [`import { owner } from './owner';`, shared, 'const { defineProperty } = owner;', `defineProperty${patchMap}`, registryTail].join('\n'),
    }],
    ['imported alias renamed destructuring', {
      'src/owner.ts': "export const owner = globalThis['Reflect'];",
      'src/main.ts': [`import { owner } from './owner';`, shared, 'const { set: put } = owner;', `put${setMap}`, registryTail].join('\n'),
    }],
    ['imported alias rest destructuring', {
      'src/owner.ts': 'export const owner = Reflect;',
      'src/main.ts': [`import { owner } from './owner';`, shared, 'const { ...methods } = owner;', `methods.set${setMap}`, registryTail].join('\n'),
    }],
    ['imported alias computed-key destructuring', {
      'src/owner.ts': 'export const owner = Reflect;',
      'src/main.ts': [`import { owner } from './owner';`, shared, "declare const key: 'set';", 'const { [key]: put } = owner;', `put${setMap}`, registryTail].join('\n'),
    }],
    ['export * barrel', {
      'src/owner.ts': 'export const owner = Reflect;',
      'src/barrel.ts': "export * from './owner';",
      'src/main.ts': [`import { owner } from './barrel';`, shared, `owner.set${setMap}`, registryTail].join('\n'),
    }],
    ['export * as namespace barrel', {
      'src/owner.ts': 'export const owner = Reflect;',
      'src/barrel.ts': "export * as owners from './owner';",
      'src/main.ts': [`import { owners } from './barrel';`, shared, `owners.owner.set${setMap}`, registryTail].join('\n'),
    }],
    ['default import of an alias', {
      'src/owner.ts': 'const owner = Reflect;\nexport default owner;',
      'src/main.ts': [`import owner from './owner';`, shared, `owner.set${setMap}`, registryTail].join('\n'),
    }],
    ['export = alias with import-equals', {
      'src/owner.ts': 'const owner = Reflect;\nexport = owner;',
      'src/main.ts': [`import owner = require('./owner');`, shared, `owner.set${setMap}`, registryTail].join('\n'),
    }],
    ['dynamic import member', {
      'src/owner.ts': 'export const owner = Reflect;',
      'src/main.ts': [shared, `export async function patch() { const owners = await import('./owner'); owners.owner.set${setMap} }`, registryTail].join('\n'),
    }],
    ['value and type merged alias', {
      'src/owner.ts': 'export const owner = Reflect;\nexport type owner = typeof Reflect;',
      'src/main.ts': [`import { owner } from './owner';`, shared, `owner.set${setMap}`, registryTail].join('\n'),
    }],
    ['value and type merged alias computed member', {
      'src/owner.ts': 'export const owner = Reflect;\nexport type owner = typeof Reflect;',
      'src/main.ts': [`import { owner } from './owner';`, shared, "declare const key: 'set';", `owner[key]${setMap}`, registryTail].join('\n'),
    }],
    ['re-exported let alias', {
      'src/owner.ts': 'export let owner = Reflect;',
      'src/barrel.ts': "export { owner as reflect } from './owner';",
      'src/main.ts': [`import { reflect } from './barrel';`, shared, `reflect.set${setMap}`, registryTail].join('\n'),
    }],
  ];
  for (const [label, files] of cases) assertClosedProof(await graphOf(files), label);
});

test('alias chains longer than the resolver depth close the native Map proof', async () => {
  // FlowIndex의 alias 추적(4단계)과 소유자 해석기(16단계)가 모두 끝나기 전에 끊기는 사슬이다.
  const chainOf = (origin: string, hops: number) => [
    `const link0 = ${origin};`,
    ...Array.from({ length: hops }, (_, index) => `const link${index + 1} = link${index};`),
  ];
  const cases: readonly [string, Record<string, string>][] = [
    ['20 hops .set', { 'src/main.ts': [shared, ...chainOf("globalThis['Reflect']", 20), `link20.set${"(Map.prototype, 'get', () => () => new Second());"}`, registryTail].join('\n') }],
    ['20 hops computed', { 'src/main.ts': [shared, ...chainOf('Object', 20), "declare const key: 'defineProperty';", `link20[key]${"(Map.prototype, 'get', { value: () => () => new Second() });"}`, registryTail].join('\n') }],
    ['40 hops across modules', {
      'src/owner.ts': 'export const link0 = Reflect;',
      'src/main.ts': [`import { link0 } from './owner';`, shared, ...chainOf('link0', 40).slice(1), `link40.set${"(Map.prototype, 'get', () => () => new Second());"}`, registryTail].join('\n'),
    }],
  ];
  for (const [label, files] of cases) assertClosedProof(await graphOf(files), label);
});

test('static non-mutating members through recognized aliases keep the native Map proof', async () => {
  const cases: readonly Record<string, string>[] = [
    { 'src/main.ts': [shared, "const owner = globalThis['Object'];", 'export const names = owner.keys({ a: 1 });', registryTail].join('\n') },
    {
      'src/owner.ts': 'export const owner = globalThis["Reflect"] as typeof Reflect;',
      'src/main.ts': [`import { owner } from './owner';`, shared, 'export const keys = owner.ownKeys({ a: 1 });', registryTail].join('\n'),
    },
  ];
  const destructured = {
    'src/owner.ts': 'export const owner = Object;',
    'src/main.ts': [`import { owner } from './owner';`, shared, 'const { keys } = owner;', 'export const names = keys({ a: 1 });', registryTail].join('\n'),
  };
  for (const files of [...cases, destructured]) assert.deepEqual(boundTo(await graphOf(files), 'read'), ['src/main.ts#First.run']);
});
