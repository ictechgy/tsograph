/**
 * 파일 하나에서 간선을 모은다(2단계, 모든 노드가 등록된 뒤).
 *
 * 출발 노드는 코드 위치의 스코프 id(`scopeIdOf`)다. 호출·`new`·태그 템플릿·데코레이터·JSX 태그는
 * `TargetResolver.resolveCallee`로, 함수 값 참조(콜백·일반 참조)는 `referenceTargets`로 잇는다.
 * 인라인 콜백(호출 인자로 바로 넘긴 화살표·함수 식)은 담은 노드에서 `contains` 간선으로 잇는다.
 * 잇지 못한 호출은 이유별로 세고 간선을 만들지 않는다. 인터페이스 공백 메서드 호출(`recv.m()`)과
 * 매개변수·간접·계산 호출은 디스패치 단계(`dispatch.ts`)로 넘기고, 노드별 미해석 계수는 그 단계가 모드별로 센다.
 */

import ts from 'typescript';

import { isInlineCallback } from '../schema/inline-callback.ts';
import type {
  CallStatistics,
  EdgeKind,
  GraphStore,
  IndirectSiteKind,
  UnresolvedReason,
} from './graph-model.ts';
import { isFunctionValued, isTypeOnly, skipWrappers } from './node-collector.ts';
import { moduleScopeId, scopeIdOf } from './symbol-ids.ts';
import { isInterfaceGap, type Resolution, type TargetResolver } from './target-resolver.ts';

/** 간선 수집 중 센 공백이다. */
export interface EdgeGaps {
  /** 일부 대상만 이은 호출 수(이유별) */
  readonly partial: Partial<Record<UnresolvedReason, number>>;
  /** bound로 완전히 이은 호출 수(원래 공백 이유별) */
  readonly bound: Partial<Record<UnresolvedReason, number>>;
  /** direct로 일부만 이은 호출을 bound로 보완한 수(원래 공백 이유별) */
  readonly boundPartial: Partial<Record<UnresolvedReason, number>>;
  /** candidate로 이은 호출 수(원래 공백 이유별) */
  readonly candidate: Partial<Record<UnresolvedReason, number>>;
  /** direct로 일부만 이은 호출을 candidate로 보완한 수(원래 공백 이유별) */
  readonly candidatePartial: Partial<Record<UnresolvedReason, number>>;
  /** 하위 클래스가 재정의한 메서드를 기반 타입으로 부른 호출 수 */
  overriddenCalls: number;
}

/**
 * 디스패치 단계로 넘기는 공백 메서드·호출 가능 값 호출이다.
 */
interface PendingDispatchBase {
  /** 대기 종류 */
  readonly kind: 'member' | 'callable';
  /** 호출이 있는 파일의 프로젝트 기준 경로 */
  readonly path: string;
  /** 호출을 감싸는 스코프 노드 id */
  readonly from: string;
  /** 호출식 */
  readonly call: ts.CallExpression;
  /** 직접 해석이 남긴 원래 공백 이유 */
  readonly reason: UnresolvedReason;
}

/** 인터페이스·구조 타입 수신자 메서드의 대기 호출이다. */
export interface PendingMemberDispatch extends PendingDispatchBase {
  readonly kind: 'member';
  /** 수신자 식(래퍼를 벗기지 않은 원래 식) */
  readonly receiver: ts.Expression;
  /** 메서드 이름 */
  readonly method: string;
  /** direct로 이미 이은 대상(union의 구현 부분), 없으면 빈 목록 */
  readonly direct: readonly string[];
}

/** 호출 가능 값을 통해 해석할 수 있는 대기 호출이다. */
export interface PendingCallableDispatch extends PendingDispatchBase {
  readonly kind: 'callable';
  /** direct로 이미 이은 대상(union의 함수 선언 부분), 없으면 빈 목록 */
  readonly direct: readonly string[];
}

/** 디스패치 단계로 넘기는 메서드·호출 가능 값 대기 호출이다. */
export type PendingDispatch = PendingMemberDispatch | PendingCallableDispatch;

