/**
 * FlowIndex mutation 근거를 clean-view 증명으로 투영하는 보수적인 공통 guard다.
 *
 * `known` confidence는 AST 연산 형태만 안다는 뜻이다. receiver가 private ordinary object literal이고 own-data
 * primitive 값이라는 별도 증명이 없으면 known direct assignment도 허용하지 않는다.
 */

import ts from 'typescript';
import { SterileConfinementCertificate } from './constructor-carrier.ts';

import { climbWrappers, referenceSite, type FlowIndex, type MutationRecord } from './flow-index.ts';
import { propertyToKey, resolvePrimitiveKeys, type PrimitiveKeyContext } from './primitive-keys.ts';
import { skipWrappers } from './node-collector.ts';

/** mutation guard와 native intrinsic 판정이 공유하는 분석 문맥이다. */
export interface MutationSafetyContext extends PrimitiveKeyContext {
  /** direct·reflective mutation과 visible writes를 담은 전체 FlowIndex다. */
  readonly index: FlowIndex;
  /** 스캔 밖 호출자가 있을 수 있는 공개/불완전 프로그램 여부다. */
  readonly openProgram: boolean;
  /** 스캔 밖 코드가 공개 property를 쓸 수 있는지 여부다. */
  readonly openProperties: boolean;
  /** cached extended proof가 실제 current fact read를 같은 charged guard 위치에서 재생한다. */
  readonly currentFact?: <T>(read: () => T, equal?: (current: T, expected: T) => boolean) => T;
}

/** ctor가 정확히 audited initializer site를 예외로 넘길 때 쓰는 선택지다. */
export interface MutationSafetyOptions {
  /** 이 site identity만 해당 mutation을 허용한다. 모든 다른 record는 계속 검사한다. */
  readonly allowedSites?: ReadonlySet<ts.Node>;
  /** 세 소비자가 같은 완료·문맥 인증서를 검사한다. 영역 안 mismatch는 즉시 닫는다. */
  readonly confinement?: SterileConfinementCertificate;
}

/**
 * 전체 mutation 관찰이 clean-view인지 판정한다.
 *
 * 허용 범위는 unrelated identifier binding과 private nonescaping ordinary object literal의 기존 own-data property에
 * primitive 값을 쓰는 직접 assignment뿐이다. prototype·descriptor·reflective·delete·update·unknown receiver는
 * 항상 실패한다. `allowedSites`는 caller가 감사한 정확한 ctor site에만 적용하며, 다른 mutation record의 스캔을 건너뛰지 않는다.
 * @param context checker·FlowIndex·프로그램 openness 문맥
 * @param options 정확한 예외 site 집합
 * @returns 모든 관찰을 증명했으면 true
 */
export function isMutationCleanView(context: MutationSafetyContext, options: MutationSafetyOptions = {}): boolean {
  const budget = new GuardBudget(context.budgetStep);
  try {
    if (context.openProgram || context.openProperties || context.index.hasOpaqueImport || context.index.hasOpaqueMutation) return false;
    if (options.confinement !== undefined && !SterileConfinementCertificate.isIssued(options.confinement)) return false;
    if (hasDefinitelyDirtyMutation(context, options, budget)) return false;
    if (hasForbiddenDynamicReference(context, budget)) return false;
    if (!hasSafeArrayLiteralUse(context, options, budget)) return false;
    const allowedSites = options.allowedSites;
    for (const record of context.index.mutations) {
      budget.step();
      const certified = options.confinement?.write(context, record);
      if (certified === false) return false;
      if (certified === true) continue;
      if (allowedSites?.has(record.site)) continue;
      if (record.effect === 'binding') continue;
      if (!isPrivatePrimitiveOwnDataWrite(context, record, budget)) return false;
    }
    return true;
  } catch (error) {
    // guard 자체의 상한 초과만 false로 닫고, ValueFlow caller의 budget 예외는 query가 집계하도록 보존한다.
    if (error instanceof GuardBudgetExceeded) return false;
    throw error;
  }
}

