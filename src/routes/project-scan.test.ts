import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { type CommandFileSystem, createNodeFileSystem } from '../cli/file-system.ts';
import { locateRouterDirectories, lookupEntry } from './project-scan.ts';

test('lookupEntry는 어느 구성 요소의 symlink도 따라가지 않는다', async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-scan-')));
  try {
    writeFileSync(join(project, 'src'), 'a file, not a directory');
    mkdirSync(join(project, 'real'));
    symlinkSync(join(project, 'real'), join(project, 'linked'));
    symlinkSync(join(project, 'gone'), join(project, 'dangling'));
    const fileSystem = createNodeFileSystem();
    assert.deepEqual(await lookupEntry(fileSystem, project, 'src/app'), { kind: 'absent' });
    assert.deepEqual(await lookupEntry(fileSystem, project, 'src'), { kind: 'file' });
    assert.deepEqual(await lookupEntry(fileSystem, project, 'linked/app'), { kind: 'symlink', symlinkPath: 'linked' });
    assert.deepEqual(await lookupEntry(fileSystem, project, 'dangling'), { kind: 'dangling' });
    assert.deepEqual(await lookupEntry(fileSystem, project, 'missing'), { kind: 'absent' });
    const unlisted: CommandFileSystem = { ...fileSystem, listDirectory: async () => { throw new Error('EACCES'); } };
    assert.deepEqual(await lookupEntry(unlisted, project, 'app'), { kind: 'absent' });
    assert.deepEqual(await locateRouterDirectories(fileSystem, project), { appDirectory: undefined, pagesDirectory: undefined, symlinkedLocations: [] });
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
