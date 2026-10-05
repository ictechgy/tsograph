/**
 * private constructor dependency carrier의 공개 AST 계약을 검증한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { buildFileIndex, type FlowIndex } from './flow-index.ts';
import type { EffectInventory } from './effect-inventory.ts';
import { ConstructorCarrierAnalyzer, proveConstructorCarrier, type ConstructorCarrierContext } from './constructor-carrier.ts';

interface IndexedSource {
  readonly program: ts.Program;
  readonly file: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly index: FlowIndex;
}

async function graphOf(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-constructor-carrier-')));
  try {
    const all = {
      'tsconfig.json': '{ "compilerOptions": { "strict": true, "types": [], "lib": ["es2022"], "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
      ...files,
    };
    for (const [path, content] of Object.entries(all)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, createNodeFileSystem());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function indexedSource(source: string, compilerOptions: ts.CompilerOptions = {}): IndexedSource {
  const options: ts.CompilerOptions = {
    strict: true,
    // 표준 Map·Date 근거를 유지하되 무관한 DOM·호스트 ambient 선언은 로드하지 않는다.
    types: [],
    lib: ['lib.es2022.d.ts'],
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    ...compilerOptions,
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => name === 'main.ts'
    ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.TS)
    : original.call(host, name, version, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({ rootNames: ['main.ts'], options, host });
  const file = program.getSourceFile('main.ts');
  assert.ok(file);
  const checker = program.getTypeChecker();
  return { program, file, checker, index: buildFileIndex(checker, file, () => undefined) };
}

function contextOf(source: string, compilerOptions: ts.CompilerOptions = {}): { source: IndexedSource; context: ConstructorCarrierContext; runner: ts.ClassLikeDeclaration } {
  const indexed = indexedSource(source, compilerOptions);
  let runner: ts.ClassLikeDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name?.text === 'Runner') runner = node;
    ts.forEachChild(node, visit);
  };
  visit(indexed.file);
  assert.ok(runner);
  const context: ConstructorCarrierContext = {
    checker: indexed.checker,
    index: indexed.index,
    policy: {
      isProjectFile: (file) => file === indexed.file,
      isOpenCallable: () => false,
      isOverridden: () => false,
      openProperties: false,
      isDefaultLibraryFile: (file) => indexed.program.isSourceFileDefaultLibrary(file),
    },
  };
  return { source: indexed, context, runner };
}

/** Stage2 capability tests use an authoritative synthetic inventory witness. */
function completeInventory(): EffectInventory {
  return {
    manifest: {} as EffectInventory['manifest'],
    enumeration: 'complete',
    referenceAliases: 'complete',
    initialization: 'complete',
    ambientSafety: 'safe',
    records: [],
    reasons: [],
  };
}

function carrierResult(source: string) {
  const { context, runner } = contextOf(source);
  return proveConstructorCarrier(context, runner);
}

function carrierResultWithOptions(source: string, compilerOptions: ts.CompilerOptions) {
  const { context, runner } = contextOf(source, compilerOptions);
  return proveConstructorCarrier(context, runner);
}

const positive = [
  'interface Repo { run(): string; }',
  'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
  'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
  'class Runner {',
  '  private readonly clock: () => Date;',
  '  constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
  '  run() { this.clock(); return this.deps.repo.run(); }',
  '}',
  'const live: Repo = new RepoImpl();',
  'const runner = new Runner({ repo: live, clock: undefined });',
  'export const run = () => runner.run();',
].join('\n');

