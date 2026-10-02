# Isolation

Why each case gets its own context, why the evaluator is kept apart from the agent, and where these boundaries stop.

A comparison is useful only when models face the same task. If one model can discover an earlier solution or another model's output, the result measures access to information as much as ability. tevu controls what each case can see so that a difference in results is a difference between models.

## The same files are not the same context

Checking out an old commit gives a model the old files, but the repository can still hold later commits with the finished solution. It is like setting an exercise while leaving the answer sheet available to one participant.

Each case therefore gets a sealed repository whose history begins with the task's tree. The model sees the starting point, not the source repository's later work. The original commit identity stays in the results, so the comparison can still be traced to its source. Tracked project instructions remain part of the task; they are in the tree. Host sessions, global prompts, caches, and login stores do not cross, because they are state from your earlier work, not a shared starting condition. The one exception is provider definitions, covered in [Model access](model-access.md).

A repository that stores files in Git LFS keeps small pointers in each commit and the real bytes elsewhere. A developer with Git LFS configured never sees the pointer in a checkout, so a pointer is not the starting point a case should give a model. The sealed repository holds the object content at each pointer's path, and nothing else about Git LFS crosses: no storage, remotes, or credentials. The rules are in [Repositories](../reference/repositories.md#git-lfs-content).

A managed GitHub clone is a source repository like any other: read-only to every case and sealed the same way. Clone preparation finishes before the first case is sealed.

## The evaluator has a different job

The agent needs context and credentials to produce a solution. A check needs the submitted files and its declared inputs. If the evaluator shared the agent's home or authentication state, it would gain dependencies its check definition does not describe, and a check could pass only because of something the agent left behind.

So evaluators get their own home, state, and temporary directories and a fixed environment with explicit additions. See [Environment](../reference/environment.md).

A command that only resolves through your home directory, such as a version-manager shim, cannot run in a case for the same reason. Giving the case your home would give it your other state along with the one tool. `tevu validate` instead reports such a command by name before the first case starts. See [Case executables](../reference/environment.md#case-executables).

## Hidden checks

tevu captures the solution patch before checks run. It can then reset configured paths to the starting tree and add check files the agent never saw, so the agent's edits to those paths do not decide the verdict. tevu keeps the overlay directory out of the prompt and out of the case until checks start, and reads it once when the run starts, so an edit during the run reaches no case of that run.

Hidden checks stop a model from tailoring its edits to a test it never saw. They do not stop a model that goes looking. See [Restore and overlay](../reference/checks.md#restore-and-overlay) for the mechanics.

## Where isolation stops

This is context isolation, not a sandbox. Separate directories keep sibling outputs and benchmark artifacts out of the context tevu supplies. They do not create an operating-system security boundary:

- An agent with shell access can probe other host paths, including the overlay directory, a managed clone, and the run's own configuration and `run.json`, which record the reference solution.
- The agent adapter reports its optional outside-worktree restriction as `unavailable`.
- A model call, which tevu starts with every tool denied, can still get a tool from configuration outside tevu: an `agent.<name>.permission` block, or a top-level `permission` block that lists `*` before the tool, reached through `OPENCODE_CONFIG_CONTENT`, `OPENCODE_CONFIG`, or `OPENCODE_CONFIG_DIR` in the agent block, or through a system-wide OpenCode configuration such as `/etc/opencode` on Linux. tevu finds a tool call only after the call ended, in the saved session, and cannot confirm beforehand that the denial held. By then the tool has already run.
- An agent's or check's own git reads the host's system Git configuration. When that defines the `lfs` filter, that git can report pointer paths as modified. The paths are unchanged in the case; only that git's view differs.

The distinction matters when you read a result. tevu controls the starting context and records evidence. It does not establish that untrusted code was contained. The report keeps that limitation visible next to the comparison.
