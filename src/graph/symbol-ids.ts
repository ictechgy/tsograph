/**
 * tsograph의 안정 심볼 id 규칙이다.
 *
 * 형식: `<프로젝트 기준 POSIX 경로>#<선언 경로>`. 선언 경로는 `schema`의 `symbol.qualifiedName`과 같은
 * 규칙(`enclosingSymbol`)으로 만든다 — 바깥 선언부터 `.`으로 잇는다(`src/lib/jobs.ts#listJobs`,
 * `src/lib/repo.ts#Repo.save`, `src/app/api/items/[id]/route.ts#GET`). 어떤 선언에도 속하지 않는
 * 코드(모듈 최상위 문장, 계산된 이름 멤버 안)는 모듈 스코프 `<경로>#<module>`에 속한다.
 *
 * 같은 규칙을 세 곳이 쓴다: 호출 그래프의 노드 id, `schema` relation-use의 `symbol.usr`,
 * `routes` route-decl의 `symbol.usr`. 그래서 isthmus가 생산자 id를 정확한 문자열 일치로만 이을 수 있다.
 */

import ts from 'typescript';

import { enclosingSymbol } from '../schema/enclosing-symbol.ts';

/** 모듈 스코프 선언 경로다. JS 식별자가 될 수 없는 이름이라 실제 선언과 겹치지 않는다. */
export const MODULE_SCOPE_NAME = '<module>';

/**
 * 파일의 모듈 스코프 id를 만든다.
 *
 * @param path 프로젝트 기준 POSIX 경로
 * @returns `<path>#<module>`
 */
export function moduleScopeId(path: string): string {
  return `${path}#${MODULE_SCOPE_NAME}`;
}

/**
 * 노드가 속한 스코프(가장 안쪽 이름 있는 선언, 없으면 모듈)의 id를 만든다.
 *
 * @param node 코드 노드
 * @param path 프로젝트 기준 POSIX 경로
 * @returns 스코프 id
 */
export function scopeIdOf(node: ts.Node, path: string): string {
  return enclosingSymbol(node, path) ?? moduleScopeId(path);
}

/**
 * 모듈이 내보낸 이름 하나의 id를 만든다(`routes`의 route-decl `symbol.usr`).
 *
 * - 이름 있는 `export default function h`·`export default class C`는 선언 id(`#h`, `#C`)다 —
 *   그 안 코드의 relation-use가 같은 id를 갖기 때문이다.
 * - 이름 없는 기본 내보내기(`export default <식>`, `export { x as default }`)는 `#default`다.
 * - 그 밖(`export function GET`, `export const GET = …`, 구조 분해, `export { a as GET }`,
 *   재내보내기)은 `#<내보낸 이름>`이다. 선언 id와 같지 않은 경우(별칭·재내보내기·구조 분해)
 *   그래프가 같은 id의 export 노드를 만들어 실제 대상으로 `alias` 간선을 잇는다.
 *
 * @param path 프로젝트 기준 POSIX 경로
 * @param exportName 내보낸 이름(`default` 포함)
 * @param node `collectModuleExports`가 준 이름 토큰(기본 내보내기는 `default` 키워드)
 * @returns 심볼 id
 */
export function exportBindingId(path: string, exportName: string, node: ts.Node): string {
  if (node.kind !== ts.SyntaxKind.DefaultKeyword) return `${path}#${exportName}`;
  const owner = node.parent;
  const named = (ts.isFunctionDeclaration(owner) || ts.isClassDeclaration(owner)) ? owner.name?.text : undefined;
  return `${path}#${named ?? 'default'}`;
}
