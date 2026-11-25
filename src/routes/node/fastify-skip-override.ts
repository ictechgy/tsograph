/**
 * Fastify 플러그인이 캡슐화를 건너뛰는지(`fn[Symbol.for('skip-override')]`) 본다.
 *
 * fastify 4.29.1·5.12.5 `pluginUtils.shouldSkipOverride`는 `!!fn[Symbol.for('skip-override')]`이고, 참이면 `register()`가
 * 새 인스턴스를 만들지 않아 `prefix`를 무시한다(`lib/plugin-override.js`). `fastify-plugin` 감싸기는 어댑터가 따로 알아보고,
 * 여기서는 프로젝트 코드가 그 심볼을 직접 쓰거나 바꿀 수 있는 자리를 센다:
 * - 플러그인 바인딩에 `[Symbol.for('skip-override')] = <참 리터럴>`을 모듈 최상위에서 조건 없이 쓰거나 `fastify-plugin`에 넘기면
 *   건너뛴다(`'yes'`). `fastify-plugin`은 받은 함수에 그 심볼을 직접 쓰고 같은 함수를 돌려준다.
 * - 같은 쓰기가 함수 안·조건 아래에 있거나, 값·키를 모르거나, 바인딩이 `register()` 첫 인자 밖의 호출 인자·다른 변수(등록 인자에서
 *   따라간 `const` 별칭은 함께 본다)·객체·배열·반환값으로 흘러가면(그 너머에서 심볼을 쓸 수 있다) 건너뛰는지 모른다(`'unknown'`).
 * - 이름으로 풀 수 없는 대상(`obj.plugin[Symbol.for('skip-override')] = …`)에 그 키를 쓰는 곳이 있으면 어느 플러그인이든 모른다.
 * 해석 대상 파일(테스트 소스 제외 등)만 본다. 그 밖의 파일은 서버 실행 경로가 아니다.
 */

import ts from 'typescript';

import type { InterpreterContext } from './router-interpreter.ts';
import { calleeFromPackage, resolveAlias, symbolAt, unwrap } from './symbols.ts';

/** 플러그인이 캡슐화를 건너뛰는지다. */
export type SkipOverride = 'no' | 'yes' | 'unknown';

/** 프로젝트 전체에서 한 번 모은, skip-override를 바꿀 수 있는 구문 자리다. */
interface SkipCensus {
  /** 이름별로 모은, 바인딩의 값이 쓰이거나 흘러가는 자리의 식별자 */
  readonly usesByName: ReadonlyMap<string, readonly ts.Identifier[]>;
  /** import 지정자의 지역 이름(다른 이름으로 가져온 바인딩을 찾는다) */
  readonly aliasNames: readonly ts.Identifier[];
  /** 별칭을 따라간 심볼 → 그 심볼을 가져온 지역 이름(첫 질의 때 한 번 만든다) */
  aliasIndex: Map<ts.Symbol, string[]> | undefined;
  /** 파일별 최상위 `module.exports = X`의 X */
  readonly moduleExports: ReadonlyMap<ts.SourceFile, readonly ts.Expression[]>;
  /** 파일별 `module.exports[k] = …`·`exports[k] = …` 쓰기 */
  readonly moduleExportWrites: ReadonlyMap<ts.SourceFile, readonly ts.ElementAccessExpression[]>;
  /** 이름으로 풀 수 없는 대상에 skip-override 키를 쓴 곳이 있는지 */
  readonly unresolvedSkipWrite: boolean;
}

/** 해석기 문맥마다 한 번 만든 census다. */
const censuses = new WeakMap<InterpreterContext, SkipCensus>();

/** 식별자 → 별칭을 따라간 심볼 메모다. */
const symbolMemo = new WeakMap<ts.Identifier, ts.Symbol | null>();

