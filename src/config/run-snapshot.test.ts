// @vitest-environment node
import { describe, expect, it } from "vitest";

import { decodeRunConfig } from "./run-snapshot.ts";

import type { CheckRecord, TaskRecord } from "../domain/types.ts";

type SnapshotCheck = {
  id: string;
  description: string;
  required?: boolean;
  manual?: boolean;
  run?: readonly string[];
  timeout?: string;
  exit_codes?: readonly number[];
  env?: readonly string[];
};

type SnapshotSource = { kind: "jira" | "github"; key: string; url: string; extra?: string };

type SnapshotTask = {
  id: string;
  title: string;
  repo: string;
  base_commit: string;
  description: string;
  source?: SnapshotSource;
  checks: { acceptance: SnapshotCheck[]; done: SnapshotCheck[] };
};

type SnapshotModel = { id: string; model: string; effort: string; agent?: string };

type SnapshotRepository = { id: string; path: string };

type Snapshot = {
  tasks: SnapshotTask[];
  models: SnapshotModel[];
  repositories: SnapshotRepository[];
};

function buildSnapshotCheck(overrides: Partial<SnapshotCheck> = {}): SnapshotCheck {
  return { id: "acc-1", description: "the thing works", required: true, manual: true, ...overrides };
}

function buildSnapshotTask(overrides: Partial<SnapshotTask> = {}): SnapshotTask {
  return {
    id: "task-1",
    title: "Fixture task",
    repo: "repo-1",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    description: "Fixture task description",
    checks: {
      acceptance: [buildSnapshotCheck({ id: "acc-1" })],
      done: [buildSnapshotCheck({ id: "dod-1" })],
    },
    ...overrides,
  };
}

function buildSnapshotModel(overrides: Partial<SnapshotModel> = {}): SnapshotModel {
  return { id: "alpha", model: "vendor/model-alpha", effort: "high", ...overrides };
}

function buildSnapshotRepository(overrides: Partial<SnapshotRepository> = {}): SnapshotRepository {
  return { id: "repo-1", path: "/repos/repo-1", ...overrides };
}

function buildSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    tasks: [buildSnapshotTask()],
    models: [buildSnapshotModel()],
    repositories: [buildSnapshotRepository()],
    ...overrides,
  };
}

function expectDecoded<T>(outcome: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!outcome.ok) {
    throw new Error(`expected decodeRunConfig to succeed: ${JSON.stringify(outcome.error)}`);
  }
  return outcome.value;
}

