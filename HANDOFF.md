# HANDOFF

세션을 이어받을 때 먼저 읽는 진행 상태 문서다. 작업 규칙의 정본은 [AGENTS.md](AGENTS.md)이고, 여기 적힌 상태는
실제 Git 상태·코드·검증 결과와 대조한 뒤 쓴다. 공통 규칙은 이 파일에 복제하지 않는다.

## 현재 상태 (2026-11-22)

- 발행본은 **0.11.0**이다. npm 게시(2026-11-03), 태그 `v0.11.0`, `package.json` 버전이 일치한다(2026-11-22 `npm view tsograph version`으로 다시 확인).
- isthmus `compatibility.json`의 tsograph 핀은 2026-11-22 로컬 isthmus 체크아웃 기준으로 **0.10.0**이다. isthmus가 게시본을
  검증한 뒤 바꾸는 절차이므로 tsograph 저장소에서 고치지 않는다.
- PR #57은 2026-11-09에 `9795858`로, PR #59(선언 역매핑 export 이름 대조와 그 독립 리뷰 반영)는 2026-11-16에 `3c487b1`로
  `main`에 스쿼시 머지됐다. `main` `3c487b1`의 CI 체크 6개가 모두 성공했다(2026-11-22 `gh api …/check-runs`로 확인). 두 PR의 변경은
  모두 CHANGELOG `[Unreleased]`에 있고 아직 발행하지 않았다.
- 2026-11-22: 브랜치 `ccr-37904670-hxdjsx`를 `origin/main` `3c487b1`에서 다시 시작해 **기본 index 진입점 공개 판정**(아래 절)을
  커밋했다. push·PR 전이다.

## 기본 index 진입점 공개 판정 (2026-11-22)

- 문제: 공개 판정이 `package.json`의 진입점 필드(`main`·`module`·`exports`·`bin`·`types`·`typings`·`browser`)만 봤다. Node는 `main`이 없는
  패키지를 `index.js`로 불러오고 TypeScript는 `index.ts`·`index.tsx`·`index.js`·`index.jsx`로 해석하므로, `{"name":"lib"}` 옆 `index.js`는
  `{"name":"lib","main":"index.js"}`와 똑같이 스캔 밖에서 소비된다. express 4.21.2, `@nestjs/core`·`@nestjs/common` 10.4.15가 이렇게
  게시된다. 그런데 앞의 것은 닫힌 프로그램, 뒤의 것은 열린 프로그램으로 봐서 ESM·TypeScript 패키지에 거짓 bound 간선이 났다.
- 재현(수정 전 `main` 빌드): ESM `index.js`에 `export function run(callback) { return callback(); }`·`function helper()`·
  `export function selfTest() { return run(helper); }`. `{"name":"lib-implicit","version":"1.0.0","type":"module"}`이면
  `bound index.js#run -> index.js#helper`, 같은 파일에 `"main":"index.js"`만 더하면 bound 간선 없음 + `bound-dispatch: package.json declares
  public entry points`. 소비자 디렉터리에서 Node 22.23로 두 패키지를 import하면 둘 다 `index.js`로 해석되고 `run(() => 'consumer callback')`이
  소비자 콜백을 부른다(ESM은 DEP0151 경고만 낸다). 즉 그 bound 간선은 거짓이다.
- 수정(`src/graph/default-index-entry.ts`, `build-graph.ts`): 진입점 필드가 없고 게시할 수 있는(문자열 `name`, `"private": true` 아님)
  manifest 옆에 기본 index 파일이 있으면 공개로 본다. 루트는 `bound-dispatch: package.json is not private and its default index file is
  the package entry, …`, 중첩 workspace 패키지는 `bound-dispatch: nested package.json file(s) are not private and declare no entry fields,
  so their default index file is the package entry: […]; …`로 알린다(기존 중첩 문장은 바꾸지 않았다). 디렉터리가 아닌 항목(링크 포함)은
  있는 것으로, 상태를 읽지 못하면 열린 쪽으로 본다. `private`는 기존 규칙처럼 boolean `true`만 본다.
- 줄어든 출력과 계수: 재현 사례의 bound 간선 1개가 사라지고 그 호출은 `unresolved-calls: 1 … (parameter: 1)`에 남는다. 실제 패키지:
  express 4.21.2·`@nestjs/core` 10.4.15·`@nestjs/common` 10.4.15는 간선·노드·통계가 바이트 단위로 같고 열린 프로그램 문장 한 줄만 더해진다
  (모두 CommonJS라 최상위 선언이 원래 열려 있다; bound 4·63·118 그대로). koa·zod·rxjs·@trpc/server·@tanstack/query-core·pg-boss·
  connect-pg-simple·effect·isthmus 스냅숏처럼 진입점 필드가 있거나 private인 패키지는 출력이 같다. nest 저장소 소스(v10.4.15 sparse
  checkout: 루트·`packages/core`·`packages/common`이 모두 이름만 있고 `main` 없음)는 문맥이 이미 불완전 스캔으로 열려 있어 출력이 같다.