/** 값 흐름 AST를 걷기 전에 즉시 증명 실패인 mutation record를 닫는다. */
function hasDefinitelyDirtyMutation(
  context: MutationSafetyContext,
  options: MutationSafetyOptions,
  budget: GuardBudget,
): boolean {
  for (const record of context.index.mutations) {
    budget.step();
    const certified = options.confinement?.write(context, record);
    if (certified === false) return true;
    if (certified === true) continue;
    if (options.allowedSites?.has(record.site)) continue;
    if (record.effect === 'binding') {
      const target = skipWrappers(record.target);
      if (ts.isIdentifier(target) && BUILTIN_GLOBAL_NAMES.has(target.text)) return true;
      continue;
    }
    if (record.effect !== 'property' || record.operation !== 'assignment' || record.confidence !== 'known'
      || record.key === undefined || record.value === undefined || record.staticKey === '__proto__') return true;
    if (isBuiltinReplacementRecord(context, record)) return true;
    if (!hasLiteralReceiverDeclaration(context, record.target)) return true;
  }
  return false;
}

/** Object/Reflect/Map/Date/Array global·prototype replacement을 mutation record 하나에서 판정한다. */
function isBuiltinReplacementRecord(context: MutationSafetyContext, record: MutationRecord): boolean {
  const target = skipWrappers(record.target);
  if (ts.isIdentifier(target) && BUILTIN_GLOBAL_NAMES.has(target.text)) return true;
  if (isGlobalThisExpression(target) && record.staticKey !== undefined && BUILTIN_GLOBAL_NAMES.has(record.staticKey)) return true;
  return record.effect === 'property' && builtinRootName(target, BUILTIN_GLOBAL_NAMES) !== undefined;
}

/** computed key assignment의 receiver가 최소한 private literal 후보인지 확인한다. */
function hasLiteralReceiverDeclaration(context: MutationSafetyContext, target: ts.Expression): boolean {
  const inner = skipWrappers(target);
  if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) return true;
  if (!ts.isIdentifier(inner)) return false;
  const symbol = context.checker.getSymbolAtLocation(inner);
  const declaration = symbol?.declarations?.length === 1 ? symbol.declarations[0] : undefined;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
  const initializer = skipWrappers(declaration.initializer);
  return ts.isObjectLiteralExpression(initializer) || ts.isArrayLiteralExpression(initializer);
}

/**
 * 이름이 같은 프로젝트 declaration이나 declaration file을 intrinsic으로 착각하지 않고, default lib symbol만 인정한다.
 * `isDeclarationFile`만으로는 dependency `.d.ts` shadow를 구별할 수 없으므로 반드시 Program predicate를 사용한다.
 * @param context mutation 분석 문맥
 * @param expression 전역 builtin 표기
 * @param name 기대 builtin 이름
 * @returns genuine default-library global이면 true
 */
export function isIntrinsicDefaultLibraryGlobal(
  context: MutationSafetyContext,
  expression: ts.Expression,
  name: string,
): boolean {
  const inner = skipWrappers(expression);
  if (!ts.isIdentifier(inner) || inner.text !== name) return false;
  const symbol = context.checker.getSymbolAtLocation(inner);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) !== 0) return false;
  const declarations = symbol.declarations ?? [];
  if (declarations.length === 0 || !declarations.every((declaration) => context.isDefaultLibraryFile(declaration.getSourceFile()))) return false;
  if ((context.index.identifierWrites.get(symbol)?.length ?? 0) > 0) return false;
  return !hasVisibleIntrinsicWrite(context, symbol, name);
}

/** intrinsic global·prototype에 보이는 쓰기와 broad reflective/prototype effect를 닫는다. */
function hasVisibleIntrinsicWrite(context: MutationSafetyContext, symbol: ts.Symbol, name: string): boolean {
  return context.index.mutations.some((record) => {
    if (record.effect === 'prototype' || record.effect === 'unknown' || record.operation !== 'assignment') return true;
    if (record.effect !== 'property') return false;
    const target = skipWrappers(record.target);
    if (ts.isIdentifier(target) && context.checker.getSymbolAtLocation(target) === symbol) return true;
    if (ts.isPropertyAccessExpression(target) && target.name.text === 'prototype') {
      const owner = skipWrappers(target.expression);
      if (ts.isIdentifier(owner) && owner.text === name && context.checker.getSymbolAtLocation(owner) === symbol) return true;
    }
    if (ts.isPropertyAccessExpression(target) && target.name.text === name && isGlobalThisExpression(target.expression)) return true;
    return isGlobalThisExpression(target) && record.staticKey === name;
  });
}

