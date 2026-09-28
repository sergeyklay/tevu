// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createArtifactStore } from '@/adapters/artifact-store';
import { createGitWorkspaceAdapter } from '@/adapters/git';
import { createEnvironmentAdapter, createEvaluatorProcessAdapter } from '@/adapters/process';
import { durationMs, TevuConfigSchema } from '@/config/schema';
import { unavailableMetric } from '@/domain/types';

import { planBenchmark, runBenchmark } from './run-benchmark';

import type { TaskInput, TevuConfigInput } from '@/config/schema';
import type {
  AgentAdapter,
  AgentMetrics,
  AgentRunInput,
  AgentRunResult,
  ArtifactStore,
  CaseResult,
  Clock,
  EnvironmentAdapter,
  ModelCallInput,
  ModelCallResult,
  PrerequisiteAdapter,
  ProcessResult,
  RunDependencies,
  RunResult,
  TevuConfig,
  TevuError,
  TevuResult,
} from '@/domain/types';

const FAKE_AGENT_NAME = 'fake-agent';
const CONFIG_PATH = '/synthetic/tevu.yaml';
const GIT_IDENTITY_FLAGS = ['-c', 'user.name=tevu', '-c', 'user.email=tevu@localhost'];

const BASE_GUARD_CONTENT = 'base-guard-content\n';
const AGENT_WEAKENED_GUARD_CONTENT = 'weakened-guard-content\n';
const AGENT_ADDED_TEST_CONTENT = 'agent added test\n';
const BASE_FEATURE_CONTENT = 'base-feature-content\n';
const AGENT_FEATURE_CONTENT = 'agent-fixed-feature\n';
const OVERLAY_FILE_NAME = 'hidden.test.txt';
const OVERLAY_CONTENT = 'hidden-content\n';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

type GitOutcome = { exitCode: number | null; stdout: string; stderr: string };

async function runGit(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  const result = await execa('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    reject: false,
    stdin: 'ignore',
    timeout: 60_000,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

async function createSyntheticRepository(
  testDirectory: string,
): Promise<{ path: string; commit: string }> {
  const path = join(testDirectory, 'source-repo');
  await mkdir(join(path, 'tests'), { recursive: true });
  await mkdir(join(path, 'src'), { recursive: true });
  await writeFile(join(path, 'tests/guard.test.txt'), BASE_GUARD_CONTENT);
  await writeFile(join(path, 'src/feature.txt'), BASE_FEATURE_CONTENT);
  await runGit(path, ['init', '--quiet', '-b', 'main']);
  await runGit(path, ['add', '-A']);
  await runGit(path, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'synthetic base commit']);
  const commit = (await runGit(path, ['rev-parse', 'HEAD'])).stdout.trim();
  return { path, commit };
}

async function createOverlayDirectory(testDirectory: string): Promise<string> {
  const directory = join(testDirectory, 'overlay');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, OVERLAY_FILE_NAME), OVERLAY_CONTENT);
  return directory;
}

function buildVerificationScript(): string {
  return [
    "const fs = require('node:fs');",
    "const guard = fs.readFileSync('tests/guard.test.txt', 'utf8');",
    "const addedExists = fs.existsSync('tests/added.test.txt');",
    `const overlay = fs.readFileSync(${JSON.stringify(OVERLAY_FILE_NAME)}, 'utf8');`,
    "const feature = fs.readFileSync('src/feature.txt', 'utf8');",
    `const ok = guard === ${JSON.stringify(BASE_GUARD_CONTENT)} && !addedExists && overlay === ${JSON.stringify(OVERLAY_CONTENT)} && feature === ${JSON.stringify(AGENT_FEATURE_CONTENT)};`,
    'process.exit(ok ? 0 : 1);',
  ].join('\n');
}

/**
 * Builds the synthetic benchmark configuration: one task declaring a
 * `restore` pattern over `tests/**` and the given `overlay` directory, with
 * two model entries (`TevuConfigSchema` requires at least two) rekeyed onto
 * the fake agent so no real coding agent is invoked.
 */
