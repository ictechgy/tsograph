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
