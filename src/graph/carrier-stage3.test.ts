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
import { createEffectManifest } from './effect-inventory.ts';
import { buildFileIndex, mergeFlowIndexes } from './flow-index.ts';
import { auditSingletonCarrier, coversSingletonEffects, type SingletonWitness } from './singleton-carrier.ts';
import type { ProofWork } from './proof-dag.ts';

const positive = `class Port { send() { return 1; } }
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
  const context: ConstructorCarrierContext = { program, checker, index, policy: {
    isProjectFile: (source) => source === file, isOpenCallable: () => false, isOverridden: () => false,
    openProperties: false, isDefaultLibraryFile: (source) => program.isSourceFileDefaultLibrary(source),
  } };
  return { context, declaration, literal: allocation.arguments![0] as ts.ObjectLiteralExpression };
}

/** 실제 buildCallGraph로 검증하고 직접 생성한 fixture만 정리한다. */
async function graphOf(source: string, extra: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-stage3-')));
  try {
    for (const [path, content] of Object.entries({ 'tsconfig.json': JSON.stringify({ compilerOptions: {
      strict: true, types: [], lib: ['es2022'], target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
    } }), 'src/main.ts': source, ...extra })) {
      mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, createNodeFileSystem());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('stage3 exact Controller/Port fixture has extended family, bag and actual bound service edge', async () => {
  const { context, declaration, literal } = indexed(positive);
  assert.equal(context.index.effectInventory?.enumeration, 'complete');
  const analyzer = new ConstructorCarrierAnalyzer(context);
  assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), true);
  assert.equal(analyzer.isolatesExtendedBag(declaration, literal), true);
  const graph = await graphOf(`${positive}\nexport {};`);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
});

/** 원 fixture의 가장 가까운 반례를 만들고, graph의 실제 borrowed endpoint를 검사한다. */
const negatives: ReadonlyArray<readonly [string, (source: string) => string]> = [
  ['constructor value alias', (s) => s + '\nconst alias = Controller;'],
  ['dependency constructor alias', (s) => s + '\nconst alias = Port;'],
  ['second controller', (s) => s + '\nconst other = new Controller({ port: live, tick: undefined });'],
  ['second dependency', (s) => s + '\nconst other = new Port();'],
  ['controller factory', (s) => s.replace('const controller = new Controller({ port: live, tick: undefined });',
    'function make() { return new Controller({ port: live, tick: undefined }); }\nconst controller = make();')],
  ['dependency factory', (s) => s.replace('const live = new Port();', 'function make() { return new Port(); }\nconst live = make();')],
  ['memo resets', (s) => s.replace('const controller =', 'let controller =') + '\ncontroller = new Controller({ port: live, tick: undefined });'],
  ['subclass', (s) => s + '\nclass Child extends Controller {}'],
  ['dependency subclass', (s) => s + '\nclass Child extends Port {}'],
  ['controller escape', (s) => s + '\nconsole.log(controller);'],
  ['dependency escape', (s) => s + '\nconsole.log(live);'],
  ['bag alias', (s) => s.replace('new Controller({ port: live, tick: undefined })', 'new Controller(bag)').replace('const controller =', 'const bag = { port: live, tick: undefined };\nconst controller =')],
  ['bag spread', (s) => s.replace('{ port: live, tick: undefined }', '{ ...{ port: live }, tick: undefined }')],
  ['bag duplicate', (s) => s.replace('{ port: live, tick: undefined }', '{ port: live, port: live, tick: undefined }')],
  ['bag accessor', (s) => s.replace('{ port: live, tick: undefined }', '{ get port() { return live; }, tick: undefined }')],
  ['bag prototype setter', (s) => s.replace('{ port: live, tick: undefined }', '{ __proto__: live, port: live, tick: undefined }')],
  ['optional omission', (s) => s.replace('port: live, tick: undefined', 'port: live')],
  ['optional callback effect', (s) => s.replace('tick: undefined', 'tick: () => console.log(live)')],
  ['optional inherited cast', (s) => s.replace('port: live, tick: undefined', 'port: live').replace('new Controller({ port: live })', 'new Controller({ port: live } as any)')],
  ['reversed allocation', (s) => s.replace('const live = new Port();\n', '') + '\nconst live = new Port();'],
  ['class binding forward allocation', (s) => s.replace('class Port { send() { return 1; } }\n', '') + '\nclass Port { send() { return 1; } }'],
  ['call before controller binding', (s) => 'controller.run();\n' + s],
  ['runtime namespace merge', (s) => s + '\nnamespace Controller { export const x = 1; }'],
  ['runtime enum merge', (s) => s + '\nenum Controller { x }'],
  ['dependency namespace merge', (s) => s + '\nnamespace Port { export const x = 1; }'],
  ['CJS value export', (s) => s + '\nmodule.exports = Controller;'],
  ['CJS require', (s) => s + '\nconst other = require("other");'],
  ['import equals', (s) => s + '\nimport other = require("other");'],
  ['constructor binding write', (s) => s + '\nController = Port as any;'],
  ['dependency binding write', (s) => s + '\nlive = new Port();'],
  ['endpoint write', (s) => s + '\nlive.send = () => 2;'],
  ['borrowed endpoint', (s) => s + '\nconst borrowed = live.send;'],
  ['prototype lookup', (s) => s + '\nconst proto = Port.prototype;'],
  ['known reflection', (s) => s + '\nObject.defineProperty(live, "send", { value: () => 2 });'],
  ['controller known reflection', (s) => s + '\nReflect.set(controller, "tick", () => new Date());'],
  ['opaque reflection', (s) => s + '\nconst key = console.log; (live as any).__defineGetter__(key, () => 1);'],
  ['dependency effect', (s) => s.replace('return 1;', 'console.log("effect"); return 1;')],
  ['unused dependency effect', (s) => s.replace('class Port {', 'class Port { unused() { console.log("effect"); }')],
  ['unused dependency parameter', (s) => s.replace('class Port {', 'class Port { unused(value: number) { return 1; }')],
  ['unused dependency async', (s) => s.replace('class Port {', 'class Port { async unused() { return 1; }')],
  ['dependency default entry', (s) => s.replace('send()', 'send(value = console.log("effect"))')],
  ['dependency rest entry', (s) => s.replace('send()', 'send(...values: number[])')],
  ['dependency generator', (s) => s.replace('send()', '*send()')],
  ['dependency constructor parameters', (s) => s.replace('class Port {', 'class Port { constructor(value = 1) {}')],
  ['dependency constructor body', (s) => s.replace('class Port {', 'class Port { constructor() { console.log("effect"); }')],
  ['dependency replacement return', (s) => s.replace('class Port {', 'class Port { constructor() { return {} as any; }')],
  ['dependency getter', (s) => s.replace('send() { return 1; }', 'get send() { return () => 1; }')],
  ['dependency field effect', (s) => s.replace('class Port {', 'class Port { value = console.log("effect");')],
  ['dependency field object', (s) => s.replace('class Port {', 'class Port { value = {};')],
  ['dependency field duplicate', (s) => s.replace('class Port {', 'class Port { value = 1; value = 2;')],
  ['dependency static evaluation', (s) => s.replace('class Port {', 'class Port { static value = 1;')],
  ['dependency static block', (s) => s.replace('class Port {', 'class Port { static {}')],
  ['dependency inheritance', (s) => s.replace('class Port {', 'class Base {}\nclass Port extends Base {')],
  ['dependency computed descriptor', (s) => s.replace('send() { return 1; }', '["send"]() { return 1; }')],
  ['dependency slot collision', (s) => s.replace('class Port {', 'class Port { send = 1;')],
  ['controller entry default', (s) => s.replace('run()', 'run(value = console.log(this))')],
  ['controller field collision', (s) => s.replace('tick: () => Date;', 'tick: () => Date; tick: () => Date;')],
  ['controller field initializer', (s) => s.replace('tick: () => Date;', 'tick = () => new Date();')],
  ['controller static evaluation', (s) => s.replace('class Controller {', 'class Controller { static value = 1;')],
  ['ambient effect', (s) => s + '\nconsole.log("effect");'],
  ['Date invalidation', (s) => s + '\nDate = Port as any;'],
  ['dependency decorator', (s) => 'declare function decorate(value: unknown): void;\n' + s.replace('class Port {', '@decorate class Port {')],
  ['dependency method decorator', (s) => 'declare function decorate(...value: unknown[]): void;\n' + s.replace('send() {', '@decorate send() {')],
  ['dependency field decorator', (s) => 'declare function decorate(...value: unknown[]): void;\n' + s.replace('class Port {', 'class Port { @decorate value = 1;')],
  ['dependency accessor field', (s) => s.replace('class Port {', 'class Port { accessor value = 1;')],
  ['dependency computed field', (s) => s.replace('class Port {', 'class Port { ["value"] = 1;')],
  ['dependency private field', (s) => s.replace('class Port {', 'class Port { #value = 1;')],
  ['dependency then slot', (s) => s.replace('class Port {', 'class Port { then() { return 1; }')],
  ['controller decorator', (s) => 'declare function decorate(value: unknown): void;\n' + s.replace('class Controller {', '@decorate class Controller {')],
  ['unresolved class use', (s) => s + '\nunknownConsumer(Controller);'],
  ['delayed factory alias', (s) => s.replace('const controller =', 'const now = () => new Date();\nconst controller =').replace('tick: undefined', 'tick: now')],
  ['function alias before initialization', (s) => 'read();\n' + s.replace('controller.run();', 'const read = () => controller.run();')],
  ['function binding write', (s) => s.replace('controller.run();', 'const read = () => controller.run();\nread = () => 1;')],
  ['function escape', (s) => s.replace('controller.run();', 'const read = () => controller.run();\nunknownConsumer(read);')],
];

test('stage3 singleton census, ordering, descriptors and every unused endpoint fail closed', async (t) => {
  for (const [label, edit] of negatives) {
    await t.test(label, async () => {
      const source = edit(positive);
      const { context, declaration, literal } = indexed(source);
      const analyzer = new ConstructorCarrierAnalyzer(context);
      assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false, label);
      assert.equal(analyzer.isolatesExtendedBag(declaration, literal), false, label);
      const graph = await graphOf(`${source}\nexport {};`);
      // 반복 allocation과 누락 optional의 독립 service identity는 Stage0가 이미 증명한다.
      const independent = ['second controller', 'optional omission', 'optional inherited cast'].includes(label);
      const serviceEvidence = graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
        && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence);
      if (['dependency computed descriptor', 'dependency decorator', 'dependency method decorator'].includes(label)) {
        assert.deepEqual(serviceEvidence, [], label);
        assert.ok((graph.nodes.find((node) => node.id === 'src/main.ts#Controller.run')?.unresolvedCalls?.bound ?? 0) > 0);
      } else assert.deepEqual(serviceEvidence, [independent ? 'bound' : 'candidate'], label);
      if (label.startsWith('optional ') && independent) {
        assert.equal(graph.edges.some((edge) => edge.from === 'src/main.ts#Controller.run'
          && edge.to !== 'src/main.ts#Port.send' && edge.evidence === 'bound'), false, label);
      }
    });
  }
});

test('stage3 sterile dependency primitive fields, empty constructor and unused methods are admitted', async (t) => {
  for (const addition of ['constructor() {}', 'value = 1;', 'value = true;', 'value = "ok";', 'value = null;', 'unused() {}', 'unused() { return; }']) {
    await t.test(addition, async () => {
      const source = positive.replace('class Port {', `class Port { ${addition}`);
      const { context, declaration } = indexed(source);
      assert.equal(new ConstructorCarrierAnalyzer(context).allowsExtendedInstanceIsolation(declaration), true);
      const graph = await graphOf(`${source}\nexport {};`);
      assert.ok(graph.edges.some((edge) => edge.from === 'src/main.ts#Controller.run'
        && edge.to === 'src/main.ts#Port.send' && edge.evidence === 'bound'));
    });
  }
});

test('stage3 imported value initialization is deferred even with an acyclic runtime graph', async () => {
  const graph = await graphOf(positive.replace('class Port { send() { return 1; } }', 'import { Port, live } from "./port";')
    .replace('const live = new Port();', ''), { 'src/port.ts': 'export class Port { send() { return 1; } }\nexport const live = new Port();' });
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/port.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
});

test('stage3 repeated allocations keep ordinary target unions without singleton authority', async () => {
  const source = positive.replace('class Port {', 'interface Sink { send(): number; }\nclass Second { send() { return 2; } }\nclass Port {')
    .replace('port: Port;', 'port: Sink;')
    .replace('controller.run();', 'const second = new Controller({ port: new Second(), tick: undefined });\ncontroller.run(); second.run();');
  const { context, declaration, literal } = indexed(source);
  const analyzer = new ConstructorCarrierAnalyzer(context);
  assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false);
  assert.equal(analyzer.isolatesExtendedBag(declaration, literal), false);
  const graph = await graphOf(`${source}\nexport {};`);
  for (const name of ['Port.send', 'Second.send']) {
    assert.ok(graph.edges.some((edge) => edge.from === 'src/main.ts#Controller.run'
      && edge.to === `src/main.ts#${name}` && edge.evidence === 'bound'), name);
  }
});

