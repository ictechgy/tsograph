/**
 * Stage 0 constructor carrier 규칙이 helper 결과에만 머물지 않고 실제 graph evidence를 닫는지 검증한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import type { CallGraph, EdgeEvidence } from './graph-model.ts';

const fileSystem = createNodeFileSystem();

/** 합성 소스 하나를 실제 call graph 경계까지 분석한다. */
async function graphOf(source: string): Promise<CallGraph> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-carrier-stage0-flow-')));
  try {
    const files = {
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "types": [], "lib": ["es2022"], "module": "esnext", "moduleResolution": "bundler", "target": "es2022", "experimentalDecorators": true } }',
      'src/main.ts': source,
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, fileSystem);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 한 호출 간선 쌍에 기록된 evidence를 정렬된 배열로 읽는다. */
function evidence(graph: CallGraph, from: string, to: string): EdgeEvidence[] {
  return graph.edges
    .filter((edge) => edge.from === `src/main.ts#${from}` && edge.to === `src/main.ts#${to}` && edge.kinds.includes('call'))
    .map((edge) => edge.evidence)
    .sort();
}

/** direct/bound는 concrete target identity 주장이고 candidate만 남은 경우는 보수적 gap이다. */
function hasStrongEvidence(graph: CallGraph, from: string, to: string): boolean {
  return evidence(graph, from, to).some((item) => item === 'direct' || item === 'bound');
}

interface CarrierSourceOptions {
  readonly key?: string;
  readonly literalProperty?: string;
  readonly castLiteral?: boolean;
  readonly scratch?: boolean;
  readonly constructorParameter?: string;
  readonly members?: readonly string[];
  readonly method?: string;
  readonly use?: readonly string[];
  readonly prelude?: readonly string[];
}

/** 이름에 기대지 않는 generic carrier 합성 소스를 만든다. */
function carrierSource(options: CarrierSourceOptions = {}): string {
  const key = options.key ?? 'clock';
  const literalProperty = options.literalProperty ?? `${key}: undefined`;
  const constructorParameter = options.constructorParameter ?? 'private readonly inputs: Inputs';
  const members = options.members ?? [];
  const method = options.method ?? '  run() { this.clock(); return this.inputs.repo.run(); }';
  const use = options.use ?? ['export const read = () => controller.run();'];
  const literal = `{ repo: live${literalProperty === '' ? '' : `, ${literalProperty}`} }`;
  return [
    'interface Repo { run(): string; }',
    `interface Inputs { repo: Repo; ${key}?: () => Date; }`,
    'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
    ...(options.prelude ?? []),
    'class Controller {',
    '  private readonly clock: () => Date;',
    ...members,
    `  constructor(${constructorParameter}) { this.clock = inputs.${key} ?? (() => new Date()); }`,
    method,
    '}',
    'const live: Repo = new LocalRepo();',
    ...(options.scratch ? ['const scratch = [0];', 'scratch[0] = 1;'] : []),
    `const controller = new Controller(${options.castLiteral ? `${literal} as Inputs` : literal});`,
    ...use,
  ].join('\n');
}

/** carrier service target는 unknown일 때 bound 대신 candidate gap으로 남아야 한다. */
function assertCandidateService(graph: CallGraph, label: string): void {
  assert.deepEqual(evidence(graph, 'Controller.run', 'LocalRepo.run'), ['candidate'], label);
}

/** method/property/accessor 어느 node scope든 carrier class에서 service로 가는 bound를 허용하지 않는다. */
function assertNoControllerBoundService(graph: CallGraph, label: string): void {
  const carrierEdges = graph.edges.filter((edge) => edge.from.startsWith('src/main.ts#Controller')
    && edge.to === 'src/main.ts#LocalRepo.run' && edge.kinds.includes('call'));
  assert.equal(carrierEdges.some((edge) => edge.evidence === 'bound'), false, `${label}: ${JSON.stringify(carrierEdges)}`);
  assert.ok(carrierEdges.some((edge) => edge.evidence === 'candidate'), `${label}: ${JSON.stringify(carrierEdges)}`);
}

test('omitted inherited optional keys lose only the false fallback bound edge', async (t) => {
  for (const key of ['toString', 'constructor']) {
    for (const scratch of [false, true]) {
      await t.test(`${key} / scratch=${scratch}`, async () => {
        const graph = await graphOf(carrierSource({ key, literalProperty: '', scratch, castLiteral: scratch }));
        assert.equal(evidence(graph, 'Controller.run', 'Controller.constructor').includes('bound'), false);
        const method = graph.nodes.find((node) => node.id === 'src/main.ts#Controller.run');
        assert.ok((method?.unresolvedCalls?.bound ?? 0) > 0);
        assert.deepEqual(evidence(graph, 'Controller.run', 'LocalRepo.run'), ['bound']);
      });
    }
  }
});

test('explicit own nullish and Date optional values retain graph targets', async (t) => {
  for (const literalProperty of ['clock: undefined', 'clock: null', 'clock: () => new Date()']) {
    await t.test(literalProperty, async () => {
      const graph = await graphOf(carrierSource({ literalProperty }));
      assert.deepEqual(evidence(graph, 'Controller.run', 'LocalRepo.run'), ['bound']);
      assert.ok(graph.edges.some((edge) => edge.from === 'src/main.ts#Controller.run'
        && edge.evidence === 'bound' && edge.to !== 'src/main.ts#LocalRepo.run'));
    });
  }
});

