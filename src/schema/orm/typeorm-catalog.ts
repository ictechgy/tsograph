/**
 * TypeORM 엔터티 선언과 DataSource 이름 옵션을 모으고, TypeORM 값 판정 규칙을 제공한다.
 *
 * 이름 규칙(typeorm 1.1.1·0.3.31 `naming-strategy/DefaultNamingStrategy.js`·`util/StringUtils.js`로 확인):
 *
 * - 테이블: `@Entity('name')`·`@Entity({ name })` 값, 없으면 `snakeCase(클래스 이름)`(`tableName`).
 *   DataSource `entityPrefix`가 앞에 붙는다(`prefixTableName`). `@ChildEntity`는 부모 엔터티 테이블이다.
 * - 컬럼: 데코레이터 옵션 `name`, 없으면 속성 이름 그대로(`columnName`). 임베디드는
 *   `camelCase(접두사들.join('_')) + titleCase(이름)`.
 * - 조인 컬럼(`@ManyToOne`, `@JoinColumn`이 붙은 `@OneToOne`): `camelCase(속성 + '_' + 대상 주 키 속성)`
 *   (`joinColumnName`).
 * - 조인 테이블(`@JoinTable`): `snakeCase(소유 테이블 + '_' + 속성 + '_' + 대상 테이블)`(`joinTableName`, 접두사 전
 *   이름), 컬럼은 `camelCase(테이블 + '_' + 주 키 컬럼)`(`joinTableColumnName`). 같은 이름이면 `_1`·`_2`가 붙는다.
 * - 사용자 `namingStrategy`가 보이면 명시 이름만 확정하고 나머지는 dynamic·생략한다(`orm-naming-unverified:`).
 */

import ts from 'typescript';

import type { SourceModule } from '../source-module.ts';
import { dynamicChannel } from '../relation-facts.ts';
import { bump, type OrmCounts, unwrap, walk } from './orm-facts.ts';
import { type OrmColumn, qualifiedChannel, type TableName, type TypeormEntity, type TypeormRelation } from './orm-model.ts';
import { objectMember, type OrmEvaluator, type OrmValue, type OrmValueRules, propertyNameText } from './orm-values.ts';

/** 표면 이름이다. */
export const TYPEORM = 'typeorm';

/** 엔터티를 선언하는 클래스 데코레이터다. */
const entityDecorators: ReadonlySet<string> = new Set(['Entity', 'ViewEntity', 'ChildEntity']);

/** 컬럼을 선언하는 속성 데코레이터다. */
const columnDecorators: ReadonlySet<string> = new Set([
  'Column', 'PrimaryColumn', 'PrimaryGeneratedColumn', 'CreateDateColumn', 'UpdateDateColumn', 'DeleteDateColumn',
  'VersionColumn', 'ViewColumn',
]);

/** 주 키 컬럼 데코레이터다. */
const primaryDecorators: ReadonlySet<string> = new Set(['PrimaryColumn', 'PrimaryGeneratedColumn']);

/** 관계 데코레이터 → 종류다. */
const relationDecorators: ReadonlyMap<string, TypeormRelation['kind']> = new Map([
  ['ManyToOne', 'many-to-one'], ['OneToOne', 'one-to-one'], ['OneToMany', 'one-to-many'], ['ManyToMany', 'many-to-many'],
]);

/** DataSource 수준 이름 옵션이다. */
interface NamingOptions {
  readonly custom: boolean;
  /** 테이블 이름 접두사다. undefined면 비리터럴이라 모든 테이블 이름이 dynamic이다. */
  readonly prefix: string | undefined;
  readonly schema: string | undefined;
}

/** 스키마 이름을 받는 드라이버(`buildTableName`이 스키마를 붙인다)다. */
const schemaDrivers: ReadonlySet<string> = new Set(['postgres', 'cockroachdb', 'mssql', 'sap', 'oracle', 'aurora-postgres']);

/** TypeORM 선언 목록이다. */
export class TypeormCatalog {
  /** 평가기다. */
  private readonly evaluator: OrmEvaluator;
  /** 계수다. */
  private readonly counts: OrmCounts;
  /** 클래스 → 엔터티다. */
  private readonly entities = new Map<ts.ClassLikeDeclaration, TypeormEntity>();
  /** 엔터티 클래스 → 선언 데코레이터 이름이다. */
  private readonly pending = new Map<ts.ClassLikeDeclaration, { readonly kind: string; readonly call: ts.CallExpression }>();
  /** DataSource 이름 옵션이다. */
  private naming: NamingOptions = { custom: false, prefix: '', schema: undefined };
  /**
   * 이름 옵션을 확정했는지 여부다. 수집 중 평가(호출 사슬 등)가 엔터티를 먼저 만들면 접두사가 빠지므로,
   * 확정 전에는 엔터티를 만들지 않는다.
   */
  private ready = false;

  /**
   * @param evaluator 평가기
   * @param counts 계수
   */
  constructor(evaluator: OrmEvaluator, counts: OrmCounts) {
    this.evaluator = evaluator;
    this.counts = counts;
  }

  /** 모든 엔터티다(발견 순). */
  get all(): readonly TypeormEntity[] {
    return [...this.entities.values()];
  }

