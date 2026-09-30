/**
 * Node 라우터 해석기가 만드는 모델 타입이다: 라우터 객체(인스턴스), 해석 프레임, 등록 사건.
 *
 * 해석기는 모듈 최상위와 "라우터를 넘겨받거나 만드는" 함수 호출을 순서대로 걸으며 사건을 모은다. 각 사건에는
 * 실행 위치(타임라인)가 붙는다. 같은 타임라인 뿌리 안의 위치 비교가 곧 등록 순서다 — 등록 순서로 요청을 고르는
 * 프레임워크(Hono·Express·Koa)의 `order`와, 복사 시점이 중요한 mount(Hono `route()`, @koa/router 중첩)에 쓴다.
 */

import type ts from 'typescript';

import type { HttpMethod, RouteDeclMethod } from '../../exchange/bridge-facts.ts';

/** 해석하는 프레임워크다. */
export type NodeFramework = 'hono' | 'express' | 'koa' | 'fastify' | 'nest';

/** 경로 문자열 값이다. */
export type PathValue =
  | { readonly kind: 'literal'; readonly text: string }
  /** 앞부분만 확정한 문자열(`\`/users/${id}\``의 `/users/`) */
  | { readonly kind: 'partial'; readonly head: string }
  | { readonly kind: 'unknown' };

/** 경로 인자 하나와 그 위치 노드다. */
export interface PathArgument {
  readonly value: PathValue;
  readonly node: ts.Node;
}

/** 해석 프레임이다. 모듈 최상위 하나, 또는 해석한 함수 호출 하나다. */
export interface Frame {
  readonly id: string;
  /** 타임라인 뿌리(모듈 경로 또는 독립 해석 함수 키). 같은 뿌리 안에서만 위치를 비교한다. */
  readonly root: string;
  /** 뿌리부터 이 프레임을 부른 호출 위치 목록 */
  readonly timeline: readonly number[];
  /** 어휘적으로 감싼 프레임(클로저가 바깥 매개변수를 참조할 때 찾는다) */
  readonly parent: Frame | undefined;
  readonly functionNode: ts.SignatureDeclaration | undefined;
  readonly bindings: Map<ts.Symbol, Binding>;
  /** 이 프레임을 부른 호출이 조건부였는지 */
  readonly conditional: boolean;
  readonly depth: number;
}

/** 매개변수 바인딩이다: 호출 인자 식과 그 식을 평가할 프레임, 또는 이미 정한 라우터 대상. */
export interface Binding {
  readonly expression: ts.Expression | undefined;
  readonly frame: Frame;
  readonly targets?: readonly RouterTarget[];
}

/** 라우터 객체 하나다. */
export interface RouterInstance {
  readonly id: number;
  readonly framework: NodeFramework;
  /** `app`은 요청을 직접 받을 수 있는 앱, `router`는 붙여야 쓰는 라우터, `plugin`은 Fastify 플러그인 범위, `opaque`는 타입으로만 안 라우터 */
  readonly kind: 'app' | 'router' | 'plugin' | 'opaque';
  /** 만든 노드(생성 식·매개변수) */
  readonly node: ts.Node;
  readonly frame: Frame;
  /** 프레임워크별로 읽은 생성 옵션 */
  readonly options: Readonly<Record<string, unknown>>;
  /** Fastify 플러그인 범위의 부모 대상 */
  readonly parent?: RouterTarget;
}

/** 등록을 받는 대상이다. Hono `basePath()`처럼 같은 인스턴스에 접두사만 더한 파생도 대상 하나다. */
export interface RouterTarget {
  readonly instance: RouterInstance;
  /** 파생 접두사(Hono basePath) */
  readonly basePaths: readonly PathArgument[];
  /** Express `route(path)`가 돌려준 route 빌더면 그 경로 */
  readonly routePath?: PathArgument;
  /** route 빌더를 만든 호출(같은 route의 method는 한 등록이다) */
  readonly routeNode?: ts.Node;
}

/** 사건이 일어난 실행 위치다. */
export interface EventSite {
  readonly frame: Frame;
  readonly position: readonly number[];
  readonly conditional: boolean;
  /** 등록 호출 식 */
  readonly node: ts.CallExpression;
}

