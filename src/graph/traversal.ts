/**
 * 그래프를 root 집합에서 정방향(dependencies) 또는 역방향(dependents)으로 훑는다.
 *
 * 의미(isthmus `language-traversal` v1, 2026-09-27 개정):
 * - `reached`는 자기 자신이 아닌 root에서 1개 이상의 간선으로(깊이 상한 안에서) 닿은 정점 전부다. root이기도
 *   한 정점도 싣되 `roots`에는 그에 닿는 **다른** root만 넣는다. 자기 자신에게서만 닿는 root는 싣지 않는다.
 * - `depth`는 그 root들 중 가장 가까운 것까지의 거리, `via`는 가장 가까운 root(같은 거리면 작은 인덱스)에서
 *   depth-1 거리에 있는 선행 정점 중 id가 가장 작은 것이다(깊이 1이면 그 root id).
 *
 * 구현은 모든 root를 한 번에 출발시키는 단계 동기(level-synchronous) 너비 우선 패스다. 정점마다
 * (root 인덱스 → 처음 닿은 단계)를 기록하고 새로 닿은 쌍만 다음 단계로 넘긴다. 정점이 자기 자신이 아닌
 * root 중 더 작은 인덱스를 이미 65개 이상 가졌다면 더 큰 인덱스 root는 그 정점에서 전파를 멈춘다 — 그 65개가
 * 같은 경로로 같거나 더 얕게 닿으므로, 그 너머 정점이 자기 인덱스 하나를 빼도 더 작은 root가 64개 남아 그
 * root는 어디서도 출력(작은 인덱스 64개, depth, via)을 바꾸지 못한다(64개면 아래 정점이 자기 인덱스를 빼는
 * 순간 모자란다 — 무작위 비교 테스트가 찾은 경우다). 그래서 작은 인덱스 root가 먼저 닿는 정점은 쌍이 65개 남짓으로
 * 묶이지만, 큰 인덱스 root가 먼저 닿는 정점은 작은 인덱스가 65개 차기 전에 들어온 root를 모두 든다(root 500개를 준
 * 허브형 합성 그래프에서 정점당 평균 175개).
 * 옛 root별 알고리즘과의 동등성은 무작위 그래프 테스트(`traversal-oracle.test.ts`)로 확인한다. 전파를 멈춘
 * 경우(`rootsTruncated: true`)에는 깊이 잘림(`depth`)을 도달 정점 집합이 불완전할 때만 알린다.
 *
 * 탐색을 시작할 때 정점 id를 한 번 정수로 바꾸고 이웃 목록을 CSR 배열로 만든다. 간선마다 문자열 키 Map을 찾지 않게
 * 하려는 것이다. 지배 판정은 정점마다 자기 자신이 아닌 가장 작은 root 인덱스 65개를 들고 65번째 값과 비교한다.
 * 같은 단계 안의 처리 순서(경계에 들어온 순서, 이웃 순서)가 지배 판정에 들어가는 root를 정하므로 순서는 그대로 둔다.
 *
 * 디스패치 모드(`direct`·`bound`·`candidates`)는 따라갈 간선 근거를 정한다(direct ⊂ bound ⊂ candidate).
 * depth·via·roots는 모드가 허용하는 전체 그래프 기준이다. 정점의 `evidence`는 root별 하한이다: 그 정점에
 * 깊이 상한 안에서 닿는 **모든** root(64개 상한으로 목록에서 빠진 root 포함, 자기 자신 제외) 각각에 대해 그
 * root가 닿는 가장 강한 등급을 구하고, 그중 가장 약한 것이다. 약한 간선의 출발점에 닿을 수 없는 root는 모든
 * 등급에서 같은 거리로 닿으므로 direct다 — 그래서 약한 간선 출발점에 깊이 상한 안에서 닿는 root만 비트 집합으로
 * 등급별 정확한 도달을 구해 비교한다.
 */

import { compareStrings } from '../exchange/sorted-json.ts';
import {
  type CallGraph,
  EDGE_EVIDENCE_ORDER,
  type DispatchMode,
  type EdgeEvidence,
  type EdgeKind,
  evidenceAllowed,
  weakestEvidence,
} from './graph-model.ts';

/** 탐색 방향이다. */
export type TraversalDirection = 'dependencies' | 'dependents';

/** 노드 하나가 싣는 root 인덱스의 상한이다(계약의 `rootsTruncated`). */
export const MAX_ROOTS_PER_NODE = 64;

/** 계약이 허용하는 최대 깊이다. */
export const MAX_TRAVERSAL_DEPTH = 128;