  /**
   * DataSource 옵션과 엔터티 클래스를 모은다.
   *
   * @param modules 소스 모듈
   */
  discover(modules: readonly SourceModule[]): void {
    const optionObjects: (ts.Expression | undefined)[] = [];
    for (const module of modules) {
      walk(module.sourceFile, (node) => {
        if (ts.isClassLike(node)) this.noteEntityClass(node);
        else if (ts.isCallExpression(node) || ts.isNewExpression(node)) this.noteDataSource(node, optionObjects);
      });
    }
    this.naming = this.namingOptions(optionObjects);
    this.ready = true;
    this.evaluator.resetCache();
    for (const declaration of [...this.pending.keys()]) this.entityOf(declaration);
  }

  /**
   * 클래스의 엔터티다(부모 엔터티를 먼저 만든다).
   *
   * @param declaration 클래스
   * @returns 엔터티 또는 undefined
   */
  entityOf(declaration: ts.ClassLikeDeclaration): TypeormEntity | undefined {
    const built = this.entities.get(declaration);
    if (built !== undefined || !this.ready) return built;
    const marker = this.pending.get(declaration);
    if (marker === undefined) return undefined;
    this.pending.delete(declaration);
    const entity = this.buildEntity(declaration, marker.kind, marker.call);
    this.entities.set(declaration, entity);
    return entity;
  }

  /**
   * 관계의 대상 엔터티다.
   *
   * @param relation 관계
   * @returns 엔터티 또는 undefined
   */
  targetOf(relation: TypeormRelation): TypeormEntity | undefined {
    if (relation.target === undefined) return undefined;
    const value = this.evaluator.valueOf(relation.target);
    return value.kind === 'typeorm-entity' ? value.entity : this.entityByName(relation.target);
  }

  /**
   * 엔터티의 조인 컬럼 이름들이다(`@ManyToOne`, `@JoinColumn`이 붙은 `@OneToOne`).
   *
   * @param entity 소유 엔터티
   * @param property 관계 속성 이름
   * @returns DB 컬럼 이름들(확정하지 못하면 빈 목록)
   */
  joinColumns(entity: TypeormEntity, property: string): string[] {
    const relation = entity.relations.get(property);
    if (relation === undefined || !ownsJoinColumn(relation)) return [];
    const configured = joinColumnOptions(relation.joinColumn);
    if (configured.length === 0) return this.derivedJoinColumns(relation, property, undefined);
    return configured.flatMap((options) => {
      const explicit = this.stringOption(options, 'name');
      return explicit === undefined ? this.derivedJoinColumns(relation, property, this.stringOption(options, 'referencedColumnName')) : [explicit];
    });
  }

  /**
   * 이름을 주지 않은 조인 컬럼 이름이다(`joinColumnName(속성, 참조 속성)`).
   *
   * @param relation 관계
   * @param property 관계 속성 이름
   * @param referenced 참조 속성(없으면 대상 주 키 전부)
   * @returns 컬럼 이름들(확정하지 못하면 빈 목록)
   */
  private derivedJoinColumns(relation: TypeormRelation, property: string, referenced: string | undefined): string[] {
    const target = this.targetOf(relation);
    if (target === undefined || this.naming.custom) return [];
    const keys = referenced === undefined ? target.primaryKeys : [referenced];
    return keys.map((key) => camelCase(`${property}_${key}`));
  }

  /**
   * `@JoinTable` 조인 테이블의 이름과 컬럼이다.
   *
   * @param entity 소유 엔터티
   * @param property 관계 속성 이름
   * @returns 테이블·컬럼 또는 undefined(조인 테이블 없음·확정 불가)
   */
  joinTable(entity: TypeormEntity, property: string): { readonly table: TableName; readonly columns: string[] } | undefined {
    const relation = entity.relations.get(property);
    if (relation?.kind !== 'many-to-many' || relation.joinTable === undefined) return undefined;
    const target = this.targetOf(relation);
    const options = decoratorOptions(relation.joinTable);
    const explicit = options === undefined ? undefined : this.stringOption(options, 'name');
    const schema = (options === undefined ? undefined : this.stringOption(options, 'schema')) ?? entity.schema;
    const derived = target?.baseTable === undefined || entity.baseTable === undefined || this.naming.custom
      ? undefined
      : snakeCase(`${entity.baseTable}_${property}_${target.baseTable}`);
    const name = explicit ?? derived;
    if (name === undefined || this.naming.prefix === undefined) return { table: { channel: dynamicChannel(relation.joinTable.getText()), dynamic: true }, columns: [] };
    return { table: { channel: qualifiedChannel(schema, this.naming.prefix + name), dynamic: false }, columns: this.joinTableColumns(entity, target, options) };
  }

