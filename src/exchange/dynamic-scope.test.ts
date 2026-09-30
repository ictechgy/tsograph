/**
 * isthmus 공유 벡터 `conformance/http-limitation-scope.json`의 `scope.dynamic-validate` 사례로 `dynamicScope`
 * 검증기를 검사한다. `scope.dynamic-applies`는 소비자 규칙이라 routes가 기대는 사례가 벡터에 있는지만 확인한다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type DynamicScopeDeclaration, dynamicScopeProblem, MAX_DYNAMIC_SCOPE_ELEMENTS } from './dynamic-scope.ts';

/** 벡터 사례 중 이 검사가 읽는 모양이다. */
interface DynamicCase {
  readonly id: string;
  readonly ruleId: string;
  readonly appliesTo: readonly string[];
  readonly input: { readonly declaration: DynamicScopeDeclaration };
  readonly expect: { readonly valid?: boolean; readonly applies?: boolean };
}

/** 벤더링한 스코프 사례다. */
const cases = (JSON.parse(readFileSync(fileURLToPath(new URL('../../conformance/http-limitation-scope.json', import.meta.url)), 'utf8')) as { cases: DynamicCase[] }).cases;

test('isthmus scope.dynamic-validate 사례: 제품 검증기가 소비자와 같이 판정한다', () => {
  const validate = cases.filter((entry) => entry.ruleId === 'scope.dynamic-validate');
  assert.ok(validate.length >= 17);
  const failures = validate.filter((entry) => (dynamicScopeProblem(entry.input.declaration) === undefined) !== entry.expect.valid);
  assert.deepEqual(failures.map((entry) => entry.id), []);
});

test('isthmus scope.dynamic-applies 사례: routes가 기대는 소비자 규칙이 벡터에 있다', () => {
  const applies = new Map(cases.filter((entry) => entry.ruleId === 'scope.dynamic-applies').map((entry) => [entry.id, entry.expect.applies]));
  // mount 접두사 스코프는 세그먼트 경계를 지키고 아래 전부를 덮는다.
  assert.equal(applies.get('dynamic-applies/prefix-inside'), true);
  assert.equal(applies.get('dynamic-applies/prefix-outside'), false);
  // 스코프를 실은 선언은 자기 method로도 좁힌다(ANY가 아니면 methods를 싣지 않는다).
  assert.equal(applies.get('dynamic-applies/declaration-method-bounds'), false);
  // base 앵커 선언의 접미사 스코프는 알 수 없는 앞부분 뒤의 꼬리를 덮는다.
  assert.equal(applies.get('dynamic-applies/suffix-tail'), true);
});

test('검증기는 원소 수 상한과 스코프 없는 선언을 다룬다', () => {
  const base = { kind: 'route-decl', method: 'GET', pathAnchor: 'root', dynamic: true };
  assert.equal(dynamicScopeProblem(base), undefined);
  const many = Array.from({ length: MAX_DYNAMIC_SCOPE_ELEMENTS + 1 }, (_, index) => `/a${index}`);
  assert.equal(dynamicScopeProblem({ ...base, dynamicScope: { templates: many } }), 'too-many-elements');
  assert.equal(dynamicScopeProblem({ ...base, dynamicScope: { templates: ['/a'], methods: ['GET', 'GET'] }, method: 'ANY' }), 'invalid-methods');
});
