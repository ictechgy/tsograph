/**
 * OpenAPI `paths`에서 operation(경로 × method)을 모은다.
 *
 * 각 operation에는 원문 method 키 노드(위치용), operationId, 적용되는 서버
 * 접두사를 붙인다. 읽지 못한 부분은 버리지 않고 이유별로 센다 — 스펙이
 * authoritative로 선언될 때 "스펙에 없음"을 거짓 error로 만들지 않도록 호출자가
 * `contract-coverage:` limitation으로 알린다.
 */

import { isScalar, type ParsedNode } from 'yaml';

import type { HttpMethod } from '../exchange/bridge-facts.ts';
import { resolveLocalReference } from './json-pointer.ts';
import {
  DEFAULT_SERVER_PREFIXES,
  mergeServerPrefixes,
  resolveBasePath,
  resolveServerUrl,
  type ServerPrefixes,
  type ServerVariable,
  UNRESOLVED_SERVER_PREFIXES,
} from './servers.ts';
import type { MapEntry, SpecTree } from './spec-tree.ts';
import type { SpecVersion } from './spec-version.ts';

/** path item `$ref` 사슬을 따라가는 최대 단계다. */
export const MAX_PATH_ITEM_REFERENCE_HOPS = 16;

/** 모은 operation 하나다. */
export interface ExtractedOperation {
  readonly pathKey: string;
  readonly method: HttpMethod;
  /** method 키 노드. 사실의 location이 이 위치를 가리킨다. */
  readonly keyNode: ParsedNode;
  readonly operationId: string | undefined;
  readonly prefixes: ServerPrefixes;
}

/** 읽지 못한 부분의 이유별 개수다. */
export interface ExtractionGaps {
  /** `/`로 시작하지 않는 paths 키(확장 `x-` 제외) 수 */
  nonRootedPathKeys: number;
  /** 같은 문서 밖을 가리키는 path item `$ref` 수 */
  nonLocalReferences: number;
  /** 대상이 없거나 잘못된 path item `$ref` 수 */
  brokenReferences: number;
  /** 순환하거나 단계 상한을 넘은 path item `$ref` 수 */
  cyclicReferences: number;
  /** 객체가 아닌 path item 수 */
  nonObjectPathItems: number;
  /** 객체가 아닌 operation 수 */
  nonObjectOperations: number;
  /** operation도 알려진 필드도 확장도 아닌 path item 필드 수 */
  unknownPathItemFields: number;
}

/** operation 수집 결과다. */
export interface OperationExtraction {
  readonly operations: readonly ExtractedOperation[];
  readonly gaps: ExtractionGaps;
}

/** 버전별 operation 키다. 2.0에는 trace가 없다. */
const operationKeysByVersion: Readonly<Record<SpecVersion, readonly string[]>> = {
  '2.0': ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'],
  '3.0': ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'],
  '3.1': ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'],
};

/** operation이 아닌 알려진 path item 필드다. */
const knownPathItemFields: Readonly<Record<SpecVersion, ReadonlySet<string>>> = {
  '2.0': new Set(['parameters']),
  '3.0': new Set(['summary', 'description', 'servers', 'parameters']),
  '3.1': new Set(['summary', 'description', 'servers', 'parameters']),
};

/**
 * path item 층(매핑 노드) 하나를 한 번 훑어 만든 요약이다.
 *
 * 같은 노드를 여러 `$ref`·alias가 가리켜도 항목을 다시 훑지 않도록 노드별로 캐시한다.
 * 그러지 않으면 큰 매핑을 가리키는 참조 N개가 N × 항목 수의 제곱 시간이 된다.
 */
interface LayerSummary {
  /** operation 키 항목(버전별 최대 8개)이다. */
  readonly methodFields: readonly MapEntry[];
  /** operation도 알려진 필드도 확장도 아닌 항목 수다. */
  readonly unknownFieldCount: number;
  /** servers 값(있으면)이다. */
  readonly servers: ParsedNode | undefined;
  /** `$ref` 값(있으면)이다. */
  readonly reference: ParsedNode | null | undefined;
}

