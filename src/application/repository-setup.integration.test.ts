// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGitWorkspaceAdapter } from '@/adapters/git';
import { createEnvironmentAdapter, createEvaluatorProcessAdapter } from '@/adapters/process';
import { TevuConfigSchema } from '@/config/schema';
import { unavailableMetric } from '@/domain/types';

import { planBenchmark, runBenchmark } from './run-benchmark';

import type { TevuConfig, TevuConfigInput } from '@/config/schema';
import type {
  AgentAdapter,
  AgentCapabilityReport,
  AgentMetrics,
  AgentRegistry,
  AgentRunResult,
  ArtifactStore,
  CaseArtifactPathIndex,
  CaseResult,
  Clock,
  HostProbe,
  PrerequisiteAdapter,
  RunDependencies,
  TevuError,
  TevuResult,
} from '@/domain/types';

const GIT_IDENTITY_FLAGS = ['-c', 'user.name=tevu', '-c', 'user.email=tevu@localhost'];

const MODEL_EDIT_BASE = 'base content for model edit\n';
const MODEL_EDIT_APPEND = 'model change\n';
const MODEL_ADDED_CONTENT = 'added by the agent\n';
const RESTORE_BASE_CONTENT = 'base restore target\n';
const OVERLAY_CONTENT = 'overlay marker content\n';
const SETUP_OUTPUT_CONTENT = 'setup output content\n';
const CONFIG_CORRECT_CONTENT = 'correct config\n';
const CONFIG_CORRUPTED_CONTENT = 'CORRUPTED\n';

let testDirectory = '';
let markersDirectory = '';

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'tevu-setup-it-'));
  markersDirectory = join(testDirectory, 'markers');
});

afterEach(async () => {
  if (testDirectory.length > 0) {
    await rm(testDirectory, { recursive: true, force: true });
    testDirectory = '';
  }
});

function unwrapOk<T, K extends TevuError['kind']>(result: TevuResult<T, K>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, received ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execa('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    reject: true,
    stdin: 'ignore',
    timeout: 60_000,
  });
}

async function createSourceRepository(): Promise<{ path: string; commit: string }> {
  const path = join(testDirectory, 'source-repo');
  await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(join(path, 'src/model-edit.txt'), MODEL_EDIT_BASE);
  await writeFile(join(path, 'src/restore-target.txt'), RESTORE_BASE_CONTENT);
  await runGit(path, ['init', '--quiet', '-b', 'main']);
  await runGit(path, ['add', '-A']);
  await runGit(path, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'base commit']);
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: path });
  return { path, commit: stdout.trim() };
}

/** JSON-quotes a path for embedding in a `node -e` script string. */
function quotePath(path: string): string {
  return JSON.stringify(path);
}

function beforeAgentScript(): string {
  return [
    "const fs = require('node:fs');",
    "fs.mkdirSync('generated', { recursive: true });",
    `fs.writeFileSync('generated/setup-output.txt', ${quotePath(SETUP_OUTPUT_CONTENT)});`,
    `fs.writeFileSync('generated/config.json', ${quotePath(CONFIG_CORRECT_CONTENT)});`,
  ].join('\n');
}

function beforeChecksScript(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const markers = ${quotePath(markersDirectory)};`,
    'fs.mkdirSync(markers, { recursive: true });',
    "fs.writeFileSync(path.join(markers, 'restore-observed.txt'), fs.readFileSync('src/restore-target.txt', 'utf8'));",
    "fs.writeFileSync(path.join(markers, 'overlay-observed.txt'), fs.existsSync('overlay-marker.txt') ? fs.readFileSync('overlay-marker.txt', 'utf8') : 'MISSING');",
    `fs.writeFileSync('generated/config.json', ${quotePath(CONFIG_CORRECT_CONTENT)});`,
    "fs.writeFileSync(path.join(markers, 'before-checks-end.txt'), String(Date.now()));",
  ].join('\n');
}

function acceptanceCheckScript(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const markers = ${quotePath(markersDirectory)};`,
    "fs.writeFileSync(path.join(markers, 'check-start.txt'), String(Date.now()));",
    "fs.writeFileSync(path.join(markers, 'check-observed-config.txt'), fs.readFileSync('generated/config.json', 'utf8'));",
    'process.exit(0);',
  ].join('\n');
}

