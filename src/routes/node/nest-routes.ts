/**
 * NestJS 10–12 컨트롤러 라우트를 데코레이터에서 추출한다.
 *
 * 확인한 @nestjs/core@12.1.2(`router/routes-resolver.js`·`router-explorer.js`·`route-path-factory.js`·`router-module.js`·
 * `legacy-route-converter.js`, `nest-application.js`)와 @nestjs/common@12.1.2(`decorators/http/*`, `utils/shared.utils.js`),
 * @nestjs/core 10.4.19·11.2.7의 같은 파일, @nestjs/platform-express@12.1.2 동작(오라클 실행으로 재확인):
 * - 경로 = [전역 접두사] + [URI 버전 `/<prefix><version>`] + [RouterModule 모듈 경로] + [컨트롤러 경로] + [메서드 경로]이고,
 *   조각은 `stripEndSlash(a) + addLeadingSlash(b)`로 잇고 끝 슬래시를 뗀다(`RoutePathFactory.create`). `@Get()`의 경로는 `/`다.
 * - 모듈의 `controllers`에 든 컨트롤러만 등록된다. 컨트롤러 안 메서드는 정의 순서(`getAllMethodNames`, 상속 메서드는 뒤)로
 *   등록한다. Express 어댑터는 등록 순서 라우터라 컨트롤러 하나를 group으로 순서를 싣는다(다른 컨트롤러와는 비교하지 않는다).
 *   `@Next()`를 받는 핸들러, host·헤더 버전 필터(맞지 않으면 `next()`)가 붙은 라우트, `routeResolutionStrategy`를 켠 앱은
 *   순서를 싣지 않는다. Fastify 어댑터는 find-my-way라 구체성이다.
 * - Express 어댑터는 Nest 10이 Express 4(path-to-regexp 0.1), 11·12가 Express 5에 `LegacyRouteConverter`(`*`→`{*path}`)를 거친
 *   path-to-regexp 8이다. Express 기본값이라 대소문자 무시·끝 슬래시 선택이다.
 */

import ts from 'typescript';

import type { RouteDeclMethod } from '../../exchange/bridge-facts.ts';
import { scopeIdOf } from '../../graph/symbol-ids.ts';
import { compileExpress4Path } from './express4-path.ts';
import type { FlatRoute, FrameworkRoutes } from './flat-route.ts';
import { compileFindMyWayPath } from './fmw-path.ts';
import { groupName } from './group-name.ts';
import type { DetectedFrameworks } from './node-frameworks.ts';
import type { NodeProject } from './node-project.ts';
import type { CompiledPath } from './path-model.ts';
import { compilePte8Path } from './pte8-path.ts';
import type { HandlerInfo } from './router-model.ts';
import { declarationOf, packageBindingOf, unwrap } from './symbols.ts';

/** 요청 매핑 데코레이터 → method다(`RequestMethod`). */
const MAPPING_DECORATORS: Readonly<Record<string, RouteDeclMethod | string>> = {
  Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH', Options: 'OPTIONS', Head: 'HEAD', All: 'ANY',
  Search: 'SEARCH', Propfind: 'PROPFIND', Proppatch: 'PROPPATCH', Mkcol: 'MKCOL', Copy: 'COPY', Move: 'MOVE', Lock: 'LOCK', Unlock: 'UNLOCK', Query: 'QUERY',
};

/** 계약 method다. */
const CONTRACT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'HEAD', 'ANY']);

/** 앱 부트스트랩 설정이다. */
interface NestBootstrap {
  /** 전역 접두사(없으면 ''). 확정하지 못했으면 undefined */
  readonly globalPrefix: string | undefined;
  /** 전역 접두사 제외 경로(리터럴만) */
  readonly excluded: readonly { readonly path: string; readonly method: string | undefined }[] | undefined;
  /** URI 버전 설정(없으면 undefined). 확정하지 못했으면 'unknown' */
  readonly versioning: { readonly type: 'uri' | 'other'; readonly prefix: string; readonly defaultVersion: readonly VersionValue[] | undefined } | undefined | 'unknown';
  readonly adapter: 'express' | 'fastify';
  /** `routeResolutionStrategy` 옵션이 있으면 true(등록 순서를 바꾼다) */
  readonly reordered: boolean;
  /** 부트스트랩을 찾았는지 */
  readonly found: boolean;
}

/** 버전 값(문자열 또는 VERSION_NEUTRAL)이다. */
type VersionValue = string | typeof NEUTRAL;

/** `VERSION_NEUTRAL` 표시다. */
const NEUTRAL = Symbol('VERSION_NEUTRAL');