- 회귀 테스트(`src/graph/default-index-entry.test.ts`, 7개): 루트 ESM `index.js`·TypeScript `index.ts`, `"main"`을 적은 같은 패키지와 간선
  동일, private·이름 없음·index 없음은 닫힘, 중첩 workspace 패키지의 새 문장과 private 대조, 판정 함수 단위. `main`의 `build-graph.ts`로
  되돌리면 3개(루트 둘·중첩), 게시 가능 검사를 빼면 3개, 중첩 근거를 `declared`로 바꾸면 1개가 실패한다.
- 검증(2026-11-22, Node 22.23.4, TypeScript 5.9.3, Git 2.43, root 컨테이너, 다른 세션과 공유한 4코어 load 6~18):
  - `npm run verify`: typecheck 통과, 테스트 단계가 12분 상한을 넘어 종료 2. 상한 전 실패는 `dispatch.test.ts` 600모듈 메모 사례(31.6초)
    하나이고 단독 재실행 9.0초로 통과했다.
  - 같은 인자로 상한 없이 돌린 전체 suite(18분 45초): 1,801개 중 1,777 통과·23 skip·1 실패(`relation-facts.test.ts` `chmod 000` 사례, root 환경,
    `runuser -u nobody`로 통과). 커버리지 라인 98.68%·분기 91.61%·함수 98.21%, `default-index-entry.ts` 100/100/100.
  - `npm run verify:cli` 통과(`Build contract verified: clean dist output.`, `CLI contract verified: 0/2/64 (1 reserved)`).
  - 자기 분석(`graph --project . --generated-at 2026-11-15T00:00:00Z`): 새 분석기와 `main` 분석기를 이 브랜치 트리에 돌린 stdout·stderr가
    바이트 단위로 같고 두 번 돌려도 같다(노드 10,185, 간선 14,770, bound 741).
  - isthmus `scripts/conformance-drift.mjs tsograph=…`: 모든 벡터 current.
  - 실행하지 못한 것: GLM 리뷰(`packet-ask` 없음), Git 2.45+ change 캡처 테스트(로컬 skip), macOS·Windows·Node 24/26 job(CI).
- 하지 않은 것: `index.d.ts`만 있는 패키지(런타임 진입점이 아니다)와 `index.mjs`·`index.cjs`(Node·TypeScript의 기본 index 이름이 아니다)는
  보지 않는다. `exports` 없는 패키지는 깊은 경로(`lib/x.js`)도 가져다 쓸 수 있지만 기본 index 파일이 없는 경우까지 넓히지 않았다.
  루트 manifest가 진입점 필드와 `"private": true`를 함께 가질 때 여는 기존 동작은 그대로다.

### 이번에 살펴보고 남긴 것

| 항목 | 이유 |
|---|---|
| `unresolved-export-aliases:`가 `type` 없이 재내보낸 interface·type alias를 센다(rxjs 7.8.1: 31개 중 30개가 타입·enum) | export 노드를 만드는 구문 단계(`collectModuleExports`)에 checker가 없다. 노드를 없애면 그래프 노드·`graphRevision`·entry 표식이 바뀌고, 세기만 빼면 남는 노드를 설명할 한계가 없다. 설계가 필요하다. |
| `graph-config: declaration-outputs:` import 수가 빌드 산출물 `.d.ts` 사이의 import도 센다(yaml 2.9.1 패키지 분석: 155개 중 스캔한 소스 파일의 import 키는 3개, 나머지는 `dist/*.d.ts` 사이) | import 수의 의미를 바꾸는 일이라 PR #59에서 모드별 계수를 미룬 것과 같은 판단이 필요하다. |
| 계산된 이름 멤버(`[Symbol.dispose]()`·`*[Symbol.iterator]()`)의 호출이 `<module>`에 귀속되고, `using`·`for…of`·템플릿 문자열의 암묵 호출은 세지 않는다 | README가 계산된 이름을 모듈 범위로 적어 둔 설계다. 암묵 호출 계수는 새 limitation 설계가 필요하다. |
| 진입점 필드 없는 공개 패키지를 `non-http-entries:` 진입점으로 표시 | README가 `package.json` `bin`/`main`/`exports` 대상을 표시하지 않는다고 적어 둔 범위다. |

## 선언 역매핑 export 이름 대조 (2026-11-15, PR #57 후속, PR #59, 2026-11-16 머지)