/** 간선 수집 문맥이다. */
export interface EdgeContext {
  readonly checker: ts.TypeChecker;
  readonly store: GraphStore;
  readonly resolver: TargetResolver;
  /** 기반 메서드 id → 재정의한 메서드 id */
  readonly overrides: ReadonlyMap<string, readonly string[]>;
  readonly calls: CallStatistics;
  readonly gaps: EdgeGaps;
  /** 디스패치 단계로 넘긴 호출(갱신) */
  readonly pending: PendingDispatch[];
}

/**
 * 파일의 간선을 모은다.
 *
 * @param context 수집 문맥
 * @param path 프로젝트 기준 경로
 * @param sourceFile 파일
 */
export function collectFileEdges(context: EdgeContext, path: string, sourceFile: ts.SourceFile): void {
  addModuleInitializerEdges(context.store, path, sourceFile);
  const visit = (node: ts.Node): void => {
    if (isTypeOnly(node) || ts.isExportDeclaration(node)) return;
    visitNode(context, path, node);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
}

/**
 * 모듈 스코프에서 모듈을 불러올 때 실행되는 최상위 초기값(함수 값이 아닌 변수, `export default` 식)으로
 * `initializer` 간선을 잇는다.
 *
 * @param store 그래프 저장소
 * @param path 프로젝트 기준 경로
 * @param sourceFile 파일
 */
function addModuleInitializerEdges(store: GraphStore, path: string, sourceFile: ts.SourceFile): void {
  const module = moduleScopeId(path);
  for (const statement of sourceFile.statements) {
    const initializers = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations.flatMap((declaration) => (declaration.initializer === undefined ? [] : [declaration.initializer]))
      : ts.isExportAssignment(statement) && statement.isExportEquals !== true ? [statement.expression] : [];
    for (const initializer of initializers.filter((expression) => !isFunctionValued(expression))) {
      const id = scopeIdOf(initializer, path);
      if (id !== module && store.hasNode(id)) store.addEdge(module, id, 'initializer');
    }
  }
}

/**
 * 노드 하나에서 간선을 만든다.
 *
 * @param context 수집 문맥
 * @param path 프로젝트 기준 경로
 * @param node 노드
 */
function visitNode(context: EdgeContext, path: string, node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    visitCall(context, path, node);
  } else if (ts.isNewExpression(node)) {
    recordCall(context, path, node, context.resolver.resolveCallee(node.expression), 'new');
  } else if (ts.isTaggedTemplateExpression(node)) {
    recordCall(context, path, node, context.resolver.resolveCallee(node.tag), 'call');
  } else if (ts.isDecorator(node) && !ts.isCallExpression(node.expression)) {
    recordCall(context, path, node, context.resolver.resolveCallee(node.expression), 'call');
  } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    visitJsxTag(context, path, node);
  } else if (isInlineCallback(node)) {
    addContainsEdge(context.store, path, node);
  } else {
    visitReference(context, path, node);
  }
}

/**
 * 호출식을 처리한다. `super(...)`는 기반 클래스 생성자, `import(...)` 자체는 호출이 아니다.
 *
 * @param context 수집 문맥
 * @param path 프로젝트 기준 경로
 * @param call 호출식
 */
function visitCall(context: EdgeContext, path: string, call: ts.CallExpression): void {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) return;
  if (call.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const base = baseClassExpression(call);
    if (base !== undefined) recordCall(context, path, call, context.resolver.resolveCallee(base), 'call');
    return;
  }
  const resolution = context.resolver.resolveCallee(call.expression);
  const pending = isDecoratorCall(call) ? undefined : isInterfaceGap(resolution)
    ? memberDispatchSite(context.store, path, call, resolution)
    : isCallableGap(resolution) ? callableDispatchSite(context.store, path, call, resolution) : undefined;
  if (pending !== undefined) context.pending.push(pending);
  recordCall(context, path, call, resolution, 'call', pending !== undefined);
  countOverriddenCall(context, call.expression, resolution);
}

