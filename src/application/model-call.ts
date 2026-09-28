/**
 * One-shot model call through a configured agent: resolves a declared model
 * role, probes its agent, builds a private disposable environment with an
 * empty Git repository as its working directory, calls the agent once, and
 * disposes the environment unconditionally.
 *
 * Entry point: {@link callModelRole}. Its two production callers are
 * `draftCriteria` and `gradeCase`, which both describe a call failure through
 * {@link describeModelCallFailure}.
 */

import { durationMs } from '@/config/schema';

import type {
  EnvironmentVariableNames,
  ModelCallDependencies,
  ModelRoleCallRequest,
  ModelRoleCallResult,
  ProviderSnapshot,
  TevuError,
  TevuResult,
} from '@/domain/types';

/** Identifier-only text for a model-role call failure; never includes a secret value. */
export function describeModelCallFailure(
  error: Extract<
    TevuError,
    {
      kind:
        | 'ModelCallError'
        | 'AgentProtocolError'
        | 'PrerequisiteError'
        | 'ArtifactError'
        | 'ConfigValidationError';
    }
  >,
): string {
  switch (error.kind) {
    case 'ModelCallError':
      return `ModelCallError (${error.cause}): ${error.reason}`;
    case 'AgentProtocolError':
      return `AgentProtocolError: ${error.reason}`;
    case 'PrerequisiteError':
      return `PrerequisiteError: "${error.tool}" expected ${error.expected}${
        error.actual === undefined ? '' : `, actual ${error.actual}`
      }`;
    case 'ArtifactError':
      return `ArtifactError: ${error.operation}: ${error.reason}`;
    case 'ConfigValidationError': {
      const [first] = error.findings;
      return first === undefined
        ? 'ConfigValidationError: no finding was reported'
        : `ConfigValidationError: ${first.identifier}: ${first.message}`;
    }
  }
}

/**
 * Sends `request.prompt` through the agent configured for `request.role`,
 * inside a private, disposable, empty-Git-repository environment.
 *
 * `request.cancellation` is checked before the configuration lookup and again
 * before the call environment is created; a signal raised during the agent
 * process reaches the underlying processes through `adapter.callModel`. The
 * call environment is disposed whatever the call's outcome; a disposal
 * failure after a successful call is reported as `retainedDirectory` rather
 * than as an error, and a disposal failure after a failed call is dropped in
 * favor of the call's own error.
 */
export async function callModelRole(
  request: ModelRoleCallRequest,
  dependencies: ModelCallDependencies,
): Promise<
  TevuResult<
    ModelRoleCallResult,
    | 'ConfigValidationError'
    | 'PrerequisiteError'
    | 'AgentProtocolError'
    | 'ArtifactError'
    | 'ModelCallError'
    | 'CancellationError'
  >
> {
  if (request.cancellation.aborted) {
    return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
  }

  const role = request.config.roles?.[request.role];
  if (role === undefined) {
    return {
      ok: false,
      error: {
        kind: 'ConfigValidationError',
        findings: [
          {
            severity: 'error',
            identifier: `roles.${request.role}`,
            message: 'model role is not configured',
          },
        ],
      },
    };
  }

  const adapter = dependencies.agents.get(role.agent);
  if (adapter === undefined) {
    return {
      ok: false,
      error: {
        kind: 'PrerequisiteError',
        tool: role.agent,
        expected: 'a registered agent adapter',
        actual: 'none',
      },
    };
  }

  const agentBlock = request.config.agents[role.agent];
  const agentVariables = { secrets: agentBlock.secrets, env: agentBlock.env };
  const names: EnvironmentVariableNames = {
    agents: { [role.agent]: agentVariables },
    ordinaryEvaluator: [],
  };
  const snapshot = dependencies.environments.snapshotParent(names);
  if (!snapshot.ok) {
    return snapshot;
  }

  const probe = await adapter.probe();
  if (!probe.ok) {
    return probe;
  }

  let providers: ProviderSnapshot;
  if (request.providers !== undefined) {
    providers = request.providers;
  } else {
    const read = await adapter.readProviders();
    if (!read.ok) {
      return read;
    }
    providers = read.value;
  }

  if (request.cancellation.aborted) {
    return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
  }

  const environmentResult = await dependencies.environments.createModelCallEnvironment(
    snapshot.value,
    agentVariables,
    providers.configurationFiles,
  );
  if (!environmentResult.ok) {
    return environmentResult;
  }
  const environment = environmentResult.value;

  const initialized = await dependencies.git.initializeEmptyRepository(
    environment.workingDirectory,
  );
  if (!initialized.ok) {
    await environment.dispose();
    return initialized;
  }

  const outcome = await adapter.callModel({
    role: request.role,
    model: role.model,
    effort: role.effort,
    prompt: request.prompt,
    environment,
    timeoutMs: request.timeoutMs,
    terminationGraceMs: durationMs(request.config.run.stop_grace),
    cancellation: request.cancellation,
  });
  const removal = await environment.dispose();

  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    value: {
      ...outcome.value,
      retainedDirectory: removal.ok ? null : environment.rootDirectory,
    },
  };
}
