import type { JiraTrackerSettings, ParentEnvironmentSnapshot } from '@/domain/types';

export function buildParentEnvironmentSnapshot(
  overrides: Partial<ParentEnvironmentSnapshot> = {},
): ParentEnvironmentSnapshot {
  return {
    path: '/usr/bin',
    agentValues: {},
    ordinaryEvaluatorValues: {},
    secretValues: [],
    ...overrides,
  };
}

export function buildJiraTrackerSettings(
  overrides: Partial<JiraTrackerSettings> = {},
): JiraTrackerSettings {
  return {
    url: 'https://jira.example.test',
    email: '$TEVU_TEST_JIRA_EMAIL',
    token: '$TEVU_TEST_JIRA_TOKEN',
    ...overrides,
  };
}
