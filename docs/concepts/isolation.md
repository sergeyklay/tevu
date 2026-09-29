# Why benchmark cases need separate context

A comparison is useful only when the models face the same task. If one can discover an earlier solution or another model's output, the result measures access to that information as well as the model's ability. tevu separates the context supplied to each case to make that difference explicit.

## The same files are not the same context

Checking out an old commit gives a model the old files, but a repository can still contain later commits with the finished solution. It is like setting the same exercise while leaving the answer sheet available to one participant.

Each tevu case therefore gets a sealed repository whose history begins with the selected tree. The model sees the task's starting point rather than the source repository's later work. The original commit identity remains in the results so the comparison can still be traced to its source.

Tracked project instructions remain part of the task. Host sessions, global prompts, caches, and login stores do not: they are state from the operator's previous work, not a shared starting condition, except the provider definitions `agents.opencode.providers` names; see [A case gets the operator's providers, not their agent setup](#a-case-gets-the-operators-providers-not-their-agent-setup). The precise source-tree rules and unsupported features are in the [configuration reference](../reference/configuration.md#source-trees).

A command that only resolves its target through the operator's home directory, such as a version-manager shim, cannot run inside a case for the same reason: giving the case that home would give it the operator's other state as well, not just the one tool. tevu instead starts such a command once in a replica of its case environment and, only on failure, once in its own environment, and, if only the second run succeeds, reports it by name before the first case starts instead of giving a case the operator's home. See [Case executables](../reference/configuration.md#case-executables).

## A managed clone is a source repository like any other

A GitHub repository entry's managed clone is, for isolation purposes, a source repository like a local path: read-only to every case, and sealed the same way, into a repository with one synthetic root commit at `base_commit`. Preparation, the clone or fetch a command performs before validation, finishes before the first case is sealed; a concurrent fetch by another tevu command only adds objects and refs, so it cannot reach an already-sealed case. The clone lies outside every case and no case-scoped variable names it, though an agent with shell access can still find it on disk, the same limitation [Context isolation is not a sandbox](#context-isolation-is-not-a-sandbox) describes for hidden checks. See [GitHub repositories](../reference/configuration.md#github-repositories) for the clone's layout and lifecycle.

## The evaluator has a different job

The agent needs enough context and credentials to produce a solution. An acceptance command needs the submitted files and its declared test inputs. Sharing the agent's home or authentication state would give the evaluator dependencies that its check definition does not describe.

tevu gives evaluators separate state directories and a fixed environment with explicitly allowed additions. It also captures the solution patch before checks run, so files created by a test command do not become part of the model's submitted solution. After capturing the patch, tevu can reset configured paths to the starting commit and add hidden check files, so the agent's edits to those paths do not decide the verdict, within the limits the [configuration reference](../reference/configuration.md#restore-and-overlay) lists. The [environment reference](../reference/configuration.md#fixed-evaluator-environment) lists the exact variables.

## Context isolation is not a sandbox

Separate directories keep sibling outputs and benchmark artifacts out of the context tevu supplies. They do not create an operating-system security boundary: an agent with shell access can still probe other host paths. The current adapter reports its optional outside-worktree restriction as `unavailable`.

Hidden checks are context isolation, not a sandbox. tevu keeps a configured overlay directory out of the prompt and out of the case until checks start, and reads it once when the run starts, so a change to the directory during the run reaches no case of that run. An agent with shell access can still find the overlay directory on disk and read it; hidden checks stop a model from tailoring its edits to a test it never saw, not a model that goes looking for it.

The distinction matters when interpreting a result. tevu controls the starting context and records evidence; it does not establish that untrusted code was contained. The report keeps that limitation visible alongside the comparison.

## A case gets the operator's providers, not their agent setup

A case agent cannot reach a model whose provider it does not know, so a case built purely from the file tree above would never resolve a model served by a provider the operator only configured in their own OpenCode setup. `agents.opencode.providers` names which of the operator's provider definitions cross into a case: nothing else does. tevu reads the named definitions once per run, before the run starts, and copies the identical result into every case and model call of that run, the same shared starting condition every other fixed variable already is.

Instructions, MCP servers, permissions, plugins, agents, commands, skills, sessions, and the login store all stay host state: copying any of them would make runs incomparable in the same way copying the operator's other agent home directory would, for the same reason [Context isolation is not a sandbox](#context-isolation-is-not-a-sandbox) keeps hidden checks off a case's disk rather than out of its reach. A copied provider's credential still crosses only as a configured secret variable, redacted from every artifact the same way any other secret is; see [Agent providers](../reference/configuration.md#agent-providers) for the exact rules a copied definition must satisfy before it is copied at all.

Because the copy sits in the case agent's own global configuration rather than its project configuration, a task's tracked `opencode.json` still overrides it, so this exception does not let an operator's provider setup outrank the task's own tracked configuration. The copy is context isolation, not a sandbox, for the same reason the rest of a case's context is: it is readable by the agent, on disk, in the agent's own home.

## Model calls get no task repository

A one-shot model call, such as drafting acceptance criteria or grading a case's solution, reuses the same agent adapter and the same private environment shape as a case agent: its own home, state, and temporary directories, and the case agent variables of its agent block. It differs in what it does not get. A model call's working directory is an empty Git repository, not a case's sealed worktree: no configured repository or commit reaches it, and, being a Git top level itself, it stops OpenCode's upward search for `AGENTS.md` and other tracked instructions, `opencode.json` and `.opencode` configuration and plugins, and `.claude/skills` or `.agents/skills`, the same way a case's sealed repository stops that search at its own worktree. A grader call's prompt, on stdin, carries the task's prompt and description, its graded checks' IDs and descriptions, and the case's solution patch; it never carries a reference solution, a case ID, a run ID, or the identity of the model entry that produced the solution. A criteria call's prompt carries the task's prompt and description and the reference solution's changes; tevu adds no pull request title or description, commit hash, pull request key, pull request URL, case ID, or run ID to it. A model call gets no evaluator environment, since it runs no check, and its directory is removed as soon as the call ends. A model call, and the model listing `tevu validate` runs in an environment built the same way, receive the same copied provider definitions a case agent does; see [A case gets the operator's providers, not their agent setup](#a-case-gets-the-operators-providers-not-their-agent-setup).

This isolation is context isolation, not a sandbox, for the same reason case isolation is not one: see [Context isolation is not a sandbox](#context-isolation-is-not-a-sandbox).

## The reference solution stays out of the agent's context

A task may record a reference solution: a pull request or a commit `tevu task add` proposed the base commit from. It is provenance, kept for later use, and it never reaches an agent prompt itself. The sealed repository already excludes every commit after the base, every reference commit included, so a case worktree cannot contain them.

With `roles.criteria` declared, a task's acceptance criteria and Definition of Done may be drafted from the reference solution and, once saved, reach every benchmarked agent's prompt through the task's graded checks: unlike the reference solution's identifier, this text is not excluded from the case worktree by construction. Two guards keep it from leaking the accepted solution's identity: the draft review's identity screen rejects an item naming the reference commit or pull request before it can be accepted, and the review itself is mandatory, so an operator reads every drafted item before it is saved. A third guard, against leaking how the accepted solution works, is only an instruction to the model: the drafting prompt says that every agent reads each item and forbids naming a mechanism, file, or function that solution uses unless the task text names it too. Nothing screens the reply for it, so the mandatory review is what backs it.

`tevu validate` and `tevu run` also reject a task whose agent prompt contains, in any letter case, the first 7 characters of a recorded reference commit, the same rule enforced for `base_commit`; for a pull-request reference, they also reject its `OWNER/REPO#NUMBER` key and its URL form, matched as plain substrings built from the recorded identifier. Neither check sees the pull request itself: `validate` makes no request to GitHub itself, and `run` contacts it only to clone or fetch a GitHub repository entry's managed clone, never to read the pull request, so a rename or a transfer of the repository after the task was added is not followed, and neither command checks a prompt for any other hint to the accepted solution, such as a bare `#NUMBER`, a branch name, or a title.

The configuration file and `run.json` still record the reference outside the case, which is context isolation, not a sandbox: see [Context isolation is not a sandbox](#context-isolation-is-not-a-sandbox).

## Evidence outlives the workspace

Temporary workspaces are useful while models and checks are running. Saved evidence has a different purpose: it lets an operator inspect a solution, assess a manual criterion, or rebuild a report without starting another model run.

The patch and source records are retained after successful workspace cleanup. Credential redaction removes authentication values while preserving the project text needed to judge the work. The [results reference](../reference/results.md#saved-files) describes these files and their retention.
