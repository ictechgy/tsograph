/** 합성 소스로 독립 매니페스트와 실행 인벤토리의 신뢰 경계를 검증한다. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { buildFileIndex, mergeFlowIndexes } from './flow-index.ts';
import { createEffectManifest, collectEffectPart, reconcileEffectInventory, selectEffectManifest } from './effect-inventory.ts';

/** AST 정체성이 보존되는 합성 입력이다. */
function fixture(text = 'export const value = 1;') {
  const file = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true);
  const files = new Map([['a.ts', file]]);
  const resolve = () => undefined;
  return { file, files, resolve, manifest: createEffectManifest(files, 'whole', resolve) };
}

test('독립 기대 집합은 누락·중복·예상 밖·stale·view 불일치를 거부한다', () => {
  const { file, manifest, resolve } = fixture();
  const part = collectEffectPart(file, resolve);
  assert.equal(reconcileEffectInventory(manifest, [part]).enumeration, 'complete');
  for (const parts of [[], [part, part], [collectEffectPart(fixture('const value = 2;').file, resolve)]]) {
    assert.equal(reconcileEffectInventory(manifest, parts).enumeration, 'incomplete');
  }
  const extra = ts.createSourceFile('extra.ts', '', ts.ScriptTarget.Latest, true);
  assert.equal(reconcileEffectInventory(manifest, [part, collectEffectPart(extra, resolve)]).enumeration, 'incomplete');
  assert.equal(reconcileEffectInventory(manifest, [part], 'production').enumeration, 'incomplete');
  assert.equal(reconcileEffectInventory(manifest, [{ ...part, revision: 'stale' }]).enumeration, 'incomplete');
});

test('열거·별칭·초기화·ambient 안전은 별개이며 타입 내부 실행식은 남는다', () => {
  const { file, manifest, resolve } = fixture('declare const hidden: unknown; interface Erased { x: string }; class C { [observe()] = 1; }; const x = (effect() as number);');
  const inventory = reconcileEffectInventory(manifest, [collectEffectPart(file, resolve)]);
  assert.equal(inventory.enumeration, 'complete');
  assert.equal(inventory.initialization, 'complete');
  assert.equal(inventory.ambientSafety, 'unknown');
  assert.equal(inventory.records.filter((record) => ts.isCallExpression(record.site)).length, 2);
  assert.ok(inventory.records.every((record) => record.site.getText() !== 'hidden'));
});

test('빌드 상한은 경계까지 허용하고 넘으면 query exhaustion 없이 불완전하다', () => {
  const { file, manifest, resolve } = fixture();
  const full = collectEffectPart(file, resolve);
  const exact = collectEffectPart(file, resolve, { visited: full.visited, records: full.retained, perFile: full.visited });
  assert.equal(exact.status, 'complete');
  for (const limits of [{ visited: full.visited - 1, records: 100, perFile: 100 }, { visited: 100, records: 0, perFile: 100 }, { visited: 100, records: 100, perFile: full.visited - 1 }]) {
    const inventory = reconcileEffectInventory(manifest, [collectEffectPart(file, resolve, limits)]);
    assert.equal(inventory.enumeration, 'incomplete');
    assert.ok(inventory.reasons.includes('build-cap'));
    assert.equal(inventory.ambientSafety, 'unknown');
  }
});

test('기록 누락·분류 변경은 ambient 인증을 만들지 못한다', () => {
  const { file, manifest, resolve } = fixture('effect();');
  const part = collectEffectPart(file, resolve);
  for (const records of [[], part.records.map((record) => ({ ...record, operation: 'primitive' as const }))]) {
    const inventory = reconcileEffectInventory(manifest, [{ ...part, records }]);
    assert.ok(inventory.reasons.includes('record-mismatch'));
    assert.equal(inventory.ambientSafety, 'unknown');
  }
  assert.equal(reconcileEffectInventory(manifest, [part], 'whole', {
    references: new Map(), aliasNames: new Map(), tokenOccurrences: new Map(),
  }).referenceAliases, 'incomplete');
});

