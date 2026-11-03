/**
 * 내장 TypeScript가 모르는 compiler 옵션 값이 있어도 그 옵션만 버리고 `paths`·`include`는 유지하는지 검증한다.
 * 예전에는 오류 하나로 설정 전체를 기본값으로 바꿔 경로 별칭 간선이 사라지고 "parse 실패"로 알렸다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import type { CallGraph } from './graph-model.ts';

/** 별칭 import로 util을 부르는 합성 프로젝트를 만든다. */
function createAliasProject(compilerOptions: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-option-values-')));
  const files: Record<string, string> = {
    'tsconfig.json': `{ "compilerOptions": { "strict": true, "types": [], "module": "esnext", "moduleResolution": "bundler", "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, ${compilerOptions} }, "include": ["src"] }`,
    'src/lib/util.ts': 'export function util() { return 1; }\n',
    'src/main.ts': 'import { util } from "@/lib/util";\nexport function main() { return util(); }\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** 별칭 간선이 있는지 본다. */
function hasAliasEdge(graph: CallGraph): boolean {
  return graph.edges.some((edge) => edge.from === 'src/main.ts#main' && edge.to === 'src/lib/util.ts#util' && edge.evidence === 'direct');
}

test('모르는 target·lib 값과 모르는 옵션은 그 옵션만 버리고 paths 별칭을 유지한다', async () => {
  const root = createAliasProject('"target": "es2099", "lib": ["es2099", "dom"], "someFutureOption": true, "noUncheckedSideEffectImports": "yes"');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(hasAliasEdge(graph), graph.limitations.join('\n'));
    assert.ok(!graph.limitations.some((line) => line.includes('could not be parsed')), graph.limitations.join('\n'));
    const line = graph.limitations.find((candidate) => candidate.startsWith('graph-config: compiler-options: '));
    assert.ok(line !== undefined, graph.limitations.join('\n'));
    assert.ok(line.includes(`TypeScript ${ts.version}`));
    assert.ok(line.includes('lib, noUncheckedSideEffectImports, target'), line);
    assert.ok(line.includes('1 unknown option(s)'), line);
    // 사용자가 적은 모르는 옵션 이름은 입력 원문이라 싣지 않는다.
    assert.ok(!line.includes('someFutureOption'), line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('JSON 구문 오류처럼 옵션 하나로 국한되지 않는 오류는 예전처럼 설정을 읽지 못한 것으로 본다', async () => {
  const root = createAliasProject('"target": "es2022"');
  writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] }, "include": 3 }');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.limitations.some((line) => line.startsWith('graph-config: tsconfig.json could not be parsed')), graph.limitations.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('지원하는 옵션 값만 쓴 설정은 compiler-options limitation을 싣지 않는다', async () => {
  const root = createAliasProject('"target": "es2022", "lib": ["es2022"]');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(hasAliasEdge(graph));
    assert.ok(!graph.limitations.some((line) => line.includes('compiler-options:')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
