/**
 * 추출한 Next.js 라우트 선언을 isthmus bridge-facts v1 `route-decl` 문서로 조립한다.
 *
 * 파일 시스템을 읽지 않는 순수 조립이다. 결정 사항(README "Decisions"와 같다):
 * - `symbol.qualifiedName`은 `<프로젝트 기준 파일 경로>#<내보낸 이름>`이다. Next가 호출하는 것은
 *   모듈의 내보낸 이름이므로 (모듈 경로, 내보낸 이름) 쌍이 핸들러 신원이다. `symbol.usr`는 같은 쌍에서
 *   만든 tsograph 그래프 id다(`src/graph/symbol-ids.ts`). CommonJS 내보내기는 usr가 없고
 *   `missing-route-usrs:`로 센다.
 * - `[[...x]]`는 `{**}` decl과 catch-all을 뗀 접두사 decl을 함께 낸다. 접두사 decl은 계약대로
 *   `catchAllPrefix: true`를 단다. isthmus가 이 표식에 `symbol.usr`를 요구하므로 usr가 없으면 표식 없이
 *   일반 decl로 낸다(Next는 같은 자리의 명시 라우트를 빌드 오류 E458로 막아 충돌하지 않는다).
 */

import {
  type BridgeLocation,
  formatBridgeTimestamp,
  type RouteDeclDocument,
  type RouteDeclFact,
} from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import type { NextRouteConfig } from './next-config.ts';
import type { DeclaredRoute, FrameworkSources, NextRoutesResult, RouteGaps } from './next-routes.ts';
import type { NextVersionStatus } from './project-config.ts';
import { MAX_ROUTE_FILE_BYTES } from './next-routes.ts';
import { type ChannelPolicy, channelFor, dynamicChannel, normalizeBasePath, type RouteChannel } from './route-channel.ts';
import { joinTemplate } from './next-path.ts';
import { MAX_SCAN_DEPTH, MAX_SCANNED_ENTRIES } from './project-scan.ts';

/** 문서 하나에 담는 최대 사실 수다. isthmus 입력 상한과 같다. */
export const MAX_ROUTE_FACTS = 100_000;

/** 사실 수가 상한을 넘었다. 부분 문서를 내지 않고 실패한다. */
export class RouteFactLimitError extends Error {
  constructor() {
    super(`project produces more than ${MAX_ROUTE_FACTS} route-decl facts`);
    this.name = 'RouteFactLimitError';
  }
}

/** 조립 입력이다. */
export interface RouteDocumentInput {
  readonly extraction: NextRoutesResult;
  readonly config: NextRouteConfig;
  readonly versionStatus: NextVersionStatus;
  readonly project: string;
  readonly service: string | undefined;
  readonly includeTests: boolean;
  readonly toolVersion: string;
  readonly generatedAt: Date;
}

/** basePath 판정이다. */
interface BasePathDecision {
  readonly policy: ChannelPolicy;
  /** basePath를 확정하지 못한 이유(limitation용) */
  readonly problem: 'unknown' | 'invalid' | undefined;
}

/**
 * route-decl 문서를 조립한다.
 *
 * @param input 조립 입력
 * @returns bridge-facts v1 문서
 * @throws RouteFactLimitError 사실 수가 상한을 넘을 때
 */
export function createRouteDocument(input: RouteDocumentInput): RouteDeclDocument {
  const decision = decideBasePath(input.config);
  // 선언 하나는 사실을 최대 둘 낸다. 펼치기 전에 세어 상한을 넘는 입력이 메모리를 먼저 쓰지 않게 한다.
  if (input.extraction.routes.length > MAX_ROUTE_FACTS) throw new RouteFactLimitError();
  const facts = sortAndDeduplicate(input.extraction.routes.flatMap((route) => routeFacts(route, decision.policy, input.service)));
  if (facts.length > MAX_ROUTE_FACTS) throw new RouteFactLimitError();
  return {
    format: 'bridge-facts',
    version: 1,
    tool: { name: 'tsograph', version: input.toolVersion },
    generatedAt: formatBridgeTimestamp(input.generatedAt),
    platform: 'js',
    target: 'http',
    roles: ['server'],
    dispatch: 'specificity',
    sourceSets: { tests: input.includeTests ? 'included' : 'excluded' },
    ...(input.service === undefined ? {} : { service: input.service }),
    project: input.project,
    facts,
    limitations: buildLimitations(input, decision),
  };
}

