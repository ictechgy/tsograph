# HANDOFF

세션을 이어받을 때 먼저 읽는 진행 상태 문서다. 작업 규칙의 정본은 [AGENTS.md](AGENTS.md)이고, 여기 적힌 상태는
실제 Git 상태·코드·검증 결과와 대조한 뒤 쓴다. 공통 규칙은 이 파일에 복제하지 않는다.

## 현재 상태 (2026-11-22)

- 발행본은 **0.11.0**이다. npm 게시(2026-11-03), 태그 `v0.11.0`, `package.json` 버전이 일치한다(2026-11-22 `npm view tsograph version`으로 다시 확인).
- isthmus `compatibility.json`의 tsograph 핀은 2026-11-22 로컬 isthmus 체크아웃(`30285f9`, `origin/main`과 같음) 기준으로 **0.10.0**이다.
  isthmus가 게시본을 검증한 뒤 바꾸는 절차이므로 tsograph 저장소에서 고치지 않는다.
- PR #57(`9795858`), PR #59(`3c487b1`), PR #60(진입점 필드 없는 게시 가능 패키지 공개 판정, 2026-11-22 `cea6584`)이 `main`에 스쿼시
  머지됐다. `main` `cea6584`의 CI 체크 6개가 모두 성공했다(2026-11-22 `gh api …/check-runs`로 확인). 세 PR의 변경은 모두 CHANGELOG
  `[Unreleased]`에 있고 아직 발행하지 않았다.
- 2026-11-22 4회차: 브랜치 `ccr-37904670-hxdjsx`를 `origin/main` `cea6584`에서 다시 시작해 limitation 문장 정확성 세 가지(아래 절)를
  PR #61로 올렸다. 첫 리뷰 반영(`b6d4052`·`f826ac0`·`6e67a71`·`11ee842`)까지 push됐고, 델타 리뷰(아래 "PR #61 델타 리뷰 반영") 반영 커밋
  `e02ecbb`와 문서 커밋은 push 전이다(조정자가 올린다).

## limitation 문장 정확성: 타입 전용 export 별칭·산출물끼리의 import·합친 설정 이름 (2026-11-22, 4회차)

세 수정 모두 노드·간선·통계·`graphRevision`을 바꾸지 않고 limitation 문장만 바꾼다(아래 corpus 비교로 확인).

1. **타입 전용 export 별칭** (`ed7953d`, `src/graph/export-nodes.ts`·`build-graph.ts`): `type` 없이 다시 내보낸 interface·type alias·값 없는
   namespace·JSDoc `@typedef`의 export 노드를 `unresolved-export-aliases:`(대상을 해석하지 못함)로 셌다. 런타임 선언이 없어 이을 대상이
   처음부터 없는 이름이다. checker가 별칭을 끝까지 따라간 대상에 `SymbolFlags.Value`가 없으면 `type-only-export-aliases: N export node(s)
   re-export names that resolve only to types (interfaces, type aliases, or namespaces without values), which have no runtime declaration;
   they have no alias edge`로 따로 센다(노드는 그대로 — 지난 HANDOFF가 걱정한 "남는 노드를 설명할 한계"가 이 문장이다). 값과 합쳐진 이름,
   enum·const enum, 값 있는 namespace, 찾지 못한 이름·모듈은 그대로 `unresolved-export-aliases:`다. 문맥이 나뉘면 두 계수를 합쳐 한 줄로
   낸다(`countedCalls` 정규식에 접두사 추가). bounded 경로는 export 노드를 잇지 않으므로 예전처럼 모두 해석 실패로 센다.
   - 재현(`main` `cea6584` 빌드): rxjs 7.8.1 소스 패키지 `graph` → `unresolved-export-aliases: 31`. 31개 중 30개가 interface·type alias이고
     하나가 enum `NotificationKind`다. 새 분석기: `unresolved-export-aliases: 1` + `type-only-export-aliases: 30`.
   - 테스트 `src/graph/export-nodes.test.ts`(4개): 종류별 재내보내기(barrel·지역 import 경유, 찾지 못한 이름·모듈 포함; 7 대 7), 타입만 있으면
     `unresolved-export-aliases:` 없음과 기본 내보내기 interface, JavaScript typedef, 두 문맥 합산. 변이: 타입 전용 판정을 끄면 4개, 별칭을
     따라가지 않으면 1개, interface만 보면 2개, 정규식에서 접두사를 빼거나 첫 문맥만 합치면 1개가 실패한다. 선언 없는 심볼 검사는 checker의
     unknown 심볼이 값 플래그를 가져 테스트로 구별되지 않는 방어 코드다.