/** 탐색 요청이다. */
export interface TraversalRequest {
  readonly rootIds: readonly string[];
  readonly direction: TraversalDirection;
  /** 최대 깊이(간선 수, 1~128) */
  readonly maxDepth: number;
  /** 최대 도달 노드 수 */
  readonly maxReached: number;
  /** 따라갈 간선 근거 범위 */
  readonly dispatch: DispatchMode;
  /** 정확한 등급 비교에 쓸 비트 집합 메모리 상한(바이트, 테스트 주입용). 기본 `EVIDENCE_MEMORY_BYTES` */
  readonly evidenceMemoryBytes?: number;
}

/** 정확한 등급 비교(root당 비트 하나)가 쓸 수 있는 메모리 상한이다. 넘으면 보수적 근사로 바꾼다. */
export const EVIDENCE_MEMORY_BYTES = 64 * 1024 * 1024;

/** 도달한 노드 하나다. */
export interface ReachedSymbol {
  readonly id: string;
  readonly via: string;
  readonly depth: number;
  /** 닿는 root 인덱스(정렬, 최대 64개) */
  readonly roots: readonly number[];
  /** via와 이 노드 사이 간선의 종류(정렬) */
  readonly relationships: readonly EdgeKind[];
  /** root별 하한 근거 등급 */
  readonly evidence: EdgeEvidence;
}

/** 탐색이 잘린 이유다(정렬 순서로 싣는다). */
export type TruncationReason = 'depth' | 'max-reached';

/** 탐색 결과다. */
export interface TraversalResult {
  /** (depth, id) 순 */
  readonly reached: readonly ReachedSymbol[];
  readonly truncationReasons: readonly TruncationReason[];
  readonly rootsTruncated: boolean;
  /** 메모리 상한 때문에 `evidence`를 보수적으로 근사했으면 true(더 약하게 적을 수는 있어도 부풀리지 않는다) */
  readonly evidenceApproximated: boolean;
}

/** 방향에 맞춘 이웃 목록과 간선 종류 조회표다. */
interface Adjacency {
  readonly neighbors: ReadonlyMap<string, readonly string[]>;
  /** 방향 기준 선행 정점(id 순) */
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
  /** `from\0to`(방향 기준) → 종류 */
  readonly kinds: ReadonlyMap<string, readonly EdgeKind[]>;
}

/**
 * 정점 id를 정수로 한 번 바꾼 전체 인접 목록이다(CSR: 정점 v의 이웃은 `targets[offsets[v]]`부터
 * `targets[offsets[v + 1]]` 앞까지). 정점별 이웃 순서는 `Adjacency.neighbors`와 같다.
 */
interface IndexedGraph {
  /** 정수 → 정점 id */
  readonly ids: readonly string[];
  /** 정점 id → 정수 */
  readonly index: ReadonlyMap<string, number>;
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
}

/** 정점별 (root 인덱스 → 처음 닿은 단계) 기록이다(정점 정수 위치, 닿지 않은 정점은 undefined). */
type Levels = readonly (ReadonlyMap<number, number> | undefined)[];

/** 단일 패스의 결과다. */
interface PassResult {
  readonly levels: Levels;
  /** 정점 정수 → 그 정점이 root면 root 인덱스, 아니면 -1 */
  readonly owners: Int32Array;
  /** 정점별 자기 아닌 가장 작은 root 인덱스 65개(65개 이상 든 정점만) */
  readonly smallest: SmallestRoots;
  readonly depthCut: boolean;
  readonly pruned: boolean;
}

/**
 * 탐색한다.
 *
 * @param graph 호출 그래프
 * @param request 탐색 요청(root id는 모두 노드이고 서로 다르다)
 * @returns 탐색 결과
 */
export function traverse(graph: CallGraph, request: TraversalRequest): TraversalResult {
  const tier = weakestEvidence(request.dispatch);
  const adjacency = buildAdjacency(graph, request.direction, tier);
  const indexed = indexGraph(graph, adjacency, request.rootIds);
  const pass = propagate(indexed, request.rootIds, request.maxDepth);
  const rows = reachedRows(adjacency, indexed, pass);
  const kept = rows.slice(0, request.maxReached);
  const reasons: TruncationReason[] = [];
  if (pass.depthCut) reasons.push('depth');
  if (rows.length > kept.length) reasons.push('max-reached');
  const rootsTruncated = pass.pruned || kept.some((row) => row.roots.length > MAX_ROOTS_PER_NODE);
  const evidence = evidenceTiers(graph, request, adjacency, indexed, tier, pass.levels);
  const reached = kept.map((row) => ({ ...row, roots: row.roots.slice(0, MAX_ROOTS_PER_NODE), evidence: evidence.of(row.id) }));
  return { reached, truncationReasons: reasons, rootsTruncated, evidenceApproximated: evidence.approximated };
}

