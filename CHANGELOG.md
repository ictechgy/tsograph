# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.

## [Unreleased]

### Added

- 모르는 반사 대상에 대해, 안정한 닫힌 동기 함수가 반환한 plain object literal이 직접 객체 구조 분해 또는
  한 단계의 닫힌 factory wrapper 투영으로만 소비되는 경우에 한해 literal identity를 증명한다. 알려진 반사
  대상, 구조적 타입의 비겹침, 전체 객체 탈출, 전개·계산 키·메서드/접근자·`__proto__`·`then`, spread prefix,
  lexical `arguments`, optional/default/rest/대입·전달 매개변수, 열린·opaque·async/generator factory 경로는 계속 닫힌다.
  named import는 지원하지만 namespace/member와 괄호로 감싼 함수 호출은 보수적으로 미룬다.
- 같은 external-module의 private top-level `let` cache도 직접 버리는 `memo =`/`memo ??=` object write 한 번과
  안정한 반환 factory, 좁은 null/undefined guard만 있을 때 identity를 증명한다. export, 전체 객체·멤버 사용,
  setter, 복합·논리 대입, null/undefined 외 reset, 추가 object write는 닫힌다.

## [0.5.0] - 2026-10-02

### Added

- 닫힌 프로젝트 함수 선언에 직접 넘긴 익명 인라인 화살표·함수 식 callback의 매개변수에, 그 함수가 직접 호출한
  인자의 값을 bound callable 흐름으로 전달한다. 반환 closure 안의 호출과 닫힌 wrapper의 callable 매개변수 호출도
  따른다. 이름 있는 함수 식·전개·대입·탈출·열린 또는 프로젝트 밖 팩터리·혼합되거나 외부인 maker·모르는 호출 인자는
  미해석과 원래 unresolved 계수를 유지한다.

## [0.4.0] - 2026-10-02

### Added

- 호출 그래프가 닫힌 callback 매개변수, 프로젝트 함수가 반환한 callable, 생성자에서 대입한 callback과
  안전하게 읽은 이름 있는 메서드를 bounded value flow로 추적한다. 객체·함수 혼합이나 열린·반사적·몽키 패치
  흐름은 원래 `unresolved-calls:` 이유를 유지하고 candidate로 과대 추정하지 않는다. 이름 있는·계산된 속성
  삭제와 `Reflect.deleteProperty`도 값 모르는 쓰기로 보존하되, 닫힌 nominal 클래스 계보와 겹칠 수 없는 반사
  대상은 관계없는 호출을 오염시키지 않는다.


### Fixed

- 함수 재대입·반사/계산 쓰기·삭제·데코레이터·generic 반사 대상의 불확실성과 getter 실행 효과,
  export binding 별칭, 운영/테스트 분리 및 full/partial 미해석 계수를 보존한다. 호출을 변수 초기화
  노드로 잘못 확정하던 경우는 미해석으로 바로잡으므로 전체 미해석 수가 증가할 수 있다.
- 참조 완전성·callable 경로 조회에 공용 인덱스를 써 반복 AST 순회·경로 맵 재생성을 줄인다.
- 전체 제품 검사 한도를 CI job 10분 안의 8분으로 조정하고 timeout을 미완료로 명시한다.
  제품 검사는 모두 실행하며 라인·함수·분기 커버리지 기준 90%를 유지한다.

## [0.3.0] - 2026-10-01

### Added

- `reach`·`impact --entry-points`가 생산자가 관찰한 페이지·서버 액션 등의 진입점 표식을
  `symbol.entries`에 싣는다. 기본 출력은 유지하며 지원하는 isthmus 소비자에서 비HTTP 영향 보고에 쓴다.

## [0.2.0] - 2026-10-01

### Fixed

- SQL FROM/JOIN의 테이블 값 함수를 관계로 추측하지 않고 미해석 피연산자로 센다.

### Added

- `routes --role client`: 웹·React Native 전역 fetch, axios와 ky 요청을 route-call로 낸다.
  라이브러리별 URL 결합·UTF-8 위치·그래프 심볼 id·테스트 제외·민감 경로 마스킹·보수적 limitation을 검증했다.
  공유 URL 벡터 38개와 실제 HTTP 오라클 27개(axios 1.20.0·ky 1.10.0/2.1.0)를 추가했다.

## [0.1.0] - 2026-09-30

