/**
 * isthmus 공유 적합성 벡터(`conformance/http-template.json`)로 템플릿 정규화기를 검증한다.
 *
 * 벡터는 isthmus가 소유한다(`format: "isthmus-conformance"`, `suite: "http-template"`).
 * 생산자에 해당하는 사례만 읽는다.
 * - `producer:openapi`: OpenAPI 경로 → 정규 템플릿(`expect.template`) 또는 dynamic(`expectDynamic`).
 * - `producer` + `input.path`(framework 없음): 리터럴 정규화 규칙(`template.normalize`).
 * - `producer` + `input.template` + `expect.valid`: 정규 템플릿은 정규화기의 고정점이고,
 *   거부 템플릿은 정규화기가 그대로 내지 않는다.
 * `consumer` 전용 사례와 다른 프레임워크 사례는 건너뛴다. 같은 디렉터리에 `SHA256SUMS`가
 * 있으면 벡터 해시도 대조한다.
 *
 * 벡터 위치: `TSOGRAPH_CONFORMANCE_DIR`, 저장소의 `conformance/`(향후 벤더링), 형제 checkout
 * `../isthmus/conformance/` 순서로 찾고, 없으면 이유를 밝히고 건너뛴다.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalizeLiteralTemplate, canonicalizePathTemplate } from './path-template.ts';

/** 저장소 루트다. */
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));

/** 벡터 사례에서 읽어 낸 검사 하나다. */
type VectorCheck =
  | { readonly kind: 'openapi'; readonly id: string; readonly path: string; readonly expected: string | 'dynamic' }
  | { readonly kind: 'literal'; readonly id: string; readonly path: string; readonly expected: string }
  | { readonly kind: 'grammar'; readonly id: string; readonly template: string; readonly isValid: boolean };

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

/** 사례의 `appliesTo`에서 생산자 대상(`openapi`·`generic`)을 판별한다. */
function producerTarget(appliesTo: unknown): 'openapi' | 'generic' | undefined {
  const targets = Array.isArray(appliesTo) ? appliesTo : [];
  if (targets.includes('producer:openapi')) return 'openapi';
  return targets.includes('producer') ? 'generic' : undefined;
}

/**
 * 벡터 사례 하나를 검사로 바꾼다.
 *
 * @returns 검사, 해당 없음(undefined), 또는 읽을 수 없는 생산자 사례의 설명(string)
 */
function toCheck(entry: unknown, index: number): VectorCheck | string | undefined {
  if (!isObject(entry)) return `case ${index} is not an object`;
  const id = typeof entry['id'] === 'string' ? entry['id'] : `#${index}`;
  const target = producerTarget(entry['appliesTo']);
  const input = isObject(entry['input']) ? entry['input'] : {};
  const expect = isObject(entry['expect']) ? entry['expect'] : {};
  if (target === undefined) return undefined;
  if (target === 'openapi') {
    const expected = entry['expectDynamic'] === true ? 'dynamic' : expect['template'];
    if (typeof input['path'] !== 'string' || typeof expected !== 'string') return `openapi case ${id} is unreadable`;
    return { kind: 'openapi', id, path: input['path'], expected };
  }
  if (typeof input['template'] === 'string' && typeof expect['valid'] === 'boolean') {
    return { kind: 'grammar', id, template: input['template'], isValid: expect['valid'] };
  }
  if (typeof input['path'] === 'string' && input['framework'] === undefined && typeof expect['template'] === 'string') {
    return { kind: 'literal', id, path: input['path'], expected: expect['template'] };
  }
  return input['framework'] === undefined ? `producer case ${id} is unreadable` : undefined;
}

/** 벡터 JSON을 검사 목록으로 바꾼다. 읽을 수 없는 구조면 설명과 함께 실패한다. */
function readChecks(vector: unknown): VectorCheck[] {
  assert.ok(isObject(vector) && vector['suite'] === 'http-template', 'file is not the http-template conformance suite');
  const cases = vector['cases'];
  assert.ok(Array.isArray(cases), 'http-template vector has no "cases" array; update the tsograph adapter');
  const results = cases.map(toCheck);
  const unreadable = results.filter((result): result is string => typeof result === 'string');
  assert.deepEqual(unreadable, [], 'http-template producer cases could not be read; update the tsograph adapter');
  return results.filter((result): result is VectorCheck => typeof result === 'object');
}

