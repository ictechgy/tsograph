/**
 * 분석 대상 파일을 크기 상한 안에서 UTF-8로 읽고, 실패를 계수로 남긴다.
 *
 * "없다"와 "못 읽었다"를 구분하기 위한 장부다. 오류 문구에 경로·내용을 싣지 않고 개수만 센다.
 */

import { readFileSync, statSync } from 'node:fs';

import { decodeUtf8 } from './source-text.ts';

/** 파일 하나의 크기 상한(바이트)이다. 이보다 큰 소스는 생성물일 가능성이 커 읽지 않고 센다. */
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** 읽은 파일의 텍스트와 수정 시각이다. */
export interface ReadResult {
  readonly text: string;
  readonly modifiedAt: Date;
}

/** 계수를 가진 파일 읽기 도우미다. */
export class ProjectReader {
  /** 읽지 못한 파일 수(권한·UTF-8 아님)다. */
  unreadable = 0;
  /** 크기 상한을 넘어 읽지 않은 파일 수다. */
  oversized = 0;
  /** 읽은 파일 중 가장 늦은 수정 시각이다. */
  newestModifiedAt: Date | undefined;

  /**
   * 파일을 읽는다.
   *
   * @param path 절대 경로
   * @returns 텍스트와 수정 시각. 읽지 못하면 undefined(계수에 남긴다)
   */
  read(path: string): ReadResult | undefined {
    let bytes: Uint8Array;
    let modifiedAt: Date;
    try {
      const stats = statSync(path);
      if (stats.size > MAX_SOURCE_BYTES) {
        this.oversized++;
        return undefined;
      }
      modifiedAt = stats.mtime;
      bytes = readFileSync(path);
    } catch {
      // 권한·경합으로 못 읽은 파일은 unreadable 계수로 보고한다.
      this.unreadable++;
      return undefined;
    }
    const text = decodeUtf8(bytes);
    if (text === undefined) {
      this.unreadable++;
      return undefined;
    }
    if (this.newestModifiedAt === undefined || modifiedAt > this.newestModifiedAt) this.newestModifiedAt = modifiedAt;
    return { text, modifiedAt };
  }
}

/**
 * 경로가 있는지와 종류를 본다.
 *
 * @param path 절대 경로
 * @returns 'file'·'directory'·undefined
 */
export function pathKind(path: string): 'file' | 'directory' | undefined {
  try {
    const stats = statSync(path);
    if (stats.isFile()) return 'file';
    return stats.isDirectory() ? 'directory' : undefined;
  } catch {
    // 없는 경로는 종류가 없다.
    return undefined;
  }
}
