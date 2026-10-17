// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildCommandCheckInput,
  buildManualCheckInput,
  buildModelDefinitionInput,
  buildRepositoryInput,
  buildTaskInput,
  buildTevuConfig,
} from '@/config/__fixtures__/config.fixtures';

import { buildEnvironmentVariableNames } from './environment-variable-names';

import type { TaskInput, TevuConfigInput } from '@/config/schema';
import type { TevuConfig } from '@/domain/config';

function buildRequiredChecksTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return buildTaskInput({
    title: 'Synthetic task',
    prompt: 'implement the synthetic feature',
    checks: {
      acceptance: [
        buildCommandCheckInput({
          id: 'acc-required',
          run: ['/synthetic/acc-required'],
          exit_codes: [0],
        }),
      ],
      done: [buildManualCheckInput({ id: 'dod-required' })],
    },
    ...overrides,
  });
}

function buildDeclaredVariablesConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  return buildTevuConfig({
    agents: {
      opencode: {
        command: '/synthetic/opencode',
        secrets: ['SYNTH_AGENT_SECRET'],
        env: ['SYNTH_AGENT_ENV'],
      },
    },
    repositories: [buildRepositoryInput({ path: '/synthetic/source' })],
    models: [
      buildModelDefinitionInput({ id: 'c1', model: 'synthetic/model-a', effort: 'fast' }),
      buildModelDefinitionInput({ id: 'c2', model: 'synthetic/model-b', effort: 'deep' }),
    ],
    tasks: [buildRequiredChecksTaskInput()],
    ...overrides,
  });
}

describe('buildEnvironmentVariableNames', () => {
  it('includes the Jira token variable name when the configuration declares a Jira tracker', () => {
    const config = buildDeclaredVariablesConfig({
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
    const config = buildDeclaredVariablesConfig();

    const names = buildEnvironmentVariableNames(config);

    expect(names).not.toHaveProperty('jiraTokenVariable');
  });
});