- `declarationDir`/`outDir`↔`rootDir` 경로로 잇기 전에 선언의 export 이름(값·타입·`default`·`export =`·`export *`가 끌어오는 이름)이
  모두 그 TypeScript 소스에도 있는지 본다(`src/graph/declaration-exports.ts`). 역매핑은 module 해석 hook 안이라 checker가 없어서
  TypeScript 파서로 최상위 export 문장만 읽고, `export *`는 그 설정의 module 해석(파일 module 형식에 맞는 모드, 4 MiB bounded reader,
  설정별 `ts.createModuleResolutionCache`)으로 프로젝트 안 대상만 표 하나당 1,024개 파일까지 따라간다.
- 따라가지 않는 `export *` 대상(읽지 않는 `node_modules`·프로젝트 밖 대상, 해석·읽기 실패, JavaScript, 파일 예산 밖)은 위치 키로 비교한다.
  소스의 같은 상대 위치에 같은 지정자가 있으면 맞고(tsc는 지정자를 쓴 그대로 옮기고 손으로 쓴 `src/*.d.ts`를 `outDir`로 복사하지 않는다),
  외부 대상은 같은 파일로 해석하면 지정자가 달라도 맞는다. 절대 지정자는 `absolute:` 키로 쓴 그대로 비교한다.
- 소스 쪽에 이름을 읽지 못한 경로 `export *`(해석하지 못한 상대·절대 지정자, 해석했지만 읽지 못한 프로젝트 안 대상, JavaScript 대상, 예산 밖
  대상)가 있으면 선언의 불투명 위치 비교까지만 하고 이름은 대조하지 않는다(재리뷰 S-1, `ExportTable.unreadPathStars`). 해석하지 못한 bare
  지정자는 선언 쪽도 똑같이 해석하지 못하므로 우회를 켜지 않는다(재리뷰 S-2, 판정이 설치 상태에 달리지 않게).
- 소스 폐쇄(자신이나 `export *` 대상)에 JavaScript가 있으면 대조하지 않고 잇는다. tsc가 CommonJS·JSDoc 이름을 checker로 정해 구문 표가
  맞는 소스를 틀렸다고 판정하기 때문이다(리뷰 B2의 option a). CommonJS·JSDoc 구문 이름 읽기(비공개 `jsDoc` 속성 사용 포함)는 지웠다.
- 빠진 이름이 있거나 선언 파일 자체를 읽지 못하면(읽기·구문 깊이 실패) 잇지 않고 기존
  `graph-config: declaration-outputs:`에 센다. 문장에 `N of them reach a source through declarationDir/outDir and rootDir that does not
  export every name …`가 붙는다(`ProgramConfigStatus.declarationOutputExportMismatches`). 불일치 선언은 옆의 같은 이름 `.js`(산출물
  루트의 빌드 출력)로 돌리지 않는다. import 수·파일 목록·불일치 수는 import 키별 마지막 판정 하나에서 센다.
- declaration map과 손으로 쓴 선언 옆 같은 이름 JavaScript 형제는 이름을 대조하지 않는다. 남은 통과 사례(README·CONFIG-SCOPE에 적음):
  같은 이름을 모두 내보내는 다른 소스, export 이름 없는 선언, 종류를 구별하지 않는 이름, JavaScript 소스나 읽지 못한 프로젝트 안
  `export *`가 있는 소스를 덮어쓴 선언, 오래된 `.d.ts.map`.
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
| 재리뷰 S-1 소스 쪽만 읽지 못한 `export *` 대상 때문에 맞는 간선을 잃음(main 대비 좁힘) | 간단한 쪽으로 고침(`2e98e81`, 문서 `bda1897`) | 4 MiB를 넘는 생성 소스(mapper), 체크아웃에 없는 생성 소스(끝까지), 판정 단위, 실제 tsc emit 두 사례가 main과 같음, 수정 전 실패 |
| 재리뷰 nit 프로젝트 안 barrel 1,024개 초과 시 잇지 않음 | 고침(`2e98e81`): 남은 대상을 위치로 남김 | 양쪽 1,100개 barrel 일치·예산 밖 위치 불일치, 예산 단위 테스트 |
| 재리뷰 nit 절대 지정자를 상대처럼 옮김 | 고침(`2e98e81`): `absolute:` 키 | 키 생성·판정 단위 테스트 |
| 3차 재리뷰 S-2 해석하지 못한 bare `export *`가 소스 쪽 우회를 켜 판정이 설치 상태에 달림 | 고침(`8dc4148`, 문서 `585d009`): 우회 조건에서 해석하지 못한 bare 지정자 제외 | 재리뷰 재현(mapper, `1ff6757`에서 실패), 표시 값, 판정 단위 |
| 3차 재리뷰 nit 우회가 거칠어 선언 파일에 직접 쓴 이름까지 대조하지 않음 | 남은 한계로 문서화(`585d009`) | — |

