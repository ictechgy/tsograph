/**
 * Express 4·5 라우트 등록을 해석하고 mount를 펼친다.
 *
 * 확인한 express@4.22.3(`lib/router/index.js`·`route.js`·`layer.js`, path-to-regexp@0.1.13)과 express@5.2.1(router@2.2.0,
 * path-to-regexp@8.4.2) 동작(오라클 실행으로 재확인):
 * - `app.METHOD(path, ...handlers)`와 `app.all`은 `router.route(path)`로 route 레이어 하나를 만든다. `route(path).get().post()`는
 *   한 레이어(한 등록)에 method를 더한다. 인자 하나의 `app.get(name)`은 설정 조회다.
 * - 라우터는 스택을 **등록 순서**로 걸으며, 경로가 맞고 그 route가 method를 받는 첫 레이어가 요청을 받는다(`_handles_method`,
 *   HEAD는 GET으로). 핸들러가 `next()`를 부르면 다음 레이어로 넘어간다 — 셋째 매개변수(`next`)가 있는 핸들러에는 `order`를
 *   싣지 않는다(isthmus 계약).
 * - `use(path?, ...fns)`는 끝이 열린 레이어다(세그먼트 경계, `strict: false`). 라우터·앱을 붙이면 요청 시점에 그 스택을 걷는다
 *   (참조). 자식 경로 `/`는 붙인 경로 자체와 끝 슬래시 형태 모두와 맞는다(`slashAdded`).
 * - 경로 매칭은 원문(퍼센트 인코딩 그대로) 경로에 하고, 기본은 대소문자 무시(`case sensitive routing` 꺼짐)·끝 슬래시 선택
 *   (`strict routing` 꺼짐)이다. 앱 설정은 첫 등록 때 라우터를 만들며 읽으므로 그 전에 바꾼 값만 쓴다.
 */

import ts from 'typescript';

import type { HttpMethod, RouteDeclMethod } from '../../exchange/bridge-facts.ts';
import { compileExpress4Path } from './express4-path.ts';
import { eventsByInstance, type FlatProvided, type FlatRoute, type FrameworkRoutes, type OrderCounter, partitionEvents, takeOrder } from './flat-route.ts';
import { instanceGroupName } from './group-name.ts';
import { classifyPackageMiddleware } from './middleware-packages.ts';
import type { NodeProject } from './node-project.ts';
import { type CompiledPath, isRootVariant, joinVariants, type PathVariant, prefixTemplates, ROOT_VARIANT, templateOf } from './path-model.ts';
import { compilePte8Path } from './pte8-path.ts';
import type { FrameworkAdapter, InstanceSpec, InterpreterContext } from './router-interpreter.ts';
import type { EventSite, Frame, MountEvent, PathArgument, ProvidedEvent, RouteEvent, RouterEvent, RouterInstance, RouterTarget, SettingEvent } from './router-model.ts';
import { calleeFromPackage, packageBindingOf, unwrap } from './symbols.ts';

/** Express가 method 멤버로 만드는 동사(`methods` 패키지·Node `http.METHODS`)다. */
const EXPRESS_VERBS = new Set([
  'get', 'post', 'put', 'head', 'delete', 'options', 'trace', 'copy', 'lock', 'mkcol', 'move', 'purge', 'propfind', 'proppatch',
  'unlock', 'report', 'mkactivity', 'checkout', 'merge', 'm-search', 'notify', 'subscribe', 'unsubscribe', 'patch', 'search',
  'connect', 'acl', 'bind', 'link', 'mkcalendar', 'query', 'rebind', 'source', 'unbind', 'unlink',
]);

/** 계약 method다. */
const CONTRACT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'HEAD']);

/** 라우팅 설정 키다. */
const ROUTING_SETTINGS = new Set(['strict routing', 'case sensitive routing']);

/** Express 어댑터다. */
export const expressAdapter: FrameworkAdapter = {
  framework: 'express',
  memberNames: new Set([...EXPRESS_VERBS, 'all', 'use', 'route', 'set', 'enable', 'disable']),
  creation: expressCreation,
  chain: expressChain,
  record: expressRecord,
  opaque: expressOpaque,
};