test('unsafe carrier method entry and invocation become candidate gaps at the graph boundary', async (t) => {
  const cases: ReadonlyArray<readonly [string, CarrierSourceOptions]> = [
    ['default this escape', {
      method: '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      prelude: ['declare function observe(value: unknown): unknown;'],
    }],
    ['default this escape with scratch', {
      method: '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      prelude: ['declare function observe(value: unknown): unknown;'], scratch: true,
    }],
    ['rest parameter', { method: '  run(...values: unknown[]) { this.clock(); return this.inputs.repo.run(); }' }],
    ['destructured parameter', { method: '  run({ value }: { value?: unknown } = {}) { this.clock(); return this.inputs.repo.run(); }' }],
    ['async method', { method: '  async run() { this.clock(); return this.inputs.repo.run(); }' }],
    ['generator method', { method: '  *run() { this.clock(); return this.inputs.repo.run(); }' }],
    ['ignored call argument', { use: ['export const read = () => controller.run(observe(controller));'], prelude: ['declare function observe(value: unknown): unknown;'] }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async () => assertCandidateService(await graphOf(carrierSource(options)), label));
  }
});

/** Stage5는 모든 실제 entry가 inert primitive 인자를 제공할 때 required identifier를 인증한다. */
test('required carrier parameter with complete primitive entry is admitted by Stage5', async () => {
  const graph = await graphOf(carrierSource({
    method: '  run(value: unknown) { this.clock(); return this.inputs.repo.run(); }',
    use: ['export const read = () => controller.run(1);'],
  }));
  assert.deepEqual(evidence(graph, 'Controller.run', 'LocalRepo.run'), ['bound']);
});

test('runtime slot, body and wrapper rejections reach the graph boundary', async (t) => {
  const wrapperBase = (suffix: readonly string[]): CarrierSourceOptions => ({ use: suffix });
  const cases: ReadonlyArray<readonly [string, CarrierSourceOptions]> = [
    ['decorated constructor parameter', {
      constructorParameter: '@inject private readonly inputs: Inputs',
      prelude: ['declare function inject(target: object, propertyKey: string | symbol | undefined, parameterIndex: number): void;'],
    }],
    ['field and method collision', { members: ['  clock() { return new Date(); }'] }],
    ['duplicate methods', { members: ['  run() { return this.inputs.repo.run(); }'] }],
    ['coercing service result', { method: '  run() { this.clock(); return this.inputs.repo.run() + ""; }' }],
    ['wrapper default entry', wrapperBase([
      'function wrap(value: Controller, callback: (value: Controller) => string, extra = observe(value)) { return callback(value); }',
      'declare function observe(value: unknown): unknown;',
      'export const read = () => wrap(controller, (value) => value.run());',
    ])],
    ['wrapper arguments escape', wrapperBase([
      'function wrap(value: Controller, callback: (value: Controller) => string) { void arguments; return callback(value); }',
      'export const read = () => wrap(controller, (value) => value.run());',
    ])],
    ['callback arguments escape', wrapperBase([
      'function wrap(value: Controller, callback: (value: Controller) => string) { return callback(value); }',
      'export const read = () => wrap(controller, function(value) { void arguments; return value.run(); });',
    ])],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async () => assertCandidateService(await graphOf(carrierSource(options)), label));
  }
  await t.test('parameter property and method collision', async () => {
    const graph = await graphOf(carrierSource({ members: ['  inputs() { return undefined; }'] }));
    assert.equal(evidence(graph, 'Controller.run', 'LocalRepo.run').includes('bound'), false);
  });
});

