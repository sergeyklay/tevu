<h1 align="center">tevu</h1>

<div align="center">

**Benchmark coding models on your real tasks.**

Find which models finish your tasks, how long they take, and what they cost.

[Get started](docs/guides/run-benchmark.md) · [Documentation](docs/README.md)

</div>

## The Problem

Public benchmarks don't tell you which coding model can finish your team's backlog, or whether a cheaper model can do the same work. Finding out means giving models the same starting point, checking their solutions, and tracking time and cost. Doing that by hand becomes a project of its own.

tevu runs that comparison on tasks from your own task tracker.

## Works With

**Issue trackers:** GitHub Issues and Jira.

**Coding agents:** OpenCode.

## Install

From a checkout, with Node.js 24 and Bun installed:

```sh
bun install --frozen-lockfile
bun run build
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/index.js" ~/.local/bin/tevu
tevu --help
```

`~/.local/bin` must be on `PATH`; any directory on `PATH` works. The link points into the checkout, which must stay in place.

[Create your first comparison](docs/guides/run-benchmark.md). Runs locally on Linux and macOS.

## How It Works

1. **Choose a task.** Describe work from your task tracker. Define what a successful solution must do.
2. **Compare models.** Run different models, or the same model at different reasoning efforts, from the same starting commit in separate workspaces.
3. **Inspect the results.** Compare which solutions pass your checks, their execution time, and their cost. Review qualitative criteria yourself.

Start with one task and grow your benchmark as you learn which comparisons matter to your team.

## Documentation

[Guides and reference](docs/README.md) cover setup, configuration, commands, and results.

## License

[Apache License 2.0](LICENSE)
