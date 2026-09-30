// tsograph 사실과 프레임워크 라우트 표로 탐침을 만들고 실제 응답과 대조한다.
//
// 탐침 종류:
// - fact: 정적 루트 사실마다 템플릿을 채운 요청을 사실 method로 보낸다(ANY는 GET·POST·DELETE).
// - method: 사실 method가 아닌 동사로 같은 경로를 보낸다.
// - slash: 끝 슬래시를 바꾼 경로(사실이 strict·optional을 밝힌 경우).
// - case: 대문자로 바꾼 경로(리터럴에 글자가 있는 경우).
// - recall: 프레임워크가 등록한 라우트 표의 패턴을 채운 요청.
// 기대값은 모두 같은 문서로 `predict`가 고른 핸들러 표식이다. 응답이 `h:` 표식이면 그 표식, 아니면 상태 코드다.

import { markerOf } from './markers.mjs';
import { dynamicCandidates, predict } from './matcher.mjs';
import { regexSample } from './samples.mjs';

/** 계약 method다. */
const CONTRACT_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']);

/**
 * 템플릿 세그먼트 하나를 요청 값으로 채운다.
 *
 * @param {string} segment 템플릿 세그먼트
 * @param {object | undefined} constraint 제약
 * @returns {string} 값
 */
function fillSegment(segment, constraint) {
  if (segment === '{**}') return 'a/b';
  const hole = segment.indexOf('{}');
  if (hole === -1) return segment;
  let value = 'p1';
  if (constraint?.kind === 'int') value = '12';
  if (constraint?.kind === 'slug') value = 'ab-1';
  if (constraint?.kind === 'regex') value = regexSample(constraint.pattern);
  return `${segment.slice(0, hole)}${value}${segment.slice(hole + 2)}`;
}

/**
 * 정적 사실의 표본 요청 경로를 만든다.
 *
 * @param {object} fact 사실
 * @returns {string} 요청 경로
 */
export function sampleOf(fact) {
  const constraints = new Map((fact.paramConstraints ?? []).map((entry) => [entry.segment, entry]));
  return `/${fact.channel.slice(1).split('/').map((segment, index) => fillSegment(segment, constraints.get(index))).join('/')}`;
}

/**
 * 응답을 비교용 값으로 줄인다.
 *
 * @param {{status: number, body: string}} response 응답
 * @returns {string} 표식 또는 `status:<코드>`
 */
function outcomeOf(response) {
  const body = response.body.trim();
  return /^h:[\w.-]+$/.test(body) ? body : `status:${response.status}`;
}

/**
 * 예측한 핸들러의 표식이다. 정적 사실이 받으면 그 표식(들), 없으면 스코프가 요청을 덮는 dynamic 사실의 표식이다 —
 * dynamic 사실은 요청을 받을 수도 안 받을 수도 있다.
 *
 * @param {object} context 탐침 문맥
 * @param {string} method 요청 method
 * @param {string} path 요청 경로
 * @returns {{markers: string[], dynamic: boolean}} 기대값
 */
function expectationOf(context, method, path) {
  const { winners } = predict(context.document, method, path);
  // 조건부(narrowed) 선언만 받으면 조건(헤더·host)에 따라 받을 수도 안 받을 수도 있다.
  if (winners.length > 0) return { markers: [...new Set(winners.map((fact) => context.markerOf(fact)))], dynamic: winners.every((fact) => fact.narrowed === true) };
  const dynamic = dynamicCandidates(context.document, method, path);
  return { markers: [...new Set(dynamic.map((fact) => context.markerOf(fact)))], dynamic: true };
}

/**
 * 탐침 하나를 실행하고 판정한다. HEAD 응답은 본문이 없어 상태 코드로만 판정한다(2xx면 핸들러가 받았다).
 *
 * @param {object} context 탐침 문맥
 * @param {string} kind 탐침 종류
 * @param {string} method 요청 method
 * @param {string} path 요청 경로
 * @param {number | undefined} fact 사실 번호
 * @returns {Promise<object | undefined>} 판정 기록(건너뛴 method면 undefined)
 */
