/** Stage6 literal의 runtime alias closure와 exact own-slot 의무를 ValueFlow 없이 수집한다. */
import ts from 'typescript';
import type { ConstructorCarrierContext } from './constructor-carrier.ts';
import type { MutationRecord } from './flow-index.ts';
import { climbPrimitiveWrappers, normalizePrimitiveExpression, primitiveErasedReference } from './primitive-helpers.ts';
import type { ProofWork } from './proof-dag.ts';

/** 값 provenance child가 모두 완료된 뒤에만 소비할 수 있는 confinement 의무다. */
export interface SterileLiteralWitness {
  readonly literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
  readonly bindings: ReadonlySet<ts.VariableDeclaration>;
  readonly references: ReadonlySet<ts.Node>;
  readonly sites: ReadonlySet<ts.Node>;
  readonly values: readonly ts.Expression[];
  /** read provenance는 allocation 값만 의존해 write/read 사이의 재귀 권한을 피한다. */
  readonly initialValues: readonly ts.Expression[];
  readonly writes: ReadonlyMap<ts.Node, { readonly target: ts.Expression; readonly key: string;
    readonly value: ts.Expression; readonly access: ts.Expression }>;
}

/** 공개 Map/Set을 보존하지 않는 literal write의 immutable identity snapshot이다. */
export interface SterileLiteralWriteSnapshot {
  readonly site: ts.Node;
  readonly target: ts.Expression;
  readonly key: string;
  readonly keyNode: ts.Node;
  readonly value: ts.Expression;
  readonly access: ts.Expression;
}

/** analyzer producer가 private registry에 저장할 literal closure의 immutable 복사본이다. */
export interface SterileLiteralSnapshot {
  readonly literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression;
  readonly kind: 'object' | 'array';
  readonly slots: readonly string[];
  readonly bindings: readonly ts.VariableDeclaration[];
  readonly references: readonly ts.Node[];
  readonly sites: readonly ts.Node[];
  readonly values: readonly ts.Expression[];
  readonly initialValues: readonly ts.Expression[];
  readonly writes: readonly SterileLiteralWriteSnapshot[];
}

/** checker의 실제 binding만 조회하며 alias/type은 own-data 권한을 주지 않는다. */
function bindingOf(context: ConstructorCarrierContext, node: ts.Identifier, work: ProofWork,
  onSymbol?: (symbol: ts.Symbol) => void): ts.VariableDeclaration | undefined {
  work(); const symbol = context.checker.getSymbolAtLocation(node);
  if (symbol === undefined || (symbol.flags & ts.SymbolFlags.Alias) !== 0) return undefined;
  onSymbol?.(symbol);
  work();
  if (context.index.exportedSymbols.has(symbol) || (context.index.identifierWrites.get(symbol)?.length ?? 0) !== 0) return undefined;
  const binding = symbol.valueDeclaration;
  if (binding === undefined || !ts.isVariableDeclaration(binding) || !ts.isIdentifier(binding.name)
    || binding.initializer === undefined || !ts.isVariableDeclarationList(binding.parent)
    || (binding.parent.flags & ts.NodeFlags.Const) === 0 || (binding.parent.flags & ts.NodeFlags.Using) !== 0) return undefined;
  for (const declaration of symbol.declarations ?? []) { work(); if (declaration !== binding) return undefined; }
  return binding;
}

/** 가장 가까운 callable identity로 local alias가 closure 경계를 넘지 않게 한다. */
function ownerOf(node: ts.Node, work: ProofWork): ts.Node {
  let current = node;
  for (let depth = 0; ; depth++) {
    work(depth, depth);
    if (ts.isFunctionLike(current) || ts.isSourceFile(current)) return current;
    current = current.parent;
  }
}

/** static own key만 인정한다. 계산·coercion·prototype 특수 creation은 별도 증명 없이 거부한다. */
function keyOf(node: ts.Node, work: ProofWork): string | undefined {
  work();
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  return undefined;
}

/** immutable alias chain을 원 literal로 역추적한다. 각 edge에 depth/frame을 청구한다. */
export function sterileLiteralOrigin(context: ConstructorCarrierContext, expression: ts.Expression,
  work: ProofWork, onSymbol?: (symbol: ts.Symbol) => void): ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | undefined {
  let current = expression;
  const seen = new Set<ts.VariableDeclaration>();
  for (let depth = 0; ; depth++) {
    work(depth, depth);
    const inner = normalizePrimitiveExpression(current, work).inner;
    if (ts.isObjectLiteralExpression(inner) || ts.isArrayLiteralExpression(inner)) return inner;
    if (!ts.isIdentifier(inner)) return undefined;
    const binding = bindingOf(context, inner, work, onSymbol);
    if (binding === undefined || seen.has(binding)) return undefined;
    seen.add(binding); current = binding.initializer!;
  }
}

