/**
 * ORM·드라이버 값의 출처를 구문과 이름 해석만으로 판정하는 평가기다.
 *
 * 식 하나가 "Drizzle 테이블 객체", "TypeORM 저장소", "knex 인스턴스", "D1 바인딩" 같은 값인지를
 * 선언·초기값·타입 표기·데코레이터를 따라가며 판정한다. ORM별 판정(어떤 import의 어떤 호출이 무엇을
 * 만드는가)은 `OrmValueRules`로 꽂는다 — 평가기 자체는 ORM을 모른다. 증명하지 못한 값은 `unknown`이며,
 * 호출자는 unknown 수신자를 사실로 내지 않는다(같은 이름의 다른 메서드를 테이블 사용으로 오독하지 않기 위해).
 */

import ts from 'typescript';

import { type BindingOrigin, type OrmBinder } from './orm-binder.ts';
import type { DrizzleTable, SequelizeModel, TypeormEntity } from './orm-model.ts';

/** 평가 결과다. ORM과 무관한 값은 `unknown`이다. */
export type OrmValue =
  | { readonly kind: 'unknown' }
  /** 해석하지 않은 외부 패키지 export다. `name`은 `*`·`default`·`a.b` 꼴 경로다. */
  | { readonly kind: 'external'; readonly module: string; readonly name: string }
  | { readonly kind: 'module'; readonly sourceFile: ts.SourceFile }
  | { readonly kind: 'object'; readonly node: ts.ObjectLiteralExpression }
  | { readonly kind: 'string'; readonly value: string; readonly node: ts.StringLiteralLike }
  | { readonly kind: 'function'; readonly node: ts.SignatureDeclaration }
  | { readonly kind: 'drizzle-schema'; readonly schema: string | undefined }
  | { readonly kind: 'drizzle-creator'; readonly rename: ((name: string) => string) | undefined }
  | { readonly kind: 'drizzle-table'; readonly table: DrizzleTable }
  /** `schema`는 관계형 쿼리 스키마를 주는 식(`drizzle(c, { schema })`) 또는 타입 인자(`typeof schema`)다. */
  | { readonly kind: 'drizzle-db'; readonly schema: ts.Expression | ts.TypeNode | undefined }
  | { readonly kind: 'drizzle-query'; readonly schema: ts.Expression | ts.TypeNode | undefined }
  | { readonly kind: 'typeorm-entity'; readonly entity: TypeormEntity }
  | { readonly kind: 'typeorm-repository'; readonly entity: TypeormEntity }
  | { readonly kind: 'typeorm-manager' }
  | { readonly kind: 'sequelize' }
  | { readonly kind: 'sequelize-model'; readonly model: SequelizeModel }
  | { readonly kind: 'knex' }
  | { readonly kind: 'sql-client'; readonly driver: string }
  | { readonly kind: 'sql-tag'; readonly driver: string };

/** 모름 값이다. */
export const UNKNOWN: OrmValue = { kind: 'unknown' };

/** 평가 깊이 상한이다. 긴 초기값·반환 사슬을 끊는다. */
const MAX_DEPTH = 48;

/**
 * ORM별 판정 규칙이다. 각 메서드는 판정하지 못하면 undefined를 돌려 다음 규칙에 넘긴다.
 */
export interface OrmValueRules {
  /** `callee(...)` 호출. `callee`는 호출 대상 식의 값이다. */
  call?(callee: OrmValue, node: ts.CallExpression): OrmValue | undefined;
  /** `receiver.method(...)` 호출. */
  methodCall?(receiver: OrmValue, method: string, node: ts.CallExpression): OrmValue | undefined;
  /** `new callee(...)`. */
  construct?(callee: OrmValue, node: ts.NewExpression): OrmValue | undefined;
  /** `receiver.name` 접근. */
  member?(receiver: OrmValue, name: string, node: ts.Expression): OrmValue | undefined;
  /** 타입 참조. `target`은 타입 이름의 값(외부 import·전역 이름 등)이다. */
  typeReference?(target: OrmValue | { readonly kind: 'global'; readonly name: string }, node: ts.TypeReferenceNode): OrmValue | undefined;
  /** 클래스 선언의 값(엔터티·모델 클래스). */
  classValue?(node: ts.ClassLikeDeclaration): OrmValue | undefined;
  /** 데코레이터가 값을 정하는 매개변수·필드(`@InjectRepository(User)`). */
  decorated?(decorators: readonly ts.Decorator[]): OrmValue | undefined;
  /** 호출 인자인 콜백의 매개변수(`knex.transaction(trx => …)`). */
  callbackParameter?(call: ts.CallExpression, callee: OrmValue, parameterIndex: number): OrmValue | undefined;
  /** 식별자가 선언되지 않은 전역 이름일 때. */
  global?(name: string, node: ts.Identifier): OrmValue | undefined;
}