/**
 * `express()`·`express.Router(options)`·`Router(options)`이면 명세를 만든다.
 *
 * @param node 호출·new 식
 * @param context 문맥
 * @returns 명세 또는 undefined
 */
function expressCreation(node: ts.CallExpression | ts.NewExpression, context: InterpreterContext): InstanceSpec | undefined {
  const binding = calleeFromPackage(context.checker, node.expression, ['express'], ['default', '*', 'Router']);
  if (binding === undefined) return undefined;
  if (binding.name !== 'Router') return ts.isCallExpression(node) ? { kind: 'app', options: { strict: false, caseSensitive: false } } : undefined;
  const options = node.arguments?.[0];
  const frame = context.moduleFrame(node.getSourceFile());
  return {
    kind: 'router',
    options: { strict: context.booleanOption(options, 'strict', frame, false), caseSensitive: context.booleanOption(options, 'caseSensitive', frame, false) },
  };
}

/**
 * 멤버 호출이 돌려주는 대상이다. 등록·설정 멤버는 같은 대상, `route(path)`는 route 빌더다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param frame 프레임
 * @param context 문맥
 * @returns 대상 목록
 */
function expressChain(target: RouterTarget, member: string, call: ts.CallExpression, frame: Frame, context: InterpreterContext): readonly RouterTarget[] {
  if (target.routePath !== undefined) return EXPRESS_VERBS.has(member) || member === 'all' ? [target] : [];
  if (member === 'route') {
    const argument = call.arguments[0];
    const routePath: PathArgument = { value: argument === undefined ? { kind: 'unknown' } : context.resolvePath(argument, frame), node: argument ?? call };
    return [{ instance: target.instance, basePaths: [], routePath, routeNode: call }];
  }
  if (member === 'get' && call.arguments.length === 1) return [];
  return expressAdapter.memberNames.has(member) ? [target] : [];
}

/**
 * 멤버 호출을 사건으로 기록한다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function expressRecord(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  if (target.routePath !== undefined) {
    if (EXPRESS_VERBS.has(member) || member === 'all') recordRouteBuilder(target, member, call, site, context);
    return;
  }
  if (EXPRESS_VERBS.has(member) || member === 'all') return recordVerb(target, member, call, site, context);
  if (member === 'use') return recordUse(target, call, site, context);
  if (member === 'set' || member === 'enable' || member === 'disable') recordSetting(target, member, call, site, context);
}

/**
 * 동사 멤버 이름을 계약 method로 바꾼다.
 *
 * @param member 멤버 이름
 * @returns 계약 method와 비표준 동사
 */
function methodOf(member: string): { methods: RouteDeclMethod[]; unsupported: string[] } {
  if (member === 'all') return { methods: ['ANY'], unsupported: [] };
  const verb = member.toUpperCase();
  return CONTRACT_METHODS.has(verb) ? { methods: [verb as RouteDeclMethod], unsupported: [] } : { methods: [], unsupported: [verb] };
}

/**
 * `app.get(path, ...handlers)` 류를 기록한다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordVerb(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  if (member === 'get' && call.arguments.length === 1) return;
  const [pathArgument, ...rest] = call.arguments;
  const handler = lastFunction(rest);
  if (pathArgument === undefined || handler === undefined) return;
  const { methods, unsupported } = methodOf(member);
  context.emit({
    kind: 'route',
    target,
    methods,
    unsupportedMethods: unsupported,
    paths: context.resolvePaths(pathArgument, site.frame),
    handler: context.resolveHandler(handler, site.frame, 2, call),
    narrowed: false,
    methodDynamic: false,
    site,
    registrationNode: call,
  });
}

/**
 * `route(path).get(h)` 빌더의 method를 기록한다. 같은 route의 method는 `route()` 호출 하나(한 등록)에 묶는다.
 *
 * @param target route 빌더 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordRouteBuilder(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const handler = lastFunction(call.arguments);
  if (handler === undefined) return;
  const { methods, unsupported } = methodOf(member);
  context.emit({
    kind: 'route',
    target: { instance: target.instance, basePaths: [] },
    methods,
    unsupportedMethods: unsupported,
    paths: [target.routePath!],
    handler: context.resolveHandler(handler, site.frame, 2, call),
    narrowed: false,
    methodDynamic: false,
    site: { ...site, position: routeBuilderPosition(target, site) },
    registrationNode: target.routeNode!,
  });
}

/**
 * route 빌더 method의 위치다. 레이어는 `route()`가 스택에 넣으므로 같은 뿌리면 그 호출 위치를 쓴다.
 *
 * @param target route 빌더 대상
 * @param site method 호출 위치
 * @returns 위치
 */
