/**
 * Authoritative strict schema for tevu configuration version 1: snake_case
 * keys grouped by concern, unit-carrying durations, `$VARIABLE` references,
 * and adapter-keyed blocks. `TevuConfigSchema` is the single runtime
 * validation and TypeScript type source; unknown keys fail at every level.
 */

import { z } from 'zod';

/** ID grammar shared by every configuration collection. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

/** Configuration identifier: lowercase letters, digits, and hyphens, starting with a letter. */
const IdSchema = z.string().regex(ID_PATTERN, 'id must match ^[a-z][a-z0-9-]{0,63}$');

const nonWhitespaceTextSchema = z
  .string()
  .refine((text) => text.trim().length > 0, 'must contain non-whitespace text');

const DURATION_PATTERN = /^([1-9][0-9]*)(ms|s|m|h)$/;
const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const MAX_DURATION_MS = 2_147_483_647;
const DURATION_GRAMMAR_MESSAGE =
  'must be a positive whole number followed by ms, s, m, or h, for example 30s or 10m';
const DURATION_BOUND_MESSAGE = 'must be at most 2147483647ms';

function parseDurationMs(value: string): number | null {
  const match = DURATION_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const [, digits, unit] = match;
  if (digits === undefined || unit === undefined) {
    return null;
  }
  return Number(digits) * DURATION_UNIT_MS[unit];
}

/**
 * A duration string: a positive integer without leading zeros followed by
 * exactly one unit (`ms`, `s`, `m`, or `h`), bounded at 2147483647ms so a
 * configured value never overflows a Node.js timer (E1).
 */
export const DurationSchema = z.string().superRefine((value, ctx) => {
  const ms = parseDurationMs(value);
  if (ms === null) {
    ctx.addIssue({ code: 'custom', message: DURATION_GRAMMAR_MESSAGE });
    return;
  }
  if (ms > MAX_DURATION_MS) {
    ctx.addIssue({ code: 'custom', message: DURATION_BOUND_MESSAGE });
  }
});

/**
 * Converts a validated duration string to its millisecond value.
 *
 * @throws when `value` does not match the duration grammar; callers pass only
 * values already validated by {@link DurationSchema}.
 */
export function durationMs(value: string): number {
  const ms = parseDurationMs(value);
  if (ms === null) {
    throw new Error(`invalid duration value: ${value}`);
  }
  return ms;
}

const VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VARIABLE_NAME_GRAMMAR_MESSAGE =
  'must be a letter or underscore followed by letters, digits, or underscores';
const FIXED_NAME_MESSAGE =
  'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract and cannot be configured';

/** Environment names fixed by the isolation contract; configuration must not redefine them. */
const FIXED_ENVIRONMENT_NAMES = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI']);

function isFixedEnvironmentName(name: string): boolean {
  return FIXED_ENVIRONMENT_NAMES.has(name) || name.startsWith('XDG_');
}

/** An environment variable name: a shell-exportable identifier (E2). */
export const VariableNameSchema = z
  .string()
  .regex(VARIABLE_NAME_PATTERN, VARIABLE_NAME_GRAMMAR_MESSAGE);

const VARIABLE_REFERENCE_PATTERN = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;
const VARIABLE_REFERENCE_MESSAGE =
  'must be a $VARIABLE reference, for example $JIRA_API_TOKEN; secret values are never written here';

/** A `$VARIABLE` reference: a dollar sign followed by a variable name (E2). */
const VariableReferenceSchema = z
  .string()
  .regex(VARIABLE_REFERENCE_PATTERN, VARIABLE_REFERENCE_MESSAGE);

/**
 * Extracts the variable name a `$VARIABLE` reference names.
 *
 * @throws when `value` is not a `$VARIABLE` reference; callers pass only
 * values already validated by {@link VariableReferenceSchema}.
 */
export function referencedVariableName(value: string): string {
  const name = tryReferencedVariableName(value);
  if (name === undefined) {
    throw new Error(`invalid variable reference: ${value}`);
  }
  return name;
}

