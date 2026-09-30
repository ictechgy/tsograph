// tsograph route-decl 사실로 요청 하나를 받을 핸들러를 예측한다(isthmus 조인 규칙의 오라클용 축약).
//
// - 세그먼트 매칭: 리터럴은 같아야 하고(caseInsensitive면 대소문자 무시), `{}`는 비어 있지 않은 한 세그먼트와 닫힌 제약,
//   부분 세그먼트 `p{}s`는 가운데가 빈 값이 아닌 리터럴, `{**}`는 한 개 이상 세그먼트와 맞는다.
// - 끝 슬래시: optional이면 끝 슬래시 하나를 무시하고, strict·미상이면 정확히 비교한다.
// - method를 먼저 거른다(ANY는 모든 method, HEAD 요청은 GET decl과 맞는다).
// - specificity 문서는 구체성 최상위(왼쪽 세그먼트부터 리터럴 > 부분 > 제약 {} > {} > {**}), registration-order 문서는
//   같은 group의 가장 작은 index가 이긴다. 순서 없는 후보가 함께 맞으면 어느 쪽이 받을지 계약상 모호하므로 후보 전체를
//   허용 집합으로 돌려준다.

/**
 * 요청 경로를 세그먼트로 나눈다(앞 `/` 하나를 뗀다).
 *
 * @param {string} path 요청 경로(쿼리 없음)
 * @returns {string[]} 세그먼트
 */
export function splitPath(path) {
  return path.slice(1).split('/');
}

/**
 * 제약 하나를 검사한다.
 *
 * @param {{kind: string, pattern?: string} | undefined} constraint 제약
 * @param {string} value 세그먼트 값
 * @returns {boolean} 통과하면 true
 */
function constraintHolds(constraint, value) {
  if (constraint === undefined || constraint.kind === 'path') return true;
  if (constraint.kind === 'int') return /^[+-]?[0-9]+$/.test(value);
  if (constraint.kind === 'slug') return /^[-A-Za-z0-9_]+$/.test(value);
  if (constraint.kind === 'uuid') return /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(value);
  return new RegExp(`^(?:${constraint.pattern.replace(/^\^/, '').replace(/\$$/, '')})$`).test(value);
}

/**
 * 템플릿 세그먼트 하나가 요청 세그먼트와 맞는지 본다.
 *
 * @param {string} template 템플릿 세그먼트
 * @param {string} actual 요청 세그먼트
 * @param {boolean} caseInsensitive 대소문자 무시
 * @param {object | undefined} constraint 제약
 * @returns {boolean} 맞으면 true
 */
function segmentMatches(template, actual, caseInsensitive, constraint) {
  const fold = (text) => (caseInsensitive ? text.toLowerCase() : text);
  const hole = template.indexOf('{}');
  if (hole === -1) return fold(template) === fold(actual);
  const prefix = template.slice(0, hole);
  const suffix = template.slice(hole + 2);
  if (actual.length <= prefix.length + suffix.length) return false;
  if (!fold(actual).startsWith(fold(prefix)) || !fold(actual).endsWith(fold(suffix))) return false;
  return constraintHolds(constraint, actual.slice(prefix.length, actual.length - suffix.length));
}

/**
 * 사실 하나가 요청 경로와 맞는지 본다.
 *
 * @param {object} fact route-decl 사실
 * @param {string} path 요청 경로
 * @returns {boolean} 맞으면 true
 */
export function factMatchesPath(fact, path) {
  if (fact.dynamic || fact.pathAnchor !== 'root') return false;
  const constraints = new Map((fact.paramConstraints ?? []).map((entry) => [entry.segment, entry]));
  const tryMatch = (candidate) => {
    const pattern = splitPath(fact.channel);
    const actual = splitPath(candidate);
    for (let index = 0; index < pattern.length; index++) {
      if (pattern[index] === '{**}') return actual.length > index && actual.slice(index).join('/') !== '';
      if (index >= actual.length) return false;
      if (!segmentMatches(pattern[index], actual[index], fact.caseInsensitive === true, constraints.get(index))) return false;
    }
    return pattern.length === actual.length;
  };
  if (tryMatch(path)) return true;
  if (fact.trailingSlash !== 'optional') return false;
  if (path.endsWith('/') && path !== '/') return tryMatch(path.slice(0, -1));
  return tryMatch(`${path}/`);
}

