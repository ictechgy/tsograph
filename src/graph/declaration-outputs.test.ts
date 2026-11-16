/**
 * 프로젝트 안에서 빌드된 workspace 패키지의 선언 산출물(`dist/*.d.ts`)을 같은 패키지 소스로 되짚어 잇는지 검증한다.
 * 되짚지 못하면 호출을 외부로 조용히 세지 않고 limitation으로 알려야 한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

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
    // mapper는 TypeScript가 실제로 해석한(존재하는) 선언만 받는다. export 이름 대조가 읽을 수 있게 산출물도 둔다.
    writeFiles(root, { 'pkg/build/nested/a.d.mts': '', 'pkg/build/b.d.ts': '', 'pkg/build/twin.d.ts': '', 'pkg/build/only.d.ts': '' });
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
    writeFiles(root, { 'pkg/build/b.d.ts': '' });
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

/** 선언과 같은 상대 경로의 소스 export 이름이 다를 때 limitation 문장에 붙는 내역이다. */
function exportMismatchClause(count: number): RegExp {
  return new RegExp(`; ${count} of them reach a source through declarationDir/outDir and rootDir that does not export every name`, 'u');
}

/** 선언을 내는 설정(`declaration: true`, `outDir: dist`, `rootDir: src`)을 쓰는 project reference workspace의 설정 파일이다. */
const emittingReferences = {
  'tsconfig.json': '{ "files": [], "references": [{ "path": "packages/lib" }, { "path": "apps/web" }] }',
  'packages/lib/tsconfig.json': `{ "compilerOptions": { ${compilerOptions}, "composite": true, "declaration": true, "outDir": "dist", "rootDir": "src" }, "include": ["src"] }`,
  'apps/web/tsconfig.json': `{ "compilerOptions": { ${compilerOptions} }, "include": ["src"], "references": [{ "path": "../../packages/lib" }] }`,
};

