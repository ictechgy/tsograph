/** 실행 열거와 안전 증명을 분리한다. 기존 flow의 성공은 효과 증명으로 승격하지 않는다. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import ts from 'typescript';
import type { ModuleResolver } from './flow-index.ts';

/** 선택한 분석 범위다. 분리가 불가능하면 whole을 재사용한다. */
export type EffectView = 'whole' | 'production';
/** 쿼리 예산과 독립적인 빌드 상한이다. */
export const EFFECT_BUILD_CAPS = Object.freeze({ visited: 1_000_000, records: 1_000_000, perFile: 100_000 });
/** type-only 지정자를 빈 runtime import/export로 보존하는 emit 결정이다. */
export interface EffectEmitPolicy { readonly preserveTypeOnlySpecifiers: boolean }
const CONSERVATIVE_EMIT_POLICY: EffectEmitPolicy = Object.freeze({ preserveTypeOnlySpecifiers: true });

/** Program의 실제 compiler options를 inventory emit 결정으로 고정한다. */
export function effectEmitPolicy(options: ts.CompilerOptions): EffectEmitPolicy {
  return { preserveTypeOnlySpecifiers: options.verbatimModuleSyntax === true };
}
/** 빌드 작업 전체에서 공유하는 계수다. */
export interface EffectBuildBudget {
  visited: number;
  records: number;
  /** manifest/part 재방문을 합친 source별 visited 수다. */
  perFileVisited?: Map<ts.SourceFile, number>;
  /** checker symbol별 require binding 증거를 같은 build 안에서 한 번만 조사한다. */
  requireBindings?: Map<ts.Symbol, 'loader' | 'ordinary' | 'opaque'>;
}
/** 실행식 하나의 관찰이다. unknown은 안전하거나 비어 있다는 뜻이 아니다. */
export interface EffectRecord {
  readonly site: ts.Node;
  readonly operation: 'primitive' | 'read' | 'write' | 'call' | 'construct' | 'class' | 'entry' | 'iteration' | 'spread' | 'unknown';
}
/** 정적 runtime 모듈 연결의 원래 자리와 해석 결과다. */
export interface RuntimeModuleEdge {
  readonly site: ts.Node;
  readonly specifier: string | undefined;
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
  readonly emitPolicy: EffectEmitPolicy;
  readonly closure: EffectClosureWitness;
}
/** 공급 색인과 독립적으로 만든 기대 파일·runtime 모듈 집합이다. */
export interface EffectManifest {
  readonly version: 1;
  readonly view: EffectView;
  readonly emitPolicy: EffectEmitPolicy;
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

/** 선언이 emit 뒤에도 지역 runtime binding을 만드는지 판정한다. */
function hasRuntimeBinding(declaration: ts.Declaration): boolean {
  if (declaration.getSourceFile().isDeclarationFile) return false;
  for (let current: ts.Node | undefined = declaration; current !== undefined && !ts.isSourceFile(current); current = current.parent) {
    if (ts.canHaveModifiers(current) && (ts.getModifiers(current) ?? [])
      .some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return false;
  }
  if (ts.isFunctionDeclaration(declaration)) return declaration.body !== undefined;
  if (ts.isImportSpecifier(declaration)) {
    const clause = ts.findAncestor(declaration, ts.isImportClause);
    return !declaration.isTypeOnly && clause?.isTypeOnly !== true;
  }
  if (ts.isImportClause(declaration)) return !declaration.isTypeOnly;
  if (ts.isNamespaceImport(declaration)) return ts.findAncestor(declaration, ts.isImportClause)?.isTypeOnly !== true;
  if (ts.isImportEqualsDeclaration(declaration)) return !declaration.isTypeOnly;
  return !ts.isTypeNode(declaration) && !ts.isInterfaceDeclaration(declaration) && !ts.isTypeAliasDeclaration(declaration);
}

/** runtime require 이름을 평범한 helper라고 확정할 수 있는 직접 선언이다. */
function knownOrdinaryRequireBinding(declaration: ts.Declaration): boolean {
  if (!hasRuntimeBinding(declaration)) return false;
  if (ts.isFunctionDeclaration(declaration)) return declaration.body !== undefined;
  if (ts.isImportSpecifier(declaration) || ts.isImportClause(declaration)
    || ts.isNamespaceImport(declaration) || ts.isImportEqualsDeclaration(declaration)) return true;
  if (ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) {
    if (!ts.isVariableDeclarationList(declaration.parent)
      || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return false;
    const initializer = skipExpressionWrappers(declaration.initializer);
    return ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer);
  }
  return false;
}

type RequireBindingKind = 'loader' | 'ordinary' | 'opaque';

interface RequireClassifier {
  readonly classify: (identifier: ts.Identifier) => RequireBindingKind;
  readonly capped: () => boolean;
}

/** 식별자 binding을 다시 쓰는 직접 문법이다. */
function bindingWrite(identifier: ts.Identifier): boolean {
  let outer: ts.Node = climbWrappers(identifier);
  // 구조 분해 대상의 컨테이너만 올라간다. property access의 receiver/key 읽기는 쓰기로 바꾸지 않는다.
  while (true) {
    const parent = outer.parent;
    if (ts.isArrayLiteralExpression(parent) || ts.isObjectLiteralExpression(parent)
      || ts.isSpreadElement(parent) && parent.expression === outer
      || ts.isSpreadAssignment(parent) && parent.expression === outer
      || ts.isPropertyAssignment(parent) && parent.initializer === outer
      || ts.isShorthandPropertyAssignment(parent) && parent.name === outer) {
      outer = climbWrappers(parent);
    } else break;
  }
  const parent = outer.parent;
  return ts.isBinaryExpression(parent) && parent.left === outer
    && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    || (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) && parent.operand === outer
    || (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) && parent.initializer === outer;
}

/** 함수 선언 binding의 재대입을 source별 bounded scan으로 확인한다. */
function hasBindingWrite(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  budget: EffectBuildBudget,
  limits: Readonly<{ visited: number; perFile: number }>,
): boolean | undefined {
  const sources = new Set((symbol.declarations ?? []).map((declaration) => declaration.getSourceFile())
    .filter((source) => !source.isDeclarationFile));
  for (const source of sources) {
    const stack: ts.Node[] = [source];
    while (stack.length > 0) {
      const sourceVisited = budget.perFileVisited?.get(source) ?? 0;
      if (sourceVisited >= limits.perFile || budget.visited >= limits.visited) return undefined;
      const node = stack.pop()!;
      budget.visited++;
      budget.perFileVisited?.set(source, sourceVisited + 1);
      if (ts.isIdentifier(node) && node.text === 'require' && bindingWrite(node)) {
        const target = dealias(checker, ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node));
        if (target === symbol) return true;
      }
      const children: ts.Node[] = [];
      const room = Math.min(limits.perFile - (budget.perFileVisited?.get(source) ?? 0),
        limits.visited - budget.visited) - stack.length;
      let overflow = false;
      ts.forEachChild(node, (child) => {
        if (children.length >= room) { overflow = true; return true; }
        children.push(child);
        return undefined;
      });
      if (overflow) return undefined;
      for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
    }
  }
  return false;
}

/** require 식별자를 runtime alias target과 bounded binding-write 증거로 분류한다. */
function createRequireClassifier(
  checker: ts.TypeChecker | undefined,
  budget: EffectBuildBudget,
  limits: Readonly<{ visited: number; perFile: number }>,
): RequireClassifier {
  let capped = false;
  budget.requireBindings ??= new Map();
  return {
    classify(identifier) {
      if (checker === undefined) return 'loader';
      const local = checker.getSymbolAtLocation(identifier);
      if (local === undefined) return 'loader';
      const localRuntime = (local.declarations ?? []).filter(hasRuntimeBinding);
      if (localRuntime.length === 0) return 'loader';
      const target = dealias(checker, local);
      if (target === undefined) return 'opaque';
      const cached = budget.requireBindings!.get(target);
      if (cached !== undefined) return cached;
      const runtimeDeclarations = (target.declarations ?? []).filter(hasRuntimeBinding);
      let result: RequireBindingKind = 'opaque';
      if (runtimeDeclarations.length === 0) result = 'loader';
      else if (runtimeDeclarations.every(knownOrdinaryRequireBinding)) {
        const needsWriteCensus = runtimeDeclarations.some(ts.isFunctionDeclaration);
        const written = needsWriteCensus ? hasBindingWrite(checker, target, budget, limits) : false;
        if (written === undefined) capped = true;
        else result = written ? 'opaque' : 'ordinary';
      }
      budget.requireBindings!.set(target, result);
      return result;
    },
    capped: () => capped,
  };
}

/** 호출이 동적 import, 직접 require, 또는 미증명 local require인지 분류한다. */
function runtimeModuleLoadKind(call: ts.CallExpression, classifier: RequireClassifier): 'direct' | 'opaque' | undefined {
  const callee = skipExpressionWrappers(call.expression);
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return 'direct';
  if (!ts.isIdentifier(callee) || callee.text !== 'require') return undefined;
  const binding = classifier.classify(callee);
  return binding === 'loader' ? 'direct' : binding === 'opaque' ? 'opaque' : undefined;
}

/** 직접 require 호출의 callee가 아닌 loader 값 읽기는 alias 범위를 모르므로 opaque다. */
function opaqueRequireValueRead(identifier: ts.Identifier, classifier: RequireClassifier): boolean {
  if (identifier.text !== 'require' || classifier.classify(identifier) === 'ordinary') return false;
  const valuePosition = referencePosition(identifier) || ts.isShorthandPropertyAssignment(identifier.parent)
    || ts.isExportAssignment(identifier.parent) && identifier.parent.expression === identifier;
  if (!valuePosition) return false;
  const outer = climbWrappers(identifier);
  return !(ts.isCallExpression(outer.parent) && outer.parent.expression === outer
    && runtimeModuleLoadKind(outer.parent, classifier) !== undefined);
}

/** emit policy가 보존하는 정적 연결과 runtime loader를 남긴다. */
function runtimeEdges(
  node: ts.Node,
  source: ts.SourceFile,
  resolve: ModuleResolver,
  classifier: RequireClassifier,
  emitPolicy: EffectEmitPolicy,
): readonly RuntimeModuleEdge[] {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause?.isTypeOnly) return [];
    if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
      && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((element) => element.isTypeOnly)
      && !emitPolicy.preserveTypeOnlySpecifiers) return [];
    if (ts.isStringLiteralLike(node.moduleSpecifier)) return [{ site: node, specifier: node.moduleSpecifier.text, target: resolve(node.moduleSpecifier.text, source) }];
  }
  if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
    if (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0
      && node.exportClause.elements.every((element) => element.isTypeOnly)
      && !emitPolicy.preserveTypeOnlySpecifiers) return [];
    return [{ site: node, specifier: node.moduleSpecifier.text, target: resolve(node.moduleSpecifier.text, source) }];
  }
  if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
    const specifier = node.moduleReference.expression;
    if (specifier && ts.isStringLiteralLike(specifier)) return [{ site: node, specifier: specifier.text, target: resolve(specifier.text, source) }];
  }
  if (ts.isCallExpression(node)) {
    const load = runtimeModuleLoadKind(node, classifier);
    if (load === undefined) return [];
    if (load === 'opaque') return [{ site: node, specifier: undefined, target: undefined }];
    const argument = node.arguments[0] === undefined ? undefined : skipExpressionWrappers(node.arguments[0]);
    const specifier = argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
    return [{ site: node, specifier, target: specifier === undefined ? undefined : resolve(specifier, source) }];
  }
  if (ts.isIdentifier(node) && opaqueRequireValueRead(node, classifier)) {
    return [{ site: node, specifier: undefined, target: undefined }];
  }
  const bindingName = ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) ? node.name : undefined;
  if (bindingName !== undefined && ts.isIdentifier(bindingName)
    && bindingName.text === 'require' && classifier.classify(bindingName) === 'opaque') {
    return [{ site: node, specifier: undefined, target: undefined }];
  }
  return [];
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
  if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0) return 'unknown';
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

