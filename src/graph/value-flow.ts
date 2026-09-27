/**
 * bound 디스패치용 요구 기반(demand-driven) 전체 프로그램 값 흐름 분석이다.
 *
 * 식 하나에 흘러들 수 있는 **추상 값**(프로젝트 클래스의 인스턴스, 객체 리터럴 하나)의 집합을 구한다.
 * 문맥에 민감하지 않은(context-insensitive) 합집합이라 과대 근사이고, 증명하지 못한 흐름이 하나라도
 * 섞이면 결과 전체를 "모름"(`null`)으로 돌려준다 — 호출자는 모름이면 bound 간선을 만들지 않는다.
 *
 * 따라가는 흐름:
 * - `new C(...)`(프로젝트 클래스), 객체 리터럴, `this`(감싼 클래스와 프로젝트 하위 클래스).
 * - 변수: 초기값 + 모든 대입. 매개변수: 기본값 + 모든 호출 위치의 같은 자리 인자(함수 선언·`const` 함수·
 *   생성자만 — 메서드·콜백은 호출자를 다 알 수 없어 모름). 구조 분해 바인딩: 원본 값의 같은 이름 속성.
 * - 속성 `a.b`: `a`의 각 값에서 — 객체 리터럴이면 그 속성 초기값, 클래스 인스턴스면 필드 초기값·매개변수
 *   속성·getter 반환값 — 에 이름이 같은 모든 속성 쓰기(`x.b = e`, 관계없는 클래스의 필드 쓰기는 제외)를 더한다.
 * - 호출 `f(...)`: 호출 대상 함수(인터페이스 메서드면 수신자 값의 구현)의 모든 `return` 값. `await`는 통과.
 * - `?:`·`??`·`||`·`&&`·쉼표·대입식은 해당 피연산자의 합집합.
 *
 * 열린 자리(흐름을 다 볼 수 없는 곳)는 `FlowPolicy`가 정한다: 진입점·외부 공개 함수의 매개변수, 외부가 쓸 수
 * 있는 속성 등. 순환은 스택으로 끊고, 순환 일부로 계산된 중간 결과는 메모하지 않는다(SCC의 뿌리만 메모).
 * 질의당 단계·깊이 예산을 넘으면 모름이다.
 */

import ts from 'typescript';

import { memberName } from '../schema/scope-builder.ts';
import { climbWrappers, type FlowIndex, type PropertyWrite } from './flow-index.ts';
import { isFunctionValued, skipWrappers } from './node-collector.ts';

/** 추상 값: 프로젝트 클래스의 인스턴스, 또는 객체 리터럴 하나가 만든 객체다. */
export type AbstractValue = ts.ClassLikeDeclaration | ts.ObjectLiteralExpression;

/** 값 집합이다. `null`은 모르는 값이 섞였다는 뜻이다. */
export type Flow = ReadonlySet<AbstractValue> | null;

/** 흐름이 열린 자리를 정하는 정책이다. */
export interface FlowPolicy {
  /** 노드 파일(프로젝트 소스)인지 */
  isProjectFile(sourceFile: ts.SourceFile): boolean;
  /** 프로젝트 밖(프레임워크·스캔 밖 코드)이 부를 수 있어 호출 위치를 다 볼 수 없는 함수·클래스인지 */
  isOpenCallable(declaration: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration): boolean;
  /** 하위 클래스가 재정의한 메서드인지(정적 해석 대상이 실행된다는 보장이 없다) */
  isOverridden(method: ts.MethodDeclaration): boolean;
  /** 스캔 밖 코드가 비공개가 아닌 속성을 쓸 수 있다고 보는지(공개 패키지·불완전 스캔) */
  readonly openProperties: boolean;
}

/** 질의 하나의 최대 단계 수다. 넘으면 모름이다. */
const MAX_STEPS = 20_000;

/** 질의 하나의 최대 재귀 깊이다(스택 보호). */
const MAX_DEPTH = 256;

/** 빈 값 집합(공유)이다. */
const EMPTY: ReadonlySet<AbstractValue> = new Set();

/** 예산 초과 신호다. */
class BudgetExceeded extends Error {}

/** 메모 단위(심볼·함수 반환)의 키다. */
type UnitKey = ts.Symbol | ts.Node;

/** 호출 위치 목록이다. `null`은 호출자를 다 볼 수 없다는 뜻이다. */
type CallSites = readonly (readonly ts.Expression[])[] | null;

/**
 * 두 흐름을 합친다.
 *
 * @param left 흐름
 * @param right 흐름
 * @returns 합집합(어느 한쪽이 모름이면 모름)
 */
export function unionFlows(left: Flow, right: Flow): Flow {
  if (left === null || right === null) return null;
  if (right.size === 0) return left;
  if (left.size === 0) return right;
  return new Set([...left, ...right]);
}

/** 값 흐름 분석기다. 결과는 분석기 수명 동안 메모한다. */
export class ValueFlow {
  private readonly checker: ts.TypeChecker;
  private readonly index: FlowIndex;
  private readonly policy: FlowPolicy;
  /** 완결된 메모 단위 결과 */
  private readonly memo = new Map<UnitKey, Flow>();
  /** 계산 중인 메모 단위 → 스택 위치 */
  private readonly active = new Map<UnitKey, number>();
  /** 현재 계산이 기댄 가장 낮은 계산 중 단위의 스택 위치 */
  private lowestOpen = Number.POSITIVE_INFINITY;
  private steps = 0;
  private depth = 0;
  /** 호출 위치(함수·클래스별) 메모 */
  private readonly sitesMemo = new Map<ts.Node, CallSites>();
  /** 반사적 쓰기 대상 값(지연 계산) */
  private reflective: Flow | undefined;

