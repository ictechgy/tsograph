/** Stage5는 실제 독립 inventory와 graph 경계에서 singleton authority를 검증한다. */
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-stage5-')));
  try {
    for (const [path, content] of Object.entries({ 'tsconfig.json': JSON.stringify({ compilerOptions: {
      strict: true, types: [], lib: ['es2022'], target: 'es2022', module: 'esnext', moduleResolution: 'bundler',
    } }), 'src/main.ts': source, ...extra })) {
      mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, createNodeFileSystem());
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const positive = `const captured = "safe";
function identity(value: string) { return value; }
function composed(value: string) { const first = identity(value); const second = identity(captured); return identity(first); }
class Port { send(value: string) { const local = composed(value); return identity(local); } }
class Controller {
  tick: () => Date;
  constructor(private readonly inputs: { port: Port; tick?: () => Date }) {
    this.tick = inputs.tick ?? (() => new Date());
  }
  run(value: string) { const first = composed(value); this.tick(); return this.inputs.port.send(identity(first)); }
}
const live = new Port();
const controller = new Controller({ port: live, tick: undefined });
controller.run(composed("one"));
controller.run(captured);
export {};`;

/** capture가 arrow 선언 뒤에 있지만 모든 외부 호출보다 앞선 module-ready fixture다. */
function exportedArrowAfterSource(): string {
  return positive.replace('const captured = "safe";\n', '')
    .replace('controller.run(composed("one"));\ncontroller.run(captured);',
      'export const read = () => controller.run(captured);\nconst captured = "safe";\ncontroller.run(composed("one"));');
}

/** exact synchronous inline wrapper의 capture 순서를 바꿔 쓰는 합성 fixture다. */
function inlineWrapperSource(order: string): string {
  return `function identity(value: string) { return value; }
class Port { send() { return identity(dependencyCaptured); } }
class Controller {
  tick: () => Date;
  constructor(private readonly inputs: { port: Port; tick?: () => Date }) {
    this.tick = inputs.tick ?? (() => new Date());
  }
  run() { const local = identity(helperCaptured); this.tick(); this.inputs.port.send(); return identity(local); }
}
function wrap(value: Controller, callback: (value: Controller) => string) { return callback(value); }
const live = new Port();
const controller = new Controller({ port: live, tick: undefined });
${order}
export {};`;
}

/** body capture가 없는 arrow alias의 실제 binding/call 순서를 바꿔 쓰는 fixture다. */
function zeroCaptureArrowSource(order: string): string {
  return `class Port { send() { return 1; } }
class Controller {
  tick: () => Date;
  constructor(private readonly inputs: { port: Port; tick?: () => Date }) {
    this.tick = inputs.tick ?? (() => new Date());
  }
  run() { this.tick(); return this.inputs.port.send(); }
}
const live = new Port();
const controller = new Controller({ port: live, tick: undefined });
${order}
export {};`;
}

/** 실제 graph consumer에서 instantiated dependency와 carrier entry를 함께 검증한다. */
test('stage5 primitive entry and dependency arguments instantiate actual bound endpoint', async () => {
  const graph = await fixedPositiveDocument();
  assert.deepEqual(graph.edges.filter(edge => edge.from === 'src/main.ts#Controller.run' && edge.to === 'src/main.ts#Port.send').map(edge => edge.evidence), ['bound'], JSON.stringify(graph.limitations));
  assert.deepEqual(graph.edges.filter(edge => edge.from === 'src/main.ts#Port.send' && edge.to === 'src/main.ts#identity').map(edge => edge.evidence), ['direct']);
});

/** erased indexed/typeof method aliases must not become runtime entry obligations. */
test('stage5 type-only method aliases preserve primitive entry authority', async () => {
  for (const alias of ['type Send = Port["send"];', 'type Send = typeof Port.prototype.send;']) {
    const graph = await graphOf(`${alias}\n${positive}`);
    assert.deepEqual(endpointEvidence(graph), ['bound'], alias + JSON.stringify(graph.limitations));
  }
  const escaped = await graphOf(`${positive}\nconst escaped = live.send;`);
  assert.deepEqual(endpointEvidence(escaped), ['candidate']);
});

/** capture readiness belongs to each actual carrier method entry, not class-wide earliest use. */
test('stage5 per-method capture entry preserves warmup before later initialized run', async () => {
  const source = `class Port { send(value: string) { return value; } }
class Controller {
  tick: () => Date;
  constructor(private readonly inputs: { port: Port; tick?: () => Date }) {
    this.tick = inputs.tick ?? (() => new Date());
  }
  warmup() { this.tick(); return "ok"; }
  run() { this.tick(); return this.inputs.port.send(captured); }
}
const live = new Port();
const controller = new Controller({ port: live, tick: undefined });
controller.warmup();
const captured = "safe";
controller.run();
export {};`;
  const graph = await graphOf(source);
  assert.deepEqual(endpointEvidence(graph), ['bound'], JSON.stringify(graph.limitations));
  const swapped = await graphOf(source.replace('controller.warmup();\nconst captured = "safe";\ncontroller.run();',
    'controller.run();\ncontroller.warmup();\nconst captured = "safe";'));
  assert.deepEqual(endpointEvidence(swapped), ['candidate']);
});

/** zero-parameter dependency body captures are checked at every actual instantiation, not warmup anchor. */
test('stage5 zero-parameter dependency capture follows actual carrier call', async () => {
  const source = `class Port { send() { return captured; } }
class Controller {
  tick: () => Date;
  constructor(private readonly inputs: { port: Port; tick?: () => Date }) {
    this.tick = inputs.tick ?? (() => new Date());
  }
  warmup() { this.tick(); return "ok"; }
  run() { this.tick(); return this.inputs.port.send(); }
}
const live = new Port();
const controller = new Controller({ port: live, tick: undefined });
controller.warmup();
const captured = "safe";
controller.run();
export {};`;
  const graph = await graphOf(source);
  assert.deepEqual(endpointEvidence(graph), ['bound'], JSON.stringify(graph.limitations));
});

/** exported zero-parameter arrow의 실제 invocation entry가 capture readiness를 결정한다. */
test('stage5 exported arrow capture readiness follows invocation entry', async () => {
  const before = positive.replace('controller.run(captured);', 'export const read = () => controller.run(captured);');
  assert.deepEqual(endpointEvidence(await graphOf(before)), ['bound']);
  const after = exportedArrowAfterSource();
  const afterGraph = await graphOf(after);
  assert.deepEqual(endpointEvidence(afterGraph), ['bound'], JSON.stringify(afterGraph.limitations));
  const local = after.replace('const captured = "safe";', 'const captured = "safe";\nread();');
  assert.deepEqual(endpointEvidence(await graphOf(local)), ['bound']);
  const named = after.replace('export const read =', 'const read =') + '\nexport { read };';
  assert.deepEqual(endpointEvidence(await graphOf(named)), ['bound']);
  assert.deepEqual(endpointEvidence(await graphOf(after, {
    'src/consumer.ts': 'import { read } from "./main.js";\nread();',
  })), ['bound']);
  const early = after.replace('const captured = "safe";', 'read();\nconst captured = "safe";');
  assert.deepEqual(endpointEvidence(await graphOf(early)), ['candidate']);
  const reentrant = after.replace('const captured = "safe";', 'const captured = read();');
  assert.deepEqual(endpointEvidence(await graphOf(reentrant)), ['candidate']);
  const cycle = 'import "./cycle.js";\n' + after;
  assert.deepEqual(endpointEvidence(await graphOf(cycle, {
    'src/cycle.ts': 'import { read } from "./main.js";\nread();',
  })), ['candidate']);
  const escaped = after + '\ndeclare function schedule(callback: () => string): void;\nschedule(read);';
  assert.deepEqual(endpointEvidence(await graphOf(escaped)), ['candidate']);
});

/** arrow binding 자체의 readiness는 body summary capture가 없어도 모든 실제 호출에서 검사한다. */
test('stage5 arrow binding readiness does not depend on body captures', async () => {
  const alias = 'const read = () => controller.run();';
  assert.deepEqual(endpointEvidence(await graphOf(zeroCaptureArrowSource(`${alias}\nread();`))), ['bound']);
  assert.deepEqual(endpointEvidence(await graphOf(zeroCaptureArrowSource(`read();\n${alias}`))), ['candidate']);
  const exported = zeroCaptureArrowSource('export const read = () => controller.run();');
  assert.deepEqual(endpointEvidence(await graphOf(exported)), ['bound']);
});

/** unused controller body도 fictitious entry 없이 purity summary를 거쳐야 한다. */
test('stage5 unused controller methods retain pending effect defense', async () => {
  const safe = positive.replace('class Controller {', 'class Controller {\n  unused() { return composed("unused"); }');
  assert.deepEqual(endpointEvidence(await graphOf(safe)), ['bound']);
  const unsafe = 'declare function sink(): void;\n' + positive.replace('class Controller {',
    'class Controller {\n  unused() { sink(); }');
  const graph = await graphOf(unsafe);
  assert.deepEqual(endpointEvidence(graph), ['candidate']);
  assert.ok(graph.limitations.some(message => message.includes('carrier-proof')));
});

/** exact synchronous inline wrapper의 inner carrier call은 outer wrap invocation에서 실행된다. */
test('stage5 inline wrapper capture readiness follows the actual outer invocation', async () => {
  const captures = 'const helperCaptured = "helper";\nconst dependencyCaptured = "dependency";';
  const invocation = 'wrap(controller, value => value.run());';
  const before = inlineWrapperSource(`${captures}\n${invocation}`);
  assert.deepEqual(endpointEvidence(await graphOf(before)), ['bound']);
  const after = inlineWrapperSource(`${invocation}\n${captures}`);
  assert.deepEqual(endpointEvidence(await graphOf(after)), ['candidate']);
  const exportedEntry = `export const read = () => ${invocation.slice(0, -1)};`;
  const exported = inlineWrapperSource(`${exportedEntry}\n${captures}`);
  assert.deepEqual(endpointEvidence(await graphOf(exported)), ['bound']);
  const local = inlineWrapperSource(`${exportedEntry}\n${captures}\nread();`);
  assert.deepEqual(endpointEvidence(await graphOf(local)), ['bound']);
  const early = inlineWrapperSource(`${exportedEntry}\nread();\n${captures}`);
  assert.deepEqual(endpointEvidence(await graphOf(early)), ['candidate']);
  assert.deepEqual(endpointEvidence(await graphOf(exported, {
    'src/consumer.ts': 'import { read } from "./main.js";\nread();',
  })), ['bound']);
  const cycle = 'import "./cycle.js";\n' + exported;
  assert.deepEqual(endpointEvidence(await graphOf(cycle, {
    'src/cycle.ts': 'import { read } from "./main.js";\nread();',
  })), ['candidate']);
  const reentrant = inlineWrapperSource(
    'const helperCaptured = wrap(controller, value => value.run());\nconst dependencyCaptured = "dependency";');
  assert.deepEqual(endpointEvidence(await graphOf(reentrant)), ['candidate']);
  const defaultEntry = before.replace('function wrap(value: Controller,', 'function wrap(value: Controller = controller,');
  assert.deepEqual(endpointEvidence(await graphOf(defaultEntry)), ['candidate']);
  const escapedCallback = before.replace('{ return callback(value); }', '{ const escaped = callback; return callback(value); }');
  assert.deepEqual(endpointEvidence(await graphOf(escapedCallback)), ['candidate']);
  const blockCallback = before.replace('value => value.run()', 'value => { return value.run(); }');
  assert.deepEqual(endpointEvidence(await graphOf(blockCallback)), ['candidate']);
});

/** nominal interface/type-literal annotations do not hide the concrete singleton carrier binding. */
test('stage5 typed carrier aliases retain structural runtime entry provenance', async () => {
  for (const annotation of ['interface Runner { run(value: string): string; }', 'type Runner = { run(value: string): string };']) {
    const source = `${annotation}\n${positive.replace('const controller =', 'const controller: Runner =')}`;
    assert.deepEqual(endpointEvidence(await graphOf(source)), ['bound'], annotation);
    const unsafe = await graphOf(source.replace('controller.run(captured);', 'controller.run(controller as unknown as string);'));
    assert.deepEqual(endpointEvidence(unsafe), ['candidate'], annotation);
  }
});


/** 한 immutable 입력의 최종 문서만 재사용하며 mutation/order/cap 분석은 새 analyzer를 만든다. */
let positiveDocument: ReturnType<typeof graphOf> | undefined;

/** 동일한 고정 입력의 final document를 한 번만 계산한다. */
function fixedPositiveDocument() { return positiveDocument ??= graphOf(positive); }

/** actual target의 evidence와 미확정 진단을 함께 확인한다. */
function endpointEvidence(graph: Awaited<ReturnType<typeof graphOf>>) {
  return graph.edges.filter(edge => edge.from === 'src/main.ts#Controller.run'
    && edge.to === 'src/main.ts#Port.send').map(edge => edge.evidence);
}

test('stage5 full primitive argument grammar crosses actual dependency consumers', async t => {
  const variants: Record<string, string> = {
    literal: positive.replace('identity(first)', '"literal"'),
    capture: positive.replace('identity(first)', 'captured'),
    ordered: positive.replace('send(identity(first))', 'send(secondLocal)').replace('const first = composed(value); this.tick();',
      'const first = composed(value), secondLocal = identity(first); this.tick();'),
    zeroCarrier: positive.replace('run(value: string)', 'run()').replace('const first = composed(value); this.tick();',
      'const first = composed("safe"); this.tick();').replace('controller.run(composed("one"));', 'controller.run();').replace('controller.run(captured);', 'controller.run();'),
    zeroDependency: positive.replace('send(value: string)', 'send()').replace('const local = composed(value);',
      'const local = composed("safe");').replace('send(identity(first))', 'send()'),
    literalBody: positive.replace('const local = composed(value); return identity(local);', 'return 1;'),
    emptyBody: positive.replace('const local = composed(value); return identity(local);', ''),
    parameterReturn: positive.replace('const local = composed(value); return identity(local);', 'return value;'),
    parameterHelper: positive.replace('const local = composed(value); return identity(local);', 'identity(value); return value;'),
    publicMethods: positive.replace('send(value:', 'public send(value:').replace('run(value:', 'public run(value:'),
    wraps: positive.replace('send(identity(first))', 'send(((identity((first as string))) as string)!)')
      .replace('controller.run(captured)', 'controller.run((captured as string)!)'),
    primitives: positive.replace('controller.run(captured);', 'controller.run(1); controller.run(123n); controller.run(true); controller.run(false); controller.run(null); controller.run(undefined);'),
    localHelper: positive.replace('const local = composed(value);', 'const local = identity(value), next = identity(local);').replace('return identity(local);', 'return identity(next);'),
    multipleArguments: positive.replace('send(value: string)', 'send(value: string, other: number)')
      .replace('run(value: string)', 'run(value: string, other: number)')
      .replace('send(identity(first))', 'send(identity(first), identity(other))')
      .replace('run(composed("one"))', 'run(composed("one"), 1)').replace('run(captured)', 'run(captured, 2)'),
    carrierParameterReturn: positive.replace('return this.inputs.port.send(identity(first));', 'this.inputs.port.send(identity(first)); return value;'),
    directParameterLocal: positive.replace('const first = composed(value); this.tick();', 'const first = value; this.tick();'),
    arrowArgumentCapture: positive.replace('controller.run(captured);', 'const later = "safe"; export const read = () => controller.run(later);'),
    perCallCapture: positive.replace('controller.run(captured);', 'const later = "safe"; controller.run(later);'),
    stringMethod: positive.replace('send(value:', '"send"(value:'),
    unusedZero: positive.replace('class Port {', 'class Port { unused() { return composed("unused"); }'),
  };
  for (const [name, source] of Object.entries(variants)) await t.test(name, async () => {
    const graph = await graphOf(source);
    assert.deepEqual(endpointEvidence(graph), ['bound'], JSON.stringify(graph.limitations));
  });
  const graph = await fixedPositiveDocument();
  assert.deepEqual(endpointEvidence(graph), ['bound']);
  assert.ok(graph.edges.some(edge => edge.from === 'src/main.ts#Controller.run' && edge.to === 'src/main.ts#composed' && edge.evidence === 'direct'));
});

/** 가장 가까운 음성 사례의 실제 target과 limitation을 확인한다. */
test('stage5 every-call provenance rejects unsafe arguments and entries at the graph boundary', async t => {
  const variants: Record<string, string> = {};
  for (const [name, argument] of Object.entries({ object: 'live', carrier: 'controller', wrapper: '{ port: live }',
    arrayWrapper: '[live]', callback: '() => "safe"', spread: '...["safe"]', unknown: 'unknownValue',
    coercion: '+1', arithmetic: '1 + 1', property: 'captured.length', newDate: 'new Date()',
    missing: '', extra: '"safe", "extra"' })) {
    variants[`entry-${name}`] = positive.replace('controller.run(captured);', `controller.run(${argument});`);
    variants[`dependency-${name}`] = positive.replace('send(identity(first))', `send(${argument === 'controller' ? 'this' : argument === 'live' ? 'this.inputs.port' : argument})`);
  }
  for (const [name, syntax] of Object.entries({ default: 'value = "safe"', destructured: '{value}: any', rest: '...value: string[]',
    optional: 'value?: string', decorated: '@decorate value: string', thisParameter: 'this: Controller, value: string' })) {
    variants[`carrier-${name}`] = positive.replace('run(value: string)', `run(${syntax})`);
    variants[`endpoint-${name}`] = positive.replace('send(value: string)', `send(${syntax})`);
  }
  Object.assign(variants, {
    carrierAsync: positive.replace('run(value:', 'async run(value:'),
    carrierGenerator: positive.replace('run(value:', '*run(value:'),
    endpointAsync: positive.replace('send(value:', 'async send(value:'),
    endpointGenerator: positive.replace('send(value:', '*send(value:'),
    carrierWrite: positive.replace('const first = composed(value); this.tick();', 'value = "changed"; const first = composed(value); this.tick();'),
    endpointWrite: positive.replace('const local = composed(value);', 'value = "changed"; const local = composed(value);'),
    carrierArguments: positive.replace('composed(value); this.tick()', 'composed(arguments[0]); this.tick()'),
    endpointArguments: positive.replace('const local = composed(value);', 'const local = composed(arguments[0]);'),
    carrierDefaultEffect: positive.replace('run(value: string)', 'run(value = observe(this))'),
    unusedParameterized: positive.replace('class Port {', 'class Port { unused(value: string) { return value; }'),
    escapeEntry: positive + '\nconst escaped = controller.run;',
    escapeReceiver: positive + '\nconst alias = controller; alias.run("safe");',
    escapeEndpoint: positive.replace('this.tick(); return', 'const borrowed = this.inputs.port.send; this.tick(); return'),
    mergedHelper: positive + '\nnamespace composed { export const extra = 1; }',
    writtenHelper: positive + '\nidentity = value => value;',
    earlyCapture: positive.replace('const captured = "safe";\n', '') + '\nconst captured = "safe";',
    earlySecondCapture: positive.replace('controller.run(captured);', 'controller.run(late); const late = "safe";'),
    earlyLocal: positive.replace('const first = composed(value); this.tick();', 'const first = composed(later); const later = value; this.tick();'),
    earlyEntry: positive.replace('controller.run(captured);', '').replace('const controller =', 'controller.run("early");\nconst controller ='),
    earlyAllocation: positive.replace('const live = new Port();', '').replace('const controller =', 'const controller =') + '\nconst live = new Port();',
    recursive: positive.replace('return value;', 'return identity(value);'),
    zeroEntryExtra: positive.replace('run(value: string)', 'run()').replace('composed(value); this.tick()', 'composed("safe"); this.tick()'),
    zeroEndpointExtra: positive.replace('send(value: string)', 'send()').replace('const local = composed(value);', 'const local = composed("safe");'),
    unresolvedEntry: positive + '\n(controller as unknownValue).run("unsafe");',
    unstableReceiver: positive + '\ncontroller = new Controller({ port: live, tick: undefined });',
    unstableEndpoint: positive + '\nPort.prototype.send = function(value: string) { return value; };',
    unsafeMultiArgument: positive.replace('send(value: string)', 'send(value: string, other: string)')
      .replace('send(identity(first))', 'send(identity(first), this.inputs.port)'),
    helperObjectArgument: positive.replace('send(identity(first))', 'send(identity(this.inputs.port))'),
    helperCaptureObject: positive.replace('const captured = "safe";', 'const captured = {};'),
    nestedEntry: positive + '\nfunction deferred() { controller.run("safe"); }',
  });
  for (const [name, source] of Object.entries(variants)) await t.test(name, async () => {
    const graph = await graphOf(source);
    assert.deepEqual(endpointEvidence(graph), name === 'escapeEndpoint' ? ['direct', 'candidate'] : ['candidate'], name);
    assert.ok(graph.limitations.some(message => message.includes('candidate-dispatch')), name);
    assert.ok(graph.limitations.some(message => message.includes('carrier-proof')), name);
  });
});

/** 두 번째 unsafe 호출도 전역의 완전한 provenance를 깨뜨린다. */
test('stage5 a second unsafe endpoint call blocks all new authority', async () => {
  const source = positive.replace('this.tick(); return this.inputs.port.send(identity(first));',
    'this.inputs.port.send(first); this.tick(); return this.inputs.port.send(this.inputs);');
  const graph = await graphOf(source);
  assert.deepEqual(endpointEvidence(graph), ['candidate']);
  assert.ok(graph.limitations.some(message => message.includes('primitive')));
});

/** static helper aliases retain canonical identity and import readiness in real consumers. */
test('stage5 imported helper arguments keep static aliases and initialization obligations', async () => {
  const base = positive.replace('function identity(value: string) { return value; }', '')
    .replace('function composed(value: string) { const first = identity(value); const second = identity(captured); return identity(first); }', '');
  const helperSource = 'const captured = "safe";\nexport function identity(value: string) { return value; }\nexport function composed(value: string) { const local = identity(value); const capture = identity(captured); return identity(local); }';
  const main = 'import { identity, exposed as composed } from "./barrel.js";\n' + base;
  const files = { 'src/helpers.ts': helperSource, 'src/barrel.ts': 'export { identity, composed as exposed } from "./helpers.js";' };
  assert.deepEqual(endpointEvidence(await graphOf(main, files)), ['bound']);
  assert.deepEqual(endpointEvidence(await graphOf(main, { ...files, 'src/helpers.ts': 'composed("early");\n' + helperSource })), ['candidate']);
  assert.deepEqual(endpointEvidence(await graphOf(main, { ...files, 'src/helpers.ts': 'import "./main.js";\n' + helperSource })), ['candidate']);
  const defaultMain = 'import composed from "./helpers.js";\nfunction identity(value: string) { return value; }\n' + base;
  assert.deepEqual(endpointEvidence(await graphOf(defaultMain, { 'src/helpers.ts': helperSource.replace('export function composed', 'export default function composed') })), ['bound']);
});

/** 새 entry·instantiation에서도 DAG lookup·guard·공유 edge accounting이 일치한다. */
test('stage5 new proof cold warm prefix replay and reversed consumers are deterministic', () => {
  const { context, declaration, literal } = indexed(positive);
  const sentinel = new Error('synthetic stage5 caller interruption');
  const create = () => {
    let limit = Infinity, steps = 0, events: string[] = [];
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { events.push('step'); if (++steps > limit) throw sentinel; },
      check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
    } });
    return (budget = Infinity, bag = false) => {
      limit = budget; steps = 0; events = []; analyzer.beginQuery();
      try {
        return { value: bag ? analyzer.isolatesExtendedBag(declaration, literal) : analyzer.allowsExtendedInstanceIsolation(declaration),
          steps, events: [...events], aborted: false };
      } catch (error) {
        assert.equal(error, sentinel); return { value: false, steps, events: [...events], aborted: true };
      } finally { analyzer.endQuery(); }
    };
  };
  const warm = create(); const cold = warm();
  assert.equal(cold.value, true); assert.deepEqual(warm(), cold);
  const reverse = create(); const bag = reverse(Infinity, true);
  assert.equal(bag.value, true); assert.deepEqual(reverse(), cold); assert.deepEqual(warm(Infinity, true), bag);
  const budgets = new Set([0, 1, 2, cold.steps - 1, cold.steps, cold.steps + 1]);
  for (let i = 1; i < 32; i++) budgets.add(Math.floor(cold.steps * i / 32));
  for (const budget of budgets) {
    assert.deepEqual(warm(budget), create()(budget), `budget ${budget}`);
    assert.deepEqual(warm(), cold);
  }
});

