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
 *
 * 완전한 mutation guard가 아니다. 쓰기는 알려진 표기(`Map`, `globalThis.Map`, `globalThis["Map"]`과 그 `.prototype`·
 * `["prototype"]`)만 본다. alias(`const M = Map`), 계산 키(`Map[k]`), 다른 전역 객체(`window.Map`),
 * `Object.getPrototypeOf(…)` 같은 간접 수신자는 판정하지 않는다. 그래서 호출자는 같은 문맥이 `isMutationCleanView`를
 * 통과했을 때만 이 결과를 증명으로 쓴다(native Map 후보 판정과 descriptor 수집이 그렇게 한다).
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

/**
 * intrinsic global·prototype에 보이는 쓰기와 broad reflective/prototype effect를 닫는다.
 *
 * 소유자는 `Map`, `globalThis.Map`, `globalThis["Map"]` 표기를 보고, prototype은 `.prototype`·`["prototype"]`을 본다.
 * 그 밖의 간접 수신자는 clean-view guard의 몫이다(`isIntrinsicDefaultLibraryGlobal` 문서 참고).
 */
function hasVisibleIntrinsicWrite(context: MutationSafetyContext, symbol: ts.Symbol, name: string): boolean {
  return context.index.mutations.some((record) => {
    if (record.effect === 'prototype' || record.effect === 'unknown' || record.operation !== 'assignment') return true;
    if (record.effect !== 'property') return false;
    const target = skipWrappers(record.target);
    if (isIntrinsicOwnerReference(context, target, symbol, name)) return true;
    const member = staticMember(target);
    if (member?.name === 'prototype' && isIntrinsicOwnerReference(context, member.owner, symbol, name)) return true;
    return isGlobalThisExpression(target) && record.staticKey === name;
  });
}

/** 식이 해당 intrinsic 심볼 자체이거나 `globalThis.<name>`·`globalThis["<name>"]`인지 본다. */
function isIntrinsicOwnerReference(context: MutationSafetyContext, expression: ts.Expression, symbol: ts.Symbol, name: string): boolean {
  const inner = skipWrappers(expression);
  if (ts.isIdentifier(inner)) return context.checker.getSymbolAtLocation(inner) === symbol;
  const member = staticMember(inner);
  return member?.name === name && isGlobalThisExpression(member.owner);
}

/** property access 또는 문자열 literal element access의 소유자와 정적 멤버 이름이다. */
function staticMember(expression: ts.Expression): { readonly owner: ts.Expression; readonly name: string } | undefined {
  if (ts.isPropertyAccessExpression(expression)) return { owner: expression.expression, name: expression.name.text };
  if (!ts.isElementAccessExpression(expression)) return undefined;
  const name = literalName(expression.argumentExpression);
  return name === undefined ? undefined : { owner: expression.expression, name };
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
      const aliasName = intrinsicOwnerAliasName(token);
      if (aliasName !== undefined) {
        const symbol = context.checker.getSymbolAtLocation(aliasName);
        if (symbol !== undefined) ownerAliases.add(symbol);
      }
    }
  }
  // alias의 모든 참조를 소유자 자신의 사용처럼 다시 본다. FlowIndex는 import를 따라가지 않으므로 다른 모듈의 참조
  // (`import { o }`, re-export, `ns.o`)는 여기서만 보인다. alias를 초깃값으로 쓰는 새 alias(`const p = o`)도 등록한다.
  const pending = [...ownerAliases];
  for (let symbol = pending.pop(); symbol !== undefined; symbol = pending.pop()) {
    for (const token of context.index.references.get(symbol) ?? []) {
      budget.step();
      if (dangerousToken(context, token, forbidden)) return true;
      const site = referenceSite(token);
      if (isDangerousOwnerUse(context, site)) return true;
      const chainedName = aliasDeclarationName(site);
      const chained = chainedName === undefined ? undefined : context.checker.getSymbolAtLocation(chainedName);
      if (chained !== undefined && !ownerAliases.has(chained)) {
        ownerAliases.add(chained);
        pending.push(chained);
      }
    }
  }
  return hasPossibleOwnerComputedRead(context, budget);
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
  const owner = intrinsicOwnerExpression(token);
  if (owner !== undefined && isDangerousOwnerUse(context, owner)) return true;
  if (isDangerousDestructuredMember(context, token)) return true;
  const access = accessContainingToken(token);
  if (access === undefined) return false;
  if (mutatorReference(context, access) !== undefined || dynamicIntrinsicNamespace(context, access)) return true;
  if (!ts.isElementAccessExpression(access) || !isGlobalThisExpression(access.expression)) return false;
  const key = skipWrappers(access.argumentExpression);
  return !isStringLiteralNode(key) || forbidden.has(key.text);
}

