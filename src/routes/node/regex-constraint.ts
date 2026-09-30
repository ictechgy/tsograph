/**
 * 라우트 파라미터에 붙은 정규식(Hono `:id{[0-9]+}`, Express 4 `:id(\\d+)`, find-my-way `:id(^\\d+$)`)을 분류한다.
 *
 * 정규식은 실행하지 않고 구문만 본다. 판정은 세 가지다.
 * - 한 세그먼트 안에서만 맞는지(`/`를 받을 수 있으면 세그먼트 파라미터로 옮길 수 없다).
 * - 빈 문자열을 받는지(받으면 빈 값 변형 decl이 필요하다).
 * - 받는 문자 집합이 isthmus 닫힌 제약(`int`·`slug`)의 가장 넓은 정의 안인지. 안이면 그 종류로, 아니면 `regex`와
 *   원문으로 낸다. 소비자는 닫힌 종류를 "가장 넓은 정의로도 어길 때만" 후보에서 빼므로, 프레임워크가 더 좁게 받아도
 *   거짓 match만 생기고 거짓 error는 생기지 않는다.
 *
 * 모르는 구문(역참조·전후방 탐색·유니코드 속성 등)은 `/`를 받을 수 있다고 본다(안전한 쪽).
 */

import type { SegmentConstraint } from './path-model.ts';

/** 분류 결과다. */
export type RegexClass =
  /** 한 세그먼트 안에서만 맞는다. */
  | { readonly kind: 'segment'; readonly constraint: SegmentConstraint; readonly acceptsEmpty: boolean }
  /** `.+`처럼 나머지 경로 전체(한 글자 이상, `/` 포함)를 받는다. */
  | { readonly kind: 'rest' }
  /** `/`를 받을 수 있거나 구문을 확정하지 못했다. */
  | { readonly kind: 'unknown' };

/** 문자 집합 요약이다. */
interface CharacterSummary {
  /** `/`를 받을 수 있으면 true */
  slash: boolean;
  /** 숫자 밖 문자를 받을 수 있으면 true */
  nonDigit: boolean;
  /** slug 문자(`[-A-Za-z0-9_]`) 밖 문자를 받을 수 있으면 true */
  nonSlug: boolean;
}

/** 파싱 상태다. */
interface ParseState {
  readonly source: string;
  index: number;
}

/** 파싱 결과다. */
interface ParsedPattern {
  readonly summary: CharacterSummary;
  readonly acceptsEmpty: boolean;
}

/** 정규식 원문 최대 길이다. 넘으면 분석하지 않는다. */
const MAX_PATTERN_LENGTH = 512;

/**
 * 파라미터 정규식을 분류한다. 앞 `^`·뒤 `$` 하나씩은 find-my-way처럼 떼고 본다.
 *
 * @param pattern 정규식 원문(괄호 없이)
 * @returns 분류
 */
export function classifyParamRegex(pattern: string): RegexClass {
  const source = pattern.replace(/^\^/u, '').replace(/(?<!\\)\$$/u, '');
  if (source === '.+') return { kind: 'rest' };
  if (source.length === 0 || source.length > MAX_PATTERN_LENGTH) return { kind: 'unknown' };
  const state: ParseState = { source, index: 0 };
  const parsed = parseAlternation(state, 0);
  if (parsed === undefined || state.index !== source.length || parsed.summary.slash) return { kind: 'unknown' };
  return { kind: 'segment', constraint: constraintOf(parsed.summary, pattern), acceptsEmpty: parsed.acceptsEmpty };
}

/**
 * 문자 집합 요약에서 제약 종류를 고른다.
 *
 * @param summary 요약
 * @param pattern 원문
 * @returns 제약
 */
function constraintOf(summary: CharacterSummary, pattern: string): SegmentConstraint {
  if (!summary.nonDigit) return { kind: 'int' };
  if (!summary.nonSlug) return { kind: 'slug' };
  return { kind: 'regex', pattern };
}

/**
 * `a|b|c`를 파싱한다.
 *
 * @param state 상태
 * @param depth 그룹 깊이
 * @returns 결과 또는 undefined(모르는 구문)
 */
