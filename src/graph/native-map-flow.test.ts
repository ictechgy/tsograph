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
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
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
