/**
 * Drizzle ORM 테이블 선언·관계 설정·casing 옵션을 모으고, Drizzle 값 판정 규칙을 제공한다.
 *
 * 이름 규칙(drizzle-orm 0.45.3 소스로 확인, docs/PERSISTENCE.md):
 *
 * - 테이블: `pgTable(name, …)`·`sqliteTable`·`mysqlTable`·`singlestoreTable`·`gelTable`의 첫 인자 그대로
 *   (`pg-core/table.js` `pgTableWithSchema(name, …)` — 변환 없음). `pgSchema('s').table(name)`은 `s.name`,
 *   `pgTableCreator(fn)`은 `fn(name)`이다(정적으로 계산되는 템플릿·연결만 풀고 나머지는 dynamic).
 * - 컬럼: 빌더 첫 인자가 비지 않은 문자열이면 그 이름(`utils.js` `getColumnNameAndConfig`), 아니면 객체 키
 *   (`column-builder.js` `setName`, `keyAsName: true`). 키 이름 컬럼만 `drizzle(…, { casing })`의
 *   `snake_case`·`camelCase` 변환을 받는다(`casing.js` `CasingCache.getColumnCasing`). 명시 이름과 테이블
 *   이름은 casing을 받지 않는다.
 */

import { basename } from 'node:path';

import ts from 'typescript';

import type { SourceModule } from '../source-module.ts';
import { bump, type OrmCounts, unwrap, walk } from './orm-facts.ts';
import { type DrizzleTable, type OrmColumn, qualifiedChannel, type TableName } from './orm-model.ts';
import { objectMember, type OrmEvaluator, type OrmValue, type OrmValueRules, propertyNameText, UNKNOWN } from './orm-values.ts';
import { dynamicChannel } from '../relation-facts.ts';

/** 표면 이름(계수·limitation용)이다. */
export const DRIZZLE = 'drizzle';

/** 테이블·뷰를 만드는 함수가 있는 모듈 → 함수 이름이다. */
const tableFactories: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['drizzle-orm/pg-core', new Set(['pgTable', 'pgView', 'pgMaterializedView'])],
  ['drizzle-orm/mysql-core', new Set(['mysqlTable', 'mysqlView'])],
  ['drizzle-orm/sqlite-core', new Set(['sqliteTable', 'sqliteView'])],
  ['drizzle-orm/singlestore-core', new Set(['singlestoreTable'])],
  ['drizzle-orm/gel-core', new Set(['gelTable'])],
]);

/** 스키마 객체를 만드는 함수 이름이다(`pgSchema('auth').table(…)`). */
const schemaFactories: ReadonlySet<string> = new Set(['pgSchema', 'mysqlSchema', 'mysqlDatabase', 'singlestoreSchema', 'gelSchema']);

/** 테이블 이름 변환 함수를 받는 생성기 이름이다. */
const creatorFactories: ReadonlySet<string> = new Set(['pgTableCreator', 'mysqlTableCreator', 'sqliteTableCreator', 'singlestoreTableCreator']);

/** 스키마 객체에서 테이블·뷰를 만드는 메서드다. */
const schemaTableMethods: ReadonlySet<string> = new Set(['table', 'view', 'materializedView']);

/** casing 옵션 값(없음은 `none`)이다. */
type Casing = 'none' | 'snake_case' | 'camelCase';

/**
 * 모듈 지정자가 drizzle-orm 패키지(또는 하위 경로)인지 본다.
 *
 * @param module 지정자
 * @returns drizzle-orm이면 true
 */
export function isDrizzleModule(module: string): boolean {
  return module === 'drizzle-orm' || module.startsWith('drizzle-orm/');
}

/** Drizzle 선언 목록이다. */
export class DrizzleCatalog {
  /** 평가기다. */
  private readonly evaluator: OrmEvaluator;
  /** 계수다. */
  private readonly counts: OrmCounts;
  /** 선언 호출 → 테이블이다. */
  private readonly tablesByCall = new Map<ts.CallExpression, DrizzleTable>();
  /** `relations(table, …)` 호출이다. */
  private readonly relationCalls: ts.CallExpression[] = [];
  /** 테이블 → 관계 키 → 대상 테이블 메모다. */
  private readonly relationMemo = new Map<DrizzleTable, ReadonlyMap<string, DrizzleTable>>();
  /** 프로젝트 casing(여럿이거나 비리터럴이면 undefined)이다. */
  private casing: Casing | undefined = 'none';

