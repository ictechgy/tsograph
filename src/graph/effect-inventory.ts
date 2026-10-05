/** 실행 열거와 안전 증명을 분리한다. 기존 flow의 성공은 효과 증명으로 승격하지 않는다. */
import { createHash } from 'node:crypto';
import ts from 'typescript';
import type { ModuleResolver } from './flow-index.ts';

/** 선택한 분석 범위다. 분리가 불가능하면 whole을 재사용한다. */
export type EffectView = 'whole' | 'production';
/** 쿼리 예산과 독립적인 빌드 상한이다. */
export const EFFECT_BUILD_CAPS = Object.freeze({ visited: 1_000_000, records: 1_000_000, perFile: 100_000 });
/** 빌드 작업 전체에서 공유하는 계수다. */
export interface EffectBuildBudget {
  visited: number;
  records: number;
  /** manifest/part 재방문을 합친 source별 visited 수다. */
  perFileVisited?: Map<ts.SourceFile, number>;
}
/** 실행식 하나의 관찰이다. unknown은 안전하거나 비어 있다는 뜻이 아니다. */
export interface EffectRecord {
  readonly site: ts.Node;
  readonly operation: 'primitive' | 'read' | 'write' | 'call' | 'construct' | 'class' | 'entry' | 'iteration' | 'spread' | 'unknown';
}
/** 정적 runtime 모듈 연결의 원래 자리와 해석 결과다. */
export interface RuntimeModuleEdge {
  readonly site: ts.Node;
  readonly specifier: string;
  readonly target: ts.Symbol | undefined;
}
/** checker로 독립 재구성한 값 참조 자리다. */
export interface EffectReferenceWitness { readonly site: ts.Node; readonly target: ts.Symbol }
/** checker로 독립 재구성한 import/export alias 자리다. */
export interface EffectAliasWitness { readonly name: string; readonly target: ts.Symbol }
/** completeness 검사가 쓰는 이름 토큰 자리다. */
export interface EffectTokenWitness { readonly text: string; readonly site: ts.Node }
/** supplied FlowIndex map과 대조할 canonical closure다. */
export interface EffectClosureWitness {
  readonly references: readonly EffectReferenceWitness[];
  readonly aliases: readonly EffectAliasWitness[];
  readonly tokens: readonly EffectTokenWitness[];
  /** runtime read/alias를 checker canonical target으로 묶지 못했다. */
  readonly unresolved: boolean;
}
/** reconciliation에 공급하는 실제 FlowIndex closure map이다. */
export interface EffectReferenceIndex {
  readonly references: ReadonlyMap<ts.Symbol, readonly ts.Node[]>;
  readonly aliasNames: ReadonlyMap<ts.Symbol, readonly string[]>;
  readonly tokenOccurrences: ReadonlyMap<string, readonly ts.Node[]>;
}
/** 파일 하나의 완전성 근거다. 텍스트뿐 아니라 AST 정체성도 대조한다. */
export interface EffectPart {
  readonly source: ts.SourceFile;
  readonly revision: string;
  readonly records: readonly EffectRecord[];
  readonly moduleEdges: readonly RuntimeModuleEdge[];
  readonly visited: number;
  readonly retained: number;
  readonly status: 'complete' | 'incomplete(build-cap)';
  readonly closure: EffectClosureWitness;
}
/** 공급 색인과 독립적으로 만든 기대 파일·runtime 모듈 집합이다. */
export interface EffectManifest {
  readonly version: 1;
  readonly view: EffectView;
  readonly files: ReadonlyMap<string, ts.SourceFile | undefined>;
  readonly revisions: ReadonlyMap<ts.SourceFile, string>;
  readonly runtimeModules: ReadonlySet<ts.SourceFile>;
  readonly moduleEdges: ReadonlyMap<ts.SourceFile, readonly RuntimeModuleEdge[]>;
  readonly records: ReadonlyMap<ts.SourceFile, readonly EffectRecord[]>;
  readonly visited: ReadonlyMap<ts.SourceFile, number>;
  readonly retained: ReadonlyMap<ts.SourceFile, number>;
  readonly closures: ReadonlyMap<ts.SourceFile, EffectClosureWitness>;
  readonly statuses: ReadonlyMap<ts.SourceFile, EffectPart['status']>;
  readonly coverageComplete: boolean;
  readonly complete: boolean;
  readonly buildCapped: boolean;
}
/** 열거와 참조 폐쇄·초기화·ambient 판정을 각기 보존한다. */
export interface EffectInventory {
  readonly manifest: EffectManifest;
  readonly enumeration: 'complete' | 'incomplete';
  readonly referenceAliases: 'complete' | 'incomplete';
  readonly initialization: 'complete' | 'incomplete';
  readonly ambientSafety: 'safe' | 'unknown';
  readonly records: readonly EffectRecord[];
  readonly reasons: readonly string[];
}

