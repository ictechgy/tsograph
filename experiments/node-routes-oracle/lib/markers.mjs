// fixture 소스에서 사실 하나의 핸들러가 응답하는 표식(`h:<이름>`)을 찾는다.
//
// 규칙(합성 fixture의 약속): 라우트 핸들러는 모두 고유한 문자열 표식 `h:…`을 응답 본문으로 돌려준다. 오라클은 사실의
// 위치(경로 인자)를 감싼 등록 호출에서 method에 맞는 호출(`.post(…)` 체인 포함)을 고르고, 그 핸들러 인자 안의 표식을
// 읽는다. 핸들러가 이름 참조면 fixture 파일에서 같은 이름의 선언을 찾아 그 안의 표식을 쓴다. NestJS는 위치가 가리키는
// 메서드 데코레이터의 메서드 본문에서 찾는다.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const ts = createRequire(import.meta.url)('typescript');

/** 표식 문자열 정규식이다. */
const MARKER = /^h:[\w.-]+$/;

/** fixture별 파싱 캐시다. */
const sources = new Map();

/**
 * fixture 파일을 파싱한다.
 *
 * @param {string} root fixture 루트
 * @param {string} path 기준 경로
 * @returns {import('typescript').SourceFile} 소스
 */
function sourceOf(root, path) {
  const key = join(root, path);
  if (!sources.has(key)) sources.set(key, ts.createSourceFile(key, readFileSync(key, 'utf8'), ts.ScriptTarget.Latest, true));
  return sources.get(key);
}

/**
 * 1부터 시작하는 줄·UTF-8 바이트 열을 텍스트 오프셋으로 바꾼다.
 *
 * @param {import('typescript').SourceFile} source 소스
 * @param {{line: number, column: number}} location 위치
 * @returns {number} 오프셋
 */
function offsetOf(source, location) {
  const lineStart = source.getLineStarts()[location.line - 1];
  const bytes = Buffer.from(source.text.slice(lineStart), 'utf8');
  return lineStart + bytes.subarray(0, location.column - 1).toString('utf8').length;
}

/**
 * 노드 안의 표식 문자열을 모두 모은다.
 *
 * @param {import('typescript').Node} node 노드
 * @returns {string[]} 표식
 */
function markersIn(node) {
  const found = [];
  const visit = (current) => {
    if (ts.isStringLiteralLike(current) && MARKER.test(current.text)) found.push(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/**
 * 이름으로 fixture 안의 선언을 찾아 그 표식을 돌려준다.
 *
 * @param {string} root fixture 루트
 * @param {string[]} files fixture 소스 목록
 * @param {string} name 선언 이름(점 경로의 마지막 조각)
 * @returns {string[]} 표식
 */
function markersOfDeclaration(root, files, name) {
  for (const file of files) {
    const source = sourceOf(root, file);
    let result;
    const visit = (node) => {
      if (result !== undefined) return;
      const declared = (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node))
        && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name;
      if (declared) {
        const markers = markersIn(node);
        if (markers.length > 0) result = markers;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (result !== undefined) return result;
  }
  return [];
}

/**
 * 오프셋을 감싼 가장 안쪽 노드를 찾는다.
 *
 * @param {import('typescript').Node} node 시작 노드
 * @param {number} offset 오프셋
 * @returns {import('typescript').Node} 노드
 */
function innermost(node, offset) {
  let found = node;
  const visit = (current) => {
    if (current.getStart() <= offset && offset < current.getEnd()) {
      found = current;
      ts.forEachChild(current, visit);
    }
  };
  ts.forEachChild(node, visit);
  return found;
}

/**
 * 호출의 멤버 이름이다.
 *
 * @param {import('typescript').CallExpression} call 호출
 * @returns {string | undefined} 이름
 */
function memberOf(call) {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

/**
 * 사실 method에 맞는 등록 호출을 고른다. 위치를 감싼 첫 호출부터 체인(`a.route(p).get(h).post(h2)`)의 바깥 호출까지
 * 모은 뒤, method 이름이 같은 호출, 없으면 `all`·`use`·`on`, 없으면 첫 호출을 쓴다.
 *
 * @param {import('typescript').Node} start 위치 노드
 * @param {string} method 사실 method
 * @returns {import('typescript').CallExpression | undefined} 호출
 */
function registrationCall(start, method) {
  let node = start;
  while (node !== undefined && !ts.isCallExpression(node)) node = node.parent;
  if (node === undefined) return undefined;
  const chain = [node];
  while (ts.isPropertyAccessExpression(node.parent) && ts.isCallExpression(node.parent.parent)) {
    node = node.parent.parent;
    chain.push(node);
  }
  const exact = method === 'ANY' ? undefined : chain.find((call) => memberOf(call) === method.toLowerCase());
  return exact ?? chain.find((call) => ['all', 'use', 'on'].includes(memberOf(call) ?? '')) ?? chain[0];
}

/**
 * 사실 하나의 기대 표식을 찾는다.
 *
 * @param {string} root fixture 루트
 * @param {string[]} files fixture 소스 목록
 * @param {object} fact route-decl 사실
 * @returns {string | undefined} 표식
 */
export function markerOf(root, files, fact) {
  const source = sourceOf(root, fact.location.path);
  const node = innermost(source, offsetOf(source, fact.location));
  const decorated = decoratedMethod(node);
  if (decorated !== undefined) return markersIn(decorated.body)[0];
  const call = registrationCall(node, fact.method);
  if (call === undefined) return undefined;
  const handler = handlerArgument(call);
  if (handler === undefined) return undefined;
  const inline = markersIn(handler);
  if (inline.length > 0) return inline.at(-1);
  const name = fact.symbol.usr?.split('#')[1]?.split('.').at(-1) ?? (ts.isIdentifier(handler) ? handler.text : undefined);
  return name === undefined ? undefined : markersOfDeclaration(root, files, name)[0];
}

/**
 * 호출의 핸들러 인자(마지막 인자, Fastify `route({handler})`의 handler 속성)를 찾는다.
 *
 * @param {import('typescript').CallExpression} call 호출
 * @returns {import('typescript').Node | undefined} 핸들러 식
 */
function handlerArgument(call) {
  const last = call.arguments.at(-1);
  if (last !== undefined && ts.isObjectLiteralExpression(last)) {
    const property = last.properties.find((entry) => entry.name !== undefined && ts.isIdentifier(entry.name) && entry.name.text === 'handler');
    if (property !== undefined) return property;
  }
  return last;
}

/**
 * 위치가 메서드 데코레이터 안이면 그 메서드를 돌려준다(NestJS).
 *
 * @param {import('typescript').Node} node 위치 노드
 * @returns {import('typescript').MethodDeclaration | undefined} 메서드
 */
function decoratedMethod(node) {
  for (let current = node; current !== undefined; current = current.parent) {
    if (ts.isDecorator(current) && ts.isMethodDeclaration(current.parent)) return current.parent;
    if (ts.isStatement(current)) return undefined;
  }
  return undefined;
}
