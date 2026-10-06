/** Stage4 summary를 소비할 실제 entry와 initializer를 charged AST로 수집한다. */
import ts from 'typescript';
import type { ConstructorCarrierContext } from './constructor-carrier.ts';
import { climbPrimitiveWrappers, normalizePrimitiveExpression, primitiveCallRuntimeEntries, primitiveCarrierMethodCall,
  primitiveErasedReference, primitiveLiteral, primitiveReferenceSite, type PrimitiveRuntimeEntry } from './primitive-helpers.ts';
import { primitiveDependencyTarget } from './primitive-dependency.ts';
import type { ProofWork } from './proof-dag.ts';

/** body capture는 선언 위치 대신 실제 호출 entry에서 초기화를 검증한다. */
export interface PrimitiveEntry {
  readonly node: ts.Expression | ts.FunctionDeclaration | ts.MethodDeclaration;
  readonly entry?: PrimitiveRuntimeEntry;
  /** exact bag allocation에서 찾은 구조 후보이며 descriptor 완료 전에는 권한이 아니다. */
  readonly dependency?: ts.MethodDeclaration;
}
/** 새 summary가 담당할 initializer·callee만 모은다. 이것은 인증 결과가 아니다. */
export interface PrimitivePlan {
  readonly roots: readonly PrimitiveEntry[];
  /** unused method를 포함해 required runtime entry마다 완전한 call provenance를 요구한다. */
  readonly entries: readonly { readonly method: ts.MethodDeclaration; readonly entry?: PrimitiveRuntimeEntry; readonly initialize: boolean }[];
  /** 관찰한 runtime method use마다 지원되는 실제 entry를 만들었다. */
  readonly complete: boolean;
}
/** checker lookup과 alias lookup을 각각 logical work로 청구한다. */
function symbolOf(context: ConstructorCarrierContext, node: ts.Node, work: ProofWork): ts.Symbol | undefined {
  work(); const symbol = context.checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    work(); return context.checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/** singleton census는 descriptor가 별도로 닫는다. 여기서는 실제 const binding만 구한다. */
function controllerBinding(context: ConstructorCarrierContext, declaration: ts.ClassLikeDeclaration,
  work: ProofWork): ts.VariableDeclaration | undefined {
  const symbol = declaration.name === undefined ? undefined : symbolOf(context, declaration.name, work);
  let binding: ts.VariableDeclaration | undefined;
  work();
  const references = symbol === undefined ? [] : context.index.references.get(symbol) ?? [];
  for (const reference of references) {
    work(); const site = primitiveReferenceSite(reference, work);
    const allocation = ts.isNewExpression(site.parent) ? site.parent : undefined;
    if (allocation !== undefined) {
      const outer = climbPrimitiveWrappers(allocation, work);
      const parent = outer.parent;
      if (ts.isVariableDeclaration(parent) && parent.initializer === outer
        && ts.isIdentifier(parent.name) && ts.isVariableDeclarationList(parent.parent)
        && (parent.parent.flags & ts.NodeFlags.Const) !== 0) binding = parent;
    }
  }
  return binding;
}

/** 기존 Stage3 wrapper는 같은 descriptor child가 exact 문법·entry·effects를 검증한다. */
function carrierWrapper(context: ConstructorCarrierContext, node: ts.FunctionDeclaration,
  binding: ts.VariableDeclaration | undefined, work: ProofWork): boolean {
  work();
  const target = node.name === undefined ? undefined : symbolOf(context, node.name, work);
  const uses = target === undefined ? [] : context.index.references.get(target) ?? [];
  if (uses.length === 0 || binding === undefined) return false;
  const controller = symbolOf(context, binding.name, work);
  for (const reference of uses) {
    work(); const site = primitiveReferenceSite(reference, work); const call = site.parent;
    if (!ts.isCallExpression(call) || call.expression !== site || call.arguments.length !== 2
      || !ts.isIdentifier(call.arguments[0]!) || symbolOf(context, call.arguments[0]!, work) !== controller) return false;
  }
  return true;
}

/** method마다 실제 runtime call entry를 수집해 class-wide earliest capture를 피한다. */
function methodEntrySites(context: ConstructorCarrierContext, method: ts.MethodDeclaration,
  work: ProofWork): { readonly entries: readonly PrimitiveRuntimeEntry[]; readonly complete: boolean } {
  const result: PrimitiveRuntimeEntry[] = [];
  const name = method.name;
  const text = ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name) ? name.text : undefined;
  if (text === undefined) return { entries: result, complete: false };
  const symbol = symbolOf(context, name, work);
  work();
  const occurrences = context.index.tokenOccurrences.get(text) ?? [];
  for (const reference of occurrences) {
    work();
    if (reference === name || primitiveErasedReference(reference, work)) continue;
    const site = primitiveReferenceSite(reference, work);
    const call = site.parent;
    const resolved = symbolOf(context, reference, work);
    if (!ts.isCallExpression(call) || call.expression !== site || call.questionDotToken !== undefined) {
      if (resolved === symbol || resolved?.valueDeclaration === method) return { entries: result, complete: false };
      continue;
    }
    const concrete = primitiveCarrierMethodCall(context, method, call, work);
    if (resolved === symbol || resolved?.valueDeclaration === method || concrete) {
      const entries = primitiveCallRuntimeEntries(context, call, work);
      if (entries === undefined) return { entries: result, complete: false };
      for (const entry of entries) { work(); result.push(entry); }
    }
  }
  return { entries: result, complete: true };
}


