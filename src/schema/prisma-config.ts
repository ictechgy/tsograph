/**
 * `prisma.config.*`에서 스키마·TypedSQL 경로를 정적으로 읽는다.
 *
 * 설정 파일은 코드라 실행하지 않는다(분석 대상 코드를 실행하지 않는 제품 불변 조건). default
 * export 객체(`defineConfig({...})`, 객체 리터럴, 같은 파일의 const, `satisfies`·`as` 래퍼)의
 * `schema`와 `typedSql.path`가 문자열 리터럴일 때만 값으로 인정한다. 그 밖의 식(`path.join(...)`,
 * 환경 변수)은 "읽지 못함"으로 알려 호출자가 추측 대신 limitation을 내게 한다.
 */

import ts from 'typescript';

/** 설정 속성 하나의 정적 값이다. */
export type ConfigValue =
  | { readonly kind: 'absent' }
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'unresolved' };

/** 설정 파일에서 읽은 경로들이다. 경로는 설정 파일 디렉터리 기준 원문이다. */
export interface PrismaConfigPaths {
  readonly schema: ConfigValue;
  readonly typedSqlPath: ConfigValue;
}

/** Prisma 7이 찾는 설정 파일 후보다(c12 탐색 순서, 디렉터리 기준 상대 경로). */
export const PRISMA_CONFIG_CANDIDATES: readonly string[] = [
  ...['js', 'ts', 'mjs', 'cjs', 'mts', 'cts'].map((extension) => `prisma.config.${extension}`),
  ...['js', 'ts', 'mjs', 'cjs', 'mts', 'cts'].map((extension) => `.config/prisma.${extension}`),
  ...['js', 'ts', 'mjs', 'cjs', 'mts', 'cts'].map((extension) => `.config/prisma.config.${extension}`),
];

const ABSENT: ConfigValue = { kind: 'absent' };
const UNRESOLVED: ConfigValue = { kind: 'unresolved' };

/**
 * 설정 파일 텍스트에서 경로를 읽는다.
 *
 * @param fileName 파일 이름(스크립트 종류 판정용)
 * @param text 파일 텍스트
 * @returns 경로들. default export 객체를 찾지 못하면 둘 다 unresolved
 */
export function readPrismaConfig(fileName: string, text: string): PrismaConfigPaths {
  const kind = /\.[cm]?js$/u.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const config = defaultExportObject(sourceFile);
  if (config === undefined) return { schema: UNRESOLVED, typedSqlPath: UNRESOLVED };
  const typedSql = propertyValue(config, 'typedSql');
  return {
    schema: stringValue(propertyValue(config, 'schema')),
    typedSqlPath: typedSql === 'absent' ? ABSENT : nestedString(typedSql, 'path'),
  };
}

/**
 * default export(ESM `export default`, CJS `module.exports =`)의 설정 객체 리터럴을 찾는다.
 *
 * @param sourceFile 소스 파일
 * @returns 객체 리터럴 또는 undefined
 */
function defaultExportObject(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) return configObject(statement.expression, sourceFile);
    if (ts.isExpressionStatement(statement) && isModuleExportsAssignment(statement.expression)) {
      return configObject((statement.expression as ts.BinaryExpression).right, sourceFile);
    }
  }
  return undefined;
}

/**
 * 식을 설정 객체 리터럴로 푼다(래퍼·`defineConfig` 호출·같은 파일 const).
 *
 * @param expression 식
 * @param sourceFile 소스 파일
 * @param depth 재귀 깊이(순환 방지)
 * @returns 객체 리터럴 또는 undefined
 */
function configObject(expression: ts.Expression, sourceFile: ts.SourceFile, depth = 0): ts.ObjectLiteralExpression | undefined {
  if (depth > 8) return undefined;
  const inner = unwrap(expression);
  if (ts.isObjectLiteralExpression(inner)) return inner;
  if (ts.isCallExpression(inner) && inner.arguments.length === 1) {
    return configObject(inner.arguments[0]!, sourceFile, depth + 1);
  }
  if (ts.isIdentifier(inner)) {
    const initializer = constInitializer(sourceFile, inner.text);
    return initializer === undefined ? undefined : configObject(initializer, sourceFile, depth + 1);
  }
  return undefined;
}

/**
 * 최상위 `const name = …`의 초기값을 찾는다.
 *
 * @param sourceFile 소스 파일
 * @param name 이름
 * @returns 초기값 또는 undefined
 */
function constInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
    }
  }
  return undefined;
}

/**
 * 객체 리터럴에서 속성 값을 찾는다. 펼침(`...x`)이 있으면 값이 가려질 수 있어 읽지 못함이다.
 *
 * @param object 객체 리터럴
 * @param key 속성 이름
 * @returns 값 식, 없으면 'absent', 판정 불가면 'unresolved'
 */
function propertyValue(object: ts.ObjectLiteralExpression, key: string): ts.Expression | 'absent' | 'unresolved' {
  let found: ts.Expression | 'absent' | 'unresolved' = 'absent';
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) found = 'unresolved';
    else if (ts.isPropertyAssignment(property) && propertyKey(property.name) === key) found = property.initializer;
    else if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) found = 'unresolved';
  }
  return found;
}

/**
 * 속성 값을 문자열 설정 값으로 바꾼다.
 *
 * @param value 속성 값
 * @returns 설정 값
 */
function stringValue(value: ts.Expression | 'absent' | 'unresolved'): ConfigValue {
  if (value === 'absent') return ABSENT;
  if (value === 'unresolved') return UNRESOLVED;
  const inner = unwrap(value);
  return ts.isStringLiteralLike(inner) ? { kind: 'literal', value: inner.text } : UNRESOLVED;
}

/**
 * 중첩 객체(`typedSql: { path: '…' }`)의 문자열 속성을 읽는다.
 *
 * @param value 바깥 속성 값
 * @param key 안쪽 속성 이름
 * @returns 설정 값
 */
function nestedString(value: ts.Expression | 'unresolved', key: string): ConfigValue {
  if (value === 'unresolved') return UNRESOLVED;
  const inner = unwrap(value);
  return ts.isObjectLiteralExpression(inner) ? stringValue(propertyValue(inner, key)) : UNRESOLVED;
}

/**
 * 괄호·`as`·`satisfies` 래퍼를 벗긴다.
 *
 * @param expression 식
 * @returns 벗긴 식
 */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/**
 * 속성 이름의 정적 텍스트다.
 *
 * @param name 속성 이름
 * @returns 텍스트 또는 undefined
 */
function propertyKey(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/**
 * 식이 `module.exports = …`인지 본다.
 *
 * @param expression 식
 * @returns 맞으면 true
 */
function isModuleExportsAssignment(expression: ts.Expression): boolean {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = expression.left;
  return ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression)
    && left.expression.text === 'module' && left.name.text === 'exports';
}
