/**
 * TypeChecker로 식별자·import를 선언까지 따라가는 도우미다.
 *
 * 의존성 패키지의 타입 선언이 없어도(`node_modules` 미설치) 동작해야 하므로, 패키지 import는 `getAliasedSymbol`로
 * 풀지 않고 import 선언의 모듈 지정자와 가져온 이름만 본다(`packageBindingOf`). 프로젝트 안의 import·재수출·
 * 기본 내보내기는 `getAliasedSymbol`로 선언까지 간다.
 */

import ts from 'typescript';

/** 패키지에서 가져온 이름이다(`import express from 'express'` → `{module: 'express', name: 'default'}`). */
export interface PackageBinding {
  readonly module: string;
  /** `default`, `*`(네임스페이스·CommonJS 전체), 또는 가져온 이름 */
  readonly name: string;
}

/**
 * 식을 감싼 괄호·타입 단언·`satisfies`·non-null·`await`를 벗긴다.
 *
 * @param expression 식
 * @returns 벗긴 식
 */
export function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current) || ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * 노드의 심볼을 얻는다. 없으면 undefined다.
 *
 * @param checker TypeChecker
 * @param node 식별자 등
 * @returns 심볼
 */
export function symbolAt(checker: ts.TypeChecker, node: ts.Node): ts.Symbol | undefined {
  try {
    return checker.getSymbolAtLocation(node);
  } catch {
    // 구문 오류가 있는 파일에서 checker가 던지는 경우는 해석하지 못한 것으로 본다.
    return undefined;
  }
}

/**
 * 별칭(import·재수출)을 끝까지 따라간다. 풀 수 없으면 원래 심볼이다.
 *
 * @param checker TypeChecker
 * @param symbol 심볼
 * @returns 풀린 심볼
 */
export function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  try {
    const target = checker.getAliasedSymbol(symbol);
    return target.declarations === undefined || target.declarations.length === 0 ? symbol : target;
  } catch {
    // 모듈을 찾지 못한 import는 별칭 그대로 둔다(호출자가 패키지 바인딩으로 본다).
    return symbol;
  }
}

/**
 * 식별자가 가리키는 첫 선언을 얻는다(별칭을 푼 뒤).
 *
 * @param checker TypeChecker
 * @param identifier 식별자
 * @returns 선언 또는 undefined
 */
export function declarationOf(checker: ts.TypeChecker, identifier: ts.Node): ts.Declaration | undefined {
  const symbol = symbolAt(checker, identifier);
  if (symbol === undefined) return undefined;
  const resolved = resolveAlias(checker, symbol);
  return resolved.valueDeclaration ?? resolved.declarations?.[0];
}

/**
 * 식별자·속성 접근이 패키지에서 가져온 이름인지 본다. `import`·`import =`·`require` 세 형태를 받는다. 상대·절대 경로
 * 모듈(프로젝트 파일)은 패키지가 아니라서 undefined다.
 *
 * @param checker TypeChecker
 * @param expression 식별자 또는 `ns.member`
 * @returns 패키지 바인딩 또는 undefined
 */
export function packageBindingOf(checker: ts.TypeChecker, expression: ts.Expression): PackageBinding | undefined {
  const binding = anyModuleBinding(checker, expression);
  return binding !== undefined && isPackageSpecifier(binding.module) ? binding : undefined;
}

/**
 * 식별자·속성 접근이 가져온 모듈과 이름이다(프로젝트 모듈 포함).
 *
 * @param checker TypeChecker
 * @param expression 식별자 또는 `ns.member`
 * @returns 바인딩 또는 undefined
 */
function anyModuleBinding(checker: ts.TypeChecker, expression: ts.Expression): PackageBinding | undefined {
  const node = unwrap(expression);
  if (ts.isPropertyAccessExpression(node)) {
    const base = anyModuleBinding(checker, node.expression);
    if (base === undefined) return undefined;
    return base.name === '*' || base.name === 'default' ? { module: base.module, name: node.name.text } : undefined;
  }
  if (ts.isCallExpression(node)) return requireBinding(node);
  if (!ts.isIdentifier(node)) return undefined;
  const symbol = symbolAt(checker, node);
  const declaration = symbol?.declarations?.[0];
  return declaration === undefined ? undefined : bindingOfDeclaration(declaration);
}

/**
 * import·require 선언에서 패키지 바인딩을 만든다.
 *
 * @param declaration 선언
 * @returns 바인딩 또는 undefined
 */
function bindingOfDeclaration(declaration: ts.Declaration): PackageBinding | undefined {
  if (ts.isImportSpecifier(declaration)) {
    const module = moduleText(declaration.parent.parent.parent.moduleSpecifier);
    return module === undefined ? undefined : { module, name: (declaration.propertyName ?? declaration.name).text };
  }
  if (ts.isImportClause(declaration)) {
    const module = moduleText(declaration.parent.moduleSpecifier);
    return module === undefined ? undefined : { module, name: 'default' };
  }
  if (ts.isNamespaceImport(declaration)) {
    const module = moduleText(declaration.parent.parent.moduleSpecifier);
    return module === undefined ? undefined : { module, name: '*' };
  }
  if (ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference)) {
    const module = moduleText(declaration.moduleReference.expression);
    return module === undefined ? undefined : { module, name: '*' };
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return variableBinding(declaration);
  if (ts.isBindingElement(declaration)) return destructuredBinding(declaration);
  return undefined;
}

