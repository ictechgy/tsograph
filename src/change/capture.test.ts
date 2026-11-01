/**
 * Git 객체·작업 트리 캡처가 링크·위험 경로·잘못된 입력을 따라가거나 받아들이지 않는지 검증한다.
 * fixture는 임시 디렉터리에 합성한 저장소만 쓴다.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CaptureError, capture, contentDigest } from './capture.ts';

/** 전역 설정·hook 없이 합성 저장소를 만든다. */
function repository() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-capture-')));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args: readonly string[], input?: Buffer) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env, windowsHide: true, ...(input === undefined ? {} : { input }),
  });
  git(['init', '-q', '--object-format=sha1', '--template=']);
  /** (mode, 이름, 내용) 항목만 담은 tree로 커밋을 만든다. */
  const commitTree = (entries: readonly (readonly [string, string, string])[]): string => {
    const rows = [...entries].sort(([, a], [, b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([mode, name, content]) => {
      const blob = git(['hash-object', '-w', '--stdin'], Buffer.from(content)).toString('ascii').trim();
      return Buffer.concat([Buffer.from(`${mode} ${name}`), Buffer.from([0]), Buffer.from(blob, 'hex')]);
    });
    const tree = git(['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], Buffer.concat(rows)).toString('ascii').trim();
    return git(['commit-tree', tree, '-m', 'synthetic capture fixture']).toString('ascii').trim();
  };
  return { root, git, commitTree, close: () => rmSync(root, { recursive: true, force: true }) };
}

test('committed symlink entries are omitted instead of being read as source', () => {
  const repo = repository();
  try {
    const commit = repo.commitTree([
      ['100644', 'main.ts', 'export const main = 1;\n'],
      ['100755', 'tool.ts', 'export const tool = 1;\n'],
      ['120000', 'link.ts', 'main.ts'],
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
      const commit = repo.commitTree([['100644', 'main.ts', 'export {};\n'], ['100644', name, 'export {};\n']]);
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
