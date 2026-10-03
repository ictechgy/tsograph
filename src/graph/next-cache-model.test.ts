/**
 * Next 16.2.7 `unstable_cache`의 제한된 callback delegation 모델을 합성 SDK로 검증한다.
 * 실제 Next 소스나 비공개 fixture는 읽지 않는다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import type { CallGraph } from './graph-model.ts';

const cacheDeclaration = [
  'export declare function unstable_cache<Args extends readonly unknown[], Result>(',
  '  callback: (...args: Args) => Result,',
  '  keyParts?: readonly string[],',
  '  options?: Record<string, unknown>,',
  '): (...args: Args) => Promise<unknown>;',
].join('\n');

/** 합성 Next SDK와 프로젝트를 임시 디렉터리에 만들고 그래프를 계산한다. */
async function graphOf(
  files: Record<string, string>,
  version = '16.2.7',
): Promise<CallGraph> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-next-cache-')));
  try {
    const all = {
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
      'node_modules/next/package.json': JSON.stringify({ name: 'next', version }),
      'node_modules/next/cache.d.ts': cacheDeclaration,
      ...files,
    };
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, createNodeFileSystem());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function boundTo(graph: CallGraph, from: string, to: string): boolean {
  return graph.edges.some((edge) => edge.from === from && edge.to === to && edge.evidence === 'bound');
}

function allBound(graph: CallGraph): string[] {
  return graph.edges.filter((edge) => edge.evidence === 'bound').map((edge) => `${edge.from} -> ${edge.to}`);
}

test('Next 16.2.7 named and namespace imports delegate direct wrappers to the original callback', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'import { unstable_cache as cache } from "next/cache";',
      'import * as NextCache from "next/cache";',
      'function original(value: string) { return value; }',
      'export function direct() { return cache(original, ["direct"])("x"); }',
      'export function namespaced() { return NextCache.unstable_cache(original, ["namespace"])("x"); }',
    ].join('\n'),
  });

  assert.ok(boundTo(graph, 'src/main.ts#direct', 'src/main.ts#original'));
  assert.ok(boundTo(graph, 'src/main.ts#namespaced', 'src/main.ts#original'));
});

test('immutable const aliases and async callbacks retain only callback delegation', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'import { unstable_cache } from "next/cache";',
      'async function original(value: string) { return value; }',
      'const cached = unstable_cache(original, ["one"]);',
      'const alias = cached;',
      'export async function run() { return alias("x"); }',
    ].join('\n'),
  });

  assert.ok(boundTo(graph, 'src/main.ts#run', 'src/main.ts#original'));
  assert.deepEqual(allBound(graph), ['src/main.ts#run -> src/main.ts#original']);
});

test('cache return values stay opaque while callback arguments do not acquire value flow', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'import { unstable_cache } from "next/cache";',
      'interface Service { run(): string; }',
      'class LiveService implements Service { run() { return "live"; } }',
      'function makeService() { return new LiveService(); }',
      'function useService(service: Service) { return service.run(); }',
      'export async function objectReturnGap() {',
      '  const value = await unstable_cache(makeService, ["object"])();',
      '  return (value as { run(): string }).run();',
      '}',
      'const cached = unstable_cache(useService, ["args"]);',
      'export function argumentGap() { return cached(new LiveService()); }',
    ].join('\n'),
  });

  assert.ok(boundTo(graph, 'src/main.ts#objectReturnGap', 'src/main.ts#makeService'));
  assert.equal(boundTo(graph, 'src/main.ts#objectReturnGap', 'src/main.ts#LiveService.run'), false);
  assert.ok(boundTo(graph, 'src/main.ts#argumentGap', 'src/main.ts#useService'));
  assert.equal(boundTo(graph, 'src/main.ts#useService', 'src/main.ts#LiveService.run'), false);
});

