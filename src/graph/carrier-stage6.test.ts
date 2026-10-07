/** Stage6의 공개 합성 입력을 실제 graph 소비자에서 검증한다. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import ts from 'typescript';
import { ConstructorCarrierAnalyzer, type ConstructorCarrierContext } from './constructor-carrier.ts';
import { createEffectManifest } from './effect-inventory.ts';
import { buildFileIndex, mergeFlowIndexes } from './flow-index.ts';
import { primitiveErasedReference } from './primitive-helpers.ts';
import type { ProofWork } from './proof-dag.ts';

/** fixture 이외의 파일을 읽거나 실행하지 않고 실제 CLI 분석 경계를 사용한다. */
/** helper/dependency/carrier 문법과 실제 entry를 독립적으로 바꾸는 공개 fixture다. */
function sourceOf(body: string, options: { dependency?: string; carrier?: string; before?: string; calls?: string; after?: string; helper?: string; runParameters?: string } = {}): string {
  return `${options.before ?? ''}
function identity(value: string) { return value; }
${options.helper ?? `function helper(value: string) { ${body} }`}
class Port { send(value: string) { ${options.dependency ?? 'return helper(value);'} } }
class Controller {
  tick: () => Date;
  constructor(private readonly inputs: { port: Port; tick?: () => Date }) {
    this.tick = inputs.tick ?? (() => new Date());
  }
  run(${options.runParameters ?? "value: string"}) { ${options.carrier ?? 'this.tick(); return this.inputs.port.send(helper(value));'} }
}
const live = new Port();
const controller = new Controller({ port: live, tick: undefined });
${options.calls ?? 'controller.run("one"); controller.run("two");'}
${options.after ?? ''}
export {};`;
}

/** 실제 graph 분석은 입력을 실행하지 않으며 fixture만 정리한다. */
async function graphOf(body: string, options: Parameters<typeof sourceOf>[1] = {}, extra: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-stage6-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      strict: true, types: [], lib: ['es2022'], target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
    } }));
    writeFileSync(join(root, 'src/main.ts'), sourceOf(body, options));
    for (const [path, text] of Object.entries(extra)) writeFileSync(join(root, 'src', path), text);
    return await buildCallGraph(root, createNodeFileSystem());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** target identity와 evidence를 동시에 검사한다. */
function endpointEvidence(graph: Awaited<ReturnType<typeof graphOf>>) {
  return graph.edges.filter(edge => edge.from === 'src/main.ts#Controller.run' && edge.to === 'src/main.ts#Port.send').map(edge => edge.evidence);
}