  /**
   * @param checker TypeChecker
   * @param index 전체 프로그램 색인
   * @param policy 열린 자리 정책
   */
  constructor(checker: ts.TypeChecker, index: FlowIndex, policy: FlowPolicy) {
    this.checker = checker;
    this.index = index;
    this.policy = policy;
  }

  /**
   * 식에 흘러들 수 있는 값을 구한다(질의 진입점).
   *
   * @param expression 식
   * @returns 값 집합, 모르면 null
   */
  valuesOf(expression: ts.Expression): Flow {
    this.ensureReflective();
    return this.query(() => this.expressionValues(expression));
  }

  /**
   * 추상 값에서 이름 있는 멤버를 부를 때 실행되는 대상 심볼을 구한다. 이름이 같은 속성 쓰기(몽키 패치)가
   * 있거나 반사적 쓰기 대상이면 증명하지 못한다.
   *
   * @param value 추상 값
   * @param name 멤버 이름
   * @returns 멤버 심볼, 증명하지 못하면 undefined
   */
  memberSymbol(value: AbstractValue, name: string): ts.Symbol | undefined {
    this.ensureReflective();
    if (this.isReflectivelyWritten(value)) return undefined;
    const owner = ts.isClassLike(value) ? value : undefined;
    if ((this.index.propertyWrites.get(name) ?? []).some((write) => !this.isUnrelatedClassWrite(write, owner))) return undefined;
    return this.checker.getPropertyOfType(this.valueType(value), name);
  }

  /**
   * 반사적 쓰기 대상 값을 처음 한 번 구한다. 반사적 쓰기는 속성 값을 모름으로만 바꾸므로(값을 더하지
   * 않는다), 빈 가정으로 구한 집합을 그 집합 가정으로 다시 구해 같으면 고정점이고, 다르면 모름으로 둔다.
   * 가정 아래 계산한 메모는 버린다.
   */
  private ensureReflective(): void {
    if (this.reflective !== undefined) return;
    this.reflective = EMPTY;
    const first = this.query(() => this.reflectiveValues());
    this.memo.clear();
    this.reflective = first;
    const second = first === null ? null : this.query(() => this.reflectiveValues());
    this.memo.clear();
    this.reflective = second !== null && first !== null && second.size === first.size && [...second].every((value) => first.has(value)) ? first : null;
  }

