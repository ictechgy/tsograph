/**
 * 구조화한 mutation 색인이 기존 보수적 flow 색인과 함께 모든 주요 mutation 문법을 보존하는지 검증한다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { buildFileIndex, type FlowIndex, type MutationRecord } from './flow-index.ts';

/** 합성 소스 하나를 TypeScript 프로그램으로 만들어 색인한다. */
function indexOf(source: string): { file: ts.SourceFile; index: FlowIndex } {
  return indexOfFiles({ 'main.ts': source });
}

/** 여러 합성 소스를 TypeScript 프로그램으로 만들어 주어진 main 파일을 색인한다. */
function indexOfFiles(sources: Record<string, string>): { file: ts.SourceFile; index: FlowIndex } {
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => sources[name] !== undefined
    ? ts.createSourceFile(name, sources[name]!, version, true)
    : original.call(host, name, version, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: Object.keys(sources), options, host });
  const file = program.getSourceFile('main.ts');
  assert.ok(file);
  return { file, index: buildFileIndex(program.getTypeChecker(), file, () => undefined) };
}

function text(node: ts.Node | undefined): string | undefined {
  return node?.getText();
}

function summary(record: MutationRecord): Record<string, unknown> {
  return {
    operation: record.operation,
    effect: record.effect,
    target: text(record.target),
    key: text(record.key),
    staticKey: record.staticKey,
    value: text(record.value),
    source: text(record.source),
    sources: record.sources.map(text),
    descriptor: text(record.descriptor),
    prototype: text(record.prototype),
    site: ts.SyntaxKind[record.site.kind],
  };
}

