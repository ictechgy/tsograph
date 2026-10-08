/** Receiver-free primitive 문법을 ValueFlow 없이 charged acyclic summary로 인증한다. */
import ts from 'typescript';
import { inspectSterileLiteral, sterileLiteralOrigin, type SterileLiteralWitness } from './sterile-literals.ts';
import type { ConstructorCarrierContext } from './constructor-carrier.ts';
import { primitiveDependencyTarget } from './primitive-dependency.ts';
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
    const parent: ts.Node = current.parent;
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

/** type-only/ambient reference는 runtime symbol·call 검증 전에 charged하게 건너뛴다. */
export function primitiveErasedReference(token: ts.Node, work: ProofWork): boolean {
  work();
  const source = token.getSourceFile();
  work();
  if (source.isDeclarationFile) return true;
  let current: ts.Node | undefined = token;
  for (let depth = 0; current !== undefined && depth <= 256; depth++) {
    work(depth, depth);
    if (primitiveErasedNode(current, work)) return true;
    work(depth, depth);
    const parent: ts.Node = current.parent;
    if (ts.isSourceFile(parent)) return false;
    current = parent;
  }
  return false;
}

/** interface/type-literal receiver를 nominal type이 아니라 actual const singleton binding으로 대조한다. */
export function primitiveCarrierMethodCall(context: ConstructorCarrierContext, method: ts.MethodDeclaration,
  call: ts.CallExpression, work: ProofWork, facts?: PrimitiveFactObserver): boolean {
  const access = normalizePrimitiveExpression(call.expression, work).inner;
  if (!ts.isPropertyAccessExpression(access)) return false;
  const receiver = normalizePrimitiveExpression(access.expression, work).inner;
  if (!ts.isIdentifier(receiver)) return false;
  work(); const symbol = context.checker.getSymbolAtLocation(receiver);
  if (symbol !== undefined) facts?.symbol(symbol);
  const binding = symbol?.valueDeclaration;
  if (binding === undefined || !ts.isVariableDeclaration(binding) || binding.initializer === undefined
    || !ts.isVariableDeclarationList(binding.parent) || (binding.parent.flags & ts.NodeFlags.Const) === 0) return false;
  const allocation = normalizePrimitiveExpression(binding.initializer, work).inner;
  if (!ts.isNewExpression(allocation)) return false;
  work(); const target = context.checker.getSymbolAtLocation(normalizePrimitiveExpression(allocation.expression, work).inner);
  if (target !== undefined) facts?.symbol(target);
  let declaration = target?.valueDeclaration;
  if (target !== undefined && (target.flags & ts.SymbolFlags.Alias) !== 0) {
    work(); const aliased = context.checker.getAliasedSymbol(target); facts?.symbol(aliased); declaration = aliased.valueDeclaration;
  }
  return declaration === method.parent;
}

/** node-collector의 type-only 경계를 raw modifier work와 함께 재현한다. */
function primitiveErasedNode(node: ts.Node, work: ProofWork): boolean {
  work();
  if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return true;
  work();
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return true;
  work();
  if (ts.canHaveModifiers(node)) {
    work();
    for (const modifier of node.modifiers ?? []) {
      work();
      if (modifier.kind === ts.SyntaxKind.DeclareKeyword) return true;
    }
  }
  return false;
}

/** primitive 결과의 provenance와 실행 전에 필요한 top-level 초기화를 함께 보존한다. */
export interface PrimitiveSummary {
  readonly sites: ReadonlySet<ts.Node>;
  /** 완료된 primitive child가 모든 initializer/write 값을 인증한 literal closure다. */
  readonly literals?: ReadonlyMap<ts.Node, SterileLiteralWitness>;
  readonly captures: ReadonlySet<ts.VariableDeclaration>;
  /** generic body의 요구는 실제 호출에서만 primitive 인자로 해소한다. */
  readonly parameters: ReadonlySet<ts.ParameterDeclaration>;
}
/** 외부 ESM 호출은 가짜 source 위치 대신 module evaluation 완료를 명시한다. */
export interface PrimitiveModuleReadyEntry {
  readonly phase: 'module-ready';
  readonly source: ts.SourceFile;
  readonly arrow: ts.ArrowFunction;
}
/** 실제 문법 위치 또는 ESM module-ready 외부 진입이다. */
export type PrimitiveRuntimeEntry = ts.Node | PrimitiveModuleReadyEntry;

/** module-ready entry를 AST node와 안전하게 구분한다. */
export function isPrimitiveModuleReadyEntry(entry: PrimitiveRuntimeEntry): entry is PrimitiveModuleReadyEntry {
  return 'phase' in entry;
}

/** helper recipe가 실제 읽은 mutable index/manifest 사실을 owning trace에 연결한다. */
export interface PrimitiveFactObserver {
  readonly symbol: (symbol: ts.Symbol) => void;
  readonly tokenOccurrences: (name: string) => void;
  readonly files: () => void;
  readonly effectInventory: () => void;
  readonly moduleEdges: (source: ts.SourceFile) => void;
  readonly hasOpaqueImport: () => void;
  readonly openModules: () => void;
}

/** node의 가장 가까운 callable을 charged parent walk로 찾는다. */
function primitiveCallableOwner(node: ts.Node, work: ProofWork): ts.Node | undefined {
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

/** checker lookup과 alias lookup을 각각 logical operation으로 청구한다. */
function primitiveSymbol(context: ConstructorCarrierContext, node: ts.Node, work: ProofWork,
  facts?: PrimitiveFactObserver): ts.Symbol | undefined {
  work();
  const symbol = context.checker.getSymbolAtLocation(node);
  if (symbol !== undefined) facts?.symbol(symbol);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    work();
    const aliased = context.checker.getAliasedSymbol(symbol);
    facts?.symbol(aliased);
    return aliased;
  }
  return symbol;
}

