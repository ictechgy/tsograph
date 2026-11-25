/**
 * Fastify 플러그인이 캡슐화를 건너뛰는지(`fn[Symbol.for('skip-override')]`) 본다.
 *
 * fastify 4.29.1·5.12.5 `pluginUtils.shouldSkipOverride`는 `!!fn[Symbol.for('skip-override')]`이고, 참이면 `register()`가
 * 새 인스턴스를 만들지 않아 `prefix`를 무시한다(`lib/plugin-override.js`). `fastify-plugin` 감싸기는 어댑터가 따로 알아보고,
 * 여기서는 프로젝트 코드가 그 심볼을 쓰거나 바꿀 수 있는 자리를 센다. 판정은 바인딩(변수·함수·속성 심볼)마다 한 번 계산해 둔다.
 *
 * - 바인딩에 `[Symbol.for('skip-override')] = <참 리터럴>`을 모듈 최상위에서 조건 없이 쓰거나(그 심볼을 담은 `const` 키 포함) 바인딩을
 *   `fastify-plugin`에 넘기면 건너뛴다(`'yes'`). `fastify-plugin`은 받은 함수에 그 심볼을 직접 쓰고 같은 함수를 돌려준다.
 * - 같은 쓰기가 함수 안·조건 아래에 있거나, 값·키를 모르거나, 바인딩이 다른 곳으로 흘러가면 건너뛰는지 모른다(`'unknown'`). 흘러가지
 *   않는 자리: `register()` 첫 인자, 호출 대상, 점 접근, 읽기 원소 접근, 내보내기, 비교·`typeof`·조건 판정, `console.*` 인자, `const`
 *   별칭(그 별칭의 사용도 함께 본다), 프로젝트 함수의 매개변수 자리(그 매개변수의 사용을 따라 본다).
 * - 바인딩으로 이을 수 없는 대상(매개변수·반복 변수·원소 접근·호출 결과)에 skip-override 키를 쓰는 곳이 있으면 어느 플러그인이든 모른다.
 *   모듈 네임스페이스·`require()`·`import()`·`module.exports` 객체가 호출 인자·컨테이너로 흘러가거나 원소 접근으로 읽히거나 그 아래 원소에
 *   계산된 키로 쓰이면, 그 모듈이 내보낸 플러그인을 모른다.
 *
 * 근거는 파일마다 모은다. 등록 호출이 있는 파일, 플러그인 함수가 있는 파일, 등록 인자에서 따라간 바인딩을 선언한 파일은 늘 보고
 * (테스트 디렉터리 이름이어도 서버가 실제로 불러 쓰는 코드다), 그 밖에는 해석 대상 파일만 본다. 테스트 소스의 근거는 테스트 소스에 있지
 * 않은 등록에 대해 많아야 `'unknown'`이다(테스트 코드는 서버 실행 경로가 아니지만 테스트 디렉터리 판정은 이름 규칙이라 단정하지 않는다).
 */

import ts from 'typescript';

import { isNodeTestPath } from './node-project.ts';
import type { InterpreterContext } from './router-interpreter.ts';
import { calleeFromPackage, resolveAlias, symbolAt, unwrap } from './symbols.ts';

/** 플러그인이 캡슐화를 건너뛰는지다. */
export type SkipOverride = 'no' | 'yes' | 'unknown';

/** 근거 하나의 세기다(`'unknown'`이 `'yes'`보다 강하다). */
type Level = 'yes' | 'unknown';

/** 파일별 가장 강한 근거다. */
type Evidence = Map<ts.SourceFile, Level>;

/** 사용 자리 하나를 분류한 결과: 근거, 따라가 볼 다른 바인딩, 또는 바꾸지 않음. */
type UseVerdict = Level | 'no' | { readonly follow: ts.Symbol };

/** 사용 자리를 살펴본 누적 수다(이름별 묶기와 바인딩별 분류). 성능 회귀 검사용이다. */
let visitedUses = 0;

/**
 * 지금까지 사용 자리를 살펴본 수다. 같은 이름의 사용을 등록마다 다시 훑거나 같은 바인딩을 다시 분류하지 않는지(등록 수에 선형인지)
 * 테스트가 본다.
 *
 * @returns 누적 수
 */
export function skipOverrideWork(): number {
  return visitedUses;
}

/** 프로젝트 전체에서 한 번 모은, skip-override를 바꿀 수 있는 구문 자리와 질의 메모다. */
interface SkipCensus {
  /** 이름별로 모은, 바인딩(식별자·속성 접근)의 값이 쓰이거나 흘러가는 자리 */
  readonly usesByName: ReadonlyMap<string, readonly ts.Expression[]>;
  /** import 지정자의 지역 이름 */
  readonly aliasNames: readonly ts.Identifier[];
  /** 파일별 최상위 `module.exports = X`의 X */
  readonly moduleExports: ReadonlyMap<ts.SourceFile, readonly ts.Expression[]>;
  /** 파일별 `module.exports[k] = …`·`exports[k] = …` 쓰기 */
  readonly moduleExportWrites: ReadonlyMap<ts.SourceFile, readonly ts.ElementAccessExpression[]>;
  /** 키가 skip-override일 수 있는 원소 쓰기(바인딩으로 잇지 못하면 전역·모듈 근거가 된다) */
  readonly computedWrites: readonly ts.ElementAccessExpression[];
  /** 모듈 객체(네임스페이스·`require()`·`import()`·`module.exports`)가 흘러가거나 원소로 읽히는 자리 */
  readonly moduleObjectUses: readonly ts.Expression[];
  /** 이름 → 심볼별 사용(그 이름을 처음 물을 때 만든다) */
  readonly usesBySymbol: Map<string, Map<ts.Symbol, ts.Expression[]>>;
  /** 심볼 → import 지역 이름(첫 질의 때 만든다) */
  aliasIndex: Map<ts.Symbol, string[]> | undefined;
  /** 바인딩별 근거 메모 */
  readonly evidence: Map<ts.Symbol, Evidence>;
  /** 바인딩으로 잇지 못한 skip-override 키 쓰기(모든 플러그인의 근거, 첫 질의 때 만든다) */
  global: Evidence | undefined;
  /** 모듈 파일 → 그 모듈 심볼(알면)과 모듈 객체가 흘러간 자리(첫 질의 때 만든다) */
  escapedModules: Map<ts.SourceFile, EscapedModule> | undefined;
}

