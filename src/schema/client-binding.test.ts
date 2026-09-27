import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { extractPersistenceFacts } from './extract.ts';
import { extractProject, factLines, prismaBase, withProject } from './testing.test.ts';

/**
 * 한 파일의 소스 사실 줄을 돌려준다.
 *
 * @param source `src/a.ts` 내용
 * @param extra 추가 파일
 * @returns 사실 줄
 */
function factsOf(source: string, extra: Record<string, string> = {}): string[] {
  return factLines(extractProject({ ...prismaBase, ...extra, 'src/a.ts': source })).filter((line) => line.startsWith('src/a.ts'));
}

const header = "import { PrismaClient, Prisma } from '@prisma/client';\nconst prisma = new PrismaClient();\n";

test('조건 식·typeof·인터페이스 상속·교차·Promise 반환 팩토리를 클라이언트로 본다', () => {
  const lines = factsOf(header + [
    'interface Db extends PrismaClient {}',
    'interface Other extends Array<number> {}',
    'type Both = PrismaClient & { extra: true };',
    'type Mixed = PrismaClient | Map<string, number>;',
    'async function open(): Promise<PrismaClient> { return prisma; }',
    'const pick = (flag: boolean) => (flag ? prisma : undefined);',
    'const arrow = () => prisma;',
    'const typed: () => PrismaClient = arrow;',
    'export async function f(a: Db, b: typeof prisma, c: Both, d: Mixed, e: Other, flag: boolean) {',
    '  a.user.count(); b.user.count(); c.user.count(); d.user.count(); e.user;',
    '  (await open()).post.count();',
    '  (flag ? prisma : null)!.post.count();',
    '  (flag ? prisma : {}).post;',
    '  arrow().user.count(); typed().user.count(); pick(flag);',
    '  (prisma as unknown as PrismaClient).post.count(); (<any>prisma).post.count();',
    '}',
    '',
  ].join('\n'));
  assert.deepEqual(lines.map((line) => line.replace(/ @.*/u, '')), [
    'src/a.ts:12:5 users',
    'src/a.ts:12:21 users',
    'src/a.ts:12:37 users',
    'src/a.ts:13:18 Post',
    'src/a.ts:14:27 Post',
    'src/a.ts:16:11 users',
    'src/a.ts:16:33 users',
    'src/a.ts:17:39 Post',
    'src/a.ts:17:67 Post',
  ]);
});

test('합 타입 반환 표기의 Promise·null·undefined 멤버를 벗겨 팩토리로 본다', () => {
  const lines = factsOf(header + [
    'async function getDb(): Promise<PrismaClient> | undefined { return prisma; }',
    'function maybe(): PrismaClient | null { return prisma; }',
    'function wide(): Promise<PrismaClient> | Map<string, number> { return prisma as never; }',
    'export async function f() {',
    '  (await getDb()!).user.findMany(); maybe()!.post.count(); (await wide()).user;',
    '}',
    '',
  ].join('\n'));
  assert.deepEqual(lines.map((line) => line.replace(/ @.*/u, '')), ['src/a.ts:7:20 users', 'src/a.ts:7:46 Post']);
});

test('블록·반복문·catch·enum·namespace·구조 분해 선언은 이름을 가린다', () => {
  const lines = factsOf(header + [
    'export function g(list: string[]) {',
    '  { const prisma = 1; prisma.toString(); }',
    '  for (const prisma of list) prisma.length;',
    '  for (let i = 0, prisma = 2; i < 1; i++) prisma.toFixed();',
    '  try { prisma.user.count(); } catch (prisma) { (prisma as any).user.count(); }',
    '  switch (list.length) { case 0: const prisma = 3; prisma.valueOf(); }',
    '  const [first, { prisma: renamed }, ...rest] = [1, { prisma }, 3];',
    '  const { user } = prisma;',
    '  return [first, renamed, rest, user];',
    '}',
    'enum prismaEnum { A }',
    'namespace NS { export const x = prisma.post; }',
    'import legacy = require("legacy");',
    'export class Widget {}',
    '',
  ].join('\n'));
  assert.deepEqual(lines.map((line) => line.replace(/ @.*/u, '')), ['src/a.ts:7:16 users', 'src/a.ts:14:40 Post']);
});

