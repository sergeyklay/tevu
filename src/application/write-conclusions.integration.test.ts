// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createOpenCodeAdapter } from '@/adapters/agents/opencode/opencode';
import { createArtifactStore } from '@/adapters/artifact-store';
import { createGitWorkspaceAdapter } from '@/adapters/git';
import {
  createEnvironmentAdapter,
  createEvaluatorProcessAdapter,
  createRedactor,
  createSecretRedactor,
  runManagedProcess,
} from '@/adapters/process';
import { TevuConfigSchema } from '@/config/schema';
import { buildAgentMetrics, buildSummaryFacts } from '@/evaluation/__fixtures__/report.fixtures';

import { buildVerifiedEfforts } from './__fixtures__/effort.fixtures';
import { assessCase, rebuildReport } from './assess';
import { planBenchmark, runBenchmark } from './run-benchmark';
import { writeTaskConclusions } from './write-conclusions';

import type { ConclusionWriter } from './write-conclusions';
import type { TaskInput, TevuConfigInput } from '@/config/schema';
import type {
  AgentAdapter,
  AgentMetrics,
  AgentRunInput,
  AgentRunResult,
  ArtifactStore,
  ConclusionsArtifact,
  EnvironmentAdapter,
  PrerequisiteAdapter,
  Redactor,
  RunDependencies,
  TevuConfig,
  TevuError,
  TevuResult,
} from '@/domain/types';

const FAKE_AGENT_NAME = 'fake-agent';
const CONFIG_PATH = '/synthetic/tevu.yaml';
const GIT_IDENTITY_FLAGS = ['-c', 'user.name=tevu', '-c', 'user.email=tevu@localhost'];
const SESSION_ID = 'ses-summary-1';

const SETTING_A = 'model-a, fast';
const SETTING_B = 'model-b, deep';
const SEPARATION_MEANS =
  'The outcomes cannot tell the settings apart on this task, and a difference in time or cost does not show which setting produces the better solution.';
const TEMPLATE_CORRECTNESS = `Every model setting did the task: each passed all 2 required checks. ${SEPARATION_MEANS}`;
const TEMPLATE_COST = `${SETTING_B} was cheapest: $0.0200 against $0.0800, about 4 times less.`;
const TEMPLATE_SPEED = `${SETTING_B} was fastest: 2.0 s against 6.0 s, about 3 times faster.`;

const CONFIGURATION_IDS = [
  'alpha-task',
  'beta-task',
  'manual-task',
  'm1',
  'm2',
  'repo-1',
  'acc-command',
  'acc-manual',
  'done-command',
];
const CASE_IDS = ['alpha-task', 'beta-task', 'manual-task'].flatMap((task) =>
  ['m1', 'm2'].map((model) => `${task}--${model}--1`),
);

const ACCEPTED_REPLY = JSON.stringify({
  correctness: {
    leaders: [SETTING_A, SETTING_B],
    text: 'Both model settings did the task and passed all 2 required checks.',
  },
  cost: { leaders: [SETTING_B], text: `${SETTING_B} was the cheapest setting at $0.0200.` },
  speed: { leaders: [SETTING_B], text: `${SETTING_B} was the fastest setting at 2.0 s.` },
});

function replyWithCost(cost: { leaders: string[]; text: string }): string {
  return JSON.stringify({ ...(JSON.parse(ACCEPTED_REPLY) as object), cost });
}

type Run = { config: TevuConfig; runId: string; directory: string };

type Behavior = { run: 'ok' | 'error' | 'sleep'; reply?: string };

type FakeExecutable = { path: string; calls: () => number };

/** What the summary call's export reports; its cost must never reach `summary.md`. */
const SUMMARY_CALL_COST = '$0.7500';

const PROBE_PREAMBLE = `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0-summary-fake"); process.exit(0); }
if (args[0] === "--help") { console.log("usage: fake-opencode <command> [options]"); process.exit(0); }
if (args[0] === "run" && args[1] === "--help") {
  console.log("usage: opencode run --format json --model <model> --variant <variant>");
  process.exit(0);
}
if (args[0] === "export" && args[1] === "--help") {
  console.log("usage: opencode export <session-id>");
  process.exit(0);
}
if (args[0] === "models" && args[1] === "--help") {
  console.log("usage: opencode models [provider] --verbose");
  process.exit(0);
}
`;

