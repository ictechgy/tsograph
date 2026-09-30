/**
 * Node 백엔드 경로 문법 변환표다. 각 사례는 공식 패키지 소스(npm 레지스트리에서 받은 해당 버전)로 확인한 규칙이고,
 * `source`에 파일·함수를 적는다. 모양은 isthmus 공유 벡터(`framework.*`, `producer:<이름>`)와 같게 두어 나중에
 * `producer:tsograph` 사례로 올릴 수 있게 한다. 기대값은 사실로 펼친 템플릿 목록(0세그먼트 접두사는 `+prefix`)이거나
 * `dynamic <접두사>`다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isCanonicalTemplate } from '../../exchange/route-template-grammar.ts';
import { compileExpress4Path } from './express4-path.ts';
import { compileFindMyWayPath } from './fmw-path.ts';
import { compileHonoPath, honoMergePath, honoOptionalPaths } from './hono-path.ts';
import { convertLegacyRoute } from './nest-routes.ts';
import { type CompiledPath, expandVariant, prefixTemplates } from './path-model.ts';
import { compilePte6Path } from './pte6-path.ts';
import { compilePte8Path } from './pte8-path.ts';

/** 변환 사례다. */
interface GrammarCase {
  readonly id: string;
  readonly provenance: 'verified-source' | 'verified-run';
  readonly source: string;
  readonly path: string;
  readonly expect: string;
}

/**
 * 컴파일 결과를 비교용 문자열로 줄인다.
 *
 * @param compiled 컴파일 결과
 * @returns 템플릿 목록(`,` 구분, 정렬) 또는 `dynamic <접두사>`
 */
function render(compiled: CompiledPath): string {
  if (compiled.kind === 'dynamic') return `dynamic ${prefixTemplates(compiled.prefixes ?? []).join(',')}`.trim();
  const templates = compiled.variants.flatMap((variant) => expandVariant(variant) ?? []).map((entry) => {
    const constraint = entry.constraints.filter((item) => item.kind !== 'path').map((item) => `${item.segment}:${item.kind}`).join(' ');
    return `${entry.channel}${entry.catchAllPrefix ? '+prefix' : ''}${constraint === '' ? '' : `[${constraint}]`}`;
  });
  return [...new Set(templates)].sort().join(',');
}

/**
 * 사례 표를 검사한다.
 *
 * @param cases 사례
 * @param compile 컴파일 함수
 */
function check(cases: readonly GrammarCase[], compile: (path: string) => CompiledPath): void {
  const failures = cases.filter((entry) => render(compile(entry.path)) !== entry.expect).map((entry) => `${entry.id}: ${render(compile(entry.path))}`);
  assert.deepEqual(failures, []);
  for (const entry of cases) {
    const compiled = compile(entry.path);
    if (compiled.kind === 'variants') compiled.variants.flatMap((variant) => expandVariant(variant) ?? []).forEach((template) => assert.ok(isCanonicalTemplate(template.channel), template.channel));
  }
}