/** runtime import graph에서 source가 target 초기화 뒤 평가되며 reachable graph가 비순환인지 검증한다. */
function primitiveModuleOrder(context: ConstructorCarrierContext, source: ts.SourceFile, target: ts.SourceFile,
  work: ProofWork, facts?: PrimitiveFactObserver): boolean {
  work();
  facts?.effectInventory();
  const inventory = context.index.effectInventory;
  if (inventory === undefined) return false;
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
    work();
    facts?.moduleEdges(item.file);
    const edges = inventory.manifest.moduleEdges.get(item.file) ?? [];
    for (const edge of edges) {
      work();
      if (!ts.isImportDeclaration(edge.site) && !ts.isExportDeclaration(edge.site)) return false;
      if (edge.target !== undefined) facts?.symbol(edge.target);
      for (const declaration of edge.target?.declarations ?? []) {
        work(); stack.push({ file: declaration.getSourceFile(), leaving: false, depth: item.depth + 1 });
      }
    }
  }
  return reached;
}

/** arrow binding은 body capture 수와 무관하게 모든 actual call보다 먼저 준비되어야 한다. */
function primitiveBindingReady(context: ConstructorCarrierContext, binding: ts.VariableDeclaration,
  bindingSource: ts.SourceFile, invocation: ts.CallExpression, work: ProofWork,
  facts?: PrimitiveFactObserver): boolean {
  work();
  const invocationSource = invocation.getSourceFile();
  if (invocationSource === bindingSource) {
    work();
    return binding.end < invocation.pos;
  }
  return primitiveModuleOrder(context, invocationSource, bindingSource, work, facts);
}

/** direct/named export와 모든 direct zero-argument 호출을 닫은 arrow의 실제 runtime entry를 반환한다. */
export function primitiveCallRuntimeEntries(context: ConstructorCarrierContext, call: ts.CallExpression,
  work: ProofWork, facts?: PrimitiveFactObserver): readonly PrimitiveRuntimeEntry[] | undefined {
  const owner = primitiveCallableOwner(call, work);
  if (owner === undefined) return [call];
  if (!ts.isArrowFunction(owner)) return undefined;
  work();
  if (owner.body !== climbPrimitiveWrappers(call, work)) return undefined;
  for (const modifier of owner.modifiers ?? []) {
    work();
    if (modifier.kind === ts.SyntaxKind.AsyncKeyword) return undefined;
  }
  if (owner.parameters.length !== 0) return primitiveInlineWrapperEntries(context, owner, call, work, facts);
  const outer = climbPrimitiveWrappers(owner, work);
  work();
  const binding = outer.parent;
  if (!ts.isVariableDeclaration(binding) || binding.initializer !== outer || !ts.isIdentifier(binding.name)
    || !ts.isVariableDeclarationList(binding.parent) || (binding.parent.flags & ts.NodeFlags.Const) === 0
    || (binding.parent.flags & ts.NodeFlags.Using) !== 0 || !ts.isVariableStatement(binding.parent.parent)) return undefined;
  work();
  const source = binding.getSourceFile();
  if (binding.parent.parent.parent !== source) return undefined;
  const statement = binding.parent.parent;
  const symbol = primitiveSymbol(context, binding.name, work, facts);
  if (symbol === undefined) return undefined;
  work();
  if ((context.index.identifierWrites.get(symbol)?.length ?? 0) !== 0) return undefined;
  work();
  const declarations = symbol.declarations ?? [];
  for (const declaration of declarations) {
    work();
    if (declaration !== binding) return undefined;
  }
  work();
  facts?.hasOpaqueImport();
  if (context.index.hasOpaqueImport) return undefined;
  work();
  facts?.openModules();
  if (context.index.openModules.size !== 0) return undefined;
  let exported = false;
  for (const modifier of statement.modifiers ?? []) {
    work();
    if (modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword) exported = true;
    else return undefined;
  }
  work();
  exported ||= context.index.exportedSymbols.has(symbol);
  const entries: PrimitiveRuntimeEntry[] = [];
  work();
  const references = context.index.references.get(symbol) ?? [];
  for (const reference of references) {
    work();
    if (primitiveErasedReference(reference, work)) continue;
    const site = primitiveReferenceSite(reference, work);
    const invocation = site.parent;
    if (!ts.isCallExpression(invocation) || invocation.expression !== site || invocation.questionDotToken !== undefined
      || invocation.arguments.length !== 0 || primitiveSymbol(context, reference, work, facts) !== symbol) return undefined;
    if (!primitiveBindingReady(context, binding, source, invocation, work, facts)) return undefined;
    entries.push(invocation);
  }
  if (exported) {
    if (!primitiveModuleOrder(context, source, source, work, facts)) return undefined;
    work(); entries.push({ phase: 'module-ready', source, arrow: owner });
  }
  return entries;
}

