/**
 * Node 백엔드 추출 파이프라인(감지·해석기·문서 조립)을 합성 임시 프로젝트로 끝까지 검사한다.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../../cli/file-system.ts';
import { runGraphCommand } from '../../cli/graph-command.ts';
import { runRoutesCommand } from '../../cli/routes-command.ts';
import { ambientTypesFreeConfig, type GuardedCliRuns, type GuardedRun, runCliGuarded, runMainGuarded } from '../../cli/testing.test.ts';
import { isSafeIdentifier } from '../../exchange/bridge-facts.ts';
import { MAX_NODE_SOURCE_BYTES } from './node-project.ts';
import { factLines, limitationsWith, type NodeDocumentView, packageJson, scanNodeProject } from './testing.test.ts';

test('Next.js와 Hono가 함께 있으면 registration-order이고 Next 선언은 순서 한계로 알린다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ next: '16.2.7', hono: '4.6.0' }),
    'next.config.js': 'module.exports = {};\n',
    'app/api/items/route.ts': 'export async function GET() { return Response.json([]); }\n',
    'server/index.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/h', (c) => c.text('h'));\nexport default app;\n",
  });
  assert.equal(document.dispatch, 'registration-order');
  assert.deepEqual(factLines(document), ['GET root /api/items strict', 'GET root /h strict #0']);
  assert.equal(limitationsWith(document, 'route-dispatch-order-unknown: 1 Next.js route declaration(s)').length, 1);
});

test('모델링하지 않는 서버 프레임워크만 있으면 Next 기본 스캔과 함께 알린다', async () => {
  const document = await scanNodeProject({ 'package.json': packageJson({ '@hapi/hapi': '21.3.0' }) });
  assert.equal(document.dispatch, 'specificity');
  assert.equal(limitationsWith(document, 'route-coverage: package.json declares @hapi/hapi').length, 1);
  assert.equal(limitationsWith(document, 'route-coverage: no app or pages directory').length, 1);
});

test('깨진 package.json은 프레임워크를 감지하지 못한 이유를 알린다', async () => {
  const document = await scanNodeProject({
    'package.json': '{ "dependencies": { "hono": "4.6.0" ',
    'src/app.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/a', (c) => c.text('a'));\nexport default app;\n",
  });
  assert.equal(document.facts.length, 0);
  assert.equal(limitationsWith(document, 'route-coverage: the root package.json exists but could not be read').length, 1);
});

test('해석기는 CommonJS 플러그인·네임스페이스·열거형·조건부 등록·재귀를 다룬다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '4.21.2' }),
    'src/paths.ts': "export enum Paths { Items = '/items' }\nexport const ROUTES = { orders: '/orders' } as const;\n",
    'src/plugin.js': "module.exports = function register(app) {\n  app.get('/plugin', (req, res) => res.send('p'));\n};\n",
    'src/app.ts': [
      "import express from 'express';",
      "import * as paths from './paths.ts';",
      'const app = express();',
      "require('./plugin')(app);",
      'app.get(paths.Paths.Items, (req, res) => res.send("i"));',
      "app['post'](paths.ROUTES.orders, (req, res) => res.send('o'));",
      'const flag = process.env.FLAG === "1";',
      "flag && app.get('/and', (req, res) => res.send('and'));",
      "flag ? app.get('/yes', (req, res) => res.send('y')) : app.get('/no', (req, res) => res.send('n'));",
      "for (const name of ['a']) app.get('/loop', (req, res) => res.send(name));",
      "switch (process.env.MODE) { case 'x': app.get('/case', (req, res) => res.send('c')); }",
      "try { app.get('/try', (req, res) => res.send('t')); } catch { app.get('/catch', (req, res) => res.send('c')); } finally { app.get('/finally', (req, res) => res.send('f')); }",
      'function loop(target: typeof app, depth: number): void {',
      "  target.get('/recursive', (req, res) => res.send('r'));",
      '  loop(target, depth + 1);',
      '}',
      'loop(app, 0);',
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document), [
    'GET root /finally optional #4 ci',
    'GET root /items optional #1 ci',
    'GET root /plugin optional #0 ci',
    'GET root /recursive optional #5 ci',
    'GET root /try optional #3 ci',
    'POST root /orders optional #2 ci',
  ]);
  const conditional = limitationsWith(document, 'route-coverage: 6 route registration(s) run only under a condition');
  assert.deepEqual(conditional.map((entry) => entry.scope), [{ methods: ['GET'], templates: ['/and', '/case', '/catch', '/loop', '/no', '/yes'] }]);
  assert.equal(limitationsWith(document, 'route-coverage: 1 function call(s) were not followed').length, 1);
});

test('--include-tests는 테스트 소스의 선언을 testSource로 낸다', async () => {
  const files = {
    'package.json': packageJson({ hono: '4.6.0' }),
    'test/app.test.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/t', (c) => c.text('t'));\nexport default app;\n",
  };
  assert.deepEqual((await scanNodeProject(files)).facts, []);
  const included = await scanNodeProject(files, ['--include-tests']);
  assert.equal(included.facts[0]!.testSource, true);
});

test('스캔 공백(symlink·크기 초과·구문 오류)을 route-coverage로 알린다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-node-gaps-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), packageJson({ hono: '4.6.0' }));
    writeFileSync(join(root, 'src/index.ts'), "import { Hono } from 'hono';\nconst app = new Hono();\napp.get('/ok', (c) => c.text('ok'));\nexport default app;\nconst broken = ;\n");
    writeFileSync(join(root, 'src/huge.ts'), `// ${'x'.repeat(MAX_NODE_SOURCE_BYTES)}\n`);
    symlinkSync(join(root, 'src'), join(root, 'linked'));
    const result = await runRoutesCommand(['--role', 'server', '--project', root], { fileSystem: createNodeFileSystem(), toolVersion: '0', now: () => new Date(0) });
    const document = JSON.parse(result.standardOutput) as NodeDocumentView;
    assert.deepEqual(factLines(document), ['GET root /ok strict #0']);
    for (const prefix of ['route-coverage: 1 symbolic link(s)', 'route-coverage: 1 source file(s) exceed', 'route-coverage: 1 source file(s) have syntax errors']) {
      assert.equal(limitationsWith(document, prefix).length, 1, prefix);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('graph는 Node 백엔드 핸들러를 route-handler 진입점으로 표시한다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-node-graph-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), packageJson({ hono: '4.6.0' }));
    writeFileSync(join(root, 'src/index.ts'), "import { Hono } from 'hono';\nimport { list } from './list.ts';\nconst app = new Hono();\napp.get('/l', list);\nexport default app;\n");
    writeFileSync(join(root, 'src/list.ts'), "import type { Context } from 'hono';\nexport function list(c: Context) { return c.text('l'); }\n");
    const result = await runGraphCommand(['--project', root], { fileSystem: createNodeFileSystem(), toolVersion: '0', now: () => new Date(0) });
    assert.equal(result.exitCode, 0, result.standardError);
    const graph = JSON.parse(result.standardOutput) as { nodes: { id: string; entries?: string[] }[] };
    assert.deepEqual(graph.nodes.find((node) => node.id === 'src/list.ts#list')?.entries, ['route-handler']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('금지 문자 이름의 파일·디렉터리는 라우트 사실 경로에 싣지 않고 route-coverage로 알린다', {
  skip: process.platform === 'win32',
}, async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '4.21.2' }),
    // 저장소 @types/node를 읽지 않는 설정이다(검사와 무관한 Program 비용, 아래 공백 테스트도 같다).
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': "import express from 'express';\nconst app = express();\napp.get('/ok', (req, res) => res.send('ok'));\nexport default app;\n",
    'src/r\u007fouter.ts': "import express from 'express';\nexport const hidden = express();\nhidden.get('/hidden', (req, res) => res.send('h'));\n",
    'src/dir\u{2028}x/extra.ts': "import express from 'express';\nexport const extra = express();\nextra.get('/extra', (req, res) => res.send('e'));\n",
  });
  const unsafe = document.facts.filter((fact) => !isSafeIdentifier(fact.location.path)
    || !isSafeIdentifier(fact.symbol.qualifiedName) || (fact.symbol.usr !== undefined && !isSafeIdentifier(fact.symbol.usr)));
  assert.deepEqual(unsafe, []);
  assert.deepEqual(document.facts.map((fact) => fact.channel), ['/ok']);
  assert.equal(limitationsWith(document, 'route-coverage: 2 file or directory name(s) in the project contain characters the exchange format forbids; routers in them were not scanned').length, 1);
});

test('컴파일러가 읽지 못한 소스는 그 안의 라우트가 빠졌을 수 있다고 route-coverage로 알린다', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-node-unreadable-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), packageJson({ express: '4.21.2' }));
    writeFileSync(join(root, 'tsconfig.json'), ambientTypesFreeConfig);
    writeFileSync(join(root, 'src/app.ts'), "import express from 'express';\nimport { mount } from './users';\nconst app = express();\n"
      + "app.get('/ok', (req, res) => res.send('ok'));\nmount(app);\nexport default app;\n");
    writeFileSync(join(root, 'src/users.ts'), "export function mount(app: any) { app.get('/users/:id', (req: any, res: any) => res.send('u')); }\n");
    chmodSync(join(root, 'src/users.ts'), 0o000);
    writeFileSync(join(root, 'src/back\\slash.ts'), 'export const unused = 1;\n');
    const result = await runRoutesCommand(['--role', 'server', '--project', root], { fileSystem: createNodeFileSystem(), toolVersion: '0', now: () => new Date(0) });
    assert.equal(result.exitCode, 0, result.standardError);
    const document = JSON.parse(result.standardOutput) as NodeDocumentView;
    assert.deepEqual(document.facts.map((fact) => fact.channel), ['/ok']);
    assert.equal(limitationsWith(document, 'route-coverage: 2 source file(s) could not be read by the compiler and were not analyzed').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 해석하지 못한 tsconfig의 route-coverage 한계다(graph의 `graph-config:`와 같은 원인 문구). */
