import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createGraphSnapshot } from './graph-document.ts';
import type { CallGraph } from './graph-model.ts';
import { graphOutputChunks } from './graph-output.ts';
import { parseSavedGraphChunks, parseSavedGraphInput, SAVED_GRAPH_STREAM_LIMITS, SavedGraphError } from './saved-graph.ts';

const graph: CallGraph = {
  nodes: ['a', 'b', 'c'].map(name => ({ id: `src/한글.ts#${name}`, kind: 'function',
    location: { path: 'src/한글.ts', line: 1, column: 1 },
    ...(name === 'a' ? { entries: ['page' as const], unresolvedCalls: { direct: 2, bound: 1 } } : {}) })),
  edges: [
    { from: 'src/한글.ts#a', to: 'src/한글.ts#b', kinds: ['call'], evidence: 'direct' },
    { from: 'src/한글.ts#b', to: 'src/한글.ts#c', kinds: ['call'], evidence: 'bound' },
  ],
  limitations: ['analysis-partial: 한글😀 retained'],
  limitationsByMode: { direct: ['direct: retained'], bound: ['bound: retained'], candidates: ['candidate: retained'] },
  statistics: { files: 1, calls: { resolved: 2, external: 0, missingDependencies: 0,
    unresolved: { parameter: 1, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 },
    dispatch: { bound: 1, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 } } },
};

/** 합성 레코드만 사용하여 text·chunk 경로의 의미를 비교한다. */
function records(): any[] {
  const document = createGraphSnapshot(graph, { toolVersion: '0.11.0', generatedAt: new Date('2026-10-26T00:00:00.000Z'),
    project: '/never-read/synthetic-source', revision: 'a'.repeat(40) });
  return [...graphOutputChunks(document, 'ndjson')].map(line => JSON.parse(line));
}

/** 각 호출마다 새 byte stream을 만든다. */
async function* chunks(text: string | Uint8Array, size = 37): AsyncGenerator<Uint8Array> {
  const bytes = typeof text === 'string' ? Buffer.from(text) : text;
  for (let start = 0; start < bytes.byteLength; start += size) yield bytes.subarray(start, start + size);
}

/** 행 순서를 보존하며 잘못된 JSON도 개별 시험에서 직접 만들 수 있다. */
function encode(values = records()): string { return values.map(value => JSON.stringify(value) + '\n').join(''); }

/** 예외는 입력·경로 원문 대신 안정적인 실패 종류를 남긴다. */
async function rejects(text: string | Uint8Array, code: SavedGraphError['code']): Promise<void> {
  await assert.rejects(parseSavedGraphChunks(chunks(text)), error => error instanceof SavedGraphError && error.code === code);
}

test('chunk 경계·UTF8·초기 BOM·CRLF·마지막 LF 유무는 기존 parser와 같다', async () => {
  const text = encode();
  const expected = parseSavedGraphInput(text);
  for (const size of [1, 2, 3, 4, 17, 64, 1024]) assert.deepEqual(await parseSavedGraphChunks(chunks(text, size)), expected);
  assert.deepEqual(await parseSavedGraphChunks(chunks(text.slice(0, -1))), expected);
  assert.deepEqual(await parseSavedGraphChunks(chunks('\ufeff' + text.replaceAll('\n', '\r\n'), 1)), expected);
  const old = records(); delete old[0].limitationsByMode;
  assert.deepEqual(await parseSavedGraphChunks(chunks(encode(old))), parseSavedGraphInput(encode(old)));
});

test('큰 parser도 닫힌 header·provenance·node·edge·통계·부분 한계를 검증한다', async () => {
  const cases: [SavedGraphError['code'], (values: any[]) => void][] = [
    ['invalid-schema', values => { values[0].format = 'tsograph-graph'; }],
    ['invalid-schema', values => { values[0].extra = true; }],
    ['invalid-schema', values => { values[0].nodeCount = 500_001; }],
    ['invalid-schema', values => { values[0].edgeCount = 2_000_001; }],
    ['invalid-provenance', values => { values[0].project = '../private'; }],
    ['invalid-provenance', values => { values[0].graphRevision = 'not-a-hash'; }],
    ['invalid-statistics', values => { values[0].statistics.calls.resolved = -1; }],
    ['invalid-limitations', values => { values[0].limitations = ['duplicate', 'duplicate']; }],
    ['invalid-limitations', values => { values[0].limitationsByMode.direct = ['\u001b']; }],
    ['invalid-node', values => { values[1].node.location.path = '../escape'; }],
    ['invalid-node', values => { values[1].node.location.path = '/absolute'; }],
    ['invalid-node', values => { values[1].node.id = 'bad\u0000#injection'; }],
    ['invalid-edge', values => { values[4].edge.kinds = ['unknown']; }],
    ['missing-endpoint', values => { values[4].edge.to = 'src/한글.ts#missing'; }],
    ['revision-mismatch', values => { values[0].graphRevision = `sha256:${'0'.repeat(64)}`; }],
  ];
  for (const [code, mutate] of cases) {
    const values = records(); mutate(values);
    await assert.rejects(parseSavedGraphChunks(chunks(encode(values))), error => error instanceof SavedGraphError && error.code === code, code);
  }
});

