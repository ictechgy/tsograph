# Changelog

이 프로젝트의 주요 변경 사항을 기록한다.

## [0.11.0] - Unreleased

- Refresh shared conformance vectors from isthmus `1d6683ab2cd4f7804370c85d4869501042bc3dec`; execute SQL relation cases directly from the hashed source vector. Document published versus candidate versions and feature-specific consumer requirements.

아직 npm에 발행하지 않은 릴리스 후보이다.

- 정적 PnP host: Windows slash·상대·dot 경로 정규화를 실제 overlay 사상과 구분한다. 표기 차이로 도구 SDK lib를 거부하거나 예약 `.tsograph-pnp` 실제 파일을 채택하지 않으며 유효한 metadata의 CLI 회귀 실패에는 알려진 issue code만 남긴다.
- 예약 `.tsograph-pnp` 이름의 ZIP·virtual 경로도 물리화 전에 차단한다. 네 가지 host 메서드가 미매핑 실제 파일을 공개하지 않으며 metadata로 실제 등록한 메모리 alias와 합성 directory는 유지한다.

### Breaking

- graph·reach·impact·routes client: realpath가 `--project` 밖인 `--tsconfig`(`../shared/tsconfig.json`, 밖의
  절대 경로, 밖을 가리키는 symlink)는 그래프·compiler Program을 만들기 전에 사용 오류(64)로 끝난다. 예전에는
  검사 없이 그 설정을 그대로 썼다. 밖의 공용 설정은 프로젝트 안 설정의 `extends`로 쓴다(안 설정이 밖 설정을
  `extends`하는 것은 그대로 된다). 상대 경로는 지금처럼 `--project` 기준이고, 절대 경로는 realpath가 안이면 받는다.

### Added

- 큰 저장 NDJSON의 reach/impact:128MiB text 경로와 별도로1GiB 실제 입력·8MiB header·256KiB record·512MiB 보관 가중치 안의 chunk 경로를 추가했다. 기존 node/edge/schema/깊이/UTF8/중복·정렬·참조·hash 방어와 부분 limitation을 유지하고 실제 EOF 뒤에만 순회한다. Node reader는 안전한 regular-file handle과 신원을 확인하며 지원하지 않는 파일 시스템은 명시적으로 실패한다. 큰 그룹의 의미 분석 범위를 확장한 변경은 아니다.

- 정적 PnP: `.pnp.data.json` 또는 상수 `RAW_RUNTIME_STATE` literal을 실행 없이 읽고, Yarn ZIP/virtual peer location을 compiler host에 연결한다. TypeScript의 exports/import·require 조건과 명시 local typeRoots를 유지하며 잘못된 archive·locator 대체·경계 밖 읽기를 거부한다. 실제 Yarn4.18.1 생성물과 정상/부정 회귀를 추가했다. 전체 Yarn 런타임/임의 loader 표현식·사용자 정규식·경계 밖 global cache 지원을 주장하지 않는다.

- `--respect-gitignore`: graph/reach/impact/routes/schema/navigation/change-impact의 진입 선택에 프로젝트 내부 `.gitignore`를 선택적으로 적용한다. 기본 동작·import 의존성 읽기는 유지하며 중첩·negation·escape 규칙, 명시 files 범위, 선택 limitation과 실패 예산을 문서화했다. 전역 Git 설정·추적 신원은 사용하지 않는다.

- `change-impact --project <git-root> --base <commit> [--head <commit>]`: 실제 커밋/작업 트리 변경을 독립 before/after
  그래프에 연결한다. 삭제·rename caller, 내용 해시, seed 이유, 미매핑 파일, 준비 비용과 기존 순회 한계를 보존한다.
- `openapi --data-contracts`: 호환 소비자를 위한 opt-in bounded primitive 데이터 계약 근거다. 기존 출력은 유지한다.

- 자체 NDJSON 그래프를 소스 접근 없이 reach·impact로 다시 읽는다. 행 개수·순서·중복 키·참조·해시를 검증해 잘린 저장물을 정상 그래프로 취급하지 않는다.

### Changed

- PnP의 `@/*`·`~/*`·`$lib/*` 로컬 별칭을 npm 이름 문법과 구분한다. 공유 Program 사전 검사는 기본·import·require 모드를 모두 대조해 한 모드의 미해결을 global 입력 부재로 취급하지 않으며, Git 변경 캡처는 invalid UTF-8 파일명 충돌을 거부하고 유효한 BOM·U+FFFD 이름 신원을 보존한다.

- 정적 PnP의 선택 ZIP 누락은 입력 한계로 남기고, top-level null peer를 fallback pool로 대체하지 않는다. metadata 실패와 독립된 로컬 별칭을 유지하며, 여러 소유 설정의 PnP global universe를 보수적으로 분리한다. ZIP 이름의 BOM·원시 byte 신원을 보존한다.

- graph·routes·navigation·schema·change-impact: 소유 파일의 nearest/reference 설정으로 별칭을 해석한다.
  같은 타입 의미의 경로 옵션은 파일별로 적용하고 다른 타입 의미는 독립 Program에서 분석한다.
  문맥 간 import와 중복 소유권은 미해결로 남기며 직접 명시 typed client sink는 dynamic 위치 후보를 보존한다.
  schema도 같은 entry/import closure를 사용하며 범위 변화와 준비 예산은 `docs/CONFIG-SCOPE.md`에 기록한다.

