/**
 * OpenAPI servers(3.x)·basePath(2.0)에서 경로 접두사를 해석한다.
 *
 * host·scheme·port는 조인 키가 아니므로 버리고, 경로 부분만 정규 템플릿의
 * 접두사로 합성한다. 확정할 수 없는 경로 부분은 추측하지 않고 `base` 꼬리로
 * 돌려준다 — 호출자가 `pathAnchor: "base"`와 `unresolved-contract-servers:`를 낸다.
 *
 * 서버 변수 규칙(fail-closed, README 결정 목록):
 * - `enum`이 있으면 값 집합이 닫혀 있으므로 값마다 펼친다(조합 상한 있음).
 * - `enum` 없이 `default`만 있으면 클라이언트가 임의 값으로 바꿀 수 있는 열린 값이라
 *   경로 부분에 있을 때 확정하지 않는다. scheme·host 부분에 있으면 버려지므로 무관하다.
 */

import { canonicalizeLiteral } from './percent-encoding.ts';

/** 서버 변수 조합을 펼치는 최대 개수다. 넘으면 해석하지 않고 base로 낸다. */
export const MAX_SERVER_COMBINATIONS = 256;

/**
 * 한 서버 목록이 만드는 경로 접두사 집합이다.
 *
 * `roots`는 확정한 접두사(`''`은 서버 루트), `baseTails`는 알 수 없는 base 뒤에
 * 붙는 것이 확실한 리터럴 꼬리다(`''`이면 꼬리 없음). 둘 다 정렬·중복 제거돼 있다.
 */
export interface ServerPrefixes {
  readonly roots: readonly string[];
  readonly baseTails: readonly string[];
}

/** 서버 변수 하나의 선언이다. */
export interface ServerVariable {
  /** 닫힌 값 집합(`enum`). 없거나 비었거나 문자열이 아닌 원소가 있으면 undefined다. */
  readonly values: readonly string[] | undefined;
  /** `default` 값. 없으면 undefined다. */
  readonly defaultValue: string | undefined;
}

/** 서버가 없을 때의 기본값(OpenAPI 3.x: url `/`)이다. */
export const DEFAULT_SERVER_PREFIXES: ServerPrefixes = { roots: [''], baseTails: [] };

/** 경로를 전혀 확정하지 못했을 때의 결과다. 스펙 경로만 base로 남긴다. */
export const UNRESOLVED_SERVER_PREFIXES: ServerPrefixes = { roots: [], baseTails: [''] };

/** 템플릿 URL의 조각이다. 리터럴 문자열이거나 변수 참조다. */
type UrlToken = string | { readonly variable: string };

/** 치환한 URL 안에서 열린(enum 없는) 변수가 차지한 구간이다. */
interface FreeSpan {
  readonly start: number;
  readonly end: number;
}

/** 치환한 URL 하나의 해석 결과다. */
type ConcreteResolution =
  | { readonly kind: 'root'; readonly prefix: string }
  | { readonly kind: 'base'; readonly tail: string };

/**
 * 여러 해석 결과를 하나로 합친다.
 *
 * @param parts 합칠 결과들
 * @returns 정렬·중복 제거한 합집합
 */
export function mergeServerPrefixes(parts: readonly ServerPrefixes[]): ServerPrefixes {
  return {
    roots: sortedUnique(parts.flatMap((part) => part.roots)),
    baseTails: sortedUnique(parts.flatMap((part) => part.baseTails)),
  };
}

/**
 * Swagger 2.0 basePath를 해석한다.
 *
 * basePath는 `/`로 시작해야 하고 템플릿을 지원하지 않는다. 규칙을 어기면 의미를
 * 확정할 수 없어 base로 낸다.
 *
 * @param basePath basePath 문자열. 필드가 없으면 undefined
 * @param isPresent 필드가 있었는지(문자열이 아닌 값이 있었던 경우를 구분)
 * @returns 접두사 집합
 */
