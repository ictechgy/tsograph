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
  // 어느 바인딩인지 모르는 대상(호출 결과)에 그 키를 쓰면 증명하지 못한 플러그인 모두가 모르는 값이다.
  const unpinned = commonJs('', "function pick() { return {}; }\npick()[Symbol.for('skip-override')] = true;");
  assert.deepEqual(factLines(await scanNodeProject(unpinned)), [unproven, unproven]);
  // 이름 있는 다른 속성(값이 다른 함수)에 쓴 키는 그 속성의 근거라 등록한 플러그인과 상관없다.
  const registry = commonJs('', "const registry = { plugin: async () => {} };\nregistry.plugin[Symbol.for('skip-override')] = true;");
  assert.deepEqual(factLines(await scanNodeProject(registry)), ['GET root /o/other strict', 'GET root /p/cjs strict']);
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
      "async function andLeft(s: any) { s.get('/and-left', async () => '&'); }",
      'export const checked = andLeft && 0;',
      "async function orLeft(s: any) { s.get('/or-left', async () => '|'); }",
      'export const chosen = orLeft || null;',
      'const app = Fastify();',
      "app.register(one, { prefix: '/p1' });",
      "app.register(text, { prefix: '/p2' });",
      "app.register(zero, { prefix: '/p3' });",
      "app.register(removed, { prefix: '/p4' });",
      "app.register(picked, { prefix: '/p5' });",
      "app.register(assigned, { prefix: '/p6' });",
      "app.register(andLeft, { prefix: '/p7' });",
      "app.register(orLeft, { prefix: '/p8' });",
      'export default app;',
    ].join('\n'),
  });
  const unproven = 'GET root {dynamic} - dynamic{"templatePrefixes":["/"]}';
  // `andLeft && 0`은 0을 돌려줘 함수가 흘러가지 않고, `orLeft || null`은 함수를 돌려준다.
  assert.deepEqual(factLines(document), ['GET root /one strict', 'GET root /p7/and-left strict', 'GET root /text strict', unproven, unproven, unproven, unproven, unproven]);
});

test('해석에서 빼는 테스트 디렉터리 이름이어도 등록한 플러그인 파일의 skip-override 쓰기를 본다', async () => {
  // `routes/test/index.ts`는 테스트 경로 규칙에 걸려 해석 대상에서 빠지지만 서버가 실제로 불러 쓴다. 실제 fastify 4.29.1·5.12.8은 `/ping`.
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': "import Fastify from 'fastify';\nimport testRoutes from './routes/test/index.ts';\nconst app = Fastify();\napp.register(testRoutes, { prefix: '/test' });\nexport default app;\n",
    'src/routes/test/index.ts': "export default async function testRoutes(f: any) { f.get('/ping', async () => 'pong'); }\n(testRoutes as any)[Symbol.for('skip-override')] = true;\n",
  });
  assert.deepEqual(factLines(document), ['GET root /ping strict']);
  // 그 파일이 자기 모듈 객체를 흘려보내도 본다(실제 fastify 4.29.1·5.12.8은 `/ping`: 패키지 함수가 내보낸 플러그인에 심볼을 쓴다).
  const escaped = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.js': "const fastify = require('fastify');\nconst app = fastify();\napp.register(require('./routes/test/index.js').testRoutes, { prefix: '/test' });\nmodule.exports = app;\n",
    'src/routes/test/index.js': "exports.testRoutes = async function (f) { f.get('/ping', async () => 'pong'); };\nrequire('mark-all').markAll(exports);\n",
  });
  assert.deepEqual(factLines(escaped), ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}']);
});

