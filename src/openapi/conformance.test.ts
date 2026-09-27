/**
 * isthmus 공유 적합성 벡터(`conformance/http-template.json`)로 템플릿 정규화기를 검증한다.
 *
 * 벡터는 isthmus가 소유하며 아직 개발 중이다(스키마 미확정). 이 테스트는 벡터가 있으면
 * 두 가지를 확인하고, 없으면 이유를 밝히고 건너뛴다.
 * 1. 생산자 사례(`appliesTo`에 openapi): 원문 경로를 정규화한 결과가 기대와 같다.
 * 2. 문법 사례(`expect.ok`): 정규 템플릿은 이 정규화기의 고정점이고, 거부 템플릿은
 *    이 정규화기가 그대로 내지 않는다.
 * 벡터 위치: `TSOGRAPH_CONFORMANCE_DIR`, 저장소의 `conformance/`(향후 conformance.lock
 * 벤더링), 형제 checkout `../isthmus/conformance/` 순서로 찾는다.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalizePathTemplate } from './path-template.ts';

/** 저장소 루트다. */
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** 벡터 사례에서 읽어 낸 검사 하나다. */
type VectorCheck =
  | { readonly kind: 'producer'; readonly id: string; readonly input: string; readonly expected: ExpectedTemplate }
  | { readonly kind: 'grammar'; readonly id: string; readonly template: string; readonly isCanonical: boolean };

/** 생산자 사례의 기대 결과다. */
type ExpectedTemplate =
  | { readonly kind: 'static'; readonly template: string }
  | { readonly kind: 'not-static' };

/** 벡터 파일 후보 경로 중 처음 있는 것을 찾는다. */
function locateVector(): string | undefined {
  const directories = [
    process.env['TSOGRAPH_CONFORMANCE_DIR'],
    join(repositoryRoot, 'conformance'),
    join(repositoryRoot, '..', 'isthmus', 'conformance'),
  ].filter((directory): directory is string => directory !== undefined && directory !== '');
  return directories.map((directory) => join(directory, 'http-template.json')).find((path) => existsSync(path));
}

/** 값이 JSON 객체인지 확인한다. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `appliesTo`가 openapi 생산자를 포함하는지 확인한다(문자열·배열·객체 표기 모두). */
function appliesToOpenApi(value: unknown): boolean {
  if (typeof value === 'string') return value.toLowerCase() === 'openapi';
  if (Array.isArray(value)) return value.some(appliesToOpenApi);
  if (isObject(value)) return Object.values(value).some(appliesToOpenApi);
  return false;
}

