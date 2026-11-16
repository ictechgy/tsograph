# 패키지별 compiler 설정과 분석 범위

0.11 후보는 같은 workspace의 두 앱이 각각 `baseUrl: "./src"`를 쓰면 각 앱의 별칭을 해당 앱에서 해석한다.
import한 다른 패키지 내부의 별칭도 제공 파일의 설정으로 해석한다. graph, Node/client routes, navigation,
schema와 change-impact가 같은 파일 소유권 계획을 사용한다. Next 파일 convention의 진입 범위도 같은 계획이다.

소유권은 가장 가까운 tsconfig/jsconfig와 선택 설정의 명시 project references에서 결정한다. reference가
명시적으로 파일을 소유하면 그 설정을 사용하되 가까운 설정도 같은 파일을 진입 파일로 고르면 두 소유권을 비교한다.
서로 다른 유효 옵션의 설정이 같은 파일을 소유하거나
설정을 읽지 못하면 임의 선택을 확정하지 않는다. `extends`는 TypeScript의 bounded JSON 해석을 사용한다.
실행 코드, loader, PnP 스크립트, compiler plugin을 실행하지 않는다.

`baseUrl`·`paths`와 설정 파일 신원만 다른 옵션은 공유가 확인된 범위에서 하나의 Program으로 파일별 module resolver를 쓴다.
공유는 명시 `types: []`, 모두 external module인 소유 입력, global/namespace/module augmentation 및 triple-slash 없음,
스캔 밖 의존성 타입 반입 없음으로 제한한다. 사전 검사는 기본·import·require 모드를 모두 대조하며 어느 모드든 스캔 밖 선언이 읽히면 공유하지 않는다. 한 모드에서 미해결인 것을 global/ambient 입력 부재의 증거로 쓰지 않으며, NodeNext의 import-only exports도 포함한다. 같은 옵션이어도 전역 선언·ambient 입력 범위를 공유한다는 증거가 없으면
설정별로 문맥을 분리한다. PnP 경계에서는 ZIP의 global augmentation 부재를 아직 증명하지 않았으므로 옵션이 같은 서로 다른 소유 설정도 문맥을 분리한다. 자동 types 탐색을 쓰는 패키지 간 연결도 보수적으로 미해결일 수 있다.
나머지 분석 옵션(target, module/moduleResolution, strict 계열, JSX, lib/types, class field 의미 등)이 다르면
Program을 분리한다. 서로 다른 checker의 AST/Symbol을 교환하지 않으며 소유 파일의 문자열 ID 결과만 합친다.
module import뿐 아니라 triple-slash로 다른 문맥 소스를 읽는 경로도 host에서 거부하고 공백을 남긴다.
별도 문맥으로 가는 import는 아직 타입 API 호환성을 검증하지 못하므로 미해결이다. 그 경계의 caller는 graph에
미해결 호출로 남는다. 직접 named import의 const-new/명시 parameter 타입과 명시 HTTP 모델이 만나는 sink는
위치가 있는 dynamic 후보로 보존한다. 복잡한 re-export/receiver 흐름은 여전히 누락될 수 있으며 limitation이 남는다.
문맥을 나눈 client 분석은 다른 문맥에서의 receiver 변경을 배제하지 않아 알려진 client 요청을 보수적으로 dynamic으로 둔다.
Node server 문맥 사이의 전역 등록 순서는 증명하지 않는다.

