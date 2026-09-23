import { z } from "zod";

/** ID grammar shared by every configuration collection. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

const idSchema = z
  .string()
  .regex(ID_PATTERN, "id must match ^[a-z][a-z0-9-]{0,63}$");

const positiveMillisecondsSchema = z
  .int("duration must be an integer millisecond value")
  .positive("duration must be a positive integer millisecond value");

const nonWhitespaceTextSchema = z
  .string()
  .refine((text) => text.trim().length > 0, "must contain non-whitespace text");

/** Environment names fixed by the isolation contract; configuration must not redefine them. */
const FIXED_ENVIRONMENT_NAMES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "CI",
]);

function isFixedEnvironmentName(name: string): boolean {
  return FIXED_ENVIRONMENT_NAMES.has(name) || name.startsWith("XDG_");
}

/**
 * Declares one pass-through environment variable by name and classification.
 * Values are never part of the configuration.
 */
export const EnvironmentVariableDefinitionSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .refine(
      (name) => !isFixedEnvironmentName(name),
      "PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract and cannot be configured",
    ),
  classification: z.enum(["provider-credential", "secret", "ordinary"]),
});

/** Jira Cloud connection settings; credentials stay in named environment variables. */
export const JiraCloudConfigSchema = z.strictObject({
  baseUrl: z.url({ protocol: /^https$/ }),
  emailEnvironmentVariable: z.string().min(1),
  tokenEnvironmentVariable: z.string().min(1),
});

/** One local source repository referenced by tasks. */
export const RepositoryDefinitionSchema = z.strictObject({
  id: idSchema,
  path: z.string().min(1),
});

/** One model-plus-effort-variant contender; duplicate models with distinct variants are allowed. */
export const ContenderDefinitionSchema = z.strictObject({
  id: idSchema,
  model: z.templateLiteral([z.string().min(1), "/", z.string().min(1)]),
  variant: z.string().min(1),
});

/** Command-based check evaluator using a literal argument vector, never a shell string. */
export const CommandEvaluatorSchema = z.strictObject({
  kind: z.literal("command"),
  argv: z.tuple([z.string().min(1)], z.string()),
  timeoutMs: positiveMillisecondsSchema,
  successExitCodes: z.array(z.int()).min(1),
  environmentAllowlist: z.array(z.string().min(1)).default([]),
});

/** Manual check evaluator assessed by a human through `tevu assess`. */
export const ManualEvaluatorSchema = z.strictObject({
  kind: z.literal("manual"),
});

/** One acceptance-criterion or Definition of Done check. */
export const CheckDefinitionSchema = z.strictObject({
  id: idSchema,
  description: z.string(),
  required: z.boolean(),
  evaluator: z.discriminatedUnion("kind", [
    CommandEvaluatorSchema,
    ManualEvaluatorSchema,
  ]),
});

/** One confirmed Definition of Ready item. */
export const ReadyItemSchema = z.strictObject({
  id: idSchema,
  description: z.string(),
  confirmed: z.literal(true),
});

/** Manually curated task source. */
export const ManualTaskSourceSchema = z.strictObject({
  kind: z.literal("manual"),
  reference: z.string().optional(),
  title: z.string(),
});

/** One-time Jira Cloud import snapshot; later Jira changes never alter the task. */
export const JiraTaskSourceSchema = z.strictObject({
  kind: z.literal("jira-cloud"),
  issueKey: z.string().min(1),
  issueUrl: z.url(),
  importedAt: z.iso.datetime(),
  importedSummary: z.string(),
  importedDescription: z.string(),
});

/** One-time GitHub issue snapshot; later GitHub changes never alter the task. */
export const GitHubIssueTaskSourceSchema = z.strictObject({
  kind: z.literal("github-issue"),
  issueKey: z.string().min(1),
  issueUrl: z.url(),
  importedAt: z.iso.datetime(),
  importedSummary: z.string(),
  importedDescription: z.string(),
});

