/**
 * 호출·참조 대상 식을 그래프 노드 id로 해석한다.
 *
 * TypeChecker의 심볼로만 잇는다. import 별칭·재내보내기·기본 내보내기·`await import()`의 모듈 타입은
 * checker가 풀어 준다. 선언이 의존성·lib·생성 코드 파일에 있으면 외부(간선 없음)다. 증명하지 못한
 * 대상(매개변수 호출, 구현을 모르는 인터페이스 메서드, `any`)은 추측하지 않고 이유와 함께 미해석으로
 * 돌려준다 — 호출자는 개수만 센다.
 */

import ts from 'typescript';

import { compareStrings } from '../exchange/sorted-json.ts';
import { enclosingSymbol, isFunctionLike } from '../schema/enclosing-symbol.ts';
import type { FlowIndex } from './flow-index.ts';
import type { GraphStore, UnresolvedReason } from './graph-model.ts';
import { isFunctionValued, skipWrappers } from './node-collector.ts';
import { scopeIdOf } from './symbol-ids.ts';

/** 해석 결과다. `partial`은 일부 대상만 이었고 나머지를 증명하지 못한 이유다. */
export type Resolution =
  | { readonly kind: 'nodes'; readonly ids: readonly string[]; readonly partial?: UnresolvedReason }
  | { readonly kind: 'external'; readonly missing?: true }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason };

/** 값 별칭(`const h = g`)을 따라가는 최대 깊이다. 순환 별칭에서 끝나게 한다. */
const MAX_FOLLOW_DEPTH = 8;

/** 외부 결과(공유 상수)다. */
const external: Resolution = { kind: 'external' };

/** 타입 선언을 찾지 못한 패키지로 가는 외부 결과다(의존성 미설치 등). */
const missingExternal: Resolution = { kind: 'external', missing: true };

/**
 * 미해석 결과를 만든다.
 *
 * @param reason 이유
 * @returns 미해석 결과
 */
function unresolved(reason: UnresolvedReason): Resolution {
  return { kind: 'unresolved', reason };
}

/** 대상 해석기다. */
export class TargetResolver {
  private readonly checker: ts.TypeChecker;
  private readonly store: GraphStore;
  private readonly pathOf: (sourceFile: ts.SourceFile) => string | undefined;
  private readonly isProjectSpecifier: (specifier: string) => boolean;
  private readonly writes: Pick<FlowIndex, 'identifierWrites' | 'propertyWrites' | 'reflectiveTargets'>;

  /**
   * @param checker TypeChecker
   * @param store 노드가 모두 등록된 저장소
   * @param pathOf 노드 파일이면 프로젝트 기준 경로, 아니면 undefined
   * @param isProjectSpecifier import 지정자가 프로젝트 모듈(상대 경로·`paths` 별칭)을 가리키는지
   * @param writes 이 resolver 범위(운영 또는 전체)의 값 쓰기 색인
   */
  constructor(
    checker: ts.TypeChecker,
    store: GraphStore,
    pathOf: (sourceFile: ts.SourceFile) => string | undefined,
    isProjectSpecifier: (specifier: string) => boolean,
    writes: Pick<FlowIndex, 'identifierWrites' | 'propertyWrites' | 'reflectiveTargets'> = {
      identifierWrites: new Map(), propertyWrites: new Map(), reflectiveTargets: [],
    },
  ) {
    this.checker = checker;
    this.store = store;
    this.pathOf = pathOf;
    this.isProjectSpecifier = isProjectSpecifier;
    this.writes = writes;
  }

  /**
   * 호출·`new`·JSX 태그 식의 대상을 해석한다. 인터페이스 메서드면 수신자 초기값으로 구현을 증명해 본다.
   *
   * @param expression 호출 대상 식
   * @returns 해석 결과
   */
  resolveCallee(expression: ts.Expression): Resolution {
    const callee = skipWrappers(expression);
    const resolution = this.resolveExpression(callee, 0);
    if (resolution.kind === 'unresolved' && resolution.reason === 'untyped' && this.rootsInMissingPackage(callee)) return missingExternal;
    if (!ts.isPropertyAccessExpression(callee) || !isInterfaceGap(resolution)) return resolution;
    return this.proveFromReceiver(callee) ?? resolution;
  }

