/**
 * `next.config.*`에서 라우트 경로에 영향을 주는 값을 실행 없이 읽는다.
 *
 * 확인한 Next.js 16.2.7 동작(`next/dist` 소스와 번들 문서):
 * - 설정 파일 후보와 우선순위: `next.config.js` → `.mjs` → `.ts`(런타임이 TypeScript를 지원하면
 *   `.mts`도) — `shared/lib/constants.js`의 `CONFIG_FILES`와 `find-up` 순서.
 * - 기본값: `basePath: ''`, `trailingSlash: false`, `skipTrailingSlashRedirect` 없음,
 *   `pageExtensions: ['tsx', 'ts', 'jsx', 'js']` — `server/config-shared.js`.
 * - `rewrites`·`redirects`·`i18n`은 파일 라우트가 아닌 경로를 만든다(모델링하지 않는다).
 * - `assetPrefix`가 있으면 `<assetPrefix의 경로>/_next/:path+`를 `/_next/:path+`로 보내는 rewrite가 자동으로
 *   붙는다(`lib/load-custom-routes.js`). `/_next` 제공 경로의 스코프를 좁힐 때 쓴다.
 *
 * 설정은 객체 리터럴까지 정적으로 따라갈 수 있을 때만 값을 확정한다. 함수 내보내기·
 * 비리터럴 값은 `unknown`, 감싼 호출(`withX(config)`)은 안쪽 리터럴을 읽되 감쌌다는 사실을 남긴다.
 */

import ts from 'typescript';

import {
  indexModuleBindings,
  MAX_RESOLUTION_DEPTH,
  type ModuleBindings,
  resolveBoolean,
  resolveExpression,
  resolveString,
  resolveStringArray,
} from './static-values.ts';

/** Next.js가 찾는 설정 파일 이름(우선순위 순)이다. `.mts`는 런타임 지원 조건부라 마지막이다. */
export const NEXT_CONFIG_FILE_NAMES = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.mts'] as const;

/** 기본 `pageExtensions`다. */
export const DEFAULT_PAGE_EXTENSIONS: readonly string[] = ['tsx', 'ts', 'jsx', 'js'];

/** 정적으로 확정한 값 또는 확정하지 못함이다. */
export type Resolved<T> = { readonly kind: 'known'; readonly value: T } | { readonly kind: 'unknown' };

/** 파일 라우트 밖 경로를 만드는 설정 키다. */
export type FrameworkRouteKey = 'rewrites' | 'redirects' | 'i18n';

/** 라우트 경로에 영향을 주는 설정 값이다. */
export interface NextRouteConfig {
  /** 설정 파일 이름(프로젝트 루트 기준). 없으면 undefined */
  readonly fileName: string | undefined;
  readonly basePath: Resolved<string>;
  readonly trailingSlash: Resolved<boolean>;
  readonly skipTrailingSlashRedirect: Resolved<boolean>;
  readonly pageExtensions: Resolved<readonly string[]>;
  /** 설정에 있는 rewrites·redirects·i18n 키(정렬) */
  readonly frameworkRouteKeys: readonly FrameworkRouteKey[];
  /** 따라가지 못한 전개·계산된 키가 있어 설정 키 목록이 완전하지 않으면 true */
  readonly hasUnknownKeys: boolean;
  /** 설정에 `assetPrefix` 키가 있으면 true. `/_next` 자산이 다른 경로 접두사로도 제공된다. */
  readonly hasAssetPrefix: boolean;
  /** 내보낸 설정을 감싼 함수 호출 수. 0보다 크면 감싼 함수가 값을 바꿨을 수 있다. */
  readonly wrapperCalls: number;
  /** 내보낸 값을 객체 리터럴로 따라가지 못했으면 이유, 아니면 undefined */
  readonly unresolvedReason: UnresolvedConfigReason | undefined;
}

/** 설정 객체를 확정하지 못한 이유다. */
export type UnresolvedConfigReason = 'no-export' | 'function-export' | 'non-literal-export' | 'syntax-error' | 'unreadable' | 'symlink';

/** 설정 파일이 없을 때의 값(Next 기본값)이다. */
export const DEFAULT_NEXT_ROUTE_CONFIG: NextRouteConfig = {
  fileName: undefined,
  basePath: { kind: 'known', value: '' },
  trailingSlash: { kind: 'known', value: false },
  skipTrailingSlashRedirect: { kind: 'known', value: false },
  pageExtensions: { kind: 'known', value: DEFAULT_PAGE_EXTENSIONS },
  frameworkRouteKeys: [],
  hasUnknownKeys: false,
  hasAssetPrefix: false,
  wrapperCalls: 0,
  unresolvedReason: undefined,
};

/** 객체 리터럴에서 읽은 키 → 값 식 목록과, 모르는 키가 섞였는지다. */
interface ConfigProperties {
  readonly values: ReadonlyMap<string, ts.Expression | undefined>;
  /** 전개·계산된 키처럼 어떤 키가 있는지 확정하지 못하는 요소가 있으면 true */
  readonly hasUnknownKeys: boolean;
}

