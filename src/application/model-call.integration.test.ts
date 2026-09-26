// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

import { callModelRole } from './model-call';

import type { OpenCodeAdapterDependencies } from '@/adapters/agents/opencode/opencode';
import type {
  AgentAdapter,
  EnvironmentAdapter,
  GitWorkspaceAdapter,
  ManagedProcessRequest,
  ManagedProcessRunner,
  ModelCallDependencies,
  ModelRoleCallRequest,
  ModelRoleName,
  SecretRedactor,
  TevuConfig,
  TevuError,
} from '@/domain/types';

const SECRET_VARIABLE_NAME = 'TEVU_MODEL_CALL_SECRET';
const SECRET_VALUE = 'sk-live-modelcall-secret-000111';
const SESSION_ID = 'ses-mc-1';
const PROMPT = 'Draft acceptance criteria for the CSV export button.';

function expectOk<T>(outcome: { ok: true; value: T } | { ok: false; error: TevuError }): T {
  if (outcome.ok) {
    return outcome.value;
  }
  throw new Error(`expected success, got ${JSON.stringify(outcome.error)}`);
}

function expectFailure<K extends TevuError['kind']>(
  outcome: { ok: true; value: unknown } | { ok: false; error: TevuError },
  kind: K,
): Extract<TevuError, { kind: K }> {
  if (outcome.ok) {
    throw new Error(`expected a ${kind} failure, got success`);
  }
  if (outcome.error.kind !== kind) {
    throw new Error(`expected error kind ${kind}, got ${JSON.stringify(outcome.error)}`);
  }
  return outcome.error as Extract<TevuError, { kind: K }>;
}

function buildSecretRedactor(secretValues: readonly string[]): SecretRedactor {
  return createSecretRedactor(() => secretValues, createRedactor(secretValues));
}

/** A redactor whose `redactValue` always fails, exercising a record-redaction failure mid-run. */
function buildRecordRedactionFailingSecretRedactor(): SecretRedactor {
  return {
    secretValues: () => [],
    redactText: (text) => text,
    redactValue: () => ({
      ok: false,
      error: {
        kind: 'ArtifactError' as const,
        operation: 'redact-record',
        reason: 'record redaction failed',
      },
    }),
  };
}

/** A redactor whose `redactText` throws, exercising a reply-redaction failure after a clean export. */
function buildReplyRedactionThrowingSecretRedactor(
  secretValues: readonly string[],
): SecretRedactor {
  return {
    ...buildSecretRedactor(secretValues),
    redactText: () => {
      throw new Error('redactText failure');
    },
  };
}

type RunBehavior = 'ok' | 'error-exit-1' | 'error-exit-0' | 'sleep';
type ExportBehavior =
  'reply-with-secret' | 'no-cost' | 'secret-split' | 'assistant-error' | 'finish-length' | 'none';

/** Handlers answering `--help`, `--version`, `run --help`, and `export --help`, common to every scenario. */
const PROBE_PREAMBLE = `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0-model-call-fake"); process.exit(0); }
if (args[0] === "--help") { console.log("usage: fake-opencode <command> [options]"); process.exit(0); }
if (args[0] === "run" && args[1] === "--help") {
  console.log("usage: opencode run --format json --model <model> --variant <variant>");
  process.exit(0);
}
if (args[0] === "export" && args[1] === "--help") {
  console.log("usage: opencode export <session-id>");
  process.exit(0);
}
`;

function renderRunSection(behavior: RunBehavior, recordPath: string | undefined): string {
  const recordSnippet =
    recordPath === undefined
      ? ''
      : `
  var stdin = readFileSync(0, "utf8");
  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ argv: args, cwd: process.cwd(), dirEntries: readdirSync(process.cwd()), env: process.env, stdin: stdin }));`;

  if (behavior === 'sleep') {
    return `
if (args[0] === "run") {
  setInterval(function () {}, 1000);
}
`;
  }
  if (behavior === 'error-exit-1' || behavior === 'error-exit-0') {
    const exitCode = behavior === 'error-exit-1' ? 1 : 0;
    return `
if (args[0] === "run") {${recordSnippet}
  console.log(JSON.stringify({ type: "error", timestamp: 1, sessionID: "${SESSION_ID}", error: { data: { message: "Synthetic failure" } } }));
  process.exit(${exitCode});
}
`;
  }
  return `
if (args[0] === "run") {${recordSnippet}
  console.log(JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "${SESSION_ID}", part: { id: "prt-mc-0", sessionID: "${SESSION_ID}", messageID: "msg-mc-0", type: "step-start" } }));
  process.exit(0);
}
`;
}

