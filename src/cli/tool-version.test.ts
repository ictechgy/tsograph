import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { readToolVersion } from './tool-version.ts';

test('저장소 package.json의 버전을 읽는다', () => {
  assert.match(readToolVersion(), /^\d+\.\d+\.\d+/);
});

test('버전이 없는 package.json은 원인과 해결 방향으로 실패한다', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tsograph-version-'));
  try {
    const packagePath = join(directory, 'package.json');
    writeFileSync(packagePath, '{"name":"x"}');
    assert.throws(() => readToolVersion(pathToFileURL(packagePath)), /reinstall/);
    writeFileSync(packagePath, 'null');
    assert.throws(() => readToolVersion(pathToFileURL(packagePath)), /reinstall/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