- schema: Windows의 네이티브 경로와 TypeScript가 정규화한 경로를 같은 스캔 입력으로 조회한다. ORM·드라이버
  import가 전역 이름으로 잘못 분류되어 관계 사실이 누락되던 문제와 이미 분석한 SQL을 미분석으로 다시 세던
  문제를 고친다. 잘못된 tsconfig도 내부 예외 대신 기존 unreadable 한계로 남긴다. 입력 집합 밖 파일은 계속 읽지 않는다.
- Next convention 선언·graph 진입점에 compiler entry 범위를 적용한다. 제외된 파일의 import 의존성은 보존하되
  convention 진입점으로 승격하지 않으며 제외 수와 런타임 미평가 한계를 남긴다.
- navigation: owned import·default export·재내보내기·const 별칭의 공유 route 배열에서 경로/화면 후보를 복원하되
  외부 변경이 미평가이므로 dynamic으로 유지한다. 무인자·단일 fresh literal 반환 factory만 실행 없이 읽는다.
  쓰기·unknown escape·효과/재귀·공유 반환·shallow freeze는 정적 증명으로 쓰지 않는다. 교환 필드·버전은 유지한다.
  factory가 공유 children 별칭을 반환하면 호출 간 변경을 배제하지 않고 null/dynamic으로 남긴다. Next 진입 비교는
  TypeScript host의 파일시스템 대소문자 규칙을 따르며 case-sensitive 시스템의 별개 파일을 합치지 않는다.
- routes client: primitive 반환값을 저장하는 무관한 클래스 필드 변경이 전체 mutation 분석을 미완으로 만들지 않는다.
  실제 receiver·baseURL·method·alias 변경과 unknown escape는 계속 dynamic으로 남긴다. 알려진 typed sink는 변경·escape
  뒤에도 위치를 보존하며 모델 동사는 runtime 보장이 아닌 선언 근거다. 미완 원인 수와 상대 위치, 구문 오류 위치를 알린다.
  생성자 별칭의 prototype 변경과 외부 인스턴스의 필드 쓰기도 선언 심볼로 연결하며 다른 클래스는 오염시키지 않는다.
- client model: `base` 생략만 빈 문자열을 기본값으로 사용한다. null·숫자·위험 값은 JSON pointer와 입력 오류를 유지한다.
- graph·Node/client routes·navigation: tsconfig `files`·`include`·`exclude`로 진입 파일을 고르고 import 의존성 closure와 구분한다.
  `.pnp.*` loader와 TypeScript 소스 옆 중복 JS 진입을 제외한다. 모호한 설정·project reference 소유권은 정적 간선을
  확정하지 않고 미해결 import와 limitation을 낸다. 분리된 타입 문맥 사이의 타입 API 호환성은 아직 검증하지 않는다.
- navigation: 입력 배열의 `for...of` children 재귀를 바깥 등록에만 귀속해 중복 dynamic 사실을 줄인다. splat 경로와 상대 자식은
  router 의미가 미확정인 dynamic 사실이다. 명시적 `lazyScreen` 모델의 literal import는 실행 없이 화면 후보를 붙이되 dynamic을
  유지한다. export const 배열은 불변으로 승격하지 않는다. README의 client 미구현 문구를 현재 동작에 맞게 고쳤다.

- `schema`의 SQL 관계 스캔이 앞선 단어와 괄호 짝을 한 번만 계산해, 세미콜론 없이 `INTO`·`ON`이 반복되거나 괄호가 닫히지
  않은 대형 SQL 리터럴·파일도 어휘 수에 비례한 시간에 끝난다(출력 같음).

- `schema`가 Drizzle·TypeORM 지정자가 없는 프로젝트에서는 두 ORM의 선언 탐색을 건너뛴다. `drizzle.config.*`의 casing은
  그대로 읽는다(출력 같음).

- `schema`가 모듈 export 표와 Drizzle 관계형 쿼리 스키마 표를 파일·스키마마다 한 번만 만들어, `import * as schema`·
  `drizzle(client, { schema })` 앱의 사용 스캔이 테이블 수에 비례해 느려지지 않는다(출력 같음).

- `reach`·`impact`가 정점 id를 정수로 바꿔 순회하고 근거 등급 비교 버퍼를 재사용하며 지배 판정을 정점당 상수 시간에 해,
  root 수백~수천 개 순회가 3~4배 빨라진다(출력 같음).

- `graph`가 노드·간선 레코드를 고정 키 순서로 바로 직렬화하고 JSON 형식도 레코드 하나를 한 조각으로 내, 대형 그래프의
  NDJSON 출력은 약 2배, JSON 출력은 약 4.5배 빨라진다(출력 바이트 같음).

- graph·reach·impact: 반사적 쓰기 대상(`Object.assign(this, …)` 등)의 정체성을 resolver마다 한 번만 계산하고
  해석 결과가 노드일 때만 겹침을 따진다. 그런 대상이 많은 프로젝트에서 직접 간선 수집이 호출 수 × 대상 수로
  느려지지 않는다. 출력은 같다.

- schema: import 해석이 package.json 정보를 실행 내내 한 번만 읽고 없는 경로를 예외 없이 판정한다. Prisma가
  없어도 import가 많은 프로젝트의 schema 명령이 빨라진다(합성 1만 파일에서 약 9초 → 2.6초). 출력은 같다.

