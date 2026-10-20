import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { ambientTypesFreeConfig, linkToDevZero, makeFifo } from '../cli/testing.test.ts';
import { compilerConfigGaps } from '../routes/node/node-project.ts';
import { MAX_SOURCE_BYTES } from '../schema/project-reader.ts';
import { SYNTAX_DEPTH_CAUSE } from '../schema/syntax-depth.ts';
import { buildCallGraph } from './build-graph.ts';
import { MAX_GRAPH_CONFIG_BYTES, readBoundedConfigText, readBoundedFileBytes } from './bounded-config-reader.ts';
import { GraphProjectInputError, createGraphProgram } from './program.ts';
import { SdkSourceFileCache, sdkSourceFileCache } from './sdk-source-file-cache.ts';

/**
 * 임시 프로젝트를 만들고 콜백 뒤 지운다.
 *
 * @param files 상대 경로 → 내용
 * @param body 콜백
 */
async function withProject(
  files: Record<string, string | Uint8Array>,
  body: (root: string) => Promise<void> | void,
): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-graph-')));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    await body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('tsconfig·jsconfig·설정 없음·깨진 설정을 구분한다', async () => {
  await withProject({ 'tsconfig.json': '{ "compilerOptions": { "strict": true }, "include": ["src"] }', 'src/a.ts': 'export const a = 1;' }, (root) => {
    const { status, program } = createGraphProgram(root, []);
    assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false });
    assert.equal(program.getCompilerOptions().allowJs, true);
    assert.equal(program.getCompilerOptions().noEmit, true);
  });
  await withProject({ 'jsconfig.json': '{ "compilerOptions": { "incremental": true } }', 'a.js': '' }, (root) => {
    const { status, program } = createGraphProgram(root, [join(root, 'a.js')]);
    assert.deepEqual(status, { configName: 'jsconfig.json', configUnreadable: false });
    assert.equal(program.getCompilerOptions().incremental, undefined);
  });
  await withProject({ 'a.ts': '' }, (root) => {
    assert.deepEqual(createGraphProgram(root, []).status, { configName: undefined, configUnreadable: false });
  });
  await withProject({ 'tsconfig.json': '{ "compilerOptions": ', 'a.ts': '' }, (root) => {
    assert.deepEqual(createGraphProgram(root, []).status, { configName: 'tsconfig.json', configUnreadable: true });
  });
  await withProject({ 'tsconfig.json': '{ "compilerOptions": { "module": "nonsense" } }' }, (root) => {
    assert.deepEqual(createGraphProgram(root, []).status, { configName: 'tsconfig.json', configUnreadable: true });
  });
});

test('explicit compiler config resolves aliases from its own directory for a selected source root', async () => {
  await withProject({
    'config/build.json': JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '@lib/*': ['lib/*'] } } }),
    'lib/api.ts': 'export function request() {}',
    'app/main.ts': "import { request } from '@lib/api'; export function load() { request(); }",
  }, (root) => {
    const result = createGraphProgram(join(root, 'app'), [join(root, 'app/main.ts')], ts.createProgram, join(root, 'config/build.json'));
    assert.equal(result.status.configUnreadable, false);
    assert.ok(result.program.getSourceFile(join(root, 'lib/api.ts')));
    assert.equal(result.program.getCompilerOptions().baseUrl, root);
  });
});

test('explicit missing config fails instead of silently selecting different compiler options', async () => {
  await withProject({ 'a.ts': '' }, (root) => {
    assert.throws(
      () => createGraphProgram(root, [], ts.createProgram, join(root, 'missing.json')),
      (error) => error instanceof GraphProjectInputError
        && error.code === 'config-file'
        && !error.message.includes(root),
    );
  });
});

test('bounded config reader accepts the exact byte cap and rejects one byte over it', async () => {
  await withProject({
    'exact.json': Buffer.from('12345678'),
    'over.json': Buffer.from('123456789'),
  }, (root) => {
    assert.deepEqual(readBoundedConfigText(join(root, 'exact.json'), 8), { ok: true, text: '12345678' });
    assert.deepEqual(readBoundedConfigText(join(root, 'over.json'), 8), { ok: false, reason: 'too-large' });
  });
});

test('explicit config enforces the final byte count at exact cap and cap plus one', async () => {
  const prefix = Buffer.from('{ "compilerOptions": { "strict": true } }');
  const exact = Buffer.concat([prefix, Buffer.alloc(MAX_GRAPH_CONFIG_BYTES - prefix.byteLength, 0x20)]);
  const over = Buffer.concat([exact, Buffer.from(' ')]);
  await withProject({ 'exact.json': exact, 'over.json': over, 'a.ts': '' }, (root) => {
    const accepted = createGraphProgram(root, [], ts.createProgram, join(root, 'exact.json'));
    assert.equal(accepted.program.getCompilerOptions().strict, true);
    assert.throws(
      () => createGraphProgram(root, [], ts.createProgram, join(root, 'over.json')),
      (error) => error instanceof GraphProjectInputError && error.code === 'config-file',
    );
  });
});

test('explicit config bounds missing and oversized extends while automatic config keeps fallback', async () => {
  const oversized = Buffer.alloc(MAX_GRAPH_CONFIG_BYTES + 1, 0x20);
  await withProject({
    'tsconfig.json': JSON.stringify({ extends: './oversized.json' }),
    'oversized.json': oversized,
  }, (root) => {
    assert.throws(
      () => createGraphProgram(root, [], ts.createProgram, join(root, 'tsconfig.json')),
      (error) => error instanceof GraphProjectInputError
        && error.code === 'config-file'
        && !error.message.includes(root),
    );
    assert.deepEqual(createGraphProgram(root, []).status, {
      configName: 'tsconfig.json',
      configUnreadable: true,
    });
  });
  await withProject({
    'tsconfig.json': JSON.stringify({ extends: './missing.json' }),
  }, (root) => {
    assert.throws(
      () => createGraphProgram(root, [], ts.createProgram, join(root, 'tsconfig.json')),
      (error) => error instanceof GraphProjectInputError && error.code === 'config-file',
    );
  });
});

test('bounded config reader preserves TypeScript BOM encodings', async () => {
  const json = '{ "compilerOptions": { "strict": true } }';
  const utf16le = Buffer.from(json, 'utf16le');
  const utf16be = Buffer.from(utf16le);
  for (let index = 0; index < utf16be.length; index += 2) {
    [utf16be[index], utf16be[index + 1]] = [utf16be[index + 1]!, utf16be[index]!];
  }
  await withProject({
    'utf8.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]),
    'utf16le.json': Buffer.concat([Buffer.from([0xff, 0xfe]), utf16le]),
    'utf16be.json': Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be]),
  }, (root) => {
    for (const name of ['utf8.json', 'utf16le.json', 'utf16be.json']) {
      const result = createGraphProgram(root, [], ts.createProgram, join(root, name));
      assert.equal(result.program.getCompilerOptions().strict, true, name);
    }
  });
});

test('bounded reader는 없는 파일만 missing으로 두고 FIFO·장치·디렉터리는 기다리지 않고 unreadable로 본다', {
  skip: process.platform === 'win32',
}, async () => {
  await withProject({ 'directory/x.json': '{}' }, (root) => {
    makeFifo(join(root, 'pipe.json'));
    linkToDevZero(join(root, 'zero.json'));
    assert.deepEqual(readBoundedConfigText(join(root, 'missing.json')), { ok: false, reason: 'missing' });
    assert.deepEqual(readBoundedFileBytes(join(root, 'missing.json'), 8), { ok: false, reason: 'missing' });
    for (const name of ['pipe.json', 'zero.json', 'directory']) {
      assert.deepEqual(readBoundedFileBytes(join(root, name), 8), { ok: false, reason: 'unreadable' }, name);
      assert.deepEqual(readBoundedConfigText(join(root, name), 8), { ok: false, reason: 'unreadable' }, name);
    }
  });
});

test('bounded bytes reader는 상한을 지키고 BOM을 지우지 않으며 상한 인자를 검증한다', async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]);
  await withProject({ 'bom.json': bom, 'over.json': Buffer.from('123456789') }, (root) => {
    const read = readBoundedFileBytes(join(root, 'bom.json'), 8);
    assert.equal(read.ok && read.bytes.equals(bom), true);
    assert.deepEqual(readBoundedFileBytes(join(root, 'over.json'), 8), { ok: false, reason: 'too-large' });
    assert.throws(() => readBoundedFileBytes(join(root, 'bom.json'), -1), RangeError);
  });
});

test('noFollow는 마지막 symlink를 열지 않고 기본값은 일반 파일 대상을 따라간다', {
  skip: !constants.O_NOFOLLOW,
}, async () => {
  await withProject({ 'target.json': '{}' }, (root) => {
    symlinkSync(join(root, 'target.json'), join(root, 'link.json'));
    symlinkSync(join(root, 'absent.json'), join(root, 'dangling.json'));
    assert.deepEqual(readBoundedConfigText(join(root, 'link.json')), { ok: true, text: '{}' });
    assert.deepEqual(readBoundedConfigText(join(root, 'link.json'), 8, { noFollow: true }), { ok: false, reason: 'unreadable' });
    assert.deepEqual(readBoundedFileBytes(join(root, 'dangling.json'), 8), { ok: false, reason: 'missing' });
    assert.deepEqual(readBoundedFileBytes(join(root, 'dangling.json'), 8, { noFollow: true }), { ok: false, reason: 'unreadable' });
    assert.deepEqual(readBoundedFileBytes(join(root, 'target.json'), 8, { noFollow: true }), { ok: true, bytes: Buffer.from('{}') });
  });
});

