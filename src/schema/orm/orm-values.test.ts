import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractProject } from '../testing.test.ts';
import { OrmBinder } from './orm-binder.ts';
import { ormLines, usrLines } from './testing.test.ts';

/**
 * 콜백을 실행하는 동안 이름 해석(`OrmBinder.originOf`) 호출 수를 세고, 상한을 넘으면 즉시 실패시킨다.
 * 지수적으로 펼치는 구현이 테스트를 붙잡아 두지 않고 바로 빨간불이 되게 하려는 장치다.
 *
 * @param limit 허용하는 호출 수
 * @param run 실행할 콜백
 * @returns 콜백 결과
 */
function withOriginBudget<T>(limit: number, run: () => T): T {
  const original = OrmBinder.prototype.originOf;
  let calls = 0;
  OrmBinder.prototype.originOf = function originOfWithBudget(this: OrmBinder, node) {
    calls++;
    if (calls > limit) throw new Error(`name resolution exceeded ${limit} calls; type expansion is not memoized`);
    return original.call(this, node);
  };
  try {
    return run();
  } finally {
    OrmBinder.prototype.originOf = original;
  }
}

/**
 * `type Ti = T(i-1) | …`(분기 `fan`개) 사슬 끝 타입으로 선언한 pg 클라이언트를 쓰는 파일이다.
 * 분기 1이면 합 타입 대신 괄호 타입이라 같은 깊이를 쓰는 선형 대조군이 된다.
 *
 * @param levels 사슬 단계
 * @param fan 단계마다 같은 별칭을 참조하는 수
 * @returns 파일 내용
 */
function aliasChain(levels: number, fan: number): string {
  const lines = ["import { Pool } from 'pg';", 'type T0 = Pool;'];
  for (let level = 1; level <= levels; level++) {
    const member = `T${level - 1}`;
    lines.push(`type T${level} = ${fan === 1 ? `(${member})` : Array.from({ length: fan }, () => member).join(' | ')};`);
  }
  lines.push(`declare const deps: T${levels};`, "export async function run() { return deps.query('select * from chain_rows'); }", '');
  return lines.join('\n');
}

test('같은 별칭을 여러 번 참조하는 합 타입 사슬은 노드마다 한 번만 펼치고, 깊이 상한은 선형 대조군과 같다', () => {
  for (const levels of [20, 22, 23, 30]) {
    const control = ormLines({ 'src/q.ts': aliasChain(levels, 1) });
    const union = withOriginBudget(20_000, () => ormLines({ 'src/q.ts': aliasChain(levels, 3) }));
    assert.deepEqual(union, control, `levels ${levels}`);
  }
  assert.deepEqual(withOriginBudget(20_000, () => ormLines({ 'src/q.ts': aliasChain(20, 3) })), ['src/q.ts:24:49 chain_rows @src/q.ts#run']);
});

test('같은 인터페이스를 여러 경로로 상속해도 멤버 타입 탐색은 선언마다 한 번이다', () => {
  const fan = 8;
  const lines = ["import { Pool } from 'pg';", 'interface Found { db: Pool }'];
  for (let index = 0; index < fan; index++) lines.push(`interface I0_${index} { other${index}: Pool }`);
  for (let level = 1; level <= 9; level++) {
    const bases = Array.from({ length: fan }, (_, index) => `I${level - 1}_${index}`).join(', ');
    for (let index = 0; index < fan; index++) lines.push(`interface I${level}_${index} extends ${bases} {}`);
  }
  lines.push('interface Top extends I9_0, Found {}', 'declare const deps: Top;');
  lines.push("export async function run() { return deps.db.query('select * from lattice_rows'); }", '');
  const result = withOriginBudget(20_000, () => ormLines({ 'src/q.ts': lines.join('\n') }));
  assert.deepEqual(result, ['src/q.ts:85:52 lattice_rows @src/q.ts#run']);
});

/**
 * 15단계 별칭 사슬 타입을 깊은 변수 사슬(`a12 → … → a0`) 끝과 얕은 선언(`direct`) 양쪽에서 쓰는 파일이다.
 *
 * @param deepFirst 깊은 사용을 먼저 둘지 여부(평가 순서)
 * @returns 파일 내용
 */
