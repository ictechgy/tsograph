/**
 * Hono 4 라우트 경로 문법을 세그먼트 모델로 옮긴다.
 *
 * 확인한 hono@4.13.12 동작(`dist/utils/url.js`, `dist/router/reg-exp-router/*`, `dist/router/trie-router/node.js`,
 * `dist/hono-base.js`, 오라클 실행으로 재확인):
 * - 경로는 `mergePath(basePath, path)`로 먼저 합친다(`mergePath('/api', '/')`는 `/api`, `mergePath('/api', '')`는 `/api/`).
 * - `:`로 시작하는 세그먼트 전체가 파라미터다(`/:id.json`도 이름이 `id.json`인 파라미터). `:name{정규식}`은 정규식
 *   제약이다. 세그먼트 중간의 `:`(`/file-:id`)는 리터럴이다(RegExpRouter는 `/:`가 없으면 정적 경로로, TrieRouter는
 *   `:`로 시작하지 않는 조각을 리터럴로 본다). 다른 파라미터와 섞이면 두 라우터가 달라 dynamic으로 낸다.
 * - 파라미터는 빈 세그먼트와 맞지 않는다(TrieRouter `if (!part && matcher === true) continue`, RegExpRouter `[^/]+`).
 * - 끝 `?`가 있고 `:`를 포함하면 `checkOptionalParameter`가 경로를 여러 개로 펼친다.
 * - 끝 `/*`는 그 앞 경로 자체, 끝 슬래시, 아래 전부와 맞는다(RegExpRouter `(?:|/.*)`, TrieRouter `*` 자식). `*`·`/*`
 *   하나는 모든 경로다. 세그먼트 중간·부분의 `*`는 두 라우터의 빈 세그먼트 처리가 달라 dynamic이다.
 * - 대소문자를 구분한다. 요청 경로는 `%XX`를 디코드한 뒤 비교한다.
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

/** 세그먼트 하나의 변환 결과다. */
type SegmentResult = TemplateSegment | { readonly kind: 'dynamic'; readonly reason: DynamicPathReason };

/**
 * Hono `mergePath`를 그대로 옮긴다.
 *
 * @param base 기준 경로
 * @param sub 붙일 경로
 * @returns 합친 경로
 */
export function honoMergePath(base: string, sub: string): string {
  const lead = base.startsWith('/') ? '' : '/';
  if (sub === '/') return `${lead}${base}`;
  const separator = base.endsWith('/') ? '' : '/';
  return `${lead}${base}${separator}${sub.startsWith('/') ? sub.slice(1) : sub}`;
}

/**
 * 합친 Hono 경로를 컴파일한다.
 *
 * @param path `mergePath`를 거친 경로
 * @returns 컴파일 결과
 */
export function compileHonoPath(path: string): CompiledPath {
  if (path === '*' || path === '/*') return variantsResult([{ segments: [{ kind: 'catch-all', zeroSegments: true, acceptsEmpty: false }] }]);
  if (path.endsWith('/*')) return compileTailWildcard(path.slice(0, -2));
  if (path.endsWith('*')) return dynamicWithPrefix(path, 'unsupported-syntax');
  const optional = optionalPathEnds(path);
  if (optional !== undefined && optional.ends.length > MAX_TEMPLATE_VARIANTS) return compileManyOptionalPaths(optional);
  const expanded = honoOptionalPaths(path);
  const variants: PathVariant[] = [];
  for (const candidate of expanded) {
    const compiled = compileSegments(candidate);
    if (!('segments' in compiled)) return dynamicWithPrefix(candidate, compiled.reason);
    variants.push(compiled);
  }
  return variantsResult(variants);
}

/**
 * 끝 `/*` 경로를 컴파일한다. 앞 경로는 리터럴 세그먼트만 받는다(파라미터가 섞인 와일드카드는 두 라우터 동작을
 * 확인하지 않았다).
 *
 * @param head `/*` 앞 경로
 * @returns 컴파일 결과
 */
