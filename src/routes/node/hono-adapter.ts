/**
 * Hono 4 라우트 등록을 해석하고 mount를 펼친다.
 *
 * 확인한 hono@4.13.12 동작(`dist/hono-base.js`, `dist/router/*`, 오라클 실행으로 재확인):
 * - `app.METHOD(path?, ...handlers)`는 핸들러마다 라우트를 더한다. 경로가 없으면 인스턴스의 마지막 경로를 쓴다
 *   (체인 `app.get('/a', h).post(h2)`만 따라가고, 문장을 건너면 경로를 모른다고 본다). `all`은 모든 method, `on(m, p)`는
 *   method·경로 배열을 받는다. `query`(QUERY 동사)는 계약 method가 아니다.
 * - HEAD 요청은 GET으로 디스패치한다(`#dispatch`). 그래서 `on('HEAD', …)` 라우트는 요청을 받지 않아 decl로 내지 않는다.
 * - `use(path?, ...mw)`는 method `ALL`의 미들웨어다(기본 경로 `*`). `next`를 받지 않는 함수는 요청을 끝내므로 라우트로 본다.
 * - `route(path, sub)`는 **호출 시점의** `sub.routes`를 복사한다(뒤에 sub에 등록한 라우트는 없다). `basePath(p)`는 라우터와
 *   라우트 배열을 공유하는 복제본이다. `mount(path, fn)`은 다른 앱을 `path/*`에 붙인다.
 * - 라우터(SmartRouter: RegExpRouter·TrieRouter)는 맞는 모든 핸들러를 **등록 순서**로 합성하고, 먼저 응답한 핸들러가
 *   이긴다(RegExpRouter는 겹치는 경로가 있으면 `UnsupportedPathError`로 TrieRouter에 넘긴다). 그래서 문서는
 *   `registration-order`이고 group은 요청을 받는 앱 하나다. `next`를 받는 핸들러는 요청을 넘길 수 있어 `order`를 싣지 않는다.
 * - `strict: false`면 요청 경로의 끝 슬래시 하나를 떼고 비교한다. `hono/quick`·`hono/tiny` 프리셋은 기본에서도 끝 슬래시를
 *   무시했다(오라클) — 끝 슬래시 규칙을 싣지 않는다.
 */

import ts from 'typescript';

import type { HttpMethod, RouteDeclMethod } from '../../exchange/bridge-facts.ts';
import { instanceGroupName } from './group-name.ts';
import { compileHonoPath, honoMergePath, literalPrefix } from './hono-path.ts';
import { type CopyCutoff, eventsByInstance, type FlatProvided, type FlatRoute, type FrameworkRoutes, type OrderCounter, partitionEvents, takeOrder } from './flat-route.ts';
import { type CompiledPath, prefixTemplates } from './path-model.ts';
import { joinPieces } from './path-join.ts';
import type { FrameworkAdapter, InstanceSpec, InterpreterContext } from './router-interpreter.ts';
import type { EventSite, MountEvent, PathArgument, PathValue, ProvidedEvent, RouteEvent, RouterEvent, RouterInstance, RouterTarget } from './router-model.ts';
import { calleeFromPackage, packageBindingOf, unwrap } from './symbols.ts';
import type { NodeProject } from './node-project.ts';

/** Hono 클래스를 내보내는 모듈이다. */
const HONO_MODULES = ['hono', 'hono/quick', 'hono/tiny'];

/** 경로를 받는 method 멤버다. */
const METHOD_MEMBERS = new Set(['get', 'post', 'put', 'delete', 'options', 'patch', 'query', 'all']);

/** 정적 파일 미들웨어를 내보내는 모듈이다(요청 method를 보지 않는다). */
const STATIC_MODULES = new Set(['hono/serve-static', 'hono/bun', 'hono/deno', 'hono/cloudflare-workers', '@hono/node-server/serve-static', '@hono/node-server']);

/** 계약 method 집합이다. */
const CONTRACT_METHODS = new Set<string>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'HEAD']);

