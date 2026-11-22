/**
 * 여러 소유 설정의 공백을 한 문맥 상태로 합칠 때 limitation 문장이 실제로 그 공백을 낸 설정을 말하는지 검증한다.
 * 합친 상태는 대표 설정(루트 설정, 없으면 기본값)의 이름을 그대로 써서, 루트 설정이 없으면 `undefined could not be parsed`·
 * `… of undefined point outside …`를, 루트 `tsconfig.json`을 잘 읽었어도 `tsconfig.json could not be parsed; default compiler options
 * were used`를 냈다. 설정 파일 이름만으로는 같은 이름(`tsconfig.json`)의 루트·중첩 설정을 구별하지 못하므로 다른 설정은 프로젝트 기준
 * 경로로 말하고, 읽지 못한 설정 목록은 문맥마다 다른 수가 아니라 프로젝트 전체의 한 줄로 낸다. 읽지 못한 다른 설정의 소스는 import를
 * 미해결로 남기거나(`config-conflict:`) 기본 옵션을 쓴다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { buildCallGraph } from './build-graph.ts';

const fileSystem = createNodeFileSystem();
const environment = Object.freeze({ fileSystem, toolVersion: '0.0.0-test', now: () => new Date(0) });

/** 대표 설정 자신을 읽지 못했을 때의 기존 문장이다. */
const representativeUnparsed = (name: string) => `${name} could not be parsed; default compiler options were used, so path aliases may not resolve`;

/** 대표 설정이 아닌 소유 설정을 읽지 못했을 때 프로젝트 전체에 한 번 내는 문장이다. */
const unreadableConfigs = (paths: readonly string[]) => `config-unreadable: ${paths.length} compiler config(s) in the project could not be `
  + `parsed, so path aliases and imports in the sources they own may not resolve; files: ${JSON.stringify(paths)}; omitted: 0`;

/** 문맥 표시(`; compiler-context: i/n`)를 뗀 limitation이다. */
const withoutContext = (lines: readonly string[]) => lines.map((line) => line.replace(/; compiler-context: \d+\/\d+$/u, ''));

/**
 * 임시 프로젝트를 쓰고 검사를 돌린 뒤 지운다.
 *
 * @param files 상대 경로 → 내용
 * @param check 프로젝트 realpath를 받는 검사
 */
async function withProject(files: Readonly<Record<string, string>>, check: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-config-names-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    await check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 설치되지 않은 패키지를 extends해 읽지 못하는 설정이다. */
const unreadableConfig = '{ "extends": "@missing/base/tsconfig.json", "compilerOptions": { "strict": true } }';

/** 읽지 못하는 중첩 설정과, 설정 없는 형제 디렉터리의 Express 앱이다. */
const unreadableNestedWithoutRoot = {
  'package.json': '{ "name": "app", "private": true, "dependencies": { "express": "4" } }',
  'a/tsconfig.json': unreadableConfig,
  'a/x.ts': 'export function f() { return 1; }\n',
  'b/app.ts': "import express from 'express';\nconst app = express();\napp.get('/x', (req, res) => res.send('ok'));\nexport default app;\n",
};

test('루트 설정이 없고 중첩 설정을 읽지 못하면 graph·routes 문장이 undefined 대신 읽지 못한 설정의 경로를 말한다', async () => {
  await withProject(unreadableNestedWithoutRoot, async (root) => {
    const graph = await buildCallGraph(root, fileSystem);
    assert.ok(!graph.limitations.some((line) => line.includes('undefined')), graph.limitations.join('\n'));
    // a/tsconfig.json이 대표인 문맥은 예전 문장을 내고, 읽지 못한 설정 목록은 문맥 표시 없이 한 번만 낸다.
    assert.ok(withoutContext(graph.limitations).includes(`graph-config: ${representativeUnparsed('tsconfig.json')}`), graph.limitations.join('\n'));
    assert.deepEqual(graph.limitations.filter((line) => line.startsWith('graph-config: config-unreadable:')),
      [`graph-config: ${unreadableConfigs(['a/tsconfig.json'])}`]);
    for (const role of ['server', 'client'] as const) {
      const result = await runRoutesCommand(['--role', role, '--project', root], environment);
      const limitations = (JSON.parse(result.standardOutput) as { limitations: string[] }).limitations;
      assert.ok(!limitations.some((line) => line.includes('undefined')), `${role}: ${limitations.join('\n')}`);
      const prefix = role === 'server' ? 'route-coverage' : 'route-call-coverage';
      assert.deepEqual(limitations.filter((line) => line.includes('config-unreadable:')), [`${prefix}: ${unreadableConfigs(['a/tsconfig.json'])}`],
        `${role}: ${limitations.join('\n')}`);
    }
  });
});

test('루트 tsconfig.json을 읽었으면 중첩 jsconfig.json을 읽지 못해도 tsconfig.json을 읽지 못했다고 하지 않는다', async () => {
  await withProject({
    'package.json': '{ "name": "app", "private": true }',
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "allowJs": true }, "include": ["src"] }',
    'src/y.ts': 'export function h() { return 1; }\n',
    'a/jsconfig.json': '{ "extends": "@missing/base/jsconfig.json" }',
    'a/x.js': 'export function f() { return 1; }\n',
  }, async (root) => {
    const graph = await buildCallGraph(root, fileSystem);
    const lines = withoutContext(graph.limitations);
    assert.ok(!lines.includes(`graph-config: ${representativeUnparsed('tsconfig.json')}`), lines.join('\n'));
    assert.ok(lines.includes(`graph-config: ${representativeUnparsed('jsconfig.json')}`), lines.join('\n'));
    assert.deepEqual(graph.limitations.filter((line) => line.includes('config-unreadable:')), [`graph-config: ${unreadableConfigs(['a/jsconfig.json'])}`]);
  });
});

