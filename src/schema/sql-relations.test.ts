import assert from 'node:assert/strict';
import { test } from 'node:test';

import { escapeName, escapeQualified, lexSql, looksLikeSql, sqlRelations } from './sql-relations.ts';

// 기대값은 cartograph `SqlRelationsTests`·dartograph `sql_relations_test`와 같은 공유 벡터다.
// 가족 생산자가 같은 SQL을 같게 읽어야 isthmus 조인 결과가 생산자 언어와 무관해진다.

/**
 * 관계 이름만 뽑는다.
 *
 * @param sql SQL 텍스트
 * @param strict 대문자 게이트 여부
 * @returns 관계 이름 목록
 */
function relations(sql: string, strict = false): string[] {
  return sqlRelations(sql, strict).relations.map((relation) => relation.name);
}

test('기본 관계 키워드의 피연산자를 읽는다', () => {
  assert.deepEqual(relations('SELECT * FROM users'), ['users']);
  assert.deepEqual(relations('SELECT * FROM users JOIN orders ON true'), ['users', 'orders']);
  assert.deepEqual(relations('INSERT INTO users (id) VALUES (1)'), ['users']);
  assert.deepEqual(relations("UPDATE users SET name = 'x'"), ['users']);
  assert.deepEqual(relations('DELETE FROM users'), ['users']);
  assert.deepEqual(relations('SELECT * FROM s.t'), ['s.t']);
  assert.deepEqual(relations('SELECT * FROM `a.b`'), ['a%2Eb']);
});

test('쉼표 목록과 별칭을 읽는다', () => {
  assert.deepEqual(relations('SELECT * FROM a, b'), ['a', 'b']);
  assert.deepEqual(relations('SELECT * FROM a x, b y'), ['a', 'b']);
  assert.deepEqual(relations('SELECT * FROM a AS x, b AS y'), ['a', 'b']);
});

test('문장 경계에서만 발화한다', () => {
  assert.deepEqual(relations('UPDATE a SET x = 1; UPDATE b SET y = 2'), ['a', 'b']);
  assert.deepEqual(relations('please update the config'), []);
  assert.deepEqual(relations('UPDATE t SET x = 1'), ['t']);
  assert.deepEqual(relations('GRANT SELECT ON TABLE metrics TO app'), ['metrics']);
  assert.deepEqual(relations('GRANT SELECT ON metrics TO app'), ['metrics']);
  assert.deepEqual(relations('REVOKE SELECT ON FUNCTION f FROM r'), []);
  assert.deepEqual(relations('grant select on the report to auditors'), []);
  assert.deepEqual(relations('grant access on staging to intern'), []);
  // 라벨(`name:`)은 문장 머리를 차지하지 않는다.
  assert.deepEqual(relations('markAdult:\nUPDATE users SET adult = 1'), ['users']);
  assert.deepEqual(relations('clearAll:\nTRUNCATE users'), ['users']);
  // 캐스트(`::`)는 라벨이 아니다.
  assert.deepEqual(relations('SELECT x::int FROM t'), ['t']);
});

test('산문은 관계를 만들지 않는다', () => {
  assert.deepEqual(relations('the report into the folder'), []);
  assert.deepEqual(relations('merged the branch into main'), []);
  assert.deepEqual(relations('drop the table at noon'), []);
  assert.deepEqual(relations('turn the table over'), []);
});

test('하위 질의와 괄호를 따라간다', () => {
  assert.deepEqual(relations('SELECT * FROM (SELECT * FROM a) x JOIN b ON true'), ['a', 'b']);
  // INSERT .. SELECT는 양쪽 다 읽는다 — 읽기 원본도 관계 사용이다.
  assert.deepEqual(relations('INSERT INTO a SELECT * FROM ignored_c'), ['a', 'ignored_c']);
});

test('미해석 피연산자는 개수로 센다', () => {
  const deleted = sqlRelations('DELETE FROM {} WHERE id = ?');
  assert.deepEqual(deleted.relations, []);
  assert.equal(deleted.unresolved, 1);
  assert.equal(sqlRelations('SELECT * FROM users').unresolved, 0);
  assert.equal(sqlRelations('SELECT 1 FROM').unresolved, 1);
  assert.equal(sqlRelations('SELECT * FROM {} JOIN ?').unresolved, 2);
});

test('SQL 형태 게이트가 산문을 걸러낸다', () => {
  assert.equal(looksLikeSql('SELECT * FROM t'), true);
  assert.equal(looksLikeSql('update t set x = 1'), true);
  assert.equal(looksLikeSql('please update the config'), false);
  assert.equal(looksLikeSql('a plain sentence'), false);
  assert.equal(looksLikeSql(''), false);
});

