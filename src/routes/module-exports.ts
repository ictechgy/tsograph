/**
 * 모듈 하나가 런타임에 내보내는 이름을 구문만으로 모은다.
 *
 * Next.js App Router는 route 파일 모듈의 **내보낸 이름**(`GET`·`POST` …)으로 핸들러를 고른다
 * (`next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js`). 그래서 값이
 * 어디서 왔는지(로컬 함수, 다른 모듈의 재내보내기, 구조 분해)는 몰라도 이름은 확정된다.
 * 이름 집합을 정적으로 확정할 수 없는 형태(`export *`, CommonJS 할당)는 추측하지 않고
 * 따로 센다.
 */

import ts from 'typescript';

/** 내보낸 이름 하나와 그 이름 토큰(위치용)이다. */
export interface ExportedName {
  readonly name: string;
  readonly node: ts.Node;
}

/** 모듈의 내보낸 이름과, 이름 집합을 확정하지 못하게 하는 형태의 수다. */
export interface ModuleExports {
  /** 값으로 내보낸 이름(타입 전용·ambient 선언 제외). 이름당 첫 선언만 둔다. */
  readonly names: readonly ExportedName[];
  /** `export * from '…'` 수(`export * as ns`는 이름 하나라 여기 세지 않는다) */
  readonly exportStarCount: number;
  /** `module.exports`·`exports.x` 할당과 `export =` 수 */
  readonly commonJsCount: number;
  /** 기본 내보내기 위치(`export default`의 `default` 토큰, `export { x as default }`의 이름) */
  readonly defaultExport: ts.Node | undefined;
  /** 첫 CommonJS 내보내기 문장(기본 내보내기가 없을 때 위치 대체용) */
  readonly firstCommonJsExport: ts.Node | undefined;
}

/**
 * 파일의 최상위 문장에서 내보낸 이름을 모은다.
 *
 * @param sourceFile 파싱한 파일
 * @returns 내보낸 이름과 미확정 형태 수
 */
export function collectModuleExports(sourceFile: ts.SourceFile): ModuleExports {
  const names = new Map<string, ExportedName>();
  let exportStarCount = 0;
  let commonJsCount = 0;
  let defaultExport: ts.Node | undefined;
  let firstCommonJsExport: ts.Node | undefined;
  for (const statement of sourceFile.statements) {
    for (const exported of statementExports(statement)) {
      if (!names.has(exported.name)) names.set(exported.name, exported);
    }
    defaultExport ??= defaultKeywordOf(statement, sourceFile);
    if (isExportStar(statement)) exportStarCount += 1;
    if (isCommonJsExport(statement)) {
      commonJsCount += 1;
      firstCommonJsExport ??= statement;
    }
  }
  defaultExport ??= names.get('default')?.node;
  names.delete('default');
  return { names: [...names.values()], exportStarCount, commonJsCount, defaultExport, firstCommonJsExport };
}

/**
 * `export default …` 문장이면 `default` 토큰을 돌려준다(`export =`는 제외).
 *
 * @param statement 최상위 문장
 * @param sourceFile 파싱한 파일(토큰 탐색용)
 * @returns `default` 토큰 또는 undefined
 */
function defaultKeywordOf(statement: ts.Statement, sourceFile: ts.SourceFile): ts.Node | undefined {
  const isDefaultAssignment = ts.isExportAssignment(statement) && statement.isExportEquals !== true;
  const isDefaultDeclaration = !ts.isExportAssignment(statement) && !ts.isInterfaceDeclaration(statement)
    && hasExportModifier(statement)
    && hasModifier(statement, ts.SyntaxKind.DefaultKeyword) && !hasModifier(statement, ts.SyntaxKind.DeclareKeyword);
  if (!isDefaultAssignment && !isDefaultDeclaration) return undefined;
  return statement.getChildren(sourceFile).flatMap((child) => (child.kind === ts.SyntaxKind.SyntaxList ? child.getChildren(sourceFile) : [child]))
    .find((child) => child.kind === ts.SyntaxKind.DefaultKeyword);
}

