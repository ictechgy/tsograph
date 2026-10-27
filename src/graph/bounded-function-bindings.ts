/** 실제 effect proof cap 뒤에 빈 flow map을 안전 증명으로 오인하지 않는 함수 바인딩 해석이다. */
import ts from 'typescript';

import type { GraphStore } from './graph-model.ts';
import { isTypeOnly, skipWrappers } from './node-collector.ts';
import { scopeIdOf } from './symbol-ids.ts';
import type { Resolution } from './target-resolver.ts';

/** 이름은 대상 선택에 쓰지 않고, 같은 이름의 쓰기가 하나라도 있으면 보수적으로 거부한다. */
export interface BindingCensus {
  readonly writtenNames: ReadonlySet<string>;
  readonly unsafeFiles: ReadonlySet<ts.SourceFile>;
  readonly incompleteFiles: ReadonlySet<ts.SourceFile>;
}

/** 모든 선택 AST의 쓰기·동적 scope를 먼저 관찰한다. 지원 밖 LHS는 해당 파일을 인증하지 않는다. */
export function collectBindingCensus(files: Iterable<ts.SourceFile>): BindingCensus {
  const writtenNames = new Set<string>();
  const unsafeFiles = new Set<ts.SourceFile>();
  const incompleteFiles = new Set<ts.SourceFile>();
  for (const file of files) {
    if (((file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0) > 0) incompleteFiles.add(file);
    const record = (target: ts.Node): void => {
      if (ts.isIdentifier(target)) { writtenNames.add(target.text); return; }
      if (ts.isExpression(target)) target = skipWrappers(target);
      if (ts.isIdentifier(target)) { writtenNames.add(target.text); return; }
      if (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) || ts.isOmittedExpression(target)) return;
      if (ts.isBindingElement(target)) { record(target.name); return; }
      if (ts.isObjectBindingPattern(target) || ts.isArrayBindingPattern(target)) { target.elements.forEach(record); return; }
      if (ts.isObjectLiteralExpression(target)) { target.properties.forEach(record); return; }
      if (ts.isArrayLiteralExpression(target)) { target.elements.forEach(record); return; }
      if (ts.isPropertyAssignment(target)) { record(target.initializer); return; }
      if (ts.isShorthandPropertyAssignment(target)) { record(target.name); return; }
      if (ts.isSpreadAssignment(target) || ts.isSpreadElement(target)) { record(target.expression); return; }
      if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) { record(target.left); return; }
      incompleteFiles.add(file);
    };
    const visit = (node: ts.Node): void => {
      // 공통 타입 소거 판정이 import-equals를 모두 지우므로 runtime 경계를 먼저 남긴다.
      if (ts.isImportEqualsDeclaration(node)) {
        if (!node.isTypeOnly) unsafeFiles.add(file);
        return;
      }
      if (isTypeOnly(node)) return;
      if (ts.isWithStatement(node)
        || ts.isExportAssignment(node) && node.isExportEquals) unsafeFiles.add(file);
      if (ts.isIdentifier(node) && ['eval', 'exports', 'module', 'require'].includes(node.text)) {
        const propertyName = ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
        if (!propertyName) unsafeFiles.add(file);
      }
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) record(node.name);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
        && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) record(node.left);
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) record(node.operand);
      if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) record(node.initializer);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(file, visit);
  }
  return { writtenNames, unsafeFiles, incompleteFiles };
}

/** 부분 reference 색인을 기존 ValueFlow에 전달하지 않는 별도의 제한된 resolver다. */
export class BoundedFunctionResolver {
  private readonly checker: ts.TypeChecker;
  private readonly store: GraphStore;
  private readonly pathOf: (file: ts.SourceFile) => string | undefined;
  private readonly census: BindingCensus;
  private readonly moduleKind: ts.ModuleKind | undefined;
  private readonly blocked: (file: ts.SourceFile) => boolean;

  /** census는 모든 선택 파일을 먼저 방문한 결과이며 대상은 checker로만 고른다. */
  constructor(
    checker: ts.TypeChecker, store: GraphStore, pathOf: (file: ts.SourceFile) => string | undefined,
    census: BindingCensus, moduleKind: ts.ModuleKind | undefined, blocked: (file: ts.SourceFile) => boolean,
  ) {
    this.checker = checker; this.store = store; this.pathOf = pathOf;
    this.census = census; this.moduleKind = moduleKind; this.blocked = blocked;
  }

