/** 합성 .gitignore 규칙을 Git의 실제 판정 및 CLI 기본/선택 결과와 대조한다. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { runCli } from '../cli/run-cli.ts';
import { ambientTypesFreeConfig } from '../cli/testing.test.ts';
import { collectProjectFiles } from '../schema/project-files.ts';
import { acceptsGitignoreEntry, GITIGNORE_LIMITS, GitignoreInputError, gitignoreEntryFilter, gitignoreSelectionLimitation, withGitignoreSelection } from './gitignore.ts';

/** 같은 디스크 입력을 읽는 합성 fixture를 만들고 자신이 만든 디렉터리만 정리한다. */
async function fixture(files: Record<string, string | Buffer>, run: (root: string) => void | Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-gitignore-')));
  try {
    for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); }
    await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** Git은 비교 oracle로만 실행하며 대상 소스·hooks·필터를 실행하지 않는다. */
function ignoredByGit(root: string, paths: readonly string[]): Set<string> {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  execFileSync('git', ['-c', 'core.hooksPath=' + devNull, 'init', '--quiet'], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let bytes: Buffer;
  try { bytes = execFileSync('git', ['-c', 'core.hooksPath=' + devNull, '-c', 'core.excludesFile=' + devNull, 'check-ignore', '--no-index', '-z', '--stdin'], { cwd: root, env, input: paths.join('\0') + '\0' }); }
  catch (error) { if ((error as { status: number }).status !== 1) throw error; bytes = (error as { stdout: Buffer }).stdout; }
  return new Set(bytes.toString('utf8').split('\0').filter(Boolean));
}

test('기본은 꺼져 있고 활성화 명령의 중첩·부정·escape·globstar 판정이 실제 Git과 같다', async () => {
  const paths = ['keep.ts', 'generated/drop.ts', 'generated/keep.ts', 'blocked/revive.ts', '#hash.ts', '!bang.ts', 'space .ts',
    'nested/drop.log', 'nested/keep.log', 'nested/deeper/drop.log', 'nested/deeper/keep.log', 'one.tmp', 'nested/two.tmp'];
  await fixture({
    '.gitignore': 'generated/*\n!generated/keep.ts\nblocked/\n\\#hash.ts\n\\!bang.ts\nspace\\ .ts\n**/*.tmp\n*.log\n',
    'nested/.gitignore': '!keep.log\n', 'blocked/.gitignore': '!revive.ts\n',
    ...Object.fromEntries(paths.map(path => [path, 'export const value=1;'])),
  }, root => {
    assert.equal(gitignoreEntryFilter(root), undefined);
    assert.equal(gitignoreSelectionLimitation(), undefined);
    assert.equal(acceptsGitignoreEntry(root, join(root, '#hash.ts')), true);
    const expected = ignoredByGit(root, paths);
    withGitignoreSelection(() => {
      const actual = paths.filter(path => !acceptsGitignoreEntry(root, join(root, path)));
      assert.deepEqual(new Set(actual), expected);
      assert.match(gitignoreSelectionLimitation()!, /project-local/);
      const walk = collectProjectFiles(root, { includeFile: name => name.endsWith('.ts'), excludedDirectories: new Set() });
      assert.deepEqual([...walk.files.keys()], ['generated/keep.ts', 'keep.ts']);
    });
  });
});

test('프로젝트 상위·전역·info excludes·추적 신원은 읽거나 적용하지 않는다', async () => {
  await fixture({ '.gitignore': 'child/\n', 'child/main.ts': 'export function main() {}', 'child/.gitignore': '' }, root => {
    withGitignoreSelection(() => assert.equal(acceptsGitignoreEntry(join(root, 'child'), join(root, 'child/main.ts')), true));
    withGitignoreSelection(() => assert.equal(acceptsGitignoreEntry(root, join(root, 'child/main.ts')), false));
  });
});

test('동시 선택과 기본 호출의 정책·cache는 섞이지 않고 매 명령에서 다시 읽는다', async () => {
  await fixture({ '.gitignore': 'skip.ts\n', 'skip.ts': '' }, async root => {
    const task = withGitignoreSelection(async () => { await Promise.resolve(); return acceptsGitignoreEntry(root, join(root, 'skip.ts')); });
    assert.equal(acceptsGitignoreEntry(root, join(root, 'skip.ts')), true);
    assert.equal(await task, false);
    writeFileSync(join(root, '.gitignore'), '');
    withGitignoreSelection(() => assert.equal(acceptsGitignoreEntry(root, join(root, 'skip.ts')), true));
  });
});

test('잘못된 UTF-8·NUL·파일/줄/전체 규칙 예산 초과는 부분 선택을 내지 않는다', async () => {
  for (const invalid of [Buffer.from([0xff]), Buffer.from('bad\0name'), Buffer.alloc(GITIGNORE_LIMITS.fileBytes + 1, 35),
    'x'.repeat(GITIGNORE_LIMITS.lineLength + 1), 'x\n'.repeat(GITIGNORE_LIMITS.rules + 1)]) {
    await fixture({ '.gitignore': invalid, 'main.ts': '' }, root => {
      assert.equal(acceptsGitignoreEntry(root, join(root, 'main.ts')), true);
      assert.throws(() => withGitignoreSelection(() => acceptsGitignoreEntry(root, join(root, 'main.ts'))), GitignoreInputError);
    });
  }
});

test('경로 탈출·깊이/길이 초과·symlink ignore와 디렉터리를 안전하게 거부한다', async () => {
  await fixture({ 'main.ts': '' }, root => {
    withGitignoreSelection(() => {
      for (const path of [join(root, '../outside.ts'), join(root, ...Array(66).fill('deep'), 'main.ts'), join(root, 'x'.repeat(GITIGNORE_LIMITS.pathLength + 1))]) {
        assert.throws(() => acceptsGitignoreEntry(root, path), GitignoreInputError);
      }
    });
    if (process.platform !== 'win32') {
      symlinkSync(join(root, 'main.ts'), join(root, '.gitignore'));
      assert.throws(() => withGitignoreSelection(() => acceptsGitignoreEntry(root, join(root, 'main.ts'))), GitignoreInputError);
      symlinkSync(root, join(root, 'alias'));
      assert.equal(withGitignoreSelection(() => acceptsGitignoreEntry(root, join(root, 'alias/main.ts'))), false);
    }
  });
});

test('진짜 CLI 분배기는 기본 소스를 보존하고 명시 files도 선택하며 client/서버 사실에 같은 정책을 쓴다', async () => {
  await fixture({
    '.gitignore': 'ignored.ts\napp/api/ignored/\n',
    'package.json': '{"private":true}', 'tsconfig.json': JSON.stringify({ compilerOptions: { types: [], lib: [] }, files: ['kept.ts', 'ignored.ts'] }),
    'kept.ts': "export function kept() { return fetch('/kept'); } export const sql = 'SELECT * FROM kept_rows';", 'ignored.ts': "export function ignored() { return fetch('/ignored'); } export const sql = 'SELECT * FROM ignored_rows';",
    'app/api/kept/route.ts': 'export function GET() {}', 'app/api/ignored/route.ts': 'export function GET() {}',
  }, async root => {
    const env = { fileSystem: createNodeFileSystem(), toolVersion: '0.0.0-test', now: () => new Date('2026-10-01T00:00:00Z') };
    const base = await runCli(['graph', '--project', root], env);
    assert.equal(base.exitCode, 0, base.standardError);
    assert.ok(JSON.parse(base.standardOutput).nodes.some((node: { id: string }) => node.id === 'ignored.ts#ignored'));
    const chosen = await runCli(['graph', '--project', root, '--respect-gitignore'], env);
    assert.equal(chosen.exitCode, 0, chosen.standardError);
    const graph = JSON.parse(chosen.standardOutput);
    assert.ok(graph.nodes.some((node: { id: string }) => node.id === 'kept.ts#kept'));
    assert.ok(graph.nodes.every((node: { id: string }) => !node.id.startsWith('ignored.ts#')));
    assert.ok(graph.limitations.some((line: string) => line.startsWith('gitignore-selection:')));
    for (const command of [['routes', '--role', 'client'], ['schema']]) {
      const original = await runCli([...command, '--project', root], env);
      assert.equal(original.exitCode, 0, original.standardError);
      assert.ok(JSON.parse(original.standardOutput).facts.some((fact: { location?: { path: string } }) => fact.location?.path === 'ignored.ts'), command.join(' ') + original.standardOutput);
      const result = await runCli([...command, '--project', root, '--respect-gitignore'], env);
      assert.equal(result.exitCode, 0, result.standardError);
      const document = JSON.parse(result.standardOutput);
      assert.ok(document.facts.some((fact: { location?: { path: string } }) => fact.location?.path === 'kept.ts'));
      assert.ok(document.facts.every((fact: { location?: { path: string } }) => !fact.location?.path.includes('ignored')));
      assert.ok(document.limitations.some((line: string) => line.startsWith('gitignore-selection:')));
    }
    for (const command of ['reach', 'impact']) {
      const result = await runCli([command, '--project', root, '--respect-gitignore', 'kept.ts#kept'], env);
      assert.equal(result.exitCode, 0, result.standardError);
      assert.ok(JSON.parse(result.standardOutput).limitations.some((line: string) => line.startsWith('gitignore-selection:')));
    }
    const literalId = await runCli(['reach', '--project', root, '--', '--respect-gitignore'], env);
    assert.equal(literalId.exitCode, 64);
    assert.ok(literalId.standardOutput.includes('--respect-gitignore'));
    assert.ok(!literalId.standardOutput.includes('gitignore-selection:'));
    const valueMisuse = await runCli(['graph', '--project', '--respect-gitignore', root], env);
    assert.equal(valueMisuse.exitCode, 64);
    const invalid = await runCli(['graph', '--project', root, '--respect-gitignore', '--respect-gitignore'], env);
    assert.equal(invalid.exitCode, 64);
    const saved = await runCli(['reach', '--graph-file', 'graph.json', '--respect-gitignore', 'root'], env);
    assert.equal(saved.exitCode, 64);
    const ignoredOption = await runCli(['openapi', '--respect-gitignore'], env);
    assert.equal(ignoredOption.exitCode, 64);
    writeFileSync(join(root, '.gitignore'), Buffer.from([0xff]));
    const failed = await runCli(['graph', '--project', root, '--respect-gitignore'], env);
    assert.equal(failed.exitCode, 2); assert.equal(failed.standardOutput, '');
    assert.match(failed.standardError, /\.gitignore could not be read/);
    assert.ok(!failed.standardError.includes(root));
  });
});

test('Next 진입·navigation 등록도 ignore 정책을 공유하고 명시 모델 파일 자체는 계속 읽는다', async () => {
  await fixture({
    '.gitignore': 'app/api/ignored/\nrouter.tsx\nrouter-model.json\n',
    'package.json': '{"private":true}', 'tsconfig.json': ambientTypesFreeConfig,
    'app/api/kept/route.ts': 'export function GET() {}', 'app/api/ignored/route.ts': 'export function GET() {}',
    'router-api.ts': 'export function registerScreens(input: unknown) { return input; }',
    'screen.tsx': 'export function Screen() { return null; }',
    'router.tsx': "import {registerScreens} from './router-api'; import {Screen} from './screen'; registerScreens([{path:'/screen',screen:Screen}]);",
    'router-model.json': JSON.stringify({ format: 'router-models', version: 1, models: [{ factory: { path: 'router-api.ts', name: 'registerScreens' }, routesArgument: 0, pathProperty: 'path', screenProperty: 'screen', childrenProperty: 'children', pathSyntax: 'colon' }] }),
  }, async root => {
    const env = { fileSystem: createNodeFileSystem(), toolVersion: '0.0.0-test', now: () => new Date(0) };
    const server = ['routes', '--project', root, '--role', 'server'];
    const original = await runCli(server, env), selected = await runCli([...server, '--respect-gitignore'], env);
    assert.equal(original.exitCode, 0, original.standardError); assert.equal(selected.exitCode, 0, selected.standardError);
    assert.equal(JSON.parse(original.standardOutput).facts.length, 2);
    assert.equal(JSON.parse(selected.standardOutput).facts.length, 1);
    assert.equal(JSON.parse(selected.standardOutput).facts[0].channel, '/api/kept');
    const navigation = ['navigation', '--project', root, '--router-model', 'router-model.json'];
    const allScreens = await runCli(navigation, env), chosenScreens = await runCli([...navigation, '--respect-gitignore'], env);
    assert.equal(allScreens.exitCode, 0, allScreens.standardError); assert.equal(chosenScreens.exitCode, 0, chosenScreens.standardError);
    assert.equal(JSON.parse(allScreens.standardOutput).facts.length, 1);
    assert.equal(JSON.parse(chosenScreens.standardOutput).facts.length, 0);
    assert.ok(JSON.parse(chosenScreens.standardOutput).limitations.some((line: string) => line.startsWith('navigation-model-coverage:')));
  });
});

test('Git 변경 분석은 각 동결 캡처의 ignore 파일로 고르고 원본 작업 트리를 바꾸지 않는다', async () => {
  await fixture({ '.gitignore': 'ignored.ts\n', 'package.json': '{"private":true}', 'tsconfig.json': ambientTypesFreeConfig,
    'kept.ts': 'export function kept() { return 1; }', 'ignored.ts': 'export function ignored() { return 1; }' }, async root => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
    const git = (args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=' + devNull, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
    git(['init', '--quiet']); git(['add', '--force', '.gitignore', 'package.json', 'tsconfig.json', 'kept.ts', 'ignored.ts']); git(['commit', '--quiet', '-m', 'fixture']);
    const base = git(['rev-parse', 'HEAD']);
    writeFileSync(join(root, 'ignored.ts'), 'export function ignored() { return 2; }');
    const beforeStatus = git(['status', '--porcelain=v1']);
    const cliEnv = { fileSystem: createNodeFileSystem(), toolVersion: '0.0.0-test', now: () => new Date(0) };
    const args = ['change-impact', '--project', root, '--base', base];
    const all = await runCli(args, cliEnv), selected = await runCli([...args, '--respect-gitignore'], cliEnv);
    assert.equal(all.exitCode, 0, all.standardError); assert.equal(selected.exitCode, 0, selected.standardError);
    const original = JSON.parse(all.standardOutput), chosen = JSON.parse(selected.standardOutput);
    assert.ok(original.before.seeds.some((seed: { id?: string }) => seed.id === 'ignored.ts#ignored') || JSON.stringify(original.before).includes('ignored.ts#ignored'));
    assert.ok(!JSON.stringify(chosen.before).includes('ignored.ts#ignored'));
    assert.ok(!JSON.stringify(chosen.after).includes('ignored.ts#ignored'));
    assert.equal(chosen.changes[0].path, 'ignored.ts');
    assert.equal(git(['status', '--porcelain=v1']), beforeStatus);
  });
});

test('여러 규칙 파일의 총 byte와 누적 비교 예산도 전체 선택을 중단한다', async () => {
  const comments = ('#' + 'x'.repeat(4094) + '\n').repeat(15);
  await fixture(Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`d${index}/.gitignore`, comments])), root => {
    assert.throws(() => withGitignoreSelection(() => {
      for (let index = 0; index < 18; index++) acceptsGitignoreEntry(root, join(root, `d${index}/main.ts`));
    }), GitignoreInputError);
  });
  await fixture({ '.gitignore': 'x\n'.repeat(GITIGNORE_LIMITS.rules), 'selected.ts': '' }, root => {
    assert.throws(() => withGitignoreSelection(() => {
      for (let index = 0; index < 2000; index++) acceptsGitignoreEntry(root, join(root, 'selected.ts'));
    }), GitignoreInputError);
  });
});