test('구조화한 mutation 색인이 직접·계산·반사·프로토타입 쓰기의 근거를 보존한다', () => {
  const { index } = indexOf([
    'declare const dynamicKey: string;',
    'declare const value: unknown;',
    'declare const source: object;',
    'declare const secondSource: object;',
    'declare const descriptor: PropertyDescriptor;',
    'declare const descriptors: PropertyDescriptorMap;',
    'declare const proto: object | null;',
    'const target: Record<string, unknown> = {};',
    'target.field = value;',
    'target[dynamicKey] = value;',
    'target.field++;',
    'delete target.field;',
    'delete target[dynamicKey];',
    'Object.assign(target, source, secondSource);',
    'Object.defineProperty(target, "defined", descriptor);',
    'Object.defineProperty(target, "__proto__", descriptor);',
    'Object.defineProperties(target, descriptors);',
    'Reflect.set(target, "reflected", value);',
    'Reflect.defineProperty(target, dynamicKey, descriptor);',
    'Reflect.deleteProperty(target, "removed");',
    'Object.setPrototypeOf(target, proto);',
    'Reflect.setPrototypeOf(target, proto);',
    'target.__proto__ = proto;',
  ].join('\n'));

  assert.deepEqual(index.mutations.map(summary), [
    { operation: 'assignment', effect: 'property', target: 'target', key: 'field', staticKey: 'field', value: 'value', source: undefined, sources: [], descriptor: undefined, prototype: undefined, site: 'BinaryExpression' },
    { operation: 'assignment', effect: 'property', target: 'target', key: 'dynamicKey', staticKey: undefined, value: 'value', source: undefined, sources: [], descriptor: undefined, prototype: undefined, site: 'BinaryExpression' },
    { operation: 'update', effect: 'property', target: 'target', key: 'field', staticKey: 'field', value: undefined, source: undefined, sources: [], descriptor: undefined, prototype: undefined, site: 'PostfixUnaryExpression' },
    { operation: 'delete', effect: 'property', target: 'target', key: 'field', staticKey: 'field', value: undefined, source: undefined, sources: [], descriptor: undefined, prototype: undefined, site: 'DeleteExpression' },
    { operation: 'delete', effect: 'property', target: 'target', key: 'dynamicKey', staticKey: undefined, value: undefined, source: undefined, sources: [], descriptor: undefined, prototype: undefined, site: 'DeleteExpression' },
    { operation: 'object.assign', effect: 'property', target: 'target', key: undefined, staticKey: undefined, value: undefined, source: 'source', sources: ['source', 'secondSource'], descriptor: undefined, prototype: undefined, site: 'CallExpression' },
    { operation: 'object.defineProperty', effect: 'property', target: 'target', key: '"defined"', staticKey: 'defined', value: undefined, source: undefined, sources: [], descriptor: 'descriptor', prototype: undefined, site: 'CallExpression' },
    { operation: 'object.defineProperty', effect: 'property', target: 'target', key: '"__proto__"', staticKey: '__proto__', value: undefined, source: undefined, sources: [], descriptor: 'descriptor', prototype: undefined, site: 'CallExpression' },
    { operation: 'object.defineProperties', effect: 'property', target: 'target', key: undefined, staticKey: undefined, value: undefined, source: undefined, sources: [], descriptor: 'descriptors', prototype: undefined, site: 'CallExpression' },
    { operation: 'reflect.set', effect: 'property', target: 'target', key: '"reflected"', staticKey: 'reflected', value: 'value', source: undefined, sources: [], descriptor: undefined, prototype: undefined, site: 'CallExpression' },
    { operation: 'reflect.defineProperty', effect: 'property', target: 'target', key: 'dynamicKey', staticKey: undefined, value: undefined, source: undefined, sources: [], descriptor: 'descriptor', prototype: undefined, site: 'CallExpression' },
    { operation: 'reflect.deleteProperty', effect: 'property', target: 'target', key: '"removed"', staticKey: 'removed', value: undefined, source: undefined, sources: [], descriptor: undefined, prototype: undefined, site: 'CallExpression' },
    { operation: 'object.setPrototypeOf', effect: 'prototype', target: 'target', key: undefined, staticKey: undefined, value: undefined, source: undefined, sources: [], descriptor: undefined, prototype: 'proto', site: 'CallExpression' },
    { operation: 'reflect.setPrototypeOf', effect: 'prototype', target: 'target', key: undefined, staticKey: undefined, value: undefined, source: undefined, sources: [], descriptor: undefined, prototype: 'proto', site: 'CallExpression' },
    { operation: 'proto', effect: 'prototype', target: 'target', key: '__proto__', staticKey: '__proto__', value: 'proto', source: undefined, sources: [], descriptor: undefined, prototype: 'proto', site: 'BinaryExpression' },
  ]);
  assert.equal(index.mutations.find((record) => record.operation === 'assignment')?.confidence, 'known');
  assert.equal(index.mutations.find((record) => record.operation === 'object.assign')?.confidence, 'unknown');
});

test('프로토타입 mutation은 legacy reflectiveTargets에도 보수적으로 무효화 대상을 남긴다', () => {
  const { index } = indexOf([
    'declare const proto: object | null;',
    'const first: object = {};',
    'const second: object = {};',
    'Object.setPrototypeOf(first, proto);',
    'Reflect.setPrototypeOf(second, proto);',
    'first.__proto__ = proto;',
    'second["__proto__"] = proto;',
  ].join('\n'));

  assert.deepEqual(index.mutations.filter((record) => record.effect === 'prototype').map(summary), [
    { operation: 'object.setPrototypeOf', effect: 'prototype', target: 'first', key: undefined, staticKey: undefined, value: undefined, source: undefined, sources: [], descriptor: undefined, prototype: 'proto', site: 'CallExpression' },
    { operation: 'reflect.setPrototypeOf', effect: 'prototype', target: 'second', key: undefined, staticKey: undefined, value: undefined, source: undefined, sources: [], descriptor: undefined, prototype: 'proto', site: 'CallExpression' },
    { operation: 'proto', effect: 'prototype', target: 'first', key: '__proto__', staticKey: '__proto__', value: 'proto', source: undefined, sources: [], descriptor: undefined, prototype: 'proto', site: 'BinaryExpression' },
    { operation: 'proto', effect: 'prototype', target: 'second', key: '"__proto__"', staticKey: '__proto__', value: 'proto', source: undefined, sources: [], descriptor: undefined, prototype: 'proto', site: 'BinaryExpression' },
  ]);
  assert.deepEqual(index.reflectiveTargets.map(text), ['first', 'second', 'first', 'second']);
});