test('같은 이름의 설정을 여럿 읽지 못하면 문맥마다 다른 수가 아니라 경로 목록 한 줄로 알린다', async () => {
  // 루트 tsconfig.json은 읽었고 a·b의 tsconfig.json은 읽지 못한다. 예전에는 문맥마다 `1 other`·`1 other`·`2 other … (tsconfig.json)`이었다.
  await withProject({
    'package.json': '{ "name": "app", "private": true }',
    'tsconfig.json': '{ "compilerOptions": { "strict": true }, "include": ["src"] }',
    'src/y.ts': 'export function h() { return 1; }\n',
    'a/tsconfig.json': unreadableConfig,
    'a/x.ts': 'export function f() { return 1; }\n',
    'b/tsconfig.json': unreadableConfig,
    'b/x.ts': 'export function g() { return 1; }\n',
  }, async (root) => {
    const graph = await buildCallGraph(root, fileSystem);
    assert.deepEqual(graph.limitations.filter((line) => line.includes('config-unreadable:')),
      [`graph-config: ${unreadableConfigs(['a/tsconfig.json', 'b/tsconfig.json'])}`]);
    assert.ok(!graph.limitations.some((line) => line.includes('other compiler config')), graph.limitations.join('\n'));
  });
});

test('대표 설정과 중첩 설정을 모두 읽지 못하면 대표 문장과 프로젝트 목록을 함께 낸다', async () => {
  await withProject({
    'package.json': '{ "name": "app", "private": true }',
    'tsconfig.json': '{ "compilerOptions": ',
    'src/y.ts': 'export function h() { return 1; }\n',
    'a/tsconfig.json': unreadableConfig,
    'a/x.ts': 'export function f() { return 1; }\n',
  }, async (root) => {
    const graph = await buildCallGraph(root, fileSystem);
    assert.ok(withoutContext(graph.limitations).includes(`graph-config: ${representativeUnparsed('tsconfig.json')}`), graph.limitations.join('\n'));
    assert.deepEqual(graph.limitations.filter((line) => line.includes('config-unreadable:')),
      [`graph-config: ${unreadableConfigs(['a/tsconfig.json', 'tsconfig.json'])}`]);
  });
});

