/**
 * Koa + @koa/router(koa-router) 라우트 등록을 해석하고 mount를 펼친다.
 *
 * 확인한 @koa/router@15.7.0(`dist/index.js`, path-to-regexp 8)·13.1.1(path-to-regexp 6)과 koa@3.2.1 동작(오라클 실행으로
 * 재확인):
 * - `router.METHOD([name,] path, ...middleware)`: 둘째 인자가 문자열·정규식이면 첫 인자는 이름이다. 배열 경로는 레이어를
 *   여럿 만든다. GET 레이어는 HEAD도 받는다. `all`은 Node `http.METHODS` 전부다. 레이어 경로는 등록 시점에 라우터
 *   `prefix`를 붙인다(`/` 경로는 strict가 아니면 접두사만).
 * - `router.routes()` 미들웨어는 경로와 method가 맞는 레이어를 **스택 순서**로 합성한다. 핸들러가 `next`를 부르지 않으면
 *   뒤 레이어는 돌지 않는다 — 둘째 매개변수(`next`)가 있는 핸들러에는 `order`를 싣지 않는다. 맞는 route가 없으면 다음 앱
 *   미들웨어로 넘어가므로 앱의 `use` 순서가 라우터 사이 순서다.
 * - `router.use([path], nested.routes())`는 **호출 시점의** 중첩 라우터 스택을 복제해 접두사를 붙인다(복사 mount).
 * - `exclusive` 라우터는 맞는 레이어 중 하나만 돌려 등록 순서가 아니다(순서를 싣지 않는다). `host` 옵션은 조건부다.
 * - 기본은 대소문자 무시(`sensitive: false`)·끝 슬래시 선택(`strict: false`, path-to-regexp `trailing`)이다. 끝이 `/`인 경로는
 *   그 슬래시가 필요하다(`/users/`는 `/users`와 맞지 않는다).
 */

import ts from 'typescript';

import type { HttpMethod, RouteDeclMethod } from '../../exchange/bridge-facts.ts';
import { type CopyCutoff, eventsByInstance, type FlatProvided, type FlatRoute, type FrameworkRoutes, type OrderCounter, partitionEvents, takeOrder } from './flat-route.ts';
import { instanceGroupName } from './group-name.ts';
import { classifyPackageMiddleware } from './middleware-packages.ts';
import type { NodeProject } from './node-project.ts';
import { type CompiledPath, prefixTemplates, ROOT_VARIANT } from './path-model.ts';
import { compilePte6Path } from './pte6-path.ts';
import { compilePte8Path } from './pte8-path.ts';
import type { FrameworkAdapter, InstanceSpec, InterpreterContext } from './router-interpreter.ts';
import type { EventSite, Frame, MountEvent, PathArgument, PathValue, ProvidedEvent, RouteEvent, RouterEvent, RouterInstance, RouterTarget, SettingEvent } from './router-model.ts';
import { calleeFromPackage, mayCarryRoutes, packageBindingOf, unwrap } from './symbols.ts';

/** 라우터 패키지다. */
const ROUTER_MODULES = ['@koa/router', 'koa-router'];

/** 라우터가 동사 멤버로 만드는 method(Node `http.METHODS` 소문자와 `del`)다. */
const KOA_VERBS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options', 'acl', 'bind', 'checkout', 'connect', 'copy', 'link', 'lock',
  'm-search', 'merge', 'mkactivity', 'mkcalendar', 'mkcol', 'move', 'notify', 'propfind', 'proppatch', 'purge', 'query', 'rebind',
  'report', 'search', 'source', 'subscribe', 'trace', 'unbind', 'unlink', 'unlock', 'unsubscribe',
]);

/** 계약 method다. */
const CONTRACT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'HEAD']);

/** Koa 어댑터다. */
export const koaAdapter: FrameworkAdapter = {
  framework: 'koa',
  memberNames: new Set([...KOA_VERBS, 'all', 'use', 'prefix', 'routes', 'middleware', 'redirect']),
  creation: koaCreation,
  chain: koaChain,
  record: koaRecord,
  opaque: koaOpaque,
};

