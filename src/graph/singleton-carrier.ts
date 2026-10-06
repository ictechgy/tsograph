/** Stage3의 singleton census와 명명된 효과 증명이다. ValueFlow를 호출하지 않는다. */
import ts from 'typescript';
import type { ConstructorCarrierContext, ConstructorCarrierProof } from './constructor-carrier.ts';
import { hasPrimitiveHelperCandidates } from './effect-inventory.ts';
import { normalizePrimitiveExpression } from './primitive-helpers.ts';
import { climbWrappers, referenceSite, type MutationRecord } from './flow-index.ts';
import { skipWrappers } from './node-collector.ts';
import type { ProofWork } from './proof-dag.ts';

/** 열거된 실행 효과마다 정확한 승인 모델을 남긴다. */
export type SingletonEffectModel = 'class-evaluation' | 'singleton-construction' | 'parameter-property-storage'
  | 'descriptor-projection' | 'delayed-date' | 'carrier-call' | 'sterile-endpoint' | 'primitive-field'
  | 'ordered-binding' | 'canonical-private-slot' | 'primitive-helper' | 'primitive-helper-pending';
/** descriptor·순서 증명이 효과와 mutation 소비자에게 전달하는 같은 근거다. */
export interface SingletonWitness {
  readonly proof: ConstructorCarrierProof;
  /** 자기 census·descriptor·endpoint 감사가 완료된 실제 dependency singleton family다. */
  readonly dependencies: ReadonlySet<ts.ClassLikeDeclaration>;
  readonly models: ReadonlyMap<ts.Node, SingletonEffectModel>;
  readonly writes: ReadonlyMap<ts.Node, { readonly target: ts.Expression; readonly key: string; readonly value: ts.Expression }>;
}
/** 정책 조회도 호출자의 ordered work trace에 포함한다. */
export interface SingletonPolicy {
  readonly project: (source: ts.SourceFile) => boolean;
  readonly open: (node: ts.ClassLikeDeclaration | ts.FunctionLikeDeclaration) => boolean;
  readonly intrinsic: (source: ts.SourceFile) => boolean;
}