/** module-ready와 실제 arrow call closure도 cold/warm 및 중단 prefix를 동일하게 청구한다. */
test('stage5 exported arrow runtime entries replay charged work and recover after interruption', () => {
  const { context, declaration } = indexed(exportedArrowAfterSource());
  const sentinel = new Error('synthetic exported arrow interruption');
  const create = () => {
    let limit = Infinity, steps = 0, events: string[] = [];
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { events.push('step'); if (++steps > limit) throw sentinel; },
      check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
    } });
    return (budget = Infinity) => {
      limit = budget; steps = 0; events = []; analyzer.beginQuery();
      try { return { value: analyzer.allowsExtendedInstanceIsolation(declaration), steps, events: [...events], aborted: false }; }
      catch (error) {
        assert.equal(error, sentinel); return { value: false, steps, events: [...events], aborted: true };
      } finally { analyzer.endQuery(); }
    };
  };
  const warm = create();
  const complete = warm();
  assert.equal(complete.value, true);
  assert.deepEqual(warm(), complete);
  const budgets = new Set([0, 1, 2, complete.steps - 1, complete.steps, complete.steps + 1]);
  for (let i = 1; i < 24; i++) budgets.add(Math.floor(complete.steps * i / 24));
  for (const budget of budgets) {
    assert.deepEqual(warm(budget), create()(budget), `arrow budget ${budget}`);
    assert.deepEqual(warm(), complete);
  }
});

