/** 타입 signature 대신 exact bag의 실제 allocation에서 primitive summary 후보 endpoint를 찾는다. */
import ts from 'typescript';
import type { ConstructorCarrierContext } from './constructor-carrier.ts';
import { normalizePrimitiveExpression, primitiveReferenceSite } from './primitive-helpers.ts';
import type { ProofWork } from './proof-dag.ts';

/** canonical binding 조회 자체도 query work에 포함한다. */
function symbolOf(context: ConstructorCarrierContext, node: ts.Node, work: ProofWork): ts.Symbol | undefined {
  work(); const symbol = context.checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    work(); return context.checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/** 구조 후보만 반환한다. singleton census·descriptor·entry 인증 없이 이 결과는 권한이 아니다. */
export function primitiveDependencyTarget(context: ConstructorCarrierContext, call: ts.CallExpression,
  work: ProofWork): ts.MethodDeclaration | undefined {
  const callee = normalizePrimitiveExpression(call.expression, work).inner;
  if (!ts.isPropertyAccessExpression(callee) || callee.questionDotToken !== undefined) return undefined;
  const projection = normalizePrimitiveExpression(callee.expression, work).inner;
  if (!ts.isPropertyAccessExpression(projection) || projection.questionDotToken !== undefined) return undefined;
  const bag = normalizePrimitiveExpression(projection.expression, work).inner;
  if (!ts.isPropertyAccessExpression(bag) || bag.questionDotToken !== undefined
    || normalizePrimitiveExpression(bag.expression, work).inner.kind !== ts.SyntaxKind.ThisKeyword) return undefined;
  let owner: ts.Node = call;
  for (let depth = 0; !ts.isFunctionLike(owner); depth++) {
    work(depth, depth);
    if (ts.isSourceFile(owner)) return undefined;
    owner = owner.parent;
  }
  if (!ts.isMethodDeclaration(owner) || !ts.isClassDeclaration(owner.parent) || owner.parent.name === undefined) return undefined;
  const carrier = owner.parent;
  const bagSymbol = symbolOf(context, bag.name, work);
  let parameter: ts.ParameterDeclaration | undefined;
  for (const member of carrier.members) {
    work(); if (!ts.isConstructorDeclaration(member)) continue;
    for (const candidate of member.parameters) {
      work(); if (!ts.isIdentifier(candidate.name)) continue;
      for (const declaration of bagSymbol?.declarations ?? []) {
        work(); if (declaration === candidate) parameter = candidate;
      }
    }
  }
  if (parameter === undefined) return undefined;
  const carrierSymbol = symbolOf(context, carrier.name!, work);
  let allocation: ts.NewExpression | undefined;
  for (const reference of carrierSymbol === undefined ? [] : context.index.references.get(carrierSymbol) ?? []) {
    work(); const site = primitiveReferenceSite(reference, work);
    if (!ts.isNewExpression(site.parent) || site.parent.expression !== site || allocation !== undefined) return undefined;
    allocation = site.parent;
  }
  work();
  if (allocation?.arguments?.length !== 1) return undefined;
  const literal = normalizePrimitiveExpression(allocation.arguments[0]!, work).inner;
  if (!ts.isObjectLiteralExpression(literal)) return undefined;
  let bindingSymbol: ts.Symbol | undefined;
  for (const property of literal.properties) {
    work();
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return undefined;
    if (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name)) return undefined;
    if (property.name.text !== projection.name.text) continue;
    const value = ts.isShorthandPropertyAssignment(property) ? property.name
      : normalizePrimitiveExpression(property.initializer, work).inner;
    if (!ts.isIdentifier(value) || bindingSymbol !== undefined) return undefined;
    work(); bindingSymbol = ts.isShorthandPropertyAssignment(property)
      ? context.checker.getShorthandAssignmentValueSymbol(property) : symbolOf(context, value, work);
  }
  const binding = bindingSymbol?.valueDeclaration;
  if (binding === undefined || !ts.isVariableDeclaration(binding) || binding.initializer === undefined) return undefined;
  const construction = normalizePrimitiveExpression(binding.initializer, work).inner;
  if (!ts.isNewExpression(construction)) return undefined;
  const target = symbolOf(context, normalizePrimitiveExpression(construction.expression, work).inner, work)?.valueDeclaration;
  if (target === undefined || !ts.isClassDeclaration(target)) return undefined;
  for (const member of target.members) {
    work();
    if (ts.isMethodDeclaration(member) && (ts.isIdentifier(member.name) || ts.isStringLiteralLike(member.name))
      && member.name.text === callee.name.text) return member;
  }
  return undefined;
}