첫 발행이다. npm 패키지 `tsograph`, 실행 명령 `tsograph`. Node.js 22.18.0 이상이 필요하고, 출력을 이으려면
isthmus-cli 0.10.0 이상이 필요하다(http·`trace`·`language-traversal`을 소비하는 첫 isthmus 발행본).

### 요약

- `tsograph openapi`: Swagger 2.0·OpenAPI 3.0.x/3.1.x(JSON·YAML) → isthmus bridge-facts v1 http `route-contract`.
  서버 접두사 합성, 정규 경로 템플릿, fail-closed limitation, 입력 크기·깊이·alias 상한.
- `tsograph routes --role server`: Next.js App Router·Pages Router API와 Node 백엔드(Hono 4, Express 4·5,
  Fastify 4·5, Koa + @koa/router, NestJS 10–12) → http `route-decl`. 등록 순서 디스패치(`order`),
  `paramConstraints`·`dynamicScope`·`limitationScopes`를 싣는다.
- `tsograph schema`: Prisma 스키마·Prisma Client, Drizzle·TypeORM·Sequelize 6·knex, 원시 SQL 드라이버,
  Cloudflare D1, 원시 SQL → persistence `relation-use`. 이름 규칙은 각 라이브러리 소스와 오라클 기록으로 확인했다.
- `tsograph graph`·`reach`·`impact`: TypeScript 컴파일러 API 호출 그래프 → `tsograph-graph` v1 스냅샷과 isthmus
  `language-traversal` v1. 인터페이스·의존성 주입 호출을 `bound`·`candidate` 간선으로 잇고 `--dispatch`
  (기본 `bound`)·root별 `evidence`·`unresolvedCalls`를 낸다.
- 안정 심볼 id: 이름 있는 선언과 인라인 콜백 핸들러가 graph·routes·schema에서 같은 id(`symbol.usr`)를 가져
  isthmus `trace`가 route → 핸들러 → relation-use를 정확한 문자열 일치로 잇는다.

아래는 개발 중 기록한 세부 변경이다.

### Changed — 인라인 콜백 id (graph·reach·impact·routes·schema)

- 호출·`new` 인자로 바로 넘긴 화살표·함수 식(인라인 콜백)이 자기 그래프 노드와 id를 갖는다:
  `<콜백 식이 속한 스코프 id>.<호출 대상>(<키 인자>)[~n]`(`src/app.ts#<module>.app.get("/users")`,
  `src/lib/jobs.ts#listJobs.items.map()`). 감싼 콜백(`asyncHandler(async …)`)은 인자 사슬의 가장 바깥 호출이 이름을 주고,
  호출 대상 사슬 안의 호출·`new`는 `…`로 줄이며, 키 인자는 앞쪽 정적 키(문자열·템플릿·이름 사슬·그 배열) 최대 2개다.
  같은 스코프·같은 조각은 소스 순서로 `~2`…를 붙인다. 줄·열을 쓰지 않아 무관한 수정에 흔들리지 않는다. 규칙은 README
  "Inline callback ids"에 있다.
- graph: 담은 노드에서 콜백 노드로 새 간선 종류 `contains`를 잇는다(kartograph의 어휘적 포함 선례). 콜백을 부르는 쪽이
  대개 외부라, 이 간선이 담은 노드에서의 도달과 콜백 안에서의 역방향 영향을 잇는다. 콜백 안의 호출은 콜백 노드에서 나간다.
- routes: 인라인 핸들러의 `symbol.usr`가 감싼 선언·`<path>#<module>` 대신 핸들러 콜백 id다. 자기 노드를 얻지 못한 인라인
  핸들러(계산된 이름 멤버 안)만 `framework-dispatch-unmodeled:`로 알린다.
- schema: 인라인 콜백 안의 relation-use가 콜백 id를 `symbol.usr`로 싣는다. 모듈 최상위 콜백(`describe`·`it` 테스트 포함)
  안의 사실도 usr가 생겨 `missing-relation-usrs:`가 줄어든다.
- 이름 있는 선언의 id는 그대로다. 인라인 콜백이 없는 프로젝트의 출력은 바이트 단위로 같다. 인라인 콜백이 있으면
  `graphRevision`·그 안의 사실 usr·reach/impact의 depth(콜백 한 단계)가 바뀐다. 함수 안에서 콜백을 품은 초기값을 받은
  지역 변수는 더는 이름 조각이 아니다(예: `const handler = wrap(async () => …)`의 콜백은 `#f.handler`가 아니라 `#f.wrap()`).
  그래서 그 지역 변수를 부른 `handler()`는 `unresolved-calls:`의 `indirect`로 셀 수 있지만, 담은 함수가 `contains`로 콜백을
  이으므로 도달 집합은 같다. 전에는 `const rows = ids.map(async …)` 같은 지역 변수 노드에 들어오는 간선이 없어 담은 함수의
  reach가 콜백 안 호출을 놓쳤는데, 이제 `contains`로 잇는다.
