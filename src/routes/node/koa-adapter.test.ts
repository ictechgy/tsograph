/**
 * Koa + @koa/router 어댑터의 해석·펼치기 규칙을 합성 임시 프로젝트로 검사한다(오라클 fixture가 덮지 않는 분기).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { factLines, limitationsWith, packageJson, scanNodeProject } from './testing.test.ts';

test('prefix() 호출·exclusive·host·redirect·정적 파일·끝을 여는 함수를 다룬다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ koa: '3.0.0', '@koa/router': '15.1.0', 'koa-static': '5.0.0' }),
    'src/app.ts': [
      "import Koa from 'koa';",
      "import Router from '@koa/router';",
      "import serve from 'koa-static';",
      'const app = new Koa();',
      "const router = new Router({ exclusive: true, host: 'api.example.com' });",
      "router.prefix('/v2');",
      "router.get('/a', (ctx) => { ctx.body = 'a'; });",
      "router.redirect('/old', '/v2/a');",
      "router.use(async (ctx, next) => { await next(); });",
      "router.use('/term', (ctx) => { ctx.body = 'term'; });",
      'app.use(router.routes());',
      "app.use(serve('public'));",
      "app.use((ctx) => { ctx.body = 'last'; });",
      "app.use((ctx) => { ctx.status = 404; });",
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document), [
    'ANY root / optional #0 prefix',
    'ANY root /v2/old optional ci narrowed',
    'ANY root /v2/term optional ci narrowed prefix',
    'ANY root /v2/term/{**} - ci narrowed',
    'ANY root /{**} - #0',
    'GET root /v2/a optional ci narrowed',
  ]);
  assert.equal(limitationsWith(document, 'route-dispatch-order-unknown: 3 route declaration(s) belong to an exclusive').length, 1);
  assert.deepEqual(limitationsWith(document, 'framework-provided-routes:').map((entry) => entry.scope), [{ templatePrefixes: ['/'], methods: ['GET', 'HEAD'] }]);
  assert.equal(limitationsWith(document, 'missing-route-usrs: 1').length, 1);
});

test('@koa/router 13(잠금 파일)은 path-to-regexp 6 문법이고 앱에 붙지 않은 라우터는 base다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ '@koa/router': '^13.0.0' }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@koa/router': { version: '13.1.1' } } }),
    'src/router.js': "const Router = require('@koa/router');\nconst router = new Router({ strict: true, sensitive: true, prefix: '/p/' });\nrouter.get('/users/:id?', (ctx) => { ctx.body = 'u'; });\nrouter.get('/', (ctx) => { ctx.body = 'root'; });\nmodule.exports = router;\n",
  });
  assert.deepEqual(factLines(document), ['GET base /p/ strict #1', 'GET base /p/users strict #0', 'GET base /p/users/{} strict #0']);
});

test('라우터 버전을 모르면 두 문법이 같을 때만 정적 사실이다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ koa: '*', 'koa-router': 'latest' }),
    'src/app.ts': "import Koa from 'koa';\nimport Router from 'koa-router';\nconst app = new Koa();\nconst router = new Router();\nrouter.get('/same/:id', (ctx) => { ctx.body = 's'; });\nrouter.get('/opt/:id?', (ctx) => { ctx.body = 'o'; });\nconst nested = new Router();\nnested.get('/n', (ctx) => { ctx.body = 'n'; });\nrouter.use(['/x', '/y'], nested.routes());\nrouter.use(process.env.P as string, nested.routes());\napp.use(router.routes());\nexport default app;\n",
  });
  assert.deepEqual(factLines(document), [
    'GET root /opt/:id%3F - dynamic{"templatePrefixes":["/opt"]} #1 ci',
    'GET root /same/{} optional #0 ci',
    // 같은 중첩 레이어를 여러 접두사로 복제해도 소스 위치가 같은 한 등록이다(같은 index).
    'GET root /x/n optional #2 ci',
    'GET root /y/n optional #2 ci',
    'GET root {dynamic} - dynamic #2 ci',
  ]);
  assert.equal(limitationsWith(document, 'route-framework-version-unknown:').length, 1);
});
