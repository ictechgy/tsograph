# HANDOFF

세션을 이어받을 때 먼저 읽는 진행 상태 문서다. 작업 규칙의 정본은 [AGENTS.md](AGENTS.md)이고, 여기 적힌 상태는
실제 Git 상태·코드·검증 결과와 대조한 뒤 쓴다. 공통 규칙은 이 파일에 복제하지 않는다.

## 현재 상태 (2026-11-25)

- 발행본은 **0.11.0**이다. npm 게시(2026-11-03), 태그 `v0.11.0`, `package.json` 버전이 일치한다(2026-11-25 `npm view tsograph version`으로 다시 확인).
- isthmus `compatibility.json`의 tsograph 핀은 2026-11-25 로컬 isthmus 체크아웃(`4a3e99d`, `origin/main`과 같음) 기준으로 **0.10.0**이다.
  isthmus가 게시본을 검증한 뒤 바꾸는 절차이므로 tsograph 저장소에서 고치지 않는다.
- PR #57·#59·#60·#61이 `main`에 스쿼시 머지됐다(#61은 `2dac50e`). `main` `2dac50e`의 CI 체크 6개가 모두 성공했다(2026-11-25
  `gh api …/check-runs`로 확인). 네 PR의 변경은 모두 CHANGELOG `[Unreleased]`에 있고 아직 발행하지 않았다.