test('unsupported carrier bag, storage and instance-member shapes cannot bypass the stage0 gate', async (t) => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['two optional Date members', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; extra?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { this.clock = inputs.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined, extra: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['extended union bag', [
      'interface Repo { run(): string; }',
      'interface BaseInputs { repo: Repo; }',
      'interface Inputs extends BaseInputs { clock?: (() => Date) | undefined; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { this.clock = inputs.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['computed constructor storage', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { this["clock"] = inputs.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['nested constructor storage', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { if (inputs.clock) this.clock = inputs.clock; else this.clock = inputs.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['unsupported Date fallback body', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { this.clock = inputs.clock ?? (() => { return new Date(); }); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['parameter-property fallback read', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { this.clock = this.inputs.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['compound instance storage', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { this.clock ??= inputs.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['assignment chain', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { let other: (() => Date) | undefined; this.clock = other = inputs.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['separated fallback and storage', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { const selected = inputs.clock ?? (() => new Date()); this.clock = selected; }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['bag alias', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { const bag = inputs; this.clock = bag.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['self alias', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { const self = this; self.clock = inputs.clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['destructured projection alias', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { const { clock } = inputs; this.clock = clock ?? (() => new Date()); }',
      '  run(value = observe(this)) { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['arrow property entry', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'declare function observe(value: unknown): unknown;',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { this.clock = inputs.clock ?? (() => new Date()); }',
      '  readonly run = (value = observe(this)) => { this.clock(); return this.inputs.repo.run(); };',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.run();',
    ].join('\n')],
    ['getter body', [
      'interface Repo { run(): string; }',
      'interface Inputs { repo: Repo; clock?: () => Date; }',
      'class LocalRepo implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'class Controller {',
      '  private readonly clock: () => Date;',
      '  constructor(private readonly inputs: Inputs) { this.clock = inputs.clock ?? (() => new Date()); }',
      '  get result() { this.clock(); return this.inputs.repo.run(); }',
      '}',
      'const live: Repo = new LocalRepo();',
      'const controller = new Controller({ repo: live, clock: undefined });',
      'export const read = () => controller.result;',
    ].join('\n')],
  ];
  for (const [label, source] of cases) {
    await t.test(label, async () => assertNoControllerBoundService(await graphOf(source), label));
  }
});

test('ordinary parameter, async and constructor dataflow do not require carrier admission', async () => {
  const graph = await graphOf([
    'interface Repo { run(): string; }',
    'interface Inputs { repo: Repo; }',
    'interface OtherInputs { repo: Repo; transform?: () => string; }',
    'class LocalRepo implements Repo { run() { return "ok"; } }',
    'class ParameterConsumer { constructor(private readonly inputs: Inputs) {} run(value: string) { void value; return this.inputs.repo.run(); } }',
    'class AsyncConsumer { constructor(private readonly inputs: Inputs) {} async run() { return this.inputs.repo.run(); } }',
    'class DirectConsumer { constructor(private readonly repo: Repo) {} run() { return this.repo.run(); } }',
    'class ArrowConsumer { constructor(private readonly inputs: Inputs) {} readonly run = () => this.inputs.repo.run(); }',
    'class GetterConsumer { constructor(private readonly inputs: Inputs) {} get result() { return this.inputs.repo.run(); } }',
    'class ComputedConsumer { private marker = 0; constructor(private readonly inputs: Inputs) { this["marker"] = 1; } run() { return this.inputs.repo.run(); } }',
    'class OptionalFallbackConsumer { private readonly transform: () => string; constructor(private readonly inputs: OtherInputs) { this.transform = inputs.transform ?? (() => { void new Date(); return "fallback"; }); } run(value: string) { void value; this.transform(); return this.inputs.repo.run(); } }',
    'class NestedDateConsumer { private readonly transform: () => string; constructor(private readonly inputs: OtherInputs) { this.transform = inputs.transform ?? (() => { function unused() { return new Date(); } void unused; return "fallback"; }); } run(value: string) { void value; this.transform(); return this.inputs.repo.run(); } }',
    'class ShadowDateConsumer { private readonly transform: () => string; constructor(private readonly inputs: OtherInputs) { class Date {} this.transform = inputs.transform ?? (() => { void new Date(); return "fallback"; }); } run(value: string) { void value; this.transform(); return this.inputs.repo.run(); } }',
    'class DirectDateConsumer { private readonly clock: () => Date; constructor(private readonly inputs: Inputs) { this.clock = undefined ?? (() => new Date()); } run(value: string) { void value; this.clock(); return this.inputs.repo.run(); } }',
    'const live: Repo = new LocalRepo();',
    'const parameter = new ParameterConsumer({ repo: live });',
    'const asynchronous = new AsyncConsumer({ repo: live });',
    'const direct = new DirectConsumer(live);',
    'const arrow = new ArrowConsumer({ repo: live });',
    'const getter = new GetterConsumer({ repo: live });',
    'const computed = new ComputedConsumer({ repo: live });',
    'const optional = new OptionalFallbackConsumer({ repo: live });',
    'const nestedDate = new NestedDateConsumer({ repo: live });',
    'const shadowDate = new ShadowDateConsumer({ repo: live });',
    'const directDate = new DirectDateConsumer({ repo: live });',
    'export const readParameter = () => parameter.run("value");',
    'export const readAsync = () => asynchronous.run();',
    'export const readDirect = () => direct.run();',
    'export const readDirectElement = () => direct["run"]();',
    'export const readArrow = () => arrow.run();',
    'export const readGetter = () => getter.result;',
    'export const readComputed = () => computed.run();',
    'export const readOptional = () => optional.run("value");',
    'export const readNestedDate = () => nestedDate.run("value");',
    'export const readShadowDate = () => shadowDate.run("value");',
    'export const readDirectDate = () => directDate.run("value");',
  ].join('\n'));
  assert.deepEqual(evidence(graph, 'ParameterConsumer.run', 'LocalRepo.run'), ['bound']);
  assert.deepEqual(evidence(graph, 'AsyncConsumer.run', 'LocalRepo.run'), ['bound']);
  assert.deepEqual(evidence(graph, 'DirectConsumer.run', 'LocalRepo.run'), ['bound']);
  assert.ok(hasStrongEvidence(graph, 'readDirectElement', 'DirectConsumer.run'));
  assert.deepEqual(evidence(graph, 'ArrowConsumer.run', 'LocalRepo.run'), ['bound']);
  assert.deepEqual(evidence(graph, 'GetterConsumer.result', 'LocalRepo.run'), ['bound']);
  assert.deepEqual(evidence(graph, 'ComputedConsumer.run', 'LocalRepo.run'), ['bound']);
  assert.deepEqual(evidence(graph, 'OptionalFallbackConsumer.run', 'LocalRepo.run'), ['bound']);
  assert.deepEqual(evidence(graph, 'NestedDateConsumer.run', 'LocalRepo.run'), ['bound']);
  assert.deepEqual(evidence(graph, 'ShadowDateConsumer.run', 'LocalRepo.run'), ['bound']);
  assert.deepEqual(evidence(graph, 'DirectDateConsumer.run', 'LocalRepo.run'), ['bound']);
});

test('repeated carrier-shaped constructions retain the ordinary target union', async () => {
  const graph = await graphOf([
    'interface Repo { run(): string; }',
    'interface Inputs { repo: Repo; clock?: () => Date; }',
    'class FirstRepo implements Repo { private readonly first = true; run() { return "first"; } }',
    'class SecondRepo implements Repo { private readonly second = true; run() { return "second"; } }',
    'class Controller {',
    '  private readonly clock: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.clock = inputs.clock ?? (() => new Date()); }',
    '  run() { this.clock(); return this.inputs.repo.run(); }',
    '}',
    'const first = new Controller({ repo: new FirstRepo(), clock: undefined });',
    'const second = new Controller({ repo: new SecondRepo(), clock: undefined });',
    'export const readFirst = () => first.run();',
    'export const readSecond = () => second.run();',
  ].join('\n'));
  assert.deepEqual(graph.edges.filter((edge) => edge.from === 'src/main.ts#Controller.run'
    && edge.evidence === 'bound' && edge.to.endsWith('Repo.run')).map((edge) => edge.to), [
    'src/main.ts#FirstRepo.run',
    'src/main.ts#SecondRepo.run',
  ]);
});

test('safe declared self-method dispatch survives unrelated unknown array provenance', async (t) => {
  const source = (
    scratch: boolean,
    serve = 'async serve(value: string) { return this.echo(value); }',
    echo = 'private echo(value: string) { return value; }',
  ): string => [
    'interface Port { send(): string; }',
    'interface Inputs { port: Port; stamp?: () => Date; }',
    'class LocalPort implements Port { send() { return "ok"; } }',
    'declare function use(value: unknown): void;',
    'export class Consumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); }',
    `  ${serve}`,
    `  ${echo}`,
    '}',
    ...(scratch ? [
      'declare const list: unknown[];',
      'const scratch = [...list];',
      'const slot = 0;',
      'scratch[slot] = 1;',
    ] : []),
    'const consumer = new Consumer({ port: new LocalPort(), stamp: undefined });',
    'export const read = () => consumer.serve("value");',
  ].join('\n');
  await t.test('without unrelated write', async () => {
    const graph = await graphOf(source(false));
    assert.ok(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'));
  });
  await t.test('with unrelated write', async () => {
    const graph = await graphOf(source(true));
    assert.ok(evidence(graph, 'Consumer.serve', 'Consumer.echo').some((item) => item === 'direct' || item === 'bound'));
  });
  await t.test('awaited captured result', async () => {
    const graph = await graphOf(source(true, 'async serve(value: string) { const result = await this.echo(value); return result; }'));
    assert.deepEqual(evidence(graph, 'Consumer.serve', 'Consumer.echo'), ['bound']);
  });
  await t.test('inert const prefix', async () => {
    const graph = await graphOf(source(true, [
      'async serve(value: string) {',
      '  const copy = value;',
      '  const marker = "safe";',
      '  const result = await this.echo(copy);',
      '  return result;',
      '}',
    ].join(' ')));
    assert.deepEqual(evidence(graph, 'Consumer.serve', 'Consumer.echo'), ['bound']);
  });
  await t.test('destructured awaited result', async () => {
    const graph = await graphOf(source(
      true,
      'async serve(value: string) { const { label } = await this.echo(value); return label; }',
      'private echo(value: string) { return { label: value }; }',
    ));
    assert.deepEqual(evidence(graph, 'Consumer.serve', 'Consumer.echo'), ['bound']);
  });
  await t.test('later effect after captured result', async () => {
    const graph = await graphOf(source(
      true,
      'async serve(value: string) { const result = await this.echo(value); use(result); return result; }',
    ));
    assert.deepEqual(evidence(graph, 'Consumer.serve', 'Consumer.echo'), ['bound']);
  });
  await t.test('static element self call', async () => {
    const graph = await graphOf(source(true, 'async serve(value: string) { return this["echo"](value); }'));
    assert.ok(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'));
  });
  await t.test('static element receiver and self call', async () => {
    const elementSource = source(true, 'async serve(value: string) { return this["echo"](value); }')
      .replace('consumer.serve(', 'consumer["serve"](');
    const graph = await graphOf(elementSource);
    assert.ok(hasStrongEvidence(graph, 'read', 'Consumer.serve'));
    assert.ok(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'));
  });
});

test('declared self-method exception rejects unsafe entry, call arguments and prior slot effects', async (t) => {
  const source = (serve: string, invocation: string): string => [
    'interface Port { send(): string; }',
    'interface Inputs { port: Port; stamp?: () => Date; }',
    'class LocalPort implements Port { send() { return "ok"; } }',
    'declare function observe(value: unknown): string;',
    'class Consumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); }',
    `  ${serve}`,
    '  private echo(value: string) { return value; }',
    '}',
    'declare const list: unknown[];',
    'const scratch = [...list];',
    'scratch[0] = 1;',
    'const consumer = new Consumer({ port: new LocalPort(), stamp: undefined });',
    `export const read = () => ${invocation};`,
  ].join('\n');
  const cases = [
    ['default entry escape', 'serve(value = observe(this)) { return this.echo(value); }', 'consumer.serve()'],
    ['default entry escape static element', 'serve(value = observe(this)) { return this["echo"](value); }', 'consumer["serve"]()'],
    ['effectful outer argument', 'serve(value: string) { return this.echo(value); }', 'consumer.serve(observe(consumer))'],
    ['prior carrier slot call', 'async serve(value: string) { this.tick(); return this.echo(value); }', 'consumer.serve("value")'],
    ['prior dependency call', 'async serve(value: string) { await this.inputs.port.send(); return this.echo(value); }', 'consumer.serve("value")'],
    ['earlier await', 'async serve(value: string) { await Promise.resolve(); return this.echo(value); }', 'consumer.serve("value")'],
    ['effectful initializer', 'serve(value: string) { const exposed = observe(this); void exposed; return this.echo(value); }', 'consumer.serve("value")'],
    ['arguments escape', 'serve(value: string) { const exposed = arguments; void exposed; return this.echo(value); }', 'consumer.serve("value")'],
    ['rest entry', 'serve(...values: string[]) { return this.echo(values[0]!); }', 'consumer.serve("value")'],
    ['destructured entry', 'serve({ value }: { value: string }) { return this.echo(value); }', 'consumer.serve({ value: "value" })'],
    ['generator entry', '*serve(value: string) { return this.echo(value); }', 'consumer.serve("value")'],
  ] as const;
  for (const [label, serve, invocation] of cases) {
    await t.test(label, async () => {
      const graph = await graphOf(source(serve, invocation));
      assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false, label);
    });
  }
  await t.test('runtime slot collision', async () => {
    const graph = await graphOf(source(
      'serve(value: string) { return this.echo(value); }\n  private echo = (value: string) => value;',
      'consumer.serve("value")',
    ));
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false);
  });
  await t.test('reflected method write', async () => {
    const patched = source('serve(value: string) { return this.echo(value); }', 'consumer.serve("value")')
      .replace('const consumer =', '(Consumer.prototype as { echo: (value: string) => string }).echo = (value) => value;\nconst consumer =');
    const graph = await graphOf(patched);
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false);
  });
  await t.test('instance escape', async () => {
    const escaped = source('serve(value: string) { return this.echo(value); }', 'consumer.serve("value")')
      .replace('const consumer =', 'declare function consume(value: unknown): void;\nconst consumer =')
      .replace('export const read', 'consume(consumer);\nexport const read');
    const graph = await graphOf(escaped);
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false);
  });
  await t.test('later protected uses invalidate repeated recovery', async () => {
    const graph = await graphOf(source(
      [
        'async serve(value: string) {',
        '  const result = await this.echo(value);',
        '  observe(result);',
        '  this.inputs.port.send();',
        '  return this.after(result);',
        '}',
        'private after(value: string) { return value; }',
      ].join(' '),
      'consumer.serve("value")',
    ));
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false);
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.after'), false);
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'LocalPort.send'), false);
  });
});