/**
 * basePath를 정하고 경로 규칙을 만든다. 확정하지 못하면 앵커를 base로 둔다.
 *
 * @param config 라우트 설정
 * @returns 경로 규칙과 문제
 */
function decideBasePath(config: NextRouteConfig): BasePathDecision {
  const shared = { trailingSlash: config.trailingSlash, skipTrailingSlashRedirect: config.skipTrailingSlashRedirect };
  if (config.basePath.kind === 'unknown') {
    return { policy: { basePath: '', pathAnchor: 'base', ...shared }, problem: 'unknown' };
  }
  const basePath = normalizeBasePath(config.basePath.value);
  if (basePath === undefined) return { policy: { basePath: '', pathAnchor: 'base', ...shared }, problem: 'invalid' };
  return { policy: { basePath, pathAnchor: 'root', ...shared }, problem: undefined };
}

/**
 * 선언 하나를 사실로 바꾼다. optional catch-all이면 접두사 사실을 하나 더 낸다.
 *
 * @param route 선언
 * @param policy 경로 규칙
 * @param service 서비스 신원
 * @returns 사실 목록
 */
function routeFacts(route: DeclaredRoute, policy: ChannelPolicy, service: string | undefined): RouteDeclFact[] {
  if (route.path.kind === 'dynamic') {
    return [fact(route, dynamicChannel(joinTemplate(policy.basePath, [route.path.raw.slice(1)]), policy.pathAnchor), service)];
  }
  const facts = [fact(route, channelFor(route.path.segments, policy), service)];
  if (route.path.optionalCatchAll) {
    const prefix = fact(route, channelFor(route.path.segments.slice(0, -1), policy), service);
    facts.push(route.usr === undefined ? prefix : { ...prefix, catchAllPrefix: true });
  }
  return facts;
}

/**
 * 사실 하나를 만든다.
 *
 * @param route 선언
 * @param shape 경로 부분
 * @param service 서비스 신원
 * @returns route-decl 사실
 */
function fact(route: DeclaredRoute, shape: RouteChannel, service: string | undefined): RouteDeclFact {
  const location: BridgeLocation = { path: route.file, ...route.position };
  return {
    kind: 'route-decl',
    method: route.method,
    channel: shape.channel,
    dynamic: shape.dynamic,
    pathAnchor: shape.pathAnchor,
    ...(service === undefined ? {} : { service }),
    ...(shape.trailingSlash === undefined ? {} : { trailingSlash: shape.trailingSlash }),
    ...(route.testSource ? { testSource: true as const } : {}),
    location,
    symbol: {
      qualifiedName: `${route.file}#${route.exportName}`,
      ...(route.usr === undefined ? {} : { usr: route.usr }),
    },
  };
}

/**
 * 사실을 결정적으로 정렬하고 완전히 같은 사실을 하나로 줄인다.
 *
 * @param facts 사실 목록
 * @returns 정렬·중복 제거한 목록
 */
function sortAndDeduplicate(facts: readonly RouteDeclFact[]): RouteDeclFact[] {
  const unique = new Map(facts.map((entry) => [JSON.stringify(entry), entry]));
  return [...unique.values()].sort(compareFacts);
}

/**
 * 사실을 (channel, method, 앵커, dynamic, 파일, 줄, 열) 순서로 비교한다.
 *
 * @param left 왼쪽 사실
 * @param right 오른쪽 사실
 * @returns 음수·0·양수
 */
function compareFacts(left: RouteDeclFact, right: RouteDeclFact): number {
  return compareStrings(left.channel, right.channel)
    || compareStrings(left.method, right.method)
    || compareStrings(left.pathAnchor, right.pathAnchor)
    || Number(left.dynamic) - Number(right.dynamic)
    || compareStrings(left.location.path, right.location.path)
    || left.location.line - right.location.line
    || left.location.column - right.location.column;
}

/**
 * limitation 문장을 모은다. 서버 측 접두사는 계약의 닫힌 목록에서만 쓴다.
 *
 * @param input 조립 입력
 * @param decision basePath 판정
 * @returns 정렬한 limitation 목록
 */
