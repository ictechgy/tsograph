import assert from 'node:assert/strict';
import { test } from 'node:test';

import { inputFailure, isStackExhaustion, stackExhaustionFailure, success, usageFailure } from './command-result.ts';

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

/**
 * 끝없이 재귀해 엔진이 실제로 던지는 스택 초과 예외를 얻는다.
 *
 * @returns 잡은 예외
 */
function realStackOverflow(): unknown {
  const descend = (depth: number): number => descend(depth + 1) + 1;
  try {
    return descend(0);
  } catch (error) {
    return error;
  }
}

test('호출 스택 초과만 분석 스택 초과로 분류하고 다른 RangeError·오류는 분류하지 않는다', () => {
  assert.equal(isStackExhaustion(realStackOverflow()), true);
  assert.equal(isStackExhaustion(new RangeError('Maximum call stack size exceeded')), true);
  for (const other of [
    new RangeError('Invalid string length'),
    new RangeError('Map maximum size exceeded'),
    new RangeError('Invalid time value'),
    new Error('Maximum call stack size exceeded'),
    'Maximum call stack size exceeded',
    undefined,
  ]) {
    assert.equal(isStackExhaustion(other), false, String(other));
  }
});

test('분석 스택 초과 실패는 코드 2이고 원인과 해결 방향만 싣는다', () => {
  const result = stackExhaustionFailure();
  assert.equal(result.exitCode, 2);
  assert.equal(result.standardOutput, '');
  assert.match(result.standardError, /^tsograph: .*call stack.*nests expressions.*; exclude or split .* and retry\.\n$/u);
  assert.doesNotMatch(result.standardError, /internal error|would exceed|\//u);
});
