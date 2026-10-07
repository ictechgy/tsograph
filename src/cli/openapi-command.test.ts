import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type CommandFileSystem, createNodeFileSystem } from './file-system.ts';
import { MAX_OUTPUT_LENGTH, MAX_SERVICE_LENGTH, MAX_SPEC_BYTES, runOpenApiCommand } from './openapi-command.ts';

/** 저장소 루트다. fixture 위치를 이 루트 기준으로 싣는다. */
const repositoryRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
/** 합성 fixture 디렉터리다. */
const fixtures = join(repositoryRoot, 'fixtures/openapi');
/** 고정 시계다. */
const fixedNow = () => new Date('2026-09-27T00:00:00.000Z');

/** 실제 파일 시스템으로 명령을 실행한다. */
function run(arguments_: readonly string[], fileSystem: CommandFileSystem = createNodeFileSystem()) {
  return runOpenApiCommand(arguments_, { fileSystem, toolVersion: '0.0.0-test', now: fixedNow });
}

/** fixture를 저장소 루트 기준으로 변환해 문서를 돌려준다. */
async function convertFixture(name: string) {
  const result = await run([join(fixtures, name), '--service', 'demo', '--project', repositoryRoot]);
  assert.equal(result.exitCode, 0, result.standardError);
  return JSON.parse(result.standardOutput) as {
    project: string;
    facts: { method: string; channel: string; pathAnchor: string; dynamic: boolean; location: { path: string; line: number; column: number }; operationId?: string }[];
    limitations: string[];
  };
}

/** 사실을 `METHOD anchor channel` 문자열로 줄인다. */
function routeLines(facts: readonly { method: string; channel: string; pathAnchor: string; dynamic: boolean }[]): string[] {
  return facts.map((fact) => `${fact.method} ${fact.pathAnchor}${fact.dynamic ? '*' : ''} ${fact.channel}`);
}

test('OpenAPI 3.0 YAML: 서버 경로 합성·path 수준 servers·부분 세그먼트·dynamic', async () => {
  const document = await convertFixture('petstore-3.0.yaml');
  assert.equal(document.project, repositoryRoot);
  assert.deepEqual(routeLines(document.facts), [
    'GET root /api/v1/files/{}.json',
    'GET root /api/v1/health',
    'GET root /api/v1/pets',
    'POST root /api/v1/pets',
    'DELETE root /api/v1/pets/{}',
    'GET root /api/v1/pets/{}',
    'GET root* /api/v1/reports/{year}-{month}',
    'GET root /internal/admin/stats',
  ]);
  assert.deepEqual(document.facts[0]?.location, { path: 'fixtures/openapi/petstore-3.0.yaml', line: 30, column: 5 });
  assert.equal(document.facts[1]?.operationId, undefined);
  assert.equal(document.limitations.length, 1);
});

test('Swagger 2.0 JSON: basePath 합성, 2.0의 trace는 모르는 필드', async () => {
  const document = await convertFixture('swagger-2.0.json');
  assert.deepEqual(routeLines(document.facts), [
    'HEAD root /v2/',
    'GET root /v2/items',
    'POST root /v2/items',
    'PATCH root /v2/items/{}',
    'PUT root /v2/items/{}',
  ]);
  assert.deepEqual(document.facts[1]?.location, { path: 'fixtures/openapi/swagger-2.0.json', line: 9, column: 7 });
});

test('OpenAPI 3.1 JSON: enum 펼침, host 변수 무시, 열린 경로 변수는 base, $ref path item', async () => {
  const document = await convertFixture('openapi-3.1.json');
  assert.deepEqual(routeLines(document.facts), [
    'GET base /api/orders/{}',
    'GET root /v1/orders',
    'POST root /v1/orders',
    'GET root /v2/orders',
    'POST root /v2/orders',
  ]);
  assert.match(document.limitations[0]!, /^unresolved-contract-servers: 1 operations/);
});

