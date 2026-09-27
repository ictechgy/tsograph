/**
 * Next.js 파일 경로(폴더 세그먼트)를 isthmus 정규 경로 템플릿으로 바꾼다.
 *
 * 확인한 Next.js 16.2.7 규칙(`next/dist` 소스, 번들 문서):
 * - App Router 경로는 `shared/lib/router/utils/app-paths.js`의 `normalizeAppPath`로 만든다:
 *   route group `(x)`와 `@slot` 세그먼트를 빼고 끝의 `route`를 뗀다.
 * - `_`로 시작하는 파일·폴더는 App Router 스캔에서 통째로 빠진다
 *   (`build/route-discovery.js`의 `ignorePartFilter`). Pages Router에는 이 규칙이 없다.
 * - 동적 세그먼트는 세그먼트 전체가 `[x]`·`[...x]`·`[[...x]]`일 때만이다
 *   (`shared/lib/router/utils/sorted-routes.js`). `[[x]]`, 끝이 아닌 catch-all, `.`로 시작하는 이름,
 *   겹친 대괄호, 같은 경로의 같은 이름은 Next가 빌드에서 거부한다.
 * - `[...x]`는 1개 이상, `[[...x]]`는 0개 이상 세그먼트와 맞는다(`route-regex.js`).
 *
 * `(.)x` 같은 intercepting route와 `@slot` 아래 route 파일은 공식 문서가 페이지에 대해서만
 * 설명하므로 모델링하지 않고 호출자가 limitation으로 센다.
 */

import { canonicalizeLiteral } from '../openapi/percent-encoding.ts';

/** 파일 라우터 종류다. 세그먼트 규칙이 다르다. */
export type NextRouter = 'app' | 'pages';

/** 세그먼트 하나의 분류다. */
export type SegmentClass =
  | { readonly kind: 'static'; readonly literal: string }
  | { readonly kind: 'omitted' }
  | { readonly kind: 'private' }
  | { readonly kind: 'unmodeled' }
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'catch-all'; readonly name: string; readonly optional: boolean }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'partial' };

/** 파일 경로 하나를 템플릿으로 바꾼 결과다(basePath·끝 슬래시 적용 전). */
export type RoutePath =
  /** 정규 템플릿 세그먼트. `optionalCatchAll`이면 마지막 세그먼트가 `[[...x]]`다. */
  | { readonly kind: 'template'; readonly segments: readonly string[]; readonly optionalCatchAll: boolean }
  /** 부분 동적 세그먼트처럼 Next의 해석이 갈리는 경로. `raw`는 원문 경로다. */
  | { readonly kind: 'dynamic'; readonly raw: string }
  /** `_` 비공개 폴더 아래라 라우트가 아니다. */
  | { readonly kind: 'private' }
  /** intercepting route·`@slot` 아래라 모델링하지 않는다. */
  | { readonly kind: 'unmodeled' }
  /** Next가 빌드에서 거부하는 세그먼트 이름이다. */
  | { readonly kind: 'invalid' };

/** intercepting route 표식(`shared/lib/router/utils/interception-routes.js`)이다. */
const interceptionMarkers = ['(..)(..)', '(.)', '(..)', '(...)'] as const;

/** 세그먼트 전체가 대괄호 하나 또는 두 겹인 동적 세그먼트다. */
const dynamicSegmentPattern = /^\[(\[)?(\.\.\.)?([^[\]]*)\]?\]$/u;

/**
 * 세그먼트 하나를 분류한다.
 *
 * @param segment 폴더·파일 이름(확장자 제거)
 * @param router 파일 라우터 종류
 * @returns 분류
 */
export function classifySegment(segment: string, router: NextRouter): SegmentClass {
  if (router === 'app') {
    const appClass = classifyAppConvention(segment);
    if (appClass !== undefined) return appClass;
  }
  if (segment.startsWith('[') && segment.endsWith(']')) return classifyDynamic(segment);
  if (segment.includes('[') || segment.includes(']')) return { kind: 'partial' };
  return { kind: 'static', literal: canonicalizeLiteral(segment) };
}

/**
 * App Router 전용 폴더 규칙(비공개·intercepting·group·slot)을 분류한다.
 *
 * intercepting 표식을 group보다 먼저 본다 — `(.)`처럼 group 모양이기도 한 이름을 경로에서
 * 빼 버리면 모델링하지 않은 규칙 위에서 사실을 내게 된다.
 *
 * @param segment 폴더 이름
 * @returns 분류, 해당 없으면 undefined
 */
function classifyAppConvention(segment: string): SegmentClass | undefined {
  if (segment.startsWith('_')) return { kind: 'private' };
  if (interceptionMarkers.some((marker) => segment.startsWith(marker))) return { kind: 'unmodeled' };
  if (segment.startsWith('(') && segment.endsWith(')')) return { kind: 'omitted' };
  if (segment.startsWith('@')) return { kind: 'unmodeled' };
  return undefined;
}

