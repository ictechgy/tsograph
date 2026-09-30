/**
 * TypeORM 쿼리 사용을 사실로 읽는다.
 *
 * - 저장소(`getRepository(User)`, `Repository<User>`, `@InjectRepository(User)`, `extends Repository<User>`의 `this`)와
 *   ActiveRecord 엔터티 클래스(`User.find()`)의 쿼리 메서드: 엔터티 테이블. 찾기 옵션의 `where`·`select`·`order` 키와
 *   `…By(where)`·`insert`·`save`·`update`의 객체 키는 컬럼, `relations`는 대상 엔터티 테이블(과 조인 테이블)이다.
 * - EntityManager·DataSource의 메서드는 첫 인자가 엔터티 클래스일 때만 읽는다.
 * - QueryBuilder: `from`·`into`·`update`·`…Join…`의 엔터티 인자, 같은 사슬의 별칭으로 푼 `'u.photos'` 관계 경로,
 *   TypeORM 사슬의 문자열 테이블 이름.
 * - `query(sql)`: SQL 텍스트.
 */

import ts from 'typescript';

import { bump, unwrap } from './orm-facts.ts';
import type { TypeormEntity } from './orm-model.ts';
import { type OrmContext, readSqlArgument } from './orm-sql.ts';
import { TYPEORM, type TypeormCatalog } from './typeorm-catalog.ts';
import { objectMember, type OrmValue, propertyNameText } from './orm-values.ts';

/** 찾기 옵션 객체를 첫 인자로 받는 저장소 메서드다. */
const findOptionMethods: ReadonlySet<string> = new Set(['find', 'findOne', 'findOneOrFail', 'findAndCount', 'count', 'exists', 'exist']);

/** where 객체를 첫 인자로 받는 저장소 메서드다. */
const whereMethods: ReadonlySet<string> = new Set([
  'findBy', 'findOneBy', 'findOneByOrFail', 'findAndCountBy', 'countBy', 'existsBy', 'delete', 'softDelete', 'restore',
]);

/** 값 객체(또는 배열)를 첫 인자로 받는 저장소 메서드다. */
const valueMethods: ReadonlySet<string> = new Set(['insert', 'save', 'upsert', 'softRemove', 'remove', 'recover', 'preload']);

/** 테이블만 쓰는 그 밖의 저장소 메서드다. */
const plainMethods: ReadonlySet<string> = new Set([
  'update', 'increment', 'decrement', 'clear', 'sum', 'average', 'minimum', 'maximum', 'findByIds', 'createQueryBuilder',
]);

/** 첫 인자로 테이블(엔터티·문자열)을 받는 QueryBuilder 메서드다. */
const builderTableMethods: ReadonlySet<string> = new Set([
  'from', 'into', 'update', 'innerJoin', 'leftJoin', 'innerJoinAndSelect', 'leftJoinAndSelect',
]);

/** 둘째 인자로 테이블을 받는 QueryBuilder 메서드(`innerJoinAndMapOne(mapTo, User, 'u')`)다. */
const mappedJoinMethods: ReadonlySet<string> = new Set(['innerJoinAndMapOne', 'innerJoinAndMapMany', 'leftJoinAndMapOne', 'leftJoinAndMapMany']);

/** 연산 이름 → 옵션 인자 위치 해석이다. */
type OperationShape = 'find' | 'where' | 'values' | 'update' | 'plain';

/**
 * 저장소 연산의 인자 모양이다.
 *
 * @param method 메서드 이름
 * @returns 모양 또는 undefined(쿼리 메서드가 아님)
 */
function operationShape(method: string): OperationShape | undefined {
  if (findOptionMethods.has(method)) return 'find';
  if (whereMethods.has(method)) return 'where';
  if (valueMethods.has(method)) return 'values';
  if (method === 'update') return 'update';
  return plainMethods.has(method) ? 'plain' : undefined;
}

/** 저장소처럼 테이블 하나를 가리키는 수신자다. */
type EntityReceiver = { readonly entity: TypeormEntity } | undefined;

/** TypeORM 사용 스캐너다. */
export class TypeormUsage {
  /** 분석 문맥이다. */
  private readonly context: OrmContext;
  /** 선언 목록이다. */
  private readonly catalog: TypeormCatalog;