/** 값 평가기다. 프로젝트 하나에 하나를 둔다. */
export class OrmEvaluator {
  /** 이름 해석기다. */
  readonly binder: OrmBinder;
  /** ORM별 규칙이다. */
  private readonly rules: OrmValueRules[] = [];
  /** 식 노드 → 값 메모다. */
  private readonly memo = new Map<ts.Node, OrmValue>();
  /** 계산 중인 노드다(순환 감지). */
  private readonly computing = new Set<ts.Node>();
  /** 현재 평가 깊이다. */
  private depth = 0;

  /**
   * @param binder 이름 해석기
   */
  constructor(binder: OrmBinder) {
    this.binder = binder;
  }

  /**
   * 규칙을 더한다. 먼저 더한 규칙이 우선한다.
   *
   * @param rules 규칙
   */
  addRules(rules: OrmValueRules): void {
    this.rules.push(rules);
  }

  /** 메모를 비운다. 선언 수집이 끝나 규칙의 답이 바뀔 수 있을 때 부른다. */
  resetCache(): void {
    this.memo.clear();
  }

  /**
   * 식의 값을 돌려준다.
   *
   * @param expression 식
   * @returns 값
   */
  valueOf(expression: ts.Expression): OrmValue {
    const cached = this.memo.get(expression);
    if (cached !== undefined) return cached;
    if (this.computing.has(expression) || this.depth >= MAX_DEPTH) return UNKNOWN;
    this.computing.add(expression);
    this.depth++;
    try {
      const value = this.compute(expression);
      this.memo.set(expression, value);
      return value;
    } finally {
      this.depth--;
      this.computing.delete(expression);
    }
  }

  /**
   * 타입 표기의 값을 돌려준다.
   *
   * @param type 타입 노드
   * @returns 값
   */
  typeValue(type: ts.TypeNode): OrmValue {
    if (this.depth >= MAX_DEPTH) return UNKNOWN;
    this.depth++;
    try {
      return this.computeType(type);
    } finally {
      this.depth--;
    }
  }

  /**
   * 선언의 값을 돌려준다(변수 초기값·타입 표기·클래스·함수·매개변수).
   *
   * @param declaration 선언
   * @returns 값
   */
  declarationValue(declaration: ts.Declaration): OrmValue {
    if (this.computing.has(declaration) || this.depth >= MAX_DEPTH) return UNKNOWN;
    this.computing.add(declaration);
    this.depth++;
    try {
      return this.computeDeclaration(declaration);
    } finally {
      this.depth--;
      this.computing.delete(declaration);
    }
  }

  /**
   * 이름 해석 결과를 값으로 바꾼다.
   *
   * @param origin 해석 결과
   * @param node 이름 노드(전역 규칙용)
   * @returns 값
   */
  originValue(origin: BindingOrigin, node: ts.Node): OrmValue {
    switch (origin.kind) {
      case 'external': return { kind: 'external', module: origin.module, name: origin.name };
      case 'module': return { kind: 'module', sourceFile: origin.sourceFile };
      case 'declaration': return this.declarationValue(origin.declaration);
      case 'global': return ts.isIdentifier(node) ? this.firstRule((rules) => rules.global?.(origin.name, node)) : UNKNOWN;
      default: return UNKNOWN;
    }
  }

  /**
   * 함수가 돌려주는 값이다: 반환 타입 표기, 식 본문, 또는 모든 return 식이 같은 값일 때 그 값.
   *
   * @param node 함수 노드
   * @returns 값
   */
  returnValue(node: ts.SignatureDeclaration): OrmValue {
    if (node.type !== undefined) return this.typeValue(unwrapPromise(node.type));
    const body = (node as ts.FunctionLikeDeclaration).body;
    if (body === undefined) return UNKNOWN;
    if (!ts.isBlock(body)) return this.valueOf(body);
    const values = returnExpressions(body).map((expression) => this.valueOf(expression));
    return sameValue(values);
  }

  /**
   * 객체 값의 멤버 값을 돌려준다(`receiver.name`과 같은 규칙).
   *
   * @param receiver 수신자 값
   * @param name 멤버 이름
   * @param node 접근 식(규칙용)
   * @returns 값
   */
  memberValue(receiver: OrmValue, name: string, node: ts.Expression): OrmValue {
    if (receiver.kind === 'module') {
      const origin = this.binder.exportsOf(receiver.sourceFile).get(name);
      return origin === undefined ? UNKNOWN : this.originValue(origin, node);
    }
    if (receiver.kind === 'external' && (receiver.name === '*' || receiver.name === 'default')) {
      return { kind: 'external', module: receiver.module, name };
    }
    if (receiver.kind === 'object') {
      const initializer = this.propertyOf(receiver.node, name);
      if (initializer === null) return UNKNOWN;
      if (initializer !== undefined) return this.valueOf(initializer);
    }
    const ruled = this.firstRule((rules) => rules.member?.(receiver, name, node));
    if (ruled.kind !== 'unknown') return ruled;
    return receiver.kind === 'external' ? { kind: 'external', module: receiver.module, name: `${receiver.name}.${name}` } : UNKNOWN;
  }

