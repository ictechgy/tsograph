/** Stage3는 실제 독립 inventory와 graph 경계에서 singleton authority를 검증한다. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { ConstructorCarrierAnalyzer, type ConstructorCarrierContext } from './constructor-carrier.ts';
import { createEffectManifest, hasPrimitiveHelperCandidates, selectEffectManifest } from './effect-inventory.ts';
import { buildFileIndex, mergeFlowIndexes } from './flow-index.ts';
import { auditSingletonCarrier, coversSingletonEffects } from './singleton-carrier.ts';
import type { ProofWork } from './proof-dag.ts';

const carrier = `class Port { send() { return 1; } }
class Controller {
  tick: () => Date;
  constructor(private readonly inputs: { port: Port; tick?: () => Date }) {
    this.tick = inputs.tick ?? (() => new Date());
  }
  run() { this.tick(); return this.inputs.port.send(); }
}
const live = new Port();
const controller = new Controller({ port: live, tick: undefined });
controller.run();`;

/** 공개 합성 파일을 실제 Program과 독립 manifest로 결합한다. */
function indexed(source: string, compilerOptions: ts.CompilerOptions = {}) {
  const options: ts.CompilerOptions = { strict: true, types: [], lib: ['lib.es2022.d.ts'],
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, ...compilerOptions };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile;
  host.getSourceFile = (name, version, onError, fresh) => name === 'main.ts'
    ? ts.createSourceFile(name, source, version, true) : read.call(host, name, version, onError, fresh);
  const program = ts.createProgram({ rootNames: ['main.ts'], options, host });
  const file = program.getSourceFile('main.ts')!;
  const checker = program.getTypeChecker();
  const part = buildFileIndex(checker, file, () => undefined);
  const manifest = createEffectManifest(new Map([[file.fileName, file]]), 'whole', () => undefined, true, undefined, checker);
  const index = { ...mergeFlowIndexes([part], manifest), proofProgram: program, proofDiagnostics: new Set<string>() };
  const declaration = file.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'Controller')!;
  let allocation: ts.NewExpression | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Controller'
      && allocation === undefined) allocation = node;
    ts.forEachChild(node, find);
  };
  find(file);
  assert.ok(allocation);
  const context = { program, checker, index, policy: {
    isProjectFile: (source) => source === file, isOpenCallable: () => false, isOverridden: () => false,
    openProperties: false, isDefaultLibraryFile: (source) => program.isSourceFileDefaultLibrary(source),
  } } satisfies ConstructorCarrierContext;
  return { context, declaration, literal: allocation.arguments![0] as ts.ObjectLiteralExpression };
}

/** 실제 buildCallGraph로 검증하고 직접 생성한 fixture만 정리한다. */
async function graphOf(source: string, extra: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-stage4-')));
  try {
    for (const [path, content] of Object.entries({ 'tsconfig.json': JSON.stringify({ compilerOptions: {
      strict: true, types: [], lib: ['es2022'], target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
    } }), 'src/main.ts': source, ...extra })) {
      mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, createNodeFileSystem());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const helpers = `const captured = "safe";
function identity(value: string) { return value; }
function composed(value: string) { const local = identity(value); const result = identity(captured); return identity(local); }
`;
const positive = helpers + carrier.replace('return 1;', 'return composed("value");') + '\nexport {};';

test('stage4 composed primitive helpers authorize the actual singleton bound endpoint', async () => {
  const graph = await graphOf(positive);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Port.send'
    && edge.to === 'src/main.ts#composed').map((edge) => edge.evidence), ['direct']);
});

/** Stage3 plain sterile class의 명시적 public method도 helper effect를 보존한다. */
test('stage4 public sterile endpoint keeps the actual bound edge', async () => {
  const graph = await graphOf(positive.replace('class Port { send()', 'class Port { public send()'));
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
});