workspace 패키지의 `exports`·`types`가 가리키는 프로젝트 안 선언 산출물은 declaration map, 산출물을 낸(선언을 내는) 설정의
`declarationDir`/`outDir`↔`rootDir`, 손으로 쓴 선언 옆 같은 이름의 JavaScript 구현 중 하나가 스캔한 소스 하나를 가리킬 때만 그 소스로
되짚는다. `outDir`/`rootDir` 대응은 배치만 보는 추론이므로 TypeScript 소스면 선언의 export 이름(값·타입·`default`·`export =`·`export *`가
끌어오는 이름)이 모두 그 소스에도 있을 때만 잇는다. 역매핑은 module 해석 중이라 checker가 없으므로, 이름 표는 TypeScript 파서로 최상위
export 문장만 읽어 만든다. `export *`는 그 설정의 module 해석(파일의 module 형식에 맞는 모드, 4 MiB bounded reader, 설정별 TypeScript 해석
캐시)으로 프로젝트 안 대상만 표 하나당 최대 1,024개 파일까지 따라간다. tsc는 지정자를 쓴 그대로 옮기므로 따라가지 않는 대상은 위치로
비교한다. 따라가지 않는 대상(읽지 않는 `node_modules`·프로젝트 밖 대상, 해석하지 못한 대상(tsc가 `outDir`로 복사하지 않는 손으로 쓴
`src/types.d.ts`), 읽지 못한 대상, JavaScript 대상, 파일 예산 밖 대상)은 소스의 같은 상대 위치에 같은 지정자가 있을 때 맞고, 외부 대상은
소스가 같은 파일을 다시 내보낼 때도 맞는다(지정자가 달라도 같은 파일이면 같다). 상대 지정자는 선언 루트 기준 위치를 소스 루트 기준으로
옮겨 비교하고, 절대 지정자는 두 쪽에서 같은 파일을 가리키므로 쓴 그대로 비교한다. 소스 쪽에도 이름을 읽지 못한 프로젝트 안 `export *`가
있을 수 있다(4 MiB 읽기 상한을 넘는 생성 소스와 그보다 작은 선언, 체크아웃에 없는 생성 소스와 남아 있는 선언, 예산 밖 barrel). 그러면
선언 쪽이 같은 위치에서 읽은 이름이 소스 표에 없으므로 위치만 비교하고 이름은 대조하지 않는다. 선언 파일 자체의 읽기·구문 깊이 실패는
맞다는 증명이 아니므로 잇지 않는다.

JavaScript 소스는 대조하지 않는다. tsc는 CommonJS 내보내기와 JSDoc 타입의 이름을 checker로 정해(`const api = { helper };
module.exports = api`, `module.exports = create()`, `var x = exports.x = …`, `if`·`try`·IIFE 안의 `exports.x`, 조건부
`module.exports = require(…)`) 최상위 구문만 보는 표는 맞는 소스를 틀렸다고 판정하기 때문이다. 소스 폐쇄에 JavaScript 모듈이 있으면
(소스 자신이나 `export *` 대상) 예전처럼 잇는다. 잇지 않은 import는 `graph-config: declaration-outputs:`에 export 불일치 수와 함께 세고
스캔을 불완전으로 본다. 이름이 맞지 않은 선언은 옆의 같은 이름 `.js`(그 산출물 루트의 빌드 출력)로도 돌리지 않는다.

남은 한계: 같은 이름을 모두 내보내는 다른 구현은 이름으로 구별하지 못하고, export 이름이 없는 선언(`export {}`, `declare global`만 있음)은
그 위치의 어느 소스와도 맞으며, 이름의 종류(값·타입)를 구별하지 않아 타입 전용 이름도 같은 이름의 값으로 맞는다. 대응 소스가
JavaScript이거나 읽지 못한 프로젝트 안 `export *`가 있는 덮어쓴 선언은 위치가 맞으면 알아채지 못한다. declaration map과 같은 이름 형제 근거는 이름을 대조하지 않으며 오래된 `.d.ts.map`은 그대로
믿는다. 이름이 맞지 않은 선언을 import하는 설정은 위 문맥 공유 검사에서 소유 파일 밖 선언을 읽는 것으로 보여 따로 문맥을 받을 수 있고,
그 경계를 넘는 import는 `config-context-boundary:`로 센다.

`files`/`include`/`exclude`는 진입 파일 선택이다. 제외된 파일도 정적 import/require 의존성이면 분석에 들어올 수
있다. schema는 기존 전체 파일 스캔 대신 이 entry/closure를 사용하므로 제외된 독립 파일의 사실 수가 줄 수 있다.
필요한 독립 파일을 포함하려면 소유 설정의 include/files를 명시한다. 제외 수를 완전성의 증거로 사용하지 않는다.
schema의 바인더는 타입 추론 없이 기존 scanned AST만 사용한다. standalone persistence의 루트 밖 extends는
읽지 않고 로컬 명시 별칭만 보존하며 부분 설정 한계를 알린다. frozen change capture에서는 외부 설정/소스 읽기를
계속 거부하고 compiler SDK의 제한된 lib 예외만 유지한다.

