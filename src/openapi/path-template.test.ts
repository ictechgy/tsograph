import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalizePathTemplate,
  MAX_DYNAMIC_CHANNEL_LENGTH,
  sanitizeDynamicChannel,
  stripQueryAndFragment,
} from './path-template.ts';

/** 정규 템플릿 결과를 기대한다. */
function staticTemplate(raw: string): string {
  const result = canonicalizePathTemplate(raw);
  assert.equal(result.kind, 'static', `expected static for ${raw}`);
  return result.kind === 'static' ? result.template : '';
}

test('세그먼트 전체 파라미터는 이름을 지우고 {}로 쓴다', () => {
  assert.equal(staticTemplate('/users/{id}/posts/{postId}'), '/users/{}/posts/{}');
  assert.equal(staticTemplate('/{}'), '/{}');
});

test('부분 세그먼트 파라미터는 리터럴 골격을 남긴다', () => {
  assert.equal(staticTemplate('/files/{name}.json'), '/files/{}.json');
  assert.equal(staticTemplate('/v{major}'), '/v{}');
  assert.equal(staticTemplate('/{id}.café'), '/{}.caf%C3%A9');
});

test('루트·중복 슬래시·끝 슬래시·대소문자를 보존한다', () => {
  assert.equal(staticTemplate('/'), '/');
  assert.equal(staticTemplate('/Items//x/'), '/Items//x/');
});

test('query와 fragment를 뗀다', () => {
  assert.equal(staticTemplate('/search?q={q}'), '/search');
  assert.equal(staticTemplate('/doc#section'), '/doc');
  assert.equal(stripQueryAndFragment('/a'), '/a');
});

test('한 세그먼트의 파라미터가 둘 이상이면 dynamic이다', () => {
  assert.deepEqual(canonicalizePathTemplate('/reports/{year}-{month}'), {
    kind: 'dynamic',
    channel: '/reports/{year}-{month}',
    reason: 'multi-parameter-segment',
  });
});

test('중괄호가 짝이 맞지 않으면 dynamic이다', () => {
  for (const raw of ['/a/{id', '/a/id}', '/a/{{id}}']) {
    const result = canonicalizePathTemplate(raw);
    assert.equal(result.kind, 'dynamic');
    assert.equal(result.kind === 'dynamic' ? result.reason : '', 'unbalanced-braces');
  }
});

test('짝 없는 서러게이트가 있으면 안전하게 인코딩한 dynamic이다', () => {
  const result = canonicalizePathTemplate('/a/\uD800');
  assert.deepEqual(result, { kind: 'dynamic', channel: '/a/%EF%BF%BD', reason: 'malformed-text' });
});

test('. 또는 ..(%2E 포함) 세그먼트는 dynamic이다', () => {
  for (const raw of ['/a/../b', '/a/./b', '/a/%2E%2e/b', '/..']) {
    const result = canonicalizePathTemplate(raw);
    assert.equal(result.kind === 'dynamic' ? result.reason : result.kind, 'dot-segment', raw);
  }
  assert.equal(staticTemplate('/a/.../b.c'), '/a/.../b.c');
});

test('/로 시작하지 않으면 거부한다', () => {
  assert.deepEqual(canonicalizePathTemplate('users'), { kind: 'rejected' });
  assert.deepEqual(canonicalizePathTemplate('?x=/y'), { kind: 'rejected' });
});

test('dynamic 원문은 제어 문자를 인코딩하고 길이 상한에서 %XX를 끊지 않는다', () => {
  assert.equal(sanitizeDynamicChannel('/a b/\u0007{x}'), '/a%20b/%07{x}');
  const long = sanitizeDynamicChannel(`/${'a'.repeat(MAX_DYNAMIC_CHANNEL_LENGTH - 2)}é`);
  assert.equal(long, `/${'a'.repeat(MAX_DYNAMIC_CHANNEL_LENGTH - 2)}`);
  const exact = sanitizeDynamicChannel(`/${'b'.repeat(MAX_DYNAMIC_CHANNEL_LENGTH * 2)}`);
  assert.equal(exact.length, MAX_DYNAMIC_CHANNEL_LENGTH);
});
