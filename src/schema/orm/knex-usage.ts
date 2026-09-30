/**
 * knex 쿼리 사용을 사실로 읽는다.
 *
 * 사슬 하나(`knex('users as u').join('posts as p', 'u.id', 'p.user_id').select('u.id').where(…)`)를 가장 바깥 호출에서
 * 한 번에 읽는다. 테이블은 `knex('t')`·`from`·`into`·`table`·`…join`의 문자열(`'t as a'`, `{ a: 't' }`, `'s.t'`)이고,
 * `withSchema('s')`는 본 테이블(위치 무관)과 그 뒤의 조인에 스키마를 붙인다(knex 3.3.0 `querybuilder.js` `join`,
 * `querycompiler.js` `tableName`). 컬럼은 별칭으로 한정했거나 사슬의 테이블이 하나일 때만 낸다.
 * `knex.raw(sql)`은 SQL 텍스트이고, `knex.schema.…`(DDL)는 사용으로 보지 않는다.
 */

import ts from 'typescript';

import { unwrap } from './orm-facts.ts';
import { qualifiedChannel } from './orm-model.ts';
import { type OrmContext, readSqlArgument } from './orm-sql.ts';
import { type OrmValue, propertyNameText } from './orm-values.ts';
import { escapeQualified } from '../sql-relations.ts';

/** 첫 인자가 테이블인 메서드다. */
const tableMethods: ReadonlySet<string> = new Set([
  'from', 'into', 'table', 'join', 'innerJoin', 'leftJoin', 'leftOuterJoin', 'rightJoin', 'rightOuterJoin', 'fullOuterJoin',
  'crossJoin', 'outerJoin',
]);

/** 조인 메서드(조건 인자의 컬럼을 읽는다)다. */
const joinMethods: ReadonlySet<string> = new Set([
  'join', 'innerJoin', 'leftJoin', 'leftOuterJoin', 'rightJoin', 'rightOuterJoin', 'fullOuterJoin', 'crossJoin', 'outerJoin',
]);

/** 모든 문자열 인자가 컬럼인 메서드다. */
const columnListMethods: ReadonlySet<string> = new Set(['select', 'column', 'columns', 'returning', 'first', 'pluck', 'groupBy', 'distinct']);

/** 첫 인자가 컬럼(또는 컬럼 → 값 객체)인 메서드다. */
const firstColumnMethods: ReadonlySet<string> = new Set([
  'where', 'andWhere', 'orWhere', 'whereNot', 'orWhereNot', 'whereIn', 'orWhereIn', 'whereNotIn', 'orWhereNotIn', 'whereNull',
  'orWhereNull', 'whereNotNull', 'orWhereNotNull', 'whereBetween', 'whereNotBetween', 'whereLike', 'whereILike', 'orderBy',
  'increment', 'decrement', 'having',
]);

/** 첫 인자 객체의 키가 컬럼인 메서드다. */
const valueObjectMethods: ReadonlySet<string> = new Set(['insert', 'update', 'onConflict', 'merge']);

/** 사슬에서 모은 테이블 하나다. */
interface ChainTable {
  readonly channel: string;
  readonly alias: string;
}

/** knex 사용 스캐너다. */
export class KnexUsage {
  /** 분석 문맥이다. */
  private readonly context: OrmContext;

  /**
   * @param context 분석 문맥
   */
  constructor(context: OrmContext) {
    this.context = context;
  }

  /**
   * 호출 식을 검사한다. 사슬의 가장 바깥 호출일 때만 사슬 전체를 읽는다.
   *
   * @param node 호출 식
   */
  call(node: ts.CallExpression): void {
    if (isInnerChainCall(node)) return;
    const calls = chainFrom(node);
    const root = calls[0];
    if (root === undefined || !this.isKnexRoot(root)) return;
    if (calls.some((call) => isSchemaAccess(call))) return;
    this.readChain(calls);
  }

  /**
   * 사슬의 첫 호출이 knex 인스턴스에서 시작하는지 본다(`knex('t')`, `knex.from(…)`, `knex.raw(…)`).
   *
   * @param root 첫 호출
   * @returns knex 사슬이면 true
   */
  private isKnexRoot(root: ts.CallExpression): boolean {
    const callee = root.expression;
    const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression : callee;
    return this.context.evaluator.valueOf(receiver).kind === 'knex';
  }