test('stage3 family and bag real cold/warm work and analyzer query order are identical', () => {
  for (const source of [positive, positive.replace('return 1;', 'console.log("effect"); return 1;')]) {
    const { context, declaration, literal } = indexed(source);
    const traces: string[][] = [];
    let trace: string[] = [];
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { trace.push('step'); }, check: (depth, frames) => { trace.push(`${depth}:${frames}`); },
    } });
    const run = (bag: boolean): boolean => {
      trace = []; analyzer.beginQuery();
      try { return bag ? analyzer.isolatesExtendedBag(declaration, literal) : analyzer.allowsExtendedInstanceIsolation(declaration); }
      finally { analyzer.endQuery(); traces.push(trace); }
    };
    const expected = source === positive;
    assert.equal(run(false), expected); assert.equal(run(false), expected);
    assert.deepEqual(traces[0], traces[1]);
    assert.equal(run(true), expected); assert.equal(run(true), expected);
    assert.deepEqual(traces[2], traces[3]);
    const reversed = new ConstructorCarrierAnalyzer(context);
    assert.equal(reversed.isolatesExtendedBag(declaration, literal), expected);
    assert.equal(reversed.allowsExtendedInstanceIsolation(declaration), expected);
  }
});

/** 충분한 warm cache도 interrupted caller의 ordered step/depth/frame prefix를 바꾸지 않는다. */
test('stage3 cold and warm interruption prefixes have identical caller events', () => {
  const { context, declaration } = indexed(positive);
  type Trace = { readonly kind: 'ok' | 'abort'; readonly value: boolean; readonly events: readonly string[]; readonly steps: number };
  const run = (warm: boolean, limit: number): Trace => {
    const abort = new Error('stage3 synthetic caller interruption');
    let steps = 0;
    let activeLimit = Number.POSITIVE_INFINITY;
    let events: string[] = [];
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { events.push('step'); if (++steps > activeLimit) throw abort; },
      check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
    } });
    const invoke = (budget: number): Trace => {
      activeLimit = budget; steps = 0; events = [];
      analyzer.beginQuery();
      try {
        return { kind: 'ok', value: analyzer.allowsExtendedInstanceIsolation(declaration), events: [...events], steps };
      } catch (error) {
        if (error !== abort) throw error;
        return { kind: 'abort', value: false, events: [...events], steps };
      } finally { analyzer.endQuery(); }
    };
    if (warm) assert.equal(invoke(Number.POSITIVE_INFINITY).value, true);
    return invoke(limit);
  };
  const full = run(false, Number.POSITIVE_INFINITY);
  assert.equal(full.kind, 'ok');
  for (let budget = 0; budget <= full.steps + 1; budget++) {
    const cold = run(false, budget);
    const warm = run(true, budget);
    assert.equal(warm.kind, cold.kind, `budget ${budget}`);
    assert.equal(warm.value, cold.value, `budget ${budget}`);
    assert.deepEqual(warm.events, cold.events, `budget ${budget}`);
    assert.equal(warm.steps, cold.steps, `budget ${budget}`);
  }
});