/** Hono 대상의 체인 경로다(`app.get('/a', h).post(h2)`). */
interface HonoTarget extends RouterTarget {
  readonly chainPath?: PathArgument;
}

/** Hono 어댑터다. */
export const honoAdapter: FrameworkAdapter = {
  framework: 'hono',
  memberNames: new Set([...METHOD_MEMBERS, 'on', 'use', 'route', 'basePath', 'mount']),
  creation: honoCreation,
  chain: honoChain,
  record: honoRecord,
  opaque: honoOpaque,
};

/**
 * `new Hono(options)`이면 명세를 만든다.
 *
 * @param node 생성 식
 * @param context 해석 문맥
 * @returns 명세 또는 undefined
 */
function honoCreation(node: ts.CallExpression | ts.NewExpression, context: InterpreterContext): InstanceSpec | undefined {
  if (!ts.isNewExpression(node)) return undefined;
  const binding = calleeFromPackage(context.checker, node.expression, HONO_MODULES, ['Hono']);
  if (binding === undefined) return undefined;
  const options = node.arguments?.[0];
  const frame = context.moduleFrame(node.getSourceFile());
  const custom = (name: string): boolean => options !== undefined && context.lookupProperty(options, name, frame).kind !== 'absent';
  return {
    kind: 'app',
    options: {
      preset: binding.module,
      strict: context.booleanOption(options, 'strict', frame, true),
      customPath: custom('getPath') || custom('router'),
    },
  };
}

/**
 * 멤버 호출이 돌려주는 대상이다. 등록 멤버는 같은 인스턴스(체인 경로 갱신), `basePath`는 접두사를 더한 복제본이다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param frame 프레임
 * @param context 문맥
 * @returns 대상 목록
 */
function honoChain(target: RouterTarget, member: string, call: ts.CallExpression, frame: import('./router-model.ts').Frame, context: InterpreterContext): readonly RouterTarget[] {
  if (member === 'basePath') {
    const argument = call.arguments[0];
    const path: PathArgument = { value: argument === undefined ? { kind: 'unknown' } : context.resolvePath(argument, frame), node: argument ?? call };
    return [{ instance: target.instance, basePaths: [...target.basePaths, path] }];
  }
  if (!honoAdapter.memberNames.has(member)) return [];
  const chainPath = registeredPath(member, call, frame, context) ?? (target as HonoTarget).chainPath;
  return [{ ...target, ...(chainPath === undefined ? {} : { chainPath }) } as HonoTarget];
}

/**
 * 등록 호출이 인스턴스의 "마지막 경로"로 남기는 경로다.
 *
 * @param member 멤버 이름
 * @param call 호출
 * @param frame 프레임
 * @param context 문맥
 * @returns 경로 인자 또는 undefined(바꾸지 않음)
 */