/** 컨트롤러 하나다. */
interface ControllerInfo {
  readonly node: ts.ClassDeclaration;
  readonly paths: readonly string[] | undefined;
  readonly hasHost: boolean;
  readonly version: readonly VersionValue[] | undefined | 'unknown';
}

/**
 * NestJS 라우트를 추출한다.
 *
 * @param project 프로젝트
 * @param nest 감지 결과
 * @param includeFile 분석할 파일인지
 * @returns 프레임워크 결과(없으면 빈 목록)
 */
export function extractNestRoutes(project: NodeProject, nest: NonNullable<DetectedFrameworks['nest']>, includeFile: (path: string) => boolean): FrameworkRoutes[] {
  const files = [...project.files].filter(([path]) => includeFile(path)).map(([, sourceFile]) => sourceFile);
  const registered = registeredControllers(project, files);
  const modulePaths = routerModulePaths(project, files);
  const bootstrap = readBootstrap(project, files, nest.adapters);
  const routes: FlatRoute[] = [];
  for (const controller of controllers(project, files)) {
    // 어느 모듈의 controllers에도 없는 컨트롤러는 Nest가 등록하지 않는다.
    if (!registered.has(controller.node)) continue;
    const module = registered.get(controller.node);
    const modulePath = module !== undefined && modulePaths.has(module) ? modulePaths.get(module) ?? null : '';
    routes.push(...controllerRoutes(project, controller, modulePath, bootstrap, nest));
  }
  const notes = bootstrap.found ? [] : ['unresolved-route-prefix: no NestFactory.create() bootstrap was found in the project; the global prefix and versioning are unknown, so NestJS routes use pathAnchor base'];
  return [{ framework: 'nest', dispatch: bootstrap.adapter === 'express' ? 'registration-order' : 'specificity', routes, provided: [], middlewareCount: 0, notes }];
}

/**
 * 데코레이터가 `@nestjs/common`의 이름이면 그 호출 식을 돌려준다.
 *
 * @param project 프로젝트
 * @param decorator 데코레이터
 * @param names 이름 목록
 * @returns 이름과 호출 식
 */
function nestDecorator(project: NodeProject, decorator: ts.Decorator, names: readonly string[]): { name: string; call: ts.CallExpression | undefined } | undefined {
  const expression = decorator.expression;
  const callee = ts.isCallExpression(expression) ? expression.expression : expression;
  const binding = packageBindingOf(project.checker, callee);
  if (binding?.module !== '@nestjs/common' || !names.includes(binding.name)) return undefined;
  return { name: binding.name, call: ts.isCallExpression(expression) ? expression : undefined };
}

/**
 * 노드의 데코레이터 목록이다.
 *
 * @param node 노드
 * @returns 데코레이터
 */
function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? ts.getDecorators(node) ?? [] : [];
}

/**
 * `@Controller`가 붙은 클래스를 모은다.
 *
 * @param project 프로젝트
 * @param files 분석할 소스
 * @returns 컨트롤러 목록
 */
function controllers(project: NodeProject, files: readonly ts.SourceFile[]): ControllerInfo[] {
  const found: ControllerInfo[] = [];
  for (const sourceFile of files) {
    for (const statement of sourceFile.statements) {
      if (!ts.isClassDeclaration(statement)) continue;
      const decorator = decoratorsOf(statement).map((entry) => nestDecorator(project, entry, ['Controller'])).find((entry) => entry !== undefined);
      if (decorator !== undefined) found.push(controllerInfo(project, statement, decorator.call));
    }
  }
  return found;
}

/**
 * `@Controller(prefixOrOptions)` 인자를 읽는다.
 *
 * @param project 프로젝트
 * @param node 클래스
 * @param call 데코레이터 호출
 * @returns 컨트롤러 정보
 */
function controllerInfo(project: NodeProject, node: ts.ClassDeclaration, call: ts.CallExpression | undefined): ControllerInfo {
  const argument = call?.arguments[0];
  if (argument === undefined) return { node, paths: ['/'], hasHost: false, version: undefined };
  const value = unwrap(argument);
  if (!ts.isObjectLiteralExpression(value)) return { node, paths: stringList(project, value, '/'), hasHost: false, version: undefined };
  const property = (name: string): ts.Expression | undefined => {
    const entry = value.properties.find((item) => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name);
    return entry !== undefined && ts.isPropertyAssignment(entry) ? entry.initializer : undefined;
  };
  const path = property('path');
  const version = property('version');
  return {
    node,
    paths: path === undefined ? ['/'] : stringList(project, path, '/'),
    hasHost: property('host') !== undefined,
    version: version === undefined ? undefined : versionList(project, version),
  };
}