test('stage3 abort cleanup, unexpected RangeError, coverage and exhausted diagnostics stay distinct', () => {
  const { context, declaration, literal } = indexed(positive);
  const diagnostics = new Set<string>();
  let calls = 0;
  let interrupt = true;
  const failure = new RangeError('synthetic interrupted construction');
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, index: { ...context.index, proofDiagnostics: diagnostics },
    caller: { step: () => { if (interrupt && ++calls === 30) throw failure; }, check: () => {} } });
  assert.throws(() => analyzer.isolatesExtendedBag(declaration, literal), (error) => error === failure);
  assert.equal(diagnostics.size, 0);
  interrupt = false;
  assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), true);
  assert.equal(analyzer.isolatesExtendedBag(declaration, literal), true);
  const incomplete = new ConstructorCarrierAnalyzer({ ...context, index: { ...context.index,
    effectInventory: undefined, proofDiagnostics: diagnostics } });
  assert.equal(incomplete.allowsExtendedInstanceIsolation(declaration), false);
  assert.ok([...diagnostics].some((line) => line.includes('incomplete(coverage)')));
  assert.equal([...diagnostics].some((line) => line.includes('exhausted')), false);
  const large = indexed(positive.replace('class Port {', `class Port { ${Array.from({ length: 3500 }, (_, n) => `field${n} = 1;`).join('\n')}`));
  assert.equal(new ConstructorCarrierAnalyzer(large.context).allowsExtendedInstanceIsolation(large.declaration), false);
  // 실제 독립 inventory는 build cap 안에서 완료되고, query의 고정 20k 상한만 소진한다.
  assert.equal(large.context.index.effectInventory?.enumeration, 'complete');
  assert.equal([...large.context.index.proofDiagnostics!].filter((line) => line.includes('exhausted')).length, 1);
  assert.equal([...large.context.index.proofDiagnostics!].some((line) => line.includes('rejected')), false);
});

