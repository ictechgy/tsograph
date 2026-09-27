import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseArguments } from './parse-arguments.ts';

test('플래그는 위치 인자 앞뒤 어디에나 올 수 있다', () => {
  const parsed = parseArguments(['--a', '1', 'x', '--b', 'y'], ['--a'], ['--b']);
  assert.deepEqual(parsed?.valueFlags, new Map([['--a', '1']]));
  assert.deepEqual(parsed?.booleanFlags, new Set(['--b']));
  assert.deepEqual(parsed?.positionals, ['x', 'y']);
});

test('-- 뒤는 모두 위치 인자다', () => {
  assert.deepEqual(parseArguments(['--', '-x', '--a'], ['--a'], [])?.positionals, ['-x', '--a']);
});

test('모르는 플래그·중복 값 플래그·빈 값·대시 값은 사용법 위반이다', () => {
  assert.equal(parseArguments(['--nope'], [], []), undefined);
  assert.equal(parseArguments(['--a', '1', '--a', '2'], ['--a'], []), undefined);
  assert.equal(parseArguments(['--a', ''], ['--a'], []), undefined);
  assert.equal(parseArguments(['--a', '-1'], ['--a'], []), undefined);
  assert.equal(parseArguments(['--a'], ['--a'], []), undefined);
});
