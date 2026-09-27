/**
 * 스펙 트리를 isthmus bridge-facts v1 `route-contract` 문서로 조립한다.
 *
 * 파일 시스템을 읽지 않는 순수 조립이다. 경로·시각·도구 버전은 CLI가 넘긴다.
 * 사실 하나 = (경로 템플릿, method, 앵커)마다 operation 하나다. 여러 서버가 서로
 * 다른 경로 접두사를 가지면 접두사마다 사실을 낸다 — 각 접두사가 스펙이 선언한
 * 실제 경로이기 때문이다.
 */

import {
  type BridgeLocation,
  formatBridgeTimestamp,
  isSafeIdentifier,
  type PathAnchor,
  type RouteContractDocument,
  type RouteContractFact,
} from '../exchange/bridge-facts.ts';
import { compareStrings } from '../exchange/sorted-json.ts';
import { type ExtractedOperation, extractOperations, type ExtractionGaps } from './operations.ts';
import {
  canonicalizePathTemplate,
  MAX_TEMPLATE_LENGTH,
  type PathTemplateResult,
  sanitizeDynamicChannel,
} from './path-template.ts';
import type { SpecTree } from './spec-tree.ts';
import { readSpecShape } from './spec-version.ts';

/** 문서 하나에 담는 최대 사실 수다. isthmus 입력 상한과 같다. */
export const MAX_FACTS = 100_000;

/** 사실 수가 상한을 넘었다. 부분 문서를 내지 않고 실패한다. */
export class FactLimitError extends Error {
  constructor() {
    super(`spec produces more than ${MAX_FACTS} route-contract facts`);
    this.name = 'FactLimitError';
  }
}

/** 조립 입력이다. */
export interface ContractDocumentInput {
  readonly tree: SpecTree;
  /** 프로젝트 루트 기준 스펙 파일 상대 경로(POSIX 구분자) */
  readonly specPath: string;
  /** POSIX realpath로 정규화한 프로젝트 루트 */
  readonly project: string;
  readonly service: string;
  readonly toolVersion: string;
  readonly generatedAt: Date;
  /** 스펙 파일의 mtime. 측정하지 않았으면 undefined */
  readonly sourceModifiedAt: Date | undefined;
}

/** 사실을 만들며 세는 한계 개수다. */
interface FactCounters {
  unresolvedServerOperations: number;
  dynamicTemplates: number;
  unsafeOperationIds: number;
}

/**
 * 스펙 트리를 route-contract 문서로 조립한다.
 *
 * @param input 조립 입력
 * @returns bridge-facts v1 문서
 * @throws SpecContentError 버전·paths가 조건에 맞지 않을 때
 * @throws FactLimitError 사실 수가 상한을 넘을 때
 */
export function createContractDocument(input: ContractDocumentInput): RouteContractDocument {
  const shape = readSpecShape(input.tree);
  const extraction = extractOperations(input.tree, shape.version, shape.paths);
  const counters: FactCounters = { unresolvedServerOperations: 0, dynamicTemplates: 0, unsafeOperationIds: 0 };
  const facts = extraction.operations.flatMap((operation) => operationFacts(input, operation, counters));
  if (facts.length > MAX_FACTS) throw new FactLimitError();
  return {
    format: 'bridge-facts',
    version: 1,
    tool: { name: 'tsograph', version: input.toolVersion },
    generatedAt: formatBridgeTimestamp(input.generatedAt),
    ...(input.sourceModifiedAt === undefined ? {} : { sourceModifiedAt: formatBridgeTimestamp(input.sourceModifiedAt) }),
    platform: 'openapi',
    target: 'http',
    roles: ['server'],
    service: input.service,
    project: input.project,
    facts: sortAndDeduplicate(facts),
    limitations: buildLimitations(extraction.gaps, counters),
  };
}

/**
 * operation 하나의 사실을 서버 접두사마다 만든다.
 *
 * @param input 조립 입력
 * @param operation operation
 * @param counters 한계 개수(갱신)
 * @returns 사실 목록
 */
function operationFacts(
  input: ContractDocumentInput,
  operation: ExtractedOperation,
  counters: FactCounters,
): RouteContractFact[] {
  const template = canonicalizePathTemplate(operation.pathKey);
  if (operation.prefixes.baseTails.length > 0) counters.unresolvedServerOperations += 1;
  const operationId = safeOperationId(operation.operationId, counters);
  const position = input.tree.position(operation.keyNode);
  const location: BridgeLocation = { path: input.specPath, ...position };
  const anchored: [string, PathAnchor][] = [
    ...operation.prefixes.roots.map((prefix): [string, PathAnchor] => [prefix, 'root']),
    ...operation.prefixes.baseTails.map((tail): [string, PathAnchor] => [tail, 'base']),
  ];
  const facts = anchored.map(([prefix, pathAnchor]): RouteContractFact => ({
    kind: 'route-contract',
    method: operation.method,
    ...composeChannel(prefix, template),
    pathAnchor,
    service: input.service,
    location,
    ...(operationId === undefined ? {} : { symbol: { qualifiedName: operationId }, operationId }),
  }));
  if (facts.some((fact) => fact.dynamic)) counters.dynamicTemplates += 1;
  return facts;
}

