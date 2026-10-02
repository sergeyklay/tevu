# Model access

Why a case receives your provider definitions but nothing else from your agent setup, and why one-shot model calls run without a task repository or tools.

## Providers cross, the rest of your setup does not

A case agent cannot reach a model whose provider it does not know. If a case were built only from the sealed file tree, it could never use a model served by a provider you configured only in your own OpenCode setup. `agents.opencode.providers` names which of your provider definitions cross into a case. Nothing else does.

tevu reads the named definitions once, before the run starts, and copies the identical result into every case and model call of that run. Like every other fixed variable, the provider definitions are a shared starting condition.

Instructions, MCP servers, permissions, plugins, agents, commands, skills, sessions, and the login store all stay host state. Copying any of them would make runs incomparable in the same way copying your agent home directory would. A copied provider's credential crosses only as a configured secret variable, redacted from every artifact like any other secret. The [copy rules](../reference/agents-and-models.md#copy-rules) decide which definitions are accepted at all.

The copy is readable by the agent, on disk, in the agent's own home. It is context isolation, not a sandbox.

## Model calls get no task repository

Drafting acceptance criteria, grading a solution, and writing the conclusions of the run summary are one-shot model calls. They reuse the same agent adapter and the same private environment shape as a case agent, and differ in what they do not get.

A model call's working directory is an empty Git repository, not a case's sealed worktree. No configured repository or commit reaches it. That keeps two kinds of contamination out:

- **Leakage into the task.** A grader that could read the source repository could find the accepted solution. An empty directory has nothing to find.
- **Ambient instructions.** Agents search upward for project instructions and configuration. A directory that is its own Git top level stops that search, the way a case's sealed repository does at its own worktree.

The prompts are narrow for the same reason. A grader sees the task text, the graded criteria, and the solution patch. It never sees a reference solution, a case ID, a run ID, or which model entry produced the patch, so its verdict cannot depend on who wrote the solution. A criteria draft sees the task text and the reference solution's changes, and tevu adds no identifying metadata to it. The exact contents are in [Model calls](../reference/agents-and-models.md#model-calls).

The summary call sees even less. Its prompt carries the exact names of the model settings, the facts tevu derived from the saved outcomes and measurements, the template sentences, and the grader's rationales as data. It omits the task text, every ID, the repository, the date, and the configuration, so the model can reword a comparison but has nothing to change it with, and tevu rejects a reply that names a number, setting, or leader the facts do not hold.

A model call also gets no tools. tevu sets OpenCode's `OPENCODE_PERMISSION` to `{"*":"deny"}` for the `run` process of every drafting, grading, and summary call, so the model is offered none. A grader that could call a tool could read or change files on the host, and a call that ends in a tool call produces no reply, so it grades nothing. tevu replaces any `OPENCODE_PERMISSION` you pass through the agent block's `env` for model calls only; case agents keep it. Configuration outside tevu can still allow a tool, which tevu detects only after the call. See [Where isolation stops](isolation.md#where-isolation-stops).

A model call runs no check, so it gets no evaluator environment, and its directory is removed when the call ends.

Grading, drafting, and summarizing are separate roles, configured separately, because a model that grades or drafts for its own family can favor solutions shaped like its own. tevu allows the same model in both places and prints a note in the report when that happens. Choosing different families is your decision to make.
