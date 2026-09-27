import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifySegment, joinTemplate, toRoutePath } from './next-path.ts';

test('App Router 폴더 규칙: 비공개·group·slot·intercepting', () => {
  assert.deepEqual(classifySegment('_lib', 'app'), { kind: 'private' });
  assert.deepEqual(classifySegment('(marketing)', 'app'), { kind: 'omitted' });
  assert.deepEqual(classifySegment('@modal', 'app'), { kind: 'unmodeled' });
  for (const marker of ['(.)photo', '(..)photo', '(..)(..)photo', '(...)photo', '(.)']) {
    assert.deepEqual(classifySegment(marker, 'app'), { kind: 'unmodeled' }, marker);
  }
});

test('Pages Router에는 App Router 폴더 규칙이 없다', () => {
  assert.deepEqual(classifySegment('_lib', 'pages'), { kind: 'static', literal: '_lib' });
  assert.deepEqual(classifySegment('(group)', 'pages'), { kind: 'static', literal: '(group)' });
  assert.deepEqual(classifySegment('@x', 'pages'), { kind: 'static', literal: '@x' });
});

test('동적 세그먼트는 세그먼트 전체일 때만이고 Next가 거부하는 이름은 invalid다', () => {
  assert.deepEqual(classifySegment('[id]', 'app'), { kind: 'param', name: 'id' });
  assert.deepEqual(classifySegment('[...slug]', 'app'), { kind: 'catch-all', name: 'slug', optional: false });
  assert.deepEqual(classifySegment('[[...slug]]', 'pages'), { kind: 'catch-all', name: 'slug', optional: true });
  for (const invalid of ['[[id]]', '[]', '[...]', '[.x]', '[....x]', '[…x]', '[a][b]', '[[...x]', '[...x]]', '[[x]']) {
    assert.deepEqual(classifySegment(invalid, 'app'), { kind: 'invalid' }, invalid);
  }
  for (const partial of ['v[id]', '[id].json', 'a]b', 'x[']) {
    assert.deepEqual(classifySegment(partial, 'app'), { kind: 'partial' }, partial);
  }
});

test('정적 세그먼트는 정규 리터럴로 인코딩한다', () => {
  assert.deepEqual(classifySegment('café', 'app'), { kind: 'static', literal: 'caf%C3%A9' });
  assert.deepEqual(classifySegment('%5Fprivate', 'app'), { kind: 'static', literal: '_private' });
  assert.deepEqual(classifySegment('a b{c}', 'pages'), { kind: 'static', literal: 'a%20b%7Bc%7D' });
});

test('경로 변환: group 생략, catch-all, optional catch-all', () => {
  assert.deepEqual(toRoutePath([], 'app'), { kind: 'template', segments: [], optionalCatchAll: false });
  assert.deepEqual(toRoutePath(['(shop)', 'api', '[id]'], 'app'), { kind: 'template', segments: ['api', '{}'], optionalCatchAll: false });
  assert.deepEqual(toRoutePath(['files', '[...path]'], 'app'), { kind: 'template', segments: ['files', '{**}'], optionalCatchAll: false });
  assert.deepEqual(toRoutePath(['docs', '[[...slug]]', '(g)'], 'app'), { kind: 'template', segments: ['docs', '{**}'], optionalCatchAll: true });
});

test('경로 변환: 막는 분류는 비공개 > 거부 > 미모델링 순서다', () => {
  assert.deepEqual(toRoutePath(['_x', '[[id]]', '@s'], 'app'), { kind: 'private' });
  assert.deepEqual(toRoutePath(['[[id]]', '@s'], 'app'), { kind: 'invalid' });
  assert.deepEqual(toRoutePath(['@s', 'api'], 'app'), { kind: 'unmodeled' });
});

test('경로 변환: 끝이 아닌 catch-all과 겹치는 이름은 invalid, 부분 세그먼트는 dynamic이다', () => {
  assert.deepEqual(toRoutePath(['[...a]', 'x'], 'app'), { kind: 'invalid' });
  assert.deepEqual(toRoutePath(['[id]', 'x', '[id]'], 'pages'), { kind: 'invalid' });
  assert.deepEqual(toRoutePath(['[a-b]', '[ab]'], 'pages'), { kind: 'invalid' });
  assert.deepEqual(toRoutePath(['api', 'v[version]'], 'app'), { kind: 'dynamic', raw: '/api/v[version]' });
});

test('basePath 결합: 루트 라우트는 basePath 자체다', () => {
  assert.equal(joinTemplate('', []), '/');
  assert.equal(joinTemplate('/docs', []), '/docs');
  assert.equal(joinTemplate('', ['api', '{}']), '/api/{}');
  assert.equal(joinTemplate('/docs', ['api']), '/docs/api');
});
