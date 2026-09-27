/**
 * 식별자·식·타입이 Prisma Client와 어떤 관계인지 구문만으로 판정한다.
 *
 * 타입 검사기를 돌리지 않는다(분석 대상의 의존성이 설치돼 있다는 보장이 없고, 설치된 타입을
 * 믿으면 결과가 환경마다 달라진다). 대신 출처가 증명되는 모양만 인정한다: `PrismaClient`
 * 클래스의 생성, `PrismaClient`·`Prisma.TransactionClient` 타입 표기, 그런 값을 돌려준다고
 * 표기한 함수, 그리고 그 값을 옮긴 바인딩. 증명하지 못한 수신자는 클라이언트가 아니다 —
 * 같은 이름의 메서드(`Map.delete` 등)를 테이블 사용으로 오독하지 않기 위해서다.
 *
 * 바인딩은 스코프별로 지연 평가한다. 선언 순서와 무관하게 참조를 풀고, 순환은 "모름"으로 끊는다.
 */

import ts from 'typescript';

/** 바인딩의 의미다. 사실과 무관한 값은 모두 `other`다. */
export type BindingKind =
  | { readonly kind: 'client' }
  | { readonly kind: 'client-class' }
  | { readonly kind: 'client-type' }
  | { readonly kind: 'client-factory' }
  | { readonly kind: 'prisma-namespace' }
  | { readonly kind: 'prisma-module' }
  | { readonly kind: 'module'; readonly path: string }
  /** `literalStart`는 같은 파일 안 문자열 리터럴의 시작 위치다(게이트가 소비 표시에 쓴다). */
  | { readonly kind: 'string'; readonly value: string; readonly literalStart: number }
  | { readonly kind: 'sql-fragment' }
  | { readonly kind: 'other' };

/** 자주 쓰는 불변 값이다. */
export const OTHER: BindingKind = { kind: 'other' };
export const CLIENT: BindingKind = { kind: 'client' };
export const CLIENT_CLASS: BindingKind = { kind: 'client-class' };
export const CLIENT_TYPE: BindingKind = { kind: 'client-type' };
export const CLIENT_FACTORY: BindingKind = { kind: 'client-factory' };
export const PRISMA_NAMESPACE: BindingKind = { kind: 'prisma-namespace' };
export const PRISMA_MODULE: BindingKind = { kind: 'prisma-module' };
export const SQL_FRAGMENT: BindingKind = { kind: 'sql-fragment' };

/** 지연 평가 바인딩 하나다. */
class LazyBinding {
  /** 값을 계산하는 함수다. */
  private readonly compute: () => BindingKind;
  /** 평가 상태다. `computing`은 순환 감지용이다. */
  private state: 'pending' | 'computing' | 'done' = 'pending';
  /** 계산된 값이다. */
  private value: BindingKind = OTHER;

  /**
   * @param compute 값 계산 함수
   */
  constructor(compute: () => BindingKind) {
    this.compute = compute;
  }

  /**
   * 값을 돌려준다. 계산 중에 다시 불리면(순환) `other`다.
   *
   * @returns 바인딩 의미
   */
  get(): BindingKind {
    if (this.state === 'done') return this.value;
    if (this.state === 'computing') return OTHER;
    this.state = 'computing';
    this.value = this.compute();
    this.state = 'done';
    return this.value;
  }
}

/** 값 이름공간과 타입 이름공간을 따로 가진 렉시컬 스코프다. */
export class Scope {
  /** 바깥 스코프다. */
  readonly parent: Scope | undefined;
  /** 값 바인딩이다. */
  private readonly values = new Map<string, LazyBinding>();
  /** 타입 바인딩이다. */
  private readonly types = new Map<string, LazyBinding>();

  /**
   * @param parent 바깥 스코프
   */
  constructor(parent: Scope | undefined) {
    this.parent = parent;
  }

