import type { JiraTrackerSettings } from '@/domain/config';
import type { ParentEnvironmentSnapshot } from '@/domain/ports/environment';

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