- routes server·graph(reach·impact 포함): 루트 잠금 파일(`package-lock.json`·`npm-shrinkwrap.json`·
  `pnpm-lock.yaml`·`yarn.lock`)을 확인하는 프레임워크마다 다시 파싱하지 않고 파일마다 한 번만 색인한다. 수 MiB
  잠금 파일에 프레임워크를 여럿 선언한 프로젝트가 빨라진다. 주 버전 판정은 같다.

- routes server·graph: path-to-regexp 8 경로 컴파일이 파라미터나 끝이 아닌 `/`가 많은 긴 경로에서 길이의
  제곱으로 느려지지 않는다. 출력은 같다.

- schema: SQL 텍스트 관계 추출이 같은 `;` 문장 안의 CTE 이름(`WITH recent AS (…) SELECT * FROM recent`),
  함수 인자 안의 FROM(`EXTRACT(YEAR FROM created_at)`·`TRIM(BOTH ' ' FROM name)`·`SUBSTRING(name FROM 2 FOR 3)`),
  `IS [NOT] DISTINCT FROM`의 피연산자를 relation-use로 내지 않는다. 계열 생산자와 같은 공통 사례 14개(같은 SQL
  문자열과 기대 관계)로 고정했다. 그 자리의 바인드 플레이스홀더(`$queryRaw`의 `IS DISTINCT FROM ${value}`)도
  미해석으로 세지 않아 dynamic 사실과 `dynamic-relation-names:` 계수를 더하지 않는다. 그런 SQL이 거짓 관계
  (`recent`·`created_at`·`$1` 등)를 내 isthmus가 `relation-use-without-decl` error를 내던 문제다. 같은 규칙
  때문에 절 키워드가 아닌 단어 뒤 괄호 속 문장(`COPY (DELETE FROM t …)`)의 FROM과, 테이블과 같은 이름의 CTE를
  정의한 문장 안의 그 테이블 사용도 이제 관계로 나오지 않는다(README `SQL text`).

- routes client: 설정 변경 분석 예산(20,000단계)을 프로젝트 전체가 함께 쓰지 않고 질의(알 수 없는 호출 지점의
  인자·수신자, `new`, tagged template, 색인 지점)마다 따로 둔다. 질의 사이에는 방문 메모를 함께 쓰고, 단계마다
  전체 작업을 분석 소스 문자당 8단계로 묶으며, wrapper 재검사도 프로젝트 총횟수 20,000 대신 호출 지점당
  200회차로 센다. 파일이 수백 개를 넘는 프로젝트에서 HTTP와 무관한 파일 수만으로 axios·ky·init을 준 fetch 호출이
  모두 `channel: null`이 되고 wrapper 경유 호출이 문서에서 사라지던 문제다(합성 1,000~10,000파일: 정적 사실
  0개 → 파일당 4개). 고정 예산을 넘는 질의 하나는 지금처럼 변경 분석 전체를 미완(`route-call-coverage:`)으로 두고
  모든 axios·ky 클라이언트와 요청 설정을 dynamic으로 낸다.

- routes client: 변경 분석이 미완이어도 `--client-model` typed 호출을 버리지 않고 모델의 동사·`service`와
  `channel: null`·`pathAnchor: "base"`의 dynamic 사실로 남긴다. 예전에는 그 호출이 문서에서 사라졌다. 변경을
  확인한 수신자도 위치를 보존하는 dynamic 후보로 남긴다.

- schema: 파일 하나의 스캔을 마치면 그 파일의 구문 트리를 놓고, 파일 사이 단계에는 노드 없는 요약과 소스
  텍스트만 남긴다(트리가 다시 필요한 파일만 다시 파싱한다). 출력은 같다. ORM·SQL 드라이버 이름 해석 단계가 돌지
  않는 합성 프로젝트에서 최대 RSS가 5,000파일 1,020 MiB → 537 MiB, 20,000파일 3,496 MiB → 1,026 MiB로 줄고,
  힙 768 MiB에서 OOM(134)으로 끝나던 5,000·10,000파일 프로젝트가 끝난다. 지원 ORM·SQL 드라이버 패키지를
  import하거나 `D1Database`를 언급하는 소스가 있으면 그 단계의 Program이 모든 트리를 담으므로 그 단계의 최대
  메모리는 그대로다(README `Memory` 항목).

- schema·routes(server·client)·navigation·graph(reach·impact 포함): 구문 중첩이 400단을 넘거나 파싱이 호출
  스택을 넘긴 소스 파일은 그 파일만 분석에서 빼고 나머지를 분석한다(종료 0). 뺀 파일은 schema·graph
  `parse-errors:`, server `route-coverage:`, client `route-call-coverage:`, navigation
  `navigation-source-coverage:`로 알린다. Next.js route 파일은 건너뛰어 `route-coverage:`로 세고, 그런
  `next.config.*`·`prisma.config`는 읽지 못한 설정(`unresolved-route-prefix:`·`unresolved-prisma-config:`)이 된다.
  compiler Program을 쓰는 명령은 선언·패키지 입력에도 같은 상한을 두며, graph는 그런 입력이 있으면 coverage
  완전성을 주장하지 않는다. 예전에는 그런 파일 하나(괄호 수백 겹의 약 2 KB 파일, 640항 `||` 사슬 등)로 문서
  전체가 코드 2로 끝났다. 상한은 실측에서 TypeScript 바인더가 넘친 깊이(`||` 사슬 640단, Node 22)보다 넉넉히
  낮고 공개 npm 소스의 최대 깊이(약 220)보다 높다. 모양에 따라 예전에는 분석되던 깊이 401~1,000의 파일도 이제
  빠진다. 그래도 분석이 호출 스택을 넘기면 지금처럼 공용 문구로 코드 2다.

