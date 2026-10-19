import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { readSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test } from 'node:test';

import { LinkFreePaths, MAX_SOURCE_BYTES, ProjectReader } from './project-reader.ts';
import { withProject } from './testing.test.ts';

test('파일 크기 정보가 오래되어도 실제 읽기 상한을 넘긴 소스를 받아들이지 않는다', (t) => {
  withProject({ 'growing.ts': 'x' }, (root) => {
    const path = join(root, 'growing.ts');
    const beforeGrowth = statSync(path);
    writeFileSync(path, Buffer.alloc(MAX_SOURCE_BYTES + 1, 0x20));
    const originalRead = readSync;
    let bytesRead = 0;
    t.mock.method(fs, 'readSync', (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      const count = originalRead(fd, buffer, offset, length, position);
      bytesRead += count;
      return count;
    });
    t.mock.method(fs, 'statSync', () => beforeGrowth);
    t.mock.method(fs, 'fstatSync', () => beforeGrowth);
    syncBuiltinESMExports();
    try {
      const reader = new ProjectReader();
      assert.equal(reader.read(path) === undefined, true);
      assert.deepEqual([reader.unreadable, reader.oversized], [0, 1]);
      assert.equal(reader.newestModifiedAt, undefined);
      assert.equal(bytesRead, MAX_SOURCE_BYTES + 1);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test('정확한 바이트 상한과 빈 UTF-8 파일은 읽고 상한 초과와 디렉터리는 거부한다', () => {
  withProject({ 'exact.ts': '', 'empty.ts': '' }, (root) => {
    writeFileSync(join(root, 'exact.ts'), Buffer.concat([Buffer.alloc(MAX_SOURCE_BYTES - 3, 0x20), Buffer.from('한')]));
    const reader = new ProjectReader();
    const exact = reader.read(join(root, 'exact.ts'));
    assert.equal(exact?.text.length, MAX_SOURCE_BYTES - 2);
    assert.equal(exact?.text.endsWith('한'), true);
    assert.equal(reader.read(join(root, 'empty.ts'))?.text, '');
    assert.equal(reader.read(root), undefined);
    assert.deepEqual([reader.unreadable, reader.oversized], [1, 0]);
  });
});

for (const failure of ['read', 'close']) {
  test(`${failure} 실패 때 열린 핸들을 닫고 읽기 실패만 센다`, (t) => {
    withProject({ 'source.ts': 'export const answer = 42;' }, (root) => {
      const originalClose = fs.closeSync;
      let closed = 0;
      if (failure === 'read') t.mock.method(fs, 'readSync', () => { throw new Error('private error'); });
      t.mock.method(fs, 'closeSync', (fd: number) => {
        originalClose(fd);
        closed++;
        if (failure === 'close') throw new Error('private close error');
      });
      syncBuiltinESMExports();
      try {
        const reader = new ProjectReader();
        assert.equal(reader.read(join(root, 'source.ts')), undefined);
        assert.deepEqual([reader.unreadable, reader.oversized], [1, 0]);
        assert.equal(reader.newestModifiedAt, undefined);
        assert.equal(closed, 1);
      } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
      }
    });
  });
}

test('열린 파일이 교체되어도 같은 핸들의 내용과 수정 시각을 사용한다', (t) => {
  withProject({ 'source.ts': 'original' }, (root) => {
    const path = join(root, 'source.ts');
    const originalOpen = fs.openSync;
    const before = statSync(path);
    let replaced = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      renameSync(path, join(root, 'saved.ts'));
      writeFileSync(path, 'replacement');
      replaced = true;
      return fd;
    });
    syncBuiltinESMExports();
    try {
      const result = new ProjectReader().read(path);
      assert.equal(replaced, true);
      assert.equal(result?.text, 'original');
      assert.equal(result?.modifiedAt.getTime(), before.mtime.getTime());
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test('지원하는 플랫폼에서는 마지막 파일 심볼릭 링크를 따라가지 않는다', {
  skip: !fs.constants.O_NOFOLLOW,
}, () => {
  withProject({ 'source.ts': 'private target' }, (root) => {
    symlinkSync(join(root, 'source.ts'), join(root, 'link.ts'));
    const reader = new ProjectReader();
    assert.equal(reader.read(join(root, 'link.ts')), undefined);
    assert.equal(reader.unreadable, 1);
  });
});

test('링크 없는 경로 판정은 루트부터 요소마다 lstat하고 막은 링크를 한 번씩 모은다', {
  skip: process.platform === 'win32',
}, () => {
  withProject({ 'dir/file.txt': 'x', 'dir/sub/deep.txt': 'y' }, (root) => {
    symlinkSync(join(root, 'dir'), join(root, 'linked'));
    symlinkSync(join(root, 'dir', 'file.txt'), join(root, 'dir', 'file-link.txt'));
    symlinkSync(join(root, 'dir', 'sub'), join(root, 'dir', 'sub-link'));
    const paths = new LinkFreePaths(root);
    const kinds = [
      root, join(root, 'dir'), join(root, 'dir', 'file.txt'), join(root, 'missing', 'x'),
      join(root, 'dir', 'file.txt', 'x'), join(root, '..', 'elsewhere'), join(root, 'dir', 'file-link.txt'),
      join(root, 'linked', 'file.txt'), join(root, 'linked', 'sub', 'deep.txt'), join(root, 'dir', 'sub-link'),
    ].map((path) => paths.kind(path));
    assert.deepEqual(kinds, ['directory', 'directory', 'file', undefined, undefined, 'outside', 'file', 'symlink', 'symlink', 'symlink']);
    assert.deepEqual([...paths.skippedLinks].sort(), [join(root, 'dir', 'sub-link'), join(root, 'linked')]);
  });
});

test('FIFO는 기다리거나 내용을 읽지 않고 일반 파일이 아닌 입력으로 거부한다', {
  skip: process.platform === 'win32',
}, () => {
  withProject({}, (root) => {
    const path = join(root, 'pipe.ts');
    const created = spawnSync('mkfifo', [path], { timeout: 1000 });
    assert.equal(created.status, 0);
    const reader = new ProjectReader();
    assert.equal(reader.read(path), undefined);
    assert.equal(reader.unreadable, 1);
  });
});
