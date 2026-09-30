// @vitest-environment node
import { readFileSync } from 'node:fs';
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
  console.log("usage: opencode models");
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
  const executable = await writeFakeGraderExecutable({
    run: options.run,
    replyText: options.replyText,
    withCost: options.withCost,
    recordPath: options.recordPath,
  });
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
      expect(outcome.grading.call.status).toBe('no-reply');
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
    expect(outcome.grading.call).toEqual({
      status: 'no-reply',
      reason: 'the grader prompt could not be redacted; the grader was not called',
    });
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