function renderExportSection(behavior: ExportBehavior): string {
  if (behavior === 'none') {
    return '';
  }
  if (behavior === 'assistant-error') {
    return `
if (args[0] === "export") {
  var requested = args[1] || "";
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-mc-1", sessionID: requested, role: "assistant", parentID: "msg-mc-0", error: { data: { message: "Synthetic failure" } } }, parts: [] }] }));
  process.exit(0);
}
`;
  }
  if (behavior === 'finish-length') {
    return `
if (args[0] === "export") {
  var requested = args[1] || "";
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-mc-1", sessionID: requested, role: "assistant", parentID: "msg-mc-0", finish: "length" }, parts: [] }] }));
  process.exit(0);
}
`;
  }
  if (behavior === 'no-cost') {
    return `
if (args[0] === "export") {
  var requested = args[1] || "";
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-mc-1", sessionID: requested, role: "assistant", parentID: "msg-mc-0", finish: "stop", tokens: { input: 5, output: 6, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ id: "prt-mc-1", sessionID: requested, messageID: "msg-mc-1", type: "text", text: "no cost reply" }] }] }));
  process.exit(0);
}
`;
  }
  if (behavior === 'secret-split') {
    return `
if (args[0] === "export") {
  var requested = args[1] || "";
  var secret = process.env["${SECRET_VARIABLE_NAME}"] || "";
  var half = Math.ceil(secret.length / 2);
  var first = secret.slice(0, half);
  var second = secret.slice(half);
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-mc-1", sessionID: requested, role: "assistant", parentID: "msg-mc-0", finish: "stop", cost: 0.2, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ id: "prt-mc-1", sessionID: requested, messageID: "msg-mc-1", type: "text", text: first }, { id: "prt-mc-2", sessionID: requested, messageID: "msg-mc-1", type: "text", text: second }] }] }));
  process.exit(0);
}
`;
  }
  return `
if (args[0] === "export") {
  var requested = args[1] || "";
  var secret = process.env["${SECRET_VARIABLE_NAME}"] || "";
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-mc-1", sessionID: requested, role: "assistant", parentID: "msg-mc-0", finish: "stop", cost: 0.75, tokens: { input: 10, output: 20, reasoning: 1, cache: { read: 2, write: 3 } } }, parts: [{ id: "prt-mc-1", sessionID: requested, messageID: "msg-mc-1", type: "text", text: "Hello " + secret + " world" }] }] }));
  process.exit(0);
}
`;
}

let tempRoot: string;
let scriptCounterValue = 0;
let recordCounterValue = 0;

function nextScriptName(): string {
  scriptCounterValue += 1;
  return `fake-opencode-${scriptCounterValue}.mjs`;
}

function nextRecordPath(): string {
  recordCounterValue += 1;
  return join(tempRoot, `record-${recordCounterValue}.json`);
}

async function writeFakeExecutable(
  run: RunBehavior,
  exportBehavior: ExportBehavior,
  recordPath?: string,
): Promise<string> {
  const body =
    '#!/usr/bin/env node\n' +
    'import { readFileSync, readdirSync, writeFileSync } from "node:fs";\n' +
    PROBE_PREAMBLE +
    renderRunSection(run, recordPath) +
    renderExportSection(exportBehavior) +
    '\nif (args[0] !== "run" && args[0] !== "export") { process.exit(3); }\n';
  const filePath = join(tempRoot, nextScriptName());
  await writeFile(filePath, body, { mode: 0o755 });
  await chmod(filePath, 0o755);
  return filePath;
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'tevu-model-call-it-'));
  process.env[SECRET_VARIABLE_NAME] = SECRET_VALUE;
});