export function resolveBasePath(basePath: string | undefined, isPresent: boolean): ServerPrefixes {
  if (!isPresent) return DEFAULT_SERVER_PREFIXES;
  const isValid = basePath !== undefined
    && basePath.startsWith('/')
    && basePath.isWellFormed()
    && !/[{}?#]/u.test(basePath);
  return isValid ? { roots: [canonicalizeLiteralPath(basePath)], baseTails: [] } : UNRESOLVED_SERVER_PREFIXES;
}

/**
 * OpenAPI 3.x 서버 URL 하나를 해석한다.
 *
 * @param url 서버 URL 템플릿(예: `https://{region}.example.com/api/{version}`)
 * @param variables 서버 변수 선언
 * @returns 접두사 집합
 */
export function resolveServerUrl(
  url: string,
  variables: ReadonlyMap<string, ServerVariable>,
): ServerPrefixes {
  const tokens = url.isWellFormed() ? tokenizeServerUrl(url) : undefined;
  if (tokens === undefined) return UNRESOLVED_SERVER_PREFIXES;
  const combinations = enumerateCombinations(tokens, variables);
  if (combinations === undefined) return UNRESOLVED_SERVER_PREFIXES;
  const resolutions = combinations.map((pinned) => {
    const { text, spans } = substituteVariables(tokens, variables, pinned);
    return classifyConcreteUrl(text, spans);
  });
  return {
    roots: sortedUnique(resolutions.flatMap((item) => (item.kind === 'root' ? [item.prefix] : []))),
    baseTails: sortedUnique(resolutions.flatMap((item) => (item.kind === 'base' ? [item.tail] : []))),
  };
}

/**
 * URL 템플릿을 리터럴과 `{name}` 변수 조각으로 나눈다.
 *
 * @param url 서버 URL 템플릿
 * @returns 조각 목록. 중괄호가 짝이 맞지 않으면 undefined
 */
function tokenizeServerUrl(url: string): UrlToken[] | undefined {
  const tokens: UrlToken[] = [];
  const pattern = /\{([^{}]*)\}|[{}]/gu;
  let last = 0;
  for (const match of url.matchAll(pattern)) {
    if (match[1] === undefined) return undefined;
    tokens.push(url.slice(last, match.index), { variable: match[1] });
    last = match.index + match[0].length;
  }
  tokens.push(url.slice(last));
  return tokens;
}

/**
 * enum이 있는 변수의 값 조합을 모두 만든다.
 *
 * @param tokens URL 조각
 * @param variables 변수 선언
 * @returns 변수 이름 → 값 사상의 목록. 상한을 넘으면 undefined
 */
function enumerateCombinations(
  tokens: readonly UrlToken[],
  variables: ReadonlyMap<string, ServerVariable>,
): ReadonlyMap<string, string>[] | undefined {
  let combinations: Map<string, string>[] = [new Map()];
  for (const name of referencedVariableNames(tokens)) {
    const values = variables.get(name)?.values;
    if (values === undefined) continue;
    if (combinations.length * values.length > MAX_SERVER_COMBINATIONS) return undefined;
    combinations = combinations.flatMap((base) => values.map((value) => new Map(base).set(name, value)));
  }
  return combinations;
}

/**
 * URL에 등장하는 변수 이름을 처음 등장 순서로 중복 없이 돌려준다.
 *
 * @param tokens URL 조각
 * @returns 변수 이름 목록
 */
function referencedVariableNames(tokens: readonly UrlToken[]): string[] {
  const names = tokens.flatMap((token) => (typeof token === 'string' ? [] : [token.variable]));
  return [...new Set(names)];
}

/**
 * 변수를 치환한 URL과 열린 변수가 차지한 구간을 만든다.
 *
 * enum 변수는 조합의 값으로, 열린 변수는 default(없으면 빈 문자열)로 채운다.
 * 열린 변수의 값은 구조 판별(경로가 어디서 시작하는지)에만 쓰고, 경로 부분에
 * 걸리면 호출자가 그 구간을 미확정으로 처리한다.
 *
 * @param tokens URL 조각
 * @param variables 변수 선언
 * @param pinned 이번 조합의 enum 변수 값
 * @returns 치환한 텍스트와 열린 변수 구간
 */
function substituteVariables(
  tokens: readonly UrlToken[],
  variables: ReadonlyMap<string, ServerVariable>,
  pinned: ReadonlyMap<string, string>,
): { text: string; spans: FreeSpan[] } {
  let text = '';
  const spans: FreeSpan[] = [];
  for (const token of tokens) {
    if (typeof token === 'string') {
      text += token;
      continue;
    }
    const pinnedValue = pinned.get(token.variable);
    if (pinnedValue !== undefined) {
      text += pinnedValue;
      continue;
    }
    const start = text.length;
    text += variables.get(token.variable)?.defaultValue ?? '';
    spans.push({ start, end: text.length });
  }
  return { text, spans };
}

/**
 * 치환한 URL에서 경로 부분을 찾아 root 접두사 또는 base 꼬리로 분류한다.
 *
 * - `scheme://authority/path`·`//authority/path`: authority 뒤가 경로다.
 * - `/path`: 문서를 제공하는 host 기준 절대 경로다.
 * - 그 밖(`v1`, `./v1`): 문서 위치 기준 상대 URL이라 앞부분을 알 수 없다(base).
 *
 * @param rawText 치환한 URL
 * @param rawSpans 열린 변수 구간
 * @returns 분류 결과
 */
function classifyConcreteUrl(rawText: string, rawSpans: readonly FreeSpan[]): ConcreteResolution {
  const cut = rawText.search(/[?#]/u);
  const text = cut === -1 ? rawText : rawText.slice(0, cut);
  const spans = rawSpans
    .filter((span) => span.start < text.length || span.start === span.end)
    .map((span) => ({ start: span.start, end: Math.min(span.end, text.length) }));
  const authorityStart = findAuthorityStart(text);
  if (authorityStart === 'opaque') return { kind: 'base', tail: '' };
  if (authorityStart === undefined && !text.startsWith('/')) {
    return { kind: 'base', tail: literalTail(text, 0, spans, true) };
  }
  const pathStart = authorityStart === undefined ? 0 : findPathStart(text, authorityStart);
  const pathSpans = spans.filter((span) => !isHarmlessAuthoritySpan(text, span, pathStart));
  if (pathSpans.length > 0) return { kind: 'base', tail: literalTail(text, pathStart, pathSpans, false) };
  return { kind: 'root', prefix: canonicalizeLiteralPath(text.slice(pathStart)) };
}

/**
 * authority가 시작하는 위치를 찾는다.
 *
 * @param text query를 뗀 URL
 * @returns authority 시작 오프셋, 계층 없는 scheme(`urn:`)이면 'opaque', 없으면 undefined
 */
function findAuthorityStart(text: string): number | 'opaque' | undefined {
  if (text.startsWith('//')) return 2;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/u.exec(text);
  if (scheme === null) return undefined;
  return text.startsWith('//', scheme[0].length) ? scheme[0].length + 2 : 'opaque';
}

/**
 * authority 뒤 경로가 시작하는 위치를 찾는다.
 *
 * @param text URL
 * @param authorityStart authority 시작 오프셋
 * @returns 경로 시작 오프셋(경로가 없으면 텍스트 끝)
 */
function findPathStart(text: string, authorityStart: number): number {
  const slash = text.indexOf('/', authorityStart);
  return slash === -1 ? text.length : slash;
}

/**
 * 열린 변수 구간이 경로에 영향을 주지 않는 scheme·authority 안쪽인지 판단한다.
 *
 * 구간이 경로 시작 전에 끝나고 값에 `/`가 없어야 한다. 값에 `/`가
 * 있으면 다른 값으로 바뀔 때 경로 시작점이 달라질 수 있다.
 *
 * @param text URL
 * @param span 열린 변수 구간
 * @param pathStart 경로 시작 오프셋
 * @returns 경로와 무관하면 true
 */
function isHarmlessAuthoritySpan(text: string, span: FreeSpan, pathStart: number): boolean {
  // 빈 값 구간이 경로 시작점에 붙어 있으면, 뒤에 리터럴 `/`가 있을 때만 authority 쪽이다.
  // 경로가 없는 URL 끝의 빈 변수는 경로 자리일 수 있다.
  const isBeforePath = span.start < pathStart || pathStart < text.length;
  return span.end <= pathStart && isBeforePath && !text.slice(span.start, span.end).includes('/');
}

/**
 * 미확정 앞부분 뒤에 확실히 붙는 리터럴 꼬리를 만든다.
 *
 * 열린 변수가 걸친 마지막 세그먼트 뒤의 세그먼트만 남긴다. 문서 기준 상대
 * URL이면 `.`은 버리고 `..`는 알 수 없는 세그먼트를 지우므로 그 뒤부터 남긴다.
 *
 * @param text URL
 * @param pathStart 경로 시작 오프셋
 * @param spans 경로에 걸린 열린 변수 구간
 * @param isDocumentRelative 문서 기준 상대 URL인지
 * @returns 정규 꼬리(`''` 또는 `/`로 시작)
 */
function literalTail(
  text: string,
  pathStart: number,
  spans: readonly FreeSpan[],
  isDocumentRelative: boolean,
): string {
  const segments: string[] = [];
  let offset = pathStart;
  for (const segment of text.slice(pathStart).split('/')) {
    const end = offset + segment.length;
    const touchesSpan = spans.some((span) => span.start <= end && span.end >= offset);
    const isDotReset = isDocumentRelative && segment === '..';
    if (touchesSpan || isDotReset) segments.length = 0;
    else if (!(isDocumentRelative && segment === '.')) segments.push(segment);
    offset = end + 1;
  }
  const kept = segments[0] === '' ? segments.slice(1) : segments;
  return kept.length === 0 ? '' : canonicalizeLiteralPath(`/${kept.join('/')}`);
}

/**
 * 변수 없는 경로를 정규 리터럴 경로로 바꾸고 끝 슬래시 하나를 뗀다.
 *
 * 서버 URL의 끝 슬래시는 스펙 경로와 이어 붙일 때 관례상 한 번 접힌다
 * (`https://h/v1/` + `/items` = `/v1/items`). 결과는 `''`(서버 루트) 또는 `/`로 시작한다.
 *
 * @param path `''` 또는 `/`로 시작하는 경로
 * @returns 정규 접두사
 */
export function canonicalizeLiteralPath(path: string): string {
  const canonical = path.split('/').map(canonicalizeLiteral).join('/');
  return canonical.endsWith('/') ? canonical.slice(0, -1) : canonical;
}

/**
 * 문자열을 정렬하고 중복을 제거한다.
 *
 * @param values 문자열 목록
 * @returns UTF-16 코드 단위 순서의 고유 목록
 */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
