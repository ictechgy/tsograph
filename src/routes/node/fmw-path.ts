/**
 * find-my-way 경로 문법(Fastify 4·5, NestJS Fastify 어댑터)을 세그먼트 모델로 옮긴다.
 *
 * 확인한 find-my-way@8.2.2·9.9.0 `index.js`·`lib/node.js` 동작(오라클 실행으로 재확인):
 * - 끝 선택 파라미터 `/:x?`는 `/:x` 경로와 앞 경로(비면 `/`) 두 개로 등록한다. 끝이 아니면 오류다.
 * - `ignoreTrailingSlash`면 등록·조회 양쪽에서 끝 슬래시 하나를 떼고, `ignoreDuplicateSlashes`면 중복 슬래시를 줄인다.
 * - `::`는 리터럴 `:`다. `:name` 파라미터는 `/`·`(`·`-`·`.`에서 끝나고, 한 세그먼트에 파라미터가 여럿이거나 정적
 *   조각이 섞이면 정규식 노드가 된다. 제약 없는 파라미터는 빈 문자열도 받는다(`/users/`가 `/users/:id`에 맞는다).
 * - `*`는 경로 마지막 문자여야 하고 나머지 전체(빈 값 포함)를 받는다.
 * - 정적 > 파라미터(정규식 먼저) > 와일드카드 순으로 고르고 되돌아간다(구체성 디스패치).
 * - `caseSensitive: false`면 정적 부분과 요청 경로를 소문자로 비교한다. 요청 경로는 퍼센트 디코드 뒤 비교한다.
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

/** find-my-way의 선택 파라미터 정규식이다(원본과 같다). */
const OPTIONAL_PARAM_PATTERN = /(\/:[^/()]*?)\?(\/?)/u;

/** 라우터 옵션 중 경로 해석에 쓰는 값이다. */
export interface FindMyWayOptions {
  readonly ignoreTrailingSlash: boolean;
  readonly ignoreDuplicateSlashes: boolean;
}

/**
 * find-my-way 경로 하나를 컴파일한다.
 *
 * @param path 접두사를 붙인 경로
 * @param options 라우터 옵션
 * @returns 컴파일 결과
 */
export function compileFindMyWayPath(path: string, options: FindMyWayOptions): CompiledPath {
  if (path === '*') return variantsResult([{ segments: [{ kind: 'catch-all', zeroSegments: true, acceptsEmpty: false }] }]);
  if (!path.startsWith('/')) return { kind: 'dynamic', reason: 'unsupported-syntax', prefixes: undefined };
  const paths = optionalPaths(path);
  if (paths === undefined) return dynamicWithPrefix(path, 'unsupported-syntax');
  const variants: PathVariant[] = [];
  for (const candidate of paths) {
    const normalized = normalizePath(candidate, options);
    const variant = compileSingle(normalized, options.ignoreTrailingSlash);
    if (!('segments' in variant)) return dynamicWithPrefix(normalized, variant.reason);
    variants.push(variant);
  }
  return variantsResult(variants);
}

/**
 * 끝 선택 파라미터를 두 경로로 펼친다. 선택 파라미터가 끝이 아니면 undefined(등록 오류)다.
 *
 * @param path 경로
 * @returns 경로 목록 또는 undefined
 */
function optionalPaths(path: string): string[] | undefined {
  const match = OPTIONAL_PARAM_PATTERN.exec(path);
  if (match === null) return [path];
  if (path.length !== match.index + match[0].length) return undefined;
  const full = path.replace(OPTIONAL_PARAM_PATTERN, '$1$2');
  const optional = path.replace(OPTIONAL_PARAM_PATTERN, '$2') || '/';
  return [full, optional];
}

/**
 * 라우터 옵션에 따라 경로를 정리한다.
 *
 * @param path 경로
 * @param options 라우터 옵션
 * @returns 정리한 경로
 */
