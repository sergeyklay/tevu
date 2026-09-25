// @vitest-environment node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rebuildReport } from "../../../application/assess.ts";
import { createArtifactStore } from "../../artifact-store.ts";
import { createRedactor } from "../../process.ts";
import { TevuConfigSchema } from "../../../config/schema.ts";
import { unavailableBenchmarkMetrics } from "../../../domain/types.ts";
import { combineCaseMetrics } from "../../../evaluation/metrics.ts";
import { serializeNormalizedRun } from "../../../evaluation/report.ts";
import { decodeEvent, decodeExport } from "./opencode-protocol.ts";
import { createOpenCodeAdapter } from "./opencode.ts";

import type {
  ModelDefinitionInput,
  RepositoryDefinition,
  TaskInput,
  TevuConfig,
  TevuConfigInput,
} from "../../../config/schema.ts";
import type {
  AgentCapabilityReport,
  AgentEventRecord,
  AgentRegistry,
  AgentSessionExport,
  AssessmentArtifact,
  CaseIdentity,
  CaseResult,
  CheckRecord,
  CheckResult,
  ProcessResult,
  RunFinding,
  RunManifest,
  RunResult,
} from "../../../domain/types.ts";
import type { OpenCodeExport, OpenCodeRunEvent } from "./opencode-protocol.ts";
import type { NormalizedRunModel } from "../../../evaluation/report.ts";

/**
 * Pre-migration OpenCode capability report shape, as the pinned baseline
 * fixture stores it; retired from production code, so the fixture's own
 * shape is described here only for the byte-identity transform below.
 */
type PreMigrationOpenCodeCapabilityReport = {
  executable: string;
  detectedVersion: string | null;
  commands: { run: "available" | "unavailable"; export: "available" | "unavailable" };
  runOptions: {
    jsonFormat: "available" | "unavailable";
    model: "available" | "unavailable";
    variant: "available" | "unavailable";
  };
  isolation: { denyOutsideWorktree: "available" | "unavailable" };
};

const PROVIDER_SECRET = "synthetic-provider-secret-9f2";
const PROVIDER_ENV_NAME = "TEVU_PROVIDER_KEY";
const TRANSCRIPT_BODY = "TEVU-TRANSCRIPT-BODY model output text";
const PATCH_BODY = "TEVU-PATCH-BODY diff --git a/src/welcome.ts b/src/welcome.ts";

const FIXTURE_DIRECTORY = new URL("./opencode-protocol.fixtures/", import.meta.url);

/**
 * A registry holding the real OpenCode adapter under "opencode", matching the
 * synthetic run's saved agent name. Only `normalizeMetrics` is invoked by
 * report regeneration; the other methods are never called.
 */
const AGENTS_REGISTRY: AgentRegistry = new Map([
  [
    "opencode",
    createOpenCodeAdapter(
      { agent: "opencode", executable: "/synthetic/opencode" },
      {
        runProcess: () => Promise.reject(new Error("unused in report regeneration")),
        secrets: {
          secretValues: () => [],
          redactText: (text) => text,
          redactValue: (value) => ({ ok: true, value }),
        },
        probeEnvironment: {},
        probeDirectory: "/synthetic",
      },
    ),
  ],
]);

function requireOpenCodeAdapter() {
  const adapter = AGENTS_REGISTRY.get("opencode");
  if (adapter === undefined) {
    throw new Error("expected AGENTS_REGISTRY to register the opencode adapter");
  }
  return adapter;
}

function readTextFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIRECTORY), "utf8");
}

function readJsonFixture(name: string): unknown {
  return JSON.parse(readTextFixture(name)) as unknown;
}

function decodeFixtureEvents(text: string): OpenCodeRunEvent[] {
  const events: OpenCodeRunEvent[] = [];
  for (const [index, line] of text.trim().split("\n").entries()) {
    const decoded = decodeEvent(JSON.parse(line) as unknown, { phase: "case", caseId: "fixture" }, index + 1);
    if (decoded.ok && decoded.value !== null) {
      events.push(decoded.value);
    }
  }
  return events;
}