  /**
   * @param evaluator 평가기
   * @param counts 계수
   */
  constructor(evaluator: OrmEvaluator, counts: OrmCounts) {
    this.evaluator = evaluator;
    this.counts = counts;
  }

  /** 모든 테이블 선언이다(발견 순). */
  get tables(): readonly DrizzleTable[] {
    return [...this.tablesByCall.values()];
  }

  /**
   * 모듈에서 casing·테이블·관계 선언을 모은다. casing을 먼저 모아야 키 이름 컬럼을 풀 수 있다.
   *
   * @param modules 소스 모듈
   */
  discover(modules: readonly SourceModule[]): void {
    const calls: ts.CallExpression[] = [];
    for (const module of modules) walk(module.sourceFile, (node) => { if (ts.isCallExpression(node)) calls.push(node); });
    this.casing = this.projectCasing(calls, modules);
    for (const call of calls) this.discoverCall(call);
  }

  /**
   * 관계형 쿼리 스키마(`drizzle(c, { schema })`의 값 또는 `typeof schema` 타입)의 키 → 테이블 표다.
   * 스키마를 풀지 못하면 프로젝트의 export 이름이 유일한 테이블로 대신한다(스키마 키는 export 이름이다).
   *
   * @param schema 스키마 식·타입 또는 undefined
   * @returns 키 → 테이블
   */
  relationalTables(schema: ts.Expression | ts.TypeNode | undefined): ReadonlyMap<string, DrizzleTable> {
    const value = schema === undefined ? UNKNOWN : ts.isTypeNode(schema) ? this.evaluator.typeValue(schema) : this.evaluator.valueOf(schema);
    const tables = new Map<string, DrizzleTable>();
    if (this.collectSchemaTables(value, tables, 0)) return tables;
    return this.exportNameIndex();
  }

  /**
   * 테이블의 관계 설정(`relations(table, ({ one, many }) => ({ key: one(target) }))`) 키 → 대상 테이블이다.
   *
   * @param table 원본 테이블
   * @returns 키 → 대상 테이블
   */
  relationsOf(table: DrizzleTable): ReadonlyMap<string, DrizzleTable> {
    const cached = this.relationMemo.get(table);
    if (cached !== undefined) return cached;
    const result = new Map<string, DrizzleTable>();
    for (const call of this.relationCalls) {
      const [source, config] = call.arguments;
      if (source === undefined || config === undefined) continue;
      const value = this.evaluator.valueOf(source);
      if (value.kind === 'drizzle-table' && value.table === table) this.readRelationConfig(config, result);
    }
    this.relationMemo.set(table, result);
    return result;
  }

  /**
   * Drizzle 값 판정 규칙이다.
   *
   * @returns 규칙
   */
  rules(): OrmValueRules {
    return {
      call: (callee, node) => this.callRule(callee, node),
      methodCall: (receiver, method, node) => {
        if (receiver.kind === 'drizzle-schema' && schemaTableMethods.has(method)) return tableValue(this.tablesByCall.get(node));
        if (receiver.kind === 'drizzle-db' && (method === '$withAuth' || method === '$withCache')) return receiver;
        return undefined;
      },
      member: (receiver, name) => (receiver.kind === 'drizzle-db' && name === 'query' ? { kind: 'drizzle-query', schema: receiver.schema } : undefined),
      typeReference: (target, node) => drizzleDatabaseType(target, node),
      callbackParameter: (call, callee, index) => {
        const method = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';
        return callee.kind === 'drizzle-db' && method === 'transaction' && index === 0 ? callee : undefined;
      },
    };
  }

