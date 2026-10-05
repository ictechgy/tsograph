/** 합성 소스로 독립 매니페스트와 실행 인벤토리의 신뢰 경계를 검증한다. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { buildFileIndex, mergeFlowIndexes } from './flow-index.ts';
import { EFFECT_BUILD_CAPS, createEffectManifest, collectEffectPart, reconcileEffectInventory, selectEffectManifest,
  type EffectBuildBudget, type EffectPart } from './effect-inventory.ts';

/** AST 정체성이 보존되는 합성 입력이다. */
function fixture(text = 'export const value = 1;') {
  const file = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true);
  const files = new Map([['a.ts', file]]);
  const resolve = () => undefined;
  return { file, files, resolve, manifest: createEffectManifest(files, 'whole', resolve) };
}

/** 실제 module resolution과 기본 lib를 유지하는 메모리 Program이다. */
function checkedSources(entries: Readonly<Record<string, string>>, options: ts.CompilerOptions = {}): {
  files: ReadonlyMap<string, ts.SourceFile>;
  checker: ts.TypeChecker;
} {
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...options,
  };
  const texts = new Map(Object.entries(entries));
  const host = ts.createCompilerHost(compilerOptions, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (name) => texts.has(name) || fileExists(name);
  host.readFile = (name) => texts.get(name) ?? readFile(name);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = texts.get(name);
    return text === undefined ? getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile)
      : ts.createSourceFile(name, text, languageVersion, true);
  };
  const program = ts.createProgram([...texts.keys()], compilerOptions, host);
  return {
    files: new Map([...texts.keys()].map((name) => [name, program.getSourceFile(name)!])),
    checker: program.getTypeChecker(),
  };
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
  const poison = new Proxy([part, part], {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error('part count must be rejected before copying');
      return Reflect.get(target, property, receiver);
    },
  });
  assert.doesNotThrow(() => reconcileEffectInventory(manifest, poison));
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
  const emitPolicy = { preserveTypeOnlySpecifiers: false };
  const manifest = createEffectManifest(files, 'whole', resolve, true, undefined, undefined, emitPolicy);
  const part = collectEffectPart(file, resolve, undefined, undefined, undefined, emitPolicy);
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

test('all-type 지정자의 runtime edge는 실제 emit policy를 따르고 선언 단위 type import/export는 지운다', () => {
  const file = ts.createSourceFile('a.ts', 'import { type A } from "./b"; export { type B } from "./b";', ts.ScriptTarget.Latest, true);
  const resolve = () => undefined;
  const erasedPart = collectEffectPart(file, resolve, undefined, undefined, undefined, { preserveTypeOnlySpecifiers: false });
  const preservedPart = collectEffectPart(file, resolve, undefined, undefined, undefined, { preserveTypeOnlySpecifiers: true });
  assert.deepEqual(erasedPart.moduleEdges, []);
  assert.deepEqual(preservedPart.moduleEdges.map((edge) => edge.specifier), ['./b', './b']);

  const declarationType = ts.createSourceFile('types.ts', 'import type { A } from "./b"; export type { B } from "./b";', ts.ScriptTarget.Latest, true);
  assert.deepEqual(collectEffectPart(declarationType, resolve, undefined, undefined, undefined,
    { preserveTypeOnlySpecifiers: true }).moduleEdges, []);
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
  const budget: EffectBuildBudget = { visited: 0, records: 0, perFileVisited: new Map<ts.SourceFile, number>() };
  const caps = { visited: full.visited, records: full.retained, perFile: full.visited };
  assert.equal(collectEffectPart(file, resolve, caps, budget).status, 'complete');
  assert.equal(collectEffectPart(file, resolve, caps, budget).status, 'incomplete(build-cap)');
});

test('manifest·view projection·part 수집은 global/per-file/retained 계수를 한 번 공유한다', () => {
  const { file, files, resolve } = fixture();
  const full = collectEffectPart(file, resolve);
  const budget: EffectBuildBudget = { visited: 0, records: 0, perFileVisited: new Map<ts.SourceFile, number>() };
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
    'export {}; using resource = "x";',
    'export {}; await using resource = null;',
  ]) {
    const { file, manifest, resolve } = fixture(text);
    const part = collectEffectPart(file, resolve);
    assert.equal(reconcileEffectInventory(manifest, [part]).ambientSafety, 'unknown', text);
    assert.ok(part.records.some((record) => record.operation !== 'primitive'), text);
  }
  const inert = fixture('export {}; const resource = "x";');
  assert.equal(reconcileEffectInventory(inert.manifest, [collectEffectPart(inert.file, inert.resolve)]).ambientSafety, 'safe');
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
  const elsewhere = ts.createSourceFile('/elsewhere/src/a.ts', 'export const value = 1;', ts.ScriptTarget.Latest, true);
  const suffixOnly = createEffectManifest(new Map([['src/a.ts', elsewhere]]), 'whole', resolve);
  assert.equal(reconcileEffectInventory(suffixOnly, [collectEffectPart(elsewhere, resolve)]).enumeration, 'incomplete');
  const normalized = ts.createSourceFile('src/a.ts', 'export const value = 1;', ts.ScriptTarget.Latest, true);
  assert.equal(reconcileEffectInventory(createEffectManifest(new Map([['./src/a.ts', normalized]]), 'whole', resolve),
    [collectEffectPart(normalized, resolve)]).enumeration, 'complete');

  const manifest = createEffectManifest(new Map([['actual.ts', actual]]), 'whole', resolve);
  const part = collectEffectPart(actual, resolve);
  for (const visited of [0, part.visited + 1, 100_001]) {
    const inventory = reconcileEffectInventory(manifest, [{ ...part, visited }]);
    assert.equal(inventory.enumeration, 'incomplete', String(visited));
    assert.equal(inventory.ambientSafety, 'unknown', String(visited));
  }
  const perFileOverflowManifest = { ...manifest, visited: new Map([[actual, 60_000]]) };
  const perFileOverflow = reconcileEffectInventory(perFileOverflowManifest, [{ ...part, visited: 60_000 }]);
  assert.equal(perFileOverflow.enumeration, 'incomplete');
  assert.ok(perFileOverflow.reasons.includes('build-cap'));

  const manySources = new Map(Array.from({ length: 11 }, (_, index) => {
    const file = ts.createSourceFile(`many-${index}.ts`, 'export const value = 1;', ts.ScriptTarget.Latest, true);
    return [`many-${index}.ts`, file] as const;
  }));
  const manyManifest = createEffectManifest(manySources, 'whole', resolve);
  const manyParts = [...manySources.values()].map((file) => collectEffectPart(file, resolve));
  const aggregateManifest = { ...manyManifest, visited: new Map([...manyManifest.visited].map(([file]) => [file, 50_000] as const)) };
  const aggregateParts = manyParts.map((candidate) => ({ ...candidate, visited: 50_000 }));
  const aggregateOverflow = reconcileEffectInventory(aggregateManifest, aggregateParts);
  assert.equal(aggregateOverflow.enumeration, 'incomplete');
  assert.ok(aggregateOverflow.reasons.includes('build-cap'));
});