- 합성 fixture `fixtures/graph/hono-d1-inline`·`fixtures/graph/express-pg-inline`(마이그레이션 SQL 포함)과 route → 인라인
  핸들러 → relation-use 사슬 테스트를 더했다. Node 라우트 오라클 기록을 새 usr로 다시 기록했다(모든 탐침 통과).

### Added — schema: Node ORM·원시 SQL 드라이버·Cloudflare D1

- schema: Drizzle·TypeORM·Sequelize 6·knex·원시 SQL 드라이버(`pg`·`mysql2`·`mysql`·`better-sqlite3`·`sqlite3`·
  `@libsql/client`·`postgres`·`@neondatabase/serverless`·`@vercel/postgres`·`@planetscale/database`)·Cloudflare D1의
  테이블·컬럼 선언과 쿼리를 `relation-use` 사실로 낸다. 전에는 이 패키지를 쓰는 파일 수만
  `unsupported-db-packages:`로 셌다. 이름 규칙은 각 라이브러리 소스로 확인했고(Drizzle casing, TypeORM
  `DefaultNamingStrategy`, Sequelize inflection 복수화·`underscored`·연관 외래 키) [docs/PERSISTENCE.md](docs/PERSISTENCE.md)에
  출처와 함께 적었다.
- schema: 이름 해석에 프로젝트 소스만 담은 TypeScript Program의 심볼 해석만 쓴다(lib·`node_modules` 없음, 실행·타입
  추론 없음). 지원 패키지 import나 `D1Database` 언급이 없으면 이 단계를 건너뛴다.
- schema: ORM 선언 사실은 Prisma와 같은 `#model:` 선언 이름공간(`<선언 파일>#model:<테이블 변수·Entity·Model>[.<키>]`)을
  쓴다. 새 이름공간이 없으므로 isthmus capture의 root 위생 표를 바꿀 필요가 없다.
- schema: limitation 접두사 `unresolved-orm-receivers:`·`orm-naming-unverified:`·`unreadable-orm-declarations:`를 더한다.
  `unsupported-db-packages:`에는 Kysely·Objection·MikroORM·pg-promise·sequelize-typescript·`sqlite`·MSSQL·Oracle·slonik만 남는다.
- schema: ORM·드라이버 게이트가 받은 보간 템플릿 문자열(과 그것을 담은 const)은 원문에 이름으로 쓴 관계를 정적 사실로,
  전체를 dynamic 사실로 낸다(`IN (${placeholders})` 관용구). 게이트가 읽은 SQL은 소문자여도 읽고, 게이트 없는 대문자
  SQL 스캔은 같은 리터럴을 다시 읽지 않는다. Prisma `$queryRawUnsafe` 규칙은 바꾸지 않았다.
- schema: `.d.ts` 파일을 탐색에 포함해 D1 바인딩 선언(`interface Env { DB: D1Database }`)만 읽는다(소스로 파싱하지 않는다).
- experiments/orm-naming-oracle: 합성 fixture(`fixtures/schema/{drizzle-d1,typeorm,sequelize,knex}-app`)를 실제 라이브러리로
  실행해(drizzle-kit DDL→sql.js, TypeORM `sqljs`, Sequelize pg-mem, knex `toSQL()`) 이름을 기록하고,
  `src/schema/orm/oracle.test.ts`가 오프라인으로 100% 일치를 검사한다.
- fixtures: `prisma-app`의 지원 표면 밖 예시를 TypeORM에서 Kysely로 바꾼다(TypeORM은 이제 읽는다).

### Added — Node 백엔드 라우트 선언

- routes: `tsograph routes --role server`가 Next.js 밖의 Node 백엔드 — Hono 4, Express 4·5, Fastify 4·5, Koa + @koa/router
  12–15(koa-router 12–14), NestJS 10–12(Express·Fastify 어댑터) — 의 `route-decl`을 낸다. 규칙은 npm 레지스트리에서 받은 패키지
  소스로 확인했고 출처는 `docs/NODE-ROUTES.md`에 적었다. 프레임워크는 루트 `package.json` 의존성으로 감지하고 주 버전은 잠금
  파일(없으면 선언 범위)로 정한다. 경로 문법이 주 버전마다 다른 Express·@koa/router는 주 버전을 모르면 두 문법이 같은 결과일
  때만 정적 사실로 낸다.
