/**
 * 정규 경로 템플릿의 리터럴 percent-encoding 규칙이다.
 *
 * isthmus 초안의 문법: 리터럴 문자는 RFC 3986 pchar(unreserved · pct-encoded ·
 * sub-delims · ":" · "@")만 쓰고, `%XX`는 대문자 hex, unreserved 문자는 인코딩하지
 * 않는다. 생산자마다 `%2f`·`%2F`처럼 다르게 정규화하면 조용히 조인되지 않으므로
 * 모든 리터럴을 이 한 함수로 정규화한다.
 */

/** RFC 3986 unreserved 문자 한 개다. */
const unreservedCharacter = /^[A-Za-z0-9\-._~]$/u;

/** pchar 중 인코딩 없이 그대로 두는 문자 한 개(unreserved · sub-delims · ":" · "@")다. */
const rawPathCharacter = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/u;

/** `%` 뒤의 두 hex 자리다. */
const hexPair = /^[0-9A-Fa-f]{2}$/u;

/** 문자를 UTF-8로 바꿀 때 쓰는 공유 인코더다. */
const utf8Encoder = new TextEncoder();

/**
 * 세그먼트 하나의 리터럴 부분을 정규 형태로 바꾼다.
 *
 * - `%XX`가 unreserved 문자를 가리키면 디코드하고, 아니면 hex를 대문자로 쓴다.
 * - 뒤에 hex 두 자리가 없는 `%`는 리터럴 퍼센트라 `%25`로 쓴다.
 * - pchar 밖 문자(공백·비ASCII·중괄호 등)는 UTF-8 바이트별 `%XX`로 쓴다.
 *
 * 호출자는 짝 없는 서러게이트가 없는 문자열만 넘긴다(인코더가 U+FFFD로 바꿔
 * 원문과 다른 템플릿을 만들기 때문이다).
 *
 * @param literal `/`를 포함하지 않는 리터럴 텍스트
 * @returns 정규 리터럴
 */
export function canonicalizeLiteral(literal: string): string {
  let output = '';
  let index = 0;
  while (index < literal.length) {
    const character = String.fromCodePoint(literal.codePointAt(index)!);
    if (character === '%') {
      const pair = literal.slice(index + 1, index + 3);
      output += hexPair.test(pair) ? normalizeEscape(pair) : '%25';
      index += hexPair.test(pair) ? 3 : 1;
      continue;
    }
    output += rawPathCharacter.test(character) ? character : percentEncode(character);
    index += character.length;
  }
  return output;
}

/**
 * `%XX` 한 개를 정규화한다.
 *
 * @param pair `%` 뒤의 hex 두 자리
 * @returns unreserved면 디코드한 문자, 아니면 대문자 `%XX`
 */
function normalizeEscape(pair: string): string {
  const decoded = String.fromCharCode(Number.parseInt(pair, 16));
  return unreservedCharacter.test(decoded) ? decoded : `%${pair.toUpperCase()}`;
}

/**
 * 문자 하나를 UTF-8 바이트별 대문자 `%XX`로 인코딩한다.
 *
 * @param character 코드 포인트 하나
 * @returns 인코딩한 문자열
 */
export function percentEncode(character: string): string {
  let output = '';
  for (const byte of utf8Encoder.encode(character)) {
    output += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return output;
}
