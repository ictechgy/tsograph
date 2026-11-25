/**
 * Fastify 4·5 라우트 등록을 해석하고 플러그인 접두사를 펼친다.
 *
 * 확인한 fastify@4.29.1·5.12.5(`lib/route.js`, 5 `lib/plugin-override.js`·4 `lib/pluginOverride.js`)와 find-my-way@8.2.2·9.9.0
 * 동작(오라클 실행으로 재확인):
 * - `fastify.METHOD(url, [options], handler)`·`fastify.route({method, url, handler})`가 라우트다. `all`은 지원 method 전부다.
 *   GET 라우트에는 HEAD 라우트가 자동으로 붙는다(`exposeHeadRoutes`, decl로 내지 않는다).
 * - `register(plugin, {prefix})`는 새 캡슐화 인스턴스를 만들어 접두사를 `buildRoutePrefix`로 잇는다(부모가 `/`로 끝날 때의
 *   이음은 주 버전마다 다르다). `fastify-plugin`으로 감싸거나 `Symbol.for('skip-override')`를 쓴 플러그인은 부모 인스턴스를 그대로
 *   쓰고 접두사를 무시한다(`fastify-skip-override.ts`).
 * - 타입 주석으로만 아는 `FastifyInstance`는 붙는 위치를 모르므로 base 앵커이고, 그 아래 리터럴 접두사는 base 뒤 꼬리로 잇는다.
 * - 접두사 아래 `/` 라우트는 기본(`prefixTrailingSlash: 'both'`)으로 `prefix`와 `prefix/` 둘 다 등록한다.
 * - find-my-way는 정적 > 파라미터 > 와일드카드 순으로 고르므로 문서는 `specificity`다. `constraints`(version·host)는 조건부다.
 * - `caseSensitive: false`면 대소문자 무시, `ignoreTrailingSlash`면 끝 슬래시 선택이다. fastify 5는 `routerOptions` 값이 우선이고
 *   fastify 4는 `routerOptions`를 읽지 않는다.
 */

import ts from 'typescript';

import type { HttpMethod, PathAnchor, RouteDeclMethod } from '../../exchange/bridge-facts.ts';
import { skipOverrideOf } from './fastify-skip-override.ts';
import { eventsByInstance, type FlatProvided, type FlatRoute, type FrameworkRoutes } from './flat-route.ts';
import { compileFindMyWayPath, type FindMyWayOptions } from './fmw-path.ts';
import type { NodeProject } from './node-project.ts';
import { type CompiledPath, prefixTemplates } from './path-model.ts';
import type { FrameworkAdapter, InstanceSpec, InterpreterContext } from './router-interpreter.ts';
import type { EventSite, Frame, PathArgument, PathValue, ProvidedEvent, RouteEvent, RouterEvent, RouterInstance, RouterTarget } from './router-model.ts';
import { calleeFromPackage, packageBindingOf, resolveAlias, symbolAt, unwrap } from './symbols.ts';
import type { PropertyLookup } from './value-resolver.ts';

/** 경로를 받는 단축 method다. */
const SHORTHAND = new Set(['get', 'head', 'post', 'put', 'delete', 'options', 'patch', 'all']);

/** 계약 method다. */
const CONTRACT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'HEAD']);

/** 라우트를 만들지 않는다고 보는 공식·흔한 플러그인이다(공개 문서의 용도 기준). */
const ROUTE_FREE_PLUGINS = new Set([
  '@fastify/accepts', '@fastify/auth', '@fastify/bearer-auth', '@fastify/caching', '@fastify/circuit-breaker', '@fastify/compress',
  '@fastify/cookie', '@fastify/csrf-protection', '@fastify/env', '@fastify/etag', '@fastify/formbody', '@fastify/helmet',
  '@fastify/jwt', '@fastify/mongodb', '@fastify/multipart', '@fastify/mysql', '@fastify/postgres', '@fastify/rate-limit',
  '@fastify/redis', '@fastify/request-context', '@fastify/sensible', '@fastify/session', '@fastify/secure-session',
  '@fastify/swagger', '@fastify/under-pressure', '@fastify/websocket',
]);

/** Fastify 어댑터다. */
export const fastifyAdapter: FrameworkAdapter = {
  framework: 'fastify',
  memberNames: new Set([...SHORTHAND, 'route', 'register']),
  creation: fastifyCreation,
  chain: (target, member) => (fastifyAdapter.memberNames.has(member) ? [target] : []),
  record: fastifyRecord,
  opaque: fastifyOpaque,
};