function routeBuilderPosition(target: RouterTarget, site: EventSite): readonly number[] {
  return [...site.frame.timeline, target.routeNode!.getEnd()];
}

/**
 * 인자 목록에서 마지막 핸들러 식을 찾는다(배열 인자는 펼친다).
 *
 * @param args 인자
 * @returns 핸들러 식 또는 undefined
 */
function lastFunction(args: readonly ts.Expression[]): ts.Expression | undefined {
  const flat = args.flatMap((argument) => {
    const node = unwrap(argument);
    return ts.isArrayLiteralExpression(node) ? node.elements.filter((element) => !ts.isSpreadElement(element)) : [argument];
  });
  const last = flat.at(-1);
  return last === undefined || ts.isSpreadElement(last) ? undefined : last;
}

/**
 * `use(path?, ...fns)`를 기록한다: 라우터·앱은 mount, 정적 파일은 GET·HEAD 제공 경로, 패키지 미들웨어는 분류,
 * `next`를 받지 않는 프로젝트 함수는 끝이 열린 라우트, 나머지는 넘기는 미들웨어다.
 *
 * @param target 대상
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordUse(target: RouterTarget, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [first] = call.arguments;
  if (first === undefined) return;
  const hasPath = context.isPathArgument(first, site.frame, call.arguments.length >= 2);
  const prefixes: (PathArgument | undefined)[] = hasPath ? context.resolvePaths(first, site.frame) : [undefined];
  const functions = call.arguments.slice(hasPath ? 1 : 0).flatMap((argument) => {
    const node = unwrap(argument);
    return ts.isArrayLiteralExpression(node) ? node.elements.filter((element): element is ts.Expression => !ts.isSpreadElement(element)) : [argument];
  });
  for (const prefix of prefixes) {
    for (const fn of functions) recordUseFunction(target, prefix, fn, call, site, context);
  }
}

/**
 * `use()` 함수 인자 하나를 기록한다.
 *
 * @param target 대상
 * @param prefix 경로 인자(없으면 `/`)
 * @param fn 함수 인자
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordUseFunction(target: RouterTarget, prefix: PathArgument | undefined, fn: ts.Expression, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const children = context.resolveTargets(fn, site.frame).filter((child) => child.instance.framework === 'express' && child.routePath === undefined && child.instance !== target.instance);
  if (children.length > 0) {
    context.emit({ kind: 'mount', target, prefix, children, unresolved: false, mode: 'reference', site });
    return;
  }
  const binding = packageMiddlewareBinding(fn, context);
  if (binding !== undefined) {
    const classified = classifyPackageMiddleware(binding.module, binding.name);
    if (classified.kind === 'pass-through') context.emit({ kind: 'middleware', target, site });
    else emitProvided(target, prefix, classified.kind === 'static' ? ['GET', 'HEAD'] : undefined, classified.description, site, context);
    return;
  }
  const handler = context.resolveHandler(fn, site.frame, 2, call);
  if (handler.usr === undefined && prefix !== undefined) {
    // 경로를 붙여 넘긴 값을 풀지 못했다: 라우터일 수 있으므로 그 접두사 아래를 모델링하지 못한 것으로 알린다.
    context.emit({ kind: 'provided', target, prefix, methods: undefined, prefixKind: 'route-coverage', description: 'a value passed to use() with a path that tsograph could not resolve (a router or middleware)', site });
    return;
  }
  if (handler.usr === undefined || handler.mayCallNext || isErrorHandler(fn, site.frame, context)) {
    if (!isErrorHandler(fn, site.frame, context)) context.emit({ kind: 'middleware', target, site });
    return;
  }
  if (setsNotFound(fn, site.frame, context)) return;
  const path: PathArgument = prefix ?? { value: { kind: 'literal', text: '/' }, node: call };
  context.emit({ kind: 'route', target, methods: ['ANY'], unsupportedMethods: [], paths: [path], handler, narrowed: false, methodDynamic: false, site, registrationNode: call, openEnded: true });
}

/**
 * 제공 경로 사건을 만든다.
 *
 * @param target 대상
 * @param prefix 경로 인자
 * @param methods 받을 수 있는 method
 * @param description 설명
 * @param site 위치
 * @param context 문맥
 */
