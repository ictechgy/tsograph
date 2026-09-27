import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSpecTree } from './spec-tree.ts';
import { readSpecShape, SpecContentError } from './spec-version.ts';

/** 텍스트의 스펙 버전을 읽는다. */
function versionOf(source: string): string {
  return readSpecShape(parseSpecTree(source)).version;
}

/** 내용 실패 이유를 기대한다. */
function expectContentFailure(source: string, reason: string): void {
  assert.throws(
    () => readSpecShape(parseSpecTree(source)),
    (error: unknown) => error instanceof SpecContentError && error.reason === reason,
  );
}

test('2.0·3.0.x·3.1.x를 판별한다', () => {
  assert.equal(versionOf('swagger: "2.0"\npaths: {}\n'), '2.0');
  assert.equal(versionOf('swagger: 2.0\npaths: {}\n'), '2.0');
  assert.equal(versionOf('openapi: 3.0.3\npaths: {}\n'), '3.0');
  assert.equal(versionOf('openapi: "3.1"\npaths: {}\n'), '3.1');
  assert.equal(versionOf('openapi: 3.1.1\nwebhooks: {}\n'), '3.1');
});

test('지원하지 않거나 모호하거나 없는 버전을 거부한다', () => {
  expectContentFailure('openapi: 3.2.0\npaths: {}\n', 'unsupported-version');
  expectContentFailure('openapi: 3.0\npaths: {}\n', 'unsupported-version');
  expectContentFailure('swagger: "1.2"\npaths: {}\n', 'unsupported-version');
  expectContentFailure('swagger: "2.0"\nopenapi: 3.0.0\npaths: {}\n', 'ambiguous-version');
  expectContentFailure('info: {}\npaths: {}\n', 'missing-version');
  expectContentFailure('- a\n', 'not-an-object');
  expectContentFailure('', 'not-an-object');
});

test('2.0·3.0은 paths가 필수이고 paths는 객체여야 한다', () => {
  expectContentFailure('openapi: 3.0.0\n', 'missing-paths');
  expectContentFailure('swagger: "2.0"\n', 'missing-paths');
  expectContentFailure('openapi: 3.1.0\npaths: []\n', 'invalid-paths');
  assert.equal(readSpecShape(parseSpecTree('openapi: 3.1.0\n')).paths, undefined);
});
