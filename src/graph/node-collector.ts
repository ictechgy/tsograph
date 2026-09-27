/**
 * 파일 하나에서 그래프 노드를 모은다(1단계).
 *
 * 노드 집합은 "어떤 코드 위치의 `enclosingSymbol`이 될 수 있는 id 전부"다. 그래야 relation-use의
 * `symbol.usr`(같은 함수로 만든다)가 언제나 그래프 노드가 된다. 그런 id는 이름 조각이 바뀌는 경계에서만
 * 생기므로, 함수 본문·변수/필드 초기값·클래스·`export default` 식·모듈 스코프에서 id를 구해 등록한다.
 * 이미 있는 id(감싸는 선언과 같은 id)는 무시된다. 순회는 전위라 바깥 선언이 먼저 등록된다.
 */

import ts from 'typescript';

import { isFunctionLike } from '../schema/enclosing-symbol.ts';
import type { GraphStore, NodeKind } from './graph-model.ts';
import { moduleScopeId, scopeIdOf } from './symbol-ids.ts';

/** 1단계가 2단계에 넘기는 파일별 선언이다. */
export interface CollectedDeclarations {
  /** 클래스 선언·식(상속·필드 초기값 간선용) */
  readonly classes: readonly ts.ClassLikeDeclaration[];
}

/**
 * 파일의 노드를 등록한다.
 *
 * @param store 그래프 저장소
 * @param path 프로젝트 기준 경로
 * @param sourceFile 파일
 * @returns 2단계용 선언 목록
 */
export function collectFileNodes(store: GraphStore, path: string, sourceFile: ts.SourceFile): CollectedDeclarations {
  store.addNode(moduleScopeId(path), 'module', path, sourceFile);
  const classes: ts.ClassLikeDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (isTypeOnly(node)) return;
    registerNode(store, path, node, classes);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return { classes };
}

/**
 * 타입 전용이라 코드가 없는 노드인지 본다(하위 트리를 건너뛴다).
 *
 * @param node 노드
 * @returns 타입 노드·인터페이스·타입 별칭·ambient 선언이면 true
 */
export function isTypeOnly(node: ts.Node): boolean {
  // `class A extends mixin(B)`의 상속 식은 타입 노드 종류지만 실행되는 코드라 건너뛰지 않는다.
  if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return true;
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
  if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return true;
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

/**
 * 노드 하나가 새 id의 경계면 등록한다.
 *
 * @param store 그래프 저장소
 * @param path 프로젝트 기준 경로
 * @param node 노드
 * @param classes 클래스 수집 목록(갱신)
 */
function registerNode(store: GraphStore, path: string, node: ts.Node, classes: ts.ClassLikeDeclaration[]): void {
  if (isFunctionLike(node) && node.body !== undefined) {
    store.addNode(scopeIdOf(node.body, path), functionKind(node), path, node.name ?? node);
  } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
    store.addNode(scopeIdOf(node.initializer, path), isFunctionValued(node.initializer) ? 'function' : 'variable', path, node.name);
  } else if (ts.isPropertyDeclaration(node) && node.initializer !== undefined) {
    store.addNode(scopeIdOf(node.initializer, path), 'field', path, node.name);
  } else if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    classes.push(node);
    const probe = node.name ?? node.members[0];
    if (probe !== undefined) store.addNode(scopeIdOf(probe, path), 'class', path, node.name ?? node);
  } else if (ts.isExportAssignment(node) && node.isExportEquals !== true) {
    store.addNode(scopeIdOf(node.expression, path), 'variable', path, node);
  }
}

/**
 * 함수 계열 노드의 종류를 고른다.
 *
 * @param node 함수 계열 선언
 * @returns 노드 종류
 */
function functionKind(node: ts.FunctionLikeDeclaration): NodeKind {
  if (ts.isMethodDeclaration(node)) return 'method';
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) return 'accessor';
  return 'function';
}

/**
 * 식이 (래퍼를 벗겨) 화살표·함수 식인지 본다.
 *
 * @param expression 식
 * @returns 함수 값이면 true
 */
export function isFunctionValued(expression: ts.Expression): boolean {
  const inner = skipWrappers(expression);
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
}

/**
 * 값을 바꾸지 않는 래퍼(괄호·`as`·`satisfies`·non-null·타입 단언)를 벗긴다.
 *
 * @param expression 식
 * @returns 벗긴 식
 */
export function skipWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) {
    current = current.expression;
  }
  return current;
}