  /**
   * 값 바인딩을 선언한다. 같은 스코프의 먼저 선언된 이름은 덮지 않는다(첫 선언 우선).
   *
   * @param name 이름
   * @param compute 값 계산 함수
   */
  declareValue(name: string, compute: () => BindingKind): void {
    if (!this.values.has(name)) this.values.set(name, new LazyBinding(compute));
  }

  /**
   * 타입 바인딩을 선언한다.
   *
   * @param name 이름
   * @param compute 값 계산 함수
   */
  declareType(name: string, compute: () => BindingKind): void {
    if (!this.types.has(name)) this.types.set(name, new LazyBinding(compute));
  }

  /**
   * 값 이름을 바깥으로 올라가며 찾는다.
   *
   * @param name 이름
   * @returns 의미. 어디에도 없으면(전역 등) `other`
   */
  lookupValue(name: string): BindingKind {
    for (let scope: Scope | undefined = this; scope !== undefined; scope = scope.parent) {
      const binding = scope.values.get(name);
      if (binding !== undefined) return binding.get();
    }
    return OTHER;
  }

  /**
   * 타입 이름을 바깥으로 올라가며 찾는다.
   *
   * @param name 이름
   * @returns 의미. 없으면 `other`
   */
  lookupType(name: string): BindingKind {
    for (let scope: Scope | undefined = this; scope !== undefined; scope = scope.parent) {
      const binding = scope.types.get(name);
      if (binding !== undefined) return binding.get();
    }
    return OTHER;
  }
}

/** 클래스 멤버(`this.x`)의 의미다. */
export type ClassMembers = ReadonlyMap<string, () => BindingKind>;

/** 평가 문맥이다. `thisMembers`는 `this`가 가리키는 클래스의 멤버다. */
export interface EvaluationContext {
  readonly scope: Scope;
  readonly thisMembers: ClassMembers | undefined;
}

/** 다른 모듈의 export 의미를 묻는 함수다. */
export type ExportLookup = (path: string, name: string) => BindingKind;

/** 필요 없는 래퍼로 감싼 타입에서 원래 타입을 꺼내는 유틸리티 타입 이름이다. */
const passThroughTypeUtilities: ReadonlySet<string> = new Set(['Omit', 'Pick', 'Readonly', 'NonNullable', 'Required']);

/** 식·타입 평가기다. 파일 하나에 하나씩 둔다. */
export class BindingEvaluator {
  /** 다른 모듈의 export 의미다. */
  private readonly exportLookup: ExportLookup;

  /**
   * @param exportLookup 다른 모듈의 export 의미를 묻는 함수
   */
  constructor(exportLookup: ExportLookup) {
    this.exportLookup = exportLookup;
  }