/** wrapper callee와 direct sink는 helper 후보와 ambient isolation을 모두 보수적으로 닫아야 한다. */
test('stage4 wrapped external sink remains an unknown effect', async () => {
  const forms = ['sink()', 'sink(this.inputs)', '(sink)()', 'sink!()', 'sink!(this)', 'sink!(this.inputs)',
    'sink!(unknownValue)', 'sink!(...[])', 'sink!(() => 1)'];
  for (const form of forms) {
    const source = `declare function sink(value?: unknown): void;\n${carrier.replace('return this.inputs.port.send();', `${form}; return this.inputs.port.send();`)}\nexport {};`;
    const { context, declaration } = indexed(source);
    assert.equal(context.index.effectInventory?.enumeration, 'complete', form);
    const hint = hasPrimitiveHelperCandidates(context.index.effectInventory);
    const isolated = new ConstructorCarrierAnalyzer(context).allowsExtendedInstanceIsolation(declaration);
    assert.equal(hint, true, form);
    assert.equal(isolated, false, form);
    const graph = await graphOf(source);
    assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
      && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate'], form);
  }
});

/** property-call local initializer도 helper 후보에서 빠지면 안 된다. */
test('stage4 unknown property call initializer remains an unreviewed effect', async () => {
  const source = `declare const external: { touch(value: unknown): number };\n${carrier.replace(
    'this.tick(); return this.inputs.port.send();',
    'const ignored = external.touch(this.inputs.port); this.tick(); return this.inputs.port.send();')}\nexport {};`;
  const { context, declaration } = indexed(source);
  assert.equal(context.index.effectInventory?.enumeration, 'complete');
  assert.equal(hasPrimitiveHelperCandidates(context.index.effectInventory), true);
  assert.equal(new ConstructorCarrierAnalyzer(context).allowsExtendedInstanceIsolation(declaration), false);
  const graph = await graphOf(source);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
});

/** whole allocation 주변의 값 보존 wrapper도 exact top-level binding을 유지한다. */
test('stage4 wrapped singleton allocation keeps the bound endpoint', async () => {
  const allocation = 'new Controller({ port: live, tick: undefined })';
  for (const wrapped of [allocation, `(${allocation})`, `(${allocation} as Controller)`, `(${allocation})!`]) {
    const source = `${carrier.replace(allocation, wrapped).replace('controller.run();',
      'function invoke(value: Controller, callback: (value: Controller) => void) { return callback(value); }\ninvoke(controller, value => value.run());')}\nexport {};`;
    const graph = await graphOf(source);
    assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
      && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], wrapped);
  }
});

/** helper wrapper 후보와 audited Date receiver wrapper를 구분한다. */
test('stage4 wrapped carrier Date receiver keeps the bound endpoint', async () => {
  for (const call of ['(this.tick)();', '(this.tick as () => Date)();', 'this.tick!();']) {
    const source = `${carrier.replace('this.tick();', call)}\nexport {};`;
    const graph = await graphOf(source);
    assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
      && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], call);
  }
});