/** 한 mutation이 허용된 private own-data primitive assignment인지 판정한다. */
function isPrivatePrimitiveOwnDataWrite(context: MutationSafetyContext, record: MutationRecord, budget: GuardBudget): boolean {
  if (record.operation !== 'assignment' || record.confidence !== 'known' || record.key === undefined
    || record.value === undefined || record.effect !== 'property') return false;
  if (record.staticKey === '__proto__') return false;
  const receiver = privateLiteralReceiver(context, record.target, budget);
  if (receiver === undefined) return false;
  const resolvedKeys = record.staticKey === undefined ? resolvePrimitiveKeys(record.key, context, 'property') : [record.staticKey];
  if (resolvedKeys === undefined || resolvedKeys.length !== 1) return false;
  const key = propertyToKey(resolvedKeys[0]!);
  if (receiver.kind === 'array') return isPrimitiveArrayWrite(context, receiver.literal, key, record.value, budget);
  const ownData = ownDataProperties(receiver.literal);
  if (ownData === undefined) return false;
  const property = ownData.get(key);
  if (property === undefined) return false;
  for (const value of ownData.values()) {
    budget.step();
    const resolved = resolvePrimitiveKeys(value, context, 'map');
    if (resolved === undefined) return false;
  }
  const written = resolvePrimitiveKeys(record.value, context, 'map');
  return written !== undefined;
}

/** mutation receiver를 ordinary object literal과 private symbol에 연결한다. */
type PrivateLiteralReceiver =
  | { readonly literal: ts.ObjectLiteralExpression; readonly kind: 'object' }
  | { readonly literal: ts.ArrayLiteralExpression; readonly kind: 'array' };

/** mutation receiver를 private ordinary object/array literal에 연결한다. */
function privateLiteralReceiver(
  context: MutationSafetyContext,
  target: ts.Expression,
  budget: GuardBudget,
): PrivateLiteralReceiver | undefined {
  const inner = skipWrappers(target);
  if (ts.isObjectLiteralExpression(inner)) return { literal: inner, kind: 'object' };
  if (ts.isArrayLiteralExpression(inner)) return { literal: inner, kind: 'array' };
  if (!ts.isIdentifier(inner)) return undefined;
  const symbol = context.checker.getSymbolAtLocation(inner);
  if (symbol === undefined || context.index.exportedSymbols.has(symbol) || (context.index.aliasNames.get(symbol)?.length ?? 0) > 0) return undefined;
  if ((context.index.identifierWrites.get(symbol)?.length ?? 0) > 0) return undefined;
  const declaration = symbol.declarations?.length === 1 ? symbol.declarations[0] : undefined;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)
    || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0
    || declaration.initializer === undefined) return undefined;
  const literal = skipWrappers(declaration.initializer);
  if (ts.isObjectLiteralExpression(literal)) {
    return isNonescapingObject(context, symbol, budget, 'object') ? { literal, kind: 'object' } : undefined;
  }
  if (ts.isArrayLiteralExpression(literal)) {
    return !isReadonlyArrayDeclaration(declaration) && isNonescapingObject(context, symbol, budget, 'array')
      ? { literal, kind: 'array' } : undefined;
  }
  return undefined;
}

/** object/array literal 변수의 모든 visible reference가 허용된 own property/index read인지 확인한다. */
function isNonescapingObject(context: MutationSafetyContext, symbol: ts.Symbol, budget: GuardBudget, kind: 'object' | 'array'): boolean {
  for (const token of context.index.references.get(symbol) ?? []) {
    budget.step();
    const site = referenceSite(token);
    if (!isSafeObjectPropertyUse(context, symbol, site, kind)) return false;
  }
  return true;
}

/** private object/array가 primitive own property/index를 읽는 자리인지 확인한다. */
function isSafeObjectPropertyUse(context: MutationSafetyContext, symbol: ts.Symbol, site: ts.Node, kind: 'object' | 'array'): boolean {
  const expressionSite = climbWrappers(site);
  const parent = expressionSite.parent;
  const access = ts.isPropertyAccessExpression(parent) && parent.expression === expressionSite ? parent
    : ts.isElementAccessExpression(parent) && parent.expression === expressionSite ? parent : undefined;
  if (access === undefined || access.questionDotToken !== undefined) return false;
  const receiver = skipWrappers(access.expression);
  if (!ts.isIdentifier(receiver) || context.checker.getSymbolAtLocation(receiver) !== symbol) return false;
  if (kind === 'object' && ts.isPropertyAccessExpression(access)) return true;
  const keys = ts.isPropertyAccessExpression(access) ? undefined : resolvePrimitiveKeys(access.argumentExpression, context, 'property');
  return keys !== undefined && keys.length === 1 && (kind === 'object' || (typeof keys[0] === 'string' && isArrayIndex(keys[0])));
}

