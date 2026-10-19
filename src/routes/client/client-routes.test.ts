/** 웹·RN 호출부 추출의 외부 계약을 합성 프로젝트로 검증한다. */
import assert from 'node:assert/strict';
import { chmodSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../../cli/file-system.ts';
import { runRoutesCommand } from '../../cli/routes-command.ts';
import { ambientTypesFreeConfig, linkToDevZero, makeFifo, runCliGuarded, runMainGuarded } from '../../cli/testing.test.ts';
import { buildCallGraph } from '../../graph/build-graph.ts';

/** 문서 경계에서 관찰할 사실이다. */
interface Fact {
  kind: string; channel: string | null; method?: string; methodDynamic?: true;
  dynamic: boolean; pathAnchor: string; authority?: string; service?: string; queryTailStripped?: true;
  channelPrefix?: string; maskedSegments?: number; testSource?: true;
  symbol?: { usr: string }; location: { path: string; line: number; column: number };
}
/** 임시 합성 프로젝트에서 실제 routes 명령을 실행한다. */
async function scan(source: string, extra: readonly string[] = [], more: Record<string, string> = {}, verifyGraph = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-client-')));
  try {
    const files = { 'package.json': '{"dependencies":{"ky":"2.1.0","axios":"1.20.0"}}', 'src/client.ts': source, ...more };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const result = await runRoutesCommand(['--role', 'client', '--project', root, ...extra], {
      fileSystem: createNodeFileSystem(), toolVersion: '0.0.0-test', now: () => new Date('2026-10-01T00:00:00Z'),
    });
    assert.equal(result.exitCode, 0, result.standardError);
    const document = JSON.parse(result.standardOutput) as { roles: string[]; sourceSets: { tests: string }; facts: Fact[]; limitations: string[] };
    if (verifyGraph) {
      const graph = await buildCallGraph(root, createNodeFileSystem());
      const ids = new Set(graph.nodes.map((node) => node.id));
      for (const fact of document.facts) assert.ok(ids.has(fact.symbol!.usr), `missing graph id: ${fact.symbol!.usr}`);
    }
    return document;
  } finally { rmSync(root, { recursive: true, force: true }); }
}

/** 명시 모델을 함께 읽는 합성 프로젝트에서 실제 routes 명령을 실행한다. */
async function scanTyped(source: string, model: unknown, extra: readonly string[] = [], more: Record<string, string> = {}) {
  return scan(source, ['--client-model', 'client-model.json', ...extra], { ...more, 'client-model.json': JSON.stringify(model) });
}

test('fetch/RN: method, whole segments, query stripping, UTF-8 location and graph identity', async () => {
  const doc = await scan('export function load(id: string) { const 한글 = 1; return fetch(`https://API.example.com/v1/items/${id}?q=${id}`, { method: "post" }); }');
  assert.deepEqual(doc.roles, ['client']);
  assert.deepEqual(doc.sourceSets, { tests: 'excluded' });
  assert.equal(doc.facts.length, 1);
  const fact = doc.facts[0]!;
  assert.equal(fact.kind, 'route-call');
  assert.equal(fact.channel, '/v1/items/{}');
  assert.equal(fact.method, 'POST');
  assert.equal(fact.authority, 'api.example.com');
  assert.equal(fact.pathAnchor, 'root');
  assert.equal(fact.queryTailStripped, true);
  assert.equal(fact.symbol?.usr, 'src/client.ts#load');
  assert.equal(fact.location.column, Buffer.byteLength('export function load(id: string) { const 한글 = 1; return ') + 1);
});

test('typed model binds an opaque transport through an exact declared type', async () => {
  const doc = await scanTyped(`
    type CatalogClient = { getItem(path: string): unknown };
    declare const client: CatalogClient;
    export function load(id: string) { return client.getItem('/items/' + id); }
  `, {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/client.ts', name: 'CatalogClient' }, methods: [
      { name: 'getItem', method: 'GET', pathArgument: 0, base: 'https://api.example.test/v1', service: 'catalog' },
    ] }],
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel, fact.authority, fact.service]), [['GET', '/v1/items/{}', 'api.example.test', 'catalog']]);
});

test('client routes use an explicit package config with workspace-relative graph ids', async () => {
  const doc = await scanTyped("import type { CatalogPort } from '@lib/api'; declare const port: CatalogPort; export function load() { port.read('/items'); }", {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'packages/lib/api.ts', name: 'CatalogPort' },
      methods: [{ name: 'read', method: 'GET', pathArgument: 0, base: '/v2' }] }],
  }, ['--tsconfig', 'configs/client.json'], {
    'configs/client.json': '{"compilerOptions":{"baseUrl":"..","paths":{"@lib/*":["packages/lib/*"]}}}',
    'packages/lib/api.ts': 'export interface CatalogPort { read(path: string): unknown; }',
  });
  assert.equal(doc.facts[0]?.channel, '/v2/items');
  assert.equal(doc.facts[0]?.symbol?.usr, 'src/client.ts#load');
});

test('typed model follows imports and aliases but rejects same-name, untyped and ambiguous receivers', async () => {
  const doc = await scanTyped(`
    import type { CatalogClient as Imported } from './api';
    type Alias = Imported;
    declare const typed: Alias;
    declare const untyped: any;
    declare const unknownValue: unknown;
    declare const ambiguous: Imported | Other;
    function load() { typed.getItem('/typed'); untyped.getItem('/any'); unknownValue.getItem('/unknown'); ambiguous.getItem('/ambiguous'); }
  `, {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'CatalogClient' }, methods: [
      { name: 'getItem', method: 'GET', pathArgument: 0, base: '/v1' },
    ] }],
  }, [], { 'src/api.ts': 'export interface CatalogClient { getItem(path: string): unknown; } interface Other { getItem(path: string): unknown; }' });
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel]), [['GET', '/v1/typed']]);
});

test('typed model class identity and service conflict remain explicit', async () => {
  const doc = await scanTyped(`
    class CatalogClient { getItem(path: string) { return transport(path); } }
    declare const transport: (path: string) => unknown;
    export function load() { new CatalogClient().getItem('/items'); }
  `, {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'class', path: 'src/client.ts', name: 'CatalogClient' }, methods: [
      { name: 'getItem', method: 'POST', pathArgument: 0, base: '/v2', service: 'catalog' },
    ] }],
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel, fact.service]), [['POST', '/v2/items', 'catalog']]);
});

test('typed model follows a named Pick alias from its TypeReference declaration', async () => {
  const doc = await scanTyped(`
    type ConcretePort = { read(path: string): unknown };
    type GatewayPort = Pick<ConcretePort, 'read'>;
    declare const gateway: GatewayPort;
    gateway.read('/pick');
  `, {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/client.ts', name: 'GatewayPort' }, methods: [
      { name: 'read', method: 'GET', pathArgument: 0, base: '/typed' },
    ] }],
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel]), [['GET', '/typed/pick']]);
});

test('typed models prefer the declared alias before its expanded identity independent of file order', async () => {
  const source = 'type ConcretePort = { read(path: string): unknown }; type GatewayPort = ConcretePort; declare const port: GatewayPort; port.read("/items");';
  const model = (name: string, base: string) => ({ receiver: { kind: 'type', path: 'src/client.ts', name },
    methods: [{ name: 'read', method: 'GET', pathArgument: 0, base }] });
  for (const models of [[model('ConcretePort', '/expanded'), model('GatewayPort', '/declared')], [model('GatewayPort', '/declared'), model('ConcretePort', '/expanded')]]) {
    const doc = await scanTyped(source, { format: 'http-client-models', version: 1, models });
    assert.equal(doc.facts[0]?.channel, '/declared/items');
  }
});

test('typed model missing path arguments remain dynamic and absolute paths use the declared base-URL rule', async () => {
  const doc = await scanTyped('type CatalogPort = { read(path?: string): unknown }; declare const port: CatalogPort; port.read(); port.read("https://other.example.test/items");', {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/client.ts', name: 'CatalogPort' },
      methods: [{ name: 'read', method: 'GET', pathArgument: 0, base: 'https://api.example.test/v2' }] }],
  });
  assert.equal(doc.facts[0]?.dynamic, true);
  assert.equal(doc.facts[0]?.channel, null);
  assert.equal(doc.facts[1]?.authority, 'other.example.test');
  assert.equal(doc.facts[1]?.channel, '/items');
});

test('typed model follows an imported named Pick alias by its declaration symbol', async () => {
  const doc = await scanTyped(`
    import type { GatewayPort as ImportedGateway } from './api';
    declare const gateway: ImportedGateway;
    gateway.read('/imported-pick');
  `, {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/api.ts', name: 'GatewayPort' }, methods: [
      { name: 'read', method: 'GET', pathArgument: 0, base: '/typed' },
    ] }],
  }, [], { 'src/api.ts': 'type ConcretePort = { read(path: string): unknown }; export type GatewayPort = Pick<ConcretePort, \'read\'>;' });
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel]), [['GET', '/typed/imported-pick']]);
});

test('typed model preserves the declared local alias identity before expanded type identity', async () => {
  const doc = await scanTyped(`
    import type { CatalogClient as Imported } from './api';
    type GatewayPort = Imported;
    declare const gateway: GatewayPort;
    gateway.getItem('/declared-alias');
  `, {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/client.ts', name: 'GatewayPort' }, methods: [
      { name: 'getItem', method: 'GET', pathArgument: 0, base: '/typed' },
    ] }],
  }, [], { 'src/api.ts': 'export interface CatalogClient { getItem(path: string): unknown; }' });
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel]), [['GET', '/typed/declared-alias']]);
});

test('typed model rejects reassigned receivers, replaced methods and nested same-name declarations', async () => {
  const doc = await scanTyped(`
    type GatewayPort = { read(path: string): unknown };
    declare const replacement: GatewayPort;
    let gateway: GatewayPort = replacement;
    gateway = replacement;
    gateway.read = replacement.read;
    gateway.read('/replaced');
    function nested() {
      type GatewayPort = { read(path: string): unknown };
      declare const inner: GatewayPort;
      inner.read('/nested');
    }
  `, {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/client.ts', name: 'GatewayPort' }, methods: [
      { name: 'read', method: 'GET', pathArgument: 0, base: '/typed' },
    ] }],
  });
  assert.deepEqual(doc.facts, []);
});