function buildConfig(repositoryPath: string, commit: string, overlayDirectory: string): TevuConfig {
  const config: TevuConfigInput = {
    version: 1,
    run: {
      output_dir: join(testDirectory, 'artifacts'),
      concurrency: 1,
      timeout: '30s',
      stop_grace: '1s',
    },
    agents: { opencode: { command: '/unused/agent', secrets: [], env: [] } },
    repositories: [
      {
        id: 'repo-1',
        path: repositoryPath,
        setup: {
          before_agent: [[process.execPath, '-e', beforeAgentScript()]],
          before_checks: [[process.execPath, '-e', beforeChecksScript()]],
          timeout: '10s',
          env: [],
        },
      },
    ],
    models: [
      { id: 'c1', model: 'synthetic/model-a', effort: 'fast' },
      { id: 'c2', model: 'synthetic/model-b', effort: 'deep' },
    ],
    tasks: [
      {
        id: 'task-1',
        title: 'Synthetic setup task',
        repo: 'repo-1',
        base_commit: commit,
        description: 'synthetic task description',
        prompt: 'implement the synthetic feature',
        readiness: ['synthetic ready item'],
        checks: {
          restore: ['src/restore-target.txt'],
          overlay: overlayDirectory,
          acceptance: [
            {
              id: 'acc-repaired',
              description: 'the repaired config is visible to the check',
              run: [process.execPath, '-e', acceptanceCheckScript()],
              timeout: '10s',
              exit_codes: [0],
              env: [],
            },
          ],
          done: [
            {
              id: 'dod-noop',
              description: 'no-op done check',
              run: [process.execPath, '-e', 'process.exit(0);'],
              timeout: '10s',
              exit_codes: [0],
              env: [],
            },
          ],
        },
      },
    ],
  };
  return TevuConfigSchema.parse(config);
}

function buildAgentMetricsStub(): AgentMetrics {
  const reason = 'not used in this test';
  return {
    inputTokens: unavailableMetric('token', reason),
    outputTokens: unavailableMetric('token', reason),
    reasoningTokens: unavailableMetric('token', reason),
    cacheReadTokens: unavailableMetric('token', reason),
    cacheWriteTokens: unavailableMetric('token', reason),
    turns: unavailableMetric('count', reason),
    apiCalls: unavailableMetric('count', reason),
    apiErrors: unavailableMetric('count', reason),
    toolCalls: unavailableMetric('count', reason),
    skillCalls: unavailableMetric('count', reason),
    cost: unavailableMetric('USD', reason),
  };
}

function buildAgentCapabilityReport(): AgentCapabilityReport {
  return {
    executable: '/unused/agent',
    detectedVersion: null,
    capabilities: [],
    isolation: { denyOutsideWorktree: 'available' },
  };
}

/** The "agent": edits the worktree directly with plain Node fs calls, no model or subprocess involved. */
function buildDirectEditAgent(): AgentAdapter {
  return {
    async probe() {
      return { ok: true, value: buildAgentCapabilityReport() };
    },
    async run(input) {
      const worktree = input.worktreeDirectory;
      const setupOutput = await readFile(join(worktree, 'generated/setup-output.txt'), 'utf8');
      if (setupOutput !== SETUP_OUTPUT_CONTENT) {
        throw new Error(
          `expected before_agent's output to be visible to the agent, got: ${setupOutput}`,
        );
      }
      await writeFile(
        join(worktree, 'src/model-edit.txt'),
        `${MODEL_EDIT_BASE}${MODEL_EDIT_APPEND}`,
      );
      await writeFile(join(worktree, 'src/model-added.txt'), MODEL_ADDED_CONTENT);
      await writeFile(join(worktree, 'src/restore-target.txt'), 'agent modified\n');
      await writeFile(join(worktree, 'generated/config.json'), CONFIG_CORRUPTED_CONTENT);
      const result: AgentRunResult = {
        process: {
          exitCode: 0,
          signal: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:01.000Z',
          durationMs: 1_000,
          terminationStage: 'none',
        },
        sessionId: null,
        parseFindings: [],
      };
      input.onProcess?.(result);
      return { ok: true, value: result };
    },
    async exportSession() {
      throw new Error('not used in this test: sessionId is always null');
    },
    normalizeMetrics() {
      return { ok: true, value: buildAgentMetricsStub() };
    },
  };
}