/** 모듈 객체가 흘러간 모듈이다. */
interface EscapedModule {
  /** 모듈 심볼(`module.exports`처럼 지정자 없이 만난 모듈이면 undefined) */
  symbol: ts.Symbol | undefined;
  /** 모듈 객체가 흘러간 자리의 파일별 근거 */
  readonly evidence: Evidence;
}

/** 해석기 문맥마다 한 번 만든 census다. */
const censuses = new WeakMap<InterpreterContext, SkipCensus>();

/** 식·식별자 → 별칭을 따라간 심볼 메모다. */
const symbolMemo = new WeakMap<ts.Node, ts.Symbol | null>();

/**
 * 등록한 플러그인 함수가 캡슐화를 건너뛰는지 본다.
 *
 * @param context 해석기 문맥
 * @param chain 등록 인자에서 함수까지 따라간 식별자·속성 접근의 심볼
 * @param fn 플러그인 함수 선언
 * @param call 등록 호출
 * @returns 건너뜀·안 건너뜀·모름
 */
export function skipOverrideOf(context: InterpreterContext, chain: ReadonlySet<ts.Symbol>, fn: ts.SignatureDeclaration, call: ts.Node): SkipOverride {
  const census = censusOf(context);
  const checker = context.checker;
  const tracked = trackedSymbols(checker, chain, fn);
  const merged: Evidence = new Map();
  for (const symbol of tracked) mergeInto(merged, evidenceOf(census, context, symbol, new Set()));
  const file = fn.getSourceFile();
  const exportsFunction = (census.moduleExports.get(file) ?? []).some((value) => value === fn
    || (ts.isIdentifier(value) && tracked.has(resolvedSymbol(checker, value) as ts.Symbol)));
  if (exportsFunction) for (const write of census.moduleExportWrites.get(file) ?? []) addLevel(merged, write.getSourceFile(), classifyWrite(checker, write));
  mergeInto(merged, globalEvidence(census, context));
  const declarations = [fn, ...[...tracked].flatMap((symbol) => symbol.declarations ?? [])];
  const modules = escapedModules(census, context);
  for (const module of new Set(declarations.map((declaration) => declaration.getSourceFile()))) {
    const escaped = modules.get(module);
    if (escaped !== undefined && (exportsFunction && module === file || exportedFrom(checker, escaped.symbol, module, declarations, [...tracked]))) {
      mergeInto(merged, escaped.evidence);
    }
  }
  const privileged = new Set([...declarations.map((declaration) => declaration.getSourceFile()), call.getSourceFile()]);
  return verdictOf(context, merged, privileged, call.getSourceFile());
}

/**
 * 선언 중 하나가 모듈이 내보낸 최상위 선언(또는 그 안)에 있는지 본다. 모듈 객체가 흘러가면 내보낸 값에만 이름 없이 닿을 수 있다.
 *
 * @param checker TypeChecker
 * @param moduleSymbol 모듈 심볼(모르면 undefined)
 * @param module 모듈 파일
 * @param declarations 플러그인 함수와 바인딩 선언
 * @param tracked 바인딩 심볼(CommonJS `exports.x = fn`처럼 그 심볼 자체가 내보낸 이름일 수 있다)
 * @returns 내보낸 선언 안에 있으면 true
 */
function exportedFrom(checker: ts.TypeChecker, moduleSymbol: ts.Symbol | undefined, module: ts.SourceFile, declarations: readonly ts.Node[], tracked: readonly ts.Symbol[]): boolean {
  // 모듈 심볼을 모르면(지정자 없이 만난 `module.exports`) 내보냈는지 가리지 않고 모르는 쪽으로 본다.
  if (moduleSymbol === undefined) return true;
  const exported = new Set(checker.getExportsOfModule(moduleSymbol).map((symbol) => resolveAlias(checker, symbol)));
  if (tracked.some((symbol) => exported.has(symbol))) return true;
  return declarations.some((declaration) => {
    if (declaration.getSourceFile() !== module) return false;
    let statement: ts.Node = declaration;
    while (!ts.isSourceFile(statement.parent)) statement = statement.parent;
    return declaredSymbols(checker, statement).some((symbol) => exported.has(symbol));
  });
}

/**
 * 최상위 문장이 선언하는 심볼이다(변수·함수·클래스).
 *
 * @param checker TypeChecker
 * @param statement 최상위 문장
 * @returns 심볼
 */
function declaredSymbols(checker: ts.TypeChecker, statement: ts.Node): ts.Symbol[] {
  const names = ts.isVariableStatement(statement)
    ? statement.declarationList.declarations.map((declaration) => declaration.name)
    : ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ? [statement.name] : [];
  return names.flatMap((name) => {
    const symbol = name !== undefined && ts.isIdentifier(name) ? symbolAt(checker, name) : undefined;
    return symbol === undefined ? [] : [symbol];
  });
}

/**
 * 파일별 근거를 등록 하나에 대한 판정으로 줄인다. 늘 보는 파일(등록·플러그인·바인딩 선언 파일)이 아니면 해석 대상 파일의 근거만 쓰고,
 * 테스트 소스에 있지 않은 등록에 대한 테스트 소스의 근거는 많아야 `'unknown'`이다.
 *
 * @param context 해석기 문맥
 * @param evidence 파일별 근거
 * @param privileged 늘 보는 파일
 * @param registrationFile 등록 호출이 있는 파일
 * @returns 판정
 */
function verdictOf(context: InterpreterContext, evidence: Evidence, privileged: ReadonlySet<ts.SourceFile>, registrationFile: ts.SourceFile): SkipOverride {
  const registrationInTests = isTestSource(context, registrationFile);
  let result: SkipOverride = 'no';
  for (const [file, level] of evidence) {
    if (!privileged.has(file)) {
      const path = context.project.pathOf(file);
      if (path === undefined || !context.includesFile(path)) continue;
      if (level === 'yes' && !registrationInTests && isNodeTestPath(path)) {
        result = 'unknown';
        continue;
      }
    }
    if (level === 'unknown') return 'unknown';
    result = result === 'unknown' ? 'unknown' : 'yes';
  }
  return result;
}

