import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { exceedsSyntaxDepth, isStackExhaustion, MAX_SYNTAX_DEPTH, parseWithinSyntaxDepth, TOO_DEEP } from './syntax-depth.ts';

/**
 * `+` 연결 식 하나를 내보내는 소스를 파싱한다. 파서가 이항 연산을 반복으로 읽으므로 항이 많아도 파싱은 넘치지 않는다.
 *
 * @param terms 항 수
 * @returns 구문 트리
 */
function concatenation(terms: number): ts.SourceFile {
  const text = `export const s = ${Array.from({ length: terms }, () => '"a"').join(' + ')};\n`;
  return ts.createSourceFile('concat.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/**
 * 재귀로 잰 트리 깊이다(뿌리가 1). 검사기와 독립인 기대값을 만들려고 쓴다 — 작은 트리에만 부른다.
 *
 * @param node 노드
 * @returns 깊이
 */
function recursiveDepth(node: ts.Node): number {
  let deepest = 0;
  ts.forEachChild(node, (child) => {
    deepest = Math.max(deepest, recursiveDepth(child));
  });
  return deepest + 1;
}

test('명시 스택 깊이 검사는 재귀로 잰 깊이와 같은 경계에서 갈린다', () => {
  for (const terms of [1, 2, 7, 40]) {
    const sourceFile = concatenation(terms);
    const depth = recursiveDepth(sourceFile);
    assert.equal(exceedsSyntaxDepth(sourceFile, depth), false, `${terms} terms`);
    assert.equal(exceedsSyntaxDepth(sourceFile, depth - 1), true, `${terms} terms`);
  }
});

test('기본 상한 바로 아래 깊이는 통과하고 한 단계 더 깊으면 걸린다', () => {
  // `export const s = a + … ;`의 깊이는 항 수 + 4다(SourceFile·VariableStatement·목록·선언 뒤 이항식 사슬).
  const atLimit = concatenation(MAX_SYNTAX_DEPTH - 4);
  assert.equal(recursiveDepth(atLimit), MAX_SYNTAX_DEPTH);
  assert.equal(exceedsSyntaxDepth(atLimit), false);
  assert.equal(exceedsSyntaxDepth(concatenation(MAX_SYNTAX_DEPTH - 3)), true);
});

test('깊이 검사는 재귀하지 않아 수만 단 트리도 스택을 넘기지 않는다', () => {
  const deep = concatenation(50_000);
  assert.equal(exceedsSyntaxDepth(deep), true);
  assert.equal(exceedsSyntaxDepth(deep, Number.POSITIVE_INFINITY), false);
});

test('격리 파싱은 상한 안의 트리와 읽지 못함(undefined)을 그대로 주고 깊은 트리만 TOO_DEEP으로 바꾼다', () => {
  const shallow = concatenation(3);
  assert.equal(parseWithinSyntaxDepth(() => shallow), shallow);
  assert.equal(parseWithinSyntaxDepth(() => undefined), undefined);
  assert.equal(parseWithinSyntaxDepth(() => concatenation(MAX_SYNTAX_DEPTH)), TOO_DEEP);
});

test('격리 파싱은 파서의 실제 스택 초과만 TOO_DEEP으로 가두고 다른 예외는 그대로 던진다', () => {
  // 괄호 수천 겹은 TypeScript 파서 자체가 재귀로 읽다가 스택을 넘긴다(수백 겹부터).
  const parens = `export const p = ${'('.repeat(20_000)}1${')'.repeat(20_000)};\n`;
  const parse = (): ts.SourceFile => ts.createSourceFile('parens.ts', parens, ts.ScriptTarget.Latest, true);
  assert.throws(parse, isStackExhaustion);
  assert.equal(parseWithinSyntaxDepth(parse), TOO_DEEP);
  for (const error of [new RangeError('Invalid string length'), new TypeError('Maximum call stack size exceeded')]) {
    assert.throws(() => parseWithinSyntaxDepth(() => { throw error; }), (thrown) => thrown === error);
  }
  assert.equal(isStackExhaustion(new RangeError('Maximum call stack size exceeded')), true);
});