for (const [name, body] of [
  ['object', 'const slots = { value }; const first = slots; const second = first; second.value = identity(value); return second.value;'],
  ['array', 'const slots = [value]; const first = slots; const second = first; second[0] = identity(value); return second[0];'],
] as const) {
  test(`stage6 ${name} confinement reaches actual bound dependency`, async () => {
    const graph = await graphOf(body);
    assert.deepEqual(graph.edges.filter(edge => edge.from === 'src/main.ts#Controller.run'
      && edge.to === 'src/main.ts#Port.send').map(edge => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
    assert.ok(graph.edges.some(edge => edge.from === 'src/main.ts#Port.send' && edge.to === 'src/main.ts#helper' && edge.evidence === 'direct'));
  });
}

/** direct expression과 own-name 충돌은 같은 primitive own-data witness로 인증한다. */
test('stage6 direct literals canonical reads and explicit own names reach bound endpoint', async t => {
  for (const [name, body] of Object.entries({
    readStatement: 'const slots = [value]; slots[0]; return slots[0];',
    directAssignment: '([value])[0] = value; return value;',
    arrayAliasesRead: 'const slots = [value]; const first = slots; const second = first; return second[0];',
    erasedReadonly: 'const slots = [value] as const; return slots[0];',
    arrayRead: 'const slots = [value]; return slots[0];',
    objectRead: 'const slots = { value: identity(value) }; return slots.value;',
    directArray: 'return [value][0];',
    directObject: 'return ({ value }).value;',
    ownConstructor: 'const slots = { constructor: value }; slots.constructor = identity(value); return slots.constructor;',
    ownToString: 'const slots = { toString: value }; return slots.toString;',
    staticString: 'const slots = { "value": value }; slots["value"] = value; return slots["value"];',
    readWriteLocal: 'const slots = [value]; const previous = slots[0]; slots[0] = identity(previous); return slots[0];',
    selfSlot: 'const slots = { value }; slots.value = slots.value; return slots.value;',
    primitiveLocals: 'const local = identity(value); const slots = [local]; slots[0] = local; return slots[0];',
  })) await t.test(name, async () => assert.deepEqual(endpointEvidence(await graphOf(body)), ['bound']));
});

/** dependency와 carrier 양쪽 body도 같은 모델을 소비한다. */
test('stage6 literal grammar composes in helper dependency and carrier bodies', async () => {
  const graph = await graphOf('const slots = [value]; return slots[0];', {
    dependency: 'const slots = { value: helper(value) }; const alias = slots; alias.value = identity(value); return helper(alias.value);',
    carrier: 'const slots = [helper(value)]; const alias = slots; alias[0] = identity(value); this.tick(); return this.inputs.port.send(alias[0]);',
  });
  assert.deepEqual(endpointEvidence(graph), ['bound'], JSON.stringify(graph.limitations));
});

/** 뒤늦은 unsafe reference도 첫 호출의 confinement 권한을 막는다. */
test('stage6 nearest distinct unsafe literal effects retain candidate and proof gaps', async t => {
  for (const [name, body] of Object.entries({
    lateAliasEscape: 'const slots = [value]; const alias = slots; const result = alias[0]; identity(alias); return result;',
    siblingEscape: 'const slots = { value }; const first = slots; const second = slots; identity(second); return first.value;',
    storedContainer: 'const slots = [value]; const wrapper = { slots }; return slots[0];',
    protectedValue: 'const slots = [live]; return slots[0];',
    returnedContainer: 'const slots = [value]; return slots;',
    mutableAlias: 'const slots = [value]; let alias = slots; return alias[0];',
    forwardAlias: 'const alias = slots; const slots = [value]; return alias[0];',
    effectfulInit: 'const slots = [Date.now()]; return slots[0];',
    coercion: 'const slots = [value + ""]; return slots[0];',
    holes: 'const slots = [, value]; return slots[1];',
    spread: 'const slots = [...[value]]; return slots[0];',
    length: 'const slots = [value]; slots.length = 0; return slots[0];',
    push: 'const slots = [value]; slots.push(value); return slots[0];',
    newIndex: 'const slots = [value]; slots[1] = value; return slots[0];',
    noncanonicalIndex: 'const slots = [value]; slots["00"] = value; return slots[0];',
    deleteSlot: 'const slots = [value]; delete slots[0]; return slots[0];',
    updateSlot: 'const slots = [0]; slots[0]++; return slots[0];',
    dynamicKey: 'const slots = { value }; const key = "value"; return slots[key];',
    duplicateKey: 'const slots = { value, value: "unsafe" }; return slots.value;',
    accessor: 'const slots = { get value() { return value; } }; return slots.value;',
    method: 'const slots = { value() { return value; } }; return slots.value();',
    prototypeCreation: 'const slots = { __proto__: null, value }; return slots.value;',
    inheritedRead: 'const slots = { value }; return slots.constructor;',
    reflection: 'const slots = [value]; Reflect.set(slots, "0", value); return slots[0];',
    opaque: 'const slots = [value]; unknown(slots); return slots[0];',
    nonprimitiveWrite: 'const slots = [value]; slots[0] = {}; return slots[0];',
    conditionalWrite: 'const slots = [value]; if (value) slots[0] = value; return slots[0];',
    factory: 'function factory() { return [value]; } const slots = factory(); return slots[0];',
    reflectionRead: 'const slots = [value]; Reflect.ownKeys(slots); return slots[0];',
    callback: 'const slots = [value]; const later = () => slots[0]; return later();',
  })) await t.test(name, async () => {
    const graph = await graphOf(body);
    assert.deepEqual(endpointEvidence(graph), ['candidate'], name);
    assert.ok(graph.limitations.some(gap => gap.includes('carrier-proof: rejected')), name);
  });
});

/** container capture의 초기화와 모든 actual entry를 함께 검증한다. */
test('stage6 captured literal and every entry preserve initialization and primitive arguments', async t => {
  const body = 'const local = shared[0]; const slots = { value: local }; slots.value = identity(value); return slots.value;';
  const before = 'const captured = "safe"; const shared = [captured]; const alias = shared;';
  const safe = await graphOf(body, { before, calls: 'export const read = () => controller.run("safe"); read();' });
  assert.deepEqual(endpointEvidence(safe), ['bound'], JSON.stringify(safe.limitations));
  for (const [name, options] of Object.entries({
    missingSecond: { before, calls: 'controller.run("one"); controller.run();' },
    unsafeSecond: { before, calls: 'controller.run("one"); controller.run(live);' },
    earlyCapture: { before: '', calls: 'controller.run("one"); const captured = "safe"; const shared = [captured]; const alias = shared;' },
    lateEscape: { before, after: 'identity(alias);' },
    siblingWrite: { before, after: 'alias[0] = live;' },
    intrinsicChange: { before, after: 'Array.prototype[0] = live;' },
    borrowedChange: { before, after: 'live.send = () => "unsafe";' },
  })) await t.test(name, async () => assert.deepEqual(endpointEvidence(await graphOf(body, options)), ['candidate']));
});

/** import entry와 inline wrapper도 Stage5의 실제 entry grammar를 그대로 사용한다. */
test('stage6 imported helper and wrapper entries consume completed literal proofs', async () => {
  const body = 'const slots = [value]; const alias = slots; alias[0] = identity(value); return alias[0];';
  const imported = await graphOf(body, { helper: 'import { helper } from "./helper";' }, {
    'helper.ts': `function identity(value: string) { return value; } export function helper(value: string) { ${body} }`,
  });
  assert.deepEqual(endpointEvidence(imported), ['bound'], JSON.stringify(imported.limitations));
  const wrapped = await graphOf(body, {
    runParameters: "", carrier: 'this.tick(); return this.inputs.port.send(helper("safe"));',
    calls: 'function wrap(value: Controller, callback: (value: Controller) => string) { return callback(value); } wrap(controller, value => value.run());',
  });
  assert.deepEqual(endpointEvidence(wrapped), ['bound'], JSON.stringify(wrapped.limitations));
});

/** 값 보존 wrapper는 original assignment site와 receiver identity를 바꾸지 않는다. */
test('stage6 wrapped object and array assignments reach actual bound consumers', async t => {
  const positives = {
    arrayParentheses: 'const slots = [value]; (slots[0] = identity(value)); return slots[0];',
    arrayAssertion: 'const slots = [value]; ((slots[0] = identity(value)) as string); return slots[0];',
    arraySatisfies: 'const slots = [value]; ((slots[0] = identity(value)) satisfies string); return slots[0];',
    objectNonNull: 'const slots = { value }; ((slots.value = identity(value))!); return slots.value;',
    objectTypeAssertion: 'const slots = { value }; (<string>(slots.value = identity(value))); return slots.value;',
    objectOwnPrototype: 'const slots = { prototype: value }; (slots.prototype = identity(value)); return slots.prototype;',
  };
  for (const [name, body] of Object.entries(positives)) await t.test(name, async () => {
    assert.deepEqual(endpointEvidence(await graphOf(body)), ['bound'], name);
  });
  const negatives = {
    protectedValue: 'const slots = [value]; (slots[0] = live as unknown as string); return slots[0];',
    newSlot: 'const slots = [value]; (slots[1] = identity(value)); return slots[0];',
    resultEscape: 'const slots = [value]; const result = (slots[0] = identity(value)); return slots[0];',
    comma: 'const slots = [value]; ((slots[0] = identity(value)), value); return slots[0];',
    dynamicKey: 'const slots = { value }; const key = "value"; (slots[key] = identity(value)); return slots.value;',
    coercion: 'const slots = [value]; (slots[0] = value + ""); return slots[0];',
    effectful: 'const slots = [value]; (slots[0] = Date.now() as unknown as string); return slots[0];',
    unknown: 'const slots = [value]; (slots[0] = unknownValue); return slots[0];',
    escape: 'const slots = [value]; (slots[0] = identity(value)); identity(slots); return slots[0];',
    length: 'const slots = [value]; (slots.length = 0); return slots[0];',
  };
  for (const [name, body] of Object.entries(negatives)) await t.test(name, async () => {
    assert.deepEqual(endpointEvidence(await graphOf(body)), ['candidate'], name);
  });
});

/** 독립 manifest를 가진 실제 Program으로 proof와 accounting을 검증한다. */
function indexed(source: string) {
  const options: ts.CompilerOptions = { strict: true, types: [], lib: ['lib.es2022.d.ts'],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
  const host = ts.createCompilerHost(options), read = host.getSourceFile;
  host.getSourceFile = (name, version, onError, fresh) => name === 'main.ts'
    ? ts.createSourceFile(name, source, version, true) : read.call(host, name, version, onError, fresh);
  const program = ts.createProgram({ rootNames: ['main.ts'], options, host });
  const file = program.getSourceFile('main.ts')!, checker = program.getTypeChecker();
  const manifest = createEffectManifest(new Map([[file.fileName, file]]), 'whole', () => undefined, true, undefined, checker);
  const index = { ...mergeFlowIndexes([buildFileIndex(checker, file, () => undefined)], manifest),
    proofProgram: program, proofDiagnostics: new Set<string>() };
  const declaration = file.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'Controller')!;
  let slots: ts.VariableDeclaration | undefined;
  let literal: ts.ObjectLiteralExpression | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Controller') literal = node.arguments![0] as ts.ObjectLiteralExpression;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'slots') slots = node;
    ts.forEachChild(node, find);
  };
  find(file); assert.ok(literal && slots);
  const context = { program, checker, index, policy: {
    isProjectFile: source => source === file, isOpenCallable: () => false, isOverridden: () => false,
    openProperties: false, isDefaultLibraryFile: source => program.isSourceFileDefaultLibrary(source),
  } } satisfies ConstructorCarrierContext;
  return { context, declaration, literal, file, slots };
}

const confinedBody = 'const slots = [value]; const first = slots; const second = first; const previous = second[0]; second[0] = identity(previous); return second[0];';

/** literal closure와 copy work도 실제 proof의 cold/warm charged prefix를 유지한다. */
test('stage6 new proof cold warm event prefixes negative replay and reversed consumers match', () => {
  const wrappedBody = 'const slots = [value]; ((slots[0] = identity(value)) as string); return slots[0];';
  for (const [body, expected] of [
    [confinedBody, true], [wrappedBody, true],
    [confinedBody.replace('return second[0];', 'identity(first); return second[0];'), false],
  ] as const) {
    const { context, declaration, literal } = indexed(sourceOf(body));
    const sentinel = new Error('synthetic confinement interruption');
    const create = () => {
      let limit = Infinity, steps = 0, events: string[] = [];
      const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
        step: () => { events.push('step'); if (++steps > limit) throw sentinel; },
        check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
      } });
      return (budget = Infinity, bag = false) => {
        limit = budget; steps = 0; events = []; analyzer.beginQuery();
        try { return { value: bag ? analyzer.isolatesExtendedBag(declaration, literal)
          : analyzer.allowsExtendedInstanceIsolation(declaration), steps, events: [...events], aborted: false }; }
        catch (error) { assert.equal(error, sentinel); return { value: false, steps, events: [...events], aborted: true }; }
        finally { analyzer.endQuery(); }
      };
    };
    const warm = create(), reversed = create();
    const complete = warm(), bag = reversed(Infinity, true);
    assert.equal(complete.value, expected); assert.equal(bag.value, complete.value);
    assert.deepEqual(warm(), complete); assert.deepEqual(reversed(), complete);
    assert.deepEqual(warm(Infinity, true), bag); assert.deepEqual(reversed(Infinity, true), bag);
    const limits = new Set([0, 1, 2, complete.steps - 1, complete.steps, complete.steps + 1]);
    for (let i = 1; i < 24; i++) limits.add(Math.floor(complete.steps * i / 24));
    for (const limit of limits) {
      assert.deepEqual(warm(limit), create()(limit), `confinement budget ${limit}`);
      assert.deepEqual(warm(), complete);
    }
  }
});

/** 현재 entry/context와 예상 밖 RangeError를 cached success로 덮지 않는다. */
test('stage6 current entry foreign context and RangeError recovery preserve authority', () => {
  const { context, declaration } = indexed(sourceOf(confinedBody));
  let open = false, fail = false;
  const sentinel = new RangeError('synthetic confinement checker failure');
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, policy: { ...context.policy,
    isOpenCallable: node => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'helper') {
        if (fail) throw sentinel;
        return open;
      }
      return false;
    },
  } });
  const run = (current = analyzer) => {
    current.beginQuery();
    try { return current.allowsExtendedInstanceIsolation(declaration); }
    finally { current.endQuery(); }
  };
  assert.equal(run(), true); open = true; assert.equal(run(), false);
  open = false; fail = true; assert.throws(run, error => error === sentinel);
  fail = false; assert.equal(run(), true);
  const foreign = indexed(sourceOf(confinedBody));
  assert.equal(run(new ConstructorCarrierAnalyzer({ ...context, checker: foreign.context.checker })), false);
  assert.equal(run(new ConstructorCarrierAnalyzer({ ...context, index: { ...context.index, mutationComplete: false } })), false);
  assert.equal(run(), true);
});