  /**
   * 객체 리터럴의 속성 값 식을 스프레드까지 따라 찾는다(뒤의 속성이 앞을 덮는다).
   *
   * @param object 객체 리터럴
   * @param name 속성 이름
   * @param depth 스프레드 깊이
   * @returns 값 식, 없으면 undefined, 풀지 못한 스프레드가 가릴 수 있으면 null
   */
  propertyOf(object: ts.ObjectLiteralExpression, name: string, depth = 0): ts.Expression | undefined | null {
    for (let index = object.properties.length - 1; index >= 0; index--) {
      const property = object.properties[index]!;
      if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === name) return property.initializer;
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
      if (!ts.isSpreadAssignment(property)) continue;
      const spread = depth > 4 ? UNKNOWN : this.valueOf(property.expression);
      if (spread.kind !== 'object') return null;
      const found = this.propertyOf(spread.node, name, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /**
   * 규칙을 차례로 물어 첫 답을 돌려준다.
   *
   * @param ask 규칙 하나에 묻는 함수
   * @returns 첫 답 또는 unknown
   */
  private firstRule(ask: (rules: OrmValueRules) => OrmValue | undefined): OrmValue {
    for (const rules of this.rules) {
      const value = ask(rules);
      if (value !== undefined) return value;
    }
    return UNKNOWN;
  }

  /**
   * 식 종류별 계산이다.
   *
   * @param expression 식
   * @returns 값
   */
  private compute(expression: ts.Expression): OrmValue {
    if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isSatisfiesExpression(expression)
      || ts.isAwaitExpression(expression)) {
      return this.valueOf(expression.expression);
    }
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      const typed = this.typeValue(expression.type);
      return typed.kind === 'unknown' ? this.valueOf(expression.expression) : typed;
    }
    if (ts.isIdentifier(expression)) return this.originValue(this.binder.originOf(expression), expression);
    if (ts.isPropertyAccessExpression(expression)) return this.propertyAccess(expression);
    if (ts.isElementAccessExpression(expression) && ts.isStringLiteralLike(expression.argumentExpression)) {
      return this.memberValue(this.valueOf(expression.expression), expression.argumentExpression.text, expression);
    }
    if (ts.isCallExpression(expression)) return this.callValue(expression);
    if (ts.isNewExpression(expression)) return this.firstRule((rules) => rules.construct?.(this.valueOf(expression.expression), expression));
    return this.literalValue(expression);
  }

  /**
   * 리터럴·조건·이항 식의 값이다.
   *
   * @param expression 식
   * @returns 값
   */
  private literalValue(expression: ts.Expression): OrmValue {
    if (ts.isStringLiteralLike(expression)) return { kind: 'string', value: expression.text, node: expression };
    if (ts.isObjectLiteralExpression(expression)) return { kind: 'object', node: expression };
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return { kind: 'function', node: expression };
    if (ts.isConditionalExpression(expression)) {
      return sameValue([expression.whenTrue, expression.whenFalse].filter((branch) => !isNullish(branch)).map((branch) => this.valueOf(branch)));
    }
    if (ts.isBinaryExpression(expression) && isFallbackOperator(expression.operatorToken.kind)) {
      const left = this.valueOf(expression.left);
      return left.kind === 'unknown' ? this.valueOf(expression.right) : left;
    }
    return UNKNOWN;
  }