/** 가까운 반례에서도 helper의 ordinary direct 간선과 extended gap을 함께 검사한다. */
const negatives: ReadonlyArray<readonly [string, (source: string) => string]> = [
  ['property read', (s) => s.replace('return value;', 'return value.length;')],
  ['element read', (s) => s.replace('return value;', 'return value[0];')],
  ['arithmetic', (s) => s.replace('return value;', 'return value + 1;')],
  ['coercion', (s) => s.replace('return value;', 'return +value;')],
  ['template coercion', (s) => s.replace('return value;', 'return `${value}`;')],
  ['closure', (s) => s.replace('return value;', 'return () => value;')],
  ['nested function', (s) => s.replace('return value;', 'function nested() { return value; } return value;')],
  ['this', (s) => s.replace('return value;', 'return this;')],
  ['arguments', (s) => s.replace('return value;', 'return arguments;')],
  ['scheduling', (s) => s.replace('return value;', 'setTimeout(() => value); return value;')],
  ['async entry', (s) => s.replace('function identity', 'async function identity')],
  ['generator entry', (s) => s.replace('function identity', 'function* identity')],
  ['optional entry', (s) => s.replace('value: string) { return value;', 'value?: string) { return value;')],
  ['default entry', (s) => s.replace('value: string) { return value;', 'value = "default") { return value;')],
  ['destructured entry', (s) => s.replace('value: string) { return value;', '{ value }: any) { return value;')],
  ['rest entry', (s) => s.replace('value: string) { return value;', '...value: string[]) { return value;')],
  ['this parameter', (s) => s.replace('value: string) { return value;', 'this: unknown, value: string) { return value;')],
  ['mutable callee', (s) => s + '\nidentity = composed;'],
  ['escaped callee', (s) => s + '\nconst escaped = identity;'],
  ['callee callback escape', (s) => s + '\nunknownConsumer(identity);'],
  ['declaration merging', (s) => s + '\nnamespace identity { export const value = 1; }'],
  ['overload merging', (s) => s.replace('function identity', 'function identity(value: number): number;\nfunction identity')],
  ['mutable free binding', (s) => s.replace('const captured =', 'let captured =')],
  ['free binding write', (s) => s + '\ncaptured = "changed";'],
  ['mutable local', (s) => s.replace('const local =', 'let local =')],
  ['local write', (s) => s.replace('const result =', 'local = "changed"; const result =')],
  ['parameter write', (s) => s.replace('return value;', 'value = "changed"; return value;')],
  ['forward local', (s) => s.replace('const local = identity(value); const result = identity(captured);', 'const local = identity(result); const result = identity(captured);')],
  ['call before capture initialization', (s) => 'composed("early");\n' + s],
  ['initializer before capture initialization', (s) => 'const early = composed("early");\n' + s],
  ['effectful capture initializer', (s) => s.replace('const captured = "safe";', 'const captured = unknownConsumer();')],
  ['object capture', (s) => s.replace('const captured = "safe";', 'const captured = {};')],
  ['array capture', (s) => s.replace('const captured = "safe";', 'const captured = [];')],
  ['recursive helper', (s) => s.replace('return value;', 'return identity(value);')],
  ['mutual recursion', (s) => s.replace('return value;', 'return composed(value);')],
  ['protected object argument', (s) => s.replace('composed("value")', 'composed(this)')],
  ['containing wrapper argument', (s) => s.replace('composed("value")', 'composed({ value: "value" })')],
  ['callback argument', (s) => s.replace('composed("value")', 'composed(() => "value")')],
  ['spread argument', (s) => s.replace('composed("value")', 'composed(...["value"])')],
  ['unknown argument', (s) => s.replace('composed("value")', 'composed(unknownValue)')],
  ['missing argument', (s) => s.replace('composed("value")', 'composed()')],
  ['extra argument', (s) => s.replace('composed("value")', 'composed("value", "extra")')],
  ['optional call', (s) => s.replace('composed("value")', 'composed?.("value")')],
  ['mutable ambient helper result', (s) => s + '\nlet result = identity("value");'],
  ['ambient result write', (s) => s + '\nconst result = identity("value"); result = "changed";'],
  ['unused endpoint effect', (s) => s.replace('class Port {', 'class Port { unused() { console.log("effect"); }')],
  ['unused endpoint helper effect', (s) => s.replace('class Port {', 'class Port { unused() { return identity({}); }')],
  ['stage5 dependency entry', (s) => s.replace('send() {', 'send(value: string) {')],
  ['stage5 carrier entry', (s) => s.replace('run() {', 'run(value: string) {')],
  ['stage6 container local', (s) => s.replace('const local = identity(value);', 'const local = [value];')],
  ['opaque boundary', (s) => s + '\nconst effect = Reflect.set;'],
  ['reflection boundary', (s) => s + '\nObject.defineProperty(live, "send", { value: () => 2 });'],
];

test('stage4 primitive helper nearest negatives retain candidate targets and limitations', async (t) => {
  for (const [name, change] of negatives) await t.test(name, async () => {
    const graph = await graphOf(change(positive));
    assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
      && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate'], name);
    assert.ok(graph.limitations.some((message) => message.startsWith('carrier-proof:')), name);
    assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Port.send'
      && edge.to === 'src/main.ts#composed').map((edge) => edge.evidence), ['direct'], name);
  });
});