test('typed model calls stay as dynamic facts when mutation analysis is incomplete', async () => {
  // 예전에는 변경 분석이 미완(여기서는 증명하지 못한 변경 수신자)이면 typed 호출 사실이 문서에서 사라졌다. 지금은 모델
  // 동사·service의 dynamic 사실로 남긴다. 변경을 확인한 수신자(`replaced`)는 그때도 승격하지 않는다.
  const doc = await scanTyped(`
    type CatalogPort = { read(path: string): unknown };
    declare const port: CatalogPort;
    declare const replaced: CatalogPort;
    declare function runtime(): { method: string };
    runtime().method = 'POST';
    replaced.read = port.read;
    port.read('/items');
    replaced.read('/replaced');
  `, {
    format: 'http-client-models', version: 1, models: [{ receiver: { kind: 'type', path: 'src/client.ts', name: 'CatalogPort' }, methods: [
      { name: 'read', method: 'GET', pathArgument: 0, base: '/v2', service: 'catalog' },
    ] }],
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel, fact.dynamic, fact.pathAnchor, fact.service]), [
    ['GET', null, true, 'base', 'catalog'],
  ]);
  assert.ok(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')));
});

test('axios aliases, instances, config overrides, config-call and default methods', async () => {
  const doc = await scan(`import http from 'axios';
    const client = http.create({ baseURL: 'https://api.example.com/v1/' });
    export function load() {
      client.get('/items'); client.post('items', { method: 'DELETE' });
      client.request({ url: '/items/../users', method: 'put' });
      client('/search', { baseURL: 'https://other.example.com/v2' });
      http({ url: 'https://third.example.com/ping' });
    }`);
  assert.deepEqual(doc.facts.map((f) => [f.method, f.channel, f.authority]), [
    ['GET', '/v1/items', 'api.example.com'], ['POST', '/v1/items', 'api.example.com'],
    ['PUT', '/v1/users', 'api.example.com'], ['GET', '/v2/search', 'other.example.com'],
    ['GET', '/ping', 'third.example.com'],
  ]);
});

test('ky 2 prefix/baseUrl and legacy ky 1 prefixUrl are distinct joins', async () => {
  const doc = await scan(`import ky from 'ky';
    const api = ky.create({ prefix: 'https://api.example.com/v1///' });
    export function load() { api.get('/items'); ky('users', { baseUrl: 'https://api.example.com/v1' });
      ky.post('/users', { baseUrl: 'https://api.example.com/v1/' }); }`);
  assert.deepEqual(doc.facts.map((f) => [f.method, f.channel]), [['GET', '/v1/items'], ['GET', '/users'], ['POST', '/users']]);
  const legacy = await scan(`import ky from 'ky'; ky('items', {prefixUrl: 'https://api.example.com/v1'}); ky('/items', {prefixUrl: 'https://api.example.com/v1'});`, [], {
    'package.json': '{"dependencies":{"ky":"1.10.0"}}',
  });
  assert.equal(legacy.facts[0]?.channel, '/v1/items');
  assert.equal(legacy.facts[1]?.dynamic, true);
});

/** ky 2 `prefix` 결합을 쓰는 호출이다(major를 모르면 결합 방식을 정하지 않는다). */
const kyPrefixSource = "import ky from 'ky';\nexport function load() { return ky('items', { prefix: 'https://api.example.com/v1' }); }\n";

/** 선언 major를 모를 때 ky 호출에 싣는 limitation이다. */
const kyMajorUnknown = 'route-call-coverage: ky URL option dialect requires an unambiguous declared major version (1 or 2)';

test('FIFO or device-link package.json is neither awaited nor read without bound and leaves the ky major unknown', {
  skip: process.platform === 'win32',
}, async () => {
  const places = [makeFifo, linkToDevZero];
  const roots: string[] = [];
  try {
    for (const place of places) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-client-special-')));
      roots.push(root);
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/client.ts'), kyPrefixSource);
      place(join(root, 'package.json'));
    }
    // 수정 전 코드는 이 manifest에서 멈추거나 메모리를 끝없이 쓰므로 감시하는 자식 프로세스에서 추출한다.
    // 두 특수 파일 종류의 프로젝트는 그 자식 하나에서 차례로 추출한다.
    const { child, results } = await runCliGuarded(roots.map((root) => ['routes', '--role', 'client', '--project', root]));
    assert.equal(child.stopped, undefined, child.stderr);
    assert.equal(child.status, 0, child.stderr);
    for (const [index, place] of places.entries()) {
      const result = results[index];
      assert.ok(result !== undefined, place.name);
      assert.equal(result.exitCode, 0, `${place.name}: ${result.standardError}`);
      const document = JSON.parse(result.standardOutput) as { facts: Fact[]; limitations: string[] };
      assert.ok(document.limitations.includes(kyMajorUnknown), place.name);
      assert.equal(document.facts[0]?.dynamic, true, place.name);
    }
  } finally {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test('a symlinked package.json is not followed for the ky major while a regular one keeps the declared dialect', {
  skip: !constants.O_NOFOLLOW,
}, async () => {
  // 이 파일의 상한·공백 테스트 fixture는 저장소 @types/node를 읽지 않는 tsconfig를 둔다(검사와 무관한 Program 비용).
  const regular = await scan(kyPrefixSource, [], { 'tsconfig.json': ambientTypesFreeConfig });
  assert.equal(regular.limitations.includes(kyMajorUnknown), false);
  assert.equal(regular.facts[0]?.channel, '/v1/items');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-client-linked-')));
  try {
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'config/package.json'), '{"dependencies":{"ky":"2.1.0"}}');
    symlinkSync(join(root, 'config/package.json'), join(root, 'package.json'));
    writeFileSync(join(root, 'tsconfig.json'), ambientTypesFreeConfig);
    writeFileSync(join(root, 'src/client.ts'), kyPrefixSource);
    const result = await runRoutesCommand(['--role', 'client', '--project', root], {
      fileSystem: createNodeFileSystem(), toolVersion: '0.0.0-test', now: () => new Date('2026-10-01T00:00:00Z'),
    });
    assert.equal(result.exitCode, 0, result.standardError);
    const document = JSON.parse(result.standardOutput) as { facts: Fact[]; limitations: string[] };
    assert.ok(document.limitations.includes(kyMajorUnknown));
    assert.equal(document.facts[0]?.dynamic, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dynamic path/method/config and unknown base retain honest limitations without source leakage', async () => {
  const doc = await scan(`import axios from 'axios';
    export function load(name, method, options, baseURL) {
      fetch('/files/' + name + '.json', {method}); fetch('/fixed', {...options});
      axios.get('/items', {baseURL}); fetch('/api/items' + name);
    }`);
  assert.equal(doc.facts[0]?.dynamic, true);
  assert.equal(doc.facts[0]?.channelPrefix, '/files/');
  assert.equal(doc.facts[0]?.methodDynamic, true);
  assert.equal(doc.facts[1]?.methodDynamic, true);
  assert.equal(doc.facts[2]?.pathAnchor, 'base');
  assert.equal(doc.facts[2]?.channel, '/items');
  assert.equal(doc.facts[3]?.channel, null);
  assert.ok(doc.limitations.some((l) => l.startsWith('unresolved-route-prefix:')));
});

test('same-file/local/imported constants resolve by symbol; shadowed fetch is not a sink', async () => {
  const doc = await scan(`import { path } from './paths'; const METHOD = 'PATCH';
    export function load() { const local = '/local'; fetch(local); fetch(path, { method: METHOD }); }
    export function fake(fetch) { fetch('/not-network'); }
    const http = { get() {} }; http.get('/not-network');`, [], { 'src/paths.ts': "export const path = '/imported';" });
  assert.deepEqual(doc.facts.map((f) => [f.method, f.channel]), [['GET', '/local'], ['PATCH', '/imported']]);
});

test('mutable options, interceptors and hooks invalidate static requests', async () => {
  const doc = await scan(`import axios from 'axios'; import ky from 'ky';
    const opts = {method: 'GET'}; opts.method = 'DELETE';
    const api = axios.create({baseURL: 'https://api.example.com/v1'});
    api.interceptors.request.use((c) => c);
    fetch('/items', opts); api.get('/items'); ky('/items', { hooks: {beforeRequest: []} });`);
  assert.equal(doc.facts[0]?.methodDynamic, true);
  assert.equal(doc.facts[1]?.dynamic, true);
  assert.equal(doc.facts[2]?.dynamic, true);
  assert.ok(doc.limitations.some((l) => l.startsWith('route-call-coverage:')));
});

test('test exclusion, inline callback id, secret masking and query/userinfo removal', async () => {
  const doc = await scan(`export function Screen() { useEffect(() => fetch('https://user:pass@api.example.com/items/Abcdefgh1234567890?token=secret#secret'), []); }`, [], {
    'tests/network.test.ts': "fetch('/test-only');",
  });
  assert.equal(doc.facts.length, 1);
  assert.equal(doc.facts[0]?.channel, '/items/{}');
  assert.equal(doc.facts[0]?.maskedSegments, 1);
  assert.equal(doc.facts[0]?.symbol?.usr, 'src/client.ts#Screen.useEffect()');
  assert.ok(!JSON.stringify(doc).includes('secret'));
  const included = await scan("fetch('/normal');", ['--include-tests'], { 'tests/network.test.ts': "fetch('/test-only');" });
  assert.equal(included.facts.length, 2);
  assert.equal(included.facts[1]?.testSource, true);
});

test('escaped options, cyclic constants, request overloads and invalid method stay conservative', async () => {
  const doc = await scan(`import axios from 'axios';
    const opts = {baseURL:'https://api.example.com/v1'}; change(opts);
    const a = b; const b = a;
    axios.get('/items', opts); fetch(a); fetch('/items', {method:'CUSTOM'});
    axios.request('https://api.example.com/items', {method:'patch'}); axios();
    export function load(id) {const suffix = id ? '?q=' + id : ''; return fetch('/items/' + id + suffix);}`);
  assert.equal(doc.facts[0]?.dynamic, true);
  assert.equal(doc.facts[1]?.dynamic, true);
  assert.equal(doc.facts[2]?.methodDynamic, true);
  assert.equal(doc.facts[3]?.method, 'PATCH');
  assert.equal(doc.facts[3]?.channel, '/items');
  assert.equal(doc.facts[4]?.dynamic, true);
  assert.equal(doc.facts[5]?.channel, '/items/{}');
  assert.equal(doc.facts[5]?.queryTailStripped, true);
});

test('instance create inheritance and library method identity match real APIs', async () => {
  const doc = await scan(`import axios from 'axios'; import ky from 'ky';
    const parent = axios.create({baseURL:'https://api.example.com/v1'});
    const child = parent.create({}); child.get('/items');
    axios.GET('/fake'); axios.trace('/fake'); ky.request('/fake'); ky.options('/fake');`);
  assert.deepEqual(doc.facts.map((f) => f.channel), ['/v1/items']);
});

test('a shared imported configuration mutation invalidates consumers in other modules', async () => {
  const doc = await scan(`import {opts} from './options'; opts.method = 'DELETE';`, [], {
    'src/options.ts': "export const opts = {method:'GET'};",
    'src/use.ts': "import {opts} from './options'; fetch('/items',opts);",
  });
  assert.equal(doc.facts[0]?.methodDynamic, true);
});

test('deep object escape invalidates the nested config without degrading an unrelated request', async () => {
  const nested = (value: string) => Array.from({ length: 17 }, () => '{ value: ').join('')
    + value + Array.from({ length: 17 }, () => ' }').join('');
  const doc = await scan(`declare function register(value: unknown): void;
    const inline = { method: 'GET' }; const aliased = { method: 'GET' }; const stable = { method: 'GET' };
    const holder = ${nested('aliased')}; const alias = holder;
    register(${nested('inline')}); register(alias);
    fetch('/inline', inline); fetch('/aliased', aliased); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('unknown value boundaries traverse containers properties constructors callbacks tags and conditionals', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    declare function tag(strings: TemplateStringsArray, ...values: unknown[]): unknown;
    declare class Registry { constructor(value: unknown); }
    declare const condition: boolean;
    const array = { method: 'GET' }; const property = { method: 'GET' };
    const sibling = { method: 'GET' }; const holder = { property, sibling };
    const constructed = { method: 'GET' }; const returned = { method: 'GET' };
    const tagged = { method: 'GET' }; const conditional = { method: 'GET' };
    const direct = { method: 'POST' }; const stable = { method: 'GET' };
    register([array]); register(holder.property); new Registry(constructed);
    register(() => returned); tag\`value=\${tagged}\`; register(condition ? conditional : null);
    fetch('/array', array); fetch('/property', property); fetch('/sibling', sibling);
    fetch('/constructed', constructed); fetch('/returned', returned); fetch('/tagged', tagged);
    fetch('/conditional', conditional); fetch('/direct', direct); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/sibling', 'GET', undefined],
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], ['/direct', 'POST', undefined], ['/stable', 'GET', undefined],
  ]);
});

test('wrapper call arguments become unknown when an earlier callback escape invalidates its receiver', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const options = { method: 'GET' }; const stable = { method: 'GET' };
    const api = { request(config: typeof options) { return fetch('/hidden', config); } };
    register(() => api); api.request(options); fetch('/options', options); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('mutation aliases flow back through binding assignment and nonidentifier receivers', async () => {
  const doc = await scan(`const binding = { method: 'GET' }; const holder = { opts: binding };
    const { opts: renamed } = holder; renamed.method = 'POST';
    const assigned = { method: 'GET' }; let alias: typeof assigned; alias = assigned; alias.method = 'POST';
    const indexed = { method: 'GET' }; [indexed][0].method = 'POST';
    const borrowed = { method: 'GET' }; let untouched: typeof borrowed; untouched = borrowed;
    const stable = { method: 'GET' };
    fetch('/binding', binding); fetch('/assigned', assigned); fetch('/indexed', indexed);
    fetch('/borrowed', borrowed); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    ['/borrowed', 'GET', undefined], ['/stable', 'GET', undefined],
  ]);
});

test('assignment patterns and stored values retain provenance until an alias escapes or mutates', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const objectValue = { method: 'GET' }; const holder = { opts: objectValue };
    let objectAlias: typeof objectValue; ({ opts: objectAlias } = holder); objectAlias.method = 'POST';
    const arrayValue = { method: 'GET' }; let arrayAlias: typeof arrayValue;
    [arrayAlias] = [arrayValue]; arrayAlias.method = 'POST';
    const nestedValue = { method: 'GET' }; let nestedAlias: typeof nestedValue;
    ({ outer: { opts: nestedAlias } } = { outer: { opts: nestedValue } }); nestedAlias.method = 'POST';
    const defaultValue = { method: 'GET' }; let defaultAlias: typeof defaultValue;
    ({ missing: defaultAlias = defaultValue } = {}); defaultAlias.method = 'POST';
    const restValue = { method: 'GET' }; let restAlias: { opts: typeof restValue };
    ({ ...restAlias } = { opts: restValue }); restAlias.opts.method = 'POST';
    const objectStored = { method: 'GET' }; const box: { cfg?: typeof objectStored } = {};
    box.cfg = objectStored; register(box);
    const stored = { method: 'GET' }; const list: unknown[] = []; list[2] = stored; register(list[2]);
    const storedOnly = { method: 'GET' }; const localBox: { cfg?: typeof storedOnly } = {}; localBox.cfg = storedOnly;
    const borrowed = { method: 'GET' }; let untouched: typeof borrowed;
    ({ opts: untouched } = { opts: borrowed });
    const stable = { method: 'GET' };
    fetch('/object', objectValue); fetch('/array', arrayValue); fetch('/nested', nestedValue);
    fetch('/default', defaultValue); fetch('/rest', restValue); fetch('/object-stored', objectStored); fetch('/stored', stored);
    fetch('/stored-only', storedOnly); fetch('/borrowed', borrowed); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    ['/stored-only', 'GET', undefined], ['/borrowed', 'GET', undefined], ['/stable', 'GET', undefined],
  ]);
});