/** Stage0가 인증하는 exact inline callback은 inner method를 outer synchronous wrapper call에서 실행한다. */
function primitiveInlineWrapperEntries(context: ConstructorCarrierContext, owner: ts.ArrowFunction,
  call: ts.CallExpression, work: ProofWork, facts?: PrimitiveFactObserver): readonly PrimitiveRuntimeEntry[] | undefined {
  work();
  if (owner.parameters.length !== 1 || call.arguments.length !== 0) return undefined;
  const parameter = owner.parameters[0]!;
  work();
  if (!ts.isIdentifier(parameter.name) || parameter.initializer !== undefined || parameter.questionToken !== undefined
    || parameter.dotDotDotToken !== undefined || (parameter.modifiers?.length ?? 0) !== 0) return undefined;
  const access = normalizePrimitiveExpression(call.expression, work).inner;
  if (!ts.isPropertyAccessExpression(access) || access.questionDotToken !== undefined) return undefined;
  const receiver = normalizePrimitiveExpression(access.expression, work).inner;
  if (!ts.isIdentifier(receiver)
    || primitiveSymbol(context, receiver, work, facts) !== primitiveSymbol(context, parameter.name, work, facts)) {
    return undefined;
  }
  const callback = climbPrimitiveWrappers(owner, work);
  work();
  const wrapperCall = callback.parent;
  if (!ts.isCallExpression(wrapperCall) || wrapperCall.questionDotToken !== undefined
    || wrapperCall.arguments.length !== 2) return undefined;
  for (const argument of wrapperCall.arguments) { work(); }
  if (wrapperCall.arguments[1] !== callback
    || !ts.isIdentifier(normalizePrimitiveExpression(wrapperCall.arguments[0]!, work).inner)) return undefined;
  const callee = normalizePrimitiveExpression(wrapperCall.expression, work).inner;
  if (!ts.isIdentifier(callee)) return undefined;
  const target = primitiveSymbol(context, callee, work, facts)?.valueDeclaration;
  if (target === undefined || !ts.isFunctionDeclaration(target) || target.body === undefined) return undefined;
  work();
  const source = target.getSourceFile();
  if (target.parent !== source || target.asteriskToken !== undefined || target.parameters.length !== 2) return undefined;
  for (const modifier of target.modifiers ?? []) {
    work();
    if (modifier.kind === ts.SyntaxKind.AsyncKeyword || modifier.kind === ts.SyntaxKind.Decorator) return undefined;
  }
  const [value, callbackParameter] = target.parameters;
  if (value === undefined || callbackParameter === undefined || !ts.isIdentifier(value.name)
    || !ts.isIdentifier(callbackParameter.name)) return undefined;
  for (const formal of target.parameters) {
    work();
    if (formal.initializer !== undefined || formal.questionToken !== undefined || formal.dotDotDotToken !== undefined
      || (formal.modifiers?.length ?? 0) !== 0) return undefined;
  }
  work();
  const statement = target.body.statements.length === 1 ? target.body.statements[0] : undefined;
  const invocation = statement !== undefined && (ts.isReturnStatement(statement) || ts.isExpressionStatement(statement))
    ? statement.expression : undefined;
  if (invocation === undefined || !ts.isCallExpression(invocation) || invocation.questionDotToken !== undefined
    || invocation.arguments.length !== 1 || !ts.isIdentifier(invocation.expression)) return undefined;
  for (const argument of invocation.arguments) { work(); }
  if (!ts.isIdentifier(invocation.arguments[0]!)
    || primitiveSymbol(context, invocation.expression, work, facts) !== primitiveSymbol(context, callbackParameter.name, work, facts)
    || primitiveSymbol(context, invocation.arguments[0]!, work, facts) !== primitiveSymbol(context, value.name, work, facts)) return undefined;
  return primitiveCallRuntimeEntries(context, wrapperCall, work, facts);
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

/** helper가 실제로 조회한 symbol별 index 사실의 identity snapshot이다. */
interface PrimitiveFactSnapshot {
  readonly symbol: ts.Symbol;
  readonly flags: ts.SymbolFlags;
  readonly valueDeclaration: ts.Declaration | undefined;
  readonly referencesMap: ReadonlyMap<ts.Symbol, readonly ts.Node[]>;
  readonly referencesPresent: boolean;
  readonly references: readonly ts.Node[];
  readonly identifierWritesMap: ReadonlyMap<ts.Symbol, readonly (ts.Expression | undefined)[]>;
  readonly identifierWritesPresent: boolean;
  readonly identifierWrites: readonly (ts.Expression | undefined)[];
  readonly exported: boolean;
  readonly declarations: readonly ts.Declaration[];
}

/** 한 recipe callback이 실제로 읽은 mutable index/manifest fact key 집합이다. */
interface PrimitiveFactReads {
  readonly symbols: Set<ts.Symbol>;
  readonly tokenOccurrences: Set<string>;
  readonly moduleEdges: Set<ts.SourceFile>;
  files: boolean;
  effectInventory: boolean;
  hasOpaqueImport: boolean;
  openModules: boolean;
}

/** 첫 helper fact 읽기의 list를 element identity까지 charged snapshot으로 복사한다. */
function primitiveFactList<T>(read: () => readonly T[], work: ProofWork): readonly T[] {
  work(); const source = read();
  work(); const length = source.length;
  const result: T[] = [];
  for (let index = 0; index < length; index++) { work(); result.push(source[index]!); }
  return Object.freeze(result);
}

/** method-name census가 읽은 현재 token list를 재감사 가능한 ordered guards로 고정한다. */
function primitiveTokenGuards(context: ConstructorCarrierContext, name: string,
  work: ProofWork): readonly ProofGuard[] {
  work(); const occurrencesMap = context.index.tokenOccurrences;
  work(); const present = occurrencesMap.has(name);
  const occurrences = primitiveFactList(() => occurrencesMap.get(name) ?? [], work);
  const guards: ProofGuard[] = [];
  work(); guards.push(Object.freeze({ read: () => context.index.tokenOccurrences === occurrencesMap }));
  work(); guards.push(Object.freeze({ read: () => context.index.tokenOccurrences.has(name) === present }));
  const length = occurrences.length;
  work(); guards.push(Object.freeze({ reconstruct: true,
    read: () => (context.index.tokenOccurrences.get(name)?.length ?? 0) === length }));
  for (let index = 0; index < length; index++) {
    const value = occurrences[index]!;
    work(); guards.push(Object.freeze({ reconstruct: true,
      read: () => context.index.tokenOccurrences.get(name)?.[index] === value }));
  }
  return Object.freeze(guards);
}

/** plan census가 순회한 current file list를 owning inventory recipe가 다시 감사한다. */
function primitiveFilesGuards(context: ConstructorCarrierContext, work: ProofWork): readonly ProofGuard[] {
  work(); const files = context.index.files;
  const guards: ProofGuard[] = [];
  work(); guards.push(Object.freeze({ reconstruct: true, read: () => context.index.files === files }));
  work(); const length = files.length;
  work(); guards.push(Object.freeze({ reconstruct: true, read: () => context.index.files.length === length }));
  for (let index = 0; index < length; index++) {
    const file = files[index]!;
    work(); guards.push(Object.freeze({ reconstruct: true, read: () => context.index.files[index] === file }));
  }
  return Object.freeze(guards);
}

/** module-order walk의 inventory/manifest/map identity를 current entry에 묶는다. */
function primitiveInventoryGuards(context: ConstructorCarrierContext, work: ProofWork): readonly ProofGuard[] {
  work(); const inventory = context.index.effectInventory;
  const guards: ProofGuard[] = [];
  work(); guards.push(Object.freeze({ read: () => context.index.effectInventory === inventory }));
  if (inventory !== undefined) {
    work(); const manifest = inventory.manifest;
    work(); guards.push(Object.freeze({ read: () => context.index.effectInventory?.manifest === manifest }));
    work(); const moduleEdges = manifest.moduleEdges;
    work(); guards.push(Object.freeze({ read: () => context.index.effectInventory?.manifest.moduleEdges === moduleEdges }));
  }
  return Object.freeze(guards);
}

/** 실제 방문한 source의 module edge list와 module-order가 읽는 field만 재감사한다. */
function primitiveModuleEdgeGuards(context: ConstructorCarrierContext, source: ts.SourceFile,
  work: ProofWork): readonly ProofGuard[] {
  const read = () => context.index.effectInventory?.manifest.moduleEdges.get(source) ?? [];
  work(); const map = context.index.effectInventory?.manifest.moduleEdges;
  work(); const present = map?.has(source) === true;
  const edges = primitiveFactList(read, work);
  const guards: ProofGuard[] = [];
  work(); guards.push(Object.freeze({ read: () => context.index.effectInventory?.manifest.moduleEdges === map }));
  work(); guards.push(Object.freeze({ read: () =>
    (context.index.effectInventory?.manifest.moduleEdges.has(source) === true) === present }));
  const length = edges.length;
  work(); guards.push(Object.freeze({ reconstruct: true, read: () => read().length === length }));
  for (let index = 0; index < length; index++) {
    const edge = edges[index]!;
    work(); guards.push(Object.freeze({ reconstruct: true, read: () => read()[index] === edge }));
    work(); guards.push(Object.freeze({ reconstruct: true, read: () => read()[index]?.site === edge.site }));
    work(); guards.push(Object.freeze({ reconstruct: true, read: () => read()[index]?.target === edge.target }));
  }
  return Object.freeze(guards);
}

/** runtime-entry closure가 읽은 global import/open-module facts를 고정한다. */
function primitiveRuntimeGuards(context: ConstructorCarrierContext, kind: 'opaque-import' | 'open-modules',
  work: ProofWork): readonly ProofGuard[] {
  const guards: ProofGuard[] = [];
  if (kind === 'opaque-import') {
    work(); const expected = context.index.hasOpaqueImport;
    work(); guards.push(Object.freeze({ read: () => context.index.hasOpaqueImport === expected }));
    return Object.freeze(guards);
  }
  work(); const openModules = context.index.openModules;
  work(); guards.push(Object.freeze({ read: () => context.index.openModules === openModules }));
  work(); const size = openModules.size;
  work(); guards.push(Object.freeze({ read: () => context.index.openModules.size === size }));
  for (const symbol of openModules) {
    work(); guards.push(Object.freeze({ read: () => context.index.openModules.has(symbol) }));
  }
  return Object.freeze(guards);
}

/** shared helper가 실제 소비한 symbol fact에 대한 O(1) ordered guards를 만든다. */
function primitiveFactGuards(context: ConstructorCarrierContext, symbols: ReadonlySet<ts.Symbol>, work: ProofWork): readonly ProofGuard[] {
  const expected: PrimitiveFactSnapshot[] = [];
  for (const symbol of symbols) {
    work(); const flags = symbol.flags;
    work(); const valueDeclaration = symbol.valueDeclaration;
    work(); const referencesMap = context.index.references;
    work(); const referencesPresent = context.index.references.has(symbol);
    const references = primitiveFactList(() => context.index.references.get(symbol) ?? [], work);
    work(); const identifierWritesMap = context.index.identifierWrites;
    work(); const identifierWritesPresent = context.index.identifierWrites.has(symbol);
    const identifierWrites = primitiveFactList(() => context.index.identifierWrites.get(symbol) ?? [], work);
    work(); const exported = context.index.exportedSymbols.has(symbol);
    const declarations = primitiveFactList(() => symbol.declarations ?? [], work);
    expected.push(Object.freeze({ symbol, flags, valueDeclaration, referencesMap, referencesPresent, references, identifierWritesMap,
      identifierWritesPresent, identifierWrites, exported, declarations }));
  }
  const guards: ProofGuard[] = [];
  for (const fact of expected) {
    work(); guards.push(Object.freeze({ read: () => fact.symbol.flags === fact.flags }));
    work(); guards.push(Object.freeze({ read: () => fact.symbol.valueDeclaration === fact.valueDeclaration }));
    work(); guards.push(Object.freeze({ read: () => context.index.references === fact.referencesMap }));
    work(); guards.push(Object.freeze({ read: () => context.index.references.has(fact.symbol) === fact.referencesPresent }));
    work(); guards.push(Object.freeze({ read: () => context.index.identifierWrites === fact.identifierWritesMap }));
    work(); guards.push(Object.freeze({ read: () => context.index.identifierWrites.has(fact.symbol) === fact.identifierWritesPresent }));
    const writesLength = fact.identifierWrites.length;
    work(); guards.push(Object.freeze({ read: () => (context.index.identifierWrites.get(fact.symbol)?.length ?? 0) === writesLength }));
    for (let index = 0; index < writesLength; index++) {
      const value = fact.identifierWrites[index];
      work(); guards.push(Object.freeze({ read: () => context.index.identifierWrites.get(fact.symbol)?.[index] === value }));
    }
    work(); guards.push(Object.freeze({ read: () => context.index.exportedSymbols.has(fact.symbol) === fact.exported }));
    const declarationsLength = fact.declarations.length;
    work(); guards.push(Object.freeze({ read: () => (fact.symbol.declarations?.length ?? 0) === declarationsLength }));
    for (let index = 0; index < declarationsLength; index++) {
      const value = fact.declarations[index]!;
      work(); guards.push(Object.freeze({ read: () => fact.symbol.declarations?.[index] === value }));
    }
    // reference 내용은 helper 문법이 전체를 다시 감사할 수 있다. 다른 hard fact를 먼저 고정한다.
    const referencesLength = fact.references.length;
    work(); guards.push(Object.freeze({ reconstruct: true,
      read: () => (context.index.references.get(fact.symbol)?.length ?? 0) === referencesLength }));
    for (let index = 0; index < referencesLength; index++) {
      const value = fact.references[index]!;
      work(); guards.push(Object.freeze({ reconstruct: true,
        read: () => context.index.references.get(fact.symbol)?.[index] === value }));
    }
  }
  return Object.freeze(guards);
}

/** 각 initializer·argument·callee를 같은 capability DAG의 개별 dependency로 구성한다. */
export class PrimitiveHelpers {
  private readonly recipes = new Map<PrimitiveNode, ProofRecipe<PrimitiveSummary>>();
  private readonly instantiations = new Map<ts.CallExpression, Map<ts.MethodDeclaration, ProofRecipe<PrimitiveSummary>>>();
  private readonly entries = new Map<ts.MethodDeclaration, ProofRecipe<PrimitiveSummary>>();
  private readonly context: ConstructorCarrierContext;
  private readonly policy: PrimitivePolicy;
  private consumedFacts: PrimitiveFactReads | undefined;
  private readonly factGuards = new Map<ts.Symbol, readonly ProofGuard[]>();
  private readonly tokenGuards = new Map<string, readonly ProofGuard[]>();
  private readonly moduleEdgeGuards = new Map<ts.SourceFile, readonly ProofGuard[]>();
  private filesGuards: readonly ProofGuard[] | undefined;
  private inventoryGuards: readonly ProofGuard[] | undefined;
  private opaqueImportGuards: readonly ProofGuard[] | undefined;
  private openModuleGuards: readonly ProofGuard[] | undefined;
  private readonly facts: PrimitiveFactObserver;
  constructor(context: ConstructorCarrierContext, policy: PrimitivePolicy) {
    this.context = context; this.policy = policy;
    this.facts = Object.freeze({
      symbol: (symbol: ts.Symbol) => { this.consumedFacts?.symbols.add(symbol); },
      tokenOccurrences: (name: string) => { this.consumedFacts?.tokenOccurrences.add(name); },
      files: () => { if (this.consumedFacts !== undefined) this.consumedFacts.files = true; },
      effectInventory: () => { if (this.consumedFacts !== undefined) this.consumedFacts.effectInventory = true; },
      moduleEdges: (source: ts.SourceFile) => { this.consumedFacts?.moduleEdges.add(source); },
      hasOpaqueImport: () => { if (this.consumedFacts !== undefined) this.consumedFacts.hasOpaqueImport = true; },
      openModules: () => { if (this.consumedFacts !== undefined) this.consumedFacts.openModules = true; },
    });
  }

  /** 같은 질의 안에서만 fact 구성을 공유한다. 다음 질의의 재평가는 현재 기준선을 다시 읽는다. */
  beginQuery(): void {
    this.factGuards.clear(); this.tokenGuards.clear(); this.moduleEdgeGuards.clear();
    this.filesGuards = undefined; this.inventoryGuards = undefined;
    this.opaqueImportGuards = undefined; this.openModuleGuards = undefined;
  }

  /** recipe callback의 실제 fact read를 모아 같은 before/after trace에 ordered guard를 남긴다. */
  withFactReads<T>(work: ProofWork, read: (facts: PrimitiveFactObserver) => T): T {
    if (this.consumedFacts !== undefined) return read(this.facts);
    const facts: PrimitiveFactReads = { symbols: new Set(), tokenOccurrences: new Set(), moduleEdges: new Set(),
      files: false, effectInventory: false, hasOpaqueImport: false, openModules: false };
    this.consumedFacts = facts;
    let value!: T;
    try { value = read(this.facts); }
    finally { this.consumedFacts = undefined; }
    this.requireFactReads(facts, work);
    return value;
  }

  /** query-local blueprint를 공유하되 각 owning recipe의 guard replay 비용은 독립 청구한다. */
  private requireFactReads(facts: PrimitiveFactReads, work: ProofWork): void {
    for (const symbol of facts.symbols) {
      work(); let guards = this.factGuards.get(symbol);
      if (guards === undefined) {
        guards = primitiveFactGuards(this.context, new Set([symbol]), work); this.factGuards.set(symbol, guards);
      }
      for (const guard of guards) work.require(guard, true);
    }
    for (const name of facts.tokenOccurrences) {
      work(); let guards = this.tokenGuards.get(name);
      if (guards === undefined) {
        guards = primitiveTokenGuards(this.context, name, work); this.tokenGuards.set(name, guards);
      }
      for (const guard of guards) work.require(guard, true);
    }
    if (facts.files) {
      work(); this.filesGuards ??= primitiveFilesGuards(this.context, work);
      for (const guard of this.filesGuards) work.require(guard, true);
    }
    if (facts.hasOpaqueImport) {
      work(); this.opaqueImportGuards ??= primitiveRuntimeGuards(this.context, 'opaque-import', work);
      for (const guard of this.opaqueImportGuards) work.require(guard, true);
    }
    if (facts.openModules) {
      work(); this.openModuleGuards ??= primitiveRuntimeGuards(this.context, 'open-modules', work);
      for (const guard of this.openModuleGuards) work.require(guard, true);
    }
    if (facts.effectInventory) {
      work(); this.inventoryGuards ??= primitiveInventoryGuards(this.context, work);
      for (const guard of this.inventoryGuards) work.require(guard, true);
    }
    for (const source of facts.moduleEdges) {
      work(); let guards = this.moduleEdgeGuards.get(source);
      if (guards === undefined) {
        guards = primitiveModuleEdgeGuards(this.context, source, work); this.moduleEdgeGuards.set(source, guards);
      }
      for (const guard of guards) work.require(guard, true);
    }
  }

  /** recipe 생성 자체는 AST를 탐색하지 않는다. 실제 구성은 첫 charged lookup에서만 한다. */
  recipe(node: PrimitiveNode): ProofRecipe<PrimitiveSummary> {
    const known = this.recipes.get(node);
    if (known !== undefined) return known;
    let accepted = false;
    let sites = new Set<ts.Node>();
    let captures = new Set<ts.VariableDeclaration>();
    let parameters = new Set<ts.ParameterDeclaration>();
    let literals = new Map<ts.Node, SterileLiteralWitness>();
    const recipe: ProofRecipe<PrimitiveSummary> = {
      id: `${node.getSourceFile().fileName}:${node.pos}:${node.end}:stage4-primitive`,
      identity: node, capability: 'primitive-effects', mode: 'extended', valid: this.policy.valid,
      dependencies: (work) => this.withFactReads(work, () => {
        sites = new Set(); captures = new Set(); parameters = new Set(); literals = new Map();
        const edges: ProofEdge[] = [];
        accepted = this.inspect(node, work, sites, captures, parameters, edges, literals);
        return edges;
      }),
      evaluate: (work, children) => this.withFactReads(work, () => {
        work();
        if (!accepted) return { kind: 'rejected', reason: 'primitive-helper' };
        for (const child of children) {
          work();
          if (child.kind !== 'proved') return child;
          const summary = child.value as PrimitiveSummary;
          for (const [identity, literal] of summary.literals ?? []) { work(); literals.set(identity, literal); }
          for (const site of summary.sites) { work(); sites.add(site); }
          for (const capture of summary.captures) { work(); captures.add(capture); }
          for (const parameter of summary.parameters) { work(); parameters.add(parameter); }
        }
        // callee의 formal 요구는 exact-arity의 모든 인자 child가 완료된 뒤 해소한다.
        if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node)) {
          const expression = normalizePrimitiveExpression(node, work).inner;
          if (ts.isCallExpression(expression)) {
            const target = this.symbol(normalizePrimitiveExpression(expression.expression, work).inner, work)?.valueDeclaration;
            if (target !== undefined && (ts.isFunctionDeclaration(target) || ts.isMethodDeclaration(target))) {
              for (const parameter of target.parameters) { work(); parameters.delete(parameter); }
            }
          }
        }
        return { kind: 'proved', value: { sites, captures, parameters, literals } };
      }),
    };
    this.recipes.set(node, recipe); return recipe;
  }

  /** descriptor가 지정한 실제 dependency call에서만 completed body의 formal 요구를 인자로 해소한다. */
  instantiationRecipe(call: ts.CallExpression, target: ts.MethodDeclaration): ProofRecipe<PrimitiveSummary> {
    let byTarget = this.instantiations.get(call);
    if (byTarget === undefined) { byTarget = new Map(); this.instantiations.set(call, byTarget); }
    const known = byTarget.get(target);
    if (known !== undefined) return known;
    let accepted = false;
    const recipe: ProofRecipe<PrimitiveSummary> = {
      id: `${call.getSourceFile().fileName}:${call.pos}:${call.end}:${target.getSourceFile().fileName}:${target.pos}:stage5-instantiation`,
      identity: call, capability: 'primitive-effects', mode: 'extended', valid: this.policy.valid,
      dependencies: (work) => this.withFactReads(work, () => {
        accepted = false;
        const edges: ProofEdge[] = [];
        work();
        if (call.questionDotToken !== undefined || call.arguments.length !== target.parameters.length) return edges;
        work(); if (this.context.checker.getResolvedSignature(call)?.declaration !== target
          && primitiveDependencyTarget(this.context, call, work, this.facts.symbol) !== target) return edges;
        // physical read와 인자 평가의 요구를 원래 left-to-right 순서로 기록한다.
        for (const argument of call.arguments) {
          work(); if (ts.isSpreadElement(argument)) return edges;
          edges.push({ recipe: this.recipe(argument), capability: 'primitive-effects', depth: 1, frames: 1 });
        }
        work(); edges.push({ recipe: this.recipe(target), capability: 'primitive-effects', depth: 1, frames: 1 });
        if (target.parameters.length > 0) {
          work(); edges.push({ recipe: this.entryRecipe(target), capability: 'primitive-effects', depth: 1, frames: 1 });
        }
        accepted = true; return edges;
      }),
      evaluate: (work, children) => {
        work(); if (!accepted) return { kind: 'rejected', reason: 'primitive-instantiation' };
        for (const child of children) { work(); if (child.kind !== 'proved') return child; }
        const summary = primitiveChildren(children, work);
        const parameters = new Set<ts.ParameterDeclaration>();
        for (const parameter of summary.parameters) { work(); parameters.add(parameter); }
        for (const parameter of target.parameters) { work(); parameters.delete(parameter); }
        const sites = new Set<ts.Node>();
        for (const site of summary.sites) { work(); sites.add(site); }
        work(); sites.add(call);
        return { kind: 'proved', value: { ...summary, sites, parameters } };
      },
    };
    byTarget.set(target, recipe); return recipe;
  }

  /** required method entry의 모든 참조를 감사하고 각 실제 인자를 독립 DAG child로 인증한다. */
  entryRecipe(method: ts.MethodDeclaration): ProofRecipe<PrimitiveSummary> {
    const known = this.entries.get(method);
    if (known !== undefined) return known;
    let accepted = false;
    let calls: ts.CallExpression[] = [];
    let runtimeEntries = new Map<ts.CallExpression, readonly PrimitiveRuntimeEntry[] | 'deferred'>();
    const recipe: ProofRecipe<PrimitiveSummary> = {
      id: `${method.getSourceFile().fileName}:${method.pos}:${method.end}:stage5-entry`,
      identity: method.name, capability: 'primitive-effects', mode: 'extended', valid: this.policy.valid,
      dependencies: (work) => this.withFactReads(work, () => {
        calls = []; runtimeEntries = new Map(); accepted = false;
        const edges: ProofEdge[] = [];
        work();
        if (method.body === undefined || method.asteriskToken !== undefined || work.observe(this.policy.open(method))) return edges;
        for (const modifier of method.modifiers ?? []) {
          work(); if (modifier.kind !== ts.SyntaxKind.PublicKeyword) return edges;
        }
        for (const parameter of method.parameters) {
          work();
          if (!ts.isIdentifier(parameter.name) || parameter.name.text === 'this' || parameter.name.text === 'arguments'
            || parameter.initializer !== undefined || parameter.questionToken !== undefined || parameter.dotDotDotToken !== undefined
            || (parameter.modifiers?.length ?? 0) !== 0 || !this.immutable(parameter.name, work)) return edges;
        }
        const symbol = this.symbol(method.name, work);
        if (symbol === undefined) return edges;
        work(); if ((this.context.index.identifierWrites.get(symbol)?.length ?? 0) !== 0) return edges;
        work();
        const declarations = symbol.declarations ?? [];
        for (const declaration of declarations) { work(); if (declaration !== method) return edges; }
        work();
        if (!ts.isIdentifier(method.name) && !ts.isStringLiteralLike(method.name) && !ts.isNumericLiteral(method.name)) return edges;
        work();
        this.facts.tokenOccurrences(method.name.text);
        const occurrences = this.context.index.tokenOccurrences.get(method.name.text) ?? [];
        for (const reference of occurrences) {
          work();
          if (reference === method.name) continue;
          if (primitiveErasedReference(reference, work)) continue;
          const site = primitiveReferenceSite(reference, work);
          const parentCall = ts.isCallExpression(site.parent) && site.parent.expression === site
            ? site.parent : undefined;
          const resolved = this.symbol(reference, work);
          const concreteEntry = parentCall !== undefined
            && primitiveCarrierMethodCall(this.context, method, parentCall, work, this.facts);
          if (resolved?.valueDeclaration !== method && (parentCall === undefined
            || primitiveDependencyTarget(this.context, parentCall, work, this.facts.symbol) !== method)
            && !concreteEntry) {
            if (resolved === undefined && (ts.isPropertyAccessExpression(reference.parent)
              || ts.isElementAccessExpression(reference.parent))) return edges;
            continue;
          }
          const call = site.parent;
          const access = ts.isExpression(site) ? normalizePrimitiveExpression(site, work).inner : undefined;
          if (access === undefined || !ts.isPropertyAccessExpression(access) || access.questionDotToken !== undefined
            || !ts.isCallExpression(call) || call.expression !== site || call.questionDotToken !== undefined
            || call.arguments.length !== method.parameters.length) return edges;
          work(); if (this.context.checker.getResolvedSignature(call)?.declaration !== method
            && primitiveDependencyTarget(this.context, call, work, this.facts.symbol) !== method
            && !primitiveCarrierMethodCall(this.context, method, call, work, this.facts)) return edges;
          const owner = this.callableOwner(call, work);
          const entries = owner !== undefined && ts.isArrowFunction(owner)
            ? primitiveCallRuntimeEntries(this.context, call, work, this.facts) : owner === undefined ? [call] : 'deferred';
          if (entries === undefined) return edges;
          if (entries !== 'deferred' && entries.length === 0) continue;
          work(); calls.push(call);
          work(); runtimeEntries.set(call, entries);
          for (const argument of call.arguments) {
            work(); if (ts.isSpreadElement(argument)) return edges;
            edges.push({ recipe: this.recipe(argument), capability: 'primitive-effects', depth: 1, frames: 1 });
          }
        }
        accepted = calls.length > 0;
        return edges;
      }),
      evaluate: (work, children) => this.withFactReads(work, () => {
        work();
        if (!accepted) return { kind: 'rejected', reason: 'primitive-entry' };
        for (const child of children) { work(); if (child.kind !== 'proved') return child; }
        const summary = primitiveChildren(children, work);
        const argumentsByIdentity = new Map<object, PrimitiveSummary>();
        for (const child of children) {
          work(); if (child.kind === 'proved') argumentsByIdentity.set(child.certificate.identity, child.value as PrimitiveSummary);
        }
        const captures = new Set<ts.VariableDeclaration>();
        for (const call of calls) {
          work();
          const entries = runtimeEntries.get(call);
          if (entries === undefined) return { kind: 'incomplete', reason: 'entry-summary' };
          const deferred = entries === 'deferred';
          for (const argument of call.arguments) {
            work(); const argumentSummary = argumentsByIdentity.get(argument);
            if (argumentSummary === undefined) return { kind: 'incomplete', reason: 'argument-summary' };
            // 각 실제 호출과 module-ready 외부 entry를 모두 검사한다. method body는 enclosing entry에 남긴다.
            if (entries !== 'deferred') {
              for (const entry of entries) {
                work();
                if (!this.initialized(argumentSummary, entry, work)) {
                  return { kind: 'rejected', reason: 'primitive-entry-initialization' };
                }
              }
            }
            if (deferred) for (const capture of argumentSummary.captures) { work(); captures.add(capture); }
          }
        }
        const sites = new Set<ts.Node>();
        for (const site of summary.sites) { work(); sites.add(site); }
        const parameters = new Set<ts.ParameterDeclaration>();
        for (const parameter of summary.parameters) { work(); parameters.add(parameter); }
        for (const parameter of method.parameters) { work(); sites.add(parameter); sites.add(parameter.name); parameters.delete(parameter); }
        return { kind: 'proved', value: { ...summary, sites, captures, parameters } };
      }),
    };
    this.entries.set(method, recipe); return recipe;
  }

  /** 외부 entry는 static import 경로와 실제 source-local 초기화 순서를 별개로 검증한다. */
  initialized(summary: PrimitiveSummary, entry: PrimitiveRuntimeEntry, work: ProofWork): boolean {
    return this.withFactReads(work, () => {
      if (isPrimitiveModuleReadyEntry(entry) && !this.moduleOrder(entry.source, entry.source, work)) return false;
      for (const capture of summary.captures) {
        work();
        if (isPrimitiveModuleReadyEntry(entry)) {
          const target = capture.getSourceFile();
          if (target === entry.source) {
            work();
            if (!ts.isVariableDeclarationList(capture.parent) || !ts.isVariableStatement(capture.parent.parent)
              || capture.parent.parent.parent !== entry.source) return false;
          } else if (!this.moduleOrder(entry.source, target, work)) return false;
        } else if (!this.before(capture, entry, work)) return false;
      }
      return true;
    });
  }

  /** 요약에 primitive만 넣으므로 parameter 타입이나 literal의 TS 타입은 사용하지 않는다. */
  private inspect(node: PrimitiveNode, work: ProofWork, sites: Set<ts.Node>,
    captures: Set<ts.VariableDeclaration>, parameters: Set<ts.ParameterDeclaration>, edges: ProofEdge[], literals: Map<ts.Node, SterileLiteralWitness>): boolean {
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
      }
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
          && (ts.isCallExpression(normalizePrimitiveExpression(statement.expression, work).inner)
            || ts.isBinaryExpression(normalizePrimitiveExpression(statement.expression, work).inner)
            || ts.isPropertyAccessExpression(normalizePrimitiveExpression(statement.expression, work).inner)
            || ts.isElementAccessExpression(normalizePrimitiveExpression(statement.expression, work).inner))) {
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
    if (ts.isBinaryExpression(expression)) {
      const outerAssignment = climbPrimitiveWrappers(expression, work);
      const statement = outerAssignment.parent;
      if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isExpressionStatement(statement)
        || statement.expression !== outerAssignment) return false;
      const access = normalizePrimitiveExpression(expression.left, work).inner;
      if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return false;
      const literal = sterileLiteralOrigin(this.context, access.expression, work, this.facts.symbol);
      if (literal === undefined) return false;
      depend(literal); return true;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const literal = sterileLiteralOrigin(this.context, expression.expression, work, this.facts.symbol);
      if (literal === undefined) return false;
      const witness = inspectSterileLiteral(this.context, literal, work, this.facts.symbol);
      if (witness === undefined || !witness.sites.has(expression)) return false;
      for (const binding of witness.bindings) {
        work();
        if (this.callableOwner(binding, work) === undefined) captures.add(binding);
      }
      if (witness.bindings.size === 0) depend(literal);
      else for (const value of witness.initialValues) { work(); depend(value); }
      return true;
    }
    if (ts.isObjectLiteralExpression(expression) || ts.isArrayLiteralExpression(expression)) {
      const literalParent = climbPrimitiveWrappers(expression, work).parent;
      if (!ts.isVariableDeclaration(literalParent) && !ts.isPropertyAccessExpression(literalParent)
        && !ts.isElementAccessExpression(literalParent)) return false;
      const witness = inspectSterileLiteral(this.context, expression, work, this.facts.symbol);
      if (witness === undefined) return false;
      literals.set(expression, witness);
      for (const site of witness.sites) { work(); sites.add(site); }
      for (const value of witness.values) { work(); depend(value); }
      return true;
    }
    if (primitiveLiteral(expression)) return true;
    if (ts.isIdentifier(expression)) {
      if (expression.text === 'arguments') return false;
      const origin = sterileLiteralOrigin(this.context, expression, work, this.facts.symbol);
      if (origin !== undefined) {
        const alias = climbPrimitiveWrappers(expression, work).parent;
        if (!ts.isVariableDeclaration(alias) || alias.initializer !== climbPrimitiveWrappers(expression, work)) return false;
        const witness = inspectSterileLiteral(this.context, origin, work, this.facts.symbol);
        if (witness === undefined || !witness.bindings.has(alias)) return false;
        depend(origin); return true;
      }
      const symbol = this.symbol(expression, work);
      if (symbol === undefined) return false;
      if (expression.text === 'undefined') {
        work();
        const intrinsic = this.context.checker.resolveName('undefined', undefined, ts.SymbolFlags.Value, false);
        if (intrinsic !== undefined) this.facts.symbol(intrinsic);
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
        parameters.add(binding);
        return (ts.isFunctionDeclaration(owner) && owner.parent === owner.getSourceFile() || ts.isMethodDeclaration(owner)) && owner.body !== undefined
          && ts.isIdentifier(binding.name) && binding.initializer === undefined && binding.questionToken === undefined
          && binding.dotDotDotToken === undefined && (binding.modifiers?.length ?? 0) === 0
          && this.immutable(binding.name, work) && this.callableOwner(expression, work) === owner;
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
      if (local !== undefined) this.facts.symbol(local);
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
    const symbol = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? this.context.checker.getShorthandAssignmentValueSymbol(node.parent) : this.context.checker.getSymbolAtLocation(node);
    if (symbol !== undefined) this.facts.symbol(symbol);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      work(); const aliased = this.context.checker.getAliasedSymbol(symbol);
      this.facts.symbol(aliased);
      return aliased;
    }
    return symbol;
  }

  /** 중첩 closure를 투명한 execution scope로 취급하지 않는다. */
  private callableOwner(node: ts.Node, work: ProofWork): ts.Node | undefined {
    return primitiveCallableOwner(node, work);
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
    return this.moduleOrder(source, target, work);
  }

  /** source가 target 초기화 뒤 평가되며 reachable runtime import graph가 비순환인지 검증한다. */
  private moduleOrder(source: ts.SourceFile, target: ts.SourceFile, work: ProofWork): boolean {
    return primitiveModuleOrder(this.context, source, target, work, this.facts);
  }
}

/** primitive provenance를 만들 때 coercion·property·container를 문법으로 구분한다. */
export function primitiveLiteral(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword;
}

/** primitive recipe children은 canonical 정렬되므로 summary 값만 합쳐 소비한다. */
export function primitiveChildren(children: readonly ProofOutcome<unknown>[], work: ProofWork): PrimitiveSummary {
  const sites = new Set<ts.Node>(), captures = new Set<ts.VariableDeclaration>(), parameters = new Set<ts.ParameterDeclaration>();
  const literals = new Map<ts.Node, SterileLiteralWitness>();
  for (const child of children) {
    work();
    if (child.kind !== 'proved') continue;
    const summary = child.value as PrimitiveSummary;
    for (const [identity, literal] of summary.literals ?? []) { work(); literals.set(identity, literal); }
    for (const site of summary.sites) { work(); sites.add(site); }
    for (const capture of summary.captures) { work(); captures.add(capture); }
    for (const parameter of summary.parameters) { work(); parameters.add(parameter); }
  }
  return { sites, captures, parameters, literals };
}