/** 한 path item의 실제 필드 층이다. `$ref`를 따라간 순서(형제 필드가 먼저)다. */
type PathItemLayers =
  | { readonly kind: 'layers'; readonly layers: readonly LayerSummary[] }
  | { readonly kind: 'gap'; readonly gap: keyof ExtractionGaps };

/** 서버 목록 선택 결과다. */
type ServerSource =
  | { readonly kind: 'list'; readonly node: ParsedNode }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'none' };

/**
 * 스펙에서 operation을 모은다.
 *
 * @param tree 스펙 트리
 * @param version 스펙 버전
 * @param pathsNode `paths` 노드(3.1에서 없으면 undefined)
 * @returns operation과 읽지 못한 부분의 개수
 */
export function extractOperations(
  tree: SpecTree,
  version: SpecVersion,
  pathsNode: ParsedNode | undefined,
): OperationExtraction {
  const gaps = emptyGaps();
  const context = createContext(tree, version, gaps);
  const operations: ExtractedOperation[] = [];
  for (const entry of tree.entries(pathsNode) ?? []) {
    if (entry.key?.startsWith('x-') === true) continue;
    if (entry.key === undefined || !entry.key.startsWith('/')) {
      gaps.nonRootedPathKeys += 1;
      continue;
    }
    operations.push(...extractPathItem(context, entry.key, entry.value));
  }
  return { operations, gaps };
}

/** 수집 중 공유하는 상태다. */
interface ExtractionContext {
  readonly tree: SpecTree;
  readonly version: SpecVersion;
  readonly gaps: ExtractionGaps;
  /** 루트 수준 서버 접두사(3.x servers 또는 2.0 basePath)다. */
  readonly rootPrefixes: ServerPrefixes;
  /** 같은 servers 노드를 여러 operation이 공유할 때 다시 해석하지 않기 위한 캐시다. */
  readonly serverCache: Map<ParsedNode, ServerPrefixes>;
  /** path item 층 노드별 요약 캐시다. */
  readonly layerCache: Map<ParsedNode, LayerSummary>;
  /** 모르는 필드를 이미 센 층이다. 여러 번 참조된 층의 필드를 한 번만 센다. */
  readonly countedLayers: Set<LayerSummary>;
}

/**
 * 빈 개수 집합을 만든다.
 *
 * @returns 모든 개수가 0인 집합
 */
function emptyGaps(): ExtractionGaps {
  return {
    nonRootedPathKeys: 0,
    nonLocalReferences: 0,
    brokenReferences: 0,
    cyclicReferences: 0,
    nonObjectPathItems: 0,
    nonObjectOperations: 0,
    unknownPathItemFields: 0,
  };
}

/**
 * 수집 상태를 만들고 루트 수준 접두사를 해석한다.
 *
 * @param tree 스펙 트리
 * @param version 스펙 버전
 * @param gaps 개수 집합
 * @returns 수집 상태
 */
function createContext(tree: SpecTree, version: SpecVersion, gaps: ExtractionGaps): ExtractionContext {
  const serverCache = new Map<ParsedNode, ServerPrefixes>();
  const partial = {
    tree,
    version,
    gaps,
    serverCache,
    layerCache: new Map<ParsedNode, LayerSummary>(),
    countedLayers: new Set<LayerSummary>(),
    rootPrefixes: DEFAULT_SERVER_PREFIXES,
  };
  const rootPrefixes = version === '2.0'
    ? resolveSwaggerBasePath(tree)
    : prefixesFor(partial, [pickServerSource(tree, tree.get(tree.root, 'servers'))], DEFAULT_SERVER_PREFIXES);
  return { ...partial, rootPrefixes };
}

/**
 * Swagger 2.0 루트의 basePath를 해석한다.
 *
 * @param tree 스펙 트리
 * @returns 접두사 집합
 */
function resolveSwaggerBasePath(tree: SpecTree): ServerPrefixes {
  const node = tree.get(tree.root, 'basePath');
  return resolveBasePath(tree.string(node), node !== undefined);
}

