/**
 * 임시 프로젝트로 드문 해석 경로를 검증한다: super·데코레이터·태그 템플릿·리터럴 원소 접근·축약 속성·
 * 기본 내보내기 식·필드 별칭·인라인 서버 액션·Pages Router 페이지·instrumentation.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { templateMatches } from './entry-points.ts';
import type { CallGraph } from './graph-model.ts';

/**
 * 임시 프로젝트의 그래프를 만든다.
 *
 * @param files 상대 경로 → 내용
 * @returns 그래프
 */
async function graphOf(files: Record<string, string>): Promise<CallGraph> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-resolution-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return await buildCallGraph(root, createNodeFileSystem());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 간선을 문자열로 줄인다.
 *
 * @param graph 그래프
 * @returns `from -> to kinds` 목록
 */
function edges(graph: CallGraph): string[] {
  return graph.edges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kinds.join(',')}`);
}

test('super·데코레이터·태그 템플릿·원소 접근·축약 속성·기본 내보내기 식·필드 별칭', async () => {
  const graph = await graphOf({
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "experimentalDecorators": true, "module": "esnext", "moduleResolution": "bundler" } }',
    'src/base.ts': [
      'export class Base { constructor(readonly name: string) {} }',
      'export class Child extends Base { constructor() { super("child"); } }',
      'export function sealed(target: unknown) { return target; }',
      '@sealed export class Marked {}',
      'export function sql(parts: TemplateStringsArray) { return parts.join(""); }',
      'export const query = () => sql`SELECT 1`;',
      'export const tools = { run() { return 1; } };',
      'export const runIt = () => tools["run"]();',
      'function helper() { return 2; }',
      'export const bag = { helper };',
      'export const viaBag = () => bag.helper();',
      'export class Holder { readonly fn = helper; call() { return this.fn(); } }',
      'const ident = helper;',
      'export default ident;',
    ].join('\n'),
    'src/wrapped.ts': 'function wrap<T>(value: T): T { return value; }\nexport default wrap(() => 3);\n',
    'src/use.ts': [
      'import value, { Child } from "./base";',
      'import wrapped from "./wrapped";',
      'export function main() { new Child(); value(); return wrapped(); }',
      'export function action() { "use server"; return main(); }',
    ].join('\n'),
  });
  const lines = edges(graph);
  for (const expected of [
    'src/base.ts#Child.constructor -> src/base.ts#Base.constructor call',
    'src/base.ts#Marked -> src/base.ts#sealed call',
    'src/base.ts#query -> src/base.ts#sql call',
    'src/base.ts#runIt -> src/base.ts#tools.run call',
    'src/base.ts#viaBag -> src/base.ts#helper call',
    'src/base.ts#bag -> src/base.ts#helper reference',
    'src/base.ts#Holder.call -> src/base.ts#helper call',
    'src/use.ts#main -> src/base.ts#Child.constructor new',
    'src/use.ts#main -> src/base.ts#helper call',
    'src/use.ts#main -> src/wrapped.ts#default call',
    'src/wrapped.ts#default -> src/wrapped.ts#wrap call',
  ]) {
    assert.ok(lines.includes(expected), `${expected}\n${lines.join('\n')}`);
  }
  assert.deepEqual(graph.nodes.find((node) => node.id === 'src/use.ts#action')?.entries, ['server-action']);
});

test('콜백·참조는 값 별칭·속성 별칭을 따라가고, 전개 인자도 콜백이다', async () => {
  const graph = await graphOf({
    'src/alias.ts': [
      'function g() { return 1; }',
      'function k() { return 2; }',
      'function m() { return 3; }',
      'declare function register(fn: unknown): void;',
      'declare function emit(...fns: unknown[]): void;',
      'export const h = g;',
      'const obj = { g, k: k, deep: { m } };',
      'const viaProperty = obj.g;',
      'const { k: picked } = obj;',
      'let loop1: unknown = 0;',
      'const cycleA: unknown = cycleB;',
      'const cycleB: unknown = cycleA;',
      'export function wire() {',
      '  register(h);',
      '  register(viaProperty);',
      '  register(obj.k);',
      '  register(picked);',
      '  register(obj.deep.m);',
      '  register(loop1);',
      '  register(cycleA);',
      '  emit(...[m]);',
      '  const local = h;',
      '  return local;',
      '}',
    ].join('\n'),
  });
  const lines = edges(graph).filter((line) => line.startsWith('src/alias.ts#wire '));
  assert.deepEqual(lines, [
    'src/alias.ts#wire -> src/alias.ts#g callback,reference',
    'src/alias.ts#wire -> src/alias.ts#k callback',
    'src/alias.ts#wire -> src/alias.ts#m callback',
  ]);
});

test('Pages Router 페이지·instrumentation·메타데이터 진입점과 cron 템플릿 매칭', async () => {
  const graph = await graphOf({
    'package.json': '{ "dependencies": { "next": "16.2.7" } }',
    'vercel.json': '{ "crons": [{ "path": "/api/jobs/42?x=1" }, { "path": "/api/files/a/b" }, { "schedule": "x" }] }',
    'pages/index.tsx': 'export default function Home() { return null; }\nexport async function getServerSideProps() { return { props: {} }; }\nexport function helper() {}\n',
    'pages/api/jobs/[id].ts': 'export default function job() {}\n',
    'pages/api/files/[...path].ts': 'export default function files() {}\n',
    'instrumentation.ts': 'export function register() {}\nexport function other() {}\n',
    'app/sitemap.ts': 'export default function sitemap() { return []; }\n',
    'app/icon.tsx': 'export default function Icon() { return null; }\n',
  });
  const entries = Object.fromEntries(graph.nodes.filter((node) => node.entries !== undefined).map((node) => [node.id, node.entries!.join(',')]));
  assert.deepEqual(entries, {
    'app/icon.tsx#Icon': 'metadata-route',
    'app/sitemap.ts#sitemap': 'metadata-route',
    'instrumentation.ts#register': 'instrumentation',
    'pages/api/files/[...path].ts#files': 'route-handler,scheduled',
    'pages/api/jobs/[id].ts#job': 'route-handler,scheduled',
    'pages/index.tsx#Home': 'page',
    'pages/index.tsx#getServerSideProps': 'page',
  });
  assert.equal(templateMatches('/api/items/{}.json', '/api/items/a.json'), true);
  assert.equal(templateMatches('/api/items/{}.json', '/api/items/.json'), false);
  assert.equal(templateMatches('/api/items/{}', '/api/items'), false);
  assert.equal(templateMatches('/api/items/', '/api/items'), true);
  assert.equal(templateMatches('/', '/'), true);
  assert.equal(templateMatches('/a', '/a/b'), false);
});
