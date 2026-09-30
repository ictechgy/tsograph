/**
 * 펼친 Node 라우트를 isthmus `route-decl` 사실과 서버 측 한계로 바꾼다.
 *
 * - 정적 경로는 대안마다 정규 템플릿·빈 값 변형·0세그먼트 catch-all 접두사 decl로 펼치고 method마다 사실 하나를 낸다.
 *   접두사 decl의 `catchAllPrefix`는 isthmus가 `symbol.usr`를 요구하므로 usr가 있을 때만 단다.
 * - 옮기지 못한 경로는 dynamic 사실이고, 증명한 정적 접두사가 있으면 `dynamicScope`를 싣는다(`methods`는 ANY 전용이라
 *   싣지 않는다). 같은 원인의 `route-coverage:` 한계도 같은 상한으로 스코프를 단다.
 * - 조건부 등록(if·반복문·단락 평가 등)은 선언 대신 스코프 있는 `route-coverage:`다(pythograph Django와 같은 결정).
 * - 스코프는 한계가 가릴 수 있는 **모든** 요청의 상한일 때만 싣는다. 하나라도 상한을 증명하지 못하면 그 한계는 스코프
 *   없이 문서 전체에 적용한다.
 */

import type { HttpMethod, ParamConstraint, RouteDeclFact, RouteDeclMethod } from '../../exchange/bridge-facts.ts';
import { dynamicScopeProblem } from '../../exchange/dynamic-scope.ts';
import { sanitizeDynamicChannel } from '../../openapi/path-template.ts';
import type { FlatProvided, FlatRoute, FrameworkRoutes } from './flat-route.ts';
import { isNodeTestPath, type NodeProject } from './node-project.ts';
import { expandVariant, type ExpandedTemplate, MAX_TEMPLATE_VARIANTS, prefixTemplates } from './path-model.ts';

/** 한계 하나의 요청 상한이다(스코프 항목에서 인덱스를 뺀 모양). */
export interface LimitationRange {
  readonly templates?: readonly string[];
  readonly templatePrefixes?: readonly string[];
  readonly templateSuffixes?: readonly string[];
  readonly methods?: readonly HttpMethod[];
}

/** 한계 문장과, 증명했으면 상한이다. */
export interface LimitationEntry {
  readonly text: string;
  readonly range?: LimitationRange;
}

/** 스코프 원소 수 상한이다. 넘으면 스코프를 생략한다(문서 전체 효과, 안전한 쪽). */
const MAX_SCOPE_ELEMENTS = 2000;

/** 사실 조립 입력이다. */
export interface NodeFactsInput {
  readonly project: NodeProject;
  readonly frameworks: readonly FrameworkRoutes[];
  readonly service: string | undefined;
  readonly includeTests: boolean;
  /** 문서가 registration-order인지(아니면 `order`를 떼고 순서 한계도 내지 않는다) */
  readonly registrationOrder: boolean;
}

/** 조립 결과다. */
export interface NodeFacts {
  readonly facts: RouteDeclFact[];
  readonly limitations: LimitationEntry[];
}

/** 한계 계수를 모으는 상자다. */
interface Tally {
  readonly conditional: ScopeAccumulator;
  readonly unsupportedVerbs: ScopeAccumulator;
  readonly dynamic: ScopeAccumulator;
  readonly base: ScopeAccumulator;
  readonly orderless: ScopeAccumulator;
  inline: number;
  missingUsr: number;
  capped: number;
}

/**
 * 사실과 한계를 조립한다.
 *
 * @param input 입력
 * @returns 사실·한계
 */