test('logical aliases and runtime roots invalidate every reachable client or configuration', async () => {
  const doc = await scan(`import axios from 'axios'; const http = axios;
    axios.defaults.baseURL = 'https://changed.example.com'; http.interceptors.request.use(value => value);
    const nullishValue = { method: 'GET' }; declare let nullishAlias: typeof nullishValue | undefined;
    nullishAlias ??= nullishValue; nullishAlias.method = 'POST';
    const orValue = { method: 'GET' }; declare let orAlias: typeof orValue | undefined;
    orAlias ||= orValue; orAlias.method = 'POST';
    const andValue = { method: 'GET' }; declare let andAlias: typeof andValue | undefined;
    andAlias &&= andValue; andAlias!.method = 'POST';
    const stable = { method: 'GET' };
    axios.get('/bare'); http.get('/alias'); fetch('/nullish', nullishValue);
    fetch('/or', orValue); fetch('/and', andValue); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, 'GET', undefined], [null, 'GET', undefined], [null, undefined, true],
    [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('rest computed iteration and direct return sources invalidate their actual values', async () => {
  const doc = await scan(`const first = { method: 'GET' }; const restValue = { method: 'GET' };
    const [, ...others] = [first, restValue]; others[0].method = 'POST';
    const computedValue = { method: 'GET' }; const holder = { opts: computedValue }; const key = 'opts';
    const { [key]: computedAlias } = holder; computedAlias.method = 'POST';
    const iterated = { method: 'GET' }; for (const item of [iterated]) item.method = 'POST';
    const returned = { method: 'GET' }; function current() { return returned; } current().method = 'POST';
    const stable = { method: 'GET' };
    fetch('/rest', restValue); fetch('/computed', computedValue); fetch('/iterated', iterated);
    fetch('/returned', returned); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('unknown receiver methods expose container values while HTTP sinks remain exact', async () => {
  const doc = await scan(`const iterated = { method: 'GET' }; const list = [iterated];
    list.forEach(value => { value.method = 'POST'; });
    const direct = { method: 'POST' }; const stable = { method: 'GET' };
    fetch('/iterated', iterated); fetch('/direct', direct); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/direct', 'POST', undefined], ['/stable', 'GET', undefined],
  ]);
});

test('unresolved mutation receivers and cyclic projections fail closed with observable bounds', async () => {
  const unresolved = await scan(`declare function runtime(): { method: string };
    runtime().method = 'POST'; const stable = { method: 'GET' }; fetch('/stable', stable);`);
  assert.deepEqual(unresolved.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [[null, undefined, true]]);
  assert.ok(unresolved.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')));
  const cyclic = await scan(`declare function register(value: unknown): void;
    const a: any = b.x; const b: any = a.y; register(a.z);
    const stable = { method: 'GET' }; fetch('/stable', stable);`);
  assert.deepEqual(cyclic.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [[null, undefined, true]]);
  assert.ok(cyclic.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')));
});

test('shared mutation traversal reuses a large container without tainting an unrelated config', async () => {
  const properties = Array.from({ length: 100 }, (_, index) => `p${index}: ${index}`).join(',');
  const escapes = Array.from({ length: 2_000 }, () => 'register(holder);').join('');
  const doc = await scan(`declare function register(value: unknown): void;
    const escaped = { method: 'GET' }; const holder = { escaped, ${properties} };
    ${escapes} const stable = { method: 'GET' }; fetch('/escaped', escaped); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('client mutation work exhaustion stays conservative and reports incomplete coverage', async () => {
  const properties = Array.from({ length: 20_001 }, (_, index) => `p${index}: ${index}`).join(',');
  const doc = await scan(`import axios from 'axios'; declare function register(value: unknown): void;
    const api = axios; register({${properties}}); register({ api });
    fetch('/after-cap', { method: 'GET' }); api.get('/client-after-cap');`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, 'GET', undefined],
  ]);
  assert.ok(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')));
});

test('array spread positions cannot certify a numeric configuration projection', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const opts = { method: 'GET' }; const list = [...[0, 0], opts]; register(list[2]);
    const stable = { method: 'GET' }; fetch('/spread', opts); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('stored numeric and string keys identify the same runtime configuration property', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const opts = { method: 'GET' }; const list: unknown[] = []; list[2] = opts; register(list['2']);
    const stable = { method: 'GET' }; fetch('/stored', opts); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('constructed class aliases and actual namespaces retain configuration source identity', async () => {
  const doc = await scan(`import * as model from './model'; import { imported } from './model';
    declare function register(value: unknown): void;
    const declared = { method: 'GET' }, expression = { method: 'GET' };
    class Holder { cfg = declared; } const Alias = Holder;
    const Expression = class { cfg = expression; }; const Other = Expression;
    register(new Alias()); register(new Other()); register(new model.Holder());
    const stable = { method: 'GET' };
    fetch('/declared', declared); fetch('/expression', expression); fetch('/imported', imported); fetch('/stable', stable);`, [], {
    'src/model.ts': "export const imported = { method: 'GET' }; export class Holder { cfg = imported; }",
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('escaping constructor values expose class sources without tainting unrelated configs', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const declared = { method: 'GET' }, expression = { method: 'GET' };
    class Holder { cfg = declared; } const Alias = Holder;
    const Other = class { cfg = expression; };
    register(Alias); register(Other);
    const stable = { method: 'GET' }; fetch('/declared', declared); fetch('/expression', expression); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('escaping actual namespace constructor values expose returned class configuration sources', async () => {
  const doc = await scan(`import * as model from './model'; import { opts } from './model';
    declare function register(value: unknown): void;
    register(model.Holder); const stable = { method: 'GET' }; fetch('/exposed', opts); fetch('/stable', stable);`, [], {
    'src/model.ts': "export const opts = { method: 'GET' }; export class Holder { reveal() { return opts; } }",
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('class receiver projections account for preceding array spreads before indexing stores', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const stored = { method: 'GET' }; class Holder { cfg = { method: 'GET' }; }
    const instance = new Holder(); const list = [...[null, null], instance];
    list[2].cfg = stored; register(instance);
    const stable = { method: 'GET' }; fetch('/stored', stored); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('class constructor candidate arrays account for preceding spread positions', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const opts = { method: 'GET' }; class Holder { reveal() { return opts; } }
    const constructors: any[] = [...[null, null], Holder]; register(new constructors[2]());
    const stable = { method: 'GET' }; fetch('/exposed', opts); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('actual namespace class identities compose with static constructor projections', async () => {
  const doc = await scan(`import * as model from './model'; declare function register(value: unknown): void;
    register(new model.Outer.Nested()); const stable = { method: 'GET' }; fetch('/stable', stable);`, [], {
    'src/model.ts': `const opts = { method: 'GET' }; class Inner { reveal() { return opts; } }
      export class Outer { static Nested = Inner; } fetch('/exposed', opts);`,
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    ['/stable', 'GET', undefined], [null, undefined, true],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('dynamic mutation keys and object method captures expose their actual configuration sources', async () => {
  const doc = await scan(`declare const key: string; declare function register(value: unknown): void;
    const initial = { method: 'GET' }; const holder = { cfg: initial }; holder[key].method = 'POST';
    const stored = { method: 'GET' }; const box = {}; box[key] = stored; box[key].method = 'POST';
    const captured = { method: 'GET' }; register({ get() { return captured; } });
    const getter = { method: 'GET' }; register({ get cfg() { return getter; } });
    const stable = { method: 'GET' };
    fetch('/initial', initial); fetch('/stored', stored); fetch('/captured', captured);
    fetch('/getter', getter); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('local class this writes preserve primitive precision and invalidate exact field sources', async () => {
  const doc = await scan(`const field = { method: 'GET' }, stored = { method: 'GET' };
    const parameter = { method: 'GET' }, direct = { method: 'GET' };
    class Counter { value = 0; constructor() { this.value = 1; } bump() { this.value++; } }
    class FieldHolder { cfg = field; set() { this.cfg.method = 'POST'; } }
    class StoredHolder { cfg: typeof stored; constructor(value = stored) { this.cfg = value; } set() { this.cfg.method = 'POST'; } }
    class ParameterHolder { constructor(public cfg = parameter) {} set = () => { this.cfg.method = 'POST'; }; }
    class DirectHolder { cfg = direct; }
    new Counter().bump(); new FieldHolder().set(); new StoredHolder().set(); new ParameterHolder().set();
    new DirectHolder().cfg.method = 'POST';
    fetch('/field', field); fetch('/stored', stored); fetch('/parameter', parameter);
    fetch('/direct', direct); fetch('/stable', { method: 'POST' });`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], ['/stable', 'POST', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('class member stores through patterns and this aliases expose their nonprimitive sources', async () => {
  const doc = await scan(`const arrayValue = { method: 'GET' }, aliasValue = { method: 'GET' };
    const orderedValue = { method: 'GET' }, nestedValue = { method: 'GET' };
    function install() { ordered.cfg = orderedValue; }
    class Holder {
      cfg!: typeof arrayValue; other!: typeof aliasValue;
      constructor() {
        [this.cfg] = [arrayValue]; const self = this; self.other = aliasValue;
        let nested: this; [nested] = [this]; const box = { nested }; box.nested.other = nestedValue;
      }
      touch() { this.cfg.method = 'POST'; this.other.method = 'POST'; }
    }
    class Ordered { cfg!: typeof orderedValue; touch() { this.cfg.method = 'POST'; } }
    const ordered = new Ordered(); install(); ordered.touch(); new Holder().touch();
    const stable = { method: 'GET' };
    fetch('/array', arrayValue); fetch('/alias', aliasValue); fetch('/ordered', orderedValue);
    fetch('/nested', nestedValue); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('borrowed dynamic this remains observable incomplete', async () => {
  const doc = await scan(`function borrowed(this: { cfg: { method: string } }) { this.cfg.method = 'POST'; }
    const stable = { method: 'GET' }; borrowed.call({ cfg: stable }); fetch('/stable', stable);`);
  assert.equal(doc.facts[0]?.methodDynamic, true);
  assert.ok(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')));
});

test('escaped project class instances expose accessor method constructor and inherited sources', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const getter = { method: 'GET' }, method = { method: 'GET' };
    const replacement = { method: 'GET' }, inherited = { method: 'GET' };
    class Getter { get cfg() { return getter; } }
    class Method { reveal() { return method; } }
    class Replacement { constructor() { return { cfg: replacement } as unknown as Replacement; } }
    class Base { cfg = inherited; } class Derived extends Base {}
    register(new Getter()); register(new Method()); register(new Replacement()); register(new Derived());
    const stable = { method: 'GET' };
    fetch('/getter', getter); fetch('/method', method); fetch('/replacement', replacement);
    fetch('/inherited', inherited); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('derived instance stores and borrowed tagged methods expose every local receiver source', async () => {
  const doc = await scan(`const base = { method: 'GET' }, derived = { method: 'GET' };
    const stored = { method: 'GET' }, borrowed = { method: 'GET' };
    class Base { cfg = base; get touch() { this.cfg.method = 'POST'; return 1; } }
    class Derived extends Base { cfg = derived; }
    const instance = new Derived(); instance.cfg = stored; instance.touch;
    class Holder { cfg = base; set() { this.cfg.method = 'POST'; } }
    const receiver = { cfg: borrowed, run: Holder.prototype.set }; receiver.run\`now\`;
    const stable = { method: 'GET' };
    fetch('/base', base); fetch('/derived', derived); fetch('/stored', stored);
    fetch('/borrowed', borrowed); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('mutable conditional classes and external bases keep local sources without global taint', async () => {
  const doc = await scan(`import axios from 'axios'; declare function register(value: unknown): void;
    declare const condition: boolean;
    const mutable = { method: 'GET' }, left = { method: 'GET' }, right = { method: 'GET' };
    let Mutable = class { cfg = mutable; };
    class Left { cfg = left; } class Right { cfg = right; }
    const Choice = condition ? Left : Right;
    class Session extends Error { cache?: { hit: boolean }; start() { this.cache!.hit = true; } }
    register(new Mutable()); register(new Choice()); new Session().start(); Promise.reject(new Error('x'));
    const api = axios.create({ baseURL: 'https://api.example.com/v1' });
    api.get('/items'); fetch('/mutable', mutable); fetch('/left', left); fetch('/right', right);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    ['/v1/items', 'GET', undefined], [null, undefined, true], [null, undefined, true], [null, undefined, true],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('conditional project bases expose every possible inherited return source', async () => {
  const doc = await scan(`declare function register(value: unknown): void; declare const condition: boolean;
    const left = { method: 'GET' }, right = { method: 'GET' };
    class Left { reveal() { return left; } } class Right { reveal() { return right; } }
    class Derived extends (condition ? Left : Right) {}
    register(new Derived()); const stable = { method: 'GET' };
    fetch('/left', left); fetch('/right', right); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('irrelevant large class return expressions do not consume mutation-analysis work', async () => {
  const values = Array.from({ length: 20_001 }, (_, index) => String(index)).join(',');
  const doc = await scan(`import axios from 'axios'; class Large {
      payload = [${values}]; values() { return [${values}]; }
    }
    const api = axios.create({ baseURL: 'https://api.example.com/v1' }); class Service { http = api; }
    api.get('/items');`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method]), [['/v1/items', 'GET']]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('ordinary rebinding does not enter class member provenance or exhaust query work', async () => {
  const assignments = Array.from({ length: 150 }, (_, index) => `state = ${index};`).join('');
  const doc = await scan(`import axios from 'axios'; let state = 0; ${assignments}
    const stored = { method: 'GET' }; class Holder { cfg = stored; }
    let instance: unknown = new Holder(); const unrelated = { method: 'GET' }; instance = unrelated;
    const api = axios.create({ baseURL: 'https://api.example.com/v1' }); api.get('/items'); fetch('/unrelated', unrelated);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method]), [
    ['/v1/items', 'GET'], ['/unrelated', 'GET'],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('parameter and call-result member stores expose RHS while a closed plain store stays precise', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const parameter = { method: 'GET' }, returned = { method: 'GET' }, plain = { method: 'GET' };
    class Holder { cfg?: { method: string }; }
    function install(holder: Holder) { holder.cfg = parameter; }
    function get() { return new Holder(); }
    const holder = new Holder(); install(holder); get().cfg = returned; register(holder); register(get());
    const localBox: { cfg?: typeof plain } = {}; localBox.cfg = plain;
    fetch('/parameter', parameter); fetch('/returned', returned); fetch('/plain', plain);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/plain', 'GET', undefined],
  ]);
});

test('class method returns enter value mode while getter returns remain callable', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const method = { method: 'GET' }, getter = { method: 'GET' };
    class Method { reveal() { return method; } }
    class Getter { get make() { return () => getter; } }
    const { reveal } = new Method(); const { make } = new Getter(); register(reveal()); register(make());
    const stable = { method: 'GET' }; fetch('/method', method); fetch('/getter', getter); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('escaped constructor values expose static field method and assignment sources', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const field = { method: 'GET' }, method = { method: 'GET' }, assigned = { method: 'GET' };
    class Holder { static cfg = field; static reveal() { return method; } }
    (Holder as any).assigned = assigned; register(Holder);
    const stable = { method: 'GET' }; fetch('/field', field); fetch('/method', method);
    fetch('/assigned', assigned); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('actual namespace value mutation and whole escape reach exported configuration values', async () => {
  const doc = await scan(`import * as model from './model'; import { opts } from './model';
    declare function register(value: unknown): void;
    model.opts.method = 'POST'; register(model.opts); register(model);
    const stable = { method: 'GET' }; fetch('/opts', opts); fetch('/stable', stable);`, [], {
    'src/model.ts': "export const opts = { method: 'GET' };",
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('namespace projections preserve anonymous default class declaration identity', async () => {
  const doc = await scan(`import * as model from './model';
    declare function register(value: unknown): void; register(new model.default()); register(model);`, [], {
    'src/model.ts': `const opts = { method: 'GET' };
      export default class { reveal() { return opts; } } fetch('/opts', opts);`,
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [[null, undefined, true]]);
});

test('namespace callable projections preserve anonymous declarations and export assignments', async () => {
  const declaration = await scan(`import * as model from './model'; declare function register(value: unknown): void;
    register(model.default());`, [], {
    'src/model.ts': `const opts = { method: 'GET' }; export default function() { return opts; }
      fetch('/declaration', opts);`,
  });
  assert.deepEqual(declaration.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true],
  ]);
  const assignment = await scan(`import * as model from './model'; declare function register(value: unknown): void;
    register(model.default());`, [], {
    'src/model.ts': `const opts = { method: 'GET' }; export default (() => opts);
      fetch('/assignment', opts);`,
  });
  assert.deepEqual(assignment.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true],
  ]);
});

test('class candidates consume projected static field and getter sources without sibling leakage', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const field = { method: 'GET' }, getter = { method: 'GET' }, sibling = { method: 'GET' };
    class FieldInner { reveal() { return field; } }
    class GetterInner { reveal() { return getter; } }
    class SiblingInner { reveal() { return sibling; } }
    class FieldOuter { static Nested = FieldInner; static Sibling = SiblingInner; }
    class GetterOuter { static get Nested() { return GetterInner; } }
    register(new FieldOuter.Nested()); register(new GetterOuter.Nested());
    fetch('/field', field); fetch('/getter', getter); fetch('/sibling', sibling);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/sibling', 'GET', undefined],
  ]);
});

test('class member stores retain both static and instance receiver candidates', async () => {
  const doc = await scan(`declare const flag: boolean;
    const stored = { method: 'GET' }; class Holder { cfg?: typeof stored; touch() { this.cfg!.method = 'POST'; } }
    let holder: any = flag ? Holder : null; holder = new Holder(); holder.cfg = stored;
    const stable = { method: 'GET' }; fetch('/stored', stored); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('class return materialization reads only overlapping member paths', async () => {
  const statements = Array.from({ length: 20_001 }, (_, index) => `${index};`).join('');
  const doc = await scan(`import axios from 'axios'; const cfg = { method: 'GET' };
    class Holder { cfg = cfg; reveal() { ${statements} return cfg; } touch() { this.cfg.method = 'POST'; } }
    const api = axios.create({ baseURL: 'https://api.example.com/v1' }); api.get('/items');
    fetch('/cfg', cfg);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    ['/v1/items', 'GET', undefined], [null, undefined, true],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('ordinary member stores use indexed paths without quadratic query work', async () => {
  const stores = Array.from({ length: 200 }, (_, index) => `box.k${index} = ${index};`).join('');
  const doc = await scan(`import axios from 'axios'; const box: Record<string, number> = {}; ${stores}
    const api = axios.create({ baseURL: 'https://api.example.com/v1' }); api.get('/items');`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method]), [['/v1/items', 'GET']]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('callable class and namespace constructor projections consume static method returns', async () => {
  const doc = await scan(`import * as model from './model'; import { imported } from './model';
    declare function register(value: unknown): void;
    const local = { method: 'GET' }; class Holder { static reveal() { return local; } }
    const { reveal } = Holder; const { reveal: importedReveal } = model.Holder;
    register(reveal()); register(importedReveal());
    const stable = { method: 'GET' }; fetch('/local', local); fetch('/imported', imported); fetch('/stable', stable);`, [], {
    'src/model.ts': `export const imported = { method: 'GET' };
      export class Holder { static reveal() { return imported; } }`,
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('projected static class candidates include inherited base sources', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const cfg = { method: 'GET' }; class Inner { reveal() { return cfg; } }
    class Base { static Nested = Inner; } class Derived extends Base {}
    register(new Derived.Nested()); const stable = { method: 'GET' };
    fetch('/cfg', cfg); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('namespace BindingElement exports retain canonical runtime value identity', async () => {
  const doc = await scan(`import * as model from './model'; declare function register(value: unknown): void;
    model.shared.method = 'POST'; register(model.shared); register(model);`, [], {
    'src/model.ts': `const cfg = { method: 'GET' }; export const { cfg: shared } = { cfg };
      fetch('/shared', cfg);`,
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [[null, undefined, true]]);
});

test('for-of member targets feed class and unknown receiver stores but for-in keys do not', async () => {
  const doc = await scan(`const stored = { method: 'GET' }, selfStored = { method: 'GET' };
    class Holder { cfg?: { method: string }; }
    function install(holder: Holder) { for (holder.cfg of [stored]) holder.cfg.method = 'POST'; }
    class SelfHolder { cfg?: { method: string }; run() { for (this.cfg of [selfStored]) this.cfg.method = 'POST'; } }
    install(new Holder()); new SelfHolder().run();
    const untouched = { method: 'GET' }; const box: any = { slot: untouched }; for (box.slot in { key: 1 }) {}
    fetch('/stored', stored); fetch('/self', selfStored); fetch('/untouched', untouched);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], ['/untouched', 'GET', undefined],
  ]);
});

test('for-in member targets mutate the receiver without treating RHS values as sources', async () => {
  const doc = await scan(`const opts = { method: 'GET' }; for (opts.method in { DELETE: 1 }) {}
    const untouched = { method: 'GET' }; const box: any = { slot: untouched };
    for (box.slot in { key: 1 }) {} fetch('/opts', opts); fetch('/untouched', untouched);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/untouched', 'GET', undefined],
  ]);
});

test('dynamic-key primitive stores reuse canonical receiver lookup without exhausting bounds', async () => {
  const stores = Array.from({ length: 200 }, (_, index) => `box[key${index}] = ${index};`).join('');
  const keys = Array.from({ length: 200 }, (_, index) => `declare const key${index}: string;`).join('');
  const doc = await scan(`import axios from 'axios'; ${keys} const box: Record<string, number> = {}; ${stores}
    const api = axios.create({ baseURL: 'https://api.example.com/v1' }); api.get('/items');`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method]), [['/v1/items', 'GET']]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('class aliases are resolved after late static stores finish the class graph', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const exposed = { method: 'GET' }; class Inner { reveal() { return exposed; } }
    class Outer { static Nested: typeof Inner; } const Nested = Outer.Nested;
    register(new Nested()); Outer.Nested = Inner;
    const stable = { method: 'GET' }; fetch('/exposed', exposed); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('constructor parameter class aliases are resolved after construction sources are indexed', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const exposed = { method: 'GET' }; class Inner { reveal() { return exposed; } }
    class Factory { constructor(C: typeof Inner) { register(new C()); } } new Factory(Inner);
    const stable = { method: 'GET' }; fetch('/exposed', exposed); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('direct and contained receiver alternatives both retain precise member stores', async () => {
  const doc = await scan(`declare const condition: boolean; declare function register(value: unknown): void;
    const stored = { method: 'GET' }; class Direct {} class Nested { cfg?: typeof stored; }
    const box: any = condition ? new Direct() : { inner: new Nested() };
    box.inner.cfg = stored; register(box.inner);
    const stable = { method: 'GET' }; fetch('/stored', stored); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('unresolved member alternatives keep unknown-store fallback despite unrelated contained classes', async () => {
  const doc = await scan(`declare const condition: boolean;
    const stored = { method: 'GET' }; class Unrelated {}
    declare const external: { cfg?: typeof stored };
    const box: any = condition ? { other: new Unrelated() } : { inner: external };
    box.inner.cfg = stored;
    const stable = { method: 'GET' }; fetch('/stored', stored); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('namespace escapes are evaluated at each identifier location after shorthand containers', async () => {
  const doc = await scan(`import * as model from './model'; import { opts } from './model';
    declare function register(value: unknown): void; register({ model }); register(model);
    const stable = { method: 'GET' }; fetch('/opts', opts); fetch('/stable', stable);`, [], {
    'src/model.ts': "export const opts = { method: 'GET' };",
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('narrowed primitive occurrences do not suppress later object escapes for the same symbol', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const opts: { method: string } | undefined = { method: 'GET' };
    if (!opts) register(opts); register(opts);
    const stable = { method: 'GET' }; fetch('/opts', opts); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('mixed root rebindings and distinct member stores reuse canonical root expansion', async () => {
  const declarations = Array.from({ length: 150 }, (_, index) => `const holder${index}: any = {};`).join('');
  const rebindings = Array.from({ length: 150 }, (_, index) => `box = holder${index};`).join('');
  const stores = Array.from({ length: 150 }, (_, index) => `box.k${index} = ${index};`).join('');
  const doc = await scan(`import axios from 'axios'; ${declarations} let box: any = {};
    ${rebindings} ${stores} const api = axios.create({ baseURL: 'https://api.example.com/v1' }); api.get('/items');`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method]), [['/v1/items', 'GET']]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('closed-root proof memoizes shared fanout and charges explicit edges to the build bound', async () => {
  const fanout = Array.from({ length: 12 }, (_, index) => `p${index}: previous`).join(',');
  const layers = Array.from({ length: 4 }, (_, index) =>
    `const layer${index} = { ${fanout.replaceAll('previous', index === 0 ? 'leaf' : `layer${index - 1}`)} };`).join('');
  const shared = await scan(`const leaf = {}; ${layers} const Root = layer3; new (Root as any)();
    fetch('/stable', { method: 'GET' });`);
  assert.deepEqual(shared.facts.map((fact) => [fact.channel, fact.method]), [['/stable', 'GET']]);
  assert.equal(shared.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);

  const properties = Array.from({ length: 10_001 }, (_, index) => `p${index}: ${index}`).join(',');
  const bounded = await scan(`const Root = { ${properties} }; new (Root as any)();
    fetch('/bounded', { method: 'GET' });`);
  assert.equal(bounded.facts[0]?.methodDynamic, true);
  assert.ok(bounded.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')));
});

test('instance store destinations wait for late static constructor sources to close', async () => {
  const doc = await scan(`declare const condition: boolean;
    const stored = { method: 'GET' }; class Direct { cfg?: typeof stored; }
    class Inner { cfg?: typeof stored; touch() { this.cfg!.method = 'POST'; } }
    class Outer { static Nested: typeof Inner; }
    const holder: any = condition ? new Direct() : new Outer.Nested();
    holder.cfg = stored; Outer.Nested = Inner;
    const stable = { method: 'GET' }; fetch('/stored', stored); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('projected static sources do not materialize unrelated large instance returns', async () => {
  const statements = Array.from({ length: 20_001 }, (_, index) => `${index};`).join('');
  const doc = await scan(`import axios from 'axios'; declare function register(value: unknown): void;
    const cfg = { method: 'GET' }; class Inner { reveal() { return cfg; } }
    class Outer { static Nested = Inner; huge() { ${statements} return cfg; } }
    register(Outer.Nested); const api = axios.create({ baseURL: 'https://api.example.com/v1' });
    api.get('/items'); fetch('/cfg', cfg);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    ['/v1/items', 'GET', undefined], [null, undefined, true],
  ]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('deep inherited static projections fail closed when the class-source depth bound is reached', async () => {
  const chain = Array.from({ length: 18 }, (_, index) => `class B${index + 1} extends B${index} {}`).join('');
  const doc = await scan(`declare function register(value: unknown): void;
    const cfg = { method: 'GET' }; class Inner { reveal() { return cfg; } }
    class B0 { static Nested = Inner; } ${chain} register(new B18.Nested()); fetch('/cfg', cfg);`);
  assert.equal(doc.facts[0]?.methodDynamic, true);
  assert.ok(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')));
});

test('subclass closure is built after static base stores are indexed', async () => {
  const doc = await scan(`const stored = { method: 'GET' };
    class Inner { cfg?: typeof stored; get touch() { this.cfg!.method = 'POST'; return 1; } }
    class Outer { static Nested: typeof Inner; } Outer.Nested = Inner;
    class Derived extends Outer.Nested { cfg = stored; }
    const stable = { method: 'GET' }; fetch('/stored', stored); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('declared type-shaped receivers cannot supply projected class identity', async () => {
  const doc = await scan(`import type * as Model from './model'; declare const fake: typeof Model;
    declare function register(value: unknown): void; register(new fake.Outer.Nested());
    const stable = { method: 'GET' }; fetch('/stable', stable);`, [], {
    'src/model.ts': `export const opts = { method: 'GET' }; export class Inner { reveal() { return opts; } }
      export class Outer { static Nested = Inner; }`,
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method]), [['/stable', 'GET']]);
});

test('project class candidates flow through object properties and destructuring aliases', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const cfg = { method: 'GET' }; class Left { reveal() { return cfg; } }
    const bases = { Left }; class Derived extends bases.Left {}
    const { Left: Alias } = bases; register(new Derived()); register(new bases.Left()); register(new Alias());
    const stable = { method: 'GET' }; fetch('/cfg', cfg); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('unused large class statement bodies do not consume mutation query work', async () => {
  const statements = Array.from({ length: 20_001 }, (_, index) => `${index};`).join('');
  const doc = await scan(`import axios from 'axios'; const hidden = { method: 'GET' };
    class Large { reveal() { ${statements} return hidden; } }
    const api = axios.create({ baseURL: 'https://api.example.com/v1' }); api.get('/items');`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method]), [['/v1/items', 'GET']]);
  assert.equal(doc.limitations.some((limitation) => limitation.includes('configuration mutation analysis is incomplete')), false);
});

test('a callback returning an HTTP call does not mutate the callable client', async () => {
  const doc = await scan(`import axios from 'axios'; declare function register(value: unknown): void;
    const api = axios.create({ baseURL: 'https://api.example.com/v1' });
    register(() => api('/users')); api.get('/items');`);
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel, fact.dynamic]), [
    ['GET', '/v1/users', false], ['GET', '/v1/items', false],
  ]);
});

test('evaluated arrow and function-expression results expose all local return sources', async () => {
  const doc = await scan(`declare function register(value: unknown): void;
    const arrow = { method: 'GET' }, expression = { method: 'GET' }, replacement = { method: 'GET' };
    const destructured = { method: 'GET' }, assigned = { method: 'GET' }, iterated = { method: 'GET' };
    const getter = { method: 'GET' }, classMethod = { method: 'GET' };
    const current = () => arrow; const other = function() { return expression; };
    let changed = () => arrow; changed = () => replacement;
    const factories = { make: () => destructured }; const { make } = factories;
    const getterFactories = { get make() { return () => getter; } }; const { make: getterMake } = getterFactories;
    class ClassFactories { make() { return () => classMethod; } }
    let assignedFactory: () => typeof assigned; [assignedFactory] = [() => assigned];
    register(current()); register(other()); register(changed()); register(make()); register(getterMake());
    register(new ClassFactories().make()); register(assignedFactory());
    for (const iteratedFactory of [() => iterated]) register(iteratedFactory());
    const stable = { method: 'GET' };
    fetch('/arrow', arrow); fetch('/expression', expression); fetch('/replacement', replacement);
    fetch('/destructured', destructured); fetch('/getter', getter); fetch('/class-method', classMethod);
    fetch('/assigned', assigned); fetch('/iterated', iterated); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('shorthand container escapes and nested writes invalidate the actual configuration values', async () => {
  const doc = await scan(`declare function mutate(value: unknown): void;
    const escaped = { method: 'GET' }; const holder = { escaped }; mutate(holder);
    const changed = { method: 'GET' }; const written = { changed }; written.changed.method = 'DELETE';
    const removed = { method: 'GET' }; const deleted = { removed }; delete deleted.removed.method;
    const counted = { method: 'GET' }; const incremented = { counted }; incremented.counted.method++;
    const stable = { method: 'GET' };
    fetch('/escaped', escaped); fetch('/written', changed); fetch('/deleted', removed);
    fetch('/incremented', counted); fetch('/stable', stable);`);
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.method, fact.methodDynamic]), [
    [null, undefined, true], [null, undefined, true], [null, undefined, true],
    [null, undefined, true], ['/stable', 'GET', undefined],
  ]);
});

test('delete and destructuring assignments invalidate configuration; graph accepts all caller ids', async () => {
  const doc = await scan(`const deleted = {method:'POST'}; delete deleted.method;
    const changed = {method:'GET'}; ({method:changed.method} = dynamicOptions);
    fetch('/deleted', deleted); fetch('/changed', changed);
    export function Screen(){ useEffect(() => fetch('/callback'), []); }`, [], {}, true);
  assert.equal(doc.facts[0]?.methodDynamic, true);
  assert.equal(doc.facts[1]?.methodDynamic, true);
});

test('unknown-call escape detection covers Object assign trivia, element access and aliases', async () => {
  const doc = await scan(`const a={method:'GET'},b={method:'GET'},c={method:'GET'};
    Object /* trivia */ .assign(a,{method:'DELETE'}); Object['assign'](b,{method:'DELETE'});
    const O=Object; O.assign(c,{method:'DELETE'}); fetch('/a',a);fetch('/b',b);fetch('/c',c);`);
  assert.ok(doc.facts.every((f) => f.methodDynamic === true));
});

test('cross-file axios factory remains a positive control for project const provenance', async () => {
  const doc = await scan("import { thttp } from './http'; export function load() { thttp.get('/users'); }", [], {
    'src/http.ts': "import axios from 'axios'; export const thttp = axios.create({ baseURL: 'https://api.example.com/v1' });",
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel]), [['GET', '/v1/users']]);
});

test('object forwarding does not borrow a method replaced through indirect this mutation', async () => {
  const doc = await scan(`import axios from 'axios';
    const api = {
      get(url: string) { return axios.get(url); },
      configure(value: string) { return this.replace(value); },
      replace(value: string) { this.get = url => axios.post(url); return value; }
    };
    export function load() { api.configure('now'); api.get('/actual-post'); }`);
  assert.ok(!doc.facts.some(fact => fact.channel === '/actual-post' && fact.method === 'GET' && !fact.dynamic));
  assert.ok(doc.facts.some(fact => fact.dynamic), 'unproved body calls must remain visible');
});

test('pure project forwarders preserve url and options across files and aliases', async () => {
  const doc = await scan(`import { request, load } from './http';
    const options = { method: 'POST' };
    export function run() { request('/users', options); load('/items'); }`, [], {
    'src/http.ts': `import axios from 'axios';
      export function request<T>(url: string, options: T) { return axios(url, options); }
      export const load = (url: string) => axios.get(url);`,
  });
  assert.deepEqual(doc.facts.filter((fact) => fact.channel !== null).map((fact) => [fact.method, fact.channel]),
    [['POST', '/users'], ['GET', '/items']]);
  assert.deepEqual(doc.facts.filter((fact) => fact.channel === null).map((fact) =>
    [fact.method, fact.methodDynamic, fact.symbol?.usr]), [
    [undefined, true, 'src/http.ts#request'], ['GET', undefined, 'src/http.ts#load'],
  ]);
});

test('pure object methods forward while class methods retain a conservative body fallback', async () => {
  const doc = await scan(`import axios from 'axios';
    const objectApi = { get(url: string) { return axios.get(url); } };
    class Api { get(url: string) { return axios.get(url); } }
    const classApi = new Api();
    export function load() { objectApi.get('/object'); classApi.get('/class'); }`);
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel]), [['GET', null], ['GET', '/object']]);
  assert.equal(doc.facts[0]?.dynamic, true);
});

test('closed object forwards every called pure member and admits inert metadata', async () => {
  const doc = await scan(`import axios from 'axios';
    const api = {
      name: 'api', version: 1, active: true, optional: null,
      get(url: string) { return axios.get(url); },
      post(url: string) { return axios.post(url); }
    };
    export function load() { api.get('/a'); api.post('/b'); }`);
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel, fact.dynamic]), [
    ['GET', '/a', false], ['POST', '/b', false],
  ]);
});

test('wrapper body suppression requires every invocation to be represented', async () => {
  const doc = await scan(`import axios from 'axios';
    function request(url: string) { return axios.get(url); }
    const open: (...args: unknown[]) => unknown = request;
    export function load(dynamicUrl: string) { request('/known'); open(dynamicUrl, 'extra'); }`);
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel, fact.dynamic]), [
    ['GET', null, true], ['GET', '/known', false],
  ]);
  assert.equal(doc.facts[0]?.symbol?.usr, 'src/client.ts#request');
  assert.equal(doc.facts[1]?.symbol?.usr, 'src/client.ts#load');
});

test('exported imported and escaped arrow wrappers retain unknown-entry fallback', async () => {
  const doc = await scan(`import { imported } from './http'; import * as http from './http'; import axios from 'axios';
    declare function register(value: unknown): void;
    export function exported(url: string) { return axios.get(url); }
    const arrow = (url: string) => axios.get(url);
    register(imported); register(arrow);
    export function load() { imported('/imported'); http.imported('/namespace'); exported('/exported'); arrow('/arrow'); }`, [], {
    'src/http.ts': "import axios from 'axios'; export function imported(url: string) { return axios.get(url); }",
  });
  assert.deepEqual(doc.facts.filter((fact) => fact.channel !== null).map((fact) => [fact.method, fact.channel]), [
    ['GET', '/imported'], ['GET', '/namespace'], ['GET', '/exported'], ['GET', '/arrow'],
  ]);
  assert.deepEqual(doc.facts.filter((fact) => fact.channel === null).map((fact) => fact.symbol?.usr).sort(), [
    'src/client.ts#arrow', 'src/client.ts#exported', 'src/http.ts#imported',
  ]);
});

test('anonymous default export keeps external fallback for default and namespace calls', async () => {
  const doc = await scan(`import request from './http'; import * as http from './http';
    export function load() { request('/default'); http.default('/namespace'); }`, [], {
    'src/http.ts': "import axios from 'axios'; export default function(url: string) { return axios.get(url); }",
  });
  assert.deepEqual(doc.facts.filter((fact) => fact.channel !== null).map((fact) => [fact.method, fact.channel]), [
    ['GET', '/default'], ['GET', '/namespace'],
  ]);
  assert.deepEqual(doc.facts.filter((fact) => fact.channel === null).map((fact) =>
    [fact.method, fact.dynamic]), [['GET', true]]);
});

test('async anonymous default export keeps external fallback for both import forms', async () => {
  const doc = await scan(`import request from './http'; import * as http from './http';
    export function load() { request('/async-default'); http.default('/async-namespace'); }`, [], {
    'src/http.ts': "import axios from 'axios'; export default async function(url: string) { return await axios.get(url); }",
  });
  assert.deepEqual(doc.facts.filter((fact) => fact.channel !== null).map((fact) => [fact.method, fact.channel]), [
    ['GET', '/async-default'], ['GET', '/async-namespace'],
  ]);
  assert.deepEqual(doc.facts.filter((fact) => fact.channel === null).map((fact) =>
    [fact.method, fact.dynamic]), [['GET', true]]);
});

test('shorthand export records the callable value escape and preserves its body fallback', async () => {
  const doc = await scan(`import handlers from './http';
    export function load(dynamicUrl: string) { handlers.request(dynamicUrl); }`, [], {
    'src/http.ts': `import axios from 'axios';
      function request(url: string) { return axios.get(url); }
      export default { request };
      request('/known');`,
  });
  assert.deepEqual(doc.facts.filter((fact) => fact.channel !== null).map((fact) => [fact.method, fact.channel]), [
    ['GET', '/known'],
  ]);
  assert.deepEqual(doc.facts.filter((fact) => fact.channel === null).map((fact) =>
    [fact.method, fact.dynamic, fact.symbol?.usr]), [['GET', true, 'src/http.ts#request']]);
});

test('shorthand holder escape prevents false facts after nested receiver replacement', async () => {
  const doc = await scan(`import axios from 'axios';
    const api = { get(url: string) { return axios.get(url); } };
    const holder = { api };
    holder.api.get = (url: string) => axios.post(url);
    api.get('/runtime-post');`);
  assert.equal(doc.facts.some((fact) => fact.method === 'GET' && fact.channel === '/runtime-post'), false);
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel, fact.dynamic]), [
    ['GET', null, true], ['POST', null, true],
  ]);
});

test('module function forwarding requires an actual namespace value receiver', async () => {
  const doc = await scan(`import * as http from './http'; import type * as Http from './http';
    const namespaceAlias = http;
    declare const declaredApi: typeof Http;
    function use(parameterApi: typeof Http) {
      declaredApi.request('/declared-only'); parameterApi.request('/parameter-only');
    }
    http.request('/namespace'); namespaceAlias.request('/namespace-alias'); use(declaredApi);`, [], {
    'src/http.ts': "import axios from 'axios'; export function request(url: string) { return axios.get(url); }",
  });
  assert.deepEqual(doc.facts.filter((fact) => fact.channel !== null).map((fact) => [fact.method, fact.channel]), [
    ['GET', '/namespace'], ['GET', '/namespace-alias'],
  ]);
  assert.equal(doc.facts.some((fact) => ['/declared-only', '/parameter-only'].includes(fact.channel ?? '')), false);
  assert.deepEqual(doc.facts.filter((fact) => fact.channel === null).map((fact) =>
    [fact.method, fact.dynamic, fact.symbol?.usr]), [['GET', true, 'src/http.ts#request']]);
});

test('effectful wrapper callee remains unsuppressed so nested request facts survive', async () => {
  const doc = await scan(`import axios from 'axios';
    function request(url: string) {
      return axios.create({ headers: { x: fetch('/ping') } }).get(url);
    }
    export function load() { request('/outer'); }`);
  assert.equal(doc.facts.some((fact) => fact.channel === '/outer'), false);
  assert.ok(doc.facts.some((fact) => fact.method === 'GET' && fact.channel === '/ping' && !fact.dynamic));
  assert.ok(doc.facts.some((fact) => fact.method === 'GET' && fact.channel === null && fact.dynamic
    && fact.symbol?.usr === 'src/client.ts#request'));
});

test('escaped or exported object-method receivers do not mint outer facts', async () => {
  const doc = await scan(`import axios from 'axios'; declare function register(value: unknown): void;
    const escaped = { get(url: string) { return axios.get(url); } };
    export const exported = { get(url: string) { return axios.get(url); } };
    const reconfigured = {
      get(url: string) { return axios.get(url); },
      configure() { this.get = (url: string) => axios.post(url); }
    };
    const unknownMember = { get(url: string) { return axios.get(url); } };
    register(escaped);
    reconfigured.configure(); (unknownMember as any).missing();
    export function load() {
      escaped.get('/escaped-object'); exported.get('/exported-object'); reconfigured.get('/reconfigured-object');
      unknownMember.get('/unknown-member-object');
    }`);
  assert.equal(doc.facts.some((fact) =>
    ['/escaped-object', '/exported-object', '/reconfigured-object', '/unknown-member-object'].includes(fact.channel ?? '')), false);
  assert.equal(doc.facts.filter((fact) => fact.method === 'GET' && fact.channel === null && fact.dynamic).length, 4);
  assert.ok(doc.facts.some((fact) => fact.method === 'POST' && fact.channel === null && fact.dynamic));
});

test('class method forwarding rejects prototype replacement receiver escape and parameter decorators', async () => {
  const doc = await scan(`import axios from 'axios';
    declare function mutate(value: unknown): void;
    function parameterDecorator(...args: unknown[]) {}
    class Replaced { get(url: string) { return axios.get(url); } }
    class Escaped { get(url: string) { return axios.get(url); } }
    class Decorated { get(@parameterDecorator url: string) { return axios.get(url); } }
    const replaced = new Replaced(); const escaped = new Escaped(); const decorated = new Decorated();
    Replaced.prototype.get = (url: string) => axios.post(url); mutate(escaped);
    export function load() { replaced.get('/actual-post'); escaped.get('/escaped'); decorated.get('/decorated'); }`);
  for (const channel of ['/actual-post', '/escaped', '/decorated']) {
    assert.equal(doc.facts.some((fact) => fact.method === 'GET' && fact.channel === channel), false, channel);
  }
  assert.ok(doc.facts.some((fact) => fact.method === 'POST' && fact.channel === null));
  for (const symbol of ['src/client.ts#Replaced.get', 'src/client.ts#Escaped.get', 'src/client.ts#Decorated.get']) {
    assert.ok(doc.facts.some((fact) => fact.symbol?.usr === symbol
      && fact.method === 'GET' && fact.channel === null && fact.dynamic), symbol);
  }
});

test('non-pure or escaped project wrappers remain unknown', async () => {
  const doc = await scan(`import axios from 'axios';
    const api = axios.create({ baseURL: 'https://api.example.com' });
    function escaped(url: string) { return api.get(url); }
    const alias = escaped;
    api.defaults.baseURL = 'https://other.example.com';
    function extra(url: string) { const copy = url; return axios.get(copy); }
    function rewritten(url: string) { return axios.get(url).then((response) => response); }
    function coerced(url: string) { return axios.get(String(url)); }
    function optional(url?: string) { return axios.get(url ?? '/fallback'); }
    function overloaded(url: string): unknown;
    function overloaded(url: string) { return axios.get(url); }
    const objectApi = { ["get"](url: string) { return axios.get(url); } };
    class MutableApi { get(url: string) { return axios.get(url); } }
    let mutableApi = new MutableApi(); mutableApi = new MutableApi();
    export function load() {
      alias('/escaped'); escaped('/mutated'); extra('/extra'); rewritten('/rewritten');
      coerced('/coerced'); optional('/optional'); overloaded('/overloaded'); objectApi['get']('/computed'); mutableApi.get('/mutated-class');
  }`);
  const outer = doc.facts.filter((fact) => fact.symbol?.usr === 'src/client.ts#load');
  assert.deepEqual(outer.map((fact) => [fact.method, fact.channel, fact.dynamic]), [
    ['GET', null, true], ['GET', null, true],
  ]);
  assert.ok(doc.facts.some((fact) => fact.symbol?.usr === 'src/client.ts#extra'
    && fact.method === 'GET' && fact.dynamic && fact.channel === null));
  assert.ok(doc.limitations.some((limitation) => limitation.startsWith('route-call-coverage:')));
});

test('forwarding preserves global fetch and two-hop argument bindings', async () => {
  const doc = await scan(`
    function low(url: string, options: RequestInit) { return fetch(url, options); }
    function high(url: string, options: RequestInit) { return low(url, options); }
    export function load() { high('/fetch-forward', { method: 'POST' }); }
  `);
  assert.deepEqual(doc.facts.map((fact) => [fact.method, fact.channel]), [['POST', '/fetch-forward']]);
});

test('mutable or escaped function aliases do not retain wrapper provenance', async () => {
  const doc = await scan(`import axios from 'axios';
    let mutableAlias = (url: string) => axios.get(url); mutableAlias = (url: string) => axios.post(url);
    function escape(url: string) { return axios.get(url); }
    const exported = escape;
    export function load() {
      mutableAlias('/alias-replaced'); exported('/escaped');
    }`);
  assert.ok(!doc.facts.some((fact) => fact.channel === '/alias-replaced' && fact.method === 'GET'));
});

test('an immutable local function alias remains a proven wrapper', async () => {
  const doc = await scan(`import axios from 'axios';
    const stable = (url: string) => axios.get(url);
    const immutableAlias = stable;
    export function load() { immutableAlias('/alias-ok'); }
  `);
  assert.ok(doc.facts.some((fact) => fact.channel === '/alias-ok' && fact.method === 'GET'));
});

test('duplicate object methods and unsafe class shapes remain unresolved', async () => {
  const doc = await scan(`import axios from 'axios';
    const duplicate = { get(url: string) { return axios.get(url); }, get(url: string) { return axios.post(url); } };
    class Replaced { get(url: string) { return axios.get(url); } }
    const replaced = new Replaced(); replaced.get = (url: string) => axios.post(url);
    class StaticGet { static get(url: string) { return axios.get(url); } }
    class Derived extends Replaced { get(url: string) { return axios.get(url); } }
    @decorator class Decorated { get(url: string) { return axios.get(url); } }
    const derived = new Derived(); const decorated = new Decorated();
    export function load() {
      duplicate.get('/duplicate'); replaced.get('/replaced'); StaticGet.get('/static');
      derived.get('/derived'); decorated.get('/decorated');
    }`);
  assert.ok(!doc.facts.some((fact) => ['/duplicate', '/replaced', '/static', '/derived', '/decorated'].includes(fact.channel ?? '')));
  assert.ok(doc.limitations.some((limitation) => limitation.startsWith('route-call-coverage:')));
});

test('async generators and forwarding cycles stay conservative', async () => {
  const doc = await scan(`import axios from 'axios';
    async function asyncForward(url: string) { return axios.get(url); }
    async function asyncAwait(url: string) { return await axios.get(url); }
    function* generated(url: string) { yield axios.get(url); }
    function cycleA(url: string) { return cycleB(url); }
    function cycleB(url: string) { return cycleA(url); }
    export function load() { asyncForward('/async'); asyncAwait('/awaited'); generated('/generated'); cycleA('/cycle'); }
  `);
  assert.deepEqual(doc.facts.filter((fact) => fact.channel !== null).map((fact) => [fact.method, fact.channel]), [
    ['GET', '/async'], ['GET', '/awaited'],
  ]);
  assert.ok(!doc.facts.some((fact) => ['/generated', '/cycle'].includes(fact.channel ?? '')));
  assert.ok(doc.limitations.some((limitation) => limitation.includes('wrapper alias or forwarding analysis exceeded')));
});

test('wrapper alias depth is bounded without throwing and reports incomplete coverage', async () => {
  const aliases = Array.from({ length: 800 }, (_, index) =>
    `const alias${index} = ${index === 0 ? 'request' : `alias${index - 1}`};`).join('\n');
  const doc = await scan(`import axios from 'axios';
    function request(url: string) { return axios.get(url); }
    ${aliases}
    request('/known'); alias799('/too-deep');`);
  assert.ok(doc.facts.some((fact) => fact.method === 'GET' && fact.channel === '/known'));
  assert.equal(doc.facts.some((fact) => fact.channel === '/too-deep'), false);
  assert.ok(doc.facts.some((fact) => fact.method === 'GET' && fact.channel === null && fact.dynamic));
  assert.ok(doc.limitations.some((limitation) => limitation.includes('wrapper alias or forwarding analysis exceeded')));
});

test('large ordinary local-call structure remains non-HTTP without wrapper facts', async () => {
  const declarations = Array.from({ length: 800 }, (_, index) =>
    `function local${index}(value: string) { return value; }`).join('\n');
  const calls = Array.from({ length: 800 }, (_, index) => `local${index}('/value');`).join('\n');
  const doc = await scan(`${declarations}\n${calls}`);
  assert.deepEqual(doc.facts, []);
});

test('large wrapper summary set emits one outer fact per represented call', async () => {
  const declarations = Array.from({ length: 800 }, (_, index) =>
    `function request${index}(url: string) { return axios.get(url); }`).join('\n');
  const calls = Array.from({ length: 800 }, (_, index) => `request${index}('/route-${index}');`).join('\n');
  const doc = await scan(`import axios from 'axios';\n${declarations}\n${calls}`);
  assert.equal(doc.facts.length, 800);
  assert.deepEqual([doc.facts[0]?.method, doc.facts[0]?.channel], ['GET', '/route-0']);
  assert.deepEqual([doc.facts.at(-1)?.method, doc.facts.at(-1)?.channel], ['GET', '/route-799']);
  assert.equal(doc.facts.some((fact) => fact.channel === null), false);
});

/** 건너뛴 프로젝트 소스가 있을 때 호출 문서가 싣는 limitation이다. */
const skippedProjectSources = 'route-call-coverage: unreadable, symlinked, oversized or capped project sources were skipped';

test('sources whose names contain forbidden characters are skipped without exposing their paths', {
  skip: process.platform === 'win32',
}, async () => {
  const doc = await scan('export const load = () => fetch("/ok");', [], {
    'tsconfig.json': ambientTypesFreeConfig,
    'src/h\u007fidden.ts': 'export const hidden = () => fetch("/hidden");',
    'src/dir\u{2028}x/nested.ts': 'export const nested = () => fetch("/nested");',
  });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.location.path, fact.symbol?.usr]), [['/ok', 'src/client.ts', 'src/client.ts#load']]);
  assert.ok(doc.limitations.includes(skippedProjectSources));
});

test('sources the compiler cannot read are reported as skipped project sources', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-client-unreadable-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"dependencies":{"axios":"1.20.0"}}');
    writeFileSync(join(root, 'tsconfig.json'), ambientTypesFreeConfig);
    writeFileSync(join(root, 'src/client.ts'), 'export const load = () => fetch("/ok");');
    writeFileSync(join(root, 'src/locked.ts'), 'export const hidden = () => fetch("/hidden");');
    chmodSync(join(root, 'src/locked.ts'), 0o000);
    const result = await runRoutesCommand(['--role', 'client', '--project', root], {
      fileSystem: createNodeFileSystem(), toolVersion: '0.0.0-test', now: () => new Date('2026-10-01T00:00:00Z'),
    });
    assert.equal(result.exitCode, 0, result.standardError);
    const document = JSON.parse(result.standardOutput) as { facts: Fact[]; limitations: string[] };
    assert.deepEqual(document.facts.map((fact) => fact.channel), ['/ok']);
    assert.ok(document.limitations.includes(skippedProjectSources));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unparsed tsconfig is reported with the graph cause wording', async () => {
  const doc = await scan('export const load = () => fetch("/ok");', [], {
    'tsconfig.json': JSON.stringify({ extends: '@tsconfig/node20/tsconfig.json', compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] } } }),
  });
  assert.deepEqual(doc.facts.map((fact) => fact.channel), ['/ok']);
  assert.ok(doc.limitations.includes('route-call-coverage: tsconfig.json could not be parsed; default compiler options were used, so path aliases may not resolve'));
});

/** 상수 사슬 선언 줄이다. `<name>0`은 `base`이고, 단계마다 바로 앞 상수를 `spans`번 보간한다. */
function constantChain(name: string, levels: number, spans: number, base: string): string[] {
  const lines = [`const ${name}0 = '${base}';`];
  for (let level = 1; level <= levels; level++) lines.push(`const ${name}${level} = \`${`\${${name}${level - 1}}`.repeat(spans)}\`;`);
  return lines;
}

test('URL constant chains, query-suffix fanout and oversized literal joins stop at fixed bounds as unknown request paths', async () => {
  // 예전에는 c8을 3^8 조각까지 펼치고, q14의 query 꼬리 판정을 2^14번 되풀이하고, 40 KB 리터럴 둘을 이어 붙였다.
  // 펼치다 만 조각을 한 세그먼트 보간으로 남기면 좁은 정적 경로를 주장하므로 URL 전체를 모르는 값으로 낸다.
  const big = 'a'.repeat(40_000);
  const doc = await scan([
    'declare const flag: boolean;',
    ...constantChain('c', 8, 3, '/a'),
    "const q0 = '?a';",
    ...Array.from({ length: 14 }, (_, index) => `const q${index + 1} = flag ? q${index} : q${index};`),
    `const big = '/${big}';`,
    'export const chain = () => fetch(c8);',
    'export const query = () => fetch(`/search${q14}`);',
    'export const long = () => fetch(`${big}${big}`);',
    "export const ok = () => fetch('/ok');",
  ].join('\n'), [], { 'tsconfig.json': ambientTypesFreeConfig });
  assert.deepEqual(doc.facts.map((fact) => [fact.channel, fact.pathAnchor, fact.dynamic]), [[null, 'base', true], [null, 'base', true], [null, 'base', true], ['/ok', 'root', false]]);
  assert.ok(doc.limitations.some((text) => text.startsWith('unresolved-route-prefix:')));
});

test('a 14-level URL constant chain ends within the per-URL work budget instead of expanding 3^14 parts', async () => {
  // 예전에는 조각 478만 개를 만들어 16초·RSS 2 GB를 썼다. 회귀가 이 검사만 실패하도록 감시하는 자식 프로세스로 돌린다.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-client-chain-')));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'package.json'), '{"dependencies":{}}');
    writeFileSync(join(root, 'src/client.ts'), [...constantChain('c', 14, 3, '/a'), 'export const chain = () => fetch(c14);', "export const ok = () => fetch('/ok');"].join('\n'));
    const result = await runMainGuarded(['routes', '--role', 'client', '--project', root]);
    assert.equal(result.stopped, undefined);
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout) as { facts: Fact[] };
    assert.deepEqual(document.facts.map((fact) => [fact.channel, fact.pathAnchor, fact.dynamic]), [[null, 'base', true], ['/ok', 'root', false]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