/** inline wrapper entry도 cold/warm, 실패 prefix, 완료 negative를 같은 순서로 재생한다. */
test('stage5 inline wrapper entry replays charged work and completed negatives', () => {
  const captures = 'const helperCaptured = "helper";\nconst dependencyCaptured = "dependency";';
  const invocation = 'wrap(controller, value => value.run());';
  const create = (source: string) => {
    const { context, declaration } = indexed(source);
    const sentinel = new Error('synthetic inline wrapper interruption');
    let limit = Infinity, steps = 0, events: string[] = [];
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { events.push('step'); if (++steps > limit) throw sentinel; },
      check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
    } });
    return (budget = Infinity) => {
      limit = budget; steps = 0; events = []; analyzer.beginQuery();
      try { return { value: analyzer.allowsExtendedInstanceIsolation(declaration), steps, events: [...events], aborted: false }; }
      catch (error) {
        assert.equal(error, sentinel); return { value: false, steps, events: [...events], aborted: true };
      } finally { analyzer.endQuery(); }
    };
  };
  const positiveSource = inlineWrapperSource(`${captures}\n${invocation}`);
  const warm = create(positiveSource);
  const complete = warm();
  assert.equal(complete.value, true);
  assert.deepEqual(warm(), complete);
  for (const budget of new Set([0, 1, 2, Math.floor(complete.steps / 2), complete.steps - 1, complete.steps])) {
    assert.deepEqual(warm(budget), create(positiveSource)(budget), `wrapper budget ${budget}`);
    assert.deepEqual(warm(), complete);
  }
  const negativeSource = inlineWrapperSource(`${invocation}\n${captures}`);
  const negative = create(negativeSource);
  const rejected = negative();
  assert.equal(rejected.value, false);
  assert.deepEqual(negative(), rejected);
  assert.deepEqual(create(positiveSource)(), complete);
});

