/**
 * Next 16.2.7 `unstable_cache`의 실행 위임만 제한적으로 모델링한다.
 *
 * 이 모듈은 wrapper 자체를 함수 값으로 만들지 않는다. 호출 가능 공백의 callee가
 * SDK factory 호출임을 증명한 경우에만 첫 callback 식을 돌려주고, 반환 값·인자는
 * `ValueFlow`에 전달하지 않는다.
 */

import { readFileSync, statSync } from 'node:fs';

import ts from 'typescript';

import type { FlowIndex } from './flow-index.ts';
import { skipWrappers } from './node-collector.ts';

/** 모델이 인정하는 Next SDK 버전이다. */
const NEXT_PACKAGE_NAME = 'next';
const NEXT_PACKAGE_VERSION = '16.2.7';
/** package.json은 필요한 메타데이터만 읽으므로 크기를 작게 제한한다. */
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
/** 순환·긴 const alias를 추측 없이 끊는 상한이다. */
const MAX_ALIAS_DEPTH = 16;

/** 디스패치가 Next cache 모델에 넘기는 프로그램별 문맥이다. */
export interface NextCacheModelContext {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** 프로젝트 노드 파일을 SDK declaration과 분리하는 기존 path map이다. */
  readonly pathByFile: ReadonlyMap<ts.SourceFile, string>;
  /** 테스트 분리 전 전체 프로젝트 노드 파일 map이다. */
  readonly allPathByFile: ReadonlyMap<ts.SourceFile, string>;
  /** 이미 만들어진 해당 분석 범위의 값 흐름 색인이다. */
  readonly index: Pick<FlowIndex, 'identifierWrites' | 'propertyWrites' | 'reflectiveTargets' | 'openModules' | 'hasOpaqueImport'>;
  /** 공개 패키지·불완전 스캔이면 모델을 끈다. */
  readonly openProgram: boolean;
}

/** import·package 메타데이터를 프로그램 수명 안에서만 보관한다. */
interface ModelCache {
  readonly manifests: Map<string, PackageManifest | undefined>;
  readonly mutations: WeakMap<object, Map<ts.Symbol, MutationState>>;
  readonly aliases: WeakMap<object, Map<ts.Symbol, ReadonlySet<ts.Symbol> | undefined>>;
}

/** 한 분석 범위·심볼의 쓰기 판정 캐시다. */
interface MutationState {
  readonly writes: boolean;
  readonly reflective: boolean;
}

/** 읽은 package.json의 최소 안전 표면이다. */
interface PackageManifest {
  readonly name: string;
  readonly version: string;
}

const programCaches = new WeakMap<ts.Program, ModelCache>();

/**
 * Next cache wrapper의 callback 식을 구한다.
 *
 * `expression`은 대기 중인 호출의 callee이고, `invocation`은 그 callee를 실제로
 * 부르는 바깥 호출이다. 직접 factory 호출과 immutable const alias만 허용한다.
 *
 * @param expression 대기 호출의 callee
 * @param context 프로그램·checker·기존 흐름 색인
 * @param invocation 선택한 바깥 호출(옵션 호출·전개 인자 거부에 필요)
 * @returns 증명된 첫 callback 식, 아니면 undefined
 */
export function delegateCallbackExpression(
  expression: ts.Expression,
  context: NextCacheModelContext,
  invocation?: ts.CallExpression,
): ts.Expression | undefined {
  if (context.openProgram || context.index.hasOpaqueImport) return undefined;
  if (invocation?.questionDotToken !== undefined || invocation?.arguments.some(ts.isSpreadElement)) return undefined;
  const cache = cacheFor(context.program);
  return resolveWrapper(expression, context, cache, new Set<ts.Symbol>(), 0);
}

/**
 * callee가 Next cache wrapper 모양인지 본다. provenance를 증명하지 못한 경우에도
 * 일반 `ValueFlow`가 wrapper를 원 callback으로 잘못 축약하지 않도록 dispatch가 쓸
 * 보수적 차단 표식이다.
 */
export function isNextCacheWrapperExpression(expression: ts.Expression, context: NextCacheModelContext): boolean {
  const cache = cacheFor(context.program);
  return potentialWrapper(expression, context, cache, new Set<ts.Symbol>(), 0);
}