function emitProvided(target: RouterTarget, prefix: PathArgument | undefined, methods: readonly HttpMethod[] | undefined, description: string, site: EventSite, context: InterpreterContext): void {
  const path = prefix ?? { value: { kind: 'literal' as const, text: '/' }, node: site.node };
  context.emit({ kind: 'provided', target, prefix: path, methods, prefixKind: 'framework-provided-routes', description, site });
}

/**
 * 미들웨어 식이 패키지에서 온 것이면 그 바인딩이다(`cors()`, `express.json()`, `helmet`).
 *
 * @param fn 미들웨어 식
 * @param context 문맥
 * @returns 바인딩 또는 undefined
 */
function packageMiddlewareBinding(fn: ts.Expression, context: InterpreterContext): { module: string; name: string } | undefined {
  const node = unwrap(fn);
  const callee = ts.isCallExpression(node) ? node.expression : node;
  const binding = packageBindingOf(context.checker, callee);
  if (binding !== undefined) return binding;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const base = packageBindingOf(context.checker, node.expression.expression);
    if (base !== undefined) return { module: base.module, name: node.expression.name.text };
  }
  return undefined;
}

/**
 * 오류 처리 미들웨어(매개변수 넷, `(err, req, res, next)`)인지 본다. 보통 요청에는 호출되지 않는다.
 *
 * @param fn 함수 식
 * @param frame 프레임
 * @param context 문맥
 * @returns 오류 처리기면 true
 */
function isErrorHandler(fn: ts.Expression, frame: Frame, context: InterpreterContext): boolean {
  const found = context.resolveFunction(fn, frame);
  return found !== undefined && found.node.parameters.length === 4;
}

/**
 * 함수 본문이 404 응답을 만드는지 본다(`res.status(404)`, `res.sendStatus(404)`, `statusCode = 404`). 끝에 붙인 "찾지 못함"
 * 처리기는 선언 없는 경로를 받는 라우트가 아니라서 decl로 내지 않는다(문서화한 결정).
 *
 * @param fn 함수 식
 * @param frame 프레임
 * @param context 문맥
 * @returns 404 처리기면 true
 */
function setsNotFound(fn: ts.Expression, frame: Frame, context: InterpreterContext): boolean {
  const found = context.resolveFunction(fn, frame);
  if (found === undefined) return false;
  let hit = false;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (ts.isNumericLiteral(node) && node.text === '404') hit = true;
    ts.forEachChild(node, visit);
  };
  visit(found.node);
  return hit;
}

/**
 * `app.set('strict routing', true)`·`app.enable(...)`·`app.disable(...)`를 기록한다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordSetting(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [keyArgument, valueArgument] = call.arguments;
  if (keyArgument === undefined) return;
  const key = context.resolvePath(keyArgument, site.frame);
  if (key.kind !== 'literal' || !ROUTING_SETTINGS.has(key.text)) {
    if (key.kind !== 'literal') context.emit({ kind: 'setting', target, key: '*', value: undefined, site });
    return;
  }
  const value = member === 'enable' ? true : member === 'disable' ? false : valueArgument === undefined ? undefined : context.resolveBoolean(valueArgument, site.frame);
  context.emit({ kind: 'setting', target, key: key.text, value, site });
}

/**
 * 타입 주석이 Express `Router`·`Express`·`Application`인 매개변수면 붙는 위치를 모르는 라우터로 본다.
 *
 * @param parameter 매개변수
 * @param context 문맥
 * @returns 명세 또는 undefined
 */
