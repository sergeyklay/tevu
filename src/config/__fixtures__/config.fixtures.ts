import { assert } from 'vitest';

import { TevuConfigSchema } from '@/config/schema';

import type {
  CheckInput,
  ModelDefinitionInput,
  RepositoryInput,
  TaskInput,
  TevuConfigInput,
} from '@/config/schema';
import type { RepositoryDefinition, TaskDefinition, TevuConfig } from '@/domain/config';

/** The agent key that agent-neutral tests run under instead of the schema-required `opencode`. */
export const FAKE_AGENT_NAME = 'fake-agent';

/**
 * Renames the schema-required `opencode` key to `fake-agent` after parsing.
 * The strict schema accepts only the literal `opencode` key, so every
 * agent-neutral test builds through that key and relabels the materialized
 * config instead of parsing `fake-agent` directly.
 */
export function rekeyToFakeAgent(config: TevuConfig): TevuConfig {
  const { opencode, ...otherAgents } = config.agents;
  assert.isDefined(opencode, 'agents.opencode block');
  return {
    ...config,
    agents: { ...otherAgents, [FAKE_AGENT_NAME]: opencode },
    models: config.models.map((model) => ({ ...model, agent: FAKE_AGENT_NAME })),
  };
}

/** Run settings as a file declares them. */
export function buildRunSettingsInput(
  overrides: Partial<TevuConfigInput['run']> = {},
): TevuConfigInput['run'] {
  return {
    output_dir: '/synthetic/artifacts',
    concurrency: 1,
    timeout: '1m',
    stop_grace: '1s',
    ...overrides,
  };
}

/** A model entry as a file declares it. */
export function buildModelDefinitionInput(
  overrides: Partial<ModelDefinitionInput> = {},
): ModelDefinitionInput {
  return { id: 'm1', model: 'vendor/model-a', effort: 'high', ...overrides };
}

/** A path repository entry as a file declares it. */
export function buildRepositoryInput(overrides: Partial<RepositoryInput> = {}): RepositoryInput {
  return { id: 'repo-1', path: '/synthetic/repo-1', ...overrides };
}

/** A resolved path repository. */
export function buildRepositoryDefinition(
  overrides: Partial<RepositoryDefinition> = {},
): RepositoryDefinition {
  return { id: 'repo-1', path: '/synthetic/repo-1', ...overrides };
}

/** An acceptance check that runs a command, as a file declares it. */
export function buildCommandCheckInput(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    id: 'acc-command',
    description: 'acceptance command exits zero',
    run: ['/synthetic/acceptance-probe', '--suite', 'synthetic'],
    timeout: '5s',
    ...overrides,
  };
}

/** A done check that a person decides, as a file declares it. */
export function buildManualCheckInput(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    id: 'done-manual',
    description: 'manual Definition of Done review',
    manual: true,
    ...overrides,
  };
}

/** A task as a file declares it, on the repository `buildRepositoryInput` declares. */
export function buildTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    title: 'Fix the login redirect',
    repo: 'repo-1',
    base_commit: '0123456789abcdef0123456789abcdef01234567',
    description: 'synthetic task description',
    prompt: 'synthetic task prompt',
    readiness: ['synthetic ready item'],
    checks: { acceptance: [buildCommandCheckInput()], done: [buildManualCheckInput()] },
    ...overrides,
  };
}

/** A configuration as a file declares it; it parses against the schema. */
export function buildTevuConfigInput(overrides: Partial<TevuConfigInput> = {}): TevuConfigInput {
  return {
    version: 1,
    run: buildRunSettingsInput(),
    agents: { opencode: { command: '/synthetic/opencode', secrets: [], env: [] } },
    repositories: [buildRepositoryInput()],
    models: [
      buildModelDefinitionInput(),
      buildModelDefinitionInput({ id: 'm2', model: 'vendor/model-b', effort: 'low' }),
    ],
    tasks: [buildTaskInput()],
    ...overrides,
  };
}

/**
 * Materializes a configuration through the schema, so a default the schema
 * rejects throws in every test that builds one.
 */
export function buildTevuConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  return TevuConfigSchema.parse(buildTevuConfigInput(overrides));
}

/**
 * Materializes one task through the schema so every default (required, evaluator, etc.) is resolved.
 *
 * @throws When the schema rejects a value, or the parse yields no task.
 */
export function buildTaskDefinition(overrides: Partial<TaskInput> = {}): TaskDefinition {
  const task = buildTevuConfig({ tasks: [buildTaskInput(overrides)] }).tasks[0];
  if (task === undefined) {
    throw new Error('expected the fixture configuration to materialize its task');
  }
  return task;
}
