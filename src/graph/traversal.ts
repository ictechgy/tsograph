/**
 * 그래프를 root 집합에서 정방향(dependencies) 또는 역방향(dependents)으로 훑는다.
 *
 * root마다 너비 우선 탐색을 따로 돌려 `roots`(그 노드에 닿는 root 인덱스)를 정확히 보존한다. 각 노드의
 * `depth`는 모든 root에 걸친 최단 거리, `via`는 그 최단 경로의 직전 노드(깊이 1이면 root)다. 같은 깊이면
 * 먼저 온 root, 같은 root 안에서는 정렬된 이웃 순서로 먼저 발견한 부모가 이긴다 — 출력이 결정적이다.
 *
 * isthmus `language-traversal` v1 규칙(`docs/LANGUAGE-TRAVERSAL.md`)을 따른다: root는 깊이 0이며 `reached`에
 * 다시 싣지 않는다(root끼리의 도달은 v1에서 표현하지 않는다). 경로는 다른 root를 지나갈 수 있고, 그 너머의
 * 정점은 두 root 인덱스를 모두 싣는다. 깊이는 1~128이다.
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
  /** `from\0to`(방향 기준) → 종류 */
  readonly kinds: ReadonlyMap<string, readonly EdgeKind[]>;
}

/** 전역 기록(모든 root에 걸친 최단)이다. */
interface Record {
  depth: number;
  via: string;
  readonly roots: Set<number>;
}

/**
 * 탐색한다.
 *
 * @param graph 호출 그래프
 * @param request 탐색 요청(root id는 모두 노드여야 한다)
 * @returns 탐색 결과
 */
export function traverse(graph: CallGraph, request: TraversalRequest): TraversalResult {
  const adjacency = buildAdjacency(graph, request.direction);
  const records = new Map<string, Record>();
  const roots = new Set(request.rootIds);
  let depthCut = false;
  request.rootIds.forEach((root, index) => {
    depthCut = searchFromRoot(adjacency, { root, index, roots }, request.maxDepth, records) || depthCut;
  });
  const ordered = [...records].sort(([leftId, left], [rightId, right]) => left.depth - right.depth || compareStrings(leftId, rightId));
  const kept = ordered.slice(0, request.maxReached);
  const reasons: TruncationReason[] = [];
  if (depthCut) reasons.push('depth');
  if (ordered.length > kept.length) reasons.push('max-reached');
  let rootsTruncated = false;
  const reached = kept.map(([id, record]) => {
    const roots = [...record.roots].sort((left, right) => left - right);
    if (roots.length > MAX_ROOTS_PER_NODE) rootsTruncated = true;
    const relationships = adjacency.kinds.get(`${record.via}\u0000${id}`) ?? [];
    return { id, via: record.via, depth: record.depth, roots: roots.slice(0, MAX_ROOTS_PER_NODE), relationships };
  });
  return { reached, truncationReasons: reasons, rootsTruncated };
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
  const kinds = new Map<string, readonly EdgeKind[]>();
  for (const edge of graph.edges) {
    const [from, to] = direction === 'dependencies' ? [edge.from, edge.to] : [edge.to, edge.from];
    const list = neighbors.get(from);
    if (list === undefined) neighbors.set(from, [to]);
    else list.push(to);
    kinds.set(`${from}\u0000${to}`, edge.kinds);
  }
  for (const list of neighbors.values()) list.sort(compareStrings);
  return { neighbors, kinds };
}

/** 탐색 중인 root다. */
interface SearchRoot {
  readonly root: string;
  readonly index: number;
  /** 모든 root id(기록에서 뺀다) */
  readonly roots: ReadonlySet<string>;
}

/**
 * root 하나에서 너비 우선으로 훑어 전역 기록을 갱신한다. 다른 root도 지나가지만 기록하지 않는다.
 *
 * @param adjacency 인접 목록
 * @param search 탐색 중인 root
 * @param maxDepth 최대 깊이
 * @param records 전역 기록(갱신)
 * @returns 깊이 제한 때문에 닿지 못한 이웃이 있었으면 true
 */
function searchFromRoot(adjacency: Adjacency, search: SearchRoot, maxDepth: number, records: Map<string, Record>): boolean {
  const depths = new Map<string, number>([[search.root, 0]]);
  const queue = [search.root];
  let depthCut = false;
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    const depth = depths.get(node)!;
    const next = adjacency.neighbors.get(node) ?? [];
    if (depth >= maxDepth) {
      depthCut ||= next.some((neighbor) => !depths.has(neighbor));
      continue;
    }
    for (const neighbor of next.filter((candidate) => !depths.has(candidate))) {
      depths.set(neighbor, depth + 1);
      queue.push(neighbor);
      if (!search.roots.has(neighbor)) record(records, neighbor, depth + 1, node, search.index);
    }
  }
  return depthCut;
}

/**
 * 도달 하나를 기록한다. 더 짧은 깊이만 via를 바꾸고(같은 깊이면 먼저 온 root), root 인덱스는 언제나 더한다.
 *
 * @param records 전역 기록
 * @param id 노드 id
 * @param depth 깊이
 * @param via 직전 노드
 * @param rootIndex root 인덱스
 */
function record(records: Map<string, Record>, id: string, depth: number, via: string, rootIndex: number): void {
  const existing = records.get(id);
  if (existing === undefined) {
    records.set(id, { depth, via, roots: new Set([rootIndex]) });
    return;
  }
  if (depth < existing.depth) {
    existing.depth = depth;
    existing.via = via;
  }
  existing.roots.add(rootIndex);
}
