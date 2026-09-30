/**
 * 파라미터 정규식 분류기를 검사한다: 한 세그먼트 안인지, 빈 값을 받는지, 닫힌 제약 종류.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyParamRegex } from './regex-constraint.ts';

/**
 * 분류 결과를 문자열로 줄인다.
 *
 * @param pattern 정규식 원문
 * @returns `kind[:constraint][:empty]`
 */
function describe(pattern: string): string {
  const result = classifyParamRegex(pattern);
  if (result.kind !== 'segment') return result.kind;
  return `segment:${result.constraint.kind}${result.acceptsEmpty ? ':empty' : ''}`;
}

test('숫자·slug 문자만 받는 정규식은 닫힌 제약이다', () => {
  assert.equal(describe('\\d+'), 'segment:int');
  assert.equal(describe('^[0-9]{1,5}$'), 'segment:int');
  assert.equal(describe('[a-z0-9-]+'), 'segment:slug');
  assert.equal(describe('\\w+'), 'segment:slug');
  assert.equal(describe('(?:ab|cd)+'), 'segment:slug');
  assert.equal(describe('[A-Z]{2}\\.x'), 'segment:regex');
  assert.equal(describe('[^/]+'), 'segment:regex');
});

test('빈 값을 받는 정규식을 알린다', () => {
  assert.equal(describe('\\d*'), 'segment:int:empty');
  assert.equal(describe('a?'), 'segment:slug:empty');
  assert.equal(describe('x{0,3}'), 'segment:slug:empty');
  assert.equal(describe('a|'), 'segment:slug:empty');
});

test('`/`를 받을 수 있거나 모르는 구문은 옮기지 않는다', () => {
  assert.equal(describe('.+'), 'rest');
  assert.equal(describe('.*'), 'unknown');
  assert.equal(describe('\\S+'), 'unknown');
  assert.equal(describe('[^x]+'), 'unknown');
  assert.equal(describe('(?=a)b'), 'unknown');
  assert.equal(describe('(a'), 'unknown');
  assert.equal(describe('[a-z'), 'unknown');
  assert.equal(describe('a{x}'), 'unknown');
  assert.equal(describe('[\\s]'), 'unknown');
  assert.equal(describe('[é]'), 'unknown');
  assert.equal(describe('\\1'), 'unknown');
  assert.equal(describe(''), 'unknown');
  assert.equal(describe('a'.repeat(600)), 'unknown');
  assert.equal(describe('((((((((((a))))))))))'), 'unknown');
  assert.equal(describe('*a'), 'unknown');
  assert.equal(describe('\\/'), 'unknown');
});

test('이스케이프한 기호와 범위는 리터럴 문자다', () => {
  assert.equal(describe('\\-\\_+'), 'segment:slug');
  assert.equal(describe('[\\d\\-]+'), 'segment:slug');
  assert.equal(describe('[\\.]+'), 'segment:regex');
  assert.equal(describe('a+?'), 'segment:slug');
});
