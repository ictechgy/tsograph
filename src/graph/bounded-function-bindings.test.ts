import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';

/** 실제 고정 effect cap을 넘기며 소스 제외·상한 조절 없이 부분 의미 상태를 확인한다. */
test('actual effect proof exhaustion retains checked function calls with explicit partial semantics', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-proof-cap-')));
  try {
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["**/*.ts","**/*.cts","**/*.mts"]}');
    for (let index = 0; index < 12; index++) {
      writeFileSync(join(root, `ballast${index}.ts`), 'export {};\n' + '0;\n'.repeat(60_001));
    }
    writeFileSync(join(root, 'main.ts'), 'export function checkedTarget() {} export function goodCaller() { checkedTarget(); }');
    writeFileSync(join(root, 'writes.ts'), `
export function assigned() {} assigned = () => {}; export function callAssigned() { assigned(); }
export function logical() {} logical ||= () => {}; export function callLogical() { logical(); }
export function nested() {} ({ value: [nested = () => {}] } = { value: [] }); export function callNested() { nested(); }
export function rest() {} [ ...rest ] = []; export function callRest() { rest(); }
export function loop() {} for (loop of [() => {}]) {} export function callLoop() { loop(); }
export function update() {} update++; export function callUpdate() { update(); }
export function mergedCaller() { function merged() {} var merged = () => {}; merged(); }
`);
    writeFileSync(join(root, 'namespace.ts'), 'export namespace Owned { export function hidden() {} export function caller() { hidden(); } }');
    writeFileSync(join(root, 'commonjs.ts'), 'export function commonTarget() {} export function caller() { commonTarget(); } module.exports = {};');
    writeFileSync(join(root, 'dynamic.ts'), 'export function dynamicTarget() {} export function caller() { eval("dynamicTarget = replacement"); dynamicTarget(); }');
    writeFileSync(join(root, 'with.ts'), 'export function withTarget() {} export function caller() { with ({}) { withTarget(); } }');
    writeFileSync(join(root, 'target.ts'), 'export function typeOnlyTarget() {} export function valueTarget() {}');
    writeFileSync(join(root, 'type-only.ts'), 'import type { typeOnlyTarget } from "./target.js"; export function caller() { typeOnlyTarget(); }');
    writeFileSync(join(root, 'barrel.ts'), 'export type * from "./target.js";');
    writeFileSync(join(root, 'through-barrel.ts'), 'import { typeOnlyTarget } from "./barrel.js"; export function caller() { typeOnlyTarget(); }');
    writeFileSync(join(root, 'value-barrel.ts'), 'export { valueTarget as exportedAlias } from "./target.js";');
    writeFileSync(join(root, 'value-caller.ts'), 'import { exportedAlias as namedAlias } from "./value-barrel.js"; export function caller() { namedAlias(); }');
    writeFileSync(join(root, 'overloads.ts'), 'export function overloaded(value: string): void; export function overloaded(value: number): void; export function overloaded(value: string | number) {} export function caller() { overloaded("x"); }');
    writeFileSync(join(root, 'cjs-target.cts'), 'export function changedTarget() { return "original"; }');
    writeFileSync(join(root, 'cjs-mutator.cts'), 'import * as target from "./cjs-target.cjs"; Object.defineProperty(target, "changedTarget", { value: () => "changed" }); export {};');
    writeFileSync(join(root, 'cjs-caller.cts'), 'import { changedTarget } from "./cjs-target.cjs"; import "./cjs-mutator.cjs"; export function cjsCaller() { return changedTarget(); }');
    writeFileSync(join(root, 'import-equals.mts'), 'import value = require("./target.js"); export function interopTarget() {} export function interopCaller() { interopTarget(); }');
    writeFileSync(join(root, 'type-import-equals.mts'), 'import type value = require("./target.js"); export function esmTarget() {} export function esmCaller() { esmTarget(); }');
    mkdirSync(join(root, 'package-commonjs'));
    writeFileSync(join(root, 'package-commonjs/package.json'), '{"type":"commonjs"}');
    writeFileSync(join(root, 'package-commonjs/main.ts'), 'export function packageTarget() {} export function packageCaller() { packageTarget(); }');
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(graph.statistics.files, 31);
    assert.ok(graph.edges.some(edge => edge.from === 'main.ts#goodCaller' && edge.to === 'main.ts#checkedTarget' && edge.evidence === 'direct'));
    assert.ok(graph.limitations.some(line => line.startsWith('analysis-partial: bounded-function-bindings;')),
      '실제 proof cap을 완전한 의미 분석으로 표시하지 않는다');
    assert.ok(graph.limitations.some(line => line.startsWith('effect-inventory: incomplete(build-cap)')));
    assert.ok(graph.edges.some(edge => edge.from === 'value-caller.ts#caller' && edge.to === 'target.ts#valueTarget' && edge.evidence === 'direct'));
    assert.ok(graph.edges.some(edge => edge.from === 'overloads.ts#caller' && edge.to === 'overloads.ts#overloaded' && edge.evidence === 'direct'));
    assert.ok(graph.edges.some(edge => edge.from === 'type-import-equals.mts#esmCaller' && edge.to === 'type-import-equals.mts#esmTarget' && edge.evidence === 'direct'));
    for (const path of ['writes.ts', 'namespace.ts', 'commonjs.ts', 'dynamic.ts', 'with.ts', 'type-only.ts', 'through-barrel.ts', 'cjs-caller.cts', 'import-equals.mts', 'package-commonjs/main.ts']) {
      assert.ok(!graph.edges.some(edge => edge.from.startsWith(path + '#') && edge.kinds.includes('call')), `${path}의 미확정 runtime 바인딩은 direct가 아니다`);
    }
    assert.equal(graph.statistics.calls.dispatch.bound, 0);
    assert.equal(graph.statistics.calls.dispatch.candidate, 0);
    assert.ok(Object.values(graph.statistics.calls.unresolved).reduce((sum, count) => sum + count, 0) >= 10);
    // NodeNext 분기만 검사하면 전역 ESNext 허용이 파일별 .cts 형식을 덮는 원래 결함을 놓친다.
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"module":"ESNext","moduleResolution":"Bundler"},"include":["**/*.ts","**/*.cts","**/*.mts"]}');
    const globalEsm = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(globalEsm.statistics.files, 31);
    assert.ok(globalEsm.limitations.some(line => line.startsWith('analysis-partial: bounded-function-bindings;')));
    assert.ok(globalEsm.edges.some(edge => edge.from === 'main.ts#goodCaller' && edge.to === 'main.ts#checkedTarget' && edge.evidence === 'direct'));
    assert.ok(!globalEsm.edges.some(edge => edge.from.startsWith('cjs-caller.cts#') && edge.kinds.includes('call')),
      '전역 ESNext도 .cts export 속성 변경을 lexical ESM 바인딩으로 인증하지 않는다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
