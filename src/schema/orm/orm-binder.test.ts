import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { test } from 'node:test';

import type ts from 'typescript';

import { OrmBinder } from './orm-binder.ts';
import { ormLines } from './testing.test.ts';

/**
 * 콜백을 실행하는 동안 `OrmBinder.exportsOf`가 파일마다 돌려준 서로 다른 표의 수를 센다. 표를 다시 계산하면 호출마다
 * 새 표가 나오므로, 실행 시간 대신 이 수로 export 표를 다시 만드는지 결정적으로 본다.
 *
 * @param run 실행할 콜백
 * @returns 콜백 결과와 파일 이름 → 서로 다른 표 수·호출 수
 */
function countExportTables<T>(run: () => T): { readonly result: T; readonly tables: Map<string, { distinct: number; calls: number }> } {
  const original = OrmBinder.prototype.exportsOf;
  const seen = new Map<ts.SourceFile, Set<unknown>>();
  const calls = new Map<ts.SourceFile, number>();
  OrmBinder.prototype.exportsOf = function countedExportsOf(this: OrmBinder, sourceFile) {
    const table = original.call(this, sourceFile);
    seen.set(sourceFile, (seen.get(sourceFile) ?? new Set()).add(table));
    calls.set(sourceFile, (calls.get(sourceFile) ?? 0) + 1);
    return table;
  };
  try {
    const result = run();
    const tables = new Map([...seen].map(([file, distinct]) => [basename(file.fileName), { distinct: distinct.size, calls: calls.get(file)! }]));
    return { result, tables };
  } finally {
    OrmBinder.prototype.exportsOf = original;
  }
}

test('서로를 require로 재수출하는 모듈의 export 표는 끝없이 펼치지 않고 순환 멤버를 모르는 값으로 둔다', () => {
  const lines = ormLines({
    'src/db.ts': [
      "import { Pool } from 'pg';",
      "import * as a from './a';",
      "const { y } = require('./b');",
      'const pool = new Pool();',
      'export async function q() {',
      "  await a.x.query('select * from cycle_x');",
      "  await y.query('select * from cycle_y');",
      "  return pool.query('select * from ok_rows');",
      '}',
      '',
    ].join('\n'),
    'src/a.ts': "export const x = require('./b').x;\nexport const { y } = require('./b');\n",
    'src/b.ts': "export const x = require('./a').x;\nexport const y = require('./a').y;\n",
  });
  assert.deepEqual(lines, ['src/db.ts:8:21 ok_rows @src/db.ts#q']);
});

test('모듈 export 표는 파일마다 한 번만 만들어 이름공간 접근·require 구조 분해·관계형 쿼리 스키마가 함께 쓴다', () => {
  const tables = Array.from({ length: 4 }, (_, index) => `export const t${index} = sqliteTable('t${index}_rows', { id: integer() });`);
  const uses = Array.from({ length: 4 }, (_, index) => `  await db.select().from(schema.t${index});\n  await db.query.t${index}.findMany();`);
  const { result, tables: counted } = countExportTables(() => ormLines({
    'src/schema.ts': ["import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';", ...tables, ''].join('\n'),
    'src/db.ts': "import { drizzle } from 'drizzle-orm/libsql';\nimport * as schema from './schema';\nexport const db = drizzle('file:x', { schema });\n",
    'src/q.ts': [
      "import * as schema from './schema';",
      "import { db } from './db';",
      "const { t0 } = require('./schema');",
      'export async function run() {',
      ...uses,
      '  return db.delete(t0);',
      '}',
      '',
    ].join('\n'),
  }));
  const schema = counted.get('schema.ts');
  assert.ok(schema !== undefined && schema.calls > 1, JSON.stringify(schema));
  assert.equal(schema.distinct, 1, `${schema.calls} calls built ${schema.distinct} export tables`);
  assert.deepEqual(result, [
    'src/q.ts:5:26 t0_rows @src/q.ts#run',
    'src/q.ts:6:18 t0_rows @src/q.ts#run',
    'src/q.ts:7:26 t1_rows @src/q.ts#run',
    'src/q.ts:8:18 t1_rows @src/q.ts#run',
    'src/q.ts:9:26 t2_rows @src/q.ts#run',
    'src/q.ts:10:18 t2_rows @src/q.ts#run',
    'src/q.ts:11:26 t3_rows @src/q.ts#run',
    'src/q.ts:12:18 t3_rows @src/q.ts#run',
    'src/q.ts:13:20 t0_rows @src/q.ts#run',
    'src/schema.ts:2:31 t0_rows @src/schema.ts#model:t0',
    'src/schema.ts:2:44 t0_rows.id @src/schema.ts#model:t0.id',
    'src/schema.ts:3:31 t1_rows @src/schema.ts#model:t1',
    'src/schema.ts:3:44 t1_rows.id @src/schema.ts#model:t1.id',
    'src/schema.ts:4:31 t2_rows @src/schema.ts#model:t2',
    'src/schema.ts:4:44 t2_rows.id @src/schema.ts#model:t2.id',
    'src/schema.ts:5:31 t3_rows @src/schema.ts#model:t3',
    'src/schema.ts:5:44 t3_rows.id @src/schema.ts#model:t3.id',
  ]);
});

test('모듈이 아닌 스크립트를 require하면 export 표는 비고, 그 빈 표도 파일마다 한 번만 만든다', () => {
  const { result, tables } = countExportTables(() => ormLines({
    'src/plain.ts': 'const local = 1;\n',
    'src/db.ts': [
      "import { Pool } from 'pg';",
      "const plain = require('./plain');",
      'const pool = new Pool();',
      'export async function q() {',
      "  await plain.x.query('select * from script_x');",
      "  await plain.y.query('select * from script_y');",
      "  return pool.query('select * from ok_rows');",
      '}',
      '',
    ].join('\n'),
  }));
  const plain = tables.get('plain.ts');
  assert.ok(plain !== undefined && plain.calls > 1, JSON.stringify(plain));
  assert.equal(plain.distinct, 1, `${plain.calls} calls built ${plain.distinct} export tables`);
  assert.deepEqual(result, ['src/db.ts:7:21 ok_rows @src/db.ts#q']);
});
