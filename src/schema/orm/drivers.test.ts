import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractProject } from '../testing.test.ts';
import { ormLines, usrLines } from './testing.test.ts';

test('knex 사슬·원시 드라이버·SQL 태그·D1 바인딩(선언 파일·구조 분해·세션·모양)을 읽는다', () => {
  const result = extractProject({
  'worker-configuration.d.ts': 'interface Env { MAIN_DB: D1Database; CACHE: KVNamespace }\n',
  'src/knex.js': [
    "const db = require('knex')({ client: 'mysql2' });",
    "const TABLES = { users: 'app_users' };",
    'async function k(trx) {',
    "  const t = await db.transaction();",
    "  await t(TABLES.users).where({ 'app_users.id': 1 }).first('email as e', '*');",
    "  await db.withSchema('s1').select('x').from('main').join('joined', 'main.id', '=', 'joined.main_id');",
    "  await db.select('a').from(function () { this.from('sub'); }).as('q');",
    "  await db.schema.createTable('ddl_only', () => {});",
    '  await db(dynamicTable());',
    '}',
    'module.exports = { k };',
    '',
  ].join('\n'),
  'src/drivers.ts': [
    "import * as pg from 'pg';",
    "import type { PoolClient } from 'pg';",
    "import mysql from 'mysql';",
    "import sqlite3 from 'sqlite3';",
    "import { createClient } from '@libsql/client';",
    "import { neon, Pool as NeonPool } from '@neondatabase/serverless';",
    "import { sql as vercelSql, db as vercelDb, createPool } from '@vercel/postgres';",
    "import { connect } from '@planetscale/database';",
    "import postgres from 'postgres';",
    "const SELECT_SQL = 'select * from shared_const';",
    'export async function all(client: PoolClient, env: Env) {',
    '  const pool = new pg.Pool();',
    "  await pool.query({ text: SELECT_SQL, values: [] });",
    "  await client.query('insert into pg_log values (1)');",
    "  mysql.createConnection({}).query('select * from my_legacy');",
    "  new (sqlite3.verbose().Database)(':memory:').all('select * from lite_rows');",
    '  const libsql = createClient({ url: "x" });',
    "  await libsql.batch(['delete from lib_a', { sql: 'delete from lib_b', args: [] }], 'write');",
    "  await libsql.execute({ args: [] });",
    '  const sql = neon("x");',
    '  await sql`select * from neon_rows where id = ${1}`;',
    "  await sql.query('select * from neon_query');",
    "  await new NeonPool().query('select * from neon_pool');",
    '  await vercelSql`select * from vercel_rows`;',
    "  await vercelDb.query('select * from vercel_db');",
    "  await createPool().query('select * from vercel_pool');",
    "  await connect({}).execute('select * from ps_rows');",
    '  const pg2 = postgres("x");',
    '  await pg2.begin(async (tx) => tx`update pj_rows set a = 1 ${tx`where ${tx("col")} = 1`}`);',
    "  await env.MAIN_DB.prepare('select * from d1_main').first();",
    "  await (env as any).OTHER.prepare('select * from d1_shape').all();",
    "  await env.MAIN_DB.batch([env.MAIN_DB.prepare('select * from d1_batch')]);",
    "  return new Map().get('select * from not_sql');",
    '}',
    '',
  ].join('\n'),
  'src/do.ts': [
    'export class Counter {',
    '  constructor(private state: unknown, private env: Env) {}',
    "  async fetch() { await this.env.MAIN_DB.exec('delete from d1_counter'); const session = this.env.MAIN_DB.withSession(); return session.prepare('select * from d1_session').run(); }",
    '}',
    '',
  ].join('\n'),
});
  assert.deepEqual(usrLines(result), [
    'src/do.ts:3:47 d1_counter @src/do.ts#Counter.fetch',
    'src/do.ts:3:145 d1_session @src/do.ts#Counter.fetch',
    'src/drivers.ts:13:28 shared_const @src/drivers.ts#all',
    'src/drivers.ts:14:22 pg_log @src/drivers.ts#all',
    'src/drivers.ts:15:36 my_legacy @src/drivers.ts#all',
    'src/drivers.ts:16:52 lite_rows @src/drivers.ts#all',
    'src/drivers.ts:18:23 lib_a @src/drivers.ts#all',
    'src/drivers.ts:18:51 lib_b @src/drivers.ts#all',
    'src/drivers.ts:19:24 { args: [] } dyn @src/drivers.ts#all',
    'src/drivers.ts:21:12 neon_rows @src/drivers.ts#all',
    'src/drivers.ts:22:19 neon_query @src/drivers.ts#all',
    'src/drivers.ts:23:30 neon_pool @src/drivers.ts#all',
    'src/drivers.ts:24:18 vercel_rows @src/drivers.ts#all',
    'src/drivers.ts:25:24 vercel_db @src/drivers.ts#all',
    'src/drivers.ts:26:28 vercel_pool @src/drivers.ts#all',
    'src/drivers.ts:27:29 ps_rows @src/drivers.ts#all',
    'src/drivers.ts:29:35 pj_rows @src/drivers.ts#all',
    'src/drivers.ts:30:29 d1_main @src/drivers.ts#all',
    'src/drivers.ts:31:36 d1_shape @src/drivers.ts#all',
    'src/drivers.ts:32:48 d1_batch @src/drivers.ts#all',
    'src/knex.js:5:11 app_users @src/knex.js#k',
    'src/knex.js:5:33 app_users.id @src/knex.js#k',
    'src/knex.js:5:60 app_users.email @src/knex.js#k',
    'src/knex.js:6:46 s1.main @src/knex.js#k',
    'src/knex.js:6:59 s1.joined @src/knex.js#k',
    'src/knex.js:6:69 s1.main.id @src/knex.js#k',
    'src/knex.js:6:85 s1.joined.main_id @src/knex.js#k',
    'src/knex.js:9:12 dynamicTable() dyn @src/knex.js#k',
  ]);
  assert.deepEqual(result.limitations, [
    'dynamic-relation-names: 2 SQL argument(s), relation operand(s), or delegate access(es) were not statically readable; they are emitted as dynamic facts',
    'skipped-sql-literals: 1 ungated literal(s) contained SQL verbs but not the uppercase form required for heuristic scanning; not counted',
  ]);
});

test('D1 바인딩 선언은 구조 분해와 값 복사를 따라가고, 관련 패키지가 없으면 ORM 단계를 건너뛴다', () => {
  const lines = ormLines({
    'src/env.ts': 'export type Bindings = { DB?: D1Database | undefined };\n',
    'src/h.ts': [
      "import type { Bindings } from './env';",
      'export async function handler(c: { env: Bindings }) {',
      '  const { DB: database } = c.env;',
      '  const alias = database;',
      "  return alias!.prepare('select * from h_rows').all();",
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, ['src/h.ts:5:25 h_rows @src/h.ts#handler']);
  assert.deepEqual(ormLines({ 'src/plain.ts': "export const q = 'SELECT * FROM plain_rows';\n" }), ['src/plain.ts:1:18 plain_rows @src/plain.ts#q']);
});