- 2026-11-25 5회차: 브랜치 `ccr-37904670-hxdjsx`를 `origin/main` `2dac50e`에서 다시 시작해 Fastify 플러그인 접두사 이음 두 가지(아래 절)를
  고쳐 PR #62(`36491b4`·`e381053`, 조정자가 push)로 올렸다. 독립 리뷰의 should-fix 둘(`routerOptions` 주 버전, 직접 쓴 skip-override)과 nit 둘을
  `ae729b0`·`60553ce`로 반영했고(아래 "PR #62 독립 리뷰 반영"), 재확인 리뷰의 should-fix 넷(A~D)과 nit 넷을 그 위 커밋으로 반영했다(아래 "PR #62
  재확인 리뷰 반영"). 마지막 재확인 리뷰의 should-fix 셋과 nit 셋은 `db64014` 위 커밋으로 반영했다(아래 "PR #62 마지막 재확인 리뷰
  반영"). 이 반영 커밋은 push 전이다(조정자가 올린다).

## Fastify 플러그인 접두사 이음 (2026-11-25, 5회차)

첫 커밋의 두 수정은 `src/routes/node/fastify-adapter.ts`의 펼치기(`flattenFastify`) 안이다. 리뷰 반영(아래 "PR #62 독립 리뷰 반영")으로 `fastifyCreation`의 옵션 출처, 새 `fastify-skip-override.ts`, 해석기 문맥의 `includesFile()`이 더해졌고, 마지막 재확인 반영에서 해석기의 상대 `require()` 해석(`requiredModule()`)을 문맥에 드러냈다. 다른 프레임워크·graph·schema 출력은 바뀌지 않는다.

1. **타입으로만 아는 `FastifyInstance` 아래의 플러그인 접두사**: 붙는 위치를 모르는 인스턴스(fastify-cli가 불러 붙이는
   `export default async function app(fastify: FastifyInstance)`)를 "값을 모르는 접두사"(`{ kind: 'unknown' }`)로 다뤄, 그 아래
   `register(plugin, { prefix: '/users' })`를 `buildRoutePrefix`가 모두 버렸다(`unknown`이 이기므로). `/users` 플러그인의 `get('/')`·
   `get('/:id')`·`get('/:id/posts')`가 `/`·`/{}`·`/{}/posts` base로 나왔고 접두사 아래 `/`의 `prefixTrailingSlash` 규칙도 빠졌다. Express·Koa·Hono
   어댑터는 같은 모양에서 `/api/x` base처럼 접두사를 지킨다(확인함).
   - 수정: 앵커를 접두사 값과 따로 들고 다닌다(`InstancePrefix { anchor, value }`, Express·Koa 어댑터와 같은 구조). 타입으로만 아는 루트는
     `base` + 빈 리터럴로 시작하고, 리터럴 플러그인 접두사는 base 뒤 꼬리로 잇는다. base 아래에서 이은 결과가 리터럴이 아니면(모르거나
     앞부분만 아는 접두사, 주 버전을 몰라 정하지 못한 이음) 꼬리를 비워 알 수 없는 base에 합친다(예전 출력과 같다). base 아래 제공 경로
     (`framework-provided-routes:`·`route-coverage:`)는 예전처럼 스코프가 없다. `buildRoutePrefix`는 이제 `unknown` 부모를 받지 않는다(타입으로
     막았다).
   - 실제 실행(scratch에 fastify 5.12.5·4.29.1 설치, find-my-way `on` 기록과 `inject`): 같은 플러그인을 바깥 접두사 `''`·`/api`로 붙이면
     `<바깥>/users`·`<바깥>/users/`·`<바깥>/users/:id`·`<바깥>/users/:id/posts`가 등록되고 `<바깥>/7`·`<바깥>/`·`<바깥>/orders/7/posts`는 404다.
   - isthmus로 확인(로컬 `4a3e99d` dist, `check --pairs`): 클라이언트 `/api/users`·`/api/users/7`·`/api/users/7/posts`·`/api/orders/7/posts`에 대해
     `main` 출력은 `/{}/posts` base가 `/api/users/7/posts`와 **없는 경로** `/api/orders/7/posts`를 모두 받고(suffix match) `/api/users`·`/api/users/7`은
     decl 없음 warning이었다. 새 출력은 세 호출이 각자 decl(`/users`·`/users/{}`·`/users/{}/posts`)과 이어지고 `/api/orders/7/posts`는
     `route-call-without-decl` error다(실제로 404). warning 5 → 2, error 0 → 1.
2. **Fastify 4의 접두사 이음 규칙**: 부모 접두사가 `/`로 끝나고 플러그인 접두사가 `/` 아닌 글자로 시작하면 fastify 5.12.5
   (`lib/plugin-override.js`)는 그대로 잇고 4.29.1(`lib/pluginOverride.js`)은 `/`를 더한다. 포팅이 5 규칙만 따라 fastify 4 앱에서
   `/v1/` + `bare` + `/y`를 `/v1/bare/y`(실제 404)로 냈다(실제 4.29.1은 `/v1//bare/y`).
   - 수정: `flattenFastify`가 감지한 주 버전을 받고 `joinPrefixText`가 4·5 규칙을 고른다. 그 주 버전에서 켜진 `ignoreDuplicateSlashes`
     (최상위 값은 4·5 모두, `routerOptions` 값은 5만 — 리뷰 SF1 반영)면 find-my-way가 겹친 `/`를 줄여 두 버전이 같으므로 5 규칙을 쓴다
     (실행으로 확인: 최상위 옵션이면 두 버전 모두 `/v1/bare/y`·`/v1//bare/y` 200). 주 버전을 모르는데 두 규칙이 다르면 부모 접두사까지만 아는
     partial이라 root에서는 dynamic(`dynamicScope` `/v1`), base에서는 위 규칙대로 base에 합친다. 플러그인 접두사 앞부분이 빈 문자열이면 첫
     글자를 모르므로 두 규칙 모두 부모(`/`로 끝나지 않으면 `/`까지)만 확정한다.
   - 주 버전을 모르는 경우 정적 사실이 dynamic이 된다(아래 적대 입력 a18-vx: `/v1/bare/y` → `/v1/{dynamic}`). 그 정적 사실은 증명된 사실이
     아니었고(5에서는 참, 4에서는 거짓), 문서에는 이미 `route-framework-version-unknown:`("주 버전마다 다른 경로 문법은 dynamic")이 붙으며 줄어든 정적
     사실은 `route-coverage: N route declaration(s) have paths … dynamic`(1 → 2)에 센다. 이 수는 경로가 아니라 등록을 세므로 사실 수는 더 줄 수
     있다: 접두사 아래 `/` 라우트는 `prefix`·`prefix/` 두 decl 대신 dynamic 하나다(리뷰 nit 2: `^4.0.0 || ^5.0.0`에 `/aa/` → `bb/` → `/cc/` → `dd`
     사슬이면 사실 7개가 5개). Express·@koa/router가 주 버전을 모를 때 쓰는 기존 규칙과 같다.
- 테스트(`src/routes/node/fastify-adapter.test.ts`): `buildRoutePrefix` 단위 테스트를 4·5·모름 세 규칙으로 돌리고 갈리는 이음을 더했다(예전
  단언 중 `unknown` 부모 하나는 타입으로 막혀 지웠다 — 그 표현이 버그의 원인이었다). 끝까지 테스트 2개: 타입으로만 아는 루트 아래 리터럴·
  `/` 없는·`/`로 끝나는 접두사, `no-slash`, 모르는 접두사 뒤 리터럴 접두사, `fastify-plugin`, base 아래 `@fastify/static` 스코프 없음; 4·5·모름(`*`)
  ·`ignoreDuplicateSlashes`의 이음. 변이: `main` 구현으로 되돌리면 3개, base에서 늘 꼬리를 비우면 1개, 주 버전을 늘 5로 보면 1개, 모르는 주
  버전을 5로 보면 2개, 제공 경로 스코프가 앵커를 보지 않으면 1개, 빈 앞부분에 주 버전 규칙을 쓰면 1개, 타입으로만 아는 루트를 root로 보면
  2개, `ignoreDuplicateSlashes` 처리를 빼면 1개가 실패한다.
- 적대 입력 20모양 × fastify 5.2.0·4.28.1·`*` = 60개(`scratchpad/r5-tsograph/adv/mk.mjs`, 사실·한계·스코프를 `main`과 비교): 바뀌지 않은 것은
  모르는 접두사·partial 접두사 바로 아래(base에 합침, a04·a05), `fastify-plugin`(a06), base 아래 `@fastify/static`(a08, 스코프 없음 유지),
  `Fastify()` 앱(a12), JSDoc으로만 타입을 단 JavaScript(a14, 원래 사실 없음), autoload·동적 import(a17), 5와 4 + `ignoreDuplicateSlashes`의
  이음(a18-v5, a20). 바뀐 것은 모두 실제 실행 결과 쪽으로 바뀌었다: a01(`/users`…), a02(`bare` → `/bare/x`), a03(`/v1/` 아래 `/users`·`bare`, 4는
  `/v1//bare/y`, 모름은 `/y` base), a07·a16(모르는 접두사 뒤 리터럴), a09(`slash`·`no-slash`·`both`), a10(조건부 등록 스코프 `/users/cond`,
  dynamic 사실의 접두사), a11(타입 루트에서 타입 루트로 register), a13(`/` 접두사 아래 `/`는 `/`·`//`), a15(`/users/:org` 접두사), a18-v4·vx,
  a19(base 아래 `/v1/`·`bare`). `unresolved-route-prefix:` 수는 base decl이 늘어난 만큼 늘었다(예: a01 5 → 6, `/users`와 `/users/`).
- 실제 프로젝트(`routes --role server`, `generatedAt`·`project` 제외 비교): fastify/demo, yonathan06/fastify-typescript-starter,
  fastify/fastify-example-todo, delvedor/fastify-example-twitter, 저장소 `fixtures/node/fastify4-app`·`fastify5-app`은 stdout·stderr가 같다(이 표본에는
  타입 루트 아래 접두사 register나 4의 `/`로 끝나는 부모 접두사가 없다).
- 검증: 아래 "5회차 검증".

### 5회차 검증

마지막 재확인 리뷰 반영 뒤(2026-11-25, Node 22.23.4, TypeScript 5.9.3, Git 2.43, root 컨테이너, 다른 세션과 공유한 4코어 load 1~3.5).

- `npx tsc --noEmit` 통과.
- 상한 없이 `scripts/run-tests.mjs`와 같은 인자로 돌린 전체 suite(5분 17초, 그 뒤 고친 것은 CommonJS 재내보내기 테스트의 기대 하나뿐이고 Fastify
  테스트 세 파일 집중 실행 55/55로 확인): 1,849개 중 1,825 통과·23 skip·1 실패. 실패는
  `relation-facts`의 `chmod 000`(root 컨테이너, 기존 환경 문제)뿐이다. 커버리지 라인 98.72%·분기 91.72%·함수 98.23%(90% 게이트 통과),
  `fastify-adapter.ts` 100/92.02/97.14, `fastify-skip-override.ts` 99.63/93.00/98.81(미실행은 `++`·`--` 대입 대상 두 줄과 checker 예외 처리 세 줄).
  앞 회차들: 첫 커밋 40분 54초(load 20~32), 첫 리뷰 반영 11분 57초, 재확인 반영 6분 6초(모두 같은 환경 실패 1).
- `npm run verify:cli`: 통과(`Build contract verified: clean dist output.`, `CLI contract verified: 0/2/64 (1 reserved)`).
- isthmus `node ../isthmus/scripts/conformance-drift.mjs tsograph=.`: 모든 벡터 current(로컬 isthmus `4a3e99d`).
- 자기 분석(`graph --generated-at 2026-11-15T00:00:00Z`): 새 분석기를 `db64014` worktree에 돌린 결과는 `db64014` 분석기 결과와 stdout·stderr
  바이트가 같다(앞 회차는 `2dac50e`·`60553ce`와 같은 비교). 이 head 트리와의 노드·간선 차이는 바뀐 네 파일(`fastify-skip-override.ts`·그 테스트·
  `fastify-adapter.test.ts`·`router-interpreter.ts`) 안뿐이다(노드 10,420 → 10,453, 간선 15,224 → 15,304, 바뀐 파일 밖 변화 0, `candidate-dispatch`
  214 → 219·`unresolved-calls` 4,564 → 4,573은 새 코드의 호출). 그 밖의 limitation 차이(`effect-inventory` 문맥 수, `skipped-symlinks`)는 worktree의
  `node_modules` symlink 때문에 생기는 줄뿐이다.
- 실행하지 못한 것: GLM 리뷰(`packet-ask` 없음), Git 2.45+ change 캡처 테스트(로컬 skip), macOS·Windows·Node 24/26 job(CI), `runuser -u nobody`
  재실행, 저장소 오라클(`experiments/node-routes-oracle`) 재기록(fixture를 바꾸지 않았다; 대신 리뷰어 하네스 `rt4`·`rt5`의 fastify 4.29.1·5.12.8로
  새 모양을 직접 실행했다). TS 네임스페이스·`import x = require()`·TS 파일 `require()`는 Node의 타입 지우기로 실행할 수 없어 실제 실행 대신 같은
  값이 패키지 함수에 닿는다는 의미로 판단했다.

### PR #62 독립 리뷰 반영 (2026-11-25, `e381053` 위)

리뷰어 fixture(`scratchpad/r5-review-tsograph/fx` 43개, 실제 fastify 4.29.1·5.12.8 하네스 `rt4`·`rt5`)와 반영용 fixture 22개
(`scratchpad/r5-tsograph/rv/mk.mjs`: `routerOptions`·최상위 옵션 × 4·5·`*`, skip-override 11모양)를 `2dac50e`·`e381053`·새 head와 실제 실행에 돌렸다.

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| SF1: `routerOptions.ignoreDuplicateSlashes`를 fastify 4·주 버전 모름에서도 믿음 — fastify 4.29.1은 `routerOptions`가 없어 `/v1//bare/y`·`/v1//bare`·`/v1//bare/`·`/v1//`를 등록하는데 `main`·`e381053` 모두 `/v1/bare/y` 등을 정적 사실로 냄 | 고침: `fastifyCreation`이 옵션마다 최상위 값과 `routerOptions` 값을 따로 담고(`RouterOptionSources`), 펼칠 때 `effectiveOption`이 4는 최상위, 5는 `routerOptions`(없으면 최상위), 모르면 같을 때만 쓴다. `ignoreDuplicateSlashes`·`ignoreTrailingSlash`·`caseSensitive` 모두(`fmwOptions`·접두사 아래 `/`의 두 등록·`trailingSlash`·`caseInsensitive`)에 적용. 4는 실제 등록과 같아지고(`/v1//`·`/v1//bare*`·`/v1/a//b`, `routerOptions: { caseSensitive: false, ignoreTrailingSlash: true }`는 `/Mixed`·`/users`·`/users/` strict), 모름은 갈리는 이음이 dynamic, 옵션은 모르는 값(`trailingSlash` 생략) | 테스트 "routerOptions의 라우터 옵션은 fastify 5만 읽고 …"(4·5·모름 × 최상위·`routerOptions`, 세 옵션), `e381053`에서 실패. 변이: 4가 `routerOptions`를 읽음 1, 모름이 5 값을 씀 1 |
| SF2: 플러그인 바인딩에 직접 쓴 `Symbol.for('skip-override')`를 몰라 base 아래에서 `/p2/manual`(실제 `<바깥>/manual`)을 냄. root에서는 `main`부터 `/p2/manual`(실제 `/manual`) | 고침: `fastify-skip-override.ts`가 해석 대상 파일에서 그 심볼을 바꿀 수 있는 자리를 한 번 모으고(이름별 식별자 사용, import 지역 이름, CommonJS `module.exports[…]` 쓰기, 이름으로 풀 수 없는 대상의 쓰기), 등록한 함수의 바인딩마다 판정한다. 참 리터럴을 모듈 최상위에서 조건 없이 쓰거나(`const` 키·다른 이름 import 포함) `fastify-plugin`에 넘기면 건너뜀(접두사 무시), 함수 안·조건 아래의 쓰기·모르는 키·`register()` 첫 인자 밖의 호출 인자·변수·객체·배열·반환값으로 흘러간 바인딩·이름 없는 대상의 쓰기가 있으면 모름 → 접두사를 모르는 값(root dynamic, base는 base에 합침). 등록 인자에서 따라간 `const` 별칭은 함께 본다. 모르는 감싸기(`wrap(fn)`)는 원래 걷지 않고 `route-coverage:`로 센다 | 테스트 넷(root 10모양, base, CommonJS·이름 없는 대상, 값의 참·거짓·`delete`·`??`·대입으로 흘러감), `e381053`에서 모두 실패. 변이: 모름이 접두사를 그대로 둠 3, 조건 아래를 최상위로 봄 1, 흘러간 바인딩을 무시 1, 이름 없는 대상 무시 1, `module.exports` 쓰기 무시 1, `const` 키를 못 풂 1, 등록 별칭을 흘러감으로 봄 1, `register()` 인자를 흘러감으로 봄 2, 다른 이름 import 무시 1, 등록 별칭 이름을 찾지 않음 1, 숫자 참 리터럴 무시 1, `delete`를 쓰기로 보지 않음 1, `??`·대입 오른쪽을 흐름으로 보지 않음 각 1 |
| nit 1: 모르는 접두사(`process.env.TENANT`) 아래 `/users/:id`와 `/users` 아래 `/:id`가 둘 다 `/users/{}` base라 isthmus `route-decl-conflict` 경고가 날 수 있음 | 문서화(CHANGELOG·NODE-ROUTES의 남은 한계). base에 합치는 설계에서 둘을 가를 정보가 없다 | — |
| nit 2: 주 버전 모름에서 사실 수가 등록 수보다 더 준다(7 → 5) | 문서화(위 2번 항목, CHANGELOG, NODE-ROUTES) | — |

- 바뀐 출력(리뷰어 fixture 43개 중 `e381053` 대비): d3-ids-routeropts-v4(실제 4와 같아짐)·-vx(갈리는 이음 dynamic), f1-fp-indirect(`/p2/manual` →
  `/manual` base), f2-skip-root(`/p2/manual` → `/manual` root). 나머지 39개는 같다. 반영용 22개: `routerOptions` 4·모름 넷과 skip-override 9개가 바뀌고
  최상위 옵션 6개·`routerOptions` 5 둘·무해한 속성 쓰기(`autoPrefix`·`'meta'`)는 같다. 실제로 건너뛰지 않는
  `export const registry = { users }`처럼 흘러간 바인딩은 dynamic이 된다(건전하지만 덜 정밀).
- 5회차 적대 입력 60개와 실제 프로젝트 여섯 개는 `e381053`과 출력이 같다.
- 비용(이 시점, 무해한 모양만 쟀다): 합성 앱(플러그인 N개를 접두사로 등록, 파일 2N개)의 CPU user 시간은 N=600에서 `e381053` 3.8~4.3초·
  `60553ce` 4.4~4.5초, N=2400에서 7.0~7.1초·6.4~8.3초. 같은 이름 바인딩이 많은 적대 모양은 재확인 리뷰 D에서 이차로 드러났다(아래 절).
- 이 절의 판정 규칙 일부(해석 대상 파일만 보기, 이름으로 풀 수 없는 대상의 리터럴 키만 전역으로 보기, 흘러간 바인딩은 모두 모름)는 재확인
  리뷰에서 바뀌었다(아래 "PR #62 재확인 리뷰 반영").

### PR #62 재확인 리뷰 반영 (2026-11-25, `60553ce` 위)

재확인 리뷰는 SF1을 완결로 확인했고 SF2에서 should-fix 넷과 nit 넷을 냈다. 새 fixture 9개(`scratchpad/r5-tsograph/rv2/mk.mjs`)와 리뷰어 fixture 83개
(`r5-review-tsograph/fx`, 실제 fastify 4.29.1·5.12.8 하네스)를 `60553ce`·새 head에 돌렸다(아래 표의 "실제"는 실제 등록 경로).

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| A: 해석 대상에서 빠지는 테스트 경로 규칙(`test/`·`tests/`·`e2e/`·`__mocks__/`) 파일의 쓰기를 못 봄 — `src/routes/test/index.ts`가 자기 플러그인에 skip-override를 써도 `/test/ping`(실제 `/ping`) | 고침: census가 프로젝트 파일을 모두 걷고 근거를 파일별로 둔다. 판정할 때 등록 호출·플러그인 함수·등록 인자에서 따라간 바인딩의 선언이 있는 파일은 늘 쓰고, 그 밖에는 해석 대상 파일만 쓴다 | 테스트 "해석에서 빼는 테스트 디렉터리 이름이어도 …", `60553ce`에서 실패. 변이: 늘 쓰는 파일을 무시 1 |
| B: 이름이 아닌 대상의 `const` 키 쓰기를 못 봄 — `plugins.users[SKIP] = true`·`P.users[SKIP] = true`가 `/u/x`(실제 `/x`) | 고침: 속성 접근도 바인딩 사용으로 세어 속성 심볼(객체 리터럴 속성, 네임스페이스로 가져온 내보내기)의 근거로 둔다(`plugins.users` 등록 인자의 사슬에 그 심볼이 있다). 값의 출처를 따라가지 않는 대상(매개변수·반복 변수·구조 분해·원소 접근·호출 결과)에 skip-override 키(리터럴·`const`)를 쓰면 모든 플러그인이 모름이다. 모듈 객체(네임스페이스·`require()`·`import()`·`module.exports`)가 흘러가거나 원소로 읽히거나 그 아래에 계산된 키로 쓰이면 그 모듈이 내보낸 플러그인이 모름이다(`Object.values(P)` 반복) | 테스트 "const 키·네임스페이스 속성에 쓴 …"(고정된 속성 둘은 실제처럼 접두사 없음, 반복 변수·매개변수 대상은 모름)와 "require() 모듈 객체가 흘러가면 …"(점 접근만 하면 그대로, `Object.keys(mod)`·`require()[k]` 읽기면 그 모듈이 내보낸 플러그인만 모름, 같은 파일의 내보내지 않은 함수는 그대로), 둘 다 `60553ce`에서 실패. 변이: 속성 대상을 바인딩으로 잇지 않음 2, 모든 바인딩을 값이 정해진 것으로 봄 1, 속성 사용을 세지 않음 1, 모듈 객체 사용 무시 1, 내보낸 바인딩을 못 알아봄 1, 대입 왼쪽을 흐름으로 봄 1 |
| C: `--include-tests`에서 테스트 전용 코드가 운영 사실을 바꿈 — `src/users.test.ts`의 `fp(users)`로 운영 등록이 `/`·`/{}`(실제 `/users/:id`, 새 거짓 사실) | 고침: 테스트 소스에 있지 않은 등록에 대해 (늘 쓰는 파일이 아닌) 테스트 소스의 근거는 많아야 모름이다. 기본 실행에서는 테스트 소스가 해석 대상이 아니라 쓰지 않는다 | 테스트 "--include-tests의 테스트 소스는 …"(기본 실행은 `/users/{}`, `--include-tests`는 dynamic), `60553ce`에서 실패. 변이: 테스트 근거를 깎지 않음 1 |
| D: 이차 비용 — 등록마다 같은 이름의 모든 사용을 훑음(플러그인 3,000개 `plugin` 이름에서 6.7초 → 48.6초) | 고침: 이름별 사용을 심볼별로 한 번 묶고(첫 질의 때), 바인딩별 근거를 메모한다(`const` 별칭·매개변수를 따라가며 순환을 만나면 그 경로의 부분 결과는 메모하지 않는다) | `fastify-skip-override.test.ts`: 살펴본 사용 수가 플러그인 수에 선형(20개 → 320, 60개 → 960, 등록 둘씩)인지 결정적으로 본다. `60553ce`에서 실패(내보낸 계수 없음). 변이: 근거 메모 끔 1, 이름 묶기 메모 끔 1. 측정은 아래 |
| nit 1: 흘러간 바인딩의 정밀도 손실 — 도우미 `mountUsers(app, users)`(리터럴 접두사로 등록)가 dynamic, s4의 세 플러그인(객체·`console.log`·배열) | 일부 반영: 프로젝트 함수의 매개변수 자리는 그 매개변수의 사용을 따라 보고(본문이 `arguments`를 읽거나 나머지 매개변수·펼친 인자면 모름), `console.*` 인자는 바꾸지 않음으로 본다. `&&`·쉼표의 왼쪽은 흘러가지 않는다(함수 값은 참). 제안된 프로젝트 전체 게이트(skip-override·모르는 키·추적하지 않는 `fp()` 쓰기가 프로젝트에 없으면 흘러감을 무시)는 건전하지 않아 넣지 않았다: 바인딩을 받은 패키지 함수(예: `fastify-plugin`을 감싼 사내 패키지)나 그 바인딩을 다시 패키지로 넘기는 프로젝트 함수가 심볼을 쓸 수 있는데 그런 코드는 프로젝트 안에 쓰기로 나타나지 않는다. 객체·배열·다른 변수·패키지 함수로 흘러간 바인딩은 여전히 dynamic이고 비용을 문서에 적었다 | 테스트 "프로젝트 함수 매개변수로 넘긴 …"(도우미·두 단계 도우미·재귀·console은 접두사 유지, 저장·나머지 매개변수·`arguments`는 모름), `60553ce`에서 실패. 변이: 매개변수를 따라가지 않음 1, console을 무해로 보지 않음 1, `arguments` 무시 1, `&&` 왼쪽을 흐름으로 봄 1 |
| nit 2: `--include-tests`의 테스트 도우미(`build(users)`)가 운영 사실을 dynamic으로 만듦 | 매개변수 따라가기로 해결: 리뷰어 s8-tests(`build(p)`가 등록만 함)는 `--include-tests`에서도 `/users/{}`. 테스트 소스가 바인딩을 패키지 함수나 저장소로 넘기면 C 규칙대로 모름(dynamic)이다 | 테스트 "프로젝트 함수 매개변수로 넘긴 …", 리뷰어 s8-tests |
| nit 3: 주 버전 모름에서 두 위치의 `caseSensitive`가 다르면 "모름"이라 썼지만 `caseInsensitive`는 생략되어 대소문자 구분으로 읽힘 | 문구를 고침(CHANGELOG·NODE-ROUTES): `trailingSlash`만 모름을 표현하고, 증명했을 때만 싣는 `caseInsensitive`는 싣지 않아 대소문자 구분으로 읽힌다(대소문자만 다른 호출은 isthmus `route-case-mismatch` 경고) | — |
| nit 4: SF2 문서가 실제보다 넓게 말함("해석 대상 파일", 증명 못 하면 모름) | 문서를 실제 규칙대로 다시 썼다(CHANGELOG·NODE-ROUTES·이 절): 근거를 모으는 파일, 건너뜀·모름의 조건, 정밀도 비용, 남은 한계 | — |

- 바뀐 출력(`60553ce` 대비): 리뷰어 fixture 83개 중 s1-testdir(`/ping`), s2-prop-constkey(`/x`), s4-escape(`console.log`로 넘긴 orders가 `/orders/{}`),
  s9-helper-literal(`/users/{}`)이 실제 쪽으로 바뀌고 79개는 같다(`--include-tests`로 돌린 s8-tests는 dynamic → `/users/{}`, s10-test-fp는 `/`·`/{}` →
  dynamic). 새 fixture 9개 중 a1·b1·b2(실제처럼 접두사 없음), b3(`Object.values(P)` 반복 → dynamic), n1(도우미 → `/users/{}`, s4의 console 인자 →
  접두사 유지)가 바뀌었다. 5회차 적대 입력 60개, 반영용 22개, 실제 프로젝트 여섯 개는 `60553ce`와 같다.
- 비용(공유 4코어 load 1~4, wall/CPU user): 같은 이름 `plugin` 바인딩 N개를 31번씩 흘려보내는 적대 모양(`scratchpad/r5-tsograph/perf/gen3.mjs`)은
  N=1,500에서 `e381053` 3.5초/5.2초 · `60553ce` 10.5~10.7초/12.3~12.5초 · 새 head 3.5초/6.1초, N=3,000에서 5.1초/7.1초 · 34.2~41.1초/36.9~42.8초 ·
  5.3초/8.2초다. 리뷰어 perf1(1,500개)·perf3(3,000개)은 `e381053` 4.5초·5.1초, `60553ce` 11.3초·35.4초, 새 head 3.8초·5.1초, 무해한 perf2는 5.1초·
  5.2초·4.2초다. perf3은 `&&` 왼쪽을 흘러감으로 보지 않게 되어 `60553ce`의 dynamic 사실 6,000개가 `e381053`처럼 정적 사실 12,000개로 돌아왔다.
  perf1은 바인딩을 받은 프로젝트 함수(`tag(x) { return x; }`)가 그 값을 반환해(반환은 흘러감) 여전히 dynamic 15,000개다.
- 남은 한계(문서에 적음): 테스트 경로 규칙에 걸린 파일 중 등록·플러그인·바인딩 선언 파일이 아닌 운영 코드의 쓰기는 기본 실행에서 보지 않는다.
  이름으로 다시 내보낸 모듈 네임스페이스(`export { P }`)를 받은 쪽의 동적 접근은 따라가지 않는다.

### PR #62 마지막 재확인 리뷰 반영 (2026-11-25, `db64014` 위)

마지막 재확인 리뷰는 A~D를 완결로 확인했고, 새 매개변수 따라가기와 모듈 객체 규칙이 거짓 접두사 사실을 내고 비용 절벽을 더한다고 했다
(should-fix 셋, nit 셋, 지침 "건전함이 정밀함보다 먼저"). 고른 쪽: **매개변수 따라가기는 남기되 대상이 정적으로 하나인 호출만 따른다**
(`60553ce`의 "흘러가면 모름"으로 되돌리지 않았다 — 대상이 정해지지 않는 호출은 모두 모름이라 건전하고, 등록만 하는 도우미·`console` 도우미의
정밀도가 남는다). 리뷰가 허용한 "쓰기 없는 `const` 객체 리터럴 수신자의 메서드" 예외는 넣지 않았다(메서드는 모두 모름). 모듈 객체는 내보낸
값을 별칭·재내보내기를 따라 펼치는 쪽을 택하고, TypeScript가 별칭으로 잇지 않는 모양(`exports.P = require(…)`, TS 파일의 `require()` 구조
분해)은 흘러감으로 본다. 순환은 Tarjan 강연결 요소로 정확히 합쳤다(순환을 모름으로 보지 않았고, 재귀가 없어 깊이 상한도 두지 않았다).
리뷰어 fixture 112개(새 37개 포함, 실제 fastify 4.29.1·5.12.8 하네스)와 반영 중 만든 모양 20여 개를 `db64014`·새 head·실제 실행에 돌렸다.

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| SF1: 매개변수 따라가기가 정적 호출 대상 선언을 믿음 — p1(`let prepare`를 `markAll({ p })`를 부르는 본문으로 다시 대입), p2(`helper: Base = new Marking()`의 재정의 메서드)가 `/u/x`(실제 `/x`) | 고침: `projectFunction`이 식별자 호출만 보고, 별칭을 따라간 바인딩의 선언이 하나이며 본문 있는 함수 선언이거나 함수 식·화살표 함수를 초기값으로 둔 `const`이고, census가 이름별로 모은 대입 대상(대입·복합 대입·`++`/`--`·구조 분해 대입·`for (x of …)`·속성 대입) 중 같은 심볼로 풀리는 것이 없을 때만 따른다. 메서드·속성 호출, `let`·`var`, 다시 대입한 함수는 모름 | 테스트 "매개변수를 따라가는 호출은 대상이 정적으로 하나인 함수뿐이고 …"(p1·p2·다시 대입한 함수 선언·구조 분해 대입은 dynamic, `const`·함수 선언은 `/u/x`): 넷 모두 `db64014`는 `/u/x`(실제 `/x`, 실행 확인). 변이: 메서드 호출을 따라감 1, 재대입 무시 1, 구조 분해 대입을 못 봄 1. `const` 검사를 지운 변이는 살아남는다(재대입 검사와 겹친다: `let`도 다시 대입해야 다른 함수가 된다) |
| SF2: 모듈 객체 규칙이 재내보내기를 놓침 — b1(`export *` 배럴), b2(`export { users } from`), b3(`import * as P; export { P }`를 받은 `import { P }`)를 `markAll`에 넘겨도 `/u/x`(실제 `/x`) | 고침: 모듈 객체가 흘러가면 `getExportsOfModule`로 내보낸 값을 별칭 너머 선언까지 따라가 심볼·선언 근거로 두고, 내보낸 값이 다시 모듈이면 그 모듈도 펼친다(작업 목록, 재귀 없음). 모듈 객체는 이름이 아니라 심볼로 알아본다: 별칭을 따라가 모듈(파일 모듈·TS 네임스페이스)로 풀리는 식별자·속성 접근(`import { P as Plugins }`, `All.R`), `require()`·`import()`와 그 결과 변수(TS 파일의 상대 `require()`는 해석기와 같은 `requiredModule`로 파일을 찾고, 심볼이 없으면 그 파일의 플러그인 모두), `import().then` 콜백, `module.exports`·`exports`. 모듈 객체를 대입하면(`exports.P = require('./users')`) 흘러감이다 | 테스트 셋: "모듈 객체가 흘러가면 다시 내보낸 이름 …"(b1·b2·b3·이름 바꾼 b3·`All.R`은 dynamic, 점 접근만 하면 `/u/x`), "CommonJS에서 내보내기에 대입한 모듈 객체 …", "TS 네임스페이스·import().then·TS 파일의 require()·…"(`import().then`·TS `require`·`import x = require`·다시 내보낸 네임스페이스를 통째로·TS 네임스페이스·CommonJS `mount`). 다시 내보낸 네임스페이스를 통째로 넘기는 경우 말고는 모두 `db64014`가 `/u/x`인 거짓 사실이다(실제 `/x`, 실행 확인; 통째로 넘기면 한 겹만 보는 `markAll`에서 실제 `/u/x`라 건전하지만 덜 정밀하다). 변이 11(재내보낸 모듈 펼치지 않음, 별칭 이름 무시, 대입을 흘러감으로 보지 않음, 내보낸 별칭을 풀지 않음, `then` 무시, TS `require` 미해석, 네임스페이스 이름 무시, `module.exports` 흘러감 무시, 파일 근거·선언 근거 무시, 원소 읽기 무시) |
| SF3: 서로 부르는 도우미에서 계승 비용(도우미 9개 5.3초, 10개 41.9초) | 고침: 바인딩 근거를 Tarjan 강연결 요소로 재귀 없이 구해 요소의 근거를 합치고 모두 메모한다. 서로 부르기만 하는 도우미는 접두사를 지키고, 순환 어디서든 흘려보내면 순환 전체가 모름이다. 사용 자리는 바인딩마다 한 번만 분류한다 | 테스트 "서로 부르는 도우미의 매개변수는 순환을 한 번에 묶어 …"(살펴본 사용 수 2k(k-1)+2: 6개 62, 8개 114, 결정적), "순환 안의 한 도우미가 …"(두 도우미, 세 도우미 순환 가운데로 들어간 둘째 플러그인). 앞 것은 `db64014`에서 실패. 변이: 요소 합을 뿌리 근거만 씀 1, low 전파 끔 1 |
| nit 1: 긴 도우미 사슬(3,000~4,500개)에서 호출 스택을 넘겨 "nests too deeply"로 종료 2 | 위 Tarjan이 재귀 없이 돌아 사슬 길이와 상관없다. 깊이 상한을 두지 않아 사슬 끝까지 따라가 실제와 같은 `/u/x`를 낸다 | 테스트 "매개변수를 넘기기만 하는 도우미 사슬이 길어도 …"(6,000개), `db64014`에서 실패. 리뷰어 chain4500·chain6000은 `db64014` 종료 2 → `/u/x` |
| nit 2: A3 — 운영 코드가 부수 효과로 불러오는 `setup/test/mark.ts`의 쓰기를 버려 `/u/x`(실제 `/x`) | 고침: 해석 대상 파일에서 값을 불러오는 문자열 지정자(import·export·`import x = require()`·`require()`·`import()`, 타입 전용 제외)를 따라 닿는 파일은 해석 대상에서 빠졌어도 근거를 쓴다. 테스트 경로 파일이라 많아야 모름이다. 테스트 파일만 불러오면 그대로 버린다 | 테스트 "운영 코드가 불러오는 테스트 디렉터리 파일 …"(운영 import → dynamic, 테스트 파일 import·없음 → `/u/x`), `db64014`에서 실패. 변이: 불러오는 파일 무시 1, 그 `'yes'`를 줄이지 않음 1, 해석 대상 밖에서 따라가기 시작 1 |
| nit 3: 문서·PR이 실제 동작과 맞아야 함(순환·비용 한계 포함) | CHANGELOG·NODE-ROUTES·PR 초안을 새 규칙, 비용(살펴본 사용 수에 선형인 범위와 모듈 객체의 추가 근거), 정밀도 비용, 남은 한계로 다시 썼다. PR의 "등록 수에 선형이다"는 측정한 범위로 고쳤다 | — |

- 바뀐 출력(`db64014` 대비): 리뷰어 fixture 112개 중 a3·b1·b2·b3·p1·p2(`/u/x` → dynamic, 실제 `/x`), chain4500·chain6000(종료 2 → `/u/x`)의 8개가
  바뀌고 104개는 같다(p6·p10의 `/u/x`, b4의 `/x`, b0·h1~h3·p3~p5·p7~p9·p11·p12의 dynamic 유지). 반영용 22개·새 fixture 9개·적대 입력 60개, 실제
  프로젝트 여섯 개(fastify/demo·fastify-example-todo·fastify-example-twitter·yonathan06/fastify-typescript-starter를 다시 받아 돌림,
  `fixtures/node/fastify4-app`·`fastify5-app`)는 `generatedAt` 밖 출력이 같다.
- 근거 줄이기: 모듈 객체 근거는 흘러간 자리의 파일마다 두면 같은 배럴을 파일 M개가 흘려보낼 때 내보낸 값 N개 × M이 된다(N=M=2,000에서 5.1초,
  `db64014` 3.3초). 근거가 모두 `'unknown'`이라 판정에 늘 세는 파일(해석 대상, 그것이 불러오는 파일)은 하나만 남겨도 판정이 같으므로 하나로 줄였다
  (3.3초). 그 밖의 파일을 남기는 분기는 살아남는 변이가 있다: 늘 보는 파일인데 해석 대상이 불러오지 않는 파일은 해석기가 닿지 않아 실제로 생기지
  않는다. 이 배럴 모양에서 `db64014`는 정적 사실 4,000개(실제로는 모두 접두사 없음, 거짓)를 냈다.
- 비용(wall/CPU user, 공유 4코어 load 1~2, 새 head는 두 번 잰 범위): 리뷰어 perf1·perf2·perf3 `db64014` 3.7/6.0·4.0/6.3·4.7/7.5초, 새 head
  3.7~4.0/5.9~6.4·4.0~4.3/6.4~6.8·4.4~4.7/7.3~7.8초. 같은 이름 바인딩 적대 모양(`perf/gen3.mjs`) N=1,500은 3.4/5.4초와 3.4/5.6초, N=3,000은
  5.3/7.9초와 5.2~5.6/7.8~8.6초. 서로 모두 부르는 도우미 8·9·10개는 `db64014` 1.9·5.2·39.4초, 새 head 1.4초 안팎(고정). 도우미 사슬 3,000개는
  1.8초와 1.6초, 6,000개는 `db64014` 종료 2와 1.6~2.0초. 배럴 모양(`perf/gen4.mjs`, N=M=2,000)은 `db64014` 3.3초, 새 head 3.3~3.9초.
- 변이 23종 중 21종이 잡힌다(위 표 밖: 근거를 하나로 줄이며 늘 세는 자리까지 버림 1, JS 파일의 `require()` 구조 분해를 흘러감으로 봄 1). 살아남는
  둘(`const` 검사 제거, 늘 세지 않는 자리 버리기)은 위의 이유로 출력이 같은 변이다.
- 정밀도 비용(문서에 적음): 메서드·`let`·다시 대입하는 함수에 넘긴 바인딩, 흘러간 모듈 객체가 내보낸 플러그인 전부(다시 내보낸 네임스페이스 안을
  건드리지 않는 함수여도), TS 파일의 `const { a } = require('./x')`와 CommonJS 재내보내기(`exports.P = require('./x')`·`module.exports =
  require('./x')`, 아무도 넘기지 않아도)가 가리키는 모듈의 플러그인은 실제로 건너뛰지 않아도 dynamic이다. 받는 쪽에서 그 이름이 모듈 객체인지
  TypeScript가 잇지 않아(`exports.P`는 별칭이 아닌 속성 심볼이다, 확인함) 내보내는 자리를 흘러감으로 봤다.
- 남은 한계(문서에 적음): 문자열 리터럴이 아닌 `require(x)`·`import(x)`는 따라가지 않는다(그 결과가 흘러가는 것도, 그것으로만 불러오는 테스트 경로
  파일의 쓰기도 보지 않는다). 해석기도 그 모듈의 등록을 따라가지 않지만 같은 플러그인을 정적으로 불러와 등록하면 놓친다.
- 위 "PR #62 재확인 리뷰 반영" 절의 남은 한계 두 줄(테스트 경로의 그 밖의 운영 코드, `export { P }`를 받은 쪽)은 이 반영으로 닫혔다.

### 이번에 살펴보고 남긴 것 (5회차)

| 항목 | 이유 |
|---|---|
| `fp(fn, { encapsulate: true })`는 실제로 접두사를 붙이는데(`/encap/enc`) tsograph는 `GET root /enc`(거짓)를 낸다 | `main`부터 있던 문제다(리뷰가 범위 밖으로 정함). `fastify-plugin` 옵션 해석을 더하는 후속 수정이다. |
| `d.after(() => addUsers(d))`나 `for (const h of hooks) h(c)`로 부른 `FastifyInstance` 도우미의 라우트가 한계 없이 빠진다 | `main`부터 있던 해석기 한계다(리뷰가 범위 밖으로 정함). 콜백·반복으로 부른 함수를 걷거나 한계로 세는 설계가 필요하다. |
| 앱을 받은 도우미가 앱을 다른 도우미에 다시 넘겨 등록하면(`mountUsers(app, users)` → `inner(app, plugin)` → `app.register(plugin, …)`) 사실도 한계도 없다 | `e381053`·`60553ce`·새 head가 같다(재확인 반영 중 확인한 기존 해석기 한계). 위 항목과 같은 설계 문제다. |
| 도우미 매개변수로 받은 접두사(`mount(app, users, '/users')` → `register(plugin, { prefix })`)는 dynamic이다 | `e381053`부터 같은 기존 동작(리뷰어 s7-helper). 매개변수 값을 접두사로 푸는 해석기 개선이다. |
| 주 버전을 모르고 `ignoreDuplicateSlashes`가 버전마다 다르면 `/a//b` 같은 리터럴 경로는 겹친 `/`를 줄이지 않은 채 정적 사실이다 | 모르는 옵션 값을 끈 것으로 컴파일하는 기존 규칙(`Fastify(opts)`의 모르는 옵션과 같다)이다. 줄이는 버전에서도 그 요청은 줄인 경로로 받아지므로 거짓 사실은 아니다. |
| 타입 없는 JavaScript 플러그인(`module.exports = async function (fastify, opts) { fastify.get(…) }`, fastify-cli JS 템플릿·fastify-example-twitter·fastify-example-todo)과 `FastifyPluginAsync`로 문맥 타입만 받은 매개변수, JSDoc `@param {import('fastify').FastifyInstance}`는 라우터로 보지 않아 사실 0개·limitation 0개다 | 받는 쪽을 증명하지 못하는 호출을 사실로 낼지, 새 limitation(증명하지 못한 수신자의 등록 모양 호출 수)으로 알릴지는 설계 결정이다. 수신자 판정을 넓히면 거짓 decl이 생길 수 있어 반례 corpus가 필요하다. |
| 타입으로만 아는 루트 자신의 `get('/')`은 바깥 접두사가 비어 있지 않으면 `<바깥>`과 `<바깥>/` 둘로 등록되는데 `/` base 하나만 낸다 | 참인 사실이고(`<바깥>/`은 늘 있다) 빠진 `<바깥>`은 `unresolved-route-prefix:`가 덮는다. 바깥 접두사가 비었는지 모르므로 `<바깥>`을 따로 낼 근거가 없다. |
| SQL `DELETE FROM a USING b`·`MERGE INTO t USING s`의 `b`·`s`가 relation-use로 나오지 않는다(한계도 없다) | 계열이 공유하는 lexical 추출기(dartograph·cartograph 포트, 공유 벡터)의 규칙이라 교차 저장소 계약 변경이다. |
| `reach --max-depth -1`이 "unknown, repeated, or empty option"을 낸다(`-`로 시작하는 값은 값으로 받지 않는 파서 규칙) | 종료 코드 64는 맞고 문구만 덜 정확하다. 파서 공통 규칙이라 이번 범위 밖에 두었다. |
| 문자열 리터럴이 아닌 `require(x)`·`import(x)`의 결과가 흘러가거나 그것으로만 테스트 경로 파일을 불러오면 skip-override 근거를 보지 않는다 | 어느 모듈인지 모르면 모든 플러그인을 모름으로 봐야 하는데, 설정 로더(`require(configPath)`)처럼 흔한 모양이 프로젝트 전체를 dynamic으로 만든다. 해석기도 그 모듈을 따라가지 않으므로 같은 플러그인을 정적으로도 등록할 때만 생기는 누락이라 문서에 남겼다. |
| 다시 내보낸 네임스페이스를 통째로 넘기면(`markAll(All)`, `All`이 `export * as R`을 담음) 한 겹만 보는 함수여도 그 안의 플러그인이 dynamic이다 | 받은 함수가 얼마나 깊이 걷는지 모른다. 건전한 쪽을 택했다(실제 `markAll`은 한 겹이라 `/u/x`). |
| 4회차에 남긴 항목(`import type` 재내보내기 alias 간선, `import * as ns; export { ns }`, 산출물끼리만의 import 판정, 설정 루트 공백 반복 등) | 4회차 표의 이유 그대로다. |

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
     나머지는 모두 `config-unreadable: N compiler config(s) read for <결과> could not be parsed, so path aliases and imports in the sources
     they own may not resolve; files: [<경로>]; omitted: M` 한 줄에 적는다(주 설정은 다시 적지 않는다). `<결과>`는 그 계획이 설정을 읽은 목적
     (graph `calls`, routes server `route registrations`, client `requests`, navigation `screen registrations`, Next 진입 범위 `Next convention
     discovery`)이다. 두 문장 모두 계획 기준이라 문맥과 상관없이 같고, graph는 접두사와 상관없이 문맥 표시 없이 하나로 합치며
     (`PLAN_SCOPED_CONFIG_GAP`, 주 설정 문장은 고정 꼬리까지 맞춰 경로에 공백이 있어도 맞는다), routes는 문장 합치기로 하나만 남는다. 표시
     이름은 실패한 경로(스캔 루트 기준)이고, 같은 실제 파일을 여러 경로로 읽어 실패하면 실패한 경로 중 경로 순 첫 경로로 한 번만 적는다. 주
     설정과 같은 실제 파일은 목록에서 뺀다. 그 소스가 막히는지(소유권 충돌)는 nearest 소유자인지, reference로만 닿는지, 문맥 모드에 따라 달라 단정하지 않았다.
   - 경과: 첫 커밋 `e5343c2`는 `N other compiler config(s) (<이름>)`을 문맥마다 냈고, `b6d4052`는 경로·한 줄로 바꿨지만 대표 문장을 문맥의
     대표 설정 기준으로 남겨 fx15(루트 읽음, 소스가 `sub/`에만 있고 `sub/tsconfig.json`만 깨짐)에서 `tsconfig.json could not be parsed`(거짓)만
     나오고 `sub/tsconfig.json`은 이름이 없었다(델타 리뷰 B1).
   - 루트 공백 문장은 공백을 낸 설정의 스캔 루트 기준 경로를 쓰고, 스캔 루트의 대표 설정 하나만 냈으면(설정 자체로 비교하고 경로가 파일 이름과
     같을 때) 상태에 싣지 않아 기존 상태 `deepEqual` 테스트와 출력이 그대로다. `--workspace`로 경계를 넓히면 프로젝트 설정의 공백도
     `app/tsconfig.json`처럼 경로로 말한다(기존 테스트 기대값 하나를 바꿨다). 문장 함수는 `configParseGaps` 하나로 graph와 Node routes가 같이 쓴다.
   - 재현: typeorm 얕은 clone(`d5b143d`, 의존성 미설치라 `@tsconfig/node20`·`@docusaurus/tsconfig` extends를 못 읽음, 읽지 못한 설정 3개)
     `graph` → 루트 문맥 `undefined could not be parsed`, 잘 읽은 `playground`·`packages/codemod` 문맥에도 `tsconfig.json could not be parsed`.
     새 분석기: `config-unreadable: 3 compiler config(s) read for calls could not be parsed, …; files: ["docs/tsconfig.json",
     "packages/legacy-naming-strategies/tsconfig.json","packages/typeorm/tsconfig.json"]` 한 줄만 남는다(주 설정은 설정 없음이라 기본 옵션 문장이
     없다. `route-call-coverage:`도 같다). 합성 재현: 설정 없는 루트 +
     읽지 못한 `a/tsconfig.json` + 설정 없는 `b/app.ts`(Express)에서 graph·routes server·client 모두 `undefined` 문장, 루트 `tsconfig.json` +
     중첩 `jsconfig.json`의 건너뛴 `files` 항목은 graph·schema(`persistence-config:`)가 `of tsconfig.json`이라고 썼다.
   - 테스트 `src/graph/config-status-names.test.ts`(19개, graph·routes server·client): 위 세 모양, 같은 이름 설정 둘 읽기 실패(한 줄, 경로 둘),
     주 설정·중첩 설정 모두 읽기 실패(주 설정 문장 하나 + 주 설정을 뺀 목록), 루트와 같은 이름 중첩 `tsconfig.json`의 밖 include, 중첩
     `jsconfig.json`의 건너뛴 `files`, 루트 설정 자신의 공백은 이름 그대로(보호), fx15·fx16, fx01, fx18, fx11(둘 다 실패한 symlink 중복은
     `link/tsconfig.json` 하나), fx17, fx10, 재확인 리뷰의 e6(공백 있는 주 설정 경로, 두 문맥에서 한 번), e7(Next·Node 계획의 서로 다른 목록),
     e8(링크 경로로만 extends가 깨짐 → `deep/link/tsconfig.json`), e9(주 설정 파일을 symlink로 다시 읽음 → 주 설정 문장 하나, 보호).
     `ca7a2c3`에 이 파일을 돌리면 13개가 실패하고 e6·e7·e8 테스트가 그 안에 있다(e9는 `ca7a2c3`에서도 통과하는 보호 테스트). 변이(재확인
     반영 뒤): 주 설정 문장 패턴을 `\S+`로 되돌리면 1개(e6), 목록 문구에서 `read for <결과>`를 빼면 12개, 표시 이름을 실제 경로로 되돌리면
     2개(fx11·e8), 경로 순 마지막 경로를 쓰면 1개(fx11), 주 설정과 같은 실제 파일을 목록에서 빼지 않으면 1개(e9)가 실패한다. 델타 리뷰 때
     변이(대표 설정을 주 설정으로 쓰면 10개 등)와 첫 리뷰 때 루트 공백 변이도 그대로 잡힌다.
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
- 검증(2026-11-22, Node 22.23.4, TypeScript 5.9.3, Git 2.43, root 컨테이너, 다른 세션과 공유한 4코어). 재확인 리뷰 반영(`b86b1dd`) 뒤 다시 돌렸다.
  - `npx tsc --noEmit` 통과.
  - 리뷰어 fixture 31개(`scratchpad/r4d-fx` 21개 + `r5-fx` 10개, 실행은 `r4d-tools/run.sh`와 같은 인자, graph·routes server·client):
    `11ee842`·`ca7a2c3`·새 head에서 노드·간선·`graphRevision`·종료 코드가 31/31 같다. 문장 변화는 위 재확인·델타 리뷰 표대로다(e6 주 설정 문장
    한 줄, e7 server 목록 둘이 서로 다른 범위, e8 `deep/link/tsconfig.json`, fx11 `link/tsconfig.json`, e9 주 설정 문장 하나, 그 밖은 목록 문구만
    `read for <결과>`).
  - 상한 없이 `scripts/run-tests.mjs`와 같은 인자로 돌린 전체 suite(6분 24초): 1,827개 중 1,803 통과·23 skip·1 실패. 실패는 `relation-facts`의
    `chmod 000` 사례(root 컨테이너, 기존 환경 문제)뿐이다. 커버리지 라인 98.69%·분기 91.65%·함수 98.22%, `export-nodes.ts` 100/100/100,
    `program.ts` 100/97.02/99.21, `build-graph.ts` 99.71/94.51/97.06. 12분 상한 `npm test`는 돌리지 않았다(이번 실행 시간이면 상한 안이지만
    단계별로 돌렸다).
  - `npm run verify:cli`: 통과(`Build contract verified: clean dist output.`, `CLI contract verified: 0/2/64 (1 reserved)`).
  - isthmus `node ../isthmus/scripts/conformance-drift.mjs tsograph=.`: 모든 벡터 current(로컬 isthmus 체크아웃의 conformance는 `origin/main`
    `30285f9`와 같다).
  - 자기 분석(`graph --generated-at 2026-11-15T00:00:00Z`): 새 분석기를 `cea6584` worktree에 돌린 결과는 `cea6584` 분석기 결과와, 이 head 트리에
    돌린 결과는 `ca7a2c3` 분석기 결과와 stdout·stderr 바이트가 같다(자기 분석에는 새 문장이 나오지 않는다). `cea6584` 트리와의 차이는 바뀐 여덟
    파일 안뿐이다(노드 10,174 → 10,306, 간선 14,761 → 14,999, bound 간선 710 → 731·호출 740 → 742, `unresolved-calls` 4,555 → 4,557, 바뀐 파일을
    건드리지 않는 노드·간선 변화 0). 두 번 돌려 바이트가 같다.
  - corpus(`cea6584`·`ca7a2c3`·새 head): graph는 rxjs·yaml(`ca7a2c3`와 같음)과 typeorm(`ca7a2c3` 대비 목록 문구만 `read for calls`)만 바뀌고
    노드·간선·통계·`graphRevision`·stderr는 같다. 나머지 열두 대상은 바이트가 같다. `routes`(`generatedAt` 제외)는 typeorm client만 목록 문구가
    `read for requests`로 바뀌고 `schema`는 네 저장소 모두 같다.
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

### PR #61 재확인 리뷰 반영 (2026-11-22, `11ee842..ca7a2c3` 리뷰)

리뷰어 fixture 31개(`r4d-fx` 21개 + `r5-fx` 10개)를 `11ee842`·`ca7a2c3`·새 head에 돌렸다. 노드·간선·`graphRevision`·종료 코드는 세 빌드에서 같다
(결과는 아래 검증).

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| SF1: 주 설정 경로에 공백이 있으면(`my app/tsconfig.json`, e6) 주 설정 문장이 문맥마다 반복 | 고침: 계획 기준 문장 패턴을 `program.ts`의 `PLAN_SCOPED_CONFIG_GAP`으로 옮기고 주 설정 문장은 고정 꼬리까지 맞춤 | e6 테스트, `\S+`로 되돌리면 실패 |
| SF2: Next 진입 범위 계획(route 파일 + 루트 `include`)이 Node routes 계획보다 설정을 적게 읽어 한 server 문서에 같은 문구의 `config-unreadable: 1 …`과 `2 …`가 함께 나옴(e7, graph도 `graph-config: … 2`와 `route-coverage: … 1`) | 고침: 목록이 `read for <결과>`로 계획의 범위를 말한다(Next `Next convention discovery`, Node routes `route registrations`, graph `calls` …). 두 줄은 범위가 다르다고 문장에 적힌다 | e7 테스트(server·graph), 범위 없는 문구로 되돌리면 실패 |
| N1: 실제 경로를 적으면 다른 경로로 잘 읽힌 파일을 실패했다고 말함(e8: `sub/`로는 읽히고 `deep/link/`로만 `extends`가 깨짐) | 고침: 실패한 경로를 적고, 같은 실제 파일을 여러 경로로 읽어 실패했을 때만 경로 순 첫 실패 경로로 한 번 | e8 테스트, 실제 경로 표시로 되돌리면 실패 |

### PR #61 델타 리뷰 반영 (2026-11-22, `4939c2a..11ee842` 리뷰)

리뷰어 fixture 21개(`r4d-fx`, 생성기 `r4d-tools/mkfx.sh`)를 `4939c2a`·`11ee842`·새 head에 돌렸다. 노드·간선·`graphRevision`·종료 코드는 21개
모두 세 빌드에서 같다.

| 지적 | 처리 | 회귀 근거 |
|---|---|---|
| B1 blocker: 문맥의 대표 설정 기준이라 fx15·fx16에서 `tsconfig.json could not be parsed`(거짓, 루트 설정 탓)만 나오고 `sub/tsconfig.json`은 이름이 없음, fx01은 routes에서 실패한 설정이 둘처럼 읽힘 | 고침(`e02ecbb`): 계획의 주 설정만 예전 문장, 나머지는 모두 목록 | fx15·fx16·fx01 테스트(graph·server·client), `11ee842`에서 실패. 대표 설정을 주 설정으로 쓰는 변이에서 10개 실패 |
| S1: Next 진입 범위의 `route-coverage: config-unreadable:`이 graph에서 문맥마다 반복(fx18) | 고침(`e02ecbb`): 접두사와 상관없이 전역 줄로 합침 | fx18 테스트, graph 접두사만 보는 변이에서 실패 |
| N1: symlink로 다시 참조한 같은 파일을 둘로 셈(fx11) | 고침(`e02ecbb`): 실제 경로 표시 이름으로 한 번(재확인 리뷰 N1에서 실패한 경로 중 경로 순 첫 경로로 바꿈) | symlink 테스트, realpath를 빼면 실패. 소유권 판정 자체는 남긴 것(위 표) |
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

## 다음 할 일 (5회차 이후)

0. 브랜치 `ccr-37904670-hxdjsx`의 5회차 커밋을 push해 PR로 올리고 CI(특히 전체 `npm test`·Git 2.45 경로·macOS·Windows)와 리뷰를 받는다.
1. 0.12.0 릴리스. 출력이 바뀌는 변경(새 direct 간선, bound→candidate, 새 limitation 접두사·문장, Fastify base 접두사)이 있으므로 마이너로 올린다.
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