/**
 * `[`로 시작하고 `]`로 끝나는 세그먼트를 Next의 `UrlNode._insert` 규칙으로 분류한다.
 *
 * @param segment 세그먼트
 * @returns param·catch-all 또는 invalid
 */
function classifyDynamic(segment: string): SegmentClass {
  const match = dynamicSegmentPattern.exec(segment);
  if (match === null) return { kind: 'invalid' };
  const isDoubled = match[1] !== undefined;
  const isCatchAll = match[2] !== undefined;
  const name = match[3]!;
  // `[[x]]`(optional 단일 세그먼트)는 Next가 지원하지 않는다. 두 겹이면 끝도 두 겹이어야 한다.
  if (isDoubled !== segment.endsWith(']]') || (isDoubled && !isCatchAll)) return { kind: 'invalid' };
  if (name === '' || name.startsWith('.') || name.startsWith('…')) return { kind: 'invalid' };
  return isCatchAll ? { kind: 'catch-all', name, optional: isDoubled } : { kind: 'param', name };
}

/**
 * 라우터 루트 기준 세그먼트 목록(끝의 `route`·파일 이름 제거 후)을 템플릿으로 바꾼다.
 *
 * @param segments 폴더 세그먼트(Pages Router는 확장자·`index`를 뗀 파일 이름 포함)
 * @param router 파일 라우터 종류
 * @returns 경로 변환 결과
 */
export function toRoutePath(segments: readonly string[], router: NextRouter): RoutePath {
  const classes = segments.map((segment) => classifySegment(segment, router));
  const blocking = firstBlockingClass(classes);
  if (blocking !== undefined) return blocking;
  if (!hasValidDynamicNames(classes)) return { kind: 'invalid' };
  if (classes.some((segmentClass) => segmentClass.kind === 'partial')) {
    return { kind: 'dynamic', raw: `/${segments.join('/')}` };
  }
  return buildTemplate(classes);
}

/**
 * 경로 전체를 막는 분류를 우선순위대로 찾는다: 비공개 > 거부 > 미모델링.
 *
 * @param classes 세그먼트 분류
 * @returns 막는 결과 또는 undefined
 */
function firstBlockingClass(classes: readonly SegmentClass[]): RoutePath | undefined {
  if (classes.some((segmentClass) => segmentClass.kind === 'private')) return { kind: 'private' };
  if (classes.some((segmentClass) => segmentClass.kind === 'invalid')) return { kind: 'invalid' };
  if (classes.some((segmentClass) => segmentClass.kind === 'unmodeled')) return { kind: 'unmodeled' };
  return undefined;
}

/**
 * catch-all이 마지막이고 동적 이름이 겹치지 않는지 확인한다.
 *
 * Next는 같은 경로에서 같은 이름, 비단어 문자만 다른 이름을 거부한다(E247·E499).
 *
 * @param classes 세그먼트 분류(비공개·거부·미모델링 없음)
 * @returns 유효하면 true
 */
function hasValidDynamicNames(classes: readonly SegmentClass[]): boolean {
  const effective = classes.filter((segmentClass) => segmentClass.kind !== 'omitted');
  const catchAllIndex = effective.findIndex((segmentClass) => segmentClass.kind === 'catch-all');
  if (catchAllIndex !== -1 && catchAllIndex !== effective.length - 1) return false;
  const names = effective.flatMap((segmentClass) =>
    segmentClass.kind === 'param' || segmentClass.kind === 'catch-all' ? [segmentClass.name.replace(/\W/gu, '')] : []);
  return new Set(names).size === names.length;
}

/**
 * 분류를 템플릿 세그먼트로 바꾼다.
 *
 * @param classes 세그먼트 분류(정적·생략·param·catch-all만)
 * @returns 템플릿 결과
 */
function buildTemplate(classes: readonly SegmentClass[]): RoutePath {
  const output: string[] = [];
  let optionalCatchAll = false;
  for (const segmentClass of classes) {
    if (segmentClass.kind === 'static') output.push(segmentClass.literal);
    if (segmentClass.kind === 'param') output.push('{}');
    if (segmentClass.kind === 'catch-all') {
      output.push('{**}');
      optionalCatchAll = segmentClass.optional;
    }
  }
  return { kind: 'template', segments: output, optionalCatchAll };
}

/**
 * 세그먼트 목록을 basePath 뒤에 이어 경로 템플릿을 만든다.
 *
 * Next 루트 라우트는 basePath가 있으면 basePath 자체(`/docs`), 없으면 `/`다.
 *
 * @param basePath 정규화한 basePath(`''` 또는 `/`로 시작, 끝 슬래시 없음)
 * @param segments 템플릿 세그먼트
 * @returns 경로 템플릿
 */
export function joinTemplate(basePath: string, segments: readonly string[]): string {
  if (segments.length === 0) return basePath === '' ? '/' : basePath;
  return `${basePath}/${segments.join('/')}`;
}
