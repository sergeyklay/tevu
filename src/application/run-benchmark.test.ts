// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { planBenchmark, reduceRunExitCode, runBenchmark } from "./run-benchmark.ts";
import { TevuConfigSchema } from "../config/schema.ts";
import { unavailableBenchmarkMetrics } from "../evaluation/metrics.ts";

import type { CheckDefinition, CommandEvaluator, TaskDefinition, TevuConfig } from "../config/schema.ts";
import type {
  ArtifactStore,
  CaseEnvironments,
  CaseIdentity,
  CaseLifecycle,
  CaseResult,
  CaseWorkspace,
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
  OpenCodeAdapter,
  OpenCodeCapabilityReport,
  OpenCodeExport,
  OpenCodeRunEvent,
  OpenCodeRunInput,
  OpenCodeRunResult,
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

const EMPTY_CAPTURE: RedactedCapture = { text: "", totalBytes: 0, truncated: false };

type FakeRunOutcome = TevuResult<
  OpenCodeRunResult,
  "OpenCodeProcessError" | "OpenCodeProtocolError" | "CaseTimeoutError" | "CancellationError"
>;

type CaseRunFailure = Extract<
  TevuError,
  { kind: "OpenCodeProcessError" | "OpenCodeProtocolError" | "CaseTimeoutError" | "CancellationError" }
>;

type ExportFailure = Extract<TevuError, { kind: "OpenCodeProcessError" | "OpenCodeProtocolError" }>;

type RunScript = (input: OpenCodeRunInput) => Promise<FakeRunOutcome>;

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

function buildCommandEvaluator(overrides: Partial<CommandEvaluator> = {}): CommandEvaluator {
  return {
    kind: "command",
    argv: ["/synthetic/acc-required", "--verify"],
    timeoutMs: 5_000,
    successExitCodes: [0],
    environmentAllowlist: [],
    ...overrides,
  };
}

function buildCheck(overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: "acc-required",
    description: "acceptance command exits zero",
    required: true,
    evaluator: buildCommandEvaluator(),
    ...overrides,
  };
}

function buildTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "task-1",
    repositoryId: "repo-1",
    startCommit: COMMIT_A,
    source: { kind: "manual", title: "synthetic manual task" },
    description: "synthetic task description",
    prompt: "implement the synthetic feature",
    definitionOfReady: [{ id: "ready-1", description: "synthetic ready item", confirmed: true }],
    acceptanceCriteria: [buildCheck({ id: "acc-required" })],
    definitionOfDone: [
      buildCheck({
        id: "dod-required",
        evaluator: buildCommandEvaluator({ argv: ["/synthetic/dod-required", "--verify"] }),
      }),
    ],
    ...overrides,
  };
}

function buildTevuConfig(overrides: Partial<TevuConfig> = {}): TevuConfig {
  const config: TevuConfig = {
    version: 1,
    artifacts: { directory: "/synthetic/artifacts" },
    execution: {
      concurrency: 2,
      caseTimeoutMs: 60_000,
      terminationGraceMs: 500,
      opencodeEnvironment: [{ name: "TEVU_PROVIDER_KEY", classification: "provider-credential" }],
      evaluatorEnvironment: [{ name: "TEVU_EVAL_VAR", classification: "ordinary" }],
    },
    opencode: { executable: "/synthetic/opencode" },
    repositories: [{ id: "repo-1", path: "/synthetic/source" }],
    contenders: [
      { id: "c1", model: "synthetic/model-a", variant: "fast" },
      { id: "c2", model: "synthetic/model-b", variant: "deep" },
    ],
    tasks: [buildTask({ id: "task-1" }), buildTask({ id: "task-2" })],
    ...overrides,
  };
  return TevuConfigSchema.parse(config);
}