function potentialWrapper(
  expression: ts.Expression,
  context: NextCacheModelContext,
  cache: ModelCache,
  seen: Set<ts.Symbol>,
  depth: number,
): boolean {
  if (depth > MAX_ALIAS_DEPTH) return false;
  const inner = skipWrappers(expression);
  if (ts.isCallExpression(inner)) return potentialFactory(inner.expression, context, cache);
  if (!ts.isIdentifier(inner)) return false;
  if (isInstalledNamedFactoryIdentifier(inner, context, cache) || isInstalledNamespaceFactoryReceiver(inner, context, cache)) return true;
  const symbol = canonicalSymbol(context.checker, context.checker.getSymbolAtLocation(inner));
  if (symbol === undefined || seen.has(symbol)) return false;
  const declarations = symbol.declarations ?? [];
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined) return false;
  if ((declaration.parent.flags & ts.NodeFlags.Const) === 0) return false;
  seen.add(symbol);
  try {
    return potentialWrapper(declaration.initializer, context, cache, seen, depth + 1);
  } finally {
    seen.delete(symbol);
  }
}

function potentialFactory(expression: ts.Expression, context: NextCacheModelContext, cache: ModelCache): boolean {
  const callee = skipWrappers(expression);
  if (ts.isIdentifier(callee)) return isInstalledNamedFactoryIdentifier(callee, context, cache);
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    const argument = ts.isElementAccessExpression(callee) ? skipWrappers(callee.argumentExpression) : undefined;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
      : argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
    const receiver = skipWrappers(callee.expression);
    return name === 'unstable_cache' && ts.isIdentifier(receiver)
      && isInstalledNamespaceFactoryReceiver(receiver, context, cache);
  }
  return false;
}

/** package version과 무관하게 실제 node_modules/next declaration인지 본다. */
function isInstalledNextSource(sourceFile: ts.SourceFile, context: NextCacheModelContext, cache: ModelCache): boolean {
  if (context.pathByFile.has(sourceFile)) return false;
  const root = nextPackageRoot(sourceFile.fileName);
  return root !== undefined && packageManifest(root, cache)?.name === NEXT_PACKAGE_NAME;
}

/** 활성 선언 중 하나라도 설치된 Next package source인지 본다(augmentation은 delegate가 reject한다). */
function hasInstalledNextDeclaration(symbol: ts.Symbol, context: NextCacheModelContext, cache: ModelCache): boolean {
  const declarations = activeDeclarations(symbol, context);
  return declarations.some((declaration) => isInstalledNextSource(declaration.getSourceFile(), context, cache));
}

/** production view에서 제외한 test declaration만 안전하게 무시한다. */
function activeDeclarations(symbol: ts.Symbol, context: NextCacheModelContext): readonly ts.Declaration[] {
  return (symbol.declarations ?? []).filter((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return !context.allPathByFile.has(sourceFile) || context.pathByFile.has(sourceFile);
  });
}

/** exact next/cache named import가 설치된 Next declaration으로 풀리는지 본다. */
function isInstalledNamedFactoryIdentifier(
  identifier: ts.Identifier,
  context: NextCacheModelContext,
  cache: ModelCache,
): boolean {
  const checker = context.checker;
  const local = checker.getSymbolAtLocation(identifier);
  const declaration = uniqueDeclaration(local, ts.isImportSpecifier);
  if (declaration === undefined || (declaration.propertyName?.text ?? declaration.name.text) !== 'unstable_cache'
    || !ts.isImportDeclaration(declaration.parent.parent.parent)
    || !isNextCacheSpecifier(declaration.parent.parent.parent.moduleSpecifier)) return false;
  const target = canonicalSymbol(checker, local);
  return target !== undefined && hasInstalledNextDeclaration(target, context, cache);
}

/** exact next/cache NamespaceImport가 설치된 Next module declaration으로 풀리는지 본다. */
function isInstalledNamespaceFactoryReceiver(
  identifier: ts.Identifier,
  context: NextCacheModelContext,
  cache: ModelCache,
): boolean {
  const checker = context.checker;
  const local = checker.getSymbolAtLocation(identifier);
  const declaration = uniqueDeclaration(local, ts.isNamespaceImport);
  if (declaration === undefined || !ts.isImportDeclaration(declaration.parent.parent)
    || !isNextCacheSpecifier(declaration.parent.parent.moduleSpecifier)) return false;
  const module = canonicalSymbol(checker, local);
  return module !== undefined && hasInstalledNextDeclaration(module, context, cache);
}

