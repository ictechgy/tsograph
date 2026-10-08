/** 프로젝트-local HTTP forwarder의 구조와 모든 runtime reference를 한 번 색인한다. */
import ts from 'typescript';
import { resolveAlias, symbolAt } from '../node/symbols.ts';
import { isNodeTestPath } from '../node/node-project.ts';
import type { ClientValues } from './client-values.ts';

/** 하나의 순수 forwarding body와 canonical callable identity다. */
export interface ClientForwardTarget {
  readonly declaration: ts.FunctionLikeDeclaration;
  readonly call: ts.CallExpression;
  readonly parameters: readonly ts.ParameterDeclaration[];
  readonly symbol: ts.Symbol;
  readonly receiver?: ts.Symbol;
  readonly member?: string;
}

/** suppression 전에 확인할 모든 canonical invocation과 closure 상태다. */
export interface ClientForwardCoverage {
  readonly calls: readonly ts.CallExpression[];
  readonly closed: boolean;
}

interface SymbolUses {
  readonly calls: Set<ts.CallExpression>;
  readonly receiverCalls: Map<string, Set<ts.CallExpression>>;
  escaped: boolean;
  exported: boolean;
}

interface ObjectMember {
  readonly declaration: ts.FunctionLikeDeclaration;
  readonly symbol: ts.Symbol;
}

const MAX_ALIAS_DEPTH = 16;
const MAX_ALIAS_EDGES = 20_000;

/** AST 전체를 한 번만 읽고 alias·call·escape closure와 forwarding summary를 memo한다. */
export class ClientWrappers {
  readonly values: ClientValues;
  private readonly uses = new Map<ts.Symbol, SymbolUses>();
  private readonly aliasTargets = new Map<ts.Symbol, ts.Symbol>();
  private readonly reverseAliases = new Map<ts.Symbol, Set<ts.Symbol>>();
  private readonly namespaceValues = new Set<ts.Symbol>();
  private readonly mutated = new Set<ts.Symbol>();
  private readonly summaryMemo = new Map<ts.Symbol, ClientForwardTarget | null>();
  private readonly objectMemo = new Map<ts.Symbol, Map<string, ClientForwardTarget | null>>();
  private readonly objectShapeMemo = new Map<ts.Symbol, ReadonlyMap<string, ObjectMember> | null>();
  private readonly receiverClosedMemo = new Map<ts.Symbol, boolean>();
  private readonly summaries = new Set<ClientForwardTarget>();
  private readonly calls = new Set<ts.CallExpression>();
  private incompleteValue = false;

  constructor(values: ClientValues, includeTests: boolean) {
    this.values = values;
    for (const symbol of values.mutated) {
      this.mutated.add(symbol); this.mutated.add(this.canonical(symbol));
    }
    for (const [path, source] of values.project.files) {
      if (!includeTests && isNodeTestPath(path)) continue;
      const stack: ts.Node[] = [source];
      while (stack.length > 0) {
        const node = stack.pop()!;
        this.recordExportedDeclaration(node);
        if (ts.isIdentifier(node)) this.recordIdentifier(node);
        if (ts.isCallExpression(node)) this.calls.add(node);
        ts.forEachChild(node, child => { stack.push(child); });
      }
    }
    for (const call of this.calls) this.target(call.expression);
  }

  /** alias/forwarding 고정 상한을 넘겨 affected body를 dynamic fallback으로 남겨야 하는지 알린다. */
  get incomplete(): boolean { return this.incompleteValue; }

  /** sink recursion의 고정 상한도 같은 보수적 limitation으로 합친다. */
  markIncomplete(): void { this.incompleteValue = true; }

