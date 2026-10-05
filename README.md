<h1 align="center">tevu</h1>

<div align="center">

**Benchmark coding models on your real tasks.**

Find which models finish your tasks, how long they take, and what they cost.

[Get started](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/docs/getting-started/first-comparison.md) · [Documentation](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/docs/README.md)

</div>

## The Problem

Public benchmarks don't tell you which coding model can finish your team's backlog, or whether a cheaper model can do the same work. Finding out means giving models the same starting point, checking their solutions, and tracking time and cost. Doing that by hand becomes a project of its own.

tevu runs that comparison on tasks from your own task tracker.

## Works With

**Issue trackers:** GitHub Issues and Jira.

**Coding agents:** OpenCode.

## Install

With Node.js 24 and Git:

```sh
npm install --global tevu
tevu --version
```

Update with `npm install --global tevu@latest` and remove with `npm uninstall --global tevu`. Release candidates are on the `next` channel: `npm install --global tevu@next`. If npm fails with `EACCES`, see [Install tevu](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/docs/getting-started/installation.md#1-install-the-package); don't use `sudo`.

To work on tevu itself, see [CONTRIBUTING.md](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/CONTRIBUTING.md).

Without `--config`, tevu reads `tevu.yaml` from the current directory, or otherwise the configuration file in the user configuration directory; see the [CLI reference](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/docs/reference/cli.md) for the search order.

[Create your first comparison](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/docs/getting-started/first-comparison.md). Runs locally on Linux and macOS.

## How It Works

1. **Choose a task.** Describe work from your task tracker. Define what a successful solution must do.
2. **Compare models.** Run different models, or the same model at different reasoning efforts, from the same starting commit in separate workspaces.
3. **Inspect the results.** Compare which solutions pass your checks, their execution time, and their cost. Review qualitative criteria yourself.

Start with one task and grow your benchmark as you learn which comparisons matter to your team.

## Documentation

[Guides and reference](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/docs/README.md) cover setup, configuration, commands, and results.

## License

[Apache License 2.0](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/LICENSE)
