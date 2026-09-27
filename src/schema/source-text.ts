/**
 * 소스 텍스트의 UTF-16 오프셋을 1부터 시작하는 줄·UTF-8 바이트 열로 바꾼다.
 *
 * 교환 계약의 위치는 줄과 UTF-8 바이트 열이다. 한 파일에서 사실을 여러 개 내므로 줄 시작
 * 오프셋을 한 번 색인하고 긴 줄은 openapi와 같은 체크포인트 색인으로 센다. 앞머리 BOM은
 * 읽을 때 떼어 내므로 열에 세지 않는다.
 */

import { ByteColumnIndex } from '../openapi/byte-columns.ts';

/** 1부터 시작하는 줄과 UTF-8 바이트 열이다. */
export interface LineColumn {
  readonly line: number;
  readonly column: number;
}

/** 오프셋 → 줄·열 변환기다. */
export class SourceText {
  /** 원문(BOM 제거 뒤)이다. */
  readonly text: string;
  /** 각 줄의 시작 오프셋이다. */
  private readonly lineStarts: readonly number[];
  /** UTF-8 바이트 열 색인이다. */
  private readonly columns: ByteColumnIndex;

  /**
   * @param text 파일 텍스트(BOM 제거 뒤)
   */
  constructor(text: string) {
    this.text = text;
    this.lineStarts = indexLineStarts(text);
    this.columns = new ByteColumnIndex(text);
  }

  /**
   * 오프셋의 줄·열을 돌려준다.
   *
   * @param offset UTF-16 오프셋
   * @returns 1부터 시작하는 줄과 UTF-8 바이트 열
   */
  locate(offset: number): LineColumn {
    const lineIndex = this.lineIndexOf(offset);
    const lineStart = this.lineStarts[lineIndex]!;
    return { line: lineIndex + 1, column: this.columns.column(lineStart, offset) };
  }

  /**
   * 오프셋이 속한 줄 번호(0부터)를 이진 탐색한다.
   *
   * @param offset UTF-16 오프셋
   * @returns 줄 번호(0부터)
   */
  private lineIndexOf(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  }
}

/**
 * 줄 시작 오프셋을 모은다. `\r\n`은 `\n` 뒤에서 새 줄이 시작되므로 `\n`만 기준으로 삼는다.
 *
 * @param text 텍스트
 * @returns 오름차순 줄 시작 오프셋
 */
function indexLineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

/**
 * 바이트를 엄격한 UTF-8로 디코드하고 앞머리 BOM을 뗀다.
 *
 * @param bytes 파일 바이트
 * @returns 텍스트. UTF-8이 아니면 undefined
 */
export function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.startsWith('﻿') ? text.slice(1) : text;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    /* node:coverage ignore next */
    throw error;
  }
}