function parseAlternation(state: ParseState, depth: number): ParsedPattern | undefined {
  const branches: ParsedPattern[] = [];
  for (;;) {
    const branch = parseSequence(state, depth);
    if (branch === undefined) return undefined;
    branches.push(branch);
    if (state.source[state.index] !== '|') break;
    state.index += 1;
  }
  return {
    summary: mergeSummaries(branches.map((branch) => branch.summary)),
    acceptsEmpty: branches.some((branch) => branch.acceptsEmpty),
  };
}

/**
 * 원자와 수량자의 연속을 파싱한다.
 *
 * @param state 상태
 * @param depth 그룹 깊이
 * @returns 결과 또는 undefined
 */
function parseSequence(state: ParseState, depth: number): ParsedPattern | undefined {
  const summaries: CharacterSummary[] = [];
  let acceptsEmpty = true;
  while (state.index < state.source.length && state.source[state.index] !== '|' && state.source[state.index] !== ')') {
    const atom = parseAtom(state, depth);
    if (atom === undefined) return undefined;
    const optional = parseQuantifier(state);
    if (optional === undefined) return undefined;
    summaries.push(atom.summary);
    acceptsEmpty &&= atom.acceptsEmpty || optional;
  }
  return { summary: mergeSummaries(summaries), acceptsEmpty };
}

/**
 * 원자 하나(문자, 이스케이프, 문자 클래스, 비포획·포획 그룹)를 파싱한다.
 *
 * @param state 상태
 * @param depth 그룹 깊이
 * @returns 결과 또는 undefined
 */
function parseAtom(state: ParseState, depth: number): ParsedPattern | undefined {
  const character = state.source[state.index]!;
  if (character === '(') return parseGroup(state, depth);
  if (character === '[') return single(parseClass(state));
  if (character === '\\') return single(parseEscape(state));
  if ('^$*+?{}'.includes(character)) return undefined;
  state.index += 1;
  return single(character === '.' ? anyCharacter() : literalSummary(character));
}

/**
 * 그룹 `( … )`·`(?: … )`을 파싱한다. 전후방 탐색·이름 그룹 등은 모르는 구문이다.
 *
 * @param state 상태
 * @param depth 그룹 깊이
 * @returns 결과 또는 undefined
 */
function parseGroup(state: ParseState, depth: number): ParsedPattern | undefined {
  if (depth > 8) return undefined;
  state.index += 1;
  if (state.source[state.index] === '?') {
    if (state.source.slice(state.index, state.index + 2) !== '?:') return undefined;
    state.index += 2;
  }
  const inner = parseAlternation(state, depth + 1);
  if (inner === undefined || state.source[state.index] !== ')') return undefined;
  state.index += 1;
  return inner;
}

/**
 * 수량자(`*`·`+`·`?`·`{n,m}`, 게으른 `?` 포함)를 읽는다.
 *
 * @param state 상태
 * @returns 원자를 0번 반복할 수 있으면 true, 수량자가 없거나 1번 이상이면 false, 잘못된 수량자면 undefined
 */
function parseQuantifier(state: ParseState): boolean | undefined {
  const character = state.source[state.index];
  let optional = false;
  if (character === '*' || character === '?') {
    optional = true;
    state.index += 1;
  } else if (character === '+') {
    state.index += 1;
  } else if (character === '{') {
    const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(state.source.slice(state.index));
    if (match === null) return undefined;
    optional = Number(match[1]) === 0;
    state.index += match[0].length;
  } else {
    return false;
  }
  if (state.source[state.index] === '?') state.index += 1;
  return optional;
}

/**
 * 문자 클래스 `[...]`를 파싱한다.
 *
 * @param state 상태
 * @returns 요약 또는 undefined
 */
function parseClass(state: ParseState): CharacterSummary | undefined {
  const end = findClassEnd(state.source, state.index);
  if (end === -1) return undefined;
  const body = state.source.slice(state.index + 1, end);
  state.index = end + 1;
  const negated = body.startsWith('^');
  const members = expandClassMembers(negated ? body.slice(1) : body);
  if (members === undefined) return undefined;
  if (negated) return { slash: !members.has('/'), nonDigit: true, nonSlug: true };
  return summarizeMembers(members);
}