function compileTailWildcard(head: string): CompiledPath {
  const compiled = compileSegments(head === '' ? '/' : head);
  if (!('segments' in compiled) || compiled.segments.some((segment) => segment.kind !== 'literal')) {
    return dynamicWithPrefix(head, 'unsupported-syntax');
  }
  const base = compiled.segments.length === 1 && compiled.segments[0]!.kind === 'literal' && compiled.segments[0]!.text === '' ? [] : compiled.segments;
  return variantsResult([{ segments: [...base, { kind: 'catch-all', zeroSegments: true, acceptsEmpty: true }] }]);
}

/**
 * Hono `checkOptionalParameter`를 그대로 옮긴다. 끝이 `?`가 아니거나 `:`가 없으면 경로 하나다.
 *
 * @param path 경로
 * @returns 펼친 경로 목록
 */
export function honoOptionalPaths(path: string): string[] {
  if (!path.endsWith('?') || !path.includes(':')) return [path];
  const results: string[] = [];
  let basePath = '';
  for (const segment of path.split('/')) {
    if (segment !== '' && !segment.includes(':')) {
      basePath += `/${segment}`;
    } else if (segment.includes(':')) {
      if (segment.endsWith('?')) {
        results.push(results.length === 0 && basePath === '' ? '/' : basePath);
        basePath += `/${segment.slice(0, -1)}`;
        results.push(basePath);
      } else {
        basePath += `/${segment}`;
      }
    }
  }
  return [...new Set(results)];
}

/** 선택 파라미터로 펼칠 경로들을 문자열 없이 나타낸 것이다. 펼칠 경로는 모두 `full`의 접두사다. */
interface OptionalPathEnds {
  /** 선택 세그먼트의 `?`를 뗀 전체 경로(`checkOptionalParameter`가 마지막에 쌓은 basePath) */
  readonly full: string;
  /** {@link honoOptionalPaths}가 낼 경로마다 `full` 안의 끝 위치(중복을 뺀 오름차순) */
  readonly ends: readonly number[];
}

/**
 * {@link honoOptionalPaths}와 같은 규칙으로 펼칠 경로를 세되, 경로마다 문자열을 만들지 않고 끝 위치만 모은다. 원본은
 * 선택 세그먼트마다 그때까지의 접두사 전체를 새 문자열로 만들어 세그먼트 n개에 O(n²) 문자를 쓴다. 펼친 경로는 앞
 * 경로를 늘려 가며 만들므로 모두 마지막 경로의 접두사이고, 같은 문자열은 이웃해서만 생긴다.
 *
 * @param path 경로
 * @returns 끝 위치, 선택 파라미터를 펼치지 않는 경로면 undefined
 */
function optionalPathEnds(path: string): OptionalPathEnds | undefined {
  if (!path.endsWith('?') || !path.includes(':')) return undefined;
  const kept: string[] = [];
  const ends: number[] = [];
  let length = 0;
  const mark = (end: number): void => {
    if (ends.at(-1) !== end) ends.push(end);
  };
  for (const segment of path.split('/').filter((part) => part !== '')) {
    const optional = segment.includes(':') && segment.endsWith('?');
    if (optional) mark(ends.length === 0 && length === 0 ? 1 : length);
    const text = optional ? segment.slice(0, -1) : segment;
    kept.push(text);
    length += 1 + text.length;
    if (optional) mark(length);
  }
  return { full: `/${kept.join('/')}`, ends };
}

/**
 * 펼칠 경로가 템플릿 상한보다 많을 때의 결과를 경로마다 문자열을 만들지 않고 전체 경로를 한 번 훑어 구한다. 경로를
 * 앞에서부터 하나씩 {@link compileSegments}로 컴파일한 것과 같다: 처음 실패하는 경로가 있으면 그 경로의 dynamic이고,
 * 모두 컴파일되면 대안이 상한을 넘으므로 접두사 없는 `expansion-capped`다(`variantsResult`와 같은 값).
 *
 * @param optional 펼칠 경로의 끝 위치
 * @returns 컴파일 결과
 */
