/**
 * 사실을 담은 선언의 이름(`symbol.qualifiedName`)을 만든다.
 *
 * 형식: `<프로젝트 기준 POSIX 경로>#<이름>(.<이름>)*`. 이름은 바깥 선언부터 안쪽 선언 순서다.
 *
 * - 함수 선언·클래스 선언/식(이름 있는 것)·클래스 메서드·접근자·필드: 선언 이름. 생성자는
 *   `constructor`, 이름 없는 default export 함수·클래스는 `default`다.
 * - 변수 선언: 모듈 최상위 변수이거나, 사실이 그 초기값 안의 함수 안에 있을 때만 이름이 된다
 *   (함수 안 지역 결과 변수 `const rows = await …`는 이름이 아니다).
 * - 객체 리터럴의 메서드·함수 값 속성: 속성 이름(`handlers.GET`).
 * - `export default <식>`(CommonJS `export =`는 제외)의 식 안은 `default`다 — 모듈이 내보낸 값이고
 *   `routes`의 Pages Router 핸들러 id(`#default`)와 같아야 하기 때문이다.
 * - 이름 없는 콜백(화살표·함수 식)은 투명하다 — 감싸는 선언에 귀속한다.
 * - 계산된 이름이 끼면 이름을 만들지 않는다(추측하지 않는다). 이름이 하나도 없으면(모듈 최상위 문장)
 *   심볼을 생략하고 호출자가 `missing-relation-usrs:`로 센다(isthmus 체인 전용 접두사).
 *
 * 이 이름은 그대로 tsograph 그래프 id(`symbol.usr`)다(`src/graph/symbol-ids.ts`).
 */

import ts from 'typescript';

import { memberName } from './scope-builder.ts';

/**
 * 노드를 담은 선언의 한정 이름을 만든다.
 *
 * @param node 사실 노드
 * @param path 프로젝트 기준 경로
 * @returns `path#A.B` 또는 undefined
 */
export function enclosingSymbol(node: ts.Node, path: string): string | undefined {
  const names: string[] = [];
  let insideFunction = false;
  for (let current: ts.Node = node; current.parent !== undefined; current = current.parent) {
    const parent = current.parent;
    const name = declarationSegment(parent, current, insideFunction);
    if (name === null) return undefined;
    if (name !== undefined) names.push(name);
    if (isFunctionLike(parent)) insideFunction = true;
  }
  return names.length === 0 ? undefined : `${path}#${names.reverse().join('.')}`;
}

/**
 * 조상 노드 하나가 이름 조각이 되는지 본다.
 *
 * @param node 조상 노드
 * @param child 그 조상으로 올라온 자식
 * @param insideFunction 사실이 이미 어떤 함수 안에 있는지
 * @returns 이름, 조각 아님(undefined), 계산된 이름이라 포기(null)
 */
function declarationSegment(node: ts.Node, child: ts.Node, insideFunction: boolean): string | undefined | null {
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return node.name?.text ?? 'default';
  if (ts.isClassExpression(node)) return node.name?.text;
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
    || ts.isPropertyDeclaration(node)) {
    return memberName(node.name) ?? null;
  }
  if (ts.isPropertyAssignment(node)) {
    if (child !== node.initializer || !insideFunction || !isFunctionValued(node.initializer)) return undefined;
    return memberName(node.name) ?? null;
  }
  if (ts.isVariableDeclaration(node)) return variableSegment(node, child, insideFunction);
  if (ts.isExportAssignment(node) && node.isExportEquals !== true) return 'default';
  return undefined;
}

/**
 * 변수 선언이 이름 조각이 되는지 본다.
 *
 * @param node 변수 선언
 * @param child 올라온 자식
 * @param insideFunction 사실이 이미 함수 안에 있는지
 * @returns 이름 또는 undefined
 */
function variableSegment(node: ts.VariableDeclaration, child: ts.Node, insideFunction: boolean): string | undefined {
  if (!ts.isIdentifier(node.name) || child !== node.initializer) return undefined;
  return insideFunction || isModuleLevel(node) ? node.name.text : undefined;
}

/**
 * 변수 선언이 모듈 최상위 문장에 속하는지 본다.
 *
 * @param node 변수 선언
 * @returns 최상위면 true
 */
function isModuleLevel(node: ts.VariableDeclaration): boolean {
  const statement = node.parent.parent;
  return ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
}

/**
 * 식이 (괄호를 벗겨) 함수 값인지 본다.
 *
 * @param expression 식
 * @returns 함수 값이면 true
 */
function isFunctionValued(expression: ts.Expression): boolean {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return ts.isArrowFunction(current) || ts.isFunctionExpression(current);
}

/**
 * 함수처럼 본문을 가진 노드인지 본다.
 *
 * @param node 노드
 * @returns 함수 계열이면 true
 */
export function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
}