test('graph 모듈 해석기도 compiler host와 같은 상한으로 package.json을 읽는다', async (t) => {
  await withProject({
    // 저장소 @types/node를 읽지 않는 설정이다(검사와 무관한 Program 비용).
    'tsconfig.json': ambientTypesFreeConfig,
    'src/main.ts': 'import { value } from "./lib";\nexport function read() { return value; }\n',
    'src/lib/package.json': `{"main":"other.ts"}${' '.repeat(MAX_SOURCE_BYTES)}`,
    'src/lib/index.ts': 'export const value = 1;\n',
    'src/lib/other.ts': 'export const value = 2;\n',
  }, async (root) => {
    const originalReadFileSync = fs.readFileSync;
    const unboundedManifestReads: string[] = [];
    t.mock.method(fs, 'readFileSync', function readFileSync(this: unknown, ...arguments_: Parameters<typeof fs.readFileSync>) {
      if (String(arguments_[0]).endsWith('/src/lib/package.json')) unboundedManifestReads.push(String(arguments_[0]));
      return originalReadFileSync.apply(this, arguments_);
    });
    syncBuiltinESMExports();
    try {
      const graph = await buildCallGraph(root, createNodeFileSystem());
      assert.deepEqual(unboundedManifestReads, []);
      assert.ok(graph.limitations.some((line) => line.startsWith('oversized-compiler-inputs:')));
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test('workspace roots connect imported package declarations with workspace-relative ids', async () => {
  await withProject({
    'apps/web/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '../..', paths: { '@lib/*': ['packages/lib/*'] } } }),
    'apps/web/main.ts': "import { request } from '@lib/api'; export function load() { request(); }",
    'packages/lib/api.ts': 'export function request() {}',
    'node_modules/other/a.ts': 'export function ignored() {}',
  }, async (root) => {
    const result = await buildCallGraph(join(root, 'apps/web'), createNodeFileSystem(), { workspace: root });
    assert.ok(result.nodes.some((node) => node.id === 'packages/lib/api.ts#request'));
    assert.ok(result.edges.some((edge) => edge.from === 'apps/web/main.ts#load' && edge.to === 'packages/lib/api.ts#request' && edge.evidence === 'direct'));
    assert.ok(result.nodes.every((node) => !node.id.includes('node_modules')));
    assert.ok(result.limitations.some((line) => line.startsWith('workspace-config:')));
  });
});

test('workspace keeps automatic config fallback and rejects a project outside its owned root', async () => {
  await withProject({ 'apps/web/tsconfig.json': '{', 'apps/web/main.ts': 'export function load() {}', 'other/a.ts': '' }, async (root) => {
    const result = await buildCallGraph(join(root, 'apps/web'), createNodeFileSystem(), { workspace: root });
    assert.ok(result.limitations.some((line) => line.startsWith('graph-config:')));
    await assert.rejects(buildCallGraph(join(root, 'apps/web'), createNodeFileSystem(), { workspace: join(root, 'other') }), /workspace must/);
  });
});

test('PnP-only project gets a specific limitation without executing its loader', async () => {
  await withProject({ '.pnp.cjs': 'throw new Error("must never run");', 'src/a.ts': 'export function a() {}' }, async (root) => {
    const result = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(result.limitations.some((line) => line.startsWith('pnp-dependencies:')));
    assert.ok(result.limitationsByMode.bound.some((line) => line.startsWith('pnp-dependencies:')));
  });
});

test('기본 lib JSDoc 최적화도 프로젝트·외부 declaration의 JSDoc과 기본 타입을 보존한다', async () => {
  await withProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs: true, moduleResolution: 'Bundler', target: 'ES2022' }, include: ['src'] }),
    'src/global.d.ts': 'interface Date { projectEpoch?: number; }\n',
    'src/main.ts': `import type { Vendor } from 'vendor';
import type { VendorLib } from 'vendor/lib.es5';
/** @deprecated project declaration */
export function project(value: string): string { return value; }
export const arrayValue: Array<Date> = [];
export const dateValue: Date = new Date();
export const mapValue: Map<string, Date> = new Map();
export const vendorValue: Vendor = { dates: [] };
export const vendorLibValue: VendorLib = { value: new Date() };
`,
    'src/js-api.js': `/**
 * @typedef {{ when?: Date, values?: Map<string, Date> }} JsPayload
 */
/**
 * @param {JsPayload} payload
 * @returns {Array<Date>}
 */
export function jsProject(payload) {
  return payload.values ? Array.from(payload.values.values()) : payload.when ? [payload.when] : [];
}
`,
    'node_modules/vendor/index.d.ts': `/** @deprecated third-party declaration */
export interface Vendor { dates: Array<Date>; }
`,
    'node_modules/vendor/lib.es5.d.ts': `/** @deprecated third-party lib-like declaration */
export interface VendorLib { value: Date; }
`,
  }, (root) => {
    const actual = createGraphProgram(root, []);
    const pristineHost = ts.createCompilerHost(actual.program.getCompilerOptions(), true);
    const pristine = ts.createProgram({ rootNames: actual.program.getRootFileNames(), options: actual.program.getCompilerOptions(), host: pristineHost });
    const summarize = (program: ts.Program) => {
      const checker = program.getTypeChecker();
      const project = program.getSourceFile(join(root, 'src/main.ts'))!;
      const vendor = program.getSourceFile(join(root, 'node_modules/vendor/index.d.ts'))!;
      const vendorLib = program.getSourceFile(join(root, 'node_modules/vendor/lib.es5.d.ts'))!;
      const js = program.getSourceFile(join(root, 'src/js-api.js'))!;
      const projectFunction = project.statements.find((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'project');
      const vendorInterface = vendor.statements.find((node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === 'Vendor');
      const vendorLibInterface = vendorLib.statements.find((node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === 'VendorLib');
      const jsFunction = js.statements.find((node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === 'jsProject');
      const sdk = program.getSourceFiles().find((file) => file.fileName.endsWith('/lib.es5.d.ts'))!;
      const sdkString = sdk.statements.find((node): node is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(node) && node.name.text === 'String');
      const sdkSubstr = sdkString?.members.find((node): node is ts.MethodSignature =>
        ts.isMethodSignature(node) && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === 'substr');
      const jsParameter = jsFunction?.parameters[0];
      const jsReturnType = jsFunction === undefined ? undefined : checker.getSignatureFromDeclaration(jsFunction)?.getReturnType();
      const types = new Map(project.statements.flatMap((statement) => {
        if (!ts.isVariableStatement(statement)) return [];
        return statement.declarationList.declarations.flatMap((declaration) =>
          ts.isIdentifier(declaration.name) ? [[declaration.name.text, checker.typeToString(checker.getTypeAtLocation(declaration.name))] as const] : []);
      }));
      const dateDeclaration = project.statements.flatMap((statement) => {
        if (!ts.isVariableStatement(statement)) return [];
        return statement.declarationList.declarations.filter((declaration): declaration is ts.VariableDeclaration & { name: ts.Identifier } =>
          ts.isIdentifier(declaration.name) && declaration.name.text === 'dateValue');
      })[0]!;
      const dateProperty = checker.getTypeAtLocation(dateDeclaration.name).getProperty('projectEpoch');
      return {
        projectTags: ts.getJSDocTags(projectFunction!).map((tag) => tag.tagName.text),
        vendorTags: ts.getJSDocTags(vendorInterface!).map((tag) => tag.tagName.text),
        vendorLibTags: ts.getJSDocTags(vendorLibInterface!).map((tag) => tag.tagName.text),
        jsTags: ts.getJSDocTags(jsFunction!).map((tag) => tag.tagName.text),
        sdkSubstrTags: ts.getJSDocTags(sdkSubstr!).map((tag) => tag.tagName.text),
        jsParameterType: checker.typeToString(checker.getTypeAtLocation(jsParameter!)),
        jsReturnType: jsReturnType === undefined ? undefined : checker.typeToString(jsReturnType),
        dateEpochType: dateProperty === undefined ? undefined : checker.typeToString(checker.getTypeOfSymbolAtLocation(dateProperty, dateDeclaration.name)),
        dateEpochOptional: dateProperty !== undefined && (dateProperty.flags & ts.SymbolFlags.Optional) !== 0,
        types: Object.fromEntries(['arrayValue', 'dateValue', 'mapValue', 'vendorValue', 'vendorLibValue'].map((name) => [name, types.get(name)])),
      };
    };
    const expected = summarize(pristine);
    const observed = summarize(actual.program);
    const { sdkSubstrTags: _expectedSdkSubstrTags, ...expectedBehavior } = expected;
    const { sdkSubstrTags: _observedSdkSubstrTags, ...observedBehavior } = observed;
    assert.deepEqual(observedBehavior, expectedBehavior);
    assert.deepEqual(observed.projectTags, ['deprecated']);
    assert.deepEqual(observed.vendorTags, ['deprecated']);
    assert.deepEqual(observed.vendorLibTags, ['deprecated']);
    assert.deepEqual(observed.jsTags, ['param', 'returns']);
    assert.ok(expected.sdkSubstrTags.includes('deprecated'));
    assert.deepEqual(observed.sdkSubstrTags, []);
    assert.match(observed.jsParameterType!, /JsPayload/u);
    assert.match(observed.jsReturnType!, /Date/u);
    assert.match(observed.dateEpochType!, /number/u);
    assert.equal(observed.dateEpochOptional, true);
    assert.match(observed.types.arrayValue!, /Date/u);
    assert.match(observed.types.dateValue!, /Date/u);
    assert.match(observed.types.mapValue!, /Map/u);
  });
});

test('작은 프로젝트: 깨진 설정·구문 오류·과대 파일·깨진 vercel.json·CommonJS를 limitation으로 알린다', async () => {
  await withProject({
    'tsconfig.json': '{ "compilerOptions": ',
    'vercel.json': '{ crons: nope',
    'src/a.ts': 'export function f( {\n',
    'src/big.ts': `export const big = "${'x'.repeat(4 * 1024 * 1024)}";\n`,
    'src/c.js': 'module.exports = function handler() { helper(); };\nfunction helper() {}\nclass K { static s = helper(); [Symbol.iterator]() { helper(); } }\n',
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.deepEqual(graph.limitations.filter((line) => !line.startsWith('unresolved-calls')), [
      'graph-config: tsconfig.json could not be parsed; default compiler options were used, so path aliases may not resolve',
      'parse-errors: 1 source file(s) have syntax errors; their calls may be incomplete; files: ["src/a.ts"]; omitted: 0',
      'oversized-sources: 1 file(s) larger than 4 MiB were skipped',
      'entry-points: vercel.json could not be read as JSON within 1 MiB; scheduled entries are unknown',
      'effect-inventory: incomplete(coverage); coverage cannot certify ambient safety.',
    ]);
    const edges = graph.edges.map((edge) => `${edge.from} -> ${edge.to} ${edge.kinds.join(',')}`);
    // 이름 없는 CommonJS 할당과 계산된 이름 멤버 안의 코드는 모듈 스코프에 속하고, static 필드는 모듈이 초기화한다.
    assert.ok(edges.includes('src/c.js#<module> -> src/c.js#helper call'), edges.join('\n'));
    assert.ok(edges.includes('src/c.js#<module> -> src/c.js#K.s initializer'), edges.join('\n'));
    assert.ok(graph.nodes.every((node) => node.location.path !== 'src/big.ts'));
  });
});

/** Program에서 기본 library와 프로젝트 파일을 찾는다. */
function sourceFile(program: ts.Program, path: string): ts.SourceFile {
  const source = program.getSourceFile(path);
  assert.ok(source, path);
  return source;
}

/** Date augmentation을 checker가 관찰하는 형태로 줄인다. */
function dateEpochType(result: ReturnType<typeof createGraphProgram>, path: string): string | undefined {
  const main = sourceFile(result.program, path);
  const declaration = main.statements.flatMap((statement) => {
    if (!ts.isVariableStatement(statement)) return [];
    return statement.declarationList.declarations.filter((item): item is ts.VariableDeclaration & { name: ts.Identifier } =>
      ts.isIdentifier(item.name) && item.name.text === 'dateValue');
  })[0];
  assert.ok(declaration);
  const property = result.checker.getTypeAtLocation(declaration.name).getProperty('projectEpoch');
  return property === undefined ? undefined : result.checker.typeToString(result.checker.getTypeOfSymbolAtLocation(property, declaration.name));
}

test('bundled SDK AST는 Program 사이에서 공유되고 프로젝트·vendor AST와 checker는 공유하지 않는다', async () => {
  await withProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'Bundler', target: 'ES2022' }, include: ['src'] }),
    'src/global.d.ts': 'interface Date { projectEpoch?: number; }\n',
    'src/main.ts': `import type { Vendor } from 'vendor';
export const dateValue: Date = new Date();
export const vendorValue: Vendor = { name: 'a' };
`,
    'node_modules/vendor/index.d.ts': 'export interface Vendor { name: string; }\n',
  }, async (firstRoot) => {
    await withProject({
      'tsconfig.json': JSON.stringify({ compilerOptions: { moduleResolution: 'Bundler', target: 'ES2022' }, include: ['src'] }),
      'src/main.ts': `import type { Vendor } from 'vendor';
export const dateValue: Date = new Date();
export const vendorValue: Vendor = { name: 'b' };
`,
      'node_modules/vendor/index.d.ts': 'export interface Vendor { name: string; }\n',
    }, (secondRoot) => {
      const first = createGraphProgram(firstRoot, []);
      const second = createGraphProgram(secondRoot, []);
      const firstAgain = createGraphProgram(firstRoot, []);
      const firstLib = first.program.getSourceFiles().find((file) => first.program.isSourceFileDefaultLibrary(file));
      const secondLib = second.program.getSourceFiles().find((file) => second.program.isSourceFileDefaultLibrary(file));
      const firstVendor = sourceFile(first.program, join(firstRoot, 'node_modules/vendor/index.d.ts'));
      const secondVendor = sourceFile(second.program, join(secondRoot, 'node_modules/vendor/index.d.ts'));
      assert.ok(firstLib);
      assert.equal(firstLib, secondLib);
      assert.equal(first.program.isSourceFileDefaultLibrary(firstLib), true);
      assert.equal(firstLib.statements[0]?.parent, firstLib);
      assert.notEqual(first.program, second.program);
      assert.notEqual(first.checker, second.checker);
      assert.notEqual(sourceFile(first.program, join(firstRoot, 'src/main.ts')), sourceFile(second.program, join(secondRoot, 'src/main.ts')));
      assert.notEqual(firstVendor, secondVendor);
      assert.equal(dateEpochType(first, join(firstRoot, 'src/main.ts')), 'number');
      assert.equal(dateEpochType(second, join(secondRoot, 'src/main.ts')), undefined);
      assert.equal(dateEpochType(firstAgain, join(firstRoot, 'src/main.ts')), 'number');
      assert.equal(firstLib, firstAgain.program.getSourceFiles().find((file) => firstAgain.program.isSourceFileDefaultLibrary(file)));

      const pristineHost = ts.createCompilerHost(first.program.getCompilerOptions(), true);
      const pristine = ts.createProgram({ rootNames: first.program.getRootFileNames(), options: first.program.getCompilerOptions(), host: pristineHost });
      const pristineResult = { program: pristine, checker: pristine.getTypeChecker() } as ReturnType<typeof createGraphProgram>;
      assert.equal(dateEpochType(pristineResult, join(firstRoot, 'src/main.ts')), 'number');
    });
  });
});

/** 제어된 SDK root에서 캐시가 설치된 CompilerHost를 만든다. */
function controlledSdkHost(
  files: Map<string, string>,
  cache: SdkSourceFileCache,
  options: ts.CompilerOptions,
  sdkDirectory: string,
): { host: ts.CompilerHost; release: () => void } {
  const host = ts.createCompilerHost(options, true);
  const originalReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => files.get(fileName) ?? originalReadFile(fileName);
  const lease = cache.install(host, options, sdkDirectory);
  return lease;
}

test('SDK cache는 digest·options·format별 identity와 fresh·LRU·oversized 경계를 지킨다', () => {
  const sdkDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-sdk-cache-')));
  try {
    const alpha = join(sdkDirectory, 'lib.alpha.d.ts');
    const beta = join(sdkDirectory, 'lib.beta.d.ts');
    const gamma = join(sdkDirectory, 'lib.gamma.d.ts');
    const large = join(sdkDirectory, 'lib.large.d.ts');
    const vendor = join(sdkDirectory, 'nested/lib.es5.d.ts');
    const missing = join(sdkDirectory, 'lib.missing.d.ts');
    mkdirSync(join(sdkDirectory, 'nested'), { recursive: true });
    const files = new Map([
      [alpha, '/** @deprecated */\ninterface Alpha { value: string }\n'],
      [beta, 'interface Beta { value: string }\n'],
      [gamma, 'interface Gamma { value: string }\n'],
      [large, `interface Large { value: "${'x'.repeat(120)}" }\n`],
      [vendor, 'interface VendorLib { value: string }\n'],
    ]);
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
    };
    const cache = new SdkSourceFileCache({
      registry: ts.createDocumentRegistry(true, sdkDirectory, ts.JSDocParsingMode.ParseForTypeInfo),
      maxEntries: 2,
      maxWeight: 200,
    });
    const incoming: ts.CreateSourceFileOptions = {
      languageVersion: ts.ScriptTarget.ES2022,
      impliedNodeFormat: ts.ModuleKind.ESNext,
      jsDocParsingMode: ts.JSDocParsingMode.ParseAll,
    };
    const request = (fileName: string, sourceOptions = incoming, fresh = false, compilerOptions = options): ts.SourceFile | undefined => {
      const lease = controlledSdkHost(files, cache, compilerOptions, sdkDirectory);
      try {
        return lease.host.getSourceFile(fileName, sourceOptions, undefined, fresh);
      } finally {
        lease.release();
      }
    };

    const first = request(alpha)!;
    assert.equal(first.languageVersion, ts.ScriptTarget.ES2022);
    assert.equal(first.impliedNodeFormat, ts.ModuleKind.ESNext);
    assert.deepEqual(ts.getJSDocTags(first.statements[0]!), []);
    assert.equal(request(alpha), first);
    const fresh = request(alpha, incoming, true);
    assert.ok(fresh);
    assert.notEqual(fresh, first);

    files.set(alpha, 'interface Alpha { changed: number }\n');
    const changed = request(alpha)!;
    assert.notEqual(changed, first);
    assert.match(first.text, /value/u);
    assert.match(changed.text, /changed/u);

    const commonJs = request(alpha, { ...incoming, impliedNodeFormat: ts.ModuleKind.CommonJS });
    assert.ok(commonJs);
    assert.notEqual(commonJs, changed);
    const sameOptionsDifferentLanguage = request(alpha, { ...incoming, languageVersion: ts.ScriptTarget.ES2018 });
    assert.ok(sameOptionsDifferentLanguage);
    assert.notEqual(sameOptionsDifferentLanguage, changed);
    assert.equal(sameOptionsDifferentLanguage.languageVersion, ts.ScriptTarget.ES2018);
    const olderTarget = request(alpha, { ...incoming, languageVersion: ts.ScriptTarget.ES2018 }, false, {
      ...options,
      target: ts.ScriptTarget.ES2018,
    });
    assert.ok(olderTarget);
    assert.notEqual(olderTarget, changed);

    assert.ok(request(beta));
    assert.ok(request(gamma));
    const afterEviction = cache.getStats();
    assert.equal(afterEviction.entries, 2);
    assert.ok(afterEviction.utf16Weight <= 200);
    assert.ok(afterEviction.evictions > 0);
    const oversizedBefore = cache.getStats();
    assert.ok(request(large));
    const oversizedAfter = cache.getStats();
    assert.equal(oversizedAfter.entries, oversizedBefore.entries);
    assert.equal(oversizedAfter.utf16Weight, oversizedBefore.utf16Weight);

    const vendorFirst = request(vendor);
    const vendorSecond = request(vendor);
    assert.ok(vendorFirst);
    assert.ok(vendorSecond);
    assert.notEqual(vendorFirst, vendorSecond);
    const readsBeforeMissing = cache.getStats().reads;
    assert.equal(request(missing), undefined);
    assert.equal(cache.getStats().reads, readsBeforeMissing);
    cache.clear();
    assert.equal(cache.getStats().entries, 0);
  } finally {
    rmSync(sdkDirectory, { recursive: true, force: true });
  }
});

test('SDK cache의 read failure·예외·중복 release는 원래 host와 registry lease를 보존한다', () => {
  const sdkDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-sdk-cache-failure-')));
  try {
    const missing = join(sdkDirectory, 'lib.missing.d.ts');
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
    let delegated = 0;
    let errorMessage: string | undefined;
    const host = ts.createCompilerHost(options, true);
    host.readFile = () => undefined;
    host.getSourceFile = (_fileName, _options, onError) => {
      delegated++;
      onError?.('controlled read failure');
      return undefined;
    };
    const cache = new SdkSourceFileCache({ maxEntries: 1, maxWeight: 100 });
    const lease = cache.install(host, options, sdkDirectory);
    assert.equal(lease.host.getSourceFile(missing, ts.ScriptTarget.ES2022, (message) => { errorMessage = message; }), undefined);
    lease.release();
    lease.release();
    assert.equal(delegated, 1);
    assert.equal(errorMessage, 'controlled read failure');
    assert.deepEqual(cache.getStats(), { entries: 0, utf16Weight: 0, hits: 0, misses: 0, evictions: 0, reads: 0 });

    const throwingHost = ts.createCompilerHost(options, true);
    let throwingDelegated = 0;
    throwingHost.readFile = () => { throw new Error('controlled read throw'); };
    throwingHost.getSourceFile = (_fileName, _options, onError) => {
      throwingDelegated++;
      onError?.('controlled read throw');
      return undefined;
    };
    const throwingReadLease = cache.install(throwingHost, options, sdkDirectory);
    assert.equal(throwingReadLease.host.getSourceFile(missing, ts.ScriptTarget.ES2022), undefined);
    throwingReadLease.release();
    assert.equal(throwingDelegated, 1);

    const sentinelPath = join(sdkDirectory, 'lib.sentinel.d.ts');
    const sentinelFiles = new Map([[sentinelPath, 'interface Sentinel {}\n']]);
    const sentinelHost = ts.createCompilerHost(options, true);
    const sentinelMarker = ts.createSourceFile('sentinel-marker.ts', 'export const marker = 1;\n', ts.ScriptTarget.ES2022, true);
    const sentinelOnError = () => undefined;
    let sentinelDelegated = 0;
    let sentinelOptions: ts.ScriptTarget | ts.CreateSourceFileOptions | undefined;
    let sentinelFresh: boolean | undefined;
    let sentinelReceivedOnError: ((message: string) => void) | undefined;
    sentinelHost.readFile = (fileName) => sentinelFiles.get(fileName);
    sentinelHost.fileExists = (fileName) => sentinelFiles.has(fileName);
    sentinelHost.getSourceFile = (fileName, incoming, onError, fresh) => {
      sentinelDelegated++;
      sentinelOptions = incoming;
      sentinelFresh = fresh;
      sentinelReceivedOnError = onError;
      return sentinelMarker;
    };
    const sentinelCache = new SdkSourceFileCache({ maxEntries: 2, maxWeight: 100 });
    const sentinelLease = sentinelCache.install(sentinelHost, options, sdkDirectory);
    const freshSource = sentinelLease.host.getSourceFile(sentinelPath, { languageVersion: ts.ScriptTarget.ES2022 }, sentinelOnError, true);
    assert.equal(freshSource, sentinelMarker);
    assert.equal(sentinelDelegated, 1);
    assert.equal(sentinelReceivedOnError, sentinelOnError);
    const mismatchFresh = sentinelLease.host.getSourceFile(sentinelPath, { languageVersion: ts.ScriptTarget.ES2018 }, sentinelOnError, true);
    assert.equal(mismatchFresh, sentinelMarker);
    assert.equal(sentinelDelegated, 2);
    assert.equal(sentinelFresh, true);
    assert.equal((sentinelOptions as ts.CreateSourceFileOptions).languageVersion, ts.ScriptTarget.ES2018);
    assert.equal((sentinelOptions as ts.CreateSourceFileOptions).jsDocParsingMode, ts.JSDocParsingMode.ParseForTypeInfo);
    sentinelLease.release();

    const postReleasePath = join(sdkDirectory, 'lib.post-release.d.ts');
    const postReleaseFiles = new Map([[postReleasePath, 'interface PostRelease {}\n']]);
    const postReleaseHost = ts.createCompilerHost(options, true);
    const postReleaseMarker = ts.createSourceFile('post-release-marker.ts', 'export const marker = 1;\n', ts.ScriptTarget.ES2022, true);
    const postReleaseRegistry = ts.createDocumentRegistry(true, sdkDirectory, ts.JSDocParsingMode.ParseForTypeInfo);
    let postReleaseAcquires = 0;
    let postReleaseReleases = 0;
    let postReleaseDelegated = 0;
    const postReleaseCountingRegistry = new Proxy(postReleaseRegistry, {
      get(target, property, receiver) {
        if (property === 'acquireDocument') {
          return (...args: unknown[]) => {
            postReleaseAcquires++;
            return (target.acquireDocument as unknown as (...values: unknown[]) => ts.SourceFile)(...args);
          };
        }
        if (property === 'releaseDocument') {
          return (...args: unknown[]) => {
            postReleaseReleases++;
            return (target.releaseDocument as unknown as (...values: unknown[]) => void)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as ts.DocumentRegistry;
    postReleaseHost.readFile = (fileName) => postReleaseFiles.get(fileName);
    postReleaseHost.fileExists = (fileName) => postReleaseFiles.has(fileName);
    const postReleaseOnError = () => undefined;
    let postReleaseOptions: ts.ScriptTarget | ts.CreateSourceFileOptions | undefined;
    let postReleaseFresh: boolean | undefined;
    postReleaseHost.getSourceFile = (_fileName, incoming, _onError, fresh) => {
      postReleaseDelegated++;
      postReleaseOptions = incoming;
      postReleaseFresh = fresh;
      return postReleaseMarker;
    };
    const postReleaseCache = new SdkSourceFileCache({ registry: postReleaseCountingRegistry, maxEntries: 2, maxWeight: 100 });
    const postReleaseLease = postReleaseCache.install(postReleaseHost, options, sdkDirectory);
    const cachedPostRelease = postReleaseLease.host.getSourceFile(postReleasePath, ts.ScriptTarget.ES2022);
    assert.ok(cachedPostRelease);
    postReleaseLease.release();
    const beforePostRelease = { acquires: postReleaseAcquires, releases: postReleaseReleases };
    const afterPostRelease = postReleaseLease.host.getSourceFile(postReleasePath, { languageVersion: ts.ScriptTarget.ES2022 }, postReleaseOnError);
    assert.equal(afterPostRelease, postReleaseMarker);
    assert.equal(postReleaseDelegated, 1);
    assert.equal(postReleaseAcquires, beforePostRelease.acquires);
    assert.equal(postReleaseReleases, beforePostRelease.releases);
    assert.equal((postReleaseOptions as ts.CreateSourceFileOptions).jsDocParsingMode, ts.JSDocParsingMode.ParseForTypeInfo);
    assert.equal(postReleaseFresh, undefined);
    postReleaseCache.clear();

    const mutableOptions: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext };
    const mutablePath = join(sdkDirectory, 'lib.mutable.d.ts');
    const mutableOtherPath = join(sdkDirectory, 'lib.mutable-other.d.ts');
    const mutableFiles = new Map([[mutablePath, 'interface Mutable {}\n'], [mutableOtherPath, 'interface MutableOther {}\n']]);
    const mutableCache = new SdkSourceFileCache({ maxEntries: 1, maxWeight: 100 });
    const mutableLease = controlledSdkHost(mutableFiles, mutableCache, mutableOptions, sdkDirectory);
    assert.ok(mutableLease.host.getSourceFile(mutablePath, ts.ScriptTarget.ES2022));
    assert.ok(mutableLease.host.getSourceFile(mutableOtherPath, ts.ScriptTarget.ES2022));
    mutableOptions.target = ts.ScriptTarget.ES2018;
    assert.doesNotThrow(() => mutableLease.release());
    assert.doesNotThrow(() => mutableCache.clear());

    const releasePathA = join(sdkDirectory, 'lib.release-a.d.ts');
    const releasePathB = join(sdkDirectory, 'lib.release-b.d.ts');
    const releaseFiles = new Map([[releasePathA, 'interface ReleaseA {}\n'], [releasePathB, 'interface ReleaseB {}\n']]);
    const releaseRegistry = ts.createDocumentRegistry(true, sdkDirectory, ts.JSDocParsingMode.ParseForTypeInfo);
    let releaseAttempts = 0;
    const throwingReleaseRegistry = new Proxy(releaseRegistry, {
      get(target, property, receiver) {
        if (property === 'releaseDocument') {
          return (...args: unknown[]) => {
            releaseAttempts++;
            if (releaseAttempts === 1) throw new Error('controlled release failure');
            return (target.releaseDocument as unknown as (...values: unknown[]) => void)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as ts.DocumentRegistry;
    const releaseCache = new SdkSourceFileCache({ registry: throwingReleaseRegistry, maxEntries: 4, maxWeight: 100 });
    const releaseLease = controlledSdkHost(releaseFiles, releaseCache, options, sdkDirectory);
    assert.ok(releaseLease.host.getSourceFile(releasePathA, ts.ScriptTarget.ES2022));
    assert.ok(releaseLease.host.getSourceFile(releasePathB, ts.ScriptTarget.ES2022));
    assert.throws(() => releaseLease.release(), /controlled release failure/u);
    assert.equal(releaseAttempts, 2);
    assert.doesNotThrow(() => releaseLease.release());
    assert.doesNotThrow(() => releaseCache.clear());
    assert.equal(releaseAttempts, 4);
    assert.equal(releaseCache.getStats().entries, 0);

    let trimAttempts = 0;
    const trimRegistry = new Proxy(ts.createDocumentRegistry(true, sdkDirectory, ts.JSDocParsingMode.ParseForTypeInfo), {
      get(target, property, receiver) {
        if (property === 'releaseDocument') {
          return (...args: unknown[]) => {
            trimAttempts++;
            if (trimAttempts === 3) throw new Error('controlled trim failure');
            return (target.releaseDocument as unknown as (...values: unknown[]) => void)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as ts.DocumentRegistry;
    const trimCache = new SdkSourceFileCache({ registry: trimRegistry, maxEntries: 1, maxWeight: 100 });
    const trimLease = controlledSdkHost(releaseFiles, trimCache, options, sdkDirectory);
    assert.ok(trimLease.host.getSourceFile(releasePathA, ts.ScriptTarget.ES2022));
    assert.ok(trimLease.host.getSourceFile(releasePathB, ts.ScriptTarget.ES2022));
    assert.throws(() => trimLease.release(), /controlled trim failure/u);
    assert.equal(trimAttempts, 3);
    assert.equal(trimCache.getStats().entries, 1);
    assert.doesNotThrow(() => trimCache.clear());
    assert.equal(trimCache.getStats().entries, 0);

    let clearAttempts = 0;
    const clearRegistry = new Proxy(ts.createDocumentRegistry(true, sdkDirectory, ts.JSDocParsingMode.ParseForTypeInfo), {
      get(target, property, receiver) {
        if (property === 'releaseDocument') {
          return (...args: unknown[]) => {
            clearAttempts++;
            if (clearAttempts === 1) return (target.releaseDocument as unknown as (...values: unknown[]) => void)(...args);
            throw new Error('controlled clear failure');
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as ts.DocumentRegistry;
    const clearCache = new SdkSourceFileCache({ registry: clearRegistry, maxEntries: 1, maxWeight: 100 });
    const clearLease = controlledSdkHost(releaseFiles, clearCache, options, sdkDirectory);
    assert.ok(clearLease.host.getSourceFile(releasePathA, ts.ScriptTarget.ES2022));
    clearLease.release();
    assert.throws(() => clearCache.clear(), /controlled clear failure/u);
    assert.equal(clearAttempts, 2);
    assert.equal(clearCache.getStats().entries, 0);

    for (const cleanupValue of [undefined, null]) {
      let cleanupAttempts = 0;
      const cleanupRegistry = new Proxy(ts.createDocumentRegistry(true, sdkDirectory, ts.JSDocParsingMode.ParseForTypeInfo), {
        get(target, property, receiver) {
          if (property === 'releaseDocument') {
            return (...args: unknown[]) => {
              cleanupAttempts++;
              if (cleanupAttempts === 1) throw cleanupValue;
              return (target.releaseDocument as unknown as (...values: unknown[]) => void)(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as unknown as ts.DocumentRegistry;
      const cleanupCache = new SdkSourceFileCache({ registry: cleanupRegistry, maxEntries: 4, maxWeight: 100 });
      const cleanupLease = controlledSdkHost(releaseFiles, cleanupCache, options, sdkDirectory);
      assert.ok(cleanupLease.host.getSourceFile(releasePathA, ts.ScriptTarget.ES2022));
      assert.ok(cleanupLease.host.getSourceFile(releasePathB, ts.ScriptTarget.ES2022));
      let caught = false;
      let observed: unknown;
      try {
        cleanupLease.release();
      } catch (error) {
        caught = true;
        observed = error;
      }
      assert.equal(caught, true);
      assert.equal(observed, cleanupValue);
      assert.equal(cleanupAttempts, 2);
      cleanupCache.clear();
      assert.equal(cleanupCache.getStats().entries, 0);
    }

    const delegate = ts.createDocumentRegistry(true, sdkDirectory, ts.JSDocParsingMode.ParseForTypeInfo);
    let acquireCount = 0;
    let releaseCount = 0;
    const throwingRegistry = new Proxy(delegate, {
      get(target, property, receiver) {
        if (property === 'acquireDocument') {
          return (...args: unknown[]) => {
            acquireCount++;
            if (acquireCount === 2) throw new Error('controlled registry failure');
            return (target.acquireDocument as unknown as (...values: unknown[]) => ts.SourceFile)(...args);
          };
        }
        if (property === 'releaseDocument') {
          return (...args: unknown[]) => {
            releaseCount++;
            return (target.releaseDocument as unknown as (...values: unknown[]) => void)(...args);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }) as unknown as ts.DocumentRegistry;
    const path = join(sdkDirectory, 'lib.throwing.d.ts');
    const files = new Map([[path, 'interface Throwing {}\n']]);
    const failureCache = new SdkSourceFileCache({ registry: throwingRegistry, maxEntries: 1, maxWeight: 100 });
    const failureLease = controlledSdkHost(files, failureCache, options, sdkDirectory);
    assert.throws(() => failureLease.host.getSourceFile(path, ts.ScriptTarget.ES2022), /controlled registry failure/u);
    failureLease.release();
    assert.equal(failureCache.getStats().entries, 0);
    assert.equal(releaseCount, 1);
  } finally {
    rmSync(sdkDirectory, { recursive: true, force: true });
  }
  assert.throws(() => new SdkSourceFileCache({ maxEntries: 0 }), RangeError);
  assert.throws(() => new SdkSourceFileCache({ maxWeight: Number.NaN }), RangeError);
});

test('JS·TSX·MTS·CTS 프로젝트와 vendor lib 선언은 SDK cache 경계와 freshness를 유지한다', async () => {
  await withProject({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true, jsx: 'preserve', module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2022' },
      include: ['src/**/*'],
    }),
    'src/plain.js': 'export const plain = 1;\n',
    'src/view.tsx': 'export const view = 1;\n',
    'src/module.mts': 'export const esm = 1;\n',
    'src/module.cts': 'export const cjs = 1;\n',
    'node_modules/vendor/lib.es5.d.ts': 'export interface VendorLib { version: "one"; }\n',
    'src/main.ts': `import type { VendorLib } from 'vendor/lib.es5';
export const vendorValue: VendorLib = { version: 'one' };
`,
  }, (root) => {
    const first = createGraphProgram(root, []);
    for (const name of ['plain.js', 'view.tsx', 'module.mts', 'module.cts']) {
      assert.ok(first.program.getSourceFile(join(root, 'src', name)), name);
    }
    const vendorPath = join(root, 'node_modules/vendor/lib.es5.d.ts');
    const firstVendor = sourceFile(first.program, vendorPath);
    writeFileSync(vendorPath, 'export interface VendorLib { version: "two"; }\n');
    const second = createGraphProgram(root, []);
    const secondVendor = sourceFile(second.program, vendorPath);
    assert.notEqual(secondVendor, firstVendor);
    assert.match(firstVendor.text, /one/u);
    assert.match(secondVendor.text, /two/u);
  });
});

test('Program 생성 primary error가 cleanup error에 가려지지 않고 cleanup을 시도한다', async () => {
  await withProject({ 'a.ts': 'export const value = 1;\n' }, (root) => {
    const primary = new Error('primary program failure');
    const cleanup = new Error('cleanup release failure');
    const originalInstall = sdkSourceFileCache.install;
    let cleanupAttempts = 0;
    const mutableCache = sdkSourceFileCache as unknown as { install: typeof sdkSourceFileCache.install };
    mutableCache.install = ((host, options, defaultLibDirectory) => {
      const lease = originalInstall.call(sdkSourceFileCache, host, options, defaultLibDirectory);
      return {
        host: lease.host,
        release: () => {
          cleanupAttempts++;
          throw cleanup;
        },
      };
    }) as typeof sdkSourceFileCache.install;
    try {
      let observed: unknown;
      try {
        createGraphProgram(root, [], (() => { throw primary; }) as typeof ts.createProgram);
      } catch (error) {
        observed = error;
      }
      assert.equal(observed, primary);
      assert.equal(cleanupAttempts, 1);
    } finally {
      mutableCache.install = originalInstall;
    }
  });
});


test('compiler host caps valid tsconfig roots, transitive imports and declaration dependencies', async () => {
  const huge = `/*${'x'.repeat(4 * 1024 * 1024)}*/ export function huge() {}`;
  await withProject({
    'package.json': '{"private":true}',
    'tsconfig.json': '{"files":["entry.ts","huge.ts"]}',
    'entry.ts': 'import { hidden } from "./hidden"; import type { Shape } from "./types"; export function entry(a: Shape){ hidden(); }',
    'huge.ts': huge,
    'hidden.ts': huge.replace('huge()', 'hidden()'),
    'types.d.ts': huge,
  }, async (root) => {
    const originalRead = ts.sys.readFile;
    let unboundedReads = 0;
    ts.sys.readFile = (path, encoding) => {
      if (['huge.ts', 'hidden.ts', 'types.d.ts'].some((name) => path === join(root, name))) unboundedReads++;
      return originalRead(path, encoding);
    };
    try {
      const { program, status } = createGraphProgram(root, [join(root, 'entry.ts')]);
      for (const name of ['huge.ts', 'hidden.ts', 'types.d.ts']) assert.equal(program.getSourceFile(join(root, name)), undefined);
      assert.equal(status.oversizedCompilerInputs, 3);
      assert.ok(program.getSourceFile(join(root, 'entry.ts')));
      assert.ok(program.getSourceFiles().some((file) => file.fileName.endsWith('/lib.es5.d.ts')));
      const graph = await buildCallGraph(root, createNodeFileSystem());
      assert.ok(graph.limitations.some((line) => line.startsWith('oversized-compiler-inputs: 3')));
      assert.ok(graph.limitations.some((line) => line.includes('incomplete(coverage)')));
      assert.equal(unboundedReads, 0);
    } finally { ts.sys.readFile = originalRead; }
  });
});

/**
 * 구문 깊이 상한을 넘는 소스다. 격리 전에는 TypeScript 바인더가 이 `||` 사슬을 재귀로 걷다가 스택을 넘겨 Program을 쓰는
 * 명령 전체가 실패했다.
 *
 * @param name 내보낼 이름
 * @returns 소스 텍스트
 */
function deepLogicalSource(name: string): string {
  return `declare const a: boolean;\nexport const ${name} = ${Array.from({ length: 3_000 }, () => 'a').join(' || ')};\n`;
}

test('compiler host는 구문 깊이 상한을 넘는 입력을 Program에서 빼고 호출자 소스와 나머지 입력을 나눠 센다', async () => {
  await withProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, files: ['entry.ts', 'selected.ts'] }),
    'entry.ts': 'import { hidden } from "./hidden"; import { walked } from "./walked"; export function entry() { return hidden || walked; }',
    'selected.ts': deepLogicalSource('selected'),
    'hidden.ts': deepLogicalSource('hidden'),
    'walked.ts': deepLogicalSource('walked'),
    'parens.ts': `export const parens = ${'('.repeat(3_000)}1${')'.repeat(3_000)};\n`,
  }, (root) => {
    const { program, checker, status, deeplyNestedSources } = createGraphProgram(root, [join(root, 'entry.ts'), join(root, 'walked.ts'), join(root, 'parens.ts')]);
    for (const name of ['selected.ts', 'hidden.ts', 'walked.ts', 'parens.ts']) assert.equal(program.getSourceFile(join(root, name)), undefined, name);
    const entry = sourceFile(program, join(root, 'entry.ts'));
    assert.ok(checker.getSymbolsInScope(entry, ts.SymbolFlags.Function).some((symbol) => symbol.name === 'entry'));
    assert.deepEqual([...deeplyNestedSources].sort(), [join(root, 'parens.ts'), join(root, 'walked.ts')]);
    assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false, deeplyNestedCompilerInputs: 2 });
  });
});

test('graph는 깊이로 뺀 소스를 노드 없이 parse-errors로 알리고 읽지 못한 소스와 섞지 않으며 완전성을 주장하지 않는다', async () => {
  await withProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, include: ['src'] }),
    'src/app.ts': 'import { deep } from "./deep";\nexport function main() { return helper() || deep; }\nfunction helper() { return false; }\n',
    'src/deep.ts': deepLogicalSource('deep'),
    'src/types/shape.d.ts': `declare const shape: ${'Array<'.repeat(3_000)}number${'>'.repeat(3_000)};\n`,
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.edges.some((edge) => edge.from === 'src/app.ts#main' && edge.to === 'src/app.ts#helper'));
    assert.ok(graph.nodes.every((node) => node.location.path !== 'src/deep.ts'));
    assert.deepEqual(graph.limitations.filter((line) => line.startsWith('parse-errors:') || line.startsWith('unreadable-sources:')), [
      `parse-errors: 1 source file(s) ${SYNTAX_DEPTH_CAUSE} and were not analyzed; they have no nodes and calls into them stay unlinked; `
        + 'files: ["src/deep.ts"]; omitted: 0',
      `parse-errors: 1 declaration, package, or config-selected input(s) ${SYNTAX_DEPTH_CAUSE} and were not loaded; type resolution and calls may be incomplete`,
    ]);
    assert.ok(graph.limitations.some((line) => line.includes('incomplete(coverage)')));
    assert.equal(graph.statistics.files, 1);
  });
});

/** 실행 위치만 바꾼 자식 프로세스 검사가 타입 제거로 직접 실행하는 CLI 진입점이다. */
const mainPath = fileURLToPath(new URL('../cli/main.ts', import.meta.url));

/**
 * Program 루트 파일을 기준 디렉터리 상대 경로로 줄인다(정렬).
 *
 * @param program Program
 * @param root 기준 디렉터리
 * @returns 상대 경로 목록
 */
function rootFiles(program: ts.Program, root: string): string[] {
  return program.getRootFileNames().map((name) => relative(root, name)).sort();
}

/**
 * `node_modules/@types/<name>` 선언 패키지 파일을 만든다(TypeScript 자동 타입 포함 대상).
 *
 * @param directory 패키지를 둘 디렉터리(프로젝트 기준)
 * @param name `@types` 아래 패키지 이름
 * @param declaration `index.d.ts` 내용
 * @returns 상대 경로 → 내용
 */
function typesPackage(directory: string, name: string, declaration: string): Record<string, string> {
  const base = `${directory}/node_modules/@types/${name}`;
  return {
    [`${base}/index.d.ts`]: declaration,
    [`${base}/package.json`]: JSON.stringify({ name: `@types/${name}`, version: '1.0.0', types: 'index.d.ts' }),
  };
}

/** `graph-config:`·coverage 한계가 함께 쓰는 '경계 밖 설정 루트' 원인 문장이다. */
function outsideRootsGap(count: number, affected: string): string {
  return `${count} include pattern(s) or files entr(ies) of tsconfig.json point outside the scanned root and were not used as root files; `
    + `type resolution and ${affected} may be incomplete (analyze a root that contains them)`;
}

/** `graph-config:`·coverage 한계가 함께 쓰는 '걷기 정책에 막힌 이름 설정 루트' 원인 문장이다. */
function excludedRootsGap(count: number, affected: string): string {
  return `${count} files entr(ies) or wildcard-free include path(s) of tsconfig.json name paths in directories the scan skips `
    + `or through symbolic links and were not used as root files; type resolution and ${affected} may be incomplete `
    + '(import or reference them from a project source instead)';
}

test('설정 루트는 걷기가 건너뛰는 디렉터리·symlink 아래를 열거하지 않고 루트 안 선언은 남기며 이름으로 적은 항목만 센다', {
  skip: process.platform === 'win32',
}, async () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-graph-link-')));
  try {
    writeFileSync(join(outside, 'linked.d.ts'), 'declare const linked: number;\n');
    await withProject({
      'tsconfig.json': JSON.stringify({
        compilerOptions: { types: [] },
        include: ['src', 'build', 'dist/**/*', 'out', 'coverage', '.storybook', 'generated', 'src/vendor/**/*', 'src/missing'],
        files: ['src/types/listed.d.ts', 'build/listed.d.ts', 'src/vendor/linked.d.ts', 'src/missing.d.ts'],
      }),
      'src/main.ts': 'export function main() { return 1; }\n',
      'src/types/global.d.ts': 'declare const projectGlobal: number;\n',
      'src/types/listed.d.ts': 'declare const listed: number;\n',
      'build/bundle.ts': 'export const build = 1;\n',
      'build/listed.d.ts': 'declare const buildListed: number;\n',
      'dist/chunk.ts': 'export const dist = 1;\n',
      'out/emitted.ts': 'export const out = 1;\n',
      'coverage/report.ts': 'export const coverage = 1;\n',
      '.storybook/main.ts': 'export const storybook = 1;\n',
      'generated/client.ts': 'export const generated = 1;\n',
    }, (root) => {
      symlinkSync(outside, join(root, 'src/vendor'));
      // `generated/`는 Prisma 생성 출력처럼 호출자의 걷기가 따로 뺀 디렉터리다.
      const boundary = { root, excludedDirectories: new Set([join(root, 'generated')]) };
      const { program, status } = createGraphProgram(root, [join(root, 'src/main.ts')], ts.createProgram, undefined, boundary);
      assert.deepEqual(rootFiles(program, root), ['src/main.ts', 'src/types/global.d.ts', 'src/types/listed.d.ts']);
      // 글롭(`dist/**/*`·`src/vendor/**/*`)이 고를 파일은 걷기와 같은 정책이라 세지 않는다. 이름으로 적은 include 디렉터리
      // `build`·`out`·`coverage`·`generated`와 `files`의 `build/listed.d.ts`·`src/vendor/linked.d.ts`(symlink 디렉터리 아래)는
      // 사용자가 콕 집어 고른 경로라 센다. 점이 든 `.storybook`은 TypeScript가 파일 이름으로 읽어 디렉터리를 고르지 않고,
      // 없는 `src/missing`·`src/missing.d.ts`는 TypeScript도 아무것도 얻지 못하므로 세지 않는다.
      assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false, excludedConfigRoots: 6 });
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('이름으로 적은 files가 걷기가 건너뛰는 디렉터리 아래면 graph-config로 알리고, 프로젝트 소스가 참조하면 공백 없이 쓴다', async () => {
  const files = {
    'package.json': '{"private":true}',
    'src/main.ts': 'export function run() { return makeStore() + makeStore(); }\n',
    'node_modules/globals-pkg/index.d.ts': 'declare function makeStore(): number;\n',
  };
  await withProject({
    ...files,
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, include: ['src'], files: ['node_modules/globals-pkg/index.d.ts'] }),
  }, async (root) => {
    const { program, status } = createGraphProgram(root, [join(root, 'src/main.ts')]);
    assert.deepEqual(rootFiles(program, root), ['src/main.ts']);
    assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false, excludedConfigRoots: 1 });
    // 예전에는 원인 없이 `unresolved-calls:`만 남고 coverage 완전성을 그대로 주장했다.
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.ok(graph.limitations.includes(`graph-config: ${excludedRootsGap(1, 'calls')}`), graph.limitations.join('\n'));
    assert.ok(graph.limitations.some((line) => line.includes('incomplete(coverage)')), graph.limitations.join('\n'));
  });
  // 안내한 해결 방향: 프로젝트 소스가 참조하면 compiler host가 그 선언을 읽어 공백이 없다.
  await withProject({
    ...files,
    'src/main.ts': `/// <reference path="../node_modules/globals-pkg/index.d.ts" />\n${files['src/main.ts']}`,
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, include: ['src'] }),
  }, async (root) => {
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.deepEqual(graph.limitations.filter((line) => /^(graph-config|unresolved-calls|effect-inventory):/u.test(line)), []);
  });
});

test('정책에 막힌 설정 루트는 TypeScript가 실제로 고를 이름 항목만 세고 글롭 일치·없는 항목·특수 파일은 세지 않는다', {
  skip: process.platform === 'win32',
}, async () => {
  await withProject({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { types: [] },
      // `.next/types/**/*.ts`는 Next가 생성 설정에 넣는 글롭이라 조용히 둔다. 점 디렉터리 아래 파일 `.types/global.d.ts`와
      // symlink 디렉터리 `types-link`는 센다. `src`·`next-env.d.ts`는 정책을 통과한다.
      include: ['src', 'next-env.d.ts', '.next/types/**/*.ts', '.types/global.d.ts', 'types-link'],
      // 디렉터리·FIFO·없는 파일은 TypeScript도 소스로 읽지 못해 세지 않는다. 일반 파일로 가는 symlink는 센다.
      files: ['src', 'src/pipe.d.ts', 'src/gone.d.ts', 'src/link.d.ts'],
    }),
    'src/main.ts': 'export const main = 1;\n',
    'next-env.d.ts': 'declare const nextEnv: number;\n',
    '.next/types/app/page.ts': 'export const page = 1;\n',
    '.types/global.d.ts': 'declare const dotted: number;\n',
    'real-types/linked.d.ts': 'declare const linked: number;\n',
  }, (root) => {
    makeFifo(join(root, 'src/pipe.d.ts'));
    symlinkSync(join(root, 'real-types'), join(root, 'types-link'));
    symlinkSync(join(root, 'real-types/linked.d.ts'), join(root, 'src/link.d.ts'));
    const { program, status } = createGraphProgram(root, []);
    assert.deepEqual(rootFiles(program, root), ['next-env.d.ts', 'src/main.ts']);
    assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false, excludedConfigRoots: 3 });
    assert.deepEqual(compilerConfigGaps(status, 'route registrations'), [excludedRootsGap(3, 'route registrations')]);
  });
});