function buildConfig(options: {
  repositoryPath: string;
  commit: string;
  overlayDirectory: string;
  outputDirectory: string;
  taskTimeout?: string;
}): TevuConfig {
  const input: TevuConfigInput = {
    version: 1,
    run: {
      output_dir: options.outputDirectory,
      concurrency: 1,
      timeout: '30s',
      stop_grace: '500ms',
    },
    agents: { opencode: { command: 'unused-agent-command', secrets: [], env: [] } },
    repositories: [{ id: 'repo-1', path: options.repositoryPath }],
    models: [
      { id: 'm1', model: 'synthetic/model-a', effort: 'fast' },
      { id: 'm2', model: 'synthetic/model-b', effort: 'deep' },
    ],
    tasks: [
      {
        id: 'guard-task',
        title: 'Guard task',
        repo: 'repo-1',
        base_commit: options.commit,
        ...(options.taskTimeout === undefined ? {} : { timeout: options.taskTimeout }),
        description: 'synthetic task description',
        prompt: 'synthetic task prompt',
        readiness: ['synthetic ready item'],
        checks: {
          restore: ['tests/**'],
          overlay: options.overlayDirectory,
          acceptance: [
            {
              id: 'verify-check-state',
              description: 'observes the restored, removed, and overlaid worktree state',
              run: [process.execPath, '-e', buildVerificationScript()],
              timeout: '10s',
              exit_codes: [0],
            },
          ],
          done: [
            {
              id: 'trivial-done',
              description: 'always passes',
              run: [process.execPath, '-e', 'process.exit(0);'],
              timeout: '10s',
              exit_codes: [0],
            },
          ],
        },
      },
    ],
  };
  return rekeyToFakeAgent(TevuConfigSchema.parse(input));
}

/**
 * Renames the schema-required `opencode` key to `fake-agent` after parsing.
 * The strict schema accepts only the literal `opencode` agent key, so this
 * configuration is built through that key and relabeled afterward, mirroring
 * `run-benchmark.test.ts`'s own `rekeyToFakeAgent`.
 */
function rekeyToFakeAgent(config: TevuConfig): TevuConfig {
  const { opencode, ...otherAgents } = config.agents;
  return {
    ...config,
    agents: { ...otherAgents, [FAKE_AGENT_NAME]: opencode },
    models: config.models.map((model) => ({ ...model, agent: FAKE_AGENT_NAME })),
  };
}

function buildProcessResult(): ProcessResult {
  const startedAt = '2026-01-01T00:00:00.000Z';
  const endedAt = '2026-01-01T00:00:01.000Z';
  return {
    exitCode: 0,
    signal: null,
    startedAt,
    endedAt,
    durationMs: 1_000,
    terminationStage: 'none',
  };
}

