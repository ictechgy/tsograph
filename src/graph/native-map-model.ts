/**
 * private top-level `const registry = new Map()`의 제한된 AST 모델이다.
 *
 * registry 자체가 밖으로 새거나 Map API 표기가 alias/computed/optional/chained가 되면 전체 descriptor를 버린다.
 * set의 key/value는 평가하지 않고 원래 expression만 보존하며, key가 모호하면 조회 값은 전체 set union이다.
 */

import ts from 'typescript';

import { climbWrappers, referenceSite } from './flow-index.ts';
import { isIntrinsicDefaultLibraryGlobal, isMutationCleanView, type MutationSafetyContext } from './mutation-safety.ts';
import { resolvePrimitiveKeys } from './primitive-keys.ts';
import { skipWrappers } from './node-collector.ts';

/** native Map에 허용하는 직접 operation이다. */
export type NativeMapOperation = 'get' | 'set' | 'has' | 'delete' | 'clear' | 'keys' | 'size';

/** `registry.set(key, value)` 한 건의 AST expression 보존 기록이다. */
export interface NativeMapSet {
  /** set 호출 site */
  readonly site: ts.CallExpression;
  /** 원래 key expression */
  readonly key: ts.Expression;
  /** 원래 value expression */
  readonly value: ts.Expression;
}

/** registry 직접 참조 하나의 operation과 key expression이다. */
export interface NativeMapUse {
  /** 직접 읽은 Map operation */
  readonly operation: NativeMapOperation;
  /** 호출이면 CallExpression, size면 PropertyAccessExpression */
  readonly site: ts.Node;
  /** get/has/delete/set의 원래 key expression, 그 밖에는 undefined */
  readonly key: ts.Expression | undefined;
}

/** private native Map registry descriptor다. 값은 expression으로만 공개한다. */
export interface NativeMapDescriptor {
  /** registry variable symbol */
  readonly symbol: ts.Symbol;
  /** top-level const declaration */
  readonly declaration: ts.VariableDeclaration;
  /** zero-argument genuine Map constructor */
  readonly initializer: ts.NewExpression;
  /** 모든 직접 set 기록(호출 순서) */
  readonly sets: readonly NativeMapSet[];
  /** 모든 set value expression의 편의 projection */
  readonly values: readonly ts.Expression[];
  /** 모든 허용된 직접 참조(호출 순서) */
  readonly uses: readonly NativeMapUse[];
}

/**
 * 스캔한 파일에서 strict native Map registry descriptor를 모은다.
 * @param context checker·FlowIndex·default-lib predicate·openness 문맥
 * @returns 증명된 descriptor만 반환하며 하나라도 escape/unsupported use면 해당 registry를 버린다.
 */
export function collectNativeMapDescriptors(context: MutationSafetyContext): readonly NativeMapDescriptor[] {
  if (context.openProgram || context.openProperties || context.index.hasOpaqueImport || context.index.hasOpaqueMutation) return [];
  if (!isMutationCleanView(context)) return [];
  const budget = new ModelBudget(context.budgetStep);
  const descriptors: NativeMapDescriptor[] = [];
  try {
    for (const sourceFile of context.index.files) {
      budget.step();
      for (const statement of sourceFile.statements) {
        budget.step();
        if (!ts.isVariableStatement(statement) || hasExportModifier(statement)) continue;
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
        for (const declaration of statement.declarationList.declarations) {
          budget.step();
          const initializer = mapInitializer(context, declaration);
          if (initializer === undefined) continue;
          const symbol = context.checker.getSymbolAtLocation(declaration.name);
          if (symbol === undefined || !ts.isIdentifier(declaration.name) || !isPrivateRegistry(context, symbol)) continue;
          const descriptor = inspectRegistry(context, symbol, declaration, initializer, budget);
          if (descriptor !== undefined) descriptors.push(descriptor);
        }
      }
    }
    return descriptors;
  } catch (error) {
    // bounded AST walk가 끝나면 positive descriptor를 만들지 않지만, caller budget 예외는 보존한다.
    if (error instanceof ModelBudgetExceeded) return [];
    throw error;
  }
}

/**
 * get/has/delete 조회 key에 해당할 수 있는 set value expression을 고른다.
 * key 또는 set key를 primitive로 증명하지 못하면 모호한 key가 될 수 있으므로 full union을 돌려준다.
 * @param descriptor native Map descriptor
 * @param key 조회 key expression; undefined면 unknown receiver/query
 * @param context primitive key 해석 문맥
 * @returns ValueFlow가 후속으로 union할 expression 목록
 */
export function nativeMapValuesForKey(
  descriptor: NativeMapDescriptor,
  key: ts.Expression | undefined,
  context: MutationSafetyContext,
): readonly ts.Expression[] {
  const query = key === undefined ? undefined : resolvePrimitiveKeys(key, context, 'map');
  if (query === undefined || query.length === 0) return descriptor.values;
  const selected: ts.Expression[] = [];
  for (const set of descriptor.sets) {
    const setKeys = resolvePrimitiveKeys(set.key, context, 'map');
    if (setKeys === undefined || setKeys.some((setKey) => query.some((queryKey) => Object.is(setKey, queryKey)))) {
      selected.push(set.value);
    }
  }
  return selected;
}

/** zero-argument direct genuine Map initializer인지 확인한다. */
function mapInitializer(context: MutationSafetyContext, declaration: ts.VariableDeclaration): ts.NewExpression | undefined {
  if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) return undefined;
  const initializer = skipWrappers(declaration.initializer);
  if (!ts.isNewExpression(initializer) || initializer.arguments?.length !== 0) return undefined;
  const callee = skipWrappers(initializer.expression);
  return ts.isIdentifier(callee) && isIntrinsicDefaultLibraryGlobal(context, callee, 'Map') ? initializer : undefined;
}

