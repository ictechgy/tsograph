import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { type CommandFileSystem, createNodeFileSystem } from '../cli/file-system.ts';
import { readTextFile } from './text-file.ts';

test('텍스트 읽기: BOM 보존, 디렉터리·크기 초과·자라난 파일·비UTF-8은 실패 이유다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tsograph-text-'));
  try {
    const file = join(directory, 'a.ts');
    writeFileSync(file, '﻿export {};');
    const base = createNodeFileSystem();
    assert.deepEqual(await readTextFile(base, file, 100), { kind: 'text', text: '﻿export {};' });
    assert.deepEqual(await readTextFile(base, directory, 100), { kind: 'failure', reason: 'unreadable' });
    assert.deepEqual(await readTextFile(base, file, 3), { kind: 'failure', reason: 'too-large' });
    const grown: CommandFileSystem = { ...base, readBytes: async () => new Uint8Array(200) };
    assert.deepEqual(await readTextFile(grown, file, 100), { kind: 'failure', reason: 'too-large' });
    const latin: CommandFileSystem = { ...base, readBytes: async () => new Uint8Array([0xe9]) };
    assert.deepEqual(await readTextFile(latin, file, 100), { kind: 'failure', reason: 'invalid-utf8' });
    assert.deepEqual(await readTextFile(base, join(directory, 'missing.ts'), 100), { kind: 'failure', reason: 'unreadable' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
