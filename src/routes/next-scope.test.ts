import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { runRoutesCommand } from '../cli/routes-command.ts';
import { buildCallGraph } from '../graph/build-graph.ts';
import { withFrozenInputs } from '../graph/frozen-inputs.ts';

/** 같은 실제 CLI 경계를 써서 설정과 사실·한계를 함께 확인한다. */
async function routes(root: string) {
  const result = await runRoutesCommand(['--role', 'server', '--project', root], { fileSystem: createNodeFileSystem(), toolVersion: 'test', now: () => new Date(0) });
  assert.equal(result.exitCode, 0, result.standardError);
  return JSON.parse(result.standardOutput) as { facts: { channel: string; method: string }[]; limitations: string[] };
}

/** 실제 파일 시스템의 합성 입력이며 Next·로더를 실행하지 않는다. */
async function fixture(files: Record<string, string>, run: (root: string) => Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-next-scope-')));
  try {
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source);
    }
    await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('Next convention은 config 진입 범위를 지키고 제외 경로의 import 의존 노드는 유지한다', async () => {
  await fixture({
    'package.json': '{"dependencies":{"next":"16.2.7"}}',
    'tsconfig.json': '{"compilerOptions":{"types":[],"noLib":true,"allowJs":true,"jsx":"preserve"},"include":["src/app/api/kept"]}',
    'src/app/api/kept/route.ts': 'import {GET as excluded} from "../excluded/route"; import Page from "../../page"; export function GET(){ Page(); return excluded(); }',
    'src/app/api/kept/route.js': 'export function POST(){}',
    'src/app/api/excluded/route.ts': 'export function GET(){return "dependency";}',
    'src/app/page.tsx': 'export default function Page(){return null;}',
    'pages/api/legacy.ts': 'export default function legacy(){}',
    '.pnp.cjs': 'throw new Error("loader must not execute");',
  }, async root => {
    const result = await runRoutesCommand(['--role', 'server', '--project', root], { fileSystem: createNodeFileSystem(), toolVersion: 'test', now: () => new Date(0) });
    assert.equal(result.exitCode, 0, result.standardError);
    const doc = JSON.parse(result.standardOutput);
    assert.deepEqual(doc.facts.map((f: { channel: string; method: string }) => [f.channel, f.method]), [['/api/kept', 'GET']]);
    assert.ok(doc.limitations.some((l: string) => l.includes('Next convention') && l.includes('runtime')));
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const excluded = graph.nodes.find(n => n.id === 'src/app/api/excluded/route.ts#GET');
    const page = graph.nodes.find(n => n.location.path === 'src/app/page.tsx' && n.kind === 'function');
    assert.ok(excluded && page, JSON.stringify(graph.nodes.map(n => [n.id, n.kind])));
    assert.ok(!excluded.entries?.includes('route-handler'));
    assert.ok(!page.entries?.includes('page'));
    assert.ok(graph.edges.some(e => e.from === 'src/app/api/kept/route.ts#GET' && e.to === excluded.id));
    assert.ok(graph.limitations.some(l => l.includes('excluded runtime routes are not assessed')));
    assert.ok(!existsSync(join(root, 'LOADER-MUST-NOT-RUN')));
  });
});

test('Next 진입 범위는 extends·references·명시 빈 files를 따르며 제외를 런타임 부재로 보지 않는다', async () => {
  await fixture({
    'package.json': '{"dependencies":{"next":"16.2.7"}}',
    'base.json': '{"compilerOptions":{"types":[],"noLib":true},"include":["app"],"exclude":["app/excluded"]}',
    'tsconfig.json': '{"extends":"./base.json"}',
    'app/kept/route.ts': 'export function GET(){}',
    'app/excluded/route.ts': 'export function GET(){}',
  }, async root => {
    assert.deepEqual((await routes(root)).facts.map(f => f.channel), ['/kept']);
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"types":[],"noLib":true},"files":[]}');
    const empty = await routes(root);
    assert.equal(empty.facts.length, 0);
    assert.ok(empty.limitations.some(l => l.includes('2 Next convention') && l.includes('runtime')));
    writeFileSync(join(root, 'tsconfig.json'), '{"files":[],"references":[{"path":"./selected.json"}]}');
    writeFileSync(join(root, 'selected.json'), '{"files":["app/kept/route.ts"]}');
    assert.deepEqual((await routes(root)).facts.map(f => f.channel), ['/kept']);
  });
});

test('설정 없는 Next TS/JS 형제와 잘못된 설정의 fallback 범위도 한계를 남긴다', async () => {
  await fixture({
    'app/items/route.ts': 'export function GET(){}',
    'app/items/route.js': 'export function POST(){}',
  }, async root => {
    const defaultScope = await routes(root);
    assert.deepEqual(defaultScope.facts.map(f => f.method), ['GET']);
    assert.ok(defaultScope.limitations.some(l => l.includes('TypeScript sibling')));
    writeFileSync(join(root, 'tsconfig.json'), '{');
    const fallback = await routes(root);
    assert.deepEqual(fallback.facts, defaultScope.facts);
    assert.ok(fallback.limitations.some(l => l.includes('could not be parsed')));
  });
});

test('Next 범위 읽기도 캡처 밖 extends 입력을 동결된 것으로 취급하지 않는다', async () => {
  await fixture({
    'outside.json': '{"compilerOptions":{"noLib":true,"types":[]}}',
    'capture/tsconfig.json': '{"extends":"../outside.json"}',
    'capture/app/items/route.ts': 'export function GET(){}',
  }, async root => {
    const capture = join(root, 'capture');
    await assert.rejects(withFrozenInputs(capture, () => routes(capture)), /outside the captured root/u);
  });
});
