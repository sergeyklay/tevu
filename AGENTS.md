# tevu

A benchmark whose output is worth only as much as its fairness and its evidence. Most rules below protect the comparison rather than the code, and neither `tsc` nor the test suite enforces any of them.

## Commands

- Run tests: `bun run test` (NOT `bun test`, which starts Bun's own runner on the JavaScriptCore runtime instead of Vitest on Node; from the repository root it prints an error and exits with code 1 before running any test).
- A change is done when `bun run check` passes. It runs every CI gate in CI's order: formatting, lint, unused code (knip), types, tests, and build. Vitest does not type-check, and passing tests alone say nothing about the other gates.
- Build: `bun run build` bundles `src/index.ts` with esbuild into `dist/index.js`, leaving `dependencies` external. `dist/index.js` is the only supported way to run tevu; sources do not run under plain Node.

## Gotchas

- **Imports that leave the file's directory use `@/…`, which maps to `src/…`; same-directory imports stay `./x`. No specifier carries a `.ts` or `.js` extension.** The alias comes from `paths` in `tsconfig.json`, which `tsc`, esbuild, Vitest (`resolve.tsconfigPaths`), typescript-eslint, and knip all read; a new tool that resolves `src` imports needs the same.
- **`src/index.ts` reads the package version from `__TEVU_VERSION__`, a constant the build writes from `package.json`.** `scripts/build.mjs` and `vitest.config.ts` define it; a new tool that evaluates `src/index.ts` needs the same. `src/` never imports `package.json` and never repeats the version as a literal.
- **Dependencies point one way: `domain` <- `config` <- `application` <- `interface`.** `adapters` implement contracts declared in `domain` and import nothing else from `src`. `src/index.ts` is the only module that wires concrete adapters.
- **Errors cross module boundaries as `TevuResult`, never as thrown exceptions.**
- **Pure modules read time only through the injected clock**, never `Date.now()` or `new Date()`.
- **`tevu report` must reproduce byte-identical JSON and Markdown from unchanged artifacts.** Derived output may not depend on wall-clock time, randomness, or unordered iteration.

## Boundaries

### Always

- Leave the code you touch cleaner than you found it.
- Keep documentation true to the code in the same change. When writing a spec, a plan, or code that changes a command, flag, configuration field, default, message, artifact, result, or other behaviour, find every document it makes wrong (`README.md`, anything under `docs/`, and the reference docs listed below) and update it. A task that does not mention docs, or names only some of them, does not exempt the rest. The one protected case is a fix that would restructure `docs/` (see Ask first): report that document as stale instead of moving or splitting pages.

### Ask first

- Any change to the configuration contract (`version: 1`, strict rejection of unknown fields) or to the layout and format of saved run artifacts. Both are public contracts with existing files on disk.
- Restructuring `docs/`, which follows Diátaxis: getting-started, guides, reference, concepts.

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
- `docs/reference/configuration.md` - the configuration file format; `docs/reference/repositories.md` for source-tree rules and `docs/reference/environment.md` for fixed environments.
- `docs/reference/results.md` and `docs/reference/artifacts.md` - outcomes, metric semantics, artifact files, and regeneration guarantees.
- `docs/README.md` - full documentation index.