  /**
   * 사슬의 테이블·컬럼·SQL을 사실로 낸다.
   *
   * @param calls 뿌리부터의 호출 목록
   */
  private readChain(calls: readonly ts.CallExpression[]): void {
    const schema = mainSchema(calls);
    const tables: ChainTable[] = [];
    let joinSchema: string | undefined;
    for (const call of calls) {
      const method = methodName(call);
      if (method === 'withSchema') joinSchema = literalText(call.arguments[0]);
      if (method === 'raw') readSqlArgument(this.context, call.arguments[0]);
      if (method !== undefined && !tableMethods.has(method)) continue;
      const scope = method === undefined || !joinMethods.has(method) ? schema : joinSchema;
      const table = this.readTable(call.arguments[0], scope);
      if (table !== undefined) tables.push(table);
    }
    for (const call of calls) this.readColumns(call, tables);
  }

  /**
   * 테이블 인자 하나를 사실로 내고 별칭과 함께 돌려준다.
   *
   * @param argument 테이블 인자
   * @param schema 붙일 스키마
   * @returns 테이블 또는 undefined(부분 쿼리·콜백 등)
   */
  private readTable(argument: ts.Expression | undefined, schema: string | undefined): ChainTable | undefined {
    const inner = argument === undefined ? undefined : unwrap(argument);
    if (inner === undefined) return undefined;
    if (ts.isObjectLiteralExpression(inner)) return this.readAliasObject(inner, schema);
    const value = ts.isStringLiteralLike(inner) ? undefined : this.context.evaluator.valueOf(inner);
    const text = ts.isStringLiteralLike(inner) ? inner.text : value?.kind === 'string' ? value.value : undefined;
    if (text === undefined) {
      if (!isSubquery(inner, value)) this.context.emitter.dynamic(inner, inner);
      return undefined;
    }
    const [name, alias] = splitAlias(text);
    const channel = schema === undefined ? escapeQualified(name) : qualifiedChannel(schema, name);
    this.context.emitter.use(channel, undefined, false, inner);
    return { channel, alias: alias ?? name.split('.').at(-1)! };
  }

  /**
   * `{ a: 'users' }` 별칭 객체의 테이블이다.
   *
   * @param object 별칭 객체
   * @param schema 붙일 스키마
   * @returns 테이블 또는 undefined
   */
  private readAliasObject(object: ts.ObjectLiteralExpression, schema: string | undefined): ChainTable | undefined {
    const [property] = object.properties;
    if (property === undefined || !ts.isPropertyAssignment(property)) return undefined;
    const alias = propertyNameText(property.name);
    const value = unwrap(property.initializer);
    if (alias === undefined || !ts.isStringLiteralLike(value)) return undefined;
    const channel = schema === undefined ? escapeQualified(value.text) : qualifiedChannel(schema, value.text);
    this.context.emitter.use(channel, undefined, false, value);
    return { channel, alias };
  }

  /**
   * 호출 하나의 컬럼 인자를 사실로 낸다.
   *
   * @param call 호출
   * @param tables 사슬의 테이블
   */
  private readColumns(call: ts.CallExpression, tables: readonly ChainTable[]): void {
    const method = methodName(call);
    if (method === undefined) return;
    const args = call.arguments;
    if (columnListMethods.has(method)) args.forEach((argument) => this.columnArgument(argument, tables));
    else if (firstColumnMethods.has(method) && args[0] !== undefined) this.columnArgument(args[0], tables);
    else if (valueObjectMethods.has(method) && args[0] !== undefined) this.columnArgument(args[0], tables);
    else if (joinMethods.has(method)) args.slice(1).forEach((argument) => this.columnArgument(argument, tables));
  }

  /**
   * 컬럼 인자(문자열, 문자열 배열, 컬럼 → 값 객체)를 사실로 낸다.
   *
   * @param argument 인자
   * @param tables 사슬의 테이블
   */
  private columnArgument(argument: ts.Expression, tables: readonly ChainTable[]): void {
    const inner = unwrap(argument);
    if (ts.isStringLiteralLike(inner)) this.columnReference(inner.text, inner, tables);
    else if (ts.isArrayLiteralExpression(inner)) inner.elements.forEach((element) => this.columnArgument(element, tables));
    else if (ts.isObjectLiteralExpression(inner)) {
      for (const property of inner.properties) {
        const key = property.name === undefined || ts.isComputedPropertyName(property.name) ? undefined : propertyNameText(property.name);
        if (key !== undefined && property.name !== undefined) this.columnReference(key, property.name, tables);
      }
    }
  }