/** 정점별 근거 등급 조회와 근사 여부다. */
interface EvidenceLookup {
  readonly of: (id: string) => EdgeEvidence;
  readonly approximated: boolean;
}

/**
 * 정점의 root별 하한 근거 등급을 구하는 함수를 만든다.
 *
 * 메모리 판정식(정점 수 × 단어 수 × 4 × (등급 수 + 1))은 근사로 바꾸는 조건과 출력을 지키려고 그대로 둔다.
 * 정확 비교는 (정점 수 × 단어 수) 평면 배열 네 개(전체 등급 도달, 재사용하는 하위 등급 도달, 경계 두 벌)를 쓰므로
 * bound 모드에서는 판정식보다 한 벌 많다(정점·단계마다 비트 배열과 Map 항목을 만들던 예전 구현보다는 훨씬 작다).
 *
 * @param graph 호출 그래프
 * @param request 탐색 요청
 * @param full 모드가 허용하는 전체 인접 목록
 * @param indexed 정수 인접 목록(정점 번호를 함께 쓴다)
 * @param tier 모드가 허용하는 가장 약한 근거
 * @param levels 전체 그래프 단계 기록
 * @returns 정점 id → 근거 등급
 */
function evidenceTiers(graph: CallGraph, request: TraversalRequest, full: Adjacency, indexed: IndexedGraph, tier: EdgeEvidence, levels: Levels): EvidenceLookup {
  const tiers = EDGE_EVIDENCE_ORDER.slice(0, EDGE_EVIDENCE_ORDER.indexOf(tier) + 1);
  const weakEdges = graph.edges.filter((edge) => edge.evidence !== 'direct' && evidenceAllowed(edge.evidence, request.dispatch));
  const weakSources = new Set(weakEdges.map((edge) => (request.direction === 'dependencies' ? edge.from : edge.to)));
  const compared = weakTouchingRoots(full, request.rootIds, weakSources, request.maxDepth);
  if (tiers.length === 1 || compared.length === 0) return { of: () => 'direct', approximated: false };
  const estimate = graph.nodes.length * Math.ceil(compared.length / 32) * 4 * (tiers.length + 1);
  if (estimate > (request.evidenceMemoryBytes ?? EVIDENCE_MEMORY_BYTES)) {
    return { of: approximateEvidence(full, indexed, weakEdges, request.direction, levels), approximated: true };
  }
  const tierGraph = buildTierGraph(graph, indexed, request.direction, tiers.length - 1);
  const strongest = strongestTiers(tierGraph, compared.map((root) => indexed.index.get(root)!), tiers.length, request.maxDepth);
  // 도달 행의 정점은 모두 번호가 있다(노드·간선 끝점·root를 모두 번호에 넣었다).
  return { of: (id) => tiers[strongest[indexed.index.get(id)!]!]!, approximated: false };
}

/**
 * 메모리 상한을 넘을 때의 보수적 근거 등급이다: root에서 닿는(단계 기록에 있는) 출발점을 가진 약한 간선의 도착점에서
 * 깊이 제한 없이 닿는 정점을 등급별로 표시하고, 정점이 속한 가장 약한 등급을 싣는다. 어느 표시에도 들지 않는 정점은
 * 모든 root에서 약한 간선 없이 닿으므로 정확히 direct다. candidate 표시가 없으면 어느 root도 candidate 간선이 필요 없어
 * bound 이하이므로, 이 값은 정확한 root별 하한보다 약하게 적을 수는 있어도 부풀리지 않는다.
 *
 * @param full 모드가 허용하는 전체 인접 목록
 * @param indexed 정수 인접 목록(단계 기록의 정점 번호)
 * @param weakEdges 모드가 허용하는 약한(direct가 아닌) 간선
 * @param direction 방향
 * @param levels 전체 그래프 단계 기록(root에서 깊이 상한 안에 닿은 정점)
 * @returns 정점 id → 근거 등급
 */