  /**
   * 함수 값 참조(콜백·일반 참조)의 대상 노드를 고른다. 함수 값 선언만 인정한다 — 일반 변수 읽기는
   * 호출 관계가 아니기 때문이다. 값 별칭(`const h = g`, `const h = obj.g`), 객체 속성 별칭
   * (`{ h: g }`, `{ g }`), 객체 구조 분해(`const { h } = obj`)는 호출과 같은 깊이 상한으로 따라간다.
   *
   * @param symbol 참조 식의 심볼
   * @returns 노드 id(정렬)
   */
  referenceTargets(symbol: ts.Symbol | undefined): string[] {
    return [...new Set(this.functionValueTargets(symbol, 0))].sort(compareStrings);
  }

  /**
   * 심볼이 가리키는 함수 값 선언의 노드 id를 모은다(별칭을 따라간다).
   *
   * @param symbol 심볼
   * @param depth 별칭 추적 깊이
   * @returns 노드 id(중복 가능)
   */
  private functionValueTargets(symbol: ts.Symbol | undefined, depth: number): string[] {
    const target = this.dealias(symbol);
    if (target === undefined || depth > MAX_FOLLOW_DEPTH) return [];
    return (target.declarations ?? []).flatMap((declaration) => {
      if (isFunctionValuedDeclaration(declaration)) {
        const resolution = this.resolveDeclaration(declaration, depth);
        if (resolution.kind === 'nodes') return resolution.ids;
        const binding = ts.isVariableDeclaration(declaration) ? this.variableBindingNode(declaration) : resolution;
        return binding.kind === 'nodes' ? binding.ids : [];
      }
      return this.functionValueTargets(this.aliasedValueSymbol(declaration), depth + 1);
    });
  }