/** 사례에서 첫 문자열 필드를 찾는다. */
function firstString(record: Record<string, unknown>, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = record[name];
    if (typeof value === 'string') return value;
    if (isObject(value)) {
      const nested = firstString(value, ['path', 'template', 'raw']);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** 생산자 사례의 기대 결과를 읽는다. */
function readExpected(record: Record<string, unknown>): ExpectedTemplate | undefined {
  const expected = record['expect'] ?? record['expected'];
  if (typeof expected === 'string') return { kind: 'static', template: expected };
  if (!isObject(expected)) return undefined;
  if (expected['dynamic'] === true || expected['ok'] === false || expected['rejected'] === true) return { kind: 'not-static' };
  const template = firstString(expected, ['template', 'channel', 'canonical']);
  return template === undefined ? undefined : { kind: 'static', template };
}

/**
 * 벡터 사례 하나를 검사로 바꾼다.
 *
 * @returns 검사, 해당 없음(undefined), 또는 읽을 수 없는 사례의 설명(string)
 */
function toCheck(entry: unknown, index: number): VectorCheck | string | undefined {
  if (!isObject(entry)) return `case ${index} is not an object`;
  const id = typeof entry['id'] === 'string' ? entry['id'] : `#${index}`;
  if (appliesToOpenApi(entry['appliesTo'] ?? entry['producer'] ?? entry['dialect'] ?? entry['source'])) {
    const input = firstString(entry, ['input', 'raw', 'source', 'path']);
    const expected = readExpected(entry);
    if (input === undefined || expected === undefined) return `openapi case ${id} has no readable input/expect`;
    return { kind: 'producer', id, input, expected };
  }
  const expectation = entry['expect'] ?? entry['expected'];
  const template = firstString(entry, ['template', 'channel']);
  if (template === undefined || !isObject(expectation) || typeof expectation['ok'] !== 'boolean') return undefined;
  return { kind: 'grammar', id, template, isCanonical: expectation['ok'] };
}

/** 벡터 JSON을 검사 목록으로 바꾼다. 읽을 수 없는 구조면 설명과 함께 실패한다. */
function readChecks(vector: unknown): VectorCheck[] {
  const cases = isObject(vector) ? vector['cases'] : Array.isArray(vector) ? vector : undefined;
  assert.ok(Array.isArray(cases), 'http-template vector has no "cases" array; update the tsograph adapter to the vector schema');
  const results = cases.map(toCheck);
  const unreadable = results.filter((result): result is string => typeof result === 'string');
  assert.deepEqual(unreadable, [], 'http-template vector cases could not be read; update the tsograph adapter');
  return results.filter((result): result is VectorCheck => typeof result === 'object');
}

/** 검사 하나를 실행하고 불일치 설명을 돌려준다. */
function runCheck(check: VectorCheck): string | undefined {
  if (check.kind === 'producer') {
    const result = canonicalizePathTemplate(check.input);
    const actual = result.kind === 'static' ? result.template : undefined;
    const expected = check.expected.kind === 'static' ? check.expected.template : undefined;
    return actual === expected ? undefined : `${check.id}: expected ${String(expected)}, got ${String(actual)}`;
  }
  // 이 정규화기는 catch-all을 만들지 않으므로 {**} 템플릿의 고정점 성질은 해당 없다.
  if (check.template.includes('{**}')) return undefined;
  const result = canonicalizePathTemplate(check.template);
  const isFixedPoint = result.kind === 'static' && result.template === check.template;
  if (check.isCanonical && !isFixedPoint) return `${check.id}: canonical template is not a fixed point`;
  if (!check.isCanonical && isFixedPoint) return `${check.id}: rejected template is emitted unchanged`;
  return undefined;
}

/** 벡터 파일 위치다. 없으면 건너뛴다. */
const vectorPath = locateVector();

test(
  'isthmus http-template 공유 벡터를 통과한다',
  { skip: vectorPath === undefined ? 'isthmus conformance/http-template.json not found (set TSOGRAPH_CONFORMANCE_DIR); shared-vector check pending' : false },
  () => {
    const checks = readChecks(JSON.parse(readFileSync(vectorPath!, 'utf8')));
    assert.ok(checks.length > 0, 'http-template vector has no case applicable to tsograph');
    assert.deepEqual(checks.map(runCheck).filter((failure) => failure !== undefined), []);
  },
);

test('벡터 어댑터는 생산자 사례와 문법 사례를 읽고 불일치를 찾는다', () => {
  const checks = readChecks({
    cases: [
      { id: 'p1', appliesTo: ['openapi'], input: '/users/{id}', expect: { template: '/users/{}' } },
      { id: 'p2', appliesTo: 'openapi', input: { path: '/r/{y}-{m}' }, expect: { dynamic: true } },
      { id: 'p3', appliesTo: { producers: ['openapi'] }, input: '/a%7e', expected: '/a~' },
      { id: 'g1', template: '/files/{}.json', expect: { ok: true } },
      { id: 'g2', template: '/a%2f', expect: { ok: false, reason: 'lowercase-percent-hex' } },
      { id: 'g3', template: '/x/{**}', expect: { ok: true } },
      { id: 'other', appliesTo: ['spring'], input: '/{id:[0-9]+}', expect: { template: '/{}' } },
    ],
  });
  assert.deepEqual(checks.map((check) => check.id), ['p1', 'p2', 'p3', 'g1', 'g2', 'g3']);
  assert.deepEqual(checks.map(runCheck).filter((failure) => failure !== undefined), []);
  assert.match(runCheck({ kind: 'producer', id: 'bad', input: '/a', expected: { kind: 'static', template: '/b' } }) ?? '', /expected \/b/);
  assert.match(runCheck({ kind: 'grammar', id: 'bad', template: '/a%2f', isCanonical: true }) ?? '', /fixed point/);
  assert.match(runCheck({ kind: 'grammar', id: 'bad', template: '/ok', isCanonical: false }) ?? '', /unchanged/);
  assert.throws(() => readChecks({ cases: [{ appliesTo: 'openapi' }] }), /could not be read/);
  assert.throws(() => readChecks({}), /no "cases" array/);
});