/** 프로그램에 귀속한 bounded metadata cache다. */
function cacheFor(program: ts.Program): ModelCache {
  const existing = programCaches.get(program);
  if (existing !== undefined) return existing;
  const created: ModelCache = { manifests: new Map(), mutations: new WeakMap(), aliases: new WeakMap() };
  programCaches.set(program, created);
  return created;
}

/** wrapper callee에서 callback을 찾는다. */
function resolveWrapper(
  expression: ts.Expression,
  context: NextCacheModelContext,
  cache: ModelCache,
  aliases: Set<ts.Symbol>,
  depth: number,
): ts.Expression | undefined {
  if (depth > MAX_ALIAS_DEPTH) return undefined;
  const inner = skipWrappers(expression);
  if (ts.isCallExpression(inner)) return callbackFromFactory(inner, context, cache);
  if (!ts.isIdentifier(inner)) return undefined;

  const symbol = canonicalSymbol(context.checker, context.checker.getSymbolAtLocation(inner));
  if (symbol === undefined || aliases.has(symbol) || hasWrites(symbol, context, cache)) return undefined;
  if (depth === MAX_ALIAS_DEPTH) return undefined;
  aliases.add(symbol);
  try {
    const declarations = symbol.declarations ?? [];
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) return undefined;
    if ((declaration.parent.flags & ts.NodeFlags.Const) === 0 || declaration.initializer === undefined) return undefined;
    const initializer = skipWrappers(declaration.initializer);
    if (!ts.isCallExpression(initializer) && !ts.isIdentifier(initializer)) return undefined;
    return resolveWrapper(initializer, context, cache, aliases, depth + 1);
  } finally {
    aliases.delete(symbol);
  }
}

/** genuine Next factory 호출에서 첫 callback만 꺼낸다. */
function callbackFromFactory(
  call: ts.CallExpression,
  context: NextCacheModelContext,
  cache: ModelCache,
): ts.Expression | undefined {
  if (call.questionDotToken !== undefined || call.arguments.length === 0 || call.arguments.some(ts.isSpreadElement)) return undefined;
  const callback = call.arguments[0];
  if (callback === undefined || ts.isSpreadElement(callback)) return undefined;
  if (!isStableCallbackExpression(callback, context.checker, new Set<ts.Symbol>(), 0)) return undefined;
  const factory = factorySymbol(call.expression, context, cache);
  return factory === undefined ? undefined : callback;
}

/** callback 식을 함수 선언·inline 함수·const identifier alias로만 제한한다. */
function isStableCallbackExpression(expression: ts.Expression, checker: ts.TypeChecker, seen: Set<ts.Symbol>, depth: number): boolean {
  if (depth > MAX_ALIAS_DEPTH) return false;
  const inner = skipWrappers(expression);
  if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return true;
  if (ts.isIdentifier(inner)) {
    const symbol = canonicalSymbol(checker, checker.getSymbolAtLocation(inner));
    if (symbol === undefined || seen.has(symbol)) return false;
    const declarations = symbol.declarations ?? [];
    if (declarations.some(ts.isParameter)) return false;
    if (declarations.some((declaration) => ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration))) return true;
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0) {
      seen.add(symbol);
      try {
        return isStableCallbackExpression(declaration.initializer, checker, seen, depth + 1);
      } finally {
        seen.delete(symbol);
      }
    }
    return false;
  }
  return false;
}

/** factory 식이 genuine direct named import 또는 direct namespace import인지 본다. */
function factorySymbol(
  expression: ts.Expression,
  context: NextCacheModelContext,
  cache: ModelCache,
): ts.Symbol | undefined {
  const callee = skipWrappers(expression);
  if (ts.isIdentifier(callee)) return namedFactorySymbol(callee, context, cache);
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return namespaceFactorySymbol(callee, context, cache);
  }
  return undefined;
}