  /**
   * 값 별칭 선언이 가리키는 다음 심볼이다: 따라갈 수 있는 초기값, 축약 속성의 값, 객체 구조 분해의 속성.
   *
   * @param declaration 선언
   * @returns 다음 심볼 또는 undefined(별칭이 아님)
   */
  private aliasedValueSymbol(declaration: ts.Declaration): ts.Symbol | undefined {
    if (ts.isShorthandPropertyAssignment(declaration)) return this.checker.getShorthandAssignmentValueSymbol(declaration);
    if (ts.isBindingElement(declaration)) {
      const name = ts.isObjectBindingPattern(declaration.parent) ? bindingPropertyName(declaration) : undefined;
      if (name === undefined || bindingRoot(declaration) === 'parameter') return undefined;
      return this.checker.getPropertyOfType(this.checker.getTypeAtLocation(declaration.parent), name);
    }
    const initializer = ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)
      ? declaration.initializer : undefined;
    return initializer === undefined ? undefined : this.expressionSymbol(skipWrappers(initializer));
  }

  /**
   * 따라갈 수 있는 식(식별자·속성 접근·리터럴 키 원소 접근)의 심볼이다.
   *
   * @param expression 래퍼를 벗긴 식
   * @returns 심볼 또는 undefined
   */
  private expressionSymbol(expression: ts.Expression): ts.Symbol | undefined {
    if (ts.isIdentifier(expression)) return this.checker.getSymbolAtLocation(expression);
    if (ts.isPropertyAccessExpression(expression)) return this.checker.getSymbolAtLocation(expression.name);
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
      return this.checker.getSymbolAtLocation(expression.argumentExpression);
    }
    return undefined;
  }

  /**
   * 심볼(별칭 포함)의 대상을 해석한다. export 노드의 `alias` 간선에도 쓴다.
   *
   * @param symbol 심볼
   * @param depth 별칭 추적 깊이
   * @returns 해석 결과
   */
  resolveSymbol(symbol: ts.Symbol | undefined, depth: number): Resolution {
    if (symbol === undefined) return unresolved('untyped');
    if (depth > MAX_FOLLOW_DEPTH) return unresolved('indirect');
    const target = this.dealias(symbol);
    if (target === undefined) return this.isMissingPackageImport(symbol) ? missingExternal : unresolved('unresolved-import');
    const declarations = target.declarations ?? [];
    if (declarations.length === 0) return unresolved('untyped');
    if (declarations.some((declaration) => isFunctionLike(declaration) && declaration.body !== undefined && this.hasSymbolWrite(target))) {
      return unresolved('indirect');
    }
    const hasBody = declarations.some((declaration) => isFunctionLike(declaration) && declaration.body !== undefined);
    const candidates = declarations.filter((declaration) => !hasBody || !isFunctionLike(declaration) || declaration.body !== undefined);
    return mergeResolutions(candidates.map((declaration) => this.resolveDeclaration(declaration, depth)));
  }

  /** export 별칭만을 위해 변수 초기화 노드의 안정 id를 보존한다. 호출 대상 해석에는 쓰지 않는다. */
  resolveExportSymbol(symbol: ts.Symbol | undefined, depth: number): Resolution {
    const target = this.dealias(symbol);
    const binding = target?.valueDeclaration;
    if (binding !== undefined && ts.isBindingElement(binding)) return this.resolveExportBinding(binding, depth);
    const resolution = this.resolveSymbol(symbol, depth);
    if (resolution.kind !== 'unresolved' || resolution.reason !== 'indirect') return resolution;
    const declaration = target?.valueDeclaration;
    if (!target || !declaration || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return resolution;
    return this.variableBindingNode(declaration);
  }

  /**
   * 클래스의 생성 대상(본문 있는 생성자, 없으면 클래스 노드)을 해석한다.
   *
   * @param declaration 클래스 선언·식
   * @returns 해석 결과
   */
  constructorTarget(declaration: ts.ClassLikeDeclaration): Resolution {
    const path = this.pathOf(declaration.getSourceFile());
    if (path === undefined) return external;
    const constructor = declaration.members.find((member): member is ts.ConstructorDeclaration =>
      ts.isConstructorDeclaration(member) && member.body !== undefined);
    if (constructor !== undefined) return this.node(scopeIdOf(constructor.body!, path));
    const probe = declaration.name ?? declaration.members[0];
    return probe === undefined ? unresolved('indirect') : this.node(scopeIdOf(probe, path));
  }

  /**
   * 식(식별자·속성 접근·리터럴 키 원소 접근)의 대상을 해석한다.
   *
   * @param expression 래퍼를 벗긴 식
   * @param depth 별칭 추적 깊이
   * @returns 해석 결과
   */
  private resolveExpression(expression: ts.Expression, depth: number): Resolution {
    if (ts.isIdentifier(expression)) return this.resolveSymbol(this.checker.getSymbolAtLocation(expression), depth);
    if (ts.isPropertyAccessExpression(expression)) {
      const resolution = this.resolveSymbol(this.checker.getSymbolAtLocation(expression.name), depth);
      const mutable = this.isReflectivelyMutable(expression.expression)
        || this.hasPotentialPropertyWrite(expression.expression, expression.name.text);
      return resolution.kind === 'nodes' && mutable ? unresolved('indirect') : resolution;
    }
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
      const resolution = this.resolveSymbol(this.checker.getSymbolAtLocation(expression.argumentExpression), depth);
      const mutable = this.isReflectivelyMutable(expression.expression)
        || this.hasPotentialPropertyWrite(expression.expression, expression.argumentExpression.text);
      return resolution.kind === 'nodes' && mutable ? unresolved('indirect') : resolution;
    }
    return unresolved('computed');
  }

  /**
   * 선언 하나의 대상을 해석한다.
   *
   * @param declaration 선언
   * @param depth 별칭 추적 깊이
   * @returns 해석 결과
   */
  private resolveDeclaration(declaration: ts.Declaration, depth: number): Resolution {
    const path = this.pathOf(declaration.getSourceFile());
    if (path === undefined || isAmbient(declaration)) return external;
    if (isDecoratedMember(declaration)) return unresolved('indirect');
    if (ts.isGetAccessorDeclaration(declaration)) {
      if (declaration.body === undefined) return unresolved('interface');
      const direct = this.node(scopeIdOf(declaration.body, path));
      return direct.kind === 'nodes' ? { ...direct, partial: 'indirect' } : direct;
    }
    if (isFunctionLike(declaration)) {
      return declaration.body === undefined ? unresolved('interface') : this.node(scopeIdOf(declaration.body, path));
    }
    if (ts.isPropertySignature(declaration)
      && this.checker.getNonNullableType(this.checker.getTypeAtLocation(declaration)).getCallSignatures().length > 0) {
      return unresolved('indirect');
    }
    if (isSignature(declaration)) return unresolved('interface');
    if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return this.constructorTarget(declaration);
    if (ts.isVariableDeclaration(declaration)) return this.resolveVariable(declaration, path, depth);
    if (ts.isBindingElement(declaration)) return this.resolveBinding(declaration, depth);
    if (ts.isParameter(declaration)) return unresolved('parameter');
    return this.resolveOtherDeclaration(declaration, path, depth);
  }

  /**
   * 속성·필드·기본 내보내기·import 계열 선언을 해석한다.
   *
   * @param declaration 선언
   * @param path 프로젝트 기준 경로
   * @param depth 별칭 추적 깊이
   * @returns 해석 결과
   */
  private resolveOtherDeclaration(declaration: ts.Declaration, path: string, depth: number): Resolution {
    if (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) {
      if (ts.isPropertyDeclaration(declaration) && isDecoratedMember(declaration)) return unresolved('indirect');
      return this.resolveInitialized(declaration.initializer, path, depth, ts.isPropertyDeclaration(declaration) ? declaration.name : undefined);
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      return this.resolveSymbol(this.checker.getShorthandAssignmentValueSymbol(declaration), depth + 1);
    }
    if (ts.isExportAssignment(declaration)) {
      const expression = skipWrappers(declaration.expression);
      return isFollowable(expression) ? this.resolveExpression(expression, depth + 1) : this.node(`${path}#default`);
    }
    if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)
      || ts.isExportSpecifier(declaration)) {
      return unresolved('unresolved-import');
    }
    return unresolved('indirect');
  }

  /**
   * 초기값이 있는 속성·필드를 해석한다: 함수 값이면 그 함수, 별칭이면 따라가고, 필드면 필드 노드다.
   *
   * @param initializer 초기값
   * @param path 프로젝트 기준 경로
   * @param depth 별칭 추적 깊이
   * @param fieldName 클래스 필드 이름(필드 노드 id용), 객체 속성이면 undefined
   * @returns 해석 결과
   */
  private resolveInitialized(initializer: ts.Expression | undefined, path: string, depth: number, fieldName: ts.PropertyName | undefined): Resolution {
    if (initializer === undefined) return unresolved('indirect');
    const inner = skipWrappers(initializer);
    if (isFunctionValued(inner)) return this.node(scopeIdOf((inner as ts.ArrowFunction | ts.FunctionExpression).body, path));
    if (isFollowable(inner)) {
      const followed = this.resolveExpression(inner, depth + 1);
      if (followed.kind !== 'unresolved') return followed;
    }
    return fieldName === undefined ? unresolved('indirect') : this.node(scopeIdOf(initializer, path));
  }

  /**
   * 변수 선언을 해석한다. 함수 값이면 그 함수, 별칭이면 따라가고, 이름 있는 노드면(모듈 최상위 변수,
   * 함수를 품은 초기값) 그 노드다. 지역 결과 변수 같은 값은 증명하지 못한다.
   *
   * @param declaration 변수 선언
   * @param path 프로젝트 기준 경로
   * @param depth 별칭 추적 깊이
   * @returns 해석 결과
   */
  private resolveVariable(declaration: ts.VariableDeclaration, path: string, depth: number): Resolution {
    if (!ts.isIdentifier(declaration.name)) return unresolved('indirect');
    const initializer = declaration.initializer === undefined ? undefined : skipWrappers(declaration.initializer);
    const immutable = ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
    if (immutable && initializer !== undefined && isFunctionValued(initializer)) {
      return this.node(scopeIdOf((initializer as ts.ArrowFunction | ts.FunctionExpression).body, path));
    }
    if (immutable && initializer !== undefined && isFollowable(initializer)) {
      const followed = this.resolveExpression(initializer, depth + 1);
      if (followed.kind !== 'unresolved') return followed;
    }
    // 호출·객체·그 밖의 계산값으로 초기화한 변수는 그 자체가 호출 가능 선언이 아니다.
    // 반환 callback을 값 흐름으로 증명할 수 있도록 공백으로 남기고 변수 초기화 노드를 호출 대상으로 꾸미지 않는다.
    return unresolved('indirect');
  }

  /** 변수의 안정 binding 노드를 구한다. export/reference 의미에만 쓰고 호출 대상으로는 쓰지 않는다. */
  private variableBindingNode(declaration: ts.VariableDeclaration): Resolution {
    if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return unresolved('indirect');
    const path = this.pathOf(declaration.getSourceFile());
    if (path === undefined) return external;
    const outer = enclosingSymbol(declaration.name, path);
    const candidate = outer === undefined ? `${path}#${declaration.name.text}` : `${outer}.${declaration.name.text}`;
    return this.store.hasNode(candidate) ? { kind: 'nodes', ids: [candidate] } : unresolved('indirect');
  }

  /**
   * 구조 분해 바인딩을 해석한다. 객체 패턴이면 초기값 타입의 같은 이름 속성으로 잇는다
   * (`const { GET } = handlers`, `const { f } = await import('./m')`). 매개변수 구조 분해는 매개변수다.
   *
   * @param element 바인딩 요소
   * @param depth 별칭 추적 깊이
   * @returns 해석 결과
   */
  private resolveBinding(element: ts.BindingElement, depth: number): Resolution {
    if (bindingRoot(element) === 'parameter') return unresolved('parameter');
    const source = bindingSourceExpression(element);
    const name = ts.isObjectBindingPattern(element.parent) ? bindingPropertyName(element) : undefined;
    if (source !== undefined && name !== undefined && isFollowable(source)
      && (this.isReflectivelyMutable(source) || this.hasPotentialPropertyWrite(source, name))) return unresolved('indirect');
    return this.resolveBindingProperty(element, depth);
  }

  /** export 노드 전용으로 구조 분해 바인딩의 선언 대상을 푼다. */
  private resolveExportBinding(element: ts.BindingElement, depth: number): Resolution {
    if (bindingRoot(element) === 'parameter') return unresolved('parameter');
    return this.resolveBindingProperty(element, depth);
  }

  /** 구조 분해 바인딩의 타입 속성을 선언 대상으로 푼다. */
  private resolveBindingProperty(element: ts.BindingElement, depth: number): Resolution {
    const pattern = element.parent;
    const name = ts.isObjectBindingPattern(pattern) ? bindingPropertyName(element) : undefined;
    if (name === undefined) return unresolved('indirect');
    const property = this.checker.getPropertyOfType(this.checker.getTypeAtLocation(pattern), name);
    return this.resolveSymbol(property, depth + 1);
  }

  /**
   * 인터페이스 메서드 호출의 수신자가 `new C()`·객체 리터럴로 초기화된 `const`·`readonly` 필드면 그 값의
   * 타입에서 같은 이름 멤버를 찾는다. 그 밖은 증명하지 못한다.
   *
   * @param access 호출 대상 속성 접근
   * @returns 증명한 대상 또는 undefined
   */
  private proveFromReceiver(access: ts.PropertyAccessExpression): Resolution | undefined {
    const receiver = skipWrappers(access.expression);
    const location = ts.isPropertyAccessExpression(receiver) ? receiver.name : receiver;
    const initializer = fixedInitializer(this.checker.getSymbolAtLocation(location)?.valueDeclaration);
    if (initializer === undefined) return undefined;
    const property = this.checker.getPropertyOfType(this.checker.getTypeAtLocation(initializer), access.name.text);
    const proven = this.resolveSymbol(property, 1);
    const mutable = this.isReflectivelyMutable(receiver) || this.hasPotentialPropertyWrite(receiver, access.name.text);
    return proven.kind === 'nodes' && proven.partial === undefined && !mutable ? proven : undefined;
  }

  /**
   * 풀리지 않는 별칭이 프로젝트 밖 패키지 import인지 본다. 패키지의 타입 선언이 없을 뿐(의존성 미설치,
   * 타입 없는 패키지) 프로젝트 코드의 공백이 아니므로 외부로 센다.
   *
   * @param symbol 별칭 심볼
   * @returns 패키지 import면 true
   */
  private isMissingPackageImport(symbol: ts.Symbol): boolean {
    const specifier = importSpecifierOf(symbol.declarations?.[0]);
    return specifier !== undefined && !this.isProjectSpecifier(specifier);
  }

  /**
   * 식의 뿌리 식별자(`a.b().c`의 `a`)가 타입 선언을 찾지 못한 패키지 import인지 본다.
   *
   * @param expression 호출 대상 식
   * @returns 그렇다면 true
   */
  private rootsInMissingPackage(expression: ts.Expression): boolean {
    let current: ts.Expression = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current) || ts.isCallExpression(current)
      || ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    }
    if (!ts.isIdentifier(current)) return false;
    const symbol = this.checker.getSymbolAtLocation(current);
    return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 && this.dealias(symbol) === undefined
      && this.isMissingPackageImport(symbol);
  }

  /** 함수 선언 심볼에 값 대입이 있는지 본다. */
  private hasSymbolWrite(symbol: ts.Symbol): boolean {
    return (this.writes.identifierWrites.get(symbol)?.length ?? 0) > 0;
  }

  /** 같은 이름 쓰기 중 호출 수신자와 겹칠 수 있는 것이 있는지 본다. */
  private hasPotentialPropertyWrite(receiver: ts.Expression, name: string): boolean {
    return (this.writes.propertyWrites.get(name) ?? [])
      .some((write) => !this.expressionsProvablyDisjoint(receiver, write.target.expression));
  }

  /**
   * 반사적 쓰기 대상과 같은 수신자이거나 대상을 정적으로 식별할 수 없으면 멤버의 선언 전 본문을 직접 잇지 않는다.
   * dispatch 값 흐름이 실제 수신자와 겹치지 않음을 증명할 때만 bound로 복구한다.
   */
  private isReflectivelyMutable(receiver: ts.Expression): boolean {
    if (this.writes.reflectiveTargets.length === 0) return false;
    return this.writes.reflectiveTargets.some((target) => !this.expressionsProvablyDisjoint(receiver, target));
  }

  /** 두 수신자 식이 같은 객체를 가리킬 수 없음을 할당·클래스 정체성으로 증명한다. */
  private expressionsProvablyDisjoint(left: ts.Expression, right: ts.Expression): boolean {
    const leftIdentities = this.expressionIdentities(left);
    const rightIdentities = this.expressionIdentities(right);
    if (leftIdentities.length === 0 || rightIdentities.length === 0) return false;
    if (leftIdentities.some((identity) => rightIdentities.includes(identity))) return false;
    const leftPrimary = this.expressionIdentity(left);
    const rightPrimary = this.expressionIdentity(right);
    if (leftPrimary === undefined || rightPrimary === undefined) return false;
    if (isObjectAllocation(leftPrimary) && isObjectAllocation(rightPrimary)) return leftPrimary !== rightPrimary;
    if ((isNodeIdentity(leftPrimary) && ts.isObjectLiteralExpression(leftPrimary))
      || (isNodeIdentity(rightPrimary) && ts.isObjectLiteralExpression(rightPrimary))) return true;
    const leftClass = this.identityClass(leftPrimary);
    const rightClass = this.identityClass(rightPrimary);
    if (leftClass === undefined || rightClass === undefined) return false;
    const leftLineage = this.classLineage(leftClass);
    const rightLineage = this.classLineage(rightClass);
    return leftLineage !== undefined && rightLineage !== undefined
      && !leftLineage.some((declaration) => rightLineage.includes(declaration));
  }

  /** 정체성이 나타내는 클래스(`this` 또는 `new C`)다. */
  private identityClass(identity: ts.Node | ts.Symbol): ts.ClassLikeDeclaration | undefined {
    if (!isNodeIdentity(identity)) return undefined;
    if (ts.isClassLike(identity)) return identity;
    if (!ts.isNewExpression(identity)) return undefined;
    const callee = skipWrappers(identity.expression);
    if (ts.isClassExpression(callee)) return callee;
    const symbol = this.dealias(this.expressionSymbol(callee));
    return symbol?.declarations?.find(ts.isClassLike);
  }

  /** 클래스와 해석 가능한 기반 클래스 계보. 계산된 기반을 풀지 못하면 undefined다. */
  private classLineage(declaration: ts.ClassLikeDeclaration): readonly ts.ClassLikeDeclaration[] | undefined {
    const result: ts.ClassLikeDeclaration[] = [];
    const seen = new Set<ts.ClassLikeDeclaration>();
    let current: ts.ClassLikeDeclaration | undefined = declaration;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      result.push(current);
      const base: ts.Expression | undefined = current.heritageClauses
        ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
      if (base === undefined) break;
      const symbol = this.dealias(this.expressionSymbol(skipWrappers(base)));
      const next = symbol?.declarations?.find(ts.isClassLike);
      if (next === undefined) return undefined;
      current = next;
    }
    return result;
  }

  /** 수신자와 그 속성 사슬의 각 접두사를 반사적 쓰기 대상 비교용 정체성으로 바꾼다. */
  private expressionIdentities(expression: ts.Expression): (ts.Node | ts.Symbol)[] {
    const result: (ts.Node | ts.Symbol)[] = [];
    let current = skipWrappers(expression);
    while (true) {
      const identity = this.expressionIdentity(current);
      if (identity !== undefined) result.push(identity);
      if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = skipWrappers(current.expression);
      else break;
    }
    return result;
  }

  /** 반사적 쓰기 대상 비교에 쓸 선언·객체 값·심볼 정체성이다. */
  private expressionIdentity(
    expression: ts.Expression,
    seen: ReadonlySet<ts.Symbol> = new Set(),
    depth = 0,
  ): ts.Node | ts.Symbol | undefined {
    if (depth > MAX_FOLLOW_DEPTH) return undefined;
    const inner = skipWrappers(expression);
    if (inner.kind === ts.SyntaxKind.ThisKeyword) return ts.findAncestor(inner, ts.isClassLike);
    if (ts.isObjectLiteralExpression(inner) || ts.isNewExpression(inner)) return inner;
    if (ts.isIdentifier(inner)) {
      const symbol = this.dealias(this.checker.getSymbolAtLocation(inner));
      if (symbol === undefined || seen.has(symbol) || this.hasSymbolWrite(symbol)) return undefined;
      const declaration = symbol.valueDeclaration;
      const immutableVariable = declaration !== undefined && ts.isVariableDeclaration(declaration)
        && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
      const readonlyProperty = declaration !== undefined && ts.isPropertyDeclaration(declaration)
        && (ts.getModifiers(declaration) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
      if ((immutableVariable || readonlyProperty) && declaration !== undefined && declaration.initializer !== undefined) {
        const nextSeen = new Set(seen);
        nextSeen.add(symbol);
        return this.expressionIdentity(declaration.initializer, nextSeen, depth + 1);
      }
      return symbol;
    }
    if (ts.isPropertyAccessExpression(inner)) return this.dealias(this.checker.getSymbolAtLocation(inner.name));
    if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(inner.argumentExpression)) {
      return this.dealias(this.checker.getSymbolAtLocation(inner.argumentExpression));
    }
    return undefined;
  }

  /**
   * 별칭 심볼을 실제 심볼로 푼다.
   *
   * @param symbol 심볼
   * @returns 실제 심볼. 풀리지 않는 import면 undefined
   */
  private dealias(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    const target = this.checker.getAliasedSymbol(symbol);
    return (target.declarations ?? []).length === 0 ? undefined : target;
  }

  /**
   * id가 등록된 노드면 노드 결과, 아니면 미해석(간접)이다.
   *
   * @param id 노드 id
   * @returns 해석 결과
   */
  private node(id: string): Resolution {
    return this.store.hasNode(id) ? { kind: 'nodes', ids: [id] } : unresolved('indirect');
  }
}

