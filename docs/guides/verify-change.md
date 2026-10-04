# Verify a change

Run the same gates CI runs before you send a change for review.

## Prerequisites

Node.js 24, Bun, and Git from the repository checkout. The synthetic-repository integration tests use Git.

Use the Bun version declared by `packageManager` in [package.json](../../package.json). Check it with `bun --version` before installing dependencies. CI reads the same field through `setup-bun`; it no longer selects `latest`.

```sh
bun install --frozen-lockfile
```

Bun installs dependencies, launches scripts, and also runs the fake OpenCode of one end-to-end test, because the loss that test reproduces comes from how Bun handles a pending stdout write at exit. Node.js runs the CLI and Vitest.

## Run every gate

```sh
bun run check
```

It runs formatting, lint, unused code, types, tests, and build, in CI's order. A change is ready for review only when it passes. Markdown is not covered: `*.md` is excluded from formatting.

## Run one gate

Check types and behavior:

```sh
bun run typecheck
bun run test
```

Type checking is separate from test execution and covers production modules and colocated test files. Use `bun run test`, not `bun test`: the second starts Bun's own runner instead of Vitest.

Run one test file:

```sh
bun run test -- src/evaluation/evaluation.test.ts
```

Check the executable:

```sh
bun run build
./dist/index.js --help
./dist/index.js run --help
./dist/index.js --version
npm pkg get version
```

Confirm that help renders and exits successfully without starting a benchmark, and that `--version` prints the version `npm pkg get version` shows, without the quotes.

The [source layout reference](../reference/source-layout.md) lists what each module holds.
