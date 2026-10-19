/**
 * Node ORM·원시 드라이버 표면(Drizzle·TypeORM·Sequelize·knex·pg·mysql2·SQLite·libSQL·postgres.js·Neon·Vercel·
 * PlanetScale·Cloudflare D1)의 `relation-use` 사실을 뽑는다.
 *
 * 단계: 관련 패키지·D1 흔적이 없으면 건너뛴다 → 프로젝트 소스만 담은 Program으로 이름 해석기 구성 → 선언 수집
 * (Drizzle 테이블·TypeORM 엔터티·Sequelize 모델과 연관. Drizzle·TypeORM은 그 패키지 지정자가 있을 때만 호출·클래스를
 * 훑는다) → 선언 사실 → 파일별 사용 스캔. 게이트가 읽은 리터럴은
 * `consumed`로 돌려줘, 뒤이은 게이트 없는 SQL 리터럴 스캔(`ClientUsageScanner`)이 다시 읽지 않게 한다.
 */

import ts from 'typescript';

import type { ModuleResolver } from '../module-resolver.ts';
import { packageName } from '../db-packages.ts';
import type { RelationFactSink } from '../relation-facts.ts';
import type { SourceModule } from '../source-module.ts';
import { collectD1Bindings, D1_TYPE_NAME, driverRules } from './driver-rules.ts';
import { DriverUsage } from './driver-usage.ts';
import { DrizzleCatalog } from './drizzle-catalog.ts';
import { DrizzleUsage } from './drizzle-usage.ts';
import { KnexUsage } from './knex-usage.ts';
import { OrmBinder } from './orm-binder.ts';
import { emptyOrmCounts, type OrmCounts, OrmFactEmitter, walk } from './orm-facts.ts';
import type { OrmContext } from './orm-sql.ts';
import { moduleLoadSpecifier, OrmEvaluator } from './orm-values.ts';
import { SequelizeCatalog } from './sequelize-catalog.ts';
import { SequelizeUsage } from './sequelize-usage.ts';
import { TypeormCatalog } from './typeorm-catalog.ts';
import { TypeormUsage } from './typeorm-usage.ts';

/** ORM 표면이 읽는 패키지다(이 밖의 import만 있으면 단계 전체를 건너뛴다). */
export const SUPPORTED_ORM_PACKAGES: ReadonlySet<string> = new Set([
  'drizzle-orm', 'typeorm', '@nestjs/typeorm', 'sequelize', 'knex', 'pg', 'mysql', 'mysql2', 'better-sqlite3', 'sqlite3',
  '@libsql/client', 'postgres', '@neondatabase/serverless', '@vercel/postgres', '@planetscale/database',
]);

/** Drizzle 값(테이블 생성 함수·`drizzle()`·`relations`)을 주는 패키지다(하위 경로 포함). */
const DRIZZLE_PACKAGE = 'drizzle-orm';

/** TypeORM 값(엔터티 데코레이터·DataSource·NestJS 연동)을 주는 패키지다. */
const TYPEORM_PACKAGES: readonly string[] = ['typeorm', '@nestjs/typeorm'];

/** 프로젝트 모듈 지정자를 한 번 훑은 결과다. */
interface ProjectPackages {
  /** ORM 표면과 관련 있는 모듈(지원 패키지 import·require·동적 import 또는 `D1Database` 참조)이 있는지 여부다. */
  readonly hasOrmModule: boolean;
  /**
   * 외부 패키지 값이 생길 수 있는 모든 자리(import·re-export·`import x = require` 선언, `require`·동적 import 호출)의
   * 지정자 패키지 이름이다. 이름 해석기는 이 자리의 지정자로만 외부 패키지 값을 만든다.
   */
  readonly names: ReadonlySet<string>;
}

/** 모듈 하나의 지정자다. */
interface ModuleSpecifiers {
  /** ORM 단계 게이트가 보는 지정자(import 바인딩, `require`·동적 import 호출)다. */
  readonly gate: readonly string[];
  /** 외부 패키지 값이 생길 수 있는 모든 자리의 지정자다(`ProjectPackages.names`의 재료). */
  readonly all: readonly string[];
}

/** ORM 단계 입력이다. */
export interface OrmExtractionInput {
  readonly modules: readonly SourceModule[];
  readonly resolver: ModuleResolver;
  readonly sink: RelationFactSink;
  /** 선언 파일(`.d.ts`) 텍스트를 돌려주는 함수다(D1 바인딩 선언 수집용). */
  readonly declarationFiles: () => readonly { readonly path: string; readonly text: string }[];
}