export function buildNodeFacts(input: NodeFactsInput): NodeFacts {
  const tally: Tally = {
    conditional: new ScopeAccumulator(),
    unsupportedVerbs: new ScopeAccumulator(),
    dynamic: new ScopeAccumulator(),
    base: new ScopeAccumulator(),
    orderless: new ScopeAccumulator(),
    inline: 0,
    missingUsr: 0,
    capped: 0,
  };
  const facts: RouteDeclFact[] = [];
  for (const framework of input.frameworks) {
    const built = framework.routes.flatMap((route) => routeFacts(input, route, tally));
    facts.push(...(framework.dispatch === 'specificity' ? dropShadowedEmptyVariants(built) : built).map((entry) => entry.fact));
  }
  const limitations = [
    ...tallyLimitations(tally, input.registrationOrder),
    ...providedLimitations(input.frameworks.flatMap((framework) => framework.provided)),
    ...middlewareLimitations(input.frameworks),
    ...input.frameworks.flatMap((framework) => framework.notes.map((text) => ({ text }))),
  ];
  return { facts, limitations };
}

/** 사실과, 빈 값 변형으로 만든 사실인지다. */
interface BuiltFact {
  readonly fact: RouteDeclFact;
  readonly emptyVariant: boolean;
}

/**
 * 구체성 라우터(find-my-way)에서 명시적 정적 선언과 같은 (method, 템플릿)인 빈 값 변형을 뺀다. 정적 노드가 빈 파라미터보다
 * 먼저 맞으므로 그 변형은 요청을 받지 않는다(남기면 같은 키의 거짓 충돌이 된다).
 *
 * @param built 조립한 사실
 * @returns 남길 사실
 */
function dropShadowedEmptyVariants(built: readonly BuiltFact[]): BuiltFact[] {
  const explicit = new Set(built.filter((entry) => !entry.emptyVariant).map((entry) => `${entry.fact.pathAnchor} ${entry.fact.channel}`));
  const explicitMethods = new Map<string, Set<string>>();
  for (const entry of built.filter((item) => !item.emptyVariant)) {
    const key = `${entry.fact.pathAnchor} ${entry.fact.channel}`;
    explicitMethods.set(key, (explicitMethods.get(key) ?? new Set()).add(entry.fact.method));
  }
  return built.filter((entry) => {
    const key = `${entry.fact.pathAnchor} ${entry.fact.channel}`;
    if (!entry.emptyVariant || !explicit.has(key)) return true;
    const methods = explicitMethods.get(key)!;
    return !(methods.has('ANY') || methods.has(entry.fact.method));
  });
}

/**
 * 라우트 하나를 사실로 바꾼다. 조건부·비표준 동사는 사실 대신 한계 계수로 센다.
 *
 * @param input 입력
 * @param route 라우트
 * @param tally 계수
 * @returns 사실 목록(빈 값 변형 표시 포함)
 */
function routeFacts(input: NodeFactsInput, route: FlatRoute, tally: Tally): BuiltFact[] {
  const shape = shapeOf(route);
  if (shape.kind === 'capped') tally.capped += 1;
  const methods = route.methods;
  const scopeMethods = methods.includes('ANY') ? undefined : (methods as HttpMethod[]);
  if (route.conditional) {
    tally.conditional.add(shape.range(route.anchor), scopeMethods);
    return [];
  }
  if (route.unsupportedMethods.length > 0) tally.unsupportedVerbs.add(shape.range(route.anchor), undefined);
  if (methods.length === 0) return [];
  countHandler(route, tally);
  const order = input.registrationOrder ? route.order : undefined;
  if (input.registrationOrder && order === undefined) tally.orderless.add(shape.range(route.anchor), scopeMethods);
  if (route.anchor === 'base') tally.base.add(shape.kind === 'static' ? { templateSuffixes: shape.templates.map((entry) => entry.channel) } : undefined, undefined);
  if (shape.kind !== 'static') {
    const scope = dynamicScopeOf(route, shape.prefixes);
    tally.dynamic.add(scope, scopeMethods);
    return methods.map((method) => ({ fact: dynamicFact(input, route, method, scope, order), emptyVariant: false }));
  }
  return shape.templates.flatMap((template) => methods.map((method) => ({ fact: staticFact(input, route, method, template, order), emptyVariant: template.emptyVariant })));
}

/** 라우트 경로의 사실 모양이다. */
type RouteShape =
  | { readonly kind: 'static'; readonly templates: readonly ExpandedTemplate[]; range(anchor: string): LimitationRange | undefined }
  | { readonly kind: 'dynamic' | 'capped'; readonly prefixes: readonly string[] | undefined; range(anchor: string): LimitationRange | undefined };

