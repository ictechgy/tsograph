/**
 * 스펙 버전(Swagger 2.0, OpenAPI 3.0.x, 3.1.x)을 판별하고 필수 구조를 확인한다.
 *
 * 지원하지 않는 버전(예: 3.2)은 구조가 다를 수 있어 추측해 읽지 않고 실패한다.
 */

import type { ParsedNode } from 'yaml';
import { isScalar } from 'yaml';

import type { SpecTree } from './spec-tree.ts';

/** 지원하는 스펙 버전 계열이다. */
export type SpecVersion = '2.0' | '3.0' | '3.1';

/** 스펙 내용이 이 명령의 입력 조건을 만족하지 않는 이유다. */
export type SpecContentFailureReason =
  | 'not-an-object'
  | 'missing-version'
  | 'ambiguous-version'
  | 'unsupported-version'
  | 'missing-paths'
  | 'invalid-paths';

/** 스펙 내용 실패다. 메시지에 원문을 싣지 않는다. */
export class SpecContentError extends Error {
  /** 실패 분류다. */
  readonly reason: SpecContentFailureReason;

  /**
   * @param reason 실패 분류
   */
  constructor(reason: SpecContentFailureReason) {
    super(`spec content failure: ${reason}`);
    this.name = 'SpecContentError';
    this.reason = reason;
  }
}

/** 판별한 버전과 paths 노드다. */
export interface SpecShape {
  readonly version: SpecVersion;
  /** 3.1에서 paths가 없으면 undefined다(3.1은 paths를 필수로 두지 않는다). */
  readonly paths: ParsedNode | undefined;
}

/** OpenAPI 3.0.x·3.1.x 버전 문자열이다. 흔한 축약 `3.0`·`3.1`도 받는다. */
const openApiVersionPattern = /^3\.(0|1)(\.[0-9]+)?$/u;

/**
 * 스펙 버전과 paths를 확인한다.
 *
 * @param tree 스펙 트리
 * @returns 버전과 paths 노드
 * @throws SpecContentError 최상위가 객체가 아니거나 버전·paths가 조건에 맞지 않을 때
 */
export function readSpecShape(tree: SpecTree): SpecShape {
  if (!tree.isMapping(tree.root)) throw new SpecContentError('not-an-object');
  // 루트 키(openapi·swagger·servers·basePath·host·paths 등)는 사실을 정하는 구역이라 엄격하다.
  tree.requireUniqueKeys(tree.root);
  const version = detectVersion(tree);
  const paths = tree.get(tree.root, 'paths');
  if (paths === undefined && version !== '3.1') throw new SpecContentError('missing-paths');
  if (paths !== undefined && !tree.isMapping(paths)) throw new SpecContentError('invalid-paths');
  return { version, paths };
}

/**
 * `swagger`·`openapi` 필드로 버전을 판별한다.
 *
 * @param tree 스펙 트리
 * @returns 버전
 * @throws SpecContentError 버전이 없거나 둘 다 있거나 지원하지 않을 때
 */
function detectVersion(tree: SpecTree): SpecVersion {
  const swagger = tree.get(tree.root, 'swagger');
  const openApi = tree.get(tree.root, 'openapi');
  if (swagger !== undefined && openApi !== undefined) throw new SpecContentError('ambiguous-version');
  if (swagger !== undefined) {
    if (isSwaggerTwo(tree, swagger)) return '2.0';
    throw new SpecContentError('unsupported-version');
  }
  if (openApi === undefined) throw new SpecContentError('missing-version');
  const match = openApiVersionPattern.exec(tree.string(openApi) ?? '');
  if (match === null) throw new SpecContentError('unsupported-version');
  return match[1] === '0' ? '3.0' : '3.1';
}

/**
 * `swagger` 값이 2.0인지 확인한다. YAML에서 따옴표 없는 `2.0`은 숫자 2라 함께 받는다.
 *
 * @param tree 스펙 트리
 * @param node swagger 값
 * @returns 2.0이면 true
 */
function isSwaggerTwo(tree: SpecTree, node: ParsedNode): boolean {
  if (tree.string(node) === '2.0') return true;
  return isScalar(node) && node.value === 2;
}
