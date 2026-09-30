/**
 * Express 4 경로 문법(path-to-regexp 0.1.x)을 세그먼트 모델로 옮긴다.
 *
 * 확인한 path-to-regexp@0.1.13(express@4.22.3 의존성) `index.js` 동작:
 * - 문자열을 `/\\.|(\/)?(\.)?:(\w+)(\(.*?\))?(\*)?(\?)?|[.*]|\/\(/g`로 훑어 바꾸고, 나머지 문자는 **정규식 원문 그대로**
 *   둔다. 그래서 `?`·`+`·`(`·`[`·`^`·`$`·`|`·`{` 같은 문자가 파라미터 밖에 있으면 정규식 연산자다(dynamic).
 * - `.`은 리터럴 점, `*`는 `(.*)`(빈 값과 `/`를 포함한 모든 문자), `/(`는 비포획 그룹이다.
 * - `:name`은 `([^/]+?)`(한 글자 이상), 앞에 리터럴이 있으면 그 리터럴 뒤의 부분 세그먼트, `.:name`은 점 뒤의
 *   부분 세그먼트, `(정규식)`은 제약, `*`는 `/`를 넘는 반복(끝 catch-all), `?`는 앞 `/`까지 포함한 선택이다.
 * - `strict`가 아니면 끝에 `/?`를 붙여 끝 슬래시가 선택이 된다. `sensitive`가 아니면 `i` 플래그다.
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
import { classifyParamRegex } from './regex-constraint.ts';

/** path-to-regexp 0.1.x의 토큰 정규식이다(원본과 같다). */
const TOKEN_PATTERN = /\\.|(\/)?(\.)?:(\w+)(\(.*?\))?(\*)?(\?)?|[.*]|\/\(/gu;

/** 파라미터 밖에서 그대로 두어도 리터럴인 문자다(정규식 연산자가 아닌 문자). */
const SAFE_LITERAL = /^[A-Za-z0-9\-_~!@,;=&'%:/ ]*$/u;

/** 한 세그먼트를 만드는 중인 조각이다. */
interface SegmentBuilder {
  literal: string;
  param: { prefix: string; constraint?: TemplateSegment & { kind: 'param' } } | undefined;
  suffix: string;
}

/** 파라미터 토큰 하나다. */
interface ParameterToken {
  readonly slash: boolean;
  readonly format: boolean;
  readonly capture: string | undefined;
  readonly star: boolean;
  readonly optional: boolean;
}

/** 토큰으로 나눈 경로 조각이다. */
type Piece = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'param'; readonly token: ParameterToken } | { readonly kind: 'star' };

/**
 * Express 4 경로 하나를 컴파일한다.
 *
 * @param path 경로 문자열
 * @param strict 라우터의 strict 옵션(끝 슬래시 선택 여부)
 * @returns 컴파일 결과
 */
export function compileExpress4Path(path: string, strict: boolean): CompiledPath {
  if (path === '*') return variantsResult([{ segments: [{ kind: 'catch-all', zeroSegments: true, acceptsEmpty: false }] }]);
  if (!path.startsWith('/')) return { kind: 'dynamic', reason: 'unsupported-syntax', prefixes: undefined };
  const pieces = tokenize(path);
  if (pieces === undefined) return dynamicWithPrefix(path, 'unsupported-syntax');
  const trimmed = strict ? pieces : trimTrailingSlash(pieces);
  const variants = expandOptional(trimmed);
  if (variants === undefined) return dynamicWithPrefix(path, 'expansion-capped');
  const compiled: PathVariant[] = [];
  for (const variant of variants) {
    const result = buildVariant(variant);
    if (!('segments' in result)) return dynamicWithPrefix(path, result.reason);
    compiled.push(result);
  }
  return variantsResult(compiled);
}

/**
 * 경로를 토큰 조각으로 나눈다. 파라미터 밖에 정규식 연산자가 있으면 undefined다.
 *
 * @param path 경로
 * @returns 조각 목록 또는 undefined
 */
function tokenize(path: string): Piece[] | undefined {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of path.matchAll(TOKEN_PATTERN)) {
    const text = path.slice(last, match.index);
    if (!SAFE_LITERAL.test(text)) return undefined;
    if (text !== '') pieces.push({ kind: 'text', text });
    last = match.index + match[0].length;
    const piece = tokenPiece(match);
    if (piece === undefined) return undefined;
    pieces.push(piece);
  }
  const rest = path.slice(last);
  if (!SAFE_LITERAL.test(rest)) return undefined;
  if (rest !== '') pieces.push({ kind: 'text', text: rest });
  return mergeText(pieces);
}

