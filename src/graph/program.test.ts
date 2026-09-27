import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { createGraphProgram } from './program.ts';

/**
 * 임시 프로젝트를 만들고 콜백 뒤 지운다.
 *
 * @param files 상대 경로 → 내용
 * @param body 콜백
 */
async function withProject(files: Record<string, string>, body: (root: string) => Promise<void> | void): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-graph-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('tsconfig·jsconfig·설정 없음·깨진 설정을 구분한다', async () => {
  await withProject({ 'tsconfig.json': '{ "compilerOptions": { "strict": true }, "include": ["src"] }', 'src/a.ts': 'export const a = 1;' }, (root) => {
    const { status, program } = createGraphProgram(root, []);
    assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false });
    assert.equal(program.getCompilerOptions().allowJs, true);
    assert.equal(program.getCompilerOptions().noEmit, true);
  });
  await withProject({ 'jsconfig.json': '{ "compilerOptions": { "incremental": true } }', 'a.js': '' }, (root) => {
    const { status, program } = createGraphProgram(root, [join(root, 'a.js')]);
    assert.deepEqual(status, { configName: 'jsconfig.json', configUnreadable: false });
    assert.equal(program.getCompilerOptions().incremental, undefined);
  });
  await withProject({ 'a.ts': '' }, (root) => {
    assert.deepEqual(createGraphProgram(root, []).status, { configName: undefined, configUnreadable: false });
  });
  await withProject({ 'tsconfig.json': '{ "compilerOptions": ', 'a.ts': '' }, (root) => {
    assert.deepEqual(createGraphProgram(root, []).status, { configName: 'tsconfig.json', configUnreadable: true });
  });
  await withProject({ 'tsconfig.json': '{ "compilerOptions": { "module": "nonsense" } }' }, (root) => {
    assert.deepEqual(createGraphProgram(root, []).status, { configName: 'tsconfig.json', configUnreadable: true });
  });
});

test('작은 프로젝트: 깨진 설정·구문 오류·과대 파일·깨진 vercel.json·CommonJS를 limitation으로 알린다', async () => {
  await withProject({
    'tsconfig.json': '{ "compilerOptions": ',
    'vercel.json': '{ crons: nope',
    'src/a.ts': 'export function f( {\n',
    'src/big.ts': `export const big = "${'x'.repeat(4 * 1024 * 1024)}";\n`,
    'src/c.js': 'module.exports = function handler() { helper(); };\nfunction helper() {}\nclass K { static s = helper(); [Symbol.iterator]() { helper(); } }\n',
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.deepEqual(graph.limitations.filter((line) => !line.startsWith('unresolved-calls')), [
      'graph-config: tsconfig.json could not be parsed; default compiler options were used, so path aliases may not resolve',
      'parse-errors: 1 source file(s) have syntax errors; their calls may be incomplete',
      'oversized-sources: 1 file(s) larger than 4 MiB were skipped',
      'entry-points: vercel.json could not be read as JSON within 1 MiB; scheduled entries are unknown',
    ]);
    const edges = graph.edges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kinds.join(',')}`);
    // 이름 없는 CommonJS 할당과 계산된 이름 멤버 안의 코드는 모듈 스코프에 속하고, static 필드는 모듈이 초기화한다.
    assert.ok(edges.includes('src/c.js#<module> -> src/c.js#helper call'), edges.join('\n'));
    assert.ok(edges.includes('src/c.js#<module> -> src/c.js#K.s initializer'), edges.join('\n'));
    assert.ok(graph.nodes.every((node) => node.location.path !== 'src/big.ts'));
  });
});
