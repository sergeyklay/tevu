/**
 * One-shot model call through a configured agent: resolves a declared model
 * role, probes its agent, builds a private disposable environment with an
 * empty Git repository as its working directory, calls the agent once, and
 * disposes the environment unconditionally.
 *
 * Entry point: {@link callModelRole}. Its three production callers are
 * `draftCriteria`, `gradeCase`, and `writeTaskConclusions`, which describe a
 * call failure through {@link describeModelCallFailure}.
 */

import { durationMs } from '@/config/schema';

import type {
  AgentAdapter,
  AgentConfigurationFile,
  EnvironmentAdapter,
  EnvironmentVariableNames,
  GitWorkspaceAdapter,
  ModelCallDependencies,
  ModelCallEnvironment,
  ModelListing,
  ModelRoleCallOutcome,
  ModelRoleCallRequest,
  ParentEnvironmentSnapshot,
  ProviderSnapshot,
  TevuError,
  ToolDenialProbe,
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
 * inside a private, disposable, empty-Git-repository environment. The call is
 * refused before it starts unless the agent's `debug config` shows every tool
 * denied in that environment.
 *
 * `request.cancellation` is checked before the configuration lookup and again
 * before the call environment is created; a signal raised during the denial
 * check or the agent process reaches the underlying processes through the
 * adapter. The call environment is disposed whatever the call's outcome; a
 * failed removal on any path after the call directory exists is reported as
 * `retainedDirectory` beside the call's own result, never as an error that
 * replaces it.
 */
export async function callModelRole(
  request: ModelRoleCallRequest,
  dependencies: ModelCallDependencies,
): Promise<ModelRoleCallOutcome> {
  if (request.cancellation.aborted) {
    return {
      ok: false,
      error: { kind: 'CancellationError', activeCaseIds: [] },
      retainedDirectory: null,
    };
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
      retainedDirectory: null,
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
      retainedDirectory: null,
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
    return { ...snapshot, retainedDirectory: null };
  }

  const probe = await adapter.probe();
  if (!probe.ok) {
    return { ...probe, retainedDirectory: null };
  }

  let providers: ProviderSnapshot;
  if (request.providers !== undefined) {
    providers = request.providers;
  } else {
    const read = await adapter.readProviders();
    if (!read.ok) {
      return { ...read, retainedDirectory: null };
    }
    providers = read.value;
  }

  if (request.cancellation.aborted) {
    return {
      ok: false,
      error: { kind: 'CancellationError', activeCaseIds: [] },
      retainedDirectory: null,
    };
  }

  const environmentResult = await dependencies.environments.createModelCallEnvironment(
    snapshot.value,
    agentVariables,
    providers.configurationFiles,
  );
  if (!environmentResult.ok) {
    return { ...environmentResult, retainedDirectory: null };
  }
  const environment = environmentResult.value;

  const initialized = await dependencies.git.initializeEmptyRepository(
    environment.workingDirectory,
  );
  if (!initialized.ok) {
    return { ...initialized, retainedDirectory: await removalOf(environment) };
  }

  const toolDenial = await adapter.probeToolDenial(environment, request.cancellation);
  if (toolDenial.outcome === 'cancelled') {
    return {
      ok: false,
      error: { kind: 'CancellationError', activeCaseIds: [] },
      retainedDirectory: await removalOf(environment),
    };
  }
  if (toolDenial.outcome !== 'denied') {
    return {
      ok: false,
      error: {
        kind: 'AgentProtocolError',
        agent: role.agent,
        context: { phase: 'probe' },
        reason:
          toolDenial.outcome === 'not-shown'
            ? describeMissingToolDenial(toolDenial.reason)
            : describeUncheckedToolDenial(toolDenial.reason),
      },
      retainedDirectory: await removalOf(environment),
    };
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
    copiedProviders: providers.copiedProviders,
    onEvidence: request.onEvidence,
  });
  return { ...outcome, retainedDirectory: await removalOf(environment) };
}

async function removalOf(environment: ModelCallEnvironment): Promise<string | null> {
  return (await environment.dispose()).ok ? null : environment.rootDirectory;
}