  /**
   * 컬럼 참조 하나(`'u.id as uid'`, `'email'`)를 사실로 낸다.
   *
   * @param text 참조 문자열
   * @param at 위치
   * @param tables 사슬의 테이블
   */
  private columnReference(text: string, at: ts.Node, tables: readonly ChainTable[]): void {
    const [reference] = splitAlias(text);
    if (reference === '*' || !/^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)?$/u.test(reference)) return;
    const [first, second] = reference.split('.');
    const table = second === undefined ? (tables.length === 1 ? tables[0] : undefined) : tables.find((entry) => entry.alias === first);
    if (table !== undefined) this.context.emitter.use(table.channel, second ?? first, false, at);
  }
}

/**
 * 테이블 자리의 식이 부분 쿼리(콜백 함수, knex 빌더 값·사슬)인지 본다. 부분 쿼리는 테이블 이름이 아니다.
 *
 * @param expression 테이블 자리 식
 * @param value 식의 값
 * @returns 부분 쿼리면 true
 */
function isSubquery(expression: ts.Expression, value: OrmValue | undefined): boolean {
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression) || value?.kind === 'knex') return true;
  if (!ts.isCallExpression(expression)) return false;
  return ts.isPropertyAccessExpression(expression.expression) && ts.isCallExpression(unwrap(expression.expression.expression));
}

/**
 * 호출이 더 바깥 사슬 호출의 수신자인지 본다(`a.b().c()`의 `a.b()`).
 *
 * @param node 호출
 * @returns 안쪽 호출이면 true
 */
function isInnerChainCall(node: ts.CallExpression): boolean {
  const parent = node.parent;
  return ts.isPropertyAccessExpression(parent) && parent.expression === node && ts.isCallExpression(parent.parent)
    && parent.parent.expression === parent;
}

/**
 * 가장 바깥 호출에서 뿌리까지의 호출 목록(뿌리 먼저)이다.
 *
 * @param outermost 가장 바깥 호출
 * @returns 호출 목록
 */
function chainFrom(outermost: ts.CallExpression): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  let current: ts.Expression = outermost;
  for (let step = 0; step < 64; step++) {
    const inner = unwrap(current);
    if (ts.isCallExpression(inner)) {
      calls.unshift(inner);
      current = inner.expression;
    } else if (ts.isPropertyAccessExpression(inner) && ts.isCallExpression(unwrap(inner.expression))) {
      current = inner.expression;
    } else break;
  }
  return calls;
}

/**
 * 호출이 `knex.schema.…`(DDL) 사슬의 일부인지 본다.
 *
 * @param call 호출
 * @returns DDL이면 true
 */
function isSchemaAccess(call: ts.CallExpression): boolean {
  const callee = call.expression;
  return ts.isPropertyAccessExpression(callee) && ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === 'schema';
}

/**
 * 호출의 메서드 이름이다(`knex('t')`처럼 직접 호출이면 undefined).
 *
 * @param call 호출
 * @returns 메서드 이름 또는 undefined
 */
function methodName(call: ts.CallExpression): string | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined;
}

/**
 * 본 테이블에 붙는 스키마다(사슬의 마지막 `withSchema`).
 *
 * @param calls 호출 목록
 * @returns 스키마 또는 undefined
 */
function mainSchema(calls: readonly ts.CallExpression[]): string | undefined {
  let schema: string | undefined;
  for (const call of calls) if (methodName(call) === 'withSchema') schema = literalText(call.arguments[0]);
  return schema;
}

/**
 * 문자열 리터럴 인자의 값이다.
 *
 * @param argument 인자
 * @returns 값 또는 undefined
 */
function literalText(argument: ts.Expression | undefined): string | undefined {
  const inner = argument === undefined ? undefined : unwrap(argument);
  return inner !== undefined && ts.isStringLiteralLike(inner) ? inner.text : undefined;
}

/**
 * `'name as alias'`(대소문자 무관)를 이름과 별칭으로 나눈다.
 *
 * @param text 문자열
 * @returns [이름, 별칭]
 */
function splitAlias(text: string): [string, string | undefined] {
  const match = /^\s*(\S+)\s+as\s+(\S+)\s*$/iu.exec(text);
  return match === null ? [text.trim(), undefined] : [match[1]!, match[2]!];
}
