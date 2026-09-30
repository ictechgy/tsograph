/**
 * Express 어댑터의 해석·펼치기 규칙을 합성 임시 프로젝트로 검사한다(오라클 fixture가 덮지 않는 분기).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { factLines, limitationsWith, packageJson, scanNodeProject } from './testing.test.ts';

test('CommonJS exports·클래스 필드·설정 순서·정규식 경로·배열 경로를 다룬다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '4.21.2' }),
    'src/routes.js': "const express = require('express');\nconst router = express.Router();\nrouter.get(['/a', '/b'], (req, res) => res.send('ab'));\nrouter.get(/^\\/re$/, (req, res) => res.send('re'));\nexports.router = router;\n",
    'src/server.js': [
      "const express = require('express');",
      "const { router } = require('./routes');",
      'class Server {',
      '  constructor() {',
      '    this.app = express();',
      "    this.app.set('strict routing', true);",
      "    this.app.get('title');",
      "    this.app.use('/r', router);",
      "    this.app.get('/s/', (req, res) => res.send('s'));",
      "    this.app.enable('case sensitive routing');",
      '  }',
      '}',
      'module.exports = Server;',
    ].join('\n'),
  });
  // 생성자에서 만든 앱은 독립 프레임이지만 요청을 받는 앱이다. 라우터는 자기 strict(기본 false)를 쓴다.
  assert.deepEqual(factLines(document), ['GET root /r/a optional #0', 'GET root /r/b optional #1', 'GET root /r{dynamic} - dynamic{"templatePrefixes":["/r"]} #2', 'GET root /s/ strict #3']);
});

test('설정은 첫 등록 전에 바꾼 값만 쓰고, 모르는 값이면 규칙을 싣지 않는다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '^4.21.0' }),
    'src/app.js': [
      "const express = require('express');",
      'const app = express();',
      "app.enable('strict routing');",
      "app.set('case sensitive routing', true);",
      "app.get('/x/', (req, res) => res.send('x'));",
      'const late = express();',
      "late.get('/y', (req, res) => res.send('y'));",
      "late.disable('strict routing');",
      'const unknown = express();',
      'unknown.set(process.env.KEY, true);',
      "unknown.get('/z', (req, res) => res.send('z'));",
      'module.exports = { app, late, unknown };',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document), ['GET root /x/ strict #0', 'GET root /y - #0 ci', 'GET root /z - #0']);
});

test('주 버전을 모르면 두 문법이 같을 때만 정적 사실이고 버전 한계를 낸다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '*' }),
    'src/app.js': "const express = require('express');\nconst app = express();\napp.get('/same/:id', (req, res) => res.send('a'));\napp.get('/files/*', (req, res) => res.send('b'));\napp.use('/m/:v?', express.Router().get('/q', (req, res) => res.send('c')));\nmodule.exports = app;\n",
  });
  assert.deepEqual(factLines(document), ['GET root /files/* - dynamic{"templatePrefixes":["/files"]} #1 ci', 'GET root /m/{dynamic}/q - dynamic{"templatePrefixes":["/m"]} #2 ci', 'GET root /same/{} optional #0 ci'].sort());
  assert.equal(limitationsWith(document, 'route-framework-version-unknown: package.json and the lockfile do not pin express').length, 1);
});

test('use()의 패키지 미들웨어·정적 파일·요청을 끝내는 함수·찾지 못함 처리기를 가른다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '5.1.0', 'serve-static': '2.0.0', 'swagger-ui-express': '5.0.0', helmet: '8.0.0' }),
    'src/app.ts': [
      "import express from 'express';",
      "import serveStatic from 'serve-static';",
      "import swaggerUi from 'swagger-ui-express';",
      "import helmet from 'helmet';",
      'const app = express();',
      'app.use(helmet());',
      "app.use('/docs', swaggerUi.serve, swaggerUi.setup({}));",
      "app.use(serveStatic('public'));",
      "app.use((req, res) => { res.send('fallback'); });",
      "app.use((req, res) => { res.status(404).send('missing'); });",
      "app.get('/lib', swaggerUi.setup({}));",
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document), ['ANY root / optional #0 ci prefix', 'ANY root /{**} - #0 ci', 'GET root /lib optional ci'].sort());
  const provided = limitationsWith(document, 'framework-provided-routes:');
  assert.deepEqual(provided.map((entry) => entry.scope), [{ templatePrefixes: ['/'], methods: ['GET', 'HEAD'] }, { templatePrefixes: ['/docs'] }]);
  assert.match(provided[0]!.text, /static files from serve-static/u);
  assert.match(provided[1]!.text, /2 registration\(s\) of middleware from swagger-ui-express/u);
  assert.equal(limitationsWith(document, 'missing-route-usrs: 1').length, 1);
});

test('붙인 곳을 모르는 라우터는 base 앵커이고 자기 group으로 순서를 싣는다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '5.1.0' }),
    'src/orphan.ts': "import { Router } from 'express';\nconst router = Router({ caseSensitive: true });\nrouter.get('/o', (req, res) => { res.send('o'); });\nrouter.get('/p', (req, res, next) => next());\nexport default router;\n",
    'src/app.ts': "import express from 'express';\nimport sub from './orphan.ts';\nconst app = express();\napp.use(process.env.MOUNT as string, sub);\nexport default app;\n",
  });
  assert.deepEqual(factLines(document), ['GET base /o optional #0', 'GET base /p optional']);
  assert.ok(document.facts[0]!.order!.group.startsWith('express:src/app.ts'));
  assert.deepEqual(limitationsWith(document, 'unresolved-route-prefix:').map((entry) => entry.scope), [{ templateSuffixes: ['/o', '/p'] }]);
});

test('타입 주석으로만 아는 Express 라우터 매개변수와 앞부분만 아는 mount 접두사', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '4.21.2' }),
    'src/register.ts': "import type { Router } from 'express';\nimport * as express from 'express';\nexport function register(router: Router) {\n  router.post('/hook', (req, res) => res.send('h'));\n}\nconst app = express.default();\napp.use(`/api/${process.env.V}`, express.Router().get('/x', (req, res) => res.send('x')));\n",
  });
  assert.deepEqual(factLines(document), ['GET root /api/{dynamic}/x - dynamic{"templatePrefixes":["/api"]} #0 ci', 'POST base /hook -'].sort());
});

test('타입 정보 없는 첫 인자도 뒤에 인자가 있으면 경로이고, 풀지 못한 값은 그 접두사 아래를 알린다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '4.21.2' }),
    'src/app.js': "const express = require('express');\nconst app = express();\nconst router = express.Router();\nrouter.get('/r', (req, res) => res.send('r'));\napp.use(process.env.PREFIX, router);\napp.use('/ext', require(process.env.MODULE));\nmodule.exports = app;\n",
  });
  assert.deepEqual(factLines(document), ['GET base /r optional #0 ci']);
  assert.deepEqual(limitationsWith(document, 'route-coverage: 1 registration(s) of a value passed to use()').map((entry) => entry.scope), [{ templatePrefixes: ['/ext'] }]);
});

test('route 빌더 순서는 route() 호출 위치이고, 펼친 핸들러·풀지 못한 라우터 모양 use()를 조용히 빠뜨리지 않는다', async () => {
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '5.1.0' }),
    'src/app.ts': [
      "import express from 'express';",
      "import { handlers } from './h.js';",
      'const app = express();',
      "const route = app.route('/x');",
      "app.get('/y', (req, res) => { res.send('y'); });",
      "function wire() { route.get((req, res) => { res.send('x'); }); }",
      'wire();',
      "app.get('/spread', ...handlers);",
      "app.get('/nested', [handlers[0]!, ...handlers]);",
      'declare const routers: express.Router[];',
      'app.use(routers[0]!);',
      '// 임시 프로젝트에는 @types/express가 없어 패키지 타입은 any다. 라우터 표식이 없는 함수 타입은 미들웨어로 센다.',
      'declare const logger: (req: unknown, res: unknown, next: () => void) => void;',
      'app.use(logger);',
      'declare const mounted: ((req: unknown, res: unknown) => void) & { stack: unknown[] };',
      'app.use(mounted);',
      'export default app;',
    ].join('\n'),
    'src/h.ts': "import type { RequestHandler } from 'express';\nexport const handlers: RequestHandler[] = [(req, res) => { res.send('s'); }];\n",
  });
  assert.deepEqual(factLines(document), ['GET root /nested optional ci', 'GET root /spread optional ci', 'GET root /x optional #0 ci', 'GET root /y optional #1 ci']);
  assert.equal(limitationsWith(document, 'missing-route-usrs: 2 route declaration(s)').length, 1);
  assert.equal(limitationsWith(document, 'route-coverage: 2 registration(s) of a value passed to use() that tsograph could not resolve').length, 1);
  assert.equal(limitationsWith(document, 'framework-dispatch-unmodeled: 1 middleware registration(s)').length, 1);
});
