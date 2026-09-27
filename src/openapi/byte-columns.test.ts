import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ByteColumnIndex, CHECKPOINT_INTERVAL } from './byte-columns.ts';

/** 기준값: 줄 시작부터 직접 센 UTF-8 바이트 열이다. */
function naiveColumn(text: string, lineStart: number, offset: number): number {
  return Buffer.byteLength(text.slice(lineStart, offset), 'utf8') + 1;
}

test('짧은 거리는 줄 시작부터 센다', () => {
  const text = 'ab\nné: x';
  assert.equal(new ByteColumnIndex(text).column(3, 6), 5);
});

test('긴 줄의 체크포인트 결과는 직접 센 값과 같고 서러게이트 쌍을 가르지 않는다', () => {
  // 체크포인트 경계가 서러게이트 쌍 가운데에 오도록 앞에 한 칸을 둔다.
  const line = `x${'😀é'.repeat(CHECKPOINT_INTERVAL)}`;
  const text = `head\n${line}\ntail`;
  const index = new ByteColumnIndex(text);
  const lineStart = 5;
  const offsets = [lineStart + CHECKPOINT_INTERVAL + 1, lineStart + 3 * CHECKPOINT_INTERVAL + 2, lineStart + line.length - 1, lineStart + CHECKPOINT_INTERVAL * 2 - 1];
  for (const offset of offsets) {
    const safe = text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff ? offset + 1 : offset;
    assert.equal(index.column(lineStart, safe), naiveColumn(text, lineStart, safe), String(safe));
  }
  const lastLine = new ByteColumnIndex(`a\n${'é'.repeat(CHECKPOINT_INTERVAL * 2)}`);
  assert.equal(lastLine.column(2, 2 + CHECKPOINT_INTERVAL + 5), (CHECKPOINT_INTERVAL + 5) * 2 + 1);
});