  /**
   * `a.b` 접근의 값이다. `this.x`는 클래스 멤버 선언을 본다.
   *
   * @param expression 접근 식
   * @returns 값
   */
  private propertyAccess(expression: ts.PropertyAccessExpression): OrmValue {
    const name = expression.name.text;
    if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) return this.thisMember(expression, name);
    const value = this.memberValue(this.valueOf(expression.expression), name, expression);
    return value.kind === 'unknown' ? this.declaredMember(expression.expression, name) : value;
  }

  /**
   * 수신자의 선언 타입 표기에서 멤버 타입을 찾아 값으로 읽는다(`deps.db`에서 `deps: { db: D1Database }`).
   *
   * @param receiver 수신자 식
   * @param name 멤버 이름
   * @returns 값
   */
  private declaredMember(receiver: ts.Expression, name: string): OrmValue {
    const type = this.declaredType(receiver, 0);
    const member = type === undefined ? undefined : this.memberType(type, name, 0);
    return member === undefined ? UNKNOWN : this.typeValue(member);
  }

  /**
   * 식의 선언 타입 표기다(식별자·`a.b` 사슬·구조 분해 매개변수).
   *
   * @param expression 식
   * @param depth 깊이
   * @returns 타입 노드 또는 undefined
   */
  private declaredType(expression: ts.Expression, depth: number): ts.TypeNode | undefined {
    if (depth > 8) return undefined;
    const inner = skipExpressionWrappers(expression);
    if (ts.isPropertyAccessExpression(inner)) {
      const owner = this.declaredType(inner.expression, depth + 1);
      return owner === undefined ? undefined : this.memberType(owner, inner.name.text, 0);
    }
    if (!ts.isIdentifier(inner)) return undefined;
    const origin = this.binder.originOf(inner);
    return origin.kind === 'declaration' ? this.declarationType(origin.declaration, depth) : undefined;
  }

  /**
   * 선언의 타입 표기다. 매개변수 구조 분해 원소는 매개변수 타입의 멤버 타입이다.
   *
   * @param declaration 선언
   * @param depth 깊이
   * @returns 타입 노드 또는 undefined
   */
  private declarationType(declaration: ts.Declaration, depth: number): ts.TypeNode | undefined {
    if (ts.isParameter(declaration) || ts.isVariableDeclaration(declaration) || ts.isPropertyDeclaration(declaration)
      || ts.isPropertySignature(declaration)) {
      return declaration.type;
    }
    if (!ts.isBindingElement(declaration) || !ts.isObjectBindingPattern(declaration.parent)) return undefined;
    const key = declaration.propertyName ?? declaration.name;
    const owner = declaration.parent.parent;
    const ownerType = ts.isBindingElement(owner) ? this.declarationType(owner, depth + 1) : (owner as ts.ParameterDeclaration | ts.VariableDeclaration).type;
    if (ownerType === undefined || (!ts.isIdentifier(key) && !ts.isStringLiteral(key))) return undefined;
    return this.memberType(ownerType, key.text, 0);
  }

  /**
   * 타입 표기(타입 리터럴, 프로젝트 인터페이스·타입 별칭, 교차·합 타입)에서 멤버의 타입 표기를 찾는다.
   *
   * @param type 타입 노드
   * @param name 멤버 이름
   * @param depth 깊이
   * @returns 멤버 타입 노드 또는 undefined
   */
  private memberType(type: ts.TypeNode, name: string, depth: number): ts.TypeNode | undefined {
    if (depth > 8) return undefined;
    if (ts.isParenthesizedTypeNode(type)) return this.memberType(type.type, name, depth + 1);
    if (ts.isTypeLiteralNode(type)) return memberSignatureType(type.members, name);
    if (ts.isIntersectionTypeNode(type) || ts.isUnionTypeNode(type)) {
      for (const member of type.types) {
        const found = this.memberType(member, name, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!ts.isTypeReferenceNode(type)) return undefined;
    const origin = this.binder.originOf(ts.isIdentifier(type.typeName) ? type.typeName : type.typeName.right);
    if (origin.kind !== 'declaration') return undefined;
    if (ts.isTypeAliasDeclaration(origin.declaration)) return this.memberType(origin.declaration.type, name, depth + 1);
    return ts.isInterfaceDeclaration(origin.declaration) ? this.interfaceMember(origin.declaration, name, depth) : undefined;
  }

  /**
   * 인터페이스(와 그것이 확장한 프로젝트 인터페이스)의 멤버 타입이다.
   *
   * @param declaration 인터페이스
   * @param name 멤버 이름
   * @param depth 깊이
   * @returns 멤버 타입 노드 또는 undefined
   */
  private interfaceMember(declaration: ts.InterfaceDeclaration, name: string, depth: number): ts.TypeNode | undefined {
    const own = memberSignatureType(declaration.members, name);
    if (own !== undefined) return own;
    for (const clause of declaration.heritageClauses ?? []) {
      for (const base of clause.types) {
        const origin = ts.isIdentifier(base.expression) ? this.binder.originOf(base.expression) : undefined;
        if (origin?.kind !== 'declaration' || !ts.isInterfaceDeclaration(origin.declaration) || depth > 8) continue;
        const found = this.interfaceMember(origin.declaration, name, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }

  /**
   * `this.name`의 값이다: 감싼 클래스의 필드·생성자 매개변수 속성, 없으면 규칙(`this.env.DB` 등).
   *
   * @param expression 접근 식
   * @param name 멤버 이름
   * @returns 값
   */
  private thisMember(expression: ts.PropertyAccessExpression, name: string): OrmValue {
    const owner = enclosingClass(expression);
    const member = owner === undefined ? undefined : classMember(owner, name);
    if (member !== undefined) return this.declarationValue(member);
    const ruled = this.firstRule((rules) => rules.member?.(UNKNOWN, name, expression));
    if (ruled.kind !== 'unknown' || owner === undefined) return ruled;
    return this.firstRule((rules) => rules.member?.(this.classSelf(owner), name, expression));
  }

  /**
   * 클래스 인스턴스 자신(`this`)의 값이다. 사용자 저장소(`extends Repository<User>`)만 의미가 있다.
   *
   * @param owner 클래스
   * @returns 값
   */
  classSelf(owner: ts.ClassLikeDeclaration): OrmValue {
    for (const clause of owner.heritageClauses ?? []) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of clause.types) {
        const value = this.heritageValue(type);
        if (value.kind === 'typeorm-repository') return value;
      }
    }
    return UNKNOWN;
  }

  /**
   * 상속 절의 타입(`Repository<User>`)을 타입 참조처럼 평가한다.
   *
   * @param type 상속 절 타입
   * @returns 값
   */
  heritageValue(type: ts.ExpressionWithTypeArguments): OrmValue {
    const target = this.valueOf(type.expression);
    const reference = ts.factory.createTypeReferenceNode('__heritage__', type.typeArguments);
    (reference as { parent?: ts.Node }).parent = type;
    return this.firstRule((rules) => rules.typeReference?.(target, reference));
  }

  /**
   * 호출 식의 값이다: `require`·동적 import, 메서드 호출 규칙, 호출 규칙, 프로젝트 함수의 반환 값.
   *
   * @param expression 호출 식
   * @returns 값
   */
  private callValue(expression: ts.CallExpression): OrmValue {
    const callee = expression.expression;
    const specifier = moduleLoadSpecifier(expression);
    if (specifier !== undefined) return this.originValue(this.binder.moduleOrigin(specifier, expression.getSourceFile()), expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = callee.expression.kind === ts.SyntaxKind.ThisKeyword ? this.thisValue(callee) : this.valueOf(callee.expression);
      const ruled = this.firstRule((rules) => rules.methodCall?.(receiver, callee.name.text, expression));
      if (ruled.kind !== 'unknown') return ruled;
    }
    const calleeValue = this.callableValue(this.valueOf(callee));
    const ruled = this.firstRule((rules) => rules.call?.(calleeValue, expression));
    if (ruled.kind !== 'unknown') return ruled;
    return calleeValue.kind === 'function' ? this.returnValue(calleeValue.node) : UNKNOWN;
  }

  /**
   * 호출 대상이 CommonJS 모듈(`require('./m')(…)`)이면 `module.exports`의 값으로 바꾼다.
   *
   * @param value 호출 대상 값
   * @returns 호출할 값
   */
  private callableValue(value: OrmValue): OrmValue {
    if (value.kind !== 'module') return value;
    const exported = this.binder.commonJsDefault(value.sourceFile);
    return exported === undefined ? value : this.valueOf(exported);
  }

  /**
   * `this`의 값이다(감싼 클래스 기준).
   *
   * @param node `this`를 담은 식
   * @returns 값
   */
  thisValue(node: ts.Node): OrmValue {
    const owner = enclosingClass(node);
    return owner === undefined ? UNKNOWN : this.classSelf(owner);
  }

  /**
   * 선언 종류별 계산이다.
   *
   * @param declaration 선언
   * @returns 값
   */
  private computeDeclaration(declaration: ts.Declaration): OrmValue {
    if (ts.isVariableDeclaration(declaration)) return this.variableValue(declaration);
    if (ts.isBindingElement(declaration)) return this.bindingElementValue(declaration);
    if (ts.isParameter(declaration)) return this.parameterValue(declaration);
    if (ts.isPropertyDeclaration(declaration)) return this.propertyValue(declaration);
    if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
      return this.firstRule((rules) => rules.classValue?.(declaration));
    }
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return { kind: 'function', node: declaration };
    if (ts.isExportAssignment(declaration)) return this.valueOf(declaration.expression);
    if (ts.isPropertyAssignment(declaration)) return this.valueOf(declaration.initializer);
    if (ts.isBinaryExpression(declaration) && declaration.operatorToken.kind === ts.SyntaxKind.EqualsToken) return this.valueOf(declaration.right);
    if (ts.isShorthandPropertyAssignment(declaration)) return this.originValue(this.binder.originOf(declaration.name), declaration.name);
    return UNKNOWN;
  }

  /**
   * 변수 선언의 값이다. 초기값을 먼저 보고, 없거나 모르면 타입 표기를 본다.
   *
   * @param declaration 변수 선언
   * @returns 값
   */
  private variableValue(declaration: ts.VariableDeclaration): OrmValue {
    const fromInitializer = declaration.initializer === undefined || !ts.isIdentifier(declaration.name)
      ? UNKNOWN
      : this.valueOf(declaration.initializer);
    if (fromInitializer.kind !== 'unknown' || declaration.type === undefined) return fromInitializer;
    return this.typeValue(declaration.type);
  }

  /**
   * 구조 분해 원소(`const { DB } = c.env`)의 값이다.
   *
   * @param element 구조 분해 원소
   * @returns 값
   */
  private bindingElementValue(element: ts.BindingElement): OrmValue {
    const pattern = element.parent;
    const owner = pattern.parent;
    if (!ts.isObjectBindingPattern(pattern)) return UNKNOWN;
    if (!ts.isVariableDeclaration(owner) || owner.initializer === undefined) {
      const declared = this.declarationType(element, 0);
      return declared === undefined ? UNKNOWN : this.typeValue(declared);
    }
    const key = element.propertyName ?? element.name;
    if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) return UNKNOWN;
    const value = this.memberValue(this.valueOf(owner.initializer), key.text, owner.initializer);
    if (value.kind !== 'unknown') return value;
    const declared = this.declarationType(element, 0);
    return declared === undefined ? UNKNOWN : this.typeValue(declared);
  }

  /**
   * 매개변수의 값이다: 타입 표기, 데코레이터, 알려진 호출의 콜백 매개변수 순이다.
   *
   * @param parameter 매개변수
   * @returns 값
   */
  private parameterValue(parameter: ts.ParameterDeclaration): OrmValue {
    const decorated = this.decoratedValue(parameter);
    if (decorated.kind !== 'unknown') return decorated;
    if (parameter.type !== undefined) {
      const typed = this.typeValue(parameter.type);
      if (typed.kind !== 'unknown') return typed;
    }
    return this.callbackParameterValue(parameter);
  }

  /**
   * 콜백 인자의 매개변수면 그 호출의 규칙에 묻는다.
   *
   * @param parameter 매개변수
   * @returns 값
   */
  private callbackParameterValue(parameter: ts.ParameterDeclaration): OrmValue {
    const fn = parameter.parent;
    const call = fn.parent;
    if (!ts.isCallExpression(call) || !call.arguments.includes(fn as ts.Expression)) return UNKNOWN;
    const index = fn.parameters.indexOf(parameter);
    const callee = call.expression;
    const calleeValue = ts.isPropertyAccessExpression(callee) ? this.valueOf(callee.expression) : this.valueOf(callee);
    return this.firstRule((rules) => rules.callbackParameter?.(call, calleeValue, index));
  }

  /**
   * 클래스 필드의 값이다: 데코레이터, 타입 표기, 초기값 순이다.
   *
   * @param property 필드 선언
   * @returns 값
   */
  private propertyValue(property: ts.PropertyDeclaration): OrmValue {
    const decorated = this.decoratedValue(property);
    if (decorated.kind !== 'unknown') return decorated;
    if (property.type !== undefined) {
      const typed = this.typeValue(property.type);
      if (typed.kind !== 'unknown') return typed;
    }
    return property.initializer === undefined ? UNKNOWN : this.valueOf(property.initializer);
  }

  /**
   * 데코레이터가 정하는 값이다.
   *
   * @param node 데코레이터를 가질 수 있는 노드
   * @returns 값
   */
  private decoratedValue(node: ts.HasDecorators): OrmValue {
    const decorators = ts.getDecorators(node) ?? [];
    return decorators.length === 0 ? UNKNOWN : this.firstRule((rules) => rules.decorated?.(decorators));
  }

  /**
   * 타입 종류별 계산이다.
   *
   * @param type 타입 노드
   * @returns 값
   */
  private computeType(type: ts.TypeNode): OrmValue {
    if (ts.isParenthesizedTypeNode(type)) return this.typeValue(type.type);
    if (ts.isUnionTypeNode(type)) return sameValue(type.types.filter((member) => !isNullishType(member)).map((member) => this.typeValue(member)));
    if (ts.isIntersectionTypeNode(type)) return firstKnown(type.types.map((member) => this.typeValue(member)));
    if (ts.isTypeQueryNode(type)) return this.entityValue(type.exprName);
    if (!ts.isTypeReferenceNode(type)) return UNKNOWN;
    const wrapped = passThroughArgument(type);
    if (wrapped !== undefined) return this.typeValue(wrapped);
    const returned = returnTypeArgument(type);
    if (returned !== undefined) return this.typeQueryReturn(returned);
    return this.typeReferenceValue(type);
  }

  /**
   * `ReturnType<typeof f>`의 값이다.
   *
   * @param query `typeof f`
   * @returns 값
   */
  private typeQueryReturn(query: ts.TypeQueryNode): OrmValue {
    const target = this.entityValue(query.exprName);
    return target.kind === 'function' ? this.returnValue(target.node) : UNKNOWN;
  }

  /**
   * 타입 참조의 값이다. 프로젝트 타입 별칭은 펼치고, 나머지는 규칙에 묻는다.
   *
   * @param type 타입 참조
   * @returns 값
   */
  private typeReferenceValue(type: ts.TypeReferenceNode): OrmValue {
    const name = type.typeName;
    const origin = this.binder.originOf(ts.isIdentifier(name) ? name : name.right);
    if (origin.kind === 'declaration' && ts.isTypeAliasDeclaration(origin.declaration)) return this.typeValue(origin.declaration.type);
    let target: OrmValue | { readonly kind: 'global'; readonly name: string };
    if (origin.kind === 'global') target = { kind: 'global', name: origin.name };
    else if (origin.kind === 'declaration' && (ts.isClassDeclaration(origin.declaration) || ts.isClassExpression(origin.declaration))) {
      target = this.declarationValue(origin.declaration);
    } else if (ts.isQualifiedName(name) && origin.kind === 'unknown') target = this.qualifiedTarget(name);
    else target = this.originValue(origin, name);
    const ruled = this.firstRule((rules) => rules.typeReference?.(target, type));
    // 엔터티·모델 클래스 타입(`Repository<Book>`의 `Book`, `user: User`)은 그 클래스 값으로 읽는다.
    return ruled.kind === 'unknown' && isClassValue(target) ? target : ruled;
  }

  /**
   * 한정 타입 이름(`Knex.Transaction`)의 대상이다. 왼쪽이 외부 이름공간이면 경로를 잇는다.
   *
   * @param name 한정 이름
   * @returns 대상 값
   */
  private qualifiedTarget(name: ts.QualifiedName): OrmValue {
    const left = this.entityValue(name.left);
    if (left.kind === 'external') return { kind: 'external', module: left.module, name: left.name === '*' || left.name === 'default' ? name.right.text : `${left.name}.${name.right.text}` };
    return UNKNOWN;
  }

  /**
   * 값 위치 엔터티 이름(`typeof a.b`)의 값이다.
   *
   * @param name 엔터티 이름
   * @returns 값
   */
  private entityValue(name: ts.EntityName): OrmValue {
    if (ts.isIdentifier(name)) return this.originValue(this.binder.originOf(name), name);
    return this.memberValue(this.entityValue(name.left), name.right.text, name.right as unknown as ts.Expression);
  }
}

