# tsograph

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
| Other Node backend route declarations (Hono, Express, Fastify, NestJS, Koa) | Planned |
| `tsograph schema`: Prisma schema, Prisma Client, and raw SQL → persistence `relation-use` facts | Implemented |
| TypeORM, Sequelize, Drizzle, Knex, raw drivers, D1 relation-use facts | Planned (counted as limitations today) |
| `tsograph graph` / `reach` / `impact`: TypeScript/JavaScript call graph → isthmus `language-traversal` v1 | Implemented |
| Interface / dependency-injection dispatch: `bound` and `candidate` edges, `--dispatch`, per-root `evidence`, `unresolvedCalls` | Implemented |
| Web/React Native client route-calls | Planned |

The isthmus `http` target is still a **draft** in isthmus `docs/GRAPH-EXCHANGE.md`
("개발 중: HTTP 경계 합의 초안"). Released isthmus versions reject `target: "http"` documents
until that draft ships.

## Requirements

- Node.js 22.18.0 or newer

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

Scans a Next.js project and writes a bridge-facts v1 document to stdout: `platform: "js"`,
`target: "http"`, `roles: ["server"]`, `dispatch: "specificity"`, `sourceSets`, and one
`route-decl` fact per (route file, HTTP method). The analyzed code is parsed with the
TypeScript parser only; it is never executed, and no module resolution, type checking, or
network access happens.

- `--role server` (required): only the declaration side is implemented. `client` is a usage
  error until route-call extraction exists.
- `--project` (required): the Next.js project root (where `next.config.*` and `app/` or
  `pages/` live). `project` is its POSIX realpath and `location.path` is relative to it.
- `--service`: service identity recorded on the document and on every fact.
- `--include-tests`: also emit route files that look like tests, with `testSource: true`
  and `sourceSets.tests: "included"`. Without it they are skipped and the document declares
  `sourceSets.tests: "excluded"`. Test paths are `*.test.*`, `*.spec.*`, and files under
  `__tests__/` or `__mocks__/`. `test/` folders are not treated as tests, because in Next.js
  they are real URL segments (`app/api/test/route.ts` serves `/api/test`).
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
| `proxy`/`middleware` file, metadata files, non-empty `public/` | `framework-provided-routes:` (no synthetic decls) |
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

### Validation with isthmus

The synthetic fixtures under `fixtures/next/` were checked with the isthmus `main` consumer:

```sh
tsograph openapi fixtures/next/app-router/openapi.yaml --service demo --project fixtures/next/app-router > contract.json
tsograph routes --role server --project fixtures/next/app-router --service demo > decl.json
# client.json: a zero-fact document with roles ["client"], the same project and service
node <isthmus>/src/cli/main.ts check contract.json decl.json client.json
```

The check exits 0 and reports the intended drift (`route-contract-without-decl` for
`GET /api/health` and `PUT /api/items/{}`, `route-decl-without-contract` for handlers the spec
does not list).

## `tsograph schema`

```sh
tsograph schema --project <root> [--format json]
```

Scans the project for Prisma schemas, Prisma Client usage, and SQL text, and writes a
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
  Prisma generator output directories, `*.d.ts`, and files over 4 MiB (counted).

### Facts

| Source | `channel` | `method` | `location` | `symbol.qualifiedName` |
|---|---|---|---|---|
| Prisma `model`/`view` | resolved table name | — | model name | `Model` |
| Prisma scalar field | resolved table name | resolved column | field name | `Model.field` |
| Implicit many-to-many | `_<RelationName>` | — and `A`, `B` | first relation field | `Model.field` |
| `client.<delegate>` access | the model's table | — | delegate name | enclosing declaration |
| Delegate call arguments | the model's table | column | object key or string | enclosing declaration |
| Raw SQL (`$queryRaw`, `$executeRaw`, `Prisma.sql`, `…Unsafe`, TypedSQL, uppercase literals) | relation as written | — | the SQL literal (TypedSQL: the keyword) | enclosing declaration |

Channels are written as the code or mapping names them: `schema.table` when qualified
(`@@schema`, `FROM s.t`), otherwise unqualified — tsograph never guesses a default schema such as
`public`, because PostgreSQL resolves it from the connection. A name that itself contains `.`
(`@@map("a.b")`, `"a.b"` in SQL) is one segment escaped as `a%2Eb`; `%` is escaped as `%25`.

**Symbol format.** Source facts use `<project-relative POSIX path>#<Name>(.<Name>)*`, outermost
declaration first: function declarations, named classes and class expressions, methods,
accessors, class fields, `constructor`, `default` for anonymous default exports (including the
expression of `export default <expr>`), variables at
module level or whose function-valued initializer contains the fact (`src/lib/jobs.ts#listJobs`,
`src/repo.ts#Repo.save`, `src/api.ts#handlers.GET`). Anonymous callbacks are transparent. A
computed name stops the symbol, and module-level statements have none; those facts are counted
under `missing-relation-usrs:` (the isthmus chain-only prefix; informational). Schema facts use the model name (`Job`, `Job.title`), and
TypedSQL facts use `<path>#<file name>`.

