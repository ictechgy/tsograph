/**
 * schema 모듈 해석기(`ModuleResolver`)의 설정 읽기 경계와 해석 캐시 회귀 테스트다.
 *
 * tsconfig·jsconfig·`extends`·package.json은 1 MiB 상한 안에서, 링크를 따라간 실제 경로가 프로젝트 안일 때만
 * 읽어야 한다. TypeScript 해석 캐시를 써도 같은 package.json을 디렉터리마다 다시 읽지 않되, tsconfig 범위끼리
 * 결과가 섞이면 안 된다.
 */

import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { runSchemaCommand } from '../cli/schema-command.ts';
import { MAX_GRAPH_CONFIG_BYTES } from '../graph/bounded-config-reader.ts';
import { ModuleResolver } from './module-resolver.ts';
import { prismaBase, withProject } from './testing.test.ts';

/** `@/*` → `src/*` 별칭만 둔 tsconfig 본문이다. */
const aliasConfig = JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } });

/** 별칭으로 Prisma 클라이언트를 가져오는 최소 소스다. */
const aliasSources: Record<string, string> = {
  'src/db.ts': "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n",
  'src/use.ts': "import { prisma } from '@/db';\nexport const count = () => prisma.user.count();\n",
};

/** 경로별 파일 읽기 기록이다. */
interface ReadLog {
  /** 경로 → 열거나(openSync) 통째로 읽은(readFileSync) 횟수다. */
  readonly counts: Map<string, number>;
  /** 상한 없이 통째로 읽은 경로다. */
  readonly unbounded: string[];
}

/**
 * JSON 본문 뒤에 공백을 채워 정확히 `bytes` byte로 만든다. JSON 뒤 공백은 유효한 설정이다.
 *
 * @param json JSON 본문
 * @param bytes 만들 byte 수
 * @returns 채운 본문
 */
function padded(json: string, bytes: number): string {
  return json + ' '.repeat(bytes - Buffer.byteLength(json));
}

/**
 * 프로젝트 기준 소스 경로로 해석기를 만든다.
 *
 * @param root 프로젝트 realpath
 * @param sources 스캔한 것으로 볼 소스(프로젝트 기준 경로)
 * @returns 해석기
 */
function resolverFor(root: string, sources: readonly string[]): ModuleResolver {
  return new ModuleResolver(root, new Set(sources.map((path) => join(root, path))));
}

/**
 * {@link withProject}의 비동기 판이다. 기다려야 하는 콜백이 끝난 뒤에 프로젝트를 지운다.
 *
 * @param files 프로젝트 기준 경로 → 내용
 * @param run 프로젝트 realpath를 받는 콜백
 * @returns 콜백 결과
 */
async function withProjectAsync<T>(files: Record<string, string>, run: (root: string) => Promise<T>): Promise<T> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-schema-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 콜백 동안 경로별 파일 읽기를 센다. bounded reader는 openSync로 열고, 상한 없는 읽기는 readFileSync로 읽는다.
 *
 * @param t 테스트 문맥(mock 복원용)
 * @param body 읽기를 일으키는 콜백
 * @returns 콜백 결과와 읽기 기록
 */
