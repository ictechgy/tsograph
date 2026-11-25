/**
 * Fastify 어댑터의 해석·펼치기 규칙을 합성 임시 프로젝트로 검사한다(오라클 fixture가 덮지 않는 분기).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ambientTypesFreeConfig } from '../../cli/testing.test.ts';
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

test('buildRoutePrefix는 fastify 5 lib/plugin-override.js·4 lib/pluginOverride.js와 같다', () => {
  const literal = (text: string) => ({ kind: 'literal', text }) as const;
  const partial = (head: string) => ({ kind: 'partial', head }) as const;
  // 두 주 버전이 같은 결과를 내는 이음은 주 버전을 몰라도 같다.
  for (const grammar of [4, 5, undefined] as const) {
    assert.deepEqual(buildRoutePrefix(literal(''), literal('admin'), grammar), literal('/admin'));
    assert.deepEqual(buildRoutePrefix(literal('/a/'), literal('/b'), grammar), literal('/a/b'));
    assert.deepEqual(buildRoutePrefix(literal('/a'), literal('/b'), grammar), literal('/a/b'));
    assert.deepEqual(buildRoutePrefix(literal('/a'), undefined, grammar), literal('/a'));
    assert.deepEqual(buildRoutePrefix(literal('/a'), { kind: 'unknown' }, grammar), partial('/a'));
    assert.deepEqual(buildRoutePrefix(literal('/a'), partial('b'), grammar), partial('/a/b'));
    // 앞부분이 비면 첫 글자를 몰라 두 규칙 모두 부모(`/`로 끝나지 않으면 `/`까지)만 확정한다.
    assert.deepEqual(buildRoutePrefix(literal('/a/'), partial(''), grammar), partial('/a/'));
    assert.deepEqual(buildRoutePrefix(literal('/a'), partial(''), grammar), partial('/a/'));
  }
  // 부모가 `/`로 끝나고 플러그인 접두사가 `/` 아닌 글자로 시작하면 5는 `/`를 더하지 않고 4는 더한다
  // (fastify 5.12.5·4.29.1에 실제로 등록해 `/v1/bare/y`·`/v1//bare/y`를 확인했다). 주 버전을 모르면 부모까지만 안다.
  assert.deepEqual(buildRoutePrefix(literal('/v1/'), literal('bare'), 5), literal('/v1/bare'));
  assert.deepEqual(buildRoutePrefix(literal('/v1/'), literal('bare'), 4), literal('/v1//bare'));
  assert.deepEqual(buildRoutePrefix(literal('/v1/'), literal('bare'), undefined), partial('/v1/'));
  assert.deepEqual(buildRoutePrefix(literal('/v1/'), partial('b'), 5), partial('/v1/b'));
  assert.deepEqual(buildRoutePrefix(literal('/v1/'), partial('b'), 4), partial('/v1//b'));
  assert.deepEqual(buildRoutePrefix(literal('/v1/'), partial('b'), undefined), partial('/v1/'));
});

test('타입으로만 아는 FastifyInstance 아래 register 접두사는 base 뒤의 꼬리로 잇는다', async () => {
  // fastify-cli 형태(붙는 위치를 모르는 플러그인)다. 실제 fastify 5.12.5·4.29.1에 바깥 접두사 ''·'/api'로 붙여 보면 users 플러그인은
  // `<바깥>/users`·`<바깥>/users/`·`<바깥>/users/:id`로 등록된다. 예전에는 base 아래 접두사를 모두 버려 `/`·`/{}` base로 냈다.
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0', '@fastify/static': '8.0.0', 'fastify-plugin': '5.0.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import type { FastifyInstance } from 'fastify';",
      "import fastifyStatic from '@fastify/static';",
      "import fp from 'fastify-plugin';",
      "import users from './users.ts';",
      "const shared = fp(async (s: any) => { s.get('/shared', async () => 's'); });",
      'export default async function app(f: FastifyInstance) {',
      "  f.get('/health', async () => 'h');",
      "  f.register(users, { prefix: '/users' });",
      "  f.register(async (c) => { c.get('/x', async () => 'x'); }, { prefix: 'bare' });",
      "  f.register(async (v) => {",
      "    v.register(async (u) => { u.get('/', { prefixTrailingSlash: 'no-slash' }, async () => 'n'); u.get('/x', async () => 'x'); }, { prefix: '/users' });",
      "  }, { prefix: '/v1/' });",
      "  f.register(async (c) => { c.register(async (d) => { d.get('/z', async () => 'z'); }, { prefix: '/inner' }); }, { prefix: process.env.P });",
      "  f.register(shared, { prefix: '/ignored' });",
      "  f.register(fastifyStatic, { root: '/tmp', prefix: '/public' });",
      '}',
    ].join('\n'),
    'src/users.ts': "export default async function users(f: any) {\n  f.get('/', async () => 'u');\n  f.get('/:id', async () => 'i');\n}\n",
  });
  assert.deepEqual(factLines(document), [
    'GET base /health -',
    'GET base /users -',
    'GET base /users/ -',
    'GET base /users/{} -',
    'GET base /bare/x -',
    'GET base /v1/users -',
    'GET base /v1/users/x -',
    // 모르는 접두사(process.env.P)는 알 수 없는 base에 합치고 그 뒤 리터럴 접두사는 남긴다.
    'GET base /inner/z -',
    'GET base /shared -',
  ].sort());
  // base 뒤 경로는 root 기준 접두사로 상한을 잡을 수 없어 스코프가 없다.
  assert.deepEqual(limitationsWith(document, 'framework-provided-routes:').map((entry) => entry.scope), [undefined]);
});

test('부모 접두사가 /로 끝나면 플러그인 접두사 이음은 fastify 주 버전을 따르고 모르면 dynamic이다', async () => {
  const files = (fastify: string): Record<string, string> => ({
    'package.json': packageJson({ fastify }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      'const app = Fastify();',
      "app.register(async (v) => {",
      "  v.register(async (b) => { b.get('/y', async () => 'y'); }, { prefix: 'bare' });",
      "  v.register(async (u) => { u.get('/x', async () => 'x'); }, { prefix: '/users' });",
      "}, { prefix: '/v1/' });",
      'export default app;',
    ].join('\n'),
  });
  // fastify 4.29.1·5.12.5에 실제로 등록한 경로와 같다. 두 주 버전이 같은 `/v1/users/x`는 주 버전을 몰라도 정적 사실이다.
  assert.deepEqual(factLines(await scanNodeProject(files('4.28.1'))), ['GET root /v1//bare/y strict', 'GET root /v1/users/x strict']);
  assert.deepEqual(factLines(await scanNodeProject(files('5.2.0'))), ['GET root /v1/bare/y strict', 'GET root /v1/users/x strict']);
  const unknown = await scanNodeProject(files('*'));
  assert.deepEqual(factLines(unknown), ['GET root /v1/users/x strict', 'GET root /v1/{dynamic} - dynamic{"templatePrefixes":["/v1"]}']);
  assert.equal(limitationsWith(unknown, 'route-framework-version-unknown:').length, 1);
  // ignoreDuplicateSlashes면 두 주 버전 모두 겹친 `/`를 줄여 `/v1/bare/y`가 받는다(실제 실행으로 확인).
  const collapsed = files('*');
  collapsed['src/app.ts'] = collapsed['src/app.ts']!.replace('Fastify()', 'Fastify({ ignoreDuplicateSlashes: true })');
  assert.deepEqual(factLines(await scanNodeProject(collapsed)), ['GET root /v1/bare/y strict', 'GET root /v1/users/x strict']);
});

test('빈 값 변형으로 펼친 템플릿이 16개를 넘으면 대안 하나든 여럿의 합이든 상한 초과 dynamic이다', async () => {
  // find-my-way 파라미터는 빈 값도 받는다. `/:a/:b/:c/:d/:e`는 대안 하나가 32개로, `/x/:a/:b/:c/:d?`는 대안 둘이 16 + 8개로 넘는다.
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.0.0' }),
    // 저장소 @types/node를 읽지 않는 설정이다(검사와 무관한 Program 비용).
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': "import Fastify from 'fastify';\nconst app = Fastify();\napp.get('/:a/:b/:c/:d/:e', async () => 'one');\napp.get('/x/:a/:b/:c/:d?', async () => 'two');\napp.get('/y/:a/:b/:c?', async () => 'ok');\nexport default app;\n",
  });
  const capped = document.facts.filter((fact) => fact.dynamic).map((fact) => `${fact.channel} ${JSON.stringify(fact.dynamicScope ?? null)}`);
  assert.deepEqual(capped.sort(), ['/:a/:b/:c/:d/:e {"templatePrefixes":["/{}/{}/{}/{}/{}"]}', '/x/:a/:b/:c/:d%3F {"templatePrefixes":["/x/{}/{}/{}","/x/{}/{}/{}/{}"]}']);
  assert.equal(document.facts.filter((fact) => !fact.dynamic && fact.channel.startsWith('/y/')).length, 12);
  assert.equal(limitationsWith(document, 'route-template-expansion-capped: 2 route path(s)').length, 1);
});
