/**
 * 해석 프레임 안에서 식의 정적 값(문자열·불리언·객체 속성)을 구한다.
 *
 * 식별자는 매개변수 바인딩(호출 인자), `const`·초기값 있는 변수, import한 상수, 열거형 멤버, `as const` 객체 속성까지
 * 따라간다. 템플릿 문자열과 `+` 연결은 앞부분이 확정되면 `partial`로 돌려준다 — 경로 앞부분만 증명해도
 * `dynamicScope` 접두사로 쓸 수 있기 때문이다. 확정하지 못하면 `unknown`이고 호출자가 dynamic·limitation으로 낸다.
 */

import ts from 'typescript';

import type { Binding, Frame, PathValue } from './router-model.ts';
import { enclosingFunction, resolveAlias, symbolAt, unwrap } from './symbols.ts';

/** 값 추적 최대 깊이다. 순환 참조를 끊는다. */
export const MAX_VALUE_DEPTH = 16;

/** 객체 속성 조회 결과다. */
export type PropertyLookup =
  | { readonly kind: 'found'; readonly expression: ts.Expression; readonly frame: Frame }
  | { readonly kind: 'absent' }
  /** 객체를 확정하지 못했거나 전개·계산된 키가 있어 속성이 있을 수 있다 */
  | { readonly kind: 'unknown' };

/** 값 해석에 필요한 환경이다(해석기가 준다). */
export interface ValueEnvironment {
  readonly checker: ts.TypeChecker;
  /** 파일의 모듈 프레임 */
  moduleFrame(sourceFile: ts.SourceFile): Frame;
}

/**
 * 프레임 체인에서 심볼의 바인딩을 찾는다.
 *
 * @param frame 프레임
 * @param symbol 심볼
 * @returns 바인딩 또는 undefined
 */
export function findBinding(frame: Frame | undefined, symbol: ts.Symbol): Binding | undefined {
  for (let current = frame; current !== undefined; current = current.parent) {
    const binding = current.bindings.get(symbol);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

/**
 * 선언의 초기값을 평가할 프레임을 고른다: 지금 프레임 체인 중 선언을 감싼 함수의 프레임, 모듈 최상위면 모듈 프레임.
 *
 * @param environment 환경
 * @param declaration 선언
 * @param frame 지금 프레임
 * @returns 프레임 또는 undefined(해석하지 않은 함수의 지역 변수)
 */
export function frameForDeclaration(environment: ValueEnvironment, declaration: ts.Node, frame: Frame): Frame | undefined {
  const owner = enclosingFunction(declaration);
  if (owner === undefined) return environment.moduleFrame(declaration.getSourceFile());
  for (let current: Frame | undefined = frame; current !== undefined; current = current.parent) {
    if (current.functionNode === owner) return current;
  }
  return undefined;
}

/**
 * 식을 경로 문자열 값으로 구한다.
 *
 * @param environment 환경
 * @param expression 식
 * @param frame 프레임
 * @param depth 추적 깊이
 * @returns 문자열 값
 */
export function resolveStringValue(environment: ValueEnvironment, expression: ts.Expression, frame: Frame, depth = 0): PathValue {
  if (depth > MAX_VALUE_DEPTH) return { kind: 'unknown' };
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) return { kind: 'literal', text: node.text };
  if (ts.isTemplateExpression(node)) return templateValue(environment, node, frame, depth);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) return concatValue(environment, node, frame, depth);
  const reference = referencedExpression(environment, node, frame);
  if (reference !== undefined) return resolveStringValue(environment, reference.expression, reference.frame, depth + 1);
  const constant = constantString(environment.checker, node);
  return constant === undefined ? { kind: 'unknown' } : { kind: 'literal', text: constant };
}

/**
 * 템플릿 문자열을 구한다. 보간을 확정하지 못하면 그 앞까지가 `partial`이다.
 *
 * @param environment 환경
 * @param node 템플릿 식
 * @param frame 프레임
 * @param depth 추적 깊이
 * @returns 문자열 값
 */
function templateValue(environment: ValueEnvironment, node: ts.TemplateExpression, frame: Frame, depth: number): PathValue {
  let text = node.head.text;
  for (const span of node.templateSpans) {
    const value = resolveStringValue(environment, span.expression, frame, depth + 1);
    if (value.kind !== 'literal') return { kind: 'partial', head: value.kind === 'partial' ? text + value.head : text };
    text += value.text + span.literal.text;
  }
  return { kind: 'literal', text };
}