function registeredPath(member: string, call: ts.CallExpression, frame: import('./router-model.ts').Frame, context: InterpreterContext): PathArgument | undefined {
  const [first, second] = call.arguments;
  if ((METHOD_MEMBERS.has(member) || member === 'use') && first !== undefined && context.isPathArgument(first, frame, call.arguments.length >= 2)) {
    return { value: context.resolvePath(first, frame), node: first };
  }
  if (member === 'on' && second !== undefined) return context.resolvePaths(second, frame).at(-1);
  return undefined;
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
function honoRecord(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  if (METHOD_MEMBERS.has(member)) return recordMethod(target, member, call, site, context);
  if (member === 'on') return recordOn(target, call, site, context);
  if (member === 'use') return recordUse(target, call, site, context);
  if (member === 'route') return recordRoute(target, call, site, context);
  if (member === 'mount') {
    const argument = call.arguments[0];
    const prefix: PathArgument | undefined = argument === undefined ? undefined : { value: context.resolvePath(argument, site.frame), node: argument };
    context.emit({ kind: 'provided', target, prefix: prefix === undefined ? undefined : wildcardPrefix(prefix), methods: undefined, prefixKind: 'route-coverage', description: 'an application attached with Hono mount()', site });
  }
}

/**
 * `app.get(path?, ...handlers)` 류를 기록한다.
 *
 * @param target 대상
 * @param member 멤버 이름
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordMethod(target: RouterTarget, member: string, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [first] = call.arguments;
  const hasPath = first !== undefined && context.isPathArgument(first, site.frame, call.arguments.length >= 2);
  const handlers = call.arguments.slice(hasPath ? 1 : 0);
  const handler = handlers.at(-1);
  if (handler === undefined || ts.isSpreadElement(handler)) return;
  const path: PathArgument = hasPath ? { value: context.resolvePath(first, site.frame), node: first } : ((target as HonoTarget).chainPath ?? { value: { kind: 'unknown' }, node: call });
  const verb = member.toUpperCase();
  emitRoute(target, verb === 'ALL' ? ['ANY'] : methodsOf([verb]), [path], handler, call, site, context);
}

/**
 * `app.on(method | methods, path | paths, ...handlers)`를 기록한다.
 *
 * @param target 대상
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordOn(target: RouterTarget, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [methodArgument, pathArgument, ...handlers] = call.arguments;
  const handler = handlers.at(-1);
  if (methodArgument === undefined || pathArgument === undefined || handler === undefined || ts.isSpreadElement(handler)) return;
  const verbs = context.resolvePaths(methodArgument, site.frame).map((entry) => (entry.value.kind === 'literal' ? entry.value.text.toUpperCase() : undefined));
  const dynamicMethod = verbs.includes(undefined);
  const known = verbs.filter((verb): verb is string => verb !== undefined && verb !== 'HEAD');
  if (!dynamicMethod && known.length === 0) return;
  const methods = dynamicMethod || known.includes('ALL') ? ['ANY' as const] : methodsOf(known);
  emitRoute(target, methods, context.resolvePaths(pathArgument, site.frame), handler, call, site, context, dynamicMethod);
}

/**
 * 동사 목록을 계약 method와 비표준 동사로 나눈다.
 *
 * @param verbs 대문자 동사
 * @returns 계약 method와 비표준 동사
 */
function methodsOf(verbs: readonly string[]): { contract: RouteDeclMethod[]; unsupported: string[] } | RouteDeclMethod[] {
  const contract = verbs.filter((verb) => CONTRACT_METHODS.has(verb)) as RouteDeclMethod[];
  const unsupported = verbs.filter((verb) => !CONTRACT_METHODS.has(verb));
  return unsupported.length === 0 ? contract : { contract, unsupported };
}

/**
 * 라우트 사건을 만든다.
 *
 * @param target 대상
 * @param methods method 목록 또는 (계약, 비표준) 쌍
 * @param paths 경로 인자
 * @param handler 핸들러 식
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 * @param methodDynamic method를 정적으로 모르는지
 */
function emitRoute(
  target: RouterTarget,
  methods: RouteDeclMethod[] | { contract: RouteDeclMethod[]; unsupported: string[] },
  paths: readonly PathArgument[],
  handler: ts.Expression,
  call: ts.CallExpression,
  site: EventSite,
  context: InterpreterContext,
  methodDynamic = false,
): void {
  const split = Array.isArray(methods) ? { contract: methods, unsupported: [] } : methods;
  context.emit({
    kind: 'route',
    target,
    methods: split.contract,
    unsupportedMethods: split.unsupported,
    paths,
    handler: context.resolveHandler(handler, site.frame, 1, call),
    narrowed: false,
    methodDynamic,
    site,
    registrationNode: call,
  });
}

/**
 * `app.use(path?, ...middleware)`를 기록한다: 정적 파일 미들웨어는 제공 경로, `next`를 받지 않는 함수는 라우트,
 * 나머지는 요청을 넘기는 미들웨어로 본다.
 *
 * @param target 대상
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordUse(target: RouterTarget, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [first] = call.arguments;
  const hasPath = first !== undefined && context.isPathArgument(first, site.frame, call.arguments.length >= 2);
  const path: PathArgument = hasPath ? { value: context.resolvePath(first, site.frame), node: first } : { value: { kind: 'literal', text: '*' }, node: call };
  for (const argument of call.arguments.slice(hasPath ? 1 : 0)) {
    if (ts.isSpreadElement(argument)) continue;
    const provided = providedMiddleware(argument, context);
    if (provided !== undefined) {
      context.emit({ kind: 'provided', target, prefix: path, methods: undefined, prefixKind: 'framework-provided-routes', description: provided, site });
      continue;
    }
    const handler = context.resolveHandler(argument, site.frame, 1, call);
    if (handler.usr !== undefined && !handler.mayCallNext) {
      context.emit({ kind: 'route', target, methods: ['ANY'], unsupportedMethods: [], paths: [path], handler, narrowed: false, methodDynamic: false, site, registrationNode: call });
    } else {
      context.emit({ kind: 'middleware', target, site });
    }
  }
}

/**
 * 제공 경로를 만드는 패키지 미들웨어(정적 파일)인지 본다.
 *
 * @param argument 미들웨어 식
 * @param context 문맥
 * @returns 설명 또는 undefined
 */
function providedMiddleware(argument: ts.Expression, context: InterpreterContext): string | undefined {
  const node = unwrap(argument);
  if (!ts.isCallExpression(node)) return undefined;
  const binding = packageBindingOf(context.checker, node.expression);
  if (binding === undefined) return undefined;
  if (STATIC_MODULES.has(binding.module) && binding.name === 'serveStatic') return `serveStatic from ${binding.module} serves files for every method`;
  return undefined;
}

/**
 * `app.route(path, sub)`를 기록한다.
 *
 * @param target 대상
 * @param call 호출
 * @param site 위치
 * @param context 문맥
 */
function recordRoute(target: RouterTarget, call: ts.CallExpression, site: EventSite, context: InterpreterContext): void {
  const [pathArgument, child] = call.arguments;
  if (pathArgument === undefined || child === undefined) return;
  const prefix: PathArgument = { value: context.resolvePath(pathArgument, site.frame), node: pathArgument };
  const children = context.resolveTargets(child, site.frame).filter((entry) => entry.instance.framework === 'hono' && entry.instance !== target.instance);
  context.emit({ kind: 'mount', target, prefix, children, unresolved: children.length === 0, mode: 'copy', site });
}

/**
 * mount 경로에 `/*`를 붙인 제공 경로 접두사를 만든다.
 *
 * @param prefix mount 경로
 * @returns 접두사 인자
 */
function wildcardPrefix(prefix: PathArgument): PathArgument {
  return prefix.value.kind === 'literal' ? { value: { kind: 'literal', text: honoMergePath(prefix.value.text, '*') }, node: prefix.node } : prefix;
}

/**
 * 타입 주석이 `Hono`인 매개변수면 붙는 위치를 모르는 라우터로 본다.
 *
 * @param parameter 매개변수
 * @param context 문맥
 * @returns 명세 또는 undefined
 */
function honoOpaque(parameter: ts.ParameterDeclaration, context: InterpreterContext): InstanceSpec | undefined {
  const type = parameter.type;
  if (type === undefined || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName)) return undefined;
  const binding = packageBindingOf(context.checker, type.typeName);
  return binding !== undefined && HONO_MODULES.includes(binding.module) && binding.name === 'Hono' ? { kind: 'opaque', options: { strict: undefined } } : undefined;
}

