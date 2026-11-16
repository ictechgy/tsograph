/**
 * 선언 산출물 역매핑이 쓰는 export 이름 표가 tsc 선언 emit의 이름을 소스와 같은 방식으로 읽는지, 확정하지 못한 표를 맞는다고
 * 보지 않는지, 따라가지 않는 `export *`를 같은 위치의 지정자나 외부 대상 표지로 비교하는지 검증한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { declarationExportsCovered, ExportTableReader, type ExportTable } from './declaration-exports.ts';

/** 합성 파일들을 쓰고 프로젝트 realpath를 돌려준다. */
function createProject(files: Readonly<Record<string, string>>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-declaration-exports-')));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** 위치 키의 경로를 표 루트 디렉터리 기준 상대 경로로 보여 준다. */
function showKey(table: ExportTable, key: string): string {
  return key.startsWith('path:') ? `path:${relative(table.directory, key.slice('path:'.length)).replaceAll('\\', '/')}` : key;
}

/** 이름 표를 비교하기 쉬운 정렬 배열로 바꾼다. 이름을 읽지 않은 `export *`는 위치 키로 보인다. */
function plain(table: ExportTable) {
  return { names: [...table.names].sort(), opaque: [...table.opaqueStars.keys()].map((key) => showKey(table, key)).sort(), complete: table.complete };
}

/** 번들러 해석 옵션이다. */
const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext };

test('ES module·TypeScript 문법의 export 이름을 값·타입 구분 없이 모은다', () => {
  const root = createProject({
    'a.ts': [
      'export interface I {}', 'export type T = 1;', 'export enum E { A }', 'export const enum C { B }', 'export declare const d: number;',
      'export namespace N { export const inner = 1; }', 'export declare namespace M {}', 'declare module "augmented" { export const x: 1; }',
      'declare global { interface Window {} }', 'export default function () {}', 'export import Alias = N.inner;',
      'export let [first, , third] = [1, 2, 3];', 'export { I as Renamed };', 'export { b as "string export" } from "./b";', 'export type { T as TypeOnly };',
      'export * as ns from "./b";', 'export {};', 'function local() {}', 'export function (): void {}', 'export class {}', 'export declare module "quoted" {}',
      'export as namespace Global;',
    ].join('\n'),
    'b.ts': 'export const b = 1;\n',
  });
  try {
    assert.deepEqual(plain(new ExportTableReader(root).table(join(root, 'a.ts'), options)), {
      names: ['Alias', 'C', 'E', 'I', 'M', 'N', 'Renamed', 'T', 'TypeOnly', 'd', 'default', 'first', 'ns', 'string export', 'third'],
      opaque: [], complete: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export *는 대상 이름을 default와 export = 없이 보태고, 순환·중복 대상은 한 번만 읽는다', () => {
  const root = createProject({
    'index.d.ts': 'export * from "./a";\nexport * from "./a.js";\nexport * from "./cycle";\nexport type * from "./types";\nexport default 1;\n',
    'a.d.ts': 'export declare function a(): void;\nexport default a;\n',
    'cycle.d.ts': 'export * from "./index";\nexport declare const cycle: 1;\n',
    'types.d.ts': 'export interface Shape {}\n',
    'equals.d.ts': 'export * from "./assigned";\n',
    'assigned.d.ts': 'declare function f(): void;\nexport = f;\n',
  });
  try {
    const reader = new ExportTableReader(root);
    const index = reader.table(join(root, 'index.d.ts'), options);
    assert.deepEqual(plain(index), { names: ['Shape', 'a', 'cycle', 'default'], opaque: [], complete: true });
    // 따라간 재내보내기도 위치 키로 남는다(상대 키는 지정자를 쓴 그대로다).
    assert.deepEqual([...index.starKeys].map((key) => showKey(index, key)).sort(), ['path:a', 'path:a.js', 'path:cycle', 'path:index', 'path:types']);
    assert.deepEqual(plain(reader.table(join(root, 'equals.d.ts'), options)), { names: [], opaque: [], complete: true });
    // 같은 설정·같은 파일은 캐시한 같은 표다.
    assert.equal(reader.table(join(root, 'index.d.ts'), options), reader.table(join(root, 'index.d.ts'), options));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Node 모드 해석은 파일의 module 형식에 맞는 모드로 export *를 따라간다', () => {
  // type: module 패키지의 선언은 ESM이라 확장자 없는 상대 지정자를 해석하지 못한다(TypeScript와 같다).
  const root = createProject({
    'esm/package.json': '{ "type": "module" }',
    'esm/index.d.ts': 'export * from "./a.js";\nexport declare const own: 1;\n',
    'esm/extensionless.d.ts': 'export * from "./a";\n',
    'esm/a.d.ts': 'export declare const a: 1;\n',
    'cjs/package.json': '{ "type": "commonjs" }',
    'cjs/extensionless.d.ts': 'export * from "./a";\n',
    'cjs/a.d.ts': 'export declare const a: 1;\n',
  });
  try {
    const nodeNext: ts.CompilerOptions = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    const reader = new ExportTableReader(root);
    assert.deepEqual(plain(reader.table(join(root, 'esm/index.d.ts'), nodeNext)), { names: ['a', 'own'], opaque: [], complete: true });
    assert.deepEqual(plain(reader.table(join(root, 'esm/extensionless.d.ts'), nodeNext)), { names: [], opaque: ['path:a'], complete: true });
    assert.deepEqual(plain(reader.table(join(root, 'cjs/extensionless.d.ts'), nodeNext)), { names: ['a'], opaque: [], complete: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('JavaScript 모듈은 이름을 구문으로 정하지 않고 폐쇄에 JavaScript가 있다고 표시한다', () => {
  // tsc는 CommonJS·JSDoc export 이름을 checker로 정한다. 구문 표는 그 이름을 다 읽지 못하므로 읽지 않는다.
  const root = createProject({
    'cjs.cjs': 'const api = { helper() {} };\nmodule.exports = api;\n',
    'esm.mjs': 'export const view = 1;\n',
    'jsx.jsx': 'export const view = 1;\n',
    'tsx.tsx': 'export const view = 1;\n',
    'reexport.ts': 'export * from "./cjs.cjs";\nexport const own = 1;\n',
    'reexport.d.ts': 'export * from "./esm.mjs";\nexport declare const own: 1;\n',
  });
  try {
    const reader = new ExportTableReader(root);
    for (const name of ['cjs.cjs', 'esm.mjs', 'jsx.jsx']) {
      const table = reader.table(join(root, name), options);
      assert.deepEqual({ ...plain(table), javaScript: table.includesJavaScript }, { names: [], opaque: [], complete: true, javaScript: true }, name);
    }
    const tsx = reader.table(join(root, 'tsx.tsx'), options);
    assert.deepEqual({ ...plain(tsx), javaScript: tsx.includesJavaScript }, { names: ['view'], opaque: [], complete: true, javaScript: false });
    // export *가 닿은 JavaScript 대상은 이름을 읽지 않은 재내보내기다. 소스 쪽에서는 대조를 끄는 표시도 남긴다.
    const source = reader.table(join(root, 'reexport.ts'), { ...options, allowJs: true });
    assert.deepEqual({ ...plain(source), javaScript: source.includesJavaScript }, { names: ['own'], opaque: ['path:cjs.cjs'], complete: true, javaScript: true });
    const declaration = reader.table(join(root, 'reexport.d.ts'), options);
    assert.deepEqual({ ...plain(declaration), javaScript: declaration.includesJavaScript },
      { names: ['own'], opaque: ['path:esm.mjs'], complete: true, javaScript: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TypeScript 파일의 CommonJS 모양 할당과 JSDoc은 export가 아니다', () => {
  const root = createProject({ 'a.ts': '/** @typedef {number} Count */\nexports.a = 1;\nmodule.exports = { b: 1 };\n' });
  try {
    assert.deepEqual(plain(new ExportTableReader(root).table(join(root, 'a.ts'), options)), { names: [], opaque: [], complete: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('표 루트를 읽지 못하거나 구문 깊이를 넘으면 표를 확정하지 않고, 읽지 못한·해석하지 못한 export * 대상은 위치로만 남긴다', () => {
  const root = createProject({
    'json.ts': 'export * from "./data.json";\n',
    'data.json': '{}',
    'deep.ts': `export const deep = ${'('.repeat(500)}1${')'.repeat(500)};\n`,
    'nested.ts': 'export * from "./deep";\nexport const kept = 1;\n',
    'relative.ts': 'export * from "../outside-missing";\nexport const kept = 1;\n',
    'absolute.ts': 'export * from "/definitely/missing/module";\n',
    'bare.ts': 'export * from "@not-installed/pkg";\nexport * from "@not-installed/pkg";\n',
  });
  try {
    const reader = new ExportTableReader(root);
    assert.equal(reader.table(join(root, 'missing.ts'), options).complete, false);
    assert.equal(reader.table(join(root, 'deep.ts'), options).complete, false);
    assert.deepEqual(plain(reader.table(join(root, 'json.ts'), { ...options, resolveJsonModule: true })),
      { names: [], opaque: ['path:data.json'], complete: true });
    assert.deepEqual(plain(reader.table(join(root, 'nested.ts'), options)), { names: ['kept'], opaque: ['path:deep'], complete: true });
    assert.deepEqual(plain(reader.table(join(root, 'relative.ts'), options)), { names: ['kept'], opaque: ['path:../outside-missing'], complete: true });
    // 절대 지정자는 위치를 옮기지 않고 지정자 그대로 비교한다.
    assert.deepEqual([...reader.table(join(root, 'absolute.ts'), options).opaqueStars.keys()], ['absolute:/definitely/missing/module']);
    assert.deepEqual(plain(reader.table(join(root, 'bare.ts'), options)), { names: [], opaque: ['package:@not-installed/pkg'], complete: true });
    // 소스 쪽 이름 대조를 끄는 표시: 경로 지정자의 해석·읽기 실패는 켜고, 해석하지 못한 bare 지정자는 켜지 않는다.
    assert.deepEqual(['nested.ts', 'relative.ts', 'absolute.ts', 'json.ts', 'bare.ts']
      .map((name) => reader.table(join(root, name), { ...options, resolveJsonModule: true }).unreadPathStars), [true, true, true, true, false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('node_modules·프로젝트 밖 export * 대상은 따라가지 않고 해석한 경로를 표지로 남긴다', () => {
  // pkg의 폐쇄에는 깨진 상대 재내보내기와 4 MiB를 넘는 생성 선언이 있다. 따라갔다면 표를 확정하지 못했을 것이다.
  const root = createProject({
    'inner/node_modules/pkg/package.json': '{ "name": "pkg", "types": "./index.d.ts" }',
    'inner/node_modules/pkg/index.d.ts': 'export * from "./missing";\nexport * from "./huge";\nexport declare const fromPackage: 1;\n',
    'inner/node_modules/pkg/huge.d.ts': `export declare const huge: 1;\n${'/'.repeat(4 * 1024 * 1024 + 1)}\n`,
    'outside/shared.d.ts': 'export declare const shared: 1;\n',
    'inner/src.ts': 'export * from "pkg";\nexport * from "../outside/shared";\nexport const own = 1;\n',
  });
  try {
    const table = new ExportTableReader(join(root, 'inner')).table(join(root, 'inner/src.ts'), options);
    assert.deepEqual(plain(table), { names: ['own'], opaque: ['package:pkg', 'path:../outside/shared'], complete: true });
    // 외부 대상은 양쪽 모두 읽지 않으므로 소스 쪽 이름 대조를 끄지 않는다.
    assert.equal(table.unreadPathStars, false);
    assert.deepEqual([...table.externalTargets].map((path) => relative(root, path).replaceAll('\\', '/')).sort(),
      ['inner/node_modules/pkg/index.d.ts', 'outside/shared.d.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export * 폐쇄가 1,024개 파일을 넘으면 남은 대상을 읽지 않고 위치로만 남긴다', () => {
  const files: Record<string, string> = {};
  for (let index = 0; index <= 1024; index++) files[`chain/m${index}.d.ts`] = `export * from "./m${index + 1}";\nexport declare const v${index}: number;\n`;
  files['chain/m1025.d.ts'] = 'export declare const last: number;\n';
  const root = createProject(files);
  try {
    const table = new ExportTableReader(root).table(join(root, 'chain/m0.d.ts'), options);
    assert.equal(table.complete, true);
    assert.equal(table.names.has('v1023'), true);
    assert.equal(table.names.has('v1024'), false);
    assert.deepEqual(plain(table).opaque, ['path:m1024']);
    assert.equal(table.unreadPathStars, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 판정 테스트용 표의 선택 항목이다. */
interface TableParts {
  readonly directory?: string;
  readonly starKeys?: readonly string[];
  readonly opaque?: Readonly<Record<string, string | undefined>>;
  readonly externals?: readonly string[];
  readonly complete?: boolean;
  readonly includesJavaScript?: boolean;
  readonly unreadPathStars?: boolean;
}

/** 판정 테스트용 이름 표를 만든다. */
function table(names: readonly string[], parts: TableParts = {}): ExportTable {
  const opaque = Object.entries(parts.opaque ?? {});
  return {
    names: new Set(names), directory: parts.directory ?? '/project/src',
    starKeys: new Set([...(parts.starKeys ?? []), ...opaque.map(([key]) => key)]), opaqueStars: new Map(opaque),
    externalTargets: new Set(parts.externals ?? []), complete: parts.complete ?? true, includesJavaScript: parts.includesJavaScript ?? false,
    unreadPathStars: parts.unreadPathStars ?? false,
  };
}

test('판정: 확정한 선언 이름이 모두 소스에 있을 때만 맞는다', () => {
  assert.equal(declarationExportsCovered(table(['a']), table(['a', 'b'])), true);
  assert.equal(declarationExportsCovered(table([]), table([], { complete: false })), true);
  assert.equal(declarationExportsCovered(table(['a', 'c']), table(['a', 'b'])), false);
  assert.equal(declarationExportsCovered(table(['a'], { complete: false }), table(['a'])), false);
  // 소스 폐쇄에 JavaScript가 있으면 선언 표가 불완전하거나 이름이 달라도 대조하지 않는다.
  assert.equal(declarationExportsCovered(table(['a', 'c'], { complete: false }), table([], { includesJavaScript: true })), true);
  // 선언 쪽 JavaScript 표시는 판정을 너그럽게 하지 않는다(그 재내보내기는 위치로 비교한다).
  assert.equal(declarationExportsCovered(table(['c'], { includesJavaScript: true }), table(['a'])), false);
});

test('판정: 이름을 읽지 않은 선언 export *는 소스의 같은 위치 같은 지정자나 같은 외부 대상이 있을 때만 상쇄한다', () => {
  const declaration = (opaque: Readonly<Record<string, string | undefined>>) => table(['own'], { directory: '/project/dist', opaque });
  // tsc가 복사하지 않은 손으로 쓴 src/types.d.ts: 선언 쪽은 해석하지 못하고 소스 쪽은 해석해 따라갔다.
  assert.equal(declarationExportsCovered(declaration({ 'path:/project/dist/types': undefined }),
    table(['own', 'Options'], { starKeys: ['path:/project/src/types'] })), true);
  assert.equal(declarationExportsCovered(declaration({ 'path:/project/dist/types': undefined }),
    table(['own'], { starKeys: ['path:/project/src/other'] })), false);
  // 같은 상대 위치여야 한다(다른 디렉터리의 같은 지정자 문자열은 다른 모듈이다).
  assert.equal(declarationExportsCovered(declaration({ 'path:/project/dist/nested/types': undefined }),
    table(['own'], { starKeys: ['path:/project/src/types'] })), false);
  assert.equal(declarationExportsCovered(declaration({ 'package:pkg': undefined }), table(['own'], { starKeys: ['package:pkg'] })), true);
  assert.equal(declarationExportsCovered(declaration({ 'package:pkg': undefined }), table(['own'], { starKeys: ['package:other'] })), false);
  // 외부 대상은 지정자가 달라도 같은 파일로 해석했으면 같다.
  const external = '/project/node_modules/pkg/index.d.ts';
  assert.equal(declarationExportsCovered(declaration({ 'package:pkg/index.js': external }),
    table(['own'], { opaque: { 'package:pkg': external }, externals: [external] })), true);
  assert.equal(declarationExportsCovered(declaration({ 'package:pkg/index.js': external }),
    table(['own'], { opaque: { 'package:pkg': '/project/node_modules/pkg/other.d.ts' }, externals: ['/project/node_modules/pkg/other.d.ts'] })), false);
});

test('판정: 소스 쪽에 이름을 읽지 못한 프로젝트 안 export *가 있으면 위치만 비교하고 이름은 대조하지 않는다', () => {
  // 4 MiB를 넘는 생성 소스(또는 체크아웃에 없는 생성 소스)는 소스 쪽에서 읽지 못했고, 4 MiB 안의 그 선언은 선언 쪽에서 따라가 읽었다.
  const declaration = (opaque: Readonly<Record<string, string | undefined>> = {}) =>
    table(['helper', 'generated0'], { directory: '/project/dist', starKeys: ['path:/project/dist/generated'], opaque });
  const unreadSource = table(['helper'], { opaque: { 'path:/project/src/generated': undefined }, unreadPathStars: true });
  assert.equal(declarationExportsCovered(declaration(), unreadSource), true);
  // 위치 비교는 그대로 한다(소스에 없는 재내보내기는 이 소스에서 나온 선언이 아니라는 증거다).
  assert.equal(declarationExportsCovered(declaration({ 'path:/project/dist/stray': undefined }), unreadSource), false);
  // 외부 대상은 양쪽 모두 읽지 않으므로 이름 대조를 끄지 않는다.
  const external = '/project/node_modules/dep/index.d.ts';
  assert.equal(declarationExportsCovered(declaration(), table(['helper'], { opaque: { 'package:dep': external }, externals: [external] })), false);
  // 선언 루트를 읽지 못한 표는 여전히 맞다고 보지 않는다.
  assert.equal(declarationExportsCovered(table([], { complete: false }), unreadSource), false);
});

test('판정: 절대 지정자 위치 키는 outDir↔rootDir로 옮기지 않는다', () => {
  // 선언 루트와 소스 루트의 깊이가 달라도(declarationDir types/esm, rootDir src) 같은 절대 지정자는 같은 재내보내기다.
  const declaration = table(['own'], { directory: '/project/types/esm', opaque: { 'absolute:/shared/types': undefined } });
  assert.equal(declarationExportsCovered(declaration, table(['own'], { starKeys: ['absolute:/shared/types'] })), true);
  assert.equal(declarationExportsCovered(declaration, table(['own'], { starKeys: ['absolute:/shared/other'] })), false);
});

test('판정: 소스와 선언이 똑같이 해석하지 못한 bare export *는 이름 대조를 끄지 않는다', () => {
  // 같은 설정·같은 패키지라 선언 쪽도 "not-installed-dep"를 해석하지 못한다. 설치 여부와 무관하게 덮어쓴 선언의 format을 잡아야 한다.
  const source = table(['helper'], { opaque: { 'package:not-installed-dep': undefined } });
  const declaration = (names: readonly string[]) => table(names, { directory: '/project/dist', opaque: { 'package:not-installed-dep': undefined } });
  assert.equal(declarationExportsCovered(declaration(['helper', 'format']), source), false);
  assert.equal(declarationExportsCovered(declaration(['helper']), source), true);
});
