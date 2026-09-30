// ORM 이름 규칙 오라클: 합성 fixture를 실제 ORM으로 실행해 DB에 생기는(또는 쿼리가 참조하는) 테이블·컬럼
// 이름을 기록한다. tsograph는 이 기록과 자기 사실을 오프라인 테스트(src/schema/orm/oracle.test.ts)로 대조한다.
//
// - Drizzle: drizzle-kit `generateSQLiteMigration`으로 DDL을 만들어 sql.js에 적용하고 PRAGMA로 읽는다. 쿼리 함수는
//   fixture의 `createDb`(실제 casing 옵션)로 만든 빌더의 `toSQL()`을 기록한다. DDL은 fixture 마이그레이션으로도 쓴다.
// - TypeORM: fixture의 DataSource 옵션(entityPrefix 등) 그대로 `sqljs` 드라이버로 synchronize한 뒤 PRAGMA로 읽는다.
// - Sequelize: fixture가 만드는 `new Sequelize(…)`를 pg-mem 방언으로 바꿔 `sync()`한 뒤 information_schema를 읽는다.
// - knex: fixture 쿼리 함수의 `toSQL()`을 기록한다(DB 없음).
//
// 실행: `npm ci && npm run record` (이 디렉터리). 네트워크는 npm 레지스트리 설치에만 쓴다. fixture 코드는 `work/`에
// 옮겨 트랜스파일한 뒤 실행한다 — tsograph 자체는 분석 대상을 실행하지 않고, 이 스크립트는 합성 fixture만 실행한다.

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, '..', '..');
const workRoot = join(here, 'work');
const require = createRequire(import.meta.url);

/** 기록에 싣는 실행 라이브러리 버전이다. */
const packageVersions = (names) => Object.fromEntries(names.map((name) => [name, JSON.parse(readFileSync(join(here, 'node_modules', name, 'package.json'), 'utf8')).version]));

/**
 * fixture를 work 디렉터리로 옮기고 TS를 CommonJS로 트랜스파일한다.
 *
 * @param {string} fixture fixture 이름
 * @returns {string} work 안 fixture 루트
 */
function stageFixture(fixture) {
  const source = join(repository, 'fixtures', 'schema', fixture);
  const target = join(workRoot, fixture);
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  writeFileSync(join(target, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  for (const file of listFiles(join(target, 'src'))) {
    if (extname(file) !== '.ts') continue;
    const output = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true },
    });
    writeFileSync(file.replace(/\.ts$/u, '.js'), output.outputText);
  }
  return target;
}

/**
 * 디렉터리 아래 파일을 모두 나열한다.
 *
 * @param {string} directory 디렉터리
 * @returns {string[]} 파일 경로
 */
function listFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/**
 * sql.js 데이터베이스의 테이블·컬럼을 `table`·`table.column` 목록으로 읽는다.
 *
 * @param {(sql: string) => Array<Record<string, unknown>>} query 질의 함수
 * @returns {string[]} 정렬된 관계 목록
 */
function sqliteRelations(query) {
  const tables = query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'typeorm_%'");
  const result = [];
  for (const { name } of tables) {
    result.push(name);
    for (const column of query(`PRAGMA table_info("${name}")`)) result.push(`${name}.${column.name}`);
  }
  return result.sort();
}

/**
 * ORM이 만든 SQL(인용 식별자)에서 참조 테이블과 한정 컬럼을 읽는다.
 *
 * @param {string} sql SQL
 * @returns {{ relations: string[], columns: string[] }} 테이블과 `table.column`(별칭은 테이블로 푼다)
 */
function sqlReferences(sql) {
  const aliases = new Map();
  const relations = new Set();
  const identifier = '(?:"[^"]+"|[A-Za-z_]\\w*)';
  const tablePattern = new RegExp(`\\b(?:from|join|into|update)\\s+(${identifier}(?:\\.${identifier})?)(?:\\s+as\\s+("?)(\\w+)\\2|\\s+"(\\w+)")?`, 'giu');
  for (const match of sql.matchAll(tablePattern)) {
    const name = match[1].replaceAll('"', '');
    relations.add(name);
    aliases.set(match[3] ?? match[4] ?? name.split('.').at(-1), name);
    aliases.set(name.split('.').at(-1), name);
  }
  const columns = new Set();
  for (const match of sql.matchAll(/"([^"]+)"\."([^"]+)"/gu)) {
    const table = aliases.get(match[1]);
    if (table !== undefined && !relations.has(`${match[1]}.${match[2]}`)) columns.add(`${table}.${match[2]}`);
  }
  if (relations.size === 1) addUnqualifiedColumns(sql, [...relations][0], aliases, columns);
  return { relations: [...relations].sort(), columns: [...columns].sort() };
}

