/**
 * isthmus bridge-facts v1 문서 중 tsograph가 내는 부분의 타입과 공통 검증이다.
 *
 * 계약 정본은 isthmus `docs/GRAPH-EXCHANGE.md`다. http 절은 "개발 중" 초안이라
 * 이 파일은 초안의 route-contract 사실에 필요한 필드만 옮긴다. 초안이 바뀌면
 * 여기와 README의 결정 목록을 함께 고친다.
 */

/** 초안이 허용하는 HTTP method다. `ANY`는 route-decl 전용이라 스펙에서는 내지 않는다. */
export type HttpMethod =
  | 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'TRACE';

/**
 * 경로 앵커다.
 *
 * `root`는 템플릿이 서버 경로 루트부터 확정됐다는 뜻, `base`는 정적으로 알 수
 * 없는 base 경로 뒤에 붙는다는 뜻이다.
 */
export type PathAnchor = 'root' | 'base';

/** 프로젝트 루트 기준 상대 경로와 1부터 시작하는 줄·UTF-8 바이트 열이다. */
export interface BridgeLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

/** 스펙 operation 하나를 나타내는 `route-contract` 사실이다. */
export interface RouteContractFact {
  readonly kind: 'route-contract';
  readonly method: HttpMethod;
  /** 정규 경로 템플릿. dynamic이면 안전하게 인코딩한 원문(길이 상한)이다. */
  readonly channel: string;
  readonly dynamic: boolean;
  readonly pathAnchor: PathAnchor;
  readonly service: string;
  readonly location: BridgeLocation;
  /** operationId가 있을 때만 싣는다. usr는 스펙에 안정 식별자가 없어 싣지 않는다. */
  readonly symbol?: { readonly qualifiedName: string };
  /** 초안이 route-contract 증거로 허용하는 operationId다. */
  readonly operationId?: string;
}

/** tsograph openapi가 내는 bridge-facts v1 문서다. */
export interface RouteContractDocument {
  readonly format: 'bridge-facts';
  readonly version: 1;
  readonly tool: { readonly name: 'tsograph'; readonly version: string };
  readonly generatedAt: string;
  readonly sourceModifiedAt?: string;
  readonly platform: 'openapi';
  /** roles가 비어 있지 않은 http 문서는 사실이 0건이어도 target을 유지한다(초안의 http 예외). */
  readonly target: 'http';
  /** 스펙은 선언 측이다. 초안의 미결 항목이라 server를 재사용한다(README 결정 목록). */
  readonly roles: readonly ['server'];
  readonly service: string;
  readonly project: string;
  readonly facts: readonly RouteContractFact[];
  readonly limitations: readonly string[];
}

/**
 * 계약이 식별자에 금지하는 문자를 찾는다.
 *
 * C0·DEL·C1 제어 문자, NEL(U+0085), 줄·문단 구분자(U+2028/U+2029)다. C1 범위가
 * NEL을 포함한다. 소비자가 이런 문서를 거부하므로 생산 단계에서 먼저 막는다.
 */
const forbiddenIdentifierCharacters = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

/**
 * 값이 계약상 안전한 식별자 문자열인지 확인한다.
 *
 * 프로젝트 경로·위치 경로·service·operationId처럼 문서에 그대로 싣는 문자열에
 * 쓴다. 짝 없는 서러게이트도 소비자가 거부하므로 함께 막는다.
 *
 * @param value 검사할 문자열
 * @returns 비어 있지 않고 금지 문자·짝 없는 서러게이트가 없으면 true
 */
export function isSafeIdentifier(value: string): boolean {
  return value.length > 0
    && value.isWellFormed()
    && !forbiddenIdentifierCharacters.test(value);
}

/**
 * 시각을 계약의 정규 형식(`YYYY-MM-DDTHH:mm:ss.SSSZ`, UTC)으로 바꾼다.
 *
 * @param instant 변환할 시각
 * @returns 밀리초 세 자리의 UTC ISO 8601 문자열
 */
export function formatBridgeTimestamp(instant: Date): string {
  return instant.toISOString();
}

/** `route-decl` 전용 method다. `ANY`는 method를 정적으로 알 수 없는 선언(Pages Router API 등)이다. */
export type RouteDeclMethod = HttpMethod | 'ANY';

