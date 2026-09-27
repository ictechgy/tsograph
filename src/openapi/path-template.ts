/**
 * OpenAPI 경로 템플릿을 isthmus 정규 경로 템플릿으로 바꾼다.
 *
 * 정규화는 생산자 책임이고 isthmus는 문법만 검증한다. 규칙(초안 "정규 경로 템플릿"):
 * - `/`로 시작하고 query·fragment를 뗀다. 중복·끝 슬래시와 대소문자는 보존한다.
 * - 세그먼트 전체가 파라미터면 `{}`, 일부만 파라미터면 리터럴 골격 `p{}s`다.
 * - 한 세그먼트에 파라미터가 둘 이상이면 골격을 만들지 않고 dynamic으로 낸다.
 * OpenAPI에는 catch-all 개념이 없어 `{**}`는 만들지 않는다.
 */

import { canonicalizeLiteral, percentEncode } from './percent-encoding.ts';

/** dynamic 원문 channel의 최대 길이(UTF-16 코드 단위)다. 초안은 상한만 요구하고 값을 정하지 않았다. */
export const MAX_DYNAMIC_CHANNEL_LENGTH = 1024;

/**
 * 정규 템플릿의 최대 길이(UTF-16 코드 단위)다.
 *
 * isthmus 소비자(개발 중 브랜치)가 이보다 긴 템플릿을 문서째 거부하므로, 넘는
 * 템플릿은 정적 사실 대신 dynamic으로 낸다.
 */
export const MAX_TEMPLATE_LENGTH = 2048;

/** 정규화 결과다. */
export type PathTemplateResult =
  /** 정규 템플릿으로 확정했다. */
  | { readonly kind: 'static'; readonly template: string }
  /** 골격을 만들 수 없어 안전하게 인코딩한 원문을 dynamic channel로 쓴다. */
  | {
    readonly kind: 'dynamic';
    readonly channel: string;
    readonly reason: 'multi-parameter-segment' | 'unbalanced-braces' | 'malformed-text';
  }
  /** `/`로 시작하지 않아 경로 템플릿이 아니다. */
  | { readonly kind: 'rejected' };

/** 세그먼트를 리터럴 조각과 파라미터 수로 나눈 결과다. */
interface SegmentParts {
  /** 파라미터 사이의 리터럴 조각이다. 길이는 항상 파라미터 수 + 1이다. */
  readonly literals: readonly string[];
}

/**
 * OpenAPI 경로 키를 정규 템플릿으로 바꾼다.
 *
 * @param rawPath OpenAPI `paths`의 키(예: `/users/{id}/files/{name}.json`)
 * @returns 정규 템플릿, dynamic 원문, 또는 거부
 */
export function canonicalizePathTemplate(rawPath: string): PathTemplateResult {
  const path = stripQueryAndFragment(rawPath);
  if (!path.startsWith('/')) return { kind: 'rejected' };
  if (!path.isWellFormed()) return dynamic(path, 'malformed-text');
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    const parts = splitSegment(segment);
    if (parts === undefined) return dynamic(path, 'unbalanced-braces');
    if (parts.literals.length > 2) return dynamic(path, 'multi-parameter-segment');
    segments.push(parts.literals.map(canonicalizeLiteral).join('{}'));
  }
  return { kind: 'static', template: segments.join('/') };
}

/**
 * 첫 `?` 또는 `#`부터 끝까지 뗀다. 초안은 query·fragment를 템플릿에서 제외한다.
 *
 * @param path 원문 경로
 * @returns query·fragment가 없는 경로
 */
export function stripQueryAndFragment(path: string): string {
  const cut = path.search(/[?#]/u);
  return cut === -1 ? path : path.slice(0, cut);
}

/**
 * 세그먼트를 `{name}` 파라미터 경계로 나눈다.
 *
 * 중첩되거나 닫히지 않은 중괄호는 템플릿 의미를 확정할 수 없어 undefined다.
 *
 * @param segment `/`가 없는 세그먼트
 * @returns 리터럴 조각 목록, 또는 괄호 불균형이면 undefined
 */
function splitSegment(segment: string): SegmentParts | undefined {
  const literals: string[] = [];
  let current = '';
  let insideParameter = false;
  for (const character of segment) {
    if (character === '{') {
      if (insideParameter) return undefined;
      literals.push(current);
      current = '';
      insideParameter = true;
    } else if (character === '}') {
      if (!insideParameter) return undefined;
      insideParameter = false;
    } else if (!insideParameter) {
      current += character;
    }
  }
  if (insideParameter) return undefined;
  literals.push(current);
  return { literals };
}

/**
 * dynamic 결과를 만든다.
 *
 * @param path query를 뗀 원문 경로
 * @param reason dynamic으로 내린 이유
 * @returns dynamic 결과
 */
function dynamic(
  path: string,
  reason: 'multi-parameter-segment' | 'unbalanced-braces' | 'malformed-text',
): PathTemplateResult {
  return { kind: 'dynamic', channel: sanitizeDynamicChannel(path), reason };
}

/** dynamic 원문에서 그대로 두는 문자 한 개(pchar 원문 문자 · `/` · 중괄호 · `%`)다. */
const dynamicRawCharacter = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/{}%]$/u;

/**
 * dynamic channel로 쓸 원문을 계약상 안전한 ASCII로 만든다.
 *
 * 원문을 보존하되 제어 문자·비ASCII·짝 없는 서러게이트가 문서에 들어가지 않게
 * 나머지 문자를 `%XX`로 인코딩하고 길이 상한에서 자른다. 자를 때 `%XX` 중간을
 * 끊지 않는다.
 *
 * @param path 원문 경로
 * @returns 안전한 dynamic channel
 */
export function sanitizeDynamicChannel(path: string): string {
  let output = '';
  for (const character of path.toWellFormed()) {
    output += dynamicRawCharacter.test(character) ? character : percentEncode(character);
    if (output.length >= MAX_DYNAMIC_CHANNEL_LENGTH) break;
  }
  return truncateOnEscapeBoundary(output, MAX_DYNAMIC_CHANNEL_LENGTH);
}

/**
 * 길이 상한에서 자르되 끝에 걸친 불완전한 `%X`를 버린다.
 *
 * @param text 자를 문자열
 * @param limit 최대 길이
 * @returns 잘린 문자열
 */
function truncateOnEscapeBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastPercent = cut.lastIndexOf('%');
  return lastPercent !== -1 && lastPercent > limit - 3 ? cut.slice(0, lastPercent) : cut;
}