/**
 * 등록한 플러그인 함수가 캡슐화를 건너뛰는지 본다.
 *
 * @param context 해석기 문맥
 * @param chain 등록 인자에서 함수까지 따라간 식별자·속성 접근의 심볼
 * @param fn 플러그인 함수 선언
 * @returns 건너뜀·안 건너뜀·모름
 */
export function skipOverrideOf(context: InterpreterContext, chain: ReadonlySet<ts.Symbol>, fn: ts.SignatureDeclaration): SkipOverride {
  const census = censusOf(context);
  const checker = context.checker;
  const matches = (symbol: ts.Symbol | undefined): boolean => symbol !== undefined && (chain.has(symbol) || declaresFunction(symbol, fn));
  let result: SkipOverride = 'no';
  const add = (evidence: SkipOverride): void => {
    if (evidence === 'unknown' || result === 'unknown') result = 'unknown';
    else if (evidence === 'yes') result = 'yes';
  };
  for (const name of candidateNames(census, checker, chain, fn)) {
    for (const use of census.usesByName.get(name) ?? []) {
      if (matches(resolvedSymbol(checker, use))) add(classifyUse(checker, use, matches));
    }
  }
  const file = fn.getSourceFile();
  const exportsFunction = (census.moduleExports.get(file) ?? []).some((value) => value === fn
    || (ts.isIdentifier(value) && matches(resolvedSymbol(checker, value))));
  if (exportsFunction) for (const write of census.moduleExportWrites.get(file) ?? []) add(classifyWrite(checker, write));
  return result === 'no' && census.unresolvedSkipWrite ? 'unknown' : result;
}

/**
 * 심볼이 그 함수를 선언하는지(함수 선언, 함수 식을 초기값으로 둔 변수) 본다.
 *
 * @param symbol 심볼
 * @param fn 함수 선언
 * @returns 선언하면 true
 */
function declaresFunction(symbol: ts.Symbol, fn: ts.SignatureDeclaration): boolean {
  return (symbol.declarations ?? []).some((declaration) => declaration === fn
    || (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && unwrap(declaration.initializer) === fn));
}

/**
 * 플러그인 바인딩을 가리킬 수 있는 이름 목록이다: 등록 인자에서 따라간 바인딩·함수 선언·함수 식을 담은 변수의 이름과, 그 심볼들을
 * 다른 이름으로 가져온 import 지역 이름이다.
 *
 * @param census census
 * @param checker TypeChecker
 * @param chain 등록 인자에서 따라간 바인딩의 심볼
 * @param fn 플러그인 함수 선언
 * @returns 이름 집합
 */
function candidateNames(census: SkipCensus, checker: ts.TypeChecker, chain: ReadonlySet<ts.Symbol>, fn: ts.SignatureDeclaration): Set<string> {
  const symbols = new Set(chain);
  const holder = holderName(fn);
  for (const name of [fn.name, holder]) {
    const symbol = name !== undefined && ts.isIdentifier(name) ? symbolAt(checker, name) : undefined;
    if (symbol !== undefined) symbols.add(symbol);
  }
  const index = aliasIndexOf(census, checker);
  const names = new Set<string>();
  for (const symbol of symbols) {
    names.add(symbol.name);
    for (const local of index.get(symbol) ?? []) names.add(local);
  }
  if (fn.name !== undefined && ts.isIdentifier(fn.name)) names.add(fn.name.text);
  if (holder !== undefined) names.add(holder.text);
  return names;
}

/**
 * import 지역 이름을 별칭을 따라간 심볼별로 묶은 색인이다(질의마다 모든 import를 다시 풀지 않게 한 번만 만든다).
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
 * 함수 식을 초기값으로 둔 변수의 이름 식별자다.
 *
 * @param fn 함수 선언
 * @returns 변수 이름 또는 undefined
 */
function holderName(fn: ts.SignatureDeclaration): ts.Identifier | undefined {
  let current: ts.Node = fn;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)) current = current.parent;
  const parent = current.parent;
  return ts.isVariableDeclaration(parent) && parent.initializer === current && ts.isIdentifier(parent.name) ? parent.name : undefined;
}