function renderRunSection(behavior: Behavior['run'], logPath: string): string {
  const announce = `appendFileSync(${JSON.stringify(logPath)}, "run\\n");`;
  if (behavior === 'sleep') {
    return `
if (args[0] === "run") {
  ${announce}
  setInterval(function () {}, 1000);
}
`;
  }
  if (behavior === 'error') {
    return `
if (args[0] === "run") {
  ${announce}
  console.log(JSON.stringify({ type: "error", timestamp: 1, sessionID: "${SESSION_ID}", error: { data: { message: "Synthetic failure" } } }));
  process.exit(1);
}
`;
  }
  return `
if (args[0] === "run") {
  ${announce}
  console.log(JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "${SESSION_ID}", part: { id: "prt-1", sessionID: "${SESSION_ID}", messageID: "msg-0", type: "step-start" } }));
  process.exit(0);
}
`;
}

function renderExportSection(reply: string): string {
  return `
if (args[0] === "export") {
  var requested = args[1] || "";
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-1", sessionID: requested, role: "assistant", parentID: "msg-0", finish: "stop", cost: 0.75, tokens: { input: 10, output: 20, reasoning: 1, cache: { read: 2, write: 3 } } }, parts: [{ id: "prt-1", sessionID: requested, messageID: "msg-1", type: "text", text: ${JSON.stringify(reply)} }] }] }));
  process.exit(0);
}
`;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function unwrapOk<T, K extends TevuError['kind']>(result: TevuResult<T, K>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, received ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function unwrapFailure<T, K extends TevuError['kind']>(result: TevuResult<T, K>): TevuError {
  if (result.ok) {
    throw new Error('expected a failure, received an ok result');
  }
  return result.error;
}

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
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
  return typeof result.stdout === 'string' ? result.stdout : '';
}

async function createSyntheticRepository(root: string): Promise<{ path: string; commit: string }> {
  const path = join(root, 'source-repo');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'README.md'), 'synthetic repository\n');
  await runGit(path, ['init', '--quiet', '-b', 'main']);
  await runGit(path, ['add', '-A']);
  await runGit(path, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'synthetic base commit']);
  return { path, commit: (await runGit(path, ['rev-parse', 'HEAD'])).trim() };
}

const PASSING_COMMAND: [string, ...string[]] = [process.execPath, '-e', 'process.exit(0);'];

function buildTask(id: string, title: string, manual = false): TaskInput {
  return {
    id,
    title,
    repo: 'repo-1',
    base_commit: '0123456789abcdef0123456789abcdef01234567',
    description: 'synthetic task description',
    prompt: 'synthetic task prompt',
    readiness: ['synthetic ready item'],
    checks: {
      acceptance: [
        manual
          ? { id: 'acc-manual', description: 'a person confirms the redirect', manual: true }
          : {
              id: 'acc-command',
              description: 'the acceptance command passes',
              run: PASSING_COMMAND,
              timeout: '10s',
              exit_codes: [0],
            },
      ],
      done: [
        {
          id: 'done-command',
          description: 'the done command passes',
          run: PASSING_COMMAND,
          timeout: '10s',
          exit_codes: [0],
        },
      ],
    },
  };
}

/**
 * Two model entries on the fake agent, and a `roles.summary` on the sole
 * `opencode` agent, which the summary call reaches through a fake executable.
 */
function buildConfig(options: {
  repositoryPath: string;
  outputDirectory: string;
  tasks: TaskInput[];
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
      { id: 'm1', model: 'litellm/vendor/model-a', effort: 'fast' },
      { id: 'm2', model: 'vendor/model-b', effort: 'deep' },
    ],
    roles: { summary: { model: 'vendor/summary-model', effort: 'medium' } },
    tasks: options.tasks,
  };
  const config = TevuConfigSchema.parse(input);
  const { opencode } = config.agents;
  return {
    ...config,
    agents: { ...config.agents, [FAKE_AGENT_NAME]: opencode },
    models: config.models.map((model) => ({ ...model, agent: FAKE_AGENT_NAME })),
  };
}

function costOf(caseId: string): number {
  return caseId.includes('--m1--') ? 0.08 : 0.02;
}

function buildRunMetrics(caseId: string): AgentMetrics {
  return buildAgentMetrics({
    cost: {
      value: costOf(caseId),
      unit: 'USD',
      availability: { status: 'available', source: 'export' },
      scope: 'root-session',
    },
  });
}