async function runProbe(context, kind, method, path, fact) {
  // 계약 method 밖의 동사는 사실이 싣지 않으므로 비교하지 않는다(CONNECT는 Node가 처리기로 넘기지도 않는다).
  if (context.skipMethods.has(method) || !CONTRACT_METHODS.has(method)) return undefined;
  const expectation = expectationOf(context, method, path);
  const response = await context.request(method, path);
  const outcome = outcomeOf(response);
  const handled = method === 'HEAD' ? response.status >= 200 && response.status < 300 : outcome.startsWith('h:');
  const matched = method === 'HEAD' ? handled : expectation.markers.includes(outcome);
  const ok = expectation.dynamic ? (!handled || matched) : expectation.markers.length === 0 ? !handled : matched;
  return { kind, method, path, expect: expectation.markers.length === 0 ? ['(no handler)'] : expectation.markers, ...(expectation.dynamic && expectation.markers.length > 0 ? { dynamic: true } : {}), actual: method === 'HEAD' ? `status:${response.status}` : outcome, ok, ...(fact === undefined ? {} : { fact }) };
}

/**
 * 사실 기반 탐침(fact·method·slash·case)을 모두 실행한다.
 *
 * @param {object} context 탐침 문맥
 * @returns {Promise<object[]>} 판정 기록
 */
export async function factProbes(context) {
  const records = [];
  for (const [index, fact] of context.document.facts.entries()) {
    if (fact.dynamic || fact.pathAnchor !== 'root' || fact.testSource) continue;
    const path = sampleOf(fact);
    const methods = fact.method === 'ANY' ? ['GET', 'POST', 'DELETE'] : [fact.method];
    for (const method of methods) records.push(await runProbe(context, 'fact', method, path, index));
    if (fact.method !== 'ANY') records.push(await runProbe(context, 'method', otherMethod(fact.method), path, index));
    if (fact.trailingSlash !== undefined && path !== '/') records.push(await runProbe(context, 'slash', methods[0], toggleSlash(path), index));
    if (/[a-z]/.test(path)) records.push(await runProbe(context, 'case', methods[0], path.toUpperCase(), index));
  }
  return records.filter((record) => record !== undefined);
}

/**
 * 프레임워크 라우트 표 기반 탐침(recall)을 실행한다.
 *
 * @param {object} context 탐침 문맥
 * @param {{method: string, path: string}[]} requests 라우트 표에서 만든 요청
 * @returns {Promise<object[]>} 판정 기록
 */
export async function recallProbes(context, requests) {
  const records = [];
  for (const { method, path } of requests) records.push(await runProbe(context, 'recall', method, path, undefined));
  return records.filter((record) => record !== undefined);
}

/**
 * 사실 method와 다른 동사를 고른다.
 *
 * @param {string} method 사실 method
 * @returns {string} 다른 동사
 */
function otherMethod(method) {
  return method === 'DELETE' ? 'PATCH' : 'DELETE';
}

/**
 * 끝 슬래시를 붙이거나 뗀다.
 *
 * @param {string} path 경로
 * @returns {string} 바꾼 경로
 */
function toggleSlash(path) {
  return path.endsWith('/') ? path.slice(0, -1) : `${path}/`;
}

/**
 * 사실 번호 → 표식 조회기를 만든다.
 *
 * @param {string} root fixture 루트
 * @param {string[]} files fixture 소스 목록
 * @returns {(fact: object) => string} 조회기
 */
export function markerLookup(root, files) {
  const cache = new Map();
  return (fact) => {
    const key = JSON.stringify([fact.location, fact.method]);
    if (!cache.has(key)) cache.set(key, markerOf(root, files, fact) ?? `(unknown marker ${fact.location.path}:${fact.location.line})`);
    return cache.get(key);
  };
}

/**
 * 판정 기록을 요약한다. 정밀도는 모든 탐침이 통과한 정적 루트 사실의 비율, 재현율은 표식을 응답한 recall 탐침 중
 * 예측이 맞은 비율이다.
 *
 * @param {object} document tsograph 문서
 * @param {object[]} records 판정 기록
 * @returns {object} 요약
 */
export function summarize(document, records) {
  const probed = new Set(records.filter((record) => record.fact !== undefined).map((record) => record.fact));
  const failedFacts = new Set(records.filter((record) => record.fact !== undefined && !record.ok).map((record) => record.fact));
  const served = records.filter((record) => record.kind === 'recall' && record.actual.startsWith('h:'));
  return {
    staticFacts: probed.size,
    verifiedFacts: probed.size - failedFacts.size,
    dynamicFacts: document.facts.filter((fact) => fact.dynamic).length,
    servedRoutes: served.length,
    coveredRoutes: served.filter((record) => record.ok).length,
    probes: records.length,
    failedProbes: records.filter((record) => !record.ok).length,
  };
}