test('stage3 real graph statement query order keeps extended success and failed dependencies stable', async () => {
  for (const source of [positive, positive.replace('return 1;', 'console.log("effect"); return 1;')]) {
    const withSecond = source.replace('  run() {', '  another() { this.tick(); return this.inputs.port.send(); }\n  run() {');
    const first = await graphOf(`${withSecond.replace('controller.run();', 'controller.run(); controller.another();')}\nexport {};`);
    const second = await graphOf(`${withSecond.replace('controller.run();', 'controller.another(); controller.run();')}\nexport {};`);
    const targets = (graph: typeof first) => graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
      && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence);
    assert.deepEqual(targets(first), targets(second));
    assert.deepEqual(targets(first), [source === positive ? 'bound' : 'candidate']);
  }
});

test('stage3 modifier spelling never substitutes for endpoint effects or isolation', async () => {
  for (const modifier of ['', 'readonly ', 'private ', 'private readonly ', 'public ']) {
    for (const effectful of [false, true]) {
      const source = positive.replace('  tick:', `  ${modifier}tick:`)
        .replace('return 1;', effectful ? 'console.log("effect"); return 1;' : 'return 1;');
      const { context, declaration } = indexed(source);
      assert.equal(new ConstructorCarrierAnalyzer(context).allowsExtendedInstanceIsolation(declaration), !effectful);
      const graph = await graphOf(`${source}\nexport {};`);
      assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
        && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), [effectful ? 'candidate' : 'bound']);
    }
  }
});

test('stage3 canonical private own-index and own-data writes keep their existing named model', async () => {
  for (const scratch of ['const scratch = [0]; scratch[0] = 1;',
    'const scratch = { value: 0 }; scratch.value = 1;',
    'const scratch = [0]; const key = 0; scratch[key] = 1;']) {
    const source = `${positive}\n${scratch}`;
    const { context, declaration } = indexed(source);
    assert.equal(new ConstructorCarrierAnalyzer(context).allowsExtendedInstanceIsolation(declaration), true);
    const graph = await graphOf(`${source}\nexport {};`);
    assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
      && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['bound']);
  }
});

