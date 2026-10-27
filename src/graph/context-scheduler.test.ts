import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';
import { createGraphPrograms } from './program.ts';

/** 유효한 서로 다른 ambient 문맥도 총 개수 때문에 모든 의미 간선을 잃지 않는다. */
test('serial contexts retain checker-resolved calls after the former global context budget', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-semantic-contexts-')));
  try {
    for (let index = 0; index < 17; index++) {
      const directory = join(root, `p${index}`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { types: [], lib: ['ES2022'], strict: true },
        files: ['ambient.d.ts', 'main.ts', 'target.ts'],
      }));
      writeFileSync(join(directory, 'ambient.d.ts'), `export {}; declare global { interface LocalBrand { value: ${index}; } }`);
      writeFileSync(join(directory, 'main.ts'), 'import { target } from "./target"; export function main() { return target(); }');
      writeFileSync(join(directory, 'target.ts'), `export function target(): LocalBrand { return { value: ${index} }; }`);
    }
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(graph.statistics.files, 34, '모든 기존 비선언 소스 범위를 유지한다');
    assert.equal(new Set(graph.nodes.map(node => node.id)).size, graph.nodes.length, '동명 선언은 프로젝트 상대 파일로 구분한다');
    for (let index = 0; index < 17; index++) {
      assert.ok(graph.edges.some(edge => edge.from === `p${index}/main.ts#main`
        && edge.to === `p${index}/target.ts#target` && edge.evidence === 'direct'), `문맥${index}의 실제 checker 호출이 필요하다`);
      assert.ok(!graph.edges.some(edge => edge.from === `p${index}/main.ts#main`
        && edge.to.endsWith('/target.ts#target') && !edge.to.startsWith(`p${index}/`)), '다른 문맥의 동명 함수를 대신 연결하지 않는다');
    }
    assert.equal(graph.statistics.calls.resolved, 17);
    assert.equal(graph.statistics.calls.unresolved['unresolved-import'], 0);
    assert.ok(!graph.limitations.some(line => line.startsWith('analysis-partial: declaration-only;')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 지역 한계 문장이 같아도 direct/bound/candidates의 독립 공백 합계를 잃지 않는다. */
test('semantic context diagnostics retain every mode-adjusted unresolved and boundary count', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-semantic-gaps-')));
  try {
    for (let index = 0; index < 17; index++) {
      const directory = join(root, `p${index}`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [`unavailable-${index}`] }, files: ['main.ts', 'target.ts'] }));
      writeFileSync(join(directory, 'main.ts'), `import { target } from './target';
import { target as foreign } from '../p${(index + 1) % 17}/target';
export function main(callback: () => void) { callback(); foreign(); target(); }`);
      writeFileSync(join(directory, 'target.ts'), 'export function target() {}');
    }
    const graph = await buildCallGraph(root, createNodeFileSystem());
    const total = Object.values(graph.statistics.calls.unresolved).reduce((sum, count) => sum + count, 0);
    assert.equal(total, 34);
    const reported = (lines: readonly string[]) => lines.reduce((sum, line) => sum + Number(/^unresolved-calls: (\d+) /u.exec(line)?.[1] ?? 0), 0);
    assert.equal(reported(graph.limitations), total, 'snapshot은 지역 문자열 중복 제거로 합계를 줄이지 않는다');
    for (const mode of ['direct', 'bound', 'candidates'] as const) {
      const unresolved = graph.nodes.reduce((sum, node) => sum + (node.unresolvedCalls?.[mode] ?? 0), 0);
      assert.equal(reported(graph.limitationsByMode[mode]), unresolved, `${mode}의 실제 node 공백과 같은 합계를 유지한다`);
    }
    const boundaryLines = graph.limitations.filter(line => line.startsWith('graph-config: config-context-boundary:'));
    assert.ok(boundaryLines.some(line => line.includes('compiler-context:')) || boundaryLines.some(line => line.includes('17 import(s)')),
      '경계 계수는 문맥별 범위를 남기거나 전체 합으로 보고한다');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** compact 경로도 JS JSDoc·ambient 타입·진단을 같은 roots의 기본 compiler와 대조한다. */
test('compact contexts preserve JSDoc type semantics and semantic diagnostics', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-semantic-jsdoc-')));
  const paths: string[] = [];
  try {
    for (let index = 0; index < 17; index++) {
      const directory = join(root, `p${index}`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
        types: [], lib: ['ES2022'], strict: true, allowJs: true,
      }, files: ['ambient.d.ts', 'target.ts', 'api.js'] }));
      writeFileSync(join(directory, 'ambient.d.ts'), `export {}; declare global { interface LocalBrand { value: ${index}; } }`);
      writeFileSync(join(directory, 'target.ts'), `/** @deprecated text only */
export function target(value: number): LocalBrand { return { value: ${index} }; }
export type Output = LocalBrand;
/** @see {@link MissingLink} */ export const documented = 1;`);
      writeFileSync(join(directory, 'api.js'), `import { target } from './target';
/** @typedef {{value: number}} Payload */
/** @typedef {import('./target').Output} Output */
export const schema = undefined;
/** @param {Payload} value @returns {Output} */
export function invoke(value) { return target(value.value); }
/** @overload @param {string} value @returns {string} */
/** @overload @param {number} value @returns {number} */
/** @param {string | number} value @returns {string | number} */
export function pick(value) { return value; }`);
      paths.push(join(directory, 'ambient.d.ts'), join(directory, 'target.ts'), join(directory, 'api.js'));
    }
    for (const context of createGraphPrograms(root, paths)) {
      assert.equal(context.status.compactDocumentation, true);
      const actual = context.program;
      const pristine = ts.createProgram({ rootNames: actual.getRootFileNames(), options: actual.getCompilerOptions(),
        host: ts.createCompilerHost(actual.getCompilerOptions(), true) });
      const summarize = (program: ts.Program) => {
        const checker = program.getTypeChecker();
        const js = program.getSourceFiles().find(file => file.fileName.endsWith('/api.js'))!;
        const declaration = js.statements.find(ts.isFunctionDeclaration)!;
        const signature = checker.getSignatureFromDeclaration(declaration)!;
        const overloaded = js.statements.filter(ts.isFunctionDeclaration).find(statement => statement.name?.text === 'pick')!;
        return { parameter: checker.typeToString(checker.getTypeAtLocation(declaration.parameters[0]!)),
          returnType: checker.typeToString(signature.getReturnType()),
          jsTags: ts.getJSDocTags(declaration).map(tag => tag.tagName.text),
          overloads: checker.getTypeAtLocation(overloaded.name!).getCallSignatures().map(item => checker.signatureToString(item)),
          diagnostics: program.getSemanticDiagnostics().map(diagnostic => ({ code: diagnostic.code,
            start: diagnostic.start, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') })) };
      };
      assert.deepEqual(summarize(actual), summarize(pristine));
      assert.deepEqual(summarize(actual).jsTags, ['param', 'returns']);
      assert.equal(summarize(actual).overloads.length, 2);
      const target = actual.getSourceFiles().find(file => file.fileName.endsWith('/target.ts'))!.statements.find(ts.isFunctionDeclaration)!;
      const pristineTarget = pristine.getSourceFile(target.getSourceFile().fileName)!.statements.find(ts.isFunctionDeclaration)!;
      assert.ok(ts.getJSDocTags(pristineTarget).some(tag => tag.tagName.text === 'deprecated'));
      assert.ok(!ts.getJSDocTags(target).some(tag => tag.tagName.text === 'deprecated'), '문서 AST만 생략한 실제 compact 경로를 검증한다');
      break;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
