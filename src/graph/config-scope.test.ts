import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { extractClientRoutes } from '../routes/client/client-routes.ts';
import { extractNavigationRoutes, parseRouterModels } from '../routes/navigation-routes.ts';
import { loadNodeProject } from '../routes/node/node-project.ts';
import { buildCallGraph } from './build-graph.ts';
import { createModuleResolver } from './dispatch.ts';
import { withFrozenInputs } from './frozen-inputs.ts';
import { createGraphProgram } from './program.ts';

/** 저장소 밖 합성 입력만 만들며 소스·로더를 실행하지 않는다. */
async function fixture(files: Record<string, string>, body: (root: string) => void | Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-scope-')));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    await body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const config = (baseUrl: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  compilerOptions: { baseUrl, types: [], noLib: true }, ...extra,
});
const apps = {
  'tsconfig.json': config('./app-a/src'),
  'app-a/tsconfig.json': config('./src'),
  'app-b/tsconfig.json': config('./src'),
  'app-a/src/components/Button.ts': 'export function Button(){ return "A"; }',
  'app-b/src/components/Button.ts': 'export function Button(){ return "B"; }',
  'app-a/src/page.ts': 'import {Button} from "components/Button"; export function PageA(){ return Button(); }',
  'app-b/src/page.ts': 'import {Button} from "components/Button"; export function PageB(){ return Button(); }',
};

test('서로 다른 앱 baseUrl은 소유 앱으로만 직접 연결한다', async () => {
  await fixture(apps, async (root) => {
    for (const selected of [root, join(root, 'app-b')]) {
      const graph = await buildCallGraph(selected, createNodeFileSystem(), selected === root ? {} : { workspace: root });
      const matching = selected === root ? 'app-a' : 'app-b';
      const other = matching === 'app-a' ? 'app-b' : 'app-a';
      assert.ok(graph.edges.some((edge) => edge.from.startsWith(matching + '/src/page.ts#') && edge.to === matching + '/src/components/Button.ts#Button'));
      assert.ok(graph.edges.some((edge) => edge.from.startsWith(other + '/src/page.ts#') && edge.to === other + '/src/components/Button.ts#Button'));
      assert.ok(!graph.edges.some((edge) => edge.from.startsWith(other + '/src/page.ts#') && edge.to === matching + '/src/components/Button.ts#Button'));
      for (const mode of ['direct', 'bound', 'candidates'] as const) assert.ok(!graph.limitationsByMode[mode].some((line) => line.includes('config-conflict:')));
    }
  });
});

test('동일 extends 설정은 충돌로 만들지 않고 보조 module resolver도 충돌 보류를 지킨다', async () => {
  await fixture({ ...apps, 'app-b/tsconfig.json': '{"extends":"../tsconfig.json"}' }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(!graph.limitations.some((line) => line.includes('config-conflict:')));
    assert.ok(graph.edges.some((edge) => edge.from === 'app-b/src/page.ts#PageB' && edge.to === 'app-a/src/components/Button.ts#Button'));
    writeFileSync(join(root, 'app-b/tsconfig.json'), config('./src'));
    const project = loadNodeProject(root);
    const resolver = createModuleResolver(project.program, project.checker);
    assert.equal(project.pathOf(resolver('components/Button', project.files.get('app-b/src/page.ts')!)!.valueDeclaration!.getSourceFile()), 'app-b/src/components/Button.ts');
  });
});

test('project references의 중복 소유권과 누락 설정은 조용히 하나로 선택하지 않는다', async () => {
  await fixture({
    'tsconfig.json': config('.', { files: [], references: [{ path: './a.json' }, { path: './b.json' }] }),
    'a.json': config('./a', { files: ['src/main.ts'] }),
    'b.json': config('./b', { files: ['src/main.ts'] }),
    'src/main.ts': 'import {target} from "target"; export function main(){target();}',
    'a/target.ts': 'export function target(){}',
    'b/target.ts': 'export function target(){}',
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.nodes.some((node) => node.id === 'src/main.ts#main'));
    assert.ok(!graph.edges.some((edge) => edge.from === 'src/main.ts#main'));
    assert.ok(graph.limitations.some((line) => line.includes('config-conflict:')));
    writeFileSync(join(root, 'tsconfig.json'), config('.', { references: [{ path: './missing' }] }));
    const missing = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(missing.limitations.some((line) => line.includes('config-ownership:')));
  });
});

