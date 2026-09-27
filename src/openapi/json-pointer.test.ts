import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveLocalReference } from './json-pointer.ts';
import { parseSpecTree } from './spec-tree.ts';

/** 포인터 테스트용 트리다. */
const tree = parseSpecTree(JSON.stringify({
  components: { 'a/b': { 'c~d': 'deep' }, 'sp ace': 'x' },
  list: ['zero', 'one'],
}));

/** 해석 결과의 문자열 값을 돌려준다. */
function resolvedString(reference: string): string | undefined {
  const resolution = resolveLocalReference(tree, reference);
  return resolution.kind === 'resolved' ? tree.string(resolution.node) : resolution.kind;
}

test('JSON Pointer 이스케이프와 percent-encoding을 풀어 따라간다', () => {
  assert.equal(resolvedString('#/components/a~1b/c~0d'), 'deep');
  assert.equal(resolvedString('#/components/sp%20ace'), 'x');
  assert.equal(resolvedString('#/list/1'), 'one');
});

test('빈 fragment는 문서 전체를 가리킨다', () => {
  const resolution = resolveLocalReference(tree, '#');
  assert.equal(resolution.kind, 'resolved');
});

test('다른 파일·원격 참조는 따라가지 않는다', () => {
  assert.equal(resolvedString('other.yaml#/x'), 'non-local');
  assert.equal(resolvedString('https://example.test/spec.yaml'), 'non-local');
});

test('없는 대상·잘못된 포인터·잘못된 인덱스는 broken이다', () => {
  for (const reference of ['#/missing', '#components', '#/list/01', '#/list/9', '#/list/0/x', '#/%E0%A4%A']) {
    assert.equal(resolvedString(reference), 'broken', reference);
  }
});