test('YAML의 비ASCII 경로는 percent-encoding하고 열은 UTF-8 바이트로 센다', async () => {
  const document = await convertFixture('utf8-column.yaml');
  assert.deepEqual(document.facts.map((fact) => [fact.channel, fact.location.line, fact.location.column]), [
    ['/%E5%96%AB%E8%8C%B6%E5%BA%97', 6, 17],
    ['/caf%C3%A9/men%C3%BC', 5, 19],
  ]);
});

test('같은 입력의 출력은 바이트 단위로 같다', async () => {
  const arguments_ = [join(fixtures, 'petstore-3.0.yaml'), '--service', 'demo', '--project', repositoryRoot, '--format', 'json'];
  const first = await run(arguments_);
  const second = await run(arguments_);
  assert.equal(first.standardOutput, second.standardOutput);
  assert.ok(first.standardOutput.endsWith('\n'));
});

test('--project가 없으면 스펙 디렉터리가 조인 루트다', async () => {
  const result = await run([join(fixtures, 'swagger-2.0.json'), '--service', 'demo']);
  const document = JSON.parse(result.standardOutput) as { project: string; facts: { location: { path: string } }[] };
  assert.equal(document.project, fixtures);
  assert.equal(document.facts[0]?.location.path, 'swagger-2.0.json');
});

test('--help는 사용법을 성공으로 낸다', async () => {
  const result = await run(['--help']);
  assert.equal(result.exitCode, 0);
  assert.match(result.standardOutput, /^Usage: tsograph openapi/);
});

test('잘못된 호출은 64다', async () => {
  const spec = join(fixtures, 'swagger-2.0.json');
  const cases: string[][] = [
    [],
    [spec],
    [spec, spec, '--service', 'x'],
    [spec, '--service', 'x', '--format', 'yaml'],
    [spec, '--service', 'x', '--unknown'],
    [spec, '--service'],
    [spec, '--service', 'bad\u0001name'],
    [spec, '--service', 'x'.repeat(MAX_SERVICE_LENGTH + 1)],
    [spec, '--service', 'x', '--project', join(fixtures, '..', '..', 'src')],
  ];
  for (const arguments_ of cases) {
    const result = await run(arguments_);
    assert.equal(result.exitCode, 64, JSON.stringify(arguments_));
    assert.match(result.standardError, /Usage: tsograph openapi/);
  }
});