/** 모든 alias/reference와 canonical slot을 감사한다. values는 별도 primitive DAG child로 인증한다. */
export function inspectSterileLiteral(context: ConstructorCarrierContext,
  literal: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression, work: ProofWork,
  onSymbol?: (symbol: ts.Symbol) => void): SterileLiteralWitness | undefined {
  const sites = new Set<ts.Node>(), references = new Set<ts.Node>(), bindings = new Set<ts.VariableDeclaration>();
  const values: ts.Expression[] = [];
  const writes = new Map<ts.Node, { target: ts.Expression; key: string; value: ts.Expression; access: ts.Expression }>();
  const slots = new Set<string>();
  work(); sites.add(literal);
  if (ts.isArrayLiteralExpression(literal)) {
    for (let index = 0; index < literal.elements.length; index++) {
      work(); const element = literal.elements[index]!;
      if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return undefined;
      slots.add(String(index)); values.push(element);
    }
  } else {
    for (const property of literal.properties) {
      work();
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
      const key = keyOf(property.name, work);
      if (key === undefined || key === '__proto__' || slots.has(key)
        || ts.isShorthandPropertyAssignment(property) && property.objectAssignmentInitializer !== undefined) return undefined;
      slots.add(key); sites.add(property);
      values.push(ts.isPropertyAssignment(property) ? property.initializer : property.name);
    }
  }
  const initialValues: ts.Expression[] = [];
  for (const value of values) { work(); initialValues.push(value); }
  const outer = climbPrimitiveWrappers(literal, work);
  const initial = outer.parent;
  const queue: { binding?: ts.VariableDeclaration; node: ts.Node; depth: number }[] = [];
  if (ts.isVariableDeclaration(initial) && initial.initializer === outer && ts.isIdentifier(initial.name)) {
    if (bindingOf(context, initial.name, work, onSymbol) !== initial) return undefined;
    bindings.add(initial); queue.push({ binding: initial, node: initial.name, depth: 0 });
  } else queue.push({ node: literal, depth: 0 });
  const originOwner = ownerOf(literal, work);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const item = queue[cursor]!;
    work(item.depth, item.depth);
    const binding = item.binding;
    let tokens: readonly ts.Node[];
    if (binding === undefined) tokens = [item.node];
    else {
      sites.add(binding); sites.add(binding.name);
      work(); const symbol = context.checker.getSymbolAtLocation(binding.name)!;
      onSymbol?.(symbol);
      work(); tokens = context.index.references.get(symbol) ?? [];
    }
    for (const token of tokens) {
      work(item.depth, item.depth);
      if (primitiveErasedReference(token, work)) continue;
      const site = climbPrimitiveWrappers(token, work), parent = site.parent;
      references.add(token);
      if (binding !== undefined && originOwner !== literal.getSourceFile() && ownerOf(token, work) !== originOwner) return undefined;
      if (ts.isVariableDeclaration(parent) && parent.initializer === site && ts.isIdentifier(parent.name)) {
        const alias = bindingOf(context, parent.name, work, onSymbol);
        if (alias !== parent || binding === undefined || alias.pos < binding.end
          || alias.getSourceFile() !== binding.getSourceFile() || ownerOf(alias, work) !== ownerOf(binding, work)) return undefined;
        if (bindings.has(alias)) return undefined;
        bindings.add(alias); queue.push({ binding: alias, node: alias.name, depth: item.depth + 1 });
        continue;
      }
      const access = (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === site ? parent : undefined;
      if (access === undefined || access.questionDotToken !== undefined) return undefined;
      const key = ts.isPropertyAccessExpression(access) ? keyOf(access.name, work)
        : keyOf(normalizePrimitiveExpression(access.argumentExpression, work).inner, work);
      // computed identifiers are runtime reads, not static key spelling.
      if (ts.isElementAccessExpression(access) && ts.isIdentifier(normalizePrimitiveExpression(access.argumentExpression, work).inner)) return undefined;
      if (key === undefined || key === '__proto__' || !slots.has(key)) return undefined;
      if (binding !== undefined && ownerOf(token, work) === ownerOf(binding, work) && token.pos < binding.end) return undefined;
      sites.add(token); sites.add(access);
      for (const wrapper of normalizePrimitiveExpression(access.expression, work).wrappers) { work(); sites.add(wrapper); }
      const use = climbPrimitiveWrappers(access, work), operation = use.parent;
      if (ts.isBinaryExpression(operation) && operation.left === use) {
        const outerAssignment = climbPrimitiveWrappers(operation, work);
        const statement = outerAssignment.parent;
        if (operation.operatorToken.kind !== ts.SyntaxKind.EqualsToken || !ts.isExpressionStatement(statement)
          || statement.expression !== outerAssignment) return undefined;
        values.push(operation.right); sites.add(operation);
        writes.set(operation, { target: access.expression, key, value: operation.right, access });
      } else if (ts.isDeleteExpression(operation) || ts.isPrefixUnaryExpression(operation) || ts.isPostfixUnaryExpression(operation)
        || ts.isCallExpression(operation) && operation.expression === use || ts.isNewExpression(operation) && operation.expression === use) return undefined;
    }
  }
  return { literal, bindings, references, sites, values, initialValues, writes };
}