/** plain zero-entry singleton과 같은 모듈의 선행 sterile dependency만 인증한다. */
export function auditSingletonCarrier(context: ConstructorCarrierContext, proof: ConstructorCarrierProof,
  work: ProofWork, policy: SingletonPolicy): SingletonWitness | undefined {
  const { checker, index } = context;
  const source = proof.declaration.getSourceFile();
  const models = new Map<ts.Node, SingletonEffectModel>();
  const writes = new Map<ts.Node, { target: ts.Expression; key: string; value: ts.Expression }>();
  const helperHint = hasPrimitiveHelperCandidates(index.effectInventory);
  /** grammar로 감사한 subtree의 개별 실행 site만 모델에 묶는다. */
  const mark = (root: ts.Node, model: SingletonEffectModel): void => {
    const stack: { node: ts.Node; depth: number }[] = [{ node: root, depth: 0 }];
    while (stack.length > 0) {
      const { node, depth } = stack.pop()!;
      work(depth, depth); models.set(node, model);
      ts.forEachChild(node, (child) => { stack.push({ node: child, depth: depth + 1 }); });
    }
  };
  /** alias를 canonical class 값에 연결하고 runtime merging과 binding 쓰기를 닫는다. */
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    work();
    const symbol = checker.getSymbolAtLocation(node);
    return symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
  };
  /** 완전한 참조 색인으로 모든 runtime class use가 직접 new 한 곳뿐인지 확인한다. */
  const singleton = (owner: ts.ClassLikeDeclaration): ts.NewExpression | undefined => {
    work();
    if (!ts.isClassDeclaration(owner) || owner.name === undefined || owner.parent !== owner.getSourceFile()
      || decorated(owner, work) || hasHeritage(owner, ts.SyntaxKind.ExtendsKeyword, work)
      || policy.open(owner) || !policy.project(owner.getSourceFile()) || index.newThisClasses.has(owner)
      || (index.subclasses.get(owner)?.length ?? 0) !== 0) return undefined;
    const symbol = symbolOf(owner.name);
    if (symbol === undefined || (index.identifierWrites.get(symbol)?.length ?? 0) !== 0) return undefined;
    for (const declaration of symbol.declarations ?? []) {
      work();
      if (declaration !== owner && !ts.isInterfaceDeclaration(declaration)) return undefined;
    }
    let construction: ts.NewExpression | undefined;
    for (const reference of index.references.get(symbol) ?? []) {
      work();
      const site = climbWrappers(referenceSite(reference));
      const parent = site.parent;
      if (!ts.isNewExpression(parent) || parent.expression !== site || construction !== undefined) return undefined;
      construction = parent;
    }
    const binding = construction === undefined ? undefined : directBinding(construction);
    if (binding === undefined || binding.getSourceFile() !== owner.getSourceFile()
      || owner.end > binding.pos) return undefined;
    const bindingSymbol = symbolOf(binding.name);
    if (bindingSymbol === undefined || (index.identifierWrites.get(bindingSymbol)?.length ?? 0) !== 0) return undefined;
    mark(owner, 'class-evaluation');
    mark(binding, 'ordered-binding');
    mark(construction!, 'singleton-construction');
    return construction;
  };
  const construction = singleton(proof.declaration);
  if (construction === undefined || construction.arguments?.length !== 1
    || skipWrappers(construction.arguments[0]!) !== proof.innerLiteral) return undefined;
  const controllerBinding = directBinding(construction)!;
  const controllerSymbol = symbolOf(controllerBinding.name);
  if (controllerSymbol === undefined) return undefined;
  // 먼저 generic class/storage/method 모델을 채우고, 아래의 exact audited site가 덮어쓴다.
  mark(proof.constructor, 'parameter-property-storage');
  for (const member of proof.declaration.members) {
    work();
    if (ts.isPropertyDeclaration(member)) mark(member, 'descriptor-projection');
    if (ts.isMethodDeclaration(member)) {
      mark(member, 'carrier-call');
      if (helperHint && member.body !== undefined) markPendingHelperSites(member.body, work, mark);
    }
  }
  markDelayedDateSites(proof.constructor, checker, policy, work, mark);
  /** 기존 Stage0의 닫힌 callback wrapper를 정확한 호출·순서 모델로만 보존한다. */
  const wrapperUse = (site: ts.Node): boolean => {
    const call = site.parent;
    if (!ts.isCallExpression(call) || call.arguments[0] !== site || call.arguments.length !== 2
      || !ts.isIdentifier(call.expression) || call.questionDotToken !== undefined
      || !orderedCall(call, controllerBinding, work)) return false;
    const target = symbolOf(call.expression);
    const wrapper = target?.valueDeclaration;
    const callback = call.arguments[1]!;
    if (wrapper === undefined || !ts.isFunctionDeclaration(wrapper) || wrapper.parent !== source
      || wrapper.body === undefined || wrapper.parameters.length !== 2 || wrapper.asteriskToken !== undefined
      || decorated(wrapper, work) || policy.open(wrapper) || (index.identifierWrites.get(target!)?.length ?? 0) !== 0
      || target?.declarations?.length !== 1 || !ts.isArrowFunction(callback) || callback.parameters.length !== 1
      || decorated(callback, work) || callback.parameters[0]!.initializer !== undefined
      || callback.parameters[0]!.dotDotDotToken !== undefined || !ts.isIdentifier(callback.parameters[0]!.name)
      || !ts.isCallExpression(callback.body) || callback.body.arguments.length !== 0
      || !ts.isPropertyAccessExpression(callback.body.expression)
      || !ts.isIdentifier(callback.body.expression.expression)
      || symbolOf(callback.body.expression.expression) !== symbolOf(callback.parameters[0]!.name)) return false;
    const endpointName = callback.body.expression.name.text;
    if (!proof.declaration.members.some((node) => {
      work(); return ts.isMethodDeclaration(node) && slot(node.name) === endpointName;
    })) return false;
    const [carrier, fn] = wrapper.parameters;
    if (!carrier || !fn || !ts.isIdentifier(carrier.name) || !ts.isIdentifier(fn.name)
      || carrier.initializer !== undefined || fn.initializer !== undefined
      || carrier.dotDotDotToken !== undefined || fn.dotDotDotToken !== undefined
      || carrier.questionToken !== undefined || fn.questionToken !== undefined || decorated(carrier, work) || decorated(fn, work)
      || hasModifier(wrapper, ts.SyntaxKind.AsyncKeyword, work)
      || hasModifier(callback, ts.SyntaxKind.AsyncKeyword, work)) return false;
    const statement = wrapper.body.statements.length === 1 ? wrapper.body.statements[0] : undefined;
    const invocation = statement && (ts.isReturnStatement(statement) || ts.isExpressionStatement(statement)) ? statement.expression : undefined;
    if (!invocation || !ts.isCallExpression(invocation) || !ts.isIdentifier(invocation.expression)
      || symbolOf(invocation.expression) !== symbolOf(fn.name) || invocation.arguments.length !== 1
      || !ts.isIdentifier(invocation.arguments[0]!) || symbolOf(invocation.arguments[0]!) !== symbolOf(carrier.name)) return false;
    for (const reference of index.references.get(target!) ?? []) {
      work();
      const ref = referenceSite(reference);
      if (ref !== call.expression) return false;
    }
    mark(wrapper, 'carrier-call'); mark(call, 'carrier-call');
    if (ts.isArrowFunction(call.parent)) mark(call.parent.parent, 'carrier-call');
    return true;
  };
  /** instance alias·borrow·escape를 막고 binding 완료 후 직접 호출만 허용한다. */
  for (const reference of index.references.get(controllerSymbol) ?? []) {
    work();
    const site = climbWrappers(referenceSite(reference));
    if (wrapperUse(site)) continue;
    const access = site.parent;
    const call = ts.isPropertyAccessExpression(access) && access.expression === site ? access.parent : undefined;
    if (!ts.isPropertyAccessExpression(access) || call === undefined || !ts.isCallExpression(call) || call.expression !== access
      || call.arguments.length !== 0 || call.questionDotToken !== undefined || access.questionDotToken !== undefined
      || !proof.declaration.members.some((member) => { work(); return ts.isMethodDeclaration(member) && slot(member.name) === access.name.text; })
      || !orderedCall(call, controllerBinding, work)) return undefined;
    mark(call, 'carrier-call');
    const arrow = ts.isArrowFunction(call.parent) ? call.parent : undefined;
    if (arrow !== undefined) mark(arrow.parent, 'carrier-call');
  }
  const dependencies = new Map<string, ts.ClassLikeDeclaration>();
  const serviceProperties = new Set<string>();
  for (const use of proof.serviceUses) {
    work();
    serviceProperties.add(use.propertyName);
  }
  const dependencyMethods = new Map<ts.ClassLikeDeclaration, ReadonlyMap<string, ts.MethodDeclaration>>();
  for (const property of proof.innerLiteral.properties) {
    work();
    const key = slot(property.name);
    if (key === undefined) return undefined;
    if (!serviceProperties.has(key)) continue;
    const value = ts.isPropertyAssignment(property) ? skipWrappers(property.initializer)
      : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
    if (value === undefined || !ts.isIdentifier(value)) return undefined;
    const symbol = ts.isShorthandPropertyAssignment(property) ? checker.getShorthandAssignmentValueSymbol(property) : symbolOf(value);
    const binding = symbol?.valueDeclaration;
    if (binding === undefined || !ts.isVariableDeclaration(binding) || binding.initializer === undefined
      || !ts.isNewExpression(skipWrappers(binding.initializer)) || binding.getSourceFile() !== source
      || binding.end >= controllerBinding.pos || (index.identifierWrites.get(symbol!)?.length ?? 0) !== 0) return undefined;
    const allocation = skipWrappers(binding.initializer) as ts.NewExpression;
    if ((allocation.arguments?.length ?? 0) !== 0 || !ts.isIdentifier(skipWrappers(allocation.expression))) return undefined;
    const classSymbol = symbolOf(skipWrappers(allocation.expression));
    const owner = classSymbol?.valueDeclaration;
    if (owner === undefined || !ts.isClassDeclaration(owner) || owner.getSourceFile() !== source
      || singleton(owner) !== allocation || !sterileClass(owner, work, policy, mark)) return undefined;
    if (!dependencyMethods.has(owner)) {
      const methods = new Map<string, ts.MethodDeclaration>();
      for (const candidate of owner.members) {
        work();
        if (ts.isMethodDeclaration(candidate)) {
          const name = slot(candidate.name);
          if (name !== undefined) methods.set(name, candidate);
        }
      }
      dependencyMethods.set(owner, methods);
    }
    for (const reference of index.references.get(symbol!) ?? []) {
      work();
      if (referenceSite(reference) !== value) return undefined;
    }
    dependencies.set(key, owner);
  }
  for (const use of proof.serviceUses) {
    work();
    const owner = dependencies.get(use.propertyName);
    const member = owner === undefined ? undefined : dependencyMethods.get(owner)?.get(use.methodName);
    if (member === undefined) return undefined;
    mark(use.call, 'sterile-endpoint');
  }
  // 미사용 bag 값도 평가되므로 임의의 객체나 호출을 놓치지 않는다.
  for (const property of proof.innerLiteral.properties) {
    work();
    if (dependencies.has(slot(property.name)!)) continue;
    if (!ts.isPropertyAssignment(property)) return undefined;
    const value = skipWrappers(property.initializer);
    if (primitive(value)) continue;
    if (ts.isIdentifier(value) && value.text === 'undefined') {
      const target = symbolOf(value);
      for (const node of target?.declarations ?? []) {
        work();
        if (!policy.intrinsic(node.getSourceFile())) return undefined;
      }
      continue;
    }
    if (!ts.isArrowFunction(value) || value.parameters.length !== 0 || decorated(value, work)
      || hasModifier(value, ts.SyntaxKind.AsyncKeyword, work)
      || !ts.isNewExpression(value.body) || (value.body.arguments?.length ?? 0) !== 0
      || !ts.isIdentifier(value.body.expression) || value.body.expression.text !== 'Date') return undefined;
    const date = symbolOf(value.body.expression);
    if (date === undefined || (date.declarations?.length ?? 0) === 0
      || (index.identifierWrites.get(date)?.length ?? 0) !== 0) return undefined;
    for (const node of date.declarations ?? []) {
      work();
      if (!policy.intrinsic(node.getSourceFile())) return undefined;
    }
    mark(value, 'delayed-date');
  }
  for (const site of proof.allowedMutationSites) {
    work();
    if (!ts.isBinaryExpression(site) || !ts.isPropertyAccessExpression(site.left)
      || site.left.expression.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
    writes.set(site, { target: site.left.expression, key: site.left.name.text, value: site.right });
  }
  if (index.hasOpaqueImport || index.hasOpaqueMutation || context.policy.openProperties) return undefined;
  const inventory = index.effectInventory;
  if (inventory === undefined) return undefined;
  // 정적 모듈 연결도 순서를 증명하지 않는다. 관련 순환은 별도로 닫는다.
  const edgesBySource = new Map<ts.SourceFile, ts.SourceFile[]>();
  for (const [file, edges] of inventory.manifest.moduleEdges) {
    work();
    for (const edge of edges) {
      work();
      if (!ts.isImportDeclaration(edge.site) && !ts.isExportDeclaration(edge.site)) return undefined;
      for (const declaration of edge.target?.declarations ?? []) {
        work();
        const target = declaration.getSourceFile();
        const targets = edgesBySource.get(file) ?? [];
        targets.push(target); edgesBySource.set(file, targets);
      }
    }
  }
  const active = new Set<ts.SourceFile>();
  const done = new Set<ts.SourceFile>();
  const stack = [{ file: source, leaving: false }];
  while (stack.length > 0) {
    work();
    const item = stack.pop()!;
    if (item.leaving) { active.delete(item.file); done.add(item.file); continue; }
    if (active.has(item.file)) return undefined;
    if (done.has(item.file)) continue;
    active.add(item.file); stack.push({ file: item.file, leaving: true });
    for (const target of edgesBySource.get(item.file) ?? []) { work(); stack.push({ file: target, leaving: false }); }
  }
  // 기존 canonical private own-slot 모델만 보충한다. receiver/alias는 mutation guard로 검증한다.
  for (const record of index.mutations) {
    work();
    if (record.effect !== 'property' || writes.has(record.site)) continue;
    if (record.operation !== 'assignment' || record.confidence !== 'known' || record.value === undefined
      || !primitive(skipWrappers(record.value))) return undefined;
    const target = skipWrappers(record.target);
    const symbol = ts.isIdentifier(target) ? symbolOf(target) : undefined;
    const binding = symbol?.valueDeclaration;
    if (binding === undefined || !ts.isVariableDeclaration(binding) || binding.initializer === undefined
      || directBinding(binding.initializer) !== binding) return undefined;
    const literal = skipWrappers(binding.initializer);
    if (!canonicalLiteral(literal, work)) return undefined;
    mark(binding, 'canonical-private-slot'); mark(record.site, 'canonical-private-slot');
  }
  // 감사된 subtree 밖은 primitive와 직접 immutable primitive binding만 모델링한다.
  for (const file of index.files) {
    work();
    for (const statement of file.statements) {
      work();
      if (ts.isClassDeclaration(statement) && !models.has(statement) && statement.name !== undefined
        && (index.references.get(symbolOf(statement.name)!)?.length ?? 0) === 0
        && !decorated(statement, work) && statement.heritageClauses === undefined
        && sterileClass(statement, work, policy, mark)) { mark(statement, 'class-evaluation'); continue; }
      if (!ts.isVariableStatement(statement)) continue;
      for (const binding of statement.declarationList.declarations) {
        work();
        if (models.has(binding) || binding.initializer === undefined || !primitive(skipWrappers(binding.initializer))) continue;
        if (directBinding(binding.initializer) !== binding) return undefined;
        mark(binding, 'ordered-binding');
      }
    }
  }
  return { proof, dependencies: new Set(dependencies.values()), models, writes };
}

