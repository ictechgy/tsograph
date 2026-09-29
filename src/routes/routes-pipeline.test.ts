/**
 * 설정·스캔·추출·조립을 합성 임시 프로젝트로 끝까지 검증한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { type CommandFileSystem, createNodeFileSystem, type DirectoryEntry } from '../cli/file-system.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { MAX_SCANNED_ENTRIES } from './project-scan.ts';

/** 문서에서 테스트가 보는 부분이다. */
interface DocumentView {
  readonly facts: { method: string; channel: string; dynamic: boolean; pathAnchor: string; trailingSlash?: string; testSource?: boolean; location: { path: string } }[];
  readonly limitations: string[];
  readonly limitationScopes?: { limitationIndex: number; templatePrefixes?: string[]; methods?: string[] }[];
}

/** 기본 package.json이다(확인한 Next 주 버전). */
const nextPackage = JSON.stringify({ dependencies: { next: '16.2.7' } });

/** 임시 프로젝트를 만들어 콜백에 넘기고 지운다. */
async function withProject(files: Record<string, string>, body: (project: string) => Promise<void>): Promise<void> {
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-routes-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(project, path)), { recursive: true });
      writeFileSync(join(project, path), content);
    }
    await body(project);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

/** 명령을 실행해 문서를 돌려준다. */
async function scan(project: string, fileSystem: CommandFileSystem = createNodeFileSystem(), extra: string[] = []): Promise<DocumentView> {
  const result = await runRoutesCommand(['--role', 'server', '--project', project, ...extra], {
    fileSystem,
    toolVersion: '0.0.0-test',
    now: () => new Date(0),
  });
  assert.equal(result.exitCode, 0, result.standardError);
  return JSON.parse(result.standardOutput) as DocumentView;
}

/** 사실을 `METHOD anchor channel trailingSlash` 문자열로 줄인다. */
function lines(document: DocumentView): string[] {
  return document.facts.map((fact) => `${fact.method} ${fact.pathAnchor} ${fact.channel} ${fact.trailingSlash ?? '-'}${fact.dynamic ? ' dynamic' : ''}`);
}

/** 접두사로 시작하는 limitation만 고른다. */
function limitationsWith(document: DocumentView, prefix: string): string[] {
  return document.limitations.filter((line) => line.startsWith(prefix));
}

/** 앱이 있으면 항상 내는 `/_next` 제공 경로 limitation이다. */
const NEXT_ASSETS = 'framework-provided-routes: Next.js serves build assets and internal endpoints under /_next after basePath (static files, image optimization, data routes); they are not modeled';

/** 간단한 GET route 파일 본문이다. */
const getRoute = 'export async function GET() {\n  return new Response(null);\n}\n';

test('설정 파일을 정적으로 읽지 못하면 앵커는 base이고 unresolved-route-prefix다', async () => {
  await withProject({
    'package.json': nextPackage,
    'next.config.mjs': 'export default async (phase) => ({ basePath: "/x" });\n',
    'app/api/items/route.ts': getRoute,
  }, async (project) => {
    const document = await scan(project);
    assert.deepEqual(lines(document), ['GET base /api/items -']);
    assert.equal(limitationsWith(document, 'unresolved-route-prefix:').length, 1);
    assert.match(document.limitations.join('\n'), /exports a function whose result depends on execution/);
    assert.match(document.limitations.join('\n'), /framework-provided-routes: next\.config\.mjs has configuration keys tsograph cannot enumerate/);
  });
});

test('basePath 비리터럴·잘못된 값은 base, 감싼 호출은 root와 limitation이다', async () => {
  const cases: [string, string, RegExp][] = [
    ['export default { basePath: process.env.BASE };', 'GET base /api/items strict', /basePath is not a string literal/],
    ["export default { basePath: '/bad/' };", 'GET base /api/items strict', /basePath is not a value Next\.js accepts/],
    ["const withX = (c) => c;\nexport default withX({ basePath: '/w' });", 'GET root /w/api/items strict', /passes its configuration through 1 wrapper call/],
  ];
  for (const [config, expected, limitation] of cases) {
    await withProject({ 'package.json': nextPackage, 'next.config.js': config, 'app/api/items/route.ts': getRoute }, async (project) => {
      const document = await scan(project);
      assert.deepEqual(lines(document), [expected], config);
      assert.match(document.limitations.join('\n'), limitation, config);
    });
  }
});

