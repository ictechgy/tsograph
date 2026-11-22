/**
 * 선언이 아닌 내보내기의 export 노드와 `alias` 간선이다.
 *
 * `routes`는 route-decl `symbol.usr`를 `exportBindingId`로 만든다. 그 id가 선언 노드가 아니면
 * (`export { a as GET }`, `export { GET } from './impl'`, `export const { GET } = handlers`,
 * 초기값 없는 `export let x`) 같은 id의 export 노드를 만들어 usr가 언제나 그래프 노드가 되게 하고,
 * checker로 해석한 실제 대상에 `alias` 간선을 잇는다. `type` 없이 다시 내보낸 interface·type alias처럼 타입만 가리키는
 * 이름은 노드를 그대로 두되 런타임 선언이 없어 간선 없이 따로 센다.
 */

import ts from 'typescript';

import { collectModuleExports } from '../routes/module-exports.ts';
import type { GraphStore } from './graph-model.ts';
import { exportBindingId } from './symbol-ids.ts';
import type { TargetResolver } from './target-resolver.ts';

/** 대상 해석을 기다리는 export 노드다. */
export interface PendingExport {
  readonly id: string;
  /** 내보낸 이름 토큰 */
  readonly name: ts.Node;
}

/**
 * 파일의 내보낸 이름 중 선언 노드가 아닌 것을 export 노드로 등록한다.
 *
 * @param store 그래프 저장소(선언 노드 등록 뒤)
 * @param path 프로젝트 기준 경로
 * @param sourceFile 파일
 * @returns 등록한 export 노드
 */
export function registerExportNodes(store: GraphStore, path: string, sourceFile: ts.SourceFile): PendingExport[] {
  const exports = collectModuleExports(sourceFile);
  const named = exports.names.map((exported) => ({ id: exportBindingId(path, exported.name, exported.node), name: exported.node }));
  const all = exports.defaultExport === undefined
    ? named
    : [...named, { id: exportBindingId(path, 'default', exports.defaultExport), name: exports.defaultExport }];
  const pending = all.filter((entry) => !store.hasNode(entry.id));
  for (const entry of pending) store.addNode(entry.id, 'export', path, entry.name);
  return pending;
}

/** export 노드 중 `alias` 간선을 잇지 못한 것의 원인별 수다. 외부 대상(ambient·의존성)은 어느 쪽에도 세지 않는다. */
export interface ExportLinkGaps {
  /** 대상을 해석하지 못한 export 노드 수(`unresolved-export-aliases:`) */
  readonly unresolved: number;
  /** 타입만 가리켜 이을 런타임 선언이 없는 export 노드 수(`type-only-export-aliases:`) */
  readonly typeOnly: number;
}

/**
 * export 노드에서 해석한 대상으로 `alias` 간선을 잇는다.
 *
 * @param store 그래프 저장소
 * @param checker TypeChecker
 * @param resolverFor export 파일 범위(운영/전체)에 맞는 대상 해석기
 * @param pending export 노드
 * @returns 간선을 잇지 못한 export 노드의 원인별 수
 */
export function linkExportNodes(
  store: GraphStore,
  checker: ts.TypeChecker,
  resolverFor: (sourceFile: ts.SourceFile) => TargetResolver,
  pending: readonly PendingExport[],
): ExportLinkGaps {
  let unresolved = 0;
  let typeOnly = 0;
  for (const entry of pending) {
    const symbol = exportTargetSymbol(checker, entry.name);
    if (symbol === 'none') continue;
    const resolution = resolverFor(entry.name.getSourceFile()).resolveExportSymbol(symbol, 0);
    if (resolution.kind === 'nodes') resolution.ids.forEach((id) => store.addEdge(entry.id, id, 'alias'));
    if (resolution.kind !== 'unresolved') continue;
    if (isTypeOnlyTarget(checker, symbol)) typeOnly++;
    else unresolved++;
  }
  return { unresolved, typeOnly };
}

/**
 * 내보낸 이름이 별칭을 끝까지 따라가도 타입만 가리키는지 본다. interface·type alias·값 없는 namespace·JSDoc typedef는
 * 런타임 값이 없어(TypeScript는 이런 재내보내기를 emit에서 지운다) 이을 선언이 없다. 값과 합쳐진 심볼(같은 이름의 interface와
 * `const`, enum, 값 있는 namespace)은 타입 전용이 아니다. 찾지 못한 대상은 checker의 unknown 심볼로 따라가고, 그 심볼은 값 플래그를
 * 가지므로 역시 타입 전용이 아니다(해석 실패로 남는다).
 *
 * @param checker TypeChecker
 * @param symbol 내보낸 이름의 심볼
 * @returns 타입만 가리키면 true
 */
function isTypeOnlyTarget(checker: ts.TypeChecker, symbol: ts.Symbol | undefined): boolean {
  if (symbol === undefined) return false;
  const target = (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  return (target.flags & ts.SymbolFlags.Value) === 0;
}

/**
 * export 이름 토큰이 가리키는 심볼이다.
 *
 * @param checker TypeChecker
 * @param name 내보낸 이름 토큰
 * @returns 심볼, 대상이 없는 형태(초기값 없는 변수·네임스페이스 재내보내기)면 'none'
 */
function exportTargetSymbol(checker: ts.TypeChecker, name: ts.Node): ts.Symbol | undefined | 'none' {
  const parent = name.parent;
  if (ts.isExportSpecifier(parent)) return checker.getExportSpecifierLocalTargetSymbol(parent);
  if (ts.isBindingElement(parent)) return checker.getSymbolAtLocation(name);
  return 'none';
}
