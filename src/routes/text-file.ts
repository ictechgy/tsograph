/**
 * 분석 대상 텍스트 파일을 크기 상한 안에서 엄격한 UTF-8로 읽는다.
 *
 * BOM은 지우지 않는다. 위치(UTF-8 바이트 열)를 파일 원문 기준으로 세기 위해서다.
 */

import type { CommandFileSystem } from '../cli/file-system.ts';

/** 텍스트를 읽지 못한 이유다. */
export type TextReadFailure = 'too-large' | 'unreadable' | 'invalid-utf8';

/** 읽기 결과다. 실패 이유가 문자열이라 텍스트와 섞이지 않게 종류로 나눈다. */
export type TextReadResult =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'failure'; readonly reason: TextReadFailure };

/**
 * 파일을 읽어 텍스트로 돌려준다.
 *
 * @param fileSystem 파일 시스템
 * @param path 절대 경로
 * @param maxBytes 최대 바이트 수
 * @returns 텍스트 또는 실패 이유
 */
export async function readTextFile(fileSystem: CommandFileSystem, path: string, maxBytes: number): Promise<TextReadResult> {
  let bytes: Uint8Array;
  try {
    const status = await fileSystem.status(path);
    if (status.kind !== 'file') return failure('unreadable');
    if (status.size > maxBytes) return failure('too-large');
    bytes = await fileSystem.readBytes(path);
  } catch {
    // 읽기 실패는 호출자가 route-coverage 공백으로 센다(실패 이유 문자열이 신호다).
    return failure('unreadable');
  }
  if (bytes.byteLength > maxBytes) return failure('too-large');
  return decodeUtf8(bytes);
}

/**
 * 실패 결과를 만든다.
 *
 * @param reason 이유
 * @returns 실패 결과
 */
function failure(reason: TextReadFailure): TextReadResult {
  return { kind: 'failure', reason };
}

/**
 * 바이트를 엄격한 UTF-8로 디코드한다.
 *
 * @param bytes 파일 바이트
 * @returns 텍스트 또는 'invalid-utf8' 실패
 */
function decodeUtf8(bytes: Uint8Array): TextReadResult {
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch (error) {
    if (error instanceof TypeError) return failure('invalid-utf8');
    /* node:coverage ignore next */
    throw error;
  }
}
