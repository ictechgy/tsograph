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
 *   별칭(그 별칭의 사용도 함께 본다), 대상이 정적으로 하나인 프로젝트 함수(다시 대입하지 않는 함수 선언·`const` 함수)의 매개변수
 *   자리(그 매개변수의 사용을 따라 본다). 메서드·`let`·다시 대입하는 바인딩을 부르는 호출은 실제로 부를 함수를 몰라 모른다.
 *   따라가는 관계가 순환하면(서로 부르는 도우미) 강연결 요소마다 근거를 합친다.
 * - 바인딩으로 이을 수 없는 대상(매개변수·반복 변수·원소 접근·호출 결과)에 skip-override 키를 쓰는 곳이 있으면 어느 플러그인이든 모른다.
 *   모듈 객체(네임스페이스 import, `require()`·`import()`, `module.exports`, TS 네임스페이스, 다시 내보낸 네임스페이스)가 호출 인자·컨테이너·
 *   대입으로 흘러가거나 원소 접근으로 읽히면, 그 모듈이 (다시 내보낸 것까지) 내보낸 플러그인을 모른다.
 *
 * 근거는 파일마다 모은다. 등록 호출이 있는 파일, 플러그인 함수가 있는 파일, 등록 인자에서 따라간 바인딩을 선언한 파일은 늘 보고
 * (테스트 디렉터리 이름이어도 서버가 실제로 불러 쓰는 코드다), 그 밖에는 해석 대상 파일과 해석 대상 파일이 (거쳐서라도) 불러오는 파일을
 * 본다. 테스트 소스의 근거는 테스트 소스에 있지 않은 등록에 대해 많아야 `'unknown'`이다(테스트 디렉터리 판정은 이름 규칙이라 단정하지
 * 않는다).
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
 * 지금까지 사용 자리를 살펴본 수다. 같은 이름의 사용을 등록마다 다시 훑거나 같은 바인딩을 다시 분류하지 않는지(등록 수·도우미 순환
 * 모양과 상관없이 사용 자리마다 한 번씩인지) 테스트가 본다.
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
  /** `require()`·`import()` 호출과 `module.exports`·`exports`가 흘러가는 자리(모듈 객체 이름은 판정할 때 심볼로 찾는다) */
  readonly moduleObjectUses: readonly ts.Expression[];
  /** 이름별로 모은, 대입 대상 식별자·속성 접근(`x = …`, `x++`, 구조 분해 대입, `for (x of …)`, `globalThis.x = …`) */
  readonly assignedTargets: ReadonlyMap<string, readonly ts.Expression[]>;
  /** 이름별로 모은, 모듈 객체일 때만 흘러가는 자리의 식별자·속성 접근(원소 접근 대상 `P[k]`, `exports.x = P`의 오른쪽) */
  readonly objectOnlyUses: ReadonlyMap<string, readonly ts.Expression[]>;
  /** 모듈 객체일 수 있는 이름(네임스페이스 import, `import x = require()`, `require()`·`import()` 결과 변수, TS 네임스페이스, 다시 내보낸 이름) */
  readonly moduleObjectNames: ReadonlySet<string>;
  /** 파일별 모듈 지정자(값을 불러오는 import·export·`import x = require()`·`require()`·`import()`) */
  readonly moduleSpecifiers: ReadonlyMap<ts.SourceFile, readonly ts.StringLiteralLike[]>;
  /** 이름 → 심볼별 사용(그 이름을 처음 물을 때 만든다) */
  readonly usesBySymbol: Map<string, Map<ts.Symbol, ts.Expression[]>>;
  /** 심볼 → import 지역 이름(첫 질의 때 만든다) */
  aliasIndex: Map<ts.Symbol, string[]> | undefined;
  /** 바인딩별 근거 메모 */
  readonly evidence: Map<ts.Symbol, Evidence>;
  /** 함수 바인딩 → 다른 값이 대입되는지 메모 */
  readonly reassigned: Map<ts.Symbol, boolean>;
  /** 바인딩으로 잇지 못한 skip-override 키 쓰기(모든 플러그인의 근거, 첫 질의 때 만든다) */
  global: Evidence | undefined;
  /** 모듈 객체가 흘러가 이름 없이 닿을 수 있게 된 내보낸 값(첫 질의 때 만든다) */
  escapedExports: EscapedExports | undefined;
  /** 운영 소스가 (다시) 불러오는, 해석 대상에서 빠진 파일(첫 질의 때 만든다) */
  importedExcluded: ReadonlySet<ts.SourceFile> | undefined;
}

