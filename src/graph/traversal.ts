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
 * 순간 모자란다 — 무작위 비교 테스트가 찾은 경우다). 그래서 root 수가 많아도 정점당 쌍 수가 대략 65로 묶인다.
 * 옛 root별 알고리즘과의 동등성은 무작위 그래프 테스트(`traversal-oracle.test.ts`)로 확인한다. 전파를 멈춘
 * 경우(`rootsTruncated: true`)에는 깊이 잘림(`depth`)을 도달 정점 집합이 불완전할 때만 알린다.
 */

import { compareStrings } from '../exchange/sorted-json.ts';
import type { CallGraph, EdgeKind } from './graph-model.ts';

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
}

/** 도달한 노드 하나다. */
export interface ReachedSymbol {
  readonly id: string;
  readonly via: string;
  readonly depth: number;
  /** 닿는 root 인덱스(정렬, 최대 64개) */
  readonly roots: readonly number[];
  /** via와 이 노드 사이 간선의 종류(정렬) */
  readonly relationships: readonly EdgeKind[];
}

/** 탐색이 잘린 이유다(정렬 순서로 싣는다). */
export type TruncationReason = 'depth' | 'max-reached';

/** 탐색 결과다. */
export interface TraversalResult {
  /** (depth, id) 순 */
  readonly reached: readonly ReachedSymbol[];
  readonly truncationReasons: readonly TruncationReason[];
  readonly rootsTruncated: boolean;
}

/** 방향에 맞춘 이웃 목록과 간선 종류 조회표다. */
interface Adjacency {
  readonly neighbors: ReadonlyMap<string, readonly string[]>;
  /** 방향 기준 선행 정점(id 순) */
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
  /** `from\0to`(방향 기준) → 종류 */
  readonly kinds: ReadonlyMap<string, readonly EdgeKind[]>;
}

/** 정점별 (root 인덱스 → 처음 닿은 단계) 기록이다. */
type Levels = Map<string, Map<number, number>>;

/** 단일 패스의 결과다. */
interface PassResult {
  readonly levels: Levels;
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
  const adjacency = buildAdjacency(graph, request.direction);
  const pass = propagate(adjacency, request.rootIds, request.maxDepth);
  const rows = reachedRows(adjacency, pass.levels, request.rootIds);
  const kept = rows.slice(0, request.maxReached);
  const reasons: TruncationReason[] = [];
  if (pass.depthCut) reasons.push('depth');
  if (rows.length > kept.length) reasons.push('max-reached');
  const rootsTruncated = pass.pruned || kept.some((row) => row.roots.length > MAX_ROOTS_PER_NODE);
  const reached = kept.map((row) => ({ ...row, roots: row.roots.slice(0, MAX_ROOTS_PER_NODE) }));
  return { reached, truncationReasons: reasons, rootsTruncated };
}

/**
 * 모든 root에서 단계 동기로 전파한다.
 *
 * @param adjacency 인접 목록
 * @param rootIds root id
 * @param maxDepth 최대 깊이
 * @returns 정점별 단계 기록과 잘림·전파 중단 여부
 */
function propagate(adjacency: Adjacency, rootIds: readonly string[], maxDepth: number): PassResult {
  const levels: Levels = new Map();
  const owners = new Map(rootIds.map((root, index) => [root, index]));
  let frontier = new Map<string, number[]>();
  rootIds.forEach((root, index) => {
    levels.set(root, new Map([[index, 0]]));
    frontier.set(root, [index]);
  });
  let pruned = false;
  for (let level = 0; level < maxDepth && frontier.size > 0; level++) {
    const next = new Map<string, number[]>();
    for (const [node, roots] of frontier) {
      for (const neighbor of adjacency.neighbors.get(node) ?? []) {
        pruned = spread(levels, owners.get(neighbor), neighbor, roots, level + 1, next) || pruned;
      }
    }
    frontier = next;
  }
  return { levels, depthCut: hasDepthCut(adjacency, levels, frontier), pruned };
}

/**
 * 한 간선으로 root 인덱스들을 이웃에 전파한다.
 *
 * @param levels 단계 기록(갱신)
 * @param owner 이웃이 root면 그 인덱스
 * @param neighbor 이웃 정점
 * @param roots 넘길 root 인덱스
 * @param level 이웃이 닿는 단계
 * @param next 다음 단계 경계(갱신)
 * @returns 전파를 멈춘 쌍이 있었으면 true
 */
