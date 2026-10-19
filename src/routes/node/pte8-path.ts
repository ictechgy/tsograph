/**
 * path-to-regexp 8 문법(Express 5·router 2, @koa/router 14 이상, NestJS 11 이상 Express 어댑터)을 세그먼트 모델로 옮긴다.
 *
 * 확인한 path-to-regexp@8.4.2 `dist/index.js`와 router@2.2.0 `lib/layer.js` 동작:
 * - 토큰은 텍스트, `:name` 파라미터(`[^/]+`, 한 글자 이상), `*name` 와일드카드(`[^]+`, `/`를 포함한 한 글자 이상),
 *   `{…}` 선택 그룹(넣은 것과 뺀 것으로 펼침, 최대 256), `\x` 이스케이프다. `(`·`)`·`[`·`]`·`+`·`?`·`!`·짝 없는 `}`는
 *   `PathError`라 앱이 시작하지 않는다(dynamic으로 낸다).
 * - 이름은 `[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*` 또는 `"…"`다.
 * - `strict`가 아니면 router가 경로 끝 슬래시를 떼고(`loosen`) `trailing: true`로 끝 슬래시 하나를 선택으로 받는다.
 *   `sensitive`가 아니면 `i` 플래그다.
 */

import { canonicalizeLiteral } from '../../openapi/percent-encoding.ts';
import {
  type CompiledPath,
  type DynamicPathReason,
  MAX_TEMPLATE_VARIANTS,
  type PathVariant,
  ROOT_VARIANT,
  type TemplateSegment,
  variantOf,
  variantsResult,
} from './path-model.ts';

/** path-to-regexp 8 토큰이다. */
type Token =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'param' | 'wildcard'; readonly name: string }
  | { readonly type: 'group'; readonly tokens: readonly Token[] };

/** 이름 첫 글자다(원본과 같다). */
const ID_START = /^[$_\p{ID_Start}]$/u;

/** 이름 다음 글자다(원본과 같다). */
const ID_CONTINUE = /^[$‌‍\p{ID_Continue}]$/u;

/** 파싱 상태다. */
interface ParseState {
  readonly chars: readonly string[];
  index: number;
  /** 아직 토큰으로 내보내지 않은 텍스트 */
  text: string;
  /** 열린 그룹마다 모으는 토큰(맨 앞은 최상위) */
  readonly groups: Token[][];
}

/**
 * path-to-regexp 8 경로 하나를 컴파일한다.
 *
 * 작업은 경로 길이에 선형이다. 선택 그룹이 상한 이상으로 겹치면 펼치지 않고 상한 초과로 낸다 — 그룹이 d겹이면 펼친
 * 대안이 d+1개 이상이라 펼쳐도 같은 결과이고, 겹친 수만큼 깊어지는 재귀가 긴 경로 한 줄로 호출 스택을 넘지 않게 한다.
 *
 * @param path 경로 문자열
 * @param loosen 끝 슬래시를 떼는지(Express router의 non-strict `loosen`). @koa/router는 떼지 않는다.
 * @returns 컴파일 결과
 */
export function compilePte8Path(path: string, loosen: boolean): CompiledPath {
  const loosened = !loosen || path === '/' ? path : trimTrailingSlashes(path);
  const tokens = parseTokens(loosened);
  if (tokens === undefined) return dynamicWithPrefix(loosened, 'unsupported-syntax');
  const sequences = groupDepth(tokens) >= MAX_TEMPLATE_VARIANTS ? undefined : flattenGroups(tokens);
  if (sequences === undefined) return dynamicWithPrefix(loosened, 'expansion-capped');
  const variants: PathVariant[] = [];
  for (const sequence of sequences) {
    const variant = buildVariant(sequence);
    if (!('segments' in variant)) return dynamicWithPrefix(loosened, variant.reason);
    variants.push(variant);
  }
  return variantsResult(dedupeVariants(variants));
}

/**
 * 끝 슬래시를 모두 뗀다(router `loosen`의 `/\/+$/` 치환과 같다). 정규식 치환은 끝이 아닌 긴 `/` 연속에서 시작
 * 위치마다 연속의 끝까지 다시 맞춰 보아 길이의 제곱으로 느려지므로 뒤에서부터 센다.
 *
 * @param path 경로
 * @returns 끝 슬래시를 뗀 경로
 */
function trimTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path[end - 1] === '/') end -= 1;
  return path.slice(0, end);
}