/**
 * Extracts the variable name a `$VARIABLE` reference names, or `undefined`
 * when `value` is not a reference. Used by cross-field checks that may run
 * before `VariableReferenceSchema` has validated the same value.
 */
function tryReferencedVariableName(value: string): string | undefined {
  const match = VARIABLE_REFERENCE_PATTERN.exec(value);
  return match === null ? undefined : match[1];
}

/** Most attempts per task/model pair that `run.repeat` and `tevu run --repeat` accept. */
export const MAX_REPEAT = 100;

/** Attempts per task/model pair: a whole number from 1 through {@link MAX_REPEAT}. */
export const RepeatSchema = z.int().min(1).max(MAX_REPEAT);

/** Settings shared by every benchmark case. */
const RunSettingsSchema = z.strictObject({
  output_dir: z.string().min(1),
  concurrency: z.int().min(1).max(32),
  repeat: RepeatSchema.default(1),
  timeout: DurationSchema,
  stop_grace: DurationSchema,
  check_timeout: DurationSchema.optional(),
});

/** Parsed run settings, all defaults materialized except the genuinely optional `check_timeout`. */
type RunSettings = z.infer<typeof RunSettingsSchema>;

function checkNoFixedNames(
  names: readonly string[],
  ctx: z.RefinementCtx,
  basePath: readonly (string | number)[],
): void {
  names.forEach((name, index) => {
    if (isFixedEnvironmentName(name)) {
      ctx.addIssue({ code: 'custom', path: [...basePath, index], message: FIXED_NAME_MESSAGE });
    }
  });
}

function checkUniqueStrings(
  names: readonly string[],
  ctx: z.RefinementCtx,
  basePath: readonly (string | number)[],
  label: string,
): void {
  const seen = new Set<string>();
  names.forEach((name, index) => {
    if (seen.has(name)) {
      ctx.addIssue({ code: 'custom', path: [...basePath, index], message: `${label} "${name}"` });
    }
    seen.add(name);
  });
}

/** Schema of one `agents.<agentName>` block; `agentName` appears only in validation messages. */
export function agentSettingsSchema(agentName: string) {
  return z
    .strictObject({
      command: z.string().min(1),
      secrets: z.array(VariableNameSchema).default([]),
      env: z.array(VariableNameSchema).default([]),
    })
    .superRefine((value, ctx) => {
      checkNoFixedNames(value.secrets, ctx, ['secrets']);
      checkNoFixedNames(value.env, ctx, ['env']);
      checkUniqueStrings(value.secrets, ctx, ['secrets'], 'duplicate environment variable name');
      checkUniqueStrings(value.env, ctx, ['env'], 'duplicate environment variable name');
      const secretNames = new Set(value.secrets);
      value.env.forEach((name, index) => {
        if (secretNames.has(name)) {
          ctx.addIssue({
            code: 'custom',
            path: ['env', index],
            message: `environment variable "${name}" appears in both agents.${agentName}.secrets and agents.${agentName}.env`,
          });
        }
      });
    });
}

/** Parsed agent block settings; `secrets` and `env` default to `[]`. */
type AgentSettings = z.infer<ReturnType<typeof agentSettingsSchema>>;

const AGENTS_SHAPE = { opencode: agentSettingsSchema('opencode') };

/** Agent name: a key of the `agents` block. */
export type AgentName = keyof TevuConfigInput['agents'];

/** Agent names the `agents` block accepts, derived from its strict object shape, not a second literal. */
export const AGENT_NAMES: readonly AgentName[] = Object.keys(AGENTS_SHAPE) as AgentName[];

/** Distinct `models[].agent` values in configuration order. */
export function agentNamesInUse(config: TevuConfig): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const model of config.models) {
    if (!seen.has(model.agent)) {
      seen.add(model.agent);
      names.push(model.agent);
    }
  }
  return names;
}