/**
 * `new Koa()`·`new Router(options)`이면 명세를 만든다.
 *
 * @param node 호출·new 식
 * @param context 문맥
 * @returns 명세 또는 undefined
 */
function koaCreation(node: ts.CallExpression | ts.NewExpression, context: InterpreterContext): InstanceSpec | undefined {
  if (ts.isNewExpression(node) && calleeFromPackage(context.checker, node.expression, ['koa'], ['default', '*', 'Koa']) !== undefined) {
    // 앱 미들웨어 체인은 등록 순서로 돌고 경로 매칭이 없다.
    return { kind: 'app', options: { prefix: { kind: 'literal', text: '' }, strict: undefined, sensitive: undefined, exclusive: false, host: false } };
  }
  if (calleeFromPackage(context.checker, node.expression, ROUTER_MODULES, ['default', '*', 'Router']) === undefined) return undefined;
  const options = node.arguments?.[0];
  const frame = context.moduleFrame(node.getSourceFile());
  const prefix = options === undefined ? { kind: 'absent' as const } : context.lookupProperty(options, 'prefix', frame);
  return {
    kind: 'router',
    options: {
      prefix: prefix.kind === 'absent' ? { kind: 'literal', text: '' } : prefix.kind === 'found' ? context.resolvePath(prefix.expression, prefix.frame) : { kind: 'unknown' },
      strict: context.booleanOption(options, 'strict', frame, false),
      sensitive: context.booleanOption(options, 'sensitive', frame, false),
      exclusive: context.booleanOption(options, 'exclusive', frame, false),
      host: options !== undefined && context.lookupProperty(options, 'host', frame).kind !== 'absent',
    },
  };
}

/**
 * 멤버 호출이 돌려주는 대상이다. `routes()`·`middleware()`는 라우터를 가리키는 디스패치 미들웨어다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @returns 대상 목록
 */