준비는 최대 128개 소유 설정과 모든 설정을 합쳐 500,000개 디렉터리 항목으로 제한한다. 원래 config 1 MiB/source 4 MiB 및
구문 깊이 제한도 유지한다. 가장 가까운 설정이 128개 예산 밖인 소스만 import를 보류하고 `config-budget:`으로 그 수를 알린다.
예산 안 설정이 소유한 소스는 계속 분석한다(상위 설정의 옵션·별칭으로 대신하지 않는다). 예산 밖 project reference는
어느 소스를 소유할지 모르므로 예전처럼 전체를 `config-ownership:` 불완전으로 본다. 총 문맥 수가 동시에 살아 있는 checker 수는 아니므로, 16개 문맥 또는 200,000개 후보×문맥을
넘었다는 이유로 모든 import를 보류하지 않는다. 소유권과 진입 선택·global/ambient 의미가 같은 문맥을 순차 처리한다.
큰 계획은 `ParseForTypeErrors`로 JS JSDoc 타입과 TS 타입 오류에 필요한 문서를 보존하고 문서 전용 TS 태그 AST만 생략한다.
일반 Program 생성의 ParseAll 계약과 SDK 캐시의 별도 정책은 유지하며 기존 AST의 문서·부모·심볼을 사후 삭제하지 않는다.
파일별 flow 임시 맵은 whole/production view로 즉시 병합한다. 독립 manifest와 실제 effect part는 계속 별도 수집하고,
예상 파일은 로드 성공 목록이 아니라 원래 소유 계획에서 얻으므로 누락 입력을 완전하다고 인증하지 않는다.
문맥 간 import·모호한 소유권·읽기/구문 실패와 실제 proof 예산은 미해결·불완전성으로 남긴다. 종료 0은 저장 성공이다.
독립 effect manifest의 실제 전체 quota(visited/records 각1,000,000)를 소진한 문맥은 모든 AST의 바인딩 쓰기 census 뒤
checker-selected 단일 본문의 ESM 함수 선언 호출만 잇는다. 파일당 visited100,000의 지역 cap도 유지하지만, 파일 하나의 cap만으로
기존 지역 증명까지 일괄 중지하지 않는다.
쓰기 이름은 대상 선택이 아니라 보수적인 거부 필터다. merged 선언·타입 전용 별칭·관찰하지 못한 star export·namespace·
CommonJS·eval/with·불완전 census는 확정 함수 호출로 승격하지 않는다. 일반 멤버·생성자·간접 호출·참조·export alias·
bound/candidate dispatch는 이 부분 경로에서 인증하지 않으며 모드별 unresolved 계수와 한계·stderr 경고에 남긴다.
부분 reference map을 ValueFlow에 전달하지 않으며 cap에 이르지 않은 문맥의 기존 분석은 유지한다.
숫자 호출 진단은 각 모드의 실제 공백을 합산하며 다른 지역 한계에는 compiler-context 범위를 붙여 중복 제거로 수를 잃지 않는다.
이 경계는 전체 runtime/빌드 설정 조합의 호환성 증명이 아니다.

회귀는 두 앱 baseUrl, cross-package 반환 타입의 내부 alias, strict/target/JSX/lib/types 분리, 같은 디렉터리의
서로 다른 reference, 중복/누락/순환 reference, include/dependency closure, typed dynamic sink, server 문맥,
실제 Git before/after, frozen 외부 extends, 예산 초과, 선언 산출물의 export 이름 불일치(번들러 덮어쓰기, `lib` 산출물 루트의
빌드 출력 형제)·부분집합·재내보내기·CommonJS 소스 모양·손으로 쓴 `src/*.d.ts` 재내보내기·의존성 `export *`·소스 쪽에서 읽지 못한
생성 모듈·예산을 넘는 프로젝트 안 barrel을 합성 fixture로 검증한다.
사내 앱을 재실행한 결과는 아니다.