test('stage4 primitive literals, captures, ordered locals and actual carrier effects compose', async (t) => {
  const variants = [
    positive + '\nconst ambient = composed("later"); composed(ambient);',
    positive.replace('const captured = "safe";\n', '').replace('const controller =', 'const captured = "safe";\nconst controller ='),
    positive.replace('const captured = "safe";\n', '').replace('controller.run();', 'const captured = "safe";\ncontroller.run();'),
    positive.replace('return value;', 'return (value as unknown)!;'),
    positive.replace('class Port {', 'class Port { value = identity(1);'),
    positive.replace('run() { this.tick();', 'run() { const first = composed("carrier"); identity(first); this.tick();'),
    positive.replace('class Controller {', 'class Controller { unused() { const value = identity(null); return composed(value); }'),
    positive.replace('const result = identity(captured);', 'const result = identity(captured), next = identity(result);'),
    positive.replace('return value;', 'const first = value; const second = identity(captured); return first;').replace('const second = identity(captured);', 'const second = captured;'),
    positive.replace('return value;', 'return;'),
    positive.replace('const captured = "safe";', 'const captured = undefined;'),
    positive.replace('composed("value")', 'composed(123n)'),
    positive.replace('composed("value")', 'composed(true)'),
    positive.replace('composed("value")', 'composed(null)'),
    positive.replace('const captured = "safe";', 'const captured = identity("safe");'),
  ];
  for (const [i, source] of variants.entries()) await t.test(`variant ${i}`, async () => {
    const graph = await graphOf(source);
    assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
      && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
  });
});

test('stage4 static imported alias has independent manifests and ordered module captures', async () => {
  const source = 'import { composed as helper } from "./helpers.js";\n' + carrier.replace('return 1;', 'return helper("value");') + '\nexport {};';
  const extra = { 'src/helpers.ts': helpers.replace('function composed', 'export function composed') };
  const graph = await graphOf(source, extra);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Port.send'
    && edge.to === 'src/helpers.ts#composed').map((edge) => edge.evidence), ['direct']);
  const early = await graphOf(source, { 'src/helpers.ts': 'composed("early");\n' + extra['src/helpers.ts'] });
  assert.deepEqual(early.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
  const cycle = await graphOf(source, { 'src/helpers.ts': 'import "./main.js";\n' + extra['src/helpers.ts'] });
  assert.deepEqual(cycle.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
});

/** default import도 named import와 같은 canonical helper target과 초기화 순서를 소비한다. */
test('stage4 default imported helper composes through the actual graph', async () => {
  const source = 'import helper from "./helpers.js";\n' + carrier.replace('return 1;', 'return helper("value");') + '\nexport {};';
  const extra = { 'src/helpers.ts': helpers.replace('function composed', 'export default function composed') };
  const graph = await graphOf(source, extra);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Port.send'
    && edge.to === 'src/helpers.ts#composed').map((edge) => edge.evidence), ['direct']);
  const written = await graphOf(`${source}\nhelper = helper as any;`, extra);
  assert.deepEqual(written.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
});

test('stage4 wrapped capture reads still require provenance and initialization', async () => {
  const source = carrier.replace('return 1;', 'return (captured as string);') + '\nconst captured = "late";\nexport {};';
  const graph = await graphOf(source);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
});