function koaChain(target: RouterTarget, member: string): readonly RouterTarget[] {
  if (target.instance.kind === 'app') return member === 'use' ? [target] : [];
  return koaAdapter.memberNames.has(member) ? [target] : [];
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
function koaRecord(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  if (member === 'use') return recordUse(target, call, site, context);
  if (target.instance.kind === 'app') return;
  if (KOA_VERBS.has(member) || member === 'all') return recordVerb(target, member, call, site, context);
  if (member === 'prefix' && call.arguments[0] !== undefined) {
    context.emit({ kind: 'setting', target, key: 'prefix', value: undefined, path: { value: context.resolvePath(call.arguments[0], site.frame), node: call.arguments[0] }, site });
    return;
  }
  if (member === 'redirect' && call.arguments[0] !== undefined) {
    const handler = { usr: undefined, qualifiedName: 'koa-router#redirect', inline: false, mayCallNext: false };
    context.emit({ kind: 'route', target, methods: ['ANY'], unsupportedMethods: [], paths: context.resolvePaths(call.arguments[0], site.frame), handler, narrowed: false, methodDynamic: false, site, registrationNode: call });
  }
}

/**
 * `router.get([name,] path, ...middleware)` 류를 기록한다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordVerb(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const named = call.arguments.length >= 3 && !ts.isArrayLiteralExpression(unwrap(call.arguments[1]!)) && context.isPathArgument(call.arguments[1]!, site.frame);
  const pathArgument = call.arguments[named ? 1 : 0];
  const handler = call.arguments.slice(named ? 2 : 1).at(-1);
  // 마지막 핸들러가 펼침이면 핸들러를 모르는 선언(usr 없음, 순서 없음)으로 낸다.
  if (pathArgument === undefined || handler === undefined) return;
  const verb = member === 'del' ? 'DELETE' : member.toUpperCase();
  const methods: RouteDeclMethod[] = member === 'all' ? ['ANY'] : CONTRACT_METHODS.has(verb) ? [verb as RouteDeclMethod] : [];
  context.emit({
    kind: 'route',
    target,
    methods,
    unsupportedMethods: methods.length === 0 ? [verb] : [],
    paths: context.resolvePaths(pathArgument, site.frame),
    handler: context.resolveHandler(handler, site.frame, 1, call),
    narrowed: false,
    methodDynamic: false,
    site,
    registrationNode: call,
  });
}

/**
 * 앱·라우터의 `use()`를 기록한다: 라우터(`routes()`)는 mount, 정적 파일은 제공 경로, 패키지 미들웨어는 분류, `next`를
 * 받지 않는 프로젝트 함수는 끝이 열린 라우트, 나머지는 넘기는 미들웨어다.
 *
 * @param target 대상
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordUse(target: RouterTarget, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [first] = call.arguments;
  if (first === undefined) return;
  const isRouter = target.instance.kind !== 'app';
  const hasPath = isRouter && context.isPathArgument(first, site.frame, call.arguments.length >= 2);
  const prefixes: (PathArgument | undefined)[] = hasPath ? context.resolvePaths(first, site.frame) : [undefined];
  for (const prefix of prefixes) {
    for (const fn of call.arguments.slice(hasPath ? 1 : 0)) recordUseFunction(target, prefix, fn, call, site, context);
  }
}

/**
 * `use()` 함수 인자 하나를 기록한다.
 *
 * @param target 대상
 * @param prefix 경로 인자(없으면 전체)
 * @param fn 함수 인자
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordUseFunction(target: RouterTarget, prefix: PathArgument | undefined, fn: ts.Expression, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const children = context.resolveTargets(fn, site.frame).filter((child) => child.instance.framework === 'koa' && child.instance.kind !== 'app' && child.instance !== target.instance);
  if (children.length > 0) {
    context.emit({ kind: 'mount', target, prefix, children, unresolved: false, mode: target.instance.kind === 'app' ? 'reference' : 'copy', site });
    return;
  }
  const binding = packageMiddlewareBinding(fn, context);
  if (binding !== undefined) {
    const classified = classifyPackageMiddleware(binding.module, binding.name);
    if (classified.kind === 'pass-through') context.emit({ kind: 'middleware', target, site });
    else emitProvided(target, prefix, classified.kind === 'static' ? ['GET', 'HEAD'] : undefined, classified.description, site, context);
    return;
  }
  if (isAllowedMethods(fn, site, context)) {
    context.emit({ kind: 'middleware', target, site });
    return;
  }
  const handler = context.resolveHandler(fn, site.frame, 1, call);
  if (handler.usr === undefined && (prefix !== undefined || mayCarryRoutes(context.checker, fn))) {
    // 풀지 못한 값이 라우터일 수 있다(경로를 붙였거나, 타입이 라우터 모양·모름): 그 접두사 아래를 모델링하지 못한 것으로 알린다.
    const coveragePrefix = prefix ?? { value: { kind: 'literal', text: '/' }, node: call };
    context.emit({ kind: 'provided', target, prefix: coveragePrefix, methods: undefined, prefixKind: 'route-coverage', description: 'a value passed to use() that tsograph could not resolve (a router or middleware)', site });
    return;
  }
  if (handler.usr === undefined || handler.mayCallNext || setsNotFound(fn, site.frame, context)) {
    context.emit({ kind: 'middleware', target, site });
    return;
  }
  const path: PathArgument = prefix ?? { value: { kind: 'literal', text: '/' }, node: call };
  context.emit({ kind: 'route', target, methods: ['ANY'], unsupportedMethods: [], paths: [path], handler, narrowed: false, methodDynamic: false, site, registrationNode: call, openEnded: true });
}

/**
 * 인자가 아는 Koa 라우터의 `allowedMethods()`인지 본다. 이 미들웨어는 먼저 `next()`를 부르고, 그 라우터가 이미 맞춘
 * 경로(`ctx.matched`)에만 OPTIONS·405·501로 답하므로(@koa/router `allowedMethods`) 넘기는 미들웨어다.
 *
 * @param fn 인자 식
 * @param site 위치
 * @param context 문맥
 * @returns `allowedMethods()`면 true
 */
function isAllowedMethods(fn: ts.Expression, site: EventSite, context: InterpreterContext): boolean {
  const node = unwrap(fn);
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'allowedMethods') return false;
  return context.resolveTargets(node.expression.expression, site.frame).some((owner) => owner.instance.framework === 'koa' && owner.instance.kind !== 'app');
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
  context.emit({ kind: 'provided', target, prefix: prefix ?? { value: { kind: 'literal', text: '/' }, node: site.node }, methods, prefixKind: 'framework-provided-routes', description, site });
}

