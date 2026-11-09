/**
 * registration-order 문서의 `order` 필드를 내기 전에 계약 모양을 검증한다.
 *
 * 규칙의 정본은 isthmus `docs/GRAPH-EXCHANGE.md`의 "디스패치 모델" 절과 공유 벡터 `conformance/http-dispatch.json`의
 * `dispatch.validate` 사례다(생산자도 적용). `dispatch-order.test.ts`가 벤더링한 벡터로 이 검사기를 검증하고,
 * `routes` 문서 조립은 내보내기 전에 같은 검사를 한 번 더 거쳐 어긋나면 순서를 버린다(순서 없는 decl은 비교되지
 * 않을 뿐이라 안전한 쪽이다).
 */

/** group 문자열 최대 길이다(계약). */
export const MAX_ORDER_GROUP_LENGTH = 256;

/** 검증에 쓰는 사실 모양이다(JSON 객체 그대로). */
export interface OrderedFactShape {
  readonly method?: unknown;
  readonly channel?: unknown;
  readonly order?: unknown;
  readonly service?: unknown;
  readonly location?: unknown;
  readonly symbol?: unknown;
  readonly catchAllPrefix?: unknown;
  readonly trailingSlash?: unknown;
}

/** 검증에 쓰는 문서 모양이다. */
export interface OrderedDocumentShape {
  readonly dispatch?: unknown;
  readonly service?: unknown;
  readonly facts: readonly OrderedFactShape[];
}

/** 같은 (group, index)를 공유하는 사실의 첫 관찰이다. */
interface OrderSlot {
  readonly location: string;
  readonly service: string;
}

/**
 * 문서의 `order` 필드를 모두 검증한다.
 *
 * @param document 문서(JSON 객체)
 * @returns 위반 사유 코드, 통과하면 undefined
 */
export function dispatchOrderProblem(document: OrderedDocumentShape): string | undefined {
  const slots = new Map<string, OrderSlot>();
  const groupServices = new Map<string, string>();
  for (const fact of document.facts) {
    if (fact.order === undefined) continue;
    if (document.dispatch !== 'registration-order') return 'order-requires-registration-order';
    const problem = orderShapeProblem(fact.order);
    if (problem !== undefined) return problem;
    const { group, index } = fact.order as { group: string; index: number };
    const service = effectiveService(fact, document);
    const knownService = groupServices.get(group);
    if (knownService !== undefined && knownService !== service) return 'group-across-services';
    groupServices.set(group, service);
    const key = `${group}\u0000${index}`;
    const location = JSON.stringify(fact.location ?? null);
    const slot = slots.get(key);
    if (slot !== undefined && slot.location !== location) return 'index-shared-by-two-registrations';
    slots.set(key, { location, service });
  }
  return catchAllPrefixProblem(document);
}

/**
 * `order` 값 하나의 모양을 검증한다.
 *
 * @param order `order` 값
 * @returns 위반 사유 코드, 통과하면 undefined
 */
export function orderShapeProblem(order: unknown): string | undefined {
  if (typeof order !== 'object' || order === null || Array.isArray(order)) return 'order-not-object';
  const record = order as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'group' && key !== 'index')) return 'order-extra-key';
  const { group, index } = record;
  if (typeof group !== 'string' || group.length === 0 || group.length > MAX_ORDER_GROUP_LENGTH) return 'invalid-group';
  if (group.trim() !== group || /[\u0000-\u001F\u007F-\u009F]/u.test(group)) return 'invalid-group';
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) return 'invalid-index';
  return undefined;
}

/**
 * 사실의 유효 service(사실 값, 없으면 문서 값)를 문자열로 만든다.
 *
 * @param fact 사실
 * @param document 문서
 * @returns 유효 service(없으면 빈 문자열)
 */
function effectiveService(fact: OrderedFactShape, document: OrderedDocumentShape): string {
  const value = fact.service ?? document.service;
  return typeof value === 'string' ? value : '';
}

/**
 * catch-all 접두사 decl의 `order`가 원본 `{**}` decl과 같은지 본다. 원본을 찾는 키(method·usr·템플릿)에 `order`가
 * 들어가므로 다르거나 한쪽에만 있으면 소비자가 원본을 찾지 못해 입력 오류다.
 *
 * @param document 문서
 * @returns 위반 사유 코드, 통과하면 undefined
 */
function catchAllPrefixProblem(document: OrderedDocumentShape): string | undefined {
  const originals = new Set(document.facts.filter((fact) => typeof fact.channel === 'string' && fact.channel.endsWith('{**}'))
    .map((fact) => prefixKey(fact, fact.channel as string)));
  const orphan = document.facts.find((fact) => fact.catchAllPrefix === true && typeof fact.channel === 'string'
    && !originalTemplatesOf(fact.channel, fact.trailingSlash).some((original) => originals.has(prefixKey(fact, original))));
  return orphan === undefined ? undefined : 'catch-all-prefix-order-mismatch';
}

/**
 * 접두사 decl이 가리킬 수 있는 `{**}` 원본 템플릿이다(isthmus `catchAllOriginalTemplates`와 같은 규칙). 루트 접두사 `/`는
 * `/{**}`이다. 끝 슬래시를 엄격히 구분하는(`trailingSlash: "strict"`) 접두사 `/a/`는 기존 빈 세그먼트 표기 `/a//{**}`와
 * 펼친 끝 슬래시를 원본과 묶은 `/a/{**}`를 모두 원본으로 받는다.
 *
 * @param prefix 접두사 템플릿
 * @param trailingSlash 접두사 decl의 끝 슬래시 정책
 * @returns 원본 템플릿 후보
 */
function originalTemplatesOf(prefix: string, trailingSlash: unknown): readonly string[] {
  if (prefix === '/') return ['/{**}'];
  const original = `${prefix}/{**}`;
  return trailingSlash === 'strict' && prefix.endsWith('/') ? [original, `${prefix.slice(0, -1)}/{**}`] : [original];
}

/**
 * 접두사 짝을 찾는 키(method·usr·원본 `{**}` 템플릿·order)를 만든다.
 *
 * @param fact 사실
 * @param original 원본 템플릿
 * @returns 키 문자열
 */
function prefixKey(fact: OrderedFactShape, original: string): string {
  const usr = (fact.symbol as { usr?: unknown } | undefined)?.usr;
  return JSON.stringify([fact.method, usr ?? null, original, fact.order ?? null]);
}