/**
 * 타입 멤버 목록에서 이름 있는 속성 시그니처의 타입을 찾는다.
 *
 * @param members 타입 멤버
 * @param name 멤버 이름
 * @returns 타입 노드 또는 undefined
 */
function memberSignatureType(members: ts.NodeArray<ts.TypeElement>, name: string): ts.TypeNode | undefined {
  for (const member of members) {
    if (ts.isPropertySignature(member) && propertyNameText(member.name) === name) return member.type;
  }
  return undefined;
}

/**
 * 괄호·`as`·non-null 래퍼를 벗긴다.
 *
 * @param expression 식
 * @returns 벗긴 식
 */
function skipExpressionWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) current = current.expression;
  return current;
}

/**
 * 여러 값이 모두 같은 종류·대상이면 그 값, 아니면 unknown이다.
 *
 * @param values 값 목록
 * @returns 공통 값
 */
export function sameValue(values: readonly OrmValue[]): OrmValue {
  const [first] = values;
  if (first === undefined || first.kind === 'unknown') return UNKNOWN;
  return values.every((value) => sameTarget(value, first)) ? first : UNKNOWN;
}

/**
 * 두 값이 같은 대상인지 본다(종류와 테이블·엔터티·모델 동일성).
 *
 * @param left 왼쪽
 * @param right 오른쪽
 * @returns 같으면 true
 */
