/** 웹·RN 호출부 추출의 외부 계약을 합성 프로젝트로 검증한다. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../../cli/file-system.ts';
import { runRoutesCommand } from '../../cli/routes-command.ts';
import { buildCallGraph } from '../../graph/build-graph.ts';

/** 문서 경계에서 관찰할 사실이다. */
interface Fact {
  kind: string; channel: string | null; method?: string; methodDynamic?: true;
  dynamic: boolean; pathAnchor: string; authority?: string; queryTailStripped?: true;
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
