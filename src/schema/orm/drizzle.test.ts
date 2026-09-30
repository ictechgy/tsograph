import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractProject } from '../testing.test.ts';
import { ormLines, usrLines } from './testing.test.ts';
import { toCamelCase, toSnakeCase } from './drizzle-catalog.ts';

/** pg 스키마 파일 하나다. */
const pgSchema = [
  "import { pgTable, pgSchema, pgView, text, integer, serial, index } from 'drizzle-orm/pg-core';",
  "import { relations } from 'drizzle-orm';",
  "const auth = pgSchema('auth');",
  'const audit = { createdAt: integer(), note: text(\'audit_note\') };',
  "export const users = pgTable('users', { id: serial('id').primaryKey(), fullName: text(), ...audit }, (t) => [index('i').on(t.fullName)]);",
  "export const sessions = auth.table('sessions', { id: text().primaryKey(), userId: integer('user_id') });",
  "export const activeUsers = pgView('active_users', { id: integer() }).existing();",
  "export const odd = pgTable('a.b', { v: text('x') });",
  'export const usersRelations = relations(users, ({ many }) => ({ sessions: many(sessions) }));',
  '',
].join('\n');

test('테이블·스키마·뷰·스프레드 컬럼 선언을 #model: 사실로 낸다', () => {
  const lines = ormLines({ 'src/schema.ts': pgSchema });
  for (const expected of [
    'src/schema.ts:5:30 users @src/schema.ts#model:users',
    'src/schema.ts:5:41 users.id @src/schema.ts#model:users.id',
    'src/schema.ts:5:72 users.fullName @src/schema.ts#model:users.fullName',
    'src/schema.ts:4:17 users.createdAt @src/schema.ts#model:users.createdAt',
    'src/schema.ts:4:39 users.audit_note @src/schema.ts#model:users.note',
    'src/schema.ts:6:36 auth.sessions @src/schema.ts#model:sessions',
    'src/schema.ts:6:75 auth.sessions.user_id @src/schema.ts#model:sessions.userId',
    'src/schema.ts:7:35 active_users @src/schema.ts#model:activeUsers',
    'src/schema.ts:7:53 active_users.id @src/schema.ts#model:activeUsers.id',
    'src/schema.ts:8:28 a%2Eb @src/schema.ts#model:odd',
    'src/schema.ts:8:37 a%2Eb.x @src/schema.ts#model:odd.v',
  ]) {
    assert.ok(lines.includes(expected), expected);
  }
});

test('쿼리 빌더·컬럼 접근·값 객체 키·관계형 쿼리를 사용 사실로 낸다', () => {
  const lines = ormLines({
    'src/schema.ts': pgSchema,
    'src/db.ts': [
      "import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';",
      "import * as schema from './schema';",
      'export const db = drizzle(process.env.URL!, { schema });',
      'export type Db = NodePgDatabase<typeof schema>;',
      '',
    ].join('\n'),
    'src/repo.ts': [
      "import { eq } from 'drizzle-orm';",
      "import { db, type Db } from './db';",
      "import { users, sessions } from './schema';",
      'export async function all(client: Db) {',
      '  await db.update(users).set({ fullName: \'x\', unknown: 1 }).where(eq(users.id, 1));',
      "  await db.insert(sessions).values([{ id: 'a', userId: 1 }]);",
      '  await db.$count(users);',
      '  await db.transaction(async (tx) => tx.delete(sessions));',
      '  return client.query.users.findMany({ columns: { fullName: true }, with: { sessions: { columns: { userId: true } } } });',
      '}',
      'export const cache = new Map<string, number>();',
      "export function drop(key: string) { cache.delete(key); return new Map([[1, 2]]).get(1); }",
      '',
    ].join('\n'),
  }).filter((line) => line.startsWith('src/repo.ts'));
  assert.deepEqual(lines, [
    'src/repo.ts:5:19 users @src/repo.ts#all',
    'src/repo.ts:5:32 users.fullName @src/repo.ts#all',
    'src/repo.ts:5:76 users.id @src/repo.ts#all',
    'src/repo.ts:6:19 auth.sessions @src/repo.ts#all',
    'src/repo.ts:6:39 auth.sessions.id @src/repo.ts#all',
    'src/repo.ts:6:48 auth.sessions.user_id @src/repo.ts#all',
    'src/repo.ts:7:19 users @src/repo.ts#all',
    'src/repo.ts:8:48 auth.sessions @src/repo.ts#all.db.transaction()',
    'src/repo.ts:9:23 users @src/repo.ts#all',
    'src/repo.ts:9:51 users.fullName @src/repo.ts#all',
    'src/repo.ts:9:77 auth.sessions @src/repo.ts#all',
    'src/repo.ts:9:100 auth.sessions.user_id @src/repo.ts#all',
  ]);
});

