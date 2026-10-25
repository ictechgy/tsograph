import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { createGraphProgram } from './program.ts';
import { StaticPnp, PNP_LIMITS } from './static-pnp.ts';
import { parseInlinePnp } from './pnp-inline.ts';
import { parsePnpJson } from './pnp-json.ts';
import { readPnpZip } from './pnp-zip.ts';
import { makeZip } from './pnp-testing.test.ts';

const fixture = fileURLToPath(new URL('../../fixtures/pnp/yarn-generated/', import.meta.url));
type RawPackage = { packageLocation: string; packageDependencies: [string, string | [string, string] | null][]; discardFromLookup?: boolean };
type RawManifest = { packageRegistryData: [string | null, [string | null, RawPackage][]][]; fallbackPool: unknown[]; fallbackExclusionList: unknown[]; enableTopLevelFallback: boolean; ignorePatternData: string | null };

/** 실제 Yarn 생성물을 임시 디렉터리에 복사하고 원본 fixture를 보존한다. */
async function withFixture(body: (root: string) => void | Promise<void>, inline = false): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-static-pnp-')));
  try {
    cpSync(fixture, root, { recursive: true });
    writeFileSync(join(root, '.pnp.cjs'), inline ? readFileSync(join(root, 'inline-state.txt')) : 'throw new Error("LOADER_MUST_NOT_EXECUTE");');
    if (inline) rmSync(join(root, '.pnp.data.json'));
    await body(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

function metadata(root: string): RawManifest { return JSON.parse(readFileSync(join(root, '.pnp.data.json'), 'utf8')) as RawManifest; }
function saveMetadata(root: string, raw: RawManifest): void { writeFileSync(join(root, '.pnp.data.json'), JSON.stringify(raw)); }
function client(raw: RawManifest): [string | null, RawPackage] { return raw.packageRegistryData.find(([name]) => name === '@fixture/client')![1].find(([ref]) => ref?.startsWith('virtual:'))!; }

/** ZIP의 선언을 읽었는지 checker의 리터럴 타입으로 확인한다. 단순 fileExists 검사가 아니다. */
function inferred(root: string, path = 'src/main.ts'): { values: Record<string, string>; status: ReturnType<typeof createGraphProgram>['status']; program: ts.Program } {
  const { program, checker, status } = createGraphProgram(root, [join(root, path)]);
  const values: Record<string, string> = {};
  for (const statement of program.getSourceFile(join(root, path))!.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
    values[declaration.name.getText()] = checker.typeToString(checker.getTypeAtLocation(declaration));
  }
  return { values, status, program };
}

for (const inline of [false, true]) test(`실제 Yarn4.18.1 ${inline ? 'RAW_RUNTIME_STATE' : '.pnp.data.json'}·ZIP·virtual peer 타입과 exports subpath를 읽는다`, async () => {
  await withFixture(root => {
    const result = inferred(root);
    assert.deepEqual(result.values, { value: '"zip-peer"', fortyTwo: '42' });
    assert.deepEqual(result.status.pnpIssues, []);
    assert.equal(result.program.getSemanticDiagnostics().length, 0);
    assert.ok(result.program.getSourceFiles().some(source => source.fileName.includes('/__virtual__/') && source.fileName.includes('.zip/')));
    assert.equal(existsSync(join(root, 'PNP_EXECUTED')), false);
  }, inline);
});

test('package alias·전이 ZIP 의존성·소유 설정 paths를 같은 compiler host로 해석한다', async () => {
  await withFixture(root => {
    const raw = metadata(root), [ref, pkg] = client(raw);
    for (const [name, entries] of raw.packageRegistryData) if (name === null || name === 'pnp-positive-fixture') entries[0]![1].packageDependencies.push(['client-alias', ['@fixture/client', ref!]]);
    saveMetadata(root, raw);
    const zipPath = join(root, pkg.packageLocation.replace(/__virtual__\/[^/]+\/0\//u, '').split('.zip/')[0]! + '.zip');
    const files = readPnpZip(readFileSync(zipPath)).files;
    files instanceof Map && files.set('node_modules/@fixture/client/index.d.ts', Buffer.from('import {provider} from "@fixture/provider"; export declare function answer(): typeof provider;'));
    writeFileSync(zipPath, makeZip([...files].map(([name, bytes]) => ({ name, text: bytes.toString() }))));
    writeFileSync(join(root, 'src/main.ts'), 'import {answer} from "client-alias"; import {local} from "alias/local"; export const value = answer(); export const value2 = local;');
    writeFileSync(join(root, 'src/local.ts'), 'export const local = 99 as const;');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], baseUrl: '.', paths: { 'alias/*': ['src/*'] } }, include: ['src'] }));
    assert.deepEqual(inferred(root).values, { value: 'true', value2: '99' });
  });
});