/**
 * 여러 선언의 결과를 합친다. 노드가 하나라도 있으면 노드(나머지 미해석은 partial), 없으면 첫 미해석,
 * 그것도 없으면 외부다.
 *
 * @param resolutions 선언별 결과
 * @returns 합친 결과
 */
export function mergeResolutions(resolutions: readonly Resolution[]): Resolution {
  const ids = new Set<string>();
  let firstGap: UnresolvedReason | undefined;
  let missing = false;
  for (const resolution of resolutions) {
    if (resolution.kind === 'nodes') resolution.ids.forEach((id) => ids.add(id));
    if (resolution.kind === 'external' && resolution.missing === true) missing = true;
    const gap = resolution.kind === 'unresolved' ? resolution.reason : resolution.kind === 'nodes' ? resolution.partial : undefined;
    firstGap ??= gap;
  }
  if (ids.size > 0) {
    const sorted = [...ids].sort(compareStrings);
    return firstGap === undefined ? { kind: 'nodes', ids: sorted } : { kind: 'nodes', ids: sorted, partial: firstGap };
  }
  if (firstGap !== undefined) return unresolved(firstGap);
  return missing ? missingExternal : external;
}

/**
 * 별칭 선언(import 지정자·절, 재내보내기 지정자, JS `require`)의 모듈 지정자 텍스트다.
 *
 * @param declaration 별칭 선언
 * @returns 지정자 또는 undefined
 */