test('unknown callbacks and unsupported wrapper shapes remain unresolved', async () => {
  const cases: readonly [string, string][] = [
    ['parameter', [
      'import { unstable_cache } from "next/cache";',
      'function make(callback: (value: string) => string) { const cached = unstable_cache(callback, []); return cached("x"); }',
      'function original(value: string) { return value; }',
      'export function run() { return make(original); }',
    ].join('\n')],
    ['object-carrier parameter', [
      'import { unstable_cache } from "next/cache";',
      'function make(callback: (value: string) => string) { const holder = { callback }; const cached = unstable_cache(holder.callback, []); return cached("x"); }',
      'function original(value: string) { return value; }',
      'export function run() { return make(original); }',
    ].join('\n')],
    ['conditional parameter', [
      'import { unstable_cache } from "next/cache";',
      'declare const flag: boolean;',
      'function make(callback: (value: string) => string) { const selected = flag ? callback : fallback; const cached = unstable_cache(selected, []); return cached("x"); }',
      'function fallback(value: string) { return value; }',
      'function original(value: string) { return value; }',
      'export function run() { return make(original); }',
    ].join('\n')],
    ['mutable', [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'function replacement(value: string) { return value; }',
      'let cached = unstable_cache(original, []);',
      'cached = unstable_cache(replacement, []);',
      'export function run() { return cached("x"); }',
    ].join('\n')],
    ['property-alias', [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'const holder = { make: unstable_cache };',
      'const cached = holder.make(original, []);',
      'export function run() { return cached("x"); }',
    ].join('\n')],
    ['unknown-receiver', [
      'import * as NextCache from "next/cache";',
      'function original(value: string) { return value; }',
      'const namespace = NextCache;',
      'const cached = namespace.unstable_cache(original, []);',
      'export function run() { return cached("x"); }',
    ].join('\n')],
    ['cycle', [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'const first = second;',
      'const second = first;',
      'export function run() { return first("x"); }',
    ].join('\n')],
    ['depth', [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'const alias0 = unstable_cache(original, []);',
      ...Array.from({ length: 20 }, (_, index) => `const alias${index + 1} = alias${index};`),
      'export function run() { return alias20("x"); }',
    ].join('\n')],
    ['spread', [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'const cached = unstable_cache(original, []);',
      'declare const values: [string];',
      'export function run() { return cached(...values); }',
    ].join('\n')],
    ['optional', [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'const cached = unstable_cache(original, []);',
      'export function run() { return cached?.("x"); }',
    ].join('\n')],
  ];

  for (const [name, source] of cases) {
    const graph = await graphOf({ 'src/main.ts': source });
    assert.deepEqual(allBound(graph), [], name);
  }
});

test('factory provenance and public mutation guards fail closed', async () => {
  const cases: readonly [string, Record<string, string>, string?][] = [
    ['factory shadow', {
      'src/main.ts': [
        'declare function unstable_cache(callback: (value: string) => string): (value: string) => Promise<unknown>;',
        'function original(value: string) { return value; }',
        'const cached = unstable_cache(original);',
        'export function run() { return cached("x"); }',
      ].join('\n'),
    }],
    ['named import write', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof unstable_cache;',
        'unstable_cache = replacement;',
        'const cached = unstable_cache(original, []);',
        'export function run() { return cached("x"); }',
      ].join('\n'),
    }],
    ['namespace member write', {
      'src/main.ts': [
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache.unstable_cache;',
        'NextCache.unstable_cache = replacement;',
        'const cached = NextCache.unstable_cache(original, []);',
        'export function run() { return cached("x"); }',
      ].join('\n'),
    }],
    ['namespace import write', {
      'src/main.ts': [
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache;',
        'NextCache = replacement;',
        'export function run() { return NextCache.unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['namespace helper parameter write', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache.unstable_cache;',
        'function mutate(namespace: typeof NextCache) { Reflect.set(namespace, "unstable_cache", replacement); }',
        'mutate(NextCache);',
        'export function namedRun() { return unstable_cache(original, [])("x"); }',
        'export function namespaceRun() { return NextCache.unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['named reflective write', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'Object.assign(unstable_cache, { marker: true });',
        'export function run() { return unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['namespace reflective write affects named import', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache.unstable_cache;',
        'Reflect.set(NextCache, "unstable_cache", replacement);',
        'export function namedRun() { return unstable_cache(original, [])("x"); }',
        'export function namespaceRun() { return NextCache.unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['namespace defineProperty affects named import', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache.unstable_cache;',
        'Object.defineProperty(NextCache, "unstable_cache", { value: replacement });',
        'export function namedRun() { return unstable_cache(original, [])("x"); }',
        'export function namespaceRun() { return NextCache.unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['namespace alias Reflect.set affects both imports', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache.unstable_cache;',
        'const alias = NextCache;',
        'Reflect.set(alias, "unstable_cache", replacement);',
        'export function namedRun() { return unstable_cache(original, [])("x"); }',
        'export function namespaceRun() { return NextCache.unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['namespace alias defineProperty affects both imports', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache.unstable_cache;',
        'const alias = NextCache;',
        'Object.defineProperty(alias, "unstable_cache", { value: replacement });',
        'export function namedRun() { return unstable_cache(original, [])("x"); }',
        'export function namespaceRun() { return NextCache.unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['namespace alias Object.assign affects both imports', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache.unstable_cache;',
        'const alias = NextCache;',
        'Object.assign(alias, { unstable_cache: replacement });',
        'export function namedRun() { return unstable_cache(original, [])("x"); }',
        'export function namespaceRun() { return NextCache.unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['namespace alias direct member write affects both imports', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'import * as NextCache from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof NextCache.unstable_cache;',
        'const alias = NextCache;',
        'alias.unstable_cache = replacement;',
        'export function namedRun() { return unstable_cache(original, [])("x"); }',
        'export function namespaceRun() { return NextCache.unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['SDK function alias reflection is guarded', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'declare const replacement: typeof unstable_cache;',
        'const alias = unstable_cache;',
        'Reflect.set(alias, "marker", replacement);',
        'export function run() { return unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['ambient augmentation', {
      'src/ambient.d.ts': [
        'declare module "next/cache" {',
        '  export function unstable_cache(callback: (value: string) => string): (value: string) => Promise<unknown>;',
        '}',
      ].join('\n'),
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'export function run() { return unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['path shadow', {
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          strict: true,
          module: 'esnext',
          moduleResolution: 'bundler',
          target: 'es2022',
          baseUrl: '.',
          paths: { 'next/cache': ['src/mock-cache.d.ts'] },
        },
      }),
      'src/mock-cache.d.ts': 'export declare function unstable_cache(callback: (value: string) => string): (value: string) => Promise<unknown>;',
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'export function run() { return unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['opaque import', {
      'src/load.ts': 'declare const moduleName: string; export const load = () => import(moduleName);',
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'export function run() { return unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['oversized manifest', {
      'node_modules/next/package.json': `${' '.repeat(65 * 1024)}{"name":"next","version":"16.2.7"}`,
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'export function run() { return unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
    ['unsupported version', {
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'export function run() { return unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }, '16.2.6'],
    ['open project', {
      'package.json': '{ "name": "public-project", "main": "src/main.ts" }',
      'src/main.ts': [
        'import { unstable_cache } from "next/cache";',
        'function original(value: string) { return value; }',
        'export function run() { return unstable_cache(original, [])("x"); }',
      ].join('\n'),
    }],
  ];

  for (const [name, files, version] of cases) {
    const graph = await graphOf(files, version);
    assert.deepEqual(allBound(graph), [], name);
  }
});