test('정적 필드·이름 있는 함수 식·기본값 매개변수·static 블록을 처리한다', () => {
  const lines = factsOf(header + [
    'export class Service {',
    '  static shared = prisma;',
    '  static { this.shared; }',
    '  field;',
    '  #db = prisma;',
    '  run(limit = prisma.post.count()) { return [this.#db.user.count(), Service.shared.user, this.field, limit]; }',
    '}',
    'export const named = function inner(this: unknown) { return inner; };',
    '',
  ].join('\n'));
  assert.deepEqual(lines.map((line) => line.replace(/ @.*/u, '')), ['src/a.ts:8:22 Post', 'src/a.ts:8:55 users']);
});

test('CommonJS·재수출 형태의 export 표를 따라간다', () => {
  const lines = factsOf([
    "import a, { b, c, d, e } from './cjs';",
    "import { f } from './star';",
    'export function use() { a.user.count(); b.user.count(); c.post.count(); d.post; e.user; f.post.count(); }',
    '',
  ].join('\n'), {
    'src/cjs.js': [
      "const { PrismaClient } = require('@prisma/client');",
      'const client = new PrismaClient();',
      'exports.b = client;',
      'module.exports.c = new PrismaClient();',
      'module.exports.d = 1;',
      'exports.e = ok;',
      'module.exports = client;',
      'other.exports = client;',
      '',
    ].join('\n'),
    'src/star.ts': "export * from '@prisma/client';\nexport * from './cjs';\nexport * from './missing';\nexport * as ns from './cjs';\nimport { PrismaClient } from '@prisma/client';\nexport const f = new PrismaClient();\n",
    'src/obj.cjs': "const { PrismaClient: Ctor } = require('@prisma/client');\nmodule.exports = { made: new Ctor(), ['x']: 1, plain };\n",
  });
  assert.deepEqual(lines.map((line) => line.replace(/ @.*/u, '')), [
    'src/a.ts:3:27 users',
    'src/a.ts:3:43 users',
    'src/a.ts:3:59 Post',
    'src/a.ts:3:91 Post',
  ]);
});

test('Prisma 모듈 이름공간 import와 require 결과를 Prisma 모듈로 본다', () => {
  const lines = factsOf([
    "import * as P from '@prisma/client';",
    "import D from '@prisma/client/edge';",
    "const R = require('.prisma/client');",
    'const one = new P.PrismaClient(); const two = new D.PrismaClient(); const three = new R.PrismaClient();',
    'type T = P.Prisma.TransactionClient;',
    'export function h(tx: T) { one.user.count(); two.user.count(); three.user.count(); tx.post.count(); return P.other; }',
    '',
  ].join('\n'));
  assert.equal(lines.length, 4);
});

test('tsconfig를 읽지 못하면 기본 해석으로 계속하고 limitation을 낸다', () => {
  withProject({
    ...prismaBase,
    'tsconfig.json': '{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } ',
    'src/db.ts': "import { PrismaClient } from '@prisma/client';\nexport const prisma = new PrismaClient();\n",
    'src/use.ts': "import { prisma } from './db.js';\nimport { nope } from '@/db';\nexport const n = () => prisma.user.count();\n",
    'web/jsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["lib/*"] } } }',
    'web/lib/db.js': "import { PrismaClient } from '@prisma/client';\nexport const db = new PrismaClient();\n",
    'web/pages/x.jsx': "import { db } from '~/db';\nexport default function X() { db.post.count(); return <div />; }\n",
  }, (root) => {
    writeFileSync(join(root, 'src', 'broken.ts'), 'export const = ;\n');
    const result = extractPersistenceFacts(root);
    assert.deepEqual(factLines(result).filter((line) => !line.startsWith('prisma/')), [
      'src/use.ts:3:31 users @src/use.ts#n',
      'web/pages/x.jsx:2:34 Post @web/pages/x.jsx#X',
    ]);
    assert.ok(result.limitations.some((line) => line.startsWith('unreadable-module-configs: 1 ')));
    assert.ok(result.limitations.some((line) => line.startsWith('parse-errors: 1 ')));
  });
});