/**
 * 문자열 또는 문자열 배열 식을 읽는다. 빈 문자열·빈 배열은 기본값이다.
 *
 * @param project 프로젝트
 * @param expression 식
 * @param fallback 기본값
 * @returns 문자열 목록 또는 undefined(확정하지 못함)
 */
function stringList(project: NodeProject, expression: ts.Expression, fallback: string): string[] | undefined {
  const node = unwrap(expression);
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((element) => constantString(project, element as ts.Expression));
    if (values.some((entry) => entry === undefined)) return undefined;
    return values.length === 0 ? [fallback] : (values as string[]);
  }
  const value = constantString(project, node);
  return value === undefined ? undefined : [value];
}

/**
 * 상수 문자열(리터럴, const 변수, 열거형 멤버)을 읽는다.
 *
 * @param project 프로젝트
 * @param expression 식
 * @param depth 추적 깊이
 * @returns 문자열 또는 undefined
 */
function constantString(project: NodeProject, expression: ts.Expression, depth = 0): string | undefined {
  const node = unwrap(expression);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (depth > 8) return undefined;
  if (ts.isPropertyAccessExpression(node)) {
    const value = project.checker.getConstantValue(node);
    if (typeof value === 'string') return value;
  }
  if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return undefined;
  const declaration = declarationOf(project.checker, ts.isIdentifier(node) ? node : node.name);
  if (declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined) return constantString(project, declaration.initializer, depth + 1);
  if (declaration !== undefined && ts.isPropertyAssignment(declaration)) return constantString(project, declaration.initializer, depth + 1);
  return undefined;
}

/**
 * 버전 값(문자열, 배열, `VERSION_NEUTRAL`)을 읽는다.
 *
 * @param project 프로젝트
 * @param expression 식
 * @returns 버전 목록 또는 'unknown'
 */
function versionList(project: NodeProject, expression: ts.Expression): readonly VersionValue[] | 'unknown' {
  const node = unwrap(expression);
  const single = (entry: ts.Expression): VersionValue | undefined => {
    const inner = unwrap(entry);
    const binding = ts.isIdentifier(inner) ? packageBindingOf(project.checker, inner) : undefined;
    if (binding?.module === '@nestjs/common' && binding.name === 'VERSION_NEUTRAL') return NEUTRAL;
    return constantString(project, inner);
  };
  const values = ts.isArrayLiteralExpression(node) ? node.elements.map((element) => single(element as ts.Expression)) : [single(node)];
  return values.some((entry) => entry === undefined) ? 'unknown' : [...new Set(values as VersionValue[])];
}

/**
 * 모듈 `controllers` 배열에 든 컨트롤러와 그 모듈을 모은다(`@Module({controllers})`와 동적 모듈 객체의 `controllers`).
 *
 * @param project 프로젝트
 * @param files 분석할 소스
 * @returns 컨트롤러 클래스 → 모듈 클래스(동적 모듈이면 그 식을 감싼 클래스)
 */
function registeredControllers(project: NodeProject, files: readonly ts.SourceFile[]): Map<ts.ClassDeclaration, ts.ClassDeclaration | undefined> {
  const registered = new Map<ts.ClassDeclaration, ts.ClassDeclaration | undefined>();
  for (const sourceFile of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'controllers' && ts.isArrayLiteralExpression(unwrap(node.initializer))) {
        const owner = owningClass(node);
        for (const element of (unwrap(node.initializer) as ts.ArrayLiteralExpression).elements) {
          const declaration = ts.isIdentifier(element) ? declarationOf(project.checker, element) : undefined;
          if (declaration !== undefined && ts.isClassDeclaration(declaration)) registered.set(declaration, owner);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return registered;
}

/**
 * 노드를 감싼 클래스 선언이다.
 *
 * @param node 노드
 * @returns 클래스 또는 undefined
 */
function owningClass(node: ts.Node): ts.ClassDeclaration | undefined {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isClassDeclaration(current)) return current;
  }
  return undefined;
}

/**
 * `RouterModule.register([...])`의 모듈 경로를 모은다(`flattenRoutePaths`·`normalizePath`와 같은 규칙).
 *
 * @param project 프로젝트
 * @param files 분석할 소스
 * @returns 모듈 클래스 → 모듈 경로(확정하지 못했으면 undefined 값)
 */