  /** 현재 callee의 stable project wrapper summary를 memoized lookup으로 반환한다. */
  target(callee: ts.Expression): ClientForwardTarget | undefined {
    const node = transparentValue(callee);
    if (ts.isIdentifier(node)) {
      const symbol = this.symbol(node);
      const root = symbol === undefined ? undefined : this.aliasRoot(symbol);
      return root === undefined ? undefined : this.functionSummary(root);
    }
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(transparentValue(node.expression))) return undefined;
    const receiver = this.symbol(transparentValue(node.expression));
    const root = receiver === undefined ? undefined : this.aliasRoot(receiver);
    if (root !== undefined && this.namespaceValues.has(root)) {
      const member = this.symbol(node.name);
      const callable = member === undefined ? undefined : this.aliasRoot(member);
      return callable === undefined ? undefined : this.functionSummary(callable);
    }
    return root === undefined ? undefined : this.objectSummary(root, node.name.text);
  }

  /** 발견된 순수 wrapper summary다. suppression은 coverage 판정 뒤 별도로 결정한다. */
  targets(): readonly ClientForwardTarget[] { return [...this.summaries]; }

  /** callable alias closure의 모든 call과 export/escape/mutation 폐쇄 여부를 계산한다. */
  coverage(target: ClientForwardTarget): ClientForwardCoverage {
    const queue = [{ symbol: target.symbol, depth: 0 }];
    const seen = new Set<ts.Symbol>();
    const calls = new Set<ts.CallExpression>();
    let closed = target.receiver === undefined || this.receiverClosed(target.receiver);
    if (exported(target.declaration)) closed = false;
    if (target.receiver !== undefined && target.member !== undefined) {
      for (const call of this.uses.get(target.receiver)?.receiverCalls.get(target.member) ?? []) calls.add(call);
    }
    let edges = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const item = queue[cursor]!;
      if (seen.has(item.symbol)) continue;
      seen.add(item.symbol);
      const usage = this.uses.get(item.symbol);
      if (usage !== undefined) {
        for (const call of usage.calls) calls.add(call);
        if (usage.escaped || usage.exported || usage.receiverCalls.size > 0) closed = false;
      }
      if (this.isMutated(item.symbol)) closed = false;
      for (const alias of this.reverseAliases.get(item.symbol) ?? []) {
        if (++edges > MAX_ALIAS_EDGES || item.depth >= MAX_ALIAS_DEPTH) {
          this.incompleteValue = true; closed = false; continue;
        }
        queue.push({ symbol: alias, depth: item.depth + 1 });
      }
    }
    return { calls: [...calls], closed };
  }

  /** raw/import symbol을 프로젝트 canonical identity로 정규화한다. */
  private canonical(symbol: ts.Symbol): ts.Symbol { return resolveAlias(this.values.project.checker, symbol); }

  private symbol(node: ts.Node): ts.Symbol | undefined {
    const shorthand = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? this.values.project.checker.getShorthandAssignmentValueSymbol(node.parent) : undefined;
    const symbol = shorthand ?? symbolAt(this.values.project.checker, node);
    return symbol === undefined ? undefined : this.canonical(symbol);
  }

  private usage(symbol: ts.Symbol): SymbolUses {
    let usage = this.uses.get(symbol);
    if (usage === undefined) {
      usage = { calls: new Set(), receiverCalls: new Map(), escaped: false, exported: false };
      this.uses.set(symbol, usage);
    }
    return usage;
  }

  /** identifier 한 개를 declaration/call/alias/receiver/escape 중 정확히 하나로 분류한다. */
  private recordIdentifier(node: ts.Identifier): void {
    const symbol = this.symbol(node);
    if (symbol === undefined || this.typeOnly(node)) return;
    const usage = this.usage(symbol);
    if (this.declarationName(node)) {
      if (ts.isNamespaceImport(node.parent) && ts.isImportClause(node.parent.parent)
        && !node.parent.parent.isTypeOnly) this.namespaceValues.add(symbol);
      return;
    }
    if (ts.isExportSpecifier(node.parent) || ts.isExportAssignment(node.parent)) {
      usage.exported = true; return;
    }
    const alias = this.aliasDeclaration(node);
    if (alias !== undefined) {
      if (alias.safe) this.addAlias(alias.symbol, symbol);
      else usage.escaped = true;
      return;
    }
    const call = this.directCall(node);
    if (call !== undefined) { usage.calls.add(call); return; }
    const receiver = this.receiverCall(node);
    if (receiver !== undefined) {
      let calls = usage.receiverCalls.get(receiver.name);
      if (calls === undefined) { calls = new Set(); usage.receiverCalls.set(receiver.name, calls); }
      calls.add(receiver.call); return;
    }
    usage.escaped = true;
  }

  private addAlias(alias: ts.Symbol, target: ts.Symbol): void {
    if (alias === target) { this.incompleteValue = true; return; }
    const previous = this.aliasTargets.get(alias);
    if (previous !== undefined && previous !== target) { this.usage(alias).escaped = true; return; }
    this.aliasTargets.set(alias, target);
    let reverse = this.reverseAliases.get(target);
    if (reverse === undefined) { reverse = new Set(); this.reverseAliases.set(target, reverse); }
    reverse.add(alias);
  }

  /** const identifier alias만 closure edge로 인정한다. */
  private aliasDeclaration(node: ts.Identifier): { readonly symbol: ts.Symbol; readonly safe: boolean } | undefined {
    const outer = transparentOuter(node);
    const declaration = outer.parent;
    if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== outer || !ts.isIdentifier(declaration.name)) return undefined;
    const symbol = this.symbol(declaration.name);
    if (symbol === undefined) return undefined;
    const safe = ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0 && !this.isMutated(symbol);
    return { symbol, safe };
  }

  /** property-name 또는 identifier가 실제 call callee인 경우만 반환한다. */
  private directCall(node: ts.Identifier): ts.CallExpression | undefined {
    let site: ts.Node = transparentOuter(node);
    if (ts.isPropertyAccessExpression(site.parent) && site.parent.name === site) site = transparentOuter(site.parent);
    const parent = site.parent;
    return ts.isCallExpression(parent) && parent.expression === site ? parent : undefined;
  }

  /** object receiver의 direct named-method call을 따로 기록한다. */
  private receiverCall(node: ts.Identifier): { readonly name: string; readonly call: ts.CallExpression } | undefined {
    const receiver = transparentOuter(node);
    const access = receiver.parent;
    if (!ts.isPropertyAccessExpression(access) || access.expression !== receiver || access.questionDotToken !== undefined) return undefined;
    const site = transparentOuter(access), call = site.parent;
    return ts.isCallExpression(call) && call.expression === site && call.questionDotToken === undefined
      ? { name: access.name.text, call } : undefined;
  }

  /** declaration modifier와 variable-statement export를 canonical callable/receiver에 기록한다. */
  private recordExportedDeclaration(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined
      && (exported(node) || ts.isSourceFile(node.parent) && !ts.isExternalModule(node.parent))) {
      const symbol = this.symbol(node.name); if (symbol !== undefined) this.usage(symbol).exported = true;
    }
    if (ts.isVariableStatement(node)
      && (exported(node) || ts.isSourceFile(node.parent) && !ts.isExternalModule(node.parent))) {
      for (const declaration of node.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const symbol = this.symbol(declaration.name); if (symbol !== undefined) this.usage(symbol).exported = true;
      }
    }
  }

  /** const alias를 stack 없이 최대 16단계만 따라간다. */
  private aliasRoot(symbol: ts.Symbol): ts.Symbol | undefined {
    let current = symbol;
    const seen = new Set<ts.Symbol>();
    for (let depth = 0; depth <= MAX_ALIAS_DEPTH; depth++) {
      if (seen.has(current)) { this.incompleteValue = true; return undefined; }
      seen.add(current);
      const next = this.aliasTargets.get(current);
      if (next === undefined) return current;
      current = next;
    }
    this.incompleteValue = true;
    return undefined;
  }

  /** 함수 선언 또는 const function value의 cheap structural summary다. */
  private functionSummary(symbol: ts.Symbol): ClientForwardTarget | undefined {
    const cached = this.summaryMemo.get(symbol);
    if (cached !== undefined) return cached === null ? undefined : cached;
    this.summaryMemo.set(symbol, null);
    if (this.isMutated(symbol) || (symbol.declarations?.length ?? 0) !== 1) return undefined;
    const value = symbol.valueDeclaration ?? symbol.declarations?.[0];
    let declaration: ts.FunctionLikeDeclaration | undefined;
    if (value !== undefined && ts.isFunctionDeclaration(value)) declaration = value;
    else if (value !== undefined && ts.isVariableDeclaration(value) && value.initializer !== undefined
      && ts.isVariableDeclarationList(value.parent) && (value.parent.flags & ts.NodeFlags.Const) !== 0) {
      const initializer = transparentValue(value.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) declaration = initializer;
    }
    if (declaration === undefined || this.values.project.pathOf(declaration.getSourceFile()) === undefined) return undefined;
    const summary = this.structuralSummary(symbol, declaration);
    if (summary !== undefined) { this.summaryMemo.set(symbol, summary); this.summaries.add(summary); }
    return summary;
  }

  /** exact const object method만 지원한다. class receiver는 closure가 별도로 증명될 때까지 제외한다. */
  private objectSummary(receiver: ts.Symbol, name: string): ClientForwardTarget | undefined {
    let byName = this.objectMemo.get(receiver);
    if (byName === undefined) { byName = new Map(); this.objectMemo.set(receiver, byName); }
    const cached = byName.get(name);
    if (cached !== undefined) return cached === null ? undefined : cached;
    byName.set(name, null);
    if (!this.receiverClosed(receiver)) return undefined;
    const member = this.objectShape(receiver)?.get(name);
    if (member === undefined) return undefined;
    const summary = this.structuralSummary(member.symbol, member.declaration, receiver, name);
    if (summary !== undefined) { byName.set(name, summary); this.summaries.add(summary); }
    return summary;
  }

  private structuralSummary(symbol: ts.Symbol, declaration: ts.FunctionLikeDeclaration,
    receiver?: ts.Symbol, member?: string): ClientForwardTarget | undefined {
    if (decorated(declaration) || declaration.parameters.some(parameter => decorated(parameter))
      || declaration.asteriskToken !== undefined) return undefined;
    for (const parameter of declaration.parameters) {
      if (!ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.questionToken !== undefined
        || parameter.dotDotDotToken !== undefined || (parameter.modifiers?.length ?? 0) !== 0) return undefined;
    }
    const body = declaration.body;
    if (body === undefined) return undefined;
    const statement = ts.isBlock(body) && body.statements.length === 1 ? body.statements[0] : undefined;
    const expression = ts.isArrowFunction(declaration) && !ts.isBlock(body) ? body
      : statement !== undefined && ts.isReturnStatement(statement) ? statement.expression : undefined;
    let call: ts.Expression | undefined = expression === undefined ? undefined : transparentValue(expression);
    if (call !== undefined && ts.isAwaitExpression(call)) {
      const async = declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true;
      if (!async) return undefined;
      call = transparentValue(call.expression);
    }
    if (call === undefined || !ts.isCallExpression(call) || call.questionDotToken !== undefined
      || declaration.parameters.length !== call.arguments.length) return undefined;
    if (!this.inertCallee(call.expression)) return undefined;
    for (let index = 0; index < declaration.parameters.length; index++) {
      const parameter = declaration.parameters[index]!, argument = transparentValue(call.arguments[index]!);
      if (!ts.isIdentifier(argument) || this.symbol(argument) !== this.symbol(parameter.name)) return undefined;
    }
    return { declaration, call, parameters: declaration.parameters, symbol,
      ...(receiver === undefined ? {} : { receiver }), ...(member === undefined ? {} : { member }) };
  }

  /** nested call/new/await나 this/super를 포함한 callee는 순수 forwarding endpoint가 아니다. */
  private inertCallee(expression: ts.Expression): boolean {
    const pending: ts.Node[] = [expression];
    let nodes = 0;
    while (pending.length > 0) {
      if (++nodes > 256) { this.incompleteValue = true; return false; }
      const node = pending.pop()!;
      if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) return false;
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node)
        || ts.isAwaitExpression(node) || ts.isYieldExpression(node)) return false;
      ts.forEachChild(node, child => { pending.push(child); });
    }
    return true;
  }

  /** object method receiver의 모든 runtime reference가 direct named call인지 확인한다. */
  private receiverClosed(receiver: ts.Symbol): boolean {
    const cached = this.receiverClosedMemo.get(receiver);
    if (cached !== undefined) return cached;
    this.receiverClosedMemo.set(receiver, false);
    if (this.isMutated(receiver) || (this.reverseAliases.get(receiver)?.size ?? 0) > 0) return false;
    const usage = this.uses.get(receiver);
    const shape = this.objectShape(receiver);
    if (usage === undefined || usage.escaped || usage.exported || usage.calls.size !== 0 || shape === undefined) return false;
    for (const name of usage.receiverCalls.keys()) {
      const member = shape.get(name);
      if (member === undefined
        || this.structuralSummary(member.symbol, member.declaration, receiver, name) === undefined) return false;
    }
    this.receiverClosedMemo.set(receiver, true);
    return true;
  }

  /** exact object shape를 pure callable members와 inert primitive metadata로 나눈다. */
  private objectShape(receiver: ts.Symbol): ReadonlyMap<string, ObjectMember> | undefined {
    const cached = this.objectShapeMemo.get(receiver);
    if (cached !== undefined) return cached === null ? undefined : cached;
    this.objectShapeMemo.set(receiver, null);
    const declaration = receiver.valueDeclaration ?? receiver.declarations?.[0];
    if (declaration === undefined || !ts.isVariableDeclaration(declaration) || declaration.initializer === undefined
      || !ts.isVariableDeclarationList(declaration.parent) || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
    const initializer = transparentValue(declaration.initializer);
    if (!ts.isObjectLiteralExpression(initializer)) return undefined;
    const members = new Map<string, ObjectMember>(), names = new Set<string>();
    for (const property of initializer.properties) {
      if ((!ts.isMethodDeclaration(property) && !ts.isPropertyAssignment(property)) || !ts.isIdentifier(property.name)
        || names.has(property.name.text)) return undefined;
      names.add(property.name.text);
      const value = ts.isMethodDeclaration(property) ? property : transparentValue(property.initializer);
      if (!ts.isFunctionLike(value)) {
        if (ts.isPropertyAssignment(property) && inertPrimitive(value)) continue;
        return undefined;
      }
      const symbol = this.symbol(property.name);
      if (symbol === undefined) return undefined;
      members.set(property.name.text, { declaration: value, symbol });
    }
    this.objectShapeMemo.set(receiver, members);
    return members;
  }

  private isMutated(symbol: ts.Symbol): boolean {
    return this.mutated.has(symbol) || this.values.mutated.has(symbol);
  }

  private declarationName(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
      || ts.isImportEqualsDeclaration(parent)) return true;
    return (ts.isVariableDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent)
      || ts.isClassDeclaration(parent) || ts.isClassExpression(parent) || ts.isMethodDeclaration(parent)
      || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isParameter(parent)
      || ts.isBindingElement(parent) || ts.isTypeAliasDeclaration(parent) || ts.isInterfaceDeclaration(parent)
      || ts.isEnumDeclaration(parent) || ts.isModuleDeclaration(parent) || ts.isTypeParameterDeclaration(parent))
      && parent.name === node;
  }

  private typeOnly(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined && !ts.isSourceFile(current)) {
      if (ts.isTypeNode(current) && !ts.isExpressionWithTypeArguments(current)) return true;
      if (ts.isImportSpecifier(current) && current.isTypeOnly || ts.isImportClause(current) && current.isTypeOnly
        || ts.isExportSpecifier(current) && current.isTypeOnly) return true;
      if (ts.isExpression(current) || ts.isStatement(current)) break;
      current = current.parent;
    }
    return false;
  }
}

function transparentOuter(node: ts.Node): ts.Node {
  let current = node;
  while (current.parent !== undefined && (ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)
    || ts.isNonNullExpression(current.parent) || ts.isTypeAssertionExpression(current.parent))
    && current.parent.expression === current) current = current.parent;
  return current;
}

function transparentValue(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)
    || ts.isNonNullExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression;
  return current;
}

function inertPrimitive(expression: ts.Expression): boolean {
  const value = transparentValue(expression);
  return ts.isStringLiteralLike(value) || ts.isNumericLiteral(value) || ts.isBigIntLiteral(value)
    || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword
    || value.kind === ts.SyntaxKind.NullKeyword;
}

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier =>
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) ?? false);
}

function decorated(node: ts.Node): boolean {
  return ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
}