/** The coding agent of the run: no edits, 6 s for model-a and 2 s for model-b, $0.08 and $0.02. */
function buildRunAdapter(): AgentAdapter {
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
      return {
        ok: true,
        value: { agent: 'fake-agent', configurationFiles: [], findings: [], copiedProviders: [] },
      };
    },
    async inspectOperatorProvider() {
      return { ok: true, value: { defined: false } };
    },
    async listModels() {
      return { outcome: 'listed', models: [], variants: new Map() };
    },
    repositoryConfigurationEntries() {
      return [];
    },
    async run(input: AgentRunInput): Promise<TevuResult<AgentRunResult, never>> {
      const duration = input.identity.modelId === 'm1' ? 6_000 : 2_000;
      const value: AgentRunResult = {
        process: {
          exitCode: 0,
          signal: null,
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:06.000Z',
          durationMs: duration,
          terminationStage: 'none',
        },
        sessionId: 'session-1',
        parseFindings: [],
      };
      input.onProcess?.(value);
      return { ok: true, value };
    },
    async exportSession() {
      return { ok: true, value: {} };
    },
    normalizeMetrics(input) {
      return { ok: true, value: buildRunMetrics(input.caseId) };
    },
    async callModel() {
      return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
    },
  };
}

function buildRunDependencies(config: TevuConfig, root: string, runId: string): RunDependencies {
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
  return {
    git: createGitWorkspaceAdapter({ workspacesDirectory: join(root, `workspaces-${runId}`) }),
    agents: new Map([[FAKE_AGENT_NAME, buildRunAdapter()]]),
    artifacts: createArtifactStore({
      artifactsDirectory: config.run.output_dir,
      redact: (text) => text,
    }),
    evaluatorProcesses: createEvaluatorProcessAdapter(() => []),
    environments: createEnvironmentAdapter(),
    prerequisites,
    clock: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    generateRunId: () => runId,
    configDigest: () => `digest-${runId}`,
    textDigest: sha256Hex,
    redact: (text) => text,
    cancellation: new AbortController().signal,
  };
}

let root = '';
let mainRun: Run;
let manualRun: Run;
let scriptCounter = 0;
let copyCounter = 0;

async function executeRun(name: string, tasks: TaskInput[]): Promise<Run> {
  const repository = await createSyntheticRepository(join(root, name));
  const directory = join(root, name, 'artifacts');
  const config = buildConfig({
    repositoryPath: repository.path,
    outputDirectory: directory,
    tasks: tasks.map((task) => ({ ...task, base_commit: repository.commit })),
  });
  const runId = `run-${name}`;
  const result = await runBenchmark(
    planBenchmark(config, CONFIG_PATH, buildVerifiedEfforts(config)),
    buildRunDependencies(config, root, runId),
  );
  unwrapOk(result);
  return { config, runId, directory };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tevu-summary-it-'));
  mainRun = await executeRun('main', [
    buildTask('alpha-task', 'Fix the welcome route'),
    buildTask('beta-task', 'Add the export button'),
  ]);
  manualRun = await executeRun('manual', [buildTask('manual-task', 'Review the redirect', true)]);
}, 120_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A private copy of a finished run, so a test can rewrite its files freely. */
async function copyOf(run: Run, redact: Redactor = (text) => text) {
  copyCounter += 1;
  const directory = join(root, `copy-${copyCounter}`);
  await cp(run.directory, directory, { recursive: true });
  const store: ArtifactStore = createArtifactStore({ artifactsDirectory: directory, redact });
  return { store, directory, runId: run.runId };
}

async function writeFakeOpenCode(behavior: Behavior): Promise<FakeExecutable> {
  scriptCounter += 1;
  const path = join(root, `fake-opencode-${scriptCounter}.mjs`);
  const logPath = join(root, `calls-${scriptCounter}.log`);
  const body =
    '#!/usr/bin/env node\n' +
    'import { appendFileSync } from "node:fs";\n' +
    PROBE_PREAMBLE +
    renderRunSection(behavior.run, logPath) +
    renderExportSection(behavior.reply ?? ACCEPTED_REPLY) +
    '\nif (args[0] !== "run" && args[0] !== "export") { process.exit(3); }\n';
  await writeFile(path, body, { mode: 0o755 });
  await chmod(path, 0o755);
  return {
    path,
    calls: () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').length - 1 : 0),
  };
}

function buildWriter(options: {
  config: TevuConfig;
  executable: FakeExecutable;
  redact?: Redactor;
  cancellation?: AbortSignal;
}): ConclusionWriter {
  const secrets = createSecretRedactor(() => [], createRedactor([]));
  const adapter = createOpenCodeAdapter(
    {
      agent: 'opencode',
      executable: options.executable.path,
      providers: [],
      declaredVariables: { secrets: [], env: [] },
    },
    {
      runProcess: runManagedProcess,
      secrets,
      probeEnvironment: { PATH: process.env['PATH'] ?? '' },
      probeDirectory: process.cwd(),
      operatorDirectories: { home: undefined, xdgConfigHome: undefined },
    },
  );
  const environments: EnvironmentAdapter = createEnvironmentAdapter();
  return {
    write: (evidence) =>
      writeTaskConclusions(
        {
          config: options.config,
          evidence,
          redact: options.redact ?? ((text) => text),
          cancellation: options.cancellation ?? new AbortController().signal,
        },
        {
          agents: new Map([['opencode', adapter]]),
          environments,
          git: createGitWorkspaceAdapter({ workspacesDirectory: join(root, 'call-workspaces') }),
        },
      ),
  };
}