test('runtime 모듈 집합·간선은 erased import와 구분하고 대상까지 대조한다', () => {
  const { file, files, resolve } = fixture('import type { A } from "./types"; import { type B } from "./types"; export type { A } from "./types"; export { type B } from "./types"; import "./runtime"; export * from "./other";');
  const manifest = createEffectManifest(files, 'whole', resolve);
  const part = collectEffectPart(file, resolve);
  assert.deepEqual(part.moduleEdges.map((edge) => edge.specifier), ['./runtime', './other']);
  assert.deepEqual([...manifest.runtimeModules], [file]);
  const inventory = reconcileEffectInventory(manifest, [part]);
  assert.equal(inventory.enumeration, 'complete');
  assert.equal(inventory.initialization, 'incomplete');
  assert.equal(inventory.ambientSafety, 'unknown');
  assert.ok(reconcileEffectInventory(manifest, [{ ...part, moduleEdges: [] }]).reasons.includes('module-edge-mismatch'));
  const declaration = ts.createSourceFile('types.d.ts', 'declare function hidden(): void;', ts.ScriptTarget.Latest, true);
  const declared = createEffectManifest(new Map([['types.d.ts', declaration]]), 'whole', resolve);
  assert.equal(declared.runtimeModules.size, 0);
  assert.equal(reconcileEffectInventory(declared, [collectEffectPart(declaration, resolve)]).ambientSafety, 'safe');
});

test('생산 관점은 독립 기대 집합이며 whole part를 잘못 섞으면 실패한다', () => {
  const { file, resolve } = fixture();
  const testFile = ts.createSourceFile('a.test.ts', 'effect();', ts.ScriptTarget.Latest, true);
  const whole = createEffectManifest(new Map([['a.ts', file], ['a.test.ts', testFile]]), 'whole', resolve);
  const production = createEffectManifest(new Map([['a.ts', file]]), 'production', resolve);
  const parts = [collectEffectPart(file, resolve), collectEffectPart(testFile, resolve)];
  assert.equal(reconcileEffectInventory(whole, parts).ambientSafety, 'unknown');
  assert.deepEqual(reconcileEffectInventory(whole, [...parts].reverse()).records, reconcileEffectInventory(whole, parts).records);
  assert.equal(reconcileEffectInventory(production, parts.slice(0, 1)).ambientSafety, 'safe');
  assert.equal(reconcileEffectInventory(production, parts).enumeration, 'incomplete');
  const checker = ts.createProgram([], { types: [], noLib: true }).getTypeChecker();
  const index = buildFileIndex(checker, file, resolve);
  assert.equal(mergeFlowIndexes([index], production).effectInventory?.enumeration, 'complete');
  assert.equal(mergeFlowIndexes([{ ...index, files: [] }], production).effectInventory?.enumeration, 'incomplete');
  assert.equal(mergeFlowIndexes([index]).effectInventory, undefined);
});

test('누락 소스·불완전 스캔·parse 오류·기대 정체성 중복은 안전을 주장하지 않는다', () => {
  const { file, files, resolve } = fixture();
  const invalid = ts.createSourceFile('broken.ts', 'const = ;', ts.ScriptTarget.Latest, true);
  for (const manifest of [createEffectManifest(new Map([['missing.ts', undefined]]), 'whole', resolve),
    createEffectManifest(files, 'whole', resolve, false),
    createEffectManifest(new Map([['broken.ts', invalid]]), 'whole', resolve),
    createEffectManifest(new Map([['a.ts', file], ['alias.ts', file]]), 'whole', resolve)]) {
    assert.equal(reconcileEffectInventory(manifest, [collectEffectPart(file, resolve)]).ambientSafety, 'unknown');
  }
});