test('casing 옵션은 키 이름 컬럼에만 적용되고, 값이 엇갈리면 키 이름 컬럼을 내지 않는다', () => {
  const schema = "import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';\nexport const t = sqliteTable('t', { createdAt: integer(), fixedName: integer('Fixed') });\n";
  const camel = ormLines({
    'src/schema.ts': schema.replace('createdAt', 'created_at'),
    'src/db.ts': "import { drizzle } from 'drizzle-orm/libsql';\nconst options = { casing: 'camelCase' } as const;\nexport const db = drizzle({ connection: { url: 'x' }, ...{}, casing: 'camelCase' });\nexport const other = drizzle('x', options);\n",
  });
  assert.ok(camel.includes('src/schema.ts:2:37 t.createdAt @src/schema.ts#model:t.created_at'));
  const mixed = extractProject({
    'src/schema.ts': schema,
    'src/a.ts': "import { drizzle } from 'drizzle-orm/libsql';\nexport const a = drizzle('x', { casing: 'snake_case' });\n",
    'src/b.ts': "import { drizzle } from 'drizzle-orm/libsql';\nexport const b = drizzle('x');\n",
  });
  assert.deepEqual(usrLines(mixed).filter((line) => line.includes('#model:t.')), ['src/schema.ts:2:59 t.Fixed @src/schema.ts#model:t.fixedName']);
  assert.ok(mixed.limitations.some((line) => line.startsWith('orm-naming-unverified: drizzle: the casing option differs')));
});

test('drizzle.config의 casing을 읽고, 비리터럴이면 확정하지 않는다', () => {
  const schema = "import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';\nexport const t = sqliteTable('t', { createdAt: integer() });\n";
  const configured = ormLines({
    'src/schema.ts': schema,
    'drizzle.config.ts': "import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ dialect: 'sqlite', casing: 'snake_case' });\n",
  });
  assert.ok(configured.includes('src/schema.ts:2:37 t.created_at @src/schema.ts#model:t.createdAt'));
  const local = ormLines({
    'src/schema.ts': schema,
    'drizzle.config.ts': "const config = { casing: 'snake_case' };\nexport default config;\n",
  });
  assert.ok(local.includes('src/schema.ts:2:37 t.created_at @src/schema.ts#model:t.createdAt'));
  const unknown = extractProject({
    'src/schema.ts': schema,
    'drizzle.config.ts': "export default { casing: process.env.CASING };\n",
  });
  assert.ok(unknown.limitations.some((line) => line.startsWith('orm-naming-unverified: drizzle:')));
  const reexported = ormLines({ 'src/schema.ts': schema, 'drizzle.config.ts': "export { default } from './base.config';\n" });
  assert.ok(reexported.includes('src/schema.ts:2:37 t.createdAt @src/schema.ts#model:t.createdAt'));
});

test('이름 생성기·비리터럴 이름은 정적으로 풀거나 dynamic으로 낸다', () => {
  const result = extractProject({
    'src/schema.ts': [
      "import { pgTableCreator, pgTable, pgSchema, text } from 'drizzle-orm/pg-core';",
      "const prefixed = pgTableCreator((name) => 'pre_' + name);",
      'const templated = pgTableCreator(function (name) { return `t_${name}_x`; });',
      'const opaque = pgTableCreator((name) => name.toUpperCase());',
      'const plain = pgTableCreator((name) => name);',
      'declare const dynamicName: string;',
      'const scoped = pgSchema(dynamicName);',
      "export const a = prefixed('a', { v: text(dynamicName) });",
      "export const b = templated('b', { v: text() });",
      "export const c = opaque('c', { v: text() });",
      "export const d = plain('d', {});",
      'export const e = pgTable(dynamicName, { v: text() });',
      "export const f = scoped.table('f', { v: text() });",
      "export const g = pgTable('g', columnsFromElsewhere());",
      "export const h = pgTable('h', { [dynamicName]: text(), ok: text().notNull() });",
      'declare function columnsFromElsewhere(): any;',
      '',
    ].join('\n'),
  });
  const lines = usrLines(result);
  for (const expected of [
    'src/schema.ts:8:27 pre_a @src/schema.ts#model:a',
    'src/schema.ts:9:28 t_b_x @src/schema.ts#model:b',
    "src/schema.ts:10:25 opaque('c', { v: text() }) dyn @src/schema.ts#model:c",
    'src/schema.ts:11:24 d @src/schema.ts#model:d',
    'src/schema.ts:9:35 t_b_x.v @src/schema.ts#model:b.v',
    'src/schema.ts:12:26 pgTable(dynamicName, { v: text() }) dyn @src/schema.ts#model:e',
    "src/schema.ts:13:31 scoped.table('f', { v: text() }) dyn @src/schema.ts#model:f",
    'src/schema.ts:14:26 g @src/schema.ts#model:g',
    'src/schema.ts:15:56 h.ok @src/schema.ts#model:h.ok',
  ]) {
    assert.ok(lines.includes(expected), expected);
  }
  assert.ok(!lines.some((line) => line.includes('pre_a.')));
  assert.ok(result.limitations.includes('unreadable-orm-declarations: 3 ORM declaration part(s) (spreads, computed keys, non-literal names or options) could not be read statically and were not emitted: drizzle (3)'));
  assert.ok(result.limitations.some((line) => line.startsWith('dynamic-relation-names: 3 ')));
});