function compileManyOptionalPaths({ full, ends }: OptionalPathEnds): CompiledPath {
  const scan: PrefixScan = { depth: 0, start: 1, failure: undefined, hasDot: false };
  let position = 1;
  for (const end of ends) {
    for (; position < end; position += 1) {
      if (!advanceScan(scan, full, position)) return dynamicWithPrefix(full.slice(0, end), 'unsupported-syntax');
    }
    const reason = prefixFailure(scan, full.slice(scan.start, end));
    if (reason !== undefined) return dynamicWithPrefix(full.slice(0, end), reason);
  }
  return { kind: 'dynamic', reason: 'expansion-capped', prefixes: undefined };
}

/**
 * 공통 전체 경로를 앞에서부터 훑는 상태다. 접두사마다 {@link splitRoutingPath}와 세그먼트 변환을 다시 하지 않도록,
 * 끝난 세그먼트의 판정을 이어서 들고 간다.
 */
interface PrefixScan {
  /** 지금까지의 중괄호 깊이 */
  depth: number;
  /** 지금 세그먼트의 시작 위치 */
  start: number;
  /** 끝난(마지막이 아닌) 세그먼트 중 처음 변환에 실패한 이유 */
  failure: DynamicPathReason | undefined;
  /** 끝난 세그먼트 중 점 세그먼트가 있었는지 */
  hasDot: boolean;
}

/**
 * 공통 전체 경로의 한 글자를 읽어 상태를 갱신한다. 중괄호 밖 `/`에서 끝난 세그먼트는 마지막이 아닌 세그먼트로
 * 변환한다(그 뒤에서 끝나는 경로에서는 늘 마지막이 아니다).
 *
 * @param scan 상태
 * @param full 전체 경로
 * @param position 읽을 위치
 * @returns 닫는 중괄호가 짝보다 많아지면 false(이 위치를 포함하는 경로는 모두 {@link splitRoutingPath}가 거부한다)
 */
function advanceScan(scan: PrefixScan, full: string, position: number): boolean {
  const character = full[position];
  if (character === '{') scan.depth += 1;
  if (character === '}') scan.depth -= 1;
  if (scan.depth < 0) return false;
  if (character === '/' && scan.depth === 0) {
    const converted = convertSegment(full.slice(scan.start, position), false);
    if (converted.kind === 'dynamic') scan.failure ??= converted.reason;
    else if (variantOf([converted]) === undefined) scan.hasDot = true;
    scan.start = position + 1;
  }
  return true;
}

/**
 * 지금 위치에서 끝나는 경로가 컴파일되지 않는 이유다. {@link compileSegments}와 같은 순서로 본다: 중괄호 짝, 앞
 * 세그먼트부터의 변환, 점 세그먼트.
 *
 * @param scan 상태
 * @param last 마지막 세그먼트 원문
 * @returns 실패 이유, 컴파일되면 undefined
 */
function prefixFailure(scan: PrefixScan, last: string): DynamicPathReason | undefined {
  if (scan.depth !== 0) return 'unsupported-syntax';
  if (scan.failure !== undefined) return scan.failure;
  const converted = convertSegment(last, true);
  if (converted.kind === 'dynamic') return converted.reason;
  return scan.hasDot || variantOf([converted]) === undefined ? 'dot-segment' : undefined;
}

/**
 * 경로 하나를 세그먼트로 나눠 변환한다. `{…}` 안의 `/`로는 나누지 않는다(`splitRoutingPath`).
 *
 * @param path 경로
 * @returns 대안 또는 dynamic 이유
 */