/**
 * `Fastify(options)`이면 명세를 만든다.
 *
 * @param node 호출 식
 * @param context 문맥
 * @returns 명세 또는 undefined
 */
function fastifyCreation(node: ts.CallExpression | ts.NewExpression, context: InterpreterContext): InstanceSpec | undefined {
  if (!ts.isCallExpression(node) || calleeFromPackage(context.checker, node.expression, ['fastify'], ['default', '*', 'fastify']) === undefined) return undefined;
  const options = node.arguments[0];
  const frame = context.moduleFrame(node.getSourceFile());
  const routerOption = (name: string, fallback: boolean): RouterOptionSources => ({
    topLevel: context.booleanOption(options, name, frame, fallback),
    routerOptions: nestedRouterOption(options, name, frame, context),
  });
  return {
    kind: 'app',
    options: {
      ignoreTrailingSlash: routerOption('ignoreTrailingSlash', false),
      ignoreDuplicateSlashes: routerOption('ignoreDuplicateSlashes', false),
      caseSensitive: routerOption('caseSensitive', true),
      prefix: { kind: 'literal', text: '' },
    },
  };
}

/**
 * 라우터 옵션 하나의 두 출처다. fastify 5는 `routerOptions`에 그 키가 있으면 그 값을, 없으면 최상위 값을 쓰고
 * (5.12.5 `lib/route.js#buildRouterOptions`), fastify 4는 `routerOptions`를 모르고 최상위 값만 쓴다(4.29.1 `fastify.js`).
 * 주 버전을 알아야 실제 값을 고를 수 있으므로 만들 때는 둘 다 담고 펼칠 때 {@link effectiveOption}으로 고른다.
 */
interface RouterOptionSources {
  /** 최상위 값(없으면 기본값, 모르면 undefined) */
  readonly topLevel: boolean | undefined;
  /** `routerOptions` 안의 값. `'absent'`는 그 키(또는 `routerOptions`)가 없다는 뜻, undefined는 값을 모른다는 뜻이다 */
  readonly routerOptions: boolean | undefined | 'absent';
}

/**
 * `routerOptions.<name>`을 읽는다.
 *
 * @param options `Fastify()`의 첫 인자
 * @param name 옵션 이름
 * @param frame 프레임
 * @param context 문맥
 * @returns 값, 없으면 `'absent'`, 모르면 undefined
 */
function nestedRouterOption(options: ts.Expression | undefined, name: string, frame: Frame, context: InterpreterContext): boolean | undefined | 'absent' {
  const routerOptions = options === undefined ? { kind: 'absent' as const } : context.lookupProperty(options, 'routerOptions', frame);
  if (routerOptions.kind !== 'found') return routerOptions.kind === 'absent' ? 'absent' : undefined;
  const nested = context.lookupProperty(routerOptions.expression, name, routerOptions.frame);
  if (nested.kind !== 'found') return nested.kind === 'absent' ? 'absent' : undefined;
  return context.resolveBoolean(nested.expression, nested.frame);
}

/**
 * 주 버전에 맞는 라우터 옵션 값이다. 4는 최상위 값, 5는 `routerOptions` 값이 있으면 그 값이다. 주 버전을 모르면 두 값이 같을 때만
 * 그 값이고 다르면 모른다(undefined) — fastify 4에서 `routerOptions.ignoreDuplicateSlashes`를 믿으면 실제로 등록되는 `/v1//bare`를
 * `/v1/bare`로 내게 된다.
 *
 * @param sources 옵션 출처(타입으로만 아는 인스턴스면 undefined)
 * @param grammar 주 버전
 * @returns 값 또는 undefined
 */
