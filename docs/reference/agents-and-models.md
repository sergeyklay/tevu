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

The adapter needs these OpenCode capabilities: the `run`, `export`, and `models` commands, the verbose model listing (`models --verbose`), JSON output, model selection, and effort variants. `tevu validate` probes them. Compatibility is decided by these capabilities, never by the OpenCode version, which is recorded as provenance only. The adapter reports its optional outside-worktree restriction as `unavailable`.

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

`roles` declares models tevu uses for its own work rather than benchmarking. Both roles are optional and independent, and a configuration declaring neither is valid. `roles` accepts only the keys `criteria` and `grader`; `{}` declares neither.

| Field | Contract |
| --- | --- |
| `roles.criteria` | Model that drafts acceptance criteria and a Definition of Done in `tevu task add` |
| `roles.grader` | Model that grades graded checks after each case's checks run. See [Graded checks](checks.md#graded-checks) |
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
```

- Each role is read only by the command that uses it. `tevu run` reads `grader`, once per graded case. `tevu task add` reads `criteria`, and only for a task with a reference solution. No command requires `criteria`; without it the interview asks for criteria by hand. A retry of a criteria draft is another model call.
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

A model that reports no variants accepts no effort value, yet `effort` is required, so an effort on such a model is a warning and never blocks. A model whose listing has no variant data is a warning and `unverified`. When the listing failed or lacks the model, the model finding is already an error and the effort gets no finding of its own.

### Repository configuration

A case agent works in its case worktree, where OpenCode reads `opencode.json`, `opencode.jsonc`, and `.opencode` at the top of the task's base commit. Those can define or disable a variant that a listing in an empty repository cannot show. tevu reads the top-level entries of each task's base commit and counts a task as having repository configuration when one of those three names is among them.

The error for a model entry becomes a warning once every task's base commit has one of those entries at its root. A `.opencode` directory counts whatever it holds, so a repository that commits `.opencode/` only for agents or commands also gets the warning. A model call has no repository, so no task counts for a role.

tevu does not see files `setup.before_agent` writes, or an `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, or `OPENCODE_CONFIG_CONTENT` variable an agent block passes. A variant that only those create is reported as unsupported. To make the listing report it, define the variant in a provider your global configuration defines and copy that provider with `agents.opencode.providers`.

A verified effort covers the listing environment only. A task repository's configuration can still disable or redefine the variant inside its cases.

### Criteria draft

`tevu task add` runs the listing before each criteria draft. A model the agent does not list, or an effort outside a non-empty list of reported variants, ends the draft before the model session starts, and the interview falls back to entering the criteria by hand. An effort that is `unverified`, or `unsupported` for a model that reports no variants, draws a warning and the draft goes ahead.

### Where the check is recorded

`tevu run --dry-run` marks each model entry's effort that is not verified. `run.json` records the check of every model entry and of the grader under `efforts`, and `report.md` shows each effort with its status and reason. See [Artifacts](artifacts.md#run-manifest) and [Results](results.md#cases). Identities keep the configured `effort` string.

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

tevu reads the providers once per `tevu validate` invocation, once per run before the run directory exists (shared by every case and grader call of that run), and once per model call outside a run. A later edit to your configuration reaches nothing already using a reading.

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

A model call is a one-shot use of the agent that runs no case: criteria drafting, grading, and the model listing.

- It uses the agent's own home, state, and temporary directories, the variables of its agent block's `secrets` and `env`, and the copied providers. It gets no evaluator environment.
- Its working directory is an empty Git repository. No configured repository or commit reaches it. The directory is removed when the call ends.
- **Grader prompt**, on stdin: the task's `prompt` and `description`, the `id` and `description` of each graded check, and the solution patch. It never carries a reference solution, a case ID, a run ID, or the model entry that produced the solution.
- **Criteria prompt**: the task's `prompt` and `description` and the reference solution's changes. tevu adds no pull request title or description, commit hash, pull request key or URL, case ID, or run ID. The changes come from GitHub's diff media type for a pull request and from the local repository for a commit.

See [Model access](../concepts/model-access.md) for why calls are shaped this way.