test('stage3 closed static export aliases reconcile, runtime cycles lose initialization authority', async () => {
  const exported = `${positive}\nexport { Controller as Renamed };`;
  const closed = await graphOf(exported, { 'src/consumer.ts': 'import type { Renamed } from "./main";\nexport type Selected = Renamed;' });
  assert.ok(closed.edges.some((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send' && edge.evidence === 'bound'));
  const aliased = await graphOf(exported, { 'src/consumer.ts': 'import { Renamed as LocalName } from "./main";\nexport {};' });
  assert.ok(aliased.edges.some((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send' && edge.evidence === 'bound'));
  const cyclic = await graphOf(`import "./consumer";\n${exported}`, { 'src/consumer.ts': 'import "./main";\nexport {};' });
  assert.deepEqual(cyclic.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
});

test('stage3 authoritative missing and duplicate parts cannot issue new family or bag authority', () => {
  const { context, declaration, literal } = indexed(positive);
  const file = declaration.getSourceFile();
  const manifest = createEffectManifest(new Map([[file.fileName, file]]), 'whole', () => undefined, true, undefined, context.checker);
  const part = buildFileIndex(context.checker, file, () => undefined);
  for (const parts of [[], [part, part]]) {
    const index = { ...mergeFlowIndexes(parts, manifest), proofProgram: context.program! };
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, index });
    assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false);
    assert.equal(analyzer.isolatesExtendedBag(declaration, literal), false);
  }
});

test('stage3 failed borrowed dependency family does not manufacture endpoint ownership or retry legacy', () => {
  const unsafe = positive.replace('return 1;', 'console.log("effect"); return 1;');
  const { context, declaration } = indexed(unsafe);
  const port = declaration.getSourceFile().statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'Port')!;
  const analyzer = new ConstructorCarrierAnalyzer(context);
  assert.equal(analyzer.allowsExtendedDependencyIsolation(port), false);
  assert.equal(analyzer.allowsUnknownReflectionIsolation(port), false);
  assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false);
  const safe = indexed(positive);
  const safePort = safe.declaration.getSourceFile().statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'Port')!;
  const safeAnalyzer = new ConstructorCarrierAnalyzer(safe.context);
  assert.equal(safeAnalyzer.allowsExtendedDependencyIsolation(safePort), true);
  assert.equal(safeAnalyzer.allowsExtendedInstanceIsolation(safePort), false);
  assert.equal(safeAnalyzer.allowsExtendedDependencyIsolation(port), false);
});

test('stage3 current source dependency guards reject stale cached revisions and recover after restoration', () => {
  const { context, declaration, literal } = indexed(positive);
  const analyzer = new ConstructorCarrierAnalyzer(context);
  assert.equal(analyzer.isolatesExtendedBag(declaration, literal), true);
  const file = declaration.getSourceFile();
  const text = file.text;
  file.text = `${text}\nconsole.log("stale");`;
  try { assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false); }
  finally { file.text = text; }
  assert.equal(analyzer.isolatesExtendedBag(declaration, literal), true);
});

test('stage3 graph budget exhaustion keeps one diagnostic and candidate endpoint', async () => {
  const source = positive.replace('class Port {', `class Port { ${Array.from({ length: 3500 }, (_, n) => `field${n} = 1;`).join('\n')}`);
  const graph = await graphOf(`${source}\nexport {};`);
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map((edge) => edge.evidence), ['candidate']);
  assert.equal(graph.limitations.filter((line) => line.startsWith('dispatch-budget:')).length, 1);
  assert.equal(graph.limitations.some((line) => line.includes('inventory') && line.includes('build-cap')), false);
});

/** extended-selection의 모든 선언·매개변수 witness가 caller 회계에 들어가는지 측정한다. */
test('stage3 extended selection charges large member and parameter scans', () => {
  const sourceFor = (members: number, parameters: number): string => {
    const methods = Array.from({ length: members }, (_, index) => `m${index}() {}` ).join('\n');
    const ordinary = Array.from({ length: parameters }, (_, index) => `p${index}: number`).join(', ');
    const parametersText = ordinary.length === 0 ? 'private readonly inputs: { value: number }'
      : `${ordinary}, private readonly inputs: { value: number }`;
    return `class Controller {\n${methods}\nconstructor(${parametersText}) {}\n}\nconst controller = new Controller({ value: 1 });`;
  };
  const measure = (members: number, parameters: number): { value: boolean; steps: number } => {
    const { context, declaration } = indexed(sourceFor(members, parameters));
    let steps = 0;
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { steps++; }, check: () => {},
    } });
    analyzer.beginQuery();
    try { return { value: analyzer.selectsExtendedFlow(declaration), steps }; }
    finally { analyzer.endQuery(); }
  };
  const baseline = measure(0, 0);
  const largeMembers = measure(1_000, 0);
  const largeParameters = measure(0, 1_000);
  assert.equal(baseline.value, true);
  assert.equal(largeMembers.value, true);
  assert.equal(largeParameters.value, true);
  assert.ok(largeMembers.steps > baseline.steps + 900, `${baseline.steps} -> ${largeMembers.steps}`);
  assert.ok(largeParameters.steps > baseline.steps + 900, `${baseline.steps} -> ${largeParameters.steps}`);
});

/** service lookup의 201×201 witness가 숨은 무과금 quadratic이 되지 않는지 확인한다. */
test('stage3 service endpoint lookup charges examined work before the fixed query cap', () => {
  const sourceFor = (count: number): string => {
    const members = Array.from({ length: count }, (_, index) => `m${index}() { return ${index}; }`).join('\n');
    const methods = Array.from({ length: count }, (_, index) => `run${index}() { return this.inputs.port.m${index}(); }`).join('\n');
    return `class Port { ${members} }\nclass Controller {\nconstructor(private readonly inputs: { port: Port }) {}\n${methods}\n}\nconst live = new Port();\nconst controller = new Controller({ port: live });\ncontroller.run0();`;
  };
  const measure = (count: number): { value: boolean; steps: number } => {
    const { context, declaration } = indexed(sourceFor(count));
    let steps = 0;
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { steps++; }, check: () => {},
    } });
    analyzer.beginQuery();
    try { return { value: analyzer.allowsExtendedInstanceIsolation(declaration), steps }; }
    finally { analyzer.endQuery(); }
  };
  const small = measure(1);
  const large = measure(201);
  assert.equal(small.value, true);
  assert.equal(large.value, true);
  assert.ok(large.steps > small.steps + 300, `unaccounted endpoint work: ${small.steps} -> ${large.steps}`);
  assert.ok(large.steps < 20_000, `unexpected quadratic lookup: ${small.steps} -> ${large.steps}`);
});

