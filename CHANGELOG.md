# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.

## [Unreleased]

### Added

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
- 결정: `usr`는 아직 싣지 않고 `symbol.qualifiedName`을 `<파일>#<내보낸 이름>`으로 둔다(이후 그래프 id로
  `usr` 추가). isthmus가 `catchAllPrefix` decl에 `symbol.usr`를 요구하므로 optional catch-all 접두사 decl은
  표식 없이 일반 decl로 낸다. 감싼 설정(`withX(config)`)은 안쪽 리터럴을 쓰고 `unresolved-route-prefix:`로
  알린다.
- `CommandFileSystem.listDirectory`(symlink를 따라가지 않는 디렉터리 읽기)와 `RouteDeclFact`·
  `RouteDeclDocument` 교환 타입을 더한다. 구문 트리를 읽기 위해 `typescript`를 런타임 의존성으로 옮긴다.
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