  /** 실제 call 식의 checker-selected 단일 함수 본문만 허용한다. 이름 후보·멤버·생성자는 추측하지 않는다. */
  resolveCallee(expression: ts.Expression): Resolution {
    const caller = expression.getSourceFile();
    if (this.blocked(caller)) return { kind: 'unresolved', reason: 'unresolved-import' };
    if (!ts.isCallExpression(expression.parent) || expression.parent.expression !== expression
      || !this.safeSource(caller)) return { kind: 'unresolved', reason: 'indirect' };
    const callee = skipWrappers(expression);
    if (!ts.isIdentifier(callee)) return { kind: 'unresolved', reason: 'indirect' };
    const original = this.checker.getSymbolAtLocation(callee);
    const symbol = this.runtimeSymbol(original);
    if (symbol === undefined) return { kind: 'unresolved', reason: original !== undefined && (original.flags & ts.SymbolFlags.Alias) !== 0 ? 'unresolved-import' : 'untyped' };
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0 || !declarations.every(ts.isFunctionDeclaration)) return { kind: 'unresolved', reason: 'indirect' };
    const bodies = declarations.filter(declaration => declaration.body !== undefined);
    if (bodies.length !== 1) return { kind: 'unresolved', reason: 'indirect' };
    const declaration = bodies[0]!;
    if (declaration.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword || modifier.kind === ts.SyntaxKind.Decorator)) {
      return { kind: 'unresolved', reason: 'indirect' };
    }
    const file = declaration.getSourceFile();
    const path = this.pathOf(file);
    if (path === undefined) return { kind: 'external' };
    if (this.blocked(file)) return { kind: 'unresolved', reason: 'unresolved-import' };
    if (!this.safeSource(file) || declaration.name === undefined
      || this.census.writtenNames.has(declaration.name.text)
      || ts.findAncestor(declaration.parent, ts.isModuleDeclaration) !== undefined) return { kind: 'unresolved', reason: 'indirect' };
    const id = scopeIdOf(declaration.body!, path);
    return this.store.hasNode(id) ? { kind: 'nodes', ids: [id] } : { kind: 'unresolved', reason: 'indirect' };
  }

  /** 이 경로는 참조·콜백 관계를 인증하지 않는다. */
  referenceTargets(_symbol: ts.Symbol | undefined): string[] { return []; }

  /** 타입 전용·순환·관찰하지 못한 export-star 경계는 runtime 함수로 승격하지 않는다. */
  private runtimeSymbol(original: ts.Symbol | undefined): ts.Symbol | undefined {
    let symbol = original;
    const seen = new Set<ts.Symbol>();
    for (let depth = 0; symbol !== undefined && depth < 32; depth++) {
      if (seen.has(symbol)) return undefined;
      seen.add(symbol);
      if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
      if (symbol.declarations?.length !== 1) return undefined;
      for (const declaration of symbol.declarations ?? []) {
        if (ts.isTypeOnlyImportOrExportDeclaration(declaration) || !this.safeSource(declaration.getSourceFile())) return undefined;
        const container = ts.findAncestor(declaration, (node): node is ts.ImportDeclaration | ts.ExportDeclaration => ts.isImportDeclaration(node) || ts.isExportDeclaration(node));
        if (container !== undefined && (ts.isExportDeclaration(container) ? container.isTypeOnly : container.importClause?.isTypeOnly === true)) return undefined;
        if (container?.moduleSpecifier !== undefined) {
          const module = this.checker.getSymbolAtLocation(container.moduleSpecifier);
          const sources = module?.declarations?.filter(ts.isSourceFile) ?? [];
          if (sources.length !== 1 || !this.safeSource(sources[0]!) || sources[0]!.statements.some(statement =>
            ts.isExportDeclaration(statement) && (statement.isTypeOnly || statement.exportClause === undefined))) return undefined;
        }
      }
      symbol = this.checker.getImmediateAliasedSymbol(symbol);
    }
    return undefined;
  }

  /** lexical binding의 외부 재대입이 없는 실제 ESM·정상 AST만 다룬다. */
  private safeSource(file: ts.SourceFile): boolean {
    if (!ts.isExternalModule(file) || this.census.unsafeFiles.has(file) || this.census.incompleteFiles.has(file)) return false;
    // 전역 ESNext보다 파일별 CJS emit 판정이 우선한다. CJS exports의 property 쓰기는 lexical 쓰기 census로 닫히지 않는다.
    if (file.impliedNodeFormat === ts.ModuleKind.CommonJS || /\.c(?:ts|js)$/iu.test(file.fileName)) return false;
    if ([ts.ModuleKind.ES2015, ts.ModuleKind.ES2020, ts.ModuleKind.ES2022, ts.ModuleKind.ESNext].includes(this.moduleKind!)) return true;
    return (this.moduleKind === ts.ModuleKind.Node16 || this.moduleKind === ts.ModuleKind.NodeNext)
      && file.impliedNodeFormat === ts.ModuleKind.ESNext;
  }
}
