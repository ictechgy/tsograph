import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** TypeScript compiler config 하나와 extends 파일 하나에 허용하는 최대 byte 수다. */
export const MAX_GRAPH_CONFIG_BYTES = 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

/** bounded config read의 값 또는 안전하게 분류된 실패다. */
export type BoundedConfigText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: 'too-large' | 'unreadable' };

/**
 * 설정 파일을 최대 byte 수보다 하나만 더 읽어 크기를 판정한다.
 *
 * TypeScript의 시스템 reader와 같은 BOM 인코딩을 지원하지만 파일 전체 크기로 buffer를
 * 미리 잡지 않는다. open 이후 오류와 close 오류는 경로나 내용을 노출하지 않는
 * 실패가 된다.
 */
export function readBoundedConfigText(
  path: string,
  maximumBytes = MAX_GRAPH_CONFIG_BYTES,
): BoundedConfigText {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('maximumBytes must be a nonnegative safe integer with room for one sentinel byte');
  }
  let descriptor: number | undefined;
  let result: BoundedConfigText = { ok: false, reason: 'unreadable' };
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) return result;
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maximumBytes + 1));
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const count = readSync(
        descriptor,
        chunk,
        0,
        Math.min(chunk.byteLength, maximumBytes + 1 - total),
        null,
      );
      if (count === 0) {
        result = { ok: true, text: decodeConfigText(Buffer.concat(chunks, total)) };
        break;
      }
      total += count;
      if (total > maximumBytes) {
        result = { ok: false, reason: 'too-large' };
        break;
      }
      chunks.push(Buffer.from(chunk.subarray(0, count)));
    }
  } catch {
    result = { ok: false, reason: 'unreadable' };
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        result = { ok: false, reason: 'unreadable' };
      }
    }
  }
  return result;
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