test('const 키·네임스페이스 속성에 쓴 skip-override는 그 속성의 근거이고, 이름으로 잇지 못한 대상은 모든 플러그인의 근거다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 셋 모두 접두사를 무시한다(`/x1`, `/x2`, `/x`).
  const pinned = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import * as P from './plugins.ts';",
      "const SKIP = Symbol.for('skip-override');",
      "const plugins = { users: async (f: any) => { f.get('/x1', async () => 'x'); } };",
      '(plugins.users as any)[SKIP] = true;',
      '(P.items as any)[SKIP] = true;',
      'const app = Fastify();',
      "app.register(plugins.users, { prefix: '/u' });",
      "app.register(P.items, { prefix: '/i' });",
      'export default app;',
    ].join('\n'),
    'src/plugins.ts': "export async function items(f: any) { f.get('/x2', async () => 'x'); }\n",
  });
  assert.deepEqual(factLines(pinned), ['GET root /x1 strict', 'GET root /x2 strict']);
  const loop = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import * as P from './plugins.ts';",
      "import { items } from './plugins.ts';",
      "for (const plugin of Object.values(P)) (plugin as any)[Symbol.for('skip-override')] = true;",
      'const app = Fastify();',
      "app.register(items, { prefix: '/i' });",
      'export default app;',
    ].join('\n'),
    'src/plugins.ts': "export async function items(f: any) { f.get('/x', async () => 'x'); }\n",
  });
  assert.deepEqual(factLines(loop), ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}']);
  // 매개변수에 쓴 키도 그 값이 어디서 오는지 따라가지 않으므로 모든 플러그인의 근거다(모듈 객체가 흘러가지 않아도).
  const parameter = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { items } from './plugins.ts';",
      "function mark(fn: any) { fn[Symbol.for('skip-override')] = true; }",
      'mark(async () => {});',
      'const app = Fastify();',
      "app.register(items, { prefix: '/i' });",
      'export default app;',
    ].join('\n'),
    'src/plugins.ts': "export async function items(f: any) { f.get('/x', async () => 'x'); }\n",
  });
  assert.deepEqual(factLines(parameter), ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}']);
});

test('--include-tests의 테스트 소스는 테스트 밖 등록의 skip-override를 많아야 모르는 값으로 만든다', async () => {
  // 운영 서버는 `/users/:id`를 등록한다(테스트 파일은 실행 경로가 아니다). 테스트 소스의 `fp(users)`는 이름 규칙으로 정한 테스트 파일이라
  // 건너뜀으로 단정하지 않는다.
  const files = {
    'package.json': packageJson({ fastify: '5.2.0', 'fastify-plugin': '5.0.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': "import Fastify from 'fastify';\nimport users from './users.ts';\nconst app = Fastify();\napp.register(users, { prefix: '/users' });\nexport default app;\n",
    'src/users.ts': "export default async function users(f: any) { f.get('/:id', async () => 'u'); }\n",
    'src/users.test.ts': "import fp from 'fastify-plugin';\nimport users from './users.ts';\nexport const exposed = fp(users);\n",
  };
  assert.deepEqual(factLines(await scanNodeProject(files)), ['GET root /users/ strict', 'GET root /users/{} strict']);
  assert.deepEqual(factLines(await scanNodeProject(files, ['--include-tests'])), ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}']);
});

test('프로젝트 함수 매개변수로 넘긴 바인딩은 그 매개변수의 사용을 따라 보고 console 출력은 바꾸지 않는다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 모두 접두사를 붙인다. 등록만 하는 도우미, 두 단계로 넘겨 console.log만 하는 도우미, 자기 자신만 다시 부르는 재귀 도우미는
  // 건너뛰지 않음이고, 매개변수를 저장하거나 `arguments`·나머지 매개변수로 받으면 모른다.
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import users from './users.ts';",
      "async function logged(f: any) { f.get('/logged', async () => 'l'); }",
      "async function walked(f: any) { f.get('/walked', async () => 'w'); }",
      "async function stored(f: any) { f.get('/stored', async () => 's'); }",
      "async function rested(f: any) { f.get('/rested', async () => 'r'); }",
      "async function counted(f: any) { f.get('/counted', async () => 'c'); }",
      'const kept: unknown[] = [];',
      "async function relayed(f: any) { f.get('/relayed', async () => 'd'); }",
      "function mountUsers(app: any, plugin: any) { app.register(plugin, { prefix: '/users' }); }",
      'function look(plugin: any) { console.log(plugin); }',
      'function relay(plugin: any) { look(plugin); }',
      'function visit(plugin: any, depth: number): void { if (depth > 0) visit(plugin, depth - 1); }',
      'function keep(plugin: any) { kept.push(plugin); }',
      'function variadic(...items: unknown[]) { return items.length; }',
      'function tally(plugin: any) { return arguments.length + (plugin ? 1 : 0); }',
      'const app = Fastify();',
      'mountUsers(app, users);',
      'relay(relayed);',
      "app.register(relayed, { prefix: '/relay' });",
      'console.log(logged);',
      'visit(walked, 2);',
      'keep(stored);',
      'variadic(rested);',
      'tally(counted);',
      "app.register(logged, { prefix: '/log' });",
      "app.register(walked, { prefix: '/walk' });",
      "app.register(stored, { prefix: '/store' });",
      "app.register(rested, { prefix: '/rest' });",
      "app.register(counted, { prefix: '/count' });",
      'export default app;',
    ].join('\n'),
    'src/users.ts': "export default async function users(f: any) { f.get('/:id', async () => 'u'); }\n",
  });
  const unproven = 'GET root {dynamic} - dynamic{"templatePrefixes":["/"]}';
  assert.deepEqual(factLines(document), [
    'GET root /log/logged strict', 'GET root /relay/relayed strict', 'GET root /users/ strict', 'GET root /users/{} strict', 'GET root /walk/walked strict',
    unproven, unproven, unproven,
  ].sort());
});