/**
 * 경로를 토큰으로 파싱한다(`parse`와 같은 규칙). 오류면 undefined다.
 *
 * 원본은 `{`마다 재귀하지만 여기서는 열린 그룹을 명시 스택으로 들고 간다. 그룹이 수천 겹인 경로 한 줄도 호출 스택을
 * 넘지 않고 같은 토큰을 만든다.
 *
 * @param path 경로
 * @returns 토큰 목록 또는 undefined
 */
export function parseTokens(path: string): Token[] | undefined {
  const state: ParseState = { chars: [...path], index: 0, text: '', groups: [[]] };
  while (state.index < state.chars.length) {
    if (!consumeCharacter(state, state.chars[state.index++]!)) return undefined;
  }
  if (state.groups.length > 1) return undefined;
  writeText(state);
  return state.groups[0];
}

/**
 * 문자 하나를 읽어 토큰 상태를 갱신한다(원본 `consume` 반복의 한 단계).
 *
 * @param state 상태
 * @param value 읽은 문자
 * @returns 문법 오류면 false
 */
function consumeCharacter(state: ParseState, value: string): boolean {
  if (value === '}' && state.groups.length > 1) {
    writeText(state);
    const tokens = state.groups.pop()!;
    state.groups.at(-1)!.push({ type: 'group', tokens });
    return true;
  }
  if (value === '\\') {
    if (state.index === state.chars.length) return false;
    state.text += state.chars[state.index++]!;
    return true;
  }
  if (value === ':' || value === '*') return consumeName(state, value);
  if (value === '{') {
    writeText(state);
    state.groups.push([]);
    return true;
  }
  if ('}()[]+?!'.includes(value)) return false;
  state.text += value;
  return true;
}

/**
 * `:name`·`*name` 토큰을 읽는다.
 *
 * @param state 상태
 * @param marker `:` 또는 `*`
 * @returns 이름이 없거나 따옴표가 닫히지 않으면 false
 */
function consumeName(state: ParseState, marker: ':' | '*'): boolean {
  const name = readName(state);
  if (name === undefined) return false;
  writeText(state);
  state.groups.at(-1)!.push({ type: marker === ':' ? 'param' : 'wildcard', name });
  return true;
}

/**
 * 모은 텍스트를 지금 그룹의 텍스트 토큰으로 내보낸다.
 *
 * @param state 상태
 */
function writeText(state: ParseState): void {
  if (state.text !== '') state.groups.at(-1)!.push({ type: 'text', value: state.text });
  state.text = '';
}

/**
 * 파라미터 이름을 읽는다(식별자 또는 따옴표 이름).
 *
 * @param state 상태
 * @returns 이름 또는 undefined(이름 없음·닫히지 않은 따옴표)
 */
function readName(state: ParseState): string | undefined {
  let name = '';
  if (ID_START.test(state.chars[state.index] ?? '')) {
    do name += state.chars[state.index++]!;
    while (ID_CONTINUE.test(state.chars[state.index] ?? ''));
    return name;
  }
  if (state.chars[state.index] !== '"') return undefined;
  state.index += 1;
  while (state.index < state.chars.length) {
    const character = state.chars[state.index++]!;
    if (character === '"') return name === '' ? undefined : name;
    if (character === '\\') name += state.chars[state.index++] ?? '';
    else name += character;
  }
  return undefined;
}

/**
 * 가장 깊은 선택 그룹 중첩 수다(`{a}`는 1). 경로 길이만큼 깊을 수 있어 재귀하지 않는다.
 *
 * @param tokens 토큰 목록
 * @returns 중첩 수
 */
function groupDepth(tokens: readonly Token[]): number {
  let deepest = 0;
  const pending: { readonly tokens: readonly Token[]; readonly depth: number }[] = [{ tokens, depth: 0 }];
  for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
    deepest = Math.max(deepest, item.depth);
    for (const token of item.tokens) {
      if (token.type === 'group') pending.push({ tokens: token.tokens, depth: item.depth + 1 });
    }
  }
  return deepest;
}

/**
 * 선택 그룹을 넣은 것과 뺀 것으로 펼친다(`flatten`과 같은 순서). 조합이 상한을 넘으면 undefined다.
 *
 * 그룹이 아닌 토큰은 모든 대안 끝에 그대로 붙인다. 대안 배열은 서로 공유하지 않으므로(그룹을 펼칠 때 새로 만든다)
 * 복사하지 않고 붙여 토큰 수에 선형이다.
 *
 * @param tokens 토큰 목록
 * @returns 평평한 토큰 목록의 목록 또는 undefined
 */