/** 라우트 핸들러 정보다. */
export interface HandlerInfo {
  readonly usr: string | undefined;
  readonly qualifiedName: string;
  /** 인라인 함수라 usr가 감싼 선언(또는 모듈 스코프)이면 true */
  readonly inline: boolean;
  /** 다음 핸들러로 넘길 수 있으면(`next` 매개변수, 모르는 함수) true */
  readonly mayCallNext: boolean;
}

/** 라우트 등록 사건이다. 경로 원소마다 한 등록이다. */
export interface RouteEvent {
  readonly kind: 'route';
  readonly target: RouterTarget;
  /** 계약 method(ANY 포함). 비표준 동사는 `unsupportedMethods`에 둔다. */
  readonly methods: readonly RouteDeclMethod[];
  readonly unsupportedMethods: readonly string[];
  /** 경로 인자(없으면 target의 route 경로·체인 경로를 쓴다) */
  readonly paths: readonly PathArgument[];
  readonly handler: HandlerInfo;
  readonly narrowed: boolean;
  /** method를 정적으로 알 수 없다(계산된 멤버 이름) */
  readonly methodDynamic: boolean;
  readonly site: EventSite;
  /** 한 등록으로 묶을 노드(Express route 빌더면 `route()` 호출) */
  readonly registrationNode: ts.Node;
  /** 끝이 열린 레이어(Express·Koa `use`의 요청을 끝내는 함수)면 true: 경로 자체와 그 아래 전부를 받는다 */
  readonly openEnded?: boolean;
}

/** 다른 라우터를 붙이는 사건이다. */
export interface MountEvent {
  readonly kind: 'mount';
  readonly target: RouterTarget;
  readonly prefix: PathArgument | undefined;
  readonly children: readonly RouterTarget[];
  /** 붙인 값을 라우터로 풀지 못했다 */
  readonly unresolved: boolean;
  /** 등록 시점에 자식의 라우트를 복사하는지(Hono·@koa/router 중첩), 참조하는지(Express·Koa 앱) */
  readonly mode: 'copy' | 'reference';
  readonly site: EventSite;
}

/** 프로젝트 코드에 선언이 없는 경로를 서비스할 수 있는 등록이다(정적 파일·모르는 패키지 미들웨어 등). */
export interface ProvidedEvent {
  readonly kind: 'provided';
  readonly target: RouterTarget;
  readonly prefix: PathArgument | undefined;
  /** 받을 수 있는 method(모르면 undefined) */
  readonly methods: readonly HttpMethod[] | undefined;
  /** `framework-provided-routes:`(프레임워크·패키지 제공) 또는 `route-coverage:`(프로젝트 코드인데 모델링하지 못함) */
  readonly prefixKind: 'framework-provided-routes' | 'route-coverage';
  /** limitation 문구에 넣을 짧은 설명(패키지 이름 등, 경로·코드 원문 없음) */
  readonly description: string;
  readonly site: EventSite;
}

/** 요청을 다음으로 넘긴다고 보는 미들웨어 등록이다(개수만 센다). */
export interface MiddlewareEvent {
  readonly kind: 'middleware';
  readonly target: RouterTarget;
  readonly site: EventSite;
}

/** 라우팅 설정 변경이다(Express `app.set('strict routing', true)` 등). */
export interface SettingEvent {
  readonly kind: 'setting';
  readonly target: RouterTarget;
  readonly key: string;
  /** 불리언으로 확정하지 못하면 undefined */
  readonly value: boolean | undefined;
  /** 경로 설정(@koa/router `prefix()`)이면 그 값 */
  readonly path?: PathArgument;
  readonly site: EventSite;
}

/** 해석기가 모은 사건이다. */
export type RouterEvent = RouteEvent | MountEvent | ProvidedEvent | MiddlewareEvent | SettingEvent;

/**
 * 두 위치(타임라인)를 사전식으로 비교한다.
 *
 * @param left 왼쪽 위치
 * @param right 오른쪽 위치
 * @returns 음수·0·양수
 */
export function comparePositions(left: readonly number[], right: readonly number[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index++) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}