test('require() 모듈 객체가 흘러가면 그 모듈이 내보낸 플러그인을 모르고, 화살표 도우미의 매개변수도 따라간다', async () => {
  const commonJs = (escape: string): Record<string, string> => ({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.js': [
      "const fastify = require('fastify');",
      "const mod = require('./plugins.js');",
      "const local = async (f) => { f.get('/local', async () => 'l'); };",
      'const show = (plugin) => { console.log(plugin); };',
      'show(local);',
      escape,
      'const app = fastify();',
      "app.register(mod.users, { prefix: '/u' });",
      "app.register(local, { prefix: '/l' });",
      'module.exports = app;',
    ].join('\n'),
    'src/plugins.js': "exports.users = async function (f) { f.get('/x', async () => 'x'); };\n",
  });
  const unproven = 'GET root {dynamic} - dynamic{"templatePrefixes":["/"]}';
  // 점 접근만 하면 내보낸 플러그인에 이름 없이 닿지 않는다.
  assert.deepEqual(factLines(await scanNodeProject(commonJs(''))), ['GET root /l/local strict', 'GET root /u/x strict']);
  // 모듈 객체를 넘기거나 원소로 읽으면 그 너머에서 내보낸 함수에 심볼을 쓸 수 있다(같은 파일의 내보내지 않은 함수는 그대로).
  assert.deepEqual(factLines(await scanNodeProject(commonJs('Object.keys(mod);'))), ['GET root /l/local strict', unproven]);
  assert.deepEqual(factLines(await scanNodeProject(commonJs("console.info(require('./plugins.js')[process.env.NAME]);"))), ['GET root /l/local strict', unproven]);
  assert.deepEqual(factLines(await scanNodeProject(commonJs('console.info(mod[process.env.NAME]);'))), ['GET root /l/local strict', unproven]);
});

test('네임스페이스 객체가 흘러가면 내보낸 최상위 선언 안의 플러그인도 모르고, 흘러가지 않으면 그대로다', async () => {
  const files = (escape: string): Record<string, string> => ({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import * as P from './plugins.ts';",
      escape,
      'const app = Fastify();',
      "app.register(P.group.users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
    'src/plugins.ts': "export const group = { users: async (f: any) => { f.get('/x', async () => 'x'); } };\n",
  });
  assert.deepEqual(factLines(await scanNodeProject(files(''))), ['GET root /u/x strict']);
  assert.deepEqual(factLines(await scanNodeProject(files('export const all = Object.values(P);'))), ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}']);
});

