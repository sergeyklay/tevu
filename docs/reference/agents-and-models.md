# Agents and models reference

The `agents`, `models`, and `roles` blocks: the agent adapter, model entries, providers copied from your OpenCode configuration, model resolution, and the model roles tevu uses for its own work.

## Agents

`agents.opencode` is the only agent adapter. A `models[].agent` or `roles.<role>.agent` value must be a key of `agents` and defaults to the first configured key, which today is `opencode`.

| Field | Contract |
| --- | --- |
| `command` | Non-empty executable name or path. No agent-version constraint is accepted |
| `secrets` | Variable names passed to the agent and redacted from every artifact. Default `[]` |
| `env` | Variable names passed to the agent as-is. Default `[]` |
| `providers` | Providers copied from your OpenCode global configuration into every case agent and model call. Default `[]`. See [Providers](#providers) |

See [Environment](environment.md) for the variable rules.

The adapter needs these OpenCode capabilities: the `run`, `export`, and `models` commands, the verbose model listing (`models --verbose`), JSON output, model selection, and effort variants, and, for an agent a declared role names, the [tool denial](#tool-denial-check) of model calls. `tevu validate` probes them. Unlike the other capabilities, the tool denial is not among the capability lines `tevu run --dry-run` prints or the capability reports `run.json` saves; only validation findings and refused calls report it. Compatibility is decided by these capabilities, never by the OpenCode version, which is recorded as provenance only. The adapter reports its optional outside-worktree restriction as `unavailable`.

## Model entries

`models` needs at least two entries.

| Field | Contract |
| --- | --- |
| `id` | Unique identifier |
| `model` | `provider/model` syntax, both parts non-empty. Different entries may share a `model` |
| `effort` | Non-empty. Passed verbatim as OpenCode's `--variant` argument, so it must name a variant the agent reports for the model. `tevu validate` checks it; see [Effort check](#effort-check) |
| `agent` | Optional key of `agents` |

Which identifiers and efforts work depends on the provider. `tevu validate` checks that the agent resolves each entry's model and reports its effort as a variant; see [Model resolution](#model-resolution) and [Effort check](#effort-check).

## Model roles

`roles` declares models tevu uses for its own work rather than benchmarking. Every role is optional and independent, and a configuration declaring none is valid. `roles` accepts only the keys `criteria`, `grader`, and `summary`; `{}` declares none.

| Field | Contract |
| --- | --- |
| `roles.criteria` | Model that drafts acceptance criteria and a Definition of Done in `tevu task add` |
| `roles.grader` | Model that grades graded checks after each case's checks run. See [Graded checks](checks.md#graded-checks) |
| `roles.summary` | Model that rewords the three conclusions of `summary.md` at the end of `tevu run`. See [The summary model](results.md#the-summary-model) |
| `roles.<role>.model` | `provider/model`, the same grammar as `models[].model` |
| `roles.<role>.effort` | Non-empty string passed verbatim as `--variant`. `tevu validate` checks it; see [Effort check](#effort-check) |
| `roles.<role>.agent` | Optional key of `agents`, default the first configured key |

```yaml
roles:
  criteria:
    model: anthropic/your-drafting-model
    effort: high
  grader:
    model: openai/your-grader-model
    effort: medium
  summary:
    model: openai/your-summary-model
    effort: medium
```

- Each role is read only by the command that uses it. `tevu run` reads `grader` for every graded case, in up to three calls per case. `tevu task add` reads `criteria`, and only for a task with a reference solution. No command requires `criteria`; without it the interview asks for criteria by hand. A retry of a criteria draft is another model call. Only `tevu run` reads `summary`, once per task at its end and without a retry; `tevu assess` and `tevu report` never do, and no command requires it.
- A role's provider credential belongs in its agent block's `secrets`. Every case agent of that block receives the same credential, so a role on a provider no model entry uses still exposes its credential to every benchmarked case agent.
- The same model may serve a role and a model entry. The report prints an informational note when the grader model is also a benchmarked model entry.
- Neither the loader nor `tevu validate` checks a role's credential value. A missing credential fails the call at run time.

## Model resolution

`tevu validate` lists the models the agent resolves with `<command> models --verbose`, in an environment built like a case agent's: its own home, the agent's declared variables, the copied providers, and an empty Git repository as working directory. No model session starts, though the listing may reach the network on its own. Then it reports each model entry and role whose model is not among them:

| Item | Unresolved model is |
| --- | --- |
| Model entry | Always an error |
| `roles.grader` | An error when a configured task declares a graded check, otherwise a warning |
| `roles.criteria` | Always a warning |
| `roles.summary` | Always a warning |

`tevu run` and `tevu run --dry-run` run this check through their own validation. The setup interview of `tevu task add` runs the same listing for each model it asks and refuses a model the agent does not list.

A listed model proves that OpenCode declares it, not that the provider answers. A wrong base URL or key still lists.

The listing runs in an empty repository. A provider that only a task's tracked `opencode.json` defines or disables is invisible to it, and a model entry or role that depends on such a provider is reported as unresolved. Define the provider in `agents.opencode.providers` as well.

## Effort check

The same listing carries the evidence for efforts. `<command> models --verbose` prints each model's record, including its `variants`, after OpenCode applies its built-in variants, your configuration, and `disabled` filtering. tevu passes `effort` as `--variant`, and OpenCode looks that name up as a key of the model's variants. A name that is not a key merges no options, so the model runs with its default options and the case still reports the requested effort. `tevu validate` therefore compares each model entry's effort and each declared role's effort with the variants the listing reports for its model, verbatim, without trimming or case folding.

| Status | Meaning |
| --- | --- |
| `verified` | The effort is one of the reported variants |
| `unverified` | tevu could not decide, and the effort is used as requested. Causes: the agent produced no listing, the listing lacks the model, the listing has no variant data for the model, or a task repository may define the variant |
| `unsupported` | The effort is not among the reported variants, and nothing tevu can see defines it. OpenCode runs the model with its default options |

The findings, at `models.<id>.effort` and `roles.<role>.effort`:

| Item | Effort outside the reported variants | Severity |
| --- | --- | --- |
| Model entry | At least one task's base commit has no [repository configuration](#repository-configuration), and the model reports variants | Error |
| Model entry | At least one task's base commit has no repository configuration, and the model reports no variants | Warning |
| Model entry | Every task's base commit has repository configuration | Warning, `unverified` |
| `roles.grader` | The model reports variants, and a configured task declares a graded check | Error |
| `roles.grader` | The model reports variants and no configured task declares a graded check, or it reports none | Warning |
| `roles.criteria` | Always | Warning |
| `roles.summary` | Always | Warning |

A model that reports no variants accepts no effort value, yet `effort` is required, so an effort on such a model is a warning and never blocks. A model whose listing has no variant data is a warning and `unverified`. When the listing failed or lacks the model, the model finding is already an error and the effort gets no finding of its own.

### Repository configuration

A case agent works in its case worktree, where OpenCode reads `opencode.json`, `opencode.jsonc`, and `.opencode` at the top of the task's base commit. Those can define or disable a variant that a listing in an empty repository cannot show. tevu reads the top-level entries of each task's base commit and counts a task as having repository configuration when one of those three names is among them.

The error for a model entry becomes a warning once every task's base commit has one of those entries at its root. A `.opencode` directory counts whatever it holds, so a repository that commits `.opencode/` only for agents or commands also gets the warning. A model call has no repository, so no task counts for a role.

tevu does not see files `setup.before_agent` writes, or an `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, or `OPENCODE_CONFIG_CONTENT` variable an agent block passes. A variant that only those create is reported as unsupported. To make the listing report it, define the variant in a provider your global configuration defines and copy that provider with `agents.opencode.providers`.

A verified effort covers the listing environment only. A task repository's configuration can still disable or redefine the variant inside its cases.

### Criteria draft

`tevu task add` runs the listing before each criteria draft. A model the agent does not list, or an effort outside a non-empty list of reported variants, ends the draft before the model session starts, and the interview falls back to entering the criteria by hand. An effort that is `unverified`, or `unsupported` for a model that reports no variants, draws a warning and the draft goes ahead.

### Where the check is recorded

`tevu run --dry-run` marks each model entry's effort that is not verified. `run.json` records the check of every model entry and of the grader under `efforts`, and none for `roles.summary`, and `report.md` shows each effort with its status and reason. See [Artifacts](artifacts.md#run-manifest) and [Results](results.md#cases). Identities keep the configured `effort` string.

## Providers

`agents.opencode.providers` names providers your own OpenCode global configuration defines, so a case agent and a model call can reach a model that provider serves.

| Field | Required | Contract |
| --- | --- | --- |
| `providers[].id` | Yes | Non-empty string without `/`. A key of the `provider` map in your OpenCode global configuration. Unique within the list |
| `providers[].api_key` | No | A variable name listed in the same block's `secrets`, written as the provider's API key |

```yaml
agents:
  opencode:
    command: opencode
    secrets:
      - ACME_KEY
    providers:
      - id: acme-proxy
        api_key: ACME_KEY
```

### Reading your configuration

tevu reads `$XDG_CONFIG_HOME/opencode` when `XDG_CONFIG_HOME` is set, non-empty, and absolute, otherwise `$HOME/.config/opencode`. In it, `config.json`, `opencode.json`, and `opencode.jsonc` load in that order. Later files win: objects merge, and arrays and scalars replace. Every file is fully parsed, so an unparseable file or a non-object `provider` map is an error even when the named provider is fine. Only the named providers' definitions are kept. Instructions, MCP servers, permissions, plugins, agents, commands, skills, and the login store are never copied.

tevu reads the providers once per `tevu validate` invocation, once per run before the run directory exists (shared by every case and grader call of that run), once per model call outside a run, and once per summary call. A later edit to your configuration reaches nothing already using a reading.

### What a case receives

The collected definitions become the entire content of `opencode/opencode.json` under the case agent's own `XDG_CONFIG_HOME`: one file holding exactly `{"provider": {...}}`. `run.json` records the SHA-256 of every file tevu writes into an agent's homes, never its text. `run.json` also records which models each copied definition defines a price for; see [Metrics](results.md#metrics).

### Copy rules

tevu checks every definition before it reaches a case:

- A value at a key named `apiKey`, or a string value at a key whose name reads as a credential, must be exactly one `{env:NAME}` reference naming a variable in `secrets`. The host value is never copied. A key reads as a credential when, ignoring case, it contains `api key` (with an optional separator character), `secret`, `password`, `credential`, or `private key`, or ends in `token`, `authorization`, or `cookie`.
- Every value in a `headers` map, at any depth, must hold at least one `{env:NAME}` reference. In a credential-named header every reference must name a `secrets` variable.
- No value may hold a `{file:...}` reference. tevu copies no host file into a case.
- An ordinary reference must name a variable listed in `secrets` or `env`.
- The definition's root `env` list must not name a variable listed in `agents.<agent>.env`.
- `api_key`, when set, replaces the definition's `options.apiKey` with a reference to the named variable and discards the host value without reading it.
- Every other value is copied as written and reaches the case agent unredacted. A credential under a key name no rule matches belongs in a `secrets` variable, not in your OpenCode configuration.

A definition that checks cleanly but references no `secrets` variable draws a warning naming the provider. tevu cannot tell a provider that needs no key from one whose key sits in the OpenCode login store. Set `api_key` when the key is in the login store; a provider that needs no key can ignore the warning.

### Setup interview

For each model it asks, `tevu task add` takes the provider from the text before the first `/`. When your global configuration defines it, the interview copies it and declares every variable the definition references in `secrets`. When the definition names no key variable or holds a literal `options.apiKey`, the interview asks for the variable that holds the key and writes it as `api_key`. A provider your configuration does not define needs no copy.

## Model calls

A model call is a one-shot use of the agent that runs no case: criteria drafting, grading, summary writing, and the model listing.

- It uses the agent's own home, state, and temporary directories, the variables of its agent block's `secrets` and `env`, and the copied providers. It gets no evaluator environment.
- Its working directory is an empty Git repository. No configured repository or commit reaches it. The directory is removed when the call ends.
- Its `run` process, for drafting, grading, and summary calls alike, receives `OPENCODE_PERMISSION` set to `{"*":"deny"}`, so the model is offered no tool, and [the tool denial check](#tool-denial-check) confirms before the call that OpenCode applies it. The value replaces any `OPENCODE_PERMISSION` the agent block's `env` passes. Case agents and the model listing keep the environment described above.
- A call fails with the cause `tool-call` when its saved session holds a tool call, which catches a tool the tool denial check could not see, and with the cause `unfinished` when the model's last message ended without the finish reason `stop`, for example because it hit a length limit. The criteria wizard prints the call's own reason for both. A grader call that fails with `unfinished` is made again; see [Graded checks](checks.md#graded-checks).
- **Grader prompt**, on stdin: the task's `prompt` and `description`, the `id` and `description` of each graded check, and the solution patch. It never carries a reference solution, a case ID, a run ID, or the model entry that produced the solution.
- **Summary prompt**: the exact names of the task's model settings, the facts of the comparison as JSON, the template sentences, and the grader's saved rationales for the task, fenced as data. It carries no task `prompt` or `description`, check ID, case ID, run ID, repository, path, date, or configuration. See [The summary model](results.md#the-summary-model).
- **Criteria prompt**: the task's `prompt` and `description` and the reference solution's changes. tevu adds no pull request title or description, commit hash, pull request key or URL, case ID, or run ID. The changes come from GitHub's diff media type for a pull request and from the local repository for a commit.

### Tool denial check

Before each drafting, grading, and summary call, and in `tevu validate` for each agent a declared role names, tevu runs `<command> debug config` and reads the configuration OpenCode resolves. The process runs in a model call's environment, with `OPENCODE_PERMISSION` set as for the call's `run` process, so it sees the configuration the call would. No model session starts. The command can use the network on its own, for example to install a plugin the configuration names, which the call's `run` then reuses. It ends within 120 seconds, a limit that does not count against `run.timeout`. Case agents and the model listing get no check.

The output shows every tool denied when all of these hold:

- In `permission`, `*` is `deny` and so is every key after it. A key before `*` does not matter. A value of `ask`, `allow`, an object, or a masked `***` fails.
- Every key in the `permission` of the agent `run` uses is `deny`. That agent is `default_agent` when the output has one, else `build`. A `build` agent that is disabled, hidden, or a subagent, with no `default_agent`, fails, because the agent of a model call is then unknown.

Any other output fails, including output that is not one JSON object and a `permission`, `default_agent`, or `agent` field of a shape tevu does not read. The reason names the first key or field that failed.

| Result | In `tevu validate` | Before a call |
| --- | --- | --- |
| Every tool is denied | No finding | The call starts |
| The output does not show every tool denied | The finding `capability "model call tool denial" is missing: <reason>`, which ends with the roles whose calls are refused before they start | The call is refused with the same text |
| `debug config` fails or does not finish: it cannot start, exits with a nonzero code, is terminated by a signal, exceeds 120 seconds, prints more than 16 MiB, or prints output tevu cannot read to its end | The finding `capability "model call tool denial" could not be checked: <reason>`, which ends with the roles whose calls repeat the check and are refused unless it shows the denial | The call is refused with the same text |

The finding is an error when `roles.grader` names the agent and a configured task declares a graded check, and a warning otherwise. A warning does not let a call through: each call repeats the check and is refused unless it shows the denial.

A refused call starts no `run` process and fails as any model call does:

| Role | Effect of a refused call |
| --- | --- |
| `roles.grader` | The grader call is recorded as `no-reply` with the cause `other`, and the case's graded checks stay pending |
| `roles.summary` | The conclusions stay the template sentences, and the footnote of `report.md` gives the reason |
| `roles.criteria` | The wizard reports that it could not draft criteria, gives the reason, and offers to draft again |

The check reads the configuration OpenCode reports. An executable that reports the denial but does not apply it, or configuration that changes between the check and the call, is found only after the call; see [Where isolation stops](../concepts/isolation.md#where-isolation-stops).

See [Model access](../concepts/model-access.md) for why calls are shaped this way.
