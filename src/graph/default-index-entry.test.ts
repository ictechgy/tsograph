/**
 * 공개 진입점 필드 없이 게시할 수 있는 패키지의 기본 index 진입점 판정과, 그 판정이 bound 디스패치를 여는지 검증한다.
 * `{"name":"lib"}`와 그 옆 `index.js`는 Node가 `{"name":"lib","main":"index.js"}`와 똑같이 불러오므로(express 4,
 * `@nestjs/core`·`@nestjs/common` 10의 게시 모양) 스캔 밖 소비자가 넘기는 값을 보지 못한 bound 간선을 내면 안 된다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { DEFAULT_INDEX_ENTRY_NAMES, hasDefaultIndexEntry, isPublishableManifest } from './default-index-entry.ts';
import type { CallGraph } from './graph-model.ts';

const fileSystem = createNodeFileSystem();

/** 루트 기본 index 진입점으로 열린 프로그램의 limitation 앞부분이다. */
const rootDefaultIndexLimitation = 'bound-dispatch: package.json is not private and its default index file is the package entry, so ';

/** 중첩 기본 index 진입점으로 일부 파일을 연 프로그램의 limitation 앞부분이다. */
const nestedDefaultIndexLimitation = 'bound-dispatch: nested package.json file(s) are not private and declare no entry fields, so their default index file is the package entry: ';

/** 콜백을 받는 내보낸 함수와, 프로젝트 안에서 그 함수를 한 번만 부르는 자기 검사다. 닫힌 프로그램이면 `run → helper`가 bound다. */
const callbackModule = [
  'export function run(callback) { return callback(); }',
  "function helper() { return 'helper'; }",
  'export function selfTest() { return run(helper); }',
].join('\n');

/**
 * 임시 디렉터리를 만들어 콜백에 넘기고 끝나면 지운다.
 *
 * @param use 디렉터리 realpath를 받는 콜백
 * @returns 콜백 결과
 */
