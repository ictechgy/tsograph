import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Resolved } from './next-config.ts';
import { type ChannelPolicy, channelFor, dynamicChannel, normalizeBasePath } from './route-channel.ts';

/** 확정 값이다. */
function known<T>(value: T): Resolved<T> {
  return { kind: 'known', value };
}

/** 경로 규칙을 만든다. */
function policy(overrides: Partial<ChannelPolicy> = {}): ChannelPolicy {
  return {
    basePath: '',
    pathAnchor: 'root',
    trailingSlash: known(false),
    skipTrailingSlashRedirect: known(false),
    ...overrides,
  };
}

/** channel과 끝 슬래시 규칙만 줄인다. */
function shape(segments: string[], rules: ChannelPolicy): string {
  const result = channelFor(segments, rules);
  return `${result.channel} ${result.trailingSlash ?? 'unknown'}${result.dynamic ? ' dynamic' : ''}`;
}

test('basePath 정규화는 Next 검증 규칙을 따른다', () => {
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/docs'), '/docs');
  assert.equal(normalizeBasePath('/문서/v1'), '/%EB%AC%B8%EC%84%9C/v1');
  for (const invalid of ['/', 'docs', '/docs/', '/a?b', '/a#b', '/a//b', '/./a', '/a/..', '/\uD800']) {
    assert.equal(normalizeBasePath(invalid), undefined, invalid);
  }
});

test('trailingSlash false(기본): 끝 슬래시 없는 형태가 정규이고 strict다', () => {
  assert.equal(shape([], policy()), '/ strict');
  assert.equal(shape(['api', 'items'], policy()), '/api/items strict');
  assert.equal(shape([], policy({ basePath: '/docs' })), '/docs strict');
});

test('trailingSlash true: 점 없는 마지막 세그먼트는 슬래시를 붙이고 파일 모양은 뗀다', () => {
  const rules = policy({ trailingSlash: known(true) });
  assert.equal(shape(['api', 'items'], rules), '/api/items/ strict');
  assert.equal(shape(['feed.xml'], rules), '/feed.xml strict');
  assert.equal(shape(['a.'], rules), '/a. optional');
  assert.equal(shape(['api', '{}'], rules), '/api/{} unknown');
  assert.equal(shape(['files', '{**}'], rules), '/files/{**} unknown');
  assert.equal(shape(['.well-known', 'x'], rules), '/.well-known/x optional');
  assert.equal(shape([], rules), '/ strict');
  assert.equal(shape([], { ...rules, basePath: '/docs' }), '/docs/ strict');
});

test('skipTrailingSlashRedirect true면 두 형태가 모두 닿아 optional이다', () => {
  assert.equal(shape(['api'], policy({ skipTrailingSlashRedirect: known(true), trailingSlash: { kind: 'unknown' } })), '/api optional');
  assert.equal(shape(['api'], policy({ skipTrailingSlashRedirect: known(true), trailingSlash: known(true) })), '/api optional');
});

test('설정을 모르면 끝 슬래시 규칙을 생략한다', () => {
  assert.equal(shape(['api'], policy({ trailingSlash: { kind: 'unknown' } })), '/api unknown');
  assert.equal(shape(['api'], policy({ skipTrailingSlashRedirect: { kind: 'unknown' } })), '/api unknown');
});

test('길이 상한을 넘는 템플릿과 원문 경로는 dynamic이다', () => {
  const long = channelFor(['x'.repeat(2100)], policy({ pathAnchor: 'base' }));
  assert.equal(long.dynamic, true);
  assert.equal(long.pathAnchor, 'base');
  assert.ok(long.channel.length <= 2048);
  assert.deepEqual(dynamicChannel('/api/v[id]', 'root'), { channel: '/api/v%5Bid%5D', dynamic: true, pathAnchor: 'root', trailingSlash: undefined });
});
