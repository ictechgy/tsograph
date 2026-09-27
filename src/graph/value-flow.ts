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
import { climbWrappers, type FlowIndex, type PropertyWrite, referenceSite } from './flow-index.ts';
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

/** 함수 값 별칭을 따라가는 최대 깊이다. */
const MAX_ALIAS_DEPTH = 8;

/** 한 단위의 순환 고정점 되풀이 상한이다. */
const MAX_ROUNDS = 64;

/** 질의 하나의 최대 메모 단위 중첩 깊이다. */
const MAX_DEPTH = 256;

/** 질의 하나의 최대 식 재귀 깊이다(깊게 중첩된 객체 리터럴·속성 사슬에서 스택을 지킨다). */
const MAX_FRAMES = 400;

/** 빈 값 집합(공유)이다. */
const EMPTY: ReadonlySet<AbstractValue> = new Set();

/** 예산 초과 신호다. */
class BudgetExceeded extends Error {}

/** 메모 단위(심볼·함수 반환·메서드의 `this`)의 키다. */
type UnitKey = object;

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

/**
 * 두 흐름이 같은지 본다(둘 다 알려진 집합일 때).
 *
 * @param left 흐름
 * @param right 흐름
 * @returns 같으면 true
 */
function sameFlow(left: Flow, right: Flow): boolean {
  if (left === null || right === null) return left === right;
  return left.size === right.size && [...left].every((value) => right.has(value));
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
  /** 계산 중인 단위의 잠정 결과(자기 순환 고정점 되풀이용) */
  private readonly provisional = new Map<UnitKey, Flow>();
  /** 메서드 → `this` 단위 키 */
  private readonly thisKeys = new Map<ts.MethodDeclaration, object>();
  /** 계산 중 다시 만난 단위 */
  private readonly reentered = new Set<UnitKey>();
  /** 현재 계산이 기댄 가장 낮은 계산 중 단위의 스택 위치 */
  private lowestOpen = Number.POSITIVE_INFINITY;
  private steps = 0;
  private depth = 0;
  private frames = 0;
  /** 예산(단계·깊이·스택)을 넘어 모름으로 끝난 질의 수(진단용) */
  private overBudget = 0;
  /** (종류, 노드·값) → 파생 메모 단위 키 */
  private readonly derivedKeys = new Map<string, Map<object, object>>();
  /** 클래스 → 자신과 프로젝트 하위 클래스 */
  private readonly subclassMemo = new Map<ts.ClassLikeDeclaration, readonly ts.ClassLikeDeclaration[]>();
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
    // 본문 검증은 속성 쓰기 수신자의 흐름을 구하므로 질의 예산 안에서 돌린다(넘으면 증명 실패).
    let body: ts.FunctionLikeDeclaration | undefined;
    const proven = this.query(() => {
      body = this.memberBody(value, name);
      return body === undefined ? null : EMPTY;
    });
    if (proven === null || body === undefined) return undefined;
    return this.checker.getPropertyOfType(this.valueType(value), name);
  }

  /**
   * 지금까지 예산을 넘어 모름으로 끝난 질의 수다. 디스패치가 호출별로 증가를 보고 `dispatch-budget:`으로 알린다.
   *
   * @returns 누적 수
   */
  budgetExceededQueries(): number {
    return this.overBudget;
  }

  /**
   * 반사적 쓰기 대상 값을 처음 한 번 구한다. 반사적 쓰기는 속성 값을 모름으로만 바꾸므로(값을 더하지
   * 않는다), 빈 가정으로 구한 집합을 그 집합 가정으로 다시 구해 같으면 고정점이고, 다르면 모름으로 둔다.
   * 가정 아래 계산한 메모는 버린다.
   */
  private ensureReflective(): void {
    if (this.reflective !== undefined) return;
    this.reflective = EMPTY;
    if (this.index.reflectiveTargets.length === 0) return;
    const first = this.query(() => this.reflectiveValues());
    // 빈 가정으로 빈 집합을 얻었으면 가정이 곧 답이라 메모를 버릴 필요가 없다.
    if (first !== null && first.size === 0) return;
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
    this.frames = 0;
    try {
      return run();
    } catch (error) {
      // 예산 초과와 스택 초과(RangeError)는 증명 실패다(모름). 메모에는 완결된 단위만 남아 있다.
      if (!(error instanceof BudgetExceeded) && !(error instanceof RangeError)) throw error;
      this.overBudget++;
      this.active.clear();
      this.provisional.clear();
      this.reentered.clear();
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
    if (++this.frames > MAX_FRAMES) throw new BudgetExceeded();
    try {
      return this.expressionKindValues(skipWrappers(node));
    } finally {
      this.frames--;
    }
  }

  /**
   * 식 종류별로 값을 구한다.
   *
   * @param expression 래퍼를 벗긴 식
   * @returns 값 집합, 모르면 null
   */
  private expressionKindValues(expression: ts.Expression): Flow {
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
    if (owner === undefined || this.policy.isOpenCallable(owner.declaration)) return null;
    const classes = this.withSubclasses(owner.declaration);
    if (classes.some((declaration) => this.isEscapedClass(declaration))) return null;
    const method = owner.method;
    if (method === undefined) return new Set(classes);
    // 떼어 내기 판정은 메서드 자신을 읽는 `this.m`의 흐름을 구하므로(`setTimeout(this.tick.bind(this))`)
    // 메서드별 메모 단위로 감싼다. 재진입하면 빈 잠정값이 "닿을 수 있음"이 되어 보수적으로 끝난다.
    return this.unit(this.thisKey(method), () => (this.isDetachable(method, owner.declaration) ? null : new Set(classes)));
  }

  /**
   * 메서드 안 `this` 값의 메모 단위 키다(반환 값 단위와 겹치지 않게 따로 만든다).
   *
   * @param method 메서드
   * @returns 단위 키
   */
  private thisKey(method: ts.MethodDeclaration): object {
    let key = this.thisKeys.get(method);
    if (key === undefined) {
      key = { method };
      this.thisKeys.set(method, key);
    }
    return key;
  }

  /**
   * 클래스가 `new`·`extends 식별자`·static 접근·`instanceof`·`typeof` 밖의 자리에서 값으로 쓰였는지 본다
   * (`Mixin(Holder)`·인자로 넘김). 그러면 색인에 없는 하위 클래스가 생길 수 있어 `this`의 값을 다 알 수 없다.
   *
   * @param declaration 클래스
   * @returns 새어 나갔으면 true
   */
  private isEscapedClass(declaration: ts.ClassLikeDeclaration): boolean {
    const symbol = this.classSymbol(declaration);
    if (symbol === undefined) return true;
    return (this.index.references.get(symbol) ?? []).some((reference) => !isHarmlessClassUse(referenceSite(reference)));
  }

  /**
   * 메서드를 떼어 내 다른 `this`로 부를 수 있는지 본다: 이름이 같은 멤버를 호출 대상이 아닌 자리에서 읽는 위치
   * (`h.run.bind(x)`, `const f = h.run`, `const { run } = h`, `({ run } = h)`)가 있고, 그 읽기의 원본 객체가 이
   * 클래스(또는 하위 클래스)의 인스턴스가 아님을 흐름으로 증명하지 못한다.
   *
   * @param method 메서드
   * @param owner 소유 클래스
   * @returns 떼어 낼 수 있으면 true
   */
  private isDetachable(method: ts.MethodDeclaration, owner: ts.ClassLikeDeclaration): boolean {
    const name = memberName(method.name);
    if (name === undefined) return true;
    return (this.index.memberReads.get(name) ?? []).some((read) => !this.cannotReach(this.readSource(read), owner));
  }

  /**
   * 멤버 읽기 위치의 원본 객체 값이다. 대입 구조 분해 패턴은 원본을 여기서 알 수 없어 모름이다.
   *
   * @param read 속성 접근·바인딩 요소·대입 패턴 속성
   * @returns 원본 값
   */
  private readSource(read: ts.Node): Flow {
    if (ts.isPropertyAccessExpression(read) || ts.isElementAccessExpression(read)) return this.expressionUnit(read.expression);
    return ts.isBindingElement(read) && ts.isObjectBindingPattern(read.parent) ? this.patternSource(read.parent) : null;
  }

  /**
   * 클래스와 그 프로젝트 하위 클래스 전부다.
   *
   * @param declaration 클래스
   * @returns 클래스 목록(자신 먼저)
   */
  private withSubclasses(declaration: ts.ClassLikeDeclaration): readonly ts.ClassLikeDeclaration[] {
    const cached = this.subclassMemo.get(declaration);
    if (cached !== undefined) return cached;
    const seen = new Set([declaration]);
    const result = [declaration];
    for (let index = 0; index < result.length; index++) {
      for (const child of this.index.subclasses.get(result[index]!) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          result.push(child);
        }
      }
    }
    this.subclassMemo.set(declaration, result);
    return result;
  }

  /**
   * (종류, 노드·값)에 대한 파생 메모 단위 키다. 같은 노드라도 종류가 다르면 다른 단위다.
   *
   * @param kind 단위 종류
   * @param subject 노드·추상 값
   * @returns 단위 키
   */
  private keyFor(kind: string, subject: object): object {
    let byKind = this.derivedKeys.get(kind);
    if (byKind === undefined) {
      byKind = new Map();
      this.derivedKeys.set(kind, byKind);
    }
    let key = byKind.get(subject);
    if (key === undefined) {
      key = { kind, subject };
      byKind.set(subject, key);
    }
    return key;
  }

  /**
   * 식의 값을 메모 단위로 구한다. 이름으로 모은 쓰기·읽기 위치처럼 여러 질의가 되풀이해 묻는 식에 쓴다.
   *
   * @param expression 식
   * @returns 값 집합
   */
  private expressionUnit(expression: ts.Expression): Flow {
    return this.unit(this.keyFor('expression', expression), () => this.expressionValues(expression));
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
    // `#이름` 필드는 선언한 클래스 본문만 읽고 쓸 수 있어 심볼로 바로 구한다(이름으로 타입 멤버를 찾을 수 없다).
    if (ts.isPropertyAccessExpression(expression) && ts.isPrivateIdentifier(expression.name)) {
      return this.symbolValues(this.checker.getSymbolAtLocation(expression.name));
    }
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
    return unionFlows(result, this.foreignWrites(name, literal));
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
    if (ts.isVariableDeclaration(declaration)) return unionFlows(this.allVariableValues(symbol), this.identifierWrites(symbol));
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
   * 변수 심볼의 모든 선언(`var x = a; var x = b;`처럼 되풀이한 선언 포함)의 값 합이다. 변수가 아닌 선언이 섞이면 모름이다.
   *
   * @param symbol 변수 심볼
   * @returns 값 집합
   */
  private allVariableValues(symbol: ts.Symbol): Flow {
    let result: Flow = EMPTY;
    for (const declaration of symbol.declarations ?? []) {
      if (!ts.isVariableDeclaration(declaration) || !this.policy.isProjectFile(declaration.getSourceFile())) return null;
      result = unionFlows(result, this.variableValues(declaration));
      if (result === null) return null;
    }
    return result;
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
      const outer = referenceSite(reference);
      if (!ts.isCallExpression(outer.parent) || outer.parent.expression !== outer) return null;
      sites.push([...outer.parent.arguments]);
    }
    // 색인된 호출이 없으면, 참조 색인이 그 심볼에 대해 완전함을 증명할 때만 "호출 없음"으로 본다. 아니면 기본값만
    // 흐른다고 추측하지 않고 모름이다.
    return sites.length === 0 && !this.hasCompleteReferences(symbol) ? null : sites;
  }

  /**
   * 색인된 참조가 하나도 없는 심볼에 대해 "정말 참조가 없다"를 엄격히 증명한다: 분석 범위의 모든 파일에서 심볼 이름이나
   * 별칭 지역 이름과 텍스트가 같은 토큰(식별자·`#이름`·문자열 리터럴)이 그 심볼 자신의 선언 이름뿐이어야 한다. 해석
   * 결과를 믿지 않으므로 구조 분해 속성 이름·속성 접근 이름·`export default`·타입 자리·다른 심볼의 같은 이름까지 모두
   * 증명 실패로 본다(닫힌 쪽으로 실패).
   *
   * @param symbol 함수·클래스 심볼
   * @returns 증명되면 true
   */
  private hasCompleteReferences(symbol: ts.Symbol): boolean {
    if ((this.index.references.get(symbol) ?? []).length > 0) return false;
    const names = new Set([symbol.name, ...(this.index.aliasNames.get(symbol) ?? [])]);
    const own = new Set((symbol.declarations ?? []).map((declaration) => (declaration as { name?: ts.Node }).name).filter((name) => name !== undefined));
    return this.index.files.every((sourceFile) => ![...names].some((name) => sourceFile.text.includes(name)) || !hasForeignToken(sourceFile, names, own));
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
   * @param isSlotOwner 값을 구하는 매개변수의 클래스이면 true(하위 클래스로 따라 들어온 경우는 false)
   * @returns 인자 목록들 또는 null
   */
  private constructorSites(declaration: ts.ClassLikeDeclaration, isSlotOwner = true): CallSites {
    if (hasDecorators(declaration) || this.index.newThisClasses.has(declaration) || this.policy.isOpenCallable(declaration)) return null;
    const symbol = this.classSymbol(declaration);
    if (symbol === undefined) return null;
    const sites: (readonly ts.Expression[])[] = [];
    for (const reference of this.index.references.get(symbol) ?? []) {
      const found = this.constructorUse(referenceSite(reference));
      if (found === null) return null;
      sites.push(...found);
    }
    // 매개변수의 클래스에 색인된 생성 위치가 없으면, 참조 색인의 완전함을 증명할 때만 "생성 없음"으로 본다. 생성되지
    // 않는 하위 클래스는 기반 생성자에 인자를 더하지 않을 뿐이다.
    return sites.length === 0 && isSlotOwner && !this.hasCompleteReferences(symbol) ? null : sites;
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
    if (constructor === undefined) return this.constructorSites(subclass, false);
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
  private foreignWrites(name: string, owner: AbstractValue): Flow {
    const writes = this.index.propertyWrites.get(name) ?? [];
    if (writes.length === 0) return EMPTY;
    return this.unit(this.keyFor(`writes:${name}`, owner), () => {
      let result: Flow = EMPTY;
      for (const write of writes) {
        if (this.isUnrelatedClassWrite(write, owner)) continue;
        result = unionFlows(result, write.value === undefined ? null : this.expressionUnit(write.value));
        if (result === null) return null;
      }
      return result;
    });
  }

  /**
   * 속성 쓰기가 값에 닿을 수 없는지 본다(수신자 흐름으로, `cannotReach`).
   *
   * @param write 속성 쓰기
   * @param owner 값(클래스·객체 리터럴)
   * @returns 닿을 수 없으면 true
   */
  private isUnrelatedClassWrite(write: PropertyWrite, owner: AbstractValue): boolean {
    return this.cannotReach(this.expressionUnit(write.target.expression), owner);
  }

  /**
   * 접근의 수신자 값에 이 값(클래스면 그 하위 클래스 인스턴스 포함)이 없음이 흐름으로 증명되는지 본다. 타입으로는
   * 가르지 않는다 — 구조적 대입, 공통 상위 타입을 거친 배열 공변성, 메서드 매개변수 이변성 때문에 형변환 없이도 어느
   * 타입 자리에든 값이 들어갈 수 있다. 수신자 흐름을 모르거나 비어 있으면 닿을 수 있다고 본다.
   *
   * @param receivers 수신자 값
   * @param owner 값(클래스·객체 리터럴)
   * @returns 닿을 수 없으면 true
   */
  private cannotReach(receivers: Flow, owner: AbstractValue): boolean {
    // 빈 흐름(프로젝트 안 호출자가 없는 내보낸 함수의 매개변수 등)은 스캔 밖에서 채워질 수 있어 증명으로 쓰지 않는다.
    if (receivers === null || receivers.size === 0) return false;
    const targets = new Set<AbstractValue>(ts.isClassLike(owner) ? this.withSubclasses(owner) : [owner]);
    return ![...receivers].some((value) => targets.has(value));
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
    if (declarations.some(isMemberDeclaration) && !this.isSafeFromReflection(callee)) return null;
    return bodies as ts.FunctionLikeDeclaration[];
  }

  /**
   * 멤버 호출의 수신자가 반사적 쓰기(`Object.assign(x, { m })`)로 멤버가 바뀌었을 수 없는지 본다. 반사적 대상이
   * 없으면 안전하고, 대상을 모르면 안전하지 않다. 대상 집합이 알려져 있으면 수신자 값이 겹치지 않음을 증명해야
   * 한다(클래스·모듈 자체를 부르는 static 호출은 대상 집합에 들 수 없다 — 대상 집합은 인스턴스·리터럴뿐이다).
   *
   * @param callee 호출 대상 식
   * @returns 안전하면 true
   */
  private isSafeFromReflection(callee: ts.Expression): boolean {
    if (this.reflective !== null && this.reflective !== undefined && this.reflective.size === 0) return true;
    if (this.reflective === null || (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee))) return false;
    const owner = skipWrappers(callee.expression);
    const ownerSymbol = ts.isIdentifier(owner) ? this.dealias(this.checker.getSymbolAtLocation(owner)) : undefined;
    if (ownerSymbol !== undefined && (ownerSymbol.flags & (ts.SymbolFlags.ValueModule | ts.SymbolFlags.Class)) !== 0) return true;
    const receivers = this.expressionValues(owner);
    return receivers !== null && ![...receivers].some((value) => this.isReflectivelyWritten(value));
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
      const body = this.memberBody(value, name!);
      if (body === undefined) return null;
      result.push(body);
    }
    return result;
  }

  /**
   * 정확한 추상 값에서 이름 있는 멤버를 부를 때 실행되는 본문이다. 반사적 쓰기 대상이거나, 멤버를 바꿀 수 있는
   * 같은 이름 속성 쓰기가 있거나, 데코레이터·`let` 별칭처럼 본문을 증명하지 못하면 undefined다.
   *
   * @param value 추상 값
   * @param name 멤버 이름
   * @returns 함수 계열 또는 undefined
   */
  private memberBody(value: AbstractValue, name: string): ts.FunctionLikeDeclaration | undefined {
    if (this.isReflectivelyWritten(value)) return undefined;
    const member = this.checker.getPropertyOfType(this.valueType(value), name);
    const body = member?.valueDeclaration === undefined ? null : this.functionBody(member.valueDeclaration, name, true);
    return body ?? undefined;
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
  private functionBody(declaration: ts.Declaration, name: string, exact = false, depth = 0): ts.FunctionLikeDeclaration | undefined | null {
    if (!this.policy.isProjectFile(declaration.getSourceFile()) || isAmbient(declaration) || depth > MAX_ALIAS_DEPTH) return null;
    if ((ts.isMethodDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && (ts.getDecorators(declaration) ?? []).length > 0) return null;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) {
      if (declaration.body === undefined) return undefined;
      if (!exact && ts.isMethodDeclaration(declaration) && ts.isClassLike(declaration.parent) && this.policy.isOverridden(declaration)) return null;
      return ts.isMethodDeclaration(declaration) && this.hasForeignMemberWrites(declaration, name) ? null : declaration;
    }
    const isMember = !ts.isVariableDeclaration(declaration);
    if (ts.isVariableDeclaration(declaration) ? !isConstDeclaration(declaration) : this.hasForeignMemberWrites(declaration, name)) return null;
    if (ts.isShorthandPropertyAssignment(declaration)) return this.aliasBody(this.checker.getShorthandAssignmentValueSymbol(declaration), depth);
    const initializer = ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)
      ? declaration.initializer : undefined;
    if (initializer === undefined || (!isMember && !ts.isVariableDeclaration(declaration))) return null;
    const inner = skipWrappers(initializer);
    if (isFunctionValued(inner)) return inner as ts.ArrowFunction | ts.FunctionExpression;
    return ts.isIdentifier(inner) || ts.isPropertyAccessExpression(inner) ? this.aliasBody(this.calleeSymbol(inner), depth) : null;
  }

  /**
   * 값 별칭(`{ find: findItem }`, `{ findItem }`, `const h = g`)이 가리키는 함수 본문이다. 본문이 정확히 하나여야 한다.
   *
   * @param symbol 별칭이 가리키는 심볼
   * @param depth 별칭 추적 깊이
   * @returns 함수 계열 또는 null
   */
  private aliasBody(symbol: ts.Symbol | undefined, depth: number): ts.FunctionLikeDeclaration | null {
    const target = this.dealias(symbol);
    if (target === undefined) return null;
    const bodies = (target.declarations ?? []).map((declaration) => this.functionBody(declaration, target.name, false, depth + 1))
      .filter((body) => body !== undefined);
    return bodies.length === 1 ? bodies[0]! : null;
  }

  /**
   * 멤버를 이름이 같은 속성 쓰기가 바꿀 수 있는지 본다(관계없는 클래스 멤버 쓰기는 제외).
   *
   * @param declaration 멤버 선언
   * @param name 멤버 이름
   * @returns 바꿀 수 있는 쓰기가 있으면 true
   */
  private hasForeignMemberWrites(declaration: ts.Declaration, name: string): boolean {
    const owner = declaration.parent;
    const writes = this.index.propertyWrites.get(name) ?? [];
    if (writes.length === 0) return false;
    if (!ts.isClassLike(owner) && !ts.isObjectLiteralExpression(owner)) return true;
    // 모름(null)을 "바꿀 수 있는 쓰기가 있다"로 쓰는 메모 단위다.
    const verdict = this.unit(this.keyFor(`patch:${name}`, owner), () =>
      (writes.some((write) => !this.isUnrelatedClassWrite(write, owner)) ? null : EMPTY));
    return verdict === null;
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
      this.reentered.add(key);
      return this.provisional.get(key) ?? EMPTY;
    }
    const position = this.active.size;
    const outerLowest = this.lowestOpen;
    this.active.set(key, position);
    if (++this.depth > MAX_DEPTH) throw new BudgetExceeded();
    const result = this.iterateUnit(key, compute);
    this.depth--;
    this.active.delete(key);
    this.provisional.delete(key);
    const complete = result === null || this.lowestOpen >= position;
    if (complete) this.memo.set(key, result);
    this.lowestOpen = Math.min(outerLowest, complete ? Number.POSITIVE_INFINITY : this.lowestOpen);
    return result;
  }

  /**
   * 메모 단위를 자기 순환의 고정점까지 되풀이 계산한다. 계산 중 자기 자신을 다시 만나면 직전 결과(처음엔 빈
   * 집합)를 잠정값으로 돌려주고, 결과가 잠정값과 같아질 때까지 다시 계산한다. 속성·호출처럼 값에 따라 결과가
   * 달라지는 단계가 순환 안에 있어도(`this.store = this.store.withCache()`) 값이 빠지지 않게 하기 위해서다.
   * 모든 단계가 단조이고 추상 값이 유한하므로 끝나며, 되풀이 상한을 넘으면 모름이다.
   *
   * @param key 단위 키
   * @param compute 계산
   * @returns 고정점 결과(모름이면 null)
   */
  private iterateUnit(key: UnitKey, compute: () => Flow): Flow {
    for (let round = 0; ; round++) {
      this.lowestOpen = Number.POSITIVE_INFINITY;
      this.reentered.delete(key);
      const result = compute();
      if (result === null || !this.reentered.has(key) || sameFlow(result, this.provisional.get(key) ?? EMPTY)) return result;
      if (round >= MAX_ROUNDS) throw new BudgetExceeded();
      this.provisional.set(key, result);
    }
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
 * 파일에 이름이 같은 토큰 중 허용한 선언 이름이 아닌 것이 있는지 본다(해석하지 않는 문법 검사).
 *
 * @param sourceFile 파일
 * @param names 찾는 이름
 * @param own 허용하는 선언 이름 노드
 * @returns 있으면 true
 */
function hasForeignToken(sourceFile: ts.SourceFile, names: ReadonlySet<string>, own: ReadonlySet<ts.Node>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    const text = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    if (text !== undefined && names.has(text) && !own.has(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * `this`가 가리키는 인스턴스의 클래스다. 화살표 함수는 건너뛰고, 인스턴스 멤버(메서드·생성자·접근자·필드
 * 초기값) 안이 아니면 undefined다.
 *
 * @param node this 키워드
 * @returns 클래스 또는 undefined
 */
function thisOwner(node: ts.Node): { declaration: ts.ClassLikeDeclaration; method: ts.MethodDeclaration | undefined } | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (ts.isArrowFunction(current)) continue;
    const isMember = ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current) || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current) || ts.isPropertyDeclaration(current);
    if (isMember) {
      if (!ts.isClassLike(current.parent) || isStatic(current as ts.ClassElement)) return undefined;
      return { declaration: current.parent, method: ts.isMethodDeclaration(current) ? current : undefined };
    }
    if (ts.isFunctionLike(current) || ts.isClassStaticBlockDeclaration(current) || ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

/**
 * 클래스 참조가 하위 클래스를 몰래 만들 수 없는 자리인지 본다: `new C`, `class D extends C`, `C.x`, `instanceof C`,
 * `typeof C`, `implements C`.
 *
 * @param outer 래퍼까지 올라간 참조 식
 * @returns 무해한 사용이면 true
 */
function isHarmlessClassUse(outer: ts.Node): boolean {
  const parent = outer.parent;
  if (ts.isNewExpression(parent) && parent.expression === outer) return true;
  if (ts.isExpressionWithTypeArguments(parent) && ts.isHeritageClause(parent.parent)) return true;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === outer) return true;
  if (ts.isBinaryExpression(parent) && parent.right === outer && parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) return true;
  return ts.isTypeOfExpression(parent);
}

/**
 * 수신자가 있는 멤버 선언(메서드·객체 리터럴 속성·클래스 필드)인지 본다.
 *
 * @param declaration 선언
 * @returns 멤버면 true
 */
function isMemberDeclaration(declaration: ts.Declaration): boolean {
  return ts.isMethodDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isShorthandPropertyAssignment(declaration)
    || ts.isPropertyDeclaration(declaration);
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