function approximateEvidence(
  full: Adjacency,
  indexed: IndexedGraph,
  weakEdges: CallGraph['edges'],
  direction: TraversalDirection,
  levels: Levels,
): (id: string) => EdgeEvidence {
  const marks = new Map<string, EdgeEvidence>();
  for (const evidence of ['bound', 'candidate'] as const) {
    const heads = weakEdges.filter((edge) => edge.evidence === evidence)
      .map((edge) => (direction === 'dependencies' ? [edge.from, edge.to] : [edge.to, edge.from]) as [string, string])
      .filter(([tail]) => levels[indexed.index.get(tail)!] !== undefined).map(([, head]) => head);
    const queue = [...new Set(heads)];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const node = queue.pop()!;
      marks.set(node, evidence);
      for (const next of full.neighbors.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return (id) => marks.get(id) ?? 'direct';
}

/**
 * 깊이 상한 안에서 약한 간선의 출발점에 닿을 수 있는 root다(그 밖의 root는 모든 등급에서 같게 닿는다).
 * 약한 간선을 타려면 출발점까지 maxDepth-1 이하여야 한다.
 *
 * @param full 전체 인접 목록
 * @param rootIds root id
 * @param weakSources 약한 간선의 출발점(순회 방향 기준)
 * @param maxDepth 최대 깊이
 * @returns root id 목록(입력 순서)
 */
function weakTouchingRoots(full: Adjacency, rootIds: readonly string[], weakSources: ReadonlySet<string>, maxDepth: number): string[] {
  const seen = new Set(weakSources);
  let frontier = [...weakSources];
  for (let level = 0; level < maxDepth - 1 && frontier.length > 0; level++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const previous of full.predecessors.get(node) ?? []) {
        if (!seen.has(previous)) {
          seen.add(previous);
          next.push(previous);
        }
      }
    }
    frontier = next;
  }
  return rootIds.filter((root) => seen.has(root));
}

/**
 * 등급 비교용 정수 인접 목록이다(CSR). 항목마다 그 간선의 근거 강도를 싣고, 등급별 전파는 그 등급 이하 항목만
 * 따른다 — 등급마다 인접 목록을 다시 만들지 않으려는 것이다. 같은 쌍의 근거별 간선은 항목이 따로 남지만, 같은 비트를
 * 두 번 넘겨도 전파 결과는 같다.
 */
interface TierGraph {
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  /** 항목의 근거 강도(`EDGE_EVIDENCE_ORDER` 인덱스) */
  readonly strengths: Uint8Array;
}

/**
 * 모드가 허용하는 간선으로 등급 비교용 인접 목록을 만든다.
 *
 * @param graph 호출 그래프
 * @param indexed 정점 번호
 * @param direction 방향
 * @param limit 따라갈 가장 약한 근거의 강도
 * @returns 등급 비교용 인접 목록
 */
function buildTierGraph(graph: CallGraph, indexed: IndexedGraph, direction: TraversalDirection, limit: number): TierGraph {
  const size = indexed.ids.length;
  const edges = graph.edges.filter((edge) => EDGE_EVIDENCE_ORDER.indexOf(edge.evidence) <= limit);
  const sources = edges.map((edge) => indexed.index.get(direction === 'dependencies' ? edge.from : edge.to)!);
  const offsets = new Int32Array(size + 1);
  for (const source of sources) offsets[source + 1] = offsets[source + 1]! + 1;
  for (let node = 0; node < size; node++) offsets[node + 1] = offsets[node + 1]! + offsets[node]!;
  const cursors = offsets.slice(0, size);
  const targets = new Int32Array(edges.length);
  const strengths = new Uint8Array(edges.length);
  edges.forEach((edge, position) => {
    const at = cursors[sources[position]!]!;
    cursors[sources[position]!] = at + 1;
    targets[at] = indexed.index.get(direction === 'dependencies' ? edge.to : edge.from)!;
    strengths[at] = EDGE_EVIDENCE_ORDER.indexOf(edge.evidence);
  });
  return { offsets, targets, strengths };
}

/** 등급 전파가 단계마다 재사용하는 경계 버퍼다. 전파가 끝나면 비트는 다시 모두 0이다. */
interface BitFrontier {
  /** 비트 집합 길이(32비트 단어 수) */
  readonly words: number;
  /** 지금 단계와 다음 단계의 정점별 새 비트((정점 수 × words) 평면 배열 두 벌) */
  readonly bits: readonly [Uint32Array, Uint32Array];
  /** 지금 단계와 다음 단계에 새 비트를 받은 정점 */
  readonly nodes: readonly [Int32Array, Int32Array];
  /** 정점이 다음 단계 목록에 들어간 세대 번호 */
  readonly stamps: Int32Array;
  /** 마지막으로 쓴 세대 번호(단계마다 하나씩 늘린다) */
  generation: number;
}

/**
 * 비교 대상 root마다 비트 하나로 등급별 도달을 구해, 정점마다 전체 등급과 같은 root 집합을 주는 가장 강한 등급을
 * 고른다(등급 그래프는 포함 관계라 도달 집합도 포함 관계다). 하위 등급 도달 배열과 경계 버퍼는 등급마다 재사용한다.
 *
 * @param graph 등급 비교용 인접 목록
 * @param roots 비교 대상 root 정점 번호(순번이 비트 위치)
 * @param tierCount 모드가 허용하는 등급 수
 * @param maxDepth 최대 깊이
 * @returns 정점 번호 → 등급 위치(`EDGE_EVIDENCE_ORDER` 인덱스)
 */