/** 내보낸 값을 따라간 결과다. */
type ExportResolution =
  | { readonly kind: 'object'; readonly object: ts.ObjectLiteralExpression; readonly wrapperCalls: number }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedConfigReason; readonly wrapperCalls: number };

/**
 * 설정 파일 텍스트에서 라우트 설정을 읽는다.
 *
 * @param fileName 설정 파일 이름
 * @param sourceFile 파싱한 설정 파일
 * @param hasSyntaxErrors 파서가 구문 오류를 보고했는지
 * @returns 라우트 설정
 */
export function readNextRouteConfig(fileName: string, sourceFile: ts.SourceFile, hasSyntaxErrors: boolean): NextRouteConfig {
  if (hasSyntaxErrors) return unresolvedConfig(fileName, 'syntax-error', 0);
  const bindings = indexModuleBindings(sourceFile);
  const exported = findExportedExpression(sourceFile);
  if (exported === undefined) return unresolvedConfig(fileName, 'no-export', 0);
  const resolution = resolveConfigObject(exported, bindings, 0, 0);
  if (resolution.kind === 'unresolved') return unresolvedConfig(fileName, resolution.reason, resolution.wrapperCalls);
  const properties = readObjectProperties(resolution.object, bindings, 0);
  return {
    fileName,
    basePath: readValue(properties, 'basePath', '', (value) => resolveString(value, bindings)),
    trailingSlash: readValue(properties, 'trailingSlash', false, (value) => resolveBoolean(value, bindings)),
    skipTrailingSlashRedirect: readValue(properties, 'skipTrailingSlashRedirect', false, (value) => resolveBoolean(value, bindings)),
    pageExtensions: readValue<readonly string[]>(properties, 'pageExtensions', DEFAULT_PAGE_EXTENSIONS, (value) => resolveStringArray(value, bindings)),
    frameworkRouteKeys: (['i18n', 'redirects', 'rewrites'] as const).filter((key) => properties.values.has(key)),
    hasUnknownKeys: properties.hasUnknownKeys,
    hasAssetPrefix: properties.values.has('assetPrefix'),
    wrapperCalls: resolution.wrapperCalls,
    unresolvedReason: undefined,
  };
}

/**
 * 설정을 읽지 못했을 때의 값이다. 경로 접두사와 확장자를 모두 모른다고 표시한다.
 *
 * @param fileName 설정 파일 이름
 * @param reason 이유
 * @param wrapperCalls 따라가며 지난 감싼 호출 수
 * @returns 라우트 설정
 */
export function unresolvedConfig(fileName: string, reason: UnresolvedConfigReason, wrapperCalls: number): NextRouteConfig {
  return {
    fileName,
    basePath: { kind: 'unknown' },
    trailingSlash: { kind: 'unknown' },
    skipTrailingSlashRedirect: { kind: 'unknown' },
    pageExtensions: { kind: 'unknown' },
    frameworkRouteKeys: [],
    hasUnknownKeys: true,
    hasAssetPrefix: false,
    wrapperCalls,
    unresolvedReason: reason,
  };
}

/**
 * 모듈이 내보내는 설정 식을 찾는다: `export default X`, `module.exports = X`, `export = X`.
 *
 * `export default function …`은 함수 설정이라 함수 선언 노드를 식처럼 돌려주지 않고
 * 별도 표식(함수 식)으로 다룬다.
 *
 * @param sourceFile 파싱한 설정 파일
 * @returns 내보낸 식, 함수 선언, 또는 undefined
 */
function findExportedExpression(sourceFile: ts.SourceFile): ts.Expression | ts.FunctionDeclaration | undefined {
  let found: ts.Expression | ts.FunctionDeclaration | undefined;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) found = statement.expression;
    if (ts.isFunctionDeclaration(statement) && isDefaultExport(statement)) found = statement;
    if (ts.isExpressionStatement(statement) && isModuleExportsAssignment(statement.expression)) {
      found = (statement.expression as ts.BinaryExpression).right;
    }
  }
  return found;
}

/**
 * 함수 선언이 `export default function`인지 확인한다.
 *
 * @param declaration 함수 선언
 * @returns 기본 내보내기면 true
 */
function isDefaultExport(declaration: ts.FunctionDeclaration): boolean {
  const modifiers = ts.getModifiers(declaration) ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
}

/**
 * 식이 `module.exports = …` 할당인지 확인한다.
 *
 * @param expression 식 문장의 식
 * @returns module.exports 할당이면 true
 */
function isModuleExportsAssignment(expression: ts.Expression): boolean {
  if (!ts.isBinaryExpression(expression) || expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  const left = expression.left;
  return ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression)
    && left.expression.text === 'module' && left.name.text === 'exports';
}

