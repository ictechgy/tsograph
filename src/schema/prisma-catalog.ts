/**
 * 파싱한 Prisma 스키마 파일들을 모델 → SQL 이름 표로 바꾼다.
 *
 * 이름 규칙(README "Prisma naming rules", 근거는 Prisma 공식 소스):
 *
 * - 테이블: `@@map` 값, 없으면 모델 이름(규칙 `prisma-8-lower-first`만 첫 글자 소문자).
 *   `@@schema("s")`가 있으면 `s.table`로 한정하고, 없으면 기본 스키마를 추측하지 않고 비한정으로
 *   둔다(Postgres 기본 스키마는 연결 URL·어댑터 설정이 정해 정적으로 알 수 없다).
 * - 컬럼: `@map` 값, 없으면 필드 이름(모든 버전 같음).
 * - 관계 필드·`@ignore` 필드·`@@ignore` 모델·composite `type`은 사실이 아니다.
 * - 암시적 다대다: `_<관계 이름>`(기본 이름은 코드 포인트 순으로 모델 이름을 이은 `<A>To<B>`), 컬럼 `A`·`B`,
 *   모델 A의 스키마. Prisma 7 규칙에서만 있다.
 * - delegate: 모델 이름의 첫 글자만 소문자(`uncapitalize`). 런타임은 모델 이름 그대로의 키도 받는다.
 */

import { compareStrings } from '../exchange/sorted-json.ts';
import {
  attributeNameArgument,
  findAttribute,
  type PrismaBlock,
  type PrismaField,
  type PrismaSchemaFile,
  type PrismaValue,
} from './prisma-schema.ts';
import type { NamingRuleId } from './prisma-version.ts';
import type { SourceText } from './source-text.ts';
import { escapeName } from './sql-relations.ts';

/** 규칙 후보 전체로 평가한 이름이다. 후보마다 결과가 다르면 dynamic이다. */
export interface ResolvedName {
  readonly channel: string;
  readonly dynamic: boolean;
}

/** 스키마 파일 하나와 그 위치 정보다. */
export interface LoadedSchemaFile {
  /** 프로젝트 기준 POSIX 경로다. */
  readonly path: string;
  readonly text: SourceText;
  readonly parsed: PrismaSchemaFile;
}

/** 컬럼 하나다. */
export interface CatalogColumn {
  readonly field: string;
  readonly column: string;
  readonly nameOffset: number;
}

/** 모델·뷰 하나의 SQL 이름이다. */
export interface CatalogModel {
  readonly name: string;
  readonly kind: 'model' | 'view';
  readonly file: LoadedSchemaFile;
  readonly nameOffset: number;
  readonly table: ResolvedName;
  /** 스칼라 컬럼(관계·ignore 필드 제외)이다. 테이블이 dynamic이면 비어 있다. */
  readonly columns: readonly CatalogColumn[];
}

/** 암시적 다대다 조인 테이블이다. */
export interface CatalogJoinTable {
  readonly table: ResolvedName;
  readonly file: LoadedSchemaFile;
  /** 사실 위치로 쓰는 관계 필드 이름 오프셋이다. */
  readonly nameOffset: number;
  /** 심볼로 쓰는 `Model.field`다. */
  readonly symbol: string;
}

/** 스키마 전체의 이름 표와 계수다. */
export interface PrismaCatalog {
  readonly models: readonly CatalogModel[];
  readonly joinTables: readonly CatalogJoinTable[];
  /** delegate 이름 → 모델이다. 이름이 겹쳐 모델을 정할 수 없으면 undefined 값이다. */
  readonly delegates: ReadonlyMap<string, CatalogModel | undefined>;
  /** datasource provider 값들이다. */
  readonly providers: readonly string[];
  readonly counts: CatalogCounts;
}

/** 사실로 만들지 않은 스키마 요소의 계수다. */
export interface CatalogCounts {
  ignoredModels: number;
  ignoredFields: number;
  unresolvedFieldTypes: number;
  dynamicTables: number;
  dynamicJoinTables: number;
  unparsedLines: number;
}

/** Prisma 스칼라 타입이다. `Unsupported("…")`도 DB 컬럼을 만든다. */
const scalarTypes: ReadonlySet<string> = new Set([
  'String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes', 'Unsupported',
]);

