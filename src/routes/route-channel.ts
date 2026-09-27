/**
 * 템플릿 세그먼트에 basePath와 끝 슬래시 규칙을 적용해 사실의 channel을 만든다.
 *
 * 확인한 Next.js 16.2.7 동작:
 * - basePath는 `''`이거나 `/`로 시작하고 `/`로 끝나지 않으며 `/` 자체가 아니어야 한다
 *   (`server/config.js`). 어기면 Next가 시작하지 않으므로 확정 값으로 쓰지 않는다.
 * - 라우트 매칭은 끝 슬래시를 떼고 한다(`server/lib/router-utils/filesystem.js`, `route-regex.js`의
 *   `(?:/)?`). 그 앞에서 `lib/load-custom-routes.js`의 내부 308 redirect가 정규 형태로 보낸다:
 *   - `trailingSlash: false`(기본): `/:path+/` → `/:path+`. 정규 형태는 끝 슬래시 없음.
 *   - `trailingSlash: true`: 마지막 세그먼트에 `.`이 없으면 슬래시를 붙이고(`/:notfile`),
 *     `이름.확장자` 모양이면 슬래시를 뗀다(`/:file`). `.well-known` 아래는 둘 다 제외.
 *   - `skipTrailingSlashRedirect: true`면 redirect가 없어 두 형태가 모두 핸들러에 닿는다.
 * redirect로만 닿는 형태는 핸들러가 받는 형태가 아니므로 `strict`, redirect 없이 두 형태가 닿으면
 * `optional`, 값이 경로 파라미터에 달려 정할 수 없으면 필드를 생략(unknown)한다.
 */

import type { PathAnchor } from '../exchange/bridge-facts.ts';
import { canonicalizeLiteralTemplate, MAX_TEMPLATE_LENGTH, sanitizeDynamicChannel } from '../openapi/path-template.ts';
import { joinTemplate } from './next-path.ts';
import type { Resolved } from './next-config.ts';

/** 끝 슬래시 규칙이다. */
export type TrailingSlashRule = 'strict' | 'optional';

/** 사실의 경로 부분이다. */
export interface RouteChannel {
  readonly channel: string;
  readonly dynamic: boolean;
  readonly pathAnchor: PathAnchor;
  readonly trailingSlash: TrailingSlashRule | undefined;
}

/** 프로젝트 전체에 같은 경로 규칙이다. */
export interface ChannelPolicy {
  /** 정규화한 basePath(`''` 또는 `/x`). 확정하지 못했으면 `''`이고 앵커가 base다. */
  readonly basePath: string;
  readonly pathAnchor: PathAnchor;
  readonly trailingSlash: Resolved<boolean>;
  readonly skipTrailingSlashRedirect: Resolved<boolean>;
}

/** `name.ext` 모양 세그먼트(`/:file` redirect의 마지막 세그먼트)다. */
const fileLikeSegment = /^[^/]+\.\w+$/u;

/**
 * basePath 원문을 정규화한다. Next가 거부하는 값이면 undefined다.
 *
 * @param basePath 설정의 basePath 문자열
 * @returns 정규화한 basePath 또는 undefined
 */
export function normalizeBasePath(basePath: string): string | undefined {
  if (basePath === '') return '';
  if (basePath === '/' || !basePath.startsWith('/') || basePath.endsWith('/')) return undefined;
  if (!basePath.isWellFormed() || /[?#]/u.test(basePath)) return undefined;
  const canonical = canonicalizeLiteralTemplate(basePath);
  const segments = canonical.split('/').slice(1);
  return segments.some((segment) => segment === '' || segment === '.' || segment === '..') ? undefined : canonical;
}

/**
 * 템플릿 세그먼트를 사실의 경로 부분으로 바꾼다.
 *
 * @param segments 라우터 루트 기준 템플릿 세그먼트
 * @param policy 경로 규칙
 * @returns channel·dynamic·앵커·끝 슬래시
 */
export function channelFor(segments: readonly string[], policy: ChannelPolicy): RouteChannel {
  const shaped = applyTrailingSlash(segments, policy);
  const template = joinTemplate(policy.basePath, segments);
  const channel = shaped.appendSlash ? `${template}/` : template;
  if (channel.length > MAX_TEMPLATE_LENGTH) return dynamicChannel(channel, policy.pathAnchor);
  return { channel, dynamic: false, pathAnchor: policy.pathAnchor, trailingSlash: shaped.rule };
}

/**
 * 정규 템플릿으로 만들 수 없는 원문 경로를 dynamic channel로 만든다.
 *
 * @param rawPath 원문 경로(basePath 포함)
 * @param pathAnchor 앵커
 * @returns dynamic 경로 부분
 */
export function dynamicChannel(rawPath: string, pathAnchor: PathAnchor): RouteChannel {
  return { channel: sanitizeDynamicChannel(rawPath), dynamic: true, pathAnchor, trailingSlash: undefined };
}

/**
 * 끝 슬래시 규칙과 정규 형태에 슬래시를 붙일지 정한다.
 *
 * @param segments 템플릿 세그먼트
 * @param policy 경로 규칙
 * @returns 규칙(생략 가능)과 슬래시 추가 여부
 */
function applyTrailingSlash(
  segments: readonly string[],
  policy: ChannelPolicy,
): { rule: TrailingSlashRule | undefined; appendSlash: boolean } {
  const skip = policy.skipTrailingSlashRedirect;
  if (skip.kind === 'known' && skip.value) return { rule: 'optional', appendSlash: false };
  if (skip.kind === 'unknown' || policy.trailingSlash.kind === 'unknown') return { rule: undefined, appendSlash: false };
  if (!policy.trailingSlash.value) return { rule: 'strict', appendSlash: false };
  return trailingSlashTrueRule(segments, policy.basePath);
}

/**
 * `trailingSlash: true`일 때 세그먼트별 정규 형태를 정한다.
 *
 * @param segments 템플릿 세그먼트
 * @param basePath 정규화한 basePath
 * @returns 규칙과 슬래시 추가 여부
 */
function trailingSlashTrueRule(segments: readonly string[], basePath: string): { rule: TrailingSlashRule | undefined; appendSlash: boolean } {
  const last = segments.at(-1);
  // 루트: basePath가 있으면 basePath → basePath/ redirect가 따로 있다. 없으면 `/` 자체가 정규 형태다.
  if (last === undefined) return { rule: 'strict', appendSlash: basePath !== '' };
  if (segments[0] === '.well-known') return { rule: 'optional', appendSlash: false };
  if (last.includes('{')) return { rule: undefined, appendSlash: false };
  if (!last.includes('.')) return { rule: 'strict', appendSlash: true };
  return fileLikeSegment.test(last) ? { rule: 'strict', appendSlash: false } : { rule: 'optional', appendSlash: false };
}