function strongestTiers(graph: TierGraph, roots: readonly number[], tierCount: number, maxDepth: number): Uint8Array {
  const size = graph.offsets.length - 1;
  const words = Math.ceil(roots.length / 32);
  const work: BitFrontier = {
    words,
    bits: [new Uint32Array(size * words), new Uint32Array(size * words)],
    nodes: [new Int32Array(size), new Int32Array(size)],
    stamps: new Int32Array(size),
    generation: 0,
  };
  const full = new Uint32Array(size * words);
  reachBits(graph, roots, tierCount - 1, maxDepth, full, work);
  const strongest = new Uint8Array(size).fill(tierCount - 1);
  const lower = new Uint32Array(size * words);
  for (let tier = 0; tier < tierCount - 1; tier++) {
    if (tier > 0) lower.fill(0);
    reachBits(graph, roots, tier, maxDepth, lower, work);
    for (let node = 0; node < size; node++) {
      if (strongest[node] === tierCount - 1 && sameRow(full, lower, node * words, words)) strongest[node] = tier;
    }
  }
  return strongest;
}

/**
 * root마다 비트 하나를 두고 단계 동기로 전파해, 깊이 상한 안에서 각 정점에 닿는 root 비트 집합을 `seen`에 채운다.
 * 단계마다 새 Map·비트 배열을 만들지 않고 경계 버퍼 두 벌을 번갈아 쓰며, 지난 단계 정점의 행만 지운다.
 *
 * @param graph 등급 비교용 인접 목록
 * @param roots 비교 대상 root 정점 번호(순번이 비트 위치, 서로 다르다)
 * @param strength 따라갈 가장 약한 근거의 강도
 * @param maxDepth 최대 깊이
 * @param seen 정점 → 비트 집합 평면 배열(0으로 시작, 갱신)
 * @param work 경계 버퍼(0으로 시작하고 0으로 끝난다)
 */
function reachBits(graph: TierGraph, roots: readonly number[], strength: number, maxDepth: number, seen: Uint32Array, work: BitFrontier): void {
  const { words, stamps } = work;
  let [bits, nextBits] = work.bits;
  let [nodes, nextNodes] = work.nodes;
  let count = roots.length;
  roots.forEach((node, position) => {
    const at = node * words + (position >>> 5);
    seen[at]! |= 1 << (position & 31);
    bits[at]! |= 1 << (position & 31);
    nodes[position] = node;
  });
  for (let level = 0; level < maxDepth && count > 0; level++) {
    const stamp = ++work.generation;
    let nextCount = 0;
    for (let item = 0; item < count; item++) {
      const node = nodes[item]!;
      for (let entry = graph.offsets[node]!, end = graph.offsets[node + 1]!; entry < end; entry++) {
        const neighbor = graph.targets[entry]!;
        if (graph.strengths[entry]! > strength || !spreadBits(bits, node * words, seen, nextBits, neighbor * words, words)) continue;
        if (stamps[neighbor] !== stamp) {
          stamps[neighbor] = stamp;
          nextNodes[nextCount++] = neighbor;
        }
      }
    }
    clearRows(bits, nodes, count, words);
    [bits, nextBits] = [nextBits, bits];
    [nodes, nextNodes] = [nextNodes, nodes];
    count = nextCount;
  }
  clearRows(bits, nodes, count, words);
}

/**
 * 한 간선으로 새 root 비트를 이웃에 넘긴다.
 *
 * @param bits 지금 단계 비트(평면 배열)
 * @param from 출발 정점 행의 시작
 * @param seen 정점이 가진 비트(갱신)
 * @param next 다음 단계 비트(갱신)
 * @param to 이웃 정점 행의 시작
 * @param words 비트 집합 길이(32비트 단어 수)
 * @returns 이웃이 새 비트를 받았으면 true
 */
function spreadBits(bits: Uint32Array, from: number, seen: Uint32Array, next: Uint32Array, to: number, words: number): boolean {
  let spread = false;
  for (let word = 0; word < words; word++) {
    const fresh = bits[from + word]! & ~seen[to + word]!;
    if (fresh === 0) continue;
    seen[to + word]! |= fresh;
    next[to + word]! |= fresh;
    spread = true;
  }
  return spread;
}

/**
 * 경계 정점들의 비트 행을 0으로 되돌린다.
 *
 * @param bits 비트 평면 배열(갱신)
 * @param nodes 정점 목록
 * @param count 목록 길이
 * @param words 비트 집합 길이(32비트 단어 수)
 */
function clearRows(bits: Uint32Array, nodes: Int32Array, count: number, words: number): void {
  for (let item = 0; item < count; item++) bits.fill(0, nodes[item]! * words, (nodes[item]! + 1) * words);
}

/**
 * 두 평면 배열의 한 행이 같은지 본다.
 *
 * @param left 비트 평면 배열
 * @param right 비트 평면 배열
 * @param start 행의 시작
 * @param words 행 길이
 * @returns 같으면 true
 */