async function withDirectory<T>(use: (root: string) => T | Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-default-index-')));
  try {
    return await use(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 임시 프로젝트를 쓰고 그래프를 만든다.
 *
 * @param files 상대 경로 → 내용
 * @returns 그래프
 */
async function graphOf(files: Record<string, string>): Promise<CallGraph> {
  return withDirectory(async (root) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return buildCallGraph(root, fileSystem);
  });
}

/**
 * 근거가 bound인 간선을 `from -> to`로 줄인다.
 *
 * @param graph 그래프
 * @returns 간선 문자열
 */
function boundEdges(graph: CallGraph): string[] {
  return graph.edges.filter((edge) => edge.evidence === 'bound').map((edge) => `${edge.from} -> ${edge.to}`);
}

test('isPublishableManifest: a string name without "private": true can be installed by name', () => {
  assert.equal(isPublishableManifest({ name: 'lib' }), true);
  assert.equal(isPublishableManifest({ name: 'lib', private: false }), true);
  // 공개 진입점 필드 규칙처럼 boolean true만 private로 본다. 다른 값은 판단하지 않고 열린 쪽(게시 가능)에 둔다.
  assert.equal(isPublishableManifest({ name: 'lib', private: 'true' }), true);
  assert.equal(isPublishableManifest({ name: 'lib', private: true }), false);
  assert.equal(isPublishableManifest({ version: '1.0.0' }), false);
  assert.equal(isPublishableManifest({ name: 42 }), false);
});

test('hasDefaultIndexEntry: every Node/TypeScript default index name counts, directories and private packages do not', async () => {
  assert.deepEqual(DEFAULT_INDEX_ENTRY_NAMES, ['index.js', 'index.jsx', 'index.ts', 'index.tsx']);
  await withDirectory((root) => {
    assert.equal(hasDefaultIndexEntry(root, { name: 'lib' }), false, 'no index file');
    mkdirSync(join(root, 'index.js'));
    assert.equal(hasDefaultIndexEntry(root, { name: 'lib' }), false, 'a directory named index.js is not the entry file');
    for (const name of DEFAULT_INDEX_ENTRY_NAMES.filter((entry) => entry !== 'index.js')) {
      writeFileSync(join(root, name), 'export {};');
      assert.equal(hasDefaultIndexEntry(root, { name: 'lib' }), true, name);
      assert.equal(hasDefaultIndexEntry(root, { name: 'lib', private: true }), false, `${name} in a private package`);
      assert.equal(hasDefaultIndexEntry(root, {}), false, `${name} in a nameless package`);
      rmSync(join(root, name));
    }
    // Node는 링크를 따라 불러오므로 링크도 진입점으로 본다(대상이 끊겨도 판단할 수 없으니 열린 쪽).
    symlinkSync('missing-target.js', join(root, 'index.jsx'));
    assert.equal(hasDefaultIndexEntry(root, { name: 'lib' }), true, 'symlinked index');
  });
});

test('hasDefaultIndexEntry: an unreadable status is not taken as a missing entry', async () => {
  await withDirectory((root) => {
    // 디렉터리 자리에 일반 파일이 있으면 lstat이 ENOTDIR로 실패한다 — 없다고 단정하지 않는다.
    writeFileSync(join(root, 'file'), '');
    assert.equal(hasDefaultIndexEntry(join(root, 'file'), { name: 'lib' }), true);
  });
});

test('root package: a publishable manifest without entry fields opens exports through its default index.js', async () => {
  const implicit = await graphOf({
    'package.json': '{ "name": "lib", "version": "1.0.0", "type": "module" }',
    'index.js': callbackModule,
  });
  assert.deepEqual(boundEdges(implicit), [], 'external consumers can pass any callback to the exported run()');
  assert.deepEqual(implicit.nodes.find((node) => node.id === 'index.js#run')?.unresolvedCalls, { direct: 1, bound: 1, candidates: 1 });
  assert.ok(implicit.limitations.some((line) => line.startsWith(rootDefaultIndexLimitation)), implicit.limitations.join('\n'));
  assert.ok(implicit.limitations.some((line) => line.startsWith('unresolved-calls: 1 call(s)') && line.includes('parameter: 1')));

  // `"main": "index.js"`를 적은 같은 패키지와 간선이 같다(Node가 같은 파일을 불러온다).
  const explicit = await graphOf({
    'package.json': '{ "name": "lib", "version": "1.0.0", "type": "module", "main": "index.js" }',
    'index.js': callbackModule,
  });
  assert.deepEqual(explicit.edges, implicit.edges);
  assert.ok(explicit.limitations.some((line) => line.startsWith('bound-dispatch: package.json declares public entry points')));
});

test('root package: a TypeScript default index.ts opens the program like an explicit entry', async () => {
  const graph = await graphOf({
    'package.json': '{ "name": "lib", "version": "1.0.0" }',
    'tsconfig.json': '{ "compilerOptions": { "strict": false, "allowJs": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
    'index.ts': callbackModule.replace('run(callback)', 'run(callback: () => string)'),
  });
  assert.deepEqual(boundEdges(graph), []);
  assert.ok(graph.limitations.some((line) => line.startsWith(rootDefaultIndexLimitation)), graph.limitations.join('\n'));
});

test('root package: private, nameless, or index-less manifests stay closed', async () => {
  const closed = ['index.js#run -> index.js#helper'];
  for (const manifest of ['{ "name": "app", "private": true, "type": "module" }', '{ "version": "1.0.0", "type": "module" }']) {
    const graph = await graphOf({ 'package.json': manifest, 'index.js': callbackModule });
    assert.deepEqual(boundEdges(graph), closed, manifest);
    assert.ok(!graph.limitations.some((line) => line.startsWith(rootDefaultIndexLimitation)), manifest);
  }
  const withoutIndex = await graphOf({ 'package.json': '{ "name": "lib", "type": "module" }', 'src/main.js': callbackModule });
  assert.deepEqual(boundEdges(withoutIndex), ['src/main.js#run -> src/main.js#helper']);
});

test('nested package: a publishable workspace package with a default index opens its own exports', async () => {
  const tsconfig = '{ "compilerOptions": { "strict": false, "types": [], "lib": ["es2022"], "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }';
  const files = {
    'tsconfig.json': tsconfig,
    'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
    'packages/lib/index.ts': "export * from './src/main';",
    'packages/lib/src/main.ts': callbackModule,
  };
  const published = await graphOf({ ...files, 'packages/lib/package.json': '{ "name": "@acme/lib", "version": "1.0.0" }' });
  assert.deepEqual(boundEdges(published), []);
  assert.ok(published.limitations.some((line) => line.startsWith(`${nestedDefaultIndexLimitation}["packages/lib/package.json"]`)),
    published.limitations.join('\n'));
  assert.ok(!published.limitations.some((line) => line.startsWith('bound-dispatch: nested package.json file(s) declare public entry points')));

  const internal = await graphOf({ ...files, 'packages/lib/package.json': '{ "name": "@acme/lib", "private": true }' });
  assert.deepEqual(boundEdges(internal), ['packages/lib/src/main.ts#run -> packages/lib/src/main.ts#helper']);
  assert.ok(!internal.limitations.some((line) => line.startsWith(nestedDefaultIndexLimitation)));
});