function optionalKeyCarrier(key: string, value: string | undefined, cast = false): string {
  const argument = value === undefined ? '{ repo: live }' : `{ repo: live, ${key}: ${value} }`;
  const typedArgument = cast ? `${argument} as RunnerDeps` : argument;
  return [
    'interface Repo { run(): string; }',
    `interface RunnerDeps { repo: Repo; ${key}?: () => Date; }`,
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner {',
    '  private readonly clock: () => Date;',
    `  constructor(private readonly deps: RunnerDeps) { this.clock = deps.${key} ?? (() => new Date()); }`,
    '  run() { this.clock(); return this.deps.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    `const runner = new Runner(${typedArgument});`,
    'export const run = () => runner.run();',
  ].join('\n');
}

test('stage0 requires an explicitly present own optional value, including inherited-name collisions', () => {
  for (const key of ['toString', 'constructor']) {
    assert.equal(carrierResult(optionalKeyCarrier(key, undefined)) === undefined, true, `${key} omission`);
    assert.equal(carrierResult(optionalKeyCarrier(key, undefined, true)) === undefined, true, `${key} cast omission`);
    assert.ok(carrierResult(optionalKeyCarrier(key, 'undefined')), `${key} own undefined`);
    assert.ok(carrierResult(optionalKeyCarrier(key, 'null')), `${key} own null`);
    assert.ok(carrierResult(optionalKeyCarrier(key, '() => new Date()')), `${key} own pure Date`);
  }
});

test('stage0 audits carrier method entry and rejects unproved body coercion', () => {
  const method = '  run() { this.clock(); return this.deps.repo.run(); }';
  const entryCases = [
    positive.replace(method, '  run(value: unknown) { this.clock(); return this.deps.repo.run(); }'),
    `${positive}\ndeclare function observe(value: Runner): unknown;`.replace(method, '  run(value = observe(this)) { this.clock(); return this.deps.repo.run(); }'),
    positive.replace(method, '  run(...values: unknown[]) { this.clock(); return this.deps.repo.run(); }'),
    positive.replace(method, '  run({ value }: { value: unknown }) { this.clock(); return this.deps.repo.run(); }'),
    positive.replace(method, '  async run() { this.clock(); return this.deps.repo.run(); }'),
    positive.replace(method, '  *run() { this.clock(); return this.deps.repo.run(); }'),
    positive.replace('export const run = () => runner.run();', 'export const run = () => runner.run(1);'),
    positive.replace('export const run = () => runner.run();', 'export const run = () => new Runner({ repo: live, clock: undefined }).run(1);'),
    `${positive}\nfunction wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run(1));`,
    positive.replace('return this.deps.repo.run();', 'return this.deps.repo.run() + "";'),
    positive.replace('return this.deps.repo.run();', 'const value = this.deps.repo.run(); return value;'),
    positive.replace('return this.deps.repo.run();', 'return this.deps.repo.run() as unknown as string;'),
  ];
  for (const source of entryCases) assert.equal(carrierResult(source) === undefined, true, source);
  assert.ok(carrierResult(positive.replace(
    method,
    '  run() { (this.clock()); return (this.deps.repo.run()); }',
  )));
  assert.equal(carrierResult(positive.replace(
    method,
    '  run() { (this.clock() as unknown); return this.deps.repo.run(); }',
  )) === undefined, true);
  assert.ok(carrierResult(positive));
});

test('stage0 normalizes parameter, field, and prototype-sensitive runtime slots', () => {
  const parameterPrototypeSlot = positive
    .replace('private readonly deps', 'private readonly __proto__')
    .replace('deps.clock', '__proto__.clock')
    .replace('this.deps', 'this.__proto__');
  const methodFieldCollision = positive.replace('class Runner {', 'class Runner {\n  clock() {}');
  const parameterMethodCollision = positive.replace('class Runner {', 'class Runner {\n  deps() {}');
  const optionalBagParameter = positive.replace(
    'constructor(private readonly deps: RunnerDeps)',
    'constructor(private readonly deps?: RunnerDeps)',
  );
  const decoratedBagParameter = positive.replace(
    'constructor(private readonly deps: RunnerDeps)',
    'constructor(@inject private readonly deps: RunnerDeps)',
  );
  for (const useDefineForClassFields of [false, true]) {
    const options = { useDefineForClassFields };
    const indexed = contextOf(positive, options);
    assert.ok(proveConstructorCarrier(indexed.context, indexed.runner));
    assert.equal(carrierResultWithOptions(parameterPrototypeSlot, options) === undefined, true, `__proto__ / ${useDefineForClassFields}`);
    assert.equal(carrierResultWithOptions(methodFieldCollision, options) === undefined, true, `field/method / ${useDefineForClassFields}`);
    assert.equal(carrierResultWithOptions(parameterMethodCollision, options) === undefined, true, `parameter/method / ${useDefineForClassFields}`);
    assert.equal(carrierResultWithOptions(optionalBagParameter, options) === undefined, true, `optional bag / ${useDefineForClassFields}`);
    assert.equal(carrierResultWithOptions(decoratedBagParameter, options) === undefined, true, `decorated bag / ${useDefineForClassFields}`);
  }
});

test('정확히 한 번 생성된 private readonly bag carrier와 Date fallback을 증명한다', () => {
  const { context, runner } = contextOf(positive);
  const proof = proveConstructorCarrier(context, runner);
  assert.ok(proof);
  assert.equal(proof.bagParameter.name.getText(), 'deps');
  assert.deepEqual([...proof.bagKeys].sort(), ['clock', 'repo']);
  assert.ok(proof.serviceUses.some((use) => use.methodName === 'run'));
});

test('analyzer는 완료 결과·재진입·예산 경계를 분리하고 내부 stack failure를 전파한다', () => {
  const { context, runner } = contextOf(positive);
  const analyzer = new ConstructorCarrierAnalyzer(context);
  const proof = analyzer.prove(runner);
  assert.ok(proof);
  assert.equal(analyzer.prove(runner), proof);

  let projectChecks = 0;
  const rejected = new ConstructorCarrierAnalyzer({
    ...context,
    policy: {
      ...context.policy,
      isProjectFile: () => {
        projectChecks++;
        return false;
      },
    },
  });
  assert.equal(rejected.prove(runner), undefined);
  assert.equal(rejected.prove(runner), undefined);
  assert.equal(projectChecks, 2);

  let reentered: ReturnType<ConstructorCarrierAnalyzer['prove']> | null = null;
  let firstProjectCheck = true;
  let reentrant!: ConstructorCarrierAnalyzer;
  reentrant = new ConstructorCarrierAnalyzer({
    ...context,
    policy: {
      ...context.policy,
      isProjectFile: (file) => {
        if (firstProjectCheck) {
          firstProjectCheck = false;
          reentered = reentrant.prove(runner);
        }
        return context.policy.isProjectFile(file);
      },
    },
  });
  assert.ok(reentrant.prove(runner));
  assert.equal(reentered, undefined);

  const rangeError = new ConstructorCarrierAnalyzer({
    ...context,
    policy: { ...context.policy, isProjectFile: () => { throw new RangeError('bounded recursion'); } },
  });
  assert.throws(() => rangeError.prove(runner), RangeError);
  const unexpected = new ConstructorCarrierAnalyzer({
    ...context,
    policy: { ...context.policy, isProjectFile: () => { throw new Error('unexpected analyzer failure'); } },
  });
  assert.throws(() => unexpected.prove(runner), /unexpected analyzer failure/);

  assert.ok(runner.name);
  const classSymbol = context.checker.getSymbolAtLocation(runner.name);
  assert.ok(classSymbol);
  const references = new Map(context.index.references);
  const originalReference = references.get(classSymbol)?.[0];
  assert.ok(originalReference);
  references.set(classSymbol, Array.from({ length: 20_050 }, () => originalReference));
  const exhausted = new ConstructorCarrierAnalyzer({ ...context, index: { ...context.index, references } });
  assert.equal(exhausted.prove(runner), undefined);

  let instanceFlowChecks = 0;
  const instanceFlow = new ConstructorCarrierAnalyzer({
    ...context,
    policy: {
      ...context.policy,
      isProjectFile: (file) => {
        instanceFlowChecks++;
        return context.policy.isProjectFile(file);
      },
    },
  });
  assert.equal(instanceFlow.allowsInstanceFlow(runner), true);
  const completedChecks = instanceFlowChecks;
  assert.equal(instanceFlow.allowsInstanceFlow(runner), true);
  assert.equal(instanceFlowChecks, completedChecks);

  let exhaustedFlowChecks = 0;
  const exhaustedFlow = new ConstructorCarrierAnalyzer({
    ...context,
    index: { ...context.index, references },
    policy: {
      ...context.policy,
      isProjectFile: (file) => {
        exhaustedFlowChecks++;
        return context.policy.isProjectFile(file);
      },
    },
  });
  assert.equal(exhaustedFlow.allowsInstanceFlow(runner), false);
  const firstExhaustedChecks = exhaustedFlowChecks;
  assert.equal(exhaustedFlow.allowsInstanceFlow(runner), false);
  assert.ok(exhaustedFlowChecks > firstExhaustedChecks);

  let rangeFlowChecks = 0;
  const rangeFlow = new ConstructorCarrierAnalyzer({
    ...context,
    policy: {
      ...context.policy,
      isProjectFile: () => {
        rangeFlowChecks++;
        throw new RangeError('bounded instance-flow recursion');
      },
    },
  });
  assert.throws(() => rangeFlow.allowsInstanceFlow(runner), RangeError);
  assert.throws(() => rangeFlow.allowsInstanceFlow(runner), RangeError);
  assert.equal(rangeFlowChecks, 2);

  const unexpectedFlow = new ConstructorCarrierAnalyzer({
    ...context,
    policy: { ...context.policy, isProjectFile: () => { throw new TypeError('unexpected instance-flow failure'); } },
  });
  assert.throws(() => unexpectedFlow.allowsInstanceFlow(runner), /unexpected instance-flow failure/);
});

test('declared-method receiver certificate excludes constructor replacement, entry escape, effects and shadowing', () => {
  const receiverAllowed = (source: string): boolean => {
    const { context, runner } = contextOf(source);
    return new ConstructorCarrierAnalyzer(context).allowsDeclaredMethodReceiver(runner);
  };
  const safeReceiver = positive.replace(
    '  run() { this.clock(); return this.deps.repo.run(); }',
    '  run() { return "ok"; }',
  );
  assert.equal(receiverAllowed(safeReceiver), true);
  const cases = [
    safeReceiver.replace(
      'this.clock = deps.clock ?? (() => new Date()); }',
      'this.clock = deps.clock ?? (() => new Date()); return {} as Runner; }',
    ),
    `${safeReceiver}\ndeclare function observeInputs(value: unknown): RunnerDeps;`.replace(
      'constructor(private readonly deps: RunnerDeps)',
      'constructor(private readonly deps: RunnerDeps = observeInputs(this))',
    ),
    `${safeReceiver}\ndeclare function observe(value: unknown): void;`.replace(
      '{ this.clock = deps.clock ?? (() => new Date()); }',
      '{ observe(this); this.clock = deps.clock ?? (() => new Date()); }',
    ),
    safeReceiver.replace(
      'this.clock = deps.clock ?? (() => new Date());',
      '(this as { run: () => string }).run = () => "patched"; this.clock = deps.clock ?? (() => new Date());',
    ),
    safeReceiver.replace('class Runner {', 'class Runner {\n  private run = () => "field";'),
  ];
  for (const source of cases) assert.equal(receiverAllowed(source), false, source);
});

test('private module memo outer literal의 one-level projection binding도 전체 소비를 확인한다', () => {
  const source = [
    'interface Repo { run(): string; }',
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner {',
    '  private readonly clock: () => Date;',
    '  constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
    '  run() { this.clock(); return this.deps.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    'let memo: { runner: Runner } | null = null;',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
    'const { runner } = deps();',
    'export const run = () => runner.run();',
    'function wrap(make: () => { runner: Runner }, callback: (runner: Runner) => string) { const { runner } = make(); return callback(runner); }',
    'export const wrapped = wrap(deps, (runner) => runner.run());',
  ].join('\n');
  const { context, runner } = contextOf(source);
  const proof = proveConstructorCarrier(context, runner);
  assert.ok(proof);
  assert.equal(proof.projectionBindings.length, 2);
  assert.ok(proof.projectionBindings.every((binding) => binding.key === 'runner'));
  assert.ok(carrierResult(source.replace('(runner) => runner.run()', '((runner) => runner.run())')));

  const equalityGuard = source.replace('if (!memo)', 'if (memo === null)');
  assert.ok(carrierResult(equalityGuard));
  const guardedFactories = [
    'function deps() { if (memo) {} else memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; memo ? undefined : undefined; return memo; }',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; !memo ? undefined : undefined; return memo; }',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; while (memo === null) { break; } return memo; }',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; do {} while (memo === null); return memo; }',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; for (; memo === null;) { break; } return memo; }',
    'function deps() { if (memo !== null) {} else memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
  ];
  for (const factory of guardedFactories) assert.ok(carrierResult(source.replace(
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
    factory,
  )), factory);
  const duplicateFactory = source.replace(
    'function wrap(make: () => { runner: Runner }, callback: (runner: Runner) => string) { const { runner } = make(); return callback(runner); }\nexport const wrapped = wrap(deps, (runner) => runner.run());',
    'function consume(_value: unknown) {}\nfunction wrap(first: () => { runner: Runner }, second: () => { runner: Runner }, callback: (runner: Runner) => string) { const { runner } = first(); consume(second()); return callback(runner); }\nexport const wrapped = wrap(deps, deps, (runner) => runner.run());',
  );
  assert.equal(carrierResult(duplicateFactory) === undefined, true);
  const unsafeWrite = source.replace(
    'function deps()',
    'function corrupt(other: { runner: Runner }) { memo = other; }\nfunction deps()',
  );
  assert.equal(carrierResult(unsafeWrite) === undefined, true);
  const arrowFactory = source.replace('function deps() {', 'const deps = () => {');
  assert.equal(carrierResult(arrowFactory) === undefined, true);
});

