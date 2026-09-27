/**
 * 다중 출발 단일 패스 `traverse`를 옛 root별 너비 우선 알고리즘(테스트 오라클)과 무작위 그래프에서 비교한다.
 *
 * 오라클은 문서화한 의미를 그대로 계산한다: root마다 최단 거리, 자기 자신이 아닌 root만 싣는 `roots`,
 * 가장 가까운 root(같으면 작은 인덱스) 기준 depth, 그 root에서 depth-1에 있는 선행 정점 중 가장 작은 id의
 * via. 도달 목록(id·depth·via·roots·relationships)은 언제나 같아야 한다. `rootsTruncated`가 거짓이면 잘림
 * 이유도 같아야 하고, 참이면(정점당 root 64개 초과) `depth` 이유는 단일 패스 쪽이 부분집합일 수 있다.
 * max-reached로 잘린 문서에서는 단일 패스가 버린 정점의 root 초과까지 `rootsTruncated`로 알릴 수 있다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareStrings } from '../exchange/sorted-json.ts';
import type { CallGraph, EdgeKind } from './graph-model.ts';
import { MAX_ROOTS_PER_NODE, traverse, type TraversalRequest, type TraversalResult } from './traversal.ts';

/**
 * 옛 root별 알고리즘이다(오라클).
 *
 * @param graph 그래프
 * @param request 요청
 * @returns 탐색 결과
 */
function oracle(graph: CallGraph, request: TraversalRequest): TraversalResult {
  const forward = request.direction === 'dependencies';
  const neighbors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  const kinds = new Map<string, readonly EdgeKind[]>();
  for (const edge of graph.edges) {
    const [from, to] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
    neighbors.set(from, [...(neighbors.get(from) ?? []), to]);
    predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
    kinds.set(`${from}\u0000${to}`, edge.kinds);
  }
  const distances = request.rootIds.map(() => new Map<string, number>());
  let depthCut = false;
  request.rootIds.forEach((root, index) => {
    const depths = distances[index]!;
    depths.set(root, 0);
    const queue = [root];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head]!;
      const depth = depths.get(node)!;
      const next = neighbors.get(node) ?? [];
      if (depth >= request.maxDepth) {
        depthCut ||= next.some((neighbor) => !depths.has(neighbor));
        continue;
      }
      for (const neighbor of next) {
        if (!depths.has(neighbor)) {
          depths.set(neighbor, depth + 1);
          queue.push(neighbor);
        }
      }
    }
  });
  const rows: { id: string; depth: number; via: string; roots: number[] }[] = [];
  const ids = new Set(distances.flatMap((depths) => [...depths.keys()]));
  for (const id of ids) {
    const roots = distances.map((depths, index) => (request.rootIds[index] !== id && depths.has(id) ? index : -1)).filter((index) => index >= 0);
    if (roots.length === 0) continue;
    const depth = Math.min(...roots.map((index) => distances[index]!.get(id)!));
    const nearest = roots.find((index) => distances[index]!.get(id) === depth)!;
    const via = (predecessors.get(id) ?? []).filter((candidate) => distances[nearest]!.get(candidate) === depth - 1).sort(compareStrings)[0]!;
    rows.push({ id, depth, via, roots });
  }
  rows.sort((left, right) => left.depth - right.depth || compareStrings(left.id, right.id));
  const kept = rows.slice(0, request.maxReached);
  const reasons: TraversalResult['truncationReasons'][number][] = [];
  if (depthCut) reasons.push('depth');
  if (rows.length > kept.length) reasons.push('max-reached');
  return {
    reached: kept.map((row) => ({
      id: row.id, via: row.via, depth: row.depth, roots: row.roots.slice(0, MAX_ROOTS_PER_NODE),
      relationships: kinds.get(`${row.via}\u0000${row.id}`) ?? [],
    })),
    truncationReasons: reasons,
    rootsTruncated: kept.some((row) => row.roots.length > MAX_ROOTS_PER_NODE),
  };
}

/**
 * 시드 고정 난수 생성기(mulberry32)다.
 *
 * @param seed 시드
 * @returns [0, 1) 난수 함수
 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 무작위 그래프와 요청을 만든다.
 *
 * @param next 난수 함수
 * @param size 정점 수
 * @param density 간선 확률
 * @param rootCount root 수
 * @returns 그래프와 요청
 */