/**
 * 정규식 일치 하나를 조각으로 만든다.
 *
 * @param match 토큰 일치
 * @returns 조각 또는 undefined(비포획 그룹 `/(`)
 */
function tokenPiece(match: RegExpMatchArray): Piece | undefined {
  const token = match[0];
  if (token.startsWith('\\')) return /[A-Za-z0-9]/u.test(token[1]!) ? undefined : { kind: 'text', text: token[1]! };
  if (token === '.') return { kind: 'text', text: '.' };
  if (token === '*') return { kind: 'star' };
  if (token === '/(') return undefined;
  return {
    kind: 'param',
    token: { slash: match[1] !== undefined, format: match[2] !== undefined, capture: match[4], star: match[5] !== undefined, optional: match[6] !== undefined },
  };
}

/**
 * 붙은 텍스트 조각을 하나로 합친다.
 *
 * @param pieces 조각 목록
 * @returns 합친 목록
 */
function mergeText(pieces: readonly Piece[]): Piece[] {
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const previous = merged.at(-1);
    if (piece.kind === 'text' && previous?.kind === 'text') merged[merged.length - 1] = { kind: 'text', text: previous.text + piece.text };
    else merged.push(piece);
  }
  return merged;
}

/**
 * strict가 아닐 때 끝 슬래시 하나를 뗀다(`/users/`는 `/users`와 `/users/` 모두와 맞는다). 루트는 그대로다.
 *
 * @param pieces 조각 목록
 * @returns 끝 슬래시를 뗀 목록
 */
function trimTrailingSlash(pieces: readonly Piece[]): Piece[] {
  const last = pieces.at(-1);
  if (last?.kind !== 'text' || !last.text.endsWith('/') || (pieces.length === 1 && last.text === '/')) return [...pieces];
  const text = last.text.slice(0, -1);
  return text === '' ? pieces.slice(0, -1) : [...pieces.slice(0, -1), { kind: 'text', text }];
}

/**
 * 선택 파라미터(`/:x?`)를 넣은 것과 뺀 것으로 펼친다. 조합이 상한을 넘으면 undefined다.
 *
 * @param pieces 조각 목록
 * @returns 조각 목록의 목록 또는 undefined
 */
function expandOptional(pieces: readonly Piece[]): Piece[][] | undefined {
  let results: Piece[][] = [[]];
  for (const piece of pieces) {
    const isOptionalSegment = piece.kind === 'param' && piece.token.optional && !piece.token.star;
    results = results.flatMap((result) => (isOptionalSegment ? [[...result, piece], result] : [[...result, piece]]));
    if (results.length > MAX_TEMPLATE_VARIANTS) return undefined;
  }
  return results;
}

/** 세그먼트 조립용으로 편 항목이다: 구분자 `/`, 리터럴 문자열, 파라미터, `*`. */
type Item = { readonly kind: 'separator' } | { readonly kind: 'text'; readonly text: string } | { readonly kind: 'param'; readonly token: ParameterToken } | { readonly kind: 'star' };

/**
 * 조각을 구분자·텍스트 항목으로 편다. 파라미터의 앞 `/`는 구분자 항목으로 뺀다.
 *
 * @param pieces 조각 목록
 * @returns 항목 목록
 */
function toItems(pieces: readonly Piece[]): Item[] {
  const items: Item[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'text') {
      piece.text.split('/').forEach((part, index) => {
        if (index > 0) items.push({ kind: 'separator' });
        if (part !== '') items.push({ kind: 'text', text: part });
      });
    } else if (piece.kind === 'param' && piece.token.slash) {
      items.push({ kind: 'separator' }, piece);
    } else {
      items.push(piece);
    }
  }
  return items;
}

/**
 * 조각 목록 하나를 세그먼트 대안으로 만든다. 경로는 `/`로 시작하므로 첫 항목은 구분자다.
 *
 * @param pieces 조각 목록(선택 파라미터를 펼친 뒤)
 * @returns 대안 또는 dynamic 이유
 */