Source facts also carry `symbol.usr`, equal to `qualifiedName`: it is the tsograph graph id of
the enclosing declaration ([Symbol ids](#symbol-ids)), so `tsograph reach` output can be joined
with relation-use facts by exact string match.

Schema declaration facts and TypedSQL facts also carry a stable usr, in namespaces that are **not**
graph nodes: `<schema path>#model:<Model>` / `#model:<Model.field>` (for example
`prisma/schema.prisma#model:Job`, `prisma/schema.prisma#model:Job.title`, and
`#model:Book.tags` for an implicit many-to-many join table), and `<sql path>#typedsql:<name>`.
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

### Outside the supported surface

TypeORM, Sequelize, Drizzle, Knex, Kysely, Objection, MikroORM, `pg`, `postgres`, `mysql`,
`mysql2`, SQLite drivers, libSQL, Neon, Vercel Postgres, PlanetScale, MSSQL, Oracle, slonik, and
Cloudflare D1 (`D1Database`) queries are not interpreted. Files using them are counted under
`unsupported-db-packages:`, and Mongoose, MongoDB, DynamoDB, Firebase, and Redis under
`non-relational-stores:`. Uppercase SQL literals in those files are still read as SQL text.

### Limitation prefixes

`prisma-schema-not-found:`, `unresolved-prisma-config:`, `missing-prisma-schemas:`,
`schema-outside-project:`, `non-relational-stores:`, `prisma-naming-unverified:`,
`prisma-8-surface-unscanned:`, `unparsed-schema-lines:`, `unresolved-field-types:`,
`ignored-prisma-elements:`, `unresolved-generator-outputs:`, `unresolved-typed-sql:`,
`unsupported-db-packages:`, `dynamic-relation-names:`, `skipped-sql-literals:`,
`unresolved-client-receivers:`, `provenance-truncated:`, `missing-relation-usrs:`,
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
  when readable. The snapshot holds every edge tier (see [Interface dispatch](#interface-dispatch-bound-and-candidate-edges)).
- `reach` writes the symbols reachable from the root ids (`direction: "dependencies"`), and
  `impact` the symbols that reach them (`direction: "dependents"`), as isthmus
  [`language-traversal` v1](https://github.com/ictechgy/isthmus/blob/main/docs/LANGUAGE-TRAVERSAL.md).
- Ids are [symbol ids](#symbol-ids): the same strings as `symbol.usr` in `tsograph routes` and
  `tsograph schema` output. An unknown id is a usage error (exit `64`) that lists the ids; tsograph
  does not emit the contract's in-document `root-not-found` roots, because a typo in a root id should
  stop the pipeline rather than produce a silently partial traversal. Duplicate
  ids are kept once, in first-seen order (that order defines `reached[].roots` indices).
- Exit codes: `0` success, `2` unreadable project or output over 16 Mi characters, `64` usage error.

### Nodes and edges

Nodes are only the project's own source files (the same walk as `tsograph schema`, minus Prisma
generator output, plus every route file). Declarations in `node_modules`, TypeScript lib files, and
generated clients are never nodes; calls into them are counted as external.

| Node kind | What |
|---|---|
| `module` | `<path>#<module>`: top-level statements and code outside any named declaration |
| `function`, `method`, `constructor`, `accessor`, `class`, `field`, `variable` | declarations named by the symbol id rules (function-valued variables and object properties are `function`) |
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
- Calls through packages whose type declarations cannot be resolved (dependencies not installed,
  untyped packages) are external and counted under `missing-dependencies:`.
- Module scopes are not linked from importers (import-time side effects stay on the `<module>` node).

### Interface dispatch (bound and candidate edges)

Every edge carries an `evidence` tier. The tiers nest: the `direct` graph ⊂ the `bound` graph ⊂ the
`candidate` graph.

| `evidence` | Meaning |
|---|---|
| `direct` | The target is proven by checker symbols (or by the receiver's fixed initializer, above). |
| `bound` | A call through an interface-typed or structurally typed receiver (`this.deps.store.findItem()`, `repository.save()`) where **every value observed flowing into the receiver** within the scanned project is an instance of a project class or a project object literal, and the method resolves on each of them to a project declaration with a body. One edge per distinct implementation. |
| `candidate` | The flows could not all be proven, so the call is linked to every project class or object that could implement it: classes that declare `implements` for the receiver's interface (directly, through a base class, or through an extending interface), and classes and object literals whose type is assignable to the receiver type (`TypeChecker.isTypeAssignableTo`, public in the pinned TypeScript 5.9.3; a type-parameter receiver uses its constraint). An over-approximation. |

How `bound` values are found (whole program, context- and path-insensitive): `new C(...)`, object
literals, `this` (the enclosing class and its project subclasses), variable initializers plus every
assignment, parameters (default value plus the same-position argument at every call site of a
function declaration, a `const`-bound function, or a constructor, including `super(...)` and the
implicit `super` of subclasses without a constructor), object destructuring, properties of object
literals and class instances (initializer, parameter property, getter return, plus every same-named
property write anywhere; a write is skipped only when it resolves to a member of a class that, like the
value's class, has `private`/`protected`/`#` members and neither class is assignable to the other —
TypeScript's structural rules, array covariance, and method-parameter bivariance let any other type
reach the value), return values of called functions
(interface-typed factories are resolved through their receiver's values), `await`, `?:`, `??`, `||`,
`&&`, and the comma operator. A slot that feeds itself through a call or property
(`this.store = this.store.withCache()`, a recursive wrapper) is iterated to its fixpoint. Composition roots such as
`new ItemHandler({ store: new SqlItemStore(client) })`, `createLookup({ store })`, `new ItemService(sql)`,
default-parameter DI (`store: ItemStore = new MemoryItemStore()`), and module singletons created by a
factory are followed across modules.

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
  `const { run } = h`, `({ run } = h)`) unless the read provably cannot reach the class under the same
  nominal rule, exports reachable from a
  loaded module through re-export barrels (`export *`, `export { x } from`, `export * as ns`), and
  `declare`d values. A package whose `package.json` declares `main`, `module`, `exports`, `bin`,
  `types`, `typings`, or `browser` (or whose `package.json` cannot be read as a JSON object within
  1 MiB), or an incomplete scan (skipped, oversized, unreadable, or
  symlinked files, or parse errors), additionally opens every exported function and class and every
  non-private property; the document then says so under `bound-dispatch:`. An exported function whose
  callers are all in the project is closed; one with no project caller has no observed flow and is not
  bound.
- **Not modeled** (documented gaps): writes through computed keys (`obj[key] = v`), prototype mutation,
  `eval`, type assertions that lie about a value's type (`x as unknown as Other`), values that leave the
  project through library code and come back, and properties that library code mutates. When
  dependencies are not installed, their types are errors and count as `any`. Same-named writes and
  method reads elsewhere in the project can therefore block `bound` for unrelated classes (fewer `bound`
  edges, never wrong ones). Dynamic `import()`/`require()` with a non-string specifier and file-pattern
  loaders (`import.meta.glob`, `require.context`) open every export. `Object.assign`,
  `Object.defineProperty(ies)`, `Reflect.set`, and `Reflect.defineProperty` targets are handled
  conservatively (their properties and members become unknown, including for statically resolved member
  calls). A same-named property write that replaces a
  method (monkey patching) blocks `bound` for that method.
- **Test sources are separate programs.** For call sites outside test sources (`*.test.*`,
  `*.spec.*`, `__tests__/`, `__mocks__/` — the `routes` rule), flows and candidates come from the
  program without test sources, so mocks injected by unit tests do not block production edges. Call
  sites inside test sources use the whole project. If a non-test file imports a test source, the whole
  project is used everywhere.
- Each flow query has a budget (20,000 steps, 256 nested slots); a query over budget is unknown.

`unresolvedCalls` counts, per node and per mode, the node's own call sites (calls, `new`, tagged
templates, decorators, JSX) that have no edge or only a partial set of targets under that mode:
`direct` counts every such site, `bound` drops the interface calls linked by `bound` edges, and
`candidates` also drops those linked by `candidate` edges. Calls into dependencies are external, not
unresolved. Callback invocations through parameters are counted even though the caller's `callback`
edge covers the reach.

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
  value in `roots[]` and `reached[]`.
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
consumer.

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

`unresolved-calls:`, `partial-dispatch:`, `bound-dispatch:`, `candidate-dispatch:`,
`overridden-methods:`, `missing-dependencies:`,
`unresolved-export-aliases:`, `graph-config:`, `parse-errors:`, `oversized-sources:`,
`unreadable-sources:`, `skipped-symlinks:`, `scan-truncated:`, `entry-points:`, `non-http-entries:`.
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
- Code outside every named declaration (top-level statements, callbacks passed at module level,
  members with computed names) belongs to the module scope `<path>#<module>`.
- An anonymous default export is `<path>#default` (also for `export default <expr>`).
- An export that is not itself a named declaration (`export { a as GET }`, `export { GET } from
  './impl'`, `export const { GET } = handlers`, `export let x;`) gets an export node
  `<path>#<export name>` with an `alias` edge to what it resolves to.
- Declarations that produce the same id (overloads, a getter/setter pair, same-named functions in
  sibling blocks) are one node.
- Declaration-side relation-use facts use `#model:` and `#typedsql:` ids (see
  [Facts](#facts)); these are never graph nodes.

## Development

```sh
npm ci
npm run verify   # typecheck, tests with a 90% line/branch/function gate, clean build, CLI contract
node --test src/openapi/path-template.test.ts   # focused run
```

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