/**
 * 인라인 콜백을 담은 노드에서 콜백 노드로 `contains` 간선을 잇는다. 계산된 이름이 끼어 콜백이 자기 id를 얻지 못하면
 * (담은 노드와 같은 id) 잇지 않는다.
 *
 * @param store 그래프 저장소
 * @param path 프로젝트 기준 경로
 * @param callback 인라인 콜백
 */
function addContainsEdge(store: GraphStore, path: string, callback: ts.ArrowFunction | ts.FunctionExpression): void {
  const inner = ensureScope(store, path, callback.body);
  const owner = ensureScope(store, path, callback);
  if (owner !== inner) store.addEdge(owner, inner, 'contains');
}

/**
 * 인터페이스 공백 호출이 수신자 있는 메서드 호출(`recv.m()`, `recv["m"]()`)이면 메서드 대기 항목을 만든다.
 *
 * @param store 그래프 저장소
 * @param path 프로젝트 기준 경로
 * @param call 호출식
 * @param resolution direct 해석 결과
 * @returns 대기 항목, 메서드 호출이 아니면 undefined
 */
function memberDispatchSite(store: GraphStore, path: string, call: ts.CallExpression, resolution: Resolution): PendingMemberDispatch | undefined {
  const callee = skipWrappers(call.expression);
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return undefined;
  const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
    : ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : undefined;
  if (method === undefined || callee.expression.kind === ts.SyntaxKind.SuperKeyword) return undefined;
  const receiver = callee.expression;
  const direct = resolution.kind === 'nodes' ? resolution.ids : [];
  return { kind: 'member', path, from: ensureScope(store, path, call), call, reason: 'interface', receiver, method, direct };
}

/** 매개변수·간접·계산 호출을 callable 값 흐름으로 넘길지 본다. */
function isCallableGap(resolution: Resolution): boolean {
  const reason = resolution.kind === 'unresolved' ? resolution.reason : resolution.kind === 'nodes' ? resolution.partial : undefined;
  return reason === 'parameter' || reason === 'indirect' || reason === 'computed';
}

/** 호출 가능 값 흐름으로 해석할 대기 호출을 만든다. */
function callableDispatchSite(store: GraphStore, path: string, call: ts.CallExpression, resolution: Resolution): PendingCallableDispatch | undefined {
  const reason = resolution.kind === 'unresolved' ? resolution.reason : resolution.kind === 'nodes' ? resolution.partial : undefined;
  if (reason !== 'parameter' && reason !== 'indirect' && reason !== 'computed') return undefined;
  const direct = resolution.kind === 'nodes' ? resolution.ids : [];
  return { kind: 'callable', path, from: ensureScope(store, path, call), call, reason, direct };
}

