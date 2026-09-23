# Configuration reference

tevu reads UTF-8 YAML with `version: 1`. Unknown fields are rejected at every level. `--config` selects the file; its default is `tevu.yaml`.

## Example

This template compares two effort variants on one task using manual checks. The repository path, commit, model identifier, variants, and credential-variable name are illustrative values, not a ready-to-run configuration. The [benchmark guide](../guides/run-benchmark.md) covers setup for a real task.

```yaml
version: 1
artifacts:
  directory: ../tevu-runs
execution:
  concurrency: 2
  caseTimeoutMs: 600000
  terminationGraceMs: 3000
  opencodeEnvironment:
    - name: OPENAI_API_KEY
      classification: provider-credential
  evaluatorEnvironment: []
opencode:
  executable: opencode
repositories:
  - id: app
    path: ../your-app
contenders:
  - id: low
    model: openai/your-model
    variant: low
  - id: high
    model: openai/your-model
    variant: high
tasks:
  - id: csv-export
    repositoryId: app
    startCommit: "0123456789abcdef0123456789abcdef01234567"
    source:
      kind: manual
      title: Export the current view as CSV
    description: Users need to download the visible table as a CSV file.
    prompt: Add a CSV export button to the table view.
    definitionOfReady:
      - id: requirements
        description: The expected columns and escaping rules are defined.
        confirmed: true
    acceptanceCriteria:
      - id: csv-content
        description: The CSV contains the visible rows and correctly escapes values.
        required: true
        evaluator:
          kind: manual
    definitionOfDone:
      - id: docs
        description: The export action is documented for users.
        required: true
        evaluator:
          kind: manual
```

## Top-level fields

| Field | Contract |
| --- | --- |
| `version` | Must be `1` |
| `artifacts.directory` | Output directory, outside and non-overlapping with configured repositories after resolving symlinks |
| `execution.concurrency` | Integer from 1 through 32 |
| `execution.caseTimeoutMs` | Positive integer milliseconds for the managed agent run; a timed-out case skips acceptance checks |
| `execution.terminationGraceMs` | Positive integer milliseconds between graceful and forced process-group termination |
| `execution.opencodeEnvironment` | Variables passed to the agent, declared by name and classification |
| `execution.evaluatorEnvironment` | Ordinary variables available to acceptance commands through per-check allowlists |
| `opencode.executable` | Non-empty executable name or path; no agent-version constraint is accepted |
| `jira` | Optional Jira Cloud connection settings |
| `repositories` | At least one `{id, path}` entry |
| `contenders` | At least two `{id, model, variant}` entries |
| `tasks` | At least one task |

Paths resolve relative to the configuration file. Bare executable names are found through `PATH`. IDs start with a lowercase letter, contain lowercase letters, digits, or hyphens, and have at most 64 characters. IDs are unique within their collection.

A contender is one model/effort combination. `model` uses `provider/model` syntax and `variant` is non-empty. Different contenders may use the same model. The provider determines which model identifiers and variants are supported.

## Tasks

| Field | Contract |
| --- | --- |
| `id` | Unique task ID |
| `repositoryId` | An ID from `repositories` |
| `startCommit` | A commit resolvable in that repository; the wizard records the resolved commit |
| `source` | A manual source or saved Jira snapshot |
| `description` | Non-whitespace task description |
| `prompt` | Non-whitespace instructions for the model |
| `definitionOfReady` | At least one `{id, description, confirmed: true}` prerequisite |
| `acceptanceCriteria` | Checks for the solution; at least one must be required |
| `definitionOfDone` | Completion checks; at least one must be required |

A manual source has `kind: manual`, `title`, and an optional `reference`.

A Jira snapshot has `kind: jira-cloud`, `issueKey`, `issueUrl`, `importedAt`, `importedSummary`, and `importedDescription`. The wizard fills these from a one-time import. Later changes in Jira do not update the task.

### Source trees

The configured source repository is read-only to tevu. Each case receives a sealed repository with one synthetic root commit containing the tracked tree at `startCommit`. Dirty and untracked source-worktree files are excluded.

The case contains no source remotes, later history, tags, stashes, or shared object database. Sibling cases have separate Git metadata and writable directories. The original repository and commit identity are retained separately from the synthetic commit.

Submodules and Git LFS sources are unsupported. Project instructions tracked at the pinned commit remain task context. The [isolation explanation](../concepts/isolation.md) covers why these boundaries matter to a comparison.

## Checks

Each check has `id`, `description`, `required`, and `evaluator`. Check IDs are unique across both check collections within a task. All contenders for a task receive the same checks.

`evaluator.kind: manual` requires a verdict through `tevu assess`. A command evaluator has the following fields:

| Field | Contract |
| --- | --- |
| `kind` | `command` |
| `argv` | Non-empty array: executable followed by literal arguments |
| `timeoutMs` | Positive integer milliseconds |
| `successExitCodes` | Non-empty array of integer exit codes |
| `environmentAllowlist` | Optional array of names from `execution.evaluatorEnvironment`; defaults to `[]` |

For example, a task whose target repository uses `npm test` can define:

```yaml
id: tests
description: The target repository's test suite passes.
required: true
evaluator:
  kind: command
  argv: [npm, test]
  timeoutMs: 120000
  successExitCodes: [0]
  environmentAllowlist: []
```

Commands run sequentially in the case workspace. Arguments are passed directly, without a shell. A target task's test command is independent of tevu's own product-test runner. The solution patch is captured before checks run.

## Environment variables

Environment entries contain `name` and `classification`, never a value:

| Classification | Agent environment | Acceptance-command environment |
| --- | --- | --- |
| `provider-credential` | Allowed | Not allowed |
| `secret` | Allowed, redacted from saved/displayed evidence | Not allowed |
| `ordinary` | Allowed | Allowed only when declared for evaluators and selected by the check |

Provider credentials are also redacted. A variable name cannot appear in both environment collections. Names must be unique within each collection. Every declared variable must be present in the launching environment.

`PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `CI`, and all `XDG_*` names are supplied by tevu and cannot be configured in these lists. Evaluators receive the fixed environment below, plus only their allowlisted ordinary values.

### Fixed evaluator environment

| Variables | Value |
| --- | --- |
| `PATH` | Run-level snapshot of the parent's executable search path |
| `HOME` | Per-case evaluator home |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME` | Directories under the evaluator home |
| `TMPDIR` | Per-case evaluator temporary directory |
| `LANG`, `LC_ALL` | `C.UTF-8` |
| `CI` | `1` |

No other parent variables are inherited. Sequential checks reuse these directories. Evaluator home, state, and temporary directories are separate from the agent's directories.

Agent processes receive the same fixed variable names with their own per-case home, state, and temporary directories, plus the variables declared in `opencodeEnvironment`. Host agent sessions, global configuration, caches, and login stores are not copied.

## Jira Cloud

| Field | Contract |
| --- | --- |
| `jira.baseUrl` | HTTPS site URL |
| `jira.emailEnvironmentVariable` | Name of the variable holding the account email |
| `jira.tokenEnvironmentVariable` | Name of the variable holding the API token |

Neither Jira credential variable may appear in `evaluatorEnvironment`. Jira import is read-only and uses at most three requests per import, sharing that budget across redirects and retries. Jira Server and Data Center are unsupported.

The [Jira import guide](../guides/import-jira-task.md) describes connection setup and task creation.
