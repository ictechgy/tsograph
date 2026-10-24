import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { frozenInputAllowed } from './frozen-inputs.ts';

/** TypeScript compiler config 하나와 extends 파일 하나에 허용하는 최대 byte 수다. */
export const MAX_GRAPH_CONFIG_BYTES = 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

/** `noFollow` open flag다. Windows에는 `O_NOFOLLOW`가 없어 0이 된다. */
/* node:coverage ignore next */
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

/**
 * bounded read가 실패한 이유다.
 *
 * 'missing'은 open이 ENOENT로 실패했을 때뿐이다(끊어진 symlink 포함). 호출자가 "파일 없음"과 "있는데 못 읽음"을
 * 다르게 다뤄야 해서 나눈다. 일반 파일이 아닌 대상(FIFO·장치·디렉터리), `noFollow`에서 만난 symlink와 그 밖의
 * open·read·close 오류는 'unreadable'이다.
 */
export type BoundedReadFailure = 'missing' | 'too-large' | 'unreadable';

/** bounded read로 읽은 bytes 또는 안전하게 분류된 실패다. */
export type BoundedFileBytes =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: BoundedReadFailure };

/** bounded config read의 값 또는 안전하게 분류된 실패다. */
export type BoundedConfigText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: BoundedReadFailure };

/** bounded read 선택 사항이다. */
export interface BoundedReadOptions {
  /**
   * 마지막 경로 요소가 symlink면 열지 않고 'unreadable'로 본다(`O_NOFOLLOW` 지원 플랫폼).
   * 저장소가 루트 manifest 같은 고정 이름을 프로젝트 밖이나 장치로 가는 링크로 바꿔 둘 수 있어서다.
   */
  readonly noFollow?: boolean;
}

/**
 * 일반 파일을 최대 byte 수보다 하나만 더 읽어 크기를 판정한다.
 *
 * 블로킹 없이(`O_NONBLOCK`) 열고 열린 핸들의 `fstat`이 일반 파일일 때만 읽는다. 그래서 FIFO에서 쓰는 쪽을
 * 기다리지 않고, `stat` 크기가 0인 장치(`/dev/zero`)를 끝없이 읽지 않으며, 메타데이터 확인 뒤 커진 파일도
 * 상한+1 byte까지만 읽는다. open 이후 오류와 close 오류는 경로나 내용을 노출하지 않는 실패가 된다.
 *
 * @param path 읽을 파일
 * @param maximumBytes 허용하는 최대 byte 수
 * @param options 마지막 symlink 처리
 * @returns 읽은 bytes(디코드하지 않음) 또는 실패 이유
 */
export function readBoundedFileBytes(path: string, maximumBytes: number, options: BoundedReadOptions = {}): BoundedFileBytes {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('maximumBytes must be a nonnegative safe integer with room for one sentinel byte');
  }
  if (!frozenInputAllowed(path)) return { ok: false, reason: 'missing' };
  let descriptor: number | undefined;
  let result: BoundedFileBytes = { ok: false, reason: 'unreadable' };
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (options.noFollow === true ? NO_FOLLOW_FLAG : 0));
    result = readOpenFile(descriptor, maximumBytes);
  } catch (error) {
    // 열기 전의 ENOENT만 "없음"이다. 그 밖의 open·fstat·read 오류는 내용을 노출하지 않는 읽기 실패로 둔다.
    result = { ok: false, reason: descriptor === undefined && isMissingFile(error) ? 'missing' : 'unreadable' };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // 닫지 못한 핸들에서 읽은 내용은 믿지 않는다.
        result = { ok: false, reason: 'unreadable' };
      }
    }
  }
  return result;
}

/**
 * 설정 파일을 최대 byte 수보다 하나만 더 읽어 크기를 판정한다.
 *
 * TypeScript의 시스템 reader와 같은 BOM 인코딩을 지원하지만 파일 전체 크기로 buffer를
 * 미리 잡지 않는다. 열기·읽기 규칙은 {@link readBoundedFileBytes}와 같다.
 *
 * @param path 읽을 파일
 * @param maximumBytes 허용하는 최대 byte 수
 * @param options 마지막 symlink 처리
 * @returns 텍스트 또는 실패 이유
 */
export function readBoundedConfigText(
  path: string,
  maximumBytes = MAX_GRAPH_CONFIG_BYTES,
  options: BoundedReadOptions = {},
): BoundedConfigText {
  const read = readBoundedFileBytes(path, maximumBytes, options);
  return read.ok ? { ok: true, text: decodeConfigText(read.bytes) } : read;
}

/**
 * 열린 핸들이 일반 파일일 때만 상한+1 byte까지 읽는다.
 *
 * @param descriptor 열린 파일 핸들
 * @param maximumBytes 허용하는 최대 byte 수
 * @returns 읽은 bytes 또는 실패 이유
 */
function readOpenFile(descriptor: number, maximumBytes: number): BoundedFileBytes {
  if (!fstatSync(descriptor).isFile()) return { ok: false, reason: 'unreadable' };
  const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maximumBytes + 1));
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const count = readSync(descriptor, chunk, 0, Math.min(chunk.byteLength, maximumBytes + 1 - total), null);
    if (count === 0) return { ok: true, bytes: Buffer.concat(chunks, total) };
    total += count;
    if (total > maximumBytes) return { ok: false, reason: 'too-large' };
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
}

/**
 * open 실패가 경로 없음(ENOENT)인지 본다.
 *
 * @param error open이 던진 값
 * @returns ENOENT면 true
 */
function isMissingFile(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** TypeScript sys.readFile과 같은 UTF-8·UTF-16 BOM 규칙으로 bytes를 문자열로 바꾼다. */
function decodeConfigText(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const evenLength = bytes.length & ~1;
    for (let index = 0; index < evenLength; index += 2) {
      [bytes[index], bytes[index + 1]] = [bytes[index + 1]!, bytes[index]!];
    }
    return bytes.toString('utf16le', 2, evenLength);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.toString('utf16le', 2);
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.toString('utf8', 3);
  }
  return bytes.toString('utf8');
}
