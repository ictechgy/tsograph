/**
 * knex·원시 SQL 드라이버·Cloudflare D1 값 판정 규칙이다.
 *
 * 드라이버 값은 생성 호출(`new Pool()`, `createConnection()`, `createClient()`, `postgres()`, `neon()`)이나
 * 타입 표기(`Pool`, `D1Database`)로만 증명한다. D1 바인딩은 import가 없으므로 프로젝트(선언 파일 포함)에서
 * `NAME: D1Database`로 선언된 속성 이름을 모아 `env.NAME`·`c.env.NAME`·`this.env.NAME` 접근을 D1으로 본다.
 */

import ts from 'typescript';

import { unwrap } from './orm-facts.ts';
import type { OrmValue, OrmValueRules } from './orm-values.ts';

/** knex 표면 이름이다. */
export const KNEX = 'knex';

/** D1 바인딩 타입 이름이다. */
export const D1_TYPE_NAME = 'D1Database';

/** 드라이버 생성 함수: 모듈 → 함수 이름 → 값이다. */
const driverFactories: ReadonlyMap<string, ReadonlyMap<string, OrmValue>> = new Map([
  ['mysql2', factories(['createConnection', 'createPool', 'createPoolCluster'], client('mysql2'))],
  ['mysql2/promise', factories(['createConnection', 'createPool', 'createPoolCluster'], client('mysql2'))],
  ['mysql', factories(['createConnection', 'createPool', 'createPoolCluster'], client('mysql'))],
  ['@libsql/client', factories(['createClient'], client('libsql'))],
  ['@libsql/client/web', factories(['createClient'], client('libsql'))],
  ['@planetscale/database', factories(['connect'], client('planetscale'))],
  ['postgres', factories(['*', 'default'], tag('postgres'))],
  ['@neondatabase/serverless', factories(['neon'], tag('neon'))],
  ['@vercel/postgres', factories(['createPool', 'createClient'], client('vercel-postgres'))],
]);

/** 드라이버 클래스: 모듈 → 클래스 이름 → 값이다. */
const driverClasses: ReadonlyMap<string, ReadonlyMap<string, OrmValue>> = new Map([
  ['pg', factories(['Pool', 'Client'], client('pg'))],
  ['better-sqlite3', factories(['*', 'default'], client('better-sqlite3'))],
  ['sqlite3', factories(['Database'], client('sqlite3'))],
  ['@neondatabase/serverless', factories(['Pool', 'Client'], client('neon'))],
  ['@planetscale/database', factories(['Client'], client('planetscale'))],
]);

/** 드라이버 타입: 모듈 → 타입 이름 → 값이다. */
const driverTypes: ReadonlyMap<string, ReadonlyMap<string, OrmValue>> = new Map([
  ['pg', factories(['Pool', 'PoolClient', 'Client', 'ClientBase'], client('pg'))],
  ['mysql2', factories(['Connection', 'Pool', 'PoolConnection'], client('mysql2'))],
  ['mysql2/promise', factories(['Connection', 'Pool', 'PoolConnection'], client('mysql2'))],
  ['better-sqlite3', factories(['Database', 'default'], client('better-sqlite3'))],
  ['@libsql/client', factories(['Client', 'Transaction'], client('libsql'))],
  ['postgres', factories(['Sql', 'TransactionSql'], tag('postgres'))],
]);

/** 드라이버 값에서 또 드라이버 값을 돌려주는 메서드다(`pool.connect()`, `pool.getConnection()`). */
const derivedClientMethods: ReadonlySet<string> = new Set(['connect', 'getConnection', 'promise', 'connection', 'transaction', 'reserve', 'withSession']);

/** knex 인스턴스를 만드는 export 이름이다. */
const knexFactoryNames: ReadonlySet<string> = new Set(['*', 'default', 'knex', 'Knex']);

/** knex 인스턴스를 뜻하는 타입 이름이다. */
const knexTypeNames: ReadonlySet<string> = new Set(['Knex', 'Knex.Transaction', 'Knex.QueryBuilder']);

/**
 * 이름 목록을 같은 값으로 잇는 표를 만든다.
 *
 * @param names 이름 목록
 * @param value 값
 * @returns 이름 → 값
 */
function factories(names: readonly string[], value: OrmValue): Map<string, OrmValue> {
  return new Map(names.map((name) => [name, value]));
}