/** 모든 실행 기록에 개별 site 모델이 있는지 확인한다. unknown은 빈 효과가 아니다. */
export function coversSingletonEffects(context: ConstructorCarrierContext, witness: SingletonWitness, work: ProofWork): boolean {
  for (const record of context.index.effectInventory!.records) {
    work();
    if (record.operation === 'primitive') continue;
    const model = witness.models.get(record.site);
    if (model === undefined || !compatibleEffectModel(record.operation, model, record.site)) return false;
    // 감사된 영역 안에서도 모델 없는 runtime syntax는 거부한다.
    if (record.operation === 'unknown' && !ts.isObjectLiteralExpression(record.site)
      && !ts.isArrayLiteralExpression(record.site) && record.site.kind !== ts.SyntaxKind.ThisKeyword
      && !(ts.isBinaryExpression(record.site) && record.site.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) return false;
  }
  return true;
}

/** 동일한 descriptor/effect 증명으로 mutation record의 receiver·key·value 정체성을 인증한다. */
export function certifiesSingletonWrite(witness: SingletonWitness, record: MutationRecord): boolean {
  const write = witness.writes.get(record.site);
  return write !== undefined && record.operation === 'assignment' && record.effect === 'property'
    && record.confidence === 'known' && record.target === write.target && record.staticKey === write.key
    && record.value === write.value;
}

/** 직접 top-level const initializer의 binding만 반환한다. */
function directBinding(expression: ts.Expression): ts.VariableDeclaration | undefined {
  const outer = climbWrappers(expression);
  const binding = outer.parent;
  return ts.isVariableDeclaration(binding) && binding.initializer === outer && ts.isIdentifier(binding.name)
    && ts.isVariableDeclarationList(binding.parent) && (binding.parent.flags & ts.NodeFlags.Const) !== 0
    && ts.isVariableStatement(binding.parent.parent) && binding.parent.parent.parent === binding.getSourceFile()
    ? binding : undefined;
}
/** 순서를 증명하지 못한 지연 alias/helper 호출은 이후 단계에 남긴다. */
function orderedCall(call: ts.CallExpression, binding: ts.VariableDeclaration, work: ProofWork): boolean {
  const outer = climbWrappers(call);
  let statement: ts.Node = outer;
  while (!ts.isSourceFile(statement.parent)) {
    work();
    if (ts.isArrowFunction(statement)) {
      const variable = directBinding(statement);
      return statement.parameters.length === 0 && statement.body === outer && !decorated(statement, work)
        && !hasModifier(statement, ts.SyntaxKind.AsyncKeyword, work)
        && variable !== undefined && variable.getSourceFile() === binding.getSourceFile() && binding.end < variable.pos;
    }
    if (ts.isFunctionLike(statement)) return false;
    statement = statement.parent;
  }
  return call.getSourceFile() === binding.getSourceFile() && binding.end < statement.pos
    && ts.isExpressionStatement(statement) && statement.expression === outer;
}
/** 의존 클래스의 미사용 method도 zero-entry primitive 문법으로 감사한다. */
function sterileClass(owner: ts.ClassDeclaration, work: ProofWork, policy: SingletonPolicy,
  mark: (node: ts.Node, model: SingletonEffectModel) => void): boolean {
  const slots = new Set<string>();
  let constructors = 0;
  for (const member of owner.members) {
    work();
    if (decorated(member, work) || staticMember(member, work)) return false;
    if (ts.isConstructorDeclaration(member)) {
      if (++constructors !== 1 || member.parameters.length !== 0 || member.body === undefined || member.body.statements.length !== 0) return false;
      mark(member, 'sterile-endpoint'); continue;
    }
    const name = slot(member.name);
    if (name === undefined || sensitive(name) || slots.has(name)) return false;
    slots.add(name);
    if (ts.isPropertyDeclaration(member)) {
      if (member.initializer === undefined || !primitiveCandidate(skipWrappers(member.initializer))
        || ts.isAutoAccessorPropertyDeclaration(member)) return false;
      mark(member, 'primitive-field');
      if (!primitive(skipWrappers(member.initializer))) mark(member.initializer, 'primitive-helper-pending');
      continue;
    }
    if (!ts.isMethodDeclaration(member) || member.body === undefined || member.parameters.length !== 0
      || member.asteriskToken !== undefined || hasModifier(member, ts.SyntaxKind.AsyncKeyword, work)
      || policy.open(member)) return false;
    // Stage3 literal/empty grammar의 비용과 named model을 그대로 보존한다.
    const only = member.body.statements.length === 1 ? member.body.statements[0] : undefined;
    if (member.body.statements.length === 0 || only !== undefined && ts.isReturnStatement(only)
      && (only.expression === undefined || primitive(skipWrappers(only.expression)))) {
      mark(member, 'sterile-endpoint'); continue;
    }
    // descriptor 단계는 entry만 닫는다. primitive body의 provenance/effect는 Stage4 DAG가 별도로 인증한다.
    for (const statement of member.body.statements) {
      work();
      if (ts.isReturnStatement(statement)) {
        if (statement.expression !== undefined && !primitiveCandidate(skipWrappers(statement.expression))) return false;
      } else if (ts.isExpressionStatement(statement)) {
        if (!ts.isCallExpression(skipWrappers(statement.expression))) return false;
      } else if (ts.isVariableStatement(statement)) {
        if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
        for (const binding of statement.declarationList.declarations) {
          work();
          if (!ts.isIdentifier(binding.name) || binding.initializer === undefined
            || !primitiveCandidate(skipWrappers(binding.initializer))) return false;
        }
      } else return false;
    }
    mark(member, 'primitive-helper-pending');
  }
  return true;
}
/** 기존 private literal write 모델에 전달하는 최소 literal 문법이다. */
function canonicalLiteral(expression: ts.Expression, work: ProofWork): boolean {
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.every((element) => { work(); return primitive(skipWrappers(element)); });
  if (!ts.isObjectLiteralExpression(expression)) return false;
  const keys = new Set<string>();
  return expression.properties.every((property) => {
    work(); const key = slot(property.name);
    if (!ts.isPropertyAssignment(property) || key === undefined || sensitive(key) || keys.has(key)
      || !primitive(skipWrappers(property.initializer))) return false;
    keys.add(key); return true;
  });
}
/** primitive literal만 inert 평가로 인정한다. */
function primitive(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)
    || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword;
}
/** computed/private 이름을 runtime own-data 근거로 바꾸지 않는다. */
function slot(name: ts.PropertyName | ts.BindingName | undefined): string | undefined {
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) ? name.text : undefined;
}
/** prototype lookup에 영향을 주는 slot은 인증하지 않는다. */
function sensitive(name: string): boolean { return ['__proto__', 'prototype', 'constructor', 'then'].includes(name); }
/** decorator는 runtime descriptor를 바꿀 수 있다. Stage3에서는 raw modifier만 읽는다. */
function decorated(node: ts.Node, work?: ProofWork): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  for (const modifier of node.modifiers ?? []) {
    work?.();
    if (modifier.kind === ts.SyntaxKind.Decorator) return true;
  }
  return false;
}
/** static 평가와 dependency instance의 primitive field를 구분한다. */
function staticMember(node: ts.Node, work?: ProofWork): boolean {
  return ts.isClassStaticBlockDeclaration(node) || ts.canHaveModifiers(node)
    && hasModifier(node, ts.SyntaxKind.StaticKeyword, work);
}