  /**
   * TypeORM 값 판정 규칙이다.
   *
   * @returns 규칙
   */
  rules(): OrmValueRules {
    return {
      classValue: (node) => entityValue(this.entityOf(node)),
      call: (callee, node) => this.callRule(callee, node),
      methodCall: (receiver, method, node) => this.methodRule(receiver, method, node),
      construct: (callee) => (isTypeorm(callee, 'DataSource') || isTypeorm(callee, 'Connection') ? { kind: 'typeorm-manager' } : undefined),
      member: (receiver, name) => (name === 'manager' && (receiver.kind === 'typeorm-manager' || receiver.kind === 'typeorm-repository')
        ? { kind: 'typeorm-manager' } : undefined),
      typeReference: (target, node) => this.typeRule(target, node),
      decorated: (decorators) => this.decoratedRule(decorators),
      callbackParameter: (call, callee, index) => {
        const method = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';
        return callee.kind === 'typeorm-manager' && method === 'transaction' && index === 0 ? { kind: 'typeorm-manager' } : undefined;
      },
    };
  }

  /**
   * 호출 규칙: `getRepository(User)`·`getManager()`.
   *
   * @param callee 호출 대상 값
   * @param node 호출 식
   * @returns 값 또는 undefined
   */
  private callRule(callee: OrmValue, node: ts.CallExpression): OrmValue | undefined {
    if (isTypeorm(callee, 'getRepository') || isTypeorm(callee, 'getTreeRepository')) return this.repositoryOf(node.arguments[0]);
    if (isTypeorm(callee, 'getManager') || isTypeorm(callee, 'getConnection')) return { kind: 'typeorm-manager' };
    return undefined;
  }

  /**
   * 메서드 호출 규칙: `x.getRepository(User)`(엔터티 인자가 증거), 저장소 확장, 쿼리 러너.
   *
   * @param receiver 수신자 값
   * @param method 메서드 이름
   * @param node 호출 식
   * @returns 값 또는 undefined
   */
  private methodRule(receiver: OrmValue, method: string, node: ts.CallExpression): OrmValue | undefined {
    if (method === 'getRepository' || method === 'getTreeRepository') return this.repositoryOf(node.arguments[0]);
    if (receiver.kind === 'typeorm-repository' && method === 'extend') return receiver;
    if (receiver.kind === 'typeorm-manager' && method === 'withRepository') {
      const [argument] = node.arguments;
      return argument === undefined ? undefined : this.evaluator.valueOf(argument);
    }
    if (receiver.kind === 'typeorm-manager' && (method === 'createQueryRunner' || method === 'initialize')) return { kind: 'typeorm-manager' };
    return undefined;
  }

  /**
   * 타입 규칙: `Repository<User>`, `EntityManager`·`DataSource`·`QueryRunner`.
   *
   * @param target 타입 이름의 값
   * @param node 타입 참조
   * @returns 값 또는 undefined
   */
  private typeRule(target: OrmValue | { readonly kind: 'global' }, node: ts.TypeReferenceNode): OrmValue | undefined {
    if (target.kind !== 'external' || target.module !== 'typeorm') return undefined;
    if (target.name === 'Repository' || target.name === 'TreeRepository') {
      const [argument] = node.typeArguments ?? [];
      const entity = argument === undefined ? undefined : this.evaluator.typeValue(argument);
      return entity?.kind === 'typeorm-entity' ? { kind: 'typeorm-repository', entity: entity.entity } : undefined;
    }
    return ['EntityManager', 'DataSource', 'Connection', 'QueryRunner'].includes(target.name) ? { kind: 'typeorm-manager' } : undefined;
  }

  /**
   * 데코레이터 규칙: NestJS `@InjectRepository(User)`·`@InjectDataSource()`·`@InjectEntityManager()`.
   *
   * @param decorators 데코레이터
   * @returns 값 또는 undefined
   */
  private decoratedRule(decorators: readonly ts.Decorator[]): OrmValue | undefined {
    for (const decorator of decorators) {
      const call = decorator.expression;
      if (!ts.isCallExpression(call)) continue;
      const callee = this.evaluator.valueOf(call.expression);
      if (callee.kind !== 'external' || callee.module !== '@nestjs/typeorm') continue;
      if (callee.name === 'InjectRepository') return this.repositoryOf(call.arguments[0]);
      if (callee.name === 'InjectDataSource' || callee.name === 'InjectEntityManager') return { kind: 'typeorm-manager' };
    }
    return undefined;
  }

  /**
   * 엔터티 인자의 저장소 값이다.
   *
   * @param argument 엔터티 식
   * @returns 저장소 값 또는 undefined
   */
  private repositoryOf(argument: ts.Expression | undefined): OrmValue | undefined {
    const value = argument === undefined ? undefined : this.evaluator.valueOf(argument);
    return value?.kind === 'typeorm-entity' ? { kind: 'typeorm-repository', entity: value.entity } : undefined;
  }

  /**
   * 클래스에 엔터티 데코레이터가 있으면 기록한다.
   *
   * @param node 클래스
   */
  private noteEntityClass(node: ts.ClassLikeDeclaration): void {
    for (const decorator of ts.getDecorators(node) ?? []) {
      const name = this.typeormDecorator(decorator);
      if (name !== undefined && entityDecorators.has(name) && ts.isCallExpression(decorator.expression)) {
        this.pending.set(node, { kind: name, call: decorator.expression });
        return;
      }
    }
  }

