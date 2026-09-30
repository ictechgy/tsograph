/**
 * http limitation 스코프 항목을 내기 전에 계약 모양을 검증한다.
 *
 * isthmus는 잘못된 스코프를 빈 공백으로 읽지 않고 문서 전체를 입력 오류(종료 코드 2)로 거부한다. 그래서
 * 생산 단계에서 같은 규칙으로 먼저 거른다. 규칙의 정본은 isthmus `docs/GRAPH-EXCHANGE.md`의
 * "http limitation 스코프" 절과 공유 벡터 `conformance/http-limitation-scope.json`의 `scope.validate`
 * 사례다(`http-limitation-scope.test.ts`가 벤더링한 벡터로 이 검사기를 검증한다). 어떤 호출이 스코프
 * 안인지(`scope.applies`)는 소비자의 조인 규칙이라 여기서 계산하지 않는다.
 */

import type { HttpMethod } from './bridge-facts.ts';
import { isCanonicalTemplate } from './route-template-grammar.ts';

/** 경로 필드 이름이다. 항목마다 하나 이상 있어야 한다. dynamic 선언의 `dynamicScope`도 같은 필드를 쓴다. */
export const pathFields = ['templates', 'templatePrefixes', 'templateSuffixes'] as const;

/** 경로 필드 이름 하나다. */
export type PathField = (typeof pathFields)[number];

/** 항목이 가질 수 있는 키다. 그 밖의 키(`channels` 포함)는 거부한다. */
const allowedKeys = new Set<string>(['limitationIndex', ...pathFields, 'methods']);

/** 스코프에 쓸 수 있는 HTTP 동사다. `ANY`는 쓰지 않는다(생략이 모든 method다). */
const scopeMethods = new Set<string>(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'] satisfies HttpMethod[]);

/**
 * 스코프 항목 하나의 모양을 검증한다. 인덱스 범위·중복과 문서 상한은 호출자가 본다.
 *
 * @param entry 스코프 항목(JSON 객체)
 * @returns 위반 사유 코드, 통과하면 undefined
 */
export function httpLimitationScopeProblem(entry: Readonly<Record<string, unknown>>): string | undefined {
  if (entry['channels'] !== undefined) return 'channels-in-http-scope';
  if (Object.keys(entry).some((key) => !allowedKeys.has(key))) return 'unknown-key';
  if (!pathFields.some((field) => entry[field] !== undefined)) return 'path-field-required';
  for (const field of pathFields) {
    const problem = pathFieldProblem(field, entry[field]);
    if (problem !== undefined) return problem;
  }
  return methodsProblem(entry['methods']);
}

/**
 * 경로 필드 하나를 검증한다. 비어 있지 않은 배열이고 원소마다 정규 템플릿이어야 한다.
 *
 * 접두사·접미사에는 `{**}`를 쓰지 않고, 루트가 아닌 접두사는 `/`로 끝날 수 없으며, 접미사 `/` 하나는
 * 모든 경로라는 뜻이 되어 접두사 `/`로 쓰게 한다(계약).
 *
 * @param field 필드 이름
 * @param value 필드 값
 * @returns 위반 사유 코드, 통과하면 undefined
 */
export function pathFieldProblem(field: PathField, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) return `${field}-not-non-empty-array`;
  for (const element of value) {
    if (typeof element !== 'string' || !isCanonicalTemplate(element)) return `${field}-non-canonical-template`;
    if (field === 'templates') continue;
    if (element.split('/').includes('{**}')) return `${field}-catch-all`;
    if (field === 'templatePrefixes' && element !== '/' && element.endsWith('/')) return 'templatePrefixes-trailing-slash';
    if (field === 'templateSuffixes' && element === '/') return 'templateSuffixes-root';
  }
  return undefined;
}

/**
 * `methods`를 검증한다. 선택 필드이며 중복 없는 HTTP 동사의 비어 있지 않은 배열이다.
 *
 * @param value 필드 값
 * @returns 위반 사유 코드, 통과하면 undefined
 */
export function methodsProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const isValid = Array.isArray(value) && value.length > 0
    && value.every((method) => typeof method === 'string' && scopeMethods.has(method))
    && new Set(value).size === value.length;
  return isValid ? undefined : 'invalid-methods';
}
