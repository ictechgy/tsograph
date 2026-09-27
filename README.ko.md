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
- **location**: operation의 method 키 위치. 1부터 시작하는 줄과 1부터 시작하는 UTF-8 바이트 열이며
  앞의 BOM은 세지 않는다.
- **symbol.qualifiedName**·**operationId**: operationId가 있으면 싣는다(`usr` 없음).
- 서버 우선순위: operation `servers` > path item `servers` > 루트 `servers` > 기본값 `/`.
  빈 `servers` 배열은 없는 것과 같다.

### fail-closed 결정

증명할 수 없는 값은 추측하지 않는다. `pathAnchor: "base"`, `dynamic: true`, 초안의 계약 측
limitation 접두사를 써서 isthmus가 거짓 error 대신 판정을 낮추게 한다.

- **경로의 서버 변수**: `enum`이 있으면 값마다 사실을 낸다(조합 256개 상한). `default`만 있는
  변수는 클라이언트가 바꿀 수 있는 열린 값이라 접두사를 **확정하지 않는다** — 변수 뒤 리터럴
  꼬리와 `pathAnchor: "base"`를 쓰고 문서에 `unresolved-contract-servers:`를 싣는다. scheme·host·
  port의 변수는 버려지므로 무관하다.
- **상대 서버 URL**(`v1`, `./v1`)은 문서를 제공하는 위치 기준이라 역시 `base`다. `/v1`은 절대
  경로라 `root`다.
- **여러 서버**의 경로 접두사가 다르면 확정한 접두사마다 사실을 낸다. 일부만 확정되면 `root`와
  `base` 사실을 함께 낸다.
- **Swagger 2.0 `basePath`**가 `/`로 시작하지 않거나 중괄호·`?`·`#`를 포함하면 `base`다.
- **`$ref`**: path item(3.1 `components.pathItems` 포함)의 로컬 JSON Pointer(`#/...`)만 최대 16단계
  따라간다. 로컬이 아니거나 깨졌거나 순환하는 참조는 `contract-coverage:`로 센다. 네트워크는 쓰지
  않는다.
- **건너뛴 입력은 조용히 버리지 않고 센다**: `/`로 시작하지 않는 paths 키, 객체가 아닌 path
  item·operation, 모르는 path item 필드, dynamic 템플릿은 `contract-coverage:`로 알린다. 금지 문자가
  있는 operationId는 빼고 `unsafe-operation-ids:`(정보용)로 센다.
- **3.1 `webhooks`**는 서비스가 보내는 요청이지 제공하는 라우트가 아니라 내지 않는다.
- **2,048자를 넘는 템플릿**은 소비자가 거부하므로 `dynamic`으로 낸다.

### 입력 안전

- 스펙은 16 MiB 이하, 유효한 UTF-8, YAML 문서 하나여야 한다.
- 중복 매핑 키는 거부한다. 파서 내장 검사가 매핑 크기에 대해 제곱 시간이라 선형 시간 검사로 찾는다.
- YAML alias는 미리 만든 색인으로 따라가고 역참조는 100,000회로 제한한다. merge key(`<<`)는
  적용하지 않는다. 사용자 태그는 실행하지 않고, 트리를 JS 객체로 바꾸지 않는다.
- 과도한 중첩은 파서가 거부한다. 사실은 최대 100,000개이고, 넘으면 부분 문서 대신 실패한다.

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
