# Source layout reference

| Path | Responsibility |
| --- | --- |
| `src/config` | YAML loading, the strict configuration schema, the configuration template, configuration document rendering and append, and run-snapshot decoding |
| `src/domain` | Shared records and dependency contracts |
| `src/application` | Task creation, task prompt building, validation, orchestration, assessment, and report rebuilding |
| `src/evaluation` | Checks, agent-independent metric rules, and report rendering |
| `src/adapters` | Git, issue tracker, process, and artifact I/O |
| `src/adapters/agents` | One directory per agent adapter: probing, case runs, session export, metric normalization, and protocol decoding |
| `src/interface` | Command parsing and interactive prompts |
| `src/index.ts` | Executable entry point and dependency wiring |

Product tests are colocated with the behavior they verify as `*.test.ts` or `*.integration.test.ts`. Protocol fixtures are adjacent to the protocol adapter. TypeScript module exports are internal; the CLI is the public interface.

`bun run build` compiles production modules into `dist/` at the same relative paths using `tsconfig.build.json`. `dist/index.js` is the `tevu` executable. Test files and fixtures are not compiled.

Verification commands are in the [change verification guide](../guides/verify-change.md).