function importSpecifierOf(declaration: ts.Declaration | undefined): string | undefined {
  if (declaration === undefined) return undefined;
  const owner = ts.findAncestor(declaration, (node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
    || ts.isImportEqualsDeclaration(node) || ts.isVariableDeclaration(node));
  if (owner === undefined) return undefined;
  const specifier = ts.isImportDeclaration(owner) || ts.isExportDeclaration(owner) ? owner.moduleSpecifier
    : ts.isImportEqualsDeclaration(owner) && ts.isExternalModuleReference(owner.moduleReference) ? owner.moduleReference.expression
      : ts.isVariableDeclaration(owner) && owner.initializer !== undefined && ts.isCallExpression(owner.initializer) ? owner.initializer.arguments[0]
        : undefined;
  return specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
}

/**
 * 결과가 인터페이스 공백(전부 또는 일부)인지 본다.
 *
 * @param resolution 해석 결과
 * @returns 인터페이스 이유가 있으면 true
 */
export function isInterfaceGap(resolution: Resolution): boolean {
  return (resolution.kind === 'unresolved' && resolution.reason === 'interface')
    || (resolution.kind === 'nodes' && resolution.partial === 'interface');
}

/**
 * `declare`로 선언된(또는 `declare module`·`declare global` 안의) 선언인지 본다. 구현이 다른 곳에 있다.
 *
 * @param declaration 선언
 * @returns ambient면 true
 */
function isAmbient(declaration: ts.Node): boolean {
  return ts.findAncestor(declaration, (node) => ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) !== undefined;
}

/**
 * 구현이 없는 멤버 시그니처인지 본다.
 *
 * @param declaration 선언
 * @returns 인터페이스·타입 리터럴 멤버면 true
 */
function isSignature(declaration: ts.Declaration): boolean {
  return ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration) || ts.isCallSignatureDeclaration(declaration)
    || ts.isConstructSignatureDeclaration(declaration) || ts.isIndexSignatureDeclaration(declaration);
}