/** 선언 없는 checker intrinsic `undefined`만 전역 값으로 인정한다. */
function intrinsicUndefined(checker: ts.TypeChecker | undefined, identifier: ts.Identifier, symbol: ts.Symbol | undefined): boolean {
  if (checker === undefined || symbol === undefined || identifier.text !== 'undefined') return false;
  return symbol.name === 'undefined' && (symbol.flags & ts.SymbolFlags.Transient) !== 0
    && (symbol.flags & ts.SymbolFlags.Property) !== 0 && (symbol.declarations?.length ?? 0) === 0
    && (checker.getTypeAtLocation(identifier).flags & ts.TypeFlags.Undefined) !== 0;
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

/** authoritative expected path와 Program SourceFile 경로를 정규화한 전체 문자열로 대조한다. */
function sourceMatchesPath(path: string, source: ts.SourceFile): boolean {
  const normalize = (value: string): string => posix.normalize(value.replaceAll('\\', '/'));
  return normalize(source.fileName) === normalize(path);
}

/** 재귀 스택 없이 파일별 추가 AST 작업과 전체 보존 기록을 각각 제한한다. */
export function collectEffectPart(
  source: ts.SourceFile,
  resolve: ModuleResolver,
  limits: Readonly<{ visited: number; records: number; perFile: number }> = EFFECT_BUILD_CAPS,
  budget: EffectBuildBudget = { visited: 0, records: 0 },
  checker?: ts.TypeChecker,
  emitPolicy: EffectEmitPolicy = CONSERVATIVE_EMIT_POLICY,
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
  const requireClassifier = createRequireClassifier(checker, budget, limits);
  while (stack.length > 0) {
    const sourceVisited = budget.perFileVisited.get(source) ?? 0;
    if (sourceVisited >= limits.perFile || budget.visited >= limits.visited) { status = 'incomplete(build-cap)'; break; }
    const node = stack.pop()!;
    visited++;
    budget.visited++;
    budget.perFileVisited.set(source, sourceVisited + 1);
    const runtime = !source.isDeclarationFile && !erased(node);
    const tokenText = runtime && (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
    const aliasNode = ts.isImportSpecifier(node) || ts.isExportSpecifier(node) || ts.isImportClause(node)
      || ts.isNamespaceImport(node) || ts.isImportEqualsDeclaration(node) ? node : undefined;
    const aliasName = runtime ? aliasNode?.name : undefined;
    const aliasSite = aliasName !== undefined;
    const aliasSymbol = aliasName === undefined ? undefined : checker?.getSymbolAtLocation(aliasName);
    const alias = aliasName === undefined || aliasNode === undefined ? undefined : aliasWitness(checker, aliasNode);
    let reference: EffectReferenceWitness | undefined;
    let requiresReferenceResolution = false;
    let referenceResolved = true;
    if (runtime && ts.isIdentifier(node)) {
      const parent = node.parent;
      const propertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      if (propertyName || referencePosition(node)) {
        // Checker가 이름을 붙이지 않는 own property는 read 효과로 남기되 alias 폐쇄 실패로 보지 않는다.
        requiresReferenceResolution = !propertyName;
        const symbol = checker?.getSymbolAtLocation(node);
        referenceResolved = symbolResolved(checker, symbol) || intrinsicUndefined(checker, node, symbol);
        reference = referenceWitness(checker, node, symbol);
      }
    } else if (runtime && ts.isShorthandPropertyAssignment(node)) {
      requiresReferenceResolution = true;
      const symbol = checker?.getShorthandAssignmentValueSymbol(node);
      referenceResolved = symbolResolved(checker, symbol) || intrinsicUndefined(checker, node.name, symbol);
      reference = referenceWitness(checker, node.name, symbol);
    } else if (runtime && ts.isElementAccessExpression(node)) {
      const key = skipExpressionWrappers(node.argumentExpression);
      if (ts.isStringLiteralLike(key)) {
        const symbol = checker?.getSymbolAtLocation(key);
        reference = referenceWitness(checker, key, symbol);
      }
    }
    if (runtime && (requiresReferenceResolution && !referenceResolved || aliasSite && !symbolResolved(checker, aliasSymbol))) unresolvedClosure = true;
    const edges = runtime ? runtimeEdges(node, source, resolve, requireClassifier, emitPolicy) : [];
    if (requireClassifier.capped()) status = 'incomplete(build-cap)';
    const kind = runtime ? operation(node) : undefined;
    const additions = Number(tokenText !== undefined) + Number(alias !== undefined) + Number(reference !== undefined)
      + edges.length + Number(kind !== undefined);
    if (budget.records + additions > limits.records) { status = 'incomplete(build-cap)'; break; }
    budget.records += additions;
    retained += additions;
    if (tokenText !== undefined) tokens.push({ text: tokenText, site: node });
    if (alias) aliases.push(alias);
    if (reference) references.push(reference);
    moduleEdges.push(...edges);
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
    source, revision: revision(source), records, moduleEdges, visited, retained, status, emitPolicy,
    closure: { references, aliases, tokens, unresolved: unresolvedClosure },
  };
}

/** build-graph 기대 입력으로 만든다. 공급 flow index의 files는 참조하지 않는다. */
export function createEffectManifest(
  files: ReadonlyMap<string, ts.SourceFile | undefined>, view: EffectView, resolve: ModuleResolver,
  coverageComplete = true,
  budget: EffectBuildBudget = { visited: 0, records: 0 },
  checker?: ts.TypeChecker,
  emitPolicy: EffectEmitPolicy = CONSERVATIVE_EMIT_POLICY,
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
    if (revisions.has(source)) { complete = false; continue; }
    if (!sourceMatchesPath(path, source)) complete = false;
    const expected = collectEffectPart(source, resolve, EFFECT_BUILD_CAPS, budget, checker, emitPolicy);
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
    version: 1, view, emitPolicy, files: new Map(files), revisions, runtimeModules, moduleEdges, records,
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
    emitPolicy: manifest.emitPolicy,
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

interface ReconciliationBudget { remaining: number; exhausted: boolean }

/** supplied 길이를 순회하기 전에 고정 reconciliation 한도에 청구한다. */
function chargeReconciliation(budget: ReconciliationBudget, amount: number): boolean {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > budget.remaining) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining -= amount;
  return true;
}

/** incomplete inventory는 supplied 배열·맵을 더 읽지 않고 즉시 닫는다. */
function incompleteInventory(manifest: EffectManifest, reasons: ReadonlySet<string>): EffectInventory {
  return {
    manifest,
    enumeration: 'incomplete',
    referenceAliases: 'incomplete',
    initialization: 'incomplete',
    ambientSafety: 'unknown',
    records: [],
    reasons: [...reasons].sort(),
  };
}

/** 두 edge 배열을 한도 안에서 순서·AST·대상까지 대조한다. */
function sameEdges(
  expected: readonly RuntimeModuleEdge[],
  actual: readonly RuntimeModuleEdge[],
  budget: ReconciliationBudget,
): boolean {
  if (expected.length !== actual.length) return false;
  if (!chargeReconciliation(budget, expected.length) || !chargeReconciliation(budget, actual.length)) return false;
  for (let index = 0; index < expected.length; index++) {
    const left = expected[index]!;
    const right = actual[index]!;
    if (left.site !== right.site || left.specifier !== right.specifier || left.target !== right.target) return false;
  }
  return true;
}

/** 두 record 배열을 한도 안에서 대조하고 검증된 actual 기록을 보존한다. */
function sameRecords(
  expected: readonly EffectRecord[],
  actual: readonly EffectRecord[],
  records: EffectRecord[],
  budget: ReconciliationBudget,
  ambient: { safe: boolean },
): boolean {
  if (expected.length !== actual.length) return false;
  if (!chargeReconciliation(budget, expected.length) || !chargeReconciliation(budget, actual.length)) return false;
  for (let index = 0; index < expected.length; index++) {
    const left = expected[index]!;
    const right = actual[index]!;
    if (left.site !== right.site || left.operation !== right.operation) return false;
    records.push(right);
    ambient.safe &&= right.operation === 'primitive';
  }
  return true;
}

/** canonical closure 배열을 bounded 순서 비교한다. */
function sameClosure(
  expected: EffectClosureWitness,
  actual: EffectClosureWitness,
  budget: ReconciliationBudget,
): boolean {
  if (expected.unresolved !== actual.unresolved
    || expected.references.length !== actual.references.length
    || expected.aliases.length !== actual.aliases.length
    || expected.tokens.length !== actual.tokens.length) return false;
  for (const length of [expected.references.length, actual.references.length, expected.aliases.length,
    actual.aliases.length, expected.tokens.length, actual.tokens.length]) {
    if (!chargeReconciliation(budget, length)) return false;
  }
  for (let index = 0; index < expected.references.length; index++) {
    const left = expected.references[index]!;
    const right = actual.references[index]!;
    if (left.site !== right.site || left.target !== right.target) return false;
  }
  for (let index = 0; index < expected.aliases.length; index++) {
    const left = expected.aliases[index]!;
    const right = actual.aliases[index]!;
    if (left.name !== right.name || left.target !== right.target) return false;
  }
  for (let index = 0; index < expected.tokens.length; index++) {
    const left = expected.tokens[index]!;
    const right = actual.tokens[index]!;
    if (left.text !== right.text || left.site !== right.site) return false;
  }
  return true;
}

/** expected key만 actual map에서 읽고 각 supplied 배열을 순회 전에 청구한다. */
function containsExpected<K, V>(
  actual: ReadonlyMap<K, readonly V[]>,
  expected: ReadonlyMap<K, readonly V[]>,
  budget: ReconciliationBudget,
): boolean {
  for (const [key, required] of expected) {
    let supplied: readonly V[] | undefined;
    try {
      supplied = actual.get(key);
    } catch {
      return false;
    }
    if (!Array.isArray(supplied)) return false;
    let count: number;
    try {
      count = supplied.length;
    } catch {
      return false;
    }
    if (!chargeReconciliation(budget, count)) return false;
    let values: ReadonlySet<V>;
    try {
      const indexed = new Set<V>();
      for (let index = 0; index < count; index++) indexed.add(supplied[index]!);
      values = indexed;
    } catch {
      return false;
    }
    for (const value of required) if (!values.has(value)) return false;
  }
  return true;
}

/** canonical runtime closure가 요구하는 key만 묶어 actual FlowIndex와 대조한다. */
function closureMapsContain(
  sources: readonly ts.SourceFile[],
  manifest: EffectManifest,
  actual: EffectReferenceIndex,
  budget: ReconciliationBudget,
): { readonly contained: boolean; readonly exhausted: boolean } {
  const references = new Map<ts.Symbol, ts.Node[]>();
  const aliases = new Map<ts.Symbol, string[]>();
  const tokens = new Map<string, ts.Node[]>();
  const append = <K, V>(map: Map<K, V[]>, key: K, value: V): boolean => {
    if (!chargeReconciliation(budget, 1)) return false;
    const values = map.get(key);
    if (values === undefined) map.set(key, [value]);
    else values.push(value);
    return true;
  };
  for (const source of sources) {
    const closure = manifest.closures.get(source);
    if (closure === undefined || closure.unresolved) return { contained: false, exhausted: budget.exhausted };
    for (const witness of closure.references) if (!append(references, witness.target, witness.site)) return { contained: false, exhausted: budget.exhausted };
    for (const witness of closure.aliases) if (!append(aliases, witness.target, witness.name)) return { contained: false, exhausted: budget.exhausted };
    for (const witness of closure.tokens) if (!append(tokens, witness.text, witness.site)) return { contained: false, exhausted: budget.exhausted };
  }
  const contained = containsExpected(actual.references, references, budget)
    && containsExpected(actual.aliasNames, aliases, budget)
    && containsExpected(actual.tokenOccurrences, tokens, budget);
  return { contained, exhausted: budget.exhausted };
}

/** 기대 파일마다 정확히 하나의 part가 필요하다. 열거 성공에서 unknown 효과를 제거하지 않는다. */
export function reconcileEffectInventory(
  manifest: EffectManifest,
  parts: readonly EffectPart[],
  view: EffectView = manifest.view,
  referenceIndex?: EffectReferenceIndex,
): EffectInventory {
  const reasons = new Set<string>();
  if (!manifest.complete) reasons.add('manifest-incomplete');
  if (manifest.buildCapped) reasons.add('build-cap');
  if (view !== manifest.view) reasons.add('view-mismatch');
  const expectedCount = manifest.revisions.size;
  if (expectedCount !== manifest.files.size) reasons.add('manifest-file-mismatch');
  if (expectedCount > EFFECT_BUILD_CAPS.visited || parts.length !== expectedCount || parts.length > EFFECT_BUILD_CAPS.visited) {
    reasons.add('part-count-mismatch');
    if (expectedCount > EFFECT_BUILD_CAPS.visited || parts.length > EFFECT_BUILD_CAPS.visited) reasons.add('build-cap');
  }
  if (reasons.size > 0) return incompleteInventory(manifest, reasons);

  const sources = [...manifest.revisions.keys()];
  const partBySource = new Map<ts.SourceFile, EffectPart>();
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === undefined || !manifest.revisions.has(part.source)) { reasons.add('unexpected-part'); continue; }
    if (partBySource.has(part.source)) reasons.add('duplicate-part');
    else partBySource.set(part.source, part);
  }
  for (const source of sources) if (!partBySource.has(source)) reasons.add('missing-part');
  if (reasons.size > 0) return incompleteInventory(manifest, reasons);

  let aggregateVisited = 0;
  let aggregateRetained = 0;
  for (const source of sources) {
    const part = partBySource.get(source)!;
    const expectedVisited = manifest.visited.get(source);
    const expectedRetained = manifest.retained.get(source);
    if (manifest.statuses.get(source) !== 'complete' || part.status !== 'complete') reasons.add('build-cap');
    if (!Number.isSafeInteger(expectedVisited) || !Number.isSafeInteger(part.visited)
      || expectedVisited === undefined || expectedVisited <= 0 || part.visited <= 0
      || expectedVisited !== part.visited || expectedVisited + part.visited > EFFECT_BUILD_CAPS.perFile) reasons.add('visit-mismatch');
    else aggregateVisited += expectedVisited + part.visited;
    if (!Number.isSafeInteger(expectedRetained) || !Number.isSafeInteger(part.retained)
      || expectedRetained === undefined || expectedRetained < 0 || part.retained < 0
      || expectedRetained !== part.retained) reasons.add('retained-mismatch');
    else aggregateRetained += expectedRetained + part.retained;
    const expectedRevision = manifest.revisions.get(source)!;
    if (part.revision !== expectedRevision || revision(source) !== expectedRevision) reasons.add('stale-part');
    if (part.emitPolicy.preserveTypeOnlySpecifiers !== manifest.emitPolicy.preserveTypeOnlySpecifiers) reasons.add('emit-policy-mismatch');
  }
  if (aggregateVisited > EFFECT_BUILD_CAPS.visited) reasons.add('visit-mismatch');
  if (aggregateRetained > EFFECT_BUILD_CAPS.records) reasons.add('build-cap');
  if (reasons.size > 0) return incompleteInventory(manifest, reasons);

  const reconciliationBudget: ReconciliationBudget = { remaining: EFFECT_BUILD_CAPS.records, exhausted: false };
  const records: EffectRecord[] = [];
  const ambient = { safe: true };
  let referenceClosureComplete = true;
  let coveredEdges = true;
  for (const source of sources) {
    const part = partBySource.get(source)!;
    const expectedEdges = manifest.moduleEdges.get(source) ?? [];
    if (!sameEdges(expectedEdges, part.moduleEdges, reconciliationBudget)) reasons.add('module-edge-mismatch');
    for (const edge of expectedEdges) {
      const declarations = edge.target?.declarations;
      if (declarations === undefined || !chargeReconciliation(reconciliationBudget, declarations.length)) {
        coveredEdges = false;
        continue;
      }
      let inside = false;
      for (const declaration of declarations) {
        if (ts.isSourceFile(declaration) && manifest.runtimeModules.has(declaration)) { inside = true; break; }
      }
      coveredEdges &&= inside;
    }
    if (!sameRecords(manifest.records.get(source) ?? [], part.records, records, reconciliationBudget, ambient)) reasons.add('record-mismatch');
    const expectedClosure = manifest.closures.get(source);
    if (expectedClosure === undefined || !sameClosure(expectedClosure, part.closure, reconciliationBudget)) {
      reasons.add('reference-closure-mismatch');
      referenceClosureComplete = false;
    }
    if (part.closure.unresolved) referenceClosureComplete = false;
  }
  if (reconciliationBudget.exhausted) reasons.add('build-cap');
  const enumerationReasons = [...reasons].filter((reason) => reason !== 'reference-closure-mismatch');
  if (enumerationReasons.length > 0) return incompleteInventory(manifest, reasons);
  if (referenceIndex !== undefined && referenceClosureComplete) {
    const closureCheck = closureMapsContain(sources, manifest, referenceIndex, reconciliationBudget);
    if (closureCheck.exhausted) {
      reasons.add('build-cap');
      return incompleteInventory(manifest, reasons);
    }
    if (!closureCheck.contained) {
      reasons.add('reference-closure-mismatch');
      referenceClosureComplete = false;
    }
  }
  const closed = referenceClosureComplete;
  return {
    manifest, enumeration: 'complete', referenceAliases: closed ? 'complete' : 'incomplete',
    initialization: coveredEdges ? 'complete' : 'incomplete',
    ambientSafety: closed && coveredEdges && ambient.safe ? 'safe' : 'unknown',
    records, reasons: [...reasons].sort(),
  };
}
