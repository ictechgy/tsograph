import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { RouteFactLimitError } from '../routes/route-document.ts';
import { type CommandFileSystem, createNodeFileSystem } from './file-system.ts';
import { renderDocument, routesUsage, runRoutesCommand } from './routes-command.ts';

/** 합성 Next fixture 디렉터리다. */
const fixtures = realpathSync(fileURLToPath(new URL('../../fixtures/next/', import.meta.url)));

/** 고정 시계다. */
const fixedNow = () => new Date('2026-09-27T00:00:00.000Z');

/** 문서에서 테스트가 보는 부분이다. */
interface RoutesDocumentView {
  readonly platform: string;
  readonly target: string;
  readonly roles: string[];
  readonly dispatch: string;
  readonly sourceSets: { tests: string };
  readonly service?: string;
  readonly project: string;
  readonly facts: {
    method: string;
    channel: string;
    dynamic: boolean;
    pathAnchor: string;
    trailingSlash?: string;
    testSource?: boolean;
    catchAllPrefix?: boolean;
    service?: string;
    location: { path: string; line: number; column: number };
    symbol: { qualifiedName: string; usr?: string };
  }[];
  readonly limitations: string[];
  readonly limitationScopes?: { limitationIndex: number; templatePrefixes?: string[]; methods?: string[] }[];
}

/** 명령을 실행한다. */
function run(arguments_: readonly string[], fileSystem: CommandFileSystem = createNodeFileSystem()) {
  return runRoutesCommand(arguments_, { fileSystem, toolVersion: '0.0.0-test', now: fixedNow });
}

/** fixture 하나를 변환해 문서를 돌려준다. */
async function convertFixture(name: string, extra: readonly string[] = []): Promise<RoutesDocumentView> {
  const result = await run(['--role', 'server', '--project', join(fixtures, name), ...extra]);
  assert.equal(result.exitCode, 0, result.standardError);
  return JSON.parse(result.standardOutput) as RoutesDocumentView;
}

/** 사실을 `METHOD anchor channel trailingSlash @ path:line:column` 문자열로 줄인다. */
function routeLines(document: RoutesDocumentView): string[] {
  return document.facts.map((fact) => {
    const flags = `${fact.dynamic ? ' dynamic' : ''}${fact.testSource === true ? ' test' : ''}`;
    const { path, line, column } = fact.location;
    return `${fact.method} ${fact.pathAnchor} ${fact.channel} ${fact.trailingSlash ?? '-'}${flags} @ ${path}:${line}:${column}`;
  });
}

