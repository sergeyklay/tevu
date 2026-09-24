/**
 * Decodes a run's stored configuration snapshot into the run-record
 * projection that `tevu report` and `tevu assess` read.
 *
 * The projection schema is independent of `TevuConfigSchema`: it ignores
 * unknown keys, requires only the fields it reads, and applies no
 * pattern, length, URL, datetime, or template-literal rule, so a
 * manifest-redacted `[REDACTED]` fragment inside an id or URL still decodes,
 * and a later configuration schema change that leaves these fields alone
 * leaves stored runs decodable.
 */

import { z } from "zod";

import type { CheckRecord, RunConfigRecord, TaskRecord, TevuResult } from "../domain/types.ts";

const projectionSourceSchema = z.object({
  kind: z.enum(["jira", "github"]),
  key: z.string(),
  url: z.string(),
});

const projectionCheckSchema = z.object({
  id: z.string(),
  description: z.string(),
  required: z.boolean(),
  manual: z.boolean().optional(),
});

const projectionTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  repo: z.string(),
  base_commit: z.string(),
  description: z.string(),
  source: projectionSourceSchema.optional(),
  checks: z.object({
    acceptance: z.array(projectionCheckSchema),
    done: z.array(projectionCheckSchema),
  }),
});

const projectionModelSchema = z.object({ id: z.string(), model: z.string(), effort: z.string() });

const projectionRepositorySchema = z.object({ id: z.string(), path: z.string() });

const projectionConfigSchema = z.object({
  tasks: z.array(projectionTaskSchema),
  models: z.array(projectionModelSchema),
  repositories: z.array(projectionRepositorySchema),
});

/**
 * Decodes an untyped run-manifest configuration snapshot into a
 * {@link RunConfigRecord}.
 *
 * @throws never; a snapshot that fails the projection is returned as an
 * `ArtifactError`, never thrown.
 */
export function decodeRunConfig(snapshot: unknown): TevuResult<RunConfigRecord, "ArtifactError"> {
  const parsed = projectionConfigSchema.safeParse(snapshot);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path =
      firstIssue === undefined || firstIssue.path.length === 0
        ? "(root)"
        : firstIssue.path.map((segment) => String(segment)).join(".");
    return {
      ok: false,
      error: {
        kind: "ArtifactError",
        operation: "decode-run-configuration",
        reason: `run configuration snapshot does not match the current configuration layout at ${path}`,
      },
    };
  }
  const data = parsed.data;
  const tasks: TaskRecord[] = data.tasks.map((task) => ({
    id: task.id,
    repositoryId: task.repo,
    startCommit: task.base_commit,
    description: task.description,
    source: projectSource(task.title, task.source),
    checks: [
      ...task.checks.acceptance.map((check) => projectCheck(check, "acceptance")),
      ...task.checks.done.map((check) => projectCheck(check, "definition-of-done")),
    ],
  }));
  return {
    ok: true,
    value: {
      tasks,
      models: data.models.map((model) => ({ id: model.id, model: model.model, effort: model.effort })),
      repositories: data.repositories.map((repository) => ({ id: repository.id, path: repository.path })),
    },
  };
}

function projectSource(
  title: string,
  source: z.infer<typeof projectionSourceSchema> | undefined,
): TaskRecord["source"] {
  if (source === undefined) {
    return { kind: "manual", reference: null, title };
  }
  return source.kind === "jira"
    ? { kind: "jira-cloud", issueKey: source.key, issueUrl: source.url }
    : { kind: "github-issue", issueKey: source.key, issueUrl: source.url };
}

function projectCheck(
  check: z.infer<typeof projectionCheckSchema>,
  category: CheckRecord["category"],
): CheckRecord {
  return {
    id: check.id,
    category,
    description: check.description,
    required: check.required,
    evaluator: check.manual === true ? "manual" : "command",
  };
}