test('whole-owner protected this effects invalidate repeated self-method recovery', async (t) => {
  const source = (serve: string, declarations: readonly string[] = []): string => [
    'interface Inputs { stamp?: () => Date; }',
    ...declarations,
    'class Consumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); }',
    `  ${serve}`,
    '  private echo(value: string) { return value; }',
    '}',
    'const consumer = new Consumer({ stamp: undefined });',
    'consumer.serve("first");',
    'export const read = () => consumer.serve("second");',
  ].join('\n');
  await t.test('post-call this escape affects later invocation', async () => {
    const graph = await graphOf(source(
      'serve(value: string) { const result = this.echo(value); observe(this); return result; }',
      ['declare function observe(value: unknown): void;'],
    ));
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false);
  });
  await t.test('recursive tail has effectful this argument', async () => {
    const graph = await graphOf(source(
      'serve(value: string) { const result = this.echo(value); return this.serve(patch(this)); }',
      ['declare function patch(value: unknown): string;'],
    ));
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false);
  });
});

test('declared self-method recovery requires unreplaced and unescaped construction', async (t) => {
  const source = (constructor: string, construction: string, extra: readonly string[] = []): string => [
    'interface Port { send(): string; }',
    'interface Inputs { port: Port; stamp?: () => Date; }',
    'class LocalPort implements Port { send() { return "ok"; } }',
    'declare function observe(value: unknown): void;',
    'declare function observeInputs(value: unknown): Inputs;',
    'class Consumer {',
    '  private readonly tick: () => Date;',
    `  ${constructor}`,
    '  async serve(value: string) { return this.echo(value); }',
    '  private echo(value: string) { return value; }',
    '}',
    ...extra,
    'declare const list: unknown[];',
    'const scratch = [...list];',
    'scratch[0] = 1;',
    `const consumer = ${construction};`,
    'export const read = () => consumer.serve("value");',
  ].join('\n');
  const cases = [
    [
      'explicit replacement return',
      'constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); return {} as Consumer; }',
      'new Consumer({ port: new LocalPort(), stamp: undefined })',
      [],
    ],
    [
      'constructor default escape',
      'constructor(private readonly inputs: Inputs = observeInputs(this)) { this.tick = inputs.stamp ?? (() => new Date()); }',
      'new Consumer()',
      [],
    ],
    [
      'constructor body escape',
      'constructor(private readonly inputs: Inputs) { observe(this); this.tick = inputs.stamp ?? (() => new Date()); }',
      'new Consumer({ port: new LocalPort(), stamp: undefined })',
      [],
    ],
    [
      'constructor method shadow',
      'constructor(private readonly inputs: Inputs) { (this as { echo: (value: string) => string }).echo = (value) => value; this.tick = inputs.stamp ?? (() => new Date()); }',
      'new Consumer({ port: new LocalPort(), stamp: undefined })',
      [],
    ],
  ] as const;
  for (const [label, constructor, construction, extra] of cases) {
    await t.test(label, async () => {
      const graph = await graphOf(source(constructor, construction, extra));
      assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false, label);
      if (label === 'explicit replacement return') assert.equal(hasStrongEvidence(graph, 'read', 'Consumer.serve'), false, label);
    });
  }
  await t.test('explicit replacement static element calls', async () => {
    const elementSource = source(
      'constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); return {} as Consumer; }',
      'new Consumer({ port: new LocalPort(), stamp: undefined })',
    ).replace('this.echo(value)', 'this["echo"](value)').replace('consumer.serve(', 'consumer["serve"](');
    const graph = await graphOf(elementSource);
    assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false);
    assert.equal(hasStrongEvidence(graph, 'read', 'Consumer.serve'), false);
  });
});

