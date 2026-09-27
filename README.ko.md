# tsograph

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
| 그 밖의 Node 백엔드 라우트 선언(Hono·Express·Fastify·NestJS·Koa) | 계획 |
| ORM/SQL relation-use(Prisma·TypeORM·Sequelize·Drizzle·Knex·raw SQL·D1) | 계획 |
| 웹/React Native 클라이언트 route-call, 호출 그래프, 영향 | 계획 |

isthmus의 `http` target은 아직 isthmus `docs/GRAPH-EXCHANGE.md`의 **초안**("개발 중: HTTP 경계
합의 초안")이다. 초안이 발행되기 전의 isthmus는 `target: "http"` 문서를 거부한다.

## 요구 사항

- Node.js 22.18.0 이상

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

Next.js 프로젝트를 스캔해 bridge-facts v1 문서를 표준 출력에 쓴다: `platform: "js"`,
`target: "http"`, `roles: ["server"]`, `dispatch: "specificity"`, `sourceSets`, (route 파일, HTTP
method)마다 `route-decl` 사실 하나. 분석 대상 코드는 TypeScript 파서로 읽기만 하고 실행하지 않는다.
모듈 해석·타입 검사·네트워크 접근도 하지 않는다.

- `--role server`(필수): 선언 측만 구현했다. `client`는 route-call 추출이 생기기 전까지 사용법 오류다.
- `--project`(필수): Next.js 프로젝트 루트(`next.config.*`와 `app/`·`pages/`가 있는 곳). `project`는
  그 POSIX realpath이고 `location.path`는 그 기준 상대 경로다.
- `--service`: 문서와 모든 사실에 싣는 서비스 신원.
- `--include-tests`: 테스트로 보이는 route 파일도 `testSource: true`와 `sourceSets.tests: "included"`로
  낸다. 없으면 건너뛰고 `sourceSets.tests: "excluded"`를 선언한다. 테스트 경로는 `*.test.*`·`*.spec.*`와
  `__tests__/`·`__mocks__/` 아래 파일이다. `test/` 폴더는 Next.js에서 실제 URL 세그먼트라
  (`app/api/test/route.ts`는 `/api/test`) 테스트로 보지 않는다.
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
| 설정 파일은 `next.config.js`, `.mjs`, `.ts` 순서로 찾는다(`.mts`는 런타임이 TypeScript를 지원할 때만) | `shared/lib/constants.js`(`CONFIG_FILES`) |
| `basePath`는 빈 문자열이거나 `/`로 시작하고 `/`로 끝나지 않아야 한다 | `server/config.js` |
| 끝 슬래시: `trailingSlash: false`(기본)면 `/x/`를 `/x`로 308 redirect하고, `true`면 마지막 세그먼트가 `name.ext` 모양이거나 `.well-known` 아래가 아닌 한 `/x`를 `/x/`로 보낸다. `skipTrailingSlashRedirect: true`면 redirect가 없고 매칭은 끝 슬래시를 무시한다 | `lib/load-custom-routes.js`, `server/lib/router-utils/filesystem.js` |
| `proxy.<ext>`·`middleware.<ext>`는 `app`/`pages` 옆(루트 또는 `src/`)에 둔다 | `build/index.js`, `lib/constants.js` |
| 메타데이터 파일(`sitemap`·`robots`·`manifest`·`icon`·`apple-icon`·`opengraph-image`·`twitter-image`·`favicon.ico`)은 framework 라우트를 만든다 | `lib/metadata/is-metadata-route.js` |
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
  decl에 `catchAllPrefix`가 없는 이유는 아래 결정 목록에 있다.
- **trailingSlash**: 위 redirect 규칙으로 한 형태가 정규이면 `strict`(channel은 그 형태), redirect가 없어
  두 형태가 모두 핸들러에 닿으면 `optional`(`skipTrailingSlashRedirect: true`, `.well-known`, 두 redirect에
  모두 걸리지 않는 점 있는 마지막 세그먼트), 파라미터 값에 달렸거나 설정 값이 리터럴이 아니면 생략
  (unknown)한다. `caseInsensitive`는 증명하지 못했으므로 내지 않는다.
- **location**: 내보낸 이름 토큰(`GET`, Pages Router는 `default`)의 1부터 시작하는 줄과 UTF-8 바이트 열.
  앞의 BOM은 3바이트로 센다.
- **symbol.qualifiedName**: `<프로젝트 기준 파일 경로>#<내보낸 이름>`, 예: `src/app/api/items/route.ts#GET`,
  `pages/api/hello.ts#default`. 아직 `usr`는 없다.

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
| `proxy`/`middleware` 파일, 메타데이터 파일, 비어 있지 않은 `public/` | `framework-provided-routes:`(합성 decl 없음) |
| route 파일 위에 `@slot`·intercepting route(`(.)x`) 폴더 | 모델링하지 않음(Next 문서가 페이지에 대해서만 설명), `route-coverage:` |
| Next가 거부하는 세그먼트 이름, 구문 오류, 읽을 수 없거나 크거나 UTF-8이 아닌 파일, 비JavaScript 확장자, symlink(따라가지 않음), 금지 문자가 든 이름, 스캔 상한(항목 200,000개, 깊이 64) | `route-coverage:` |
| `package.json`에 `next`가 없거나 범위가 주 버전 16에 한정되지 않음 | `route-framework-version-unknown:` |
| `app/`·`pages/` 디렉터리가 없음 | 사실 0건 + `route-coverage:` |

서버 측 접두사는 모두 계약의 닫힌 목록에서 쓴다. 그래서 isthmus는 각각을 서버 측 공백으로 읽고
`route-call-without-decl`을 거짓 error 대신 `-unverified`로 내린다. limitation에는 개수와 프로젝트 기준
이름만 싣는다.

### 결정 사항(초안과 다른 부분)

- **`usr` 없음, qualifiedName이 조인 손잡이.** `<file>#<export>`는 Next.js가 호출하는 모듈 내보내기를
  가리킨다. 이후 단계에서 tsograph 그래프 id를 같은 (모듈 경로, 내보낸 이름) 쌍으로 찾아 `symbol.usr`로
  더한다. `qualifiedName`은 바꾸지 않는다.
- **optional catch-all 접두사에 `catchAllPrefix`를 달지 않는다.** 계약은 펼친 접두사 decl에
  `catchAllPrefix: true`를 달게 하지만, isthmus는 그런 decl에 `symbol.usr`를 요구한다. usr가 생기기 전까지는
  접두사 decl을 일반 decl로 낸다(`{**}` decl과 같은 method·symbol·location). Next.js는 같은 자리의 명시
  라우트를 빌드 오류(E458)로 막으므로 명시 decl과 충돌하지 않는다. 대신 `route-decl-without-call`·드리프트
  경고에 나타날 수 있다. usr가 생기면 `catchAllPrefix: true`로 바꾼다.
- **감싼 설정은 `root`를 유지한다.** `withX(config)`를 모두 basePath 미상으로 보면 실제 프로젝트 대부분이
  `base`가 된다. 안쪽 리터럴을 쓰고 불확실성은 `unresolved-route-prefix:`로 알린다. 이 limitation이 이미
  거짓 error를 막는다.
- **설정은 프로젝트 루트에서만 찾는다.** Next.js는 부모 디렉터리도 찾는다(`find-up`). `next.config.*`가 있는
  디렉터리를 넘긴다.

### isthmus로 검증

`fixtures/next/`의 합성 fixture를 isthmus `main` 소비자로 확인했다:

```sh
tsograph openapi fixtures/next/app-router/openapi.yaml --service demo --project fixtures/next/app-router > contract.json
tsograph routes --role server --project fixtures/next/app-router --service demo > decl.json
# client.json: roles ["client"], 같은 project·service의 사실 0건 문서
node <isthmus>/src/cli/main.ts check contract.json decl.json client.json
```

check는 코드 0으로 끝나고 의도한 드리프트를 보고한다(`GET /api/health`·`PUT /api/items/{}`의
`route-contract-without-decl`, 스펙에 없는 핸들러의 `route-decl-without-contract`).

## 개발

```sh
npm ci
npm run verify   # 타입 검사, 라인·분기·함수 90% 게이트 테스트, clean build, CLI 계약
node --test src/openapi/path-template.test.ts   # 집중 실행
```

`src/openapi/conformance.test.ts`는 isthmus 공유 벡터 `conformance/http-template.json`이 있으면
(`TSOGRAPH_CONFORMANCE_DIR`, `./conformance/`, 형제 `../isthmus/conformance/`) 템플릿 정규화기를
그 벡터로 검증하고, 없으면 이유를 알리고 건너뛴다.

`src/routes/conformance.test.ts`는 Next fixture가 내는 모든 정적 channel을 벤더링한
`conformance/http-template.json`의 문법 사례로 검사하고, 확인한 Next.js 변환표(`next/dist` 출처 포함)를
isthmus 벡터 모양으로 두어 `producer:nextjs` 사례로 올릴 수 있게 한다.

## 라이선스

MIT. 영구 무료, 텔레메트리 없음.