/**
 * 라우트 경로를 펼친 템플릿 또는 dynamic 모양으로 만든다.
 *
 * @param route 라우트
 * @returns 모양
 */
function shapeOf(route: FlatRoute): RouteShape {
  if (route.path.kind === 'dynamic') {
    const prefixes = route.path.prefixes === undefined ? undefined : prefixTemplates(route.path.prefixes);
    return dynamicShape(route.path.reason === 'expansion-capped' ? 'capped' : 'dynamic', prefixes);
  }
  const templates: ExpandedTemplate[] = [];
  for (const variant of route.path.variants) {
    const expanded = expandVariant(variant);
    if (expanded === undefined) return dynamicShape('capped', prefixTemplates(route.path.variants));
    templates.push(...expanded);
  }
  if (templates.length > MAX_TEMPLATE_VARIANTS) return dynamicShape('capped', prefixTemplates(route.path.variants));
  return {
    kind: 'static',
    templates,
    range: (anchor) => (anchor === 'root' ? { templates: templates.map((entry) => entry.channel) } : { templateSuffixes: templates.map((entry) => entry.channel) }),
  };
}

/**
 * dynamic 모양을 만든다.
 *
 * @param kind dynamic 또는 상한 초과
 * @param prefixes 증명한 접두사 템플릿
 * @returns 모양
 */
function dynamicShape(kind: 'dynamic' | 'capped', prefixes: readonly string[] | undefined): RouteShape {
  return { kind, prefixes, range: (anchor) => (anchor === 'root' && prefixes !== undefined && prefixes.length > 0 ? { templatePrefixes: prefixes } : undefined) };
}

/**
 * 핸들러 관련 계수(인라인, usr 없음)를 센다.
 *
 * @param route 라우트
 * @param tally 계수
 */
function countHandler(route: FlatRoute, tally: Tally): void {
  if (route.handler.usr === undefined) tally.missingUsr += 1;
  else if (route.handler.inline) tally.inline += 1;
}

/**
 * dynamic 사실의 `dynamicScope`를 만든다. 루트 앵커에서 접두사를 증명했을 때만 싣는다.
 *
 * @param route 라우트
 * @param prefixes 접두사 템플릿
 * @returns 스코프 또는 undefined
 */
function dynamicScopeOf(route: FlatRoute, prefixes: readonly string[] | undefined): LimitationRange | undefined {
  if (route.anchor !== 'root' || prefixes === undefined || prefixes.length === 0) return undefined;
  const scope = { templatePrefixes: prefixes };
  const probe = { kind: 'route-decl', method: route.methods[0], pathAnchor: route.anchor, dynamic: true, dynamicScope: scope };
  return dynamicScopeProblem(probe) === undefined ? scope : undefined;
}

/**
 * 정적 사실 하나를 만든다.
 *
 * @param input 입력
 * @param route 라우트
 * @param method method
 * @param template 펼친 템플릿
 * @param order 순서
 * @returns 사실
 */
function staticFact(input: NodeFactsInput, route: FlatRoute, method: RouteDeclMethod, template: ExpandedTemplate, order: FlatRoute['order']): RouteDeclFact {
  const hasUsr = route.handler.usr !== undefined;
  const trailingSlash = trailingSlashOf(route, template);
  return {
    ...commonFields(input, route, method, order),
    channel: template.channel,
    dynamic: false,
    ...(trailingSlash === undefined ? {} : { trailingSlash }),
    ...(template.catchAllPrefix && hasUsr ? { catchAllPrefix: true as const } : {}),
    ...(template.constraints.length === 0 ? {} : { paramConstraints: template.constraints as ParamConstraint[] }),
  } as RouteDeclFact;
}