2. **산출물끼리의 import** (`6795257`, `src/graph/program.ts`): `graph-config: declaration-outputs:` import 수에 스캔이 소스로 분석하지 않는
   파일(산출물 선언끼리, 스캔하지 않은 빌드 출력 JavaScript)의 import가 들어가는데 문장이 그것을 말하지 않았고, `files:` 표본(경로 순 10개)이
   그 대상으로 차서 스캔한 소스가 실제로 import한 산출물이 빠졌다. 전체 수의 의미와 스캔 불완전 판정은 그대로 두고(지난 HANDOFF가 "의미를
   바꾸는 일"로 미룬 부분은 건드리지 않았다), 그런 import가 있으면 `; N of them are made by files that are not analyzed as sources either
   (for example build output importing build output), so no <calls|route registrations> are taken from those files`를 붙이고(리뷰 반영
   `f826ac0` 전에는 graph를 박은 `which contribute no calls to the graph`였다) 표본은 스캔한 소스가 import한 산출물을 먼저 고른 뒤 경로 순으로
   싣는다. Node routes도 같은 graph Program으로 산출물을 되짚으므로 `route-coverage: declaration-outputs:`에 같은 절이 나온다. 모든 import가 스캔한 소스에서 나오면 출력이 예전과 같다.
   - 재현: yaml 2.9.1 패키지 → 155개 중 스캔한 소스(`util.js`)의 import는 1개, `dist/*.d.ts` 사이 147개, 스캔하지 않은 `dist/cli.mjs` 7개.
     예전 표본은 `dist/compose/…`~`dist/nodes/Node.d.ts`로 `util.js`가 import하는 `dist/util.d.ts`가 없었다. 새 분석기: `154 of them …`,
     표본 끝에 `dist/util.d.ts`.
   - 테스트(`declaration-outputs.test.ts` 2개 추가): `dist/index.d.ts`가 `a0`~`a10`을 다시 내보내는 12개 import 사례(문장·표본에 원인 파일·경로 순),
     모든 import가 소스에서 나오면 문장 없음, Node routes 문장의 `route registrations`(리뷰 반영). 변이: 계수를 0이나 전체로 바꾸면 1~2개, 표본
     우선순위나 마지막 정렬을 빼면 1~2개, 절을 예전 graph 문장으로 되돌리면 2개가 실패한다.
3. **합친 설정 상태의 이름** (`e5343c2`, `program.ts`·`build-graph.ts`·`routes/node/node-project.ts`): `ownershipStatus`가 읽지 못함·밖 include·
   건너뛴 루트·열거 상한을 모든 소유 설정에서 모으면서 문장은 대표 설정 이름을 썼다. 루트 설정이 없으면 `graph-config: undefined could not be
   parsed; …`(routes server·client도 같다), 루트 `tsconfig.json`을 잘 읽었어도 중첩 `jsconfig.json`을 읽지 못하면 거짓 `tsconfig.json could
   not be parsed; default compiler options were used`, 밖 include는 `… of undefined point outside …`가 나왔다.
   - 최종 규칙(델타 리뷰 반영 `e02ecbb`): 읽지 못한 설정을 문맥의 대표 설정이 아니라 소유권 계획의 **주 설정**(`ConfigOwnership.main`: 루트
     설정, `--tsconfig`로 고른 설정, 없으면 기본값) 기준으로 나눈다. 주 설정을 읽지 못했을 때만 예전 문장(스캔 루트 밖이면 경로)을 내고,
     나머지는 모두 `config-unreadable: N compiler config(s) under the scanned root could not be parsed, so path aliases and imports in the sources
     they own may not resolve; files: [<경로>]; omitted: M` 한 줄에 적는다(주 설정은 다시 적지 않는다). 두 문장 모두 계획 기준이라 문맥과
     상관없이 같고, graph는 접두사(`graph-config:`, Next 진입 범위 `route-coverage:` …)와 상관없이 문맥 표시 없이 하나로 합치며(`globalInputs`),
     routes는 문장 합치기로 하나만 남는다. 표시 이름은 실제 경로(스캔 루트 안일 때) 기준이라 symlink 디렉터리로 다시 읽은 같은 파일은 한 번만
     센다. 그 소스가 막히는지(소유권 충돌)는 nearest 소유자인지, reference로만 닿는지, 문맥 모드에 따라 달라 단정하지 않았다.
   - 경과: 첫 커밋 `e5343c2`는 `N other compiler config(s) (<이름>)`을 문맥마다 냈고, `b6d4052`는 경로·한 줄로 바꿨지만 대표 문장을 문맥의
     대표 설정 기준으로 남겨 fx15(루트 읽음, 소스가 `sub/`에만 있고 `sub/tsconfig.json`만 깨짐)에서 `tsconfig.json could not be parsed`(거짓)만
     나오고 `sub/tsconfig.json`은 이름이 없었다(델타 리뷰 B1).
   - 루트 공백 문장은 공백을 낸 설정의 스캔 루트 기준 경로를 쓰고, 스캔 루트의 대표 설정 하나만 냈으면(설정 자체로 비교하고 경로가 파일 이름과
     같을 때) 상태에 싣지 않아 기존 상태 `deepEqual` 테스트와 출력이 그대로다. `--workspace`로 경계를 넓히면 프로젝트 설정의 공백도
     `app/tsconfig.json`처럼 경로로 말한다(기존 테스트 기대값 하나를 바꿨다). 문장 함수는 `configParseGaps` 하나로 graph와 Node routes가 같이 쓴다.
   - 재현: typeorm 얕은 clone(`d5b143d`, 의존성 미설치라 `@tsconfig/node20`·`@docusaurus/tsconfig` extends를 못 읽음, 읽지 못한 설정 3개)
     `graph` → 루트 문맥 `undefined could not be parsed`, 잘 읽은 `playground`·`packages/codemod` 문맥에도 `tsconfig.json could not be parsed`.
     새 분석기: `config-unreadable: 3 compiler config(s) under the scanned root could not be parsed, …; files: ["docs/tsconfig.json",
     "packages/legacy-naming-strategies/tsconfig.json","packages/typeorm/tsconfig.json"]` 한 줄만 남는다(주 설정은 설정 없음이라 기본 옵션 문장이
     없다. `route-call-coverage:`도 같다). 합성 재현: 설정 없는 루트 +
     읽지 못한 `a/tsconfig.json` + 설정 없는 `b/app.ts`(Express)에서 graph·routes server·client 모두 `undefined` 문장, 루트 `tsconfig.json` +
     중첩 `jsconfig.json`의 건너뛴 `files` 항목은 graph·schema(`persistence-config:`)가 `of tsconfig.json`이라고 썼다.
   - 테스트 `src/graph/config-status-names.test.ts`(15개, graph·routes server·client): 위 세 모양, 같은 이름 설정 둘 읽기 실패(한 줄, 경로 둘),
     주 설정·중첩 설정 모두 읽기 실패(주 설정 문장 하나 + 주 설정을 뺀 목록), 루트와 같은 이름 중첩 `tsconfig.json`의 밖 include, 중첩
     `jsconfig.json`의 건너뛴 `files`, 루트 설정 자신의 공백은 이름 그대로(보호), fx15·fx16(유일한 소스의 중첩 설정만 깨짐, 루트 설정 있음·없음),
     fx01(루트·중첩 소스, 목록 한 줄만), fx18(Next, `route-coverage:` 목록도 한 번), fx11(symlink 중복), fx17(주 설정만 깨짐), fx10(`--workspace`).
     `11ee842`에 이 파일을 돌리면 루트 공백 네 개(보호 포함)를 뺀 11개가 실패한다. 변이(`e02ecbb` 뒤): 대표 설정을 주 설정으로 쓰면 10개,
     graph 접두사만 합치면 1개(fx18), 주 설정 문장을 문맥마다 내면 2개, realpath를 빼면 1개(fx11), 목록에서 주 설정을 빼지 않으면 2개,
     예전 "in the project" 문구면 10개가 실패한다. 첫 리뷰 반영 때 변이(경로 대신 이름 7개, 늘 경로 5개 등)는 루트 공백 쪽 그대로다.
- 적대 입력(수정 전후 비교, 노드·간선이 바뀐 사례 없음): 타입 쪽 — const enum(해석 실패 유지), interface+function·interface+class 병합(간선 유지),
  `import type`으로 가져온 class를 `export { }`(기존 alias 간선 유지, 아래 남긴 것), JSDoc `@callback`, 외부 패키지·ambient `.d.ts`·`declare
  function`(외부라 세지 않음 유지), `export * as ns`(노드 대상 없음 유지). 산출물 쪽 — 스캔한 `src/shim.d.ts`가 산출물을 다시 내보냄(소스 import로
  셈, 문장 없음), 소스가 산출물 12개를 직접 import(표본 동일), 같은 산출물을 소스와 산출물이 함께 import(1개만 나눠 셈). 설정 쪽 — 중첩
  `jsconfig.json`의 건너뛴 `files`(graph·schema 이름 수정), Next 앱 + 설정 없는 루트 + 읽지 못한 `lib/tsconfig.json`(graph 문장 수정, routes는
  해당 문장 없음), 읽은 설정끼리의 같은 이름 루트 공백(출력 동일). 리뷰 반영 뒤 — 루트와 같은 이름 중첩 `tsconfig.json`의 밖 include(두 문맥 모두
  `packages/a/tsconfig.json`), 루트 설정 없이 같은 이름 설정 둘 읽기 실패(한 줄, 경로 둘), 루트 있음 + 같은 이름 설정 둘 읽기 실패(문맥 셋에서
  한 줄), 중첩 `jsconfig.json`의 건너뛴 `files`(graph·schema `of a/jsconfig.json`), Express 앱 workspace의 산출물끼리 import(`route-coverage:` 절이
  `route registrations`).
- corpus 비교(`graph --generated-at 2026-11-15T00:00:00Z`, `main` `cea6584` 빌드 대 새 빌드): rxjs 7.8.1·yaml 2.9.1·typeorm만 limitation이 바뀌고
  노드·간선·통계·`graphRevision`·stderr는 모두 같다. zod 3.23.8, koa 2.15.3, express 4.21.2, @trpc/server 10.45.2, @tanstack/query-core
  5.59.0, @nestjs/common·core 10.4.15, pg-boss 10.1.5, connect-pg-simple 10.0.0, hono(얕은 clone), node-express-realworld-example-app,
  node-express-boilerplate는 stdout·stderr 바이트가 같다. 리뷰 반영 뒤 다시 잰 `routes --role server|client`(`generatedAt`만 빼고 비교)는 typeorm
  client만 위 문장이 바뀌고 나머지 일곱은 같다. 첫 커밋 때 적은 "routes도 바이트가 같다"는 `routes`가 받지 않는 `--generated-at`을 넘겨 두 쪽
  출력이 모두 비어 있던 잘못된 비교였다. `schema`(`generatedAt` 제외)는 네 저장소 모두 같다.
- 검증(2026-11-22, Node 22.23.4, TypeScript 5.9.3, Git 2.43, root 컨테이너, 다른 세션과 공유한 4코어). 델타 리뷰 반영(`e02ecbb`) 뒤 다시 돌렸다.
  - `npx tsc --noEmit` 통과.
  - 리뷰어 fixture 21개(`scratchpad/r4d-fx`, 실행은 `r4d-tools/run.sh`와 같은 인자, graph·routes server·client): `4939c2a`·`11ee842`·새 head에서
    노드·간선·`graphRevision`·종료 코드가 21/21 같다. 문장 변화는 위 델타 리뷰 표대로다(fx02는 예전과 같고, fx04는 문맥별 `tsconfig.json could
    not be parsed` 열두 줄이 목록 한 줄로 바뀐다).
  - 상한 없이 `scripts/run-tests.mjs`와 같은 인자로 돌린 전체 suite(13분 2초): 1,823개 중 1,798 통과·23 skip·2 실패. 실패는 `dispatch` 600모듈
    메모 사례(부하; 단독 재실행 통과)와 `relation-facts`의 `chmod 000` 사례(root 컨테이너, 기존 환경 문제)다. 커버리지 라인 98.69%·분기 91.64%·
    함수 98.22%, `export-nodes.ts` 100/100/100, `program.ts` 100/97.18/99.21, `build-graph.ts` 99.70/94.49/97.06. 그 전 실행에서 상태 `deepEqual`
    테스트 두 개(`program.test.ts`)가 새 `unreadableConfigs` 필드 때문에 실패해, 주 설정이 곧 대표 설정이고 스캔 루트에 있으며 그것만 깨졌을 때는
    필드를 싣지 않게 고쳤다(같은 문장이 나온다). 12분 상한 `npm test`는 돌리지 않았다.
  - `npm run verify:cli`: 통과(`Build contract verified: clean dist output.`, `CLI contract verified: 0/2/64 (1 reserved)`).
  - isthmus `node ../isthmus/scripts/conformance-drift.mjs tsograph=.`: 모든 벡터 current(로컬 isthmus 체크아웃의 conformance는 `origin/main`
    `30285f9`와 같다).
  - 자기 분석(`graph --generated-at 2026-11-15T00:00:00Z`): 새 분석기를 `cea6584` worktree에 돌린 결과는 `cea6584` 분석기 결과와, 이 head 트리에
    돌린 결과는 `11ee842` 분석기 결과와 stdout·stderr 바이트가 같다(자기 분석에는 새 문장이 나오지 않는다). `cea6584` 트리와의 차이는 바뀐 여덟
    파일 안뿐이다(노드 10,174 → 10,290, 간선 14,761 → 14,963, bound 간선 710 → 728·호출 740 → 743, `unresolved-calls` 4,555 → 4,558, 바뀐 파일을
    건드리지 않는 노드·간선 변화 0). 두 번 돌려 바이트가 같다.
  - corpus(`cea6584`·`11ee842`·새 head): graph는 rxjs·yaml(`11ee842`와 같음)과 typeorm(`11ee842` 대비 문맥별 `tsconfig.json could not be parsed`
    세 줄이 사라지고 목록 문구가 "under the scanned root")만 바뀌고 노드·간선·통계·`graphRevision`·stderr는 같다. 나머지 열두 대상은 바이트가
    같다. `routes`(`generatedAt` 제외)는 typeorm client만 같은 식으로 바뀌고 `schema`는 네 저장소 모두 같다.
  - 실행하지 못한 것: GLM 리뷰(`packet-ask` 없음), Git 2.45+ change 캡처 테스트(로컬 skip), macOS·Windows·Node 24/26 job(CI), `runuser -u nobody`
    재실행(스크래치 디렉터리 권한을 넓히지 않으려고 하지 않았다).

### 이번에 살펴보고 남긴 것 (4회차)

| 항목 | 이유 |
|---|---|
| `files` 필드·`.npmignore`로 게시본에서 빠지는 파일을 닫기 | 건전하지 않다. `files: ["dist"]` 패키지도 `dist`는 `src`를 컴파일한 것이라 소비자가 `lib/dist/main.js`로 깊은 경로 import하면 `src/main.ts`의 내보낸 함수가 불린다. `src`를 닫으면 거짓 bound 간선이 난다. 소스↔게시 산출물 대응을 증명할 수 있을 때만 검토한다. |
| `declaration-outputs:` 전체 import 수를 스캔한 소스의 import만으로 바꾸기 | 기존 테스트가 고정한 계수 의미와 스캔 불완전 판정을 바꾼다. 이번에는 수를 그대로 두고 나눠 말하는 문장·표본만 고쳤다. |
| `import type { C }`로 가져온 class를 `export { C }`하면 export 노드에서 class로 `alias` 간선이 난다 | TypeScript emit은 이 재내보내기를 지우므로 런타임 export가 없다. 간선을 지우는 것은 출력 축소라 반례 corpus와 실제 프로젝트 근거가 필요하고, 실제로 드문 모양이다. |
| `import * as ns from './x'; export { ns }`를 `unresolved-export-aliases:`로 셈 | 모듈 객체라 이을 선언 노드가 없다. `<module>` 노드로 잇는 것은 새 간선 설계다. |
| 의존성을 설치하지 않은 typeorm 저장소는 간선 0개 | 읽지 못한 extends 설정 3개가 소유권 계획을 불완전으로 만들어 모든 소스의 import를 보류하는 기존 보수 규칙이다. limitation은 사실대로 알린다(이번 수정으로 이름도 맞다). |
| GLM 리뷰 | 이 환경에 `packet-ask`가 없다. |
| 산출물 import가 모두 스캔하지 않는 파일에서 나와도 `declaration-outputs:`가 "calls through them are counted as external"을 말하고 스캔을 불완전으로 본다 | 전체 수로 판정하는 기존 동작이다. 그런 경우를 완전한 스캔으로 바꾸면 bound 간선이 늘 수 있어 반례 corpus가 필요하다(리뷰 nit 3, 후속). routes 문장도 이 고정 구절은 `calls`라고 말한다. |
| 소유권 계획은 설정을 `resolve()` 경로로 캐시해, symlink 디렉터리나 대소문자만 다른 경로로 참조한 같은 설정 파일을 두 설정으로 다룬다 | 이번에는 문장의 표시 이름만 실제 경로로 합쳤다(델타 리뷰 N1). 소유권 판정 자체를 realpath로 바꾸는 것은 충돌·문맥 분리 판정이 바뀌는 일이라 하지 않았다. |
| 설정 루트 공백 문장은 문맥마다 같은 합계를 `compiler-context:` 표시와 함께 반복한다 | 기존 구조다. 이번에는 이름·경로만 고쳤다. |

### PR #61 델타 리뷰 반영 (2026-11-22, `4939c2a..11ee842` 리뷰)

리뷰어 fixture 21개(`r4d-fx`, 생성기 `r4d-tools/mkfx.sh`)를 `4939c2a`·`11ee842`·새 head에 돌렸다. 노드·간선·`graphRevision`·종료 코드는 21개
모두 세 빌드에서 같다.

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| B1 blocker: 문맥의 대표 설정 기준이라 fx15·fx16에서 `tsconfig.json could not be parsed`(거짓, 루트 설정 탓)만 나오고 `sub/tsconfig.json`은 이름이 없음, fx01은 routes에서 실패한 설정이 둘처럼 읽힘 | 고침(`e02ecbb`): 계획의 주 설정만 예전 문장, 나머지는 모두 목록 | fx15·fx16·fx01 테스트(graph·server·client), `11ee842`에서 실패. 대표 설정을 주 설정으로 쓰는 변이에서 10개 실패 |
| S1: Next 진입 범위의 `route-coverage: config-unreadable:`이 graph에서 문맥마다 반복(fx18) | 고침(`e02ecbb`): 접두사와 상관없이 전역 줄로 합침 | fx18 테스트, graph 접두사만 보는 변이에서 실패 |
| N1: symlink로 다시 참조한 같은 파일을 둘로 셈(fx11) | 고침(`e02ecbb`): 실제 경로 표시 이름으로 한 번 | symlink 테스트, realpath를 빼면 실패. 소유권 판정 자체는 남긴 것(위 표) |
| N2: 주 설정만 읽지 못하면 목록에 주 설정을 다시 적음(fx17) | 고침(`e02ecbb`) | fx17 테스트, 목록에서 주 설정을 빼지 않으면 2개 실패 |
| N3: `--workspace` 목록에 프로젝트 밖 설정이 있는데 "in the project"(fx10) | 고침(`e02ecbb`): "under the scanned root" | `--workspace` 테스트 |
| N4: 문서가 중립 절을 graph·Node routes만 말함 | 고침(문서 커밋): client `requests`, navigation `screen registrations`까지 | — |

### PR #61 리뷰 반영 (2026-11-22)

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| should-fix: 이름만 저장하고 이름으로 대표 설정을 가려 같은 이름(`tsconfig.json`) 설정을 구별하지 못함 | 고침(`b6d4052`): 두 필드에 프로젝트 기준 경로, 대표 판정은 설정 자체, 대표 문장은 그대로 | 같은 이름 밖 include·같은 이름 설정 둘 읽기 실패 테스트, `4939c2a`에서 실패 |
| nit: 다른 설정 줄이 문맥마다 다른 수로 반복 | 고침(`b6d4052`): 프로젝트 전체 `config-unreadable:` 한 줄 | 문맥 셋에서 한 줄만 나오는지 검사, 전역 정규식 변이에서 실패 |
| nit: 산출물끼리 절이 "to the graph"를 박아 routes 문장에 맞지 않음 | 고침(`f826ac0`): `so no <affected> are taken from those files` | Node routes 테스트, 예전 절로 되돌리면 실패 |
| nit: 모든 import가 스캔하지 않는 파일에서 나와도 외부 호출·불완전 문장 | 후속으로 기록(위 표) | — |
| nit: `isTypeOnlyTarget`의 선언 수 검사, `configRootGapSubject`의 `undefined` 반환 타입 | 고침(`6e67a71`, `b6d4052`) | 기존 export-nodes 테스트 그대로 통과 |

## 진입점 필드 없는 게시 가능 패키지 공개 판정 (2026-11-22, PR #60)

- 문제: 공개 판정이 `package.json`의 진입점 필드(`main`·`module`·`exports`·`bin`·`types`·`typings`·`browser`)만 봤다. 게시할 수 있는
  패키지에 `exports`가 없으면 Node·TypeScript는 패키지 안 모든 파일을 경로로 가져다 쓰게 하고(`import { run } from 'lib/src/main.js'`),
  `main`이 없으면 패키지 이름 자체가 기본 index 파일(Node `index.js`, TypeScript는 `index.ts`·`index.tsx`·`index.jsx`도)로 해석된다.
  express 4.21.2, `@nestjs/core`·`@nestjs/common` 10.4.15가 진입점 필드 없이 게시된다. 그런데 진입점 필드가 없으면 닫힌 프로그램으로 봐서
  ESM·TypeScript 패키지에 거짓 bound 간선이 났다.
- 경과: 첫 커밋 `f81d4f4`는 기본 index 파일(`index.js|jsx|ts|tsx`)이 있을 때만 열었다. 독립 리뷰 S1이 index 없는 깊은 경로 import를 재현해
  `5ff8259`에서 index 파일과 상관없이 열도록 넓혔다(모듈 `default-index-entry.ts` → `publishable-manifest.ts`, index 존재 검사 삭제).
- 재현:
  - 기본 index(`main` `3c487b1` 빌드): ESM `index.js`에 `export function run(callback) { return callback(); }`·`function helper()`·
    `export function selfTest() { return run(helper); }`. `{"name":"lib-implicit","version":"1.0.0","type":"module"}`이면
    `bound index.js#run -> index.js#helper`, `"main":"index.js"`만 더하면 bound 간선 없음 + `bound-dispatch: package.json declares public entry
    points`. 소비자 디렉터리에서 Node 22.23로 import하면 둘 다 `index.js`로 해석되고 소비자 콜백이 불린다.
  - 깊은 경로(리뷰 S1, `8e0a7b1` 빌드): `{"name":"lib","version":"1.0.0","type":"module"}`과 같은 내용의 `src/main.js` →
    `bound src/main.js#run -> src/main.js#helper`. 패키지를 소비자 `node_modules/lib`로 링크하고
    `node --input-type=module -e "import { run } from 'lib/src/main.js'; console.log(run(() => 'consumer callback via deep import'))"`를 돌리면
    소비자 콜백 문자열이 찍힌다(이름 import `lib`는 index가 없어 `ERR_MODULE_NOT_FOUND`). 루트 `index.mjs`(`lib-mjs/index.mjs`)도 같다.
- 수정(`src/graph/publishable-manifest.ts`, `build-graph.ts`): 진입점 필드가 없고 게시할 수 있는(문자열 `name`, `"private": true` 아님)
  manifest는 루트면 프로그램 전체를, 중첩 workspace 패키지면 자기 파일을 연다. 루트는 `bound-dispatch: package.json has a string name
  without "private": true and no exports field, which lets any file be imported by path, so …`, 중첩은 `bound-dispatch: nested package.json
  file(s) have a string name without "private": true and no entry fields, which lets any of their files be imported by path: […]; …`로
  알린다(기존 중첩 문장은 그대로). `"private": true`·문자열 `name` 없음·형식 표식 manifest는 닫힌 쪽이다. 루트가 진입점 필드와
  `"private": true`를 함께 가지면 여는 기존 동작, 중첩 패키지의 진입점 필드 규칙도 그대로다.
- private 판정(리뷰 N1): boolean `true`만 private로 본다(`isMarkedPrivate`). npm 10.9.9는 truthy 값을 모두 거절한다(`libnpmpublish` 10.0.2
  `lib/publish.js:15`의 `if (manifest.private)`, `lib/commands/publish.js:136` workspace 검사; 가짜 레지스트리로 `npm publish`하면
  `"private": "true"`·`1`은 네트워크 전에 `EPRIVATE`, `false`는 요청까지 간다). 그러나 Yarn 4(`@yarnpkg/core` 4.9.3 `Manifest.js:170-173`은
  `typeof data.private === 'boolean'`일 때만 읽고, `@yarnpkg/plugin-npm-cli` 4.6.0 `publish.js:43`은 그 값만 검사)는 `"private": "true"`를
  게시한다. 리뷰는 npm 규칙을 권했지만 그렇게 닫으면 Yarn으로 게시한 패키지에 거짓 bound 간선이 다시 나므로, 판정은 열린 쪽에 두고
  문장이 "is not private"라고 단정하지 않게 바꿨다.
- 출력 비교(`graph --generated-at 2026-11-15T00:00:00Z`, `main` `3c487b1` / `8e0a7b1` / 새 분석기, bound 간선 수/bound 호출 수):
  - 재현 사례: 기본 index 1→0(`8e0a7b1`부터), 깊은 경로 `src/main.js`·`index.mjs` 1/1→1/1→0. 줄어든 호출은 `unresolved-calls: … (parameter: 1)`.
  - express 4.21.2 4/4, `@nestjs/core` 60/63, `@nestjs/common` 89/118: 세 분석기 간선·노드·통계 동일(CommonJS라 원래 열려 있다). `main` 대비
    열린 프로그램 문장 한 줄만 더해지고 `8e0a7b1` 대비 그 문장만 바뀐다.
  - koa 0/0, zod 122/219, rxjs 46/45, @trpc/server 6/10, @tanstack/query-core 49/55, pg-boss 23/23, connect-pg-simple 0/0, effect
    9,289/11,937: 세 분석기 출력 바이트 동일(진입점 필드가 있다).
  - 이름만 있고 `private`·진입점 필드가 없는 공개 앱·템플릿(GitHub 얕은 clone): prisma-examples `orm/express`·`fastify`·`graphql`·`koa`
    (0/0, 바이트 동일: 간극이 없어 문장도 안 나온다), `orm/hono`(0/0, 문장 한 줄 추가), hono starter `templates/vercel`·medusa-starter-default
    (0/0, 바이트 동일), umami(40/43, 간선 동일; 네 문맥 중 셋은 이미 불완전 스캔, 하나는 중첩 문장이 루트 문장으로 바뀜), jellyfin-web(136/165)·
    uptime-kuma(387/444, 빈 `files` tsconfig를 치운 사본; 원본은 노드 0): 원본 그대로는 source-scope로 이미 열려 있어 바이트 동일이고,
    제외된 루트 설정 파일 9개·sibling 1개를 사본에서 치워 스캔을 완전하게 만들어도 간선·노드·통계가 같고 문장만 바뀐다. 즉 이 표본에서
    앱이 잃은 bound 간선은 0개다.
  - 자기 분석(이 브랜치 `5ff8259` 트리): 세 분석기 stdout·stderr 바이트 동일, 두 번 돌려도 같다(노드 10,174, 간선 14,761, bound 간선 710·
    호출 740; `package.json`에 `bin`이 있어 원래 공개 패키지).
- 회귀 테스트(`src/graph/publishable-manifest.test.ts`, 7개): 판정 단위(boolean이 아닌 `private`는 게시 가능), 루트 깊은 경로 `src/main.js`
  (+ 그 파일을 `main`으로 적은 패키지와 간선 동일), 루트 `index.js`·`index.mjs`·`index.ts`, `"private": true`·이름 없음·`{"type":"module"}`는
  index가 있든 없든 닫힘, 루트 `"private": true` + `main`은 열림, `"private": "true"`는 열리고 문장에 `is not private`가 없음, 중첩 workspace
  패키지(index 있음·없음)는 열리고 private·이름 없음·형식 표식은 닫힘. 변이 확인: `8e0a7b1`이나 `main`의 `build-graph.ts`로 되돌리면 4개
  (루트 깊은 경로·index 파일·`"private": "true"`·중첩)가 실패하고(`8e0a7b1`에서 `"private": "true"` 사례는 옛 문장 때문에 실패), private를
  truthy로 판정하면 2개, 중첩 근거를 `declared`로 바꾸거나 중첩을 닫으면 1개, 루트가 private를 무시하면 2개가 실패한다.
- 검증(2026-11-22, Node 22.23.4, TypeScript 5.9.3, Git 2.43, root 컨테이너, 다른 세션과 공유한 4코어):
  - `npx tsc --noEmit` 통과. 집중 실행 `publishable-manifest`·`dispatch`·`build-graph` 테스트 73개 중 71 통과·2 skip(root 권한 사례).
  - 상한 없이 `scripts/run-tests.mjs`와 같은 인자로 돌린 전체 suite(14분 25초, load 13~19): 1,801개 중 1,777 통과·23 skip·1 실패. 실패는
    `relation-facts.test.ts`의 `chmod 000` 사례(root 컨테이너, `runuser -u nobody`로 통과)뿐이다. 커버리지 라인 98.68%·분기 91.61%·함수 98.21%,
    `publishable-manifest.ts` 100/100/100, `build-graph.ts` 99.70/94.46/97.00. 12분 상한 안에는 들지 못하는 시간이다.
  - `npm run verify:cli`: 통과(`Build contract verified: clean dist output.`, `CLI contract verified: 0/2/64 (1 reserved)`).
  - isthmus `node ../isthmus/scripts/conformance-drift.mjs tsograph=.`: 모든 벡터 current.
  - 실행하지 못한 것: GLM 리뷰(`packet-ask` 없음), Git 2.45+ change 캡처 테스트(로컬 skip), macOS·Windows·Node 24/26 job(CI). 12분 상한
    `npm run verify`는 앞 회차에서 부하로 상한을 넘었으므로 이번에는 단계별로(테스트는 상한 없이) 돌렸다. nest 저장소 소스와 isthmus
    스냅숏은 다시 돌리지 않았다(isthmus는 `bin`이 있어 판정이 바뀌지 않는다).
- 하지 않은 것: `files` 필드·`.npmignore`로 게시본에서 빠지는 파일도 연다(게시본 파일 목록을 계산하지 않는다). `exports`가 있으면 그 대상만
  여는 정밀화는 하지 않았다(진입점 필드가 하나라도 있으면 프로그램 전체를 여는 기존 거친 규칙 그대로). Yarn과 npm이 다르게 보는 `private`
  값은 열린 쪽에 둔다.

### PR #60 독립 리뷰 반영 (2026-11-22)

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| S1 `exports` 없는 게시 가능 패키지는 깊은 경로로 아무 파일이나 불러오는데 index가 없으면 닫혀 있고, 새 테스트가 그 거짓 간선을 맞다고 고정 | 고침(`5ff8259`): 게시 가능 manifest는 index 파일과 상관없이 연다. 거짓 간선을 고정하던 테스트를 바꿨다 | 루트 깊은 경로·`index.mjs`·중첩 index 없음 테스트, `8e0a7b1` 구현에서 실패 |
| N1 `"private": "true"`를 게시 가능으로 보면서 "is not private"라고 씀 | 문장을 고침. 판정은 boolean 유지(Yarn 4가 게시한다, 위 근거) | `"private": "true"` 루트 테스트, `8e0a7b1`에서 옛 문장으로 실패. truthy 판정 변이에서 실패 |
| N2 README가 루트 `private: true` + 진입점 필드는 열고 `private: true`만은 닫는다는 규칙을 안 적음 | 고침: README·README.ko에 루트·중첩 규칙과 private 값 규칙을 구현대로 적음 | 루트 `"private": true` + `main` 열림 테스트 추가 |
| N3 `dispatch.ts` 모듈 주석이 공개 패키지를 일곱 필드로만 정의 | 고침 | — |

### PR #60에서 살펴보고 남긴 것

| 항목 | 이유 |
|---|---|
| `unresolved-export-aliases:`가 `type` 없이 재내보낸 interface·type alias를 센다(rxjs 7.8.1: 31개 중 30개가 타입·enum) | 4회차에서 처리: 노드는 두고 `type-only-export-aliases:`로 나눠 센다(위 절). |
| `graph-config: declaration-outputs:` import 수가 빌드 산출물 `.d.ts` 사이의 import도 센다(yaml 2.9.1 패키지 분석: 155개 중 스캔한 소스 파일의 import는 1개, 나머지는 `dist/*.d.ts`와 스캔하지 않은 `dist/cli.mjs`) | 4회차에서 수는 그대로 두고 나눠 말하는 문장과 표본 우선순위를 더했다(위 절). 수 자체의 의미 변경은 하지 않았다. |
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

## 다음 할 일 (4회차 이후)

0. 브랜치 `ccr-37904670-hxdjsx`의 4회차 커밋을 push해 PR로 올리고 CI(특히 전체 `npm test`·Git 2.45 경로·macOS·Windows)와 리뷰를 받는다.
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