  /**
   * 예산을 두고 질의를 실행한다.
   *
   * @param run 질의
   * @returns 결과, 예산을 넘으면 null
   */
  private query(run: () => Flow): Flow {
    this.steps = 0;
    this.depth = 0;
    try {
      return run();
    } catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      // 예산 초과는 증명 실패다(모름). 메모에는 완결된 단위만 남아 있다.
      this.active.clear();
      this.lowestOpen = Number.POSITIVE_INFINITY;
      return null;
    }
  }

  /**
   * 식의 값을 구한다.
   *
   * @param node 식
   * @returns 값 집합, 모르면 null
   */
  private expressionValues(node: ts.Expression): Flow {
    this.step();
    const expression = skipWrappers(node);
    if (ts.isObjectLiteralExpression(expression)) return new Set([expression]);
    if (ts.isNewExpression(expression)) return this.newValues(expression);
    if (ts.isIdentifier(expression)) return this.identifierValues(expression);
    if (expression.kind === ts.SyntaxKind.ThisKeyword) return this.thisValues(expression);
    if (expression.kind === ts.SyntaxKind.NullKeyword || ts.isVoidExpression(expression)) return EMPTY;
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) return this.accessValues(expression);
    if (ts.isCallExpression(expression)) return this.callValues(expression);
    if (ts.isAwaitExpression(expression)) return this.expressionValues(expression.expression);
    if (ts.isConditionalExpression(expression)) return unionFlows(this.expressionValues(expression.whenTrue), this.expressionValues(expression.whenFalse));
    if (ts.isBinaryExpression(expression)) return this.binaryValues(expression);
    return null;
  }

  /**
   * 이항식의 값이다: 논리·병합 연산은 두 쪽 합, 쉼표·대입은 오른쪽.
   *
   * @param expression 이항식
   * @returns 값 집합
   */
  private binaryValues(expression: ts.BinaryExpression): Flow {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      return unionFlows(this.expressionValues(expression.left), this.expressionValues(expression.right));
    }
    if (operator === ts.SyntaxKind.CommaToken || operator === ts.SyntaxKind.EqualsToken) return this.expressionValues(expression.right);
    return null;
  }

  /**
   * `new C(...)`의 값이다. 프로젝트 클래스(선언·식, `const C = class …`)만 안다.
   *
   * @param expression new 식
   * @returns 값 집합
   */
  private newValues(expression: ts.NewExpression): Flow {
    const callee = skipWrappers(expression.expression);
    if (ts.isClassExpression(callee)) return new Set([callee]);
    const declaration = this.classOfSymbol(this.calleeSymbol(callee));
    return declaration === undefined ? null : new Set([declaration]);
  }

  /**
   * 심볼이 가리키는 프로젝트 클래스 선언이다.
   *
   * @param symbol 심볼(별칭 가능)
   * @returns 클래스 선언·식, 아니면 undefined
   */
  private classOfSymbol(symbol: ts.Symbol | undefined): ts.ClassLikeDeclaration | undefined {
    const declaration = this.dealias(symbol)?.valueDeclaration;
    if (declaration === undefined || !this.policy.isProjectFile(declaration.getSourceFile()) || isAmbient(declaration)) return undefined;
    if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration) && isConstDeclaration(declaration) && declaration.initializer !== undefined) {
      const initializer = skipWrappers(declaration.initializer);
      if (ts.isClassExpression(initializer)) return initializer;
    }
    return undefined;
  }

  /**
   * 식별자의 값이다. 전역 `undefined`는 빈 집합이다.
   *
   * @param identifier 식별자
   * @returns 값 집합
   */
  private identifierValues(identifier: ts.Identifier): Flow {
    const symbol = this.checker.getSymbolAtLocation(identifier);
    if (identifier.text === 'undefined' && symbol !== undefined && !this.isProjectSymbol(symbol)) return EMPTY;
    return this.symbolValues(symbol);
  }

  /**
   * `this`의 값이다: 인스턴스 멤버 안이면 감싼 클래스와 프로젝트 하위 클래스, 그 밖은 모름.
   *
   * @param node this 키워드
   * @returns 값 집합
   */
  private thisValues(node: ts.Node): Flow {
    const owner = thisOwner(node);
    if (owner === undefined || this.policy.isOpenCallable(owner)) return null;
    return new Set(this.withSubclasses(owner));
  }

  /**
   * 클래스와 그 프로젝트 하위 클래스 전부다.
   *
   * @param declaration 클래스
   * @returns 클래스 목록(자신 먼저)
   */
  private withSubclasses(declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration[] {
    const result = [declaration];
    for (let index = 0; index < result.length; index++) {
      for (const child of this.index.subclasses.get(result[index]!) ?? []) if (!result.includes(child)) result.push(child);
    }
    return result;
  }

  /**
   * 속성 접근의 값이다. 모듈 네임스페이스·클래스 static 멤버는 심볼로, 그 밖은 수신자 값의 속성으로 구한다.
   *
   * @param expression 속성·원소 접근
   * @returns 값 집합
   */
  private accessValues(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): Flow {
    const name = accessName(expression);
    if (name === undefined) return null;
    const owner = skipWrappers(expression.expression);
    const ownerSymbol = ts.isIdentifier(owner) ? this.dealias(this.checker.getSymbolAtLocation(owner)) : undefined;
    if (ownerSymbol !== undefined && (ownerSymbol.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.Class)) !== 0) {
      const member = ts.isPropertyAccessExpression(expression) ? expression.name : (expression.argumentExpression as ts.Expression);
      return this.symbolValues(this.checker.getSymbolAtLocation(member));
    }
    return this.propertyValues(this.expressionValues(owner), name);
  }

  /**
   * 값 집합의 각 값에서 이름 있는 속성의 값을 모은다.
   *
   * @param flow 수신자 값
   * @param name 속성 이름
   * @returns 값 집합
   */
  private propertyValues(flow: Flow, name: string): Flow {
    if (flow === null) return null;
    let result: Flow = EMPTY;
    for (const value of flow) {
      result = unionFlows(result, ts.isObjectLiteralExpression(value) ? this.literalProperty(value, name) : this.instanceProperty(value, name));
      if (result === null) return null;
    }
    return result;
  }

  /**
   * 객체 리터럴 값의 속성 값이다: 마지막 명시 속성과 그 뒤 전개(`...x`)의 같은 속성, 그리고 이름이 같은 속성
   * 쓰기. 메서드·접근자·계산된 키는 모름이다.
   *
   * @param literal 객체 리터럴
   * @param name 속성 이름
   * @returns 값 집합
   */
  private literalProperty(literal: ts.ObjectLiteralExpression, name: string): Flow {
    if (this.policy.openProperties || this.isReflectivelyWritten(literal)) return null;
    let result: Flow = EMPTY;
    for (const property of literal.properties) {
      if (ts.isSpreadAssignment(property)) {
        result = unionFlows(result, this.propertyValues(this.expressionValues(property.expression), name));
      } else if (property.name !== undefined && ts.isComputedPropertyName(property.name)) {
        return null;
      } else if (property.name !== undefined && memberName(property.name) === name) {
        result = this.literalMemberValues(property);
      }
      if (result === null) return null;
    }
    return unionFlows(result, this.foreignWrites(name, undefined));
  }

  /**
   * 객체 리터럴 멤버 하나의 값이다.
   *
   * @param property 리터럴 멤버
   * @returns 값 집합
   */
  private literalMemberValues(property: ts.ObjectLiteralElementLike): Flow {
    if (ts.isPropertyAssignment(property)) return this.expressionValues(property.initializer);
    if (ts.isShorthandPropertyAssignment(property)) return this.symbolValues(this.checker.getShorthandAssignmentValueSymbol(property));
    return null;
  }

  /**
   * 클래스 인스턴스 값의 속성 값이다(필드·매개변수 속성·getter). 메서드는 모름이다.
   *
   * @param declaration 클래스
   * @param name 속성 이름
   * @returns 값 집합
   */
  private instanceProperty(declaration: ts.ClassLikeDeclaration, name: string): Flow {
    if (this.isReflectivelyWritten(declaration)) return null;
    const member = this.checker.getPropertyOfType(this.valueType(declaration), name);
    const memberDeclaration = member?.valueDeclaration;
    if (memberDeclaration === undefined || !this.policy.isProjectFile(memberDeclaration.getSourceFile())) return null;
    if (ts.isGetAccessorDeclaration(memberDeclaration)) return this.returnValues(memberDeclaration);
    if (ts.isPropertyDeclaration(memberDeclaration) || ts.isParameter(memberDeclaration)) return this.symbolValues(member);
    return null;
  }

  /**
   * 심볼의 값이다(메모 단위). 별칭을 풀고, 프로젝트 밖 선언이면 모름이다.
   *
   * @param symbol 심볼
   * @returns 값 집합
   */
  private symbolValues(symbol: ts.Symbol | undefined): Flow {
    const target = this.dealias(symbol);
    const declaration = target?.valueDeclaration;
    if (target === undefined || declaration === undefined || !this.policy.isProjectFile(declaration.getSourceFile())) return null;
    return this.unit(target, () => this.computeSymbolValues(target, declaration));
  }

  /**
   * 심볼 선언 종류별로 값을 구한다.
   *
   * @param symbol 별칭을 푼 심볼
   * @param declaration 값 선언
   * @returns 값 집합
   */
  private computeSymbolValues(symbol: ts.Symbol, declaration: ts.Declaration): Flow {
    if (ts.isVariableDeclaration(declaration)) return unionFlows(this.variableValues(declaration), this.identifierWrites(symbol));
    if (ts.isBindingElement(declaration)) return unionFlows(this.bindingValues(declaration), this.identifierWrites(symbol));
    if (ts.isParameter(declaration)) {
      const flow = unionFlows(this.parameterValues(declaration), this.identifierWrites(symbol));
      return (symbol.flags & ts.SymbolFlags.Property) === 0 ? flow : unionFlows(flow, this.fieldExtras(declaration, ts.findAncestor(declaration, ts.isClassLike)));
    }
    if (ts.isPropertyDeclaration(declaration)) return this.fieldValues(declaration);
    if (ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)) {
      return ts.isObjectLiteralExpression(declaration.parent) ? this.literalProperty(declaration.parent, symbol.name) : null;
    }
    return null;
  }

  /**
   * 변수 선언의 값이다(대입은 호출자가 더한다). for-in/of·catch·ambient 변수는 모름이다.
   *
   * @param declaration 변수 선언
   * @returns 값 집합
   */
  private variableValues(declaration: ts.VariableDeclaration): Flow {
    const statement = declaration.parent.parent;
    if (ts.isForInStatement(statement) || ts.isForOfStatement(statement) || ts.isCatchClause(declaration.parent) || isAmbient(declaration)) return null;
    return declaration.initializer === undefined ? EMPTY : this.expressionValues(declaration.initializer);
  }

  /**
   * 객체 구조 분해 바인딩의 값이다: 원본 값의 같은 이름 속성과 기본값.
   *
   * @param element 바인딩 요소
   * @returns 값 집합
   */
  private bindingValues(element: ts.BindingElement): Flow {
    const name = bindingPropertyName(element);
    if (!ts.isObjectBindingPattern(element.parent) || name === undefined || element.dotDotDotToken !== undefined) return null;
    const source = this.patternSource(element.parent);
    const fallback = element.initializer === undefined ? EMPTY : this.expressionValues(element.initializer);
    return unionFlows(this.propertyValues(source, name), fallback);
  }

  /**
   * 구조 분해 패턴이 풀어 내는 원본 값이다.
   *
   * @param pattern 객체 바인딩 패턴
   * @returns 값 집합
   */
  private patternSource(pattern: ts.ObjectBindingPattern): Flow {
    const owner = pattern.parent;
    if (ts.isParameter(owner)) return this.parameterValues(owner);
    if (ts.isBindingElement(owner)) return this.bindingValues(owner);
    return this.variableValues(owner);
  }

  /**
   * 매개변수의 값이다: 기본값과 모든 호출 위치의 같은 자리 인자. 나머지 매개변수·`this` 매개변수·호출자를
   * 다 볼 수 없는 함수는 모름이다.
   *
   * @param parameter 매개변수 선언
   * @returns 값 집합
   */
  private parameterValues(parameter: ts.ParameterDeclaration): Flow {
    const owner = parameter.parent;
    if (parameter.dotDotDotToken !== undefined || !ts.isFunctionLike(owner) || isThisParameter(parameter)) return null;
    const position = owner.parameters.filter((candidate) => !isThisParameter(candidate)).indexOf(parameter);
    const sites = this.callSites(owner as ts.SignatureDeclaration);
    if (sites === null) return null;
    let result: Flow = parameter.initializer === undefined ? EMPTY : this.expressionValues(parameter.initializer);
    for (const argumentsList of sites) {
      if (argumentsList.slice(0, position + 1).some(ts.isSpreadElement)) return null;
      const argument = argumentsList[position];
      if (argument !== undefined) result = unionFlows(result, this.expressionValues(argument));
      if (result === null) return null;
    }
    return result;
  }

  /**
   * 함수·생성자의 호출 위치(인자 목록)다. 메모한다.
   *
   * @param owner 매개변수를 가진 함수 계열
   * @returns 인자 목록들, 호출자를 다 볼 수 없으면 null
   */
  private callSites(owner: ts.SignatureDeclaration): CallSites {
    const cached = this.sitesMemo.get(owner);
    if (cached !== undefined) return cached;
    const sites = ts.isConstructorDeclaration(owner) ? this.constructorSites(owner.parent) : this.functionSites(owner);
    this.sitesMemo.set(owner, sites);
    return sites;
  }

  /**
   * 함수 선언·`const` 함수 값의 호출 위치다. 호출 대상이 아닌 자리의 참조(값으로 새어 나감)가 있거나,
   * 밖에서 부를 수 있는 함수면 null이다.
   *
   * @param owner 함수 계열
   * @returns 인자 목록들 또는 null
   */
  private functionSites(owner: ts.SignatureDeclaration): CallSites {
    const symbol = this.functionSymbol(owner);
    if (symbol === undefined || this.policy.isOpenCallable(owner as ts.FunctionLikeDeclaration)) return null;
    const sites: ts.Expression[][] = [];
    for (const reference of this.index.references.get(symbol) ?? []) {
      const outer = climbWrappers(ts.isPropertyAccessExpression(reference.parent) && reference.parent.name === reference ? reference.parent : reference);
      if (!ts.isCallExpression(outer.parent) || outer.parent.expression !== outer) return null;
      sites.push([...outer.parent.arguments]);
    }
    return sites;
  }

  /**
   * 호출 위치를 셀 수 있는 함수의 심볼이다: 이름 있는 함수 선언, `const` 변수에 담긴 화살표·함수 식.
   *
   * @param owner 함수 계열
   * @returns 심볼 또는 undefined(메서드·콜백 등)
   */
  private functionSymbol(owner: ts.SignatureDeclaration): ts.Symbol | undefined {
    if (ts.isFunctionDeclaration(owner)) return owner.name === undefined ? undefined : this.checker.getSymbolAtLocation(owner.name);
    if (!ts.isArrowFunction(owner) && !ts.isFunctionExpression(owner)) return undefined;
    const holder = climbWrappers(owner).parent;
    if (!ts.isVariableDeclaration(holder) || !ts.isIdentifier(holder.name) || !isConstDeclaration(holder)) return undefined;
    return this.checker.getSymbolAtLocation(holder.name);
  }

  /**
   * 클래스 생성자의 호출 위치다: `new C(...)`, 하위 클래스 생성자의 `super(...)`, 생성자가 없는 하위 클래스의
   * 생성 위치. 데코레이터(DI 컨테이너가 생성)·`new this()`·값으로 새어 나간 클래스·밖에서 부를 수 있는 클래스면 null이다.
   *
   * @param declaration 클래스
   * @returns 인자 목록들 또는 null
   */
  private constructorSites(declaration: ts.ClassLikeDeclaration): CallSites {
    if (hasDecorators(declaration) || this.index.newThisClasses.has(declaration) || this.policy.isOpenCallable(declaration)) return null;
    const symbol = this.classSymbol(declaration);
    if (symbol === undefined) return null;
    const sites: (readonly ts.Expression[])[] = [];
    for (const reference of this.index.references.get(symbol) ?? []) {
      const found = this.constructorUse(climbWrappers(reference));
      if (found === null) return null;
      sites.push(...found);
    }
    return sites;
  }

  /**
   * 클래스 참조 하나가 만드는 생성 위치다.
   *
   * @param outer 래퍼까지 올라간 참조 식
   * @returns 인자 목록들(생성이 아닌 무해한 사용이면 빈 목록), 새어 나가면 null
   */
  private constructorUse(outer: ts.Node): CallSites {
    const parent = outer.parent;
    if (ts.isNewExpression(parent) && parent.expression === outer) return [[...(parent.arguments ?? [])]];
    if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent)) {
      const heir = parent.parent.parent;
      return parent.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(heir) ? this.subclassSites(heir) : [];
    }
    const isStaticAccess = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer;
    const isInstanceCheck = ts.isBinaryExpression(parent) && parent.right === outer && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword;
    return isStaticAccess || isInstanceCheck || ts.isTypeOfExpression(parent) ? [] : null;
  }

  /**
   * 하위 클래스가 기반 생성자를 부르는 위치다: 생성자가 있으면 그 안의 `super(...)`, 없으면 하위 클래스의 생성 위치.
   *
   * @param subclass 하위 클래스
   * @returns 인자 목록들 또는 null
   */
  private subclassSites(subclass: ts.ClassLikeDeclaration): CallSites {
    const constructor = subclass.members.find((member): member is ts.ConstructorDeclaration => ts.isConstructorDeclaration(member) && member.body !== undefined);
    if (constructor === undefined) return this.constructorSites(subclass);
    const calls: ts.Expression[][] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) calls.push([...node.arguments]);
      if (!ts.isFunctionDeclaration(node) && !ts.isFunctionExpression(node) && !ts.isClassLike(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(constructor.body!, visit);
    return calls;
  }

  /**
   * 클래스의 값 심볼이다(이름 있는 선언, 또는 `const C = class …`의 변수).
   *
   * @param declaration 클래스
   * @returns 심볼 또는 undefined
   */
  private classSymbol(declaration: ts.ClassLikeDeclaration): ts.Symbol | undefined {
    if (ts.isClassDeclaration(declaration)) return declaration.name === undefined ? undefined : this.checker.getSymbolAtLocation(declaration.name);
    const holder = climbWrappers(declaration).parent;
    return ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) && isConstDeclaration(holder) ? this.checker.getSymbolAtLocation(holder.name) : undefined;
  }

  /**
   * 클래스 필드의 값이다: 초기값과 이름이 같은 속성 쓰기. 데코레이터·`declare` 필드는 모름이다.
   *
   * @param declaration 필드 선언
   * @returns 값 집합
   */
  private fieldValues(declaration: ts.PropertyDeclaration): Flow {
    if (hasDecorators(declaration) || isAmbient(declaration)) return null;
    const initial = declaration.initializer === undefined ? EMPTY : this.expressionValues(declaration.initializer);
    return unionFlows(initial, this.fieldExtras(declaration, declaration.parent));
  }

  /**
   * 필드·매개변수 속성에 초기값 밖에서 더해지는 값이다: 이름이 같은 속성 쓰기, 외부가 쓸 수 있으면 모름.
   *
   * @param declaration 필드·매개변수 속성
   * @param owner 소유 클래스
   * @returns 값 집합
   */
  private fieldExtras(declaration: ts.PropertyDeclaration | ts.ParameterDeclaration, owner: ts.ClassLikeDeclaration | undefined): Flow {
    if (owner === undefined || ts.isArrayBindingPattern(declaration.name) || ts.isObjectBindingPattern(declaration.name)) return null;
    if (this.policy.openProperties && !isPrivateMember(declaration)) return null;
    const name = memberName(declaration.name as ts.PropertyName);
    return name === undefined ? null : this.foreignWrites(name, owner);
  }

  /**
   * 이름이 같은 속성 쓰기의 값을 모은다. 대상이 관계없는(상속 관계가 아닌) 프로젝트 클래스의 멤버로 해석되는
   * 쓰기는 뺀다 — 그 객체는 이 값이 아니기 때문이다. 인터페이스·any·리터럴 속성으로 해석되는 쓰기는 넣는다.
   *
   * @param name 속성 이름
   * @param owner 값의 클래스(객체 리터럴이면 undefined)
   * @returns 값 집합
   */
  private foreignWrites(name: string, owner: ts.ClassLikeDeclaration | undefined): Flow {
    let result: Flow = EMPTY;
    for (const write of this.index.propertyWrites.get(name) ?? []) {
      if (this.isUnrelatedClassWrite(write, owner)) continue;
      result = unionFlows(result, write.value === undefined ? null : this.expressionValues(write.value));
      if (result === null) return null;
    }
    return result;
  }

  /**
   * 쓰기 대상이 값의 클래스와 상속 관계가 없는 클래스의 멤버인지 본다.
   *
   * @param write 속성 쓰기
   * @param owner 값의 클래스(객체 리터럴이면 undefined)
   * @returns 관계없는 클래스 멤버면 true
   */
  private isUnrelatedClassWrite(write: PropertyWrite, owner: ts.ClassLikeDeclaration | undefined): boolean {
    const member = ts.isPropertyAccessExpression(write.target) ? write.target.name : write.target.argumentExpression;
    const declaration = this.checker.getSymbolAtLocation(member)?.valueDeclaration;
    const memberClass = declaration === undefined ? undefined : classOfMember(declaration);
    if (memberClass === undefined) return false;
    if (owner === undefined) return true;
    return !this.withSubclasses(memberClass).includes(owner) && !this.withSubclasses(owner).includes(memberClass);
  }

  /**
   * 식별자 대입으로 더해지는 값이다(값 모르는 쓰기가 있으면 모름).
   *
   * @param symbol 변수·매개변수 심볼
   * @returns 값 집합
   */
  private identifierWrites(symbol: ts.Symbol): Flow {
    let result: Flow = EMPTY;
    for (const value of this.index.identifierWrites.get(symbol) ?? []) {
      result = unionFlows(result, value === undefined ? null : this.expressionValues(value));
      if (result === null) return null;
    }
    return result;
  }

  /**
   * 호출식의 값: 실행될 수 있는 함수 본문들의 반환 값 합이다.
   *
   * @param call 호출식
   * @returns 값 집합
   */
  private callValues(call: ts.CallExpression): Flow {
    const functions = this.calleeFunctions(call);
    if (functions === null) return null;
    let result: Flow = EMPTY;
    for (const target of functions) {
      result = unionFlows(result, this.returnValues(target));
      if (result === null) return null;
    }
    return result;
  }

  /**
   * 호출식이 실행할 수 있는 본문 있는 함수들이다. 인터페이스 멤버면 수신자 값의 구현으로 푼다.
   *
   * @param call 호출식
   * @returns 함수 계열 목록, 증명하지 못하면 null
   */
  private calleeFunctions(call: ts.CallExpression): ts.FunctionLikeDeclaration[] | null {
    const callee = skipWrappers(call.expression);
    const symbol = this.dealias(this.calleeSymbol(callee));
    if (symbol === undefined) return null;
    const declarations = symbol.declarations ?? [];
    if (declarations.some((declaration) => ts.isMethodSignature(declaration) || ts.isPropertySignature(declaration))) {
      return ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? this.dispatchedFunctions(callee) : null;
    }
    const bodies = declarations.map((declaration) => this.functionBody(declaration, symbol.name)).filter((body) => body !== undefined);
    if (bodies.includes(null) || bodies.length === 0) return null;
    return bodies as ts.FunctionLikeDeclaration[];
  }

  /**
   * 인터페이스 멤버 호출의 수신자 값별 구현 본문이다.
   *
   * @param callee 속성·원소 접근 호출 대상
   * @returns 함수 계열 목록 또는 null
   */
  private dispatchedFunctions(callee: ts.PropertyAccessExpression | ts.ElementAccessExpression): ts.FunctionLikeDeclaration[] | null {
    const name = accessName(callee);
    const receivers = name === undefined ? null : this.expressionValues(callee.expression);
    if (receivers === null) return null;
    const result: ts.FunctionLikeDeclaration[] = [];
    for (const value of receivers) {
      const member = this.checker.getPropertyOfType(this.valueType(value), name!);
      const body = member?.valueDeclaration === undefined ? null : this.functionBody(member.valueDeclaration, name!, true);
      if (body === null || body === undefined) return null;
      if (!ts.isObjectLiteralExpression(value) && this.isReflectivelyWritten(value)) return null;
      result.push(body);
    }
    return result;
  }

  /**
   * 선언이 호출될 때 실행하는 본문이다. 오버로드 시그니처는 건너뛰고(undefined), 증명하지 못하면 null이다:
   * 프로젝트 밖, 재정의된 메서드, 이름이 같은 속성 쓰기로 바뀔 수 있는 멤버, `let` 변수에 담긴 함수.
   *
   * @param declaration 선언
   * @param name 멤버·변수 이름
   * @param exact 수신자가 정확한 클래스 값이라 재정의를 따질 필요가 없으면 true
   * @returns 함수 계열, 건너뛸 시그니처면 undefined, 증명 실패면 null
   */
  private functionBody(declaration: ts.Declaration, name: string, exact = false): ts.FunctionLikeDeclaration | undefined | null {
    if (!this.policy.isProjectFile(declaration.getSourceFile()) || isAmbient(declaration)) return null;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
      if (declaration.body === undefined) return undefined;
      if (!exact && ts.isMethodDeclaration(declaration) && ts.isClassLike(declaration.parent) && this.policy.isOverridden(declaration)) return null;
      return ts.isMethodDeclaration(declaration) && this.hasForeignMemberWrites(declaration, name) ? null : declaration;
    }
    const initializer = ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)
      ? declaration.initializer : undefined;
    if (initializer === undefined || !isFunctionValued(initializer)) return null;
    const isReassignable = ts.isVariableDeclaration(declaration) ? !isConstDeclaration(declaration) : this.hasForeignMemberWrites(declaration, name);
    return isReassignable ? null : skipWrappers(initializer) as ts.ArrowFunction | ts.FunctionExpression;
  }

  /**
   * 멤버를 이름이 같은 속성 쓰기가 바꿀 수 있는지 본다(관계없는 클래스 멤버 쓰기는 제외).
   *
   * @param declaration 멤버 선언
   * @param name 멤버 이름
   * @returns 바꿀 수 있는 쓰기가 있으면 true
   */
  private hasForeignMemberWrites(declaration: ts.Declaration, name: string): boolean {
    const owner = ts.isClassLike(declaration.parent) ? declaration.parent : undefined;
    return (this.index.propertyWrites.get(name) ?? []).some((write) => !this.isUnrelatedClassWrite(write, owner));
  }

  /**
   * 함수 본문의 반환 값이다(메모 단위). 생성기는 모름, 반환이 없으면 빈 집합이다.
   *
   * @param target 함수 계열
   * @returns 값 집합
   */
  private returnValues(target: ts.FunctionLikeDeclaration): Flow {
    if (target.asteriskToken !== undefined || target.body === undefined) return null;
    return this.unit(target, () => {
      if (!ts.isBlock(target.body!)) return this.expressionValues(target.body as ts.Expression);
      let result: Flow = EMPTY;
      for (const expression of returnExpressions(target.body)) {
        result = unionFlows(result, this.expressionValues(expression));
        if (result === null) return null;
      }
      return result;
    });
  }

  /**
   * 값이 반사적 쓰기(`Object.assign(x, …)` 등)의 대상일 수 있는지 본다.
   *
   * @param value 추상 값
   * @returns 대상일 수 있으면 true
   */
  private isReflectivelyWritten(value: AbstractValue): boolean {
    return this.reflective === null || this.reflective?.has(value) === true;
  }

  /**
   * 반사적 쓰기 대상의 값 합이다(현재 가정 아래). 외부 클래스의 새 인스턴스(`new Error()`)는 프로젝트 값일
   * 수 없어 뺀다.
   *
   * @returns 값 집합
   */
  private reflectiveValues(): Flow {
    let result: Flow = EMPTY;
    for (const target of this.index.reflectiveTargets) {
      const inner = skipWrappers(target);
      if (ts.isNewExpression(inner) && this.classOfSymbol(this.calleeSymbol(skipWrappers(inner.expression))) === undefined
        && !ts.isClassExpression(skipWrappers(inner.expression))) {
        continue;
      }
      result = unionFlows(result, this.expressionValues(target));
      if (result === null) break;
    }
    return result;
  }

  /**
   * 추상 값의 타입이다(클래스는 인스턴스 타입).
   *
   * @param value 추상 값
   * @returns 타입
   */
  private valueType(value: AbstractValue): ts.Type {
    return ts.isObjectLiteralExpression(value) ? this.checker.getTypeAtLocation(value) : instanceTypeOf(this.checker, value);
  }

  /**
   * 호출·`new` 대상 식의 심볼이다.
   *
   * @param callee 래퍼를 벗긴 식
   * @returns 심볼 또는 undefined
   */
  private calleeSymbol(callee: ts.Expression): ts.Symbol | undefined {
    if (ts.isIdentifier(callee)) return this.checker.getSymbolAtLocation(callee);
    if (ts.isPropertyAccessExpression(callee)) return this.checker.getSymbolAtLocation(callee.name);
    if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) return this.checker.getSymbolAtLocation(callee.argumentExpression);
    return undefined;
  }

  /**
   * 심볼이 프로젝트 파일에 선언됐는지 본다.
   *
   * @param symbol 심볼
   * @returns 프로젝트 선언이면 true
   */
  private isProjectSymbol(symbol: ts.Symbol): boolean {
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
    return declaration !== undefined && this.policy.isProjectFile(declaration.getSourceFile());
  }

  /**
   * 메모 단위를 계산한다. 계산 중인 단위를 다시 만나면 빈 집합으로 끊고, 끊은 단위보다 위(더 깊은)
   * 단위의 결과는 불완전할 수 있어 메모하지 않는다. 모름은 언제나 완결이다.
   *
   * @param key 단위 키
   * @param compute 계산
   * @returns 값 집합
   */
  private unit(key: UnitKey, compute: () => Flow): Flow {
    if (this.memo.has(key)) return this.memo.get(key)!;
    const open = this.active.get(key);
    if (open !== undefined) {
      this.lowestOpen = Math.min(this.lowestOpen, open);
      return EMPTY;
    }
    const position = this.active.size;
    const outerLowest = this.lowestOpen;
    this.lowestOpen = Number.POSITIVE_INFINITY;
    this.active.set(key, position);
    if (++this.depth > MAX_DEPTH) throw new BudgetExceeded();
    const result = compute();
    this.depth--;
    this.active.delete(key);
    const complete = result === null || this.lowestOpen >= position;
    if (complete) this.memo.set(key, result);
    this.lowestOpen = Math.min(outerLowest, complete ? Number.POSITIVE_INFINITY : this.lowestOpen);
    return result;
  }

  /**
   * 단계 예산을 쓴다.
   */
  private step(): void {
    if (++this.steps > MAX_STEPS) throw new BudgetExceeded();
  }

  /**
   * 별칭 심볼을 실제 심볼로 푼다.
   *
   * @param symbol 심볼
   * @returns 실제 심볼, 풀리지 않으면 undefined
   */
  private dealias(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
    const target = this.checker.getAliasedSymbol(symbol);
    return (target.declarations ?? []).length === 0 ? undefined : target;
  }
}