/** private array의 기존 own index에 primitive 값을 쓰는지 확인한다. */
function isPrimitiveArrayWrite(
  context: MutationSafetyContext,
  literal: ts.ArrayLiteralExpression,
  key: string,
  value: ts.Expression,
  budget: GuardBudget,
): boolean {
  if (!isArrayIndex(key) || !arrayHasIndex(literal, key)) return false;
  if (!arrayValuesPrimitive(context, literal, budget)) return false;
  return resolvePrimitiveKeys(value, context, 'map') !== undefined;
}

/** 참조되는 const array literal의 초기 own elements가 모두 primitive인지 확인한다. */
function arrayValuesPrimitive(context: MutationSafetyContext, literal: ts.ArrayLiteralExpression, budget: GuardBudget): boolean {
  for (const element of literal.elements) {
    budget.step();
    if (!ts.isExpression(element) || resolvePrimitiveKeys(element, context, 'map') === undefined) return false;
  }
  return true;
}

/** mutation record가 없는 array method/alias/escape도 clean-view를 열도록 모든 const array reference를 검사한다. */
function hasSafeArrayLiteralUse(context: MutationSafetyContext, options: MutationSafetyOptions, budget: GuardBudget): boolean {
  // readonly index의 내용은 새 질의에서 바뀔 수 있다. 객체 identity로 완료 판정을 재사용하지 않는다.
  const declarations = new Set<ts.VariableDeclaration>();
  if (context.currentFact !== undefined) {
    const snapshot = context.currentFact(() => {
      const map = context.index.tokenOccurrences;
      return { map, size: map.size };
    }, (current, expected) => current.map === expected.map && current.size === expected.size);
    for (const name of snapshot.map.keys()) {
      const tokens = currentTokenList(context, name);
      for (let index = 0; index < tokens.length; index++) {
        const token = context.currentFact(() => context.index.tokenOccurrences.get(name)?.[index]);
        if (token === undefined) return false;
        if (!ts.isIdentifier(token) || !ts.isVariableDeclaration(token.parent) || token.parent.name !== token
          || token.parent.initializer === undefined || !ts.isVariableDeclarationList(token.parent.parent)
          || (token.parent.parent.flags & ts.NodeFlags.Const) === 0) continue;
        declarations.add(token.parent);
      }
    }
  } else for (const tokens of context.index.tokenOccurrences.values()) {
    for (const token of tokens) {
      budget.step();
      if (!ts.isIdentifier(token) || !ts.isVariableDeclaration(token.parent) || token.parent.name !== token
        || token.parent.initializer === undefined || !ts.isVariableDeclarationList(token.parent.parent)
        || (token.parent.parent.flags & ts.NodeFlags.Const) === 0) continue;
      declarations.add(token.parent);
    }
  }
  for (const declaration of declarations) {
    const certified = options.confinement?.array(context, declaration);
    if (certified === false) return false;
    if (certified === true) continue;
    const literal = skipWrappers(declaration.initializer!);
    if (!ts.isArrayLiteralExpression(literal)) continue;
    const symbol = context.checker.getSymbolAtLocation(declaration.name);
    if (symbol === undefined) {
      return false;
    }
    const references = context.index.references.get(symbol) ?? [];
    if (references.length > 0 && (isReadonlyArrayDeclaration(declaration) || !arrayValuesPrimitive(context, literal, budget)
      || !isNonescapingObject(context, symbol, budget, 'array'))) {
      return false;
    }
  }
  return true;
}

/** canonical nonnegative array index인지 확인한다. `length`·앞자리 0·2^32-1 이상은 제외한다. */
function isArrayIndex(key: string): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return false;
  const value = Number(key);
  return Number.isSafeInteger(value) && value >= 0 && value < 4_294_967_295;
}

