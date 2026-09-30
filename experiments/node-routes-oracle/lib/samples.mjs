// 파라미터 정규식을 만족하는 표본 값을 고른다.

/** 시도하는 값이다(tsograph 탐침의 값과 같다). */
const CANDIDATES = ['12', 'abc', 'a1', 'x-y', 'AB', 'p1'];

/**
 * 정규식을 만족하는 첫 값을 고른다.
 *
 * @param {string} pattern 정규식 원문
 * @returns {string} 값
 */
export function regexSample(pattern) {
  const source = pattern.replace(/^\^/, '').replace(/\$$/, '');
  return CANDIDATES.find((candidate) => new RegExp(`^(?:${source})$`).test(candidate)) ?? 'p1';
}

/**
 * path-to-regexp 8 패턴의 표본 경로다(선택 그룹은 넣은 것과 뺀 것, `:name`은 `p1`, `*name`은 `a/b`).
 *
 * @param {string} pattern 패턴
 * @returns {string[]} 표본
 */
export function pte8Samples(pattern) {
  const expand = (entry) => {
    const match = /\{([^{}]*)\}/.exec(entry);
    if (match === null) return [entry];
    return [...expand(entry.replace(match[0], match[1])), ...expand(entry.replace(match[0], ''))];
  };
  return expand(pattern).map((entry) => entry.replace(/\*[A-Za-z_$][\w$]*/g, 'a/b').replace(/:[A-Za-z_$][\w$]*/g, 'p1') || '/');
}

/**
 * path-to-regexp 6 패턴의 표본 경로다(`:x?`는 넣은 것과 뺀 것, `:x*`는 빈 값과 `a/b`, `:x+`는 `a/b`, `(정규식)`은 맞는 값).
 *
 * @param {string} pattern 패턴
 * @returns {string[]} 표본
 */
export function pte6Samples(pattern) {
  const expand = (entry) => {
    const match = /\/:(\w+)(\([^)]*\))?([?*])/.exec(entry);
    if (match === null) return [entry];
    const withValue = entry.replace(match[0], `/:${match[1]}${match[2] ?? ''}${match[3] === '*' ? '+' : ''}`);
    return [...expand(withValue), ...expand(entry.replace(match[0], ''))];
  };
  return expand(pattern).map((entry) => entry
    .replace(/:\w+\(((?:\\.|[^)])*)\)/g, (_, regex) => regexSample(regex))
    .replace(/:\w+\+/g, 'a/b')
    .replace(/:\w+/g, 'p1') || '/');
}