/** 검사 하나를 실행하고 불일치 설명을 돌려준다. */
function runCheck(check: VectorCheck): string | undefined {
  if (check.kind === 'openapi') {
    const result = canonicalizePathTemplate(check.path);
    const actual = result.kind === 'static' ? result.template : result.kind;
    return actual === check.expected ? undefined : `${check.id}: expected ${check.expected}, got ${actual}`;
  }
  if (check.kind === 'literal') {
    const actual = canonicalizeLiteralTemplate(check.path);
    return actual === check.expected ? undefined : `${check.id}: expected ${check.expected}, got ${actual}`;
  }
  // 이 정규화기는 catch-all을 만들지 않으므로 {**} 템플릿의 고정점 성질은 해당 없다.
  if (check.template.includes('{**}')) return undefined;
  const result = canonicalizePathTemplate(check.template);
  const isFixedPoint = result.kind === 'static' && result.template === check.template;
  if (check.isValid && !isFixedPoint) return `${check.id}: canonical template is not a fixed point`;
  if (!check.isValid && isFixedPoint) return `${check.id}: rejected template is emitted unchanged`;
  return undefined;
}

/** 벡터 옆의 SHA256SUMS가 있으면 해시를 대조한다. */
function verifyChecksum(vectorPath: string, bytes: Buffer): void {
  const sumsPath = join(dirname(vectorPath), 'SHA256SUMS');
  if (!existsSync(sumsPath)) return;
  const line = readFileSync(sumsPath, 'utf8').split('\n').find((entry) => entry.trim().endsWith(' http-template.json'));
  assert.ok(line !== undefined, 'SHA256SUMS has no http-template.json entry');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), line.trim().split(/\s+/u)[0], 'http-template.json sha256 mismatch');
}

/** 벡터 파일 위치다. 없으면 건너뛴다. */
const vectorPath = locateVector();

test(
  'isthmus http-template 공유 벡터를 통과한다',
  { skip: vectorPath === undefined ? 'isthmus conformance/http-template.json not found (set TSOGRAPH_CONFORMANCE_DIR); shared-vector check pending' : false },
  () => {
    const bytes = readFileSync(vectorPath!);
    verifyChecksum(vectorPath!, bytes);
    const checks = readChecks(JSON.parse(bytes.toString('utf8')));
    assert.ok(checks.some((check) => check.kind === 'openapi'), 'http-template vector has no producer:openapi case');
    assert.deepEqual(checks.map(runCheck).filter((failure) => failure !== undefined), []);
  },
);

test('벡터 어댑터는 생산자 사례만 읽고 불일치를 찾는다', () => {
  const checks = readChecks({
    suite: 'http-template',
    cases: [
      { id: 'o1', appliesTo: ['producer:openapi'], input: { framework: 'openapi', path: '/users/{id}' }, expect: { template: '/users/{}' } },
      { id: 'o2', appliesTo: ['producer:openapi'], input: { framework: 'openapi', path: '/v{a}.{b}' }, expectDynamic: true },
      { id: 'n1', appliesTo: ['producer'], input: { path: '/tpl/{x}' }, expect: { template: '/tpl/%7Bx%7D' } },
      { id: 'g1', appliesTo: ['consumer', 'producer'], input: { template: '/files/{}.json' }, expect: { valid: true } },
      { id: 'g2', appliesTo: ['consumer', 'producer'], input: { template: '/a%2f' }, expect: { valid: false, reason: 'lowercase-percent-hex' } },
      { id: 'g3', appliesTo: ['consumer', 'producer'], input: { template: '/x/{**}' }, expect: { valid: true } },
      { id: 'c1', appliesTo: ['consumer'], input: { call: '/a', decls: [] }, expect: { status: 'none' } },
      { id: 's1', appliesTo: ['producer'], input: { framework: 'spring', path: '/{id:[0-9]+}' }, expect: { template: '/{}' } },
    ],
  });
  assert.deepEqual(checks.map((check) => check.id), ['o1', 'o2', 'n1', 'g1', 'g2', 'g3']);
  assert.deepEqual(checks.map(runCheck).filter((failure) => failure !== undefined), []);
  assert.match(runCheck({ kind: 'openapi', id: 'x', path: '/a', expected: '/b' }) ?? '', /expected \/b/);
  assert.match(runCheck({ kind: 'literal', id: 'x', path: '/a', expected: '/b' }) ?? '', /expected \/b/);
  assert.match(runCheck({ kind: 'grammar', id: 'x', template: '/a%2f', isValid: true }) ?? '', /fixed point/);
  assert.match(runCheck({ kind: 'grammar', id: 'x', template: '/ok', isValid: false }) ?? '', /unchanged/);
  assert.throws(() => readChecks({ suite: 'http-template', cases: [{ appliesTo: ['producer:openapi'] }] }), /could not be read/);
  assert.throws(() => readChecks({ suite: 'http-template', cases: [{ appliesTo: ['producer'], input: {} }] }), /could not be read/);
  assert.throws(() => readChecks({ suite: 'http-template', cases: [1] }), /could not be read/);
  assert.throws(() => readChecks({ suite: 'http-template' }), /no "cases" array/);
  assert.throws(() => readChecks({ suite: 'url-compose', cases: [] }), /not the http-template/);
});