/** 모듈 객체가 흘러가 이름 없이 닿을 수 있게 된 내보낸 값과 그 자리의 근거다. */
interface EscapedExports {
  /** 별칭을 따라간 내보낸 심볼 → 근거 */
  readonly symbols: Map<ts.Symbol, Evidence>;
  /** 그 심볼의 선언 노드 → 근거(내보낸 객체 안에 선언한 플러그인을 찾는다) */
  readonly declarations: Map<ts.Node, Evidence>;
  /** 모듈 심볼 없이 만난 모듈 파일(`module.exports`·`exports` 객체, TS 파일의 상대 `require()`) → 근거(그 파일의 플러그인 모두) */
  readonly files: Map<ts.SourceFile, Evidence>;
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
  for (const symbol of tracked) mergeInto(merged, evidenceOf(census, context, symbol));
  const file = fn.getSourceFile();
  const exportsFunction = (census.moduleExports.get(file) ?? []).some((value) => value === fn
    || (ts.isIdentifier(value) && tracked.has(resolvedSymbol(checker, value) as ts.Symbol)));
  if (exportsFunction) for (const write of census.moduleExportWrites.get(file) ?? []) addLevel(merged, write.getSourceFile(), classifyWrite(checker, write));
  mergeInto(merged, globalEvidence(census, context));
  const declarations = [fn, ...[...tracked].flatMap((symbol) => symbol.declarations ?? [])];
  mergeEscapedExports(merged, escapedExports(census, context), tracked, declarations);
  const privileged = new Set([...declarations.map((declaration) => declaration.getSourceFile()), call.getSourceFile()]);
  return verdictOf(census, context, merged, privileged, call.getSourceFile());
}

/**
 * 모듈 객체가 흘러가 이름 없이 닿을 수 있게 된 값의 근거를 더한다: 바인딩이 그 내보낸 심볼이거나, 플러그인·바인딩 선언이 내보낸 선언 안에
 * 있거나, 심볼 없이 만난 `module.exports` 파일에 있으면 그 자리의 근거다.
 *
 * @param merged 합칠 근거
 * @param escaped 흘러간 내보낸 값
 * @param tracked 바인딩 심볼
 * @param declarations 플러그인 함수와 바인딩 선언
 */
function mergeEscapedExports(merged: Evidence, escaped: EscapedExports, tracked: ReadonlySet<ts.Symbol>, declarations: readonly ts.Node[]): void {
  for (const symbol of tracked) mergeInto(merged, escaped.symbols.get(symbol));
  for (const declaration of declarations) {
    mergeInto(merged, escaped.files.get(declaration.getSourceFile()));
    for (let current: ts.Node | undefined = declaration; current !== undefined && !ts.isSourceFile(current); current = current.parent) {
      mergeInto(merged, escaped.declarations.get(current));
    }
  }
}

/**
 * 파일별 근거를 등록 하나에 대한 판정으로 줄인다. 늘 보는 파일(등록·플러그인·바인딩 선언 파일)이 아니면 해석 대상 파일과, 해석 대상에서
 * 빠졌지만 해석 대상 파일이 불러오는 파일의 근거만 쓴다. 테스트 소스에 있지 않은 등록에 대한 테스트 소스의 근거는 많아야 `'unknown'`이다
 * (해석 대상에서 빠지는 파일은 테스트 소스뿐이라 불러오는 파일의 근거도 여기서 줄어든다).
 *
 * @param census census
 * @param context 해석기 문맥
 * @param evidence 파일별 근거
 * @param privileged 늘 보는 파일
 * @param registrationFile 등록 호출이 있는 파일
 * @returns 판정
 */