function sameTarget(left: OrmValue, right: OrmValue): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'drizzle-table' && right.kind === 'drizzle-table') return left.table === right.table;
  if ((left.kind === 'typeorm-entity' || left.kind === 'typeorm-repository')
    && (right.kind === 'typeorm-entity' || right.kind === 'typeorm-repository')) return left.entity === right.entity;
  if (left.kind === 'sequelize-model' && right.kind === 'sequelize-model') return left.model === right.model;
  return true;
}

/**
 * 값이 엔터티·모델 클래스인지 본다.
 *
 * @param value 값
 * @returns 클래스 값이면 true
 */
function isClassValue(value: OrmValue | { readonly kind: 'global' }): value is OrmValue {
  return value.kind === 'typeorm-entity' || value.kind === 'sequelize-model';
}

/**
 * 첫 번째로 알려진 값이다.
 *
 * @param values 값 목록
 * @returns 값
 */
function firstKnown(values: readonly OrmValue[]): OrmValue {
  return values.find((value) => value.kind !== 'unknown') ?? UNKNOWN;
}

/** 값을 그대로 넘기는 유틸리티 타입이다. */
const passThroughTypes: ReadonlySet<string> = new Set(['Promise', 'Awaited', 'Readonly', 'NonNullable', 'Required', 'Omit', 'Pick']);