const unparsedConfig = 'route-coverage: tsconfig.json could not be parsed; default compiler options were used, so path aliases may not resolve';

test('tsconfig 해석 실패와 compiler 입력 상한 초과를 graph와 같은 원인 문구로 route-coverage에 알린다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '4.21.2' }),
    // 설치하지 않은 extends 때문에 paths 별칭이 풀리지 않고 기본 옵션으로 떨어진다.
    'tsconfig.json': JSON.stringify({ extends: '@tsconfig/node20/tsconfig.json', compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }),
    'src/app.ts': "import express from 'express';\nimport users from '@app/routes';\nimport './huge';\nconst app = express();\n"
      + "app.use('/users', users);\napp.get('/ok', (req, res) => res.send('ok'));\nexport default app;\n",
    'src/routes.ts': "import express from 'express';\nconst router = express.Router();\nrouter.get('/:id', (req, res) => res.send('u'));\nexport default router;\n",
    'src/huge.ts': `// ${'x'.repeat(MAX_NODE_SOURCE_BYTES)}\n`,
  });
  assert.equal(limitationsWith(document, unparsedConfig).length, 1);
  assert.equal(limitationsWith(document, unparsedConfig)[0]!.scope, undefined);
  assert.equal(limitationsWith(document, 'route-coverage: 1 source, declaration, or package input(s) exceeded 4 MiB; type resolution and route registrations may be incomplete').length, 1);
});