test('include/exclude는 진입 파일에 적용하고 import 의존성은 graph·client·navigation에서 유지한다', async () => {
  await fixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [], noLib: true, allowJs: true }, include: ['src'], exclude: ['src/excluded'] }),
    'src/main.ts': 'import {dep} from "../shared/dep"; import {used} from "./excluded/used"; export function main(){dep();used();fetch("/included");}',
    'src/main.js': 'export function stale(){fetch("/stale");}',
    'src/excluded/unused.ts': 'export function unused(){fetch("/excluded");}',
    'src/excluded/used.ts': 'export function used(){fetch("/dependency");}',
    'shared/dep.ts': 'export function dep(){fetch("/shared");}',
    'vendor/legacy.ts': 'export function legacy(){fetch("/vendor");}',
    '.pnp.cjs': 'require("fs").writeFileSync("LOADER-MUST-NOT-RUN", "bad"); function loader(){fetch("/loader");}',
    'src/factory.ts': 'export function registerRoutes(routes: unknown){}',
    'src/routes.ts': 'import {registerRoutes} from "./factory"; import {Screen} from "../shared/Screen"; registerRoutes([{path:"/yes",screen:Screen}]);',
    'shared/Screen.ts': 'export function Screen(){}',
    'vendor/routes.ts': 'import {registerRoutes} from "../src/factory"; import {Screen} from "../shared/Screen"; registerRoutes([{path:"/no",screen:Screen}]);',
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const paths = new Set(graph.nodes.map((node) => node.location.path));
    assert.ok(paths.has('shared/dep.ts') && paths.has('src/excluded/used.ts'));
    for (const path of ['vendor/legacy.ts', 'src/excluded/unused.ts', 'src/main.js', '.pnp.cjs']) assert.ok(!paths.has(path), path);
    const client = extractClientRoutes(root, undefined, false, 'test', new Date(0));
    assert.deepEqual(client.facts.map((fact) => fact.channel).sort(), ['/dependency', '/included', '/shared']);
    const models = parseRouterModels(JSON.stringify({ format: 'router-models', version: 1, models: [{ factory: { path: 'src/factory.ts', name: 'registerRoutes' }, routesArgument: 0, pathProperty: 'path', screenProperty: 'screen', pathSyntax: 'colon' }] }));
    const navigation = extractNavigationRoutes(root, models, 'test', new Date(0));
    assert.deepEqual(navigation.facts.map((fact) => fact.urlTemplate), ['/yes']);
    for (const output of [graph, client, navigation]) {
      assert.ok(output.limitations.some((line) => line.includes('source-scope:') && line.includes('imported dependencies')));
      assert.ok(output.limitations.some((line) => line.includes('PnP loader')));
      assert.ok(!output.limitations.some((line) => line.includes('unreadable source')));
    }
    assert.ok(!existsSync(join(root, 'LOADER-MUST-NOT-RUN')));
  });
});

test('새 nearest config의 외부 extends도 frozen input 경계를 벗어나지 못한다', async () => {
  await fixture({ 'outside.json': config('.'), 'capture/tsconfig.json': config('.'), 'capture/app/tsconfig.json': '{"extends":"../../outside.json"}', 'capture/app/main.ts': 'export function main(){}' }, async (root) => {
    const capture = join(root, 'capture');
    await assert.rejects(withFrozenInputs(capture, async () => createGraphProgram(capture, [join(capture, 'app/main.ts')])), /outside the captured root/u);
  });
});

