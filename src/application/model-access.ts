/**
 * Model access checks for the `tevu task add` setup interview: probes an
 * agent command, names the provider of an entered model, and reports whether
 * the agent lists the model in an environment built like a case agent's.
 * Reads operator files and starts only capability probes and model listings;
 * never writes and never starts a model session.
 *
 * Entry points: {@link probeAgent}, {@link inspectModelProvider}, and
 * {@link checkModelAccess}.
 */

import * as path from 'node:path';

import { resolveAgentCommand } from '@/config/load';
import { AGENT_NAMES } from '@/config/schema';

import { listModelsInCallEnvironment } from './model-call';

import type {
  AgentAdapter,
  AgentCapabilityReport,
  AgentProviderSetting,
  AgentRegistry,
  EnvironmentAdapter,
  GitWorkspaceAdapter,
  OperatorProvider,
  TevuConfig,
  TevuResult,
  ValidationFinding,
} from '@/domain/types';

/** The `agents.opencode` answers of a setup interview so far; `command` as typed. */
export type AgentDraft = {
  command: string;
  secrets: readonly string[];
  env: readonly string[];
  providers: readonly AgentProviderSetting[];
};

/** The provider a model identifier names and what the operator's configuration defines for it. */
export type ModelProviderInspection = { provider: string; definition: OperatorProvider };

/**
 * What checking one model found: listed or not, why no answer exists, or a
 * cancellation. Every status except `provider-rejected` carries
 * `retainedDirectory`, the listing's call directory whose removal failed;
 * `provider-rejected` is returned before that directory exists.
 */
export type ModelAccessOutcome =
  | {
      status: 'listed';
      /** The model's reported variant names; `null` when the listing carried no readable variant data for it. */
      variants: readonly string[] | null;
      /** Declared variables tevu's own environment leaves unset; the check ran without them. */
      unsetVariables: readonly string[];
      retainedDirectory: string | null;
    }
  | { status: 'not-listed'; unsetVariables: readonly string[]; retainedDirectory: string | null }
  | { status: 'provider-rejected'; findings: readonly ValidationFinding[] }
  | { status: 'listing-failed'; detail: string; retainedDirectory: string | null }
  | { status: 'cancelled'; retainedDirectory: string | null };

/** Effects injected into the model access checks. */
export type ModelAccessDependencies = {
  agentsFor: (config: Pick<TevuConfig, 'agents'>) => AgentRegistry;
  environments: EnvironmentAdapter;
  git: Pick<GitWorkspaceAdapter, 'initializeEmptyRepository'>;
  cancellation: AbortSignal;
};

type ModelIdentifier = `${string}/${string}`;

const AGENT_NAME = AGENT_NAMES[0];

/**
 * Runs the agent's capability probe for `command`, resolved against the
 * configuration file's directory.
 */
export async function probeAgent(
  request: { configPath: string; command: string },
  dependencies: ModelAccessDependencies,
): Promise<TevuResult<AgentCapabilityReport, 'PrerequisiteError' | 'AgentProtocolError'>> {
  const adapter = buildAdapter(
    request.configPath,
    { command: request.command, secrets: [], env: [], providers: [] },
    dependencies,
  );
  if (adapter === undefined) {
    return {
      ok: false,
      error: {
        kind: 'PrerequisiteError',
        tool: AGENT_NAME,
        expected: 'a registered agent adapter',
        actual: 'none',
      },
    };
  }
  return adapter.probe();
}

/**
 * Names the provider of `model`, the text before its first `/`, and reads
 * what the operator's configuration defines for it. Reads names and states
 * only, never a value.
 */
export async function inspectModelProvider(
  request: { configPath: string; agent: AgentDraft; model: ModelIdentifier },
  dependencies: ModelAccessDependencies,
): Promise<TevuResult<ModelProviderInspection, 'ConfigValidationError'>> {
  const adapter = buildAdapter(request.configPath, request.agent, dependencies);
  if (adapter === undefined) {
    return unregisteredAgent();
  }
  const provider = request.model.slice(0, request.model.indexOf('/'));
  const inspected = await adapter.inspectOperatorProvider(provider);
  if (!inspected.ok) {
    return inspected;
  }
  return { ok: true, value: { provider, definition: inspected.value } };
}