/** Jira Cloud connection settings; credentials are `$VARIABLE` references, never values. */
const JiraTrackerSettingsSchema = z.strictObject({
  url: z.url({ protocol: /^https$/ }),
  email: VariableReferenceSchema,
  token: VariableReferenceSchema,
});

/** Parsed Jira Cloud connection settings. */
export type JiraTrackerSettings = z.infer<typeof JiraTrackerSettingsSchema>;

/** One repository setup command: executable and literal arguments, no shell; the shape of a check's `run`. */
export type SetupCommand = [string, ...string[]];

/** Field-level materialized schema mirroring {@link SetupCommand}; the same shape as {@link CommandCheck}'s `run` field. */
const SetupCommandSchema = z.tuple([z.string().min(1)], z.string());

const RawRepositorySetupShape = z.strictObject({
  before_agent: z.array(SetupCommandSchema).optional(),
  before_checks: z.array(SetupCommandSchema).optional(),
  timeout: DurationSchema.optional(),
  env: z.array(VariableNameSchema).default([]),
});

type RawRepositorySetup = z.infer<typeof RawRepositorySetupShape>;

function hasSetupCommand(commands: SetupCommand[] | undefined): boolean {
  return commands !== undefined && commands.length > 0;
}

function refineRepositorySetup(value: RawRepositorySetup, ctx: z.RefinementCtx): void {
  if (!hasSetupCommand(value.before_agent) && !hasSetupCommand(value.before_checks)) {
    ctx.addIssue({
      code: 'custom',
      message: 'setup must declare a command in before_agent, before_checks, or both',
    });
  }
  if (value.timeout === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['timeout'],
      message: 'timeout is required when setup is declared',
    });
  }
  checkNoFixedNames(value.env, ctx, ['env']);
  checkUniqueStrings(value.env, ctx, ['env'], 'duplicate environment variable name');
}

/** A repository's setup block; a phase key is present only when its list holds at least one command. */
export interface RepositorySetup {
  before_agent?: SetupCommand[];
  before_checks?: SetupCommand[];
  timeout: string;
  env: string[];
}

/**
 * Validates and normalizes one repository's `setup` block: at least one
 * phase holds a command, `timeout` is present, and `env` carries no fixed or
 * duplicate name. An empty phase list is materialized as an absent key
 * (owner decision: `before_agent: []` and an absent `before_agent` are the
 * same value), so run-time code never branches on an empty phase.
 */
const RepositorySetupSchema = RawRepositorySetupShape.superRefine(refineRepositorySetup).transform(
  (value): RepositorySetup => {
    const timeout = value.timeout;
    if (timeout === undefined) {
      throw new Error('unreachable: refineRepositorySetup guarantees setup.timeout is present');
    }
    return {
      ...(hasSetupCommand(value.before_agent) ? { before_agent: value.before_agent } : {}),
      ...(hasSetupCommand(value.before_checks) ? { before_checks: value.before_checks } : {}),
      timeout,
      env: value.env,
    };
  },
);

/** One local source repository referenced by tasks. */
const RepositoryDefinitionSchema = z.strictObject({
  id: IdSchema,
  path: z.string().min(1),
  setup: RepositorySetupSchema.optional(),
});

/** One configured source repository. */
export type RepositoryDefinition = z.infer<typeof RepositoryDefinitionSchema>;

/** File-shape repository entry; identical to {@link RepositoryDefinition}. */
export type RepositoryInput = z.input<typeof RepositoryDefinitionSchema>;

/** One benchmark model entry, before its `agent` default is resolved against the configured agents. */
const ModelDefinitionSchema = z.strictObject({
  id: IdSchema,
  model: z.templateLiteral([z.string().min(1), '/', z.string().min(1)]),
  effort: z.string().min(1),
  agent: z.string().min(1).optional(),
});

/** File-shape model entry; `agent` defaults to the sole configured agent. */
export type ModelDefinitionInput = z.input<typeof ModelDefinitionSchema>;

