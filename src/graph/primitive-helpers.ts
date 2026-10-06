/** Receiver-free primitive 문법을 ValueFlow 없이 charged acyclic summary로 인증한다. */
import ts from 'typescript';
import type { ConstructorCarrierContext } from './constructor-carrier.ts';
import type { ProofEdge, ProofGuard, ProofOutcome, ProofRecipe, ProofWork } from './proof-dag.ts';

/** wrapper inspection 전에 caller work를 청구한 inner·outer 정규화 결과다. */
export interface PrimitiveExpressionView {
  readonly inner: ts.Expression;
  readonly wrappers: readonly ts.Expression[];
}

/** type-preserving wrapper 하나인지 판정한다. */
function primitiveWrapper(node: ts.Node): node is ts.Expression & { readonly expression: ts.Expression } {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node);
}

/** inner expression과 모든 wrapper를 한 번에 검사하고 각 검사 전에 depth/frame work를 청구한다. */
export function normalizePrimitiveExpression(expression: ts.Expression, work: ProofWork): PrimitiveExpressionView {
  const wrappers: ts.Expression[] = [];
  let current = expression;
  for (let depth = 0; ; depth++) {
    work(depth, depth);
    wrappers.push(current);
    if (!primitiveWrapper(current)) return { inner: current, wrappers };
    current = current.expression;
  }
}

/** reference의 바깥 wrapper를 parent 검사 전에 caller work로 청구한다. */
export function climbPrimitiveWrappers(node: ts.Node, work: ProofWork): ts.Node {
  let current = node;
  for (let depth = 0; ; depth++) {
    work(depth, depth);
    const parent = current.parent;
    if (!primitiveWrapper(parent)) return current;
    current = parent;
  }
}

/** reference token을 값 site로 바꾸되 shared referenceSite의 uncharged wrapper walk를 피한다. */
export function primitiveReferenceSite(token: ts.Node, work: ProofWork): ts.Node {
  work();
  const parent = token.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === token) return climbPrimitiveWrappers(parent, work);
  if (ts.isElementAccessExpression(parent)
    && normalizePrimitiveExpression(parent.argumentExpression, work).inner === token) {
    return climbPrimitiveWrappers(parent, work);
  }
  return climbPrimitiveWrappers(token, work);
}

/** primitive 결과의 provenance와 실행 전에 필요한 top-level 초기화를 함께 보존한다. */
export interface PrimitiveSummary {
  readonly sites: ReadonlySet<ts.Node>;
  readonly captures: ReadonlySet<ts.VariableDeclaration>;
}
/** callable body와 일반 expression의 독립 정적 entry다. */
type PrimitiveNode = ts.Expression | ts.FunctionDeclaration | ts.MethodDeclaration;
/** 현재 policy는 cold/warm 모두 DAG의 ordered guard로 읽는다. */
export interface PrimitivePolicy {
  readonly project: (source: ts.SourceFile) => ProofGuard;
  readonly open: (node: ts.FunctionLikeDeclaration) => ProofGuard;
  readonly intrinsic: (source: ts.SourceFile) => ProofGuard;
  readonly valid: () => boolean;
}

/** 각 initializer·argument·callee를 같은 capability DAG의 개별 dependency로 구성한다. */
export class PrimitiveHelpers {
  private readonly recipes = new Map<PrimitiveNode, ProofRecipe<PrimitiveSummary>>();
  private readonly context: ConstructorCarrierContext;
  private readonly policy: PrimitivePolicy;
  constructor(context: ConstructorCarrierContext, policy: PrimitivePolicy) {
    this.context = context; this.policy = policy;
  }

