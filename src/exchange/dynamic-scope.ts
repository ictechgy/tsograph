/**
 * dynamic 선언의 `dynamicScope`를 내기 전에 계약 모양을 검증한다.
 *
 * isthmus는 잘못된 `dynamicScope`를 빈 공백으로 읽지 않고 문서 전체를 입력 오류로 거부한다(좁히는 선언이 틀리면
 * 거짓 error가 되기 때문이다). 그래서 생산 단계에서 같은 규칙으로 먼저 거른다. 규칙의 정본은 isthmus
 * `docs/GRAPH-EXCHANGE.md`의 "dynamic 선언의 스코프" 절과 공유 벡터 `scope.dynamic-validate` 사례다
 * (`dynamic-scope.test.ts`가 벤더링한 벡터로 이 검사기를 검증한다).
 */

import { methodsProblem, pathFieldProblem, pathFields } from './http-limitation-scope.ts';

/** `dynamicScope`가 가질 수 있는 키다. `limitationIndex`·`channels`는 거부한다. */
const allowedKeys = new Set<string>([...pathFields, 'methods']);

/** 한 `dynamicScope`의 원소 수 상한이다(계약). */
export const MAX_DYNAMIC_SCOPE_ELEMENTS = 1000;

/** 검증에 쓰는 선언 모양이다(JSON 객체 그대로). */
export interface DynamicScopeDeclaration {
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly pathAnchor?: unknown;
  readonly dynamic?: unknown;
  readonly dynamicScope?: unknown;
}

/**
 * 선언 하나의 `dynamicScope`를 검증한다. `dynamicScope`가 없으면 통과다.
 *
 * @param declaration route 사실(JSON 객체)
 * @returns 위반 사유 코드, 통과하면 undefined
 */
export function dynamicScopeProblem(declaration: DynamicScopeDeclaration): string | undefined {
  const scope = declaration.dynamicScope;
  if (scope === undefined) return undefined;
  if (declaration.kind !== 'route-decl' && declaration.kind !== 'route-contract') return 'scope-on-non-declaration';
  if (declaration.dynamic !== true) return 'scope-on-static-declaration';
  if (typeof scope !== 'object' || scope === null || Array.isArray(scope)) return 'scope-not-object';
  return scopeShapeProblem(scope as Readonly<Record<string, unknown>>) ?? relationProblem(declaration, scope as Readonly<Record<string, unknown>>);
}

/**
 * 스코프 객체 자체의 모양(키·경로 필드·method·원소 수)을 검증한다.
 *
 * @param scope 스코프 객체
 * @returns 위반 사유 코드, 통과하면 undefined
 */
function scopeShapeProblem(scope: Readonly<Record<string, unknown>>): string | undefined {
  if (Object.keys(scope).some((key) => !allowedKeys.has(key))) return 'unknown-key';
  if (!pathFields.some((field) => scope[field] !== undefined)) return 'path-field-required';
  for (const field of pathFields) {
    const problem = pathFieldProblem(field, scope[field]);
    if (problem !== undefined) return problem;
  }
  const elements = pathFields.reduce((sum, field) => sum + ((scope[field] as unknown[] | undefined)?.length ?? 0), 0);
  if (elements > MAX_DYNAMIC_SCOPE_ELEMENTS) return 'too-many-elements';
  return methodsProblem(scope['methods']);
}

/**
 * 선언과 스코프의 관계 규칙을 검증한다: `methods`는 `ANY` route-decl 전용이고, base 앵커 선언은
 * `templateSuffixes`와 `templatePrefixes: ["/"]`만 쓴다.
 *
 * @param declaration 선언
 * @param scope 스코프 객체
 * @returns 위반 사유 코드, 통과하면 undefined
 */
function relationProblem(declaration: DynamicScopeDeclaration, scope: Readonly<Record<string, unknown>>): string | undefined {
  if (scope['methods'] !== undefined && (declaration.kind !== 'route-decl' || declaration.method !== 'ANY')) return 'methods-on-non-any';
  if (declaration.pathAnchor !== 'base') return undefined;
  if (scope['templates'] !== undefined) return 'base-templates';
  const prefixes = scope['templatePrefixes'] as readonly string[] | undefined;
  return prefixes !== undefined && prefixes.some((prefix) => prefix !== '/') ? 'base-non-root-prefix' : undefined;
}
