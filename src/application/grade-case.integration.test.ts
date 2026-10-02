// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOpenCodeAdapter } from '@/adapters/agents/opencode/opencode';
import { createGitWorkspaceAdapter } from '@/adapters/git';
import {
  createEnvironmentAdapter,
  createRedactor,
  createSecretRedactor,
  runManagedProcess,
} from '@/adapters/process';
import { describeModelCallFailure } from '@/application/model-call';
import { gradeLines } from '@/evaluation/wording';

import { gradeCase } from './grade-case';

import type {
  AgentAdapter,
  EnvironmentAdapter,
  ModelCallDependencies,
  Redactor,
  TaskDefinition,
  TevuConfig,
  TevuError,
} from '@/domain/types';

const SECRET_VARIABLE_NAME = 'TEVU_GRADE_CASE_SECRET';
const SECRET_VALUE = 'sk-live-grade-case-secret-778899';
const SESSION_ID = 'ses-grade-1';

const TASK_ID_MARKER = 'csv-export-task-id-marker';
const TASK_TITLE_MARKER = 'TASK-TITLE-MARKER for export CSV';
const REFERENCE_IDENTIFIER_MARKER = 'REFERENCE-IDENTIFIER-MARKER';
const REFERENCE_COMMIT = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
const TASK_PROMPT_MARKER = 'TASK-PROMPT-MARKER: add a CSV export button.';
const TASK_DESCRIPTION_MARKER = 'TASK-DESCRIPTION-MARKER: users need a CSV download.';
const CHECK_DESCRIPTION_MARKER = 'CHECK-DESCRIPTION-MARKER: escapes every value correctly';
const PATCH_MARKER = 'PATCH-MARKER-LINE add export button';

let tempRoot: string;
let scriptCounter = 0;
let recordCounter = 0;

function nextScriptPath(): string {
  scriptCounter += 1;
  return join(tempRoot, `fake-grader-${scriptCounter}.mjs`);
}

function nextRecordPath(): string {
  recordCounter += 1;
  return join(tempRoot, `grade-record-${recordCounter}.json`);
}

const PROBE_PREAMBLE = `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0-grade-case-fake"); process.exit(0); }
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

type RunBehavior = 'ok' | 'error-exit-1' | 'sleep';

function renderRunSection(behavior: RunBehavior, recordPath: string): string {
  const recordSnippet = `
  var stdin = readFileSync(0, "utf8");
  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ stdin: stdin }));`;
  if (behavior === 'sleep') {
    return `
if (args[0] === "run") {${recordSnippet}
  setInterval(function () {}, 1000);
}
`;
  }
  if (behavior === 'error-exit-1') {
    return `
if (args[0] === "run") {${recordSnippet}
  console.log(JSON.stringify({ type: "error", timestamp: 1, sessionID: "${SESSION_ID}", error: { data: { message: "Synthetic grader failure" } } }));
  process.exit(1);
}
`;
  }
  return `
if (args[0] === "run") {${recordSnippet}
  console.log(JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "${SESSION_ID}", part: { id: "prt-grade-0", sessionID: "${SESSION_ID}", messageID: "msg-grade-0", type: "step-start" } }));
  process.exit(0);
}
`;
}

function renderExportSection(replyText: string, withCost: boolean): string {
  const costField = withCost ? 'cost: 0.42,' : '';
  return `