/**
 * 파일이 테스트 소스인지 본다.
 *
 * @param context 해석기 문맥
 * @param file 파일
 * @returns 테스트 소스면 true
 */
function isTestSource(context: InterpreterContext, file: ts.SourceFile): boolean {
  const path = context.project.pathOf(file);
  return path !== undefined && isNodeTestPath(path);
}

/**
 * 근거에 한 파일의 근거를 더한다(`'unknown'`이 `'yes'`를 이긴다).
 *
 * @param evidence 근거
 * @param file 파일
 * @param level 근거(`'no'`면 더하지 않는다)
 */
function addLevel(evidence: Evidence, file: ts.SourceFile, level: SkipOverride): void {
  if (level === 'no') return;
  if (evidence.get(file) !== 'unknown') evidence.set(file, level);
}

/**
 * 근거를 합친다.
 *
 * @param target 합칠 곳
 * @param source 더할 근거
 */
function mergeInto(target: Evidence, source: Evidence | undefined): void {
  for (const [file, level] of source ?? []) addLevel(target, file, level);
}

/**
 * 등록 인자에서 따라간 바인딩과 함수 선언·함수 식을 담은 변수의 심볼이다.
 *
 * @param checker TypeChecker
 * @param chain 등록 인자에서 따라간 심볼
 * @param fn 플러그인 함수 선언
 * @returns 심볼 집합
 */
function trackedSymbols(checker: ts.TypeChecker, chain: ReadonlySet<ts.Symbol>, fn: ts.SignatureDeclaration): Set<ts.Symbol> {
  const symbols = new Set(chain);
  for (const name of [fn.name, holderName(fn)]) {
    const symbol = name !== undefined && ts.isIdentifier(name) ? symbolAt(checker, name) : undefined;
    if (symbol !== undefined) symbols.add(resolveAlias(checker, symbol));
  }
  return symbols;
}

/**
 * 함수 식을 초기값으로 둔 변수·속성의 이름 식별자다.
 *
 * @param fn 함수 선언
 * @returns 이름 또는 undefined
 */
function holderName(fn: ts.SignatureDeclaration): ts.Identifier | undefined {
  let current: ts.Node = fn;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  if ((ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === current
    && ts.isIdentifier(parent.name)) return parent.name;
  return undefined;
}

/**
 * 바인딩 하나의 파일별 근거다(메모한다). `const` 별칭과 매개변수로 흘러간 자리는 그 바인딩의 근거를 합친다. 따라가다 다시 만난 바인딩은
 * 비어 있는 근거로 보고, 그런 순환을 거친 결과는 순환의 시작 바인딩에만 메모한다(부분 결과를 다른 바인딩에 남기지 않는다).
 *
 * @param census census
 * @param context 해석기 문맥
 * @param symbol 바인딩 심볼
 * @param active 지금 계산 중인 바인딩
 * @returns 근거
 */
function evidenceOf(census: SkipCensus, context: InterpreterContext, symbol: ts.Symbol, active: Set<ts.Symbol>): Evidence {
  const memo = census.evidence.get(symbol);
  if (memo !== undefined) return memo;
  if (active.has(symbol)) {
    active.add(CYCLE);
    return new Map();
  }
  active.add(symbol);
  const evidence: Evidence = new Map();
  let cycleBelow = false;
  for (const use of usesOf(census, context.checker, symbol)) {
    visitedUses++;
    const verdict = classifyUse(context, use);
    if (typeof verdict === 'string') addLevel(evidence, use.getSourceFile(), verdict);
    else {
      const inner = new Set(active);
      mergeInto(evidence, evidenceOf(census, context, verdict.follow, inner));
      if (inner.has(CYCLE)) cycleBelow = true;
    }
  }
  active.delete(symbol);
  if (cycleBelow) active.add(CYCLE);
  else census.evidence.set(symbol, evidence);
  return evidence;
}

/** 순환을 만났다는 표식 심볼이다. */
const CYCLE = { name: '<cycle>' } as unknown as ts.Symbol;

/**
 * 심볼의 사용 자리다. 심볼 이름, 선언 이름, 그 심볼을 다른 이름으로 가져온 import 지역 이름으로 찾는다.
 *
 * @param census census
 * @param checker TypeChecker
 * @param symbol 심볼
 * @returns 사용 자리
 */
function usesOf(census: SkipCensus, checker: ts.TypeChecker, symbol: ts.Symbol): ts.Expression[] {
  // 기본 내보내기 함수의 심볼 이름은 `default`라 선언 이름도 넣는다.
  const declared = (symbol.declarations ?? []).flatMap((declaration) => {
    const name = (declaration as ts.Declaration & { readonly name?: ts.Node }).name;
    return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
  });
  const names = new Set([symbol.name, ...declared, ...(aliasIndexOf(census, checker).get(symbol) ?? [])]);
  return [...names].flatMap((name) => symbolUsesByName(census, checker, name).get(symbol) ?? []);
}

/**
 * 이름 하나의 사용을 심볼별로 묶는다(이름마다 한 번).
 *
 * @param census census
 * @param checker TypeChecker
 * @param name 이름
 * @returns 심볼 → 사용
 */
function symbolUsesByName(census: SkipCensus, checker: ts.TypeChecker, name: string): Map<ts.Symbol, ts.Expression[]> {
  const cached = census.usesBySymbol.get(name);
  if (cached !== undefined) return cached;
  const grouped = new Map<ts.Symbol, ts.Expression[]>();
  for (const use of census.usesByName.get(name) ?? []) {
    visitedUses++;
    const symbol = resolvedSymbol(checker, use);
    if (symbol !== undefined) pushTo(grouped, symbol, use);
  }
  census.usesBySymbol.set(name, grouped);
  return grouped;
}

/**
 * import 지역 이름을 별칭을 따라간 심볼별로 묶은 색인이다(한 번만 만든다).
 *
 * @param census census
 * @param checker TypeChecker
 * @returns 심볼 → 지역 이름
 */
function aliasIndexOf(census: SkipCensus, checker: ts.TypeChecker): Map<ts.Symbol, string[]> {
  if (census.aliasIndex !== undefined) return census.aliasIndex;
  const index = new Map<ts.Symbol, string[]>();
  for (const alias of census.aliasNames) {
    const symbol = resolvedSymbol(checker, alias);
    if (symbol !== undefined) pushTo(index, symbol, alias.text);
  }
  census.aliasIndex = index;
  return index;
}

/**
 * 식별자·속성 접근이 가리키는 값 심볼(별칭을 따라간 뒤)이다.
 *
 * @param checker TypeChecker
 * @param node 식별자 또는 속성 접근
 * @returns 심볼 또는 undefined
 */
function resolvedSymbol(checker: ts.TypeChecker, node: ts.Expression): ts.Symbol | undefined {
  const memo = symbolMemo.get(node);
  if (memo !== undefined) return memo ?? undefined;
  const parent = node.parent;
  let raw: ts.Symbol | undefined;
  if (ts.isPropertyAccessExpression(node)) raw = symbolAt(checker, node.name);
  else if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) raw = checker.getShorthandAssignmentValueSymbol(parent);
  else raw = symbolAt(checker, node);
  const symbol = raw === undefined ? undefined : resolveAlias(checker, raw);
  symbolMemo.set(node, symbol ?? null);
  return symbol;
}

