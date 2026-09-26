// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { TevuConfigSchema } from '@/config/schema';

import { buildEnvironmentVariableNames } from './environment-variable-names';

import type { TevuConfigInput } from '@/config/schema';
import type { TevuConfig } from '@/domain/types';

function buildTaskInput(
  overrides: Partial<TevuConfigInput['tasks'][number]> = {},
): TevuConfigInput['tasks'][number] {
  return {
    id: 'task-1',
    title: 'Synthetic task',
    repo: 'repo-1',
    base_commit: '0123456789abcdef0123456789abcdef01234567',
    description: 'synthetic task description',
    prompt: 'implement the synthetic feature',
    readiness: ['synthetic ready item'],
    checks: {
      acceptance: [
        {
          id: 'acc-required',
          description: 'acceptance command exits zero',
          run: ['/synthetic/acc-required'],
          timeout: '5s',
          exit_codes: [0],
        },
      ],
      done: [{ id: 'dod-required', description: 'manual Definition of Done review', manual: true }],
    },
    ...overrides,
  };
}

function buildConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  return TevuConfigSchema.parse({
    version: 1,
    run: { output_dir: '/synthetic/artifacts', concurrency: 1, timeout: '1m', stop_grace: '1s' },
    agents: {
      opencode: {
        command: '/synthetic/opencode',
        secrets: ['SYNTH_AGENT_SECRET'],
        env: ['SYNTH_AGENT_ENV'],
      },
    },
    repositories: [{ id: 'repo-1', path: '/synthetic/source' }],
    models: [
      { id: 'c1', model: 'synthetic/model-a', effort: 'fast' },
      { id: 'c2', model: 'synthetic/model-b', effort: 'deep' },
    ],
    tasks: [buildTaskInput()],
    ...overrides,
  });
}

describe('buildEnvironmentVariableNames', () => {
  it('includes the Jira token variable name when the configuration declares a Jira tracker', () => {
    const config = buildConfig({
      trackers: {
        jira: {
          url: 'https://synthetic-jira.example.com',
          email: '$SYNTH_JIRA_EMAIL',
          token: '$SYNTH_JIRA_TOKEN',
        },
      },
    });

    const names = buildEnvironmentVariableNames(config);

    expect(names.jiraTokenVariable).toBe('SYNTH_JIRA_TOKEN');
  });

  it('omits the jiraTokenVariable key when the configuration declares no Jira tracker', () => {
    const config = buildConfig();

    const names = buildEnvironmentVariableNames(config);

    expect(names).not.toHaveProperty('jiraTokenVariable');
  });
});
