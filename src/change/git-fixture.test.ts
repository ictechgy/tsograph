/**
 * change 캡처 회귀 테스트가 함께 쓰는 합성 Git 저장소 도우미다. 테스트를 담지 않는다.
 *
 * 전역·시스템 설정과 hook을 끄고, 테스트를 부른 쪽에서 상속된 `GIT_*` 변수(`GIT_DIR`·`GIT_INDEX_FILE` 등)를
 * 지운다. git hook 안에서 테스트가 돌아도 fixture 명령이 바깥 저장소를 건드리지 않게 하려는 것이다(`capture.ts`가
 * 실제 캡처 때 같은 변수를 지우는 것과 같은 이유다).
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 합성 tree 항목 하나다. 이름은 파일 시스템에 만들 수 없는 원시 byte도 쓸 수 있도록 Buffer를 받는다. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string | Buffer;
  readonly content: string;
}

/** 합성 저장소와 그 안에서만 도는 git 실행기다. */
export interface GitFixture {
  readonly root: string;
  readonly git: (args: readonly string[], input?: Buffer) => Buffer;
  /** 항목만 담은 tree로 커밋을 만들어 그 id를 돌려준다(작업 트리는 바꾸지 않는다). */
  readonly commitTree: (entries: readonly TreeEntry[]) => string;
  readonly close: () => void;
}

/**
 * 빈 임시 디렉터리(또는 주어진 새 디렉터리)에 합성 저장소를 만든다.
 * @param root 대소문자 같은 경로 모양을 고정해야 할 때 쓸, 아직 없는 저장소 경로
 * @returns 저장소 도우미
 */
export function gitFixture(root?: string): GitFixture {
  if (root !== undefined) mkdirSync(root);
  const directory = root ?? realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-capture-')));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env = { ...inherited, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args: readonly string[], input?: Buffer): Buffer => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: directory, env, windowsHide: true, ...(input === undefined ? {} : { input }),
  });
  git(['init', '-q', '--object-format=sha1', '--template=']);
  const commitTree = (entries: readonly TreeEntry[]): string => {
    const rows = [...entries]
      .map((entry) => ({ ...entry, name: Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name) }))
      .sort((left, right) => Buffer.compare(left.name, right.name))
      .map(({ mode, name, content }) => {
        const blob = git(['hash-object', '-w', '--stdin'], Buffer.from(content)).toString('ascii').trim();
        return Buffer.concat([Buffer.from(`${mode} `), name, Buffer.from([0]), Buffer.from(blob, 'hex')]);
      });
    // `.git` 같은 이름도 캡처 거부 경로를 검사할 수 있도록 tree 검증을 건너뛴다.
    const tree = git(['hash-object', '-w', '-t', 'tree', '--literally', '--stdin'], Buffer.concat(rows)).toString('ascii').trim();
    return git(['commit-tree', tree, '-m', 'synthetic capture fixture']).toString('ascii').trim();
  };
  return { root: directory, git, commitTree, close: () => rmSync(directory, { recursive: true, force: true }) };
}