/** actual graph가 쓰는 같은 analyzer entry에서 cold/warm work·current policy·abort cleanup을 검증한다. */
test('stage4 real composed summaries replay equal work, depth, frames and caller interruption', () => {
  const { context, declaration, literal } = indexed(positive);
  assert.equal(context.index.effectInventory?.enumeration, 'complete');
  assert.equal(context.index.effectInventory?.referenceAliases, 'complete');
  const sentinel = new Error('synthetic stage4 caller interruption');
  let limit = Infinity, steps = 0, events: string[] = [];
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
    step: () => { events.push('step'); if (++steps > limit) throw sentinel; },
    check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
  } });
  const run = (budget: number, bag = false) => {
    limit = budget; steps = 0; events = [];
    analyzer.beginQuery();
    try {
      return { value: bag ? analyzer.isolatesExtendedBag(declaration, literal) : analyzer.allowsExtendedInstanceIsolation(declaration),
        steps, events: [...events], aborted: false };
    } catch (error) {
      assert.equal(error, sentinel);
      return { value: false, steps, events: [...events], aborted: true };
    } finally { analyzer.endQuery(); }
  };
  const cold = run(Infinity);
  assert.equal(cold.value, true);
  assert.deepEqual(run(Infinity), cold);
  assert.equal(run(Infinity, true).value, true);
  assert.deepEqual(run(Infinity), cold);
  // 모든 budget prefix는 기존 Stage2 테스트로 보호하고 실제 helper의 각 계층과 마지막 경계를 함께 검증한다.
  const budgets = new Set([0, 1, 2, cold.steps - 1, cold.steps, cold.steps + 1]);
  for (let i = 1; i < 24; i++) budgets.add(Math.floor(cold.steps * i / 24));
  for (const budget of budgets) {
    const { context: freshContext, declaration: freshDeclaration } = indexed(positive);
    let freshSteps = 0;
    const freshEvents: string[] = [];
    const fresh = new ConstructorCarrierAnalyzer({ ...freshContext, caller: {
      step: () => { freshEvents.push('step'); if (++freshSteps > budget) throw sentinel; },
      check: (depth, frames) => { freshEvents.push(`check:${depth}:${frames}`); },
    } });
    fresh.beginQuery();
    let aborted = false, value = false;
    try { value = fresh.allowsExtendedInstanceIsolation(freshDeclaration); }
    catch (error) { assert.equal(error, sentinel); aborted = true; }
    finally { fresh.endQuery(); }
    assert.deepEqual(run(budget), { value, steps: freshSteps, events: freshEvents, aborted }, `budget ${budget}`);
    assert.equal(run(Infinity).value, true);
  }
});

test('stage4 helper policy is checked on warm entries and unexpected RangeError propagates', () => {
  const { context, declaration } = indexed(positive);
  let open = false, fail = false;
  const error = new RangeError('synthetic unexpected helper policy failure');
  const policy = { ...context.policy, isOpenCallable: (node: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'identity') {
      if (fail) throw error;
      return open;
    }
    return false;
  } };
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, policy });
  const run = () => {
    analyzer.beginQuery();
    try { return analyzer.allowsExtendedInstanceIsolation(declaration); }
    finally { analyzer.endQuery(); }
  };
  assert.equal(run(), true);
  open = true; assert.equal(run(), false);
  assert.ok([...context.index.proofDiagnostics].some((message) => message.includes('incomplete(entry)')));
  open = false; fail = true; assert.throws(run, (value) => value === error);
  fail = false; assert.equal(run(), true);
});

test('stage4 helper recursion is cycle, not a cached semantic rejection or legacy fallback', () => {
  const { context, declaration } = indexed(positive.replace('return value;', 'return identity(value);'));
  const analyzer = new ConstructorCarrierAnalyzer(context);
  for (let i = 0; i < 2; i++) {
    analyzer.beginQuery();
    try { assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false); }
    finally { analyzer.endQuery(); }
  }
  assert.deepEqual([...context.index.proofDiagnostics], ['carrier-proof: cycle; carrier proof was not completed.']);
});

test('stage4 charged helper construction exhausts at the unchanged cap with one diagnostic', () => {
  const locals = Array.from({ length: 3_000 }, (_, index) => `const value${index} = "safe";`).join('\n');
  const { context, declaration } = indexed(positive.replace('return value;', `${locals}\nreturn value;`));
  assert.equal(context.index.effectInventory?.enumeration, 'complete');
  const analyzer = new ConstructorCarrierAnalyzer(context);
  for (let i = 0; i < 2; i++) {
    analyzer.beginQuery();
    try { assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false); }
    finally { analyzer.endQuery(); }
  }
  assert.deepEqual([...context.index.proofDiagnostics], ['carrier-proof: exhausted; carrier proof was not completed.']);
});