/**
 * `a + b` 문자열 연결을 구한다.
 *
 * @param environment 환경
 * @param node 이항 식
 * @param frame 프레임
 * @param depth 추적 깊이
 * @returns 문자열 값
 */
function concatValue(environment: ValueEnvironment, node: ts.BinaryExpression, frame: Frame, depth: number): PathValue {
  const left = resolveStringValue(environment, node.left, frame, depth + 1);
  if (left.kind !== 'literal') return left.kind === 'partial' ? left : { kind: 'unknown' };
  const right = resolveStringValue(environment, node.right, frame, depth + 1);
  if (right.kind === 'literal') return { kind: 'literal', text: left.text + right.text };
  return { kind: 'partial', head: right.kind === 'partial' ? left.text + right.head : left.text };
}

/**
 * 열거형 멤버처럼 checker가 아는 상수 문자열을 얻는다.
 *
 * @param checker TypeChecker
 * @param node 식
 * @returns 문자열 또는 undefined
 */
function constantString(checker: ts.TypeChecker, node: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return undefined;
  const value = checker.getConstantValue(node);
  return typeof value === 'string' ? value : undefined;
}

/**
 * 식별자·속성 접근이 가리키는 값 식을 찾는다: 매개변수 바인딩, 변수 초기값, 객체 속성 값.
 *
 * @param environment 환경
 * @param node 식
 * @param frame 프레임
 * @returns 값 식과 평가 프레임, 없으면 undefined
 */
export function referencedExpression(environment: ValueEnvironment, node: ts.Expression, frame: Frame): { expression: ts.Expression; frame: Frame } | undefined {
  if (ts.isIdentifier(node)) return identifierValue(environment, node, frame);
  if (ts.isPropertyAccessExpression(node) || (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))) {
    const name = ts.isPropertyAccessExpression(node) ? node.name.text : (node.argumentExpression as ts.StringLiteralLike).text;
    const lookup = lookupProperty(environment, node.expression, name, frame);
    if (lookup.kind === 'found') return { expression: lookup.expression, frame: lookup.frame };
    return memberValue(environment, node, frame);
  }
  return undefined;
}

/**
 * 속성 접근의 심볼(네임스페이스 import 멤버, 클래스 정적 필드 등)을 따라 값 식을 찾는다.
 *
 * @param environment 환경
 * @param node 속성 접근 식
 * @param frame 프레임
 * @returns 값 식과 평가 프레임, 없으면 undefined
 */
function memberValue(environment: ValueEnvironment, node: ts.PropertyAccessExpression | ts.ElementAccessExpression, frame: Frame): { expression: ts.Expression; frame: Frame } | undefined {
  const symbol = symbolAt(environment.checker, ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression);
  const declaration = symbol === undefined ? undefined : resolveAlias(environment.checker, symbol).valueDeclaration;
  return declaration === undefined ? undefined : declarationValue(environment, declaration, frame);
}

/**
 * 식별자의 값 식을 찾는다.
 *
 * @param environment 환경
 * @param identifier 식별자
 * @param frame 프레임
 * @returns 값 식과 평가 프레임, 없으면 undefined
 */
function identifierValue(environment: ValueEnvironment, identifier: ts.Identifier, frame: Frame): { expression: ts.Expression; frame: Frame } | undefined {
  const symbol = symbolAt(environment.checker, identifier);
  if (symbol === undefined) return undefined;
  const binding = findBinding(frame, symbol);
  if (binding !== undefined) return binding.expression === undefined ? undefined : { expression: binding.expression, frame: binding.frame };
  const declaration = resolveAlias(environment.checker, symbol).valueDeclaration;
  if (declaration === undefined) return undefined;
  return declarationValue(environment, declaration, frame);
}

/**
 * 선언의 값 식을 찾는다(변수 초기값, 기본 내보내기 식, 객체 속성, 축약 속성).
 *
 * @param environment 환경
 * @param declaration 선언
 * @param frame 프레임
 * @returns 값 식과 평가 프레임, 없으면 undefined
 */