/** 새 closure의 cycle/exhaustion이 pending/negative를 남기지 않게 검증한다. */
test('stage6 cycle incomplete inventory exhaustion and depth retain exactly once diagnostics', async () => {
  const cyclic = indexed(sourceOf('const slots = [identity(value)]; return slots[0];', {
    helper: 'function helper(value: string) { const slots = [helper(value)]; return slots[0]; }',
  }));
  const cyclicAnalyzer = new ConstructorCarrierAnalyzer(cyclic.context);
  for (let i = 0; i < 2; i++) {
    cyclicAnalyzer.beginQuery();
    try { assert.equal(cyclicAnalyzer.allowsExtendedInstanceIsolation(cyclic.declaration), false); }
    finally { cyclicAnalyzer.endQuery(); }
  }
  assert.deepEqual([...cyclic.context.index.proofDiagnostics], ['carrier-proof: cycle; carrier proof was not completed.']);
  const aliases = Array.from({ length: 270 }, (_, index) => `const alias${index} = ${index === 0 ? 'slots' : `alias${index - 1}`};`).join(' ');
  const deepBody = `const slots = [value]; ${aliases} return alias269[0];`;
  const deep = indexed(sourceOf(deepBody)), analyzer = new ConstructorCarrierAnalyzer(deep.context);
  for (let i = 0; i < 2; i++) {
    analyzer.beginQuery();
    try { assert.equal(analyzer.allowsExtendedInstanceIsolation(deep.declaration), false); }
    finally { analyzer.endQuery(); }
  }
  assert.deepEqual([...deep.context.index.proofDiagnostics], ['carrier-proof: exhausted; carrier proof was not completed.']);
  const graph = await graphOf(deepBody);
  assert.deepEqual(endpointEvidence(graph), ['candidate']);
  assert.equal(graph.limitations.filter(gap => gap.startsWith('dispatch-budget:')).length, 1);
  const oversized = indexed(sourceOf(confinedBody, {
    calls: Array.from({ length: 2_000 }, () => 'controller.run("safe");').join('\n'),
  }));
  const large = new ConstructorCarrierAnalyzer(oversized.context);
  large.beginQuery();
  try { assert.equal(large.allowsExtendedInstanceIsolation(oversized.declaration), false); }
  finally { large.endQuery(); }
  assert.deepEqual([...oversized.context.index.proofDiagnostics], ['carrier-proof: exhausted; carrier proof was not completed.']);
  const fresh = indexed(sourceOf(confinedBody)), recovery = new ConstructorCarrierAnalyzer(fresh.context);
  recovery.beginQuery();
  try { assert.equal(recovery.allowsExtendedInstanceIsolation(fresh.declaration), true); }
  finally { recovery.endQuery(); }
});

/** producer-private snapshot은 세 mutation 경계를 통과하지만 global legacy memo를 만들지 않는다. */
test('stage6 producer-private confinement validates all mutation boundaries', async () => {
  const { isMutationCleanView } = await import('./mutation-safety.ts');
  const indexedSource = indexed(sourceOf(confinedBody));
  const { context, declaration } = indexedSource;
  const safety = { checker: context.checker, index: context.index,
    isDefaultLibraryFile: context.policy.isDefaultLibraryFile!, openProgram: false, openProperties: false };
  assert.equal(isMutationCleanView(safety), false, 'legacy guards cannot grant Stage6 alias authority');
  const privateNames = ['dag', 'query', 'singletonRecipe', 'singletonRecipes', 'helperInventory', 'helpers',
    'helperSnapshots', 'descriptorSnapshots', 'primitiveSnapshots'];
  const beforeAnalyzer = new ConstructorCarrierAnalyzer(context);
  for (const name of privateNames) Reflect.set(beforeAnalyzer, name, { forged: true });
  beforeAnalyzer.beginQuery();
  try { assert.equal(beforeAnalyzer.allowsExtendedInstanceIsolation(declaration), true,
    'lookalike fields installed before production cannot replace private snapshot state'); }
  finally { beforeAnalyzer.endQuery(); }
  const analyzer = new ConstructorCarrierAnalyzer(context);
  const run = () => {
    analyzer.beginQuery();
    try { return analyzer.allowsExtendedInstanceIsolation(declaration); }
    finally { analyzer.endQuery(); }
  };
  assert.equal(run(), true, 'genuine producer snapshot must validate dirty receiver, array closure and final record');
  assert.equal(isMutationCleanView(safety), false, 'completed authority must not enter global mutation memo');
  for (const name of privateNames) {
    assert.equal(Reflect.get(analyzer, name), undefined, `${name} must remain producer-private`);
    Reflect.set(analyzer, name, { forged: true });
  }
  assert.equal(run(), true, 'public lookalike fields cannot replace producer-private state');

  const mutation = context.index.mutations.find(record => record.effect === 'property' && record.operation === 'assignment');
  assert.ok(mutation);
  const changed = { ...mutation, key: mutation.value };
  const changedIndex = { ...context.index,
    mutations: context.index.mutations.map(record => record === mutation ? changed : record) };
  const changedAnalyzer = new ConstructorCarrierAnalyzer({ ...context, index: changedIndex });
  changedAnalyzer.beginQuery();
  try { assert.equal(changedAnalyzer.allowsExtendedInstanceIsolation(declaration), false, 'final record mismatch must reject'); }
  finally { changedAnalyzer.endQuery(); }

  let arrayBinding: ts.VariableDeclaration | undefined;
  const findBinding = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'slots') arrayBinding ??= node;
    ts.forEachChild(node, findBinding);
  };
  findBinding(indexedSource.file); assert.ok(arrayBinding);
  const symbol = context.checker.getSymbolAtLocation(arrayBinding.name)!;
  const references = new Map(context.index.references);
  references.set(symbol, [...(references.get(symbol) ?? []), mutation.value!]);
  const escapedAnalyzer = new ConstructorCarrierAnalyzer({ ...context, index: { ...context.index, references } });
  escapedAnalyzer.beginQuery();
  try { assert.equal(escapedAnalyzer.allowsExtendedInstanceIsolation(declaration), false, 'unmatched array reference must reject'); }
  finally { escapedAnalyzer.endQuery(); }
});

