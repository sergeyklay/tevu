# Source layout reference

| Path | Responsibility |
| --- | --- |
| `src/config` | YAML loading and the strict configuration schema |
| `src/domain` | Shared records and dependency contracts |
| `src/application` | Task creation, validation, orchestration, assessment, and report rebuilding |
| `src/evaluation` | Checks, metric normalization, and report rendering |
| `src/adapters` | Git, agent, Jira, process, and artifact I/O |
| `src/interface` | Command parsing and interactive prompts |
| `src/index.ts` | Executable entry point and dependency wiring |

Product tests are colocated with the behavior they verify as `*.test.ts` or `*.integration.test.ts`. Protocol fixtures are adjacent to the protocol adapter. TypeScript module exports are internal; the CLI is the public interface.

`bun run build` compiles production modules into `dist/` at the same relative paths using `tsconfig.build.json`. `dist/index.js` is the `tevu` executable. Test files and fixtures are not compiled.

Verification commands are in the [change verification guide](../guides/verify-change.md).
