import { TevuConfigSchema } from '@/config/schema';

import type { ModelDefinitionInput, ModelRoleInput, TaskInput } from '@/config/schema';
import type { EffortChecks, ModelListing, TevuConfig } from '@/domain/types';

type ListedModels = Extract<ModelListing, { outcome: 'listed' }>;

const BASE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** Builds a task whose checks are all commands, or whose one acceptance check is graded. */
export function buildEffortTask(id: string, options: { graded?: boolean } = {}): TaskInput {
  return {
    id,
    title: `Task ${id}`,
    repo: 'repo-1',
    base_commit: BASE_COMMIT,
    description: 'synthetic task description',
    prompt: 'synthetic task prompt',
    readiness: ['synthetic ready item'],
    checks: {
      acceptance: [
        options.graded === true
          ? { id: 'acc-graded', description: 'graded by the grader role' }
          : { id: 'acc-command', description: 'command check', run: ['true'], timeout: '1m' },
      ],
      done: [{ id: 'done-manual', description: 'manual review', manual: true }],
    },
  };
}

/**
 * The schema requires two model entries. A single one is padded with `pad` on a
 * model no listing contains, so the padding never raises an effort finding.
 */
function withSchemaMinimum(models: ModelDefinitionInput[]): ModelDefinitionInput[] {
  return models.length >= 2
    ? models
    : [...models, { id: 'pad', model: 'pad/unlisted', effort: 'effort-a' }];
}

/** Builds a parsed configuration with agent "opencode", tasks `task-a` and `task-b`, and model entry `known`. */
export function buildEffortConfig(
  overrides: {
    agents?: Record<string, { command: string }>;
    models?: ModelDefinitionInput[];
    roles?: { criteria?: ModelRoleInput; grader?: ModelRoleInput };
    tasks?: TaskInput[];
  } = {},
): TevuConfig {
  const agents = overrides.agents ?? { opencode: { command: 'opencode' } };
  return TevuConfigSchema.parse({
    version: 1,
    run: { output_dir: '/synthetic/artifacts', concurrency: 1, timeout: '10m', stop_grace: '3s' },
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, agent]) => [name, { ...agent, secrets: [], env: [] }]),
    ),
    repositories: [{ id: 'repo-1', path: '/synthetic/repo-1' }],
    models: withSchemaMinimum(
      overrides.models ?? [{ id: 'known', model: 'prov/model-a', effort: 'effort-a' }],
    ),
    ...(overrides.roles === undefined ? {} : { roles: overrides.roles }),
    tasks: overrides.tasks ?? [buildEffortTask('task-a'), buildEffortTask('task-b')],
  });
}

/** Builds a listing that settled as `listed`; `variants` maps a model to its reported variant names. */
export function buildListedModels(
  models: readonly string[],
  variants: Readonly<Record<string, readonly string[]>> = {},
): ListedModels {
  return {
    outcome: 'listed',
    models: [...models],
    variants: new Map(Object.entries(variants)),
  };
}

/** Builds the checks a clean validation records: every model entry and every declared role verified. */
export function buildVerifiedEfforts(config: TevuConfig): EffortChecks {
  return {
    models: Object.fromEntries(config.models.map((entry) => [entry.id, { status: 'verified' }])),
    roles: Object.fromEntries(
      Object.keys(config.roles ?? {}).map((role) => [role, { status: 'verified' }]),
    ),
  };
}
