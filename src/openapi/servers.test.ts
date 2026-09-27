import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  canonicalizeLiteralPath,
  DEFAULT_SERVER_PREFIXES,
  MAX_SERVER_COMBINATIONS,
  mergeServerPrefixes,
  resolveBasePath,
  resolveServerUrl,
  type ServerVariable,
  UNRESOLVED_SERVER_PREFIXES,
} from './servers.ts';

/** 변수 선언 사상을 만든다. */
function variables(entries: Record<string, ServerVariable>): Map<string, ServerVariable> {
  return new Map(Object.entries(entries));
}

/** 변수 없는 URL을 해석한다. */
function resolvePlain(url: string) {
  return resolveServerUrl(url, new Map());
}

test('절대 URL은 host를 버리고 경로를 root 접두사로 쓴다', () => {
  assert.deepEqual(resolvePlain('https://api.example.test/api/v1'), { roots: ['/api/v1'], baseTails: [] });
  assert.deepEqual(resolvePlain('https://api.example.test:8443'), { roots: [''], baseTails: [] });
  assert.deepEqual(resolvePlain('//cdn.example.test/v1/'), { roots: ['/v1'], baseTails: [] });
  assert.deepEqual(resolvePlain('/v1'), { roots: ['/v1'], baseTails: [] });
  assert.deepEqual(resolvePlain('/'), { roots: [''], baseTails: [] });
});

test('서버 경로의 query·fragment를 떼고 리터럴을 정규화한다', () => {
  assert.deepEqual(resolvePlain('https://h.test/a%7e/b c?x=1#f'), { roots: ['/a~/b%20c'], baseTails: [] });
});

test('문서 기준 상대 URL은 앞부분을 알 수 없어 base 꼬리다', () => {
  assert.deepEqual(resolvePlain('v1'), { roots: [], baseTails: ['/v1'] });
  assert.deepEqual(resolvePlain('./v1/'), { roots: [], baseTails: ['/v1'] });
  assert.deepEqual(resolvePlain('../x/v2'), { roots: [], baseTails: ['/x/v2'] });
  assert.deepEqual(resolvePlain(''), { roots: [], baseTails: [''] });
  assert.deepEqual(resolvePlain('.'), { roots: [], baseTails: [''] });
});

test('계층 없는 scheme과 짝 없는 중괄호·서러게이트는 미확정이다', () => {
  assert.deepEqual(resolvePlain('urn:example:api'), UNRESOLVED_SERVER_PREFIXES);
  assert.deepEqual(resolvePlain('https://h.test/{v'), UNRESOLVED_SERVER_PREFIXES);
  assert.deepEqual(resolvePlain('https://h.test/v}'), UNRESOLVED_SERVER_PREFIXES);
  assert.deepEqual(resolvePlain('https://h.test/\uD800'), UNRESOLVED_SERVER_PREFIXES);
});

test('host·scheme·port의 열린 변수는 경로에 영향이 없어 root다', () => {
  const declared = variables({
    scheme: { values: undefined, defaultValue: 'https' },
    region: { values: undefined, defaultValue: 'eu' },
    port: { values: undefined, defaultValue: undefined },
  });
  assert.deepEqual(resolveServerUrl('{scheme}://{region}.h.test:{port}/api', declared), { roots: ['/api'], baseTails: [] });
});

test('경로의 enum 변수는 값마다 펼친다', () => {
  const declared = variables({ version: { values: ['v1', 'v2', 'v1'], defaultValue: 'v1' } });
  assert.deepEqual(resolveServerUrl('https://h.test/{version}/api', declared), { roots: ['/v1/api', '/v2/api'], baseTails: [] });
});

test('경로의 열린 변수는 확정하지 않고 뒤쪽 리터럴만 base 꼬리로 남긴다', () => {
  const declared = variables({ tenant: { values: undefined, defaultValue: 'acme' } });
  assert.deepEqual(resolveServerUrl('https://h.test/tenants/{tenant}/api', declared), { roots: [], baseTails: ['/api'] });
  assert.deepEqual(resolveServerUrl('https://h.test/v{tenant}', declared), { roots: [], baseTails: [''] });
  assert.deepEqual(resolveServerUrl('/api/{tenant}', declared), { roots: [], baseTails: [''] });
  assert.deepEqual(resolveServerUrl('https://h.test{undeclared}', declared), { roots: [], baseTails: [''] });
  assert.deepEqual(resolveServerUrl('https://h.test/{empty}', declared), { roots: [], baseTails: [''] });
});

test('값에 /가 있는 열린 변수가 authority 자리에 있으면 경로 시작을 확정하지 않는다', () => {
  const declared = variables({ server: { values: undefined, defaultValue: 'https://h.test/base' } });
  assert.deepEqual(resolveServerUrl('{server}/v1', declared), { roots: [], baseTails: ['/v1'] });
  const hostWithPath = variables({ host: { values: undefined, defaultValue: 'h.test/x' } });
  assert.deepEqual(resolveServerUrl('https://{host}/v1', hostWithPath), { roots: [], baseTails: ['/v1'] });
});

test('열린 변수가 문서 기준 상대 URL에 있으면 그 뒤만 남긴다', () => {
  const declared = variables({ stage: { values: undefined, defaultValue: 'prod' } });
  assert.deepEqual(resolveServerUrl('{stage}/v1', declared), { roots: [], baseTails: ['/v1'] });
});

test('query 뒤의 변수는 경로에 영향이 없다', () => {
  const declared = variables({ token: { values: undefined, defaultValue: 'x' } });
  assert.deepEqual(resolveServerUrl('https://h.test/api?t={token}', declared), { roots: ['/api'], baseTails: [] });
});

test('enum 조합이 상한을 넘으면 미확정이다', () => {
  const many = Array.from({ length: MAX_SERVER_COMBINATIONS + 1 }, (_, index) => `v${index}`);
  const declared = variables({ version: { values: many, defaultValue: 'v0' } });
  assert.deepEqual(resolveServerUrl('https://h.test/{version}', declared), UNRESOLVED_SERVER_PREFIXES);
});

test('basePath는 /로 시작하는 리터럴만 root로 받는다', () => {
  assert.deepEqual(resolveBasePath(undefined, false), DEFAULT_SERVER_PREFIXES);
  assert.deepEqual(resolveBasePath('/v2/', true), { roots: ['/v2'], baseTails: [] });
  assert.deepEqual(resolveBasePath('/', true), { roots: [''], baseTails: [] });
  for (const invalid of ['v2', '/v{n}', '/v2?x', '/\uD800']) {
    assert.deepEqual(resolveBasePath(invalid, true), UNRESOLVED_SERVER_PREFIXES, invalid);
  }
  assert.deepEqual(resolveBasePath(undefined, true), UNRESOLVED_SERVER_PREFIXES);
});

test('접두사 합치기는 정렬·중복 제거하고 리터럴 경로는 끝 슬래시 하나만 뗀다', () => {
  assert.deepEqual(
    mergeServerPrefixes([{ roots: ['/b', '/a'], baseTails: [] }, { roots: ['/a'], baseTails: [''] }]),
    { roots: ['/a', '/b'], baseTails: [''] },
  );
  assert.equal(canonicalizeLiteralPath('/v1//'), '/v1/');
  assert.equal(canonicalizeLiteralPath(''), '');
});