  /**
   * 식의 의미를 판정한다.
   *
   * @param expression 식
   * @param context 평가 문맥
   * @returns 의미
   */
  expression(expression: ts.Expression, context: EvaluationContext): BindingKind {
    if (ts.isIdentifier(expression)) return context.scope.lookupValue(expression.text);
    if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
      || ts.isSatisfiesExpression(expression) || ts.isAwaitExpression(expression)) {
      return this.expression(expression.expression, context);
    }
    if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
      return this.isClientType(expression.type, context) ? CLIENT : this.expression(expression.expression, context);
    }
    if (ts.isNewExpression(expression)) return this.newExpression(expression, context);
    if (ts.isCallExpression(expression)) return this.callExpression(expression, context);
    if (ts.isBinaryExpression(expression)) return this.binaryExpression(expression, context);
    if (ts.isConditionalExpression(expression)) return this.conditionalExpression(expression, context);
    if (ts.isPropertyAccessExpression(expression)) return this.propertyAccess(expression, context);
    return this.literalExpression(expression, context);
  }

  /**
   * 리터럴·함수·태그 템플릿 식의 의미를 판정한다.
   *
   * @param expression 식
   * @param context 평가 문맥
   * @returns 의미
   */
  private literalExpression(expression: ts.Expression, context: EvaluationContext): BindingKind {
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return { kind: 'string', value: expression.text, literalStart: expression.getStart() };
    }
    if (ts.isTaggedTemplateExpression(expression) && this.isPrismaSqlTag(expression.tag, context)) return SQL_FRAGMENT;
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      return this.returnsClient(expression, context) ? CLIENT_FACTORY : OTHER;
    }
    return OTHER;
  }

  /**
   * `new X(...)`는 X가 `PrismaClient` 클래스일 때만 클라이언트다.
   *
   * @param expression new 식
   * @param context 평가 문맥
   * @returns 의미
   */
  private newExpression(expression: ts.NewExpression, context: EvaluationContext): BindingKind {
    return this.expression(expression.expression, context).kind === 'client-class' ? CLIENT : OTHER;
  }

  /**
   * 호출 식: 클라이언트를 돌려준다고 표기한 함수, `client.$extends(...)`, `require(...)`.
   *
   * @param expression 호출 식
   * @param context 평가 문맥
   * @returns 의미
   */
  private callExpression(expression: ts.CallExpression, context: EvaluationContext): BindingKind {
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee) && callee.name.text === '$extends') {
      return this.expression(callee.expression, context).kind === 'client' ? CLIENT : OTHER;
    }
    if (ts.isIdentifier(callee) && callee.text === 'require' && context.scope.lookupValue('require').kind === 'other') {
      return this.moduleCall(expression, this.requireLookup);
    }
    if (callee.kind === ts.SyntaxKind.ImportKeyword) return this.moduleCall(expression, this.dynamicImportLookup);
    return this.expression(callee, context).kind === 'client-factory' ? CLIENT : OTHER;
  }

  /**
   * `require('…')`·`import('…')` 호출의 의미를 판정한다. 해석은 파일 쪽 훅이 맡는다.
   *
   * @param expression 호출 식
   * @param lookup 지정자 → 의미 훅
   * @returns 의미
   */
  private moduleCall(expression: ts.CallExpression, lookup: (specifier: string) => BindingKind): BindingKind {
    const [argument] = expression.arguments;
    if (argument === undefined || !ts.isStringLiteralLike(argument)) return OTHER;
    return lookup(argument.text);
  }

  /**
   * `require` 지정자의 의미를 돌려주는 훅이다. 파일 분석기가 덮어쓴다.
   *
   * @param _specifier 지정자
   * @returns 의미
   */
  requireLookup: (specifier: string) => BindingKind = () => OTHER;

  /**
   * 동적 `import('…')` 지정자의 의미(모듈 이름공간)를 돌려주는 훅이다. 파일 분석기가 덮어쓴다.
   *
   * @param _specifier 지정자
   * @returns 의미
   */
  dynamicImportLookup: (specifier: string) => BindingKind = () => OTHER;

  /**
   * `a ?? b`·`a || b`는 한쪽이 클라이언트면 클라이언트다(`globalThis.prisma ?? new PrismaClient()` 관용구).
   *
   * @param expression 이항 식
   * @param context 평가 문맥
   * @returns 의미
   */
  private binaryExpression(expression: ts.BinaryExpression, context: EvaluationContext): BindingKind {
    const operator = expression.operatorToken.kind;
    if (operator !== ts.SyntaxKind.QuestionQuestionToken && operator !== ts.SyntaxKind.BarBarToken) return OTHER;
    const left = this.expression(expression.left, context).kind === 'client';
    const right = this.expression(expression.right, context).kind === 'client';
    return left || right ? CLIENT : OTHER;
  }

  /**
   * 조건 식은 양쪽이 클라이언트이거나 한쪽이 클라이언트이고 다른 쪽이 null·undefined일 때만 클라이언트다.
   *
   * @param expression 조건 식
   * @param context 평가 문맥
   * @returns 의미
   */
  private conditionalExpression(expression: ts.ConditionalExpression, context: EvaluationContext): BindingKind {
    const branches = [expression.whenTrue, expression.whenFalse];
    const clients = branches.filter((branch) => this.expression(branch, context).kind === 'client').length;
    const empties = branches.filter(isNullish).length;
    return clients > 0 && clients + empties === 2 ? CLIENT : OTHER;
  }

  /**
   * 멤버 접근: 모듈 이름공간의 export, `this.x` 클래스 멤버, Prisma 모듈의 `PrismaClient`·`Prisma`.
   *
   * @param expression 멤버 접근 식
   * @param context 평가 문맥
   * @returns 의미
   */
  private propertyAccess(expression: ts.PropertyAccessExpression, context: EvaluationContext): BindingKind {
    const name = expression.name.text;
    if (expression.expression.kind === ts.SyntaxKind.ThisKeyword) {
      return context.thisMembers?.get(name)?.() ?? OTHER;
    }
    return this.memberOf(this.expression(expression.expression, context), name);
  }

  /**
   * 이름공간 의미의 멤버 의미를 돌려준다.
   *
   * @param owner 소유자 의미
   * @param name 멤버 이름
   * @returns 의미
   */
  memberOf(owner: BindingKind, name: string): BindingKind {
    if (owner.kind === 'prisma-module') return prismaModuleMember(name);
    if (owner.kind === 'module') return this.exportLookup(owner.path, name);
    return OTHER;
  }

  /**
   * 태그가 `Prisma.sql`인지 본다.
   *
   * @param tag 태그 식
   * @param context 평가 문맥
   * @returns `Prisma.sql`이면 true
   */
  isPrismaSqlTag(tag: ts.Expression, context: EvaluationContext): boolean {
    return this.isPrismaHelper(tag, 'sql', context);
  }

  /**
   * 식이 `Prisma.<helper>`(또는 Prisma 모듈 이름공간을 거친 같은 값)인지 본다.
   *
   * @param expression 식
   * @param helper 도우미 이름(`sql`·`raw`·`join`·`empty`)
   * @param context 평가 문맥
   * @returns 맞으면 true
   */
  isPrismaHelper(expression: ts.Expression, helper: string, context: EvaluationContext): boolean {
    if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== helper) return false;
    return this.expression(expression.expression, context).kind === 'prisma-namespace';
  }

  /**
   * 함수가 클라이언트를 돌려준다고 표기했거나, 식 본문이 클라이언트인지 본다.
   *
   * @param node 함수 노드
   * @param context 평가 문맥(함수가 선언된 스코프)
   * @returns 클라이언트를 돌려주면 true
   */
  returnsClient(node: ts.SignatureDeclaration, context: EvaluationContext): boolean {
    if (node.type !== undefined) return this.isClientType(unwrapPromiseType(node.type), context);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      return this.expression(node.body, context).kind === 'client';
    }
    return false;
  }

  /**
   * 타입 표기가 클라이언트 타입인지 본다.
   *
   * @param type 타입 노드
   * @param context 평가 문맥
   * @returns 클라이언트 타입이면 true
   */
  isClientType(type: ts.TypeNode, context: EvaluationContext): boolean {
    if (ts.isParenthesizedTypeNode(type)) return this.isClientType(type.type, context);
    if (ts.isUnionTypeNode(type)) return this.isClientUnion(type, context);
    if (ts.isIntersectionTypeNode(type)) return type.types.some((member) => this.isClientType(member, context));
    if (ts.isTypeQueryNode(type)) return this.entityValue(type.exprName, context).kind === 'client';
    if (!ts.isTypeReferenceNode(type)) return false;
    const [firstArgument] = type.typeArguments ?? [];
    if (ts.isIdentifier(type.typeName) && passThroughTypeUtilities.has(type.typeName.text)
      && context.scope.lookupType(type.typeName.text).kind === 'other' && firstArgument !== undefined) {
      return this.isClientType(firstArgument, context);
    }
    const kind = this.entityType(type.typeName, context).kind;
    return kind === 'client-class' || kind === 'client-type';
  }

  /**
   * 합 타입은 null·undefined를 뺀 모든 멤버가 클라이언트 타입일 때만 클라이언트 타입이다.
   *
   * @param type 합 타입
   * @param context 평가 문맥
   * @returns 클라이언트 타입이면 true
   */
  private isClientUnion(type: ts.UnionTypeNode, context: EvaluationContext): boolean {
    const members = type.types.filter((member) => !isNullishType(member));
    return members.length > 0 && members.every((member) => this.isClientType(member, context));
  }

  /**
   * 타입 위치의 이름(`A`, `A.B.C`)의 의미를 돌려준다.
   *
   * @param name 엔터티 이름
   * @param context 평가 문맥
   * @returns 의미
   */
  private entityType(name: ts.EntityName, context: EvaluationContext): BindingKind {
    if (ts.isIdentifier(name)) return context.scope.lookupType(name.text);
    const owner = this.entityNamespace(name.left, context);
    if (owner.kind === 'prisma-namespace') return name.right.text === 'TransactionClient' ? CLIENT_TYPE : OTHER;
    return this.memberOf(owner, name.right.text);
  }

  /**
   * 한정 이름의 왼쪽(이름공간)의 의미다. 이름공간은 값·타입 어느 쪽으로도 들어올 수 있다.
   *
   * @param name 엔터티 이름
   * @param context 평가 문맥
   * @returns 의미
   */
  private entityNamespace(name: ts.EntityName, context: EvaluationContext): BindingKind {
    if (ts.isIdentifier(name)) {
      const value = context.scope.lookupValue(name.text);
      return value.kind === 'other' ? context.scope.lookupType(name.text) : value;
    }
    return this.memberOf(this.entityNamespace(name.left, context), name.right.text);
  }

  /**
   * `typeof a.b` 같은 값 위치 엔터티 이름의 의미다.
   *
   * @param name 엔터티 이름
   * @param context 평가 문맥
   * @returns 의미
   */
  private entityValue(name: ts.EntityName, context: EvaluationContext): BindingKind {
    if (ts.isIdentifier(name)) return context.scope.lookupValue(name.text);
    return this.memberOf(this.entityValue(name.left, context), name.right.text);
  }
}

