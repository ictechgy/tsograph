/**
 * 문장 목록·매개변수·import를 스코프 바인딩으로 선언한다.
 *
 * 모든 선언은 지연 평가 바인딩이다. 선언된 이름은 의미가 `other`여도 반드시 선언한다 —
 * 바깥의 클라이언트 바인딩을 같은 이름의 지역 변수·매개변수가 가리면 그 안의 접근은
 * 클라이언트가 아니기 때문이다.
 */

import ts from 'typescript';

import {
  type BindingEvaluator,
  type BindingKind,
  CLIENT,
  CLIENT_FACTORY,
  CLIENT_TYPE,
  type ClassMembers,
  type EvaluationContext,
  OTHER,
  Scope,
} from './client-binding.ts';

/** 스코프 빌더다. 파일 하나에 하나씩 둔다. */
export class ScopeBuilder {
  /** 식·타입 평가기다. */
  private readonly evaluator: BindingEvaluator;

  /**
   * @param evaluator 평가기
   */
  constructor(evaluator: BindingEvaluator) {
    this.evaluator = evaluator;
  }

  /**
   * 문장 목록의 선언을 스코프에 올린다(let·const·var·function·class·type·interface·enum).
   *
   * @param statements 문장 목록
   * @param context 선언이 속한 스코프와 `this` 문맥
   */
  hoistStatements(statements: readonly ts.Statement[], context: EvaluationContext): void {
    for (const statement of statements) this.hoistStatement(statement, context);
  }

  /**
   * 문장 하나의 선언을 올린다.
   *
   * @param statement 문장
   * @param context 선언 문맥
   */
  private hoistStatement(statement: ts.Statement, context: EvaluationContext): void {
    const scope = context.scope;
    if (ts.isVariableStatement(statement)) {
      this.declareVariables(statement.declarationList, context);
    } else if (ts.isFunctionDeclaration(statement)) {
      scope.declareValue(statement.name?.text ?? 'default',
        () => (this.evaluator.returnsClient(statement, context) ? CLIENT_FACTORY : OTHER));
    } else if (ts.isClassDeclaration(statement)) {
      const name = statement.name?.text ?? 'default';
      scope.declareValue(name, () => OTHER);
      scope.declareType(name, () => OTHER);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      scope.declareType(statement.name.text,
        () => (this.evaluator.isClientType(statement.type, context) ? CLIENT_TYPE : OTHER));
    } else if (ts.isInterfaceDeclaration(statement)) {
      scope.declareType(statement.name.text, () => this.interfaceKind(statement, context));
    } else if (ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) {
      this.declareOpaque(statement.name, scope);
    } else if (ts.isImportEqualsDeclaration(statement)) {
      scope.declareValue(statement.name.text, () => OTHER);
    }
  }

  /**
   * 이름만 가리는 선언(enum·namespace)을 값과 타입 양쪽에 올린다.
   *
   * @param name 선언 이름
   * @param scope 스코프
   */
  private declareOpaque(name: ts.ModuleName, scope: Scope): void {
    if (!ts.isIdentifier(name)) return;
    scope.declareValue(name.text, () => OTHER);
    scope.declareType(name.text, () => OTHER);
  }

  /**
   * `interface X extends PrismaClient {}`는 클라이언트 타입이다.
   *
   * @param statement 인터페이스 선언
   * @param context 선언 문맥
   * @returns 의미
   */
  private interfaceKind(statement: ts.InterfaceDeclaration, context: EvaluationContext): BindingKind {
    const heritage = statement.heritageClauses?.flatMap((clause) => clause.types) ?? [];
    const extendsClient = heritage.some((type) => {
      const reference = ts.factory.createTypeReferenceNode(expressionToEntity(type.expression) ?? 'unknown');
      return this.evaluator.isClientType(reference, context);
    });
    return extendsClient ? CLIENT_TYPE : OTHER;
  }