function buildLimitations(input: RouteDocumentInput, decision: BasePathDecision): string[] {
  return [
    ...configLimitations(input.config, decision),
    ...frameworkLimitations(input.extraction.frameworkSources),
    ...gapLimitations(input.extraction.gaps),
    ...directoryLimitations(input.extraction),
    ...versionLimitations(input.versionStatus),
    ...usrLimitations(input.extraction.routes),
  ].sort(compareStrings);
}

/**
 * 설정에서 온 limitation이다.
 *
 * @param config 라우트 설정
 * @param decision basePath 판정
 * @returns limitation 목록
 */
function configLimitations(config: NextRouteConfig, decision: BasePathDecision): string[] {
  const name = config.fileName ?? 'next.config';
  const reasons: Record<NonNullable<NextRouteConfig['unresolvedReason']>, string> = {
    'no-export': 'it has no default export or module.exports assignment',
    'function-export': 'it exports a function whose result depends on execution',
    'non-literal-export': 'its export does not resolve to an object literal',
    'syntax-error': 'it has syntax errors',
    unreadable: 'it could not be read as UTF-8 text within the size limit',
    symlink: 'it is a symbolic link, which tsograph does not follow',
  };
  const lines: string[] = [];
  if (config.unresolvedReason !== undefined) {
    lines.push(`unresolved-route-prefix: ${name} could not be resolved statically (${reasons[config.unresolvedReason]}); basePath, trailingSlash, and pageExtensions are unknown, so facts use pathAnchor base and the default page extensions`);
  } else if (decision.problem === 'unknown') {
    lines.push(`unresolved-route-prefix: ${name} basePath is not a string literal tsograph can resolve; facts use pathAnchor base`);
  } else if (decision.problem === 'invalid') {
    lines.push(`unresolved-route-prefix: ${name} basePath is not a value Next.js accepts (empty, or starting with "/" without a trailing "/"); facts use pathAnchor base`);
  }
  if (config.unresolvedReason === undefined && config.wrapperCalls > 0) {
    lines.push(`unresolved-route-prefix: ${name} passes its configuration through ${config.wrapperCalls} wrapper call(s); basePath and trailing-slash settings were read from the wrapped object literal, but a wrapper may change them or add routes`);
  }
  if (config.unresolvedReason === undefined && config.pageExtensions.kind === 'unknown') {
    lines.push(`route-coverage: ${name} pageExtensions is not a literal string array; the default extensions (tsx, ts, jsx, js) were used, so route files with other extensions may be missing`);
  }
  if (config.frameworkRouteKeys.length > 0) {
    lines.push(`framework-provided-routes: ${name} declares ${config.frameworkRouteKeys.join(', ')}; paths they add, localize, or redirect are not modeled`);
  }
  if (config.fileName !== undefined && config.hasUnknownKeys) {
    lines.push(`framework-provided-routes: ${name} has configuration keys tsograph cannot enumerate (spread, computed, or unresolved); rewrites, redirects, or i18n may be present and are not modeled`);
  }
  return lines;
}

/**
 * 파일 라우트 밖 경로 근거의 limitation이다.
 *
 * @param sources framework 경로 근거
 * @returns limitation 목록
 */
function frameworkLimitations(sources: FrameworkSources): string[] {
  const candidates: [boolean, string][] = [
    [sources.proxyFiles.length > 0, `framework-provided-routes: ${sources.proxyFiles.join(', ')} can answer or rewrite requests before file routing (Next.js proxy/middleware); those paths are not modeled`],
    [sources.metadataFiles > 0, `framework-provided-routes: ${sources.metadataFiles} metadata file(s) under the app directory (sitemap, robots, manifest, icons, Open Graph or Twitter images) serve framework-generated routes that are not modeled`],
    [sources.hasPublicFiles, 'framework-provided-routes: the public/ directory serves static files at the site root; they are not modeled'],
  ];
  return candidates.filter(([applies]) => applies).map(([, text]) => text);
}

/**
 * 스캔·추출 공백의 limitation이다.
 *
 * @param gaps 공백 계수
 * @returns limitation 목록
 */