/** zero-capture arrow의 binding readiness도 warm cache와 중단 뒤에 같은 work를 재생한다. */
test('stage5 zero-capture arrow binding replay is deterministic and recoverable', () => {
  const alias = 'const read = () => controller.run();';
  const ready = zeroCaptureArrowSource(`${alias}\nread();`);
  const early = zeroCaptureArrowSource(`read();\n${alias}`);
  const create = (source: string) => {
    const { context, declaration } = indexed(source);
    const sentinel = new Error('synthetic zero-capture arrow interruption');
    let limit = Infinity, steps = 0, events: string[] = [];
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { events.push('step'); if (++steps > limit) throw sentinel; },
      check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
    } });
    return (budget = Infinity) => {
      limit = budget; steps = 0; events = []; analyzer.beginQuery();
      try { return { value: analyzer.allowsExtendedInstanceIsolation(declaration), steps, events: [...events], aborted: false }; }
      catch (error) {
        assert.equal(error, sentinel); return { value: false, steps, events: [...events], aborted: true };
      } finally { analyzer.endQuery(); }
    };
  };
  const warm = create(ready);
  const complete = warm();
  assert.equal(complete.value, true);
  assert.deepEqual(warm(), complete);
  for (const budget of new Set([0, 1, 2, Math.floor(complete.steps / 2), complete.steps - 1, complete.steps])) {
    assert.deepEqual(warm(budget), create(ready)(budget), `zero-capture positive budget ${budget}`);
    assert.deepEqual(warm(), complete);
  }
  const negative = create(early);
  const rejected = negative();
  assert.equal(rejected.value, false);
  assert.deepEqual(negative(), rejected);
  const negativeSteps = rejected.events.filter(event => event === 'step').length;
  for (const budget of new Set([0, 1, 2, Math.floor(negativeSteps / 2), negativeSteps - 1, negativeSteps])) {
    assert.deepEqual(negative(budget), create(early)(budget), `zero-capture negative budget ${budget}`);
    assert.deepEqual(negative(), rejected);
  }
});

