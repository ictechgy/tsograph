/**
 * Express 어댑터의 해석·펼치기 규칙을 합성 임시 프로젝트로 검사한다(오라클 fixture가 덮지 않는 분기).
 */

import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runMainGuarded } from '../../cli/testing.test.ts';
import { MAX_SOURCE_BYTES } from '../../schema/project-reader.ts';
import { factLines, limitationsWith, type NodeDocumentView, packageJson, scanNodeProject } from './testing.test.ts';

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

/**
 * `require('./routes')`가 디렉터리 package.json의 `main`으로 풀리는 Express 프로젝트다.
 *
 * @param manifestPadding package.json 뒤에 붙일 공백 바이트 수
 * @returns 프로젝트 기준 경로 → 내용
 */
function directoryRequireProject(manifestPadding: number): Record<string, string> {
  const router = (path: string): string => `const express = require('express');\nconst router = express.Router();\nrouter.get('${path}', (req, res) => res.send('x'));\nmodule.exports = router;\n`;
  return {
    'package.json': packageJson({ express: '4.21.2' }),
    'src/app.js': "const express = require('express');\nconst app = express();\napp.use('/api', require('./routes'));\nmodule.exports = app;\n",
    'src/routes/package.json': `{"main":"other.js"}${' '.repeat(manifestPadding)}`,
    'src/routes/index.js': router('/index'),
    'src/routes/other.js': router('/other'),
  };
}