/** large sterile model merge도 caller work와 warm replay에 포함한다. */
test('stage4 large sterile model merge scales and recovers warm', () => {
  const methodCount = 500;
  const methods = Array.from({ length: methodCount }, (_, index) => `unused${index}() { return ${index}; }`).join('\n');
  const source = positive.replace('class Port {', `class Port {\n${methods}`);
  const measure = (input: string): { value: boolean; steps: number; events: readonly string[] } => {
    const { context, declaration } = indexed(input);
    let steps = 0;
    const events: string[] = [];
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { steps++; events.push('step'); },
      check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
    } });
    analyzer.beginQuery();
    try { return { value: analyzer.allowsExtendedInstanceIsolation(declaration), steps, events: [...events] }; }
    finally { analyzer.endQuery(); }
  };
  const small = measure(positive);
  const large = measure(source);
  assert.equal(small.value, true);
  assert.equal(large.value, true);
  assert.ok(large.steps > small.steps + methodCount * 20, `${small.steps} -> ${large.steps}`);
  const { context, declaration } = indexed(source);
  let steps = 0;
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
    step: () => { steps++; }, check: () => {},
  } });
  analyzer.beginQuery();
  try {
    assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), true);
  } finally { analyzer.endQuery(); }
  const warmSteps = steps;
  steps = 0; analyzer.beginQuery();
  try { assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), true); }
  finally { analyzer.endQuery(); }
  assert.equal(steps, warmSteps);
});

/** 깊은 wrapper의 expression read가 첫 normalizer work 뒤에 일어나고 warm에는 재읽지 않는지 본다. */
test('stage4 deep wrapper normalization charges physical reads before inspection', () => {
  const wrappedCall = `${'('.repeat(80)}identity(local)${')'.repeat(80)}`;
  const source = positive.replace('return identity(local);', `return ${wrappedCall};`);
  const { context, declaration } = indexed(source);
  const wrappers: ts.Expression[] = [];
  let expression: ts.Expression | undefined;
  const find = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined && expression === undefined) expression = node.expression;
    ts.forEachChild(node, find);
  };
  const helper = declaration.getSourceFile().statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'composed');
  assert.ok(helper);
  find(helper);
  assert.ok(expression);
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
    wrappers.push(current); current = current.expression;
  }
  assert.ok(wrappers.length >= 80);
  let reads = 0;
  const originals = wrappers.map((wrapper) => {
    const descriptor = Object.getOwnPropertyDescriptor(wrapper, 'expression')!;
    Object.defineProperty(wrapper, 'expression', { configurable: true, enumerable: descriptor.enumerable ?? false,
      get: () => { reads++; return descriptor.value; } });
    return { wrapper, descriptor };
  });
  try {
    const run = (warm: boolean, limit: number) => {
      const sentinel = new Error('wrapper normalizer interruption');
      let activeLimit = Number.POSITIVE_INFINITY;
      let steps = 0;
      let events: string[] = [];
      const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
        step: () => { events.push('step'); if (++steps > activeLimit) throw sentinel; },
        check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
      } });
      const invoke = (allowance: number) => {
        activeLimit = allowance; steps = 0; events = []; reads = 0;
        analyzer.beginQuery();
        try { return { kind: 'ok' as const, value: analyzer.allowsExtendedInstanceIsolation(declaration), steps, events: [...events], reads }; }
        catch (error) {
          if (error !== sentinel) throw error;
          return { kind: 'abort' as const, value: false, steps, events: [...events], reads };
        } finally { analyzer.endQuery(); }
      };
      if (warm) assert.equal(invoke(Number.POSITIVE_INFINITY).value, true);
      return invoke(limit);
    };
    const full = run(false, Number.POSITIVE_INFINITY);
    assert.equal(full.kind, 'ok'); assert.equal(full.value, true); assert.ok(full.reads >= wrappers.length);
    for (let budget = 0; budget <= full.steps + 1; budget++) {
      const cold = run(false, budget); const warm = run(true, budget);
      assert.equal(warm.kind, cold.kind, `budget ${budget}`);
      assert.equal(warm.value, cold.value, `budget ${budget}`);
      assert.equal(warm.steps, cold.steps, `budget ${budget}`);
      assert.deepEqual(warm.events, cold.events, `budget ${budget}`);
      assert.equal(warm.reads, 0, `warm wrapper read at budget ${budget}`);
      assert.ok(cold.reads <= cold.steps, `wrapper read escaped work at budget ${budget}`);
      if (budget === 0) assert.equal(cold.reads, 0);
    }
  } finally {
    for (const { wrapper, descriptor } of originals) Object.defineProperty(wrapper, 'expression', descriptor);
  }
});