if (args[0] === "export") {
  var requested = args[1] || "";
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-grade-1", sessionID: requested, role: "assistant", parentID: "msg-grade-0", finish: "stop", ${costField} tokens: { input: 11, output: 22, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ id: "prt-grade-1", sessionID: requested, messageID: "msg-grade-1", type: "text", text: ${JSON.stringify(replyText)} }] }] }));
  process.exit(0);
}
`;
}

type ExportScript =
  | { kind: 'reply'; text: string; cost?: number; tokens?: ScriptTokens }
  | { kind: 'unfinished'; cost?: number; tokens?: ScriptTokens }
  | { kind: 'tool-call'; cost?: number; tokens?: ScriptTokens }
  | { kind: 'assistant-error'; cost?: number; tokens?: ScriptTokens };

type ScriptTokens = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

/** What the scripted fake does on its n-th `run` start; the last script repeats for every later start. */
type CallScript = { run: 'ok'; export: ExportScript } | { run: 'error-exit-1' } | { run: 'sleep' };

/** Placeholder the scripted fake replaces with the configured secret value wherever it writes text. */
const SECRET_PLACEHOLDER = '{{SECRET}}';

function renderScriptedBody(scripts: readonly CallScript[], logPath: string): string {
  return (
    '#!/usr/bin/env node\n' +
    'import { appendFileSync, existsSync, readFileSync } from "node:fs";\n' +
    PROBE_PREAMBLE +
    `