/** One acceptance-driven benchmark task pinned to a repository commit. */
export const TaskDefinitionSchema = z
  .strictObject({
    id: idSchema,
    repositoryId: idSchema,
    startCommit: z.string().min(1),
    source: z.discriminatedUnion("kind", [
      ManualTaskSourceSchema,
      JiraTaskSourceSchema,
      GitHubIssueTaskSourceSchema,
    ]),
    description: nonWhitespaceTextSchema,
    prompt: nonWhitespaceTextSchema,
    definitionOfReady: z.array(ReadyItemSchema).min(1),
    acceptanceCriteria: z.array(CheckDefinitionSchema).min(1),
    definitionOfDone: z.array(CheckDefinitionSchema).min(1),
  })
  .superRefine((task, ctx) => {
    if (!task.acceptanceCriteria.some((check) => check.required)) {
      ctx.addIssue({
        code: "custom",
        path: ["acceptanceCriteria"],
        message: "at least one acceptance criterion must be required",
      });
    }
    if (!task.definitionOfDone.some((check) => check.required)) {
      ctx.addIssue({
        code: "custom",
        path: ["definitionOfDone"],
        message: "at least one Definition of Done check must be required",
      });
    }
    const readyIds = new Set<string>();
    task.definitionOfReady.forEach((item, index) => {
      if (readyIds.has(item.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["definitionOfReady", index, "id"],
          message: `duplicate Definition of Ready id "${item.id}"`,
        });
      }
      readyIds.add(item.id);
    });
    const checkIds = new Set<string>();
    const collections = [
      ["acceptanceCriteria", task.acceptanceCriteria],
      ["definitionOfDone", task.definitionOfDone],
    ] as const;
    for (const [collection, checks] of collections) {
      checks.forEach((check, index) => {
        if (checkIds.has(check.id)) {
          ctx.addIssue({
            code: "custom",
            path: [collection, index, "id"],
            message: `duplicate check id "${check.id}" across acceptanceCriteria and definitionOfDone`,
          });
        }
        checkIds.add(check.id);
      });
    }
  });

const executionSchema = z
  .strictObject({
    concurrency: z.int().min(1).max(32),
    caseTimeoutMs: positiveMillisecondsSchema,
    terminationGraceMs: positiveMillisecondsSchema,
    opencodeEnvironment: z.array(EnvironmentVariableDefinitionSchema),
    evaluatorEnvironment: z.array(EnvironmentVariableDefinitionSchema),
  })
  .superRefine((execution, ctx) => {
    execution.evaluatorEnvironment.forEach((entry, index) => {
      if (entry.classification !== "ordinary") {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatorEnvironment", index, "classification"],
          message: "evaluatorEnvironment entries must be classified ordinary",
        });
      }
    });
    const seenByCollection = {
      opencodeEnvironment: new Set<string>(),
      evaluatorEnvironment: new Set<string>(),
    };
    for (const collection of [
      "opencodeEnvironment",
      "evaluatorEnvironment",
    ] as const) {
      execution[collection].forEach((entry, index) => {
        if (seenByCollection[collection].has(entry.name)) {
          ctx.addIssue({
            code: "custom",
            path: [collection, index, "name"],
            message: `duplicate environment variable name "${entry.name}"`,
          });
        }
        seenByCollection[collection].add(entry.name);
      });
    }
    execution.evaluatorEnvironment.forEach((entry, index) => {
      if (seenByCollection.opencodeEnvironment.has(entry.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluatorEnvironment", index, "name"],
          message: `environment variable "${entry.name}" appears in both opencodeEnvironment and evaluatorEnvironment`,
        });
      }
    });
  });

/**
 * Authoritative strict schema for tevu configuration version 1.
 * It is the single runtime validation and TypeScript type source; unknown keys
 * fail at every level and no OpenCode release constraint exists.
 */
