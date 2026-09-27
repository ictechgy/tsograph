import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_ALIAS_DEREFERENCES,
  MAX_ESTIMATED_NODES,
  MAX_FLOW_DEPTH,
  parseSpecTree,
  precheckSpecText,
  SpecParseError,
} from './spec-tree.ts';

/** 파싱 실패 이유와 줄을 기대한다. */
function expectParseFailure(source: string, reason: string, line?: number): void {
  assert.throws(() => parseSpecTree(source), (error: unknown) => {
    assert.ok(error instanceof SpecParseError);
    assert.equal(error.reason, reason);
    if (line !== undefined) assert.equal(error.line, line);
    return true;
  });
}

test('JSON과 YAML을 같은 트리로 읽고 문자열 키로 조회한다', () => {
  for (const source of ['{"a": {"b": "c"}, "n": 1}', 'a:\n  b: c\nn: 1\n']) {
    const tree = parseSpecTree(source);
    assert.equal(tree.string(tree.get(tree.get(tree.root, 'a'), 'b')), 'c');
    assert.equal(tree.string(tree.get(tree.root, 'n')), undefined);
    assert.equal(tree.get(tree.root, 'missing'), undefined);
    assert.equal(tree.entries(tree.get(tree.root, 'n')), undefined);
    assert.equal(tree.items(tree.root), undefined);
  }
});

test('중복 키는 JSON·YAML 모두 줄 번호와 함께 거부한다', () => {
  expectParseFailure('{\n"a": 1,\n"a": 2\n}', 'duplicate-key', 3);
  expectParseFailure('paths:\n  /x: {}\n  /x: {}\n', 'duplicate-key', 3);
});

test('중복 키 검사는 큰 매핑에서도 선형 시간이다(제곱 시간 DoS 회귀 방지)', { timeout: 30_000 }, () => {
  const lines = ['m:', ...Array.from({ length: 150_000 }, (_, index) => `  /p${index}: 1`), '  /p7: 2'];
  expectParseFailure(lines.join('\n'), 'duplicate-key', 150_002);
});

test('숫자 키와 문자열 키는 다른 키이고 깊은 곳의 중복도 찾는다', () => {
  assert.doesNotThrow(() => parseSpecTree('m: {1: a, "1": b}\n'));
  expectParseFailure('a:\n  b:\n    c: 1\n    c: 2\n', 'duplicate-key', 4);
});

test('여러 문서·구문 오류·과도한 중첩을 거부한다', () => {
  expectParseFailure('a: 1\n---\nb: 2\n', 'multiple-documents');
  expectParseFailure('a: [1, 2\n', 'syntax');
  expectParseFailure(`${'['.repeat(900)}${']'.repeat(900)}`, 'resource-exhaustion');
});

test('alias는 앞선 마지막 anchor로 따라간다', () => {
  const tree = parseSpecTree('base: &x {v: 1}\nother: &x {v: 2}\nuse: *x\n');
  assert.equal(tree.entries(tree.get(tree.root, 'use'))?.[0]?.key, 'v');
  assert.equal(tree.get(tree.get(tree.root, 'use'), 'v')?.toString(), '2');
});

test('merge key는 펼치지 않고 거부하며 따옴표 키 "<<"는 일반 키다', () => {
  expectParseFailure('x: &a {servers: []}\n<<: *a\n', 'merge-key', 2);
  expectParseFailure('%YAML 1.1\n---\nx: &a {p: 1}\ny:\n  <<: *a\n', 'merge-key', 5);
  const tree = parseSpecTree('m: {"<<": 1}\n');
  assert.equal(tree.entries(tree.get(tree.root, 'm'))?.[0]?.key, '<<');
});

test('alias·컬렉션 키는 거부한다', () => {
  expectParseFailure('k: &k servers\nservers: 1\n*k : 2\n', 'complex-key', 3);
  expectParseFailure('? [a, b]\n: 1\n', 'complex-key', 1);
});

test('파싱 전 사전 검사가 노드 수 추정치와 flow 깊이를 제한한다', () => {
  expectParseFailure(`x: [${'0,'.repeat(MAX_ESTIMATED_NODES)}0]`, 'too-many-nodes');
  expectParseFailure(`${'['.repeat(MAX_FLOW_DEPTH + 1)}`, 'resource-exhaustion');
  assert.doesNotThrow(() => precheckSpecText(`${'['.repeat(MAX_FLOW_DEPTH)}${']'.repeat(MAX_FLOW_DEPTH + 5)}`));
});

test('alias 역참조가 상한을 넘으면 alias-budget으로 멈춘다', () => {
  const tree = parseSpecTree('a: &x {k: v}\nb: *x\n');
  const alias = tree.entries(tree.root)?.[1]?.value ?? null;
  assert.throws(() => {
    for (let index = 0; index <= MAX_ALIAS_DEREFERENCES; index++) tree.resolve(alias);
  }, (error: unknown) => error instanceof SpecParseError && error.reason === 'alias-budget');
});

test('문자열이 아닌 키는 undefined 키로 남고 시퀀스는 원소로 읽는다', () => {
  const tree = parseSpecTree('200: ok\nlist: [a, 1]\n');
  assert.equal(tree.entries(tree.root)?.[0]?.key, undefined);
  const items = tree.items(tree.get(tree.root, 'list'));
  assert.equal(tree.string(items?.[0]), 'a');
  assert.equal(tree.string(null), undefined);
});

test('위치는 1부터 시작하는 줄과 UTF-8 바이트 열이고 BOM은 세지 않는다', () => {
  const tree = parseSpecTree('\uFEFFa: 1\nné: { get: x }\r\nz: 2\n');
  const entries = tree.entries(tree.root) ?? [];
  assert.deepEqual(tree.position(entries[0]!.keyNode), { line: 1, column: 1 });
  const inner = tree.entries(entries[1]!.value) ?? [];
  assert.deepEqual(tree.position(inner[0]!.keyNode), { line: 2, column: 8 });
  assert.deepEqual(tree.position(entries[2]!.keyNode), { line: 3, column: 1 });
});