- 성능(합성: 300개 선언이 같은 500파일 barrel을 `export *`, 공유 4코어 load 5~6에서 다시 잼): mapper 하나 CPU 3.84 s → 0.30 s,
  graph 전체 wall 11.3~11.5 s → 3.8~4.7 s(CPU 11.3~11.6 → 4.0~4.4 s, main 2.9~3.1 s). 파일별 해석 memo(`34f3c19`, 이 시점 4.5~4.7 s)가
  대부분이고 해석 캐시·mapper 공유가 나머지다. 네 분석기의 출력은 바이트 단위로 같다. 측정 도구는 커밋하지 않았다.
- 재리뷰 S-1의 정밀한 쪽(선언 이름마다 거쳐 온 `export *` 위치 사슬을 기록해 소스가 읽지 못한 위치를 지나온 이름만 면제)은 하지 않았다.
  간단한 쪽은 그런 소스를 덮어쓴 번들러 선언을 이름으로 알아채지 못하고(위치 비교는 한다), 선언 파일에 직접 쓴 이름도 대조하지 않는다.
  반례 corpus가 생기면 정밀한 쪽을 검토한다.
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
- 재리뷰 S-1 반영 검증(2026-11-16, 같은 환경, load 6~16):
  - `npm run typecheck`·`npm run verify:cli` 통과. 선언 집중 테스트 49/49 통과. 새 회귀 테스트 6개는 `f0bda2b` 구현에서 실패했고, 이름 대조
    우회·예산 밖 위치 기록·절대 키를 하나씩 되돌리면 각각 실패한다. 재리뷰의 두 사례를 실제 tsc emit으로 다시 만들어 main·`f0bda2b`·새 head에
    돌렸다(main·새 head는 `src/index.ts#helper` direct, `f0bda2b`는 간선 없음+한계).
  - 상한 없는 전체 suite(19분 13초): 1,792개 중 1,766 통과·23 skip·3 실패. 실패 셋은 `schema-command` 힙 사례(부하 중 61초 timeout),
    `dispatch` 600모듈 사례(33초), `relation-facts` `chmod 000` 사례(root)이고 앞 둘은 단독 재실행, 셋째는 `runuser -u nobody`로 통과했다.
    커버리지 라인 98.68%·분기 91.60%·함수 98.21%, `declaration-exports.ts` 100/98.00/100. 12분 상한 `npm test`는 앞 회차에서 부하로 상한을
    넘었으므로 이번에는 상한 없는 실행만 했다.
  - 자기 분석: 새 분석기를 `f0bda2b` 트리에 돌린 결과는 `f0bda2b` 분석기 결과와 stdout·stderr 모두 바이트 단위로 같다. 새 트리와의 차이는
    바뀐 세 파일(`declaration-exports.ts`와 두 테스트) 안뿐이다: 노드 10,128 → 10,144, 간선 14,679 → 14,709(바뀐 파일을 건드리지 않는 변화 0),
    `unresolved-calls` 4,550 → 4,553(indirect 3,521 → 3,524), external 호출 25,836 → 25,888. 새 limitation 종류는 없다.
- 3차 재리뷰 S-2 반영 검증(2026-11-16): `npm run typecheck`·`npm run verify:cli` 통과, 선언 집중 테스트 51/51 통과. 재현 테스트는 `1ff6757`
  구현에서 실패한다. 재리뷰가 전체 suite는 필요 없다고 해 돌리지 않았다. 자기 분석: 새 분석기를 `1ff6757` 트리에 돌린 결과는 `1ff6757` 분석기
  결과와 바이트 단위로 같고, 새 트리와의 차이는 바뀐 세 파일 안뿐이다(노드 10,144 → 10,147, 간선 14,709 → 14,717, `unresolved-calls` 4,553 →
  4,555(indirect +2), external 호출 25,888 → 25,907, 바뀐 파일을 건드리지 않는 변화 0).

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

## 다음 할 일 (PR #59 머지 이후)

0. 브랜치 `ccr-37904670-hxdjsx`(기본 index 진입점 공개 판정)를 push하고 PR·CI(특히 전체 `npm test`·Git 2.45 경로)와 리뷰를 받는다.
1. 0.12.0 릴리스. 출력이 바뀌는 변경(새 direct 간선, bound→candidate, 새 limitation 접두사·문장)이 있으므로 마이너로 올린다.
   이전 릴리스 커밋(`chore(release): prepare tsograph 0.11.0`)처럼 `package.json`·`package-lock.json`·CHANGELOG를 함께 바꾼다.
2. isthmus에 게시본 검증과 `compatibility.json` 핀 갱신을 요청한다(isthmus 저장소의 일).
3. 위 제외·남긴 항목 중 사용자가 고른 것.

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