/**
 * 해석기 문맥의 census를 (처음이면 만들어) 돌려준다.
 *
 * @param context 해석기 문맥
 * @returns census
 */
function censusOf(context: InterpreterContext): SkipCensus {
  const cached = censuses.get(context);
  if (cached !== undefined) return cached;
  const census = buildCensus(context);
  censuses.set(context, census);
  return census;
}

/**
 * 프로젝트 파일을 모두 한 번씩 걸어 census를 만든다(재귀 없이 걷는다). 어느 파일의 근거를 쓸지는 판정할 때 정한다.
 *
 * @param context 해석기 문맥
 * @returns census
 */
function buildCensus(context: InterpreterContext): SkipCensus {
  const usesByName = new Map<string, ts.Expression[]>();
  const aliasNames: ts.Identifier[] = [];
  const moduleExports = new Map<ts.SourceFile, ts.Expression[]>();
  const moduleExportWrites = new Map<ts.SourceFile, ts.ElementAccessExpression[]>();
  const computedWrites: ts.ElementAccessExpression[] = [];
  const moduleObjectUses: ts.Expression[] = [];
  for (const sourceFile of context.project.files.values()) {
    const moduleNames = moduleObjectNames(sourceFile);
    const stack: ts.Node[] = [sourceFile];
    while (stack.length > 0) {
      const node = stack.pop()!;
      visitNode(node, sourceFile, moduleNames, { usesByName, aliasNames, moduleExports, moduleExportWrites, computedWrites, moduleObjectUses });
      ts.forEachChild(node, (child) => { stack.push(child); });
    }
  }
  return {
    usesByName, aliasNames, moduleExports, moduleExportWrites, computedWrites, moduleObjectUses,
    usesBySymbol: new Map(), aliasIndex: undefined, evidence: new Map(), global: undefined, escapedModules: undefined,
  };
}

/** census를 만들며 채우는 목록이다. */
interface CensusLists {
  readonly usesByName: Map<string, ts.Expression[]>;
  readonly aliasNames: ts.Identifier[];
  readonly moduleExports: Map<ts.SourceFile, ts.Expression[]>;
  readonly moduleExportWrites: Map<ts.SourceFile, ts.ElementAccessExpression[]>;
  readonly computedWrites: ts.ElementAccessExpression[];
  readonly moduleObjectUses: ts.Expression[];
}

/**
 * 노드 하나를 census 목록에 분류한다.
 *
 * @param node 노드
 * @param sourceFile 파일
 * @param moduleNames 이 파일에서 모듈 객체를 담은 이름
 * @param lists 목록
 */
function visitNode(node: ts.Node, sourceFile: ts.SourceFile, moduleNames: ReadonlySet<string>, lists: CensusLists): void {
  if (ts.isIdentifier(node)) {
    if (isAliasName(node)) lists.aliasNames.push(node);
    else if (isValueReference(node) && mayChangeBinding(node)) pushTo(lists.usesByName, node.text, node);
    if ((moduleNames.has(node.text) || node.text === 'exports') && isValueReference(node) && moduleObjectEscapes(node)) lists.moduleObjectUses.push(node);
  } else if (ts.isPropertyAccessExpression(node)) {
    if (isModuleExportsReference(node)) {
      if (moduleObjectEscapes(node)) lists.moduleObjectUses.push(node);
    } else if (mayChangeBinding(node)) pushTo(lists.usesByName, node.name.text, node);
  } else if (ts.isElementAccessExpression(node) && isWriteTarget(node)) {
    const target = unwrap(node.expression);
    if (isModuleExportsReference(target)) pushTo(lists.moduleExportWrites, sourceFile, node);
    else if (!isOtherKeyLiteral(node.argumentExpression)) lists.computedWrites.push(node);
  } else if (isModuleObjectCall(node) && moduleObjectEscapes(node)) {
    lists.moduleObjectUses.push(node);
  } else if (isTopLevelModuleExportsAssignment(node)) {
    pushTo(lists.moduleExports, sourceFile, unwrap(node.right));
  }
}

/**
 * 맵의 목록에 값을 더한다.
 *
 * @param map 맵
 * @param key 키
 * @param value 값
 */
function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * 파일에서 모듈 객체를 담은 이름이다: 네임스페이스 import, `import x = require()`, `require()`·`import()` 결과로 초기화한 변수.
 *
 * @param sourceFile 파일
 * @returns 이름 집합
 */
function moduleObjectNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const stack: ts.Node[] = [sourceFile];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (ts.isNamespaceImport(node) || (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))) names.add(node.name.text);
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined && isModuleObjectCall(unwrap(node.initializer))) names.add(node.name.text);
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
  return names;
}