/** `import { unstable_cache as cache } from "next/cache"`만 인정한다. */
function namedFactorySymbol(
  identifier: ts.Identifier,
  context: NextCacheModelContext,
  cache: ModelCache,
): ts.Symbol | undefined {
  const local = context.checker.getSymbolAtLocation(identifier);
  const declaration = uniqueDeclaration(local, ts.isImportSpecifier);
  if (declaration === undefined) return undefined;
  const importDeclaration = declaration.parent.parent.parent;
  if (!ts.isImportDeclaration(importDeclaration) || !isNextCacheSpecifier(importDeclaration.moduleSpecifier)
    || declaration.isTypeOnly || importDeclaration.importClause?.isTypeOnly === true
    || (declaration.propertyName?.text ?? declaration.name.text) !== 'unstable_cache') return undefined;
  const module = importedModule(importDeclaration, context.checker);
  const target = canonicalSymbol(context.checker, local);
  if (module === undefined || target === undefined || target.name !== 'unstable_cache') return undefined;
  if (context.index.openModules.has(module)) return undefined;
  if (!isSdkSymbol(module, context, cache) || !isSdkSymbol(target, context, cache)) return undefined;
  return hasWrites(target, context, cache) || hasWrites(module, context, cache)
    || hasReflectiveWrite(target, context, cache) ? undefined : target;
}

/** direct NamespaceImport의 `.unstable_cache` 또는 문자열 literal access만 인정한다. */
function namespaceFactorySymbol(
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  context: NextCacheModelContext,
  cache: ModelCache,
): ts.Symbol | undefined {
  if (access.questionDotToken !== undefined) return undefined;
  const argument = ts.isElementAccessExpression(access) ? skipWrappers(access.argumentExpression) : undefined;
  const name = ts.isPropertyAccessExpression(access) ? access.name.text
    : argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
  if (name !== 'unstable_cache') return undefined;
  const receiver = skipWrappers(access.expression);
  if (!ts.isIdentifier(receiver)) return undefined;
  const local = context.checker.getSymbolAtLocation(receiver);
  const declaration = uniqueDeclaration(local, ts.isNamespaceImport);
  if (declaration === undefined) return undefined;
  const importDeclaration = declaration.parent.parent;
  if (!ts.isImportDeclaration(importDeclaration) || !isNextCacheSpecifier(importDeclaration.moduleSpecifier)
    || importDeclaration.importClause?.isTypeOnly === true) return undefined;
  const module = canonicalSymbol(context.checker, local);
  if (module === undefined || context.index.openModules.has(module) || !isSdkSymbol(module, context, cache)) return undefined;
  let exported: ts.Symbol | undefined;
  try {
    exported = context.checker.getExportsOfModule(module).find((candidate) => candidate.name === 'unstable_cache');
  } catch {
    return undefined;
  }
  const target = canonicalSymbol(context.checker, exported);
  if (target === undefined || target.name !== 'unstable_cache' || !isSdkSymbol(target, context, cache)) return undefined;
  return hasWrites(target, context, cache) || hasWrites(module, context, cache) ? undefined : target;
}

/** import declaration의 module specifier를 정확히 제한한다. */
function isNextCacheSpecifier(specifier: ts.Expression | undefined): specifier is ts.StringLiteralLike {
  return specifier !== undefined && ts.isStringLiteralLike(specifier) && specifier.text === 'next/cache';
}

/** import declaration에서 checker module symbol을 얻는다. */
function importedModule(declaration: ts.ImportDeclaration, checker: ts.TypeChecker): ts.Symbol | undefined {
  return canonicalSymbol(checker, checker.getSymbolAtLocation(declaration.moduleSpecifier));
}

/** alias를 풀되 checker 실패는 모두 unknown으로 둔다. */
function canonicalSymbol(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (symbol === undefined) return undefined;
  let current = symbol;
  const seen = new Set<ts.Symbol>();
  while ((current.flags & ts.SymbolFlags.Alias) !== 0) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    try {
      const next = checker.getAliasedSymbol(current);
      if (next === current) return undefined;
      current = next;
    } catch {
      return undefined;
    }
  }
  return current;
}

/** 선언 종류가 정확히 하나인 import declaration을 찾는다. */
function uniqueDeclaration<T extends ts.Declaration>(
  symbol: ts.Symbol | undefined,
  predicate: (node: ts.Node) => node is T,
): T | undefined {
  const declarations = symbol?.declarations ?? [];
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  return declaration !== undefined && predicate(declaration) ? declaration : undefined;
}

