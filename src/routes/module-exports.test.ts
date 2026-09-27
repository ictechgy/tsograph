import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { collectModuleExports } from './module-exports.ts';
import { parseSource, scriptKindOf } from './source-file.ts';

/** 텍스트를 파싱해 내보낸 이름과 위치를 돌려준다. */
function exportsOf(text: string, fileName = 'route.ts') {
  const parsed = parseSource(fileName, text, scriptKindOf(fileName)!);
  const collected = collectModuleExports(parsed.sourceFile);
  return {
    ...collected,
    names: collected.names.map((exported) => exported.name),
    positions: collected.names.map((exported) => parsed.positionOf(exported.node)),
    defaultPosition: collected.defaultExport === undefined ? undefined : parsed.positionOf(collected.defaultExport),
    hasSyntaxErrors: parsed.hasSyntaxErrors,
  };
}

test('함수·변수·구조 분해·재내보내기·문자열 이름을 모은다', () => {
  const result = exportsOf([
    'export async function GET() {}',
    'export const POST = () => 1, PUT = 2;',
    'export const { DELETE, inner: { PATCH } } = handlers;',
    'export const [HEAD, , OPTIONS] = list;',
    'const handler = 1;',
    'export { handler as TRACE, handler as "CONNECT" };',
    "export { A } from './a';",
    "export * as ns from './ns';",
    'export class Controller {}',
    "export import Alias = Other.Name;",
  ].join('\n'));
  assert.deepEqual(result.names, ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'A', 'ns', 'Controller', 'Alias']);
  assert.deepEqual(result.positions[0], { line: 1, column: 23 });
  assert.equal(result.exportStarCount, 0);
  assert.equal(result.commonJsCount, 0);
  assert.equal(result.defaultExport, undefined);
});

test('타입 전용·ambient·기본 내보내기는 이름에서 뺀다', () => {
  const result = exportsOf([
    'export type GET = string;',
    'export interface POST {}',
    'export declare const PUT: number;',
    'export declare function PATCH(): void;',
    "export type { DELETE } from './d';",
    "export { type HEAD, OPTIONS } from './o';",
    'export default function GETS() {}',
    'export enum Kind { A }',
    'export function GET2(): void;',
    'export function GET2() {}',
    'export function GET2(x?: number) {}',
    'export default interface Shape {}',
  ].join('\n'));
  assert.deepEqual(result.names, ['OPTIONS', 'GET2']);
  assert.deepEqual(result.defaultPosition, { line: 7, column: 8 });
});

test('기본 내보내기 위치: export default 식, 지정자, 첫 문장만', () => {
  assert.deepEqual(exportsOf('const h = 1;\nexport default h;').defaultPosition, { line: 2, column: 8 });
  assert.deepEqual(exportsOf('const h = 1;\nexport { h as default };').defaultPosition, { line: 2, column: 15 });
  assert.equal(exportsOf('export declare default function x(): void;').defaultExport?.kind, undefined);
  assert.deepEqual(exportsOf('export default class {}').names, []);
});

test('export *와 CommonJS 형태를 센다', () => {
  const result = exportsOf([
    "export * from './a';",
    "export type * from './types';",
    'module.exports = handler;',
    'module.exports.GET = handler;',
    'exports.POST = handler;',
    "exports['PUT'] = handler;",
    'module.other = 1;',
    'other.exports = 1;',
    'foo = 1;',
    'call();',
    'value += 1;',
  ].join('\n'), 'route.js');
  assert.equal(result.exportStarCount, 1);
  assert.equal(result.commonJsCount, 4);
  assert.ok(result.firstCommonJsExport !== undefined);
  assert.equal(exportsOf('const x = 1;\nexport = x;').commonJsCount, 1);
});

test('파서: JSX 허용 여부는 확장자로, 구문 오류는 표시로 알린다', () => {
  assert.equal(scriptKindOf('route.tsx'), ts.ScriptKind.TSX);
  assert.equal(scriptKindOf('route.mjs'), ts.ScriptKind.JS);
  assert.equal(scriptKindOf('route.mdx'), undefined);
  assert.equal(scriptKindOf('route'), undefined);
  assert.equal(exportsOf('export const GET = () => <div />;', 'route.jsx').hasSyntaxErrors, false);
  assert.equal(exportsOf('export const GET = () => <div />;', 'route.ts').hasSyntaxErrors, true);
  const broken = exportsOf('export async function GET( {\n}', 'route.ts');
  assert.equal(broken.hasSyntaxErrors, true);
  assert.deepEqual(broken.names, ['GET']);
});

test('위치는 BOM과 멀티바이트 문자를 UTF-8 바이트로 센다', () => {
  const result = exportsOf('﻿export const GET = 1;\nconst 한 = 1; export const POST = 2;');
  assert.deepEqual(result.positions, [{ line: 1, column: 17 }, { line: 2, column: 29 }]);
});