/** 새 semantic negative의 완료된 child work도 consumer 순서를 바꿔 재생한다. */
test('stage5 complete negative child replay preserves diagnostics and consumer order', () => {
  const { context, declaration, literal } = indexed(positive.replace('controller.run(captured);', 'controller.run({ port: live });'));
  const sentinel = new Error("synthetic negative replay interruption");
  const create = () => {
    let events: string[] = [], steps = 0, budget = Infinity;
    const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
      step: () => { events.push('step'); if (++steps > budget) throw sentinel; }, check: (depth, frames) => { events.push(`check:${depth}:${frames}`); },
    } });
    return (bag: boolean, limit = Infinity) => {
      budget = limit; steps = 0; events = []; analyzer.beginQuery();
      try { return { value: bag ? analyzer.isolatesExtendedBag(declaration, literal) : analyzer.allowsExtendedInstanceIsolation(declaration), events: [...events], aborted: false }; }
      catch (error) { assert.equal(error, sentinel); return { value: false, events: [...events], aborted: true }; }
      finally { analyzer.endQuery(); }
    };
  };
  const forward = create(), reversed = create();
  const family = forward(false), bag = reversed(true);
  assert.equal(family.value, false); assert.equal(bag.value, false);
  assert.deepEqual(forward(false), family); assert.deepEqual(reversed(false), family);
  assert.deepEqual(forward(true), bag); assert.deepEqual(reversed(true), bag);
  const cost = family.events.filter(event => event === 'step').length;
  for (const budget of new Set([0, 1, 2, Math.floor(cost / 4), Math.floor(cost / 2), cost - 1, cost, cost + 1])) {
    assert.deepEqual(forward(false, budget), create()(false, budget), `negative prefix ${budget}`);
    assert.deepEqual(forward(false), family);
  }
  assert.ok([...context.index.proofDiagnostics].some(message => message.includes('rejected(primitive-helper)')));
  assert.ok(![...context.index.proofDiagnostics].some(message => message.includes('exhausted') || message.includes('cycle')));
});