const scripts = ${JSON.stringify(scripts)};
const LOG = ${JSON.stringify(logPath)};
const SECRET = process.env[${JSON.stringify(SECRET_VARIABLE_NAME)}] || "";
const PLACEHOLDER = ${JSON.stringify(SECRET_PLACEHOLDER)};
function withSecret(text) { return text.split(PLACEHOLDER).join(SECRET); }
function scriptFor(index) { return scripts[Math.min(index, scripts.length - 1)]; }
if (args[0] === "run") {
  readFileSync(0, "utf8");
  var index = existsSync(LOG) ? readFileSync(LOG, "utf8").split("\\n").filter(Boolean).length : 0;
  appendFileSync(LOG, "run\\n");
  var script = scriptFor(index);
  var sessionId = "ses-seq-" + index;
  console.error("grader stderr " + SECRET);
  if (script.run === "sleep") {
    setInterval(function () {}, 1000);
  } else {
    console.log(JSON.stringify({ type: "step_start", timestamp: 1, sessionID: sessionId, part: { id: "prt-seq-0", sessionID: sessionId, messageID: "msg-seq-0", type: "step-start", note: "event " + SECRET } }));
    if (script.run === "error-exit-1") {
      console.log(JSON.stringify({ type: "error", timestamp: 2, sessionID: sessionId, error: { data: { message: "Synthetic grader failure" } } }));
      process.exit(1);
    }
    process.exit(0);
  }
}
if (args[0] === "export") {
  var requested = args[1] || "";
  var exported = scriptFor(Number(requested.slice("ses-seq-".length))).export;
  var info = { id: "msg-seq-1", sessionID: requested, role: "assistant", parentID: "msg-seq-0", cost: exported.cost === undefined ? 0.42 : exported.cost, tokens: exported.tokens || { input: 11, output: 22, reasoning: 0, cache: { read: 0, write: 0 } } };
  var parts = [];
  function textPart(text) { return { id: "prt-seq-1", sessionID: requested, messageID: "msg-seq-1", type: "text", text: withSecret(text) }; }
  if (exported.kind === "reply") { info.finish = "stop"; parts.push(textPart(exported.text)); }
  if (exported.kind === "unfinished") { info.finish = "length"; parts.push(textPart("partial " + PLACEHOLDER)); }
  if (exported.kind === "assistant-error") { info.finish = "stop"; info.error = { data: { message: "Synthetic grader failure" } }; }
  if (exported.kind === "tool-call") { info.finish = "tool-calls"; parts.push({ id: "prt-seq-2", sessionID: requested, messageID: "msg-seq-1", type: "tool", callID: "call-1", tool: "read", state: { status: "error" } }); }
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: info, parts: parts }] }));
  process.exit(0);
}
` +
    '\nif (args[0] !== "run" && args[0] !== "export") { process.exit(3); }\n'
  );
}

async function writeScriptedGraderExecutable(
  scripts: readonly CallScript[],
  logPath: string,
): Promise<string> {
  const filePath = nextScriptPath();
  await writeFile(filePath, renderScriptedBody(scripts, logPath), { mode: 0o755 });
  await chmod(filePath, 0o755);
  return filePath;
}

function countRunStarts(logPath: string): number {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length : 0;
}

async function writeFakeGraderExecutable(options: {
  run: RunBehavior;
  replyText?: string;
  withCost?: boolean;
  recordPath?: string;
}): Promise<string> {
  const recordPath = options.recordPath ?? nextRecordPath();
  const body =
    '#!/usr/bin/env node\n' +
    'import { readFileSync, writeFileSync } from "node:fs";\n' +
    PROBE_PREAMBLE +
    renderRunSection(options.run, recordPath) +
    renderExportSection(options.replyText ?? '{"grades":[]}', options.withCost ?? true) +
    '\nif (args[0] !== "run" && args[0] !== "export") { process.exit(3); }\n';
  const filePath = nextScriptPath();
  await writeFile(filePath, body, { mode: 0o755 });
  await chmod(filePath, 0o755);
  return filePath;
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'tevu-grade-case-it-'));
  process.env[SECRET_VARIABLE_NAME] = SECRET_VALUE;
});

afterAll(async () => {
  delete process.env[SECRET_VARIABLE_NAME];
  await rm(tempRoot, { recursive: true, force: true });
});

function buildTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: TASK_ID_MARKER,
    title: TASK_TITLE_MARKER,
    repo: 'app',
    base_commit: '0'.repeat(40),
    prompt: TASK_PROMPT_MARKER,
    description: TASK_DESCRIPTION_MARKER,
    reference: {
      kind: 'commit',
      identifier: REFERENCE_IDENTIFIER_MARKER,
      commits: [REFERENCE_COMMIT],
    },
    readiness: [],
    checks: {
      acceptance: [{ id: 'csv-content', description: CHECK_DESCRIPTION_MARKER, required: true }],
      done: [],
    },
    ...overrides,
  };
}

function buildConfig(overrides: Partial<TevuConfig> = {}): TevuConfig {
  return {
    version: 1,
    run: {
      output_dir: join(tempRoot, 'runs'),
      concurrency: 1,
      repeat: 1,
      timeout: '30s',
      stop_grace: '200ms',
    },
    agents: {
      opencode: {
        command: 'unused-fake-opencode-command',
        secrets: [SECRET_VARIABLE_NAME],
        env: [],
        providers: [],
      },
    },
    repositories: [],
    models: [],
    roles: { grader: { model: 'openai/grader-model', effort: 'high', agent: 'opencode' } },
    tasks: [],
    ...overrides,
  };
}

type CallOptions = {
  run: RunBehavior;
  executable?: string;
  replyText?: string;
  withCost?: boolean;
  timeoutMs?: number;
  redact?: Redactor;
  task?: TaskDefinition;
  patch?: string;
  config?: TevuConfig;
  agents?: ModelCallDependencies['agents'];
  cancellation?: AbortSignal;
  recordPath?: string;
};

async function gradeWithFakeExecutable(options: CallOptions) {
  const executable =
    options.executable ??
    (await writeFakeGraderExecutable({
      run: options.run,
      replyText: options.replyText,
      withCost: options.withCost,
      recordPath: options.recordPath,
    }));
  const secrets = createSecretRedactor(() => [SECRET_VALUE], createRedactor([SECRET_VALUE]));
  const adapter: AgentAdapter = createOpenCodeAdapter(
    { agent: 'opencode', executable, providers: [], declaredVariables: { secrets: [], env: [] } },
    {
      runProcess: runManagedProcess,
      secrets,
      probeEnvironment: { PATH: process.env['PATH'] ?? '' },
      probeDirectory: process.cwd(),
      operatorDirectories: { home: undefined, xdgConfigHome: undefined },
    },
  );
  const dependencies: ModelCallDependencies = {
    agents: options.agents ?? new Map([['opencode', adapter]]),
    environments: createEnvironmentAdapter(),
    git: createGitWorkspaceAdapter({ workspacesDirectory: join(tempRoot, 'workspaces') }),
  };
  const outcome = await gradeCase(
    {
      config: options.config ?? buildConfig(),
      task: options.task ?? buildTask(),
      patch: options.patch ?? `diff --git a/x b/x\n+${PATCH_MARKER}\n`,
      timeoutMs: options.timeoutMs ?? 10_000,
      redact: options.redact ?? ((text: string) => text),
      cancellation: options.cancellation ?? new AbortController().signal,
      providers: { agent: 'opencode', configurationFiles: [], findings: [], copiedProviders: [] },
    },
    dependencies,
  );
  return outcome;
}

describe('gradeCase against a fake OpenCode executable', () => {
  it('sends the grader only the task instructions, description, check list, and patch, excluding the case identity, reference, and commit hashes', async () => {
    const recordPath = nextRecordPath();

    const outcome = await gradeWithFakeExecutable({
      run: 'ok',
      replyText:
        '{"grades":[{"check":"csv-content","verdict":"passed","rationale":"lines added"}]}',
      recordPath,
    });

    expect(outcome.status).toBe('graded');
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as { stdin: string };
    expect(record.stdin).toContain(TASK_PROMPT_MARKER);
    expect(record.stdin).toContain(TASK_DESCRIPTION_MARKER);
    expect(record.stdin).toContain(`csv-content: ${CHECK_DESCRIPTION_MARKER}`);
    expect(record.stdin).toContain(PATCH_MARKER);
    expect(record.stdin).not.toContain(TASK_ID_MARKER);
    expect(record.stdin).not.toContain(TASK_TITLE_MARKER);
    expect(record.stdin).not.toContain(REFERENCE_IDENTIFIER_MARKER);
    expect(record.stdin).not.toContain(REFERENCE_COMMIT);
    expect(record.stdin).not.toContain(REFERENCE_COMMIT.slice(0, 7));
  });

  it.each<{ verdict: 'passed' | 'failed' | 'undetermined' }>([
    { verdict: 'passed' },
    { verdict: 'failed' },
    { verdict: 'undetermined' },
  ])('records a canned $verdict grade unchanged in the grading outcome', async ({ verdict }) => {
    const outcome = await gradeWithFakeExecutable({
      run: 'ok',
      replyText: `{"grades":[{"check":"csv-content","verdict":"${verdict}","rationale":"rationale for ${verdict}"}]}`,
    });

    if (outcome.status !== 'graded') {
      throw new Error(`expected a graded outcome, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.grading.call).toEqual({
      status: 'replied',
      reply: `{"grades":[{"check":"csv-content","verdict":"${verdict}","rationale":"rationale for ${verdict}"}]}`,
    });
    expect(outcome.grading.grades).toEqual([
      {
        checkId: 'csv-content',
        category: 'acceptance',
        status: 'graded',
        verdict,
        rationale: `rationale for ${verdict}`,
      },
    ]);
    expect(outcome.grading.grader).toEqual({
      model: 'openai/grader-model',
      effort: 'high',
      agent: 'opencode',
    });
  });

  it('reports the grader cost independently, unavailable with a reason when the export carries none', async () => {
    const withCost = await gradeWithFakeExecutable({ run: 'ok', withCost: true });
    const withoutCost = await gradeWithFakeExecutable({ run: 'ok', withCost: false });

    if (withCost.status !== 'graded' || withoutCost.status !== 'graded') {
      throw new Error('expected both calls to grade');
    }
    expect(withCost.grading.metrics.cost.value).toBe(0.42);
    expect(withCost.grading.metrics.cost.availability.status).toBe('available');
    expect(withoutCost.grading.metrics.cost).toEqual({
      value: null,
      unit: 'USD',
      availability: {
        status: 'unavailable',
        reason: 'field "cost" is absent in export message "msg-grade-1"',
      },
      scope: 'root-session',
    });
  });

  it('leaves the graded check pending, with a replied call, when the reply is not valid JSON', async () => {
    const outcome = await gradeWithFakeExecutable({ run: 'ok', replyText: 'not json at all' });

    if (outcome.status !== 'graded') {
      throw new Error(`expected a graded (pending) outcome, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.grading.call).toEqual({ status: 'replied', reply: 'not json at all' });
    expect(outcome.grading.grades).toEqual([
      {
        checkId: 'csv-content',
        category: 'acceptance',
        status: 'pending',
        reason: 'the grader reply is not valid: the reply is not valid JSON',
      },
    ]);
  });

  it.each<{ scenario: string; run: RunBehavior; timeoutMs?: number }>([
    { scenario: 'the run process exits nonzero', run: 'error-exit-1' },
    { scenario: 'the run process times out', run: 'sleep', timeoutMs: 700 },
  ])(
    'leaves every graded check pending with a no-reply call and unavailable, never-zero metrics when $scenario',
    async ({ run, timeoutMs }) => {
      const outcome = await gradeWithFakeExecutable({ run, timeoutMs });

      if (outcome.status !== 'graded') {
        throw new Error(`expected a graded (pending) outcome, got ${JSON.stringify(outcome)}`);
      }
      expect(outcome.grading.call).toMatchObject({ status: 'no-reply', cause: 'other' });
      expect(outcome.grading.grades).toHaveLength(1);
      expect(outcome.grading.grades[0]).toMatchObject({
        checkId: 'csv-content',
        status: 'pending',
      });
      for (const metric of Object.values(outcome.grading.metrics)) {
        expect(metric.availability.status).toBe('unavailable');
        expect(metric.value).toBeNull();
        expect(metric.value).not.toBe(0);
      }
    },
  );

  it('short-circuits to no-reply without starting a process when prompt redaction throws', async () => {
    const outcome = await gradeWithFakeExecutable({
      run: 'ok',
      redact: () => {
        throw new Error('synthetic redaction failure');
      },
    });

    if (outcome.status !== 'graded') {
      throw new Error(`expected a graded (pending) outcome, got ${JSON.stringify(outcome)}`);
    }
    const reason = 'the grader prompt could not be redacted; the grader was not called';
    expect(outcome.grading.call).toEqual({ status: 'no-reply', cause: 'other', reason });
    expect(outcome.grading.calls).toEqual([]);
    for (const metric of Object.values(outcome.grading.metrics)) {
      expect(metric.availability).toEqual({ status: 'unavailable', reason });
    }
    expect(outcome.grading.grades).toEqual([
      {
        checkId: 'csv-content',
        category: 'acceptance',
        status: 'pending',
        reason: 'the grader prompt could not be redacted; the grader was not called',
      },
    ]);
  });

  it('returns a cancelled outcome with no grading to persist when the cancellation signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await gradeWithFakeExecutable({ run: 'ok', cancellation: controller.signal });

    expect(outcome).toEqual({ status: 'cancelled' });
  });

  it('records a PrerequisiteError call failure as no-reply when the grader agent has no registered adapter', async () => {
    const outcome = await gradeWithFakeExecutable({ run: 'ok', agents: new Map() });

    if (outcome.status !== 'graded') {
      throw new Error(`expected a graded (pending) outcome, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.grading.call.status).toBe('no-reply');
    if (outcome.grading.call.status === 'no-reply') {
      expect(outcome.grading.call.reason).toContain('PrerequisiteError:');
    }
  });
});

