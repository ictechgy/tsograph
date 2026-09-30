import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractProject, factLines, prismaBase } from './testing.test.ts';

/**
 * 스키마 사실을 뺀 소스 사실 줄만 돌려준다.
 *
 * @param files 추가 파일
 * @returns 사실 줄
 */
function sourceFacts(files: Record<string, string>): string[] {
  return factLines(extractProject({ ...prismaBase, ...files })).filter((line) => !line.startsWith('prisma/'));
}

test('모듈에서 export한 클라이언트의 delegate 호출과 인자 키를 읽는다', () => {
  const lines = sourceFacts({
    'src/db.ts': "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n",
    'src/users.ts': [
      "import { prisma } from './db';",
      'export async function findUser(email: string) {',
      '  return prisma.user.findFirst({ where: { email, posts: {} }, select: { id: true } });',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, [
    'src/users.ts:3:17 users @src/users.ts#findUser',
    'src/users.ts:3:43 users.email_address @src/users.ts#findUser',
    'src/users.ts:3:73 users.id @src/users.ts#findUser',
  ]);
});

test('출처를 증명하지 못한 수신자와 같은 이름의 다른 메서드는 사실이 아니다', () => {
  const result = extractProject({
    ...prismaBase,
    'src/other.ts': [
      'const cache = new Map<string, number>();',
      'export function drop(key: string, ctx: any) {',
      '  cache.delete(key);',
      '  return ctx.db.user.findMany();',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(factLines(result).filter((line) => line.startsWith('src/')), []);
  assert.ok(result.limitations.some((line) => line.startsWith('unresolved-client-receivers: 1 ')));
});

test('매개변수·지역 변수가 바깥 클라이언트를 가리면 클라이언트가 아니다', () => {
  const lines = sourceFacts({
    'src/shadow.ts': [
      "import { PrismaClient } from '@prisma/client';",
      'const prisma = new PrismaClient();',
      'export function a(prisma: { user: { findMany(): void } }) { prisma.user.findMany(); }',
      'export function b() { const prisma = { user: 1 }; return prisma.user; }',
      'export function c() { return prisma.post.count(); }',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, ['src/shadow.ts:5:37 Post @src/shadow.ts#c']);
});

test('트랜잭션 콜백·TransactionClient 타입·클래스 필드·팩토리·$extends를 추적한다', () => {
  const lines = sourceFacts({
    'src/db.ts': [
      "import { PrismaClient, Prisma } from '@prisma/client';",
      'type Tx = Prisma.TransactionClient;',
      'type Db = Omit<PrismaClient, "$connect"> | undefined;',
      'function make(): PrismaClient { return new PrismaClient(); }',
      'const base = make();',
      'const extended = base.$extends({});',
      'export async function run(tx: Tx, db: Db) {',
      '  await base.$transaction(async (inner) => inner.user.count());',
      '  await tx.post.count();',
      '  await db!.post.count();',
      '  await extended.user.count();',
      '}',
      'export class Repo {',
      '  private readonly field: PrismaClient = base;',
      '  constructor(private readonly db: PrismaClient) {}',
      '  list() { return [this.db.user.findMany(), this.field.post.findMany()]; }',
      '  detached() { return function () { return this.db.user.findMany(); }; }',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, [
    'src/db.ts:8:50 users @src/db.ts#run',
    'src/db.ts:9:12 Post @src/db.ts#run',
    'src/db.ts:10:13 Post @src/db.ts#run',
    'src/db.ts:11:18 users @src/db.ts#run',
    'src/db.ts:16:28 users @src/db.ts#Repo.list',
    'src/db.ts:16:56 Post @src/db.ts#Repo.list',
  ]);
});

test('$queryRaw 태그 템플릿은 보간을 바인드 파라미터로 보고 관계 자리 보간만 dynamic이다', () => {
  const result = extractProject({
    ...prismaBase,
    'src/raw.ts': [
      "import { PrismaClient, Prisma } from '@prisma/client';",
      'const prisma = new PrismaClient();',
      'const tail = Prisma.sql`ORDER BY id`;',
      'export async function q(id: number, table: string) {',
      '  await prisma.$queryRaw`SELECT * FROM users u JOIN "Post" p ON p."authorId" = u.id WHERE u.id = ${id} ${tail}`;',
      '  await prisma.$executeRaw`DELETE FROM ${Prisma.raw(\'"Post"\')} WHERE id = ${id}`;',
      '  await prisma.$queryRaw`SELECT 1 FROM ${table}`;',
      '  await prisma.$queryRaw(Prisma.sql`SELECT * FROM ${Prisma.sql`users`}${Prisma.empty}`);',
      '  await prisma.$queryRaw(tail);',
      '  await prisma.$queryRaw(buildQuery());',
      '}',
      'declare function buildQuery(): any;',
      '',
    ].join('\n'),
  });
  assert.deepEqual(factLines(result).filter((line) => line.startsWith('src/')), [
    'src/raw.ts:5:25 Post @src/raw.ts#q',
    'src/raw.ts:5:25 users @src/raw.ts#q',
    'src/raw.ts:6:27 Post @src/raw.ts#q',
    'src/raw.ts:7:25 SELECT 1 FROM ? dyn @src/raw.ts#q',
    'src/raw.ts:8:36 users @src/raw.ts#q',
    'src/raw.ts:10:26 buildQuery() dyn @src/raw.ts#q',
  ]);
  assert.ok(result.limitations.some((line) => line.startsWith('dynamic-relation-names: 2 ')));
});

test('$queryRawUnsafe는 리터럴·같은 파일 const를 읽고 보간 템플릿은 dynamic이다', () => {
  const lines = sourceFacts({
    'src/unsafe.ts': [
      "import { PrismaClient } from '@prisma/client';",
      'const prisma = new PrismaClient();',
      'const SQL = "SELECT * FROM users WHERE id = $1";',
      'let mutable = "SELECT * FROM mutable_table";',
      'export async function u(table: string) {',
      '  await prisma.$queryRawUnsafe(SQL, 1);',
      "  await prisma.$executeRawUnsafe('UPDATE \"Post\" SET title = $1', 'x');",
      '  await prisma.$queryRawUnsafe(`SELECT * FROM ${table}`);',
      '  await prisma.$queryRawUnsafe(mutable);',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, [
    'src/unsafe.ts:4:15 mutable_table @src/unsafe.ts#mutable',
    'src/unsafe.ts:6:32 users @src/unsafe.ts#u',
    'src/unsafe.ts:7:34 Post @src/unsafe.ts#u',
    'src/unsafe.ts:8:32 `SELECT * FROM ${table}` dyn @src/unsafe.ts#u',
    'src/unsafe.ts:9:32 mutable dyn @src/unsafe.ts#u',
  ]);
});

test('게이트 없는 리터럴은 대문자 SQL만 읽고 소문자 SQL은 건너뛴 수로 센다', () => {
  const result = extractProject({
    'src/sql.ts': [
      "export const a = 'SELECT id FROM accounts';",
      "export const b = 'select id from ignored';",
      'export const c = `INSERT INTO audit_log (x) VALUES (${1})`;',
      'export const d = `update the ${"doc"}`;',
      "import type { X } from 'SELECT FROM y';",
      '',
    ].join('\n'),
  });
  assert.deepEqual(factLines(result), [
    'src/sql.ts:1:18 accounts @src/sql.ts#a',
    'src/sql.ts:3:18 `INSERT INTO audit_log (x) VALUES (${1})` dyn @src/sql.ts#c',
  ]);
  assert.ok(result.limitations.some((line) => line.startsWith('skipped-sql-literals: 2 ')));
});

test('알 수 없는 delegate와 계산된 delegate 접근은 dynamic이다', () => {
  const lines = sourceFacts({
    'src/dyn.ts': [
      "import { PrismaClient } from '@prisma/client';",
      'const prisma = new PrismaClient();',
      'export function f(name: string) { prisma.missing; prisma[name]; prisma["post"].count(); prisma.$disconnect(); }',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, [
    'src/dyn.ts:3:42 prisma.missing dyn @src/dyn.ts#f',
    'src/dyn.ts:3:58 prisma[name] dyn @src/dyn.ts#f',
    'src/dyn.ts:3:72 Post @src/dyn.ts#f',
  ]);
});

test('재수출·이름공간 import·default export·CommonJS·동적 import를 따라간다', () => {
  const lines = sourceFacts({
    'src/client.ts': "import { PrismaClient } from '@prisma/client';\nconst client = new PrismaClient();\nexport default client;\nexport { client as named };\n",
    'src/index.ts': "export { default as db } from './client';\nexport * from './client';\n",
    'src/cjs.cjs': "const { PrismaClient } = require('@prisma/client');\nconst prisma = new PrismaClient();\nmodule.exports = { prisma };\n",
    'src/use.ts': [
      "import { db, named } from './index';",
      "import * as clientModule from './client';",
      "import main from './client';",
      "const { prisma } = require('./cjs.cjs');",
      'export async function use() {',
      '  db.user.count(); named.post.count(); main.user.count(); prisma.post.count();',
      "  const { named: late } = await import('./client');",
      '  late.user.count(); clientModule.named.post.count();',
      '}',
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, [
    'src/use.ts:6:6 users @src/use.ts#use',
    'src/use.ts:6:26 Post @src/use.ts#use',
    'src/use.ts:6:45 users @src/use.ts#use',
    'src/use.ts:6:66 Post @src/use.ts#use',
    'src/use.ts:8:8 users @src/use.ts#use',
    'src/use.ts:8:41 Post @src/use.ts#use',
  ]);
});

test('generator output 경로의 클라이언트를 tsconfig paths로 인식하고 생성물은 스캔하지 않는다', () => {
  const lines = sourceFacts({
    'prisma/schema.prisma': prismaBase['prisma/schema.prisma']!.replace(
      'provider = "prisma-client-js"', 'provider = "prisma-client"\n  output = "../src/generated/prisma"'),
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
    'src/generated/prisma/client.ts': "export const PrismaClient = class {};\nconst SQL = 'SELECT * FROM generated_only';\n",
    'src/lib/db.ts': "import { PrismaClient } from '@/generated/prisma/client';\nexport const prisma: PrismaClient = make();\ndeclare function make(): any;\n",
    'src/lib/use.ts': "import { prisma } from '@/lib/db';\nexport const count = () => prisma.user.count();\n",
  });
  assert.deepEqual(lines, ['src/lib/use.ts:2:35 users @src/lib/use.ts#count']);
});

test('지원 표면 밖 DB 패키지는 파일 수로만 센다', () => {
  const result = extractProject({
    'src/a.ts': "import { Kysely } from 'kysely';\nimport objection from 'objection/lib';\nexport { Kysely, objection };\n",
    'src/b.ts': "const mongoose = require('mongoose');\nexport async function f() { await import('slonik'); return mongoose; }\n",
  });
  assert.deepEqual(result.facts, []);
  assert.ok(result.limitations.includes('unsupported-db-packages: 2 source file(s) use SQL packages outside the supported surface: kysely (1), objection (1), slonik (1)'));
  assert.ok(result.limitations.includes('non-relational-stores: 1 source file(s) import non-SQL persistence packages outside the relation join: mongoose (1)'));
});