/** 실제 Stage0 descriptor와 독립 inventory로 동일한 singleton 감사 witness를 만든다. */
function audited(source: string) {
  const { context, declaration } = indexed(source);
  const proof = new ConstructorCarrierAnalyzer(context).prove(declaration);
  assert.ok(proof);
  const work = (() => {}) as ProofWork;
  const policy = {
    project: (file: ts.SourceFile) => file === declaration.getSourceFile(),
    open: () => false,
    intrinsic: (file: ts.SourceFile) => context.program!.isSourceFileDefaultLibrary(file),
  };
  const witness = auditSingletonCarrier(context, proof, work, policy);
  assert.ok(witness);
  return { context, declaration, proof, work, policy, witness };
}

/** 실제 witness의 특정 site 하나만 바꿔 model 호환성 거부의 원인을 고립한다. */
test('stage3 actual witness preserves Date and sterile models and rejects one mismatched call', () => {
  // 기존 descriptor API를 사용하기 위한 readonly 표기이며 효과 모델의 실행 문법은 같다.
  const { context, work, witness } = audited(positive.replace('tick: () => Date;', 'readonly tick: () => Date;'));
  const records = context.index.effectInventory!.records;
  const recordAt = (operation: string, text: string) => {
    const record = records.find((value) => value.operation === operation && value.site.getText() === text);
    assert.ok(record, `${operation}: ${text}`);
    return record;
  };
  assert.equal(coversSingletonEffects(context, witness, work), true);
  for (const [operation, text, model] of [
    ['construct', 'new Date()', 'delayed-date'],
    ['entry', '() => new Date()', 'delayed-date'],
    ['entry', 'send() { return 1; }', 'sterile-endpoint'],
    ['call', 'this.inputs.port.send()', 'sterile-endpoint'],
    ['call', 'this.tick()', 'carrier-call'],
  ] as const) assert.equal(witness.models.get(recordAt(operation, text).site), model);
  const target = recordAt('call', 'this.inputs.port.send()');
  const models = new Map(witness.models);
  models.set(target.site, 'delayed-date');
  const mismatched: SingletonWitness = { ...witness, models };
  assert.equal(coversSingletonEffects(context, mismatched, work), false);
  assert.equal(coversSingletonEffects(context, witness, work), true);
});

/** 큰 member census의 cold 검사와 warm 재생은 요소 검사 전에도 같은 budget prefix로 멈춘다. */
test('stage3 large member selection interrupts before inspection with equal cold and warm prefixes', () => {
  const count = 40;
  const source = `class Controller { ${Array.from({ length: count }, (_, index) => `m${index}() {}`).join(' ')} }
const controller = new Controller();`;
  const { context, declaration } = indexed(source);
  let inspections = 0;
  const originals = declaration.members.map((member) => {
    const descriptor = Object.getOwnPropertyDescriptor(member, 'kind')!;
    Object.defineProperty(member, 'kind', { configurable: true, enumerable: descriptor.enumerable!,
      get: () => { inspections++; return descriptor.value; } });
    return { member, descriptor };
  });
  try {
    const run = (warm: boolean, limit: number) => {
      const sentinel = new Error('large census caller interruption');
      let steps = 0;
      let budget = Number.POSITIVE_INFINITY;
      let events: string[] = [];
      const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
        step: () => { events.push('step'); if (++steps > budget) throw sentinel; },
        check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
      } });
      const invoke = (allowance: number) => {
        steps = 0; events = []; inspections = 0; budget = allowance;
        analyzer.beginQuery();
        let aborted = false;
        try { assert.equal(analyzer.selectsExtendedFlow(declaration), false); }
        catch (error) { assert.equal(error, sentinel); aborted = true; }
        finally { analyzer.endQuery(); }
        return { aborted, steps, events: [...events], inspections };
      };
      if (warm) assert.equal(invoke(Number.POSITIVE_INFINITY).aborted, false);
      return invoke(limit);
    };
    const full = run(false, Number.POSITIVE_INFINITY);
    assert.equal(full.steps, count + 4);
    assert.equal(full.inspections, count);
    for (let budget = 0; budget <= full.steps + 1; budget++) {
      const cold = run(false, budget);
      const warm = run(true, budget);
      assert.equal(warm.aborted, cold.aborted, `budget ${budget}`);
      assert.equal(warm.steps, cold.steps, `budget ${budget}`);
      assert.deepEqual(warm.events, cold.events, `budget ${budget}`);
      if (budget === 4) {
        assert.equal(cold.aborted, true);
        assert.equal(cold.steps, 5);
        assert.equal(cold.inspections, 0);
        assert.equal(warm.inspections, 0);
      }
    }
  } finally {
    for (const { member, descriptor } of originals) Object.defineProperty(member, 'kind', descriptor);
  }
});