/**
 * 라우터 DAG 소스를 만든다. 단계마다 다음 라우터를 두 경로에 붙이므로 마지막 라우터의 GET 하나가 펼친 라우트 2^depth개가 된다.
 *
 * @param depth DAG 단계 수
 * @param second 둘째 mount 경로의 머리 글자. 기본 `b`면 경로가 모두 달라 사실이 2^depth개다. `%61`이면 둘째 경로가 정규화하면
 *   첫째와 같아(`/%611` → `/a1`) 펼친 라우트가 모두 같은 사실 하나다
 * @param leafPaths 마지막 라우터에 GET으로 등록할 경로 인자의 소스(문자열 리터럴이나 식)
 * @returns `src/app.js` 내용
 */
function routerDagSource(depth: number, second = 'b', leafPaths: readonly string[] = ["'/x'"]): string {
  const lines = ["const express = require('express');", 'const app = express();'];
  for (let level = 1; level <= depth; level++) lines.push(`const r${level} = express.Router();`);
  for (const path of leafPaths) lines.push(`r${depth}.get(${path}, (req, res) => res.send('x'));`);
  for (let level = depth; level >= 1; level--) {
    const parent = level === 1 ? 'app' : `r${level - 1}`;
    lines.push(`${parent}.use('/a${level}', r${level});`, `${parent}.use('/${second}${level}', r${level});`);
  }
  return `${lines.join('\n')}\nmodule.exports = app;\n`;
}