function verdictOf(census: SkipCensus, context: InterpreterContext, evidence: Evidence, privileged: ReadonlySet<ts.SourceFile>, registrationFile: ts.SourceFile): SkipOverride {
  const registrationInTests = isTestSource(context, registrationFile);
  const importedExcluded = importedExcludedFiles(census, context);
  let result: SkipOverride = 'no';
  for (const [file, level] of evidence) {
    if (!privileged.has(file)) {
      const path = context.project.pathOf(file);
      if (path === undefined || (!context.includesFile(path) && !importedExcluded.has(file))) continue;
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
 * 바인딩 하나의 파일별 근거다(메모한다). `const` 별칭과 매개변수로 흘러간 자리는 그 바인딩의 근거를 합친다.
 *
 * 흘러가는 관계는 순환할 수 있다(서로 부르는 도우미). Tarjan 강연결 요소를 재귀 없이 구해, 한 요소의 바인딩은 모두 요소 안의 근거와 요소
 * 밖으로 이어지는 근거의 합을 갖는다. 바인딩마다 사용 자리를 한 번만 분류하므로 비용은 살펴본 사용 수에 선형이고, 긴 도우미 사슬에서도
 * 호출 스택이 자라지 않는다.
 *
 * @param census census
 * @param context 해석기 문맥
 * @param root 바인딩 심볼
 * @returns 근거
 */
function evidenceOf(census: SkipCensus, context: InterpreterContext, root: ts.Symbol): Evidence {
  const memo = census.evidence.get(root);
  if (memo !== undefined) return memo;
  const order = new Map<ts.Symbol, number>();
  const low = new Map<ts.Symbol, number>();
  const local = new Map<ts.Symbol, Evidence>();
  const stack: ts.Symbol[] = [];
  const onStack = new Set<ts.Symbol>();
  const frames: { readonly symbol: ts.Symbol; readonly next: readonly ts.Symbol[]; position: number }[] = [];
  const open = (symbol: ts.Symbol): void => {
    order.set(symbol, order.size);
    low.set(symbol, order.get(symbol)!);
    stack.push(symbol);
    onStack.add(symbol);
    const evidence: Evidence = new Map();
    const next: ts.Symbol[] = [];
    for (const use of usesOf(census, context.checker, symbol)) {
      visitedUses++;
      const verdict = classifyUse(census, context, use);
      if (typeof verdict === 'string') addLevel(evidence, use.getSourceFile(), verdict);
      else next.push(verdict.follow);
    }
    local.set(symbol, evidence);
    frames.push({ symbol, next, position: 0 });
  };
  open(root);
  while (frames.length > 0) {
    const frame = frames[frames.length - 1]!;
    if (frame.position < frame.next.length) {
      const target = frame.next[frame.position++]!;
      const done = census.evidence.get(target);
      if (done !== undefined) mergeInto(local.get(frame.symbol)!, done);
      else if (!order.has(target)) open(target);
      else if (onStack.has(target)) low.set(frame.symbol, Math.min(low.get(frame.symbol)!, order.get(target)!));
      continue;
    }
    frames.pop();
    const parent = frames[frames.length - 1];
    if (low.get(frame.symbol) === order.get(frame.symbol)) {
      const members: ts.Symbol[] = [];
      let member: ts.Symbol;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
      } while (member !== frame.symbol);
      const evidence: Evidence = new Map();
      for (const each of members) mergeInto(evidence, local.get(each));
      for (const each of members) census.evidence.set(each, evidence);
      if (parent !== undefined) mergeInto(local.get(parent.symbol)!, evidence);
    } else if (parent !== undefined) {
      low.set(parent.symbol, Math.min(low.get(parent.symbol)!, low.get(frame.symbol)!));
    }
  }
  return census.evidence.get(root)!;
}

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
  const assignedTargets = new Map<string, ts.Expression[]>();
  const objectOnlyUses = new Map<string, ts.Expression[]>();
  const moduleObjectNames = new Set<string>();
  const moduleSpecifiers = new Map<ts.SourceFile, ts.StringLiteralLike[]>();
  const lists = {
    usesByName, aliasNames, moduleExports, moduleExportWrites, computedWrites, moduleObjectUses, assignedTargets, objectOnlyUses, moduleObjectNames,
    moduleSpecifiers,
  };
  for (const sourceFile of context.project.files.values()) {
    const stack: ts.Node[] = [sourceFile];
    while (stack.length > 0) {
      const node = stack.pop()!;
      visitNode(node, sourceFile, lists);
      ts.forEachChild(node, (child) => { stack.push(child); });
    }
  }
  return {
    ...lists, usesBySymbol: new Map(), aliasIndex: undefined, evidence: new Map(), reassigned: new Map(), global: undefined, escapedExports: undefined,
    importedExcluded: undefined,
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
  readonly assignedTargets: Map<string, ts.Expression[]>;
  readonly objectOnlyUses: Map<string, ts.Expression[]>;
  readonly moduleObjectNames: Set<string>;
  readonly moduleSpecifiers: Map<ts.SourceFile, ts.StringLiteralLike[]>;
}

/**
 * 노드 하나를 census 목록에 분류한다.
 *
 * @param node 노드
 * @param sourceFile 파일
 * @param lists 목록
 */
function visitNode(node: ts.Node, sourceFile: ts.SourceFile, lists: CensusLists): void {
  if (ts.isIdentifier(node)) {
    visitReference(node, node.text, lists);
  } else if (ts.isPropertyAccessExpression(node)) {
    visitReference(node, node.name.text, lists);
  } else if (ts.isElementAccessExpression(node) && isWriteTarget(node)) {
    const target = unwrap(node.expression);
    if (isModuleExportsReference(target)) pushTo(lists.moduleExportWrites, sourceFile, node);
    else if (!isOtherKeyLiteral(node.argumentExpression)) lists.computedWrites.push(node);
  } else if (isModuleObjectCall(node)) {
    pushTo(lists.moduleSpecifiers, sourceFile, node.arguments[0] as ts.StringLiteralLike);
    if (moduleObjectEscapes(node)) lists.moduleObjectUses.push(node);
  } else if (isTopLevelModuleExportsAssignment(node)) {
    pushTo(lists.moduleExports, sourceFile, unwrap(node.right));
  } else {
    visitModuleSyntax(node, sourceFile, lists);
  }
}

/**
 * 식별자·속성 접근 하나를 census 목록에 분류한다.
 *
 * @param node 식별자 또는 속성 접근
 * @param name 이름(속성 접근이면 속성 이름)
 * @param lists 목록
 */
function visitReference(node: ts.Identifier | ts.PropertyAccessExpression, name: string, lists: CensusLists): void {
  if (ts.isIdentifier(node)) {
    if (isAliasName(node)) {
      lists.aliasNames.push(node);
      return;
    }
    if (!isValueReference(node)) return;
  }
  if (isModuleExportsReference(node)) {
    if (moduleObjectEscapes(node)) lists.moduleObjectUses.push(node);
    return;
  }
  if (mayChangeBinding(node)) pushTo(lists.usesByName, name, node);
  if (isAssignmentTarget(node)) pushTo(lists.assignedTargets, name, node);
  if (isObjectOnlyUse(node)) pushTo(lists.objectOnlyUses, name, node);
}

/**
 * 모듈 지정자와 모듈 객체일 수 있는 이름을 모은다.
 *
 * @param node 노드
 * @param sourceFile 파일
 * @param lists 목록
 */
function visitModuleSyntax(node: ts.Node, sourceFile: ts.SourceFile, lists: CensusLists): void {
  if (ts.isImportDeclaration(node) && !(node.importClause?.isTypeOnly ?? false) && ts.isStringLiteralLike(node.moduleSpecifier)) {
    pushTo(lists.moduleSpecifiers, sourceFile, node.moduleSpecifier);
  } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier !== undefined && ts.isStringLiteralLike(node.moduleSpecifier)) {
    pushTo(lists.moduleSpecifiers, sourceFile, node.moduleSpecifier);
  } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
    if (ts.isStringLiteralLike(node.moduleReference.expression)) pushTo(lists.moduleSpecifiers, sourceFile, node.moduleReference.expression);
    lists.moduleObjectNames.add(node.name.text);
  } else if (ts.isNamespaceImport(node) || ts.isNamespaceExport(node) || ts.isExportSpecifier(node)) {
    if (ts.isIdentifier(node.name)) lists.moduleObjectNames.add(node.name.text);
  } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
    lists.moduleObjectNames.add(node.name.text);
  } else if (ts.isVariableDeclaration(node) && node.initializer !== undefined && isModuleObjectCall(unwrap(node.initializer))) {
    for (const name of boundNames(node.name)) lists.moduleObjectNames.add(name);
  }
}

