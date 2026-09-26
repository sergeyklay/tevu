# Source layout reference

| Path | Responsibility |
| --- | --- |
| `src/config` | YAML loading, configuration file search, the strict configuration schema, the configuration template, configuration document rendering and append, and run-snapshot decoding |
| `src/domain` | Shared records, dependency contracts, and helpers that every layer may import |
| `src/application` | Task creation, task prompt building, validation, orchestration, assessment, report rebuilding, and the one-shot model call |
| `src/evaluation` | Checks, agent-independent metric rules, and report rendering |
| `src/adapters` | Git, issue tracker, process, and artifact I/O |
| `src/adapters/agents` | One directory per agent adapter: probing, case runs, session export, model calls, metric normalization, and protocol decoding |
| `src/interface` | Command parsing and interactive prompts |
| `src/index.ts` | Executable entry point and dependency wiring |

Product tests are colocated with the behavior they verify as `*.test.ts` or `*.integration.test.ts`. Protocol fixtures are adjacent to the protocol adapter. TypeScript module exports are internal; the CLI is the public interface.

`bun run build` bundles `src/index.ts` and the production modules it imports into the single file `dist/index.js` with esbuild. `dist/index.js` is the `tevu` executable and the only supported way to run it. Packages from `dependencies` are not bundled and load from `node_modules` at run time. Test files and fixtures are not part of the bundle.

Verification commands are in the [change verification guide](../guides/verify-change.md).