const RUN_AGENTS = new Map([[FAKE_AGENT_NAME, buildRunAdapter()]]);

async function readFiles(directory: string, runId: string) {
  const read = (name: string) => readFile(join(directory, runId, name), 'utf8');
  return {
    conclusions: await read('conclusions.json'),
    summary: await read('summary.md'),
    report: await read('report.md'),
    result: await read('result.json'),
  };
}

/** The first verification property: one link, and no ID, path, file name, footnote, or error name. */
function expectCleanSummary(markdown: string): void {
  const links = markdown.match(/(?<!\\)\[(?:\\.|[^\]\\])*\]\([^)]*\)/g) ?? [];
  expect(links).toEqual(['[report.md](report.md)']);
  for (const caseId of CASE_IDS) {
    expect(markdown).not.toContain(caseId);
  }
  for (const id of CONFIGURATION_IDS) {
    expect(markdown).not.toMatch(new RegExp(`(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_-])`));
  }
  expect(markdown).not.toContain(root);
  expect(markdown).not.toContain('cases/');
  const fileNames = markdown.match(/[A-Za-z0-9_-]+\.(?:md|json|jsonl|yaml|patch|log|txt)\b/g) ?? [];
  expect([...new Set(fileNames)]).toEqual(['report.md']);
  expect(markdown).not.toContain('Technical detail:');
  expect(markdown).not.toMatch(/\\\[\d+\\\]/);
  expect(markdown).not.toMatch(/(?<![A-Za-z0-9_])[A-Z][A-Za-z]*Error(?![A-Za-z0-9_])/);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('expected a JSON object');
  }
  // Narrowed to a non-null object above; the saved artifact has string keys only.
  return value as Record<string, unknown>;
}

function summarySentences(markdown: string, aspect: 'Correctness' | 'Cost' | 'Speed'): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith(`- **${aspect}:**`))
    .map((line) => line.slice(`- **${aspect}:** `.length));
}

describe('tevu run with no roles.summary', () => {
  it('saves the template sentences with no call, and writes summary.md from the saved entries', async () => {
    const { store, directory, runId } = await copyOf(mainRun);
    const executable = await writeFakeOpenCode({ run: 'ok' });
    const withoutRole = { ...mainRun.config, roles: {} };

    const rebuilt = unwrapOk(
      await rebuildReport(
        runId,
        store,
        RUN_AGENTS,
        buildWriter({ config: withoutRole, executable }),
      ),
    );

    const saved = unwrapOk(await store.readConclusions(runId));
    expect(saved?.tasks.map((entry) => [entry.taskId, entry.call, entry.conclusions])).toEqual(
      ['alpha-task', 'beta-task'].map((taskId) => [
        taskId,
        null,
        { correctness: TEMPLATE_CORRECTNESS, cost: TEMPLATE_COST, speed: TEMPLATE_SPEED },
      ]),
    );
    expect(executable.calls()).toBe(0);
    expect(rebuilt.retainedDirectories).toEqual([]);
    const { summary, report } = await readFiles(directory, runId);
    expect(summary).toBe(
      [
        '# Model comparison summary',
        '',
        ...[['Fix the welcome route'], ['Add the export button']].flatMap(([title]) => [
          `## ${title}`,
          '',
          'Compared 2 model settings on this task in source-repo, with 1 attempt each, on 2026-01-01 at 00:00 UTC.',
          '',
          '| Model | Effort | Outcome | Required checks | Elapsed | Cost | Turns | Tool calls | Input | Cache read | Cache write | Output | Reasoning | API errors | Runtime failure |',
          '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
          '| model-a | fast | passed | 2/2 passed | 6.0 s | $0.0800 | 1 | 0 | 100 | 0 | 0 | 20 | 0 | 0 | none |',
          '| model-b | deep | passed | 2/2 passed | 2.0 s | $0.0200 | 1 | 0 | 100 | 0 | 0 | 20 | 0 | 0 | none |',
          '',
          `- **Correctness:** ${TEMPLATE_CORRECTNESS}`,
          `- **Cost:** ${TEMPLATE_COST}`,
          `- **Speed:** ${TEMPLATE_SPEED}`,
          '',
        ]),
        'Details of every attempt, check, and measurement: [report.md](report.md)',
        '',
      ].join('\n'),
    );
    expectCleanSummary(summary);
    expect(report).not.toContain('Summary model');
  });
});

