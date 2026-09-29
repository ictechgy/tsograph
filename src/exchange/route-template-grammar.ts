/**
 * isthmus 계약의 정규 경로 템플릿 문법 검사다.
 *
 * 규칙의 정본은 isthmus `docs/GRAPH-EXCHANGE.md`의 정규 문법과 공유 벡터 `template.grammar` 사례다
 * (`src/routes/conformance.test.ts`가 벤더링한 벡터로 이 검사기를 검증한다). 생산 경로에서는
 * limitation 스코프 원소처럼 소비자가 문법을 어기면 입력 오류로 거부하는 값을 내기 전에 쓴다.
 */

/** 정규 템플릿 최대 길이다(계약 상한). */
const MAX_CANONICAL_TEMPLATE_LENGTH = 2048;

/** pchar 리터럴 문자(퍼센트 제외)다. */
const literalCharacter = /^[A-Za-z0-9\-._~!$&'()*+,;=:@]$/u;

/** 인코딩하면 안 되는 unreserved 문자다. */
const unreservedCharacter = /^[A-Za-z0-9\-._~]$/u;

/**
 * 템플릿이 계약의 정규 문법을 지키는지 검사한다.
 *
 * `/`로 시작하고, 세그먼트마다 리터럴(pchar, 대문자 `%XX`, unreserved 비인코딩)과 파라미터 `{}` 하나
 * 이하로 이루어지며, `{**}`는 마지막 세그먼트 전체로만 올 수 있다.
 *
 * @param template 검사할 템플릿
 * @returns 정규 템플릿이면 true
 */
export function isCanonicalTemplate(template: string): boolean {
  if (!template.startsWith('/') || template.length > MAX_CANONICAL_TEMPLATE_LENGTH) return false;
  const segments = template.slice(1).split('/');
  return segments.every((segment, index) => isCanonicalSegment(segment, index === segments.length - 1));
}

/**
 * 세그먼트 하나의 문법을 검사한다.
 *
 * @param segment 세그먼트
 * @param isLast 마지막 세그먼트인지
 * @returns 유효하면 true
 */
function isCanonicalSegment(segment: string, isLast: boolean): boolean {
  if (segment === '{**}') return isLast;
  const parts = segment.split('{}');
  if (parts.length > 2) return false;
  return parts.every(isCanonicalLiteral);
}

/**
 * 리터럴 조각의 문법(pchar, 대문자 `%XX`, unreserved 비인코딩)을 검사한다.
 *
 * @param literal 리터럴 조각
 * @returns 유효하면 true
 */
function isCanonicalLiteral(literal: string): boolean {
  for (let index = 0; index < literal.length; index++) {
    const character = literal[index]!;
    if (character !== '%') {
      if (!literalCharacter.test(character)) return false;
      continue;
    }
    const pair = literal.slice(index + 1, index + 3);
    if (!/^[0-9A-F]{2}$/u.test(pair)) return false;
    if (unreservedCharacter.test(String.fromCharCode(Number.parseInt(pair, 16)))) return false;
    index += 2;
  }
  return true;
}