/** Postgres 식별자 최대 길이다. 이보다 긴 조인 테이블 이름은 잘리는 규칙을 추측하지 않는다. */
const MAX_JOIN_TABLE_NAME_LENGTH = 63;

/**
 * 스키마 파일들로 이름 표를 만든다.
 *
 * @param files 스키마 파일(경로 순)
 * @param rules 평가할 이름 규칙 후보
 * @returns 이름 표
 */
export function buildPrismaCatalog(files: readonly LoadedSchemaFile[], rules: readonly NamingRuleId[]): PrismaCatalog {
  const blocks = files.flatMap((file) => file.parsed.blocks.map((block) => ({ block, file })));
  const names = collectTypeNames(blocks.map(({ block }) => block));
  const counts: CatalogCounts = {
    ignoredModels: 0, ignoredFields: 0, unresolvedFieldTypes: 0, dynamicTables: 0, dynamicJoinTables: 0,
    unparsedLines: files.reduce((sum, file) => sum + file.parsed.unparsedLines, 0),
  };
  const models: CatalogModel[] = [];
  for (const { block, file } of blocks) {
    if (block.kind !== 'model' && block.kind !== 'view') continue;
    if (findAttribute(block.blockAttributes, 'ignore') !== undefined) {
      counts.ignoredModels++;
      continue;
    }
    models.push(buildModel(block, file, names, rules, counts));
  }
  const joinTables = buildJoinTables(blocks, names, rules, counts);
  return { models, joinTables, delegates: buildDelegates(models), providers: datasourceProviders(blocks), counts };
}

/** 이름 종류별 집합이다. */
interface TypeNames {
  readonly models: ReadonlySet<string>;
  readonly views: ReadonlySet<string>;
  readonly enums: ReadonlySet<string>;
  readonly composites: ReadonlySet<string>;
}

/**
 * 블록 이름을 종류별로 모은다.
 *
 * @param blocks 모든 블록
 * @returns 종류별 이름
 */
function collectTypeNames(blocks: readonly PrismaBlock[]): TypeNames {
  const of = (kind: PrismaBlock['kind']): Set<string> =>
    new Set(blocks.filter((block) => block.kind === kind).map((block) => block.name));
  return { models: of('model'), views: of('view'), enums: of('enum'), composites: of('type') };
}

/**
 * 모델 하나의 이름 표를 만든다.
 *
 * @param block model·view 블록
 * @param file 스키마 파일
 * @param names 종류별 이름
 * @param rules 이름 규칙 후보
 * @param counts 계수(갱신된다)
 * @returns 모델
 */
function buildModel(
  block: PrismaBlock,
  file: LoadedSchemaFile,
  names: TypeNames,
  rules: readonly NamingRuleId[],
  counts: CatalogCounts,
): CatalogModel {
  const table = resolveTable(block, rules);
  if (table.dynamic) counts.dynamicTables++;
  const columns: CatalogColumn[] = [];
  for (const field of block.fields) {
    const column = scalarColumn(field, names, counts);
    if (column !== undefined && !table.dynamic) columns.push({ field: field.name, column, nameOffset: field.nameOffset });
  }
  return { name: block.name, kind: block.kind as 'model' | 'view', file, nameOffset: block.nameOffset, table, columns };
}

/**
 * 필드가 스칼라 컬럼이면 컬럼 이름을 돌려준다.
 *
 * @param field 필드
 * @param names 종류별 이름
 * @param counts 계수(갱신된다)
 * @returns 컬럼 이름 또는 undefined
 */
function scalarColumn(field: PrismaField, names: TypeNames, counts: CatalogCounts): string | undefined {
  if (names.models.has(field.typeName) || names.views.has(field.typeName) || names.composites.has(field.typeName)) {
    return undefined;
  }
  if (!scalarTypes.has(field.typeName) && !names.enums.has(field.typeName)) {
    counts.unresolvedFieldTypes++;
    return undefined;
  }
  if (findAttribute(field.attributes, 'ignore') !== undefined) {
    counts.ignoredFields++;
    return undefined;
  }
  const mapped = stringArgument(findAttribute(field.attributes, 'map'));
  return mapped ?? field.name;
}

