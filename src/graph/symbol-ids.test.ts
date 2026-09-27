import assert from 'node:assert/strict';
import { test } from 'node:test';

import ts from 'typescript';

import { collectModuleExports } from '../routes/module-exports.ts';
import { exportBindingId, moduleScopeId, scopeIdOf } from './symbol-ids.ts';

/**
 * 소스의 내보낸 이름마다 id를 만든다.
 *
 * @param source 소스 텍스트
 * @returns 내보낸 이름 → id
 */
function exportIds(source: string): Record<string, string> {
  const file = ts.createSourceFile('a.ts', source, ts.ScriptTarget.Latest, true);
  const exports = collectModuleExports(file);
  const result: Record<string, string> = {};
  for (const exported of exports.names) result[exported.name] = exportBindingId('src/a.ts', exported.name, exported.node);
  if (exports.defaultExport !== undefined) result.default = exportBindingId('src/a.ts', 'default', exports.defaultExport);
  return result;
}

test('내보낸 이름의 id는 선언 id이거나 내보낸 이름이다', () => {
  assert.deepEqual(exportIds('export function GET() {}\nexport const { POST } = h;\nexport { x as PUT };\n'), {
    GET: 'src/a.ts#GET', POST: 'src/a.ts#POST', PUT: 'src/a.ts#PUT',
  });
  assert.deepEqual(exportIds('export default function handler() {}'), { default: 'src/a.ts#handler' });
  assert.deepEqual(exportIds('export default class Page {}'), { default: 'src/a.ts#Page' });
  assert.deepEqual(exportIds('export default function () {}'), { default: 'src/a.ts#default' });
  assert.deepEqual(exportIds('export default wrap(h);'), { default: 'src/a.ts#default' });
  assert.deepEqual(exportIds('const h = 1;\nexport { h as default };'), { default: 'src/a.ts#default' });
});

test('스코프 id는 감싸는 선언이 없으면 모듈 스코프다', () => {
  const file = ts.createSourceFile('a.ts', 'run();\nfunction f() { go(); }\n', ts.ScriptTarget.Latest, true);
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(scopeIdOf(node, 'src/a.ts'));
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.deepEqual(calls, [moduleScopeId('src/a.ts'), 'src/a.ts#f']);
  assert.equal(moduleScopeId('src/a.ts'), 'src/a.ts#<module>');
});