/** registry symbol이 export/alias/reassignment 없이 private인지 확인한다. */
function isPrivateRegistry(context: MutationSafetyContext, symbol: ts.Symbol): boolean {
  return !context.index.exportedSymbols.has(symbol)
    && (context.index.aliasNames.get(symbol)?.length ?? 0) === 0
    && (context.index.identifierWrites.get(symbol)?.length ?? 0) === 0;
}

/** 하나의 registry 사용을 전부 검사하고 descriptor를 만든다. */
function inspectRegistry(
  context: MutationSafetyContext,
  symbol: ts.Symbol,
  declaration: ts.VariableDeclaration,
  initializer: ts.NewExpression,
  budget: ModelBudget,
): NativeMapDescriptor | undefined {
  const sets: NativeMapSet[] = [];
  const uses: NativeMapUse[] = [];
  for (const token of context.index.references.get(symbol) ?? []) {
    budget.step();
    const use = describeUse(context, symbol, token);
    if (use === undefined) return undefined;
    uses.push(use);
    if (use.operation !== 'set') continue;
    const call = use.site;
    const value = ts.isCallExpression(call) && call.arguments.length === 2 ? call.arguments[1] : undefined;
    if (!ts.isCallExpression(call) || use.key === undefined || value === undefined || !ts.isExpression(value)) return undefined;
    sets.push({ site: call, key: use.key, value });
  }
  return { symbol, declaration, initializer, sets, values: sets.map((set) => set.value), uses };
}

/** reference token의 정확한 direct property access를 operation으로 분류한다. */
function describeUse(context: MutationSafetyContext, symbol: ts.Symbol, token: ts.Node): NativeMapUse | undefined {
  const site = referenceSite(token);
  if (!ts.isExpression(site)) return undefined;
  const expressionSite = climbWrappers(site);
  const parent = expressionSite.parent;
  const access = ts.isPropertyAccessExpression(parent) && parent.expression === expressionSite ? parent
    : ts.isElementAccessExpression(parent) && parent.expression === expressionSite ? parent : undefined;
  if (access === undefined || access.questionDotToken !== undefined) return undefined;
  const receiver = skipWrappers(access.expression);
  if (!ts.isIdentifier(receiver) || context.checker.getSymbolAtLocation(receiver) !== symbol) return undefined;
  if (!ts.isPropertyAccessExpression(access)) return undefined; // computed `registry[key]`는 unknown alias다.
  const operation = nativeOperation(access.name.text);
  if (operation === undefined) return undefined;
  if (operation === 'size') return isReadOnlySizeUse(access) ? { operation, site: access, key: undefined } : undefined;
  const call = access.parent;
  if (!ts.isCallExpression(call) || call.expression !== access || call.questionDotToken !== undefined || call.arguments.some(ts.isSpreadElement)) return undefined;
  const expectedArguments = operation === 'set' ? 2 : operation === 'get' || operation === 'has' || operation === 'delete' ? 1 : 0;
  if (call.arguments.length !== expectedArguments || isChainedCall(call)) return undefined;
  const key = operation === 'set' || operation === 'get' || operation === 'has' || operation === 'delete' ? call.arguments[0] : undefined;
  if (key !== undefined && !ts.isExpression(key)) return undefined;
  if (operation === 'set' && !isDiscardedSetCall(call)) return undefined;
  return { operation, site: call, key };
}

/** 허용하는 direct native Map member 이름이다. */
function nativeOperation(name: string): NativeMapOperation | undefined {
  if (name === 'get' || name === 'set' || name === 'has' || name === 'delete'
    || name === 'clear' || name === 'keys') return name;
  if (name === 'size') return 'size';
  return undefined;
}

/** set 결과를 포함한 method call chaining을 거부한다. */
function isChainedCall(call: ts.CallExpression): boolean {
  const parent = call.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.expression === call)
    || (ts.isElementAccessExpression(parent) && parent.expression === call)
    || (ts.isCallExpression(parent) && parent.expression === call)
    || (ts.isTaggedTemplateExpression(parent) && parent.tag === call);
}

/** set 반환값을 버리는 expression statement 또는 `void` expression만 허용한다. */
function isDiscardedSetCall(call: ts.CallExpression): boolean {
  const parent = call.parent;
  return (ts.isExpressionStatement(parent) && parent.expression === call)
    || (ts.isVoidExpression(parent) && parent.expression === call);
}

/** size는 읽기 expression으로만 허용한다. */
function isReadOnlySizeUse(access: ts.PropertyAccessExpression): boolean {
  const parent = access.parent;
  if (ts.isBinaryExpression(parent) && parent.left === access
    && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return false;
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent) || ts.isDeleteExpression(parent)) return false;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === access) return false;
  if (ts.isCallExpression(parent) && parent.expression === access) return false;
  return true;
}

/** variable statement export modifier를 확인한다. */
function hasExportModifier(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
}

/** native Map 모델의 내부 AST 예산이다. */
class ModelBudget {
  private readonly externalStep: (() => void) | undefined;
  private steps = 0;

  constructor(externalStep: (() => void) | undefined) {
    this.externalStep = externalStep;
  }

  step(): void {
    if (++this.steps > 100_000) throw new ModelBudgetExceeded();
    this.externalStep?.();
  }
}

/** native Map 모델 자체의 상한 초과 표식이다. */
class ModelBudgetExceeded extends Error {}
