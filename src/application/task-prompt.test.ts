// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildTaskPrompt } from "./task-prompt.ts";
import { TevuConfigSchema } from "../config/schema.ts";

import type { ModelDefinitionInput, TaskDefinition, TaskInput } from "../config/schema.ts";

function buildTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: "task-1",
    title: "Synthetic welcome-route task",
    repo: "repo-1",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    description: "synthetic task description for the welcome route",
    prompt: "TEVU-PROMPT-BODY implement the welcome route",
    readiness: ["synthetic ready item"],
    checks: {
      acceptance: [
        {
          id: "acc-acceptance-command",
          description: "acceptance command exits zero",
          run: ["/synthetic/acceptance-probe", "--suite", "synthetic"],
          timeout: "5s",
          exit_codes: [0],
        },
      ],
      done: [
        {
          id: "dod-manual-review",
          description: "manual Definition of Done review",
          manual: true,
        },
      ],
    },
    ...overrides,
  };
}

function buildModel(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return { id: "alpha", model: "vendor/model-alpha-synth", effort: "effort-high", ...overrides };
}

/** Materializes one task through the schema so `buildTaskPrompt` sees every default resolved. */
function materializeTask(overrides: Partial<TaskInput> = {}): TaskDefinition {
  const config = TevuConfigSchema.parse({
    version: 1,
    run: { output_dir: "/synthetic/artifacts", concurrency: 1, timeout: "1m", stop_grace: "1s" },
    agents: { opencode: { command: "/synthetic/opencode" } },
    repositories: [{ id: "repo-1", path: "/synthetic/source" }],
    models: [buildModel(), buildModel({ id: "beta" })],
    tasks: [buildTask(overrides)],
  });
  const task = config.tasks[0];
  if (task === undefined) {
    throw new Error("expected the fixture configuration to materialize its task");
  }
  return task;
}

describe("buildTaskPrompt", () => {
  it("builds identical prompt bytes for every contender on the same task", () => {
    const task = materializeTask();

    const prompt = buildTaskPrompt(task);

    expect(prompt).toBe(buildTaskPrompt(task));
  });

  it("includes the prompt, description, check descriptions, and repository boundary instruction", () => {
    const task = materializeTask();

    const prompt = buildTaskPrompt(task);

    expect(prompt).toBe(
      [
        task.prompt,
        task.description,
        `Acceptance criteria:\n- ${task.checks.acceptance[0]?.description}`,
        `Definition of Done:\n- ${task.checks.done[0]?.description}`,
        "Work only inside the current repository. Do not read or modify any path outside this repository's working tree.",
      ].join("\n\n"),
    );
    expect(prompt).not.toContain("Pinned source commit");
    expect(prompt.toLowerCase()).not.toContain("0123456");
  });

  it("omits evaluator commands, contender identity, and Jira identity from the prompt", () => {
    const jiraTask = materializeTask({
      source: {
        kind: "jira",
        key: "TEVU-999",
        url: "https://jira.example.com/browse/TEVU-999",
        imported_at: "2026-09-22T12:00:00.000Z",
        title: "TEVU-JIRA-SUMMARY",
        body: "TEVU-JIRA-DESCRIPTION",
      },
    });
    const model: ModelDefinitionInput = buildModel();

    const prompt = buildTaskPrompt(jiraTask);

    expect(prompt).not.toContain("/synthetic/acceptance-probe");
    expect(prompt).not.toContain("TEVU-999");
    expect(prompt).not.toContain("TEVU-JIRA-DESCRIPTION");
    expect(prompt).not.toContain(model.model);
    expect(prompt).not.toContain(model.effort);
  });

  it("omits GitHub issue identity and imported body from the prompt", () => {
    const githubTask = materializeTask({
      source: {
        kind: "github",
        key: "octo/repo#42",
        url: "https://github.com/octo/repo/issues/42",
        imported_at: "2026-09-22T12:00:00.000Z",
        title: "TEVU-GITHUB-SUMMARY",
        body: "TEVU-GITHUB-DESCRIPTION",
      },
    });

    const prompt = buildTaskPrompt(githubTask);

    expect(prompt).not.toContain("octo/repo#42");
    expect(prompt).not.toContain("https://github.com/octo/repo/issues/42");
    expect(prompt).not.toContain("TEVU-GITHUB-SUMMARY");
    expect(prompt).not.toContain("TEVU-GITHUB-DESCRIPTION");
  });

  it("does not read the task's base commit", () => {
    const first = materializeTask({ base_commit: "0123456789abcdef0123456789abcdef01234567" });
    const second = materializeTask({ base_commit: "fedcba9876543210fedcba9876543210fedcba98" });

    expect(buildTaskPrompt(first)).toBe(buildTaskPrompt(second));
  });
});