/** One resolved benchmark model entry: what the benchmark compares. */
interface ModelDefinition {
  id: string;
  model: `${string}/${string}`;
  effort: string;
  agent: string;
}

/** One-time tracker import snapshot; later tracker changes never alter the task. */
const ImportedTaskSourceSchema = z.strictObject({
  kind: z.enum(['jira', 'github']),
  key: z.string().min(1),
  url: z.url(),
  imported_at: z.iso.datetime(),
  title: z.string(),
  body: z.string(),
});

/** One-time tracker import snapshot stored on a task. */
type ImportedTaskSource = z.infer<typeof ImportedTaskSourceSchema>;

/** One restore pattern: non-empty and relative to the repository root, with no leading `/` or `..` segment. */
const RestorePatternSchema = z
  .string()
  .refine((pattern) => pattern.length > 0, 'restore pattern must not be empty')
  .refine(
    (pattern) => !pattern.startsWith('/') && !pattern.split('/').includes('..'),
    'restore pattern must be relative to the repository root, without a leading / or a .. segment',
  );

const RawCheckShape = z.strictObject({
  id: IdSchema,
  description: z.string(),
  run: z.tuple([z.string().min(1)], z.string()).optional(),
  manual: z.boolean().optional(),
  timeout: DurationSchema.optional(),
  exit_codes: z.array(z.int()).min(1).optional(),
  env: z.array(VariableNameSchema).optional(),
  required: z.boolean().optional(),
});

type RawCheck = z.infer<typeof RawCheckShape>;

function refineCheckDiscrimination(check: RawCheck, ctx: z.RefinementCtx): void {
  const hasRun = check.run !== undefined;
  const hasManual = check.manual !== undefined;
  if (!hasRun && !hasManual) {
    ctx.addIssue({ code: 'custom', message: 'a check needs run (a command) or manual: true' });
    return;
  }
  if (hasRun && hasManual) {
    ctx.addIssue({ code: 'custom', message: 'a check has either run or manual: true, not both' });
    return;
  }
  if (hasManual && check.manual !== true) {
    ctx.addIssue({
      code: 'custom',
      path: ['manual'],
      message: 'manual must be true; omit it for a command check',
    });
    return;
  }
  if (hasManual) {
    for (const key of ['timeout', 'exit_codes', 'env'] as const) {
      if (check[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `only a command check (with run) accepts ${key}`,
        });
      }
    }
  }
}

/** A command check's resolved shape: literal argv, no shell, and every default materialized. */
export interface CommandCheck {
  id: string;
  description: string;
  run: [string, ...string[]];
  timeout: string;
  exit_codes: number[];
  env: string[];
  required: boolean;
}

/** A manual check's resolved shape: assessed by a human through `tevu assess`. */
interface ManualCheck {
  id: string;
  description: string;
  manual: true;
  required: boolean;
}

/** One acceptance or done check: a command check or a manual check. */
export type CheckDefinition = CommandCheck | ManualCheck;

/** A resolved manual check; identical to {@link ManualCheck}. */
type PreManualCheck = { id: string; description: string; manual: true; required: boolean };

/** A command check whose `timeout` default is not yet resolved against `run.check_timeout`. */
type PreCommandCheck = {
  id: string;
  description: string;
  run: [string, ...string[]];
  timeout?: string;
  exit_codes: number[];
  env: string[];
  required: boolean;
};

/** A check without its `timeout` default resolved; command checks defer that to `run.check_timeout`. */
type PreCheck = PreManualCheck | PreCommandCheck;

/**
 * Validates and normalizes one check: exactly one of `run` or `manual: true`,
 * `required`/`exit_codes`/`env` defaulted for a command check. Leaves a
 * command check's `timeout` unresolved; `TevuConfigSchema` applies the
 * `run.check_timeout` fallback once the sibling `run` block is available.
 */
