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

test('routerOptions의 라우터 옵션은 fastify 5만 읽고 주 버전을 모르면 두 값이 같을 때만 쓴다', async () => {
  // fastify 4.29.1은 routerOptions를 모르고 최상위 값만 쓴다(실제로 `/v1//bare/y`·`/v1/a//b`를 등록하고 `/v1/bare/y`는 404).
  // fastify 5.12.8은 routerOptions를 먼저 보고 없으면 최상위 값을 쓴다(최상위 값은 두 주 버전이 같다).
  const slashes = (fastify: string, options: string): Record<string, string> => ({
    'package.json': packageJson({ fastify }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      `const app = Fastify(${options});`,
      'app.register(async (v) => {',
      "  v.get('/', async () => 'r');",
      "  v.get('/a//b', async () => 'ab');",
      "  v.register(async (b) => { b.get('/y', async () => 'y'); b.get('/', async () => 'b'); }, { prefix: 'bare' });",
      "}, { prefix: '/v1/' });",
      'export default app;',
    ].join('\n'),
  });
  const routerOptions = '{ routerOptions: { ignoreDuplicateSlashes: true } }';
  const topLevel = '{ ignoreDuplicateSlashes: true }';
  const collapsed = ['GET root /v1/ strict', 'GET root /v1/a/b strict', 'GET root /v1/bare strict', 'GET root /v1/bare/ strict', 'GET root /v1/bare/y strict'];
  assert.deepEqual(factLines(await scanNodeProject(slashes('4.28.1', routerOptions))), [
    'GET root /v1// strict', 'GET root /v1//bare strict', 'GET root /v1//bare/ strict', 'GET root /v1//bare/y strict', 'GET root /v1/ strict', 'GET root /v1/a//b strict',
  ].sort());
  assert.deepEqual(factLines(await scanNodeProject(slashes('5.2.0', routerOptions))), collapsed);
  assert.deepEqual(factLines(await scanNodeProject(slashes('*', routerOptions))), [
    'GET root /v1// strict', 'GET root /v1/ strict', 'GET root /v1/a//b strict',
    'GET root /v1/{dynamic} - dynamic{"templatePrefixes":["/v1"]}', 'GET root /v1/{dynamic} - dynamic{"templatePrefixes":["/v1"]}',
  ].sort());
  for (const fastify of ['4.28.1', '5.2.0', '*']) assert.deepEqual(factLines(await scanNodeProject(slashes(fastify, topLevel))), collapsed, fastify);

  const flags = (fastify: string, options: string): Record<string, string> => ({
    'package.json': packageJson({ fastify }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': `import Fastify from 'fastify';\nconst app = Fastify(${options});\napp.get('/Mixed', async () => 'm');\napp.register(async (u) => { u.get('/', async () => 'u'); }, { prefix: '/users' });\nexport default app;\n`,
  });
  const routerFlags = '{ routerOptions: { caseSensitive: false, ignoreTrailingSlash: true } }';
  const loose = ['GET root /Mixed optional ci', 'GET root /users optional ci'];
  assert.deepEqual(factLines(await scanNodeProject(flags('4.28.1', routerFlags))), ['GET root /Mixed strict', 'GET root /users strict', 'GET root /users/ strict']);
  assert.deepEqual(factLines(await scanNodeProject(flags('5.2.0', routerFlags))), loose);
  assert.deepEqual(factLines(await scanNodeProject(flags('*', routerFlags))), ['GET root /Mixed -', 'GET root /users -', 'GET root /users/ -']);
  for (const fastify of ['4.28.1', '5.2.0', '*']) {
    assert.deepEqual(factLines(await scanNodeProject(flags(fastify, '{ caseSensitive: false, ignoreTrailingSlash: true }'))), loose, fastify);
  }
});

test('skip-override 심볼을 쓴 플러그인은 접두사를 무시하고, 건너뛰는지 증명하지 못하면 접두사를 모르는 값으로 본다', async () => {
  // fastify 4.29.1·5.12.8은 `fn[Symbol.for('skip-override')]`가 참이면 새 인스턴스를 만들지 않아 prefix를 무시한다(실행으로 확인:
  // `/manual`, `/keyed`, `/marked`, `/imported`가 접두사 없이 등록된다). fastify-plugin은 받은 함수에 그 심볼을 쓴다.
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0', 'fastify-plugin': '5.0.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import fp from 'fastify-plugin';",
      "import imported from './imported.ts';",
      "import plug from './renamed.ts';",
      "(plug as any)[Symbol.for('skip-override')] = true;",
      "const SKIP = Symbol.for('skip-override');",
      "const manual = async (s: any) => { s.get('/manual', async () => 'm'); };",
      "(manual as any)[Symbol.for('skip-override')] = true;",
      "async function keyed(s: any) { s.get('/keyed', async () => 'k'); }",
      '(keyed as any)[SKIP] = true;',
      "const marked = async (s: any) => { s.get('/marked', async () => 'f'); };",
      'fp(marked);',
      'const alias = keyed;',
      "async function viaAlias(s: any) { s.get('/via-alias', async () => 'v'); }",
      'const aliasWritten = viaAlias;',
      "(aliasWritten as any)[Symbol.for('skip-override')] = true;",
      "async function plain(s: any) { s.get('/plain', async () => 'p'); }",
      "(plain as any).autoPrefix = '/x';",
      "(plain as any)['meta'] = { name: 'plain' };",
      "(plain as any)[Symbol.for('plugin-meta')] = { name: 'plain' };",
      "const escaped = async (s: any) => { s.get('/escaped', async () => 'e'); };",
      'remember(escaped);',
      'function remember(fn: unknown) { return fn; }',
      "const conditional = async (s: any) => { s.get('/conditional', async () => 'c'); };",
      "if (process.env.SKIP) (conditional as any)[Symbol.for('skip-override')] = true;",
      "async function stored(s: any) { s.get('/stored', async () => 's'); }",
      'export const registry = { stored };',
      'const app = Fastify();',
      "app.register(manual, { prefix: '/p1' });",
      "app.register(alias, { prefix: '/p2' });",
      "app.register(marked, { prefix: '/p3' });",
      "app.register(imported, { prefix: '/p4' });",
      "app.register(plain, { prefix: '/p5' });",
      "app.register(plain, { prefix: '/p5b' });",
      "app.register(escaped, { prefix: '/p6' });",
      "app.register(conditional, { prefix: '/p7' });",
      "app.register(stored, { prefix: '/p8' });",
      "app.register(plug, { prefix: '/p9' });",
      "app.register(aliasWritten, { prefix: '/p10' });",
      'export default app;',
    ].join('\n'),
    'src/imported.ts': "export default async function imported(s: any) { s.get('/imported', async () => 'i'); }\n(imported as any)[Symbol.for('skip-override')] = true;\n",
    // 다른 이름으로 가져온 바인딩에 쓴 심볼도 같은 함수의 것이다.
    'src/renamed.ts': "export default async function renamedSource(s: any) { s.get('/renamed', async () => 'r'); }\n",
  });
  const unproven = 'GET root {dynamic} - dynamic{"templatePrefixes":["/"]}';
  assert.deepEqual(factLines(document), [
    'GET root /imported strict', 'GET root /keyed strict', 'GET root /manual strict', 'GET root /marked strict',
    'GET root /p5/plain strict', 'GET root /p5b/plain strict', 'GET root /renamed strict', 'GET root /via-alias strict', unproven, unproven, unproven,
  ].sort());
});