/** 서버 코드의 라우트 선언 하나를 나타내는 `route-decl` 사실이다. */
export interface RouteDeclFact {
  readonly kind: 'route-decl';
  readonly method: RouteDeclMethod;
  /** 정규 경로 템플릿. dynamic이면 안전하게 인코딩한 원문(길이 상한)이다. */
  readonly channel: string;
  readonly dynamic: boolean;
  readonly pathAnchor: PathAnchor;
  readonly service?: string;
  /** 끝 슬래시 규칙. 생략은 unknown이다. */
  readonly trailingSlash?: 'strict' | 'optional';
  /** `--include-tests`로 낸 테스트 소스 사실에만 단다. */
  readonly testSource?: true;
  /** 0세그먼트 catch-all을 펼친 접두사 decl 표식이다. `symbol.usr`가 있을 때만 단다(isthmus 검증). */
  readonly catchAllPrefix?: true;
  /** 대소문자를 무시하고 매칭함을 증명한 선언에만 단다(Express·Koa 기본값 등). */
  readonly caseInsensitive?: true;
  /** host·version 같은 조건으로 같은 키를 나눈 핸들러다(조건이 맞지 않는 요청은 다른 핸들러로 간다). */
  readonly narrowed?: true;
  /** 파라미터 세그먼트의 제약이다. 세그먼트마다 하나이며 인덱스 순으로 싣는다. */
  readonly paramConstraints?: readonly ParamConstraint[];
  /** registration-order 문서에서 순서를 증명한 선언의 (라우터 체인, 등록 순번)이다. */
  readonly order?: RouteOrder;
  /** dynamic 선언이 받을 수 있는 요청의 증명된 상한이다. */
  readonly dynamicScope?: DynamicScope;
  readonly location: BridgeLocation;
  /** qualifiedName은 사람이 읽는 핸들러 이름, usr는 핸들러의 tsograph 그래프 id다(없으면 생략). */
  readonly symbol: { readonly qualifiedName: string; readonly usr?: string };
}

/** `paramConstraints` 원소다. `pattern`은 `regex` 전용 정보 필드다. */
export interface ParamConstraint {
  readonly segment: number;
  readonly kind: 'int' | 'uuid' | 'slug' | 'path' | 'regex';
  readonly pattern?: string;
}

/** registration-order 문서의 등록 순서다. 한 index는 한 등록(소스 위치 하나)이다. */
export interface RouteOrder {
  readonly group: string;
  readonly index: number;
}

/** dynamic 선언의 요청 상한이다. `methods`는 `ANY` 선언에만 싣는다. */
export interface DynamicScope {
  readonly templates?: readonly string[];
  readonly templatePrefixes?: readonly string[];
  readonly templateSuffixes?: readonly string[];
  readonly methods?: readonly HttpMethod[];
}

/** tsograph routes --role server가 내는 bridge-facts v1 문서다. */
export interface RouteDeclDocument {
  readonly format: 'bridge-facts';
  readonly version: 1;
  readonly tool: { readonly name: 'tsograph'; readonly version: string };
  readonly generatedAt: string;
  readonly platform: 'js';
  /** roles가 있는 http 문서는 사실이 0건이어도 target을 유지한다. */
  readonly target: 'http';
  readonly roles: readonly ['server'];
  /** 파일 라우터(Next.js)·find-my-way(Fastify)는 구체성, 등록 순서로 고르는 라우터(Hono·Express·Koa)가 있으면 등록 순서다. */
  readonly dispatch: 'specificity' | 'registration-order';
  readonly sourceSets: { readonly tests: 'excluded' | 'included' };
  readonly service?: string;
  readonly project: string;
  readonly facts: readonly RouteDeclFact[];
  readonly limitations: readonly string[];
  /** 한계 하나가 가릴 수 있는 요청의 보수적 상한. 증명한 항목이 있을 때만 싣는다. */
  readonly limitationScopes?: readonly HttpLimitationScope[];
}

/**
 * http 문서의 limitation 스코프 항목이다(isthmus GRAPH-EXCHANGE "http limitation 스코프").
 *
 * 스코프는 그 한계가 가릴 수 있는 **모든** 요청을 포함하는 상한이어야 한다. 소비자는 스코프 밖의 호출에
 * 그 한계를 적용하지 않으므로, 상한을 증명하지 못한 한계는 항목을 생략해 문서 전체 효과로 둔다.
 */
export interface HttpLimitationScope {
  /** 같은 문서 `limitations` 배열의 0부터 시작하는 인덱스다. */
  readonly limitationIndex: number;
  /** 정확한 정규 템플릿 집합이다. */
  readonly templates?: readonly string[];
  /** 세그먼트 경계의 root 접두사다(`/`는 모든 경로). */
  readonly templatePrefixes?: readonly string[];
  /** 알 수 없는 앞부분 뒤의 세그먼트 경계 접미사다. */
  readonly templateSuffixes?: readonly string[];
  /** 생략하면 모든 method다. */
  readonly methods?: readonly HttpMethod[];
}