afterAll(async () => {
  delete process.env[SECRET_VARIABLE_NAME];
  await rm(tempRoot, { recursive: true, force: true });
});

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
      },
    },
    repositories: [],
    models: [],
    roles: { grader: { model: 'openai/grader-model', effort: 'high', agent: 'opencode' } },
    tasks: [],
    ...overrides,
  };
}

/** Wraps a real `EnvironmentAdapter`, recording every call directory it creates. */
function captureModelCallRoots(real: EnvironmentAdapter): {
  environments: EnvironmentAdapter;
  roots: string[];
} {
  const roots: string[] = [];
  const environments: EnvironmentAdapter = {
    ...real,
    async createModelCallEnvironment(snapshot, agentVariables) {
      const result = await real.createModelCallEnvironment(snapshot, agentVariables);
      if (result.ok) {
        roots.push(result.value.rootDirectory);
      }
      return result;
    },
  };
  return { environments, roots };
}

/** Wraps a `ManagedProcessRunner`, recording every request it receives. */
function spyOnRunProcess(): { runProcess: ManagedProcessRunner; calls: ManagedProcessRequest[] } {
  const calls: ManagedProcessRequest[] = [];
  const runProcess: ManagedProcessRunner = async (request) => {
    calls.push(request);
    return runManagedProcess(request);
  };
  return { runProcess, calls };
}

type CallOptions = {
  run: RunBehavior;
  export: ExportBehavior;
  timeoutMs?: number;
  secrets?: SecretRedactor;
  environments?: EnvironmentAdapter;
  git?: Pick<GitWorkspaceAdapter, 'initializeEmptyRepository'>;
  runProcess?: ManagedProcessRunner;
  recordPath?: string;
  cancellation?: AbortSignal;
  role?: ModelRoleName;
  config?: TevuConfig;
};

async function callWithFakeAgent(options: CallOptions) {
  const executable = await writeFakeExecutable(options.run, options.export, options.recordPath);
  const dependencies: OpenCodeAdapterDependencies = {
    runProcess: options.runProcess ?? runManagedProcess,
    secrets: options.secrets ?? buildSecretRedactor([SECRET_VALUE]),
    probeEnvironment: { PATH: process.env['PATH'] ?? '' },
    probeDirectory: process.cwd(),
  };
  const adapter: AgentAdapter = createOpenCodeAdapter(
    { agent: 'opencode', executable },
    dependencies,
  );
  const modelCallDependencies: ModelCallDependencies = {
    agents: new Map([['opencode', adapter]]),
    environments: options.environments ?? createEnvironmentAdapter(),
    git:
      options.git ??
      createGitWorkspaceAdapter({ workspacesDirectory: join(tempRoot, 'workspaces') }),
  };
  const request: ModelRoleCallRequest = {
    config: options.config ?? buildConfig(),
    role: options.role ?? 'grader',
    prompt: PROMPT,
    timeoutMs: options.timeoutMs ?? 10_000,
    cancellation: options.cancellation ?? new AbortController().signal,
  };
  return callModelRole(request, modelCallDependencies);
}