/** 이미 Stage3로 인증한 literal/empty endpoint에는 새 summary를 붙이지 않는다. */
function literalEndpoint(method: ts.MethodDeclaration, work: ProofWork): boolean {
  if (method.parameters.length > 0) return false;
  const statements = method.body!.statements;
  const only = statements.length === 1 ? statements[0] : undefined;
  return statements.length === 0 || only !== undefined && ts.isReturnStatement(only)
    && (only.expression === undefined || primitiveLiteral(normalizePrimitiveExpression(only.expression, work).inner));
}

/** receiver-free 식의 정확한 candidate다. descriptor가 인정한 receiver call과 섞지 않는다. */
function primitiveCandidate(expression: ts.Expression, work: ProofWork): boolean {
  const value = normalizePrimitiveExpression(expression, work).inner;
  return primitiveLiteral(value) || ts.isIdentifier(value)
    || ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)
    || ts.isBinaryExpression(value) || ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)
    || ts.isCallExpression(value) && ts.isIdentifier(normalizePrimitiveExpression(value.expression, work).inner);
}

/** carrier 내부 helper 초기화·호출·반환은 actual method grammar와 같은 site를 소비한다. */
function carrierRoots(method: ts.MethodDeclaration, entries: readonly PrimitiveRuntimeEntry[], roots: PrimitiveEntry[], work: ProofWork): void {
  const add = (node: ts.Expression): void => {
    if (entries.length === 0) roots.push({ node });
    else for (const entry of entries) { work(); roots.push({ node, entry }); }
  };
  for (const statement of method.body!.statements) {
    work();
    if (ts.isVariableStatement(statement)) {
      for (const binding of statement.declarationList.declarations) {
        work(); if (binding.initializer !== undefined) add(binding.initializer);
      }
    } else if (ts.isReturnStatement(statement) && statement.expression !== undefined && primitiveCandidate(statement.expression, work)) {
      add(statement.expression);
    } else if (ts.isExpressionStatement(statement)
      && primitiveCandidate(statement.expression, work)) {
      add(statement.expression);
    }
  }
}

/** 필드 initializer의 TDZ는 method entry가 아니라 실제 construction entry에서 검사한다. */
function fieldEntry(context: ConstructorCarrierContext, owner: ts.ClassDeclaration, work: ProofWork): ts.Node {
  let allocation: ts.Node = owner;
  const symbol = owner.name === undefined ? undefined : symbolOf(context, owner.name, work);
  for (const reference of symbol === undefined ? [] : context.index.references.get(symbol) ?? []) {
    work(); const site = primitiveReferenceSite(reference, work);
    if (ts.isNewExpression(site.parent)) allocation = site.parent;
  }
  return allocation;
}

/** Stage3의 literal-only scratch write는 기존 own-slot guard가 독립적으로 검사한다. */
function existingScratchOnly(context: ConstructorCarrierContext, binding: ts.VariableDeclaration,
  literal: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression, work: ProofWork): boolean {
  if (ts.isArrayLiteralExpression(literal)) {
    for (const element of literal.elements) { work(); if (!primitiveLiteral(normalizePrimitiveExpression(element, work).inner)) return false; }
  } else {
    for (const property of literal.properties) {
      work(); if (!ts.isPropertyAssignment(property) || !primitiveLiteral(normalizePrimitiveExpression(property.initializer, work).inner)) return false;
    }
  }
  const symbol = symbolOf(context, binding.name, work);
  work(); const references = symbol === undefined ? [] : context.index.references.get(symbol) ?? [];
  if (references.length === 0) return false;
  for (const reference of references) {
    work(); const site = climbPrimitiveWrappers(reference, work), access = site.parent;
    if ((!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) || access.expression !== site) return false;
    const operation = climbPrimitiveWrappers(access, work).parent;
    if (!ts.isBinaryExpression(operation) || operation.left !== access || operation.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      || !primitiveLiteral(normalizePrimitiveExpression(operation.right, work).inner)) return false;
  }
  return true;
}