/** array literal에 해당 own index가 실제로 존재하는지 확인한다(holes 금지). */
function arrayHasIndex(literal: ts.ArrayLiteralExpression, key: string): boolean {
  const index = Number(key);
  return index < literal.elements.length && literal.elements[index] !== undefined && !ts.isOmittedExpression(literal.elements[index]!);
}

/** 명시적 readonly 배열 타입과 `as const` 배열은 writable 증명을 닫는다. */
function isReadonlyArrayDeclaration(declaration: ts.VariableDeclaration): boolean {
  const type = declaration.type;
  if (type !== undefined && (ts.isTypeOperatorNode(type) && type.operator === ts.SyntaxKind.ReadonlyKeyword
    || ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'ReadonlyArray')) return true;
  let initializer = declaration.initializer;
  while (initializer !== undefined && ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
  return initializer !== undefined && ts.isAsExpression(initializer) && initializer.type.kind === ts.SyntaxKind.ConstKeyword;
}

/** object literal의 static own-data property만 수집한다. accessor·method·spread·computed는 모두 거부한다. */
function ownDataProperties(literal: ts.ObjectLiteralExpression): ReadonlyMap<string, ts.Expression> | undefined {
  const properties = new Map<string, ts.Expression>();
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
    const name = property.name;
    if (name === undefined || ts.isComputedPropertyName(name)) return undefined;
    const key = propertyName(name);
    if (key === undefined || key === '__proto__' || properties.has(key)) return undefined;
    properties.set(key, ts.isPropertyAssignment(property) ? property.initializer : property.name);
  }
  return properties;
}

/** ordinary object literal property name을 JavaScript property key로 바꾼다. */
function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isNumericLiteral(name)) return propertyToKey(Number(name.text));
  return undefined;
}

/** eval·Function·Proxy의 직접 참조와 alias, computed globalThis 참조를 보수적으로 닫는다. */
function hasForbiddenDynamicReference(context: MutationSafetyContext, budget: GuardBudget): boolean {
  // 예산이 있는 증명의 결과도 다른 caller의 전역 긍정 cache로 넘어가지 않도록 현재 근거만 읽는다.
  const forbidden = new Set(['eval', 'Function', 'Proxy']);
  if (hasBuiltinReplacement(context)) return true;
  const candidateNames = new Set([
    ...forbidden, 'Object', 'Reflect', 'globalThis', ...MUTATOR_NAMES, 'call', 'apply', 'bind',
  ]);
  const ownerAliases = new Set<ts.Symbol>();
  for (const name of candidateNames) {
    const tokens = context.currentFact === undefined ? context.index.tokenOccurrences.get(name) ?? [] : currentTokenList(context, name);
    for (let index = 0; index < tokens.length; index++) {
      const token = context.currentFact === undefined
        ? (budget.step(), tokens[index]!) : context.currentFact(() => context.index.tokenOccurrences.get(name)?.[index]);
      if (token === undefined) return true;
      if (dangerousToken(context, token, forbidden)) return true;
      if (isIntrinsicOwnerAliasDeclaration(token)) {
        const symbol = context.checker.getSymbolAtLocation((token.parent as ts.VariableDeclaration).name);
        if (symbol !== undefined) ownerAliases.add(symbol);
      }
    }
  }
  for (const symbol of ownerAliases) {
    for (const token of context.index.references.get(symbol) ?? []) {
      budget.step();
      if (dangerousToken(context, token, forbidden)) return true;
    }
  }
  return false;
}

/** token map/list identity와 길이를 한 current guard로 읽어 append·교체를 닫는다. */
function currentTokenList(context: MutationSafetyContext, name: string): readonly ts.Node[] {
  return context.currentFact!(() => {
    const map = context.index.tokenOccurrences;
    const list = map.get(name);
    return { map, present: map.has(name), list, length: list?.length ?? 0 };
  }, (current, expected) => current.map === expected.map && current.present === expected.present
    && current.list === expected.list && current.length === expected.length).list ?? [];
}

/** candidate token 하나의 direct forbidden/mutator/global namespace 사용을 판정한다. */
function dangerousToken(context: MutationSafetyContext, token: ts.Node, forbidden: ReadonlySet<string>): boolean {
  if (ts.isIdentifier(token) && forbidden.has(token.text) && isValueReference(token)
    && !isDeclarationName(token) && !isTypePosition(token)) return true;
  if (ts.isIdentifier(token) && isAliasedForbiddenSymbol(context, token) && isValueReference(token)
    && !isDeclarationName(token) && !isTypePosition(token)) return true;
  const access = accessContainingToken(token);
  if (access === undefined) return false;
  if (mutatorReference(context, access) !== undefined || dynamicIntrinsicNamespace(context, access)) return true;
  if (!ts.isElementAccessExpression(access) || !isGlobalThisExpression(access.expression)) return false;
  const key = skipWrappers(access.argumentExpression);
  return !isStringLiteralNode(key) || forbidden.has(key.text);
}