  /**
   * `new DataSource({…})`·`createConnection({…})`·`TypeOrmModule.forRoot({…})`의 옵션 식을 기록한다.
   *
   * @param node 호출·new 식
   * @param options 옵션 식 목록(추가된다)
   */
  private noteDataSource(node: ts.CallExpression | ts.NewExpression, options: (ts.Expression | undefined)[]): void {
    const callee = this.evaluator.valueOf(node.expression);
    if (callee.kind !== 'external') return;
    const [first] = node.arguments ?? [];
    if (callee.module === 'typeorm' && ['DataSource', 'Connection', 'createConnection'].includes(callee.name)) options.push(first);
    if (callee.module === '@nestjs/typeorm' && callee.name === 'TypeOrmModule.forRoot') options.push(first);
    if (callee.module === '@nestjs/typeorm' && callee.name === 'TypeOrmModule.forRootAsync') options.push(this.factoryOptions(first));
  }

  /**
   * `forRootAsync({ useFactory })`의 팩토리가 돌려주는 옵션 식이다.
   *
   * @param argument forRootAsync 인자
   * @returns 옵션 식 또는 undefined
   */
  private factoryOptions(argument: ts.Expression | undefined): ts.Expression | undefined {
    const object = argument === undefined ? undefined : unwrap(argument);
    const fn = object !== undefined && ts.isObjectLiteralExpression(object) ? factoryFunction(object) : undefined;
    const value = fn === undefined ? undefined : this.evaluator.returnValue(fn);
    if (value?.kind === 'object') return value.node;
    this.counts.namingUnverified.add(`${TYPEORM}: TypeOrmModule.forRootAsync options could not be read; the default naming strategy without entityPrefix is assumed`);
    return undefined;
  }

  /**
   * DataSource 옵션들에서 이름 옵션을 정한다. 여러 DataSource가 있으면 모두 같은 값만 쓴다: 접두사가 다르면
   * 테이블 이름을 확정하지 못하고(dynamic), 스키마가 다르면 한정하지 않는다(비한정 이름은 조인에서 그대로 맞는다).
   *
   * @param optionObjects 옵션 식들
   * @returns 이름 옵션
   */
  private namingOptions(optionObjects: readonly (ts.Expression | undefined)[]): NamingOptions {
    const all: NamingOptions[] = [];
    for (const expression of optionObjects) {
      const value = expression === undefined ? undefined : this.evaluator.valueOf(expression);
      if (value?.kind === 'object') all.push(this.readNaming(value.node));
    }
    const custom = all.some((options) => options.custom);
    if (custom) {
      this.counts.namingUnverified.add(`${TYPEORM}: a custom namingStrategy is configured; only explicitly named tables and columns are emitted, other table names are dynamic`);
    }
    const prefixes = new Set(all.map((options) => options.prefix));
    if (prefixes.size > 1) this.counts.namingUnverified.add(`${TYPEORM}: DataSource options disagree on entityPrefix; table names are dynamic`);
    const schemas = new Set(all.map((options) => options.schema));
    return {
      custom,
      prefix: prefixes.size === 0 ? '' : prefixes.size === 1 ? [...prefixes][0] : undefined,
      schema: schemas.size === 1 ? [...schemas][0] : undefined,
    };
  }

  /**
   * 옵션 객체 하나의 이름 옵션을 읽는다.
   *
   * @param object 옵션 객체
   * @returns 이름 옵션
   */
  private readNaming(object: ts.ObjectLiteralExpression): NamingOptions {
    const strategy = this.evaluator.propertyOf(object, 'namingStrategy');
    const prefixExpression = this.evaluator.propertyOf(object, 'entityPrefix');
    if (strategy === null || prefixExpression === null) {
      this.counts.namingUnverified.add(`${TYPEORM}: DataSource options spread a value that could not be read; the default naming strategy without entityPrefix is assumed`);
    }
    const prefixValue = prefixExpression === undefined || prefixExpression === null ? undefined : this.evaluator.valueOf(prefixExpression);
    if (prefixValue !== undefined && prefixValue.kind !== 'string') {
      this.counts.namingUnverified.add(`${TYPEORM}: entityPrefix is not a string literal; table names are dynamic`);
    }
    const prefix = prefixValue === undefined ? '' : prefixValue.kind === 'string' ? prefixValue.value : undefined;
    const driver = this.stringOption(object, 'type', true);
    const schema = driver !== undefined && schemaDrivers.has(driver) ? this.stringOption(object, 'schema') : undefined;
    return { custom: strategy !== undefined && strategy !== null, prefix, schema };
  }

  /**
   * 엔터티를 만든다.
   *
   * @param declaration 클래스
   * @param kind 엔터티 데코레이터 이름
   * @param call 데코레이터 호출
   * @returns 엔터티
   */
  private buildEntity(declaration: ts.ClassLikeDeclaration, kind: string, call: ts.CallExpression): TypeormEntity {
    const className = declaration.name?.text ?? 'default';
    const parent = kind === 'ChildEntity' ? this.parentEntity(declaration) : undefined;
    const options = kind === 'ChildEntity' ? undefined : entityOptions(call);
    const given = parent !== undefined ? undefined : this.givenName(call);
    const schema = parent?.schema ?? (options === undefined ? undefined : this.stringOption(options, 'schema')) ?? this.naming.schema;
    const baseTable = parent?.baseTable ?? (given === null ? undefined : given ?? (this.naming.custom ? undefined : snakeCase(className)));
    const table: TableName = parent?.table ?? (baseTable === undefined || this.naming.prefix === undefined
      ? { channel: dynamicChannel(`${call.getText()} class ${className}`), dynamic: true }
      : { channel: qualifiedChannel(schema, this.naming.prefix + baseTable), dynamic: false });
    const columns = new Map<string, OrmColumn>();
    const primaryKeys: string[] = [];
    const relations = new Map<string, TypeormRelation>();
    for (const owner of this.classChain(declaration)) this.readMembers(owner, columns, primaryKeys, relations);
    this.addDiscriminator(declaration, columns);
    return { declaration, symbol: className, node: declaration.name ?? call, baseTable, schema, table, columns, primaryKeys, relations };
  }

