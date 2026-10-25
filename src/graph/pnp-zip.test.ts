import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeZip } from './pnp-testing.test.ts';
import { PNP_ZIP_LIMITS, PnpZipError, crc32, readPnpZip } from './pnp-zip.ts';

test('CRC의 알려진 벡터와 store/deflate UTF-8·빈 directory를 검증한다', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const zip = readPnpZip(makeZip([{ name: 'node_modules/pkg/index.d.ts', text: 'export const x: 1;', method: 8 },
    { name: '한글.txt', text: 'text' }, { name: 'empty/', method: 8 }]));
  assert.equal(zip.files.get('한글.txt')?.toString(), 'text');
  assert.equal(zip.files.get('node_modules/pkg/index.d.ts')?.toString(), 'export const x: 1;');
  assert.ok(zip.directories.has('node_modules/pkg'));
  assert.ok(zip.directories.has('empty'));
  assert.equal(readPnpZip(makeZip([])).files.size, 0);
});

test('경로 탈출·symlink·중복·파일/directory 충돌·비지원 encoding을 archive째 거부한다', () => {
  for (const name of ['../escape', '/root', 'a/../b', 'a//b', 'a\\b', 'C:file', 'a\0b', './a', 'a/./b', 'a\u202eb', 'a/'.repeat(65) + 'file']) {
    assert.throws(() => readPnpZip(makeZip([{ name }])), PnpZipError, name);
  }
  for (const entries of [[{ name: 'a', mode: 0xa1ff }], [{ name: 'a' }, { name: 'a' }], [{ name: 'a' }, { name: 'a/b' }],
    [{ name: 'a/', text: 'not empty' }], [{ name: '한글', flags: 0 }], [{ name: 'a', flags: 1 }], [{ name: 'a', method: 99 }]]) {
    assert.throws(() => readPnpZip(makeZip(entries)), PnpZipError);
  }
});

test('중앙/로컬 불일치·CRC·압축 손상·overlap·split/ZIP64 header를 거부한다', () => {
  const good = makeZip([{ name: 'a', text: 'hello' }, { name: 'b', text: 'world' }]);
  const central = good.readUInt32LE(good.length - 6);
  for (const [offset, value, width] of [[0, 0, 4], [central, 0, 4], [6, 0, 2], [8, 8, 2], [14, 1, 4], [18, 4, 4],
    [central + 16, 1, 4], [central + 42, 0xffffffff, 4], [central + 34, 1, 2], [central + 47 + 42, 0, 4],
    [good.length - 18, 1, 2], [good.length - 14, 1, 2], [good.length - 10, 1, 4], [good.length - 6, 0xffffffff, 4]] as const) {
    const bad = Buffer.from(good);
    if (width === 2) bad.writeUInt16LE(value, offset); else bad.writeUInt32LE(value, offset);
    assert.throws(() => readPnpZip(bad), PnpZipError, String(offset));
  }
  const corrupt = makeZip([{ name: 'a', text: 'compress this', method: 8 }]); corrupt[31] = 0xff;
  assert.throws(() => readPnpZip(corrupt), PnpZipError);
  const name = Buffer.from(good); name[30] = 0x62;
  assert.throws(() => readPnpZip(name), PnpZipError);
  for (const bad of [good.subarray(0, 5), good.subarray(0, good.length - 1), Buffer.concat([good, Buffer.from('trailing')])]) assert.throws(() => readPnpZip(bad), PnpZipError);
});

test('압축 해제·항목·경로·extra field 예산을 검사하고 descriptor의 중앙 크기를 사용한다', () => {
  assert.throws(() => readPnpZip(makeZip([{ name: 'a', text: 'hello' }]), 4), PnpZipError);
  assert.throws(() => readPnpZip(makeZip([{ name: 'a', text: 'a'.repeat(PNP_ZIP_LIMITS.fileBytes + 1), method: 8 }])), PnpZipError);
  assert.throws(() => readPnpZip(makeZip([{ name: 'a', text: 'a'.repeat(1_000_000), method: 8 }])), PnpZipError);
  assert.throws(() => readPnpZip(makeZip(Array.from({ length: PNP_ZIP_LIMITS.entries + 1 }, (_, i) => ({ name: String(i) })))), PnpZipError);
  for (const extra of [Buffer.from([1, 0, 0, 0]), Buffer.from([0x75, 0x70, 0, 0]), Buffer.from([2, 0, 5, 0]), Buffer.from([1])]) {
    assert.throws(() => readPnpZip(makeZip([{ name: 'a', extra }])), PnpZipError);
  }
  const zip = makeZip([{ name: 'a', text: 'hello', flags: 8 }]);
  zip.fill(0, 14, 26);
  assert.equal(readPnpZip(zip).files.get('a')?.toString(), 'hello');
  assert.equal(readPnpZip(makeZip([{ name: 'a', text: 'hello', flags: 8, descriptor: 'unsigned' }])).files.get('a')?.toString(), 'hello');
  assert.throws(() => readPnpZip(makeZip([{ name: 'a', text: 'hello', flags: 8, descriptor: 'missing' }])), PnpZipError);
  for (const field of [0, 4, 8, 12]) {
    const bad = makeZip([{ name: 'a', text: 'hello', flags: 8 }]);
    bad.writeUInt32LE(0, 30 + 1 + 5 + field);
    assert.throws(() => readPnpZip(bad), PnpZipError);
  }
});