/** ORM 단계 결과다. */
export interface OrmExtraction {
  readonly counts: OrmCounts;
  /** 게이트가 소비한 노드다. */
  readonly consumed: ReadonlySet<ts.Node>;
}

/** 파일 하나를 도는 사용 스캐너 묶음이다. */
interface UsageScanners {
  readonly drizzle: DrizzleUsage;
  readonly typeorm: TypeormUsage;
  readonly sequelize: SequelizeUsage;
  readonly knex: KnexUsage;
  readonly driver: DriverUsage;
}

/**
 * ORM·드라이버 사실을 뽑아 수집기에 넣는다.
 *
 * @param input 입력
 * @returns 계수와 소비 노드
 */
export function extractOrmFacts(input: OrmExtractionInput): OrmExtraction {
  const counts = emptyOrmCounts();
  const consumed = new Set<ts.Node>();
  const packages = projectPackages(input.modules);
  if (!packages.hasOrmModule) return { counts, consumed };
  const d1Bindings = collectBindings(input);
  const evaluator = new OrmEvaluator(new OrmBinder(input.modules, input.resolver));
  const drizzle = new DrizzleCatalog(evaluator, counts);
  const typeorm = new TypeormCatalog(evaluator, counts);
  const sequelize = new SequelizeCatalog(evaluator, counts);
  for (const rules of [drizzle.rules(), typeorm.rules(), sequelize.rules(), driverRules(d1Bindings)]) evaluator.addRules(rules);
  // Drizzle·TypeORM 선언은 그 패키지 지정자에서 온 값으로만 생긴다. 지정자가 없으면 모든 호출·클래스를 평가해도
  // 결과가 늘 비므로 건너뛴다(drizzle.config casing 관찰과 TypeORM 기본 이름 옵션 확정은 그대로 한다).
  drizzle.discover(input.modules, packages.names.has(DRIZZLE_PACKAGE));
  evaluator.resetCache();
  typeorm.discover(TYPEORM_PACKAGES.some((name) => packages.names.has(name)) ? input.modules : []);
  evaluator.resetCache();
  sequelize.discover(input.modules);
  evaluator.resetCache();
  const context: OrmContext = { evaluator, emitter: new OrmFactEmitter(input.sink, counts, consumed, input.modules) };
  emitDeclarations(context, drizzle, typeorm, sequelize);
  const scanners: UsageScanners = {
    drizzle: new DrizzleUsage(context, drizzle), typeorm: new TypeormUsage(context, typeorm),
    sequelize: new SequelizeUsage(context, sequelize), knex: new KnexUsage(context), driver: new DriverUsage(context),
  };
  for (const module of input.modules) scanModule(module, scanners);
  counts.evaluationTruncated = evaluator.evaluationTruncated;
  return { counts, consumed };
}

/**
 * 모든 모듈의 지정자를 한 번 훑어 ORM 단계 게이트와 ORM별 선언 탐색 게이트의 재료를 모은다.
 *
 * @param modules 소스 모듈
 * @returns 단계 게이트 여부와 지정자 패키지 이름
 */
function projectPackages(modules: readonly SourceModule[]): ProjectPackages {
  let hasOrmModule = false;
  const names = new Set<string>();
  for (const module of modules) {
    const specifiers = moduleSpecifiers(module);
    hasOrmModule ||= isOrmModule(module, specifiers.gate);
    for (const specifier of specifiers.all) {
      const name = packageName(specifier);
      if (name !== undefined) names.add(name);
    }
  }
  return { hasOrmModule, names };
}

/**
 * 모듈이 ORM 표면과 관련 있는지 본다(지원 패키지 import·require·동적 import 또는 `D1Database` 참조).
 *
 * @param module 소스 모듈
 * @param specifiers 게이트가 보는 지정자
 * @returns 관련 있으면 true
 */
function isOrmModule(module: SourceModule, specifiers: readonly string[]): boolean {
  if (module.text.text.includes(D1_TYPE_NAME)) return true;
  return specifiers.some((specifier) => SUPPORTED_ORM_PACKAGES.has(packageName(specifier) ?? ''));
}

/**
 * 모듈 하나의 지정자를 한 번에 모은다. 게이트 지정자는 예전 게이트와 같은 자리만 본다(게이트가 여는 범위를 바꾸지
 * 않는다). 나머지 자리(re-export·`import x = require`·바인딩 없는 import)는 선언 탐색 게이트에만 더한다.
 *
 * @param module 소스 모듈
 * @returns 게이트 지정자와 모든 지정자
 */
