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
| Node backend route declarations (Next.js, Hono, Express, Fastify, NestJS, Koa) | Planned |
| ORM/SQL relation-use facts (Prisma, TypeORM, Sequelize, Drizzle, Knex, raw SQL, D1) | Planned |
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
  column. A leading BOM is not counted.
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
  `unresolved-contract-servers:`. Variables inside a literal `scheme://host` authority are
  harmless and ignored. A leading variable with no literal authority (`{base}/v1`) can change
  the path, so it is not resolved either.
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
- At most 100,000 facts are emitted (counted before any fact is built), and the output must
  fit the isthmus per-file input cap of 16 Mi characters. Beyond either limit the command
  fails instead of writing a partial document.

## Development

```sh
npm ci
npm run verify   # typecheck, tests with a 90% line/branch/function gate, clean build, CLI contract
node --test src/openapi/path-template.test.ts   # focused run
```

`src/openapi/conformance.test.ts` runs the template canonicalizer against the isthmus shared
vector `conformance/http-template.json` when one is available (`TSOGRAPH_CONFORMANCE_DIR`,
`./conformance/`, or a sibling `../isthmus/conformance/`). If none is found, it is skipped
with a message.

## License

MIT. Free forever, no telemetry.
