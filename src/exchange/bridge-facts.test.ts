import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatBridgeTimestamp, isSafeIdentifier } from './bridge-facts.ts';

test('안전한 식별자는 비어 있지 않고 제어·구분 문자·짝 없는 서러게이트가 없다', () => {
  assert.equal(isSafeIdentifier('orders-api'), true);
  assert.equal(isSafeIdentifier('/Users/한글/프로젝트'), true);
  for (const unsafe of ['', 'a\u0000', 'a\u001F', 'a\u007F', 'a\u0085', 'a\u009F', 'a ', 'a ', 'a\uD800']) {
    assert.equal(isSafeIdentifier(unsafe), false, JSON.stringify(unsafe));
  }
});

test('시각은 밀리초 세 자리 UTC로 정규화한다', () => {
  assert.equal(formatBridgeTimestamp(new Date('2026-09-27T09:00:00+09:00')), '2026-09-27T00:00:00.000Z');
});
