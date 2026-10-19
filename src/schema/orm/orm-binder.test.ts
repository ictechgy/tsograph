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

/**
 * 콜백을 실행하는 동안 모듈 지정자 해석(`OrmBinder.moduleOrigin`) 호출 수를 세고, 상한을 넘으면 즉시 실패시킨다.
 * require 재수출 사슬 한 단계마다 한 번 불리므로, 사슬을 다시 따라가는 구현이 고리에서 지수적으로 늘어 테스트를
 * 붙잡아 두지 않고 바로 빨간불이 되게 하려는 장치다.
 *
 * @param limit 허용하는 호출 수
 * @param run 실행할 콜백
 * @returns 콜백 결과
 */
function withModuleOriginBudget<T>(limit: number, run: () => T): T {
  const original = OrmBinder.prototype.moduleOrigin;
  let calls = 0;
  OrmBinder.prototype.moduleOrigin = function moduleOriginWithBudget(this: OrmBinder, specifier, importer) {
    calls++;
    if (calls > limit) throw new Error(`module resolution exceeded ${limit} calls; require re-export chains are followed again`);
    return original.call(this, specifier, importer);
  };
  try {
    return run();
  } finally {
    OrmBinder.prototype.moduleOrigin = original;
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

test('순환 require 재수출 안에서 끊어 만든 export 표는 다른 파일에서 시작한 해석에 다시 쓰지 않는다', () => {
  // `a.x`를 먼저 풀면 b의 표는 a를 계산하는 중에 만들어져 `b.x`(= a.z)가 끊긴다. 그 표를 b 자신의 표로 다시 쓰면
  // 뒤의 `b.x`가 모르는 값이 되어 via_b 사실이 사라진다. b에서 시작하면 a.z는 순환 없이 풀린다.
  const lines = ormLines({
    'src/a.ts': "import { Pool } from 'pg';\nexport const x = require('./b').x;\nexport const z = new Pool();\n",
    'src/b.ts': "export const x = require('./a').z;\nexport const w = require('./a').x;\n",
    'src/db.ts': [
      "import * as a from './a';",
      "import * as b from './b';",
      'export async function q() {',
      "  await a.x.query('select * from via_a');",
      "  await b.w.query('select * from via_w');",
      "  return b.x.query('select * from via_b');",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, ['src/db.ts:6:20 via_b @src/db.ts#q']);
});

test('require 재수출 고리는 export마다 한 번만 따라가고, 고리로만 이어진 멤버는 모르는 값이다', () => {
  // 파일 12개가 export 6개씩을 다음 파일에서 require로 재수출한다. 표를 export마다 다시 만들면 6^12번 따라간다.
  const files: Record<string, string> = {};
  for (let file = 0; file < 12; file++) {
    const next = (file + 1) % 12;
    files[`src/f${file}.ts`] = Array.from({ length: 6 }, (_, index) => `export const e${index} = require('./f${next}').e${index};`).join('\n') + '\n';
  }
  files['src/db.ts'] = [
    "import { Pool } from 'pg';",
    "import * as f0 from './f0';",
    "const { e3 } = require('./f7');",
    'const pool = new Pool();',
    'export async function q() {',
    "  await f0.e0.query('select * from ring_rows');",
    "  await e3.query('select * from ring_e3');",
    "  return pool.query('select * from ok_rows');",
    '}',
    '',
  ].join('\n');
  const lines = withModuleOriginBudget(1_000, () => ormLines(files));
  assert.deepEqual(lines, ['src/db.ts:8:21 ok_rows @src/db.ts#q']);
});

test('require 사슬이 이미 들어간 파일로 돌아오는지는 사슬을 시작한 파일마다 따로 판정한다', () => {
  // a에서 시작한 `a.x`는 b.x(Pool)로 풀린다. b에서 시작한 `b.y`는 a.x를 거쳐 b로 돌아오므로 모르는 값이다.
  const lines = ormLines({
    'src/a.ts': "export const x = require('./b').x;\n",
    'src/b.ts': "import { Pool } from 'pg';\nexport const x = new Pool();\nexport const y = require('./a').x;\n",
    'src/db.ts': [
      "import * as a from './a';",
      "import * as b from './b';",
      'export async function q() {',
      "  await a.x.query('select * from from_a');",
      "  return b.y.query('select * from from_b');",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, ['src/db.ts:4:19 from_a @src/db.ts#q']);
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