/**
 * SQL 클라이언트 값이다.
 *
 * @param driver 드라이버 이름
 * @returns 값
 */
function client(driver: string): OrmValue {
  return { kind: 'sql-client', driver };
}

/**
 * SQL 태그 함수 값이다.
 *
 * @param driver 드라이버 이름
 * @returns 값
 */
function tag(driver: string): OrmValue {
  return { kind: 'sql-tag', driver };
}

/**
 * 표에서 외부 export의 값을 찾는다.
 *
 * @param table 모듈 → 이름 → 값
 * @param value 외부 export 값
 * @returns 값 또는 undefined
 */
function lookup(table: ReadonlyMap<string, ReadonlyMap<string, OrmValue>>, value: OrmValue | { readonly kind: 'global' }): OrmValue | undefined {
  return value.kind === 'external' ? table.get(value.module)?.get(value.name) : undefined;
}

/**
 * knex·드라이버·D1 판정 규칙을 만든다.
 *
 * @param d1Bindings `D1Database`로 선언된 바인딩 이름
 * @returns 규칙
 */
export function driverRules(d1Bindings: ReadonlySet<string>): OrmValueRules {
  return {
    call: (callee) => {
      if (callee.kind === 'external' && callee.module === KNEX && knexFactoryNames.has(callee.name)) return { kind: 'knex' };
      return lookup(driverFactories, callee);
    },
    construct: (callee) => lookup(driverClasses, callee),
    methodCall: (receiver, method, node) => {
      if (receiver.kind === 'knex' && method === 'transaction' && node.arguments.length === 0) return receiver;
      if ((receiver.kind === 'sql-client' || receiver.kind === 'sql-tag') && derivedClientMethods.has(method)) return receiver;
      if (receiver.kind === 'external' && receiver.module === 'sqlite3' && method === 'verbose') return { kind: 'external', module: 'sqlite3', name: '*' };
      return undefined;
    },
    typeReference: (target) => {
      if (target.kind === 'global' && target.name === D1_TYPE_NAME) return client('d1');
      if (target.kind === 'external' && target.module === KNEX && knexTypeNames.has(target.name)) return { kind: 'knex' };
      return lookup(driverTypes, target);
    },
    member: (_receiver, name, node) => (d1Bindings.has(name) && isBindingAccess(node) ? client('d1') : undefined),
    callbackParameter: (call, callee, index) => {
      const method = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';
      if (callee.kind === 'knex' && method === 'transaction' && index === 0) return callee;
      if (callee.kind === 'sql-tag' && (method === 'begin' || method === 'transaction') && index === 0) return callee;
      return undefined;
    },
  };
}

/**
 * 식이 Workers 바인딩 접근인지 본다: `env.NAME`·`c.env.NAME`·`this.env.NAME`, 또는 구조 분해의 원본 `c.env`.
 *
 * @param node 접근 식 또는 구조 분해 원본 식
 * @returns 바인딩 접근이면 true
 */
export function isBindingAccess(node: ts.Expression): boolean {
  const inner = unwrap(node);
  if (isEnvExpression(inner)) return true;
  return (ts.isPropertyAccessExpression(inner) || ts.isElementAccessExpression(inner)) && isEnvExpression(unwrap(inner.expression));
}

/**
 * 식이 Workers 환경 객체(`env`, `x.env`)인지 본다.
 *
 * @param node 식
 * @returns 환경 객체면 true
 */
function isEnvExpression(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === 'env';
  return ts.isPropertyAccessExpression(node) && node.name.text === 'env';
}

/**
 * 파일에서 `NAME: D1Database`로 선언된 속성 이름을 모은다(인터페이스·타입 리터럴·클래스 필드).
 *
 * @param sourceFile 파일(선언 파일 포함)
 * @param names 이름 집합(추가된다)
 */
export function collectD1Bindings(sourceFile: ts.SourceFile, names: Set<string>): void {
  const visit = (node: ts.Node): void => {
    if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && node.type !== undefined && isD1Type(node.type)) {
      if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * 타입 표기가 `D1Database`(또는 그것과 null·undefined의 합)인지 본다.
 *
 * @param type 타입 노드
 * @returns D1 타입이면 true
 */
function isD1Type(type: ts.TypeNode): boolean {
  if (ts.isUnionTypeNode(type)) return type.types.some(isD1Type);
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === D1_TYPE_NAME;
}
