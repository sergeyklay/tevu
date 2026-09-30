# Source layout reference

The source directories of tevu, what each holds, and how the executable is built. For the dependency direction between them, see [AGENTS.md](../../AGENTS.md).

| Path | Responsibility |
| --- | --- |
| `src/config` | YAML loading, configuration file search, the strict schema, the template, document rendering and append, and run-snapshot decoding |
| `src/domain` | Shared records, dependency contracts, and helpers every layer may import |
| `src/application` | Task creation and prompts, reference-solution resolution, managed-clone preparation, validation, run orchestration, assessment, report rebuilding, the one-shot model, grading, and criteria calls, and the model access check of the setup interview |
| `src/evaluation` | Checks, agent-independent metric rules, grading logic, and report rendering |
| `src/adapters` | Git, managed clones, trackers, process supervision, and artifact I/O |
| `src/adapters/agents` | One directory per agent adapter: probing, case runs, session export, model calls, metric normalization, protocol decoding, provider copying, and model listing |
| `src/interface` | Command parsing and interactive prompts |
| `src/index.ts` | Executable entry point and dependency wiring |

Product tests are colocated with the behavior they verify, as `*.test.ts` or `*.integration.test.ts`. Protocol fixtures sit next to the protocol adapter. TypeScript module exports are internal; the CLI is the public interface.

## Build

`bun run build` bundles `src/index.ts` and the production modules it imports into `dist/index.js` with esbuild. `dist/index.js` is the `tevu` executable and the only supported way to run it. Packages in `dependencies` are not bundled and load from `node_modules` at run time. Test files and fixtures are not part of the bundle.

The commands that verify a change are in the [change verification guide](../guides/verify-change.md).