/** cached sterile success 전에 mutable index/inventory/manifest guards를 매 query 다시 읽는다. */
test('stage6 warm confinement revalidates in-place mutable proof inputs and recovers', () => {
  const fixture = indexed(sourceOf(confinedBody));
  const { context, declaration, file } = fixture;
  const manifestEdges = context.index.effectInventory!.manifest.moduleEdges as Map<ts.SourceFile,
    readonly { site: ts.Node; specifier: string | undefined; target: ts.Symbol | undefined }[]>;
  const originalManifestEdges = manifestEdges.get(file) ?? [];
  const exportSite = file.statements.find(ts.isExportDeclaration)!;
  const initialManifestEdges = [{ site: exportSite, specifier: undefined, target: undefined }];
  manifestEdges.set(file, initialManifestEdges);
  const analyzer = new ConstructorCarrierAnalyzer(context);
  const run = () => {
    analyzer.beginQuery();
    try { return analyzer.allowsExtendedInstanceIsolation(declaration); }
    finally { analyzer.endQuery(); }
  };
  assert.equal(run(), true);
  let arrayBinding: ts.VariableDeclaration | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'slots') arrayBinding ??= node;
    ts.forEachChild(node, find);
  };
  find(file); assert.ok(arrayBinding);
  const symbol = context.checker.getSymbolAtLocation(arrayBinding.name)!;
  const identityDeclaration = file.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'identity')!;
  const helperSymbol = context.checker.getSymbolAtLocation(identityDeclaration.name!)!;
  let runtimeIdentifier: ts.Identifier | undefined;
  const findIdentifier = (node: ts.Node): void => {
    if (runtimeIdentifier === undefined && ts.isIdentifier(node) && node !== identityDeclaration.name) runtimeIdentifier = node;
    ts.forEachChild(node, findIdentifier);
  };
  findIdentifier(file); assert.ok(runtimeIdentifier);
  const references = context.index.references as Map<ts.Symbol, ts.Node[]>;
  const referenceList = references.get(symbol)!;
  const extra = context.index.mutations.find(record => record.value !== undefined)!.value!;
  const referenceIndex = referenceList.findIndex(token => token !== extra);
  assert.ok(referenceIndex >= 0);
  const reference = referenceList[referenceIndex]!;
  referenceList[referenceIndex] = extra;
  assert.equal(run(), false, 'same-size reference list with an unmatched token must invalidate warm success');
  referenceList[referenceIndex] = reference; assert.equal(run(), true);
  const identifierWrites = context.index.identifierWrites as Map<ts.Symbol, readonly (ts.Expression | undefined)[]>;
  const originalWrites = identifierWrites.get(symbol);
  identifierWrites.set(symbol, [undefined]);
  assert.equal(run(), false, 'relevant identifier writes must invalidate warm success');
  if (originalWrites === undefined) identifierWrites.delete(symbol); else identifierWrites.set(symbol, originalWrites);
  assert.equal(run(), true);
  const exportedSymbols = context.index.exportedSymbols as Set<ts.Symbol>;
  const wasExported = exportedSymbols.has(symbol);
  exportedSymbols.add(symbol);
  assert.equal(run(), false, 'relevant exported-symbol membership must invalidate warm success');
  if (!wasExported) exportedSymbols.delete(symbol);
  assert.equal(run(), true);
  const tokenOccurrences = context.index.tokenOccurrences as Map<string, readonly ts.Node[]>;
  const hadEval = tokenOccurrences.has('eval'), originalEval = tokenOccurrences.get('eval');
  tokenOccurrences.set('eval', [runtimeIdentifier]);
  assert.equal(run(), false, 'new global eval token candidates must invalidate warm success');
  if (hadEval) tokenOccurrences.set('eval', originalEval!); else tokenOccurrences.delete('eval');
  assert.equal(run(), true);
  const replacementEntry = [...tokenOccurrences.entries()].find(([key]) => key !== '__replacement__')!;
  tokenOccurrences.delete(replacementEntry[0]);
  tokenOccurrences.set('__replacement__', replacementEntry[1]);
  assert.equal(run(), false, 'same-size token map key replacement must invalidate warm success');
  tokenOccurrences.delete('__replacement__'); tokenOccurrences.set(replacementEntry[0], replacementEntry[1]);
  assert.equal(run(), true);
  const helperWrites = context.index.identifierWrites as Map<ts.Symbol, readonly (ts.Expression | undefined)[]>;
  const hadHelperWrites = helperWrites.has(helperSymbol), originalHelperWrites = helperWrites.get(helperSymbol);
  helperWrites.set(helperSymbol, []);
  assert.equal(run(), false, 'present empty helper-write key must differ from an absent key');
  helperWrites.set(helperSymbol, [undefined]);
  assert.equal(run(), false, 'helper binding writes must invalidate warm success');
  if (hadHelperWrites) helperWrites.set(helperSymbol, originalHelperWrites!); else helperWrites.delete(helperSymbol);
  assert.equal(run(), true);
  const helperReferences = context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
  const originalHelperReferences = helperReferences.get(helperSymbol)!;
  helperReferences.set(helperSymbol, [...originalHelperReferences, runtimeIdentifier]);
  assert.equal(run(), false, 'helper reference escapes must invalidate warm success');
  helperReferences.set(helperSymbol, originalHelperReferences); assert.equal(run(), true);
  const aliasNames = context.index.aliasNames as Map<ts.Symbol, readonly string[]>;
  const hadAliases = aliasNames.has(helperSymbol), originalAliases = aliasNames.get(helperSymbol);
  aliasNames.set(helperSymbol, []); assert.equal(run(), false, 'present empty alias key must invalidate warm success');
  if (hadAliases) aliasNames.set(helperSymbol, originalAliases!); else aliasNames.delete(helperSymbol);
  assert.equal(run(), true);
  const memberReads = context.index.memberReads as Map<string, readonly ts.Node[]>;
  memberReads.set('__unsafe__', [runtimeIdentifier]); assert.equal(run(), false);
  memberReads.delete('__unsafe__'); assert.equal(run(), true);
  const propertyWrites = context.index.propertyWrites as Map<string, readonly import('./flow-index.ts').PropertyWrite[]>;
  propertyWrites.set('__unsafe__', []); assert.equal(run(), false);
  propertyWrites.delete('__unsafe__'); assert.equal(run(), true);
  const subclasses = context.index.subclasses as Map<ts.ClassLikeDeclaration, readonly ts.ClassLikeDeclaration[]>;
  const hadSubclasses = subclasses.has(declaration), originalSubclasses = subclasses.get(declaration);
  subclasses.set(declaration, []); assert.equal(run(), false);
  if (hadSubclasses) subclasses.set(declaration, originalSubclasses!); else subclasses.delete(declaration);
  assert.equal(run(), true);
  const helperWasExported = exportedSymbols.has(helperSymbol);
  exportedSymbols.add(helperSymbol); assert.equal(run(), false);
  if (!helperWasExported) exportedSymbols.delete(helperSymbol);
  assert.equal(run(), true);
  const newThisClasses = context.index.newThisClasses as Set<ts.ClassLikeDeclaration>;
  const hadNewThis = newThisClasses.has(declaration);
  newThisClasses.add(declaration); assert.equal(run(), false);
  if (!hadNewThis) newThisClasses.delete(declaration);
  assert.equal(run(), true);
  const openModules = context.index.openModules as Set<ts.Symbol>;
  const helperWasOpen = openModules.has(helperSymbol);
  openModules.add(helperSymbol); assert.equal(run(), false);
  if (!helperWasOpen) openModules.delete(helperSymbol);
  assert.equal(run(), true);
  const reflectiveTargets = context.index.reflectiveTargets as ts.Expression[];
  reflectiveTargets.push(extra); assert.equal(run(), false);
  reflectiveTargets.pop(); assert.equal(run(), true);

  const mutations = context.index.mutations as import('./flow-index.ts').MutationRecord[];
  const mutationIndex = mutations.findIndex(record => record.effect === 'property' && record.operation === 'assignment');
  assert.ok(mutationIndex >= 0);
  const mutation = mutations[mutationIndex]!;
  mutations[mutationIndex] = { ...mutation, key: mutation.value };
  assert.equal(run(), false, 'same mutation array length with changed exact record must invalidate warm success');
  mutations[mutationIndex] = mutation; assert.equal(run(), true);

  const inventory = context.index.effectInventory!;
  const records = inventory.records as { site: ts.Node; operation: string }[];
  const effect = records[0]!;
  records[0] = { ...effect, operation: 'spread' };
  assert.equal(run(), false, 'same effect record site and length with changed operation must invalidate warm success');
  records[0] = effect; assert.equal(run(), true);

  const manifest = inventory.manifest as unknown as { view: string;
    moduleEdges: Map<ts.SourceFile, readonly { site: ts.Node; specifier: string | undefined; target: ts.Symbol | undefined }[]> };
  const view = manifest.view;
  manifest.view = view === 'whole' ? 'production' : 'whole';
  assert.equal(run(), false, 'manifest view changes must invalidate warm success');
  manifest.view = view; assert.equal(run(), true);
  manifest.moduleEdges.set(file, [{ ...initialManifestEdges[0]!, specifier: "changed" }]);
  assert.equal(run(), false, 'same-size module edge field changes must invalidate warm success');
  manifest.moduleEdges.set(file, initialManifestEdges); assert.equal(run(), true);

  const sentinel = new RangeError('synthetic current-reference guard failure');
  const operationDescriptor = Object.getOwnPropertyDescriptor(effect, 'operation')!;
  Object.defineProperty(effect, 'operation', { configurable: true, get() { throw sentinel; } });
  assert.throws(run, error => error === sentinel);
  Object.defineProperty(effect, 'operation', operationDescriptor);
  assert.equal(run(), true);
  assert.equal([...context.index.proofDiagnostics].filter(message => message.includes('incomplete(entry)')).length, 1);
  manifestEdges.set(file, originalManifestEdges);
});

