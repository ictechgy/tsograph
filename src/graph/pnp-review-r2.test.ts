import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { createGraphProgram, createGraphPrograms } from './program.ts';
import { readPnpZip } from './pnp-zip.ts';
import { makeZip } from './pnp-testing.test.ts';

const fixture = fileURLToPath(new URL('../../fixtures/pnp/yarn-generated/', import.meta.url));
type Data = { packageLocation: string; packageDependencies: [string, string | null][] };
type Manifest = { packageRegistryData: [string | null, [string | null, Data][]][]; fallbackPool: unknown[]; fallbackExclusionList: unknown[]; enableTopLevelFallback: boolean; ignorePatternData: string | null };

/** r1과 같은 실제 Yarn 생성물을 복사해 각 리뷰 finding을 독립 검증한다. */
async function withFixture(run: (root: string, raw: Manifest) => void | Promise<void>): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-pnp-review-r2-')));
  try { cpSync(fixture, root, { recursive: true }); await run(root, JSON.parse(readFileSync(join(root, '.pnp.data.json'), 'utf8')) as Manifest); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function valueType(root: string): string {
  const { program, checker } = createGraphProgram(root, [join(root, 'src/main.ts')]);
  const statements = program.getSourceFile(join(root, 'src/main.ts'))!.statements.filter(ts.isVariableStatement);
  const declaration = statements.flatMap(statement => [...statement.declarationList.declarations]).find(declaration => declaration.name.getText() === 'value')!;
  return checker.typeToString(checker.getTypeAtLocation(declaration));
}

function selectedClient(raw: Manifest) { return raw.packageRegistryData.find(([name]) => name === '@fixture/client')![1].find(([reference]) => reference?.startsWith('virtual:'))!; }
function selectedArchive(root: string, data: Data): string { return join(root, data.packageLocation.replace(/__virtual__\/[^/]+\/0\//u, '').split('.zip/')[0]! + '.zip'); }

test('선택된 ZIP 삭제는 조상 directory 탐침과 구분해 명시적 PnP 불완전으로 남긴다', async () => {
  await withFixture(async (root, raw) => {
    rmSync(selectedArchive(root, selectedClient(raw)[1]));
    const { status } = createGraphProgram(root, [join(root, 'src/main.ts')]);
    assert.ok(status.pnpIssues?.includes('input-unreadable'));
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.limitations.some(line => line.startsWith('pnp-dependencies:')));
    assert.ok(graph.limitationsByMode.bound.some(line => line.startsWith('pnp-dependencies:')));
  });
});

test('top-level fallback의 명시 null peer를 fallbackPool의 다른 locator로 대체하지 않는다', async () => {
  await withFixture((root, raw) => {
    const [reference] = selectedClient(raw);
    for (const [name, entries] of raw.packageRegistryData) if (name === null || name === 'pnp-positive-fixture') {
      entries[0]![1].packageDependencies = entries[0]![1].packageDependencies.map(([name, ref]) => [name, name === '@fixture/client' ? null : ref]);
    }
    raw.fallbackExclusionList = []; raw.fallbackPool = [['@fixture/client', reference]]; raw.enableTopLevelFallback = true;
    writeFileSync(join(root, '.pnp.data.json'), JSON.stringify(raw));
    assert.equal(valueType(root), 'any');
  });
});

test('불완전/지원 밖 PnP metadata도 명시 local paths·baseUrl의 별칭을 없애지 않는다', async () => {
  for (const mode of ['invalid', 'unsupported-ignore']) await withFixture((root, raw) => {
    writeFileSync(join(root, 'src/main.ts'), 'import {local} from "alias/local"; export const value = local;');
    writeFileSync(join(root, 'src/local.ts'), 'export const local = 17 as const;');
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"types":[],"baseUrl":".","paths":{"alias/*":["src/*"]}},"include":["src"]}');
    raw.ignorePatternData = '(a+)+$';
    writeFileSync(join(root, '.pnp.data.json'), mode === 'invalid' ? '{invalid' : JSON.stringify(raw));
    assert.equal(valueType(root), '17', mode);
    const { status } = createGraphProgram(root, [join(root, 'src/main.ts'), join(root, 'src/local.ts')]);
    assert.ok(status.pnpIssues!.length > 0);
  });
});

test('같은 semantic options의 두 앱도 PnP global augmentation의 source universe를 공유하지 않는다', async () => {
  await withFixture((root, raw) => {
    const [reference, client] = selectedClient(raw), archive = selectedArchive(root, client);
    const files = new Map(readPnpZip(readFileSync(archive)).files);
    files.set('node_modules/@fixture/client/index.d.ts', Buffer.from('export {}; declare global { function pnpGlobal(): void; }'));
    writeFileSync(archive, makeZip([...files].map(([name, bytes]) => ({ name, text: bytes.toString() }))));
    raw.packageRegistryData.push(['app-a', [['workspace:apps/a', { packageLocation: './apps/a/', packageDependencies: [['@fixture/client', reference!]] }]]],
      ['app-b', [['workspace:apps/b', { packageLocation: './apps/b/', packageDependencies: [] }]]]);
    writeFileSync(join(root, '.pnp.data.json'), JSON.stringify(raw));
    for (const app of ['a', 'b']) {
      mkdirSync(join(root, `apps/${app}/src`), { recursive: true });
      writeFileSync(join(root, `apps/${app}/tsconfig.json`), '{"compilerOptions":{"types":[],"lib":[],"module":"esnext","moduleResolution":"bundler"},"include":["src"]}');
      writeFileSync(join(root, `apps/${app}/src/main.ts`), `${app === 'a' ? 'import "@fixture/client";' : ''} export function ${app}() { pnpGlobal(); }`);
    }
    writeFileSync(join(root, 'tsconfig.json'), '{"files":[],"references":[{"path":"apps/a"},{"path":"apps/b"}]}');
    const a = join(root, 'apps/a/src/main.ts'), b = join(root, 'apps/b/src/main.ts');
    const programs = [...createGraphPrograms(root, [a, b])];
    const hasGlobal = (file: string): boolean => {
      const context = programs.find(context => context.ownedSources?.has(file))!;
      const source = context.program.getSourceFile(file)!;
      let found = false;
      const visit = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === 'pnpGlobal') found ||= context.checker.getSymbolAtLocation(node) !== undefined; ts.forEachChild(node, visit); };
      visit(source); return found;
    };
    assert.equal(hasGlobal(a), true, 'positive control: importing app sees its package augmentation');
    assert.equal(hasGlobal(b), false, 'negative control: other app must not acquire a global from PnP');
    assert.equal(programs.length, 2);
  });
});

test('BOM으로 시작하는 ZIP 이름은 byte identity를 보존해 Cf 경로로 거부한다', () => {
  assert.throws(() => readPnpZip(makeZip([{ name: '\uFEFFa', text: 'hello' }])));
});

test('중앙 BOM 이름과 BOM 없는 로컬 이름을 같은 ZIP 항목으로 받아들이지 않는다', () => {
  const original = makeZip([{ name: '\uFEFFa', text: 'hello' }]);
  const central = original.readUInt32LE(original.length - 6);
  const modified = Buffer.concat([original.subarray(0, 30), original.subarray(33)]);
  modified.writeUInt16LE(1, 26);
  modified.writeUInt32LE(central - 3, modified.length - 6);
  assert.throws(() => readPnpZip(modified));
});