/**
 * candidate token이 Object/Reflect의 변수 alias 선언(`const o = Object`, `globalThis.Object`, `globalThis["Object"]`,
 * 감싼 형태, `let`·`var` 포함)의 초깃값이면 alias 이름을 돌려준다.
 *
 * 한정 표기에서 token의 부모는 member access이고 선언은 그 위(와 wrapper 위)다. 선언 이름을 여기서 돌려주어
 * 호출자가 token 부모를 선언으로 가정해 전역 심볼을 alias로 잘못 등록하지 않게 한다.
 * @param token `Object`·`Reflect`·`globalThis` candidate token 또는 `"Object"` 문자열 키
 * @returns alias 선언의 이름 식별자, 아니면 undefined
 */
function intrinsicOwnerAliasName(token: ts.Node): ts.Identifier | undefined {
  const owner = intrinsicOwnerExpression(token);
  return owner === undefined ? undefined : aliasDeclarationName(owner);
}

/**
 * candidate token이 속한 Object/Reflect 소유자 식을 바깥 wrapper까지 올라가 돌려준다.
 *
 * FlowIndex의 `reflectiveOwner`가 인정하는 표기(bare 식별자, `globalThis.X`, `globalThis["X"]`, 각 wrapper)를 같게 본다.
 * 멤버 이름·키 자리의 token(`window.Object`, `holder["Object"]`)은 소유자 자신이 아니다.
 * @param token `Object`·`Reflect`·`globalThis` 식별자 또는 문자열 키 token
 * @returns 소유자 식, 아니면 undefined
 */
function intrinsicOwnerExpression(token: ts.Node): ts.Expression | undefined {
  if (!ts.isIdentifier(token) && !ts.isStringLiteralLike(token)) return undefined;
  const site = climbWrappers(token) as ts.Expression;
  const parent = site.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) {
    const isMemberKey = ts.isPropertyAccessExpression(parent) ? parent.name === site : parent.argumentExpression === site;
    if (isMemberKey || parent.expression === site) {
      const qualified = climbWrappers(parent) as ts.Expression;
      if (intrinsicOwnerName(qualified) !== undefined) return qualified;
      if (isMemberKey) return undefined;
    }
  }
  return ts.isIdentifier(token) && intrinsicOwnerName(site) !== undefined ? site : undefined;
}

/** `Object`·`Reflect` 표기(bare, `globalThis.X`, `globalThis["X"]`, wrapper 포함)의 이름이다. */
function intrinsicOwnerName(expression: ts.Expression): string | undefined {
  const inner = skipWrappers(expression);
  const member = ts.isIdentifier(inner) ? undefined : staticMember(inner);
  const name = ts.isIdentifier(inner) ? inner.text : member !== undefined && isGlobalThisExpression(member.owner) ? member.name : undefined;
  return name === 'Object' || name === 'Reflect' ? name : undefined;
}

/** site가 단순 이름 변수 선언의 초깃값 전체이면 그 이름이다(`const o = site`, wrapper는 site에 포함). */
function aliasDeclarationName(site: ts.Node): ts.Identifier | undefined {
  const declaration = site.parent;
  return ts.isVariableDeclaration(declaration) && declaration.initializer === site && ts.isIdentifier(declaration.name)
    ? declaration.name : undefined;
}

