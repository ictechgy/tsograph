/**
 * persistence 사실을 isthmus bridge-facts v1 문서로 조립한다.
 *
 * `platform: "js"`, 사실이 있으면 `target: "persistence"`, 없으면 `target: null`(계약의 target 호환
 * 규칙 — 사실이 없는 문서는 target을 갖지 않는다). 사실 수가 소비자 상한을 넘으면 부분 문서를
 * 만들지 않고 실패한다.
 */

import { formatBridgeTimestamp } from '../exchange/bridge-facts.ts';
import type { RelationUseFact } from './relation-facts.ts';

/** 문서 하나의 최대 사실 수다(isthmus 입력 상한). */
export const MAX_SCHEMA_FACTS = 100_000;

/** 사실 수 상한 초과다. */
export class SchemaFactLimitError extends Error {
  /**
   * @param count 사실 수
   */
  constructor(count: number) {
    super(`fact count ${count} exceeds ${MAX_SCHEMA_FACTS}`);
    this.name = 'SchemaFactLimitError';
  }
}

/** tsograph schema가 내는 문서다. */
export interface PersistenceDocument {
  readonly format: 'bridge-facts';
  readonly version: 1;
  readonly tool: { readonly name: 'tsograph'; readonly version: string };
  readonly generatedAt: string;
  readonly sourceModifiedAt?: string;
  readonly platform: 'js';
  readonly target: 'persistence' | null;
  readonly project: string;
  readonly facts: readonly RelationUseFact[];
  readonly limitations: readonly string[];
}

/** 문서 조립 입력이다. */
export interface PersistenceDocumentInput {
  readonly project: string;
  readonly toolVersion: string;
  readonly generatedAt: Date;
  readonly sourceModifiedAt: Date | undefined;
  readonly facts: readonly RelationUseFact[];
  readonly limitations: readonly string[];
}

/**
 * 문서를 조립한다.
 *
 * @param input 조립 입력
 * @returns 문서
 * @throws SchemaFactLimitError 사실 수가 상한을 넘을 때
 */
export function createPersistenceDocument(input: PersistenceDocumentInput): PersistenceDocument {
  if (input.facts.length > MAX_SCHEMA_FACTS) throw new SchemaFactLimitError(input.facts.length);
  return {
    format: 'bridge-facts',
    version: 1,
    tool: { name: 'tsograph', version: input.toolVersion },
    generatedAt: formatBridgeTimestamp(input.generatedAt),
    ...(input.sourceModifiedAt === undefined ? {} : { sourceModifiedAt: formatBridgeTimestamp(input.sourceModifiedAt) }),
    platform: 'js',
    target: input.facts.length > 0 ? 'persistence' : null,
    project: input.project,
    facts: input.facts,
    limitations: input.limitations,
  };
}