  /**
   * 호출 규칙: 테이블 선언 호출, `pgSchema`·`pgTableCreator`·`drizzle()` 호출.
   *
   * @param callee 호출 대상 값
   * @param node 호출 식
   * @returns 값 또는 undefined
   */
  private callRule(callee: OrmValue, node: ts.CallExpression): OrmValue | undefined {
    const table = this.tablesByCall.get(node);
    if (table !== undefined) return tableValue(table);
    if (callee.kind !== 'external' || !isDrizzleModule(callee.module)) return undefined;
    if (schemaFactories.has(callee.name)) return { kind: 'drizzle-schema', schema: literalArgument(node.arguments[0], this.evaluator) };
    if (creatorFactories.has(callee.name)) return { kind: 'drizzle-creator', rename: renameFunction(node.arguments[0]) };
    if (callee.name === 'drizzle') return { kind: 'drizzle-db', schema: drizzleSchemaOption(node, this.evaluator) };
    return undefined;
  }

  /**
   * 호출 하나가 테이블 선언·관계 설정이면 기록한다.
   *
   * @param call 호출 식
   */
  private discoverCall(call: ts.CallExpression): void {
    const callee = this.evaluator.valueOf(call.expression);
    if (callee.kind === 'external' && isDrizzleModule(callee.module) && callee.name === 'relations') {
      this.relationCalls.push(call);
      return;
    }
    const target = this.tableTarget(call, callee);
    if (target !== undefined) this.tablesByCall.set(call, this.buildTable(call, target));
  }

  /**
   * 호출이 테이블 선언이면 스키마와 이름 변환을 돌려준다.
   *
   * @param call 호출 식
   * @param callee 호출 대상 값
   * @returns 선언 대상 또는 undefined
   */
  private tableTarget(call: ts.CallExpression, callee: OrmValue): TableTarget | undefined {
    if (callee.kind === 'external' && tableFactories.get(callee.module)?.has(callee.name) === true) {
      return { schema: undefined, rename: (name) => name, dynamicSchema: false };
    }
    if (callee.kind === 'drizzle-creator') return { schema: undefined, rename: callee.rename, dynamicSchema: false };
    const expression = call.expression;
    if (!ts.isPropertyAccessExpression(expression) || !schemaTableMethods.has(expression.name.text)) return undefined;
    const owner = this.evaluator.valueOf(expression.expression);
    if (owner.kind !== 'drizzle-schema') return undefined;
    return { schema: owner.schema, rename: (name) => name, dynamicSchema: owner.schema === undefined };
  }

  /**
   * 테이블 선언을 만든다.
   *
   * @param call 선언 호출
   * @param target 스키마·이름 변환
   * @returns 테이블
   */
  private buildTable(call: ts.CallExpression, target: TableTarget): DrizzleTable {
    const [nameArgument, columnsArgument] = call.arguments;
    const written = literalArgument(nameArgument, this.evaluator);
    const renamed = written === undefined || target.rename === undefined ? undefined : target.rename(written);
    const table: TableName = renamed === undefined || target.dynamicSchema
      ? { channel: dynamicChannel(call.getText()), dynamic: true }
      : { channel: qualifiedChannel(target.schema, renamed), dynamic: false };
    const columns = new Map<string, OrmColumn>();
    if (columnsArgument !== undefined) this.readColumns(columnsArgument, columns, 0);
    return {
      table, columns, call,
      symbol: declarationName(call) ?? written ?? '<table>', node: nameArgument ?? call,
    };
  }

