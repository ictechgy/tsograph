/**
 * ORM 선언(테이블·엔터티·모델)의 공통 모양이다.
 *
 * 선언은 두 가지로 쓰인다: 선언 자체를 선언 쪽 `relation-use` 사실로 내고(`#model:` 이름공간),
 * 코드의 사용(쿼리)이 가리키는 테이블·컬럼 이름을 풀 때 참조한다.
 */

import type ts from 'typescript';

import { escapeName } from '../sql-relations.ts';

/** 해석한 테이블 이름이다. dynamic이면 channel은 원문 요약이다. */
export interface TableName {
  readonly channel: string;
  readonly dynamic: boolean;
}

/** 컬럼 하나다: 코드 쪽 키(속성·필드 이름)와 DB 컬럼 이름. */
export interface OrmColumn {
  /** 코드 쪽 이름(Drizzle 객체 키, TypeORM 속성, Sequelize 속성)이다. */
  readonly key: string;
  /** DB 컬럼 이름이다. undefined면 이름 규칙을 확정하지 못해 내지 않는다. */
  readonly column: string | undefined;
  /** 선언 사실의 위치 노드다. */
  readonly node: ts.Node;
}

/** 선언 사실을 낼 때 쓰는 공통 정보다. */
export interface DeclarationSite {
  /** 선언 사실의 `symbol.qualifiedName`(`users`·`User`)이다. */
  readonly symbol: string;
  /** 테이블 사실의 위치 노드다. */
  readonly node: ts.Node;
}

/** Drizzle 테이블(또는 뷰) 선언이다. */
export interface DrizzleTable extends DeclarationSite {
  readonly table: TableName;
  /** 객체 키 → 컬럼이다. */
  readonly columns: ReadonlyMap<string, OrmColumn>;
  /** 테이블 선언 호출 노드다. */
  readonly call: ts.CallExpression;
}

/** TypeORM 관계 하나다. */
export interface TypeormRelation {
  readonly kind: 'many-to-one' | 'one-to-one' | 'one-to-many' | 'many-to-many';
  /** 대상 엔터티를 돌려주는 식(`() => User`의 `User`)이다. */
  readonly target: ts.Expression | undefined;
  /** `@JoinColumn`·`@JoinTable` 데코레이터 호출이다. */
  readonly joinColumn: ts.CallExpression | undefined;
  readonly joinTable: ts.CallExpression | undefined;
  /** 속성 이름 노드다. */
  readonly node: ts.Node;
}

/** TypeORM 엔터티 선언이다. */
export interface TypeormEntity extends DeclarationSite {
  readonly declaration: ts.ClassLikeDeclaration;
  /** 접두사를 붙이기 전 테이블 이름(조인 테이블 이름 규칙이 쓴다)이다. */
  readonly baseTable: string | undefined;
  readonly schema: string | undefined;
  readonly table: TableName;
  /** 속성 이름 → 컬럼(상속한 컬럼 포함)이다. */
  readonly columns: ReadonlyMap<string, OrmColumn>;
  /** 주 키 속성 이름이다(선언 순). */
  readonly primaryKeys: readonly string[];
  /** 속성 이름 → 관계다. */
  readonly relations: ReadonlyMap<string, TypeormRelation>;
}

/** Sequelize 모델 선언이다. */
export interface SequelizeModel extends DeclarationSite {
  /** 모델 이름(`modelName`)이다. */
  readonly name: string;
  readonly table: TableName;
  /** 속성 이름 → 컬럼(자동 추가 속성 포함)이다. */
  readonly attributes: Map<string, OrmColumn>;
  /** 주 키 속성 이름이다. */
  readonly primaryKey: string;
  /** 단수·복수 이름(연관 외래 키 이름 규칙)이다. */
  readonly singular: string;
  readonly plural: string;
  /** `underscored` 옵션이다. */
  readonly underscored: boolean;
  /** 모델 옵션(연관이 조인 모델에 물려준다)이다. */
  readonly options: SequelizeModelOptions;
}

/** 조인 테이블 등 추가 선언 사실이다(연관·다대다가 만든다). */
export interface ExtraDeclaration extends DeclarationSite {
  readonly table: TableName;
  readonly columns: readonly string[];
}

/** Sequelize 모델 옵션 중 이름에 영향을 주는 것이다. undefined는 지정하지 않음이다. */
export interface SequelizeModelOptions {
  readonly tableName?: string | undefined;
  readonly freezeTableName?: boolean | undefined;
  readonly underscored?: boolean | undefined;
  readonly timestamps?: boolean | undefined;
  readonly paranoid?: boolean | undefined;
  readonly createdAt?: string | false | undefined;
  readonly updatedAt?: string | false | undefined;
  readonly deletedAt?: string | false | undefined;
  readonly version?: string | boolean | undefined;
  readonly schema?: string | undefined;
  readonly singular?: string | undefined;
  readonly plural?: string | undefined;
}

/**
 * 스키마·테이블 이름을 channel로 만든다. 각 세그먼트는 그대로 한 이름이라 `.`·`%`를 escape한다.
 *
 * @param schema 스키마(없으면 비한정)
 * @param table 테이블 이름
 * @returns channel
 */
export function qualifiedChannel(schema: string | undefined, table: string): string {
  return schema === undefined ? escapeName(table) : `${escapeName(schema)}.${escapeName(table)}`;
}
