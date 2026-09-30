/**
 * Hono 어댑터의 해석·펼치기 규칙을 합성 임시 프로젝트로 검사한다(오라클 fixture가 덮지 않는 분기).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { factLines, limitationsWith, packageJson, scanNodeProject } from './testing.test.ts';

/** 기본 package.json이다. */
const hono = packageJson({ hono: '^4.6.0' });

test('타입 주석으로만 아는 Hono 매개변수는 base 앵커이고 접미사 스코프를 단다', async () => {
  const document = await scanNodeProject({
    'package.json': hono,
    'src/register.ts': "import { Hono } from 'hono';\nexport default function register(app: Hono) {\n  app.get('/items/:id', (c) => c.text('x'));\n}\n",
  });
  assert.deepEqual(factLines(document), ['GET base /items/{} -']);
  assert.deepEqual(limitationsWith(document, 'unresolved-route-prefix:').map((entry) => entry.scope), [{ templateSuffixes: ['/items/{}'] }]);
  assert.equal(document.facts[0]!.order, undefined);
});

test('hono/quick 프리셋과 사용자 router 옵션은 끝 슬래시 규칙을 싣지 않는다', async () => {
  const document = await scanNodeProject({
    'package.json': hono,
    'src/a.ts': "import { Hono } from 'hono/quick';\nconst app = new Hono();\napp.get('/q', (c) => c.text('q'));\nexport default app;\n",
    'src/b.ts': "import { Hono } from 'hono';\nimport { RegExpRouter } from 'hono/router/reg-exp-router';\nconst app = new Hono({ router: new RegExpRouter() });\napp.get('/r', (c) => c.text('r'));\nexport default app;\n",
  });
  assert.deepEqual(factLines(document), ['GET root /q - #0', 'GET root /r - #0']);
});

test('정적으로 모르는 method·경로·붙인 대상은 dynamic·base·한계로 낸다', async () => {
  const document = await scanNodeProject({
    'package.json': hono,
    'src/index.ts': [
      "import { Hono } from 'hono';",
      "import { serveStatic } from '@hono/node-server/serve-static';",
      'const app = new Hono();',
      'const verb = process.env.VERB as string;',
      "app.on(verb, '/dyn-method', (c) => c.text('m'));",
      "app.query('/search', (c) => c.text('s'));",
      "app.on(['PURGE', 'GET'], '/purge', (c) => c.text('p'));",
      "app.get((c) => c.text('no path'));",
      "app.use('/static/*', serveStatic({ root: './' }));",
      "app.mount('/legacy', (request: Request) => new Response('legacy'));",
      'app.route(process.env.PREFIX as string, new Hono().get(\'/under\', (c) => c.text(\'u\')));',
      "app.route('/lost', globalThis.unknownApp);",
      'app.route(`/v/${process.env.V}`, new Hono().get(\'/x\', (c) => c.text(\'x\')));',
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document), [
    'ANY root /dyn-method strict',
    'GET base /under strict #3',
    'GET root /purge strict #1',
    'GET root /v/{dynamic} - dynamic{"templatePrefixes":["/v"]} #4',
    'GET root /{dynamic} - dynamic{"templatePrefixes":["/"]} #2',
  ]);
  assert.equal(limitationsWith(document, 'route-coverage: 2 route registration(s) also accept HTTP verbs').length, 1);
  const provided = limitationsWith(document, 'framework-provided-routes:');
  assert.deepEqual(provided.map((entry) => entry.scope), [{ templatePrefixes: ['/static'] }]);
  const coverage = limitationsWith(document, 'route-coverage: 1 registration(s) of');
  assert.deepEqual(coverage.map((entry) => entry.scope).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [{ templatePrefixes: ['/legacy'] }, { templatePrefixes: ['/lost'] }]);
  assert.equal(limitationsWith(document, 'route-coverage: 2 route declaration(s) have paths').length, 1);
});

test('basePath 파생·체인·import한 앱과 다른 모듈의 등록은 순서를 가려 싣는다', async () => {
  const document = await scanNodeProject({
    'package.json': hono,
    'src/app.ts': "import { Hono } from 'hono';\nexport const app = new Hono({ strict: false });\napp.get('/a', (c) => c.text('a'));\n",
    'src/extra.ts': "import { app } from './app.ts';\napp.get('/b', (c) => c.text('b'));\nconst v1 = app.basePath('/v1');\nv1.get('/c', (c) => c.text('c')).post((c) => c.text('d'));\n",
  });
  assert.deepEqual(factLines(document), ['GET root /a optional #0', 'GET root /b optional', 'GET root /v1/c optional', 'POST root /v1/c optional']);
  assert.equal(limitationsWith(document, 'route-dispatch-order-unknown: 3').length, 1);
});

test('next를 받지 않는 use 함수는 라우트이고, 받는 함수는 넘기는 미들웨어다', async () => {
  const document = await scanNodeProject({
    'package.json': hono,
    'src/index.ts': "import { Hono } from 'hono';\nconst app = new Hono();\napp.use(async (c, next) => { await next(); });\napp.use('/ping', (c) => c.text('pong'));\nexport default app;\n",
  });
  assert.deepEqual(factLines(document), ['ANY root /ping strict #0']);
  assert.equal(limitationsWith(document, 'framework-dispatch-unmodeled: 1 middleware').length, 1);
});

test('팩토리를 두 번 부르면 앱마다 다른 group이다', async () => {
  const document = await scanNodeProject({
    'package.json': hono,
    'src/factory.ts': "import { Hono } from 'hono';\nexport function createApp() {\n  const app = new Hono();\n  app.get('/f', (c) => c.text('f'));\n  return app;\n}\n",
    'src/a.ts': "import { createApp } from './factory.ts';\nexport const a = createApp();\n",
    'src/b.ts': "import { createApp } from './factory.ts';\nexport const b = createApp();\n",
  });
  const groups = document.facts.map((fact) => fact.order?.group);
  assert.equal(groups.length, 2);
  assert.notEqual(groups[0], groups[1]);
  assert.ok(groups.every((group) => /^hono:src\/factory\.ts:3:15@[0-9a-f]{8}$/u.test(group ?? '')));
});
