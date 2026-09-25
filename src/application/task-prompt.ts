import type { TaskDefinition } from "../config/schema.ts";

/**
 * Builds the contender-independent task prompt from only the task's own
 * fields: configured prompt, task description, acceptance-criterion
 * descriptions, Definition of Done descriptions, and the stay-inside-the-
 * repository instruction, in that order. The same input always yields the
 * same bytes, so every contender receives an identical prompt.
 *
 * The prompt excludes the source commit: the sealed repository the agent
 * runs in does not contain that commit, and naming it would let a
 * network-capable agent find a public repository's later history.
 */
export function buildTaskPrompt(task: TaskDefinition): string {
  const acceptance = task.checks.acceptance.map((check) => `- ${check.description}`);
  const definitionOfDone = task.checks.done.map((check) => `- ${check.description}`);
  return [
    task.prompt,
    task.description,
    ["Acceptance criteria:", ...acceptance].join("\n"),
    ["Definition of Done:", ...definitionOfDone].join("\n"),
    "Work only inside the current repository. Do not read or modify any path outside this repository's working tree.",
  ].join("\n\n");
}