/** AST revision은 원문을 출력하지 않는 digest로 묶는다. */
function revision(source: ts.SourceFile): string {
  return createHash('sha256').update(source.text).digest('hex');
}

/** 타입·ambient 하위 트리는 실행하지 않되 extends 식과 단언의 피연산자는 방문한다. */
function erased(node: ts.Node): boolean {
  if (ts.isImportEqualsDeclaration(node) && node.isTypeOnly) return true;
  if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === 'this') return true;
  if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) return true;
  if (ts.isExportDeclaration(node) && node.isTypeOnly) return true;
  if ((ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) && node.isTypeOnly) return true;
  if (ts.isExpressionWithTypeArguments(node)) return ts.isHeritageClause(node.parent) && node.parent.token === ts.SyntaxKind.ImplementsKeyword;
  if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

/** 정적 import/export의 값 연결만 남긴다. 혼합 type/value 지정자도 구분한다. */
function runtimeEdge(node: ts.Node, source: ts.SourceFile, resolve: ModuleResolver): RuntimeModuleEdge | undefined {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return undefined;
    if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)) return undefined;
    if (ts.isStringLiteralLike(node.moduleSpecifier)) return { site: node, specifier: node.moduleSpecifier.text, target: resolve(node.moduleSpecifier.text, source) };
  }
  if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
    if (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0
      && node.exportClause.elements.every((element) => element.isTypeOnly)) return undefined;
    return { site: node, specifier: node.moduleSpecifier.text, target: resolve(node.moduleSpecifier.text, source) };
  }
  if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
    const specifier = node.moduleReference.expression;
    if (specifier && ts.isStringLiteralLike(specifier)) return { site: node, specifier: specifier.text, target: resolve(specifier.text, source) };
  }
  return undefined;
}

/** 단독 primitive 생성만 inert로 분류한다. 다른 평가는 후속 named witness가 필요하다. */
function operation(node: ts.Node): EffectRecord['operation'] | undefined {
  // 속성 이름·선언 이름·모듈 지정자는 값 읽기가 아니다. computed 이름은 자식을 따로 평가한다.
  const parent = node.parent;
  if (parent && ((parent as { name?: ts.Node }).name === node && !ts.isComputedPropertyName(node)
    && !ts.isShorthandPropertyAssignment(parent)
    || ts.isPropertyAccessExpression(parent) && parent.name === node
    || ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)
    || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent)
    || ts.isNamespaceImport(parent))) return undefined;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node) || ts.isExpressionWithTypeArguments(node)) return undefined;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) return 'primitive';
  if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) return 'call';
  if (ts.isNewExpression(node)) return 'construct';
  if (ts.isClassLike(node)) return 'class';
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) return 'read';
  if (ts.isPropertyDeclaration(node) || ts.isDeleteExpression(node) || ts.isBinaryExpression(node)
    && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return 'write';
  // 스크립트의 전역 binding 생성은 intrinsic·전역 lexical 환경을 바꿀 수 있다.
  if (ts.isVariableDeclaration(node) && !ts.isExternalModule(node.getSourceFile())) return 'write';
  if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name)) return 'entry';
  if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name)) return 'iteration';
  if (ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionLike(node)) return 'entry';
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) return 'iteration';
  if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) return 'spread';
  if (ts.isExportAssignment(node) && node.isExportEquals) return 'unknown';
  if (ts.isIfStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForStatement(node)
    || ts.isSwitchStatement(node) || ts.isTryStatement(node) || ts.isCatchClause(node)) return 'unknown';
  if (ts.isExpression(node) || ts.isClassLike(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)
    || ts.isImportEqualsDeclaration(node) || ts.isDecorator(node) || ts.isForOfStatement(node) || ts.isForInStatement(node)
    || ts.isParameter(node) || ts.isBindingElement(node) || ts.isThrowStatement(node)
    || ts.isWithStatement(node) || ts.isDebuggerStatement(node)) return 'unknown';
  return undefined;
}