function routerModulePaths(project: NodeProject, files: readonly ts.SourceFile[]): Map<ts.ClassDeclaration | undefined, string | undefined> {
  const paths = new Map<ts.ClassDeclaration | undefined, string | undefined>();
  for (const sourceFile of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'register') {
        const binding = packageBindingOf(project.checker, node.expression.expression);
        const routes = node.arguments[0];
        if (binding?.module === '@nestjs/core' && binding.name === 'RouterModule' && routes !== undefined) collectRoutes(project, routes, '', paths);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return paths;
}

/**
 * RouterModule 라우트 배열 하나를 읽는다.
 *
 * @param project 프로젝트
 * @param routes 라우트 배열 식
 * @param parent 부모 경로
 * @param paths 결과(갱신)
 */
function collectRoutes(project: NodeProject, routes: ts.Expression, parent: string, paths: Map<ts.ClassDeclaration | undefined, string | undefined>): void {
  const node = unwrap(routes);
  if (!ts.isArrayLiteralExpression(node)) return;
  for (const element of node.elements) {
    const entry = unwrap(element as ts.Expression);
    if (ts.isIdentifier(entry)) {
      const declaration = declarationOf(project.checker, entry);
      if (declaration !== undefined && ts.isClassDeclaration(declaration) && parent !== '') paths.set(declaration, normalizeNestPath(parent));
      continue;
    }
    if (!ts.isObjectLiteralExpression(entry)) continue;
    const property = (name: string): ts.Expression | undefined => {
      const item = entry.properties.find((candidate) => ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === name);
      return item !== undefined && ts.isPropertyAssignment(item) ? item.initializer : undefined;
    };
    const pathExpression = property('path');
    const path = pathExpression === undefined ? undefined : constantString(project, pathExpression);
    const combined = path === undefined ? undefined : normalizeNestPath(normalizeNestPath(parent) + normalizeNestPath(path));
    const moduleExpression = property('module');
    const module = moduleExpression !== undefined && ts.isIdentifier(unwrap(moduleExpression)) ? declarationOf(project.checker, unwrap(moduleExpression)) : undefined;
    if (module !== undefined && ts.isClassDeclaration(module) && path !== undefined) paths.set(module, combined);
    else if (module !== undefined && ts.isClassDeclaration(module)) paths.set(module, undefined);
    const children = property('children');
    if (children !== undefined && combined !== undefined) collectRoutes(project, children, combined, paths);
  }
}

/**
 * Nest `normalizePath`를 옮긴다.
 *
 * @param path 경로
 * @returns 정리한 경로
 */
function normalizeNestPath(path: string): string {
  return path === '' ? '/' : `/${path.replace(/\/+$/u, '')}`.replace(/\/+/gu, '/');
}

/**
 * 부트스트랩(`NestFactory.create`)과 전역 접두사·버전 설정을 읽는다.
 *
 * @param project 프로젝트
 * @param files 분석할 소스
 * @param adapters 감지한 어댑터 패키지
 * @returns 부트스트랩 설정
 */
function readBootstrap(project: NodeProject, files: readonly ts.SourceFile[], adapters: readonly ('express' | 'fastify')[]): NestBootstrap {
  const creates: ts.CallExpression[] = [];
  const configs: ts.CallExpression[] = [];
  for (const sourceFile of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        const binding = packageBindingOf(project.checker, node.expression.expression);
        if (name === 'create' && binding?.module === '@nestjs/core' && binding.name === 'NestFactory') creates.push(node);
        if (name === 'setGlobalPrefix' || name === 'enableVersioning') configs.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  const adapter = creates.some((call) => usesFastifyAdapter(project, call)) || (creates.length === 0 && adapters.length === 1 && adapters[0] === 'fastify') ? 'fastify' : 'express';
  const relevant = configs.filter((call) => receiverIsApp(project, call, creates));
  return {
    ...globalPrefixOf(project, relevant.filter((call) => (call.expression as ts.PropertyAccessExpression).name.text === 'setGlobalPrefix')),
    versioning: versioningOf(project, relevant.filter((call) => (call.expression as ts.PropertyAccessExpression).name.text === 'enableVersioning')),
    adapter,
    reordered: creates.some((call) => call.arguments.some((argument) => ts.isObjectLiteralExpression(unwrap(argument)) && (unwrap(argument) as ts.ObjectLiteralExpression).properties.some((property) => property.name !== undefined && ts.isIdentifier(property.name) && property.name.text === 'routeResolutionStrategy'))),
    found: creates.length > 0,
  };
}

/**
 * `NestFactory.create(Module, new FastifyAdapter())`인지 본다.
 *
 * @param project 프로젝트
 * @param call create 호출
 * @returns Fastify 어댑터면 true
 */
function usesFastifyAdapter(project: NodeProject, call: ts.CallExpression): boolean {
  return call.arguments.slice(1).some((argument) => {
    const node = unwrap(argument);
    return ts.isNewExpression(node) && packageBindingOf(project.checker, node.expression)?.module === '@nestjs/platform-fastify';
  });
}

/**
 * 설정 호출의 수신자가 `NestFactory.create()` 결과를 담은 변수인지 본다.
 *
 * @param project 프로젝트
 * @param call 설정 호출
 * @param creates create 호출 목록
 * @returns 그렇다면 true
 */
function receiverIsApp(project: NodeProject, call: ts.CallExpression, creates: readonly ts.CallExpression[]): boolean {
  const receiver = unwrap((call.expression as ts.PropertyAccessExpression).expression);
  if (!ts.isIdentifier(receiver)) return false;
  const declaration = declarationOf(project.checker, receiver);
  return declaration !== undefined && ts.isVariableDeclaration(declaration) && declaration.initializer !== undefined && creates.includes(unwrap(declaration.initializer) as ts.CallExpression);
}

/**
 * 전역 접두사와 제외 경로를 읽는다. 호출이 여럿이거나 값을 확정하지 못하면 모른다.
 *
 * @param project 프로젝트
 * @param calls setGlobalPrefix 호출
 * @returns 접두사·제외
 */
function globalPrefixOf(project: NodeProject, calls: readonly ts.CallExpression[]): Pick<NestBootstrap, 'globalPrefix' | 'excluded'> {
  if (calls.length === 0) return { globalPrefix: '', excluded: [] };
  if (calls.length > 1) return { globalPrefix: undefined, excluded: undefined };
  const [prefixArgument, options] = calls[0]!.arguments;
  const prefix = prefixArgument === undefined ? undefined : constantString(project, prefixArgument);
  if (options === undefined) return { globalPrefix: prefix, excluded: [] };
  const optionObject = unwrap(options);
  if (!ts.isObjectLiteralExpression(optionObject)) return { globalPrefix: prefix, excluded: undefined };
  const exclude = optionObject.properties.find((property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'exclude');
  if (exclude === undefined || !ts.isPropertyAssignment(exclude) || !ts.isArrayLiteralExpression(unwrap(exclude.initializer))) return { globalPrefix: prefix, excluded: exclude === undefined ? [] : undefined };
  const excluded = (unwrap(exclude.initializer) as ts.ArrayLiteralExpression).elements.map((element) => excludedRoute(project, element as ts.Expression));
  return { globalPrefix: prefix, excluded: excluded.some((entry) => entry === undefined) ? undefined : (excluded as { path: string; method: string | undefined }[]) };
}

/**
 * 제외 경로 하나(파라미터 없는 리터럴 문자열 또는 `{path, method: RequestMethod.X}`)를 읽는다.
 *
 * @param project 프로젝트
 * @param expression 원소 식
 * @returns 제외 경로 또는 undefined(확정하지 못함)
 */
function excludedRoute(project: NodeProject, expression: ts.Expression): { path: string; method: string | undefined } | undefined {
  const node = unwrap(expression);
  const literal = constantString(project, node);
  if (literal !== undefined) return /[:*({]/u.test(literal) ? undefined : { path: normalizeNestPath(literal), method: undefined };
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const find = (name: string): ts.Expression | undefined => {
    const property = node.properties.find((item) => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name);
    return property !== undefined && ts.isPropertyAssignment(property) ? property.initializer : undefined;
  };
  const path = find('path') === undefined ? undefined : constantString(project, find('path')!);
  const method = find('method');
  const methodName = method !== undefined && ts.isPropertyAccessExpression(unwrap(method)) ? (unwrap(method) as ts.PropertyAccessExpression).name.text : undefined;
  if (path === undefined || /[:*({]/u.test(path) || (method !== undefined && methodName === undefined)) return undefined;
  return { path: normalizeNestPath(path), method: methodName === 'ALL' ? undefined : methodName };
}

/**
 * URI 버전 설정을 읽는다.
 *
 * @param project 프로젝트
 * @param calls enableVersioning 호출
 * @returns 버전 설정, 없음(undefined), 또는 'unknown'
 */
function versioningOf(project: NodeProject, calls: readonly ts.CallExpression[]): NestBootstrap['versioning'] {
  if (calls.length === 0) return undefined;
  const options = calls.length === 1 ? calls[0]!.arguments[0] : undefined;
  const object = options === undefined ? undefined : unwrap(options);
  if (object === undefined || !ts.isObjectLiteralExpression(object) || calls.length > 1) return 'unknown';
  const find = (name: string): ts.Expression | undefined => {
    const property = object.properties.find((item) => ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name);
    return property !== undefined && ts.isPropertyAssignment(property) ? property.initializer : undefined;
  };
  const type = find('type');
  const typeName = type !== undefined && ts.isPropertyAccessExpression(unwrap(type)) ? (unwrap(type) as ts.PropertyAccessExpression).name.text : undefined;
  if (typeName === undefined) return 'unknown';
  const prefixExpression = find('prefix');
  const prefix = prefixExpression === undefined ? 'v' : unwrap(prefixExpression).kind === ts.SyntaxKind.FalseKeyword ? '' : constantString(project, prefixExpression);
  const defaultExpression = find('defaultVersion');
  const defaultVersion = defaultExpression === undefined ? undefined : versionList(project, defaultExpression);
  if (prefix === undefined || defaultVersion === 'unknown') return 'unknown';
  return { type: typeName === 'URI' ? 'uri' : 'other', prefix, defaultVersion };
}

/**
 * 클래스와 조상 클래스의 메서드를 등록 순서(자기 메서드 먼저, 같은 이름은 자식이 가린다)로 모은다.
 *
 * @param project 프로젝트
 * @param node 클래스
 * @returns 메서드 목록
 */
function methodsInOrder(project: NodeProject, node: ts.ClassDeclaration): ts.MethodDeclaration[] {
  const seen = new Set<string>();
  const methods: ts.MethodDeclaration[] = [];
  for (let current: ts.ClassDeclaration | undefined = node, depth = 0; current !== undefined && depth < 16; depth++) {
    for (const member of current.members) {
      if (!ts.isMethodDeclaration(member) || member.name === undefined || !ts.isIdentifier(member.name) || seen.has(member.name.text)) continue;
      seen.add(member.name.text);
      methods.push(member);
    }
    const heritage: ts.ExpressionWithTypeArguments | undefined = current.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
    const base: ts.Declaration | undefined = heritage === undefined ? undefined : declarationOf(project.checker, heritage.expression);
    current = base !== undefined && ts.isClassDeclaration(base) && project.pathOf(base.getSourceFile()) !== undefined ? base : undefined;
  }
  return methods;
}

/**
 * 컨트롤러 하나의 라우트를 만든다.
 *
 * @param project 프로젝트
 * @param controller 컨트롤러
 * @param modulePath RouterModule 모듈 경로(없으면 `''`, 확정하지 못했으면 null)
 * @param bootstrap 부트스트랩 설정
 * @param nest 감지 결과
 * @returns 라우트 목록
 */
function controllerRoutes(project: NodeProject, controller: ControllerInfo, modulePath: string | null, bootstrap: NestBootstrap, nest: NonNullable<DetectedFrameworks['nest']>): FlatRoute[] {
  const routes: FlatRoute[] = [];
  const counter = { group: bootstrap.adapter === 'express' ? groupName('nest', project, controller.node.name ?? controller.node) : undefined, next: 0 };
  for (const controllerPath of controller.paths ?? ['{dynamic}']) {
    for (const method of methodsInOrder(project, controller.node)) {
      const mapping = decoratorsOf(method).map((entry) => nestDecorator(project, entry, Object.keys(MAPPING_DECORATORS))).find((entry) => entry !== undefined);
      if (mapping === undefined) continue;
      const decorator = decoratorsOf(method).find((entry) => nestDecorator(project, entry, [mapping.name]) !== undefined)!;
      const pathArgument = mapping.call?.arguments[0];
      const methodPaths = pathArgument === undefined ? ['/'] : stringList(project, pathArgument, '/');
      const handler = handlerOf(project, method);
      const methodVersion = methodVersionOf(project, method);
      const verb = MAPPING_DECORATORS[mapping.name]!;
      const index = counter.next;
      counter.next += 1;
      for (const methodPath of methodPaths ?? ['{dynamic}']) {
        for (const path of fullPaths(bootstrap, modulePath, controllerPath, methodPath, methodVersion ?? controller.version, verb)) {
          routes.push(nestRoute(bootstrap, nest, path, verb, handler, pathArgument ?? decorator, counter.group === undefined ? undefined : { group: counter.group, index }, controller, controller.paths === undefined || methodPaths === undefined));
        }
      }
    }
  }
  return routes;
}

/**
 * 메서드의 핸들러 정보다. `@Next()` 매개변수가 있으면 다음 핸들러로 넘길 수 있다.
 *
 * @param project 프로젝트
 * @param method 메서드
 * @returns 핸들러 정보
 */
function handlerOf(project: NodeProject, method: ts.MethodDeclaration): HandlerInfo {
  const path = project.pathOf(method.getSourceFile())!;
  const usr = method.body === undefined ? undefined : scopeIdOf(method.body, path);
  const next = method.parameters.some((parameter) => decoratorsOf(parameter).some((decorator) => nestDecorator(project, decorator, ['Next']) !== undefined));
  return { usr, qualifiedName: usr ?? scopeIdOf(method, path), inline: false, mayCallNext: next };
}

/**
 * 메서드의 `@Version()` 값이다.
 *
 * @param project 프로젝트
 * @param method 메서드
 * @returns 버전 목록, 없음(undefined), 또는 'unknown'
 */
function methodVersionOf(project: NodeProject, method: ts.MethodDeclaration): readonly VersionValue[] | undefined | 'unknown' {
  const decorator = decoratorsOf(method).map((entry) => nestDecorator(project, entry, ['Version'])).find((entry) => entry !== undefined);
  const argument = decorator?.call?.arguments[0];
  return argument === undefined ? undefined : versionList(project, argument);
}

/** 조립한 경로 하나다. */
interface NestPath {
  readonly text: string;
  readonly anchor: 'root' | 'base';
  readonly versionFiltered: boolean;
}

/**
 * `RoutePathFactory.create`로 경로를 조립한다.
 *
 * @param bootstrap 부트스트랩 설정
 * @param modulePath 모듈 경로(확정하지 못했으면 null)
 * @param controllerPath 컨트롤러 경로
 * @param methodPath 메서드 경로
 * @param version 버전(메서드 우선, 없으면 컨트롤러, 없으면 기본 버전)
 * @param verb method
 * @returns 경로 목록
 */
function fullPaths(bootstrap: NestBootstrap, modulePath: string | null, controllerPath: string, methodPath: string, version: readonly VersionValue[] | undefined | 'unknown', verb: string): NestPath[] {
  const versioning = bootstrap.versioning;
  const unknownPrefix = bootstrap.globalPrefix === undefined || versioning === 'unknown' || version === 'unknown' || modulePath === null;
  const effectiveVersion = version ?? (typeof versioning === 'object' ? versioning.defaultVersion : undefined);
  let paths = [''];
  const versionFiltered = typeof versioning === 'object' && versioning.type === 'other' && effectiveVersion !== undefined;
  if (!unknownPrefix && typeof versioning === 'object' && versioning.type === 'uri' && effectiveVersion !== undefined && effectiveVersion !== 'unknown') {
    paths = effectiveVersion.map((entry) => (entry === NEUTRAL ? '' : `/${versioning.prefix}${entry}`));
  }
  const concat = (base: string, fragment: string): string => stripEndSlash(base) + addLeadingSlash(fragment);
  for (const fragment of [modulePath ?? '', controllerPath, methodPath]) {
    const normalized = addLeadingSlash(fragment);
    if (normalized !== '') paths = paths.map((path) => concat(path, normalized));
  }
  if (!unknownPrefix && bootstrap.globalPrefix !== '') {
    const versionPrefixes = typeof versioning === 'object' && versioning.type === 'uri' && effectiveVersion !== undefined && effectiveVersion !== 'unknown'
      ? effectiveVersion.filter((entry): entry is string => entry !== NEUTRAL).map((entry) => `/${versioning.prefix}${entry}`)
      : [];
    paths = paths.map((path) => (isExcluded(bootstrap, truncateVersion(path, versionPrefixes), verb) ? path : stripEndSlash(bootstrap.globalPrefix!) + path));
  }
  return [...new Set(paths.map((path) => {
    const lead = addLeadingSlash(path === '' ? '/' : path);
    return lead !== '/' ? stripEndSlash(lead) : lead;
  }))].map((text) => ({ text, anchor: unknownPrefix || !bootstrap.found ? 'base' : 'root', versionFiltered }));
}

/**
 * 제외 비교 전에 URI 버전 접두사를 뗀다(`truncateVersionPrefixFromPath`: 앞에서 맞는 첫 버전 접두사를 한 번 지운다).
 *
 * @param path 경로
 * @param versionPrefixes `/<prefix><version>` 목록
 * @returns 뗀 경로
 */
function truncateVersion(path: string, versionPrefixes: readonly string[]): string {
  let result = path;
  for (const prefix of versionPrefixes) {
    if (result.startsWith(prefix)) result = result.replace(prefix, '');
  }
  return result;
}

/**
 * 전역 접두사 제외 경로에 걸리는지 본다(리터럴만 받으므로 정확히 비교한다).
 *
 * @param bootstrap 부트스트랩 설정
 * @param path 접두사 전 경로
 * @param verb method
 * @returns 제외면 true
 */
function isExcluded(bootstrap: NestBootstrap, path: string, verb: string): boolean {
  return (bootstrap.excluded ?? []).some((entry) => (entry.method === undefined || entry.method === verb) && normalizeNestPath(path) === entry.path);
}

/**
 * Nest `addLeadingSlash`다.
 *
 * @param path 경로
 * @returns 앞 슬래시를 붙인 경로
 */
function addLeadingSlash(path: string): string {
  if (path === '') return '';
  return path.startsWith('/') || path.startsWith('{/') ? path : `/${path}`;
}

/**
 * Nest `stripEndSlash`다.
 *
 * @param path 경로
 * @returns 끝 슬래시를 뗀 경로
 */
function stripEndSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * Nest 11·12 Express 어댑터의 `LegacyRouteConverter.tryConvert`를 옮긴다.
 *
 * @param route 경로
 * @returns 바꾼 경로
 */
export function convertLegacyRoute(route: string): string {
  const withLeading = route.startsWith('/') ? route : `/${route}`;
  const normalized = route.endsWith('/') ? withLeading : `${withLeading}/`;
  if (normalized.endsWith('/(.*)/')) return route.replace('(.*)', '{*path}');
  if (normalized.endsWith('/*/')) return route.replace('*', '{*path}');
  if (normalized.endsWith('/+/')) return route.replace('/+', '/*path');
  if (normalized.includes('/*/')) return route.replaceAll(/\/\*(?=\/)/gu, (_match, offset: number) => `/*path${offset}`);
  return route;
}

/**
 * 조립한 경로 하나를 어댑터 문법으로 컴파일해 라우트로 만든다.
 *
 * @param bootstrap 부트스트랩 설정
 * @param nest 감지 결과
 * @param path 조립한 경로
 * @param verb method
 * @param handler 핸들러
 * @param locationNode 위치 노드
 * @param order 순서
 * @param controller 컨트롤러
 * @param dynamicSource 컨트롤러·메서드 경로를 확정하지 못했는지
 * @returns 라우트
 */
function nestRoute(
  bootstrap: NestBootstrap,
  nest: NonNullable<DetectedFrameworks['nest']>,
  path: NestPath,
  verb: string,
  handler: HandlerInfo,
  locationNode: ts.Node,
  order: { group: string; index: number } | undefined,
  controller: ControllerInfo,
  dynamicSource: boolean,
): FlatRoute {
  const compiled: CompiledPath = dynamicSource ? { kind: 'dynamic', reason: 'non-literal', prefixes: undefined } : compileNestPath(bootstrap.adapter, nest.expressMajor, path.text);
  const narrowed = controller.hasHost || path.versionFiltered;
  const orderable = order !== undefined && !handler.mayCallNext && !narrowed && !bootstrap.reordered;
  const express = bootstrap.adapter === 'express';
  return {
    handler,
    unsupportedMethods: CONTRACT_METHODS.has(verb) ? [] : [verb],
    methods: CONTRACT_METHODS.has(verb) ? [verb as RouteDeclMethod] : [],
    path: compiled,
    rawPath: path.text,
    anchor: path.anchor,
    locationNode,
    order: orderable ? order : undefined,
    trailingSlash: express ? 'optional' : 'strict',
    caseInsensitive: express,
    narrowed,
    conditional: false,
  };
}

/**
 * 어댑터 문법으로 컴파일한다.
 *
 * @param adapter 어댑터
 * @param expressMajor Express 주 버전(Nest 주 버전에서 정함)
 * @param path 경로
 * @returns 컴파일 결과
 */
function compileNestPath(adapter: 'express' | 'fastify', expressMajor: number | undefined, path: string): CompiledPath {
  if (adapter === 'fastify') return compileFindMyWayPath(path, { ignoreTrailingSlash: false, ignoreDuplicateSlashes: false });
  if (expressMajor === 4) return compileExpress4Path(path, false);
  if (expressMajor === 5) return compilePte8Path(convertLegacyRoute(path), true);
  const four = compileExpress4Path(path, false);
  const five = compilePte8Path(convertLegacyRoute(path), true);
  return JSON.stringify(four) === JSON.stringify(five) ? four : { kind: 'dynamic', reason: 'unsupported-syntax', prefixes: undefined };
}
