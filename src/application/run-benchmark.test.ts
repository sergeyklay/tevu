// @vitest-environment node
import { describe, expect, it } from "vitest";

import { planBenchmark, reduceRunExitCode, runBenchmark } from "./run-benchmark.ts";
import { buildTaskPrompt } from "./task-prompt.ts";
import { TevuConfigSchema } from "../config/schema.ts";
import { unavailableBenchmarkMetrics } from "../domain/types.ts";

import type { CheckInput, TaskInput, TevuConfig, TevuConfigInput } from "../config/schema.ts";
import type {
  AgentAdapter,
  AgentCapabilityReport,
  AgentMetrics,
  AgentRegistry,
  AgentRunInput,
  AgentRunResult,
  ArtifactStore,
  CaseEnvironments,
  CaseIdentity,
  CaseLifecycle,
  CaseResult,
  CaseWorkspace,
  CheckStateRecord,
  CheckStateRequest,
  Clock,
  EnvironmentAdapter,
  EnvironmentVariableRecord,
  EvaluatorProcessAdapter,
  EvaluatorProcessRequest,
  FailureRecord,
  GitWorkspaceAdapter,
  HostProbe,
  IsolatedEnvironment,
  MetricValue,
  OverlaySnapshot,
  ParentEnvironmentSnapshot,
  PrerequisiteAdapter,
  ProcessResult,
  RedactedCapture,
  RunDependencies,
  RunFinding,
  RunManifest,
  RunResult,
  TevuError,
  TevuResult,
} from "../domain/types.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const RUN_ID = "run-0001-synthetic";
const CLOCK_BASE = "2026-01-01T00:00:00.000Z";
const AGENT_NAME = "fake-agent";

const EMPTY_CAPTURE: RedactedCapture = { text: "", totalBytes: 0, truncated: false };

/** Neutral event record the fake agent emits and counts; carries no protocol shape. */
type FakeEventRecord = { kind: "tool" } | { kind: "error" };

type FakeRunOutcome = TevuResult<
  AgentRunResult,
  "AgentProcessError" | "AgentProtocolError" | "CaseTimeoutError" | "CancellationError"
>;

type CaseRunFailure = Extract<
  TevuError,
  { kind: "AgentProcessError" | "AgentProtocolError" | "CaseTimeoutError" | "CancellationError" }
>;

type ExportFailure = Extract<TevuError, { kind: "AgentProcessError" | "AgentProtocolError" }>;

type RunScript = (input: AgentRunInput) => Promise<FakeRunOutcome>;