test('unsafe carrier construction aliases defer direct methods without global mutation', async () => {
  const graph = await graphOf([
    'interface Port { send(): string; }',
    'interface Inputs { port: Port; stamp?: () => Date; }',
    'class LocalPort implements Port { send() { return "ok"; } }',
    'class Consumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); return {} as Consumer; }',
    '  serve(value: string) { return value; }',
    '}',
    'const create = () => new Consumer({ port: new LocalPort(), stamp: undefined });',
    'let mutable = create();',
    'const holder = { consumer: create() };',
    'function make() { return create(); }',
    'function callParameter(value: Consumer) { return value.serve("value"); }',
    'export const readMutable = () => mutable.serve("value");',
    'export const readHolder = () => holder.consumer.serve("value");',
    'export const readFactory = () => make().serve("value");',
    'export const readParameter = () => callParameter(create());',
    '',
    'class PlainConsumer { serve(value: string) { return value; } }',
    'const createPlain = () => new PlainConsumer();',
    'let plainMutable = createPlain();',
    'const plainHolder = { consumer: createPlain() };',
    'function makePlain() { return createPlain(); }',
    'function callPlainParameter(value: PlainConsumer) { return value.serve("value"); }',
    'export const readPlainMutable = () => plainMutable.serve("value");',
    'export const readPlainHolder = () => plainHolder.consumer.serve("value");',
    'export const readPlainFactory = () => makePlain().serve("value");',
    'export const readPlainParameter = () => callPlainParameter(createPlain());',
    '',
    'class SafeConsumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); }',
    '  serve(value: string) { return value; }',
    '}',
    'const safeHolder = { consumer: new SafeConsumer({ port: new LocalPort(), stamp: undefined }) };',
    'export const readSafeHolder = () => safeHolder.consumer.serve("value");',
  ].join('\n'));
  for (const from of ['readMutable', 'readHolder', 'readFactory', 'callParameter']) {
    assert.equal(hasStrongEvidence(graph, from, 'Consumer.serve'), false, from);
  }
  for (const from of ['readPlainMutable', 'readPlainHolder', 'readPlainFactory', 'callPlainParameter']) {
    assert.equal(hasStrongEvidence(graph, from, 'PlainConsumer.serve'), true, from);
  }
  assert.equal(hasStrongEvidence(graph, 'readSafeHolder', 'SafeConsumer.serve'), true);
});