function buildVariant(pieces: readonly Piece[]): PathVariant | { readonly reason: DynamicPathReason } {
  const segments: TemplateSegment[] = [];
  const items = toItems(pieces);
  let current: SegmentBuilder | undefined;
  for (const [index, item] of items.entries()) {
    const isLast = index === items.length - 1;
    if (item.kind === 'separator') {
      if (current !== undefined) segments.push(finishSegment(current));
      current = { literal: '', param: undefined, suffix: '' };
      continue;
    }
    if (current === undefined) return { reason: 'unsupported-syntax' };
    if (item.kind === 'text') {
      if (current.param === undefined) current.literal += item.text;
      else current.suffix += item.text;
      continue;
    }
    const tail = item.kind === 'star' ? starSegment(current, isLast) : applyParameter(item.token, isLast, current);
    if (typeof tail === 'string') return { reason: tail };
    if (tail !== undefined) {
      segments.push(tail);
      current = undefined;
    }
  }
  if (current !== undefined) segments.push(finishSegment(current));
  return variantOf(segments.length === 0 ? ROOT_VARIANT.segments : segments) ?? { reason: 'dot-segment' };
}

/**
 * `*`(`(.*)`)가 온전한 끝 세그먼트일 때만 빈 값도 받는 catch-all로 받는다.
 *
 * @param current 만드는 중인 세그먼트
 * @param isLast 마지막 항목인지
 * @returns catch-all 세그먼트 또는 문제 이유
 */
function starSegment(current: SegmentBuilder, isLast: boolean): TemplateSegment | DynamicPathReason {
  if (!isLast || current.literal !== '' || current.param !== undefined) return 'unsupported-syntax';
  return { kind: 'catch-all', zeroSegments: false, acceptsEmpty: true };
}

/**
 * 파라미터 토큰 하나를 만드는 중인 세그먼트에 적용한다.
 *
 * @param token 토큰
 * @param isLast 마지막 항목인지
 * @param current 만드는 중인 세그먼트(갱신)
 * @returns 끝 catch-all 세그먼트, 문제 이유, 또는 undefined(세그먼트에 파라미터를 넣음)
 */
function applyParameter(token: ParameterToken, isLast: boolean, current: SegmentBuilder): TemplateSegment | DynamicPathReason | undefined {
  if (current.param !== undefined) return 'multiple-parameters';
  if (token.star) {
    // `:name*`는 `/`를 넘는 한 번 이상 반복, `:name*?`는 앞 `/`까지 선택이라 0세그먼트도 받는다.
    if (!isLast || !token.slash || token.capture !== undefined || current.literal !== '') return 'unsupported-syntax';
    return { kind: 'catch-all', zeroSegments: token.optional, acceptsEmpty: false };
  }
  const constraint = constraintOf(token.capture);
  if (constraint === 'dynamic') return 'regex';
  current.param = { prefix: token.format ? `${current.literal}.` : current.literal, ...(constraint === undefined ? {} : { constraint }) };
  return undefined;
}

/**
 * 파라미터 정규식을 제약으로 바꾼다.
 *
 * @param capture `(정규식)` 원문 또는 undefined
 * @returns 제약 세그먼트, 제약 없음(undefined), 또는 옮길 수 없음('dynamic')
 */
function constraintOf(capture: string | undefined): (TemplateSegment & { kind: 'param' }) | undefined | 'dynamic' {
  if (capture === undefined) return undefined;
  const regex = classifyParamRegex(capture.slice(1, -1));
  if (regex.kind !== 'segment' || regex.acceptsEmpty) return 'dynamic';
  return { kind: 'param', prefix: '', suffix: '', acceptsEmpty: false, constraint: regex.constraint };
}

/**
 * 만드는 중인 세그먼트를 완성한다.
 *
 * @param builder 세그먼트 조각
 * @returns 세그먼트
 */
function finishSegment(builder: SegmentBuilder): TemplateSegment {
  if (builder.param === undefined) return { kind: 'literal', text: canonicalizeLiteral(builder.literal) };
  const constraint = builder.param.constraint?.constraint;
  return {
    kind: 'param',
    prefix: canonicalizeLiteral(builder.param.prefix),
    suffix: canonicalizeLiteral(builder.suffix),
    acceptsEmpty: false,
    ...(constraint === undefined ? {} : { constraint }),
  };
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
    if (part === '' || !/^[A-Za-z0-9\-_~!@,;=&'%]+$/u.test(part) || part === '.' || part === '..') break;
    literals.push({ kind: 'literal', text: canonicalizeLiteral(part) });
  }
  return { kind: 'dynamic', reason, prefixes: [literals.length === 0 ? ROOT_VARIANT : { segments: literals }] };
}
