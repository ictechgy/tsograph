/** 실제 Git patch로 삭제·rename·본문 신선도와 시점 분리를 재현한다. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { runCli } from '../cli/run-cli.ts';
import { capture, contentDigest, materialize } from './capture.ts';
import { analyzeChange, changedFiles } from './impact.ts';

/** Git 저장소 하나를 만들고 검증 뒤 정리한다. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'tsograph-change-test-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  git('init', '-q'); git('config', 'core.autocrlf', 'false'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, 'value.ts'), 'export function value() { return 1; }\n');
  writeFileSync(join(root, 'caller.ts'), "import { value } from './value'; export function caller() { return value(); }\n");
  writeFileSync(join(root, 'test_value.ts'), "import { caller } from './caller'; export function test_value() { return caller(); }\n");
  git('add', '.'); git('commit', '-qm', 'fixture');
  return { root, git, close: () => rmSync(root, { recursive: true, force: true }) };
}
const common = { maxDepth: 128, maxReached: 100_000, dispatch: 'bound' as const, toolVersion: 'test', generatedAt: new Date('2026-10-22T00:00:00Z') };

test('deleted symbol keeps old callers; current graph has no fabricated cross-revision edge', async () => {
  const f = fixture();
  try {
    rmSync(join(f.root, 'value.ts'));
    writeFileSync(join(f.root, 'caller.ts'), 'export function caller() { return 2; }\n');
    const report = await analyzeChange({ ...common, project: f.root, base: 'HEAD' });
    assert.equal(report.status, 'incomplete');
    assert.ok(report.before.traversal.reached.some((row) => row.symbol.usr === 'caller.ts#caller'));
    assert.ok(report.before.traversal.reached.some((row) => row.symbol.usr === 'test_value.ts#test_value'));
    assert.ok(!report.after.traversal.roots.some((row) => row.id === 'value.ts#value'));
    assert.ok(report.before.input.contentDigest !== report.after.input.contentDigest);
    assert.equal(report.before.traversal.revision?.length, 40);
    assert.equal(report.after.input.revision, null);
  } finally { f.close(); }
});

test('body-only dirty edits change content identity; rename preserves both file seeds', async () => {
  const f = fixture();
  try {
    const old = capture(f.root, 'HEAD');
    writeFileSync(join(f.root, 'value.ts'), 'export function value() { return 99; }\n');
    const dirty = capture(f.root);
    assert.notEqual(old.digest, dirty.digest);
    assert.deepEqual(changedFiles(old, dirty).map((row) => row.path), ['value.ts']);
    f.git('checkout', '--', 'value.ts'); renameSync(join(f.root, 'value.ts'), join(f.root, 'renamed.ts'));
    const report = await analyzeChange({ ...common, project: f.root, base: 'HEAD' });
    assert.equal(report.changes.find((row) => row.path === 'renamed.ts')?.renamedFrom, 'value.ts');
    assert.ok(report.before.seeds.some((row) => row.id === 'value.ts#value'));
    assert.ok(report.after.seeds.some((row) => row.id === 'renamed.ts#value'));
  } finally { f.close(); }
});

test('explicit commit head excludes dirty edits and reports depth/output restrictions', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'value.ts'), 'export function value() { return 2; }\n');
    f.git('add', '.'); f.git('commit', '-qm', 'body');
    const report = await analyzeChange({ ...common, maxDepth: 1, maxReached: 1, project: f.root, base: 'HEAD~1', head: 'HEAD' });
    assert.equal(report.after.input.kind, 'git');
    assert.equal(report.limits.maxDepth, 1);
    assert.ok(report.before.traversal.truncated);
    assert.ok(report.before.traversal.truncationReasons?.includes('depth'));
    const capped = await analyzeChange({ ...common, maxReached: 1, project: f.root, base: 'HEAD~1', head: 'HEAD' });
    assert.ok(capped.before.traversal.truncationReasons?.includes('max-reached'));
  } finally { f.close(); }
});

test('unmapped config and empty change sets stay incomplete; capture is content based', async () => {
  const f = fixture();
  try {
    const empty = await analyzeChange({ ...common, project: f.root, base: 'HEAD', head: 'HEAD' });
    assert.equal(empty.changes.length, 0); assert.equal(empty.status, 'incomplete');
    writeFileSync(join(f.root, 'settings.json'), '{"feature":true}');
    const report = await analyzeChange({ ...common, project: f.root, base: 'HEAD' });
    assert.deepEqual(report.after.unmappedFiles, ['settings.json']);
    assert.equal(contentDigest(new Map([['x', Buffer.from('a')]])), contentDigest(new Map([['x', Buffer.from('a')]])));
    assert.notEqual(contentDigest(new Map([['x', Buffer.from('a')]])), contentDigest(new Map([['y', Buffer.from('a')]])));
    const target = join(f.root, 'copy'); materialize(capture(f.root, 'HEAD'), target);
  } finally { f.close(); }
});

test('CLI preserves ID impact and rejects invalid change requests', async () => {
  const env = { fileSystem: createNodeFileSystem(), toolVersion: 'test', now: () => common.generatedAt };
  for (const args of [['change-impact', '--help'], ['help', 'change-impact']]) assert.equal((await runCli(args, env)).exitCode, 0);
  for (const args of [['change-impact'], ['change-impact', '--project', '.', '--base', 'HEAD', '--max-depth', '0'], ['change-impact', '--project', '.', '--base', 'HEAD', '--dispatch', 'bad']]) assert.equal((await runCli(args, env)).exitCode, 64);
  assert.equal((await runCli(['change-impact', '--project', '.', '--base', 'missing-ref-xyz'], env)).exitCode, 2);
  const f = fixture();
  try {
    assert.equal((await runCli(['impact', '--project', f.root, 'value.ts#value'], env)).exitCode, 0);
    const result = await runCli(['change-impact', '--project', f.root, '--base', 'HEAD', '--head', 'HEAD'], env);
    assert.equal(result.exitCode, 0); assert.equal(JSON.parse(result.standardOutput).mode, 'before-after');
    writeFileSync(join(f.root, 'tsconfig.json'), '{"compilerOptions":{}}');
    const report = await analyzeChange({ ...common, project: f.root, base: 'HEAD' });
    assert.ok(report.after.seeds.every((row) => row.reason === 'configuration-wide'));
  } finally { f.close(); }
});
