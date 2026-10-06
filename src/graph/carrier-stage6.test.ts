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
  let literal: ts.ObjectLiteralExpression | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Controller') literal = node.arguments![0] as ts.ObjectLiteralExpression;
    ts.forEachChild(node, find);
  };
  find(file); assert.ok(literal);
  const context = { program, checker, index, policy: {
    isProjectFile: source => source === file, isOpenCallable: () => false, isOverridden: () => false,
    openProperties: false, isDefaultLibraryFile: source => program.isSourceFileDefaultLibrary(source),
  } } satisfies ConstructorCarrierContext;
  return { context, declaration, literal, file };
}

const confinedBody = 'const slots = [value]; const first = slots; const second = first; const previous = second[0]; second[0] = identity(previous); return second[0];';

/** literal closure와 copy work도 실제 proof의 cold/warm charged prefix를 유지한다. */
test('stage6 new proof cold warm event prefixes negative replay and reversed consumers match', () => {
  for (const body of [confinedBody, confinedBody.replace('return second[0];', 'identity(first); return second[0];')]) {
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
    assert.equal(complete.value, body === confinedBody); assert.equal(bag.value, complete.value);
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

/** 실제 primitive-effects DAG의 완료 witness로 세 guard의 동일 인증서 소비를 확인한다. */
test('stage6 same completed certificate validates dirty receiver array closure and final records', async () => {
  const { completeSterileConfinement } = await import('./sterile-confinement.ts');
  const { isMutationCleanView } = await import('./mutation-safety.ts');
  const { ProofQuery } = await import('./proof-dag.ts');
  const { context, declaration } = indexed(sourceOf(confinedBody));
  const analyzer = new ConstructorCarrierAnalyzer(context);
  // 새 public 테스트 API를 추가하지 않고 실제 analyzer의 내부 DAG node를 검증한다.
  const probe = analyzer as unknown as {
    singletonRecipe: (declaration: ts.ClassLikeDeclaration, capability: 'primitive-effects') => import('./proof-dag.ts').ProofRecipe<import('./singleton-carrier.ts').SingletonWitness>;
    dag: import('./proof-dag.ts').ProofDag;
  };
  const result = probe.dag.resolve(probe.singletonRecipe(declaration, 'primitive-effects'), new ProofQuery());
  assert.equal(result.kind, 'proved');
  if (result.kind !== 'proved') return;
  const safety = { checker: context.checker, index: context.index,
    isDefaultLibraryFile: context.policy.isDefaultLibraryFile!, openProgram: false, openProperties: false };
  const work = Object.assign(() => {}, { observe: (guard: import('./proof-dag.ts').ProofGuard) => guard.read(),
    require: (guard: import('./proof-dag.ts').ProofGuard, expected: boolean) => assert.equal(guard.read(), expected) });
  const certificate = completeSterileConfinement(safety, result.value, work);
  assert.equal(isMutationCleanView(safety), false, 'legacy reference guard cannot grant alias authority');
  assert.equal(isMutationCleanView(safety, { confinement: certificate }), true);
  assert.equal(isMutationCleanView(safety), false, 'completed root authority must not enter global array memo');
  const forged = { write: () => true, array: () => true } as unknown as typeof certificate;
  assert.equal(isMutationCleanView(safety, { confinement: forged }), false);
  assert.equal(isMutationCleanView(safety, { confinement: null as unknown as typeof certificate }), false);
  assert.equal(isMutationCleanView(safety, { confinement: 1 as unknown as typeof certificate }), false);
  assert.equal(isMutationCleanView(safety, { confinement: Object.create(Object.getPrototypeOf(certificate)) as typeof certificate }), false);
  const record = context.index.mutations.find(record => [...(result.value.literals?.values() ?? [])].some(literal => literal.writes.has(record.site)));
  assert.ok(record);
  assert.equal(certificate.write(safety, record), true);
  for (const changed of [
    { ...record, value: record.target }, { ...record, target: record.value! },
    { ...record, staticKey: '1' }, { ...record, key: record.value },
    { ...record, effect: 'prototype' as const }, { ...record, operation: 'delete' as const },
    { ...record, source: record.value }, { ...record, sources: [record.value!] },
    { ...record, descriptor: record.value }, { ...record, prototype: record.value },
    { ...record, args: [record.value!] }, { ...record, confidence: 'unknown' as const },
  ]) assert.equal(certificate.write(safety, changed), false);
  const foreign = { ...safety, index: { ...context.index } };
  assert.equal(certificate.write(foreign, record), false);
  const other = indexed(sourceOf(confinedBody));
  assert.equal(certificate.write({ ...safety, checker: other.context.checker }, record), false);
  assert.equal(certificate.write({ ...safety, openProgram: true }, record), false);
  assert.equal(certificate.write({ ...safety, openProperties: true }, record), false);
  assert.equal(isMutationCleanView(foreign, { confinement: certificate }), false);
  const mutations = context.index.mutations as import("./flow-index.ts").MutationRecord[];
  const current = safety;
  let calls = 0, active = false;
  const changed = { ...record, key: record.value };
  // dirty write 검사를 마친 다음 certificate의 array/reference work에서 snapshot을 바꾼다.
  const mutatingWork = Object.assign(() => {
    if (active && ++calls === context.index.mutations.length + 1) mutations[mutations.indexOf(record)] = changed;
  }, { observe: work.observe, require: work.require });
  const observed = completeSterileConfinement(current, result.value, mutatingWork);
  active = true;
  assert.equal(isMutationCleanView(current, { confinement: observed }), false);
  assert.ok(calls > context.index.mutations.length + 1, 'final record scan must run after the array guard');
  mutations[mutations.indexOf(changed)] = record;
  const literal = [...result.value.literals!.values()][0]!;
  const arrayBinding = [...literal.bindings][0]!;
  assert.equal(certificate.array(safety, arrayBinding), true);
  const symbol = context.checker.getSymbolAtLocation(arrayBinding.name)!;
  const references = context.index.references as Map<ts.Symbol, readonly ts.Node[]>;
  const original = references.get(symbol)!;
  references.set(symbol, [...original, record.value!]);
  assert.equal(certificate.array(safety, arrayBinding), false, 'unmatched reference without a mutation record rejects');
  references.set(symbol, original);
  const foreignCertificate = completeSterileConfinement(foreign, result.value, work);
  assert.equal(foreignCertificate.array(foreign, arrayBinding), false, 'foreign index cannot mint completed authority');
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