test('별칭·전체 인자 전달·computed this와 순환 생성은 닫힌 증명이 아니다', () => {
  const cases = [
    `${positive}\nconst alias = runner; export const aliasRun = () => alias.run();`,
    `${positive}\nfunction consume(_runner: Runner) {} consume(runner);`,
    `${positive}\nfunction namedCallback() { return runner.run(); } export const namedRun = () => namedCallback();`,
    positive.replace('return this.deps.repo.run();', 'return this["deps"].repo.run();'),
    positive.replace('const runner = new Runner({ repo: live, clock: undefined });', 'const runner = new Runner({ repo: live, clock: undefined });\nnew Runner({ repo: runner as unknown as Repo });'),
  ];
  for (const source of cases) {
    const { context, runner } = contextOf(source);
    assert.equal(proveConstructorCarrier(context, runner) === undefined, true, source);
  }
});

test('bag·optional Date key·instance fallback field 이름은 고정되지 않는다', () => {
  const source = [
    'interface Port { run(): string; }',
    'interface Resources { data: Port; timestamp?: () => Date; }',
    'class PortImpl implements Port { private readonly brand = true; run() { return "ok"; } }',
    'class Runner {',
    '  private readonly timeSource: () => Date;',
    '  constructor(private readonly resources: Resources) { this.timeSource = resources.timestamp ?? (() => new Date()); }',
    '  run() { this.timeSource(); return this.resources.data.run(); }',
    '}',
    'const port: Port = new PortImpl();',
    'const runner = new Runner({ data: port, timestamp: undefined });',
    'export const run = () => runner.run();',
  ].join('\n');
  const { context, runner } = contextOf(source);
  assert.ok(proveConstructorCarrier(context, runner));
});

