import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import { createGraphPrograms } from './program.ts';

test('NodeNext import-only exports의 global을 classic resolver 미해결이라는 이유로 다른 앱에 공유하지 않는다', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-mode-review-r3-')));
  const files: Record<string, string> = {
    'tsconfig.json': '{"files":[],"references":[{"path":"a"},{"path":"b"}]}',
    'a/tsconfig.json': '{"compilerOptions":{"types":[],"lib":[],"module":"nodenext","moduleResolution":"nodenext"},"include":["*.mts"]}',
    'b/tsconfig.json': '{"compilerOptions":{"types":[],"lib":[],"module":"nodenext","moduleResolution":"nodenext"},"include":["*.mts"]}',
    'a/main.mts': 'import "import-only"; export function a() { modeGlobal(); }',
    'b/main.mts': 'export function b() { modeGlobal(); }',
    'node_modules/import-only/package.json': '{"name":"import-only","version":"1.0.0","exports":{".":{"import":{"types":"./index.d.mts"}}}}',
    'node_modules/import-only/index.d.mts': 'export {}; declare global { function modeGlobal(): void; }',
  };
  try {
    for (const [path, text] of Object.entries(files)) { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); }
    const a = join(root, 'a/main.mts'), b = join(root, 'b/main.mts');
    const options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
    assert.equal(ts.resolveModuleName('import-only', a, options, ts.sys).resolvedModule, undefined, 'classic undefined-mode control');
    assert.ok(ts.resolveModuleName('import-only', a, options, ts.sys, undefined, undefined, ts.ModuleKind.ESNext).resolvedModule, 'actual import-mode positive control');
    const contexts = [...createGraphPrograms(root, [a, b])];
    const hasGlobal = (path: string): boolean => {
      const context = contexts.find(context => context.ownedSources?.has(path))!;
      let found = false;
      const visit = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === 'modeGlobal') found ||= context.checker.getSymbolAtLocation(node) !== undefined; ts.forEachChild(node, visit); };
      visit(context.program.getSourceFile(path)!); return found;
    };
    assert.equal(hasGlobal(a), true);
    assert.equal(hasGlobal(b), false, 'unrelated app must not acquire the import-only package global');
    assert.equal(contexts.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
