/**
 * 프로젝트 안에서 빌드된 workspace 패키지의 선언 산출물(`dist/*.d.ts`)을 같은 패키지 소스로 되짚어 잇는지 검증한다.
 * 되짚지 못하면 호출을 외부로 조용히 세지 않고 limitation으로 알려야 한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import type { CallGraph } from './graph-model.ts';

/** 호출하는 앱과 호출되는 라이브러리 함수의 그래프 id다. */
const callerId = 'apps/web/src/main.ts#main';
const helperId = 'packages/lib/src/index.ts#helper';

/** 합성 workspace의 파일 하나를 쓴다. */
function writeProjectFile(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/**
 * `@acme/lib`를 node_modules symlink로 노출하고, 타입 진입점이 빌드 산출물 `dist/index.d.ts`인 workspace를 만든다.
 *
 * @param files 시나리오별 추가 파일(상대 경로 → 내용)
 * @returns 프로젝트 realpath
 */
function createWorkspace(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-outputs-')));
  writeProjectFile(root, 'package.json', '{ "name": "root", "private": true, "workspaces": ["packages/*", "apps/*"] }');
  writeProjectFile(root, 'packages/lib/package.json',
    '{ "name": "@acme/lib", "private": true, "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } } }');
  writeProjectFile(root, 'packages/lib/src/index.ts', 'export function helper() { return 1; }\n');
  writeProjectFile(root, 'packages/lib/dist/index.d.ts', 'export declare function helper(): number;\n');
  writeProjectFile(root, 'packages/lib/dist/index.js', 'export function helper() { return 1; }\n');
  writeProjectFile(root, 'apps/web/src/main.ts', 'import { helper } from "@acme/lib";\nexport function main() { return helper(); }\n');
  for (const [path, text] of Object.entries(files)) writeProjectFile(root, path, text);
  mkdirSync(join(root, 'node_modules/@acme'), { recursive: true });
  symlinkSync(join(root, 'packages/lib'), join(root, 'node_modules/@acme/lib'), 'dir');
  return root;
}

/** 그래프에서 호출자→helper 간선을 찾는다. */
function helperEdge(graph: CallGraph) {
  return graph.edges.find((edge) => edge.from === callerId && edge.to === helperId);
}

/** 선언 산출물 limitation을 찾는다. */
function declarationOutputLimitation(graph: CallGraph): string | undefined {
  return graph.limitations.find((line) => line.includes('declaration-outputs:'));
}

/** 공통 compiler 옵션이다. 전역 타입 탐색을 끄고 번들러 해석을 쓴다. */
const compilerOptions = '"strict": true, "types": [], "lib": ["es2022"], "module": "esnext", "moduleResolution": "bundler", "target": "es2022"';

test('project reference의 outDir/rootDir 산출물은 같은 패키지 소스로 잇는다', async () => {
  const root = createWorkspace({
    'tsconfig.json': '{ "files": [], "references": [{ "path": "packages/lib" }, { "path": "apps/web" }] }',
    'packages/lib/tsconfig.json': `{ "compilerOptions": { ${compilerOptions}, "composite": true, "outDir": "dist", "rootDir": "src" }, "include": ["src"] }`,
    'apps/web/tsconfig.json': `{ "compilerOptions": { ${compilerOptions} }, "include": ["src"], "references": [{ "path": "../../packages/lib" }] }`,
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph)?.evidence, 'direct');
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('composite 설정의 기본 rootDir(설정 디렉터리)로도 산출물을 되짚는다', async () => {
  const root = createWorkspace({
    'packages/lib/dist/src/index.d.ts': 'export declare function helper(): number;\n',
    'packages/lib/package.json': '{ "name": "@acme/lib", "private": true, "types": "./dist/src/index.d.ts" }',
    'packages/lib/tsconfig.json': `{ "compilerOptions": { ${compilerOptions}, "composite": true, "outDir": "dist" }, "include": ["src"] }`,
    'tsconfig.json': `{ "compilerOptions": { ${compilerOptions} } }`,
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph)?.evidence, 'direct');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('declaration map이 가리키는 소스로 잇는다', async () => {
  const root = createWorkspace({
    'packages/lib/dist/index.d.ts.map': '{"version":3,"file":"index.d.ts","sourceRoot":"","sources":["../src/index.ts"],"names":[],"mappings":""}',
    'tsconfig.json': `{ "compilerOptions": { ${compilerOptions} } }`,
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph)?.evidence, 'direct');
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('스캔 밖 소스를 가리키는 declaration map은 잇지 않고 limitation으로 남긴다', async () => {
  const root = createWorkspace({
    'packages/lib/dist/index.d.ts.map': '{"version":3,"file":"index.d.ts","sources":["../../../../outside/index.ts"],"names":[],"mappings":""}',
    'tsconfig.json': `{ "compilerOptions": { ${compilerOptions} } }`,
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph), undefined);
    assert.match(declarationOutputLimitation(graph) ?? '', /declaration-outputs: 1 import\(s\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('소스로 되짚을 근거가 없는 프로젝트 안 산출물은 limitation으로 알린다', async () => {
  const root = createWorkspace({ 'tsconfig.json': `{ "compilerOptions": { ${compilerOptions} } }` });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph), undefined);
    const line = declarationOutputLimitation(graph);
    assert.match(line ?? '', /^graph-config: declaration-outputs: 1 import\(s\) resolve to declaration files inside the project/u);
    assert.match(line ?? '', /files: \["packages\/lib\/dist\/index\.d\.ts"\]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('같은 디렉터리의 JavaScript 구현을 설명하는 선언 파일은 그 구현으로 잇는다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-sibling-')));
  writeProjectFile(root, 'tsconfig.json', `{ "compilerOptions": { ${compilerOptions}, "allowJs": true } }`);
  writeProjectFile(root, 'src/legacy.js', 'export function legacy() { return 1; }\n');
  writeProjectFile(root, 'src/legacy.d.ts', 'export declare function legacy(): number;\n');
  writeProjectFile(root, 'src/main.ts', 'import { legacy } from "./legacy";\nexport function main() { return legacy(); }\n');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const edge = graph.edges.find((candidate) => candidate.from === 'src/main.ts#main' && candidate.to === 'src/legacy.js#legacy');
    assert.equal(edge?.evidence, 'direct');
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('프로젝트 밖 의존성(node_modules 실경로)의 선언은 산출물로 세지 않는다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-external-')));
  writeProjectFile(root, 'tsconfig.json', `{ "compilerOptions": { ${compilerOptions} } }`);
  writeProjectFile(root, 'node_modules/ext/package.json', '{ "name": "ext", "types": "./index.d.ts" }');
  writeProjectFile(root, 'node_modules/ext/index.d.ts', 'export declare function ext(): number;\n');
  writeProjectFile(root, 'src/main.ts', 'import { ext } from "ext";\nexport function main() { return ext(); }\n');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