/**
 * 식이 `require('…')` 또는 `import('…')` 호출인지 본다.
 *
 * @param node 노드
 * @returns 맞으면 true
 */
function isModuleObjectCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || node.arguments.length < 1 || !ts.isStringLiteralLike(node.arguments[0]!)) return false;
  return node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
}

/**
 * 모듈 객체 식이 흘러가거나(호출 인자·컨테이너·다른 변수) 원소 접근으로 읽혀, 그 모듈의 내보낸 값에 이름 없이 닿을 수 있는지 본다.
 * 모듈 객체 자체에 대입하는 자리(`module.exports = …`, `module.exports[k] = …`)는 내보낸 값을 읽지 않는다(`module.exports[k]` 쓰기는
 * {@link skipOverrideOf}가 따로 본다).
 * 점 접근(`P.users`)은 속성 심볼로 따로 세고, 호출 대상·`register()` 첫 인자, 모듈 객체 이름이 되는 `require()`·`import()` 결과의 변수
 * 초기값은 흘려보내지 않는다(이름을 다른 변수에 옮기면 흘러간 것으로 본다).
 *
 * @param node 모듈 객체 식
 * @returns 흘러가면 true
 */
function moduleObjectEscapes(node: ts.Expression): boolean {
  const outer = outermostWrapper(node);
  const parent = outer.parent;
  if (ts.isElementAccessExpression(parent) && parent.expression === outer) return !isWriteTarget(parent);
  if (ts.isBinaryExpression(parent) && parent.left === outer && isAssignmentOperator(parent.operatorToken.kind)) return false;
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer) return !isModuleObjectCall(node);
  if (ts.isAwaitExpression(parent)) return moduleObjectEscapes(parent);
  if (ts.isPropertyAccessExpression(parent)) return false;
  return mayChangeBinding(node);
}

/**
 * import 지정자(기본·이름·네임스페이스·`import x = require()`)의 지역 이름인지 본다(다른 이름으로 가져온 바인딩을 찾는 데 쓴다).
 *
 * @param identifier 식별자
 * @returns 지정자 이름이면 true
 */
function isAliasName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  return (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportEqualsDeclaration(parent))
    && parent.name === identifier;
}

/**
 * 식별자가 값 참조인지 본다(선언 이름·속성 이름·라벨이 아니다).
 *
 * @param identifier 식별자
 * @returns 값 참조면 true
 */
function isValueReference(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === identifier) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  const named = parent as ts.Node & { readonly name?: ts.Node; readonly propertyName?: ts.Node };
  return named.name !== identifier && named.propertyName !== identifier && !ts.isLabeledStatement(parent) && !ts.isBreakOrContinueStatement(parent)
    && !ts.isQualifiedName(parent) && !ts.isTypeReferenceNode(parent);
}

/**
 * 식(바인딩을 가리키는 식별자·속성 접근)이 바인딩의 값을 쓰거나 다른 곳으로 흘려보내 skip-override를 바꿀 수 있는 자리인지 본다.
 * 호출 대상, 점 접근, 읽기 원소 접근, `register()` 첫 인자, 내보내기, 비교·`typeof`·조건 판정은 바꾸지 못한다.
 *
 * @param node 식
 * @returns 바꿀 수 있으면 true
 */
function mayChangeBinding(node: ts.Expression): boolean {
  const outer = outermostWrapper(node);
  const parent = outer.parent;
  if (ts.isPropertyAccessExpression(parent) || ts.isTypeQueryNode(parent)) return false;
  if (ts.isElementAccessExpression(parent)) return parent.expression === outer && isWriteTarget(parent);
  if (ts.isCallExpression(parent) || ts.isNewExpression(parent)) return parent.expression !== outer && !isRegisterPlugin(parent, outer);
  if (ts.isBinaryExpression(parent)) return bindingFlowsThroughBinary(parent, outer);
  if (ts.isConditionalExpression(parent)) return parent.condition !== outer;
  return !(ts.isExportAssignment(parent) || ts.isExportSpecifier(parent) || ts.isTypeOfExpression(parent) || ts.isTemplateSpan(parent)
    || ts.isExpressionStatement(parent) || ts.isIfStatement(parent) || ts.isWhileStatement(parent) || ts.isDoStatement(parent)
    || ts.isForOfStatement(parent) || ts.isForInStatement(parent) || ts.isCaseClause(parent) || ts.isSwitchStatement(parent)
    || (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken));
}

/**
 * 괄호·타입 단언·`satisfies`·non-null로 감싼 가장 바깥 식이다.
 *
 * @param node 식
 * @returns 바깥 식
 */
function outermostWrapper(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
    || ts.isNonNullExpression(current.parent) || ts.isTypeAssertionExpression(current.parent)) {
    current = current.parent;
  }
  return current;
}

/**
 * 호출이 `x.register(plugin, …)`이고 식이 그 첫 인자인지 본다. 등록은 skip-override를 읽기만 한다.
 *
 * @param call 호출
 * @param argument 인자 식
 * @returns 등록 첫 인자면 true
 */
function isRegisterPlugin(call: ts.CallExpression | ts.NewExpression, argument: ts.Expression): boolean {
  return ts.isCallExpression(call) && call.arguments[0] === argument && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'register';
}

/**
 * 이항식에서 바인딩의 값이 다른 곳으로 흘러가는지 본다. 비교 연산, `&&`·쉼표의 왼쪽, 바인딩에 대입하는 왼쪽은 흘려보내지 않는다.
 * `module.exports = x`·`exports.a = x`는 내보내기라 흘려보내지 않는다(그 뒤 쓰기는 {@link skipOverrideOf}가 따로 본다).
 *
 * @param binary 이항식
 * @param operand 바인딩을 담은 피연산자
 * @returns 흘려보내면 true
 */
