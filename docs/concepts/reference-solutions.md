# Reference solutions

Why a recorded reference solution never reaches an agent, how criteria drafted from it can still leak it, and where the guards stop.

A task may record a reference solution: the pull request or commit that `tevu task add` proposed the base commit from. It is provenance. It lets tevu propose a starting commit, reject a starting commit that already holds the answer, and draft acceptance criteria. It is never part of an agent's prompt, and the sealed repository excludes every commit after the base, the reference commits included, so a case worktree cannot contain them.

## Where a leak can still happen

Drafted criteria are the weak point. With `roles.criteria` declared, a model reads the reference solution's changes and writes acceptance criteria and a Definition of Done. Once saved, those items reach every benchmarked agent's prompt through the graded checks. Unlike the reference's identifier, that text is not excluded from a case by construction. It can leak in two ways:

- **Identity.** An item can name the reference commit or pull request, which tells the agent where the answer is.
- **Method.** An item can describe how the accepted solution works, which hands every model the technique and makes the comparison measure who followed the hint.

## Guards

- **Identity screen.** The draft review rejects an item that names the reference commit or pull request, and accepting is blocked until it is fixed.
- **Mandatory review.** Even an unedited draft needs an explicit accept, so an operator reads every item before it is saved. A drafting model can favor outcomes shaped like its own family's solutions, which is one reason a human check matters.
- **Prompt instruction.** The drafting prompt tells the model that every agent reads each item, and forbids naming a mechanism, file, or function the solution uses unless the task text names it too. Nothing screens the reply against this rule. It is an instruction to the model, and the mandatory review is what backs it.
- **Prompt screening.** `tevu validate` and `tevu run` reject a task whose agent prompt contains identifiers of the reference. The rule is in [Tasks](../reference/tasks.md#prompt-screening).

## Where the guards stop

The screen matches recorded identifiers as plain substrings. It does not read the pull request, and it does not know about a bare `#NUMBER`, a branch name, or a title. A rename or transfer of the repository after the task was added is not followed. Method leaks have no screen at all. What remains is your reading of the prompt and the criteria before you accept them.

The configuration file and `run.json` still record the reference outside the case. That is context isolation, not a sandbox; see [Isolation](isolation.md#where-isolation-stops).