  /**
   * @param context 분석 문맥
   * @param catalog 선언 목록
   */
  constructor(context: OrmContext, catalog: TypeormCatalog) {
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
    const receiver = this.receiverValue(callee.expression);
    const entity = entityReceiver(receiver);
    if (entity !== undefined) this.repositoryCall(node, method, entity.entity, callee.name);
    else if (receiver.kind === 'typeorm-manager') this.managerCall(node, method);
    else if (receiver.kind === 'unknown' && (whereMethods.has(method) && method.endsWith('By')) && this.catalog.all.length > 0) {
      bump(this.context.emitter.counts.unresolvedReceivers, TYPEORM);
    }
    if ((builderTableMethods.has(method) || mappedJoinMethods.has(method)) && (receiver.kind === 'typeorm-manager' || this.isTypeormChain(node))) {
      this.builderCall(node, method);
    }
  }

  /**
   * 수신자 식의 값이다(`this`는 사용자 저장소 클래스를 본다).
   *
   * @param expression 수신자 식
   * @returns 값
   */
  private receiverValue(expression: ts.Expression): OrmValue {
    const { evaluator } = this.context;
    return expression.kind === ts.SyntaxKind.ThisKeyword ? evaluator.thisValue(expression) : evaluator.valueOf(expression);
  }

  /**
   * 저장소·엔터티 클래스의 쿼리 메서드 호출이다.
   *
   * @param node 호출 식
   * @param method 메서드 이름
   * @param entity 엔터티
   * @param at 위치(메서드 이름)
   */
  private repositoryCall(node: ts.CallExpression, method: string, entity: TypeormEntity, at: ts.Node): void {
    if (method === 'query') {
      readSqlArgument(this.context, node.arguments[0]);
      return;
    }
    const shape = operationShape(method);
    if (shape === undefined) return;
    this.context.emitter.useTable(entity.table, undefined, at);
    this.readArguments(shape, node.arguments, entity);
  }

  /**
   * EntityManager·DataSource 메서드 호출이다(첫 인자가 엔터티일 때만).
   *
   * @param node 호출 식
   * @param method 메서드 이름
   */
  private managerCall(node: ts.CallExpression, method: string): void {
    if (method === 'query') {
      readSqlArgument(this.context, node.arguments[0]);
      return;
    }
    const [first, ...rest] = node.arguments;
    const shape = operationShape(method);
    const value = first === undefined || shape === undefined ? undefined : this.context.evaluator.valueOf(first);
    if (first === undefined || shape === undefined || value?.kind !== 'typeorm-entity') return;
    this.context.emitter.useTable(value.entity.table, undefined, first);
    this.readArguments(shape, rest, value.entity);
  }

  /**
   * 연산 인자의 컬럼·관계를 읽는다.
   *
   * @param shape 인자 모양
   * @param args 엔터티 인자를 뺀 인자
   * @param entity 엔터티
   */
  private readArguments(shape: OperationShape, args: readonly ts.Expression[], entity: TypeormEntity): void {
    const [first, second] = args;
    if (first === undefined) return;
    if (shape === 'find') this.readFindOptions(first, entity);
    else if (shape === 'where' || shape === 'values') this.readColumnObject(first, entity, 0);
    else if (shape === 'update') {
      this.readColumnObject(first, entity, 0);
      if (second !== undefined) this.readColumnObject(second, entity, 0);
    }
  }

  /**
   * 찾기 옵션(`where`·`select`·`order`·`relations`)을 읽는다.
   *
   * @param options 옵션 식
   * @param entity 엔터티
   */
  private readFindOptions(options: ts.Expression, entity: TypeormEntity): void {
    const object = unwrap(options);
    if (!ts.isObjectLiteralExpression(object)) return;
    for (const key of ['where', 'order']) {
      const member = objectMember(object, key);
      if (member !== undefined) this.readColumnObject(member, entity, 0);
    }
    const select = objectMember(object, 'select');
    if (select !== undefined) this.readColumnList(select, entity);
    const relations = objectMember(object, 'relations');
    if (relations !== undefined) this.readRelations(relations, entity, 0);
  }

  /**
   * 객체(또는 객체 배열)의 키를 컬럼 사실로 낸다. 임베디드 키는 안쪽 객체를 따라간다.
   *
   * @param value 객체 식
   * @param entity 엔터티
   * @param depth 깊이
   * @param prefix 임베디드 경로
   */
  private readColumnObject(value: ts.Expression, entity: TypeormEntity, depth: number, prefix = ''): void {
    const inner = unwrap(value);
    const objects = ts.isArrayLiteralExpression(inner) ? inner.elements.map(unwrap) : [inner];
    for (const object of objects) {
      if (!ts.isObjectLiteralExpression(object) || depth > 4) continue;
      for (const property of object.properties) {
        const key = property.name === undefined ? undefined : propertyNameText(property.name);
        if (key === undefined || property.name === undefined) continue;
        this.emitColumn(entity, `${prefix}${key}`, property.name);
        if (ts.isPropertyAssignment(property) && hasEmbedded(entity, `${prefix}${key}`)) {
          this.readColumnObject(property.initializer, entity, depth + 1, `${prefix}${key}.`);
        }
      }
    }
  }