async function countReads<T>(t: TestContext, body: () => T | Promise<T>): Promise<{ readonly value: T; readonly log: ReadLog }> {
  const log: ReadLog = { counts: new Map(), unbounded: [] };
  const note = (path: unknown): void => {
    if (typeof path === 'string') log.counts.set(path, (log.counts.get(path) ?? 0) + 1);
  };
  const originalOpen = fs.openSync;
  const originalReadFile = fs.readFileSync;
  t.mock.method(fs, 'openSync', function openSync(this: unknown, ...arguments_: Parameters<typeof fs.openSync>) {
    note(arguments_[0]);
    return originalOpen.apply(this, arguments_);
  });
  t.mock.method(fs, 'readFileSync', function readFileSync(this: unknown, ...arguments_: Parameters<typeof fs.readFileSync>) {
    note(arguments_[0]);
    if (typeof arguments_[0] === 'string') log.unbounded.push(arguments_[0]);
    return originalReadFile.apply(this, arguments_);
  });
  syncBuiltinESMExports();
  try {
    return { value: await body(), log };
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test('1 MiB를 넘는 tsconfig는 통째로 읽지 않고 읽지 못한 설정으로 센 뒤 성공으로 끝난다', async (t) => {
  await withProjectAsync({ ...prismaBase, ...aliasSources, 'tsconfig.json': padded(aliasConfig, MAX_GRAPH_CONFIG_BYTES + 1) }, async (root) => {
    const environment = { fileSystem: createNodeFileSystem(), toolVersion: '0.0.0', now: () => new Date(0) };
    const { value: result, log } = await countReads(t, () => runSchemaCommand(['--project', root], environment));
    assert.equal(result.exitCode, 0);
    const document = JSON.parse(result.standardOutput) as { readonly limitations: readonly string[] };
    assert.ok(document.limitations.some((line) => line.startsWith('unreadable-module-configs: 1 ')));
    assert.deepEqual(log.unbounded.filter((path) => path.endsWith('tsconfig.json')), []);
  });
});

test('정확히 1 MiB인 설정은 읽고, 상한을 넘는 extends 대상이 있으면 그 설정을 읽지 못한 것으로 센다', async () => {
  await withProjectAsync({
    ...aliasSources,
    'tsconfig.json': padded(aliasConfig, MAX_GRAPH_CONFIG_BYTES),
    'web/tsconfig.json': JSON.stringify({ extends: './base.json', compilerOptions: { paths: { '~/*': ['./lib/*'] } } }),
    'web/base.json': padded(JSON.stringify({ compilerOptions: { module: 'esnext' } }), MAX_GRAPH_CONFIG_BYTES + 1),
    'web/lib/db.ts': 'export const db = 1;\n',
    'web/use.ts': "import { db } from '~/db';\n",
  }, async (root) => {
    const resolver = resolverFor(root, ['src/db.ts', 'src/use.ts', 'web/lib/db.ts', 'web/use.ts']);
    assert.equal(resolver.resolve('@/db', join(root, 'src/use.ts')), join(root, 'src/db.ts'));
    assert.equal(resolver.unreadableConfigs, 0);
    // extends 사슬의 일부만 읽은 옵션을 쓰지 않고, limitation 문구대로 기본 해석으로 둔다.
    assert.equal(resolver.resolve('~/db', join(root, 'web/use.ts')), undefined);
    assert.equal(resolver.unreadableConfigs, 1);
  });
});

test('설정 파일과 package.json은 링크를 따라간 실제 경로가 프로젝트 안일 때만 읽는다', {
  skip: process.platform === 'win32',
}, async (t) => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-outside-')));
  try {
    writeFileSync(join(outside, 'tsconfig.json'), aliasConfig);
    mkdirSync(join(outside, 'ext'));
    writeFileSync(join(outside, 'ext', 'package.json'), JSON.stringify({ name: 'ext', main: 'index.js' }));
    const store = 'node_modules/.pnpm/@acme+tsconfig@1.0.0/node_modules/@acme/tsconfig';
    await withProjectAsync({
      ...aliasSources,
      'configs/web.json': JSON.stringify({ compilerOptions: { paths: { '~/*': ['./lib/*'] } } }),
      'web/lib/db.ts': 'export const db = 1;\n',
      'web/use.ts': "import { db } from '~/db';\n",
      [`${store}/package.json`]: JSON.stringify({ name: '@acme/tsconfig', version: '1.0.0' }),
      [`${store}/base.json`]: JSON.stringify({ compilerOptions: { paths: { '@api/*': ['${configDir}/*'] } } }),
      'api/tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig/base.json' }),
      'api/db.ts': 'export const db = 1;\n',
      'api/use.ts': "import { db } from '@api/db';\n",
    }, async (root) => {
      symlinkSync(join(outside, 'tsconfig.json'), join(root, 'tsconfig.json'));
      symlinkSync(join('..', 'configs', 'web.json'), join(root, 'web', 'tsconfig.json'));
      mkdirSync(join(root, 'node_modules', '@acme'));
      symlinkSync(join('..', '.pnpm', '@acme+tsconfig@1.0.0', 'node_modules', '@acme', 'tsconfig'), join(root, 'node_modules', '@acme', 'tsconfig'));
      symlinkSync(join(outside, 'ext'), join(root, 'node_modules', 'ext'));
      const resolver = resolverFor(root, ['src/db.ts', 'src/use.ts', 'web/lib/db.ts', 'web/use.ts', 'api/db.ts', 'api/use.ts']);
      const { value: resolved, log } = await countReads(t, () => [
        resolver.resolve('@/db', join(root, 'src/use.ts')),
        resolver.resolve('ext', join(root, 'src/use.ts')),
        resolver.resolve('~/db', join(root, 'web/use.ts')),
        resolver.resolve('@api/db', join(root, 'api/use.ts')),
      ]);
      // 프로젝트 밖으로 가는 tsconfig 링크와 패키지 링크는 열지 않는다. 루트 tsconfig는 읽지 못한 설정으로 센다.
      assert.deepEqual(resolved, [undefined, undefined, join(root, 'web/lib/db.ts'), join(root, 'api/db.ts')]);
      assert.equal(log.counts.get(join(root, 'tsconfig.json')), undefined);
      assert.equal(log.counts.get(join(root, 'node_modules/ext/package.json')), undefined);
      assert.equal(resolver.unreadableConfigs, 1);
      // 프로젝트 안 링크(설정 파일 링크, pnpm 디렉터리 링크를 거친 extends)는 따라 읽는다.
      assert.equal(log.counts.get(join(root, 'web/tsconfig.json')), 1);
      assert.equal(log.counts.get(join(root, 'node_modules/@acme/tsconfig/base.json')), 1);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('실제 경로를 확인하지 못한 설정은 읽지 않고 읽지 못한 설정으로 센다', (t) => {
  withProject({ ...aliasSources, 'tsconfig.json': aliasConfig }, (root) => {
    const config = join(root, 'tsconfig.json');
    const originalRealpath = fs.realpathSync.native;
    t.mock.method(fs.realpathSync, 'native', (...arguments_: Parameters<typeof fs.realpathSync.native>) => {
      if (arguments_[0] === config) throw Object.assign(new Error('synthetic realpath failure'), { code: 'ENOENT' });
      return originalRealpath(...arguments_);
    });
    try {
      const resolver = resolverFor(root, ['src/db.ts', 'src/use.ts']);
      assert.equal(resolver.resolve('@/db', join(root, 'src/use.ts')), undefined);
      assert.equal(resolver.unreadableConfigs, 1);
    } finally {
      t.mock.restoreAll();
    }
  });
});

test('여러 디렉터리·tsconfig 범위의 같은 bare 지정자는 package.json을 한 번만 읽는다', async (t) => {
  const sources = ['src/a/x.ts', 'src/b/y.ts', 'src/c/d/z.ts', 'packages/lib/src/w.ts'];
  await withProjectAsync({
    'node_modules/shared/package.json': JSON.stringify({ name: 'shared', version: '1.0.0', main: 'index.js' }),
    'node_modules/shared/index.js': 'exports.value = 1;\n',
    'packages/lib/tsconfig.json': JSON.stringify({ compilerOptions: { module: 'esnext' } }),
    ...Object.fromEntries(sources.map((path) => [path, "import { value } from 'shared';\n"])),
  }, async (root) => {
    const resolver = resolverFor(root, sources);
    const { value: resolved, log } = await countReads(t, () => sources.map((path) => resolver.resolve('shared', join(root, path))));
    // 의존성 패키지는 스캔한 소스가 아니므로 해석 결과는 없고, package.json 읽기는 실행에 한 번이다.
    assert.deepEqual(resolved, [undefined, undefined, undefined, undefined]);
    assert.equal(log.counts.get(join(root, 'node_modules/shared/package.json')), 1);
  });
});

test('한 tsconfig 범위의 paths 결과가 다른 범위의 node_modules 탐색 결과로 새지 않는다', () => {
  // node10 해석의 node_modules 조상 탐색은 다른 디렉터리에서 캐시한 bare 지정자 결과를 다시 쓴다. 캐시 하나를
  // 두 범위가 함께 쓰면 a의 paths 결과(apps 아래)를 b가 조상 `apps`에서 그대로 받는다.
  withProject({
    'apps/a/tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node', paths: { '@db/*': ['../shared/*'] } } }),
    'apps/a/src/x.ts': "import { db } from '@db/client';\n",
    'apps/b/tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'node', paths: { '@other/*': ['./other/*'] } } }),
    'apps/b/src/y.ts': "import { db } from '@db/client';\n",
    'apps/shared/client.ts': 'export const db = 1;\n',
  }, (root) => {
    const resolver = resolverFor(root, ['apps/a/src/x.ts', 'apps/b/src/y.ts', 'apps/shared/client.ts']);
    assert.equal(resolver.resolve('@db/client', join(root, 'apps/a/src/x.ts')), join(root, 'apps/shared/client.ts'));
    assert.equal(resolver.resolve('@db/client', join(root, 'apps/b/src/y.ts')), undefined);
    assert.equal(resolver.unreadableConfigs, 0);
  });
});

test('stat이 없음 밖의 오류(링크 순환)로 실패한 경로는 없는 것으로 보고 해석을 계속한다', {
  skip: process.platform === 'win32',
}, () => {
  withProject({ 'src/use.ts': "import { x } from 'cycle';\nimport { y } from './loop';\n" }, (root) => {
    mkdirSync(join(root, 'node_modules'));
    symlinkSync('cycle', join(root, 'node_modules', 'cycle'));
    symlinkSync('loop.ts', join(root, 'src', 'loop.ts'));
    const resolver = resolverFor(root, ['src/use.ts']);
    assert.equal(resolver.resolve('cycle', join(root, 'src/use.ts')), undefined);
    assert.equal(resolver.resolve('./loop', join(root, 'src/use.ts')), undefined);
  });
});