/** 실제 graph의 global evaluation·closed helper body·borrowed endpoint를 한 계획으로 연결한다. */
export function collectPrimitivePlan(context: ConstructorCarrierContext, declaration: ts.ClassLikeDeclaration,
  work: ProofWork): PrimitivePlan {
  const roots: PrimitiveEntry[] = [];
  const entries: { method: ts.MethodDeclaration; entry?: PrimitiveRuntimeEntry; initialize: boolean }[] = [];
  const binding = controllerBinding(context, declaration, work);
  let complete = true;
  for (const file of context.index.files) {
    work();
    for (const statement of file.statements) {
      work();
      if (ts.isFunctionDeclaration(statement) && statement.body !== undefined) {
        if (!carrierWrapper(context, statement, binding, work)) roots.push({ node: statement });
      } else if (ts.isClassDeclaration(statement)) {
        for (const member of statement.members) {
          work();
          if (ts.isMethodDeclaration(member) && member.body !== undefined) {
            const entryResult = statement === declaration ? methodEntrySites(context, member, work)
              : { entries: [] as readonly PrimitiveRuntimeEntry[], complete: true };
            const methodEntries = entryResult.entries;
            work(); complete &&= entryResult.complete;
            if (member.parameters.length > 0) {
              for (const entry of methodEntries) { work(); entries.push({ method: member, entry, initialize: true }); }
            }
            if (statement === declaration) {
              carrierRoots(member, methodEntries, roots, work);
              // receiver와 descriptor는 별도 증명이 담당한다. 인자는 모든 실제 호출마다 소비한다.
              const stack = [{ node: member.body as ts.Node, depth: 0 }];
              while (stack.length > 0) {
                const { node, depth } = stack.pop()!; work(depth, depth);
                if (ts.isCallExpression(node) && !ts.isIdentifier(normalizePrimitiveExpression(node.expression, work).inner)) {
                  const target = primitiveDependencyTarget(context, node, work);
                  if (target !== undefined && ts.isMethodDeclaration(target) && target.parent !== declaration) {
                    for (const entry of methodEntries) { work(); roots.push({ node, entry, dependency: target }); }
                  } else {
                    for (const argument of node.arguments) {
                      for (const entry of methodEntries) { work(); roots.push({ node: argument, entry }); }
                    }
                  }
                }
                ts.forEachChild(node, child => { stack.push({ node: child, depth: depth + 1 }); });
              }
            } else if (!literalEndpoint(member, work)) {
              const methodEntries = member.parameters.length > 0 ? methodEntrySites(context, member, work).entries : [];
              if (member.parameters.length > 0) {
                work(); entries.push({ method: member, initialize: false });
              } else if (methodEntries.length === 0) roots.push({ node: member });
              else for (const entry of methodEntries) { work(); roots.push({ node: member, entry }); }
            }
          } else if (ts.isPropertyDeclaration(member) && member.initializer !== undefined
            && !primitiveLiteral(normalizePrimitiveExpression(member.initializer, work).inner)) {
            roots.push({ node: member.initializer, entry: fieldEntry(context, statement, work) });
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        for (const binding of statement.declarationList.declarations) {
          work(); const value = binding.initializer === undefined ? undefined
            : normalizePrimitiveExpression(binding.initializer, work).inner;
          if (value !== undefined && (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))
            && existingScratchOnly(context, binding, value, work)) continue;
          if (value !== undefined && (ts.isIdentifier(value) || ts.isCallExpression(value)
            || ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value))) {
            roots.push({ node: binding.initializer!, entry: binding.initializer! });
          }
        }
      } else if (ts.isExpressionStatement(statement)) {
        const callValue = normalizePrimitiveExpression(statement.expression, work).inner;
        if (!ts.isCallExpression(callValue)) continue;
        const call = callValue;
        const callee = normalizePrimitiveExpression(call.expression, work).inner;
        if (!ts.isIdentifier(callee)) continue;
        const target = symbolOf(context, callee, work)?.valueDeclaration;
        if (target !== undefined && ts.isFunctionDeclaration(target) && !carrierWrapper(context, target, binding, work)) {
          roots.push({ node: statement.expression, entry: statement });
        }
      }
    }
  }
  return { roots, entries, complete };
}
