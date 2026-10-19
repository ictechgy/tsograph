import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractProject } from '../testing.test.ts';
import { DrizzleCatalog } from './drizzle-catalog.ts';
import { OrmEvaluator } from './orm-values.ts';
import { usrLines } from './testing.test.ts';
import { TypeormCatalog } from './typeorm-catalog.ts';

/** 선언 탐색 단계별 값 평가 수다. */
interface DiscoveryEvaluations {
  readonly drizzle: number;
  readonly typeorm: number;
}

/**
 * 합성 프로젝트를 추출하면서 Drizzle·TypeORM 선언 탐색(`discover`) 안에서 불린 `valueOf` 수를 센다.
 * 탐색이 호출·클래스를 하나하나 평가하는지를 실행 시간 대신 결정적인 수로 보려는 장치다.
 *
 * @param files 프로젝트 기준 경로 → 내용
 * @returns 단계별 평가 수와 사실 줄
 */
function countDiscoveryEvaluations(files: Record<string, string>): { readonly evaluations: DiscoveryEvaluations; readonly lines: string[] } {
  const counts = { drizzle: 0, typeorm: 0 };
  let phase: keyof typeof counts | undefined;
  const { valueOf } = OrmEvaluator.prototype;
  const drizzleDiscover = DrizzleCatalog.prototype.discover;
  const typeormDiscover = TypeormCatalog.prototype.discover;
  OrmEvaluator.prototype.valueOf = function countedValueOf(this: OrmEvaluator, expression) {
    if (phase !== undefined) counts[phase]++;
    return valueOf.call(this, expression);
  };
  DrizzleCatalog.prototype.discover = function drizzlePhase(this: DrizzleCatalog, ...args: Parameters<DrizzleCatalog['discover']>) {
    phase = 'drizzle';
    try {
      drizzleDiscover.apply(this, args);
    } finally {
      phase = undefined;
    }
  };
  TypeormCatalog.prototype.discover = function typeormPhase(this: TypeormCatalog, ...args: Parameters<TypeormCatalog['discover']>) {
    phase = 'typeorm';
    try {
      typeormDiscover.apply(this, args);
    } finally {
      phase = undefined;
    }
  };
  try {
    const lines = usrLines(extractProject(files));
    return { evaluations: { ...counts }, lines };
  } finally {
    OrmEvaluator.prototype.valueOf = valueOf;
    DrizzleCatalog.prototype.discover = drizzleDiscover;
    TypeormCatalog.prototype.discover = typeormDiscover;
  }
}

/** pg만 쓰는 앱이다(호출·new·데코레이터 클래스가 많지만 Drizzle·TypeORM 지정자는 없다). */
const pgOnlyApp: Record<string, string> = {
  'src/db.ts': "import { Pool } from 'pg';\nconst pool = new Pool();\nexport async function listUsers() { return pool.query('select * from users'); }\n",
  'src/util.ts': 'export function helper(value: number) { return value + 1; }\nexport function decorate(): ClassDecorator { return () => undefined; }\n',
  'src/app.ts': [
    "import { helper, decorate } from './util';",
    '@decorate()',
    'export class Service { run() { return helper(1) + new Date().getTime(); } }',
    'export function compute() { return [helper(2), helper(3)].map((value) => Math.max(value, helper(4))); }',
    '',
  ].join('\n'),
};

test('Drizzle·TypeORM 지정자가 없으면 두 선언 탐색은 호출·클래스를 평가하지 않고, 사실은 그대로다', () => {
  const { evaluations, lines } = countDiscoveryEvaluations(pgOnlyApp);
  assert.deepEqual(lines, ['src/db.ts:3:55 users @src/db.ts#listUsers']);
  assert.deepEqual(evaluations, { drizzle: 0, typeorm: 0 });
  const withOrms = countDiscoveryEvaluations({
    ...pgOnlyApp,
    'src/schema.ts': "import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';\nexport const t = sqliteTable('t', { id: integer() });\n",
    'src/user.ts': "import { Entity, PrimaryGeneratedColumn } from 'typeorm';\n@Entity()\nexport class User { @PrimaryGeneratedColumn() id!: number; }\n",
  });
  assert.ok(withOrms.evaluations.drizzle > 0 && withOrms.evaluations.typeorm > 0, JSON.stringify(withOrms.evaluations));
});

test('drizzle-orm 지정자가 없어도 drizzle.config의 casing은 읽어 limitation을 낸다', () => {
  const result = extractProject({
    'src/db.ts': "import { Pool } from 'pg';\nexport const pool = new Pool();\n",
    'drizzle.config.ts': "import { defineConfig } from 'drizzle-kit';\nexport default defineConfig({ dialect: 'postgresql', casing: process.env.CASING });\n",
  });
  assert.ok(result.limitations.some((line) => line.startsWith('orm-naming-unverified: drizzle: the casing option differs')), result.limitations.join('\n'));
});

test('re-export·import=·require로만 가져온 Drizzle·TypeORM 선언도 찾는다', () => {
  // pg import가 ORM 단계를 연다. 각 사례는 Drizzle·TypeORM 지정자가 한 가지 자리에만 있다.
  const pg = { 'src/db.ts': "import { Pool } from 'pg';\nexport const pool = new Pool();\n" };
  const cases: readonly (readonly [Record<string, string>, readonly string[]])[] = [
    [{
      'src/barrel.ts': "export { sqliteTable, integer } from 'drizzle-orm/sqlite-core';\n",
      'src/a.ts': "import { sqliteTable, integer } from './barrel';\nexport const a = sqliteTable('a_rows', { id: integer() });\n",
    }, ['src/a.ts:2:30 a_rows @src/a.ts#model:a', 'src/a.ts:2:42 a_rows.id @src/a.ts#model:a.id']],
    [{
      'src/b.ts': "import core = require('drizzle-orm/sqlite-core');\nexport const b = core.sqliteTable('b_rows', { id: core.integer() });\n",
    }, ['src/b.ts:2:35 b_rows @src/b.ts#model:b', 'src/b.ts:2:47 b_rows.id @src/b.ts#model:b.id']],
    [{
      'src/c.js': "const { sqliteTable, integer } = require('drizzle-orm/sqlite-core');\nexports.c = sqliteTable('c_rows', { id: integer() });\n",
    }, ['src/c.js:2:25 c_rows @src/c.js#model:c_rows', 'src/c.js:2:37 c_rows.id @src/c.js#model:c_rows.id']],
    [{
      'src/user.ts': "import typeorm = require('typeorm');\n@typeorm.Entity()\nexport class User { @typeorm.PrimaryGeneratedColumn() id!: number; }\n",
    }, ['src/user.ts:3:14 user @src/user.ts#model:User', 'src/user.ts:3:55 user.id @src/user.ts#model:User.id']],
    [{
      'src/orm.ts': "export { Entity, PrimaryColumn } from 'typeorm';\n",
      'src/photo.ts': "import { Entity, PrimaryColumn } from './orm';\n@Entity('photos')\nexport class Photo { @PrimaryColumn() key!: string; }\n",
    }, ['src/photo.ts:3:14 photos @src/photo.ts#model:Photo', 'src/photo.ts:3:39 photos.key @src/photo.ts#model:Photo.key']],
  ];
  for (const [files, expected] of cases) {
    assert.deepEqual(usrLines(extractProject({ ...pg, ...files })), expected, Object.keys(files).join(', '));
  }
});