test('설정 우선순위는 .js > .mjs > .ts이고 rewrites·i18n은 framework 경로 근거다', async () => {
  await withProject({
    'package.json': nextPackage,
    'next.config.js': "module.exports = { basePath: '/first', async rewrites() { return []; }, i18n: { locales: ['en'], defaultLocale: 'en' } };",
    'next.config.ts': "export default { basePath: '/second' };",
    'src/app/route.ts': getRoute,
  }, async (project) => {
    const document = await scan(project);
    assert.deepEqual(lines(document), ['GET root /first strict']);
    assert.deepEqual(limitationsWith(document, 'framework-provided-routes:'), [
      NEXT_ASSETS,
      'framework-provided-routes: next.config.js declares i18n, rewrites; paths they add, localize, or redirect are not modeled',
    ]);
  });
});

test('pageExtensions 리터럴은 route 파일 이름을 바꾸고, 비리터럴이면 기본값과 route-coverage다', async () => {
  await withProject({
    'package.json': nextPackage,
    'next.config.js': "module.exports = { pageExtensions: ['page.ts', 'mdx'], skipTrailingSlashRedirect: true };",
    'app/api/a/route.page.ts': getRoute,
    'app/api/b/route.ts': getRoute,
    'app/api/c/route.mdx': '# not javascript',
    'pages/api/d.page.ts': 'export default function d() {}\n',
    'pages/api/e.ts': 'export default function e() {}\n',
  }, async (project) => {
    const document = await scan(project);
    assert.deepEqual(lines(document), ['GET root /api/a optional', 'ANY root /api/d optional']);
    assert.match(document.limitations.join('\n'), /route-coverage: 1 route file\(s\) use a non-JavaScript page extension/);
  });
  await withProject({
    'package.json': nextPackage,
    'next.config.js': 'module.exports = { pageExtensions: extensions, trailingSlash: flag };',
    'app/api/b/route.ts': getRoute,
  }, async (project) => {
    const document = await scan(project);
    assert.deepEqual(lines(document), ['GET root /api/b -']);
    assert.match(document.limitations.join('\n'), /pageExtensions is not a literal string array/);
  });
});

test('Pages Router: api.<ext>, index, .d.ts, __tests__, invalid 세그먼트', async () => {
  await withProject({
    'package.json': nextPackage,
    'pages/api.ts': 'export default function api() {}\n',
    'pages/api/types.d.ts': 'export type T = 1;\n',
    'pages/api/__tests__/x.ts': 'export default function x() {}\n',
    'pages/api/[[id]].ts': 'export default function bad() {}\n',
    'pages/api/_private.ts': 'export default function underscore() {}\n',
    'pages/about.tsx': 'export default function About() { return null; }\n',
  }, async (project) => {
    const document = await scan(project);
    assert.deepEqual(lines(document), ['ANY root /api strict', 'ANY root /api/_private strict']);
    assert.match(document.limitations.join('\n'), /1 route file\(s\) use dynamic segment names Next\.js rejects/);
    const withTests = await scan(project, createNodeFileSystem(), ['--include-tests']);
    assert.ok(lines(withTests).includes('ANY root /api/__tests__/x strict'));
  });
});

test('라우터 디렉터리가 없으면 0건과 route-coverage, 버전 판정은 limitation으로 알린다', async () => {
  await withProject({ 'README.md': '# nothing' }, async (project) => {
    const document = await scan(project);
    assert.deepEqual(document.facts, []);
    assert.deepEqual(document.limitations, [
      'route-coverage: no app or pages directory was found at the project root or under src/; no Next.js routes were scanned',
      'route-framework-version-unknown: package.json at the project root is missing, unreadable, a symbolic link, or does not declare a next dependency; tsograph models Next.js 16 routing semantics',
    ]);
  });
  const versions: [string, boolean][] = [
    [JSON.stringify({ dependencies: { next: '^15.5.0' } }), false],
    [JSON.stringify({ devDependencies: { next: 'latest' } }), false],
    [JSON.stringify({ peerDependencies: { next: '>=16.0.0 <17' } }), true],
    [JSON.stringify({ dependencies: { next: '>=15.0.0 <17' } }), false],
    [JSON.stringify({ dependencies: { next: '~16.2.0-canary.1' } }), true],
    [JSON.stringify({ dependencies: [] }), false],
    ['{ broken', false],
    ['[]', false],
  ];
  for (const [packageJson, isVerified] of versions) {
    await withProject({ 'package.json': packageJson, 'app/route.ts': getRoute }, async (project) => {
      const document = await scan(project);
      assert.equal(limitationsWith(document, 'route-framework-version-unknown:').length === 0, isVerified, packageJson);
    });
  }
});