/**
 * 미들웨어 식이 패키지에서 온 것이면 그 바인딩이다.
 *
 * @param fn 미들웨어 식
 * @param context 문맥
 * @returns 바인딩 또는 undefined
 */
function packageMiddlewareBinding(fn: ts.Expression, context: InterpreterContext): { module: string; name: string } | undefined {
  const node = unwrap(fn);
  return packageBindingOf(context.checker, ts.isCallExpression(node) ? node.expression : node);
}

/**
 * 함수 본문이 404 응답을 만드는지 본다(`ctx.status = 404` 등). 끝에 붙인 "찾지 못함" 처리기는 라우트가 아니다.
 *
 * @param fn 함수 식
 * @param frame 프레임
 * @param context 문맥
 * @returns 404 처리기면 true
 */
function setsNotFound(fn: ts.Expression, frame: Frame, context: InterpreterContext): boolean {
  const found = context.resolveFunction(fn, frame);
  let hit = false;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (ts.isNumericLiteral(node) && node.text === '404') hit = true;
    ts.forEachChild(node, visit);
  };
  if (found !== undefined) visit(found.node);
  return hit;
}

/**
 * 타입 주석이 @koa/router `Router`인 매개변수면 붙는 위치를 모르는 라우터로 본다.
 *
 * @param parameter 매개변수
 * @param context 문맥
 * @returns 명세 또는 undefined
 */