test('include 없는 jsconfig도 build/·dist/ 산출물을 루트로 넣지 않아 그래프가 산출물 없는 프로젝트와 같다', async () => {
  const files = {
    'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', types: [] } }),
    'package.json': '{"private":true}',
    'src/main.js': 'export function apply(callback) { return callback(); }\n'
      + 'export function work() { return apply(() => helper()); }\nfunction helper() { return 1; }\n',
  };
  await withProject(files, async (clean) => {
    await withProject({
      ...files,
      // 4 MiB를 넘는 로컬 번들 하나가 예전에는 compiler 입력 상한으로 bound 디스패치 전체를 껐다.
      'build/main.js': `/*${'x'.repeat(MAX_SOURCE_BYTES)}*/\nexport function bundled() {}\n`,
      'dist/chunk.js': 'export function chunk() { return 2; }\n',
    }, async (built) => {
      const [expected, actual] = await Promise.all([buildCallGraph(clean, createNodeFileSystem()), buildCallGraph(built, createNodeFileSystem())]);
      assert.deepEqual(
        { nodes: actual.nodes, edges: actual.edges, limitations: actual.limitations },
        { nodes: expected.nodes, edges: expected.edges, limitations: expected.limitations },
      );
      assert.ok(actual.edges.some((edge) => edge.evidence === 'bound'));
    });
  });
});

