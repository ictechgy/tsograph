/** PnP 패키지 ZIP을 추출·실행 없이 검증하고 유계 메모리 안에서 읽는다. */
import { inflateRawSync } from 'node:zlib';

/** ZIP 하나의 압축 전/후와 항목 수 상한이다. ZIP64·분할·암호화 형식은 받지 않는다. */
export const PNP_ZIP_LIMITS = { archiveBytes: 64 * 1024 * 1024, fileBytes: 4 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024, entries: 10_000, ratio: 1_000, pathBytes: 4 * 1024 * 1024, directories: 50_000 } as const;

/** 잘못된 ZIP은 경로나 입력 내용을 오류에 싣지 않는다. */
export class PnpZipError extends Error {
  constructor() { super('static PnP ZIP is malformed, unsupported, or exceeds its resource budget'); this.name = 'PnpZipError'; }
}

/** 검증한 archive의 파일과 디렉터리다. 원본 파일 시스템에는 쓰지 않는다. */
export interface PnpZip {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly directories: ReadonlySet<string>;
  readonly expandedBytes: number;
}

interface Entry { name: string; nameBytes: Buffer; flags: number; method: number; crc: number; size: number; compressed: number; offset: number }

/** 중앙/로컬 header 일치·경로·중복·CRC를 모든 항목에서 검증한 뒤에만 archive를 내준다. */
export function readPnpZip(bytes: Buffer, expandedBudget = PNP_ZIP_LIMITS.expandedBytes): PnpZip {
  if (bytes.length > PNP_ZIP_LIMITS.archiveBytes || bytes.length < 22) throw new PnpZipError();
  const end = findEnd(bytes);
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), central = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0
    || bytes.readUInt16LE(end + 8) !== count || count > PNP_ZIP_LIMITS.entries || count === 0xffff
    || central === 0xffffffff || centralSize === 0xffffffff || central + centralSize !== end) throw new PnpZipError();
  const entries: Entry[] = [], names = new Set<string>();
  let cursor = central, expanded = 0, pathBytes = 0;
  for (let index = 0; index < count; index++) {
    requireBytes(bytes, cursor, 46, end);
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new PnpZipError();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42), mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    requireBytes(bytes, cursor + 46, nameLength + extraLength + commentLength, end);
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = entryName(nameBytes, flags);
    pathBytes += nameLength;
    if ((flags & ~0x080e) !== 0 || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34) !== 0
      || offset === 0xffffffff || compressed === 0xffffffff || size === 0xffffffff || (mode & 0xf000) === 0xa000
      || size > PNP_ZIP_LIMITS.fileBytes || (size > Math.max(compressed, 1) * PNP_ZIP_LIMITS.ratio)
      || (method === 0 && size !== compressed) || pathBytes > PNP_ZIP_LIMITS.pathBytes
      || names.has(name) || (name.endsWith('/') && size !== 0)) throw new PnpZipError();
    checkExtra(bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
    names.add(name);
    expanded += size;
    if (expanded > expandedBudget || expanded > PNP_ZIP_LIMITS.expandedBytes) throw new PnpZipError();
    entries.push({ name, nameBytes, flags, method, crc: bytes.readUInt32LE(cursor + 16), size, compressed, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) throw new PnpZipError();
  const files = new Map<string, Buffer>(), directories = new Set<string>(['']);
  let directoryBytes = 0;
  const addDirectory = (path: string): void => {
    if (directories.has(path)) return;
    directoryBytes += Buffer.byteLength(path);
    if (directories.size >= PNP_ZIP_LIMITS.directories || directoryBytes > PNP_ZIP_LIMITS.pathBytes) throw new PnpZipError();
    directories.add(path);
  };
  const occupied: { start: number; end: number }[] = [];
  for (const entry of entries) {
    const data = localData(bytes, entry, central);
    occupied.push({ start: entry.offset, end: data.end });
    let content: Buffer;
    try { content = entry.method === 0 ? Buffer.from(data.bytes)
      : inflateRawSync(data.bytes, { maxOutputLength: Math.min(PNP_ZIP_LIMITS.fileBytes, entry.size + 1) }); }
    catch { throw new PnpZipError(); }
    if (content.length !== entry.size || crc32(content) !== entry.crc) throw new PnpZipError();
    const path = entry.name.endsWith('/') ? entry.name.slice(0, -1) : entry.name;
    if (entry.name.endsWith('/')) addDirectory(path); else files.set(path, content);
    const parts = path.split('/');
    for (let depth = 1; depth < parts.length; depth++) addDirectory(parts.slice(0, depth).join('/'));
  }
  occupied.sort((a, b) => a.start - b.start);
  if (occupied.some((range, index) => index > 0 && range.start < occupied[index - 1]!.end)
    || [...files.keys()].some(path => directories.has(path))) throw new PnpZipError();
  return { files, directories, expandedBytes: expanded };
}

/** EOCD의 comment 길이까지 일치하는 마지막 단일 디스크 header만 받는다. */
function findEnd(bytes: Buffer): number {
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  throw new PnpZipError();
}

/** 범위를 벗어난 header·data는 Buffer의 저수준 오류 대신 같은 안전한 실패가 된다. */
function requireBytes(bytes: Buffer, offset: number, count: number, end = bytes.length): void {
  if (offset < 0 || count < 0 || offset + count > end || end > bytes.length) throw new PnpZipError();
}

/** CP437/Unicode extra-field 별칭을 추측하지 않고 명시 UTF-8 또는 ASCII 경로만 받는다. */
function entryName(bytes: Buffer, flags: number): string {
  if (bytes.length === 0 || bytes.length > 4_096 || ((flags & 0x800) === 0 && bytes.some(byte => byte > 0x7f))) throw new PnpZipError();
  let name: string;
  try { name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new PnpZipError(); }
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (/^[\/]/u.test(name) || /[\\:\p{Cc}\p{Cf}]/u.test(name)
    || parts.length > 64 || parts.some(part => part === '' || part === '.' || part === '..')) throw new PnpZipError();
  return name;
}

/** ZIP64 또는 header와 다른 파일명을 제시하는 extra field는 지원 범위 밖이다. */
function checkExtra(bytes: Buffer): void {
  let cursor = 0;
  while (cursor < bytes.length) {
    requireBytes(bytes, cursor, 4);
    const kind = bytes.readUInt16LE(cursor), size = bytes.readUInt16LE(cursor + 2);
    requireBytes(bytes, cursor + 4, size);
    if (kind === 0x0001 || kind === 0x7075) throw new PnpZipError();
    cursor += 4 + size;
  }
}

/** 로컬 이름/압축 방식/크기가 중앙 index와 같은 항목만 읽는다. descriptor는 중앙 크기를 사용한다. */
function localData(bytes: Buffer, entry: Entry, central: number): { bytes: Buffer; end: number } {
  requireBytes(bytes, entry.offset, 30, central);
  const offset = entry.offset, nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
  requireBytes(bytes, offset + 30, nameLength + extraLength + entry.compressed, central);
  if (bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== entry.flags
    || bytes.readUInt16LE(offset + 8) !== entry.method
    || !bytes.subarray(offset + 30, offset + 30 + nameLength).equals(entry.nameBytes)
    || entryName(bytes.subarray(offset + 30, offset + 30 + nameLength), entry.flags) !== entry.name) throw new PnpZipError();
  for (const [field, expected] of [[14, entry.crc], [18, entry.compressed], [22, entry.size]] as const) {
    const actual = bytes.readUInt32LE(offset + field);
    if (actual !== expected && !((entry.flags & 8) !== 0 && actual === 0)) throw new PnpZipError();
  }
  checkExtra(bytes.subarray(offset + 30 + nameLength, offset + 30 + nameLength + extraLength));
  const start = offset + 30 + nameLength + extraLength, dataEnd = start + entry.compressed;
  let end = dataEnd;
  if ((entry.flags & 8) !== 0) {
    const candidates = [0, 4].filter(signatureBytes => {
      if (dataEnd + signatureBytes + 12 > central) return false;
      if (signatureBytes === 4 && bytes.readUInt32LE(dataEnd) !== 0x08074b50) return false;
      return bytes.readUInt32LE(dataEnd + signatureBytes) === entry.crc
        && bytes.readUInt32LE(dataEnd + signatureBytes + 4) === entry.compressed
        && bytes.readUInt32LE(dataEnd + signatureBytes + 8) === entry.size;
    });
    if (candidates.length !== 1) throw new PnpZipError();
    end += candidates[0]! + 12;
  }
  return { bytes: bytes.subarray(start, dataEnd), end };
}

/** ISO-HDLC CRC32를 검사해 압축 해제 성공만으로 손상된 패키지를 신뢰하지 않는다. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