function koaOpaque(parameter: ts.ParameterDeclaration, context: InterpreterContext): InstanceSpec | undefined {
  const type = parameter.type;
  if (type === undefined || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
  const binding = packageBindingOf(context.checker, type.typeName);
  if (binding === undefined || !ROUTER_MODULES.includes(binding.module)) return undefined;
  return { kind: 'opaque', options: { prefix: { kind: 'literal', text: '' }, strict: undefined, sensitive: undefined, exclusive: undefined, host: false } };
}

// --- 펼치기 ---

/** 경로 문법 선택이다. */
type KoaGrammar = 6 | 8 | undefined;

/** 펼치기 문맥이다. */
interface FlattenContext {
  readonly byInstance: ReadonlyMap<RouterInstance, readonly RouterEvent[]>;
  readonly grammar: KoaGrammar;
  readonly routes: FlatRoute[];
  readonly provided: FlatProvided[];
  middlewareCount: number;
  exclusiveRoutes: number;
  readonly active: Set<RouterInstance>;
}

/** 라우터 경로 옵션이다. */
interface RouterPolicy {
  readonly prefix: PathValue;
  readonly strict: boolean | undefined;
  readonly sensitive: boolean | undefined;
  readonly exclusive: boolean | undefined;
  /** `host` 옵션이 있으면 라우터 전체가 조건부다 */
  readonly host: boolean;
}

/** 바깥에서 붙는 접두사 조각(안쪽부터)과 앵커다. */
interface OuterPrefix {
  readonly pieces: readonly PathValue[];
  readonly anchor: 'root' | 'base';
}

/**
 * 해석 결과에서 Koa 라우트를 펼친다.
 *
 * @param project 프로젝트
 * @param instances 인스턴스
 * @param events 사건
 * @param routerMajor 라우터 주 버전(모르면 undefined)
 * @returns Koa 추출 결과
 */
export function flattenKoa(project: NodeProject, instances: readonly RouterInstance[], events: readonly RouterEvent[], routerMajor: number | undefined): FrameworkRoutes {
  const koa = instances.filter((instance) => instance.framework === 'koa');
  const koaEvents = events.filter((event) => event.target.instance.framework === 'koa');
  const grammar: KoaGrammar = routerMajor === undefined ? undefined : routerMajor >= 14 ? 8 : 6;
  const context: FlattenContext = { byInstance: eventsByInstance(koaEvents), grammar, routes: [], provided: [], middlewareCount: 0, exclusiveRoutes: 0, active: new Set() };
  const mounted = new Set(koaEvents.flatMap((event) => (event.kind === 'mount' ? event.children.map((child) => child.instance) : [])));
  for (const root of koa.filter((instance) => !mounted.has(instance))) {
    const counter: OrderCounter = { group: root.kind === 'opaque' ? undefined : instanceGroupName('koa', project, root), next: 0, assigned: new Map() };
    walkInstance(context, root, { pieces: [], anchor: root.kind === 'app' ? 'root' : 'base' }, counter, undefined, true);
  }
  const notes = context.exclusiveRoutes === 0 ? [] : [`route-dispatch-order-unknown: ${context.exclusiveRoutes} route declaration(s) belong to an exclusive @koa/router router, which runs only one matching layer instead of the registration chain`];
  return { framework: 'koa', dispatch: 'registration-order', routes: context.routes, provided: context.provided, middlewareCount: context.middlewareCount, notes };
}

/**
 * 라우터의 경로 옵션을 정한다. `prefix()` 호출이 있으면 순서를 증명한 마지막 값만 쓰고, 아니면 모른다.
 *
 * @param instance 인스턴스
 * @param events 그 인스턴스의 사건
 * @returns 옵션
 */
function policyOf(instance: RouterInstance, events: readonly RouterEvent[]): RouterPolicy {
  const settings = events.filter((event): event is SettingEvent => event.kind === 'setting' && event.key === 'prefix');
  const constructorPrefix = (instance.options['prefix'] as PathValue | undefined) ?? { kind: 'literal', text: '' };
  const { ordered } = partitionEvents(instance, settings, undefined);
  const prefix = settings.length === 0 ? constructorPrefix : ordered.length === settings.length ? (ordered.at(-1) as SettingEvent).path!.value : { kind: 'unknown' as const };
  const normalized = prefix.kind === 'literal' ? { kind: 'literal' as const, text: prefix.text.replace(/\/$/u, '') } : prefix;
  return {
    prefix: normalized,
    strict: instance.options['strict'] as boolean | undefined,
    sensitive: instance.options['sensitive'] as boolean | undefined,
    exclusive: instance.options['exclusive'] as boolean | undefined,
    host: instance.options['host'] === true,
  };
}

/**
 * 인스턴스의 사건을 순서대로 펼친다.
 *
 * @param context 펼치기 문맥
 * @param instance 인스턴스
 * @param outer 바깥 접두사
 * @param counter 순서 계수기
 * @param cutoff 복사 mount 시점 제한
 * @param isOrdered 순서를 이을 수 있는지
 */
function walkInstance(context: FlattenContext, instance: RouterInstance, outer: OuterPrefix, counter: OrderCounter, cutoff: CopyCutoff | undefined, isOrdered: boolean): void {
  if (context.active.has(instance)) return;
  context.active.add(instance);
  const events = context.byInstance.get(instance) ?? [];
  const policy = policyOf(instance, events);
  const { ordered, unordered } = partitionEvents(instance, events, cutoff);
  for (const event of ordered) handleEvent(context, event, outer, policy, counter, isOrdered);
  for (const event of unordered) handleEvent(context, event, outer, policy, counter, false);
  context.active.delete(instance);
}

/**
 * 사건 하나를 펼친다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param outer 바깥 접두사
 * @param policy 라우터 옵션
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function handleEvent(context: FlattenContext, event: RouterEvent, outer: OuterPrefix, policy: RouterPolicy, counter: OrderCounter, isOrdered: boolean): void {
  if (event.kind === 'route') return routeEvent(context, event, outer, policy, counter, isOrdered);
  if (event.kind === 'mount') return mountEvent(context, event, outer, policy, counter, isOrdered);
  if (event.kind === 'provided') return context.provided.push(providedOf(context, event, outer, policy)), undefined;
  if (event.kind === 'middleware') context.middlewareCount += 1;
}

/**
 * 라우트 사건을 펼친다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param outer 바깥 접두사
 * @param policy 라우터 옵션
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function routeEvent(context: FlattenContext, event: RouteEvent, outer: OuterPrefix, policy: RouterPolicy, counter: OrderCounter, isOrdered: boolean): void {
  if (policy.exclusive === true) context.exclusiveRoutes += event.paths.length;
  for (const [element, path] of event.paths.entries()) {
    const joined = joinKoa([path.value, policy.prefix, ...outer.pieces], policy.strict === true);
    const compiled = compileJoined(context, joined, event.openEnded === true);
    const provable = isOrdered && policy.exclusive === false && !event.handler.mayCallNext && !event.site.conditional;
    context.routes.push({
      handler: event.handler,
      unsupportedMethods: event.unsupportedMethods,
      methods: event.methods,
      path: compiled.path,
      rawPath: compiled.raw,
      anchor: outer.anchor,
      locationNode: path.node,
      order: takeOrder(counter, provable, { node: event.registrationNode, element }),
      trailingSlash: compiled.trailingSlash(policy.strict),
      caseInsensitive: policy.sensitive === false,
      narrowed: event.narrowed || policy.host,
      conditional: event.site.conditional,
    });
  }
}

/**
 * mount 사건을 펼친다. 라우터 안 중첩은 mount 시점까지 등록한 레이어만 복제하고, 앱의 `use(router.routes())`는 참조다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param outer 바깥 접두사
 * @param policy 부모 라우터 옵션
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function mountEvent(context: FlattenContext, event: MountEvent, outer: OuterPrefix, policy: RouterPolicy, counter: OrderCounter, isOrdered: boolean): void {
  const cutoff: CopyCutoff | undefined = event.mode === 'copy' ? { root: event.site.frame.root, position: event.site.position } : undefined;
  const pieces = event.target.instance.kind === 'app' ? outer.pieces : [...(event.prefix === undefined ? [] : [event.prefix.value]), policy.prefix, ...outer.pieces];
  for (const child of event.children) walkInstance(context, child.instance, { pieces, anchor: outer.anchor }, counter, cutoff, isOrdered && !event.site.conditional);
}

/**
 * 안쪽부터의 경로 조각을 @koa/router `setPrefix` 규칙으로 잇는다(`/` 경로는 strict가 아니면 접두사만).
 *
 * @param pieces 안쪽(라우트 경로)부터 바깥 접두사까지의 조각
 * @param strict 라우트를 등록한 라우터의 strict 옵션
 * @returns 이은 값
 */
function joinKoa(pieces: readonly PathValue[], strict: boolean): PathValue {
  let current = pieces[0]!;
  for (const piece of pieces.slice(1)) {
    if (piece.kind === 'unknown' || current.kind === 'unknown') return { kind: 'unknown' };
    if (piece.kind === 'partial') return { kind: 'partial', head: piece.head };
    if (piece.text === '') continue;
    if (current.kind === 'partial') current = { kind: 'partial', head: piece.text + current.head };
    else current = { kind: 'literal', text: current.text === '/' && !strict ? piece.text : piece.text + current.text };
  }
  return current;
}

/** 이어 컴파일한 결과다. */
interface JoinedCompile {
  readonly path: CompiledPath;
  readonly raw: string;
  trailingSlash(strict: boolean | undefined): 'strict' | 'optional' | undefined;
}

/**
 * 이은 경로를 문법으로 컴파일한다. 주 버전을 모르면 두 문법이 같은 결과일 때만 쓴다.
 *
 * @param context 펼치기 문맥
 * @param joined 이은 값
 * @param openEnded 끝이 열린 use 레이어인지
 * @returns 결과
 */
function compileJoined(context: FlattenContext, joined: PathValue, openEnded: boolean): JoinedCompile {
  const unknownTrailing = (): undefined => undefined;
  if (joined.kind === 'unknown') return { path: { kind: 'dynamic', reason: 'non-literal', prefixes: undefined }, raw: '{dynamic}', trailingSlash: unknownTrailing };
  if (joined.kind === 'partial') {
    const cut = joined.head.lastIndexOf('/');
    const head = cut <= 0 ? undefined : compileKoaPath(context.grammar, joined.head.slice(0, cut));
    const prefixes = head?.kind === 'variants' ? head.variants : [ROOT_VARIANT];
    return { path: { kind: 'dynamic', reason: 'non-literal', prefixes }, raw: `${joined.head}{dynamic}`, trailingSlash: unknownTrailing };
  }
  const compiled = compileKoaPath(context.grammar, openEnded ? joined.text.replace(/\/$/u, '') || '/' : joined.text);
  if (compiled.kind === 'dynamic' || !openEnded) {
    return { path: compiled, raw: joined.text, trailingSlash: (strict) => (strict === undefined ? undefined : strict || (joined.text !== '/' && joined.text.endsWith('/')) ? 'strict' : 'optional') };
  }
  const variants = compiled.variants.map((variant) => ({ segments: [...(variant.segments.length === 1 && variant.segments[0]!.kind === 'literal' && variant.segments[0]!.text === '' ? [] : variant.segments), { kind: 'catch-all' as const, zeroSegments: true, acceptsEmpty: false }] }));
  // 끝이 열린 레이어(`end: false`)는 `(?=/|$)`로 끝나 끝 슬래시 형태도 받는다.
  return { path: { kind: 'variants', variants }, raw: joined.text, trailingSlash: () => 'optional' };
}

/**
 * 라우터 주 버전의 문법으로 컴파일한다.
 *
 * @param grammar 문법
 * @param path 경로
 * @returns 컴파일 결과
 */
function compileKoaPath(grammar: KoaGrammar, path: string): CompiledPath {
  if (grammar === 6) return compilePte6Path(path);
  if (grammar === 8) return compilePte8Path(path, false);
  const six = compilePte6Path(path);
  const eight = compilePte8Path(path, false);
  if (JSON.stringify(six) === JSON.stringify(eight)) return six;
  return { kind: 'dynamic', reason: 'unsupported-syntax', prefixes: six.kind === 'dynamic' ? six.prefixes : eight.kind === 'dynamic' ? eight.prefixes : undefined };
}

/**
 * 제공 사건을 요청 경로 상한으로 바꾼다.
 *
 * @param context 펼치기 문맥
 * @param event 제공 사건
 * @param outer 바깥 접두사
 * @param policy 라우터 옵션
 * @returns 펼친 제공 경로
 */
function providedOf(context: FlattenContext, event: ProvidedEvent, outer: OuterPrefix, policy: RouterPolicy): FlatProvided {
  const base = { prefixKind: event.prefixKind, description: event.description };
  if (outer.anchor !== 'root') return { ...base, scope: undefined };
  const pieces = event.target.instance.kind === 'app' ? outer.pieces : [policy.prefix, ...outer.pieces];
  const joined = joinKoa([event.prefix?.value ?? { kind: 'literal', text: '/' }, ...pieces], false);
  const compiled = compileJoined(context, joined, false).path;
  const prefixes = prefixTemplates(compiled.kind === 'variants' ? compiled.variants : compiled.prefixes ?? []);
  if (prefixes.length === 0) return { ...base, scope: undefined };
  return { ...base, scope: { templatePrefixes: prefixes, ...(event.methods === undefined ? {} : { methods: event.methods }) } };
}