/** Object/Reflect를 local const alias로 만들었는지 candidate declaration에서 확인한다. */
function isIntrinsicOwnerAliasDeclaration(token: ts.Node): boolean {
  if (!ts.isIdentifier(token)) return false;
  let initializer: ts.Expression = token;
  if (ts.isPropertyAccessExpression(token.parent) && token.parent.name === token) initializer = token.parent;
  const declaration = initializer.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== initializer || !ts.isIdentifier(declaration.name)) return false;
  if (ts.isIdentifier(initializer)) return initializer.text === 'Object' || initializer.text === 'Reflect';
  return ts.isPropertyAccessExpression(initializer) && isGlobalThisExpression(initializer.expression)
    && (initializer.name.text === 'Object' || initializer.name.text === 'Reflect');
}

/** token이 속한 direct property/element access다. */
function accessContainingToken(token: ts.Node): ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined {
  const parent = token.parent;
  if (ts.isPropertyAccessExpression(parent) && (parent.name === token || parent.expression === token)) return parent;
  if (ts.isElementAccessExpression(parent) && parent.expression === token) return parent;
  return undefined;
}

/** 문자열 literal AST node만 type-safe하게 판정한다. */
function isStringLiteralNode(node: ts.Expression): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** Object/Reflect/Map/Date global binding과 prototype/member replacement을 닫는다. */
function hasBuiltinReplacement(context: MutationSafetyContext): boolean {
  return context.index.mutations.some((record) => {
    const target = skipWrappers(record.target);
    if (record.effect === 'binding' && ts.isIdentifier(target) && BUILTIN_GLOBAL_NAMES.has(target.text)) return true;
    if (record.effect !== 'property') return false;
    if (isGlobalThisExpression(target) && record.staticKey !== undefined && BUILTIN_GLOBAL_NAMES.has(record.staticKey)) return true;
    return builtinRootName(target, BUILTIN_GLOBAL_NAMES) !== undefined;
  });
}

/** `Map.prototype`, `globalThis.Map.prototype`처럼 builtin으로 시작하는 target을 찾는다. */
function builtinRootName(expression: ts.Expression, names: ReadonlySet<string>): string | undefined {
  const inner = skipWrappers(expression);
  if (ts.isIdentifier(inner)) return names.has(inner.text) ? inner.text : undefined;
  if (ts.isPropertyAccessExpression(inner)) {
    if (isGlobalThisExpression(inner.expression) && names.has(inner.name.text)) return inner.name.text;
    return builtinRootName(inner.expression, names);
  }
  if (ts.isElementAccessExpression(inner)) {
    const key = literalName(inner.argumentExpression);
    if (isGlobalThisExpression(inner.expression) && key !== undefined && names.has(key)) return key;
    return builtinRootName(inner.expression, names);
  }
  return undefined;
}

