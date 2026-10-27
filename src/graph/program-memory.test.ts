import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createNodeFileSystem } from '../cli/file-system.ts';
import { buildCallGraph } from './build-graph.ts';

/** 문맥 수가 많아도 전체 소스를 합치거나 유효한 호출을 일괄 포기하지 않는다. */
test('serial context schedule keeps every owned source without one all-context compiler', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tsograph-context-memory-')));
  const paths: string[] = [];
  try {
    for (let index = 0; index < 17; index++) {
      const directory = join(root, `p${index}`);
      mkdirSync(directory);
      writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { types: [`unavailable-${index}`] }, files: ['main.ts', 'target.ts'] }));
      writeFileSync(join(directory, 'main.ts'), 'import {target} from "./target"; export function main(){target();}');
      writeFileSync(join(directory, 'target.ts'), 'export function target(){}');
      paths.push(join(directory, 'main.ts'), join(directory, 'target.ts'));
    }
    const { createGraphPrograms } = await import('./program.ts');
    const seen = new Set<string>();
    let contexts = 0;
    for (const result of createGraphPrograms(root, paths)) {
      contexts++;
      assert.equal(result.status.contextBudgetExceeded, undefined, '총 그룹 수를 실제 의미 실패로 취급하지 않는다');
      assert.equal(result.status.compactDocumentation, true);
      assert.ok(result.program.getRootFileNames().length <= 2,
        'budget fallback must bound each compiler to its ownership context');
      for (const path of result.ownedSources!) seen.add(path);
    }
    assert.equal(contexts, 17);
    assert.deepEqual([...seen].sort(), [...paths].sort(), 'no selected source is skipped to stay within memory');
    const graph = await buildCallGraph(root, createNodeFileSystem());
    assert.equal(graph.statistics.files, 34);
    assert.equal(graph.statistics.calls.unresolved['unresolved-import'], 0);
    assert.equal(graph.statistics.calls.resolved, 17, '같은 소유 문맥의 실제 호출은 유지한다');
    assert.equal(graph.edges.filter(edge => edge.kinds.includes('call')).length, 17);
    assert.equal(graph.nodes.filter(node => node.id.endsWith('main.ts#main')).length, 17);
    assert.ok(!graph.limitations.some(line => line.startsWith('analysis-partial: declaration-only;')));
    assert.ok(!graph.limitations.some(line => line.includes('config-conflict:')), 'precision-budget blocking must not be mislabeled as actual config-ownership ambiguity');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