/**
 * 펼친 템플릿 하나의 끝 슬래시 규칙이다. catch-all로 끝나면 싣지 않고, 빈 값 변형은 strict다. 끝 슬래시를 떼고 비교하는
 * 라우터(optional)에서 `/`로 끝나는 템플릿은 두 형태가 같은 핸들러에 닿는지 증명하지 못해 싣지 않는다.
 *
 * @param route 라우트
 * @param template 펼친 템플릿
 * @returns 규칙 또는 undefined
 */
function trailingSlashOf(route: FlatRoute, template: ExpandedTemplate): 'strict' | 'optional' | undefined {
  if (template.endsWithCatchAll) return undefined;
  if (template.emptyTail) return 'strict';
  if (route.trailingSlash === 'optional' && template.channel !== '/' && template.channel.endsWith('/')) return undefined;
  return route.trailingSlash;
}

/**
 * dynamic 사실 하나를 만든다.
 *
 * @param input 입력
 * @param route 라우트
 * @param method method
 * @param scope 스코프
 * @param order 순서
 * @returns 사실
 */
function dynamicFact(input: NodeFactsInput, route: FlatRoute, method: RouteDeclMethod, scope: LimitationRange | undefined, order: FlatRoute['order']): RouteDeclFact {
  return {
    ...commonFields(input, route, method, order),
    channel: sanitizeDynamicChannel(route.rawPath),
    dynamic: true,
    ...(scope === undefined ? {} : { dynamicScope: scope }),
  } as RouteDeclFact;
}

/**
 * 모든 사실이 공유하는 필드다.
 *
 * @param input 입력
 * @param route 라우트
 * @param method method
 * @param order 순서
 * @returns 공통 필드
 */
function commonFields(input: NodeFactsInput, route: FlatRoute, method: RouteDeclMethod, order: FlatRoute['order']): Omit<RouteDeclFact, 'channel' | 'dynamic'> {
  const location = input.project.locationOf(route.locationNode);
  const handler = route.handler;
  return {
    kind: 'route-decl',
    method,
    pathAnchor: route.anchor,
    ...(input.service === undefined ? {} : { service: input.service }),
    ...(input.includeTests && isNodeTestPath(location.path) ? { testSource: true as const } : {}),
    ...(route.caseInsensitive ? { caseInsensitive: true as const } : {}),
    ...(route.narrowed ? { narrowed: true as const } : {}),
    ...(order === undefined ? {} : { order }),
    location,
    symbol: { qualifiedName: handler.qualifiedName, ...(handler.usr === undefined ? {} : { usr: handler.usr }) },
  };
}

/**
 * 계수에서 한계를 만든다.
 *
 * @param tally 계수
 * @param registrationOrder registration-order 문서인지
 * @returns 한계 목록
 */
function tallyLimitations(tally: Tally, registrationOrder: boolean): LimitationEntry[] {
  const entries: LimitationEntry[] = [];
  const push = (accumulator: ScopeAccumulator, text: (count: number) => string): void => {
    if (accumulator.count > 0) entries.push(accumulator.entry(text(accumulator.count)));
  };
  push(tally.conditional, (count) => `route-coverage: ${count} route registration(s) run only under a condition (if, switch, loop, catch, or short-circuit expression); they are not emitted as declarations`);
  push(tally.unsupportedVerbs, (count) => `route-coverage: ${count} route registration(s) also accept HTTP verbs outside the contract's method set; those verbs are not emitted`);
  push(tally.dynamic, (count) => `route-coverage: ${count} route declaration(s) have paths tsograph could not translate into a canonical template; their facts are dynamic`);
  push(tally.base, (count) => `unresolved-route-prefix: ${count} route declaration(s) sit behind a mount prefix or router attachment tsograph could not resolve; they use pathAnchor base`);
  if (registrationOrder) push(tally.orderless, (count) => `route-dispatch-order-unknown: ${count} route declaration(s) carry no order (a handler that may pass the request on with next(), a registration outside the app's own module or behind a condition, or a router that picks by specificity)`);
  if (tally.inline > 0) entries.push({ text: `framework-dispatch-unmodeled: ${tally.inline} route handler(s) are inline functions; their symbol.usr is the enclosing declaration or module scope, so reach from them includes sibling code` });
  if (tally.missingUsr > 0) entries.push({ text: `missing-route-usrs: ${tally.missingUsr} route declaration(s) have handlers defined outside the project or that tsograph could not resolve; they carry no symbol.usr` });
  if (tally.capped > 0) entries.push({ text: `route-template-expansion-capped: ${tally.capped} route path(s) expand to more than ${MAX_TEMPLATE_VARIANTS} templates (optional segments or empty-value variants); their facts are dynamic` });
  return entries;
}

