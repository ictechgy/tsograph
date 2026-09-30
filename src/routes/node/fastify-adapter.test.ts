/**
 * Fastify 어댑터의 해석·펼치기 규칙을 합성 임시 프로젝트로 검사한다(오라클 fixture가 덮지 않는 분기).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildRoutePrefix } from './fastify-adapter.ts';
import { factLines, limitationsWith, packageJson, scanNodeProject } from './testing.test.ts';

test('패키지 플러그인을 분류하고 접두사 스코프를 단다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0', '@fastify/static': '8.0.0', '@fastify/cors': '10.0.0', '@fastify/autoload': '6.0.0', '@fastify/helmet': '13.0.0', 'fastify-metrics': '12.0.0' }),
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import fastifyStatic from '@fastify/static';",
      "import cors from '@fastify/cors';",
      "import autoload from '@fastify/autoload';",
      "import helmet from '@fastify/helmet';",
      "import metrics from 'fastify-metrics';",
      'const app = Fastify({ routerOptions: { ignoreTrailingSlash: true, caseSensitive: false } });',
      "app.register(fastifyStatic, { root: '/tmp', prefix: '/public' });",
      'app.register(cors);',
      "app.register(autoload, { dir: 'routes' });",
      'app.register(helmet);',
      "app.register(metrics, { prefix: '/metrics' });",
      "app.register(import('./plugin.ts'), { prefix: '/lazy' });",
      "app.get('/Mixed', async () => 'm');",
      'export default app;',
    ].join('\n'),
    'src/plugin.ts': "export default async function plugin() {}\n",
  });
  assert.deepEqual(factLines(document), ['GET root /Mixed optional ci']);
  const provided = limitationsWith(document, 'framework-provided-routes:').map((entry) => entry.scope);
  assert.deepEqual(provided, [{ templatePrefixes: ['/metrics'] }, { templatePrefixes: ['/'], methods: ['OPTIONS'] }, { templatePrefixes: ['/public'], methods: ['GET', 'HEAD'] }]);
  const coverage = limitationsWith(document, 'route-coverage: 1 registration(s) of').map((entry) => entry.scope);
  assert.deepEqual(coverage, [{ templatePrefixes: ['/lazy'] }, { templatePrefixes: ['/'] }]);
});

test('route() 옵션·prefixTrailingSlash·동적 method·접두사 규칙을 다룬다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '4.28.0' }),
    'src/app.js': [
      "const fastify = require('fastify');",
      'const app = fastify({ ignoreDuplicateSlashes: true });',
      "app.register(async (child) => {",
      "  child.get('/', { prefixTrailingSlash: 'slash' }, async () => 's');",
      "  child.route({ method: 'GET', url: '/', prefixTrailingSlash: 'no-slash', handler: async () => 'n' });",
      "  child.route({ method: process.env.M, path: '/dyn', handler: async () => 'd' });",
      "  child.get('/', { prefixTrailingSlash: process.env.MODE }, async () => 'u');",
      "  child.post('/p', { handler: async () => 'p' });",
      "  child.get(`/t/${process.env.T}`, async () => 't');",
      "}, { prefix: '/v/' });",
      "app.register(async (child) => { child.get('/unknown', async () => 'x'); }, { prefix: process.env.P });",
      'module.exports = app;',
    ].join('\n'),
  });
  // 접두사가 `/`로 끝나고 ignoreDuplicateSlashes면 'slash'(`/v//`)와 'no-slash'(`/v/`)가 같은 URL이 된다.
  assert.deepEqual(factLines(document), [
    'ANY root /v/dyn strict',
    'GET root /v/ strict',
    'GET root /v/ strict',
    'GET root /v/t/{dynamic} - dynamic{"templatePrefixes":["/v/t"]}',
    'GET root /v/{dynamic} - dynamic{"templatePrefixes":["/v"]}',
    'GET root {dynamic} - dynamic{"templatePrefixes":["/"]}',
    'POST root /v/p strict',
  ].sort());
});

test('타입 주석으로만 아는 FastifyInstance 매개변수는 base 앵커다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.0.0' }),
    'src/routes.ts': "import type { FastifyInstance } from 'fastify';\nexport async function routes(app: FastifyInstance) {\n  app.get('/health', async () => 'ok');\n}\n",
  });
  assert.deepEqual(factLines(document), ['GET base /health -']);
});

test('buildRoutePrefix는 fastify lib/plugin-override.js와 같다', () => {
  assert.deepEqual(buildRoutePrefix({ kind: 'literal', text: '' }, { kind: 'literal', text: 'admin' }), { kind: 'literal', text: '/admin' });
  assert.deepEqual(buildRoutePrefix({ kind: 'literal', text: '/a/' }, { kind: 'literal', text: '/b' }), { kind: 'literal', text: '/a/b' });
  assert.deepEqual(buildRoutePrefix({ kind: 'literal', text: '/a' }, { kind: 'literal', text: '/b' }), { kind: 'literal', text: '/a/b' });
  assert.deepEqual(buildRoutePrefix({ kind: 'literal', text: '/a' }, undefined), { kind: 'literal', text: '/a' });
  assert.deepEqual(buildRoutePrefix({ kind: 'literal', text: '/a' }, { kind: 'unknown' }), { kind: 'partial', head: '/a' });
  assert.deepEqual(buildRoutePrefix({ kind: 'literal', text: '/a' }, { kind: 'partial', head: 'b' }), { kind: 'partial', head: '/a/b' });
  assert.deepEqual(buildRoutePrefix({ kind: 'unknown' }, { kind: 'literal', text: '/b' }), { kind: 'unknown' });
});