function buildModel(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return { id: "alpha", model: "vendor/model-alpha-synth", effort: "effort-high", ...overrides };
}

function buildRepository(overrides: Partial<RepositoryDefinition> = {}): RepositoryDefinition {
  return { id: "repo-1", path: "/tevu-synthetic/repo-1", ...overrides };
}

function buildTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: "task-1",
    title: "Synthetic welcome-route task",
    repo: "repo-1",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    description: "synthetic task description for the welcome route",
    prompt: "TEVU-PROMPT-BODY implement the welcome route",
    readiness: ["synthetic ready item"],
    checks: {
      acceptance: [
        {
          id: "acc-acceptance-command",
          description: "acceptance command exits zero",
          run: ["/synthetic/acceptance-probe", "--suite", "synthetic"],
          timeout: "5s",
          exit_codes: [0],
          env: ["TEVU_EVAL_ORDINARY"],
        },
      ],
      done: [
        { id: "dod-manual-review", description: "manual Definition of Done review", manual: true },
        {
          id: "man-optional-polish",
          description: "optional manual polish review",
          manual: true,
          required: false,
        },
      ],
    },
    ...overrides,
  };
}

function buildJiraTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return buildTask({
    id: "task-2",
    source: {
      kind: "jira",
      key: "TEVU-999",
      url: "https://jira.example.com/browse/TEVU-999",
      imported_at: "2026-09-22T12:00:00.000Z",
      title: "TEVU-JIRA-SUMMARY imported issue title",
      body: "TEVU-JIRA-DESCRIPTION full imported body",
    },
    ...overrides,
  });
}

function buildSyntheticConfig(): TevuConfig {
  const config: TevuConfigInput = {
    version: 1,
    run: { output_dir: "/tevu-synthetic/artifacts", concurrency: 2, timeout: "60s", stop_grace: "1s" },
    agents: { opencode: { command: "/synthetic/opencode", secrets: [PROVIDER_ENV_NAME], env: [] } },
    repositories: [buildRepository()],
    models: [
      buildModel(),
      buildModel({ id: "beta", effort: "effort-low" }),
      buildModel({ id: "gamma", model: "vendor/model-gamma-synth" }),
    ],
    tasks: [buildTask(), buildJiraTask({ base_commit: "fedcba9876543210fedcba9876543210fedcba98" })],
  };
  return TevuConfigSchema.parse(config);
}

function buildCaseIdentity(overrides: Partial<CaseIdentity> = {}): CaseIdentity {
  return {
    caseId: "task-1--alpha",
    taskId: "task-1",
    modelId: "alpha",
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    model: "vendor/model-alpha-synth",
    effort: "effort-high",
    agent: "opencode",
    ...overrides,
  };
}

function buildCheckRecord(overrides: Partial<CheckRecord> & Pick<CheckRecord, "id">): CheckRecord {
  return {
    category: "acceptance",
    description: `synthetic check ${overrides.id}`,
    required: true,
    evaluator: "command",
    ...overrides,
  };
}

function buildProcessResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    startedAt: "2026-09-23T00:00:00.000Z",
    endedAt: "2026-09-23T00:00:01.500Z",
    durationMs: 1500,
    terminationStage: "none",
    ...overrides,
  };
}

function buildCheckResult(overrides: Partial<CheckResult> & Pick<CheckResult, "checkId">): CheckResult {
  return {
    category: "acceptance",
    verdict: "passed",
    evidence: "exit code 0",
    durationMs: 12,
    ...overrides,
  };
}

function buildArtifactIndex(caseId: string, present: ReadonlySet<string>): CaseResult["artifacts"] {
  const paths: Record<string, string> = {
    events: `cases/${caseId}/events.jsonl`,
    diagnostics: `cases/${caseId}/stderr.log`,
    sessionExport: `cases/${caseId}/session.json`,
    solutionPatch: `cases/${caseId}/solution.patch`,
    checks: `cases/${caseId}/checks.json`,
    assessment: `cases/${caseId}/assessment.json`,
    result: `cases/${caseId}/result.json`,
  };
  return {
    events: present.has("events") ? paths.events : null,
    diagnostics: present.has("diagnostics") ? paths.diagnostics : null,
    sessionExport: present.has("sessionExport") ? paths.sessionExport : null,
    solutionPatch: present.has("solutionPatch") ? paths.solutionPatch : null,
    checks: present.has("checks") ? paths.checks : null,
    assessment: present.has("assessment") ? paths.assessment : null,
    result: paths.result,
  };
}

function buildCaseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  return {
    schemaVersion: 1,
    identity: buildCaseIdentity(),
    lifecycle: "completed",
    process: buildProcessResult(),
    outcome: "passed",
    checks: [],
    metrics: unavailableBenchmarkMetrics("not yet normalized"),
    artifacts: buildArtifactIndex("task-1--alpha", new Set(["result"])),
    failure: null,
    ...overrides,
  };
}

function buildAssessmentArtifact(overrides: Partial<AssessmentArtifact> = {}): AssessmentArtifact {
  return {
    schemaVersion: 1,
    runId: "20260923t000000z-synthetic",
    caseId: "task-1--alpha",
    revision: 2,
    current: [
      {
        checkId: "dod-manual-review",
        verdict: "passed",
        assessor: "curator",
        note: "confirmed by reviewer",
        assessedAt: "2026-09-23T01:00:00.000Z",
      },
    ],
    history: [
      {
        checkId: "dod-manual-review",
        verdict: "failed",
        assessor: "curator",
        note: "needs rework",
        assessedAt: "2026-09-23T00:30:00.000Z",
        replacedAt: "2026-09-23T01:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function buildCapabilityReport(overrides: Partial<AgentCapabilityReport> = {}): AgentCapabilityReport {
  return {
    executable: "/synthetic/opencode",
    detectedVersion: "9.9.9-synthetic",
    capabilities: [
      { name: "run command", required: true, availability: "available" },
      { name: "export command", required: true, availability: "available" },
      { name: "run --format json", required: true, availability: "available" },
      { name: "run --model", required: true, availability: "available" },
      { name: "run --variant", required: true, availability: "available" },
    ],
    isolation: { denyOutsideWorktree: "unavailable" },
    ...overrides,
  };
}

function buildManifest(
  runId: string,
  config: TevuConfig,
  capabilities: AgentCapabilityReport,
  caseIds: readonly string[],
): RunManifest {
  return {
    schemaVersion: 1,
    runId,
    configDigest: "sha256-synthetic-digest",
    startedAt: "2026-09-23T00:00:00.000Z",
    completedAt: null,
    host: { platform: "linux", nodeVersion: "v24.21.0", bunVersion: "1.4.2" },
    tools: { gitVersion: "git version 2.45.0", agentVersions: { opencode: capabilities.detectedVersion } },
    execution: { concurrency: config.run.concurrency, caseTimeoutMs: 60_000 },
    cases: caseIds.map((caseId) => {
      const [taskId, modelId] = caseId.split("--") as [string, string];
      const model = config.models.find((entry) => entry.id === modelId);
      const task = config.tasks.find((entry) => entry.id === taskId);
      return buildCaseIdentity({
        caseId,
        taskId,
        modelId,
        sourceCommit: task?.base_commit ?? "0123456789abcdef0123456789abcdef01234567",
        model: model?.model ?? "vendor/model-alpha-synth",
        effort: model?.effort ?? "effort-high",
      });
    }),
    context: { config, capabilities: { opencode: capabilities } },
  };
}

type SyntheticRecords = {
  runId: string;
  config: TevuConfig;
  capabilities: AgentCapabilityReport;
  manifest: RunManifest;
  caseResults: CaseResult[];
  assessment: AssessmentArtifact;
  findings: RunFinding[];
  exportRecord: OpenCodeExport;
  events: OpenCodeRunEvent[];
};

function buildSyntheticRecords(): SyntheticRecords {
  const config = buildSyntheticConfig();
  const capabilities = buildCapabilityReport();
  const runId = "20260923t000000z-synthetic";
  const manifest = buildManifest(runId, config, capabilities, ["task-1--alpha", "task-1--beta", "task-2--alpha"]);

  const parsedExport = structuredClone(readJsonFixture("session-valid.json")) as {
    messages: Array<{ parts: Array<Record<string, unknown>> }>;
  };
  parsedExport.messages[1].parts.push({
    id: "prt-x9",
    sessionID: "ses-root-0001",
    messageID: "msg-a1",
    type: "text",
    text: TRANSCRIPT_BODY,
  });
  const decodedExport = decodeExport(parsedExport, { phase: "case", caseId: "task-1--alpha" });
  if (!decodedExport.ok) {
    throw new Error(`valid export fixture must decode: ${decodedExport.error.reason}`);
  }

  const secretError: OpenCodeRunEvent = {
    type: "error",
    timestamp: 2000,
    sessionID: "ses-root-0001",
    error: { message: `leak ${PROVIDER_SECRET} marker` },
  };
  const events = [...decodeFixtureEvents(readTextFixture("events-valid.jsonl")), secretError];

  const alphaNormalized = requireOpenCodeAdapter().normalizeMetrics({
    caseId: "task-1--alpha",
    sessionId: "ses-root-0001",
    sessionExport: decodedExport.value,
    events,
  });
  if (!alphaNormalized.ok) {
    throw new Error(`fixture metrics must normalize: ${alphaNormalized.error.reason}`);
  }
  const alphaMetrics = combineCaseMetrics({
    durationMs: 1500,
    elapsedUnavailableReason: "unused",
    normalized: alphaNormalized,
  });

  const alpha = buildCaseResult({
    identity: buildCaseIdentity({ caseId: "task-1--alpha" }),
    lifecycle: "completed",
    outcome: "pending",
    checks: [
      buildCheckResult({ checkId: "acc-acceptance-command" }),
      buildCheckResult({
        checkId: "dod-manual-review",
        category: "definition-of-done",
        verdict: "pending",
        evidence: "awaiting manual assessment",
        durationMs: null,
      }),
      buildCheckResult({
        checkId: "man-optional-polish",
        category: "definition-of-done",
        verdict: "pending",
        evidence: "awaiting manual assessment",
        durationMs: null,
      }),
    ],
    metrics: alphaMetrics.metrics,
    artifacts: buildArtifactIndex(
      "task-1--alpha",
      new Set(["events", "diagnostics", "sessionExport", "solutionPatch", "checks", "result"]),
    ),
  });

  const beta = buildCaseResult({
    identity: buildCaseIdentity({ caseId: "task-1--beta", modelId: "beta", effort: "effort-low" }),
    lifecycle: "completed",
    outcome: "failed",
    process: buildProcessResult({ exitCode: 1, endedAt: "2026-09-23T00:00:00.900Z", durationMs: 900 }),
    checks: [
      buildCheckResult({
        checkId: "acc-acceptance-command",
        verdict: "failed",
        evidence: "exit code 1 (not a declared success exit code)",
      }),
    ],
    metrics: unavailableBenchmarkMetrics("root session export unavailable"),
    artifacts: buildArtifactIndex("task-1--beta", new Set(["events", "diagnostics", "checks", "result"])),
    failure: {
      error: { kind: "AgentProcessError", agent: "opencode", caseId: "task-1--beta", exitCode: 1, signal: null },
      occurredAt: "2026-09-23T00:00:00.950Z",
    },
  });

  const gamma = buildCaseResult({
    identity: buildCaseIdentity({
      caseId: "task-2--alpha",
      taskId: "task-2",
      modelId: "gamma",
      model: "vendor/model-gamma-synth",
      sourceCommit: "fedcba9876543210fedcba9876543210fedcba98",
    }),
    lifecycle: "timed-out",
    process: buildProcessResult({
      exitCode: null,
      signal: "SIGKILL",
      endedAt: "2026-09-23T00:00:42.000Z",
      durationMs: 42000,
      terminationStage: "forced",
    }),
    outcome: "not-evaluated",
    checks: [],
    metrics: unavailableBenchmarkMetrics("case timed out; checks were not run"),
    artifacts: buildArtifactIndex("task-2--alpha", new Set([])),
    failure: {
      error: { kind: "CaseTimeoutError", caseId: "task-2--alpha", timeoutMs: 60000 },
      occurredAt: "2026-09-23T00:00:42.100Z",
    },
  });

  return {
    runId,
    config,
    capabilities,
    manifest,
    caseResults: [alpha, beta, gamma],
    assessment: buildAssessmentArtifact({ runId }),
    findings: [{ severity: "warning", caseId: null, message: "cleanup warning: retained synthetic path" }],
    exportRecord: decodedExport.value,
    events,
  };
}

async function appendOrThrow(
  store: ReturnType<typeof createArtifactStore>,
  caseId: string,
  event: AgentEventRecord,
): Promise<void> {
  const appended = await store.appendEvent(caseId, event);
  if (!appended.ok) {
    throw new Error(`appendEvent failed: ${JSON.stringify(appended.error)}`);
  }
}

async function writeChecksOrThrow(
  store: ReturnType<typeof createArtifactStore>,
  caseId: string,
  checks: CheckResult[],
): Promise<void> {
  const written = await store.writeChecks(caseId, checks);
  if (!written.ok) {
    throw new Error(`writeChecks failed: ${JSON.stringify(written.error)}`);
  }
}

async function createSyntheticRun(root: string): Promise<{
  runId: string;
  store: ReturnType<typeof createArtifactStore>;
  records: SyntheticRecords;
}> {
  const records = buildSyntheticRecords();
  const store = createArtifactStore({
    artifactsDirectory: join(root, "artifacts"),
    redact: createRedactor([PROVIDER_SECRET]),
  });

  const started = await store.startRun(records.manifest);
  if (!started.ok) {
    throw new Error(`startRun failed: ${JSON.stringify(started.error)}`);
  }

  for (const event of records.events) {
    await appendOrThrow(store, "task-1--alpha", event);
  }
  const diagnostic = await store.appendDiagnostic("task-1--alpha", `synthetic diagnostic ${PROVIDER_SECRET}`);
  if (!diagnostic.ok) {
    throw new Error(`appendDiagnostic failed: ${JSON.stringify(diagnostic.error)}`);
  }
  const exportWrite = await store.writeSessionExport("task-1--alpha", records.exportRecord as AgentSessionExport);
  if (!exportWrite.ok) {
    throw new Error(`writeSessionExport failed: ${JSON.stringify(exportWrite.error)}`);
  }
  const patchWrite = await store.writePatch("task-1--alpha", {
    caseId: "task-1--alpha",
    content: `${PATCH_BODY}\n`,
    isEmpty: false,
  });
  if (!patchWrite.ok) {
    throw new Error(`writePatch failed: ${JSON.stringify(patchWrite.error)}`);
  }
  await writeChecksOrThrow(store, "task-1--alpha", records.caseResults[0].checks);

  const betaError: OpenCodeRunEvent = {
    type: "error",
    timestamp: 3000,
    sessionID: "ses-beta-0001",
    error: { message: "synthetic provider outage" },
  };
  const betaToolUse: OpenCodeRunEvent = {
    type: "tool_use",
    timestamp: 3100,
    sessionID: "ses-beta-0001",
    part: {
      id: "prt-beta-1",
      sessionID: "ses-beta-0001",
      messageID: "msg-beta-1",
      type: "tool",
      callID: "call-beta-1",
      tool: "bash",
      state: { status: "completed" },
    },
  };
  await appendOrThrow(store, "task-1--beta", betaError);
  await appendOrThrow(store, "task-1--beta", betaToolUse);
  const betaDiagnostic = await store.appendDiagnostic("task-1--beta", "synthetic beta diagnostic");
  if (!betaDiagnostic.ok) {
    throw new Error(`appendDiagnostic failed: ${JSON.stringify(betaDiagnostic.error)}`);
  }
  await writeChecksOrThrow(store, "task-1--beta", records.caseResults[1].checks);

  for (const result of records.caseResults) {
    const finalized = await store.finalizeCase(result);
    if (!finalized.ok) {
      throw new Error(`finalizeCase failed: ${JSON.stringify(finalized.error)}`);
    }
  }

  const run: RunResult = {
    schemaVersion: 1,
    manifest: records.manifest,
    cases: records.caseResults,
    findings: records.findings,
    exitCode: 2,
  };
  const runFinalized = await store.finalizeRun(run);
  if (!runFinalized.ok) {
    throw new Error(`finalizeRun failed: ${JSON.stringify(runFinalized.error)}`);
  }

  const assessment = await store.replaceAssessment(records.assessment);
  if (!assessment.ok) {
    throw new Error(`replaceAssessment failed: ${JSON.stringify(assessment.error)}`);
  }

  return { runId: records.runId, store, records };
}

function caseFile(root: string, runId: string, caseId: string, file: string): string {
  return join(root, "artifacts", runId, "cases", caseId, file);
}

async function digestFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function collectSourceDigests(root: string, runId: string): Promise<string[]> {
  const alpha = ["events.jsonl", "session.json", "solution.patch", "checks.json", "assessment.json"];
  const beta = ["events.jsonl", "checks.json"];
  const digests: string[] = [];
  for (const file of alpha) {
    digests.push(await digestFile(caseFile(root, runId, "task-1--alpha", file)));
  }
  for (const file of beta) {
    digests.push(await digestFile(caseFile(root, runId, "task-1--beta", file)));
  }
  return digests;
}

/**
 * Applies the pre-migration-to-current JSON shape transform to a parsed
 * fixture, in place, turning its shape into what today's `rebuildReport`
 * produces for agent "opencode": `tools.agentVersions` replaces
 * `tools.opencodeVersion`, every capabilities report becomes a single-entry
 * `Record<string, AgentCapabilityReport>`, every case identity gains
 * `agent`, and an `OpenCodeProcessError` failure becomes `AgentProcessError`
 * with `agent`.
 */
function applyPreMigrationJsonTransform(fixture: unknown): NormalizedRunModel {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- transforming an untyped, structurally-known fixture literal
  const model = fixture as any;

  const oldTools = model.manifest.tools as { gitVersion: string; opencodeVersion: string | null };
  model.manifest.tools = { gitVersion: oldTools.gitVersion, agentVersions: { opencode: oldTools.opencodeVersion } };

  const toAgentCapabilityReport = (report: PreMigrationOpenCodeCapabilityReport) => ({
    executable: report.executable,
    detectedVersion: report.detectedVersion,
    capabilities: [
      { name: "run command", required: true, availability: report.commands.run },
      { name: "export command", required: true, availability: report.commands.export },
      { name: "run --format json", required: true, availability: report.runOptions.jsonFormat },
      { name: "run --model", required: true, availability: report.runOptions.model },
      { name: "run --variant", required: true, availability: report.runOptions.variant },
    ],
    isolation: report.isolation,
  });
  model.capabilities = { opencode: toAgentCapabilityReport(model.capabilities as PreMigrationOpenCodeCapabilityReport) };
  model.manifest.context.capabilities = {
    opencode: toAgentCapabilityReport(model.manifest.context.capabilities as PreMigrationOpenCodeCapabilityReport),
  };

  for (const identity of model.manifest.cases) {
    identity.agent = "opencode";
  }
  for (const caseResult of model.cases) {
    caseResult.identity.agent = "opencode";
    if (caseResult.failure?.error?.kind === "OpenCodeProcessError") {
      caseResult.failure.error.kind = "AgentProcessError";
      caseResult.failure.error.agent = "opencode";
    }
  }
  return model as NormalizedRunModel;
}

/** Applies the four agent-naming replacements `report.md` gained for `<name>` as `opencode`. */
function applyPreMigrationMarkdownTransform(fixture: string): string {
  return fixture
    .replace(
      "> later Git history, host OpenCode state, and benchmark artifacts from normal discovery.",
      "> later Git history, host agent state, and benchmark artifacts from normal discovery.",
    )
    .replace(
      /^- OpenCode version \(detected provenance only\): (.+)$/m,
      '- Agent "opencode" version (detected provenance only): $1',
    )
    .replace(
      /^- Isolation control \(deny outside worktree\): (.+)$/m,
      '- Agent "opencode" isolation control (deny outside worktree): $1',
    )
    .replaceAll("OpenCodeProcessError", "AgentProcessError");
}

beforeAll(() => {
  process.env[PROVIDER_ENV_NAME] = PROVIDER_SECRET;
});

afterAll(() => {
  delete process.env[PROVIDER_ENV_NAME];
});

describe("OpenCode report regeneration matches the pinned pre-migration baseline", () => {
  it("rebuilds byte-identically to the pinned pre-migration baseline fixtures once the shape transform is applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "tevu-opencode-report-p4-"));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const rebuilt = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(rebuilt.ok).toBe(true);
      if (!rebuilt.ok) return;

      const expectedJson = serializeNormalizedRun(applyPreMigrationJsonTransform(readJsonFixture("report-18d5127.json")));
      expect(rebuilt.value.normalizedJson).toBe(expectedJson);

      const expectedMarkdown = applyPreMigrationMarkdownTransform(readTextFixture("report-18d5127.md"));
      expect(rebuilt.value.markdown).toBe(expectedMarkdown);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns identical bytes and leaves source-artifact digests unchanged across two consecutive rebuilds", async () => {
    const root = await mkdtemp(join(tmpdir(), "tevu-opencode-report-p5-"));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const digestsBefore = await collectSourceDigests(root, runId);

      const first = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(first.ok).toBe(true);
      const digestsAfterFirst = await collectSourceDigests(root, runId);
      const second = await rebuildReport(runId, store, AGENTS_REGISTRY);
      expect(second.ok).toBe(true);
      const digestsAfterSecond = await collectSourceDigests(root, runId);

      if (!first.ok || !second.ok) return;
      expect(second.value.normalizedJson).toBe(first.value.normalizedJson);
      expect(second.value.markdown).toBe(first.value.markdown);
      expect(digestsAfterFirst).toEqual(digestsBefore);
      expect(digestsAfterSecond).toEqual(digestsBefore);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a run whose case result is missing identity.agent, before any write", async () => {
    const root = await mkdtemp(join(tmpdir(), "tevu-opencode-report-p8-case-"));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const resultPath = caseFile(root, runId, "task-1--alpha", "result.json");
      const before = await readFile(resultPath, "utf8");
      const stored = JSON.parse(before) as { identity: Record<string, unknown> };
      delete stored.identity["agent"];
      await writeFile(resultPath, JSON.stringify(stored, null, 2), "utf8");
      const corrupted = await readFile(resultPath, "utf8");
      const reportPath = join(root, "artifacts", runId, "report.md");

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("ArtifactError");
      expect(await readFile(resultPath, "utf8")).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a run whose manifest is missing tools.agentVersions, before any write", async () => {
    const root = await mkdtemp(join(tmpdir(), "tevu-opencode-report-p8-manifest-"));
    try {
      const { runId, store } = await createSyntheticRun(root);
      const runJsonPath = join(root, "artifacts", runId, "run.json");
      const before = await readFile(runJsonPath, "utf8");
      const stored = JSON.parse(before) as { manifest: { tools: Record<string, unknown> } };
      const { agentVersions, ...toolsWithoutAgentVersions } = stored.manifest.tools;
      stored.manifest.tools = { ...toolsWithoutAgentVersions, opencodeVersion: agentVersions };
      await writeFile(runJsonPath, JSON.stringify(stored, null, 2), "utf8");
      const corrupted = await readFile(runJsonPath, "utf8");
      const reportPath = join(root, "artifacts", runId, "report.md");

      const result = await rebuildReport(runId, store, AGENTS_REGISTRY);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe("ArtifactError");
      expect(await readFile(runJsonPath, "utf8")).toBe(corrupted);
      expect(existsSync(reportPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