test('타입으로만 아는 루트 아래 skip-override 플러그인은 base에 붙고, 함수 안의 쓰기는 접두사를 base에 합친다', async () => {
  // 실제 fastify 4.29.1·5.12.8에 바깥 접두사 ''·'/api'로 붙이면 `<바깥>/manual`·`<바깥>/top`·`<바깥>/p3/kept`가 등록된다.
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import type { FastifyInstance } from 'fastify';",
      "const top = async (s: any) => { s.get('/top', async () => 't'); };",
      "(top as any)[Symbol.for('skip-override')] = true;",
      'export default async function app(f: FastifyInstance) {',
      "  const manual = async (s: any) => { s.get('/manual', async () => 'm'); };",
      "  (manual as any)[Symbol.for('skip-override')] = true;",
      "  f.register(manual, { prefix: '/p2' });",
      "  f.register(top, { prefix: '/p1' });",
      "  f.register(async (s: any) => { s.get('/kept', async () => 'k'); }, { prefix: '/p3' });",
      '}',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document), ['GET base /manual -', 'GET base /p3/kept -', 'GET base /top -']);
});

test('CommonJS module.exports에 쓴 skip-override와 이름으로 풀 수 없는 대상의 쓰기를 본다', async () => {
  const commonJs = (pluginTail: string, extra = ''): Record<string, string> => ({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.js': [
      "const fastify = require('fastify');",
      "const plugin = require('./plugin.js');",
      "const other = async (s) => { s.get('/other', async () => 'o'); };",
      extra,
      'const app = fastify();',
      "app.register(plugin, { prefix: '/p' });",
      "app.register(other, { prefix: '/o' });",
      'module.exports = app;',
    ].join('\n'),
    'src/plugin.js': `module.exports = async function (s) { s.get('/cjs', async () => 'c'); };\n${pluginTail}\n`,
  });
  const unproven = 'GET root {dynamic} - dynamic{"templatePrefixes":["/"]}';
  assert.deepEqual(factLines(await scanNodeProject(commonJs("module.exports[Symbol.for('skip-override')] = true;"))), ['GET root /cjs strict', 'GET root /o/other strict']);
  assert.deepEqual(factLines(await scanNodeProject(commonJs('module.exports[process.env.KEY] = true;'))), ['GET root /o/other strict', unproven]);
  assert.deepEqual(factLines(await scanNodeProject(commonJs("module.exports['meta'] = true;"))), ['GET root /o/other strict', 'GET root /p/cjs strict']);
  // 어느 바인딩인지 모르는 대상에 그 키를 쓰면 증명하지 못한 플러그인 모두가 모르는 값이다.
  const registry = commonJs('', "const registry = { plugin: async () => {} };\nregistry.plugin[Symbol.for('skip-override')] = true;");
  assert.deepEqual(factLines(await scanNodeProject(registry)), [unproven, unproven]);
});