function expressOpaque(parameter: ts.ParameterDeclaration, context: InterpreterContext): InstanceSpec | undefined {
  const type = parameter.type;
  if (type === undefined || !ts.isTypeReferenceNode(type)) return undefined;
  const name = ts.isIdentifier(type.typeName) ? type.typeName : ts.isQualifiedName(type.typeName) ? type.typeName.right : undefined;
  if (name === undefined || !['Router', 'Express', 'Application'].includes(name.text)) return undefined;
  const base = ts.isQualifiedName(type.typeName) ? type.typeName.left : type.typeName;
  const binding = packageBindingOf(context.checker, base as ts.Identifier);
  return binding?.module === 'express' ? { kind: 'opaque', options: { strict: undefined, caseSensitive: undefined } } : undefined;
}

// --- 펼치기 ---

/** 경로 문법 선택이다. */
type ExpressGrammar = 4 | 5 | undefined;

/** 펼치기 문맥이다. */
interface FlattenContext {
  readonly byInstance: ReadonlyMap<RouterInstance, readonly RouterEvent[]>;
  readonly grammar: ExpressGrammar;
  readonly routes: FlatRoute[];
  readonly provided: FlatProvided[];
  middlewareCount: number;
  readonly active: Set<RouterInstance>;
}

/** 지금까지 붙인 접두사다. */
interface Prefix {
  /** 접두사 대안(루트면 `/` 하나). 확정하지 못했으면 undefined */
  readonly variants: readonly PathVariant[] | undefined;
  /** 확정하지 못한 접두사의 증명된 앞부분 */
  readonly proven: readonly PathVariant[] | undefined;
  readonly anchor: 'root' | 'base';
  /** 지나온 라우터가 모두 대소문자를 무시하는지 */
  readonly caseInsensitive: boolean;
}

/**
 * 해석 결과에서 Express 라우트를 펼친다.
 *
 * @param project 프로젝트
 * @param instances 인스턴스
 * @param events 사건
 * @param major Express 주 버전(모르면 undefined)
 * @returns Express 추출 결과
 */
export function flattenExpress(project: NodeProject, instances: readonly RouterInstance[], events: readonly RouterEvent[], major: number | undefined): FrameworkRoutes {
  const express = instances.filter((instance) => instance.framework === 'express');
  const expressEvents = events.filter((event) => event.target.instance.framework === 'express');
  const grammar: ExpressGrammar = major === 4 || major === 5 ? major : undefined;
  const context: FlattenContext = { byInstance: eventsByInstance(expressEvents), grammar, routes: [], provided: [], middlewareCount: 0, active: new Set() };
  const mounted = new Set(expressEvents.flatMap((event) => (event.kind === 'mount' ? event.children.map((child) => child.instance) : [])));
  for (const root of express.filter((instance) => !mounted.has(instance))) {
    const counter: OrderCounter = { group: root.kind === 'opaque' ? undefined : instanceGroupName('express', project, root), next: 0, assigned: new Map() };
    const anchor = root.kind === 'app' ? 'root' : 'base';
    walkRouter(context, root, { variants: [ROOT_VARIANT], proven: undefined, anchor, caseInsensitive: true }, counter, true);
  }
  return { framework: 'express', dispatch: 'registration-order', routes: context.routes, provided: context.provided, middlewareCount: context.middlewareCount, notes: [] };
}

/**
 * 라우터 하나의 경로 옵션(strict·caseSensitive)을 정한다. 앱은 첫 등록 전에 바꾼 설정만 쓴다.
 *
 * @param instance 인스턴스
 * @param events 그 인스턴스의 사건
 * @returns 옵션(모르면 undefined 값)
 */