function sameRow(left: Uint32Array, right: Uint32Array, start: number, words: number): boolean {
  for (let word = start; word < start + words; word++) if (left[word] !== right[word]) return false;
  return true;
}

/** 한 단계의 경계다: 새 root를 받은 정점(받은 순서)과 정점별로 받은 root 인덱스(받은 순서)다. */
interface Frontier {
  readonly nodes: number[];
  readonly roots: (number[] | undefined)[];
}

/** 전파 중인 상태다. */
interface PassState {
  readonly levels: (Map<number, number> | undefined)[];
  readonly owners: Int32Array;
  readonly smallest: SmallestRoots;
}

/**
 * 모든 root에서 단계 동기로 전파한다.
 *
 * @param graph 정수 인접 목록
 * @param rootIds root id
 * @param maxDepth 최대 깊이
 * @returns 정점별 단계 기록과 잘림·전파 중단 여부
 */
function propagate(graph: IndexedGraph, rootIds: readonly string[], maxDepth: number): PassResult {
  const size = graph.ids.length;
  const state: PassState = {
    levels: new Array<Map<number, number> | undefined>(size).fill(undefined),
    owners: new Int32Array(size).fill(-1),
    smallest: new SmallestRoots(size),
  };
  let frontier = emptyFrontier(size);
  let next = emptyFrontier(size);
  rootIds.forEach((root, index) => {
    const node = graph.index.get(root)!;
    state.owners[node] = index;
    state.levels[node] = new Map([[index, 0]]);
    frontier.nodes.push(node);
    frontier.roots[node] = [index];
  });
  let pruned = false;
  for (let level = 0; level < maxDepth && frontier.nodes.length > 0; level++) {
    for (const node of frontier.nodes) {
      const roots = frontier.roots[node]!;
      for (let entry = graph.offsets[node]!, end = graph.offsets[node + 1]!; entry < end; entry++) {
        pruned = spread(state, graph.targets[entry]!, roots, level + 1, next) || pruned;
      }
    }
    clearFrontier(frontier);
    [frontier, next] = [next, frontier];
  }
  return { ...state, depthCut: hasDepthCut(graph, state.levels, frontier), pruned };
}

/**
 * 빈 경계를 만든다.
 *
 * @param size 정점 수
 * @returns 빈 경계
 */
function emptyFrontier(size: number): Frontier {
  return { nodes: [], roots: new Array<number[] | undefined>(size).fill(undefined) };
}

/**
 * 다 쓴 경계를 비워 다음 단계에 다시 쓴다.
 *
 * @param frontier 경계(갱신)
 */
function clearFrontier(frontier: Frontier): void {
  for (const node of frontier.nodes) frontier.roots[node] = undefined;
  frontier.nodes.length = 0;
}

/**
 * 한 간선으로 root 인덱스들을 이웃에 전파한다.
 *
 * @param state 전파 상태(갱신)
 * @param neighbor 이웃 정점
 * @param roots 넘길 root 인덱스
 * @param level 이웃이 닿는 단계
 * @param next 다음 단계 경계(갱신)
 * @returns 전파를 멈춘 쌍이 있었으면 true
 */
function spread(state: PassState, neighbor: number, roots: readonly number[], level: number, next: Frontier): boolean {
  let held = state.levels[neighbor];
  if (held === undefined) {
    held = new Map();
    state.levels[neighbor] = held;
  }
  const owner = state.owners[neighbor]!;
  let pruned = false;
  for (const root of roots) {
    if (held.has(root)) continue;
    if (state.smallest.dominates(neighbor, root)) {
      pruned = true;
      continue;
    }
    held.set(root, level);
    state.smallest.add(neighbor, root, held, owner);
    let list = next.roots[neighbor];
    if (list === undefined) {
      list = [];
      next.roots[neighbor] = list;
      next.nodes.push(neighbor);
    }
    list.push(root);
  }
  return pruned;
}

/** 전파를 멈추게 하는 더 작은 root 수다. 아래 정점이 자기 인덱스 하나를 빼도 64개가 남도록 하나 더 둔다. */
const DOMINATING_ROOTS = MAX_ROOTS_PER_NODE + 1;

/**
 * 정점마다 자기 자신이 아닌 root 인덱스 중 가장 작은 `DOMINATING_ROOTS`개를 오름차순으로 든다. 지배 판정(이 root보다
 * 작은 인덱스를 65개 이상 가졌는가)은 65번째로 작은 값과의 비교 한 번이다. 판정마다 정점의 root 기록을 처음부터
 * 훑으면 정점이 root를 수백 개 들 때 판정이 전파 비용의 대부분이 된다. 칸은 자기 아닌 root가 65개 찬 정점에만 둔다.
 */
