/**
 * Drizzle 쿼리 사용을 사실로 읽는다.
 *
 * - `db.select().from(t)`·`insert(t)`·`update(t)`·`delete(t)`·`…Join(t, …)`·`$count(t)`: 첫 인자가 테이블 객체일 때만
 *   (같은 이름의 `Map.delete` 등을 오독하지 않도록 테이블 출처가 증거다).
 * - `t.column` 접근: 그 테이블의 컬럼 사실. `insert(t).values({…})`·`update(t).set({…})`의 키도 컬럼이다.
 * - `db.query.<key>.findMany/findFirst({ with, columns })`: 스키마 키 → 테이블, `with` 키 → `relations()` 대상 테이블.
 * - `sql\`…\`` 태그 템플릿: 테이블 보간은 인용 테이블 이름, 컬럼 보간은 `"테이블"."컬럼"`, `sql.raw('…')`는 원문,
 *   `sql.identifier('…')`는 인용 이름, 그 밖의 보간은 바인드 파라미터 `?`로 읽는다.
 */

import ts from 'typescript';

import { DRIZZLE, type DrizzleCatalog, isDrizzleModule } from './drizzle-catalog.ts';
import { bump, unwrap } from './orm-facts.ts';
import type { DrizzleTable } from './orm-model.ts';
import { type OrmContext, quoteIdentifier, templateSql } from './orm-sql.ts';
import { objectMember, propertyNameText } from './orm-values.ts';

/** 첫 인자로 테이블을 받는 쿼리 빌더 메서드다. */
const tableMethods: ReadonlySet<string> = new Set([
  'from', 'insert', 'update', 'delete', '$count', 'innerJoin', 'leftJoin', 'rightJoin', 'fullJoin', 'crossJoin',
  'leftJoinLateral', 'innerJoinLateral', 'crossJoinLateral',
]);

/** 값 객체 키가 컬럼인 메서드(`insert(t).values({…})`, `update(t).set({…})`)다. */
const valueMethods: ReadonlySet<string> = new Set(['values', 'set']);

/** 충돌 시 갱신 옵션(`{ set: {…} }`)을 받는 메서드다. */
const upsertMethods: ReadonlySet<string> = new Set(['onConflictDoUpdate', 'onDuplicateKeyUpdate']);

/** 관계형 쿼리 연산이다. */
const relationalOperations: ReadonlySet<string> = new Set(['findMany', 'findFirst']);

/** Drizzle 사용 스캐너다(프로젝트 하나에 하나). */
export class DrizzleUsage {
  /** 분석 문맥이다. */
  private readonly context: OrmContext;
  /** 선언 목록이다. */
  private readonly catalog: DrizzleCatalog;
  /** 어떤 테이블의 컬럼 키인 이름 집합(속성 접근을 평가할지 빠르게 거른다)이다. */
  private readonly columnKeys: ReadonlySet<string>;

  /**
   * @param context 분석 문맥
   * @param catalog 선언 목록
   */
  constructor(context: OrmContext, catalog: DrizzleCatalog) {
    this.context = context;
    this.catalog = catalog;
    this.columnKeys = new Set(catalog.tables.flatMap((table) => [...table.columns.keys()]));
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
    if (tableMethods.has(method)) this.tableCall(node, method);
    else if (relationalOperations.has(method)) this.relationalQuery(node, callee);
  }

  /**
   * `t.column` 접근을 검사한다.
   *
   * @param node 속성 접근
   */
  propertyAccess(node: ts.PropertyAccessExpression): void {
    const key = node.name.text;
    if (!this.columnKeys.has(key)) return;
    const owner = this.context.evaluator.valueOf(node.expression);
    if (owner.kind !== 'drizzle-table') return;
    const column = owner.table.columns.get(key)?.column;
    if (column !== undefined) this.context.emitter.useTable(owner.table.table, column, node.name);
  }

  /**
   * `sql\`…\`` 태그 템플릿을 검사한다.
   *
   * @param node 태그 템플릿
   */
  taggedTemplate(node: ts.TaggedTemplateExpression): void {
    const { emitter } = this.context;
    if (isConsumed(node, emitter.consumed) || !this.isSqlTag(node.tag)) return;
    emitter.consume(node);
    emitter.sql(templateSql(node.template, (expression) => this.interpolation(expression)), node.template);
  }