/**
 * Reports whether `model` resolves for `agent` in an environment built like
 * a case agent's: the agent's copied providers, its declared variables that
 * tevu's own environment sets, and an empty repository as working directory.
 * A listed model is declared, not proven reachable.
 */
export async function checkModelAccess(
  request: { configPath: string; agent: AgentDraft; model: ModelIdentifier },
  dependencies: ModelAccessDependencies,
): Promise<ModelAccessOutcome> {
  const adapter = buildAdapter(request.configPath, request.agent, dependencies);
  if (adapter === undefined) {
    return {
      status: 'listing-failed',
      detail: 'no adapter is registered for the agent',
      retainedDirectory: null,
    };
  }
  const copied = await adapter.readProviders();
  if (!copied.ok) {
    return { status: 'provider-rejected', findings: copied.error.findings };
  }

  const { secrets, env } = request.agent;
  const unset = dependencies.environments.unsetVariables([...secrets, ...env]);
  const agentVariables = {
    secrets: secrets.filter((name) => !unset.includes(name)),
    env: env.filter((name) => !unset.includes(name)),
  };
  const snapshot = dependencies.environments.snapshotParent({
    agents: { [AGENT_NAME]: agentVariables },
    ordinaryEvaluator: [],
  });
  if (!snapshot.ok) {
    const { tool, expected, actual } = snapshot.error;
    return {
      status: 'listing-failed',
      detail: `prerequisite "${tool}" is not satisfied; expected ${expected}${actual === undefined ? '' : `, actual ${actual}`}`,
      retainedDirectory: null,
    };
  }

  const result = await listModelsInCallEnvironment(
    adapter,
    {
      snapshot: snapshot.value,
      agentVariables,
      configurationFiles: copied.value.configurationFiles,
      cancellation: dependencies.cancellation,
    },
    dependencies,
  );
  if (!result.prepared) {
    return {
      status: 'listing-failed',
      detail: result.reason,
      retainedDirectory: result.retainedDirectory,
    };
  }

  const command = resolveCommand(request.configPath, request.agent.command);
  const { listing } = result;
  switch (listing.outcome) {
    case 'cancelled':
      return { status: 'cancelled', retainedDirectory: result.retainedDirectory };
    case 'timed-out':
      return {
        status: 'listing-failed',
        detail: `"${command} models --verbose" did not finish within ${listing.limitMs / 1000}s`,
        retainedDirectory: result.retainedDirectory,
      };
    case 'failed':
      return {
        status: 'listing-failed',
        detail: `"${command} models --verbose" ${listing.reason}`,
        retainedDirectory: result.retainedDirectory,
      };
    case 'listed':
      return listing.models.includes(request.model)
        ? {
            status: 'listed',
            variants: listing.variants.get(request.model) ?? null,
            unsetVariables: unset,
            retainedDirectory: result.retainedDirectory,
          }
        : {
            status: 'not-listed',
            unsetVariables: unset,
            retainedDirectory: result.retainedDirectory,
          };
  }
}

function resolveCommand(configPath: string, command: string): string {
  return resolveAgentCommand(command, path.dirname(path.resolve(configPath)));
}

function buildAdapter(
  configPath: string,
  agent: AgentDraft,
  dependencies: Pick<ModelAccessDependencies, 'agentsFor'>,
): AgentAdapter | undefined {
  const block = {
    command: resolveCommand(configPath, agent.command),
    secrets: [...agent.secrets],
    env: [...agent.env],
    providers: [...agent.providers],
  };
  return dependencies.agentsFor({ agents: { [AGENT_NAME]: block } }).get(AGENT_NAME);
}

function unregisteredAgent(): TevuResult<never, 'ConfigValidationError'> {
  return {
    ok: false,
    error: {
      kind: 'ConfigValidationError',
      findings: [
        {
          severity: 'error',
          identifier: `agents.${AGENT_NAME}`,
          message: 'no adapter is registered for this agent',
        },
      ],
    },
  };
}