function effectiveOption(sources: unknown, grammar: PrefixGrammar): boolean | undefined {
  if (sources === undefined) return undefined;
  const { topLevel, routerOptions } = sources as RouterOptionSources;
  const fastify5 = routerOptions === 'absent' ? topLevel : routerOptions;
  if (grammar === 4) return topLevel;
  if (grammar === 5) return fastify5;
  return topLevel === fastify5 ? topLevel : undefined;
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
function fastifyRecord(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  if (SHORTHAND.has(member)) return recordShorthand(target, member, call, site, context);
  if (member === 'route' && call.arguments[0] !== undefined) return recordRouteOptions(target, call.arguments[0], call, site, context);
  if (member === 'register' && call.arguments[0] !== undefined) recordRegister(target, call, site, context);
}

/**
 * `fastify.get(url, [options], handler)`를 기록한다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordShorthand(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [urlArgument, second, third] = call.arguments;
  if (urlArgument === undefined || second === undefined) return;
  const options = third === undefined ? (isFunctionArgument(second, site.frame, context) ? undefined : second) : second;
  const handler = third ?? (options === undefined ? second : propertyExpression(context.lookupProperty(options, 'handler', site.frame)));
  const verb = member.toUpperCase();
  emitRoute(target, member === 'all' ? ['ANY'] : [verb], { value: context.resolvePath(urlArgument, site.frame), node: urlArgument }, options, handler, call, site, context);
}

/**
 * `fastify.route({method, url, handler})`를 기록한다.
 *
 * @param target 대상
 * @param options 옵션 객체 식
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordRouteOptions(target: RouterTarget, options: ts.Expression, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const method = context.lookupProperty(options, 'method', site.frame);
  const url = firstFound(context.lookupProperty(options, 'url', site.frame), context.lookupProperty(options, 'path', site.frame));
  const verbs = method.kind === 'found' ? context.resolvePaths(method.expression, method.frame).map((entry) => (entry.value.kind === 'literal' ? entry.value.text.toUpperCase() : undefined)) : [undefined];
  const path: PathArgument = url.kind === 'found' ? { value: context.resolvePath(url.expression, url.frame), node: url.expression } : { value: { kind: 'unknown' }, node: call };
  const dynamicMethod = verbs.includes(undefined);
  emitRoute(target, dynamicMethod ? ['ANY'] : (verbs as string[]), path, options, propertyExpression(context.lookupProperty(options, 'handler', site.frame)), call, site, context, dynamicMethod);
}

/**
 * 두 조회 중 찾은 쪽을 고른다.
 *
 * @param first 첫 조회
 * @param second 둘째 조회
 * @returns 조회 결과
 */
function firstFound(first: PropertyLookup, second: PropertyLookup): PropertyLookup {
  return first.kind === 'found' ? first : second.kind === 'found' ? second : first.kind === 'unknown' ? first : second;
}

/**
 * 조회 결과의 값 식이다.
 *
 * @param lookup 조회 결과
 * @returns 식 또는 undefined
 */
function propertyExpression(lookup: PropertyLookup): ts.Expression | undefined {
  return lookup.kind === 'found' ? lookup.expression : undefined;
}

/**
 * 인자가 함수(핸들러)인지 본다.
 *
 * @param argument 인자
 * @param frame 프레임
 * @param context 문맥
 * @returns 함수면 true
 */
function isFunctionArgument(argument: ts.Expression, frame: Frame, context: InterpreterContext): boolean {
  const node = unwrap(argument);
  if (ts.isObjectLiteralExpression(node)) return false;
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || context.resolveFunction(node, frame) !== undefined || context.lookupProperty(node, 'handler', frame).kind === 'unknown';
}

/**
 * 라우트 사건을 만든다. 옵션의 `constraints`는 조건부 표식이고 `prefixTrailingSlash`는 접두사 아래 `/` 등록 방식이다.
 *
 * @param target 대상
 * @param verbs 대문자 동사(ANY 포함)
 * @param path 경로 인자
 * @param options 옵션 객체 식
 * @param handler 핸들러 식
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 * @param methodDynamic method를 모르는지
 */
function emitRoute(target: RouterTarget, verbs: readonly string[], path: PathArgument, options: ts.Expression | undefined, handler: ts.Expression | undefined, call: ts.CallExpression, site: EventSite, context: InterpreterContext, methodDynamic = false): void {
  const methods = verbs.filter((verb) => verb === 'ANY' || CONTRACT_METHODS.has(verb)) as RouteDeclMethod[];
  const constraints = options === undefined ? { kind: 'absent' as const } : context.lookupProperty(options, 'constraints', site.frame);
  const prefixTrailingSlash = options === undefined ? { kind: 'absent' as const } : context.lookupProperty(options, 'prefixTrailingSlash', site.frame);
  const handlerInfo = handler === undefined
    ? { usr: undefined, qualifiedName: `${context.project.pathOf(call.getSourceFile()) ?? ''}#route`, inline: false, mayCallNext: false }
    : context.resolveHandler(handler, site.frame, 99, call);
  const event: RouteEvent & { prefixTrailingSlash?: PathValue } = {
    kind: 'route',
    target,
    methods,
    unsupportedMethods: verbs.filter((verb) => verb !== 'ANY' && !CONTRACT_METHODS.has(verb)),
    paths: [path],
    handler: { ...handlerInfo, mayCallNext: false },
    narrowed: constraints.kind !== 'absent',
    methodDynamic,
    site,
    registrationNode: call,
    ...(prefixTrailingSlash.kind === 'found' ? { prefixTrailingSlash: context.resolvePath(prefixTrailingSlash.expression, prefixTrailingSlash.frame) } : {}),
  };
  context.emit(event);
}

/**
 * `register(plugin, options)`을 기록한다: 프로젝트 플러그인은 새 인스턴스로 본문을 걷고, 패키지 플러그인은 분류한다.
 *
 * @param target 대상
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordRegister(target: RouterTarget, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [pluginArgument, options] = call.arguments;
  const prefixLookup = options === undefined ? { kind: 'absent' as const } : context.lookupProperty(options, 'prefix', site.frame);
  const prefix: PathArgument | undefined = prefixLookup.kind === 'found' ? { value: context.resolvePath(prefixLookup.expression, prefixLookup.frame), node: prefixLookup.expression } : prefixLookup.kind === 'unknown' ? { value: { kind: 'unknown' }, node: options! } : undefined;
  const plugin = unwrapPlugin(pluginArgument!, site.frame, context);
  const inner = plugin.expression;
  const fn = inner === undefined ? undefined : context.resolveFunction(inner, plugin.frame);
  if (fn !== undefined) {
    const skip = plugin.wrapped ? 'yes' : skipOverrideOf(context, plugin.symbols, fn.node);
    const pluginPrefix = skip === 'unknown' ? unprovenPrefix(prefix) : prefix;
    const child = skip === 'yes' ? target : { instance: context.instance({ kind: 'plugin', options: { ...target.instance.options, prefix: pluginPrefix?.value ?? { kind: 'literal', text: '' } }, parent: target }, 'fastify', call, site.frame), basePaths: [] };
    if (skip !== 'yes') context.emit({ kind: 'mount', target, prefix: pluginPrefix, children: [child], unresolved: false, mode: 'reference', site });
    context.interpretFunction(fn.node, fn.frame, site, [child]);
    return;
  }
  const description = packagePluginDescription(inner ?? pluginArgument!, context);
  if (description === undefined) return;
  context.emit({ kind: 'provided', target, prefix, methods: description.methods, prefixKind: description.prefixKind, description: description.text, site });
}

/**
 * 캡슐화를 건너뛰는지 증명하지 못한 플러그인의 접두사다. 건너뛰면 `prefix`를 무시하고 아니면 붙이므로, 비어 있지 않은 접두사는
 * 값을 모르는 접두사로 바꾼다(root 앵커는 부모 접두사까지만 아는 dynamic, base 앵커는 알 수 없는 base에 합친다).
 *
 * @param prefix `register()`의 접두사 인자
 * @returns 바꾼 접두사 인자
 */
function unprovenPrefix(prefix: PathArgument | undefined): PathArgument | undefined {
  if (prefix === undefined || (prefix.value.kind === 'literal' && prefix.value.text === '')) return prefix;
  return { value: { kind: 'unknown' }, node: prefix.node };
}

/** 플러그인 식을 따라간 결과다. */
interface UnwrappedPlugin {
  /** `fastify-plugin`으로 감쌌는지 */
  readonly wrapped: boolean;
  /** 안쪽 함수 식(감싼 경우 `fp()`의 첫 인자) */
  readonly expression: ts.Expression | undefined;
  readonly frame: Frame;
  /** 따라가며 지난 식별자·속성 접근의 심볼(별칭을 푼 뒤). skip-override 쓰기를 찾는 데 쓴다 */
  readonly symbols: ReadonlySet<ts.Symbol>;
}

/**
 * 플러그인 식을 따라가 `fastify-plugin`으로 감쌌는지와 안쪽 함수 식을 찾는다(`const p = fp(async (app) => …)`도 따라간다).
 *
 * @param expression 플러그인 식
 * @param frame 프레임
 * @param context 문맥
 * @returns 감쌌는지, 안쪽 식, 평가 프레임, 지난 심볼
 */
function unwrapPlugin(expression: ts.Expression, frame: Frame, context: InterpreterContext): UnwrappedPlugin {
  const symbols = new Set<ts.Symbol>();
  let current = unwrap(expression);
  let currentFrame = frame;
  for (let depth = 0; depth < 8; depth++) {
    if (ts.isCallExpression(current) && calleeFromPackage(context.checker, current.expression, ['fastify-plugin'], ['default', '*', 'fastifyPlugin']) !== undefined) {
      return { wrapped: true, expression: current.arguments[0], frame: currentFrame, symbols };
    }
    if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) break;
    const symbol = symbolAt(context.checker, ts.isIdentifier(current) ? current : current.name);
    if (symbol !== undefined) symbols.add(resolveAlias(context.checker, symbol));
    const reference = context.resolveReference(current, currentFrame);
    if (reference === undefined) break;
    current = unwrap(reference.expression);
    currentFrame = reference.frame;
  }
  return { wrapped: false, expression, frame, symbols };
}

