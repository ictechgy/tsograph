import { deflateRawSync } from 'node:zlib';
import { crc32 } from './pnp-zip.ts';

/** 합성 ZIP header를 독립 조립해 손상·중복·예산 대조군을 만든다. */
export function makeZip(entries: readonly { name: string; text?: string; method?: number; flags?: number; mode?: number; extra?: Buffer; descriptor?: 'signed' | 'unsigned' | 'missing' }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), content = Buffer.from(entry.text ?? ''), method = entry.method ?? 0, flags = entry.flags ?? 0x800;
    const compressed = method === 8 ? deflateRawSync(content) : content, extra = entry.extra ?? Buffer.alloc(0);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc32(content), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28);
    let descriptor = Buffer.alloc(0);
    if ((flags & 8) !== 0) {
      header.fill(0, 14, 26);
      if (entry.descriptor !== 'missing') {
        const start = entry.descriptor === 'unsigned' ? 0 : 4;
        descriptor = Buffer.alloc(start + 12);
        if (start === 4) descriptor.writeUInt32LE(0x08074b50);
        descriptor.writeUInt32LE(crc32(content), start); descriptor.writeUInt32LE(compressed.length, start + 4); descriptor.writeUInt32LE(content.length, start + 8);
      }
    }
    local.push(header, name, extra, compressed, descriptor);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x314, 4); index.writeUInt16LE(20, 6); index.writeUInt16LE(flags, 8); index.writeUInt16LE(method, 10);
    index.writeUInt32LE(crc32(content), 16); index.writeUInt32LE(compressed.length, 20); index.writeUInt32LE(content.length, 24);
    index.writeUInt16LE(name.length, 28); index.writeUInt16LE(extra.length, 30); index.writeUInt32LE(((entry.mode ?? 0x81a4) << 16) >>> 0, 38); index.writeUInt32LE(offset, 42);
    central.push(index, name, extra);
    offset += header.length + name.length + extra.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