/**
 * 규칙 후보 전체로 테이블 이름을 평가한다.
 *
 * @param block model·view 블록
 * @param rules 이름 규칙 후보
 * @returns 이름. 후보마다 다르면 모델 이름을 실은 dynamic이다
 */
function resolveTable(block: PrismaBlock, rules: readonly NamingRuleId[]): ResolvedName {
  const mapped = stringArgument(findAttribute(block.blockAttributes, 'map'));
  const schema = stringArgument(findAttribute(block.blockAttributes, 'schema'));
  const candidates = new Set(rules.map((rule) => qualify(schema, mapped ?? defaultTableName(block.name, rule))));
  if (candidates.size !== 1) return { channel: block.name, dynamic: true };
  return { channel: [...candidates][0]!, dynamic: false };
}

/**
 * `@@map`이 없는 모델의 테이블 이름이다.
 *
 * @param modelName 모델 이름
 * @param rule 이름 규칙
 * @returns 테이블 이름
 */
export function defaultTableName(modelName: string, rule: NamingRuleId): string {
  return rule === 'prisma-8-lower-first' ? lowerFirst(modelName) : modelName;
}

/**
 * 스키마로 한정한 채널을 만든다. 이름 자체의 점은 한정자가 아니므로 escape한다.
 *
 * @param schema `@@schema` 값
 * @param table 테이블 이름
 * @returns 채널
 */
function qualify(schema: string | undefined, table: string): string {
  return schema === undefined ? escapeName(table) : `${escapeName(schema)}.${escapeName(table)}`;
}

/**
 * Prisma의 `uncapitalize`·`lowerFirst`와 같은 변환이다(첫 UTF-16 코드 단위만 소문자).
 *
 * @param name 이름
 * @returns 변환한 이름
 */
export function lowerFirst(name: string): string {
  return name.substring(0, 1).toLowerCase() + name.substring(1);
}

/**
 * 속성의 이름 인자가 문자열이면 값을 돌려준다.
 *
 * @param attribute 속성 또는 undefined
 * @returns 문자열 값 또는 undefined
 */
function stringArgument(attribute: Parameters<typeof attributeNameArgument>[0] | undefined): string | undefined {
  if (attribute === undefined) return undefined;
  const value = attributeNameArgument(attribute);
  return value?.kind === 'string' ? value.value : undefined;
}

/**
 * delegate 이름 표를 만든다. `uncapitalize` 이름과 모델 이름 그대로를 모두 등록한다.
 *
 * @param models 모델 목록
 * @returns delegate → 모델(겹치면 undefined)
 */
function buildDelegates(models: readonly CatalogModel[]): Map<string, CatalogModel | undefined> {
  const delegates = new Map<string, CatalogModel | undefined>();
  for (const model of models) {
    for (const name of new Set([lowerFirst(model.name), model.name])) {
      const existing = delegates.get(name);
      delegates.set(name, delegates.has(name) && existing !== model ? undefined : model);
    }
  }
  return delegates;
}

/**
 * datasource provider 값을 모은다.
 *
 * @param blocks 블록과 파일
 * @returns 정렬된 provider 목록
 */
function datasourceProviders(blocks: readonly { block: PrismaBlock }[]): string[] {
  const providers = new Set<string>();
  for (const { block } of blocks) {
    const provider = block.kind === 'datasource' ? block.properties.get('provider') : undefined;
    if (provider?.kind === 'string') providers.add(provider.value);
  }
  return [...providers].sort(compareStrings);
}

/** 관계 필드 하나와 그 소속이다. */
interface RelationEnd {
  readonly model: PrismaBlock;
  readonly field: PrismaField;
  readonly file: LoadedSchemaFile;
  readonly relationName: string | undefined;
}

/**
 * 암시적 다대다 관계의 조인 테이블을 만든다.
 *
 * 양쪽이 모두 목록 관계 필드이고 `fields`·`references`가 없는 관계다. 짝을 하나로 정할 수 없거나
 * 뷰·무시된 모델이 끼면 만들지 않는다(Prisma도 뷰에는 조인 테이블을 만들지 않는다).
 *
 * @param blocks 블록과 파일
 * @param names 종류별 이름
 * @param rules 이름 규칙 후보
 * @param counts 계수(갱신된다)
 * @returns 조인 테이블 목록
 */