function unwrapOk<T, K extends TevuError["kind"]>(result: TevuResult<T, K>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, received ${result.error.kind}`);
  }
  return result.value;
}

function unwrapError<T, K extends TevuError["kind"]>(
  result: TevuResult<T, K>,
): Extract<TevuError, { kind: K }> {
  if (result.ok) {
    throw new Error("expected an error result");
  }
  return result.error;
}

function waitForSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function buildCheck(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    id: "acc-required",
    description: "acceptance command exits zero",
    run: ["/synthetic/acc-required", "--verify"],
    timeout: "5s",
    exit_codes: [0],
    env: [],
    ...overrides,
  };
}

function buildTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: "task-1",
    title: "Synthetic task",
    repo: "repo-1",
    base_commit: COMMIT_A,
    description: "synthetic task description",
    prompt: "implement the synthetic feature",
    readiness: ["synthetic ready item"],
    checks: {
      acceptance: [buildCheck({ id: "acc-required" })],
      done: [
        buildCheck({
          id: "dod-required",
          run: ["/synthetic/dod-required", "--verify"],
        }),
      ],
    },
    ...overrides,
  };
}

function buildRunSettings(overrides: Partial<TevuConfigInput["run"]> = {}): TevuConfigInput["run"] {
  return { output_dir: "/synthetic/artifacts", concurrency: 2, timeout: "60s", stop_grace: "500ms", ...overrides };
}

/**
 * Renames the schema-required `opencode` key to `fake-agent` after parsing.
 * The strict schema accepts only the literal `opencode` key (out of scope for
 * this migration), so every agent-neutral test builds through that key and
 * relabels the materialized config instead of parsing `fake-agent` directly.
 */
function rekeyToFakeAgent(config: TevuConfig): TevuConfig {
  const { opencode, ...otherAgents } = config.agents;
  return {
    ...config,
    agents: { ...otherAgents, [AGENT_NAME]: opencode },
    models: config.models.map((model) => ({ ...model, agent: AGENT_NAME })),
  };
}

function buildTevuConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfig {
  const config: TevuConfigInput = {
    version: 1,
    run: buildRunSettings(),
    agents: { opencode: { command: "/synthetic/fake-agent", secrets: ["TEVU_PROVIDER_KEY"], env: [] } },
    repositories: [{ id: "repo-1", path: "/synthetic/source" }],
    models: [
      { id: "c1", model: "synthetic/model-a", effort: "fast" },
      { id: "c2", model: "synthetic/model-b", effort: "deep" },
    ],
    tasks: [buildTask({ id: "task-1" }), buildTask({ id: "task-2" })],
    ...overrides,
  };
  return rekeyToFakeAgent(TevuConfigSchema.parse(config));
}

function buildCaseIdentity(caseId = "task-1--c1"): CaseIdentity {
  return {
    caseId,
    taskId: "task-1",
    modelId: "c1",
    sourceCommit: COMMIT_A,
    model: "synthetic/model-a",
    effort: "fast",
    agent: AGENT_NAME,
  };
}

function buildProcessResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    startedAt: CLOCK_BASE,
    endedAt: "2026-01-01T00:00:01.000Z",
    durationMs: 1_000,
    terminationStage: "none",
    ...overrides,
  };
}

function buildAgentRunResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    process: buildProcessResult(),
    sessionId: "session-synthetic",
    parseFindings: [],
    ...overrides,
  };
}

function buildCapabilityReport(): AgentCapabilityReport {
  return {
    executable: "/synthetic/fake-agent",
    detectedVersion: "99.0.0-synthetic",
    capabilities: [{ name: "run command", required: true, availability: "available" }],
    isolation: { denyOutsideWorktree: "available" },
  };
}

function buildHostProbe(): HostProbe {
  return {
    platform: "linux",
    nodeVersion: "v24.0.0-synthetic",
    bunVersion: "1.2.3-synthetic",
    gitVersion: "2.45.0-synthetic",
  };
}

function buildWorkspace(identity: CaseIdentity): CaseWorkspace {
  return {
    caseId: identity.caseId,
    sourceRepositoryPath: `/synthetic/source-${identity.taskId}`,
    sourceCommit: identity.sourceCommit,
    repositoryDirectory: `/synthetic/workspaces/${identity.caseId}/repo.git`,
    worktreeDirectory: `/synthetic/workspaces/${identity.caseId}/worktree`,
    runtimeDirectory: `/synthetic/workspaces/${identity.caseId}/runtime`,
    branch: identity.caseId,
    syntheticCommit: `synthetic-${identity.caseId}`,
  };
}

function buildFakeEnvironment(
  caseId: string,
  recipient: "agent" | "evaluator",
  snapshot: ParentEnvironmentSnapshot,
): IsolatedEnvironment {
  const homeDirectory = `/synthetic/workspaces/${caseId}/runtime/${recipient}/home`;
  const temporaryDirectory = `/synthetic/workspaces/${caseId}/runtime/${recipient}/tmp`;
  const agentValues = snapshot.agentValues;
  const variables: Record<string, string> = {
    PATH: snapshot.path,
    HOME: homeDirectory,
    TMPDIR: temporaryDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    ...(recipient === "agent" ? agentValues : {}),
  };
  const configuredNames =
    recipient === "agent" ? Object.keys(agentValues) : Object.keys(snapshot.ordinaryEvaluatorValues);
  const variableManifest: EnvironmentVariableRecord[] = [
    ...["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI"].map((name) => ({
      name,
      classification: "fixed" as const,
      recipient,
    })),
    ...configuredNames.map((name) => ({
      name,
      classification: recipient === "agent" ? ("secret" as const) : ("ordinary" as const),
      recipient,
    })),
  ];
  return { caseId, recipient, homeDirectory, temporaryDirectory, variables, variableManifest };
}

function buildCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    schemaVersion: 1,
    identity: buildCaseIdentity(),
    lifecycle: "completed",
    process: null,
    outcome: "passed",
    checks: [],
    metrics: unavailableBenchmarkMetrics("synthetic metrics unavailable"),
    artifacts: {
      events: null,
      diagnostics: null,
      sessionExport: null,
      solutionPatch: null,
      checks: null,
      assessment: null,
      result: "task-1--c1/result.json",
    },
    failure: null,
    ...overrides,
  };
}

function buildFailureRecord(overrides: Partial<FailureRecord> = {}): FailureRecord {
  return {
    error: { kind: "AgentProcessError", agent: AGENT_NAME, caseId: "task-1--c1", exitCode: 3, signal: null },
    occurredAt: CLOCK_BASE,
    ...overrides,
  };
}

function buildRunFinding(overrides: Partial<RunFinding> = {}): RunFinding {
  return { severity: "warning", caseId: null, message: "synthetic finding", ...overrides };
}

function defaultRunScript(input: AgentRunInput): Promise<FakeRunOutcome> {
  return successfulRunScript(input);
}

async function successfulRunScript(input: AgentRunInput): Promise<FakeRunOutcome> {
  const sessionId = `session-${input.identity.caseId}`;
  await input.onEvent({ kind: "tool" } satisfies FakeEventRecord);
  const value = buildAgentRunResult({ sessionId });
  input.onProcess?.(value);
  return { ok: true, value };
}

function failedRunScript(
  error: CaseRunFailure,
  options: { withErrorEvent?: boolean } = {},
): RunScript {
  return async (input) => {
    const sessionId = `session-${input.identity.caseId}`;
    await input.onEvent({ kind: "tool" } satisfies FakeEventRecord);
    if (options.withErrorEvent === true) {
      await input.onEvent({ kind: "error" } satisfies FakeEventRecord);
    }
    const value = buildAgentRunResult({
      sessionId,
      process: buildProcessResult({ exitCode: 3, durationMs: 4_321 }),
    });
    input.onProcess?.(value);
    return { ok: false, error };
  };
}

function timedOutRunScript(): RunScript {
  return async (input) => {
    const sessionId = `session-${input.identity.caseId}`;
    await input.onEvent({ kind: "tool" } satisfies FakeEventRecord);
    await input.onEvent({ kind: "error" } satisfies FakeEventRecord);
    const value = buildAgentRunResult({
      sessionId,
      process: buildProcessResult({
        exitCode: null,
        signal: "SIGKILL",
        durationMs: 4_321,
        terminationStage: "forced",
      }),
    });
    input.onProcess?.(value);
    return {
      ok: false,
      error: { kind: "CaseTimeoutError", caseId: input.identity.caseId, timeoutMs: 60_000 },
    };
  };
}

/** Sums fixed values matching a fully available root-session export; verified verbatim by the tests below. */
function buildFullMetrics(): AgentMetrics {
  const measured = (value: number, unit: MetricValue["unit"]): MetricValue => ({
    value,
    unit,
    availability: { status: "available", source: "root-session export" },
    scope: "root-session",
  });
  return {
    inputTokens: measured(10, "token"),
    outputTokens: measured(20, "token"),
    reasoningTokens: measured(3, "token"),
    cacheReadTokens: measured(4, "token"),
    cacheWriteTokens: measured(5, "token"),
    turns: measured(1, "count"),
    apiCalls: measured(1, "count"),
    apiErrors: measured(0, "count"),
    toolCalls: measured(0, "count"),
    skillCalls: measured(0, "count"),
    cost: measured(0.25, "USD"),
  };
}

/** Counts the neutral event records the fake agent's own `run` emitted; mirrors a real adapter's event fallback. */
function buildEventFallbackMetrics(reason: string, events: readonly unknown[]): AgentMetrics {
  const unavailable = (unit: MetricValue["unit"]): MetricValue => ({
    value: null,
    unit,
    availability: { status: "unavailable", reason },
    scope: "root-session",
  });
  const measured = (value: number, unit: MetricValue["unit"]): MetricValue => ({
    value,
    unit,
    availability: { status: "available", source: "run events" },
    scope: "root-session",
  });
  const records = events as FakeEventRecord[];
  return {
    inputTokens: unavailable("token"),
    outputTokens: unavailable("token"),
    reasoningTokens: unavailable("token"),
    cacheReadTokens: unavailable("token"),
    cacheWriteTokens: unavailable("token"),
    turns: unavailable("count"),
    apiCalls: unavailable("count"),
    apiErrors: measured(records.filter((event) => event.kind === "error").length, "count"),
    toolCalls: measured(records.filter((event) => event.kind === "tool").length, "count"),
    skillCalls: measured(0, "count"),
    cost: unavailable("USD"),
  };
}

function createHarness(config: TevuConfig) {
  const timeline: string[] = [];
  const lifecycleEvents: Array<{ caseId: string; lifecycle: CaseLifecycle }> = [];
  const cancellationController = new AbortController();

  const gitState = {
    validatedCommits: [] as Array<{ repositoryId: string; commit: string }>,
    unreadableCaseIds: new Set<string>(),
    disposeErrors: new Map<string, Extract<TevuError, { kind: "ArtifactError" }>>(),
    validateSourceError: null as Extract<TevuError, { kind: "SourceMaterializationError" }> | null,
    createIsolatedCaseError: null as
      | Extract<TevuError, { kind: "SourceMaterializationError" | "IsolationError" }>
      | null,
    readOverlayCalls: [] as string[],
    readOverlayError: null as Extract<TevuError, { kind: "CheckStateError" }> | null,
    readOverlaySnapshots: new Map<string, OverlaySnapshot>(),
    applyCheckStateCalls: [] as Array<{ caseId: string; request: CheckStateRequest }>,
    applyCheckStateError: null as Extract<TevuError, { kind: "CheckStateError" }> | null,
    applyCheckStateResults: new Map<string, CheckStateRecord>(),
  };

  const git: GitWorkspaceAdapter = {
    async validateSource(repository, commit) {
      gitState.validatedCommits.push({ repositoryId: repository.id, commit });
      timeline.push(`validateSource:${repository.id}`);
      if (gitState.validateSourceError !== null) {
        return { ok: false, error: gitState.validateSourceError };
      }
      return {
        ok: true,
        value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit: `pinned-${commit}` },
      };
    },
    async createIsolatedCase(identity) {
      timeline.push(`prepare:${identity.caseId}`);
      if (gitState.createIsolatedCaseError !== null) {
        return { ok: false, error: gitState.createIsolatedCaseError };
      }
      return { ok: true, value: buildWorkspace(identity) };
    },
    async capturePatch(workspace) {
      timeline.push(`patch:${workspace.caseId}`);
      return {
        ok: true,
        value: { caseId: workspace.caseId, content: `synthetic patch ${workspace.caseId}`, isEmpty: false },
      };
    },
    async dispose(workspace) {
      timeline.push(`dispose:${workspace.caseId}`);
      const error = gitState.disposeErrors.get(workspace.caseId);
      return error === undefined ? { ok: true, value: undefined } : { ok: false, error };
    },
    async isReadable(workspace) {
      timeline.push(`isReadable:${workspace.caseId}`);
      return !gitState.unreadableCaseIds.has(workspace.caseId);
    },
    async readOverlay(directory) {
      gitState.readOverlayCalls.push(directory);
      timeline.push(`readOverlay:${directory}`);
      if (gitState.readOverlayError !== null) {
        return { ok: false, error: gitState.readOverlayError };
      }
      return { ok: true, value: gitState.readOverlaySnapshots.get(directory) ?? [] };
    },
    async applyCheckState(workspace, request) {
      gitState.applyCheckStateCalls.push({ caseId: workspace.caseId, request });
      timeline.push(`applyCheckState:${workspace.caseId}`);
      if (gitState.applyCheckStateError !== null) {
        return { ok: false, error: gitState.applyCheckStateError };
      }
      return {
        ok: true,
        value: gitState.applyCheckStateResults.get(workspace.caseId) ?? { restore: null, overlay: null },
      };
    },
  };

  let heldRuns: PromiseWithResolvers<void> | null = null;
  const startedSignals = new Map<string, PromiseWithResolvers<void>>();

  const agentState = {
    runCalls: new Map<string, number>(),
    runInputs: [] as AgentRunInput[],
    startedOrder: [] as string[],
    scripts: new Map<string, RunScript>(),
    exportCalls: [] as string[],
    exportFailures: new Map<string, ExportFailure>(),
    activeCount: 0,
    maxActiveCount: 0,
    probeError: null as Extract<TevuError, { kind: "PrerequisiteError" | "AgentProtocolError" }> | null,
  };

  const fakeAdapter: AgentAdapter = {
    async probe() {
      timeline.push("probe");
      if (agentState.probeError !== null) {
        return { ok: false, error: agentState.probeError };
      }
      return { ok: true, value: buildCapabilityReport() };
    },
    async run(input) {
      const caseId = input.identity.caseId;
      agentState.runCalls.set(caseId, (agentState.runCalls.get(caseId) ?? 0) + 1);
      agentState.startedOrder.push(caseId);
      agentState.runInputs.push(input);
      agentState.activeCount += 1;
      agentState.maxActiveCount = Math.max(agentState.maxActiveCount, agentState.activeCount);
      startedSignals.get(caseId)?.resolve();
      timeline.push(`run:start:${caseId}`);
      if (heldRuns !== null) {
        await heldRuns.promise;
      }
      const script = agentState.scripts.get(caseId) ?? defaultRunScript;
      const outcome = await script(input);
      agentState.activeCount -= 1;
      timeline.push(`run:end:${caseId}`);
      return outcome;
    },
    async exportSession(sessionId) {
      agentState.exportCalls.push(sessionId);
      timeline.push(`exportSession:${sessionId}`);
      const failure = agentState.exportFailures.get(sessionId);
      if (failure !== undefined) {
        return { ok: false, error: failure };
      }
      return { ok: true, value: { rootSessionId: sessionId } };
    },
    normalizeMetrics(input) {
      if (input.sessionExport !== null) {
        return { ok: true, value: buildFullMetrics() };
      }
      const reason = input.exportUnavailableReason ?? "root session export unavailable";
      return { ok: true, value: buildEventFallbackMetrics(reason, input.events) };
    },
  };
  const agents: AgentRegistry = new Map([[AGENT_NAME, fakeAdapter]]);

  const artifactState = {
    failOnce: new Map<string, Extract<TevuError, { kind: "ArtifactError" }>>(),
    startedManifests: [] as RunManifest[],
    finalizedCases: [] as CaseResult[],
    finalizedRuns: [] as RunResult[],
  };

  const recordArtifactCall = (operation: string, key: string): TevuResult<void, "ArtifactError"> => {
    timeline.push(`${operation}:${key}`);
    const failure = artifactState.failOnce.get(`${operation}:${key}`);
    if (failure !== undefined) {
      artifactState.failOnce.delete(`${operation}:${key}`);
      return { ok: false, error: failure };
    }
    return { ok: true, value: undefined };
  };

  const artifacts: ArtifactStore = {
    caseArtifactPaths(caseId) {
      return {
        events: `${caseId}/events.jsonl`,
        diagnostics: `${caseId}/stderr.log`,
        sessionExport: `${caseId}/session.json`,
        solutionPatch: `${caseId}/solution.patch`,
        checks: `${caseId}/checks.json`,
        assessment: `${caseId}/assessment.json`,
        result: `${caseId}/result.json`,
      };
    },
    async startRun(manifest) {
      artifactState.startedManifests.push(manifest);
      return recordArtifactCall("startRun", manifest.runId);
    },
    async appendEvent(caseId) {
      return recordArtifactCall("appendEvent", caseId);
    },
    async appendDiagnostic(caseId) {
      return recordArtifactCall("appendDiagnostic", caseId);
    },
    async writeSessionExport(caseId) {
      return recordArtifactCall("writeSessionExport", caseId);
    },
    async writePatch(caseId) {
      return recordArtifactCall("writePatch", caseId);
    },
    async writeChecks(caseId) {
      return recordArtifactCall("writeChecks", caseId);
    },
    async finalizeCase(result) {
      artifactState.finalizedCases.push(result);
      return recordArtifactCall("finalizeCase", result.identity.caseId);
    },
    async replaceCaseResult() {
      return { ok: true, value: undefined };
    },
    async finalizeRun(result) {
      artifactState.finalizedRuns.push(result);
      return recordArtifactCall("finalizeRun", result.manifest.runId);
    },
    async writeReport() {
      return { ok: true, value: undefined };
    },
    async readRunManifest() {
      return { ok: true, value: buildRunManifest() };
    },
    async readRunResult() {
      return { ok: true, value: buildRunResult() };
    },
    async readCaseResult(_runId, caseId) {
      return { ok: true, value: buildCaseResult({ identity: buildCaseIdentity(caseId) }) };
    },
    async readEvents() {
      return { ok: true, value: [] };
    },
    async readSessionExport() {
      return { ok: true, value: null };
    },
    async readChecks() {
      return { ok: true, value: [] };
    },
    async readAssessment() {
      return { ok: true, value: null };
    },
    async acquireAssessmentLock(runId, caseId) {
      return {
        ok: true,
        value: {
          runId,
          caseId,
          release: async () => ({ ok: true, value: undefined }),
        },
      };
    },
    async replaceAssessment() {
      return { ok: true, value: undefined };
    },
  };

  let checkGate: PromiseWithResolvers<void> | null = null;
  const checkSignals = new Map<string, PromiseWithResolvers<void>>();

  const evaluatorState = {
    requests: [] as EvaluatorProcessRequest[],
    exitCodes: new Map<string, number>(),
  };

  const evaluatorProcesses: EvaluatorProcessAdapter = {
    async run(request) {
      evaluatorState.requests.push(request);
      const key = request.argv[0];
      timeline.push(`check:${key}`);
      checkSignals.get(key)?.resolve();
      if (checkGate !== null) {
        await checkGate.promise;
      }
      return {
        launched: true,
        exitCode: evaluatorState.exitCodes.get(key) ?? 0,
        signal: null,
        durationMs: 5,
        timedOut: false,
        terminationStage: "none",
        stdout: EMPTY_CAPTURE,
        stderr: EMPTY_CAPTURE,
      };
    },
  };

  const environmentState = {
    snapshotValue: {
      path: "/synthetic/bin:/usr/bin",
      agentValues: { TEVU_PROVIDER_KEY: "synthetic-provider-secret" },
      ordinaryEvaluatorValues: { TEVU_EVAL_VAR: "synthetic-evaluator-value" },
      secretValues: ["synthetic-provider-secret"],
    } satisfies ParentEnvironmentSnapshot,
    snapshotParentCalls: 0,
    snapshotParentError: null as Extract<TevuError, { kind: "PrerequisiteError" }> | null,
    snapshotsReceived: [] as ParentEnvironmentSnapshot[],
    created: [] as Array<{ caseId: string; value: CaseEnvironments }>,
  };

  const environments: EnvironmentAdapter = {
    snapshotParent() {
      environmentState.snapshotParentCalls += 1;
      timeline.push("snapshotParent");
      if (environmentState.snapshotParentError !== null) {
        return { ok: false, error: environmentState.snapshotParentError };
      }
      return { ok: true, value: environmentState.snapshotValue };
    },
    async createCaseEnvironments(workspace, snapshot) {
      timeline.push(`environments:${workspace.caseId}`);
      environmentState.snapshotsReceived.push(snapshot);
      const value: CaseEnvironments = {
        agent: buildFakeEnvironment(workspace.caseId, "agent", snapshot),
        evaluator: buildFakeEnvironment(workspace.caseId, "evaluator", snapshot),
      };
      environmentState.created.push({ caseId: workspace.caseId, value });
      return { ok: true, value };
    },
  };

  const prerequisitesState = {
    probeHostCalls: 0,
    probeHostError: null as Extract<TevuError, { kind: "PrerequisiteError" }> | null,
  };

  const prerequisites: PrerequisiteAdapter = {
    async probeHost() {
      prerequisitesState.probeHostCalls += 1;
      timeline.push("probeHost");
      if (prerequisitesState.probeHostError !== null) {
        return { ok: false, error: prerequisitesState.probeHostError };
      }
      return { ok: true, value: buildHostProbe() };
    },
    hasEnvironmentVariable() {
      return true;
    },
    async probeWritableDirectory() {
      return { ok: true, value: undefined };
    },
  };

  let clockTicks = 0;
  const clock: Clock = {
    now: () => new Date(Date.parse(CLOCK_BASE) + (clockTicks += 1) * 1_000),
  };

  const dependencies: RunDependencies = {
    git,
    agents,
    artifacts,
    evaluatorProcesses,
    environments,
    prerequisites,
    clock,
    generateRunId: () => RUN_ID,
    configDigest: () => "digest-synthetic",
    redact: (text) => text,
    cancellation: cancellationController.signal,
    onLifecycle: (caseId, lifecycle) => lifecycleEvents.push({ caseId, lifecycle }),
  };

  const agentHarness = Object.assign(agentState, {
    holdNewRuns(): void {
      heldRuns = Promise.withResolvers<void>();
    },
    releaseHeldRuns(): void {
      heldRuns?.resolve();
      heldRuns = null;
    },
    waitForCaseStart(caseId: string): Promise<void> {
      const existing = startedSignals.get(caseId);
      if (existing !== undefined) {
        return existing.promise;
      }
      const signal = Promise.withResolvers<void>();
      startedSignals.set(caseId, signal);
      return signal.promise;
    },
  });

  const evaluatorHarness = Object.assign(evaluatorState, {
    holdChecks(): void {
      checkGate = Promise.withResolvers<void>();
    },
    releaseChecks(): void {
      checkGate?.resolve();
      checkGate = null;
    },
    waitForCheck(argvKey: string): Promise<void> {
      const existing = checkSignals.get(argvKey);
      if (existing !== undefined) {
        return existing.promise;
      }
      const signal = Promise.withResolvers<void>();
      checkSignals.set(argvKey, signal);
      return signal.promise;
    },
  });

  return {
    config,
    dependencies,
    timeline,
    lifecycleEvents,
    cancellation: cancellationController,
    git: gitState,
    agent: agentHarness,
    artifacts: artifactState,
    evaluatorProcesses: evaluatorHarness,
    environments: environmentState,
    prerequisites: prerequisitesState,
  };
}

type Harness = ReturnType<typeof createHarness>;

function caseResultOf(run: RunResult, caseId: string): CaseResult {
  const found = run.cases.find((entry) => entry.identity.caseId === caseId);
  if (found === undefined) {
    throw new Error(`missing case result for ${caseId}`);
  }
  return found;
}

async function runCancelledDuringEvaluation(): Promise<{
  run: RunResult;
  harness: Harness;
}> {
  const config = buildTevuConfig({
    run: buildRunSettings({ concurrency: 1 }),
    tasks: [buildTask()],
  });
  const harness = createHarness(config);
  harness.evaluatorProcesses.holdChecks();
  const firstCheck = harness.evaluatorProcesses.waitForCheck("/synthetic/acc-required");

  const runPromise = runBenchmark(planBenchmark(config), harness.dependencies);
  await firstCheck;
  harness.cancellation.abort();
  harness.evaluatorProcesses.releaseChecks();
  const result = await runPromise;
  return { run: unwrapOk(result), harness };
}

async function runWithFailingExport(
  buildError: (caseId: string) => ExportFailure,
): Promise<{ run: RunResult; harness: Harness }> {
  const config = buildTevuConfig({ tasks: [buildTask()] });
  const harness = createHarness(config);
  harness.agent.exportFailures.set("session-task-1--c1", buildError("task-1--c1"));
  const result = await runBenchmark(planBenchmark(config), harness.dependencies);
  return { run: unwrapOk(result), harness };
}

function expectAvailableMetric(
  metric: MetricValue,
  value: number,
  unit: MetricValue["unit"],
  source: string,
  scope: MetricValue["scope"] = "root-session",
): void {
  expect(metric).toEqual({ value, unit, availability: { status: "available", source }, scope });
}

function expectUnavailableMetric(metric: MetricValue, reasonIncludes: string): void {
  expect(metric.value).toBeNull();
  expect(metric.availability).toMatchObject({ status: "unavailable" });
  if (metric.availability.status === "unavailable") {
    expect(metric.availability.reason).toContain(reasonIncludes);
  }
}

describe("planBenchmark", () => {
  it("plans the exact task-by-contender matrix in configuration order", () => {
    const config = buildTevuConfig({
      tasks: [
        buildTask({ id: "task-1", base_commit: COMMIT_A }),
        buildTask({ id: "task-2", base_commit: COMMIT_B }),
      ],
    });

    const plan = planBenchmark(config);

    expect(plan.config).toBe(config);
    expect(plan.cases).toEqual([
      {
        caseId: "task-1--c1",
        taskId: "task-1",
        modelId: "c1",
        sourceCommit: COMMIT_A,
        model: "synthetic/model-a",
        effort: "fast",
        agent: AGENT_NAME,
      },
      {
        caseId: "task-1--c2",
        taskId: "task-1",
        modelId: "c2",
        sourceCommit: COMMIT_A,
        model: "synthetic/model-b",
        effort: "deep",
        agent: AGENT_NAME,
      },
      {
        caseId: "task-2--c1",
        taskId: "task-2",
        modelId: "c1",
        sourceCommit: COMMIT_B,
        model: "synthetic/model-a",
        effort: "fast",
        agent: AGENT_NAME,
      },
      {
        caseId: "task-2--c2",
        taskId: "task-2",
        modelId: "c2",
        sourceCommit: COMMIT_B,
        model: "synthetic/model-b",
        effort: "deep",
        agent: AGENT_NAME,
      },
    ]);
  });

  it("builds each CaseIdentity with keys in the order caseId, taskId, modelId, sourceCommit, model, effort, agent", () => {
    const config = buildTevuConfig({ tasks: [buildTask({ id: "task-1", base_commit: COMMIT_A })] });

    const plan = planBenchmark(config);

    expect(Object.keys(plan.cases[0] ?? {})).toEqual([
      "caseId",
      "taskId",
      "modelId",
      "sourceCommit",
      "model",
      "effort",
      "agent",
    ]);
  });

  it("copies the configured limits and artifact destination into the plan", () => {
    const config = buildTevuConfig();
    const plan = planBenchmark(config);

    expect(plan.concurrency).toBe(2);
    expect(plan.caseTimeoutMs).toBe(60_000);
    expect(plan.terminationGraceMs).toBe(500);
    expect(plan.artifactsDirectory).toBe("/synthetic/artifacts");
  });
});

describe("reduceRunExitCode", () => {
  it.each([
    { label: "no cases and no findings", cases: [], findings: [], cancelled: false, expected: 0 },
    { label: "an explicit cancellation flag", cases: [], findings: [], cancelled: true, expected: 130 },
    {
      label: "a cancelled case without the flag",
      cases: [buildCaseResult({ lifecycle: "cancelled" })],
      findings: [],
      cancelled: false,
      expected: 130,
    },
    {
      label: "an error-severity finding",
      cases: [],
      findings: [buildRunFinding({ severity: "error" })],
      cancelled: false,
      expected: 1,
    },
    {
      label: "an infrastructure-failed case",
      cases: [buildCaseResult({ lifecycle: "infrastructure-failed" })],
      findings: [],
      cancelled: false,
      expected: 1,
    },
    {
      label: "a timed-out case",
      cases: [buildCaseResult({ lifecycle: "timed-out" })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: "a process-failed case",
      cases: [buildCaseResult({ lifecycle: "process-failed" })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: "a failed acceptance outcome",
      cases: [buildCaseResult({ outcome: "failed" })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: "a pending acceptance outcome",
      cases: [buildCaseResult({ outcome: "pending" })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: "a completed case with a preserved runtime failure",
      cases: [buildCaseResult({ failure: buildFailureRecord() })],
      findings: [],
      cancelled: false,
      expected: 2,
    },
    {
      label: "cancellation over error findings",
      cases: [buildCaseResult({ lifecycle: "cancelled" })],
      findings: [buildRunFinding({ severity: "error" })],
      cancelled: false,
      expected: 130,
    },
    {
      label: "error findings over degraded cases",
      cases: [buildCaseResult({ lifecycle: "timed-out" })],
      findings: [buildRunFinding({ severity: "error" })],
      cancelled: false,
      expected: 1,
    },
    {
      label: "infrastructure failure over a preserved runtime failure",
      cases: [buildCaseResult({ lifecycle: "infrastructure-failed" }), buildCaseResult({ failure: buildFailureRecord() })],
      findings: [],
      cancelled: false,
      expected: 1,
    },
  ])("reduces $label to exit code $expected", ({ cases, findings, cancelled, expected }) => {
    expect(reduceRunExitCode(cases, findings, cancelled)).toBe(expected);
  });
});

describe("runBenchmark", () => {
  it("probes the host once, snapshots the parent environment once, and pins commits before the first write", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    expect(harness.timeline.slice(0, 5)).toEqual([
      "probeHost",
      "snapshotParent",
      "probe",
      "validateSource:repo-1",
      `startRun:${RUN_ID}`,
    ]);
    expect(harness.git.validatedCommits).toEqual([{ repositoryId: "repo-1", commit: COMMIT_A }]);
    expect(harness.environments.snapshotParentCalls).toBe(1);
    expect(harness.environments.snapshotsReceived).toHaveLength(4);
    expect(harness.environments.snapshotsReceived.every((s) => s === harness.environments.snapshotValue)).toBe(true);
    expect(harness.artifacts.startedManifests).toHaveLength(1);
    expect(harness.artifacts.finalizedRuns).toHaveLength(1);
    expect(run.exitCode).toBe(0);
    expect(run.findings).toEqual([]);
  });

  it("writes a manifest with pinned identities, injected provenance, and a completed timestamp", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const manifest = run.manifest;
    expect(manifest.runId).toBe(RUN_ID);
    expect(manifest.configDigest).toBe("digest-synthetic");
    expect(manifest.startedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(manifest.completedAt).not.toBeNull();
    expect(manifest.host).toEqual({
      platform: "linux",
      nodeVersion: "v24.0.0-synthetic",
      bunVersion: "1.2.3-synthetic",
    });
    expect(manifest.tools).toEqual({
      gitVersion: "2.45.0-synthetic",
      agentVersions: { [AGENT_NAME]: "99.0.0-synthetic" },
    });
    expect(manifest.execution).toEqual({ concurrency: 2, caseTimeoutMs: 60_000 });
    expect(manifest.cases).toEqual([
      {
        caseId: "task-1--c1",
        taskId: "task-1",
        modelId: "c1",
        sourceCommit: `pinned-${COMMIT_A}`,
        model: "synthetic/model-a",
        effort: "fast",
        agent: AGENT_NAME,
      },
      {
        caseId: "task-1--c2",
        taskId: "task-1",
        modelId: "c2",
        sourceCommit: `pinned-${COMMIT_A}`,
        model: "synthetic/model-b",
        effort: "deep",
        agent: AGENT_NAME,
      },
      {
        caseId: "task-2--c1",
        taskId: "task-2",
        modelId: "c1",
        sourceCommit: `pinned-${COMMIT_A}`,
        model: "synthetic/model-a",
        effort: "fast",
        agent: AGENT_NAME,
      },
      {
        caseId: "task-2--c2",
        taskId: "task-2",
        modelId: "c2",
        sourceCommit: `pinned-${COMMIT_A}`,
        model: "synthetic/model-b",
        effort: "deep",
        agent: AGENT_NAME,
      },
    ]);
    expect(manifest.context?.config).toBe(config);
    expect((manifest.context?.capabilities as Record<string, AgentCapabilityReport>)[AGENT_NAME]?.detectedVersion).toBe(
      "99.0.0-synthetic",
    );
    expect(harness.artifacts.startedManifests[0]?.completedAt).toBeNull();
    expect(run.cases.every((entry) => entry.identity.sourceCommit === `pinned-${COMMIT_A}`)).toBe(true);
  });

  it("returns the host probe failure before any write", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);
    harness.prerequisites.probeHostError = { kind: "PrerequisiteError", tool: "git", expected: "git on PATH", actual: "missing" };

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const error = unwrapError(result);
    expect(error.kind).toBe("PrerequisiteError");
    expect(harness.environments.snapshotParentCalls).toBe(0);
    expect(harness.agent.runCalls.size).toBe(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
  });

  it("returns the snapshot failure before the capability probe and any write", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);
    harness.environments.snapshotParentError = {
      kind: "PrerequisiteError",
      tool: "environment",
      expected: "non-empty parent PATH",
      actual: "empty",
    };

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const error = unwrapError(result);
    expect(error.kind).toBe("PrerequisiteError");
    expect(harness.prerequisites.probeHostCalls).toBe(1);
    expect(harness.agent.runCalls.size).toBe(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
  });

  it("returns the capability probe failure before commit pinning and any write", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);
    harness.agent.probeError = {
      kind: "AgentProtocolError",
      agent: AGENT_NAME,
      context: { phase: "probe" },
      reason: "synthetic missing run command",
    };

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const error = unwrapError(result);
    expect(error).toMatchObject({ kind: "AgentProtocolError", context: { phase: "probe" } });
    expect(harness.git.validatedCommits).toHaveLength(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.lifecycleEvents).toEqual([]);
  });

  it("returns a PrerequisiteError naming the agent when no adapter is registered for it", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);
    harness.dependencies.agents = new Map();

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "PrerequisiteError",
        tool: AGENT_NAME,
        expected: "a registered agent adapter",
        actual: "none",
      },
    });
  });

  it("remaps source resolution failures to the owning task before any write", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);
    harness.git.validateSourceError = {
      kind: "SourceMaterializationError",
      taskId: "repo-1",
      reason: "synthetic commit is not readable",
    };

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const error = unwrapError(result);
    expect(error).toMatchObject({ kind: "SourceMaterializationError", taskId: "task-1" });
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.agent.runCalls.size).toBe(0);
  });

  it("fails before any case starts when a planned case's prompt names its resolved commit", async () => {
    const config = buildTevuConfig({
      tasks: [
        buildTask({ id: "task-1" }),
        buildTask({ id: "task-2", prompt: "the agent prompt names pinned-something" }),
      ],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "SourceMaterializationError",
        taskId: "task-2",
        reason: "agent prompt contains resolved base commit pinned-",
      },
    });
    expect(harness.timeline).toEqual(["probeHost", "snapshotParent", "probe", "validateSource:repo-1"]);
  });

  it("fails before any case starts when the first, uncached task's prompt names its resolved commit", async () => {
    const config = buildTevuConfig({
      tasks: [
        buildTask({ id: "task-1", prompt: "the agent prompt names pinned-something" }),
        buildTask({ id: "task-2" }),
      ],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "SourceMaterializationError",
        taskId: "task-1",
        reason: "agent prompt contains resolved base commit pinned-",
      },
    });
    expect(harness.timeline).toEqual(["probeHost", "snapshotParent", "probe", "validateSource:repo-1"]);
  });

  it("runs the complete per-case pipeline in order with the patch captured before evaluators", async () => {
    const config = buildTevuConfig({
      run: buildRunSettings({ concurrency: 1 }),
      tasks: [buildTask()],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const caseTimeline = (caseId: string): string[] => [
      `prepare:${caseId}`,
      `environments:${caseId}`,
      `run:start:${caseId}`,
      `appendEvent:${caseId}`,
      `run:end:${caseId}`,
      `exportSession:session-${caseId}`,
      `writeSessionExport:${caseId}`,
      `patch:${caseId}`,
      `writePatch:${caseId}`,
      "check:/synthetic/acc-required",
      "check:/synthetic/dod-required",
      `writeChecks:${caseId}`,
      `finalizeCase:${caseId}`,
      `dispose:${caseId}`,
    ];
    expect(harness.timeline).toEqual([
      "probeHost",
      "snapshotParent",
      "probe",
      "validateSource:repo-1",
      `startRun:${RUN_ID}`,
      ...caseTimeline("task-1--c1"),
      ...caseTimeline("task-1--c2"),
      `finalizeRun:${RUN_ID}`,
    ]);
    expect(harness.lifecycleEvents).toEqual([
      { caseId: "task-1--c1", lifecycle: "queued" },
      { caseId: "task-1--c2", lifecycle: "queued" },
      { caseId: "task-1--c1", lifecycle: "preparing" },
      { caseId: "task-1--c1", lifecycle: "running" },
      { caseId: "task-1--c1", lifecycle: "evaluating" },
      { caseId: "task-1--c1", lifecycle: "completed" },
      { caseId: "task-1--c2", lifecycle: "preparing" },
      { caseId: "task-1--c2", lifecycle: "running" },
      { caseId: "task-1--c2", lifecycle: "evaluating" },
      { caseId: "task-1--c2", lifecycle: "completed" },
    ]);

    const runInput = harness.agent.runInputs[0];
    expect(runInput).toBeDefined();
    expect(runInput?.identity).toEqual({ ...buildCaseIdentity("task-1--c1"), sourceCommit: `pinned-${COMMIT_A}` });
    const task = config.tasks[0];
    expect(task).toBeDefined();
    expect(runInput?.prompt).toBe(task === undefined ? undefined : buildTaskPrompt(task));
    expect(runInput?.prompt).not.toContain(`pinned-${COMMIT_A}`);
    expect(runInput?.worktreeDirectory).toBe("/synthetic/workspaces/task-1--c1/worktree");
    expect(runInput?.environment).toBe(harness.environments.created[0]?.value.agent);
    expect(runInput?.timeoutMs).toBe(60_000);
    expect(runInput?.terminationGraceMs).toBe(500);
    expect(runInput?.cancellation.aborted).toBe(false);

    const caseRequests = harness.evaluatorProcesses.requests.filter(
      (request) => request.cwd === "/synthetic/workspaces/task-1--c1/worktree",
    );
    expect(caseRequests.map((request) => request.argv[0])).toEqual([
      "/synthetic/acc-required",
      "/synthetic/dod-required",
    ]);
    const evaluatorRequest = caseRequests[0];
    expect(evaluatorRequest?.argv).toEqual(["/synthetic/acc-required", "--verify"]);
    expect(evaluatorRequest?.cwd).toBe("/synthetic/workspaces/task-1--c1/worktree");
    expect(evaluatorRequest?.environment).toEqual(harness.environments.created[0]?.value.evaluator.variables);
    expect(evaluatorRequest?.timeoutMs).toBe(5_000);
    expect(evaluatorRequest?.terminationGraceMs).toBe(500);

    const caseResult = caseResultOf(run, "task-1--c1");
    expect(caseResult.lifecycle).toBe("completed");
    expect(caseResult.outcome).toBe("passed");
    expect(caseResult.failure).toBeNull();
    expect(caseResult.process?.exitCode).toBe(0);
    expect(caseResult.checks.map((check) => check.verdict)).toEqual(["passed", "passed"]);
    expect(caseResult.checks[0]?.evidence).toContain("exit code 0");
    expect(caseResult.artifacts).toEqual({
      events: "task-1--c1/events.jsonl",
      diagnostics: null,
      sessionExport: "task-1--c1/session.json",
      solutionPatch: "task-1--c1/solution.patch",
      checks: "task-1--c1/checks.json",
      assessment: null,
      result: "task-1--c1/result.json",
    });
    expectAvailableMetric(caseResult.metrics.elapsed, 1_000, "millisecond", "process", "case");
    expectAvailableMetric(caseResult.metrics.inputTokens, 10, "token", "root-session export");
    expectAvailableMetric(caseResult.metrics.turns, 1, "count", "root-session export");
    expectAvailableMetric(caseResult.metrics.apiErrors, 0, "count", "root-session export");
    expectAvailableMetric(caseResult.metrics.cost, 0.25, "USD", "root-session export");
  });

  it("caps active cases at the configured concurrency", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);
    harness.agent.holdNewRuns();
    const firstStart = harness.agent.waitForCaseStart("task-1--c1");
    const secondStart = harness.agent.waitForCaseStart("task-1--c2");

    const runPromise = runBenchmark(planBenchmark(config), harness.dependencies);
    await Promise.all([firstStart, secondStart]);

    expect(harness.agent.activeCount).toBe(2);
    expect(harness.agent.maxActiveCount).toBe(2);
    expect(harness.agent.startedOrder).toEqual(["task-1--c1", "task-1--c2"]);

    harness.agent.releaseHeldRuns();
    const result = await runPromise;

    const run = unwrapOk(result);
    expect(harness.agent.maxActiveCount).toBe(2);
    expect(harness.agent.runCalls.size).toBe(4);
    expect(run.cases).toHaveLength(4);
    expect(run.cases.every((entry) => entry.lifecycle === "completed")).toBe(true);
  });

  it("keeps the concurrency slot held while acceptance checks evaluate", async () => {
    const config = buildTevuConfig({
      run: buildRunSettings({ concurrency: 1 }),
      tasks: [buildTask()],
    });
    const harness = createHarness(config);
    harness.evaluatorProcesses.holdChecks();
    const firstCheck = harness.evaluatorProcesses.waitForCheck("/synthetic/acc-required");

    const runPromise = runBenchmark(planBenchmark(config), harness.dependencies);
    await firstCheck;

    expect(harness.timeline.filter((entry) => entry.startsWith("prepare:"))).toEqual(["prepare:task-1--c1"]);
    expect([...harness.agent.runCalls.keys()]).toEqual(["task-1--c1"]);

    harness.evaluatorProcesses.releaseChecks();
    const result = await runPromise;

    unwrapOk(result);
    expect(harness.agent.runCalls.size).toBe(2);
    expect(harness.timeline.filter((entry) => entry.startsWith("prepare:"))).toEqual([
      "prepare:task-1--c1",
      "prepare:task-1--c2",
    ]);
  });

  describe.each([
    {
      label: "readable agent process failure",
      buildError: (caseId: string): CaseRunFailure => ({
        kind: "AgentProcessError",
        agent: AGENT_NAME,
        caseId,
        exitCode: 3,
        signal: null,
      }),
    },
    {
      label: "readable case-context agent protocol failure",
      buildError: (caseId: string): CaseRunFailure => ({
        kind: "AgentProtocolError",
        agent: AGENT_NAME,
        context: { phase: "case", caseId },
        reason: "synthetic malformed event identity",
      }),
    },
  ])("$label", ({ buildError }) => {
    it("completes evaluation, preserves the runtime failure, and forces exit 2 without retrying", async () => {
      const config = buildTevuConfig({ tasks: [buildTask()] });
      const harness = createHarness(config);
      harness.agent.scripts.set("task-1--c1", failedRunScript(buildError("task-1--c1")));

      const result = await runBenchmark(planBenchmark(config), harness.dependencies);

      const run = unwrapOk(result);
      const failedCase = caseResultOf(run, "task-1--c1");
      expect(failedCase.lifecycle).toBe("completed");
      expect(failedCase.outcome).toBe("passed");
      expect(failedCase.failure?.error).toEqual(buildError("task-1--c1"));
      expect(failedCase.process?.exitCode).toBe(3);
      expect(failedCase.checks.map((check) => check.verdict)).toEqual(["passed", "passed"]);
      expect(failedCase.artifacts.sessionExport).toBe("task-1--c1/session.json");
      expect(failedCase.artifacts.solutionPatch).toBe("task-1--c1/solution.patch");
      expect(failedCase.artifacts.checks).toBe("task-1--c1/checks.json");
      expect(failedCase.artifacts.assessment).toBeNull();
      expectAvailableMetric(failedCase.metrics.elapsed, 4_321, "millisecond", "process", "case");
      expectAvailableMetric(failedCase.metrics.inputTokens, 10, "token", "root-session export");
      expect(harness.agent.exportCalls).toHaveLength(2);
      expect(harness.agent.exportCalls).toContain("session-task-1--c1");
      expect(harness.agent.runCalls.get("task-1--c1")).toBe(1);
      expect(run.exitCode).toBe(2);

      const independentCase = caseResultOf(run, "task-1--c2");
      expect(independentCase.lifecycle).toBe("completed");
      expect(independentCase.outcome).toBe("passed");
      expect(independentCase.failure).toBeNull();
    });
  });

  describe.each([
    {
      label: "agent process error",
      buildError: (caseId: string): ExportFailure => ({
        kind: "AgentProcessError",
        agent: AGENT_NAME,
        caseId,
        exitCode: 2,
        signal: null,
      }),
    },
    {
      label: "case-context agent protocol error",
      buildError: (caseId: string): ExportFailure => ({
        kind: "AgentProtocolError",
        agent: AGENT_NAME,
        context: { phase: "case", caseId },
        reason: "synthetic export identity failure",
      }),
    },
  ])("failing root-session export with a $label", ({ buildError }) => {
    it("completes eligible checks with truthfully unavailable export metrics and continues independent cases", async () => {
      const { run, harness } = await runWithFailingExport(buildError);

      const failedExportCase = caseResultOf(run, "task-1--c1");
      expect(failedExportCase.lifecycle).toBe("completed");
      expect(failedExportCase.outcome).toBe("passed");
      expect(failedExportCase.process?.exitCode).toBe(0);
      expect(failedExportCase.checks).toHaveLength(2);
      expect(failedExportCase.checks.map((check) => check.verdict)).toEqual(["passed", "passed"]);
      expect(failedExportCase.artifacts.sessionExport).toBeNull();
      expect(failedExportCase.artifacts.checks).toBe("task-1--c1/checks.json");
      expectAvailableMetric(failedExportCase.metrics.elapsed, 1_000, "millisecond", "process", "case");
      expectAvailableMetric(failedExportCase.metrics.toolCalls, 1, "count", "run events");
      expectUnavailableMetric(failedExportCase.metrics.inputTokens, "export failed");
      expectUnavailableMetric(failedExportCase.metrics.turns, "export failed");
      expect(harness.agent.exportCalls).toContain("session-task-1--c1");

      const independentCase = caseResultOf(run, "task-1--c2");
      expect(independentCase.lifecycle).toBe("completed");
      expect(independentCase.outcome).toBe("passed");
      expectAvailableMetric(independentCase.metrics.inputTokens, 10, "token", "root-session export");
    });

    it("preserves the failing export as the case runtime failure", async () => {
      const { run } = await runWithFailingExport(buildError);

      const failedExportCase = caseResultOf(run, "task-1--c1");
      expect(failedExportCase.failure?.error).toEqual(buildError("task-1--c1"));
    });

    it("forces run exit 2 despite the passed acceptance outcome", async () => {
      const { run } = await runWithFailingExport(buildError);

      expect(run.exitCode).toBe(2);
    });
  });

  it("marks an unreadable workspace as process-failed and skips export, patch, and checks", async () => {
    const config = buildTevuConfig({ tasks: [buildTask()] });
    const harness = createHarness(config);
    harness.git.unreadableCaseIds.add("task-1--c1");
    harness.agent.scripts.set(
      "task-1--c1",
      failedRunScript(
        { kind: "AgentProcessError", agent: AGENT_NAME, caseId: "task-1--c1", exitCode: 3, signal: null },
        { withErrorEvent: true },
      ),
    );

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const failedCase = caseResultOf(run, "task-1--c1");
    expect(failedCase.lifecycle).toBe("process-failed");
    expect(failedCase.outcome).toBe("not-evaluated");
    expect(failedCase.checks).toEqual([]);
    expect(failedCase.failure?.error.kind).toBe("AgentProcessError");
    expect(failedCase.process?.exitCode).toBe(3);
    expect(failedCase.artifacts.events).toBe("task-1--c1/events.jsonl");
    expect(failedCase.artifacts.sessionExport).toBeNull();
    expect(failedCase.artifacts.solutionPatch).toBeNull();
    expect(failedCase.artifacts.checks).toBeNull();
    expectAvailableMetric(failedCase.metrics.elapsed, 4_321, "millisecond", "process", "case");
    expectAvailableMetric(failedCase.metrics.apiErrors, 1, "count", "run events");
    expectAvailableMetric(failedCase.metrics.toolCalls, 1, "count", "run events");
    expectUnavailableMetric(failedCase.metrics.inputTokens, "unreadable");
    expect(harness.agent.exportCalls).not.toContain("session-task-1--c1");
    expect(harness.agent.runCalls.get("task-1--c1")).toBe(1);
    expect(harness.timeline).not.toContain(`patch:task-1--c1`);
    expect(
      harness.evaluatorProcesses.requests.every((request) => request.cwd !== "/synthetic/workspaces/task-1--c1/worktree"),
    ).toBe(true);
    expect(run.exitCode).toBe(2);

    const independentCase = caseResultOf(run, "task-1--c2");
    expect(independentCase.lifecycle).toBe("completed");
    expect(independentCase.outcome).toBe("passed");
  });

  it("times out, skips all checks, attempts the patch, and falls back to event metrics", async () => {
    const config = buildTevuConfig({ tasks: [buildTask()] });
    const harness = createHarness(config);
    harness.agent.scripts.set("task-1--c1", timedOutRunScript());

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const timedOutCase = caseResultOf(run, "task-1--c1");
    expect(timedOutCase.lifecycle).toBe("timed-out");
    expect(timedOutCase.outcome).toBe("not-evaluated");
    expect(timedOutCase.checks).toEqual([]);
    expect(timedOutCase.failure?.error.kind).toBe("CaseTimeoutError");
    expect(timedOutCase.process?.terminationStage).toBe("forced");
    expect(timedOutCase.artifacts.sessionExport).toBeNull();
    expect(timedOutCase.artifacts.solutionPatch).toBe("task-1--c1/solution.patch");
    expect(timedOutCase.artifacts.checks).toBeNull();
    expectAvailableMetric(timedOutCase.metrics.elapsed, 4_321, "millisecond", "process", "case");
    expectAvailableMetric(timedOutCase.metrics.apiErrors, 1, "count", "run events");
    expectAvailableMetric(timedOutCase.metrics.toolCalls, 1, "count", "run events");
    expectUnavailableMetric(timedOutCase.metrics.inputTokens, "timed out");
    expect(harness.agent.exportCalls).not.toContain("session-task-1--c1");
    expect(harness.agent.runCalls.get("task-1--c1")).toBe(1);
    expect(harness.timeline).not.toContain(`exportSession:session-task-1--c1`);
    expect(
      harness.evaluatorProcesses.requests.every(
        (request) => request.cwd !== "/synthetic/workspaces/task-1--c1/worktree",
      ),
    ).toBe(true);
    expect(run.exitCode).toBe(2);
  });

  it("stops scheduling queued cases after an artifact failure and reports every planned case", async () => {
    const config = buildTevuConfig({ run: buildRunSettings({ concurrency: 1 }), tasks: [buildTask()] });
    const harness = createHarness(config);
    harness.artifacts.failOnce.set("appendEvent:task-1--c1", {
      kind: "ArtifactError",
      operation: "append-event",
      reason: "synthetic disk full",
    });

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const failedCase = caseResultOf(run, "task-1--c1");
    expect(failedCase.lifecycle).toBe("infrastructure-failed");
    expect(failedCase.outcome).toBe("not-evaluated");
    expect(failedCase.failure?.error.kind).toBe("ArtifactError");
    expect(failedCase.artifacts.sessionExport).toBeNull();
    expect(harness.agent.exportCalls).not.toContain("session-task-1--c1");
    expect(harness.agent.runCalls.get("task-1--c1")).toBe(1);
    expect(harness.agent.runCalls.has("task-1--c2")).toBe(false);

    expect(run.cases.map((entry) => entry.identity.caseId)).toEqual(["task-1--c1"]);
    expect(run.findings).toEqual([
      {
        severity: "error",
        caseId: "task-1--c2",
        message: "case was not started because an artifact failure stopped scheduling",
      },
    ]);
    for (const plannedCaseId of ["task-1--c1", "task-1--c2"]) {
      const covered =
        run.cases.some((entry) => entry.identity.caseId === plannedCaseId) ||
        run.findings.some((finding) => finding.caseId === plannedCaseId);
      expect(covered).toBe(true);
    }
    expect(run.exitCode).toBe(1);
  });

  it("finalizes the run with queued-case findings when cancelled during a case", async () => {
    const config = buildTevuConfig({
      run: buildRunSettings({ concurrency: 1 }),
      tasks: [buildTask()],
    });
    const harness = createHarness(config);
    harness.agent.scripts.set("task-1--c1", async (input) => {
      await waitForSignal(input.cancellation);
      return { ok: false, error: { kind: "CancellationError", activeCaseIds: ["task-1--c1"] } };
    });
    const caseStart = harness.agent.waitForCaseStart("task-1--c1");

    const runPromise = runBenchmark(planBenchmark(config), harness.dependencies);
    await caseStart;
    harness.cancellation.abort();
    const result = await runPromise;

    const run = unwrapOk(result);
    const cancelledCase = caseResultOf(run, "task-1--c1");
    expect(cancelledCase.lifecycle).toBe("cancelled");
    expect(cancelledCase.outcome).toBe("not-evaluated");
    expect(cancelledCase.failure?.error.kind).toBe("CancellationError");
    expect(cancelledCase.artifacts.sessionExport).toBeNull();
    expect(harness.agent.exportCalls).not.toContain("session-task-1--c1");
    expect(harness.agent.runCalls.has("task-1--c2")).toBe(false);
    expect(run.findings).toEqual([
      {
        severity: "warning",
        caseId: "task-1--c2",
        message: "case was still queued when the run was cancelled and was not started",
      },
    ]);
    expect(run.exitCode).toBe(130);
    expect(harness.artifacts.finalizedRuns).toHaveLength(1);
    expect(harness.lifecycleEvents).toContainEqual({ caseId: "task-1--c1", lifecycle: "cancelled" });
  });

  it("finishes the case as cancelled with the evaluator request carrying the case signal when cancelled during evaluation", async () => {
    const { run, harness } = await runCancelledDuringEvaluation();

    const cancelledCase = caseResultOf(run, "task-1--c1");
    expect(cancelledCase.lifecycle).toBe("cancelled");
    expect(cancelledCase.outcome).toBe("not-evaluated");
    expect(cancelledCase.artifacts.sessionExport).toBe("task-1--c1/session.json");
    expect(cancelledCase.artifacts.solutionPatch).toBe("task-1--c1/solution.patch");
    expect(cancelledCase.artifacts.checks).toBe("task-1--c1/checks.json");
    expect(harness.evaluatorProcesses.requests[0]?.cancellation).toBeDefined();
    expect(harness.agent.runCalls.has("task-1--c2")).toBe(false);
    expect(run.findings).toEqual([
      {
        severity: "warning",
        caseId: "task-1--c2",
        message: "case was still queued when the run was cancelled and was not started",
      },
    ]);
    expect(run.exitCode).toBe(130);
    expect(harness.artifacts.finalizedRuns).toHaveLength(1);
  });

  it("aborts the case cancellation signal when the run is cancelled during evaluation", async () => {
    const { harness } = await runCancelledDuringEvaluation();

    expect(harness.evaluatorProcesses.requests[0]?.cancellation?.aborted).toBe(true);
  });

  it("skips remaining checks when the run is cancelled during evaluation", async () => {
    const { run } = await runCancelledDuringEvaluation();

    const cancelledCase = caseResultOf(run, "task-1--c1");
    expect(cancelledCase.checks).toHaveLength(1);
    expect(cancelledCase.checks[0]).toMatchObject({ checkId: "acc-required", verdict: "passed" });
  });

  it("returns CancellationError without any writes when the run signal is already aborted", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);
    harness.cancellation.abort();

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const error = unwrapError(result);
    expect(error).toMatchObject({ kind: "CancellationError", activeCaseIds: [] });
    expect(harness.prerequisites.probeHostCalls).toBe(0);
    expect(harness.git.validatedCommits).toHaveLength(0);
    expect(harness.agent.runCalls.size).toBe(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.artifacts.finalizedRuns).toHaveLength(0);
  });

  it("records preparation failure as infrastructure-failed without starting the process", async () => {
    const config = buildTevuConfig({ tasks: [buildTask()] });
    const harness = createHarness(config);
    harness.git.createIsolatedCaseError = {
      kind: "IsolationError",
      caseId: "task-1--c1",
      reason: "synthetic isolation failure",
    };

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    expect(run.cases).toHaveLength(2);
    for (const entry of run.cases) {
      expect(entry.lifecycle).toBe("infrastructure-failed");
      expect(entry.outcome).toBe("not-evaluated");
      expect(entry.failure?.error.kind).toBe("IsolationError");
      expect(entry.artifacts.result).toBe(`${entry.identity.caseId}/result.json`);
      expect(entry.artifacts.events).toBeNull();
      expectUnavailableMetric(entry.metrics.elapsed, "case preparation failed");
    }
    expect(harness.agent.runCalls.size).toBe(0);
    expect(harness.timeline.filter((entry) => entry.startsWith("dispose:"))).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it("records a cleanup warning with the retained path when disposal fails", async () => {
    const config = buildTevuConfig({ tasks: [buildTask()] });
    const harness = createHarness(config);
    harness.git.disposeErrors.set("task-1--c1", {
      kind: "ArtifactError",
      operation: "dispose-case-workspace",
      reason: "synthetic disposal failure",
    });

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const disposedCase = caseResultOf(run, "task-1--c1");
    expect(disposedCase.lifecycle).toBe("completed");
    expect(disposedCase.outcome).toBe("passed");
    expect(run.findings).toEqual([
      {
        severity: "warning",
        caseId: "task-1--c1",
        message: expect.stringContaining("/synthetic/workspaces/task-1--c1/worktree"),
      },
    ]);
    expect(run.findings[0]?.message).toContain("cleanup failed");
    expect(run.exitCode).toBe(0);
  });

  it("stops scheduling and retains the workspace when case persistence fails", async () => {
    const config = buildTevuConfig({ run: buildRunSettings({ concurrency: 1 }), tasks: [buildTask()] });
    const harness = createHarness(config);
    harness.artifacts.failOnce.set("finalizeCase:task-1--c1", {
      kind: "ArtifactError",
      operation: "finalize-case",
      reason: "synthetic persistence failure",
    });

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const persistedCase = caseResultOf(run, "task-1--c1");
    expect(persistedCase.lifecycle).toBe("completed");
    expect(harness.timeline).not.toContain("dispose:task-1--c1");
    expect(harness.agent.runCalls.has("task-1--c2")).toBe(false);
    expect(run.findings).toEqual([
      {
        severity: "error",
        caseId: "task-1--c1",
        message: expect.stringContaining("/synthetic/workspaces/task-1--c1/worktree"),
      },
      {
        severity: "error",
        caseId: "task-1--c2",
        message: "case was not started because an artifact failure stopped scheduling",
      },
    ]);
    expect(run.exitCode).toBe(1);
  });

  it.each([
    {
      label: "a failed required acceptance command",
      manualDefinitionOfDone: false,
      acceptanceExitCode: 1,
      expectedOutcome: "failed",
    },
    {
      label: "an unassessed required manual check",
      manualDefinitionOfDone: true,
      acceptanceExitCode: 0,
      expectedOutcome: "pending",
    },
  ])("completes $label with outcome $expectedOutcome and forces exit 2", async ({
    manualDefinitionOfDone,
    acceptanceExitCode,
    expectedOutcome,
  }) => {
    const config = buildTevuConfig({
      tasks: [
        buildTask({
          checks: {
            acceptance: [buildCheck({ id: "acc-required" })],
            done: manualDefinitionOfDone
              ? [{ id: "dod-required", description: "manual Definition of Done review", manual: true }]
              : [buildCheck({ id: "dod-required", run: ["/synthetic/dod-required", "--verify"] })],
          },
        }),
      ],
    });
    const harness = createHarness(config);
    if (acceptanceExitCode !== 0) {
      harness.evaluatorProcesses.exitCodes.set("/synthetic/acc-required", acceptanceExitCode);
    }

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const caseResult = caseResultOf(run, "task-1--c1");
    expect(caseResult.lifecycle).toBe("completed");
    expect(caseResult.outcome).toBe(expectedOutcome);
    expect(caseResult.failure).toBeNull();
    expect(caseResult.process?.exitCode).toBe(0);
    expect(run.exitCode).toBe(2);
  });
});

describe("runBenchmark check-state orchestration", () => {
  function buildOverlaySnapshot(): OverlaySnapshot {
    return [{ kind: "file", path: "hidden.txt", executable: false, bytes: new Uint8Array([1, 2, 3]) }];
  }

  it("reads each distinct overlay directory once between the last validateSource call and the run start, and calls applyCheckState once per case between the patch write and the first evaluator process", async () => {
    const overlaySnapshot = buildOverlaySnapshot();
    const config = buildTevuConfig({
      run: buildRunSettings({ concurrency: 1 }),
      tasks: [
        buildTask({
          id: "task-1",
          checks: { ...buildTask().checks, restore: ["tests/**"], overlay: "/synthetic/overlay-a" },
        }),
      ],
    });
    const harness = createHarness(config);
    harness.git.readOverlaySnapshots.set("/synthetic/overlay-a", overlaySnapshot);

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    expect(harness.git.readOverlayCalls).toEqual(["/synthetic/overlay-a"]);
    const readOverlayIndex = harness.timeline.indexOf("readOverlay:/synthetic/overlay-a");
    const lastValidateSourceIndex = harness.timeline.lastIndexOf("validateSource:repo-1");
    const startRunIndex = harness.timeline.findIndex((entry) => entry.startsWith("startRun:"));
    expect(readOverlayIndex).toBeGreaterThan(lastValidateSourceIndex);
    expect(readOverlayIndex).toBeLessThan(startRunIndex);

    expect(harness.git.applyCheckStateCalls).toHaveLength(2);
    for (const call of harness.git.applyCheckStateCalls) {
      expect(call.request).toEqual({ restore: ["tests/**"], overlay: overlaySnapshot });
    }
    const firstCaseId = harness.git.applyCheckStateCalls[0]?.caseId;
    const applyIndex = harness.timeline.indexOf(`applyCheckState:${firstCaseId}`);
    const patchWriteIndex = harness.timeline.indexOf(`writePatch:${firstCaseId}`);
    const firstCheckIndex = harness.timeline.findIndex((entry) => entry.startsWith("check:"));
    expect(applyIndex).toBeGreaterThan(patchWriteIndex);
    expect(applyIndex).toBeLessThan(firstCheckIndex);
    expect(run.exitCode).toBe(0);
  });

  it("ends the case as infrastructure-failed with no checks and no evaluator process when applyCheckState fails", async () => {
    const config = buildTevuConfig({
      run: buildRunSettings({ concurrency: 1 }),
      tasks: [buildTask({ id: "task-1", checks: { ...buildTask().checks, restore: ["tests/**"] } })],
    });
    const harness = createHarness(config);
    const failure: Extract<TevuError, { kind: "CheckStateError" }> = {
      kind: "CheckStateError",
      step: "restore",
      reason: "synthetic restore failure",
    };
    harness.git.applyCheckStateError = failure;

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const failedCase = caseResultOf(run, "task-1--c1");
    expect(failedCase.lifecycle).toBe("infrastructure-failed");
    expect(failedCase.outcome).toBe("not-evaluated");
    expect(failedCase.checks).toEqual([]);
    expect(failedCase.artifacts.checks).toBeNull();
    expect(failedCase.artifacts.solutionPatch).toBe("task-1--c1/solution.patch");
    expect(failedCase.failure?.error).toEqual(failure);
    expect(harness.timeline.filter((entry) => entry.startsWith("check:"))).toEqual([]);
    expect(run.exitCode).toBe(1);
  });

  it("never calls applyCheckState or readOverlay, and omits checkState, for a task declaring neither key", async () => {
    const config = buildTevuConfig({ tasks: [buildTask({ id: "task-1" })] });
    const harness = createHarness(config);

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    expect(harness.git.readOverlayCalls).toEqual([]);
    expect(harness.git.applyCheckStateCalls).toEqual([]);
    for (const caseResult of run.cases) {
      expect(Object.hasOwn(caseResult, "checkState")).toBe(false);
    }
  });

  it("never calls applyCheckState and omits checkState for a task declaring an empty restore array without an overlay", async () => {
    const config = buildTevuConfig({
      tasks: [buildTask({ id: "task-1", checks: { ...buildTask().checks, restore: [] } })],
    });
    const harness = createHarness(config);

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    expect(harness.git.applyCheckStateCalls).toEqual([]);
    expect(Object.hasOwn(caseResultOf(run, "task-1--c1"), "checkState")).toBe(false);
  });

  it("returns the readOverlay failure unchanged before the run starts, any case is prepared, or any agent runs", async () => {
    const config = buildTevuConfig({
      tasks: [
        buildTask({ id: "task-1", checks: { ...buildTask().checks, overlay: "/synthetic/overlay-a" } }),
      ],
    });
    const harness = createHarness(config);
    const failure: Extract<TevuError, { kind: "CheckStateError" }> = {
      kind: "CheckStateError",
      step: "overlay",
      reason: "synthetic overlay unreadable",
    };
    harness.git.readOverlayError = failure;

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    expect(result).toEqual({ ok: false, error: failure });
    expect(harness.timeline.some((entry) => entry.startsWith("startRun:"))).toBe(false);
    expect(harness.timeline.some((entry) => entry.startsWith("prepare:"))).toBe(false);
    expect(harness.agent.runCalls.size).toBe(0);
  });
});

function buildRunManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    runId: "run-stub-synthetic",
    configDigest: "digest-stub-synthetic",
    startedAt: CLOCK_BASE,
    completedAt: null,
    host: { platform: "linux", nodeVersion: "v24.0.0-synthetic", bunVersion: "1.2.3-synthetic" },
    tools: { gitVersion: "2.45.0-synthetic", agentVersions: {} },
    execution: { concurrency: 1, caseTimeoutMs: 1_000 },
    cases: [],
    ...overrides,
  };
}

function buildRunResult(): RunResult {
  return { schemaVersion: 1, manifest: buildRunManifest(), cases: [], findings: [], exitCode: 0 };
}