/**
 * 문장 하나가 값으로 내보내는 이름을 돌려준다.
 *
 * @param statement 최상위 문장
 * @returns 내보낸 이름 목록
 */
function statementExports(statement: ts.Statement): ExportedName[] {
  if (ts.isExportDeclaration(statement)) return exportDeclarationNames(statement);
  if (!hasExportModifier(statement) || hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) return [];
  if (hasModifier(statement, ts.SyntaxKind.DefaultKeyword)) return [];
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    return statement.name === undefined ? [] : [{ name: statement.name.text, node: statement.name }];
  }
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
  }
  if (ts.isImportEqualsDeclaration(statement) && !statement.isTypeOnly) {
    return [{ name: statement.name.text, node: statement.name }];
  }
  return [];
}

/**
 * `export { a as B }`·`export { B } from '…'`·`export * as ns from '…'`의 이름을 돌려준다.
 *
 * 타입 전용 선언과 타입 전용 지정자는 런타임 값이 없어 뺀다.
 *
 * @param declaration export 선언
 * @returns 내보낸 이름 목록
 */
function exportDeclarationNames(declaration: ts.ExportDeclaration): ExportedName[] {
  if (declaration.isTypeOnly) return [];
  const clause = declaration.exportClause;
  if (clause === undefined) return [];
  if (ts.isNamespaceExport(clause)) return [{ name: moduleExportNameText(clause.name), node: clause.name }];
  return clause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => ({ name: moduleExportNameText(element.name), node: element.name }));
}

/**
 * 모듈 내보내기 이름(식별자 또는 ES2022 문자열 이름)의 텍스트다.
 *
 * @param name 이름 노드
 * @returns 이름 텍스트
 */
function moduleExportNameText(name: ts.ModuleExportName): string {
  return name.text;
}

/**
 * 변수 선언의 바인딩 이름을 모두 모은다. 구조 분해(`export const { GET, POST } = h`)도 포함한다.
 *
 * @param name 바인딩 이름
 * @returns 바인딩된 식별자 목록
 */
function bindingNames(name: ts.BindingName): ExportedName[] {
  if (ts.isIdentifier(name)) return [{ name: name.text, node: name }];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bindingNames(element.name)));
}

/**
 * `export * from '…'`인지 확인한다.
 *
 * @param statement 최상위 문장
 * @returns 이름 집합을 확정할 수 없는 재내보내기면 true
 */
function isExportStar(statement: ts.Statement): boolean {
  return ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.exportClause === undefined;
}

/**
 * CommonJS 내보내기(`module.exports = …`, `module.exports.x = …`, `exports.x = …`)나 `export =`인지 확인한다.
 *
 * @param statement 최상위 문장
 * @returns CommonJS 형태면 true
 */
function isCommonJsExport(statement: ts.Statement): boolean {
  if (ts.isExportAssignment(statement)) return statement.isExportEquals === true;
  if (!ts.isExpressionStatement(statement)) return false;
  const expression = statement.expression;
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  return isCommonJsTarget(expression.left);
}

/**
 * 할당 대상이 `module.exports` 또는 `exports`에서 시작하는지 확인한다.
 *
 * @param target 할당 왼쪽 식
 * @returns CommonJS 내보내기 대상이면 true
 */
function isCommonJsTarget(target: ts.Expression): boolean {
  if (ts.isIdentifier(target)) return target.text === 'exports';
  if (!ts.isPropertyAccessExpression(target) && !ts.isElementAccessExpression(target)) return false;
  const owner = target.expression;
  if (ts.isIdentifier(owner) && owner.text === 'module' && ts.isPropertyAccessExpression(target)) {
    return target.name.text === 'exports';
  }
  return isCommonJsTarget(owner);
}

/**
 * 선언에 `export` 수정자가 있는지 확인한다.
 *
 * @param node 문장
 * @returns export 수정자가 있으면 true
 */
function hasExportModifier(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

/**
 * 선언에 특정 수정자가 있는지 확인한다.
 *
 * @param node 문장
 * @param kind 수정자 종류
 * @returns 있으면 true
 */
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}