const CheckDefinitionSchema = RawCheckShape.superRefine(refineCheckDiscrimination).transform(
  (check): PreCheck => {
    if (check.manual === true) {
      return {
        id: check.id,
        description: check.description,
        manual: true,
        required: check.required ?? true,
      };
    }
    const run = check.run;
    if (run === undefined) {
      throw new Error(
        'unreachable: refineCheckDiscrimination guarantees a command check declares run',
      );
    }
    return {
      id: check.id,
      description: check.description,
      run,
      ...(check.timeout === undefined ? {} : { timeout: check.timeout }),
      exit_codes: check.exit_codes ?? [0],
      env: check.env ?? [],
      required: check.required ?? true,
    };
  },
);

/** File-shape check entry: a flat object where either `run` or `manual: true` is present. */
export type CheckInput = z.input<typeof CheckDefinitionSchema>;

function refineTaskChecks(
  task: { checks: { acceptance: PreCheck[]; done: PreCheck[] } },
  ctx: z.RefinementCtx,
): void {
  if (!task.checks.acceptance.some((check) => check.required)) {
    ctx.addIssue({
      code: 'custom',
      path: ['checks', 'acceptance'],
      message: 'at least one acceptance check must be required',
    });
  }
  if (!task.checks.done.some((check) => check.required)) {
    ctx.addIssue({
      code: 'custom',
      path: ['checks', 'done'],
      message: 'at least one done check must be required',
    });
  }
  const checkIds = new Set<string>();
  (['acceptance', 'done'] as const).forEach((collection) => {
    task.checks[collection].forEach((check, index) => {
      if (checkIds.has(check.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['checks', collection, index, 'id'],
          message: `duplicate check id "${check.id}" across checks.acceptance and checks.done`,
        });
      }
      checkIds.add(check.id);
    });
  });
}

/** One acceptance-driven benchmark task, before its `repo` default and check timeouts are resolved. */
const TaskDefinitionSchema = z
  .strictObject({
    id: IdSchema,
    title: nonWhitespaceTextSchema,
    repo: IdSchema.optional(),
    base_commit: z.string().min(1),
    prompt: nonWhitespaceTextSchema,
    description: nonWhitespaceTextSchema,
    source: ImportedTaskSourceSchema.optional(),
    readiness: z.array(nonWhitespaceTextSchema).min(1),
    checks: z.strictObject({
      restore: z.array(RestorePatternSchema).optional(),
      overlay: z.string().min(1).optional(),
      acceptance: z.array(CheckDefinitionSchema).min(1),
      done: z.array(CheckDefinitionSchema).min(1),
    }),
  })
  .superRefine(refineTaskChecks);

type RawTask = z.infer<typeof TaskDefinitionSchema>;

/** File-shape task entry; `repo` is optional and a command check's `timeout` may be absent. */
export type TaskInput = z.input<typeof TaskDefinitionSchema>;

/** One resolved acceptance-driven benchmark task pinned to a repository commit. */
export interface TaskDefinition {
  id: string;
  title: string;
  repo: string;
  base_commit: string;
  prompt: string;
  description: string;
  source?: ImportedTaskSource;
  readiness: string[];
  checks: {
    /** Present only when the file declares it; `[]` declares nothing to restore. */
    restore?: string[];
    /** Present only when the file declares it; absolute after `resolveConfig`. */
    overlay?: string;
    acceptance: CheckDefinition[];
    done: CheckDefinition[];
  };
}

function resolveCheck(check: PreCheck, checkTimeout: string | undefined): CheckDefinition {
  if (!('run' in check)) {
    return check;
  }
  const timeout = check.timeout ?? checkTimeout;
  if (timeout === undefined) {
    throw new Error(
      'unreachable: refineTevuConfig guarantees every command check resolves a timeout',
    );
  }
  return {
    id: check.id,
    description: check.description,
    run: check.run,
    timeout,
    exit_codes: check.exit_codes,
    env: check.env,
    required: check.required,
  };
}

