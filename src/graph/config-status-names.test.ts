/**
 * 여러 소유 설정의 공백을 한 문맥 상태로 합칠 때 limitation 문장이 실제로 그 공백을 낸 설정을 말하는지 검증한다.
 * 합친 상태는 대표 설정(루트 설정, 없으면 기본값)의 이름을 그대로 써서, 루트 설정이 없으면 `undefined could not be parsed`·
 * `… of undefined point outside …`를, 루트 `tsconfig.json`을 잘 읽었어도 `tsconfig.json could not be parsed; default compiler options
 * were used`를 냈다. 설정 파일 이름만으로는 같은 이름(`tsconfig.json`)의 루트·중첩 설정을 구별하지 못하므로 다른 설정은 스캔 루트 기준
 * 경로로 말한다. 읽지 못한 설정은 문맥의 대표 설정이 아니라 소유권 계획의 주 설정을 기준으로 나눠, 주 설정만 예전 문장으로 말하고 나머지는
 * 모든 문맥·접두사에서 같은 `config-unreadable:` 한 줄로 낸다. 읽지 못한 다른 설정의 소스는 import를 미해결로 남기거나(`config-conflict:`)
 * 기본 옵션을 쓴다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { buildCallGraph } from './build-graph.ts';

const fileSystem = createNodeFileSystem();
const environment = Object.freeze({ fileSystem, toolVersion: '0.0.0-test', now: () => new Date(0) });

/** 소유권 계획의 주 설정(루트 설정·`--tsconfig`로 고른 설정)을 읽지 못했을 때의 기존 문장이다. */
const representativeUnparsed = (name: string) => `${name} could not be parsed; default compiler options were used, so path aliases may not resolve`;

/**
 * 주 설정이 아닌 소유 설정을 읽지 못했을 때 모든 문맥에서 같은 문장으로 한 번 내는 문장이다. 그 계획이 무엇을 분석하려고 읽은 설정인지
 * (`affected`)를 말한다(graph `calls`, routes server `route registrations`, client `requests`, Next 진입 범위 `Next convention discovery`).
 */
const unreadableConfigs = (paths: readonly string[], affected = 'calls') => `config-unreadable: ${paths.length} compiler config(s) read for `
  + `${affected} could not be parsed, so path aliases and imports in the sources they own may not resolve; files: ${JSON.stringify(paths)}; omitted: 0`;

/** 기본 옵션을 썼다고 말하는 설정 문장이다. 주 설정을 읽었으면 하나도 없어야 한다. */
const defaultOptionsLines = (lines: readonly string[]) => lines.filter((line) => line.includes('could not be parsed; default compiler options'));

/** Express 라우트와 전역 fetch 호출이 함께 있는 소스다(graph·routes server·client가 모두 분석한다). */
const appSource = (name: string) => `import express from 'express';\nconst app = express();\nexport function ${name}() { return fetch('/api/${name}'); }\n`
  + `app.get('/r${name}', ${name});\n`;

/** 끝이 잘려 읽지 못하는 설정이다. */
const truncatedConfig = '{ "compilerOptions": { "strict": true, }, "include": [ ';

/**
 * graph·routes server·client의 limitation을 모은다.
 *
 * @param root 프로젝트 realpath
 * @returns 문서별 limitation
 */
async function allLimitations(root: string): Promise<Record<'graph' | 'server' | 'client', readonly string[]>> {
  const routes = async (role: 'server' | 'client') =>
    (JSON.parse((await runRoutesCommand(['--role', role, '--project', root], environment)).standardOutput) as { limitations: string[] }).limitations;
  return { graph: (await buildCallGraph(root, fileSystem)).limitations, server: await routes('server'), client: await routes('client') };
}

/** 문서별 접두사다. */
const prefixes = { graph: 'graph-config', server: 'route-coverage', client: 'route-call-coverage' } as const;

