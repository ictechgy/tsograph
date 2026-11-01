/**
 * Git 객체·작업 트리 캡처가 링크·위험 경로·잘못된 입력을 따라가거나 받아들이지 않는지 검증한다.
 * fixture는 임시 디렉터리에 합성한 저장소만 쓴다.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative } from 'node:path';
import { test } from 'node:test';

import { CaptureError, capture, contentDigest } from './capture.ts';
import { gitFixture as repository } from './git-fixture.test.ts';

test('committed symlink entries are omitted instead of being read as source', () => {
  const repo = repository();
  try {
    const commit = repo.commitTree([
      { mode: '100644', name: 'main.ts', content: 'export const main = 1;\n' },
      { mode: '100755', name: 'tool.ts', content: 'export const tool = 1;\n' },
      { mode: '120000', name: 'link.ts', content: 'main.ts' },
    ]);
    const captured = capture(repo.root, commit);
    assert.deepEqual([...captured.files.keys()].sort(), ['main.ts', 'tool.ts']);
    assert.equal(captured.omitted, 1);
    assert.equal(captured.kind, 'git');
    assert.equal(captured.revision, commit);
  } finally { repo.close(); }
});

test('working-tree symlinks to files and directories are omitted and never followed', { skip: process.platform === 'win32' }, () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.root, 'main.ts'), 'export const main = 1;\n');
    mkdirSync(join(repo.root, 'real'));
    writeFileSync(join(repo.root, 'real', 'inner.ts'), 'export const inner = 1;\n');
    symlinkSync('main.ts', join(repo.root, 'link.ts'));
    symlinkSync('real', join(repo.root, 'linked'));
    const captured = capture(repo.root);
    assert.deepEqual([...captured.files.keys()].sort(), ['main.ts', 'real/inner.ts']);
    assert.equal(captured.omitted, 2);
    assert.equal(captured.kind, 'working-tree');
    assert.equal(captured.revision, undefined);
  } finally { repo.close(); }
});

test('reserved device names, trailing dots and Git metadata paths in a tree are rejected', () => {
  for (const name of ['con.ts', 'trailing.', '.git']) {
    const repo = repository();
    try {
      const commit = repo.commitTree([{ mode: '100644', name: 'main.ts', content: 'export {};\n' }, { mode: '100644', name, content: 'export {};\n' }]);
      assert.throws(() => capture(repo.root, commit),
        (error: unknown) => error instanceof CaptureError && /unsupported path spelling/u.test(error.message), name);
    } finally { repo.close(); }
  }
});

test('non-repository roots and unknown revisions fail without exposing Git output', () => {
  const plain = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-capture-plain-')));
  try {
    assert.throws(() => capture(plain), (error: unknown) => error instanceof CaptureError && /Git repository root/u.test(error.message));
  } finally { rmSync(plain, { recursive: true, force: true }); }

  const repo = repository();
  try {
    assert.throws(() => capture(repo.root, 'no-such-revision'),
      (error: unknown) => error instanceof CaptureError && error.message === 'Git capture failed (requires Git 2.45+, local objects and a repository root)');
  } finally { repo.close(); }
});

test('content digest is independent of insertion order and sensitive to path and bytes', () => {
  const first = new Map([['b.ts', Buffer.from('b')], ['a.ts', Buffer.from('a')]]);
  const reordered = new Map([['a.ts', Buffer.from('a')], ['b.ts', Buffer.from('b')]]);
  const renamed = new Map([['a.ts', Buffer.from('a')], ['c.ts', Buffer.from('b')]]);
  const edited = new Map([['a.ts', Buffer.from('a')], ['b.ts', Buffer.from('B')]]);
  assert.match(contentDigest(first), /^sha256:[0-9a-f]{64}$/u);
  assert.equal(contentDigest(first), contentDigest(reordered));
  assert.notEqual(contentDigest(first), contentDigest(renamed));
  assert.notEqual(contentDigest(first), contentDigest(edited));
});

/** 실제 git 위치다. 심은 git은 표식을 남긴 뒤 실제 git으로 넘겨, 선택되면 캡처가 성공해도 표식으로 드러난다. */
function realGit(): string {
  return realpathSync(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());
}

