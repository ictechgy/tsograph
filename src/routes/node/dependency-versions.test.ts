/**
 * package.json·잠금 파일에서 주 버전을 읽는 규칙과 프레임워크 감지를 검사한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { Parser } from 'yaml';

import { createNodeFileSystem } from '../../cli/file-system.ts';
import { declaredRanges, lockedVersions, majorOfRange, readProjectDependencies } from './dependency-versions.ts';
import { detectFrameworks, hasNodeFramework } from './node-frameworks.ts';

/**
 * 임시 디렉터리에 파일을 쓰고 의존성을 읽는다.
 *
 * @param files 파일 이름 → 내용
 * @returns 의존성
 */
async function readWith(files: Record<string, string>): Promise<Awaited<ReturnType<typeof readProjectDependencies>>> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-deps-')));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
    return await readProjectDependencies(createNodeFileSystem(), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('범위가 한 주 버전에만 걸릴 때만 주 버전이다', () => {
  assert.equal(majorOfRange('4.21.2'), 4);
  assert.equal(majorOfRange('^5.1.0'), 5);
  assert.equal(majorOfRange('~4.18'), 4);
  assert.equal(majorOfRange('4.x'), 4);
  assert.equal(majorOfRange('4'), 4);
  assert.equal(majorOfRange('>=4.0.0 <5'), 4);
  assert.equal(majorOfRange('npm:express@4.21.2'), 4);
  assert.equal(majorOfRange('^0.1.0'), undefined);
  assert.equal(majorOfRange('>=4 <6'), undefined);
  assert.equal(majorOfRange('latest'), undefined);
  assert.equal(majorOfRange('*'), undefined);
});

test('잠금 파일 형식마다 최상위 설치 버전을 읽는다', () => {
  assert.deepEqual(lockedVersions('package-lock.json', JSON.stringify({ packages: { 'node_modules/express': { version: '5.1.0' } } }), 'express'), ['5.1.0']);
  assert.deepEqual(lockedVersions('npm-shrinkwrap.json', JSON.stringify({ dependencies: { express: { version: '4.21.2' } } }), 'express'), ['4.21.2']);
  assert.deepEqual(lockedVersions('package-lock.json', '{', 'express'), []);
  assert.deepEqual(lockedVersions('pnpm-lock.yaml', "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      hono:\n        specifier: ^4.6.0\n        version: 4.6.14(typescript@5.7.2)\n", 'hono'), ['4.6.14']);
  assert.deepEqual(lockedVersions('pnpm-lock.yaml', 'dependencies:\n  hono: 4.5.0\n', 'hono'), ['4.5.0']);
  assert.deepEqual(lockedVersions('pnpm-lock.yaml', ': : :', 'hono'), []);
  assert.deepEqual(lockedVersions('yarn.lock', '# yarn\n"express@^4.18.0", express@^4.21.0:\n  version "4.21.2"\n\nfastify@^5:\n  version: 5.2.0\n', 'express'), ['4.21.2']);
  assert.deepEqual(lockedVersions('bun.lock', '{ "packages": { "koa": ["koa@3.0.0", "", {}] } }', 'koa'), ['3.0.0']);
});

test('package.json 선언과 잠금 파일을 합쳐 주 버전을 정한다', async () => {
  const locked = await readWith({
    'package.json': JSON.stringify({ dependencies: { express: '*' }, devDependencies: { fastify: '^5.0.0', express: '4' } }),
    'yarn.lock': 'express@*:\n  version "4.21.2"\n',
  });
  assert.equal(locked.manifest, 'parsed');
  assert.equal(locked.majorOf('express'), 4);
  assert.equal(locked.majorOf('fastify'), 5);
  assert.equal(locked.majorOf('hono'), undefined);
  const conflicting = await readWith({
    'package.json': JSON.stringify({ dependencies: { express: '^4.0.0' } }),
    'package-lock.json': JSON.stringify({ packages: { 'node_modules/express': { version: '5.0.0' } } }),
    'yarn.lock': 'express@^4:\n  version "4.21.0"\n',
  });
  assert.equal(conflicting.majorOf('express'), undefined);
  const broken = await readWith({ 'package.json': '{' });
  assert.deepEqual([...broken.declared], []);
  assert.equal(broken.manifest, 'unusable');
  assert.equal((await readWith({ 'a.ts': '' })).manifest, 'absent');
});

test('yarn 머리 줄의 여러 키·따옴표·scope 이름과 버전 없는 항목을 이름마다 그대로 가린다', () => {
  const text = [
    '"@koa/router@^12.0.0", "@koa/router@^12.0.1":', '  version "12.0.2"', '',
    'express@npm:@scope/fork@1.0.0:', '  dependencies:', '    version "0.0.1"', '  version: 4.0.0', '  version: 9.9.9', '',
    'koa-router@^12:', '', 'express@^5:', '  version "5.1.0"', '',
  ].join('\n');
  assert.deepEqual(lockedVersions('yarn.lock', text, '@koa/router'), ['12.0.2']);
  assert.deepEqual(lockedVersions('yarn.lock', text, 'express'), ['4.0.0', '5.1.0']);
  assert.deepEqual(lockedVersions('yarn.lock', text, 'koa-router'), []);
  assert.deepEqual(lockedVersions('yarn.lock', text, 'hono'), []);
});

test('잠금 파일은 선언한 프레임워크 수와 상관없이 처음 조회할 때 파일마다 한 번만 파싱한다', async (t) => {
  const pnpm = ["lockfileVersion: '9.0'", 'importers:', '  .:', '    dependencies:',
    ...[['express', '4.21.2'], ['hono', '4.6.14'], ['fastify', '5.2.0']].flatMap(([name, version]) => [`      ${name}:`, `        specifier: ^${version}`, `        version: ${version}`]),
    '    devDependencies:', '      typescript:', '        specifier: 5.9.3', '        version: 5.9.3',
    'packages:', '  express@4.21.2:', '    resolution: {integrity: sha512-x}', ''].join('\n');
  const npm = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/express': { version: '4.21.2' }, 'node_modules/hono': { version: '4.6.14' }, 'node_modules/fastify': { version: '5.2.0' } } });
  // npm은 JSON.parse, pnpm은 yaml의 parse가 문서마다 한 번 부르는 Parser.prototype.parse로 센다(잠금 파일 텍스트만).
  const jsonParse = t.mock.method(JSON, 'parse');
  const yamlParse = t.mock.method(Parser.prototype, 'parse');
  const parses = (): readonly number[] => [
    jsonParse.mock.calls.filter((call) => call.arguments[0] === npm).length,
    yamlParse.mock.calls.filter((call) => call.arguments[0] === pnpm).length,
  ];
  const nextOnly = detectFrameworks(await readWith({ 'package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }), 'package-lock.json': npm, 'pnpm-lock.yaml': pnpm }));
  assert.equal(nextOnly.next, true);
  assert.deepEqual(parses(), [0, 0]);
  const declared = { dependencies: { express: '*', hono: '*', fastify: '*' } };
  const detected = detectFrameworks(await readWith({ 'package.json': JSON.stringify(declared), 'package-lock.json': npm, 'pnpm-lock.yaml': pnpm }));
  assert.deepEqual([detected.express?.major, detected.hono?.major, detected.fastify?.major, detected.unverified], [4, 4, 5, []]);
  assert.deepEqual(parses(), [1, 1]);
});

test('symlink package.json은 읽지 않는다', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-deps-')));
  try {
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'package.json'), JSON.stringify({ dependencies: { hono: '4.0.0' } }));
    symlinkSync(join(root, 'real', 'package.json'), join(root, 'package.json'));
    const dependencies = await readProjectDependencies(createNodeFileSystem(), root);
    assert.equal(dependencies.manifest, 'unusable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('프레임워크 감지는 확인한 주 버전과 모델링하지 않는 서버 프레임워크를 가른다', async () => {
  const detected = detectFrameworks(await readWith({
    'package.json': JSON.stringify({ dependencies: { hono: '^3.0.0', express: '^5.0.0', koa: '2.0.0', '@nestjs/core': '9.0.0', '@hapi/hapi': '21.0.0', next: '16.0.0' } }),
  }));
  assert.deepEqual(detected.unverified, ['@nestjs/core', 'hono']);
  assert.deepEqual(detected.unsupported, ['@hapi/hapi']);
  assert.equal(detected.koa?.routerPackage, undefined);
  assert.equal(detected.nest?.expressMajor, undefined);
  assert.deepEqual(detected.nest?.adapters, ['express']);
  assert.equal(detected.next, true);
  assert.equal(hasNodeFramework(detected), true);
  assert.equal(hasNodeFramework(detectFrameworks(await readWith({ 'package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }) }))), false);
  assert.deepEqual(declaredRanges(JSON.stringify({ dependencies: { a: 1 } })), new Map());
  assert.equal(declaredRanges('{'), undefined);
});