describe('tevu run with roles.summary', () => {
  it('puts an accepted reply in summary.md and conclusions.json, one call per task, and keeps its cost out of summary.md', async () => {
    const { store, directory, runId } = await copyOf(mainRun);
    const executable = await writeFakeOpenCode({ run: 'ok' });

    const rebuilt = unwrapOk(
      await rebuildReport(
        runId,
        store,
        RUN_AGENTS,
        buildWriter({ config: mainRun.config, executable }),
      ),
    );

    expect(executable.calls()).toBe(2);
    expect(rebuilt.retainedDirectories).toEqual([]);
    const saved = unwrapOk(await store.readConclusions(runId));
    for (const entry of saved?.tasks ?? []) {
      expect(entry.call?.model).toEqual({
        model: 'vendor/summary-model',
        effort: 'medium',
        agent: 'opencode',
      });
      expect(entry.call?.outcome).toEqual({ status: 'accepted', reply: ACCEPTED_REPLY });
      expect(entry.call?.metrics.cost.value).toBe(0.75);
      expect(entry.conclusions).toEqual({
        correctness: 'Both model settings did the task and passed all 2 required checks.',
        cost: `${SETTING_B} was the cheapest setting at $0.0200.`,
        speed: `${SETTING_B} was the fastest setting at 2.0 s.`,
      });
    }
    const { summary, report } = await readFiles(directory, runId);
    expect(summarySentences(summary, 'Cost')).toEqual(
      Array(2).fill(`${SETTING_B} was the cheapest setting at $0.0200.`),
    );
    expect(summarySentences(summary, 'Correctness')).toEqual(
      Array(2).fill('Both model settings did the task and passed all 2 required checks.'),
    );
    expect(summary).not.toContain(SUMMARY_CALL_COST);
    expect(summary).not.toContain('Summary model');
    expectCleanSummary(summary);
    expect(report.match(/Summary model for this task, not added to any row: /g)).toHaveLength(2);
    expect(report).toContain(
      `vendor/summary-model (effort medium, agent opencode), its sentences are in the summary, input 10, cache read 2, cache write 3, output 20, reasoning 1, cost ${SUMMARY_CALL_COST}.`,
    );
  });

  it.each([
    {
      name: 'a number that is not in the facts',
      reply: replyWithCost({ leaders: [SETTING_B], text: `${SETTING_B} was cheapest by 7 times.` }),
      reason: 'the cost text names a number that is not in the facts: 7',
    },
    {
      name: 'a model outside an exact setting name',
      reply: replyWithCost({ leaders: [SETTING_B], text: 'model-a was dearer than the rest.' }),
      reason: 'the cost text names a model outside an exact setting name: model-a',
    },
    {
      name: 'leaders that differ from the facts',
      reply: replyWithCost({ leaders: [SETTING_A], text: `${SETTING_A} was cheapest.` }),
      reason: 'the cost leaders differ from the facts',
    },
  ])(
    'falls back to the template sentences and saves the reason when the reply holds $name',
    async ({ reply, reason }) => {
      const { store, directory, runId } = await copyOf(mainRun);
      const executable = await writeFakeOpenCode({ run: 'ok', reply });

      unwrapOk(
        await rebuildReport(
          runId,
          store,
          RUN_AGENTS,
          buildWriter({ config: mainRun.config, executable }),
        ),
      );

      const saved = unwrapOk(await store.readConclusions(runId));
      for (const entry of saved?.tasks ?? []) {
        expect(entry.call?.outcome).toEqual({ status: 'rejected', reply, reason });
        expect(entry.conclusions).toEqual({
          correctness: TEMPLATE_CORRECTNESS,
          cost: TEMPLATE_COST,
          speed: TEMPLATE_SPEED,
        });
      }
      const { summary, report } = await readFiles(directory, runId);
      expect(summarySentences(summary, 'Cost')).toEqual([TEMPLATE_COST, TEMPLATE_COST]);
      expect(summary).not.toContain(SUMMARY_CALL_COST);
      expectCleanSummary(summary);
      expect(report).toContain('its sentences are not in the summary');
      expect(report).toContain(`Technical detail: ${reason}`);
    },
  );

  it('falls back to the template sentences with a no-reply entry when the call fails', async () => {
    const { store, directory, runId } = await copyOf(mainRun);
    const executable = await writeFakeOpenCode({ run: 'error' });

    const rebuilt = unwrapOk(
      await rebuildReport(
        runId,
        store,
        RUN_AGENTS,
        buildWriter({ config: mainRun.config, executable }),
      ),
    );

    expect(executable.calls()).toBe(2);
    expect(rebuilt.retainedDirectories).toEqual([]);
    const saved = unwrapOk(await store.readConclusions(runId));
    for (const entry of saved?.tasks ?? []) {
      expect(entry.call?.outcome.status).toBe('no-reply');
      expect(entry.call?.outcome).toMatchObject({
        reason: expect.stringMatching(/^the summary call failed: /),
      });
      expect(entry.conclusions.cost).toBe(TEMPLATE_COST);
    }
    const { summary, report } = await readFiles(directory, runId);
    expect(summarySentences(summary, 'Correctness')).toEqual([
      TEMPLATE_CORRECTNESS,
      TEMPLATE_CORRECTNESS,
    ]);
    expectCleanSummary(summary);
    expect(report).toContain('The summary model returned no sentences.');
  });

  describe('a prompt that cannot be redacted', () => {
    // The injected redactor is typed to return text; a defective one is simulated through a double assertion.
    const NON_STRING_REDACTOR = (() => 42) as unknown as Redactor;
    const THROWING_REDACTOR: Redactor = () => {
      throw new Error('redactor failure');
    };

    it.each([
      { name: 'throws', redact: THROWING_REDACTOR },
      { name: 'returns no text', redact: NON_STRING_REDACTOR },
    ])('makes no call and saves a no-reply entry when the redactor $name', async ({ redact }) => {
      const { store, directory, runId } = await copyOf(mainRun);
      const executable = await writeFakeOpenCode({ run: 'ok' });

      unwrapOk(
        await rebuildReport(
          runId,
          store,
          RUN_AGENTS,
          buildWriter({ config: mainRun.config, executable, redact }),
        ),
      );

      expect(executable.calls()).toBe(0);
      const saved = unwrapOk(await store.readConclusions(runId));
      for (const entry of saved?.tasks ?? []) {
        expect(entry.call?.outcome).toEqual({
          status: 'no-reply',
          reason: 'the summary prompt could not be redacted; the summary model was not called',
        });
        expect(entry.call?.metrics.cost).toMatchObject({ value: null });
        expect(entry.conclusions.cost).toBe(TEMPLATE_COST);
      }
      expectCleanSummary((await readFiles(directory, runId)).summary);
    });
  });

  it('skips every remaining call after a cancellation and saves template entries with no call', async () => {
    const { store, directory, runId } = await copyOf(mainRun);
    const executable = await writeFakeOpenCode({ run: 'sleep' });
    const controller = new AbortController();
    const writer = buildWriter({
      config: mainRun.config,
      executable,
      cancellation: controller.signal,
    });

    const rebuilding = rebuildReport(runId, store, RUN_AGENTS, writer);
    await vi.waitFor(() => expect(executable.calls()).toBe(1), { timeout: 15_000 });
    controller.abort();
    const rebuilt = unwrapOk(await rebuilding);

    expect(executable.calls()).toBe(1);
    expect(rebuilt.retainedDirectories).toEqual([]);
    const saved = unwrapOk(await store.readConclusions(runId));
    expect(saved?.tasks.map((entry) => [entry.taskId, entry.call, entry.conclusions.cost])).toEqual(
      ['alpha-task', 'beta-task'].map((taskId) => [taskId, null, TEMPLATE_COST]),
    );
    const { summary } = await readFiles(directory, runId);
    expect(summarySentences(summary, 'Cost')).toEqual([TEMPLATE_COST, TEMPLATE_COST]);
    expectCleanSummary(summary);
  }, 30_000);
});

