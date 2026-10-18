import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { linkToDevZero, makeFifo, runNodeGuarded } from '../cli/testing.test.ts';
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

test('옛 git의 symlink HEAD는 계속 따라간다', { skip: process.platform === 'win32' }, () => {
  withFiles({ 'p/.git/refs/heads/main': `${sha}\n` }, (root) => {
    symlinkSync('refs/heads/main', join(root, 'p/.git/HEAD'));
    assert.equal(readGitRevision(join(root, 'p')), sha);
  });
});

test('FIFO·장치 링크인 .git·HEAD·commondir·ref·packed-refs는 기다리거나 끝없이 읽지 않고 revision 없음이다', {
  skip: process.platform === 'win32',
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-git-special-')));
  try {
    for (const name of ['a', 'b', 'c', 'd']) mkdirSync(join(root, name, '.git/refs/heads'), { recursive: true });
    mkdirSync(join(root, 'e'));
    makeFifo(join(root, 'a/.git/HEAD'));
    linkToDevZero(join(root, 'b/.git/HEAD'));
    writeFileSync(join(root, 'c/.git/HEAD'), 'ref: refs/heads/main\n');
    makeFifo(join(root, 'c/.git/commondir'));
    writeFileSync(join(root, 'd/.git/HEAD'), 'ref: refs/heads/main\n');
    linkToDevZero(join(root, 'd/.git/refs/heads/main'));
    makeFifo(join(root, 'd/.git/packed-refs'));
    makeFifo(join(root, 'e/.git'));
    // 수정 전 코드는 이 입력에서 멈추거나 메모리를 끝없이 쓰므로 감시하는 자식 프로세스에서 읽는다.
    const module = new URL('./git-revision.ts', import.meta.url).href;
    const script = `import { readGitRevision } from ${JSON.stringify(module)};\n`
      + 'process.stdout.write(JSON.stringify(process.argv.slice(1).map((project) => readGitRevision(project) ?? null)));';
    const projects = ['a', 'b', 'c', 'd', 'e'].map((name) => join(root, name));
    const result = await runNodeGuarded(['--input-type=module', '-e', script, ...projects]);
    assert.equal(result.stopped, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [null, null, null, null, null]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