/** 데코레이터 표현식 안의 호출은 일반 callable 디스패치로 넘기지 않는다. */
function isDecoratorCall(call: ts.CallExpression): boolean {
  for (let current: ts.Node | undefined = call.parent; current !== undefined; current = current.parent) {
    if (ts.isDecorator(current)) return true;
    if (ts.isFunctionLike(current) || ts.isClassLike(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

/**
 * JSX 태그가 컴포넌트(대문자 식별자·속성 접근)면 `jsx` 간선을 잇는다. 소문자 내장 태그는 건너뛴다.
 *
 * @param context 수집 문맥
 * @param path 프로젝트 기준 경로
 * @param element JSX 여는 태그·자기 닫힘 태그
 */
function visitJsxTag(context: EdgeContext, path: string, element: ts.JsxOpeningElement | ts.JsxSelfClosingElement): void {
  const tag = element.tagName;
  const isComponent = ts.isPropertyAccessExpression(tag) || (ts.isIdentifier(tag) && /^[A-Z_$]/u.test(tag.text));
  if (isComponent) recordCall(context, path, element, context.resolver.resolveCallee(tag as ts.Expression), 'jsx');
}

/**
 * 함수 값 참조(식별자·속성 접근·축약 속성)를 처리한다.
 *
 * @param context 수집 문맥
 * @param path 프로젝트 기준 경로
 * @param node 노드
 */
function visitReference(context: EdgeContext, path: string, node: ts.Node): void {
  let symbol: ts.Symbol | undefined;
  if (ts.isShorthandPropertyAssignment(node)) {
    symbol = context.checker.getShorthandAssignmentValueSymbol(node);
  } else if (ts.isIdentifier(node) && isValueIdentifier(node)) {
    symbol = context.checker.getSymbolAtLocation(node);
  } else if (ts.isPropertyAccessExpression(node) && isReferencePosition(node)) {
    symbol = context.checker.getSymbolAtLocation(node.name);
  } else {
    return;
  }
  const targets = context.resolver.referenceTargets(symbol);
  if (targets.length === 0) return;
  const from = ensureScope(context.store, path, node);
  const kind = isArgument(node) ? 'callback' : 'reference';
  for (const target of targets) context.store.addEdge(from, target, kind);
}

/**
 * 호출 해석 결과를 간선·통계로 옮긴다.
 *
 * @param context 수집 문맥
 * @param path 프로젝트 기준 경로
 * @param site 호출 위치
 * @param resolution 해석 결과
 * @param kind 간선 종류
 * @param deferred 디스패치 단계가 노드별 미해석 계수를 셀 호출이면 true
 */
function recordCall(context: EdgeContext, path: string, site: ts.Node, resolution: Resolution, kind: EdgeKind, deferred = false): void {
  const isGap = resolution.kind === 'unresolved' || (resolution.kind === 'nodes' && resolution.partial !== undefined);
  if (isGap && !deferred) context.store.countUnresolved(ensureScope(context.store, path, site), undefined);
  if (resolution.kind === 'external') {
    context.calls.external++;
    if (resolution.missing === true) context.calls.missingDependencies++;
  } else if (resolution.kind === 'unresolved') {
    context.calls.unresolved[resolution.reason]++;
    if (resolution.reason === 'indirect') countIndirectSite(context.calls, site);
  } else {
    context.calls.resolved++;
    if (resolution.partial !== undefined) context.gaps.partial[resolution.partial] = (context.gaps.partial[resolution.partial] ?? 0) + 1;
    const from = ensureScope(context.store, path, site);
    for (const id of resolution.ids) context.store.addEdge(from, id, kind);
  }
}

/** fully unresolved indirect 호출을 callee AST 모양 하나로 센다. */
function countIndirectSite(calls: CallStatistics, site: ts.Node): void {
  const kind = indirectSiteKind(site);
  const sites = calls.indirectSites ??= {};
  sites[kind] = (sites[kind] ?? 0) + 1;
}

/** 해석 결과나 이름을 보지 않고 호출 위치에 실제로 적힌 callee 모양만 분류한다. */
function indirectSiteKind(site: ts.Node): IndirectSiteKind {
  const expression = ts.isCallExpression(site) || ts.isNewExpression(site) ? site.expression
    : ts.isTaggedTemplateExpression(site) ? site.tag
      : ts.isDecorator(site) ? site.expression
        : ts.isJsxOpeningElement(site) || ts.isJsxSelfClosingElement(site) ? site.tagName
          : undefined;
  if (expression === undefined) return 'other';
  const callee = skipWrappers(expression as ts.Expression);
  if (ts.isIdentifier(callee)) return 'identifier';
  if (ts.isPropertyAccessExpression(callee)) return 'property';
  return ts.isElementAccessExpression(callee) ? 'element' : 'other';
}

/**
 * 기반 타입으로 부른 메서드를 하위 클래스가 재정의했으면 센다(재정의는 증명하지 못해 잇지 않는다).
 *
 * @param context 수집 문맥
 * @param callee 호출 대상 식
 * @param resolution 해석 결과
 */
function countOverriddenCall(context: EdgeContext, callee: ts.Expression, resolution: Resolution): void {
  const inner = skipWrappers(callee);
  if (resolution.kind !== 'nodes' || !ts.isPropertyAccessExpression(inner)) return;
  if (inner.expression.kind === ts.SyntaxKind.SuperKeyword) return;
  if (resolution.ids.some((id) => context.overrides.has(id))) context.gaps.overriddenCalls++;
}

/**
 * 위치의 스코프 id를 구하고, 없는 노드면 등록한다(1단계 경계 규칙이 놓친 경우의 안전장치).
 *
 * @param store 그래프 저장소
 * @param path 프로젝트 기준 경로
 * @param node 코드 노드
 * @returns 스코프 id
 */
function ensureScope(store: GraphStore, path: string, node: ts.Node): string {
  const id = scopeIdOf(node, path);
  store.addNode(id, 'variable', path, node);
  return id;
}

/**
 * `super(...)`를 감싼 클래스의 `extends` 식이다.
 *
 * @param call super 호출
 * @returns 기반 클래스 식 또는 undefined
 */
function baseClassExpression(call: ts.CallExpression): ts.Expression | undefined {
  const owner = ts.findAncestor(call, ts.isClassLike);
  const clause = owner?.heritageClauses?.find((heritage) => heritage.token === ts.SyntaxKind.ExtendsKeyword);
  return clause?.types[0]?.expression;
}

/**
 * 식별자가 값 참조 위치인지 본다. 선언 이름·호출 대상·속성 이름·JSX 태그·대입 왼쪽은 아니다.
 *
 * @param identifier 식별자
 * @returns 값 참조면 true
 */
function isValueIdentifier(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (isNamePosition(identifier, parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (ts.isQualifiedName(parent) || ts.isShorthandPropertyAssignment(parent)) return false;
  return isReferencePosition(identifier);
}

/**
 * 식이 호출 대상·JSX 태그·대입 왼쪽이 아닌 참조 위치인지 본다.
 *
 * @param expression 식별자·속성 접근
 * @returns 참조 위치면 true
 */
function isReferencePosition(expression: ts.Expression): boolean {
  const parent = expression.parent;
  if ((ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isDecorator(parent)) && parent.expression === expression) return false;
  if (ts.isTaggedTemplateExpression(parent) && parent.tag === expression) return false;
  if ((ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) && parent.tagName === expression) return false;
  return !(ts.isBinaryExpression(parent) && parent.left === expression && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
}

/**
 * 식별자가 선언·import/export·레이블의 이름 자리인지 본다.
 *
 * @param identifier 식별자
 * @param parent 부모
 * @returns 이름 자리면 true
 */
function isNamePosition(identifier: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
    || ts.isNamespaceExport(parent) || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)
    || ts.isMetaProperty(parent)) {
    return true;
  }
  // 속성 접근·축약 속성은 호출자가 먼저 걸렀으므로, 남은 `name` 자리는 선언·JSX 속성 이름이다.
  return (parent as { name?: ts.Node }).name === identifier;
}

/**
 * 값을 바꾸지 않는 부모 래퍼(괄호·`as`·`satisfies`·non-null)를 위로 벗긴다.
 *
 * @param node 식
 * @returns 가장 바깥 래퍼(없으면 식 자신)
 */
function unwrapValueParents(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
    || ts.isNonNullExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}

/**
 * 식이 (래퍼를 벗겨) 호출·`new`의 인자(전개 원소 포함)인지 본다.
 *
 * @param node 식
 * @returns 인자면 true
 */
function isArgument(node: ts.Node): boolean {
  let current = unwrapValueParents(node);
  // `emit(...handlers)`·`emit(...[a, b])`의 전개 원소도 인자로 넘긴 값이다.
  if (ts.isArrayLiteralExpression(current.parent) && ts.isSpreadElement(current.parent.parent)) current = current.parent;
  if (ts.isSpreadElement(current.parent)) current = current.parent;
  const parent = current.parent;
  if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) return false;
  const argumentsList: readonly ts.Node[] = parent.arguments ?? [];
  return argumentsList.includes(current);
}