/**
 * 별칭으로 따라갈 수 있는 식(식별자·속성 접근·리터럴 키 원소 접근)인지 본다.
 *
 * @param expression 래퍼를 벗긴 식
 * @returns 따라갈 수 있으면 true
 */
function isFollowable(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) || ts.isPropertyAccessExpression(expression)
    || (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression));
}

/** 정체성 값이 AST 노드인지 본다. */
function isNodeIdentity(identity: ts.Node | ts.Symbol): identity is ts.Node {
  return 'kind' in identity;
}

/** 정체성 값이 매 평가마다 고유한 객체 할당인지 본다. */
function isObjectAllocation(identity: ts.Node | ts.Symbol): identity is ts.ObjectLiteralExpression | ts.NewExpression {
  return isNodeIdentity(identity) && (ts.isObjectLiteralExpression(identity) || ts.isNewExpression(identity));
}

/** 멤버나 소유 클래스의 데코레이터가 런타임 값을 바꿀 수 있는지 본다. */
function isDecoratedMember(declaration: ts.Declaration): boolean {
  if (ts.canHaveDecorators(declaration) && (ts.getDecorators(declaration) ?? []).length > 0) return true;
  const owner = declaration.parent;
  if (!ts.isClassLike(owner)) return false;
  if ((ts.getDecorators(owner) ?? []).length > 0) return true;
  return owner.members.some((member) => ts.isConstructorDeclaration(member)
    && member.parameters.some((parameter) => (ts.getDecorators(parameter) ?? []).length > 0));
}

