import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareStrings, encodeSortedJson } from './sorted-json.ts';

test('모든 깊이의 객체 키를 코드 단위 순서로 정렬하고 배열 순서는 보존한다', () => {
  const encoded = encodeSortedJson({ b: 1, a: [{ z: 1, y: null }, 2], B: 'x' });
  assert.equal(encoded, '{\n  "B": "x",\n  "a": [\n    {\n      "y": null,\n      "z": 1\n    },\n    2\n  ],\n  "b": 1\n}\n');
});

test('문자열 비교는 locale과 무관하다', () => {
  assert.equal(compareStrings('a', 'b'), -1);
  assert.equal(compareStrings('b', 'a'), 1);
  assert.equal(compareStrings('é', 'é'), 0);
  assert.equal(compareStrings('Z', 'a'), -1);
});