  /**
   * 변수 선언 목록을 올린다. 구조 분해로 묶인 이름은 모두 `other`로 가린다.
   *
   * @param list 선언 목록
   * @param context 선언 문맥
   */
  declareVariables(list: ts.VariableDeclarationList, context: EvaluationContext): void {
    const isConst = (list.flags & ts.NodeFlags.Const) !== 0;
    for (const declaration of list.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        context.scope.declareValue(declaration.name.text, () => this.variableKind(declaration, isConst, context));
      } else {
        this.declareDestructured(declaration, context);
      }
    }
  }

  /**
   * 구조 분해 선언을 올린다. `const { PrismaClient } = require('@prisma/client')`처럼 원천이
   * Prisma·프로젝트 모듈이면 멤버 의미를, 아니면 `other`를 준다.
   *
   * @param declaration 변수 선언
   * @param context 선언 문맥
   */
  private declareDestructured(declaration: ts.VariableDeclaration, context: EvaluationContext): void {
    const pattern = declaration.name;
    const initializer = declaration.initializer;
    for (const { local, property } of bindingElements(pattern)) {
      context.scope.declareValue(local, () => {
        if (property === undefined || initializer === undefined || !ts.isObjectBindingPattern(pattern)) return OTHER;
        return this.evaluator.memberOf(this.evaluator.expression(initializer, context), property);
      });
    }
  }

  /**
   * 변수 하나의 의미다. 타입 표기가 있으면 그것만 믿고, 없으면 초기값을 본다. 문자열 상수는
   * `const`일 때만 의미가 있다(재할당될 수 있는 값을 SQL로 읽지 않는다).
   *
   * @param declaration 변수 선언
   * @param isConst const 선언인지 여부
   * @param context 선언 문맥
   * @returns 의미
   */
  private variableKind(declaration: ts.VariableDeclaration, isConst: boolean, context: EvaluationContext): BindingKind {
    if (declaration.type !== undefined) {
      if (this.evaluator.isClientType(declaration.type, context)) return CLIENT;
      if (ts.isFunctionTypeNode(declaration.type) && this.evaluator.isClientType(declaration.type.type, context)) {
        return CLIENT_FACTORY;
      }
    }
    if (declaration.initializer === undefined) return OTHER;
    const kind = this.evaluator.expression(declaration.initializer, context);
    if ((kind.kind === 'string' || kind.kind === 'sql-fragment') && !isConst) return OTHER;
    return kind;
  }

  /**
   * 함수 매개변수를 올린다. 타입 표기가 클라이언트면 클라이언트이고, `$transaction` 콜백의 첫
   * 매개변수도 클라이언트다.
   *
   * @param node 함수 노드
   * @param context 함수 안 스코프 문맥(매개변수 타입은 함수가 선언된 문맥에서 평가한다)
   * @param outer 함수가 선언된 문맥
   * @param isTransactionCallback `$transaction` 콜백인지 여부
   */
  declareParameters(
    node: ts.SignatureDeclaration,
    context: EvaluationContext,
    outer: EvaluationContext,
    isTransactionCallback: boolean,
  ): void {
    node.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) {
        for (const { local } of bindingElements(parameter.name)) context.scope.declareValue(local, () => OTHER);
        return;
      }
      context.scope.declareValue(parameter.name.text, () => {
        if (parameter.type !== undefined) return this.evaluator.isClientType(parameter.type, outer) ? CLIENT : OTHER;
        return isTransactionCallback && index === 0 ? CLIENT : OTHER;
      });
    });
  }

  /**
   * 클래스의 `this` 멤버 의미를 만든다(필드 선언·매개변수 속성).
   *
   * @param node 클래스 노드
   * @param context 클래스가 선언된 문맥
   * @returns 멤버 이름 → 지연 의미
   */
  classMembers(node: ts.ClassLikeDeclaration, context: EvaluationContext): ClassMembers {
    const members = new Map<string, () => BindingKind>();
    const memberContext: EvaluationContext = { scope: context.scope, thisMembers: members };
    for (const member of node.members) {
      if (ts.isPropertyDeclaration(member) && !isStatic(member)) this.addPropertyMember(member, memberContext, members);
      if (ts.isConstructorDeclaration(member)) this.addParameterProperties(member, memberContext, members);
    }
    return members;
  }

  /**
   * 필드 선언 멤버를 더한다.
   *
   * @param member 필드 선언
   * @param context 멤버 문맥
   * @param members 멤버 표(추가된다)
   */
  private addPropertyMember(
    member: ts.PropertyDeclaration,
    context: EvaluationContext,
    members: Map<string, () => BindingKind>,
  ): void {
    const name = memberName(member.name);
    if (name === undefined || members.has(name)) return;
    members.set(name, memoize(() => {
      if (member.type !== undefined) return this.evaluator.isClientType(member.type, context) ? CLIENT : OTHER;
      return member.initializer === undefined ? OTHER : this.evaluator.expression(member.initializer, context);
    }));
  }

  /**
   * 생성자 매개변수 속성(`constructor(private readonly prisma: PrismaClient)`)을 더한다.
   *
   * @param constructor 생성자 선언
   * @param context 멤버 문맥
   * @param members 멤버 표(추가된다)
   */
  private addParameterProperties(
    constructor: ts.ConstructorDeclaration,
    context: EvaluationContext,
    members: Map<string, () => BindingKind>,
  ): void {
    for (const parameter of constructor.parameters) {
      if (!ts.isIdentifier(parameter.name) || !ts.isParameterPropertyDeclaration(parameter, constructor)) continue;
      const type = parameter.type;
      members.set(parameter.name.text, memoize(() => (
        type !== undefined && this.evaluator.isClientType(type, context) ? CLIENT : OTHER)));
    }
  }
}

