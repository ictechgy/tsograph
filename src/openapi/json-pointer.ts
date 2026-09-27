/**
 * 로컬 `$ref`(같은 파일 안의 JSON Pointer)만 해석한다.
 *
 * 원격·다른 파일 참조는 네트워크·파일 접근이 필요하므로 따라가지 않고
 * 호출자가 limitation으로 센다(초안: 외부 `$ref`와 네트워크를 쓰지 않는다).
 */

import type { ParsedNode } from 'yaml';

import type { SpecTree } from './spec-tree.ts';

/** `$ref` 해석 결과다. */
export type RefResolution =
  | { readonly kind: 'resolved'; readonly node: ParsedNode }
  /** 같은 문서 밖을 가리킨다(`other.yaml#/x`, `https://…`). */
  | { readonly kind: 'non-local' }
  /** 같은 문서 안이지만 대상이 없거나 포인터가 잘못됐다. */
  | { readonly kind: 'broken' };

/** 배열 인덱스로 쓸 수 있는 포인터 토큰이다(앞자리 0 금지). */
const arrayIndexToken = /^(0|[1-9][0-9]*)$/u;

/**
 * `$ref` 문자열을 같은 문서 안의 노드로 해석한다.
 *
 * @param tree 스펙 트리
 * @param reference `$ref` 값(예: `#/components/pathItems/Items`)
 * @returns 해석 결과
 */
export function resolveLocalReference(tree: SpecTree, reference: string): RefResolution {
  if (!reference.startsWith('#')) return { kind: 'non-local' };
  const pointer = decodeFragment(reference.slice(1));
  if (pointer === undefined || (pointer !== '' && !pointer.startsWith('/'))) return { kind: 'broken' };
  let node = tree.resolve(tree.root);
  for (const token of pointer === '' ? [] : pointer.slice(1).split('/')) {
    node = stepInto(tree, node, unescapeToken(token));
    if (node === undefined) return { kind: 'broken' };
  }
  return node === undefined ? { kind: 'broken' } : { kind: 'resolved', node };
}

/**
 * URI fragment의 percent-encoding을 푼다.
 *
 * @param fragment `#` 뒤 문자열
 * @returns 디코드한 포인터. 잘못된 인코딩이면 undefined
 */
function decodeFragment(fragment: string): string | undefined {
  try {
    return decodeURIComponent(fragment);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    /* node:coverage ignore next */
    throw error;
  }
}

/**
 * JSON Pointer 토큰 이스케이프(`~1` → `/`, `~0` → `~`)를 푼다. 순서가 중요하다.
 *
 * @param token 포인터 토큰
 * @returns 키 문자열
 */
function unescapeToken(token: string): string {
  return token.replaceAll('~1', '/').replaceAll('~0', '~');
}

/**
 * 매핑이면 키로, 시퀀스면 인덱스로 한 단계 내려간다.
 *
 * @param tree 스펙 트리
 * @param node 현재 노드
 * @param token 키 또는 인덱스
 * @returns 다음 노드. 없으면 undefined
 */
function stepInto(tree: SpecTree, node: ParsedNode | undefined, token: string): ParsedNode | undefined {
  if (tree.isMapping(node)) return tree.get(node, token);
  const items = tree.items(node);
  if (items === undefined || !arrayIndexToken.test(token)) return undefined;
  return items[Number(token)];
}
