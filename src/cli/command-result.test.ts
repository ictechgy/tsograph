import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inputFailure, success, usageFailure } from './command-result.ts';

test('결과 생성기는 종료 코드 계약을 지킨다', () => {
  assert.deepEqual(success('ok\n'), { standardOutput: 'ok\n', standardError: '', exitCode: 0 });
  assert.equal(usageFailure('usage\n').exitCode, 64);
  assert.equal(usageFailure('usage\n').standardError, 'usage\n');
});

test('입력 실패는 도구 이름을 붙이고 개행을 한 번만 둔다', () => {
  assert.equal(inputFailure('bad input').standardError, 'tsograph: bad input\n');
  assert.equal(inputFailure('bad input\n').standardError, 'tsograph: bad input\n');
  assert.equal(inputFailure('x').exitCode, 2);
});