describe('callModelRole against a fake OpenCode executable', () => {
  describe('successful calls', () => {
    it('returns the redacted reply text and the export-reported metrics with a configured secret redacted', async () => {
      const result = await callWithFakeAgent({ run: 'ok', export: 'reply-with-secret' });

      const value = expectOk(result);
      expect(value.text).toBe('Hello [REDACTED] world');
      expect(value.text).not.toContain(SECRET_VALUE);
      expect(value.retainedDirectory).toBeNull();
      expect(value.metrics.inputTokens).toEqual({
        value: 10,
        unit: 'token',
        availability: { status: 'available', source: 'root-session export' },
        scope: 'root-session',
      });
      expect(value.metrics.outputTokens.value).toBe(20);
      expect(value.metrics.reasoningTokens.value).toBe(1);
      expect(value.metrics.cacheReadTokens.value).toBe(2);
      expect(value.metrics.cacheWriteTokens.value).toBe(3);
      expect(value.metrics.cost).toEqual({
        value: 0.75,
        unit: 'USD',
        availability: { status: 'available', source: 'root-session export' },
        scope: 'root-session',
      });
    });

    it('marks cost unavailable with the documented reason when the export message has no cost field', async () => {
      const result = await callWithFakeAgent({ run: 'ok', export: 'no-cost' });

      const value = expectOk(result);
      expect(value.metrics.cost).toEqual({
        value: null,
        unit: 'USD',
        availability: {
          status: 'unavailable',
          reason: 'field "cost" is absent in export message "msg-mc-1"',
        },
        scope: 'root-session',
      });
    });

    it('joins two text parts that split a configured secret with a line feed, leaving both halves and no whole occurrence', async () => {
      const result = await callWithFakeAgent({ run: 'ok', export: 'secret-split' });

      const value = expectOk(result);
      const half = Math.ceil(SECRET_VALUE.length / 2);
      const first = SECRET_VALUE.slice(0, half);
      const second = SECRET_VALUE.slice(half);
      expect(value.text).toBe(`${first}\n${second}`);
      expect(value.text).not.toContain(SECRET_VALUE);
    });

    it('gives the fake agent an empty Git working directory, exactly the documented variable set, and the prompt on stdin', async () => {
      const recordPath = nextRecordPath();

      const result = await callWithFakeAgent({
        run: 'ok',
        export: 'reply-with-secret',
        recordPath,
      });

      expect(result.ok).toBe(true);
      const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
        cwd: string;
        dirEntries: string[];
        env: Record<string, string>;
        stdin: string;
      };
      expect(record.dirEntries).toEqual(['.git']);
      expect(record.stdin).toBe(PROMPT);
      expect(Object.keys(record.env).sort()).toEqual(
        [
          'CI',
          'HOME',
          'LANG',
          'LC_ALL',
          'PATH',
          SECRET_VARIABLE_NAME,
          'TMPDIR',
          'XDG_CACHE_HOME',
          'XDG_CONFIG_HOME',
          'XDG_DATA_HOME',
          'XDG_STATE_HOME',
        ].sort(),
      );
      const callRoot = dirname(record.cwd);
      expect(callRoot.startsWith(join(tmpdir(), 'tevu-call-'))).toBe(true);
      for (const name of [
        'HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
        'TMPDIR',
      ]) {
        expect(record.env[name]?.startsWith(callRoot)).toBe(true);
      }
    });
  });

  describe('call directory lifecycle', () => {
    it('removes the call directory after a successful call', async () => {
      const { environments, roots } = captureModelCallRoots(createEnvironmentAdapter());

      const result = await callWithFakeAgent({
        run: 'ok',
        export: 'reply-with-secret',
        environments,
      });

      expect(result.ok).toBe(true);
      expect(roots).toHaveLength(1);
      expect(existsSync(roots[0]!)).toBe(false);
    });

    it('removes the call directory after a failed call', async () => {
      const { environments, roots } = captureModelCallRoots(createEnvironmentAdapter());

      const result = await callWithFakeAgent({
        run: 'sleep',
        export: 'none',
        timeoutMs: 700,
        environments,
      });

      expect(result.ok).toBe(false);
      expect(roots).toHaveLength(1);
      expect(existsSync(roots[0]!)).toBe(false);
    });

    it('starts no run process, but still removes the call directory, when initializeEmptyRepository fails', async () => {
      const { environments, roots } = captureModelCallRoots(createEnvironmentAdapter());
      const { runProcess, calls } = spyOnRunProcess();
      const failingGit: Pick<GitWorkspaceAdapter, 'initializeEmptyRepository'> = {
        initializeEmptyRepository: async () => ({
          ok: false,
          error: {
            kind: 'ArtifactError',
            operation: 'initialize-repository',
            reason: 'git init exited with code 1',
          },
        }),
      };

      const result = await callWithFakeAgent({
        run: 'ok',
        export: 'none',
        environments,
        git: failingGit,
        runProcess,
      });

      const error = expectFailure(result, 'ArtifactError');
      expect(error.operation).toBe('initialize-repository');
      expect(calls.some((call) => call.argv[1] === 'run' && call.argv[2] === '--format')).toBe(
        false,
      );
      expect(roots).toHaveLength(1);
      expect(existsSync(roots[0]!)).toBe(false);
    });
  });

  describe('redaction failures', () => {
    it('returns AgentProtocolError with no reply text when record redaction fails mid-run', async () => {
      const result = await callWithFakeAgent({
        run: 'ok',
        export: 'none',
        secrets: buildRecordRedactionFailingSecretRedactor(),
      });

      const error = expectFailure(result, 'AgentProtocolError');
      expect(error.context).toEqual({ phase: 'call', role: 'grader' });
      expect(error.reason).toBe('record redaction failed; record withheld');
    });

    it('returns AgentProtocolError with no reply text when reply redaction throws', async () => {
      const result = await callWithFakeAgent({
        run: 'ok',
        export: 'reply-with-secret',
        secrets: buildReplyRedactionThrowingSecretRedactor([SECRET_VALUE]),
      });

      const error = expectFailure(result, 'AgentProtocolError');
      expect(error.context).toEqual({ phase: 'call', role: 'grader' });
      expect(error.reason).toBe('reply redaction failed; reply withheld');
    });
  });

  describe('rejected before any process starts', () => {
    it('returns ConfigValidationError for an undeclared model role, starting no process and creating no call directory', async () => {
      const { environments, roots } = captureModelCallRoots(createEnvironmentAdapter());
      const { runProcess, calls } = spyOnRunProcess();

      const result = await callWithFakeAgent({
        run: 'ok',
        export: 'none',
        environments,
        runProcess,
        config: buildConfig({ roles: {} }),
      });

      const error = expectFailure(result, 'ConfigValidationError');
      expect(error.findings).toEqual([
        { severity: 'error', identifier: 'roles.grader', message: 'model role is not configured' },
      ]);
      expect(calls).toHaveLength(0);
      expect(roots).toHaveLength(0);
    });

    it('returns CancellationError for an already-aborted cancellation, starting no process and creating no call directory', async () => {
      const { environments, roots } = captureModelCallRoots(createEnvironmentAdapter());
      const { runProcess, calls } = spyOnRunProcess();
      const controller = new AbortController();
      controller.abort();

      const result = await callWithFakeAgent({
        run: 'ok',
        export: 'none',
        environments,
        runProcess,
        cancellation: controller.signal,
      });

      const error = expectFailure(result, 'CancellationError');
      expect(error.activeCaseIds).toEqual([]);
      expect(calls).toHaveLength(0);
      expect(roots).toHaveLength(0);
    });
  });

  describe('run and export failures', () => {
    it('fails with the exit code and error summary when run exits nonzero after reporting an error', async () => {
      const result = await callWithFakeAgent({ run: 'error-exit-1', export: 'none' });

      const error = expectFailure(result, 'ModelCallError');
      expect(error.cause).toBe('failed');
      expect(error.reason).toBe('run process exited with code 1: Synthetic failure');
    });

    it('times out when run outlives timeoutMs', async () => {
      const result = await callWithFakeAgent({ run: 'sleep', export: 'none', timeoutMs: 700 });

      const error = expectFailure(result, 'ModelCallError');
      expect(error.cause).toBe('timed-out');
      expect(error.reason).toBe('run process did not finish within 700ms');
    });

    it.each([
      {
        name: 'a zero-exit run that still reported an error event',
        run: 'error-exit-0' as const,
        exportBehavior: 'none' as const,
        reason: 'run reported an error: Synthetic failure',
      },
      {
        name: "the final assistant message's own error",
        run: 'ok' as const,
        exportBehavior: 'assistant-error' as const,
        reason: 'final assistant message carries an error: Synthetic failure',
      },
      {
        name: 'a final assistant message with a non-stop finish reason',
        run: 'ok' as const,
        exportBehavior: 'finish-length' as const,
        reason: 'final assistant message finished with "length"',
      },
    ])('fails the call with cause failed for $name', async ({ run, exportBehavior, reason }) => {
      const result = await callWithFakeAgent({ run, export: exportBehavior });

      const error = expectFailure(result, 'ModelCallError');
      expect(error.cause).toBe('failed');
      expect(error.reason).toBe(reason);
    });
  });
});