/** Hono 4.13.12 사례다. */
const honoCases: readonly GrammarCase[] = [
  { id: 'hono/param', provenance: 'verified-run', source: 'hono/dist/router/trie-router/node.js#search (matcher === true)', path: '/users/:id', expect: '/users/{}' },
  { id: 'hono/regex-int', provenance: 'verified-run', source: 'hono/dist/utils/url.js#getPattern', path: '/books/:id{[0-9]+}', expect: '/books/{}[1:int]' },
  { id: 'hono/regex-slug', provenance: 'verified-source', source: 'hono/dist/utils/url.js#getPattern', path: '/tags/:tag{[a-z0-9-]+}', expect: '/tags/{}[1:slug]' },
  { id: 'hono/regex-other', provenance: 'verified-source', source: 'hono/dist/utils/url.js#getPattern', path: '/v/:code{[A-Z]{2}\\.x}', expect: '/v/{}[1:regex]' },
  { id: 'hono/regex-rest', provenance: 'verified-source', source: 'hono/dist/router/trie-router/node.js#search (restPathString)', path: '/assets/:rest{.+}', expect: '/assets/{**}' },
  { id: 'hono/regex-slash', provenance: 'verified-source', source: 'hono/dist/router/reg-exp-router/node.js#insert (PATH_ERROR for .*)', path: '/x/:v{.*}', expect: 'dynamic /x' },
  { id: 'hono/tail-wildcard', provenance: 'verified-run', source: 'hono/dist/router/reg-exp-router/node.js (TAIL_WILDCARD (?:|/.*))', path: '/files/*', expect: '/files+prefix,/files/,/files/{**}' },
  { id: 'hono/root-wildcard', provenance: 'verified-source', source: 'hono/dist/router/reg-exp-router/router.js#add (path === "/*")', path: '*', expect: '/+prefix,/{**}' },
  { id: 'hono/partial-wildcard', provenance: 'verified-source', source: 'reg-exp-router .* vs trie-router prefix match disagree', path: '/api*', expect: 'dynamic /' },
  { id: 'hono/middle-wildcard', provenance: 'verified-run', source: 'hono/quick·tiny differ on empty segments for a middle *', path: '/a/*/b', expect: 'dynamic /a' },
  { id: 'hono/optional', provenance: 'verified-run', source: 'hono/dist/utils/url.js#checkOptionalParameter', path: '/authors/:name?', expect: '/authors,/authors/{}' },
  { id: 'hono/literal-colon', provenance: 'verified-run', source: 'reg-exp-router treats /file-:id as static; mixed with params the routers differ', path: '/file-:id', expect: 'dynamic /' },
  { id: 'hono/trailing-slash', provenance: 'verified-run', source: 'hono/dist/hono-base.js (strict getPath)', path: '/users/', expect: '/users/' },
  { id: 'hono/dot-segment', provenance: 'verified-source', source: 'clients normalize dot segments', path: '/a/../b', expect: 'dynamic /a' },
  { id: 'hono/whole-segment-param-name', provenance: 'verified-source', source: 'hono/dist/utils/url.js#getPattern (/^\\:([^\\{\\}]+)/)', path: '/files/:name.json', expect: '/files/{}' },
  { id: 'hono/unbalanced-brace', provenance: 'verified-source', source: 'hono/dist/utils/url.js#extractGroupsFromPath', path: '/a/:b{x', expect: 'dynamic /a' },
];

/** Express 4.22.3(path-to-regexp 0.1.13) 사례다(strict 꺼짐). */
const express4Cases: readonly GrammarCase[] = [
  { id: 'express4/param', provenance: 'verified-run', source: 'path-to-regexp@0.1.13/index.js (([^/]+?))', path: '/users/:id', expect: '/users/{}' },
  { id: 'express4/param-regex', provenance: 'verified-run', source: 'path-to-regexp@0.1.13/index.js (capture)', path: '/orders/:id(\\d+)', expect: '/orders/{}[1:int]' },
  { id: 'express4/optional', provenance: 'verified-run', source: 'path-to-regexp@0.1.13/index.js ((?:/x)?)', path: '/pages/:page?', expect: '/pages,/pages/{}' },
  { id: 'express4/star', provenance: 'verified-run', source: 'path-to-regexp@0.1.13/index.js (* → (.*))', path: '/raw/*', expect: '/raw/,/raw/{**}' },
  { id: 'express4/root-star', provenance: 'verified-source', source: 'express/lib/router/layer.js (fast_star)', path: '*', expect: '/+prefix,/{**}' },
  { id: 'express4/partial', provenance: 'verified-run', source: 'path-to-regexp@0.1.13/index.js (backtrack)', path: '/img-:id', expect: '/img-{}' },
  { id: 'express4/format', provenance: 'verified-source', source: 'path-to-regexp@0.1.13/index.js (format \\.)', path: '/file.:ext', expect: '/file.{}' },
  { id: 'express4/two-params', provenance: 'verified-run', source: 'two parameters in one segment', path: '/:name.:ext', expect: 'dynamic /' },
  { id: 'express4/repeat', provenance: 'verified-source', source: 'path-to-regexp@0.1.13/index.js (star ((?:[/].+?)?))', path: '/docs/:path*', expect: '/docs/{**}' },
  { id: 'express4/repeat-optional', provenance: 'verified-source', source: 'path-to-regexp@0.1.13/index.js (star + optional)', path: '/docs/:path*?', expect: '/docs+prefix,/docs/{**}' },
  { id: 'express4/regex-operator', provenance: 'verified-source', source: 'path-to-regexp@0.1.13/index.js (other characters stay regex source)', path: '/ab?cd', expect: 'dynamic /' },
  { id: 'express4/group', provenance: 'verified-source', source: 'path-to-regexp@0.1.13/index.js (/( → /(?:)', path: '/api/(v1|v2)/x', expect: 'dynamic /api' },
  { id: 'express4/escape', provenance: 'verified-source', source: 'path-to-regexp@0.1.13/index.js (\\\\. kept)', path: '/a\\.b', expect: '/a.b' },
  { id: 'express4/trailing-slash-loose', provenance: 'verified-run', source: 'path-to-regexp@0.1.13/index.js (strict false → /?)', path: '/users/', expect: '/users' },
  { id: 'express4/no-leading-slash', provenance: 'verified-source', source: 'a path without / never matches a pathname', path: 'users', expect: 'dynamic' },
];