/**
 * 클래스의 인스턴스 타입이다. 클래스 선언은 선언 타입, 클래스 식은 생성 시그니처의 반환 타입이다
 * (`getTypeAtLocation`이 클래스 식에는 생성자 타입을 주기 때문이다).
 *
 * @param checker TypeChecker
 * @param declaration 클래스 선언·식
 * @returns 인스턴스 타입
 */
export function instanceTypeOf(checker: ts.TypeChecker, declaration: ts.ClassLikeDeclaration): ts.Type {
  const type = checker.getTypeAtLocation(declaration);
  return ts.isClassExpression(declaration) ? type.getConstructSignatures()[0]?.getReturnType() ?? type : type;
}

/**
 * `this`가 가리키는 인스턴스의 클래스다. 화살표 함수는 건너뛰고, 인스턴스 멤버(메서드·생성자·접근자·필드
 * 초기값) 안이 아니면 undefined다.
 *
 * @param node this 키워드
 * @returns 클래스 또는 undefined
 */
function thisOwner(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isArrowFunction(current)) continue;
    const isMember = ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current) || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current) || ts.isPropertyDeclaration(current);
    if (isMember) return ts.isClassLike(current.parent) && !isStatic(current as ts.ClassElement) ? current.parent : undefined;
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current) || ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