function checkUniqueIds(
  entries: readonly { id: string }[],
  ctx: z.RefinementCtx,
  collection: 'repositories' | 'models' | 'tasks',
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      ctx.addIssue({
        code: 'custom',
        path: [collection, index, 'id'],
        message: `duplicate ${collection} id "${entry.id}"`,
      });
    }
    seen.add(entry.id);
  });
}

const RawTevuConfigShape = z.strictObject({
  version: z.literal(1),
  run: RunSettingsSchema,
  agents: z.strictObject(AGENTS_SHAPE),
  trackers: z.strictObject({ jira: JiraTrackerSettingsSchema.optional() }).optional(),
  repositories: z.array(RepositoryDefinitionSchema).min(1),
  models: z.array(ModelDefinitionSchema).min(2),
  tasks: z.array(TaskDefinitionSchema).min(1),
});

type RawTevuConfig = z.infer<typeof RawTevuConfigShape>;

function refineTevuConfig(raw: RawTevuConfig, ctx: z.RefinementCtx): void {
  checkUniqueIds(raw.repositories, ctx, 'repositories');
  checkUniqueIds(raw.models, ctx, 'models');
  checkUniqueIds(raw.tasks, ctx, 'tasks');

  const agentKeys = Object.keys(raw.agents);
  raw.models.forEach((model, index) => {
    if (model.agent !== undefined && !agentKeys.includes(model.agent)) {
      ctx.addIssue({
        code: 'custom',
        path: ['models', index, 'agent'],
        message: `agent must name a configured agent: ${agentKeys.join(', ')}`,
      });
    }
  });

  const repositoryIds = new Set(raw.repositories.map((repository) => repository.id));
  const agentNames = new Set(
    Object.values(raw.agents).flatMap((agent) => [...agent.secrets, ...agent.env]),
  );
  const jira = raw.trackers?.jira;
  const jiraEmailName = jira === undefined ? undefined : tryReferencedVariableName(jira.email);
  const jiraTokenName = jira === undefined ? undefined : tryReferencedVariableName(jira.token);

  raw.repositories.forEach((repository, repositoryIndex) => {
    repository.setup?.env.forEach((name, nameIndex) => {
      const path = ['repositories', repositoryIndex, 'setup', 'env', nameIndex];
      if (agentNames.has(name)) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `environment variable "${name}" is passed to the agent and cannot also be passed to a setup command`,
        });
      } else if (name === jiraEmailName || name === jiraTokenName) {
        ctx.addIssue({
          code: 'custom',
          path,
          message: `Jira credential variable "${name}" must not be passed to a setup command`,
        });
      }
    });
  });

  raw.tasks.forEach((task: RawTask, taskIndex) => {
    if (task.repo === undefined) {
      if (raw.repositories.length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', taskIndex, 'repo'],
          message: 'repo is required when more than one repository is configured',
        });
      }
    } else if (!repositoryIds.has(task.repo)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks', taskIndex, 'repo'],
        message: 'repo must reference a configured repository',
      });
    }

    (['acceptance', 'done'] as const).forEach((collection) => {
      task.checks[collection].forEach((check: PreCheck, checkIndex) => {
        if (!('run' in check)) {
          return;
        }
        if (check.timeout === undefined && raw.run.check_timeout === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['tasks', taskIndex, 'checks', collection, checkIndex, 'timeout'],
            message: 'set timeout on this check or run.check_timeout',
          });
        }
        const seenNames = new Set<string>();
        (check.env ?? []).forEach((name, nameIndex) => {
          const path = ['tasks', taskIndex, 'checks', collection, checkIndex, 'env', nameIndex];
          if (seenNames.has(name)) {
            ctx.addIssue({
              code: 'custom',
              path,
              message: `duplicate environment variable name "${name}" in check env`,
            });
          }
          seenNames.add(name);
          if (agentNames.has(name)) {
            ctx.addIssue({
              code: 'custom',
              path,
              message: `environment variable "${name}" is passed to the agent and cannot also be passed to a check`,
            });
          } else if (name === jiraEmailName || name === jiraTokenName) {
            ctx.addIssue({
              code: 'custom',
              path,
              message: `Jira credential variable "${name}" must not be passed to a check`,
            });
          }
        });
      });
    });
  });
}

