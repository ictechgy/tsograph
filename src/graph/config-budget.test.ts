/**
 * compiler 설정 128개 예산을 넘는 모노레포에서도 예산 안 설정이 소유한 소스는 계속 분석하는지 검증한다.
 * 예전에는 예산을 넘는 순간 모든 소스의 import를 막아 그래프 간선이 0개가 됐다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';

/**
 * 패키지마다 tsconfig 하나와 다음 패키지를 부르는 함수 하나를 둔 workspace를 만든다.
 *
 * @param packages 패키지 수
 * @returns 프로젝트 realpath
 */
function createChainedPackages(packages: number): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-config-budget-')));
  writeFileSync(join(root, 'package.json'), '{ "name": "root", "private": true }');
  writeFileSync(join(root, 'tsconfig.base.json'),
    '{ "compilerOptions": { "strict": true, "types": [], "lib": ["es2022"], "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }');
  writeFileSync(join(root, 'tsconfig.json'), '{ "extends": "./tsconfig.base.json", "include": ["packages/*/src"] }');
  for (let index = 1; index <= packages; index++) {
    const directory = join(root, `packages/p${index}`);
    mkdirSync(join(directory, 'src'), { recursive: true });
    writeFileSync(join(directory, 'tsconfig.json'), '{ "extends": "../../tsconfig.base.json", "include": ["src"] }');
    writeFileSync(join(directory, 'src/local.ts'), `export function local${index}() { return ${index}; }\n`);
    const next = index < packages ? `import { f${index + 1} } from "../../p${index + 1}/src/index";\n` : '';
    const body = index < packages ? `return f${index + 1}() + local${index}();` : `return local${index}();`;
    writeFileSync(join(directory, 'src/index.ts'), `${next}import { local${index} } from "./local";\nexport function f${index}() { ${body} }\n`);
  }
  return root;
}

test('설정 예산을 넘어도 예산 안 설정이 소유한 소스의 간선은 남고 원인이 예산으로 보고된다', async () => {
  const root = createChainedPackages(130);
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    // 예산 안에서 읽은 설정의 패키지 안 import(`./local`)는 계속 해석된다.
    assert.ok(graph.edges.some((edge) => edge.from === 'packages/p1/src/index.ts#f1' && edge.to === 'packages/p1/src/local.ts#local1'),
      `expected in-budget edges, got ${graph.edges.length}`);
    const budget = graph.limitations.find((line) => line.startsWith('graph-config: config-budget: '));
    assert.match(budget ?? '', /^graph-config: config-budget: \d+ source\(s\) are owned by compiler configs beyond the 128-config budget/u);
    assert.ok(!graph.limitations.some((line) => line.startsWith('graph-config: config-conflict: ')), graph.limitations.join('\n'));
    assert.ok(!graph.limitations.some((line) => line.startsWith('graph-config: config-ownership: ')), graph.limitations.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('설정 예산 안의 workspace는 예산 limitation을 싣지 않는다', async () => {
  const root = createChainedPackages(20);
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.edges.some((edge) => edge.from === 'packages/p1/src/index.ts#f1' && edge.to === 'packages/p2/src/index.ts#f2'));
    assert.ok(!graph.limitations.some((line) => line.includes('config-budget:')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('solution형 root references가 128개를 넘으면 막힌 소스를 소유권 충돌이 아니라 config-ownership으로 센다', async () => {
  const root = createChainedPackages(130);
  const references = Array.from({ length: 130 }, (_, index) => ({ path: `packages/p${index + 1}` }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: [], references }));
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(!graph.limitations.some((line) => line.startsWith('graph-config: config-conflict: ')), graph.limitations.join('\n'));
    const ownership = graph.limitations.find((line) => line.startsWith('graph-config: config-ownership: '));
    assert.match(ownership ?? '', /; \d+ source\(s\) were left unresolved$/u, graph.limitations.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