test('carrier의 구조·bag·constructor 경계를 모두 닫고 immediate known method 소비는 허용한다', () => {
  const indexed = contextOf(positive);
  assert.equal(proveConstructorCarrier({
    ...indexed.context,
    policy: { ...indexed.context.policy, isProjectFile: () => false },
  }, indexed.runner) === undefined, true);
  assert.equal(proveConstructorCarrier({
    ...indexed.context,
    policy: { ...indexed.context.policy, isOpenCallable: () => true },
  }, indexed.runner) === undefined, true);

  const immediate = positive.replace(
    'const runner = new Runner({ repo: live, clock: undefined });\nexport const run = () => runner.run();',
    'export const run = () => new Runner({ repo: live, clock: undefined }).run();',
  );
  assert.ok(carrierResult(immediate));
  assert.ok(carrierResult(positive.replace(
    'constructor(private readonly deps: RunnerDeps)',
    'constructor(private readonly deps: (RunnerDeps))',
  )));
  const classExpression = positive.replace('class Runner {', 'const Runner = class Runner {')
    .replace('}\nconst live: Repo', '};\nconst live: Repo');
  assert.ok(carrierResult(classExpression));

  const importedTypeAlias = positive.replace(
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'namespace Types { export interface RunnerDeps { repo: Repo; clock?: () => Date; } }\nimport RunnerDeps = Types.RunnerDeps;',
  );
  assert.ok(carrierResult(importedTypeAlias));

  const cases = [
    positive.replace('class Runner {', 'class Runner extends RepoImpl {'),
    `${positive}\nclass Specialized extends Runner {}`,
    positive.replace('class Runner {', 'export class Runner {'),
    positive.replace('class Runner {', '@sealed\nclass Runner {'),
    positive.replace('  run() { this.clock(); return this.deps.repo.run(); }', '  @logged run() { this.clock(); return this.deps.repo.run(); }'),
    positive.replace('const runner = new Runner({ repo: live, clock: undefined });', 'export const runner = new Runner({ repo: live, clock: undefined });'),
    `${positive}\nexport { runner };`,
    classExpression.replace('const Runner =', 'export const Runner ='),
    classExpression.replace('const Runner = class Runner', 'const holder = { Runner: class Runner')
      .replace('};\nconst live: Repo', '} };\nconst Runner = holder.Runner;\nconst live: Repo'),
    positive.replace(
      'constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
      'constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); return {} as Runner; }',
    ),
    positive.replace('constructor(private readonly deps: RunnerDeps)', 'constructor(private readonly deps: RunnerDeps, extra: unknown)'),
    positive.replace('constructor(private readonly deps: RunnerDeps)', 'constructor(private deps: RunnerDeps)'),
    positive.replace('constructor(private readonly deps: RunnerDeps)', 'constructor(private readonly deps: RunnerDeps = { repo: live })'),
    positive.replace('constructor(private readonly deps: RunnerDeps)', 'constructor(private readonly deps)'),
    positive.replace(
      'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
      'interface BaseDeps { repo: Repo; } interface RunnerDeps extends BaseDeps { clock?: () => Date; }',
    ),
    positive.replace(
      'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
      'class RunnerDeps { repo!: Repo; clock?: () => Date; }',
    ),
    positive.replace(
      'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
      'type RunnerDeps = readonly [Repo];',
    ),
    positive.replace('interface RunnerDeps { repo: Repo; clock?: () => Date; }', 'interface RunnerDeps { repo(): Repo; clock?: () => Date; }'),
    positive.replace('interface RunnerDeps { repo: Repo; clock?: () => Date; }', 'interface RunnerDeps { repo: Repo; repo: Repo; clock?: () => Date; }'),
    positive.replace('interface RunnerDeps { repo: Repo; clock?: () => Date; }', 'interface RunnerDeps { repo: Repo; clock?: () => Date; spare?: () => Date; }'),
    positive.replace('interface RunnerDeps { repo: Repo; clock?: () => Date; }', 'interface RunnerDeps { __proto__: Repo; clock?: () => Date; }'),
    positive.replace('interface RunnerDeps { repo: Repo; clock?: () => Date; }', 'interface RunnerDeps { then: Repo; clock?: () => Date; }'),
    positive.replace('interface RunnerDeps { repo: Repo; clock?: () => Date; }', 'declare const field: unique symbol; interface RunnerDeps { [field]: Repo; clock?: () => Date; }'),
    positive.replace('const runner = new Runner({ repo: live, clock: undefined });', 'const runner = new Runner({ repo: live, ...{} });'),
    positive.replace('const runner = new Runner({ repo: live, clock: undefined });', 'const runner = new Runner({ repo: live, repo: live });'),
    positive.replace(
      'const runner = new Runner({ repo: live, clock: undefined });',
      'const clock = () => new Date(); const runner = new Runner({ repo: live, clock });',
    ),
    positive.replace('  private readonly clock: () => Date;', '  private clock: () => Date;'),
    positive.replace('  private readonly clock: () => Date;', '  private readonly clock: () => Date = () => new Date();'),
    positive.replace('class Runner {', 'class Runner {\n  get leaked() { return this; }'),
    positive.replace('class Runner {', 'class Runner {\n  set leaked(value: unknown) {}'),
    positive.replace('class Runner {', 'class Runner {\n  static { void 0; }'),
    positive.replace('class Runner {', 'class Runner {\n  readonly #hidden: string;'),
    positive.replace('class Runner {', 'class Runner {\n  private readonly unused: string;'),
    positive.replace(
      'constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
      'constructor(private readonly deps: RunnerDeps) { const ignored = true; this.clock = deps.clock ?? (() => new Date()); }',
    ),
    positive.replace(
      'constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
      'constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); this.clock = () => new Date(); }',
    ),
    positive.replace('  run() { this.clock(); return this.deps.repo.run(); }', '  run() { this.clock(); return "unused"; }'),
    positive.replace('class Runner {', 'class Runner {\n  static extra() { return "extra"; }'),
  ];
  assert.deepEqual(cases.flatMap((source, index) => carrierResult(source) === undefined ? [] : [index]), []);
});

test('unknown computed receiver mutation keeps the carrier unresolved', () => {
  const source = `${positive}\ndeclare const unknownReceiver: any;\ndeclare const dynamicKey: string;\nunknownReceiver[dynamicKey] = runner;`;
  const { context, runner } = contextOf(source);
  assert.equal(proveConstructorCarrier(context, runner) === undefined, true);
});

test('prototype setter, prototype replacement, Date patch and method patch close the carrier view', () => {
  const cases = [
    `${positive}\nObject.prototype.deps = (_value: unknown) => undefined;`,
    `${positive}\nObject.setPrototypeOf({}, null);`,
    `${positive}\nDate.prototype.toString = () => "patched";`,
    `${positive}\nRunner.prototype.run = () => "patched";`,
  ];
  for (const source of cases) {
    const { context, runner } = contextOf(source);
    assert.equal(proveConstructorCarrier(context, runner) === undefined, true, source);
  }
});

