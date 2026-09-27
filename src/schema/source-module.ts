/**
 * TS/JS 소스 파일 하나를 파싱하고 import·export 표를 만든다.
 *
 * 컴파일러 API의 구문 트리만 쓴다(타입 검사·프로그램 생성 없음). export 표는 파일 사이
 * 클라이언트 출처 추적(`client-provenance.ts`)의 입력이고, 바인딩 선언은 스코프 빌더가 맡는다.
 */

import { extname } from 'node:path';

import ts from 'typescript';

import { SourceText } from './source-text.ts';

/** import 바인딩 하나다. `imported`는 `default`·`*`·이름 중 하나다. */
export interface ImportBinding {
  readonly local: string;
  readonly specifier: string;
  readonly imported: string;
}

/** export 대상이다. 로컬 이름, 다른 모듈의 재수출, 또는 식(default·CJS)이다. */
export type ExportTarget =
  | { readonly kind: 'local'; readonly name: string }
  | { readonly kind: 'reexport'; readonly specifier: string; readonly imported: string }
  | { readonly kind: 'expression'; readonly expression: ts.Expression };

/** 파싱한 소스 모듈이다. */
export interface SourceModule {
  /** 프로젝트 루트 기준 POSIX 경로다. */
  readonly path: string;
  /** 절대 경로다. */
  readonly absolutePath: string;
  readonly sourceFile: ts.SourceFile;
  readonly text: SourceText;
  /** 파서가 구문 오류를 보고했는지 여부다(트리는 오류 복구 결과다). */
  readonly hasParseErrors: boolean;
  readonly imports: readonly ImportBinding[];
  /** export 이름 → 대상이다. */
  readonly exports: ReadonlyMap<string, ExportTarget>;
  /** `export * from '…'`의 지정자다. */
  readonly starExports: readonly string[];
}

/** 소스로 읽는 확장자와 스크립트 종류다. 선언 파일(`.d.ts` 등)은 호출을 담지 않아 제외한다. */
const scriptKinds: ReadonlyMap<string, ts.ScriptKind> = new Map([
  ['.ts', ts.ScriptKind.TS], ['.mts', ts.ScriptKind.TS], ['.cts', ts.ScriptKind.TS],
  ['.tsx', ts.ScriptKind.TSX], ['.js', ts.ScriptKind.JS], ['.mjs', ts.ScriptKind.JS],
  ['.cjs', ts.ScriptKind.JS], ['.jsx', ts.ScriptKind.JSX],
]);

/**
 * 파일 이름이 스캔할 소스인지 본다.
 *
 * @param name 파일 이름
 * @returns 소스면 true
 */
export function isSourceFileName(name: string): boolean {
  return scriptKinds.has(extname(name)) && !/\.d\.[cm]?ts$/u.test(name);
}

/**
 * 소스 텍스트를 파싱해 모듈을 만든다.
 *
 * @param path 프로젝트 기준 경로
 * @param absolutePath 절대 경로
 * @param text 파일 텍스트(BOM 제거 뒤)
 * @returns 소스 모듈
 */
export function parseSourceModule(path: string, absolutePath: string, text: string): SourceModule {
  const kind = scriptKinds.get(extname(path)) ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(absolutePath, text, ts.ScriptTarget.Latest, true, kind);
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  const tables = collectModuleTables(sourceFile);
  return {
    path,
    absolutePath,
    sourceFile,
    text: new SourceText(text),
    hasParseErrors: (diagnostics?.length ?? 0) > 0,
    ...tables,
  };
}

/** import·export 표다. */
interface ModuleTables {
  readonly imports: ImportBinding[];
  readonly exports: Map<string, ExportTarget>;
  readonly starExports: string[];
}

/**
 * 최상위 문장에서 import·export 표를 만든다.
 *
 * @param sourceFile 소스 파일
 * @returns 표
 */
function collectModuleTables(sourceFile: ts.SourceFile): ModuleTables {
  const tables: ModuleTables = { imports: [], exports: new Map(), starExports: [] };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) collectImport(statement, tables);
    else if (ts.isExportDeclaration(statement)) collectExportDeclaration(statement, tables);
    else if (ts.isExportAssignment(statement)) collectExportAssignment(statement, tables);
    else if (ts.isExpressionStatement(statement)) collectCommonJsExport(statement.expression, tables);
    else collectExportedDeclaration(statement, tables);
  }
  return tables;
}

/**
 * import 선언의 바인딩을 모은다.
 *
 * @param statement import 선언
 * @param tables 표(추가된다)
 */
function collectImport(statement: ts.ImportDeclaration, tables: ModuleTables): void {
  const clause = statement.importClause;
  if (clause === undefined || !ts.isStringLiteral(statement.moduleSpecifier)) return;
  const specifier = statement.moduleSpecifier.text;
  if (clause.name !== undefined) tables.imports.push({ local: clause.name.text, specifier, imported: 'default' });
  const bindings = clause.namedBindings;
  if (bindings === undefined) return;
  if (ts.isNamespaceImport(bindings)) {
    tables.imports.push({ local: bindings.name.text, specifier, imported: '*' });
    return;
  }
  for (const element of bindings.elements) {
    const imported = element.propertyName === undefined ? element.name.text : moduleExportName(element.propertyName);
    tables.imports.push({ local: element.name.text, specifier, imported });
  }
}