function buildCaseIdentity(caseId = "task-1--c1"): CaseIdentity {
  return {
    caseId,
    taskId: "task-1",
    contenderId: "c1",
    sourceCommit: COMMIT_A,
    model: "synthetic/model-a",
    variant: "fast",
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

function buildToolUseEvent(sessionId: string): OpenCodeRunEvent {
  return {
    type: "tool_use",
    timestamp: 1,
    sessionID: sessionId,
    part: {
      id: "part-tool-1",
      sessionID: sessionId,
      messageID: "message-1",
      type: "tool",
      callID: "call-1",
      tool: "edit",
      state: { status: "completed" },
    },
  };
}

function buildErrorEvent(sessionId: string): OpenCodeRunEvent {
  return {
    type: "error",
    timestamp: 2,
    sessionID: sessionId,
    error: { message: "synthetic provider outage" },
  };
}

function buildExport(sessionId: string): OpenCodeExport {
  return {
    info: { id: sessionId },
    messages: [
      { info: { id: `${sessionId}-user`, sessionID: sessionId, role: "user" }, parts: [] },
      {
        info: {
          id: `${sessionId}-assistant`,
          sessionID: sessionId,
          role: "assistant",
          parentID: `${sessionId}-user`,
          finish: "stop",
          cost: 0.25,
          tokens: { input: 10, output: 20, reasoning: 3, cache: { read: 4, write: 5 } },
        },
        parts: [],
      },
    ],
  };
}

function buildOpenCodeRunResult(overrides: Partial<OpenCodeRunResult> = {}): OpenCodeRunResult {
  return {
    process: buildProcessResult(),
    sessionId: "session-synthetic",
    parseFindings: [],
    ...overrides,
  };
}

function buildCapabilityReport(): OpenCodeCapabilityReport {
  return {
    executable: "/synthetic/opencode",
    detectedVersion: "99.0.0-synthetic",
    commands: { run: "available", export: "available" },
    runOptions: { jsonFormat: "available", model: "available", variant: "available" },
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
  recipient: "opencode" | "evaluator",
  snapshot: ParentEnvironmentSnapshot,
): IsolatedEnvironment {
  const homeDirectory = `/synthetic/workspaces/${caseId}/runtime/${recipient}/home`;
  const temporaryDirectory = `/synthetic/workspaces/${caseId}/runtime/${recipient}/tmp`;
  const variables: Record<string, string> = {
    PATH: snapshot.path,
    HOME: homeDirectory,
    TMPDIR: temporaryDirectory,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    CI: "1",
    ...(recipient === "opencode" ? snapshot.opencodeValues : {}),
  };
  const configuredNames =
    recipient === "opencode" ? Object.keys(snapshot.opencodeValues) : Object.keys(snapshot.ordinaryEvaluatorValues);
  const variableManifest: EnvironmentVariableRecord[] = [
    ...["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CI"].map((name) => ({
      name,
      classification: "fixed" as const,
      recipient,
    })),
    ...configuredNames.map((name) => ({
      name,
      classification: recipient === "opencode" ? ("provider-credential" as const) : ("ordinary" as const),
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
    error: { kind: "OpenCodeProcessError", caseId: "task-1--c1", exitCode: 3, signal: null },
    occurredAt: CLOCK_BASE,
    ...overrides,
  };
}

function buildRunFinding(overrides: Partial<RunFinding> = {}): RunFinding {
  return { severity: "warning", caseId: null, message: "synthetic finding", ...overrides };
}

function defaultRunScript(input: OpenCodeRunInput): Promise<FakeRunOutcome> {
  return successfulRunScript(input);
}

async function successfulRunScript(input: OpenCodeRunInput): Promise<FakeRunOutcome> {
  const sessionId = `session-${input.identity.caseId}`;
  await input.onEvent(buildToolUseEvent(sessionId));
  const value = buildOpenCodeRunResult({ sessionId });
  input.onProcess?.(value);
  return { ok: true, value };
}

function failedRunScript(
  error: CaseRunFailure,
  options: { withErrorEvent?: boolean } = {},
): RunScript {
  return async (input) => {
    const sessionId = `session-${input.identity.caseId}`;
    await input.onEvent(buildToolUseEvent(sessionId));
    if (options.withErrorEvent === true) {
      await input.onEvent(buildErrorEvent(sessionId));
    }
    const value = buildOpenCodeRunResult({
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
    await input.onEvent(buildToolUseEvent(sessionId));
    await input.onEvent(buildErrorEvent(sessionId));
    const value = buildOpenCodeRunResult({
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
  };

  let heldRuns: PromiseWithResolvers<void> | null = null;
  const startedSignals = new Map<string, PromiseWithResolvers<void>>();

  const opencodeState = {
    runCalls: new Map<string, number>(),
    runInputs: [] as OpenCodeRunInput[],
    startedOrder: [] as string[],
    scripts: new Map<string, RunScript>(),
    exportCalls: [] as string[],
    exportFailures: new Map<string, ExportFailure>(),
    activeCount: 0,
    maxActiveCount: 0,
    probeError: null as Extract<TevuError, { kind: "PrerequisiteError" | "OpenCodeProtocolError" }> | null,
  };

  const opencode: OpenCodeAdapter = {
    async probe(executable) {
      timeline.push("probe");
      if (opencodeState.probeError !== null) {
        return { ok: false, error: opencodeState.probeError };
      }
      return { ok: true, value: buildCapabilityReport() };
    },
    async run(input) {
      const caseId = input.identity.caseId;
      opencodeState.runCalls.set(caseId, (opencodeState.runCalls.get(caseId) ?? 0) + 1);
      opencodeState.startedOrder.push(caseId);
      opencodeState.runInputs.push(input);
      opencodeState.activeCount += 1;
      opencodeState.maxActiveCount = Math.max(opencodeState.maxActiveCount, opencodeState.activeCount);
      startedSignals.get(caseId)?.resolve();
      timeline.push(`run:start:${caseId}`);
      const script = opencodeState.scripts.get(caseId) ?? defaultRunScript;
      const outcome = await script(input);
      opencodeState.activeCount -= 1;
      timeline.push(`run:end:${caseId}`);
      return outcome;
    },
    async exportSession(sessionId) {
      opencodeState.exportCalls.push(sessionId);
      timeline.push(`exportSession:${sessionId}`);
      const failure = opencodeState.exportFailures.get(sessionId);
      if (failure !== undefined) {
        return { ok: false, error: failure };
      }
      return { ok: true, value: buildExport(sessionId) };
    },
  };

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
    async appendEvent(caseId, event) {
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
      opencodeValues: { TEVU_PROVIDER_KEY: "synthetic-provider-secret" },
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
        opencode: buildFakeEnvironment(workspace.caseId, "opencode", snapshot),
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
    opencode,
    artifacts,
    evaluatorProcesses,
    environments,
    prerequisites,
    clock,
    generateRunId: () => RUN_ID,
    configDigest: () => "digest-synthetic",
    buildTaskPrompt: vi.fn((task: TaskDefinition) => `prompt:${task.id}`),
    redact: (text) => text,
    cancellation: cancellationController.signal,
    onLifecycle: (caseId, lifecycle) => lifecycleEvents.push({ caseId, lifecycle }),
  };

  const opencodeHarness = Object.assign(opencodeState, {
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
    opencode: opencodeHarness,
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
    execution: {
      concurrency: 1,
      caseTimeoutMs: 60_000,
      terminationGraceMs: 500,
      opencodeEnvironment: [{ name: "TEVU_PROVIDER_KEY", classification: "provider-credential" }],
      evaluatorEnvironment: [{ name: "TEVU_EVAL_VAR", classification: "ordinary" }],
    },
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
  harness.opencode.exportFailures.set("session-task-1--c1", buildError("task-1--c1"));
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
        buildTask({ id: "task-1", startCommit: COMMIT_A }),
        buildTask({ id: "task-2", startCommit: COMMIT_B }),
      ],
    });

    const plan = planBenchmark(config);

    expect(plan.config).toBe(config);
    expect(plan.cases).toEqual([
      {
        caseId: "task-1--c1",
        taskId: "task-1",
        contenderId: "c1",
        sourceCommit: COMMIT_A,
        model: "synthetic/model-a",
        variant: "fast",
      },
      {
        caseId: "task-1--c2",
        taskId: "task-1",
        contenderId: "c2",
        sourceCommit: COMMIT_A,
        model: "synthetic/model-b",
        variant: "deep",
      },
      {
        caseId: "task-2--c1",
        taskId: "task-2",
        contenderId: "c1",
        sourceCommit: COMMIT_B,
        model: "synthetic/model-a",
        variant: "fast",
      },
      {
        caseId: "task-2--c2",
        taskId: "task-2",
        contenderId: "c2",
        sourceCommit: COMMIT_B,
        model: "synthetic/model-b",
        variant: "deep",
      },
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
    expect(manifest.tools).toEqual({ gitVersion: "2.45.0-synthetic", opencodeVersion: "99.0.0-synthetic" });
    expect(manifest.execution).toEqual({ concurrency: 2, caseTimeoutMs: 60_000 });
    expect(manifest.cases).toEqual([
      {
        caseId: "task-1--c1",
        taskId: "task-1",
        contenderId: "c1",
        sourceCommit: `pinned-${COMMIT_A}`,
        model: "synthetic/model-a",
        variant: "fast",
      },
      {
        caseId: "task-1--c2",
        taskId: "task-1",
        contenderId: "c2",
        sourceCommit: `pinned-${COMMIT_A}`,
        model: "synthetic/model-b",
        variant: "deep",
      },
      {
        caseId: "task-2--c1",
        taskId: "task-2",
        contenderId: "c1",
        sourceCommit: `pinned-${COMMIT_A}`,
        model: "synthetic/model-a",
        variant: "fast",
      },
      {
        caseId: "task-2--c2",
        taskId: "task-2",
        contenderId: "c2",
        sourceCommit: `pinned-${COMMIT_A}`,
        model: "synthetic/model-b",
        variant: "deep",
      },
    ]);
    expect(manifest.context?.config).toBe(config);
    expect(manifest.context?.capabilities.detectedVersion).toBe("99.0.0-synthetic");
    expect(harness.artifacts.startedManifests[0].completedAt).toBeNull();
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
    expect(harness.opencode.runCalls.size).toBe(0);
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
    expect(harness.opencode.runCalls.size).toBe(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
  });

  it("returns the capability probe failure before commit pinning and any write", async () => {
    const config = buildTevuConfig();
    const harness = createHarness(config);
    harness.opencode.probeError = {
      kind: "OpenCodeProtocolError",
      context: { phase: "probe" },
      reason: "synthetic missing run command",
    };

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const error = unwrapError(result);
    expect(error).toMatchObject({ kind: "OpenCodeProtocolError", context: { phase: "probe" } });
    expect(harness.git.validatedCommits).toHaveLength(0);
    expect(harness.artifacts.startedManifests).toHaveLength(0);
    expect(harness.lifecycleEvents).toEqual([]);
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
    expect(harness.opencode.runCalls.size).toBe(0);
  });

  it("runs the complete per-case pipeline in order with the patch captured before evaluators", async () => {
    const task = buildTask();
    const config = buildTevuConfig({
      execution: {
        concurrency: 1,
        caseTimeoutMs: 60_000,
        terminationGraceMs: 500,
        opencodeEnvironment: [{ name: "TEVU_PROVIDER_KEY", classification: "provider-credential" }],
        evaluatorEnvironment: [{ name: "TEVU_EVAL_VAR", classification: "ordinary" }],
      },
      tasks: [task],
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

    const runInput = harness.opencode.runInputs[0];
    expect(runInput.identity).toEqual({ ...buildCaseIdentity("task-1--c1"), sourceCommit: `pinned-${COMMIT_A}` });
    expect(runInput.executable).toBe("/synthetic/opencode");
    expect(runInput.prompt).toBe("prompt:task-1");
    expect(runInput.prompt).not.toContain(`pinned-${COMMIT_A}`);
    expect(vi.mocked(harness.dependencies.buildTaskPrompt).mock.calls).toEqual([[task], [task]]);
    expect(runInput.worktreeDirectory).toBe("/synthetic/workspaces/task-1--c1/worktree");
    expect(runInput.environment).toBe(harness.environments.created[0].value.opencode);
    expect(runInput.timeoutMs).toBe(60_000);
    expect(runInput.terminationGraceMs).toBe(500);
    expect(runInput.cancellation.aborted).toBe(false);

    const caseRequests = harness.evaluatorProcesses.requests.filter(
      (request) => request.cwd === "/synthetic/workspaces/task-1--c1/worktree",
    );
    expect(caseRequests.map((request) => request.argv[0])).toEqual([
      "/synthetic/acc-required",
      "/synthetic/dod-required",
    ]);
    const evaluatorRequest = caseRequests[0];
    expect(evaluatorRequest.argv).toEqual(["/synthetic/acc-required", "--verify"]);
    expect(evaluatorRequest.cwd).toBe("/synthetic/workspaces/task-1--c1/worktree");
    expect(evaluatorRequest.environment).toEqual(harness.environments.created[0].value.evaluator.variables);
    expect(evaluatorRequest.timeoutMs).toBe(5_000);
    expect(evaluatorRequest.terminationGraceMs).toBe(500);

    const caseResult = caseResultOf(run, "task-1--c1");
    expect(caseResult.lifecycle).toBe("completed");
    expect(caseResult.outcome).toBe("passed");
    expect(caseResult.failure).toBeNull();
    expect(caseResult.process?.exitCode).toBe(0);
    expect(caseResult.checks.map((check) => check.verdict)).toEqual(["passed", "passed"]);
    expect(caseResult.checks[0].evidence).toContain("exit code 0");
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
    harness.opencode.holdNewRuns();
    const firstStart = harness.opencode.waitForCaseStart("task-1--c1");
    const secondStart = harness.opencode.waitForCaseStart("task-1--c2");

    const runPromise = runBenchmark(planBenchmark(config), harness.dependencies);
    await Promise.all([firstStart, secondStart]);

    expect(harness.opencode.activeCount).toBe(2);
    expect(harness.opencode.maxActiveCount).toBe(2);
    expect(harness.opencode.startedOrder).toEqual(["task-1--c1", "task-1--c2"]);

    harness.opencode.releaseHeldRuns();
    const result = await runPromise;

    const run = unwrapOk(result);
    expect(harness.opencode.maxActiveCount).toBe(2);
    expect(harness.opencode.runCalls.size).toBe(4);
    expect(run.cases).toHaveLength(4);
    expect(run.cases.every((entry) => entry.lifecycle === "completed")).toBe(true);
  });

  it("keeps the concurrency slot held while acceptance checks evaluate", async () => {
    const config = buildTevuConfig({
      execution: {
        concurrency: 1,
        caseTimeoutMs: 60_000,
        terminationGraceMs: 500,
        opencodeEnvironment: [{ name: "TEVU_PROVIDER_KEY", classification: "provider-credential" }],
        evaluatorEnvironment: [{ name: "TEVU_EVAL_VAR", classification: "ordinary" }],
      },
      tasks: [buildTask()],
    });
    const harness = createHarness(config);
    harness.evaluatorProcesses.holdChecks();
    const firstCheck = harness.evaluatorProcesses.waitForCheck("/synthetic/acc-required");

    const runPromise = runBenchmark(planBenchmark(config), harness.dependencies);
    await firstCheck;

    expect(harness.timeline.filter((entry) => entry.startsWith("prepare:"))).toEqual(["prepare:task-1--c1"]);
    expect([...harness.opencode.runCalls.keys()]).toEqual(["task-1--c1"]);

    harness.evaluatorProcesses.releaseChecks();
    const result = await runPromise;

    unwrapOk(result);
    expect(harness.opencode.runCalls.size).toBe(2);
    expect(harness.timeline.filter((entry) => entry.startsWith("prepare:"))).toEqual([
      "prepare:task-1--c1",
      "prepare:task-1--c2",
    ]);
  });

  describe.each([
    {
      label: "readable OpenCode process failure",
      buildError: (caseId: string): CaseRunFailure => ({
        kind: "OpenCodeProcessError",
        caseId,
        exitCode: 3,
        signal: null,
      }),
    },
    {
      label: "readable case-context OpenCode protocol failure",
      buildError: (caseId: string): CaseRunFailure => ({
        kind: "OpenCodeProtocolError",
        context: { phase: "case", caseId },
        reason: "synthetic malformed event identity",
      }),
    },
  ])("$label", ({ buildError }) => {
    it("completes evaluation, preserves the runtime failure, and forces exit 2 without retrying", async () => {
      const config = buildTevuConfig({ tasks: [buildTask()] });
      const harness = createHarness(config);
      harness.opencode.scripts.set("task-1--c1", failedRunScript(buildError("task-1--c1")));

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
      expect(harness.opencode.exportCalls).toHaveLength(2);
      expect(harness.opencode.exportCalls).toContain("session-task-1--c1");
      expect(harness.opencode.runCalls.get("task-1--c1")).toBe(1);
      expect(run.exitCode).toBe(2);

      const independentCase = caseResultOf(run, "task-1--c2");
      expect(independentCase.lifecycle).toBe("completed");
      expect(independentCase.outcome).toBe("passed");
      expect(independentCase.failure).toBeNull();
    });
  });

  describe.each([
    {
      label: "OpenCode process error",
      buildError: (caseId: string): ExportFailure => ({
        kind: "OpenCodeProcessError",
        caseId,
        exitCode: 2,
        signal: null,
      }),
    },
    {
      label: "case-context OpenCode protocol error",
      buildError: (caseId: string): ExportFailure => ({
        kind: "OpenCodeProtocolError",
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
      expect(harness.opencode.exportCalls).toContain("session-task-1--c1");

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
    harness.opencode.scripts.set(
      "task-1--c1",
      failedRunScript({ kind: "OpenCodeProcessError", caseId: "task-1--c1", exitCode: 3, signal: null }, {
        withErrorEvent: true,
      }),
    );

    const result = await runBenchmark(planBenchmark(config), harness.dependencies);

    const run = unwrapOk(result);
    const failedCase = caseResultOf(run, "task-1--c1");
    expect(failedCase.lifecycle).toBe("process-failed");
    expect(failedCase.outcome).toBe("not-evaluated");
    expect(failedCase.checks).toEqual([]);
    expect(failedCase.failure?.error.kind).toBe("OpenCodeProcessError");
    expect(failedCase.process?.exitCode).toBe(3);
    expect(failedCase.artifacts.events).toBe("task-1--c1/events.jsonl");
    expect(failedCase.artifacts.sessionExport).toBeNull();
    expect(failedCase.artifacts.solutionPatch).toBeNull();
    expect(failedCase.artifacts.checks).toBeNull();
    expectAvailableMetric(failedCase.metrics.elapsed, 4_321, "millisecond", "process", "case");
    expectAvailableMetric(failedCase.metrics.apiErrors, 1, "count", "run events");
    expectAvailableMetric(failedCase.metrics.toolCalls, 1, "count", "run events");
    expectUnavailableMetric(failedCase.metrics.inputTokens, "unreadable");
    expect(harness.opencode.exportCalls).not.toContain("session-task-1--c1");
    expect(harness.opencode.runCalls.get("task-1--c1")).toBe(1);
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
    harness.opencode.scripts.set("task-1--c1", timedOutRunScript());

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
    expect(harness.opencode.exportCalls).not.toContain("session-task-1--c1");
    expect(harness.opencode.runCalls.get("task-1--c1")).toBe(1);
    expect(harness.timeline).not.toContain(`exportSession:session-task-1--c1`);
    expect(
      harness.evaluatorProcesses.requests.every(
        (request) => request.cwd !== "/synthetic/workspaces/task-1--c1/worktree",
      ),
    ).toBe(true);
    expect(run.exitCode).toBe(2);
  });

  it("stops scheduling queued cases after an artifact failure and reports every planned case", async () => {
    const config = buildTevuConfig({ execution: { ...buildTevuConfig().execution, concurrency: 1 }, tasks: [buildTask()] });
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
    expect(harness.opencode.exportCalls).not.toContain("session-task-1--c1");
    expect(harness.opencode.runCalls.get("task-1--c1")).toBe(1);
    expect(harness.opencode.runCalls.has("task-1--c2")).toBe(false);

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
      execution: {
        concurrency: 1,
        caseTimeoutMs: 60_000,
        terminationGraceMs: 500,
        opencodeEnvironment: [{ name: "TEVU_PROVIDER_KEY", classification: "provider-credential" }],
        evaluatorEnvironment: [{ name: "TEVU_EVAL_VAR", classification: "ordinary" }],
      },
      tasks: [buildTask()],
    });
    const harness = createHarness(config);
    harness.opencode.scripts.set("task-1--c1", async (input) => {
      await waitForSignal(input.cancellation);
      return { ok: false, error: { kind: "CancellationError", activeCaseIds: ["task-1--c1"] } };
    });
    const caseStart = harness.opencode.waitForCaseStart("task-1--c1");

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
    expect(harness.opencode.exportCalls).not.toContain("session-task-1--c1");
    expect(harness.opencode.runCalls.has("task-1--c2")).toBe(false);
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
    expect(harness.evaluatorProcesses.requests[0].cancellation).toBeDefined();
    expect(harness.opencode.runCalls.has("task-1--c2")).toBe(false);
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

    expect(harness.evaluatorProcesses.requests[0].cancellation?.aborted).toBe(true);
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
    expect(harness.opencode.runCalls.size).toBe(0);
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
    expect(harness.opencode.runCalls.size).toBe(0);
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
    expect(run.findings[0].message).toContain("cleanup failed");
    expect(run.exitCode).toBe(0);
  });

  it("stops scheduling and retains the workspace when case persistence fails", async () => {
    const config = buildTevuConfig({ execution: { ...buildTevuConfig().execution, concurrency: 1 }, tasks: [buildTask()] });
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
    expect(harness.opencode.runCalls.has("task-1--c2")).toBe(false);
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
          definitionOfDone: manualDefinitionOfDone
            ? [
                {
                  id: "dod-required",
                  description: "manual Definition of Done review",
                  required: true,
                  evaluator: { kind: "manual" },
                },
              ]
            : [buildCheck({ id: "dod-required" })],
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

function buildRunManifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    runId: "run-stub-synthetic",
    configDigest: "digest-stub-synthetic",
    startedAt: CLOCK_BASE,
    completedAt: null,
    host: { platform: "linux", nodeVersion: "v24.0.0-synthetic", bunVersion: "1.2.3-synthetic" },
    tools: { gitVersion: "2.45.0-synthetic", opencodeVersion: null },
    execution: { concurrency: 1, caseTimeoutMs: 1_000 },
    cases: [],
    ...overrides,
  };
}

function buildRunResult(): RunResult {
  return { schemaVersion: 1, manifest: buildRunManifest(), cases: [], findings: [], exitCode: 0 };
}