  /**
   * 컬럼 정의 인자(객체 리터럴, `(t) => ({…})`, 스프레드)를 읽는다.
   *
   * @param argument 컬럼 인자
   * @param columns 키 → 컬럼(추가된다)
   * @param depth 스프레드를 따라간 깊이
   */
  private readColumns(argument: ts.Expression, columns: Map<string, OrmColumn>, depth: number): void {
    const object = this.columnObject(argument);
    if (object === undefined || depth > 4) {
      bump(this.counts.unreadableDeclarations, DRIZZLE);
      return;
    }
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        this.readColumns(property.expression, columns, depth + 1);
        continue;
      }
      const key = property.name === undefined ? undefined : propertyNameText(property.name);
      const builder = columnBuilder(property);
      if (key === undefined || builder === undefined) {
        bump(this.counts.unreadableDeclarations, DRIZZLE);
        continue;
      }
      columns.set(key, { key, column: this.columnName(key, builder), node: property.name ?? property });
    }
  }

  /**
   * 컬럼 인자의 객체 리터럴을 찾는다(화살표 함수 본문, 같은 프로젝트 const 포함).
   *
   * @param argument 컬럼 인자
   * @returns 객체 리터럴 또는 undefined
   */
  private columnObject(argument: ts.Expression): ts.ObjectLiteralExpression | undefined {
    const inner = unwrap(argument);
    if (ts.isObjectLiteralExpression(inner)) return inner;
    if (ts.isArrowFunction(inner) && !ts.isBlock(inner.body)) return this.columnObject(inner.body);
    const value = this.evaluator.valueOf(inner);
    return value.kind === 'object' ? value.node : undefined;
  }

  /**
   * 컬럼 빌더 호출의 DB 컬럼 이름이다.
   *
   * @param key 객체 키
   * @param builder 빌더 뿌리 호출(`text('name')`)
   * @returns 컬럼 이름. casing을 확정하지 못한 키 이름 컬럼이면 undefined
   */
  private columnName(key: string, builder: ts.CallExpression): string | undefined {
    const [first] = builder.arguments;
    if (first === undefined || ts.isObjectLiteralExpression(unwrap(first))) return this.keyColumn(key);
    const value = this.evaluator.valueOf(first);
    if (value.kind !== 'string') {
      bump(this.counts.unreadableDeclarations, DRIZZLE);
      return undefined;
    }
    return value.value.length > 0 ? value.value : this.keyColumn(key);
  }

  /**
   * 키 이름 컬럼의 DB 이름이다(casing 적용).
   *
   * @param key 객체 키
   * @returns 컬럼 이름 또는 undefined(casing 미확정)
   */
  private keyColumn(key: string): string | undefined {
    if (this.casing === undefined) return undefined;
    if (this.casing === 'snake_case') return toSnakeCase(key);
    if (this.casing === 'camelCase') return toCamelCase(key);
    return key;
  }

  /**
   * 프로젝트의 casing 옵션을 정한다: 모든 `drizzle()` 호출과 `drizzle.config.*`의 `casing`이 한 값이면 그 값.
   *
   * @param calls 모든 호출 식
   * @param modules 소스 모듈
   * @returns casing 또는 undefined(여럿·비리터럴)
   */
  private projectCasing(calls: readonly ts.CallExpression[], modules: readonly SourceModule[]): Casing | undefined {
    const observed = new Set<Casing | 'unknown'>();
    for (const call of calls) {
      const callee = this.evaluator.valueOf(call.expression);
      if (callee.kind === 'external' && isDrizzleModule(callee.module) && callee.name === 'drizzle') {
        observed.add(casingOption(drizzleOptions(call, this.evaluator), this.evaluator));
      }
    }
    for (const module of modules) {
      if (basename(module.path).startsWith('drizzle.config.')) observed.add(configCasing(module, this.evaluator));
    }
    this.evaluator.resetCache();
    if (observed.size === 0) return 'none';
    const [only] = observed;
    if (observed.size === 1 && only !== 'unknown') return only;
    this.counts.namingUnverified.add(`${DRIZZLE}: the casing option differs across drizzle() calls or drizzle.config, or is not a literal; key-named columns are not emitted`);
    return undefined;
  }

  /**
   * 스키마 값의 테이블을 모은다. 모듈 이름공간, 객체 리터럴(스프레드·축약 속성)을 따라간다.
   *
   * @param value 스키마 값
   * @param tables 키 → 테이블(추가된다)
   * @param depth 깊이
   * @returns 스키마를 풀었으면 true
   */
  private collectSchemaTables(value: OrmValue, tables: Map<string, DrizzleTable>, depth: number): boolean {
    if (depth > 4) return false;
    if (value.kind === 'module') {
      for (const [name, origin] of this.evaluator.binder.exportsOf(value.sourceFile)) {
        const member = this.evaluator.originValue(origin, value.sourceFile);
        if (member.kind === 'drizzle-table') tables.set(name, member.table);
      }
      return true;
    }
    if (value.kind !== 'object') return false;
    for (const property of value.node.properties) {
      if (ts.isSpreadAssignment(property)) {
        if (!this.collectSchemaTables(this.evaluator.valueOf(property.expression), tables, depth + 1)) return false;
        continue;
      }
      const key = property.name === undefined ? undefined : propertyNameText(property.name);
      const member = ts.isPropertyAssignment(property) ? this.evaluator.valueOf(property.initializer)
        : ts.isShorthandPropertyAssignment(property) ? this.evaluator.valueOf(property.name) : UNKNOWN;
      if (key !== undefined && member.kind === 'drizzle-table') tables.set(key, member.table);
    }
    return true;
  }

  /**
   * 테이블을 담은 변수 이름 → 테이블 표다. 같은 이름이 여럿이면 뺀다(추측하지 않는다).
   *
   * @returns 이름 → 테이블
   */
  private exportNameIndex(): ReadonlyMap<string, DrizzleTable> {
    const byName = new Map<string, DrizzleTable | null>();
    for (const table of this.tablesByCall.values()) {
      const name = declarationName(table.call);
      if (name !== undefined) byName.set(name, byName.has(name) ? null : table);
    }
    return new Map([...byName].filter((entry): entry is [string, DrizzleTable] => entry[1] !== null));
  }

  /**
   * 관계 설정 콜백이 돌려주는 객체의 키 → 대상 테이블을 읽는다.
   *
   * @param config 콜백(`({ one, many }) => ({…})`)
   * @param result 키 → 대상(추가된다)
   */
  private readRelationConfig(config: ts.Expression, result: Map<string, DrizzleTable>): void {
    const fn = unwrap(config);
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return;
    const body = ts.isBlock(fn.body) ? returnedObject(fn.body) : unwrap(fn.body);
    if (body === undefined || !ts.isObjectLiteralExpression(body)) return;
    for (const property of body.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyNameText(property.name);
      const target = relationTarget(property.initializer);
      const value = target === undefined ? UNKNOWN : this.evaluator.valueOf(target);
      if (key !== undefined && value.kind === 'drizzle-table') result.set(key, value.table);
    }
  }
}

