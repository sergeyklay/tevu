# Source layout reference

The source directories of tevu, what each holds, how they depend on each other, and how the executable is built.

| Path | Responsibility |
| --- | --- |
| `src/config` | YAML loading, configuration file search, the strict schema, the template, document rendering and append, and run-snapshot decoding |
| `src/domain` | Shared records, dependency contracts, and helpers every layer may import |
| `src/application` | Task creation and prompts, reference-solution resolution, managed-clone preparation, validation, run orchestration, assessment, report rebuilding, the one-shot model, grading, criteria, and summary calls, writing the summary conclusions, and the model access check of the setup interview |
| `src/evaluation` | Checks, agent-independent metric rules, grading logic, report rendering, and the run summary: its facts, template sentences, rendering, prompt, and acceptance check |
| `src/adapters` | Git, managed clones, trackers, process supervision, and artifact I/O |
| `src/adapters/agents` | One directory per agent adapter: probing, case runs, session export, model calls, metric normalization, protocol decoding, provider copying, and model listing |
| `src/interface` | Command parsing and interactive prompts |
| `src/index.ts` | Executable entry point and dependency wiring |

Product tests are colocated with the behavior they verify, as `*.test.ts` or `*.integration.test.ts`. Protocol fixtures sit next to the protocol adapter. TypeScript module exports are internal; the CLI is the public interface.

## Dependencies between directories

Imports point one way:

```text
domain <- config <- evaluation <- application <- interface
```

A directory imports only from directories to its left. `src/adapters` implements contracts declared in `src/domain` and imports nothing else from `src`. `src/index.ts` is the only module that wires concrete adapters.

## Code rules

- Errors cross module boundaries as `TevuResult` values, never as thrown exceptions.
- Pure modules read time only through the injected clock, never through `Date.now()` or `new Date()`.
- `tevu report` reproduces byte-identical JSON and Markdown from unchanged artifacts, so derived output never depends on wall-clock time, randomness, or unordered iteration.

## Build

`bun run build` runs `scripts/build.mjs`, which bundles `src/index.ts` and the production modules it imports into `dist/index.js` with esbuild and writes the `version` of `package.json` into the bundle. `dist/index.js` is the `tevu` executable and the only supported way to run it; `tevu --version` prints the version written at build time without reading `package.json`. Packages in `dependencies` are not bundled and load from `node_modules` at run time. Test files and fixtures are not part of the bundle.

The commands that reproduce CI are in [CONTRIBUTING.md](../../CONTRIBUTING.md#reproduce-ci).