  /**
   * 테이블 인자 메서드 호출이다.
   *
   * @param node 호출 식
   * @param method 메서드 이름
   */
  private tableCall(node: ts.CallExpression, method: string): void {
    const [argument] = node.arguments;
    const value = argument === undefined ? undefined : this.context.evaluator.valueOf(argument);
    if (argument === undefined || value?.kind !== 'drizzle-table') return;
    this.context.emitter.useTable(value.table.table, undefined, argument);
    if (method === 'insert' || method === 'update') this.readValueKeys(node, value.table);
  }

  /**
   * `insert(t)`·`update(t)` 뒤 사슬의 `.values({…})`·`.set({…})` 키를 컬럼 사실로 낸다.
   *
   * @param builder `insert(t)`·`update(t)` 호출
   * @param table 테이블
   */
  private readValueKeys(builder: ts.CallExpression, table: DrizzleTable): void {
    let current: ts.Expression = builder;
    for (let step = 0; step < 8; step++) {
      const access = current.parent;
      if (!ts.isPropertyAccessExpression(access) || access.expression !== current || !ts.isCallExpression(access.parent)) return;
      const call = access.parent;
      if (valueMethods.has(access.name.text)) for (const argument of call.arguments) this.readObjectKeys(argument, table);
      if (upsertMethods.has(access.name.text)) this.readUpsertSet(call.arguments[0], table);
      current = call;
    }
  }

  /**
   * `onConflictDoUpdate({ set: {…} })`·`onDuplicateKeyUpdate({ set })`의 `set` 키를 컬럼 사실로 낸다.
   *
   * @param options 옵션 인자
   * @param table 테이블
   */
  private readUpsertSet(options: ts.Expression | undefined, table: DrizzleTable): void {
    const object = options === undefined ? undefined : unwrap(options);
    const set = object !== undefined && ts.isObjectLiteralExpression(object) ? objectMember(object, 'set') : undefined;
    if (set !== undefined) this.readObjectKeys(set, table);
  }

  /**
   * 객체(또는 객체 배열) 인자의 키를 컬럼 사실로 낸다.
   *
   * @param argument 인자
   * @param table 테이블
   */
  private readObjectKeys(argument: ts.Expression, table: DrizzleTable): void {
    const inner = unwrap(argument);
    const objects = ts.isArrayLiteralExpression(inner) ? inner.elements.map(unwrap) : [inner];
    for (const object of objects) {
      if (!ts.isObjectLiteralExpression(object)) continue;
      for (const property of object.properties) {
        const key = property.name === undefined ? undefined : propertyNameText(property.name);
        const column = key === undefined ? undefined : table.columns.get(key)?.column;
        if (column !== undefined && property.name !== undefined) this.context.emitter.useTable(table.table, column, property.name);
      }
    }
  }

  /**
   * `db.query.<key>.findMany(opts)`·`findFirst(opts)`를 읽는다.
   *
   * @param node 호출 식
   * @param callee `db.query.<key>.findMany`
   */
  private relationalQuery(node: ts.CallExpression, callee: ts.PropertyAccessExpression): void {
    const keyAccess = callee.expression;
    if (!ts.isPropertyAccessExpression(keyAccess) || !ts.isPropertyAccessExpression(keyAccess.expression)
      || keyAccess.expression.name.text !== 'query') return;
    const query = this.context.evaluator.valueOf(keyAccess.expression);
    if (query.kind !== 'drizzle-query') {
      bump(this.context.emitter.counts.unresolvedReceivers, DRIZZLE);
      return;
    }
    const table = this.catalog.relationalTables(query.schema).get(keyAccess.name.text);
    if (table === undefined) {
      this.context.emitter.dynamic(keyAccess, keyAccess.name);
      return;
    }
    this.context.emitter.useTable(table.table, undefined, keyAccess.name);
    const [options] = node.arguments;
    if (options !== undefined) this.readRelationalOptions(options, table, 0);
  }

