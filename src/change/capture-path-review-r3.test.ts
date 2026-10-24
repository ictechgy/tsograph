import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { runCli } from '../cli/run-cli.ts';
import { CaptureError, capture } from './capture.ts';

/** 파일시스템에 invalid byte 이름을 만들지 않고 Git 원시 tree 객체를 조립한다. */
function rawTreeFixture(names: readonly Buffer[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-capture-path-r3-')));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args: readonly string[], input?: Buffer) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env, windowsHide: true, ...(input === undefined ? {} : { input }),
  });
  git(['init', '-q', '--object-format=sha1', '--template=']);
  const entries = [...names].sort(Buffer.compare).map((name, index) => {
    const blob = git(['hash-object', '-w', '--stdin'], Buffer.from(`export const item${index} = ${index};\n`)).toString('ascii').trim();
    return Buffer.concat([Buffer.from('100644 '), name, Buffer.from([0]), Buffer.from(blob, 'hex')]);
  });
  const tree = git(['hash-object', '-w', '-t', 'tree', '--stdin'], Buffer.concat(entries)).toString('ascii').trim();
  const commit = git(['commit-tree', tree, '-m', 'synthetic raw path fixture']).toString('ascii').trim();
  return { root, commit, git, close: () => rmSync(root, { recursive: true, force: true }) };
}

const invalidNames = () => [Buffer.concat([Buffer.from('f'), Buffer.from([0xff]), Buffer.from('.ts')]),
  Buffer.concat([Buffer.from('f'), Buffer.from([0xfe]), Buffer.from('.ts')]), Buffer.from('f\uFFFD.ts')];

test('서로 다른 invalid Git 이름을 valid U+FFFD 이름으로 lossy 합치지 않고 캡처를 거부한다', () => {
  const f = rawTreeFixture(invalidNames());
  try { assert.throws(() => capture(f.root, f.commit), (error: unknown) => error instanceof CaptureError && /UTF-8/u.test(error.message)); }
  finally { f.close(); }
});

test('invalid Git path의 change-impact 입력은 stdout 없는 코드2이며 원문을 노출하지 않는다', async () => {
  const f = rawTreeFixture(invalidNames());
  try {
    const result = await runCli(['change-impact', '--project', f.root, '--base', f.commit, '--head', f.commit], {
      fileSystem: createNodeFileSystem(), toolVersion: 'test', now: () => new Date(0),
    });
    assert.equal(result.exitCode, 2);
    assert.equal(result.standardOutput, '');
    assert.ok(!result.standardError.includes('\uFFFD'));
  } finally { f.close(); }
});

test('valid U+FFFD와 첫 BOM 이름은 Git 객체·working-tree 모두 opaque identity로 보존한다', () => {
  const f = rawTreeFixture([Buffer.from('f\uFFFD.ts'), Buffer.from('\uFEFFfirst.ts'), Buffer.from('first.ts')]);
  try {
    const committed = capture(f.root, f.commit);
    assert.equal(committed.files.size, 3); assert.equal(committed.omitted, 0);
    assert.ok(committed.files.has('f\uFFFD.ts') && committed.files.has('\uFEFFfirst.ts') && committed.files.has('first.ts'));
    writeFileSync(join(f.root, '\uFEFFfirst.ts'), 'export const bom = true;');
    f.git(['add', '--', '\uFEFFfirst.ts']);
    const working = capture(f.root);
    assert.deepEqual([...working.files.keys()], ['\uFEFFfirst.ts']);
    assert.equal(working.omitted, 0);
  } finally { f.close(); }
});
