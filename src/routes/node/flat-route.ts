/**
 * 프레임워크 어댑터가 mount를 펼쳐 만든 최종 라우트(요청 경로 기준)와, 그 과정의 공통 도우미다.
 *
 * - 등록 순서: 인스턴스를 만든 타임라인 뿌리 안에서 일어난 사건만 위치로 정렬해 순서를 증명한다. 다른 뿌리의 사건(다른
 *   모듈이 import한 라우터에 등록 등)은 실행 순서를 모르므로 `order` 없이 낸다.
 * - 복사 mount(Hono `route()`, @koa/router 중첩 `use`)는 mount 시점까지 자식에 등록된 라우트만 복사한다. 같은 뿌리에서
 *   mount 뒤에 등록한 사건은 그 mount 아래에 없다.
 */

import type { HttpMethod, PathAnchor, RouteDeclMethod, RouteOrder } from '../../exchange/bridge-facts.ts';
import type { CompiledPath } from './path-model.ts';
import { comparePositions, type EventSite, type HandlerInfo, type RouterEvent, type RouterInstance } from './router-model.ts';

/** 요청 경로 기준으로 펼친 라우트 하나다. */
export interface FlatRoute {
  readonly handler: HandlerInfo;
  /** 계약 밖이라 내지 않은 동사 */
  readonly unsupportedMethods: readonly string[];
  readonly methods: readonly RouteDeclMethod[];
  readonly path: CompiledPath;
  /** dynamic channel에 쓸 원문(접두사 포함) */
  readonly rawPath: string;
  readonly anchor: PathAnchor;
  /** 위치로 쓸 노드(경로 인자, 없으면 등록 호출) */
  readonly locationNode: import('typescript').Node;
  readonly order: RouteOrder | undefined;
  /** 프레임워크의 끝 슬래시 규칙(빈 값 변형·catch-all 템플릿은 조립할 때 따로 정한다) */
  readonly trailingSlash: 'strict' | 'optional' | undefined;
  readonly caseInsensitive: boolean;
  readonly narrowed: boolean;
  /** 조건부 등록이면 true(사실 대신 스코프 있는 `route-coverage:` 한계로 낸다) */
  readonly conditional: boolean;
}

/** mount를 펼친 제공 경로(정적 파일·모르는 패키지 등)다. */
export interface FlatProvided {
  readonly prefixKind: 'framework-provided-routes' | 'route-coverage';
  readonly description: string;
  /** 받을 수 있는 요청의 상한. 증명하지 못했으면 undefined(문서 전체 효과)다. */
  readonly scope: { readonly templatePrefixes: readonly string[]; readonly methods?: readonly HttpMethod[] } | undefined;
}

/** 프레임워크 하나의 추출 결과다. */
export interface FrameworkRoutes {
  readonly framework: import('./router-model.ts').NodeFramework;
  readonly dispatch: 'specificity' | 'registration-order';
  readonly routes: readonly FlatRoute[];
  readonly provided: readonly FlatProvided[];
  /** 요청을 넘긴다고 본 미들웨어 등록 수 */
  readonly middlewareCount: number;
  /** 프레임워크별 추가 한계 문장(서버 측 접두사로 시작한다) */
  readonly notes: readonly string[];
}

/** 순서 번호를 매기는 계수기다. */
export interface OrderCounter {
  readonly group: string | undefined;
  next: number;
  /** 등록 키 → 매긴 순서(Express route 빌더처럼 한 레이어에 method를 더하는 등록은 같은 index를 쓴다) */
  readonly assigned?: Map<string, import('../../exchange/bridge-facts.ts').RouteOrder>;
}

/** mount 복사 시점 제한이다. 같은 뿌리에서 이 위치 뒤의 사건은 복사되지 않는다. */
export interface CopyCutoff {
  readonly root: string;
  readonly position: readonly number[];
}

/**
 * 인스턴스의 사건을 (순서를 증명한 것, 증명하지 못한 것)으로 나눈다. 앞쪽은 위치 순이다.
 *
 * @param instance 인스턴스
 * @param events 그 인스턴스를 대상으로 한 사건
 * @param cutoff 복사 mount 시점 제한
 * @returns 나눈 사건
 */
export function partitionEvents(instance: RouterInstance, events: readonly RouterEvent[], cutoff: CopyCutoff | undefined): { ordered: RouterEvent[]; unordered: RouterEvent[] } {
  const visible = events.filter((event) => isBeforeCutoff(event.site, cutoff));
  const ordered = visible.filter((event) => !event.site.conditional && event.site.frame.root === instance.frame.root)
    .sort((left, right) => comparePositions(left.site.position, right.site.position));
  const unordered = visible.filter((event) => !ordered.includes(event));
  return { ordered, unordered };
}

/**
 * 사건이 복사 시점 제한 안인지 본다. 다른 뿌리(먼저 실행된 다른 모듈)의 사건은 복사된 것으로 본다.
 *
 * @param site 사건 위치
 * @param cutoff 제한
 * @returns 안이면 true
 */
function isBeforeCutoff(site: EventSite, cutoff: CopyCutoff | undefined): boolean {
  if (cutoff === undefined || site.frame.root !== cutoff.root) return true;
  return comparePositions(site.position, cutoff.position) < 0;
}

/**
 * 순서를 증명한 등록이면 다음 번호를 매긴다. 같은 등록(노드, 경로 원소)은 같은 번호다.
 *
 * @param counter 계수기(group이 없으면 순서를 싣지 않는다)
 * @param isOrdered 순서를 증명했는지
 * @param registration 등록 노드와 경로 원소 번호
 * @returns order 또는 undefined
 */
export function takeOrder(counter: OrderCounter, isOrdered: boolean, registration?: { node: import('typescript').Node; element: number }): RouteOrder | undefined {
  if (counter.group === undefined || !isOrdered) return undefined;
  const key = registration === undefined ? undefined : `${registration.node.pos}:${registration.node.end}:${registration.node.getSourceFile().fileName}#${registration.element}`;
  const existing = key === undefined ? undefined : counter.assigned?.get(key);
  if (existing !== undefined) return existing;
  const order = { group: counter.group, index: counter.next };
  counter.next += 1;
  if (key !== undefined) counter.assigned?.set(key, order);
  return order;
}

/**
 * 사건을 대상 인스턴스별로 묶는다.
 *
 * @param events 사건
 * @returns 인스턴스 → 사건
 */
export function eventsByInstance(events: readonly RouterEvent[]): Map<RouterInstance, RouterEvent[]> {
  const grouped = new Map<RouterInstance, RouterEvent[]>();
  for (const event of events) {
    const list = grouped.get(event.target.instance) ?? [];
    list.push(event);
    grouped.set(event.target.instance, list);
  }
  return grouped;
}