function routerOptions(instance: RouterInstance, events: readonly RouterEvent[]): { strict: boolean | undefined; caseSensitive: boolean | undefined } {
  const base = { strict: instance.options['strict'] as boolean | undefined, caseSensitive: instance.options['caseSensitive'] as boolean | undefined };
  if (instance.kind !== 'app') return base;
  const settings = events.filter((event): event is SettingEvent => event.kind === 'setting');
  if (settings.length === 0) return base;
  const { ordered } = partitionEvents(instance, events, undefined);
  const firstRegistration = ordered.findIndex((event) => event.kind !== 'setting');
  const early = new Set(ordered.slice(0, firstRegistration === -1 ? ordered.length : firstRegistration));
  const valueOf = (key: string, fallback: boolean | undefined): boolean | undefined => {
    const relevant = settings.filter((event) => event.key === key || event.key === '*');
    if (relevant.some((event) => !early.has(event) || event.value === undefined || event.key === '*')) return relevant.length === 0 ? fallback : undefined;
    return relevant.length === 0 ? fallback : relevant.at(-1)!.value;
  };
  return { strict: valueOf('strict routing', base.strict), caseSensitive: valueOf('case sensitive routing', base.caseSensitive) };
}

/**
 * 라우터의 사건을 순서대로 펼친다.
 *
 * @param context 펼치기 문맥
 * @param instance 라우터
 * @param prefix 붙인 접두사
 * @param counter 순서 계수기
 * @param isOrdered 순서를 이을 수 있는지
 */
function walkRouter(context: FlattenContext, instance: RouterInstance, prefix: Prefix, counter: OrderCounter, isOrdered: boolean): void {
  if (context.active.has(instance)) return;
  context.active.add(instance);
  const events = context.byInstance.get(instance) ?? [];
  const options = routerOptions(instance, events);
  const scoped: Prefix = { ...prefix, caseInsensitive: prefix.caseInsensitive && options.caseSensitive === false };
  const { ordered, unordered } = partitionEvents(instance, events, undefined);
  for (const event of ordered) handleEvent(context, event, scoped, options, counter, isOrdered);
  for (const event of unordered) handleEvent(context, event, scoped, options, counter, false);
  context.active.delete(instance);
}

/**
 * 사건 하나를 펼친다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param prefix 접두사
 * @param options 라우터 옵션
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function handleEvent(context: FlattenContext, event: RouterEvent, prefix: Prefix, options: ReturnType<typeof routerOptions>, counter: OrderCounter, isOrdered: boolean): void {
  if (event.kind === 'route') return routeEvent(context, event, prefix, options, counter, isOrdered);
  if (event.kind === 'mount') return mountEvent(context, event, prefix, counter, isOrdered);
  if (event.kind === 'provided') return context.provided.push(providedOf(context, event, prefix)), undefined;
  if (event.kind === 'middleware') context.middlewareCount += 1;
}

/**
 * 라우트 사건을 펼친다. 경로 원소 하나가 한 등록이다(route 빌더는 `route()` 호출 하나).
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param prefix 접두사
 * @param options 라우터 옵션
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function routeEvent(context: FlattenContext, event: RouteEvent, prefix: Prefix, options: ReturnType<typeof routerOptions>, counter: OrderCounter, isOrdered: boolean): void {
  const openEnded = event.openEnded === true;
  for (const [element, path] of event.paths.entries()) {
    const compiled = compileWithPrefix(context, prefix, path, options.strict ?? false, openEnded ? 'use' : 'route');
    const provable = isOrdered && !event.handler.mayCallNext && !event.site.conditional;
    context.routes.push({
      handler: event.handler,
      unsupportedMethods: event.unsupportedMethods,
      methods: event.methods,
      path: compiled.path,
      rawPath: compiled.raw,
      anchor: prefix.anchor,
      locationNode: path.node,
      order: takeOrder(counter, provable, { node: event.registrationNode, element }),
      trailingSlash: compiled.trailingSlash(options.strict),
      caseInsensitive: prefix.caseInsensitive && options.caseSensitive === false,
      narrowed: false,
      conditional: event.site.conditional,
    });
  }
}

/**
 * mount 사건을 펼친다. 붙인 라우터의 스택은 요청 시점에 걸리므로 등록 시점과 무관하게 모두 이어진다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param prefix 접두사
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function mountEvent(context: FlattenContext, event: MountEvent, prefix: Prefix, counter: OrderCounter, isOrdered: boolean): void {
  const mountPath = event.prefix ?? { value: { kind: 'literal', text: '/' }, node: event.site.node };
  const next = extendPrefix(context, prefix, mountPath);
  for (const child of event.children) walkRouter(context, child.instance, next, counter, isOrdered && !event.site.conditional);
}

/**
 * 경로 문법으로 컴파일한다. 주 버전을 모르면 두 문법이 같은 결과를 낼 때만 쓰고, 아니면 dynamic이다.
 *
 * @param grammar 문법
 * @param path 경로 문자열
 * @param strict strict 옵션
 * @returns 컴파일 결과
 */