function flattenGroups(tokens: readonly Token[]): Token[][] | undefined {
  let results: Token[][] = [[]];
  for (const token of tokens) {
    if (token.type !== 'group') {
      for (const result of results) result.push(token);
      continue;
    }
    const inner = flattenGroups(token.tokens);
    if (inner === undefined) return undefined;
    results = results.flatMap((result) => [...inner.map((sequence) => [...result, ...sequence]), result]);
    if (results.length > MAX_TEMPLATE_VARIANTS) return undefined;
  }
  return results;
}

/** 세그먼트 하나를 만드는 중인 조각이다. */
interface SegmentBuilder {
  prefix: string;
  suffix: string;
  hasParam: boolean;
}

/**
 * 평평한 토큰 목록 하나를 세그먼트 대안으로 만든다.
 *
 * @param tokens 평평한 토큰 목록
 * @returns 대안 또는 dynamic 이유
 */
function buildVariant(tokens: readonly Token[]): PathVariant | { readonly reason: DynamicPathReason } {
  if (tokens.length === 0) return { segments: ROOT_VARIANT.segments };
  const first = tokens[0]!;
  if (first.type !== 'text' || !first.value.startsWith('/')) return { reason: 'unsupported-syntax' };
  const segments: TemplateSegment[] = [];
  let current: SegmentBuilder | undefined;
  for (const [index, token] of tokens.entries()) {
    if (token.type === 'text') {
      token.value.split('/').forEach((part, partIndex) => {
        if (partIndex > 0) {
          if (current !== undefined) segments.push(finishSegment(current));
          current = { prefix: '', suffix: '', hasParam: false };
        }
        if (current === undefined) return;
        if (current.hasParam) current.suffix += part;
        else current.prefix += part;
      });
      continue;
    }
    if (current === undefined) return { reason: 'unsupported-syntax' };
    if (token.type === 'wildcard') {
      if (index !== tokens.length - 1 || current.prefix !== '' || current.hasParam) return { reason: 'unsupported-syntax' };
      segments.push({ kind: 'catch-all', zeroSegments: false, acceptsEmpty: false });
      current = undefined;
      continue;
    }
    if (current.hasParam) return { reason: 'multiple-parameters' };
    current.hasParam = true;
  }
  if (current !== undefined) segments.push(finishSegment(current));
  return variantOf(segments) ?? { reason: 'dot-segment' };
}

/**
 * 만드는 중인 세그먼트를 완성한다.
 *
 * @param builder 세그먼트 조각
 * @returns 세그먼트
 */
function finishSegment(builder: SegmentBuilder): TemplateSegment {
  if (!builder.hasParam) return { kind: 'literal', text: canonicalizeLiteral(builder.prefix) };
  return { kind: 'param', prefix: canonicalizeLiteral(builder.prefix), suffix: canonicalizeLiteral(builder.suffix), acceptsEmpty: false };
}

/**
 * 같은 템플릿이 된 대안을 하나로 줄인다(`{/}` 같은 그룹은 같은 모양을 두 번 만들 수 있다).
 *
 * @param variants 대안 목록
 * @returns 중복을 뺀 목록
 */
function dedupeVariants(variants: readonly PathVariant[]): PathVariant[] {
  const seen = new Map<string, PathVariant>();
  for (const variant of variants) seen.set(JSON.stringify(variant.segments), variant);
  return [...seen.values()];
}

/**
 * 옮기지 못한 경로를 dynamic으로 내고, 문법 문자가 없는 앞쪽 세그먼트를 접두사로 증명한다.
 *
 * @param path 경로
 * @param reason 이유
 * @returns dynamic 결과
 */
function dynamicWithPrefix(path: string, reason: DynamicPathReason): CompiledPath {
  const literals: TemplateSegment[] = [];
  for (const part of path.split('/').slice(1, -1)) {
    if (part === '' || /[:*{}()[\]+?!\\]/u.test(part) || part === '.' || part === '..') break;
    literals.push({ kind: 'literal', text: canonicalizeLiteral(part) });
  }
  return { kind: 'dynamic', reason, prefixes: [literals.length === 0 ? ROOT_VARIANT : { segments: literals }] };
}