function materializeTevuConfig(raw: RawTevuConfig): TevuConfig {
  const firstAgentKey = Object.keys(raw.agents)[0];
  if (firstAgentKey === undefined) {
    throw new Error(
      'unreachable: RawTevuConfigShape.agents guarantees at least one configured agent',
    );
  }
  const soleRepositoryId = raw.repositories.length === 1 ? raw.repositories[0]?.id : undefined;

  const models: ModelDefinition[] = raw.models.map((model) => ({
    id: model.id,
    model: model.model,
    effort: model.effort,
    agent: model.agent ?? firstAgentKey,
  }));

  const tasks: TaskDefinition[] = raw.tasks.map((task: RawTask) => {
    const repo = task.repo ?? soleRepositoryId;
    if (repo === undefined) {
      throw new Error('unreachable: refineTevuConfig guarantees a resolvable repository id');
    }
    return {
      id: task.id,
      title: task.title,
      repo,
      base_commit: task.base_commit,
      prompt: task.prompt,
      description: task.description,
      ...(task.source === undefined ? {} : { source: task.source }),
      readiness: task.readiness,
      checks: {
        ...(task.checks.restore === undefined ? {} : { restore: task.checks.restore }),
        ...(task.checks.overlay === undefined ? {} : { overlay: task.checks.overlay }),
        acceptance: task.checks.acceptance.map((check) =>
          resolveCheck(check, raw.run.check_timeout),
        ),
        done: task.checks.done.map((check) => resolveCheck(check, raw.run.check_timeout)),
      },
    };
  });

  return {
    version: 1,
    run: raw.run,
    agents: raw.agents,
    ...(raw.trackers === undefined ? {} : { trackers: raw.trackers }),
    repositories: raw.repositories,
    models,
    tasks,
  };
}

/** One resolved tevu configuration: every default materialized, ready for its consumers. */
export interface TevuConfig {
  version: 1;
  run: RunSettings;
  agents: Record<string, AgentSettings>;
  trackers?: { jira?: JiraTrackerSettings };
  repositories: RepositoryDefinition[];
  models: ModelDefinition[];
  tasks: TaskDefinition[];
}

/**
 * Parses and validates one tevu configuration document, enforcing the
 * cross-field rules and defaults of the configuration reference: unique
 * identifiers, agent and repository references, environment-variable
 * separation, and check-timeout resolution.
 */
export const TevuConfigSchema =
  RawTevuConfigShape.superRefine(refineTevuConfig).transform(materializeTevuConfig);

/** File-shape tevu configuration; fields with a default are optional. */
export type TevuConfigInput = z.input<typeof TevuConfigSchema>;

/**
 * Returns every command check's `env` name across every task, in
 * first-appearance order (tasks, then acceptance before done, then list
 * order). Module-private: {@link evaluatorEnvironmentNames} is the isolated
 * evaluator environment's ordinary allowlist.
 */
function checkEnvironmentNames(config: TevuConfig): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const task of config.tasks) {
    for (const check of [...task.checks.acceptance, ...task.checks.done]) {
      if (!('run' in check)) {
        continue;
      }
      for (const name of check.env) {
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
    }
  }
  return names;
}

/**
 * Returns every evaluator-environment variable name: {@link checkEnvironmentNames}'s
 * result and order, then each repository's `setup.env` names in configuration
 * order, first appearance wins across the combined list.
 */
export function evaluatorEnvironmentNames(config: TevuConfig): string[] {
  const names = checkEnvironmentNames(config);
  const seen = new Set(names);
  for (const repository of config.repositories) {
    for (const name of repository.setup?.env ?? []) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}