/**
 * 바인딩 이름(구조 분해 포함)의 식별자 이름이다.
 *
 * @param name 바인딩 이름
 * @returns 이름
 */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : boundNames(element.name));
}

/**
 * 식별자·속성 접근이 모듈 객체일 때만 흘러가는 자리에 있는지 본다: 원소 접근의 대상(`P[k]`), `module.exports`·`exports` 아래에 대입하는
 * 값(`exports.x = P`). 바인딩이면 이 자리는 바꾸지 않는 자리이거나 따로 센다.
 *
 * @param node 식별자 또는 속성 접근
 * @returns 그렇다면 true
 */
function isObjectOnlyUse(node: ts.Expression): boolean {
  const outer = outermostWrapper(node);
  const parent = outer.parent;
  if (ts.isElementAccessExpression(parent)) return parent.expression === outer;
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === outer
    && isModuleExportsReference(exportsRoot(unwrap(parent.left)));
}

/**
 * 식별자·속성 접근이 대입 대상인지 본다(`x = …`, 복합 대입, `x++`, 구조 분해 대입 안, `for (x of …)`·`for (x in …)`).
 *
 * @param node 식별자 또는 속성 접근
 * @returns 대입 대상이면 true
 */
function isAssignmentTarget(node: ts.Expression): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent: ts.Node = current.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)
      || ts.isTypeAssertionExpression(parent) || ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent) || ts.isSpreadElement(parent)
      || ts.isSpreadAssignment(parent) || (ts.isShorthandPropertyAssignment(parent) && parent.name === current)
      || (ts.isPropertyAssignment(parent) && parent.initializer === current)
      || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === current
        && (ts.isArrayLiteralExpression(parent.parent) || ts.isObjectLiteralExpression(parent.parent) || ts.isPropertyAssignment(parent.parent)))) {
      current = parent;
      continue;
    }
    if (ts.isBinaryExpression(parent)) return parent.left === current && isAssignmentOperator(parent.operatorToken.kind);
    if (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) return parent.initializer === current;
    if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
      return parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken;
    }
    return false;
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
 * 모듈 객체 식이 흘러가거나(호출 인자·컨테이너·다른 변수·대입·`then` 콜백) 원소 접근으로 읽혀, 그 모듈의 내보낸 값에 이름 없이 닿을 수
 * 있는지 본다. `exports.x = P`처럼 모듈 객체를 내보내는 대입도 흘러간 것으로 본다(TypeScript가 그 내보내기를 모듈 별칭으로 잇지 않는다).
 * 모듈 객체 자체에 대입하는 자리(`module.exports = …`, `module.exports[k] = …`)는 내보낸 값을 읽지 않는다(`module.exports[k]` 쓰기는
 * {@link skipOverrideOf}가 따로 본다).
 * 점 접근(`P.users`)은 속성 심볼로 따로 세고, 호출 대상·`register()` 첫 인자, 이름 하나에 담는 `require()`·`import()` 결과의 변수
 * 초기값은 흘려보내지 않는다(그 이름의 사용을 따로 본다). JS 파일의 `const { a } = require()`는 TypeScript가 이름마다 그 내보내기의
 * 별칭으로 잇는다. 그 밖의 구조 분해는 흘러간 것으로 본다.
 *
 * @param node 모듈 객체 식
 * @returns 흘러가면 true
 */
