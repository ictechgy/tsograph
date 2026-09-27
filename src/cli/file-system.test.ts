import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
