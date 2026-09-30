/**
 * isthmus 공유 벡터 `conformance/http-dispatch.json`의 `dispatch.validate` 사례(생산자도 적용)로 `order` 검증기를
 * 검사한다. `dispatch.match`·`dispatch.shadow`는 소비자 전용이라 여기서 실행하지 않는다.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { dispatchOrderProblem, type OrderedDocumentShape, orderShapeProblem } from './dispatch-order.ts';

/** 벡터 사례 중 이 검사가 읽는 모양이다. */
interface DispatchCase {
  readonly id: string;
  readonly ruleId: string;
  readonly appliesTo: readonly string[];
  readonly input: { readonly document?: OrderedDocumentShape };
  readonly expect: { readonly valid?: boolean };
}

/** 벤더링한 디스패치 사례다. */
const dispatchCases = (JSON.parse(readFileSync(fileURLToPath(new URL('../../conformance/http-dispatch.json', import.meta.url)), 'utf8')) as { cases: DispatchCase[] }).cases;

test('isthmus dispatch.validate 사례: 제품 검증기가 소비자와 같이 판정한다', () => {
  const validate = dispatchCases.filter((entry) => entry.ruleId === 'dispatch.validate');
  assert.ok(validate.length >= 18);
  assert.ok(validate.every((entry) => entry.appliesTo.includes('producer')));
  const failures = validate.filter((entry) => (dispatchOrderProblem(entry.input.document!) === undefined) !== entry.expect.valid);
  assert.deepEqual(failures.map((entry) => entry.id), []);
});

test('order 모양 검사는 계약의 거부 사유를 가린다', () => {
  assert.equal(orderShapeProblem({ group: 'hono:a.ts:1:1', index: 0 }), undefined);
  assert.equal(orderShapeProblem(null), 'order-not-object');
  assert.equal(orderShapeProblem([1]), 'order-not-object');
  assert.equal(orderShapeProblem({ group: 'g\u0001', index: 0 }), 'invalid-group');
  assert.equal(orderShapeProblem({ group: 'g', index: Number.MAX_SAFE_INTEGER + 1 }), 'invalid-index');
});

test('문서 service가 group의 유효 service를 정한다', () => {
  const document: OrderedDocumentShape = {
    dispatch: 'registration-order',
    service: 'shop',
    facts: [
      { method: 'GET', channel: '/a', order: { group: 'g', index: 0 } },
      { method: 'GET', channel: '/b', order: { group: 'g', index: 1 }, service: 'shop' },
    ],
  };
  assert.equal(dispatchOrderProblem(document), undefined);
  assert.equal(dispatchOrderProblem({ ...document, facts: [...document.facts, { method: 'GET', channel: '/c', order: { group: 'g', index: 2 }, service: 'blog' }] }), 'group-across-services');
});

test('루트 catch-all의 접두사 decl은 `/`이고 원본이 없으면 거부한다', () => {
  const symbol = { qualifiedName: 'a', usr: 'a.ts#a' };
  const original = { method: 'GET', channel: '/{**}', symbol };
  const prefix = { method: 'GET', channel: '/', symbol, catchAllPrefix: true };
  assert.equal(dispatchOrderProblem({ dispatch: 'specificity', facts: [original, prefix] }), undefined);
  assert.equal(dispatchOrderProblem({ dispatch: 'specificity', facts: [prefix] }), 'catch-all-prefix-order-mismatch');
});
