/** Stage4 summary를 소비할 실제 entry와 initializer를 charged AST로 수집한다. */
import ts from 'typescript';
import type { ConstructorCarrierContext } from './constructor-carrier.ts';
import { climbPrimitiveWrappers, normalizePrimitiveExpression, primitiveLiteral, primitiveReferenceSite } from './primitive-helpers.ts';
import type { ProofWork } from './proof-dag.ts';

/** body capture는 선언 위치 대신 실제 호출 entry에서 초기화를 검증한다. */
export interface PrimitiveEntry {
  readonly node: ts.Expression | ts.FunctionDeclaration | ts.MethodDeclaration;
  readonly entry?: ts.Node;
}
/** 새 summary가 담당할 initializer·callee만 모은다. 이것은 인증 결과가 아니다. */
export interface PrimitivePlan {
  readonly roots: readonly PrimitiveEntry[];
}
/** checker lookup과 alias lookup을 각각 logical work로 청구한다. */
function symbolOf(context: ConstructorCarrierContext, node: ts.Node, work: ProofWork): ts.Symbol | undefined {
  work(); const symbol = context.checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    work(); return context.checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/** singleton census는 descriptor가 별도로 닫는다. 여기서는 실제 binding과 가장 이른 entry만 구한다. */
function controllerEntry(context: ConstructorCarrierContext, declaration: ts.ClassLikeDeclaration, work: ProofWork) {
  const symbol = declaration.name === undefined ? undefined : symbolOf(context, declaration.name, work);
  let binding: ts.VariableDeclaration | undefined;
  for (const reference of symbol === undefined ? [] : context.index.references.get(symbol) ?? []) {
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
  if (binding === undefined) return { binding, anchor: declaration as ts.Node };
  const controller = symbolOf(context, binding.name, work);
  let earliest: ts.Node | undefined;
  for (const reference of controller === undefined ? [] : context.index.references.get(controller) ?? []) {
    work(); let current: ts.Node = primitiveReferenceSite(reference, work);
    let delayed = false;
    while (!ts.isSourceFile(current.parent)) {
      work(); delayed ||= ts.isFunctionLike(current); current = current.parent;
    }
    // Stage3가 허용한 delayed carrier wrapper도 binding 완료보다 이른 capture에 의존하지 않는다.
    const candidate = delayed ? binding : current;
    if (earliest === undefined || candidate.pos < earliest.pos) earliest = candidate;
  }
  return { binding, anchor: earliest ?? binding };
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

/** 이미 Stage3로 인증한 literal/empty endpoint에는 새 summary를 붙이지 않는다. */
function literalEndpoint(method: ts.MethodDeclaration, work: ProofWork): boolean {
  const statements = method.body!.statements;
  const only = statements.length === 1 ? statements[0] : undefined;
  return statements.length === 0 || only !== undefined && ts.isReturnStatement(only)
    && (only.expression === undefined || primitiveLiteral(normalizePrimitiveExpression(only.expression, work).inner));
}

/** receiver-free 식의 정확한 candidate다. descriptor가 인정한 receiver call과 섞지 않는다. */
function primitiveCandidate(expression: ts.Expression, work: ProofWork): boolean {
  const value = normalizePrimitiveExpression(expression, work).inner;
  return primitiveLiteral(value) || ts.isIdentifier(value)
    || ts.isCallExpression(value) && ts.isIdentifier(normalizePrimitiveExpression(value.expression, work).inner);
}

/** carrier 내부 helper 초기화·호출·반환은 actual method grammar와 같은 site를 소비한다. */
function carrierRoots(method: ts.MethodDeclaration, anchor: ts.Node, roots: PrimitiveEntry[], work: ProofWork): void {
  for (const statement of method.body!.statements) {
    work();
    if (ts.isVariableStatement(statement)) {
      for (const binding of statement.declarationList.declarations) {
        work(); if (binding.initializer !== undefined) roots.push({ node: binding.initializer, entry: anchor });
      }
    } else if (ts.isReturnStatement(statement) && statement.expression !== undefined && primitiveCandidate(statement.expression, work)) {
      roots.push({ node: statement.expression, entry: anchor });
    } else if (ts.isExpressionStatement(statement)
      && ts.isCallExpression(normalizePrimitiveExpression(statement.expression, work).inner)
      && primitiveCandidate(statement.expression, work)) {
      roots.push({ node: statement.expression, entry: anchor });
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

/** 실제 graph의 global evaluation·closed helper body·borrowed endpoint를 한 계획으로 연결한다. */
export function collectPrimitivePlan(context: ConstructorCarrierContext, declaration: ts.ClassLikeDeclaration,
  work: ProofWork): PrimitivePlan {
  const roots: PrimitiveEntry[] = [];
  const { binding, anchor } = controllerEntry(context, declaration, work);
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
            if (statement === declaration) carrierRoots(member, anchor, roots, work);
            else if (!literalEndpoint(member, work)) roots.push({ node: member, entry: anchor });
          } else if (ts.isPropertyDeclaration(member) && member.initializer !== undefined
            && !primitiveLiteral(normalizePrimitiveExpression(member.initializer, work).inner)) {
            roots.push({ node: member.initializer, entry: fieldEntry(context, statement, work) });
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        for (const binding of statement.declarationList.declarations) {
          work(); const value = binding.initializer === undefined ? undefined
            : normalizePrimitiveExpression(binding.initializer, work).inner;
          if (value !== undefined && (ts.isIdentifier(value) || ts.isCallExpression(value))) {
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
  return { roots };
}
