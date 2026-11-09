/**
 * 내장 TypeScript가 모르는 compiler 옵션 값이 있어도 그 옵션만 버리고 `paths`·`include`는 유지하는지 검증한다.
 * 예전에는 오류 하나로 설정 전체를 기본값으로 바꿔 경로 별칭 간선이 사라지고 "parse 실패"로 알렸다.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import type { CallGraph } from './graph-model.ts';
import { createGraphProgram } from './program.ts';

/** 별칭 import로 util을 부르는 합성 프로젝트를 만든다. */
function createAliasProject(compilerOptions: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-option-values-')));
  const files: Record<string, string> = {
    'tsconfig.json': `{ "compilerOptions": { "strict": true, "types": [], "module": "esnext", "moduleResolution": "bundler", "baseUrl": ".", "paths": { "@/*": ["./src/*"] }, ${compilerOptions} }, "include": ["src"] }`,
    'src/lib/util.ts': 'export function util() { return 1; }\n',
    'src/main.ts': 'import { util } from "@/lib/util";\nexport function main() { return util(); }\n',
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** 별칭 간선이 있는지 본다. */
function hasAliasEdge(graph: CallGraph): boolean {
  return graph.edges.some((edge) => edge.from === 'src/main.ts#main' && edge.to === 'src/lib/util.ts#util' && edge.evidence === 'direct');
}

test('모르는 target·lib 값과 모르는 옵션은 그 옵션만 버리고 paths 별칭을 유지한다', async () => {
  const root = createAliasProject('"target": "es2099", "lib": ["es2099", "dom"], "someFutureOption": true, "noUncheckedSideEffectImports": "yes"');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(hasAliasEdge(graph), graph.limitations.join('\n'));
    assert.ok(!graph.limitations.some((line) => line.includes('could not be parsed')), graph.limitations.join('\n'));
    const line = graph.limitations.find((candidate) => candidate.startsWith('graph-config: compiler-options: '));
    assert.ok(line !== undefined, graph.limitations.join('\n'));
    assert.ok(line.includes(`TypeScript ${ts.version}`));
    assert.ok(line.includes('lib, noUncheckedSideEffectImports, target'), line);
    assert.ok(line.includes('1 unknown option(s)'), line);
    // 사용자가 적은 모르는 옵션 이름은 입력 원문이라 싣지 않는다.
    assert.ok(!line.includes('someFutureOption'), line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('옵션이 아닌 설정 최상위 필드(include)의 형식 오류는 옵션 하나로 국한되지 않아 예전처럼 설정을 읽지 못한 것으로 본다', async () => {
  const root = createAliasProject('"target": "es2022"');
  // 옵션이 아닌 설정 최상위 필드(`include`)의 형식 오류다. JSON 자체는 올바르다.
  writeFileSync(join(root, 'tsconfig.json'), '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } }, "include": 3 }');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.limitations.some((line) => line.startsWith('graph-config: tsconfig.json could not be parsed')), graph.limitations.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('지원하는 옵션 값만 쓴 설정은 compiler-options limitation을 싣지 않는다', async () => {
  const root = createAliasProject('"target": "es2022", "lib": ["es2022"]');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(hasAliasEdge(graph));
    assert.ok(!graph.limitations.some((line) => line.includes('compiler-options:')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('버린 target·lib 값은 ESNext로 근사한다(빠지면 ES5 기본 lib로 내장 타입이 사라진다)', () => {
  const root = createAliasProject('"target": "es2099", "lib": ["es2099", "es2022"]');
  try {
    const { program } = createGraphProgram(root, [join(root, 'src/main.ts'), join(root, 'src/lib/util.ts')]);
    const options = program.getCompilerOptions();
    assert.equal(options.target, ts.ScriptTarget.ESNext);
    assert.ok(options.lib?.includes('lib.esnext.d.ts'), JSON.stringify(options.lib));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** `exports`로 소스를 노출하는 workspace 패키지와, 그 하위 경로를 import하는 앱을 만든다. */
function createExportsProject(compilerOptions: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-option-resolution-')));
  const files: Record<string, string> = {
    'package.json': '{ "name": "root", "private": true }',
    'tsconfig.json': `{ "compilerOptions": { "strict": true, "types": [], "lib": ["es2022"], "target": "es2022", ${compilerOptions} }, "include": ["apps", "packages"] }`,
    'packages/lib/package.json': '{ "name": "@acme/lib", "private": true, "exports": { "./feature": "./src/feature.ts" } }',
    'packages/lib/src/feature.ts': 'export function feature() { return "new"; }\n',
    'packages/lib/feature.ts': 'export function feature() { return "legacy"; }\n',
    'apps/web/src/main.ts': "import { feature } from '@acme/lib/feature';\nexport function main() { return feature(); }\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  mkdirSync(join(root, 'node_modules/@acme'), { recursive: true });
  symlinkSync(join(root, 'packages/lib'), join(root, 'node_modules/@acme/lib'), 'dir');
  return root;
}

test('버린 module·moduleResolution 값은 도구 기본 해석으로 근사하고 프로그램을 불완전으로 둔다', async () => {
  const root = createExportsProject('"module": "node99", "moduleResolution": "node99"');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.edges.some((edge) => edge.from === 'apps/web/src/main.ts#main' && edge.to === 'packages/lib/src/feature.ts#feature'
      && edge.evidence === 'direct'), JSON.stringify(graph.edges));
    assert.ok(graph.limitations.some((line) => line.startsWith('effect-inventory: incomplete')), graph.limitations.join('\n'));
    const line = graph.limitations.find((candidate) => candidate.startsWith('graph-config: compiler-options: '));
    assert.ok(line?.includes('module, moduleResolution'), line);
    assert.ok(line?.includes('approximated'), line);
    assert.ok(!line?.includes('baseUrl'), line);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('남은 쪽이 Node 해석이면 버린 짝 옵션도 NodeNext로 맞춘다', () => {
  for (const [options, module, resolution] of [
    ['"module": "nodenext", "moduleResolution": "node99"', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    ['"module": "node99", "moduleResolution": "node16"', ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.Node16],
    ['"module": "node99", "moduleResolution": "bundler"', ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const root = createExportsProject(options);
    try {
      const { program } = createGraphProgram(root, [join(root, 'apps/web/src/main.ts')]);
      assert.equal(program.getCompilerOptions().module, module, options);
      assert.equal(program.getCompilerOptions().moduleResolution, resolution, options);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('baseUrl 값을 버리면 한계 문구가 baseUrl을 유지했다고 말하지 않고 해석을 불완전으로 둔다', async () => {
  const root = createAliasProject('"target": "es2022"');
  writeFileSync(join(root, 'tsconfig.json'),
    '{ "compilerOptions": { "strict": true, "types": [], "module": "esnext", "moduleResolution": "bundler", "baseUrl": 1, "paths": { "@/*": ["./src/*"] } }, "include": ["src"] }');
  try {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const line = graph.limitations.find((candidate) => candidate.startsWith('graph-config: compiler-options: '));
    assert.ok(line?.includes('(baseUrl)'), line);
    assert.ok(!line?.includes('paths, baseUrl and include were kept'), line);
    assert.ok(graph.limitations.some((candidate) => candidate.startsWith('effect-inventory: incomplete')), graph.limitations.join('\n'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