describe('gradeCase call loop against a scripted fake OpenCode executable', () => {
  const REPLY_PASSED =
    '{"grades":[{"check":"csv-content","verdict":"passed","rationale":"lines added"}]}';
  const FIRST_TOKENS = { input: 11, output: 22, reasoning: 3, cache: { read: 4, write: 5 } };
  const SECOND_TOKENS = { input: 100, output: 200, reasoning: 30, cache: { read: 40, write: 50 } };

  async function gradeWithScripts(
    scripts: readonly CallScript[],
    options: Partial<CallOptions> = {},
  ) {
    const logPath = nextRecordPath();
    const executable = await writeScriptedGraderExecutable(scripts, logPath);
    const outcome = await gradeWithFakeExecutable({ run: 'ok', ...options, executable });
    if (outcome.status !== 'graded') {
      throw new Error(`expected a graded outcome, got ${JSON.stringify(outcome)}`);
    }
    return { grading: outcome.grading, retainedDirectory: outcome.retainedDirectory, logPath };
  }

  it('starts the run once and leaves every check pending when the session holds a tool call', async () => {
    const { grading, logPath } = await gradeWithScripts([
      { run: 'ok', export: { kind: 'tool-call' } },
    ]);

    expect(countRunStarts(logPath)).toBe(1);
    expect(grading.calls).toHaveLength(1);
    expect(grading.call).toMatchObject({ status: 'no-reply', cause: 'tool-call' });
    expect(grading.calls[0]?.outcome).toEqual(grading.call);
    expect(grading.grades).toEqual([
      expect.objectContaining({ checkId: 'csv-content', status: 'pending' }),
    ]);
    expect(grading.metrics).toEqual(grading.calls[0]?.metrics);
    expect(grading.metrics.inputTokens.value).toBe(11);
    expect(grading.metrics.outputTokens.value).toBe(22);
    expect(grading.metrics.cost.value).toBe(0.42);
  });

  it('calls again after an unfinished call, takes the grades from the reply, and sums both exports', async () => {
    const { grading, logPath, retainedDirectory } = await gradeWithScripts([
      { run: 'ok', export: { kind: 'unfinished', cost: 0.25, tokens: FIRST_TOKENS } },
      {
        run: 'ok',
        export: { kind: 'reply', text: REPLY_PASSED, cost: 0.5, tokens: SECOND_TOKENS },
      },
    ]);

    expect(countRunStarts(logPath)).toBe(2);
    expect(grading.calls.map((call) => call.outcome.status)).toEqual(['no-reply', 'replied']);
    expect(grading.calls[0]?.outcome).toMatchObject({ cause: 'unfinished' });
    expect(grading.call).toEqual({ status: 'replied', reply: REPLY_PASSED });
    expect(grading.grades).toEqual([
      {
        checkId: 'csv-content',
        category: 'acceptance',
        status: 'graded',
        verdict: 'passed',
        rationale: 'lines added',
      },
    ]);
    expect(grading.metrics.inputTokens.value).toBe(111);
    expect(grading.metrics.outputTokens.value).toBe(222);
    expect(grading.metrics.reasoningTokens.value).toBe(33);
    expect(grading.metrics.cacheReadTokens.value).toBe(44);
    expect(grading.metrics.cacheWriteTokens.value).toBe(55);
    expect(grading.metrics.cost.value).toBe(0.75);
    expect(retainedDirectory).toBeNull();
  });

  it('stops after three unfinished calls and opens the pending wording with the call count', async () => {
    const { grading, logPath } = await gradeWithScripts([
      { run: 'ok', export: { kind: 'unfinished' } },
    ]);

    expect(countRunStarts(logPath)).toBe(3);
    expect(grading.calls).toHaveLength(3);
    expect(grading.call).toMatchObject({ status: 'no-reply', cause: 'unfinished' });
    const [grade] = grading.grades;
    expect(grade).toMatchObject({ status: 'pending' });
    const lines = gradeLines(grade ?? null, grading);
    expect(lines[0]).toMatch(
      /^After 3 calls, the grading model stopped before finishing its reply\. /,
    );
    expect(grading.metrics.inputTokens.value).toBe(33);
  });

  it.each([
    { scenario: 'the run process exits nonzero', script: { run: 'error-exit-1' } as const },
    { scenario: 'the run process times out', script: { run: 'sleep' } as const },
    {
      scenario: 'the final assistant message carries an error',
      script: { run: 'ok', export: { kind: 'assistant-error' } } as const,
    },
  ])('starts the run once when $scenario', async ({ script }) => {
    const { grading, logPath } = await gradeWithScripts([script], { timeoutMs: 700 });

    expect(countRunStarts(logPath)).toBe(1);
    expect(grading.calls).toHaveLength(1);
    expect(grading.call).toMatchObject({ status: 'no-reply', cause: 'other' });
  });

  it('keeps the first call cost and makes the grading cost unavailable with the reason of a call that timed out', async () => {
    const { grading, logPath } = await gradeWithScripts(
      [{ run: 'ok', export: { kind: 'unfinished', cost: 0.25 } }, { run: 'sleep' }],
      { timeoutMs: 1_000 },
    );

    expect(countRunStarts(logPath)).toBe(2);
    const [first, second] = grading.calls;
    expect(first?.metrics.cost).toMatchObject({
      value: 0.25,
      availability: { status: 'available' },
    });
    expect(second?.metrics.cost.availability).toMatchObject({ status: 'unavailable' });
    expect(second?.session).toBeNull();
    expect(grading.call).toMatchObject({ status: 'no-reply', cause: 'other' });
    expect(grading.metrics.cost.value).toBeNull();
    expect(grading.metrics.cost.availability).toEqual(second?.metrics.cost.availability);
    expect(grading.metrics.cost.availability).toMatchObject({
      reason: expect.stringContaining('timed-out'),
    });
  });

  it('returns a cancelled outcome and drops the earlier calls when cancellation arrives before a retry', async () => {
    const controller = new AbortController();
    const logPath = nextRecordPath();
    const executable = await writeScriptedGraderExecutable(
      [{ run: 'ok', export: { kind: 'unfinished' } }],
      logPath,
    );
    const realAdapter = createOpenCodeAdapter(
      { agent: 'opencode', executable, providers: [], declaredVariables: { secrets: [], env: [] } },
      {
        runProcess: runManagedProcess,
        secrets: createSecretRedactor(() => [SECRET_VALUE], createRedactor([SECRET_VALUE])),
        probeEnvironment: { PATH: process.env['PATH'] ?? '' },
        probeDirectory: process.cwd(),
        operatorDirectories: { home: undefined, xdgConfigHome: undefined },
      },
    );
    let started = 0;
    const agent: AgentAdapter = {
      ...realAdapter,
      async callModel(input) {
        started += 1;
        if (started === 2) {
          controller.abort();
        }
        return realAdapter.callModel(input);
      },
    };

    const outcome = await gradeWithFakeExecutable({
      run: 'ok',
      executable,
      agents: new Map([['opencode', agent]]),
      cancellation: controller.signal,
    });

    expect(outcome).toEqual({ status: 'cancelled' });
    expect(started).toBe(2);
    expect(countRunStarts(logPath)).toBe(1);
  });

  it('keeps a configured secret out of every field of the grading and records its replacement', async () => {
    const { grading } = await gradeWithScripts([
      { run: 'ok', export: { kind: 'unfinished' } },
      {
        run: 'ok',
        export: {
          kind: 'reply',
          text: `{"grades":[{"check":"csv-content","verdict":"passed","rationale":"saw ${SECRET_PLACEHOLDER}"}]}`,
        },
      },
    ]);

    const serialized = JSON.stringify(grading);
    expect(serialized).not.toContain(SECRET_VALUE);
    expect(serialized).toContain('[REDACTED]');
    for (const call of grading.calls) {
      expect(JSON.stringify(call.events)).toContain('[REDACTED]');
      expect(call.diagnostics).toContain('[REDACTED]');
      expect(call.diagnostics).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(call.session)).toContain('[REDACTED]');
    }
  });
});