test('상속한 include/exclude와 명시 빈 진입 목록은 전체 스캔으로 바뀌지 않는다', async () => {
  await fixture({
    'base.json': JSON.stringify({ compilerOptions: { noLib: true, types: [] }, include: ['src'], exclude: ['src/unused.ts'] }),
    'tsconfig.json': '{"extends":"./base.json"}',
    'src/main.ts': 'export function main(){}',
    'src/unused.ts': 'export function unused(){}',
    'other.ts': 'export function other(){}',
  }, async (root) => {
    assert.deepEqual([...loadNodeProject(root).files.keys()], ['src/main.ts']);
    for (const scope of [{ include: [] }, { files: [] }]) {
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noLib: true, types: [] }, ...scope }));
      const project = loadNodeProject(root);
      assert.equal(project.files.size, 0);
      assert.equal(project.configStatus.configUnreadable, false);
      assert.equal(project.configStatus.excludedSourceRoots, 3);
      assert.equal(project.gaps.unreadableFiles, 0);
    }
  });
});

test('명시 PnP loader와 설정 없는 TS/JS 중복도 소스 진입 파일에서 제외한다', async () => {
  await fixture({
    '.pnp.cjs': 'throw new Error("must never execute");',
    '.pnp.loader.mjs': 'throw new Error("must never execute");',
    'main.ts': 'export function main(){}',
    'main.js': 'export function stale(){}',
    'unrelated.js': 'export function plainJavaScript(){}',
  }, async (root) => {
    const unconfigured = loadNodeProject(root);
    assert.deepEqual([...unconfigured.files.keys()], ['main.ts', 'unrelated.js']);
    assert.equal(unconfigured.configStatus.skippedLoaderEntries, 2);
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ files: ['.pnp.cjs'], compilerOptions: { allowJs: true, noLib: true, types: [] } }));
    const explicit = loadNodeProject(root);
    assert.equal(explicit.files.size, 0);
    assert.equal(explicit.configStatus.excludedConfigRoots, 1);
  });
});

test('동일 reference 옵션과 reference 순환은 유지하고 128 설정 예산 초과는 명시한다', async () => {
  await fixture({
    'tsconfig.json': config('.', { files: [], references: [{ path: './other.json' }] }),
    'other.json': config('.', { files: ['main.ts', 'target.ts'], references: [{ path: './tsconfig.json' }] }),
    'main.ts': 'import {target} from "target"; export function main(){target();}',
    'target.ts': 'export function target(){}',
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.edges.some((edge) => edge.from === 'main.ts#main' && edge.to === 'target.ts#target'));
    assert.ok(!graph.limitations.some((line) => line.includes('config-conflict:') || line.includes('config-ownership:')));
    const refs = Array.from({ length: 129 }, (_, index) => ({ path: `./config-${index}.json` }));
    for (const ref of refs) writeFileSync(join(root, ref.path), config('.', { files: ['main.ts'] }));
    writeFileSync(join(root, 'tsconfig.json'), config('.', { references: refs }));
    const limited = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(limited.limitations.some((line) => line.includes('128-config budget')));
    assert.ok(!limited.edges.some((edge) => edge.from === 'main.ts#main'));
  });
});

test('제외 경로에서 import했지만 파싱 상한에 걸린 소스는 의도한 제외로 숨기지 않는다', async () => {
  await fixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [], noLib: true }, files: ['src/main.ts'] }),
    'src/main.ts': 'import {deep} from "../shared/deep"; export function main(){return deep;}',
    'shared/deep.ts': `export const deep = ${'('.repeat(3_000)}1${')'.repeat(3_000)};`,
  }, async (root) => {
    const project = loadNodeProject(root);
    assert.equal(project.gaps.unreadableFiles, 0);
    assert.deepEqual(project.deeplyNestedFiles, ['shared/deep.ts']);
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.limitations.some((line) => line.startsWith('parse-errors:') && line.includes('shared/deep.ts')));
    assert.ok(!graph.limitations.some((line) => line.startsWith('unreadable-sources:')));
  });
});