/** helper literal이 없어도 mutation consumer가 읽는 global index/inventory를 warm 전에 다시 검증한다. */
test('stage6 literal-free confinement revalidates all consumed current facts and recovers', () => {
  type Consumer = 'instance' | 'bag';
  const fixture = indexed(sourceOf('return identity(value);', { before: 'const slots = "harness";' }));
  const { context, declaration, literal, file } = fixture;
  const moduleEdges = context.index.effectInventory!.manifest.moduleEdges as Map<ts.SourceFile,
    readonly { site: ts.Node; specifier: string | undefined; target: ts.Symbol | undefined }[]>;
  const originalEdges = moduleEdges.get(file) ?? [];
  const exportSite = file.statements.find(ts.isExportDeclaration); assert.ok(exportSite);
  const validEdges = [{ site: exportSite, specifier: undefined, target: undefined }];
  moduleEdges.set(file, validEdges);
  const analyzer = new ConstructorCarrierAnalyzer(context);
  const reverseAnalyzer = new ConstructorCarrierAnalyzer(context);
  const run = (current: ConstructorCarrierAnalyzer, consumer: Consumer): boolean => {
    current.beginQuery();
    try { return consumer === 'instance' ? current.allowsExtendedInstanceIsolation(declaration)
      : current.isolatesExtendedBag(declaration, literal); }
    finally { current.endQuery(); }
  };
  const assertState = (expected: boolean, label: string): void => {
    for (const [current, order] of [[analyzer, ['instance', 'bag']],
      [reverseAnalyzer, ['bag', 'instance']]] as const) {
      for (const consumer of order) assert.equal(run(current, consumer), expected, `${label}:same:${consumer}`);
    }
    for (const consumer of ['instance', 'bag'] as const) {
      assert.equal(run(new ConstructorCarrierAnalyzer(context), consumer), expected, `${label}:fresh:${consumer}`);
    }
  };
  assertState(true, 'baseline');

  const injected = ts.createSourceFile('literal-free-eval.ts', 'eval("x");', ts.ScriptTarget.ES2022, true);
  const statement = injected.statements[0];
  assert.ok(statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
    && ts.isIdentifier(statement.expression.expression));
  const runtimeIdentifier = statement.expression.expression;
  const tokenOccurrences = context.index.tokenOccurrences as Map<string, readonly ts.Node[]>;
  const hadEval = tokenOccurrences.has('eval'), originalEval = tokenOccurrences.get('eval');
  tokenOccurrences.set('eval', [runtimeIdentifier]); assertState(false, 'eval-token');
  if (hadEval) tokenOccurrences.set('eval', originalEval!); else tokenOccurrences.delete('eval');
  assertState(true, 'eval-restored');

  const mutations = context.index.mutations as import('./flow-index.ts').MutationRecord[];
  const mutationIndex = mutations.findIndex(record => record.effect === 'property' && record.operation === 'assignment');
  assert.ok(mutationIndex >= 0);
  const mutation = mutations[mutationIndex]!;
  mutations[mutationIndex] = { ...mutation, key: mutation.value };
  assertState(false, 'mutation-record');
  mutations[mutationIndex] = mutation; assertState(true, 'mutation-restored');

  const records = context.index.effectInventory!.records as { site: ts.Node; operation: string }[];
  const effect = records[0]; assert.ok(effect);
  records[0] = { ...effect, operation: 'call' };
  assertState(false, 'inventory-operation');
  records[0] = effect; assertState(true, 'inventory-restored');

  const injectedEdge = ts.createSourceFile('literal-free-edge.ts', 'runtime();', ts.ScriptTarget.ES2022, true).statements[0];
  assert.ok(injectedEdge);
  moduleEdges.set(file, [{ site: injectedEdge, specifier: undefined, target: undefined }]);
  assertState(false, 'module-edge-site');
  moduleEdges.set(file, validEdges); assertState(true, 'module-edge-restored');
  moduleEdges.set(file, originalEdges);
});

test('stage6 literal-free confinement rechecks mutable intrinsic policy results', () => {
  const fixture = indexed(sourceOf('return identity(value);', { before: 'const slots = "harness";' }));
  let allowIntrinsic = true;
  const baseIntrinsic = fixture.context.policy.isDefaultLibraryFile!;
  const context: ConstructorCarrierContext = { ...fixture.context, policy: { ...fixture.context.policy,
    isDefaultLibraryFile: (file) => allowIntrinsic && baseIntrinsic(file),
  } };
  const analyzer = new ConstructorCarrierAnalyzer(context);
  const run = (current: ConstructorCarrierAnalyzer, consumer: 'instance' | 'bag'): boolean => {
    current.beginQuery();
    try { return consumer === 'instance' ? current.allowsExtendedInstanceIsolation(fixture.declaration)
      : current.isolatesExtendedBag(fixture.declaration, fixture.literal); }
    finally { current.endQuery(); }
  };
  for (const consumer of ['instance', 'bag'] as const) assert.equal(run(analyzer, consumer), true);
  allowIntrinsic = false;
  for (const consumer of ['instance', 'bag'] as const) {
    assert.equal(run(analyzer, consumer), false, `warm:${consumer}`);
    assert.equal(run(new ConstructorCarrierAnalyzer(context), consumer), false, `fresh:${consumer}`);
  }
  allowIntrinsic = true;
  for (const consumer of ['instance', 'bag'] as const) assert.equal(run(analyzer, consumer), true, `restored:${consumer}`);
});

/** literal-free current guard 재생이 중단돼도 다음 질의에서 unsafe/restore 상태를 다시 읽는다. */
test('stage6 literal-free current fact replay is charged and retryable for both consumers', () => {
  type Consumer = 'instance' | 'bag';
  const create = (consumer: Consumer) => {
    const fixture = indexed(sourceOf('return identity(value);', { before: 'const slots = "harness";' }));
    let steps = 0, limit = Infinity;
    const sentinel = new Error(`literal-free-${consumer}-budget`);
    const analyzer = new ConstructorCarrierAnalyzer({ ...fixture.context, caller: {
      step: () => { if (++steps > limit) throw sentinel; }, check: () => {},
    } });
    const run = (): boolean => {
      analyzer.beginQuery();
      try { return consumer === 'instance' ? analyzer.allowsExtendedInstanceIsolation(fixture.declaration)
        : analyzer.isolatesExtendedBag(fixture.declaration, fixture.literal); }
      finally { analyzer.endQuery(); }
    };
    const injected = ts.createSourceFile(`literal-free-${consumer}.ts`, 'eval("x");', ts.ScriptTarget.ES2022, true);
    const statement = injected.statements[0];
    assert.ok(statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)
      && ts.isIdentifier(statement.expression.expression));
    const evalToken = statement.expression.expression;
    const tokens = fixture.context.index.tokenOccurrences as Map<string, readonly ts.Node[]>;
    const hadEval = tokens.has('eval'), previous = tokens.get('eval');
    return { sentinel, run, inject: () => tokens.set('eval', [evalToken]),
      restore: () => { if (hadEval) tokens.set('eval', previous!); else tokens.delete('eval'); },
      reset: (next: number) => { steps = 0; limit = next; }, steps: () => steps };
  };
  for (const consumer of ['instance', 'bag'] as const) {
    const measured = create(consumer);
    assert.equal(measured.run(), true); measured.inject(); measured.reset(Infinity);
    assert.equal(measured.run(), false); const fullSteps = measured.steps();
    assert.ok(fullSteps > 1 && fullSteps <= 20_000);
    const current = create(consumer);
    assert.equal(current.run(), true); current.inject(); current.reset(Math.floor(fullSteps / 2));
    assert.throws(() => current.run(), error => error === current.sentinel);
    current.reset(Infinity); assert.equal(current.run(), false);
    current.restore(); current.reset(Infinity); assert.equal(current.run(), true);
  }
});

/** descriptor가 먼저 helper literal을 캐시해도 실제 helper reference 변경은 모든 consumer를 무효화한다. */
test('stage6 shared helper cache revalidates descriptor-first consumers in both orders', () => {
  type Consumer = 'instance' | 'bag';
  const body = 'const slots = { value }; slots.value = identity(value); return slots.value;';
  for (const order of [['instance', 'bag'], ['bag', 'instance']] as const) {
    const fixture = indexed(sourceOf(body));
    const declaration = fixture.declaration;
    const analyzer = new ConstructorCarrierAnalyzer(fixture.context);
    const run = (current: ConstructorCarrierAnalyzer, consumer: Consumer): boolean => {
      current.beginQuery();
      try {
        return consumer === 'instance' ? current.allowsExtendedInstanceIsolation(declaration)
          : current.isolatesExtendedBag(declaration, fixture.literal);
      } finally { current.endQuery(); }
    };
    assert.equal(run(analyzer, 'instance'), true);
    assert.equal(run(analyzer, 'bag'), true);
    const symbol = fixture.context.checker.getSymbolAtLocation(fixture.slots.name);
    assert.ok(symbol);
    const references = fixture.context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
    const original = references.get(symbol) ?? [];
    assert.ok(original.length > 0);
    references.set(symbol, [...original, original[0]!]);
    for (const consumer of order) {
      assert.equal(run(analyzer, consumer), true, `${consumer} must accept an existing reference duplicate`);
      assert.equal(run(new ConstructorCarrierAnalyzer(fixture.context), consumer), true);
    }
    references.set(symbol, original);
    const injected = ts.createSourceFile('escape.ts', 'consume(slots);', ts.ScriptTarget.ES2022, true);
    const statement = injected.statements[0];
    assert.ok(statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression));
    const token = statement.expression.arguments[0];
    assert.ok(token && ts.isIdentifier(token));
    references.set(symbol, [...original, token]);
    for (const consumer of order) {
      assert.equal(run(analyzer, consumer), false, `${consumer} must reject the changed helper fact`);
      assert.equal(run(new ConstructorCarrierAnalyzer(fixture.context), consumer), false,
        `${consumer} fresh analysis must reject the changed helper fact`);
    }
    references.set(symbol, original);
    for (const consumer of order) {
      assert.equal(run(analyzer, consumer), true, `${consumer} must recover after restoring helper facts`);
      assert.equal(run(new ConstructorCarrierAnalyzer(fixture.context), consumer), true);
    }
  }
});