/**
 * `const x = require('m')`·`const x = require('m').y`의 바인딩이다.
 *
 * @param declaration 변수 선언
 * @returns 바인딩 또는 undefined
 */
function variableBinding(declaration: ts.VariableDeclaration): PackageBinding | undefined {
  if (!ts.isIdentifier(declaration.name)) return undefined;
  const initializer = unwrap(declaration.initializer!);
  if (ts.isCallExpression(initializer)) return requireBinding(initializer);
  if (ts.isPropertyAccessExpression(initializer) && ts.isCallExpression(unwrap(initializer.expression))) {
    const base = requireBinding(unwrap(initializer.expression) as ts.CallExpression);
    return base === undefined ? undefined : { module: base.module, name: initializer.name.text };
  }
  return undefined;
}

/**
 * `const { Router } = require('express')`의 바인딩이다.
 *
 * @param element 구조 분해 원소
 * @returns 바인딩 또는 undefined
 */
function destructuredBinding(element: ts.BindingElement): PackageBinding | undefined {
  const pattern = element.parent;
  if (!ts.isObjectBindingPattern(pattern) || !ts.isVariableDeclaration(pattern.parent) || pattern.parent.initializer === undefined) return undefined;
  const initializer = unwrap(pattern.parent.initializer);
  const base = ts.isCallExpression(initializer) ? requireBinding(initializer) : undefined;
  const property = element.propertyName ?? element.name;
  if (base === undefined || !ts.isIdentifier(property)) return undefined;
  return { module: base.module, name: property.text };
}

/**
 * `require('m')` 호출이면 `{module: 'm', name: '*'}`다.
 *
 * @param call 호출 식
 * @returns 바인딩 또는 undefined
 */
export function requireBinding(call: ts.CallExpression): PackageBinding | undefined {
  if (!ts.isIdentifier(call.expression) || call.expression.text !== 'require' || call.arguments.length !== 1) return undefined;
  const module = moduleText(call.arguments[0]!);
  return module === undefined ? undefined : { module, name: '*' };
}

/**
 * 모듈 지정자 문자열을 얻는다.
 *
 * @param node 지정자 식
 * @returns 문자열 또는 undefined
 */
function moduleText(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined;
}

/**
 * 모듈 지정자가 패키지(상대·절대 경로가 아닌 것)인지 본다.
 *
 * @param module 모듈 지정자
 * @returns 패키지면 true
 */
function isPackageSpecifier(module: string): boolean {
  return !module.startsWith('.') && !module.startsWith('/');
}

/**
 * 호출·new 식이 패키지의 특정 이름을 부르는지 본다(`express()`, `new Hono()`, `express.Router()`).
 *
 * @param checker TypeChecker
 * @param callee 호출 대상 식
 * @param modules 패키지 이름 목록
 * @param names 가져온 이름 목록(`default`·`*` 포함 가능)
 * @returns 맞으면 그 바인딩
 */
export function calleeFromPackage(checker: ts.TypeChecker, callee: ts.Expression, modules: readonly string[], names: readonly string[]): PackageBinding | undefined {
  const binding = packageBindingOf(checker, callee);
  return binding !== undefined && modules.includes(binding.module) && names.includes(binding.name) ? binding : undefined;
}

/**
 * 노드를 감싼 가장 가까운 함수형 선언(함수·메서드·화살표·접근자)을 찾는다.
 *
 * @param node 노드
 * @returns 함수형 선언 또는 undefined(모듈 최상위)
 */
export function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

/**
 * 라우터·앱 값의 타입에 있는 속성 이름이다. Express `Router`·`Application`은 `route`·`stack`, @koa/router `routes()`의
 * 반환 타입(`RouterComposedMiddleware`)은 `router`, 라우터 자체는 `routes`를 가진다. 일반 미들웨어 함수 타입에는 없다.
 */
const ROUTER_TYPE_MARKERS = ['route', 'routes', 'router', 'stack'] as const;

/**
 * 풀지 못한 `use()` 인자가 라우터(그래서 라우트)를 담을 수 있는지 타입으로 가늠한다. 타입을 모르면(`any`·`unknown`,
 * 해석 실패, 펼침 인자) 담을 수 있다고 본다 — 라우트가 조용히 빠지는 것보다 한계로 알리는 편이 안전하기 때문이다.
 *
 * @param checker TypeChecker
 * @param expression 인자 식
 * @returns 라우터일 수 있으면 true
 */
export function mayCarryRoutes(checker: ts.TypeChecker, expression: ts.Expression): boolean {
  if (ts.isSpreadElement(expression)) return true;
  const type = checker.getTypeAtLocation(expression);
  const parts = type.isUnion() || type.isIntersection() ? type.types : [type];
  return parts.some((part) => (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0 || ROUTER_TYPE_MARKERS.some((name) => part.getProperty(name) !== undefined));
}