function moduleObjectEscapes(node: ts.Expression): boolean {
  const outer = outermostWrapper(node);
  const parent = outer.parent;
  if (ts.isElementAccessExpression(parent) && parent.expression === outer) return !isWriteTarget(parent);
  if (ts.isBinaryExpression(parent) && isAssignmentOperator(parent.operatorToken.kind)) return parent.right === outer;
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
    const call = unwrap(outer);
    if (!isModuleObjectCall(call)) return true;
    if (ts.isIdentifier(parent.name)) return false;
    return !(isRequireCall(call) && (call.flags & ts.NodeFlags.JavaScriptFile) !== 0 && ts.isObjectBindingPattern(parent.name));
  }
  if (ts.isAwaitExpression(parent)) return moduleObjectEscapes(parent);
  if (ts.isPropertyAccessExpression(parent)) return isModuleObjectCall(node) && !isRequireCall(node);
  return mayChangeBinding(node);
}

/**
 * 호출이 `require('…')`인지 본다(`import('…')`가 아니다).
 *
 * @param node 노드
 * @returns 맞으면 true
 */
function isRequireCall(node: ts.Node): boolean {
  return isModuleObjectCall(node) && ts.isIdentifier(node.expression);
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
 * @param census census
 * @param context 해석기 문맥
 * @param use 바인딩 식(식별자·속성 접근)
 * @returns 근거, 따라갈 바인딩, 또는 바꾸지 않음
 */
function classifyUse(census: SkipCensus, context: InterpreterContext, use: ts.Expression): UseVerdict {
  const checker = context.checker;
  const outer = outermostWrapper(use);
  const parent = outer.parent;
  if (ts.isElementAccessExpression(parent)) return classifyWrite(checker, parent);
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name)
    && (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0) {
    const alias = resolvedSymbol(checker, parent.name);
    return alias === undefined ? 'unknown' : { follow: alias };
  }
  if (ts.isCallExpression(parent) && parent.expression !== outer) return classifyArgument(census, context, parent, outer);
  return 'unknown';
}

/**
 * 호출 인자로 넘긴 바인딩을 분류한다. `fastify-plugin` 한 인자 호출은 건너뜀(모듈 최상위·조건 없음일 때), `console.*`은 바꾸지 않음,
 * 호출 대상이 정적으로 하나로 정해지는 프로젝트 함수면 받는 매개변수의 사용을 따라간다({@link projectFunction}). 그 밖(패키지·전역 함수,
 * 메서드, 다시 대입할 수 있는 바인딩, 모르는 호출)은 모름이다 — `fastify-plugin`처럼 받은 함수에 심볼을 쓰는 패키지가 있을 수 있다.
 *
 * @param census census
 * @param context 해석기 문맥
 * @param call 호출
 * @param argument 인자 식
 * @returns 분류
 */