function bindingFlowsThroughBinary(binary: ts.BinaryExpression, operand: ts.Expression): boolean {
  const operator = binary.operatorToken.kind;
  // 바인딩에 다른 값을 대입하는 자리(`exports.users = fn`, `x ||= y`)는 지금 값에 심볼을 쓰지 않는다.
  if (isAssignmentOperator(operator) && binary.left === operand) return false;
  if (operator === ts.SyntaxKind.EqualsToken && binary.right === operand) return !isModuleExportsReference(exportsRoot(unwrap(binary.left)));
  if (isAssignmentOperator(operator)) return true;
  // 함수 값은 참이라 `plugin && x`·`plugin, x`는 오른쪽 값을 돌려준다(왼쪽의 함수는 흘러가지 않는다).
  if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.CommaToken) return binary.right === operand;
  return operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken;
}

/**
 * `module.exports.a.b`·`exports.a`의 뿌리(`module.exports`·`exports`)다.
 *
 * @param expression 대입 대상
 * @returns 뿌리 식
 */
function exportsRoot(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) && !isModuleExportsReference(current)) current = current.expression;
  return current;
}

/**
 * 연산자가 대입(복합 대입 포함)인지 본다.
 *
 * @param operator 연산자
 * @returns 대입이면 true
 */
function isAssignmentOperator(operator: ts.SyntaxKind): boolean {
  return operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment;
}

/**
 * 원소 접근이 쓰기 대상(대입 왼쪽, `delete`, `++`·`--`)인지 본다.
 *
 * @param access 원소 접근
 * @returns 쓰기 대상이면 true
 */
function isWriteTarget(access: ts.ElementAccessExpression): boolean {
  const outer = outermostWrapper(access);
  const parent = outer.parent;
  if (ts.isBinaryExpression(parent)) return parent.left === outer && isAssignmentOperator(parent.operatorToken.kind);
  if (ts.isDeleteExpression(parent)) return true;
  return (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent))
    && (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken);
}

/**
 * 식이 `module.exports` 또는 `exports`인지 본다.
 *
 * @param expression 식
 * @returns 맞으면 true
 */
function isModuleExportsReference(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === 'exports';
  return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === 'module'
    && expression.name.text === 'exports';
}

/**
 * 모듈 최상위의 `module.exports = X` 문장인지 본다.
 *
 * @param node 노드
 * @returns 맞으면 true
 */
function isTopLevelModuleExportsAssignment(node: ts.Node): node is ts.BinaryExpression {
  return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isExpressionStatement(node.parent)
    && ts.isSourceFile(node.parent.parent) && isModuleExportsReference(unwrap(node.left));
}

/**
 * 바인딩을 쓰는 자리 하나를 분류한다.
 *
 * @param context 해석기 문맥
 * @param use 바인딩 식(식별자·속성 접근)
 * @returns 근거, 따라갈 바인딩, 또는 바꾸지 않음
 */
function classifyUse(context: InterpreterContext, use: ts.Expression): UseVerdict {
  const checker = context.checker;
  const outer = outermostWrapper(use);
  const parent = outer.parent;
  if (ts.isElementAccessExpression(parent)) return classifyWrite(checker, parent);
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name)
    && (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0) {
    const alias = resolvedSymbol(checker, parent.name);
    return alias === undefined ? 'unknown' : { follow: alias };
  }
  if (ts.isCallExpression(parent) && parent.expression !== outer) return classifyArgument(context, parent, outer);
  return 'unknown';
}

/**
 * 호출 인자로 넘긴 바인딩을 분류한다. `fastify-plugin` 한 인자 호출은 건너뜀(모듈 최상위·조건 없음일 때), `console.*`은 바꾸지 않음,
 * 프로젝트 함수는 받는 매개변수의 사용을 따라간다. 그 밖(패키지·전역 함수, 모르는 호출)은 모름이다 — `fastify-plugin`처럼 받은
 * 함수에 심볼을 쓰는 패키지가 있을 수 있다.
 *
 * @param context 해석기 문맥
 * @param call 호출
 * @param argument 인자 식
 * @returns 분류
 */
function classifyArgument(context: InterpreterContext, call: ts.CallExpression, argument: ts.Expression): UseVerdict {
  const checker = context.checker;
  if (calleeFromPackage(checker, call.expression, ['fastify-plugin'], ['default', '*', 'fastifyPlugin']) !== undefined) {
    return call.arguments.length === 1 && runsOnceAtTopLevel(call) ? 'yes' : 'unknown';
  }
  if (isConsoleCall(context, call)) return 'no';
  const parameter = parameterReceiving(context, call, argument);
  if (parameter === 'none') return 'no';
  return parameter === undefined ? 'unknown' : { follow: parameter };
}

/** 인자를 바꾸지 않는 `console` 메서드다. */
const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']);

/**
 * 호출이 전역 `console`의 출력 메서드인지 본다(프로젝트가 `console`을 다시 선언하지 않았다).
 *
 * @param context 해석기 문맥
 * @param call 호출
 * @returns 맞으면 true
 */
function isConsoleCall(context: InterpreterContext, call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || callee.expression.text !== 'console' || !CONSOLE_METHODS.has(callee.name.text)) return false;
  const symbol = symbolAt(context.checker, callee.expression);
  return (symbol?.declarations ?? []).every((declaration) => context.project.pathOf(declaration.getSourceFile()) === undefined);
}

/**
 * 프로젝트 함수 호출에서 인자를 받는 매개변수 심볼이다.
 *
 * @param context 해석기 문맥
 * @param call 호출
 * @param argument 인자 식
 * @returns 매개변수 심볼, 받는 매개변수가 없고 `arguments`·나머지 매개변수도 없으면 `'none'`, 모르면 undefined
 */