test('App Router fixture: 내보내기 형태·group·catch-all·비ASCII·미모델링 규칙', async () => {
  const document = await convertFixture('app-router', ['--service', 'demo']);
  assert.equal(document.platform, 'js');
  assert.equal(document.target, 'http');
  assert.deepEqual(document.roles, ['server']);
  assert.equal(document.dispatch, 'specificity');
  assert.deepEqual(document.sourceSets, { tests: 'excluded' });
  assert.equal(document.service, 'demo');
  assert.equal(document.project, join(fixtures, 'app-router'));
  assert.deepEqual(routeLines(document), [
    'GET root /api/admin/stats strict @ src/app/(admin)/api/admin/stats/route.ts:1:23',
    'GET root /api/auth/{**} strict @ src/app/api/auth/[...nextauth]/route.ts:3:16',
    'POST root /api/auth/{**} strict @ src/app/api/auth/[...nextauth]/route.ts:3:21',
    'GET root /api/broken strict @ src/app/api/broken/route.ts:1:23',
    'GET root /api/caf%C3%A9/men%C3%BC strict @ src/app/api/café/menü/route.ts:1:41',
    'GET root /api/docs strict @ src/app/api/docs/[[...slug]]/route.ts:1:23',
    'GET root /api/docs/{**} strict @ src/app/api/docs/[[...slug]]/route.ts:1:23',
    'GET root /api/files/{**} strict @ src/app/api/files/[...path]/route.ts:1:23',
    'GET root /api/items strict @ src/app/api/items/route.ts:5:23',
    'POST root /api/items strict @ src/app/api/items/route.ts:9:23',
    'GET root /api/items/featured strict @ src/app/api/items/featured/route.js:1:17',
    'DELETE root /api/items/{} strict @ src/app/api/items/[id]/route.ts:4:14',
    'GET root /api/items/{} strict @ src/app/api/items/[id]/route.ts:3:14',
    'PATCH root /api/items/{} strict @ src/app/api/items/[id]/route.ts:5:21',
    'GET root /api/proxy strict @ src/app/api/proxy/route.ts:1:10',
    'HEAD root /api/proxy strict @ src/app/api/proxy/route.ts:1:15',
    'GET root /api/v%5Bversion%5D - dynamic @ src/app/api/v[version]/route.ts:1:23',
  ]);
  assert.ok(document.facts.every((fact) => fact.service === 'demo'));
  assert.equal(document.facts[0]?.symbol.qualifiedName, 'src/app/(admin)/api/admin/stats/route.ts#GET');
  // usr는 그래프 id다: 선언은 같은 이름, 구조 분해·재내보내기는 내보낸 이름의 export 노드다.
  assert.deepEqual(document.facts.map((fact) => fact.symbol.usr), document.facts.map((fact) => fact.symbol.qualifiedName));
  assert.deepEqual(document.facts.filter((fact) => fact.catchAllPrefix === true).map((fact) => fact.channel), ['/api/docs']);
  assert.deepEqual(document.limitations, [
    'framework-provided-routes: 2 metadata file(s) under the app directory (sitemap, robots, manifest, icons, Open Graph or Twitter images) serve framework-generated routes that are not modeled',
    'framework-provided-routes: Next.js serves build assets and internal endpoints under /_next after basePath (static files, image optimization, data routes); they are not modeled',
    'framework-provided-routes: src/proxy.ts can answer or rewrite requests before file routing (Next.js proxy/middleware); those paths are not modeled',
    'framework-provided-routes: the public/ directory serves static files at the site root; they are not modeled',
    'route-coverage: 1 route file(s) have a segment that mixes brackets with other text, which Next.js does not document; their facts are dynamic',
    'route-coverage: 1 route file(s) have syntax errors; their exported handlers may be incomplete',
    'route-coverage: 1 route file(s) use export * or CommonJS exports whose names cannot be enumerated statically; their HTTP method handlers may be incomplete',
    'route-coverage: 2 route file(s) are under parallel-route slots (@name) or intercepting-route segments ((.)name), which Next.js documents for pages only; they were not modeled',
  ]);
  // proxy·메타데이터는 상한을 증명하지 못해 문서 전체 효과로 남고, /_next와 public만 좁힌다.
  assert.deepEqual(document.limitationScopes, [
    { limitationIndex: 1, templatePrefixes: ['/_next'] },
    { limitationIndex: 3, templatePrefixes: ['/'], methods: ['GET', 'HEAD'] },
  ]);
});

test('Pages Router fixture: ANY, basePath, trailingSlash true, CommonJS 기본 내보내기, 테스트 제외', async () => {
  const document = await convertFixture('pages-api');
  assert.equal(document.service, undefined);
  assert.deepEqual(routeLines(document), [
    'ANY root /docs/api/ strict @ pages/api/index.js:1:1',
    'ANY root /docs/api/files/ strict @ pages/api/files/[[...path]].ts:1:8',
    'ANY root /docs/api/files/{**} - @ pages/api/files/[[...path]].ts:1:8',
    'ANY root /docs/api/hello/ strict @ pages/api/hello.ts:1:8',
    'ANY root /docs/api/users/{} - @ pages/api/users/[id].ts:3:8',
  ]);
  assert.equal(document.facts[0]?.symbol.qualifiedName, 'pages/api/index.js#default');
  // CommonJS 기본 내보내기는 usr가 없고, 이름 있는 default 함수는 함수 이름이 usr다.
  assert.equal(document.facts[0]?.symbol.usr, undefined);
  assert.deepEqual(document.facts.slice(1).map((fact) => fact.symbol.usr), [
    'pages/api/files/[[...path]].ts#files', 'pages/api/files/[[...path]].ts#files', 'pages/api/hello.ts#handler', 'pages/api/users/[id].ts#default',
  ]);
  assert.deepEqual(document.facts.filter((fact) => fact.catchAllPrefix === true).map((fact) => fact.channel), ['/docs/api/files/']);
  assert.deepEqual(document.limitations, [
    'framework-provided-routes: Next.js serves build assets and internal endpoints under /_next after basePath (static files, image optimization, data routes); they are not modeled',
    'missing-route-usrs: 1 route declaration(s) come from CommonJS exports and carry no symbol.usr; tsograph graph has no named node for them',
    'route-coverage: 1 pages/api file(s) have no statically visible default export or module.exports assignment; no declaration was emitted for them',
  ]);
  assert.deepEqual(document.limitationScopes, [{ limitationIndex: 0, templatePrefixes: ['/docs/_next'] }]);
  const withTests = await convertFixture('pages-api', ['--include-tests']);
  assert.deepEqual(withTests.sourceSets, { tests: 'included' });
  assert.ok(routeLines(withTests).includes('ANY root /docs/api/hello.test strict test @ pages/api/hello.test.ts:1:8'));
  assert.equal(withTests.facts.filter((fact) => fact.testSource === true).length, 1);
});