test('경계 밖을 가리키는 include·files는 열거하지 않고 세며 --workspace 경계 안이면 루트로 쓴다', async (t) => {
  await withProject({
    // `../../**/*.d.ts`는 임시 디렉터리의 부모(다른 테스트의 파일까지)를 연다. `/**/*`는 TypeScript가 설정 디렉터리로
    // 되돌리지만 뜻은 파일 시스템 전체라 경계 밖으로 센다.
    'app/tsconfig.json': JSON.stringify({
      compilerOptions: { types: [] }, include: ['src', '../shared/**/*', '../../**/*.d.ts', '/**/*'], files: ['../extra/extra.d.ts'],
    }),
    'app/package.json': '{"private":true}',
    'app/src/main.ts': 'export function main() { return sharedAmbient() + extraAmbient(); }\n',
    'shared/globals.d.ts': 'declare function sharedAmbient(): number;\n',
    'extra/extra.d.ts': 'declare function extraAmbient(): number;\n',
  }, async (root) => {
    const app = join(root, 'app');
    const originalReaddir = fs.readdirSync;
    const outsideListings: string[] = [];
    // 임시 루트 밖 목록 요청은 기록하고 빈 목록을 돌려준다. 고치기 전 코드가 실행 위치·파일 시스템 전체를 열거하지 않게 막는다.
    t.mock.method(fs, 'readdirSync', function readdirSync(this: unknown, ...arguments_: Parameters<typeof fs.readdirSync>) {
      const directory = resolve(String(arguments_[0]));
      if (relative(root, directory).startsWith('..')) {
        outsideListings.push(directory);
        return [];
      }
      return originalReaddir.apply(this, arguments_);
    });
    syncBuiltinESMExports();
    try {
      const own = createGraphProgram(app, [join(app, 'src/main.ts')]);
      assert.deepEqual(rootFiles(own.program, root), ['app/src/main.ts']);
      assert.equal(own.status.outsideConfigRoots, 4);
      const widened = createGraphProgram(app, [join(app, 'src/main.ts')], ts.createProgram, undefined, { root, excludedDirectories: new Set() });
      assert.deepEqual(rootFiles(widened.program, root), ['app/src/main.ts', 'extra/extra.d.ts', 'shared/globals.d.ts']);
      assert.equal(widened.status.outsideConfigRoots, 2);
      const graph = await buildCallGraph(app, createNodeFileSystem());
      assert.ok(graph.limitations.includes(`graph-config: ${outsideRootsGap(4, 'calls')}`), graph.limitations.join('\n'));
      assert.ok(graph.limitations.some((line) => line.includes('incomplete(coverage)')));
      const workspace = await buildCallGraph(app, createNodeFileSystem(), { workspace: root });
      assert.ok(workspace.limitations.includes(`graph-config: ${outsideRootsGap(2, 'calls')}`), workspace.limitations.join('\n'));
      assert.deepEqual(outsideListings, []);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
});

test('프로젝트 경로에 든 `*`·`?`는 include 글롭이 아니라 경계 판정이 설정 루트를 버리지 않고 이웃 디렉터리도 열지 않는다', {
  // Windows 파일 이름에는 `*`·`?`를 쓸 수 없다.
  skip: process.platform === 'win32',
}, async () => {
  const project = (directory: string): Record<string, string> => ({
    // `${configDir}`는 TypeScript가 설정 디렉터리 절대 경로로 바꿔 넘긴다. 그 경로에도 같은 문자가 든다.
    [`${directory}/tsconfig.json`]: JSON.stringify({ compilerOptions: { types: [] }, include: ['src', 'types', '${configDir}/extra'] }),
    [`${directory}/package.json`]: '{"private":true}',
    [`${directory}/src/main.ts`]: 'export function run() { return makeStore(); }\n',
    [`${directory}/types/global.d.ts`]: 'declare function makeStore(): number;\n',
    [`${directory}/extra/more.d.ts`]: 'declare const more: number;\n',
  });
  // `weXrd`는 TypeScript가 `we*rd`·`we?rd`를 글롭으로 읽으면 맞는 이웃이다. 그 파일이 루트로 섞이면 안 된다.
  await withProject({ ...project('we*rd/proj'), ...project('we?rd/proj'), ...project('weXrd/proj') }, async (root) => {
    for (const directory of ['we*rd/proj', 'we?rd/proj']) {
      const app = join(root, directory);
      const { program, status } = createGraphProgram(app, [join(app, 'src/main.ts')]);
      assert.deepEqual(rootFiles(program, app), ['extra/more.d.ts', 'src/main.ts', 'types/global.d.ts'], directory);
      assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false }, directory);
      const graph = await buildCallGraph(app, createNodeFileSystem());
      assert.deepEqual(graph.limitations.filter((line) => line.startsWith('graph-config:') || line.includes('incomplete(coverage)')), [], directory);
    }
  });
});

test('include의 백슬래시는 TypeScript처럼 경로 구분자로 읽어 밖을 가리키면 세고 안을 가리키면 루트로 쓴다', async () => {
  await withProject({
    'app/tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, include: ['src', 'types\\**\\*.d.ts', '..\\outside\\**\\*.d.ts'] }),
    'app/package.json': '{"private":true}',
    'app/src/main.ts': 'export function run() { return insideAmbient() + outsideAmbient(); }\n',
    'app/types/inside.d.ts': 'declare function insideAmbient(): number;\n',
    'outside/global.d.ts': 'declare function outsideAmbient(): number;\n',
  }, async (root) => {
    const app = join(root, 'app');
    const { program, status } = createGraphProgram(app, [join(app, 'src/main.ts')]);
    assert.deepEqual(rootFiles(program, app), ['src/main.ts', 'types/inside.d.ts']);
    // 같은 뜻의 `../outside/**/*.d.ts`처럼 경계 밖으로 센다. 예전에는 한 이름으로 읽어 안으로 판정하고 세지 않았다.
    assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false, outsideConfigRoots: 1 });
    const graph = await buildCallGraph(app, createNodeFileSystem());
    assert.ok(graph.limitations.includes(`graph-config: ${outsideRootsGap(1, 'calls')}`), graph.limitations.join('\n'));
    assert.ok(graph.limitations.some((line) => line.includes('incomplete(coverage)')), graph.limitations.join('\n'));
  });
});