test('import/require 조건은 TypeScript가 선택하고 peer virtual package의 packageId는 합치지 않는다', async () => {
  await withFixture(root => {
    const raw = metadata(root), [ref, pkg] = client(raw);
    const zipPath = join(root, pkg.packageLocation.replace(/__virtual__\/[^/]+\/0\//u, '').split('.zip/')[0]! + '.zip');
    writeFileSync(zipPath, makeZip([{ name: 'node_modules/@fixture/client/package.json', text: JSON.stringify({ name: '@fixture/client', version: '1.0.0', exports: { '.': { import: { types: './import.d.mts' }, require: { types: './require.d.cts' } } } }) },
      { name: 'node_modules/@fixture/client/import.d.mts', text: 'export declare function answer(): "esm";' }, { name: 'node_modules/@fixture/client/require.d.cts', text: 'export declare function answer(): "cjs";' }]));
    writeFileSync(join(root, 'src/use.mts'), 'import {answer} from "@fixture/client"; export const value = answer();');
    writeFileSync(join(root, 'src/use.cts'), 'import {answer} from "@fixture/client"; export const value = answer();');
    writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [], module: 'nodenext', moduleResolution: 'nodenext' }, include: ['src'] }));
    assert.equal(inferred(root, 'src/use.mts').values['value'], '"esm"');
    assert.equal(inferred(root, 'src/use.cts').values['value'], '"cjs"');
    const pnp = new StaticPnp(root), host = ts.sys, options = { moduleResolution: ts.ModuleResolutionKind.Bundler };
    const first = pnp.resolveModule('@fixture/client', join(root, 'src/use.mts'), options, host, ts.ModuleKind.ESNext)!;
    assert.equal(first.packageId, undefined);
    assert.ok(ref!.startsWith('virtual:'));
  });
});

test('불명확한 location·누락 locator·중복 dependency·지원 밖 regexp를 추측하지 않는다', async () => {
  for (const mutate of [
    (raw: RawManifest) => { raw.packageRegistryData.push(['ambiguous', [['workspace:other', { packageLocation: './', packageDependencies: [] }]]]); },
    (raw: RawManifest) => { client(raw)[1].packageDependencies.push(['missing', 'npm:0']); },
    (raw: RawManifest) => { client(raw)[1].packageDependencies.push(client(raw)[1].packageDependencies[0]!); },
    (raw: RawManifest) => { raw.ignorePatternData = '(a+)+$'; },
  ]) await withFixture(root => {
    const raw = metadata(root); mutate(raw); saveMetadata(root, raw);
    const result = inferred(root);
    assert.equal(result.values['value'], 'any');
    assert.ok(result.status.pnpIssues!.length > 0);
  });
});