/**
 * Hono `route()` DAG 소스다. 단계마다 다음 앱을 두 경로에 복사해 붙이므로 마지막 앱의 GET 하나가 사실 2^depth개가 된다.
 *
 * @param depth DAG 단계 수
 * @returns `src/app.ts` 내용
 */
function honoDagSource(depth: number): string {
  const lines = ["import { Hono } from 'hono';", 'const app = new Hono();'];
  for (let level = 1; level <= depth; level++) lines.push(`const r${level} = new Hono();`);
  lines.push(`r${depth}.get('/x', (c) => c.text('x'));`);
  for (let level = depth; level >= 1; level--) {
    const parent = level === 1 ? 'app' : `r${level - 1}`;
    lines.push(`${parent}.route('/a${level}', r${level});`, `${parent}.route('/b${level}', r${level});`);
  }
  return `${lines.join('\n')}\nexport default app;\n`;
}

/**
 * @koa/router 중첩 `use()` DAG 소스다. 둘째 라우터부터 단계마다 다음 라우터를 두 경로에 복사해 붙이므로 사실이 2^(depth-1)개가 된다.
 *
 * @param depth 라우터 수
 * @returns `src/app.ts` 내용
 */
function koaDagSource(depth: number): string {
  const lines = ["import Koa from 'koa';", "import Router from '@koa/router';", 'const app = new Koa();'];
  for (let level = 1; level <= depth; level++) lines.push(`const r${level} = new Router();`);
  lines.push(`r${depth}.get('/x', (ctx) => { ctx.body = 'x'; });`);
  for (let level = depth; level >= 2; level--) lines.push(`r${level - 1}.use('/a${level}', r${level}.routes());`, `r${level - 1}.use('/b${level}', r${level}.routes());`);
  return `${lines.join('\n')}\napp.use(r1.routes());\nexport default app;\n`;
}

/**
 * 큰 라우터 DAG 자식의 V8 old 영역 상한(MiB)이다.
 *
 * 펼치기가 사실 상한에서 멈추면 살아 있는 힙은 400 MiB 남짓이다(hono·koa가 448 MiB에서 통과하고 384 MiB에서 OOM). 그런데
 * `npm test`·CI처럼 커버리지를 켠 실행에서는 자식도 `NODE_V8_COVERAGE`를 물려받고, 그때 hono·koa 자식이 끝나기 직전에 회수할
 * 수 있는 old 영역 쓰레기를 1 GB 가까이 쌓은 채 Mark-Compact 없이 끝나는 일이 잦다(최대 RSS가 약 0.6 GB와 1.5 GB로 갈린다).
 * 그래서 RSS 감시(1 GiB)만으로는 펼치기 회귀가 아니라 GC 시점 때문에 실패했다. 상한을 주면 V8이 넘기 전에 쓰레기를 회수하므로
 * 검사가 살아 있는 크기에만 걸리고, 다 펼치던 예전 코드는 상한을 넘어 OOM(종료 134)으로 실패한다. 상한에 V8 밖 메모리를 더해도
 * RSS 감시 아래에 남는 값이다.
 */
const DAG_CHILD_HEAP_MIB = 640;

/**
 * 합성 파일로 임시 프로젝트를 만들어 CLI를 시간·메모리를 감시하는 자식 프로세스로 실행한다. 펼치기가 지수로 커지는 회귀가
 * 생겨도 테스트 프로세스의 메모리를 다 쓰지 않고 이 검사만 실패하게 하려는 것이다. 자식 힙은 `DAG_CHILD_HEAP_MIB`로 막는다.
 *
 * @param files 프로젝트 기준 경로 → 내용
 * @param command `--project` 앞의 CLI 인자
 * @returns 감시한 실행 결과
 */
