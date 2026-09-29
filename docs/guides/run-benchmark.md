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

For a missing configuration, the wizard first asks for the run settings (output directory, concurrency, agent time limit, stop grace period, check time limit), the `agents.opencode` command and its secret and non-secret variable names, an optional Jira connection, at least one repository, at least two model entries with their reasoning efforts, whether to declare a grader model for graded checks, and whether to declare a criteria model to draft criteria from a reference solution. A question with a default shows it dim, and an empty Enter accepts it: `runs`, `2` concurrent cases, `10m`, `3s`, `5m`, and `opencode`. The setup interview always writes `run.check_timeout`, `5m` unless you type another duration. Each variable list is one answer of names separated by commas, spaces, or both; enter names, not their values, because tevu reads the values from the environment at run time. Export every variable before you start the wizard: a name that isn't set in its terminal is refused, and the question is asked again. The same holds for the API key, Jira, and check variables. The grader's and the criteria model's provider credentials go in the same agent's `secrets` as a case agent's, so declaring either may mean adding a secret variable there too.

The wizard probes the agent command as soon as you enter it, and checks every model you enter, including the grader and criteria models, by listing the models OpenCode resolves in an environment built like a case agent's. When the operator's OpenCode global configuration defines the model's provider, the wizard copies that provider into `agents.opencode.providers` and declares the variables it references as secrets, with no question when the definition names its key variable. It asks for an API key variable only when the definition names none, holds a literal key, or the provider is a built-in one OpenCode did not list. A command or model that fails its check is reported, and Enter tries again with your answer filled in. A built-in provider's model that does not list while a declared variable is unset in the terminal is kept as entered, with a warning; run `tevu validate` with every variable set to check it. A listed model proves that OpenCode declares it, not that the provider answers.

Choose a repository commit from before the task was solved. Describe the task, the instructions for the model, the prerequisites you have checked, the acceptance criteria, and the completion checks. A criterion you write defaults to graded, meaning `roles.grader` grades it against its description after a case's other checks run; a check can also run a command or require your manual verdict instead. Type a command check as you would in a terminal, for example `npm test -- --run`. tevu saves it as typed and runs it through `/bin/sh -c` in the case worktree, where `$VAR` expands only for the fixed evaluator variables and the variables you list for the check. Adding a graded check with no `roles.grader` declared draws a warning in the review, and `tevu validate` and `tevu run` refuse the task until the role is declared. See the [configuration reference](../reference/configuration.md) for the field definitions.

Optionally enter the accepted pull request, from the task's repository or its fork network, or a commit that already holds the accepted solution, as the reference solution. Leave the question empty to add the task exactly as without a reference.

For a pull request, accept the proposed base or override it: when the wizard warns that the pull request conflicts, or that its mergeability is unknown, enter the hash the warning names, the parent of its first commit. Before `tevu validate`, fetch a missing base with the command validation prints, and fetch its branch too, for example `git fetch origin`, because a commit fetched only by hash is on no ref and a later `git gc` can remove it. For a commit, the wizard proposes the commit's parent as the base commit, which you can accept or override; a commit reference must hold the whole solution: for the last commit of a series, its parent already holds the earlier ones, and for a merge, a base among the commits it merged passes. For a long-lived branch merged by squash, enter the squash commit itself as a commit reference, since its first parent becomes the proposed base; never pick a base among a rebase merge's other copies of the same commits.

tevu rejects only a reference commit prefix and, for a pull request, its key and URL form in the agent prompt. Check the prompt for any other hint to the accepted solution, such as a bare `#NUMBER`, the branch name, or the pull request title, and reword the prompt if you find one.

With `roles.criteria` declared and a reference solution entered, the wizard drafts acceptance criteria and a Definition of Done from the task's prompt and description and the reference solution's changes instead of asking for them by hand. Review is mandatory: even an unedited draft needs an explicit accept, because a drafting model tends to favor outcomes shaped like its own family's solutions. Accept the draft, edit an item, remove it, add one of your own, or write the criteria by hand instead; accepting stays blocked while the acceptance criteria list is empty or an item names the reference commit or pull request. A draft may have no Definition of Done item, because the drafting model leaves conditions such as a passing test suite to command checks; the check questions that follow then ask you for at least one. Accepted items are saved as graded checks, exactly like ones written by hand, and a command, a manual, or another graded check can still follow them. A failed drafting call names its cause, such as a model OpenCode cannot find in tevu's environment, and falls back to writing the criteria by hand.