test('반사 built-in 표기가 shadow되거나 별칭이면 unknown confidence를 보존한다', () => {
  const { index } = indexOf([
    'declare const target: object;',
    'declare const source: object;',
    'declare const operation: string;',
    'function shadow(Object: { assign(target: object, source: object): object }, Reflect: { set(target: object, key: string, value: object): boolean }) {',
    '  Object.assign(target, source);',
    '  Reflect.set(target, "key", source);',
    '}',
    'const assign = Object.assign;',
    'assign(target, source);',
    'const changePrototype = Reflect.setPrototypeOf;',
    'changePrototype(target, source);',
    'Object[operation](target, source);',
  ].join('\n'));

  const reflective = index.mutations.filter((record) => record.site.kind === ts.SyntaxKind.CallExpression);
  assert.equal(reflective.length, 5);
  assert.deepEqual(reflective.map((record) => [record.operation, record.confidence, text(record.target), text(record.key)]), [
    ['object.assign', 'unknown', 'target', undefined],
    ['reflect.set', 'unknown', 'target', '"key"'],
    ['object.assign', 'unknown', 'target', undefined],
    ['reflect.setPrototypeOf', 'unknown', 'target', undefined],
    ['unknown', 'unknown', 'target', undefined],
  ]);
});

test('프로젝트 declaration file의 Object shadow도 intrinsic confidence를 만들지 않는다', () => {
  const { index } = indexOfFiles({
    'main.ts': [
      'declare const target: object;',
      'declare const source: object;',
      'Object.assign(target, source);',
    ].join('\n'),
    'project-globals.d.ts': 'declare const Object: { assign(target: object, source: object): object };\n',
  });

  assert.deepEqual(index.mutations.map((record) => [record.operation, record.confidence, text(record.target)]), [
    ['object.assign', 'unknown', 'target'],
  ]);
});

test('읽기 전용 built-in과 provenance 없는 같은 이름 함수는 mutation으로 열지 않는다', () => {
  const { index } = indexOf([
    'declare const target: object;',
    'declare const source: object;',
    'function assign(_target: object, _source: object): void {}',
    'function set(_target: object, _key: string, _value: object): void {}',
    'function defineProperty(_target: object, _key: string, _descriptor: PropertyDescriptor): void {}',
    'Object.keys(target);',
    'Object.values(target);',
    'Object.fromEntries([]);',
    'Reflect.get(target, "key");',
    'Reflect.ownKeys(target);',
    'assign(target, source);',
    'set(target, "key", source);',
    'defineProperty(target, "key", {});',
  ].join('\n'));

  assert.equal(index.mutations.length, 0);
  assert.equal(index.reflectiveTargets.length, 0);
});

test('mutation built-in의 긴 alias 추적 실패는 opaque로 남고 일반 local alias cycle은 오염시키지 않는다', () => {
  const longAliasCount = 66;
  const longAliases = [
    'const alias0 = Object.setPrototypeOf;',
    ...Array.from({ length: longAliasCount }, (_, index) => `const alias${index + 1} = alias${index};`),
    `alias${longAliasCount}(target, source);`,
  ];
  const ordinaryAliases = [
    'const local = (_target: object, _source: object): void => {};',
    'const localAlias0 = local;',
    ...Array.from({ length: 8 }, (_, index) => `const localAlias${index + 1} = localAlias${index};`),
    'localAlias8(target, source);',
    'let cycle = local;',
    'cycle = local;',
    'cycle(target, source);',
  ];

  const long = indexOf([
    'declare const target: object;',
    'declare const source: object;',
    ...longAliases,
  ].join('\n')).index;
  assert.equal(long.mutations.length, 0);
  assert.equal(long.reflectiveTargets.length, 0);
  assert.equal(long.hasOpaqueMutation, true);

  const ordinary = indexOf([
    'declare const target: object;',
    'declare const source: object;',
    ...ordinaryAliases,
  ].join('\n')).index;
  assert.equal(ordinary.mutations.filter((record) => record.effect !== 'binding').length, 0);
  assert.equal(ordinary.reflectiveTargets.length, 0);
  assert.equal(ordinary.hasOpaqueMutation, false);
});