/** 테이블 선언의 스키마·이름 변환이다. */
interface TableTarget {
  readonly schema: string | undefined;
  /** 이름 변환(정적으로 풀지 못하면 undefined → dynamic)이다. */
  readonly rename: ((name: string) => string) | undefined;
  /** 스키마 이름이 리터럴이 아닌지 여부다. */
  readonly dynamicSchema: boolean;
}

/**
 * 테이블을 값으로 감싼다.
 *
 * @param table 테이블 또는 undefined
 * @returns 값 또는 undefined
 */
function tableValue(table: DrizzleTable | undefined): OrmValue | undefined {
  return table === undefined ? undefined : { kind: 'drizzle-table', table };
}

/** 관계형 쿼리를 쓸 수 있는 Drizzle 데이터베이스·트랜잭션 타입 이름 꼴이다. */
const databaseTypePattern = /(Database|Transaction)$/u;

/**
 * 타입 참조가 Drizzle 데이터베이스 타입(`NodePgDatabase<typeof schema>`, `DrizzleD1Database`)이면 값을 만든다.
 *
 * @param target 타입 이름의 값
 * @param node 타입 참조
 * @returns 값 또는 undefined
 */
function drizzleDatabaseType(target: OrmValue | { readonly kind: 'global' }, node: ts.TypeReferenceNode): OrmValue | undefined {
  if (target.kind !== 'external' || !isDrizzleModule(target.module) || !databaseTypePattern.test(target.name)) return undefined;
  const schema = node.typeArguments?.find((argument) => ts.isTypeQueryNode(argument));
  return { kind: 'drizzle-db', schema };
}

/**
 * `drizzle(client, options)`·`drizzle({ client, … })`의 옵션 객체다. 식별자는 값으로 따라간다.
 *
 * @param call drizzle 호출
 * @param evaluator 평가기
 * @returns 옵션 객체 또는 undefined(옵션 없음·객체 아님)
 */
function drizzleOptions(call: ts.CallExpression, evaluator: OrmEvaluator): ts.ObjectLiteralExpression | undefined {
  const argument = call.arguments.length >= 2 ? call.arguments[1] : call.arguments[0];
  return argument === undefined ? undefined : objectOf(argument, evaluator);
}

/**
 * 식이 객체 리터럴(또는 그것을 담은 const)이면 돌려준다.
 *
 * @param expression 식
 * @param evaluator 평가기
 * @returns 객체 리터럴 또는 undefined
 */