test('proxy·middleware·메타데이터·public 근거를 framework-provided-routes로 낸다', async () => {
  await withProject({
    'package.json': nextPackage,
    'middleware.js': 'export function middleware() {}\n',
    'app/robots.ts': 'export default function robots() { return {}; }\n',
    'app/manifest.webmanifest': '{}',
    'app/blog/opengraph-image2.png': '',
    'app/blog/sitemap.xml': '<urlset/>',
    'app/blog/icon.tsx': 'export default function Icon() { return null; }\n',
    'app/blog/robots.txt': 'not a root metadata file',
    'app/blog/notes.md': '# not metadata',
    'public/.keep': '',
  }, async (project) => {
    const document = await scan(project);
    assert.deepEqual(limitationsWith(document, 'framework-provided-routes:'), [
      'framework-provided-routes: 5 metadata file(s) under the app directory (sitemap, robots, manifest, icons, Open Graph or Twitter images) serve framework-generated routes that are not modeled',
      NEXT_ASSETS,
      'framework-provided-routes: middleware.js can answer or rewrite requests before file routing (Next.js proxy/middleware); those paths are not modeled',
      'framework-provided-routes: the public/ directory serves static files at the site root; they are not modeled',
    ]);
  });
  await withProject({ 'package.json': nextPackage, 'app/route.ts': getRoute }, async (project) => {
    mkdirSync(join(project, 'public'));
    mkdirSync(join(project, 'static'));
    const document = await scan(project);
    assert.deepEqual(limitationsWith(document, 'framework-provided-routes:'), [NEXT_ASSETS]);
  });
});

/** 문서의 스코프를 `한계 접두사 뒤 첫 단어 → 범위` 문자열로 줄인다. */
function scopeLines(document: DocumentView): string[] {
  return (document.limitationScopes ?? []).map((scope) => {
    const subject = document.limitations[scope.limitationIndex]!.split(' ').slice(1, 3).join(' ');
    return `${subject}: ${scope.templatePrefixes!.join(',')}${scope.methods === undefined ? '' : ` ${scope.methods.join(',')}`}`;
  });
}

test('public·static·/_next는 basePath 접두사와 method로 좁히고, 증명하지 못하면 스코프를 생략한다', async () => {
  const assets = { 'package.json': nextPackage, 'app/api/items/route.ts': getRoute, 'public/logo.png': '', 'static/old.css': '' };
  const cases: [string | undefined, string[]][] = [
    [undefined, ['Next.js serves: /_next', 'the public/: / GET,HEAD', 'the static/: /static GET,HEAD']],
    ["module.exports = { basePath: '/b' };", ['Next.js serves: /b/_next', 'the public/: /b GET,HEAD', 'the static/: /b/static GET,HEAD']],
    // i18n은 정적 자산을 기본 locale 접두사 아래로도 찾는다. public은 여전히 basePath 아래라 좁힐 수 있다.
    ["module.exports = { basePath: '/b', i18n: { locales: ['en'], defaultLocale: 'en' } };", ['the public/: /b GET,HEAD']],
    // assetPrefix는 그 경로 아래 /_next/:path+를 rewrite한다.
    ["module.exports = { assetPrefix: '/cdn' };", ['the public/: / GET,HEAD', 'the static/: /static GET,HEAD']],
    // basePath를 확정하지 못하면(감싼 호출·모르는 키·비리터럴·함수 설정) 어떤 스코프도 증명할 수 없다.
    ["const withX = (c) => c;\nmodule.exports = withX({ basePath: '/w' });", []],
    ["const extra = require('./extra');\nmodule.exports = { basePath: '/b', ...extra };", []],
    ['module.exports = { basePath: process.env.BASE };', []],
    ['module.exports = () => ({});', []],
  ];
  for (const [config, expected] of cases) {
    await withProject(config === undefined ? assets : { ...assets, 'next.config.js': config }, async (project) => {
      const document = await scan(project);
      assert.deepEqual(scopeLines(document), expected, config);
      if (expected.length === 0) assert.equal(document.limitationScopes, undefined, config);
    });
  }
});