Confirm the final review to write `tevu.yaml`. Press Ctrl-C at any point, or Escape twice at a prompt, to cancel; nothing is written and the configuration stays unchanged. The status line under every open prompt shows `Esc twice or Ctrl-C to exit`. The first Escape replaces it with `Press Esc again to exit`, and the second must follow within 800 ms. The exceptions are the `Add to`, `Item to edit`, and `Item to remove` prompts of the criteria review, where one Escape returns to the review, Ctrl-C still cancels, and the status line shows `Esc to go back · Ctrl-C to exit`.

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

For each case whose task declares a graded check, the report shows the grader's verdict and rationale per check, alongside the grader's own metrics kept separate from the agent's. A pending or `undetermined` grade needs your judgment the same way a manual check does.

For pending manual and graded checks, use the run and case IDs shown in the output. The following IDs are examples; replace them with yours:

```sh
tevu assess 20260923t120000z-a1b2c3 csv-export--high--1
```

The assessment command records your verdicts, including an override of a grader's verdict, and rebuilds the report. To rebuild it again from saved evidence:

```sh
tevu report 20260923t120000z-a1b2c3
```

Confirm that required manual and graded checks now have verdicts. Optional checks remain visible but do not change an otherwise passed task outcome.

## Benchmark a project without a local clone

When you have no local clone of the target repository, log in with `gh auth login` (or `gh auth login --hostname <host>` for a GitHub Enterprise Server host) before running `tevu task add`, then choose "GitHub repository, cloned by tevu" at the repository question and enter `OWNER/REPO` or `https://HOST/OWNER/REPO`. tevu reads the repository with your `gh` login as soon as you enter it and asks again when it can't. It clones it into a directory it owns, under `$XDG_CACHE_HOME/tevu/repositories` or `$HOME/.cache/tevu/repositories`, and fetches every reference-solution and base-commit answer you type as you type it.

`tevu validate` never clones or fetches: with no clone yet, or one missing a commit, it prints a finding naming `tevu run --dry-run` as the fix, without contacting GitHub. `tevu run` and `tevu run --dry-run` clone and fetch whatever the configured tasks still need before validation runs, so `tevu run --dry-run` after a validation finding is usually enough to resolve it.

The managed-clone root holds only what tevu can re-derive from the configuration, so deleting it is always safe: the next `tevu run --dry-run` or `tevu task add` clones and fetches again. See [GitHub repositories](../reference/configuration.md#github-repositories) for the clone layout and the commands that reach the network.

## Troubleshooting

- **Missing variable:** export the variable named in the error in the same terminal, then rerun validation.
- **Unsupported source tree:** choose a commit without submodules or Git LFS content. See the [source-tree reference](../reference/configuration.md#source-trees).
- **Missing agent capability:** check that `agents.opencode.command` points to the intended executable and that it supports the required commands and options.
- **Interactive terminal required:** run `task add` or `assess` with both input and output attached to a terminal.
- **Failed clone or fetch:** for an authentication failure, run `gh auth login` (or `gh auth login --hostname <host>`) and retry. For a TLS or proxy failure against a GitHub Enterprise Server host, set `GIT_SSL_CAINFO` or `HTTPS_PROXY` in the environment that launches tevu instead of the operator's gitconfig, which managed clones never read. A `clone lock already exists` error names the lock directory; remove it once you have confirmed no other tevu command is updating that clone.
- **Case executable only runs in tevu's own environment:** the finding names the variable to declare if the command reads one a case does not already give it. For a version-manager shim, find the real executable's path with your version manager's own command for that, run in the directory where the version applies, then start tevu with that executable's directory before the shim directory on PATH, for example `PATH="/path/to/real/bin:$PATH" tevu validate`.
- **Model not available to the agent:** add a provider from your OpenCode global configuration to `agents.opencode.providers`, with `api_key` set when its key lives in the OpenCode login store; for a built-in provider, declare its credential variable in `agents.opencode.secrets` instead. Compare the exact model identifier against `opencode models` run in your own shell. For a model only a repository's tracked `opencode.json` provides, see the remedy under [Model resolution](../reference/configuration.md#model-resolution).
- **Provider cannot be copied:** the finding names the value at fault. Reference a declared variable as `{env:NAME}` instead of writing a literal credential; for a credential header or an `env` entry, name a variable listed in `agents.opencode.secrets`; remove a `{file:...}` reference, since tevu copies no host file into a case; or set `api_key` instead of writing `options.apiKey` by hand.
- **Provider carries no credential:** set `api_key` to a variable in `agents.opencode.secrets` when the provider's key lives in the OpenCode login store. A provider that genuinely needs no key can ignore the warning.
- **Model listing failed or timed out:** run `<command> models` yourself to see OpenCode's own diagnostic for the failure or the delay.