/**
 * `Promise<T>`·`Awaited<T>` 같은 래퍼 타입의 T다.
 *
 * @param type 타입 참조
 * @returns T 또는 undefined
 */
function passThroughArgument(type: ts.TypeReferenceNode): ts.TypeNode | undefined {
  if (!ts.isIdentifier(type.typeName) || !passThroughTypes.has(type.typeName.text)) return undefined;
  return type.typeArguments?.[0];
}

/**
 * `ReturnType<typeof f>`의 `typeof f`다.
 *
 * @param type 타입 참조
 * @returns 타입 질의 또는 undefined
 */
function returnTypeArgument(type: ts.TypeReferenceNode): ts.TypeQueryNode | undefined {
  if (!ts.isIdentifier(type.typeName) || type.typeName.text !== 'ReturnType') return undefined;
  const [argument] = type.typeArguments ?? [];
  return argument !== undefined && ts.isTypeQueryNode(argument) ? argument : undefined;
}

/**
 * `Promise<T>` 반환 타입을 T로 벗긴다.
 *
 * @param type 타입
 * @returns 벗긴 타입
 */
function unwrapPromise(type: ts.TypeNode): ts.TypeNode {
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'Promise' && type.typeArguments?.[0] !== undefined
    ? type.typeArguments[0]
    : type;
}

