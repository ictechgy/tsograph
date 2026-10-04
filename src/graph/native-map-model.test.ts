/**
 * private top-level native Map registry의 직접 사용 경계와 값 표현식 수집을 검증한다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { buildFileIndex, type FlowIndex } from './flow-index.ts';
import {
  collectNativeMapDescriptors,
  nativeMapValuesForKey,
  type NativeMapDescriptor,
} from './native-map-model.ts';
import type { MutationSafetyContext } from './mutation-safety.ts';

interface IndexedSource {
  readonly program: ts.Program;
  readonly file: ts.SourceFile;
  readonly index: FlowIndex;
  readonly checker: ts.TypeChecker;
}

function indexedSource(source: string): IndexedSource {
  // fixture는 ECMAScript 표준 라이브러리만 사용하며 호스트의 ambient @types를 읽지 않는다.
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, types: [], lib: ['lib.es2022.d.ts'] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => name === 'main.ts'
    ? ts.createSourceFile(name, source, version, true)
    : original.call(host, name, version, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: ['main.ts'], options, host });
  const file = program.getSourceFile('main.ts');
  assert.ok(file);
  const checker = program.getTypeChecker();
  return { program, file, checker, index: buildFileIndex(checker, file, () => undefined) };
}

function contextOf(source: string, overrides: Partial<MutationSafetyContext> = {}): MutationSafetyContext & { source: IndexedSource } {
  const indexed = indexedSource(source);
  return {
    source: indexed,
    checker: indexed.checker,
    index: indexed.index,
    isDefaultLibraryFile: (file) => indexed.program.isSourceFileDefaultLibrary(file),
    openProgram: false,
    openProperties: false,
    ...overrides,
  };
}

function text(node: ts.Node | undefined): string | undefined {
  return node?.getText();
}

function declarationOf(descriptor: NativeMapDescriptor): ts.VariableDeclaration {
  return descriptor.declaration;
}

test('private top-level const new Map() records direct operations and every set expression', () => {
  const source = [
    'declare const dynamicKey: string;',
    'declare function makeFirst(): object;',
    'declare function makeSecond(): object;',
    'declare function makeThird(): object;',
    'const registry = new Map();',
    'registry.set("first", makeFirst());',
    'registry.set(dynamicKey, makeSecond());',
    'registry.set("first", makeThird());',
    'const first = registry.get("first");',
    'const present = registry.has("second");',
    'registry.delete("old");',
    'registry.clear();',
    'const keys = registry.keys();',
    'const size = registry.size;',
  ].join('\n');
  const context = contextOf(source);
  const descriptors = collectNativeMapDescriptors(context);

  assert.equal(descriptors.length, 1);
  const descriptor = descriptors[0]!;
  assert.equal(text(declarationOf(descriptor).name), 'registry');
  assert.deepEqual(descriptor.sets.map((set) => ({ key: text(set.key), value: text(set.value) })), [
    { key: '"first"', value: 'makeFirst()' },
    { key: 'dynamicKey', value: 'makeSecond()' },
    { key: '"first"', value: 'makeThird()' },
  ]);
  assert.deepEqual(descriptor.values.map(text), ['makeFirst()', 'makeSecond()', 'makeThird()']);
  assert.deepEqual(descriptor.uses.map((use) => use.operation), ['set', 'set', 'set', 'get', 'has', 'delete', 'clear', 'keys', 'size']);

  const firstGet = descriptor.uses.find((use) => use.operation === 'get');
  const dynamicSet = descriptor.sets[1]!;
  assert.ok(firstGet);
  assert.deepEqual(nativeMapValuesForKey(descriptor, firstGet.key, context), descriptor.values);
  assert.deepEqual(nativeMapValuesForKey(descriptor, dynamicSet.key, context), descriptor.values);
});

test('Map aliases, exports, escapes, optional/computed/detached/chained calls and unsupported methods are rejected', () => {
  const invalidSources = [
    'const registry = new Map(); const alias = registry;',
    'const registry = new Map(); export { registry };',
    'const registry = new Map(); function read(): Map<unknown, unknown> { return registry; }',
    'declare function consume(value: unknown): void; const registry = new Map(); consume(registry);',
    'const registry = new Map(); registry?.get("key");',
    'const registry = new Map(); const method = registry.get;',
    'const registry = new Map(); registry.get.call(undefined, "key");',
    'const registry = new Map(); registry.set("key", value).get("key"); declare const value: object;',
    'const registry = new Map(); const method = "get"; registry[method]("key");',
    'const registry = new Map(); registry.forEach(() => undefined);',
    'const registry = new Map(); registry.values();',
    'const registry = new Map(); registry.entries();',
    'const registry = new Map(); registry[Symbol.iterator]();',
    'const registry = new Map(); new Proxy(registry, {});',
    'const registry = new Map(); registry.set("key");',
    'const registry = new Map(value); declare const value: object;',
  ];
  for (const source of invalidSources) assert.deepEqual(collectNativeMapDescriptors(contextOf(source)), [], source);
});

test('only the authoritative default-library predicate proves the intrinsic Map constructor', () => {
  const source = 'const registry = new Map(); registry.set("key", value); declare const value: object;';
  assert.equal(collectNativeMapDescriptors(contextOf(source)).length, 1);
  assert.equal(collectNativeMapDescriptors(contextOf(source, { isDefaultLibraryFile: () => false })).length, 0);

  const shadowed = [
    'declare class Map<K = unknown, V = unknown> { constructor(); set(key: K, value: V): this; }',
    'const registry = new Map();',
  ].join('\n');
  assert.equal(collectNativeMapDescriptors(contextOf(shadowed)).length, 0);
});

test('visible Map.prototype writes close intrinsic provenance', () => {
  const source = 'declare const replacement: any; Map.prototype.set = replacement; const registry = new Map(); registry.set("key", replacement);';
  assert.deepEqual(collectNativeMapDescriptors(contextOf(source)), []);
});

test('open program, open properties and opaque imports close the registry proof', () => {
  const source = 'const registry = new Map(); registry.set("key", value); declare const value: object;';
  assert.deepEqual(collectNativeMapDescriptors(contextOf(source, { openProgram: true })), []);
  assert.deepEqual(collectNativeMapDescriptors(contextOf(source, { openProperties: true })), []);
  const opaque = contextOf('const moduleName: string = "./other"; import(moduleName);');
  assert.deepEqual(collectNativeMapDescriptors(opaque), []);
});

test('proxy, unknown receiver setter and Map method replacement keep the descriptor negative', () => {
  const cases = [
    'declare const handler: ProxyHandler<object>; new Proxy(Map.prototype, handler); const registry = new Map(); registry.set("key", value); declare const value: object;',
    'declare const receiver: { key: object }; receiver.key = value; const registry = new Map(); registry.set("key", value); declare const value: object;',
    'Map.prototype.get = replacement; const registry = new Map(); registry.set("key", value); declare const replacement: any; declare const value: object;',
  ];
  for (const source of cases) assert.deepEqual(collectNativeMapDescriptors(contextOf(source)), [], source);
});

test('a set result must be discarded and registry must be top-level const', () => {
  const sources = [
    'function make() { const registry = new Map(); registry.set("key", value); } declare const value: object;',
    'let registry = new Map(); registry.set("key", value); declare const value: object;',
    'const registry = new Map(); const result = registry.set("key", value); declare const value: object;',
    'const registry = new Map(); returnValue(registry.set("key", value)); declare function returnValue(value: unknown): void; declare const value: object;',
  ];
  for (const source of sources) assert.deepEqual(collectNativeMapDescriptors(contextOf(source)), [], source);
});

test('void may explicitly discard a set result', () => {
  const source = 'const registry = new Map(); void registry.set("key", value); declare const value: object;';
  const descriptor = collectNativeMapDescriptors(contextOf(source))[0];
  assert.ok(descriptor);
  assert.deepEqual(descriptor.values.map(text), ['value']);
});

test('native map collection preserves the caller budget signal', () => {
  const context = contextOf('const registry = new Map();', {
    budgetStep: () => { throw new Error('budget'); },
  });
  assert.throws(() => collectNativeMapDescriptors(context), /budget/);
});

test('dirty computed receiver rejects a Map descriptor before irrelevant source scanning', () => {
  const irrelevant = Array.from({ length: 2_000 }, (_, index) => `function unrelated${index}() { return ${index}; }`).join('\n');
  let steps = 0;
  const context = contextOf([
    'declare const receiver: Record<string, object>;',
    'declare const dynamicKey: string;',
    'declare const value: object;',
    'receiver[dynamicKey] = value;',
    'const registry = new Map();',
    'registry.set("key", value);',
    irrelevant,
  ].join('\n'), {
    budgetStep: () => {
      steps++;
      if (steps > 8) throw new Error('budget');
    },
  });
  assert.deepEqual(collectNativeMapDescriptors(context), []);
});

test('Map key identity keeps number and bigint keys distinct while unknown queries use the full union', () => {
  const source = [
    'declare const numberValue: object;',
    'declare const bigintValue: object;',
    'const registry = new Map();',
    'registry.set(1, numberValue);',
    'registry.set(1n, bigintValue);',
    'const numberRead = registry.get(1);',
    'const bigintRead = registry.get(1n);',
  ].join('\n');
  const context = contextOf(source);
  const descriptor = collectNativeMapDescriptors(context)[0];
  assert.ok(descriptor);
  const numberRead = descriptor.uses.find((use) => use.operation === 'get' && use.key?.getText() === '1');
  const bigintRead = descriptor.uses.find((use) => use.operation === 'get' && use.key?.getText() === '1n');
  assert.ok(numberRead && bigintRead);
  assert.deepEqual(nativeMapValuesForKey(descriptor, numberRead.key, context).map(text), ['numberValue']);
  assert.deepEqual(nativeMapValuesForKey(descriptor, bigintRead.key, context).map(text), ['bigintValue']);
  assert.deepEqual(nativeMapValuesForKey(descriptor, undefined, context).map(text), ['numberValue', 'bigintValue']);
});
