import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractPersistenceFacts } from '../extract.ts';
import type { RelationUseFact } from '../relation-facts.ts';

/** 저장소 루트다. */
const repository = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));

/** 오라클 기록 하나다(`experiments/orm-naming-oracle/oracle.mjs`가 만든다). */
interface Recording {
  readonly fixture: string;
  readonly packages: Readonly<Record<string, string>>;
  /** ORM이 선언한 테이블·`테이블.컬럼`(실제 DDL)이다. */
  readonly declared: readonly string[];
  /** DB 전체(원시 SQL 마이그레이션 포함)의 테이블·`테이블.컬럼`이다. 비었으면 DB 없이 기록했다. */
  readonly relations: readonly string[];
  /** 쿼리 함수 usr → ORM이 만든 SQL의 참조다. */
  readonly queries: Readonly<Record<string, { readonly sql: string; readonly relations: readonly string[]; readonly columns: readonly string[] }>>;
}

/**
 * 기록을 읽는다.
 *
 * @param name 기록 이름
 * @returns 기록
 */
function recording(name: string): Recording {
  return JSON.parse(readFileSync(join(repository, 'experiments', 'orm-naming-oracle', 'recordings', `${name}.json`), 'utf8')) as Recording;
}

/**
 * 사실의 비교 키(`table` 또는 `table.column`)다.
 *
 * @param fact 사실
 * @returns 키
 */
function keyOf(fact: RelationUseFact): string {
  return fact.method === undefined ? fact.channel : `${fact.channel}.${fact.method}`;
}

/**
 * 선언 사실(`#model:` 이름공간)인지 본다.
 *
 * @param fact 사실
 * @returns 선언 사실이면 true
 */
function isDeclaration(fact: RelationUseFact): boolean {
  return fact.symbol?.usr?.includes('#model:') === true;
}

for (const name of ['drizzle', 'typeorm', 'sequelize', 'knex']) {
  test(`${name} 선언·사용 이름이 실제 ORM이 만든 DDL·SQL과 일치한다`, () => {
    const expected = recording(name);
    const { facts } = extractPersistenceFacts(join(repository, expected.fixture));
    const declared = [...new Set(facts.filter(isDeclaration).map(keyOf))].sort();
    assert.deepEqual(declared, [...expected.declared]);
    const database = new Set(expected.relations);
    const uses = facts.filter((fact) => !fact.dynamic && !isDeclaration(fact));
    if (database.size > 0) assert.deepEqual(uses.map(keyOf).filter((key) => !database.has(key)), []);
    for (const [usr, query] of Object.entries(expected.queries)) {
      const own = uses.filter((fact) => fact.symbol?.usr === usr);
      assert.deepEqual([...new Set(own.filter((fact) => fact.method === undefined).map(keyOf))].sort(), query.relations, usr);
      if ((query.sql.match(/\bselect\b/giu) ?? []).length > 1) continue;
      const columns = new Set(query.columns);
      assert.deepEqual(own.filter((fact) => fact.method !== undefined).map(keyOf).filter((key) => !columns.has(key)), [], usr);
    }
  });
}

test('Drizzle fixture의 마이그레이션은 오라클이 drizzle-kit으로 만든 DDL이다', () => {
  const migration = readFileSync(join(repository, 'fixtures', 'schema', 'drizzle-d1-app', 'migrations', '0000_init.sql'), 'utf8');
  for (const table of recording('drizzle').declared.filter((entry) => !entry.includes('.'))) assert.ok(migration.includes(`CREATE TABLE \`${table}\``), table);
});
