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
import { DeclarationOutputMapper } from './declaration-outputs.ts';
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

/** 파일들을 쓰고 그 절대 경로 목록을 돌려준다. */
function writeFiles(root: string, files: Readonly<Record<string, string>>): string[] {
  for (const [path, text] of Object.entries(files)) writeProjectFile(root, path, text);
  return Object.keys(files).map((path) => join(root, path));
}

test('mapper: 쓸 수 없는 declaration map은 다른 근거로 넘어가고, 여러·원격 소스 map은 쓰지 않는다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-mapper-')));
  try {
    const scanned = writeFiles(root, { 'lib/src/a.ts': '', 'lib/src/b.ts': '', 'lib/src/c.ts': '', 'lib/src/d.ts': '' });
    writeFiles(root, {
      'lib/out/a.d.ts': '', 'lib/out/a.d.ts.map': '{ not json',
      'lib/out/b.d.ts': '', 'lib/out/b.d.ts.map': '{"sources":["../src/b.ts","../src/c.ts"]}',
      'lib/out/c.d.ts': '', 'lib/out/c.d.ts.map': '{"sources":["https://example.invalid/c.ts"]}',
      'lib/out/d.d.ts': '', 'lib/out/d.d.ts.map': '[1]',
    });
    const mapper = new DeclarationOutputMapper(root, [], scanned);
    for (const name of ['a', 'b', 'c', 'd']) assert.deepEqual(mapper.match(join(root, `lib/out/${name}.d.ts`)), { kind: 'unmapped' }, name);
    // 같은 파일을 다시 물어도 같은 판정(캐시)이다.
    assert.deepEqual(mapper.match(join(root, 'lib/out/a.d.ts')), { kind: 'unmapped' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mapper: rootDir 없는 설정은 공통 소스 디렉터리로, .d.mts는 .mts로, 모호한 소스는 잇지 않는다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-mapper-')));
  try {
    const scanned = writeFiles(root, {
      'pkg/src/nested/a.mts': '', 'pkg/src/b.ts': '', 'pkg/src/twin.ts': '', 'pkg/src/twin.tsx': '', 'pkg/src/only.js': '',
    });
    const config = { path: join(root, 'pkg/tsconfig.json'), options: { declaration: true, outDir: join(root, 'pkg/build') },
      fileNames: [join(root, 'pkg/src/nested/a.mts'), join(root, 'pkg/src/b.ts'), join(root, 'pkg/src/types.d.ts')] };
    const mapper = new DeclarationOutputMapper(root, [config], scanned);
    assert.deepEqual(mapper.match(join(root, 'pkg/build/nested/a.d.mts')), { kind: 'source', fileName: join(root, 'pkg/src/nested/a.mts') });
    assert.deepEqual(mapper.match(join(root, 'pkg/build/b.d.ts')), { kind: 'source', fileName: join(root, 'pkg/src/b.ts') });
    assert.deepEqual(mapper.match(join(root, 'pkg/build/twin.d.ts')), { kind: 'unmapped' });
    assert.deepEqual(mapper.match(join(root, 'pkg/build/only.d.ts')), { kind: 'source', fileName: join(root, 'pkg/src/only.js') });
    assert.deepEqual(mapper.match(join(root, 'pkg/src/b.ts')), { kind: 'not-output' });
    assert.deepEqual(mapper.match(join(root, '..', 'outside.d.ts')), { kind: 'not-output' });
    // 내보내지 않는 설정과 진입 파일이 없는 설정은 산출물 루트를 만들지 않는다.
    const silent = new DeclarationOutputMapper(root, [{ options: {}, fileNames: [] }, { options: { declaration: true, outDir: join(root, 'x') }, fileNames: [] }], scanned);
    assert.deepEqual(silent.match(join(root, 'x/b.d.ts')), { kind: 'unmapped' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('선언을 내지 않는 설정(번들러가 dist를 만드는 tsup식 구성)의 outDir로는 되짚지 않는다', async () => {
  // dist/index.d.ts는 번들러가 만든 것이고, 같은 상대 경로의 src/index.ts는 실제 라이브러리 진입점이 아니다(CLI helper).
  const root = createWorkspace({
    'tsconfig.json': '{ "files": [], "references": [{ "path": "packages/lib" }, { "path": "apps/web" }] }',
    'packages/lib/tsconfig.json': `{ "compilerOptions": { ${compilerOptions}, "outDir": "dist" }, "include": ["src"] }`,
    'packages/lib/src/index.ts': '// CLI entry, not the library entry\nexport function helper() { return "cli"; }\n',
    'packages/lib/src/lib/index.ts': 'export function helper() { return 1; }\n',
    'apps/web/tsconfig.json': `{ "compilerOptions": { ${compilerOptions} }, "include": ["src"] }`,
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph), undefined);
    assert.match(declarationOutputLimitation(graph) ?? '', /declaration-outputs: 1 import\(s\)/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserveSymlinks로 node_modules 경로가 남아도 realpath가 프로젝트 산출물이면 되짚는다', async () => {
  const root = createWorkspace({
    'tsconfig.json': '{ "files": [], "references": [{ "path": "packages/lib" }, { "path": "apps/web" }] }',
    'packages/lib/tsconfig.json': `{ "compilerOptions": { ${compilerOptions}, "preserveSymlinks": true, "composite": true, "outDir": "dist", `
      + '"rootDir": "src" }, "include": ["src"] }',
    'apps/web/tsconfig.json': `{ "compilerOptions": { ${compilerOptions}, "preserveSymlinks": true }, "include": ["src"], `
      + '"references": [{ "path": "../../packages/lib" }] }',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph)?.evidence, 'direct');
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('preserveSymlinks 경로가 다른 type-checking 문맥의 소스로 되짚히면 조용히 사라지지 않고 문맥 경계로 알린다', async () => {
  const root = createWorkspace({
    'tsconfig.json': '{ "files": [], "references": [{ "path": "packages/lib" }, { "path": "apps/web" }] }',
    'packages/lib/tsconfig.json': `{ "compilerOptions": { ${compilerOptions}, "composite": true, "outDir": "dist", "rootDir": "src" }, "include": ["src"] }`,
    'apps/web/tsconfig.json': `{ "compilerOptions": { ${compilerOptions}, "preserveSymlinks": true }, "include": ["src"], `
      + '"references": [{ "path": "../../packages/lib" }] }',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph), undefined);
    assert.ok(graph.limitations.some((line) => line.includes('config-context-boundary: 1 import(s)')), JSON.stringify(graph.limitations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 걷기가 일부러 빼는 생성 선언을 import하는 프로젝트에서 bound 증명이 유지되는지 보는 소스다. */
const boundProbe = 'function one() { return 1; }\nexport function apply(f: () => number) { return f(); }\nexport function main2() { return apply(one); }\n';

/** 그래프에 `apply → one` bound 간선이 있는지 본다. */
function hasBoundApply(graph: CallGraph, path: string): boolean {
  return graph.edges.some((edge) => edge.from === `${path}#apply` && edge.to === `${path}#one` && edge.evidence === 'bound');
}

test('Prisma 생성 클라이언트(걷기가 뺀 출력 디렉터리)의 선언은 빌드 산출물로 세지 않는다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-prisma-')));
  writeProjectFile(root, 'package.json', '{ "name": "app", "private": true }');
  writeProjectFile(root, 'tsconfig.json', `{ "compilerOptions": { ${compilerOptions} }, "include": ["src"] }`);
  writeProjectFile(root, 'prisma/schema.prisma',
    'generator client {\n  provider = "prisma-client-js"\n  output   = "../src/generated/prisma"\n}\n'
    + 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n');
  writeProjectFile(root, 'src/generated/prisma/index.d.ts', 'export declare class PrismaClient { constructor(); }\n');
  writeProjectFile(root, 'src/generated/prisma/index.js', 'export class PrismaClient {}\n');
  writeProjectFile(root, 'src/main.ts', `import { PrismaClient } from './generated/prisma';\nexport function main() { return new PrismaClient(); }\n${boundProbe}`);
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(declarationOutputLimitation(graph), undefined);
    assert.equal(hasBoundApply(graph, 'src/main.ts'), true, JSON.stringify(graph.limitations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('점 디렉터리(.nuxt)의 프레임워크 생성 선언은 빌드 산출물로 세지 않는다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-dot-')));
  writeProjectFile(root, 'package.json', '{ "name": "app", "private": true }');
  writeProjectFile(root, 'tsconfig.json',
    `{ "compilerOptions": { ${compilerOptions}, "paths": { "#imports": ["./.nuxt/imports"] } }, "include": ["server"] }`);
  writeProjectFile(root, '.nuxt/imports.d.ts', 'export declare function useRuntimeConfig(): Record<string, string>;\n');
  writeProjectFile(root, 'server/api/hello.ts', `import { useRuntimeConfig } from '#imports';\nexport function handler() { return useRuntimeConfig(); }\n${boundProbe}`);
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(declarationOutputLimitation(graph), undefined);
    assert.equal(hasBoundApply(graph, 'server/api/hello.ts'), true, JSON.stringify(graph.limitations));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mapper: 스캔 밖 소스를 가리키는 declaration map은 다른 근거가 있어도 unmapped로 끝낸다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-mapper-')));
  try {
    const scanned = writeFiles(root, { 'pkg/src/a.ts': '' });
    writeFiles(root, { 'pkg/out/a.d.ts': '', 'pkg/out/a.d.ts.map': '{"sources":["../../elsewhere/a.ts"]}' });
    const config = { path: join(root, 'pkg/tsconfig.json'),
      options: { declaration: true, outDir: join(root, 'pkg/out'), rootDir: join(root, 'pkg/src') }, fileNames: scanned };
    const mapper = new DeclarationOutputMapper(root, [config], scanned);
    assert.deepEqual(mapper.match(join(root, 'pkg/out/a.d.ts')), { kind: 'unmapped' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mapper: 선언을 내지 않는 설정은 산출물 루트가 아니고, 제외·점 디렉터리 선언은 산출물이 아니다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-mapper-')));
  try {
    const scanned = writeFiles(root, { 'pkg/src/b.ts': '' });
    const options = { outDir: join(root, 'pkg/build'), rootDir: join(root, 'pkg/src') };
    const emitting = (extra: object) => new DeclarationOutputMapper(root, [{ options: { ...options, ...extra }, fileNames: scanned }], scanned);
    assert.deepEqual(emitting({}).match(join(root, 'pkg/build/b.d.ts')), { kind: 'unmapped' });
    for (const extra of [{ declaration: true }, { composite: true }, { emitDeclarationOnly: true }]) {
      assert.deepEqual(emitting(extra).match(join(root, 'pkg/build/b.d.ts')), { kind: 'source', fileName: join(root, 'pkg/src/b.ts') }, JSON.stringify(extra));
    }
    const excluded = new DeclarationOutputMapper(root, [], scanned, new Set([join(root, 'src/generated')]));
    assert.deepEqual(excluded.match(join(root, 'src/generated/client/index.d.ts')), { kind: 'not-output' });
    assert.deepEqual(excluded.match(join(root, '.nuxt/imports.d.ts')), { kind: 'not-output' });
    assert.deepEqual(excluded.match(join(root, 'apps/.svelte-kit/types/a.d.ts')), { kind: 'not-output' });
    assert.deepEqual(excluded.match(join(root, 'src/generatedX/index.d.ts')), { kind: 'unmapped' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