/**
 * 식별자가 가리키는 값 심볼(별칭을 따라간 뒤)이다.
 *
 * @param checker TypeChecker
 * @param identifier 식별자
 * @returns 심볼 또는 undefined
 */
function resolvedSymbol(checker: ts.TypeChecker, identifier: ts.Identifier): ts.Symbol | undefined {
  const memo = symbolMemo.get(identifier);
  if (memo !== undefined) return memo ?? undefined;
  const parent = identifier.parent;
  const raw = ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
    ? checker.getShorthandAssignmentValueSymbol(parent)
    : symbolAt(checker, identifier);
  const symbol = raw === undefined ? undefined : resolveAlias(checker, raw);
  symbolMemo.set(identifier, symbol ?? null);
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
 * 해석 대상 파일을 한 번씩 걸어 census를 만든다(재귀 없이 걷는다).
 *
 * @param context 해석기 문맥
 * @returns census
 */
function buildCensus(context: InterpreterContext): SkipCensus {
  const usesByName = new Map<string, ts.Identifier[]>();
  const aliasNames: ts.Identifier[] = [];
  const moduleExports = new Map<ts.SourceFile, ts.Expression[]>();
  const moduleExportWrites = new Map<ts.SourceFile, ts.ElementAccessExpression[]>();
  let unresolvedSkipWrite = false;
  for (const [path, sourceFile] of context.project.files) {
    if (!context.includesFile(path)) continue;
    const stack: ts.Node[] = [sourceFile];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (ts.isIdentifier(node)) {
        if (isAliasName(node)) aliasNames.push(node);
        else if (mayChangeBinding(node)) pushTo(usesByName, node.text, node);
      } else if (ts.isElementAccessExpression(node) && isWriteTarget(node)) {
        const target = unwrap(node.expression);
        if (isModuleExportsReference(target)) pushTo(moduleExportWrites, sourceFile, node);
        else if (!ts.isIdentifier(target) && isSkipKeyLiteral(node.argumentExpression)) unresolvedSkipWrite = true;
      } else if (isTopLevelModuleExportsAssignment(node)) {
        pushTo(moduleExports, sourceFile, unwrap(node.right));
      }
      ts.forEachChild(node, (child) => { stack.push(child); });
    }
  }
  return { usesByName, aliasNames, aliasIndex: undefined, moduleExports, moduleExportWrites, unresolvedSkipWrite };
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
 * 식별자가 바인딩의 값을 쓰거나 다른 곳으로 흘려보내 skip-override를 바꿀 수 있는 자리인지 본다. 선언 이름, 호출 대상, 점 접근,
 * 읽기 원소 접근, `register()` 첫 인자, 내보내기, 비교·`typeof`·조건식 판정은 바꾸지 못한다.
 *
 * @param identifier 식별자
 * @returns 바꿀 수 있으면 true
 */
function mayChangeBinding(identifier: ts.Identifier): boolean {
  const outer = outermostWrapper(identifier);
  const parent = outer.parent;
  if (isDeclarationName(identifier) || ts.isPropertyAccessExpression(parent) || ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent)) return false;
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
 * 식별자가 선언의 이름인지 본다(변수·함수·클래스·매개변수·구조 분해·속성·메서드·지정자 이름).
 *
 * @param identifier 식별자
 * @returns 선언 이름이면 true
 */
function isDeclarationName(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isShorthandPropertyAssignment(parent)) return false;
  const named = parent as ts.Node & { readonly name?: ts.Node; readonly propertyName?: ts.Node };
  return named.name === identifier || named.propertyName === identifier || ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent);
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
 * 이항식에서 바인딩의 값이 다른 곳으로 흘러가거나 바인딩이 다시 대입되는지 본다. 비교 연산은 흘려보내지 않는다.
 * `module.exports = x`·`exports.a = x`는 내보내기라 흘려보내지 않는다(그 뒤 쓰기는 {@link skipOverrideOf}가 따로 본다).
 *
 * @param binary 이항식
 * @param operand 바인딩을 담은 피연산자
 * @returns 흘려보내면 true
 */
