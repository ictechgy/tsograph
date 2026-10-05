# tsograph

<img src="https://raw.githubusercontent.com/ictechgy/tsograph/main/icon.png" alt="tsograph의 물총새 마스코트" width="112" height="112" align="right">

[English](README.md)

TypeScript/JavaScript(Node) 서비스의 정적 사실을
[isthmus](https://github.com/ictechgy/isthmus) bridge-facts 교환 형식으로 낸다.

tsograph는 정적 분석 CLI 가족(Swift의 cartograph, Kotlin의 kartograph, Dart의 dartograph,
Go의 gartograph, Rust의 rustograph, SQL의 schemagraph)의 TypeScript/JavaScript 생산자다. 각 도구는
자기 언어에서 본 것만 보고하고, 조인은 isthmus가 한다.

## 상태

| 영역 | 상태 |
|---|---|
| `tsograph openapi`: OpenAPI 2.0/3.0/3.1 → `route-contract` 사실 | 구현됨 |
| `tsograph routes --role server`: Next.js App Router route handler·Pages Router API route → `route-decl` 사실 | 구현됨 |
| `tsograph routes --role server`: Node 백엔드 — Hono 4, Express 4·5, Fastify 4·5, Koa + @koa/router 12–15, NestJS 10–12 → `route-decl` 사실([규칙](docs/NODE-ROUTES.md)) | 구현됨 |
| `tsograph schema`: Prisma 스키마·Prisma Client·원시 SQL → persistence `relation-use` 사실 | 구현됨 |
| `tsograph schema`: Drizzle·TypeORM·Sequelize 6·knex·원시 SQL 드라이버(`pg`·`mysql2`·SQLite·libSQL·postgres.js·Neon·Vercel Postgres·PlanetScale)·Cloudflare D1 | 구현됨([docs/PERSISTENCE.md](docs/PERSISTENCE.md)) |
| Kysely·Objection·MikroORM·pg-promise·sequelize-typescript·MSSQL·Oracle·slonik relation-use | 계획(현재는 limitation으로 센다) |
| `tsograph graph`·`reach`·`impact`: TypeScript/JavaScript 호출 그래프 → isthmus `language-traversal` v1 | 구현됨 |
| 인터페이스·의존성 주입 디스패치: `bound`·`candidate` 간선, `--dispatch`, root별 하한 `evidence`, `unresolvedCalls` | 구현됨 |
| `tsograph routes --role client`: 웹/React Native fetch·axios·ky route-call | 구현됨 |

HTTP v1 계약은 isthmus-cli **0.10.0**에 발행됐다. `check`(`--pairs` 포함)·`query`·`trace`·`diff --http`가
`target: "http"` 문서를 읽고, `trace`는 `language-traversal` v1도 읽는다. 구현되지 않은 확장 필드는
명시적 초안으로 남기고 입력 오류로 거부한다. isthmus-cli 0.9.0 이하는 `target: "http"`를 거부한다.

## `tsograph routes --role client`

```sh
tsograph routes --role client --project ./web --service example-api > calls.json
tsograph impact --project ./web --roots-from affected-call-symbols.json
```

전역 `fetch`(웹·React Native), 심볼 provenance가 있는 axios import·`create` 인스턴스,
ky import·`create`/`extend` 인스턴스를 `platform: "js"`, `target: "http"`, `roles: ["client"]`로 낸다.
`symbol.usr`는 화면 콜백을 포함한 감싸는 선언의 그래프 id이며, 위치는 1 기반 UTF-8 바이트 열이다.
테스트 소스는 `--include-tests`로 포함할 때만 `testSource: true`를 단다.

axios 1.20.0·ky 1.10.0(`prefixUrl`)·ky 2.1.0(`prefix`/`baseUrl`) 결합을 isthmus 공유 벡터와 실제
로컬 HTTP 요청 27개로 검증했다. ky 설정은 선언된 major가 명확해야 한다. 전체 세그먼트 보간만 `{}`가
되고 부분 보간은 dynamic이다. query·fragment·userinfo를 제거하고 고엔트로피·웹훅 경로를 마스킹한다.

미상 전개, 변경되거나 외부로 넘겨진 설정, interceptor·hook·adapter 및 미확정 동사는 `dynamic`·
`methodDynamic`·`pathAnchor: "base"`·limitation으로 보존한다. 자체 래퍼, URL/Request 객체, 계산된 메서드,
런타임 설정, ky prefix+baseUrl 동시 사용, 전역 fetch 교체는 증명 범위 밖이다. 0건이어도 coverage 한계가 남는다.
라이브러리는 오라클용 개발 의존성이며 CLI는 분석 대상 코드를 실행하지 않는다.

## 요구 사항

- Node.js 22.18.0 이상
- 문서를 이으려면 isthmus-cli 0.10.0 이상(`npm install -g isthmus-cli`)

## 설치

```sh
npm install -g tsograph
tsograph --version
```

## `tsograph openapi`

```sh
tsograph openapi <spec-file> --service <name> [--project <root>] [--format json]
```

Swagger 2.0 또는 OpenAPI 3.0.x/3.1.x 스펙 하나(JSON·YAML)를 읽어 bridge-facts v1 문서를 표준
출력에 쓴다. `platform: "openapi"`, `target: "http"`, `roles: ["server"]`이고, (경로, method)
operation마다 `route-contract` 사실이 하나다.

- `--service`(필수): 문서와 모든 사실에 싣는 서비스 신원.
- `--project`: 조인 루트. `project`는 그 POSIX realpath이고 `location.path`는 그 기준 상대 경로다.
  기본값은 스펙 파일의 디렉터리다. 스펙이 프로젝트 밖에 있으면 사용법 오류다.
- 종료 코드: `0` 성공(사실 0건도 성공이며 완전성의 증거가 아니다), `2` 읽을 수 없거나 잘못된
  스펙(원인과 해결 방향을 알리되 스펙 원문·절대 경로는 싣지 않는다), `64` 사용법 오류. `1`은 예약.

출력 예시는 [README.md](README.md#tsograph-openapi)에 있다(키 정렬·두 칸 들여쓰기 JSON).

### 사실을 만드는 규칙

- **channel**: 정규 경로 템플릿. 서버 경로 접두사(3.x `servers`, 2.0 `basePath`)를 앞에 붙이고
  scheme·host·port는 버린다. 세그먼트 전체 파라미터는 `{}`, 부분 세그먼트 파라미터는 리터럴 골격
  (`/files/{}.json`), 파라미터가 둘 이상인 세그먼트는 `dynamic`이다. 리터럴은 RFC 3986 pchar와
  대문자 `%XX`를 쓰고 unreserved 문자는 인코딩하지 않는다. 중복·끝 슬래시와 대소문자는 보존한다.
  query 파라미터와 헤더는 키에 들어가지 않는다.
- **method**: operation 키의 대문자. 키는 대소문자를 구분한다(`GET:`은 operation이 아니다).
  `trace`는 3.x에서만 operation이다.
- **location**: operation의 method 키 위치. 소스 파일 기준 1부터 시작하는 줄과 1부터 시작하는
  UTF-8 바이트 열이다. 열은 소스 오프셋에서 구하므로 같은 줄 앞의 이스케이프(JSON·YAML 큰따옴표
  문자열의 `\u0041`·`\"`·`\n`)는 디코드한 값이 아니라 쓰인 바이트 그대로 센다. 앞의 BOM은 세지 않는다.
- **symbol.qualifiedName**·**operationId**: operationId가 있으면 싣는다(`usr` 없음).
- 서버 우선순위: operation `servers` > path item `servers` > 루트 `servers` > 기본값 `/`.
  빈 `servers` 배열은 없는 것과 같다.

### fail-closed 결정

증명할 수 없는 값은 추측하지 않는다. `pathAnchor: "base"`, `dynamic: true`, 초안의 계약 측
limitation 접두사를 써서 isthmus가 거짓 error 대신 판정을 낮추게 한다.

- **경로의 서버 변수**: `enum`이 있으면 값마다 사실을 낸다(조합 256개 상한). `default`만 있는
  변수는 클라이언트가 바꿀 수 있는 열린 값이라 접두사를 **확정하지 않는다** — 변수 뒤 리터럴
  꼬리와 `pathAnchor: "base"`를 쓰고 문서에 `unresolved-contract-servers:`를 싣는다. 리터럴
  authority 없이 앞에 오는 변수(`{base}/v1`)는 경로를 바꿀 수 있어 역시 확정하지 않는다.
- **host의 열린 변수**는 host 라벨 안쪽에 있을 때만 경로와 무관하다고 본다. 조건은 모두다:
  URL에 리터럴 `scheme://` 또는 `//`가 있고, authority에 userinfo(`@`)가 없고, 변수가 host 끝보다
  앞에서 끝나고(authority/경로 경계나 port에 닿지 않음), 기본값에 `/`·`@`·`:`·`[`·`]`가 없다.
  그래서 `https://{tenant}.example.com/api`는 `root`다(테넌트 서브도메인이 흔하고, OpenAPI 변수는
  URL 템플릿의 치환 값이다). 나머지는 `base`다: `https://api{env}/x`(경계에 붙은 빈·미선언 변수),
  `https://{host}/api`(host 전체를 차지해 경계에 닿음), `https://h:{port}/api`,
  `https://{user}@h/api`, `enum` 없는 scheme 변수(`{scheme}://h/api`).
- **상대 서버 URL**(`v1`, `./v1`)은 문서를 제공하는 위치 기준이라 역시 `base`다. `/v1`은 절대
  경로라 `root`다.
- **여러 서버**의 경로 접두사가 다르면 확정한 접두사마다 사실을 낸다. 일부만 확정되면 `root`와
  `base` 사실을 함께 낸다.
- **해석기마다 갈리는 표기**: 서버 URL·`basePath`의 `.`·`..` 세그먼트(`%2E` 포함), 백슬래시, 탭·
  줄바꿈은 WHATWG와 RFC 3986 해석 결과가 달라 `base`다. 값에 `?`·`#`가 든 열린 변수도 `base`다.
- **Swagger 2.0 `basePath`**가 `/`로 시작하지 않거나 중괄호·`?`·`#`를 포함하면 `base`다.
- **경로 키의 dot 세그먼트**(`/a/../b`, `/a/%2E/b`)는 클라이언트 URL 정규화가 지우므로 `dynamic`이다.
- **`$ref`**: path item(3.1 `components.pathItems` 포함)의 로컬 JSON Pointer(`#/...`)만 최대 16단계
  따라간다. 로컬이 아니거나 깨졌거나 순환하는 참조는 `contract-coverage:`로 센다. 네트워크는 쓰지
  않는다.
- **건너뛴 입력은 조용히 버리지 않고 센다**: `/`로 시작하지 않는 paths 키, 객체가 아닌 path
  item·operation, 모르는 path item 필드, dynamic 템플릿은 `contract-coverage:`로 알린다. 금지 문자가
  있거나 1,024자를 넘는 operationId는 빼고 `unsafe-operation-ids:`(정보용)로 센다.
- **3.1 `webhooks`**는 서비스가 보내는 요청이지 제공하는 라우트가 아니라 내지 않는다.
- **2,048자를 넘는 템플릿**은 소비자가 거부하므로 `dynamic`으로 낸다.

### 입력 안전

- 스펙은 16 MiB 이하, 유효한 UTF-8, YAML 문서 하나여야 한다.
- 파싱 전 선형 사전 검사로 값 수 추정치(쉼표 + 콜론 + 줄바꿈)를 1,500,000, flow 중첩 깊이를
  1,000으로 제한한다. YAML 파서가 노드마다 약 1 KB를 써서 더 큰 입력은 메모리를 다 쓸 수 있다.
  아주 큰 스펙은 나눈다.
- 중복 매핑 키는 선형 시간 검사로 찾는다(파서 내장 검사는 매핑 크기에 대해 제곱 시간이다).
  처리는 위치에 따라 다르다.
  - **거부(코드 2)**: 사실이나 그 위치를 바꿀 수 있는 곳. 모든 루트 키(`openapi`·`swagger`·
    `servers`·`basePath`·`host`·`paths` 등), `paths` 안의 키, path item의 모든 키(로컬 `$ref`로
    따라간 것 포함), tsograph가 읽는 operation 키(`operationId`·`servers`), 서버 객체와 서버
    변수의 모든 키, 따라간 `$ref` 포인터가 지나가는 각 키다.
  - **무시**: 그 밖의 곳(예: `components.schemas`, 설명, 예시, 쓰지 않는 components, operation의
    `responses`). 파싱을 계속하고 **첫 번째** 값을 쓰며(어느 사실에도 영향이 없다), 공백이 보이도록
    정보용 limitation `duplicate-mapping-keys: <count> duplicate key(s) outside route-bearing
    sections were ignored (first at line N)`을 싣는다.
- alias·컬렉션 매핑 키는 거부한다.
- YAML merge key(`<<`)는 무시하지 않고 거부한다. 다른 도구는 펼치므로 조용히 버리면 `servers`가
  사라질 수 있다. alias는 미리 만든 색인으로 따라가고 역참조는 100,000회로 제한한다. 사용자
  태그는 실행하지 않고, 트리를 JS 객체로 바꾸지 않는다.
- 사전 검사는 block(들여쓰기) 중첩을 세지 않는다. 파서가 이를 자원 오류로 알리고, 파서가 던지는
  스택 초과도 코드 2로 바꾼다. 그 밖의 예상하지 못한 내부 예외도 스택 트레이스나 스펙 원문 없이
  `internal error (<kind>)`와 코드 2로 끝난다.
- 사실은 최대 100,000개(사실을 만들기 전에 센다)이고, 출력은 isthmus 파일당 입력 상한인
  16 Mi 문자 안이어야 한다. 넘으면 부분 문서 대신 실패한다.

## `tsograph routes --role server`

```sh
tsograph routes --role server --project <root> [--service <name>] [--include-tests] [--format json]
```

Next.js 프로젝트나 Node 백엔드(Hono·Express·Fastify·Koa + @koa/router·NestJS)를 스캔해 bridge-facts v1
문서를 표준 출력에 쓴다: `platform: "js"`, `target: "http"`, `roles: ["server"]`, `dispatch`, `sourceSets`,
(라우트, HTTP method)마다 `route-decl` 사실 하나. 분석 대상 코드는 실행하지 않고 네트워크 접근도 하지 않는다.
Next.js route 파일은 TypeScript 파서로 읽기만 하고, Node 백엔드는 라우터를 파일 사이로 따라가려고 `tsograph graph`와
같은 방식의 TypeScript `Program`으로 읽는다. 아래 [Node 백엔드](#node-백엔드)를 본다.

- `--role server`(필수): 선언 측만 구현했다. `client`는 route-call 추출이 생기기 전까지 사용법 오류다.
- `--project`(필수): 프로젝트 루트(`package.json`, `next.config.*`, `app/`·`pages/`가 있는 곳). `project`는
  그 POSIX realpath이고 `location.path`는 그 기준 상대 경로다. Node 프레임워크는 루트 `package.json` 의존성으로
  감지하고, Next.js는 `next`가 선언됐거나 `next.config.*`가 있거나 Node 백엔드 프레임워크를 하나도 감지하지 못했을 때
  스캔한다.
- `--service`: 문서와 모든 사실에 싣는 서비스 신원.
- `--include-tests`: 테스트로 보이는 route 파일도 `testSource: true`와 `sourceSets.tests: "included"`로
  낸다. 없으면 건너뛰고 `sourceSets.tests: "excluded"`를 선언한다. 테스트 경로는 `*.test.*`·`*.spec.*`와
  `__tests__/`·`__mocks__/` 아래 파일이다. Next.js에서 `test/` 폴더는 실제 URL 세그먼트라
  (`app/api/test/route.ts`는 `/api/test`) 테스트로 보지 않고, Node 백엔드에서는 `test/`·`tests/`·`e2e/` 아래 파일과
  `*.e2e-spec.*`·`*.e2e.*`도 테스트다.
- 종료 코드: `0` 성공(사실 0건도 성공이며 완전성의 증거가 아니다), `2` 읽을 수 없는 프로젝트나 상한을
  넘는 출력(사실 100,000개 초과, 16 Mi 문자 초과), `64` 사용법 오류. route 파일 하나를 읽지 못하는 것은
  실패가 아니라 limitation이다.

### 확인한 Next.js 동작(next 16.2.7)

아래 규칙은 추측하지 않고 `next@16.2.7` 패키지(`dist/` 소스와 `dist/docs/`의 번들 문서)로 확인했다.

| 규칙 | `next/dist` 출처 |
|---|---|
| `app/`·`pages/`는 프로젝트 루트를 먼저, 없으면 `src/`를 본다 | `lib/find-pages-dir.js`(`findDir`) |
| route handler는 `pageExtensions`마다 `route.<ext>`다(기본 `tsx`·`ts`·`jsx`·`js`, `.mts`는 기본값이 **아니다**) | `server/lib/find-page-file.js`, `server/config-shared.js` |
| 핸들러 method는 내보낸 이름 `GET`·`HEAD`·`OPTIONS`·`POST`·`PUT`·`DELETE`·`PATCH`다. 소문자 이름과 `default`는 핸들러가 아니다 | `server/web/http.js`, `server/route-modules/app-route/module.js` |
| `HEAD`(GET이 있을 때)와 `OPTIONS`는 자동 구현되므로 decl로 내지 **않는다**(isthmus가 `head-as-get`·`options-any`로 맞춘다) | `server/route-modules/app-route/helpers/auto-implement-methods.js` |
| route group `(name)`과 `@slot` 세그먼트는 경로에서 빠진다 | `shared/lib/router/utils/app-paths.js`(`normalizeAppPath`), `shared/lib/segment.js` |
| `_`로 시작하는 파일·폴더는 App Router 스캔에서 빠지고, `%5F`는 리터럴 밑줄이다 | `build/route-discovery.js`(`ignorePartFilter`), project-structure 문서 |
| 동적 세그먼트는 세그먼트 전체일 때만이다: `[x]` → `{}`, `[...x]` → `{**}`(1개 이상), `[[...x]]` → 0개 이상. `[[x]]`, 끝이 아닌 catch-all, `.`로 시작하는 이름, 반복된 이름은 빌드 오류다 | `shared/lib/router/utils/sorted-routes.js`, `route-regex.js` |
| `pages/api` 아래(와 `pages/api.<ext>`)의 페이지 확장자 파일은 `.d.ts`를 빼고 모두 API route다. 여기서는 `_`에 특별한 뜻이 없고, 핸들러가 모든 method를 받는다 | `lib/is-api-route.js`, `build/route-discovery.js`, API Routes 문서 |
| Pages Router API route도 `[...x]`와 optional `[[...x]]`를 지원한다(`pages/api/post/[[...slug]].js`는 `/api/post`와 그 아래 경로에 맞는다) | API Routes 문서("Optional catch all API routes"), `server/route-matchers/pages-api-route-matcher.js`(`RouteMatcher` + `getRouteRegex`) |
| 설정 파일은 `next.config.js`, `.mjs`, `.ts` 순서로 찾는다(`.mts`는 런타임이 TypeScript를 지원할 때만) | `shared/lib/constants.js`(`CONFIG_FILES`) |
| `basePath`는 빈 문자열이거나 `/`로 시작하고 `/`로 끝나지 않아야 한다 | `server/config.js` |
| 끝 슬래시: `trailingSlash: false`(기본)면 `/x/`를 `/x`로 308 redirect하고, `true`면 마지막 세그먼트가 `name.ext` 모양이거나 `.well-known` 아래가 아닌 한 `/x`를 `/x/`로 보낸다. `skipTrailingSlashRedirect: true`면 redirect가 없고 매칭은 끝 슬래시를 무시한다 | `lib/load-custom-routes.js`, `server/lib/router-utils/filesystem.js` |
| `proxy.<ext>`·`middleware.<ext>`는 `app`/`pages` 옆(루트 또는 `src/`)에 둔다 | `build/index.js`, `lib/constants.js` |
| 메타데이터 파일(`sitemap`·`robots`·`manifest`·`icon`·`apple-icon`·`opengraph-image`·`twitter-image`·`favicon.ico`)은 framework 라우트를 만든다 | `lib/metadata/is-metadata-route.js` |
| `public/`은 사이트 루트, 루트의 구 규칙 `static/`은 `/static`, 빌드 자산은 `/_next/static`, 이미지 최적화는 `/_next/image`, Pages Router 데이터는 `/_next/data/<buildId>/` 아래로 제공한다. 모두 `basePath` 뒤다 | `server/lib/router-utils/filesystem.js`(`getItem`) |
| `public/`·`static/`·`/_next/static`에서 제공하는 파일은 `GET`·`HEAD`에만 답한다(그 밖은 405) | `server/lib/router-server.js` |
| `i18n`이 있으면 정적 파일을 기본 locale 접두사 아래에서도 찾고, `assetPrefix`가 있으면 `<assetPrefix 경로>/_next/:path+`를 `/_next/:path+`로 rewrite한다 | `server/lib/router-utils/filesystem.js`, `lib/load-custom-routes.js` |
| 라우팅은 가장 구체적인 후보를 고른다(정적 > `[x]` > `[...x]` > `[[...x]]`). 그래서 문서는 `dispatch: "specificity"`다 | `shared/lib/router/utils/sorted-routes.js` |

### 사실을 만드는 규칙

- **내보내기 형태**: `export [async] function GET`, `export const GET = …`, 구조 분해
  (`export const { GET, POST } = handlers`), `export { handler as GET }`, 재내보내기
  (`export { GET } from './impl'`, `export { x as POST } from '…'`). Next는 내보낸 **이름**으로
  고르므로 값이 다른 모듈에서 와도 이름은 확정된다. 타입 전용·`declare` 내보내기는 뺀다.
- **확정할 수 없는 내보내기**는 추측하지 않는다: `export * from '…'`와 CommonJS 할당
  (`module.exports`·`exports.x`·`export =`)은 `route-coverage:`로 센다.
- **Pages Router**: API 파일마다 `ANY` decl 하나, 위치는 `export default`(없으면 첫 CommonJS 내보내기)다.
  정적으로 보이는 기본 내보내기가 없는 파일은 내지 않고 `route-coverage:`로 센다(`pages/api` 아래 둔
  도우미 파일이 출력에 섞이지 않는다).
- **channel**: `basePath` + 폴더 경로의 정규 템플릿. 정적 세그먼트는 `tsograph openapi`와 같은 RFC 3986
  리터럴 정규화를 쓴다(`café` → `caf%C3%A9`). 대괄호와 다른 글자가 섞인 세그먼트(`v[id]`)는 Next.js가
  문서화하지 않았고 라우터와 정규식 생성기가 다르게 해석하므로 `dynamic`과 `route-coverage:`로 낸다.
- **`[[...x]]`**는 `{**}` decl과 catch-all을 뗀 접두사 decl을 함께 낸다(계약의 0세그먼트 펼침). 접두사
  decl은 `catchAllPrefix: true`를 단다(`{**}` decl과 같은 method·symbol·location). isthmus가 이 표식에
  `symbol.usr`를 요구하므로 usr가 없는 CommonJS 핸들러는 표식 없는 접두사 decl을 낸다.
- **trailingSlash**: 위 redirect 규칙으로 한 형태가 정규이면 `strict`(channel은 그 형태), redirect가 없어
  두 형태가 모두 핸들러에 닿으면 `optional`(`skipTrailingSlashRedirect: true`, `.well-known`, 두 redirect에
  모두 걸리지 않는 점 있는 마지막 세그먼트), 파라미터 값에 달렸거나 설정 값이 리터럴이 아니면 생략
  (unknown)한다. `caseInsensitive`는 증명하지 못했으므로 내지 않는다.
- **location**: 내보낸 이름 토큰(`GET`, Pages Router는 `default`)의 1부터 시작하는 줄과 UTF-8 바이트 열.
  앞의 BOM은 3바이트로 센다.
- **symbol.qualifiedName**: `<프로젝트 기준 파일 경로>#<내보낸 이름>`, 예: `src/app/api/items/route.ts#GET`,
  `pages/api/hello.ts#default`.
- **symbol.usr**: 핸들러의 tsograph 그래프 id([심볼 id](#심볼-id)). 이름 있는 기본 내보내기
  (`export default function handler` → `pages/api/hello.ts#handler`, 안쪽 코드가 `handler`에 귀속되므로)를
  빼면 `qualifiedName`과 같다. 별칭·구조 분해·재내보내기(`export { GET } from './impl'`,
  `export const { GET } = h`)는 `<파일>#<내보낸 이름>`을 유지하고, `tsograph graph`가 같은 id의 export 노드와
  실제 선언으로 가는 `alias` 간선을 만든다. CommonJS 핸들러(`module.exports = …`)는 usr가 없고
  `missing-route-usrs:`로 센다.

### 설정과 limitation

`next.config.*`는 정적으로 읽는다: `export default`·`module.exports`·`export =`를 `const` 바인딩,
`satisfies`/`as`, 따라갈 수 있는 전개까지 따라간다. 재할당·속성 변경·`Object.assign` 대상이 된 이름은
따라가지 않는다.

| 상황 | 결과 |
|---|---|
| 설정이 함수·비객체를 내보내거나, 내보내기가 없거나, 구문 오류 | `pathAnchor: "base"` + `unresolved-route-prefix:` |
| `basePath`가 문자열 리터럴이 아니거나 Next.js가 거부하는 값 | `pathAnchor: "base"` + `unresolved-route-prefix:` |
| 설정을 감싼 호출(`withX(config)`) | 안쪽 리터럴 값을 쓰고 `root`, 그리고 `unresolved-route-prefix:`(감싼 함수가 값을 바꾸거나 라우트를 더할 수 있다) |
| `pageExtensions`가 리터럴 문자열 배열이 아님 | 기본 확장자 + `route-coverage:` |
| `rewrites`·`redirects`·`i18n`, 또는 열거할 수 없는 키 | `framework-provided-routes:` |
| `proxy`/`middleware` 파일, 메타데이터 파일, 비어 있지 않은 `public/`·구 규칙 `static/` | `framework-provided-routes:`(합성 decl 없음) |
| `app/`이나 `pages/` 디렉터리가 있음 | `/_next` 엔드포인트의 `framework-provided-routes:` |
| route 파일 위에 `@slot`·intercepting route(`(.)x`) 폴더 | 모델링하지 않음(Next 문서가 페이지에 대해서만 설명), `route-coverage:` |
| `app`·`pages`·`src`·`src/app`·`src/pages`가 symlink | 따라가지 않음(Next는 그 후보를 고르므로 `src/`로 내려가지도 않는다), 위치를 적은 `route-coverage:` |
| `next.config.*`가 symlink | 읽지 않고 `pathAnchor: "base"` + `unresolved-route-prefix:`. 끊어진 symlink는 Next의 `existsSync`처럼 없는 파일로 본다 |
| `package.json`이 symlink | 읽지 않고 `route-framework-version-unknown:` |
| `public/`이나 proxy/middleware 파일이 symlink | 읽지 않되 `framework-provided-routes:` 근거로는 남긴다 |
| Next가 거부하는 세그먼트 이름, 구문 오류, 읽을 수 없거나 크거나 UTF-8이 아닌 파일, 비JavaScript 확장자, symlink(따라가지 않음), 금지 문자가 든 이름, 스캔 상한(항목 200,000개, 깊이 64) | `route-coverage:` |
| `package.json`에 `next`가 없거나 범위가 주 버전 16에 한정되지 않음 | `route-framework-version-unknown:` |
| `app/`·`pages/` 디렉터리가 없음 | 사실 0건 + `route-coverage:` |
| 핸들러를 CommonJS(`module.exports = …`)로 내보냄 | `symbol.usr` 없는 사실 + `missing-route-usrs:` |

서버 측 접두사는 모두 계약의 닫힌 목록에서 쓴다. 그래서 isthmus는 각각을 서버 측 공백으로 읽고
`route-call-without-decl`을 거짓 error 대신 `-unverified`로 내린다. limitation에는 개수와 프로젝트 기준
이름만 싣는다.

**limitation 스코프.** 스코프 없는 한계는 문서의 모든 호출에 적용된다. framework 제공 경로가 받을 수 있는
요청의 상한을 증명할 수 있으면 `limitationScopes` 항목(isthmus "http limitation 스코프")을 더해, 그 안의
호출만 `-unverified`가 되게 한다.

| 한계 | 스코프 | 조건 |
|---|---|---|
| `public/` | `templatePrefixes: [basePath 또는 "/"]`, `methods: ["GET", "HEAD"]` | 설정을 끝까지 확정함(감싼 호출·열거할 수 없는 키 없음, 유효한 리터럴 `basePath`이거나 없음) |
| 구 규칙 `static/` | `templatePrefixes: [basePath + "/static"]`, `methods: ["GET", "HEAD"]` | 위 조건과 `i18n` 없음 |
| `/_next` | `templatePrefixes: [basePath + "/_next"]`(method는 엔드포인트마다 달라 생략) | 위 조건, `i18n` 없음, `assetPrefix` 없음 |

그 밖의 framework 제공 경로(proxy/middleware, 메타데이터 파일, `rewrites`·`redirects`·`i18n`)와 모든
`route-coverage:`·`unresolved-route-prefix:` 공백은 스코프 없이 남는다. `public/`을 파일 목록으로 좁히지
않는 이유는 빌드 단계가 그곳에 파일을 만들 수 있어(서비스 워커, 사이트맵 생성기 등) 저장소의 파일이 제공
파일 전체라는 상한을 증명하지 못하기 때문이다. 그래서 `basePath`가 없으면 `GET`·`HEAD` 호출은 여전히 판정할
수 없고 다른 method는 판정할 수 있다. 스코프 항목은 내기 전에 계약 모양으로 검증한다
(`src/exchange/http-limitation-scope.ts`).

### 결정 사항(초안과 다른 부분)

- **qualifiedName은 내보내기, usr는 그래프 노드.** `<file>#<export>`는 Next.js가 호출하는 모듈 내보내기를
  가리키고, `symbol.usr`는 같은 (모듈 경로, 내보낸 이름) 쌍에서 만든 `tsograph graph`/`reach`/`impact`의
  핸들러 id다.
- **optional catch-all 접두사와 usr.** isthmus는 `catchAllPrefix` decl에 `symbol.usr`를 요구한다. usr가 없는
  CommonJS 핸들러의 접두사 decl은 일반 decl로 낸다. Next.js는 같은 자리의 명시 라우트를 빌드 오류(E458)로
  막으므로 명시 decl과 충돌하지 않는다. 대신 `route-decl-without-call`·드리프트 경고에 나타날 수 있다.
- **감싼 설정은 `root`를 유지한다.** `withX(config)`를 모두 basePath 미상으로 보면 실제 프로젝트 대부분이
  `base`가 된다. 안쪽 리터럴을 쓰고 불확실성은 `unresolved-route-prefix:`로 알린다. 이 limitation이 이미
  거짓 error를 막는다.
- **설정은 프로젝트 루트에서만 찾는다.** Next.js는 부모 디렉터리도 찾는다(`find-up`). `next.config.*`가 있는
  디렉터리를 넘긴다.

### Node 백엔드

확인한 패키지 소스가 붙은 전체 규칙표, 디스패치 모델, 오라클 결과는 [docs/NODE-ROUTES.md](docs/NODE-ROUTES.md)에 있다.
모든 규칙은 npm 패키지(Hono 4.13.12, Express 4.22.3·5.2.1과 path-to-regexp 0.1.13·8.4.2, Fastify 4.29.1·5.12.5와
find-my-way 8.2.2·9.9.0, @koa/router 15.7.0·13.1.1, NestJS 12.1.2)에서 읽었고 `fixtures/node/`의 합성 fixture를 실행해
다시 확인했다.

- **등록**: 모듈 최상위를 순서대로 걷고 라우터를 넘겨받거나 만드는 프로젝트 함수(`registerRoutes(app)`, `createApp()`,
  Fastify 플러그인)를 따라가는 정적 해석기가 모은다. `app.METHOD`·`all`·`on`·`route()` 빌더, 접두사가 붙은
  `use()`·`route()`·`register()` mount, Hono `basePath()`, @koa/router `prefix`, Fastify `prefix`·`fastify-plugin`, NestJS
  `@Controller`·`@Get`…과 `setGlobalPrefix`·URI 버전·`RouterModule`을 다룬다. 값은 `const`·import·열거형·`as const` 객체·
  템플릿 문자열·CommonJS `require`/`module.exports`로 따라간다.
- **경로 문법**: 라우터마다 옮긴다 — Hono 패턴, path-to-regexp 0.1(Express 4)·8(Express 5, @koa/router 14 이상)·
  6(@koa/router 12–13), find-my-way(Fastify, NestJS Fastify 어댑터). 선택 세그먼트는 템플릿 여러 개, 0세그먼트 catch-all은
  `catchAllPrefix` decl, 빈 값을 받는 find-my-way 파라미터는 빈 값 변형, 파라미터 정규식은 `paramConstraints`(`int`·`slug`·
  `regex`)다. 계약 문법으로 쓸 수 없으면 `dynamic`이고, 정적 접두사를 증명하면 `dynamicScope`를 싣는다.
- **디스패치**: Hono·Express·Koa·NestJS(Express)는 먼저 맞는 등록이 받으므로, 이들이 있는 문서는 `registration-order`이고
  `order: {group, index}`를 싣는다(group은 요청을 받는 앱, NestJS는 컨트롤러 하나). 요청을 넘길 수 있는 핸들러(`next`
  매개변수, `@Next()`), 조건부·다른 모듈 등록, exclusive Koa 라우터, NestJS host·헤더 버전 필터는 `order` 없이
  `route-dispatch-order-unknown:`으로 알린다. Fastify·Next.js는 `specificity`이고 섞인 문서에서는 순서 없이 낸다.
- **표식**: `trailingSlash`·`caseInsensitive`는 라우터 옵션을 따른다(Express·Koa 기본은 대소문자 무시·끝 슬래시 선택, Hono·
  Fastify 기본은 strict·대소문자 구분). Fastify `constraints`, Koa `host`, NestJS host·버전 필터는 `narrowed`다.
- **symbol.usr**: 핸들러 본문이 속한 그래프 노드다. 이름 있는 함수·메서드면 그 id(`src/lib/books.ts#listBooks`,
  `src/users.controller.ts#UsersController.findOne`), 인라인 핸들러(감싼 `asyncHandler(async (req, res) => …)` 포함)면
  [인라인 콜백 id](#인라인-콜백-id)(`src/app.ts#<module>.app.get("/users")`)다. 그 핸들러 안의 relation-use도 같은 id라
  trace가 형제 핸들러를 끌어오지 않고 route → 핸들러 → 테이블로 잇는다. 자기 노드를 얻지 못한 인라인 핸들러(계산된 이름
  멤버 안)만 감싼 id를 쓰고 `framework-dispatch-unmodeled:`로 알린다. `tsograph graph`가 이 핸들러를 `route-handler`
  진입점으로 표시한다.
- **limitation**(상한을 증명하면 스코프를 단다): 조건부 등록·계약 밖 동사(`route-coverage:` + 템플릿), 모르는 mount 접두사·
  타입으로만 아는 라우터(`pathAnchor: "base"`와 `templateSuffixes`를 단 `unresolved-route-prefix:`), 정적 파일 미들웨어와
  모르는 패키지 미들웨어·플러그인(붙인 접두사를 단 `framework-provided-routes:`, 정적 파일은 `GET`·`HEAD`), 프로젝트 밖
  핸들러(`missing-route-usrs:`), 확인하지 않은 주 버전(`route-framework-version-unknown:`), 모델링하지 않는 서버
  프레임워크·symlink·크기 초과·구문 오류 파일(`route-coverage:`). `next`를 부르는 미들웨어와 잘 알려진 패키지(cors·helmet·
  본문 파서·Hono 내장·Fastify 공식 플러그인 대부분)는 요청을 넘긴다고 본다. `next`를 받지 않는 `use()` 함수는 끝이 열린
  `ANY` 라우트다(끝의 404 처리기는 제외).

**오라클.** `experiments/node-routes-oracle/run-oracle.mjs <스크래치>`가 fixture마다 스크래치 사본에 npm 레지스트리로 설치하고
실제 프레임워크로 불러와(Hono `app.request`, Express·Koa·NestJS는 127.0.0.1 임시 포트, Fastify `inject`) 요청이 닿는 핸들러와
tsograph 사실이 예측한 핸들러를 대조한다 — 다른 method, 끝 슬래시를 바꾼 경로, 대문자 경로, 프레임워크 자신의 라우트 표로 만든
요청까지. 2026-09-30 기록(`src/routes/node/oracle-replay.test.ts`가 오프라인으로 다시 본다):

| fixture | 프레임워크 | 정밀도(정적 사실) | 재현율(응답한 라우트) |
|---|---|---|---|
| `hono-app` | Hono 4.13.12 | 27/27 | 29/29 |
| `hono-loose-app` | Hono 4.13.12, `strict: false` | 4/4 | 4/4 |
| `express4-app` | Express 4.22.3(CommonJS) | 22/22 | 34/34 |
| `express5-app` | Express 5.2.1(ESM TypeScript) | 14/14 | 13/13 |
| `koa-app` | Koa 3.2.1 + @koa/router 15.7.0 | 18/18 | 18/18 |
| `koa13-app` | Koa 2.16.4 + @koa/router 13.1.1 | 10/10 | 10/10 |
| `fastify5-app` | Fastify 5.12.5 + fastify-plugin | 27/27 | 29/29 |
| `fastify4-app` | Fastify 4.29.1, `ignoreTrailingSlash` | 5/5 | 5/5 |
| `nest-app` | NestJS 12.1.2 + platform-express | 13/13 | 18/18 |

### isthmus로 검증

`fixtures/next/`의 합성 fixture를 isthmus `main` 소비자로 확인했다(이 소비자는 isthmus-cli 0.10.0에 발행됐다):

```sh
tsograph openapi fixtures/next/app-router/openapi.yaml --service demo --project fixtures/next/app-router > contract.json
tsograph routes --role server --project fixtures/next/app-router --service demo > decl.json
# client.json: roles ["client"], 같은 project·service의 사실 0건 문서
node <isthmus>/src/cli/main.ts check contract.json decl.json client.json
```

check는 코드 0으로 끝나고 의도한 드리프트를 보고한다(`GET /api/health`·`PUT /api/items/{}`의
`route-contract-without-decl`, 스펙에 없는 핸들러의 `route-decl-without-contract`).

`fixtures/node/` 문서는 isthmus `2954375`로 확인했다: `check`가 모든 문서를 받고(파라미터 라우트 뒤에 등록한 Hono 리터럴
라우트의 `route-decl-shadowed`, 선언 없는 호출의 error, `dynamicScope` 안 호출의 `-unverified`), `trace`가 핸들러 usr를
`tsograph reach` forward 분석으로 잇는다.

## `tsograph schema`

```sh
tsograph schema --project <root> [--format json]
```

프로젝트의 Prisma 스키마, Prisma Client 사용, Node ORM·SQL 드라이버 사용([Node ORM과 SQL 드라이버](#node-orm과-sql-드라이버)),
SQL 텍스트를 읽어 bridge-facts v1 문서를 표준 출력에 쓴다. `platform: "js"`, `target: "persistence"`(사실이 없으면 `null`), 관찰한 관계·컬럼 참조마다
`relation-use` 사실 하나다. isthmus가 `docs/GRAPH-EXCHANGE.md` persistence 규칙으로
`platform: "sql"` 문서(schemagraph `facts --document <catalog>`)와 조인한다.

- `--project`(필수): 조인 루트. `project`는 그 POSIX realpath이고 모든 `location.path`는 그 기준
  상대 경로다. 심볼릭 링크는 따라가지 않는다.
- 종료 코드: `0` 성공(사실 0건도 성공이며 완전성의 증거가 아니다), `2` 읽을 수 없는 프로젝트·
  사실 100,000개 초과·출력 16 Mi 문자 초과, `64` 사용법 오류. `1`은 예약이다.
- 탐색에서 건너뛰는 것: `node_modules`, `dist`, `build`, `out`, `coverage`, 점 디렉터리, Prisma
  generator 출력 디렉터리, 4 MiB 넘는 파일(개수로 센다). `*.d.ts`는 소스로 파싱하지 않고 Cloudflare D1 바인딩
  선언을 찾을 때만 읽는다.

### 사실

| 원천 | `channel` | `method` | `location` | `symbol.qualifiedName` |
|---|---|---|---|---|
| Prisma `model`/`view` | 해석한 테이블 이름 | — | 모델 이름 | `Model` |
| Prisma 스칼라 필드 | 해석한 테이블 이름 | 해석한 컬럼 | 필드 이름 | `Model.field` |
| 암시적 다대다 | `_<관계 이름>` | —와 `A`, `B` | 첫 관계 필드 | `Model.field` |
| `client.<delegate>` 접근 | 모델의 테이블 | — | delegate 이름 | 감싸는 선언 |
| delegate 호출 인자 | 모델의 테이블 | 컬럼 | 객체 키·문자열 | 감싸는 선언 |
| 원시 SQL(`$queryRaw`·`$executeRaw`·`Prisma.sql`·`…Unsafe`·TypedSQL·대문자 리터럴) | 쓰인 그대로의 관계 | — | SQL 리터럴(TypedSQL은 키워드) | 감싸는 선언 |
| Drizzle 테이블·TypeORM 엔터티·Sequelize 모델 선언 | 해석한 테이블 이름 | —와 해석한 컬럼 | 테이블 이름·클래스·모델 이름, 컬럼 키 | `table`·`table.key`(`Entity`, `Model.attribute`) |
| ORM·드라이버 쿼리(빌더·저장소·모델 메서드·드라이버 SQL) | 해석한 테이블 이름 | 읽었을 때 컬럼 | 테이블 인자·메서드 이름·SQL 인자 | 감싸는 선언 |

채널은 코드·매핑이 쓴 그대로다. 한정됐으면(`@@schema`, `FROM s.t`) `schema.table`, 아니면
비한정이다 — PostgreSQL 기본 스키마는 연결 설정이 정하므로 `public` 같은 값을 추측하지 않는다.
이름 자체에 `.`가 있으면(`@@map("a.b")`, SQL의 `"a.b"`) 한 세그먼트로 `a%2Eb`처럼 escape하고,
`%`는 `%25`로 escape한다.

**심볼 형식.** 소스 사실은 `<프로젝트 기준 POSIX 경로>#<이름>(.<이름>)*`이고 바깥 선언부터 적는다.
함수 선언, 이름 있는 클래스·클래스 식, 메서드, 접근자, 클래스 필드, `constructor`, 이름 없는 default
export(`export default <식>`의 식 포함)의 `default`, 모듈 최상위 변수 또는 함수 값 초기값 안에 사실이 있는 변수
(`src/lib/jobs.ts#listJobs`, `src/repo.ts#Repo.save`, `src/api.ts#handlers.GET`). 호출·`new` 인자로 바로 넘긴
화살표·함수 식(인라인 콜백)은 콜백 식이 속한 스코프 id 뒤에 자기 조각을 붙인다(`src/app.ts#<module>.app.get("/users")`,
`src/lib/jobs.ts#listJobs.items.map()`, [인라인 콜백 id](#인라인-콜백-id)). 그 밖의 이름 없는 함수(JSX 속성 값, 즉시
실행 함수, 조건식 값)는 투명하다. 계산된 이름이 끼면 심볼을 만들지 않고, 모듈 최상위 문장에는 심볼이 없다 — 이런 사실은
`missing-relation-usrs:`(isthmus 체인 전용 접두사, 정보용)로 센다. 스키마 사실은 모델 이름(`Job`, `Job.title`), TypedSQL 사실은
`<경로>#<파일 이름>`이다.

소스 사실은 `qualifiedName`과 같은 값의 `symbol.usr`도 싣는다. 감싸는 선언의 tsograph 그래프
id([심볼 id](#심볼-id))라서 `tsograph reach` 출력과 relation-use 사실을 정확한 문자열 일치로 이을 수 있다.
스키마 선언 사실과 TypedSQL 사실도 안정 usr를 싣지만, 그래프 노드가 **아닌** 이름공간을 쓴다:
`<스키마 경로>#model:<Model>`·`#model:<Model.field>`(예: `prisma/schema.prisma#model:Job`,
`prisma/schema.prisma#model:Job.title`, 암시적 다대다 조인 테이블은 `#model:Book.tags`)와
`<sql 경로>#typedsql:<이름>`. Node ORM 선언은 선언 소스 파일을 경로로 삼아 같은 `#model:` 이름공간을 쓴다
(`src/db/schema.ts#model:users`, `src/entities/user.ts#model:User.email`, `src/models/post.js#model:BlogPost.authorId`) —
isthmus capture에 새 표식이 필요 없다. 선언 측 사실이라 어떤 순회에도 나오지 않으며, isthmus `trace`는 모든 순회에 없는
id를 "심볼 없음"이 아니라 "닿지 않음"으로 읽는다.

### Prisma 스키마 위치(Prisma 7.8.0 CLI 규칙)

프로젝트 루트, `prisma.config.*`가 있는 디렉터리, `prisma`·`@prisma/client`에 의존하는
package.json이 있는 패키지마다:

1. `prisma.config.{js,ts,mjs,cjs,mts,cts}`, `.config/prisma.*`, `.config/prisma.config.*` 중 첫
   설정 파일. default export(`defineConfig({...})`, 객체 리터럴, 같은 파일 `const`)의 `schema`가
   문자열 리터럴일 때만 읽는다. 디렉터리면 다중 파일 스키마이고 그 아래 `.prisma`를 재귀로 모두 읽는다.
2. `schema`가 없으면 `<기준>/schema.prisma`, 그다음 `<기준>/prisma/schema.prisma` 한 파일.
3. package.json `"prisma": { "schema" }`는 설치된 Prisma가 6.x 이하일 때만 쓴다(7.x는 읽지 않는다).

리터럴이 아닌 설정 값(`path.join(...)`, 환경 변수)은 추측하지 않는다: `unresolved-prisma-config:`.
설정한 경로가 없으면 `missing-prisma-schemas:`.

### Prisma 이름 규칙

고정 버전의 Prisma 소스로 확인했다(`@prisma/internals@7.8.0`이 고정한 prisma-engines 커밋,
`@prisma/client-generator-ts@7.8.0`, `@prisma/client-common@7.8.0`,
`@prisma/orm-family-sql@8.0.0-rc.1`–`rc.12`).

- **테이블**: `@@map` 값, 없으면 모델 이름 그대로(`psl/parser-database/src/walkers/model.rs`
  `database_name()`). `@prisma/orm-family-sql` 8.0.0-rc.1–rc.11은 첫 글자를 소문자로 바꾸고
  (`lowerFirst(model.name)`), rc.12가 모델 이름 그대로로 되돌렸다(`defaultTableName`, 릴리스 노트).
- **컬럼**: `@map` 값, 없으면 필드 이름(`walkers/scalar_field.rs`, 8.x도 같다).
- **스키마**: `@@schema("s")`가 테이블을 한정한다(6.13부터 GA, PostgreSQL·CockroachDB·SQL Server).
  없으면 비한정이다.
- **암시적 다대다**: 테이블은 `_` + 관계 이름. 기본 관계 이름은 두 모델 이름을 코드 포인트 순
  (대문자가 소문자보다 앞)으로 이은 `<A>To<B>`, `@relation("Name")`이면 `_Name`, 컬럼은 `A`·`B`,
  스키마는 모델 `A`의 스키마다. 63자를 넘는 이름은 잘림 규칙을 추측하지 않고 dynamic으로 낸다.
  Prisma 8 네이티브 PSL에는 암시적 다대다가 없다.
- **내지 않는 것**: 관계 필드, `@ignore` 필드, `@@ignore` 모델(클라이언트에 없다), composite `type`,
  datasource provider가 `mongodb`인 모든 모델(`non-relational-stores:`). `Unsupported("…")` 필드는
  컬럼이라 낸다.
- **클라이언트 delegate**: 모델 이름의 첫 글자만 소문자(`uncapitalize`). 런타임이 모델 이름 그대로의
  키도 받으므로 그것도 인정한다.

**버전 선택.** 잠금 파일(`pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
`yarn.lock`, `bun.lock`)에서, 잠금 파일이 Prisma를 담지 않으면 package.json의 정확한 버전·`^`·`~`
명세에서 읽는다. `prisma`·`@prisma/client` 2.x–7.x는 Prisma 7 규칙, `@prisma/orm-family-sql`은 8.x
규칙을 고른다(8.x `prisma` 패키지는 다른 CLI라 무시한다). 버전을 모르거나 확인하지 않은 버전
(예: rc.13 이상, 8.0.0)이거나 규칙이 여럿 설치됐으면 후보 규칙을 모두 평가해, 같은 이름은 내고 갈리는
이름은 컬럼 없는 dynamic 사실로 내며 `prisma-naming-unverified:`를 싣는다. Prisma 8 contract 파일과
클라이언트 API는 읽지 않는다(`prisma-8-surface-unscanned:`).

### Prisma Client 사용

수신자의 출처가 구문으로 증명될 때만 클라이언트로 본다. 타입 검사기를 돌리지 않고 아무것도
실행하지 않는다.

- `@prisma/client`(`/edge`·`/wasm` 등), `.prisma/client`, generator `output` 디렉터리(스키마 파일 기준,
  상대 경로·tsconfig/jsconfig `paths`로 맞추며 생성물이 커밋되지 않았어도 된다)에서 가져온
  `PrismaClient`의 `new PrismaClient(...)`
- `PrismaClient`·`Prisma.TransactionClient`, 그 지역 별칭, `Omit/Pick/Readonly/NonNullable/Required<…>`,
  교차 타입, `typeof client`, 이를 상속한 인터페이스로 표기한 선언, 그리고 반환 타입(또는 `Promise<…>`)을
  그렇게 표기한 함수
- 한쪽이 클라이언트인 `a ?? b`·`a || b`(`globalThis.prisma ?? new PrismaClient()`),
  `client.$extends(...)`, `client.$transaction(async (tx) => …)` 콜백의 첫 매개변수, 클래스 필드와
  생성자 매개변수 속성(`this.db`)
- 파일 사이 바인딩: 이름·default·이름공간 import, 재수출, `export *`, CommonJS
  `require`·`module.exports`, `await import(...)`. TypeScript 모듈 해석기와 가장 가까운
  `tsconfig.json`/`jsconfig.json`(프로젝트 안으로 제한)으로 풀고 고정점까지 반복한다.

지역 변수·매개변수는 바깥 클라이언트를 가린다. 출처를 추적하지 못한 수신자의
`x.<delegate>.<operation>(...)` 모양 호출은 내지 않고 `unresolved-client-receivers:`로 센다. 증명된
클라이언트의 모르는·계산된 delegate(`prisma[name]`)는 dynamic 사실이다.

컬럼 사실은 delegate 호출 객체 리터럴의 `select`·`omit`·`where`·`data`·`cursor`·`create`·`update`·
`orderBy` 최상위 키와 `distinct`·`by` 문자열 중, 그 모델의 스칼라 필드인 것만 낸다.

### SQL 텍스트

SQL은 가족 공유 어휘 추출기(dartograph `sql_relations.dart`·cartograph `SqlRelations.swift`를 한
줄씩 옮기고 같은 벡터로 검증한 포트)로 읽어, 같은 SQL이 생산자와 무관하게 같은 관계가 된다.

- `$queryRaw`·`$executeRaw` 태그 템플릿과 `Prisma.sql` 조각: 보간은 바인드 파라미터라 `?`
  플레이스홀더로 바꾼다. 중첩 `Prisma.sql`, `Prisma.raw('리터럴')`, `Prisma.empty`는 펼친다. 관계 자리의
  플레이스홀더(`FROM ${table}`)는 미해석 피연산자라 dynamic 사실 하나를 더한다.
- `$queryRawUnsafe`·`$executeRawUnsafe`: 문자열 리터럴·같은 파일 `const`는 읽고, 보간 템플릿과 그 밖의
  식은 dynamic 사실이다(가족 규칙).
- TypedSQL: generator가 `typedSql` preview를 켜면 설정 `typedSql.path` 또는 `<스키마 루트>/sql`의
  최상위 `.sql` 파일을 읽는다.
- 그 밖의 문자열 리터럴은 SQL 동사와 관계 키워드가 대문자일 때만 읽는다(strict). 소문자 SQL처럼 보이는
  리터럴은 `skipped-sql-literals:`로 센다.

### Node ORM과 SQL 드라이버

이름 규칙·출처·오라클은 [docs/PERSISTENCE.md](docs/PERSISTENCE.md)에 있다. 요약:

- **해석.** 프로젝트 소스만 담은 TypeScript Program(lib·`node_modules` 없음, 프로젝트 안 모듈 해석)의 심볼 해석만
  쓴다. 아무것도 실행하지 않고 추론한 타입도 쓰지 않는다. 패키지 값은 import 지정자와 이름으로 식별한다. 수신자는
  출처(초기값, 반환 값, 타입 표기와 그 멤버, 데코레이터, 콜백 매개변수, import·CommonJS `require`·`module.exports`)를
  증명했을 때만 인정한다. 지원 패키지를 import하거나 `D1Database`를 언급하는 소스가 없으면 이 단계를 건너뛴다.
- **Drizzle**(drizzle-orm 0.45.3): 테이블은 쓴 그대로(`pgTable`·`sqliteTable`·`mysqlTable`·뷰·`pgSchema().table`·
  정적으로 계산되는 `pgTableCreator`). 컬럼은 빌더 이름, 없으면 객체 키 — 모든 `drizzle()` 호출과 `drizzle.config.*`의
  `casing`(`snake_case`·`camelCase`)이 같을 때만 변환한다. 사용: 테이블 인자의 `from`·`insert`·`update`·`delete`·조인·
  `$count`, `t.column`, `.values()`·`.set()` 키, `columns`·`with`(`relations()` 경유)가 있는
  `db.query.<key>.findMany/findFirst`, `sql` 템플릿.
- **TypeORM**(1.1.1·0.3.31): `@Entity` 이름 또는 `snakeCase(클래스)`, `entityPrefix`, 스키마; 컬럼 `name` 또는 속성;
  임베디드 접두사; 조인 컬럼 `camelCase(속성_참조)`; 조인 테이블 `snakeCase(소유_속성_대상)`과 `camelCase(테이블_주키)`
  컬럼. 사용자 `namingStrategy`면 명시 이름만 남긴다. 사용: 저장소, ActiveRecord 엔터티, 엔터티 인자의 EntityManager
  호출, QueryBuilder 엔터티·별칭, `query(sql)`.
- **Sequelize 6**(6.37.8, inflection 1.13.4): `tableName`, 없으면 `modelName`(freeze) 또는
  `underscoredIf(pluralize(modelName))`; `field` 또는 `underscoredIf(속성)`; 자동 `id`·타임스탬프; 연관 외래 키와 문자열
  `through` 조인 테이블. 사용: 모델 메서드, `include`, `where`·`attributes`·값 키, `sequelize.query(sql)`.
- **knex**(3.3.0): `knex('t')`, `from`·`into`·`table`·조인(`'t as a'`, `{ a: 't' }`, `withSchema`), 한정했거나 테이블이
  하나인 사슬의 컬럼, `knex.raw(sql)`. `knex.schema` DDL은 무시한다.
- **원시 드라이버와 D1**: 증명한 클라이언트의 `query`·`execute`·`prepare`·`exec`·`run`·`all`·`get`·`each` SQL, libSQL
  `batch`, `postgres`·`neon`·`@vercel/postgres` 태그 템플릿, D1 바인딩(`D1Database`로 선언된 속성의 `env.DB` —
  `.d.ts` 포함 — 과 `D1Database` 표기). 게이트가 받은 보간 템플릿 문자열은 원문에 이름으로 쓴 관계와 dynamic 사실
  하나를 낸다.

모든 규칙은 `experiments/orm-naming-oracle`이 검증한다: 합성 fixture를 실제 라이브러리로 실행해(sql.js의 drizzle-kit
DDL, TypeORM `sqljs` synchronize, pg-mem의 Sequelize, knex `toSQL()`) 이름을 기록하고, `src/schema/orm/oracle.test.ts`가
오프라인으로 대조한다(기록 시점 100% 일치).

### 지원 표면 밖

Kysely, Objection, MikroORM, pg-promise, sequelize-typescript 모델, `sqlite` 래퍼, MSSQL, Oracle, slonik의
쿼리는 해석하지 않는다. 이를 쓰는 파일 수를 `unsupported-db-packages:`로, Mongoose·MongoDB·DynamoDB·Firebase·
Redis는 `non-relational-stores:`로 센다. 그 파일의 대문자 SQL 리터럴은 여전히 SQL 텍스트로 읽는다.

### limitation 접두사

`prisma-schema-not-found:`, `unresolved-prisma-config:`, `missing-prisma-schemas:`,
`schema-outside-project:`, `non-relational-stores:`, `prisma-naming-unverified:`,
`prisma-8-surface-unscanned:`, `unparsed-schema-lines:`, `unresolved-field-types:`,
`ignored-prisma-elements:`, `unresolved-generator-outputs:`, `unresolved-typed-sql:`,
`unsupported-db-packages:`, `dynamic-relation-names:`, `skipped-sql-literals:`,
`unresolved-client-receivers:`, `unresolved-orm-receivers:`, `orm-naming-unverified:`,
`unreadable-orm-declarations:`, `provenance-truncated:`, `missing-relation-usrs:`,
`invalid-relation-names:`, `unreadable-sources:`, `oversized-sources:`, `parse-errors:`,
`unreadable-module-configs:`, `skipped-symlinks:`, `scan-truncated:`. 모두 호출 측 한계라 isthmus가
심각도를 바꾸지 않으며, 조인하지 못한 dynamic 사실은 isthmus가 직접 센다(`unjoined-dynamic-relations`).

### 카탈로그와 조인

schemagraph는 DDL 파일을 직접 읽지 않으므로, Prisma 마이그레이션 폴더의 카탈로그는 임시
데이터베이스에서 모은다. `prisma/migrations/*/migration.sql`을 버릴 PostgreSQL에 순서대로 적용한 뒤:

```sh
schemagraph scan "postgres://…/scratch" --source-id prisma-migrations --emit-document catalog.json -o graph.json
schemagraph facts --document catalog.json --project <root> -o sql-facts.json
tsograph schema --project <root> > js-facts.json
isthmus check --pairs js-facts.json sql-facts.json
```

`fixtures/schema/prisma-app`은 자체 마이그레이션을 가진 합성 프로젝트다. 이렇게 조인하면 오류가 없다
(`@@ignore` 모델에 대한 예상된 `relation-decl-without-use-unverified` 경고 하나).

`fixtures/schema/drizzle-d1-app`(Hono·Drizzle·원시 D1 SQL)은 마이그레이션으로 만든 SQLite 카탈로그와 조인한다
(`sqlite3 app.db < migrations/0000_init.sql`과 `0001_audit.sql` 뒤 `schemagraph scan "sqlite:app.db" …`): 오류·경고 없이
관계 5개와 컬럼 14개가 짝지어진다. 라우트 핸들러가 이름 있는 함수면 `tsograph reach`와
`schemagraph impact --format language-traversal`로 `isthmus trace`가 라우트에서 테이블과 DB 의존자까지 잇는다
([docs/PERSISTENCE.md](docs/PERSISTENCE.md#isthmus와-잇기)).

## `tsograph graph`, `tsograph reach`, `tsograph impact`

```sh
tsograph graph  --project <root> [--generated-at <timestamp>] [--format json]
tsograph reach  --project <root> [--max-depth <n>] [--max-reached <n>] [--dispatch direct|bound|candidates] [--generated-at <timestamp>] [--format json] <id>...
tsograph impact --project <root> [--max-depth <n>] [--max-reached <n>] [--dispatch direct|bound|candidates] [--generated-at <timestamp>] [--format json] <id>...
```

TypeScript 컴파일러 API로 프로젝트의 TypeScript/JavaScript 호출 그래프를 만든다(루트 `tsconfig.json`,
없으면 `jsconfig.json`, 둘 다 없으면 번들러식 기본값 위의 `Program`·`TypeChecker`, `allowJs`는 항상 켠다).
분석 대상 코드는 실행하지 않고 진단도 계산하지 않는다.

- `graph`는 `tsograph-graph` v1 스냅샷(tsograph 자체 형식, isthmus 입력 아님)을 낸다: `nodes`(`id`·`kind`·
  `location`·선택 `entries`·선택 `unresolvedCalls`), `edges`(`from`·`to`·`kinds`·`evidence`), `statistics`,
  `limitations`, `graphRevision`, 읽을 수 있으면 `revision`. 스냅샷은 모든 근거 등급을 나타낸다
  ([인터페이스 디스패치](#인터페이스-디스패치boundcandidate-간선) 참고): 심볼 쌍마다 근거 등급별 간선은 많아야 하나이고,
  같은 쌍의 더 강한 간선들이 종류를 모두 덮는 약한 간선은 어느 모드의 순회도 바꾸지 못하므로 뺀다. 노드
  `unresolvedCalls`는 상한 없는 정확한 수다.
- `reach`는 root id에서 닿는 심볼(`direction: "dependencies"`), `impact`는 root에 닿는 심볼
  (`direction: "dependents"`)을 isthmus
  [`language-traversal` v1](https://github.com/ictechgy/isthmus/blob/main/docs/LANGUAGE-TRAVERSAL.md)로 낸다.
- id는 [심볼 id](#심볼-id)다. `tsograph routes`·`tsograph schema` 출력의 `symbol.usr`와 같은 문자열이다.
  중복 id는 처음 나온 순서로 한 번만 둔다(그 순서가 `reached[].roots` 인덱스의 뜻이다).
- **그래프 노드가 아닌 root**는 cartograph·kartograph처럼 계약의 `root-not-found` 규칙을 따른다. 나머지 root로 문서를
  그대로 내고, 그런 id는 요청한 자리의 `roots` 항목에 원문 `id`만 두고 **`symbol`을 싣지 않는다**(isthmus `trace`는
  symbol이 있는 root만 잇는다). 문서에는 `truncated: true`, `truncationReasons`의 `root-not-found`, `root-not-found:`
  limitation 하나를 단다. 그리고 **문서를 출력한 뒤 `64`로 끝나며** 표준 오류에 id 목록을 알린다 — 종료 코드를 보는
  파이프라인은 오타에 여전히 멈추고, 부분 순회를 받는 호출자(예: `acceptExitCodes: [0, 64]`를 준 isthmus capture)는 문서를
  읽는다. 순수 사용법 오류는 표준 출력이 비어 있어 구별된다. 그래프 노드인 root가 하나도 없으면 `reached`가 빈 문서다.
  limitation과 표준 오류는 두 종류를 구별한다: `#model:`·`#typedsql:` [선언 id](#사실)는 어떤 순회도 닿지 않는 것으로
  이미 아는 비노드 id이고(순회 root에서 빼면 된다), 그 밖은 모르는 id다. 형제 생산자처럼 strict 옵션은 따로 없다.
- 종료 코드: `0` 성공, `2` 프로젝트를 읽을 수 없거나 출력이 16 Mi 문자를 넘음(문서 없음), `64` 사용법 오류(표준 출력 비어
  있음) 또는 root-not-found(문서 출력).

### 노드와 간선

노드는 프로젝트 자체 소스 파일에서만 만든다(`tsograph schema`와 같은 걷기 규칙, Prisma generator 출력 제외,
모든 라우트 파일 포함). `node_modules`·TypeScript lib·생성 클라이언트의 선언은 노드가 아니고, 그리로 가는
호출은 외부로 센다.

| 노드 종류 | 뜻 |
|---|---|
| `module` | `<경로>#<module>`: 최상위 문장과 이름 있는 선언 밖의 코드 |
| `function`·`method`·`constructor`·`accessor`·`class`·`field`·`variable` | 심볼 id 규칙이 이름 붙이는 선언(함수 값 변수·객체 속성·[인라인 콜백](#인라인-콜백-id)은 `function`) |
| `export` | 그 자체가 선언이 아닌 내보내기(별칭·재내보내기·구조 분해) |

| 간선 종류 | 뜻 |
|---|---|
| `call` | 직접 호출(태그 템플릿·데코레이터·`super(...)` 포함) |
| `new` | `new C()` → 본문 있는 생성자, 없으면 클래스 노드 |
| `callback` | 함수 값을 인자로 넘김(`items.map(format)`, `withAuth(handler)`) |
| `reference` | 그 밖의 함수 값 참조(`export default handler`, `{ onClick: h }`, `action={fn}`) |
| `jsx` | JSX 컴포넌트(`<JobList />`) |
| `alias` | export 노드 → 해석한 선언 |
| `initializer` | 생성자·클래스 → 인스턴스 필드 초기값, 생성자 없는 파생 클래스 → 기반 생성, 모듈 스코프 → 최상위 변수 초기값·static 필드 |
| `contains` | 인라인 콜백을 어휘적으로 담은 노드 → 콜백 노드(`<경로>#<module>` → `<경로>#<module>.app.get("/users")`). 콜백을 부르는 쪽(`app.get`, `items.map`)은 대개 외부라, 이 간선이 담은 노드에서의 도달과 콜백 안에서의 역방향 영향을 잇는다. 콜백이 실제로 실행되는지는 증명하지 않는다. 인라인 콜백에 노드가 없던 때는 그 코드가 담은 노드에 귀속했으므로 도달 집합은 같다 |

호출은 checker 심볼로 모듈을 넘어 잇는다: named/default/namespace import, 재내보내기(`export *` 포함),
경로 별칭, 값 별칭(`const h = g`), 구조 분해(`const { GET } = handlers`, `const { f } = await import('./m')`),
객체 리터럴 멤버. 추측하지 않는다.

- 인터페이스·타입 리터럴 시그니처로 부른 메서드는 수신자가 `new C()`·객체 리터럴로 초기화된 `const` 변수나
  `readonly` 필드일 때만 `direct`로 잇는다(그때 구현이 증명된다). union 수신자는 본문 있는 멤버를 모두 잇고,
  증명하지 못한 부분은 `partial-dispatch:`로 센다. 남은 인터페이스 호출은
  [인터페이스 디스패치](#인터페이스-디스패치boundcandidate-간선)가 추측 대신 `bound`·`candidate` 간선으로 잇는다.
- 하위 클래스가 재정의한 메서드 호출은 정적으로 해석한 선언에만 잇고 `overridden-methods:`로 센다.
- 매개변수·`any`·계산된 호출 대상·함수가 아닌 값·풀리지 않는 프로젝트 import를 거친 호출은 간선 없이
  `unresolved-calls:`에 이유별로 센다.
- 닫힌 callback 매개변수, 프로젝트 함수가 반환한 지역 callback, 안전하게 읽은 이름 있는 메서드는
  호출 가능 값 흐름으로 증명해 `bound` 근거로 잇는다. 닫힌 프로젝트 함수 선언(본문 하나)에
  화살표·함수 식 callback을 직접 넘긴 경우에는 그 함수의 callback 직접 호출 인자도 읽으며, 반환된
  closure 안의 호출도 따른다. 팩터리가 받는 callback 매개변수는 단순 식별자여야 하며
  기본값·나머지·대입·탈출 참조가 없어야 한다. 인자 위치를 가리는 전개도 미해석으로 둔다. callable 흐름은 전부 증명해야 하므로
  객체와 함수가 섞이거나 모르는 값이 있으면 원래 공백을 남기고 타입 후보를 열거하지 않는다.
- 타입 선언을 찾지 못한 패키지(의존성 미설치, 타입 없는 패키지)를 거친 호출은 외부이고
  `missing-dependencies:`로 센다.
- 모듈 스코프는 import하는 쪽에서 잇지 않는다(import 시점 부수 효과는 `<module>` 노드에 남는다).

### 인터페이스 디스패치(bound·candidate 간선)

모든 간선은 근거 등급 `evidence`를 싣는다. 등급은 포개진다: `direct` 그래프 ⊂ `bound` 그래프 ⊂ `candidate` 그래프.

| `evidence` | 뜻 |
|---|---|
| `direct` | checker 심볼(또는 위의 수신자 고정 초기값)로 대상을 증명했다. |
| `bound` | 인터페이스·구조 타입 수신자 호출(`this.deps.store.findItem()`, `repository.save()`)이나 닫힌 callable 값 호출(`invoke(callback)`, `make()()`)이고, 스캔한 프로젝트 안에서 관찰한 수신자·호출 가능 값이 모두 본문 있는 프로젝트 구현·호출 가능 선언으로 해석된다. 대상마다 `bound` 간선 하나(같은 쌍의 더 강한 간선이 이미 덮으면 뺀다 — 스냅샷 규칙). |
| `candidate` | 흐름을 다 증명하지 못해, 구현할 수 있는 프로젝트 클래스·객체 전부로 잇는다: 수신자 인터페이스를 `implements`로 선언한 클래스(직접, 기반 클래스, 확장 인터페이스를 거쳐), 그리고 타입이 수신자 타입에 대입 가능한 클래스·객체 리터럴(`TypeChecker.isTypeAssignableTo`, 고정한 TypeScript 5.9.3의 공개 API, 타입 매개변수 수신자는 제약 타입). 과대 근사다. |

`bound` 값을 구하는 방법(전체 프로그램, 문맥·경로 비민감): `new C(...)`, 객체 리터럴, `this`(감싼 클래스와
프로젝트 하위 클래스), 변수 초기값과 모든 대입, 매개변수(기본값과, 함수 선언·`const`에 담긴 함수·생성자의 모든
호출 위치의 같은 자리 인자 — `super(...)`와 생성자 없는 하위 클래스의 암묵 `super` 포함), 객체 구조 분해, 객체
리터럴·클래스 인스턴스의 속성(초기값·매개변수 속성·getter 반환값, 그리고 쓰기 수신자 타입에 그 값이 올 수 없는 경우를
뺀 모든 같은 이름 속성 쓰기 — 쓰기 수신자 식의 흐름이 알려져 있고 비어 있지 않으며 그 값(클래스면 프로젝트 하위 클래스
인스턴스 포함)을 담지 않을 때만 뺀다. 구조적 대입, 공통 상위 타입을 거친 배열 공변성, 메서드 매개변수 이변성 때문에
형변환 없이도 어느 타입 자리에든 값이 들어갈 수 있어 타입만으로는 빼지 않는다), 호출한 함수의 반환 값(인터페이스 타입 팩터리는 수신자
값으로 푼다), `await`·`?:`·`??`·`||`·`&&`·쉼표 연산자. 호출·속성을 거쳐 자기 자신에게 흘러드는 자리
(`this.store = this.store.withCache()`, 재귀 래퍼)는 고정점까지 되풀이한다. `new ItemHandler({ store: new SqlItemStore(client) })`,
`createLookup({ store })`, `new ItemService(sql)`, 기본 매개변수 DI(`store: ItemStore = new MemoryItemStore()`),
팩터리로 만든 모듈 싱글턴 같은 조립 지점을 모듈을 넘어 따라간다.

반사 대상이 모르는 경우에만 반환 의존성 컨테이너의 identity를 좁게 증명한다. 이름이 있고 안정적이며 닫힌
프로젝트 `FunctionDeclaration`이 동기·비제너레이터로 반환한 객체 리터럴이 정적 own-data 속성만 가지면
무관한 모르는 반사 대상과 분리할 수 있다(전개·계산 키·메서드/접근자·`__proto__`·`then`은 거부). 팩터리의
모든 사용은 호출 결과를 단순한 한 단계 객체 구조 분해로 바로 받거나, 안정한 wrapper의 직접 식별자 호출에
팩터리를 정확한 인자로 넘겨 그 wrapper 매개변수가 같은 투영만 해야 한다. 앞쪽 전개, optional/default/rest
또는 대입된 매개변수, 전달·전체 객체 alias/반환/인자 전달, lexical `arguments`, 열린 속성·opaque import,
async/generator 팩터리는 계속 모름이다. 알려진 반사 대상은 항상 막고, 이 예외는 구조적 타입의 비겹침을
사용하지 않는다. named import는 허용하지만 namespace/member와 괄호로 감싼 함수 호출은 의도적으로 미룬다.

같은 external-module 파일의 private cache 리터럴도 같은 증명을 쓸 수 있다. 최상위 `let` 슬롯 하나의
초기값이 없거나 `null`, shadow되지 않은 전역 `undefined`이고, 리터럴을 버리는 직접 `memo =` 또는
`memo ??=` 표현문 대입으로 정확히 한 번만 만들 때만 허용한다. 안정한 닫힌 named 함수는 그 슬롯을
반환할 수 있고, 다른 슬롯 읽기는 `memo`, `!memo`, `null`/전역 `undefined`와의 동등·부등 비교인 좁은
조건 guard여야 한다. 버리는 `memo = null`/전역 `undefined` 초기화는 허용하지만 export, 전체 객체 사용,
멤버 읽기, setter, 복합·논리 대입, 추가 객체 대입은 계속 모름이다.

관찰한 mutation은 연산·수신자·키·값/source/descriptor·prototype 인자를 내부 색인에 보존한다.
`Object.setPrototypeOf`, `Reflect.setPrototypeOf`, `__proto__` 쓰기는 해당 수신자의 증명을 무효화한다.
mutator 값 탈출·불완전한 별칭과 `__defineGetter__`/`__defineSetter__`는 opaque mutation으로 남긴다.
declaration file이나 무관한 키 이름만으로 부수효과가 없다고 판단하지 않는다.

좁은 생성자 carrier 증명은 정확한 의존성 객체 리터럴을 모르는 반사 대상과 분리할 수 있다. 닫힌 비내보내기
프로젝트 클래스, private readonly 매개변수 속성, 완전한 instance 소비·projection 감사와 로컬로 증명한
mutation 효과가 필요하다. optional Date callback도 명시적인 own data 속성으로 있어야 한다. genuine
`undefined`·`null`은 기본값 선택을 증명하며, 정확히 감사한 Date 화살표도 직접 공급할 수 있다. 누락된 키는 `toString`·
`constructor` 같은 상속 속성이 기본값 호출을 막을 수 있어 미해석으로 남긴다. cast와 optional 타입은
런타임 부재의 근거가 아니다. 초기 carrier 메서드는 runtime 매개변수가 없어야 하며, 허용하는 instance 호출도
인자가 없어야 한다. 감사한 wrapper의 필수 identifier 전달만 유지하고, default나 암묵적 `arguments` 누출은
증명하지 않는다. default/rest/구조 분해
매개변수·decorator·async/generator 실행 및 증명하지 못한 암묵적·coercion 평가도 불확실성을 유지한다.
매개변수 속성의 저장·인스턴스 필드·메서드 slot의 충돌과 setter 가로채기는 class-field emit 옵션과 독립적으로
감사한다. TypeScript private/readonly 자체는 런타임 소유권 근거가 아니다. instance/bag 탈출, 별칭, accessor,
상속, 위험한 callback과 증명하지 못한 mutation 수신자는 계속 미해석이다. 과거 허용했던 optional 누락이나
감사하지 않은 진입 효과도 candidate 또는 미해석으로 바뀔 수 있다. private primitive object/array literal의
기존 own data slot 쓰기만 완전한 사용 감사 안에서 무관한 mutation으로 분리할 수 있다. 배열 타입·spread 배열·
임의 factory·`map().sort().map()`은 이 증명이 아니다.

일반 선언 메서드의 target identity는 carrier 필드·bag 격리와 따로 검사한다. 진입·인자가 inert한 동일 클래스의
직접 메서드 호출은 반환하거나 불변 지역 변수에 저장할 때 target을 유지할 수 있다.
`const result = await this.method(value); return result`도 메서드 조회가 suspension보다 먼저 일어난다.
수신자 생성도 교체 객체 반환·instance 탈출 없이 별도 진입·저장 감사를 통과해야 한다.
호출 뒤의 결과 처리는 이후의 보호된 사용을 인증하지 않는다. 조회 전에 모르는 callback·의존성 호출·
이전 suspension이 있으면 계속 미해석이며, Date 타입 필드 자체는 부수효과가 없다는 증명이 아니다.
carrier 상속 클래스는 실제 subclass 생성자 증명이 필요해 이번 릴리스에서 보수적으로 남긴다.
일반 wrapper·factory에 격리 자격을 주지 않으며, 정확한 비공개 단일 속성 holder를 감사한 직접 호출로만
소비하는 경우에만 기존 일반 수신자 경로를 유지한다.
수신자 증명은 여전히 정확한 생성자 bag 리터럴과 class 값의 전체 사용 감사를 요구하므로, bag 변수나
추가 `instanceof` 사용은 미해석으로 남긴다. 완료된 carrier 증명이 인정한 memo 투영·wrapper callback의
메서드 target은 유지한다. 일반 메서드 복구는 현재 메서드의 조회 뒤를 포함해 클래스 전체의 보호된
`this` 소비를 감사한다. 뒤의 탈출도 다음 호출의 target을 바꿀 수 있기 때문이다. 보호된 `this`를 받지 않는
호출 뒤 결과 처리는 계속 지원한다.

private 최상위 `const registry = new Map()`은 실제 TypeScript default library의 생성자/API 선언과 mutation 범위를
확인한 경우 `get`으로 프로젝트 factory 값을 전달한다. 직접 `get/set/has/delete/clear/keys`와 readonly `size`만
허용하고 `set` 결과는 버려야 한다. 별칭·export·인자 전달·반사·computed/detached/optional 호출·chaining·`forEach`·
`values`·`entries`는 opaque다. 모르는 키는 모든 등록 값을 포함하며, 정확한 primitive literal·immutable const 별칭·
조건식 합집합만 키 일치를 좁힌다. Map은 primitive 종류를 구분하고 `-0`과 `0`을 같게 본다. symbol/object/enum/call
유래 키는 추측하지 않는다. delete/clear 후에도 문맥 비민감 분석의 가능한 값은 보존하고 iterator 결과는 opaque다.

호출 가능 값도 같은 흐름 엔진을 쓴다. 함수 선언·함수 값 초기화와 관찰한 대입, 닫힌 callback 매개변수와 익명 인라인
callback의 직접 호출, 함수·getter 반환값, 생성자 대입·기본값, 안전하게 읽은 객체·클래스 메서드를 따라간다. 인라인
callback은 직접 호출 인자이면서 본문이 하나인 닫힌 프로젝트 함수 선언에서만 연결한다. 이름 있는 함수 식,
callback 매개변수 대입·탈출, 전개, 열린·프로젝트 밖 팩터리, 모르는 호출 인자는 미해석으로 둔다. 함수 객체 속성,
데코레이터·증명할 수 없는 몽키 패치 메서드, 반사적 쓰기, 열린 export·진입점, 모르는 값도 미해석으로 둔다. callable
증명에 실패하면 원래 `parameter`·`indirect`·`computed` 이유를 유지하고 candidate 간선을 만들지 않는다. 이 범위 안에서
닫힌 wrapper가 `make()` 같은 callable 매개변수를 부를 때도 그 흐름이 프로젝트 함수 본문으로 전부 증명되면 따른다.
알려진 값과 모르는 값의 혼합, 모르는 값으로 재대입, 열린 wrapper, 외부 maker 값은 계속 미해석이다.

설치된 Next.js **16.2.7**의 `unstable_cache`에는 SDK별 callback 실행 위임 모델 하나를 적용한다.
import가 프로젝트 밖 SDK 선언으로 해석되는 named import(이름 별칭 포함) 또는 직접 namespace 멤버여야 하고,
직접 factory 호출이나 최대 16단계 immutable `const` wrapper 별칭만 따른다. 인라인 함수·안정한 프로젝트 함수 선언/import·immutable 식별자 별칭의
callable 흐름이 전부 해석되면 wrapper 호출에서 callback으로 `bound` 간선을 낸다. 캐시 hit는 callback 실행을 건너뛸 수 있으므로 이 간선은
가능한 실행 경로를 뜻한다. 캐시 읽기는 JSON을 역직렬화하므로 반환 값은 계속 opaque이고, wrapper의 호출 인자를
callback 매개변수 흐름으로 전달하지 않는다. 다른 SDK 버전, 프로젝트 shadow·augmentation, mutable/속성 별칭,
주입된 callback 매개변수, optional/spread 호출, 열린 프로그램·opaque import·namespace 값 탈출·관찰된 SDK 쓰기는 미해석으로 둔다.
SDK 실행이나 네트워크 요청은 하지 않는다.

`bound`가 보장하는 것과 보장하지 않는 것:

- **보장**(아래 전제 아래): 호출 위치에서 실행될 수 있는 구현이 빠지지 않고, 이은 구현은 모두 프로젝트 어딘가에서
  수신자로 흘러드는 것이 관찰됐다.
- **보장하지 않음**: 이은 구현이 모든 경로·모든 호출자에서 실행된다는 것. 흐름이 문맥에 민감하지 않아, 두 조립
  지점에서 두 저장소로 조립된 공유 핸들러는 두 저장소 모두에 bound된다(`fixtures/graph/di-dispatch`:
  `ItemHandler.get` → `SqlItemStore.findItem`·`MemoryItemStore.findItem`). 쓰이지 않는 조립 지점도 센다.
- **전제: 스캔한 프로젝트가 프로그램 전체다.** 스캔 밖 코드가 값을 넣을 수 있는 자리는 흐름을 모름으로 보고
  `bound`를 내지 않는다: 진입점(과 진입점 export가 별칭·참조하는 함수)의 매개변수, 진입점 파일의 내보내기, 동적
  `import()`/`require()`로 불리거나 네임스페이스가 값으로 쓰인 모듈의 내보내기, 메서드·객체 리터럴 멤버·콜백의
  매개변수(호출자를 다 셀 수 없다), 호출 대상 밖에서 참조된 함수·클래스(값으로 넘김, `.call`/`.bind`, JSX, 태그
  템플릿), 데코레이터가 붙은 클래스(DI 컨테이너가 만든다)와 데코레이터가 붙은 메서드·필드·접근자, `new this()`를 쓰는
  클래스, `new`·`extends`·static 접근 밖에서 값으로 쓰인 클래스(mixin이 하위 클래스를 만들 수 있다)의 `this`, 이름이 같은
  멤버가 호출 대상 밖에서 읽히는(`h.run.bind(x)`, `const { run } = h`, `({ run } = h)`) 메서드의 `this`(쓰기와 같은 규칙으로
  그 읽기의 수신자 흐름이 클래스·하위 클래스를 담지 않음을 증명하지 못하면), 불러온 모듈에서
  재내보내기 배럴(`export *`·`export { x } from`·`export * as ns`)로 닿는 내보내기, `declare`한 값.
  `package.json`이 `main`·`module`·`exports`·`bin`·`types`·`typings`·`browser`를 선언한 패키지(또는 1 MiB 안에서
  JSON 객체로 읽지 못하는 `package.json`)이거나 스캔이
  불완전하면(건너뛴·너무 큰·읽지 못한·symlink 파일, 구문 오류) 모든 내보낸 함수·클래스와 비공개가 아닌 속성도
  열린 자리로 보고, 문서가 `bound-dispatch:`로 알린다. 호출자가 모두 프로젝트 안인 내보낸 함수는 닫혀 있고,
  프로젝트 안 호출자가 없는 내보낸 함수는 관찰된 흐름이 없어 bound하지 않는다. 닫힌 쪽으로 실패한다: 색인된 호출
  위치가 없는 함수·생성자는 모름이다(기본 매개변수 값만으로 흐름 전체라고 보지 않는다). 단 엄격한 문법 재검사로 참조가
  전혀 없음을 증명하면 — 분석한 파일 전체에서 이름이나 별칭 지역 이름과 텍스트가 같은 식별자·`#이름`·문자열 리터럴 토큰이
  그 심볼 자신의 선언 이름뿐이면 — "호출 없음"으로 본다. 구조 분해 속성 이름·속성 접근 이름·`export default`·타입 자리·
  이름이 같은 다른 심볼 등 그 밖의 등장은 모두 증명 실패다. 참조 색인은 값 자리의 모든
  식별자, 모든 속성 접근 이름(파일 안 `namespace App`의 `new App.Repo(…)`, `globalThis.f` 포함), 모든 문자열 리터럴
  원소 접근(`App["load"](…)`)을 checker로 푼다. 식별자·속성 사슬(`App.Repo`, `helpers.sub`)·리터럴 원소 접근으로 닿은
  모듈·값 네임스페이스가 값으로 쓰이거나(인자, `const { run } = App.Repo` 같은 구조 분해 초기값, 전개) 계산된 키로
  읽히면(`App.Repo[key]`) 멤버 전부를 연다. 프레임워크 파일(App Router `route`·특수 파일, `pages/` 아래 전부, `proxy`·`middleware`·
  `instrumentation` — `export * from`만 있어도)의 내보내기와 그것이 재내보내는 선언 전부, 그리고 ES 모듈이 아닌 파일
  (스크립트·CommonJS)의 최상위 선언도 열린 자리다. 여러 번 선언한 변수(`var x = a; var x = b;`)는 모든 초기값을 합친다.
- **모델링하지 않음**(문서화한 공백): 색인하지 못한 prototype API, `eval`, 라이브러리 코드로 나갔다 돌아오는 값, 라이브러리 코드가 바꾸는 속성. 의존성이 설치되지
  않으면 그 타입은 오류 타입이라 `any`로 센다. 그 API를 거친 값은 모름이라, 그런 값 위의 같은 이름 쓰기·메서드
  읽기가 관계없는 클래스의 bound를 막을 수 있다(bound가 줄 뿐 틀리지 않는다). 지정자가 문자열이 아닌 동적 `import()`/`require()`와 파일 패턴
  로더(`import.meta.glob`·`require.context`)는 모든 내보내기를 연다. `Object.assign`·`Object.defineProperty(ies)`·`Reflect.set`·`Reflect.defineProperty`·
  `Reflect.deleteProperty`의 대상은 보수적으로 다룬다(그 속성·멤버는 모름, 정적으로 해석한 멤버 호출도 포함).
  위의 좁은 반환 리터럴·생성자 carrier identity 증명은 모르는 대상에만 적용하는 예외이며, 알려진 반사 대상은 여전히 리터럴을 막는다.
  계산된 키 쓰기·삭제(`obj[key] = v`, `delete obj[key]`)도 그 수신자의 속성을 모름으로 연다. 값을 모르는 반사 대상은
  정적 타입을 보존하며, 닫혀 있고 밖으로 새지 않은 nominal 클래스 계보에서 그 클래스와 모든 프로젝트 하위 클래스가
  대상 타입과 겹칠 수 없을 때만 제외한다. 구조적으로 서로 대입할 수 없는 타입도 교차 객체로 겹칠 수 있으므로 계속 모름이다.
  `any`·`unknown`·generic/instantiable 대상 타입에는 이 제외 규칙을 쓰지 않는다. 메서드를 바꾸는 같은 이름 속성 쓰기(몽키 패치)가 있으면 그 메서드는
  bound하지 않는다.
- **테스트 소스는 별개 프로그램이다.** 테스트 소스(`*.test.*`·`*.spec.*`·`__tests__/`·`__mocks__/` — `routes`와
  같은 규칙)가 아닌 파일의 호출은 테스트 소스를 뺀 프로그램으로 흐름·후보를 구한다. 그래서 단위 테스트가 주입한
  목(mock)이 운영 간선을 막지 않는다. 테스트 소스 안의 호출은 프로젝트 전체로 구한다. 테스트가 아닌 파일이 테스트
  소스를 import하면 모든 호출을 전체로 구한다.
- 독립적인 실행 효과 목록은 전체·운영 분석의 기대 소스와 파일 색인, 소스 revision, runtime 모듈 간선,
  실행 연산을 대조한다. 열거·참조 및 별칭 폐쇄·초기화 범위·ambient 안전성은 별도 판정이며, 열거가
  완료되어도 모르는 효과가 남을 수 있다. 참조·별칭 폐쇄는 실행 위치의 근거를 대조한다.
  불완전한 범위는 새 효과 인증을 막고 기존 디스패치는 각자의
  검증을 유지한다. 목록 구축은 방문 노드 1,000,000개·보존 기록 1,000,000개·파일당 추가 노드 100,000개로
  제한한다. 반복 수집은 상한을 공유하며 각 순회의 작업과 참조·별칭·토큰 근거의 보존을 합산한다.
  초기화 범위는 정적 간선과 인식된 로더 출처의 모듈 로드 범위이며 실행 순서는 별도 증명이 필요하다.
  일반 반사·임의 팩터리는 호출·속성 효과를 모름으로 남기므로 이 판정으로 실제 모듈 로드나 ambient 안전성을
  인증하지 않는다. runtime CJS import-equals의
  로더 평가는 모름으로 남는다. 실제 플랫폼 로더의 동적 접근과 플랫폼 루트의 외부 전달은 모듈 로드의
  불투명한 근거로 남긴다. 잘못된 색인 part로 범위를 인증하지 않는다.
  구축 상한 초과는 `effect-inventory: incomplete(build-cap)`으로 알리며 흐름 질의 예산을
  소비하거나 부분 목록을 안전하다고 인증하지 않는다. 그 밖의 누락·불일치는
  `effect-inventory: incomplete(coverage)`로 알린다. 이 effect-inventory 한계는 전체 관점의 열거 범위를 보고한다.
  후속 효과 인증은 선택한 관점의 참조 폐쇄와 모듈 로드 범위를 직접 검사해야 한다. 열거 완료만으로 두 판정이나 초기화
  순서를 인증하지 않는다.
- 흐름 질의마다 예산이 있다(20,000단계, 중첩 자리 256개, 중첩 식 400개). 넘거나 JavaScript 스택이 넘치면 모름이고
  그 수를 `dispatch-budget:`으로 알린다. 이름으로 찾는 속성 쓰기·멤버 읽기·수신자 흐름은 질의 사이에 메모해, 흔한 멤버
  이름이 예산을 태우지 않는다(같은 이름 쓰기·떼어 낸 읽기가 1,500개인 합성 모듈 1,500개에서 21.7초 → 2.5초).

`unresolvedCalls`는 노드·모드마다, 노드 자신의 호출 위치(호출·`new`·태그 템플릿·데코레이터·JSX) 중 그 모드에서
간선이 없거나 대상의 일부만 이은 수다: `direct`는 그런 위치 전부, `bound`는 `bound` 간선으로 이은 대기
호출을 빼고, `candidates`는 `candidate` 간선으로 이은 것도 뺀다. 의존성으로 가는 호출은 외부이지 미해석이 아니다.
매개변수로 받은 콜백 실행은 호출자 쪽 `callback` 간선이 도달을 덮더라도 센다.

### 진입점

| `entries` | 근거 |
|---|---|
| `route-handler` | 프로젝트 `tsograph routes` route-decl 사실의 `symbol.usr`(테스트 소스 제외) |
| `scheduled` | 템플릿이 `vercel.json` `crons[].path`와 맞는 GET/ANY route 핸들러(Vercel은 cron을 GET으로 부른다) |
| `server-action` | `'use server'` 모듈의 내보내기, 본문이 `'use server'`로 시작하는 함수 |
| `page` | App Router 특수 파일(`page`·`layout`·`template`·`default`·`error`·`not-found`·`loading` …)의 기본 내보내기와 `generateMetadata`·`generateStaticParams` 등, Pages Router 페이지(기본 내보내기, `getServerSideProps`·`getStaticProps` 등) |
| `metadata-route` | `sitemap`·`robots`·`manifest`·아이콘·Open Graph 이미지 파일의 기본 내보내기 |
| `middleware` | `proxy.<ext>`·`middleware.<ext>`의 `proxy`·`middleware`·기본 내보내기 |
| `instrumentation` | `instrumentation.<ext>`의 `register`·`onRequestError` |

isthmus http 조인으로 닿는 것은 `route-handler`뿐이다. `reach`·`impact` 문서는 root·도달 심볼 중 그 밖의
진입점을 `non-http-entries:`로 세어, isthmus `trace`가 route 누락 대신 `non-http-entry` gap으로 보고할 수
있게 한다.

`reach`·`impact --entry-points`는 root·도달 심볼에 관찰한 `symbol.entries`를 추가하고, 표시된 root의 위치도 싣는다.
isthmus-cli 0.12.0 이상은 relation·심볼·파일 선택에서 비HTTP 진입점을 API 영향과 함께 보고한다. page 표식에는
layout·특수 파일도 들어 전부 RSC라는 뜻이 아니다. 기본 옵션은 꺼져 있어 출력 호환을 유지한다. 발행된
isthmus-cli 0.11.0은 `symbol.entries`를 거부하므로 소비자를 먼저 업그레이드한다.

### language-traversal 출력

- `dispatch`: 쓴 모드(`--dispatch`, 기본 `bound`). `direct`는 `direct` 간선만(디스패치 이전 동작), `bound`는
  `direct`·`bound`, `candidates`는 모든 간선을 따른다. 계약상 `dispatch`를 싣는 것은 모든 도달 심볼에
  `evidence`를 싣고, 잇지 못한 호출이 하나 이상인 모든 root·도달 심볼에 `unresolvedCalls`를 싣는다는 선언이다.
- `roots[]`: 입력 순서의 `{ id, symbol: { usr, qualifiedName }, unresolvedCalls? }`.
- `reached[]`: `{ symbol: { usr, qualifiedName, kind, location }, via, depth, roots, relationships, evidence,
  unresolvedCalls? }`, (`depth`, `usr`) 순. `depth`는 가장 가까운 root까지의 거리, `via`는 가장 가까운 root에서의 최단 경로의
  직전 심볼(같으면 작은 root 인덱스, 그다음 작은 선행 id, 깊이 1이면 root id), `roots`는 그 심볼에 닿는 모든 root 인덱스, `relationships`는 `via`와 심볼 사이 간선 종류다(모드가 허용하는 근거
  등급의 간선을 합친다). `depth`·`via`·`roots`·`relationships`는 모드가 허용하는 전체 그래프 기준이다.
- `evidence`는 **root별 하한**이다: 깊이 상한 안에서 심볼에 닿는 root 각각(64개 상한으로 목록에서 빠진 root 포함,
  심볼 자신 제외)에 대해, 그 등급의 간선만으로 깊이 상한 안에서 그 root에서 닿는 가장 강한 등급을 구하고, 그중
  가장 약한 것이다. 그래서 `"direct"`는 그 심볼에 닿는 모든 root가 `direct` 간선만으로 닿는다는 뜻이다. 등급별
  최단 경로는 `via` 사슬과 다를 수 있다. 깊이 예산 안에서 `direct`가 아닌 간선의 출발점에 닿지 못하는 root는
  모든 등급에서 똑같이 닿으므로, 나머지 root만 root당 비트 하나로 정확히 비교한다.
- `unresolvedCalls`(1~1,000,000, 0이면 생략)는 [위](#인터페이스-디스패치boundcandidate-간선)의 노드별 모드 계수다.
  다른 root에서 닿은 root는 `roots[]`와 `reached[]`에 같은 값을 싣는다. 1,000,000을 넘으면 1,000,000으로 싣고 문서에
  `unresolved-calls-capped:`를 더한다. 그래프 스냅샷은 정확한 수를 싣는다.
- 정확한 등급 비교는 심볼·등급마다 비교 대상 root당 비트 하나가 든다. 이것이 64 MiB를 넘으면 `evidence`는 root에서 닿는
  출발점을 가진 `direct`가 아닌 간선 중 심볼의 위쪽에 있는 것의 가장 약한 등급으로 근사한다(없으면 `direct`). root별
  하한보다 약하게 적을 수는 있어도 부풀리지 않으며, 문서에 `evidence-approximated:`를 더한다.
- **다른** root에서 닿는 root도 `reached`에 싣는다(핸들러 A가 부르는 도우미 H도 root면 H는
  `roots: [A의 인덱스]`). 그 `roots`에는 자기 인덱스를 넣지 않고, `depth`·`via`도 그 다른 root들 기준이다
  (`via`는 다른 root id일 수 있다). 자기 자신에게서만(순환으로) 닿는 root는 싣지 않는다. 경로는 다른 root를
  지날 수 있고, 그 너머 심볼은 두 root 인덱스를 모두 싣는다.
- 예산: `--max-depth` 1–128(기본 128), `--max-reached` 최대 100,000(기본 100,000). 예산이 순회를 자르면
  `truncated: true`와 `truncationReasons`(`depth`·`max-reached`)를 싣는다. 한 심볼의 root 인덱스가 64개를
  넘으면 작은 64개만 싣고 `rootsTruncated: true`를 단다.
- 순회는 root마다 따로 도는 탐색이 아니라 모든 root를 한 번에 출발시키는 단계 동기 단일 패스다. 더 작은 root
  인덱스를 이미 65개 가진 심볼에서는 더 큰 root가 전파를 멈춘다 — 싣는 `roots`·`depth`·`via`를 더는 바꾸지
  못하기 때문이며, root가 10,000개여도 심볼당 작업이 묶인다. root별 알고리즘과의 동등성은 무작위 테스트로
  확인한다. root 인덱스가 넘치면(`rootsTruncated: true`) `depth` 이유는 깊이 상한 때문에 심볼이 빠졌을 때
  싣고, 한 root의 출처만 잘린 경우에는 싣지 않는다. `max-reached`로도 잘린 문서에서는 버린 심볼의 root
  초과도 `rootsTruncated`로 알린다.
- `graphRevision`은 노드 id·종류·진입점·모드별 미해석 호출 수와 간선(근거 포함)의 `sha256:` 해시다(위치 제외).
  같은 그래프의 `graph`·`reach`·`impact`는 `--dispatch` 모드와 관계없이 같은 값을 싣는다. `revision`은 `.git`에서 읽은 프로젝트 루트의 git `HEAD` 커밋이다
  (작업 트리 변경은 반영하지 않는다).
- `limitations`는 모드의 그래프 limitation과 이 문서 범위의 `non-http-entries:`다. `unresolved-calls:`·
  `partial-dispatch:` 계수는 모드가 이은 인터페이스 호출을 빼고, `bound-dispatch:`·`candidate-dispatch:`는 모드의
  디스패치 간선이 이은 호출 수를 알린다. 스냅샷은 `unresolved-calls:`를 `direct` 기준으로 세고 두 디스패치 줄을
  모두 싣는다.
- `--generated-at`은 `generatedAt`을 고정해 바이트 단위로 같은 출력을 만든다.

예시(합성 `fixtures/graph/next-prisma`, 줄임):

```sh
tsograph reach --project fixtures/graph/next-prisma --generated-at 2026-09-27T00:00:00.000Z 'src/app/api/jobs/route.ts#POST'
```

```json
{
  "direction": "dependencies",
  "format": "language-traversal",
  "generatedAt": "2026-09-27T00:00:00.000Z",
  "dispatch": "bound",
  "graphRevision": "sha256:8af7fab5…",
  "limitations": ["unresolved-calls: 6 call(s) could not be linked to a project declaration and were not guessed (parameter: 1, interface: 1, untyped: 1, computed: 1, indirect: 1, unresolved-import: 1)", "…"],
  "platform": "js",
  "project": "/work/example",
  "reached": [
    { "depth": 1, "evidence": "direct", "relationships": ["call"], "roots": [0],
      "symbol": { "kind": "function", "location": { "column": 17, "line": 3, "path": "src/lib/hof.ts" },
                  "qualifiedName": "src/lib/hof.ts#withAuth", "usr": "src/lib/hof.ts#withAuth" },
      "unresolvedCalls": 1, "via": "src/app/api/jobs/route.ts#POST" },
    { "depth": 1, "evidence": "direct", "relationships": ["call"], "roots": [0],
      "symbol": { "kind": "function", "location": { "column": 23, "line": 8, "path": "src/lib/jobs.ts" },
                  "qualifiedName": "src/lib/jobs.ts#createJob", "usr": "src/lib/jobs.ts#createJob" },
      "via": "src/app/api/jobs/route.ts#POST" },
    { "depth": 2, "evidence": "direct", "relationships": ["call"], "roots": [0],
      "symbol": { "kind": "function", "location": { "column": 23, "line": 3, "path": "src/lib/audit.ts" },
                  "qualifiedName": "src/lib/audit.ts#audit", "usr": "src/lib/audit.ts#audit" },
      "via": "src/lib/jobs.ts#createJob" }
  ],
  "roots": [{ "id": "src/app/api/jobs/route.ts#POST",
              "symbol": { "qualifiedName": "src/app/api/jobs/route.ts#POST", "usr": "src/app/api/jobs/route.ts#POST" } }],
  "tool": { "name": "tsograph", "version": "0.1.0" },
  "truncated": false,
  "version": 1
}
```

`tsograph schema`의 relation-use 사실(`symbol.usr` ∈ 도달 집합 ∪ {핸들러})과 이으면 `POST /api/jobs`는
`jobs`와 `AuditLog`에 닿는다. 같은 문서가 isthmus `feature/trace-language-traversal` 소비자의
`language-traversal` 파서와 `isthmus trace`(`forward` 분석의 route 선택, `reverse` 분석의 심볼 선택)를
통과하고, `dispatch`·`evidence`·`unresolvedCalls`를 실은 문서는 `feature/trace-evidence-tiers` 소비자의 파서를
통과한다. 두 소비자는 isthmus-cli 0.10.0에 발행됐다.

디스패치 예시(합성 `fixtures/graph/di-dispatch`, 줄임): `GET /api/items`는 `primaryHandler.get()`을 부르고, 그
안의 `this.deps.store.findItem()`은 `ItemStore` 인터페이스를 거친다. `PATCH`는 Next.js가 채우는 매개변수로
저장소를 받으므로 흐름을 모른다.

```sh
tsograph reach --project fixtures/graph/di-dispatch 'src/app/api/items/route.ts#GET' 'src/app/api/items/route.ts#PATCH'
```

```json
{
  "dispatch": "bound",
  "reached": [
    { "depth": 1, "evidence": "direct", "roots": [0], "symbol": { "usr": "src/lib/handler.ts#ItemHandler.get", "…": "…" }, "via": "src/app/api/items/route.ts#GET" },
    { "depth": 2, "evidence": "bound", "roots": [0], "symbol": { "usr": "src/lib/store.ts#SqlItemStore.findItem", "…": "…" }, "via": "src/lib/handler.ts#ItemHandler.get" },
    { "depth": 3, "evidence": "bound", "roots": [0], "symbol": { "usr": "src/lib/store.ts#SqlClient.query", "…": "…" }, "via": "src/lib/store.ts#SqlItemStore.findItem" }
  ],
  "roots": [
    { "id": "src/app/api/items/route.ts#GET", "symbol": { "…": "…" } },
    { "id": "src/app/api/items/route.ts#PATCH", "symbol": { "…": "…" }, "unresolvedCalls": 1 }
  ]
}
```

`--dispatch direct`면 저장소 메서드에 닿지 않고, `--dispatch candidates`면 `PATCH`도 두 저장소에 닿으며
`SqlClient.query`는 `"candidate"`가 된다(PATCH는 candidate 간선으로만 닿는다).

### 그래프 limitation 접두사

`unresolved-calls:`, `partial-dispatch:`, `bound-dispatch:`, `candidate-dispatch:`, `dispatch-budget:`,
`overridden-methods:`, `missing-dependencies:`,
`unresolved-export-aliases:`, `graph-config:`, `parse-errors:`, `oversized-sources:`,
`unreadable-sources:`, `skipped-symlinks:`, `scan-truncated:`, `entry-points:`, `non-http-entries:`, 그리고
`reach`·`impact` 문서에만 `evidence-approximated:`·`unresolved-calls-capped:`.
개수만 싣고 소스 원문·절대 경로는 싣지 않는다.

## 심볼 id

`tsograph graph`/`reach`/`impact`의 노드, route-decl 사실의 `symbol.usr`, relation-use 사실의 `symbol.usr`가
한 가지 id 형식을 같이 쓴다. 그래서 isthmus가 정확한 문자열 일치만으로 셋을 잇는다.

```text
<프로젝트 기준 POSIX 경로>#<선언 경로>
```

- 선언 경로는 schema [심볼 형식](#사실)과 같다. 감싸는 선언 이름을 바깥부터 `.`으로 잇는다:
  `src/lib/jobs.ts#listJobs`, `src/lib/repo.ts#Repo.save`, `src/lib/repo.ts#Repo.constructor`,
  `src/auth.ts#handlers.GET`, `src/app/api/items/[id]/route.ts#GET`, `pages/api/hello.ts#handler`.
- 이름 있는 선언 밖의 코드(최상위 문장, 계산된 이름 멤버와 그 안의 콜백)는 모듈 스코프 `<경로>#<module>`에 속한다.
- 인라인 콜백은 자기 id를 갖는다: [인라인 콜백 id](#인라인-콜백-id).
- 이름 없는 기본 내보내기는 `<경로>#default`다(`export default <식>` 포함).
- 그 자체가 이름 있는 선언이 아닌 내보내기(`export { a as GET }`, `export { GET } from './impl'`,
  `export const { GET } = handlers`, `export let x;`)는 `<경로>#<내보낸 이름>` export 노드가 되고, 해석한
  대상으로 `alias` 간선을 잇는다.
- 같은 id가 되는 선언(오버로드, getter/setter 쌍, 형제 블록의 같은 이름 함수)은 한 노드다.
- 선언 측 relation-use 사실은 `#model:`·`#typedsql:` id를 쓴다([사실](#사실)). 이 id는 그래프 노드가 아니다.
  Node ORM 선언(Drizzle 테이블·TypeORM 엔터티·Sequelize 모델)도 `#model:`을 쓴다.

### 인라인 콜백 id

호출·`new`의 인자로 바로 넘긴 화살표·함수 식(괄호·`as`·`satisfies`·non-null 래퍼는 벗긴다)은 그래프 노드다. id는 다음과 같다.

```text
<콜백 식이 속한 스코프 id>.<호출 대상>(<키 인자>)[~<n>]
```

- **스코프.** 앞부분은 콜백 안의 코드가 아니라 콜백 식 자신의 위치가 정한다. 모듈 최상위 콜백은 `<경로>#<module>` 아래,
  `listJobs` 안의 콜백은 `#listJobs` 아래, 다른 콜백 안의 콜백은 그 콜백 id 아래다(`#<module>.describe("suite").it("works")`).
  호출 결과를 받는 지역 변수는 조각이 아니다(`load` 안의 `const rows = ids.map(cb)`는 `#load.ids.map()`). 그래서 앞부분은
  언제나 콜백을 담은 노드이고, 그래프가 그 노드에서 `contains` 간선으로 잇는다.
- **기준 호출.** 콜백을 받은 호출이 다시 다른 호출의 인자면 인자 사슬의 가장 바깥 호출이 이름을 준다.
  `app.get('/x', asyncHandler(async (req, res) => …))`는 감싸지 않은 핸들러처럼 `app.get("/x")`다.
- **호출 대상.** 식별자·`this`·`super`·속성 접근·문자열 키 원소 접근의 사슬을 쓴 그대로 옮긴다(`app.get`,
  `this.router.post`, `db["run"]`). 사슬 안의 호출·`new`·그 밖의 식은 `…`로 줄인다(`new Hono().get('/a', …)` →
  `….get("/a")`). 그래서 체인의 앞 등록이 뒤 핸들러 id에 스며들지 않는다. `new` 기준 호출은 `new <대상>`이다(`new Promise()`).
- **키 인자.** 앞쪽의 정적 키 인자 최대 2개를 `,`로 잇는다: 문자열 리터럴(JSON 인용), 템플릿 리터럴(치환은 이름 사슬이면
  `${이름}`, 아니면 `${…}`), 이름 사슬(`books.post(BOOKS)`, `authors.get(PATHS.authors)`), 그런 키만 담은 배열
  (`books.on(["PUT","PATCH"],"/b")`). 다른 인자에서 멈추고, 없으면 빈 괄호다(`useEffect()`). 64 UTF-16 단위를 넘는 문자열은
  서러게이트 쌍을 가르지 않고 자른 뒤 `…`를 붙이고, C1 제어 문자·U+2028/U+2029는 `\uXXXX`로 쓴다(계약이 심볼 이름에 제어
  문자를 금지한다).
- **겹침.** 앞부분과 조각이 같은 콜백(같은 경로 두 번 등록, 한 호출의 인라인 함수 여럿, 반복한 `useEffect`)은 소스 순서로
  번호를 매겨 두 번째부터 `~2`, `~3`…을 붙인다.
- **안정성.** 줄·열에 기대지 않으므로 무관한 수정(선언·다른 콜백 추가, 줄 이동, 다른 라우트 경로 수정, 다른 스코프의 콜백
  추가)에 그대로다. 콜백 자신의 앞부분·호출 대상·키 인자가 바뀌거나, 앞부분과 조각이 같은 콜백이 앞에 끼면(뒤 콜백의
  `~n`이 밀린다) 바뀐다.
- **덮지 않는 것.** 계산된 이름 멤버 안의 콜백은 이름을 만들지 않고(추측하지 않는다) 모듈 스코프에 남는다. 호출 인자가
  아닌 함수는 기존 규칙 그대로다: 객체 리터럴 속성(`{ handler: async () => … }`는 `…handler`), 변수 초기값, JSX 속성 값과
  즉시 실행 함수(투명).

## 개발

```sh
npm ci
npm run verify   # 타입 검사, 라인·분기·함수 90% 게이트 테스트, clean build, CLI 계약
node --test src/openapi/path-template.test.ts   # 집중 실행
```

`src/schema/sql-relations.test.ts`는 가족 공유 SQL 관계 벡터(cartograph `SqlRelationsTests`·
dartograph `sql_relations_test`와 같은 기대값)를 담는다.

`src/openapi/conformance.test.ts`는 isthmus 공유 벡터 `conformance/http-template.json`이 있으면
(`TSOGRAPH_CONFORMANCE_DIR`, `./conformance/`, 형제 `../isthmus/conformance/`) 템플릿 정규화기를
그 벡터로 검증하고, 없으면 이유를 알리고 건너뛴다.

`src/exchange/http-limitation-scope.test.ts`는 벤더링한 모든 벡터 파일을 `conformance/SHA256SUMS`와
대조하고, `conformance/http-limitation-scope.json`의 `scope.validate` 사례로 스코프 검증기를 검사하며,
`routes` 스코프가 기대는 `scope.applies` 사례를 고정한다. `src/exchange/dispatch-order.test.ts`는
`conformance/http-dispatch.json`의 `dispatch.validate` 사례를, `src/exchange/dynamic-scope.test.ts`는
`scope.dynamic-validate` 사례를 실행하고, `routes`는 같은 검증기로 `order`·`dynamicScope`를 내기 전에 검사한다.

`src/routes/node/node-conformance.test.ts`는 확인한 Node 경로 문법 변환표(Hono, path-to-regexp 0.1·6·8, find-my-way,
NestJS 옛 경로 변환기)를 패키지 출처와 함께 고정하고, `src/routes/node/oracle-replay.test.ts`는
`experiments/node-routes-oracle/recorded/`의 오라클 기록을 다시 본다.

`src/routes/conformance.test.ts`는 Next fixture가 내는 모든 정적 channel을 벤더링한
`conformance/http-template.json`의 문법 사례로 검사하고, 확인한 Next.js 변환표(`next/dist` 출처 포함)를
isthmus 벡터 모양으로 두어 `producer:nextjs` 사례로 올릴 수 있게 한다.

## 라이선스

MIT. 영구 무료, 텔레메트리 없음.