describe('rebuildReport with a conclusion writer', () => {
  it('asks for no conclusions after a cancellation and saves template sentences with no call for the remaining tasks', async () => {
    const { store, directory, runId } = await copyOf(mainRun);
    const write = vi.fn<ConclusionWriter['write']>(async () => ({ status: 'cancelled' }));

    const rebuilt = unwrapOk(await rebuildReport(runId, store, RUN_AGENTS, { write }));

    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0].taskId).toBe('alpha-task');
    expect(rebuilt.retainedDirectories).toEqual([]);
    const saved = unwrapOk(await store.readConclusions(runId));
    expect(saved?.tasks.map((entry) => [entry.taskId, entry.call, entry.conclusions.cost])).toEqual(
      ['alpha-task', 'beta-task'].map((taskId) => [taskId, null, TEMPLATE_COST]),
    );
    const { summary } = await readFiles(directory, runId);
    expect(summarySentences(summary, 'Speed')).toEqual([TEMPLATE_SPEED, TEMPLATE_SPEED]);
  });

  it('returns the retained directory of every task in task ID order', async () => {
    const { store, runId } = await copyOf(mainRun);
    const write = vi.fn<ConclusionWriter['write']>(async (evidence) => ({
      status: 'written',
      conclusions: {
        taskId: evidence.taskId,
        facts: evidence.facts,
        conclusions: { correctness: 'A.', cost: 'B.', speed: 'C.' },
        call: null,
      },
      retainedDirectory: `/tmp/tevu-call-${evidence.taskId}`,
    }));

    const rebuilt = unwrapOk(await rebuildReport(runId, store, RUN_AGENTS, { write }));

    expect(rebuilt.retainedDirectories).toEqual([
      '/tmp/tevu-call-alpha-task',
      '/tmp/tevu-call-beta-task',
    ]);
  });
});

