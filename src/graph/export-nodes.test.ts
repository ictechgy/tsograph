/**
 * 선언이 아닌 내보내기의 export 노드가 대상을 해석하지 못했을 때 그 이유를 사실대로 세는지 검증한다.
 * `type` 없이 다시 내보낸 interface·type alias·값 없는 namespace는 런타임 선언이 없어 `alias` 간선을 낼 대상이 없다.
 * 이들을 `unresolved-export-aliases:`(해석하지 못한 대상)로 세면 rxjs 7.8.1처럼 31개 중 30개가 타입인 그래프가 해석 공백을
 * 부풀려 알리므로, 노드는 그대로 두고 `type-only-export-aliases:`로 따로 센다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import type { CallGraph } from './graph-model.ts';
import { createGraphPrograms } from './program.ts';

const fileSystem = createNodeFileSystem();

/** 전역 타입 탐색을 끈 공통 tsconfig다. */
const tsconfig = JSON.stringify({
  compilerOptions: { strict: true, types: [], lib: ['es2022'], module: 'esnext', moduleResolution: 'bundler', target: 'es2022' },
  include: ['src'],
});

/** 값·타입 선언을 고루 담은 모듈이다. 재내보내기 대상의 종류마다 하나씩 둔다. */
const declarations = [
  'export interface Config { a: number }',
  "export type Mode = 'a' | 'b';",
  'export namespace TypeOnly { export interface Inner { b: number } }',
  'export enum Kind { A, B }',
  'export namespace Values { export const x = 1; }',
  'export function run(): number { return 1; }',
  'export class Box {}',
  'export interface Merged { x: number }',
  'export const Merged = { make(): number { return 1; } };',
].join('\n');

/**
 * 임시 프로젝트를 쓰고 그래프를 만든 뒤 지운다.
 *
 * @param files 상대 경로 → 내용
 * @returns 그래프
 */
async function graphOf(files: Readonly<Record<string, string>>): Promise<CallGraph> {
  return (await projectOf(files)).graph;
}

/**
 * 임시 프로젝트를 쓰고 그래프와 type-checking 문맥 수를 구한 뒤 지운다.
 *
 * @param files 상대 경로 → 내용
 * @returns 그래프와 문맥 수
 */
async function projectOf(files: Readonly<Record<string, string>>): Promise<{ graph: CallGraph; contexts: number }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-export-nodes-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const sources = Object.keys(files).filter((path) => /\.[jt]s$/u.test(path)).map((path) => join(root, path));
    const contexts = [...createGraphPrograms(root, sources)].length;
    return { graph: await buildCallGraph(root, fileSystem), contexts };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 접두사로 시작하는 limitation 줄의 첫 숫자다.
 *
 * @param lines limitation 목록
 * @param prefix 접두사(콜론 포함)
 * @returns 숫자, 줄이 없으면 undefined
 */
function countOf(lines: readonly string[], prefix: string): number | undefined {
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? undefined : Number(/^\S+ (\d+) /u.exec(line)?.[1]);
}

/**
 * export 노드 id와, 그 노드에서 나가는 `alias` 간선의 대상이다.
 *
 * @param graph 그래프
 * @returns export 노드 id → alias 대상 목록
 */
function exportAliases(graph: CallGraph): Map<string, string[]> {
  const result = new Map(graph.nodes.filter((node) => node.kind === 'export').map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) if (edge.kinds.includes('alias')) result.get(edge.from)?.push(edge.to);
  return result;
}

