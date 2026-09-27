import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalizeLiteral, percentEncode } from './percent-encoding.ts';

test('unreserved·sub-delims·콜론·@는 그대로 둔다', () => {
  assert.equal(canonicalizeLiteral("Az09-._~!$&'()*+,;=:@"), "Az09-._~!$&'()*+,;=:@");
});

test('unreserved를 가리키는 %XX는 디코드하고 나머지는 대문자 hex로 쓴다', () => {
  assert.equal(canonicalizeLiteral('%41%7e%2f%2F%7b'), 'A~%2F%2F%7B');
});

test('hex 두 자리가 없는 %는 리터럴 퍼센트로 인코딩한다', () => {
  assert.equal(canonicalizeLiteral('100%'), '100%25');
  assert.equal(canonicalizeLiteral('%zz%4'), '%25zz%254');
});

test('pchar 밖 문자는 UTF-8 바이트별로 인코딩한다', () => {
  assert.equal(canonicalizeLiteral('a b'), 'a%20b');
  assert.equal(canonicalizeLiteral('café'), 'caf%C3%A9');
  assert.equal(canonicalizeLiteral('{x}'), '%7Bx%7D');
  assert.equal(canonicalizeLiteral('😀'), '%F0%9F%98%80');
  assert.equal(percentEncode('\u0001'), '%01');
});