test('중복 key·과도한 중첩·비 JSON 숫자·원시 wrapper와 여분 속성을 거부한다', async () => {
  const text = encode();
  await rejects(text.replace('"nodeCount":3', '"nodeCount":3,"nodeCount":3'), 'duplicate-key');
  await rejects(text.replace('"kind":"function"', '"kind":"function","kind":"function"'), 'duplicate-key');
  await rejects('['.repeat(40) + '0' + ']'.repeat(40), 'too-deep');
  await rejects(text.replace('"nodeCount":3', '"nodeCount":NaN'), 'invalid-json');
  await rejects('null\n', 'invalid-schema');
  const values = records(); values[1].extra = '__proto__';
  await rejects(encode(values), 'invalid-schema');
  await rejects(text.replace('"record":"node"', '"__proto__":{"polluted":true},"record":"node"'), 'invalid-schema');
  assert.equal((Object.prototype as unknown as { polluted?: boolean }).polluted, undefined);
});

test('정렬·중복·nodes-before-edges·선언한 정확한 count와 실제 EOF를 요구한다', async () => {
  const duplicate = records(); duplicate[0].nodeCount++; duplicate.splice(2, 0, structuredClone(duplicate[1]));
  await rejects(encode(duplicate), 'duplicate-node');
  const unsorted = records(); [unsorted[1], unsorted[2]] = [unsorted[2], unsorted[1]];
  await rejects(encode(unsorted), 'invalid-node');
  const repeated = records(); repeated[0].edgeCount++; repeated.splice(5, 0, structuredClone(repeated[4]));
  await rejects(encode(repeated), 'duplicate-edge');
  const reverse = records(); [reverse[4], reverse[5]] = [reverse[5], reverse[4]];
  await rejects(encode(reverse), 'invalid-edge');
  const lateNode = records(); lateNode.push(structuredClone(lateNode[1]));
  await rejects(encode(lateNode), 'invalid-schema');
  await rejects(encode(records().slice(0, -1)), 'invalid-schema');
  await rejects(encode() + JSON.stringify(records()[0]) + '\n', 'invalid-schema');
  await rejects(encode() + '\n', 'invalid-json');
  await rejects('', 'invalid-schema');
  await rejects(encode().slice(0, -4), 'invalid-json');
});

test('UTF8는 행 사이로 이어질 수 없고 중간 BOM·EOF 미완성 sequence도 거부한다', async () => {
  await rejects(new Uint8Array([0xff]), 'invalid-utf8');
  await rejects(new Uint8Array([0xe3, 10, 0x81, 0x82]), 'invalid-utf8');
  await rejects(Buffer.concat([Buffer.from(encode()), Buffer.from([0xf0, 0x9f])]), 'invalid-utf8');
  await rejects(encode().replace('\n', '\n\ufeff'), 'invalid-json');
});

test('실제 byte·header·record·retained 예산을 따로 집행하며 경계는 허용한다', async () => {
  const text = encode(); const byteLength = Buffer.byteLength(text);
  const lengths = text.trimEnd().split('\n').map(line => Buffer.byteLength(line + '\n'));
  assert.deepEqual(await parseSavedGraphChunks(chunks(text), { bytes: byteLength, headerBytes: lengths[0]!, recordBytes: Math.max(...lengths.slice(1)) }), parseSavedGraphInput(text));
  for (const [limits, code] of [
    [{ bytes: byteLength - 1 }, 'stream-too-large'],
    [{ headerBytes: lengths[0]! - 1 }, 'stream-line-too-large'],
    [{ recordBytes: Math.max(...lengths.slice(1)) - 1 }, 'stream-line-too-large'],
    [{ retainedBytes: 1 }, 'stream-retained-limit'],
  ] as const) {
    await assert.rejects(parseSavedGraphChunks(chunks(text), limits), error => error instanceof SavedGraphError && error.code === code);
  }
});

test('주입 상한은 제품 최대를 올리지 못하고 큰 chunk도 거부한다', async () => {
  async function* overHeader() {
    const padding = Buffer.alloc(64 * 1024, 32);
    for (let index = 0; index < SAVED_GRAPH_STREAM_LIMITS.headerBytes / padding.byteLength; index++) yield padding;
    yield new Uint8Array([32]);
  }
  await assert.rejects(parseSavedGraphChunks(overHeader(), { headerBytes: SAVED_GRAPH_STREAM_LIMITS.headerBytes * 2 }), error => error instanceof SavedGraphError && error.code === 'stream-line-too-large');
  await assert.rejects(parseSavedGraphChunks(chunks(new Uint8Array(1024 * 1024 + 1), 1024 * 1024 + 1)), error => error instanceof SavedGraphError && error.code === 'stream-chunk-too-large');
  for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(parseSavedGraphChunks(chunks(encode()), { bytes: value }), RangeError);
  }
});

test('parser 거부는 iterator를 닫고 count 충족 뒤의 read 오류도 성공으로 바꾸지 않는다', async () => {
  let closed = false, readPastFailure = false;
  async function* bad() {
    try { yield Buffer.from('null\n'); readPastFailure = true; yield Buffer.from(encode()); }
    finally { closed = true; }
  }
  await assert.rejects(parseSavedGraphChunks(bad()), SavedGraphError);
  assert.equal(closed, true); assert.equal(readPastFailure, false);
  const failure = new Error('synthetic read failure'); closed = false;
  async function* lateFailure() {
    try { yield* chunks(encode()); throw failure; }
    finally { closed = true; }
  }
  await assert.rejects(parseSavedGraphChunks(lateFailure()), error => error === failure);
  assert.equal(closed, true);
});