function parameterReceiving(context: InterpreterContext, call: ts.CallExpression, argument: ts.Expression): ts.Symbol | 'none' | undefined {
  const index = call.arguments.indexOf(argument);
  if (index < 0 || call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return undefined;
  const callee = projectFunction(context, call.expression);
  if (callee === undefined || readsArguments(callee)) return undefined;
  const parameters = callee.parameters.filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  const parameter = parameters[index];
  if (parameter === undefined) return parameters.some((candidate) => candidate.dotDotDotToken !== undefined) ? undefined : 'none';
  if (parameter.dotDotDotToken !== undefined || !ts.isIdentifier(parameter.name)) return undefined;
  const symbol = symbolAt(context.checker, parameter.name);
  return symbol === undefined ? undefined : resolveAlias(context.checker, symbol);
}

/**
 * 호출 대상이 가리키는 본문 있는 프로젝트 함수다(함수 선언, 메서드, 함수 식을 초기값으로 둔 변수·속성). 선언이 여럿이거나 본문이 없으면
 * undefined다.
 *
 * @param context 해석기 문맥
 * @param callee 호출 대상 식
 * @returns 함수 또는 undefined
 */
function projectFunction(context: InterpreterContext, callee: ts.Expression): ts.SignatureDeclaration | undefined {
  const node = unwrap(callee);
  const name = ts.isIdentifier(node) ? node : ts.isPropertyAccessExpression(node) ? node.name : undefined;
  const symbol = name === undefined ? undefined : symbolAt(context.checker, name);
  if (symbol === undefined) return undefined;
  const bodies = (resolveAlias(context.checker, symbol).declarations ?? []).flatMap((declaration) => {
    const fn = functionOfDeclaration(declaration);
    return fn === undefined ? [] : [fn];
  });
  const only = bodies.length === 1 ? bodies[0]! : undefined;
  return only !== undefined && context.project.pathOf(only.getSourceFile()) !== undefined ? only : undefined;
}

/**
 * 선언이 담은 본문 있는 함수다.
 *
 * @param declaration 선언
 * @returns 함수 또는 undefined
 */
function functionOfDeclaration(declaration: ts.Declaration): ts.SignatureDeclaration | undefined {
  if ((ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) && declaration.body !== undefined) return declaration;
  if (!(ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) || declaration.initializer === undefined) return undefined;
  const initializer = unwrap(declaration.initializer);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : undefined;
}

/**
 * 함수 본문이 `arguments`를 읽는지 본다(매개변수 밖에서 인자에 닿을 수 있다).
 *
 * @param fn 함수
 * @returns 읽으면 true
 */
function readsArguments(fn: ts.SignatureDeclaration): boolean {
  const cached = argumentsMemo.get(fn);
  if (cached !== undefined) return cached;
  let found = false;
  const stack: ts.Node[] = [fn];
  while (stack.length > 0 && !found) {
    const node = stack.pop()!;
    if (ts.isIdentifier(node) && node.text === 'arguments') found = true;
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
  argumentsMemo.set(fn, found);
  return found;
}

/** 함수 → 본문이 `arguments`를 읽는지 메모다. */
const argumentsMemo = new WeakMap<ts.SignatureDeclaration, boolean>();

/**
 * 원소 쓰기 하나가 skip-override에 주는 근거다. 문자열·숫자 키와 다른 이름의 `Symbol.for()`는 그 심볼을 바꾸지 못한다.
 *
 * @param checker TypeChecker
 * @param write 원소 쓰기
 * @returns 근거
 */
function classifyWrite(checker: ts.TypeChecker, write: ts.ElementAccessExpression): SkipOverride {
  const key = keyKind(checker, write.argumentExpression);
  if (key === 'other') return 'no';
  if (key === 'unknown') return 'unknown';
  const parent = outermostWrapper(write).parent;
  const assigned = ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? unwrap(parent.right) : undefined;
  return assigned !== undefined && isTruthyLiteral(assigned) && runsOnceAtTopLevel(parent) ? 'yes' : 'unknown';
}

/**
 * 바인딩으로 잇지 못한 skip-override 키 쓰기를 모은 전역 근거다(한 번 만든다). 대상이 이름 있는 바인딩·속성이면 그 바인딩의 근거로
 * 세고, 매개변수·반복 변수·구조 분해·`catch` 변수처럼 값의 출처를 모르는 바인딩이나 원소 접근·호출 결과 같은 대상이면 어느
 * 플러그인이든 그 값일 수 있다.
 *
 * @param census census
 * @param context 해석기 문맥
 * @returns 파일별 근거
 */
function globalEvidence(census: SkipCensus, context: InterpreterContext): Evidence {
  if (census.global !== undefined) return census.global;
  const evidence: Evidence = new Map();
  for (const write of census.computedWrites) {
    if (keyKind(context.checker, write.argumentExpression) !== 'skip') continue;
    const symbol = attributedSymbol(context.checker, unwrap(write.expression));
    if (symbol === undefined || !hasKnownValue(symbol)) addLevel(evidence, write.getSourceFile(), 'unknown');
  }
  census.global = evidence;
  return evidence;
}

/**
 * 원소 쓰기 대상이 이름 있는 바인딩·속성이면 그 심볼이다(그 쓰기는 바인딩의 근거로 센다).
 *
 * @param checker TypeChecker
 * @param target 쓰기 대상 식
 * @returns 심볼 또는 undefined
 */
function attributedSymbol(checker: ts.TypeChecker, target: ts.Expression): ts.Symbol | undefined {
  return ts.isIdentifier(target) || ts.isPropertyAccessExpression(target) ? resolvedSymbol(checker, target) : undefined;
}

/**
 * 바인딩이 선언에서 값을 정하는지 본다(함수·클래스 선언, 초기값 있는 변수·속성). 매개변수·반복 변수·구조 분해·`catch` 변수는 값이 어디서
 * 오는지 이 census가 따라가지 않는다.
 *
 * @param symbol 심볼
 * @returns 정하면 true
 */
function hasKnownValue(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some((declaration) => ts.isFunctionDeclaration(declaration) || ts.isClassDeclaration(declaration)
    || ts.isMethodDeclaration(declaration) || ts.isEnumDeclaration(declaration)
    || ((ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration))
      && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined));
}

/**
 * 모듈 객체가 흘러간 모듈 파일과 그 자리다(한 번 만든다). 계산된 키 쓰기의 대상이 모듈 객체에서 원소로 읽은 값이면 그 모듈도 넣는다.
 * 프로젝트 밖(패키지) 모듈은 프로젝트 플러그인을 담지 않으므로 뺀다.
 *
 * @param census census
 * @param context 해석기 문맥
 * @returns 모듈 파일 → 모듈 심볼과 파일별 근거
 */
function escapedModules(census: SkipCensus, context: InterpreterContext): Map<ts.SourceFile, EscapedModule> {
  if (census.escapedModules !== undefined) return census.escapedModules;
  const modules = new Map<ts.SourceFile, EscapedModule>();
  const record = (expression: ts.Expression, site: ts.Node): void => {
    const found = moduleOfObject(context, expression);
    if (found === undefined) return;
    const entry = modules.get(found.file) ?? { symbol: found.symbol, evidence: new Map<ts.SourceFile, Level>() };
    entry.symbol ??= found.symbol;
    addLevel(entry.evidence, site.getSourceFile(), 'unknown');
    modules.set(found.file, entry);
  };
  for (const use of census.moduleObjectUses) record(use, use);
  for (const write of census.computedWrites) {
    const target = unwrap(write.expression);
    if (attributedSymbol(context.checker, target) !== undefined) continue;
    const root = accessRoot(target);
    if (root !== target && (ts.isIdentifier(root) || isModuleObjectCall(root) || isModuleExportsReference(root))) record(root, write);
  }
  census.escapedModules = modules;
  return modules;
}

/**
 * 원소·속성 접근 사슬의 뿌리 식이다.
 *
 * @param expression 식
 * @returns 뿌리
 */
function accessRoot(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isElementAccessExpression(current) || ts.isPropertyAccessExpression(current)) current = unwrap(current.expression);
  return current;
}