- graph·reach·impact·routes(Node 백엔드·client)·navigation: tsconfig/jsconfig의 `include`·`files`가 고르는
  compiler 루트 파일을 소스 걷기와 같은 정책으로 거른다. 프로젝트 안(graph는 `--workspace`를 주면 workspace
  안)만 쓰고, `node_modules`·`dist`·`build`·`out`·`coverage`·점 디렉터리 아래(graph는 Prisma 생성 출력 아래도)와
  symlink 경유는 빼며, 디렉터리 항목은 500,000개까지만 열거한다. 시작 디렉터리가 그 밖인 include 패턴과 밖의
  `files` 항목은 열거하지도 루트 파일로 쓰지도 않는다. 이름으로 적은 `files` 항목과 와일드카드 없는 include 경로가
  그 제외 디렉터리 안이거나 symlink를 거치는 경우도 쓰지 않는다(그 디렉터리에서 글롭이 고를 파일은 걷기처럼 세지
  않는다). 그 수와 열거 상한 도달은 `graph-config:`(server `route-coverage:`, client `route-call-coverage:`,
  navigation `navigation-project-coverage:`)로 알리며, graph는 그때 coverage 완전성을 주장하지 않는다. 그런 파일도
  프로젝트 소스가 import하거나 참조하면 지금처럼 읽는다. 로컬 빌드 산출물이 Program에 들어가 수 배 느려지거나(합성
  build/ 3×3 MB: 1.34초 → 0.47초), 4 MiB를 넘는 번들 하나가 `oversized-compiler-inputs:`로 bound 디스패치를
  끄거나, 상위 글롭(`../../**/*`)이 프로젝트 밖 트리를 열거·로드하던 문제다.

- graph·reach·impact·routes(Node 백엔드·client)·navigation: tsconfig/jsconfig가 없거나 읽지 못해 기본 옵션을 쓸
  때 자동 타입 루트(`node_modules/@types`)를 실행 위치가 아니라 프로젝트 루트와 그 상위에서 찾는다(설정이 루트에
  있을 때와 같다). 실행 위치에 따라 타입 해석·외부 호출 판정이 달라지고 프로젝트 자신의 `@types`가 쓰이지 않던
  문제다.

- graph·reach·impact: Node 백엔드 프레임워크(Hono·Express·Fastify·Koa·NestJS)를 감지한 프로젝트는 routes와 같은
  테스트 경로 규칙으로 production·test 프로그램을 나눈다. `*.test.*`·`*.spec.*`·`__tests__/`·`__mocks__/`에 더해
  `test/`·`tests/`·`e2e/` 아래와 `*.e2e-spec.*`·`*.e2e.*`도 테스트 소스다. Next.js 라우터 디렉터리(`app`·`pages`
  또는 `src/app`·`src/pages`) 안은 지금처럼 Next 규칙이라 `app/api/test/route.ts`는 운영 소스로 남는다. `test/`
  아래 목이 운영 bound 간선을 막아 reach가 비고 `unresolved-calls:`만 남거나, 테스트 클래스가 운영 reach에
  bound로 섞이던 문제다. 프레임워크를 감지하지 못한 프로젝트(Next 전용·라이브러리)는 그대로다.

- navigation: `--project` 밖(직접이든 symlink로든)의 `--router-model`·`--tsconfig`는 입력 실패(2) 대신 사용
  오류(64)로 끝나고(openapi 스펙·routes client 모델과 같다), realpath가 `--project` 안이면 절대 경로
  `--tsconfig`도 받는다(예전 2). openapi·routes·schema·navigation·graph가 프로젝트·입력 파일 검증을 한곳에서
  하며, 밖 입력 파일 문구는 `tsograph: <입력> is outside --project; <해결 방향>`에 명령 사용법을 붙인 같은
  형식이다(routes client 모델 문구도 이 형식으로 바뀌고 코드 64는 그대로다). graph·routes client의 없는·읽지
  못하는·1 MiB를 넘는 `--tsconfig`는 지금처럼 2이며 navigation과 같은 문구를 낸다. navigation이 symlink로 고른
  `--tsconfig`는 이제 받은 경로의 디렉터리를 상대 옵션(`baseUrl`·`paths`·`include`·`extends`)의 기준으로 쓴다
  (`tsc -p`·graph·routes client와 같다). 예전에는 링크 대상의 디렉터리가 기준이었다. 그래서 대상 디렉터리 기준으로
  상대 옵션을 적은 링크 설정은 별칭·include 해석과 사실이 달라질 수 있고, limitation에 실리는 설정 이름도 링크
  이름이 된다. 대상 디렉터리 기준이 필요하면 실제 설정 경로를 `--tsconfig`로 준다. 링크가 아닌 설정은 그대로다.

### Fixed

- persistence 소스 reader가 파일을 연 뒤 같은 핸들에서 최대 4 MiB+1 바이트만 읽는다. 크기 확인 뒤 커진 파일도
  과대 입력으로 세고 사실을 내지 않으며, FIFO·비일반 파일과 지원 플랫폼의 마지막 파일 링크를 거부한다.

- 호출 그래프의 compiler host에도 파일별 4 MiB 읽기 상한을 적용한다. tsconfig 루트·전이 import·선언 파일이 수집기 제한을 우회하지 못하며, 생략된 compiler 입력을 한계와 불완전한 분석으로 알린다.