const EFFECT_TRACKED_FLAGS = ts.SymbolFlags.Function | ts.SymbolFlags.Class | ts.SymbolFlags.Variable;

/** 값 보존 wrapper를 AST 위로 벗긴다. */
function climbWrappers(node: ts.Node): ts.Node {
  let current = node;
  while (ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent) || ts.isNonNullExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)) current = current.parent;
  return current;
}

/** 값 보존 expression wrapper를 아래로 벗긴다. */
function skipExpressionWrappers(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression;
  return current;
}

/** 별칭이면 checker target을 얻는다. */
function dealias(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Symbol | undefined {
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
  const target = checker.getAliasedSymbol(symbol);
  return (target.declarations ?? []).length === 0 ? undefined : target;
}

/** checker가 symbol을 실제 선언에 묶었는지와 FlowIndex 추적 대상 여부를 분리한다. */
function symbolResolved(checker: ts.TypeChecker | undefined, symbol: ts.Symbol | undefined): boolean {
  if (checker === undefined || symbol === undefined) return false;
  const target = dealias(checker, symbol);
  return target !== undefined && (target.declarations?.length ?? 0) > 0;
}

/** flow reference map과 같은 값 참조 자리인지 독립 판정한다. */
function referencePosition(identifier: ts.Identifier): boolean {
  const parent = identifier.parent;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
    || ts.isNamespaceExport(parent) || ts.isImportEqualsDeclaration(parent) || ts.isLabeledStatement(parent)
    || ts.isBreakOrContinueStatement(parent) || ts.isMetaProperty(parent) || ts.isQualifiedName(parent)
    || ts.isExportAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === identifier) return false;
  if ((parent as { name?: ts.Node }).name === identifier) return false;
  const outer = climbWrappers(identifier);
  return !(ts.isBinaryExpression(outer.parent) && outer.parent.left === outer
    && outer.parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
    && outer.parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment);
}

/** 추적 가능한 canonical reference를 witness에 더한다. */
function referenceWitness(
  checker: ts.TypeChecker | undefined,
  site: ts.Node,
  symbol: ts.Symbol | undefined,
): EffectReferenceWitness | undefined {
  if (checker === undefined) return undefined;
  const target = dealias(checker, symbol);
  return target !== undefined && (target.flags & EFFECT_TRACKED_FLAGS) !== 0 ? { site, target } : undefined;
}

/** runtime alias 선언의 canonical target을 witness에 더한다. */
function aliasWitness(checker: ts.TypeChecker | undefined, node: ts.Node): EffectAliasWitness | undefined {
  if (checker === undefined || (!ts.isImportSpecifier(node) && !ts.isExportSpecifier(node)
    && !ts.isImportClause(node) && !ts.isNamespaceImport(node) && !ts.isImportEqualsDeclaration(node))) return undefined;
  if (node.name === undefined) return undefined;
  const target = dealias(checker, checker.getSymbolAtLocation(node.name));
  return target !== undefined && (target.flags & EFFECT_TRACKED_FLAGS) !== 0 ? { name: node.name.text, target } : undefined;
}