function deepAndShallowUses(deepFirst: boolean): string {
  const lines = ["import { Pool } from 'pg';", 'type T0 = Pool;'];
  for (let level = 1; level <= 15; level++) lines.push(`type T${level} = (T${level - 1});`);
  lines.push('declare const a0: T15;');
  for (let index = 1; index <= 12; index++) lines.push(`const a${index} = a${index - 1};`);
  lines.push('declare const direct: T15;');
  const uses = [
    "export async function deep() { return a12.query('select * from deep_rows'); }",
    "export async function shallow() { return direct.query('select * from shallow_rows'); }",
  ];
  lines.push(...(deepFirst ? uses : uses.reverse()), '');
  return lines.join('\n');
}

test('메모한 타입 값도 깊이 상한이 끊는 위치는 평가 순서와 무관하게 메모 전과 같다', () => {
  assert.deepEqual(ormLines({ 'src/q.ts': deepAndShallowUses(true) }), ['src/q.ts:33:55 shallow_rows @src/q.ts#shallow']);
  assert.deepEqual(ormLines({ 'src/q.ts': deepAndShallowUses(false) }), ['src/q.ts:32:55 shallow_rows @src/q.ts#shallow']);
});

/**
 * `type T = typeof x`를 x의 초기값 단언(`pool as T`)과 다른 선언의 타입 표기(`v: T | undefined`)가 함께 쓰는 파일이다
 * (`tsc --strict` 통과). x를 평가하는 동안에는 x가 계산 중이라 T가 순환 감지로 끊기고, v에서는 x가 계산 중이 아니라
 * T가 x의 값까지 풀린다.
 *
 * @param assertionFirst x를 쓰는 함수를 먼저 둘지 여부(평가 순서)
 * @returns 파일 내용
 */
function typeofCycle(assertionFirst: boolean): string {
  const uses = [
    "export async function first() { return x.query('select * from x_rows'); }",
    "export async function second() { return v?.query('select * from v_rows'); }",
  ];
  const lines = ["import { Pool } from 'pg';", 'const pool = new Pool();', 'type T = typeof x;', 'const x: Pool = pool as T;'];
  lines.push('declare const v: T | undefined;', ...(assertionFirst ? uses : uses.reverse()), '');
  return lines.join('\n');
}

test('순환 감지로 끊긴 타입 값은 끊게 만든 선언이 계산 중인 문맥에서만 다시 쓴다(평가 순서와 무관하게 메모 전과 같다)', () => {
  assert.deepEqual(ormLines({ 'src/q.ts': typeofCycle(true) }), ['src/q.ts:6:48 x_rows @src/q.ts#first', 'src/q.ts:7:50 v_rows @src/q.ts#second']);
  assert.deepEqual(ormLines({ 'src/q.ts': typeofCycle(false) }), ['src/q.ts:6:50 v_rows @src/q.ts#second', 'src/q.ts:7:48 x_rows @src/q.ts#first']);
});

test('끊긴 타입 값은 그 계산이 끝까지 풀었던 선언이 지금 계산 중이면 다시 쓰지 않는다(없던 사실을 만들지 않는다)', () => {
  // w의 타입에서 먼저 푼 T(= typeof n.Pool)는 n을 끝까지 풀어 pg의 Pool이다. n 자신의 타입에서 같은 깊이로 다시 닿은
  // T는 n이 계산 중이라 그 자리에서 끊겨야 한다(메모 전 평가). 먼저 푼 값을 쓰면 n이 Pool이 되어 client_rows가 생긴다.
  const lines = ormLines({
    'src/q.ts': [
      "import * as pg from 'pg';",
      'type T = typeof n.Pool;',
      'declare const n: T & typeof pg;',
      'declare const w: ((((T))));',
      'const client = new n();',
      'const pool = new pg.Pool();',
      "export async function first() { return w.query('select * from w_rows'); }",
      "export async function second() { return client.query('select * from client_rows'); }",
      "export async function third() { return pool.query('select * from ok_rows'); }",
      '',
    ].join('\n'),
  });
  assert.deepEqual(lines, ['src/q.ts:9:51 ok_rows @src/q.ts#third']);
});