  /**
   * `@Entity`의 명시 테이블 이름이다(문자열 첫 인자 또는 옵션 `name`).
   *
   * @param call 데코레이터 호출
   * @returns 이름, 없으면 undefined, 읽지 못하면 null(클래스 이름으로 추측하지 않고 dynamic으로 낸다)
   */
  private givenName(call: ts.CallExpression): string | undefined | null {
    const [first] = call.arguments;
    if (first === undefined) return undefined;
    const value = this.evaluator.valueOf(first);
    if (value.kind === 'string') return value.value.length > 0 ? value.value : undefined;
    const options = entityOptions(call);
    const name = options === undefined ? null : this.evaluator.propertyOf(options, 'name');
    const named = name === undefined || name === null ? undefined : this.evaluator.valueOf(name);
    if (name === undefined) return undefined;
    if (named?.kind === 'string') return named.value.length > 0 ? named.value : undefined;
    bump(this.counts.unreadableDeclarations, TYPEORM);
    return null;
  }

  /**
   * `@ChildEntity` 클래스가 상속한 엔터티다.
   *
   * @param declaration 클래스
   * @returns 부모 엔터티 또는 undefined
   */
  private parentEntity(declaration: ts.ClassLikeDeclaration): TypeormEntity | undefined {
    const base = this.baseClass(declaration);
    return base === undefined ? undefined : this.entityOf(base);
  }

