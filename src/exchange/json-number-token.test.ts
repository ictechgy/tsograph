import assert from 'node:assert/strict';
import { test } from 'node:test';

import { scanJsonNumberToken } from './json-number-token.ts';

test('JSON number token은 suffix를 만들지 않고 시작 위치에서 끝 위치를 찾는다', () => {
  const cases: [string, number, number | undefined][] = [
    ['0,', 0, 1],
    ['[-12.5e+2]', 1, 9],
    ['x1', 0, undefined],
    ['01', 0, 1],
    ['.1', 0, undefined],
  ];
  for (const [source, start, expected] of cases) {
    assert.equal(scanJsonNumberToken(source, start), expected, source);
  }
});

test('많은 숫자를 같은 원문에서 선형 위치 전진으로 읽는다', () => {
  const count = 50_000;
  const source = `[${Array.from({ length: count }, (_, index) => index % 10).join(',')}]`;
  let index = 1;
  for (let seen = 0; seen < count; seen++) {
    index = scanJsonNumberToken(source, index)!;
    index += seen + 1 === count ? 0 : 1;
  }
  assert.equal(index, source.length - 1);
});
