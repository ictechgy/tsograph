/**
 * 공개 진입점 필드 없이 게시할 수 있는 패키지 판정과, 그 판정이 bound 디스패치를 여는지 검증한다.
 * `exports`가 없는 게시 가능 패키지는 소비자가 모든 파일을 경로로(`lib/src/main.js`), `main`이 없으면 이름으로 기본 index 파일을
 * 가져다 쓴다(express 4, `@nestjs/core`·`@nestjs/common` 10의 게시 모양). 그래서 스캔 밖 소비자가 넘기는 값을 보지 못한 bound
 * 간선을 내면 안 된다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import type { CallGraph } from './graph-model.ts';
import { isMarkedPrivate, isPublishableManifest } from './publishable-manifest.ts';

const fileSystem = createNodeFileSystem();

/** 진입점 필드 없이 게시할 수 있는 루트 패키지로 열린 프로그램의 limitation 앞부분이다. */
const rootPublishableLimitation = 'bound-dispatch: package.json has a string name without "private": true and no exports field, '
  + 'which lets any file be imported by path, so ';

/** 진입점 필드 없이 게시할 수 있는 중첩 패키지로 일부 파일을 연 프로그램의 limitation 앞부분이다. */
const nestedPublishableLimitation = 'bound-dispatch: nested package.json file(s) have a string name without "private": true and no entry fields, '
  + 'which lets any of their files be imported by path: ';

/** 콜백을 받는 내보낸 함수와, 프로젝트 안에서 그 함수를 한 번만 부르는 자기 검사다. 닫힌 프로그램이면 `run → helper`가 bound다. */
const callbackModule = [
  'export function run(callback) { return callback(); }',
  "function helper() { return 'helper'; }",
  'export function selfTest() { return run(helper); }',
].join('\n');

/**
 * 임시 프로젝트를 쓰고 그래프를 만든 뒤 지운다.
 *
 * @param files 상대 경로 → 내용
 * @returns 그래프
 */
async function graphOf(files: Record<string, string>): Promise<CallGraph> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-publishable-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, fileSystem);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

/**
 * limitation 중 주어진 앞부분으로 시작하는 줄이 있는지 본다.
 *
 * @param graph 그래프
 * @param prefix 앞부분
 * @returns 있으면 true
 */
function hasLimitation(graph: CallGraph, prefix: string): boolean {
  return graph.limitations.some((line) => line.startsWith(prefix));
}

test('isPublishableManifest: a string name without boolean "private": true can be installed by name', () => {
  assert.equal(isPublishableManifest({ name: 'lib' }), true);
  assert.equal(isPublishableManifest({ name: 'lib', private: false }), true);
  assert.equal(isPublishableManifest({ name: 'lib', private: true }), false);
  assert.equal(isPublishableManifest({ version: '1.0.0' }), false);
  assert.equal(isPublishableManifest({ name: 42 }), false);
  // npm은 truthy `private`를 모두 거절하지만 Yarn 4는 boolean이 아닌 값을 private로 보지 않고 게시한다 — 열린 쪽에 둔다.
  for (const value of ['true', 'false', 1, {}]) {
    assert.equal(isMarkedPrivate({ name: 'lib', private: value }), false, JSON.stringify(value));
    assert.equal(isPublishableManifest({ name: 'lib', private: value }), true, JSON.stringify(value));
  }
  assert.equal(isMarkedPrivate({ private: true }), true);
});

test('root package: a publishable manifest without entry fields opens exports reached by a deep import path', async () => {
  // `exports`가 없으면 소비자가 `import { run } from 'lib/src/main.js'`로 아무 파일이나 불러 자기 콜백을 넘길 수 있다.
  const files = { 'src/main.js': callbackModule };
  const implicit = await graphOf({ ...files, 'package.json': '{ "name": "lib", "version": "1.0.0", "type": "module" }' });
  assert.deepEqual(boundEdges(implicit), [], 'external consumers can pass any callback to the exported run()');
  assert.deepEqual(implicit.nodes.find((node) => node.id === 'src/main.js#run')?.unresolvedCalls, { direct: 1, bound: 1, candidates: 1 });
  assert.ok(hasLimitation(implicit, rootPublishableLimitation), implicit.limitations.join('\n'));
  assert.ok(implicit.limitations.some((line) => line.startsWith('unresolved-calls: 1 call(s)') && line.includes('parameter: 1')));

  // 그 파일을 `main`으로 적은 같은 패키지와 간선이 같다.
  const explicit = await graphOf({ ...files, 'package.json': '{ "name": "lib", "version": "1.0.0", "type": "module", "main": "src/main.js" }' });
  assert.deepEqual(explicit.edges, implicit.edges);
  assert.ok(hasLimitation(explicit, 'bound-dispatch: package.json declares public entry points'));
});