function moduleSpecifiers(module: SourceModule): ModuleSpecifiers {
  const gate = module.imports.map((binding) => binding.specifier);
  const all: string[] = [];
  walk(module.sourceFile, (node) => {
    const loaded = ts.isCallExpression(node) ? moduleLoadSpecifier(node) : undefined;
    if (loaded !== undefined) gate.push(loaded);
    const specifier = loaded ?? declarationSpecifier(node);
    if (specifier !== undefined) all.push(specifier);
  });
  return { gate, all };
}

/**
 * import·re-export·`import x = require('…')` 선언의 지정자다. 이름 해석기가 외부 패키지 값을 만드는 별칭 자리다.
 *
 * @param node 노드
 * @returns 지정자 또는 undefined
 */
function declarationSpecifier(node: ts.Node): string | undefined {
  let specifier: ts.Expression | undefined;
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
  else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
  return specifier !== undefined && ts.isStringLiteralLike(specifier) ? specifier.text : undefined;
}

/**
 * 소스와 선언 파일에서 `D1Database` 바인딩 이름을 모은다.
 *
 * @param input 입력
 * @returns 바인딩 이름
 */
function collectBindings(input: OrmExtractionInput): Set<string> {
  const names = new Set<string>();
  for (const module of input.modules) if (module.text.text.includes(D1_TYPE_NAME)) collectD1Bindings(module.sourceFile, names);
  for (const file of input.declarationFiles()) {
    if (file.text.includes(D1_TYPE_NAME)) collectD1Bindings(ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS), names);
  }
  return names;
}

/**
 * 모든 선언 사실을 낸다.
 *
 * @param context 분석 문맥
 * @param drizzle Drizzle 선언
 * @param typeorm TypeORM 선언
 * @param sequelize Sequelize 선언
 */
function emitDeclarations(context: OrmContext, drizzle: DrizzleCatalog, typeorm: TypeormCatalog, sequelize: SequelizeCatalog): void {
  const { emitter } = context;
  for (const table of drizzle.tables) {
    emitter.declaration(table, table.table, undefined, table.node);
    for (const column of table.columns.values()) if (column.column !== undefined) emitter.declaration(table, table.table, [column.key, column.column], column.node);
  }
  for (const entity of typeorm.all) emitTypeormEntity(emitter, typeorm, entity);
  for (const model of sequelize.all) {
    emitter.declaration(model, model.table, undefined, model.node);
    for (const attribute of model.attributes.values()) if (attribute.column !== undefined) emitter.declaration(model, model.table, [attribute.key, attribute.column], attribute.node);
  }
  for (const key of sequelize.foreignKeys) emitter.declaration(key.model, key.model.table, [key.key, key.column], key.node);
  for (const extra of sequelize.extras) {
    emitter.declaration(extra, extra.table, undefined, extra.node);
    for (const column of extra.columns) emitter.declaration(extra, extra.table, [column, column], extra.node);
  }
}

/**
 * TypeORM 엔터티 하나의 선언 사실(테이블, 컬럼, 조인 컬럼, 조인 테이블)을 낸다.
 *
 * @param emitter 사실 발행기
 * @param catalog TypeORM 선언
 * @param entity 엔터티
 */
function emitTypeormEntity(emitter: OrmFactEmitter, catalog: TypeormCatalog, entity: ReturnType<TypeormCatalog['entityOf']> & object): void {
  emitter.declaration(entity, entity.table, undefined, entity.node);
  for (const column of entity.columns.values()) if (column.column !== undefined) emitter.declaration(entity, entity.table, [column.key, column.column], column.node);
  for (const [property, relation] of entity.relations) {
    for (const column of catalog.joinColumns(entity, property)) emitter.declaration(entity, entity.table, [property, column], relation.node);
    const junction = catalog.joinTable(entity, property);
    if (junction === undefined) continue;
    const site = { symbol: `${entity.symbol}.${property}`, node: relation.node };
    emitter.declaration(site, junction.table, undefined, relation.node);
    for (const column of junction.columns) emitter.declaration(site, junction.table, [column, column], relation.node);
  }
}

/**
 * 파일 하나의 노드를 사용 스캐너에 돌린다.
 *
 * @param module 소스 모듈
 * @param scanners 스캐너 묶음
 */
function scanModule(module: SourceModule, scanners: UsageScanners): void {
  walk(module.sourceFile, (node) => {
    if (ts.isCallExpression(node)) {
      scanners.drizzle.call(node);
      scanners.typeorm.call(node);
      scanners.sequelize.call(node);
      scanners.knex.call(node);
      scanners.driver.call(node);
    } else if (ts.isPropertyAccessExpression(node)) {
      scanners.drizzle.propertyAccess(node);
    } else if (ts.isTaggedTemplateExpression(node)) {
      scanners.drizzle.taggedTemplate(node);
      scanners.driver.taggedTemplate(node);
    }
  });
}
