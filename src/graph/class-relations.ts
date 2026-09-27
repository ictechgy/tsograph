/**
 * 클래스가 만드는 암묵 간선과 메서드 재정의 표다.
 *
 * - 생성(생성자 또는 클래스 노드) → 인스턴스 필드 초기값: `new C()`가 필드 초기값을 실행하기 때문이다
 *   (함수 값 필드는 본문을 실행하지 않으므로 제외).
 * - 모듈 스코프 → static 필드 초기값: 클래스 정의 시점(모듈 로드)에 실행된다.
 * - 생성자가 없는 파생 클래스 → 기반 생성: 암묵 `super()`다. 명시 생성자의 `super(...)`는 호출 간선이다.
 * - 재정의 표(기반 메서드 → 재정의 메서드)는 간선을 만들지 않고, 기반 타입으로 부른 호출을 셀 때만 쓴다
 *   (어느 구현이 실행될지 증명하지 못하므로).
 */

import ts from 'typescript';

import { memberName } from '../schema/scope-builder.ts';
import type { GraphStore } from './graph-model.ts';
import { isFunctionValued } from './node-collector.ts';
import { moduleScopeId, scopeIdOf } from './symbol-ids.ts';
import type { TargetResolver } from './target-resolver.ts';

/**
 * 클래스 하나의 암묵 간선을 더한다.
 *
 * @param store 그래프 저장소
 * @param resolver 대상 해석기
 * @param path 프로젝트 기준 경로
 * @param declaration 클래스 선언·식
 */
export function addClassEdges(store: GraphStore, resolver: TargetResolver, path: string, declaration: ts.ClassLikeDeclaration): void {
  const construction = resolver.constructorTarget(declaration);
  if (construction.kind !== 'nodes') return;
  const owner = construction.ids[0]!;
  for (const member of declaration.members) {
    // 함수 값 필드(`handle = () => …`)는 생성 때 함수를 만들 뿐 본문을 실행하지 않는다.
    if (!ts.isPropertyDeclaration(member) || member.initializer === undefined || isFunctionValued(member.initializer)) continue;
    const from = isStatic(member) ? moduleScopeId(path) : owner;
    store.addEdge(from, scopeIdOf(member.initializer, path), 'initializer');
  }
  const hasConstructor = declaration.members.some((member) => ts.isConstructorDeclaration(member) && member.body !== undefined);
  const base = extendsExpression(declaration);
  if (hasConstructor || base === undefined) return;
  const baseTarget = resolver.resolveCallee(base);
  if (baseTarget.kind === 'nodes') baseTarget.ids.forEach((id) => store.addEdge(owner, id, 'initializer'));
}

/**
 * 재정의 표에 클래스 하나의 메서드를 더한다.
 *
 * @param overrides 기반 메서드 id → 재정의 메서드 id(갱신)
 * @param checker TypeChecker
 * @param resolver 대상 해석기
 * @param path 프로젝트 기준 경로
 * @param declaration 클래스 선언·식
 */
export function addOverrides(
  overrides: Map<string, string[]>,
  checker: ts.TypeChecker,
  resolver: TargetResolver,
  path: string,
  declaration: ts.ClassLikeDeclaration,
): void {
  if (extendsExpression(declaration) === undefined) return;
  const type = checker.getTypeAtLocation(declaration.name ?? declaration);
  if (!type.isClassOrInterface()) return;
  const bases = checker.getBaseTypes(type);
  for (const member of declaration.members) {
    if (!ts.isMethodDeclaration(member) || member.body === undefined || isStatic(member)) continue;
    const name = memberName(member.name);
    if (name === undefined) continue;
    const overriding = scopeIdOf(member.body, path);
    for (const base of bases) {
      const resolution = resolver.resolveSymbol(base.getProperty(name), 0);
      if (resolution.kind !== 'nodes') continue;
      for (const id of resolution.ids.filter((candidate) => candidate !== overriding)) {
        overrides.set(id, [...(overrides.get(id) ?? []), overriding]);
      }
    }
  }
}

/**
 * 클래스의 `extends` 식이다.
 *
 * @param declaration 클래스 선언·식
 * @returns 기반 클래스 식 또는 undefined
 */
function extendsExpression(declaration: ts.ClassLikeDeclaration): ts.Expression | undefined {
  return declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
}

/**
 * static 멤버인지 본다.
 *
 * @param member 클래스 멤버
 * @returns static이면 true
 */
function isStatic(member: ts.ClassElement): boolean {
  return (ts.canHaveModifiers(member) ? ts.getModifiers(member) ?? [] : []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}