function objectOf(expression: ts.Expression, evaluator: OrmEvaluator): ts.ObjectLiteralExpression | undefined {
  const inner = unwrap(expression);
  if (ts.isObjectLiteralExpression(inner)) return inner;
  const value = evaluator.valueOf(inner);
  return value.kind === 'object' ? value.node : undefined;
}

/**
 * `drizzle()` 옵션의 `schema` 식이다.
 *
 * @param call drizzle 호출
 * @param evaluator 평가기
 * @returns 스키마 식 또는 undefined
 */
function drizzleSchemaOption(call: ts.CallExpression, evaluator: OrmEvaluator): ts.Expression | undefined {
  const options = drizzleOptions(call, evaluator);
  return options === undefined ? undefined : objectMember(options, 'schema');
}

/**
 * 옵션 객체의 `casing` 값이다.
 *
 * @param options 옵션 객체 또는 undefined
 * @param evaluator 평가기
 * @returns casing 또는 `unknown`(풀지 못한 스프레드·비리터럴·모르는 값)
 */
function casingOption(options: ts.ObjectLiteralExpression | undefined, evaluator: OrmEvaluator): Casing | 'unknown' {
  if (options === undefined) return 'none';
  const member = evaluator.propertyOf(options, 'casing');
  if (member === null) return 'unknown';
  if (member === undefined) return 'none';
  const value = evaluator.valueOf(member);
  if (value.kind !== 'string') return 'unknown';
  return value.value === 'snake_case' || value.value === 'camelCase' ? value.value : 'unknown';
}

/**
 * `drizzle.config.*`의 기본 내보내기(`defineConfig({…})`·객체)의 casing이다.
 *
 * @param module 설정 모듈
 * @param evaluator 평가기
 * @returns casing 또는 unknown
 */
function configCasing(module: SourceModule, evaluator: OrmEvaluator): Casing | 'unknown' {
  const target = module.exports.get('default');
  if (target === undefined || target.kind === 'reexport') return 'none';
  let expression: ts.Expression | undefined = target.kind === 'expression' ? target.expression : undefined;
  if (target.kind === 'local') {
    const value = evaluator.binder.exportsOf(module.sourceFile).get('default');
    expression = value?.kind === 'declaration' && ts.isVariableDeclaration(value.declaration) ? value.declaration.initializer : undefined;
  }
  const inner = expression === undefined ? undefined : unwrap(expression);
  const options = inner !== undefined && ts.isCallExpression(inner) ? inner.arguments[0] : inner;
  return casingOption(options === undefined ? undefined : objectOf(options, evaluator), evaluator);
}

/**
 * 인자가 정적으로 풀리는 문자열이면 값을 돌려준다.
 *
 * @param argument 인자 식
 * @param evaluator 평가기
 * @returns 문자열 또는 undefined
 */
function literalArgument(argument: ts.Expression | undefined, evaluator: OrmEvaluator): string | undefined {
  if (argument === undefined) return undefined;
  const value = evaluator.valueOf(argument);
  return value.kind === 'string' ? value.value : undefined;
}

/**
 * `pgTableCreator((name) => \`p_${name}\`)`의 이름 변환을 정적으로 만든다. 템플릿·`+` 연결에 매개변수와
 * 문자열 리터럴만 있을 때만 푼다.
 *
 * @param argument 생성기 인자
 * @returns 변환 함수 또는 undefined
 */
function renameFunction(argument: ts.Expression | undefined): ((name: string) => string) | undefined {
  const fn = argument === undefined ? undefined : unwrap(argument);
  if (fn === undefined || (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))) return undefined;
  const [parameter] = fn.parameters;
  const body = ts.isBlock(fn.body) ? returnedExpression(fn.body) : fn.body;
  if (parameter === undefined || !ts.isIdentifier(parameter.name) || body === undefined) return undefined;
  const pieces = concatenationPieces(unwrap(body), parameter.name.text);
  return pieces === undefined ? undefined : (name) => pieces.map((piece) => piece ?? name).join('');
}