test('stage4 completed negative child work and reversed consumer order replay identically', () => {
  const { context, declaration, literal } = indexed(positive.replace('return value;', 'return value.length;'));
  let events: string[] = [];
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
    step: () => { events.push('step'); }, check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
  } });
  const run = (bag: boolean) => {
    events = []; analyzer.beginQuery();
    try {
      const value = bag ? analyzer.isolatesExtendedBag(declaration, literal) : analyzer.allowsExtendedInstanceIsolation(declaration);
      return { value, events: [...events] };
    } finally { analyzer.endQuery(); }
  };
  const bag = run(true);
  assert.equal(bag.value, false);
  assert.deepEqual(run(true), bag);
  const family = run(false);
  assert.equal(family.value, false);
  assert.deepEqual(run(false), family);
  assert.deepEqual(run(true), bag);
  assert.ok([...context.index.proofDiagnostics].some((message) => message.includes('rejected(primitive-helper)')));
  assert.ok(![...context.index.proofDiagnostics].some((message) => message.includes('exhausted') || message.includes('cycle')));
});

/** raw descriptor 감사와 primitive-effects certificate를 섞지 않는 실제 효과 소비자 검사다. */
test('stage4 descriptor candidates cannot discharge helper effects without the completed summary', () => {
  const { context, declaration } = indexed(carrier.replace('return 1;', 'return captured;').replace('tick: () => Date;', 'readonly tick: () => Date;') + '\nconst captured = "late";\nexport {};');
  const proof = new ConstructorCarrierAnalyzer(context).prove(declaration);
  assert.ok(proof);
  const work = (() => {}) as ProofWork;
  const witness = auditSingletonCarrier(context, proof, work, {
    project: (file) => file === declaration.getSourceFile(), open: () => false,
    intrinsic: (file) => context.program!.isSourceFileDefaultLibrary(file),
  });
  assert.ok(witness);
  assert.equal(coversSingletonEffects(context, witness, work), false);
  assert.ok([...witness.models.values()].includes('primitive-helper-pending'));
});

test('stage4 inventory candidate hints bind real authoritative identities and selected views', () => {
  const plain = indexed(carrier + '\nexport {};');
  const primitive = indexed(positive);
  assert.equal(hasPrimitiveHelperCandidates(plain.context.index.effectInventory), false);
  assert.equal(hasPrimitiveHelperCandidates(primitive.context.index.effectInventory), true);
  assert.equal(hasPrimitiveHelperCandidates(undefined), true);
  assert.equal(hasPrimitiveHelperCandidates({ ...plain.context.index.effectInventory! }), true);
  const manifest = plain.context.index.effectInventory!.manifest;
  const source = plain.declaration.getSourceFile();
  const selection = selectEffectManifest(manifest, new Map([[source.fileName, source]]), 'production');
  const part = buildFileIndex(plain.context.checker, source, () => undefined);
  assert.equal(hasPrimitiveHelperCandidates(mergeFlowIndexes([part], selection).effectInventory), false);
  const forged = selectEffectManifest({ ...manifest }, new Map([[source.fileName, source]]), 'production');
  assert.equal(hasPrimitiveHelperCandidates(mergeFlowIndexes([part], forged).effectInventory), true);
});

test('stage4 named re-export aliases preserve exact helper targets and capture initialization', async () => {
  const source = 'import { exposed as helper } from "./barrel.js";\n' + carrier.replace('return 1;', 'return helper("value");') + '\nexport {};';
  const graph = await graphOf(source, {
    'src/helpers.ts': helpers.replace('function composed', 'export function composed'),
    'src/barrel.ts': 'export { composed as exposed } from "./helpers.js";',
  });
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Port.send'
    && edge.to === 'src/helpers.ts#composed').map((edge) => edge.evidence), ['direct']);
});

test('stage4 field helper evaluation uses construction order rather than the later endpoint entry', async () => {
  const source = positive.replace('const captured = "safe";\n', '')
    .replace('class Port {', 'class Port { value = composed("field");')
    .replace('const controller =', 'const captured = "safe";\nconst controller =');
  const graph = await graphOf(source);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
  assert.ok(graph.limitations.some((message) => message.includes('helper-initialization')));
  const safe = await graphOf(source.replace('const captured = "safe";\n', '')
    .replace('const live =', 'const captured = "safe";\nconst live ='));
  assert.deepEqual(safe.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], JSON.stringify(safe.limitations));
});
