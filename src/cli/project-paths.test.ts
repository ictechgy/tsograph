/** CLI 명령이 함께 쓰는 프로젝트 루트·프로젝트 안 입력 파일 검증의 분류(64/2)와 문구 형식을 고정한다. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { MAX_GRAPH_CONFIG_BYTES } from '../graph/bounded-config-reader.ts';
import type { CommandResult } from './command-result.ts';
import { type CommandFileSystem, createNodeFileSystem } from './file-system.ts';
import {
  checkCompilerConfig,
  type ProjectFileRule,
  projectRelativePath,
  resolveProjectFile,
  resolveProjectRoot,
} from './project-paths.ts';

/** 검사용 사용법이다. 사용 오류 문구 끝에 붙는지 본다. */
const usage = 'Usage: tsograph example --project <root>\n';

/** 검사용 입력 파일 규칙이다. */
const rule: ProjectFileRule = {
  subject: 'the example file',
  unreadable: 'unable to read the example file; pass an existing readable file.',
  outsideRemedy: 'move it under the project root.',
  usage,
};

/** 임시 배치의 경로다. */
interface Layout {
  readonly root: string;
  readonly project: string;
  readonly outside: string;
}

/**
 * `project/`(안 입력 파일 `sub/input.json`)와 형제 `outside/`·`project-other/`(밖 입력 파일)를 만든 뒤 지운다.
 *
 * @param run 배치를 받는 검사
 */
