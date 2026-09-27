import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { readGitRevision } from './git-revision.ts';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);

/**
 * 임시 디렉터리에 파일을 만들고 콜백 뒤 지운다.
 *
 * @param files 상대 경로 → 내용
 * @param body 콜백
 */
function withFiles(files: Record<string, string>, body: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-git-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('HEAD의 loose ref·packed-refs·분리 HEAD를 읽는다', () => {
  withFiles({ 'p/.git/HEAD': 'ref: refs/heads/main\n', 'p/.git/refs/heads/main': `${sha}\n` }, (root) => {
    assert.equal(readGitRevision(join(root, 'p')), sha);
  });
  withFiles({ 'p/.git/HEAD': 'ref: refs/heads/main\n', 'p/.git/packed-refs': `# pack\n${other} refs/heads/dev\n${sha} refs/heads/main\n` }, (root) => {
    assert.equal(readGitRevision(join(root, 'p')), sha);
  });
  withFiles({ 'p/.git/HEAD': `${sha}\n` }, (root) => assert.equal(readGitRevision(join(root, 'p')), sha));
});

test('worktree의 gitdir·commondir를 따라가고, 저장소가 없거나 깨졌으면 undefined다', () => {
  withFiles({
    'p/.git': 'gitdir: ../repo/.git/worktrees/p\n',
    'repo/.git/worktrees/p/HEAD': 'ref: refs/heads/feature\n',
    'repo/.git/worktrees/p/commondir': '../..\n',
    'repo/.git/refs/heads/feature': `${other}\n`,
  }, (root) => assert.equal(readGitRevision(join(root, 'p')), other));
  withFiles({ 'p/x.txt': '' }, (root) => assert.equal(readGitRevision(join(root, 'p')), undefined));
  withFiles({ 'p/.git/HEAD': 'garbage' }, (root) => assert.equal(readGitRevision(join(root, 'p')), undefined));
  withFiles({ 'p/.git/HEAD': 'ref: refs/heads/none\n' }, (root) => assert.equal(readGitRevision(join(root, 'p')), undefined));
  withFiles({ 'p/.git/x': '' }, (root) => assert.equal(readGitRevision(join(root, 'p')), undefined));
  withFiles({ 'p/.git': 'not a pointer' }, (root) => assert.equal(readGitRevision(join(root, 'p')), undefined));
});
