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
    .map((fact) => prefixKey(fact, originalPrefix(fact.channel as string))));
  const orphan = document.facts.find((fact) => fact.catchAllPrefix === true && !originals.has(prefixKey(fact, fact.channel as string)));
  return orphan === undefined ? undefined : 'catch-all-prefix-order-mismatch';
}

/**
 * `{**}` 원본 템플릿에서 접두사 템플릿을 만든다(루트 catch-all은 `/`).
 *
 * @param channel 원본 템플릿
 * @returns 접두사 템플릿
 */
function originalPrefix(channel: string): string {
  const prefix = channel.slice(0, -'/{**}'.length);
  return prefix === '' ? '/' : prefix;
}

/**
 * 접두사 짝을 찾는 키(method·usr·접두사 템플릿·order)를 만든다.
 *
 * @param fact 사실
 * @param prefix 접두사 템플릿
 * @returns 키 문자열
 */
function prefixKey(fact: OrderedFactShape, prefix: string): string {
  const usr = (fact.symbol as { usr?: unknown } | undefined)?.usr;
  return JSON.stringify([fact.method, usr ?? null, prefix, fact.order ?? null]);
}