async function withLayout(run: (layout: Layout) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-project-paths-')));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  for (const directory of [join(project, 'sub'), outside, join(root, 'project-other')]) mkdirSync(directory, { recursive: true });
  for (const file of [join(project, 'sub/input.json'), join(outside, 'input.json'), join(root, 'project-other/input.json')]) {
    writeFileSync(file, '{}');
  }
  try {
    await run({ root, project, outside });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 결과가 경로 원문 없는 실패인지 확인한다.
 *
 * @param result 검사할 결과
 * @param exitCode 기대 종료 코드
 * @param root 문구에 나오면 안 되는 임시 디렉터리
 */
function assertFailure(result: unknown, exitCode: 2 | 64, root: string): asserts result is CommandResult {
  assert.ok(typeof result === 'object' && result !== null && 'exitCode' in result, JSON.stringify(result));
  const failure = result as CommandResult;
  assert.equal(failure.exitCode, exitCode, failure.standardError);
  assert.equal(failure.standardOutput, '');
  assert.match(failure.standardError, /^tsograph: /u);
  assert.ok(!failure.standardError.includes(root), failure.standardError);
}

test('프로젝트 안 입력 파일은 상대·절대 경로 모두 realpath·프로젝트 기준 POSIX 경로·상태를 돌려준다', async () => {
  await withLayout(async ({ project }) => {
    const fileSystem = createNodeFileSystem();
    for (const argument of ['sub/input.json', './sub/../sub/input.json', join(project, 'sub/input.json')]) {
      const file = await resolveProjectFile(fileSystem, project, argument, rule);
      assert.ok(!('exitCode' in file), argument);
      assert.equal(file.path, join(project, 'sub/input.json'), argument);
      assert.equal(file.projectPath, 'sub/input.json', argument);
      assert.equal(file.status.kind, 'file', argument);
      assert.equal(file.status.size, 2, argument);
    }
  });
});

test('realpath가 --project 밖인 입력 파일은 경로를 싣지 않은 같은 형식의 사용 오류(64)다', async () => {
  await withLayout(async ({ root, project, outside }) => {
    const fileSystem = createNodeFileSystem();
    const arguments_ = ['../outside/input.json', join(outside, 'input.json'), '../project-other/input.json'];
    if (process.platform !== 'win32') {
      // 프로젝트 안 링크가 밖 파일을 가리키면 링크 위치가 아니라 대상의 realpath로 판정한다.
      symlinkSync(join(outside, 'input.json'), join(project, 'link.json'));
      arguments_.push('link.json');
    }
    for (const argument of arguments_) {
      const result = await resolveProjectFile(fileSystem, project, argument, rule);
      assertFailure(result, 64, root);
      assert.equal(result.standardError, `tsograph: the example file is outside --project; move it under the project root.\n${usage}`);
    }
  });
});

test('없음·디렉터리·상태 실패는 밖을 가리켜도 입력 실패(2)다', async () => {
  await withLayout(async ({ root, project }) => {
    const actual = createNodeFileSystem();
    const statusFails: CommandFileSystem = { ...actual, status: async () => { throw new Error(`PRIVATE ${root}`); } };
    const cases: [CommandFileSystem, string][] = [
      [actual, 'missing.json'],
      [actual, '../outside/missing.json'],
      [actual, 'sub'],
      [actual, '../outside'],
      [actual, '.'],
      [statusFails, 'sub/input.json'],
    ];
    for (const [fileSystem, argument] of cases) {
      const result = await resolveProjectFile(fileSystem, project, argument, rule);
      assertFailure(result, 2, root);
      assert.equal(result.standardError, `tsograph: ${rule.unreadable}\n`, argument);
    }
  });
});

test('--project 루트는 읽을 수 있는 디렉터리여야 하고 교환 형식이 금지하는 문자가 없어야 한다', async () => {
  await withLayout(async ({ root, project }) => {
    const actual = createNodeFileSystem();
    assert.equal(await resolveProjectRoot(actual, join(project, 'sub/..'), 'pass the project root.'), project);
    for (const argument of [join(root, 'missing'), join(project, 'sub/input.json')]) {
      const result = await resolveProjectRoot(actual, argument, 'pass the join root to scan.');
      assertFailure(result, 2, root);
      assert.equal(result.standardError, 'tsograph: --project does not name a readable directory; pass the join root to scan.\n');
    }
    const unsafe: CommandFileSystem = {
      ...actual,
      realPath: async () => '/tmp/unsafe\u0085project',
      status: async () => ({ kind: 'directory', size: 0, modifiedAt: new Date(0) }),
    };
    const result = await resolveProjectRoot(unsafe, project, 'pass the project root.');
    assertFailure(result, 2, root);
    assert.match(result.standardError, /exchange format forbids/u);
  });
});

test('프로젝트 기준 경로는 루트 자신·조상·이름 접두사가 같은 형제를 밖으로 본다', () => {
  assert.equal(projectRelativePath('/work/app', '/work/app/src/a.ts'), 'src/a.ts');
  for (const target of ['/work/app', '/work', '/work/app-other/a.ts', '/other/a.ts']) {
    assert.equal(projectRelativePath('/work/app', target), undefined, target);
  }
});

test('--tsconfig 검사는 --project 안의 1 MiB 이하 일반 파일만 받고 상한+1은 입력 실패, 밖은 사용 오류다', async () => {
  await withLayout(async ({ root, project }) => {
    const fileSystem = createNodeFileSystem();
    writeFileSync(join(project, 'exact.json'), Buffer.alloc(MAX_GRAPH_CONFIG_BYTES, 0x20));
    writeFileSync(join(project, 'over.json'), Buffer.alloc(MAX_GRAPH_CONFIG_BYTES + 1, 0x20));
    assert.equal(await checkCompilerConfig(fileSystem, project, 'exact.json', usage), undefined);
    assert.equal(await checkCompilerConfig(fileSystem, project, join(project, 'sub/input.json'), usage), undefined);

    const oversized = await checkCompilerConfig(fileSystem, project, 'over.json', usage);
    assertFailure(oversized, 2, root);
    assert.match(oversized.standardError, new RegExp(`exceeds ${MAX_GRAPH_CONFIG_BYTES} bytes`, 'u'));

    const outside = await checkCompilerConfig(fileSystem, project, '../outside/input.json', usage);
    assertFailure(outside, 64, root);
    assert.match(outside.standardError, /^tsograph: the --tsconfig file is outside --project; [^\n]+\nUsage: tsograph example /u);

    const missing = await checkCompilerConfig(fileSystem, project, 'missing.json', usage);
    assertFailure(missing, 2, root);
    assert.match(missing.standardError, /--tsconfig must name a readable compiler config file inside --project/u);
  });
});