/** directory/git에 표식을 남기는 실행 파일을 심는다. */
function plantGit(directory: string, marker: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'git'), `#!/bin/sh\necho ran >> '${marker}'\nexec '${realGit()}' "$@"\n`, { mode: 0o755 });
}

/** PATH를 바꾼 채 실행하고 원래 값으로 되돌린다. */
function withPath<T>(entries: readonly string[], run: () => T): T {
  const original = process.env.PATH;
  process.env.PATH = entries.join(delimiter);
  try { return run(); } finally { process.env.PATH = original; }
}

const unavailable = (error: unknown) => error instanceof CaptureError && /trusted Git executable unavailable/u.test(error.message);

test('a git executable planted inside the project is never selected', { skip: process.platform === 'win32' }, () => {
  const repo = repository();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-capture-marker-')));
  try {
    writeFileSync(join(repo.root, 'main.ts'), 'export const main = 1;\n');
    const marker = join(outside, 'planted-ran');
    plantGit(join(repo.root, 'bin'), marker);
    assert.throws(() => withPath([join(repo.root, 'bin')], () => capture(repo.root)), unavailable);
    const captured = withPath([join(repo.root, 'bin'), dirname(realGit())], () => capture(repo.root));
    assert.ok(captured.files.has('main.ts'));
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    repo.close();
  }
});

test('relative PATH entries and the current directory are skipped even when they hold a git outside the project', { skip: process.platform === 'win32' }, () => {
  const repo = repository();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-capture-outside-')));
  const originalDirectory = process.cwd();
  try {
    writeFileSync(join(repo.root, 'main.ts'), 'export const main = 1;\n');
    const marker = join(outside, 'planted-ran');
    const plantedDirectory = join(outside, 'bin');
    plantGit(plantedDirectory, marker);

    const relativeEntry = relative(process.cwd(), plantedDirectory);
    assert.ok(!relativeEntry.startsWith('/'));
    assert.throws(() => withPath([relativeEntry], () => capture(repo.root)), unavailable);
    assert.ok(withPath([relativeEntry, dirname(realGit())], () => capture(repo.root)).files.has('main.ts'));
    assert.equal(existsSync(marker), false, 'relative PATH entry');

    process.chdir(plantedDirectory);
    assert.throws(() => withPath([plantedDirectory], () => capture(repo.root)), unavailable);
    assert.ok(withPath([plantedDirectory, dirname(realGit())], () => capture(repo.root)).files.has('main.ts'));
    assert.equal(existsSync(marker), false, 'current-directory PATH entry');
  } finally {
    process.chdir(originalDirectory);
    rmSync(outside, { recursive: true, force: true });
    repo.close();
  }
});

test('a differently cased PATH spelling of the project is still recognized as inside it', { skip: process.platform === 'win32' }, (t) => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-capture-case-')));
  try {
    const repo = repository(join(parent, 'Proj'));
    const alternate = join(parent, 'proj');
    if (!existsSync(alternate)) {
      // 대소문자를 구분하는 파일 시스템에서는 다른 표기가 같은 디렉터리를 가리킬 수 없다.
      assert.equal(existsSync(join(parent, 'Proj')), true);
      t.skip('case-sensitive filesystem: differently cased spelling does not name the project');
      return;
    }
    writeFileSync(join(repo.root, 'main.ts'), 'export const main = 1;\n');
    const marker = join(parent, 'planted-ran');
    plantGit(join(repo.root, 'bin'), marker);
    for (const root of [repo.root, alternate]) {
      assert.throws(() => withPath([join(alternate, 'bin')], () => capture(root)), unavailable, root);
      const captured = withPath([join(alternate, 'bin'), join(repo.root, 'bin'), dirname(realGit())], () => capture(root));
      assert.ok(captured.files.has('main.ts'), root);
      assert.equal(existsSync(marker), false, root);
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
});
