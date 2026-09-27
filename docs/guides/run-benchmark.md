# How to run your first comparison

Compare at least two model settings on a task from your backlog, using either its local Git repository or a GitHub repository tevu clones for you.

## Prepare the tools

Use Linux or macOS with Node.js 24, Git, and OpenCode installed. The current agent adapter uses OpenCode's `run` and `export` commands, JSON output, model selection, and effort variants. Compatibility is checked by those capabilities, not a fixed OpenCode version.

Choose a model and effort variant supported by your configured provider. Make its credential environment variables available in the terminal that will launch tevu. tevu uses isolated agent state, so credentials stored only in your usual agent login are not copied into benchmark runs.

From the tevu checkout, with Bun installed, install dependencies, build, and link the command:

```sh
bun install --frozen-lockfile
bun run build
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/index.js" ~/.local/bin/tevu
tevu --help
```

`tevu` runs with the `node` on `PATH`, which must be Node.js 24 in every directory where `tevu` is used. The link points into the checkout, which must stay in place. After updating the checkout, rerun `bun install --frozen-lockfile` and `bun run build`. If the shell cannot find `tevu`, add `~/.local/bin` to `PATH` or link into another directory on `PATH`. Run the remaining commands in this guide from the directory that holds, or will hold, `tevu.yaml`, or from any directory once the configuration lives in the user configuration file; see the [configuration reference](../reference/configuration.md#top-level-fields) for why the user file favors absolute paths.

## Define a task

To write the configuration by hand instead of answering the setup interview, start from `tevu config example > tevu.yaml`; see the [configuration reference](../reference/configuration.md#example).

Run the wizard in an interactive terminal:

```sh
tevu task add
```

For a missing configuration, the wizard first asks for the run settings (output directory, concurrency, time limits), the `agents.opencode` command and its secret and ordinary variable names, an optional Jira connection, at least one repository, and at least two model entries with their reasoning efforts. Enter variable names, not their values; tevu reads the values from the environment at run time.

Choose a repository commit from before the task was solved. Describe the task, the instructions for the model, the prerequisites you have checked, the acceptance criteria, and the completion checks. A check can run a command or require your manual verdict. See the [configuration reference](../reference/configuration.md) for the field definitions.

Optionally enter the accepted pull request, from the task's repository or its fork network, or a commit that already holds the accepted solution, as the reference solution. Leave the question empty to add the task exactly as without a reference.

For a pull request, accept the proposed base or override it: when the wizard warns that the pull request conflicts, or that its mergeability is unknown, enter the hash the warning names, the parent of its first commit. Before `tevu validate`, fetch a missing base with the command validation prints, and fetch its branch too, for example `git fetch origin`, because a commit fetched only by hash is on no ref and a later `git gc` can remove it. For a commit, the wizard proposes the commit's parent as the base commit, which you can accept or override; a commit reference must hold the whole solution: for the last commit of a series, its parent already holds the earlier ones, and for a merge, a base among the commits it merged passes. For a long-lived branch merged by squash, enter the squash commit itself as a commit reference, since its first parent becomes the proposed base; never pick a base among a rebase merge's other copies of the same commits.

tevu rejects only a reference commit prefix and, for a pull request, its key and URL form in the agent prompt. Check the prompt for any other hint to the accepted solution, such as a bare `#NUMBER`, the branch name, or the pull request title, and reword the prompt if you find one.

Confirm the final review to write `tevu.yaml`. Cancelling leaves the configuration unchanged.

For a Jira source, use the [Jira import guide](import-jira-task.md) when adding the task, then continue with validation below.

## Validate and preview

```sh
tevu validate
tevu run --dry-run
```

Validation first prints `Configuration: <path>`, the absolute path of the file tevu found, then `Configuration is valid.` The preview lists every task/model pair, the starting commits, execution limits, and the output directory. Neither command starts a model session.

## Run and review

```sh
tevu run
```

This command starts model sessions and can incur provider charges. Open the `report.md` path printed when the run finishes. Check task outcomes separately from runtime errors, then compare the available time, usage, and cost measurements. See the [results reference](../reference/results.md).

For pending manual checks, use the run and case IDs shown in the output. The following IDs are examples; replace them with yours:

```sh
tevu assess 20260923t120000z-a1b2c3 csv-export--high--1
```

The assessment command records your verdicts and rebuilds the report. To rebuild it again from saved evidence:

```sh
tevu report 20260923t120000z-a1b2c3
```

Confirm that required manual checks now have verdicts. Optional checks remain visible but do not change an otherwise passed task outcome.

## Benchmark a project without a local clone

When you have no local clone of the target repository, log in with `gh auth login` (or `gh auth login --hostname <host>` for a GitHub Enterprise Server host) before running `tevu task add`, then choose "GitHub repository, cloned by tevu" at the repository question and enter `OWNER/REPO` or `https://HOST/OWNER/REPO`. tevu clones it into a directory it owns, under `$XDG_CACHE_HOME/tevu/repositories` or `$HOME/.cache/tevu/repositories`, and fetches every reference-solution and base-commit answer you type as you type it.

`tevu validate` never reaches the network: with no clone yet, or one missing a commit, it prints a finding naming `tevu run --dry-run` as the fix, without contacting GitHub. `tevu run` and `tevu run --dry-run` clone and fetch whatever the configured tasks still need before validation runs, so `tevu run --dry-run` after a validation finding is usually enough to resolve it.

The managed-clone root holds only what tevu can re-derive from the configuration, so deleting it is always safe: the next `tevu run --dry-run` or `tevu task add` clones and fetches again. See [GitHub repositories](../reference/configuration.md#github-repositories) for the clone layout and the commands that reach the network.

## Troubleshooting

- **Missing variable:** export the variable named in the error in the same terminal, then rerun validation.
- **Unsupported source tree:** choose a commit without submodules or Git LFS content. See the [source-tree reference](../reference/configuration.md#source-trees).
- **Missing agent capability:** check that `agents.opencode.command` points to the intended executable and that it supports the required commands and options.
- **Interactive terminal required:** run `task add` or `assess` with both input and output attached to a terminal.
- **Failed clone or fetch:** for an authentication failure, run `gh auth login` (or `gh auth login --hostname <host>`) and retry. For a TLS or proxy failure against a GitHub Enterprise Server host, set `GIT_SSL_CAINFO` or `HTTPS_PROXY` in the environment that launches tevu instead of the operator's gitconfig, which managed clones never read. A `clone lock already exists` error names the lock directory; remove it once you have confirmed no other tevu command is updating that clone.