/**
 * path item 하나의 operation을 모은다.
 *
 * @param context 수집 상태
 * @param pathKey paths 키
 * @param value path item 값
 * @returns operation 목록
 */
function extractPathItem(
  context: ExtractionContext,
  pathKey: string,
  value: ParsedNode | null,
): ExtractedOperation[] {
  const resolved = resolvePathItemLayers(context, value);
  if (resolved.kind === 'gap') {
    context.gaps[resolved.gap] += 1;
    return [];
  }
  countUnknownFields(context, resolved.layers);
  const serversValue = resolved.layers.find((layer) => layer.servers !== undefined)?.servers;
  const pathServers = pickServerSource(context.tree, serversValue);
  const operations: ExtractedOperation[] = [];
  for (const field of resolved.layers.flatMap((layer) => layer.methodFields)) {
    const method = operationMethod(context.version, field.key)!;
    const operation = extractOperation(context, pathKey, method, field, pathServers);
    if (operation === undefined) context.gaps.nonObjectOperations += 1;
    else operations.push(operation);
  }
  return operations;
}

/**
 * 층들의 모르는 필드 수를 더한다. 이미 센 층은 다시 세지 않는다.
 *
 * @param context 수집 상태
 * @param layers path item 층 요약
 */
function countUnknownFields(context: ExtractionContext, layers: readonly LayerSummary[]): void {
  for (const layer of layers) {
    if (context.countedLayers.has(layer)) continue;
    context.countedLayers.add(layer);
    context.gaps.unknownPathItemFields += layer.unknownFieldCount;
  }
}

/**
 * operation 하나를 만든다.
 *
 * @param context 수집 상태
 * @param pathKey paths 키
 * @param method HTTP method
 * @param field method 키와 operation 값
 * @param pathServers path item 수준 서버 선택
 * @returns operation. 값이 객체가 아니면 undefined
 */
function extractOperation(
  context: ExtractionContext,
  pathKey: string,
  method: HttpMethod,
  field: MapEntry,
  pathServers: ServerSource,
): ExtractedOperation | undefined {
  const { tree } = context;
  if (!tree.isMapping(field.value)) return undefined;
  const operationServers = context.version === '2.0'
    ? { kind: 'none' as const }
    : pickServerSource(tree, tree.get(field.value, 'servers'));
  return {
    pathKey,
    method,
    keyNode: field.keyNode,
    operationId: tree.string(tree.get(field.value, 'operationId')),
    prefixes: prefixesFor(context, [operationServers, pathServers], context.rootPrefixes),
  };
}

/**
 * path item의 `$ref` 사슬을 따라 필드 층을 모은다.
 *
 * 형제 필드와 참조 대상 필드가 겹치는 경우 OpenAPI는 동작을 정의하지 않는다.
 * 추측해 하나를 버리지 않고 둘 다 층으로 남긴다(같은 method가 두 위치에서 나오면
 * 두 사실이 되고, 키 집합은 같다). 서버는 형제 필드가 먼저다.
 *
 * @param context 수집 상태
 * @param value path item 값
 * @returns 필드 층 또는 읽지 못한 이유
 */
function resolvePathItemLayers(context: ExtractionContext, value: ParsedNode | null): PathItemLayers {
  const { tree } = context;
  const layers: LayerSummary[] = [];
  const visited = new Set<ParsedNode>();
  let current = tree.resolve(value);
  for (let hop = 0; current !== undefined && !isNullScalar(current); hop++) {
    if (!tree.isMapping(current)) return { kind: 'gap', gap: 'nonObjectPathItems' };
    if (visited.has(current) || hop > MAX_PATH_ITEM_REFERENCE_HOPS) return { kind: 'gap', gap: 'cyclicReferences' };
    visited.add(current);
    const layer = summarizeLayer(context, current);
    layers.push(layer);
    if (layer.reference === undefined) break;
    const next = followReference(tree, layer.reference);
    if (next.kind === 'gap') return next;
    current = next.node;
  }
  return { kind: 'layers', layers };
}