test('explicit optional Date undefined still requires the implicit bag field prototype guard', () => {
  const source = [
    'interface Repo { run(): string; }',
    'interface RunnerDeps { repo: Repo; timestamp?: () => Date; }',
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner {',
    '  private readonly timeSource: () => Date;',
    '  constructor(private readonly resources: RunnerDeps) { this.timeSource = resources.timestamp ?? (() => new Date()); }',
    '  run() { this.timeSource(); return this.resources.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    'Object.prototype.resources = undefined;',
    'const runner = new Runner({ repo: live, timestamp: undefined });',
    'export const run = () => runner.run();',
  ].join('\n');
  const { context, runner } = contextOf(source);
  assert.equal(proveConstructorCarrier(context, runner) === undefined, true);
});

test('type aliases and optional Date property forms are checked as real bag contracts', () => {
  const aliased = positive.replace(
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'type RunnerDeps = { repo: Repo; clock?: () => Date };',
  );
  assert.ok(carrierResult(aliased));

  const unsupported = [
    positive.replace('interface RunnerDeps { repo: Repo; clock?: () => Date; }', 'type RunnerDeps = Readonly<{ repo: Repo; clock?: () => Date }>;'),
    positive.replace('interface RunnerDeps { repo: Repo; clock?: () => Date; }', 'type RunnerDeps = string;'),
    positive.replace('const runner = new Runner({ repo: live, clock: undefined });', 'const runner = new Runner({});'),
    positive.replace('const runner = new Runner({ repo: live, clock: undefined });', 'const runner = new Runner({ repo: live, extra: true });'),
    positive.replace('const runner = new Runner({ repo: live, clock: undefined });', 'const runner = new Runner({ ["repo"]: live });'),
    positive.replace('class Runner {', 'const fieldName = "secret"; class Runner {').replace(
      '  private readonly clock: () => Date;',
      '  private readonly [fieldName]: () => Date;',
    ),
  ];
  for (const source of unsupported) assert.equal(carrierResult(source) === undefined, true, source);
});

test('static bag and this reads, unsupported calls, and unsafe Date calls fail closed', () => {
  const cases = [
    positive.replace('return this.deps.repo.run();', 'return this;'),
    positive.replace('return this.deps.repo.run();', 'return this.deps;'),
    positive.replace('return this.deps.repo.run();', 'return this.deps["repo"].run();'),
    positive.replace('return this.deps.repo.run();', 'return this.deps.repo;'),
    positive.replace('return this.deps.repo.run();', 'return this.deps.repo.foo;'),
    positive.replace('return this.deps.repo.run();', 'return this.deps.repo.call();'),
    positive.replace('return this.deps.repo.run();', 'return unknown();'),
    positive.replace('return this.deps.repo.run();', 'return new Date();'),
    positive.replace('return this.deps.repo.run();', 'return tag`value`;'),
    positive.replace('return this.deps.repo.run();', 'function nested() { return "x"; } return this.deps.repo.run();'),
    positive.replace('this.clock();', 'this.clock(1);'),
    positive.replace('this.clock();', 'const detached = this.clock; return detached();'),
  ];
  for (const source of cases) assert.equal(carrierResult(source) === undefined, true, source);
});

test('carrier memo/factory and callback projections reject late or unsafe uses', () => {
  const closedWrapper = [
    positive,
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }',
    'export const wrapped = wrap(runner, (value) => value.run());',
  ].join('\n');
  assert.ok(carrierResult(closedWrapper));

  const cases = [
    positive.replace('export const run = () => runner.run();', 'const alias = runner; export const run = () => alias.run();'),
    positive.replace('export const run = () => runner.run();', 'function named() { return runner.run(); } export const run = () => named();'),
    positive.replace('export const run = () => runner.run();', 'function consume(value: Runner) {} consume(runner); export const run = () => runner.run();'),
    positive.replace('export const run = () => runner.run();', 'function wrap(value: Runner, cb: (value: Runner) => string) { return cb(value); } function named(value: Runner) { return value.run(); } export const run = () => wrap(runner, named);'),
    closedWrapper.replace('return callback(value);', 'function nested() { return value.run(); } return nested();'),
    closedWrapper.replace('(value) => value.run()', '(value) => { function nested() { return value.run(); } return nested(); }'),
    closedWrapper.replace('(value) => value.run()', '(...value) => value[0]!.run()'),
    closedWrapper.replace('(value) => value.run()', 'async (value) => value.run()'),
    closedWrapper.replace('(value) => value.run()', 'function* (value) { return value.run(); }'),
  ];
  for (const source of cases) assert.equal(carrierResult(source) === undefined, true, source);
});

