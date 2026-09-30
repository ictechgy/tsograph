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