/**
 * Prisma 모듈 이름공간의 멤버 의미다.
 *
 * @param name 멤버 이름
 * @returns 의미
 */
export function prismaModuleMember(name: string): BindingKind {
  if (name === 'PrismaClient') return CLIENT_CLASS;
  if (name === 'Prisma') return PRISMA_NAMESPACE;
  return OTHER;
}

/**
 * `Promise<T>` 표기를 T로 벗긴다(비동기 팩토리 함수의 반환 타입).
 *
 * @param type 타입 노드
 * @returns 벗긴 타입
 */
function unwrapPromiseType(type: ts.TypeNode): ts.TypeNode {
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'Promise') {
    const [inner] = type.typeArguments ?? [];
    if (inner !== undefined) return inner;
  }
  return type;
}

/**
 * 식이 null·undefined 리터럴인지 본다.
 *
 * @param expression 식
 * @returns null·undefined면 true
 */
function isNullish(expression: ts.Expression): boolean {
  return expression.kind === ts.SyntaxKind.NullKeyword
    || (ts.isIdentifier(expression) && expression.text === 'undefined');
}

/**
 * 타입 노드가 null·undefined인지 본다.
 *
 * @param type 타입 노드
 * @returns null·undefined 타입이면 true
 */
function isNullishType(type: ts.TypeNode): boolean {
  if (type.kind === ts.SyntaxKind.UndefinedKeyword) return true;
  return ts.isLiteralTypeNode(type) && type.literal.kind === ts.SyntaxKind.NullKeyword;
}
