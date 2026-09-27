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
| Node 백엔드 라우트 선언(Next.js·Hono·Express·Fastify·NestJS·Koa) | 계획 |
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

## 개발

```sh
npm ci
npm run verify   # 타입 검사, 라인·분기·함수 90% 게이트 테스트, clean build, CLI 계약
node --test src/openapi/path-template.test.ts   # 집중 실행
```

`src/openapi/conformance.test.ts`는 isthmus 공유 벡터 `conformance/http-template.json`이 있으면
(`TSOGRAPH_CONFORMANCE_DIR`, `./conformance/`, 형제 `../isthmus/conformance/`) 템플릿 정규화기를
그 벡터로 검증하고, 없으면 이유를 알리고 건너뛴다.

## 라이선스

MIT. 영구 무료, 텔레메트리 없음.
