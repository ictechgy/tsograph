import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { CallGraph, EdgeKind } from './graph-model.ts';
import { MAX_ROOTS_PER_NODE, traverse, type TraversalRequest } from './traversal.ts';

/**
 * `a>b` 형식의 간선 목록으로 그래프를 만든다.
 *
 * @param edges `from>to` 목록(종류는 call, `from>to:kind`로 바꾼다)
 * @returns 그래프
 */
function graphOf(edges: readonly string[]): CallGraph {
  const parsed = edges.map((edge) => {
    const [pair, kind] = edge.split(':');
    const [from, to] = pair!.split('>');
    return { from: from!, to: to!, kinds: [(kind ?? 'call') as EdgeKind] };
  });
  const ids = [...new Set(parsed.flatMap((edge) => [edge.from, edge.to]))].sort();
  return {
    nodes: ids.map((id) => ({ id, kind: 'function', location: { path: 'a.ts', line: 1, column: 1 } })),
    edges: parsed,
    limitations: [],
    statistics: { files: 1, calls: { resolved: 0, external: 0, missingDependencies: 0, unresolved: { parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 } } },
  };
}

/**
 * 탐색 결과를 `id depth via [roots] kinds` 문자열로 줄인다.
 *
 * @param graph 그래프
 * @param request 요청 일부
 * @returns 결과 문자열과 잘림 정보
 */
function run(graph: CallGraph, request: Partial<TraversalRequest> & { rootIds: string[] }) {
  const result = traverse(graph, { direction: 'dependencies', maxDepth: 128, maxReached: 1000, ...request });
  return {
    lines: result.reached.map((entry) => `${entry.id} ${entry.depth} ${entry.via} [${entry.roots.join(',')}] ${entry.relationships.join(',')}`),
    reasons: result.truncationReasons,
    rootsTruncated: result.rootsTruncated,
  };
}

test('여러 root의 출처를 보존하고 최단 깊이·결정적 via를 고른다', () => {
  const graph = graphOf(['r1>a', 'r1>b', 'a>c', 'b>c', 'r2>c:callback', 'c>d', 'r2>r1:alias']);
  const { lines, reasons } = run(graph, { rootIds: ['r1', 'r2'] });
  // root(r1)도 다른 root(r2)에서 닿으면 싣되 자기 인덱스는 빼고, 그 너머 정점은 두 인덱스를 모두 싣는다.
  assert.deepEqual(lines, [
    'a 1 r1 [0,1] call',
    'b 1 r1 [0,1] call',
    'c 1 r2 [0,1] callback',
    'r1 1 r2 [1] alias',
    'd 2 c [0,1] call',
  ]);
  assert.deepEqual(reasons, []);
});

test('다른 root가 부르는 root는 그 root 인덱스만 싣는다(핸들러 A → 도우미 H, H도 root)', () => {
  const graph = graphOf(['A>H', 'H>db', 'A>other']);
  assert.deepEqual(run(graph, { rootIds: ['A', 'H'] }).lines, [
    'H 1 A [0] call',
    'db 1 H [0,1] call',
    'other 1 A [0] call',
  ]);
  // 역방향도 같다: 테이블을 모두 root로 주면 서로 닿는 root가 사라지지 않는다.
  assert.deepEqual(run(graph, { rootIds: ['db', 'H'], direction: 'dependents' }).lines, [
    'A 1 H [0,1] call',
    'H 1 db [0] call',
  ]);
});

test('자기 자신에게서만 닿는 root(순환)는 싣지 않고, 자기 순환 경로는 깊이에 쓰지 않는다', () => {
  const graph = graphOf(['A>q', 'q>p', 'p>H', 'H>p']);
  // H의 depth·via는 다른 root(A) 기준이다. p는 H에서도 닿으므로 더 얕다(계약 보고 사항).
  assert.deepEqual(run(graph, { rootIds: ['A', 'H'] }).lines, [
    'p 1 H [0,1] call',
    'q 1 A [0] call',
    'H 3 p [0] call',
  ]);
});

test('순환은 한 번만 돌고 root 자신은 싣지 않는다', () => {
  const graph = graphOf(['a>b', 'b>a', 'b>c']);
  assert.deepEqual(run(graph, { rootIds: ['a'] }).lines, ['b 1 a [0] call', 'c 2 b [0] call']);
});

test('역방향은 호출자를 따라간다', () => {
  const graph = graphOf(['h1>svc', 'h2>svc', 'svc>db', 'x>y']);
  assert.deepEqual(run(graph, { rootIds: ['db'], direction: 'dependents' }).lines, [
    'svc 1 db [0] call',
    'h1 2 svc [0] call',
    'h2 2 svc [0] call',
  ]);
});

test('깊이·개수 예산을 넘으면 자르고 이유를 싣는다', () => {
  const graph = graphOf(['a>b', 'b>c', 'c>d', 'a>e']);
  const depth = run(graph, { rootIds: ['a'], maxDepth: 1 });
  assert.deepEqual(depth.lines, ['b 1 a [0] call', 'e 1 a [0] call']);
  assert.deepEqual(depth.reasons, ['depth']);
  // 잘린 곳 너머에 새 노드가 없으면 잘림이 아니다.
  assert.deepEqual(run(graph, { rootIds: ['a'], maxDepth: 3 }).reasons, []);
  const count = run(graph, { rootIds: ['a'], maxReached: 2 });
  assert.deepEqual(count.lines, ['b 1 a [0] call', 'e 1 a [0] call']);
  assert.deepEqual(count.reasons, ['max-reached']);
  // 깊이 제한 끝에서 이미 본 정점(root 포함)으로 돌아가는 간선은 잘림이 아니다.
  const loop = graphOf(['a>b', 'b>a']);
  assert.deepEqual(run(loop, { rootIds: ['a'], maxDepth: 1 }).reasons, []);
});

test('노드 하나의 root 인덱스는 64개까지만 싣는다', () => {
  const roots = Array.from({ length: MAX_ROOTS_PER_NODE + 1 }, (_, index) => `r${String(index).padStart(2, '0')}`);
  const graph = graphOf(roots.map((root) => `${root}>shared`));
  const result = traverse(graph, { rootIds: roots, direction: 'dependencies', maxDepth: 128, maxReached: 10 });
  assert.equal(result.rootsTruncated, true);
  assert.equal(result.reached[0]?.roots.length, MAX_ROOTS_PER_NODE);
  assert.equal(result.reached[0]?.via, 'r00');
});
