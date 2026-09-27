/**
 * reach·impact 결과를 isthmus `language-traversal` v1 문서로 조립한다.
 *
 * 계약(isthmus trace가 소비): `direction`, `dispatch`, `roots[]`(id·symbol·unresolvedCalls), `reached[]`(symbol·
 * via·depth·roots·relationships·evidence·unresolvedCalls), `rootsTruncated`, `truncated`·`truncationReasons`,
 * `limitations`. id와 `symbol.usr`는 routes·schema가 싣는 `symbol.usr`와 같은 문자열이다. qualifiedName도 같은
 * 값(선언 경로)이다.
 *
 * `dispatch`를 싣는 것은 계약상 두 신고의 선언이다: 모든 도달 정점에 `evidence`를 싣고(tsograph는 언제나 싣는다),
 * 모드에서 잇지 못한 호출이 1개 이상인 모든 root·도달 정점에 `unresolvedCalls`(1~1,000,000)를 싣는다. 값은
 * 그래프 노드의 모드별 계수라서 다른 root에서 닿은 root도 `roots[]`와 `reached[]`에 같은 값이 실린다.
 * limitation은 그래프의 모드별 목록을 싣고, `non-http-entries:`만 이 문서의 root·도달 노드로 다시 센다.
 */

import { type BridgeLocation, formatBridgeTimestamp } from '../exchange/bridge-facts.ts';
import { nonHttpEntryLimitations } from './build-graph.ts';
import type { DocumentHeader } from './graph-document.ts';
import type { CallGraph, DispatchMode, EdgeEvidence, EdgeKind, GraphNode } from './graph-model.ts';
import type { TraversalDirection, TraversalResult, TruncationReason } from './traversal.ts';

/** 문서의 심볼 표기다. 도달 정점은 노드 종류와 위치도 싣는다. */
interface TraversalSymbol {
  readonly usr: string;
  readonly qualifiedName: string;
  readonly kind?: string;
  readonly location?: BridgeLocation;
}

/** 계약이 허용하는 `unresolvedCalls` 최댓값이다. */
export const MAX_UNRESOLVED_CALLS = 1_000_000;

/** language-traversal v1 문서다. */
export interface LanguageTraversalDocument {
  readonly format: 'language-traversal';
  readonly version: 1;
  readonly tool: { readonly name: 'tsograph'; readonly version: string };
  readonly generatedAt: string;
  readonly platform: 'js';
  readonly project: string;
  readonly revision?: string;
  readonly graphRevision: string;
  readonly direction: TraversalDirection;
  readonly dispatch: DispatchMode;
  readonly roots: readonly { readonly id: string; readonly symbol: TraversalSymbol; readonly unresolvedCalls?: number }[];
  readonly reached: readonly {
    readonly symbol: TraversalSymbol;
    readonly via: string;
    readonly depth: number;
    readonly roots: readonly number[];
    readonly relationships?: readonly EdgeKind[];
    readonly evidence: EdgeEvidence;
    readonly unresolvedCalls?: number;
  }[];
  readonly rootsTruncated?: true;
  readonly truncated: boolean;
  readonly truncationReasons?: readonly TruncationReason[];
  readonly limitations: readonly string[];
}

/** 조립 입력이다. */
export interface TraversalDocumentInput {
  readonly graph: CallGraph;
  readonly graphRevision: string;
  readonly header: DocumentHeader;
  readonly direction: TraversalDirection;
  readonly dispatch: DispatchMode;
  readonly rootIds: readonly string[];
  readonly result: TraversalResult;
}

/**
 * 문서를 조립한다.
 *
 * @param input 조립 입력
 * @returns language-traversal v1 문서
 */
export function createTraversalDocument(input: TraversalDocumentInput): LanguageTraversalDocument {
  const { header, result, dispatch } = input;
  const nodes = new Map(input.graph.nodes.map((node) => [node.id, node]));
  const unresolved = (id: string): { unresolvedCalls?: number } => unresolvedField(nodes.get(id)!, dispatch);
  return {
    format: 'language-traversal',
    version: 1,
    tool: { name: 'tsograph', version: header.toolVersion },
    generatedAt: formatBridgeTimestamp(header.generatedAt),
    platform: 'js',
    project: header.project,
    ...(header.revision === undefined ? {} : { revision: header.revision }),
    graphRevision: input.graphRevision,
    direction: input.direction,
    dispatch,
    roots: input.rootIds.map((id) => ({ id, symbol: symbolOf(id), ...unresolved(id) })),
    reached: result.reached.map((entry) => ({
      symbol: { ...symbolOf(entry.id), kind: nodes.get(entry.id)!.kind, location: nodes.get(entry.id)!.location },
      via: entry.via,
      depth: entry.depth,
      roots: entry.roots,
      ...(entry.relationships.length === 0 ? {} : { relationships: entry.relationships }),
      evidence: entry.evidence,
      ...unresolved(entry.id),
    })),
    ...(result.rootsTruncated ? { rootsTruncated: true as const } : {}),
    truncated: result.truncationReasons.length > 0,
    ...(result.truncationReasons.length === 0 ? {} : { truncationReasons: result.truncationReasons }),
    limitations: traversalLimitations(input),
  };
}

/**
 * 노드의 모드별 미해석 호출 수 필드다. 0이면 싣지 않고, 계약 상한(1,000,000)을 넘으면 상한으로 싣는다.
 *
 * @param node 그래프 노드
 * @param dispatch 디스패치 모드
 * @returns `{ unresolvedCalls }` 또는 빈 객체
 */
function unresolvedField(node: GraphNode, dispatch: DispatchMode): { unresolvedCalls?: number } {
  const count = node.unresolvedCalls?.[dispatch] ?? 0;
  return count === 0 ? {} : { unresolvedCalls: Math.min(count, MAX_UNRESOLVED_CALLS) };
}

/**
 * id의 심볼 표기다.
 *
 * @param id 노드 id
 * @returns usr·qualifiedName
 */
function symbolOf(id: string): TraversalSymbol {
  return { usr: id, qualifiedName: id };
}

/**
 * 문서 limitation이다: 모드의 그래프 limitation(전체 `non-http-entries:` 제외)과 이 문서 범위의 `non-http-entries:`.
 *
 * @param input 조립 입력
 * @returns limitation 목록
 */
function traversalLimitations(input: TraversalDocumentInput): string[] {
  const touched = new Set([...input.rootIds, ...input.result.reached.map((entry) => entry.id)]);
  const nodes: GraphNode[] = input.graph.nodes.filter((node) => touched.has(node.id));
  const graphLimitations = input.graph.limitationsByMode?.[input.dispatch] ?? input.graph.limitations;
  return [
    ...graphLimitations.filter((line) => !line.startsWith('non-http-entries:')),
    ...nonHttpEntryLimitations(nodes),
  ];
}
