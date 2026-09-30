/**
 * 경로 세그먼트 모델의 펼치기(빈 값 변형·catch-all 접두사)와 접두사 정리를 검사한다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { expandVariant, joinVariants, MAX_TEMPLATE_VARIANTS, type PathVariant, prefixTemplates, ROOT_VARIANT, variantOf, variantsResult } from './path-model.ts';

/** `{}` 파라미터 세그먼트다. */
const param = { kind: 'param', prefix: '', suffix: '', acceptsEmpty: true } as const;

test('빈 값 변형이 상한을 넘으면 펼치지 않는다', () => {
  const segments = Array.from({ length: 5 }, () => param);
  assert.equal(expandVariant({ segments }), undefined);
  const many = Array.from({ length: MAX_TEMPLATE_VARIANTS + 1 }, (): PathVariant => ROOT_VARIANT);
  assert.equal(variantsResult(many).kind, 'dynamic');
});

test('부분 세그먼트의 빈 값 변형은 골격만 남긴다', () => {
  const expanded = expandVariant({ segments: [{ kind: 'param', prefix: 'file-', suffix: '.json', acceptsEmpty: true, constraint: { kind: 'int' } }] });
  assert.deepEqual(expanded?.map((entry) => [entry.channel, entry.emptyVariant, entry.constraints]), [
    ['/file-{}.json', false, [{ segment: 0, kind: 'int' }]],
    ['/file-.json', true, []],
  ]);
});

test('정규 문법을 어기는 템플릿은 펼치지 않는다', () => {
  assert.equal(expandVariant({ segments: [{ kind: 'literal', text: 'a b' }] }), undefined);
});

test('대안 잇기와 접두사 정리는 루트와 catch-all을 다룬다', () => {
  const users: PathVariant = { segments: [{ kind: 'literal', text: 'users' }] };
  assert.deepEqual(joinVariants(ROOT_VARIANT, users), users);
  assert.deepEqual(joinVariants(users, ROOT_VARIANT), users);
  assert.deepEqual(prefixTemplates([
    { segments: [{ kind: 'literal', text: 'a' }, { kind: 'catch-all', zeroSegments: true, acceptsEmpty: false }] },
    { segments: [{ kind: 'literal', text: 'b' }, { kind: 'literal', text: '' }] },
    ROOT_VARIANT,
    { segments: [{ kind: 'literal', text: 'bad space' }] },
  ]), ['/', '/a', '/b']);
  assert.equal(variantOf([{ kind: 'literal', text: '..' }]), undefined);
  assert.deepEqual(variantOf([]), ROOT_VARIANT);
});
