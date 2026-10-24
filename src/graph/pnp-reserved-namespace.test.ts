import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { runCli } from '../cli/run-cli.ts';
import { StaticPnp } from './static-pnp.ts';
import { makeZip } from './pnp-testing.test.ts';

const fixture = fileURLToPath(new URL('../../fixtures/pnp/yarn-generated/', import.meta.url));

/** 실제 Yarn 정상 대조군과 예약 이름의 합성 파일을 임시 경계 안에 둔다. */
async function withFixture(body: (root: string) => void | Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-pnp-reserved-')));
  try {
    cpSync(fixture, root, { recursive: true }); mkdirSync(join(root, '.tsograph-pnp'));
    writeFileSync(join(root, '.tsograph-pnp/private.d.ts'), 'export declare const privateValue: "PRIVATE";');
    writeFileSync(join(root, '.tsograph-pnp/private.zip'), makeZip([
      { name: 'hidden/index.d.ts', text: 'export declare function leaked(): "PRIVATE";' },
      { name: 'hidden/nested/index.d.ts', text: 'export declare const nested: true;' },
    ]));
    await body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('미매핑 예약 namespace의 virtual 사상은 readFile/fileExists 정책을 우회하지 않는다', async () => {
  await withFixture(root => {
    const host = new StaticPnp(root).wrapHost(ts.sys);
    const virtual = join(root, '.tsograph-pnp/__virtual__/x/0/private.d.ts');
    assert.equal(host.fileExists(virtual), false);
    assert.equal(host.readFile(virtual), undefined);
    assert.equal(host.directoryExists!(dirname(virtual)), false);
    assert.deepEqual(host.getDirectories!(dirname(virtual)), []);
  });
});

for (const method of ['readFile', 'fileExists', 'directoryExists', 'getDirectories'] as const) test(`미매핑 예약 ZIP을 ${method}로 공개하지 않는다`, async () => {
  await withFixture(root => {
    const host = new StaticPnp(root).wrapHost(ts.sys), archive = join(root, '.tsograph-pnp/private.zip');
    if (method === 'readFile') assert.equal(host.readFile(join(archive, 'hidden/index.d.ts')), undefined);
    if (method === 'fileExists') assert.equal(host.fileExists(join(archive, 'hidden/index.d.ts')), false);
    if (method === 'directoryExists') assert.equal(host.directoryExists!(join(archive, 'hidden')), false);
    if (method === 'getDirectories') assert.deepEqual(host.getDirectories!(join(archive, 'hidden')), []);
  });
});

test('metadata가 실제 매핑한 메모리 overlay의 Yarn ZIP과 합성 directory는 계속 제공한다', async () => {
  await withFixture(root => {
    const pnp = new StaticPnp(root);
    const resolved = pnp.resolveModule('@fixture/client', join(root, 'src/main.ts'), { moduleResolution: ts.ModuleResolutionKind.Bundler }, ts.sys);
    assert.ok(resolved?.resolvedFileName.includes('.zip'));
    const host = pnp.wrapHost(ts.sys), alias = join(root, '.tsograph-pnp/0/node_modules/@fixture/client');
    assert.equal(host.fileExists(join(alias, 'index.d.ts')), true);
    assert.match(host.readFile(join(alias, 'index.d.ts'))!, /zip-peer/u);
    assert.equal(host.directoryExists!(alias), true);
    assert.deepEqual(host.getDirectories!(dirname(alias)), ['client']);
    assert.deepEqual(pnp.issues, []);
  });
});

test('실제 graph producer는 예약 ZIP의 상대 import를 정상 의존성으로 보고하지 않는다', async () => {
  await withFixture(async root => {
    writeFileSync(join(root, 'src/main.ts'), 'import {leaked} from "../.tsograph-pnp/private.zip/hidden/index"; export const result = leaked();');
    const result = await runCli(['graph', '--project', root], { fileSystem: createNodeFileSystem(), toolVersion: 'test', now: () => new Date(0) });
    assert.equal(result.exitCode, 0);
    const document = JSON.parse(result.standardOutput) as { statistics: { calls: { external: number; missingDependencies: number; unresolved: { 'unresolved-import': number; untyped: number } } } };
    assert.equal(document.statistics.calls.external, 0);
    assert.equal(document.statistics.calls.missingDependencies, 0);
    assert.equal(document.statistics.calls.unresolved['unresolved-import'], 1);
    assert.equal(document.statistics.calls.unresolved.untyped, 0);
  });
});