function compileSegments(path: string): PathVariant | { readonly reason: DynamicPathReason } {
  if (!path.startsWith('/')) return { reason: 'unsupported-syntax' };
  const parts = splitRoutingPath(path);
  if (parts === undefined) return { reason: 'unsupported-syntax' };
  const segments: TemplateSegment[] = [];
  for (const [index, part] of parts.entries()) {
    const converted = convertSegment(part, index === parts.length - 1);
    if (converted.kind === 'dynamic') return { reason: converted.reason };
    segments.push(converted);
  }
  return variantOf(segments) ?? { reason: 'dot-segment' };
}

/**
 * 경로를 `/`로 나누되 `{…}` 그룹은 한 덩어리로 둔다. 루트 `/`는 빈 세그먼트 하나다.
 *
 * @param path `/`로 시작하는 경로
 * @returns 세그먼트 목록 또는 undefined(짝이 맞지 않는 중괄호)
 */
function splitRoutingPath(path: string): string[] | undefined {
  const parts: string[] = [''];
  let depth = 0;
  for (const character of path.slice(1)) {
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth < 0) return undefined;
    if (character === '/' && depth === 0) parts.push('');
    else parts[parts.length - 1] += character;
  }
  return depth === 0 ? parts : undefined;
}

/**
 * 세그먼트 하나를 변환한다.
 *
 * @param part 세그먼트 원문
 * @param isLast 마지막 세그먼트인지
 * @returns 세그먼트 또는 dynamic
 */
function convertSegment(part: string, isLast: boolean): SegmentResult {
  if (part.startsWith(':')) return convertParameter(part, isLast);
  if (/[:{}*]/u.test(part)) return { kind: 'dynamic', reason: 'unsupported-syntax' };
  return { kind: 'literal', text: canonicalizeLiteral(part) };
}

/**
 * `:name`·`:name{정규식}` 세그먼트를 변환한다.
 *
 * @param part 세그먼트 원문
 * @param isLast 마지막 세그먼트인지
 * @returns 세그먼트 또는 dynamic
 */
function convertParameter(part: string, isLast: boolean): SegmentResult {
  const match = /^:([^{}]+)(?:\{(.+)\})?$/u.exec(part);
  if (match === null) return { kind: 'dynamic', reason: 'unsupported-syntax' };
  if (match[2] === undefined) return { kind: 'param', prefix: '', suffix: '', acceptsEmpty: false };
  const regex = classifyParamRegex(match[2]);
  if (regex.kind === 'rest' && isLast) return { kind: 'catch-all', zeroSegments: false, acceptsEmpty: false };
  if (regex.kind !== 'segment' || regex.acceptsEmpty) return { kind: 'dynamic', reason: 'regex' };
  return { kind: 'param', prefix: '', suffix: '', acceptsEmpty: false, constraint: regex.constraint };
}

/**
 * 옮기지 못한 경로를 dynamic으로 내고, 앞쪽의 온전한 리터럴 세그먼트를 접두사로 증명한다.
 *
 * @param path 경로 원문
 * @param reason 이유
 * @returns dynamic 결과
 */
function dynamicWithPrefix(path: string, reason: DynamicPathReason): CompiledPath {
  return { kind: 'dynamic', reason, prefixes: [literalPrefix(path)] };
}

/**
 * 경로 앞쪽에서 `:`·`*`·`{`가 없는 온전한 세그먼트만 모은 접두사 대안이다. 마지막 조각은 뒤에 문법이 이어질 수
 * 있어 쓰지 않는다.
 *
 * @param path 경로 원문
 * @returns 접두사 대안
 */
export function literalPrefix(path: string): PathVariant {
  const parts = path.split('/').slice(1, -1);
  const literals: TemplateSegment[] = [];
  for (const part of parts) {
    if (part === '' || /[:{}*?]/u.test(part) || part === '.' || part === '..') break;
    literals.push({ kind: 'literal', text: canonicalizeLiteral(part) });
  }
  return literals.length === 0 ? ROOT_VARIANT : { segments: literals };
}