/**
 * 21단계 괄호 별칭 사슬 끝의 `typeof x`를 두 선언(v1·v2)이 타입으로 쓰고, x를 직접 쓰는 함수도 있는 파일이다.
 * v1·v2를 풀면 x의 초기값이 깊이 상한에서 끊긴다. 그 사이 x를 직접 풀면 초기값이 메모되어, 그 뒤의 평가는 같은
 * 깊이에서 끊기는 대신 메모를 읽는다.
 *
 * @param order 함수를 둘 순서(a: v1, b: x, c: v2)
 * @returns 파일 내용
 */
function depthCutThenMemo(order: string): string {
  const uses: Record<string, string> = {
    a: "export async function a() { return v1.query('select * from v1_rows'); }",
    b: "export async function b() { return x.query('select * from x_rows'); }",
    c: "export async function c() { return v2.query('select * from v2_rows'); }",
  };
  const lines = ["import { Pool } from 'pg';", 'const pool = new Pool();', 'type T0 = typeof x;'];
  for (let level = 1; level <= 21; level++) lines.push(`type T${level} = (T${level - 1});`);
  lines.push('const x = pool;', 'declare const v1: (T21);', 'declare const v2: (T21);', ...[...order].map((name) => uses[name]!), '');
  return lines.join('\n');
}

test('깊이 상한으로 끊긴 식이 나중에 메모되면 그 끊김에 기댄 타입 값은 다시 쓰지 않는다(메모 전과 같다)', () => {
  // 기대값은 타입 메모가 없는 평가(수정 전)의 사실이다. 그 평가도 식 메모 때문에 순서에 따라 결과가 다르다.
  assert.deepEqual(ormLines({ 'src/q.ts': depthCutThenMemo('abc') }), ['src/q.ts:29:44 x_rows @src/q.ts#b', 'src/q.ts:30:45 v2_rows @src/q.ts#c']);
  assert.deepEqual(ormLines({ 'src/q.ts': depthCutThenMemo('cba') }), ['src/q.ts:29:44 x_rows @src/q.ts#b', 'src/q.ts:30:45 v1_rows @src/q.ts#a']);
});

test('순환과 분기가 섞인 별칭 사슬도 같은 문맥에서는 끊긴 값을 다시 써 이름 해석 예산 안에 끝난다', () => {
  const lines = ["import { Pool } from 'pg';", 'const pool = new Pool();', 'type T0 = typeof x;'];
  for (let level = 1; level <= 18; level++) lines.push(`type T${level} = T${level - 1} | T${level - 1} | T${level - 1};`);
  lines.push('const x: Pool = pool as T18;', "export async function run() { return x.query('select * from fan_rows'); }", '');
  assert.deepEqual(withOriginBudget(20_000, () => ormLines({ 'src/q.ts': lines.join('\n') })), ['src/q.ts:23:46 fan_rows @src/q.ts#run']);
});

test('여러 선언이 서로의 typeof를 합 타입으로 참조하는 넓은 순환은 재계산 상한에서 멈추고 limitation으로 알린다', () => {
  // 선언 16개가 `T = typeof a0 | … | typeof a15`, `aN: T & Pool`이다. 정확한 문맥 조건만 쓰면 계산 중인 선언
  // 집합마다 T를 다시 계산해 선언 수에 지수적으로 늘어난다.
  const width = 16;
  const lines = ["import { Pool } from 'pg';", `type T = ${Array.from({ length: width }, (_, index) => `typeof a${index}`).join(' | ')};`];
  for (let index = 0; index < width; index++) lines.push(`declare const a${index}: T & Pool;`);
  lines.push('declare const v: T;', "export async function run() { return v.query('select * from wide_rows'); }", '');
  const result = withOriginBudget(50_000, () => extractProject({ 'src/q.ts': lines.join('\n') }));
  assert.deepEqual(usrLines(result), ['src/q.ts:20:46 wide_rows @src/q.ts#run']);
  assert.ok(result.limitations.some((limitation) => limitation.startsWith('orm-evaluation-truncated: ')), JSON.stringify(result.limitations));
});