/**
 * 속성·원소 접근의 이름이다(리터럴 키만).
 *
 * @param expression 속성·원소 접근
 * @returns 이름 또는 undefined
 */
function accessName(expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return ts.isStringLiteralLike(expression.argumentExpression) ? expression.argumentExpression.text : undefined;
}

/**
 * 함수 본문의 `return` 식들이다(안쪽 함수·클래스는 건너뛴다).
 *
 * @param body 본문 블록
 * @returns 반환 식 목록
 */
function returnExpressions(body: ts.Block): ts.Expression[] {
  const result: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression !== undefined) result.push(node.expression);
    if (!ts.isFunctionLike(node) && !ts.isClassLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return result;
}

/**
 * 멤버 선언이 속한 클래스다(필드·매개변수 속성·메서드·접근자).
 *
 * @param declaration 멤버 선언
 * @returns 클래스 또는 undefined
 */
function classOfMember(declaration: ts.Declaration): ts.ClassLikeDeclaration | undefined {
  if (ts.isParameter(declaration)) {
    const owner = declaration.parent;
    return ts.isConstructorDeclaration(owner) && ts.getModifiers(declaration) !== undefined ? owner.parent : undefined;
  }
  const isMember = ts.isPropertyDeclaration(declaration) || ts.isMethodDeclaration(declaration)
    || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration);
  return isMember && ts.isClassLike(declaration.parent) ? declaration.parent : undefined;
}