function compileExpressPath(grammar: ExpressGrammar, path: string, strict: boolean): CompiledPath {
  if (grammar === 4) return compileExpress4Path(path, strict);
  if (grammar === 5) return compilePte8Path(path, !strict);
  const four = compileExpress4Path(path, strict);
  const five = compilePte8Path(path, !strict);
  if (JSON.stringify(four) === JSON.stringify(five)) return four;
  return { kind: 'dynamic', reason: 'unsupported-syntax', prefixes: four.kind === 'dynamic' ? four.prefixes : five.kind === 'dynamic' ? five.prefixes : undefined };
}

/**
 * 접두사에 mount 경로를 더한다.
 *
 * @param context 펼치기 문맥
 * @param prefix 접두사
 * @param mountPath mount 경로
 * @returns 새 접두사
 */
function extendPrefix(context: FlattenContext, prefix: Prefix, mountPath: PathArgument): Prefix {
  if (prefix.variants === undefined) return prefix;
  if (mountPath.value.kind === 'unknown') return { variants: [ROOT_VARIANT], proven: undefined, anchor: 'base', caseInsensitive: prefix.caseInsensitive };
  if (mountPath.value.kind === 'partial') return { variants: undefined, proven: joinAll(prefix.variants, [partialPrefix(context, mountPath.value.head)]), anchor: prefix.anchor, caseInsensitive: prefix.caseInsensitive };
  const compiled = compileExpressPath(context.grammar, mountPath.value.text, false);
  if (compiled.kind === 'dynamic') return { variants: undefined, proven: compiled.prefixes === undefined ? prefix.variants : joinAll(prefix.variants, compiled.prefixes), anchor: prefix.anchor, caseInsensitive: prefix.caseInsensitive };
  return { variants: joinAll(prefix.variants, compiled.variants), proven: undefined, anchor: prefix.anchor, caseInsensitive: prefix.caseInsensitive };
}

/**
 * 앞부분만 아는 경로의 증명된 접두사(온전한 세그먼트)다.
 *
 * @param context 펼치기 문맥
 * @param head 앞부분
 * @returns 접두사 대안
 */
function partialPrefix(context: FlattenContext, head: string): PathVariant {
  const cut = head.lastIndexOf('/');
  const complete = cut <= 0 ? '/' : head.slice(0, cut);
  const compiled = compileExpressPath(context.grammar, complete, false);
  return compiled.kind === 'variants' && compiled.variants.length === 1 ? compiled.variants[0]! : ROOT_VARIANT;
}

/**
 * 두 대안 목록의 모든 조합을 잇는다.
 *
 * @param prefixes 접두사 대안
 * @param children 자식 대안
 * @returns 이은 대안
 */
function joinAll(prefixes: readonly PathVariant[], children: readonly PathVariant[]): PathVariant[] {
  return prefixes.flatMap((prefix) => children.map((child) => joinVariants(prefix, child)));
}

/** 접두사를 붙여 컴파일한 결과다. */
interface JoinedCompile {
  readonly path: CompiledPath;
  readonly raw: string;
  /** 라우터 strict 옵션으로 끝 슬래시 규칙을 정한다 */
  trailingSlash(strict: boolean | undefined): 'strict' | 'optional' | undefined;
}