  /**
   * 클래스와 상속한 프로젝트 클래스들이다(조상 먼저). TypeORM은 상속한 컬럼을 물려준다.
   *
   * @param declaration 클래스
   * @returns 조상부터의 클래스 목록
   */
  private classChain(declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration[] {
    const chain: ts.ClassLikeDeclaration[] = [];
    for (let current: ts.ClassLikeDeclaration | undefined = declaration; current !== undefined && chain.length < 16; current = this.baseClass(current)) {
      if (chain.includes(current)) break;
      chain.unshift(current);
    }
    return chain;
  }

  /**
   * 클래스의 프로젝트 부모 클래스다.
   *
   * @param declaration 클래스
   * @returns 부모 클래스 또는 undefined
   */
  private baseClass(declaration: ts.ClassLikeDeclaration): ts.ClassLikeDeclaration | undefined {
    const clause = declaration.heritageClauses?.find((candidate) => candidate.token === ts.SyntaxKind.ExtendsKeyword);
    const expression = clause?.types[0]?.expression;
    if (expression === undefined) return undefined;
    const origin = this.evaluator.binder.originOf(ts.isPropertyAccessExpression(expression) ? expression.name : expression);
    return origin.kind === 'declaration' && ts.isClassLike(origin.declaration) ? origin.declaration : undefined;
  }

  /**
   * 클래스 멤버의 컬럼·관계를 읽는다.
   *
   * @param owner 클래스
   * @param columns 속성 → 컬럼(추가된다)
   * @param primaryKeys 주 키 속성(추가된다)
   * @param relations 속성 → 관계(추가된다)
   */
  private readMembers(owner: ts.ClassLikeDeclaration, columns: Map<string, OrmColumn>, primaryKeys: string[], relations: Map<string, TypeormRelation>): void {
    for (const member of owner.members) {
      if (!ts.isPropertyDeclaration(member)) continue;
      const property = propertyNameText(member.name);
      if (property === undefined) continue;
      const decorators = this.memberDecorators(member);
      const column = decorators.find((entry) => columnDecorators.has(entry.name));
      if (column !== undefined) this.readColumn(property, member, column, columns, primaryKeys);
      const relation = decorators.find((entry) => relationDecorators.has(entry.name));
      if (relation !== undefined) relations.set(property, this.readRelation(member, relation, decorators));
    }
  }

  /**
   * 컬럼 데코레이터 하나를 읽는다. 임베디드(`@Column(() => Name)`)는 대상 클래스 컬럼을 접두사와 함께 펼친다.
   *
   * @param property 속성 이름
   * @param member 필드 선언
   * @param decorator 컬럼 데코레이터
   * @param columns 속성 → 컬럼(추가된다)
   * @param primaryKeys 주 키 속성(추가된다)
   */
  private readColumn(property: string, member: ts.PropertyDeclaration, decorator: NamedDecorator, columns: Map<string, OrmColumn>, primaryKeys: string[]): void {
    const [first] = decorator.call.arguments;
    const options = decoratorOptions(decorator.call);
    if (first !== undefined && isFunctionExpression(first)) {
      this.readEmbedded(property, member, first, options, columns, []);
      return;
    }
    const explicit = options === undefined ? undefined : this.stringOption(options, 'name');
    columns.set(property, { key: property, column: explicit ?? (this.naming.custom ? undefined : property), node: member.name });
    const primary = primaryDecorators.has(decorator.name) || (options !== undefined && isTrue(objectMember(options, 'primary')));
    if (primary && !primaryKeys.includes(property)) primaryKeys.push(property);
  }

  /**
   * 임베디드 컬럼을 펼친다(중첩 임베디드 포함).
   *
   * @param property 임베디드 속성 이름
   * @param member 필드 선언(위치)
   * @param factory `() => Name`
   * @param options 임베디드 옵션
   * @param columns 속성 경로 → 컬럼(추가된다)
   * @param outerPrefixes 바깥 임베디드 접두사
   */
  private readEmbedded(
    property: string, member: ts.PropertyDeclaration, factory: ts.Expression, options: ts.ObjectLiteralExpression | undefined,
    columns: Map<string, OrmColumn>, outerPrefixes: readonly string[],
  ): void {
    const target = embeddedClass(factory, this.evaluator);
    const prefixes = [...outerPrefixes, ...this.embeddedPrefix(property, options)];
    if (target === undefined || outerPrefixes.length > 4) {
      bump(this.counts.unreadableDeclarations, TYPEORM);
      return;
    }
    for (const inner of target.members) {
      if (!ts.isPropertyDeclaration(inner)) continue;
      const name = propertyNameText(inner.name);
      const decorator = name === undefined ? undefined : this.memberDecorators(inner).find((entry) => columnDecorators.has(entry.name));
      if (name === undefined || decorator === undefined) continue;
      const [first] = decorator.call.arguments;
      const innerOptions = decoratorOptions(decorator.call);
      if (first !== undefined && isFunctionExpression(first)) {
        this.readEmbedded(`${property}.${name}`, member, first, innerOptions, columns, prefixes);
        continue;
      }
      const explicit = innerOptions === undefined ? undefined : this.stringOption(innerOptions, 'name');
      const column = this.naming.custom ? undefined : embeddedColumnName(explicit ?? name, prefixes);
      columns.set(`${property}.${name}`, { key: `${property}.${name}`, column, node: member.name });
    }
  }

  /**
   * 임베디드 한 단계의 접두사(`buildPartialPrefix`)다.
   *
   * @param property 속성 이름
   * @param options 임베디드 옵션
   * @returns 접두사 목록(비었으면 접두사 없음)
   */
  private embeddedPrefix(property: string, options: ts.ObjectLiteralExpression | undefined): string[] {
    const expression = options === undefined ? undefined : objectMember(options, 'prefix');
    if (expression === undefined || expression.kind === ts.SyntaxKind.TrueKeyword) return [property];
    if (expression.kind === ts.SyntaxKind.FalseKeyword) return [];
    const value = this.evaluator.valueOf(expression);
    if (value.kind === 'string') return value.value.length === 0 ? [] : [value.value];
    bump(this.counts.unreadableDeclarations, TYPEORM);
    return [property];
  }

  /**
   * 관계 데코레이터 하나를 읽는다.
   *
   * @param member 필드 선언
   * @param decorator 관계 데코레이터
   * @param decorators 같은 필드의 데코레이터
   * @returns 관계
   */
  private readRelation(member: ts.PropertyDeclaration, decorator: NamedDecorator, decorators: readonly NamedDecorator[]): TypeormRelation {
    const [first] = decorator.call.arguments;
    const target = first === undefined ? undefined : relationTargetExpression(first);
    return {
      kind: relationDecorators.get(decorator.name)!,
      target,
      joinColumn: decorators.find((entry) => entry.name === 'JoinColumn')?.call,
      joinTable: decorators.find((entry) => entry.name === 'JoinTable')?.call,
      node: member.name,
    };
  }

  /**
   * `@TableInheritance` 판별 컬럼(`column.name`, 기본 `type`)을 더한다.
   *
   * @param declaration 클래스
   * @param columns 속성 → 컬럼(추가된다)
   */
  private addDiscriminator(declaration: ts.ClassLikeDeclaration, columns: Map<string, OrmColumn>): void {
    const decorator = (ts.getDecorators(declaration) ?? []).find((entry) => this.typeormDecorator(entry) === 'TableInheritance');
    if (decorator === undefined || !ts.isCallExpression(decorator.expression)) return;
    const options = decoratorOptions(decorator.expression);
    const column = options === undefined ? undefined : objectMember(options, 'column');
    const value = column === undefined ? undefined : this.evaluator.valueOf(column);
    const name = value?.kind === 'string' ? value.value : value?.kind === 'object' ? this.stringOption(value.node, 'name') ?? 'type' : 'type';
    if (!columns.has(name)) columns.set(name, { key: name, column: name, node: decorator.expression });
  }

  /**
   * 조인 테이블 컬럼 이름이다(`joinColumn`·`inverseJoinColumn` 옵션 우선).
   *
   * @param entity 소유 엔터티
   * @param target 대상 엔터티
   * @param options `@JoinTable` 옵션
   * @returns 컬럼 이름 목록
   */
  private joinTableColumns(entity: TypeormEntity, target: TypeormEntity | undefined, options: ts.ObjectLiteralExpression | undefined): string[] {
    const own = this.junctionSide(entity, options, 'joinColumn');
    const inverse = target === undefined ? [] : this.junctionSide(target, options, 'inverseJoinColumn');
    if (own.length === 1 && inverse.length === 1 && own[0] === inverse[0]) return [`${own[0]}_1`, `${inverse[0]}_2`];
    return [...own, ...inverse];
  }

  /**
   * 조인 테이블 한쪽의 컬럼 이름들이다.
   *
   * @param side 그쪽 엔터티
   * @param options `@JoinTable` 옵션
   * @param key `joinColumn`·`inverseJoinColumn`
   * @returns 컬럼 이름 목록
   */
  private junctionSide(side: TypeormEntity, options: ts.ObjectLiteralExpression | undefined, key: string): string[] {
    const configured = options === undefined ? undefined : objectMember(options, key);
    const value = configured === undefined ? undefined : this.evaluator.valueOf(configured);
    const explicit = value?.kind === 'object' ? this.stringOption(value.node, 'name') : undefined;
    if (explicit !== undefined) return [explicit];
    if (side.baseTable === undefined || this.naming.custom) return [];
    return side.primaryKeys.map((property) => camelCase(`${side.baseTable}_${side.columns.get(property)?.column ?? property}`));
  }

  /**
   * 관계 대상이 문자열 엔터티 이름(`@ManyToOne('User')`)이면 클래스 이름으로 찾는다.
   *
   * @param target 대상 식
   * @returns 엔터티 또는 undefined
   */
  private entityByName(target: ts.Expression): TypeormEntity | undefined {
    if (!ts.isStringLiteralLike(target)) return undefined;
    const matches = [...this.entities.values()].filter((entity) => entity.symbol === target.text);
    return matches.length === 1 ? matches[0] : undefined;
  }

  /**
   * 필드의 TypeORM 데코레이터들이다.
   *
   * @param member 필드 선언
   * @returns 이름·호출 목록
   */
  private memberDecorators(member: ts.PropertyDeclaration): NamedDecorator[] {
    const result: NamedDecorator[] = [];
    for (const decorator of ts.getDecorators(member) ?? []) {
      const name = this.typeormDecorator(decorator);
      if (name !== undefined && ts.isCallExpression(decorator.expression)) result.push({ name, call: decorator.expression });
    }
    return result;
  }

  /**
   * 데코레이터가 `typeorm`에서 가져온 것이면 export 이름을 돌려준다.
   *
   * @param decorator 데코레이터
   * @returns 이름 또는 undefined
   */
  private typeormDecorator(decorator: ts.Decorator): string | undefined {
    const expression = ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression;
    const value = this.evaluator.valueOf(expression);
    return value.kind === 'external' && value.module === TYPEORM ? value.name : undefined;
  }

  /**
   * 옵션 객체의 문자열 속성이다.
   *
   * @param object 옵션 객체
   * @param key 속성 이름
   * @param quiet 비리터럴이어도 계수하지 않을지 여부(드라이버 종류처럼 이름과 무관한 옵션)
   * @returns 문자열 또는 undefined(없거나 비리터럴)
   */
  private stringOption(object: ts.ObjectLiteralExpression, key: string, quiet = false): string | undefined {
    const member = this.evaluator.propertyOf(object, key);
    if (member === undefined) return undefined;
    if (member === null) {
      if (!quiet) bump(this.counts.unreadableDeclarations, TYPEORM);
      return undefined;
    }
    const value = this.evaluator.valueOf(member);
    if (value.kind === 'string') return value.value;
    if (!quiet) bump(this.counts.unreadableDeclarations, TYPEORM);
    return undefined;
  }
}

/** 이름을 확인한 데코레이터 호출이다. */
interface NamedDecorator {
  readonly name: string;
  readonly call: ts.CallExpression;
}

/**
 * 엔터티를 값으로 감싼다.
 *
 * @param entity 엔터티 또는 undefined
 * @returns 값 또는 undefined
 */
function entityValue(entity: TypeormEntity | undefined): OrmValue | undefined {
  return entity === undefined ? undefined : { kind: 'typeorm-entity', entity };
}

/**
 * 값이 `typeorm`의 이름 있는 export인지 본다.
 *
 * @param value 값
 * @param name export 이름
 * @returns 맞으면 true
 */
function isTypeorm(value: OrmValue, name: string): boolean {
  return value.kind === 'external' && value.module === TYPEORM && value.name === name;
}

/**
 * 관계가 조인 컬럼을 소유하는지 본다(`@ManyToOne` 항상, `@OneToOne`은 `@JoinColumn`이 있을 때).
 *
 * @param relation 관계
 * @returns 소유하면 true
 */
function ownsJoinColumn(relation: TypeormRelation): boolean {
  return relation.kind === 'many-to-one' || (relation.kind === 'one-to-one' && relation.joinColumn !== undefined);
}

/**
 * `forRootAsync` 옵션의 `useFactory` 함수다(화살표·함수 식 값 또는 메서드 축약형).
 *
 * @param object forRootAsync 옵션 객체
 * @returns 함수 노드 또는 undefined
 */
function factoryFunction(object: ts.ObjectLiteralExpression): ts.SignatureDeclaration | undefined {
  for (const property of object.properties) {
    if (property.name === undefined || propertyNameText(property.name) !== 'useFactory') continue;
    if (ts.isMethodDeclaration(property)) return property;
    const value = ts.isPropertyAssignment(property) ? unwrap(property.initializer) : undefined;
    if (value !== undefined && (ts.isArrowFunction(value) || ts.isFunctionExpression(value))) return value;
  }
  return undefined;
}

/**
 * `@JoinColumn` 옵션 객체들이다(객체 하나 또는 객체 배열).
 *
 * @param call 데코레이터 호출 또는 undefined
 * @returns 옵션 객체 목록
 */
function joinColumnOptions(call: ts.CallExpression | undefined): ts.ObjectLiteralExpression[] {
  const [first] = call?.arguments ?? [];
  const inner = first === undefined ? undefined : unwrap(first);
  if (inner === undefined) return [];
  const items = ts.isArrayLiteralExpression(inner) ? inner.elements.map(unwrap) : [inner];
  return items.filter((item): item is ts.ObjectLiteralExpression => ts.isObjectLiteralExpression(item));
}

/**
 * `@Entity` 옵션 객체다(첫 인자 객체 또는 둘째 인자).
 *
 * @param call 데코레이터 호출
 * @returns 옵션 객체 또는 undefined
 */
function entityOptions(call: ts.CallExpression): ts.ObjectLiteralExpression | undefined {
  return decoratorOptions(call);
}

/**
 * 데코레이터 인자 중 첫 객체 리터럴이다.
 *
 * @param call 데코레이터 호출 또는 undefined
 * @returns 객체 리터럴 또는 undefined
 */
function decoratorOptions(call: ts.CallExpression | undefined): ts.ObjectLiteralExpression | undefined {
  for (const argument of call?.arguments ?? []) {
    const inner = unwrap(argument);
    if (ts.isObjectLiteralExpression(inner)) return inner;
  }
  return undefined;
}

/**
 * 식이 화살표·함수 식인지 본다.
 *
 * @param expression 식
 * @returns 함수 식이면 true
 */
function isFunctionExpression(expression: ts.Expression): boolean {
  const inner = unwrap(expression);
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
}

/**
 * 관계 대상 식이다: `() => User`·`type => User`의 본문, 또는 문자열 엔터티 이름.
 *
 * @param first 관계 데코레이터 첫 인자
 * @returns 대상 식 또는 undefined
 */
function relationTargetExpression(first: ts.Expression): ts.Expression | undefined {
  const inner = unwrap(first);
  if (ts.isStringLiteralLike(inner)) return inner;
  if ((ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) && !ts.isBlock(inner.body)) return unwrap(inner.body);
  return undefined;
}

/**
 * 임베디드 팩토리(`() => Name`)가 가리키는 클래스다.
 *
 * @param factory 팩토리 식
 * @param evaluator 평가기
 * @returns 클래스 또는 undefined
 */
function embeddedClass(factory: ts.Expression, evaluator: OrmEvaluator): ts.ClassLikeDeclaration | undefined {
  const target = relationTargetExpression(factory);
  if (target === undefined || !ts.isIdentifier(target)) return undefined;
  const origin = evaluator.binder.originOf(target);
  return origin.kind === 'declaration' && ts.isClassLike(origin.declaration) ? origin.declaration : undefined;
}

/**
 * 식이 `true` 리터럴인지 본다.
 *
 * @param expression 식 또는 undefined
 * @returns true면 true
 */
function isTrue(expression: ts.Expression | undefined): boolean {
  return expression?.kind === ts.SyntaxKind.TrueKeyword;
}

/**
 * 임베디드 컬럼 이름이다(`columnName` with prefixes).
 *
 * @param name 명시 이름 또는 속성 이름
 * @param prefixes 접두사 목록
 * @returns 컬럼 이름
 */
function embeddedColumnName(name: string, prefixes: readonly string[]): string {
  return prefixes.length === 0 ? name : camelCase(prefixes.join('_')) + titleCase(name);
}

/**
 * TypeORM `camelCase`의 포트다(`util/StringUtils.js`).
 *
 * @param text 입력
 * @returns camelCase 문자열
 */
export function camelCase(text: string): string {
  return text.replace(/^([A-Z])|[\s\-_](\w)/g, (_match, first: string | undefined, next: string | undefined) => (next !== undefined ? next.toUpperCase() : first!.toLowerCase()));
}

/**
 * TypeORM `snakeCase`의 포트다(`util/StringUtils.js`).
 *
 * @param text 입력
 * @returns snake_case 문자열
 */
export function snakeCase(text: string): string {
  return text.replace(/([A-Z])([A-Z])([a-z])/g, '$1_$2$3').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/**
 * TypeORM `titleCase`의 포트다(`util/StringUtils.js`).
 *
 * @param text 입력
 * @returns 단어 첫 글자만 대문자인 문자열
 */
export function titleCase(text: string): string {
  return text.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}