function gapLimitations(gaps: RouteGaps): string[] {
  const candidates: [number, string][] = [
    [gaps.symlinks, `route-coverage: ${gaps.symlinks} symbolic link(s) under the app or pages directories were not followed`],
    [gaps.unreadableDirectories, `route-coverage: ${gaps.unreadableDirectories} director(ies) could not be listed`],
    [gaps.unsafeNames, `route-coverage: ${gaps.unsafeNames} file or directory name(s) contain characters the exchange format forbids and were skipped`],
    [Number(gaps.truncated), `route-coverage: the directory scan stopped at ${MAX_SCANNED_ENTRIES} entries or depth ${MAX_SCAN_DEPTH}; later route files were not scanned`],
    [gaps.unreadableFiles, `route-coverage: ${gaps.unreadableFiles} route file(s) could not be read as UTF-8 text within ${MAX_ROUTE_FILE_BYTES} bytes and were skipped`],
    [gaps.unparsedFiles, `route-coverage: ${gaps.unparsedFiles} route file(s) use a non-JavaScript page extension and were not parsed`],
    [gaps.syntaxErrorFiles, `route-coverage: ${gaps.syntaxErrorFiles} route file(s) have syntax errors; their exported handlers may be incomplete`],
    [gaps.unresolvedExportFiles, `route-coverage: ${gaps.unresolvedExportFiles} route file(s) use export * or CommonJS exports whose names cannot be enumerated statically; their HTTP method handlers may be incomplete`],
    [gaps.unmodeledFiles, `route-coverage: ${gaps.unmodeledFiles} route file(s) are under parallel-route slots (@name) or intercepting-route segments ((.)name), which Next.js documents for pages only; they were not modeled`],
    [gaps.invalidSegmentFiles, `route-coverage: ${gaps.invalidSegmentFiles} route file(s) use dynamic segment names Next.js rejects at build time and were skipped`],
    [gaps.dynamicPathFiles, `route-coverage: ${gaps.dynamicPathFiles} route file(s) have a segment that mixes brackets with other text, which Next.js does not document; their facts are dynamic`],
    [gaps.pagesWithoutDefaultExport, `route-coverage: ${gaps.pagesWithoutDefaultExport} pages/api file(s) have no statically visible default export or module.exports assignment; no declaration was emitted for them`],
  ];
  return candidates.filter(([count]) => count > 0).map(([, text]) => text);
}

/**
 * 라우터 디렉터리가 없거나 최상위 위치가 symlink일 때의 limitation이다.
 *
 * @param extraction 추출 결과
 * @returns limitation 목록
 */
function directoryLimitations(extraction: NextRoutesResult): string[] {
  const { appDirectory, pagesDirectory, symlinkedLocations } = extraction.routerDirectories;
  const lines = symlinkedLocations.length === 0 ? [] : [
    `route-coverage: top-level route locations are symbolic links and were not followed (${symlinkedLocations.join(', ')}); routes behind them were not scanned`,
  ];
  if (appDirectory !== undefined || pagesDirectory !== undefined || symlinkedLocations.length > 0) return lines;
  return ['route-coverage: no app or pages directory was found at the project root or under src/; no Next.js routes were scanned'];
}

/**
 * 그래프 id가 없는 선언의 limitation이다. isthmus trace가 핸들러에서 언어 내부로 이어가지 못하는 곳이다.
 *
 * @param routes 선언 목록
 * @returns limitation 목록
 */
function usrLimitations(routes: readonly DeclaredRoute[]): string[] {
  const missing = routes.filter((route) => route.usr === undefined).length;
  if (missing === 0) return [];
  return [`missing-route-usrs: ${missing} route declaration(s) come from CommonJS exports and carry no symbol.usr; tsograph graph has no named node for them`];
}

/**
 * 선언된 Next 버전의 limitation이다.
 *
 * @param status 버전 판정
 * @returns limitation 목록
 */
function versionLimitations(status: NextVersionStatus): string[] {
  if (status.kind === 'verified') return [];
  const reason = status.kind === 'undeclared'
    ? 'package.json at the project root is missing, unreadable, a symbolic link, or does not declare a next dependency'
    : 'the declared next version range is not limited to major version 16';
  return [`route-framework-version-unknown: ${reason}; tsograph models Next.js 16 routing semantics`];
}