test('type 없이 다시 내보낸 interface·type alias·값 없는 namespace는 해석 실패가 아니라 타입 전용으로 센다', async () => {
  const graph = await graphOf({
    'package.json': '{ "name": "app", "private": true }',
    'tsconfig.json': tsconfig,
    'src/types.ts': declarations,
    // barrel을 한 번 더 거쳐도 별칭을 끝까지 따라가 대상의 종류를 본다.
    'src/barrel.ts': "export { Config, Kind } from './types';\n",
    'src/index.ts': [
      "export { Config, Mode, TypeOnly, Kind, Values, run, Box, Merged } from './types';",
      "export { Config as Renamed } from './types';",
      "import { Mode as LocalMode, Kind as LocalKind, Nope } from './types';",
      'export { LocalMode, LocalKind, Nope };',
      "export { Config as BarrelConfig, Kind as BarrelKind } from './barrel';",
      "export { Missing } from './absent';",
    ].join('\n'),
  });
  const aliases = exportAliases(graph);
  // 노드는 예전처럼 모두 남는다(그래프 노드·routes symbol.usr가 바뀌지 않는다).
  const unlinked = ['Config', 'Mode', 'TypeOnly', 'Renamed', 'LocalMode', 'BarrelConfig', 'Kind', 'Values', 'LocalKind', 'BarrelKind', 'Nope', 'Missing'];
  for (const name of unlinked) {
    assert.deepEqual(aliases.get(`src/index.ts#${name}`), [], `${name}는 alias 대상이 없는 export 노드다`);
  }
  assert.deepEqual(aliases.get('src/index.ts#run'), ['src/types.ts#run']);
  assert.deepEqual(aliases.get('src/index.ts#Box'), ['src/types.ts#Box']);
  assert.equal(aliases.get('src/index.ts#Merged')?.length, 1, 'interface와 합쳐진 값은 값 쪽으로 잇는다');
  // 값(enum·값 있는 namespace — 지역 import·barrel을 거쳐도)과 찾지 못한 이름·모듈은 여전히 해석하지 못한 대상이다.
  // barrel 안의 export 노드(src/barrel.ts#Config·#Kind)도 각각 타입 전용·해석 실패로 센다.
  assert.equal(countOf(graph.limitations, 'unresolved-export-aliases:'), 7);
  assert.equal(countOf(graph.limitations, 'type-only-export-aliases:'), 7);
  for (const mode of ['direct', 'bound', 'candidates'] as const) {
    assert.equal(countOf(graph.limitationsByMode[mode], 'unresolved-export-aliases:'), 7, mode);
    assert.equal(countOf(graph.limitationsByMode[mode], 'type-only-export-aliases:'), 7, mode);
  }
  assert.ok(graph.limitations.includes('type-only-export-aliases: 7 export node(s) re-export names that resolve only to types '
    + '(interfaces, type aliases, or namespaces without values), which have no runtime declaration; they have no alias edge'));
});

test('타입만 다시 내보내면 unresolved-export-aliases를 내지 않고, 기본 내보내기 interface도 타입 전용이다', async () => {
  const graph = await graphOf({
    'package.json': '{ "name": "app", "private": true }',
    'tsconfig.json': tsconfig,
    'src/types.ts': 'export default interface Shape { kind: string }\nexport interface Options { verbose: boolean }\n',
    'src/index.ts': "export { default, Options } from './types';\n",
  });
  assert.deepEqual([...exportAliases(graph).keys()].sort(), ['src/index.ts#Options', 'src/index.ts#default']);
  assert.equal(countOf(graph.limitations, 'unresolved-export-aliases:'), undefined);
  assert.equal(countOf(graph.limitations, 'type-only-export-aliases:'), 2);
});

test('JavaScript의 JSDoc typedef를 다시 내보내도 런타임 값이 없으므로 타입 전용으로 센다', async () => {
  // JavaScript 파일은 TypeScript가 재내보내기를 지우지 않지만, typedef 이름에는 어느 경우에도 런타임 선언이 없다.
  const graph = await graphOf({
    'package.json': '{ "name": "app", "private": true }',
    'jsconfig.json': JSON.stringify({ compilerOptions: { checkJs: true, types: [], lib: ['es2022'], module: 'esnext', moduleResolution: 'bundler' },
      include: ['src'] }),
    'src/types.js': '/** @typedef {{ id: number }} Row */\nexport function load() { return 1; }\n',
    'src/index.js': "export { load } from './types.js';\nimport { Row } from './types.js';\nexport { Row };\n",
  });
  const aliases = exportAliases(graph);
  assert.deepEqual(aliases.get('src/index.js#load'), ['src/types.js#load']);
  assert.deepEqual(aliases.get('src/index.js#Row'), []);
  assert.equal(countOf(graph.limitations, 'unresolved-export-aliases:'), undefined);
  assert.equal(countOf(graph.limitations, 'type-only-export-aliases:'), 1);
});

test('type-checking 문맥이 나뉘어도 타입 전용 export 노드 수는 문맥 표시 없이 한 줄로 합친다', async () => {
  const files: Record<string, string> = { 'package.json': '{ "name": "app", "private": true }' };
  for (const [index, lib] of [['es2020'], ['es2022', 'dom']].entries()) {
    files[`p${index}/tsconfig.json`] = JSON.stringify({ compilerOptions: { strict: true, types: [], lib, module: 'esnext', moduleResolution: 'bundler' } });
    files[`p${index}/types.ts`] = 'export interface Config { a: number }\nexport enum Kind { A }\n';
    files[`p${index}/index.ts`] = "export { Config, Kind } from './types';\n";
  }
  const { graph, contexts } = await projectOf(files);
  assert.equal(contexts, 2, 'lib가 다른 두 설정은 문맥이 나뉜다');
  const typeOnly = graph.limitations.filter((line) => line.startsWith('type-only-export-aliases:'));
  assert.deepEqual(typeOnly.map((line) => countOf([line], 'type-only-export-aliases:')), [2]);
  assert.ok(!typeOnly[0]!.includes('compiler-context:'));
  assert.equal(countOf(graph.limitations, 'unresolved-export-aliases:'), 2);
});
