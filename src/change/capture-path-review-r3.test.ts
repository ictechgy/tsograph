import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { runCli } from '../cli/run-cli.ts';
import { CaptureError, capture } from './capture.ts';
import { gitFixture } from './git-fixture.test.ts';

/** 파일시스템에 invalid byte 이름을 만들지 않고 Git 원시 tree 객체를 조립한다. */
function rawTreeFixture(names: readonly Buffer[]) {
  const fixture = gitFixture();
  const entries = [...names].sort(Buffer.compare)
    .map((name, index) => ({ mode: '100644', name, content: `export const item${index} = ${index};\n` }));
  return { ...fixture, commit: fixture.commitTree(entries) };
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
