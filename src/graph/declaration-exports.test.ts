/**
 * 선언 산출물 역매핑이 쓰는 export 이름 표가 tsc 선언 emit의 이름을 소스와 같은 방식으로 읽는지, 확정하지 못한 표를 맞는다고
 * 보지 않는지 검증한다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

/** 이름 표를 비교하기 쉬운 정렬 배열로 바꾼다. */
function plain(table: ExportTable) {
  return { names: [...table.names].sort(), unresolvedPackages: [...table.unresolvedPackages].sort(), complete: table.complete };
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
    assert.deepEqual(plain(new ExportTableReader().table(join(root, 'a.ts'), options)), {
      names: ['Alias', 'C', 'E', 'I', 'M', 'N', 'Renamed', 'T', 'TypeOnly', 'd', 'default', 'first', 'ns', 'string export', 'third'],
      unresolvedPackages: [], complete: true,
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
    const reader = new ExportTableReader();
    assert.deepEqual(plain(reader.table(join(root, 'index.d.ts'), options)),
      { names: ['Shape', 'a', 'cycle', 'default'], unresolvedPackages: [], complete: true });
    assert.deepEqual(plain(reader.table(join(root, 'equals.d.ts'), options)), { names: [], unresolvedPackages: [], complete: true });
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
    const reader = new ExportTableReader();
    assert.deepEqual(plain(reader.table(join(root, 'esm/index.d.ts'), nodeNext)), { names: ['a', 'own'], unresolvedPackages: [], complete: true });
    assert.equal(reader.table(join(root, 'esm/extensionless.d.ts'), nodeNext).complete, false);
    assert.deepEqual(plain(reader.table(join(root, 'cjs/extensionless.d.ts'), nodeNext)), { names: ['a'], unresolvedPackages: [], complete: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('JavaScript의 CommonJS 내보내기와 최상위 JSDoc 타입 이름을 모은다', () => {
  const root = createProject({
    'cjs.cjs': [
      'exports.a = 1;', 'exports["b"] = 2;', 'module.exports.c = 3;', 'module.exports["d"] = 4;', 'exports[name] = 5;',
      'module.exports = exports = { e, "f": 1, 2: 2, g() {}, [computed]: 1, ...spread };', 'Object.defineProperty(exports, "h", {});',
      'Object.defineProperty(module.exports, "i", {});', 'Object.defineProperty(other, "j", {});', 'Object.defineProperty(exports, key, {});',
      'Reflect.defineProperty(exports, "k", {});', 'Object.freeze(exports);', 'defineProperty(exports, "l");', 'other.m = 1;', 'module.other = 1;',
      'exports = 1;', 'call();', '/** @typedef {number} Count */', '/** @callback Done */',
    ].join('\n'),
    'assign.mjs': 'module.exports = function main() {};\n',
    'jsx.jsx': 'export const view = 1;\n',
    'tsx.tsx': 'export const view = 1;\n',
  });
  try {
    const reader = new ExportTableReader();
    assert.deepEqual(plain(reader.table(join(root, 'cjs.cjs'), options)), {
      names: ['2', 'Count', 'Done', 'a', 'b', 'c', 'd', 'e', 'export=', 'f', 'g', 'h', 'i'], unresolvedPackages: [], complete: true,
    });
    assert.deepEqual(plain(reader.table(join(root, 'assign.mjs'), options)).names, ['export=']);
    assert.deepEqual(plain(reader.table(join(root, 'jsx.jsx'), options)).names, ['view']);
    assert.deepEqual(plain(reader.table(join(root, 'tsx.tsx'), options)).names, ['view']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('TypeScript 파일의 CommonJS 모양 할당과 JSDoc은 export가 아니다', () => {
  const root = createProject({ 'a.ts': '/** @typedef {number} Count */\nexports.a = 1;\nmodule.exports = { b: 1 };\n' });
  try {
    assert.deepEqual(plain(new ExportTableReader().table(join(root, 'a.ts'), options)), { names: [], unresolvedPackages: [], complete: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('읽지 못한 파일, 스크립트가 아닌 대상, 구문 깊이 초과, 해석하지 못한 상대·절대 export *는 표를 확정하지 않는다', () => {
  const root = createProject({
    'json.ts': 'export * from "./data.json";\n',
    'data.json': '{}',
    'deep.ts': `export const deep = ${'('.repeat(500)}1${')'.repeat(500)};\n`,
    'relative.ts': 'export * from "../outside-missing";\nexport const kept = 1;\n',
    'absolute.ts': 'export * from "/definitely/missing/module";\n',
    'bare.ts': 'export * from "@not-installed/pkg";\nexport * from "@not-installed/pkg";\n',
  });
  try {
    const reader = new ExportTableReader();
    const optionsWithJson = { ...options, resolveJsonModule: true };
    assert.equal(reader.table(join(root, 'missing.ts'), options).complete, false);
    assert.equal(reader.table(join(root, 'json.ts'), optionsWithJson).complete, false);
    assert.equal(reader.table(join(root, 'deep.ts'), options).complete, false);
    assert.deepEqual(plain(reader.table(join(root, 'relative.ts'), options)), { names: ['kept'], unresolvedPackages: [], complete: false });
    assert.equal(reader.table(join(root, 'absolute.ts'), options).complete, false);
    assert.deepEqual(plain(reader.table(join(root, 'bare.ts'), options)), { names: [], unresolvedPackages: ['@not-installed/pkg'], complete: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('export * 폐쇄가 1,024개 파일을 넘으면 표를 확정하지 않는다', () => {
  const files: Record<string, string> = {};
  for (let index = 0; index <= 1024; index++) files[`chain/m${index}.d.ts`] = `export * from "./m${index + 1}";\nexport declare const v${index}: number;\n`;
  files['chain/m1025.d.ts'] = 'export declare const last: number;\n';
  const root = createProject(files);
  try {
    const table = new ExportTableReader().table(join(root, 'chain/m0.d.ts'), options);
    assert.equal(table.complete, false);
    assert.equal(table.names.has('v1023'), true);
    assert.equal(table.names.has('last'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('판정: 확정한 선언 이름이 모두 소스에 있고 선언의 미해결 bare export *를 소스도 가질 때만 맞는다', () => {
  const table = (names: readonly string[], unresolvedPackages: readonly string[] = [], complete = true): ExportTable =>
    ({ names: new Set(names), unresolvedPackages: new Set(unresolvedPackages), complete });
  assert.equal(declarationExportsCovered(table(['a']), table(['a', 'b'])), true);
  assert.equal(declarationExportsCovered(table([]), table([], [], false)), true);
  assert.equal(declarationExportsCovered(table(['a', 'c']), table(['a', 'b'])), false);
  assert.equal(declarationExportsCovered(table(['a'], [], false), table(['a'])), false);
  assert.equal(declarationExportsCovered(table(['a'], ['pkg']), table(['a'], ['pkg'])), true);
  assert.equal(declarationExportsCovered(table(['a'], ['pkg']), table(['a'], ['other'])), false);
});