/**
 * Object/Reflect 소유자 식 또는 그 alias 참조 site의 사용이 mutator 멤버·계산 멤버 접근이거나 mutator를 구조 분해하는지 본다.
 * FlowIndex가 보지 못하는 다른 모듈의 alias 사용도 같은 규칙으로 닫기 위해 소유자와 alias가 공유한다.
 *
 * site는 이미 소유자(또는 소유자 alias)로 알려졌으므로 `set`·계산 멤버도 `intrinsicOwner`로 다시 증명하지 않고 바로 닫는다.
 * 다시 증명하면 깊이 상한에 걸린 긴 alias 사슬에서 이미 아는 사실을 잃는다.
 */
function isDangerousOwnerUse(context: MutationSafetyContext, site: ts.Node): boolean {
  const parent = site.parent;
  if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === site) {
    const member = ts.isPropertyAccessExpression(parent) ? parent.name.text : literalName(parent.argumentExpression);
    return member === undefined || MUTATOR_NAMES.has(member) || mutatorReference(context, parent) !== undefined;
  }
  if (isReflectiveMemberExtraction(context, site) || isTypeErasedOwnerEscape(site) || isMistypedOwnerFlow(context, site)) return true;
  if (!ts.isVariableDeclaration(parent) || parent.initializer !== site || !ts.isObjectBindingPattern(parent.name)) return false;
  return parent.name.elements.some((element) => {
    if (element.dotDotDotToken !== undefined) return true;
    const key = element.propertyName ?? element.name;
    const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
    return name === undefined || MUTATOR_NAMES.has(name);
  });
}

/** 멤버를 이름이나 descriptor로 꺼내는 Object·Reflect 반사 reader다. */
const REFLECTIVE_MEMBER_READERS = new Set(['get', 'getOwnPropertyDescriptor', 'getOwnPropertyDescriptors']);

/**
 * 소유자 식이 반사 reader의 대상 인자로 넘어가 멤버를 꺼내는지 본다(`Reflect.get(Reflect, "set")`,
 * `Object.getOwnPropertyDescriptors(Reflect)`). 비mutator 이름을 literal로 꺼내는 경우만 안전하다.
 */
function isReflectiveMemberExtraction(context: MutationSafetyContext, site: ts.Node): boolean {
  const call = site.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== site) return false;
  const callee = skipWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return false;
  const reader = ts.isPropertyAccessExpression(callee) ? callee.name.text : literalName(callee.argumentExpression);
  if (reader === undefined || !REFLECTIVE_MEMBER_READERS.has(reader) || intrinsicOwner(context, callee.expression) === undefined) return false;
  if (reader === 'getOwnPropertyDescriptors') return true;
  const key = call.arguments[1] === undefined ? undefined : literalName(call.arguments[1]);
  return key === undefined || MUTATOR_NAMES.has(key);
}

/**
 * 소유자 식이 `any`·`unknown` 단언(`Reflect as any`, `<unknown>Object`)을 거쳐 수신자·alias·구조 분해가 아닌 자리로 나가면
 * 타입을 지운 escape로 닫는다. 단언 뒤 다른 타입으로 다시 받으면 타입으로는 소유자를 되찾을 수 없기 때문이다.
 */
function isTypeErasedOwnerEscape(site: ts.Node): boolean {
  let erased = false;
  for (let node: ts.Node = site; ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node); node = node.expression) {
    if ((ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
      && (node.type.kind === ts.SyntaxKind.AnyKeyword || node.type.kind === ts.SyntaxKind.UnknownKeyword)) erased = true;
  }
  if (!erased) return false;
  const parent = site.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === site) return false;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression === site) return false;
  return !ts.isExpressionStatement(parent);
}

/**
 * 소유자 값이 받는 자리의 문맥 타입(대입 대상, 매개변수, 반환 타입 …)에 대입될 수 없으면 타입 오류로 흘러간 것이다. 그 뒤로는
 * 받는 자리 타입으로 소유자를 되찾을 수 없으므로 닫는다. 타입이 맞는 코드에서는 생기지 않는다. 문맥 타입이 `any`·`unknown`이면
 * 그 값을 쓰는 자리의 타입 검사가 닫는다.
 */
