# Contributing

Read [AGENTS.md](AGENTS.md) for product contracts and module boundaries. Reproduce behavior with synthetic input, then propose a focused change on a topic branch.

## Local verification

Use the committed lockfiles and toolchains configured in CI. These are the basic local checks; `.github/workflows/` also runs them on later Node versions, checks a packed tarball installed into an isolated prefix (`TSOGRAPH_CLI`), runs the full verification on macOS, and runs compiler-path checks on Windows. `tsograph change-impact` tests need Git 2.45+; with an older local Git they are skipped with that reason (never under `CI`).

```sh
npm ci
npm run verify
```

Report checks that could not run and the relevant environment constraints. Preserve coverage and performance gates. Optional features require a feature build; default tests alone do not validate them.

## Pull requests and reports

Use Conventional Commits and explain why the behavior changes. Include the regression, commands and results, compatibility impact and observed limitations. Keep English and Korean user documentation consistent. Source validation and published installation are separate claims.

Changes to retention, identifiers, defaults or exchange contracts need evidence for affected consumers and both false-positive and missing-dependency cases. Graph results do not establish that deletion is safe.