// --- 펼치기 ---

/** 펼치기 문맥이다. */
interface FlattenContext {
  readonly project: NodeProject;
  readonly byInstance: ReadonlyMap<RouterInstance, readonly RouterEvent[]>;
  readonly routes: FlatRoute[];
  readonly provided: FlatProvided[];
  middlewareCount: number;
  readonly active: Set<RouterInstance>;
}

/** 요청을 받는 앱 기준의 경로 규칙이다. */
interface AppPolicy {
  readonly trailingSlash: 'strict' | 'optional' | undefined;
}

/**
 * 해석 결과에서 Hono 라우트를 펼친다.
 *
 * @param project 프로젝트
 * @param instances 인스턴스
 * @param events 사건
 * @returns Hono 추출 결과
 */
export function flattenHono(project: NodeProject, instances: readonly RouterInstance[], events: readonly RouterEvent[]): FrameworkRoutes {
  const hono = instances.filter((instance) => instance.framework === 'hono');
  const honoEvents = events.filter((event) => event.target.instance.framework === 'hono');
  const context: FlattenContext = { project, byInstance: eventsByInstance(honoEvents), routes: [], provided: [], middlewareCount: 0, active: new Set() };
  const mounted = new Set(honoEvents.flatMap((event) => (event.kind === 'mount' ? event.children.map((child) => child.instance) : [])));
  for (const root of hono.filter((instance) => !mounted.has(instance))) {
    const policy: AppPolicy = { trailingSlash: trailingSlashOf(root) };
    const counter: OrderCounter = { group: root.kind === 'app' ? instanceGroupName('hono', project, root) : undefined, next: 0, assigned: new Map() };
    const anchorPieces: PathValue[] = root.kind === 'opaque' ? [{ kind: 'unknown' }] : [];
    walkInstance(context, root, anchorPieces, policy, counter, undefined, true);
  }
  return { framework: 'hono', dispatch: 'registration-order', routes: context.routes, provided: context.provided, middlewareCount: context.middlewareCount, notes: [] };
}