/** constructor에서 감사한 genuine zero-argument Date fallback만 정확한 subtree 모델로 덮는다. */
function markDelayedDateSites(
  root: ts.Node,
  checker: ts.TypeChecker,
  policy: SingletonPolicy,
  work: ProofWork,
  mark: (node: ts.Node, model: SingletonEffectModel) => void,
): void {
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    work();
    if (ts.isNewExpression(node) && (node.arguments?.length ?? 0) === 0
      && ts.isIdentifier(node.expression) && node.expression.text === 'Date') {
      const symbol = checker.getSymbolAtLocation(node.expression);
      const declarations = symbol?.declarations ?? [];
      let intrinsic = declarations.length > 0;
      for (const declaration of declarations) {
        work();
        intrinsic &&= policy.intrinsic(declaration.getSourceFile());
      }
      if (intrinsic && ts.isArrowFunction(node.parent) && node.parent.parameters.length === 0
        && node.parent.body === node) {
        mark(node.parent, 'delayed-date');
      }
    }
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
}

/** Heritage와 modifier 배열의 각 원소를 caller logical work로 관찰한다. */
function hasHeritage(node: ts.ClassLikeDeclaration, token: ts.SyntaxKind, work: ProofWork): boolean {
  for (const clause of node.heritageClauses ?? []) {
    work();
    if (clause.token === token) return true;
  }
  return false;
}