function isMistypedOwnerFlow(context: MutationSafetyContext, site: ts.Node): boolean {
  if (!ts.isExpression(site)) return false;
  // 구조 분해 원본의 문맥 타입은 pattern이 만든 모양일 뿐 받는 자리 타입이 아니다(구조 분해 규칙이 따로 본다).
  const parent = site.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.initializer === site && !ts.isIdentifier(parent.name)) return false;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === site
    && (ts.isObjectLiteralExpression(skipWrappers(parent.left)) || ts.isArrayLiteralExpression(skipWrappers(parent.left)))) return false;
  try {
    const contextual = context.checker.getContextualType(site);
    if (contextual === undefined || (contextual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return false;
    return !context.checker.isTypeAssignableTo(context.checker.getTypeAtLocation(skipWrappers(site)), contextual);
  } catch {
    return true;
  }
}

/**
 * token이 속한 direct property/element access다.
 *
 * 문자열 literal 키(`x["defineProperty"]`)는 점 표기(`x.defineProperty`)와 같은 멤버 이름이므로 그 access를 돌려준다.
 */
function accessContainingToken(token: ts.Node): ts.PropertyAccessExpression | ts.ElementAccessExpression | undefined {
  const parent = token.parent;
  if (ts.isPropertyAccessExpression(parent) && (parent.name === token || parent.expression === token)) return parent;
  if (ts.isElementAccessExpression(parent) && parent.expression === token) return parent;
  if (!ts.isStringLiteralLike(token)) return undefined;
  const key = climbWrappers(token);
  return ts.isElementAccessExpression(key.parent) && key.parent.argumentExpression === key ? key.parent : undefined;
}

/**
 * 구조 분해로 떼어 낸 mutator 이름(`const { defineProperty } = x`, `({ set: put } = x)`)을 멤버 읽기처럼 판정한다.
 *
 * 점 표기와 같이 `set` 밖의 mutator 이름은 수신자와 무관하게 닫고, `set`은 구조 분해 원본이 소유자일 수 있을 때만 닫는다.
 * @param context mutation 분석 문맥
 * @param token mutator 이름 candidate token
 * @returns 위험한 구조 분해 멤버이면 true
 */
function isDangerousDestructuredMember(context: MutationSafetyContext, token: ts.Node): boolean {
  if ((!ts.isIdentifier(token) && !ts.isStringLiteralLike(token)) || !MUTATOR_NAMES.has(token.text)) return false;
  const member = destructuredMember(token);
  if (member === undefined) return false;
  return token.text !== 'set' || patternSourceOwner(context, member.pattern) !== undefined;
}

/** token이 객체 구조 분해 pattern의 속성 이름이면 그 pattern이다(binding pattern과 대입 pattern 모두). */
function destructuredMember(token: ts.Identifier | ts.StringLiteralLike): { readonly pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression } | undefined {
  const parent = token.parent;
  if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent)
    && (parent.propertyName === token || (parent.propertyName === undefined && parent.name === token))) return { pattern: parent.parent };
  if ((ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) && parent.name === token
    && ts.isObjectLiteralExpression(parent.parent) && assignmentPatternRoot(parent.parent) !== undefined) return { pattern: parent.parent };
  return undefined;
}

/**
 * 객체·배열 literal이 구조 분해 대입의 대상(`({ a } = x)`, `[{ a }] = x`, `for ({ a } of xs)`)이면 그 바깥 literal이다.
 * @param literal 검사할 literal
 * @returns 대입 대상 pattern의 바깥 literal, 아니면 undefined
 */