class SmallestRoots {
  /** 정점 → 칸 번호(-1이면 자기 아닌 root가 아직 65개 미만) */
  readonly #slots: Int32Array;
  /** 칸마다 오름차순 root 인덱스 65개 */
  #values = new Int32Array(DOMINATING_ROOTS * 16);
  /** 쓴 칸 수 */
  #used = 0;

  /**
   * @param size 정점 수
   */
  constructor(size: number) {
    this.#slots = new Int32Array(size).fill(-1);
  }

  /**
   * 정점이 자기 자신이 아닌 root 중 이 root보다 작은 인덱스를 이미 65개 이상 가졌는지 본다.
   *
   * @param node 정점
   * @param root 정점이 아직 갖지 않은 root 인덱스
   * @returns 65개 이상이면 true
   */
  dominates(node: number, root: number): boolean {
    const slot = this.#slots[node]!;
    return slot !== -1 && this.#values[(slot + 1) * DOMINATING_ROOTS - 1]! < root;
  }

  /**
   * 정점 기록에 막 넣은(지배되지 않은) root를 반영한다.
   *
   * @param node 정점
   * @param root 넣은 root 인덱스
   * @param held 넣은 뒤의 정점 기록
   * @param owner 정점이 root면 그 인덱스(세지 않는다), 아니면 -1
   */
  add(node: number, root: number, held: ReadonlyMap<number, number>, owner: number): void {
    const slot = this.#slots[node]!;
    if (slot !== -1) this.#insert(slot * DOMINATING_ROOTS, root);
    else if (held.size - (owner === -1 ? 0 : 1) === DOMINATING_ROOTS) this.#open(node, held, owner);
  }