test('carrier-role lineage rejects replacing subclass overrides without suppressing ordinary subclasses', async () => {
  const graph = await graphOf([
    'interface Port { send(): string; }',
    'interface Inputs { port: Port; stamp?: () => Date; }',
    'class LocalPort implements Port { send() { return "ok"; } }',
    'class Consumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); }',
    '  serve(value: string) { return this.echo(value); }',
    '  protected echo(value: string) { return value; }',
    '}',
    'class Sub extends Consumer {',
    '  constructor() { super({ port: new LocalPort(), stamp: undefined }); return {} as Sub; }',
    '  override serve(value: string) { return this.echo(value); }',
    '}',
    'const replaced = new Sub();',
    'export const readReplaced = () => replaced.serve("value");',
    '',
    'class PlainBase { serve(value: string) { return this.echo(value); } protected echo(value: string) { return value; } }',
    'class PlainSub extends PlainBase { override serve(value: string) { return this.echo(value); } }',
    'const plain = new PlainSub();',
    'export const readPlain = () => plain.serve("value");',
  ].join('\n'));
  assert.equal(hasStrongEvidence(graph, 'readReplaced', 'Sub.serve'), false);
  assert.equal(hasStrongEvidence(graph, 'Sub.serve', 'Consumer.echo'), false);
  assert.equal(hasStrongEvidence(graph, 'readPlain', 'PlainSub.serve'), true);
  assert.equal(hasStrongEvidence(graph, 'PlainSub.serve', 'PlainBase.echo'), true);
});