- Unicode와 긴 단일 JSON token·NDJSON 행도 출력 write의 64 KiB byte 상한을 지키며 surrogate pair를 보존한다.

- `schema`가 같은 타입 별칭을 여러 번 참조하는 합 타입 사슬이나 같은 인터페이스를 여러 경로로 상속한 선언을 참조마다
  다시 펼쳐, 1 KB 미만 파일 하나로도 수 시간 걸리던 문제를 고친다. ORM 값 평가가 타입·멤버 탐색 결과를 메모한다.
  순환 감지·깊이 상한으로 끊긴 값은 그 값이 기댄 문맥(그때 계산 중이던 선언, 아직 메모되지 않은 식)이 같을 때만 다시
  써서 사실과 limitation은 메모 전과 같다. 여러 선언이 서로의 `typeof`를 합 타입으로 참조하는 넓은 순환처럼 그 문맥이
  계속 바뀌는 입력은 다시 계산하는 횟수를 10,000회로 묶고, 넘으면 남은 값을 모르는 값으로 두어 새 limitation
  `orm-evaluation-truncated:`로 알린다.

- 서로를 `require`로 재수출하는 모듈을 이름공간 접근이나 `require` 구조 분해로 쓰면 `schema`가 스택 초과(종료 코드 2)로
  실패하던 문제를 고친다. 순환으로만 이어진 멤버는 모르는 값으로 두고 사실로 내지 않는다. require 사슬은 export마다 한
  번만 따라가므로, 모듈 고리가 커져도 시간이 지수적으로 늘지 않는다.

- schema: Prisma 설정·스키마·스키마 폴더·TypedSQL 위치를 루트부터 경로 요소마다 `lstat`으로 확인해 `prisma/`·
  `.config/`·`prisma/sql/` 같은 디렉터리 링크를 따라가지 않는다. 링크 하나로 프로젝트 밖 스키마·SQL이 저장소
  경로의 사실로 나가던 문제를 고치고, 막은 링크는 걷기와 중복 없이 `skipped-symlinks:`로 센다.

- schema: 프로젝트 루트나 그 조상으로 풀리는 Prisma generator `output`을 소스 제외·클라이언트 출처 판정에 쓰지
  않고 `unresolved-generator-outputs:`로 알린다. 모든 소스가 생성 클라이언트로 빠져 사실이 한계 없이 사라지던
  문제다.

- schema: `prisma-naming-unverified:`에는 확인하지 않은 버전 가운데 semver와 짧은 범위·태그 명세만 원문으로
  싣고, git·URL·파일 경로·npm 별칭 명세는 범주(`<git specifier>` 등)로 바꿔 10개까지만 적는다. 의존성 명세의
  자격 증명·절대 경로가 출력에 실리던 문제다.

- schema: import 해석기가 tsconfig/jsconfig·`extends`·package.json을 실제 경로가 프로젝트 안인 일반 파일만
  1 MiB까지 읽는다. 커밋된 큰 설정 파일이나 밖의 큰 파일로 가는 링크 하나로 V8 메모리가 바닥나(종료 134) 끝나던
  문제를 고친다. 상한을 넘거나 읽을 수 없는 설정·`extends` 파일과 프로젝트 밖으로 가는 설정 파일은
  `unreadable-module-configs:`로 알린다. 링크로 프로젝트 밖에 있는 `extends` 대상(저장소가 `--project` 위에 있는
  pnpm 워크스페이스 하위 패키지 등)은 프로젝트 위 경로의 `extends`처럼 그것만 건너뛰고 설정 자체의 `paths`·
  `baseUrl`은 그대로 쓴다. 프로젝트 안 링크(링크로 둔 tsconfig, 프로젝트 안 pnpm 저장소)는 따라간다.

- graph·routes client: 루트 `package.json`·`vercel.json`·`node_modules/next/package.json`·`.git` 메타데이터와
  client가 ky 주 버전을 읽는 `package.json`을 non-blocking으로 열어 일반 파일만 상한 안에서 읽는다. FIFO에서
  멈추거나 `/dev/zero`로 가는 링크를 끝없이 읽던 문제다. 루트 `package.json`·`vercel.json`은 symlink를 따라가지
  않으며, 읽지 못하면 기존 `bound-dispatch:`(열린 프로그램)·`entry-points:`·`route-call-coverage:` 한계로 알린다.

- routes server·graph: `require`·import 모듈 해석이 compiler host와 같은 4 MiB 상한으로 package.json을 읽는다.
  Node routes는 상한을 넘은 manifest를 거친 `require`를 추측하지 않고 미해석(`route-coverage:`)으로 둔다.
  routes·openapi는 크기 확인 뒤 커진 텍스트 파일·스펙을 상한+1 byte까지만 읽는다.

- graph·schema·routes·navigation: 모을 파일이나 내려갈 디렉터리 이름에 교환 형식이 금지하는 문자(C0·C1 제어
  문자, DEL, U+2028/U+2029, 짝 없는 서러게이트)가 있으면 건너뛰고 `unsafe-names:`(graph·schema)·
  `route-coverage:`(Node)·`route-call-coverage:`(client)·`navigation-project-coverage:`로 알린다. 그런 이름 하나로
  종료 0 문서가 isthmus에 통째로 거부되고 graph 스냅샷을 `reach --graph-file`이 다시 읽지 못하던 문제다. graph는
  이때 스캔을 불완전하다고 보고 bound를 확정하지 않는다.

