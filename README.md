# tsograph

<img src="https://raw.githubusercontent.com/ictechgy/tsograph/main/icon.png" alt="tsograph's kingfisher mascot" width="112" height="112" align="right">

[한국어](README.ko.md)

Static facts for TypeScript/JavaScript (Node) services, emitted in the
[isthmus](https://github.com/ictechgy/isthmus) bridge-facts exchange format.

tsograph is the TypeScript/JavaScript member of a family of static-analysis CLIs
(cartograph for Swift, kartograph for Kotlin, dartograph for Dart, gartograph for Go,
rustograph for Rust, schemagraph for SQL). Each tool reports only what it observes in its
own language; isthmus joins the documents.

## Status

| Area | State |
|---|---|
| `tsograph openapi`: OpenAPI 2.0/3.0/3.1 → `route-contract` facts | Implemented |
| `tsograph routes --role server`: Next.js App Router route handlers and Pages Router API routes → `route-decl` facts | Implemented |
| `tsograph routes --role server`: Node backends — Hono 4, Express 4/5, Fastify 4/5, Koa with @koa/router 12–15, NestJS 10–12 → `route-decl` facts ([rules](docs/NODE-ROUTES.md), Korean) | Implemented |
| `tsograph schema`: Prisma schema, Prisma Client, and raw SQL → persistence `relation-use` facts | Implemented |
| `tsograph schema`: Drizzle, TypeORM, Sequelize 6, knex, raw SQL drivers (`pg`, `mysql2`, SQLite, libSQL, postgres.js, Neon, Vercel Postgres, PlanetScale), Cloudflare D1 | Implemented ([docs/PERSISTENCE.md](docs/PERSISTENCE.md)) |
| Kysely, Objection, MikroORM, pg-promise, sequelize-typescript, MSSQL, Oracle, slonik relation-use facts | Planned (counted as limitations today) |
| `tsograph graph` / `reach` / `impact`: TypeScript/JavaScript call graph → isthmus `language-traversal` v1 | Implemented |
| Interface / dependency-injection dispatch: `bound` and `candidate` edges, `--dispatch`, per-root `evidence`, `unresolvedCalls` | Implemented |
| `tsograph routes --role client`: web/React Native fetch, axios and ky route-calls | Implemented |

The HTTP v1 contract is shipped in isthmus-cli **0.10.0**. `check` (including `--pairs`),
`query`, `trace`, and `diff --http` read `target: "http"` documents; `trace` also reads
`language-traversal` v1. Unimplemented extension fields remain explicit drafts and are rejected.
isthmus-cli 0.9.0 and earlier reject `target: "http"` documents.

## `tsograph routes --role client`

```sh
tsograph routes --role client --project ./web --service example-api > calls.json
tsograph impact --project ./web --roots-from affected-call-symbols.json
```

Extracts global `fetch` (web and React Native), symbol-proven axios imports/`create` instances,
and ky imports/`create`/`extend` instances as `platform: "js"`, `target: "http"`, `roles: ["client"]`.
Calls keep their enclosing graph id in `symbol.usr`, including screen callbacks. Request locations
use 1-based UTF-8 byte columns. Test sources are excluded unless `--include-tests` is passed.

Project wrappers such as `thttp(url, options)` are followed when the body is a single return or
arrow expression forwarding required arguments directly to a proven fetch/axios/ky call. Immutable
function aliases and methods on closed const object literals are supported, including direct async
returns. The fact belongs to the outer invocation. Exported or escaped wrappers and unrepresented
invocations retain the inner dynamic request so known calls do not hide other possible entries.

URL joins follow axios 1.20.0, ky 1.10.0 (`prefixUrl`) and ky 2.1.0 (`prefix`/`baseUrl`), with shared
isthmus vectors and 27 real local HTTP requests. ky option dialects require an unambiguous declared
major version. Full-segment interpolation produces `{}`; partial segments remain dynamic. Query,
fragment and userinfo are removed, and high-entropy/webhook path segments are masked.

Unknown spreads, mutable/escaped configuration, interceptors, hooks, adapters and unproven methods
retain `dynamic`, `methodDynamic`, `pathAnchor: "base"` or limitations. Wrappers with additional
statements, rewritten/default/rest arguments, class methods, URL/Request
objects, computed method access, runtime configuration, ky prefix+baseUrl combinations and global
fetch replacement are outside the proven scope. The coverage limitation remains even for zero calls.
The libraries are development-only dependencies for the oracle; the CLI does not execute analyzed code.

JSON output keeps sorted keys and readable indentation. If only the indentation exceeds the
16 Mi character exchange limit, the same complete document is emitted as compact JSON. Fact and
data limits stay unchanged; a compact document that still exceeds the limit fails without a partial
document. Large traversals can use `--max-depth` and `--max-reached` to return explicit truncation.

## Requirements

- Node.js 22.18.0 or newer
- isthmus-cli 0.10.0 or newer to join the documents (`npm install -g isthmus-cli`)

## Installation

```sh
npm install -g tsograph
tsograph --version
```

## `tsograph openapi`

```sh
tsograph openapi <spec-file> --service <name> [--project <root>] [--format json]
```

Reads one Swagger 2.0 or OpenAPI 3.0.x/3.1.x spec (JSON or YAML) and writes a
bridge-facts v1 document to stdout: `platform: "openapi"`, `target: "http"`,
`roles: ["server"]`, one `route-contract` fact per (path, method) operation.

- `--service` (required): service identity recorded on the document and on every fact.
- `--project`: the join root. `project` is its POSIX realpath and `location.path` is relative
  to it. Defaults to the spec's directory. A spec outside the project is a usage error.
- Exit codes: `0` success (zero facts is still success, not proof of completeness),
  `2` unreadable or invalid spec (the message states the cause and a fix, never the spec
  text or absolute paths), `64` usage error. `1` is reserved.

Example (synthetic):

```yaml
# api/openapi.yaml
openapi: 3.1.0
info: { title: Example, version: 1.0.0 }
servers:
  - url: https://api.example.test/v1
paths:
  /items/{itemId}:
    get:
      operationId: getItem
  /files/{name}.json:
    put: {}
```

```json
{
  "facts": [
    {
      "channel": "/v1/files/{}.json",
      "dynamic": false,
      "kind": "route-contract",
      "location": { "column": 5, "line": 10, "path": "api/openapi.yaml" },
      "method": "PUT",
      "pathAnchor": "root",
      "service": "example-api"
    },
    {
      "channel": "/v1/items/{}",
      "dynamic": false,
      "kind": "route-contract",
      "location": { "column": 5, "line": 7, "path": "api/openapi.yaml" },
      "method": "GET",
      "operationId": "getItem",
      "pathAnchor": "root",
      "service": "example-api",
      "symbol": { "qualifiedName": "getItem" }
    }
  ],
  "format": "bridge-facts",
  "generatedAt": "2026-09-27T01:27:56.718Z",
  "limitations": [],
  "platform": "openapi",
  "project": "/work/example",
  "roles": ["server"],
  "service": "example-api",
  "sourceModifiedAt": "2026-09-27T01:27:56.652Z",
  "target": "http",
  "tool": { "name": "tsograph", "version": "0.1.0" },
  "version": 1
}
```

The real output is key-sorted JSON with two-space indentation (the example is compacted).

### How facts are built

- **channel**: the canonical path template. The server path prefix (3.x `servers`, 2.0
  `basePath`) is prepended; scheme, host, and port are dropped. A parameter filling a whole
  segment becomes `{}`, a partial-segment parameter keeps its literal skeleton
  (`/files/{}.json`), and a segment with more than one parameter is emitted as `dynamic`.
  Literals use RFC 3986 pchar with uppercase `%XX`; unreserved characters are never encoded.
  Duplicate and trailing slashes and letter case are preserved. Query parameters and
  headers are not part of the key.
- **method**: the uppercase operation key. Keys are case-sensitive (`GET:` is not an
  operation). `trace` is an operation in 3.x only.
- **location**: the operation's method key, as a 1-based line and a 1-based UTF-8 byte
  column of the source file. Columns come from source offsets, so escape sequences earlier on
  the line (`\u0041`, `\"`, `\n` in JSON or YAML double-quoted strings) count as their
  written bytes, not their decoded values. A leading BOM is not counted.
- **symbol.qualifiedName** and **operationId**: the operationId when present (no `usr`).
- Server precedence: operation `servers` > path-item `servers` > root `servers` > default
  `/`. An empty `servers` array counts as absent.

### Fail-closed decisions

When a value cannot be proven, tsograph does not guess. It uses `pathAnchor: "base"`,
`dynamic: true`, or a limitation with one of the draft's contract prefixes, so isthmus
downgrades errors instead of reporting false ones.

- **Server variables in the path.** A variable with an `enum` is expanded into one fact per
  value (at most 256 combinations). A variable with only a `default` is an open value that
  clients may replace, so the prefix is **not** resolved: the fact uses `pathAnchor: "base"`
  with the literal tail after the variable, and the document gets
  `unresolved-contract-servers:`. A leading variable with no literal authority (`{base}/v1`)
  can change the path, so it is not resolved either.
- **Open variables in the host** are treated as path-neutral only when they sit strictly
  inside a host label: the URL has a literal `scheme://` or `//`, the authority has no userinfo
  (`@`), the variable ends before the host ends (it does not touch the authority/path boundary
  or the port), and its default contains no `/`, `@`, `:`, `[`, or `]`. So
  `https://{tenant}.example.com/api` stays `root` (tenant subdomains are common, and OpenAPI
  variables are substitution values for the URL template). Everything else is `base`:
  `https://api{env}/x` (empty or undeclared variable at the boundary), `https://{host}/api`
  (spans the whole host up to the boundary), `https://h:{port}/api`, `https://{user}@h/api`,
  and a free variable in the scheme (`{scheme}://h/api` without an `enum`).
- **Relative server URLs** (`v1`, `./v1`) are relative to wherever the document is served,
  so they are `base` as well. `/v1` is an absolute path and is `root`.
- **Multiple servers** with different path prefixes: one fact per distinct resolved prefix.
  If some servers resolve and others do not, both `root` and `base` facts are emitted.
- **Ambiguous URL spellings**: `.`/`..` segments (including `%2E`), backslashes, tabs, and
  line breaks in a server URL or `basePath` are interpreted differently by WHATWG and RFC 3986
  parsers, so they are `base`. An open variable whose value contains `?` or `#` is also `base`.
- **Swagger 2.0 `basePath`** that does not start with `/`, or contains braces, `?`, or `#`,
  is `base`.
- **Dot segments in a path key** (`/a/../b`, `/a/%2E/b`) are emitted as `dynamic`, because
  client URL normalization removes them.
- **`$ref`**: only local JSON pointers (`#/...`) are followed, for path items (including 3.1
  `components.pathItems`), with at most 16 hops. Non-local, broken, or cyclic references are
  counted under `contract-coverage:`. The network is never used.
- **Skipped input is counted, never dropped silently**: paths keys not starting with `/`,
  non-object path items or operations, unknown path-item fields, and dynamic templates all
  appear as `contract-coverage:` limitations. operationIds containing forbidden characters
  or longer than 1,024 characters are omitted and counted under `unsafe-operation-ids:`
  (informational).
- **3.1 `webhooks`** are requests the service sends, not routes it serves, so they are not
  emitted.
- **Templates longer than 2,048 characters** become `dynamic`, because the consumer rejects
  longer canonical templates.

### Input safety

- The spec is at most 16 MiB and must be valid UTF-8, with a single YAML document.
- Before parsing, a linear pre-scan caps the estimated value count (commas + colons + line
  breaks) at 1,500,000 and flow nesting depth at 1,000. The YAML parser uses about 1 KB per
  node, so larger inputs could exhaust memory. Split very large specs.
- Duplicate mapping keys are found by a linear-time scan (the parser's built-in check is
  quadratic in map size) and handled by where they occur:
  - **Rejected (exit 2)** where they can change facts or their locations: any root key
    (`openapi`, `swagger`, `servers`, `basePath`, `host`, `paths`, …), keys inside `paths`,
    every key of a path item (including one reached through a local `$ref`), the operation keys
    tsograph reads (`operationId`, `servers`), every key of a server object and of each server
    variable, and each key a followed `$ref` pointer passes through.
  - **Ignored** everywhere else (for example `components.schemas`, descriptions, examples,
    unused components, or an operation's `responses`). Parsing continues, the **first**
    occurrence wins (it cannot affect any fact), and the document gets the informational
    limitation `duplicate-mapping-keys: <count> duplicate key(s) outside route-bearing sections
    were ignored (first at line N)`, so the gap stays visible.
- Alias and collection mapping keys are rejected.
- YAML merge keys (`<<`) are rejected rather than ignored, because other tools expand them
  and silently dropping them could hide `servers`. YAML aliases are followed through a
  precomputed index with a budget of 100,000 dereferences. Custom tags are never executed, and
  the tree is never converted to JavaScript objects.
- Deep block (indentation) nesting is not counted by the pre-scan. The parser reports it as a
  resource error, and a stack overflow thrown from the parser is also mapped to exit 2. Any
  other unexpected internal error exits 2 with `internal error (<kind>)`, never a stack trace
  or the spec text.
- At most 100,000 facts are emitted (counted before any fact is built), and the output must
  fit the isthmus per-file input cap of 16 Mi characters. Beyond either limit the command
  fails instead of writing a partial document.

## `tsograph routes --role server`

```sh
tsograph routes --role server --project <root> [--service <name>] [--include-tests] [--format json]
```

Scans a Next.js project or a Node backend (Hono, Express, Fastify, Koa with @koa/router, NestJS)
and writes a bridge-facts v1 document to stdout: `platform: "js"`, `target: "http"`,
`roles: ["server"]`, `dispatch`, `sourceSets`, and one `route-decl` fact per (route, HTTP method).
The analyzed code is never executed and nothing is fetched from the network. Next.js route files
are read with the TypeScript parser only; Node backends are read through a TypeScript `Program`
(the same setup as `tsograph graph`) so routers can be followed across files. See
[Node backends](#node-backends) below.

- `--role server` (required): only the declaration side is implemented. `client` is a usage
  error until route-call extraction exists.
- `--project` (required): the project root (where `package.json`, `next.config.*`, or `app/`/
  `pages/` live). `project` is its POSIX realpath and `location.path` is relative to it. Node
  frameworks are detected from the dependencies of the root `package.json`; Next.js is scanned
  when `next` is declared, a `next.config.*` exists, or no Node backend framework is detected.
- `--service`: service identity recorded on the document and on every fact.
- `--include-tests`: also emit route files that look like tests, with `testSource: true`
  and `sourceSets.tests: "included"`. Without it they are skipped and the document declares
  `sourceSets.tests: "excluded"`. Test paths are `*.test.*`, `*.spec.*`, and files under
  `__tests__/` or `__mocks__/`. For Next.js, `test/` folders are not treated as tests, because
  they are real URL segments (`app/api/test/route.ts` serves `/api/test`); for Node backends,
  files under `test/`, `tests/`, and `e2e/` and `*.e2e-spec.*`/`*.e2e.*` files are tests too.
- Exit codes: `0` success (zero facts is still success, not proof of completeness), `2`
  unreadable project or oversized output (more than 100,000 facts, or more than 16 Mi
  characters), `64` usage error. A single unreadable route file is a limitation, not a failure.

### Verified Next.js semantics (next 16.2.7)

Each rule below was checked against the `next@16.2.7` package (its `dist/` sources and the
bundled docs under `dist/docs/`), not guessed.

| Rule | Source in `next/dist` |
|---|---|
| `app/` and `pages/` are looked up at the project root first, then under `src/` | `lib/find-pages-dir.js` (`findDir`) |
| A route handler is `route.<ext>` for each `pageExtensions` entry (default `tsx`, `ts`, `jsx`, `js`; `.mts` is **not** a default) | `server/lib/find-page-file.js`, `server/config-shared.js` |
| Handler methods are the exported names `GET`, `HEAD`, `OPTIONS`, `POST`, `PUT`, `DELETE`, `PATCH`; lowercase names and `default` are not handlers | `server/web/http.js`, `server/route-modules/app-route/module.js` |
| `HEAD` (when `GET` exists) and `OPTIONS` are implemented automatically; they are **not** emitted as decls (isthmus matches them with `head-as-get` / `options-any`) | `server/route-modules/app-route/helpers/auto-implement-methods.js` |
| Route groups `(name)` are removed from the path; `@slot` segments are removed too | `shared/lib/router/utils/app-paths.js` (`normalizeAppPath`), `shared/lib/segment.js` |
| Files and folders starting with `_` are excluded from the App Router scan; `%5F` spells a literal underscore | `build/route-discovery.js` (`ignorePartFilter`), project-structure docs |
| Dynamic segments are whole segments only: `[x]` → `{}`, `[...x]` → `{**}` (one or more segments), `[[...x]]` → zero or more; `[[x]]`, a non-final catch-all, names starting with `.`, and repeated names are build errors | `shared/lib/router/utils/sorted-routes.js`, `route-regex.js` |
| Every file under `pages/api` (and `pages/api.<ext>`) with a page extension is an API route, except `.d.ts`; `_` has no special meaning there; the handler receives every method | `lib/is-api-route.js`, `build/route-discovery.js`, API Routes docs |
| Pages Router API routes support `[...x]` and optional `[[...x]]` (`pages/api/post/[[...slug]].js` matches `/api/post` and deeper paths) | API Routes docs ("Optional catch all API routes"), `server/route-matchers/pages-api-route-matcher.js` (`RouteMatcher` + `getRouteRegex`) |
| Config files are tried in the order `next.config.js`, `.mjs`, `.ts` (`.mts` only when the runtime supports TypeScript) | `shared/lib/constants.js` (`CONFIG_FILES`) |
| `basePath` must be empty, or start with `/` without a trailing `/` | `server/config.js` |
| Trailing slash: with `trailingSlash: false` (default) `/x/` is 308-redirected to `/x`; with `true`, `/x` is redirected to `/x/` unless the last segment looks like `name.ext` or the path is under `.well-known`; `skipTrailingSlashRedirect: true` disables the redirect, and matching ignores the trailing slash | `lib/load-custom-routes.js`, `server/lib/router-utils/filesystem.js` |
| `proxy.<ext>` / `middleware.<ext>` sit next to `app`/`pages` (root or `src/`) | `build/index.js`, `lib/constants.js` |
| Metadata files (`sitemap`, `robots`, `manifest`, `icon`, `apple-icon`, `opengraph-image`, `twitter-image`, `favicon.ico`) create framework routes | `lib/metadata/is-metadata-route.js` |
| `public/` is served at the site root, the legacy root `static/` under `/static`, build assets under `/_next/static`, the image optimizer at `/_next/image`, Pages Router data under `/_next/data/<buildId>/`; all of them only after `basePath` | `server/lib/router-utils/filesystem.js` (`getItem`) |
| Files served from `public/`, `static/`, and `/_next/static` answer only `GET` and `HEAD` (other methods get 405) | `server/lib/router-server.js` |
| With `i18n`, static files are also looked up under the default-locale prefix; with `assetPrefix`, `<assetPrefix path>/_next/:path+` is rewritten to `/_next/:path+` | `server/lib/router-utils/filesystem.js`, `lib/load-custom-routes.js` |
| Routing picks the most specific match (static > `[x]` > `[...x]` > `[[...x]]`), so documents declare `dispatch: "specificity"` | `shared/lib/router/utils/sorted-routes.js` |

### How facts are built

- **Export forms**: `export [async] function GET`, `export const GET = …`, destructuring
  (`export const { GET, POST } = handlers`), `export { handler as GET }`, and re-exports
  (`export { GET } from './impl'`, `export { x as POST } from '…'`). Next dispatches on the
  exported **name**, so the name is certain even when the value comes from another module.
  Type-only and `declare` exports are ignored.
- **Unresolvable exports** are not guessed: `export * from '…'` and CommonJS assignments
  (`module.exports`, `exports.x`, `export =`) are counted under `route-coverage:`.
- **Pages Router**: one `ANY` decl per API file, located at `export default` (or the first
  CommonJS export). Files without a statically visible default export emit nothing and are
  counted under `route-coverage:` (helpers placed under `pages/api` stay out of the output).
- **channel**: `basePath` + the canonical template of the folder path. Static segments use the
  same RFC 3986 literal normalization as `tsograph openapi` (`café` → `caf%C3%A9`). A segment
  that mixes brackets with other text (`v[id]`) is not documented by Next.js (its router and
  regex builder disagree), so the fact is `dynamic` with a `route-coverage:` limitation.
- **`[[...x]]`** emits the `{**}` decl and the prefix decl without the catch-all (the
  contract's zero-segment expansion). The prefix decl carries `catchAllPrefix: true` (same
  method, symbol, and location as the `{**}` decl). isthmus requires `symbol.usr` on it, so a
  CommonJS handler (no usr) gets a plain prefix decl instead.
- **trailingSlash**: `strict` when the redirect rules above make one form canonical (the
  channel is that form), `optional` when no redirect applies and both forms reach the handler
  (`skipTrailingSlashRedirect: true`, `.well-known`, a last segment with a dot that neither
  redirect matches), omitted (unknown) when it depends on a parameter value or the config
  value is not a literal. `caseInsensitive` is never emitted (not proven).
- **location**: the exported name token (`GET`), or `default` for Pages Router, as a 1-based
  line and 1-based UTF-8 byte column. A leading BOM counts as its three bytes.
- **symbol.qualifiedName**: `<project-relative file>#<export name>`, for example
  `src/app/api/items/route.ts#GET` or `pages/api/hello.ts#default`.
- **symbol.usr**: the handler's tsograph graph id (see [Symbol ids](#symbol-ids)). It equals
  `qualifiedName` except for a named default export (`export default function handler` →
  `pages/api/hello.ts#handler`, because code inside it is attributed to `handler`). Aliases,
  destructuring, and re-exports (`export { GET } from './impl'`, `export const { GET } = h`)
  keep `<file>#<export name>`; `tsograph graph` has an export node with that id and an `alias`
  edge to the real declaration. CommonJS handlers (`module.exports = …`) have no usr and are
  counted under `missing-route-usrs:`.

### Configuration and limitations

`next.config.*` is read statically: `export default`, `module.exports`, or `export =`,
followed through `const` bindings, `satisfies`/`as`, and resolvable spreads. Names that are
reassigned, mutated, or passed to `Object.assign` are not followed.

| Situation | Result |
|---|---|
| Config exports a function, a non-object, nothing, or has syntax errors | `pathAnchor: "base"` + `unresolved-route-prefix:` |
| `basePath` is not a string literal, or is a value Next.js rejects | `pathAnchor: "base"` + `unresolved-route-prefix:` |
| Config passes through wrapper calls (`withX(config)`) | values read from the wrapped literal, `root`, plus `unresolved-route-prefix:` (a wrapper may change them or add routes) |
| `pageExtensions` is not a literal string array | default extensions + `route-coverage:` |
| `rewrites`, `redirects`, `i18n`, or keys tsograph cannot enumerate | `framework-provided-routes:` |
| `proxy`/`middleware` file, metadata files, non-empty `public/` or legacy `static/` | `framework-provided-routes:` (no synthetic decls) |
| An `app/` or `pages/` directory exists | `framework-provided-routes:` for the `/_next` endpoints |
| `@slot` or intercepting-route (`(.)x`) folders above a route file | not modeled (Next documents them for pages), `route-coverage:` |
| `app`, `pages`, `src`, `src/app`, or `src/pages` is a symbolic link | not followed (Next.js would pick it, so tsograph does not fall back to `src/`), `route-coverage:` naming the location |
| `next.config.*` is a symbolic link | not read, `pathAnchor: "base"` + `unresolved-route-prefix:`; a dangling link is treated as absent, like Next's `existsSync` |
| `package.json` is a symbolic link | not read, `route-framework-version-unknown:` |
| `public/` or a proxy/middleware file is a symbolic link | not read; still reported under `framework-provided-routes:` |
| Segment names Next.js rejects, syntax errors, unreadable/oversized/non-UTF-8 files, non-JavaScript extensions, symlinks (not followed), names with forbidden characters, scan caps (200,000 entries, depth 64) | `route-coverage:` |
| `package.json` does not declare `next`, or its range is not limited to major 16 | `route-framework-version-unknown:` |
| No `app/` or `pages/` directory | zero facts + `route-coverage:` |
| Handler exported through CommonJS (`module.exports = …`) | fact without `symbol.usr` + `missing-route-usrs:` |

All server-side prefixes come from the contract's closed list, so isthmus reads each one as
a server-side gap and downgrades `route-call-without-decl` to `-unverified` instead of
reporting a false error. Limitations carry counts and project-relative names only.

**Limitation scopes.** A limitation without a scope applies to every call in the document.
When tsograph can prove an upper bound for what a framework-provided route can serve, it adds
a `limitationScopes` entry (isthmus "http limitation scopes") so that only calls inside it
become `-unverified`:

| Limitation | Scope | Condition |
|---|---|---|
| `public/` | `templatePrefixes: [basePath or "/"]`, `methods: ["GET", "HEAD"]` | the config is fully resolved (no wrapper call, no keys tsograph cannot enumerate, a valid literal `basePath` or none) |
| legacy `static/` | `templatePrefixes: [basePath + "/static"]`, `methods: ["GET", "HEAD"]` | as above, and no `i18n` |
| `/_next` | `templatePrefixes: [basePath + "/_next"]` (methods differ per endpoint, so none) | as above, no `i18n`, and no `assetPrefix` |

Other framework-provided routes (proxy/middleware, metadata files, `rewrites`/`redirects`/`i18n`)
and every `route-coverage:`/`unresolved-route-prefix:` gap stay unscoped. `public/` is not
narrowed to its file list because a build step can write files there (service workers, sitemap
generators), so the files in the repository do not prove the served set; with no `basePath`,
`GET`/`HEAD` calls therefore stay unverifiable while other methods can be judged. Scope entries
are checked against the contract before they are written (`src/exchange/http-limitation-scope.ts`).

### Decisions (differences from the draft)

- **qualifiedName names the export, usr names the graph node.** `<file>#<export>` names the
  module export Next.js invokes; `symbol.usr` is the id `tsograph graph`/`reach`/`impact` use for
  the same handler, derived from the same (module path, export name) pair.
- **Optional catch-all prefix and usr.** isthmus requires `symbol.usr` on a `catchAllPrefix`
  decl. A CommonJS handler has no usr, so its prefix decl is emitted as a plain decl. Next.js
  rejects an explicit route at the same place (build error E458), so it cannot collide with an
  explicit decl; the cost is that it may appear in `route-decl-without-call` / drift warnings.
- **Wrapped configs stay `root`.** Treating every `withX(config)` as an unknown basePath
  would make most real projects `base`; the literal inside is used and the uncertainty is
  reported with `unresolved-route-prefix:`, which already prevents false errors.
- **Config lookup is the project root only.** Next.js searches parent directories too
  (`find-up`); pass the directory that holds `next.config.*`.

### Node backends

The full rule table with the verified package sources, the dispatch model, and the oracle results is in
[docs/NODE-ROUTES.md](docs/NODE-ROUTES.md) (Korean). Every rule was read from the npm packages (Hono
4.13.12, Express 4.22.3 and 5.2.1 with path-to-regexp 0.1.13/8.4.2, Fastify 4.29.1 and 5.12.5 with
find-my-way 8.2.2/9.9.0, @koa/router 15.7.0 and 13.1.1, NestJS 12.1.2) and re-checked by running the
synthetic fixtures under `fixtures/node/`.

- **Registrations** are collected by a static interpreter that walks module top levels in order and
  follows project functions that receive or create a router (`registerRoutes(app)`, `createApp()`,
  Fastify plugins): `app.METHOD`/`all`/`on`/`route()` builders, `use()`/`route()`/`register()` mounts
  with their prefixes, Hono `basePath()`, @koa/router `prefix`, Fastify `prefix` and `fastify-plugin`,
  and NestJS `@Controller`/`@Get`… with `setGlobalPrefix`, URI versioning, and `RouterModule`. Values
  are followed through `const`s, imports, enums, `as const` objects, template literals, and CommonJS
  `require`/`module.exports`.
- **Path syntax** is translated per router: Hono patterns, path-to-regexp 0.1 (Express 4), 8 (Express 5,
  @koa/router 14+), 6 (@koa/router 12–13), and find-my-way (Fastify, NestJS on Fastify). Optional
  segments expand into several templates, zero-segment catch-alls add the `catchAllPrefix` decl,
  find-my-way parameters (which match empty values) add empty-value variants, and parameter regexes
  become `paramConstraints` (`int`, `slug`, or `regex`). Anything the contract grammar cannot express
  is `dynamic`, with a `dynamicScope` prefix when a static prefix is proven.
- **Dispatch**: Hono, Express, Koa, and NestJS on Express pick the first matching registration, so a
  document with any of them is `registration-order` and carries `order: {group, index}` (group = the
  app that receives requests; NestJS: one controller). Handlers that can pass the request on (`next`
  parameter, `@Next()`), conditional or out-of-module registrations, exclusive Koa routers, and NestJS
  host or header-version filters get no `order`, reported under `route-dispatch-order-unknown:`.
  Fastify and Next.js are `specificity`; in a mixed document their declarations carry no order.
- **Flags**: `trailingSlash` and `caseInsensitive` follow the router options (Express/Koa defaults are
  case-insensitive with an optional trailing slash, Hono and Fastify are strict and case-sensitive by
  default); Fastify `constraints`, Koa `host`, and NestJS host/version filters set `narrowed`.
- **symbol.usr** is the graph node that owns the handler body: a named function or method id
  (`src/lib/books.ts#listBooks`, `src/users.controller.ts#UsersController.findOne`), or for an inline
  handler (also when wrapped, `asyncHandler(async (req, res) => …)`) its
  [inline callback id](#inline-callback-ids) (`src/app.ts#<module>.app.get("/users")`). Relation-use
  facts inside that handler carry the same id, so a trace goes route → handler → table without pulling in
  sibling handlers. An inline handler that gets no node of its own (inside a computed-name member) keeps
  the enclosing id and is reported under `framework-dispatch-unmodeled:`. `tsograph graph` marks these
  handlers as `route-handler` entry points.
- **Limitations** (all with scopes when an upper bound is proven): conditional registrations and
  non-contract verbs (`route-coverage:` with their templates), unresolved mount prefixes and routers known
  only by a type annotation (`pathAnchor: "base"` and `unresolved-route-prefix:` with `templateSuffixes`),
  static-file middleware and unknown package middleware or plugins (`framework-provided-routes:` with the
  mount prefix, `GET`/`HEAD` for static files), handlers outside the project (`missing-route-usrs:`),
  unverified major versions (`route-framework-version-unknown:`), and unmodeled server frameworks, symlinks,
  oversized or unparsable files (`route-coverage:`). Middleware that calls `next` and well-known packages
  (cors, helmet, body parsers, Hono built-ins, most official Fastify plugins) are assumed to pass requests
  on; a `use()` function that takes no `next` is an open-ended `ANY` route, except a trailing 404 handler.

**Oracle.** `experiments/node-routes-oracle/run-oracle.mjs <scratch>` installs each fixture into a scratch
copy from the npm registry, loads it with the real framework (Hono `app.request`, Express/Koa/NestJS on an
ephemeral 127.0.0.1 port, Fastify `inject`), and compares the handler each request reaches with the handler
tsograph's facts predict — including other methods, toggled trailing slashes, uppercased paths, and requests
built from the framework's own route table. Recorded 2026-09-30 (`src/routes/node/oracle-replay.test.ts`
replays the recordings offline):

| Fixture | Framework | Precision (static facts) | Recall (routes that answered) |
|---|---|---|---|
| `hono-app` | Hono 4.13.12 | 27/27 | 29/29 |
| `hono-loose-app` | Hono 4.13.12, `strict: false` | 4/4 | 4/4 |
| `express4-app` | Express 4.22.3 (CommonJS) | 22/22 | 34/34 |
| `express5-app` | Express 5.2.1 (ESM TypeScript) | 14/14 | 13/13 |
| `koa-app` | Koa 3.2.1 + @koa/router 15.7.0 | 18/18 | 18/18 |
| `koa13-app` | Koa 2.16.4 + @koa/router 13.1.1 | 10/10 | 10/10 |
| `fastify5-app` | Fastify 5.12.5 + fastify-plugin | 27/27 | 29/29 |
| `fastify4-app` | Fastify 4.29.1, `ignoreTrailingSlash` | 5/5 | 5/5 |
| `nest-app` | NestJS 12.1.2 + platform-express | 13/13 | 18/18 |

### Validation with isthmus

The synthetic fixtures under `fixtures/next/` were checked with the isthmus `main` consumer
(these consumers shipped in isthmus-cli 0.10.0):

```sh
tsograph openapi fixtures/next/app-router/openapi.yaml --service demo --project fixtures/next/app-router > contract.json
tsograph routes --role server --project fixtures/next/app-router --service demo > decl.json
# client.json: a zero-fact document with roles ["client"], the same project and service
node <isthmus>/src/cli/main.ts check contract.json decl.json client.json
```

The check exits 0 and reports the intended drift (`route-contract-without-decl` for
`GET /api/health` and `PUT /api/items/{}`, `route-decl-without-contract` for handlers the spec
does not list).

The `fixtures/node/` documents were checked with isthmus `2954375`: `check` accepts every document
(`route-decl-shadowed` for a Hono literal route registered after a parameter route, an error for a call with
no declaration, `-unverified` for a call inside a `dynamicScope`), and `trace` follows the handler usrs into
`tsograph reach` forward analyses.

## `tsograph schema`

```sh
tsograph schema --project <root> [--format json]
```

Scans the project for Prisma schemas, Prisma Client usage, Node ORM and SQL driver usage
([Node ORMs and SQL drivers](#node-orms-and-sql-drivers)), and SQL text, and writes a
bridge-facts v1 document to stdout: `platform: "js"`, `target: "persistence"` (or `null` when
there are no facts), one `relation-use` fact per observed relation or column reference. isthmus
joins it with a `platform: "sql"` document (schemagraph `facts --document <catalog>`) under the
persistence rules of `docs/GRAPH-EXCHANGE.md`.

- `--project` (required): the join root. `project` is its POSIX realpath and every
  `location.path` is relative to it. Symbolic links are never followed.
- Exit codes: `0` success (zero facts is still success, not proof of completeness),
  `2` unreadable project, more than 100,000 facts, or output over 16 Mi characters,
  `64` usage error. `1` is reserved.
- Skipped while walking: `node_modules`, `dist`, `build`, `out`, `coverage`, dot-directories,
  Prisma generator output directories, and files over 4 MiB (counted). `*.d.ts` files are not
  parsed as sources; they are read only for Cloudflare D1 binding declarations.

### Facts

| Source | `channel` | `method` | `location` | `symbol.qualifiedName` |
|---|---|---|---|---|
| Prisma `model`/`view` | resolved table name | — | model name | `Model` |
| Prisma scalar field | resolved table name | resolved column | field name | `Model.field` |
| Implicit many-to-many | `_<RelationName>` | — and `A`, `B` | first relation field | `Model.field` |
| `client.<delegate>` access | the model's table | — | delegate name | enclosing declaration |
| Delegate call arguments | the model's table | column | object key or string | enclosing declaration |
| Raw SQL (`$queryRaw`, `$executeRaw`, `Prisma.sql`, `…Unsafe`, TypedSQL, uppercase literals) | relation as written | — | the SQL literal (TypedSQL: the keyword) | enclosing declaration |
| Drizzle table / TypeORM entity / Sequelize model declaration | resolved table name | — and resolved columns | table name, class, or model name; column key | `table` / `table.key` (`Entity`, `Model.attribute`) |
| ORM and driver queries (builders, repositories, model methods, driver SQL) | resolved table name | column when read | table argument, method name, or SQL argument | enclosing declaration |

Channels are written as the code or mapping names them: `schema.table` when qualified
(`@@schema`, `FROM s.t`), otherwise unqualified — tsograph never guesses a default schema such as
`public`, because PostgreSQL resolves it from the connection. A name that itself contains `.`
(`@@map("a.b")`, `"a.b"` in SQL) is one segment escaped as `a%2Eb`; `%` is escaped as `%25`.

**Symbol format.** Source facts use `<project-relative POSIX path>#<Name>(.<Name>)*`, outermost
declaration first: function declarations, named classes and class expressions, methods,
accessors, class fields, `constructor`, `default` for anonymous default exports (including the
expression of `export default <expr>`), variables at
module level or whose function-valued initializer contains the fact (`src/lib/jobs.ts#listJobs`,
`src/repo.ts#Repo.save`, `src/api.ts#handlers.GET`). Inline callbacks (arrow functions and function
expressions passed directly as call or `new` arguments) add their own segment after the id of the
scope the callback expression sits in (`src/app.ts#<module>.app.get("/users")`,
`src/lib/jobs.ts#listJobs.items.map()`; see [inline callback ids](#inline-callback-ids)); other
anonymous functions (JSX attribute values, immediately invoked functions, conditional values) are
transparent. A computed name stops the symbol, and module-level statements have none; those facts are counted
under `missing-relation-usrs:` (the isthmus chain-only prefix; informational). Schema facts use the model name (`Job`, `Job.title`), and
TypedSQL facts use `<path>#<file name>`.

Source facts also carry `symbol.usr`, equal to `qualifiedName`: it is the tsograph graph id of
the enclosing declaration ([Symbol ids](#symbol-ids)), so `tsograph reach` output can be joined
with relation-use facts by exact string match.

Schema declaration facts and TypedSQL facts also carry a stable usr, in namespaces that are **not**
graph nodes: `<schema path>#model:<Model>` / `#model:<Model.field>` (for example
`prisma/schema.prisma#model:Job`, `prisma/schema.prisma#model:Job.title`, and
`#model:Book.tags` for an implicit many-to-many join table), and `<sql path>#typedsql:<name>`. Node ORM declarations use the same `#model:` namespace with the declaring
source file as the path (`src/db/schema.ts#model:users`, `src/entities/user.ts#model:User.email`,
`src/models/post.js#model:BlogPost.authorId`), so isthmus capture needs no new marker.
They are declaration-side facts, so no traversal ever reaches them; isthmus `trace` reads an id
that is absent from every traversal as unreached, not as a missing symbol.

### Prisma schema location (Prisma 7.8.0 CLI rules)

For the project root, every directory with a `prisma.config.*` file, and every package whose
`package.json` depends on `prisma` or `@prisma/client`:

1. The first config file among `prisma.config.{js,ts,mjs,cjs,mts,cts}`, `.config/prisma.*`, and
   `.config/prisma.config.*`. Its `schema` is read only when it is a string literal in the default
   export (`defineConfig({...})`, an object literal, or a same-file `const`); a directory means a
   multi-file schema and every `.prisma` file below it is read recursively.
2. Without `schema`: `<base>/schema.prisma`, then `<base>/prisma/schema.prisma` (one file).
3. `package.json` `"prisma": { "schema" }` is honored only when the installed Prisma is 6.x or
   older; Prisma 7 no longer reads it.

A non-literal config value (`path.join(...)`, environment variables) is not guessed:
`unresolved-prisma-config:`. A configured path that does not exist: `missing-prisma-schemas:`.

### Prisma naming rules

Verified against Prisma's source for the pinned versions (prisma-engines at the commit pinned by
`@prisma/internals@7.8.0`, `@prisma/client-generator-ts@7.8.0`, `@prisma/client-common@7.8.0`,
`@prisma/orm-family-sql@8.0.0-rc.1`–`rc.12`):

- **Table**: the `@@map` value, else the model name unchanged
  (`psl/parser-database/src/walkers/model.rs` `database_name()`). `@prisma/orm-family-sql`
  8.0.0-rc.1–rc.11 lowercases the first letter (`lowerFirst(model.name)`); rc.12 restores the
  model name (`defaultTableName`, release note "A PSL model without `@@map` names its table
  exactly as written").
- **Column**: the `@map` value, else the field name (`walkers/scalar_field.rs`; unchanged in 8.x).
- **Schema**: `@@schema("s")` qualifies the table (GA since 6.13; PostgreSQL, CockroachDB, SQL
  Server). Without it the name stays unqualified.
- **Implicit many-to-many**: table `_` + relation name; the default relation name is
  `<A>To<B>` with the two model names in code point order (uppercase sorts before lowercase), an
  explicit `@relation("Name")` gives `_Name`, columns are `A` and `B`, and the table lives in the
  schema of model `A`. Names longer than 63 characters are emitted as dynamic (identifier
  truncation is not guessed). Native Prisma 8 PSL has no implicit many-to-many.
- **Not emitted**: relation fields, `@ignore` fields, `@@ignore` models (absent from the client),
  composite `type` blocks, and every model when the datasource provider is `mongodb`
  (`non-relational-stores:`). `Unsupported("…")` fields are columns and are emitted.
- **Client delegate**: the model name with its first character lowercased (`uncapitalize`);
  the exact model name is accepted too, as the runtime also exposes it.

**Version selection.** Versions come from lockfiles (`pnpm-lock.yaml`, `package-lock.json`,
`npm-shrinkwrap.json`, `yarn.lock`, `bun.lock`), or from exact or `^`/`~` specifiers in
`package.json` when no lockfile names Prisma. `prisma`/`@prisma/client` 2.x–7.x select the Prisma
7 rule; `@prisma/orm-family-sql` selects the 8.x rules (the 8.x `prisma` package is a different
CLI and is ignored). When the version is unknown, unverified (for example rc.13+ or 8.0.0), or
several rules are installed, every candidate rule is evaluated: names that agree are emitted,
names that differ become dynamic facts without columns, and the document carries
`prisma-naming-unverified:`. Prisma 8 contract files and its client API are not scanned
(`prisma-8-surface-unscanned:`).

### Prisma Client usage

A receiver is a client only when its provenance is proven syntactically; no type checker runs
and nothing is executed:

- `new PrismaClient(...)` where `PrismaClient` comes from `@prisma/client` (also `/edge`,
  `/wasm`, …), `.prisma/client`, or a generator `output` directory (resolved relative to the
  schema file, matched through relative paths or tsconfig/jsconfig `paths`, even when the
  generated files are not committed);
- declarations annotated `PrismaClient`, `Prisma.TransactionClient`, local aliases of them,
  `Omit/Pick/Readonly/NonNullable/Required<…>`, intersections, `typeof client`, and interfaces
  extending them; functions whose declared return type (or `Promise<…>`) is one of them;
- `a ?? b` / `a || b` with a client side (`globalThis.prisma ?? new PrismaClient()`),
  `client.$extends(...)`, the first parameter of a `client.$transaction(async (tx) => …)`
  callback, class fields and constructor parameter properties (`this.db`);
- bindings imported across files: named, default, namespace, re-exports, `export *`,
  CommonJS `require`/`module.exports`, and `await import(...)`, resolved with the TypeScript
  module resolver and the nearest `tsconfig.json`/`jsconfig.json` (restricted to the project),
  iterated to a fixed point.

Local variables and parameters shadow outer clients. A call shaped like
`x.<delegate>.<operation>(...)` on an untraced receiver is not emitted and is counted under
`unresolved-client-receivers:`. An unknown or computed delegate on a proven client
(`prisma[name]`) is a dynamic fact.

Column facts come from the top-level keys of `select`, `omit`, `where`, `data`, `cursor`,
`create`, `update`, and `orderBy`, and the strings in `distinct` and `by`, of a delegate call's
object literal, only when the key is a scalar field of that model.

### SQL text

SQL is read with the family's shared lexical extractor (a line-by-line port of dartograph
`sql_relations.dart` / cartograph `SqlRelations.swift`, checked against the same vectors), so the
same SQL yields the same relations in every producer.

- `$queryRaw`/`$executeRaw` tagged templates and `Prisma.sql` fragments: interpolations are bind
  parameters, so each becomes a `?` placeholder. Nested `Prisma.sql`, `Prisma.raw('literal')`, and
  `Prisma.empty` are inlined. A placeholder in a relation position (`FROM ${table}`) is an
  unresolved operand and adds one dynamic fact.
- `$queryRawUnsafe`/`$executeRawUnsafe`: a string literal or a same-file `const` is read; a
  template with substitutions or any other expression is a dynamic fact (family rule).
- TypedSQL: when a generator enables the `typedSql` preview feature, the top-level `.sql` files in
  config `typedSql.path` or `<schema root>/sql` are read.
- Other string literals are read only when their SQL verb and relation keywords are uppercase
  (strict mode); lowercase SQL-looking literals are counted under `skipped-sql-literals:`.

### Node ORMs and SQL drivers

Naming rules, sources, and the naming oracle are documented in Korean in
[docs/PERSISTENCE.md](docs/PERSISTENCE.md). Summary:

- **Resolution.** A TypeScript Program over the project's own sources only (no lib, no
  `node_modules`, project-local module resolution) is used for symbol resolution; nothing is
  executed and no inferred types are used. Package values are identified by import specifier and
  name. A receiver counts only when its provenance is proven (initializers, return values, type
  annotations and their members, decorators, callback parameters, imports and CommonJS
  `require`/`module.exports`). The phase is skipped when no source imports a supported package or
  mentions `D1Database`.
- **Drizzle** (drizzle-orm 0.45.3): table names as written (`pgTable`, `sqliteTable`, `mysqlTable`,
  views, `pgSchema().table`, statically computable `pgTableCreator`); column = builder name, else
  the object key converted by the `casing` option (`snake_case`/`camelCase`) only when every
  `drizzle()` call and `drizzle.config.*` agree. Uses: `from`/`insert`/`update`/`delete`/joins/`$count`
  with a table argument, `t.column`, `.values()`/`.set()` keys, `db.query.<key>.findMany/findFirst`
  with `columns` and `with` (via `relations()`), and `sql` templates.
- **TypeORM** (1.1.1 and 0.3.31): `@Entity` name or `snakeCase(class)`, `entityPrefix`, schema;
  column `name` or the property; embedded prefixes; join columns `camelCase(property_referenced)`;
  join tables `snakeCase(owner_property_target)` with `camelCase(table_primaryColumn)` columns. A
  custom `namingStrategy` keeps only explicit names. Uses: repositories, ActiveRecord entities,
  EntityManager calls with an entity argument, QueryBuilder entities/aliases, `query(sql)`.
- **Sequelize 6** (6.37.8, inflection 1.13.4): `tableName`, else `modelName` frozen or
  `underscoredIf(pluralize(modelName))`; `field` or `underscoredIf(attribute)`; implicit `id` and
  timestamps; association foreign keys and string `through` join tables. Uses: model methods,
  `include`, `where`/`attributes`/value keys, `sequelize.query(sql)`.
- **knex** (3.3.0): `knex('t')`, `from`/`into`/`table`/joins (`'t as a'`, `{ a: 't' }`, `withSchema`),
  qualified or single-table columns, `knex.raw(sql)`; `knex.schema` DDL is ignored.
- **Raw drivers and D1**: `query`/`execute`/`prepare`/`exec`/`run`/`all`/`get`/`each` SQL on proven
  clients, libSQL `batch`, `postgres`/`neon`/`@vercel/postgres` tagged templates, and D1 bindings
  (`env.DB` for properties declared `D1Database`, including `.d.ts` files, `D1Database` annotations).
  A gated template string with substitutions emits the relations it names literally plus one
  dynamic fact.

Every rule is checked by `experiments/orm-naming-oracle`, which runs the real libraries against
synthetic fixtures (drizzle-kit DDL on sql.js, TypeORM `sqljs` synchronize, Sequelize on pg-mem,
knex `toSQL()`) and records the names; `src/schema/orm/oracle.test.ts` compares them offline
(100% agreement at recording time).

### Outside the supported surface

Kysely, Objection, MikroORM, pg-promise, sequelize-typescript models, the `sqlite` wrapper, MSSQL,
Oracle, and slonik queries are not interpreted. Files using them are counted under
`unsupported-db-packages:`, and Mongoose, MongoDB, DynamoDB, Firebase, and Redis under
`non-relational-stores:`. Uppercase SQL literals in those files are still read as SQL text.

### Limitation prefixes

`prisma-schema-not-found:`, `unresolved-prisma-config:`, `missing-prisma-schemas:`,
`schema-outside-project:`, `non-relational-stores:`, `prisma-naming-unverified:`,
`prisma-8-surface-unscanned:`, `unparsed-schema-lines:`, `unresolved-field-types:`,
`ignored-prisma-elements:`, `unresolved-generator-outputs:`, `unresolved-typed-sql:`,
`unsupported-db-packages:`, `dynamic-relation-names:`, `skipped-sql-literals:`,
`unresolved-client-receivers:`, `unresolved-orm-receivers:`, `orm-naming-unverified:`,
`unreadable-orm-declarations:`, `provenance-truncated:`, `missing-relation-usrs:`,
`invalid-relation-names:`, `unreadable-sources:`, `oversized-sources:`, `parse-errors:`,
`unreadable-module-configs:`, `skipped-symlinks:`, `scan-truncated:`. These are caller-side
limitations: isthmus does not change severities for them, and it counts unjoined dynamic facts
itself (`unjoined-dynamic-relations`).

### Joining with a catalog

schemagraph does not read DDL files directly, so a catalog for a Prisma migrations folder is
collected from a scratch database: apply `prisma/migrations/*/migration.sql` in order to a
throwaway PostgreSQL, then

```sh
schemagraph scan "postgres://…/scratch" --source-id prisma-migrations --emit-document catalog.json -o graph.json
schemagraph facts --document catalog.json --project <root> -o sql-facts.json
tsograph schema --project <root> > js-facts.json
isthmus check --pairs js-facts.json sql-facts.json
```

`fixtures/schema/prisma-app` is a synthetic project with its own migration; joined this way it
reports no errors (one expected `relation-decl-without-use-unverified` warning for its `@@ignore` model).

`fixtures/schema/drizzle-d1-app` (Hono, Drizzle, and raw D1 SQL) joins with a SQLite catalog built
from its migrations (`sqlite3 app.db < migrations/0000_init.sql` and `0001_audit.sql`, then
`schemagraph scan "sqlite:app.db" …`): no errors or warnings, 5 relations and 14 columns paired.
With named route handlers, `tsograph reach` and `schemagraph impact --format language-traversal`
let `isthmus trace` follow a route to its tables and their database dependents
([docs/PERSISTENCE.md](docs/PERSISTENCE.md#isthmus와-잇기)).

## `tsograph graph`, `tsograph reach`, `tsograph impact`

```sh
tsograph graph  --project <root> [--generated-at <timestamp>] [--format json]
tsograph reach  --project <root> [--max-depth <n>] [--max-reached <n>] [--dispatch direct|bound|candidates] [--generated-at <timestamp>] [--format json] <id>...
tsograph impact --project <root> [--max-depth <n>] [--max-reached <n>] [--dispatch direct|bound|candidates] [--generated-at <timestamp>] [--format json] <id>...
```

Builds the project's TypeScript/JavaScript call graph with the TypeScript compiler API (a
`Program` and `TypeChecker` over the root `tsconfig.json`, else `jsconfig.json`, else bundler-style
defaults; `allowJs` is always on). The analyzed code is never executed and no diagnostics are
computed.

- `graph` writes a `tsograph-graph` v1 snapshot (tsograph's own format, not an isthmus input):
  `nodes` (`id`, `kind`, `location`, optional `entries`, optional `unresolvedCalls`), `edges`
  (`from`, `to`, `kinds`, `evidence`), `statistics`, `limitations`, `graphRevision`, and `revision`
  when readable. The snapshot represents every edge tier (see [Interface dispatch](#interface-dispatch-bound-and-candidate-edges)):
  a pair of symbols has at most one edge per evidence tier, and a weaker edge is omitted when stronger
  edges between the same pair already carry all of its kinds, because it cannot change any traversal
  in any mode. Node `unresolvedCalls` holds exact counts (not capped).
- `reach` writes the symbols reachable from the root ids (`direction: "dependencies"`), and
  `impact` the symbols that reach them (`direction: "dependents"`), as isthmus
  [`language-traversal` v1](https://github.com/ictechgy/isthmus/blob/main/docs/LANGUAGE-TRAVERSAL.md).
- Ids are [symbol ids](#symbol-ids): the same strings as `symbol.usr` in `tsograph routes` and
  `tsograph schema` output. Duplicate ids are kept once, in first-seen order (that order defines
  `reached[].roots` indices).
- **Roots that are not graph nodes** follow the contract's `root-not-found` rule, like cartograph and
  kartograph: the document is still written for the other roots; each such id stays in `roots` in
  its requested position, with its text as `id` and **no `symbol`** (isthmus `trace` links only roots
  with a symbol), and the document gets `truncated: true`, `root-not-found` in `truncationReasons`, and
  one `root-not-found:` limitation. Then the command **exits `64` after printing**, listing the ids on
  stderr, so a typo still stops a pipeline that checks the exit code; a caller that accepts partial
  traversals (for example isthmus capture with `acceptExitCodes: [0, 64]`) reads the document, and a
  plain usage error is told apart by its empty stdout. When no root is a graph node the document has
  an empty `reached`. The limitation and stderr tell the two kinds apart: `#model:`/`#typedsql:`
  [declaration ids](#facts) are known non-nodes that no traversal reaches (leave them out of
  traversal roots), anything else is an unknown id. There is no strict flag, matching the siblings.
- Exit codes: `0` success, `2` unreadable project or output over 16 Mi characters (no document), `64`
  usage error (empty stdout) or root-not-found (document written).

### Nodes and edges

Nodes are only the project's own source files (the same walk as `tsograph schema`, minus Prisma
generator output, plus every route file). Declarations in `node_modules`, TypeScript lib files, and
generated clients are never nodes; calls into them are counted as external.

| Node kind | What |
|---|---|
| `module` | `<path>#<module>`: top-level statements and code outside any named declaration |
| `function`, `method`, `constructor`, `accessor`, `class`, `field`, `variable` | declarations named by the symbol id rules (function-valued variables, object properties, and [inline callbacks](#inline-callback-ids) are `function`) |
| `export` | an export that is not itself a declaration (alias, re-export, destructuring) |

| Edge kind | Meaning |
|---|---|
| `call` | direct call (also tagged templates, decorators, `super(...)`) |
| `new` | `new C()` → the constructor with a body, else the class node |
| `callback` | a function value passed as an argument (`items.map(format)`, `withAuth(handler)`) |
| `reference` | any other function value reference (`export default handler`, `{ onClick: h }`, `action={fn}`) |
| `jsx` | a JSX component (`<JobList />`) |
| `alias` | export node → the declaration it resolves to |
| `initializer` | constructor/class → instance field initializers, derived class without a constructor → base construction, module scope → top-level variable initializers and static fields |
| `contains` | the node that lexically holds an inline callback → the callback node (`<path>#<module>` → `<path>#<module>.app.get("/users")`). The caller of a callback (`app.get`, `items.map`) is usually external, so this edge keeps reach from the holder and impact from code inside the callback connected. It does not prove the callback runs; before inline callbacks had nodes their code was attributed to the holder, so reach sets are unchanged |

Calls are resolved through checker symbols across modules: named/default/namespace imports,
re-exports (including `export *`), path aliases, value aliases (`const h = g`), destructuring
(`const { GET } = handlers`, `const { f } = await import('./m')`), and object-literal members.
Nothing is guessed:

- A method called through an interface or type-literal signature is linked `direct` only when the
  receiver is a `const` variable or `readonly` field initialized with `new C()` or an object literal
  (the implementation is then proven). A union receiver links every member that has a body; unproven
  parts are counted under `partial-dispatch:`. The remaining interface calls go to
  [interface dispatch](#interface-dispatch-bound-and-candidate-edges), which adds `bound` or
  `candidate` edges instead of guessing.
- A call to a method that subclasses override is linked to the statically resolved declaration
  only and counted under `overridden-methods:`.
- Calls through parameters, `any`, computed callees, non-function values, and unresolvable
  project imports get no edge and are counted by reason under `unresolved-calls:`.
- Calls through a closed callback parameter, a local callback returned by a project function, or a
  safely readable named method can be proven with callable value flow and linked with `bound`
  evidence. An anonymous arrow or function-expression callback passed directly to a closed,
  single-body project function declaration can also receive values from that function's direct
  callback invocations, including an invocation inside a returned closure. The factory's callback
  parameter must be a simple identifier with no default/rest, writes, or escaping references;
  argument spreads that obscure positions keep the flow unresolved. Callable flow is all-or-nothing:
  mixed object/function or unknown values keep the original gap and do not expand to type candidates.
- Calls through packages whose type declarations cannot be resolved (dependencies not installed,
  untyped packages) are external and counted under `missing-dependencies:`.
- Module scopes are not linked from importers (import-time side effects stay on the `<module>` node).

### Interface dispatch (bound and candidate edges)

Every edge carries an `evidence` tier. The tiers nest: the `direct` graph ⊂ the `bound` graph ⊂ the
`candidate` graph.

| `evidence` | Meaning |
|---|---|
| `direct` | The target is proven by checker symbols (or by the receiver's fixed initializer, above). |
| `bound` | A call through an interface-typed or structurally typed receiver (`this.deps.store.findItem()`, `repository.save()`), or a closed callable value (`invoke(callback)`, `make()()`), where **every observed receiver/callable value** within the scanned project resolves to a project implementation or callable declaration with a body. One `bound` edge per distinct target, unless a stronger edge between the same pair already covers it (see the snapshot rule). |
| `candidate` | The flows could not all be proven, so the call is linked to every project class or object that could implement it: classes that declare `implements` for the receiver's interface (directly, through a base class, or through an extending interface), and classes and object literals whose type is assignable to the receiver type (`TypeChecker.isTypeAssignableTo`, public in the pinned TypeScript 5.9.3; a type-parameter receiver uses its constraint). An over-approximation. |

How `bound` values are found (whole program, context- and path-insensitive): `new C(...)`, object
literals, `this` (the enclosing class and its project subclasses), variable initializers plus every
assignment, parameters (default value plus the same-position argument at every call site of a
function declaration, a `const`-bound function, or a constructor, including `super(...)` and the
implicit `super` of subclasses without a constructor), object destructuring, properties of object
literals and class instances (initializer, parameter property, getter return, plus every same-named
property write anywhere; a write is skipped only when the flow of its receiver expression is known,
non-empty, and holds neither the value nor, for a class, an instance of one of its project
subclasses — types alone never exclude a write, because structural assignability, array covariance,
and method-parameter bivariance let an instance reach any typed slot without a cast), return values of called functions
(interface-typed factories are resolved through their receiver's values), `await`, `?:`, `??`, `||`,
`&&`, and the comma operator. A slot that feeds itself through a call or property
(`this.store = this.store.withCache()`, a recursive wrapper) is iterated to its fixpoint. Composition roots such as
`new ItemHandler({ store: new SqlItemStore(client) })`, `createLookup({ store })`, `new ItemService(sql)`,
default-parameter DI (`store: ItemStore = new MemoryItemStore()`), and module singletons created by a
factory are followed across modules.

There is one narrow identity proof for returned dependency containers: an object literal returned by one
named, stable, closed, synchronous, non-generator project `FunctionDeclaration` may be separated from an
unknown reflective target when it contains only plain static own-data properties (no spread, computed key,
method/accessor, `__proto__`, or `then`). Every factory use must either destructure the call result directly
with a simple one-level object binding or pass the factory as an exact argument to a direct identifier call
whose stable wrapper parameter performs only that same projection. Prefix spreads, optional/default/rest or
written parameters, forwarding, whole-object aliases/returns/passes, lexical `arguments`, open properties,
opaque imports, and async/generator factories keep the literal unknown. A known reflective target always
blocks, and this exception does not use structural type disjointness. The proof accepts named imports but
intentionally defers namespace/member and parenthesized-function factory calls.

The proof also covers a private cache literal in the same external-module source file: one top-level `let`
slot with an absent, `null`, or unshadowed global `undefined` initializer may receive the literal exactly once
through a discarded direct `memo =` or `memo ??=` expression statement. Stable closed named functions may
return that slot, while every other slot read must be a narrow condition guard (`memo`, `!memo`, or an equality
against `null`/global `undefined`). Discarded `memo = null`/global `undefined` resets are allowed; exports,
whole-object uses, member reads, setters, compound/logical writes, and additional object writes keep the value
unknown.

Visible mutations retain their operation, receiver, key, value/source/descriptor, and prototype
arguments in an internal index. `Object.setPrototypeOf`, `Reflect.setPrototypeOf`, and `__proto__`
writes invalidate affected receiver proofs. Mutator value escapes, incomplete aliases, and legacy
`__defineGetter__`/`__defineSetter__` uses retain opaque mutation state. A declaration file or an
unrelated key name is never proof of a harmless effect.

A narrow constructor carrier proof can separate an exact dependency object literal from unknown
reflection. It requires a closed, unexported project class, a private readonly parameter property,
complete instance-use and projection audits, and a mutation view whose effects are proved local.
Optional Date callbacks must be present as own data properties: genuine `undefined` or `null`
selects the fallback, while an exact audited Date arrow may be supplied directly. An omitted key remains unproved because inherited
properties such as `toString` or `constructor` can prevent that fallback from running; casts and
optional types do not establish absence. Carrier methods initially have no runtime parameters,
and admitted instance calls must supply no arguments. Audited wrappers retain only their fully
checked required identifier transfers; default or implicit `arguments` escapes remain unproved.
Default/rest/destructured parameters, decorators, async/generator execution, and unproved implicit
or coercing evaluation retain uncertainty. Parameter-property stores, instance fields, and method
slots are audited for collisions and setter interception independently of class-field emit options;
TypeScript `private` and `readonly` are not runtime ownership evidence. Whole-instance or bag escapes,
aliases, accessors, inheritance, unsafe callbacks, and unproved mutation receivers keep the call
unresolved. Previously admitted omitted-key or unaudited entry cases may therefore become candidate
or unresolved. Simple private primitive object/array literals may qualify as unrelated mutation
receivers only for existing own-data slots and fully audited uses; array types, spread arrays,
arbitrary factories, and `map().sort().map()` do not establish that proof.

An extended carrier proof admits a single direct, unconditional top-level `const` construction with
an exact literal dependency bag. It audits every runtime use of the class and instance, including
closed static import/export aliases under the existing project policy. Second constructions,
constructor-value aliases, factories, subclasses, escapes, runtime namespace/enum merging, CJS,
and unresolved references do not gain extended isolation. Repeated ordinary constructions retain
their existing possible targets.

A dependency must be allocated earlier in the same module. Imported dependency initialization,
initialization-time calls before the required binding, and relevant runtime import cycles remain
unproved. Dependency constructors must be absent or empty with no parameters; initialized fields
must be primitive literals or certified primitive helper results. Every method, including unused
methods, must be synchronous, with an empty body or an audited primitive result. Required
identifier parameters need complete provenance at every actual call. Public methods use the same runtime checks. For example:

```ts
class Port { send() { return 1; } }
class Controller {
  tick: () => Date;
  constructor(private readonly inputs: { port: Port; tick?: () => Date }) {
    this.tick = inputs.tick ?? (() => new Date());
  }
  run() { this.tick(); return this.inputs.port.send(); }
}
const live = new Port();
const controller = new Controller({ port: live, tick: undefined });
controller.run();
```

Within that grammar, `Controller.run → Port.send` gains `bound` evidence. Class evaluation,
construction, parameter-property storage, projections, delayed Date creation and calls each require
an audited effect model. An enumerated effect without a matching model blocks the new proof;
completed inventory alone is not a purity claim. Existing canonical private own-slot writes retain
their separate checks. General effectful dependency methods, unsupported helpers, callbacks and
factories remain outside this proof. Proof construction and cached replay share the existing
20,000-step, depth-256 and 400-frame limits, including member and endpoint scans.

Named synchronous function declarations can supply receiver-free primitive results through required
identifier parameters, primitive literals, preceding immutable primitive locals, and calls to other
certified helpers. Each initializer and captured binding needs both primitive provenance and inert
evaluation. Captures must be initialized before every actual use, including field construction and
static import/reexport calls; the function declaration's position alone is insufficient. Closed default
imports and public dependency methods follow the same checks. Helper writes, escapes, alias or
runtime cycles, arithmetic, coercion, uncertified property access, closures, `this`, `arguments`, scheduling,
default/rest/destructured parameters, and unknown or protected arguments remain unproved. Completed
helper summaries discharge their exact effect sites through the proof DAG; syntactic candidate hints
alone grant no authority. Escaping containers and arbitrary container factories remain unproved.

Carrier and dependency methods can receive required identifier parameters when every actual call
has the exact arity and proven primitive arguments. Argument evaluation is audited left to right,
and the completed helper/dependency summary is instantiated at that call. Interface and type-literal
annotations provide no receiver authority: the proof must identify the actual singleton allocation,
exact bag and stable endpoint. Captures are checked at each actual method entry. Supported exported zero-parameter arrows use
an explicit ESM module-ready entry plus every local/imported invocation; the existing synchronous
inline wrapper uses its outer call as the entry. Binding readiness is checked even when the body
has no captures. Early initialization, cycles, reentrant calls and scheduled or escaping callbacks
remain unproved. Unknown or
protected objects, containing wrappers, callbacks, spread arguments, missing or extra arguments,
parameter writes and unproved entries block the new proof. Dependency constructors still require
their existing absent-or-empty, zero-parameter grammar.

Direct primitive object and array literals can be used as confined scratch values in certified
helpers, carrier methods and dependency methods. Immutable aliases may read or assign an existing
canonical own-data slot and return its certified primitive value. Initializers and assigned values
need both proven provenance and inert evaluation; every alias, runtime reference and actual entry
is audited. Arrays cannot contain holes or spreads, change length, create new indices, or use
mutator methods. Objects need unique static own-data keys; accessors, dynamic or duplicate keys,
prototype-sensitive operations and container escape remain unproved. Types and `as const` do not
provide a runtime ownership or descriptor witness.

The same completed confinement certificate must validate the write receiver, array aliases and
references, and each final mutation record. A site whitelist or a certificate for another root
cannot grant this authority. Only the analyzer's registered primitive-effects producer can issue
it; generic DAG completion and publicly mutable witness objects supply no authority. The producer
keeps private snapshots of the relevant proof, slots, writes, aliases and references before exposing
cached values. Opaque effects, known reflection, intrinsic changes, unstable borrowed
endpoints and unmatched effects still block extended isolation. General factories, callbacks,
reentrancy, scheduling, asynchronous services and ordinary effectful methods remain outside this
grammar.

Ordinary declared-method identity is checked separately from carrier field/bag isolation. A direct
same-class method call with inert entry and arguments can retain its target when it is returned or
stored in an immutable local, including `const result = await this.method(value); return result`:
the method lookup occurs before suspension. Receiver construction must also pass its own entry
and storage audit, with no replacement return or instance escape. Result processing after the call
does not certify subsequent protected uses. Unknown callbacks, dependency calls, or an earlier
suspension before a lookup remain unproved; a Date-typed field alone is not an effect certificate.
Carrier subclasses require a concrete subclass-constructor witness and remain conservative in this
release. General containing wrappers and factories do not gain isolation; only an exact private
single-property holder consumed through audited direct calls retains the ordinary receiver path.
Receiver proofs still require exact constructor bag literals and audited class-value uses; a bag
variable or an additional `instanceof` use remains unproved. Completed carrier proofs preserve
their admitted memo projections and wrapper-callback method targets. Declared-method recovery
also audits protected `this` uses across the entire class, including the current method after its
lookup: a later escape can change the target on a subsequent invocation. Post-call processing that
does not receive protected `this` remains supported.

A private top-level `const registry = new Map()` can supply project factory values through `get`
when the constructor and supported API declarations come from the actual TypeScript default
libraries and the mutation view is clean. Only direct `get/set/has/delete/clear/keys` calls and
readonly `size` reads are admitted; `set` results must be discarded. Aliases, exports, argument
passes, reflection, computed/detached/optional calls, chaining, `forEach`, `values`, and `entries`
keep it opaque. Unknown keys include all observed registrations; exact primitive literals, immutable
const aliases, and conditional unions can narrow key matches. Primitive kinds remain distinct for
Map, and `-0` matches `0`. Symbol/object/enum/call-derived keys are not guessed. Delete and clear do
not remove possible values from this context-insensitive analysis, and iterator results remain opaque.

Callable values use the same flow engine: function declarations and function-valued initializers plus
their observed assignments, closed callback parameters, direct invocations of anonymous inline
callbacks, function and getter return values, constructor assignments/defaults, and safely readable
object/class methods are followed. Inline callback binding is limited to a direct call argument and
a closed project function declaration with exactly one body; named function expressions, callback
parameter writes or escapes, spreads, open or external factories, and unknown invocation arguments
stay unresolved. Function-object properties, decorated or unprovably monkey-patched methods,
reflective writes, open exports/entry points, and unknown values stay unresolved. A callable failure
keeps its original `parameter`, `indirect`, or `computed` reason and never emits candidate edges.
Within that boundary, a closed wrapper may call a callable parameter such as `make()` when its full
flow resolves to project function bodies; mixed known/unknown, reassigned-to-unknown, open, and
external maker values remain unresolved.

One SDK-specific model follows callback delegation through `unstable_cache` from the installed
Next.js **16.2.7** package. The import must resolve to SDK declarations outside project sources:
a named import (including an import alias) or a direct namespace member, used by a direct factory call
or an immutable `const` wrapper alias chain of at most 16 links. An inline function, stable project function declaration/import, or immutable identifier alias
whose callable flow is fully resolved receives a `bound` edge from the wrapper invocation. Cache hits can skip that callback; the edge
records a possible execution path. Cached return values remain opaque because cache reads deserialize
JSON, and wrapper arguments do not populate callback parameter flow. Other SDK versions, project
shadows or augmentations, mutable/property aliases, injected callback parameters, optional/spread
calls, open programs, opaque imports, namespace value escapes, and observed SDK writes keep the call unresolved. This model
does not execute the SDK or make network requests.

What `bound` guarantees, and what it does not:

- **Guarantees**, under the assumptions below: no implementation that can run at the call site is
  missing, and every linked implementation is observed flowing into the receiver somewhere in the
  project.
- **Does not guarantee** that each linked implementation runs on every path or from every caller: the
  flow is context-insensitive, so a shared handler assembled at two composition roots with two stores is
  bound to both stores (`fixtures/graph/di-dispatch`: `ItemHandler.get` → `SqlItemStore.findItem` and
  `MemoryItemStore.findItem`). Dead composition roots count.
- **Assumption: the scanned project is the whole program.** Where code outside the scan can inject
  values, the flow is treated as unknown and no `bound` edge is emitted: parameters of entry points
  (and of the functions an entry export aliases or references), exports of entry files, exports of
  modules loaded with a dynamic `import()`/`require()` or used as a namespace value, parameters of
  methods, object-literal members, and callbacks (their callers cannot be enumerated), functions and
  classes referenced other than as a callee (passed as a value, `.call`/`.bind`, JSX, tagged templates),
  classes with decorators (DI containers construct them) and decorated methods, fields, and accessors,
  classes that call `new this()`, `this` in a class used as a value other than `new`/`extends`/static
  access (mixins can subclass it), `this` in a method whose name is read other than as a call callee anywhere (`h.run.bind(x)`,
  `const { run } = h`, `({ run } = h)`) unless the read's receiver flow provably excludes the class and
  its subclasses (same rule as writes), exports reachable from a
  loaded module through re-export barrels (`export *`, `export { x } from`, `export * as ns`), and
  `declare`d values. A package whose `package.json` declares `main`, `module`, `exports`, `bin`,
  `types`, `typings`, or `browser` (or whose `package.json` cannot be read as a JSON object within
  1 MiB), or an incomplete scan (skipped, oversized, unreadable, or
  symlinked files, or parse errors), additionally opens every exported function and class and every
  non-private property; the document then says so under `bound-dispatch:`. An exported function whose
  callers are all in the project is closed; one with no project caller has no observed flow and is not
  bound. Fail-closed: a function or constructor with no indexed call site is unknown (a default
  parameter value alone is never taken as the whole flow) unless a strict syntactic re-scan proves it
  has no reference at all: across the analyzed files, the only identifier, `#name`, or string-literal
  token whose text equals its name or an alias's local name is its own declaration name. Any other
  occurrence — a destructuring property name, a property-access name, `export default`, a type
  position, or an unrelated symbol with the same name — fails the proof. The reference index resolves
  every value identifier, every property-access name (including file-local `namespace App` members such as
  `new App.Repo(…)` and `globalThis.f`), and every string-literal element access (`App["load"](…)`); a
  module or value namespace reached by an identifier, a property chain (`App.Repo`, `helpers.sub`), or a
  literal element access and then used as a value (an argument, a destructuring initializer such as
  `const { run } = App.Repo`, a spread) or read with a computed key (`App.Repo[key]`) opens all its
  members. Exports of framework files — App Router `route` and special files, everything under
  `pages/`, `proxy`/`middleware`/`instrumentation`, even when they only `export * from` — and every
  declaration they re-export are open, as are top-level declarations of files that are not ES
  modules (scripts and CommonJS files). A variable declared more than once (`var x = a; var x = b;`)
  unions every initializer.
- **Not modeled** (documented gaps): unindexed prototype APIs, `eval`, values that leave the
  project through library code and come back, and properties that library code mutates. When
  dependencies are not installed, values that pass through their APIs are unknown, so same-named
  writes and method reads on such values elsewhere in the project can block `bound` for unrelated
  classes (fewer `bound` edges, never wrong ones). Dynamic `import()`/`require()` with a non-string specifier and file-pattern
  loaders (`import.meta.glob`, `require.context`) open every export. `Object.assign`,
  `Object.defineProperty(ies)`, `Reflect.set`, `Reflect.defineProperty`, and `Reflect.deleteProperty`
  targets are handled
  conservatively (their properties and members become unknown, including for statically resolved member
  calls). The narrow returned-literal and constructor-carrier identity proofs above are the exceptions, and applies only to an unknown
  target; a known reflective target still blocks the literal. A write or delete through a computed key
  (`obj[key] = v`, `delete obj[key]`) likewise makes that receiver's properties unknown. An unknown reflective
  target keeps its static type: it is excluded
  only from a closed, non-escaped nominal class family when neither the class nor any project subclass can
  overlap that type. Structurally unrelated types can still overlap through an intersection and therefore
  remain unknown; `any`, `unknown`, and generic/instantiable target types never use this exclusion. A same-named property write that replaces a
  method (monkey patching) blocks `bound` for that method.
- **Test sources are separate programs.** For call sites outside test sources (`*.test.*`,
  `*.spec.*`, `__tests__/`, `__mocks__/` — the `routes` rule), flows and candidates come from the
  program without test sources, so mocks injected by unit tests do not block production edges. Call
  sites inside test sources use the whole project. If a non-test file imports a test source, the whole
  project is used everywhere.
- An independent effect inventory reconciles the expected whole or production sources with their
  file indexes, source revisions, runtime module edges, and executable operations. Enumeration,
  runtime reference/alias closure, initialization coverage, and ambient safety are separate checks;
  complete enumeration can still contain unknown effects. Incomplete coverage prevents new effect
  certificates while existing dispatch capabilities retain their own checks. Inventory construction
  is bounded by 1,000,000 visited nodes, 1,000,000 retained records, and 100,000 additional nodes per
  file. Repeated collection passes share these limits; counts include the work of each pass and
  retained reference, alias, and token witnesses. Initialization coverage describes module-load
  coverage for static edges and recognized loader origins; initialization order requires a separate
  proof. General reflection and arbitrary factories retain unknown call/property effects, so this
  verdict does not certify their runtime module loads or ambient safety. Runtime CJS import-equals loader
  evaluation remains unknown. Dynamic access to genuine platform loaders and exposure of their
  platform roots retain opaque module-load evidence. Malformed supplied index parts cannot certify
  coverage. A build cap produces `effect-inventory: incomplete(build-cap)`; it does not consume a flow
  query's budget or certify a partial inventory as safe. Other missing or mismatched coverage is
  reported as `effect-inventory: incomplete(coverage)`. These effect-inventory limitations report whole-view
  enumeration coverage. Future effect certificates must check the selected view's reference closure and module-load
  coverage directly; a complete enumeration does not certify either verdict or initialization order.
- Carrier proof outcomes distinguish successful proof, semantic rejection, incomplete coverage,
  cycles, and resource exhaustion. Certificates bind the Program/checker, selected source view,
  manifest, policy, proof version, allocation identity, and dependency authority. Proof modes and
  capabilities are checked before dependencies execute; an extended failure does not retry a legacy
  proof. Completed AST proofs replay the same charged work in canonical dependency order, including
  rejected dependencies, and recheck entry validity and shared-edge depth/frame limits. Legacy
  dispatch and identity results do not grant new ambient, primitive-effect, or confinement authority.
  Policy predicates are sampled after their charged step and depth/frame check, at the same position
  in cold construction and warm replay. Each query keeps the first sampled value for a predicate
  and target; a new query reads the current policy again. A failed guard is incomplete and cannot
  become a completed visit or authorize a certificate on a retry in the same query.
- Each flow query has a fixed budget (20,000 steps, 256 nested slots, 400 nested expressions); a query over
  budget is unknown, and the count appears under
  `dispatch-budget:`. Property writes, member reads, and receiver flows looked up by name are memoized
  across queries, so common member names do not exhaust the budget (a synthetic 1,500-module fixture
  with 1,500 same-named writes and detached reads went from 21.7 s to 2.5 s). Unexpected internal
  `RangeError` exceptions propagate as failures; they do not become a cached rejection or an unknown
  flow result.

`unresolvedCalls` counts, per node and per mode, the node's own call sites (calls, `new`, tagged
templates, decorators, JSX) that have no edge or only a partial set of targets under that mode:
`direct` counts every such site, `bound` drops deferred calls linked by `bound` edges, and
`candidates` also drops deferred calls linked by `candidate` edges. Calls into dependencies are
external, not unresolved. Callback invocations through parameters are counted even though the
caller's `callback` edge covers the reach.

### Entry points

| `entries` | Source |
|---|---|
| `route-handler` | `symbol.usr` of the project's `tsograph routes` route-decl facts (test sources excluded) |
| `scheduled` | a GET/ANY route handler whose template matches a `vercel.json` `crons[].path` (Vercel invokes crons with GET) |
| `server-action` | exports of a `'use server'` module, functions whose body starts with `'use server'` |
| `page` | default export and `generateMetadata`/`generateStaticParams`/… of App Router special files (`page`, `layout`, `template`, `default`, `error`, `not-found`, `loading`, …) and Pages Router pages (default, `getServerSideProps`, `getStaticProps`, …) |
| `metadata-route` | default export of `sitemap`, `robots`, `manifest`, icon and Open Graph image files |
| `middleware` | `proxy`/`middleware`/default export of `proxy.<ext>`/`middleware.<ext>` |
| `instrumentation` | `register`/`onRequestError` of `instrumentation.<ext>` |

Only `route-handler` entries are reachable through the isthmus http join. `reach`/`impact`
documents count the other entry kinds among their roots and reached symbols under
`non-http-entries:`, so isthmus `trace` can report them as `non-http-entry` gaps instead of
missing routes.

`reach` and `impact --entry-points` additionally emit observed `symbol.entries` on roots and reached
symbols, with locations for marked roots. isthmus-cli 0.12.0+ can report non-HTTP entry points
alongside API impact for relation, symbol, and file selections. Page marks include layouts and special
files and do not prove that a component is an RSC. The option is off by default to preserve output
compatibility; released isthmus-cli 0.11.0 rejects `symbol.entries`, so upgrade the consumer first.

### language-traversal output

- `dispatch`: the mode used (`--dispatch`, default `bound`). `direct` follows `direct` edges only (the
  behavior before dispatch), `bound` follows `direct` and `bound`, `candidates` follows all edges.
  Emitting `dispatch` declares, per the contract, that every reached symbol carries `evidence` and that
  every root and reached symbol with at least one unresolved call carries `unresolvedCalls`.
- `roots[]`: `{ id, symbol: { usr, qualifiedName }, unresolvedCalls? }` in input order.
- `reached[]`: `{ symbol: { usr, qualifiedName, kind, location }, via, depth, roots, relationships,
  evidence, unresolvedCalls? }`, sorted by (`depth`, `usr`). `depth` is the shortest distance to any root, `via` the previous
  symbol on a shortest path from the nearest root (ties: the smallest root index, then the smallest
  predecessor id; a root id at depth 1), `roots` every root index that reaches the symbol,
  `relationships` the edge kinds between `via` and the symbol (merged across evidence tiers allowed
  by the mode). `depth`, `via`, `roots`, and `relationships` are measured over the full graph the mode
  allows.
- `evidence` is a **per-root lower bound**: for each root that reaches the symbol within `--max-depth`
  (every such root, including roots elided by the 64-index cap, never the symbol itself), take the
  strongest tier whose graph alone reaches the symbol from that root within `--max-depth`; `evidence`
  is the weakest of those. `"direct"` therefore means every root reaching the symbol does so through
  `direct` edges only. The shortest path of a tier can differ from the `via` chain. Roots that cannot
  reach the source of any non-`direct` edge within the depth budget reach every symbol identically in
  all tiers; the others are compared exactly with one bit per root.
- `unresolvedCalls` (1–1,000,000, omitted when 0) is the node's per-mode count described
  [above](#interface-dispatch-bound-and-candidate-edges). A root that is also reached carries the same
  value in `roots[]` and `reached[]`. Counts above 1,000,000 are reported as 1,000,000 and the document
  adds `unresolved-calls-capped:`; the graph snapshot keeps the exact count.
- Exact evidence needs one bit per compared root per symbol per tier. When that would exceed 64 MiB,
  `evidence` falls back to the weakest tier of any non-`direct` edge whose tail is reached from a root
  and which lies upstream of the symbol (`direct` when there is none). This may understate but never
  overstates the per-root lower bound, and the document adds `evidence-approximated:`.
- A root that is reached from **another** root is listed in `reached` too (a handler A calling a
  helper H that is also a root lists H with `roots: [indexA]`). Its `roots` never contains its own
  index, and its `depth`/`via` are measured from those other roots (`via` may be another root id).
  A root reached only from itself (through a cycle) is not listed. Paths may pass through another
  root, and symbols beyond it carry both root indices.
- Budgets: `--max-depth` 1–128 (default 128), `--max-reached` up to 100,000 (default 100,000). When a
  budget cuts the traversal, `truncated: true` with `truncationReasons` (`depth`, `max-reached`).
  More than 64 root indices on one symbol keep the smallest 64 and set `rootsTruncated: true`.
- The traversal is one multi-source, level-synchronous pass (all roots at once, not one search per
  root). A root stops spreading through a symbol that already holds 65 smaller root indices, because
  it can no longer change any listed `roots`, `depth`, or `via`; this bounds the work per symbol even
  with 10,000 roots. A randomized test checks the pass against the per-root algorithm. When root
  indices overflow (`rootsTruncated: true`), the `depth` reason is reported when a symbol is missing
  because of the depth limit, not when only one root's provenance was cut; in a document also cut by
  `max-reached`, overflow on dropped symbols still sets `rootsTruncated`.
- `graphRevision` is `sha256:` over node ids, kinds, entries, per-mode unresolved-call counts, and edges
  with their evidence (locations excluded), so `graph`, `reach`, and `impact` over the same graph agree
  whatever the `--dispatch` mode. `revision` is the project root's git
  `HEAD` commit read from `.git` (working-tree changes are not reflected).
- `limitations` carries the graph's limitations for the mode plus the document-scoped
  `non-http-entries:`. The `unresolved-calls:` and `partial-dispatch:` counts exclude the interface
  calls the mode links, and `bound-dispatch:`/`candidate-dispatch:` report how many calls the mode's
  dispatch edges link. The snapshot counts `unresolved-calls:` in the `direct` sense and lists both
  dispatch lines.
- `--generated-at` fixes `generatedAt` for byte-identical output.

Example (synthetic `fixtures/graph/next-prisma`, trimmed):

```sh
tsograph reach --project fixtures/graph/next-prisma --generated-at 2026-09-27T00:00:00.000Z 'src/app/api/jobs/route.ts#POST'
```

```json
{
  "direction": "dependencies",
  "format": "language-traversal",
  "generatedAt": "2026-09-27T00:00:00.000Z",
  "dispatch": "bound",
  "graphRevision": "sha256:8af7fab5…",
  "limitations": ["unresolved-calls: 6 call(s) could not be linked to a project declaration and were not guessed (parameter: 1, interface: 1, untyped: 1, computed: 1, indirect: 1, unresolved-import: 1)", "…"],
  "platform": "js",
  "project": "/work/example",
  "reached": [
    { "depth": 1, "evidence": "direct", "relationships": ["call"], "roots": [0],
      "symbol": { "kind": "function", "location": { "column": 17, "line": 3, "path": "src/lib/hof.ts" },
                  "qualifiedName": "src/lib/hof.ts#withAuth", "usr": "src/lib/hof.ts#withAuth" },
      "unresolvedCalls": 1, "via": "src/app/api/jobs/route.ts#POST" },
    { "depth": 1, "evidence": "direct", "relationships": ["call"], "roots": [0],
      "symbol": { "kind": "function", "location": { "column": 23, "line": 8, "path": "src/lib/jobs.ts" },
                  "qualifiedName": "src/lib/jobs.ts#createJob", "usr": "src/lib/jobs.ts#createJob" },
      "via": "src/app/api/jobs/route.ts#POST" },
    { "depth": 2, "evidence": "direct", "relationships": ["call"], "roots": [0],
      "symbol": { "kind": "function", "location": { "column": 23, "line": 3, "path": "src/lib/audit.ts" },
                  "qualifiedName": "src/lib/audit.ts#audit", "usr": "src/lib/audit.ts#audit" },
      "via": "src/lib/jobs.ts#createJob" }
  ],
  "roots": [{ "id": "src/app/api/jobs/route.ts#POST",
              "symbol": { "qualifiedName": "src/app/api/jobs/route.ts#POST", "usr": "src/app/api/jobs/route.ts#POST" } }],
  "tool": { "name": "tsograph", "version": "0.1.0" },
  "truncated": false,
  "version": 1
}
```

Joined with the relation-use facts of `tsograph schema` (`symbol.usr` ∈ reach set ∪ {handler}),
`POST /api/jobs` touches `jobs` and `AuditLog`. The same documents pass the isthmus
`language-traversal` parser and `isthmus trace` (route selection with a `forward` analysis, symbol
selection with a `reverse` analysis) on the `feature/trace-language-traversal` consumer; documents
with `dispatch`, `evidence`, and `unresolvedCalls` pass the parser on the `feature/trace-evidence-tiers`
consumer. Both consumers shipped in isthmus-cli 0.10.0.

Dispatch example (synthetic `fixtures/graph/di-dispatch`, trimmed): `GET /api/items` calls
`primaryHandler.get()`, whose `this.deps.store.findItem()` goes through the `ItemStore` interface.
`PATCH` takes its store as a parameter that Next.js fills, so its flow is unknown.

```sh
tsograph reach --project fixtures/graph/di-dispatch 'src/app/api/items/route.ts#GET' 'src/app/api/items/route.ts#PATCH'
```

```json
{
  "dispatch": "bound",
  "reached": [
    { "depth": 1, "evidence": "direct", "roots": [0], "symbol": { "usr": "src/lib/handler.ts#ItemHandler.get", "…": "…" }, "via": "src/app/api/items/route.ts#GET" },
    { "depth": 2, "evidence": "bound", "roots": [0], "symbol": { "usr": "src/lib/store.ts#SqlItemStore.findItem", "…": "…" }, "via": "src/lib/handler.ts#ItemHandler.get" },
    { "depth": 3, "evidence": "bound", "roots": [0], "symbol": { "usr": "src/lib/store.ts#SqlClient.query", "…": "…" }, "via": "src/lib/store.ts#SqlItemStore.findItem" }
  ],
  "roots": [
    { "id": "src/app/api/items/route.ts#GET", "symbol": { "…": "…" } },
    { "id": "src/app/api/items/route.ts#PATCH", "symbol": { "…": "…" }, "unresolvedCalls": 1 }
  ]
}
```

With `--dispatch direct` the store methods are not reached; with `--dispatch candidates` `PATCH` also
reaches both stores and `SqlClient.query` becomes `"candidate"` (PATCH reaches it only through a
candidate edge).

### Graph limitation prefixes

`unresolved-calls:`, `partial-dispatch:`, `bound-dispatch:`, `candidate-dispatch:`, `dispatch-budget:`,
`overridden-methods:`, `missing-dependencies:`,
`unresolved-export-aliases:`, `graph-config:`, `parse-errors:`, `oversized-sources:`,
`unreadable-sources:`, `skipped-symlinks:`, `scan-truncated:`, `entry-points:`, `non-http-entries:`, and in
`reach`/`impact` documents only, `evidence-approximated:` and `unresolved-calls-capped:`.
Counts only; no source text or absolute paths.

## Symbol ids

One id format is shared by `tsograph graph`/`reach`/`impact` nodes, `symbol.usr` on route-decl
facts, and `symbol.usr` on relation-use facts, so isthmus can chain them by exact string match:

```text
<project-relative POSIX path>#<declaration path>
```

- The declaration path follows the schema [symbol format](#facts): names of the enclosing
  declarations, outermost first, joined with `.`:
  `src/lib/jobs.ts#listJobs`, `src/lib/repo.ts#Repo.save`, `src/lib/repo.ts#Repo.constructor`,
  `src/auth.ts#handlers.GET`, `src/app/api/items/[id]/route.ts#GET`, `pages/api/hello.ts#handler`.
- Code outside every named declaration (top-level statements, members with computed names, and
  callbacks inside them) belongs to the module scope `<path>#<module>`.
- An inline callback has its own id: see [inline callback ids](#inline-callback-ids).
- An anonymous default export is `<path>#default` (also for `export default <expr>`).
- An export that is not itself a named declaration (`export { a as GET }`, `export { GET } from
  './impl'`, `export const { GET } = handlers`, `export let x;`) gets an export node
  `<path>#<export name>` with an `alias` edge to what it resolves to.
- Declarations that produce the same id (overloads, a getter/setter pair, same-named functions in
  sibling blocks) are one node.
- Declaration-side relation-use facts use `#model:` and `#typedsql:` ids (see
  [Facts](#facts)); these are never graph nodes. Node ORM declarations (Drizzle tables, TypeORM
  entities, Sequelize models) reuse `#model:`.

### Inline callback ids

Arrow functions and function expressions passed directly as a call or `new` argument (parentheses,
`as`, `satisfies`, and non-null wrappers are ignored) are graph nodes. Their id is

```text
<id of the scope the callback expression sits in>.<callee>(<keys>)[~<n>]
```

- **Scope.** The callback's own position decides the prefix, not the code inside it: a callback at
  module level is under `<path>#<module>`, one inside `listJobs` under `#listJobs`, one inside another
  callback under that callback's id (`#<module>.describe("suite").it("works")`). A local variable that
  receives the call's result is not a segment (`const rows = ids.map(cb)` in `load` gives
  `#load.ids.map()`), so the prefix is always the node that holds the callback, and the graph links it
  with a `contains` edge.
- **Anchor call.** If the call that receives the callback is itself an argument of another call, the
  outermost call of that argument chain names it: `app.get('/x', asyncHandler(async (req, res) => …))`
  is `app.get("/x")`, like an unwrapped handler.
- **Callee.** The chain of identifiers, `this`, `super`, property accesses, and string-keyed element
  accesses as written (`app.get`, `this.router.post`, `db["run"]`). A call, `new`, or any other
  expression inside the chain is shortened to `…` (`new Hono().get('/a', …)` → `….get("/a")`), so an
  earlier registration in a chain never leaks into a later handler's id. A `new` anchor is written
  `new <callee>` (`new Promise()`).
- **Keys.** Up to two leading static-key arguments, joined by `,`: string literals (JSON-quoted),
  template literals (substitutions shown as `${name}` for a name chain, else `${…}`), name chains
  (`books.post(BOOKS)`, `authors.get(PATHS.authors)`), and arrays of those
  (`books.on(["PUT","PATCH"],"/b")`). The list stops at the first other argument; with none the key is
  empty (`useEffect()`). Strings longer than 64 UTF-16 units are cut (never inside a surrogate pair) and
  end with `…`; C1 controls and U+2028/U+2029 are written as `\uXXXX`, since the contract forbids control
  characters in symbol names.
- **Collisions.** Callbacks with the same prefix and segment (the same path registered twice, several
  inline functions in one call, repeated `useEffect`) are numbered in source order; the second and later
  get `~2`, `~3`, ….
- **Stability.** The id does not depend on line or column, so it survives unrelated edits: adding
  declarations or other callbacks, moving lines, changing another route's path, or adding a callback in
  another scope. It changes when the callback's own prefix, callee, or keys change, or when a callback
  with the same prefix and segment is inserted before it (the `~n` of the later ones shifts).
- **Not covered.** Callbacks inside a computed-name member get no name (nothing is guessed) and stay in
  the module scope. Functions that are not call arguments keep the existing rules: object-literal
  properties (`{ handler: async () => … }` is `…handler`), variable initializers, JSX attribute values
  and immediately invoked functions (transparent).

## Development

```sh
npm ci
npm run verify   # typecheck, tests with a 90% line/branch/function gate, clean build, CLI contract
node --test src/openapi/path-template.test.ts   # focused run
```

`src/exchange/http-limitation-scope.test.ts` checks every vendored vector file against
`conformance/SHA256SUMS`, runs the `scope.validate` cases of `conformance/http-limitation-scope.json`
against the scope validator, and pins the `scope.applies` cases the `routes` scopes rely on.
`src/exchange/dispatch-order.test.ts` runs the `dispatch.validate` cases of `conformance/http-dispatch.json`
and `src/exchange/dynamic-scope.test.ts` the `scope.dynamic-validate` cases; `routes` checks its `order` and
`dynamicScope` fields with the same validators before writing them.

`src/routes/node/node-conformance.test.ts` keeps the verified Node path-syntax tables (Hono,
path-to-regexp 0.1/6/8, find-my-way, the NestJS legacy route converter) with their package sources, and
`src/routes/node/oracle-replay.test.ts` replays the oracle recordings under
`experiments/node-routes-oracle/recorded/`.

`src/routes/conformance.test.ts` checks every static channel from the Next fixtures against
the grammar cases of the vendored `conformance/http-template.json`, and keeps the verified
Next.js conversion table (with `next/dist` sources) in the isthmus vector shape so it can be
upstreamed as `producer:nextjs` cases.

`src/schema/sql-relations.test.ts` holds the family's shared SQL relation vectors (the same
expectations as cartograph `SqlRelationsTests` and dartograph `sql_relations_test`).

`src/openapi/conformance.test.ts` runs the template canonicalizer against the isthmus shared
vector `conformance/http-template.json` when one is available (`TSOGRAPH_CONFORMANCE_DIR`,
`./conformance/`, or a sibling `../isthmus/conformance/`). If none is found, it is skipped
with a message.

## License

MIT. Free forever, no telemetry.