test('mutation built-in의 call/apply/bind escape는 opaque로 남긴다', () => {
  const { index } = indexOf([
    'declare const target: object;',
    'declare const source: object;',
    'const assign = Object.assign;',
    'assign.call(null, target, source);',
    'assign.apply(null, [target, source]);',
    'const bound = assign.bind(null);',
    'bound(target, source);',
    'Object.setPrototypeOf.call(null, target, source);',
  ].join('\n'));

  assert.equal(index.hasOpaqueMutation, true);
  assert.equal(index.mutations.length, 0);
  assert.equal(index.reflectiveTargets.length, 0);
});

test('destructured/imported mutator values are opaque even when the call target is beyond alias indexing', () => {
  const destructured = indexOf([
    'declare const target: object;',
    'declare const source: object;',
    'const { setPrototypeOf } = Object;',
    'setPrototypeOf(target, source);',
  ].join('\n')).index;
  assert.equal(destructured.hasOpaqueMutation, true);
  assert.equal(destructured.mutations.length, 0);

  const imported = indexOfFiles({
    'main.ts': [
      'import { setPrototypeOf as importedSet } from "./helpers";',
      'declare const target: object;',
      'declare const source: object;',
      'importedSet(target, source);',
    ].join('\n'),
    'helpers.ts': 'export function setPrototypeOf(_target: object, _prototype: object): void {}\n',
  }).index;
  assert.equal(imported.hasOpaqueMutation, true);
  assert.equal(imported.mutations.length, 0);
});

test('legacy getter/setter member mutation is opaque across direct, string, alias, prototype and escape forms', () => {
  const { index } = indexOf([
    'declare const bag: { __defineGetter__: Function; __defineSetter__: Function };',
    'declare const value: object;',
    'bag.__defineGetter__("field", () => value);',
    'bag["__defineSetter__"]("field", () => value);',
    'const getter = bag.__defineGetter__;',
    'getter("field", () => value);',
    'const { __defineGetter__: destructuredGetter } = bag;',
    'destructuredGetter("field", () => value);',
    'Object.prototype.__defineGetter__("field", () => value);',
    'Map.prototype.__defineSetter__("field", () => value);',
    'bag.__defineGetter__.call(bag, "field", () => value);',
    'bag.__defineSetter__.apply(bag, ["field", () => value]);',
    'const bound = bag.__defineGetter__.bind(bag);',
    'bound("field", () => value);',
  ].join('\n'));

  assert.equal(index.hasOpaqueMutation, true);
  assert.equal(index.mutations.length, 0);
});

test('legacy getter/setter imports are opaque while bare same-named functions are not', () => {
  const imported = indexOfFiles({
    'main.ts': [
      'import { __defineGetter__ as importedGetter, "__defineSetter__" as importedSetter } from "./helpers";',
      'declare const target: object;',
      'importedGetter(target, "field", () => 1);',
      'importedSetter(target, "field", () => 1);',
    ].join('\n'),
    'helpers.ts': [
      'export function __defineGetter__(_target: object, _key: string, _value: () => number): void {}',
      'export function __defineSetter__(_target: object, _key: string, _value: () => number): void {}',
    ].join('\n'),
  }).index;
  assert.equal(imported.hasOpaqueMutation, true);

  const bare = indexOf([
    'declare const target: object;',
    'function __defineGetter__(_target: object, _key: string, _value: () => number): void {}',
    '__defineGetter__(target, "field", () => 1);',
  ].join('\n')).index;
  assert.equal(bare.hasOpaqueMutation, false);
});
