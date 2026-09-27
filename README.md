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
| Web/React Native client route-calls, call graph, impact | Planned |

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
  contract's zero-segment expansion). See Decisions for why the prefix decl does not carry
  `catchAllPrefix`.
- **trailingSlash**: `strict` when the redirect rules above make one form canonical (the
  channel is that form), `optional` when no redirect applies and both forms reach the handler
  (`skipTrailingSlashRedirect: true`, `.well-known`, a last segment with a dot that neither
  redirect matches), omitted (unknown) when it depends on a parameter value or the config
  value is not a literal. `caseInsensitive` is never emitted (not proven).
- **location**: the exported name token (`GET`), or `default` for Pages Router, as a 1-based
  line and 1-based UTF-8 byte column. A leading BOM counts as its three bytes.
- **symbol.qualifiedName**: `<project-relative file>#<export name>`, for example
  `src/app/api/items/route.ts#GET` or `pages/api/hello.ts#default`. No `usr` yet.

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

All server-side prefixes come from the contract's closed list, so isthmus reads each one as
a server-side gap and downgrades `route-call-without-decl` to `-unverified` instead of
reporting a false error. Limitations carry counts and project-relative names only.

### Decisions (differences from the draft)

- **No `usr`; qualifiedName is the join handle.** `<file>#<export>` names the module export
  Next.js invokes. A later phase adds tsograph graph ids as `symbol.usr` by looking up the
  same (module path, export name) pair, without changing `qualifiedName`.
- **Optional catch-all prefix without `catchAllPrefix`.** The contract marks the expanded
  prefix decl with `catchAllPrefix: true`, but isthmus requires `symbol.usr` on such a decl.
  Until usr exists, the prefix decl is emitted as a plain decl (same method, symbol, and
  location as the `{**}` decl). Next.js rejects an explicit route at the same place (build
  error E458), so it cannot collide with an explicit decl; the cost is that it may appear in
  `route-decl-without-call` / drift warnings. It becomes `catchAllPrefix: true` once usr lands.
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
accessors, class fields, `constructor`, `default` for anonymous default exports, variables at
module level or whose function-valued initializer contains the fact (`src/lib/jobs.ts#listJobs`,
`src/repo.ts#Repo.save`, `src/api.ts#handlers.GET`). Anonymous callbacks are transparent. A
computed name stops the symbol, and module-level statements have none; those facts are counted
under `missing-relation-symbols:`. Schema facts use the model name (`Job`, `Job.title`), and
TypedSQL facts use `<path>#<file name>`.

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
`unresolved-client-receivers:`, `provenance-truncated:`, `missing-relation-symbols:`,
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