test('루트 설정이 없을 때 중첩 설정의 밖 include는 undefined가 아니라 그 설정의 경로로 알린다', async () => {
  await withProject({
    'proj/package.json': '{ "name": "app", "private": true }',
    'proj/a/jsconfig.json': '{ "compilerOptions": { "checkJs": true }, "include": ["*.js", "../../outside/*.js"] }',
    'proj/a/x.js': 'export function f() { return 1; }\n',
    'proj/b/y.ts': 'export function h() { return 1; }\n',
    'outside/o.js': 'export function o() { return 1; }\n',
  }, async (root) => {
    const lines = withoutContext((await buildCallGraph(join(root, 'proj'), fileSystem)).limitations);
    assert.ok(!lines.some((line) => line.includes('undefined')), lines.join('\n'));
    const outside = lines.filter((line) => line.includes('point outside the scanned root'));
    assert.ok(outside.length > 0, lines.join('\n'));
    assert.ok(outside.every((line) => line.startsWith('graph-config: 1 include pattern(s) or files entr(ies) of a/jsconfig.json point outside')),
      outside.join('\n'));
  });
});

test('루트와 같은 이름의 중첩 tsconfig.json이 밖을 가리켜도 어느 문맥에서든 루트 설정이 아니라 중첩 설정의 경로를 말한다', async () => {
  await withProject({
    'proj/package.json': '{ "name": "app", "private": true }',
    'proj/tsconfig.json': '{ "compilerOptions": { "strict": true }, "include": ["src"] }',
    'proj/src/y.ts': 'export function h() { return 1; }\n',
    'proj/packages/a/tsconfig.json': '{ "compilerOptions": { "strict": true, "noImplicitAny": false }, "include": ["*.ts", "../../../outside/*.ts"] }',
    'proj/packages/a/x.ts': 'export function f() { return 1; }\n',
    'outside/o.ts': 'export function o() { return 1; }\n',
  }, async (root) => {
    const lines = withoutContext((await buildCallGraph(join(root, 'proj'), fileSystem)).limitations);
    const outside = lines.filter((line) => line.includes('point outside the scanned root'));
    assert.ok(outside.length > 0, lines.join('\n'));
    assert.ok(outside.every((line) => line.startsWith('graph-config: 1 include pattern(s) or files entr(ies) of packages/a/tsconfig.json point')),
      outside.join('\n'));
  });
});

test('루트 tsconfig.json을 읽었으면 중첩 jsconfig.json이 건너뛰는 디렉터리를 적은 files 항목을 그 설정의 경로로 말한다', async () => {
  await withProject({
    'package.json': '{ "name": "app", "private": true }',
    'tsconfig.json': '{ "compilerOptions": { "strict": true }, "include": ["src"] }',
    'src/y.ts': 'export function h() { return 1; }\n',
    'a/jsconfig.json': '{ "compilerOptions": { "checkJs": true }, "files": ["x.js", "node_modules/x/index.js"] }',
    'a/x.js': 'export function f() { return 1; }\n',
    'a/node_modules/x/index.js': 'export const v = 1;\n',
  }, async (root) => {
    const lines = withoutContext((await buildCallGraph(root, fileSystem)).limitations);
    const skipped = lines.filter((line) => line.includes('name paths in directories the scan skips'));
    assert.ok(skipped.length > 0, lines.join('\n'));
    assert.ok(skipped.every((line) => line.startsWith('graph-config: 1 files entr(ies) or wildcard-free include path(s) of a/jsconfig.json name paths')),
      skipped.join('\n'));
  });
});

test('루트 설정 자신의 공백은 예전처럼 파일 이름으로 알린다', async () => {
  await withProject({
    'proj/package.json': '{ "name": "app", "private": true }',
    'proj/tsconfig.json': '{ "compilerOptions": { "strict": true }, "include": ["src", "../outside/*.ts"] }',
    'proj/src/y.ts': 'export function h() { return 1; }\n',
    'outside/o.ts': 'export function o() { return 1; }\n',
  }, async (root) => {
    const lines = (await buildCallGraph(join(root, 'proj'), fileSystem)).limitations;
    assert.ok(lines.some((line) => line.startsWith('graph-config: 1 include pattern(s) or files entr(ies) of tsconfig.json point outside')),
      lines.join('\n'));
  });
});
