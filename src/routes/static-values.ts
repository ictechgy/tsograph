/**
 * 설정 파일 같은 작은 모듈에서 **실행 없이 확정되는** 값만 읽는 도우미다.
 *
 * 식별자는 같은 파일 최상위의 `const` 선언 초기값으로만 따라간다. 재할당·속성 변경·
 * `Object.assign`의 대상이 된 이름은 초기값이 최종값이라는 근거가 없어 따라가지 않는다.
 * 확정하지 못하면 undefined를 돌려주고 호출자가 limitation으로 낸다.
 */

import ts from 'typescript';

/** 식별자 추적의 최대 깊이다. `const a = b; const b = a` 같은 순환을 끊는다. */
export const MAX_RESOLUTION_DEPTH = 16;

/** 파일 하나의 최상위 `const` 선언과 변경된 이름 집합이다. */
export interface ModuleBindings {
  readonly sourceFile: ts.SourceFile;
  /** 최상위 `const 이름 = 초기값`(단순 식별자 바인딩만) */
  readonly constants: ReadonlyMap<string, ts.Expression>;
  /** 할당·증감·`Object.assign`으로 값이나 속성이 바뀔 수 있는 이름 */
  readonly mutated: ReadonlySet<string>;
}

/**
 * 파일의 최상위 상수와 변경된 이름을 모은다.
 *
 * @param sourceFile 파싱한 파일
 * @returns 바인딩 색인
 */
export function indexModuleBindings(sourceFile: ts.SourceFile): ModuleBindings {
  const constants = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        constants.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return { sourceFile, constants, mutated: collectMutatedNames(sourceFile) };
}

/**
 * 파일 전체에서 값이나 속성이 바뀌는 이름을 모은다.
 *
 * @param sourceFile 파싱한 파일
 * @returns 변경 대상 이름 집합
 */
function collectMutatedNames(sourceFile: ts.SourceFile): Set<string> {
  const mutated = new Set<string>();
  const visit = (node: ts.Node): void => {
    const target = mutationTarget(node);
    if (target !== undefined) mutated.add(target);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mutated;
}

/**
 * 노드가 어떤 이름을 바꾸면 그 루트 이름을 돌려준다.
 *
 * @param node 임의 노드
 * @returns 변경되는 루트 식별자 이름 또는 undefined
 */
function mutationTarget(node: ts.Node): string | undefined {
  if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) return rootName(node.left);
  if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && isUpdateOperator(node.operator)) {
    return rootName(node.operand);
  }
  if (ts.isCallExpression(node) && isObjectAssign(node.expression) && node.arguments[0] !== undefined) {
    return rootName(node.arguments[0]);
  }
  return undefined;
}

/**
 * 할당 연산자(`=`, `+=`, `??=` …)인지 확인한다.
 *
 * @param kind 연산자 토큰 종류
 * @returns 할당 연산자면 true
 */
function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

/**
 * 증감 연산자(`++`·`--`)인지 확인한다.
 *
 * @param operator 단항 연산자
 * @returns 증감 연산자면 true
 */
function isUpdateOperator(operator: ts.SyntaxKind): boolean {
  return operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken;
}

/**
 * 호출 대상이 `Object.assign`인지 확인한다.
 *
 * @param callee 호출 식의 대상
 * @returns `Object.assign`이면 true
 */
function isObjectAssign(callee: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(callee)
    && ts.isIdentifier(callee.expression) && callee.expression.text === 'Object'
    && callee.name.text === 'assign';
}

/**
 * `a.b[c].d` 같은 접근 식의 루트 식별자 이름이다.
 *
 * @param expression 식
 * @returns 루트 식별자 이름 또는 undefined
 */
function rootName(expression: ts.Expression): string | undefined {
  const inner = unwrapExpression(expression);
  if (ts.isIdentifier(inner)) return inner.text;
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) return rootName(inner.expression);
  return undefined;
}

/**
 * 값에 영향이 없는 괄호·타입 단언·`satisfies`·non-null 단언을 벗긴다.
 *
 * @param expression 식
 * @returns 벗긴 식
 */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * 식을 벗기고, 변경되지 않은 최상위 상수 식별자면 초기값으로 따라간다.
 *
 * @param expression 식
 * @param bindings 바인딩 색인
 * @param depth 현재 추적 깊이
 * @returns 확정한 식. 순환·변경·깊이 초과면 undefined
 */
export function resolveExpression(
  expression: ts.Expression,
  bindings: ModuleBindings,
  depth = 0,
): ts.Expression | undefined {
  if (depth > MAX_RESOLUTION_DEPTH) return undefined;
  const inner = unwrapExpression(expression);
  if (!ts.isIdentifier(inner)) return inner;
  if (bindings.mutated.has(inner.text)) return undefined;
  const initializer = bindings.constants.get(inner.text);
  return initializer === undefined ? undefined : resolveExpression(initializer, bindings, depth + 1);
}

/**
 * 식이 문자열 리터럴(보간 없는 템플릿 포함)로 확정되면 그 값을 돌려준다.
 *
 * @param expression 식
 * @param bindings 바인딩 색인
 * @returns 문자열 또는 undefined
 */
export function resolveString(expression: ts.Expression, bindings: ModuleBindings): string | undefined {
  const resolved = resolveExpression(expression, bindings);
  if (resolved === undefined) return undefined;
  return ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved) ? resolved.text : undefined;
}

/**
 * 식이 `true`·`false`로 확정되면 그 값을 돌려준다.
 *
 * @param expression 식
 * @param bindings 바인딩 색인
 * @returns 불리언 또는 undefined
 */
export function resolveBoolean(expression: ts.Expression, bindings: ModuleBindings): boolean | undefined {
  const resolved = resolveExpression(expression, bindings);
  if (resolved?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (resolved?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return undefined;
}

/**
 * 식이 문자열 리터럴만 담은 배열로 확정되면 그 값을 돌려준다.
 *
 * @param expression 식
 * @param bindings 바인딩 색인
 * @returns 문자열 배열 또는 undefined(전개·비리터럴 원소가 있으면)
 */
export function resolveStringArray(expression: ts.Expression, bindings: ModuleBindings): string[] | undefined {
  const resolved = resolveExpression(expression, bindings);
  if (resolved === undefined || !ts.isArrayLiteralExpression(resolved)) return undefined;
  const values: string[] = [];
  for (const element of resolved.elements) {
    const value = ts.isSpreadElement(element) ? undefined : resolveString(element, bindings);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}
