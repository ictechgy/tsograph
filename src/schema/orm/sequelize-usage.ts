/**
 * Sequelize 쿼리 사용을 사실로 읽는다.
 *
 * - 모델 정적 메서드(`User.findAll`·`create`·`update`·`destroy`…): 모델 테이블(위치는 메서드 이름). `where` 키,
 *   `attributes` 문자열, `create`·`bulkCreate`·`update` 값 객체 키는 컬럼(속성 → `field`)이다.
 * - `include: [Post]`·`include: [{ model: Post, include: […] }]`: 포함한 모델 테이블.
 * - `sequelize.query(sql)`: SQL 텍스트.
 */

import ts from 'typescript';

import { bump, unwrap } from './orm-facts.ts';
import type { SequelizeModel } from './orm-model.ts';
import { type OrmContext, readSqlArgument } from './orm-sql.ts';
import { SEQUELIZE, type SequelizeCatalog } from './sequelize-catalog.ts';
import { objectMember, propertyNameText } from './orm-values.ts';

/** 첫 인자가 찾기 옵션인 모델 메서드다. */
const findMethods: ReadonlySet<string> = new Set([
  'findAll', 'findOne', 'findAndCountAll', 'count', 'destroy', 'restore', 'findOrCreate', 'findCreateFind', 'findOrBuild', 'truncate',
]);

/** 첫 인자가 컬럼(문자열·배열·컬럼 → 값 객체)이고 둘째 인자가 찾기 옵션인 모델 메서드다. */
const columnFirstMethods: ReadonlySet<string> = new Set(['max', 'min', 'sum', 'increment', 'decrement']);

/** 첫 인자가 값 객체(또는 배열)인 모델 메서드다. */
const valueMethods: ReadonlySet<string> = new Set(['create', 'bulkCreate', 'upsert']);

/** 둘째 인자가 찾기 옵션인 모델 메서드다. */
const secondOptionMethods: ReadonlySet<string> = new Set(['findByPk']);

/** 모르는 수신자라도 Sequelize 모델 호출로 보이는 이름이다(계수만 한다). */
const distinctiveMethods: ReadonlySet<string> = new Set(['findAll', 'findByPk', 'findAndCountAll', 'bulkCreate', 'findOrCreate']);

/** Sequelize 사용 스캐너다. */
export class SequelizeUsage {
  /** 분석 문맥이다. */
  private readonly context: OrmContext;
  /** 선언 목록이다. */
  private readonly catalog: SequelizeCatalog;

  /**
   * @param context 분석 문맥
   * @param catalog 선언 목록
   */
  constructor(context: OrmContext, catalog: SequelizeCatalog) {
    this.context = context;
    this.catalog = catalog;
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
    const isOperation = findMethods.has(method) || valueMethods.has(method) || secondOptionMethods.has(method)
      || columnFirstMethods.has(method) || method === 'update' || method === 'aggregate';
    if (method === 'query') {
      if (this.context.evaluator.valueOf(callee.expression).kind === 'sequelize') readSqlArgument(this.context, node.arguments[0]);
      return;
    }
    if (!isOperation) return;
    const model = this.catalog.modelOf(callee.expression);
    if (model === undefined) {
      if (distinctiveMethods.has(method) && this.catalog.all.length > 0) bump(this.context.emitter.counts.unresolvedReceivers, SEQUELIZE);
      return;
    }
    this.context.emitter.useTable(model.table, undefined, callee.name);
    this.readArguments(method, node.arguments, model);
  }

  /**
   * 연산 인자의 컬럼·포함 모델을 읽는다.
   *
   * @param method 메서드 이름
   * @param args 인자
   * @param model 모델
   */
  private readArguments(method: string, args: readonly ts.Expression[], model: SequelizeModel): void {
    const [first, second] = args;
    if (findMethods.has(method) && first !== undefined) this.readFindOptions(first, model, 0);
    else if (secondOptionMethods.has(method) && second !== undefined) this.readFindOptions(second, model, 0);
    else if (valueMethods.has(method) && first !== undefined) this.readValueKeys(first, model);
    else if (columnFirstMethods.has(method) || method === 'aggregate') this.readColumnFirst(method, args, model);
    else if (method === 'update') {
      if (first !== undefined) this.readValueKeys(first, model);
      if (second !== undefined) this.readFindOptions(second, model, 0);
    }
  }