/**
 * Outcome of listing models in a new call environment. `retainedDirectory`
 * names the environment's root only when removing it failed.
 */
export type CallEnvironmentListing =
  | { prepared: true; listing: ModelListing; retainedDirectory: string | null }
  | { prepared: false; reason: string; retainedDirectory: string | null };

/**
 * Outcome of checking the tool denial in a new call environment.
 * `retainedDirectory` names the environment's root only when removing it
 * failed.
 */
export type CallEnvironmentToolDenial =
  | { prepared: true; probe: ToolDenialProbe; retainedDirectory: string | null }
  | { prepared: false; reason: string; retainedDirectory: string | null };

type CallEnvironmentSetup = {
  snapshot: ParentEnvironmentSnapshot;
  agentVariables: { secrets: readonly string[]; env: readonly string[] };
  configurationFiles: readonly AgentConfigurationFile[];
  cancellation?: AbortSignal;
};

type CallEnvironmentDependencies = {
  environments: EnvironmentAdapter;
  git: Pick<GitWorkspaceAdapter, 'initializeEmptyRepository'>;
};

type InCallEnvironment<T> =
  | { prepared: true; value: T; retainedDirectory: string | null }
  | { prepared: false; reason: string; retainedDirectory: string | null };

async function withCallEnvironment<T>(
  setup: CallEnvironmentSetup,
  dependencies: CallEnvironmentDependencies,
  operate: (environment: ModelCallEnvironment) => Promise<T>,
): Promise<InCallEnvironment<T>> {
  const created = await dependencies.environments.createModelCallEnvironment(
    setup.snapshot,
    setup.agentVariables,
    setup.configurationFiles,
  );
  if (!created.ok) {
    return {
      prepared: false,
      reason: `${created.error.operation}: ${created.error.reason}`,
      retainedDirectory: null,
    };
  }
  const environment = created.value;

  const initialized = await dependencies.git.initializeEmptyRepository(
    environment.workingDirectory,
  );
  if (!initialized.ok) {
    return {
      prepared: false,
      reason: `${initialized.error.operation}: ${initialized.error.reason}`,
      retainedDirectory: await removalOf(environment),
    };
  }
  const value = await operate(environment);
  return { prepared: true, value, retainedDirectory: await removalOf(environment) };
}

/**
 * Lists the models `adapter` resolves in a new model-call environment, then
 * removes the environment on every path. The listing runs in an empty Git
 * repository, the only working directory it sees.
 */
export async function listModelsInCallEnvironment(
  adapter: AgentAdapter,
  setup: CallEnvironmentSetup,
  dependencies: CallEnvironmentDependencies,
): Promise<CallEnvironmentListing> {
  const result = await withCallEnvironment(setup, dependencies, (environment) =>
    adapter.listModels(environment, setup.cancellation),
  );
  return result.prepared
    ? { prepared: true, listing: result.value, retainedDirectory: result.retainedDirectory }
    : result;
}

/**
 * Checks, in a new model-call environment, that `adapter` is offered no tool
 * there, then removes the environment on every path. The check runs in an
 * empty Git repository, the only working directory it sees.
 */
export async function probeToolDenialInCallEnvironment(
  adapter: AgentAdapter,
  setup: CallEnvironmentSetup,
  dependencies: CallEnvironmentDependencies,
): Promise<CallEnvironmentToolDenial> {
  const result = await withCallEnvironment(setup, dependencies, (environment) =>
    adapter.probeToolDenial(environment, setup.cancellation),
  );
  return result.prepared
    ? { prepared: true, probe: result.value, retainedDirectory: result.retainedDirectory }
    : result;
}

/** The one owner of the text that names the missing capability. */
export function describeMissingToolDenial(reason: string): string {
  return `capability "model call tool denial" is missing: ${reason}`;
}

/** The one owner of the text for a check that ended without a decision. */
export function describeUncheckedToolDenial(reason: string): string {
  return `capability "model call tool denial" could not be checked: ${reason}`;
}