- routes: 등록을 실행 순서대로 모으는 정적 해석기를 더한다. 모듈 최상위와 라우터를 넘겨받거나 만드는 프로젝트 함수를
  걷고(깊이 8), import·재수출·CommonJS `require`/`module.exports`·팩토리·`this.app`·Hono `basePath()`·Fastify 플러그인·
  `fastify-plugin`을 따라간다. 조건부 등록은 사실 대신 템플릿 스코프를 단 `route-coverage:`다.
- routes: 등록 순서로 요청을 고르는 Hono·Express·Koa·NestJS(Express)가 있으면 문서가 `dispatch: "registration-order"`이고
  `order: {group, index}`를 싣는다. 요청을 넘길 수 있는 핸들러(`next` 매개변수·`@Next()`), 다른 모듈·조건부 등록, exclusive
  라우터, host·헤더 버전 필터는 순서 없이 `route-dispatch-order-unknown:`으로 알린다(isthmus #128 규칙). 내보내기 전에
  `dispatch.validate` 규칙으로 다시 검사한다.
- routes: `paramConstraints`(`int`·`slug`·`regex`·`path`), `caseInsensitive`, `narrowed`, dynamic 선언의 `dynamicScope`
  (isthmus #133), 0세그먼트 catch-all 접두사 decl, find-my-way·Express 4 `*`의 빈 값 변형 decl을 낸다. 인라인 핸들러의
  `symbol.usr`는 감싼 선언(또는 모듈 스코프)이고 `framework-dispatch-unmodeled:`로 알린다.
- graph: Node 백엔드 라우트 핸들러를 `route-handler` 진입점으로 표시한다.
- experiments: `experiments/node-routes-oracle/`가 합성 fixture 9개를 실제 프레임워크로 실행해 tsograph 예측과 대조한다
  (정밀도·재현율 100%, 탐침 756개). `src/routes/node/oracle-replay.test.ts`가 기록을 오프라인으로 다시 본다.
- conformance: isthmus `2954375`의 공유 벡터로 다시 벤더링하고, `dispatch.validate`·`scope.dynamic-validate` 사례를 제품
  검증기(`src/exchange/dispatch-order.ts`·`dynamic-scope.ts`)로 실행한다.

### Changed

- routes: framework 제공 경로 limitation에 isthmus http `limitationScopes`를 싣는다. `public/`은
  `[basePath 또는 /]` 접두사 + `GET`·`HEAD`, 구 규칙 `static/`은 `basePath/static` + `GET`·`HEAD`, `/_next`는
  `basePath/_next`로 좁힌다(Next.js 16.2.7 `server/lib/router-utils/filesystem.js`·`server/lib/router-server.js`로
  확인). 전에는 `public/`이 하나만 있어도 문서의 모든 호출이 error를 증명할 수 없었다. 설정을 끝까지 확정하지
  못했으면(감싼 호출·열거할 수 없는 키·비리터럴 `basePath`) 스코프를 생략하고, `static/`·`/_next`는 `i18n`(기본
  locale 접두사)이, `/_next`는 `assetPrefix`(자동 rewrite)가 있으면 생략한다. `public/`을 파일 목록으로 좁히지 않는
  이유는 빌드 단계가 그곳에 파일을 만들 수 있어 상한을 증명할 수 없기 때문이다.
- routes: `app/`·`pages/`가 있으면 `/_next` 엔드포인트(빌드 자산·이미지 최적화·데이터 경로)를, 루트 `static/`이
  비어 있지 않으면 구 규칙 정적 파일을 `framework-provided-routes:`로 알린다. 전에는 알리지 않아 이 경로의 호출이
  거짓 error가 될 수 있었다.
- conformance: isthmus `76b6141`의 공유 벡터로 다시 벤더링한다. `url-compose.json`에 더해진 `base-join/spring-*` 13개는
  `producer:kartograph` 대상이고 tsograph는 `url-compose` 사례를 실행하지 않는다. 새 suite `http-dispatch.json`은 해시만
  대조한다 — 서버 문서가 `specificity`라 `order`를 내지 않아 `dispatch.validate`의 대상 필드가 없다.
- conformance: isthmus `78d3dee`의 공유 벡터로 다시 벤더링한다(`http-template.json`의 Spring 사례는
  `producer:kartograph` 대상이라 건너뛰고, 새 suite `http-limitation-scope.json`의 `scope.validate` 사례로 스코프
  검증기를 검사한다). 벤더링한 모든 벡터 파일을 `SHA256SUMS`와 대조한다.

- reach·impact: 그래프 노드가 아닌 root id가 하나라도 있으면 표준 출력 없이 64로 끝나던 동작을 계약(isthmus
  `language-traversal` v1)과 형제 생산자(cartograph·kartograph)에 맞춘다. 나머지 root로 문서를 내고, 그런 id는 요청한
  자리에 `symbol` 없는 `roots` 항목으로 남기며 `truncated: true`·`truncationReasons: ["root-not-found"]`·`root-not-found:`
  limitation을 단 뒤 64로 끝난다. isthmus capture가 relation-use의 선언 쪽 usr(`#model:`·`#typedsql:`)까지 root로 넘기면
  순회 전체가 빈 출력으로 죽던 문제를 고친다. limitation과 표준 오류는 선언 이름공간 id와 모르는 id를 구별해 알린다.

- schema: 스키마 선언 사실(`<스키마 경로>#model:<Model[.field]>`)과 TypedSQL 사실(`<sql 경로>#typedsql:<이름>`)에
  그래프 노드가 아닌 이름공간의 `symbol.usr`를 싣는다. isthmus trace가 이들을 `relation-use-without-symbol`이
  아니라 닿지 않은 선언으로 읽게 하기 위해서다.
- schema: limitation 접두사 `missing-relation-symbols:`를 isthmus 체인 전용 접두사 `missing-relation-usrs:`로
  바꾼다(정보용, 심각도 영향 없음).
- schema: `export default <식>`의 식 안 사실은 심볼 `<경로>#default`를 갖는다(전에는 심볼 없이
  `missing-relation-symbols:`로 셌다). Pages Router 핸들러 id와 같게 하기 위해서다.

### Added

- 인터페이스·의존성 주입 디스패치: 인터페이스·구조 타입 수신자로 부른 메서드 호출(`this.deps.store.findX()`,
  `deps.repository.save()`)을 요구 기반 전체 프로그램 값 흐름으로 잇는다. 수신자로 흘러드는 관찰된 값이 모두
  프로젝트 클래스 인스턴스·객체 리터럴이면 구현마다 `bound` 간선을, 하나라도 모르면(`any`·외부 값·스캔 밖 호출자)
  bound 없이 `implements`하거나 수신자 타입에 대입 가능한(`TypeChecker.isTypeAssignableTo`) 프로젝트 구현 전부로
  `candidate` 간선을 낸다. deps 객체·생성자 매개변수·팩터리·기본 매개변수·모듈 싱글턴·`super` 인자를 따라간다.
  진입점·진입점 파일의 내보내기·동적 import 대상·메서드와 콜백의 매개변수·값으로 새어 나간 함수·데코레이터 클래스는
  열린 자리로 보고, 공개 패키지(`package.json` main·exports 등)나 불완전한 스캔에서는 모든 내보내기와 비공개가 아닌
  속성도 연다. 테스트 소스는 별개 프로그램으로 보아 목이 운영 호출의 bound를 막지 않게 한다. 자기 순환 자리
  (`this.store = this.store.withCache()`)는 고정점까지 되풀이하고, 속성 쓰기·메서드 떼어 내기는 수신자 흐름이 그 값을 담지
  않음이 증명될 때만 제외하며(타입으로는 제외하지 않는다), 반사적 쓰기·메서드 데코레이터·mixin·`bind`·재내보내기 배럴을 거친 동적 import도 열린 자리로 본다.
- 간선 근거 `evidence`(`direct`·`bound`·`candidate`)를 스냅샷에 싣고, 노드별 모드별 미해석 호출 수
  `unresolvedCalls`를 더한다. `graphRevision`이 둘을 덮는다.
- reach·impact `--dispatch direct|bound|candidates`(기본 `bound`)와 language-traversal v1 선택 필드: 문서 `dispatch`,
  `reached[].evidence`(깊이 상한 안에서 닿는 모든 root — 64개 상한으로 빠진 root 포함 — 각각의 가장 강한 등급 중
  가장 약한 것, root별 하한), `reached[].unresolvedCalls`·`roots[].unresolvedCalls`(1~1,000,000, 0이면 생략, root가
  도달 정점이기도 하면 같은 값). 등급 비교는 약한 간선 출발점에 닿는 root만 비트 집합으로 정확히 구한다. 단일 패스
  오라클 테스트를 등급까지 넓혔다. isthmus `feature/trace-evidence-tiers` 파서로 검증했다.
- GLM 리뷰 반영: 참조 색인이 모든 속성 접근 이름·문자열 리터럴 원소 접근을 풀고(파일 안 `namespace`의 `new App.Repo()`,
  `App["load"]()`), 색인된 호출이 없는 함수·생성자는 엄격한 문법 재검사(이름이 같은 토큰이 자기 선언 이름뿐)로 참조가 없음을
  증명할 때만 "호출 없음"으로, 아니면 모름으로 둔다. 속성 사슬 끝의 네임스페이스(`App.Repo[key]`,
  `const { run } = App.Repo`, `helpers.sub[key]`)도 값으로 쓰이면 연다. 되풀이한 `var` 선언은 초기값을 합치고, 프레임워크 파일
  (`export *`만 있는 route 포함)의 재내보내기와 ES 모듈이 아닌 파일의 최상위 선언을 연다. 흐름 질의에 식 깊이 상한과 스택
  초과 → 모름 변환을 두고 `dispatch-budget:`으로 알린다. 이름으로 찾는 쓰기·읽기·수신자 흐름을 메모하고 파일 색인·모듈
  해석을 한 번만 한다(합성 1,500모듈 21.7초 → 2.5초). 근거 등급 비트 집합에 64 MiB 상한과 부풀리지 않는 근사
  (`evidence-approximated:`)를 두고, `unresolvedCalls` 상한 적용을 `unresolved-calls-capped:`로 알린다.
  `limitationsByMode`를 필수로 한다.
- limitation `bound-dispatch:`·`candidate-dispatch:`·`dispatch-budget:`, 문서 전용 `evidence-approximated:`·
  `unresolved-calls-capped:`. reach·impact 문서의 `unresolved-calls:`·`partial-dispatch:`
  인터페이스 계수는 모드가 이은 호출을 뺀다(스냅샷은 direct 기준).
- 합성 fixture `fixtures/graph/di-dispatch`(주입 방식별 bound, 여러 조립 지점의 여러 구현, 증명하지 못하는 자리).
- reach·impact 순회를 root별 탐색에서 다중 출발 단계 동기 단일 패스로 바꾼다(root 10,000개 × 정점 2만 개
  합성 그래프에서 37.2초 → 4.4초). 더 작은 root 65개를 가진 심볼에서 큰 root 전파를 멈추고, via 동률은
  작은 root 인덱스 → 작은 선행 id로 정한다. 옛 알고리즘을 오라클로 둔 무작위 비교 테스트를 더한다.
- 콜백·참조 간선이 값 별칭·속성 별칭·객체 구조 분해를 따라가고, 전개 인자(`emit(...fns)`)를 콜백으로 본다.
- language-traversal v1 개정 반영: 다른 root에서 닿는 root도 `reached`에 싣고(`roots`는 자기 인덱스를 뺀
  다른 root만, depth·via도 그 기준), 자기 자신에게서만 닿는 root는 싣지 않는다. 모든 테이블을 root로 준
  다중 root 순회에서 서로 닿는 root가 사라지던 정보 손실을 막는다.
- `tsograph graph --project <root>`, `tsograph reach --project <root> <id>...`, `tsograph impact --project <root> <id>...`:
  TypeScript 컴파일러 API(Program + TypeChecker, 프로젝트 tsconfig/jsconfig, JS 허용)로 호출 그래프를 만들고,
  스냅샷(`tsograph-graph` v1, `graphRevision` = 노드·간선 해시)과 isthmus `language-traversal` v1
  (`dependencies`·`dependents`, root 출처 보존, depth 1~128, `--max-depth`·`--max-reached`·`truncationReasons`,
  `rootsTruncated`, `--generated-at`, git HEAD `revision`)을 낸다. 모르는 id는 목록과 함께 종료 코드 64다.
- 간선 `call`·`new`·`callback`·`reference`·`jsx`·`alias`·`initializer`. import 별칭·재내보내기·기본 내보내기·
  동적 import 구조 분해·객체 리터럴 멤버를 checker로 잇고, 인터페이스 메서드는 수신자 초기값으로 증명한
  구현만 잇는다. 매개변수·`any`·계산된 호출·풀리지 않는 import는 `unresolved-calls:`, 재정의 메서드는
  `overridden-methods:`, 타입 없는 패키지는 `missing-dependencies:`로 센다(추측하지 않는다).
- 진입점 표식(`route-handler`·`scheduled`(vercel.json crons)·`server-action`·`page`·`metadata-route`·
  `middleware`·`instrumentation`)과 HTTP 밖 진입점의 `non-http-entries:` limitation.
- 합성 fixture `fixtures/graph/next-prisma`(모든 간선 종류, 모듈 사이 해석, 순환, 다중 root, route → 테이블)와
  isthmus `language-traversal` 파서·`trace`로 왕복 검증했다.
- 안정 심볼 id 형식 `<프로젝트 기준 POSIX 경로>#<선언 경로>`(모듈 스코프 `#<module>`, 이름 없는 기본 내보내기
  `#default`, 별칭·재내보내기·구조 분해 내보내기는 `#<내보낸 이름>` export 노드)를 정하고, 이 값을 routes
  route-decl과 schema relation-use(소스 사실만)의 `symbol.usr`로 싣는다. `qualifiedName`은 그대로다.
  isthmus trace가 생산자 id를 정확한 문자열 일치로만 잇기 때문이다.
- routes: optional catch-all 접두사 decl에 `catchAllPrefix: true`를 단다(usr가 생겨 isthmus 요구를 채운다).
  usr가 없는 CommonJS 핸들러는 표식 없이 내고 `missing-route-usrs:`로 센다.
- `tsograph routes --role server --project <root> [--service <name>] [--include-tests] [--format json]`:
  Next.js App Router route handler(`app/**/route.<ext>`, `src/app` 포함)와 Pages Router API route
  (`pages/api/**`)를 isthmus bridge-facts v1 http 문서(`platform: "js"`, `roles: ["server"]`,
  `dispatch: "specificity"`, `sourceSets`, `route-decl` 사실)로 낸다. Next.js 동작은 next@16.2.7 패키지의
  소스·번들 문서로 확인했고(README 표), isthmus main 소비자로 검증했다.
- 내보내기 형태(함수·const·구조 분해·`export { x as GET }`·재내보내기)를 이름으로 확정하고, `export *`·
  CommonJS는 추측하지 않고 `route-coverage:`로 센다. Pages Router는 method를 알 수 없어 `ANY`다.
- 경로: route group 생략, `_` 비공개 폴더 제외, `[x]` → `{}`, `[...x]` → `{**}`, `[[...x]]` → `{**}`와
  접두사 decl, basePath 접두사, trailingSlash·skipTrailingSlashRedirect에 따른 `strict`/`optional`.
  `@slot`·intercepting route·부분 동적 세그먼트·Next가 거부하는 이름은 모델링하지 않고 limitation으로 낸다.
- `next.config.*`를 실행 없이 읽는다. 함수 내보내기·비리터럴 basePath는 `pathAnchor: "base"`와
  `unresolved-route-prefix:`, rewrites·redirects·i18n·proxy/middleware·메타데이터 파일·`public/`은
  `framework-provided-routes:`, package.json의 next 범위가 16.x가 아니면 `route-framework-version-unknown:`.
- 결정: `symbol.qualifiedName`을 `<파일>#<내보낸 이름>`으로 둔다. 감싼 설정(`withX(config)`)은 안쪽 리터럴을 쓰고 `unresolved-route-prefix:`로
  알린다.
- symlink 규칙을 최상위 후보까지 넓힌다: `app`·`pages`·`src`·`src/app`·`src/pages`·`public`·`next.config.*`·
  `package.json`이 symlink면 `stat` 대신 부모 목록으로 판별해 따라가지 않는다(프로젝트 밖 트리·설정을 읽던
  문제 수정). 최상위 라우터 위치는 `route-coverage:`에 이름을 적고, symlink 설정은 `unresolved-route-prefix:`와
  base 앵커, 끊어진 symlink는 없는 파일로 본다. Pages Router optional catch-all API route 지원을 Next 문서와
  matcher 소스로 확인해 테스트로 고정한다.
- `CommandFileSystem.listDirectory`(symlink를 따라가지 않는 디렉터리 읽기)와 `RouteDeclFact`·
  `RouteDeclDocument` 교환 타입을 더한다. 구문 트리를 읽기 위해 `typescript`를 런타임 의존성으로 옮긴다.
- `tsograph schema --project <root> [--format json]`: Prisma 스키마·Prisma Client 사용·원시 SQL을
  isthmus bridge-facts v1 persistence 문서(`platform: "js"`, `target: "persistence"`,
  `relation-use` 사실)로 바꾼다. schemagraph 카탈로그 문서와 isthmus `check --pairs`로 왕복 검증했다.
- Prisma 스키마: prisma.config·기본 위치·다중 파일 폴더 탐색(7.8.0 CLI 규칙), 모델 테이블·스칼라
  컬럼·암시적 다대다 조인 테이블(`_AToB`, `A`·`B`) 사실, `@map`·`@@map`·`@@schema`·`@ignore`·
  `@@ignore`·composite type·`Unsupported` 처리. 이름 규칙은 Prisma 소스로 확인한 버전 범위만 인정하고
  (잠금 파일로 판정), 모르는 버전은 규칙마다 갈리는 이름만 dynamic과 `prisma-naming-unverified:`로 낸다.
- Prisma Client: 구문으로 증명한 클라이언트 출처(생성·타입 표기·팩토리·`$transaction` 콜백·클래스
  멤버·파일 사이 import/재수출/CommonJS/동적 import 고정점)만 인정하고, delegate 접근과 호출 인자의
  스칼라 필드 키를 사실로 낸다. 추적하지 못한 수신자는 개수로만 센다.
- 원시 SQL: dartograph·cartograph와 같은 공유 SQL 관계 추출기 포트와 같은 벡터. `$queryRaw` 태그
  템플릿 보간은 바인드 파라미터로 읽고, `…Unsafe` 보간·비리터럴은 dynamic, TypedSQL `.sql`, 대문자
  SQL 리터럴을 읽는다.
- 심볼 형식 `<경로>#<선언 이름>`(스키마 사실은 모델 이름), 지원 표면 밖 ORM·드라이버·D1·비관계 저장소
  사용 계수 limitation.
- `tsograph openapi <spec> --service <name> [--project <root>] [--format json]`:
  Swagger 2.0·OpenAPI 3.0.x/3.1.x(JSON·YAML)를 isthmus bridge-facts v1 http 문서
  (`platform: "openapi"`, `target: "http"`, `roles: ["server"]`, `route-contract` 사실)로 바꾼다.
  isthmus http 절은 아직 초안이며, 이 출력은 개발 중인 isthmus 소비자로 왕복 검증했다.
- 서버 경로 접두사 합성(3.x servers·path/operation 수준 재정의, 2.0 basePath), 정규 경로 템플릿
  (세그먼트 전체 `{}`, 부분 세그먼트 골격, RFC 3986 percent-encoding), UTF-8 바이트 열 위치.
- fail-closed 규칙: 열린 서버 변수·상대 서버 URL·잘못된 basePath는 `pathAnchor: "base"`와
  `unresolved-contract-servers:`, 다중 파라미터 세그먼트·읽지 못한 path item·모르는 필드는
  `contract-coverage:`로 알린다.
- 서버 URL의 열린 변수는 리터럴 host 라벨 안쪽일 때만 경로와 무관하다고 본다.
  `https://api{env}/x`처럼 authority/경로 경계에 붙은 빈·미선언 변수가 root로 확정되던 문제를
  고치고, 경계·port·userinfo·scheme에 닿는 변수는 base로 낸다.
- 파서가 던지는 스택 초과와 예상하지 못한 내부 예외도 종료 코드 2로 끝낸다.
- 중복 매핑 키 처리를 위치별로 나눈다: 루트·`paths`·path item(`$ref`로 따라간 것 포함)·
  읽는 operation 키·서버 객체와 변수·따라간 포인터 키의 중복은 코드 2로 거부하고, 그 밖
  (`components.schemas` 등)의 중복은 첫 값을 쓰고 `duplicate-mapping-keys:` limitation으로 알린다.
  실제 스펙이 schemas의 중복 정의 하나로 전체 거부되던 문제를 고친다.
- 입력 안전: 16 MiB 상한, 엄격한 UTF-8, 단일 YAML 문서, 파싱 전 노드 수·flow 깊이 사전 검사,
  선형 시간 중복 키 검사, merge key·alias 키 거부, alias 역참조 상한, 로컬 `$ref`만, 사실
  100,000개(생성 전 계수)·출력 16 Mi 문자 상한, operationId 1,024자 상한.
- isthmus `conformance/http-template.json` 공유 벡터 훅(벡터가 없으면 건너뜀).
- 저장소 골격: TypeScript ESM CLI, `node --test` 타입 제거 실행, 커버리지 90% 게이트,
  clean build와 CLI 계약 검증, CI(ubuntu·macos).