  /**
   * `select`의 문자열 배열 또는 객체 키를 컬럼 사실로 낸다.
   *
   * @param value select 식
   * @param entity 엔터티
   */
  private readColumnList(value: ts.Expression, entity: TypeormEntity): void {
    const inner = unwrap(value);
    if (!ts.isArrayLiteralExpression(inner)) {
      this.readColumnObject(inner, entity, 0);
      return;
    }
    for (const element of inner.elements.map(unwrap)) {
      if (ts.isStringLiteralLike(element)) this.emitColumn(entity, element.text, element);
    }
  }

  /**
   * `relations`(문자열 배열 또는 객체)의 대상 엔터티 테이블과 조인 테이블을 사실로 낸다.
   *
   * @param value relations 식
   * @param entity 원본 엔터티
   * @param depth 깊이
   */
  private readRelations(value: ts.Expression, entity: TypeormEntity, depth: number): void {
    const inner = unwrap(value);
    if (depth > 6) return;
    if (ts.isArrayLiteralExpression(inner)) {
      for (const element of inner.elements.map(unwrap)) {
        if (ts.isStringLiteralLike(element)) this.relationPath(entity, element.text.split('.'), element);
      }
      return;
    }
    if (!ts.isObjectLiteralExpression(inner)) return;
    for (const property of inner.properties) {
      const key = property.name === undefined ? undefined : propertyNameText(property.name);
      const target = key === undefined || property.name === undefined ? undefined : this.useRelation(entity, key, property.name);
      if (target !== undefined && ts.isPropertyAssignment(property)) this.readRelations(property.initializer, target, depth + 1);
    }
  }

  /**
   * 점으로 이은 관계 경로(`'photos.tags'`)를 따라 각 대상 테이블을 사실로 낸다.
   *
   * @param entity 원본 엔터티
   * @param path 관계 이름 목록
   * @param at 위치
   */
  private relationPath(entity: TypeormEntity, path: readonly string[], at: ts.Node): void {
    let current: TypeormEntity | undefined = entity;
    for (const name of path) {
      if (current === undefined) return;
      current = this.useRelation(current, name, at);
    }
  }

  /**
   * 관계 하나의 대상 테이블(다대다면 조인 테이블도)을 사실로 내고 대상 엔터티를 돌려준다.
   *
   * @param entity 원본 엔터티
   * @param property 관계 속성
   * @param at 위치
   * @returns 대상 엔터티 또는 undefined
   */
  private useRelation(entity: TypeormEntity, property: string, at: ts.Node): TypeormEntity | undefined {
    const relation = entity.relations.get(property);
    const target = relation === undefined ? undefined : this.catalog.targetOf(relation);
    if (target === undefined) return undefined;
    this.context.emitter.useTable(target.table, undefined, at);
    const junction = this.catalog.joinTable(entity, property) ?? this.inverseJunction(entity, target, property);
    if (junction !== undefined) this.context.emitter.useTable(junction.table, undefined, at);
    return target;
  }

  /**
   * 소유하지 않은 쪽 다대다(`@ManyToMany(() => A, (a) => a.bs)`)의 조인 테이블이다. 대상 쪽에서 원본을 가리키는
   * `@JoinTable` 관계가 하나일 때만 찾는다.
   *
   * @param entity 원본 엔터티
   * @param target 대상 엔터티
   * @param property 관계 속성
   * @returns 조인 테이블 또는 undefined
   */
  private inverseJunction(entity: TypeormEntity, target: TypeormEntity, property: string): ReturnType<TypeormCatalog['joinTable']> {
    if (entity.relations.get(property)?.kind !== 'many-to-many') return undefined;
    const owners = [...target.relations].filter(([, relation]) => relation.kind === 'many-to-many' && relation.joinTable !== undefined
      && this.catalog.targetOf(relation) === entity);
    return owners.length === 1 ? this.catalog.joinTable(target, owners[0]![0]) : undefined;
  }

  /**
   * 속성이 엔터티 컬럼이면 컬럼 사실을 낸다.
   *
   * @param entity 엔터티
   * @param property 속성 경로
   * @param at 위치
   */
  private emitColumn(entity: TypeormEntity, property: string, at: ts.Node): void {
    const column = entity.columns.get(property)?.column;
    if (column !== undefined) this.context.emitter.useTable(entity.table, column, at);
  }

