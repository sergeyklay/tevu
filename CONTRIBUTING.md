# Contributing to tevu

How to report a problem, propose a feature, set up a checkout, reproduce CI locally, and send a change.

## Report a problem or propose a feature

- **Bug:** open an issue with the [bug report form](https://github.com/sergeyklay/tevu/issues/new?template=bug_report.yml).
- **Feature request:** open an issue with the [feature request form](https://github.com/sergeyklay/tevu/issues/new?template=feature_request.yml).
- **Security vulnerability** (a credential reaching output, or a broken isolation boundary): report it privately as described in [SECURITY.md](SECURITY.md). Never open a public issue for it.

Issues and pull requests are public. Never include credentials, tokens, private task text, content of a private repository, session exports, or unredacted logs. Describe the shape of the input instead of pasting it.

## Set up a checkout

You need Linux or macOS with:

- Node.js 24, as declared by `engines` in [package.json](package.json);
- the Bun version declared by `packageManager` in [package.json](package.json). CI installs the same version. The field doesn't switch your local Bun; check it with `bun --version`;
- Git and Git LFS. The integration tests create synthetic repositories that use both.

```sh
git clone https://github.com/sergeyklay/tevu.git
cd tevu
bun install --frozen-lockfile
```

A different Bun version fails here with `lockfile had changes, but lockfile is frozen`.

## Build and run your build

```sh
bun run build
./dist/index.js --version
```

`dist/index.js` is the only supported way to run tevu; the sources don't run under plain Node.js. To run your build as `tevu` from any directory, link it into a directory on `PATH`:

```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/index.js" ~/.local/bin/tevu
command -v tevu
```

Rebuild after each change; the link picks up the new file. If the npm package is also installed, the shell runs the `tevu` found first on `PATH`.

## Reproduce CI

CI runs on every pull request. It lints and type-checks once, then runs the tests and the build on Ubuntu and macOS, each with Node.js 24.0.0, the lowest version `engines` allows, and with the latest Node.js 24 release. Run the same gates locally:

```sh
bun run check
```

It runs, in CI's order: formatting, lint, unused code (knip), types, tests, and build. A change is ready for review only when it passes. `*.md` files are excluded from formatting.

CI then checks the built executable. Run the same commands after `bun run check`:

```sh
node dist/index.js --help
./dist/index.js run --help
test "$(node dist/index.js --version)" = "$(node -p "require('./package.json').version")"
```

Last, CI packs the build and checks the archive the way a user receives it. The check installs the archive with production dependencies into a temporary directory outside the checkout, runs it with a `PATH` that holds Node.js and Git but no Bun, and runs an offline benchmark with a fake agent and a synthetic repository. It needs network access to install the runtime dependencies from npm:

```sh
version="$(node -p "require('./package.json').version")"
dir="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$dir"
node scripts/check-package.mjs "$dir/tevu-$version.tgz" "$version"
```

It fails when the archive's name, version, `bin`, or file list differ from what tevu publishes, when a devDependency gets installed, or when a command fails, and prints the archive's SHA-256 and npm integrity when it passes.

The Docs workflow checks links and fragment anchors in `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, and `docs/`. On pull requests that change Markdown or the version, it checks only files in the repository; a weekly run also checks external URLs. Run the pull request check locally with [lychee](https://github.com/lycheeverse/lychee) 0.24.2, and drop `--offline` to include external URLs:

```sh
lychee --offline --include-fragments \
  --remap "https://github\.com/sergeyklay/tevu/(blob|tree)/v[^/]+/(.*) file://$PWD/\$2" \
  README.md CONTRIBUTING.md SECURITY.md 'docs/**/*.md'
```

To iterate on one gate:

| Gate | Command |
| --- | --- |
| Formatting | `bun run format:check` |
| Lint | `bun run lint` |
| Unused code | `bun run knip` |
| Types, including test files | `bun run typecheck` |
| All tests | `bun run test` |
| One test file | `bun run test -- src/evaluation/evaluation.test.ts` |
| Build | `bun run build` |

Use `bun run test`, never `bun test`: the second starts Bun's own test runner instead of Vitest and fails.

## Architecture

- [Source layout](docs/reference/source-layout.md): what each source directory holds, the direction of imports between them, the rules for errors, time, and deterministic reports, and how the build works.
- [How tevu works](docs/concepts/how-tevu-works.md) and [Isolation](docs/concepts/isolation.md): the model a change must preserve.

Open an issue before changing the configuration contract (`version: 1`, strict rejection of unknown fields) or the layout and format of saved run artifacts. Both are public contracts with existing files on disk.

## Tests and fixtures

Tests sit next to the code they verify, as `*.test.ts` or `*.integration.test.ts`. Protocol fixtures sit next to the protocol adapter.

- No test may need provider credentials, Jira credentials, a live model session, or a private repository. Use fake executables, temporary synthetic Git repositories, and bounded local child processes.
- Secret values in tests are synthetic strings, such as `synthetic-acme-secret-value`. A test that covers redaction asserts that the synthetic value is absent from the output.
- A fixture never holds material from a real run: no real session export, task text, repository content, or credential. Write it by hand, or reduce a captured one until only synthetic content remains.
- Pure modules read time through the injected clock, so tests control it instead of reading the wall clock.

## Send a change

1. Branch from `main`.
2. Update every document the change makes wrong in the same pull request: `README.md` and pages under `docs/`. `docs/` follows Diátaxis; adding, moving, or splitting pages needs the maintainer's approval first. npm publishes `README.md` without `docs/`, so every link in `README.md` is an absolute GitHub URL at the tag of the version in `package.json`, such as `blob/v0.1.0/docs/README.md`. A version change updates these links in the same pull request.
3. Write commit messages in the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) format, for example `fix: keep the agent command out of the denial reason`.
4. Pass `bun run check` and the executable check above.
5. Open the pull request and fill in its template.