/** exported runtime entry의 binding reference는 entry recipe가 직접 재감사한다. */
test('stage6 entry-owned references accept duplicates and reject a newly unsafe runtime entry', () => {
  const fixture = indexed(sourceOf(confinedBody, {
    calls: 'export const read = () => controller.run("safe"); read();',
  }));
  const read = fixture.file.statements.flatMap(statement => ts.isVariableStatement(statement)
    ? [...statement.declarationList.declarations] : []).find(declaration => ts.isIdentifier(declaration.name)
      && declaration.name.text === 'read');
  assert.ok(read && ts.isIdentifier(read.name));
  const symbol = fixture.context.checker.getSymbolAtLocation(read.name);
  assert.ok(symbol);
  const references = fixture.context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
  const original = references.get(symbol) ?? [];
  assert.ok(original.length > 0);
  const moduleEdges = fixture.context.index.effectInventory!.manifest.moduleEdges as Map<ts.SourceFile,
    readonly { site: ts.Node; specifier: string | undefined; target: ts.Symbol | undefined }[]>;
  const originalModuleEdges = moduleEdges.get(fixture.file) ?? [];
  const exportSite = fixture.file.statements.find(ts.isExportDeclaration);
  assert.ok(exportSite);
  const entryEdge = { site: exportSite, specifier: undefined, target: undefined };
  moduleEdges.set(fixture.file, [entryEdge]);
  const analyzer = new ConstructorCarrierAnalyzer(fixture.context);
  const run = (current = analyzer): boolean => {
    current.beginQuery();
    try { return current.allowsExtendedInstanceIsolation(fixture.declaration); }
    finally { current.endQuery(); }
  };
  assert.equal(run(), true);
  references.set(symbol, [...original, original[0]!, original.at(-1)!, original[0]!]);
  assert.equal(run(), true, 'cached entry must re-audit multiple existing-reference duplicates');
  assert.equal(run(new ConstructorCarrierAnalyzer(fixture.context)), true);
  references.set(symbol, original); assert.equal(run(), true);
  const runMethod = fixture.declaration.members.find((member): member is ts.MethodDeclaration =>
    ts.isMethodDeclaration(member) && member.name.getText() === 'run');
  assert.ok(runMethod);
  const occurrences = fixture.context.index.tokenOccurrences as Map<string, readonly ts.Node[]>;
  const originalOccurrences = occurrences.get('run') ?? [];
  const callOccurrence = originalOccurrences.find(node => node !== runMethod.name);
  assert.ok(callOccurrence);
  occurrences.set('run', [...originalOccurrences, callOccurrence, callOccurrence, callOccurrence]);
  assert.equal(run(), true, 'cached entry plan must re-audit multiple existing token occurrences');
  assert.equal(run(new ConstructorCarrierAnalyzer(fixture.context)), true);
  occurrences.set('run', originalOccurrences); assert.equal(run(), true);
  moduleEdges.set(fixture.file, [entryEdge, entryEdge, entryEdge]);
  assert.equal(run(), true, 'cached module-order plan must re-audit duplicate existing edges');
  assert.equal(run(new ConstructorCarrierAnalyzer(fixture.context)), true);
  moduleEdges.set(fixture.file, [entryEdge]); assert.equal(run(), true);

  const unsafe = indexed(sourceOf(confinedBody, {
    calls: 'export const read = () => controller.run("safe"); read();',
  }));
  const unsafeRead = unsafe.file.statements.flatMap(statement => ts.isVariableStatement(statement)
    ? [...statement.declarationList.declarations] : []).find(declaration => ts.isIdentifier(declaration.name)
      && declaration.name.text === 'read');
  assert.ok(unsafeRead && ts.isIdentifier(unsafeRead.name));
  const unsafeSymbol = unsafe.context.checker.getSymbolAtLocation(unsafeRead.name);
  assert.ok(unsafeSymbol);
  const unsafeReferences = unsafe.context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
  const safeEntries = unsafeReferences.get(unsafeSymbol) ?? [];
  let runtimeEntry: ts.Identifier | undefined;
  const findRuntimeEntry = (node: ts.Node): void => {
    if (runtimeEntry === undefined && ts.isCallExpression(node) && node.arguments.length === 0
      && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)
      && node.expression.name.text === 'tick') runtimeEntry = node.expression.name;
    ts.forEachChild(node, findRuntimeEntry);
  };
  findRuntimeEntry(unsafe.file); assert.ok(runtimeEntry);
  const unsafeAnalyzer = new ConstructorCarrierAnalyzer(unsafe.context);
  const runUnsafe = (current = unsafeAnalyzer): boolean => {
    current.beginQuery();
    try { return current.allowsExtendedInstanceIsolation(unsafe.declaration); }
    finally { current.endQuery(); }
  };
  assert.equal(runUnsafe(), true);
  unsafeReferences.set(unsafeSymbol, [...safeEntries, runtimeEntry]);
  assert.equal(runUnsafe(), false, 'a foreign actual zero-argument runtime entry must invalidate cached authority');
  assert.equal(runUnsafe(new ConstructorCarrierAnalyzer(unsafe.context)), false);
  unsafeReferences.set(unsafeSymbol, safeEntries);
  assert.equal(runUnsafe(new ConstructorCarrierAnalyzer(unsafe.context)), true);
  assert.equal(runUnsafe(), true, `cached entry must recover: ${JSON.stringify([...unsafe.context.index.proofDiagnostics])}`);
  moduleEdges.set(fixture.file, originalModuleEdges);
});

/** interface endpoint resolution이 읽은 carrier symbol facts도 instantiation recipe가 소유한다. */
test('stage6 dependency-owned references match fresh census and recover', () => {
  const source = sourceOf(confinedBody)
    .replace('class Port {', 'interface Endpoint { send(value: string): string; }\nclass Port implements Endpoint {')
    .replace('port: Port;', 'port: Endpoint;').replace('const live =', 'const live: Endpoint =');
  const fixture = indexed(source);
  const name = fixture.declaration.name;
  assert.ok(name);
  const symbol = fixture.context.checker.getSymbolAtLocation(name);
  assert.ok(symbol);
  const references = fixture.context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
  const original = references.get(symbol) ?? [];
  assert.ok(original.length > 0);
  const analyzer = new ConstructorCarrierAnalyzer(fixture.context);
  const run = (current = analyzer): boolean => {
    current.beginQuery();
    try { return current.allowsExtendedInstanceIsolation(fixture.declaration); }
    finally { current.endQuery(); }
  };
  assert.equal(run(), true);
  references.set(symbol, [...original, original[0]!, original.at(-1)!, original[0]!]);
  assert.equal(run(), false, 'cached dependency target must re-audit the changed carrier census');
  assert.equal(run(new ConstructorCarrierAnalyzer(fixture.context)), false,
    'singleton construction census treats duplicate carrier rows as multiple allocations');
  references.set(symbol, original); assert.equal(run(), true);
  const injected = ts.createSourceFile('second-controller.ts', 'new Controller({});', ts.ScriptTarget.ES2022, true);
  const statement = injected.statements[0];
  assert.ok(statement && ts.isExpressionStatement(statement) && ts.isNewExpression(statement.expression));
  const token = statement.expression.expression;
  assert.ok(ts.isIdentifier(token));
  references.set(symbol, [...original, token]);
  assert.equal(run(), false, 'a distinct allocation reference must invalidate the cached dependency target');
  assert.equal(run(new ConstructorCarrierAnalyzer(fixture.context)), false);
  references.set(symbol, original); assert.equal(run(), true);
});