/**
 * 블록의 return 식을 모은다(안쪽 함수는 건너뛴다).
 *
 * @param body 함수 본문
 * @returns return 식 목록
 */
function returnExpressions(body: ts.Block): ts.Expression[] {
  const result: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) result.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return result;
}

/**
 * 객체 리터럴에서 이름 있는 멤버의 값 식을 찾는다.
 *
 * @param object 객체 리터럴
 * @param name 멤버 이름
 * @returns 값 식 또는 undefined
 */
export function objectMember(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return undefined;
}

/**
 * 속성 이름의 정적 텍스트다(식별자·문자열·숫자).
 *
 * @param name 속성 이름
 * @returns 텍스트 또는 undefined
 */
export function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return undefined;
}

/**
 * 노드를 감싼 가장 가까운 클래스다(화살표 함수는 `this`를 이어받으므로 건너뛰고, 일반 함수에서 멈춘다).
 *
 * @param node 노드
 * @returns 클래스 또는 undefined
 */
export function enclosingClass(node: ts.Node): ts.ClassLikeDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isClassLike(current)) return current;
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) return undefined;
  }
  return undefined;
}

/**
 * 클래스의 이름 있는 필드·생성자 매개변수 속성을 찾는다(없으면 상속한 프로젝트 클래스는 보지 않는다).
 *
 * @param owner 클래스
 * @param name 멤버 이름
 * @returns 선언 또는 undefined
 */
function classMember(owner: ts.ClassLikeDeclaration, name: string): ts.Declaration | undefined {
  for (const member of owner.members) {
    if (ts.isPropertyDeclaration(member) && member.name !== undefined && propertyNameText(member.name) === name) return member;
    if (!ts.isConstructorDeclaration(member)) continue;
    const parameter = member.parameters.find((candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name
      && (ts.getModifiers(candidate) ?? []).length > 0);
    if (parameter !== undefined) return parameter;
  }
  return undefined;
}

/**
 * 호출이 `require('…')`·`import('…')`면 지정자를 돌려준다.
 *
 * @param call 호출 식
 * @returns 지정자 또는 undefined
 */
function moduleLoadSpecifier(call: ts.CallExpression): string | undefined {
  const isLoad = call.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(call.expression) && call.expression.text === 'require');
  const [argument] = call.arguments;
  return isLoad && argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

/**
 * `??`·`||` 연산자인지 본다.
 *
 * @param kind 연산자 종류
 * @returns 대체 연산자면 true
 */
function isFallbackOperator(kind: ts.SyntaxKind): boolean {
  return kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken;
}

/**
 * 식이 null·undefined 리터럴인지 본다.
 *
 * @param expression 식
 * @returns null·undefined면 true
 */
function isNullish(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(expression) && expression.text === 'undefined');
}

/**
 * 타입이 null·undefined인지 본다.
 *
 * @param type 타입 노드
 * @returns null·undefined 타입이면 true
 */
function isNullishType(type: ts.TypeNode): boolean {
  return type.kind === ts.SyntaxKind.UndefinedKeyword
    || (ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword);
}