describe("decodeRunConfig", () => {
  it("projects a manually sourced task into a manual source record with a null reference", () => {
    const decoded = expectDecoded(decodeRunConfig(buildSnapshot()));

    expect(decoded.tasks[0]?.source).toEqual({ kind: "manual", reference: null, title: "Fixture task" });
  });

  it("projects a jira source into a jira-cloud source record", () => {
    const task = buildSnapshotTask({
      source: { kind: "jira", key: "PROJ-1", url: "https://jira.example.com/browse/PROJ-1" },
    });

    const decoded = expectDecoded(decodeRunConfig(buildSnapshot({ tasks: [task] })));

    expect(decoded.tasks[0]?.source).toEqual({
      kind: "jira-cloud",
      issueKey: "PROJ-1",
      issueUrl: "https://jira.example.com/browse/PROJ-1",
    });
  });

  it("projects a github source into a github-issue source record", () => {
    const task = buildSnapshotTask({
      source: { kind: "github", key: "octo/repo#42", url: "https://github.com/octo/repo/issues/42" },
    });

    const decoded = expectDecoded(decodeRunConfig(buildSnapshot({ tasks: [task] })));

    expect(decoded.tasks[0]?.source).toEqual({
      kind: "github-issue",
      issueKey: "octo/repo#42",
      issueUrl: "https://github.com/octo/repo/issues/42",
    });
  });

  it("orders checks as acceptance then done, mapping category and evaluator", () => {
    const task = buildSnapshotTask({
      checks: {
        acceptance: [
          buildSnapshotCheck({ id: "acc-command", manual: undefined, run: ["npm", "test"] }),
          buildSnapshotCheck({ id: "acc-manual" }),
        ],
        done: [buildSnapshotCheck({ id: "dod-manual", required: false })],
      },
    });

    const decoded = expectDecoded(decodeRunConfig(buildSnapshot({ tasks: [task] })));

    expect(decoded.tasks[0]?.checks).toEqual<CheckRecord[]>([
      {
        id: "acc-command",
        category: "acceptance",
        description: "the thing works",
        required: true,
        evaluator: "command",
      },
      {
        id: "acc-manual",
        category: "acceptance",
        description: "the thing works",
        required: true,
        evaluator: "manual",
      },
      {
        id: "dod-manual",
        category: "definition-of-done",
        description: "the thing works",
        required: false,
        evaluator: "manual",
      },
    ]);
  });

  it("projects repositoryId, startCommit, and description from repo, base_commit, and description", () => {
    const task = buildSnapshotTask({
      repo: "repo-2",
      base_commit: "fedcba9876543210fedcba9876543210fedcba98",
      description: "another description",
    });

    const decoded = expectDecoded(decodeRunConfig(buildSnapshot({ tasks: [task] })));

    expect(decoded.tasks[0]).toMatchObject<Partial<TaskRecord>>({
      id: "task-1",
      repositoryId: "repo-2",
      startCommit: "fedcba9876543210fedcba9876543210fedcba98",
      description: "another description",
    });
  });

  it("projects every model as id, model, and effort", () => {
    const decoded = expectDecoded(
      decodeRunConfig(buildSnapshot({ models: [buildSnapshotModel({ id: "beta", agent: "opencode" })] })),
    );

    expect(decoded.models).toEqual([{ id: "beta", model: "vendor/model-alpha", effort: "high" }]);
  });

  it("projects every repository as id and path", () => {
    const decoded = expectDecoded(
      decodeRunConfig(buildSnapshot({ repositories: [buildSnapshotRepository({ id: "repo-9", path: "/repos/9" })] })),
    );

    expect(decoded.repositories).toEqual([{ id: "repo-9", path: "/repos/9" }]);
  });

  it("ignores unknown keys on tasks, checks, models, and repositories", () => {
    const snapshot = {
      tasks: [
        {
          ...buildSnapshotTask(),
          prompt: "sent to the agent",
          readiness: ["confirmed"],
          checks: {
            acceptance: [{ ...buildSnapshotCheck({ id: "acc-1" }), timeout: "5m", exit_codes: [0], env: [] }],
            done: [buildSnapshotCheck({ id: "dod-1" })],
          },
        },
      ],
      models: [{ ...buildSnapshotModel(), agent: "opencode" }],
      repositories: buildSnapshot().repositories,
    };

    const result = decodeRunConfig(snapshot);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.tasks[0] ?? {})).toEqual([
      "id",
      "repositoryId",
      "startCommit",
      "description",
      "source",
      "checks",
    ]);
    expect(Object.keys(result.value.models[0] ?? {})).toEqual(["id", "model", "effort"]);
  });

  it.each([
    { fragment: "id", snapshot: buildSnapshot({ repositories: [buildSnapshotRepository({ id: "repo-[REDACTED]" })] }) },
    {
      fragment: "url",
      snapshot: buildSnapshot({
        tasks: [
          buildSnapshotTask({
            source: { kind: "jira", key: "PROJ-1", url: "https://jira.example.com/browse/[REDACTED]" },
          }),
        ],
      }),
    },
  ])("decodes a snapshot with a [REDACTED] fragment inside an $fragment", ({ snapshot }) => {
    const result = decodeRunConfig(snapshot);

    expect(result.ok).toBe(true);
  });

  it("refuses a previous-layout snapshot that has contenders but no models", () => {
    const { models, ...withoutModels } = buildSnapshot();
    const previousLayout = { ...withoutModels, contenders: models };

    const result = decodeRunConfig(previousLayout);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "ArtifactError",
        operation: "decode-run-configuration",
        reason: "run configuration snapshot does not match the current configuration layout at models",
      },
    });
  });

  it("names the root when the snapshot is not an object at all", () => {
    const result = decodeRunConfig(null);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "ArtifactError",
        operation: "decode-run-configuration",
        reason: "run configuration snapshot does not match the current configuration layout at (root)",
      },
    });
  });
});