/**
 * 함수 값 선언인지 본다(참조 간선 대상).
 *
 * @param declaration 선언
 * @returns 본문 있는 함수 계열이거나 함수 값 초기값이면 true
 */
function isFunctionValuedDeclaration(declaration: ts.Declaration): boolean {
  if (isFunctionLike(declaration)) return declaration.body !== undefined;
  if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) {
    return declaration.initializer !== undefined && isFunctionValued(declaration.initializer);
  }
  return false;
}

/**
 * 구조 분해 요소가 속한 최상위 선언의 종류다.
 *
 * @param element 바인딩 요소
 * @returns 매개변수면 'parameter', 아니면 'variable'
 */
function bindingRoot(element: ts.BindingElement): 'parameter' | 'variable' {
  let current: ts.Node = element.parent.parent;
  while (ts.isBindingElement(current)) current = current.parent.parent;
  return ts.isParameter(current) ? 'parameter' : 'variable';
}

/** 구조 분해 변수 선언의 원본 식이다. */
function bindingSourceExpression(element: ts.BindingElement): ts.Expression | undefined {
  let owner: ts.Node = element.parent.parent;
  while (ts.isBindingElement(owner)) owner = owner.parent.parent;
  return ts.isVariableDeclaration(owner) && owner.initializer !== undefined ? skipWrappers(owner.initializer) : undefined;
}

/**
 * 객체 구조 분해 요소가 읽는 속성 이름이다.
 *
 * @param element 바인딩 요소
 * @returns 속성 이름 또는 undefined(계산된 이름)
 */
function bindingPropertyName(element: ts.BindingElement): string | undefined {
  const name = element.propertyName ?? element.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * 다시 대입될 수 없는 `const` 변수·`readonly` 필드의 `new`·객체 리터럴 초기값이다.
 *
 * @param declaration 수신자 선언
 * @returns 초기값 또는 undefined
 */
function fixedInitializer(declaration: ts.Declaration | undefined): ts.Expression | undefined {
  if (declaration === undefined) return undefined;
  const isConst = ts.isVariableDeclaration(declaration) && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
  const isReadonly = ts.isPropertyDeclaration(declaration)
    && (ts.getModifiers(declaration) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword);
  if (!isConst && !isReadonly) return undefined;
  const initializer = (declaration as ts.VariableDeclaration | ts.PropertyDeclaration).initializer;
  if (initializer === undefined) return undefined;
  const inner = skipWrappers(initializer);
  return ts.isNewExpression(inner) || ts.isObjectLiteralExpression(inner) ? inner : undefined;
}