test('매개변수를 따라가는 호출은 대상이 정적으로 하나인 함수뿐이고, 다시 대입한 바인딩·재정의할 수 있는 메서드는 모른다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 다시 대입한 `let`·함수 선언(구조 분해 대입 포함)과 재정의한 메서드 모두 접두사를 무시한다(`/x`): 실제로 부르는 함수가
  // 받은 플러그인을 패키지 함수에 넘겨 심볼을 쓴다. 정적 선언만 보면 `p.name`만 읽는 함수라 건너뛰지 않음으로 잘못 단정한다.
  const files = (body: readonly string[]): Record<string, string> => ({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { markAll } from 'mark-all';",
      "async function users(f: any) { f.get('/x', async () => 'x'); }",
      ...body,
      'const app = Fastify();',
      "app.register(users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
  });
  const unproven = ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}'];
  const reassignedLet = ['let prepare = (p: any) => p.name;', 'prepare = (p: any) => { markAll({ p }); };', 'prepare(users);'];
  assert.deepEqual(factLines(await scanNodeProject(files(reassignedLet))), unproven);
  const overridden = [
    'class Base { prepare(p: any) { return p.name; } }',
    'class Marking extends Base { prepare(p: any) { markAll({ p }); } }',
    'const helper: Base = new Marking();',
    'helper.prepare(users);',
  ];
  assert.deepEqual(factLines(await scanNodeProject(files(overridden))), unproven);
  const reassignedFunction = ['function prepare(p: any) { return p.name; }', '(prepare as any) = (p: any) => { markAll({ p }); };', 'prepare(users);'];
  assert.deepEqual(factLines(await scanNodeProject(files(reassignedFunction))), unproven);
  const destructured = ['function prepare(p: any) { return p.name; }', '[prepare] = [(p: any) => { markAll({ p }); }] as any;', 'prepare(users);'];
  assert.deepEqual(factLines(await scanNodeProject(files(destructured))), unproven);
  // 다시 대입하지 않는 `const` 화살표 함수·함수 선언은 그 매개변수의 사용을 따라간다(실제 fastify: `/u/x`).
  assert.deepEqual(factLines(await scanNodeProject(files(['const prepare = (p: any) => p.name;', 'prepare(users);']))), ['GET root /u/x strict']);
  assert.deepEqual(factLines(await scanNodeProject(files(['function prepare(p: any) { return p.name; }', 'prepare(users);']))), ['GET root /u/x strict']);
});

test('모듈 객체가 흘러가면 다시 내보낸 이름(export *·export { a } from·네임스페이스 재내보내기)을 따라 그 플러그인을 모른다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 흘러간 넷 모두 접두사를 무시한다(`/x`): 패키지 함수가 모듈 객체의 값마다 심볼을 쓴다.
  const files = (app: readonly string[]): Record<string, string> => ({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/users.ts': "export async function users(f: any) { f.get('/x', async () => 'x'); }\n",
    'src/barrel.ts': "export * from './users.ts';\n",
    'src/named.ts': "export { users } from './users.ts';\n",
    'src/reexp.ts': "import * as P from './users.ts';\nexport { P };\n",
    'src/nested.ts': "export * as R from './users.ts';\n",
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { markAll } from 'mark-all';",
      "import { users } from './users.ts';",
      ...app,
      'const app = Fastify();',
      "app.register(users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
  });
  const unproven = ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}'];
  assert.deepEqual(factLines(await scanNodeProject(files(["import * as plugins from './barrel.ts';", 'markAll(plugins);']))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(files(["import * as plugins from './named.ts';", 'markAll(plugins);']))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(files(["import { P } from './reexp.ts';", 'markAll(P);']))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(files(["import { P as Plugins } from './reexp.ts';", 'markAll(Plugins);']))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(files(["import * as All from './nested.ts';", 'markAll(All.R);']))), unproven);
  // 점 접근으로만 읽으면 흘러가지 않는다(실제 fastify: `/u/x`).
  assert.deepEqual(factLines(await scanNodeProject(files(["import * as plugins from './barrel.ts';", 'console.log(plugins.users === users);']))), ['GET root /u/x strict']);
});

test('CommonJS에서 내보내기에 대입한 모듈 객체는 흘러간 것으로 본다', async () => {
  // `exports.P = require('./users.js')`는 TypeScript가 모듈 별칭으로 잇지 않아, 받는 쪽에서 `P`가 모듈 객체인지 모른다. 그래서 모듈 객체를
  // 내보내는 대입 자체를 흘러감으로 본다(실제 fastify 4.29.1·5.12.8은 `markAll(P)`면 `/x`, 넘기지 않으면 `/u/x` — 뒤의 것은 건전하지만 덜 정밀하다).
  const files = (reexported: string, escape: string): Record<string, string> => ({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/users.js': "exports.users = async function (f) { f.get('/x', async () => 'x'); };\n",
    'src/reexp.js': `exports.P = ${reexported};\n`,
    'src/app.js': [
      "const fastify = require('fastify');",
      "const { markAll } = require('mark-all');",
      "const { P } = require('./reexp.js');",
      "const { users } = require('./users.js');",
      escape,
      'const app = fastify();',
      "app.register(users, { prefix: '/u' });",
      'module.exports = app;',
    ].join('\n'),
  });
  const unproven = ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}'];
  assert.deepEqual(factLines(await scanNodeProject(files("require('./users.js')", 'markAll(P);'))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(files("require('./users.js')", ''))), unproven);
  // JS 파일의 `const { a } = require()`는 이름마다 그 내보내기의 별칭이라 흘러가지 않는다(실제 fastify: `/u/x`).
  assert.deepEqual(factLines(await scanNodeProject(files('{}', 'markAll(P);'))), ['GET root /u/x strict']);
});