/**
 * 내보낸 값을 객체 리터럴까지 따라간다.
 *
 * 감싼 호출(`withA(withB(config))`, `withC(opts)(config)`)은 첫 인자를 따라가고 호출 수를 센다.
 *
 * @param node 내보낸 식 또는 함수 선언
 * @param bindings 바인딩 색인
 * @param wrapperCalls 지금까지 지난 감싼 호출 수
 * @param depth 추적 깊이
 * @returns 객체 리터럴 또는 확정 실패 이유
 */
function resolveConfigObject(
  node: ts.Expression | ts.FunctionDeclaration,
  bindings: ModuleBindings,
  wrapperCalls: number,
  depth: number,
): ExportResolution {
  if (ts.isFunctionDeclaration(node)) return { kind: 'unresolved', reason: 'function-export', wrapperCalls };
  const resolved = depth > MAX_RESOLUTION_DEPTH ? undefined : resolveExpression(node, bindings);
  if (resolved === undefined) return { kind: 'unresolved', reason: 'non-literal-export', wrapperCalls };
  if (ts.isObjectLiteralExpression(resolved)) return { kind: 'object', object: resolved, wrapperCalls };
  if (ts.isArrowFunction(resolved) || ts.isFunctionExpression(resolved)) {
    return { kind: 'unresolved', reason: 'function-export', wrapperCalls };
  }
  const [first] = ts.isCallExpression(resolved) ? resolved.arguments : [];
  if (first === undefined) return { kind: 'unresolved', reason: 'non-literal-export', wrapperCalls };
  return resolveConfigObject(first, bindings, wrapperCalls + 1, depth + 1);
}

/**
 * 객체 리터럴의 키와 값 식을 읽는다. 전개(`...base`)는 따라갈 수 있으면 먼저 펼친다.
 *
 * 메서드·접근자(`async rewrites() {}`)는 키가 있다는 사실만 남기고 값은 undefined다.
 *
 * @param object 객체 리터럴
 * @param bindings 바인딩 색인
 * @param depth 전개 추적 깊이
 * @returns 키 → 값 식과 모르는 키 여부
 */
function readObjectProperties(object: ts.ObjectLiteralExpression, bindings: ModuleBindings, depth: number): ConfigProperties {
  const values = new Map<string, ts.Expression | undefined>();
  let hasUnknownKeys = false;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      const spread = readSpread(property.expression, bindings, depth);
      spread.values.forEach((value, key) => values.set(key, value));
      hasUnknownKeys ||= spread.hasUnknownKeys;
      continue;
    }
    const key = staticPropertyName(property.name);
    if (key === undefined) {
      hasUnknownKeys = true;
      continue;
    }
    values.set(key, propertyValue(property));
  }
  return { values, hasUnknownKeys };
}

/**
 * 전개 식을 객체 리터럴로 따라가 속성을 읽는다. 따라가지 못하면 모르는 키로 표시한다.
 *
 * @param expression 전개 대상 식
 * @param bindings 바인딩 색인
 * @param depth 전개 추적 깊이
 * @returns 속성과 모르는 키 여부
 */
function readSpread(expression: ts.Expression, bindings: ModuleBindings, depth: number): ConfigProperties {
  const resolved = depth >= MAX_RESOLUTION_DEPTH ? undefined : resolveExpression(expression, bindings);
  if (resolved === undefined || !ts.isObjectLiteralExpression(resolved)) return { values: new Map(), hasUnknownKeys: true };
  return readObjectProperties(resolved, bindings, depth + 1);
}

/**
 * 속성 이름이 정적(식별자·문자열·숫자)이면 텍스트를 돌려준다.
 *
 * @param name 속성 이름 노드
 * @returns 키 텍스트 또는 undefined(계산된 키·private 이름 등)
 */
function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/**
 * 속성의 값 식이다. 단축 속성은 같은 이름의 식별자, 메서드·접근자는 undefined다.
 *
 * @param property 객체 리터럴 요소(전개 제외)
 * @returns 값 식 또는 undefined
 */
function propertyValue(property: ts.ObjectLiteralElementLike): ts.Expression | undefined {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  return undefined;
}

/**
 * 키 하나의 값을 확정한다. 키가 없으면 기본값, 모르는 키가 섞였으면서 키가 없으면 unknown이다.
 *
 * @param properties 읽은 속성
 * @param key 키 이름
 * @param fallback Next 기본값
 * @param resolve 값 식 → 확정 값
 * @returns 확정 값 또는 unknown
 */
function readValue<T>(
  properties: ConfigProperties,
  key: string,
  fallback: T,
  resolve: (value: ts.Expression) => T | undefined,
): Resolved<T> {
  if (!properties.values.has(key)) {
    return properties.hasUnknownKeys ? { kind: 'unknown' } : { kind: 'known', value: fallback };
  }
  const expression = properties.values.get(key);
  const value = expression === undefined ? undefined : resolve(expression);
  return value === undefined ? { kind: 'unknown' } : { kind: 'known', value };
}