/** entry/instantiation fact 재감사는 caller 중단 뒤 현재 입력에서 다시 시작한다. */
test('stage6 entry and dependency fact reconstruction recover after abort', () => {
  const entryHarness = (unsafe: boolean) => {
    const fixture = indexed(sourceOf(confinedBody, {
      calls: 'export const read = () => controller.run("safe"); read();',
    }));
    const binding = fixture.file.statements.flatMap(statement => ts.isVariableStatement(statement)
      ? [...statement.declarationList.declarations] : []).find(declaration => ts.isIdentifier(declaration.name)
        && declaration.name.text === 'read');
    assert.ok(binding && ts.isIdentifier(binding.name));
    const symbol = fixture.context.checker.getSymbolAtLocation(binding.name);
    assert.ok(symbol);
    const references = fixture.context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
    const original = references.get(symbol) ?? [];
    assert.ok(original.length > 0);
    let runtimeEntry: ts.Identifier | undefined;
    const find = (node: ts.Node): void => {
      if (runtimeEntry === undefined && ts.isCallExpression(node) && node.arguments.length === 0
        && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.name)
        && node.expression.name.text === 'tick') runtimeEntry = node.expression.name;
      ts.forEachChild(node, find);
    };
    find(fixture.file); assert.ok(runtimeEntry);
    let steps = 0, limit = Infinity;
    const sentinel = new Error('entry fact reconstruction budget');
    const analyzer = new ConstructorCarrierAnalyzer({ ...fixture.context, caller: {
      step: () => { if (++steps > limit) throw sentinel; }, check: () => {},
    } });
    const run = (): boolean => {
      analyzer.beginQuery();
      try { return analyzer.allowsExtendedInstanceIsolation(fixture.declaration); }
      finally { analyzer.endQuery(); }
    };
    return { sentinel, run, change: () => references.set(symbol, unsafe
      ? [...original, runtimeEntry!] : [...original, original[0]!, original.at(-1)!, original[0]!]),
    restore: () => references.set(symbol, original), reset: (next: number) => { steps = 0; limit = next; },
    steps: () => steps, expected: !unsafe };
  };
  const dependencyHarness = () => {
    const source = sourceOf(confinedBody)
      .replace('class Port {', 'interface Endpoint { send(value: string): string; }\nclass Port implements Endpoint {')
      .replace('port: Port;', 'port: Endpoint;').replace('const live =', 'const live: Endpoint =');
    const fixture = indexed(source), name = fixture.declaration.name;
    assert.ok(name);
    const symbol = fixture.context.checker.getSymbolAtLocation(name);
    assert.ok(symbol);
    const references = fixture.context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
    const original = references.get(symbol) ?? [];
    assert.ok(original.length > 0);
    let steps = 0, limit = Infinity;
    const sentinel = new Error('dependency fact reconstruction budget');
    const analyzer = new ConstructorCarrierAnalyzer({ ...fixture.context, caller: {
      step: () => { if (++steps > limit) throw sentinel; }, check: () => {},
    } });
    const run = (): boolean => {
      analyzer.beginQuery();
      try { return analyzer.allowsExtendedInstanceIsolation(fixture.declaration); }
      finally { analyzer.endQuery(); }
    };
    return { sentinel, run,
      change: () => references.set(symbol, [...original, original[0]!, original.at(-1)!, original[0]!]),
      restore: () => references.set(symbol, original), reset: (next: number) => { steps = 0; limit = next; },
      steps: () => steps, expected: false };
  };

  for (const create of [() => entryHarness(false), () => entryHarness(true), dependencyHarness]) {
    const measured = create();
    assert.equal(measured.run(), true); measured.change(); measured.reset(Infinity);
    assert.equal(measured.run(), measured.expected); const fullSteps = measured.steps();
    assert.ok(fullSteps > 1 && fullSteps <= 20_000);
    const current = create();
    assert.equal(current.run(), true); current.change(); current.reset(Math.floor(fullSteps / 2));
    assert.throws(() => current.run(), error => error === current.sentinel);
    current.reset(Infinity); assert.equal(current.run(), current.expected);
    current.restore(); current.reset(Infinity); assert.equal(current.run(), true);
  }
});

/** changed reference 재감사는 이전 replay와 재구성을 모두 청구하고 중단 뒤에도 복구한다. */
test('stage6 shared helper reference reconstruction is charged bounded and retryable', () => {
  const create = () => {
    const fixture = indexed(sourceOf('const slots = { value }; slots.value = identity(value); return slots.value;'));
    let steps = 0, limit = Infinity;
    const sentinel = new Error('shared helper reconstruction budget');
    const analyzer = new ConstructorCarrierAnalyzer({ ...fixture.context, caller: {
      step: () => { if (++steps > limit) throw sentinel; }, check: () => {},
    } });
    const run = (field = false): boolean => {
      analyzer.beginQuery();
      try { return field ? analyzer.allowsCarrierFieldFlow(fixture.declaration)
        : analyzer.allowsExtendedInstanceIsolation(fixture.declaration); }
      finally { analyzer.endQuery(); }
    };
    const duplicate = (): void => {
      const symbol = fixture.context.checker.getSymbolAtLocation(fixture.slots.name);
      assert.ok(symbol);
      const references = fixture.context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
      const original = references.get(symbol) ?? [];
      assert.ok(original.length > 0);
      references.set(symbol, [...original, original[0]!, original.at(-1)!, original[0]!]);
    };
    return { sentinel, run, duplicate, reset: (next: number) => { steps = 0; limit = next; }, steps: () => steps };
  };

  const measured = create();
  assert.equal(measured.run(true), true); assert.equal(measured.run(), true);
  measured.reset(Infinity); assert.equal(measured.run(), true); const warmSteps = measured.steps();
  measured.duplicate(); measured.reset(Infinity); assert.equal(measured.run(), true);
  const reconstructionSteps = measured.steps();
  assert.ok(reconstructionSteps > warmSteps);
  assert.ok(reconstructionSteps <= 20_000);

  for (const budget of new Set([0, Math.floor(reconstructionSteps / 2), reconstructionSteps - 1, reconstructionSteps])) {
    const current = create();
    assert.equal(current.run(true), true); assert.equal(current.run(), true); current.duplicate(); current.reset(budget);
    if (budget < reconstructionSteps) {
      assert.throws(() => current.run(), error => error === current.sentinel);
      assert.equal(current.steps(), budget + 1);
      current.reset(Infinity); assert.equal(current.run(), true);
    } else {
      assert.equal(current.run(), true); assert.equal(current.steps(), reconstructionSteps);
    }
  }
});

/** descriptor 이후 consumer 증명이 예산 중단되어도 retry가 helper fact 변경을 놓치지 않는다. */
test('stage6 shared helper cache revalidates after aborted consumer retry', () => {
  const body = 'const slots = { value }; slots.value = identity(value); return slots.value;';
  const measure = indexed(sourceOf(body));
  let steps = 0;
  const measured = new ConstructorCarrierAnalyzer({ ...measure.context, caller: { step: () => { steps++; }, check: () => {} } });
  const measuredDeclaration = measure.declaration;
  measured.beginQuery();
  try { assert.equal(measured.allowsCarrierFieldFlow(measuredDeclaration), true); }
  finally { measured.endQuery(); }
  steps = 0;
  measured.beginQuery();
  try { assert.equal(measured.allowsExtendedInstanceIsolation(measuredDeclaration), true); }
  finally { measured.endQuery(); }
  const fullSteps = steps;
  for (const fraction of [0, .25, .5]) {
    const fixture = indexed(sourceOf(body));
    const declaration = fixture.declaration;
    let count = 0;
    let limit = Math.floor(fullSteps * fraction);
    const sentinel = new Error('shared helper retry budget');
    const analyzer = new ConstructorCarrierAnalyzer({ ...fixture.context, caller: {
      step: () => { if (++count > limit) throw sentinel; }, check: () => {},
    } });
    limit = Infinity;
    analyzer.beginQuery();
    try { assert.equal(analyzer.allowsCarrierFieldFlow(declaration), true); }
    finally { analyzer.endQuery(); }
    count = 0; limit = Math.floor(fullSteps * fraction);
    assert.throws(() => runAborted(analyzer, declaration), error => error === sentinel);
    const symbol = fixture.context.checker.getSymbolAtLocation(fixture.slots.name);
    assert.ok(symbol);
    const injected = ts.createSourceFile(`escape-${fraction}.ts`, 'consume(slots);', ts.ScriptTarget.ES2022, true);
    const statement = injected.statements[0];
    assert.ok(statement && ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression));
    const token = statement.expression.arguments[0];
    assert.ok(token && ts.isIdentifier(token));
    const references = fixture.context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
    const original = references.get(symbol) ?? [];
    references.set(symbol, [...original, token]);
    count = 0; limit = Infinity;
    assert.equal(runAborted(analyzer, declaration), false);
    references.set(symbol, original);
    count = 0;
    assert.equal(runAborted(analyzer, declaration), true);
  }
});

function runAborted(analyzer: ConstructorCarrierAnalyzer, declaration: ts.ClassDeclaration): boolean {
  analyzer.beginQuery();
  try { return analyzer.allowsExtendedInstanceIsolation(declaration); }
  finally { analyzer.endQuery(); }
}

/** same-pos foreign declaration은 exact-bag recipe cache를 어느 query order에서도 공유하지 않는다. */
test('stage6 exact-bag cache keys declaration object identity in both query orders', () => {
  const first = indexed(sourceOf(confinedBody));
  const second = indexed(sourceOf(confinedBody));
  assert.equal(first.declaration.pos, second.declaration.pos);
  const firstAnalyzer = new ConstructorCarrierAnalyzer(first.context);
  firstAnalyzer.beginQuery();
  try {
    assert.equal(firstAnalyzer.isolatesExtendedBag(first.declaration, first.literal), true);
    assert.equal(firstAnalyzer.isolatesExtendedBag(second.declaration, first.literal), false);
  } finally { firstAnalyzer.endQuery(); }
  const reverseAnalyzer = new ConstructorCarrierAnalyzer(first.context);
  reverseAnalyzer.beginQuery();
  try {
    assert.equal(reverseAnalyzer.isolatesExtendedBag(second.declaration, first.literal), false);
    assert.equal(reverseAnalyzer.isolatesExtendedBag(first.declaration, first.literal), true);
  } finally { reverseAnalyzer.endQuery(); }
});

