/**
 * reach·impact가 받은 root id를 그래프 노드와 대조하고, 해석하지 못한 root를 계약대로 다룬다.
 *
 * isthmus `language-traversal` v1은 해석하지 못한 요청을 원문 `id`로 `roots`에 두고 `symbol`을 생략하며,
 * `limitations`에 `root-not-found:` 문구, `truncationReasons`에 `root-not-found`, `truncated: true`를 싣게 한다.
 * trace는 `symbol`이 있는 root만 잇는다. 그래서 모르는 id가 하나 섞여도 문서 전체를 버리지 않고, 아는 root만으로
 * 순회한 뒤 root 인덱스를 요청 순서(문서 `roots` 순서)로 옮긴다. 인덱스 대응은 순서를 보존하므로 "작은 인덱스
 * 64개", "같은 거리면 작은 인덱스" 같은 순회 규칙의 결과가 그대로 유지된다.
 *
 * 선언 이름공간(`#model:`·`#typedsql:`)은 tsograph schema가 선언 쪽 relation-use에 싣는 usr로, 그래프 노드가
 * 아님을 이미 안다. 오타와 구별해 알리려고 따로 센다(문서 형태는 같다 — 계약에 다른 표기가 없다).
 */

import type { TraversalResult } from './traversal.ts';

/** 해석하지 못한 root의 종류다: 선언 이름공간(`#model:`·`#typedsql:`) 또는 그 밖의 모르는 id. */
export type UnresolvedRootKind = 'declaration' | 'unknown';

/** root 대조 결과다. */
export interface RootResolution {
  /** 요청 순서의 전체 root id(문서 `roots` 순서) */
  readonly requestedIds: readonly string[];
  /** 그래프 노드인 root id(요청 순서 유지) */
  readonly resolvedIds: readonly string[];
  /** 해석하지 못한 root id → 종류(요청 순서 유지) */
  readonly unresolved: ReadonlyMap<string, UnresolvedRootKind>;
}

/** 선언 쪽 relation-use usr의 이름공간 표식이다(`src/schema/extract.ts`가 만든다). */
const DECLARATION_NAMESPACE_MARKERS = ['#model:', '#typedsql:'] as const;

/**
 * root id를 그래프 노드 집합과 대조한다.
 *
 * @param requestedIds 요청 순서의 중복 없는 root id
 * @param nodeIds 그래프 노드 id 집합
 * @returns 대조 결과
 */
export function resolveRoots(requestedIds: readonly string[], nodeIds: ReadonlySet<string>): RootResolution {
  const unresolved = new Map<string, UnresolvedRootKind>();
  for (const id of requestedIds) {
    if (!nodeIds.has(id)) unresolved.set(id, unresolvedRootKind(id));
  }
  return { requestedIds, resolvedIds: requestedIds.filter((id) => !unresolved.has(id)), unresolved };
}

/**
 * 모르는 id의 종류를 정한다. 그래프 노드가 아닌 id에만 쓰므로 표식이 있으면 선언 이름공간 usr로 본다. 종류는
 * 안내 문구만 바꾸고 문서 형태·종료 코드는 바꾸지 않는다.
 *
 * @param id 그래프 노드가 아닌 root id
 * @returns 종류
 */
export function unresolvedRootKind(id: string): UnresolvedRootKind {
  return DECLARATION_NAMESPACE_MARKERS.some((marker) => id.includes(marker)) ? 'declaration' : 'unknown';
}

/**
 * 아는 root만으로 구한 순회 결과의 root 인덱스를 요청 순서의 인덱스로 옮긴다.
 *
 * @param result `resolution.resolvedIds` 순서의 인덱스를 쓰는 순회 결과
 * @param resolution root 대조 결과
 * @returns 요청 순서의 인덱스를 쓰는 순회 결과
 */
export function remapRootIndices(result: TraversalResult, resolution: RootResolution): TraversalResult {
  if (resolution.unresolved.size === 0) return result;
  const requestedIndex = new Map(resolution.requestedIds.map((id, index) => [id, index]));
  const toRequested = resolution.resolvedIds.map((id) => requestedIndex.get(id)!);
  return { ...result, reached: result.reached.map((entry) => ({ ...entry, roots: entry.roots.map((index) => toRequested[index]!) })) };
}

/** 해석한 root가 없을 때의 빈 순회 결과다. 순회할 출발점이 없으므로 잘림·근사도 없다. */
export const EMPTY_TRAVERSAL_RESULT: TraversalResult = { reached: [], truncationReasons: [], rootsTruncated: false, evidenceApproximated: false };

/**
 * 해석하지 못한 root의 `root-not-found:` limitation이다. 없으면 undefined다.
 *
 * @param unresolved 해석하지 못한 root id → 종류
 * @returns limitation 문구 또는 undefined
 */
export function rootNotFoundLimitation(unresolved: ReadonlyMap<string, UnresolvedRootKind>): string | undefined {
  if (unresolved.size === 0) return undefined;
  const { declaration, unknown } = countKinds(unresolved);
  const parts = [
    ...(declaration === 0 ? [] : [`${declaration} Prisma schema/TypedSQL declaration id(s) (#model:, #typedsql:), which are declaration-side relation-use ids and never graph nodes, so no traversal reaches them; leave them out of traversal roots`]),
    ...(unknown === 0 ? [] : [`${unknown} unknown id(s); pass graph node ids from 'tsograph graph --project <root>'`]),
  ];
  return `root-not-found: ${unresolved.size} requested root(s) are not graph nodes and are listed without symbol: ${parts.join('; ')}`;
}

/**
 * 종류별 개수를 센다.
 *
 * @param unresolved 해석하지 못한 root id → 종류
 * @returns 종류별 개수
 */
function countKinds(unresolved: ReadonlyMap<string, UnresolvedRootKind>): Record<UnresolvedRootKind, number> {
  const counts: Record<UnresolvedRootKind, number> = { declaration: 0, unknown: 0 };
  for (const kind of unresolved.values()) counts[kind] += 1;
  return counts;
}
