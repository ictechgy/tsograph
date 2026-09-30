/**
 * 다중 출발 단일 패스 `traverse`를 옛 root별 너비 우선 알고리즘(테스트 오라클)과 무작위 그래프에서 비교한다.
 *
 * 오라클은 문서화한 의미를 그대로 계산한다: root마다 최단 거리, 자기 자신이 아닌 root만 싣는 `roots`,
 * 가장 가까운 root(같으면 작은 인덱스) 기준 depth, 그 root에서 depth-1에 있는 선행 정점 중 가장 작은 id의
 * via. 도달 목록(id·depth·via·roots·relationships)은 언제나 같아야 한다. `rootsTruncated`가 거짓이면 잘림
 * 이유도 같아야 하고, 참이면(정점당 root 64개 초과) `depth` 이유는 단일 패스 쪽이 부분집합일 수 있다.
 * max-reached로 잘린 문서에서는 단일 패스가 버린 정점의 root 초과까지 `rootsTruncated`로 알릴 수 있다.
 *
 * 근거 등급도 정의대로 계산한다: 모드가 허용하는 등급별 그래프에서 root마다 거리를 구하고, 정점에 깊이 상한 안에서
 * 닿는 모든 root(자기 제외, 64개 상한과 무관) 각각의 가장 강한 등급 중 가장 약한 것이 `evidence`다.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareStrings } from '../exchange/sorted-json.ts';
import { type CallGraph, EDGE_EVIDENCE_ORDER, type DispatchMode, type EdgeEvidence, type EdgeKind, type GraphEdge, weakestEvidence } from './graph-model.ts';
import { MAX_ROOTS_PER_NODE, traverse, type TraversalRequest, type TraversalResult } from './traversal.ts';

/** 오라클의 방향·등급별 그래프다. */
interface OracleGraph {
  readonly neighbors: Map<string, string[]>;
  readonly predecessors: Map<string, string[]>;
  readonly kinds: Map<string, EdgeKind[]>;
}

/**
 * 등급 이하 간선으로 방향 그래프를 만든다(같은 쌍의 종류는 합친다).
 *
 * @param edges 간선
 * @param forward 정방향이면 true
 * @param tier 허용하는 가장 약한 등급
 * @returns 오라클 그래프
 */
function oracleGraph(edges: readonly GraphEdge[], forward: boolean, tier: EdgeEvidence): OracleGraph {
  const neighbors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  const kinds = new Map<string, EdgeKind[]>();
  for (const edge of edges.filter((candidate) => EDGE_EVIDENCE_ORDER.indexOf(candidate.evidence) <= EDGE_EVIDENCE_ORDER.indexOf(tier))) {
    const [from, to] = forward ? [edge.from, edge.to] : [edge.to, edge.from];
    const key = `${from}\u0000${to}`;
    if (!kinds.has(key)) {
      neighbors.set(from, [...(neighbors.get(from) ?? []), to]);
      predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
    }
    kinds.set(key, [...new Set([...(kinds.get(key) ?? []), ...edge.kinds])].sort(compareStrings));
  }
  return { neighbors, predecessors, kinds };
}

/**
 * root 하나의 깊이 제한 너비 우선 거리다.
 *
 * @param graph 오라클 그래프
 * @param root root id
 * @param maxDepth 최대 깊이
 * @returns 거리와 깊이 잘림 여부
 */
function distancesFrom(graph: OracleGraph, root: string, maxDepth: number): { depths: Map<string, number>; cut: boolean } {
  const depths = new Map([[root, 0]]);
  const queue = [root];
  let cut = false;
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    const depth = depths.get(node)!;
    const next = graph.neighbors.get(node) ?? [];
    if (depth >= maxDepth) {
      cut ||= next.some((neighbor) => !depths.has(neighbor));
      continue;
    }
    for (const neighbor of next) {
      if (!depths.has(neighbor)) {
        depths.set(neighbor, depth + 1);
        queue.push(neighbor);
      }
    }
  }
  return { depths, cut };
}

/**
 * 옛 root별 알고리즘이다(오라클). 근거 등급은 등급별 root 거리로 정의대로 구한다.
 *
 * @param graph 그래프
 * @param request 요청
 * @returns 탐색 결과
 */