test('root package: index files that Node or TypeScript load by package name open the program too', async () => {
  const cases: Record<string, string>[] = [
    { 'package.json': '{ "name": "lib", "version": "1.0.0", "type": "module" }', 'index.js': callbackModule },
    // `index.mjs`는 기본 index 이름이 아니지만 `lib/index.mjs`로 불러올 수 있다.
    { 'package.json': '{ "name": "lib", "version": "1.0.0" }', 'index.mjs': callbackModule },
    {
      'package.json': '{ "name": "lib", "version": "1.0.0" }',
      'tsconfig.json': '{ "compilerOptions": { "strict": false, "allowJs": true, "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }',
      'index.ts': callbackModule.replace('run(callback)', 'run(callback: () => string)'),
    },
  ];
  for (const files of cases) {
    const graph = await graphOf(files);
    const label = Object.keys(files).join(', ');
    assert.deepEqual(boundEdges(graph), [], label);
    assert.ok(hasLimitation(graph, rootPublishableLimitation), `${label}\n${graph.limitations.join('\n')}`);
  }
});

test('root package: "private": true, nameless, and format-marker manifests stay closed', async () => {
  const closed = ['src/main.js#run -> src/main.js#helper'];
  for (const manifest of [
    '{ "name": "app", "private": true, "type": "module" }',
    '{ "version": "1.0.0", "type": "module" }',
    '{ "type": "module" }',
  ]) {
    for (const files of [{ 'src/main.js': callbackModule }, { 'src/main.js': callbackModule, 'index.js': "export { run } from './src/main.js';" }]) {
      const graph = await graphOf({ ...files, 'package.json': manifest });
      const label = `${manifest} with ${Object.keys(files).join(', ')}`;
      assert.deepEqual(boundEdges(graph), closed, label);
      assert.ok(!graph.limitations.some((line) => line.startsWith('bound-dispatch: package.json')), label);
    }
  }
});

test('root package: a declared entry field opens the program even with "private": true', async () => {
  // 루트는 스캔한 프로그램의 경계라 진입점 필드가 있으면 private여도 연다(기존 규칙). private만 있으면 위 사례처럼 닫힌다.
  const graph = await graphOf({ 'package.json': '{ "name": "app", "private": true, "type": "module", "main": "src/main.js" }', 'src/main.js': callbackModule });
  assert.deepEqual(boundEdges(graph), []);
  assert.ok(hasLimitation(graph, 'bound-dispatch: package.json declares public entry points'));
});

test('root package: a non-boolean "private" stays open and the sentence does not claim the package is not private', async () => {
  // npm은 `"private": "true"`를 게시하지 않으므로 "is not private"라고 쓰면 거짓이다. Yarn 4는 게시하므로 열린 쪽은 유지한다.
  for (const source of ['index.js', 'src/main.js']) {
    const graph = await graphOf({ 'package.json': '{ "name": "lib", "private": "true", "type": "module" }', [source]: callbackModule });
    const line = graph.limitations.find((entry) => entry.startsWith('bound-dispatch: package.json'));
    assert.ok(line !== undefined && line.startsWith(rootPublishableLimitation), `${source}\n${graph.limitations.join('\n')}`);
    assert.ok(!line.includes('is not private'), line);
    assert.deepEqual(boundEdges(graph), [], source);
  }
});

test('nested package: a publishable workspace package without entry fields opens its own exports', async () => {
  const tsconfig = '{ "compilerOptions": { "strict": false, "types": [], "lib": ["es2022"], "module": "esnext", "moduleResolution": "bundler", "target": "es2022" } }';
  const files = {
    'tsconfig.json': tsconfig,
    'package.json': '{ "name": "root", "private": true, "workspaces": ["packages/*"] }',
    'packages/lib/src/main.ts': callbackModule,
  };
  const closed = ['packages/lib/src/main.ts#run -> packages/lib/src/main.ts#helper'];
  // 기본 index 파일이 있든 없든 `exports`가 없으면 `@acme/lib/src/main`으로 불러올 수 있다.
  for (const extra of [{}, { 'packages/lib/index.ts': "export * from './src/main';" }]) {
    const label = Object.keys(extra).join(', ') || 'no index file';
    const published = await graphOf({ ...files, ...extra, 'packages/lib/package.json': '{ "name": "@acme/lib", "version": "1.0.0" }' });
    assert.deepEqual(boundEdges(published), [], label);
    assert.ok(hasLimitation(published, `${nestedPublishableLimitation}["packages/lib/package.json"]`), `${label}\n${published.limitations.join('\n')}`);
    assert.ok(!hasLimitation(published, 'bound-dispatch: nested package.json file(s) declare public entry points'), label);

    // private이거나 이름 없는 workspace 패키지, 형식 표식 manifest(위의 private 루트가 정한다)는 닫힌 쪽이다.
    for (const manifest of ['{ "name": "@acme/lib", "private": true }', '{ "version": "1.0.0", "private": false }', '{ "type": "module" }']) {
      const internal = await graphOf({ ...files, ...extra, 'packages/lib/package.json': manifest });
      assert.deepEqual(boundEdges(internal), closed, `${label}: ${manifest}`);
      assert.ok(!hasLimitation(internal, 'bound-dispatch: nested package.json'), `${label}: ${manifest}`);
    }
  }
});