/**
 * `export { a as b }`·`export { a } from '…'`·`export * from '…'`를 모은다.
 *
 * @param statement export 선언
 * @param tables 표(추가된다)
 */
function collectExportDeclaration(statement: ts.ExportDeclaration, tables: ModuleTables): void {
  const specifier = statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
    ? statement.moduleSpecifier.text
    : undefined;
  const clause = statement.exportClause;
  if (clause === undefined) {
    if (specifier !== undefined) tables.starExports.push(specifier);
    return;
  }
  if (ts.isNamespaceExport(clause)) return;
  for (const element of clause.elements) {
    const local = element.propertyName === undefined ? element.name.text : moduleExportName(element.propertyName);
    const exported = moduleExportName(element.name);
    tables.exports.set(exported, specifier === undefined
      ? { kind: 'local', name: local }
      : { kind: 'reexport', specifier, imported: local });
  }
}

/**
 * `export default <식>`을 모은다.
 *
 * @param statement export 할당
 * @param tables 표(추가된다)
 */
function collectExportAssignment(statement: ts.ExportAssignment, tables: ModuleTables): void {
  const expression = statement.expression;
  tables.exports.set('default', ts.isIdentifier(expression)
    ? { kind: 'local', name: expression.text }
    : { kind: 'expression', expression });
}

/**
 * `export const`·`export function`·`export default function` 같은 선언 export를 모은다.
 *
 * @param statement 최상위 문장
 * @param tables 표(추가된다)
 */
function collectExportedDeclaration(statement: ts.Statement, tables: ModuleTables): void {
  const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) ?? [] : [];
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
  const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        tables.exports.set(declaration.name.text, { kind: 'local', name: declaration.name.text });
      }
    }
    return;
  }
  const name = declarationName(statement);
  if (name !== undefined) tables.exports.set(isDefault ? 'default' : name, { kind: 'local', name });
}

/**
 * CommonJS export(`module.exports = x`·`exports.a = x`·`module.exports.a = x`)를 모은다.
 *
 * @param expression 최상위 식
 * @param tables 표(추가된다)
 */
function collectCommonJsExport(expression: ts.Expression, tables: ModuleTables): void {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
  const target = expression.left;
  const value = expression.right;
  if (isModuleExports(target)) {
    collectModuleExportsValue(value, tables);
    return;
  }
  if (ts.isPropertyAccessExpression(target) && (isModuleExports(target.expression) || isExportsIdentifier(target.expression))) {
    tables.exports.set(target.name.text, expressionTarget(value));
  }
}

/**
 * `module.exports = …`의 값을 모은다. 객체 리터럴은 멤버별 export, 그 밖은 default다.
 *
 * @param value 할당 값
 * @param tables 표(추가된다)
 */
function collectModuleExportsValue(value: ts.Expression, tables: ModuleTables): void {
  if (!ts.isObjectLiteralExpression(value)) {
    tables.exports.set('default', expressionTarget(value));
    return;
  }
  for (const property of value.properties) {
    if (ts.isShorthandPropertyAssignment(property)) {
      tables.exports.set(property.name.text, { kind: 'local', name: property.name.text });
    } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      tables.exports.set(property.name.text, expressionTarget(property.initializer));
    }
  }
}

/**
 * 식을 export 대상으로 바꾼다. 식별자는 로컬 이름이다.
 *
 * @param value 식
 * @returns export 대상
 */
function expressionTarget(value: ts.Expression): ExportTarget {
  return ts.isIdentifier(value) ? { kind: 'local', name: value.text } : { kind: 'expression', expression: value };
}

/**
 * 식이 `module.exports`인지 본다.
 *
 * @param expression 식
 * @returns 맞으면 true
 */
function isModuleExports(expression: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'module' && expression.name.text === 'exports';
}

/**
 * 식이 `exports` 식별자인지 본다.
 *
 * @param expression 식
 * @returns 맞으면 true
 */
function isExportsIdentifier(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) && expression.text === 'exports';
}

/**
 * 이름 있는 선언의 이름을 돌려준다.
 *
 * @param statement 문장
 * @returns 이름 또는 undefined
 */
function declarationName(statement: ts.Statement): string | undefined {
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement)
    || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
    return statement.name?.text ?? 'default';
  }
  return undefined;
}

/**
 * import/export 이름(식별자 또는 문자열 리터럴 이름)을 문자열로 바꾼다.
 *
 * @param name 이름 노드
 * @returns 이름
 */
function moduleExportName(name: ts.ModuleExportName): string {
  return name.text;
}