export const TevuConfigSchema = z
  .strictObject({
    version: z.literal(1),
    artifacts: z.strictObject({
      directory: z.string().min(1),
    }),
    execution: executionSchema,
    opencode: z.strictObject({
      executable: z.string().min(1),
    }),
    jira: JiraCloudConfigSchema.optional(),
    repositories: z.array(RepositoryDefinitionSchema).min(1),
    contenders: z.array(ContenderDefinitionSchema).min(2),
    tasks: z.array(TaskDefinitionSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const collections = [
      ["repositories", config.repositories],
      ["contenders", config.contenders],
      ["tasks", config.tasks],
    ] as const;
    for (const [collection, entries] of collections) {
      const ids = new Set<string>();
      entries.forEach((entry, index) => {
        if (ids.has(entry.id)) {
          ctx.addIssue({
            code: "custom",
            path: [collection, index, "id"],
            message: `duplicate ${collection} id "${entry.id}"`,
          });
        }
        ids.add(entry.id);
      });
    }

    const evaluatorNames = new Set(
      config.execution.evaluatorEnvironment.map((entry) => entry.name),
    );
    const repositoryIds = new Set(config.repositories.map((repository) => repository.id));

    if (config.jira !== undefined) {
      const jiraNames = [
        ["emailEnvironmentVariable", config.jira.emailEnvironmentVariable],
        ["tokenEnvironmentVariable", config.jira.tokenEnvironmentVariable],
      ] as const;
      for (const [field, name] of jiraNames) {
        if (evaluatorNames.has(name)) {
          ctx.addIssue({
            code: "custom",
            path: ["jira", field],
            message: `Jira credential variable "${name}" must not appear in execution.evaluatorEnvironment`,
          });
        }
      }
    }

    config.tasks.forEach((task, taskIndex) => {
      if (!repositoryIds.has(task.repositoryId)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", taskIndex, "repositoryId"],
          message: "repositoryId must reference a configured repository",
        });
      }
      const taskChecks = [
        ["acceptanceCriteria", task.acceptanceCriteria],
        ["definitionOfDone", task.definitionOfDone],
      ] as const;
      for (const [collection, checks] of taskChecks) {
        checks.forEach((check, checkIndex) => {
          if (check.evaluator.kind !== "command") {
            return;
          }
          check.evaluator.environmentAllowlist.forEach((name, nameIndex) => {
            if (!evaluatorNames.has(name)) {
              ctx.addIssue({
                code: "custom",
                path: [
                  "tasks",
                  taskIndex,
                  collection,
                  checkIndex,
                  "evaluator",
                  "environmentAllowlist",
                  nameIndex,
                ],
                message: `environmentAllowlist name "${name}" is not declared in execution.evaluatorEnvironment`,
              });
            }
          });
        });
      }
    });
  });

/** Validated tevu configuration, inferred from the authoritative Zod schema. */
export type TevuConfig = z.infer<typeof TevuConfigSchema>;

/** Jira Cloud connection settings. */
export type JiraCloudConfig = z.infer<typeof JiraCloudConfigSchema>;

/** One configured source repository. */
export type RepositoryDefinition = z.infer<typeof RepositoryDefinitionSchema>;

/** One model-plus-variant contender. */
export type ContenderDefinition = z.infer<typeof ContenderDefinitionSchema>;

/** One declared pass-through environment variable. */
export type EnvironmentVariableDefinition = z.infer<
  typeof EnvironmentVariableDefinitionSchema
>;

/** One benchmark task definition. */
export type TaskDefinition = z.infer<typeof TaskDefinitionSchema>;

/** One confirmed Definition of Ready item. */
export type ReadyItem = z.infer<typeof ReadyItemSchema>;

/** One acceptance or Definition of Done check. */
export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;

/** Command-based check evaluator. */
export type CommandEvaluator = z.infer<typeof CommandEvaluatorSchema>;

/** Manual check evaluator. */
export type ManualEvaluator = z.infer<typeof ManualEvaluatorSchema>;

/** Manually curated task source. */
export type ManualTaskSource = z.infer<typeof ManualTaskSourceSchema>;

/** One-time Jira Cloud import snapshot stored on a task. */
export type JiraTaskSource = z.infer<typeof JiraTaskSourceSchema>;

/** One-time GitHub issue snapshot stored on a task. */
export type GitHubIssueTaskSource = z.infer<typeof GitHubIssueTaskSourceSchema>;