function classifyArgument(census: SkipCensus, context: InterpreterContext, call: ts.CallExpression, argument: ts.Expression): UseVerdict {
  const checker = context.checker;
  if (calleeFromPackage(checker, call.expression, ['fastify-plugin'], ['default', '*', 'fastifyPlugin']) !== undefined) {
    return call.arguments.length === 1 && runsOnceAtTopLevel(call) ? 'yes' : 'unknown';
  }
  if (isConsoleCall(context, call)) return 'no';
  const parameter = parameterReceiving(census, context, call, argument);
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
 * @param census census
 * @param context 해석기 문맥
 * @param call 호출
 * @param argument 인자 식
 * @returns 매개변수 심볼, 받는 매개변수가 없고 `arguments`·나머지 매개변수도 없으면 `'none'`, 모르면 undefined
 */
function parameterReceiving(census: SkipCensus, context: InterpreterContext, call: ts.CallExpression, argument: ts.Expression): ts.Symbol | 'none' | undefined {
  const index = call.arguments.indexOf(argument);
  if (index < 0 || call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return undefined;
  const callee = projectFunction(census, context, call.expression);
  if (callee === undefined || readsArguments(callee)) return undefined;
  const parameters = callee.parameters.filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'));
  const parameter = parameters[index];
  if (parameter === undefined) return parameters.some((candidate) => candidate.dotDotDotToken !== undefined) ? undefined : 'none';
  if (parameter.dotDotDotToken !== undefined || !ts.isIdentifier(parameter.name)) return undefined;
  const symbol = symbolAt(context.checker, parameter.name);
  return symbol === undefined ? undefined : resolveAlias(context.checker, symbol);
}

/**
 * 호출 대상이 정적으로 하나로 정해지는 본문 있는 프로젝트 함수다: 식별자 호출이고, 그 바인딩(별칭을 따라간 뒤)의 선언이 하나뿐이며 본문
 * 있는 함수 선언이거나 함수 식·화살표 함수를 초기값으로 둔 `const`이고, 프로젝트 어디서도 그 바인딩에 다른 값을 대입하지 않는다.
 * 메서드·속성 호출(재정의·다른 객체가 받을 수 있다), `let`·`var`, 다시 대입하는 바인딩은 실제로 부를 함수를 모르므로 undefined다.
 *
 * @param census census
 * @param context 해석기 문맥
 * @param callee 호출 대상 식
 * @returns 함수 또는 undefined
 */
function projectFunction(census: SkipCensus, context: InterpreterContext, callee: ts.Expression): ts.SignatureDeclaration | undefined {
  const node = unwrap(callee);
  const raw = ts.isIdentifier(node) ? symbolAt(context.checker, node) : undefined;
  if (raw === undefined) return undefined;
  const symbol = resolveAlias(context.checker, raw);
  const declarations = symbol.declarations ?? [];
  const fn = declarations.length === 1 ? staticFunctionOf(declarations[0]!) : undefined;
  if (fn === undefined || context.project.pathOf(fn.getSourceFile()) === undefined || isReassigned(census, context.checker, symbol)) return undefined;
  return fn;
}

/**
 * 선언이 바인딩에 묶는 본문 있는 함수다(함수 선언, 함수 식·화살표 함수를 초기값으로 둔 `const`).
 *
 * @param declaration 선언
 * @returns 함수 또는 undefined
 */
function staticFunctionOf(declaration: ts.Declaration): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionDeclaration(declaration)) return declaration.body === undefined ? undefined : declaration;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name) || declaration.initializer === undefined
    || (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return undefined;
  const initializer = unwrap(declaration.initializer);
  return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) ? initializer : undefined;
}

/**
 * 프로젝트 어딘가에서 바인딩에 다른 값을 대입하는지 본다(메모한다). 선언 이름·import 지역 이름으로 찾은 대입 대상 중 같은 심볼로 풀리는
 * 것이 있으면 참이다.
 *
 * @param census census
 * @param checker TypeChecker
 * @param symbol 바인딩 심볼
 * @returns 대입하면 true
 */