function spread(levels: Levels, owner: number | undefined, neighbor: string, roots: readonly number[], level: number, next: Map<string, number[]>): boolean {
  let held = levels.get(neighbor);
  if (held === undefined) {
    held = new Map();
    levels.set(neighbor, held);
  }
  let pruned = false;
  for (const root of roots) {
    if (held.has(root)) continue;
    if (dominated(held, owner, root)) {
      pruned = true;
      continue;
    }
    held.set(root, level);
    const list = next.get(neighbor);
    if (list === undefined) next.set(neighbor, [root]);
    else list.push(root);
  }
  return pruned;
}

/** 전파를 멈추게 하는 더 작은 root 수다. 아래 정점이 자기 인덱스 하나를 빼도 64개가 남도록 하나 더 둔다. */
const DOMINATING_ROOTS = MAX_ROOTS_PER_NODE + 1;

/**
 * 정점이 자기 자신이 아닌 root 중 이 root보다 작은 인덱스를 이미 65개 이상 가졌는지 본다.
 *
 * @param held 정점의 root 기록
 * @param owner 정점이 root면 그 인덱스(세지 않는다)
 * @param root 새 root 인덱스
 * @returns 65개 이상이면 true
 */
function dominated(held: ReadonlyMap<number, number>, owner: number | undefined, root: number): boolean {
  if (held.size - (owner === undefined ? 0 : 1) < DOMINATING_ROOTS) return false;
  let smaller = 0;
  for (const index of held.keys()) {
    if (index !== owner && index < root && ++smaller >= DOMINATING_ROOTS) return true;
  }
  return false;
}

/**
 * 마지막 단계 경계에서 아직 그 root를 갖지 않은 이웃이 있으면 깊이 상한에 잘린 것이다.
 *
 * @param adjacency 인접 목록
 * @param levels 단계 기록
 * @param frontier 최대 깊이 단계의 경계(상한 전에 끝났으면 비어 있다)
 * @returns 잘렸으면 true
 */
function hasDepthCut(adjacency: Adjacency, levels: Levels, frontier: ReadonlyMap<string, readonly number[]>): boolean {
  for (const [node, roots] of frontier) {
    for (const neighbor of adjacency.neighbors.get(node) ?? []) {
      const held = levels.get(neighbor);
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
  readonly roots: readonly number[];
  readonly relationships: readonly EdgeKind[];
}

/**
 * 단계 기록에서 도달 행을 만든다. (depth, id) 순이다.
 *
 * @param adjacency 인접 목록
 * @param levels 단계 기록
 * @param rootIds root id
 * @returns 도달 행
 */
function reachedRows(adjacency: Adjacency, levels: Levels, rootIds: readonly string[]): ReachedRow[] {
  const owners = new Map(rootIds.map((root, index) => [root, index]));
  const rows: ReachedRow[] = [];
  for (const [id, held] of levels) {
    const owner = owners.get(id);
    const roots = [...held.keys()].filter((index) => index !== owner).sort((left, right) => left - right);
    if (roots.length === 0) continue;
    const depth = Math.min(...roots.map((index) => held.get(index)!));
    const nearest = roots.find((index) => held.get(index) === depth)!;
    const via = (adjacency.predecessors.get(id) ?? []).find((candidate) => levels.get(candidate)?.get(nearest) === depth - 1)!;
    rows.push({ id, via, depth, roots, relationships: adjacency.kinds.get(`${via}\u0000${id}`) ?? [] });
  }
  return rows.sort((left, right) => left.depth - right.depth || compareStrings(left.id, right.id));
}

/**
 * 방향에 맞춘 인접 목록을 만든다. 이웃은 id 순이다.
 *
 * @param graph 호출 그래프
 * @param direction 방향
 * @returns 인접 목록과 종류 조회표
 */
function buildAdjacency(graph: CallGraph, direction: TraversalDirection): Adjacency {
  const neighbors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  const kinds = new Map<string, readonly EdgeKind[]>();
  for (const edge of graph.edges) {
    const [from, to] = direction === 'dependencies' ? [edge.from, edge.to] : [edge.to, edge.from];
    appendTo(neighbors, from, to);
    appendTo(predecessors, to, from);
    kinds.set(`${from}\u0000${to}`, edge.kinds);
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