  /** recipe 생성 자체는 AST를 탐색하지 않는다. 실제 구성은 첫 charged lookup에서만 한다. */
  recipe(node: PrimitiveNode): ProofRecipe<PrimitiveSummary> {
    const known = this.recipes.get(node);
    if (known !== undefined) return known;
    let accepted = false;
    let sites = new Set<ts.Node>();
    let captures = new Set<ts.VariableDeclaration>();
    const recipe: ProofRecipe<PrimitiveSummary> = {
      id: `${node.getSourceFile().fileName}:${node.pos}:${node.end}:stage4-primitive`,
      identity: node, capability: 'primitive-effects', mode: 'extended', valid: this.policy.valid,
      dependencies: (work) => {
        sites = new Set(); captures = new Set();
        const edges: ProofEdge[] = [];
        accepted = this.inspect(node, work, sites, captures, edges);
        return edges;
      },
      evaluate: (work, children) => {
        work();
        if (!accepted) return { kind: 'rejected', reason: 'primitive-helper' };
        for (const child of children) {
          work();
          if (child.kind !== 'proved') return child;
          const summary = child.value as PrimitiveSummary;
          for (const site of summary.sites) { work(); sites.add(site); }
          for (const capture of summary.captures) { work(); captures.add(capture); }
        }
        return { kind: 'proved', value: { sites, captures } };
      },
    };
    this.recipes.set(node, recipe); return recipe;
  }

  /** 외부 entry는 static import 경로와 실제 source-local 초기화 순서를 별개로 검증한다. */
  initialized(summary: PrimitiveSummary, entry: ts.Node, work: ProofWork): boolean {
    for (const capture of summary.captures) {
      work();
      if (!this.before(capture, entry, work)) return false;
    }
    return true;
  }