test('공유 빌드 계수는 파일마다 초기화되지 않는다', () => {
  const { file, resolve } = fixture();
  const full = collectEffectPart(file, resolve);
  const budget = { visited: 0, records: 0, perFileVisited: new Map<ts.SourceFile, number>() };
  const caps = { visited: full.visited, records: full.retained, perFile: full.visited };
  assert.equal(collectEffectPart(file, resolve, caps, budget).status, 'complete');
  assert.equal(collectEffectPart(file, resolve, caps, budget).status, 'incomplete(build-cap)');
});

test('manifest·view projection·part 수집은 global/per-file/retained 계수를 한 번 공유한다', () => {
  const { file, files, resolve } = fixture();
  const full = collectEffectPart(file, resolve);
  const budget = { visited: 0, records: 0, perFileVisited: new Map<ts.SourceFile, number>() };
  const limits = { visited: full.visited * 2, records: full.retained * 2, perFile: full.visited };
  const manifest = createEffectManifest(files, 'whole', resolve, true, budget);
  const beforeProjection = { visited: budget.visited, records: budget.records };
  selectEffectManifest(manifest, files, 'production');
  assert.deepEqual({ visited: budget.visited, records: budget.records }, beforeProjection);
  const second = collectEffectPart(file, resolve, limits, budget);
  assert.equal(second.status, 'incomplete(build-cap)');
  assert.equal(second.visited, 0);
  assert.equal(budget.perFileVisited?.get(file), full.visited);
  assert.equal(budget.records, full.retained);
});

test('지연 body·entry·상속·spread·coercion·저장 평가를 명시적으로 남긴다', () => {
  const { file, manifest, resolve } = fixture(`
    declare class Erased { [notRuntime()]: unknown; }
    interface Shape { [notRuntime()]: string }
    class C extends base() implements Shape {
      constructor(private inputs = entry()) {}
      field = write();
      method() { return (() => new Date())(); }
    }
    const x = { ...spread(), [key()]: coerce() + 1 };
    for (const item of iterate()) use(item);
  `);
  const part = collectEffectPart(file, resolve);
  const inventory = reconcileEffectInventory(manifest, [part]);
  assert.equal(inventory.enumeration, 'complete');
  assert.equal(inventory.ambientSafety, 'unknown');
  assert.ok(!part.records.some((record) => record.site.getText().includes('notRuntime')));
  const kinds = new Set(part.records.map((record) => record.operation));
  for (const operation of ['class', 'call', 'construct', 'write', 'entry', 'iteration', 'spread', 'unknown']) assert.ok(kinds.has(operation as typeof part.records[number]['operation']));
  assert.ok(part.records.some((record) => record.operation === 'construct' && record.site.getText() === 'new Date()'));
});

