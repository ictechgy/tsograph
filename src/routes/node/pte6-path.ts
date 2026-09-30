/**
 * path-to-regexp 6 문법(@koa/router·koa-router 12–13)을 세그먼트 모델로 옮긴다.
 *
 * 확인한 path-to-regexp@6.3.0 `dist/index.js` 동작:
 * - 토큰은 문자, 이스케이프, `:name`(`[A-Za-z0-9_]+`), `(패턴)`, 수정자 `*`·`+`·`?`, 그룹 `{…}`이다. 수정자가
 *   파라미터 뒤가 아니면 `TypeError`다(앱이 시작하지 않는다).
 * - 파라미터 앞 문자가 `.`·`/`이면 접두사로 붙는다. 기본 패턴은 `[^\/#\?]+?`(한 글자 이상)다. `/:x?`는 앞 `/`까지 선택,
 *   `/:x*`·`/:x+`는 `/`로 이은 0회·1회 이상 반복이다.
 * - `strict`가 아니면 끝에 `[\/#\?]?`를 붙인다. 경로가 `/`로 끝나지 않으면 끝 슬래시가 선택이고, `/`로 끝나면 그 슬래시가
 *   필요하다(`/users/`는 `/users`와 맞지 않는다). `sensitive`가 아니면 `i` 플래그다.
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

/** 파싱한 조각이다: 텍스트 또는 파라미터. */
type Piece =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'param'; readonly prefix: string; readonly pattern: string | undefined; readonly modifier: string };

/**
 * path-to-regexp 6 경로 하나를 컴파일한다.
 *
 * @param path 경로 문자열
 * @returns 컴파일 결과
 */
export function compilePte6Path(path: string): CompiledPath {
  const pieces = parsePieces(path);
  if (pieces === undefined || !path.startsWith('/')) return dynamicWithPrefix(path, 'unsupported-syntax');
  const expanded = expandOptional(pieces);
  if (expanded === undefined) return dynamicWithPrefix(path, 'expansion-capped');
  const variants: PathVariant[] = [];
  for (const sequence of expanded) {
    const variant = buildVariant(sequence);
    if (!('segments' in variant)) return dynamicWithPrefix(path, variant.reason);
    variants.push(variant);
  }
  return variantsResult(variants);
}

/**
 * 경로를 조각으로 파싱한다(`lexer`+`parse`와 같은 규칙). 그룹이나 문법 오류는 undefined다.
 *
 * @param path 경로
 * @returns 조각 목록 또는 undefined
 */