/**
 * 모듈 객체 식이 가리키는 프로젝트 모듈 파일이다.
 *
 * @param context 해석기 문맥
 * @param expression 모듈 객체 식(네임스페이스 이름·`require()`·`import()`·`module.exports`)
 * @returns 모듈 파일과 모듈 심볼(지정자로 찾았을 때), 프로젝트 모듈이 아니면 undefined
 */
function moduleOfObject(context: InterpreterContext, expression: ts.Expression): { readonly file: ts.SourceFile; readonly symbol: ts.Symbol | undefined } | undefined {
  const checker = context.checker;
  if (isModuleExportsReference(expression)) return { file: expression.getSourceFile(), symbol: undefined };
  let specifier: ts.Expression | undefined;
  if (isModuleObjectCall(expression)) specifier = expression.arguments[0];
  else if (ts.isIdentifier(expression)) {
    const declaration = symbolAt(checker, expression)?.declarations?.[0];
    if (declaration !== undefined && ts.isNamespaceImport(declaration)) specifier = declaration.parent.parent.moduleSpecifier;
    else if (declaration !== undefined && ts.isImportEqualsDeclaration(declaration) && ts.isExternalModuleReference(declaration.moduleReference)) specifier = declaration.moduleReference.expression;
    else if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
      const initializer = unwrap(declaration.initializer);
      if (isModuleObjectCall(initializer)) specifier = initializer.arguments[0];
    }
  }
  const symbol = specifier === undefined ? undefined : symbolAt(checker, specifier);
  const module = symbol?.valueDeclaration;
  return module !== undefined && ts.isSourceFile(module) && context.project.pathOf(module) !== undefined ? { file: module, symbol } : undefined;
}

/**
 * 원소 접근 키의 종류다: skip-override 심볼, 그것과 다른 키, 모름.
 *
 * @param checker TypeChecker
 * @param key 키 식
 * @returns 종류
 */
function keyKind(checker: ts.TypeChecker, key: ts.Expression): 'skip' | 'other' | 'unknown' {
  const node = unwrap(key);
  if (isOtherKeyLiteral(node)) return 'other';
  const symbolFor = symbolForName(node);
  if (symbolFor !== undefined) return 'skip';
  if (!ts.isIdentifier(node)) return 'unknown';
  const symbol = symbolAt(checker, node);
  const declaration = symbol === undefined ? undefined : resolveAlias(checker, symbol).valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
    || (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return 'unknown';
  const initial = symbolForName(unwrap(declaration.initializer));
  return initial === undefined ? 'unknown' : initial === 'skip-override' ? 'skip' : 'other';
}

/**
 * 키가 구문만으로 skip-override 심볼일 수 없는지 본다(문자열·숫자 리터럴, 다른 이름의 `Symbol.for()`).
 *
 * @param key 키 식
 * @returns 그럴 수 없으면 true
 */
function isOtherKeyLiteral(key: ts.Expression): boolean {
  const node = unwrap(key);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return true;
  const name = symbolForName(node);
  return name !== undefined && name !== 'skip-override';
}

/**
 * `Symbol.for('<이름>')` 호출이면 그 이름이다.
 *
 * @param node 식
 * @returns 이름 또는 undefined
 */
function symbolForName(node: ts.Expression): string | undefined {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isPropertyAccessExpression(node.expression)) return undefined;
  const callee = node.expression;
  const argument = node.arguments[0]!;
  return ts.isIdentifier(callee.expression) && callee.expression.text === 'Symbol' && callee.name.text === 'for' && ts.isStringLiteralLike(argument)
    ? argument.text : undefined;
}

/**
 * 값이 참으로 평가되는 리터럴인지 본다.
 *
 * @param value 값 식
 * @returns 참 리터럴이면 true
 */
function isTruthyLiteral(value: ts.Expression): boolean {
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (ts.isNumericLiteral(value)) return Number(value.text) !== 0;
  if (ts.isStringLiteralLike(value)) return value.text.length > 0;
  return ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value) || ts.isArrowFunction(value) || ts.isFunctionExpression(value);
}

/**
 * 노드가 모듈 최상위에서 조건 없이 한 번 실행되는지 본다(함수 안·조건·반복·단락 평가 아래가 아니다).
 *
 * @param node 노드
 * @returns 그렇다면 true
 */
function runsOnceAtTopLevel(node: ts.Node): boolean {
  for (let current = node.parent; !ts.isSourceFile(current); current = current.parent) {
    const passes = ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current) || ts.isCallExpression(current)
      || ts.isVariableDeclaration(current) || ts.isVariableDeclarationList(current) || ts.isVariableStatement(current)
      || ts.isExpressionStatement(current) || ts.isAwaitExpression(current) || ts.isExportAssignment(current)
      || (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken);
    if (!passes) return false;
  }
  return true;
}