test('cycle guards close recursive carrier factories', () => {
  const cycle = [
    'interface Repo { run(): string; }',
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner { private readonly clock: () => Date;',
    '  constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
    '  run() { return this.deps.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    'let memo: { runner: Runner } | null = null;',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return deps(); }',
    'const { runner } = deps();',
    'export const run = () => runner.run();',
  ].join('\n');
  assert.equal(carrierResult(cycle) === undefined, true);
});

test('independent review counterexamples remain unresolved until carrier-flow repair', () => {
  const failures: string[] = [];
  const duplicateBinding = [
    'interface Repo { run(): string; }',
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner { private readonly clock: () => Date;',
    '  constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
    '  run() { return this.deps.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    'let memo: { runner: Runner } | null = null;',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
    'function consume(_value: Runner) {}',
    'const { runner, runner: leaked } = deps();',
    'consume(leaked);',
    'export const run = () => runner.run();',
  ].join('\n');
  if (carrierResult(duplicateBinding) !== undefined) failures.push('duplicate projection binding');

  const sinkerMismatch = [
    positive,
    'declare const unrelated: Runner;',
    'function consume(_value: Runner) {}',
    'function sinker(value: Runner, other: Runner, callback: (value: Runner) => string) { consume(value); return callback(other); }',
    'export const wrapped = sinker(runner, unrelated, (value) => value.run());',
  ].join('\n');
  if (carrierResult(sinkerMismatch) !== undefined) failures.push('wrapper sinker mismatch');

  if (carrierResult(positive.replace('return this.deps.repo.run();', 'return this.deps.repo.run(this);')) !== undefined) failures.push('service call receives this');

  const suppliedClock = [
    positive.replace('const runner = new Runner({ repo: live, clock: undefined });', [
      'const evil: (this: Runner) => Date = function() { return this as unknown as Date; };',
      'const runner = new Runner({ repo: live, clock: evil });',
    ].join('\n')),
  ].join('\n');
  if (carrierResult(suppliedClock) !== undefined) failures.push('supplied clock receiver');

  const nestedMemoLeak = [
    'interface Repo { run(): string; }',
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner { private readonly clock: () => Date;',
    '  constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
    '  run() { return this.deps.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    'let memo: { runner: Runner } | null = null;',
    'function deps() {',
    '  if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) };',
    '  const leak = () => { return memo; };',
    '  consume(leak);',
    '  return memo;',
    '}',
    'function consume(_value: unknown) {}',
    'const { runner } = deps();',
    'export const run = () => runner.run();',
  ].join('\n');
  if (carrierResult(nestedMemoLeak) !== undefined) failures.push('nested memo factory leak');
  assert.deepEqual(failures, []);
});

test('optional Date 공급값은 inert 값 또는 pure intrinsic arrow만 허용한다', () => {
  const explicit = (value: string) => positive.replace(
    'const runner = new Runner({ repo: live, clock: undefined });',
    `const runner = new Runner({ repo: live, clock: ${value} });`,
  );
  assert.ok(carrierResult(explicit('undefined')));
  assert.ok(carrierResult(explicit('null')));
  assert.ok(carrierResult(explicit('() => new Date()')));
  for (const value of [
    'evil',
    'async () => new Date()',
    '() => { return new Date(); }',
    '(value: number) => new Date(value)',
    '() => new Date(0)',
    'function() { return new Date(); }',
  ]) assert.equal(carrierResult(explicit(value)) === undefined, true, value);

  const { context, runner } = contextOf(positive);
  const { isDefaultLibraryFile: _defaultLibrary, ...withoutDefaultLibrary } = context.policy;
  assert.equal(proveConstructorCarrier({
    ...context,
    policy: withoutDefaultLibrary,
  }, runner), undefined);
  assert.equal(carrierResult(positive.replace(
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'interface RunnerDeps { repo: Repo; clock?: (value: number) => Date; }',
  )), undefined);
  assert.equal(carrierResult(positive.replace(
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'interface RunnerDeps { repo: Repo; clock?: <T>() => Date; }',
  )), undefined);
});

test('constructor own fields accept only complete bag projections and one audited Date fallback', () => {
  const directDefault = positive.replace(
    'constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
    'constructor(private readonly deps: RunnerDeps) { this.clock = () => new Date(); }',
  ).replace('  run() { this.clock(); return this.deps.repo.run(); }', '  run() { return this.deps.repo.run(); }');
  assert.ok(carrierResult(directDefault));

  const projectedField = positive.replace(
    '  private readonly clock: () => Date;',
    '  private readonly projected: Repo;\n  private readonly clock: () => Date;',
  ).replace(
    'constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
    'constructor(private readonly deps: RunnerDeps) { this.projected = deps.repo; this.clock = deps.clock ?? (() => new Date()); }',
  );
  assert.ok(carrierResult(projectedField));

  const cases = [
    positive.replace(
      '  private readonly clock: () => Date;',
      '  private readonly clock: () => Date;\n  private readonly secondClock: () => Date;',
    ).replace(
      'this.clock = deps.clock ?? (() => new Date());',
      'this.clock = deps.clock ?? (() => new Date()); this.secondClock = deps.clock ?? (() => new Date());',
    ),
    positive.replace('this.clock = deps.clock ?? (() => new Date());', 'this.clock = deps.clock || (() => new Date());'),
    positive.replace('this.clock = deps.clock ?? (() => new Date());', 'this.clock += deps.clock ?? (() => new Date());'),
    positive.replace('this.clock = deps.clock ?? (() => new Date());', 'this.deps = deps;'),
    positive.replace('this.clock = deps.clock ?? (() => new Date());', 'this.missing = () => new Date();'),
    positive.replace('this.clock = deps.clock ?? (() => new Date());', 'deps.clock = () => new Date();'),
    positive.replace('this.clock = deps.clock ?? (() => new Date());', 'this.clock;'),
  ];
  for (const source of cases) assert.equal(carrierResult(source) === undefined, true, source);
});

test('memo 반환 factory와 wrapper는 가장 가까운 stable synchronous function 경계여야 한다', () => {
  const memo = [
    'interface Repo { run(): string; }',
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner { private readonly clock: () => Date;',
    '  constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
    '  run() { return this.deps.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    'let memo: { runner: Runner } | null = null;',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
    'const { runner } = deps();',
    'export const run = () => runner.run();',
  ].join('\n');
  assert.ok(carrierResult(memo));
  assert.equal(carrierResult(memo.replace('function deps()', 'async function deps()')) === undefined, true);
  assert.equal(carrierResult(memo.replace('function deps()', 'function* deps()')) === undefined, true);
  for (const parameter of [
    'value: unknown',
    'value = observe()',
    '...values: unknown[]',
    '{ value }: { value: unknown }',
  ]) assert.equal(carrierResult(memo.replace('function deps()', `function deps(${parameter})`)) === undefined, true, parameter);

  const wrapper = `${positive}\nfunction wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());`;
  assert.ok(carrierResult(wrapper));
  assert.equal(carrierResult(wrapper.replace('function wrap(', 'async function wrap(')) === undefined, true);
  assert.equal(carrierResult(wrapper.replace('function wrap(', 'function* wrap(')) === undefined, true);
  const extraDefault = `${positive}\nfunction wrap(value: Runner, callback: (value: Runner) => string, extra = expose(value)) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());`;
  assert.equal(carrierResult(extraDefault) === undefined, true);
  const wrapperArguments = `${positive}\nfunction wrap(value: Runner, callback: (value: Runner) => string) { const leaked = arguments; return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());`;
  assert.equal(carrierResult(wrapperArguments) === undefined, true);
  const callbackArguments = `${positive}\nfunction wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, function(value) { const leaked = arguments; return value.run(); });`;
  assert.equal(carrierResult(callbackArguments) === undefined, true);
});

test('memo factory는 모든 projection binding과 가장 가까운 function boundary를 감사한다', () => {
  const memo = [
    'interface Repo { run(): string; }',
    'interface RunnerDeps { repo: Repo; clock?: () => Date; }',
    'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
    'class Runner { private readonly clock: () => Date;',
    '  constructor(private readonly deps: RunnerDeps) { this.clock = deps.clock ?? (() => new Date()); }',
    '  run() { return this.deps.repo.run(); }',
    '}',
    'const live: Repo = new RepoImpl();',
    'let memo: { runner: Runner } | null = null;',
    'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
  ].join('\n');

  const duplicate = `${memo}\nconst { runner, runner: twin, missing } = deps();\nexport const run = () => runner.run() + twin.run();`;
  const duplicateProof = carrierResult(duplicate);
  assert.ok(duplicateProof);
  assert.equal(duplicateProof.projectionBindings.length, 2);

  const repeated = `${memo}\nconst { runner: first } = deps();\nconst { runner: second } = deps();\nexport const run = () => first.run() + second.run();`;
  const repeatedProof = carrierResult(repeated);
  assert.ok(repeatedProof);
  assert.equal(repeatedProof.projectionBindings.length, 2);

  const cases = [
    `${memo}\ndeclare const fallback: Runner;\nconst { runner = fallback } = deps();\nexport const run = () => runner.run();`,
    `${memo}\nconst { ['runner']: runner } = deps();\nexport const run = () => runner.run();`,
    `${memo}\nconst { runner, ...rest } = deps();\nexport const run = () => runner.run();`,
    `${memo}\nconst { runner: { run } } = deps();\nexport const invoke = () => run();`,
    `${memo}\nconst { missing } = deps();\nexport const invoke = () => missing;`,
    `${memo}\nexport const { runner } = deps();\nexport const run = () => runner.run();`,
    memo.replace('let memo:', 'export let memo:') + '\nconst { runner } = deps();\nexport const run = () => runner.run();',
    `${memo}\nexport { memo };\nconst { runner } = deps();\nexport const run = () => runner.run();`,
    `${memo}\nconst { runner } = deps(1);\nexport const run = () => runner.run();`,
    `${memo}\nconst { runner } = deps(...[]);\nexport const run = () => runner.run();`,
    memo,
    memo.replace(
      'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
      'memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo;',
    ),
    memo.replace('return memo; }', 'void memo; return memo; }') + '\nconst { runner } = deps();\nexport const run = () => runner.run();',
    memo.replace(
      'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
      '{ function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; } const { runner } = deps(); runner.run(); }',
    ),
    memo.replace(
      'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; return memo; }',
      'function deps() { if (!memo) memo ??= { runner: new Runner({ repo: live, clock: undefined }) }; function nested() { return memo; } nested(); return memo; }',
    ) + '\nconst { runner } = deps();\nexport const run = () => runner.run();',
    `${memo}\nfunction consume(_value: unknown) {}\nfunction wrap(make: () => { runner: Runner }, callback: (runner: Runner) => string) { consume(make); const { runner } = make(); return callback(runner); }\nexport const run = wrap(deps, (runner) => runner.run());`,
    `${memo}\nfunction wrap(make: () => { runner: Runner }, callback: (runner: Runner) => string) { function nested() { return make(); } const { runner } = nested(); return callback(runner); }\nexport const run = wrap(deps, (runner) => runner.run());`,
    `${memo}\nfunction consume(_value: unknown) {}\nconsume(deps());`,
    `${memo}\nconst values = [deps()];`,
    `${memo}\nconst wrap = (make: () => { runner: Runner }, callback: (runner: Runner) => string) => { const { runner } = make(); return callback(runner); };\nexport const run = wrap(deps, (runner) => runner.run());`,
    `${memo}\nfunction wrap(make: () => { runner: Runner }, callback: (runner: Runner) => string): string;\nfunction wrap(make: () => { runner: Runner }, callback: (runner: Runner) => string) { const { runner } = make(); return callback(runner); }\nexport const run = wrap(deps, (runner) => runner.run());`,
  ];
  assert.deepEqual(cases.flatMap((source, index) => carrierResult(source) === undefined ? [] : [index]), []);
});

test('inline wrapper는 runtime parameter 대응과 모든 callback invocation을 감사한다', () => {
  const accepted = [
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, function(value) { return value.run(); });',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => { return value.run(); });',
    'function wrap(this: void, value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { callback(value); return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
  ];
  for (const suffix of accepted) assert.ok(carrierResult(`${positive}\n${suffix}`), suffix);

  const rejected = [
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'declare const other: Runner; function wrap(value: Runner, callback: (value: Runner) => string) { return callback(other); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value, value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback.call(undefined, value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback; }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run(value));',
    'function wrap(value: Runner, callback: (value: Runner) => string, second: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run(), (value) => value.run());',
    'function wrap(value: Runner = runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(...values: Runner[]) { return values[0]!.run(); }\nexport const wrapped = wrap(runner, (value: Runner) => value.run());',
    'function wrap({ value }: { value: Runner }, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string = (value) => value.run()) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, ...callbacks: Array<(value: Runner) => string>) { return callbacks[0]!(value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); } const holder = { wrap };\nexport const wrapped = holder.wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, function named(value) { return value.run(); });',
    'function wrap(value: Runner, callback: (value: Runner) => string) { function nested() { return callback(value); } return nested(); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'const wrap = (value: Runner, callback: (value: Runner) => string) => callback(value);\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner) { return value.run(); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, { callback }: { callback: (value: Runner) => string }) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nwrap = (_value, _callback) => "patched";\nexport const wrapped = wrap(runner, (value) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, () => "unused");',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value, extra) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value = runner) => value.run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, ({ run }) => run());',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => "unused");',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => { const alias = value; return alias.run(); });',
    'function wrap(value: Runner, callback: (value: Runner) => string) { return callback(value); }\nexport const wrapped = wrap(runner, (value) => value["run"]());',
  ];
  for (const suffix of rejected) assert.equal(carrierResult(`${positive}\n${suffix}`), undefined, suffix);
});

test('unrelated private array own-index write preserves the carrier bound edge', async () => {
  const graph = await graphOf({
    'src/main.ts': [
      'interface Repo { run(): string; }',
      'interface RunnerDeps { repo: Repo; timestamp?: () => Date; }',
      'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
      'class Runner {',
      '  private readonly timeSource: () => Date;',
      '  constructor(private readonly resources: RunnerDeps) { this.timeSource = resources.timestamp ?? (() => new Date()); }',
      '  run() { this.timeSource(); return this.resources.repo.run(); }',
      '}',
      'const live: Repo = new RepoImpl();',
      'const scratch = [0];',
      'const key = 0;',
      'scratch[key] = 1;',
      'const runner = new Runner({ repo: live, timestamp: undefined });',
      'export const read = () => runner.run();',
    ].join('\n'),
  });
  assert.ok(graph.edges.some((edge) => edge.from === 'src/main.ts#Runner.run'
    && edge.to === 'src/main.ts#RepoImpl.run' && edge.evidence === 'bound'));
});

test('typed, spread and factory array provenance stay unresolved', async () => {
  const cases = [
    [
      'declare const input: unknown[];',
      'const scratch: unknown[] = input;',
      'const key = 0;',
      'scratch[key] = 1;',
    ],
    [
      'declare const input: unknown[];',
      'const scratch = [...input];',
      'const key = 0;',
      'scratch[key] = 1;',
    ],
    [
      'declare function makeArray(): unknown[];',
      'const scratch = makeArray();',
      'const key = 0;',
      'scratch[key] = 1;',
    ],
  ];
  for (const setup of cases) {
    const graph = await graphOf({
      'src/main.ts': [
        'interface Repo { run(): string; }',
        'interface RunnerDeps { repo: Repo; timestamp?: () => Date; }',
        'class RepoImpl implements Repo { private readonly brand = true; run() { return "ok"; } }',
        'class Runner {',
        '  private readonly timeSource: () => Date;',
        '  constructor(private readonly resources: RunnerDeps) { this.timeSource = resources.timestamp ?? (() => new Date()); }',
        '  run() { this.timeSource(); return this.resources.repo.run(); }',
        '}',
        'const live: Repo = new RepoImpl();',
        ...setup,
        'const runner = new Runner({ repo: live, timestamp: undefined });',
        'export const read = () => runner.run();',
      ].join('\n'),
    });
    assert.equal(graph.edges.some((edge) => edge.from === 'src/main.ts#Runner.run'
      && edge.to === 'src/main.ts#RepoImpl.run' && edge.evidence === 'bound'), false, setup.join('\n'));
  }
});

test('stage2 carrier certificates reject foreign context, forged allocation and invalidated cached entry', () => {
  const { context, runner } = contextOf(positive);
  const analyzer = new ConstructorCarrierAnalyzer(context); const proof = analyzer.prove(runner); assert.ok(proof);
  assert.equal(analyzer.accepts(proof, runner, proof.innerLiteral), true);
  assert.equal(analyzer.isolatesBag(runner, proof.innerLiteral), true);
  assert.equal(analyzer.allowsExtendedInstanceIsolation(runner), false);
  assert.equal(analyzer.isolatesExtendedBag(runner, proof.innerLiteral), false);
  assert.equal(new ConstructorCarrierAnalyzer(context).accepts(proof, runner), false);
  const other = contextOf(positive); assert.equal(new ConstructorCarrierAnalyzer(other.context).accepts(proof, other.runner), false);
  const otherProof = new ConstructorCarrierAnalyzer(other.context).prove(other.runner); assert.ok(otherProof);
  assert.equal(analyzer.isolatesBag(runner, otherProof.innerLiteral), false);
  assert.equal(analyzer.isolatesBag(other.runner, proof.innerLiteral), false);
  const fake = ts.factory.createObjectLiteralExpression();
  assert.equal(analyzer.accepts({ ...proof, innerLiteral: fake }, runner, fake), false);
  const { certificate: _certificate, ...uncertified } = proof;
  assert.equal(analyzer.accepts(uncertified, runner), false);
  const old = context.policy.isProjectFile;
  context.policy.isProjectFile = () => false;
  assert.equal(analyzer.outcome(runner).kind, 'incomplete');
  assert.equal(analyzer.accepts(proof, runner), false);
  context.policy.isProjectFile = old;
  assert.equal(analyzer.outcome(runner).kind, 'proved');
});

test('stage2 extended mutation coverage exhaustion is an incomplete outcome, not an internal throw', () => {
  const { context, runner } = contextOf(positive);
  const legacy = new ConstructorCarrierAnalyzer(context).prove(runner);
  assert.ok(legacy);
  const analyzer = new ConstructorCarrierAnalyzer({
    ...context,
    index: { ...context.index, effectInventory: completeInventory(), hasIncompleteMutations: true },
  });
  assert.equal(analyzer.isolatesExtendedBag(runner, legacy.innerLiteral), false);
});

test('stage2 extended bag certificates bind the declaration as well as the literal', () => {
  const source = `${positive}\nclass Other {}`;
  const { source: indexed, context, runner } = contextOf(source);
  const other = indexed.file.statements.find((statement): statement is ts.ClassDeclaration =>
    ts.isClassDeclaration(statement) && statement.name?.text === 'Other');
  assert.ok(other);
  const analyzer = new ConstructorCarrierAnalyzer({
    ...context,
    index: { ...context.index, effectInventory: completeInventory() },
  });
  const proof = analyzer.prove(runner);
  assert.ok(proof);
  assert.equal(analyzer.isolatesExtendedBag(runner, proof.innerLiteral), true);
  assert.equal(analyzer.isolatesExtendedBag(other, proof.innerLiteral), false);
});

test('stage2 extended bag cache revalidates policy entry state before reuse', () => {
  const { context, runner } = contextOf(positive);
  const analyzer = new ConstructorCarrierAnalyzer({
    ...context,
    index: { ...context.index, effectInventory: completeInventory() },
  });
  const proof = analyzer.prove(runner);
  assert.ok(proof);
  assert.equal(analyzer.isolatesExtendedBag(runner, proof.innerLiteral), true);
  const oldProjectCheck = context.policy.isProjectFile;
  context.policy.isProjectFile = () => false;
  try {
    assert.equal(analyzer.isolatesExtendedBag(runner, proof.innerLiteral), false);
  }
  finally {
    context.policy.isProjectFile = oldProjectCheck;
  }
});

test('stage2 preserves entry versus coverage reasons in carrier diagnostics', () => {
  const { context, runner } = contextOf(positive);
  const diagnostics = new Set<string>();
  const scoped = new ConstructorCarrierAnalyzer({
    ...context,
    index: { ...context.index, proofDiagnostics: diagnostics },
  });
  const oldProjectCheck = context.policy.isProjectFile;
  context.policy.isProjectFile = () => false;
  try {
    assert.equal(scoped.outcome(runner).kind, 'incomplete');
    assert.ok([...diagnostics].some((line) => line.startsWith('carrier-proof: incomplete(entry)')));
    assert.equal([...diagnostics].some((line) => line.startsWith('carrier-proof: incomplete(coverage)')), false);
  }
  finally {
    context.policy.isProjectFile = oldProjectCheck;
  }
});

test('stage2 actual carrier cold/warm and reversed consumer order replay the same caller work', () => {
  const { context, runner } = contextOf(positive);
  let steps = 0; let depth = 0; let frames = 0;
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: {
    step: () => { steps++; }, check: (d, f) => { depth = Math.max(depth, d); frames = Math.max(frames, f); },
  } });
  const run = (reverse = false) => {
    steps = 0; depth = 0; frames = 0; analyzer.beginQuery();
    const consumers = [() => analyzer.allowsInstanceFlow(runner), () => analyzer.allowsConstructedInstanceIdentity(runner),
      () => analyzer.allowsDeclaredMethodReceiver(runner), () => analyzer.prove(runner) !== undefined];
    try {
      const results = (reverse ? consumers.reverse() : consumers).map((consume) => consume());
      assert.deepEqual(reverse ? results.reverse() : results, [true, true, false, true]);
      return [steps, depth, frames];
    }
    finally { analyzer.endQuery(); }
  };
  const cold = run(); assert.deepEqual(run(), cold); assert.deepEqual(run(true), cold);
});