describe('gradeCase providers forwarding', () => {
  it('forwards request.providers unchanged into the model call, so its own agent never reads providers', async () => {
    const configurationFiles = [
      { relativePath: 'opencode/opencode.json', text: '{"provider":{"acme":{}}}\n' },
    ];
    const executable = await writeFakeGraderExecutable({ run: 'ok', replyText: '{"grades":[]}' });
    const secrets = createSecretRedactor(() => [SECRET_VALUE], createRedactor([SECRET_VALUE]));
    const realAdapter: AgentAdapter = createOpenCodeAdapter(
      { agent: 'opencode', executable, providers: [], declaredVariables: { secrets: [], env: [] } },
      {
        runProcess: runManagedProcess,
        secrets,
        probeEnvironment: { PATH: process.env['PATH'] ?? '' },
        probeDirectory: process.cwd(),
        operatorDirectories: { home: undefined, xdgConfigHome: undefined },
      },
    );
    let readProvidersCalls = 0;
    const agent: AgentAdapter = {
      ...realAdapter,
      async readProviders() {
        readProvidersCalls += 1;
        return {
          ok: true,
          value: { agent: 'opencode', configurationFiles: [], findings: [], copiedProviders: [] },
        };
      },
    };
    const realEnvironments = createEnvironmentAdapter();
    const receivedFiles: string[][] = [];
    const environments: EnvironmentAdapter = {
      ...realEnvironments,
      async createModelCallEnvironment(snapshot, agentVariables, files) {
        receivedFiles.push(files.map((file) => file.relativePath));
        return realEnvironments.createModelCallEnvironment(snapshot, agentVariables, files);
      },
    };
    const dependencies: ModelCallDependencies = {
      agents: new Map([['opencode', agent]]),
      environments,
      git: createGitWorkspaceAdapter({ workspacesDirectory: join(tempRoot, 'workspaces') }),
    };

    const outcome = await gradeCase(
      {
        config: buildConfig(),
        task: buildTask(),
        patch: `diff --git a/x b/x\n+${PATCH_MARKER}\n`,
        timeoutMs: 10_000,
        redact: (text) => text,
        cancellation: new AbortController().signal,
        providers: { agent: 'opencode', configurationFiles, findings: [], copiedProviders: [] },
      },
      dependencies,
    );

    expect(outcome.status).toBe('graded');
    expect(readProvidersCalls).toBe(0);
    expect(receivedFiles).toEqual([['opencode/opencode.json']]);
  });
});