function parsePieces(path: string): Piece[] | undefined {
  const pieces: Piece[] = [];
  let text = '';
  let index = 0;
  while (index < path.length) {
    const character = path[index]!;
    if (character === '\\') {
      text += path[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (character === ':' || character === '(') {
      const parsed = readParameter(path, index);
      if (parsed === undefined) return undefined;
      const prefix = text.endsWith('/') || text.endsWith('.') ? text.slice(-1) : '';
      const before = prefix === '' ? text : text.slice(0, -1);
      if (before !== '') pieces.push({ kind: 'text', text: before });
      text = '';
      pieces.push({ kind: 'param', prefix, pattern: parsed.pattern, modifier: parsed.modifier });
      index = parsed.end;
      continue;
    }
    if ('*+?{}'.includes(character)) return undefined;
    text += character;
    index += 1;
  }
  if (text !== '') pieces.push({ kind: 'text', text });
  return pieces;
}

/**
 * `:name`·`(패턴)`과 뒤따르는 수정자를 읽는다.
 *
 * @param path 경로
 * @param start 시작 위치
 * @returns 패턴·수정자·끝 위치 또는 undefined
 */
function readParameter(path: string, start: number): { pattern: string | undefined; modifier: string; end: number } | undefined {
  let index = start;
  if (path[index] === ':') {
    const name = /^[A-Za-z0-9_]+/u.exec(path.slice(index + 1));
    if (name === null) return undefined;
    index += 1 + name[0].length;
  }
  let pattern: string | undefined;
  if (path[index] === '(') {
    const end = closingParenthesis(path, index);
    if (end === undefined) return undefined;
    pattern = path.slice(index + 1, end);
    index = end + 1;
  }
  const modifier = '*+?'.includes(path[index] ?? '\u0000') ? path[index]! : '';
  return { pattern, modifier, end: index + modifier.length };
}

/**
 * `(`에 맞는 `)` 위치를 찾는다. 포획 그룹이 안에 있으면 path-to-regexp 6이 거부한다.
 *
 * @param path 경로
 * @param start `(` 위치
 * @returns `)` 위치 또는 undefined
 */
function closingParenthesis(path: string, start: number): number | undefined {
  let depth = 1;
  for (let index = start + 1; index < path.length; index++) {
    const character = path[index]!;
    if (character === '\\') index += 1;
    else if (character === '(' && path[index + 1] !== '?') return undefined;
    else if (character === '(') depth += 1;
    else if (character === ')' && --depth === 0) return index > start + 1 ? index : undefined;
  }
  return undefined;
}

/**
 * `?` 수정자 파라미터를 넣은 것과 뺀 것으로 펼친다.
 *
 * @param pieces 조각 목록
 * @returns 조각 목록의 목록 또는 undefined(상한 초과)
 */
function expandOptional(pieces: readonly Piece[]): Piece[][] | undefined {
  let results: Piece[][] = [[]];
  for (const piece of pieces) {
    const isOptional = piece.kind === 'param' && piece.modifier === '?';
    results = results.flatMap((result) => (isOptional ? [[...result, { ...piece, modifier: '' }], result] : [[...result, piece]]));
    if (results.length > MAX_TEMPLATE_VARIANTS) return undefined;
  }
  return results;
}

/** 세그먼트 하나를 만드는 중인 조각이다. */
interface SegmentBuilder {
  prefix: string;
  suffix: string;
  param: TemplateSegment | undefined;
}

/**
 * 조각 목록 하나를 대안으로 만든다.
 *
 * @param pieces 조각 목록
 * @returns 대안 또는 dynamic 이유
 */
function buildVariant(pieces: readonly Piece[]): PathVariant | { readonly reason: DynamicPathReason } {
  const segments: TemplateSegment[] = [];
  let current: SegmentBuilder | undefined;
  const openSegment = (): void => {
    if (current !== undefined) segments.push(finishSegment(current));
    current = { prefix: '', suffix: '', param: undefined };
  };
  for (const [index, piece] of pieces.entries()) {
    if (piece.kind === 'text') {
      piece.text.split('/').forEach((part, partIndex) => {
        if (partIndex > 0) openSegment();
        if (current === undefined) return;
        if (current.param === undefined) current.prefix += part;
        else current.suffix += part;
      });
      continue;
    }
    if (piece.prefix === '/') openSegment();
    if (current === undefined) return { reason: 'unsupported-syntax' };
    if (piece.modifier === '*' || piece.modifier === '+') {
      if (index !== pieces.length - 1 || piece.prefix !== '/' || piece.pattern !== undefined) return { reason: 'unsupported-syntax' };
      segments.push({ kind: 'catch-all', zeroSegments: piece.modifier === '*', acceptsEmpty: false });
      current = undefined;
      continue;
    }
    if (current.param !== undefined) return { reason: 'multiple-parameters' };
    const param = parameterSegment(piece.pattern);
    if (param === undefined) return { reason: 'regex' };
    if (piece.prefix === '.') current.prefix += '.';
    current.param = param;
  }
  if (current !== undefined) segments.push(finishSegment(current));
  return variantOf(segments.length === 0 ? ROOT_VARIANT.segments : segments) ?? { reason: 'dot-segment' };
}

/**
 * 파라미터 패턴을 세그먼트로 만든다. 기본 패턴은 제약 없는 파라미터다.
 *
 * @param pattern 패턴 원문 또는 undefined
 * @returns 파라미터 세그먼트 또는 undefined(옮길 수 없는 정규식)
 */
function parameterSegment(pattern: string | undefined): TemplateSegment | undefined {
  if (pattern === undefined) return { kind: 'param', prefix: '', suffix: '', acceptsEmpty: false };
  const regex = classifyParamRegex(pattern);
  if (regex.kind !== 'segment' || regex.acceptsEmpty) return undefined;
  return { kind: 'param', prefix: '', suffix: '', acceptsEmpty: false, constraint: regex.constraint };
}

/**
 * 만드는 중인 세그먼트를 완성한다.
 *
 * @param builder 세그먼트 조각
 * @returns 세그먼트
 */
function finishSegment(builder: SegmentBuilder): TemplateSegment {
  if (builder.param === undefined || builder.param.kind !== 'param') return { kind: 'literal', text: canonicalizeLiteral(builder.prefix) };
  return { ...builder.param, prefix: canonicalizeLiteral(builder.prefix), suffix: canonicalizeLiteral(builder.suffix) };
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
    if (part === '' || /[:*+?{}()\\]/u.test(part) || part === '.' || part === '..') break;
    literals.push({ kind: 'literal', text: canonicalizeLiteral(part) });
  }
  return { kind: 'dynamic', reason, prefixes: [literals.length === 0 ? ROOT_VARIANT : { segments: literals }] };
}
