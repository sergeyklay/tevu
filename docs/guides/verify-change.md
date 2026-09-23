# How to verify a change

Use Node.js 24 and Bun from the repository checkout. Git is required for the synthetic-repository integration tests.

## Install dependencies

```sh
bun install --frozen-lockfile
```

Bun installs dependencies and launches scripts. Node.js executes the CLI and Vitest.

## Check types and behavior

```sh
bun run typecheck
bun run test
```

Both commands must pass. Type checking is separate from test execution and covers production modules and colocated test files.

For an evaluation change, run the focused file with:

```sh
bun run test -- src/evaluation/evaluation.test.ts
```

Product tests use fakes, adjacent protocol fixtures, temporary synthetic Git repositories, and bounded local child processes. They do not require private repositories, provider credentials, Jira credentials, or live model sessions. A benchmark task's own acceptance command is separate from this test suite.

## Check the executable

```sh
bun run start -- --help
bun run start -- run --help
```

Confirm that help renders and exits successfully without starting a benchmark. The CLI is the public interface; TypeScript module exports are internal.

For module responsibilities, see the [source layout reference](../reference/source-layout.md).