test('metadata의 경로 밖/global cache·외부 archive symlink·CRC 손상은 정상 간선을 만들지 않는다', async () => {
  await withFixture(root => {
    const raw = metadata(root), pkg = client(raw)[1];
    pkg.packageLocation = '../outside-cache/package.zip/node_modules/@fixture/client/'; saveMetadata(root, raw);
    assert.equal(inferred(root).values['value'], 'any');
    assert.ok(inferred(root).status.pnpIssues?.includes('outside-boundary'));
  });
  await withFixture(root => {
    const raw = metadata(root), pkg = client(raw)[1];
    const path = join(root, pkg.packageLocation.replace(/__virtual__\/[^/]+\/0\//u, '').split('.zip/')[0]! + '.zip');
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-pnp-outside-')));
    try {
      const archive = join(outside, 'outside.zip'); writeFileSync(archive, readFileSync(path)); rmSync(path); symlinkSync(archive, path);
      const result = inferred(root); assert.equal(result.values['value'], 'any'); assert.ok(result.status.pnpIssues?.includes('outside-boundary'));
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  await withFixture(root => {
    const pkg = client(metadata(root))[1], path = join(root, pkg.packageLocation.replace(/__virtual__\/[^/]+\/0\//u, '').split('.zip/')[0]! + '.zip');
    const bytes = readFileSync(path); bytes[50] = bytes[50]! ^ 255; writeFileSync(path, bytes);
    const result = inferred(root); assert.equal(result.values['value'], 'any'); assert.ok(result.status.pnpIssues?.includes('archive-invalid'));
  });
});

test('불완전한 정적 initializer·잘못된 JSON·중복 key·깊이/byte 상한은 실행 없이 거부한다', async () => {
  for (const text of ['const RAW_RUNTIME_STATE = require("evil");', 'let RAW_RUNTIME_STATE = "{}";', 'const RAW_RUNTIME_STATE = "{}", RAW_RUNTIME_STATE = "{}";',
    'const RAW_RUNTIME_STATE = `{${run()}}`;', 'const RAW_RUNTIME_STATE =', 'const raw = "{}";']) assert.throws(() => parseInlinePnp(text));
  for (const text of ['{"a":1,"a":2}', '{"a": {"x":1,"x":2}}', '[[[[['.repeat(10) + '0' + ']]]]]'.repeat(10), '{"a":01}', '[true,false,null,1,]']) assert.throws(() => parsePnpJson(text));
  assert.deepEqual(parsePnpJson('{"a":[true,false,null,-1.25e+2,"\\u1234\\t"]}'), { a: [true, false, null, -125, '\u1234\t'] });
  assert.throws(() => parseInlinePnp('const RAW_RUNTIME_STATE = {"packageRegistryData": []}; RAW_RUNTIME_STATE.packageRegistryData.push("modified");'));
  assert.throws(() => parseInlinePnp('const RAW_RUNTIME_STATE = "{}";\n' + '0;'.repeat(100_001)));
  await withFixture(root => {
    writeFileSync(join(root, '.pnp.data.json'), ' '.repeat(PNP_LIMITS.metadataBytes + 1));
    assert.ok(inferred(root).status.pnpIssues?.includes('metadata-invalid'));
  });
});

test('일반 디렉터리의 virtual package와 직접 접근 가능한 자동 ambient @types도 읽는다', async () => {
  await withFixture(root => {
    const raw = metadata(root), pkg = client(raw)[1];
    pkg.packageLocation = './.yarn/__virtual__/local-peer/0/unplugged/client/node_modules/@fixture/client/';
    const physical = join(root, '.yarn/unplugged/client/node_modules/@fixture/client'); mkdirSync(physical, { recursive: true });
    writeFileSync(join(physical, 'package.json'), '{"name":"@fixture/client","version":"1.0.0","types":"index.d.ts"}');
    writeFileSync(join(physical, 'index.d.ts'), 'export declare function answer(): "unplugged";');
    writeFileSync(join(root, 'src/main.ts'), 'import {answer} from "@fixture/client"; export const value = answer();');
    saveMetadata(root, raw);
    assert.equal(inferred(root).values['value'], '"unplugged"');
    const types = join(root, 'types/ambient'); mkdirSync(types, { recursive: true });
    writeFileSync(join(types, 'package.json'), '{"name":"@types/ambient-fixture","version":"1.0.0","types":"index.d.ts"}');
    writeFileSync(join(types, 'index.d.ts'), 'declare const ambientAnswer: 7;');
    raw.packageRegistryData.push(['@types/ambient-fixture', [['npm:1', { packageLocation: './types/ambient/', packageDependencies: [] }]]]);
    for (const [name, entries] of raw.packageRegistryData) if (name === null || name === 'pnp-positive-fixture') entries[0]![1].packageDependencies.push(['@types/ambient-fixture', 'npm:1']);
    saveMetadata(root, raw);
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"module":"esnext"},"include":["src"]}');
    writeFileSync(join(root, 'src/main.ts'), 'export const value = ambientAnswer;');
    assert.equal(inferred(root).values['value'], '7');
  });
});

test('명시 fallback·missing peer·exclusion은 다른 locator로 우회하지 않는다', async () => {
  await withFixture(root => {
    const raw = metadata(root), [ref] = client(raw);
    for (const [name, entries] of raw.packageRegistryData) if (name === null || name === 'pnp-positive-fixture') entries[0]![1].packageDependencies = entries[0]![1].packageDependencies.filter(([name]) => name !== '@fixture/client');
    raw.fallbackPool = [['@fixture/client', ref]];
    raw.fallbackExclusionList = [];
    saveMetadata(root, raw);
    assert.equal(inferred(root).values['value'], '"zip-peer"');
    raw.fallbackExclusionList = [['pnp-positive-fixture', ['workspace:.']]];
    saveMetadata(root, raw);
    assert.equal(inferred(root).values['value'], 'any');
    raw.fallbackExclusionList = [];
    raw.enableTopLevelFallback = false;
    saveMetadata(root, raw);
    assert.equal(inferred(root).values['value'], 'any');
  });
});

test('archive 수 예산은 전이 해석 전체에 적용하고 이후 패키지를 unknown으로 보존한다', async () => {
  await withFixture(root => {
    const raw = metadata(root), dependencies: [string, string][] = [];
    for (let index = 0; index <= PNP_LIMITS.archives; index++) {
      const name = `pkg${index}`, ref = 'npm:1'; dependencies.push([name, ref]);
      raw.packageRegistryData.push([name, [[ref, { packageLocation: `./.yarn/cache/${name}.zip/node_modules/${name}/`, packageDependencies: [] }]]]);
      writeFileSync(join(root, `.yarn/cache/${name}.zip`), makeZip([{ name: `node_modules/${name}/index.d.ts`, text: 'export declare const value: 1;' }]));
    }
    for (const [name, entries] of raw.packageRegistryData) if (name === null || name === 'pnp-positive-fixture') entries[0]![1].packageDependencies = dependencies;
    saveMetadata(root, raw);
    writeFileSync(join(root, 'src/main.ts'), dependencies.map(([name], index) => `import {value as v${index}} from "${name}"; export const result${index} = v${index};`).join('\n'));
    const result = inferred(root);
    assert.equal(result.values['result0'], '1');
    assert.equal(result.values[`result${PNP_LIMITS.archives}`], 'any');
    assert.ok(result.status.pnpIssues?.includes('archive-budget'));
  });
});

test('virtual depth가 바깥 directory로 사상돼도 host의 목록 함수를 호출하지 않는다', async () => {
  await withFixture(root => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-pnp-list-outside-')));
    try {
      const pnp = new StaticPnp(root), calls: string[] = [];
      const host = pnp.wrapHost({ fileExists: () => false, readFile: () => undefined,
        getDirectories: (path: string) => { calls.push(path); return ['private-marker']; } });
      const virtual = join(root, '.yarn/__virtual__/hash/2', outside.slice(dirname(outside).length + 1));
      assert.deepEqual(host.getDirectories!(virtual), []);
      assert.deepEqual(calls, []);
      assert.ok(pnp.issues.includes('outside-boundary'));
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

test('선택한 archive가 손상돼도 실제 node_modules의 다른 버전으로 대체하지 않는다', async () => {
  await withFixture(root => {
    const raw = metadata(root), pkg = client(raw)[1];
    const selected = join(root, pkg.packageLocation.replace(/__virtual__\/[^/]+\/0\//u, '').split('.zip/')[0]! + '.zip');
    writeFileSync(selected, 'invalid ZIP');
    const rival = join(root, 'node_modules/@fixture/client'); mkdirSync(rival, { recursive: true });
    writeFileSync(join(rival, 'package.json'), '{"name":"@fixture/client","version":"99.0.0","types":"index.d.ts"}');
    writeFileSync(join(rival, 'index.d.ts'), 'export declare function answer(): "WRONG_VERSION";');
    const result = inferred(root);
    assert.equal(result.values['value'], 'any');
    assert.ok(result.status.pnpIssues?.includes('locator-mismatch'));
    assert.equal(result.program.getSourceFiles().some(source => source.fileName.startsWith(rival)), false);
  });
});

test('명시 local typeRoots와 triple-slash types는 PnP 의존성 목록으로 지우지 않는다', async () => {
  await withFixture(root => {
    const types = join(root, 'types/local-env'); mkdirSync(types, { recursive: true });
    writeFileSync(join(types, 'index.d.ts'), 'declare const customEnvironment: "local-types";');
    writeFileSync(join(root, 'tsconfig.json'), '{"compilerOptions":{"types":["local-env"],"typeRoots":["./types"]},"include":["src"]}');
    writeFileSync(join(root, 'src/main.ts'), '/// <reference types="local-env" />\nexport const value = customEnvironment;');
    const result = inferred(root);
    assert.equal(result.values['value'], '"local-types"');
    assert.deepEqual(result.status.pnpIssues, []);
  });
});

test('metadata 마지막 symlink는 플랫폼 open flag에 기대지 않고 물리 경계 검사 뒤 거부한다', async () => {
  await withFixture(root => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-pnp-meta-outside-')));
    try {
      const target = join(outside, 'metadata.json'); writeFileSync(target, readFileSync(join(root, '.pnp.data.json')));
      rmSync(join(root, '.pnp.data.json')); symlinkSync(target, join(root, '.pnp.data.json'));
      const result = inferred(root);
      assert.equal(result.values['value'], 'any');
      assert.ok(result.status.pnpIssues?.includes('outside-boundary'));
      assert.ok(result.status.pnpIssues?.includes('metadata-invalid'));
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});

test('조상 node_modules directory를 탐침만 한 것은 유효한 정적 PnP의 입력 실패가 아니다', async () => {
  await withFixture(root => {
    mkdirSync(join(root, 'node_modules'));
    const nested = join(root, 'nested'); cpSync(fixture, nested, { recursive: true });
    const result = inferred(nested);
    assert.equal(result.values['value'], '"zip-peer"');
    assert.deepEqual(result.status.pnpIssues, []);
  });
});
