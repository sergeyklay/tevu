# Tasks reference

The `tasks` block of the configuration: fields, the `source` snapshot, the `reference` record, and the rules `tevu validate` and `tevu run` apply to a task's starting commit and prompt.

## Fields

| Field | Contract |
| --- | --- |
| `id` | Unique task ID |
| `title` | Non-whitespace. Shown in the report, never sent to the agent |
| `repo` | An ID from `repositories`. Defaults to the sole repository when exactly one is configured, otherwise required |
| `base_commit` | The commit every case starts from. `tevu task add` writes the full hash. `tevu validate` resolves it in the repository; see [base commit findings](#base-commit-findings) |
| `timeout` | Optional duration. The agent time limit of every case of this task. Replaces `run.timeout` |
| `prompt` | Non-whitespace instructions sent to every model |
| `description` | Non-whitespace task description sent to every model |
| `source` | Absent for a task written by hand, otherwise an import [snapshot](#source) |
| `reference` | Optional [reference solution](#reference) |
| `readiness` | At least one non-whitespace prerequisite you confirmed. Never sent to the agent |
| `checks.restore`, `checks.overlay` | Optional check-state settings; see [Checks](checks.md#restore-and-overlay) |
| `checks.acceptance` | Checks for the solution. At least one must be required |
| `checks.done` | Completion checks. At least one must be required |

The prompt sent to the agent is built from `prompt`, `description`, and the descriptions of the acceptance and done checks. Every model entry of a task receives the same prompt and the same checks.

## Source

`kind` (`jira` or `github`), `key`, `url`, `imported_at`, `title`, and `body` are all required. `url` must be a valid URL and `imported_at` an ISO datetime. `tevu task add --jira` or `--github` fills the block once. Later changes in the tracker never update the task.

## Reference

`reference` records the pull request or commit a task's solution came from. `tevu task add` writes it once.

```yaml
reference:
  kind: pull-request            # pull-request or commit
  identifier: octo/app#128
  commits:
    - "<hash>"
  merge_commit: "<hash>"        # pull-request only, optional
```

| Field | Contract |
| --- | --- |
| `reference.kind` | `pull-request` or `commit` |
| `reference.identifier` | For `commit`, non-whitespace text. For `pull-request`, `OWNER/REPO#NUMBER` or an `https` pull request URL without user info or a port |
| `reference.commits` | Full lowercase commit hashes (40 or 64 hexadecimal characters). `commit`: exactly one. `pull-request`: at least one, all distinct |
| `reference.merge_commit` | `pull-request` only, optional. Must not repeat a hash in `commits` |

### Proposed base commit

`tevu task add` proposes a base commit from the reference. The operator can override it.

For a commit reference, the proposal is the commit's first parent.

For a pull request, the proposal depends on the pull request's state and mergeability. The "first commits" are the pull request commits that have no parent inside the pull request.

| Pull request | Proposed base | Warning |
| --- | --- | --- |
| Merged | Shared parent of the first commits | None |
| Target branch deleted | Shared parent of the first commits | Yes |
| Conflicting | Shared parent of the first commits | Yes |
| Mergeability unknown | Tip of the target branch | Yes |
| Open and mergeable | Tip of the target branch | None |
| Closed and mergeable | Tip of the target branch | Yes, GitHub does not recheck a closed pull request |

When a row uses the shared parent and the first commits do not share exactly one parent, no base is proposed. The reference is still recorded and the operator enters a base.

An accepted target tip is saved as `base_commit` even when the local repository does not hold it. `tevu validate` reports it as missing.

### Base commit findings

`tevu validate` compares the base commit with the recorded reference by hash and ancestry only, never by content, and only with commits available locally. It rejects a base commit that:

- equals a recorded reference commit;
- descends from a recorded pull request commit;
- does not precede the recorded merge commit, or the commit of a commit reference.

A base that holds the solution under another hash passes: another copy from a rebase merge, a cherry-pick, or an equivalent squash on another branch. A commit reference must hold the whole solution in the one commit it names.

An unavailable reference commit draws a warning, once per task, that does not change the exit code:

```text
reference commits not available in repository "<repo id>": <n> of <total>; the base commit was not compared with them
merge commit <7-character prefix> is not available in repository "<repo id>"; the base commit was not checked to precede it
```

For a GitHub repository entry each warning ends with `; tevu run --dry-run fetches them` (`fetches it` for the merge commit). A commit reference draws only the first warning.

A base commit missing from the repository is an error:

```text
error tasks.<id>.base_commit: base commit <hash> is not in repository "<id>" ("<path>"); fetch it there first, for example: git fetch https://<host>/<owner>/<repo>.git <hash>
error tasks.<id>.base_commit: base commit "<base_commit>" is not in the clone of repository "<id>"; tevu run --dry-run fetches it from <host>/<owner>/<repo>
```

The first form applies to a pull request task whose base is a full hash and whose repository is a path entry. The second applies to any task of a GitHub entry.

## Prompt screening

`tevu validate` and `tevu run` reject a task when the prompt sent to the agent contains, in any letter case, any of these as a plain substring:

- the first 7 characters of `base_commit`;
- the first 7 characters of every recorded reference commit and merge commit;
- for a pull request reference, its `OWNER/REPO#NUMBER` key and its `HOST/OWNER/REPO/pull/NUMBER` form.

No other hint to the accepted solution is screened: not a bare `#NUMBER`, a branch name, or a title. The screen reads recorded identifiers only. Neither `validate` nor `run` contacts GitHub to read the pull request, so a repository rename or transfer after the task was added is not followed.

See [Reference solutions](../concepts/reference-solutions.md) for why the screen exists and where it stops.