/**
 * 제공 경로 한계를 만든다. 같은 (접두사, 설명, 스코프)는 한 문장으로 센다.
 *
 * @param provided 제공 경로 목록
 * @returns 한계 목록
 */
function providedLimitations(provided: readonly FlatProvided[]): LimitationEntry[] {
  const grouped = new Map<string, { entry: FlatProvided; count: number }>();
  for (const entry of provided) {
    const key = JSON.stringify([entry.prefixKind, entry.description, entry.scope ?? null]);
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, { entry, count: 1 });
    else existing.count += 1;
  }
  return [...grouped.values()].map(({ entry, count }) => {
    const text = `${entry.prefixKind}: ${count} registration(s) of ${entry.description} can answer requests that have no route declaration in the project`;
    return entry.scope === undefined ? { text } : { text, range: { templatePrefixes: entry.scope.templatePrefixes, ...(entry.scope.methods === undefined ? {} : { methods: entry.scope.methods }) } };
  });
}

/**
 * 미들웨어 한계(체인 전용)다.
 *
 * @param frameworks 프레임워크 결과
 * @returns 한계 목록
 */
function middlewareLimitations(frameworks: readonly FrameworkRoutes[]): LimitationEntry[] {
  const count = frameworks.reduce((sum, framework) => sum + framework.middlewareCount, 0);
  if (count === 0) return [];
  return [{ text: `framework-dispatch-unmodeled: ${count} middleware registration(s) run before route handlers and are treated as passing every request on; their code is not attached to handler usrs` }];
}

/** 한계 하나의 스코프를 모은다. 상한을 증명하지 못한 항목이 하나라도 있으면 스코프가 없다. */
class ScopeAccumulator {
  count = 0;
  private unscoped = false;
  private readonly templates = new Set<string>();
  private readonly prefixes = new Set<string>();
  private readonly suffixes = new Set<string>();
  private methods: Set<HttpMethod> | undefined = new Set();

  /**
   * 항목 하나를 더한다.
   *
   * @param range 항목의 경로 상한(없으면 증명하지 못함)
   * @param methods 항목의 method(없으면 모든 method)
   */
  add(range: LimitationRange | undefined, methods: readonly HttpMethod[] | undefined): void {
    this.count += 1;
    if (range === undefined) {
      this.unscoped = true;
      return;
    }
    range.templates?.forEach((template) => this.templates.add(template));
    range.templatePrefixes?.forEach((prefix) => this.prefixes.add(prefix));
    range.templateSuffixes?.forEach((suffix) => this.suffixes.add(suffix));
    if (methods === undefined) this.methods = undefined;
    else methods.forEach((method) => this.methods?.add(method));
  }

  /**
   * 한계 항목을 만든다.
   *
   * @param text 문장
   * @returns 항목
   */
  entry(text: string): LimitationEntry {
    const size = this.templates.size + this.prefixes.size + this.suffixes.size;
    if (this.unscoped || size === 0 || size > MAX_SCOPE_ELEMENTS || [...this.suffixes].some((suffix) => suffix === '/' || suffix.includes('{**}'))) return { text };
    const range: LimitationRange = {
      ...(this.templates.size === 0 ? {} : { templates: [...this.templates].sort() }),
      ...(this.prefixes.size === 0 ? {} : { templatePrefixes: [...this.prefixes].sort() }),
      ...(this.suffixes.size === 0 ? {} : { templateSuffixes: [...this.suffixes].sort() }),
      ...(this.methods === undefined || this.methods.size === 0 ? {} : { methods: [...this.methods].sort() }),
    };
    return { text, range };
  }
}
