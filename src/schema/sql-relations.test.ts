import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

import { escapeName, escapeQualified, lexSql, looksLikeSql, type SqlToken, sqlRelations, tokenRelations } from './sql-relations.ts';

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

/** 정본 벡터를 직접 읽어 사본 배열과 공유 계약의 드리프트를 막는다. */
const sharedSuite = JSON.parse(readFileSync(new URL('../../conformance/sql-relations.json', import.meta.url), 'utf8')) as {
  readonly suite: string;
  readonly cases: readonly {
    readonly id: string;
    readonly appliesTo: readonly string[];
    readonly input: { readonly sql: string };
    readonly expect: { readonly relations: readonly string[] };
  }[];
};
const sharedRelationCases = sharedSuite.cases.filter((entry) => entry.appliesTo.includes('producer'));

test('계열 공통 사례: CTE 이름·함수 인자 안의 FROM·IS [NOT] DISTINCT FROM 피연산자는 관계가 아니다', () => {
  // 공통 사례는 키워드가 모두 대문자라 strict 모드에서도 같다. 내지 않는 피연산자는 미해석으로도 세지 않는다.
  assert.equal(sharedSuite.suite, 'sql-relations');
  assert.ok(sharedRelationCases.length > 0);
  for (const { id, input: { sql }, expect: { relations: expected } } of sharedRelationCases) {
    for (const strict of [false, true]) {
      const result = sqlRelations(sql, strict);
      const names = [...new Set(result.relations.map((relation) => relation.name))].sort();
      assert.deepEqual([names, result.unresolved], [[...expected].sort(), 0], `${id} (strict ${strict})`);
    }
  }
  // CTE 이름은 그 문장 안에서만 가린다 — 두 번째 문장의 `recent` 하나만 남는다(개수까지 본다).
  const scope = sharedRelationCases.find((testCase) => testCase.id === 'cte/scope-is-one-statement')!;
  assert.deepEqual(relations(scope.input.sql), ['recent']);
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

test('CTE·함수 인자·DISTINCT FROM 규칙은 가장 안쪽 괄호와 문장으로 판정하고 CTE 본문 괄호는 함수 인자가 아니다', () => {
  const cases: readonly (readonly [string, readonly string[], number])[] = [
    // R3의 피연산자는 자리표시자여도 관계도 미해석도 아니다.
    ['SELECT * FROM events WHERE kind IS DISTINCT FROM $1', ['events'], 0],
    ['SELECT * FROM events WHERE kind IS NOT DISTINCT FROM ?', ['events'], 0],
    // R1의 함수 이름은 절 단어(AS)가 아니고 CTE 본문 괄호(`AS [NOT] MATERIALIZED (`)도 아니다 — DML CTE 본문의 FROM은 관계다.
    ['WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', ['t'], 0],
    ['WITH d AS MATERIALIZED (DELETE FROM t RETURNING *) SELECT * FROM d', ['t'], 0],
    ['WITH d AS NOT MATERIALIZED (DELETE FROM t RETURNING *) SELECT * FROM d', ['t'], 0],
    // 이름 뒤 괄호라도 첫 토큰이 SELECT면 하위 질의이고, 판정은 FROM을 감싼 가장 안쪽 괄호로 한다.
    ['INSERT INTO t (SELECT * FROM s)', ['t', 's'], 0],
    ['(SELECT * FROM t) UNION (SELECT * FROM u)', ['t', 'u'], 0],
    ['SELECT EXTRACT(YEAR FROM (SELECT max(d) FROM t)) FROM orders', ['t', 'orders'], 0],
    ['SELECT OVERLAY(name PLACING $1 FROM 2) FROM users', ['users'], 0],
    // 테이블 값 함수 피연산자는 지금처럼 미해석이다.
    ['SELECT * FROM generate_series(1, 10)', [], 1],
    // 괄호 문맥은 문장마다 새로 시작한다 — 닫히지 않은 함수 괄호가 다음 문장의 FROM을 가리지 않는다.
    ['SELECT EXTRACT(YEAR FROM ts; SELECT * FROM orders', ['orders'], 0],
    // CTE 이름 비교: 비인용끼리는 대소문자를 무시하고, 인용 이름은 그대로 비교하고, 한정 이름은 CTE가 아니다.
    ['WITH Recent AS (SELECT * FROM orders) SELECT * FROM recent', ['orders'], 0],
    ['WITH "Recent" AS (SELECT 1) SELECT * FROM recent', ['recent'], 0],
    ['WITH "Recent" AS (SELECT 1) SELECT * FROM "Recent"', [], 0],
    ['WITH recent AS (SELECT 1) SELECT * FROM public.recent', ['public.recent'], 0],
    // 규칙대로 문장 전체를 가리므로, 테이블과 같은 이름의 CTE는 그 문장의 테이블 사용도 가린다(README에 적은 한계).
    ['WITH orders AS (SELECT * FROM orders WHERE paid) SELECT * FROM orders', [], 0],
    // 내지 않는 CTE 피연산자도 별칭·쉼표 목록 진행은 그대로다. 문장 경계는 비인용 `;`뿐이다.
    ['WITH a AS (SELECT 1) SELECT * FROM a x, orders o', ['orders'], 0],
    ['WITH recent AS (SELECT 1) SELECT ";" FROM recent', [], 0],
  ];
  for (const [sql, names, unresolved] of cases) {
    for (const strict of [false, true]) {
      const result = sqlRelations(sql, strict);
      const actual = [result.relations.map((relation) => relation.name), result.unresolved];
      assert.deepEqual(actual, [names, unresolved], `${sql} (strict ${strict})`);
    }
  }
  // 세 규칙은 관계를 빼기만 하므로 인식 단어는 strict 모드에서도 대소문자를 가리지 않는다(strict 게이트는 발화만 막는다).
  assert.deepEqual(relations('with recent as (SELECT * FROM orders) SELECT * FROM recent', true), ['orders']);
  assert.deepEqual(relations('SELECT * FROM events WHERE a is not distinct FROM b', true), ['events']);
  assert.deepEqual(relations('SELECT extract(year FROM created_at) FROM orders', true), ['orders']);
});

test('table-valued functions are unresolved operands, not table names', () => {
  assert.deepEqual(relations("SELECT * FROM pragma_table_info('t')"), []);
  assert.deepEqual(relations("SELECT * FROM users JOIN main.pragma_table_info('t') p ON true"), ['users']);
  assert.deepEqual(relations("SELECT * FROM pragma_table_info('t') AS p, users"), ['users']);
  assert.equal(sqlRelations("SELECT * FROM pragma_table_info('t')").unresolved, 1);
  assert.deepEqual(relations('INSERT INTO users (id) VALUES (1)'), ['users']);
});

test('앞선 동사·권한·종류어 탐색은 인용 여부와 무관하게 `;` 토큰에서 끊고, 괄호 짝은 비인용 괄호만 센다', () => {
  // 문장 머리·동사는 비인용 `;`에서만 끊지만, INTO·ON 앞 단어 탐색은 인용된 `;`(`[;]`·`";"`)에서도 끊는다(포트 원본 규칙).
  const cases: readonly (readonly [string, readonly string[], number])[] = [
    ['INSERT [;] INTO t', [], 0],
    ['INSERT ";" INTO t', [], 0],
    ['INSERT INTO a; INTO b', ['a'], 0],
    ['GRANT SELECT [;] ON t TO r', [], 0],
    ['GRANT SELECT ON a TO r; GRANT USAGE [;] ON b TO r', ['a'], 0],
    ['CREATE INDEX i [;] ON t (x)', [], 0],
    ['CREATE TRIGGER x AFTER INSERT ON t', ['t'], 0],
    ['INSERT INTO "a;b" SELECT * FROM `;` JOIN d', ['a;b', ';', 'd'], 0],
    ['SELECT * FROM (a)) JOIN b ON true', ['b'], 0],
    ['SELECT * FROM ) JOIN (SELECT 1 FROM c) d', ['c'], 1],
    ['SELECT * FROM f(1, (2)) x JOIN y ON true', ['y'], 1],
    ['SELECT * FROM f(1 JOIN y', ['y'], 1],
    ['SELECT * FROM ("(") x JOIN y ON true', ['y'], 0],
    ['SELECT * FROM (SELECT 1 FROM (SELECT 2 FROM c', ['c'], 2],
    ['GRANT EXECUTE ON FUNCTION f(int, (x)) TO r', [], 0],
  ];
  for (const [sql, names, unresolved] of cases) {
    const result = sqlRelations(sql);
    assert.deepEqual([result.relations.map((relation) => relation.name), result.unresolved], [names, unresolved], sql);
  }
  assert.deepEqual(relations('insert INTO t', true), []);
  assert.deepEqual(relations('insert INTO t'), ['t']);
});

/**
 * 어휘 목록 원소를 읽은 횟수를 세는 목록을 만든다. 구현이 위치마다 앞뒤를 다시 훑으면 읽기 수가 어휘 수의
 * 제곱으로 늘어나므로, 실행 시간 대신 이 수로 작업량을 결정적으로 본다.
 *
 * @param sql SQL 텍스트
 * @returns 세는 어휘 목록과 지금까지의 읽기 수
 */
function countedTokens(sql: string): { readonly tokens: readonly SqlToken[]; readonly reads: () => number } {
  let reads = 0;
  const tokens = new Proxy(lexSql(sql), {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/u.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { tokens, reads: () => reads };
}

test('반복 INTO·ON과 닫히지 않거나 중첩된 괄호도 어휘를 위치마다 다시 훑지 않는다', () => {
  const inputs = [
    `INSERT${' INTO t'.repeat(2000)}`,
    `SELECT 1${' FROM ('.repeat(2000)}`,
    `GRANT SELECT${' ON t'.repeat(2000)}`,
    `CREATE INDEX i${' ON t'.repeat(2000)}`,
    `${'SELECT * FROM ('.repeat(1000)}SELECT 1${')'.repeat(1000)}`,
  ];
  for (const sql of inputs) {
    const counted = countedTokens(sql);
    assert.deepEqual(tokenRelations(counted.tokens, true), sqlRelations(sql, true));
    const tokens = counted.tokens.length;
    assert.ok(counted.reads() <= 64 * tokens, `${sql.slice(0, 16)}…: ${counted.reads()} reads for ${tokens} tokens`);
  }
});

test('CTE 이름·함수 인자 괄호·DISTINCT FROM 판정도 어휘를 위치마다 다시 훑지 않는다', () => {
  // 피연산자마다 문장을 다시 훑는 CTE 조회, 쉼표마다 닫히지 않은 열 목록 끝을 찾는 CTE 인식, FROM마다 감싼 괄호를
  // 거꾸로 찾는 함수 인자 판정은 모두 어휘 수의 제곱이 된다.
  const inputs = [
    `WITH a AS (SELECT 1) SELECT 1${' FROM a'.repeat(2000)}`,
    `SELECT 1${', a ('.repeat(2000)}`,
    `SELECT f(x${' (1) FROM y'.repeat(2000)})`,
    `SELECT * FROM t WHERE${' a IS NOT DISTINCT FROM b AND'.repeat(2000)} true`,
    `SELECT EXTRACT(YEAR FROM ts${'; SELECT * FROM t'.repeat(2000)}`,
  ];
  for (const sql of inputs) {
    const counted = countedTokens(sql);
    assert.deepEqual(tokenRelations(counted.tokens, true), sqlRelations(sql, true));
    const tokens = counted.tokens.length;
    assert.ok(counted.reads() <= 64 * tokens, `${sql.slice(0, 16)}…: ${counted.reads()} reads for ${tokens} tokens`);
  }
});