test('skip-override에 쓴 값의 참·거짓, delete, 다른 변수로 흘러간 바인딩을 구별한다', async () => {
  // 실제 fastify 4.29.1·5.12.8: `= 1`·`= 'yes'`는 접두사를 무시하고(`/one`, `/text`), `= 0`과 쓴 뒤 `delete`는 붙인다(`/p3/zero`,
  // `/p4/removed`). 뒤의 둘은 건너뛰지 않는다고 증명하지 않으므로(값·순서 판정) 접두사를 모르는 값으로 본다.
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "const one = async (s: any) => { s.get('/one', async () => '1'); };",
      "(one as any)[Symbol.for('skip-override')] = 1;",
      "const text = async (s: any) => { s.get('/text', async () => 't'); };",
      "(text as any)[Symbol.for('skip-override')] = 'yes';",
      "const zero = async (s: any) => { s.get('/zero', async () => '0'); };",
      "(zero as any)[Symbol.for('skip-override')] = 0;",
      "const removed = async (s: any) => { s.get('/removed', async () => 'r'); };",
      "(removed as any)[Symbol.for('skip-override')] = true;",
      "delete (removed as any)[Symbol.for('skip-override')];",
      "const picked = async (s: any) => { s.get('/picked', async () => 'p'); };",
      'export const fallback = process.env.X ?? picked;',
      "const assigned = async (s: any) => { s.get('/assigned', async () => 'a'); };",
      'let holder: unknown;',
      'holder = assigned;',
      'const app = Fastify();',
      "app.register(one, { prefix: '/p1' });",
      "app.register(text, { prefix: '/p2' });",
      "app.register(zero, { prefix: '/p3' });",
      "app.register(removed, { prefix: '/p4' });",
      "app.register(picked, { prefix: '/p5' });",
      "app.register(assigned, { prefix: '/p6' });",
      'export default app;',
    ].join('\n'),
  });
  const unproven = 'GET root {dynamic} - dynamic{"templatePrefixes":["/"]}';
  assert.deepEqual(factLines(document), ['GET root /one strict', 'GET root /text strict', unproven, unproven, unproven, unproven]);
});
