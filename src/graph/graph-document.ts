/**
 * `tsograph graph` 스냅샷 문서와 그래프 내용 해시(`graphRevision`)다.
 *
 * 스냅샷은 isthmus 입력이 아니라 tsograph 자체 형식(`tsograph-graph` v1)이다. `graphRevision`은 노드
 * (id·종류·진입점)와 간선(from·to·종류)만 해시한다 — 위치(줄 이동)는 그래프의 도달 관계를 바꾸지 않으므로
 * 넣지 않는다. 같은 그래프에서 낸 reach·impact 문서는 같은 값을 싣는다.
 */

import { createHash } from 'node:crypto';

import { formatBridgeTimestamp } from '../exchange/bridge-facts.ts';
import type { CallGraph, GraphEdge, GraphNode, GraphStatistics } from './graph-model.ts';

/** 문서 머리(도구·시각·프로젝트·revision)다. */
export interface DocumentHeader {
  readonly toolVersion: string;
  readonly generatedAt: Date;
  readonly project: string;
  readonly revision: string | undefined;
}

/** 스냅샷 문서다. */
export interface GraphSnapshotDocument {
  readonly format: 'tsograph-graph';
  readonly version: 1;
  readonly tool: { readonly name: 'tsograph'; readonly version: string };
  readonly generatedAt: string;
  readonly platform: 'js';
  readonly project: string;
  readonly revision?: string;
  readonly graphRevision: string;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly statistics: GraphStatistics;
  readonly limitations: readonly string[];
}

/**
 * 그래프 내용 해시를 만든다.
 *
 * @param graph 호출 그래프
 * @returns `sha256:<hex>`
 */
export function computeGraphRevision(graph: CallGraph): string {
  const content = JSON.stringify([
    graph.nodes.map((node) => [node.id, node.kind, node.entries ?? []]),
    graph.edges.map((edge) => [edge.from, edge.to, edge.kinds]),
  ]);
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * 스냅샷 문서를 만든다.
 *
 * @param graph 호출 그래프
 * @param header 문서 머리
 * @returns 스냅샷 문서
 */
export function createGraphSnapshot(graph: CallGraph, header: DocumentHeader): GraphSnapshotDocument {
  return {
    format: 'tsograph-graph',
    version: 1,
    tool: { name: 'tsograph', version: header.toolVersion },
    generatedAt: formatBridgeTimestamp(header.generatedAt),
    platform: 'js',
    project: header.project,
    ...(header.revision === undefined ? {} : { revision: header.revision }),
    graphRevision: computeGraphRevision(graph),
    nodes: graph.nodes,
    edges: graph.edges,
    statistics: graph.statistics,
    limitations: graph.limitations,
  };
}