test('reconcile는 parts와 nested effect 배열의 length를 한 번만 읽는다', () => {
  const source = ts.createSourceFile('a.ts', 'export const value = 1;', ts.ScriptTarget.Latest, true);
  const files = new Map([['a.ts', source]]);
  const resolve = () => undefined;
  const manifest = createEffectManifest(files, 'whole', resolve);
  const part = collectEffectPart(source, resolve);
  const poisonLength = <T extends object>(value: T): T => {
    let reads = 0;
    return new Proxy(value, {
      get(target, property, receiver) {
        if (property === 'length' && ++reads === 2) throw new Error('second length read');
        return Reflect.get(target, property, receiver);
      },
    });
  };
  const poisonedParts = new Proxy([part], {
    get(target, property, receiver) {
      if (property === 'length') {
        const current = Reflect.get(target, property, receiver);
        return current;
      }
      if (property === Symbol.iterator) throw new Error('iterator must not be required');
      return Reflect.get(target, property, receiver);
    },
  });
  for (const candidate of [
    { ...part, moduleEdges: poisonLength(part.moduleEdges) },
    { ...part, records: poisonLength(part.records) },
    { ...part, closure: { ...part.closure, references: poisonLength(part.closure.references) } },
    { ...part, closure: { ...part.closure, aliases: poisonLength(part.closure.aliases) } },
    { ...part, closure: { ...part.closure, tokens: poisonLength(part.closure.tokens) } },
  ]) {
    let inventory: ReturnType<typeof reconcileEffectInventory> | undefined;
    assert.doesNotThrow(() => { inventory = reconcileEffectInventory(manifest, [candidate]); });
    assert.equal(inventory?.enumeration, 'complete');
  }
  let partsInventory: ReturnType<typeof reconcileEffectInventory> | undefined;
  assert.doesNotThrow(() => { partsInventory = reconcileEffectInventory(manifest, poisonedParts); });
  assert.equal(partsInventory?.enumeration, 'complete');

  for (const field of ['source', 'moduleEdges', 'records', 'closure', 'emitPolicy'] as const) {
    const supplied = { ...part } as EffectPart;
    Object.defineProperty(supplied, field, { get() { throw new Error(`malformed ${field}`); } });
    let malformed: ReturnType<typeof reconcileEffectInventory> | undefined;
    assert.doesNotThrow(() => { malformed = reconcileEffectInventory(manifest, [supplied]); });
    assert.equal(malformed?.enumeration, 'incomplete', field);
  }
});

test('중첩 supplied closure·emit policy의 잘못된 접근도 인증을 만들지 않는다', () => {
  const { file, manifest, resolve } = fixture();
  const part = collectEffectPart(file, resolve);
  const throwing = <T extends object>(value: T): T => new Proxy(value, {
    get() { throw new Error('malformed nested field'); },
  });
  for (const field of ['closure', 'emitPolicy'] as const) {
    for (const value of [undefined, throwing(part[field])]) {
      const supplied = { ...part, [field]: value } as unknown as EffectPart;
      let inventory: ReturnType<typeof reconcileEffectInventory> | undefined;
      assert.doesNotThrow(() => { inventory = reconcileEffectInventory(manifest, [supplied]); });
      assert.equal(inventory?.enumeration, 'incomplete', field);
      assert.equal(inventory?.ambientSafety, 'unknown', field);
    }
  }
});

