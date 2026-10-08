/** JSON 숫자 하나의 lexical 끝을 원문 suffix 복사 없이 찾는다. */
const JSON_NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy;

/**
 * 시작 offset의 JSON number token 끝을 찾는다.
 *
 * sticky 정규식은 원문에서 바로 대조하므로 숫자마다 `text.slice(start)`로 남은 문서 전체를
 * 복사하지 않는다. delimiter와 leading-zero 같은 문서 문법은 호출자가 다음 token에서 검사한다.
 *
 * @param text JSON 원문
 * @param start 숫자가 시작해야 하는 UTF-16 offset
 * @returns token 바로 뒤 offset, 시작점에 숫자가 없으면 undefined
 */
export function scanJsonNumberToken(text: string, start: number): number | undefined {
  if (!Number.isSafeInteger(start) || start < 0 || start >= text.length) return undefined;
  JSON_NUMBER.lastIndex = start;
  const match = JSON_NUMBER.exec(text);
  return match?.index === start ? JSON_NUMBER.lastIndex : undefined;
}