/** expected relative path 전체를 source.fileName 경계에 결합한다. */
function sourceMatchesPath(path: string, source: ts.SourceFile): boolean {
  const expected = path.replaceAll('\\', '/').replace(/^\.\//u, '');
  const actual = source.fileName.replaceAll('\\', '/');
  return actual === expected || actual.endsWith(`/${expected}`);
}

/** 재귀 스택 없이 파일별 추가 AST 작업과 전체 보존 기록을 각각 제한한다. */
export function collectEffectPart(
  source: ts.SourceFile,
  resolve: ModuleResolver,
  limits: Readonly<{ visited: number; records: number; perFile: number }> = EFFECT_BUILD_CAPS,
  budget: EffectBuildBudget = { visited: 0, records: 0 },
  checker?: ts.TypeChecker,
): EffectPart {
  // 작은 합성 경계 테스트는 허용하지만 호출자가 제품 상한을 올릴 수는 없다.
  limits = {
    visited: Math.min(limits.visited, EFFECT_BUILD_CAPS.visited),
    records: Math.min(limits.records, EFFECT_BUILD_CAPS.records),
    perFile: Math.min(limits.perFile, EFFECT_BUILD_CAPS.perFile),
  };
  const records: EffectRecord[] = [];
  const moduleEdges: RuntimeModuleEdge[] = [];
  const references: EffectReferenceWitness[] = [];
  const aliases: EffectAliasWitness[] = [];
  const tokens: EffectTokenWitness[] = [];
  const stack: ts.Node[] = [source];
  let visited = 0;
  let retained = 0;
  let status: EffectPart['status'] = 'complete';
  let unresolvedClosure = false;
  budget.perFileVisited ??= new Map<ts.SourceFile, number>();
  while (stack.length > 0) {
    const sourceVisited = budget.perFileVisited.get(source) ?? 0;
    if (sourceVisited >= limits.perFile || budget.visited >= limits.visited) { status = 'incomplete(build-cap)'; break; }
    const node = stack.pop()!;
    visited++;
    budget.visited++;
    budget.perFileVisited.set(source, sourceVisited + 1);
    const tokenText = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node) ? node.text : undefined;
    const aliasSite = ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isImportClause(node)
      || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node);
    const aliasSymbol = aliasSite && node.name !== undefined ? checker?.getSymbolAtLocation(node.name) : undefined;
    const alias = aliasWitness(checker, node);
    let reference: EffectReferenceWitness | undefined;
    let requiresReferenceResolution = false;
    let referenceResolved = true;
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (propertyName || referencePosition(node)) {
        // Checker가 이름을 붙이지 않는 own property는 read 효과로 남기되 alias 폐쇄 실패로 보지 않는다.
        requiresReferenceResolution = !propertyName;
        const symbol = checker?.getSymbolAtLocation(node);
        referenceResolved = symbolResolved(checker, symbol);
        reference = referenceWitness(checker, node, symbol);
      }
    } else if (ts.isShorthandPropertyAssignment(node)) {
      requiresReferenceResolution = true;
      const symbol = checker?.getShorthandAssignmentValueSymbol(node);
      referenceResolved = symbolResolved(checker, symbol);
      reference = referenceWitness(checker, node.name, symbol);
    } else if (ts.isElementAccessExpression(node)) {
      const key = skipExpressionWrappers(node.argumentExpression);
      if (ts.isStringLiteralLike(key)) {
        const symbol = checker?.getSymbolAtLocation(key);
        reference = referenceWitness(checker, key, symbol);
      }
    }
    const runtime = !source.isDeclarationFile && !erased(node);
    if (runtime && (requiresReferenceResolution && !referenceResolved || aliasSite && !symbolResolved(checker, aliasSymbol))) unresolvedClosure = true;
    const edge = runtime ? runtimeEdge(node, source, resolve) : undefined;
    const kind = runtime ? operation(node) : undefined;
    const additions = Number(tokenText !== undefined) + Number(alias !== undefined) + Number(reference !== undefined)
      + Number(edge !== undefined) + Number(kind !== undefined);
    if (budget.records + additions > limits.records) { status = 'incomplete(build-cap)'; break; }
    budget.records += additions;
    retained += additions;
    if (tokenText !== undefined) tokens.push({ text: tokenText, site: node });
    if (alias) aliases.push(alias);
    if (reference) references.push(reference);
    if (edge) moduleEdges.push(edge);
    if (kind) records.push({ site: node, operation: kind });
    if (!runtime) continue;
    const children: ts.Node[] = [];
    const remainingPerFile = limits.perFile - (budget.perFileVisited.get(source) ?? 0);
    const room = Math.min(remainingPerFile, limits.visited - budget.visited) - stack.length;
    ts.forEachChild(node, (child) => {
      if (children.length >= room) { status = 'incomplete(build-cap)'; return true; }
      children.push(child);
      return undefined;
    });
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
  }
  return {
    source, revision: revision(source), records, moduleEdges, visited, retained, status,
    closure: { references, aliases, tokens, unresolved: unresolvedClosure },
  };
}