describe('describeModelCallFailure', () => {
  function expectFailure<K extends TevuError['kind']>(
    error: Extract<TevuError, { kind: K }>,
  ): Extract<TevuError, { kind: K }> {
    return error;
  }

  it('renders a ModelCallError with its cause and reason', () => {
    const error = expectFailure({
      kind: 'ModelCallError',
      role: 'grader',
      agent: 'opencode',
      cause: 'timed-out',
      reason: 'run process did not finish within 700ms',
    });

    expect(describeModelCallFailure(error)).toBe(
      'ModelCallError (timed-out): run process did not finish within 700ms',
    );
  });

  it('renders an AgentProtocolError with its reason', () => {
    const error = expectFailure({
      kind: 'AgentProtocolError',
      agent: 'opencode',
      context: { phase: 'call', role: 'grader' },
      reason: 'reply redaction failed; reply withheld',
    });

    expect(describeModelCallFailure(error)).toBe(
      'AgentProtocolError: reply redaction failed; reply withheld',
    );
  });

  it('renders a PrerequisiteError with expected and, when set, actual', () => {
    const withActual = expectFailure({
      kind: 'PrerequisiteError',
      tool: 'opencode',
      expected: 'a registered agent adapter',
      actual: 'none',
    });
    const withoutActual = expectFailure({
      kind: 'PrerequisiteError',
      tool: 'opencode',
      expected: 'a registered agent adapter',
    });

    expect(describeModelCallFailure(withActual)).toBe(
      'PrerequisiteError: "opencode" expected a registered agent adapter, actual none',
    );
    expect(describeModelCallFailure(withoutActual)).toBe(
      'PrerequisiteError: "opencode" expected a registered agent adapter',
    );
  });

  it('renders an ArtifactError with its operation and reason', () => {
    const error = expectFailure({
      kind: 'ArtifactError',
      operation: 'initialize-repository',
      reason: 'git init exited with code 1',
    });

    expect(describeModelCallFailure(error)).toBe(
      'ArtifactError: initialize-repository: git init exited with code 1',
    );
  });

  it('renders a ConfigValidationError naming the first finding', () => {
    const error = expectFailure({
      kind: 'ConfigValidationError',
      findings: [
        { severity: 'error', identifier: 'roles.grader', message: 'model role is not configured' },
      ],
    });

    expect(describeModelCallFailure(error)).toBe(
      'ConfigValidationError: roles.grader: model role is not configured',
    );
  });
});