/** Express 5.2.1(router 2.2.0, path-to-regexp 8.4.2) 사례다(loosen). */
const pte8Cases: readonly GrammarCase[] = [
  { id: 'express5/param', provenance: 'verified-run', source: 'path-to-regexp@8.4.2/dist/index.js#toRegExpSource', path: '/products/:id', expect: '/products/{}' },
  { id: 'express5/wildcard', provenance: 'verified-run', source: 'path-to-regexp@8.4.2 (wildcard ([^]+))', path: '/files/*path', expect: '/files/{**}' },
  { id: 'express5/group', provenance: 'verified-run', source: 'path-to-regexp@8.4.2#flatten', path: '/list{/:page}', expect: '/list,/list/{}' },
  { id: 'express5/group-wildcard', provenance: 'verified-source', source: 'path-to-regexp@8.4.2#flatten', path: '/files{/*path}', expect: '/files,/files/{**}' },
  { id: 'express5/partial', provenance: 'verified-run', source: 'path-to-regexp@8.4.2#toRegExpSource', path: '/export.:format', expect: '/export.{}' },
  { id: 'express5/two-params', provenance: 'verified-source', source: 'path-to-regexp@8.4.2 (hasSegmentCapture)', path: '/:a-:b', expect: 'dynamic /' },
  { id: 'express5/reserved', provenance: 'verified-source', source: 'path-to-regexp@8.4.2#parse (PathError)', path: '/a(b)', expect: 'dynamic /' },
  { id: 'express5/wildcard-partial', provenance: 'verified-source', source: 'wildcard after text in a segment', path: '/files/x*rest', expect: 'dynamic /files' },
  { id: 'express5/wildcard-middle', provenance: 'verified-source', source: 'wildcard not last', path: '/*splat/x', expect: 'dynamic /' },
  { id: 'express5/quoted', provenance: 'verified-source', source: 'path-to-regexp@8.4.2#parse (quoted names)', path: '/:"quoted name"', expect: '/{}' },
  { id: 'express5/escape', provenance: 'verified-source', source: 'path-to-regexp@8.4.2#parse (\\\\)', path: '/a\\:b', expect: '/a:b' },
  { id: 'express5/loosen', provenance: 'verified-run', source: 'router@2.2.0/lib/layer.js#loosen', path: '/users/', expect: '/users' },
  { id: 'express5/empty', provenance: 'verified-source', source: 'path-to-regexp@8.4.2 (empty path)', path: '', expect: '/' },
  { id: 'express5/unterminated-quote', provenance: 'verified-source', source: 'path-to-regexp@8.4.2#parse', path: '/:"x', expect: 'dynamic /' },
];