function assignmentPatternRoot(literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression): ts.Expression | undefined {
  let current: ts.Node = literal;
  for (;;) {
    const site = climbWrappers(current);
    const parent = site.parent;
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === site) {
      const holder = parent.parent;
      // 구조 분해 안의 기본값(`{ a: { b } = {} }`, `[{ b } = {}]`)이면 바깥 pattern으로 계속 오른다.
      const isDefault = (ts.isPropertyAssignment(holder) && holder.initializer === parent) || ts.isArrayLiteralExpression(holder);
      if (!isDefault) return site as ts.Expression;
      current = parent;
    } else if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === site) {
      return site as ts.Expression;
    } else if (ts.isPropertyAssignment(parent) && parent.initializer === site && ts.isObjectLiteralExpression(parent.parent)) {
      current = parent.parent;
    } else if ((ts.isSpreadAssignment(parent) || ts.isSpreadElement(parent))
      && (ts.isObjectLiteralExpression(parent.parent) || ts.isArrayLiteralExpression(parent.parent))) {
      current = parent.parent;
    } else if (ts.isArrayLiteralExpression(parent)) {
      current = parent;
    } else {
      return undefined;
    }
  }
}

/**
 * 구조 분해 pattern 원본이 Object/Reflect 소유자일 수 있는지 본다.
 *
 * binding pattern은 checker가 원본 타입을 준다. 대입 pattern은 오른쪽 식에서 속성 이름을 따라 내려가고, 따라갈 수 없으면
 * 증명 실패로 닫는다.
 */
function patternSourceOwner(context: MutationSafetyContext, pattern: ts.ObjectBindingPattern | ts.ObjectLiteralExpression): string | undefined {
  if (ts.isObjectBindingPattern(pattern)) {
    const declaration = pattern.parent;
    if (ts.isVariableDeclaration(declaration) && declaration.name === pattern && declaration.initializer !== undefined) {
      return intrinsicOwner(context, declaration.initializer);
    }
    return typedOwnerOfNode(context, pattern);
  }
  const source = assignmentPatternSourceType(context, pattern);
  return source === undefined ? UNPROVEN_OWNER : ownerOfType(context, source);
}