function unavailableAgentMetrics(reason: string): AgentMetrics {
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

/** What the fake agent's `run` observed and recorded for the test to assert on afterward. */
type FakeAgentCapture = { prompt: string; overlayFilePresentDuringRun: boolean };

type OverlayMutation = 'overwrite' | 'add' | 'delete';

/**
 * Builds a fake `AgentAdapter` whose `run` edits the worktree directly, in
 * place of a real coding agent: weakens the base test file matching
 * `restore`, adds a new file matching `restore`, and edits a source file
 * outside the patterns. When given `mutateOverlay`, it also mutates the
 * overlay directory on disk directly (the way an agent with shell access
 * could) after the run's snapshot has already been pinned.
 */
function buildFakeAgentAdapter(
  capture: FakeAgentCapture,
  overlayDirectory: string,
  mutateOverlay?: OverlayMutation,
): AgentAdapter {
  return {
    async probe() {
      return {
        ok: true,
        value: {
          executable: 'fake-agent',
          detectedVersion: null,
          capabilities: [],
          isolation: { denyOutsideWorktree: 'available' },
        },
      };
    },
    async readProviders() {
      return { ok: true, value: { agent: 'fake-agent', configurationFiles: [], findings: [] } };
    },
    async listModels() {
      return { outcome: 'listed', models: [] };
    },
    async run(input: AgentRunInput): Promise<TevuResult<AgentRunResult, never>> {
      capture.prompt = input.prompt;
      capture.overlayFilePresentDuringRun = existsSync(
        join(input.worktreeDirectory, OVERLAY_FILE_NAME),
      );

      await writeFile(
        join(input.worktreeDirectory, 'tests/guard.test.txt'),
        AGENT_WEAKENED_GUARD_CONTENT,
      );
      await writeFile(
        join(input.worktreeDirectory, 'tests/added.test.txt'),
        AGENT_ADDED_TEST_CONTENT,
      );
      await writeFile(join(input.worktreeDirectory, 'src/feature.txt'), AGENT_FEATURE_CONTENT);

      if (mutateOverlay === 'overwrite') {
        await writeFile(
          join(overlayDirectory, OVERLAY_FILE_NAME),
          'agent-mutated-overlay-content\n',
        );
      } else if (mutateOverlay === 'add') {
        await writeFile(
          join(overlayDirectory, 'agent-added-overlay-file.txt'),
          'agent added overlay file\n',
        );
      } else if (mutateOverlay === 'delete') {
        await rm(overlayDirectory, { recursive: true, force: true });
      }

      const value: AgentRunResult = {
        process: buildProcessResult(),
        sessionId: 'session-1',
        parseFindings: [],
      };
      input.onProcess?.(value);
      return { ok: true, value } as TevuResult<AgentRunResult, never>;
    },
    async exportSession() {
      return { ok: true, value: {} };
    },
    normalizeMetrics() {
      return { ok: true, value: unavailableAgentMetrics('integration test: metrics not measured') };
    },
    async callModel() {
      return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
    },
  };
}

function buildDependencies(
  config: TevuConfig,
  agent: AgentAdapter,
  testDirectory: string,
): RunDependencies {
  const prerequisites: PrerequisiteAdapter = {
    async probeHost() {
      return {
        ok: true,
        value: {
          platform: process.platform === 'darwin' ? 'darwin' : 'linux',
          nodeVersion: process.version,
          gitVersion: 'n/a',
        },
      };
    },
    hasEnvironmentVariable: () => true,
    async probeWritableDirectory() {
      return { ok: true, value: undefined };
    },
  };
  const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
  return {
    git: createGitWorkspaceAdapter({ workspacesDirectory: join(testDirectory, 'workspaces') }),
    agents: new Map([[FAKE_AGENT_NAME, agent]]),
    artifacts: createArtifactStore({
      artifactsDirectory: config.run.output_dir,
      redact: (text) => text,
    }),
    evaluatorProcesses: createEvaluatorProcessAdapter(() => []),
    environments: createEnvironmentAdapter(),
    prerequisites,
    clock,
    generateRunId: () => 'run-tamper-proof-it',
    configDigest: () => 'digest-tamper-proof-it',
    textDigest: () => 'digest-file-tamper-proof-it',
    redact: (text) => text,
    cancellation: new AbortController().signal,
  };
}

function unwrapOk<T, K extends TevuError['kind']>(result: TevuResult<T, K>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, received ${result.error.kind}`);
  }
  return result.value;
}

function caseResultOf(run: RunResult, caseId: string): CaseResult {
  const found = run.cases.find((entry) => entry.identity.caseId === caseId);
  if (found === undefined) {
    throw new Error(`missing case result for ${caseId}`);
  }
  return found;
}

async function readSolutionPatch(
  config: TevuConfig,
  runId: string,
  caseResult: CaseResult,
): Promise<string> {
  const relativePath = caseResult.artifacts.solutionPatch;
  if (relativePath === null) {
    throw new Error('expected the case result to carry a solution patch path');
  }
  return readFile(join(config.run.output_dir, runId, relativePath), 'utf8');
}

let testDirectory = '';

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), 'tevu-check-state-it-'));
});

afterEach(async () => {
  if (testDirectory.length > 0) {
    await rm(testDirectory, { recursive: true, force: true });
    testDirectory = '';
  }
});

describe('runBenchmark tamper-proof check-state (AC-1, P11)', () => {
  it("restores a weakened test file, removes an agent-added file, applies the overlay, and passes the check while the saved patch holds only the agent's edits", async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const overlayDirectory = await createOverlayDirectory(testDirectory);
    const config = buildConfig({
      repositoryPath: repository.path,
      commit: repository.commit,
      overlayDirectory,
      outputDirectory: join(testDirectory, 'artifacts'),
    });
    const capture: FakeAgentCapture = { prompt: '', overlayFilePresentDuringRun: true };
    const agent = buildFakeAgentAdapter(capture, overlayDirectory);
    const dependencies = buildDependencies(config, agent, testDirectory);

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    const caseResult = caseResultOf(run, 'guard-task--m1--1');
    expect(caseResult.lifecycle).toBe('completed');
    expect(caseResult.outcome).toBe('passed');
    expect(caseResult.checks.map((check) => check.verdict)).toEqual(['passed', 'passed']);

    expect(capture.overlayFilePresentDuringRun).toBe(false);
    expect(capture.prompt).not.toContain(overlayDirectory);
    expect(capture.prompt).not.toContain(OVERLAY_CONTENT);

    const patch = await readSolutionPatch(config, run.manifest.runId, caseResult);
    expect(patch).toContain('weakened-guard-content');
    expect(patch).toContain('tests/added.test.txt');
    expect(patch).not.toContain(overlayDirectory);
    expect(patch).not.toContain(OVERLAY_CONTENT);

    expect(caseResult.checkState).toEqual({
      restore: { restored: ['tests/guard.test.txt'], removed: ['tests/added.test.txt'] },
      overlay: {
        files: [{ path: OVERLAY_FILE_NAME, sha256: sha256Hex(OVERLAY_CONTENT) }],
        removed: [],
      },
    });
  });
});

describe.each([
  { label: 'overwrites the overlay file on disk', mutateOverlay: 'overwrite' as const },
  { label: 'adds a file to the overlay directory', mutateOverlay: 'add' as const },
  { label: 'deletes the overlay directory', mutateOverlay: 'delete' as const },
])(
  'runBenchmark tamper-proof check-state when the agent $label after the pin (P18)',
  ({ mutateOverlay }) => {
    it('still passes the check against only the pinned overlay snapshot', async () => {
      const repository = await createSyntheticRepository(testDirectory);
      const overlayDirectory = await createOverlayDirectory(testDirectory);
      const config = buildConfig({
        repositoryPath: repository.path,
        commit: repository.commit,
        overlayDirectory,
        outputDirectory: join(testDirectory, 'artifacts'),
      });
      const capture: FakeAgentCapture = { prompt: '', overlayFilePresentDuringRun: true };
      const agent = buildFakeAgentAdapter(capture, overlayDirectory, mutateOverlay);
      const dependencies = buildDependencies(config, agent, testDirectory);

      const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

      const run = unwrapOk(result);
      const caseResult = caseResultOf(run, 'guard-task--m1--1');
      expect(caseResult.lifecycle).toBe('completed');
      expect(caseResult.outcome).toBe('passed');
      expect(caseResult.checks.map((check) => check.verdict)).toEqual(['passed', 'passed']);
      expect(caseResult.checkState?.overlay).toEqual({
        files: [{ path: OVERLAY_FILE_NAME, sha256: sha256Hex(OVERLAY_CONTENT) }],
        removed: [],
      });
    });
  },
);

describe('runBenchmark records the task timeout in saved artifacts (AC-4)', () => {
  it("writes every manifest and case identity's timeoutMs as the task's own limit, distinct from the default in execution.caseTimeoutMs", async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const overlayDirectory = await createOverlayDirectory(testDirectory);
    const config = buildConfig({
      repositoryPath: repository.path,
      commit: repository.commit,
      overlayDirectory,
      outputDirectory: join(testDirectory, 'artifacts'),
      taskTimeout: '20m',
    });
    const capture: FakeAgentCapture = { prompt: '', overlayFilePresentDuringRun: true };
    const agent = buildFakeAgentAdapter(capture, overlayDirectory);
    const dependencies = buildDependencies(config, agent, testDirectory);

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    expect(run.manifest.execution.caseTimeoutMs).toBe(durationMs('30s'));
    expect(run.manifest.cases.every((identity) => identity.timeoutMs === 1_200_000)).toBe(true);
    expect(run.cases.every((caseResult) => caseResult.identity.timeoutMs === 1_200_000)).toBe(true);

    const storedManifest = unwrapOk(
      await dependencies.artifacts.readRunManifest(run.manifest.runId),
    );
    expect(storedManifest.execution.caseTimeoutMs).toBe(durationMs('30s'));
    expect(storedManifest.cases.every((identity) => identity.timeoutMs === 1_200_000)).toBe(true);

    for (const caseResult of run.cases) {
      const storedCase = unwrapOk(
        await dependencies.artifacts.readCaseResult(run.manifest.runId, caseResult.identity.caseId),
      );
      expect(storedCase.identity.timeoutMs).toBe(1_200_000);
    }
  });
});

describe('runBenchmark providers (AC-1, D10, D11)', () => {
  it('reads providers exactly once before startRun, delivers the same files to every case, and records their digest in run.json', async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const overlayDirectory = await createOverlayDirectory(testDirectory);
    const config = buildConfig({
      repositoryPath: repository.path,
      commit: repository.commit,
      overlayDirectory,
      outputDirectory: join(testDirectory, 'artifacts'),
    });
    const providerFileText = '{"provider":{"acme":{"baseURL":"https://acme.example.test"}}}\n';
    const configurationFiles = [{ relativePath: 'opencode/opencode.json', text: providerFileText }];
    const capture: FakeAgentCapture = { prompt: '', overlayFilePresentDuringRun: true };
    const baseAgent = buildFakeAgentAdapter(capture, overlayDirectory);
    let readProvidersCalls = 0;
    const timeline: string[] = [];
    const receivedConfigTexts: Array<string | null> = [];
    const agent: AgentAdapter = {
      ...baseAgent,
      async readProviders() {
        readProvidersCalls += 1;
        timeline.push('readProviders');
        return { ok: true, value: { agent: FAKE_AGENT_NAME, configurationFiles, findings: [] } };
      },
      async run(input) {
        const configPath = join(
          input.environment.variables.XDG_CONFIG_HOME ?? '',
          'opencode',
          'opencode.json',
        );
        receivedConfigTexts.push(
          existsSync(configPath) ? await readFile(configPath, 'utf8') : null,
        );
        return baseAgent.run(input);
      },
    };
    const dependencies = buildDependencies(config, agent, testDirectory);
    dependencies.textDigest = (text) => sha256Hex(text);
    const realStartRun = dependencies.artifacts.startRun.bind(dependencies.artifacts);
    dependencies.artifacts.startRun = async (manifest) => {
      timeline.push('startRun');
      return realStartRun(manifest);
    };

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    expect(run.cases).toHaveLength(2);
    expect(readProvidersCalls).toBe(1);
    expect(timeline.indexOf('readProviders')).toBeLessThan(timeline.indexOf('startRun'));
    expect(receivedConfigTexts).toEqual([providerFileText, providerFileText]);
    expect(run.manifest.tools.agentConfigurationFiles).toEqual({
      [FAKE_AGENT_NAME]: [{ path: 'opencode/opencode.json', sha256: sha256Hex(providerFileText) }],
    });
    const storedManifest = unwrapOk(
      await dependencies.artifacts.readRunManifest(run.manifest.runId),
    );
    expect(storedManifest.tools.agentConfigurationFiles).toEqual(
      run.manifest.tools.agentConfigurationFiles,
    );
  });

  it('records an empty array in run.json for an agent whose block names no provider', async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const overlayDirectory = await createOverlayDirectory(testDirectory);
    const config = buildConfig({
      repositoryPath: repository.path,
      commit: repository.commit,
      overlayDirectory,
      outputDirectory: join(testDirectory, 'artifacts'),
    });
    const capture: FakeAgentCapture = { prompt: '', overlayFilePresentDuringRun: true };
    const agent = buildFakeAgentAdapter(capture, overlayDirectory);
    const dependencies = buildDependencies(config, agent, testDirectory);

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    expect(run.manifest.tools.agentConfigurationFiles).toEqual({ [FAKE_AGENT_NAME]: [] });
  });
});

describe('runBenchmark grading in the case flow', () => {
  /**
   * Renames the schema-required `opencode` key to `fake-agent`, including
   * `roles.grader.agent`, which the config schema materializes onto the
   * literal `opencode` key at parse time.
   */
  function rekeyGradedConfigToFakeAgent(config: TevuConfig): TevuConfig {
    const { opencode, ...otherAgents } = config.agents;
    return {
      ...config,
      agents: { ...otherAgents, [FAKE_AGENT_NAME]: opencode },
      models: config.models.map((model) => ({ ...model, agent: FAKE_AGENT_NAME })),
      roles:
        config.roles?.grader === undefined
          ? config.roles
          : { ...config.roles, grader: { ...config.roles.grader, agent: FAKE_AGENT_NAME } },
    };
  }

  function buildGradedConfig(options: {
    repositoryPath: string;
    commit: string;
    outputDirectory: string;
    secondTask?: boolean;
  }): TevuConfig {
    const input: TevuConfigInput = {
      version: 1,
      run: {
        output_dir: options.outputDirectory,
        concurrency: 1,
        timeout: '30s',
        stop_grace: '200ms',
      },
      agents: { opencode: { command: 'unused-agent-command', secrets: [], env: [] } },
      repositories: [{ id: 'repo-1', path: options.repositoryPath }],
      models: [
        { id: 'm1', model: 'synthetic/model-a', effort: 'fast' },
        { id: 'm2', model: 'synthetic/model-b', effort: 'deep' },
      ],
      roles: { grader: { model: 'synthetic/grader-model', effort: 'high' } },
      tasks: [
        buildGradedTask(options.commit),
        ...(options.secondTask ? [buildPlainTask(options.commit)] : []),
      ],
    };
    return rekeyGradedConfigToFakeAgent(TevuConfigSchema.parse(input));
  }

  function buildGradedTask(commit: string): TaskInput {
    return {
      id: 'graded-task',
      title: 'Graded task',
      repo: 'repo-1',
      base_commit: commit,
      description: 'synthetic graded task description',
      prompt: 'synthetic graded task prompt',
      readiness: ['synthetic ready item'],
      checks: {
        acceptance: [{ id: 'csv-content', description: 'The output looks right.' }],
        done: [
          {
            id: 'trivial-done',
            description: 'always passes',
            run: [process.execPath, '-e', 'process.exit(0);'],
            timeout: '10s',
            exit_codes: [0],
          },
        ],
      },
    };
  }

  function buildPlainTask(commit: string): TaskInput {
    return {
      id: 'plain-task',
      title: 'Plain task',
      repo: 'repo-1',
      base_commit: commit,
      description: 'synthetic plain task description',
      prompt: 'synthetic plain task prompt',
      readiness: ['synthetic ready item'],
      checks: {
        acceptance: [
          {
            id: 'trivial-acceptance',
            description: 'always passes',
            run: [process.execPath, '-e', 'process.exit(0);'],
            timeout: '10s',
            exit_codes: [0],
          },
        ],
        done: [
          {
            id: 'trivial-done-2',
            description: 'always passes',
            run: [process.execPath, '-e', 'process.exit(0);'],
            timeout: '10s',
            exit_codes: [0],
          },
        ],
      },
    };
  }

  /** A minimal fake `AgentAdapter` whose `run` performs no worktree edits; `callModel` is injected per test. */
  function buildGradingFakeAgentAdapter(
    callModelCalls: ModelCallInput[],
    callModelImpl: (
      input: ModelCallInput,
    ) => Promise<TevuResult<ModelCallResult, TevuError['kind']>>,
  ): AgentAdapter {
    return {
      async probe() {
        return {
          ok: true,
          value: {
            executable: 'fake-agent',
            detectedVersion: null,
            capabilities: [],
            isolation: { denyOutsideWorktree: 'available' },
          },
        };
      },
      async readProviders() {
        return { ok: true, value: { agent: 'fake-agent', configurationFiles: [], findings: [] } };
      },
      async listModels() {
        return { outcome: 'listed', models: [] };
      },
      async run(input: AgentRunInput): Promise<TevuResult<AgentRunResult, never>> {
        const value: AgentRunResult = {
          process: buildProcessResult(),
          sessionId: 'session-1',
          parseFindings: [],
        };
        input.onProcess?.(value);
        return { ok: true, value } as TevuResult<AgentRunResult, never>;
      },
      async exportSession() {
        return { ok: true, value: {} };
      },
      normalizeMetrics() {
        return {
          ok: true,
          value: unavailableAgentMetrics('integration test: metrics not measured'),
        };
      },
      async callModel(input) {
        callModelCalls.push(input);
        return callModelImpl(input);
      },
    } as AgentAdapter;
  }

  function buildGradingDependencies(
    config: TevuConfig,
    agent: AgentAdapter,
    testDir: string,
    options: {
      environments?: EnvironmentAdapter;
      artifacts?: ArtifactStore;
      cancellation?: AbortSignal;
    } = {},
  ): RunDependencies {
    const base = buildDependencies(config, agent, testDir);
    return {
      ...base,
      environments: options.environments ?? base.environments,
      artifacts: options.artifacts ?? base.artifacts,
      cancellation: options.cancellation ?? base.cancellation,
    };
  }

  function repliedGrade(text: string): ModelCallResult {
    return {
      text,
      metrics: unavailableAgentMetrics('integration test: metrics not measured'),
    };
  }

  it('calls the grader exactly once for the case whose task declares a graded check, and never for the plain task', async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const config = buildGradedConfig({
      repositoryPath: repository.path,
      commit: repository.commit,
      outputDirectory: join(testDirectory, 'artifacts'),
      secondTask: true,
    });
    const callModelCalls: ModelCallInput[] = [];
    const agent = buildGradingFakeAgentAdapter(callModelCalls, async () => ({
      ok: true,
      value: repliedGrade(
        '{"grades":[{"check":"csv-content","verdict":"passed","rationale":"ok"}]}',
      ),
    }));
    const dependencies = buildGradingDependencies(config, agent, testDirectory);

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    // Two model entries each run the graded task once, so the grader is
    // called once per graded case; the plain task never triggers it.
    expect(callModelCalls).toHaveLength(2);
    expect(callModelCalls.every((call) => call.role === 'grader')).toBe(true);
    const gradedCaseM1 = caseResultOf(run, 'graded-task--m1--1');
    const gradedCaseM2 = caseResultOf(run, 'graded-task--m2--1');
    expect(gradedCaseM1.artifacts.grading).not.toBeNull();
    expect(gradedCaseM2.artifacts.grading).not.toBeNull();
    expect(gradedCaseM1.checks.find((check) => check.checkId === 'csv-content')?.verdict).toBe(
      'passed',
    );
    const plainCaseM1 = caseResultOf(run, 'plain-task--m1--1');
    const plainCaseM2 = caseResultOf(run, 'plain-task--m2--1');
    expect(plainCaseM1.artifacts.grading).toBeNull();
    expect(plainCaseM2.artifacts.grading).toBeNull();
  });

  it('ends the case cancelled with no grading.json when the run is cancelled during the grader call', async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const config = buildGradedConfig({
      repositoryPath: repository.path,
      commit: repository.commit,
      outputDirectory: join(testDirectory, 'artifacts'),
    });
    const cancelController = new AbortController();
    const callModelCalls: ModelCallInput[] = [];
    const agent = buildGradingFakeAgentAdapter(callModelCalls, async () => {
      cancelController.abort();
      return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
    });
    const dependencies = buildGradingDependencies(config, agent, testDirectory, {
      cancellation: cancelController.signal,
    });

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    const gradedCase = caseResultOf(run, 'graded-task--m1--1');
    expect(gradedCase.lifecycle).toBe('cancelled');
    expect(gradedCase.artifacts.grading).toBeNull();
    expect(
      existsSync(
        join(
          config.run.output_dir,
          run.manifest.runId,
          'cases',
          'graded-task--m1--1',
          'grading.json',
        ),
      ),
    ).toBe(false);
  });

  it('ends the case infrastructure-failed and stops scheduling later cases when writeGrading fails', async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const config: TevuConfig = {
      ...buildGradedConfig({
        repositoryPath: repository.path,
        commit: repository.commit,
        outputDirectory: join(testDirectory, 'artifacts'),
      }),
      run: {
        output_dir: join(testDirectory, 'artifacts'),
        concurrency: 1,
        repeat: 2,
        timeout: '30s',
        stop_grace: '200ms',
      },
    };
    const callModelCalls: ModelCallInput[] = [];
    const agent = buildGradingFakeAgentAdapter(callModelCalls, async () => ({
      ok: true,
      value: repliedGrade(
        '{"grades":[{"check":"csv-content","verdict":"passed","rationale":"ok"}]}',
      ),
    }));
    const baseDependencies = buildDependencies(config, agent, testDirectory);
    const failingArtifacts: ArtifactStore = new Proxy(baseDependencies.artifacts, {
      get(target, property) {
        if (property === 'writeGrading') {
          return async () => ({
            ok: false,
            error: {
              kind: 'ArtifactError',
              operation: 'write-grading',
              reason: 'synthetic write failure',
            },
          });
        }
        return Reflect.get(target, property) as unknown;
      },
    });
    const dependencies = buildGradingDependencies(config, agent, testDirectory, {
      artifacts: failingArtifacts,
    });

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    const firstCase = caseResultOf(run, 'graded-task--m1--1');
    expect(firstCase.lifecycle).toBe('infrastructure-failed');
    expect(firstCase.failure?.error).toEqual({
      kind: 'ArtifactError',
      operation: 'write-grading',
      reason: 'synthetic write failure',
    });
    expect(
      run.cases.find((entry) => entry.identity.caseId === 'graded-task--m1--2'),
    ).toBeUndefined();
    expect(
      run.findings.some(
        (finding) =>
          finding.caseId === 'graded-task--m1--2' &&
          finding.message === 'case was not started because an artifact failure stopped scheduling',
      ),
    ).toBe(true);
  });

  it('leaves the case outcome pending when a required graded check is left pending by an unparseable reply, and the run exits 2', async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const config = buildGradedConfig({
      repositoryPath: repository.path,
      commit: repository.commit,
      outputDirectory: join(testDirectory, 'artifacts'),
    });
    const callModelCalls: ModelCallInput[] = [];
    const agent = buildGradingFakeAgentAdapter(callModelCalls, async () => ({
      ok: true,
      value: repliedGrade('not valid json'),
    }));
    const dependencies = buildGradingDependencies(config, agent, testDirectory);

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    const gradedCase = caseResultOf(run, 'graded-task--m1--1');
    expect(gradedCase.lifecycle).toBe('completed');
    expect(gradedCase.outcome).toBe('pending');
    expect(run.exitCode).toBe(2);
  });

  it('records a warning finding naming the retained grader call directory when its removal fails', async () => {
    const repository = await createSyntheticRepository(testDirectory);
    const config = buildGradedConfig({
      repositoryPath: repository.path,
      commit: repository.commit,
      outputDirectory: join(testDirectory, 'artifacts'),
    });
    const callModelCalls: ModelCallInput[] = [];
    const agent = buildGradingFakeAgentAdapter(callModelCalls, async () => ({
      ok: true,
      value: repliedGrade(
        '{"grades":[{"check":"csv-content","verdict":"passed","rationale":"ok"}]}',
      ),
    }));
    const realEnvironments = createEnvironmentAdapter();
    const environmentsWithFailingDispose: EnvironmentAdapter = {
      ...realEnvironments,
      async createModelCallEnvironment(snapshot, agentVariables, configurationFiles) {
        const created = await realEnvironments.createModelCallEnvironment(
          snapshot,
          agentVariables,
          configurationFiles,
        );
        if (!created.ok) {
          return created;
        }
        return {
          ok: true,
          value: {
            ...created.value,
            dispose: async () => ({
              ok: false,
              error: {
                kind: 'ArtifactError',
                operation: 'dispose-model-call-environment',
                reason: 'synthetic dispose failure',
              },
            }),
          },
        };
      },
    };
    const dependencies = buildGradingDependencies(config, agent, testDirectory, {
      environments: environmentsWithFailingDispose,
    });

    const result = await runBenchmark(planBenchmark(config, CONFIG_PATH), dependencies);

    const run = unwrapOk(result);
    const gradedCase = caseResultOf(run, 'graded-task--m1--1');
    expect(gradedCase.artifacts.grading).not.toBeNull();
    expect(
      run.findings.some(
        (finding) =>
          finding.severity === 'warning' &&
          finding.caseId === 'graded-task--m1--1' &&
          finding.message.startsWith('grader call directory could not be removed; retained at "'),
      ),
    ).toBe(true);
  });
});
