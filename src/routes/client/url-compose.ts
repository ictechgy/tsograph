/** HTTP-WRAPPERS 규칙으로 URL 조각과 라이브러리 base를 요청 경로로 바꾼다. */
import type { PathAnchor } from '../../exchange/bridge-facts.ts';
import { canonicalizeLiteralTemplate } from '../../openapi/path-template.ts';

/** 보간 값과 증명된 query 꼬리를 리터럴과 구분한다. */
export type UrlPart = { readonly literal: string } | { readonly value: true } | { readonly queryTail: true };
/** 라이브러리 소스·오라클로 확인한 결합 방식이다. */
export type UrlJoin = 'fetch' | 'axios-base-url' | 'ky-prefix-url' | 'ky-prefix' | 'ky-base-url';
/** 요청 경로만 담는다. 원문 식·userinfo·query 값은 보존하지 않는다. */
export interface ComposedUrl {
  readonly channel: string | null;
  readonly dynamic: boolean;
  readonly pathAnchor: PathAnchor;
  readonly authority?: string;
  readonly queryTailStripped?: true;
  readonly channelPrefix?: string;
  readonly maskedSegments?: number;
}

/** 리터럴 경로 안에서는 금지되는 NUL로 값 보간 자리를 구분한다. */
const HOLE = '\u0000';

/** query를 뗀 조각을 잇는다. 부분 세그먼트 보간은 정적 접두사만 남긴다. */
function assemble(parts: readonly UrlPart[]): { text: string; partial: boolean; query: boolean } {
  let text = '';
  let query = false;
  for (const [index, part] of parts.entries()) {
    if ('literal' in part) {
      if (/[\u0000-\u001F\u007F]|%00/iu.test(part.literal) || !part.literal.isWellFormed()) return { text, partial: true, query };
      const cut = part.literal.search(/[?#]/u);
      text += cut < 0 ? part.literal : part.literal.slice(0, cut);
      if (cut >= 0) { query = true; break; }
    } else if ('queryTail' in part && index === parts.length - 1) {
      query = true;
    } else {
      const next = parts[index + 1];
      const atEnd = next === undefined || ('queryTail' in next && index + 1 === parts.length - 1);
      if (!('value' in part) || !text.endsWith('/') || (!atEnd && (!('literal' in next) || !/^[/?#]/u.test(next.literal)))) {
        return { text, partial: true, query };
      }
      text += HOLE;
    }
  }
  return { text, partial: false, query };
}

/** 경로 정규화 후 값 보간을 계약의 `{}`로 되돌린다. */
function normalize(path: string): string {
  return path.split(HOLE).map(canonicalizeLiteralTemplate).join('{}');
}

/** 고엔트로피·웹훅 경로 세그먼트를 공유 마스킹 규칙으로 가린다. */
function mask(channel: string, authority: string | undefined): { channel: string; maskedSegments?: number } {
  let count = 0;
  const segments = channel.slice(1).split('/');
  const from = authority === 'hooks.slack.com' ? 0
    : (authority === 'discord.com' || authority === 'discordapp.com') && segments[0] === 'api' && segments[1] === 'webhooks' ? 2 : Infinity;
  const masked = segments.map((segment, index) => {
    if (segment.includes('{}')) return segment;
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { decoded = segment; }
    if (index >= from || (decoded.length >= 16 && /[A-Za-z]/u.test(decoded) && /[0-9]/u.test(decoded))) { count++; return '{}'; }
    return segment;
  });
  return { channel: `/${masked.join('/')}`, ...(count === 0 ? {} : { maskedSegments: count }) };
}

/** 절대 HTTP URL인지다. */
function absolute(text: string): boolean { return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(text) || text.startsWith('//'); }

/** base 미상일 때도 확정되는 접미사를 남긴다. 점 세그먼트는 앞 경로를 지울 수 있다. */
function unknownBase(path: string): { path: string; anchor: PathAnchor } | undefined {
  if (path === '' || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)|%2e|\\/iu.test(path)) return undefined;
  return { path: `/${path.replace(/^\/+/, '')}`, anchor: 'base' };
}

/** 결합 의미를 적용한다. 빈 문자열은 base 없음, null은 base 미상이다. */
function joinUrl(path: string, join: UrlJoin, base: string | null, allowAbsolute: boolean): { path: string; anchor: PathAnchor; authority?: string } | undefined {
  if (join === 'axios-base-url' && /^https?:(?!\/\/)/iu.test(path)) return undefined;
  let text = path;
  if (join === 'axios-base-url' && base !== '' && (!absolute(path) || !allowAbsolute)) {
    if (base === null) return unknownBase(path);
    text = path === '' ? base : `${base.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
  } else if ((join === 'ky-prefix-url' || join === 'ky-prefix') && base !== '') {
    if (join === 'ky-prefix-url' && path.startsWith('/')) return undefined;
    if (base === null) return unknownBase(path);
    text = join === 'ky-prefix-url' ? `${base}${base.endsWith('/') ? '' : '/'}${path}`
      : `${base.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
  } else if (join === 'ky-base-url' && !absolute(path) && base !== '') {
    if (base === null) return path.startsWith('/') ? parsedUrl(path, 'https://unknown.invalid') : unknownBase(path);
    return parsedUrl(path, base);
  }
  if (absolute(text)) return parsedUrl(text.startsWith('//') ? `https:${text}` : text);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(text)) return undefined;
  if (text.startsWith('/') && !text.startsWith('//')) return parsedUrl(text, 'https://unknown.invalid');
  return unknownBase(text);
}

/** WHATWG HTTP 파서로 송신 시 점 세그먼트·이스케이프를 반영한다. */
function parsedUrl(text: string, base?: string): { path: string; anchor: PathAnchor; authority?: string } | undefined {
  try {
    const url = new URL(text.replaceAll(HOLE, '%00'), base);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    return { path: url.pathname.replaceAll('%00', HOLE), anchor: 'root',
      ...(base === 'https://unknown.invalid' ? {} : { authority: url.host.toLowerCase() }) };
  } catch { return undefined; }
}

/** 공통 규칙으로 호출 URL을 만든다. 확정하지 못하면 null 채널과 안전한 접두사만 낸다. */
export function composeUrl(parts: readonly UrlPart[], join: UrlJoin = 'fetch', base: string | null = '', allowAbsolute = true): ComposedUrl {
  const assembled = assemble(parts.filter((part) => !('literal' in part) || part.literal !== ''));
  const joined = joinUrl(assembled.text, join, base, allowAbsolute);
  const common = { pathAnchor: joined?.anchor ?? 'base', ...(joined?.authority === undefined ? {} : { authority: joined.authority }) };
  if (assembled.partial || joined === undefined || normalize(joined.path).length > 2048) {
    const prefix = joined === undefined ? undefined : mask(normalize(joined.path), joined.authority).channel;
    return { ...common, channel: null, dynamic: true, ...(prefix === undefined || prefix.length > 2048 ? {} : { channelPrefix: prefix }) };
  }
  return { ...common, ...mask(normalize(joined.path), joined.authority), dynamic: false,
    ...(assembled.query ? { queryTailStripped: true } : {}) };
}