test('strict 모드는 산문과 소문자 키워드를 거부한다', () => {
  assert.equal(looksLikeSql('Select an option from the menu', true), false);
  assert.equal(looksLikeSql('SELECT an option FROM the menu', true), true);
  assert.deepEqual(relations('Select an option from the menu', true), []);
  assert.deepEqual(relations('select * from users', true), []);
  assert.deepEqual(relations('SELECT a FROM the'), []);
  assert.deepEqual(relations('select * from users'), ['users']);
});

test('키워드 위치는 UTF-16 오프셋이다', () => {
  const result = sqlRelations('-- 한글 주석\nSELECT * FROM users');
  assert.equal(result.relations[0]!.keyword, '-- 한글 주석\nSELECT * '.length);
});

test('이름 escape는 한정자와 한 세그먼트를 구분한다', () => {
  assert.equal(escapeQualified('main.users'), 'main.users');
  assert.equal(escapeQualified('100%.t'), '100%25.t');
  assert.equal(escapeName('a.b'), 'a%2Eb');
});

// 아래는 공유 벡터 밖의 포트 분기 회귀 테스트다(원본 알고리즘의 같은 분기를 고정한다).

test('주석·문자열·인용 식별자를 어휘로 올바르게 나눈다', () => {
  const tokens = lexSql("/* c */ SELECT 'it''s \\' x' FROM [dbo].\"T\" -- tail");
  assert.deepEqual(tokens.map((token) => token.text), ['SELECT', 'FROM', 'dbo', '.', 'T']);
  assert.deepEqual(relations('SELECT * FROM [dbo].[Order Items]'), ['dbo.Order Items']);
  assert.deepEqual(relations('SELECT * FROM "100%"'), ['100%25']);
  assert.deepEqual(relations("SELECT 'unterminated FROM x"), []);
});

test('DDL과 인덱스·트리거의 ON 대상을 읽는다', () => {
  assert.deepEqual(relations('CREATE TABLE IF NOT EXISTS t (id int)'), ['t']);
  assert.deepEqual(relations('ALTER TABLE ONLY public.t ADD COLUMN x int'), ['public.t']);
  assert.deepEqual(relations('TRUNCATE TABLE a, b'), ['a', 'b']);
  assert.deepEqual(relations('CREATE INDEX i ON t (x)'), ['t']);
  assert.deepEqual(relations('CREATE RULE r AS ON INSERT TO t DO NOTHING'), []);
  assert.deepEqual(relations('SELECT * FROM a JOIN b ON a.id = b.id'), ['a', 'b']);
  assert.deepEqual(relations('CREATE TABLE'), []);
  assert.equal(sqlRelations('CREATE TABLE').unresolved, 1);
  assert.deepEqual(relations('DROP TABLE t', true), ['t']);
  assert.deepEqual(relations('drop TABLE t', true), []);
});

test('GRANT 객체 종류와 형태 검사를 따른다', () => {
  assert.deepEqual(relations('GRANT SELECT ON TABLES a, b TO r'), ['a', 'b']);
  assert.deepEqual(relations('GRANT SELECT ON a, b'), ['a', 'b']);
  assert.deepEqual(relations('GRANT SELECT ON a WITH GRANT OPTION'), []);
  assert.deepEqual(relations('GRANT EXECUTE ON FUNCTION f(int) TO r'), []);
  assert.equal(sqlRelations('GRANT USAGE ON SEQUENCE {s} TO r').unresolved, 1);
  assert.equal(sqlRelations('GRANT EXECUTE ON FUNCTION f(int TO r').unresolved, 1);
  assert.deepEqual(relations('GRANT SELECT ON "quoted" TO r'), ['quoted']);
  assert.deepEqual(relations('GRANT SELECT ON TABLE'), []);
  assert.deepEqual(relations('SELECT * FROM a UNION SELECT * FROM b'), ['a', 'b']);
});

test('닫히지 않은 괄호와 중복 피연산자를 처리한다', () => {
  assert.equal(sqlRelations('SELECT * FROM (SELECT 1').unresolved, 1);
  assert.deepEqual(relations('SELECT * FROM a, a'), ['a']);
  assert.deepEqual(relations('SELECT * FROM a."b.c"'), ['a.b%2Ec']);
  assert.deepEqual(relations('SELECT * FROM a.where'), ['a']);
  assert.deepEqual(relations('SELECT * FROM ""'), []);
  assert.deepEqual(relations('SELECT * FROM "a" AS'), ['a']);
});
