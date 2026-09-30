/**
 * 원시 SQL 드라이버와 Cloudflare D1의 SQL 텍스트를 사실로 읽는다.
 *
 * - SQL 클라이언트(`pg`·`mysql2`·`mysql`·`better-sqlite3`·`sqlite3`·libSQL·PlanetScale·Neon Pool·Vercel Postgres·D1)의
 *   `query`·`execute`·`prepare`·`exec`·`run`·`all`·`get`·`each` 첫 인자: SQL 텍스트(문자열 리터럴·const·`{ text }`·
 *   `{ sql }`). 보간 템플릿 문자열은 dynamic이다.
 * - libSQL `batch([…])`: 원소마다 SQL. D1 `batch([…])`는 원소가 이미 `prepare`로 읽힌 문장이라 다시 읽지 않는다.
 * - SQL 태그(`postgres`·`neon`·`@vercel/postgres`의 `sql\`…\``): 보간은 바인드 파라미터 `?`, postgres.js의
 *   `${sql('t')}`는 인용 식별자다. `sql.unsafe(text)`·`sql.query(text)`는 SQL 텍스트다.
 * - `env.NAME.prepare(…)`처럼 Workers 바인딩 모양이면 `D1Database` 선언을 못 찾았어도 D1으로 본다.
 */

import ts from 'typescript';

import { isBindingAccess } from './driver-rules.ts';
import { unwrap } from './orm-facts.ts';
import { type OrmContext, quoteIdentifier, readSqlArgument, templateSql } from './orm-sql.ts';
import type { OrmValue } from './orm-values.ts';

/** SQL 텍스트를 첫 인자로 받는 클라이언트 메서드다. */
const clientSqlMethods: ReadonlySet<string> = new Set(['query', 'execute', 'prepare', 'exec', 'run', 'all', 'get', 'each']);

/** SQL 텍스트를 첫 인자로 받는 태그 함수 메서드다. */
const tagSqlMethods: ReadonlySet<string> = new Set(['unsafe', 'query']);

/** D1 바인딩 모양 수신자에서 SQL을 받는 메서드다. */
const bindingSqlMethods: ReadonlySet<string> = new Set(['prepare', 'exec']);

/** 원시 드라이버 사용 스캐너다. */
export class DriverUsage {
  /** 분석 문맥이다. */
  private readonly context: OrmContext;

  /**
   * @param context 분석 문맥
   */
  constructor(context: OrmContext) {
    this.context = context;
  }

  /**
   * 호출 식을 검사한다.
   *
   * @param node 호출 식
   */
  call(node: ts.CallExpression): void {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    const receiver = this.context.evaluator.valueOf(callee.expression);
    if (isSqlClient(receiver)) this.clientCall(node, method, receiver);
    else if (isSqlTag(receiver) && tagSqlMethods.has(method)) readSqlArgument(this.context, node.arguments[0]);
    else if (receiver.kind === 'unknown' && bindingSqlMethods.has(method) && isBindingAccess(callee.expression)) {
      readSqlArgument(this.context, node.arguments[0]);
    }
  }

  /**
   * SQL 태그 템플릿을 검사한다.
   *
   * @param node 태그 템플릿
   */
  taggedTemplate(node: ts.TaggedTemplateExpression): void {
    const { emitter, evaluator } = this.context;
    if (emitter.consumed.has(node) || !isSqlTag(evaluator.valueOf(node.tag))) return;
    emitter.consume(node);
    emitter.sql(templateSql(node.template, (expression) => this.interpolation(expression)), node.template);
  }

  /**
   * SQL 클라이언트 메서드 호출이다.
   *
   * @param node 호출 식
   * @param method 메서드 이름
   * @param receiver 수신자 값
   */
  private clientCall(node: ts.CallExpression, method: string, receiver: OrmValue): void {
    if (clientSqlMethods.has(method)) {
      readSqlArgument(this.context, node.arguments[0]);
      return;
    }
    if (method !== 'batch' || receiver.kind !== 'sql-client' || receiver.driver !== 'libsql') return;
    const [statements] = node.arguments;
    const inner = statements === undefined ? undefined : unwrap(statements);
    if (inner !== undefined && ts.isArrayLiteralExpression(inner)) for (const element of inner.elements) readSqlArgument(this.context, element);
  }

  /**
   * 태그 템플릿 보간 하나의 조각이다: 같은 태그의 중첩 템플릿은 펼치고, `sql('t')` 식별자 도우미는 인용 이름이다.
   *
   * @param expression 보간 식
   * @returns 조각 또는 undefined(바인드 파라미터)
   */
  private interpolation(expression: ts.Expression): string | undefined {
    const { emitter, evaluator } = this.context;
    const inner = unwrap(expression);
    if (ts.isTaggedTemplateExpression(inner) && isSqlTag(evaluator.valueOf(inner.tag))) {
      emitter.consume(inner);
      return templateSql(inner.template, (nested) => this.interpolation(nested));
    }
    if (!ts.isCallExpression(inner) || !isSqlTag(evaluator.valueOf(inner.expression))) return undefined;
    const [argument] = inner.arguments;
    const value = argument === undefined ? undefined : evaluator.valueOf(argument);
    return value?.kind === 'string' ? quoteIdentifier(value.value) : undefined;
  }
}

/**
 * 값이 SQL 클라이언트인지 본다(`@vercel/postgres`의 `db` export 포함).
 *
 * @param value 값
 * @returns 클라이언트면 true
 */
function isSqlClient(value: OrmValue): boolean {
  return value.kind === 'sql-client' || (value.kind === 'external' && value.module === '@vercel/postgres' && value.name === 'db');
}

/**
 * 값이 SQL 태그 함수인지 본다(`@vercel/postgres`의 `sql` export 포함).
 *
 * @param value 값
 * @returns 태그면 true
 */
function isSqlTag(value: OrmValue): boolean {
  return value.kind === 'sql-tag' || (value.kind === 'external' && value.module === '@vercel/postgres' && value.name === 'sql');
}