/**
 * 앱의 끝 슬래시 규칙이다.
 *
 * @param root 요청을 받는 인스턴스
 * @returns 규칙
 */
function trailingSlashOf(root: RouterInstance): 'strict' | 'optional' | undefined {
  if (root.kind !== 'app' || root.options['customPath'] === true || root.options['preset'] !== 'hono') return undefined;
  if (root.options['strict'] === true) return 'strict';
  return root.options['strict'] === false ? 'optional' : undefined;
}

/**
 * 인스턴스의 사건을 순서대로 펼친다.
 *
 * @param context 펼치기 문맥
 * @param instance 인스턴스
 * @param prefixes 앞 접두사 조각(mount 경로들)
 * @param policy 앱 경로 규칙
 * @param counter 순서 계수기
 * @param cutoff 복사 mount 시점 제한
 * @param isOrdered 이 인스턴스의 등록 순서를 앱 순서로 이을 수 있는지
 */
function walkInstance(
  context: FlattenContext,
  instance: RouterInstance,
  prefixes: readonly PathValue[],
  policy: AppPolicy,
  counter: OrderCounter,
  cutoff: CopyCutoff | undefined,
  isOrdered: boolean,
): void {
  if (context.active.has(instance)) return;
  context.active.add(instance);
  const { ordered, unordered } = partitionEvents(instance, context.byInstance.get(instance) ?? [], cutoff);
  for (const event of ordered) handleEvent(context, event, prefixes, policy, counter, isOrdered);
  for (const event of unordered) handleEvent(context, event, prefixes, policy, counter, false);
  context.active.delete(instance);
}

/**
 * 사건 하나를 펼친다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param prefixes 앞 접두사 조각
 * @param policy 앱 경로 규칙
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function handleEvent(context: FlattenContext, event: RouterEvent, prefixes: readonly PathValue[], policy: AppPolicy, counter: OrderCounter, isOrdered: boolean): void {
  const pieces = [...prefixes, ...event.target.basePaths.map((entry) => entry.value)];
  if (event.kind === 'route') return routeEvent(context, event, pieces, policy, counter, isOrdered);
  if (event.kind === 'mount') return mountEvent(context, event, pieces, policy, counter, isOrdered);
  if (event.kind === 'provided') return context.provided.push(providedOf(event, pieces)), undefined;
  if (event.kind === 'middleware') context.middlewareCount += 1;
}

/**
 * 라우트 사건을 경로마다 펼친다. 한 경로 원소가 한 등록(한 index)이다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param pieces 앞 접두사 조각(basePath 포함)
 * @param policy 앱 경로 규칙
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function routeEvent(context: FlattenContext, event: RouteEvent, pieces: readonly PathValue[], policy: AppPolicy, counter: OrderCounter, isOrdered: boolean): void {
  for (const [element, path] of event.paths.entries()) {
    const compiled = compileJoined([...pieces, path.value]);
    const order = takeOrder(counter, isOrdered && !event.handler.mayCallNext && !event.methodDynamic && !event.site.conditional, { node: event.registrationNode, element });
    context.routes.push({
      handler: event.handler,
      unsupportedMethods: event.unsupportedMethods,
      methods: event.methods,
      path: compiled.path,
      rawPath: compiled.raw,
      anchor: compiled.anchor,
      locationNode: path.node,
      order,
      trailingSlash: policy.trailingSlash,
      caseInsensitive: false,
      narrowed: false,
      conditional: event.site.conditional,
    });
  }
}

/**
 * mount 사건을 펼친다. 자식의 라우트는 mount 시점까지 등록한 것만 이어진다.
 *
 * @param context 펼치기 문맥
 * @param event 사건
 * @param pieces 앞 접두사 조각
 * @param policy 앱 경로 규칙
 * @param counter 순서 계수기
 * @param isOrdered 순서를 증명했는지
 */
