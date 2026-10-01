# Repositories reference

The `repositories` block: entry forms, how a source tree becomes a case repository, Git LFS handling, setup commands, and managed GitHub clones.

## Entries

Each entry has an `id` and exactly one of:

- `path`: a local Git repository, resolved against the configuration file.
- `github`: a repository tevu clones itself, see [GitHub repositories](#github-repositories).

An entry may also carry [`setup`](#setup).

## Source trees

Every configured source repository, whether a local path or a managed clone, is read-only to every case. Each case receives a sealed repository: a fresh Git repository with one synthetic root commit that holds the tracked tree at `base_commit`.

- Dirty and untracked files in the source worktree are excluded. Every tracked file, project instruction files included, is part of the tree.
- The case repository has no source remotes, later history, tags, stashes, or shared object database. Sibling cases have separate Git metadata and writable directories.
- The original repository and commit identity are recorded separately from the synthetic commit.
- tevu writes only to a managed clone, and only before cases start. It never writes to a path entry's repository. A `tevu validate` run starts a path entry's case executables in that directory; see [Case executables](environment.md#case-executables).

Unsupported trees are rejected:

- Submodules.
- Git LFS pointer entries that use Git LFS extensions (a pointer with an `ext-` line). Rebuilding their content needs programs named in your own Git configuration, which tevu never reads.

### Git LFS content

A Git LFS pointer entry is a regular-file entry (mode `100644` or `100755`) at `base_commit` whose whole blob is a Git LFS pointer under 1024 bytes: a `version https://git-lfs.github.com/spec/v1` line, an `oid sha256:` line, and a `size` line, each ending in a line feed, and nothing else. The blob decides, not `.gitattributes`: a pointer at a path no `filter=lfs` rule matches is materialized, and a `filter=lfs` path holding ordinary content is sealed unchanged.

In the synthetic root commit each pointer entry holds its object's content at the same path with the same mode. A pointer with `size 0` becomes an empty file and tevu reads no object for it. Every other path matches `base_commit` byte for byte, `.gitattributes` and a tracked root `.lfsconfig` included.

The case repository's configuration holds no `lfs.*`, `filter.*`, `remote.*`, or `credential.*` key. tevu's own patch capture and restore never run Git LFS, so a pointer path is an ordinary tracked file to them.

tevu reads objects only from the repository's own Git LFS storage: the directory `lfs.storage` names in the repository's own configuration (relative values resolve against the common Git directory), or `lfs` inside that directory when unset. Objects sit at `objects/<first two characters of the oid>/<next two>/<oid>`. Global and system Git configuration and other repositories' storage are never read, so an object held only in another repository's storage counts as missing.

- `tevu validate`, `tevu run`, and the `tevu task add` base-commit check require every object to be present with the pointer's size before any case starts. They read no object content.
- Sealing checks each object's SHA-256 against the pointer's `oid`. A mismatch fails that case only.
- Each sealing case reads every object twice and stores it twice, in its case repository and in its worktree. Disk use and sealing time grow with the Git LFS content of `base_commit` and with `run.concurrency`. Memory use does not grow with object size.

Findings (`<path>` is the repository's directory; the `git lfs fetch` command is replaced by `tevu run --dry-run fetches them from <host>/<owner>/<repo>` for a GitHub entry):

```text
repository "<id>": source tree contains <k> Git LFS pointer entries that use Git LFS extensions; tevu cannot rebuild their content
error tasks.<id>.base_commit: repository "<id>": Git LFS objects not in "<path>/.git/lfs/objects": <missing> of <needed>; fetch them in "<path>" first, for example: git lfs fetch -I "" -X "" origin <commit>
repository "<id>": Git LFS object file "<path>/.git/lfs/objects/<xx>/<yy>/<oid>" does not match its pointer; delete the file, then fetch it again in "<path>", for example: git lfs fetch -I "" -X "" origin <commit>
```

For a single extension entry the first message reads `source tree contains 1 Git LFS pointer entry that uses Git LFS extensions; tevu cannot rebuild its content`. When `git lfs version` fails, the missing-objects message names installing Git LFS first.

## Setup

`setup` prepares every case that uses the repository.

| Field | Contract |
| --- | --- |
| `setup.before_agent` | List of commands run once per case after sealing, before the agent starts. `[]` equals an absent key |
| `setup.before_checks` | List of commands run after restore and overlay, before the first check. `[]` equals an absent key |
| `setup.timeout` | Duration. The limit for one setup command. Required whenever `setup` is present, with no fallback to `run.check_timeout` |
| `setup.env` | Variable names passed as-is to this repository's setup commands. Default `[]` |

At least one of `before_agent` and `before_checks` must hold a command. A setup command uses the array form only: a non-empty executable followed by literal string arguments, no shell.

```yaml
setup:
  before_agent: [[npm, ci]]
  before_checks: [[npm, ci]]
  timeout: 5m
  env: [NPM_CONFIG_REGISTRY]
```

A case with `setup` runs these steps in order:

1. Seal the case and build its environments.
2. Run `before_agent` and, on success, record the worktree as the patch base.
3. Run the agent.
4. Capture the solution patch, relative to the patch base when one was recorded, otherwise to the synthetic root commit.
5. Restore and overlay.
6. Run `before_checks`.
7. Run the checks.

- Each setup command runs in the case worktree with the fixed evaluator environment plus `setup.env` (see [Environment](environment.md#fixed-evaluator-environment)). Commands of one phase run sequentially in declared order. No agent secret and no `agents.opencode.env` or `agents.opencode.secrets` value is present.
- `before_agent` is the only phase that runs before the agent. Whatever it leaves in the worktree, the evaluator home, or the evaluator temporary directory is visible to the agent, which can read and change it. Restore reaches only the worktree paths `checks.restore` matches.
- A `setup.env` value is an ordinary variable, not a secret. A command that prints it leaves it unredacted in its phase log, and one written to a file the agent reads reaches the agent. There is no `setup.secrets` key.
- The patch base lives in a private object directory outside the case repository, so `solution.patch` applies to the state `before_agent` left. Output the agent left unchanged never appears in the patch. A path the synthetic root commit lacks and an ignore rule matches, such as `node_modules`, stays out of the base unless the case repository's Git index tracks it. Such a path enters the patch as added only if the agent changes the ignore rules so the rule no longer matches it, or adds the path to that index, for example with `git add --force`.
- A `before_agent` or `before_checks` command that fails, times out, or does not start ends the case with lifecycle `infrastructure-failed` and outcome `not-evaluated`. A `before_agent` failure means the agent never started. A `before_checks` failure means no check ran. A cancellation during either phase ends the case as `cancelled`. See [Artifacts](artifacts.md#repository-setup).
- `restore` can remove `before_agent` output, and a file `before_checks` reads, such as `package.json`, stays editable by the agent unless a restore pattern names it.

`tevu validate` and `tevu run` reject a `setup` block that declares neither phase, an empty command or an empty first argument, a missing `timeout`, and a `setup.env` name that is fixed, duplicated, shared with an agent's `secrets` or `env`, or referenced by a Jira credential.

## GitHub repositories

A `github` value is `OWNER/REPO`, or `https://HOST/OWNER/REPO` for a host other than `github.com`, including GitHub Enterprise Server.

- `OWNER` is a letter or digit followed by up to 99 letters, digits, hyphens, or underscores.
- `REPO` is 1 to 100 letters, digits, dots, hyphens, or underscores, never `.` or `..`. One trailing `.git` is stripped first.
- The URL form takes no user info, port, query, or fragment.

### Managed clone

tevu keeps one bare clone per lowercased `<host>/<owner>/<repo>`, shared by every entry and configuration that names it, at `<root>/<host>/<owner>/<repo>.git`.

- The root is `$XDG_CACHE_HOME/tevu/repositories` when `XDG_CACHE_HOME` is set, non-empty, and absolute, otherwise `$HOME/.cache/tevu/repositories` under the same test. With neither, every command that needs a clone reports a finding naming the unset variable.
- The clone has full history, with no `--depth` and no `--filter`, because sealing borrows objects through a temporary alternates link and reference ancestry checks walk history.
- Its local configuration sets `gc.auto=0` and `maintenance.auto=false`, so a concurrent fetch never drops an object or pack a reader needs, and it holds no `credential` key.
- Deleting the root is always safe. The next command that needs a clone creates it again.
- A clone directory must not equal, lie inside, or contain `run.output_dir`, an overlay directory, or a path entry's directory, after symbolic links are resolved. The managed-clone root itself is compared only with path entries, and only when a `github` entry exists.

### When tevu clones and fetches

- `tevu task add` clones a newly selected entry immediately and fetches base commit and reference answers as they are typed.
- `tevu run` and `tevu run --dry-run` clone or fetch before validation, once per GitHub entry a task names: first base commits, then reference commits, only for what is not already local.
- `tevu validate`, `tevu assess`, `tevu report`, and `tevu config example` never clone or fetch. A missing clone or commit is a validation finding that names `tevu run --dry-run` as the fix.
- A branch or tag name in `base_commit` or a reference is fetched only when it does not already resolve. That fetch force-updates every branch and tag of the remote, so a name can resolve to a different commit across runs. `tevu task add` always writes a full hash for `base_commit`. Pin a full hash to keep a task fixed.

### Git LFS fetch

`tevu task add` (once per base-commit answer), `tevu run`, and `tevu run --dry-run` fetch the Git LFS objects a base commit's tree lacks when the clone does not hold them, and need Git LFS installed (`git lfs version` runs first). The command is `git lfs fetch -I "" -X "" <clone URL> <commit>` in the clone, under the same lock and the same 10-minute limit as a git fetch. The empty `-I` and `-X` clear any include or exclude rule a tracked `.lfsconfig` sets. A fetch that ends without every object fails the command.

The Git LFS endpoint is pinned to `<clone URL>/info/lfs`, whatever a tracked `.lfsconfig` names. This keeps a repository from choosing the host that receives your credentials. A repository whose objects live only on another server therefore cannot be fetched into a managed clone; use a path entry and fetch the objects in your own clone.

### Access and locking

- Access goes through the GitHub CLI. tevu runs git with a command-scoped credential helper, `!gh auth git-credential`, offered only to the entry's host. gh holds the token, and tevu never sees it.
- Every network git command ignores your Git configuration: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point at `/dev/null`. Settings such as `http.sslCAInfo`, `http.proxy`, and `url.<base>.insteadOf` have no effect. TLS and proxy behavior come from `GIT_SSL_*`, `GIT_HTTP_*`, `GIT_PROXY_SSL_*`, and proxy variables such as `HTTPS_PROXY`, which pass through unlike other `GIT_*` variables.
- A clone or fetch holds a lock directory, the clone's path with `.lock` appended. The lock never waits and is never removed automatically. A command that finds one fails and names the path.