/**
 * path item 층 노드를 한 번 훑어 요약하고 캐시한다.
 *
 * @param context 수집 상태
 * @param node 매핑 노드
 * @returns 층 요약
 */
function summarizeLayer(context: ExtractionContext, node: ParsedNode): LayerSummary {
  const cached = context.layerCache.get(node);
  if (cached !== undefined) return cached;
  const methodFields: MapEntry[] = [];
  let unknownFieldCount = 0;
  let servers: ParsedNode | undefined;
  let reference: ParsedNode | null | undefined;
  for (const entry of context.tree.entries(node) ?? []) {
    if (entry.key === '$ref') reference ??= entry.value;
    else if (operationMethod(context.version, entry.key) !== undefined) methodFields.push(entry);
    else if (!isKnownPathItemField(context.version, entry.key)) unknownFieldCount += 1;
    else if (entry.key === 'servers') servers ??= context.tree.resolve(entry.value);
  }
  const summary = { methodFields, unknownFieldCount, servers, reference };
  context.layerCache.set(node, summary);
  return summary;
}

/**
 * `$ref` 값 하나를 따라간다.
 *
 * @param tree 스펙 트리
 * @param referenceValue `$ref` 값 노드
 * @returns 대상 노드 또는 읽지 못한 이유
 */
function followReference(
  tree: SpecTree,
  referenceValue: ParsedNode | null,
): { kind: 'node'; node: ParsedNode } | { kind: 'gap'; gap: keyof ExtractionGaps } {
  const reference = tree.string(referenceValue);
  if (reference === undefined) return { kind: 'gap', gap: 'brokenReferences' };
  const resolution = resolveLocalReference(tree, reference);
  if (resolution.kind === 'non-local') return { kind: 'gap', gap: 'nonLocalReferences' };
  if (resolution.kind === 'broken') return { kind: 'gap', gap: 'brokenReferences' };
  return { kind: 'node', node: resolution.node };
}

/**
 * YAML의 빈 값(`/x:` 뒤에 아무것도 없음)인지 확인한다. operation이 없는 path item이다.
 *
 * @param node 노드
 * @returns null 스칼라면 true
 */
function isNullScalar(node: ParsedNode): boolean {
  return isScalar(node) && node.value === null;
}

/**
 * 키가 이 버전의 operation이면 대문자 method를 돌려준다.
 *
 * OpenAPI 필드 이름은 대소문자를 구분한다. `GET` 같은 키는 operation이 아니라
 * 모르는 필드로 센다.
 *
 * @param version 스펙 버전
 * @param key 필드 키
 * @returns method 또는 undefined
 */
function operationMethod(version: SpecVersion, key: string | undefined): HttpMethod | undefined {
  if (key === undefined || !operationKeysByVersion[version].includes(key)) return undefined;
  return key.toUpperCase() as HttpMethod;
}

/**
 * operation이 아닌 필드가 알려진 필드나 확장인지 확인한다.
 *
 * @param version 스펙 버전
 * @param key 필드 키
 * @returns 알려진 필드·`x-` 확장이면 true
 */
function isKnownPathItemField(version: SpecVersion, key: string | undefined): boolean {
  return key !== undefined && (key.startsWith('x-') || knownPathItemFields[version].has(key));
}

/**
 * servers 필드 값을 선택 결과로 분류한다.
 *
 * 빈 배열은 "제공하지 않음"과 같다(OpenAPI 3.x 루트 규칙을 하위 수준에도 적용).
 * 배열이 아닌 값은 의미를 확정할 수 없어 invalid다.
 *
 * @param tree 스펙 트리
 * @param node servers 값
 * @returns 선택 결과
 */
function pickServerSource(tree: SpecTree, node: ParsedNode | undefined): ServerSource {
  if (node === undefined) return { kind: 'none' };
  const items = tree.items(node);
  if (items === undefined) return { kind: 'invalid' };
  return items.length === 0 ? { kind: 'none' } : { kind: 'list', node };
}