function mountEvent(context: FlattenContext, event: MountEvent, pieces: readonly PathValue[], policy: AppPolicy, counter: OrderCounter, isOrdered: boolean): void {
  const prefix = event.prefix?.value ?? { kind: 'unknown' };
  if (event.unresolved) {
    context.provided.push(providedOf({ ...event, kind: 'provided', prefix: event.prefix === undefined ? undefined : wildcardPrefix(event.prefix), methods: undefined, prefixKind: 'route-coverage', description: 'a sub-application passed to Hono route() that tsograph could not resolve' }, pieces));
    return;
  }
  const cutoff: CopyCutoff = { root: event.site.frame.root, position: event.site.position };
  for (const child of event.children) {
    walkInstance(context, child.instance, [...pieces, prefix], policy, counter, cutoff, isOrdered && !event.site.conditional);
  }
}

/**
 * 조각을 Hono 규칙으로 이어 컴파일한다.
 *
 * @param pieces 접두사와 라우트 경로 조각
 * @returns 컴파일 결과·원문·앵커
 */
function compileJoined(pieces: readonly PathValue[]): { path: CompiledPath; raw: string; anchor: 'root' | 'base' } {
  const last = pieces.at(-1);
  const normalized = last?.kind === 'unknown' ? [...pieces.slice(0, -1), { kind: 'partial', head: '' } as PathValue] : pieces;
  const joined = joinPieces(normalized, '/', honoMergePath);
  if (joined.kind === 'literal') return { path: compileHonoPath(joined.text), raw: joined.text, anchor: joined.anchor };
  const head = joined.head.endsWith('/') ? `${joined.head}x` : joined.head;
  return { path: { kind: 'dynamic', reason: 'non-literal', prefixes: [literalPrefix(head)] }, raw: `${joined.head}{dynamic}`, anchor: joined.anchor };
}

/**
 * 제공 사건을 요청 경로 상한으로 바꾼다. 접두사를 확정하고 루트 앵커일 때만 스코프를 싣는다.
 *
 * @param event 제공 사건
 * @param pieces 앞 접두사 조각
 * @returns 펼친 제공 경로
 */
function providedOf(event: ProvidedEvent, pieces: readonly PathValue[]): FlatProvided {
  const methods: readonly HttpMethod[] | undefined = event.methods;
  const base = { prefixKind: event.prefixKind, description: event.description };
  if (event.prefix === undefined) return { ...base, scope: undefined };
  const compiled = compileJoined([...pieces, event.prefix.value]);
  if (compiled.anchor !== 'root') return { ...base, scope: undefined };
  const prefixes = compiled.path.kind === 'variants' ? prefixTemplates(compiled.path.variants) : prefixTemplates(compiled.path.prefixes ?? []);
  if (prefixes.length === 0) return { ...base, scope: undefined };
  return { ...base, scope: { templatePrefixes: prefixes, ...(methods === undefined ? {} : { methods }) } };
}