  /**
   * `sum('age', opts)`·`increment(['a', 'b'], opts)`·`increment({ a: 1 }, opts)`·`aggregate('age', 'max', opts)`의
   * 컬럼과 옵션을 읽는다.
   *
   * @param method 메서드 이름
   * @param args 인자
   * @param model 모델
   */
  private readColumnFirst(method: string, args: readonly ts.Expression[], model: SequelizeModel): void {
    const [columns, second, third] = args;
    if (columns !== undefined) {
      const inner = unwrap(columns);
      if (ts.isObjectLiteralExpression(inner)) this.readValueKeys(inner, model);
      else if (ts.isArrayLiteralExpression(inner)) this.readAttributeList(inner, model);
      else if (ts.isStringLiteralLike(inner)) this.emitColumn(model, inner.text, inner);
    }
    const options = method === 'aggregate' ? third : second;
    if (options !== undefined) this.readFindOptions(options, model, 0);
  }

  /**
   * 찾기 옵션(`where`·`attributes`·`include`)을 읽는다.
   *
   * @param options 옵션 식
   * @param model 모델
   * @param depth include 깊이
   */
  private readFindOptions(options: ts.Expression, model: SequelizeModel, depth: number): void {
    const object = unwrap(options);
    if (!ts.isObjectLiteralExpression(object) || depth > 6) return;
    const where = objectMember(object, 'where');
    if (where !== undefined) this.readValueKeys(where, model);
    const defaults = objectMember(object, 'defaults');
    if (defaults !== undefined) this.readValueKeys(defaults, model);
    const attributes = objectMember(object, 'attributes');
    if (attributes !== undefined) this.readAttributeList(attributes, model);
    const include = objectMember(object, 'include');
    if (include !== undefined) this.readIncludes(include, depth);
  }

  /**
   * `include`(모델, `{ model, include, where }`, 그 배열)의 모델 테이블을 사실로 낸다.
   *
   * @param include include 식
   * @param depth 깊이
   */
  private readIncludes(include: ts.Expression, depth: number): void {
    const inner = unwrap(include);
    const items = ts.isArrayLiteralExpression(inner) ? inner.elements.map(unwrap) : [inner];
    for (const item of items) {
      const target = ts.isObjectLiteralExpression(item) ? objectMember(item, 'model') : item;
      const model = target === undefined ? undefined : this.catalog.modelOf(target);
      if (model === undefined || target === undefined) continue;
      this.context.emitter.useTable(model.table, undefined, target);
      if (ts.isObjectLiteralExpression(item)) this.readFindOptions(item, model, depth + 1);
    }
  }

  /**
   * 객체(또는 객체 배열)의 속성 키를 컬럼 사실로 낸다. 연산자 키(`[Op.or]`)는 건너뛴다.
   *
   * @param value 객체 식
   * @param model 모델
   * @param depth 연산자 피연산자 깊이
   */
  private readValueKeys(value: ts.Expression, model: SequelizeModel, depth = 0): void {
    const inner = unwrap(value);
    const objects = ts.isArrayLiteralExpression(inner) ? inner.elements.map(unwrap) : [inner];
    for (const object of objects) {
      if (!ts.isObjectLiteralExpression(object) || depth > 6) continue;
      for (const property of object.properties) {
        if (property.name !== undefined && ts.isComputedPropertyName(property.name)) {
          // 연산자 키(`[Op.or]: [{ email }, …]`)는 키가 아니라 피연산자 객체의 키가 컬럼이다.
          if (ts.isPropertyAssignment(property)) this.readValueKeys(property.initializer, model, depth + 1);
          continue;
        }
        const key = property.name === undefined ? undefined : propertyNameText(property.name);
        if (key !== undefined && property.name !== undefined) this.emitColumn(model, key, property.name);
      }
    }
  }

  /**
   * `attributes`(문자열, `[속성, 별칭]`, `{ include, exclude }`)의 컬럼을 사실로 낸다.
   *
   * @param value attributes 식
   * @param model 모델
   */
  private readAttributeList(value: ts.Expression, model: SequelizeModel): void {
    const inner = unwrap(value);
    if (ts.isObjectLiteralExpression(inner)) {
      for (const key of ['include', 'exclude']) {
        const member = objectMember(inner, key);
        if (member !== undefined) this.readAttributeList(member, model);
      }
      return;
    }
    if (!ts.isArrayLiteralExpression(inner)) return;
    for (const element of inner.elements.map(unwrap)) {
      const name = ts.isArrayLiteralExpression(element) ? element.elements[0] : element;
      const literal = name === undefined ? undefined : unwrap(name);
      if (literal !== undefined && ts.isStringLiteralLike(literal)) this.emitColumn(model, literal.text, literal);
    }
  }

  /**
   * 속성이 모델 속성이면 컬럼 사실을 낸다.
   *
   * @param model 모델
   * @param attribute 속성 이름
   * @param at 위치
   */
  private emitColumn(model: SequelizeModel, attribute: string, at: ts.Node): void {
    const column = model.attributes.get(attribute)?.column;
    if (column !== undefined) this.context.emitter.useTable(model.table, column, at);
  }
}
