# persistence: Node ORM·원시 SQL 드라이버·Cloudflare D1

`tsograph schema`가 Prisma 밖에서 읽는 표면과, 그때 쓰는 테이블·컬럼 이름 규칙의 근거를 적는다.
Prisma 규칙은 [README](../README.ko.md#tsograph-schema)에 있다. 출력은 같은 bridge-facts v1 persistence 문서다
(`relation-use`만, isthmus `docs/GRAPH-EXCHANGE.md` persistence 절).

## 읽는 방식

- **실행하지 않는다.** 분석 대상 코드는 실행하지 않고 설치된 의존성도 읽지 않는다. 이름 해석에는 프로젝트 소스만 담은
  TypeScript Program의 **심볼 해석만** 쓴다(기본 lib·`node_modules`·`@types` 없음, 모듈 해석은 프로젝트 안 파일만).
  외부 패키지 값은 import 지정자와 이름으로만 식별한다(`import { pgTable } from 'drizzle-orm/pg-core'`). 그래서
  의존성 설치 여부와 무관하게 같은 결과가 나온다. 타입 추론 결과는 쓰지 않는다.
- **출처를 증명한 수신자만 인정한다.** `db.select().from(users)`는 `users`가 Drizzle 테이블 선언을 가리킬 때만,
  `repo.find()`는 `repo`가 `getRepository(User)`·`Repository<User>`·`@InjectRepository(User)` 등으로 증명될 때만,
  `pool.query(sql)`은 `pool`이 `new Pool()`·`Pool` 타입 표기 등으로 증명될 때만 사실이 된다. 증명 경로는 변수
  초기값, 함수 반환(표기·식 본문·모든 return이 같은 값), 매개변수·필드 타입 표기와 그 타입의 멤버(타입 리터럴,
  프로젝트 인터페이스와 상속, 교차·합 타입, 구조 분해 매개변수), 데코레이터, 알려진 호출의 콜백 매개변수
  (`db.transaction(async (tx) => …)`), 파일 사이 import·재수출·CommonJS `require`·`module.exports`다.
- **이름 해석 단계는 관련 패키지가 있을 때만 돈다.** 소스가 아래 패키지 중 하나를 import·require하거나
  `D1Database`를 언급하지 않으면 건너뛴다(Prisma만 쓰는 프로젝트의 비용·결과는 그대로다).

| 표면 | 패키지 |
|---|---|
| Drizzle ORM | `drizzle-orm`(`/pg-core`·`/mysql-core`·`/sqlite-core`·`/singlestore-core`·`/gel-core`·드라이버 하위 경로) |
| TypeORM | `typeorm`, `@nestjs/typeorm` |
| Sequelize 6 | `sequelize` |
| knex | `knex` |
| 원시 드라이버 | `pg`, `mysql2`(`/promise`), `mysql`, `better-sqlite3`, `sqlite3`, `@libsql/client`, `postgres`, `@neondatabase/serverless`, `@vercel/postgres`, `@planetscale/database` |
| Cloudflare D1 | `D1Database` 타입(전역 또는 `@cloudflare/workers-types`에서 가져온 것) |

## 사실

| 출처 | `channel` | `method` | `location` | `symbol.usr` |
|---|---|---|---|---|
| Drizzle 테이블·뷰 선언 | 테이블 이름 | — | 이름 인자 | `<파일>#model:<변수>` |
| Drizzle 컬럼 | 테이블 | 컬럼 | 객체 키 | `<파일>#model:<변수>.<키>` |
| TypeORM 엔터티 | 테이블 | — | 클래스 이름 | `<파일>#model:<Class>` |
| TypeORM 컬럼·조인 컬럼 | 테이블 | 컬럼 | 속성 이름 | `<파일>#model:<Class>.<속성>` |
| TypeORM 조인 테이블(`@JoinTable`) | 조인 테이블 | — 와 두 컬럼 | 관계 속성 | `<파일>#model:<Class>.<속성>[.<컬럼>]` |
| Sequelize 모델·속성(자동 `id`·타임스탬프 포함) | 테이블 | 컬럼 | 모델 이름·속성 키 | `<파일>#model:<Model>[.<속성>]` |
| Sequelize 연관 외래 키·`through` 조인 테이블 | 테이블 | 컬럼 | 연관 메서드 이름 | `<파일>#model:<Model>.<속성 또는 조인 테이블>` |
| 쿼리(빌더·저장소·모델 메서드·SQL 텍스트) | 테이블 | 컬럼(읽을 때만) | 테이블 인자·메서드 이름·SQL 인자 | 감싼 선언의 그래프 id |

선언 사실은 Prisma 스키마와 **같은 `#model:` 선언 이름공간**을 쓴다. 새 이름공간을 만들지 않았으므로 isthmus capture의
root 위생 표(`tsograph: ['#model:', '#typedsql:']`)를 바꿀 필요가 없다. 이 usr는 그래프 노드가 아니다 — 어떤 순회에도
나오지 않고, isthmus trace는 "닿지 않음"으로 읽는다. 선언 파일 안의 코드(`relations()` 설정, `.references(() => users.id)`)가
가리키는 컬럼은 그 변수의 그래프 id를 가진 사용 사실이다.

channel은 Prisma와 같다: 스키마가 있으면 `schema.table`, 없으면 비한정이고, 이름 안의 `.`은 `%2E`, `%`는 `%25`다.
tsograph는 기본 스키마(`public`)를 추측하지 않는다.

## Drizzle ORM (drizzle-orm 0.45.3, drizzle-kit 0.31.11로 확인)

- **테이블**: `pgTable`·`mysqlTable`·`sqliteTable`·`singlestoreTable`·`gelTable`의 첫 인자 그대로
  (`pg-core/table.js` `pgTableWithSchema(name, …)` — 변환 없음). `pgView`·`pgMaterializedView`·`mysqlView`·`sqliteView`도
  관계다. `pgSchema('s').table('t')`(`mysqlSchema` 등)는 `s.t`다. `pgTableCreator(fn)`은 `fn(name)`이다
  (`pg-core/table.js` `pgTableCreator`) — `fn`이 매개변수와 문자열 리터럴만으로 된 템플릿·`+` 연결·반환이면 계산하고,
  그 밖(`name.toUpperCase()` 등)은 dynamic이다. 이름·스키마가 리터럴이 아니면 dynamic이다.
- **컬럼**: 빌더 첫 인자가 비지 않은 문자열이면 그 이름(`utils.js` `getColumnNameAndConfig`), 아니면(`text()`,
  `text({ mode })`, `text('')`) 객체 키(`column-builder.js` `setName`, `keyAsName: true`). 컬럼 객체는 객체 리터럴,
  `(t) => ({…})`, 같은 프로젝트의 객체 const와 스프레드를 따라간다.
- **casing**: 키 이름 컬럼만 `drizzle(…, { casing })`의 `snake_case`·`camelCase`로 바뀐다(`casing.js` `CasingCache`
  `getColumnCasing`: `keyAsName`이 아니면 이름 그대로; `toSnakeCase`·`toCamelCase`를 그대로 포팅). 명시 이름과 테이블
  이름은 바뀌지 않는다. 프로젝트의 모든 `drizzle()` 호출과 `drizzle.config.*`의 `casing`이 한 값일 때만 적용하고,
  값이 엇갈리거나 비리터럴이면 키 이름 컬럼을 내지 않고 `orm-naming-unverified:`를 남긴다.
- **사용**: `from`·`insert`·`update`·`delete`·`innerJoin`·`leftJoin`·`rightJoin`·`fullJoin`·`crossJoin`·`…Lateral`·`$count`는
  첫 인자가 테이블일 때만. `insert(t).values({…})`·`update(t).set({…})`의 키는 컬럼. `t.column` 접근은 컬럼.
  `db.query.<key>.findMany/findFirst`: `<key>`는 `drizzle(…, { schema })`의 스키마 키(모듈 이름공간·객체·스프레드,
  또는 `NodePgDatabase<typeof schema>` 같은 타입 인자)이고, 스키마를 풀지 못하면 이름이 유일한 테이블 변수로 찾는다
  (스키마 키는 export 이름이다). `columns` 키는 컬럼, `with` 키는 `relations(table, ({ one, many }) => …)`의 대상
  테이블(중첩 포함). 모르는 키는 dynamic, 수신자를 증명하지 못한 `x.query.k.findMany`는 `unresolved-orm-receivers:`.
- **`sql` 태그**: 보간이 테이블이면 `"schema"."table"`, 컬럼이면 `"table"."column"`, `sql.raw('…')`는 원문,
  `sql.identifier('…')`는 인용 이름, `sql.empty()`는 빈 문자열, 중첩 `sql\`…\``는 펼치고 나머지는 바인드 파라미터 `?`다
  (Drizzle의 SQL 렌더링과 같다). 관계 자리의 `?`는 미해석으로 dynamic 사실 하나를 더한다.
- 읽지 않는 것: Drizzle v1 베타의 `defineRelations`(관계형 쿼리 v2) 설정, 테이블 별칭 `alias()`.

## TypeORM (typeorm 1.1.1·0.3.31로 확인)

`naming-strategy/DefaultNamingStrategy.js`·`util/StringUtils.js`·`metadata/EntityMetadata.js`·
`metadata-builder/RelationJoinColumnBuilder.js`·`metadata-builder/JunctionEntityMetadataBuilder.js`. 두 버전의 차이는
`@Entity('')`(빈 문자열)의 처리뿐이며, tsograph는 빈 이름을 이름 없음으로 본다.

- **테이블**: `@Entity('name')`·`@Entity({ name })`·`@ViewEntity({ name })`, 없으면 `snakeCase(클래스 이름)`
  (`tableName`, `snakeCase`는 `([A-Z])([A-Z])([a-z])`→`$1_$2$3`, `([a-z0-9])([A-Z])`→`$1_$2`, 소문자). DataSource
  `entityPrefix`가 앞에 붙고(`prefixTableName`), 엔터티 `schema` 또는 DataSource `schema`(`type`이 postgres·cockroachdb·
  mssql·sap·oracle일 때)가 한정한다. `@ChildEntity`는 부모 엔터티의 테이블이다(단일 테이블 상속).
- **컬럼**: `@Column`·`@PrimaryColumn`·`@PrimaryGeneratedColumn`·`@CreateDateColumn`·`@UpdateDateColumn`·
  `@DeleteDateColumn`·`@VersionColumn`·`@ViewColumn`의 옵션 `name`, 없으면 속성 이름 그대로(`columnName`). 부모
  클래스(추상 기반 클래스 포함)의 컬럼을 물려받는다. 임베디드 `@Column(() => Name, { prefix })`는
  `camelCase(접두사들.join('_')) + titleCase(이름)`이고 접두사는 속성 이름(기본)·문자열·없음(`false`·`''`)이다
  (`EmbeddedMetadata.buildPartialPrefix`). `@TableInheritance`의 판별 컬럼은 `column.name`, 기본 `type`이다.
- **조인 컬럼**: `@ManyToOne`과 `@JoinColumn`이 붙은 `@OneToOne`은 `@JoinColumn({ name })`(배열 포함), 없으면
  `camelCase(속성 + '_' + 참조 속성)`이다(`joinColumnName`). 참조 속성은 `referencedColumnName` 또는 대상 엔터티의 주 키
  속성들이다. 대상은 `() => User`·`type => User` 또는 문자열 엔터티 이름(`'User'`)이다.
- **조인 테이블**: `@JoinTable({ name })`, 없으면 `snakeCase(소유 테이블 + '_' + 속성 경로 + '_' + 대상 테이블)`(접두사
  전 이름, `joinTableName`). 컬럼은 `joinColumn`·`inverseJoinColumn`의 `name`, 없으면 `camelCase(테이블 + '_' + 주 키
  컬럼)`(`joinTableColumnName`)이고, 두 이름이 같으면(자기 참조) `_1`·`_2`가 붙는다(`joinTableColumnDuplicationPrefix`).
- **사용자 namingStrategy**: DataSource 옵션에 `namingStrategy`가 보이면 명시한 이름만 확정한다 — 이름 없는 테이블은
  dynamic, 이름 없는 컬럼은 내지 않고 `orm-naming-unverified:`를 남긴다. 명시 이름도 전략이 바꿀 수는 있지만
  (`tableName(target, userSpecifiedName)`에 넘어간다) 널리 쓰이는 전략(typeorm-naming-strategies 등)은 명시 이름을
  그대로 두므로 정적으로 낸다. 여러 DataSource의 `entityPrefix`가 다르거나 비리터럴이면 테이블 이름은 dynamic이고,
  스키마가 다르면 한정하지 않는다. 옵션 스프레드를 풀지 못하면 기본 전략을 가정하고 limitation에 남긴다.
- **사용**: 저장소(`getRepository(User)`·`x.getRepository(User)`·`Repository<User>`·`@InjectRepository(User)`·
  `class R extends Repository<User>`의 `this`·`withRepository`·`extend`)와 ActiveRecord 엔터티 클래스(`User.find()`)의
  `find`·`findBy`·`findOne(By)`·`findAndCount(By)`·`count(By)`·`exist(s)(By)`·`save`·`insert`·`update`·`upsert`·`delete`·
  `softDelete`·`restore`·`remove`·`increment`·`decrement`·`sum`·`average`·`minimum`·`maximum`·`clear`·
  `createQueryBuilder`. EntityManager·DataSource(`new DataSource`, `EntityManager` 타입, `@InjectEntityManager`,
  `transaction(async (manager) => …)`)의 같은 메서드는 첫 인자가 엔터티일 때만. `where`·`order`·`select`와 `…By(where)`·
  `insert`·`save`·`update`의 객체 키는 컬럼, `relations`(문자열 경로·객체)는 대상 테이블과 다대다 조인 테이블.
  QueryBuilder의 `from`·`into`·`update`·`…Join…`(`…AndMap…`은 둘째 인자)은 엔터티 인자, 같은 사슬 별칭으로 푼
  `'u.photos'` 관계 경로, `createQueryBuilder`에서 시작한 사슬의 문자열 테이블 이름을 읽는다. `query(sql)`은 SQL 텍스트다.
- 읽지 않는 것: `EntitySchema`, 트리 엔터티의 추가 컬럼·closure 테이블, `@Entity({ database })`, 사용자 전략이 명시
  이름을 바꾸는 경우.

## Sequelize 6 (sequelize 6.37.8, inflection 1.13.4로 확인)

`lib/model.js`(`init`·`_addDefaultAttributes`·`refreshAttributes`), `lib/sequelize.js`(`define`), `lib/utils.js`,
`lib/associations/{mixin,belongs-to,has-many,has-one,belongs-to-many}.js`.

- **옵션 병합**: 모델 옵션은 `new Sequelize(…, { define })`의 전역 옵션 위에 덮인다(`Utils.merge`, undefined는 덮지
  않는다). 인스턴스가 여럿이고 `define`이 다르거나 비리터럴이면 파생 이름을 확정하지 않는다(`orm-naming-unverified:`).
- **테이블**: `tableName`, 없으면 `freezeTableName ? modelName : underscoredIf(pluralize(modelName), underscored)`.
  `pluralize`·`singularize`는 inflection 1.13.4의 규칙 데이터(`uncountable_words`·`plural_rules`·`singular_rules`,
  `src/schema/orm/inflection-rules.ts`에 스크립트로 옮김)와 `_apply_rules`를, `underscore`는 inflection `underscore`를,
  `camelize`는 Sequelize `utils.camelize`를 포팅했다. `schema` 옵션은 테이블을 한정한다.
- **컬럼**: 속성의 `field`, 없으면 `underscoredIf(속성 이름, underscored)`. `DataTypes.VIRTUAL`은 컬럼이 아니다. 주 키가
  없으면 `id`, `timestamps`(기본 true)면 `createdAt`·`updatedAt`(옵션 문자열로 이름이 바뀌고 `false`면 없음), `paranoid`면
  `deletedAt`, `version`이면 `version`(또는 문자열)이 더해지고 같은 `underscored` 규칙을 받는다.
- **외래 키**: `belongsTo`는 원본에 `camelize((as ?? 대상 단수) + '_' + 대상 주 키)`, `hasMany`는 대상에
  `camelize(원본 단수 + '_' + 원본 주 키)`, `hasOne`은 대상에 `camelize(singularize(as ?? 원본 이름) + '_' + 원본 주 키)`.
  `foreignKey`(문자열·`{ name, field }`)가 있으면 그 이름이다. 컬럼은 속성이 이미 있으면 그 `field`, 없으면
  `underscoredIf(이름, 외래 키를 갖는 모델의 underscored)`. 단수는 `name.singular` 또는 `singularize(modelName)`이다.
- **다대다**: `belongsToMany`의 `through` 문자열은 그대로 조인 테이블 이름이다. 조인 모델은 원본 모델의 옵션
  (`underscored`·타임스탬프 이름·`version`·`schema`)을 물려받고(`mixin.js`), 타임스탬프는 연관 `timestamps` →
  전역 `define` → 기본 true 순이다. 외래 키는 `camelize(원본 단수 + '_' + 원본 주 키)`, `otherKey`는
  `camelize(대상 단수(자기 참조면 singularize(as)) + '_' + 대상 주 키)`다. `through`가 모델이면 그 모델에 두 키를 더한다.
- **모델 식별**: `sequelize.define('Name', …)`(수신자가 Sequelize 인스턴스이거나, 모르는 수신자라도 속성 객체가
  `DataTypes.X`를 쓸 때 — `module.exports = (sequelize, DataTypes) => …` 관용구), `class X extends Model` +
  `X.init(…)`·정적 메서드의 `this.init(…)`(프로젝트 기반 클래스를 거친 상속 포함). 연관의 `associate(models)`
  함수·메서드 안 `models.User`는 모델 이름으로, 정적 메서드의 `this`는 그 모델 클래스로 푼다. `sequelize.models.User`·
  `sequelize.model('User')`도 이름으로 푼다.
- **사용**: `findAll`·`findOne`·`findAndCountAll`·`count`·`destroy`·`restore`·`findOrCreate`·`truncate`·`create`·`bulkCreate`·
  `upsert`·`update`·`findByPk`·`max`·`min`·`sum`·`increment`·`decrement`. `where` 키(연산자 키 `[Op.or]` 제외),
  `attributes`(문자열, `[속성, 별칭]`, `{ include, exclude }`), 값 객체 키는 컬럼, `include`(모델·`{ model, include, where }`)는
  포함 모델 테이블이다. `sequelize.query(sql)`은 SQL 텍스트다. 모르는 수신자의 `findAll`·`findByPk` 같은 호출은
  `unresolved-orm-receivers:`로 센다.
- 읽지 않는 것: Sequelize 7(`@sequelize/core`), sequelize-typescript 데코레이터 모델(`unsupported-db-packages:`),
  `models/index.js`의 동적 로딩(`db[model.name] = model`) 뒤 `db.User`.

## knex (knex 3.3.0으로 확인)

- 사슬 하나(`knex('users as u').join(…).select(…).where(…)`)를 가장 바깥 호출에서 한 번에 읽는다. 뿌리는 knex
  인스턴스(`knex(config)`·`require('knex')(config)`·`Knex`·`Knex.Transaction` 타입·`transaction(async (trx) => …)`·
  `await knex.transaction()`)여야 한다.
- 테이블은 `knex('t')`·`from`·`into`·`table`·`…join` 인자: 문자열(`'t'`, `'t as a'`, `'s.t'`), 별칭 객체(`{ a: 't' }`),
  같은 프로젝트의 문자열 const. 그 밖의 식은 dynamic이고, 부분 쿼리(콜백·knex 사슬)는 테이블이 아니다.
- `withSchema('s')`는 본 테이블(사슬 위치 무관)과 **그 뒤에 온** 조인에 붙는다(`querybuilder.js` `join`이 호출 시점의
  `_single.schema`를, `querycompiler.js` `tableName`이 컴파일 시점의 스키마를 쓴다).
- 컬럼은 `select`·`returning`·`first`·`pluck`·`where…`·`orderBy`·`groupBy`의 문자열(`'a.col as x'`의 별칭 제거),
  `where({…})`·`insert({…})`·`update({…})`의 키, 조인 조건 인자다. 별칭(`u.id`)으로 한정했거나 사슬의 테이블이 하나일
  때만 낸다.
- `knex.raw(sql)`과 사슬의 `whereRaw`·`orWhereRaw`·`havingRaw`·`orderByRaw`·`groupByRaw`·`selectRaw`·`joinRaw` 조각은
  SQL 텍스트로, `fromRaw`·`intoRaw` 조각은 테이블 자리 SQL로 읽는다(리터럴이 아니면 dynamic). `knex.schema.…`(DDL)는
  사용으로 보지 않는다.

## 원시 드라이버와 Cloudflare D1

- **클라이언트 증명**: `new Pool()`·`new Client()`(pg, Neon), `pool.connect()`, `createConnection`·`createPool`(mysql2,
  mysql), `getConnection()`, `new Database()`(better-sqlite3, sqlite3 `verbose()` 포함), `createClient`(libSQL,
  Vercel Postgres), `connect`(PlanetScale), 타입 표기(`Pool`·`PoolClient`·`Client`, `Connection`·`Pool`·`PoolConnection`,
  `Database`, libSQL `Client`·`Transaction`, `D1Database`).
- **SQL을 읽는 메서드**: `query`·`execute`·`prepare`·`exec`·`run`·`all`·`get`·`each`의 첫 인자, libSQL `batch([…])`의
  각 원소. 인자는 문자열 리터럴, 정적으로 풀리는 const(파일 사이 포함), `{ text }`·`{ sql }`·`{ query }` 객체다
  (뒤의 스프레드가 키를 덮으면 그 값, 풀지 못한 스프레드가 가릴 수 있으면 dynamic).
  보간이 있는 일반 템플릿 문자열(과 그것을 담은 const)은 **부분 관찰**이다: 원문에 이름으로 쓴 관계는 정적 사실로
  내고(`IN (${placeholders})` 관용구), 보간이 관계·조인 조각일 수 있으므로 원문 요약 dynamic 사실을 늘 하나 더한다.
  그 밖의 식은 dynamic이다. 게이트가 읽은 SQL은 소문자여도 읽는다(게이트 없는 리터럴은 여전히 대문자만).
- **SQL 태그**: `postgres()`·`neon()`의 반환 값과 `@vercel/postgres`의 `sql`로 쓴 태그 템플릿. 보간은 바인드
  파라미터 `?`, postgres.js의 `${sql('t')}`는 인용 식별자, 같은 태그의 중첩 조각은 펼친다. `sql.unsafe(text)`·
  `sql.query(text)`는 SQL 텍스트다. `sql.begin(async (tx) => …)`의 `tx`도 태그다.
- **D1**: `D1Database`로 선언된 속성 이름(소스와 `.d.ts` — `wrangler types`가 만드는 `interface Env { DB: D1Database }`)을
  모아 `env.DB`·`c.env.DB`·`this.env.DB`와 그 구조 분해·복사를 D1 클라이언트로 본다. 매개변수·필드의 `D1Database`
  표기와 `withSession()`도 같다. 선언을 찾지 못해도 `…env.NAME.prepare(…)`·`.exec(…)` 모양이면 D1으로 본다(`env` 자체의
  `env.exec(…)`는 아니다).
  `batch([…])`의 원소는 이미 `prepare`로 읽힌 문장이라 다시 읽지 않는다.

## limitation 접두사(추가분)

- `unresolved-orm-receivers:` 쿼리 모양이지만 수신자를 모델·저장소·클라이언트로 증명하지 못해 내지 않은 호출 수(표면별).
- `orm-naming-unverified:` 이름 규칙을 확정하지 못한 이유(Drizzle casing 불일치, TypeORM 사용자 전략·접두사 불일치,
  Sequelize 전역 `define` 불일치). 해당 이름은 dynamic이거나 생략된다.
- `unreadable-orm-declarations:` 정적으로 읽지 못한 선언 조각(비리터럴 이름·옵션, 계산된 키, 풀지 못한 스프레드) 수(표면별).

dynamic 사실은 기존 `dynamic-relation-names:`에 합산한다. 이 표면이 읽는 패키지는 더 이상 `unsupported-db-packages:`로
세지 않는다. 그 목록에는 `sequelize-typescript`·`kysely`·`objection`·`pg-promise`·`sqlite`·`mssql`·`tedious`·`oracledb`·
`@mikro-orm/core`·`slonik`이 남는다.

## 이름 규칙 오라클

`experiments/orm-naming-oracle/`은 합성 fixture(`fixtures/schema/{drizzle-d1,typeorm,sequelize,knex}-app`)를 실제
라이브러리로 실행해 이름을 기록한다. 네트워크는 npm 레지스트리 설치에만 쓰고(`npm ci --ignore-scripts`), fixture는
`work/`에 옮겨 트랜스파일한 뒤 실행한다(tsograph 자체는 여전히 분석 대상을 실행하지 않는다).

| 표면 | 실행 | 기록 |
|---|---|---|
| Drizzle | drizzle-kit `generateSQLiteMigration`으로 DDL을 만들어 sql.js에 적용, fixture의 `createDb`(실제 casing)로 만든 쿼리의 `toSQL()` | 선언 이름(DDL), 원시 SQL 마이그레이션까지 적용한 DB 이름, 쿼리 함수별 SQL |
| TypeORM | fixture DataSource 옵션(`entityPrefix` 포함) 그대로 `sqljs` 드라이버로 `synchronize` | `sqlite_master`·`PRAGMA table_info` |
| Sequelize | fixture의 `new Sequelize(…)`를 pg-mem 방언으로 바꿔 `sync()` | `information_schema.columns` |
| knex | fixture 쿼리 함수의 `toSQL()`(pg 방언, 연결 없음) | 쿼리 함수별 SQL |

`src/schema/orm/oracle.test.ts`가 오프라인으로 대조한다: 선언 사실 집합 == 실제 DDL(테이블·컬럼), 사용 사실 ⊆ DB 이름,
쿼리 함수별 테이블 집합 == ORM이 만든 SQL의 테이블 집합, 하위 쿼리가 없는 SQL에서 컬럼 사실 ⊆ SQL의 컬럼. 기록 시점
결과는 Drizzle 18/18(원시 SQL 테이블 포함 DB 22), TypeORM 37/37, Sequelize 35/35, 쿼리 13/13으로 모두 일치한다.
`drizzle-d1-app/migrations/0000_init.sql`은 오라클이 만든 drizzle-kit DDL이다. 다시 기록하려면:

```sh
cd experiments/orm-naming-oracle && npm ci --ignore-scripts && npm run record
```

## isthmus와 잇기

`fixtures/schema/drizzle-d1-app`(Hono + D1 + Drizzle, 원시 D1 SQL 포함)은 SQLite DDL로 조인할 수 있다.

```sh
sqlite3 app.db < fixtures/schema/drizzle-d1-app/migrations/0000_init.sql
sqlite3 app.db < fixtures/schema/drizzle-d1-app/migrations/0001_audit.sql
schemagraph scan "sqlite:app.db" --source-id drizzle-d1 --emit-document catalog.json -o graph.json
schemagraph facts --document catalog.json --project fixtures/schema/drizzle-d1-app -o sql-facts.json
tsograph schema --project fixtures/schema/drizzle-d1-app > js-facts.json
isthmus check --pairs js-facts.json sql-facts.json
```

오류·경고 없이 관계 5개(원시 D1 SQL만 쓰는 `audit_log` 포함)와 컬럼 14개가 짝지어진다. 라우트 핸들러를 이름 있는
함수(`app.get('/users', getUsers)`)로 두면 `tsograph reach`의 정방향 순회와 `schemagraph impact --format
language-traversal`로 `isthmus trace`가 라우트에서 테이블과 DB 의존자까지 잇는다. `app.get('/x', async (c) => …)`처럼
모듈 최상위의 익명 핸들러 안 사실은 감싼 선언 이름이 없어 usr가 없다(`missing-relation-usrs:`).