  /**
   * 관계형 쿼리 옵션의 `columns` 키와 `with` 관계를 읽는다(중첩 `with` 포함).
   *
   * @param options 옵션 식
   * @param table 대상 테이블
   * @param depth 중첩 깊이
   */
  private readRelationalOptions(options: ts.Expression, table: DrizzleTable, depth: number): void {
    const object = unwrap(options);
    if (!ts.isObjectLiteralExpression(object) || depth > 8) return;
    const columns = objectMember(object, 'columns');
    if (columns !== undefined) this.readObjectKeys(columns, table);
    const relations = objectMember(object, 'with');
    const relationObject = relations === undefined ? undefined : unwrap(relations);
    if (relationObject === undefined || !ts.isObjectLiteralExpression(relationObject)) return;
    const targets = this.catalog.relationsOf(table);
    for (const property of relationObject.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyNameText(property.name);
      const target = key === undefined ? undefined : targets.get(key);
      if (target === undefined) continue;
      this.context.emitter.useTable(target.table, undefined, property.name);
      this.readRelationalOptions(property.initializer, target, depth + 1);
    }
  }

  /**
   * 태그가 drizzle-orm의 `sql`인지 본다.
   *
   * @param tag 태그 식
   * @returns `sql`이면 true
   */
  private isSqlTag(tag: ts.Expression): boolean {
    const value = this.context.evaluator.valueOf(tag);
    return value.kind === 'external' && isDrizzleModule(value.module) && value.name === 'sql';
  }

  /**
   * `sql` 템플릿 보간 하나의 SQL 조각이다.
   *
   * @param expression 보간 식
   * @returns 조각 또는 undefined(바인드 파라미터)
   */
  private interpolation(expression: ts.Expression): string | undefined {
    const inner = unwrap(expression);
    if (ts.isTaggedTemplateExpression(inner) && this.isSqlTag(inner.tag)) {
      this.context.emitter.consume(inner);
      return templateSql(inner.template, (nested) => this.interpolation(nested));
    }
    if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && this.isSqlTag(inner.expression.expression)) {
      return this.helperFragment(inner.expression.name.text, inner.arguments[0]);
    }
    const value = this.context.evaluator.valueOf(inner);
    if (value.kind === 'drizzle-table') return value.table.table.dynamic ? undefined : quoteChannel(value.table.table.channel);
    return ts.isPropertyAccessExpression(inner) ? this.columnFragment(inner) : undefined;
  }

  /**
   * 컬럼 보간(`${users.email}`)의 조각 `"users"."email"`이다.
   *
   * @param access 속성 접근
   * @returns 조각 또는 undefined
   */
  private columnFragment(access: ts.PropertyAccessExpression): string | undefined {
    const owner = this.context.evaluator.valueOf(access.expression);
    if (owner.kind !== 'drizzle-table' || owner.table.table.dynamic) return undefined;
    const column = owner.table.columns.get(access.name.text)?.column;
    return column === undefined ? undefined : `${quoteChannel(owner.table.table.channel)}.${quoteIdentifier(column)}`;
  }

  /**
   * `sql.raw('…')`·`sql.identifier('…')`·`sql.empty()`의 조각이다.
   *
   * @param helper 도우미 이름
   * @param argument 첫 인자
   * @returns 조각 또는 undefined
   */
  private helperFragment(helper: string, argument: ts.Expression | undefined): string | undefined {
    if (helper === 'empty') return '';
    const value = argument === undefined ? undefined : this.context.evaluator.valueOf(argument);
    if (value?.kind !== 'string') return undefined;
    this.context.emitter.consume(value.node);
    if (helper === 'raw') return value.value;
    return helper === 'identifier' ? quoteIdentifier(value.value) : undefined;
  }
}

/**
 * channel(`s.t`, 세그먼트는 escape됨)을 인용 식별자 사슬로 바꾼다.
 *
 * @param channel channel
 * @returns `"s"."t"`
 */
function quoteChannel(channel: string): string {
  return channel.split('.').map((segment) => quoteIdentifier(segment.replaceAll('%2E', '.').replaceAll('%25', '%'))).join('.');
}

/**
 * 노드나 조상이 소비됐는지 본다.
 *
 * @param node 노드
 * @param consumed 소비 집합
 * @returns 소비됐으면 true
 */
function isConsumed(node: ts.Node, consumed: ReadonlySet<ts.Node>): boolean {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (consumed.has(current)) return true;
  }
  return false;
}
