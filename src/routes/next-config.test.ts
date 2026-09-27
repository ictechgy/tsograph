import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_PAGE_EXTENSIONS, type NextRouteConfig, readNextRouteConfig } from './next-config.ts';
import { parseSource, scriptKindOf } from './source-file.ts';

/** 설정 텍스트를 읽는다. */
function read(text: string, fileName = 'next.config.ts'): NextRouteConfig {
  const parsed = parseSource(fileName, text, scriptKindOf(fileName)!);
  return readNextRouteConfig(fileName, parsed.sourceFile, parsed.hasSyntaxErrors);
}

/** 확정 값이면 값을, 아니면 'unknown'을 돌려준다. */
function valueOf<T>(resolved: { kind: 'known'; value: T } | { kind: 'unknown' }): T | 'unknown' {
  return resolved.kind === 'known' ? resolved.value : 'unknown';
}

test('타입 주석·satisfies·as가 붙은 const 객체를 export default로 읽는다', () => {
  const config = read([
    "import type { NextConfig } from 'next';",
    "const prefix = '/docs';",
    'const nextConfig: NextConfig = ({',
    '  basePath: prefix,',
    '  trailingSlash: true,',
    "  'skipTrailingSlashRedirect': false,",
    "  pageExtensions: ['page.tsx', `page.ts`],",
    '  async headers() { return []; },',
    '} satisfies NextConfig) as NextConfig;',
    'export default nextConfig;',
  ].join('\n'));
  assert.equal(valueOf(config.basePath), '/docs');
  assert.equal(valueOf(config.trailingSlash), true);
  assert.equal(valueOf(config.skipTrailingSlashRedirect), false);
  assert.deepEqual(valueOf(config.pageExtensions), ['page.tsx', 'page.ts']);
  assert.deepEqual(config.frameworkRouteKeys, []);
  assert.equal(config.hasUnknownKeys, false);
  assert.equal(config.unresolvedReason, undefined);
  assert.equal(config.fileName, 'next.config.ts');
});

test('module.exports와 없는 키는 Next 기본값이다', () => {
  const config = read('module.exports = { reactStrictMode: true };', 'next.config.js');
  assert.equal(valueOf(config.basePath), '');
  assert.equal(valueOf(config.trailingSlash), false);
  assert.deepEqual(valueOf(config.pageExtensions), DEFAULT_PAGE_EXTENSIONS);
  const equals = read('const c = { basePath: "/x" };\nexport = c;');
  assert.equal(valueOf(equals.basePath), '/x');
});

test('rewrites·redirects·i18n 키는 framework 경로 근거로 남긴다', () => {
  const config = read("export default { async rewrites() { return []; }, redirects: async () => [], i18n: { locales: ['en'], defaultLocale: 'en' } };", 'next.config.mjs');
  assert.deepEqual(config.frameworkRouteKeys, ['i18n', 'redirects', 'rewrites']);
});

test('감싼 호출은 첫 인자를 따라가고 호출 수를 센다', () => {
  const config = read([
    "const withA = (c: object) => c; const withB = (o: object) => (c: object) => c;",
    "const base = { basePath: '/app' };",
    'export default withA(withB({ enabled: true })(base), { silent: true });',
  ].join('\n'));
  assert.equal(valueOf(config.basePath), '/app');
  assert.equal(config.wrapperCalls, 2);
});

test('전개는 따라갈 수 있으면 펼치고, 없으면 모르는 키로 표시한다', () => {
  const merged = read("const shared = { basePath: '/s', trailingSlash: true };\nexport default { ...shared, trailingSlash: false };");
  assert.equal(valueOf(merged.basePath), '/s');
  assert.equal(valueOf(merged.trailingSlash), false);
  const opaque = read("import shared from './shared';\nexport default { ...shared, poweredByHeader: false };");
  assert.equal(valueOf(opaque.basePath), 'unknown');
  assert.equal(opaque.hasUnknownKeys, true);
  const computed = read("const key = 'basePath';\nexport default { [key]: '/x', trailingSlash: true };");
  assert.equal(valueOf(computed.basePath), 'unknown');
  assert.equal(valueOf(computed.trailingSlash), true);
});

test('비리터럴 값·변경된 이름·순환은 unknown이다', () => {
  const nonLiteral = read('export default { basePath: process.env.BASE_PATH, trailingSlash: !!process.env.X, pageExtensions: [...exts] };');
  assert.equal(valueOf(nonLiteral.basePath), 'unknown');
  assert.equal(valueOf(nonLiteral.trailingSlash), 'unknown');
  assert.equal(valueOf(nonLiteral.pageExtensions), 'unknown');
  const methodValue = read('export default { get basePath() { return "/x"; } };');
  assert.equal(valueOf(methodValue.basePath), 'unknown');
  const mutations = [
    "const c = { basePath: '/a' };\nc.basePath = '/b';\nexport default c;",
    "const c = { basePath: '/a' };\nObject.assign(c, { basePath: '/b' });\nexport default c;",
    "let n = 0; const c = { basePath: '/a' };\nn++;\nexport default c;",
  ];
  assert.equal(read(mutations[0]!).unresolvedReason, 'non-literal-export');
  assert.equal(read(mutations[1]!).unresolvedReason, 'non-literal-export');
  assert.equal(valueOf(read(mutations[2]!).basePath), '/a');
  const shorthand = read("const basePath = '/sh';\nexport default { basePath };");
  assert.equal(valueOf(shorthand.basePath), '/sh');
  const cycle = read('const a = b; const b = a;\nexport default a;');
  assert.equal(cycle.unresolvedReason, 'non-literal-export');
  const arrayValue = read("const e = ['ts', 1];\nexport default { pageExtensions: e, basePath: 5 };");
  assert.equal(valueOf(arrayValue.pageExtensions), 'unknown');
  assert.equal(valueOf(arrayValue.basePath), 'unknown');
});

test('함수·비객체 내보내기, 내보내기 없음, 구문 오류는 확정하지 못한 설정이다', () => {
  const cases: [string, string][] = [
    ['export default (phase: string) => ({ basePath: "/x" });', 'function-export'],
    ['export default function config() { return {}; }', 'function-export'],
    ['module.exports = async function () { return {}; };', 'function-export'],
    ['export default loadConfig();', 'non-literal-export'],
    ['export default 42;', 'non-literal-export'],
    ['export default undefinedName;', 'non-literal-export'],
    ['const c = {};', 'no-export'],
    ['export default { basePath: ', 'syntax-error'],
  ];
  for (const [text, reason] of cases) {
    const config = read(text);
    assert.equal(config.unresolvedReason, reason, text);
    assert.equal(valueOf(config.basePath), 'unknown', text);
    assert.equal(config.hasUnknownKeys, true, text);
  }
  const deepWrappers = read(`export default ${'w('.repeat(20)}{ basePath: '/x' }${')'.repeat(20)};`);
  assert.equal(deepWrappers.unresolvedReason, 'non-literal-export');
});

test('숫자·문자열 키와 깊은 전개 체인도 결정적으로 처리한다', () => {
  const keys = read("export default { 1: 'x', 'trailingSlash': true };");
  assert.equal(valueOf(keys.trailingSlash), true);
  const chain = Array.from({ length: 20 }, (_, index) => `const s${index} = { ...s${index + 1} };`).join('\n');
  const deep = read(`${chain}\nconst s20 = { basePath: '/deep' };\nexport default { ...s0 };`);
  assert.equal(valueOf(deep.basePath), 'unknown');
});
