# Troubleshoot common failures

Fixes for errors that `tevu task add`, `tevu validate`, and `tevu run` report. Each entry names the symptom, then the fix.

## Missing variable

A declared variable is not set. Export the variable named in the error in the same terminal, then rerun the command. In `tevu task add`, the wizard refuses an unset name and asks again.

## Interactive terminal required

`tevu task add` and `tevu assess` exit with `prerequisite "terminal" is not satisfied` when input or output is not a terminal. Run them with both attached to a terminal.

## Unsupported source tree

The starting commit's tree holds a submodule, or a Git LFS pointer that uses Git LFS extensions. Choose a commit without them. The wizard inspects the base commit as soon as you enter it and asks again with your answer filled in. See [Source trees](../reference/repositories.md#source-trees).

## Missing Git LFS objects

The finding names the missing objects.

- When it says Git LFS is not installed, install it from https://git-lfs.com.
- For a local repository, run the `git lfs fetch` command the finding prints in that repository, with the remote that holds the objects.
- For a GitHub repository, run `tevu run --dry-run` to fetch them. Run `gh auth login` first when the failure names authentication.
- When the failure says the repository does not have the objects, or that the fetch finished without them, choose another base commit.
- For `does not match its pointer`, delete the file the finding names and fetch again.

In `tevu task add`, fix the cause and press Enter to retry. See [Git LFS content](../reference/repositories.md#git-lfs-content).

## Clone or fetch fails

- **Authentication.** Run `gh auth login`, or `gh auth login --hostname <host>` for GitHub Enterprise Server, and retry.
- **TLS or proxy, on Enterprise Server.** Set `GIT_SSL_CAINFO` or `HTTPS_PROXY` in the environment that launches tevu. Managed clones ignore your Git configuration.
- **`clone lock already exists`.** The error names the lock directory. Confirm no other tevu command is updating that clone, then remove the directory.

## Case executable only runs in tevu's own environment

The finding names the executable. If the command reads a variable a case does not already give it, declare that variable in `env` or `setup.env`.

For a version-manager shim, find the real executable's path with your version manager's own command, run in the directory where the version applies. Then start tevu with that directory before the shim directory on `PATH`:

```sh
PATH="/path/to/real/bin:$PATH" tevu validate
```

## Missing agent capability

Check that `agents.opencode.command` points to the intended executable and that it supports the `run`, `export`, and `models` commands and the options tevu uses. See [Agents](../reference/agents-and-models.md#agents). For `capability "model call tool denial"`, see [Model call tool denial missing](#model-call-tool-denial-missing).

## Cost unavailable because the agent has no price for a model

The report shows a model's cost, or the grader's cost, as unavailable, while tokens, time, and outcomes are present. The agent reported a cost of zero for a model it has no price for, and tevu did not count that zero as a measurement. Give the agent the model's prices, as described in [Give the agent the model's prices](configure-model-access.md#give-the-agent-the-models-prices), and run again.

With OpenCode, the reason appears after `Technical detail:` in the footnote as `the copied definition of provider "<provider>" defines no price for model "<model>"`: the provider definition in your OpenCode global configuration has no `cost` for that model.

## Grading model asked to use a tool

`report.md` or `tevu assess` says `the grading model asked to use a tool, which grading does not allow`, and every graded check of the case is pending. tevu starts every model call with every tool denied and checks before the call that OpenCode reports the denial, so the call's session holds a tool call only when something the check could not see allowed a tool again, such as an executable that reports the denial and does not apply it. See [Model call tool denial missing](#model-call-tool-denial-missing) for the sources of a tool grant.

Remove the rule or narrow it so that it no longer allows a tool, then record the verdicts with `tevu assess <run-id> <case-id>` or run the task again. The tool may already have run when tevu noticed it, so look at the saved session in the case's `grading.json` before you trust the host's files. tevu does not call the grader again after a tool call.

## Model call tool denial missing

`tevu validate` reports `capability "model call tool denial" is missing: ...`, or a drafting, grading, or summary call fails with the same text. OpenCode's `debug config` did not show every tool denied, so tevu refuses the call before it starts. The finding is an error when `roles.grader` names the agent and a task declares a graded check, and a warning otherwise. A warning still refuses the calls it names.

The reason quotes the first key or field that failed, for example `lists "bash" after "*" in "permission" with a value other than "deny"`. Search the configuration OpenCode reads for that key. These sources can allow a tool:

- an `agent.<name>.permission` block, or a top-level `permission` block that lists `*` before the tool, in the configuration an agent block passes through `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, or `OPENCODE_CONFIG_DIR`;
- a system-wide OpenCode configuration, such as `/etc/opencode` on Linux;
- a plugin whose `config` hook adds a permission;
- an executable that ignores `OPENCODE_PERMISSION`, which shows no `permission` at all.

Remove the rule or narrow it so that it no longer allows a tool, or point `agents.opencode.command` at an executable that applies the variable. A masked value, a `build` agent that is disabled or hidden with no `default_agent`, and an object value after `*` fail too, even when you meant them to deny; the rule is in [Tool denial check](../reference/agents-and-models.md#tool-denial-check).

When the text says `could not be checked: ...`, `debug config` itself failed, and the reason names how: it could not start, exited with a nonzero code, or did not finish within 120 seconds. A plugin install that cannot reach the registry is a common cause, because the install runs before the command prints and can pass the limit. Fix what the reason names, then validate again. Every call repeats the check, so a configuration that passes validation is checked again before each call.

## Model or provider errors

See [Make a model reachable](configure-model-access.md#fix-a-failure).
