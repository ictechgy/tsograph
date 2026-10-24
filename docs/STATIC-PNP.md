# 정적 Yarn PnP 의존성 읽기

compiler 기반 `graph`·live `reach`/`impact`, Node/client `routes`, `navigation`은 프로젝트
안에서 가장 가까운 PnP 상태를 읽는다. `--workspace`가 있는 graph는 그 경계 안의 상태를 찾는다.
`.pnp.cjs`·ESM loader·의존성 JavaScript·package hooks·공장 함수는 실행하지 않는다.
분석용 파일이나 `node_modules`를 디스크에 만들지도 않는다.

Yarn의 [PnP specification](https://yarnpkg.com/advanced/pnp-spec)에 따른 지원 범위다.

- `pnpEnableInlining: false`의 `.pnp.data.json`을 우선 읽는다.
- 기본 인라인 방식은 최상위 `const RAW_RUNTIME_STATE`가 한 개의 불변 문자열/template literal일 때만 정적으로 읽는다. 문자열 안 JSON도 중복 key·깊이·값 수를 검증한다.
  함수 호출·문자열 결합·변수 참조·보간·변경 가능한 object literal·중복/변경 가능한 선언·잘린 구문은 평가하지 않는다. loader AST 생성 전 token 200,000개 상한도 적용한다.
- package locator, 의존성 alias, missing peer와 명시 fallback/exclusion을 구분한다.
  issuer가 접근할 수 없는 패키지나 불명확한 location을 다른 버전으로 추측하지 않는다. top-level fallback에 명시된 null peer도 pool의 다른 locator로 대체하지 않는다.
- TypeScript가 package `exports`, `types`, `typesVersions`, import/require 조건을 선택한다.
  명시 `paths`/`baseUrl`의 프로젝트 alias와 local `typeRoots`는 유지한다. `@/*`, `~/*`, `$lib/*`처럼 npm package-name 형태가 아닌 별칭도 이 규칙을 따른다. PnP metadata 자체가 불완전해도 이 로컬 별칭은 독립적으로 검증하고 metadata 한계를 함께 남긴다. 직접 접근 가능한
  `@types`를 열거하고 명시/삼중 슬래시 type reference에도 같은 의존성 신원을 사용한다.
- ZIP 내부 UTF-8 선언과 일반 디렉터리 패키지를 읽는다. `__virtual__/hash/depth`는 읽을 때만
  물리 위치로 사상하고 peer별 논리 파일 신원은 유지한다. TypeScript의 같은 이름/버전 package
  병합으로 서로 다른 virtual 위치를 합치지 않는다.

ZIP은 추출하지 않고 모든 항목을 검증한 후에만 파일을 제공한다. 중앙/로컬 이름·flags·압축
방식·크기·CRC가 같아야 하며 bit 3의 data descriptor는 서명 유/무 모두 CRC와 두 크기를 대조한다.
중앙/로컬 이름은 원시 byte도 비교하고 BOM을 제거해 다른 이름으로 바꾸지 않는다.
descriptor를 포함한 byte 구간 중복, 중복 이름, 파일/디렉터리 충돌, `..`·절대·역슬래시·제어
문자 경로, symlink 항목, 암호화·분할·ZIP64·알 수 없는 압축 방식과 별도 Unicode 이름 필드는 거부한다.
지원 방식은 store/deflate, 명시 UTF-8 이름 또는 ASCII 이름이다.

선택 프로젝트/workspace 밖의 global cache·package location·symlink 대상은 읽지 않는다.
프로젝트 내부 cache를 쓰거나 cache까지 포함하는 workspace를 고른다. 도구에 포함된 TypeScript
SDK lib만 경계 밖 예외다. Yarn 기본 SDK ignore 정규식의 확인된 형태는 `.yarn/sdks` 경로 비교로
처리한다. 임의 `ignorePatternData`를 JavaScript 정규식으로 실행하지 않으며 지원 밖 형태는
해당 정적 해석을 거부한다. 여러 독립 PnP 프로젝트를 한 compiler 문맥에 합치지는 않는다. PnP가 있는 경계에서는 ZIP의 global augmentation 부재를 증명하지 않았으므로 서로 다른 소유 설정의 global/type universe를 옵션이 같아도 나눈다. 문맥 사이 import는 기존 불완전성 한계와 함께 미해결일 수 있다.

자동 PnP 입력이 누락·불완전·지원 밖이면 정상 분석 결과에 `pnp-dependencies:` 원인 한계를
남기고 관련 import를 미해결로 유지한다. graph의 코드 0은 전체 의존성 완전성이나 실행 성공을
의미하지 않는다. 손상된 선택 ZIP 뒤에 실제 `node_modules`의 다른 버전이 있어도 대체하지 않는다. 선택한 ZIP이 삭제되거나 읽히지 않는 경우도 명시적 입력 한계이며 정상 조상 directory 존재 탐침과 구분한다.
현재 schema의 구문 기반 ORM binder는 스캔한 프로젝트 소스만 제공한다. ZIP의 의존성 선언이
schema 사실이나 그래프 정점으로 승격되는 기능은 아니다.

한 compiler 문맥에 적용하는 상한은 다음과 같다. 지원 밖 입력은 작게 나눠 분석하거나 정적
metadata/cache 구성을 단순화한다. 일반 분석은 입력이 안정돼 있다고 전제하며 파일시스템 전체의
원자적 snapshot을 만들지는 않는다. `change-impact`의 동결 입력 경계는 별도로 유지한다.

| 입력 | 상한 |
|---|---:|
| JSON 또는 loader 전체 | 4 MiB, JSON 깊이 32, 값 200,000, loader token 200,000 |
| package / dependency tuple | 10,000 / 100,000 |
| ZIP / 전체 압축 bytes | 32개 / 128 MiB |
| ZIP 하나 / 전체 해제 bytes | 압축 64 MiB / 해제 64 MiB |
| 항목 하나 / 항목 수 | 4 MiB / ZIP당 10,000 |
| 압축 비율 / 경로 깊이 | 1,000 / 64 |
| ZIP 이름 총 bytes·디렉터리 총 bytes | 각각 4 MiB |
| ZIP 디렉터리 수 | 50,000 |

`fixtures/pnp/yarn-generated`는 실제 Yarn 4.18.1이 scripts/network를 끄고 만든 두 합성 local
패키지의 JSON, ZIP, 인라인 literal header다. generation 설정과 archive SHA256을 함께 보존한다.
정상 타입 `"zip-peer"`·`42`, virtual peer, alias/전이 ZIP, 조건부 exports, local typeRoots와
실제 빌드 CLI의 외부 호출 3개/누락 의존성 0개를 대조한다. 사내 앱 재실행이나 모든 Yarn
환경의 호환성·성능을 입증한 결과는 아니다.

Node 요구 버전은 기존 `>=22.18.0`이다. `inflateRawSync`의 `maxOutputLength`는
[Node 22.18 문서](https://nodejs.org/download/release/v22.18.0/docs/api/zlib.html#class-options)에
있는 API이며 CRC32는 새 버전 API에 의존하지 않는다. 최소 버전과 실제 검증 runtime은 별도로 기록한다.