/**
 * 테이블이 하나인 SQL의 한정하지 않은 인용 식별자를 그 테이블의 컬럼으로 더한다.
 *
 * @param {string} sql SQL
 * @param {string} table 유일한 테이블
 * @param {Map<string, string>} aliases 별칭 → 테이블
 * @param {Set<string>} columns 컬럼(추가된다)
 */
function addUnqualifiedColumns(sql, table, aliases, columns) {
  const tokens = [...sql.matchAll(/"([^"]*)"/gu)];
  tokens.forEach((token, index) => {
    const qualifies = sql[token.index + token[0].length] === '.';
    const previous = tokens[index - 1];
    const qualified = previous !== undefined && previous.index + previous[0].length === token.index - 1 && sql[token.index - 1] === '.';
    if (!qualifies && !qualified && !aliases.has(token[1]) && !table.split('.').includes(token[1])) columns.add(`${table}.${token[1]}`);
  });
}

/**
 * Drizzle fixture를 기록한다. 생성한 DDL은 fixture 마이그레이션(0000)으로도 쓴다.
 *
 * @returns {Promise<object>} 기록
 */
async function recordDrizzle() {
  const fixture = 'drizzle-d1-app';
  const root = stageFixture(fixture);
  const load = createRequire(join(root, 'src', 'index.js'));
  const schema = load('./db/schema.js');
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import('drizzle-kit/api');
  // fixture의 drizzle() 호출과 같은 casing이다(실제 앱에서는 drizzle.config의 casing).
  const casing = 'snake_case';
  const empty = await generateSQLiteDrizzleJson({}, undefined, casing);
  const current = await generateSQLiteDrizzleJson(schema, empty.id, casing);
  const statements = await generateSQLiteMigration(empty, current);
  const migration = `${statements.join('\n--> statement-breakpoint\n')}\n`;
  writeFileSync(join(repository, 'fixtures', 'schema', fixture, 'migrations', '0000_init.sql'), migration);
  const SQL = await (await import('sql.js')).default();
  const database = new SQL.Database();
  for (const statement of statements) database.run(statement);
  const query = (sql) => {
    const [result] = database.exec(sql);
    return result === undefined ? [] : result.values.map((row) => Object.fromEntries(row.map((value, index) => [result.columns[index], value])));
  };
  // Drizzle가 선언한 이름(drizzle-kit DDL)과, 원시 SQL 마이그레이션까지 적용한 DB 전체 이름을 따로 기록한다.
  const declared = sqliteRelations(query);
  database.run(readFileSync(join(root, 'migrations', '0001_audit.sql'), 'utf8'));
  const db = load('./db/client.js').createDb({});
  const queries = {};
  for (const [name, build] of Object.entries(load('./db/queries.js'))) {
    const built = build(db, 1, 'x');
    const sql = typeof built.toSQL === 'function' ? built.toSQL().sql : db.dialect.sqlToQuery(built).sql;
    queries[`src/db/queries.ts#${name}`] = { sql, ...sqlReferences(sql) };
  }
  return { fixture: `fixtures/schema/${fixture}`, packages: packageVersions(['drizzle-orm', 'drizzle-kit', 'sql.js']), declared, relations: sqliteRelations(query), queries };
}

/**
 * TypeORM fixture를 기록한다.
 *
 * @returns {Promise<object>} 기록
 */