/**
 * 접두사와 템플릿을 이어 channel을 만든다.
 *
 * 접두사는 이미 정규화한 리터럴 경로다(`''` 또는 `/`로 시작, 끝 슬래시 없음).
 * 스펙 경로 `/`는 그대로 이어 `/v1/`이 된다 — 끝 슬래시를 보존하는 초안 규칙이다.
 * 합친 정적 템플릿이 길이 상한을 넘으면 소비자가 문서째 거부하므로 dynamic으로 낸다.
 *
 * @param prefix 서버 접두사 또는 base 꼬리
 * @param template 경로 템플릿 정규화 결과(`/`로 시작하는 키만 들어온다)
 * @returns channel과 dynamic 표시
 */
function composeChannel(prefix: string, template: PathTemplateResult): { channel: string; dynamic: boolean } {
  if (template.kind === 'static') {
    const channel = `${prefix}${template.template}`;
    if (channel.length <= MAX_TEMPLATE_LENGTH) return { channel, dynamic: false };
    return { channel: sanitizeDynamicChannel(channel), dynamic: true };
  }
  // 접두사가 길어도 dynamic 원문 상한을 넘지 않게 합친 뒤 다시 자른다.
  if (template.kind === 'dynamic') return { channel: sanitizeDynamicChannel(`${prefix}${template.channel}`), dynamic: true };
  /* node:coverage ignore next */
  throw new Error('non-rooted path keys are filtered before template canonicalization');
}

/**
 * operationId를 문서에 실어도 안전한지 확인한다.
 *
 * operationId는 정보용이라 안전하지 않으면 사실은 유지하고 이름만 뺀 뒤 센다.
 *
 * @param operationId 원문 operationId
 * @param counters 한계 개수(갱신)
 * @returns 안전한 operationId 또는 undefined
 */
function safeOperationId(operationId: string | undefined, counters: FactCounters): string | undefined {
  if (operationId === undefined) return undefined;
  if (isSafeIdentifier(operationId)) return operationId;
  counters.unsafeOperationIds += 1;
  return undefined;
}

/**
 * 사실을 결정적으로 정렬하고 완전히 같은 사실을 하나로 줄인다.
 *
 * @param facts 사실 목록
 * @returns 정렬·중복 제거한 목록
 */
function sortAndDeduplicate(facts: readonly RouteContractFact[]): RouteContractFact[] {
  const unique = new Map(facts.map((fact) => [JSON.stringify(fact), fact]));
  return [...unique.values()].sort(compareFacts);
}

/**
 * 사실을 (channel, method, 앵커, dynamic, 줄, 열, operationId) 순서로 비교한다.
 *
 * 문자열은 locale과 무관한 코드 단위 순서로 비교한다.
 *
 * @param left 왼쪽 사실
 * @param right 오른쪽 사실
 * @returns 음수·0·양수
 */
function compareFacts(left: RouteContractFact, right: RouteContractFact): number {
  return compareStrings(left.channel, right.channel)
    || compareStrings(left.method, right.method)
    || compareStrings(left.pathAnchor, right.pathAnchor)
    || Number(left.dynamic) - Number(right.dynamic)
    || left.location.line - right.location.line
    || left.location.column - right.location.column
    || compareStrings(left.operationId ?? '', right.operationId ?? '');
}

/**
 * 읽지 못한 부분과 미확정 값을 계약 접두사를 붙인 limitation 문장으로 만든다.
 *
 * 스펙 원문(경로·URL)은 싣지 않고 개수만 싣는다. `unresolved-contract-servers:`와
 * `contract-coverage:`는 초안의 계약 측 접두사다. `unsafe-operation-ids:`는 정보용이라
 * 소비자가 공백으로 읽지 않는다.
 *
 * @param gaps operation 수집 개수
 * @param counters 사실 생성 개수
 * @returns 정렬한 limitation 목록
 */
function buildLimitations(gaps: ExtractionGaps, counters: FactCounters): string[] {
  const unreadableItems = gaps.nonLocalReferences + gaps.brokenReferences + gaps.cyclicReferences + gaps.nonObjectPathItems;
  const candidates: [number, string][] = [
    [counters.unresolvedServerOperations, `unresolved-contract-servers: ${counters.unresolvedServerOperations} operations use a server URL or basePath whose path prefix could not be resolved (open server variables, relative server URLs, or invalid values); their facts use pathAnchor base`],
    [counters.dynamicTemplates, `contract-coverage: ${counters.dynamicTemplates} operation path templates have unbalanced braces, more than one parameter in a segment, malformed text, or exceed ${MAX_TEMPLATE_LENGTH} characters; they are reported as dynamic`],
    [gaps.nonRootedPathKeys, `contract-coverage: ${gaps.nonRootedPathKeys} paths keys do not start with "/" and were skipped`],
    [unreadableItems, `contract-coverage: ${unreadableItems} path items could not be read (${gaps.nonLocalReferences} non-local $ref, ${gaps.brokenReferences} broken $ref, ${gaps.cyclicReferences} cyclic $ref, ${gaps.nonObjectPathItems} non-object) and were skipped`],
    [gaps.nonObjectOperations, `contract-coverage: ${gaps.nonObjectOperations} operations are not objects and were skipped`],
    [gaps.unknownPathItemFields, `contract-coverage: ${gaps.unknownPathItemFields} path item fields are neither operations for this OpenAPI version nor known fields and were skipped`],
    [counters.unsafeOperationIds, `unsafe-operation-ids: ${counters.unsafeOperationIds} operationId values contain characters the exchange format forbids and were omitted`],
  ];
  return candidates.filter(([count]) => count > 0).map(([, text]) => text).sort(compareStrings);
}