test('require 해석은 compiler host와 같은 package.json 상한을 지키고 상한을 넘으면 대체 경로를 추측하지 않는다', async (t) => {
  assert.ok(factLines(await scanNodeProject(directoryRequireProject(0))).some((line) => line.startsWith('GET root /api/other ')));
  const originalReadFileSync = fs.readFileSync;
  const unboundedManifestReads: string[] = [];
  t.mock.method(fs, 'readFileSync', function readFileSync(this: unknown, ...arguments_: Parameters<typeof fs.readFileSync>) {
    if (String(arguments_[0]).endsWith('/src/routes/package.json')) unboundedManifestReads.push(String(arguments_[0]));
    return originalReadFileSync.apply(this, arguments_);
  });
  syncBuiltinESMExports();
  try {
    const document = await scanNodeProject(directoryRequireProject(MAX_SOURCE_BYTES));
    assert.deepEqual(unboundedManifestReads, []);
    assert.deepEqual(factLines(document).filter((line) => line.includes('/api/')), []);
    assert.ok(document.limitations.some((line) => line.startsWith('route-coverage: 1 registration(s) of a value passed to use() that tsograph could not resolve')));
    assert.ok(document.limitations.some((line) => line.startsWith('unresolved-route-prefix: 2 route declaration(s)')));
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
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

/** 선택 그룹 넷(대안 16개)이 든 Express 5 mount 경로다. */
const optionalMountPath = '/m{/g0}{/g1}{/g2}{/g3}';

/** {@link optionalMountPath}의 첫 대안(그룹을 모두 넣은 것)이다. dynamic 사실의 원문 표기는 단계마다 이것을 잇는다. */
const optionalMountHead = '/m/g0/g1/g2/g3';

/**
 * 단계마다 다음 라우터를 {@link optionalMountPath}에 붙이는 Express 5 mount 체인 소스다. 접두사 대안이 단계마다 16배가 된다.
 *
 * @param depth mount 단계 수
 * @param leaf 마지막 라우터 이름을 받아 그 라우터에 넣을 등록 줄을 돌려주는 함수
 * @returns `src/app.js` 내용
 */
function optionalMountChain(depth: number, leaf: (router: string) => readonly string[]): string {
  const lines = ["const express = require('express');", 'const app = express();'];
  for (let level = 1; level <= depth; level++) lines.push(`const r${level} = express.Router();`);
  lines.push(...leaf(`r${depth}`));
  for (let level = depth; level >= 1; level--) lines.push(`${level === 1 ? 'app' : `r${level - 1}`}.use('${optionalMountPath}', r${level});`);
  return `${lines.join('\n')}\nmodule.exports = app;\n`;
}

/**
 * 접두사 대안이 많은 라우터 아래에 둘 등록 모양들이다: 정적 경로, 풀지 못한 경로, 문법 밖 경로, 앞부분만 아는 mount,
 * 모르는 mount, 문법 밖 mount, 정적 파일, 조건부 등록, 끝이 열린 use.
 *
 * @param router 등록할 라우터 이름
 * @returns 등록 줄
 */
function mixedLeaf(router: string): readonly string[] {
  return [
    "const sub = express.Router();", "sub.get('/y', (req, res) => res.send('y'));",
    "const other = express.Router();", "other.get('/z', (req, res) => res.send('z'));",
    "const odd = express.Router();", "odd.get('/w', (req, res) => res.send('w'));",
    `${router}.get('/x', (req, res) => res.send('x'));`,
    `${router}.get(process.env.P, (req, res) => res.send('p'));`,
    `${router}.get('/files/*', (req, res) => res.send('f'));`,
    `${router}.use('/p/' + process.env.Q, sub);`,
    `${router}.use(process.env.M, other);`,
    `${router}.use('/q(', odd);`,
    `${router}.use(express.static('pub'));`,
    `if (process.env.C) ${router}.get('/c', (req, res) => res.send('c'));`,
    `${router}.use((req, res) => { res.send('end'); });`,
  ];
}

/**
 * 사실을 (method, 앵커, channel, dynamic, dynamicScope 접두사 수, 순서)로 줄인다. 스코프가 커서 원문 대신 크기를 본다.
 *
 * @param document 문서
 * @returns 줄인 사실(정렬)
 */
function factShapes(document: NodeDocumentView): string[] {
  return document.facts.map((fact) => {
    const scope = fact.dynamicScope?.['templatePrefixes'] as readonly string[] | undefined;
    return `${fact.method} ${fact.pathAnchor} ${fact.channel} ${fact.dynamic ? 'dynamic' : 'static'} scope:${scope?.length ?? '-'} #${fact.order?.index ?? '-'}`;
  }).sort();
}

/**
 * 한계의 스코프 크기를 (접두사 수, 접미사 수)로 줄인다.
 *
 * @param document 문서
 * @param prefix 한계 문장 머리
 * @returns 한계마다 스코프 크기(스코프가 없으면 '-')
 */
function scopeSizes(document: NodeDocumentView, prefix: string): string[] {
  return limitationsWith(document, prefix).map(({ scope }) => (scope === undefined ? '-'
    : `${(scope['templatePrefixes'] as unknown[] | undefined)?.length ?? 0}/${(scope['templateSuffixes'] as unknown[] | undefined)?.length ?? 0}`));
}

test('mount 접두사 대안 곱이 상한 안이면 모두 늘어놓아 dynamicScope와 한계 스코프를 싣는다', async () => {
  // 16 × 16 = 256개다. 펼친 템플릿이 16개를 넘어 상한 초과 dynamic이지만, 접두사 256개는 스코프 상한 안이다.
  const document = await scanNodeProject({ 'package.json': packageJson({ express: '5.1.0' }), 'src/app.js': optionalMountChain(2, mixedLeaf) });
  const head = optionalMountHead.repeat(2);
  assert.deepEqual(factShapes(document), [
    `ANY root ${head}/ dynamic scope:256 #6`,
    'GET base /z static scope:- #4',
    `GET root ${head}/files/* dynamic scope:256 #2`,
    `GET root ${head}/p/{dynamic}/y dynamic scope:256 #3`,
    `GET root ${head}/x dynamic scope:256 #0`,
    `GET root ${head}/{dynamic}/w dynamic scope:256 #5`,
    `GET root ${head}{dynamic} dynamic scope:256 #1`,
  ]);
  assert.equal(limitationsWith(document, 'route-template-expansion-capped: 3 route path(s)').length, 1);
  assert.deepEqual(scopeSizes(document, 'route-coverage: 6 route declaration(s) have paths'), ['1024/0']);
  assert.deepEqual(scopeSizes(document, 'route-coverage: 1 route registration(s) run only under a condition'), ['256/0']);
  assert.deepEqual(scopeSizes(document, 'framework-provided-routes: 1 registration(s) of static files'), ['256/0']);
  assert.deepEqual(scopeSizes(document, 'unresolved-route-prefix: 1 route declaration(s)'), ['0/1']);
});

test('mount 접두사 대안 곱이 상한(2,000)을 넘으면 늘어놓지 않고 같은 사실·분류에 스코프만 생략한다', async () => {
  // 256 × 16 = 4,096개다. 예전에도 dynamicScope(1,000)·한계 스코프(2,000) 상한을 넘어 생략된 크기라 사실·한계 문장은 같다.
  // 정적 파일 한계만 접두사 4,096개를 늘어놓던 스코프 대신 문서 전체 효과가 된다(안전한 쪽).
  const document = await scanNodeProject({ 'package.json': packageJson({ express: '5.1.0' }), 'src/app.js': optionalMountChain(3, mixedLeaf) });
  const head = optionalMountHead.repeat(3);
  assert.deepEqual(factShapes(document), [
    `ANY root ${head}/ dynamic scope:- #6`,
    'GET base /z static scope:- #4',
    `GET root ${head}/files/* dynamic scope:- #2`,
    `GET root ${head}/p/{dynamic}/y dynamic scope:- #3`,
    `GET root ${head}/x dynamic scope:- #0`,
    `GET root ${head}/{dynamic}/w dynamic scope:- #5`,
    `GET root ${head}{dynamic} dynamic scope:- #1`,
  ]);
  assert.equal(limitationsWith(document, 'route-template-expansion-capped: 3 route path(s)').length, 1);
  assert.deepEqual(scopeSizes(document, 'route-coverage: 6 route declaration(s) have paths'), ['-']);
  assert.deepEqual(scopeSizes(document, 'route-coverage: 1 route registration(s) run only under a condition'), ['-']);
  assert.deepEqual(scopeSizes(document, 'framework-provided-routes: 1 registration(s) of static files'), ['-']);
  assert.deepEqual(scopeSizes(document, 'unresolved-route-prefix: 1 route declaration(s)'), ['0/1']);
});

test('mount 접두사 대안이 단계마다 16배로 느는 6단 체인도 대안을 곱하지 않고 상한 초과 dynamic 하나로 끝난다', async () => {
  // 예전에는 대안 16^6개를 만들다 V8 힙이 바닥나(종료 134) 문서를 내지 못했다. 회귀가 생겨도 테스트 프로세스가 아니라
  // 이 검사만 실패하도록 시간·메모리를 감시하는 자식 프로세스로 돌린다.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-express-variants-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), packageJson({ express: '5.1.0' }));
    writeFileSync(join(root, 'src/app.js'), optionalMountChain(6, (router) => [`${router}.get('/x', (req, res) => res.send('x'));`]));
    const result = await runMainGuarded(['routes', '--role', 'server', '--project', root]);
    assert.equal(result.stopped, undefined);
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout) as NodeDocumentView;
    assert.deepEqual(factLines(document), [`GET root ${optionalMountHead.repeat(6)}/x - dynamic #0 ci`]);
    assert.equal(limitationsWith(document, 'route-template-expansion-capped: 1 route path(s)').length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('선택 그룹이 수만 겹인 경로 한 줄이 있어도 그 라우트만 상한 초과 dynamic이고 다른 라우트를 잃지 않는다', async () => {
  // 예전에는 path-to-regexp 8 파서가 `{`마다 재귀해 8,000겹 안팎에서 호출 스택을 넘었고, routes 문서 전체가 실패해
  // `/ok`까지 잃었다.
  const depth = 20_000;
  const document = await scanNodeProject({
    'package.json': packageJson({ express: '5.1.0' }),
    'src/app.js': [
      "const express = require('express');",
      'const app = express();',
      `app.get('/${'{'.repeat(depth)}a${'}'.repeat(depth)}', (req, res) => res.send('deep'));`,
      "app.get('/ok', (req, res) => res.send('ok'));",
      'module.exports = app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document).map((line) => line.replace(/^GET root \/\{+ /u, 'GET root <nested> ')), [
    'GET root /ok optional #1 ci',
    'GET root <nested> - dynamic{"templatePrefixes":["/"]} #0 ci',
  ]);
  assert.equal(limitationsWith(document, 'route-template-expansion-capped: 1 route path(s)').length, 1);
});