/** dependency descriptor 이름 검사를 직접 계측해 service matching의 quadratic 순회를 고립한다. */
test('stage3 service matching inspects dependency descriptors with linear growth', () => {
  const measure = (count: number): number => {
    const members = Array.from({ length: count }, (_, index) => `m${index}() { return ${index}; }`).join(' ');
    const methods = Array.from({ length: count }, (_, index) => `run${index}() { return this.inputs.port.m${index}(); }`).join(' ');
    const source = `class Port { ${members} }
class Controller { constructor(private readonly inputs: { port: Port }) {} ${methods} }
const live = new Port(); const controller = new Controller({ port: live }); controller.run0();`;
    const { context, proof, work, policy } = audited(source);
    const port = proof.declaration.getSourceFile().statements.find((node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'Port')!;
    let reads = 0;
    const originals = port.members.map((member) => {
      const descriptor = Object.getOwnPropertyDescriptor(member, 'name')!;
      Object.defineProperty(member, 'name', { configurable: true, enumerable: descriptor.enumerable!,
        get: () => { reads++; return descriptor.value; } });
      return { member, descriptor };
    });
    try {
      assert.ok(auditSingletonCarrier(context, proof, work, policy));
      return reads;
    } finally {
      for (const { member, descriptor } of originals) Object.defineProperty(member, 'name', descriptor);
    }
  };
  const small = measure(20);
  const large = measure(200);
  assert.ok(small > 0);
  assert.ok(large < small * 15, `descriptor reads ${small} -> ${large}`);
});

/** modifier API의 bulk filtering이 아니라 raw modifier.kind 접근을 계측한다. */
function observeModifierKinds(node: ts.Node): { readonly count: () => number; readonly reset: () => void; readonly restore: () => void } {
  const modifiers = (node as ts.Node & { readonly modifiers?: readonly ts.ModifierLike[] }).modifiers ?? [];
  let reads = 0;
  const originals = modifiers.map((modifier) => {
    const descriptor = Object.getOwnPropertyDescriptor(modifier, 'kind')!;
    Object.defineProperty(modifier, 'kind', { configurable: true, enumerable: descriptor.enumerable ?? false,
      get: () => { reads++; return descriptor.value; } });
    return { modifier, descriptor };
  });
  return { count: () => reads, reset: () => { reads = 0; }, restore: () => {
    for (const { modifier, descriptor } of originals) Object.defineProperty(modifier, 'kind', descriptor);
  } };
}

/** extended descriptor와 selection의 modifier census가 물리 읽기도 caller work로 청구한다. */
test('stage3 extended decorator census charges raw modifier reads', () => {
  const decorators = (count: number): string => Array.from({ length: count }, () => '@dec').join('\n');
  const measureClass = (count: number): { value: boolean; steps: number; reads: number } => {
    const source = `declare function dec(...args: any[]): any;\n${positive}`
      .replace('class Controller {', `${decorators(count)}\nclass Controller {`);
    const { context, declaration } = indexed(source, { experimentalDecorators: true });
    assert.equal(context.index.effectInventory?.enumeration, 'complete');
    const observation = observeModifierKinds(declaration);
    let steps = 0;
    try {
      const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
        step: () => { steps++; }, check: () => {},
      } });
      analyzer.beginQuery();
      try { return { value: analyzer.allowsExtendedInstanceIsolation(declaration), steps, reads: observation.count() }; }
      finally { analyzer.endQuery(); }
    } finally { observation.restore(); }
  };
  const measureParameter = (count: number): { value: boolean; steps: number; reads: number } => {
    const decoratedParameter = `${decorators(count)}\nprivate readonly inputs`;
    const source = `declare function dec(...args: any[]): any;\n${positive.replace('private readonly inputs', decoratedParameter)}`;
    const { context, declaration } = indexed(source, { experimentalDecorators: true });
    assert.equal(context.index.effectInventory?.enumeration, 'complete');
    const constructor = declaration.members.find(ts.isConstructorDeclaration)!;
    const observation = observeModifierKinds(constructor.parameters[0]!);
    let steps = 0;
    try {
      const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
        step: () => { steps++; }, check: () => {},
      } });
      analyzer.beginQuery();
      try { return { value: analyzer.selectsExtendedFlow(declaration), steps, reads: observation.count() }; }
      finally { analyzer.endQuery(); }
    } finally { observation.restore(); }
  };
  const classSmall = measureClass(1);
  const classLarge = measureClass(1_000);
  assert.equal(classSmall.value, false);
  assert.equal(classLarge.value, false);
  assert.ok(classSmall.reads <= 1, `first decorator should close: ${classSmall.reads}`);
  assert.ok(classLarge.reads <= 1, `first decorator should close: ${classLarge.reads}`);
  const parameterSmall = measureParameter(1);
  const parameterLarge = measureParameter(1_000);
  assert.equal(parameterSmall.value, true);
  assert.equal(parameterLarge.value, true);
  assert.ok(parameterLarge.reads > parameterSmall.reads + 900, `${parameterSmall.reads} -> ${parameterLarge.reads}`);
  assert.ok(parameterLarge.steps > parameterSmall.steps + 900, `${parameterSmall.steps} -> ${parameterLarge.steps}`);
});