test('읽을 수 없거나 잘못된 스펙은 2이고 원문을 싣지 않는다', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tsograph-openapi-'));
  try {
    const cases: [string, string | Uint8Array, RegExp][] = [
      ['dup.yaml', 'openapi: 3.0.0\npaths:\n  /secret-path: {}\n  /secret-path: {}\n', /duplicate mapping key \(line 4\)/],
      ['syntax.json', '{"openapi": "3.0.0", "paths": {', /not valid JSON or YAML/],
      ['multi.yaml', 'openapi: 3.0.0\n---\npaths: {}\n', /more than one YAML document/],
      ['deep.json', `${'['.repeat(100_000)}${']'.repeat(100_000)}`, /nested too deeply/],
      ['latin1.yaml', new Uint8Array([0x6f, 0x3a, 0x20, 0xe9, 0x0a]), /not valid UTF-8/],
      ['list.yaml', '- a\n', /top level is not an object/],
      ['noversion.yaml', 'paths: {}\n', /neither an "openapi" nor a "swagger"/],
      ['both.yaml', 'openapi: 3.0.0\nswagger: "2.0"\npaths: {}\n', /both "openapi" and "swagger"/],
      ['v32.yaml', 'openapi: 3.2.0\npaths: {}\n', /version is not supported/],
      ['nopaths.yaml', 'openapi: 3.0.0\n', /no "paths" object/],
      ['badpaths.yaml', 'openapi: 3.0.0\npaths: 1\n', /"paths" field is not an object/],
      ['merge.yaml', 'openapi: 3.0.0\nx: &d {servers: [{url: /api}]}\n<<: *d\npaths: {}\n', /merge key \(<<\) \(line 3\)/],
      ['aliaskey.yaml', 'openapi: 3.0.0\nk: &k servers\n*k : []\npaths: {}\n', /alias or collection as a mapping key/],
      ['flat.json', `{"x": [${'0,'.repeat(1_600_000)}0]}`, /safe parser budget/],
    ];
    for (const [name, content, message] of cases) {
      const path = join(directory, name);
      writeFileSync(path, content);
      const result = await run([path, '--service', 'demo']);
      assert.equal(result.exitCode, 2, name);
      assert.match(result.standardError, message, name);
      assert.doesNotMatch(result.standardError, /secret-path|tsograph-openapi-/, name);
    }
    const missing = await run([join(directory, 'missing.yaml'), '--service', 'demo']);
    assert.equal(missing.exitCode, 2);
    assert.match(missing.standardError, /unable to read the spec file/);
    const directoryInput = await run([directory, '--service', 'demo']);
    assert.equal(directoryInput.exitCode, 2);
    const badProject = await run([join(directory, 'dup.yaml'), '--service', 'demo', '--project', join(directory, 'dup.yaml')]);
    assert.equal(badProject.exitCode, 2);
    assert.match(badProject.standardError, /--project does not name a readable directory/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** 실제 구현을 감싸 일부 연산만 바꾼 가짜 파일 시스템이다. */
function fakeFileSystem(overrides: Partial<CommandFileSystem>): CommandFileSystem {
  return { ...createNodeFileSystem(), ...overrides };
}

test('크기 상한·읽기 실패·금지 문자 경로·alias 폭탄·사실 상한을 2로 보고한다', async () => {
  const spec = join(fixtures, 'swagger-2.0.json');
  const arguments_ = [spec, '--service', 'demo'];
  const huge = fakeFileSystem({ status: async () => ({ kind: 'file', size: MAX_SPEC_BYTES + 1, modifiedAt: new Date(0) }) });
  assert.match((await run(arguments_, huge)).standardError, /exceeds 16777216 bytes/);
  const grown = fakeFileSystem({ readBytes: async () => new Uint8Array(MAX_SPEC_BYTES + 1) });
  assert.match((await run(arguments_, grown)).standardError, /exceeds/);
  const denied = fakeFileSystem({ readBytes: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
  assert.match((await run(arguments_, denied)).standardError, /\(EACCES\)/);
  const opaque = fakeFileSystem({ readBytes: async () => { throw 'boom'; } });
  assert.match((await run(arguments_, opaque)).standardError, /\(unknown error\)/);
  const statFails = fakeFileSystem({ status: async () => { throw new Error('gone'); } });
  assert.equal((await run(arguments_, statFails)).exitCode, 2);
  const unsafeProject = fakeFileSystem({
    realPath: async (path) => (path === spec ? '/tmp/a\u0085b/spec.json' : path),
    status: async () => ({ kind: 'file', size: 10, modifiedAt: new Date(0) }),
  });
  const unsafeResult = await run(arguments_, unsafeProject);
  assert.equal(unsafeResult.exitCode, 2);
  assert.match(unsafeResult.standardError, /characters the exchange format forbids/);

  const bomb = ['openapi: 3.0.0', 'x: &a {get: {}}', 'paths:'];
  for (let index = 0; index < 101_000; index++) bomb.push(`  /p${index}: *a`);
  const bombFs = fakeFileSystem({ readBytes: async () => new TextEncoder().encode(bomb.join('\n')) });
  assert.match((await run(arguments_, bombFs)).standardError, /more than 100000 YAML aliases/);

  const variants = Array.from({ length: 256 }, (_, index) => `v${index}`).join(', ');
  const many = ['openapi: 3.0.0', 'servers: [{url: "/{v}", variables: {v: {default: v0, enum: [' + variants + ']}}}]', 'paths:'];
  for (let index = 0; index < 60; index++) many.push(`  /p${index}: {get: {}, put: {}, post: {}, delete: {}, options: {}, head: {}, patch: {}, trace: {}}`);
  const manyFs = fakeFileSystem({ readBytes: async () => new TextEncoder().encode(many.join('\n')) });
  assert.match((await run(arguments_, manyFs)).standardError, /more than 100000 route-contract facts/);
});

test('한 줄로 압축한 큰 JSON 스펙도 선형에 가까운 시간에 변환한다', { timeout: 30_000 }, async () => {
  const paths: Record<string, unknown> = {};
  const items: Record<string, unknown> = {};
  for (let index = 0; index < 20_000; index++) {
    paths[`/p${index}/{id}`] = { $ref: `#/components/pathItems/P${index}` };
    items[`P${index}`] = { get: { operationId: `op${index}` } };
  }
  const text = JSON.stringify({ openapi: '3.1.0', paths, components: { pathItems: items } });
  const fileSystem = fakeFileSystem({ readBytes: async () => new TextEncoder().encode(text) });
  const result = await run([join(fixtures, 'swagger-2.0.json'), '--service', 'demo'], fileSystem);
  assert.equal(result.exitCode, 0, result.standardError);
  const document = JSON.parse(result.standardOutput) as { facts: { location: { line: number; column: number } }[] };
  assert.equal(document.facts.length, 20_000);
  const last = document.facts.at(-1)!;
  assert.equal(last.location.line, 1);
  assert.equal(last.location.column, text.indexOf('"get"', text.indexOf('"P9999"')) + 1);
});

test('사실 상한을 넘는 조합 폭발은 사실을 만들기 전에 2로 끝난다', { timeout: 20_000 }, async () => {
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const variables = names.map((name) => `${name}: {default: x, enum: [x, y]}`).join(', ');
  const lines = ['openapi: 3.0.0', `servers: [{url: "/${names.map((name) => `{${name}}`).join('')}", variables: {${variables}}}]`, 'paths:'];
  for (let index = 0; index < 30_000; index++) lines.push(`  /p${index}: {get: {}, put: {}, post: {}, delete: {}}`);
  const fileSystem = fakeFileSystem({ readBytes: async () => new TextEncoder().encode(lines.join('\n')) });
  const result = await run([join(fixtures, 'swagger-2.0.json'), '--service', 'demo'], fileSystem);
  assert.equal(result.exitCode, 2);
  assert.match(result.standardError, /more than 100000 route-contract facts/);
});

test('들여쓰기만 큰 OpenAPI 출력은 모든 사실을 보존한 압축 JSON으로 소비자 상한 안에 낸다', { timeout: 20_000 }, async () => {
  const variants = Array.from({ length: 256 }, (_, index) => `v${index}`).join(', ');
  const lines = ['openapi: 3.0.0', `servers: [{url: "/{v}", variables: {v: {default: v0, enum: [${variants}]}}}]`, 'paths:'];
  for (let index = 0; index < 40; index++) lines.push(`  /p${index}: {get: {}, put: {}, post: {}, delete: {}, options: {}, head: {}, patch: {}, trace: {}}`);
  const fileSystem = fakeFileSystem({ readBytes: async () => new TextEncoder().encode(lines.join('\n')) });
  const result = await run([join(fixtures, 'swagger-2.0.json'), '--service', 'demo'], fileSystem);
  assert.equal(result.exitCode, 0, result.standardError);
  assert.equal(JSON.parse(result.standardOutput).facts.length, 256 * 40 * 8);
  assert.ok(result.standardOutput.length <= MAX_OUTPUT_LENGTH);
});

test('압축해도 isthmus 입력 상한을 넘는 출력은 쓰지 않고 2로 끝난다', { timeout: 20_000 }, async () => {
  const variants = Array.from({ length: 256 }, (_, index) => `v${index}`).join(', ');
  const lines = ['openapi: 3.0.0', `servers: [{url: "/{v}", variables: {v: {default: v0, enum: [${variants}]}}}]`, 'paths:'];
  const prefix = Array.from({ length: 16 }, (_, index) => `segment-${index}`).join('/');
  for (let index = 0; index < 40; index++) lines.push(`  /${prefix}/p${index}: {get: {}, put: {}, post: {}, delete: {}, options: {}, head: {}, patch: {}, trace: {}}`);
  const fileSystem = fakeFileSystem({ readBytes: async () => new TextEncoder().encode(lines.join('\n')) });
  const result = await run([join(fixtures, 'swagger-2.0.json'), '--service', 'demo'], fileSystem);
  assert.equal(result.exitCode, 2);
  assert.equal(result.standardOutput, '');
  assert.match(result.standardError, new RegExp(`exceed ${MAX_OUTPUT_LENGTH} characters`));
});

test('components.schemas의 중복 키는 코드 0과 duplicate-mapping-keys limitation이다', async () => {
  const text = [
    'openapi: 3.0.3',
    'paths:',
    '  /items: {get: {operationId: listItems}}',
    'components:',
    '  schemas:',
    '    Item:',
    '      type: object',
    '      description: first',
    '    Item:',
    '      type: object',
    '      description: second',
  ].join('\n');
  const fileSystem = fakeFileSystem({ readBytes: async () => new TextEncoder().encode(text) });
  const result = await run([join(fixtures, 'swagger-2.0.json'), '--service', 'demo'], fileSystem);
  assert.equal(result.exitCode, 0, result.standardError);
  const document = JSON.parse(result.standardOutput) as { facts: { channel: string }[]; limitations: string[] };
  assert.deepEqual(document.facts.map((fact) => fact.channel), ['/items']);
  assert.deepEqual(document.limitations, ['duplicate-mapping-keys: 1 duplicate key(s) outside route-bearing sections were ignored (first at line 9)']);
});

test('경로 키·path item method·서버 변수의 중복 키는 코드 2다', async () => {
  const cases: [string, string, number][] = [
    ['path key', 'openapi: 3.0.3\npaths:\n  /items: {get: {}}\n  /items: {post: {}}\n', 4],
    ['method', 'openapi: 3.0.3\npaths:\n  /items:\n    get: {operationId: a}\n    get: {operationId: b}\n', 5],
    ['server variable', 'openapi: 3.0.3\nservers:\n  - url: "https://h.test/{v}"\n    variables:\n      v: {default: v1}\n      v: {default: v2}\npaths: {/items: {get: {}}}\n', 6],
  ];
  for (const [name, text, line] of cases) {
    const fileSystem = fakeFileSystem({ readBytes: async () => new TextEncoder().encode(text) });
    const result = await run([join(fixtures, 'swagger-2.0.json'), '--service', 'demo'], fileSystem);
    assert.equal(result.exitCode, 2, name);
    assert.match(result.standardError, new RegExp(`duplicate mapping key \\(line ${line}\\)`), name);
  }
});

test('이스케이프 시퀀스가 앞에 있는 줄에서도 열은 파일 원문의 UTF-8 바이트 열이다', async () => {
  // yaml 노드 오프셋은 디코드한 값이 아니라 원문 텍스트 위치라, 이스케이프는 원문 길이 그대로 센다.
  const json = '{"openapi":"3.0.0","paths":{"/a":{"x-note":"\\u0041\\"\\\\\\n\\u00e9 é 😀","get":{}}}}';
  const yaml = 'openapi: 3.0.0\npaths:\n  "/\\u00e9": {x-note: "\\t\\u00e9é", put: {}}\n';
  for (const [text, key, line] of [[json, '"get"', 1], [yaml, 'put', 3]] as const) {
    const bytes = new TextEncoder().encode(text);
    const fileSystem = fakeFileSystem({ readBytes: async () => bytes });
    const result = await run([join(fixtures, 'swagger-2.0.json'), '--service', 'demo'], fileSystem);
    assert.equal(result.exitCode, 0, result.standardError);
    const document = JSON.parse(result.standardOutput) as { facts: { location: { line: number; column: number } }[] };
    const lineStart = Buffer.from(bytes).indexOf(text.split('\n')[line - 1]!);
    const expectedColumn = Buffer.from(bytes).indexOf(key, lineStart) - lineStart + 1;
    assert.deepEqual(document.facts[0]?.location, { path: 'swagger-2.0.json', line, column: expectedColumn }, key);
  }
});
