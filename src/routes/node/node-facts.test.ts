/**
 * Node 사실 조립의 펼치기 상한 계수기(`NodeFactBudget`)를 검사한다.
 *
 * 계수기는 서로 다른 사실 하한과 펼친 라우트 수를 따로 센다. 둘 중 어느 쪽이 상한을 넘었는지에 따라 실패 문구가 원인을
 * 다르게 들어야 한다 — 같은 사실로 합쳐지거나 사실을 내지 않는(조건부) 등록만으로 펼친 수 상한을 넘은 프로젝트에 사실 수
 * 초과를 알리면 거짓 원인이 된다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FlatRoute } from './flat-route.ts';
import { NodeFactBudget } from './node-facts.ts';

/**
 * 계수기가 읽는 필드(등록 조건·method·경로·원문·앵커)만 채운 펼친 라우트다. 경로는 dynamic이라 사실 정체성이 원문으로 정해진다.
 *
 * @param rawPath dynamic 사실 channel이 될 원문 경로
 * @param conditional 조건부 등록인지(사실을 내지 않는다)
 * @returns 펼친 라우트
 */
function flatRoute(rawPath: string, conditional = false): FlatRoute {
  const route = {
    methods: ['GET'],
    unsupportedMethods: [],
    path: { kind: 'dynamic', reason: 'non-literal', prefixes: undefined },
    rawPath,
    anchor: 'root',
    conditional,
  };
  return route as unknown as FlatRoute;
}

test('사실 하한 계수기는 상한을 넘은 원인을 서로 다른 사실과 펼친 라우트 수로 나눈다', () => {
  // 상한 2: 서로 다른 사실이 셋이 되면 사실 수가 원인이다.
  const distinct = new NodeFactBudget(2);
  for (const path of ['/a', '/b']) distinct.add(flatRoute(path));
  assert.equal(distinct.exceededCause, undefined);
  distinct.add(flatRoute('/c'));
  assert.equal(distinct.exceededCause, 'facts');
  assert.equal(distinct.isExceeded, true);
  // 같은 사실로 합쳐지는 등록과 조건부 등록은 사실 하한을 늘리지 않고 펼친 수(상한 2 × 2 = 4)만 늘린다.
  const merged = new NodeFactBudget(2);
  for (const route of [flatRoute('/x'), flatRoute('/x'), flatRoute('/x', true), flatRoute('/x', true)]) merged.add(route);
  assert.equal(merged.exceededCause, undefined);
  assert.equal(merged.isExceeded, false);
  merged.add(flatRoute('/x'));
  assert.equal(merged.exceededCause, 'flattened-routes');
  assert.equal(merged.isExceeded, true);
});