test('값 평가: 이름공간·재수출·CommonJS·import=·조건·대체 연산자·타입 별칭·ReturnType·교차 타입·객체 스키마', () => {
  assert.deepEqual(ormLines({
  'src/lib/pool.ts': "import pg = require('pg');\nexport const pool = new pg.Pool();\nexport default pool;\n",
  'src/lib/index.ts': "export * from './pool';\nexport { default as defaultPool } from './pool';\n",
  'src/lib/cjs.js': "const Pool = require('pg').Pool;\nconst { Client: PgClient } = require('pg');\nmodule.exports = { pool: new Pool(), client: new PgClient() };\n",
  'src/q.ts': [
    "import * as lib from './lib';",
    "import cjs = require('./lib/cjs');",
    "import type { Knex } from 'knex';",
    "import knexFactory from 'knex';",
    "import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';",
    "import { drizzle } from 'drizzle-orm/better-sqlite3';",
    "import { relations } from 'drizzle-orm';",
    "export const things = sqliteTable('things', { id: integer() });",
    "export const parts = sqliteTable('parts', { id: integer(), thingId: integer('thing_id') });",
    "export const thingRelations = relations(things, function ({ many }) { return { parts: many(parts) }; });",
    'const schemaParts = { parts };',
    'const db = drizzle(\'file\', { schema: { ...schemaParts, things, ignored: 1 } });',
    'function makeKnex(): Knex { return knexFactory({}); }',
    'type Trx = Knex.Transaction & { tag?: string };',
    'let cached: ReturnType<typeof makeKnex> | null = null;',
    'export async function run(flag: boolean, trx: Trx, maybe?: Knex | undefined) {',
    "  await lib.pool.query('select * from ns_pool');",
    "  await lib.defaultPool.query('select * from ns_default');",
    "  await lib['pool'].query('select * from ns_element');",
    "  await cjs.pool.query('select * from cjs_pool');",
    "  await cjs.client.query('select * from cjs_client');",
    "  const chosen = flag ? lib.pool : null;",
    "  await chosen!.query('select * from cond_pool');",
    "  await (cached ?? makeKnex())('fallback_rows');",
    "  await trx('trx_rows');",
    "  await maybe!('maybe_rows');",
    "  await (flag ? trx : maybe!)('either_rows');",
    '  const reader = async () => makeKnex();',
    "  await (await reader())('arrow_rows');",
    "  return db.query.things.findMany({ with: { parts: true } });",
    '}',
    '',
  ].join('\n'),
}), [
    'src/q.ts:8:35 things @src/q.ts#model:things',
    'src/q.ts:8:47 things.id @src/q.ts#model:things.id',
    'src/q.ts:9:34 parts @src/q.ts#model:parts',
    'src/q.ts:9:45 parts.id @src/q.ts#model:parts.id',
    'src/q.ts:9:60 parts.thing_id @src/q.ts#model:parts.thingId',
    'src/q.ts:17:24 ns_pool @src/q.ts#run',
    'src/q.ts:18:31 ns_default @src/q.ts#run',
    'src/q.ts:19:27 ns_element @src/q.ts#run',
    'src/q.ts:20:24 cjs_pool @src/q.ts#run',
    'src/q.ts:21:26 cjs_client @src/q.ts#run',
    'src/q.ts:23:23 cond_pool @src/q.ts#run',
    'src/q.ts:24:32 fallback_rows @src/q.ts#run',
    'src/q.ts:25:13 trx_rows @src/q.ts#run',
    'src/q.ts:26:16 maybe_rows @src/q.ts#run',
    'src/q.ts:27:31 either_rows @src/q.ts#run',
    'src/q.ts:29:26 arrow_rows @src/q.ts#run',
    'src/q.ts:30:19 things @src/q.ts#run',
    'src/q.ts:30:45 parts @src/q.ts#run',
  ]);
});