test('symlink·읽지 못한 파일·큰 파일·비UTF-8·안전하지 않은 이름을 센다', async () => {
  await withProject({
    'package.json': nextPackage,
    'app/api/a/route.ts': getRoute,
    'app/api/big/route.ts': getRoute,
    'app/api/latin/route.ts': '',
    'app/api/denied/route.ts': getRoute,
  }, async (project) => {
    writeFileSync(join(project, 'app/api/latin/route.ts'), new Uint8Array([0x65, 0x78, 0xe9, 0x0a]));
    symlinkSync(join(project, 'app/api/a'), join(project, 'app/api/linked'));
    const base = createNodeFileSystem();
    const fileSystem: CommandFileSystem = {
      ...base,
      status: async (path) => (path.endsWith('big/route.ts') ? { kind: 'file', size: 9 * 1024 * 1024, modifiedAt: new Date(0) } : base.status(path)),
      readBytes: async (path) => {
        if (path.endsWith('denied/route.ts')) throw Object.assign(new Error('x'), { code: 'EACCES' });
        return base.readBytes(path);
      },
      listDirectory: async (path) => {
        const entries = await base.listDirectory(path);
        return path.endsWith('/app/api') ? [...entries, { name: 'bad\u0001name', kind: 'directory' }] : entries;
      },
    };
    const document = await scan(project, fileSystem);
    assert.deepEqual(lines(document), ['GET root /api/a strict']);
    const text = document.limitations.join('\n');
    assert.match(text, /1 symbolic link\(s\) under the app or pages directories were not followed/);
    assert.match(text, /3 route file\(s\) could not be read as UTF-8 text within 8388608 bytes/);
    assert.match(text, /1 file or directory name\(s\) contain characters the exchange format forbids/);
  });
});

test('디렉터리 목록 실패·스캔 상한은 route-coverage다', async () => {
  await withProject({ 'package.json': nextPackage, 'app/api/a/route.ts': getRoute }, async (project) => {
    const base = createNodeFileSystem();
    const failing: CommandFileSystem = {
      ...base,
      listDirectory: async (path) => {
        if (path.endsWith('/app/api')) throw new Error('EACCES');
        return base.listDirectory(path);
      },
    };
    const document = await scan(project, failing);
    assert.deepEqual(document.facts, []);
    assert.match(document.limitations.join('\n'), /1 director\(ies\) could not be listed/);
    const deep: CommandFileSystem = {
      ...base,
      listDirectory: async (path): Promise<readonly DirectoryEntry[]> => (path.includes('/app') ? [{ name: 'd', kind: 'directory' }] : base.listDirectory(path)),
    };
    assert.match((await scan(project, deep)).limitations.join('\n'), /directory scan stopped/);
    const wide: CommandFileSystem = {
      ...base,
      listDirectory: async (path): Promise<readonly DirectoryEntry[]> => (path.endsWith('/app')
        ? Array.from({ length: MAX_SCANNED_ENTRIES + 1 }, (_, index) => ({ name: `f${index}.txt`, kind: 'file' as const }))
        : base.listDirectory(path)),
    };
    assert.match((await scan(project, wide)).limitations.join('\n'), /directory scan stopped/);
  });
});

test('설정 파일을 읽을 수 없으면 unreadable 이유로 base 앵커다', async () => {
  await withProject({ 'package.json': nextPackage, 'next.config.js': 'module.exports = {};', 'app/route.ts': getRoute }, async (project) => {
    const base = createNodeFileSystem();
    const fileSystem: CommandFileSystem = {
      ...base,
      readBytes: async (path) => (path.endsWith('next.config.js') ? new Uint8Array([0xff]) : base.readBytes(path)),
    };
    const document = await scan(project, fileSystem);
    assert.deepEqual(lines(document), ['GET base / -']);
    assert.match(document.limitations.join('\n'), /could not be read as UTF-8 text within the size limit/);
  });
});

test('App Router: test 폴더는 실제 세그먼트이고 route.test.ts는 route 파일이 아니다', async () => {
  await withProject({
    'package.json': nextPackage,
    'app/api/test/route.ts': getRoute,
    'app/api/test/route.test.ts': getRoute,
    'app/.well-known/security/route.ts': getRoute,
  }, async (project) => {
    const document = await scan(project);
    assert.deepEqual(lines(document), ['GET root /.well-known/security strict', 'GET root /api/test strict']);
  });
});