/**
 * 문자 클래스의 닫는 `]` 위치를 찾는다(이스케이프 건너뜀).
 *
 * @param source 원문
 * @param start `[` 위치
 * @returns `]` 위치 또는 -1
 */
function findClassEnd(source: string, start: number): number {
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === ']' && index > start + 1) return index;
  }
  return -1;
}

/**
 * 문자 클래스 본문을 ASCII 문자 집합으로 편다. `\d`·`\w`와 범위(`a-z`)를 받는다. 비ASCII·`\s` 등은 모른다.
 *
 * @param body `[`·`]` 사이(부정 `^` 제외)
 * @returns 문자 집합 또는 undefined
 */
function expandClassMembers(body: string): Set<string> | undefined {
  const members = new Set<string>();
  for (let index = 0; index < body.length; index++) {
    let character = body[index]!;
    if (character === '\\') {
      const escaped = body[index + 1];
      index += 1;
      if (escaped === 'd') { addRange(members, '0', '9'); continue; }
      if (escaped === 'w') { addRange(members, 'a', 'z'); addRange(members, 'A', 'Z'); addRange(members, '0', '9'); members.add('_'); continue; }
      if (escaped === undefined || /[A-Za-z0-9]/u.test(escaped)) return undefined;
      character = escaped;
    }
    if (character.charCodeAt(0) > 0x7e) return undefined;
    if (body[index + 1] === '-' && index + 2 < body.length && body[index + 2] !== '\\') {
      addRange(members, character, body[index + 2]!);
      index += 2;
      continue;
    }
    members.add(character);
  }
  return members;
}

/**
 * 범위의 문자를 집합에 더한다.
 *
 * @param members 집합
 * @param from 시작 문자
 * @param to 끝 문자
 */
function addRange(members: Set<string>, from: string, to: string): void {
  for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code++) members.add(String.fromCharCode(code));
}

/**
 * 이스케이프 원자를 파싱한다.
 *
 * @param state 상태
 * @returns 요약 또는 undefined
 */
function parseEscape(state: ParseState): CharacterSummary | undefined {
  const escaped = state.source[state.index + 1];
  state.index += 2;
  if (escaped === 'd') return { slash: false, nonDigit: false, nonSlug: false };
  if (escaped === 'w') return { slash: false, nonDigit: true, nonSlug: false };
  if (escaped === undefined || /[A-Za-z0-9]/u.test(escaped)) return undefined;
  return literalSummary(escaped);
}

/**
 * 리터럴 문자 하나의 요약이다.
 *
 * @param character 문자
 * @returns 요약
 */
function literalSummary(character: string): CharacterSummary {
  return summarizeMembers(new Set([character]));
}

/**
 * 문자 집합을 요약한다.
 *
 * @param members 문자 집합
 * @returns 요약
 */
function summarizeMembers(members: ReadonlySet<string>): CharacterSummary {
  const values = [...members];
  return {
    slash: members.has('/'),
    nonDigit: values.some((character) => !/[0-9]/u.test(character)),
    nonSlug: values.some((character) => !/[-A-Za-z0-9_]/u.test(character)),
  };
}

/**
 * 모든 문자(`.`)의 요약이다.
 *
 * @returns 요약
 */
function anyCharacter(): CharacterSummary {
  return { slash: true, nonDigit: true, nonSlug: true };
}

/**
 * 원자 요약을 "빈 값을 받지 않는" 결과로 감싼다.
 *
 * @param summary 요약 또는 undefined
 * @returns 결과 또는 undefined
 */
function single(summary: CharacterSummary | undefined): ParsedPattern | undefined {
  return summary === undefined ? undefined : { summary, acceptsEmpty: false };
}

/**
 * 요약을 합친다(어느 하나라도 받으면 받는다).
 *
 * @param summaries 요약 목록
 * @returns 합친 요약
 */
function mergeSummaries(summaries: readonly CharacterSummary[]): CharacterSummary {
  return {
    slash: summaries.some((summary) => summary.slash),
    nonDigit: summaries.some((summary) => summary.nonDigit),
    nonSlug: summaries.some((summary) => summary.nonSlug),
  };
}
