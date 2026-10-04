/**
 * 실행하지 않고 증명할 수 있는 primitive key만 해석한다.
 *
 * 호출·getter·enum·symbol·객체의 타입을 추측하지 않으며, 제한을 넘으면 전체 결과를 모름으로 돌린다.
 */

import ts from 'typescript';

import { skipWrappers } from './node-collector.ts';

/** Map이 보존하는 primitive key의 런타임 값이다. `-0`은 0으로 정규화한다. */
export type PrimitiveKey = string | number | bigint | boolean | null | undefined;

/** 같은 AST 값을 Map key로 볼지 ordinary property key로 볼지 나타낸다. */
export type PrimitiveKeyKind = 'map' | 'property';

/** primitive key 해석에 필요한 공개 문맥이다. */
export interface PrimitiveKeyContext {
  /** TypeChecker — const alias와 전역 `undefined`의 선언을 확인하는 데 쓴다. */
  readonly checker: ts.TypeChecker;
  /** TypeScript Program의 authoritative default-library 판정이다. */
  readonly isDefaultLibraryFile: (sourceFile: ts.SourceFile) => boolean;
  /** 호출자의 전체 예산을 한 단계 소비한다. 예산 초과 예외는 모름으로 처리한다. */
  readonly budgetStep?: () => void;
  /** 기본 16보다 작은/큰 재귀 상한이 필요할 때만 지정한다. */
  readonly maxDepth?: number;
  /** 기본 64보다 작은/큰 결과 key 상한이 필요할 때만 지정한다. */
  readonly maxKeys?: number;
}

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_KEYS = 64;
const INTERNAL_MAX_STEPS = 4_096;

/**
 * primitive literal·immutable const alias·조건식 양쪽을 정확히 합친다.
 *
 * `undefined` 반환은 값이 primitive가 아니거나, 별칭/조건식의 깊이·key 수·예산을 증명하지 못했다는 뜻이다.
 * @param expression key 식
 * @param context checker와 bounded 해석 문맥
 * @param kind Map key 또는 ordinary property key
 * @returns 중복 없는 정규화 key 목록, 증명 실패면 undefined
 */
export function resolvePrimitiveKeys(
  expression: ts.Expression,
  context: PrimitiveKeyContext,
  kind: PrimitiveKeyKind = 'map',
): readonly PrimitiveKey[] | undefined {
  const resolver = new PrimitiveKeyResolver(context, kind);
  try {
    return resolver.resolve(expression, 0);
  } catch (error) {
    if (error instanceof PrimitiveBudgetExceeded) return undefined;
    throw error;
  }
}

/**
 * primitive Map key를 ordinary object property key로 바꾼다.
 * @param value primitive key
 * @returns JavaScript property key 문자열
 */
export function propertyToKey(value: PrimitiveKey): string {
  if (typeof value === 'number' && Object.is(value, -0)) return '0';
  return String(value);
}

/** bounded primitive resolver 구현이다. */
class PrimitiveKeyResolver {
  private readonly context: PrimitiveKeyContext;
  private readonly kind: PrimitiveKeyKind;
  private readonly maxDepth: number;
  private readonly maxKeys: number;
  private readonly aliases = new Set<ts.Symbol>();
  private steps = 0;