/**
 * 접두사와 라우트 경로를 이어 컴파일한다.
 *
 * @param context 펼치기 문맥
 * @param prefix 접두사
 * @param path 라우트 경로 인자
 * @param strict 라우터 strict 옵션
 * @param mode 라우트(끝 고정) 또는 끝이 열린 use 레이어
 * @returns 결과
 */
function compileWithPrefix(context: FlattenContext, prefix: Prefix, path: PathArgument, strict: boolean, mode: 'route' | 'use'): JoinedCompile {
  const known = prefix.variants ?? prefix.proven;
  const lead = (known === undefined || known.every(isRootVariant) ? '' : templateOf(known[0]!)) + (prefix.variants === undefined ? '/{dynamic}' : '');
  const raw = lead + (path.value.kind === 'literal' ? path.value.text : path.value.kind === 'partial' ? `${path.value.head}{dynamic}` : '{dynamic}');
  const unknownTrailing = (): undefined => undefined;
  if (prefix.variants === undefined) return { path: { kind: 'dynamic', reason: 'non-literal', prefixes: prefix.proven }, raw, trailingSlash: unknownTrailing };
  if (path.value.kind !== 'literal') {
    const head = path.value.kind === 'partial' ? partialPrefix(context, path.value.head) : ROOT_VARIANT;
    return { path: { kind: 'dynamic', reason: 'non-literal', prefixes: joinAll(prefix.variants, [head]) }, raw, trailingSlash: unknownTrailing };
  }
  const compiled = compileExpressPath(context.grammar, path.value.text, mode === 'use' ? false : strict);
  if (compiled.kind === 'dynamic') {
    return { path: { ...compiled, prefixes: compiled.prefixes === undefined ? undefined : joinAll(prefix.variants, compiled.prefixes) }, raw, trailingSlash: unknownTrailing };
  }
  const childIsRoot = compiled.variants.every(isRootVariant);
  const variants = joinAll(prefix.variants, mode === 'use' ? compiled.variants.flatMap(openEndedVariants) : compiled.variants);
  const prefixIsRoot = prefix.variants.every(isRootVariant);
  return {
    path: { kind: 'variants', variants },
    raw,
    // 붙인 경로 아래 `/` 라우트는 붙인 경로 자체와 끝 슬래시 형태 모두와 맞는다(strict라도 `slashAdded`). use 레이어는
    // 라우터 strict와 무관하게 strict 꺼짐으로 컴파일한다.
    trailingSlash: (routerStrict) => ((childIsRoot && !prefixIsRoot) || mode === 'use' ? 'optional' : routerStrict === undefined ? undefined : routerStrict ? 'strict' : 'optional'),
  };
}

/**
 * 끝이 열린 use 레이어의 대안(경로 자체와 그 아래 전부)이다.
 *
 * @param variant 경로 대안
 * @returns 대안 목록
 */
function openEndedVariants(variant: PathVariant): PathVariant[] {
  const base = isRootVariant(variant) ? [] : variant.segments;
  return [{ segments: [...base, { kind: 'catch-all', zeroSegments: true, acceptsEmpty: false }] }];
}

/**
 * 제공 사건을 요청 경로 상한으로 바꾼다.
 *
 * @param context 펼치기 문맥
 * @param event 제공 사건
 * @param prefix 접두사
 * @returns 펼친 제공 경로
 */
function providedOf(context: FlattenContext, event: ProvidedEvent, prefix: Prefix): FlatProvided {
  const base = { prefixKind: event.prefixKind, description: event.description };
  const extended = extendPrefix(context, prefix, event.prefix ?? { value: { kind: 'literal', text: '/' }, node: event.site.node });
  if (extended.anchor !== 'root') return { ...base, scope: undefined };
  const prefixes = prefixTemplates(extended.variants ?? extended.proven ?? []);
  if (prefixes.length === 0) return { ...base, scope: undefined };
  return { ...base, scope: { templatePrefixes: prefixes, ...(event.methods === undefined ? {} : { methods: event.methods }) } };
}