  /**
   * 정점의 자기 아닌 가장 작은 root 인덱스 65개다.
   *
   * @param node 정점
   * @returns 오름차순 65개, 자기 아닌 root가 65개 미만이면 undefined
   */
  lowest(node: number): number[] | undefined {
    const slot = this.#slots[node]!;
    return slot === -1 ? undefined : Array.from(this.#values.subarray(slot * DOMINATING_ROOTS, (slot + 1) * DOMINATING_ROOTS));
  }

  /**
   * 자기 아닌 root가 막 65개가 된 정점의 칸을 만들어 정렬해 채운다.
   *
   * @param node 정점
   * @param held 정점 기록
   * @param owner 정점이 root면 그 인덱스, 아니면 -1
   */
  #open(node: number, held: ReadonlyMap<number, number>, owner: number): void {
    if ((this.#used + 1) * DOMINATING_ROOTS > this.#values.length) {
      const grown = new Int32Array(this.#values.length * 2);
      grown.set(this.#values);
      this.#values = grown;
    }
    const start = this.#used * DOMINATING_ROOTS;
    let cursor = start;
    for (const index of held.keys()) if (index !== owner) this.#values[cursor++] = index;
    this.#values.subarray(start, start + DOMINATING_ROOTS).sort();
    this.#slots[node] = this.#used++;
  }

  /**
   * 65번째보다 작은 새 인덱스를 제자리에 넣고 가장 큰 값을 버린다.
   *
   * @param start 칸의 시작
   * @param root 넣을 root 인덱스(칸에 없고 마지막 값보다 작다)
   */
  #insert(start: number, root: number): void {
    const last = start + DOMINATING_ROOTS - 1;
    let low = start;
    let high = last;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#values[middle]! < root) low = middle + 1;
      else high = middle;
    }
    this.#values.copyWithin(low + 1, low, last);
    this.#values[low] = root;
  }
}

/**
 * 마지막 단계 경계에서 아직 그 root를 갖지 않은 이웃이 있으면 깊이 상한에 잘린 것이다.
 *
 * @param graph 정수 인접 목록
 * @param levels 단계 기록
 * @param frontier 최대 깊이 단계의 경계(상한 전에 끝났으면 비어 있다)
 * @returns 잘렸으면 true
 */
function hasDepthCut(graph: IndexedGraph, levels: Levels, frontier: Frontier): boolean {
  for (const node of frontier.nodes) {
    const roots = frontier.roots[node]!;
    for (let entry = graph.offsets[node]!, end = graph.offsets[node + 1]!; entry < end; entry++) {
      const held = levels[graph.targets[entry]!];
      if (roots.some((root) => held?.has(root) !== true)) return true;
    }
  }
  return false;
}

/** 출력 전 도달 행이다. */
interface ReachedRow {
  readonly id: string;
  readonly via: string;
  readonly depth: number;
  /** 닿는 root 인덱스(정렬). 65개 이상이면 가장 작은 65개만 둔다(출력은 64개, 넘침 판정은 65개면 된다). */
  readonly roots: readonly number[];
  readonly relationships: readonly EdgeKind[];
}

/**
 * 단계 기록에서 도달 행을 만든다. (depth, id) 순이다. depth·가장 가까운 root는 정점 기록을 한 번 훑어 구하고,
 * root 목록은 지배 판정 표의 가장 작은 65개를 쓴다 — 정점마다 든 root 전부(수백 개)를 펼쳐 정렬하지 않게 한다.
 *
 * @param adjacency 인접 목록
 * @param graph 정수 인접 목록(정점 번호)
 * @param pass 단계 기록과 root 정점 표
 * @returns 도달 행
 */
function reachedRows(adjacency: Adjacency, graph: IndexedGraph, pass: PassResult): ReachedRow[] {
  const rows: ReachedRow[] = [];
  pass.levels.forEach((held, node) => {
    if (held === undefined) return;
    const owner = pass.owners[node]!;
    let depth = Infinity;
    let nearest = -1;
    held.forEach((level, root) => {
      if (root !== owner && (level < depth || (level === depth && root < nearest))) {
        depth = level;
        nearest = root;
      }
    });
    if (nearest === -1) return;
    const id = graph.ids[node]!;
    const roots = pass.smallest.lowest(node) ?? [...held.keys()].filter((index) => index !== owner).sort((left, right) => left - right);
    const via = (adjacency.predecessors.get(id) ?? []).find((candidate) => pass.levels[graph.index.get(candidate)!]?.get(nearest) === depth - 1)!;
    rows.push({ id, via, depth, roots, relationships: adjacency.kinds.get(`${via}\u0000${id}`) ?? [] });
  });
  return rows.sort((left, right) => left.depth - right.depth || compareStrings(left.id, right.id));
}

/**
 * 정점 id에 노드 순서대로 번호를 주고 전체 인접 목록을 CSR로 만든다. 노드 목록에 없는 root·간선 끝점이 있으면 뒤에
 * 번호를 붙인다(스냅샷 검증은 그런 간선을 거부하지만 탐색이 그 가정에 기대지 않게 한다).
 *
 * @param graph 호출 그래프
 * @param adjacency 모드가 허용하는 전체 인접 목록
 * @param rootIds root id
 * @returns 정수 인접 목록
 */
function indexGraph(graph: CallGraph, adjacency: Adjacency, rootIds: readonly string[]): IndexedGraph {
  const ids: string[] = [];
  const index = new Map<string, number>();
  const intern = (id: string): void => {
    if (index.has(id)) return;
    index.set(id, ids.length);
    ids.push(id);
  };
  for (const node of graph.nodes) intern(node.id);
  rootIds.forEach(intern);
  let total = 0;
  for (const [from, list] of adjacency.neighbors) {
    intern(from);
    list.forEach(intern);
    total += list.length;
  }
  const offsets = new Int32Array(ids.length + 1);
  const targets = new Int32Array(total);
  let cursor = 0;
  ids.forEach((id, node) => {
    offsets[node] = cursor;
    for (const to of adjacency.neighbors.get(id) ?? []) targets[cursor++] = index.get(to)!;
  });
  offsets[ids.length] = cursor;
  return { ids, index, offsets, targets };
}

/**
 * 방향과 근거 범위에 맞춘 인접 목록을 만든다. 같은 쌍의 근거별 간선은 하나로 합치고 종류를 합친다.
 *
 * @param graph 호출 그래프
 * @param direction 방향
 * @param tier 따라갈 가장 약한 근거
 * @returns 인접 목록과 종류 조회표
 */
function buildAdjacency(graph: CallGraph, direction: TraversalDirection, tier: EdgeEvidence): Adjacency {
  const neighbors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  const kinds = new Map<string, readonly EdgeKind[]>();
  const limit = EDGE_EVIDENCE_ORDER.indexOf(tier);
  for (const edge of graph.edges) {
    if (EDGE_EVIDENCE_ORDER.indexOf(edge.evidence) > limit) continue;
    const [from, to] = direction === 'dependencies' ? [edge.from, edge.to] : [edge.to, edge.from];
    const key = `${from}\u0000${to}`;
    const known = kinds.get(key);
    if (known === undefined) {
      appendTo(neighbors, from, to);
      appendTo(predecessors, to, from);
      kinds.set(key, edge.kinds);
    } else {
      kinds.set(key, [...new Set([...known, ...edge.kinds])].sort(compareStrings));
    }
  }
  for (const list of predecessors.values()) list.sort(compareStrings);
  return { neighbors, predecessors, kinds };
}

/**
 * 목록 맵에 값을 더한다.
 *
 * @param map 키 → 목록
 * @param key 키
 * @param value 값
 */
function appendTo(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}