  constructor(context: PrimitiveKeyContext, kind: PrimitiveKeyKind) {
    this.context = context;
    this.kind = kind;
    this.maxDepth = context.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxKeys = context.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** expression 하나를 해석한다. */
  resolve(expression: ts.Expression, depth: number): readonly PrimitiveKey[] | undefined {
    this.step();
    if (depth > this.maxDepth) return undefined;
    const inner = skipWrappers(expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return this.one(inner.text);
    if (ts.isNumericLiteral(inner)) return this.numeric(inner.text);
    if (inner.kind === ts.SyntaxKind.BigIntLiteral) return this.bigint((inner as ts.BigIntLiteral).text);
    if (inner.kind === ts.SyntaxKind.TrueKeyword) return [true];
    if (inner.kind === ts.SyntaxKind.FalseKeyword) return [false];
    if (inner.kind === ts.SyntaxKind.NullKeyword) return [null];
    if (ts.isPrefixUnaryExpression(inner)) return this.prefixUnary(inner, depth);
    if (ts.isConditionalExpression(inner)) {
      return this.union(this.resolve(inner.whenTrue, depth + 1), this.resolve(inner.whenFalse, depth + 1));
    }
    if (ts.isIdentifier(inner)) return this.identifier(inner, depth);
    // Binary `||`·`??`와 getter/call/element access는 실행 경로·타입을 추측해야 하므로 열지 않는다.
    return undefined;
  }

  /** primitive 하나를 kind에 맞게 정규화한다. */
  private one(value: PrimitiveKey): readonly PrimitiveKey[] {
    return [this.normalize(value)];
  }

  /** 유한 numeric literal을 읽는다. */
  private numeric(text: string): readonly PrimitiveKey[] | undefined {
    const value = Number(text.replaceAll('_', ''));
    return Number.isFinite(value) ? this.one(Object.is(value, -0) ? 0 : value) : undefined;
  }

  /** bigint literal을 읽는다. */
  private bigint(text: string): readonly PrimitiveKey[] | undefined {
    try {
      const digits = text.replaceAll('_', '').replace(/n$/u, '');
      return this.one(BigInt(digits));
    } catch {
      return undefined;
    }
  }

  /** numeric/bigint prefix unary를 제한적으로 읽는다. */
  private prefixUnary(expression: ts.PrefixUnaryExpression, depth: number): readonly PrimitiveKey[] | undefined {
    const operand = skipWrappers(expression.operand);
    if (!ts.isNumericLiteral(operand) && operand.kind !== ts.SyntaxKind.BigIntLiteral) return undefined;
    if (ts.isNumericLiteral(operand)) {
      const value = Number(operand.text.replaceAll('_', ''));
      if (!Number.isFinite(value)) return undefined;
      if (expression.operator === ts.SyntaxKind.PlusToken) return this.one(value);
      if (expression.operator === ts.SyntaxKind.MinusToken) return this.one(Object.is(-value, -0) ? 0 : -value);
    }
    if (operand.kind === ts.SyntaxKind.BigIntLiteral && expression.operator === ts.SyntaxKind.MinusToken) {
      try {
        return this.one(-BigInt((operand as ts.BigIntLiteral).text.replaceAll('_', '').replace(/n$/u, '')));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** const alias 또는 global `undefined`를 읽는다. */
  private identifier(identifier: ts.Identifier, depth: number): readonly PrimitiveKey[] | undefined {
    if (identifier.text === 'undefined') return this.isGlobalUndefined(identifier) ? [this.normalize(undefined)] : undefined;
    const symbol = this.context.checker.getSymbolAtLocation(identifier);
    if (symbol === undefined || this.aliases.has(symbol)) return undefined;
    const declaration = this.constDeclaration(symbol);
    if (declaration === undefined || declaration.initializer === undefined) return undefined;
    this.aliases.add(symbol);
    try {
      return this.resolve(declaration.initializer, depth + 1);
    } finally {
      this.aliases.delete(symbol);
    }
  }

  /** 하나의 symbol이 가리키는 immutable top-level/local const initializer를 얻는다. */
  private constDeclaration(symbol: ts.Symbol): ts.VariableDeclaration | undefined {
    const declarations = symbol.declarations ?? [];
    const declaration = declarations[0];
    if (declarations.length !== 1 || declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined;
    const list = declaration.parent;
    return ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 ? declaration : undefined;
  }

  /** checker symbol이 TypeScript default lib의 전역 undefined인지 확인한다. */
  private isGlobalUndefined(identifier: ts.Identifier): boolean {
    const symbol = this.context.checker.getSymbolAtLocation(identifier);
    if (symbol === undefined) return false;
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) {
      // TS의 intrinsic 전역 undefined는 Symbol declaration을 노출하지 않는 경우가 있다. 그때는
      // checker가 직접 부여한 Undefined type만 인정하고, 같은 이름의 선언이 있으면 아래 경로에서 거부한다.
      return (this.context.checker.getTypeAtLocation(identifier).flags & ts.TypeFlags.Undefined) !== 0;
    }
    return declarations.every((declaration) => this.context.isDefaultLibraryFile(declaration.getSourceFile()));
  }

  /** 두 branch의 primitive union을 순서 보존하며 합친다. */
  private union(left: readonly PrimitiveKey[] | undefined, right: readonly PrimitiveKey[] | undefined): readonly PrimitiveKey[] | undefined {
    if (left === undefined || right === undefined) return undefined;
    const result: PrimitiveKey[] = [];
    for (const value of [...left, ...right]) {
      const normalized = this.normalize(value);
      if (!result.some((current) => samePrimitive(current, normalized))) result.push(normalized);
      if (result.length > this.maxKeys) return undefined;
    }
    return result;
  }

  /** kind별 key 정규화다. Map은 primitive 값, property는 ToPropertyKey 문자열이다. */
  private normalize(value: PrimitiveKey): PrimitiveKey {
    const normalized = typeof value === 'number' && Object.is(value, -0) ? 0 : value;
    return this.kind === 'property' ? propertyToKey(normalized) : normalized;
  }

  /** 내부·호출자 예산을 함께 소비한다. */
  private step(): void {
    if (++this.steps > INTERNAL_MAX_STEPS) throw new PrimitiveBudgetExceeded();
    this.context.budgetStep?.();
  }
}

/** resolver 자체 상한 초과 표식이다. caller budget 예외와 구별해 전파한다. */
class PrimitiveBudgetExceeded extends Error {}

/** SameValueZero에 맞춘 bounded primitive 비교다(NaN은 입력에서 허용하지 않는다). */
function samePrimitive(left: PrimitiveKey, right: PrimitiveKey): boolean {
  return Object.is(left, right) || (typeof left === 'number' && typeof right === 'number' && left === 0 && right === 0);
}