test('same-named project factories and object members retain ordinary callable value-flow', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'type CacheLike = { unstable_cache(callback: (value: string) => string): (value: string) => string };',
      'function unstable_cache(callback: (value: string) => string) { return callback; }',
      'const holder: CacheLike = { unstable_cache() { return original; } };',
      'function original(value: string) { return value; }',
      'namespace Local { export function unstable_cache() { return original; } }',
      'const named = unstable_cache(original);',
      'const member = holder.unstable_cache();',
      'export function namedRun() { return named("x"); }',
      'export function memberRun() { return member("x"); }',
      'export function namespaceRun() { return Local.unstable_cache()("x"); }',
    ].join('\n'),
  });

  assert.deepEqual({
    named: boundTo(graph, 'src/main.ts#namedRun', 'src/main.ts#original'),
    member: boundTo(graph, 'src/main.ts#memberRun', 'src/main.ts#original'),
    namespace: boundTo(graph, 'src/main.ts#namespaceRun', 'src/main.ts#original'),
  }, { named: true, member: true, namespace: true });
});

test('project path shadow keeps ordinary value-flow instead of entering the SDK model', async () => {
  const graph = await graphOf({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'es2022',
        baseUrl: '.',
        paths: { 'next/cache': ['src/mock-cache.ts'] },
      },
    }),
    'src/mock-cache.ts': 'export function unstable_cache(callback: (value: string) => string) { return callback; }',
    'src/main.ts': [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'export function run() { return unstable_cache(original, [])("x"); }',
    ].join('\n'),
  });

  assert.ok(boundTo(graph, 'src/main.ts#run', 'src/main.ts#original'));
});

test('unrelated reflective targets do not disable a closed SDK import', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'const unrelated: Record<string, unknown> = {};',
      'Reflect.set(unrelated, "unstable_cache", original);',
      'export function run() { return unstable_cache(original, [])("x"); }',
    ].join('\n'),
  });

  assert.ok(boundTo(graph, 'src/main.ts#run', 'src/main.ts#original'));
});

test('production view ignores excluded test augmentations while whole and mixed views fail closed', async () => {
  const main = {
    'src/main.ts': [
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'export function run() { return unstable_cache(original, [])("x"); }',
    ].join('\n'),
  };
  const augmentation = [
    'export {};',
    'declare module "next/cache" {',
    '  export function unstable_cache(callback: (value: string) => string): (value: string) => Promise<unknown>;',
    '}',
  ].join('\n');
  const baseline = await graphOf(main);
  const unrelatedTest = await graphOf({ ...main, 'src/unrelated.test.ts': 'export const fixture = 1;' });
  const excludedAugmentation = await graphOf({ ...main, 'src/augment.test.ts': augmentation });
  assert.ok(boundTo(baseline, 'src/main.ts#run', 'src/main.ts#original'));
  assert.ok(boundTo(unrelatedTest, 'src/main.ts#run', 'src/main.ts#original'));
  assert.ok(boundTo(excludedAugmentation, 'src/main.ts#run', 'src/main.ts#original'));

  const testCall = await graphOf({
    ...main,
    'src/augment.test.ts': [
      augmentation,
      'import { unstable_cache } from "next/cache";',
      'function original(value: string) { return value; }',
      'export function testRun() { return unstable_cache(original, [])("x"); }',
    ].join('\n'),
  });
  assert.equal(boundTo(testCall, 'src/augment.test.ts#testRun', 'src/augment.test.ts#original'), false);

  const mixed = await graphOf({
    ...main,
    'src/augment.test.ts': `${augmentation}\nexport const fixture = 1;`,
    'src/wire.ts': 'import { fixture } from "./augment.test"; export const wired = fixture;',
  });
  assert.equal(boundTo(mixed, 'src/main.ts#run', 'src/main.ts#original'), false);
});
