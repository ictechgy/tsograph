/**
 * Node 백엔드 추출 파이프라인(감지·해석기·문서 조립)을 합성 임시 프로젝트로 끝까지 검사한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../../cli/file-system.ts';
import { runGraphCommand } from '../../cli/graph-command.ts';
import { runRoutesCommand } from '../../cli/routes-command.ts';
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