/** 프로젝트 밖에 파일을 둔 디렉터리를 만든다. */
function writeOutside(files: Record<string, string>): string {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-outside-')));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(outside, path)), { recursive: true });
    writeFileSync(join(outside, path), content);
  }
  return outside;
}

test('최상위 app·src·pages symlink는 따라가지 않고 이름을 limitation으로 알린다', async () => {
  const outside = writeOutside({ 'real-app/api/secret/route.ts': getRoute, 'real-src/app/api/secret/route.ts': getRoute, 'real-pages/api/x.ts': 'export default function x() {}\n' });
  try {
    await withProject({ 'package.json': nextPackage, 'src/app/api/fallback/route.ts': getRoute }, async (project) => {
      symlinkSync(join(outside, 'real-app'), join(project, 'app'));
      symlinkSync(join(outside, 'real-pages'), join(project, 'pages'));
      const document = await scan(project);
      // Next는 루트 app(symlink)을 고르므로 src/app으로 내려가지도 않는다.
      assert.deepEqual(document.facts, []);
      assert.ok(document.limitations.includes('route-coverage: top-level route locations are symbolic links and were not followed (app, pages); routes behind them were not scanned'));
    });
    await withProject({ 'package.json': nextPackage }, async (project) => {
      symlinkSync(join(outside, 'real-src'), join(project, 'src'));
      const document = await scan(project);
      assert.deepEqual(document.facts, []);
      assert.ok(document.limitations.includes('route-coverage: top-level route locations are symbolic links and were not followed (src); routes behind them were not scanned'));
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('밖을 가리키는 next.config·package.json symlink는 읽지 않고, 끊어진 symlink는 없는 파일로 본다', async () => {
  const outside = writeOutside({ 'next.config.js': "module.exports = { basePath: '/outside' };", 'package.json': nextPackage });
  try {
    await withProject({ 'app/api/items/route.ts': getRoute, 'next.config.ts': "export default { basePath: '/inside' };" }, async (project) => {
      symlinkSync(join(project, 'missing.js'), join(project, 'next.config.js'));
      symlinkSync(join(outside, 'package.json'), join(project, 'package.json'));
      const document = await scan(project);
      assert.deepEqual(lines(document), ['GET root /inside/api/items strict']);
      assert.equal(limitationsWith(document, 'route-framework-version-unknown:').length, 1);
    });
    await withProject({ 'package.json': nextPackage, 'app/api/items/route.ts': getRoute }, async (project) => {
      symlinkSync(join(outside, 'next.config.js'), join(project, 'next.config.js'));
      const document = await scan(project);
      assert.deepEqual(lines(document), ['GET base /api/items -']);
      assert.match(document.limitations.join('\n'), /next\.config\.js could not be resolved statically \(it is a symbolic link, which tsograph does not follow\)/);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('public·proxy·pages/api symlink는 내용을 읽지 않고 근거·공백으로만 센다', async () => {
  const outside = writeOutside({ 'public/logo.txt': 'x', 'proxy.ts': 'export function proxy() {}\n', 'api/y.ts': 'export default function y() {}\n' });
  try {
    await withProject({ 'package.json': nextPackage, 'pages/api/ok.ts': 'export default function ok() {}\n' }, async (project) => {
      symlinkSync(join(outside, 'public'), join(project, 'public'));
      symlinkSync(join(outside, 'proxy.ts'), join(project, 'proxy.ts'));
      symlinkSync(join(outside, 'api/y.ts'), join(project, 'pages/api.ts'));
      const document = await scan(project);
      assert.deepEqual(lines(document), ['ANY root /api/ok strict']);
      const text = document.limitations.join('\n');
      assert.match(text, /framework-provided-routes: the public\/ directory serves static files/);
      assert.match(text, /framework-provided-routes: proxy\.ts can answer or rewrite requests/);
      assert.match(text, /route-coverage: 1 symbolic link\(s\) under the app or pages directories were not followed/);
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Pages Router optional catch-all API route는 {**}와 접두사 decl을 낸다', async () => {
  await withProject({ 'package.json': nextPackage, 'pages/api/[[...slug]].ts': 'export default function all() {}\n' }, async (project) => {
    assert.deepEqual(lines(await scan(project)), ['ANY root /api strict', 'ANY root /api/{**} strict']);
  });
});