/** 문서별로 설정 목록이 말하는 분석 결과다. */
const affectedBy = { graph: 'calls', server: 'route registrations', client: 'requests' } as const;

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
    // 주 설정은 설정 없음(기본값)이라 기본 옵션 문장이 없다. a/tsconfig.json이 대표인 문맥도 이름만으로 루트 설정처럼 읽히는 문장을 내지 않고,
    // 읽지 못한 설정 목록은 문맥 표시 없이 한 번만 낸다.
    assert.deepEqual(defaultOptionsLines(graph.limitations), []);
    assert.deepEqual(graph.limitations.filter((line) => line.startsWith('graph-config: config-unreadable:')),
      [`graph-config: ${unreadableConfigs(['a/tsconfig.json'])}`]);
    for (const role of ['server', 'client'] as const) {
      const result = await runRoutesCommand(['--role', role, '--project', root], environment);
      const limitations = (JSON.parse(result.standardOutput) as { limitations: string[] }).limitations;
      assert.ok(!limitations.some((line) => line.includes('undefined')), `${role}: ${limitations.join('\n')}`);
      assert.deepEqual(defaultOptionsLines(limitations), [], role);
      const prefix = role === 'server' ? 'route-coverage' : 'route-call-coverage';
      assert.deepEqual(limitations.filter((line) => line.includes('config-unreadable:')), [`${prefix}: ${unreadableConfigs(['a/tsconfig.json'], affectedBy[role])}`],
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
    assert.deepEqual(defaultOptionsLines(graph.limitations), [], graph.limitations.join('\n'));
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

test('주 설정과 중첩 설정을 모두 읽지 못하면 주 설정 문장 하나와, 주 설정을 뺀 목록 한 줄을 낸다', async () => {
  await withProject({
    'package.json': '{ "name": "app", "private": true }',
    'tsconfig.json': '{ "compilerOptions": ',
    'src/y.ts': 'export function h() { return 1; }\n',
    'a/tsconfig.json': unreadableConfig,
    'a/x.ts': 'export function f() { return 1; }\n',
  }, async (root) => {
    const graph = await buildCallGraph(root, fileSystem);
    // 두 문장 모두 계획 기준이라 문맥이 나뉘어도 문맥 표시 없이 한 번씩만 나온다.
    assert.deepEqual(defaultOptionsLines(graph.limitations), [`graph-config: ${representativeUnparsed('tsconfig.json')}`]);
    assert.deepEqual(graph.limitations.filter((line) => line.includes('config-unreadable:')),
      [`graph-config: ${unreadableConfigs(['a/tsconfig.json'])}`]);
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

for (const [label, withRoot] of [['루트 tsconfig.json을 읽었고', true], ['루트 설정이 없고', false]] as const) {
  test(`${label} 유일한 소스의 중첩 설정을 읽지 못하면 그 설정을 경로로 말하고 루트 설정을 읽지 못했다고 하지 않는다`, async () => {
    await withProject({
      'package.json': '{ "name": "fx", "private": true, "dependencies": { "express": "4.21.0" } }',
      ...(withRoot ? { 'tsconfig.json': '{ "compilerOptions": { "strict": true } }' } : {}),
      'sub/tsconfig.json': truncatedConfig,
      'sub/b.ts': appSource('h'),
    }, async (root) => {
      for (const [document, lines] of Object.entries(await allLimitations(root)) as [keyof typeof prefixes, readonly string[]][]) {
        assert.deepEqual(defaultOptionsLines(lines), [], `${document}: ${lines.join('\n')}`);
        assert.deepEqual(lines.filter((line) => line.includes('config-unreadable:')),
          [`${prefixes[document]}: ${unreadableConfigs(['sub/tsconfig.json'], affectedBy[document])}`],
          `${document}: ${lines.join('\n')}`);
      }
    });
  });
}

test('루트와 중첩 디렉터리에 소스가 있고 중첩 설정만 읽지 못하면 graph·routes 모두 목록 한 줄만 낸다', async () => {
  await withProject({
    'package.json': '{ "name": "fx", "private": true, "dependencies": { "express": "4.21.0" } }',
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" } }',
    'src/a.ts': appSource('a'),
    'sub/tsconfig.json': truncatedConfig,
    'sub/b.ts': appSource('b'),
  }, async (root) => {
    for (const [document, lines] of Object.entries(await allLimitations(root)) as [keyof typeof prefixes, readonly string[]][]) {
      assert.deepEqual(lines.filter((line) => /could not be parsed|config-unreadable:/u.test(line)),
        [`${prefixes[document]}: ${unreadableConfigs(['sub/tsconfig.json'], affectedBy[document])}`], `${document}: ${lines.join('\n')}`);
    }
  });
});

test('Next 진입 범위의 route-coverage: config-unreadable:도 graph에서 문맥마다 반복하지 않는다', async () => {
  await withProject({
    'package.json': '{ "name": "fx", "private": true, "dependencies": { "next": "15.0.0", "express": "4.21.0" } }',
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" } }',
    'app/api/x/route.ts': 'export async function GET() { return new Response("ok"); }\n',
    'app/api/y/route.ts': 'export async function POST() { return new Response("ok"); }\n',
    'app/api/y/tsconfig.json': truncatedConfig,
    'sub/tsconfig.json': truncatedConfig,
    'sub/b.ts': "import express from 'express';\nconst app = express();\napp.get('/b', () => {});\n",
  }, async (root) => {
    const graph = await buildCallGraph(root, fileSystem);
    const listed = ['app/api/y/tsconfig.json', 'sub/tsconfig.json'];
    assert.deepEqual(graph.limitations.filter((line) => line.includes('config-unreadable:')),
      [`graph-config: ${unreadableConfigs(listed)}`, `route-coverage: ${unreadableConfigs(listed, 'Next convention discovery')}`], graph.limitations.join('\n'));
  });
});

test('같은 설정 디렉터리를 symlink로 한 번 더 참조해 둘 다 실패하면 실제 파일 하나로 세고 실패한 경로 중 경로 순 첫 경로를 쓴다', async () => {
  await withProject({
    'package.json': '{ "name": "fx", "private": true }',
    'tsconfig.json': '{ "compilerOptions": { "strict": true }, "references": [ { "path": "./real" }, { "path": "./link" } ] }',
    'src/a.ts': 'export function a() { return 1; }\n',
    'real/tsconfig.json': truncatedConfig,
    'real/r.ts': 'export function r() { return 1; }\n',
  }, async (root) => {
    symlinkSync(join(root, 'real'), join(root, 'link'), 'dir');
    const graph = await buildCallGraph(root, fileSystem);
    assert.deepEqual(graph.limitations.filter((line) => line.includes('config-unreadable:')), [`graph-config: ${unreadableConfigs(['link/tsconfig.json'])}`]);
  });
});

test('주 설정만 읽지 못하면 주 설정 문장만 내고 목록에 주 설정을 다시 적지 않는다', async () => {
  await withProject({
    'package.json': '{ "name": "fx", "private": true }',
    'tsconfig.json': truncatedConfig,
    'src/a.ts': 'export function a() { return 1; }\n',
    'sub/tsconfig.json': '{ "compilerOptions": { "strict": false, "target": "es2015", "module": "commonjs", "baseUrl": ".", "paths": { "@x/*": ["./*"] } } }',
    'sub/b.ts': 'export function b() { return 1; }\n',
  }, async (root) => {
    const graph = await buildCallGraph(root, fileSystem);
    assert.deepEqual(graph.limitations.filter((line) => /could not be parsed|config-unreadable:/u.test(line)),
      [`graph-config: ${representativeUnparsed('tsconfig.json')}`], graph.limitations.join('\n'));
  });
});

test('--workspace로 넓힌 경계에서는 목록이 프로젝트 밖 workspace 설정도 스캔 루트 기준 경로로 말한다', async () => {
  await withProject({
    'package.json': '{ "name": "ws", "private": true }',
    'app/package.json': '{ "name": "app", "private": true }',
    'app/tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" } }',
    'app/src/a.ts': 'export function a() { return 1; }\n',
    'lib/tsconfig.json': truncatedConfig,
    'lib/l.ts': 'export function l() { return 1; }\n',
  }, async (root) => {
    const graph = await buildCallGraph(join(root, 'app'), fileSystem, { workspace: root });
    assert.deepEqual(graph.limitations.filter((line) => /could not be parsed|config-unreadable:/u.test(line)),
      [`graph-config: ${unreadableConfigs(['lib/tsconfig.json'])}`], graph.limitations.join('\n'));
  });
});

test('주 설정 경로에 공백이 있어도 주 설정 문장은 문맥마다 반복하지 않는다', async () => {
  await withProject({
    'package.json': '{ "name": "ws", "private": true }',
    'my app/package.json': '{ "name": "app", "private": true }',
    'my app/tsconfig.json': truncatedConfig,
    'my app/src/a.ts': 'export function a() { return 1; }\n',
    'lib/tsconfig.json': '{ "compilerOptions": { "strict": false, "target": "es2015", "module": "commonjs", "baseUrl": ".", "paths": { "@q/*": ["./*"] } } }',
    'lib/l.ts': 'export function l() { return 1; }\n',
  }, async (root) => {
    const graph = await buildCallGraph(join(root, 'my app'), fileSystem, { workspace: root });
    assert.deepEqual(graph.limitations.filter((line) => /could not be parsed|config-unreadable:/u.test(line)),
      [`graph-config: ${representativeUnparsed('my app/tsconfig.json')}`], graph.limitations.join('\n'));
  });
});

test('Next 진입 범위와 Node routes가 읽은 설정이 다르면 한 문서의 두 목록이 서로 다른 분석 범위를 말한다', async () => {
  // 루트 설정의 include가 app뿐이라 Next 진입 범위 계획은 sub/tsconfig.json을 읽지 않는다. 같은 "under the scanned root" 문장으로 수가 1과 2로
  // 갈리면 서로 모순된다.
  await withProject({
    'package.json': '{ "name": "fx", "private": true, "dependencies": { "next": "15.0.0", "express": "4.21.0" } }',
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "module": "esnext", "moduleResolution": "bundler" }, "include": ["app"] }',
    'app/api/x/route.ts': 'export async function GET() { return new Response("ok"); }\n',
    'app/api/y/route.ts': 'export async function POST() { return new Response("ok"); }\n',
    'app/api/y/tsconfig.json': truncatedConfig,
    'sub/tsconfig.json': truncatedConfig,
    'sub/b.ts': appSource('hB'),
  }, async (root) => {
    const { graph, server } = await allLimitations(root);
    const unreadable = (lines: readonly string[]) => lines.filter((line) => line.includes('config-unreadable:'));
    assert.deepEqual(unreadable(server), [
      `route-coverage: ${unreadableConfigs(['app/api/y/tsconfig.json'], 'Next convention discovery')}`,
      `route-coverage: ${unreadableConfigs(['app/api/y/tsconfig.json', 'sub/tsconfig.json'], 'route registrations')}`,
    ], server.join('\n'));
    assert.deepEqual(unreadable(graph), [
      `graph-config: ${unreadableConfigs(['app/api/y/tsconfig.json', 'sub/tsconfig.json'])}`,
      `route-coverage: ${unreadableConfigs(['app/api/y/tsconfig.json'], 'Next convention discovery')}`,
    ], graph.join('\n'));
  });
});

test('symlink 경로로만 extends가 깨진 설정은 잘 읽힌 실제 경로가 아니라 실패한 경로로 말한다', async () => {
  // sub/tsconfig.json의 "../base.json"은 sub/로 읽으면 있지만 deep/link/(→ ../sub)로 읽으면 deep/base.json이라 없다.
  await withProject({
    'package.json': '{ "name": "fx", "private": true }',
    'tsconfig.json': '{ "compilerOptions": { "strict": true }, "references": [ { "path": "./sub" }, { "path": "./deep/link" } ] }',
    'base.json': '{ "compilerOptions": { "strict": true } }',
    'src/a.ts': 'export function a() { return 1; }\n',
    'sub/tsconfig.json': '{ "extends": "../base.json", "compilerOptions": { "noImplicitAny": true } }',
    'sub/b.ts': 'export function b() { return 1; }\n',
    'deep/.keep': '',
  }, async (root) => {
    symlinkSync('../sub', join(root, 'deep/link'), 'dir');
    const graph = await buildCallGraph(root, fileSystem);
    assert.deepEqual(graph.limitations.filter((line) => /could not be parsed|config-unreadable:/u.test(line)),
      [`graph-config: ${unreadableConfigs(['deep/link/tsconfig.json'])}`], graph.limitations.join('\n'));
  });
});

test('주 설정 파일을 symlink로 다시 읽어 실패해도 같은 파일이므로 주 설정 문장 하나만 낸다', async () => {
  await withProject({
    'package.json': '{ "name": "fx", "private": true }',
    'tsconfig.json': truncatedConfig,
    'src/a.ts': 'export function a() { return 1; }\n',
    'sub/b.ts': 'export function b() { return 1; }\n',
  }, async (root) => {
    symlinkSync('../tsconfig.json', join(root, 'sub/tsconfig.json'));
    const graph = await buildCallGraph(root, fileSystem);
    assert.deepEqual(graph.limitations.filter((line) => /could not be parsed|config-unreadable:/u.test(line)),
      [`graph-config: ${representativeUnparsed('tsconfig.json')}`], graph.limitations.join('\n'));
  });
});