/** 심볼 또는 namespace에 식별자·반사 쓰기가 있는지 본다. */
function hasWrites(symbol: ts.Symbol, context: NextCacheModelContext, cache: ModelCache): boolean {
  return mutationState(symbol, context, cache).writes;
}

function hasReflectiveWrite(symbol: ts.Symbol, context: NextCacheModelContext, cache: ModelCache): boolean {
  return mutationState(symbol, context, cache).reflective;
}

/** 범위마다 심볼별 mutation scan을 한 번만 수행한다. */
function mutationState(symbol: ts.Symbol, context: NextCacheModelContext, cache: ModelCache): MutationState {
  let bySymbol = cache.mutations.get(context.index);
  if (bySymbol === undefined) {
    bySymbol = new Map();
    cache.mutations.set(context.index, bySymbol);
  }
  const existing = bySymbol.get(symbol);
  if (existing !== undefined) return existing;
  const writes = (context.index.identifierWrites.get(symbol)?.length ?? 0) > 0
    || [...context.index.propertyWrites.values()].some((writesForName) => writesForName.some((write) => propertyWriteMatches(write, symbol, context, cache)));
  const reflective = context.index.reflectiveTargets.some((target) => reflectiveTargetMatches(target, symbol, context, cache));
  const state = { writes, reflective };
  bySymbol.set(symbol, state);
  return state;
}

/** alias 수신자에 대한 직접·간접 property write를 본다. */
function propertyWriteMatches(
  write: { readonly target: ts.PropertyAccessExpression | ts.ElementAccessExpression },
  symbol: ts.Symbol,
  context: NextCacheModelContext,
  cache: ModelCache,
): boolean {
  const receiver = skipWrappers(write.target.expression);
  const receiverSymbol = canonicalSymbol(context.checker, symbolOfExpression(receiver, context.checker));
  if (receiverSymbol === symbol) return true;
  const argument = ts.isElementAccessExpression(write.target) ? skipWrappers(write.target.argumentExpression) : undefined;
  const name = ts.isPropertyAccessExpression(write.target) ? write.target.name.text
    : argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
  if (name === undefined || receiverSymbol === undefined) return false;
  const origins = aliasOrigins(receiverSymbol, context, cache, new Set<ts.Symbol>(), 0);
  return origins !== undefined && [...origins].some((origin) => moduleMemberIs(origin, name, symbol, context.checker));
}

/** reflective target이 SDK 심볼 또는 그 immutable/mutable alias인지 본다. */
function reflectiveTargetMatches(
  target: ts.Expression,
  symbol: ts.Symbol,
  context: NextCacheModelContext,
  cache: ModelCache,
): boolean {
  const expressionSymbol = canonicalSymbol(context.checker, symbolOfExpression(target, context.checker));
  if (expressionSymbol === symbol) return true;
  const origins = expressionSymbol === undefined ? undefined : aliasOrigins(expressionSymbol, context, cache, new Set<ts.Symbol>(), 0);
  return origins !== undefined && origins.has(symbol);
}

/** const/let alias의 initializer·known writes에서 도달하는 심볼을 bounded하게 구한다. */
function aliasOrigins(
  symbol: ts.Symbol,
  context: NextCacheModelContext,
  cache: ModelCache,
  seen: Set<ts.Symbol>,
  depth: number,
): ReadonlySet<ts.Symbol> | undefined {
  let bySymbol = cache.aliases.get(context.index);
  if (bySymbol === undefined) {
    bySymbol = new Map();
    cache.aliases.set(context.index, bySymbol);
  }
  if (bySymbol.has(symbol)) return bySymbol.get(symbol);
  if (depth > MAX_ALIAS_DEPTH || seen.has(symbol)) return undefined;
  seen.add(symbol);
  let result: Set<ts.Symbol> | undefined;
  const declarations = symbol.declarations ?? [];
  const declaration = declarations.length === 1 ? declarations[0] : undefined;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration)) {
    result = new Set([symbol]);
  } else {
    result = aliasOriginsFromExpression(declaration.initializer, context, cache, seen, depth + 1);
    for (const value of context.index.identifierWrites.get(symbol) ?? []) {
      const fromWrite = aliasOriginsFromExpression(value, context, cache, seen, depth + 1);
      if (fromWrite !== undefined) {
        result ??= new Set();
        fromWrite.forEach((origin) => result!.add(origin));
      }
    }
  }
  seen.delete(symbol);
  bySymbol.set(symbol, result);
  return result;
}

