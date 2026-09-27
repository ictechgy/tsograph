# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.

## [Unreleased]

### Changed

- schema: `export default <식>`의 식 안 사실은 심볼 `<경로>#default`를 갖는다(전에는 심볼 없이
  `missing-relation-symbols:`로 셌다). Pages Router 핸들러 id와 같게 하기 위해서다.

### Added

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
