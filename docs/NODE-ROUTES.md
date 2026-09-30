# Node 백엔드 라우트 선언 규칙 (`tsograph routes --role server`)

tsograph가 Hono·Express·Fastify·Koa(@koa/router)·NestJS 프로젝트에서 isthmus http `route-decl` 사실을 만드는 규칙과, 각
규칙을 확인한 공식 소스를 적는다. 규칙은 추정하지 않고 npm 레지스트리에서 받은 아래 버전의 패키지 소스를 직접 읽어 확인했고,
합성 fixture를 실제 프레임워크로 실행한 오라클로 다시 확인했다(2026-09-30, [오라클](#오라클)).

| 패키지 | 확인한 버전 | 받는 선언 범위(`route-framework-version-unknown:` 기준) |
|---|---|---|
| hono | 4.13.12 | 주 버전 4 |
| express | 4.22.3(path-to-regexp 0.1.13), 5.2.1(router 2.2.0, path-to-regexp 8.4.2) | 주 버전 4·5 |
| fastify | 4.29.1(find-my-way 8.2.2), 5.12.5(find-my-way 9.9.0) | 주 버전 4·5 |
| @koa/router, koa-router | 15.7.0(path-to-regexp 8), 13.1.1(path-to-regexp 6.3.0), koa 3.2.1·2.16.4 | @koa/router 12–15, koa-router 12–14 |
| @nestjs/core·common·platform-express·platform-fastify | 12.1.2(10.4.19·11.2.7의 경로 조립 파일 대조) | 주 버전 10–12 |

프로젝트 루트 `package.json`의 의존성 선언으로 프레임워크를 감지하고, 설치 버전은 루트 잠금 파일(`package-lock.json`·
`npm-shrinkwrap.json`·`pnpm-lock.yaml`·`yarn.lock`·`bun.lock`)의 최상위 버전, 없으면 한 주 버전에만 걸리는 선언 범위로 정한다.
경로 문법이 주 버전마다 다른 경우(Express 4의 path-to-regexp 0.1과 5의 8, @koa/router 13의 6과 14 이상의 8) 주 버전을
모르면 두 문법이 같은 결과를 낼 때만 정적 사실로 내고, 다르면 dynamic이다. 모델링하지 않는 서버 프레임워크(`@hapi/hapi`,
`restify`, `polka`, `h3`, `elysia`, `itty-router`, `@hono/zod-openapi`의 `openapi()` 등)는 선언만 있어도 `route-coverage:`로 알린다.
루트 `package.json`이 있는데 읽지 못하면(깨진 JSON, UTF-8 아님, 16 MiB 초과, symlink) 프레임워크를 감지하지 못한 이유를
`route-coverage:`로 알린다.

분석 대상 코드는 실행하지 않는다. `tsograph graph`와 같은 방식으로 TypeScript `Program`·`TypeChecker`(루트 `tsconfig.json`, 없으면
`jsconfig.json`, 없으면 번들러 해석 기본값, `allowJs` 켬)를 만들어 import·재수출·기본 내보내기·CommonJS `require`를 따라간다.
emit·타입 진단은 하지 않는다. Next.js만 감지한 프로젝트에서는 Program을 만들지 않는다.

## 해석기

라우터는 여러 파일에 걸쳐 만들고 붙이는 경우가 흔해, 등록 호출을 실행 순서대로 모으는 정적 해석기(`src/routes/node/router-interpreter.ts`)를 쓴다.

- 모든 프로젝트 모듈의 최상위 문장을 모듈 프레임에서 순서대로 걷는다. 호출 식은 수신자 체인·인자를 먼저 평가하고 호출을
  나중에 본다(사건 위치는 호출 식의 끝). 인자로 넘긴 함수 식(핸들러·콜백)은 지금 실행되지 않으므로 걷지 않는다.
- 프레임워크 멤버(`get`·`use`·`route`·`register`…)를 부르는 호출은 수신자를 라우터 대상으로 푼다: 생성 식(`new Hono()`,
  `express()`, `express.Router()`, `new Koa()`, `new Router()`, `Fastify()`), `const`·초기값 있는 변수, import·재수출, 기본
  내보내기, CommonJS `module.exports`·`exports.x`·`require('./x')`, 객체 속성, 클래스의 `this.app`, 체이닝, Hono `basePath()` 파생,
  라우터를 돌려주는 프로젝트 팩토리 함수.
- 라우터를 인자로 받거나 만드는 프로젝트 함수 호출(`registerRoutes(app)`, `createApp()`, Fastify 플러그인)은 새 프레임에서 본문을
  걷는다(매개변수 → 호출 인자 바인딩, 깊이 8, 프레임 20,000개, 재귀는 한 번). 넘으면 `route-coverage:`로 센다.
- if·switch·반복문·catch·`?:`·`&&`·`||`·`??` 아래의 등록은 **조건부**다. 사실 대신 그 템플릿으로 스코프를 단
  `route-coverage:`로 낸다(pythograph의 Django 조건부 등록과 같은 결정).
- 어느 프레임에서도 걷지 않은 함수 중 라우터 문법이 있는 것(프로젝트 밖에서 부르는 `export default function (app: Hono)`,
  생성자에서 `this.app = express()`)은 마지막에 독립 프레임으로 걷는다. 타입 주석만으로 라우터임을 아는 매개변수(`Hono`,
  Express `Router`·`Express`·`Application`, @koa/router `Router`, `FastifyInstance`)는 붙는 위치를 모르는 라우터로 보고
  `pathAnchor: "base"`와 `unresolved-route-prefix:`로 낸다.
- 경로 값은 문자열 리터럴, `const`, import한 상수, 열거형 멤버, `as const` 객체 속성, 템플릿 문자열·`+` 연결을 따라간다. 앞부분만
  확정되면(`` `/users/${id}` ``) dynamic 사실의 `dynamicScope` 접두사로 쓴다. 등록 호출의 첫 인자는 리터럴·확정 문자열이면 경로,
  함수·라우터·패키지 미들웨어로 풀리면 아니며, 둘 다 아니면 타입이 문자열 계열이거나 뒤에 인자가 더 있을 때 경로로 본다
  (`app.use(process.env.PREFIX, router)`를 루트 mount로 잘못 읽지 않기 위해서다).

## 프레임워크별 규칙

### Hono 4

| 규칙 | 확인한 소스(hono@4.13.12 `dist/`) |
|---|---|
| `app.METHOD(path?, ...handlers)`는 핸들러마다 라우트를 더하고, 경로가 없으면 인스턴스의 마지막 경로를 쓴다(체인 `app.get('/a', h).post(h2)`만 따라가고 문장을 건너면 경로를 모른다). `all`은 모든 method, `on(m, p)`는 method·경로 배열, `query`는 계약 밖 동사 | `hono-base.js` 생성자 |
| HEAD 요청은 GET으로 디스패치한다 → `on('HEAD', …)` 라우트는 요청을 받지 않아 decl로 내지 않는다 | `hono-base.js#dispatch` |
| `use(path?, ...mw)`는 method `ALL`의 미들웨어(기본 경로 `*`). `next`를 받지 않는 함수는 요청을 끝내므로 라우트로 본다 | `hono-base.js` 생성자 |
| `route(path, sub)`는 **호출 시점의** `sub.routes`를 복사한다. `basePath(p)`는 라우터·라우트 배열을 공유하는 복제본. `mount(path, fn)`은 다른 앱을 `path/*`에 붙인다 | `hono-base.js#route`·`#basePath`·`#mount`·`#clone` |
| 경로는 `mergePath(basePath, path)`로 합친다(`/api`+`/`는 `/api`, `/api`+`''`는 `/api/`) | `utils/url.js#mergePath` |
| `:`로 시작하는 세그먼트 전체가 파라미터(`/:id.json`도 이름이 `id.json`), `:name{re}`는 정규식 제약, 세그먼트 중간의 `:`는 리터럴이지만 다른 파라미터와 섞이면 두 라우터가 달라 dynamic | `utils/url.js#getPattern`, `router/reg-exp-router/router.js`, `router/trie-router/node.js` |
| 파라미터는 빈 세그먼트와 맞지 않는다 | `trie-router/node.js#search` |
| 끝 `?`가 있고 `:`가 있으면 `checkOptionalParameter`로 펼친다(끝 `?` 세그먼트에 `:`가 없으면 빈 배열이라 등록되지 않는다) | `utils/url.js#checkOptionalParameter` |
| 끝 `/*`는 앞 경로 자체·끝 슬래시·아래 전부와 맞는다(`/{**}` + 0세그먼트 접두사 + 빈 값 변형). 중간·부분 `*`는 라우터마다 빈 세그먼트 처리가 달라 dynamic | `reg-exp-router/node.js`(`(?:\|/.*)`), `trie-router/node.js` |
| SmartRouter(RegExpRouter·TrieRouter)는 맞는 모든 핸들러를 **등록 순서**로 합성하고 먼저 응답한 핸들러가 이긴다(RegExpRouter는 겹치는 경로가 있으면 `UnsupportedPathError`로 TrieRouter에 넘긴다) | `router/smart-router/router.js`, `trie-router/node.js`(score 정렬), `compose.js` |
| `strict: false`면 요청의 끝 슬래시 하나를 떼고 비교한다. `hono/quick`·`hono/tiny`는 기본에서도 끝 슬래시를 무시했다(오라클) — 끝 슬래시 규칙을 싣지 않는다 | `utils/url.js#getPathNoStrict`, 오라클 |
| 대소문자를 구분하고 퍼센트 인코딩을 디코드한 경로로 비교한다 | `utils/url.js#getPath` |

### Express 4·5

| 규칙 | 확인한 소스 |
|---|---|
| `app.METHOD(path, ...handlers)`·`app.all`은 route 레이어 하나(`router.route(path)`). `route(path).get().post()`는 한 레이어에 method를 더한다. 인자 하나의 `app.get(name)`은 설정 조회 | express 4.22.3 `lib/router/index.js#route`, `lib/application.js` |
| 스택을 등록 순서로 걸어 경로가 맞고 method를 받는 첫 레이어가 받는다(`_handles_method`, HEAD는 GET). `next()`는 다음 레이어로 넘긴다 | express 4 `lib/router/index.js#handle`, router 2.2.0 `index.js` |
| `use(path?, ...fns)`는 끝이 열린 레이어(세그먼트 경계, strict 꺼짐). 라우터·앱은 요청 시점에 걸리는 참조 mount. 자식 경로 `/`는 붙인 경로와 끝 슬래시 형태 모두와 맞는다(`slashAdded`) | express 4 `#use`·`trim_prefix`, router 2.2.0 `#trimPrefix` |
| Express 4: path-to-regexp 0.1은 파라미터 밖 문자를 **정규식 원문**으로 둔다(`?`·`+`·`(`… → dynamic). `.`은 리터럴, `*`는 `(.*)`(빈 값 포함, 끝 세그먼트면 catch-all + 빈 값 변형), `:x?`는 앞 `/`까지 선택, `:x(re)`는 제약, `:x*`는 끝 catch-all, 앞 리터럴·`.:x`는 부분 세그먼트 | path-to-regexp 0.1.13 `index.js` |
| Express 5: path-to-regexp 8은 `:name`(한 글자 이상), `*name`(`/` 포함 한 글자 이상), `{…}` 선택 그룹을 쓰고 `()[]+?!`는 `PathError`. router가 non-strict 경로의 끝 슬래시를 떼고(`loosen`) `trailing: true`로 받는다 | path-to-regexp 8.4.2 `dist/index.js`, router 2.2.0 `lib/layer.js#loosen` |
| 원문(퍼센트 인코딩 그대로) 경로에 매칭하고, 기본은 대소문자 무시·끝 슬래시 선택이다. 앱 설정(`strict routing`·`case sensitive routing`)은 첫 등록 때 라우터를 만들며 읽으므로 그 전에 바꾼 값만 쓴다. `Router({strict, caseSensitive})`는 그 라우터에만 적용된다 | express 4 `lib/application.js#lazyrouter`, `lib/router/layer.js` |

### Fastify 4·5

| 규칙 | 확인한 소스 |
|---|---|
| `fastify.METHOD(url, [options], handler)`·`route({method, url, handler})`, `all`은 지원 method 전부. GET 라우트에는 HEAD가 자동으로 붙는다(`exposeHeadRoutes`) | fastify 5.12.5·4.29.1 `lib/route.js` |
| `register(plugin, {prefix})`는 새 캡슐화 인스턴스와 `buildRoutePrefix` 접두사. `fastify-plugin`(`skip-override`)은 부모 인스턴스를 쓰고 접두사를 무시한다 | `lib/plugin-override.js` |
| 접두사 아래 `/`는 `prefixTrailingSlash`(기본 `both`: `prefix`와 `prefix/`, `slash`, `no-slash`)대로 등록한다 | `lib/route.js#route` |
| find-my-way: 끝 선택 파라미터는 두 경로, `::`는 리터럴 `:`, 제약 없는 파라미터와 `*`는 **빈 값도 받는다**(빈 값 변형 decl), 한 세그먼트에 파라미터가 둘 이상이면 dynamic | find-my-way 9.9.0·8.2.2 `index.js#on`·`#_on`·`#find` |
| 정적 > 파라미터(정규식 먼저) > 와일드카드로 고르고 되돌아간다 → `specificity`. 같은 (method, 템플릿)의 명시적 정적 선언이 있으면 빈 값 변형은 요청을 받지 않아 뺀다 | `lib/node.js#getNextNode` |
| `caseSensitive: false`면 대소문자 무시, `ignoreTrailingSlash`면 끝 슬래시 선택(마지막 세그먼트의 빈 값 변형 없음), `ignoreDuplicateSlashes`면 중복 슬래시를 줄인다(v5는 `routerOptions`가 우선) | `index.js#find`, fastify 5 `lib/route.js#buildRouterOptions` |
| `constraints`(version·host)가 있는 라우트는 조건부(`narrowed: true`) | find-my-way `lib/constrainer.js` |

### Koa + @koa/router

| 규칙 | 확인한 소스 |
|---|---|
| `router.METHOD([name,] path, ...middleware)`: 둘째 인자가 문자열·정규식이면 첫 인자는 이름. 배열 경로는 레이어 여럿. GET 레이어는 HEAD도 받는다. `all`은 Node `http.METHODS` 전부, `redirect(src, dst)`는 `all` 라우트 | @koa/router 15.7.0 `dist/index.js#_registerMethod`·`#all`·`Layer#_normalizeHttpMethods` |
| `routes()`는 경로·method가 맞는 레이어를 **스택 순서**로 합성하고, 맞는 route가 없으면 다음 앱 미들웨어로 넘어간다 → 앱 `use` 순서가 라우터 사이 순서 | `#middleware`·`#match` |
| 레이어 경로에 라우터 `prefix`를 붙인다(`/` 경로는 strict가 아니면 접두사만). `router.use(path, nested.routes())`는 **호출 시점의** 중첩 스택을 복제해 접두사를 붙인다 | `Layer#setPrefix`·`#_applyPrefix`, `#_mountNestedRouter` |
| `exclusive`는 하나의 레이어만 돌려 등록 순서가 아니다(순서를 싣지 않는다). `host`는 라우터 전체가 조건부 | `#_buildMiddlewareChain`, `#matchHost` |
| 기본 대소문자 무시·끝 슬래시 선택(path-to-regexp `trailing`). 끝이 `/`인 경로는 그 슬래시가 필요하다(`/users/`는 `/users`와 맞지 않는다) | path-to-regexp 8.4.2·6.3.0 `tokensToRegexp` |
| @koa/router 12·13(path-to-regexp 6): `:x?` 선택, `:x*`·`:x+` 끝 반복, `(re)` 제약, `./` 접두사. 파라미터 뒤가 아닌 수정자는 `TypeError` | path-to-regexp 6.3.0 `dist/index.js#lexer`·`#parse` |

### NestJS

| 규칙 | 확인한 소스(@nestjs/core·common 12.1.2) |
|---|---|
| 경로 = 전역 접두사 + URI 버전 `/<prefix><version>` + RouterModule 모듈 경로 + 컨트롤러 경로 + 메서드 경로, `stripEndSlash(a) + addLeadingSlash(b)`로 잇고 끝 슬래시를 뗀다. `@Get()`의 경로는 `/` | `router/route-path-factory.js#create`, `common/utils/shared.utils.js`, `decorators/http/request-mapping.decorator.js` |
| 모듈의 `controllers`에 든 컨트롤러만 등록하고, 여러 모듈에 있으면 모듈마다 등록한다. 목록 원소는 펼치지 않는다. 메서드는 정의 순서(상속 메서드는 뒤). tsograph는 배열 리터럴·`const` 배열 참조·펼침(`...shared`)을 따라가고, 읽지 못한 원소가 있으면 `route-coverage:`로 알린다 | `scanner.js#reflectControllers`, `router/routes-resolver.js`, `metadata-scanner.js#getAllMethodNames` |
| `setGlobalPrefix(prefix, {exclude})`: 제외는 버전 접두사를 뗀 경로를 `pathToRegexp(path)` 기본값(대소문자 무시)으로 비교한다. tsograph는 리터럴 제외만 옮기고, 파라미터·식이 든 제외는 어느 경로가 접두사를 받는지 모르므로 `pathAnchor: "base"`다. `enableVersioning({type: URI, prefix, defaultVersion})`, `VERSION_NEUTRAL`은 버전 없음 | `route-path-factory.js#isExcludedFromGlobalPrefix`·`#truncateVersionPrefixFromPath`, `middleware/utils.js#mapToExcludeRoute`, `router/utils/exclude-route.util.js` |
| `RouterModule.register([{path, module, children}])`는 `normalizePath`로 모듈 경로를 잇는다 | `router/router-module.js`, `router/utils/flatten-route-paths.util.js` |
| Express 어댑터: Nest 10은 Express 4, 11·12는 Express 5에 `LegacyRouteConverter`(`files/*` → `files/{*path}`)를 거친다. 기본 대소문자 무시·끝 슬래시 선택 | `router/legacy-route-converter.js`, platform-express `express-adapter.js#normalizePath` |
| host 필터·헤더/미디어 타입 버전 필터는 조건이 맞지 않으면 `next()`로 넘긴다 → 조건부(`narrowed`)·순서 없음. `@Next()`를 받는 핸들러도 순서 없음 | `router/router-explorer.js#applyHostFilter`, express-adapter `#applyVersionFilter` |
| `routeResolutionStrategy: 'specificity'`는 등록 순서를 구체성으로 바꾼다(Nest 12) → 순서를 싣지 않는다 | `nest-application.js#registerRouter`, `router/route-specificity-sorter.js` |

## 디스패치 모델

| 프레임워크 | 문서 `dispatch` | `order.group` | 순서를 싣지 않는 등록 |
|---|---|---|---|
| Hono | `registration-order` | 요청을 받는 앱 하나(`hono:<만든 위치>`) | `next`를 받는 핸들러, 조건부, 앱을 만든 타임라인 밖(다른 모듈)의 등록, 동적 method |
| Express | `registration-order` | 루트 앱 하나(붙인 곳을 모르는 라우터는 그 라우터) | 셋째 매개변수 `next`가 있는 핸들러(isthmus #128 규칙), 조건부, 타임라인 밖 |
| Koa | `registration-order` | Koa 앱 하나(붙지 않은 라우터는 그 라우터) | `next`를 받는 핸들러, `exclusive` 라우터, 조건부 |
| NestJS(Express) | `registration-order` | 컨트롤러 하나 — 모듈 순서(DI 스캔)를 정적으로 증명하지 않고 컨트롤러 안의 메서드 순서만 싣는다 | `@Next()`, host·헤더 버전 필터, `routeResolutionStrategy` |
| Fastify, NestJS(Fastify), Next.js | `specificity` | — | — |

- 한 문서는 dispatch가 하나다. 등록 순서 프레임워크의 선언이 하나라도 있으면 `registration-order`이고, 같은 문서의 구체성
  프레임워크 선언(Next·Fastify)은 `order` 없이 내며 `route-dispatch-order-unknown:`으로 알린다(순서 없는 decl은 비교되지 않아
  모호함은 생겨도 거짓 가림은 없다).
- 한 index는 한 등록(소스 위치 하나)이다. method별 사실, 선택 세그먼트·빈 값 변형·catch-all 접두사 decl, Express `route()` 빌더의
  method들, 복사 mount로 여러 접두사에 복제된 같은 레이어는 같은 index를 공유한다. 배열 경로의 원소는 각각 한 등록이다.
- 순서는 인스턴스를 만든 타임라인 뿌리(모듈 최상위 또는 그 모듈에서 부른 팩토리·등록 함수) 안에서만 위치로 증명한다. 팩토리를
  여러 번 부르면 앱마다 다른 group이다(`<만든 위치>@<프레임 해시>`).
- 내보내기 전에 `order`를 계약 규칙(`src/exchange/dispatch-order.ts`, isthmus `dispatch.validate` 벡터)으로 다시 검사하고, 어긋나면
  순서를 모두 버린다.

## 사실 모양

- **channel**: 요청 경로 기준 정규 템플릿. 리터럴은 `tsograph openapi`와 같은 RFC 3986 정규화, 세그먼트 전체 파라미터는 `{}`,
  부분 세그먼트는 골격(`/files/{}.json`), 끝 catch-all은 `{**}`. 한 세그먼트에 파라미터가 둘 이상, 중간 catch-all, `.`·`..`
  세그먼트, 옮길 수 없는 정규식은 dynamic이다.
- **0세그먼트 catch-all**(Hono `/x/*`, Express `:x*?`, @koa/router `:x*`): `/x/{**}`와 `/x` 접두사 decl(`catchAllPrefix: true`, usr가
  있을 때만)을 함께 낸다. **빈 값 변형**(Express 4 `*`, find-my-way 파라미터·`*`)은 그 자리를 빈 값으로 채운 decl을 같은
  method·symbol·location으로 더한다. 펼친 템플릿이 16개를 넘으면 dynamic과 `route-template-expansion-capped:`다.
- **paramConstraints**: 파라미터 정규식이 숫자만 받으면 `int`, slug 문자(`[-A-Za-z0-9_]`)만 받으면 `slug`, 그 밖은 `regex`와 원문,
  catch-all은 정보용 `path`. `/`를 받을 수 있거나 빈 값을 받는 정규식은 dynamic이다(`.+`는 끝 catch-all).
- **trailingSlash**: 끝 슬래시를 정확히 비교하면 `strict`, 선택이면 `optional`, 빈 값 변형으로 생긴 끝 슬래시는 `strict`, `{**}`로
  끝나면 생략, 옵션을 확정하지 못했으면 생략.
- **caseInsensitive**: Express·Koa·NestJS(Express)의 기본값처럼 대소문자를 무시함을 증명한 경우만(mount 경로를 거친 모든 라우터가
  무시할 때). **narrowed**: Fastify `constraints`, Koa `host`, Nest host·헤더 버전 필터.
- **dynamic 사실의 channel**: 매칭에 쓰지 않는 정보용 원문이다. 증명한 앞부분 뒤에 풀지 못한 자리를 `{dynamic}`으로 적는다
  (`/api/{dynamic}`). 모든 어댑터가 같은 표기를 쓴다.
- **dynamicScope**: dynamic 사실의 증명된 정적 접두사(세그먼트 경계). 루트 앵커에서만 싣고, `methods`는 싣지 않는다(ANY 전용).
- **location**: 경로 인자(없으면 등록 호출, Nest는 메서드 데코레이터의 경로 인자 또는 데코레이터). **symbol**: `usr`는 핸들러 함수
  본문이 속한 그래프 노드(`src/lib/h.ts#listBooks`, `src/app.ts#UsersController.findOne`, 인라인 함수는 감싼 선언 또는
  `<path>#<module>`), `qualifiedName`은 같은 문자열이다. 감싼 핸들러(`asyncHandler(fn)`, `fn.bind(x)`)는 안쪽 함수를 쓴다.

## 한계와 스코프

| 상황 | 결과 |
|---|---|
| 조건부 등록 | 사실 없음, `route-coverage:` + 그 템플릿·method 스코프 |
| 정적으로 모르는 경로 | dynamic 사실 + `dynamicScope`, 같은 원인의 `route-coverage:`도 같은 접두사로 스코프 |
| 모르는 mount 접두사·타입으로만 아는 라우터 | `pathAnchor: "base"`, `unresolved-route-prefix:` + `templateSuffixes` 스코프(`{**}`·루트가 있으면 생략) |
| 계약 밖 동사(`query`, `purge`, `search`…) | 그 동사는 내지 않음, `route-coverage:` + 템플릿 스코프 |
| 정적 파일(`express.static`, `serve-static`, `koa-static`, `@fastify/static`, Hono `serveStatic`) | `framework-provided-routes:` + 붙인 경로 접두사, Express·Koa·Fastify는 `GET`·`HEAD`(Hono `serveStatic`은 method를 보지 않아 생략) |
| 모르는 패키지 미들웨어·플러그인, `@fastify/cors`(OPTIONS), `@fastify/autoload` | `framework-provided-routes:`·`route-coverage:` + 붙인 경로 접두사(없으면 스코프 없음) |
| 경로를 붙여 넘긴 값을 풀지 못함(`use('/x', require(dynamic))`), Hono `route()`의 풀지 못한 앱, `mount()` | `route-coverage:` + 그 접두사 |
| 핸들러가 프로젝트 밖·해석 불가 | usr 없음, `missing-route-usrs:`(체인 전용) |
| 인라인 핸들러, 요청을 넘긴다고 본 미들웨어 | `framework-dispatch-unmodeled:`(체인 전용) |
| 순서를 증명하지 못한 decl | `route-dispatch-order-unknown:` + 템플릿 스코프 |
| 확인하지 않은 주 버전, 모델링하지 않는 서버 프레임워크, symlink·크기 초과(4 MiB)·구문 오류 파일, 따라가지 못한 호출 | `route-framework-version-unknown:`, `route-coverage:`(스코프 없음) |

## 결정(초안·형제 도구와 다른 부분)

- **미들웨어는 요청을 넘긴다고 본다.** `use()`의 프로젝트 함수 중 `next`를 받는 것과 알려진 패키지(cors·helmet·morgan·
  body-parser·express.json…·Hono 내장 미들웨어·Fastify 공식 플러그인 대부분)는 라우트를 만들지 않는다고 본다. 인증 실패 401
  같은 응답은 라우트가 아니기 때문이다. `cors`는 OPTIONS 사전 요청에 직접 응답하지만 isthmus가 OPTIONS 호출을 `options-any`로
  이으므로 판정이 바뀌지 않는다. 목록에 없는 패키지는 응답할 수 있다고 보아 제공 경로로 알린다.
- **`next`를 받지 않는 `use()` 함수는 끝이 열린 라우트다**(`/p`와 `/p/{**}`의 ANY). 다만 본문이 404를 만드는 "찾지 못함"
  처리기(`res.status(404)`, `ctx.status = 404`)와 넷 매개변수 오류 처리기는 라우트로 내지 않는다 — 선언 없는 모든 경로를 받는
  decl이 되어 누락 호출을 모두 가리기 때문이다.
- **인라인 핸들러의 usr는 감싼 선언이다.** tsograph 그래프가 인라인 함수에 노드를 만들지 않으므로 별도 id를 지어내지 않는다.
  reach는 형제 코드까지 포함하는 과대 근사이고, `framework-dispatch-unmodeled:`로 알린다.
- **NestJS 순서는 컨트롤러 단위다.** 모듈 순서는 DI 스캔 순서라 정적으로 증명하지 않는다. 컨트롤러가 다르면 같은 템플릿이 겹칠 때
  isthmus가 모호함으로 본다(거짓 가림 없음).
- **복사 mount의 시점**: Hono `route()`와 @koa/router 중첩 `use()`는 같은 타임라인 뿌리에서 mount 뒤에 등록한 라우트를 복사하지
  않는다. 다른 모듈의 라우터는 import 때 모듈 전체가 먼저 실행되므로 모두 복사된 것으로 본다.

## 오라클

`experiments/node-routes-oracle/run-oracle.mjs <스크래치>`가 합성 fixture(`fixtures/node/*`)를 스크래치 사본에 npm 레지스트리로
설치하고 실제 프레임워크로 불러와(Hono `app.request`, Express·Koa·NestJS는 127.0.0.1 임시 포트, Fastify `inject`) tsograph 문서가
예측한 핸들러와 실제 응답(핸들러마다 고유한 `h:<이름>` 표식)을 대조한다. 탐침은 사실마다 채운 경로(method 그대로, ANY는
GET·POST·DELETE), 다른 method, 끝 슬래시를 바꾼 경로, 대문자 경로, 그리고 프레임워크 자신의 라우트 표(Hono `app.routes`,
Express·Nest 라우터 스택, @koa/router `stack`, find-my-way `on` 기록)를 채운 경로다. 예측은 isthmus 조인 규칙의 축약(method 먼저,
구체성 또는 group 안 index)이고, 조건부(narrowed)·dynamic 선언만 받는 요청은 받든 안 받든 맞는 것으로 본다.

| fixture | 프레임워크 | 정밀도(정적 사실) | 재현율(실제로 응답한 라우트) | 탐침 |
|---|---|---|---|---|
| `hono-app` | Hono 4.13.12 | 27/27 | 29/29 | 139/139 |
| `hono-loose-app` | Hono 4.13.12 (`strict: false`, `basePath`) | 4/4 | 4/4 | 19/19 |
| `express4-app` | Express 4.22.3 (CommonJS) | 22/22 | 34/34 | 134/134 |
| `express5-app` | Express 5.2.1 (ESM TS) | 14/14 | 13/13 | 67/67 |
| `koa-app` | Koa 3.2.1 + @koa/router 15.7.0 | 18/18 | 18/18 | 90/90 |
| `koa13-app` | Koa 2.16.4 + @koa/router 13.1.1 | 10/10 | 10/10 | 48/48 |
| `fastify5-app` | Fastify 5.12.5 + fastify-plugin 5.1.0 | 27/27 | 29/29 | 149/149 |
| `fastify4-app` | Fastify 4.29.1 (`ignoreTrailingSlash`, `caseSensitive: false`) | 5/5 | 5/5 | 39/39 |
| `nest-app` | NestJS 12.1.2 + platform-express | 13/13 | 18/18 | 71/71 |

기록(`experiments/node-routes-oracle/recorded/*.json`)은 절대 경로·시각 없이 문서의 사실·한계와 탐침 판정을 담는다.
`src/routes/node/oracle-replay.test.ts`가 네트워크 없이 지금 문서가 기록과 같은지, 모든 탐침이 통과했는지 다시 본다. 경로 문법
변환표는 `src/routes/node/node-conformance.test.ts`가 출처와 함께 고정한다(isthmus 벡터 모양, 나중에 `producer:tsograph`로 올릴 수
있다).

## isthmus 검증

isthmus `2954375`(origin/main)의 `check`가 모든 fixture 문서를 받는다(사실 0건 client 문서와 함께 종료 코드 0). Hono 문서에 대해
`/users/me`의 `route-decl-shadowed`(먼저 등록한 `/users/:id`), 없는 경로 호출의 `route-call-without-decl` error, dynamic
`dynamicScope` 안 호출의 `-unverified`를 확인했다. `trace`는 `tsograph reach`로 만든 forward 분석과 함께 Hono·Express·Koa·Fastify·
NestJS 문서를 받아 핸들러 usr로 체인을 만들었고, 모든 fixture의 route usr는 `tsograph reach`의 그래프 노드다.