/** parameter modifier의 selection과 descriptor 모두 검사 전 중단·재시도를 보존한다. */
test('stage3 parameter modifier census replays charged interruption prefixes', () => {
  const count = 40;
  const decoratedParameter = `${Array.from({ length: count }, () => '@dec').join('\n')}\nprivate readonly inputs`;
  const source = `declare function dec(...args: any[]): any;\n${positive.replace('private readonly inputs', decoratedParameter)}`;
  const { context, declaration } = indexed(source, { experimentalDecorators: true });
  assert.equal(context.index.effectInventory?.enumeration, 'complete');
  const constructor = declaration.members.find(ts.isConstructorDeclaration)!;
  const observation = observeModifierKinds(constructor.parameters[0]!);
  try {
    for (const operation of ['selection', 'descriptor'] as const) {
      const expected = operation === 'selection';
      const run = (warm: boolean, limit: number) => {
        const sentinel = new Error('parameter modifier caller interruption');
        let activeLimit = Number.POSITIVE_INFINITY;
        let steps = 0;
        let events: string[] = [];
        const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
          step: () => { events.push('step'); if (++steps > activeLimit) throw sentinel; },
          check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
        } });
        const invoke = (allowance: number) => {
          activeLimit = allowance; steps = 0; events = []; observation.reset();
          analyzer.beginQuery();
          try {
            const value = operation === 'selection' ? analyzer.selectsExtendedFlow(declaration)
              : analyzer.allowsExtendedInstanceIsolation(declaration);
            return { kind: 'ok' as const, value, steps, events: [...events], reads: observation.count() };
          } catch (error) {
            if (error !== sentinel) throw error;
            return { kind: 'abort' as const, value: false, steps, events: [...events], reads: observation.count() };
          } finally { analyzer.endQuery(); }
        };
        if (warm) assert.equal(invoke(Number.POSITIVE_INFINITY).value, expected);
        const result = invoke(limit);
        // 같은 analyzer의 중단 이후 새 질의도 pending/cache 오염 없이 원래 판정을 낸다.
        const recovery = invoke(Number.POSITIVE_INFINITY);
        assert.equal(recovery.kind, 'ok');
        assert.equal(recovery.value, expected);
        return result;
      };
      const full = run(false, Number.POSITIVE_INFINITY);
      assert.equal(full.kind, 'ok');
      assert.equal(full.value, expected);
      assert.ok(full.reads >= count + 2, `modifier reads ${full.reads}`);
      let firstReadBudget: number | undefined;
      for (let budget = 0; budget <= full.steps + 1; budget++) {
        const cold = run(false, budget);
        const warm = run(true, budget);
        assert.equal(warm.kind, cold.kind, `${operation} budget ${budget}`);
        assert.equal(warm.value, cold.value, `${operation} budget ${budget}`);
        assert.equal(warm.steps, cold.steps, `${operation} budget ${budget}`);
        assert.deepEqual(warm.events, cold.events, `${operation} budget ${budget}`);
        assert.equal(warm.reads, 0, `warm AST read at ${operation} budget ${budget}`);
        if (cold.reads > 0 && firstReadBudget === undefined) {
          firstReadBudget = budget;
          assert.ok(budget > 0);
          const boundary = run(false, budget - 1);
          assert.equal(boundary.kind, 'abort');
          assert.equal(boundary.reads, 0, `${operation} inspected before charged modifier`);
          assert.equal(boundary.steps, budget);
          assert.equal(cold.reads, 1, `${operation} first charged modifier read`);
        }
      }
      assert.ok(firstReadBudget !== undefined);
    }
  } finally { observation.restore(); }
});

/** 원 재현 경로인 singleton(Port)의 decorator 검사도 첫 원소 전에 caller가 중단한다. */
test('stage3 dependency decorators close at one charged read with cold warm boundary parity', () => {
  const count = 1_000;
  const source = `declare function dec(...args: any[]): any;\n${positive.replace('class Port {',
    `${Array.from({ length: count }, () => '@dec').join('\n')}\nclass Port {`)}`;
  const { context, declaration } = indexed(source, { experimentalDecorators: true });
  assert.equal(context.index.effectInventory?.enumeration, 'complete');
  const port = declaration.getSourceFile().statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'Port')!;
  const observation = observeModifierKinds(port);
  try {
    const run = (warm: boolean, limit: number) => {
      const sentinel = new Error('dependency decorator caller interruption');
      let budget = Number.POSITIVE_INFINITY;
      let steps = 0;
      let events: string[] = [];
      const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
        step: () => { events.push('step'); if (++steps > budget) throw sentinel; },
        check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
      } });
      const invoke = (allowance: number) => {
        budget = allowance; steps = 0; events = []; observation.reset();
        analyzer.beginQuery();
        try {
          return { kind: 'ok' as const, value: analyzer.allowsExtendedInstanceIsolation(declaration),
            steps, events: [...events], reads: observation.count() };
        } catch (error) {
          assert.equal(error, sentinel);
          return { kind: 'abort' as const, value: false, steps, events: [...events], reads: observation.count() };
        } finally { analyzer.endQuery(); }
      };
      if (warm) assert.equal(invoke(Number.POSITIVE_INFINITY).value, false);
      const result = invoke(limit);
      const recovery = invoke(Number.POSITIVE_INFINITY);
      assert.equal(recovery.kind, 'ok');
      assert.equal(recovery.value, false);
      return result;
    };
    const full = run(false, Number.POSITIVE_INFINITY);
    assert.equal(full.kind, 'ok');
    assert.equal(full.value, false);
    assert.equal(full.reads, 1);
    for (let budget = 0; budget <= full.steps + 1; budget++) {
      const cold = run(false, budget);
      const warm = run(true, budget);
      assert.equal(warm.kind, cold.kind, `budget ${budget}`);
      assert.equal(warm.steps, cold.steps, `budget ${budget}`);
      assert.deepEqual(warm.events, cold.events, `budget ${budget}`);
      assert.equal(warm.reads, 0);
      if (budget < full.steps) {
        assert.equal(cold.kind, 'abort');
        assert.equal(cold.reads, 0, `inspected before dependency step at budget ${budget}`);
      } else {
        assert.equal(cold.kind, 'ok');
        assert.equal(cold.reads, 1);
      }
    }
  } finally { observation.restore(); }
});