/**
 * 패키지 플러그인을 분류한다. 라우트를 만들지 않는 플러그인이면 undefined다.
 *
 * @param plugin 플러그인 식
 * @param context 문맥
 * @returns 제공 경로 설명 또는 undefined
 */
function packagePluginDescription(plugin: ts.Expression, context: InterpreterContext): { text: string; methods: readonly HttpMethod[] | undefined; prefixKind: ProvidedEvent['prefixKind'] } | undefined {
  const node = unwrap(plugin);
  const binding = packageBindingOf(context.checker, ts.isCallExpression(node) ? node.expression : node);
  if (binding === undefined) return { text: 'a plugin tsograph could not resolve (dynamic import or computed value)', methods: undefined, prefixKind: 'route-coverage' };
  if (ROUTE_FREE_PLUGINS.has(binding.module)) return undefined;
  if (binding.module === '@fastify/static') return { text: 'static files from @fastify/static', methods: ['GET', 'HEAD'], prefixKind: 'framework-provided-routes' };
  if (binding.module === '@fastify/cors') return { text: 'preflight responses from @fastify/cors', methods: ['OPTIONS'], prefixKind: 'framework-provided-routes' };
  if (binding.module === '@fastify/autoload') return { text: 'routes loaded from a directory by @fastify/autoload', methods: undefined, prefixKind: 'route-coverage' };
  return { text: `plugin ${binding.module}`, methods: undefined, prefixKind: 'framework-provided-routes' };
}