function bindingFlowsThroughBinary(binary: ts.BinaryExpression, operand: ts.Expression): boolean {
  const operator = binary.operatorToken.kind;
  if (operator === ts.SyntaxKind.EqualsToken && binary.right === operand) return !isModuleExportsReference(exportsRoot(unwrap(binary.left)));
  if (isAssignmentOperator(operator)) return true;
  return operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken
    || operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.CommaToken;
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
 * 바인딩을 쓰는 자리 하나가 skip-override에 주는 근거다. 등록 인자에서 따라간 다른 바인딩의 초기값(`const alias = manual`)은
 * 그 바인딩의 쓰기도 함께 보므로 바꾸는 자리가 아니다.
 *
 * @param checker TypeChecker
 * @param use 바인딩 식별자
 * @param matches 플러그인 바인딩 심볼인지
 * @returns 근거(`'no'`는 바꾸지 않는 자리)
 */
function classifyUse(checker: ts.TypeChecker, use: ts.Identifier, matches: (symbol: ts.Symbol | undefined) => boolean): SkipOverride {
  const outer = outermostWrapper(use);
  const parent = outer.parent;
  if (ts.isElementAccessExpression(parent)) return classifyWrite(checker, parent);
  if (ts.isVariableDeclaration(parent) && parent.initializer === outer && ts.isIdentifier(parent.name)
    && (ts.getCombinedNodeFlags(parent) & ts.NodeFlags.Const) !== 0 && matches(resolvedSymbol(checker, parent.name))) return 'no';
  if (ts.isCallExpression(parent) && parent.arguments.length === 1 && parent.arguments[0] === outer
    && calleeFromPackage(checker, parent.expression, ['fastify-plugin'], ['default', '*', 'fastifyPlugin']) !== undefined) {
    return runsOnceAtTopLevel(parent) ? 'yes' : 'unknown';
  }
  return 'unknown';
}

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
 * 원소 접근 키의 종류다: skip-override 심볼, 그것과 다른 키, 모름.
 *
 * @param checker TypeChecker
 * @param key 키 식
 * @returns 종류
 */
function keyKind(checker: ts.TypeChecker, key: ts.Expression): 'skip' | 'other' | 'unknown' {
  const node = unwrap(key);
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return 'other';
  const symbolFor = symbolForName(node);
  if (symbolFor !== undefined) return symbolFor === 'skip-override' ? 'skip' : 'other';
  if (!ts.isIdentifier(node)) return 'unknown';
  const symbol = symbolAt(checker, node);
  const declaration = symbol === undefined ? undefined : resolveAlias(checker, symbol).valueDeclaration;
  if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
    || (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return 'unknown';
  const initial = symbolForName(unwrap(declaration.initializer));
  return initial === undefined ? 'unknown' : initial === 'skip-override' ? 'skip' : 'other';
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
 * 키가 구문만으로 `Symbol.for('skip-override')`인지 본다(이름으로 풀 수 없는 대상의 쓰기를 셀 때 쓴다).
 *
 * @param key 키 식
 * @returns 맞으면 true
 */
function isSkipKeyLiteral(key: ts.Expression): boolean {
  return symbolForName(unwrap(key)) === 'skip-override';
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
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isSourceFile(current)) return true;
    const passes = ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current) || ts.isCallExpression(current)
      || ts.isVariableDeclaration(current) || ts.isVariableDeclarationList(current) || ts.isVariableStatement(current)
      || ts.isExpressionStatement(current) || ts.isAwaitExpression(current) || ts.isExportAssignment(current)
      || (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.EqualsToken);
    if (!passes) return false;
  }
  return false;
}