/** mutator API와 alias의 property/call/apply/bind 사용을 찾는다. */
function mutatorReference(context: MutationSafetyContext, expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | undefined {
  const member = ts.isPropertyAccessExpression(expression) ? expression.name.text
    : literalName(expression.argumentExpression);
  if (member !== undefined && MUTATOR_NAMES.has(member)
    && (member !== 'set' || intrinsicOwner(context, expression.expression) !== undefined)) return member;
  if (member === 'call' || member === 'apply' || member === 'bind') return mutatorValue(context, expression.expression);
  return undefined;
}

/** `Object.setPrototypeOf`와 local const alias를 bounded하게 따라간다. */
function mutatorValue(context: MutationSafetyContext, expression: ts.Expression, depth = 0, seen = new Set<ts.Symbol>()): string | undefined {
  if (depth > 16) return undefined;
  const inner = skipWrappers(expression);
  if (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) {
    const member = ts.isPropertyAccessExpression(inner) ? inner.name.text : literalName(inner.argumentExpression);
    if (member !== undefined && MUTATOR_NAMES.has(member)) return member;
    if (member === 'call' || member === 'apply' || member === 'bind') return mutatorValue(context, inner.expression, depth + 1, seen);
    return undefined;
  }
  if (!ts.isIdentifier(inner)) return undefined;
  const symbol = context.checker.getSymbolAtLocation(inner);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  const declaration = symbol.declarations?.length === 1 ? symbol.declarations[0] : undefined;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
    || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  seen.add(symbol);
  return mutatorValue(context, declaration.initializer, depth + 1, seen);
}

/** Object/Reflect alias의 computed namespace read는 method를 알 수 없어 닫는다. */
function dynamicIntrinsicNamespace(context: MutationSafetyContext, expression: ts.PropertyAccessExpression | ts.ElementAccessExpression): boolean {
  if (!ts.isElementAccessExpression(expression)) return false;
  if (literalName(expression.argumentExpression) !== undefined) return false;
  return intrinsicOwner(context, expression.expression) !== undefined;
}

/** Object/Reflect 및 local const alias owner를 bounded하게 확인한다. */
function intrinsicOwner(context: MutationSafetyContext, expression: ts.Expression, depth = 0, seen = new Set<ts.Symbol>()): string | undefined {
  if (depth > 16) return undefined;
  const inner = skipWrappers(expression);
  if (ts.isIdentifier(inner) && (inner.text === 'Object' || inner.text === 'Reflect')) return inner.text;
  if (ts.isPropertyAccessExpression(inner) && isGlobalThisExpression(inner.expression)
    && (inner.name.text === 'Object' || inner.name.text === 'Reflect')) return inner.name.text;
  if (!ts.isIdentifier(inner)) return undefined;
  const symbol = context.checker.getSymbolAtLocation(inner);
  if (symbol === undefined || seen.has(symbol)) return undefined;
  const declaration = symbol.declarations?.length === 1 ? symbol.declarations[0] : undefined;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
    || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  seen.add(symbol);
  return intrinsicOwner(context, declaration.initializer, depth + 1, seen);
}

/** string literal member name만 읽는다. */
function literalName(expression: ts.Expression): string | undefined {
  const inner = skipWrappers(expression);
  return ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) ? inner.text : undefined;
}

const MUTATOR_NAMES = new Set([
  'assign', 'defineProperty', 'defineProperties', 'setPrototypeOf', 'set', 'deleteProperty',
]);
const BUILTIN_GLOBAL_NAMES = new Set(['Object', 'Reflect', 'Map', 'Date', 'Array']);

/** forbidden builtin으로 해석되는 import alias를 확인한다. */
function isAliasedForbiddenSymbol(context: MutationSafetyContext, identifier: ts.Identifier): boolean {
  const symbol = context.checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return false;
  const target = context.checker.getAliasedSymbol(symbol);
  return ['eval', 'Function', 'Proxy'].includes(target.getName());
}

/** identifier가 값 자리인지 대략 판정한다. 속성 이름·선언 이름은 별도 제외한다. */
function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return true;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === identifier) return true;
  if (ts.isQualifiedName(parent) || ts.isTypeReferenceNode(parent) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  return true;
}

/** binding·member 선언 자리인지 확인한다. */
function isDeclarationName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isFunctionDeclaration(parent)
    || ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent)) && parent.name === identifier) return true;
  if (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertySignature(parent)) return parent.name === identifier;
  if (ts.isBindingElement(parent) && parent.name === identifier) return true;
  return false;
}

/** type 자리의 builtin 이름은 runtime dynamic reference가 아니다. */
function isTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

/** globalThis 표기다. */
function isGlobalThisExpression(expression: ts.Expression): boolean {
  const inner = skipWrappers(expression);
  return ts.isIdentifier(inner) && inner.text === 'globalThis';
}

/** 내부 예산으로 AST를 bounded하게 걷는다. */
class GuardBudget {
  private readonly externalStep: (() => void) | undefined;
  private steps = 0;

  constructor(externalStep: (() => void) | undefined) {
    this.externalStep = externalStep;
  }

  step(): void {
    if (++this.steps > 100_000) throw new GuardBudgetExceeded();
    this.externalStep?.();
  }
}

/** mutation guard 자체의 AST 상한 초과 표식이다. */
class GuardBudgetExceeded extends Error {}