async function runGuardedProject(files: Record<string, string>, command: readonly string[]): Promise<GuardedRun> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-node-flatten-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await runMainGuarded([...command, '--project', root], [`--max-old-space-size=${DAG_CHILD_HEAP_MIB}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 합성 프로젝트 여러 개를 만들어 명령마다 하나씩, 시간·메모리를 감시하는 자식 프로세스 하나에서 차례로 실행한다.
 * 자식 시작 비용을 한 번만 내려는 것이다. 자식 힙은 `DAG_CHILD_HEAP_MIB`로 막는다(명령 사이의 쓰레기는 V8이 상한
 * 전에 회수한다).
 *
 * @param projects 프로젝트 기준 경로 → 내용과 그 프로젝트에서 실행할 `--project` 앞의 CLI 인자
 * @returns 자식 실행 결과와 명령별 결과
 */
async function runGuardedProjects(projects: readonly (readonly [Record<string, string>, readonly string[]])[]): Promise<GuardedCliRuns> {
  const roots: string[] = [];
  try {
    for (const [files] of projects) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-node-flatten-')));
      roots.push(root);
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), content);
      }
    }
    const runs = projects.map(([, command], index) => [...command, '--project', roots[index]!]);
    return await runCliGuarded(runs, [`--max-old-space-size=${DAG_CHILD_HEAP_MIB}`]);
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

/** 펼치면 사실이 2^22 = 4,194,304개인 라우터 DAG를 프레임워크별로 만든 프로젝트다. */
const largeDags: readonly (readonly [string, Record<string, string>])[] = [
  ['express', { 'package.json': packageJson({ express: '4.21.2' }), 'src/app.js': routerDagSource(22) }],
  ['hono', { 'package.json': packageJson({ hono: '4.6.0' }), 'src/app.ts': honoDagSource(22) }],
  ['koa', { 'package.json': packageJson({ koa: '2.16.4', '@koa/router': '13.1.1' }), 'src/app.ts': koaDagSource(23) }],
];

test('공유 하위 라우터 DAG가 사실 상한을 넘으면 다 펼치기 전에 멈추고 사실 상한으로 알린다', async () => {
  // 예전에는 펼친 라우트 400만 개와 그 사실을 모두 만든 뒤에야 상한을 봐서, 그 전에 V8 힙이 바닥났다(종료 134).
  // 세 프레임워크는 감시하는 자식 하나에서 차례로 실행한다. 자식이 끝나지 못하면 stderr의 마지막 `run <n>`이 그 프레임워크다.
  const { child, results } = await runGuardedProjects(largeDags.map(([, files]) => [files, ['routes', '--role', 'server']]));
  assert.equal(child.stopped, undefined, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  for (const [index, [framework]] of largeDags.entries()) {
    const result = results[index];
    assert.ok(result !== undefined, framework);
    assert.equal(result.exitCode, 2, `${framework}: ${result.standardError}`);
    assert.equal(result.standardOutput, '', framework);
    assert.match(result.standardError, /more than 100000 route-decl facts/u, framework);
  }
});

test('graph는 사실 상한을 넘는 Node 라우터 DAG에서도 끝까지 가고 진입점을 표시하지 못한 것을 한계로 알린다', async () => {
  const result = await runGuardedProject(largeDags[0]![1], ['graph', '--generated-at', '2026-01-01T00:00:00.000Z']);
  assert.equal(result.stopped, undefined);
  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout) as { limitations: string[] };
  assert.ok(graph.limitations.includes('entry-points: the project produces more route-decl facts than the routes limit; route handlers are not marked'));
});

test('정규화하면 같은 경로에 거듭 붙인 DAG는 펼친 라우트가 사실 상한보다 많아도 같은 사실로 합쳐져 성공한다', async () => {
  // 2^16 × 등록 2개 = 131,072개 라우트가 정적 `/a1/…/a16/x`와 dynamic `/a1/…/a16{dynamic}` 사실 둘로 합쳐진다. 펼친 라우트나
  // 원문 경로를 세면 거짓으로 상한을 넘는다. 이 절의 같은 프로세스 DAG fixture는 저장소 @types/node를 읽지 않는 tsconfig를 둔다
  // (펼치기와 무관한 Program 비용).
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '4.21.2' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.js': routerDagSource(16, '%61', ["'/x'", 'process.env.P']),
  });
  const prefix = Array.from({ length: 16 }, (_, index) => `/a${index + 1}`).join('');
  assert.deepEqual(factLines(document), [`GET root ${prefix}/x optional #0 ci`, `GET root ${prefix}{dynamic} - dynamic{"templatePrefixes":["${prefix}"]} #1 ci`]);
});

/** 펼친 등록 수 상한 때문에 라우트 핸들러를 진입점으로 표시하지 못했다는 graph 한계다. */
const flatteningEntryPoints = "entry-points: the project's routers expand to more route registrations than the flattening limit "
  + 'when routers mounted at several paths are flattened; route handlers are not marked';