test('supplied record getter는 모르는 호출 효과를 primitive로 바꿔 인증하지 못한다', () => {
  const checked = checkedSources({ '/getter.ts': 'declare function observe(): void; export const value = observe();' },
    { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const file = checked.files.get('/getter.ts')!;
  const resolve = () => undefined;
  const policy = { preserveTypeOnlySpecifiers: false };
  const part = collectEffectPart(file, resolve, undefined, undefined, checked.checker, policy);
  const manifest = createEffectManifest(new Map([['/getter.ts', file]]), 'whole', resolve,
    true, undefined, checked.checker, policy);
  const records = part.records.map((record) => {
    let reads = 0;
    return { site: record.site, get operation() { return ++reads === 1 ? record.operation : 'primitive' as const; } };
  });
  const inventory = reconcileEffectInventory(manifest, [{ ...part, records }]);
  assert.equal(inventory.referenceAliases, 'complete');
  assert.equal(inventory.ambientSafety, 'unknown');
  assert.deepEqual(inventory.records.map((record) => record.operation), part.records.map((record) => record.operation));
});

test('supplied closure map의 revoked 값·필드 getter·invalid length는 mismatch로 닫힌다', () => {
  const checked = checkedSources({ '/maps.ts': 'const local = () => 1; const holder = { local }; export { local as alias };' },
    { noLib: true, types: [], module: ts.ModuleKind.ESNext });
  const file = checked.files.get('/maps.ts')!;
  const resolve = () => undefined;
  const manifest = createEffectManifest(new Map([['/maps.ts', file]]), 'whole', resolve, true, undefined, checked.checker);
  const index = buildFileIndex(checked.checker, file, resolve);
  for (const field of ['references', 'aliasNames', 'tokenOccurrences'] as const) {
    const supplied = { references: index.references, aliasNames: index.aliasNames, tokenOccurrences: index.tokenOccurrences };
    Object.defineProperty(supplied, field, { get() { throw new Error('malformed supplied map'); } });
    let inventory: ReturnType<typeof reconcileEffectInventory> | undefined;
    assert.doesNotThrow(() => { inventory = reconcileEffectInventory(manifest, index.effectParts, 'whole', supplied); });
    assert.equal(inventory?.referenceAliases, 'incomplete', field);
  }
  const key = partToken(index.tokenOccurrences);
  const revoked = Proxy.revocable([...index.tokenOccurrences.get(key)!], {});
  revoked.revoke();
  const invalidLength = new Proxy([...index.tokenOccurrences.get(key)!], {
    get(target, property, receiver) { return property === 'length' ? -1 : Reflect.get(target, property, receiver); },
  });
  for (const value of [revoked.proxy, invalidLength]) {
    const supplied = new Map(index.tokenOccurrences);
    supplied.set(key, value);
    let inventory: ReturnType<typeof reconcileEffectInventory> | undefined;
    assert.doesNotThrow(() => { inventory = reconcileEffectInventory(manifest, index.effectParts, 'whole', {
      references: index.references, aliasNames: index.aliasNames, tokenOccurrences: supplied,
    }); });
    assert.equal(inventory?.referenceAliases, 'incomplete');
    assert.equal(inventory?.reasons.includes('build-cap'), false);
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

  const skipped = {
    get() { throw new Error('incomplete enumeration must not inspect closure maps'); },
    [Symbol.iterator]() { throw new Error('incomplete enumeration must not normalize closure maps'); },
  } as unknown as ReadonlyMap<never, readonly never[]>;
  assert.doesNotThrow(() => reconcileEffectInventory(manifest, [], 'whole', {
    references: skipped, aliasNames: skipped, tokenOccurrences: skipped,
  }));

  const oversized = new Proxy(new Array<ts.Node>(EFFECT_BUILD_CAPS.records + 1), {
    get(target, property, receiver) {
      if (property === Symbol.iterator) throw new Error('oversized closure arrays must be rejected before iteration');
      return Reflect.get(target, property, receiver);
    },
  });
  const oversizedTokens = new Map(index.tokenOccurrences);
  const expectedToken = partToken(index.tokenOccurrences);
  oversizedTokens.set(expectedToken, oversized);
  const bounded = reconcileEffectInventory(manifest, index.effectParts, 'whole', {
    references: index.references, aliasNames: index.aliasNames, tokenOccurrences: oversizedTokens,
  });
  assert.equal(bounded.enumeration, 'incomplete');
  assert.equal(bounded.referenceAliases, 'incomplete');
  assert.ok(bounded.reasons.includes('build-cap'));

  const closure = manifest.closures.get(file)!;
  const witnessCost = closure.references.length + closure.aliases.length + closure.tokens.length;
  const actualMapCost = [...new Set(closure.references.map((witness) => witness.target))]
    .reduce((sum, target) => sum + index.references.get(target)!.length, 0)
    + [...new Set(closure.aliases.map((witness) => witness.target))]
      .reduce((sum, target) => sum + index.aliasNames.get(target)!.length, 0)
    + [...new Set(closure.tokens.map((witness) => witness.text))]
      .reduce((sum, text) => sum + index.tokenOccurrences.get(text)!.length, 0);
  const originalTokenSites = index.tokenOccurrences.get(expectedToken)!;
  const cumulativeLength = EFFECT_BUILD_CAPS.records - witnessCost - (actualMapCost - originalTokenSites.length);
  assert.ok(cumulativeLength < EFFECT_BUILD_CAPS.records && cumulativeLength >= originalTokenSites.length);
  const cumulativeSites = new Array<ts.Node>(cumulativeLength);
  originalTokenSites.forEach((site, position) => { cumulativeSites[position] = site; });
  const cumulativeTokens = new Map(index.tokenOccurrences);
  cumulativeTokens.set(expectedToken, cumulativeSites);
  const cumulative = reconcileEffectInventory(manifest, index.effectParts, 'whole', {
    references: index.references, aliasNames: index.aliasNames, tokenOccurrences: cumulativeTokens,
  });
  assert.equal(cumulative.enumeration, 'incomplete');
  assert.ok(cumulative.reasons.includes('build-cap'));

  const indexedOnly = [...index.tokenOccurrences.get(expectedToken)!];
  Object.defineProperty(indexedOnly, Symbol.iterator, {
    value() { throw new Error('bounded closure comparison must not consume supplied iterators'); },
  });
  let lengthReads = 0;
  const fixedLength = new Proxy(indexedOnly, {
    get(target, property, receiver) {
      if (property === 'length' && ++lengthReads > 1) throw new Error('supplied length must be snapshotted once');
      return Reflect.get(target, property, receiver);
    },
  });
  const poisonIteratorTokens = new Map(index.tokenOccurrences);
  poisonIteratorTokens.set(expectedToken, fixedLength);
  const iteratorSafe = reconcileEffectInventory(manifest, index.effectParts, 'whole', {
    references: index.references, aliasNames: index.aliasNames, tokenOccurrences: poisonIteratorTokens,
  });
  assert.equal(iteratorSafe.enumeration, 'complete');
  assert.equal(iteratorSafe.referenceAliases, 'complete');
  assert.equal(lengthReads, 1);
});

/** token map의 실제 expected key 하나다. */
function partToken(tokens: ReadonlyMap<string, readonly ts.Node[]>): string {
  const token = tokens.keys().next().value;
  assert.equal(typeof token, 'string');
  return token!;
}

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

test('checker intrinsic undefined와 runtime named alias는 닫히고 shadow·missing binding은 그대로 구분한다', () => {
  const { files, checker } = checkedSources({
    '/a.ts': 'import { value } from "./b"; export const exact = undefined; export const holder = { undefined }; export const result = value; export function shadow(undefined: string) { return { undefined }; }',
    '/b.ts': 'export const value = 1;',
  });
  const a = files.get('/a.ts')!;
  const b = files.get('/b.ts')!;
  const target = checker.getSymbolAtLocation(b);
  assert.ok(target);
  const resolve = (specifier: string) => specifier === './b' ? target : undefined;
  const manifest = createEffectManifest(files, 'whole', resolve, true, undefined, checker,
    { preserveTypeOnlySpecifiers: false });
  const indexes = [...files.values()].map((file) => buildFileIndex(checker, file, resolve, undefined,
    { preserveTypeOnlySpecifiers: false }));
  const inventory = mergeFlowIndexes(indexes, manifest).effectInventory!;
  const part = indexes[0]!.effectParts[0]!;
  assert.equal(part.closure.unresolved, false);
  assert.equal(inventory.referenceAliases, 'complete');
  assert.ok(part.records.some((record) => record.operation === 'read' && record.site.getText() === 'undefined'));

  const typeOnly = checkedSources({
    '/types.ts': 'import type { Shape } from "./shape"; export type { Shape } from "./shape"; export const value = 1;',
    '/shape.ts': 'export class Shape {}',
  }, { noLib: true, types: [] });
  const typesFile = typeOnly.files.get('/types.ts')!;
  const typeResolve = () => typeOnly.checker.getSymbolAtLocation(typeOnly.files.get('/shape.ts')!);
  const typeManifest = createEffectManifest(typeOnly.files, 'whole', typeResolve, true, undefined, typeOnly.checker,
    { preserveTypeOnlySpecifiers: false });
  const typeIndex = buildFileIndex(typeOnly.checker, typesFile, typeResolve, undefined, { preserveTypeOnlySpecifiers: false });
  const typeInventory = mergeFlowIndexes([{ ...typeIndex, aliasNames: new Map() },
    buildFileIndex(typeOnly.checker, typeOnly.files.get('/shape.ts')!, typeResolve, undefined,
      { preserveTypeOnlySpecifiers: false })], typeManifest).effectInventory!;
  assert.equal(typeInventory.referenceAliases, 'complete');
});

test('ambient module 선언은 runtime 구현이 아니며 실제 selected SourceFile만 initialization coverage를 닫는다', () => {
  const inventory = (entries: Readonly<Record<string, string>>, entry: string, specifier: string) => {
    const loaded = checkedSources(entries, { noLib: true, types: [] });
    const main = loaded.files.get(entry)!;
    const declaration = main.statements.find((statement): statement is ts.ImportDeclaration => ts.isImportDeclaration(statement));
    assert.ok(declaration && ts.isStringLiteralLike(declaration.moduleSpecifier));
    const target = loaded.checker.getSymbolAtLocation(declaration.moduleSpecifier);
    assert.ok(target);
    const resolve = (name: string) => name === specifier ? target : undefined;
    const manifest = createEffectManifest(loaded.files, 'whole', resolve, true, undefined, loaded.checker,
      { preserveTypeOnlySpecifiers: false });
    const parts = [...loaded.files.values()].map((file) => collectEffectPart(file, resolve, undefined, undefined,
      loaded.checker, { preserveTypeOnlySpecifiers: false }));
    return reconcileEffectInventory(manifest, parts);
  };

  const ambientTs = inventory({
    '/shim.ts': 'declare module "untyped-pkg" { export const value: number; }',
    '/main.ts': 'import { value } from "untyped-pkg"; export const result = value;',
  }, '/main.ts', 'untyped-pkg');
  assert.equal(ambientTs.initialization, 'incomplete');

  const ambientDeclaration = inventory({
    '/shim.d.ts': 'declare module "untyped-pkg" { export const value: number; }',
    '/main.ts': 'import { value } from "untyped-pkg"; export const result = value;',
  }, '/main.ts', 'untyped-pkg');
  assert.equal(ambientDeclaration.initialization, 'incomplete');

  const augmented = inventory({
    '/actual.ts': 'export const value = 1;',
    '/augment.ts': 'export {}; declare module "./actual" { export const extra: number; }',
    '/main.ts': 'import { value } from "./actual"; export const result = value;',
  }, '/main.ts', './actual');
  assert.equal(augmented.initialization, 'complete');
});

test('unresolved runtime loader는 initialization coverage를 닫지 않고 shadow require는 일반 호출이다', () => {
  const unresolved = checkedSources({ '/a.ts': 'export const a = require("untyped-pkg"); export const b = import("untyped-pkg");' },
    { noLib: true, types: [] });
  const file = unresolved.files.get('/a.ts')!;
  const resolve = () => undefined;
  const manifest = createEffectManifest(unresolved.files, 'whole', resolve, true, undefined, unresolved.checker,
    { preserveTypeOnlySpecifiers: false });
  const part = collectEffectPart(file, resolve, undefined, undefined, unresolved.checker,
    { preserveTypeOnlySpecifiers: false });
  assert.deepEqual(part.moduleEdges.map((edge) => edge.specifier), ['untyped-pkg', 'untyped-pkg']);
  assert.equal(reconcileEffectInventory(manifest, [part]).initialization, 'incomplete');

  const ambientRequire = checkedSources({
    '/ambient.ts': 'declare function require(id: string): unknown; export const result = require("untyped-pkg");',
  }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const ambientFile = ambientRequire.files.get('/ambient.ts')!;
  const ambientPart = collectEffectPart(ambientFile, resolve, undefined, undefined, ambientRequire.checker,
    { preserveTypeOnlySpecifiers: false });
  assert.deepEqual(ambientPart.moduleEdges.map((edge) => edge.specifier), ['untyped-pkg']);
  assert.equal(reconcileEffectInventory(createEffectManifest(ambientRequire.files, 'whole', resolve, true, undefined,
    ambientRequire.checker, { preserveTypeOnlySpecifiers: false }), [ambientPart]).initialization, 'incomplete');

  for (const text of [
    'declare const require: (id: string) => unknown; export default require;',
    'declare const require: (id: string) => unknown; export = require;',
    'declare const require: (id: string) => unknown; export { require };',
    'declare const require: (id: string) => unknown; export { require as load };',
    'declare const require: (id: string) => unknown; export { require as default };',
  ]) {
    const exportedLoader = checkedSources({ '/export.ts': text }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
    const exportFile = exportedLoader.files.get('/export.ts')!;
    const exportPart = collectEffectPart(exportFile, resolve, undefined, undefined, exportedLoader.checker,
      { preserveTypeOnlySpecifiers: false });
    assert.ok(exportPart.moduleEdges.some((edge) => edge.specifier === undefined && edge.target === undefined), text);
  }

  const aliasedLoader = checkedSources({
    '/alias.ts': 'declare const require: (id: string) => unknown; export const load = require; export const value = load("untyped-pkg"); export const comma = (0, require)("other-pkg"); export const bound = require.bind(null);',
  }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const aliasFile = aliasedLoader.files.get('/alias.ts')!;
  const aliasPart = collectEffectPart(aliasFile, resolve, undefined, undefined, aliasedLoader.checker,
    { preserveTypeOnlySpecifiers: false });
  assert.ok(aliasPart.moduleEdges.length >= 3);
  assert.ok(aliasPart.moduleEdges.every((edge) => edge.specifier === undefined && edge.target === undefined));
  assert.equal(reconcileEffectInventory(createEffectManifest(aliasedLoader.files, 'whole', resolve, true, undefined,
    aliasedLoader.checker, { preserveTypeOnlySpecifiers: false }), [aliasPart]).initialization, 'incomplete');

  const importedRequire = checkedSources({
    '/imported.ts': 'import { require } from "./helper"; export const result = require("untyped-pkg");',
    '/type-imported.ts': 'import type { require } from "./helper"; export const result = require("untyped-pkg");',
    '/helper.ts': 'export function require(id: string) { return id; }',
  }, { noLib: true, types: [] });
  const imported = collectEffectPart(importedRequire.files.get('/imported.ts')!,
    (specifier) => specifier === './helper' ? importedRequire.checker.getSymbolAtLocation(importedRequire.files.get('/helper.ts')!) : undefined,
    undefined, undefined, importedRequire.checker, { preserveTypeOnlySpecifiers: false });
  assert.deepEqual(imported.moduleEdges.map((edge) => edge.specifier), ['./helper']);
  const typeImported = collectEffectPart(importedRequire.files.get('/type-imported.ts')!, resolve,
    undefined, undefined, importedRequire.checker, { preserveTypeOnlySpecifiers: false });
  assert.deepEqual(typeImported.moduleEdges.map((edge) => edge.specifier), ['untyped-pkg']);

  const importedOpaque = checkedSources({
    '/loader.ts': 'declare const module: { require: (id: string) => unknown }; export const require = module.require.bind(module);',
    '/main.ts': 'import { require } from "./loader"; export const value = require("untyped-pkg");',
  }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const loaderFile = importedOpaque.files.get('/loader.ts')!;
  const mainFile = importedOpaque.files.get('/main.ts')!;
  const loaderTarget = importedOpaque.checker.getSymbolAtLocation(loaderFile);
  assert.ok(loaderTarget);
  const opaqueResolve = (specifier: string) => specifier === './loader' ? loaderTarget : undefined;
  const opaqueParts = [...importedOpaque.files.values()].map((source) => collectEffectPart(source, opaqueResolve,
    undefined, undefined, importedOpaque.checker, { preserveTypeOnlySpecifiers: false }));
  assert.ok(opaqueParts.find((candidate) => candidate.source === loaderFile)!.moduleEdges
    .some((edge) => edge.specifier === undefined));
  assert.deepEqual(opaqueParts.find((candidate) => candidate.source === mainFile)!.moduleEdges.map((edge) => edge.specifier),
    ['./loader', undefined]);
  assert.equal(reconcileEffectInventory(createEffectManifest(importedOpaque.files, 'whole', opaqueResolve, true, undefined,
    importedOpaque.checker, { preserveTypeOnlySpecifiers: false }), opaqueParts).initialization, 'incomplete');

  const mutable = checkedSources({
    '/mutable.ts': 'declare const module: { require: (id: string) => unknown }; function load() { let require = (id: string): unknown => id; require = module.require.bind(module); return require("untyped-pkg"); } export const value = load();',
    '/written-function.ts': 'declare const module: { require: (id: string) => unknown }; function require(id: string): unknown { return id; } require = module.require.bind(module); export const value = require("untyped-pkg");',
    '/array-written-function.ts': 'declare const module: { require: (id: string) => unknown }; function load() { function require(id: string): unknown { return id; } ([require] = [module.require.bind(module)]); return require("untyped-pkg"); } export const value = load();',
    '/const-written-function.ts': 'declare const module: { require: (id: string) => unknown }; function load() { const require = (id: string): unknown => id; (require as any) = module.require.bind(module); return require("untyped-pkg"); } export const value = load();',
  }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  for (const source of mutable.files.values()) {
    const mutablePart = collectEffectPart(source, resolve, undefined, undefined, mutable.checker,
      { preserveTypeOnlySpecifiers: false });
    assert.ok(mutablePart.moduleEdges.some((edge) => edge.specifier === undefined && edge.target === undefined), source.fileName);
  }
  const scripts = checkedSources({
    '/helper.ts': 'function require(id: string) { return id; }',
    '/consumer.ts': 'const value = require("untyped-pkg");',
  }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const scriptPart = collectEffectPart(scripts.files.get('/consumer.ts')!, resolve, undefined, undefined,
    scripts.checker, { preserveTypeOnlySpecifiers: false });
  assert.ok(scriptPart.moduleEdges.some((edge) => edge.target === undefined));

  const constructed = checkedSources({
    '/constructed.ts': 'declare const createRequire: (url: string) => (name: string) => unknown; const require = createRequire("x"); export function loadAll(names: string[]) { for (const name of names) require(name); }',
  }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const constructedFile = constructed.files.get('/constructed.ts')!;
  const constructedPart = collectEffectPart(constructedFile, resolve, undefined, undefined, constructed.checker,
    { preserveTypeOnlySpecifiers: false });
  assert.ok(constructedPart.moduleEdges.some((edge) => edge.specifier === undefined && edge.target === undefined));
  assert.equal(buildFileIndex(constructed.checker, constructedFile, resolve).hasOpaqueImport, true);

  const shadowed = checkedSources({
    '/shadow.ts': 'function require(value: string) { return value; } export const result = require("untyped-pkg");',
  }, { noLib: true, types: [] });
  const shadowFile = shadowed.files.get('/shadow.ts')!;
  const shadowPart = collectEffectPart(shadowFile, resolve, undefined, undefined, shadowed.checker,
    { preserveTypeOnlySpecifiers: false });
  assert.deepEqual(shadowPart.moduleEdges, []);
  assert.equal(reconcileEffectInventory(createEffectManifest(shadowed.files, 'whole', resolve, true, undefined,
    shadowed.checker, { preserveTypeOnlySpecifiers: false }), [shadowPart]).initialization, 'complete');

  for (const text of [
    'function require(value: string) { return value; } export default require;',
    'function require(value: string) { return value; } export = require;',
    'function require(value: string) { return value; } export { require as load };',
    'const require = (value: string) => value; export { require };',
    'declare const require: (id: string) => unknown; export type { require };',
    'const require = (value: string) => value; export const result = require("untyped-pkg");',
  ]) {
    const ordinary = checkedSources({ '/ordinary.ts': text }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
    const ordinaryFile = ordinary.files.get('/ordinary.ts')!;
    assert.deepEqual(collectEffectPart(ordinaryFile, resolve, undefined, undefined, ordinary.checker,
      { preserveTypeOnlySpecifiers: false }).moduleEdges, [], text);
  }
});

test('Node loader origin은 정적 alias까지 opaque closure로 남기고 일반 helper를 열지 않는다', () => {
  const platformChecked = checkedSources({
    '/platform.ts': `
      declare const module: { require: (id: string) => unknown };
      declare const createRequire: (url: string) => (id: string) => unknown;
      const localModuleLoader = module.require;
      const localFactoryLoader = createRequire('base');
      module.require('module-pkg');
      globalThis.require('global-pkg');
      localModuleLoader('alias-pkg');
      localFactoryLoader('factory-pkg');
      createRequire('inline-base')('inline-pkg');
    `,
  }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const ordinaryChecked = checkedSources({
    '/ordinary.ts': `
      const module = { require: (id: string) => id };
      function createRequire(url: string) { return (id: string) => id; }
      module.require('ordinary-module');
      createRequire('ordinary-factory')('ordinary-pkg');
    `,
  }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const resolve = () => undefined;
  const platform = collectEffectPart(platformChecked.files.get('/platform.ts')!, resolve, undefined, undefined,
    platformChecked.checker, { preserveTypeOnlySpecifiers: false });
  const ordinary = collectEffectPart(ordinaryChecked.files.get('/ordinary.ts')!, resolve, undefined, undefined,
    ordinaryChecked.checker, { preserveTypeOnlySpecifiers: false });
  const opaqueSites = new Set(platform.moduleEdges.filter((edge) => edge.specifier === undefined && edge.target === undefined)
    .map((edge) => edge.site.getText()));
  for (const site of ['module.require', "createRequire('base')", "module.require('module-pkg')",
    "globalThis.require('global-pkg')", "localModuleLoader('alias-pkg')", "localFactoryLoader('factory-pkg')",
    "createRequire('inline-base')", "createRequire('inline-base')('inline-pkg')"]) {
    assert.ok(opaqueSites.has(site), site);
  }
  assert.deepEqual(ordinary.moduleEdges, []);
  assert.equal(platform.closure.unresolved, true);

  const importedPlatform = checkedSources({
    '/node-module.d.ts': "declare module 'node:module' { export function createRequire(url: string): (id: string) => unknown; }",
    '/imported.ts': "import { createRequire as buildLoader } from 'node:module'; const localLoader = buildLoader('base'); localLoader('imported-pkg');",
  }, { noLib: true, types: [], module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
  const importedPart = collectEffectPart(importedPlatform.files.get('/imported.ts')!, resolve, undefined, undefined,
    importedPlatform.checker, { preserveTypeOnlySpecifiers: false });
  assert.ok(importedPart.moduleEdges.some((edge) => edge.specifier === undefined && edge.target === undefined));
  assert.equal(importedPart.closure.unresolved, true);

  const manifest = createEffectManifest(new Map([['/platform.ts', platformChecked.files.get('/platform.ts')!]]), 'whole', resolve,
    true, undefined, platformChecked.checker, { preserveTypeOnlySpecifiers: false });
  const inventory = reconcileEffectInventory(manifest, [platform]);
  assert.equal(inventory.initialization, 'incomplete');
  assert.equal(inventory.referenceAliases, 'incomplete');
});

test('platform root 노출·computed·reflection·eval은 각 site를 opaque coverage로 닫는다', () => {
  const fixtures = [
    ['computed const key', "declare const module: { require: (id: string) => unknown }; const key = 'require'; export const x = (module as any)[key]('plugin');"],
    ['computed unknown key', "declare const module: { require: (id: string) => unknown }; declare const key: string; export const x = (module as any)[key]('plugin');"],
    ['inline parameter root', "declare const module: { require: (id: string) => unknown }; export const x = ((m: any) => m.require('plugin'))(module);"],
    ['root alias escape', "declare const module: { require: (id: string) => unknown }; const m = module; export const x = use(m); function use(value: any) { return value; }"],
    ['globalThis root', "export const x = (globalThis as any).require('plugin');"],
    ['global root', "declare const global: any; export const x = global.require('plugin');"],
    ['process mainModule', "declare const process: any; export const x = process.mainModule.require('plugin');"],
    ['module parent', "declare const module: any; export const x = module.parent.require('plugin');"],
    ['module constructor', "declare const module: any; export const x = module.constructor.createRequire('x')('plugin');"],
    ['getBuiltinModule', "declare const process: any; export const x = process.getBuiltinModule('node:module').createRequire('x')('plugin');"],
    ['Reflect.get', "declare const module: any; export const x = Reflect.get(module, 'require')('plugin');"],
    ['direct eval', "eval('module.require(\"plugin\")');"],
  ] as const;
  for (const [label, text] of fixtures) {
    const checked = checkedSources({ '/platform.ts': text }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
    const file = checked.files.get('/platform.ts')!;
    const resolve = () => undefined;
    const part = collectEffectPart(file, resolve, undefined, undefined, checked.checker,
      { preserveTypeOnlySpecifiers: false });
    const manifest = createEffectManifest(new Map([['/platform.ts', file]]), 'whole', resolve,
      true, undefined, checked.checker, { preserveTypeOnlySpecifiers: false });
    const inventory = reconcileEffectInventory(manifest, [part]);
    assert.ok(part.moduleEdges.some((edge) => edge.specifier === undefined && edge.target === undefined), label);
    assert.equal(part.closure.unresolved, true, label);
    assert.equal(inventory.initialization, 'incomplete', label);
    assert.equal(inventory.referenceAliases, 'incomplete', label);
  }
});

test('platform root의 대입·반환·named export는 원래 노출 자리에 opaque 근거를 남긴다', () => {
  const fixtures = [
    "declare const module: any; let m: any; m = module; export const x = ((q: any) => q.require('pkg'))(m);",
    "declare const module: any; export function get() { return module; } export const x = get().require('pkg');",
    "declare const module: any; export { module };",
    "declare const module: any; export { module as root };",
    "declare const module: any; const m = module; export { m as root };",
    "declare const global: any; export { global as root };",
    "declare const module: any; export const x = (0, module).require('pkg');",
    "declare const module: any; class W { m = module; } export const x = new W().m.require('pkg');",
    "declare const module: any; class W { constructor(public m: any) {} } export const x = new W(module).m.require('pkg');",
    "declare const module: any; function f(m: any = module) { return m.require('pkg'); } f();",
    "declare function eval(code: string): any; (0, eval)(\"require('pkg')\");",
    "export const x = (globalThis as any).process.mainModule.require('pkg');",
    "export const x = (globalThis as any).eval(\"require('pkg')\");",
    "declare const module: any; export const x = module.children[0].require('pkg');",
    "declare const module: any; export const x = module.__proto__.constructor._load('pkg');",
  ];
  for (const text of fixtures) {
    const checked = checkedSources({ '/exposed.ts': text }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
    const file = checked.files.get('/exposed.ts')!;
    const resolve = () => undefined;
    const policy = { preserveTypeOnlySpecifiers: false };
    const part = collectEffectPart(file, resolve, undefined, undefined, checked.checker, policy);
    const manifest = createEffectManifest(new Map([['/exposed.ts', file]]), 'whole', resolve,
      true, undefined, checked.checker, policy);
    const inventory = reconcileEffectInventory(manifest, [part]);
    assert.ok(part.moduleEdges.some((edge) => edge.specifier === undefined && edge.target === undefined), text);
    assert.equal(inventory.initialization, 'incomplete', text);
    assert.equal(inventory.referenceAliases, 'incomplete', text);
    assert.equal(inventory.ambientSafety, 'unknown', text);
  }
});

test('computed platform key의 const 표기는 runtime key 불변성 근거가 아니다', () => {
  const checked = checkedSources({ '/key.ts': "declare const module: any; const key = 'other'; (key as any) = 'require'; export const x = module[key]('pkg');" },
    { noLib: true, types: [], module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES5 });
  const file = checked.files.get('/key.ts')!;
  const policy = { preserveTypeOnlySpecifiers: false };
  const part = collectEffectPart(file, () => undefined, undefined, undefined, checked.checker, policy);
  const manifest = createEffectManifest(new Map([['/key.ts', file]]), 'whole', () => undefined,
    true, undefined, checked.checker, policy);
  assert.ok(part.moduleEdges.some((edge) => edge.specifier === undefined));
  assert.equal(reconcileEffectInventory(manifest, [part]).initialization, 'incomplete');
});

test('다른 script의 platform 동명 helper는 사용 파일의 runtime root를 증명하지 못한다', () => {
  for (const name of ['module', 'process']) {
    const checked = checkedSources({
      '/helper.ts': `const ${name} = { require: (id: string) => id };`,
      '/consumer.ts': `${name}.require('pkg');`,
    }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
    const file = checked.files.get('/consumer.ts')!;
    const policy = { preserveTypeOnlySpecifiers: false };
    const part = collectEffectPart(file, () => undefined, undefined, undefined, checked.checker, policy);
    assert.ok(part.moduleEdges.some((edge) => edge.specifier === undefined), name);
    assert.equal(part.closure.unresolved, true, name);
  }
});

test('await builtin module의 loader factory도 opaque alias 근거를 남긴다', () => {
  const checked = checkedSources({
    '/node-module.d.ts': "declare module 'node:module' { export function createRequire(url: string): (id: string) => unknown; }",
    '/awaited.ts': "const { createRequire } = await import('node:module'); export const value = createRequire('entry')('pkg');",
  }, { noLib: true, types: [], module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
  const file = checked.files.get('/awaited.ts')!;
  const part = collectEffectPart(file, () => undefined, undefined, undefined, checked.checker,
    { preserveTypeOnlySpecifiers: false });
  assert.ok(part.moduleEdges.some((edge) => edge.specifier === undefined));
  assert.equal(part.closure.unresolved, true);
});

test('실제 기본 lib·Node 선언을 읽은 platform loader도 opaque로 남는다', () => {
  for (const text of [
    "export const value = globalThis.eval(\"require('pkg')\");",
    "import { createRequire } from 'node:module'; export const value = createRequire('entry')('pkg');",
    "export const value = Function('return this')().process.mainModule.require('pkg');",
    "export const value = new Function('return process')().mainModule.require('pkg');",
    "export const value = globalThis.Function('return process')().mainModule.require('pkg');",
    "export const value = Function.bind(null, 'return process')()().mainModule.require('pkg');",
    "export const value = Function.prototype.constructor('return process')().mainModule.require('pkg');",
    "export const value = Function.call(null, 'return process')().mainModule.require('pkg');",
    "export const value = eval.bind(null, \"process.mainModule.require('pkg')\")();",
  ]) {
    const checked = checkedSources({ '/lib-root.ts': text }, { types: ['node'], module: ts.ModuleKind.CommonJS });
    const file = checked.files.get('/lib-root.ts')!;
    const part = collectEffectPart(file, () => undefined, undefined, undefined, checked.checker,
      { preserveTypeOnlySpecifiers: false });
    assert.ok(part.moduleEdges.some((edge) => edge.specifier === undefined), text);
    assert.equal(part.closure.unresolved, true, text);
  }
});

test('일반 constructor 반사·팩터리는 unknown 효과로 남아 ambient 안전성을 인증하지 않는다', () => {
  for (const text of [
    "export const value = [].constructor.constructor('return process')().mainModule.require('pkg');",
    "export const value = ({}).constructor.constructor('return process')().mainModule.require('pkg');",
    "export const value = (() => {}).constructor('return process')().mainModule.require('pkg');",
  ]) {
    const checked = checkedSources({ '/reflection.ts': text }, { types: ['node'], module: ts.ModuleKind.CommonJS });
    const file = checked.files.get('/reflection.ts')!;
    const policy = { preserveTypeOnlySpecifiers: false };
    const part = collectEffectPart(file, () => undefined, undefined, undefined, checked.checker, policy);
    const manifest = createEffectManifest(new Map([['/reflection.ts', file]]), 'whole', () => undefined,
      true, undefined, checked.checker, policy);
    const inventory = reconcileEffectInventory(manifest, [part]);
    assert.ok(inventory.records.some((record) => record.operation === 'call'));
    assert.ok(inventory.records.some((record) => record.operation === 'read'));
    assert.equal(inventory.ambientSafety, 'unknown');
  }
});

test('platform 이름의 실제 local helper는 loader로 승격하지 않는다', () => {
  const fixtures = [
    "const global = { require: (id: string) => id }; global.require('plugin');",
    "const globalThis = { require: (id: string) => id }; globalThis.require('plugin');",
    "const process = { mainModule: { require: (id: string) => id } }; process.mainModule.require('plugin');",
    "const module = { parent: { require: (id: string) => id }, require: (id: string) => id }; module.parent.require('plugin');",
    "const Reflect = { get: (object: any, key: string) => object[key] }; const module = { require: (id: string) => id }; Reflect.get(module, 'require')('plugin');",
    "function eval(value: string) { return value; } eval('module.require(\"plugin\")');",
    "const module = { require: (id: string) => id }; let m: typeof module; m = module; export { module };",
    "const module = { require: (id: string) => id }; function get() { return module; } get().require('pkg');",
    "const module = { children: [{ require: (id: string) => id }] }; module.children[0].require('pkg');",
    "function Function(value: string) { return value; } Function('ordinary');",
  ] as const;
  for (const text of fixtures) {
    const checked = checkedSources({ '/ordinary.ts': text }, { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
    const file = checked.files.get('/ordinary.ts')!;
    const resolve = () => undefined;
    const part = collectEffectPart(file, resolve, undefined, undefined, checked.checker,
      { preserveTypeOnlySpecifiers: false });
    const manifest = createEffectManifest(new Map([['/ordinary.ts', file]]), 'whole', resolve,
      true, undefined, checked.checker, { preserveTypeOnlySpecifiers: false });
    const inventory = reconcileEffectInventory(manifest, [part]);
    assert.deepEqual(part.moduleEdges, [], text);
    assert.equal(inventory.initialization, 'complete', text);
  }
});

test('globalThis root census는 큰 parameter 목록에서도 function boundary별로 한 번만 청구한다', () => {
  const parameterCount = 4_000;
  const parameters = Array.from({ length: parameterCount }, (_, index) => `p${index}: any`).join(', ');
  const checked = checkedSources({ '/large.ts': `export function f(${parameters}) { globalThis.require('plugin'); }` },
    { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const budget: EffectBuildBudget = { visited: 0, records: 0 };
  const part = collectEffectPart(checked.files.get('/large.ts')!, () => undefined, undefined, budget,
    checked.checker, { preserveTypeOnlySpecifiers: false });
  assert.equal(part.status, 'complete');
  assert.equal(part.moduleEdges.length, 1);
  assert.ok(budget.visited < 25_000);
});

test('require classifier는 overload declaration work를 한 번만 청구하고 두 번째 분류를 cache한다', () => {
  const overloads = Array.from({ length: 250 }, (_, index) => `function require(id: '${index}'): unknown;`).join('\n');
  const calls = Array.from({ length: 250 }, (_, index) => `const value${index} = require('${index}');`).join('\n');
  const checked = checkedSources({ '/overloads.ts': `${overloads}\nfunction require(id: string): unknown { return id; }\n${calls}` },
    { noLib: true, types: [], module: ts.ModuleKind.CommonJS });
  const source = checked.files.get('/overloads.ts')!;
  const budget: EffectBuildBudget = { visited: 0, records: 0, perFileVisited: new Map<ts.SourceFile, number>() };
  const first = collectEffectPart(source, () => undefined, undefined, budget, checked.checker,
    { preserveTypeOnlySpecifiers: false });
  const afterFirst = budget.visited;
  const second = collectEffectPart(source, () => undefined, undefined, budget, checked.checker,
    { preserveTypeOnlySpecifiers: false });
  assert.equal(first.status, 'complete');
  assert.equal(second.status, 'complete');
  assert.deepEqual(first.moduleEdges, []);
  assert.deepEqual(second.moduleEdges, []);
  assert.equal(budget.requireDeclarationScans?.size, 1);
  assert.equal(budget.visited - afterFirst, second.visited);
});