async function recordTypeorm() {
  const fixture = 'typeorm-app';
  const root = stageFixture(fixture);
  const load = createRequire(join(root, 'src', 'index.js'));
  load('reflect-metadata');
  const { DataSource } = load('typeorm');
  const { dataSourceOptions, entities } = load('./data-source.js');
  const source = new DataSource({ ...dataSourceOptions, type: 'sqljs', entities, synchronize: true, logging: false });
  await source.initialize();
  const rows = [];
  const tables = await source.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  for (const { name } of tables) rows.push({ name, columns: await source.query(`PRAGMA table_info("${name}")`) });
  await source.destroy();
  const relations = rows.flatMap(({ name, columns }) => [name, ...columns.map((column) => `${name}.${column.name}`)]).sort();
  return { fixture: `fixtures/schema/${fixture}`, packages: packageVersions(['typeorm', 'sql.js']), declared: relations, relations, queries: {} };
}

/**
 * Sequelize fixture를 기록한다. fixture의 `require('sequelize')`를 pg-mem 방언으로 바꾸는 얇은 대리 모듈을 둔다.
 *
 * @returns {Promise<object>} 기록
 */
async function recordSequelize() {
  const fixture = 'sequelize-app';
  const root = stageFixture(fixture);
  const shim = join(root, 'node_modules', 'sequelize');
  mkdirSync(shim, { recursive: true });
  writeFileSync(join(shim, 'index.js'), sequelizeShim());
  const load = createRequire(join(root, 'src', 'index.js'));
  load('./models/index.js');
  const sequelize = load('./db.js');
  await sequelize.sync();
  const memory = load('sequelize').__oracleMemory;
  const rows = memory.public.many("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'");
  const tables = new Set(rows.map((row) => row.table_name));
  const relations = [...tables, ...rows.map((row) => `${row.table_name}.${row.column_name}`)].sort();
  return { fixture: `fixtures/schema/${fixture}`, packages: packageVersions(['sequelize', 'pg-mem']), declared: relations, relations, queries: {} };
}

/**
 * pg-mem을 방언 모듈로 쓰는 Sequelize 대리 모듈 원문이다. 생성자 인자의 다른 옵션(`define` 등)은 그대로 넘긴다.
 *
 * @returns {string} 모듈 원문
 */
function sequelizeShim() {
  return [
    `const real = require(${JSON.stringify(require.resolve('sequelize'))});`,
    `const { newDb } = require(${JSON.stringify(require.resolve('pg-mem'))});`,
    'const memory = newDb();',
    'class OracleSequelize extends real.Sequelize {',
    "  constructor(_url, options = {}) { super('postgres://oracle@localhost:5432/oracle', { ...options, dialect: 'postgres', dialectModule: memory.adapters.createPg(), logging: false }); }",
    '}',
    '// 정적 멤버(DataTypes·Model 등)는 상속으로 보인다.',
    'OracleSequelize.Sequelize = OracleSequelize;',
    'OracleSequelize.default = OracleSequelize;',
    'OracleSequelize.__oracleMemory = memory;',
    'module.exports = OracleSequelize;',
    '',
  ].join('\n');
}

/**
 * knex fixture의 쿼리 SQL을 기록한다(pg 방언, 연결 없음).
 *
 * @returns {Promise<object>} 기록
 */
async function recordKnex() {
  const fixture = 'knex-app';
  const root = stageFixture(fixture);
  const load = createRequire(join(root, 'src', 'index.js'));
  const db = load('knex')({ client: 'pg' });
  const queries = {};
  for (const [name, build] of Object.entries(load('./queries.js'))) {
    const sql = build(db, 1).toSQL().sql;
    queries[`src/queries.ts#${name}`] = { sql, ...sqlReferences(sql) };
  }
  await db.destroy();
  return { fixture: `fixtures/schema/${fixture}`, packages: packageVersions(['knex', 'pg']), declared: [], relations: [], queries };
}

const recordings = { drizzle: recordDrizzle, typeorm: recordTypeorm, sequelize: recordSequelize, knex: recordKnex };
mkdirSync(join(here, 'recordings'), { recursive: true });
for (const [name, record] of Object.entries(recordings)) {
  const recording = await record();
  writeFileSync(join(here, 'recordings', `${name}.json`), `${JSON.stringify(recording, null, 2)}\n`);
  console.log(`${name}: ${recording.relations.length} relation name(s), ${Object.keys(recording.queries).length} query(ies) -> ${relative(repository, join(here, 'recordings', `${name}.json`))}`);
}