test('known allocation identity rejects disjoint cast member owners', async () => {
  const graph = await graphOf([
    'interface Port { send(): string; }',
    'interface Inputs { port: Port; stamp?: () => Date; }',
    'class LocalPort implements Port { send() { return "ok"; } }',
    'class Consumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); }',
    '  serve(value: string) { return "consumer:" + value; }',
    '}',
    'class Other { serve(value: string) { return "other:" + value; } }',
    'class OtherProperty { serve = (value: string) => "property:" + value; }',
    'class OtherGetter { get serve() { return (value: string) => "getter:" + value; } }',
    'const consumer = new Consumer({ port: new LocalPort(), stamp: undefined });',
    'export const readCast = () => (consumer as unknown as Other).serve("x");',
    'export const readElementCast = () => (consumer as unknown as Other)["serve"]("x");',
    'export const readPropertyCast = () => (consumer as unknown as OtherProperty).serve("x");',
    'export const readGetterCast = () => (consumer as unknown as OtherGetter).serve("x");',
    'export const readUnionCast = () => (consumer as Consumer | Other).serve("x");',
    'export const readUnionElementCast = () => (consumer as Consumer | Other)["serve"]("x");',
    'export const readSame = () => (consumer as unknown as Consumer).serve("x");',
    'class PlainBase { serve(value: string) { return value; } }',
    'class PlainSub extends PlainBase {}',
    'const plain = new PlainSub();',
    'export const readBase = () => (plain as PlainBase).serve("x");',
  ].join('\n'));
  for (const [from, wrong] of [
    ['readCast', 'Other.serve'],
    ['readElementCast', 'Other.serve'],
    ['readPropertyCast', 'OtherProperty.serve'],
    ['readGetterCast', 'OtherGetter.serve'],
    ['readUnionCast', 'Other.serve'],
    ['readUnionElementCast', 'Other.serve'],
  ] as const) {
    assert.equal(hasStrongEvidence(graph, from, wrong), false, `${from} -> ${wrong}`);
    assert.equal(hasStrongEvidence(graph, from, 'Consumer.serve'), true, `${from} -> Consumer.serve`);
  }
  assert.equal(hasStrongEvidence(graph, 'readSame', 'Consumer.serve'), true);
  assert.equal(hasStrongEvidence(graph, 'readBase', 'PlainBase.serve'), true);
});

test('member-owner compatibility is asymmetric for downcasts and mixed descendants', async () => {
  const graph = await graphOf([
    'class Base { serve(value: string) { return "base:" + value; } }',
    'class Sub extends Base { override serve(value: string) { return "sub:" + value; } subOnly() { return "sub"; } }',
    'const base = new Base();',
    'const sub = new Sub();',
    'export const readDowncast = () => (base as Sub).serve("x");',
    'export const readDowncastElement = () => (base as Sub)["serve"]("x");',
    'export const readDescendantOnly = () => (base as Sub).subOnly();',
    'export const readUnion = () => (base as Base | Sub).serve("x");',
    'export const readUnionElement = () => (base as Base | Sub)["serve"]("x");',
    'export const readUpcast = () => (sub as Base).serve("x");',
    'export const readUpcastElement = () => (sub as Base)["serve"]("x");',
    'const typedBase: Base = new Sub();',
    'export const readTypedBase = () => typedBase.serve("x");',
    'export const readTypedBaseElement = () => typedBase["serve"]("x");',
    'class BaseNoOverride { serve(value: string) { return value; } }',
    'class SubNoOverride extends BaseNoOverride {}',
    'const noOverride = new SubNoOverride();',
    'export const readNoOverride = () => (noOverride as BaseNoOverride).serve("x");',
  ].join('\n'));
  for (const from of ['readDowncast', 'readDowncastElement', 'readUnion', 'readUnionElement']) {
    assert.equal(hasStrongEvidence(graph, from, 'Sub.serve'), false, from);
    assert.equal(hasStrongEvidence(graph, from, 'Base.serve'), true, from);
  }
  assert.equal(hasStrongEvidence(graph, 'readDescendantOnly', 'Sub.subOnly'), false);
  for (const from of ['readUpcast', 'readUpcastElement', 'readTypedBase', 'readTypedBaseElement']) {
    assert.equal(hasStrongEvidence(graph, from, 'Sub.serve'), true, `${from} -> Sub.serve`);
    assert.equal(hasStrongEvidence(graph, from, 'Base.serve'), false, `${from} -> Base.serve`);
  }
  assert.equal(hasStrongEvidence(graph, 'readNoOverride', 'BaseNoOverride.serve'), true);
});

test('sibling instance effects cannot authorize later declared self-method lookup', async () => {
  const graph = await graphOf([
    'interface Inputs { stamp?: () => Date; }',
    'declare function observe(value: unknown): void;',
    'declare function patch(value: unknown): string;',
    'class Consumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); }',
    '  prime() { observe(this); }',
    '  other(value: string) { return this.serve(patch(this)); }',
    '  serve(value: string) { return this.echo(value); }',
    '  private echo(value: string) { return value; }',
    '}',
    'const consumer = new Consumer({ stamp: undefined });',
    'consumer.prime();',
    'export const read = () => consumer.serve("x");',
    'export const readOther = () => consumer.other("x");',
  ].join('\n'));
  assert.equal(hasStrongEvidence(graph, 'Consumer.serve', 'Consumer.echo'), false);
  assert.equal(hasStrongEvidence(graph, 'Consumer.other', 'Consumer.serve'), false);
});