/** standalone generic DAG와 structural witness에는 confinement issuer가 존재하지 않는다. */
test('stage6 generic proof DAG cannot register or issue confinement authority', async t => {
  const confinement = await import('./sterile-confinement.ts');
  const { ProofDag, ProofQuery } = await import('./proof-dag.ts');
  const { isMutationCleanView } = await import('./mutation-safety.ts');
  const { context, declaration, literal } = indexed(sourceOf(confinedBody));
  const structural = { proof: { declaration: literal, constructor: undefined, bagParameter: undefined,
    bagKeys: new Set<string>(), innerLiteral: literal, serviceUses: [], projectionBindings: [], allowedMutationSites: new Set<ts.Node>() },
    origin: { index: context.index, checker: context.checker, inventory: context.index.effectInventory },
    dependencies: new Set(), models: new Map(), writes: new Map(), literals: new Map() };
  const recipe = Object.freeze({ id: 'standalone:primitive-effects', identity: declaration,
    capability: 'primitive-effects' as const, mode: 'extended' as const, valid: () => true,
    dependencies: () => [], evaluate: () => ({ kind: 'proved' as const, value: structural }) });
  const dag = new ProofDag({ program: context.program!, checker: context.checker, view: 'whole',
    manifest: context.index.effectInventory?.manifest, policy: context.policy, version: 4, coverage: () => true });
  const query = new ProofQuery();
  const outcome = dag.resolve(recipe, query);
  assert.equal(outcome.kind, 'proved');
  if (outcome.kind !== 'proved') return;
  assert.equal(dag.accepts(outcome.certificate, 'primitive-effects', declaration, query, 'extended'), true);
  assert.equal(dag.accepts(outcome.certificate, 'descriptor', declaration, query, 'extended'), false);
  assert.equal(dag.accepts(outcome.certificate, 'primitive-effects', literal, query, 'extended'), false);
  assert.equal(dag.accepts(outcome.certificate, 'primitive-effects', declaration, query, 'legacy'), false);
  assert.equal(dag.accepts({ ...outcome.certificate }, 'primitive-effects', declaration, query, 'extended'), false);
  const foreignDag = new ProofDag({ program: context.program!, checker: context.checker, view: 'whole',
    manifest: context.index.effectInventory?.manifest, policy: context.policy, version: 4, coverage: () => true });
  assert.equal(foreignDag.accepts(outcome.certificate, 'primitive-effects', declaration, query, 'extended'), false);
  assert.equal(Reflect.get(dag, 'completedValue'), undefined);
  assert.equal(Reflect.get(confinement, 'completeSterileConfinement'), undefined);
  const safety = { checker: context.checker, index: context.index,
    isDefaultLibraryFile: context.policy.isDefaultLibraryFile!, openProgram: false, openProperties: false };
  assert.equal(isMutationCleanView(safety), false);
  const forged = { write: () => true, array: () => true } as unknown as import('./constructor-carrier.ts').SterileConfinementCertificate;
  assert.equal(isMutationCleanView(safety, { confinement: forged }), false);
  assert.equal(isMutationCleanView(safety, { confinement: Object.create(
    confinement.SterileConfinementCertificate.prototype) as import('./constructor-carrier.ts').SterileConfinementCertificate }), false);
  structural.origin.index = { ...context.index };
  structural.models.set(literal, 'primitive-helper');
  structural.writes.set(literal, { target: literal, key: '0', value: literal });
  assert.equal(isMutationCleanView(safety), false, 'generic proved value mutation cannot create authority');

  await t.test('runtime constructor', () => {
    assert.throws(() => Reflect.construct(confinement.SterileConfinementCertificate as unknown as Function,
      [{}, safety, structural, () => {}]));
  });
  await t.test('runtime subclass', () => {
    const RuntimeCertificate = confinement.SterileConfinementCertificate as unknown as new (...args: unknown[]) => object;
    class ForgedCertificate extends RuntimeCertificate {}
    assert.throws(() => new ForgedCertificate({}, safety, structural, () => {}));
  });
});

/** 새 literal proof의 반복 edge에도 caller depth/frame 경계를 같은 위치에서 검사한다. */
test('stage6 new proof depth and frame edge boundaries replay on every query', () => {
  const { context, declaration } = indexed(sourceOf(confinedBody));
  const failure = new Error('synthetic confinement edge interruption');
  let depthLimit = Infinity, frameLimit = Infinity, maxDepth = 0, maxFrames = 0;
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
    step: () => {}, check: (depth, frames) => {
      maxDepth = Math.max(maxDepth, depth); maxFrames = Math.max(maxFrames, frames);
      if (depth > depthLimit || frames > frameLimit) throw failure;
    },
  } });
  const run = () => {
    maxDepth = 0; maxFrames = 0; analyzer.beginQuery();
    try { return analyzer.allowsExtendedInstanceIsolation(declaration); }
    finally { analyzer.endQuery(); }
  };
  assert.equal(run(), true);
  const depth = maxDepth, frames = maxFrames;
  assert.ok(depth > 0 && frames > 0 && depth <= 256 && frames <= 400);
  depthLimit = depth; frameLimit = frames; assert.equal(run(), true);
  depthLimit = depth - 1; assert.throws(run, error => error === failure);
  depthLimit = depth; frameLimit = frames - 1; assert.throws(run, error => error === failure);
  frameLimit = frames; assert.equal(run(), true);
});

/** primitive capture와 module-ready arrow의 실제 호출마다 literal 초기화를 요구한다. */
test('stage6 primitive captures and late module-ready bindings use every actual entry', async () => {
  const body = 'const slots = { value: captured }; const alias = slots; alias.value = identity(value); return alias.value;';
  assert.deepEqual(endpointEvidence(await graphOf(body, { before: 'const captured = "safe";' })), ['bound']);
  assert.deepEqual(endpointEvidence(await graphOf(body, {
    calls: 'controller.run("one"); const captured = "safe"; controller.run("two");',
  })), ['candidate']);
  const capturedRead = 'const slots = [shared[0]]; return slots[0];';
  const ready = await graphOf(capturedRead, {
    calls: 'export const read = () => controller.run("safe"); const shared = ["safe"]; read();',
  });
  assert.deepEqual(endpointEvidence(ready), ['bound'], JSON.stringify(ready.limitations));
  const early = await graphOf(capturedRead, {
    calls: 'export const read = () => controller.run("safe"); read(); const shared = ["safe"];',
  });
  assert.deepEqual(endpointEvidence(early), ['candidate']);
});

/** literal grammar가 있어도 누락 inventory나 exact 모델과 다른 effect는 거부한다. */
test('stage6 incomplete and unmatched effect inventory cannot mint literal authority', () => {
  const { context, declaration } = indexed(sourceOf(confinedBody));
  const inventory = context.index.effectInventory!;
  const literal = inventory.records.find(record => ts.isArrayLiteralExpression(record.site))!;
  assert.ok(literal);
  for (const effectInventory of [
    { ...inventory, enumeration: 'incomplete' as const },
    { ...inventory, referenceAliases: 'incomplete' as const },
    { ...inventory, initialization: 'incomplete' as const },
    { ...inventory, records: [...inventory.records, { ...literal, operation: 'spread' as const }] },
    { ...inventory, records: [...inventory.records, { ...literal, operation: 'call' as const }] },
  ]) {
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, index: { ...context.index, effectInventory } });
    analyzer.beginQuery();
    try { assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false); }
    finally { analyzer.endQuery(); }
  }
});

/** type/ambient 경계를 찾지 못한 bounded parent walk는 runtime reference로 fail closed한다. */
test('stage6 erased-reference walk exhaustion is runtime and deep escapes retain cap diagnostics', async () => {
  const wrappers = '('.repeat(300), closers = ')'.repeat(300);
  const source = ts.createSourceFile('deep-reference.ts',
    `const value = "safe"; consume(${wrappers}value${closers});`, ts.ScriptTarget.ES2022, true);
  let token: ts.Identifier | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === 'value' && !ts.isVariableDeclaration(node.parent)) token = node;
    ts.forEachChild(node, find);
  };
  find(source); assert.ok(token);
  const work = (() => {}) as ProofWork;
  work.observe = guard => guard.read(); work.require = (guard, required) => { assert.equal(guard.read(), required); };
  assert.equal(primitiveErasedReference(token, work), false);
  for (const body of [
    `const slots = [value]; identity(${wrappers}slots${closers}); return value;`,
    `const slots = { value }; identity(${wrappers}slots${closers}); return value;`,
  ]) {
    const graph = await graphOf(body);
    assert.deepEqual(endpointEvidence(graph), ['candidate']);
    assert.ok(graph.limitations.some(message => message.startsWith('dispatch-budget:')), JSON.stringify(graph.limitations));
    assert.ok(graph.limitations.some(message => message.includes('carrier-proof: rejected')), JSON.stringify(graph.limitations));
  }
});
