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
}

/**
 * path-to-regexp 8 경로 하나를 컴파일한다.
 *
 * @param path 경로 문자열
 * @param loosen 끝 슬래시를 떼는지(Express router의 non-strict `loosen`). @koa/router는 떼지 않는다.
 * @returns 컴파일 결과
 */
export function compilePte8Path(path: string, loosen: boolean): CompiledPath {
  const loosened = !loosen || path === '/' ? path : path.replace(/\/+$/u, '');
  const tokens = parseTokens(loosened);
  if (tokens === undefined) return dynamicWithPrefix(loosened, 'unsupported-syntax');
  const sequences = flattenGroups(tokens);
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
 * 경로를 토큰으로 파싱한다(`parse`와 같은 규칙). 오류면 undefined다.
 *
 * @param path 경로
 * @returns 토큰 목록 또는 undefined
 */
export function parseTokens(path: string): Token[] | undefined {
  const state: ParseState = { chars: [...path], index: 0 };
  return consumeUntil(state, '');
}

/**
 * 끝 문자까지 토큰을 읽는다.
 *
 * @param state 상태
 * @param end 끝 문자(`''`는 문자열 끝)
 * @returns 토큰 목록 또는 undefined
 */
function consumeUntil(state: ParseState, end: string): Token[] | undefined {
  const output: Token[] = [];
  let text = '';
  const writeText = (): void => {
    if (text !== '') output.push({ type: 'text', value: text });
    text = '';
  };
  while (state.index < state.chars.length) {
    const value = state.chars[state.index++]!;
    if (value === end) {
      writeText();
      return output;
    }
    if (value === '\\') {
      if (state.index === state.chars.length) return undefined;
      text += state.chars[state.index++]!;
      continue;
    }
    if (value === ':' || value === '*') {
      const name = readName(state);
      if (name === undefined) return undefined;
      writeText();
      output.push({ type: value === ':' ? 'param' : 'wildcard', name });
      continue;
    }
    if (value === '{') {
      writeText();
      const tokens = consumeUntil(state, '}');
      if (tokens === undefined) return undefined;
      output.push({ type: 'group', tokens });
      continue;
    }
    if ('}()[]+?!'.includes(value)) return undefined;
    text += value;
  }
  if (end !== '') return undefined;
  writeText();
  return output;
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
 * 선택 그룹을 넣은 것과 뺀 것으로 펼친다(`flatten`과 같은 순서). 조합이 상한을 넘으면 undefined다.
 *
 * @param tokens 토큰 목록
 * @returns 평평한 토큰 목록의 목록 또는 undefined
 */
function flattenGroups(tokens: readonly Token[]): Token[][] | undefined {
  let results: Token[][] = [[]];
  for (const token of tokens) {
    if (token.type !== 'group') {
      results = results.map((result) => [...result, token]);
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