test('해석한 정적 모듈 연결은 기대 runtime 집합 안에서만 초기화 범위를 닫는다', () => {
  const sources = new Map([
    ['a.ts', ts.createSourceFile('a.ts', 'import "./b"; export const a = 1;', ts.ScriptTarget.Latest, true)],
    ['b.ts', ts.createSourceFile('b.ts', 'export const b = 2;', ts.ScriptTarget.Latest, true)],
  ]);
  const options = { noLib: true, types: [], module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => sources.get(name);
  const program = ts.createProgram([...sources.keys()], options, host);
  const checker = program.getTypeChecker();
  const target = checker.getSymbolAtLocation(sources.get('b.ts')!);
  assert.ok(target);
  const resolve = () => target;
  const manifest = createEffectManifest(sources, 'whole', resolve);
  const parts = [...sources.values()].map((file) => collectEffectPart(file, resolve, undefined, undefined, checker));
  assert.equal(reconcileEffectInventory(manifest, parts).initialization, 'complete');
  assert.equal(reconcileEffectInventory(manifest, parts).ambientSafety, 'safe');
  const outside = createEffectManifest(new Map([['a.ts', sources.get('a.ts')!]]), 'production', resolve);
  assert.equal(reconcileEffectInventory(outside, parts.slice(0, 1)).initialization, 'incomplete');
  const altered = { ...parts[0]!, moduleEdges: parts[0]!.moduleEdges.map((edge) => ({ ...edge, target: undefined })) };
  assert.ok(reconcileEffectInventory(manifest, [altered, parts[1]!]).reasons.includes('module-edge-mismatch'));
});

test('전역 binding 쓰기는 primitive 초기값이나 const 표기만으로 ambient 안전이 되지 않는다', () => {
  for (const text of ['var Object = 1;', 'const Reflect = 1;', 'let ordinary = 1;']) {
    const { file, manifest, resolve } = fixture(text);
    const part = collectEffectPart(file, resolve);
    assert.equal(reconcileEffectInventory(manifest, [part]).ambientSafety, 'unknown');
    assert.ok(part.records.some((record) => record.operation === 'write'));
  }
});

test('루프·CJS export·빈 binding pattern은 primitive 자식만으로 안전해지지 않는다', () => {
  for (const text of [
    'export = 1;',
    'export {}; while (true) {}',
    'export {}; for (;;) {}',
    'export {}; do {} while (true);',
    'export {}; const {} = null;',
    'export {}; const [] = null;',
  ]) {
    const { file, manifest, resolve } = fixture(text);
    const part = collectEffectPart(file, resolve);
    assert.equal(reconcileEffectInventory(manifest, [part]).ambientSafety, 'unknown', text);
    assert.ok(part.records.some((record) => record.operation !== 'primitive'), text);
  }
});

test('wrapper는 자체 unknown을 만들지 않고 shorthand 값 읽기와 피연산자는 남긴다', () => {
  const source = 'function identity<T>(value: T) { return value; } const local = 1; export const wrapped = ((((local as number)!) satisfies number)); export const instantiated = identity<string>; export const holder = { local };';
  const options = { noLib: true, types: [], module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === 'a.ts' ? ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true) : undefined;
  const program = ts.createProgram(['a.ts'], options, host);
  const file = program.getSourceFile('a.ts')!;
  const checker = program.getTypeChecker();
  const resolve = () => undefined;
  const part = collectEffectPart(file, resolve, undefined, undefined, checker);
  assert.ok(part.records.some((record) => record.operation === 'read' && record.site.getText() === 'local'
    && ts.isShorthandPropertyAssignment(record.site.parent)));
  assert.ok(!part.records.some((record) => record.operation === 'unknown'
    && (ts.isParenthesizedExpression(record.site) || ts.isAsExpression(record.site)
      || ts.isNonNullExpression(record.site) || ts.isSatisfiesExpression(record.site)
      || ts.isTypeAssertionExpression(record.site) || ts.isExpressionWithTypeArguments(record.site))));
  assert.ok(part.records.some((record) => record.operation === 'read' && record.site.getText() === 'identity'));
});

test('runtime import-equals는 초기화 edge이고 type import-equals와 this parameter는 erased다', () => {
  const a = ts.createSourceFile('a.ts', 'import runtime = require("./b"); import type Types = require("./types"); function f<T>(this: T) { return runtime; }', ts.ScriptTarget.Latest, true);
  const b = ts.createSourceFile('b.ts', 'export const value = 1;', ts.ScriptTarget.Latest, true);
  const files = new Map([['a.ts', a], ['b.ts', b]]);
  const options = { noLib: true, types: [], module: ts.ModuleKind.CommonJS };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => files.get(name);
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const target = checker.getSymbolAtLocation(b);
  assert.ok(target);
  const resolve = (specifier: string) => specifier === './b' ? target : undefined;
  const manifest = createEffectManifest(files, 'whole', resolve, true, undefined, checker);
  const parts = [...files.values()].map((file) => collectEffectPart(file, resolve, undefined, undefined, checker));
  const part = parts[0]!;
  assert.deepEqual(part.moduleEdges.map((edge) => edge.specifier), ['./b']);
  assert.ok(!part.records.some((record) => ts.isImportEqualsDeclaration(record.site)
    && record.site.isTypeOnly));
  assert.ok(!part.records.some((record) => ts.isParameter(record.site)
    && ts.isIdentifier(record.site.name) && record.site.name.text === 'this'));
  const inventory = reconcileEffectInventory(manifest, parts);
  assert.equal(inventory.initialization, 'complete');
  assert.equal(inventory.ambientSafety, 'unknown');
  assert.ok(part.records.some((record) => record.operation === 'unknown'
    && ts.isImportEqualsDeclaration(record.site) && !record.site.isTypeOnly));
});

test('manifest 경로·part visited·aggregate cap은 공급 필드를 신뢰하지 않는다', () => {
  const actual = ts.createSourceFile('actual.ts', 'export const value = 1;', ts.ScriptTarget.Latest, true);
  const resolve = () => undefined;
  const mismatched = createEffectManifest(new Map([['expected.ts', actual]]), 'whole', resolve);
  assert.equal(reconcileEffectInventory(mismatched, [collectEffectPart(actual, resolve)]).enumeration, 'incomplete');

  const manifest = createEffectManifest(new Map([['actual.ts', actual]]), 'whole', resolve);
  const part = collectEffectPart(actual, resolve);
  for (const visited of [0, part.visited + 1, 100_001]) {
    const inventory = reconcileEffectInventory(manifest, [{ ...part, visited }]);
    assert.equal(inventory.enumeration, 'incomplete', String(visited));
    assert.equal(inventory.ambientSafety, 'unknown', String(visited));
  }
});

test('reference·alias·token closure는 독립 checker witness와 실제 index map을 대조한다', () => {
  const text = 'const local = () => 1; const holder = { local }; export { local as alias };';
  const options = { noLib: true, types: [], module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => name === 'a.ts' ? ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) : undefined;
  const program = ts.createProgram(['a.ts'], options, host);
  const file = program.getSourceFile('a.ts')!;
  const checker = program.getTypeChecker();
  const resolve = () => undefined;
  const manifest = createEffectManifest(new Map([['a.ts', file]]), 'whole', resolve, true, undefined, checker);
  const index = buildFileIndex(checker, file, resolve);
  for (const forged of [
    { ...index, references: new Map() },
    { ...index, aliasNames: new Map() },
    { ...index, tokenOccurrences: new Map() },
  ]) {
    const inventory = mergeFlowIndexes([forged], manifest).effectInventory!;
    assert.equal(inventory.referenceAliases, 'incomplete');
    assert.ok(inventory.reasons.includes('reference-closure-mismatch'));
  }
});

test('unresolved read는 closure incomplete이고 알려진 untracked member는 incomplete가 아니다', () => {
  const run = (text: string) => {
    const options = { noLib: true, types: [], module: ts.ModuleKind.ESNext };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name) => name === 'a.ts' ? ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true) : undefined;
    const program = ts.createProgram(['a.ts'], options, host);
    const file = program.getSourceFile('a.ts')!;
    const checker = program.getTypeChecker();
    const resolve = () => undefined;
    const manifest = createEffectManifest(new Map([['a.ts', file]]), 'whole', resolve, true, undefined, checker);
    const part = collectEffectPart(file, resolve, undefined, undefined, checker);
    const inventory = mergeFlowIndexes([buildFileIndex(checker, file, resolve)], manifest).effectInventory!;
    return { inventory, part };
  };
  const missing = run('export const x = missing;');
  assert.equal(missing.part.closure.unresolved, true);
  assert.equal(missing.inventory.referenceAliases, 'incomplete');
  const member = run('class Port { send() { return 1; } } const live = new Port(); live.send();');
  assert.equal(member.part.closure.unresolved, false);
  assert.equal(member.inventory.referenceAliases, 'complete');
  const unnamedIndex = run('export const x = [1]; export const y = x["0"];');
  assert.equal(unnamedIndex.part.closure.unresolved, false);
  assert.equal(unnamedIndex.inventory.referenceAliases, 'complete');
  assert.ok(unnamedIndex.part.records.some((record) => record.operation === 'read' && record.site.getText() === 'x["0"]'));
});