test('정규화하면 같은 경로로 합쳐지는 라우트도 펼친 수가 상한을 넘으면 다 펼치기 전에 멈추고 펼친 등록 수를 원인으로 알린다', async () => {
  // 서로 다른 사실 하한만 세면 같은 사실로 합쳐지는 라우트는 상한에 걸리지 않아, 2^22 = 4,194,304개를 다 펼치다 V8 힙이 바닥난다.
  // 펼친 라우트 수 자체에도 상한(200,000)을 두면 종료 2로 끝난다. 이때 사실은 하나뿐이고, 조건부 등록만 둔 2^18 DAG는 사실이
  // 0개(예전에는 종료 0)라 사실 수 초과 문구는 거짓 원인이다. 세 명령은 감시하는 자식 하나에서 차례로 실행한다.
  const sameFact = { 'package.json': packageJson({ express: '4.21.2' }), 'src/app.js': routerDagSource(22, '%61') };
  const conditionalOnly = {
    'package.json': packageJson({ express: '4.21.2' }),
    'src/app.js': routerDagSource(18).replace("r18.get('/x'", "if (process.env.C) r18.get('/x'"),
  };
  const { child, results } = await runGuardedProjects([
    [sameFact, ['routes', '--role', 'server']],
    [conditionalOnly, ['routes', '--role', 'server']],
    [sameFact, ['graph', '--generated-at', '2026-01-01T00:00:00.000Z']],
  ]);
  assert.equal(child.stopped, undefined, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  for (const [index, name] of ['same fact', 'conditional only'].entries()) {
    const result = results[index];
    assert.ok(result !== undefined, name);
    assert.equal(result.exitCode, 2, `${name}: ${result.standardError}`);
    assert.equal(result.standardOutput, '', name);
    assert.match(result.standardError, /more than 200000 route registrations when routers mounted at several paths are flattened/u, name);
    assert.doesNotMatch(result.standardError, /route-decl facts/u, name);
  }
  const graph = JSON.parse(results[2]!.standardOutput) as { limitations: string[] };
  assert.ok(graph.limitations.includes(flatteningEntryPoints));
  assert.ok(!graph.limitations.some((line) => line.includes('route-decl facts')));
});

test('사실 상한 아래의 라우터 DAG는 예전처럼 모두 펼친다', async () => {
  const cases: readonly Record<string, string>[] = [
    { 'package.json': packageJson({ express: '4.21.2' }), 'src/app.js': routerDagSource(12) },
    { 'package.json': packageJson({ hono: '4.6.0' }), 'src/app.ts': honoDagSource(12) },
    { 'package.json': packageJson({ koa: '2.16.4', '@koa/router': '13.1.1' }), 'src/app.ts': koaDagSource(13) },
  ];
  for (const files of cases) {
    const document = await scanNodeProject({ ...files, 'tsconfig.json': ambientTypesFreeConfig });
    assert.equal(document.facts.length, 4096);
    assert.equal(new Set(document.facts.map((fact) => fact.channel)).size, 4096);
  }
});

test('사실이 인자 펼침 한계(약 12만)를 넘어도 스택 초과·출력 초과가 아니라 사실 상한으로 알린다', async () => {
  // 라우트 2^13 = 8,192개가 선택 그룹 넷으로 템플릿 16개씩, 사실 131,072개다. 펼치는 동안 세는 사실 하한은 라우트마다 첫
  // 템플릿 하나(8,192개)라 펼치기는 끝까지 가고, 사실을 모두 만든 뒤 조립에서 상한을 본다. 64비트 V8 기본 스택(984 KiB)은
  // 8바이트 인자 131,072개(1 MiB)를 한 번에 펼쳐 받지 못한다.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-node-dag-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), packageJson({ express: '5.1.0' }));
    writeFileSync(join(root, 'tsconfig.json'), ambientTypesFreeConfig);
    writeFileSync(join(root, 'src/app.js'), routerDagSource(13, 'b', ["'/x{/c1}{/c2}{/c3}{/c4}'"]));
    const result = await runRoutesCommand(['--role', 'server', '--project', root], { fileSystem: createNodeFileSystem(), toolVersion: '0', now: () => new Date(0) });
    assert.equal(result.exitCode, 2);
    assert.equal(result.standardOutput, '');
    assert.match(result.standardError, /more than 100000 route-decl facts/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