/**
 * 가장 안쪽(operation → path item) 서버 선택을 적용해 접두사를 구한다.
 *
 * @param context 수집 상태
 * @param sources 안쪽부터의 서버 선택
 * @param fallback 모두 없을 때의 접두사
 * @returns 접두사 집합
 */
function prefixesFor(
  context: Pick<ExtractionContext, 'tree' | 'serverCache'>,
  sources: readonly ServerSource[],
  fallback: ServerPrefixes,
): ServerPrefixes {
  const chosen = sources.find((source) => source.kind !== 'none');
  if (chosen === undefined) return fallback;
  if (chosen.kind === 'invalid') return UNRESOLVED_SERVER_PREFIXES;
  const cached = context.serverCache.get(chosen.node);
  if (cached !== undefined) return cached;
  const resolved = resolveServerList(context.tree, chosen.node);
  context.serverCache.set(chosen.node, resolved);
  return resolved;
}

/**
 * 서버 목록 전체의 접두사를 합친다.
 *
 * @param tree 스펙 트리
 * @param listNode 비어 있지 않은 servers 배열
 * @returns 합친 접두사
 */
function resolveServerList(tree: SpecTree, listNode: ParsedNode): ServerPrefixes {
  const servers = tree.items(listNode) ?? [];
  return mergeServerPrefixes(servers.map((server) => resolveServerObject(tree, server)));
}

/**
 * 서버 객체 하나를 해석한다.
 *
 * @param tree 스펙 트리
 * @param node 서버 객체
 * @returns 접두사. url이 문자열이 아니면 미확정
 */
function resolveServerObject(tree: SpecTree, node: ParsedNode | undefined): ServerPrefixes {
  const url = tree.string(tree.get(node, 'url'));
  if (url === undefined) return UNRESOLVED_SERVER_PREFIXES;
  return resolveServerUrl(url, readServerVariables(tree, tree.get(node, 'variables')));
}

/**
 * 서버 변수 선언을 읽는다.
 *
 * @param tree 스펙 트리
 * @param node variables 객체
 * @returns 변수 이름 → 선언
 */
function readServerVariables(tree: SpecTree, node: ParsedNode | undefined): Map<string, ServerVariable> {
  const variables = new Map<string, ServerVariable>();
  for (const entry of tree.entries(node) ?? []) {
    if (entry.key === undefined) continue;
    variables.set(entry.key, {
      defaultValue: scalarText(tree, tree.get(entry.value, 'default')),
      values: enumValues(tree, tree.get(entry.value, 'enum')),
    });
  }
  return variables;
}

/**
 * 서버 변수의 enum을 문자열 목록으로 읽는다.
 *
 * @param tree 스펙 트리
 * @param node enum 값
 * @returns 모든 원소가 텍스트인 비어 있지 않은 목록, 아니면 undefined(열린 변수)
 */
function enumValues(tree: SpecTree, node: ParsedNode | undefined): string[] | undefined {
  const items = tree.items(node);
  if (items === undefined || items.length === 0) return undefined;
  const values = items.map((item) => scalarText(tree, item));
  // 짝 없는 서러게이트가 든 값은 정규화에서 U+FFFD로 바뀌어 원문과 다른 접두사가 되므로 열린 변수로 본다.
  return values.every((value) => value !== undefined && value.isWellFormed()) ? (values as string[]) : undefined;
}

/**
 * 서버 변수 값으로 쓸 스칼라 텍스트를 읽는다.
 *
 * 스펙은 문자열을 요구하지만 YAML에서 따옴표 없는 포트(`8443`)가 흔해 정수도
 * 받는다. 실수·불리언은 원문 표기를 복원할 수 없어 받지 않는다.
 *
 * @param tree 스펙 트리
 * @param node 스칼라 노드
 * @returns 텍스트 또는 undefined
 */
function scalarText(tree: SpecTree, node: ParsedNode | undefined): string | undefined {
  const text = tree.string(node);
  if (text !== undefined) return text;
  const resolved = tree.resolve(node);
  return isScalar(resolved) && Number.isSafeInteger(resolved.value) ? String(resolved.value) : undefined;
}