/** 신규 singleton grammar가 읽는 modifier 배열은 short-cut 없이 bounded하게 청구한다. */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind, work?: ProofWork): boolean {
  for (const modifier of ts.canHaveModifiers(node) ? node.modifiers ?? [] : []) {
    work?.();
    if (modifier.kind === kind) return true;
  }
  return false;
}

/** operation과 exact named witness의 최소 호환표다. 미등록 operation은 닫힌다. */
function compatibleEffectModel(operation: string, model: SingletonEffectModel, site: ts.Node): boolean {
  if (model === 'primitive-helper-pending') return false;
  switch (operation) {
    case 'class': return model === 'class-evaluation';
    case 'construct': return model === 'singleton-construction' || model === 'delayed-date';
    case 'call': return model === 'carrier-call' || model === 'sterile-endpoint' || model === 'primitive-helper';
    case 'write': return model === 'parameter-property-storage' || model === 'descriptor-projection'
      || model === 'primitive-field' || model === 'ordered-binding' || model === 'canonical-private-slot' || model === 'primitive-helper';
    case 'entry': return model === 'parameter-property-storage' || model === 'carrier-call'
      || model === 'sterile-endpoint' || model === 'delayed-date' || model === 'primitive-helper';
    case 'iteration':
    case 'spread': return false;
    case 'unknown':
      if (ts.isObjectLiteralExpression(site) || ts.isArrayLiteralExpression(site)) {
        return model === 'singleton-construction' || model === 'descriptor-projection'
          || model === 'parameter-property-storage' || model === 'ordered-binding'
          || model === 'canonical-private-slot';
      }
      if (site.kind === ts.SyntaxKind.ThisKeyword) {
        return model === 'parameter-property-storage' || model === 'carrier-call' || model === 'sterile-endpoint';
      }
      return ts.isBinaryExpression(site) && site.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        && (model === 'parameter-property-storage' || model === 'delayed-date' || model === 'carrier-call');
    case 'read': return true;
    default: return false;
  }
}

/** syntactic 후보는 capability가 아니다. 효과 소비 전에 primitive summary가 모두 필요하다. */
function primitiveCandidate(node: ts.Expression): boolean {
  return primitive(node) || ts.isIdentifier(node) || ts.isCallExpression(node);
}

/** helper 후보가 skip된 carrier subtree는 completed summary가 오기 전까지 pending으로 둔다. */
function markPendingHelperSites(
  root: ts.Node,
  work: ProofWork,
  mark: (node: ts.Node, model: SingletonEffectModel) => void,
): void {
  const stack: ts.Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    work();
    if (ts.isCallExpression(node)) {
      const callee = normalizePrimitiveExpression(node.expression, work).inner;
      if (ts.isIdentifier(callee)) {
        mark(node, 'primitive-helper-pending');
      }
    } else if (ts.isIdentifier(node) && ts.isReturnStatement(node.parent) && node.parent.expression === node) {
      mark(node, 'primitive-helper-pending');
    }
    ts.forEachChild(node, (child) => { stack.push(child); });
  }
}