test('설정 include 열거는 걷기와 같은 항목 상한에서 멈추고 잘린 사실을 compiler 공백 문구로 알린다', async () => {
  await withProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, include: ['src'] }),
    'src/a.d.ts': 'declare const a: number;\n',
    'src/b.d.ts': 'declare const b: number;\n',
    'src/nested/c.d.ts': 'declare const c: number;\n',
    'src/other/d.d.ts': 'declare const d: number;\n',
  }, (root) => {
    // 방문 항목: 루트 2(tsconfig.json·src) + src 4 + nested 1 + other 1 = 8
    const full = createGraphProgram(root, [], ts.createProgram, undefined, { root, excludedDirectories: new Set(), maxVisitedEntries: 8 });
    assert.deepEqual(rootFiles(full.program, root), ['src/a.d.ts', 'src/b.d.ts', 'src/nested/c.d.ts', 'src/other/d.d.ts']);
    assert.deepEqual(full.status, { configName: 'tsconfig.json', configUnreadable: false });
    // nested에서 상한을 넘으면 그 뒤 other도 열지 않는다.
    const capped = createGraphProgram(root, [], ts.createProgram, undefined, { root, excludedDirectories: new Set(), maxVisitedEntries: 6 });
    assert.deepEqual(rootFiles(capped.program, root), ['src/a.d.ts', 'src/b.d.ts']);
    assert.equal(capped.status.configRootsTruncated, true);
    assert.deepEqual(compilerConfigGaps(capped.status, 'route registrations'), [
      'include patterns of tsconfig.json reached the directory entry limit; later matches were not used as root files; '
        + 'type resolution and route registrations may be incomplete',
    ]);
  });
});

