/**
 * Builds the run-level environment-variable-names policy from configuration:
 * which names reach the agent and the evaluator, never their values.
 *
 * Entry point: {@link buildEnvironmentVariableNames}.
 */

import { evaluatorEnvironmentNames, referencedVariableName } from '@/config/schema';

import type { EnvironmentVariableNames, TevuConfig } from '@/domain/types';

/**
 * Derives the environment ports' name policy from one resolved configuration.
 *
 * `agents` preserves configuration key order; `ordinaryEvaluator` is exactly
 * {@link evaluatorEnvironmentNames}'s result and order. `jiraTokenVariable` is
 * present only when the configuration declares a Jira tracker.
 */
export function buildEnvironmentVariableNames(config: TevuConfig): EnvironmentVariableNames {
  const agents: Record<string, { secrets: readonly string[]; env: readonly string[] }> = {};
  for (const [name, settings] of Object.entries(config.agents)) {
    agents[name] = { secrets: settings.secrets, env: settings.env };
  }
  const ordinaryEvaluator = evaluatorEnvironmentNames(config);
  const jira = config.trackers?.jira;
  if (jira === undefined) {
    return { agents, ordinaryEvaluator };
  }
  return { agents, ordinaryEvaluator, jiraTokenVariable: referencedVariableName(jira.token) };
}