/** completed helper가 확인한 literal graph를 caller work로 읽어 immutable array records로 고정한다. */
export function snapshotSterileLiteral(witness: SterileLiteralWitness,
  work: ProofWork): SterileLiteralSnapshot | undefined {
  work();
  const literal = witness.literal;
  const slots: string[] = [];
  const slotSet = new Set<string>();
  if (ts.isArrayLiteralExpression(literal)) {
    for (let index = 0; index < literal.elements.length; index++) {
      work();
      const element = literal.elements[index]!;
      if (ts.isOmittedExpression(element) || ts.isSpreadElement(element)) return undefined;
      const key = String(index);
      slots.push(key); slotSet.add(key);
    }
  } else {
    for (const property of literal.properties) {
      work();
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
      const key = keyOf(property.name, work);
      if (key === undefined || key === '__proto__' || slotSet.has(key)) return undefined;
      slots.push(key); slotSet.add(key);
    }
  }
  const bindings: ts.VariableDeclaration[] = [];
  for (const binding of witness.bindings) { work(); bindings.push(binding); }
  const references: ts.Node[] = [];
  for (const reference of witness.references) { work(); references.push(reference); }
  const sites: ts.Node[] = [];
  for (const site of witness.sites) { work(); sites.push(site); }
  const values: ts.Expression[] = [];
  for (const value of witness.values) { work(); values.push(value); }
  const initialValues: ts.Expression[] = [];
  for (const value of witness.initialValues) { work(); initialValues.push(value); }
  const writes: SterileLiteralWriteSnapshot[] = [];
  for (const [site, write] of witness.writes) {
    work();
    if (!slotSet.has(write.key)) return undefined;
    const keyNode = ts.isElementAccessExpression(write.access) ? write.access.argumentExpression
      : ts.isPropertyAccessExpression(write.access) ? write.access.name : undefined;
    if (keyNode === undefined) return undefined;
    writes.push(Object.freeze({ site, target: write.target, key: write.key, keyNode,
      value: write.value, access: write.access }));
  }
  return Object.freeze({ literal, kind: ts.isArrayLiteralExpression(literal) ? 'array' : 'object',
    slots: Object.freeze(slots), bindings: Object.freeze(bindings), references: Object.freeze(references),
    sites: Object.freeze(sites), values: Object.freeze(values), initialValues: Object.freeze(initialValues),
    writes: Object.freeze(writes) });
}

/** mutation snapshot의 모든 identity와 연산을 같은 완료 witness에 대조한다. */
export function matchesSterileWrite(witness: SterileLiteralWitness, record: MutationRecord): boolean {
  const write = witness.writes.get(record.site);
  return write !== undefined && record.effect === 'property' && record.operation === 'assignment'
    && record.confidence === 'known' && record.target === write.target && record.staticKey === write.key
    && record.key === (ts.isElementAccessExpression(write.access) ? write.access.argumentExpression
      : ts.isPropertyAccessExpression(write.access) ? write.access.name : undefined)
    && record.value === write.value && record.args.length === 0 && record.source === undefined && record.sources.length === 0
    && record.descriptor === undefined && record.prototype === undefined;
}