  /** 요약에 primitive만 넣으므로 parameter 타입이나 literal의 TS 타입은 사용하지 않는다. */
  private inspect(node: PrimitiveNode, work: ProofWork, sites: Set<ts.Node>,
    captures: Set<ts.VariableDeclaration>, edges: ProofEdge[]): boolean {
    work();
    if (!work.observe(this.policy.project(node.getSourceFile()))) return false;
    const depend = (child: PrimitiveNode): void => {
      work(); edges.push({ recipe: this.recipe(child), capability: 'primitive-effects', depth: 1, frames: 1 });
    };
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      if (node.body === undefined || node.asteriskToken !== undefined || work.observe(this.policy.open(node))) return false;
      for (const modifier of node.modifiers ?? []) {
        work();
        const allowed = ts.isMethodDeclaration(node)
          ? modifier.kind === ts.SyntaxKind.PublicKeyword
          : modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword;
        if (!allowed) return false;
      }
      if (ts.isFunctionDeclaration(node)) {
        if (node.name === undefined || node.parent !== node.getSourceFile() || !this.closedCallee(node, work)) return false;
      } else if (node.parameters.length !== 0) return false; // Stage5의 dependency entry는 아직 닫힌다.
      for (const parameter of node.parameters) {
        work();
        if (!ts.isIdentifier(parameter.name) || parameter.name.text === 'this' || parameter.name.text === 'arguments'
          || parameter.initializer !== undefined || parameter.questionToken !== undefined || parameter.dotDotDotToken !== undefined
          || (parameter.modifiers?.length ?? 0) !== 0 || !this.immutable(parameter.name, work)) return false;
        sites.add(parameter); sites.add(parameter.name);
      }
      sites.add(node);
      let returned = false;
      for (const statement of node.body.statements) {
        work();
        if (returned) return false;
        if (ts.isVariableStatement(statement)) {
          if (!this.localStatement(statement, work)) return false;
          for (const binding of statement.declarationList.declarations) {
            work(); depend(binding.initializer!); sites.add(binding); sites.add(binding.name);
          }
        } else if (ts.isReturnStatement(statement)) {
          returned = true;
          if (statement.expression !== undefined) depend(statement.expression);
        } else if (ts.isExpressionStatement(statement)
          && ts.isCallExpression(normalizePrimitiveExpression(statement.expression, work).inner)) {
          depend(statement.expression);
        } else return false;
      }
      return true;
    }
    const outer = climbPrimitiveWrappers(node, work);
    const parent = outer.parent;
    if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
      work();
      if (!ts.isIdentifier(parent.name) || !ts.isVariableDeclarationList(parent.parent)
        || (parent.parent.flags & ts.NodeFlags.Const) === 0 || (parent.parent.flags & ts.NodeFlags.Using) !== 0
        || !this.immutable(parent.name, work)) return false;
      sites.add(parent); sites.add(parent.name);
    }
    const normalized = normalizePrimitiveExpression(node, work);
    const expression = normalized.inner;
    this.markWrappers(normalized, sites, work);
    if (primitiveLiteral(expression)) return true;
    if (ts.isIdentifier(expression)) {
      if (expression.text === 'arguments') return false;
      const symbol = this.symbol(expression, work);
      if (symbol === undefined) return false;
      if (expression.text === 'undefined') {
        work();
        const intrinsic = this.context.checker.resolveName('undefined', undefined, ts.SymbolFlags.Value, false);
        if (symbol === intrinsic && (this.context.index.identifierWrites.get(symbol)?.length ?? 0) === 0) {
          for (const declaration of symbol.declarations ?? []) {
            work(); if (!work.observe(this.policy.intrinsic(declaration.getSourceFile()))) return false;
          }
          return true;
        }
      }
      const binding = symbol.valueDeclaration;
      if (binding === undefined) return false;
      if (ts.isParameter(binding)) {
        work();
        const owner = binding.parent;
        return ts.isFunctionDeclaration(owner) && owner.parent === owner.getSourceFile() && owner.body !== undefined
          && ts.isIdentifier(binding.name) && binding.initializer === undefined && binding.questionToken === undefined
          && binding.dotDotDotToken === undefined && (binding.modifiers?.length ?? 0) === 0
          && this.immutable(binding.name, work);
      }
      if (ts.isVariableDeclaration(binding)) {
        work();
        if (!ts.isIdentifier(binding.name) || binding.initializer === undefined || !this.immutable(binding.name, work)
          || !ts.isVariableDeclarationList(binding.parent) || (binding.parent.flags & ts.NodeFlags.Const) === 0
          || (binding.parent.flags & ts.NodeFlags.Using) !== 0 || !ts.isVariableStatement(binding.parent.parent)) return false;
        const scope = binding.parent.parent.parent;
        if (ts.isSourceFile(scope)) {
          captures.add(binding);
          // top-level read는 즉시 평가되고 body capture는 모든 실제 entry에 순서 의무를 남긴다.
          if (!this.callableOwner(expression, work) && !this.before(binding, expression, work)) return false;
        } else {
          const owner = this.callableOwner(expression, work);
          if (!ts.isBlock(scope) || scope.parent !== owner || binding.end >= expression.pos) return false;
        }
        depend(binding.initializer); return true;
      }
      return false;
    }
    if (!ts.isCallExpression(expression) || expression.questionDotToken !== undefined) return false;
    const calleeView = normalizePrimitiveExpression(expression.expression, work);
    if (!ts.isIdentifier(calleeView.inner)) return false;
    const callee = calleeView.inner;
    const symbol = this.symbol(callee, work);
    const target = symbol?.valueDeclaration;
    if (target === undefined || !ts.isFunctionDeclaration(target) || target.body === undefined
      || expression.arguments.length !== target.parameters.length) return false;
    this.markWrappers(calleeView, sites, work);
    // 실제 인자 평가는 left-to-right 문법으로 수집하고 DAG는 canonical 순서로 청구한다.
    for (const argument of expression.arguments) {
      work(); if (ts.isSpreadElement(argument)) return false;
      depend(argument);
    }
    depend(target); return true;
  }

  /** helper 값의 alias·escape·merging·binding write를 완전한 static reference closure로 막는다. */
  private closedCallee(node: ts.FunctionDeclaration, work: ProofWork): boolean {
    const symbol = this.symbol(node.name!, work);
    if (symbol === undefined || (this.context.index.identifierWrites.get(symbol)?.length ?? 0) !== 0) return false;
    for (const declaration of symbol.declarations ?? []) { work(); if (declaration !== node) return false; }
    for (const reference of this.context.index.references.get(symbol) ?? []) {
      work();
      const site = primitiveReferenceSite(reference, work);
      if (!ts.isCallExpression(site.parent) || site.parent.expression !== site) return false;
      work();
      const local = this.context.checker.getSymbolAtLocation(reference);
      if (local !== undefined && (local.flags & ts.SymbolFlags.Alias) !== 0) {
        for (const declaration of local.declarations ?? []) {
          work();
          const namedImport = ts.isImportSpecifier(declaration) && !declaration.isTypeOnly;
          const defaultImport = ts.isImportClause(declaration) && !declaration.isTypeOnly && declaration.name !== undefined;
          if (!namedImport && !defaultImport) return false;
        }
      }
    }
    return true;
  }

  /** const라는 철자와 별도로 writes·runtime merging을 확인한다. primitive escapes는 inert하다. */
  private immutable(name: ts.Identifier, work: ProofWork): boolean {
    const symbol = this.symbol(name, work);
    if (symbol === undefined || (this.context.index.identifierWrites.get(symbol)?.length ?? 0) !== 0) return false;
    for (const declaration of symbol.declarations ?? []) { work(); if (declaration !== name.parent) return false; }
    return true;
  }

  /** 같은 statement의 앞선 declarator도 순서가 증명되지만 조건부·중첩 binding은 허용하지 않는다. */
  private localStatement(statement: ts.VariableStatement, work: ProofWork): boolean {
    work();
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0
      || (statement.declarationList.flags & ts.NodeFlags.Using) !== 0 || (statement.modifiers?.length ?? 0) !== 0) return false;
    for (const binding of statement.declarationList.declarations) {
      work(); if (!ts.isIdentifier(binding.name) || binding.initializer === undefined || !this.immutable(binding.name, work)) return false;
    }
    return true;
  }

  /** source와 binding의 canonical identity를 얻는 checker lookup도 청구한다. */
  private symbol(node: ts.Node, work: ProofWork): ts.Symbol | undefined {
    work();
    const symbol = this.context.checker.getSymbolAtLocation(node);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      work(); return this.context.checker.getAliasedSymbol(symbol);
    }
    return symbol;
  }

  /** 중첩 closure를 투명한 execution scope로 취급하지 않는다. */
  private callableOwner(node: ts.Node, work: ProofWork): ts.Node | undefined {
    let current: ts.Node | undefined = node;
    for (let depth = 0; current !== undefined; depth++) {
      work(depth, depth);
      const parent: ts.Node = current.parent;
      if (ts.isSourceFile(parent)) return undefined;
      if (ts.isFunctionLike(parent)) return parent;
      current = parent;
    }
    return undefined;
  }

  /** wrapper 원문은 type witness가 아니라 피연산자 평가의 동일 site로만 기록한다. */
  private markWrappers(view: PrimitiveExpressionView, sites: Set<ts.Node>, work: ProofWork): void {
    for (let depth = 0; depth < view.wrappers.length; depth++) {
      work(depth, depth); sites.add(view.wrappers[depth]!);
    }
  }

  /** acyclic runtime import/export만으로 source-local TDZ를 없애지 않는다. */
  private before(binding: ts.VariableDeclaration, entry: ts.Node, work: ProofWork): boolean {
    const source = entry.getSourceFile(), target = binding.getSourceFile();
    if (source === target) return binding.end < entry.pos;
    const manifest = this.context.index.effectInventory!.manifest;
    const active = new Set<ts.SourceFile>(), done = new Set<ts.SourceFile>();
    let reached = false;
    const stack = [{ file: source, leaving: false, depth: 0 }];
    while (stack.length > 0) {
      const item = stack.pop()!;
      work(item.depth, item.depth);
      if (item.leaving) { active.delete(item.file); done.add(item.file); continue; }
      if (active.has(item.file)) return false;
      if (done.has(item.file)) continue;
      active.add(item.file); stack.push({ ...item, leaving: true });
      reached ||= item.file === target;
      for (const edge of manifest.moduleEdges.get(item.file) ?? []) {
        work();
        if (!ts.isImportDeclaration(edge.site) && !ts.isExportDeclaration(edge.site)) return false;
        for (const declaration of edge.target?.declarations ?? []) {
          work(); stack.push({ file: declaration.getSourceFile(), leaving: false, depth: item.depth + 1 });
        }
      }
    }
    return reached;
  }
}

/** primitive provenance를 만들 때 coercion·property·container를 문법으로 구분한다. */
export function primitiveLiteral(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword;
}

/** primitive recipe children은 canonical 정렬되므로 summary 값만 합쳐 소비한다. */
export function primitiveChildren(children: readonly ProofOutcome<unknown>[], work: ProofWork): PrimitiveSummary {
  const sites = new Set<ts.Node>(), captures = new Set<ts.VariableDeclaration>();
  for (const child of children) {
    work();
    if (child.kind !== 'proved') continue;
    const summary = child.value as PrimitiveSummary;
    for (const site of summary.sites) { work(); sites.add(site); }
    for (const capture of summary.captures) { work(); captures.add(capture); }
  }
  return { sites, captures };
}