- graph·routes·client·navigation: 걷기가 골랐지만 compiler가 읽지 못한 소스(권한, 걷기 뒤 삭제, 백슬래시
  이름)를 세어 graph는 `unreadable-sources:`와 열린 프로그램으로, Node routes·client·navigation은 각 coverage
  한계로 알린다. 읽지 못한 구현을 두고 bound를 확정하거나 라우트가 빠진 문서를 한계 없이 내던 문제다.

- routes server·client·navigation: tsconfig/jsconfig 해석 실패(기본 옵션 사용)와 4 MiB를 넘은 compiler 입력을
  graph와 같은 원인 문구로 각 coverage 한계에 싣는다.

- routes·schema·graph(reach·impact 포함)·navigation: 깊이 중첩된 소스(생성·압축 코드의 긴 메서드 사슬·쉼표
  연결 등)로 분석이 호출 스택을 넘기면 원인과 해결 방향(그런 파일을 빼거나 나눠 다시 실행)을 담은 같은 문구로
  코드 2를 낸다. 예전에는 명령마다 internal error·출력 크기 초과·일반 분석 실패로 달리 보고했고,
  `routes --role client`는 분석 중 RangeError를 출력이 16,777,216자를 넘는다고 잘못 보고했다.

- routes server·graph: 사실 상한(100,000개)을 넘는 Node 프로젝트를 코드 2와 상한 문구
  (`more than 100000 route-decl facts`)로 알린다. 사실이 약 12만 개를 넘으면 출력 크기 초과로 잘못 보고하던
  문제와, 공유 하위 라우터를 여러 경로에 붙인 DAG(Express·Hono·Koa)를 다 펼치느라 V8 힙이 바닥나던 문제를
  고친다. 펼치면서 사실 수의 하한을 세어 상한을 넘는 즉시 멈추고, graph는 Next 라우트가 없는 Node 백엔드에서도
  사실 상한 초과를 `entry-points:` 한계로 알린다. 같은 사실로 합쳐지거나 사실을 내지 않는(조건부) 등록도 펼친 수가
  200,000개(사실 상한의 2배)를 넘으면 메모리를 지키려고 펼치기를 멈춘다. 이때는 사실 수가 아니라 펼친 등록 수를
  원인으로 든 문구(`more than 200000 route registrations`, 종료 2)와 그 원인의 `entry-points:` 문장으로 알린다.

- routes server·graph: Express mount 경로의 선택 그룹 대안이 단계마다 곱해져 작은 파일 하나로 V8 힙이 바닥나던
  (종료 134) 문제를 고친다. 이은 대안이 2,000개를 넘으면 늘어놓지 않고 상한 초과 dynamic
  (`route-template-expansion-capped:`)으로 내며, 정적 파일 같은 제공 경로 한계의 스코프는 싣지 않는다.

- routes server·graph: Hono 선택 파라미터가 많은 경로 한 줄이나 path-to-regexp 8(Express 5 등)의 수천 겹 중첩
  선택 그룹이 메모리나 호출 스택을 다 써 문서 전체가 실패하던 문제를 고친다. 그런 경로는 상한 초과 dynamic으로
  내고 다른 라우트는 그대로 낸다.

- routes server·graph: 같은 상수를 거듭 보간하는 상수 사슬이 경로 해석을 거듭제곱으로 늘려 1 KB 미만 파일로도
  분석이 끝나지 않던 문제를 고친다. 경로 값 하나는 4,096단계·이은 문자열 64 KiB 안에서 구하고, 넘으면 증명한
  앞부분만 dynamic 접두사로 쓴다. 큰 리터럴을 거듭 이어 internal error(RangeError)로 끝나던 문제도 함께 고친다.

- routes client: 같은 상수 사슬·query 꼬리 조건 사슬·큰 리터럴 보간이 URL 조각을 거듭제곱으로 펼쳐 멈추거나
  RangeError로 끝나던 문제를 고친다. URL 하나는 4,096단계, 템플릿·연결 하나는 1,024조각·리터럴 64 KiB까지만
  펼치고, 넘으면 URL 전체를 모르는 값(`channel: null`, `pathAnchor: "base"`)으로 낸다.

- graph·reach·impact: bound가 실패한 인터페이스 호출이 많은 대형 프로젝트(공개 패키지·데코레이터 DI)에서
  candidate 탐색이 모든 클래스를 대입 검사하다 TypeScript 관계 캐시 한도(RangeError)로 출력 없이 실패하던
  문제와, 기반 클래스가 순환하는(타입 오류) 프로젝트에서 탐색이 끝나지 않던 문제를 고친다. 메서드와 필수 멤버를
  가질 수 있는 클래스만 검사하고 결과를 수신자 타입별로 재사용한다. candidate 간선은 같다.

- 전체 제품 검사 한도를 CI job 15분 안의 12분으로 늘린다(이전 10분 안의 8분). GitHub ubuntu 러너가 같은
  테스트를 1.7~1.8배 느리게 돌면 정상 러너에서 5분 남짓인 전체 테스트가 8분을 넘겨 미완료(종료 2)로 끝나던
  문제다. 제품 테스트는 모두 실행하며 라인·함수·분기 커버리지 기준 90%를 유지한다.

## [0.10.0] - 2026-10-09

### Added