/**
 * 타입 주석이 `FastifyInstance`인 매개변수면 붙는 위치를 모르는 플러그인 범위로 본다.
 *
 * @param parameter 매개변수
 * @param context 문맥
 * @returns 명세 또는 undefined
 */
function fastifyOpaque(parameter: ts.ParameterDeclaration, context: InterpreterContext): InstanceSpec | undefined {
  const type = parameter.type;
  if (type === undefined || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
  const binding = packageBindingOf(context.checker, type.typeName);
  if (binding?.module !== 'fastify' || binding.name !== 'FastifyInstance') return undefined;
  return { kind: 'opaque', options: { ignoreTrailingSlash: undefined, ignoreDuplicateSlashes: undefined, caseSensitive: undefined, prefix: { kind: 'unknown' } } };
}

// --- 펼치기 ---

/** 앱 기준 라우터 옵션이다. */
interface AppOptions {
  readonly ignoreTrailingSlash: boolean | undefined;
  readonly ignoreDuplicateSlashes: boolean | undefined;
  readonly caseSensitive: boolean | undefined;
}

/** 펼치기 문맥이다. */
interface FlattenContext {
  readonly byInstance: ReadonlyMap<RouterInstance, readonly RouterEvent[]>;
  readonly routes: FlatRoute[];
  readonly provided: FlatProvided[];
  readonly active: Set<RouterInstance>;
  /** 플러그인 접두사를 잇는 규칙의 주 버전(모르면 undefined) */
  readonly grammar: PrefixGrammar;
}

/** 주 버전마다 다른 `buildRoutePrefix` 규칙이다. 확인한 4·5가 아니거나 모르면 undefined다. */
type PrefixGrammar = 4 | 5 | undefined;

/** 값을 아는(리터럴) 또는 앞부분만 아는(partial) 경로 접두사다. */
type KnownPrefix = Exclude<PathValue, { readonly kind: 'unknown' }>;

/**
 * 인스턴스가 라우트를 붙이는 경로 접두사다. 붙는 위치를 모르는 인스턴스(타입 주석으로만 아는 `FastifyInstance` 매개변수)는
 * `base` 앵커이고, `value`는 그 알 수 없는 base 뒤에 이어지는 알려진 꼬리다(처음은 빈 문자열). Express·Koa 어댑터처럼 앵커를
 * 접두사 값과 따로 들고 다녀야 base 아래 `register(plugin, { prefix: '/users' })`의 `/users`를 잃지 않는다.
 */
interface InstancePrefix {
  readonly anchor: PathAnchor;
  readonly value: KnownPrefix;
}

/**
 * 해석 결과에서 Fastify 라우트를 펼친다.
 *
 * @param _project 프로젝트
 * @param instances 인스턴스
 * @param events 사건
 * @param major Fastify 주 버전(모르면 undefined)
 * @returns Fastify 추출 결과
 */
export function flattenFastify(_project: NodeProject, instances: readonly RouterInstance[], events: readonly RouterEvent[], major: number | undefined): FrameworkRoutes {
  const fastify = instances.filter((instance) => instance.framework === 'fastify');
  const fastifyEvents = events.filter((event) => event.target.instance.framework === 'fastify');
  const grammar: PrefixGrammar = major === 4 || major === 5 ? major : undefined;
  const context: FlattenContext = { byInstance: eventsByInstance(fastifyEvents), routes: [], provided: [], active: new Set(), grammar };
  for (const root of fastify.filter((instance) => instance.kind !== 'plugin')) {
    const options: AppOptions = {
      ignoreTrailingSlash: effectiveOption(root.options['ignoreTrailingSlash'], grammar),
      ignoreDuplicateSlashes: effectiveOption(root.options['ignoreDuplicateSlashes'], grammar),
      caseSensitive: effectiveOption(root.options['caseSensitive'], grammar),
    };
    walkInstance(context, root, { anchor: root.kind === 'opaque' ? 'base' : 'root', value: { kind: 'literal', text: '' } }, options);
  }
  return { framework: 'fastify', dispatch: 'specificity', routes: context.routes, provided: context.provided, middlewareCount: 0, notes: [] };
}

/**
 * 인스턴스와 그 플러그인의 사건을 펼친다.
 *
 * @param context 펼치기 문맥
 * @param instance 인스턴스
 * @param prefix 이 인스턴스의 경로 접두사
 * @param options 앱 옵션
 */
function walkInstance(context: FlattenContext, instance: RouterInstance, prefix: InstancePrefix, options: AppOptions): void {
  if (context.active.has(instance)) return;
  context.active.add(instance);
  for (const event of context.byInstance.get(instance) ?? []) {
    if (event.kind === 'route') routeEvent(context, event, prefix, options);
    else if (event.kind === 'mount') {
      for (const child of event.children) walkInstance(context, child.instance, joinPluginPrefix(prefix, event.prefix?.value, joinGrammar(context, options)), options);
    } else if (event.kind === 'provided') {
      context.provided.push(providedOf(event, joinPluginPrefix(prefix, event.prefix?.value, joinGrammar(context, options))));
    }
  }
  context.active.delete(instance);
}

/**
 * 이 앱에서 플러그인 접두사를 잇는 규칙이다. 주 버전에 맞게 고른 `ignoreDuplicateSlashes`({@link effectiveOption})가 켜져 있으면
 * find-my-way가 등록·요청 경로의 겹친 `/`를 하나로 줄이므로 fastify 4가 더한 `/`(`/v1//bare`)도 5의 `/v1/bare`와 같은 경로가 된다
 * (fastify 4.29.1·5.12.5 실행으로 확인). fastify 4는 `routerOptions.ignoreDuplicateSlashes`를 읽지 않으므로 그 값은 여기 오지 않는다.
 *
 * @param context 펼치기 문맥
 * @param options 앱 옵션
 * @returns 이음 규칙의 주 버전
 */
function joinGrammar(context: FlattenContext, options: AppOptions): PrefixGrammar {
  return options.ignoreDuplicateSlashes === true ? 5 : context.grammar;
}

/**
 * 플러그인 접두사를 인스턴스 접두사에 잇는다. root 앵커는 {@link buildRoutePrefix} 그대로다. base 앵커 뒤에서는 이은 결과가
 * 리터럴일 때만 알려진 꼬리로 쓰고, 값을 모르는 부분이 생기면(모르거나 앞부분만 아는 플러그인 접두사, 주 버전을 몰라 정하지
 * 못한 이음) 그 부분까지 알 수 없는 base로 보아 꼬리를 비운다 — 그 뒤에 붙는 라우트 경로는 여전히 알려진 꼬리이기 때문이다.
 *
 * @param prefix 인스턴스 접두사
 * @param pluginPrefix `register()`의 `prefix` 값(없으면 undefined)
 * @param grammar 접두사를 잇는 규칙의 주 버전
 * @returns 플러그인 인스턴스의 접두사
 */
function joinPluginPrefix(prefix: InstancePrefix, pluginPrefix: PathValue | undefined, grammar: PrefixGrammar): InstancePrefix {
  const joined = buildRoutePrefix(prefix.value, pluginPrefix, grammar);
  if (prefix.anchor === 'base' && joined.kind !== 'literal') return { anchor: 'base', value: { kind: 'literal', text: '' } };
  return { anchor: prefix.anchor, value: joined };
}

/**
 * Fastify `buildRoutePrefix`를 옮긴다(`/`가 겹치거나 빠지지 않게 잇는다). 주 버전마다 다른 부분은 {@link joinPrefixText}가 정하고,
 * 주 버전을 몰라 정하지 못하면 부모 접두사까지만 아는 값이다.
 *
 * @param instancePrefix 부모 접두사
 * @param pluginPrefix 플러그인 접두사
 * @param grammar 접두사를 잇는 규칙의 주 버전
 * @returns 이은 접두사
 */
export function buildRoutePrefix(instancePrefix: KnownPrefix, pluginPrefix: PathValue | undefined, grammar: PrefixGrammar): KnownPrefix {
  if (pluginPrefix === undefined || (pluginPrefix.kind === 'literal' && pluginPrefix.text === '')) return instancePrefix;
  if (instancePrefix.kind !== 'literal') return instancePrefix;
  if (pluginPrefix.kind === 'unknown') return { kind: 'partial', head: instancePrefix.text };
  const text = pluginPrefix.kind === 'literal' ? pluginPrefix.text : pluginPrefix.head;
  const joined = joinPrefixText(instancePrefix.text, text, grammar);
  if (joined === undefined) return { kind: 'partial', head: instancePrefix.text };
  return pluginPrefix.kind === 'literal' ? { kind: 'literal', text: joined } : { kind: 'partial', head: joined };
}

/**
 * 부모 접두사 뒤에 플러그인 접두사 문자열(앞부분만 알면 그 앞부분)을 잇는다. fastify 5.12.5 `lib/plugin-override.js`는 부모가 `/`로
 * 끝나지 않을 때만 `/`로 시작하지 않는 플러그인 접두사 앞에 `/`를 더하고, fastify 4.29.1 `lib/pluginOverride.js`는 부모와 상관없이
 * 더한다. 그래서 부모가 `/`로 끝나고 플러그인 접두사가 `/` 아닌 글자로 시작할 때만 결과가 다르다(`/v1/` + `bare`는 5에서 `/v1/bare`,
 * 4에서 `/v1//bare`). 앞부분이 빈 문자열이면 첫 글자를 모르므로 두 규칙 모두 부모(`/`로 끝나지 않으면 `/`까지)만 확정한다.
 *
 * @param instance 부모 접두사
 * @param plugin 플러그인 접두사(또는 그 앞부분)
 * @param grammar 접두사를 잇는 규칙의 주 버전
 * @returns 이은 문자열. 주 버전을 몰라 두 규칙의 결과가 다르면 undefined
 */
function joinPrefixText(instance: string, plugin: string, grammar: PrefixGrammar): string | undefined {
  if (instance.endsWith('/') && plugin.startsWith('/')) return instance + plugin.slice(1);
  if (!instance.endsWith('/')) return plugin.startsWith('/') ? instance + plugin : `${instance}/${plugin}`;
  if (plugin === '' || grammar === 5) return instance + plugin;
  return grammar === 4 ? `${instance}/${plugin}` : undefined;
}

/**
 * 라우트 사건 하나를 펼친다. 접두사 아래 `/`는 `prefixTrailingSlash`에 따라 `prefix`·`prefix/`로 등록한다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param prefix 인스턴스 접두사
 * @param options 앱 옵션
 */
function routeEvent(context: FlattenContext, event: RouteEvent & { prefixTrailingSlash?: PathValue }, prefix: InstancePrefix, options: AppOptions): void {
  const path = event.paths[0]!;
  for (const url of routeUrls(prefix.value, path.value, event.prefixTrailingSlash, options)) {
    const compiled = compileUrl(url, options);
    context.routes.push({
      handler: event.handler,
      unsupportedMethods: event.unsupportedMethods,
      methods: event.methods,
      path: compiled.path,
      rawPath: compiled.raw,
      anchor: prefix.anchor,
      locationNode: path.node,
      order: undefined,
      trailingSlash: options.ignoreTrailingSlash === undefined ? undefined : options.ignoreTrailingSlash ? 'optional' : 'strict',
      caseInsensitive: options.caseSensitive === false,
      narrowed: event.narrowed,
      conditional: event.site.conditional,
    });
  }
}

/**
 * 접두사와 라우트 경로로 등록 URL 목록을 만든다(`route()`의 접두사 규칙).
 *
 * @param prefix 인스턴스 접두사
 * @param path 라우트 경로
 * @param prefixTrailingSlash `prefixTrailingSlash` 옵션
 * @param options 앱 옵션
 * @returns URL 값 목록
 */
function routeUrls(prefix: KnownPrefix, path: PathValue, prefixTrailingSlash: PathValue | undefined, options: AppOptions): PathValue[] {
  if (prefix.kind === 'partial') return [{ kind: 'partial', head: prefix.head }];
  if (path.kind !== 'literal') return [path.kind === 'partial' ? { kind: 'partial', head: joinUrl(prefix.text, path.head) } : { kind: 'partial', head: prefix.text }];
  if (path.text === '/' && prefix.text.length > 0) {
    const mode = prefixTrailingSlash === undefined ? 'both' : prefixTrailingSlash.kind === 'literal' ? prefixTrailingSlash.text : undefined;
    if (mode === 'slash') return [{ kind: 'literal', text: `${prefix.text}/` }];
    if (mode === 'no-slash') return [{ kind: 'literal', text: prefix.text }];
    if (mode !== 'both') return [{ kind: 'partial', head: prefix.text }];
    const withSlash = options.ignoreTrailingSlash !== true && (options.ignoreDuplicateSlashes !== true || !prefix.text.endsWith('/'));
    return withSlash ? [{ kind: 'literal', text: prefix.text }, { kind: 'literal', text: `${prefix.text}/` }] : [{ kind: 'literal', text: prefix.text }];
  }
  return [{ kind: 'literal', text: joinUrl(prefix.text, path.text) }];
}

/**
 * 접두사와 경로를 잇는다(`/prefix/` + `/route`는 `/prefix/route`).
 *
 * @param prefix 접두사
 * @param path 경로
 * @returns 이은 URL
 */
function joinUrl(prefix: string, path: string): string {
  return path.startsWith('/') && prefix.endsWith('/') ? prefix + path.slice(1) : prefix + path;
}

/**
 * URL 하나를 find-my-way 문법으로 컴파일한다.
 *
 * @param url URL 값
 * @param options 앱 옵션
 * @returns 컴파일 결과와 원문
 */
function compileUrl(url: PathValue, options: AppOptions): { path: CompiledPath; raw: string } {
  if (url.kind === 'unknown') return { path: { kind: 'dynamic', reason: 'non-literal', prefixes: undefined }, raw: '{dynamic}' };
  if (url.kind === 'partial') {
    const cut = url.head.lastIndexOf('/');
    const head = cut <= 0 ? '/' : url.head.slice(0, cut);
    const compiled = compileFindMyWayPath(head, fmwOptions(options));
    return { path: { kind: 'dynamic', reason: 'non-literal', prefixes: compiled.kind === 'variants' ? compiled.variants : undefined }, raw: `${url.head}{dynamic}` };
  }
  return { path: compileFindMyWayPath(url.text, fmwOptions(options)), raw: url.text };
}

/**
 * find-my-way 경로 옵션이다(모르면 끄고 본다 — 끝 슬래시 규칙은 따로 생략한다).
 *
 * @param options 앱 옵션
 * @returns 경로 옵션
 */
function fmwOptions(options: AppOptions): FindMyWayOptions {
  return { ignoreTrailingSlash: options.ignoreTrailingSlash === true, ignoreDuplicateSlashes: options.ignoreDuplicateSlashes === true };
}

/**
 * 제공 사건을 요청 경로 상한으로 바꾼다.
 *
 * @param event 제공 사건
 * @param prefix 플러그인 접두사를 이은 값
 * @returns 펼친 제공 경로
 */
function providedOf(event: ProvidedEvent, prefix: InstancePrefix): FlatProvided {
  const base = { prefixKind: event.prefixKind, description: event.description };
  // base 앵커 뒤의 경로는 root 기준 접두사로 상한을 잡을 수 없다(Express·Koa 어댑터와 같다).
  if (prefix.anchor !== 'root' || prefix.value.kind !== 'literal') return { ...base, scope: undefined };
  const text = prefix.value.text;
  const compiled = compileFindMyWayPath(text === '' ? '/' : text, { ignoreTrailingSlash: false, ignoreDuplicateSlashes: false });
  const prefixes = compiled.kind === 'variants' ? prefixTemplates(compiled.variants) : [];
  if (prefixes.length === 0) return { ...base, scope: undefined };
  return { ...base, scope: { templatePrefixes: prefixes, ...(event.methods === undefined ? {} : { methods: event.methods }) } };
}