test('ignore 진입 선택을 완전한 닫힌 프로그램으로 간주해 exported callable 흐름을 확정하지 않는다', async () => {
  await fixture({ '.gitignore': 'ignored.ts\n', 'package.json': '{"private":true}', 'tsconfig.json': ambientTypesFreeConfig,
    'kept.ts': 'export function invoke(cb: () => number) { return cb(); } function known() { return 1; } invoke(known);',
    'ignored.ts': 'export function hidden() { return 2; }' }, async root => {
    const env = { fileSystem: createNodeFileSystem(), toolVersion: '0.0.0-test', now: () => new Date(0) };
    const all = JSON.parse((await runCli(['graph', '--project', root], env)).standardOutput);
    assert.ok(all.edges.some((edge: { from: string; to: string; evidence: string }) => edge.from === 'kept.ts#invoke' && edge.to === 'kept.ts#known' && edge.evidence === 'bound'));
    const result = await runCli(['graph', '--project', root, '--respect-gitignore'], env);
    assert.equal(result.exitCode, 0, result.standardError);
    const selected = JSON.parse(result.standardOutput);
    assert.ok(selected.edges.every((edge: { from: string; evidence: string }) => edge.from !== 'kept.ts#invoke' || edge.evidence !== 'bound'));
    assert.ok(selected.edges.some((edge: { to: string; evidence: string }) => edge.to === 'kept.ts#invoke' && edge.evidence === 'direct'));
    assert.ok(selected.limitations.some((line: string) => line.startsWith('bound-dispatch: the scan is incomplete')));
  });
});
