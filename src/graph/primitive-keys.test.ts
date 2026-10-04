/**
 * 정적으로 증명할 수 있는 primitive key의 경계와 Map/property 정규화를 검증한다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { propertyToKey, resolvePrimitiveKeys, type PrimitiveKeyContext } from './primitive-keys.ts';

interface KeySource {
  readonly program: ts.Program;
  readonly file: ts.SourceFile;
  readonly checker: ts.TypeChecker;
}

function keySource(source: string): KeySource {
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => name === 'main.ts'
    ? ts.createSourceFile(name, source, version, true)
    : original.call(host, name, version, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: ['main.ts'], options, host });
  const file = program.getSourceFile('main.ts');
  assert.ok(file);
  return { program, file, checker: program.getTypeChecker() };
}

function contextOf(source: string, overrides: Partial<PrimitiveKeyContext> = {}): PrimitiveKeyContext & { source: KeySource } {
  const sourceInfo = keySource(source);
  return {
    source: sourceInfo,
    checker: sourceInfo.checker,
    isDefaultLibraryFile: (file) => sourceInfo.program.isSourceFileDefaultLibrary(file),
    ...overrides,
  };
}

function expressionOf(sourceOrInfo: string | KeySource, name: string): ts.Expression {
  const sourceInfo = typeof sourceOrInfo === 'string' ? keySource(sourceOrInfo) : sourceOrInfo;
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) found = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(sourceInfo.file);
  assert.ok(found);
  return found;
}

test('literal primitive keys are exact and property conversion follows JavaScript property keys', () => {
  const context = contextOf([
    'const textKey = "text";',
    'const templateKey = `template`;',
    'const numberKey = 42;',
    'const bigintKey = 1n;',
    'const boolKey = true;',
    'const nullKey = null;',
    'const undefinedKey = undefined;',
  ].join('\n'));
  const literals = [
    ['textKey', 'text'],
    ['templateKey', 'template'],
    ['numberKey', 42],
    ['bigintKey', 1n],
    ['boolKey', true],
    ['nullKey', null],
    ['undefinedKey', undefined],
  ] as const;

  for (const [name, expected] of literals) {
    const expression = expressionOf(context.source, name);
    const value = resolvePrimitiveKeys(expression, context, 'map');
    assert.deepEqual(value, [expected], name);
  }

  const negativeContext = contextOf('const key = -0;');
  const negativeZero = expressionOf(negativeContext.source, 'key');
  assert.deepEqual(resolvePrimitiveKeys(negativeZero, negativeContext, 'map'), [0]);
  assert.deepEqual(resolvePrimitiveKeys(negativeZero, negativeContext, 'property'), ['0']);
  assert.equal(propertyToKey(-0), '0');
  assert.equal(propertyToKey(1n), '1');
  assert.equal(propertyToKey(null), 'null');
});

test('immutable const aliases and conditional branches produce a bounded exact union', () => {
  const context = contextOf([
    'declare const condition: boolean;',
    'const first = "first";',
    'const second = 2;',
    'const selected = condition ? first : second;',
  ].join('\n'));
  const selected = expressionOf(context.source, 'selected');
  assert.deepEqual(resolvePrimitiveKeys(selected, context, 'map'), ['first', 2]);

  const tooDeep = contextOf(`const key = ${Array.from({ length: 18 }, (_, index) => `condition${index} ? `).join('')}"done"${')'.repeat(18)};\n` +
    Array.from({ length: 18 }, (_, index) => `declare const condition${index}: boolean;`).join('\n'));
  const deepExpression = expressionOf(tooDeep.source, 'key');
  assert.equal(resolvePrimitiveKeys(deepExpression, tooDeep, 'map'), undefined);
});

test('unsupported enum, object, call, getter and shadowed undefined forms stay unknown', () => {
  const source = [
    'enum Kind { One }',
    'const objectKey = {};',
    'const callKey = makeKey();',
    'const getterKey = holder.key;',
    'const undefined = "shadow";',
    'const shadowed = undefined;',
    'declare function makeKey(): string;',
    'declare const holder: { readonly key: string };',
  ].join('\n');
  const context = contextOf(source);
  for (const name of ['objectKey', 'callKey', 'getterKey', 'shadowed']) {
    assert.equal(resolvePrimitiveKeys(expressionOf(context.source, name), context, 'map'), undefined, name);
  }
  const enumSource = keySource('const key = Kind.One;');
  assert.equal(resolvePrimitiveKeys(expressionOf(enumSource, 'key'), context, 'map'), undefined);
  const unary = contextOf('const key = ~1;');
  assert.equal(resolvePrimitiveKeys(expressionOf(unary.source, 'key'), unary, 'map'), undefined);
  const bigintUnary = contextOf('const key = +1n;');
  assert.equal(resolvePrimitiveKeys(expressionOf(bigintUnary.source, 'key'), bigintUnary, 'map'), undefined);
  const overflow = contextOf('const key = 1e309;');
  assert.equal(resolvePrimitiveKeys(expressionOf(overflow.source, 'key'), overflow, 'map'), undefined);
  const substituted = contextOf('declare const suffix: string; const key = `prefix${suffix}`;');
  assert.equal(resolvePrimitiveKeys(expressionOf(substituted.source, 'key'), substituted, 'map'), undefined);
  const binary = contextOf('declare const condition: boolean; const key = condition || "fallback";');
  assert.equal(resolvePrimitiveKeys(expressionOf(binary.source, 'key'), binary, 'map'), undefined);
});

test('budget exhaustion and key cardinality stop resolution conservatively', () => {
  const source = 'const key = true ? "a" : "b";';
  const exhausted = contextOf(source, { budgetStep: () => { throw new Error('budget'); } });
  assert.throws(() => resolvePrimitiveKeys(expressionOf(exhausted.source, 'key'), exhausted, 'map'), /budget/);

  const branches = Array.from({ length: 65 }, (_, index) => `condition${index} ? "${index}" : `).join('') + '"last"';
  const manySource = `const key = ${branches}${')'.repeat(65)};\n${Array.from({ length: 65 }, (_, index) => `declare const condition${index}: boolean;`).join('\n')}`;
  const manyContext = contextOf(manySource);
  assert.equal(resolvePrimitiveKeys(expressionOf(manyContext.source, 'key'), manyContext, 'map'), undefined);
});