  /**
   * QueryBuilder 테이블 메서드 호출이다.
   *
   * @param node 호출 식
   * @param method 메서드 이름
   */
  private builderCall(node: ts.CallExpression, method: string): void {
    const index = mappedJoinMethods.has(method) ? 1 : 0;
    const argument = node.arguments[index];
    if (argument === undefined) return;
    const value = this.context.evaluator.valueOf(argument);
    if (value.kind === 'typeorm-entity') {
      this.context.emitter.useTable(value.entity.table, undefined, argument);
      return;
    }
    const inner = unwrap(argument);
    if (!ts.isStringLiteralLike(inner)) return;
    const [alias, relation, extra] = inner.text.split('.');
    if (relation !== undefined && extra === undefined && method !== 'from' && method !== 'into' && method !== 'update') {
      const owner = this.aliasEntity(node, alias!);
      if (owner !== undefined) this.useRelation(owner, relation, inner);
      return;
    }
    this.context.emitter.use(inner.text, undefined, false, inner);
  }

  /**
   * 호출 사슬이 TypeORM 값(저장소·매니저·엔터티)의 `createQueryBuilder`에서 시작하는지 본다.
   *
   * @param node 사슬 안의 호출
   * @returns TypeORM 사슬이면 true
   */
  private isTypeormChain(node: ts.CallExpression): boolean {
    return chainCalls(node).some((call) => {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'createQueryBuilder') return false;
      const receiver = this.receiverValue(callee.expression);
      return receiver.kind === 'typeorm-manager' || entityReceiver(receiver) !== undefined;
    });
  }

  /**
   * 사슬 앞쪽에서 별칭이 가리키는 엔터티를 찾는다: `repo.createQueryBuilder('u')`, `createQueryBuilder(User, 'u')`,
   * `from(User, 'u')`, `…Join(User, 'u')`.
   *
   * @param node 사슬 안의 호출
   * @param alias 별칭
   * @returns 엔터티 또는 undefined
   */
  private aliasEntity(node: ts.CallExpression, alias: string): TypeormEntity | undefined {
    for (const call of chainCalls(node)) {
      const callee = call.expression;
      if (!ts.isPropertyAccessExpression(callee)) continue;
      const [first, second] = call.arguments;
      if (callee.name.text === 'createQueryBuilder' && first !== undefined && isAlias(first, alias)) {
        const receiver = entityReceiver(this.receiverValue(callee.expression));
        if (receiver !== undefined) return receiver.entity;
      }
      if (second !== undefined && isAlias(second, alias) && first !== undefined) {
        const value = this.context.evaluator.valueOf(first);
        if (value.kind === 'typeorm-entity') return value.entity;
      }
    }
    return undefined;
  }
}

/**
 * 값이 테이블 하나를 가리키는 수신자(저장소, ActiveRecord 엔터티 클래스)면 엔터티를 돌려준다.
 *
 * @param value 수신자 값
 * @returns 엔터티 수신자 또는 undefined
 */
function entityReceiver(value: OrmValue): EntityReceiver {
  if (value.kind === 'typeorm-repository' || value.kind === 'typeorm-entity') return { entity: value.entity };
  return undefined;
}

/**
 * 엔터티가 그 경로 아래 임베디드 컬럼을 갖는지 본다.
 *
 * @param entity 엔터티
 * @param path 속성 경로
 * @returns 임베디드면 true
 */
function hasEmbedded(entity: TypeormEntity, path: string): boolean {
  return [...entity.columns.keys()].some((key) => key.startsWith(`${path}.`));
}

/**
 * 식이 그 별칭 문자열인지 본다.
 *
 * @param expression 식
 * @param alias 별칭
 * @returns 맞으면 true
 */
function isAlias(expression: ts.Expression, alias: string): boolean {
  const inner = unwrap(expression);
  return ts.isStringLiteralLike(inner) && inner.text === alias;
}

/**
 * 호출이 속한 메서드 사슬의 앞쪽 호출들이다(뿌리 쪽부터, 자신 제외).
 *
 * @param node 사슬 안의 호출
 * @returns 호출 목록
 */
function chainCalls(node: ts.CallExpression): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  let current: ts.Expression = node.expression;
  for (let step = 0; step < 64; step++) {
    if (ts.isPropertyAccessExpression(current)) current = current.expression;
    else if (ts.isCallExpression(current)) {
      calls.unshift(current);
      current = current.expression;
    } else break;
  }
  return calls;
}