function randomCase(next: () => number, size: number, density: number, rootCount: number): { graph: CallGraph; request: TraversalRequest } {
  const ids = Array.from({ length: size }, (_, index) => `n${String(Math.floor(next() * 1000)).padStart(3, '0')}-${index}`);
  const edgeKinds: EdgeKind[] = ['call', 'callback', 'alias'];
  const edges = ids.flatMap((from) => ids.filter(() => next() < density).map((to) => ({ from, to, kinds: [edgeKinds[Math.floor(next() * 3)]!] })));
  edges.sort((left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to));
  const shuffled = [...ids].sort(() => next() - 0.5);
  const depths = [1, 2, 3, 128];
  return {
    graph: {
      nodes: ids.map((id) => ({ id, kind: 'function', location: { path: 'a.ts', line: 1, column: 1 } })),
      edges,
      limitations: [],
      statistics: { files: 1, calls: { resolved: 0, external: 0, missingDependencies: 0, unresolved: { parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 } } },
    },
    request: {
      rootIds: shuffled.slice(0, rootCount),
      direction: next() < 0.5 ? 'dependencies' : 'dependents',
      maxDepth: depths[Math.floor(next() * depths.length)]!,
      maxReached: next() < 0.2 ? Math.max(1, Math.floor(next() * size)) : 100_000,
    },
  };
}

/**
 * 한 사례를 비교한다.
 *
 * @param label 사례 이름
 * @param graph 그래프
 * @param request 요청
 */
function compare(label: string, graph: CallGraph, request: TraversalRequest): void {
  const expected = oracle(graph, request);
  const actual = traverse(graph, request);
  assert.deepEqual(actual.reached, expected.reached, label);
  // max-reached로 잘린 문서에서는 버린 정점의 root 초과도 rootsTruncated로 알린다(보수적). 그 밖에는 같다.
  if (expected.truncationReasons.includes('max-reached')) assert.ok(actual.rootsTruncated || !expected.rootsTruncated, label);
  else assert.equal(actual.rootsTruncated, expected.rootsTruncated, label);
  if (!expected.rootsTruncated && !actual.rootsTruncated) {
    assert.deepEqual(actual.truncationReasons, expected.truncationReasons, label);
  } else {
    assert.ok(actual.truncationReasons.every((reason) => expected.truncationReasons.includes(reason)), label);
  }
}

test('root 80개가 한 허브로 모이는 그래프(전파 중단 경로)도 오라클과 같다', () => {
  const roots = Array.from({ length: 80 }, (_, index) => `r${String(index).padStart(2, '0')}`);
  const edges = [
    ...roots.map((root) => ({ from: root, to: 'hub', kinds: ['call' as EdgeKind] })),
    { from: 'hub', to: 'r05', kinds: ['call' as EdgeKind] }, { from: 'hub', to: 'tail', kinds: ['call' as EdgeKind] },
    { from: 'tail', to: 'end', kinds: ['call' as EdgeKind] },
  ].sort((left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to));
  const ids = [...roots, 'hub', 'tail', 'end'];
  const graph: CallGraph = { ...randomCase(random(1), 1, 0, 1).graph, nodes: ids.map((id) => ({ id, kind: 'function', location: { path: 'a.ts', line: 1, column: 1 } })), edges };
  for (const rootIds of [roots, [...roots].reverse()]) {
    for (const maxDepth of [1, 2, 128]) compare(`hub ${rootIds[0]} ${maxDepth}`, graph, { rootIds, direction: 'dependencies', maxDepth, maxReached: 100_000 });
  }
  const r05 = traverse(graph, { rootIds: roots, direction: 'dependencies', maxDepth: 128, maxReached: 100_000 }).reached.find((row) => row.id === 'r05')!;
  // r05는 다른 root 79개가 허브를 거쳐 닿지만 자기 인덱스(5)는 없고, 작은 인덱스 64개만 싣는다.
  assert.equal(r05.roots.length, MAX_ROOTS_PER_NODE);
  assert.ok(!r05.roots.includes(5));
  assert.equal(r05.roots.at(-1), 64);
});

test('작은 무작위 그래프에서 단일 패스는 root별 오라클과 같다', () => {
  const next = random(20260927);
  for (let iteration = 0; iteration < 1500; iteration++) {
    const size = 1 + Math.floor(next() * 12);
    const { graph, request } = randomCase(next, size, next() * 0.4, 1 + Math.floor(next() * size));
    compare(`small #${iteration}`, graph, request);
  }
});

test('root가 64개를 넘는 큰 무작위 그래프에서도 도달 목록이 오라클과 같다', () => {
  const next = random(7);
  let truncatedCases = 0;
  for (let iteration = 0; iteration < 40; iteration++) {
    const size = 90 + Math.floor(next() * 40);
    const { graph, request } = randomCase(next, size, 0.02 + next() * 0.05, 66 + Math.floor(next() * 20));
    compare(`large #${iteration}`, graph, request);
    if (traverse(graph, request).rootsTruncated) truncatedCases++;
  }
  assert.ok(truncatedCases > 0, 'at least one case exercises the 64-root cap');
});
