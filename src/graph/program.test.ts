import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { createGraphProgram } from './program.ts';

/**
 * 임시 프로젝트를 만들고 콜백 뒤 지운다.
 *
 * @param files 상대 경로 → 내용
 * @param body 콜백
 */
async function withProject(files: Record<string, string>, body: (root: string) => Promise<void> | void): Promise<void> {
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
      'parse-errors: 1 source file(s) have syntax errors; their calls may be incomplete',
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
