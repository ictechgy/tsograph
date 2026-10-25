import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep, win32 } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { StaticPnp } from './static-pnp.ts';

const fixture = fileURLToPath(new URL('../../fixtures/pnp/yarn-generated/', import.meta.url));

/** 공개 Yarn fixture와 SDK만 쓰고 각 사례의 임시 경계를 따로 만든다. */
function withFixture(body: (root: string) => void): void {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-pnp-path-normalization-')));
  try { cpSync(fixture, root, { recursive: true }); body(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

/** 상대·dot·Windows slash 표기는 OS 절대 경로로 정규화한 뒤 mapping 여부를 판단해야 한다. */
function spellings(path: string): string[] {
  return [...new Set([path, relative(process.cwd(), path), `${dirname(path)}${sep}.${sep}${path.slice(dirname(path).length + 1)}`,
    ...(process.platform === 'win32' ? [path.replaceAll('\\', '/')] : [])])];
}

test('Windows TypeScript slash 표기의 정규화는 PnP 위치 mapping이 아니다', () => {
  const compiler = 'D:/a/tool/node_modules/typescript/lib/lib.es5.d.ts';
  const native = 'D:\\a\\tool\\node_modules\\typescript\\lib\\lib.es5.d.ts';
  assert.equal(win32.resolve(compiler), native);
  assert.notEqual(native, compiler, '이전 raw-string 비교는 같은 Windows SDK를 mapping으로 오인한다');
});

test('정규화만 다른 SDK 파일은 기존 lib 예외로 읽고 false outside-boundary를 남기지 않는다', () => {
  withFixture(root => {
    const file = realpathSync(join(dirname(ts.getDefaultLibFilePath({})), 'lib.es5.d.ts'));
    const text = readFileSync(file, 'utf8');
    for (const path of spellings(file)) {
      const pnp = new StaticPnp(root), host = pnp.wrapHost(ts.sys);
      assert.equal(resolve(path), file);
      assert.equal(host.fileExists(path), true);
      assert.equal(host.readFile(path), text);
      assert.deepEqual(pnp.issues, []);
    }
  });
});

test('정규화만 다른 SDK directory 탐침·목록은 동일한 좁은 SDK 정책을 쓴다', () => {
  withFixture(root => {
    const directory = realpathSync(dirname(ts.getDefaultLibFilePath({})));
    for (const path of spellings(directory)) {
      const pnp = new StaticPnp(root), host = pnp.wrapHost(ts.sys);
      assert.equal(host.directoryExists!(path), true);
      assert.deepEqual(host.getDirectories!(path), ts.sys.getDirectories(directory));
      assert.deepEqual(pnp.issues, []);
    }
  });
});

test('정규화로 SDK 밖 읽기나 실제 .tsograph-pnp 파일이 overlay로 승격되지 않는다', () => {
  withFixture(root => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-pnp-path-outside-')));
    try {
      const outside = join(parent, 'outside.d.ts'); writeFileSync(outside, 'export const outside = true;');
      for (const path of spellings(outside)) {
        const pnp = new StaticPnp(root), host = pnp.wrapHost(ts.sys);
        assert.equal(host.fileExists(path), false);
        assert.equal(host.readFile(path), undefined);
        assert.ok(pnp.issues.includes('outside-boundary'));
      }
      const reserved = join(root, '.tsograph-pnp/private.d.ts'); mkdirSync(dirname(reserved)); writeFileSync(reserved, 'export const wrongOverlay = true;');
      for (const path of spellings(reserved)) {
        const pnp = new StaticPnp(root), host = pnp.wrapHost(ts.sys);
        assert.equal(host.fileExists(path), false);
        assert.equal(host.readFile(path), undefined);
        assert.equal(host.directoryExists!(dirname(path)), false);
        assert.deepEqual(host.getDirectories!(dirname(path)), []);
      }
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
