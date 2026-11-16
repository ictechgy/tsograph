# HANDOFF

세션을 이어받을 때 먼저 읽는 진행 상태 문서다. 작업 규칙의 정본은 [AGENTS.md](AGENTS.md)이고, 여기 적힌 상태는
실제 Git 상태·코드·검증 결과와 대조한 뒤 쓴다. 공통 규칙은 이 파일에 복제하지 않는다.

## 현재 상태 (2026-11-15)

- 발행본은 **0.11.0**이다. npm 게시(2026-11-03, `npm view tsograph version`으로 확인), 태그 `v0.11.0`, `package.json` 버전이 일치한다.
- isthmus `compatibility.json`의 tsograph 핀은 이 날짜에 로컬 isthmus 체크아웃 기준으로 **0.10.0**이다. isthmus가 게시본을
  검증한 뒤 바꾸는 절차이므로 tsograph 저장소에서 고치지 않는다.
- PR #57은 2026-11-09에 `main`으로 스쿼시 머지됐다(`9795858`). 2026-11-03 계열 9개 도구 검토의 tsograph 항목과 그 PR의
  독립 리뷰 지적을 반영한 것이다. 변경은 모두 CHANGELOG `[Unreleased]`에 있고 아직 발행하지 않았다.
- `main` `9795858`의 CI 체크 6개가 모두 성공했다(2026-11-10 확인).
- 2026-11-15: 브랜치 `ccr-37904670-hxdjsx`(`origin/main` `13971a4` 기준)에 PR #57 후속인 **선언 역매핑 export 이름 대조**를
  커밋했고(PR #59), 같은 날 그 PR의 독립 리뷰(B1·B2·S1·S2·S3·nit)를 반영해 커밋을 더했다. 아직 push 전이고 CI 결과가 없다.
  변경은 CHANGELOG `[Unreleased]`에 있다.

## 선언 역매핑 export 이름 대조 (2026-11-15, PR #57 후속, PR #59)

- `declarationDir`/`outDir`↔`rootDir` 경로로 잇기 전에 선언의 export 이름(값·타입·`default`·`export =`·`export *`가 끌어오는 이름)이
  모두 그 TypeScript 소스에도 있는지 본다(`src/graph/declaration-exports.ts`). 역매핑은 module 해석 hook 안이라 checker가 없어서
  TypeScript 파서로 최상위 export 문장만 읽고, `export *`는 그 설정의 module 해석(파일 module 형식에 맞는 모드, 4 MiB bounded reader,
  설정별 `ts.createModuleResolutionCache`)으로 프로젝트 안 대상만 표 하나당 1,024개 파일까지 따라간다.
- 따라가지 않는 `export *` 대상(읽지 않는 `node_modules`·프로젝트 밖 대상, 해석·읽기 실패, JavaScript)은 위치 키로 비교한다. 소스의 같은
  상대 위치에 같은 지정자가 있으면 맞고(tsc는 지정자를 쓴 그대로 옮기고 손으로 쓴 `src/*.d.ts`를 `outDir`로 복사하지 않는다), 외부 대상은
  같은 파일로 해석하면 지정자가 달라도 맞는다.
- 소스 폐쇄(자신이나 `export *` 대상)에 JavaScript가 있으면 대조하지 않고 잇는다. tsc가 CommonJS·JSDoc 이름을 checker로 정해 구문 표가
  맞는 소스를 틀렸다고 판정하기 때문이다(리뷰 B2의 option a). CommonJS·JSDoc 구문 이름 읽기(비공개 `jsDoc` 속성 사용 포함)는 지웠다.
- 빠진 이름이 있거나 선언 이름을 확정하지 못하면(선언 파일 읽기·구문 깊이 실패, 파일 예산 초과) 잇지 않고 기존
  `graph-config: declaration-outputs:`에 센다. 문장에 `N of them reach a source through declarationDir/outDir and rootDir that does not
  export every name …`가 붙는다(`ProgramConfigStatus.declarationOutputExportMismatches`). 불일치 선언은 옆의 같은 이름 `.js`(산출물
  루트의 빌드 출력)로 돌리지 않는다. import 수·파일 목록·불일치 수는 import 키별 마지막 판정 하나에서 센다.
- declaration map과 손으로 쓴 선언 옆 같은 이름 JavaScript 형제는 이름을 대조하지 않는다. 남은 통과 사례(README·CONFIG-SCOPE에 적음):
  같은 이름을 모두 내보내는 다른 소스, export 이름 없는 선언, 종류를 구별하지 않는 이름, JavaScript 소스를 덮어쓴 선언, 오래된 `.d.ts.map`.
  불일치 선언을 import하는 설정은 문맥 공유 검사(`isModuleOnly`)에서 소유 파일 밖 선언을 읽는 것으로 보여 문맥이 나뉠 수 있다.
- mapper 하나를 문맥 분리 판정과 모든 문맥이 함께 쓴다(`CompilerContext.declarationOutputs`).

### PR #59 독립 리뷰 반영 (2026-11-15)

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| B1 불일치 선언이 같은 이름 빌드 출력 `lib/index.js`로 조용히 이어짐 | 고침(`19c3e9e`) | outDir `lib` + 스캔되는 `lib/index.js` 끝까지 테스트, 수정 전 실패 |
| B2 CommonJS 소스의 맞는 간선을 잃음 | option a로 고침(`017fda2`) | 실제 tsc emit 11개 모양 mapper 테스트, 5개 모양 끝까지, TS의 CommonJS 재내보내기, 수정 전 7개 실패 |
| S1 `export *` 폐쇄가 손으로 쓴 `src/*.d.ts`·의존성 폐쇄에서 불완전 | 고침(`34f3c19`) | 손으로 쓴 types, 깨진 의존성 폐쇄, 4 MiB·1,100개 barrel 의존성, 다른 지정자 같은 대상, 수정 전 4개 실패 |
| S2 문맥마다 재파싱·해석 캐시 없음 | 고침(`68af192`) | 출력 바이트 동일 확인, 측정은 아래 |
| S3 문서·PR 설명 부정확 | 고침(`8c519dd`) | — |
| nit `.jsDoc` 비공개 속성 | B2에서 그 코드를 지워 해당 없음 | — |
| nit Set/Map 불일치 | 고침(`de8ec65`) | `.mts` import/require 모드 사례, 수정 전 실패 |
| nit `isModuleOnly` 부작용·남은 통과 사례 문서화 | 고침(`8c519dd`) | — |

- 성능(합성: 300개 선언이 같은 500파일 barrel을 `export *`, 공유 4코어 load 5~6에서 다시 잼): mapper 하나 CPU 3.84 s → 0.30 s,
  graph 전체 wall 11.3~11.5 s → 3.8~4.7 s(CPU 11.3~11.6 → 4.0~4.4 s, main 2.9~3.1 s). 파일별 해석 memo(`34f3c19`, 이 시점 4.5~4.7 s)가
  대부분이고 해석 캐시·mapper 공유가 나머지다. 네 분석기의 출력은 바이트 단위로 같다. 측정 도구는 커밋하지 않았다.
- 하지 않은 것: B2 option b(JavaScript 열린 표). 별칭·인자 전달·연쇄 할당 등 탈출 경로를 모두 닫아야 건전한데 반례 corpus가 없다.
  그래서 JavaScript 소스를 덮어쓴 번들러 선언은 예전처럼 알아채지 못한다. 선언 산출물 import 수를 모드별로 세는 것도 기존 의미를 바꾸므로
  하지 않았다.
- 검증(2026-11-16, Node 22.23.4, TypeScript 5.9.3, Git 2.43, root 컨테이너, 다른 세션으로 load 10~24):
  - `npm run typecheck` 통과, `npm run verify:cli` 통과(`Build contract verified: clean dist output.`, `CLI contract verified: 0/2/64`).
  - `npm test`: 12분 상한 초과로 종료 2(끊기 전 보고된 최상위 315개 중 실패 1개: `schema-command` 힙 사례, 부하). 같은 인자를 상한 없이
    돌린 전체 suite(18분 57초): 1,787개 중 1,762 통과·23 skip·2 실패. 실패는 `dispatch.test.ts` 600모듈 메모 사례(부하 중 38초, 단독
    재실행 3.5초 통과)와 `relation-facts.test.ts` `chmod 000` 사례(root 환경, `runuser -u nobody`로 통과). 커버리지 라인 98.68%·분기
    91.59%·함수 98.21%(90% 게이트 통과), `declaration-exports.ts` 100/97.87/100, `declaration-outputs.ts` 100/94.92/100.
  - 자기 분석(`graph --generated-at 2026-11-15T00:00:00Z`): 새 분석기를 `d418e9e` 트리에 돌린 결과는 `d418e9e` 분석기 결과와 바이트 단위로
    같다. 새 트리(같은 위치의 worktree)와 비교한 차이는 모두 바뀐 다섯 파일 안이다: 노드 10,097 → 10,128, 간선 14,614 → 14,679(바뀐 파일을
    건드리지 않는 간선 변화 0), `bound-dispatch` 738 → 740, `unresolved-calls` 4,544 → 4,550(indirect 3,515 → 3,521), external 호출
    25,722 → 25,836. 실제 저장소 경로에서 돌린 결과는 worktree 결과와 노드·간선·통계가 같고, worktree의 `node_modules` symlink 때문에 생기는
    `skipped-symlinks: 1`·문맥별 `effect-inventory` 줄만 다르다.
  - isthmus `scripts/conformance-drift.mjs tsograph=…`: 모든 벡터 current.
  - 실행하지 못한 것: GLM 리뷰(`packet-ask` 없음), Git 2.45+ change 캡처 테스트(로컬 skip), macOS·Windows·Node 24/26 job(CI).

## PR #57에서 처리한 것

- **선언 산출물 역매핑**: workspace 패키지의 `exports.types`가 프로젝트 안 `dist/*.d.ts`를 가리켜도, declaration map·
  `declarationDir`/`outDir`↔`rootDir`·손으로 쓴 선언 옆 JS로 소스 하나를 증명할 때만 그 소스로 잇는다
  (`src/graph/declaration-outputs.ts`). 증명하지 못하면 `declaration-outputs:`로 알리고 열린 쪽으로 본다.
  - 리뷰 반영: 선언을 내지 않는 설정(`declaration`·`composite`·`emitDeclarationOnly` 없음)은 산출물 루트가 아니다. 제외·점(`.`)
    디렉터리의 `.d.ts`는 산출물이 아니다. `preserveSymlinks`의 `node_modules` 경로는 프로젝트 안이면 realpath로 본다.
- **중첩 공개 패키지**: 파일마다 가장 가까운 `package.json`으로 공개 여부를 본다. 리뷰 반영으로 형식 표식 manifest
  (`{"type":"module"}`처럼 이름·private·진입점이 없는 것)는 건너뛰어 위로 계속 찾고, 공개 파일이 재내보낸 모듈도 연다.
- **설정 예산**: 128개 예산 밖 설정이 소유한 소스만 보류하고 `config-budget:`으로 알린다. 리뷰 반영으로 소유권 계획이
  불완전해서만 막은 소스는 `config-conflict:`가 아니라 `config-ownership:`에 개수로 센다.
- **모르는 compiler 옵션 값**: 그 옵션만 버리고 나머지를 쓴다(`compiler-options:`). 리뷰 반영으로 버린 `module`·
  `moduleResolution`은 짝이 Node 모드면 NodeNext, 아니면 ESNext·bundler로 근사하고, 해석 옵션을 버리면 스캔을 불완전으로 본다.
- **mutation guard**: `with`·`vm`·원격/`data:` import·문자열 timer handler가 있으면 clean-view 증명을 닫는다. 리뷰 반영으로
  timer의 `any`·`unknown`·별칭·문자열 키 우회를 닫고, 프로젝트가 구현한 같은 이름 메서드와 타입 전용 `vm` import는 열지 않는다.
- **문서·CI·테스트**: README 예제 수정(`--roots-from`, NUL 구분 `impact` 예시), clean-view 조건·Git 2.45 요구 문서화,
  Node 24·26과 `npm pack` 설치 CLI 계약 CI, Git 2.45 미만 로컬의 change 캡처 테스트 skip(CI에서는 skip하지 않음),
  isthmus `c76e105` 적합성 벡터 재반입.

## PR #57에서 제외한 것 (이유)

| 항목 | 이유 |
|---|---|
| 테스트 시간 상한 완화 | CONTRIBUTING의 성능 게이트 유지 원칙. `scripts/run-tests.mjs`의 12분 상한은 CI job 15분 안에 build·CLI 검증 시간을 남기려는 값이다. |
| 100줄 넘는 함수 리팩터 | 동작 이득 없이 수백 줄을 옮긴다. 별도 PR로 다룬다. |
| npm provenance·발행 workflow | 레지스트리 권한과 trusted publisher 설정(비밀)이 필요하다. |
| firebase식 중첩 manifest 좁히기 | 과보수인지 확신할 근거가 없어 열린 쪽(보수)으로 두었다. |
| 문맥이 다른 패키지 사이 산출물 import | 여전히 `config-context-boundary:`로 미해결이다. 문맥을 넘는 간선은 별도 설계다. |
| routes·schema·navigation의 산출물 되짚기 | graph 문맥 Program에만 적용했다. |

## 다음 할 일 (PR #57 머지 이후)

0. 브랜치 `ccr-37904670-hxdjsx`(PR #59)의 리뷰 반영 커밋을 push하고 CI(특히 전체 `npm test`·Git 2.45 경로)와 재리뷰를 받는다.
1. 0.12.0 릴리스. 출력이 바뀌는 변경(새 direct 간선, bound→candidate, 새 limitation 접두사)이 있으므로 마이너로 올린다.
   이전 릴리스 커밋(`chore(release): prepare tsograph 0.11.0`)처럼 `package.json`·`package-lock.json`·CHANGELOG를 함께 바꾼다.
2. isthmus에 게시본 검증과 `compatibility.json` 핀 갱신을 요청한다(isthmus 저장소의 일).
3. 위 제외 항목 중 사용자가 고른 것.

## 주의

- **리뷰 방식**: AGENTS가 요구하는 GLM 리뷰(`packet-ask`)는 PR #57 작업 환경에 도구가 없어 실행하지 못했다. 대신 독립
  Claude 리뷰를 받았고, 지적을 코드·fixture로 확인하고 회귀 테스트(구현을 되돌리면 실패하는지 확인)를 붙여 반영했다.
  PR #57은 GLM 리뷰 없이 머지됐다. 다음 PR에서 GLM을 쓸 수 있으면 원래 절차로 돌아간다. 2026-11-15 export 이름 대조 작업
  환경과 같은 날 PR #59 리뷰 반영 환경에도 `packet-ask`가 없어 GLM 리뷰를 실행하지 못했다(독립 Claude 리뷰 지적을 실제 tsc
  emit으로 재현한 뒤 반영했다).
- **로컬 Git 버전**: `change-impact`는 Git 2.45 이상이 필요하다. 낮은 Git(예: 2.43)에서는 change 캡처 테스트가 이유와 함께
  skip되므로 그 경로는 CI 결과로만 확인된다. CI에서는 skip하지 않고 실패한다.
- **테스트 12분 상한**: `npm test`(`scripts/run-tests.mjs`)는 전체 suite를 12분에 끊고 "exceeded the 12-minute execution limit"로
  실패한다. 부하가 큰 머신에서는 상한을 넘거나 heap watchdog 테스트가 실패할 수 있다. 집중 실행은
  `nice -n 10 node --test --test-concurrency=2 <파일>`로 하고, 상한 실패를 코드 회귀로 단정하기 전에 단독 재실행으로 확인한다.
- **root 컨테이너**: `src/schema/relation-facts.test.ts`의 `chmod 000` 사례는 root에서 읽기가 막히지 않아 실패한다. 환경 문제다.
- **발행된 CHANGELOG 절은 고치지 않는다.** 새 항목은 `[Unreleased]`에만 쓴다.