/** alias initializer/write 하나를 심볼 alias로만 해석한다. */
function aliasOriginsFromExpression(
  expression: ts.Expression | undefined,
  context: NextCacheModelContext,
  cache: ModelCache,
  seen: Set<ts.Symbol>,
  depth: number,
): Set<ts.Symbol> | undefined {
  if (expression === undefined) return undefined;
  const symbol = canonicalSymbol(context.checker, symbolOfExpression(expression, context.checker));
  if (symbol === undefined) return undefined;
  const origins = aliasOrigins(symbol, context, cache, seen, depth);
  return origins === undefined ? undefined : new Set(origins);
}

/** identifier/property/string-element 식의 checker 심볼이다. */
function symbolOfExpression(expression: ts.Expression, checker: ts.TypeChecker): ts.Symbol | undefined {
  const inner = skipWrappers(expression);
  if (ts.isIdentifier(inner)) return checker.getSymbolAtLocation(inner);
  if (ts.isPropertyAccessExpression(inner)) return checker.getSymbolAtLocation(inner.name);
  if (ts.isElementAccessExpression(inner) && ts.isStringLiteralLike(skipWrappers(inner.argumentExpression))) {
    return checker.getSymbolAtLocation(skipWrappers(inner.argumentExpression));
  }
  return undefined;
}

/** namespace origin의 named export가 목표 심볼인지 본다. */
function moduleMemberIs(
  module: ts.Symbol,
  name: string,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  if ((module.flags & ts.SymbolFlags.ValueModule) === 0) return false;
  try {
    const member = checker.getExportsOfModule(module).find((candidate) => candidate.name === name);
    return canonicalSymbol(checker, member) === symbol;
  } catch {
    return false;
  }
}

/** 모든 선언이 package root 아래의 정확한 Next 16.2.7 SDK인지 본다. */
function isSdkSymbol(symbol: ts.Symbol, context: NextCacheModelContext, cache: ModelCache): boolean {
  const declarations = activeDeclarations(symbol, context);
  return declarations.length > 0 && declarations.every((declaration) => isSdkSource(declaration.getSourceFile(), context, cache));
}

/** source declaration 경로에서 package root를 찾고 bounded package.json을 확인한다. */
function isSdkSource(sourceFile: ts.SourceFile, context: NextCacheModelContext, cache: ModelCache): boolean {
  if (context.pathByFile.has(sourceFile)) return false;
  const root = nextPackageRoot(sourceFile.fileName);
  if (root === undefined) return false;
  const manifest = packageManifest(root, cache);
  return manifest?.name === NEXT_PACKAGE_NAME && manifest.version === NEXT_PACKAGE_VERSION;
}

/** path separator 차이를 정규화한 `node_modules/next` package root다. */
function nextPackageRoot(fileName: string): string | undefined {
  const normalized = fileName.replaceAll('\\', '/');
  const marker = '/node_modules/next/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) return normalized.slice(0, markerIndex + marker.length - 1);
  if (normalized.startsWith('node_modules/next/')) return 'node_modules/next';
  return undefined;
}

/** package.json의 name/version만 bounded하게 읽는다. 실패는 unknown으로 캐시한다. */
function packageManifest(root: string, cache: ModelCache): PackageManifest | undefined {
  if (cache.manifests.has(root)) return cache.manifests.get(root);
  let manifest: PackageManifest | undefined;
  try {
    const path = `${root}/package.json`;
    if (statSync(path).size > MAX_PACKAGE_JSON_BYTES) {
      cache.manifests.set(root, undefined);
      return undefined;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && typeof (parsed as { name?: unknown }).name === 'string'
      && typeof (parsed as { version?: unknown }).version === 'string') {
      manifest = { name: (parsed as { name: string }).name, version: (parsed as { version: string }).version };
    }
  } catch {
    manifest = undefined;
  }
  cache.manifests.set(root, manifest);
  return manifest;
}