/** 현재 callable entry guard는 warm body·entry certificate를 재사용하기 전에도 읽는다. */
test('stage5 current method entry and RangeError recovery use the same proof DAG', () => {
  const { context, declaration } = indexed(positive);
  let open = false, fail = false;
  const failure = new RangeError('synthetic method entry policy failure');
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, policy: { ...context.policy,
    isOpenCallable: node => {
      if (ts.isMethodDeclaration(node) && node.name.getText() === 'send') {
        if (fail) throw failure;
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
  assert.ok([...context.index.proofDiagnostics].some(message => message.includes('incomplete(entry)')));
  open = false; fail = true; assert.throws(run, error => error === failure);
  fail = false; assert.equal(run(), true);
  const cold = new ConstructorCarrierAnalyzer({ ...context, policy: { ...context.policy, isOpenCallable: node => {
    if (fail && ts.isMethodDeclaration(node) && node.name.getText() === 'send') throw failure;
    return false;
  } } });
  fail = true; assert.throws(() => run(cold), error => error === failure);
  fail = false; assert.equal(run(cold), true);
});

/** entry arguments를 포함한 새 DAG에서도 cycle은 pending state나 semantic negative를 남기지 않는다. */
test('stage5 recursive argument proof and incomplete coverage never retry legacy', () => {
  const cyclic = indexed(positive.replace('return value;', 'return identity(value);'));
  const analyzer = new ConstructorCarrierAnalyzer(cyclic.context);
  for (let i = 0; i < 2; i++) {
    analyzer.beginQuery();
    try { assert.equal(analyzer.allowsExtendedInstanceIsolation(cyclic.declaration), false); }
    finally { analyzer.endQuery(); }
  }
  assert.deepEqual([...cyclic.context.index.proofDiagnostics], ['carrier-proof: cycle; carrier proof was not completed.']);
  const complete = indexed(positive);
  const incomplete = new ConstructorCarrierAnalyzer({ ...complete.context, index: { ...complete.context.index, mutationComplete: false } });
  incomplete.beginQuery();
  try { assert.equal(incomplete.allowsExtendedInstanceIsolation(complete.declaration), false); }
  finally { incomplete.endQuery(); }
  assert.ok([...complete.context.index.proofDiagnostics].some(message => message.includes('incomplete(coverage)')));
  const fresh = new ConstructorCarrierAnalyzer(complete.context);
  fresh.beginQuery();
  try { assert.equal(fresh.allowsExtendedInstanceIsolation(complete.declaration), true); }
  finally { fresh.endQuery(); }
});

/** 인자 감사의 실제 비용을 기존 20k cap 안에서 측정하며 exhaustion을 한 번만 진단한다. */
test('stage5 large primitive arguments retain fixed caps and fresh recovery', () => {
  const calls = Array.from({ length: 2_000 }, () => 'controller.run("safe");').join('\n');
  const large = indexed(positive + '\n' + calls);
  assert.equal(large.context.index.effectInventory?.enumeration, 'complete');
  const analyzer = new ConstructorCarrierAnalyzer(large.context);
  for (let i = 0; i < 2; i++) {
    analyzer.beginQuery();
    try { assert.equal(analyzer.allowsExtendedInstanceIsolation(large.declaration), false); }
    finally { analyzer.endQuery(); }
  }
  assert.deepEqual([...large.context.index.proofDiagnostics], ['carrier-proof: exhausted; carrier proof was not completed.']);
  const fresh = indexed(positive + '\ncontroller.run("safe");');
  const recovery = new ConstructorCarrierAnalyzer(fresh.context);
  recovery.beginQuery();
  try { assert.equal(recovery.allowsExtendedInstanceIsolation(fresh.declaration), true); }
  finally { recovery.endQuery(); }
});

/** interface 타입의 signature 대신 concrete singleton allocation에서 실제 endpoint를 결정한다. */
test('stage5 interface declared dependency arguments use the actual singleton endpoint', async t => {
  const source = positive.replace('class Port {', 'interface Endpoint { send(value: string): string; }\nclass Port implements Endpoint {')
    .replace('port: Port;', 'port: Endpoint;').replace('const live =', 'const live: Endpoint =');
  const graph = await graphOf(source);
  assert.deepEqual(endpointEvidence(graph), ['bound'], JSON.stringify(graph.limitations));
  const variants = {
    unsafeSecond: source.replace('this.tick(); return this.inputs.port.send(identity(first));',
      'this.inputs.port.send(first); this.tick(); return this.inputs.port.send(this.inputs);'),
    unsafeBody: 'declare function observe(value: unknown): string;\n' + source.replace('return identity(local);', 'return observe(local);'),
    typedObject: source.replace('controller.run(captured);', 'controller.run(live as unknown as string);'),
  };
  for (const [name, input] of Object.entries(variants)) await t.test(name, async () => {
    const negative = await graphOf(input);
    assert.deepEqual(endpointEvidence(negative), ['candidate']);
    assert.ok(negative.limitations.some(message => message.includes('carrier-proof')));
  });
});

/** 실제 새 argument traversal의 깊이 상한도 candidate와 단 한 번의 원래 진단으로 남는다. */
test('stage5 deep dependency argument retains depth cap and recovers independently', async () => {
  const source = positive.replace('send(identity(first))', `send(${'('.repeat(270)}identity(first)${')'.repeat(270)})`);
  const { context, declaration } = indexed(source);
  const analyzer = new ConstructorCarrierAnalyzer(context);
  for (let i = 0; i < 2; i++) {
    analyzer.beginQuery();
    try { assert.equal(analyzer.allowsExtendedInstanceIsolation(declaration), false); }
    finally { analyzer.endQuery(); }
  }
  assert.deepEqual([...context.index.proofDiagnostics], ['carrier-proof: exhausted; carrier proof was not completed.']);
  const graph = await graphOf(source);
  assert.deepEqual(endpointEvidence(graph), ['candidate']);
  assert.equal(graph.limitations.filter(message => message.startsWith('dispatch-budget:')).length, 1, JSON.stringify(graph.limitations));
  assert.deepEqual(endpointEvidence(await fixedPositiveDocument()), ['bound']);
});