test('번들러가 outDir을 다른 진입점의 선언으로 덮어쓰면 같은 상대 경로 소스로 잇지 않고 limitation으로 센다', async () => {
  // dist/index.d.ts는 번들러가 src/lib/index.ts 진입점에서 만든 것이다. 같은 상대 경로의 src/index.ts는 CLI 진입점이라
  // 같은 이름 helper를 내보내도 다른 함수이고, 선언의 format은 내보내지 않는다. 이름이 맞지 않으므로 잇지 않는다.
  const root = createWorkspace({
    ...emittingReferences,
    'packages/lib/src/index.ts': '// CLI entry, not the library entry\nexport function helper() { return 2; }\nexport function runCli() { return helper(); }\n',
    'packages/lib/src/lib/index.ts': 'export function helper() { return 1; }\nexport function format(value: number) { return String(value); }\n',
    'packages/lib/dist/index.d.ts': 'export declare function helper(): number;\nexport declare function format(value: number): string;\n',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph), undefined, JSON.stringify(graph.edges.filter((edge) => edge.from === callerId)));
    const line = declarationOutputLimitation(graph) ?? '';
    assert.match(line, /^graph-config: declaration-outputs: 1 import\(s\) resolve to declaration files inside the project/u);
    assert.match(line, exportMismatchClause(1));
    assert.match(line, /files: \["packages\/lib\/dist\/index\.d\.ts"\]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('선언 export 이름이 소스 export 이름의 부분집합이면(stripInternal 등) outDir/rootDir로 잇는다', async () => {
  const root = createWorkspace({
    ...emittingReferences,
    'packages/lib/src/index.ts': 'export function helper() { return 1; }\n/** @internal */\nexport function internalHelper() { return 2; }\nexport interface Options { readonly verbose: boolean }\n',
    'packages/lib/dist/index.d.ts': 'export declare function helper(): number;\nexport interface Options {\n    readonly verbose: boolean;\n}\n',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(helperEdge(graph)?.evidence, 'direct');
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 재내보내기로 이름을 모으는 라이브러리 진입점이다. 소스와 선언 산출물이 같은 모양이다. */
const reexportingLibrary = {
  'packages/lib/src/index.ts': 'export * from "./helpers";\nexport { format as formatValue } from "./format";\nexport type { Options } from "./types";\n',
  'packages/lib/src/helpers.ts': 'export function helper() { return 1; }\n',
  'packages/lib/src/format.ts': 'export function format(value: number) { return String(value); }\n',
  'packages/lib/src/types.ts': 'export interface Options { readonly verbose: boolean }\n',
  'packages/lib/dist/index.d.ts': 'export * from "./helpers";\nexport { format as formatValue } from "./format";\nexport type { Options } from "./types";\n',
  'packages/lib/dist/helpers.d.ts': 'export declare function helper(): number;\n',
  'packages/lib/dist/format.d.ts': 'export declare function format(value: number): string;\n',
  'packages/lib/dist/types.d.ts': 'export interface Options {\n    readonly verbose: boolean;\n}\n',
};

test('재내보내기(export *, export { as }, export type)로 모은 이름이 맞으면 잇는다', async () => {
  const root = createWorkspace({ ...emittingReferences, ...reexportingLibrary });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const edge = graph.edges.find((candidate) => candidate.from === callerId && candidate.to === 'packages/lib/src/helpers.ts#helper');
    assert.equal(edge?.evidence, 'direct', JSON.stringify(graph.edges.filter((candidate) => candidate.from === callerId)));
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('선언의 export *가 소스에 없는 이름을 끌어오면 잇지 않고 limitation으로 센다', async () => {
  // 번들러가 다른 배치로 덮어쓴 dist/helpers.d.ts에는 소스 src/helpers.ts에 없는 legacyHelper가 있다.
  const root = createWorkspace({
    ...emittingReferences, ...reexportingLibrary,
    'packages/lib/dist/helpers.d.ts': 'export declare function helper(): number;\nexport declare function legacyHelper(): number;\n',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(graph.edges.find((candidate) => candidate.from === callerId && candidate.to.startsWith('packages/lib/')), undefined);
    // 앱의 import(dist/index.d.ts)와, 잇지 않은 그 선언이 다시 읽는 dist/helpers.d.ts의 export *가 모두 불일치로 센다.
    const line = declarationOutputLimitation(graph) ?? '';
    assert.match(line, /declaration-outputs: 2 import\(s\)/u);
    assert.match(line, exportMismatchClause(2));
    assert.match(line, /files: \["packages\/lib\/dist\/helpers\.d\.ts","packages\/lib\/dist\/index\.d\.ts"\]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mapper: outDir/rootDir 경로의 소스가 선언 export 이름을 모두 내보내지 않으면 export 불일치로 unmapped다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-exports-')));
  try {
    const scanned = writeFiles(root, {
      'pkg/src/match.ts': 'export function a() {}\nexport const b = 1, { c } = { c: 2 };\nexport default class {}\n',
      'pkg/src/mismatch.ts': 'export function a() {}\n',
      'pkg/src/equals.ts': 'function main() {}\nexport = main;\n',
      'pkg/src/local.ts': 'function a() {}\nexport { a as renamed };\nexport import Alias = Space.Inner;\nnamespace Space { export const Inner = 1; }\n',
      'pkg/src/bare.ts': 'export * from "@not-installed/shared";\nexport function own() {}\n',
      'pkg/src/missing.ts': 'export * from "./absent";\nexport function own() {}\n',
      'pkg/src/otherbare.ts': 'export * from "@not-installed/shared";\nexport function own() {}\n',
      'pkg/src/stray.ts': 'export function own() {}\n',
    });
    writeFiles(root, {
      'pkg/out/match.d.ts': 'export declare function a(): void;\nexport declare const b = 1, c: number;\ndeclare const _default: {};\nexport default _default;\n',
      'pkg/out/mismatch.d.ts': 'export declare function a(): void;\nexport declare function extra(): void;\n',
      'pkg/out/equals.d.ts': 'declare function main(): void;\nexport = main;\n',
      'pkg/out/local.d.ts': 'declare function a(): void;\nexport { a as renamed };\nexport import Alias = Space.Inner;\ndeclare namespace Space { const Inner = 1; }\n',
      // 해석하지 못한 bare export *는 소스에도 같은 지정자가 있을 때만 같은 이름을 낸다고 본다.
      'pkg/out/bare.d.ts': 'export * from "@not-installed/shared";\nexport declare function own(): void;\n',
      // 해석하지 못한 상대 export *는 tsc가 지정자를 쓴 그대로 옮기므로 소스의 같은 위치에 같은 지정자가 있으면 상쇄한다.
      'pkg/out/missing.d.ts': 'export * from "./absent";\nexport declare function own(): void;\n',
      // 소스에 없는 상대 export *는 이 소스에서 나온 선언이 아니라는 증거다.
      'pkg/out/stray.d.ts': 'export * from "./absent";\nexport declare function own(): void;\n',
      // 소스에 없는 bare export *는 선언이 소스에 없는 이름을 낼 수 있으므로 잇지 않는다.
      'pkg/out/otherbare.d.ts': 'export * from "@not-installed/other";\nexport declare function own(): void;\n',
    });
    const config = { path: join(root, 'pkg/tsconfig.json'),
      options: { declaration: true, allowJs: true, outDir: join(root, 'pkg/out'), rootDir: join(root, 'pkg/src') }, fileNames: scanned };
    const mapper = new DeclarationOutputMapper(root, [config], scanned);
    for (const name of ['match', 'equals', 'local', 'bare', 'missing']) {
      assert.deepEqual(mapper.match(join(root, `pkg/out/${name}.d.ts`)), { kind: 'source', fileName: join(root, `pkg/src/${name}.ts`) }, name);
    }
    for (const name of ['mismatch', 'stray', 'otherbare']) {
      assert.deepEqual(mapper.match(join(root, `pkg/out/${name}.d.ts`)), { kind: 'unmapped', exportMismatch: true }, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mapper: declaration map과 같은 이름 JavaScript 형제는 export 이름을 대조하지 않는다(기존 근거 유지)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-exports-')));
  try {
    const scanned = writeFiles(root, { 'pkg/src/a.ts': 'export function a() {}\n', 'lib/legacy.js': 'module.exports = function legacy() {};\n' });
    writeFiles(root, {
      'pkg/out/a.d.ts': 'export declare function different(): void;\n', 'pkg/out/a.d.ts.map': '{"sources":["../src/a.ts"]}',
      'lib/legacy.d.ts': 'export declare function legacy(): void;\n',
    });
    const config = { options: { declaration: true, outDir: join(root, 'pkg/out'), rootDir: join(root, 'pkg/src') }, fileNames: scanned };
    const mapper = new DeclarationOutputMapper(root, [config], scanned);
    assert.deepEqual(mapper.match(join(root, 'pkg/out/a.d.ts')), { kind: 'source', fileName: join(root, 'pkg/src/a.ts') });
    assert.deepEqual(mapper.match(join(root, 'lib/legacy.d.ts')), { kind: 'source', fileName: join(root, 'lib/legacy.js') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 자기 이름으로 자신을 import하는 단일 패키지의 호출자 id다. */
const selfCallerId = 'src/app.ts#main';

/**
 * 선언을 내는 설정(`declaration: true`, `outDir`, `rootDir: src`)의 단일 패키지가 `exports.types`로 자기 산출물을 가리키고
 * `src/app.ts`가 패키지 이름으로 자신을 import하는 프로젝트를 만든다. `outDir`이 `lib`면 걷기가 빼지 않아 산출물 `.js`도 스캔한다.
 *
 * @param outDir 산출물 디렉터리 이름
 * @param files 시나리오별 파일(상대 경로 → 내용)
 * @param extraOptions 설정에 더할 compiler 옵션 JSON 조각
 * @returns 프로젝트 realpath
 */
function createSelfReferencingPackage(outDir: string, files: Readonly<Record<string, string>>, extraOptions = ''): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-self-')));
  writeProjectFile(root, 'package.json',
    `{ "name": "pkg", "private": true, "exports": { ".": { "types": "./${outDir}/index.d.ts", "default": "./${outDir}/index.js" } } }`);
  writeProjectFile(root, 'tsconfig.json', `{ "compilerOptions": { ${compilerOptions}, "declaration": true, "outDir": "${outDir}", "rootDir": "src"${extraOptions} }, "include": ["src"] }`);
  writeProjectFile(root, 'src/app.ts', 'import { helper } from "pkg";\nexport function main() { return helper(); }\n');
  for (const [path, text] of Object.entries(files)) writeProjectFile(root, path, text);
  return root;
}

test('outDir lib의 선언 이름이 맞지 않으면 같은 이름 빌드 출력 lib/index.js로 넘어가지 않고 불일치로 센다', async () => {
  // 번들러가 lib/index.d.ts와 lib/index.js를 다른 진입점에서 다시 만들었다. lib는 걷기가 빼지 않아 lib/index.js도 스캔한 소스다.
  const root = createSelfReferencingPackage('lib', {
    'src/index.ts': 'export function helper() { return 1; }\n',
    'lib/index.d.ts': 'export declare function helper(): number;\nexport declare function format(value: number): string;\n',
    'lib/index.js': 'export function helper() { return 1; }\nexport function format(value) { return String(value); }\n',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const calls = graph.edges.filter((edge) => edge.from === selfCallerId);
    assert.deepEqual(calls.map((edge) => edge.to), [], JSON.stringify(calls));
    const line = declarationOutputLimitation(graph) ?? '';
    assert.match(line, /^graph-config: declaration-outputs: 1 import\(s\)/u);
    assert.match(line, exportMismatchClause(1));
    assert.match(line, /files: \["lib\/index\.d\.ts"\]/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * CommonJS 소스 모양과 실제 tsc 5.9 선언 emit(`declaration`·`allowJs`)이다. 선언 이름은 checker가 정해 최상위 구문만 보는 표에는
 * 없다. 모두 소스로 이어야 한다.
 */
const commonJsShapes: Readonly<Record<string, readonly [source: string, declaration: string]>> = {
  objectAlias: ['function helper() { return 1; }\nconst api = { helper };\nmodule.exports = api;\n', 'export function helper(): number;\n'],
  factoryCall: ['function helper() { return 1; }\nfunction create() { return { helper }; }\nmodule.exports = create();\n',
    'export function helper(): number;\n'],
  propertyAlias: ['function helper() { return 1; }\nconst api = {};\napi.helper = helper;\nmodule.exports = api;\n',
    'export function helper(): number;\n'],
  chainedVar: ['var helper = exports.helper = function () { return 1; };\n', 'export function helper(): number;\n'],
  insideIf: ['function helper() { return 1; }\nif (typeof globalThis === "object") { exports.helper = helper; }\n',
    'export function helper(): number;\n'],
  insideTry: ['function helper() { return 1; }\ntry { exports.helper = helper; } catch (error) { }\n', 'export function helper(): number;\n'],
  insideIife: ['(function () {\n  function helper() { return 1; }\n  exports.helper = helper;\n})();\n', 'export function helper(): number;\n'],
  selfAlias: ['function helper() { return 1; }\nconst self = module.exports;\nself.helper = helper;\n', 'export function helper(): number;\n'],
  voidExpression: ['function helper() { return 1; }\nvoid (exports.helper = helper);\n', 'export function helper(): number;\n'],
  conditionalRequire: ['if (typeof globalThis === "object") {\n  module.exports = require("./prod");\n} else {\n  module.exports = require("./dev");\n}\n',
    'declare const _exports: typeof import("./prod") | typeof import("./dev");\nexport = _exports;\n'],
  typedefInDeclarationList: ['function helper() { return 1; }\nconst x = 1, /** @typedef {{ v: number }} Shape */ y = 2;\nexports.helper = helper;\n',
    'export type Shape = {\n    v: number;\n};\nexport function helper(): number;\n'],
};

test('mapper: JavaScript 소스는 export 이름을 대조하지 않고 outDir/rootDir로 잇는다(CommonJS 모양)', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-commonjs-')));
  try {
    const entries = Object.entries(commonJsShapes);
    const scanned = writeFiles(root, Object.fromEntries(entries.map(([name, [source]]) => [`pkg/src/${name}.js`, source])));
    writeFiles(root, Object.fromEntries(entries.map(([name, [, declaration]]) => [`pkg/dist/${name}.d.ts`, declaration])));
    const config = { path: join(root, 'pkg/tsconfig.json'),
      options: { declaration: true, allowJs: true, outDir: join(root, 'pkg/dist'), rootDir: join(root, 'pkg/src') }, fileNames: scanned };
    const mapper = new DeclarationOutputMapper(root, [config], scanned);
    for (const [name] of entries) {
      assert.deepEqual(mapper.match(join(root, `pkg/dist/${name}.d.ts`)), { kind: 'source', fileName: join(root, `pkg/src/${name}.js`) }, name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const name of ['objectAlias', 'factoryCall', 'insideIf', 'insideTry', 'insideIife'] as const) {
  test(`CommonJS 소스(${name})로 가는 outDir/rootDir 간선을 이름 대조로 잃지 않는다`, async () => {
    const [source, declaration] = commonJsShapes[name]!;
    const root = createSelfReferencingPackage('dist', { 'src/index.js': source, 'dist/index.d.ts': declaration }, ', "allowJs": true');
    try {
      const graph = await buildCallGraph(root, createNodeFileSystem());
      const calls = graph.edges.filter((edge) => edge.from === selfCallerId);
      assert.deepEqual(calls.map((edge) => edge.to), ['src/index.js#helper'], JSON.stringify(calls));
      assert.equal(declarationOutputLimitation(graph), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('TypeScript 소스가 export *로 CommonJS 모듈을 다시 내보내도 그 이름 때문에 잇지 않는 일은 없다', async () => {
  // tsc는 src/legacy.js에서 dist/legacy.d.ts의 helper를 checker로 읽어 낸다. 소스 쪽 export *가 닿은 JavaScript는 대조를 끈다.
  const root = createSelfReferencingPackage('dist', {
    'src/index.ts': 'export * from "./legacy";\nexport function own() { return 2; }\n',
    'src/legacy.js': commonJsShapes.chainedVar![0],
    'src/app.ts': 'import { own } from "pkg";\nexport function main() { return own(); }\n',
    'dist/index.d.ts': 'export * from "./legacy";\nexport declare function own(): number;\n',
    'dist/legacy.d.ts': commonJsShapes.chainedVar![1],
  }, ', "allowJs": true');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const calls = graph.edges.filter((edge) => edge.from === selfCallerId);
    assert.deepEqual(calls.map((edge) => `${edge.to}:${edge.evidence}`), ['src/index.ts#own:direct'], JSON.stringify(calls));
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tsc가 outDir로 복사하지 않은 손으로 쓴 src/types.d.ts를 export *해도 소스로 잇는다', async () => {
  // 실제 tsc emit: lib/index.d.ts는 `export * from "./types"`를 그대로 두지만 lib/types.d.ts는 만들지 않는다. 같은 위치의 같은
  // 지정자라 상쇄하고, 이름이 맞으니 lib/index.js(빌드 출력)가 아니라 src/index.ts로 잇는다.
  const root = createSelfReferencingPackage('lib', {
    'src/index.ts': 'export * from "./types";\nexport function helper() { return 1; }\n',
    'src/types.d.ts': 'export interface Options { readonly verbose: boolean }\n',
    'lib/index.d.ts': 'export * from "./types";\nexport declare function helper(): number;\n',
    'lib/index.js': 'export * from "./types";\nexport function helper() { return 1; }\n',
    'lib/app.d.ts': 'export declare function main(): number;\n',
    'lib/app.js': 'import { helper } from "pkg";\nexport function main() { return helper(); }\n',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const calls = graph.edges.filter((edge) => edge.from === selfCallerId);
    assert.deepEqual(calls.map((edge) => `${edge.to}:${edge.evidence}`), ['src/index.ts#helper:direct'], JSON.stringify(calls));
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export * from 의존성 패키지는 그 패키지 폐쇄가 깨져 있어도 같은 대상이면 소스로 잇는다', async () => {
  // dep의 선언 폐쇄에는 해석하지 못하는 상대 재내보내기가 있다. 소스와 선언이 같은 파일로 해석하므로 따라가지 않고 상쇄한다.
  // (의존성 이름이 패키지 자기 이름 pkg와 같으면 자기 참조로 해석되므로 다른 이름을 쓴다.)
  const root = createSelfReferencingPackage('dist', {
    'node_modules/dep/package.json': '{ "name": "dep", "types": "./index.d.ts" }',
    'node_modules/dep/index.d.ts': 'export * from "./missing";\nexport declare const fromPackage: 1;\n',
    'src/index.ts': 'export * from "dep";\nexport function helper() { return 1; }\n',
    'dist/index.d.ts': 'export * from "dep";\nexport declare function helper(): number;\n',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const calls = graph.edges.filter((edge) => edge.from === selfCallerId);
    assert.deepEqual(calls.map((edge) => `${edge.to}:${edge.evidence}`), ['src/index.ts#helper:direct'], JSON.stringify(calls));
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mapper: 선언의 export * 대상이 의존성 패키지면 4 MiB 넘는 파일·예산을 넘는 폐쇄를 읽지 않고 해석한 대상으로 비교한다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-external-star-')));
  try {
    // big은 1,100개 모듈 barrel이라 따라가면 표 하나의 예산(1,024개 파일)을 넘고, 4 MiB를 넘는 생성 선언도 있다.
    const barrel = Array.from({ length: 1100 }, (_, index) => `export * from "./m${index}";`).join('\n');
    writeFiles(root, Object.fromEntries(Array.from({ length: 1100 },
      (_, index) => [`node_modules/big/m${index}.d.ts`, `export declare const m${index}: ${index};\n`])));
    writeFiles(root, {
      'node_modules/big/package.json': '{ "name": "big", "types": "./index.d.ts" }',
      'node_modules/big/index.d.ts': `export * from "./huge";\n${barrel}\n`,
      'node_modules/big/huge.d.ts': `export declare const huge: 1;\n${'/'.repeat(4 * 1024 * 1024 + 1)}\n`,
      'node_modules/other/package.json': '{ "name": "other", "types": "./index.d.ts" }',
      'node_modules/other/index.d.ts': 'export declare const other: 1;\n',
      'pkg/out/same.d.ts': 'export * from "big";\nexport declare function own(): void;\n',
      'pkg/out/alias.d.ts': 'export * from "big/index.js";\nexport declare function own(): void;\n',
      'pkg/out/different.d.ts': 'export * from "other";\nexport declare function own(): void;\n',
    });
    const scanned = writeFiles(root, Object.fromEntries(['same', 'alias', 'different']
      .map((name) => [`pkg/src/${name}.ts`, 'export * from "big";\nexport function own() {}\n'])));
    const config = { path: join(root, 'pkg/tsconfig.json'), options: { declaration: true, outDir: join(root, 'pkg/out'), rootDir: join(root, 'pkg/src'),
      module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler }, fileNames: scanned };
    const mapper = new DeclarationOutputMapper(root, [config], scanned);
    // 지정자가 달라도(big/index.js) 같은 외부 파일로 해석하면 같은 재내보내기다.
    for (const name of ['same', 'alias']) {
      assert.deepEqual(mapper.match(join(root, `pkg/out/${name}.d.ts`)), { kind: 'source', fileName: join(root, `pkg/src/${name}.ts`) }, name);
    }
    assert.deepEqual(mapper.match(join(root, 'pkg/out/different.d.ts')), { kind: 'unmapped', exportMismatch: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('같은 import를 모드마다 다르게 해석하면 import 수와 export 불일치 내역이 마지막 판정 하나를 센다', async () => {
  // main.mts의 값 import는 import 조건(dist/esm, 이름 불일치)으로, 같은 지정자의 require 모드 타입 import는 require 조건
  // (dist/cjs, 근거 없음)으로 해석된다. import 키(파일·지정자)는 하나이므로 마지막 판정(dist/cjs)만 세고, 그 판정에 없는
  // 불일치 내역을 붙이지 않는다.
  const nodeNext = '"strict": true, "types": [], "lib": ["es2022"], "module": "nodenext", "moduleResolution": "nodenext", "target": "es2022"';
  const root = createWorkspace({
    'tsconfig.json': '{ "files": [], "references": [{ "path": "packages/lib" }, { "path": "apps/web" }] }',
    'packages/lib/package.json': '{ "name": "@acme/lib", "private": true, "exports": { ".": { "import": { "types": "./dist/esm/index.d.ts" }, '
      + '"require": { "types": "./dist/cjs/index.d.ts" } } } }',
    'packages/lib/tsconfig.json': `{ "compilerOptions": { ${nodeNext}, "composite": true, "declaration": true, "outDir": "dist/esm", "rootDir": "src" }, "include": ["src"] }`,
    'packages/lib/src/index.ts': 'export function helper() { return 1; }\nexport interface Options { readonly verbose: boolean }\n',
    'packages/lib/dist/esm/index.d.ts': 'export declare function helper(): number;\nexport declare function extra(): void;\nexport interface Options { readonly verbose: boolean }\n',
    'packages/lib/dist/cjs/index.d.ts': 'export declare function helper(): number;\nexport interface Options { readonly verbose: boolean }\n',
    'apps/web/tsconfig.json': `{ "compilerOptions": { ${nodeNext} }, "include": ["src"], "references": [{ "path": "../../packages/lib" }] }`,
    // 기본 fixture의 main.ts import는 이 사례와 무관하므로 지운다.
    'apps/web/src/main.ts': 'export const unrelated = 1;\n',
    'apps/web/src/main.mts': 'import { helper } from "@acme/lib";\nimport type { Options } from "@acme/lib" with { "resolution-mode": "require" };\n'
      + 'export function main(options?: Options) { return helper(); }\n',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const line = declarationOutputLimitation(graph) ?? '';
    assert.match(line, /declaration-outputs: 1 import\(s\)/u);
    assert.match(line, /files: \["packages\/lib\/dist\/cjs\/index\.d\.ts"\]/u);
    assert.doesNotMatch(line, /of them reach a source through declarationDir\/outDir/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mapper: 소스 쪽만 4 MiB를 넘어 읽지 못한 생성 모듈을 export *해도 선언이 따라가 읽은 이름 때문에 잇지 않는 일은 없다', () => {
  // 실제 tsc emit에서 src/generated.ts(4.4 MB)는 읽기 상한을 넘고 dist/generated.d.ts(3.9 MB)는 넘지 않는다. main은 잇는다.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-unread-source-')));
  try {
    const scanned = writeFiles(root, {
      'pkg/src/index.ts': 'export * from "./generated";\nexport function helper() { return 1; }\n',
      'pkg/src/generated.ts': `export function generated0() { return 0; }\n${'/'.repeat(4 * 1024 * 1024 + 1)}\n`,
    });
    writeFiles(root, {
      'pkg/out/index.d.ts': 'export * from "./generated";\nexport declare function helper(): number;\n',
      'pkg/out/generated.d.ts': 'export declare function generated0(): number;\n',
    });
    const config = { path: join(root, 'pkg/tsconfig.json'), options: { declaration: true, outDir: join(root, 'pkg/out'), rootDir: join(root, 'pkg/src') },
      fileNames: scanned };
    const mapper = new DeclarationOutputMapper(root, [config], scanned);
    assert.deepEqual(mapper.match(join(root, 'pkg/out/index.d.ts')), { kind: 'source', fileName: join(root, 'pkg/src/index.ts') });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('체크아웃에 없는 생성 소스를 export *해도 남아 있는 그 선언의 이름 때문에 잇지 않는 일은 없다', async () => {
  // src/generated.ts는 빌드 때 만들어지고 커밋되지 않았지만 dist/generated.d.ts는 남아 있다. 소스 쪽 재내보내기는 해석하지 못한다.
  const root = createSelfReferencingPackage('dist', {
    'src/index.ts': 'export * from "./generated";\nexport function helper() { return 1; }\n',
    'dist/index.d.ts': 'export * from "./generated";\nexport declare function helper(): number;\n',
    'dist/generated.d.ts': 'export declare function generated0(): number;\n',
  });
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const calls = graph.edges.filter((edge) => edge.from === selfCallerId);
    assert.deepEqual(calls.map((edge) => `${edge.to}:${edge.evidence}`), ['src/index.ts#helper:direct'], JSON.stringify(calls));
    assert.equal(declarationOutputLimitation(graph), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('mapper: 프로젝트 안 barrel이 1,024개 파일을 넘어도 같은 배치면 잇고, 예산 밖 위치가 소스에 없으면 잇지 않는다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-budget-')));
  try {
    const stars = (count: number) => Array.from({ length: count }, (_, index) => `export * from "./barrel/m${index}";`).join('\n');
    const modules = (side: 'src' | 'out') => Object.fromEntries(Array.from({ length: 1100 }, (_, index) => side === 'src'
      ? [`pkg/src/barrel/m${index}.ts`, `export function m${index}() { return ${index}; }\n`]
      : [`pkg/out/barrel/m${index}.d.ts`, `export declare function m${index}(): number;\n`]));
    const scanned = writeFiles(root, { ...modules('src'), 'pkg/src/same.ts': `${stars(1100)}\n`, 'pkg/src/narrow.ts': `${stars(1000)}\n` });
    // 선언 쪽 narrow는 소스에 없는 m1000~m1099를 다시 내보낸다. 그 위치는 예산(1,024개 파일) 밖이라 이름은 읽지 않았다.
    writeFiles(root, { ...modules('out'), 'pkg/out/same.d.ts': `${stars(1100)}\n`, 'pkg/out/narrow.d.ts': `${stars(1100)}\n` });
    const config = { path: join(root, 'pkg/tsconfig.json'), options: { declaration: true, outDir: join(root, 'pkg/out'), rootDir: join(root, 'pkg/src') },
      fileNames: scanned };
    const mapper = new DeclarationOutputMapper(root, [config], scanned);
    assert.deepEqual(mapper.match(join(root, 'pkg/out/same.d.ts')), { kind: 'source', fileName: join(root, 'pkg/src/same.ts') });
    assert.deepEqual(mapper.match(join(root, 'pkg/out/narrow.d.ts')), { kind: 'unmapped', exportMismatch: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
