/**
 * persistence `relation-use` 사실을 모으고, 검증·중복 제거·정렬한다.
 *
 * 계약(isthmus `docs/GRAPH-EXCHANGE.md` persistence 절): channel은 관계 이름(코드에 쓰인 그대로,
 * 한정·비한정), method는 선택적 컬럼 이름, dynamic은 조인할 수 없는 사용, location은 필수다.
 * 제어 문자가 섞인 이름은 소비자가 문서 전체를 거부하므로 사실로 내지 않고 센다.
 */

import { isSafeIdentifier, type BridgeLocation } from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import type { SourceText } from './source-text.ts';

/** 관계 사용 사실 하나다. */
export interface RelationUseFact {
  readonly kind: 'relation-use';
  readonly channel: string;
  readonly method?: string;
  readonly dynamic: boolean;
  readonly location: BridgeLocation;
  readonly symbol?: { readonly qualifiedName: string };
}

/** 사실 하나를 만들 입력이다. */
export interface FactInput {
  readonly channel: string;
  readonly method?: string | undefined;
  readonly dynamic: boolean;
  readonly path: string;
  readonly text: SourceText;
  readonly offset: number;
  readonly symbol: string | undefined;
}

/** dynamic 사실의 channel 요약 최대 길이(UTF-16 코드 단위)다. 가족 생산자와 같다. */
export const MAX_DYNAMIC_CHANNEL_LENGTH = 160;

/** 사실 수집기다. */
export class RelationFactSink {
  /** 중복 제거 키 → 사실이다. */
  private readonly facts = new Map<string, RelationUseFact>();
  /** 제어 문자·빈 값이라 버린 이름 수다. */
  invalidNames = 0;

  /**
   * 사실 하나를 넣는다. 같은 위치·채널·컬럼·dynamic의 사실은 한 번만 남긴다.
   *
   * @param input 사실 입력
   */
  add(input: FactInput): void {
    if (!isSafeIdentifier(input.channel) || input.channel.trim().length === 0
      || (input.method !== undefined && (!isSafeIdentifier(input.method) || input.method.trim().length === 0))) {
      this.invalidNames++;
      return;
    }
    const { line, column } = input.text.locate(input.offset);
    const symbol = input.symbol !== undefined && isSafeIdentifier(input.symbol) ? input.symbol : undefined;
    const fact: RelationUseFact = {
      kind: 'relation-use',
      channel: input.channel,
      ...(input.method === undefined ? {} : { method: input.method }),
      dynamic: input.dynamic,
      location: { path: input.path, line, column },
      ...(symbol === undefined ? {} : { symbol: { qualifiedName: symbol } }),
    };
    const key = [input.path, line, column, input.channel, input.method ?? '', input.dynamic].join('\u0000');
    if (!this.facts.has(key)) this.facts.set(key, fact);
  }

  /**
   * 결정적 순서(경로·줄·열·채널·컬럼·dynamic)로 정렬한 사실을 돌려준다.
   *
   * @returns 정렬된 사실
   */
  sorted(): RelationUseFact[] {
    return [...this.facts.values()].sort(compareFacts);
  }

  /** 모은 사실 수다. */
  get size(): number {
    return this.facts.size;
  }
}

/**
 * 사실의 결정적 순서다.
 *
 * @param left 왼쪽
 * @param right 오른쪽
 * @returns 비교 결과
 */
function compareFacts(left: RelationUseFact, right: RelationUseFact): number {
  return compareStrings(left.location.path, right.location.path)
    || left.location.line - right.location.line
    || left.location.column - right.location.column
    || compareStrings(left.channel, right.channel)
    || compareStrings(left.method ?? '', right.method ?? '')
    || Number(left.dynamic) - Number(right.dynamic);
}

/** 요약에서 지우는 문자(제어 문자·NEL·줄/문단 구분자)다. */
const controlCharacters = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

/**
 * dynamic 사실의 channel에 실을 원문 요약이다. 공백을 접고 제어 문자를 지운 뒤 160자로 자른다.
 * 서러게이트 쌍을 가르지 않는다. 가족 생산자(dartograph `_dynamicChannel`)와 같은 규칙이다.
 *
 * @param source 원문 식
 * @returns 요약(비면 `<dynamic>`)
 */
export function dynamicChannel(source: string): string {
  const folded = source.replace(/\s+/gu, ' ').trim().replace(controlCharacters, '');
  let end = Math.min(folded.length, MAX_DYNAMIC_CHANNEL_LENGTH);
  const last = folded.charCodeAt(end - 1);
  if (end < folded.length && last >= 0xd800 && last <= 0xdbff) end--;
  const text = folded.slice(0, end);
  return text.length === 0 ? '<dynamic>' : text;
}