- source-owned 등록 함수를 설정해 화면 URL과 정확한 그래프 심볼을 `navigation-facts`로 내보낸다. 동적·변경·모호한 등록은 추측하지 않고 한계로 남긴다.

- 선언 identity로 확인하는 명시적 typed HTTP client 모델을 제공한다. 주입형 transport의 동사·경로 인자·base·service를 JSON으로 지정하고 불명확한 수신자는 추측하지 않는다.
- graph CLI의 JSON 스트리밍·NDJSON, 명시 compiler config·workspace 경계 및 저장 그래프의 소스 없는 reach/impact를 제공한다. 캡처 출처와 모드별 한계를 보존한다.
- 구문 오류의 제한된 상대 파일 목록, 간접 호출의 관찰된 식 형태별 통계, PnP 전용 환경 한계를 제공한다.

### Fixed

- 빌드 URL 토큰과 미상 선행 URL 값에서 복원한 경로는 dynamic으로 남긴다. 모델 선택은 파일 순서 대신 선언된 별칭 identity를 우선한다.
- 저장 그래프·모델 읽기에 byte 상한을 적용하고, JSON 숫자는 원문 suffix를 복사하지 않고 읽는다.

## [0.9.0] - 2026-10-08

### Changed

- 승인된 확장 carrier 규칙에서 증명하지 못하는 dependency의 property·conditional 반환 및 인라인 할당은 이전 bound 대신 candidate와 rejection limitation으로 남는다. 확장 증명 실패 뒤 legacy 증명을 재시도하지 않는다.
- 번들 TypeScript SDK AST는 내용 해시·컴파일러 옵션·format을 확인하는 제한된 DocumentRegistry로 재사용한다. 프로젝트 AST·checker·manifest·인증서는 공유하지 않으며 캐시 lease 정리와 fresh host 요청을 보존한다.

### Added

- `thttp` 같은 프로젝트 함수·불변 별칭·닫힌 객체 메서드의 직접 HTTP 전달을 실제 호출 인자로
  해석한다. canonical 참조·탈출 색인과 bounded 별칭/호출 요약·변경 재검사를 사용하고,
  표현하지 못한 진입의 내부 dynamic 요청을 보존해 경로 누락과 잘못된 정적 호출을 막는다.
- JSON 문서의 들여쓰기만 출력 상한을 넘으면 사실 손실 없이 정렬된 압축 표현으로 내보낸다.
  기존 소비자 상한과 사실 수 제한은 유지하고, 실제 데이터가 너무 크면 부분 성공으로 숨기지 않는다.

- 직접 primitive 객체·배열 리터럴의 불변 confined 별칭·기존 canonical own-slot 쓰기·인증된 읽기와
  primitive 반환을 helper·carrier·의존 메서드 효과 증명에 연결한다. 같은 완료 인증서로 mutation의
  수신자, 배열 별칭·참조와 마지막 site record를 검증하며 위치 whitelist나 다른 root의 권한을 빌리지 않는다.
- 인증서 발급은 실제 분석기의 등록된 primitive-effects recipe·root·문맥에 묶는다. 범용 DAG의
  완료 결과를 발급 권한으로 쓰지 않고, 캐시 값 공개 전에 proof·슬롯·쓰기·별칭·참조의 비공개
  snapshot을 보관해 공개된 witness와 collection의 변경으로 권한이 옮겨지지 않게 한다.
- 초기화·대입 값의 출처와 inert 평가, 모든 참조와 실제 진입을 감사한다. hole·spread·길이 변경·새
  슬롯·accessor·동적/중복 키·탈출·prototype/intrinsic 변경·알려진 반사·불안정한 endpoint·미대응
  효과는 보수적으로 남기며 타입·`as const` 표기로 런타임 소유권을 추측하지 않는다.
- carrier·의존 메서드의 필수 identifier 매개변수를 실제 모든 호출의 primitive 출처·inert 평가·정확한
  인자 수와 완료된 summary 구체화로 증명한다. 인자 평가는 왼쪽부터 감사하며 interface·type-literal
  뒤의 실제 singleton 생성과 endpoint를 타입 주석 대신 구조·descriptor 근거로 확인한다.
- type-only 참조와 runtime 호출을 분리하고, 각 메서드·exported arrow·동기 wrapper의 실제 진입에서
  캡처와 binding 초기화 순서를 검사한다. 캡처 없는 조기 alias 호출도 인증을 막으며, wrapper의 바깥
  로컬·imported 호출까지 효과 위치에 연결한다.
- 이름 있는 동기·수신자 없는 primitive helper의 필수 identifier 인자·선행 불변 지역 변수·캡처·
  인증된 helper 합성을 proof DAG로 증명하고 실제 carrier 효과 위치에서 소비한다. 캡처는 실제 사용마다
  초기화 순서를 확인하며 public 의존 메서드와 닫힌 default import도 같은 검사를 적용한다.
- helper 후보 표시는 효과 권한과 분리한다. 감싼 ambient 호출·보호된 객체 인자·지역 변수의 외부 속성
  호출은 인증을 막고, 기존 감싼 생성과 Date 수신자 호출은 보존한다. wrapper의 첫 물리 조회와 모델
  복사도 cold/warm 질의의 동일한 작업·깊이·frame 상한에 청구한다.
- 단일 최상위 exact-bag carrier 생성과 같은 모듈의 선행 sterile dependency를 전체 runtime census·
  binding 순서·descriptor·효과 모델로 증명한다. 미사용 의존 메서드까지 진입·본문을 감사하며,
  닫힌 fixture의 `Controller.run → Port.send`를 `bound`로 연결한다. 반복 생성은 일반 target union을 유지한다.
