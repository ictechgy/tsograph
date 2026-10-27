import assert from 'node:assert/strict';
import { appendFileSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from './file-system.ts';

test('Node 구현은 realpath·종류·크기·바이트를 돌려준다', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-fs-')));
  try {
    const file = join(directory, 'a.txt');
    writeFileSync(file, 'abc');
    symlinkSync(file, join(directory, 'link.txt'));
    symlinkSync('/dev/null', join(directory, 'device'));
    const fileSystem = createNodeFileSystem();
    assert.equal(await fileSystem.realPath(join(directory, 'link.txt')), file);
    const status = await fileSystem.status(file);
    assert.equal(status.kind, 'file');
    assert.equal(status.size, 3);
    assert.ok(status.modifiedAt instanceof Date);
    assert.equal((await fileSystem.status(directory)).kind, 'directory');
    assert.equal((await fileSystem.status(join(directory, 'device'))).kind, 'other');
    assert.deepEqual([...await fileSystem.readBytes(file)], [97, 98, 99]);
    assert.deepEqual([...await fileSystem.readBytes(join(directory, 'link.txt'), 1)], [97, 98]);
    mkdirSync(join(directory, 'sub'));
    const entries = [...await fileSystem.listDirectory(directory)].sort((left, right) => (left.name < right.name ? -1 : 1));
    assert.deepEqual(entries, [
      { name: 'a.txt', kind: 'file' },
      { name: 'device', kind: 'symlink' },
      { name: 'link.txt', kind: 'symlink' },
      { name: 'sub', kind: 'directory' },
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded read는 stat 뒤 성장한 파일도 cap+1 byte까지만 읽는다', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-fs-bound-')));
  try {
    const file = join(directory, 'growing.bin');
    writeFileSync(file, new Uint8Array([1, 2, 3]));
    const fileSystem = createNodeFileSystem();
    const before = await fileSystem.status(file);
    appendFileSync(file, new Uint8Array([4, 5, 6, 7, 8]));
    assert.deepEqual([...await fileSystem.readBytes(file, before.size)], [1, 2, 3, 4]);
    assert.deepEqual([...await fileSystem.readBytes(file, 0)], [1]);
    assert.deepEqual([...await fileSystem.readBytes(file, 100)], [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded read는 문자 수가 아니라 UTF-8 byte의 exact cap과 cap+1을 지킨다', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-fs-utf8-')));
  try {
    const file = join(directory, 'utf8.txt');
    writeFileSync(file, '한글');
    const fileSystem = createNodeFileSystem();
    assert.equal((await fileSystem.readBytes(file, 3)).byteLength, 4);
    assert.equal((await fileSystem.readBytes(file, 6)).byteLength, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('bounded read의 cap은 유한한 nonnegative safe integer다', async () => {
  const fileSystem = createNodeFileSystem();
  for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(fileSystem.readBytes('/unused', limit), RangeError, String(limit));
  }
});

test('chunk reader는 고정 조각·cap+1·성장·조기 종료를 제한된 regular file handle로 다룬다', {
  skip: !constants.O_NOFOLLOW || !constants.O_NONBLOCK,
}, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-fs-chunks-')));
  try {
    const file = join(directory, 'bytes.bin');
    writeFileSync(file, Buffer.alloc(128 * 1024, 7));
    const fileSystem = createNodeFileSystem();
    const parts: Uint8Array[] = [];
    for await (const part of fileSystem.readChunks!(file, 64 * 1024)) parts.push(part);
    assert.deepEqual(parts.map(part => part.byteLength), [64 * 1024, 1]);
    assert.ok(parts.every(part => part.every(value => value === 7)));
    writeFileSync(file, 'abc');
    const before = await fileSystem.status(file);
    appendFileSync(file, 'defgh');
    const grown: number[] = [];
    for await (const part of fileSystem.readChunks!(file, before.size)) grown.push(...part);
    assert.deepEqual(grown, [...Buffer.from('abcd')]);
    const iterator = fileSystem.readChunks!(file, 100)[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).done, false);
    await iterator.return?.();
    assert.equal((await iterator.next()).done, true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('chunk reader는 invalid cap·symlink·directory·device를 안전하게 거부한다', async () => {
  const fileSystem = createNodeFileSystem();
  const consume = async (path: string, limit: number) => { for await (const _part of fileSystem.readChunks!(path, limit)) { /* 소비만 한다. */ } };
  for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) await assert.rejects(consume('/unused', limit), RangeError);
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-fs-chunk-boundary-')));
  try {
    writeFileSync(join(directory, 'a.txt'), 'a');
    symlinkSync(join(directory, 'a.txt'), join(directory, 'link'));
    for (const path of [directory, join(directory, 'link'), '/dev/null']) await assert.rejects(consume(path, 100));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