export function declarationValue(environment: ValueEnvironment, declaration: ts.Declaration, frame: Frame): { expression: ts.Expression; frame: Frame } | undefined {
  const evaluation = frameForDeclaration(environment, declaration, frame);
  if (evaluation === undefined) return undefined;
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
    return { expression: declaration.initializer, frame: evaluation };
  }
  if (ts.isExportAssignment(declaration)) return { expression: declaration.expression, frame: evaluation };
  if (ts.isPropertyAssignment(declaration)) return { expression: declaration.initializer, frame: evaluation };
  if (ts.isPropertyDeclaration(declaration) && declaration.initializer !== undefined) return { expression: declaration.initializer, frame: evaluation };
  if (ts.isShorthandPropertyAssignment(declaration)) return { expression: declaration.name, frame: evaluation };
  if (ts.isEnumMember(declaration) && declaration.initializer !== undefined) return { expression: declaration.initializer, frame: evaluation };
  if (ts.isBinaryExpression(declaration)) return { expression: declaration.right, frame: evaluation };
  if (ts.isPropertyAccessExpression(declaration) && ts.isBinaryExpression(declaration.parent) && declaration.parent.left === declaration) {
    return { expression: declaration.parent.right, frame: evaluation };
  }
  return undefined;
}

/**
 * 식을 객체 리터럴로 풀어 속성 값을 찾는다. 전개(`...x`)·계산된 키가 있으면 모른다고 본다.
 *
 * @param environment 환경
 * @param expression 객체 식
 * @param name 속성 이름
 * @param frame 프레임
 * @param depth 추적 깊이
 * @returns 조회 결과
 */
export function lookupProperty(environment: ValueEnvironment, expression: ts.Expression, name: string, frame: Frame, depth = 0): PropertyLookup {
  if (depth > MAX_VALUE_DEPTH) return { kind: 'unknown' };
  const node = unwrap(expression);
  if (ts.isObjectLiteralExpression(node)) return objectProperty(node, name, frame);
  const reference = referencedExpression(environment, node, frame);
  if (reference === undefined) return { kind: 'unknown' };
  return lookupProperty(environment, reference.expression, name, reference.frame, depth + 1);
}

/**
 * 객체 리터럴에서 속성 하나를 찾는다. 뒤의 같은 이름이 앞을 덮으므로 마지막 것을 쓴다.
 *
 * @param node 객체 리터럴
 * @param name 속성 이름
 * @param frame 평가 프레임
 * @returns 조회 결과
 */
function objectProperty(node: ts.ObjectLiteralExpression, name: string, frame: Frame): PropertyLookup {
  let result: PropertyLookup = { kind: 'absent' };
  for (const property of node.properties) {
    if (ts.isSpreadAssignment(property)) {
      result = { kind: 'unknown' };
      continue;
    }
    const key = property.name === undefined ? undefined : propertyKey(property.name);
    if (key === undefined) {
      result = { kind: 'unknown' };
      continue;
    }
    if (key !== name) continue;
    if (ts.isPropertyAssignment(property)) result = { kind: 'found', expression: property.initializer, frame };
    else if (ts.isShorthandPropertyAssignment(property)) result = { kind: 'found', expression: property.name, frame };
    else result = { kind: 'unknown' };
  }
  return result;
}

/**
 * 속성 이름 노드를 문자열로 만든다. 계산된 이름은 undefined다.
 *
 * @param name 속성 이름
 * @returns 문자열 또는 undefined
 */
function propertyKey(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

/**
 * 식을 불리언으로 구한다.
 *
 * @param environment 환경
 * @param expression 식
 * @param frame 프레임
 * @param depth 추적 깊이
 * @returns 불리언 또는 undefined
 */
export function resolveBooleanValue(environment: ValueEnvironment, expression: ts.Expression, frame: Frame, depth = 0): boolean | undefined {
  if (depth > MAX_VALUE_DEPTH) return undefined;
  const node = unwrap(expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  const reference = referencedExpression(environment, node, frame);
  return reference === undefined ? undefined : resolveBooleanValue(environment, reference.expression, reference.frame, depth + 1);
}

/**
 * 속성 이름의 불리언 옵션을 읽는다. 속성이 없으면 기본값, 있는데 확정하지 못하면 undefined다.
 *
 * @param environment 환경
 * @param options 옵션 객체 식(없으면 기본값)
 * @param name 속성 이름
 * @param frame 프레임
 * @param fallback 속성이 없을 때 값
 * @returns 불리언 또는 undefined
 */
export function booleanOption(environment: ValueEnvironment, options: ts.Expression | undefined, name: string, frame: Frame, fallback: boolean): boolean | undefined {
  if (options === undefined) return fallback;
  const lookup = lookupProperty(environment, options, name, frame);
  if (lookup.kind === 'absent') return fallback;
  if (lookup.kind === 'unknown') return undefined;
  return resolveBooleanValue(environment, lookup.expression, lookup.frame);
}