/**
 * import 바인딩을 모듈 스코프에 값·타입 양쪽으로 올린다.
 *
 * @param scope 모듈 스코프
 * @param local 로컬 이름
 * @param compute 의미 계산 함수
 */
export function declareImport(scope: Scope, local: string, compute: () => BindingKind): void {
  const memoized = memoize(compute);
  scope.declareValue(local, memoized);
  scope.declareType(local, memoized);
}

/** 구조 분해로 묶인 로컬 이름과, 객체 패턴이면 원천 속성 이름이다. */
interface BoundElement {
  readonly local: string;
  readonly property: string | undefined;
}

/**
 * 구조 분해 패턴의 모든 로컬 이름을 모은다.
 *
 * @param pattern 바인딩 이름
 * @returns 로컬 이름과 (최상위 객체 패턴이면) 속성 이름
 */
export function bindingElements(pattern: ts.BindingName): BoundElement[] {
  if (ts.isIdentifier(pattern)) return [{ local: pattern.text, property: undefined }];
  const result: BoundElement[] = [];
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (!ts.isIdentifier(element.name)) {
      result.push(...bindingElements(element.name).map((inner) => ({ local: inner.local, property: undefined })));
      continue;
    }
    const property = ts.isObjectBindingPattern(pattern) && element.dotDotDotToken === undefined
      ? propertyNameText(element.propertyName) ?? element.name.text
      : undefined;
    result.push({ local: element.name.text, property });
  }
  return result;
}

/**
 * 속성 이름 노드의 정적 텍스트다.
 *
 * @param name 속성 이름
 * @returns 텍스트. 없거나 계산된 이름이면 undefined
 */
function propertyNameText(name: ts.PropertyName | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/**
 * 클래스 멤버 이름의 정적 텍스트다(`#private` 포함).
 *
 * @param name 멤버 이름
 * @returns 텍스트 또는 undefined
 */
export function memberName(name: ts.PropertyName): string | undefined {
  if (ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return propertyNameText(name);
}

/**
 * static 멤버인지 본다.
 *
 * @param member 클래스 멤버
 * @returns static이면 true
 */
function isStatic(member: ts.PropertyDeclaration): boolean {
  return (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

/**
 * 식(`A`·`A.B`)을 엔터티 이름으로 바꾼다.
 *
 * @param expression 상속 절의 식
 * @returns 엔터티 이름 또는 undefined
 */
function expressionToEntity(expression: ts.Expression): ts.EntityName | undefined {
  if (ts.isIdentifier(expression)) return expression;
  if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.name)) return undefined;
  const left = expressionToEntity(expression.expression);
  return left === undefined ? undefined : ts.factory.createQualifiedName(left, expression.name);
}

/**
 * 한 번만 계산하는 함수로 감싼다. 순환 호출은 `other`로 끊는다.
 *
 * @param compute 계산 함수
 * @returns 메모이즈된 함수
 */
function memoize(compute: () => BindingKind): () => BindingKind {
  let state: 'pending' | 'computing' | 'done' = 'pending';
  let value: BindingKind = OTHER;
  return () => {
    if (state === 'done') return value;
    if (state === 'computing') return OTHER;
    state = 'computing';
    value = compute();
    state = 'done';
    return value;
  };
}
