# tevu

A benchmark whose output is worth only as much as its fairness and its evidence. Most rules below protect the comparison rather than the code, and neither `tsc` nor the test suite enforces any of them.

## Commands

- Run tests: `bun run test` (NOT `bun test`, which starts Bun's own runner on the JavaScriptCore runtime instead of Vitest on Node, and fails part of the suite).
- A change is done when both `bun run typecheck` and `bun run test` pass. Vitest does not type-check.

## Gotchas

- **Sources also run directly under Node's type stripping.** Only erasable TypeScript syntax works: no `enum`, `namespace`, or constructor parameter properties. Vitest transpiles them and passes; `node src/index.ts` crashes. Only `bun run typecheck` and `bun run build` catch it.
- **Relative imports end in `.ts`, never `.js`.** `tsc` resolves `./module.js` to `module.ts` and the build emits it unchanged, so `bun run typecheck`, `bun run test`, and `bun run build` pass while `node src/index.ts` fails with `ERR_MODULE_NOT_FOUND`. Only `node src/index.ts --help` catches it.
- **Dependencies point one way: `domain` <- `config` <- `application` <- `interface`.** `adapters` implement contracts declared in `domain` and import nothing else from `src`. `src/index.ts` is the only module that wires concrete adapters. The code currently violates this in several places; those imports are debt to remove, not precedent to follow.
- **Errors cross module boundaries as `TevuResult`, never as thrown exceptions.**
- **Pure modules read time only through the injected clock**, never `Date.now()` or `new Date()`.
- **`tevu report` must reproduce byte-identical JSON and Markdown from unchanged artifacts.** Derived output may not depend on wall-clock time, randomness, or unordered iteration.

## Boundaries

### Always

- Leave the code you touch cleaner than you found it.

### Ask first

- Any change to the configuration contract (`version: 1`, strict rejection of unknown fields) or to the layout and format of saved run artifacts. Both are public contracts with existing files on disk.
- Restructuring `docs/`, which follows Diátaxis: guides, reference, concepts.

### Never

- Discard, revert, reset, stash, or reformat uncommitted changes outside your task's file set. The working tree may hold the user's or a parallel agent's work.
- Weaken case isolation: the sealed repository with a single synthetic root commit, the separate agent and evaluator environments and home directories, or patch capture before checks run. Any leak between cases or from later history invalidates the comparison.
- Let a secret value reach an error message, log, terminal, or artifact. A redaction failure aborts the write; it never falls back to raw text.
- Record an unavailable metric as zero or as an estimate, or derive cost from a model name or token count.
- Gate behaviour on the OpenCode version. Compatibility is decided by probing capabilities; the version is provenance only.
- Write a test that needs provider credentials, Jira credentials, a live model session, or a private repository.

## Reference docs

Consult these for the area you are working on, not as a blanket prerequisite:

- `docs/concepts/isolation.md` - why each isolation boundary exists and where it deliberately stops.
- `docs/reference/configuration.md` - the configuration contract, source-tree rules, and fixed environments.
- `docs/reference/results.md` - outcomes, metric semantics, artifact files, and regeneration guarantees.
- `docs/README.md` - full documentation index.