function oracle(graph: CallGraph, request: TraversalRequest): TraversalResult {
  const forward = request.direction === 'dependencies';
  const tiers = EDGE_EVIDENCE_ORDER.slice(0, EDGE_EVIDENCE_ORDER.indexOf(weakestEvidence(request.dispatch)) + 1);
  const full = oracleGraph(graph.edges, forward, tiers.at(-1)!);
  const runs = request.rootIds.map((root) => distancesFrom(full, root, request.maxDepth));
  const distances = runs.map((run) => run.depths);
  const tierDistances = tiers.map((tier) => request.rootIds.map((root) => distancesFrom(oracleGraph(graph.edges, forward, tier), root, request.maxDepth).depths));
  const depthCut = runs.some((run) => run.cut);
  const rows: { id: string; depth: number; via: string; roots: number[]; evidence: EdgeEvidence }[] = [];
  const ids = new Set(distances.flatMap((depths) => [...depths.keys()]));
  for (const id of ids) {
    const roots = distances.map((depths, index) => (request.rootIds[index] !== id && depths.has(id) ? index : -1)).filter((index) => index >= 0);
    if (roots.length === 0) continue;
    const depth = Math.min(...roots.map((index) => distances[index]!.get(id)!));
    const nearest = roots.find((index) => distances[index]!.get(id) === depth)!;
    const via = (full.predecessors.get(id) ?? []).filter((candidate) => distances[nearest]!.get(candidate) === depth - 1).sort(compareStrings)[0]!;
    const weakest = Math.max(...roots.map((index) => tierDistances.findIndex((byRoot) => byRoot[index]!.has(id))));
    rows.push({ id, depth, via, roots, evidence: tiers[weakest]! });
  }
  rows.sort((left, right) => left.depth - right.depth || compareStrings(left.id, right.id));
  const kept = rows.slice(0, request.maxReached);
  const reasons: TraversalResult['truncationReasons'][number][] = [];
  if (depthCut) reasons.push('depth');
  if (rows.length > kept.length) reasons.push('max-reached');
  return {
    reached: kept.map((row) => ({
      id: row.id, via: row.via, depth: row.depth, roots: row.roots.slice(0, MAX_ROOTS_PER_NODE),
      relationships: full.kinds.get(`${row.via}\u0000${row.id}`) ?? [], evidence: row.evidence,
    })),
    truncationReasons: reasons,
    rootsTruncated: kept.some((row) => row.roots.length > MAX_ROOTS_PER_NODE),
    evidenceApproximated: false,
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
  const edges = ids.flatMap((from) => ids.filter(() => next() < density).flatMap((to) => randomEdges(next, from, to)));
  edges.sort((left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to)
    || EDGE_EVIDENCE_ORDER.indexOf(left.evidence) - EDGE_EVIDENCE_ORDER.indexOf(right.evidence));
  const shuffled = [...ids].sort(() => next() - 0.5);
  const depths = [1, 2, 3, 128];
  return {
    graph: {
      nodes: ids.map((id) => ({ id, kind: 'function', location: { path: 'a.ts', line: 1, column: 1 } })),
      edges,
      limitations: [],
      limitationsByMode: { direct: [], bound: [], candidates: [] },
      statistics: { files: 1, calls: { resolved: 0, external: 0, missingDependencies: 0, unresolved: { parameter: 0, interface: 0, untyped: 0, computed: 0, indirect: 0, 'unresolved-import': 0 }, dispatch: { bound: 0, boundPartial: 0, candidate: 0, candidatePartial: 0, overBudget: 0 } } },
    },
    request: {
      rootIds: shuffled.slice(0, rootCount),
      direction: next() < 0.5 ? 'dependencies' : 'dependents',
      maxDepth: depths[Math.floor(next() * depths.length)]!,
      maxReached: next() < 0.2 ? Math.max(1, Math.floor(next() * size)) : 100_000,
      dispatch: DISPATCH_CHOICES[Math.floor(next() * DISPATCH_CHOICES.length)]!,
    },
  };
}

/** 무작위 요청의 모드 선택지다(bound·candidates를 더 자주 고른다). */
const DISPATCH_CHOICES: readonly DispatchMode[] = ['direct', 'bound', 'bound', 'candidates', 'candidates'];

/**
 * 한 쌍의 무작위 간선을 만든다. 대개 direct 하나이고, 가끔 bound·candidate이거나 같은 쌍에 근거가 다른 간선이
 * 둘 있다(스냅샷처럼 약한 쪽은 강한 쪽이 덮지 않는 종류를 가진다).
 *
 * @param next 난수 함수
 * @param from 출발
 * @param to 도착
 * @returns 간선(1~2개)
 */
function randomEdges(next: () => number, from: string, to: string): GraphEdge[] {
  // `contains`(인라인 콜백의 어휘적 포함)는 스냅샷에서 언제나 direct지만, 순회는 종류를 가리지 않으므로 같은 표본에 섞는다.
  const edgeKinds: EdgeKind[] = ['call', 'callback', 'alias', 'contains'];
  const roll = next();
  const evidence: EdgeEvidence = roll < 0.6 ? 'direct' : roll < 0.8 ? 'bound' : 'candidate';
  const first: GraphEdge = { from, to, kinds: [edgeKinds[Math.floor(next() * edgeKinds.length)]!], evidence };
  if (evidence === 'candidate' || next() < 0.8) return [first];
  const weaker: EdgeEvidence = evidence === 'direct' ? 'bound' : 'candidate';
  const kind = first.kinds[0] === 'call' ? 'reference' : 'call';
  return [first, { from, to, kinds: [kind], evidence: weaker }];
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
  const edge = (from: string, to: string, evidence: EdgeEvidence = 'direct'): GraphEdge => ({ from, to, kinds: ['call'], evidence });
  // r79만 허브에 candidate로 닿는다: 64개 상한으로 목록에서 빠지지만 허브 너머의 등급은 candidate가 된다.
  const edges = [
    ...roots.map((root) => edge(root, 'hub', root === 'r79' ? 'candidate' : 'direct')),
    edge('hub', 'r05'), edge('hub', 'tail'), edge('tail', 'end'),
  ].sort((left, right) => compareStrings(left.from, right.from) || compareStrings(left.to, right.to));
  const ids = [...roots, 'hub', 'tail', 'end'];
  const graph: CallGraph = { ...randomCase(random(1), 1, 0, 1).graph, nodes: ids.map((id) => ({ id, kind: 'function', location: { path: 'a.ts', line: 1, column: 1 } })), edges };
  for (const rootIds of [roots, [...roots].reverse()]) {
    for (const maxDepth of [1, 2, 128]) {
      for (const dispatch of ['direct', 'candidates'] as const) {
        compare(`hub ${rootIds[0]} ${maxDepth} ${dispatch}`, graph, { rootIds, direction: 'dependencies', maxDepth, maxReached: 100_000, dispatch });
      }
    }
  }
  const all = traverse(graph, { rootIds: roots, direction: 'dependencies', maxDepth: 128, maxReached: 100_000, dispatch: 'candidates' });
  assert.equal(all.reached.find((row) => row.id === 'tail')?.evidence, 'candidate');
  assert.ok(!all.reached.find((row) => row.id === 'tail')!.roots.includes(79));
  const r05 = traverse(graph, { rootIds: roots, direction: 'dependencies', maxDepth: 128, maxReached: 100_000, dispatch: 'bound' }).reached.find((row) => row.id === 'r05')!;
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

test('무작위 사례가 세 등급을 모두 낸다(등급 비교가 실제로 일어난다)', () => {
  const next = random(99);
  const seen = new Set<EdgeEvidence>();
  for (let iteration = 0; iteration < 300; iteration++) {
    const size = 2 + Math.floor(next() * 12);
    const { graph, request } = randomCase(next, size, 0.1 + next() * 0.3, 1 + Math.floor(next() * 3));
    traverse(graph, { ...request, dispatch: 'candidates' }).reached.forEach((row) => seen.add(row.evidence));
  }
  assert.deepEqual([...seen].sort(), ['bound', 'candidate', 'direct']);
});

test('메모리 상한을 넘으면 evidence를 근사하되 오라클보다 강하게 적지 않고 근사를 알린다', () => {
  const next = random(4242);
  let approximated = 0;
  let understated = 0;
  for (let iteration = 0; iteration < 400; iteration++) {
    const size = 2 + Math.floor(next() * 14);
    const { graph, request } = randomCase(next, size, 0.1 + next() * 0.3, 1 + Math.floor(next() * 4));
    const bounded = { ...request, dispatch: 'candidates' as const, evidenceMemoryBytes: 1 };
    const expected = oracle(graph, bounded);
    const actual = traverse(graph, bounded);
    // 도달 목록·depth·via·roots는 근사와 무관하게 같다.
    assert.deepEqual(actual.reached.map(({ evidence: _e, ...row }) => row), expected.reached.map(({ evidence: _e, ...row }) => row));
    for (const row of actual.reached) {
      const exact = expected.reached.find((candidate) => candidate.id === row.id)!.evidence;
      const stronger = EDGE_EVIDENCE_ORDER.indexOf(row.evidence) < EDGE_EVIDENCE_ORDER.indexOf(exact);
      assert.ok(!stronger, `#${iteration} ${row.id}: ${row.evidence} overstates ${exact}`);
      if (row.evidence !== exact) understated++;
    }
    if (actual.evidenceApproximated) approximated++;
  }
  assert.ok(approximated > 0 && understated > 0, `approximated ${approximated}, understated ${understated}`);
});