/**
 * 객체 구조 분해 요소가 읽는 속성 이름이다.
 *
 * @param element 바인딩 요소
 * @returns 이름 또는 undefined(계산된 이름)
 */
function bindingPropertyName(element: ts.BindingElement): string | undefined {
  const name = element.propertyName ?? element.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * `const` 선언인지 본다.
 *
 * @param declaration 변수 선언
 * @returns const면 true
 */
function isConstDeclaration(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

/**
 * `this` 매개변수(타입 전용)인지 본다.
 *
 * @param parameter 매개변수
 * @returns this 매개변수면 true
 */
function isThisParameter(parameter: ts.ParameterDeclaration): boolean {
  return ts.isIdentifier(parameter.name) && parameter.name.text === 'this';
}

/**
 * 데코레이터가 붙었는지 본다(클래스면 생성자 매개변수의 데코레이터도).
 *
 * @param node 클래스·필드
 * @returns 데코레이터가 있으면 true
 */
function hasDecorators(node: ts.ClassLikeDeclaration | ts.PropertyDeclaration): boolean {
  if ((ts.getDecorators(node) ?? []).length > 0) return true;
  if (!ts.isClassLike(node)) return false;
  return node.members.some((member) => ts.isConstructorDeclaration(member)
    && member.parameters.some((parameter) => (ts.getDecorators(parameter) ?? []).length > 0));
}

/**
 * `declare`로 선언된(또는 ambient 문맥의) 선언인지 본다.
 *
 * @param declaration 선언
 * @returns ambient면 true
 */
function isAmbient(declaration: ts.Node): boolean {
  return ts.findAncestor(declaration, (node) => ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) !== undefined;
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

/**
 * 밖에서 쓸 수 없는 멤버(`private`·`protected`·`#이름`)인지 본다.
 *
 * @param declaration 필드·매개변수 속성
 * @returns 비공개면 true
 */
function isPrivateMember(declaration: ts.PropertyDeclaration | ts.ParameterDeclaration): boolean {
  if (ts.isPrivateIdentifier(declaration.name)) return true;
  return (ts.getModifiers(declaration) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
    || modifier.kind === ts.SyntaxKind.ProtectedKeyword);
}