test('stage2 syntax, missing mutation coverage, and interrupted caller work have distinct outcomes', () => {
  const { context, runner } = contextOf(positive);
  const syntax = contextOf(positive.replace('clock: undefined', ''));
  assert.equal(new ConstructorCarrierAnalyzer(syntax.context).outcome(syntax.runner).kind, 'rejected');
  const incomplete = new ConstructorCarrierAnalyzer({ ...context, index: { ...context.index, hasIncompleteMutations: true } });
  assert.deepEqual(incomplete.outcome(runner), { kind: 'incomplete', reason: 'coverage' });
  assert.deepEqual(incomplete.outcome(runner), { kind: 'incomplete', reason: 'coverage' });
  let remaining = 20; let interrupt = true;
  const analyzer = new ConstructorCarrierAnalyzer({ ...context, caller: { step: () => {
    if (interrupt && --remaining === 0) throw new TypeError('caller interruption');
  }, check: () => {} } });
  assert.throws(() => analyzer.prove(runner), /caller interruption/); interrupt = false;
  assert.ok(analyzer.prove(runner)); assert.ok(analyzer.prove(runner));
});


test('stage2 missing config coverage retains the inventory limitation without redefining legacy as ambient proof', async () => {
  const graph = await graphOf({ 'tsconfig.json': '{ invalid', 'src/main.ts': positive });
  assert.ok(graph.limitations.some((line) => line.startsWith('effect-inventory: incomplete(coverage)')));
  assert.equal(graph.limitations.some((line) => line.startsWith('dispatch-budget:')), false);
});