function buildJoinTables(
  blocks: readonly { block: PrismaBlock; file: LoadedSchemaFile }[],
  names: TypeNames,
  rules: readonly NamingRuleId[],
  counts: CatalogCounts,
): CatalogJoinTable[] {
  const ends = listRelationEnds(blocks, names);
  const result: CatalogJoinTable[] = [];
  const used = new Set<RelationEnd>();
  for (const end of ends) {
    if (used.has(end)) continue;
    const partners = ends.filter((other) => other !== end && isPartner(end, other));
    if (partners.length !== 1 || used.has(partners[0]!)) continue;
    used.add(end);
    used.add(partners[0]!);
    const table = joinTableName(end, partners[0]!, rules);
    if (table.dynamic) counts.dynamicJoinTables++;
    result.push({ table, file: end.file, nameOffset: end.field.nameOffset, symbol: `${end.model.name}.${end.field.name}` });
  }
  return result;
}

/**
 * 암시적 다대다 후보가 될 수 있는 목록 관계 필드를 모은다(모델 사이, 무시되지 않은 것).
 *
 * @param blocks 블록과 파일
 * @param names 종류별 이름
 * @returns 관계 끝 목록(소스 순)
 */
function listRelationEnds(blocks: readonly { block: PrismaBlock; file: LoadedSchemaFile }[], names: TypeNames): RelationEnd[] {
  const ignored = new Set(blocks
    .filter(({ block }) => block.kind === 'model' && findAttribute(block.blockAttributes, 'ignore') !== undefined)
    .map(({ block }) => block.name));
  const ends: RelationEnd[] = [];
  for (const { block, file } of blocks) {
    if (block.kind !== 'model' || ignored.has(block.name)) continue;
    for (const field of block.fields) {
      if (!field.isList || !names.models.has(field.typeName) || ignored.has(field.typeName)) continue;
      const relation = findAttribute(field.attributes, 'relation');
      if (relation?.arguments.some((argument) => argument.name === 'fields' || argument.name === 'references')) continue;
      const name = relation === undefined ? undefined : attributeNameArgument(relation);
      ends.push({ model: block, field, file, relationName: name?.kind === 'string' ? name.value : undefined });
    }
  }
  return ends;
}

/**
 * 두 관계 끝이 같은 암시적 다대다 관계의 짝인지 본다.
 *
 * @param end 한쪽 끝
 * @param other 다른 끝
 * @returns 짝이면 true
 */
function isPartner(end: RelationEnd, other: RelationEnd): boolean {
  return end.field.typeName === other.model.name
    && other.field.typeName === end.model.name
    && end.relationName === other.relationName;
}

/**
 * 조인 테이블 이름을 규칙 후보 전체로 평가한다. Prisma 7 규칙에서만 조인 테이블이 있으므로
 * 후보에 8.x 규칙이 섞이면 dynamic이다.
 *
 * @param end 한쪽 끝
 * @param partner 다른 끝
 * @param rules 이름 규칙 후보
 * @returns 이름
 */
function joinTableName(end: RelationEnd, partner: RelationEnd, rules: readonly NamingRuleId[]): ResolvedName {
  const [first, second] = compareCodePoints(end.model.name, partner.model.name) <= 0
    ? [end.model, partner.model]
    : [partner.model, end.model];
  const relationName = end.relationName ?? `${first.name}To${second.name}`;
  const table = `_${relationName}`;
  const schema = stringArgument(findAttribute(first.blockAttributes, 'schema'));
  const onlyPrisma7 = rules.every((rule) => rule === 'prisma-7');
  if (!onlyPrisma7 || table.length > MAX_JOIN_TABLE_NAME_LENGTH) return { channel: table, dynamic: true };
  return { channel: qualify(schema, table), dynamic: false };
}

/**
 * 코드 포인트 순서로 비교한다(Rust `&str` 비교와 같은 순서).
 *
 * @param left 왼쪽
 * @param right 오른쪽
 * @returns 음수·0·양수
 */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

/**
 * generator 블록의 문자열 속성을 읽는다.
 *
 * @param block generator 블록
 * @param key 속성 이름
 * @returns 문자열 값 또는 undefined
 */
export function stringProperty(block: PrismaBlock, key: string): string | undefined {
  const value: PrismaValue | undefined = block.properties.get(key);
  return value?.kind === 'string' ? value.value : undefined;
}