test('운영 코드가 불러오는 테스트 디렉터리 파일의 skip-override 쓰기는 많아야 모르는 값으로 센다', async () => {
  // `setup/test/mark.ts`는 테스트 경로 규칙에 걸려 해석 대상에서 빠지지만 운영 코드가 부수 효과로 불러 실행한다. 실제 fastify
  // 4.29.1·5.12.8은 `/x`. 테스트 파일만 불러오면 서버 실행 경로가 아니다(`/u/x`).
  const files = (importer: string): Record<string, string> => ({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/users.ts': "export default async function users(f: any) { f.get('/x', async () => 'x'); }\n",
    'src/setup/test/mark.ts': "import users from '../../users.ts';\n(users as any)[Symbol.for('skip-override')] = true;\n",
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import users from './users.ts';",
      importer === 'app' ? "import './setup/test/mark.ts';" : '',
      'const app = Fastify();',
      "app.register(users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
    'src/app.test.ts': importer === 'test' ? "import './setup/test/mark.ts';\n" : 'export {};\n',
  });
  assert.deepEqual(factLines(await scanNodeProject(files('app'))), ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}']);
  assert.deepEqual(factLines(await scanNodeProject(files('test'))), ['GET root /u/x strict']);
  assert.deepEqual(factLines(await scanNodeProject(files('none'))), ['GET root /u/x strict']);
});

