# Changelog

All notable changes to tevu are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each version may also carry `Requirements`, `Migration`, and `Known limitations` sections; [RELEASING.md](RELEASING.md#changelog) explains when.

## [Unreleased]

### Fixed

- A damaged or hand-edited run file now makes `tevu report` and `tevu assess` name the file and the first field that does not match; damage such as a malformed case record in `run.json` made them fail with `tevu failed unexpectedly`.

## [0.1.0] - 2026-10-07

This is the first stable release of tevu. It has the same features, requirements, and known limitations as [0.1.0-rc.1](https://github.com/sergeyklay/tevu/releases/tag/v0.1.0-rc.1), and `npm install --global @serghei/tevu` now installs it.

## [0.1.0-rc.1] - 2026-10-07

This is the first release of tevu.

### Added

- `tevu task add` defines a benchmark task interactively and can import its text from a Jira Cloud issue or a GitHub issue.
- A task can record its accepted pull request or commits as a reference solution, and tevu can draft acceptance criteria from it for you to review.
- `tevu run` runs each task with two or more model settings, different models or the same model at different reasoning efforts, from the same starting commit; `tevu run --dry-run` shows the plan without running it.
- `run.repeat` and `tevu run --repeat` run each task and model setting several times, and reports show the median time and cost of the attempts.
- Command, manual, and graded checks decide each case's outcome, and a grader model judges graded checks against their descriptions.
- Before checks run, `checks.restore` resets files the agent changed and `checks.overlay` adds test files the agent's workspace never held.
- `tevu assess` records manual verdicts and overrides a grader's verdict for a saved run.
- Reports compare outcomes, elapsed time, tokens, activity, API errors, and agent-reported cost, next to a one-screen run summary.
- `tevu report` regenerates identical JSON and Markdown reports from a saved run.
- `tevu validate` checks the configuration and the agent's capabilities before a run.
- `tevu config example` prints a commented configuration template.
- Without `--config`, tevu reads `tevu.yaml` from the current directory, then from the user configuration directory.
- Tasks can name a GitHub repository by `OWNER/REPO`; tevu clones and updates it through the GitHub CLI.
- A repository can declare setup commands that run before the agent starts and before checks run, such as installing dependencies.
- Each case starts from a sealed copy of the repository with no later history, in its own workspace, apart from the other cases and from the evaluator.
- Credential values named in the configuration are redacted from every saved file, log, and terminal message.
- `tevu --version` prints the installed version.

### Requirements

- Linux or macOS with Node.js 24 and Git.
- OpenCode for running benchmarks, and Git LFS for repositories that use it.
- The GitHub CLI (`gh`) for GitHub issue imports and GitHub repositories.

### Known limitations

- OpenCode is the only supported coding agent.
- Isolation controls what context a case receives; it is not a sandbox, and an agent with shell access can read other paths on the host. See [Where isolation stops](https://github.com/sergeyklay/tevu/blob/v0.1.0-rc.1/docs/concepts/isolation.md#where-isolation-stops).
- Model metrics cover the agent's root session only, not its child sessions.
- Cost is what the agent reports; when it reports none, the cost is shown as unavailable, never estimated.

[Unreleased]: https://github.com/sergeyklay/tevu/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/sergeyklay/tevu/compare/v0.1.0-rc.1...v0.1.0
[0.1.0-rc.1]: https://github.com/sergeyklay/tevu/releases/tag/v0.1.0-rc.1