/** path-to-regexp 6.3.0(@koa/router 13.1.1) 사례다. */
const pte6Cases: readonly GrammarCase[] = [
  { id: 'koa13/param', provenance: 'verified-source', source: 'path-to-regexp@6.3.0/dist/index.js#parse', path: '/users/:id', expect: '/users/{}' },
  { id: 'koa13/optional', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#tokensToRegexp (modifier ?)', path: '/users/:id?', expect: '/users,/users/{}' },
  { id: 'koa13/repeat-zero', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#tokensToRegexp (modifier *)', path: '/files/:path*', expect: '/files+prefix,/files/{**}' },
  { id: 'koa13/repeat-one', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#tokensToRegexp (modifier +)', path: '/files/:path+', expect: '/files/{**}' },
  { id: 'koa13/regex', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#lexer (PATTERN)', path: '/users/:id(\\d+)', expect: '/users/{}[1:int]' },
  { id: 'koa13/format', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#parse (prefixes "./")', path: '/file.:ext', expect: '/file.{}' },
  { id: 'koa13/partial', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#parse (safePattern)', path: '/file-:id', expect: '/file-{}' },
  { id: 'koa13/group', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#parse (OPEN)', path: '/a/{b}', expect: 'dynamic /a' },
  { id: 'koa13/bare-modifier', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#parse (mustConsume END throws)', path: '/files/*', expect: 'dynamic /files' },
  { id: 'koa13/unnamed', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#parse (unnamed PATTERN)', path: '/(\\d+)', expect: '/{}[0:int]' },
  { id: 'koa13/capture-group', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#lexer (capturing groups not allowed)', path: '/a/:b((x))', expect: 'dynamic /a' },
  { id: 'koa13/trailing-slash', provenance: 'verified-source', source: 'path-to-regexp@6.3.0#tokensToRegexp (delimiter optional after)', path: '/users/', expect: '/users/' },
];

/** find-my-way 9.9.0(Fastify 5.12.5)·8.2.2(Fastify 4.29.1) 사례다. */
const fmwCases: readonly GrammarCase[] = [
  { id: 'fmw/param-empty', provenance: 'verified-run', source: 'find-my-way/index.js#find (parametric param may be empty)', path: '/users/:id', expect: '/users/,/users/{}' },
  { id: 'fmw/regex', provenance: 'verified-run', source: 'find-my-way/index.js#_on (trimRegExpStartAndEnd)', path: '/re/:id(^\\d+$)', expect: '/re/{}[1:int]' },
  { id: 'fmw/wildcard', provenance: 'verified-run', source: 'find-my-way/lib/node.js (WildcardNode)', path: '/files/*', expect: '/files/,/files/{**}' },
  { id: 'fmw/root-wildcard', provenance: 'verified-source', source: 'find-my-way/index.js#_on (pattern "*")', path: '*', expect: '/+prefix,/{**}' },
  { id: 'fmw/optional', provenance: 'verified-run', source: 'find-my-way/index.js#on (OPTIONAL_PARAM_REGEXP)', path: '/opt/:page?', expect: '/opt,/opt/,/opt/{}' },
  { id: 'fmw/optional-not-last', provenance: 'verified-source', source: 'find-my-way/index.js#on (assert last)', path: '/a/:b?/c', expect: 'dynamic /a' },
  { id: 'fmw/multi-param', provenance: 'verified-run', source: 'find-my-way/index.js#_on (regex node)', path: '/range/:from-:to', expect: 'dynamic /range' },
  { id: 'fmw/static-suffix', provenance: 'verified-run', source: 'find-my-way/index.js#_on (static part after param)', path: '/report.:format', expect: '/report.,/report.{}' },
  { id: 'fmw/double-colon', provenance: 'verified-source', source: 'find-my-way/index.js#_on (:: literal)', path: '/a::b', expect: '/a:b' },
  { id: 'fmw/partial-wildcard', provenance: 'verified-source', source: 'find-my-way wildcard after static text', path: '/files*', expect: 'dynamic /' },
  { id: 'fmw/percent', provenance: 'verified-source', source: 'find-my-way/index.js#_on (% → %25)', path: '/100%', expect: '/100%25' },
];

/** find-my-way `ignoreTrailingSlash` 사례다. */
const fmwTrailingCases: readonly GrammarCase[] = [
  { id: 'fmw-ignore-slash/route', provenance: 'verified-run', source: 'find-my-way/index.js#on (trimLastSlash)', path: '/users/', expect: '/users' },
  { id: 'fmw-ignore-slash/no-empty-tail', provenance: 'verified-run', source: 'find-my-way/index.js#find (trimLastSlash before lookup)', path: '/items/:id', expect: '/items/{}' },
];

test('Hono 변환표(hono@4.13.12)를 통과한다', () => check(honoCases, compileHonoPath));
test('Express 4 변환표(path-to-regexp@0.1.13)를 통과한다', () => check(express4Cases, (path) => compileExpress4Path(path, false)));
test('Express 5 변환표(path-to-regexp@8.4.2, router loosen)를 통과한다', () => check(pte8Cases, (path) => compilePte8Path(path, true)));
test('@koa/router 13 변환표(path-to-regexp@6.3.0)를 통과한다', () => check(pte6Cases, compilePte6Path));
test('find-my-way 변환표를 통과한다', () => check(fmwCases, (path) => compileFindMyWayPath(path, { ignoreTrailingSlash: false, ignoreDuplicateSlashes: false })));
test('find-my-way ignoreTrailingSlash 변환표를 통과한다', () => check(fmwTrailingCases, (path) => compileFindMyWayPath(path, { ignoreTrailingSlash: true, ignoreDuplicateSlashes: true })));

test('Express strict와 @koa/router는 끝 슬래시를 떼지 않는다', () => {
  assert.equal(render(compileExpress4Path('/users/', true)), '/users/');
  assert.equal(render(compilePte8Path('/users/', false)), '/users/');
  assert.equal(render(compileFindMyWayPath('/a//b', { ignoreTrailingSlash: false, ignoreDuplicateSlashes: true })), '/a/b');
});

test('Hono mergePath·checkOptionalParameter는 원본과 같다(hono/dist/utils/url.js)', () => {
  assert.equal(honoMergePath('/api', '/'), '/api');
  assert.equal(honoMergePath('/api/', '/'), '/api/');
  assert.equal(honoMergePath('/', '/users'), '/users');
  assert.equal(honoMergePath('/api', ''), '/api/');
  assert.equal(honoMergePath('api', 'x'), '/api/x');
  assert.deepEqual(honoOptionalPaths('/:a?/:b?'), ['/', '/:a', '/:a/:b']);
  assert.deepEqual(honoOptionalPaths('/x/:a'), ['/x/:a']);
  // 끝 `?` 세그먼트에 `:`가 없으면 원본도 빈 배열을 돌려 라우트가 등록되지 않는다.
  assert.deepEqual(honoOptionalPaths('/x/:a/y?'), []);
  assert.equal(render(compileHonoPath('/x/:a/y?')), '');
});

test('NestJS LegacyRouteConverter(@nestjs/core@12.1.2 router/legacy-route-converter.js)를 옮긴다', () => {
  assert.equal(convertLegacyRoute('/users/*'), '/users/{*path}');
  assert.equal(convertLegacyRoute('/users/(.*)'), '/users/{*path}');
  assert.equal(convertLegacyRoute('/a/+'), '/a/*path');
  assert.equal(convertLegacyRoute('/a/*/b/*/c'), '/a/*path2/b/*path6/c');
  assert.equal(convertLegacyRoute('users'), 'users');
});

test('변환표 사례는 모두 확인한 출처를 적는다', () => {
  for (const entry of [...honoCases, ...express4Cases, ...pte8Cases, ...pte6Cases, ...fmwCases, ...fmwTrailingCases]) {
    assert.ok(entry.source.length > 0, entry.id);
  }
});