test('관계형 쿼리: 스키마를 못 풀면 유일한 변수 이름으로 찾고, 모르는 키는 dynamic, 모르는 수신자는 센다', () => {
  const result = extractProject({
    'src/a.ts': "import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';\nexport const items = sqliteTable('item_rows', { id: integer() });\nexport const dup = sqliteTable('dup_a', { id: integer() });\n",
    'src/b.ts': "import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';\nconst dup = sqliteTable('dup_b', { id: integer() });\nexport { dup as dupB };\n",
    'src/q.ts': [
      "import { drizzle } from 'drizzle-orm/d1';",
      'export async function run(binding: D1Database, other: any) {',
      '  const db = drizzle(binding, { schema: loadSchema() });',
      '  await db.query.items.findFirst();',
      '  await db.query.dup.findMany();',
      '  await db.query.missing.findMany();',
      '  return other.query.items.findMany();',
      '}',
      'declare function loadSchema(): any;',
      '',
    ].join('\n'),
  });
  const lines = usrLines(result).filter((line) => line.startsWith('src/q.ts'));
  assert.deepEqual(lines, [
    'src/q.ts:4:18 item_rows @src/q.ts#run',
    'src/q.ts:5:18 db.query.dup dyn @src/q.ts#run',
    'src/q.ts:6:18 db.query.missing dyn @src/q.ts#run',
  ]);
  assert.ok(result.limitations.includes('unresolved-orm-receivers: 1 ORM call(s) have a query shape but receivers that could not be traced to a model, repository, or client; not emitted: drizzle (1)'));
});

test('sql 태그 템플릿: 테이블·컬럼 보간, raw·identifier·empty, 중첩 조각을 펼친다', () => {
  const lines = ormLines({
    'src/schema.ts': "import { pgTable, pgTableCreator, text } from 'drizzle-orm/pg-core';\nexport const users = pgTable('users', { name: text('user_name') });\nexport const odd = pgTable('a.b', { v: text() });\nexport const hidden = pgTableCreator((n) => n.trim())('hidden', {});\n",
    'src/q.ts': [
      "import { sql } from 'drizzle-orm';",
      "import { users, odd, hidden } from './schema';",
      'export function fragments(id: number) {',
      '  const where = sql`${users.name} = ${id}`;',
      "  return sql`select ${users.name} from ${users} join ${sql.raw('raw_table')} on true join ${sql.identifier('ident_table')} on true ${sql`join ${odd} on true`}${sql.empty()} ${where}`;",
      '}',
      'export function hiddenTable() { return sql`select 1 from ${hidden}`; }',
      "export function notSql() { return sql.join([sql.raw(String(1))]); }",
      '',
    ].join('\n'),
  }).filter((line) => line.startsWith('src/q.ts'));
  assert.deepEqual(lines, [
    'src/q.ts:4:29 users.user_name @src/q.ts#fragments',
    'src/q.ts:5:13 a%2Eb @src/q.ts#fragments',
    'src/q.ts:5:13 ident_table @src/q.ts#fragments',
    'src/q.ts:5:13 raw_table @src/q.ts#fragments',
    'src/q.ts:5:13 users @src/q.ts#fragments',
    'src/q.ts:5:29 users.user_name @src/q.ts#fragments',
    'src/q.ts:7:43 select 1 from ? dyn @src/q.ts#hiddenTable',
  ]);
});

test('Drizzle casing 변환은 라이브러리 함수와 같다', () => {
  assert.equal(toSnakeCase('bodyHTML'), 'body_html');
  assert.equal(toSnakeCase("user'sName2"), 'users_name2');
  assert.equal(toCamelCase('created_at'), 'createdAt');
  assert.equal(toCamelCase('HTTPRequest'), 'httpRequest');
  assert.equal(toCamelCase(''), '');
});