test('TS 네임스페이스·import().then·TS 파일의 require()·CommonJS 모듈 객체가 흘러가도 그 플러그인을 모른다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 `import().then`·CommonJS `mount`가 `/x`다(TS 네임스페이스·TS 파일 require도 같은 값이 패키지 함수에 닿는다).
  const base = { 'package.json': packageJson({ fastify: '5.2.0' }), 'tsconfig.json': ambientTypesFreeConfig };
  const unproven = ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}'];
  const esm = (escape: readonly string[]): Record<string, string> => ({
    ...base,
    'src/users.ts': "export async function users(f: any) { f.get('/x', async () => 'x'); }\n",
    'src/nested.ts': "export * as R from './users.ts';\n",
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { markAll } from 'mark-all';",
      "import { users } from './users.ts';",
      ...escape,
      'const app = Fastify();',
      "app.register(users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(await scanNodeProject(esm(["await import('./users.ts').then((m) => markAll(m));"]))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(esm(['declare const require: any;', "const mod = require('./users.ts');", 'markAll(mod);']))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(esm(["import mod = require('./users.ts');", 'markAll(mod);']))), unproven);
  // 다시 내보낸 네임스페이스 안까지 걷는 함수인지 모른다(값을 한 겹만 보는 함수면 실제는 `/u/x`).
  assert.deepEqual(factLines(await scanNodeProject(esm(["import * as All from './nested.ts';", 'markAll(All);']))), unproven);
  const namespace = await scanNodeProject({
    ...base,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { markAll } from 'mark-all';",
      "namespace Plugins { export async function users(f: any) { f.get('/x', async () => 'x'); } }",
      'markAll(Plugins);',
      'const app = Fastify();',
      "app.register(Plugins.users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(namespace), unproven);
  // CommonJS `module.exports.users = users`는 TypeScript가 그 함수의 별칭으로 묶는다.
  const commonJs = (escape: string): Record<string, string> => ({
    ...base,
    'src/plugins.js': "async function users(f) { f.get('/x', async () => 'x'); }\nmodule.exports.users = users;\nmodule.exports.mount = (app) => { app.register(users, { prefix: '/u' }); };\n",
    'src/app.js': ["const fastify = require('fastify');", "const { markAll } = require('mark-all');", "const mod = require('./plugins.js');", escape, 'const app = fastify();', 'mod.mount(app);', 'module.exports = app;'].join('\n'),
  });
  assert.deepEqual(factLines(await scanNodeProject(commonJs('markAll(mod);'))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(commonJs(''))), ['GET root /u/x strict']);
  // 모듈 파일이 자기 `module.exports` 객체를 넘겨도 같다.
  const self = commonJs('');
  self['src/plugins.js'] += "require('mark-all').markAll(module.exports);\n";
  assert.deepEqual(factLines(await scanNodeProject(self)), unproven);
});

test('따라간 const 별칭이 흘러간 모듈 객체로 내보내지면 그 근거도 플러그인의 것이다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 `/x`다: `markAll(P)`가 `P.handle`(= users)에 심볼을 쓴다. 점 접근으로만 읽으면 `/u/x`.
  const base = { 'package.json': packageJson({ fastify: '5.2.0' }), 'tsconfig.json': ambientTypesFreeConfig };
  const unproven = ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}'];
  const aliased = (escape: string): Record<string, string> => ({
    ...base,
    'src/plugins.ts': [
      "import type { FastifyInstance } from 'fastify';",
      "async function users(f: any) { f.get('/x', async () => 'x'); }",
      'export const handle = users;',
      "export function mount(app: FastifyInstance) { app.register(users, { prefix: '/u' }); }",
    ].join('\n'),
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { markAll } from 'mark-all';",
      "import * as P from './plugins.ts';",
      "import { mount } from './plugins.ts';",
      escape,
      'const app = Fastify();',
      'mount(app);',
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(await scanNodeProject(aliased('markAll(P);'))), unproven);
  assert.deepEqual(factLines(await scanNodeProject(aliased('console.log(P.handle === P.handle);'))), ['GET root /u/x strict']);
});

test('태그 붙은 템플릿의 보간은 태그 함수의 인자라 플러그인을 흘려보내고, 태그 없는 템플릿은 그대로다', async () => {
  // 실제 fastify 4.29.1·5.12.8은 태그 붙은 쪽이 `/x`다(태그 함수가 보간한 함수를 그대로 받는다).
  const base = { 'package.json': packageJson({ fastify: '5.2.0' }), 'tsconfig.json': ambientTypesFreeConfig };
  const unproven = ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}'];
  const template = (use: string): Record<string, string> => ({
    ...base,
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { tag } from 'mark-all';",
      "async function users(f: any) { f.get('/x', async () => 'x'); }",
      use,
      'const app = Fastify();',
      "app.register(users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(await scanNodeProject(template('tag`${users}`;'))), unproven);
  // 태그 없는 템플릿은 문자열로 바꾸기만 한다(실제 fastify: `/u/x`).
  assert.deepEqual(factLines(await scanNodeProject(template('console.log(`${users}`);'))), ['GET root /u/x strict']);
});

test('TS 파일에서 CommonJS 내보내기에 대입한 바인딩은 흘러간 것으로 본다', async () => {
  // TypeScript는 TS 파일의 `exports.handle = users`를 내보내기로 묶지 않아, 그 모듈 객체가 흘러가도 이 바인딩에 닿는 길을 모른다. 실제 fastify
  // 4.29.1·5.12.8은 `markAll(require('./re'))`면 `/x`다(`.cts`로 실행해 확인). 넘기지 않아도 dynamic인 것은 건전하지만 덜 정밀하다.
  const document = await scanNodeProject({
    'package.json': packageJson({ fastify: '5.2.0' }),
    'tsconfig.json': ambientTypesFreeConfig,
    'src/users.ts': "export async function users(f: any) { f.get('/x', async () => 'x'); }\n",
    'src/re.ts': "import { users } from './users.ts';\ndeclare const exports: any;\nexports.handle = users;\n",
    'src/app.ts': [
      "import Fastify from 'fastify';",
      "import { markAll } from 'mark-all';",
      "import { users } from './users.ts';",
      'declare const require: any;',
      "markAll(require('./re.ts'));",
      'const app = Fastify();',
      "app.register(users, { prefix: '/u' });",
      'export default app;',
    ].join('\n'),
  });
  assert.deepEqual(factLines(document), ['GET root {dynamic} - dynamic{"templatePrefixes":["/"]}']);
});