describe('tevu report after the run', () => {
  it('rewrites result.json, report.md, and summary.md byte-identically with no summary executable available', async () => {
    const { store, directory, runId } = await copyOf(mainRun);
    const executable = await writeFakeOpenCode({ run: 'ok' });
    unwrapOk(
      await rebuildReport(
        runId,
        store,
        RUN_AGENTS,
        buildWriter({ config: mainRun.config, executable }),
      ),
    );
    const before = await readFiles(directory, runId);
    await rm(executable.path);

    unwrapOk(await rebuildReport(runId, store, RUN_AGENTS));

    const after = await readFiles(directory, runId);
    expect(after).toEqual(before);
    expect(executable.calls()).toBe(2);
    expectCleanSummary(after.summary);
  });

  it('renders template sentences from the derived facts for a run with no conclusions.json', async () => {
    const written = await copyOf(mainRun);
    const executable = await writeFakeOpenCode({ run: 'ok' });
    unwrapOk(
      await rebuildReport(
        written.runId,
        written.store,
        RUN_AGENTS,
        buildWriter({ config: { ...mainRun.config, roles: {} }, executable }),
      ),
    );
    const expected = (await readFiles(written.directory, written.runId)).summary;
    const { store, directory, runId } = await copyOf(mainRun);
    expect(existsSync(join(directory, runId, 'conclusions.json'))).toBe(false);

    unwrapOk(await rebuildReport(runId, store, RUN_AGENTS));

    const summary = await readFile(join(directory, runId, 'summary.md'), 'utf8');
    expect(summary).toBe(expected);
    expectCleanSummary(summary);
  });

  it('refuses a malformed conclusions.json, names the file, and says deleting it gives template sentences', async () => {
    const { store, directory, runId } = await copyOf(mainRun);
    await writeFile(join(directory, runId, 'conclusions.json'), '{"schemaVersion":1,"tasks":[');

    const error = unwrapFailure(await rebuildReport(runId, store, RUN_AGENTS));

    expect(error).toMatchObject({ kind: 'ArtifactError', operation: 'read-conclusions' });
    expect(error).toMatchObject({
      reason: expect.stringContaining('conclusions.json'),
    });
    expect(error).toMatchObject({
      reason: expect.stringContaining('delete it to make the summary use template sentences'),
    });
  });

  it.each([
    {
      name: 'a call without a model effort',
      mutate: (call: Record<string, unknown>) => {
        asRecord(call['model'])['effort'] = '';
      },
    },
    {
      name: 'a call outcome of an unknown status',
      mutate: (call: Record<string, unknown>) => {
        call['outcome'] = { status: 'maybe' };
      },
    },
    {
      name: 'a call without metrics',
      mutate: (call: Record<string, unknown>) => {
        delete call['metrics'];
      },
    },
  ])('refuses $name when it reads conclusions.json', async ({ mutate }) => {
    const { store, directory, runId } = await copyOf(mainRun);
    const executable = await writeFakeOpenCode({ run: 'ok' });
    unwrapOk(
      await rebuildReport(
        runId,
        store,
        RUN_AGENTS,
        buildWriter({ config: mainRun.config, executable }),
      ),
    );
    const path = join(directory, runId, 'conclusions.json');
    const saved = asRecord(JSON.parse(await readFile(path, 'utf8')));
    const [first] = saved['tasks'] as unknown[];
    mutate(asRecord(asRecord(first)['call']));
    await writeFile(path, JSON.stringify(saved));

    const result = await store.readConclusions(runId);

    expect(unwrapFailure(result)).toMatchObject({
      kind: 'ArtifactError',
      operation: 'read-conclusions',
    });
  });

  it('refuses a conclusions.json written for another run', async () => {
    const { store, directory, runId } = await copyOf(mainRun);
    const other: ConclusionsArtifact = { schemaVersion: 1, runId: 'another-run', tasks: [] };
    await writeFile(join(directory, runId, 'conclusions.json'), JSON.stringify(other));

    const result = await store.readConclusions(runId);

    expect(unwrapFailure(result)).toMatchObject({
      kind: 'ArtifactError',
      operation: 'read-conclusions',
    });
  });
});

