/**
 * 결정적 JSON 직렬화다.
 *
 * 교환 문서는 diff 가능해야 하므로 모든 깊이의 객체 키를 locale과 무관한 UTF-16
 * 코드 단위 순서로 정렬한다(isthmus와 같은 규칙). 배열 순서는 호출자가 정한다.
 */

/**
 * locale·ICU 버전과 무관한 UTF-16 코드 단위 문자열 순서다.
 *
 * @param left 왼쪽 문자열
 * @param right 오른쪽 문자열
 * @returns 음수·0·양수
 */
export function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 값을 키 정렬·두 칸 들여쓰기 JSON으로 직렬화하고 끝 개행을 붙인다.
 *
 * @param value 직렬화할 JSON 호환 값
 * @returns 끝 개행이 있는 JSON 텍스트
 */
export function encodeSortedJson(value: unknown): string {
  return `${JSON.stringify(sortJsonKeys(value), null, 2)}\n`;
}

/**
 * 객체 키만 재귀 정렬한 사본을 만든다. 배열 순서는 보존한다.
 *
 * @param value 정렬할 값
 * @returns 키가 정렬된 사본
 */
function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, item]) => [key, sortJsonKeys(item)]),
  );
}