- 생성·저장·projection·지연 Date·호출과 기존 canonical own-slot 쓰기를 명명 모델로 대조한다.
  class member·인자·endpoint 순회도 기존 query cap과 cold/warm 작업 회계 안에서 검사한다.
- 전체·운영 소스의 독립 manifest와 실행 효과 목록을 대조하고 열거·참조/별칭 폐쇄·초기화 범위·ambient
  안전성을 분리한다. 누락·중복·오래된 색인·모듈 간선 및 실행 기록 불일치는 새 효과 인증을 막는다.
- 효과 목록 구축에 전체 방문 1,000,000개·보존 기록 1,000,000개·파일당 추가 노드 100,000개의 상한을
  적용한다. 반복 순회·참조/별칭/토큰 근거의 보존을 합산한다. 불완전한 목록은 `effect-inventory:` 한계로 알리고 기존 디스패치 질의 예산과 구분한다.
- 플랫폼 로더의 동적 접근·별칭·외부 전달을 불투명한 모듈 로드 근거로 보존한다. 제공된 색인 배열은
  길이를 고정한 제한 순회로 대조하며 잘못된 접근과 상한 초과로 범위를 인증하지 않는다.
- AST proof DAG의 성공·거부·불완전·순환·자원 초과를 구분하고, 문맥·allocation·의존 권한에 묶인
  인증서를 검증한다. cold/warm 질의는 거부된 의존성까지 같은 논리 비용으로 재생하고 공유 간선의
  깊이·식 frame을 검사한다. 호출자가 20,000단계·깊이 256·식 frame 400의 상한을 늘리지 못하게 한다.
- 의존 증명 실행 전 모드·권한 혼합을 거부한다. legacy 결과는 새 효과·confinement 권한을 발급하지 않으며,
  확장 실패를 legacy 재시도로 바꾸거나 내부 `RangeError`를 의미적 거부로 캐시하지 않는다.
- 정책 guard는 원래 작업 위치에서 예산·깊이·식 frame을 청구한 뒤 실행하고 질의별 판정 snapshot을
  같은 순서로 재생한다. 실패한 guard를 완료 방문으로 표시하던 경로를 닫아 같은 질의의 재시도에서도
  stale 인증서를 승인하지 않는다.

## [0.8.1] - 2026-10-05

### Fixed

- 생성자 carrier의 optional callback은 명시적인 own data 속성일 때만 기본값 선택을 증명한다. 상속된
  `toString`·`constructor`를 읽는 누락 키를 Date fallback으로 확정하던 경로를 미해석으로 보존한다.
- carrier 메서드의 매개변수 진입·암묵적 평가를 본문보다 먼저 감사해 default에서 instance가 외부로 전달되는
  경로를 막는다. 초기 runtime 매개변수·async/generator 및 증명하지 못한 평가를 보수적으로 거부한다.
- parameter-property·필드·메서드의 runtime slot 충돌과 prototype-sensitive 저장을 emit 방식에 기대지 않고 감사한다.
- 일반 선언 메서드의 target 조회는 carrier 필드·bag 격리와 분리해, inert한 직접 호출의 반환·지역 저장 및 호출 이후 await에서 기존 target을 보존한다. 조회 전의 모르는 효과는 계속 미해석이다.
- 다른 메서드의 수신자 탈출과 내부 호출 인자를 함께 감사하고, 이미 완료된 carrier 증명의 memo·wrapper 메서드 target을 보존한다. 실제 allocation의 계층·가장 가까운 runtime 멤버와 모순된 직접 target도 값 흐름으로 넘긴다.

## [0.8.0] - 2026-10-04

### Added

- 직접·반사·prototype mutation의 연산·수신자·키·인자 근거를 보존하고, mutator 값 탈출·불완전 별칭·legacy accessor를
  opaque로 유지한다. visible prototype 변경으로 과거 본문을 직접 확정하던 경로를 무효화한다.
- 닫힌 생성자 의존성 carrier와 mutation 부수효과 범위를 제한적으로 증명한다. instance/bag 탈출과 setter 위험,
  Date 기본값·projection 완전성을 확인하며 primitive 배열의 기존 own-index 쓰기도 엄격한 계약 안에서만 분리한다.
- genuine private native Map registry의 factory 반환값을 추적하고, 정확한 primitive 키만 제한적으로 일치를 좁힌다.
  모르는 키·iterator·escape·mutation·SDK 값은 불확실성을 보존하고 delete/clear는 가능한 값을 제거하지 않는다.

## [0.7.0] - 2026-10-03

### Added

- 설치된 Next.js 16.2.7 `next/cache`의 genuine `unstable_cache` wrapper 호출에서 원래 프로젝트 callback으로
  `bound` 실행 위임 간선을 낸다. named import·직접 namespace 멤버와 bounded immutable const wrapper 별칭만
  허용하며, SDK 버전·선언 provenance·관찰된 쓰기를 확인한다. cache hit로 실행이 생략될 수 있고, JSON을 거친
  반환 identity와 callback 매개변수 인자 흐름은 추적하지 않는다. 모르는 callback·변경·shadow·augmentation·
  optional/spread·open/opaque 경로는 미해석으로 보존하고 같은 이름의 일반 프로젝트 함수 흐름은 유지한다.

## [0.6.0] - 2026-10-02

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