test('full carrier proof restores memo and wrapper method identity', async (t) => {
  const header = [
    'interface Repo { run(): string; }',
    'interface Inputs { repo: Repo; clock?: () => Date; }',
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner {',
    '  private readonly clock: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.clock = inputs.clock ?? (() => new Date()); }',
    '  run() { this.clock(); return this.inputs.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    'const scratch = [0];',
    'const key = 0;',
    'scratch[key] = 1;',
  ].join('\n');
  const cases = [
    ['memo', `${header}\nlet memo: { runner: Runner } | null = null;\nfunction deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }\nconst { runner } = deps();\nexport const read = () => runner.run();`],
    ['wrapper', `${header}\nconst runner = new Runner({ repo: live, clock: undefined });\nfunction wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const read = () => wrap(runner, (value) => value.run());`],
  ] as const;
  for (const [label, source] of cases) {
    await t.test(label, async () => {
      const graph = await graphOf(source);
      assert.ok(graph.edges.some((edge) => edge.to === 'src/main.ts#Runner.run' && edge.evidence === 'bound'), label);
      assert.deepEqual(evidence(graph, 'Runner.run', 'RepoImpl.run'), ['bound']);
    });
  }
  const unsafe = [
    ['entry', `${header.replace('  run() { this.clock();', '  run(value = observe(this)) { this.clock();')}\ndeclare function observe(value: unknown): unknown;\nconst runner = new Runner({ repo: live, clock: undefined });\nexport const read = () => runner.run();`],
    ['wrapper arguments', `${header}\nconst runner = new Runner({ repo: live, clock: undefined });\nfunction wrap(value: Runner, callback: (value: Runner) => string) { void arguments; return callback(value); }\nexport const read = () => wrap(runner, (value) => value.run());`],
    ['escape', `${header}\ndeclare function consume(value: unknown): void;\nconst runner = new Runner({ repo: live, clock: undefined });\nconsume(runner);\nexport const read = () => runner.run();`],
  ] as const;
  for (const [label, source] of unsafe) {
    await t.test(`unsafe ${label}`, async () => {
      const graph = await graphOf(source);
      if (label === 'entry') {
        assert.equal(hasStrongEvidence(graph, 'Runner.run', 'RepoImpl.run'), false,
          `${label}: ${JSON.stringify(evidence(graph, 'Runner.run', 'RepoImpl.run'))}`);
      } else {
        assert.equal(graph.edges.some((edge) => edge.to === 'src/main.ts#Runner.run'
          && edge.kinds.includes('call') && (edge.evidence === 'direct' || edge.evidence === 'bound')), false, label);
      }
    });
  }
});

test('nonliteral carrier bags and instanceof class uses remain conservative', async () => {
  const graph = await graphOf([
    'interface Inputs { stamp?: () => Date; }',
    'class Consumer {',
    '  private readonly tick: () => Date;',
    '  constructor(private readonly inputs: Inputs) { this.tick = inputs.stamp ?? (() => new Date()); }',
    '  serve(value: string) { return value; }',
    '}',
    'const inputs: Inputs = { stamp: undefined };',
    'const aliased = new Consumer(inputs);',
    'export const readAliased = () => aliased.serve("x");',
    'const checked = new Consumer({ stamp: undefined });',
    'export const isConsumer = checked instanceof Consumer;',
    'export const readChecked = () => checked.serve("x");',
    'class Plain { constructor(readonly value: string) {} serve() { return this.value; } }',
    'const plainValue = "plain";',
    'const plainAliased = new Plain(plainValue);',
    'export const readPlainAliased = () => plainAliased.serve();',
    'const plainChecked = new Plain("checked");',
    'export const isPlain = plainChecked instanceof Plain;',
    'export const readPlainChecked = () => plainChecked.serve();',
  ].join('\n'));
  assert.equal(hasStrongEvidence(graph, 'readAliased', 'Consumer.serve'), false);
  assert.equal(hasStrongEvidence(graph, 'readChecked', 'Consumer.serve'), false);
  assert.equal(hasStrongEvidence(graph, 'readPlainAliased', 'Plain.serve'), true);
  assert.equal(hasStrongEvidence(graph, 'readPlainChecked', 'Plain.serve'), true);
});

test('stage2 graph query order preserves carrier targets and known-reflection fence', async () => {
  const calls = ['export const readA = () => controller.run();', 'export const readB = () => controller.run();'];
  for (const reflection of ['', 'Object.assign(controller, { replaced: true });']) {
    const source = (reverse: boolean) => carrierSource({ use: [...(reflection ? [reflection] : []), ...(reverse ? [...calls].reverse() : calls)] });
    const first = await graphOf(source(false)); const second = await graphOf(source(true));
    const targets = (graph: CallGraph) => graph.edges.filter((edge) => edge.kinds.includes('call'))
      .map((edge) => [edge.from, edge.to, edge.evidence].join(' ')).sort();
    assert.deepEqual(targets(first), targets(second));
    if (reflection) assertNoControllerBoundService(first, 'known reflective membership');
    else assert.deepEqual(evidence(first, 'Controller.run', 'LocalRepo.run'), ['bound']);
  }
});

test('stage2 carrier exhaustion is charged to caller and emits one graph diagnostic channel', async () => {
  const source = carrierSource().replace('this.clock = inputs.clock ?? (() => new Date());',
    `this.clock = inputs.clock ?? (() => new Date()); ${';'.repeat(20_050)}`);
  const graph = await graphOf(source);
  assertNoControllerBoundService(graph, 'caller step exhaustion');
  const count = graph.statistics.calls.dispatch.overBudget;
  assert.ok(count > 0);
  const diagnostics = graph.limitations.filter((line) => line.startsWith('dispatch-budget:'));
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0]!.startsWith(`dispatch-budget: ${count} deferred`));
  assert.equal(graph.limitations.some((line) => line.startsWith('carrier-proof: rejected(syntax)')), false);
});


test('stage2 graph retains distinct syntax and authoritative coverage limitations', async () => {
  const syntax = await graphOf(carrierSource({ method: '  run(value = this) { this.clock(); return this.inputs.repo.run(); }' }));
  assertNoControllerBoundService(syntax, 'unsupported runtime entry');
  assert.ok(syntax.limitations.some((line) => line.startsWith('carrier-proof: rejected(syntax)')));
});