test('목록을 읽지 못한 include 디렉터리는 TypeScript처럼 비어 있는 것으로 보고 나머지 루트를 쓴다', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  await withProject({
    'tsconfig.json': JSON.stringify({ compilerOptions: { types: [] }, include: ['src'] }),
    'src/a.d.ts': 'declare const a: number;\n',
    'src/locked/b.d.ts': 'declare const b: number;\n',
  }, (root) => {
    chmodSync(join(root, 'src/locked'), 0o000);
    try {
      const { program, status } = createGraphProgram(root, []);
      assert.deepEqual(rootFiles(program, root), ['src/a.d.ts']);
      assert.deepEqual(status, { configName: 'tsconfig.json', configUnreadable: false });
    } finally {
      chmodSync(join(root, 'src/locked'), 0o755);
    }
  });
});

test('tsconfig가 없거나 읽지 못하면 자동 타입 루트를 실행 위치가 아니라 프로젝트 루트와 그 조상에서 찾는다', async (t) => {
  const source = 'export const a = 1;\n';
  await withProject({
    ...typesPackage('runner', 'runner-only', 'declare function runnerAmbient(): number;\n'),
    'plain/src/a.ts': source,
    ...typesPackage('own', 'own-only', 'declare function ownAmbient(): number;\n'),
    'own/src/a.ts': source,
    'broken/tsconfig.json': '{',
    ...typesPackage('broken', 'own-only', 'declare function ownAmbient(): number;\n'),
    'broken/src/a.ts': source,
    ...typesPackage('nested', 'parent-only', 'declare function parentAmbient(): number;\n'),
    'nested/app/src/a.ts': source,
    // 설정이 루트에 있으면 TypeScript가 설정 디렉터리를 쓴다. 설정이 없을 때 맞춰야 하는 기준이다.
    'configured/tsconfig.json': JSON.stringify({ include: ['src'] }),
    ...typesPackage('configured', 'own-only', 'declare function ownAmbient(): number;\n'),
    'configured/src/a.ts': source,
  }, (root) => {
    t.mock.method(ts.sys, 'getCurrentDirectory', () => join(root, 'runner'));
    const typeFiles = (project: string): string[] => {
      const directory = join(root, project);
      return createGraphProgram(directory, [join(directory, 'src/a.ts')]).program.getSourceFiles()
        .map((file) => relative(root, file.fileName))
        .filter((path) => !path.startsWith('..') && path.includes('node_modules/@types/'))
        .sort();
    };
    assert.deepEqual(typeFiles('plain'), []);
    assert.deepEqual(typeFiles('own'), ['own/node_modules/@types/own-only/index.d.ts']);
    assert.deepEqual(typeFiles('broken'), ['broken/node_modules/@types/own-only/index.d.ts']);
    assert.deepEqual(typeFiles('nested/app'), ['nested/node_modules/@types/parent-only/index.d.ts']);
    assert.deepEqual(typeFiles('configured'), ['configured/node_modules/@types/own-only/index.d.ts']);
  });
});

test('tsconfig 없는 프로젝트의 graph 출력은 실행 위치와 무관하고 프로젝트 자신의 @types를 쓴다', async () => {
  await withProject({
    ...typesPackage('project', 'own-only', 'declare function ownAmbient(): number;\n'),
    'project/src/a.ts': 'export function run(): number {\n  return ownAmbient();\n}\n',
    'runner/README.txt': 'node_modules가 없는 실행 위치\n',
  }, (root) => {
    const run = (cwd: string) => spawnSync(process.execPath, [
      mainPath, 'graph', '--project', join(root, 'project'), '--generated-at', '2026-01-01T00:00:00.000Z',
    ], { cwd, encoding: 'utf8', timeout: 60_000 });
    const fromRunner = run(join(root, 'runner'));
    const fromProject = run(join(root, 'project'));
    assert.equal(fromRunner.status, 0, fromRunner.stderr);
    assert.equal(fromProject.status, 0, fromProject.stderr);
    assert.equal(fromRunner.stdout, fromProject.stdout);
    assert.equal((JSON.parse(fromRunner.stdout) as { statistics: { calls: { external: number } } }).statistics.calls.external, 1);
  });
});