function createRecordingArtifactStore(): {
  store: ArtifactStore;
  patches: Map<string, string>;
  results: Map<string, CaseResult>;
} {
  const patches = new Map<string, string>();
  const results = new Map<string, CaseResult>();

  const paths = (caseId: string): CaseArtifactPathIndex => ({
    events: `${caseId}/events.jsonl`,
    diagnostics: `${caseId}/stderr.log`,
    sessionExport: `${caseId}/session.json`,
    solutionPatch: `${caseId}/solution.patch`,
    checks: `${caseId}/checks.json`,
    assessment: `${caseId}/assessment.json`,
    result: `${caseId}/result.json`,
    setupBeforeAgent: `${caseId}/setup-before-agent.log`,
    setupBeforeChecks: `${caseId}/setup-before-checks.log`,
  });

  const store: ArtifactStore = {
    caseArtifactPaths: paths,
    async startRun() {
      return { ok: true, value: undefined };
    },
    async appendEvent() {
      return { ok: true, value: undefined };
    },
    async appendDiagnostic() {
      return { ok: true, value: undefined };
    },
    async writeSessionExport() {
      return { ok: true, value: undefined };
    },
    async writePatch(caseId, patch) {
      patches.set(caseId, patch.content);
      return { ok: true, value: undefined };
    },
    async writeSetupLog() {
      return { ok: true, value: undefined };
    },
    async writeChecks() {
      return { ok: true, value: undefined };
    },
    async finalizeCase(result) {
      results.set(result.identity.caseId, result);
      return { ok: true, value: undefined };
    },
    async replaceCaseResult() {
      return { ok: true, value: undefined };
    },
    async finalizeRun() {
      return { ok: true, value: undefined };
    },
    async writeReport() {
      return { ok: true, value: undefined };
    },
    async readRunManifest() {
      throw new Error('not used in this test');
    },
    async readRunResult() {
      throw new Error('not used in this test');
    },
    async readCaseResult() {
      throw new Error('not used in this test');
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
    async acquireAssessmentLock() {
      throw new Error('not used in this test');
    },
    async replaceAssessment() {
      return { ok: true, value: undefined };
    },
  };

  return { store, patches, results };
}

function buildHostProbe(): HostProbe {
  return {
    platform: 'linux',
    nodeVersion: process.version,
    bunVersion: '0.0.0-synthetic',
    gitVersion: '2.45.0-synthetic',
  };
}

function buildPrerequisites(): PrerequisiteAdapter {
  return {
    async probeHost() {
      return { ok: true, value: buildHostProbe() };
    },
    hasEnvironmentVariable() {
      return true;
    },
    async probeWritableDirectory() {
      return { ok: true, value: undefined };
    },
  };
}

function buildClock(): Clock {
  let ticks = 0;
  return { now: () => new Date(Date.parse('2026-01-01T00:00:00.000Z') + (ticks += 1) * 1_000) };
}

async function readMarker(name: string): Promise<string> {
  return readFile(join(markersDirectory, name), 'utf8');
}

describe('repository setup orchestration end to end (AC-1, P7)', () => {
  it("keeps before_agent output out of the patch, includes the agent's edits, repairs a corrupted setup file before checks, and runs before_checks after restore and overlay (AC-1, P7)", async () => {
    const repository = await createSourceRepository();
    const overlayDirectory = join(testDirectory, 'overlay');
    await mkdir(overlayDirectory, { recursive: true });
    await writeFile(join(overlayDirectory, 'overlay-marker.txt'), OVERLAY_CONTENT);

    const config = buildConfig(repository.path, repository.commit, overlayDirectory);
    const git = createGitWorkspaceAdapter({
      config,
      workspacesDirectory: join(testDirectory, 'workspaces'),
    });
    const environments = createEnvironmentAdapter();
    const evaluatorProcesses = createEvaluatorProcessAdapter(() => []);
    const agents: AgentRegistry = new Map([['opencode', buildDirectEditAgent()]]);
    const artifactsFake = createRecordingArtifactStore();

    const dependencies: RunDependencies = {
      git,
      agents,
      artifacts: artifactsFake.store,
      evaluatorProcesses,
      environments,
      prerequisites: buildPrerequisites(),
      clock: buildClock(),
      generateRunId: () => 'run-setup-it',
      configDigest: () => 'digest-synthetic',
      redact: (text) => text,
      cancellation: new AbortController().signal,
    };

    const run = unwrapOk(await runBenchmark(planBenchmark(config), dependencies));

    const caseId = 'task-1--c1--1';
    const caseResult = run.cases.find((entry) => entry.identity.caseId === caseId);
    if (caseResult === undefined) {
      throw new Error(`missing case result for ${caseId}`);
    }
    expect(caseResult.lifecycle).toBe('completed');
    expect(caseResult.failure).toBeNull();

    const patch = artifactsFake.patches.get(caseId) ?? '';
    expect(patch).not.toContain('setup-output.txt');
    expect(patch).toContain('src/model-edit.txt');
    expect(patch).toContain(MODEL_EDIT_APPEND.trim());
    expect(patch).toContain('src/model-added.txt');
    expect(patch).toContain(MODEL_ADDED_CONTENT.trim());

    const restoreObserved = await readMarker('restore-observed.txt');
    const overlayObserved = await readMarker('overlay-observed.txt');
    const checkObservedConfig = await readMarker('check-observed-config.txt');
    const beforeChecksEnd = Number(await readMarker('before-checks-end.txt'));
    const checkStart = Number(await readMarker('check-start.txt'));

    expect(restoreObserved).toBe(RESTORE_BASE_CONTENT);
    expect(overlayObserved).toBe(OVERLAY_CONTENT);
    expect(checkObservedConfig).toBe(CONFIG_CORRECT_CONTENT);
    expect(beforeChecksEnd).toBeLessThanOrEqual(checkStart);
  }, 30_000);
});