/**
 * 문자열 연결 식을 조각(리터럴 문자열, 매개변수 자리는 null)으로 나눈다.
 *
 * @param expression 식
 * @param parameter 매개변수 이름
 * @returns 조각 목록 또는 undefined(다른 식이 섞임)
 */
function concatenationPieces(expression: ts.Expression, parameter: string): (string | null)[] | undefined {
  if (ts.isIdentifier(expression)) return expression.text === parameter ? [null] : undefined;
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) {
    const pieces: (string | null)[] = [expression.head.text];
    for (const span of expression.templateSpans) {
      if (!ts.isIdentifier(span.expression) || span.expression.text !== parameter) return undefined;
      pieces.push(null, span.literal.text);
    }
    return pieces;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = concatenationPieces(unwrap(expression.left), parameter);
    const right = concatenationPieces(unwrap(expression.right), parameter);
    return left === undefined || right === undefined ? undefined : [...left, ...right];
  }
  return undefined;
}

/**
 * 블록 본문의 첫 return 식이다.
 *
 * @param body 함수 본문
 * @returns return 식 또는 undefined
 */
function returnedExpression(body: ts.Block): ts.Expression | undefined {
  const statement = body.statements.find((candidate) => ts.isReturnStatement(candidate));
  return statement !== undefined && ts.isReturnStatement(statement) ? statement.expression : undefined;
}

/**
 * 블록 본문이 돌려주는 객체 리터럴이다.
 *
 * @param body 함수 본문
 * @returns 객체 리터럴 식 또는 undefined
 */
function returnedObject(body: ts.Block): ts.Expression | undefined {
  const expression = returnedExpression(body);
  return expression === undefined ? undefined : unwrap(expression);
}

/**
 * 컬럼 속성의 빌더 뿌리 호출(`text('name').notNull()`의 `text('name')`)이다.
 *
 * @param property 객체 멤버
 * @returns 뿌리 호출 또는 undefined
 */
function columnBuilder(property: ts.ObjectLiteralElementLike): ts.CallExpression | undefined {
  if (!ts.isPropertyAssignment(property)) return undefined;
  let current = unwrap(property.initializer);
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)
    && ts.isCallExpression(unwrap(current.expression.expression))) {
    current = unwrap(current.expression.expression);
  }
  return ts.isCallExpression(current) ? current : undefined;
}

/**
 * 관계 값(`one(users, {...})`·`many(posts)`·`r.one(users)`)의 대상 테이블 식이다.
 *
 * @param initializer 관계 값 식
 * @returns 대상 식 또는 undefined
 */
function relationTarget(initializer: ts.Expression): ts.Expression | undefined {
  const call = unwrap(initializer);
  if (!ts.isCallExpression(call)) return undefined;
  const callee = call.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name === 'one' || name === 'many' ? call.arguments[0] : undefined;
}

/**
 * 선언 호출을 담은 변수 이름(`const users = pgTable(…)`)이다.
 *
 * @param call 선언 호출
 * @returns 변수 이름 또는 undefined
 */
export function declarationName(call: ts.Expression): string | undefined {
  let current: ts.Node = call;
  while (ts.isCallExpression(current.parent) || ts.isPropertyAccessExpression(current.parent)
    || ts.isParenthesizedExpression(current.parent) || ts.isAsExpression(current.parent) || ts.isSatisfiesExpression(current.parent)) {
    current = current.parent;
  }
  const parent = current.parent;
  return parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : undefined;
}

/**
 * Drizzle `toSnakeCase`의 포트다(`casing.js`).
 *
 * @param input 키
 * @returns snake_case 이름
 */
export function toSnakeCase(input: string): string {
  const words = input.replace(/['’]/gu, '').match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/gu) ?? [];
  return words.map((word) => word.toLowerCase()).join('_');
}

/**
 * Drizzle `toCamelCase`의 포트다(`casing.js`).
 *
 * @param input 키
 * @returns camelCase 이름
 */
export function toCamelCase(input: string): string {
  const words = input.replace(/['’]/gu, '').match(/[\da-z]+|[A-Z]+(?![a-z])|[A-Z][\da-z]+/gu) ?? [];
  return words.reduce((result, word, index) => result + (index === 0 ? word.toLowerCase() : `${word[0]!.toUpperCase()}${word.slice(1)}`), '');
}