describe('tevu assess after the run', () => {
  it('commits the verdict into report.md and leaves conclusions.json and summary.md byte-identical with no call', async () => {
    const { store, directory, runId } = await copyOf(manualRun);
    const executable = await writeFakeOpenCode({ run: 'ok' });
    unwrapOk(
      await rebuildReport(
        runId,
        store,
        RUN_AGENTS,
        buildWriter({ config: manualRun.config, executable }),
      ),
    );
    const summaryPath = join(directory, runId, 'summary.md');
    const conclusionsPath = join(directory, runId, 'conclusions.json');
    await writeFile(summaryPath, 'as tevu run wrote it\n');
    const compact = JSON.stringify(JSON.parse(await readFile(conclusionsPath, 'utf8')));
    await writeFile(conclusionsPath, compact);
    const before = await readFiles(directory, runId);
    expect(executable.calls()).toBe(1);

    const assessed = await assessCase(
      {
        runId,
        caseId: 'manual-task--m1--1',
        decisions: [
          {
            checkId: 'acc-manual',
            verdict: 'passed',
            assessor: 'curator',
            note: 'the redirect works',
            replaceExisting: false,
          },
        ],
        assessedAt: '2026-01-02T00:00:00.000Z',
      },
      store,
      RUN_AGENTS,
    );

    unwrapOk(assessed);
    const after = await readFiles(directory, runId);
    expect(after.conclusions).toBe(before.conclusions);
    expect(after.summary).toBe(before.summary);
    expect(after.report).not.toBe(before.report);
    expect(after.report).toContain('Summary model for this task, not added to any row: ');
    expect(executable.calls()).toBe(1);
  });
});

describe('the redacting sinks of the store', () => {
  it('replaces a secret in summary.md and in conclusions.json', async () => {
    const secret = 'sk-live-summary-secret-4711';
    const { store, directory, runId } = await copyOf(mainRun, (text) =>
      text.replaceAll(secret, '[redacted]'),
    );
    const entry: ConclusionsArtifact['tasks'][number] = {
      taskId: 'alpha-task',
      facts: buildSummaryFacts({ task: `leaks ${secret}` }),
      conclusions: { correctness: `uses ${secret}`, cost: 'c.', speed: 's.' },
      call: null,
    };

    unwrapOk(await store.writeSummary(runId, `# Model comparison summary\n\n${secret}\n`));
    unwrapOk(await store.writeConclusions({ schemaVersion: 1, runId, tasks: [entry] }));

    const summary = await readFile(join(directory, runId, 'summary.md'), 'utf8');
    const conclusions = await readFile(join(directory, runId, 'conclusions.json'), 'utf8');
    expect(summary).not.toContain(secret);
    expect(summary).toContain('[redacted]');
    expect(conclusions).not.toContain(secret);
    expect(conclusions).toContain('[redacted]');
  });

  it('aborts both writes with an ArtifactError and leaves the previous file when redaction fails', async () => {
    const written = await copyOf(mainRun);
    unwrapOk(await written.store.writeSummary(written.runId, 'previous summary\n'));
    const failing = createArtifactStore({
      artifactsDirectory: written.directory,
      redact: () => {
        throw new Error('redactor failure');
      },
    });

    const summary = await failing.writeSummary(written.runId, 'new summary\n');
    const conclusions = await failing.writeConclusions({
      schemaVersion: 1,
      runId: written.runId,
      tasks: [],
    });

    expect(unwrapFailure(summary)).toMatchObject({
      kind: 'ArtifactError',
      operation: 'write-summary',
    });
    expect(unwrapFailure(conclusions)).toMatchObject({ kind: 'ArtifactError' });
    expect(await readFile(join(written.directory, written.runId, 'summary.md'), 'utf8')).toBe(
      'previous summary\n',
    );
    expect(existsSync(join(written.directory, written.runId, 'conclusions.json'))).toBe(false);
  });

  it('refuses to write summary.md for a run that does not exist', async () => {
    const { store } = await copyOf(mainRun);

    const result = await store.writeSummary('no-such-run', 'text\n');

    expect(unwrapFailure(result)).toMatchObject({ kind: 'ArtifactError' });
  });
});
