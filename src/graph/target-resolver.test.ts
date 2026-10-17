/** direct target의 carrier 감사도 호출자 예산과 중단 진단을 보존하는지 검증한다. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

import { buildFileIndex } from './flow-index.ts';
import { GraphStore } from './graph-model.ts';
import { collectFileNodes } from './node-collector.ts';
import { TargetResolver } from './target-resolver.ts';

test('direct carrier resolution reports caller exhaustion once and clears the next query', () => {
  const source = [
    'interface Inputs { repo: { run(): string }; clock?: () => Date; }',
    'class Repo { run() { return "ok"; } }',
    'class Runner {',
    '  private readonly clock: () => Date;',
    `  constructor(private readonly inputs: Inputs) { this.clock = inputs.clock ?? (() => new Date()); ${';'.repeat(20_050)} }`,
    '  run() { this.clock(); return this.inputs.repo.run(); }',
    '}',
    'const repo = new Repo(); const runner = new Runner({ repo, clock: undefined });',
    'class Plain { run() { return 1; } } const plain = new Plain();',
    'export const read = () => runner.run(); export const simple = () => plain.run();',
  ].join('\n');
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, types: [], lib: ['lib.es2022.d.ts'] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, fresh) => name === 'main.ts'
    ? ts.createSourceFile(name, source, version, true)
    : original.call(host, name, version, onError, fresh);
  const program = ts.createProgram({ rootNames: ['main.ts'], options, host });
  const file = program.getSourceFile('main.ts'); assert.ok(file);
  const checker = program.getTypeChecker();
  const diagnostics = new Set<string>();
  const index = { ...buildFileIndex(checker, file, () => undefined), proofProgram: program, proofDiagnostics: diagnostics };
  const store = new GraphStore(); collectFileNodes(store, 'main.ts', file);
  const resolver = new TargetResolver(checker, store, (candidate) => candidate === file ? 'main.ts' : undefined,
    () => false, index, (candidate) => program.isSourceFileDefaultLibrary(candidate));
  const calls = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.set(node.expression.getText(file), node.expression);
    ts.forEachChild(node, visit);
  };
  visit(file);
  const large = calls.get('runner.run'); const small = calls.get('plain.run'); assert.ok(large); assert.ok(small);
  assert.equal(resolver.resolveCallee(large).kind, 'unresolved');
  assert.equal([...diagnostics].filter((line) => line.startsWith('carrier-proof: exhausted')).length, 1);
  assert.equal(resolver.resolveCallee(small).kind, 'nodes');
  assert.equal(resolver.resolveCallee(large).kind, 'unresolved');
  assert.equal([...diagnostics].filter((line) => line.startsWith('carrier-proof: exhausted')).length, 1);
  assert.equal([...diagnostics].some((line) => line.startsWith('carrier-proof: rejected(syntax)')), false);
});

/**
 * 계산 키로 쓴(반사적 쓰기) 상자 `targets`개와 `this.helperN()` 호출 `calls`개를 담은 소스로, 모든 호출 대상을 해석하는
 * 동안의 `getSymbolAtLocation` 호출 수를 센다. 상자는 모두 `this`와 계보가 겹치지 않음을 증명할 수 있다.
 *
 * @param targets 반사적 쓰기 대상 수
 * @param calls `this` 메서드 호출 수
 * @returns 해석 결과 종류 목록과 심볼 조회 수
 */
function resolveThisCalls(targets: number, calls: number): { readonly kinds: readonly string[]; readonly lookups: number } {
  const source = [
    'declare function keyOf(index: number): string;',
    ...Array.from({ length: targets }, (_, index) =>
      `class Box${index} {}\nconst box${index} = new Box${index}();\n(box${index} as Record<string, number>)[keyOf(${index})] = 1;`),
    'class Service {',
    ...Array.from({ length: calls }, (_, index) => `  helper${index}() { return ${index}; }`),
    // 지역 Map의 메서드는 외부 대상이라 반사적 쓰기와 겹치는지 따질 필요가 없다.
    `  run() { const rows = new Map<string, number>(); rows.get("a"); return ${Array.from({ length: calls }, (_, index) => `this.helper${index}()`).join(' + ')}; }`,
    '}',
    'export const total = new Service().run();',
  ].join('\n');
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true, types: [], lib: ['lib.es2022.d.ts'] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, version, onError, fresh) => name === 'main.ts'
    ? ts.createSourceFile(name, source, version, true)
    : original.call(host, name, version, onError, fresh);
  const program = ts.createProgram({ rootNames: ['main.ts'], options, host });
  const file = program.getSourceFile('main.ts'); assert.ok(file);
  const checker = program.getTypeChecker();
  let lookups = 0;
  const counted = new Proxy(checker, {
    get: (target, property, receiver) => property === 'getSymbolAtLocation'
      ? (node: ts.Node) => {
        lookups++;
        return target.getSymbolAtLocation(node);
      }
      : Reflect.get(target, property, receiver),
  });
  const index = buildFileIndex(checker, file, () => undefined);
  assert.equal(index.reflectiveTargets.length, targets);
  const store = new GraphStore(); collectFileNodes(store, 'main.ts', file);
  const resolver = new TargetResolver(counted, store, (candidate) => candidate === file ? 'main.ts' : undefined, () => false, index);
  const callees: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) callees.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(file);
  lookups = 0;
  const kinds = callees.map((callee) => resolver.resolveCallee(callee).kind);
  return { kinds, lookups };
}

test('reflective write targets are summarized once per resolver instead of per property call', () => {
  const calls = 30;
  const few = resolveThisCalls(10, calls);
  const many = resolveThisCalls(20, calls);
  // 계보가 겹치지 않는 상자 쓰기는 this 호출과 `new Service().run()`의 직접 해석을 막지 않는다(동작 보존).
  assert.deepEqual(few.kinds, ['external', ...Array.from({ length: calls + 1 }, () => 'nodes')]);
  assert.deepEqual(many.kinds, few.kinds);
  // 수정 전에는 호출마다 모든 대상의 정체성을 다시 풀어, 대상 10개를 더하면 조회가 약 3 × 호출 × 10번 늘었다.
  // 이제 대상 정체성은 resolver마다 한 번 계산하므로 대상 수에만 비례해 늘어난다.
  assert.ok(many.lookups - few.lookups < calls * 10, `${few.lookups} -> ${many.lookups} symbol lookups`);
});