/** 대입 pattern 안의 객체 literal이 받는 값의 타입이다. 오른쪽 식에서 정적 속성 이름으로만 내려간다. */
function assignmentPatternSourceType(context: MutationSafetyContext, literal: ts.ObjectLiteralExpression): ts.Type | undefined {
  const site = climbWrappers(literal);
  const parent = site.parent;
  try {
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === site) {
      return context.checker.getTypeAtLocation(skipWrappers(parent.right));
    }
    if (ts.isPropertyAssignment(parent) && parent.initializer === site && ts.isObjectLiteralExpression(parent.parent)) {
      const name = ts.isIdentifier(parent.name) || ts.isStringLiteralLike(parent.name) ? parent.name.text : undefined;
      const outer = assignmentPatternSourceType(context, parent.parent);
      const property = name === undefined || outer === undefined ? undefined : context.checker.getPropertyOfType(outer, name);
      return property === undefined ? undefined : context.checker.getTypeOfSymbolAtLocation(property, literal);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * 계산 키 읽기(`x[k]`, `const { [k]: v } = x`, `const { ...rest } = x`)의 원본이 소유자일 수 있으면 어떤 method를 떼어 낼지
 * 몰라 닫는다. 원본 표기·alias뿐 아니라 checker 타입으로 본다(`holder.O[k]`, `({}).constructor[k]`).
 */
function hasPossibleOwnerComputedRead(context: MutationSafetyContext, budget: GuardBudget): boolean {
  for (const file of context.index.files) {
    for (const read of computedReadsOf(file)) {
      budget.step();
      const owner = ts.isElementAccessExpression(read) ? intrinsicOwner(context, read.expression)
        : ts.isObjectBindingPattern(read) || ts.isObjectLiteralExpression(read) ? patternSourceOwner(context, read) : undefined;
      if (owner !== undefined) return true;
    }
  }
  return false;
}

/** 파일의 계산 키 읽기 지점을 한 번만 모은다(AST는 바뀌지 않으므로 파일별로 재사용한다). */
const computedReadCache = new WeakMap<ts.SourceFile, readonly ComputedRead[]>();

/** 계산 키 원소 접근, 계산 키·rest가 있는 객체 binding pattern, 계산 키·spread가 있는 객체 대입 pattern이다. */
type ComputedRead = ts.ElementAccessExpression | ts.ObjectBindingPattern | ts.ObjectLiteralExpression;

function computedReadsOf(file: ts.SourceFile): readonly ComputedRead[] {
  const cached = computedReadCache.get(file);
  if (cached !== undefined) return cached;
  const reads: ComputedRead[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node)) {
      const key = skipWrappers(node.argumentExpression);
      if (!ts.isStringLiteralLike(key) && !ts.isNumericLiteral(key)) reads.push(node);
    } else if (ts.isObjectBindingPattern(node)) {
      if (node.elements.some((element) => element.dotDotDotToken !== undefined
        || (element.propertyName !== undefined && ts.isComputedPropertyName(element.propertyName)))) reads.push(node);
    } else if (ts.isObjectLiteralExpression(node) && assignmentPatternRoot(node) !== undefined) {
      if (node.properties.some((property) => ts.isSpreadAssignment(property)
        || (property.name !== undefined && ts.isComputedPropertyName(property.name)))) reads.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  computedReadCache.set(file, reads);
  return reads;
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

/** `intrinsicOwner`가 소유자가 아님을 증명하지 못했을 때 돌려주는 표식이다(호출자는 소유자로 취급한다). */
const UNPROVEN_OWNER = 'unproven';
/** 순수 alias 순환을 만났다는 내부 표식이다. 실행하면 TDZ·undefined·링크 오류라 소유자가 아니다(밖으로 내보내지 않는다). */
const CYCLIC_ALIAS = 'cyclic';
/** alias 초깃값을 따라가는 최대 깊이다(기존 상한과 같다). 넘기면 소유자가 아님을 증명하지 못한 것으로 보고 닫는다. */
const MAX_OWNER_ALIAS_DEPTH = 16;
/** union·제약을 따라 타입을 내려가는 최대 깊이다. 넘기면 증명 실패다. */
const MAX_OWNER_TYPE_DEPTH = 8;

/**
 * Object/Reflect 소유자 표기, 그 변수 alias, 또는 checker 타입상 소유자일 수 있는 식인지 bounded하게 확인한다.
 *
 * 표기는 `intrinsicOwnerName`과 같고, alias는 감싼 초깃값, alias의 alias, import·re-export·namespace 멤버(`ns.o`,
 * `ns["o"]`)를 따라간다. alias로 끝나지 않으면(속성, 반환값, 매개변수, 구조 분해, 조건식 …) checker 타입을 본다
 * (`ownerOfType`). 대입이 있는 `let`·`var` alias는 초깃값만 믿지 않고 사용 자리 타입도 본다. 깊이 상한을 넘기거나
 * checker가 실패하면 증명 실패(`UNPROVEN_OWNER`)로 닫는다. 순수 alias 순환은 소유자가 아니다.
 */
function intrinsicOwner(context: MutationSafetyContext, expression: ts.Expression): string | undefined {
  const owner = resolveOwner(context, expression, 0, new Set<ts.Symbol>());
  return owner === CYCLIC_ALIAS ? undefined : owner;
}

/** `intrinsicOwner`의 재귀 본체다. 순수 alias 순환은 `CYCLIC_ALIAS`로 위에 알린다. */
function resolveOwner(context: MutationSafetyContext, expression: ts.Expression, depth: number, seen: Set<ts.Symbol>): string | undefined {
  const direct = intrinsicOwnerName(expression);
  if (direct !== undefined) return direct;
  const location = aliasLocation(expression);
  if (location !== undefined) {
    if (depth > MAX_OWNER_ALIAS_DEPTH) return UNPROVEN_OWNER;
    const alias = aliasedVariableDeclaration(context, location, seen);
    if (alias === UNPROVEN_OWNER || alias === CYCLIC_ALIAS) return alias;
    if (alias?.declaration.initializer !== undefined) {
      const viaInitializer = resolveOwner(context, alias.declaration.initializer, depth + 1, seen);
      if (!alias.reassigned) return viaInitializer;
      if (viaInitializer !== undefined && viaInitializer !== CYCLIC_ALIAS) return viaInitializer;
    }
  }
  return typedOwnerOfNode(context, skipWrappers(expression));
}

/** 노드의 checker 타입으로 소유자일 수 있는지 본다. checker 실패는 증명 실패다. */
function typedOwnerOfNode(context: MutationSafetyContext, node: ts.Node): string | undefined {
  let type: ts.Type;
  try {
    type = context.checker.getTypeAtLocation(node);
  } catch {
    return UNPROVEN_OWNER;
  }
  return ownerOfType(context, type);
}

/** 소유자일 수 없는 원시·literal·void 계열 타입이다. */
const NON_OWNER_TYPE_FLAGS = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.BooleanLike
  | ts.TypeFlags.EnumLike | ts.TypeFlags.ESSymbolLike | ts.TypeFlags.VoidLike | ts.TypeFlags.Null | ts.TypeFlags.Never;

/**
 * 타입의 값이 Object 생성자나 Reflect namespace일 수 있는지 본다.
 *
 * - 타입 심볼이 default lib에 선언을 가진 `ObjectConstructor`·`Reflect`이면 그 소유자다. 증강
 *   (`reflect-metadata`의 `declare global { namespace Reflect … }`)이 있어도 default lib 선언이 하나라도 있으면 같다.
 * - `any`·`unknown`·제약 없는 타입 매개변수와, 두 소유자 타입이 대입될 수 있는 구조적 상위 타입(`{}`, `object`,
 *   `Function`, `Record<string, unknown>`, 같은 모양의 interface)은 소유자가 아님을 증명하지 못하므로 `UNPROVEN_OWNER`다.
 * - 그 밖의 타입은 소유자가 아니다.
 */
function ownerOfType(context: MutationSafetyContext, type: ts.Type, depth = 0): string | undefined {
  if (depth > MAX_OWNER_TYPE_DEPTH) return UNPROVEN_OWNER;
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return UNPROVEN_OWNER;
  if ((type.flags & NON_OWNER_TYPE_FLAGS) !== 0) return undefined;
  if ((type.flags & ts.TypeFlags.InstantiableNonPrimitive) !== 0) {
    const constraint = context.checker.getBaseConstraintOfType(type);
    return constraint === undefined || constraint === type ? UNPROVEN_OWNER : ownerOfType(context, constraint, depth + 1);
  }
  if (type.isUnion()) {
    let unproven = false;
    for (const part of type.types) {
      const owner = ownerOfType(context, part, depth + 1);
      if (owner === 'Object' || owner === 'Reflect') return owner;
      if (owner !== undefined) unproven = true;
    }
    return unproven ? UNPROVEN_OWNER : undefined;
  }
  const named = libOwnerName(context, type)
    ?? (type.isIntersection() ? type.types.map((part) => libOwnerName(context, part)).find((name) => name !== undefined) : undefined);
  if (named !== undefined) return named;
  const owners = ownerTypes(context);
  if (owners === undefined) return UNPROVEN_OWNER;
  try {
    if (owners.object !== undefined && context.checker.isTypeAssignableTo(owners.object, type)) return UNPROVEN_OWNER;
    if (owners.reflect !== undefined && context.checker.isTypeAssignableTo(owners.reflect, type)) return UNPROVEN_OWNER;
  } catch {
    return UNPROVEN_OWNER;
  }
  return undefined;
}

/** 타입 심볼이 default lib에 선언을 가진 `ObjectConstructor`·`Reflect`이면 소유자 이름이다. */
function libOwnerName(context: MutationSafetyContext, type: ts.Type): string | undefined {
  const symbol = type.getSymbol();
  const name = symbol?.getName();
  if (name !== 'ObjectConstructor' && name !== 'Reflect') return undefined;
  const fromDefaultLibrary = (symbol!.declarations ?? []).some((declaration) => context.isDefaultLibraryFile(declaration.getSourceFile()));
  return !fromDefaultLibrary ? undefined : name === 'ObjectConstructor' ? 'Object' : 'Reflect';
}

/** 구조적 대입 검사에 쓰는 전역 `Object`·`Reflect` 값의 타입이다. */
interface OwnerTypes {
  readonly object: ts.Type | undefined;
  readonly reflect: ts.Type | undefined;
}

/** 문맥마다 한 번만 전역 소유자 타입을 푼다. */
const ownerTypeCache = new WeakMap<MutationSafetyContext, OwnerTypes | null>();

/**
 * 프로그램이 전역 `Object`·`Reflect` 값에 준 타입이다. 대입 검사는 실제 전역 타입과 비교하면 되므로 default lib 판정을 요구하지
 * 않는다(판정 함수가 없는 문맥도 정밀도를 잃지 않는다). 둘 다 없으면(lib 없음) undefined라 호출자가 닫는다.
 */
function ownerTypes(context: MutationSafetyContext): OwnerTypes | undefined {
  const cached = ownerTypeCache.get(context);
  if (cached !== undefined) return cached ?? undefined;
  const resolve = (name: string): ts.Type | undefined => {
    const symbol = context.checker.resolveName(name, undefined, ts.SymbolFlags.Value, false);
    return symbol === undefined ? undefined : context.checker.getTypeOfSymbol(symbol);
  };
  let result: OwnerTypes | null;
  try {
    const object = resolve('Object');
    const reflect = resolve('Reflect');
    result = object === undefined && reflect === undefined ? null : { object, reflect };
  } catch {
    result = null;
  }
  ownerTypeCache.set(context, result);
  return result ?? undefined;
}

/** alias를 가리킬 수 있는 식의 심볼 조회 위치다(식별자, property 이름, 문자열 키). 그 밖의 식은 alias가 아니다. */
function aliasLocation(expression: ts.Expression): ts.Node | undefined {
  const inner = skipWrappers(expression);
  if (ts.isIdentifier(inner)) return inner;
  if (ts.isPropertyAccessExpression(inner)) return inner.name;
  const key = ts.isElementAccessExpression(inner) ? skipWrappers(inner.argumentExpression) : undefined;
  return key !== undefined && isStringLiteralNode(key) ? key : undefined;
}

/** 조회 위치가 가리키는 단일 변수 선언과, 그 변수에 선언 뒤 대입이 있는지다. */
interface AliasDeclaration {
  readonly declaration: ts.VariableDeclaration;
  readonly reassigned: boolean;
}

/**
 * 조회 위치가 가리키는 단일 변수 선언을 import·re-export alias를 풀어 찾는다.
 *
 * checker 실패는 증명 실패다. 이미 지나온 심볼이나 서로를 가리키는 import·re-export는 순수 alias 순환이다. 풀리지 않는
 * import(없는 모듈)는 변수 선언이 아니므로 호출자가 타입(오류 타입은 `any` 계열)으로 판정한다.
 */
function aliasedVariableDeclaration(
  context: MutationSafetyContext,
  location: ts.Node,
  seen: Set<ts.Symbol>,
): AliasDeclaration | typeof UNPROVEN_OWNER | typeof CYCLIC_ALIAS | undefined {
  let symbol: ts.Symbol | undefined;
  try {
    symbol = context.checker.getSymbolAtLocation(location);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      const target = context.checker.getAliasedSymbol(symbol);
      if ((target.declarations?.length ?? 0) === 0) return isCyclicImportAlias(context, symbol) ? CYCLIC_ALIAS : undefined;
      symbol = target;
    }
  } catch {
    return UNPROVEN_OWNER;
  }
  if (symbol === undefined) return undefined;
  if (seen.has(symbol)) return CYCLIC_ALIAS;
  seen.add(symbol);
  const declaration = symbol.declarations?.length === 1 ? symbol.declarations[0] : undefined;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined;
  return { declaration, reassigned: (context.index.identifierWrites.get(symbol)?.length ?? 0) > 0 };
}

/** 선언 없는 대상으로 풀린 import·re-export alias가 서로를 가리키는 순환인지 바로 다음 alias를 따라가 본다. */
function isCyclicImportAlias(context: MutationSafetyContext, symbol: ts.Symbol): boolean {
  const visited = new Set<ts.Symbol>();
  for (let current: ts.Symbol | undefined = symbol; current !== undefined && (current.flags & ts.SymbolFlags.Alias) !== 0;
    current = context.checker.getImmediateAliasedSymbol(current)) {
    if (visited.has(current)) return true;
    visited.add(current);
  }
  return false;
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