function isReassigned(census: SkipCensus, checker: ts.TypeChecker, symbol: ts.Symbol): boolean {
  const cached = census.reassigned.get(symbol);
  if (cached !== undefined) return cached;
  const declared = (symbol.declarations ?? []).flatMap((declaration) => {
    const name = (declaration as ts.Declaration & { readonly name?: ts.Node }).name;
    return name !== undefined && ts.isIdentifier(name) ? [name.text] : [];
  });
  const names = new Set([symbol.name, ...declared, ...(aliasIndexOf(census, checker).get(symbol) ?? [])]);
  const result = [...names].some((name) => (census.assignedTargets.get(name) ?? []).some((target) => resolvedSymbol(checker, target) === symbol));
  census.reassigned.set(symbol, result);
  return result;
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
 * 모듈 객체가 흘러가 이름 없이 닿을 수 있게 된 내보낸 값과 그 자리다(한 번 만든다). 모듈 객체는 `require()`·`import()` 호출,
 * `module.exports`·`exports`, 그리고 별칭을 따라가 모듈(파일 모듈·TS 네임스페이스)로 풀리는 식별자·속성 접근이다. 흘러간 모듈은
 * `getExportsOfModule`로 내보낸 값을 별칭 너머 선언까지 따라가고(`export *`·`export { a } from`·다시 내보낸 네임스페이스 포함), 그 값이 다시
 * 모듈이면 그 모듈도 펼친다. `module.exports`·`exports` 객체 자체와 심볼 없이 찾은 모듈(TS 파일의 상대 `require()`)은 그 파일의 플러그인 모두로 본다. 프로젝트 밖
 * (패키지) 모듈은 프로젝트 플러그인을 담지 않으므로 뺀다. 바인딩으로 잇지 못한 원소 쓰기는 {@link globalEvidence}가 따로 센다.
 *
 * @param census census
 * @param context 해석기 문맥
 * @returns 흘러간 내보낸 값
 */
function escapedExports(census: SkipCensus, context: InterpreterContext): EscapedExports {
  if (census.escapedExports !== undefined) return census.escapedExports;
  const checker = context.checker;
  const escaped: EscapedExports = { symbols: new Map(), declarations: new Map(), files: new Map() };
  const sitesByModule = new Map<ts.Symbol, Evidence>();
  const record = (expression: ts.Expression): void => {
    const found = moduleOfObject(context, expression);
    if (found === undefined) return;
    if (found.symbol !== undefined) addSite(sitesByModule, found.symbol, expression.getSourceFile());
    else addSite(escaped.files, found.file, expression.getSourceFile());
  };
  for (const use of census.moduleObjectUses) record(use);
  const names = new Set(census.moduleObjectNames);
  for (const [symbol, aliases] of aliasIndexOf(census, checker)) {
    if (isModuleSymbol(context, symbol)) for (const alias of aliases) names.add(alias);
  }
  for (const name of names) {
    for (const use of [...(census.usesByName.get(name) ?? []), ...(census.objectOnlyUses.get(name) ?? [])]) {
      if (moduleObjectEscapes(use)) record(use);
    }
  }
  for (const [file, sites] of escaped.files) escaped.files.set(file, countedOnce(census, context, sites));
  for (const [module, sites] of sitesByModule) {
    const reach = moduleClosure(context, module);
    const counted = countedOnce(census, context, sites);
    for (const symbol of reach.symbols) mergeAt(escaped.symbols, symbol, counted);
    for (const declaration of reach.declarations) mergeAt(escaped.declarations, declaration, counted);
  }
  census.escapedExports = escaped;
  return escaped;
}

/**
 * 흘러간 자리의 근거(모두 `'unknown'`)에서 판정 때 늘 세는 파일(해석 대상, 해석 대상이 불러오는 파일)은 하나만 남긴다. 그런 파일 하나면
 * {@link verdictOf}가 이미 모름이므로 판정은 같고, 같은 모듈 객체를 파일 수천 개가 흘려보내도 내보낸 값마다 근거가 하나로 준다. 그 밖의
 * 파일은 등록마다 늘 보는 파일일 때만 세므로 모두 남긴다.
 *
 * @param census census
 * @param context 해석기 문맥
 * @param sites 흘러간 자리의 근거
 * @returns 줄인 근거
 */
function countedOnce(census: SkipCensus, context: InterpreterContext, sites: Evidence): Evidence {
  const importedExcluded = importedExcludedFiles(census, context);
  const kept: Evidence = new Map();
  let counted = false;
  for (const [file, level] of sites) {
    const path = context.project.pathOf(file);
    const counts = path !== undefined && (context.includesFile(path) || importedExcluded.has(file));
    if (!counts || !counted) kept.set(file, level);
    counted ||= counts;
  }
  return kept;
}

/**
 * 모듈에서 이름 없이 닿는 내보낸 값이다: 내보낸 심볼(별칭을 따라간 뒤)과 그 선언, 내보낸 값이 다시 모듈이면 그 모듈의 것까지.
 * CommonJS 파일의 `exports.a = x`·`module.exports.a = x`도 TypeScript가 내보내기로 묶는다(오른쪽이 이름이면 그 별칭이다).
 *
 * @param context 해석기 문맥
 * @param module 모듈 심볼
 * @returns 닿는 심볼·선언
 */
function moduleClosure(context: InterpreterContext, module: ts.Symbol): { symbols: Set<ts.Symbol>; declarations: Set<ts.Node> } {
  const checker = context.checker;
  const reach = { symbols: new Set<ts.Symbol>(), declarations: new Set<ts.Node>() };
  const seen = new Set([module]);
  const queue = [module];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const target of moduleExportsOf(checker, current)) {
      reach.symbols.add(target);
      for (const declaration of target.declarations ?? []) {
        if (context.project.pathOf(declaration.getSourceFile()) !== undefined) reach.declarations.add(declaration);
      }
      if (isModuleSymbol(context, target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return reach;
}

/**
 * 모듈이 내보낸 값의 심볼이다(별칭을 따라간 뒤). `export =`·`module.exports =` 모듈은 TypeScript가 모듈 객체 식별자를 그 대상으로 바로
 * 풀어 주므로 여기까지 오지 않는다.
 *
 * @param checker TypeChecker
 * @param module 모듈 심볼
 * @returns 심볼
 */
function moduleExportsOf(checker: ts.TypeChecker, module: ts.Symbol): ts.Symbol[] {
  try {
    return checker.getExportsOfModule(module).map((symbol) => resolveAlias(checker, symbol));
  } catch {
    // 구문 오류가 있는 파일에서 checker가 던지면 내보낸 값을 모른다(심볼 없이 찾은 모듈처럼 파일로 보지 않고 빈 값으로 둔다).
    return [];
  }
}

/**
 * 심볼이 프로젝트 안의 모듈(파일 모듈 또는 값이 있는 TS 네임스페이스)인지 본다.
 *
 * @param context 해석기 문맥
 * @param symbol 심볼
 * @returns 맞으면 true
 */
function isModuleSymbol(context: InterpreterContext, symbol: ts.Symbol): boolean {
  if ((symbol.flags & ts.SymbolFlags.ValueModule) === 0) return false;
  const declaration = symbol.valueDeclaration;
  return declaration !== undefined && (ts.isSourceFile(declaration) || ts.isModuleDeclaration(declaration))
    && context.project.pathOf(declaration.getSourceFile()) !== undefined;
}

/**
 * 맵의 근거에 자리 하나를 더한다.
 *
 * @param map 맵
 * @param key 키
 * @param site 자리 파일
 */
function addSite<K>(map: Map<K, Evidence>, key: K, site: ts.SourceFile): void {
  const evidence = map.get(key) ?? new Map<ts.SourceFile, Level>();
  addLevel(evidence, site, 'unknown');
  map.set(key, evidence);
}

/**
 * 맵의 근거에 근거를 합친다.
 *
 * @param map 맵
 * @param key 키
 * @param source 더할 근거
 */
function mergeAt<K>(map: Map<K, Evidence>, key: K, source: Evidence): void {
  const evidence = map.get(key) ?? new Map<ts.SourceFile, Level>();
  mergeInto(evidence, source);
  map.set(key, evidence);
}

/**
 * 모듈 객체 식이 가리키는 프로젝트 모듈이다.
 *
 * @param context 해석기 문맥
 * @param expression 모듈 객체 식(`require()`·`import()`·`module.exports`, 모듈로 풀리는 식별자·속성 접근, `require()` 결과 변수)
 * @returns 모듈 심볼, 심볼 없이 찾은 모듈 파일, 프로젝트 모듈이 아니면 undefined
 */
function moduleOfObject(context: InterpreterContext, expression: ts.Expression): { readonly symbol: ts.Symbol } | { readonly symbol: undefined; readonly file: ts.SourceFile } | undefined {
  if (isModuleExportsReference(expression)) return { symbol: undefined, file: expression.getSourceFile() };
  if (isModuleObjectCall(expression)) return moduleOfCall(context, expression);
  if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression)) return undefined;
  const symbol = resolvedSymbol(context.checker, expression);
  if (symbol === undefined) return undefined;
  if (isModuleSymbol(context, symbol)) return { symbol };
  // TS 파일의 `const P = require('./x')`·`const P = await import('./x')`는 별칭이 아니라 변수다.
  const declaration = symbol.valueDeclaration;
  const initializer = declaration !== undefined && ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
    ? unwrap(declaration.initializer) : undefined;
  return initializer !== undefined && isModuleObjectCall(initializer) ? moduleOfCall(context, initializer) : undefined;
}

/**
 * `require()`·`import()` 호출이 가리키는 프로젝트 모듈이다.
 *
 * @param context 해석기 문맥
 * @param call 호출
 * @returns 모듈 심볼, 심볼 없이 찾은 모듈 파일, 또는 undefined
 */
function moduleOfCall(context: InterpreterContext, call: ts.CallExpression): { readonly symbol: ts.Symbol } | { readonly symbol: undefined; readonly file: ts.SourceFile } | undefined {
  const symbol = symbolAt(context.checker, call.arguments[0]!);
  if (symbol !== undefined && isModuleSymbol(context, symbol)) return { symbol };
  const file = context.requiredModule(call);
  return file === undefined ? undefined : { symbol: undefined, file };
}

/**
 * 해석 대상 파일에서 값을 불러오는 import·`require()`·`import()`를 따라 닿는 파일 중 해석 대상에서 빠진 파일이다(한 번 만든다). 테스트
 * 디렉터리 이름의 파일이라도 운영 코드가 불러오면 서버에서 실행된다.
 *
 * @param census census
 * @param context 해석기 문맥
 * @returns 파일 집합
 */
function importedExcludedFiles(census: SkipCensus, context: InterpreterContext): ReadonlySet<ts.SourceFile> {
  if (census.importedExcluded !== undefined) return census.importedExcluded;
  const reached = new Set<ts.SourceFile>();
  const queue: ts.SourceFile[] = [];
  for (const [path, file] of context.project.files) {
    if (context.includesFile(path)) {
      reached.add(file);
      queue.push(file);
    }
  }
  while (queue.length > 0) {
    const file = queue.pop()!;
    for (const specifier of census.moduleSpecifiers.get(file) ?? []) {
      const module = moduleFileOf(context, specifier);
      if (module !== undefined && !reached.has(module)) {
        reached.add(module);
        queue.push(module);
      }
    }
  }
  const excluded = new Set([...reached].filter((file) => !context.includesFile(context.project.pathOf(file)!)));
  census.importedExcluded = excluded;
  return excluded;
}

/**
 * 모듈 지정자가 가리키는 프로젝트 파일이다.
 *
 * @param context 해석기 문맥
 * @param specifier 지정자
 * @returns 파일 또는 undefined
 */
function moduleFileOf(context: InterpreterContext, specifier: ts.StringLiteralLike): ts.SourceFile | undefined {
  const declaration = symbolAt(context.checker, specifier)?.valueDeclaration;
  if (declaration !== undefined && ts.isSourceFile(declaration)) return context.project.pathOf(declaration) === undefined ? undefined : declaration;
  return ts.isCallExpression(specifier.parent) ? context.requiredModule(specifier.parent) : undefined;
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