function normalizePath(path: string, options: FindMyWayOptions): string {
  let normalized = options.ignoreDuplicateSlashes ? path.replace(/\/\/+/gu, '/') : path;
  if (options.ignoreTrailingSlash && normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

/**
 * 선택 파라미터를 펼친 경로 하나를 대안으로 만든다. `ignoreTrailingSlash`면 요청의 끝 슬래시를 먼저 떼므로 마지막
 * 세그먼트는 빈 값을 받을 수 없다.
 *
 * @param path 경로
 * @param ignoreTrailingSlash 끝 슬래시를 떼는지
 * @returns 대안 또는 dynamic 이유
 */
function compileSingle(path: string, ignoreTrailingSlash: boolean): PathVariant | { readonly reason: DynamicPathReason } {
  const raw = path.slice(1).split('/');
  const segments: TemplateSegment[] = [];
  for (const [index, part] of raw.entries()) {
    const isLast = index === raw.length - 1;
    const converted = convertSegment(part, isLast);
    if ('reason' in converted) return converted;
    segments.push(isLast && ignoreTrailingSlash && converted.kind !== 'literal' ? { ...converted, acceptsEmpty: false } : converted);
  }
  return variantOf(segments) ?? { reason: 'dot-segment' };
}

/**
 * 세그먼트 하나를 변환한다. `::`는 리터럴 `:`로 먼저 바꿔 둔 뒤 파라미터 경계를 찾는다.
 *
 * @param part 세그먼트 원문
 * @param isLast 마지막 세그먼트인지
 * @returns 세그먼트 또는 dynamic 이유
 */
function convertSegment(part: string, isLast: boolean): TemplateSegment | { readonly reason: DynamicPathReason } {
  const placeholder = '\u0000';
  const escaped = part.replaceAll('::', placeholder);
  const star = escaped.indexOf('*');
  if (star !== -1) {
    if (!isLast || star !== escaped.length - 1 || escaped !== '*') return { reason: 'unsupported-syntax' };
    return { kind: 'catch-all', zeroSegments: false, acceptsEmpty: true };
  }
  const colon = escaped.indexOf(':');
  if (colon === -1) return { kind: 'literal', text: literalText(escaped, placeholder) };
  if (escaped.indexOf(':', colon + 1) !== -1) return { reason: 'multiple-parameters' };
  return parameterSegment(escaped.slice(0, colon), escaped.slice(colon + 1), placeholder);
}

/**
 * 파라미터 하나가 있는 세그먼트를 변환한다.
 *
 * @param staticPrefix `:` 앞의 정적 조각
 * @param rest `:` 뒤(이름, 선택 정규식, 정적 접미사)
 * @param placeholder `::` 자리 표시 문자
 * @returns 세그먼트 또는 dynamic 이유
 */
function parameterSegment(staticPrefix: string, rest: string, placeholder: string): TemplateSegment | { readonly reason: DynamicPathReason } {
  const name = /^[^(\-.]*/u.exec(rest)![0];
  let tail = rest.slice(name.length);
  let regex: ReturnType<typeof classifyParamRegex> | undefined;
  if (tail.startsWith('(')) {
    const end = closingParenthesis(tail);
    if (end === undefined) return { reason: 'unsupported-syntax' };
    regex = classifyParamRegex(tail.slice(1, end));
    tail = tail.slice(end + 1);
  }
  if (regex !== undefined && regex.kind !== 'segment') return { reason: 'regex' };
  return {
    kind: 'param',
    prefix: literalText(staticPrefix, placeholder),
    suffix: literalText(tail, placeholder),
    acceptsEmpty: regex === undefined ? true : regex.acceptsEmpty,
    ...(regex === undefined ? {} : { constraint: regex.constraint }),
  };
}

/**
 * 정규식 조각의 닫는 괄호 위치를 찾는다(`getClosingParenthensePosition`과 같은 괄호 세기).
 *
 * @param text `(`로 시작하는 문자열
 * @returns `)` 위치 또는 undefined
 */
function closingParenthesis(text: string): number | undefined {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (character === '\\') { index += 1; continue; }
    if (character === '(') depth += 1;
    if (character === ')' && --depth === 0) return index;
  }
  return undefined;
}

/**
 * 정적 조각을 정규 리터럴로 만든다. find-my-way는 정적 `%`를 `%25`로 바꿔 디코드한 요청 경로와 비교한다.
 *
 * @param text 정적 조각
 * @param placeholder `::` 자리 표시 문자
 * @returns 정규 리터럴
 */
function literalText(text: string, placeholder: string): string {
  return canonicalizeLiteral(text.replaceAll(placeholder, ':').replaceAll('%', '%25'));
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
    if (part === '' || /[:*()]/u.test(part) || part === '.' || part === '..') break;
    literals.push({ kind: 'literal', text: canonicalizeLiteral(part.replaceAll('%', '%25')) });
  }
  return { kind: 'dynamic', reason, prefixes: [literals.length === 0 ? ROOT_VARIANT : { segments: literals }] };
}
