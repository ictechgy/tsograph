/**
 * mutation 효과의 clean-view 판정 경계만 검증한다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { buildFileIndex, type FlowIndex } from './flow-index.ts';
import { isIntrinsicDefaultLibraryGlobal, isMutationCleanView, type MutationSafetyContext } from './mutation-safety.ts';

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

test('private object-literal own-data primitive writes are clean, unrelated bindings are ignored', () => {
  const context = contextOf([
    'const state = { count: 0, label: "ready" };',
    'state.count = 1;',
    'let unrelated = 0;',
    'unrelated = 1;',
  ].join('\n'));

  assert.equal(isMutationCleanView(context), true);
  assert.equal(isMutationCleanView(contextOf('const state = { 0: 0 }; state[0] = 1;')), true);
});

test('a previously memoized guard cannot bypass the same caller proof budget', () => {
  const source = `${Array.from({ length: 80 }, (_, i) => `const value${i} = ${i};`).join('\n')}\nconst values = [0]; values[0] = 1;`;
  const context = contextOf(source);
  let coldSteps = 0;
  assert.equal(isMutationCleanView({ ...context, budgetStep: () => { coldSteps++; } }), true);
  assert.ok(coldSteps > 1);
  let remaining = coldSteps - 1;
  assert.throws(() => isMutationCleanView({ ...context, budgetStep: () => {
    if (--remaining < 0) throw new Error('caller proof budget exhausted');
  } }), /caller proof budget exhausted/);
  let warmSteps = 0;
  assert.equal(isMutationCleanView({ ...context, budgetStep: () => { warmSteps++; } }), true);
  assert.equal(warmSteps, coldSteps);
});

test('qualified and bare intrinsic aliases both reject computed reflective members', () => {
  for (const owner of ['Reflect', 'globalThis.Reflect']) {
    const context = contextOf(`const G = ${owner}; const member = 'define' + 'Property';
      const target = { x: 0 }; G[member](target, 'x', { value: 1 });`);
    assert.equal(isMutationCleanView(context), false, owner);
  }
});

test('budgeted and unbudgeted clean views recheck current dynamic reference tokens', () => {
  for (const budgeted of [false, true]) {
    const context = contextOf('const values = [0]; values[0];');
    let steps = 0;
    assert.equal(isMutationCleanView(budgeted
      ? { ...context, budgetStep: () => { steps++; } } : context), true);
    if (budgeted) assert.ok(steps > 0);
    const injected = ts.createSourceFile('injected.ts', 'eval("x");', ts.ScriptTarget.ES2022, true);
    const statement = injected.statements[0];
    assert.ok(statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression));
    const token = statement.expression.expression;
    assert.ok(ts.isIdentifier(token));
    const tokens = context.index.tokenOccurrences as Map<string, readonly ts.Node[]>;
    const previous = tokens.get('eval');
    tokens.set('eval', [token]);
    assert.equal(isMutationCleanView({ ...context, index: {
      ...context.index, tokenOccurrences: new Map(tokens),
    } }), false);
    assert.equal(isMutationCleanView(context), false);
    if (previous === undefined) tokens.delete('eval');
    else tokens.set('eval', previous);
    assert.equal(isMutationCleanView(context), true);
  }
});

test('an array view rechecks reference escapes and recovers after restoration', () => {
  const context = contextOf('const values = [0]; values[0];');
  assert.equal(isMutationCleanView(context), true);
  const declaration = context.source.file.statements[0];
  assert.ok(declaration && ts.isVariableStatement(declaration));
  const binding = declaration.declarationList.declarations[0];
  assert.ok(binding);
  const symbol = context.checker.getSymbolAtLocation(binding.name);
  assert.ok(symbol);
  const injected = ts.createSourceFile('escape.ts', 'consume(values);', ts.ScriptTarget.ES2022, true);
  const statement = injected.statements[0];
  assert.ok(statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression));
  const token = statement.expression.arguments[0];
  assert.ok(token && ts.isIdentifier(token));
  const references = context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
  const previous = references.get(symbol);
  references.set(symbol, [...(previous ?? []), token]);
  assert.equal(isMutationCleanView({ ...context, index: {
    ...context.index, references: new Map(references),
  } }), false);
  assert.equal(isMutationCleanView(context), false);
  if (previous === undefined) references.delete(symbol);
  else references.set(symbol, previous);
  assert.equal(isMutationCleanView(context), true);
});

test('unknown receivers, unknown keys, updates, deletes and reflective effects are unsafe', () => {
  const context = contextOf([
    'declare const receiver: { known: number };',
    'declare const unknownKey: string;',
    'receiver.known = 1;',
    'receiver[unknownKey] = 2;',
    'receiver.known++;',
    'delete receiver.known;',
    'Object.defineProperty(receiver, "known", { value: 3 });',
    'Object.setPrototypeOf(receiver, null);',
  ].join('\n'));

  assert.equal(isMutationCleanView(context), false);
});

test('only the exact audited site may be skipped and every other mutation is still scanned', () => {
  const context = contextOf([
    'const first = { value: 0 };',
    'first.value = 1;',
    'declare const receiver: { value: number };',
    'receiver.value = 2;',
  ].join('\n'));
  const sites = context.index.mutations.filter((record) => record.operation === 'assignment').map((record) => record.site);

  assert.equal(sites.length, 2);
  assert.equal(isMutationCleanView(context, { allowedSites: new Set([sites[0]!]) }), false);
  assert.equal(isMutationCleanView(context, { allowedSites: new Set(sites) }), true);
});

test('escaping objects, non-primitive values, eval, Function and Proxy disable the proof', () => {
  const escaped = contextOf([
    'const state = { count: 0 };',
    'consume(state);',
    'state.count = 1;',
    'declare function consume(value: object): void;',
  ].join('\n'));
  assert.equal(isMutationCleanView(escaped), false);

  const nonPrimitive = contextOf([
    'const state = { count: 0 };',
    'state.count = makeValue();',
    'declare function makeValue(): object;',
  ].join('\n'));
  assert.equal(isMutationCleanView(nonPrimitive), false);

  for (const source of [
    'const run = eval;',
    'const run = Function;',
    'const proxy = Proxy.revocable({}, {}).proxy;',
  ]) {
    assert.equal(isMutationCleanView(contextOf(source)), false, source);
  }
});

test('open analysis context and opaque imports are not clean views', () => {
  const source = 'const state = { count: 0 }; state.count = 1;';
  assert.equal(isMutationCleanView(contextOf(source, { openProgram: true })), false);
  assert.equal(isMutationCleanView(contextOf(source, { openProperties: true })), false);
  const opaque = contextOf('const moduleName: string = "./other"; import(moduleName);');
  assert.equal(isMutationCleanView(opaque), false);
});

test('builtin mutator aliases, call/apply/bind and dynamic Object or Reflect reads are unsafe', () => {
  const cases = [
    'const patch = Object.setPrototypeOf.bind(null, Map.prototype); patch(Map.prototype, null);',
    'const owner = Object; const method = "setPrototypeOf"; owner[method](Map.prototype, null);',
    'const first = Reflect; const second = first; const third = second; const patch = third.deleteProperty; patch(target, "key"); declare const target: object;',
    'const patch = Object.defineProperty; patch.call(Object.prototype, "key", descriptor); declare const descriptor: PropertyDescriptor;',
    'const method = "set"; Reflect[method](target, "key", value); declare const target: object; declare const value: unknown;',
    'const name: string = "Proxy"; globalThis[name];',
    'globalThis["Proxy"];',
  ];
  for (const source of cases) assert.equal(isMutationCleanView(contextOf(source)), false, source);
});

test('global Map and Date member replacements are visible to the guard', () => {
  for (const source of [
    'Map = Replacement; declare let Replacement: typeof Map;',
    'globalThis.Map = Replacement; declare const Replacement: typeof Map;',
    'globalThis.Date.prototype.now = replacement; declare const replacement: () => number;',
    'globalThis["Map"].prototype.set = replacement; declare const replacement: any;',
    'const globalObject = globalThis; globalObject["Map"].prototype.set = replacement; declare const replacement: any;',
  ]) assert.equal(isMutationCleanView(contextOf(source)), false, source);
});

test('object accessor, spread and computed properties do not become own-data proofs', () => {
  const cases = [
    'const state = { get count() { return 0; } }; state.count = 1;',
    'declare const source: object; const state = { ...source, count: 0 }; state.count = 1;',
    'const name = "count"; const state = { [name]: 0 }; state.count = 1;',
    'const state = { 1n: 0 }; state["1"] = 1;',
  ];
  for (const source of cases) assert.equal(isMutationCleanView(contextOf(source)), false, source);
});

test('intrinsic helper needs the authoritative default-library predicate and visible writes', () => {
  const context = contextOf('const registry = new Map();');
  const mapIdentifier = context.source.file.statements[0];
  assert.ok(mapIdentifier && ts.isVariableStatement(mapIdentifier));
  const initializer = mapIdentifier.declarationList.declarations[0]?.initializer;
  assert.ok(initializer && ts.isNewExpression(initializer));
  assert.equal(isIntrinsicDefaultLibraryGlobal(context, initializer.expression, 'Map'), true);
  assert.equal(isIntrinsicDefaultLibraryGlobal({ ...context, isDefaultLibraryFile: () => false }, initializer.expression, 'Map'), false);

  const writes = contextOf('Map.prototype.get = replacement; const registry = new Map(); declare const replacement: any;');
  const map = writes.source.file.statements[0];
  assert.ok(map && ts.isExpressionStatement(map));
  const target = map.expression;
  assert.ok(ts.isBinaryExpression(target));
  assert.ok(ts.isPropertyAccessExpression(target.left));
  const mapExpression = target.left.expression;
  assert.ok(ts.isPropertyAccessExpression(mapExpression));
  assert.equal(isIntrinsicDefaultLibraryGlobal(writes, mapExpression.expression, 'Map'), false);
});

test('opaque mutation index state closes both the clean-view result and audited exceptions', () => {
  const context = contextOf('const state = { count: 0 }; state.count = 1;');
  const opaque = { ...context.index, hasOpaqueMutation: true };
  assert.equal(isMutationCleanView({ ...context, index: opaque }), false);
});

test('caller budget exceptions propagate instead of becoming silent clean-view failures', () => {
  const context = contextOf('const state = { count: 0 }; state.count = 1;', {
    budgetStep: () => { throw new Error('budget'); },
  });
  assert.throws(() => isMutationCleanView(context), /budget/);
});

test('dirty computed receivers fail before a large irrelevant AST scan consumes the query budget', () => {
  const irrelevant = Array.from({ length: 2_000 }, (_, index) => `function irrelevant${index}() { return ${index}; }`).join('\n');
  const context = contextOf([
    'declare const receiver: Record<string, number>;',
    'declare const dynamicKey: string;',
    'receiver[dynamicKey] = 1;',
    irrelevant,
  ].join('\n'), {
    budgetStep: (() => {
      let steps = 0;
      return () => {
        steps++;
        if (steps > 8) throw new Error('budget');
      };
    })(),
  });
  assert.equal(isMutationCleanView(context), false);
});

test('private primitive array literals allow only exact existing own-index writes', () => {
  const context = contextOf([
    'const scratch = [0];',
    'const key = 0;',
    'scratch[key] = 1;',
    'const read = scratch[0];',
  ].join('\n'));
  assert.equal(isMutationCleanView(context), true);
});

test('array methods, holes, aliases, escapes, shape changes, readonly arrays and factories stay unsafe', () => {
  const cases = [
    'const scratch = [0]; scratch.push(1);',
    'const scratch = [0,,1]; scratch[0] = 1;',
    'const scratch = [0]; const alias = scratch; scratch[0] = 1;',
    'declare function consume(value: unknown): void; const scratch = [0]; consume(scratch); scratch[0] = 1;',
    'const scratch = [0]; scratch[1] = 1;',
    'const scratch = [0]; scratch.length = 0;',
    'const scratch = [0]; delete scratch[0];',
    'const scratch = [0]; scratch[0]++;',
    'const scratch: readonly number[] = [0]; scratch[0] = 1;',
    'const scratch: readonly [number] = [0]; scratch[0] = 1;',
    'declare function make(): number[]; const scratch = make(); scratch[0] = 1;',
    'const scratch = new Uint8Array([0]); scratch[0] = 1;',
    'declare const dynamicKey: string; const scratch = [0]; scratch[dynamicKey] = 1;',
    'const scratch = [0]; scratch["01"] = 1;',
    'const scratch = [0]; scratch[-1] = 1;',
    'const scratch = [0]; scratch[4294967295] = 1;',
    'const scratch = [{}]; scratch[0] = 1;',
    'Array.prototype.push = replacement; const scratch = [0]; scratch[0] = 1; declare const replacement: any;',
  ];
  for (const source of cases) assert.equal(isMutationCleanView(contextOf(source)), false, source);
});
