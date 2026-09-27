# tsograph

[한국어](README.ko.md)

Static facts for TypeScript/JavaScript (Node) services, emitted in the
[isthmus](https://github.com/ictechgy/isthmus) bridge-facts exchange format.

tsograph is the TypeScript/JavaScript member of a family of static-analysis CLIs
(cartograph for Swift, kartograph for Kotlin, dartograph for Dart, gartograph for Go,
rustograph for Rust, schemagraph for SQL). Each tool reports only what it observes in its
own language; isthmus joins the documents.

## Status

Repository skeleton. No commands are implemented yet.

## Requirements

- Node.js 22.18.0 or newer

## Development

```sh
npm ci
npm run verify   # typecheck, tests with a 90% coverage gate, clean build, CLI contract
```

## License

MIT. Free forever, no telemetry.