/** build-graph 기대 입력으로 만든다. 공급 flow index의 files는 참조하지 않는다. */
export function createEffectManifest(
  files: ReadonlyMap<string, ts.SourceFile | undefined>, view: EffectView, resolve: ModuleResolver,
  coverageComplete = true,
  budget: EffectBuildBudget = { visited: 0, records: 0 },
  checker?: ts.TypeChecker,
): EffectManifest {
  const revisions = new Map<ts.SourceFile, string>();
  const runtimeModules = new Set<ts.SourceFile>();
  const moduleEdges = new Map<ts.SourceFile, readonly RuntimeModuleEdge[]>();
  const records = new Map<ts.SourceFile, readonly EffectRecord[]>();
  const visited = new Map<ts.SourceFile, number>();
  const closures = new Map<ts.SourceFile, EffectClosureWitness>();
  const statuses = new Map<ts.SourceFile, EffectPart['status']>();
  const retained = new Map<ts.SourceFile, number>();
  let complete = coverageComplete;
  let buildCapped = false;
  for (const [path, source] of files) {
    if (!source) { complete = false; continue; }
    if (revisions.has(source) || !sourceMatchesPath(path, source)) complete = false;
    const expected = collectEffectPart(source, resolve, EFFECT_BUILD_CAPS, budget, checker);
    revisions.set(source, expected.revision);
    if (!source.isDeclarationFile) runtimeModules.add(source);
    moduleEdges.set(source, expected.moduleEdges);
    records.set(source, expected.records);
    visited.set(source, expected.visited);
    closures.set(source, expected.closure);
    statuses.set(source, expected.status);
    retained.set(source, expected.retained);
    complete &&= expected.status === 'complete';
    buildCapped ||= expected.status !== 'complete';
    if (((source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0) > 0) complete = false;
  }
  return {
    version: 1, view, files: new Map(files), revisions, runtimeModules, moduleEdges, records,
    visited, retained, closures, statuses, coverageComplete, complete, buildCapped,
  };
}

/** whole manifest의 이미 수집한 source witness를 view subset으로 투영해 중복 AST 순회를 피한다. */
export function selectEffectManifest(
  manifest: EffectManifest,
  files: ReadonlyMap<string, ts.SourceFile | undefined>,
  view: EffectView,
): EffectManifest {
  const sources = [...files.values()].filter((source): source is ts.SourceFile => source !== undefined);
  const selected = new Set(sources);
  const pick = <T>(values: ReadonlyMap<ts.SourceFile, T>): ReadonlyMap<ts.SourceFile, T> =>
    new Map([...values].filter(([source]) => selected.has(source)));
  const revisions = pick(manifest.revisions);
  const statuses = pick(manifest.statuses);
  const complete = manifest.coverageComplete && sources.length === files.size && new Set(sources).size === sources.length
    && [...files].every(([path, source]) => source !== undefined && sourceMatchesPath(path, source)
      && revisions.has(source) && statuses.get(source) === 'complete'
      && ((source as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0) === 0);
  return {
    version: manifest.version,
    view,
    files: new Map(files),
    revisions,
    runtimeModules: new Set([...manifest.runtimeModules].filter((source) => selected.has(source))),
    moduleEdges: pick(manifest.moduleEdges),
    records: pick(manifest.records),
    visited: pick(manifest.visited),
    retained: pick(manifest.retained),
    closures: pick(manifest.closures),
    statuses,
    coverageComplete: manifest.coverageComplete,
    complete,
    buildCapped: [...statuses.values()].some((status) => status !== 'complete'),
  };
}

/** 동일 AST의 정적 모듈 간선을 순서와 해석 대상까지 대조한다. */
function sameEdges(left: readonly RuntimeModuleEdge[], right: readonly RuntimeModuleEdge[]): boolean {
  return left.length === right.length && left.every((edge, index) => {
    const other = right[index]!;
    return edge.site === other.site && edge.specifier === other.specifier && edge.target === other.target;
  });
}

/** canonical reference/alias/token witness는 AST·symbol 정체성까지 순서대로 대조한다. */
function sameClosure(left: EffectClosureWitness, right: EffectClosureWitness): boolean {
  return left.unresolved === right.unresolved
    && left.references.length === right.references.length && left.references.every((witness, index) =>
    witness.site === right.references[index]?.site && witness.target === right.references[index]?.target)
    && left.aliases.length === right.aliases.length && left.aliases.every((witness, index) =>
      witness.name === right.aliases[index]?.name && witness.target === right.aliases[index]?.target)
    && left.tokens.length === right.tokens.length && left.tokens.every((witness, index) =>
      witness.text === right.tokens[index]?.text && witness.site === right.tokens[index]?.site);
}

interface EffectReferenceSets {
  readonly references: ReadonlyMap<ts.Symbol, ReadonlySet<ts.Node>>;
  readonly aliases: ReadonlyMap<ts.Symbol, ReadonlySet<string>>;
  readonly tokens: ReadonlyMap<string, ReadonlySet<ts.Node>>;
}

/** supplied FlowIndex map을 reconciliation 한 번만 linear Set으로 정규화한다. */
function referenceSets(actual: EffectReferenceIndex): EffectReferenceSets {
  return {
    references: new Map([...actual.references].map(([symbol, sites]) => [symbol, new Set(sites)])),
    aliases: new Map([...actual.aliasNames].map(([symbol, names]) => [symbol, new Set(names)])),
    tokens: new Map([...actual.tokenOccurrences].map(([text, sites]) => [text, new Set(sites)])),
  };
}

/** supplied FlowIndex map이 canonical witness를 실제로 포함하는지 확인한다. */
function closureMapsContain(expected: EffectClosureWitness, actual: EffectReferenceSets): boolean {
  if (expected.unresolved) return false;
  return expected.references.every((witness) => actual.references.get(witness.target)?.has(witness.site) === true)
    && expected.aliases.every((witness) => actual.aliases.get(witness.target)?.has(witness.name) === true)
    && expected.tokens.every((witness) => actual.tokens.get(witness.text)?.has(witness.site) === true);
}

/** 기대 파일마다 정확히 하나의 part가 필요하다. 열거 성공에서 unknown 효과를 제거하지 않는다. */
export function reconcileEffectInventory(
  manifest: EffectManifest,
  parts: readonly EffectPart[],
  view: EffectView = manifest.view,
  referenceIndex?: EffectReferenceIndex,
): EffectInventory {
  const reasons = new Set<string>();
  let referenceClosureComplete = true;
  if (!manifest.complete) reasons.add('manifest-incomplete');
  if (manifest.buildCapped) reasons.add('build-cap');
  if (view !== manifest.view) reasons.add('view-mismatch');
  const seen = new Set<ts.SourceFile>();
  const records: EffectRecord[] = [];
  const sourceOrder = new Map([...manifest.files.values()].map((source, index) => [source, index]));
  const orderedParts = [...parts].sort((left, right) => (sourceOrder.get(left.source) ?? Number.MAX_SAFE_INTEGER)
    - (sourceOrder.get(right.source) ?? Number.MAX_SAFE_INTEGER));
  let retained = 0;
  let aggregateVisited = 0;
  for (const part of orderedParts) {
    if (!manifest.revisions.has(part.source)) reasons.add('unexpected-part');
    if (seen.has(part.source)) reasons.add('duplicate-part');
    seen.add(part.source);
    if (manifest.revisions.get(part.source) !== part.revision || revision(part.source) !== part.revision) reasons.add('stale-part');
    if (!sameEdges(manifest.moduleEdges.get(part.source) ?? [], part.moduleEdges)) reasons.add('module-edge-mismatch');
    const expectedRecords = manifest.records.get(part.source) ?? [];
    if (expectedRecords.length !== part.records.length || expectedRecords.some((record, index) =>
      record.site !== part.records[index]?.site || record.operation !== part.records[index]?.operation)) reasons.add('record-mismatch');
    if (part.status !== 'complete') reasons.add('build-cap');
    aggregateVisited += part.visited;
    if (part.visited <= 0 || part.visited > EFFECT_BUILD_CAPS.perFile || aggregateVisited > EFFECT_BUILD_CAPS.visited
      || manifest.visited.get(part.source) !== part.visited) reasons.add('visit-mismatch');
    const expectedClosure = manifest.closures.get(part.source);
    if (expectedClosure === undefined || !sameClosure(expectedClosure, part.closure)) {
      reasons.add('reference-closure-mismatch');
      referenceClosureComplete = false;
    }
    if (part.closure.unresolved) referenceClosureComplete = false;
    retained += part.retained;
    if (retained > EFFECT_BUILD_CAPS.records) reasons.add('build-cap');
    if (part.retained < 0 || manifest.retained.get(part.source) !== part.retained) reasons.add('retained-mismatch');
    for (const record of part.records) {
      if (records.length >= EFFECT_BUILD_CAPS.records) break;
      records.push(record);
    }
  }
  for (const source of manifest.files.values()) if (!source || !seen.has(source)) reasons.add('missing-part');
  if (referenceIndex !== undefined) {
    const actual = referenceSets(referenceIndex);
    for (const closure of manifest.closures.values()) {
      if (!closureMapsContain(closure, actual)) {
        reasons.add('reference-closure-mismatch');
        referenceClosureComplete = false;
        break;
      }
    }
  }
  const enumerationReasons = [...reasons].filter((reason) => reason !== 'reference-closure-mismatch');
  const complete = enumerationReasons.length === 0;
  const closed = complete && referenceClosureComplete;
  const coveredEdges = [...manifest.moduleEdges.values()].every((edges) => edges.every((edge) =>
    edge.target !== undefined && (edge.target.declarations ?? []).some((declaration) => manifest.runtimeModules.has(declaration.getSourceFile()))));
  return {
    manifest, enumeration: complete ? 'complete' : 'incomplete', referenceAliases: closed ? 'complete' : 'incomplete',
    initialization: complete && coveredEdges ? 'complete' : 'incomplete',
    ambientSafety: closed && coveredEdges && records.every((record) => record.operation === 'primitive') ? 'safe' : 'unknown',
    records, reasons: [...reasons].sort(),
  };
}
