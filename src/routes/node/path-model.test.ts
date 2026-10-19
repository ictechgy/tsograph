/**
 * 경로 세그먼트 모델의 펼치기(빈 값 변형·catch-all 접두사)와 접두사 정리, 그리고 경로 문법 모듈이 그 모델을 만들 때의
 * 작업 상한(선택 세그먼트 펼치기·선택 그룹 중첩)을 검사한다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileHonoPath, honoOptionalPaths } from './hono-path.ts';
import { type CompiledPath, expandVariant, joinVariants, MAX_TEMPLATE_VARIANTS, type PathVariant, prefixTemplates, ROOT_VARIANT, variantOf, variantsResult } from './path-model.ts';
import { compilePte8Path } from './pte8-path.ts';

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

/**
 * `{` d개로 겹친 선택 그룹 경로다(`/{{a}}`).
 *
 * @param depth 겹친 수
 * @param inner 가장 안쪽 내용
 * @returns 경로
 */
function nestedGroups(depth: number, inner = 'a'): string {
  return `/${'{'.repeat(depth)}${inner}${'}'.repeat(depth)}`;
}

test('path-to-regexp 8 선택 그룹은 15겹까지 펼치고 16겹부터 상한 초과다', () => {
  // d겹이면 펼친 대안이 d+1개다(`/a` 하나와 `/` d개). 같은 템플릿을 줄이면 15겹은 두 대안이다.
  assert.deepEqual(compilePte8Path(nestedGroups(15), true), { kind: 'variants', variants: [{ segments: [{ kind: 'literal', text: 'a' }] }, ROOT_VARIANT] });
  assert.deepEqual(compilePte8Path(nestedGroups(16), true), { kind: 'dynamic', reason: 'expansion-capped', prefixes: [ROOT_VARIANT] });
});

test('path-to-regexp 8 선택 그룹이 수만 겹이어도 호출 스택을 넘지 않고 문법 오류를 먼저 본다', () => {
  // 예전에는 `{`마다 재귀해 8,000겹 안팎에서 RangeError(호출 스택 초과)로 routes 문서 전체가 실패했다.
  const depth = 50_000;
  assert.deepEqual(compilePte8Path(nestedGroups(depth), true), { kind: 'dynamic', reason: 'expansion-capped', prefixes: [ROOT_VARIANT] });
  assert.deepEqual(compilePte8Path(nestedGroups(depth, 'a('), true), { kind: 'dynamic', reason: 'unsupported-syntax', prefixes: [ROOT_VARIANT] });
  assert.deepEqual(compilePte8Path(`/${'{'.repeat(depth)}a`, false), { kind: 'dynamic', reason: 'unsupported-syntax', prefixes: [ROOT_VARIANT] });
});

/**
 * 시드로 고정한 의사 난수 생성기다(mulberry32). 무작위 차등 검사를 실행마다 같게 한다.
 *
 * @param seed 시드
 * @returns [0, 1) 난수 함수
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Hono 선택 세그먼트 경로를 펼친 경로마다 따로 컴파일한 결과다(펼칠 경로가 많을 때의 예전 구현과 같다). 펼친 경로는
 * `?`·`*`로 끝나지 않게 만들었으므로 하나씩 {@link compileHonoPath}에 넣으면 그 경로 하나의 세그먼트 컴파일이다.
 *
 * @param path 경로
 * @returns 컴파일 결과
 */
function honoPerCandidate(path: string): CompiledPath {
  const variants: PathVariant[] = [];
  for (const candidate of honoOptionalPaths(path)) {
    const compiled = compileHonoPath(candidate);
    if (compiled.kind === 'dynamic') return compiled;
    variants.push(...compiled.variants);
  }
  return variantsResult(variants);
}

/** 무작위 Hono 경로에 쓸 세그먼트다. 깨끗한 쪽은 모두 컴파일되고, 거친 쪽은 중괄호 짝·변환 실패·점 세그먼트를 섞는다. */
const honoSegments = {
  clean: ['users', 'v1', '%41', ':id', ':slug{[a-z]+}', ':n{[0-9]+}', ':p?', ':q{[0-9]+}?', ':r?'],
  rough: ['', '.', '..', '%2e', 'a:b', 'file-:id', ':a{x', 'y}', '}', '{', ':rest{.+}', ':v{.*}', ':tail{.+}?', ':bad{', ':p?', ':q?'],
} as const;

test('Hono 선택 세그먼트로 펼칠 경로가 상한보다 많아도 펼친 경로마다 컴파일한 결과와 같다', () => {
  const random = seededRandom(0x5eed);
  const outcomes = new Map<string, number>();
  for (let index = 0; index < 4000; index++) {
    const pool = index % 2 === 0 ? honoSegments.clean : honoSegments.rough;
    const segments = Array.from({ length: 18 + Math.floor(random() * 30) }, () => pool[Math.floor(random() * pool.length)]!);
    const path = `/${[...segments, ':last?'].join('/')}`;
    const compiled = compileHonoPath(path);
    assert.deepEqual(compiled, honoPerCandidate(path), path);
    if (honoOptionalPaths(path).length > MAX_TEMPLATE_VARIANTS) {
      const outcome = compiled.kind === 'dynamic' ? compiled.reason : 'variants';
      outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    }
  }
  // 상한을 넘는 경로가 모든 판정 갈래(상한 초과, 중괄호·변환 실패, 정규식, 점 세그먼트)를 거쳤는지 본다.
  assert.deepEqual([...outcomes.keys()].sort(), ['dot-segment', 'expansion-capped', 'regex', 'unsupported-syntax']);
});
