/**
 * isthmus 공유 벡터 `conformance/http-limitation-scope.json`으로 스코프 검증기를 검사한다.
 *
 * - `scope.validate`: 생산자가 내는 스코프는 소비자가 거부하지 않아야 하므로 제품 검증기
 *   (`httpLimitationScopeProblem`)가 모든 사례에서 소비자와 같은 판정을 내야 한다.
 * - `scope.applies`: 호출이 스코프 안인지는 소비자의 조인 규칙이라 생산자가 계산하지 않는다. 대신
 *   `tsograph routes`가 기대는 사례(접두사의 세그먼트 경계, 루트 접두사, method 제외, 끝 슬래시·대소문자
 *   접기)가 벡터에 그대로 있는지 확인한다. 이 규칙이 바뀌면 벤더링 갱신 때 여기서 실패해 스코프를 다시
 *   판단하게 한다.
 * 벤더링한 모든 벡터 파일은 `SHA256SUMS`와 대조한다.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { httpLimitationScopeProblem } from './http-limitation-scope.ts';

/** 벤더링한 벡터 디렉터리다. */
const conformanceDirectory = fileURLToPath(new URL('../../conformance/', import.meta.url));

/** 벡터 사례 중 이 검사가 읽는 모양이다. */
interface ScopeCase {
  readonly id: string;
  readonly ruleId: string;
  readonly appliesTo: readonly string[];
  readonly input: { readonly scope: Record<string, unknown>; readonly probe?: Record<string, unknown> };
  readonly expect: { readonly valid?: boolean; readonly applies?: boolean };
}

/** 벤더링한 스코프 사례다. */
const scopeCases = (JSON.parse(readFileSync(join(conformanceDirectory, 'http-limitation-scope.json'), 'utf8')) as { suite: string; cases: ScopeCase[] });

test('벤더링한 벡터 파일은 모두 SHA256SUMS와 같고 목록에 빠진 파일이 없다', () => {
  const sums = new Map(readFileSync(join(conformanceDirectory, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => {
    const [digest, name] = line.trim().split(/\s+/u);
    return [name!, digest!] as const;
  }));
  const vectors = readdirSync(conformanceDirectory).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual([...sums.keys()].sort(), vectors);
  for (const name of vectors) {
    const digest = createHash('sha256').update(readFileSync(join(conformanceDirectory, name))).digest('hex');
    assert.equal(digest, sums.get(name), `${name} differs from SHA256SUMS; re-vendor it with SHA256SUMS from isthmus`);
  }
});

test('스코프 suite는 생산자 대상이고 알고 있는 규칙만 담는다', () => {
  assert.equal(scopeCases.suite, 'http-limitation-scope');
  const rules = new Set(scopeCases.cases.map((entry) => entry.ruleId));
  assert.deepEqual([...rules].sort(), ['scope.applies', 'scope.dynamic-applies', 'scope.dynamic-validate', 'scope.validate']);
  assert.ok(scopeCases.cases.every((entry) => entry.appliesTo.includes('producer')));
});

test('isthmus scope.validate 사례: 제품 검증기가 소비자와 같이 판정한다', () => {
  const validate = scopeCases.cases.filter((entry) => entry.ruleId === 'scope.validate');
  assert.ok(validate.length > 0);
  const failures = validate.filter((entry) => {
    const isValid = httpLimitationScopeProblem({ limitationIndex: 0, ...entry.input.scope }) === undefined;
    return isValid !== entry.expect.valid;
  });
  assert.deepEqual(failures.map((entry) => entry.id), []);
});

test('isthmus scope.applies 사례: routes 스코프가 기대는 소비자 규칙이 벡터에 있다', () => {
  const applies = new Map(scopeCases.cases.filter((entry) => entry.ruleId === 'scope.applies').map((entry) => [entry.id, entry.expect.applies]));
  // `/_next`·`/static`·basePath 접두사는 아래 전부를 덮고 세그먼트 경계를 지킨다.
  assert.equal(applies.get('applies/prefix-covers-subtree'), true);
  assert.equal(applies.get('applies/prefix-segment-boundary'), false);
  // basePath가 없을 때 public 접두사 `/`는 모든 경로이고, GET·HEAD 제한이 다른 동사를 판정 가능하게 둔다.
  assert.equal(applies.get('applies/root-prefix-covers-everything'), true);
  assert.equal(applies.get('applies/methods-exclude-other-verbs'), false);
  // Next는 끝 슬래시를 떼고 파일을 찾는다. 소비자가 끝 슬래시·대소문자를 넓게 읽으므로 변형을 나열하지 않는다.
  assert.equal(applies.get('applies/template-trailing-slash-folded'), true);
  assert.equal(applies.get('applies/template-case-folded'), true);
});

test('검증기는 계약의 거부 사유를 가린다', () => {
  const cases: [Record<string, unknown>, string | undefined][] = [
    [{ limitationIndex: 0, templatePrefixes: ['/_next'] }, undefined],
    [{ limitationIndex: 0, templatePrefixes: ['/'], methods: ['GET', 'HEAD'] }, undefined],
    [{ limitationIndex: 0, templateSuffixes: ['/items/{}'], templates: ['/x/{**}'] }, undefined],
    [{ limitationIndex: 0, templates: [] }, 'templates-not-non-empty-array'],
    [{ limitationIndex: 0, templates: '/a' }, 'templates-not-non-empty-array'],
    [{ limitationIndex: 0, templates: [1] }, 'templates-non-canonical-template'],
    [{ limitationIndex: 0, templateSuffixes: ['/a/{**}'] }, 'templateSuffixes-catch-all'],
    [{ limitationIndex: 0, templates: ['/a'], methods: [] }, 'invalid-methods'],
    [{ limitationIndex: 0, templates: ['/a'], methods: ['GET', 'GET'] }, 'invalid-methods'],
    [{ limitationIndex: 0, templates: ['/a'], methods: 'GET' }, 'invalid-methods'],
  ];
  for (const [entry, expected] of cases) assert.equal(httpLimitationScopeProblem(entry), expected, JSON.stringify(entry));
});