test('같은 입력의 출력은 바이트 단위로 같다', async () => {
  const arguments_ = ['--role', 'server', '--project', join(fixtures, 'app-router'), '--format', 'json'];
  const first = await run(arguments_);
  const second = await run(arguments_);
  assert.equal(first.standardOutput, second.standardOutput);
  assert.ok(first.standardOutput.endsWith('\n'));
});

test('--help는 사용법을 성공으로 낸다', async () => {
  const result = await run(['--help']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.standardOutput, routesUsage);
});

test('잘못된 호출은 64다', async () => {
  const project = join(fixtures, 'app-router');
  const cases: string[][] = [
    [],
    ['--project', project],
    ['--role', 'client', '--project', project],
    ['--role', 'server'],
    ['--role', 'server', '--project', project, 'extra'],
    ['--role', 'server', '--project', project, '--format', 'yaml'],
    ['--role', 'server', '--project', project, '--service', 'bad\u0001name'],
    ['--role', 'server', '--project', project, '--service', 'x'.repeat(257)],
    ['--role', 'server', '--project', project, '--unknown'],
  ];
  for (const arguments_ of cases) {
    const result = await run(arguments_);
    assert.equal(result.exitCode, 64, JSON.stringify(arguments_));
    assert.match(result.standardError, /Usage: tsograph routes/);
  }
});

test('읽을 수 없는 프로젝트는 2이고 경로 원문을 싣지 않는다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tsograph-routes-cli-'));
  try {
    const file = join(directory, 'file.txt');
    writeFileSync(file, 'x');
    for (const project of [join(directory, 'missing'), file]) {
      const result = await run(['--role', 'server', '--project', project]);
      assert.equal(result.exitCode, 2);
      assert.match(result.standardError, /--project does not name a readable directory/);
      assert.doesNotMatch(result.standardError, /tsograph-routes-cli-/);
    }
    const unsafe: CommandFileSystem = { ...createNodeFileSystem(), realPath: async () => '/tmp/a\u0085b' , status: async () => ({ kind: 'directory', size: 0, modifiedAt: new Date(0) }) };
    const unsafeResult = await run(['--role', 'server', '--project', directory], unsafe);
    assert.equal(unsafeResult.exitCode, 2);
    assert.match(unsafeResult.standardError, /characters the exchange format forbids/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('사실·출력 상한을 넘으면 부분 문서 대신 2다', () => {
  const tooMany = renderDocument(() => { throw new RouteFactLimitError(); });
  assert.equal(tooMany.exitCode, 2);
  assert.match(tooMany.standardError, /more than 100000 route-decl facts/);
  const tooLong = renderDocument(() => ({ text: 'x'.repeat(100) }), 50);
  assert.equal(tooLong.exitCode, 2);
  assert.match(tooLong.standardError, /would exceed/);
  const rangeError = renderDocument(() => { throw new RangeError('Invalid string length'); });
  assert.equal(rangeError.exitCode, 2);
  assert.equal(renderDocument(() => ({ a: 1 })).exitCode, 0);
});
