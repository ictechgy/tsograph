# HANDOFF

세션을 이어받을 때 먼저 읽는 진행 상태 문서다. 작업 규칙의 정본은 [AGENTS.md](AGENTS.md)이고, 여기 적힌 상태는
실제 Git 상태·코드·검증 결과와 대조한 뒤 쓴다. 공통 규칙은 이 파일에 복제하지 않는다.

## 현재 상태 (2026-11-09)

- 발행본은 **0.11.0**이다. npm 게시(2026-11-03, `npm view tsograph version`으로 확인), 태그 `v0.11.0`, `package.json` 버전이 일치한다.
- isthmus `compatibility.json`의 tsograph 핀은 이 날짜에 로컬 isthmus 체크아웃 기준으로 **0.10.0**이다. isthmus가 게시본을
  검증한 뒤 바꾸는 절차이므로 tsograph 저장소에서 고치지 않는다.
- 열린 작업은 PR #57(브랜치 `ccr-37904670-hxdjsx`)이다. 2026-11-03 계열 9개 도구 검토의 tsograph 항목과 그 PR의 독립 리뷰
  지적을 반영했다. 변경은 모두 CHANGELOG `[Unreleased]`에 있고 발행 전이다.

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
| 선언 역매핑의 export 이름 대조 | 지금은 선언 emit 여부로만 거른다. 이름 대조는 산출물과 소스의 export 집합을 비교하는 별도 설계가 필요하다. |
| firebase식 중첩 manifest 좁히기 | 과보수인지 확신할 근거가 없어 열린 쪽(보수)으로 두었다. |
| 문맥이 다른 패키지 사이 산출물 import | 여전히 `config-context-boundary:`로 미해결이다. 문맥을 넘는 간선은 별도 설계다. |
| routes·schema·navigation의 산출물 되짚기 | graph 문맥 Program에만 적용했다. |

## 머지 뒤 다음 할 일

1. 0.12.0 릴리스. 출력이 바뀌는 변경(새 direct 간선, bound→candidate, 새 limitation 접두사)이 있으므로 마이너로 올린다.
   이전 릴리스 커밋(`chore(release): prepare tsograph 0.11.0`)처럼 `package.json`·`package-lock.json`·CHANGELOG를 함께 바꾼다.
2. isthmus에 게시본 검증과 `compatibility.json` 핀 갱신을 요청한다(isthmus 저장소의 일).
3. 위 제외 항목 중 사용자가 고른 것.

## 주의

- **리뷰 방식**: AGENTS가 요구하는 GLM 리뷰(`packet-ask`)는 PR #57 작업 환경에 도구가 없어 실행하지 못했다. 대신 독립
  Claude 리뷰를 받았고, 지적을 코드·fixture로 확인하고 회귀 테스트(구현을 되돌리면 실패하는지 확인)를 붙여 반영했다.
  다음 PR에서 GLM을 쓸 수 있으면 원래 절차로 돌아간다.
- **로컬 Git 버전**: `change-impact`는 Git 2.45 이상이 필요하다. 낮은 Git(예: 2.43)에서는 change 캡처 테스트가 이유와 함께
  skip되므로 그 경로는 CI 결과로만 확인된다. CI에서는 skip하지 않고 실패한다.
- **테스트 12분 상한**: `npm test`(`scripts/run-tests.mjs`)는 전체 suite를 12분에 끊고 "exceeded the 12-minute execution limit"로
  실패한다. 부하가 큰 머신에서는 상한을 넘거나 heap watchdog 테스트가 실패할 수 있다. 집중 실행은
  `nice -n 10 node --test --test-concurrency=2 <파일>`로 하고, 상한 실패를 코드 회귀로 단정하기 전에 단독 재실행으로 확인한다.
- **root 컨테이너**: `src/schema/relation-facts.test.ts`의 `chmod 000` 사례는 root에서 읽기가 막히지 않아 실패한다. 환경 문제다.
- **발행된 CHANGELOG 절은 고치지 않는다.** 새 항목은 `[Unreleased]`에만 쓴다.
