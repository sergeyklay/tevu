# Source layout reference

The source directories of tevu, what each holds, how they depend on each other, and how the executable is built.

| Path | Responsibility |
| --- | --- |
| `src/config` | YAML loading, configuration file search, the strict schema, the template, document rendering and append, and run-snapshot decoding |
| `src/domain` | Shared records, dependency contracts, and helpers every layer may import |
| `src/domain/ports` | One module per dependency contract an adapter implements, with the request and result shapes only that contract uses |
| `src/application` | Task creation and prompts, reference-solution resolution, managed-clone preparation, validation, run orchestration, assessment, report rebuilding, the one-shot model, grading, criteria, and summary calls, writing the summary conclusions, and the model access check of the setup interview |
| `src/evaluation` | Checks, agent-independent metric rules, grading logic, report rendering, and the run summary: its facts, template sentences, rendering, prompt, and acceptance check |
| `src/adapters` | Git, managed clones, trackers, process supervision, and artifact I/O |
| `src/adapters/agents` | One directory per agent adapter: probing, case runs, session export, model calls, metric normalization, protocol decoding, provider copying, and model listing |
| `src/interface` | Command parsing and interactive prompts |
| `src/interface/commands` | One module per command: the operations it needs and its handler, plus the pieces the handlers share |
| `src/interface/task-wizard` | The `tevu task add` interview: one module per interview step, the waits between questions, and the entry that runs the steps in order |
| `src/index.ts` | Executable entry point and dependency wiring |

Product tests are colocated with the behavior they verify, as `*.test.ts` or `*.integration.test.ts`. Protocol fixtures sit next to the protocol adapter. TypeScript module exports are internal; the CLI is the public interface.

## Dependencies between directories

Imports point one way:

```text
domain <- config <- evaluation <- application <- interface
```

A directory imports only from directories to its left. `src/adapters` implements contracts declared in `src/domain` and imports nothing else from `src`. `src/index.ts` is the only module that wires concrete adapters.

## Code rules

- Errors cross module boundaries as `TevuResult` values, never as thrown exceptions. `WizardCancelledError`, the cancellation sentinel of the `tevu task add` and `tevu assess` wizards, is exempt: it may cross files inside a wizard, and `runTaskWizard` and `runAssessmentWizard` turn it into a `CancellationError` result, so it never leaves a wizard.
- Pure modules read time only through the injected clock, never through `Date.now()` or `new Date()`.
- `tevu report` reproduces byte-identical JSON and Markdown from unchanged artifacts, so derived output never depends on wall-clock time, randomness, or unordered iteration.
- Modules under `src/domain` stay free of boundary dependencies: no Commander.js, Clack, Execa, Git commands, Jira transport code, or Node.js process globals.
- Each declaration in `src/domain` lives in the module of its concept: a dependency contract in its own module under `src/domain/ports`, a shape a run saves in `run-records.ts`. No module re-exports another module's declarations, and no catch-all module collects unrelated ones.

## Build

`bun run build` runs `scripts/build.mjs`, which bundles `src/index.ts` and the production modules it imports into `dist/index.js` with esbuild and writes the `version` of `package.json` into the bundle. `dist/index.js` is the `tevu` executable and the only supported way to run it; `tevu --version` prints the version written at build time without reading `package.json`. Packages in `dependencies` are not bundled and load from `node_modules` at run time. Test files and fixtures are not part of the bundle.

The commands that reproduce CI are in [CONTRIBUTING.md](../../CONTRIBUTING.md#reproduce-ci).