/**
 * 사실의 method가 요청 method를 받는지 본다.
 *
 * @param {object} fact 사실
 * @param {string} method 요청 method
 * @returns {boolean} 받으면 true
 */
export function factAcceptsMethod(fact, method) {
  return fact.method === 'ANY' || fact.method === method || (method === 'HEAD' && fact.method === 'GET');
}

/**
 * 세그먼트 순위(작을수록 구체적)다.
 *
 * @param {string} segment 템플릿 세그먼트
 * @param {boolean} constrained 닫힌 제약이 있는지
 * @returns {number} 순위
 */
function segmentRank(segment, constrained) {
  if (segment === '{**}') return 4;
  if (segment === '{}') return constrained ? 2 : 3;
  return segment.includes('{}') ? 1 : 0;
}

/**
 * 두 사실의 구체성을 비교한다.
 *
 * @param {object} left 사실
 * @param {object} right 사실
 * @returns {number} 음수면 왼쪽이 더 구체적
 */
function compareSpecificity(left, right) {
  const a = splitPath(left.channel);
  const b = splitPath(right.channel);
  const constrained = (fact, index) => (fact.paramConstraints ?? []).some((entry) => entry.segment === index && entry.kind !== 'regex' && entry.kind !== 'path');
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const rankA = index < a.length ? segmentRank(a[index], constrained(left, index)) : 5;
    const rankB = index < b.length ? segmentRank(b[index], constrained(right, index)) : 5;
    if (rankA !== rankB) return rankA - rankB;
  }
  return 0;
}

/**
 * 요청을 받을 수 있는 사실 집합을 예측한다.
 *
 * @param {object} document tsograph 문서
 * @param {string} method 요청 method
 * @param {string} path 요청 경로
 * @returns {{candidates: object[], winners: object[]}} 경로·method가 맞는 후보와 받을 수 있는 사실
 */
export function predict(document, method, path) {
  const candidates = document.facts.filter((fact) => factAcceptsMethod(fact, method) && factMatchesPath(fact, path));
  if (candidates.length === 0) return { candidates, winners: [] };
  if (document.dispatch === 'specificity') {
    const sorted = [...candidates].sort(compareSpecificity);
    return { candidates, winners: sorted.filter((fact) => compareSpecificity(fact, sorted[0]) === 0) };
  }
  const groups = new Set(candidates.map((fact) => fact.order?.group ?? `unordered:${JSON.stringify(fact.location)}`));
  const ordered = candidates.filter((fact) => fact.order !== undefined);
  if (groups.size === 1 && ordered.length === candidates.length) {
    const least = Math.min(...ordered.map((fact) => fact.order.index));
    return { candidates, winners: ordered.filter((fact) => fact.order.index === least) };
  }
  // 순서 없는 후보가 섞이면 누가 받는지 문서가 주장하지 않는다: 순서 있는 후보 중 가장 앞선 것과 순서 없는 후보 전부.
  const least = ordered.length === 0 ? undefined : Math.min(...ordered.map((fact) => fact.order.index));
  return { candidates, winners: candidates.filter((fact) => fact.order === undefined || fact.order.index === least) };
}

/**
 * 요청을 받을 수 있는 dynamic 사실(스코프 접두사·템플릿이 요청을 덮고 method가 맞는 것, 스코프가 없으면 method만)을 찾는다.
 *
 * @param {object} document tsograph 문서
 * @param {string} method 요청 method
 * @param {string} path 요청 경로
 * @returns {object[]} dynamic 사실
 */
export function dynamicCandidates(document, method, path) {
  return document.facts.filter((fact) => fact.dynamic && factAcceptsMethod(fact, method) && scopeCovers(fact.dynamicScope, path));
}

/**
 * dynamicScope가 요청 경로를 덮는지 본다(세그먼트 경계 접두사, `{}` 한 세그먼트).
 *
 * @param {object | undefined} scope 스코프
 * @param {string} path 요청 경로
 * @returns {boolean} 덮으면 true
 */
function scopeCovers(scope, path) {
  if (scope === undefined) return true;
  const actual = splitPath(path);
  const covers = (prefix, exact) => {
    const pattern = prefix === '/' ? [] : splitPath(prefix);
    if (exact ? actual.length !== pattern.length : actual.length < pattern.length) return false;
    return pattern.every((segment, index) => segmentMatches(segment, actual[index], true, undefined));
  };
  return (scope.templatePrefixes ?? []).some((prefix) => covers(prefix, false)) || (scope.templates ?? []).some((template) => covers(template, true));
}
