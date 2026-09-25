/**
 * Execa-backed process boundary: managed literal-argv process supervision with
 * detached process groups, streaming credential-secret redaction, bounded
 * output capture, isolated replacement environments, and local prerequisite
 * probes. Every managed subprocess starts without a shell and with an explicit
 * replacement environment; only the read-only local tool-version probes
 * inherit the parent environment so version-manager shims keep working.
 */

import { Buffer } from 'node:buffer';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';

import { evaluatorEnvironmentNames, referencedVariableName } from '@/config/schema';
import { describeCause } from '@/domain/describe-cause';
import { redactDecodedValue } from '@/domain/redaction';

import type { TevuConfig } from '@/config/schema';
import type {
  CaseEnvironments,
  CaseWorkspace,
  EnvironmentAdapter,
  EnvironmentVariableRecord,
  EvaluatorProcessAdapter,
  EvaluatorProcessRequest,
  EvaluatorProcessResult,
  HostProbe,
  IsolatedEnvironment,
  ManagedProcessLaunchFailure,
  ManagedProcessRequest,
  ManagedProcessResult,
  ParentEnvironmentSnapshot,
  PrerequisiteAdapter,
  RedactedCapture,
  Redactor,
  SecretRedactor,
  TerminationStage,
  TevuResult,
} from '@/domain/types';

/** Chunk-safe redactor holding back partial secret prefixes across chunk boundaries. */
export type StreamingRedactor = {
  push(chunk: string): string;
  flush(): string;
};

const REDACTION_MASK = '[REDACTED]';
const DEFAULT_MAX_CAPTURE_BYTES = 64 * 1024;
const FIXED_LOCALE = 'C.UTF-8';
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Creates a whole-text redactor replacing every non-empty secret value with
 * `[REDACTED]`, longest value first so nested secrets cannot survive.
 */
export function createRedactor(secretValues: readonly string[]): Redactor {
  const secrets = normalizeSecrets(secretValues);
  if (secrets.length === 0) {
    return (text) => text;
  }
  return (text) => {
    let redacted = text;
    for (const secret of secrets) {
      redacted = redacted.split(secret).join(REDACTION_MASK);
    }
    return redacted;
  };
}

/**
 * Creates a stateful redactor safe for chunked streams. Each push emits only
 * text that cannot be a prefix of a secret spanning into the next chunk; the
 * held-back tail is bounded by the longest secret. `flush` must be called once
 * after the final chunk.
 */
export function createStreamingRedactor(secretValues: readonly string[]): StreamingRedactor {
  const secrets = normalizeSecrets(secretValues);
  const redact = createRedactor(secrets);
  let carry = '';

  const holdLength = (text: string): number => {
    let hold = 0;
    for (const secret of secrets) {
      const longestProperPrefix = Math.min(secret.length - 1, text.length);
      for (let length = longestProperPrefix; length > hold; length -= 1) {
        if (text.endsWith(secret.slice(0, length))) {
          hold = length;
          break;
        }
      }
    }
    return hold;
  };

  return {
    push(chunk) {
      const combined = redact(carry + chunk);
      const hold = holdLength(combined);
      carry = hold === 0 ? '' : combined.slice(combined.length - hold);
      return combined.slice(0, combined.length - hold);
    },
    flush() {
      const emitted = redact(carry);
      carry = '';
      return emitted;
    },
  };
}

/**
 * Creates a `SecretRedactor` over the live secret-value accessor and text
 * redactor a caller already maintains, so every agent adapter shares one
 * redaction boundary. `redactValue` never throws: it maps a `RedactionError`
 * from `redactDecodedValue` to a fixed `ArtifactError`.
 */
export function createSecretRedactor(
  secretValues: () => readonly string[],
  redact: Redactor,
): SecretRedactor {
  return {
    secretValues,
    redactText: (text) => redact(text),
    redactValue: (value) => {
      const result = redactDecodedValue(redact, value);
      if (result.ok) {
        return { ok: true, value: result.value };
      }
      return {
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'redact-record',
          reason: 'record redaction failed',
        },
      };
    },
  };
}

/**
 * Runs one literal-argv process in its own detached process group with the
 * given replacement environment. Output streams pass through chunk-safe
 * redaction before the optional callbacks and the bounded captures. On timeout
 * or cancellation the whole group receives SIGTERM, then SIGKILL after
 * `terminationGraceMs`; surviving grandchildren are force-terminated after the
 * supervised process settles.
 */
export async function runManagedProcess(
  request: ManagedProcessRequest,
): Promise<ManagedProcessResult> {
  const secretValues = request.secretValues ?? [];
  const redact = createRedactor(secretValues);
  if (request.cancellation?.aborted === true) {
    return { launched: false, reason: 'cancelled before launch' };
  }

  const [file, ...args] = request.argv;
  const startedAt = new Date();
  let subprocess: ReturnType<typeof execa>;
  try {
    subprocess = execa(file, args, {
      cwd: request.cwd,
      env: request.environment,
      extendEnv: false,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      buffer: false,
      reject: false,
      detached: true,
      stripFinalNewline: false,
    });
  } catch (cause) {
    return launchFailure(redact(describeCause(cause)), describeErrorCode(cause));
  }

  const maxCaptureBytes = request.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const stdoutSecretValues = request.stdoutRedaction === 'structured' ? [] : secretValues;
  const stdoutCapture = createStreamCapture(stdoutSecretValues, maxCaptureBytes, request.onStdout);
  const stderrCapture = createStreamCapture(secretValues, maxCaptureBytes, request.onStderr);
  subprocess.stdout?.on('data', stdoutCapture.onData);
  subprocess.stderr?.on('data', stderrCapture.onData);

  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = subprocess.pid;
    if (pid === undefined) {
      return;
    }
    try {
      process.kill(-pid, signal);
    } catch {
      // The process group is already gone.
    }
  };

  let terminationStage: TerminationStage = 'none';
  let timedOut = false;
  let cancelled = false;
  let graceTimer: NodeJS.Timeout | undefined;
  let survivorTimer: NodeJS.Timeout | undefined;

  const beginTermination = (trigger: 'timeout' | 'cancellation'): void => {
    if (timedOut || cancelled) {
      return;
    }
    if (trigger === 'timeout') {
      timedOut = true;
    } else {
      cancelled = true;
    }
    terminationStage = 'graceful';
    signalGroup('SIGTERM');
    graceTimer = setTimeout(() => {
      terminationStage = 'forced';
      signalGroup('SIGKILL');
    }, request.terminationGraceMs);
    graceTimer.unref();
  };

  const timeoutTimer = setTimeout(() => beginTermination('timeout'), request.timeoutMs);
  timeoutTimer.unref();
  const onAbort = (): void => beginTermination('cancellation');
  request.cancellation?.addEventListener('abort', onAbort, { once: true });

  // A grandchild holding the inherited stdio pipes would otherwise keep the
  // await pending forever after the supervised process itself has exited.
  subprocess.nodeChildProcess.once('exit', () => {
    signalGroup('SIGTERM');
    survivorTimer = setTimeout(() => signalGroup('SIGKILL'), request.terminationGraceMs);
    survivorTimer.unref();
  });

  const result = await subprocess;

  clearTimeout(timeoutTimer);
  if (graceTimer !== undefined) {
    clearTimeout(graceTimer);
  }
  if (survivorTimer !== undefined) {
    clearTimeout(survivorTimer);
  }
  request.cancellation?.removeEventListener('abort', onAbort);
  signalGroup('SIGKILL');

  const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
  const signal = typeof result.signal === 'string' ? result.signal : null;
  if (exitCode === null && signal === null) {
    return launchFailure(redact(describeSpawnFailure(result)), result.code);
  }

  const endedAt = new Date();
  return {
    launched: true,
    exitCode,
    signal,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: result.durationMs,
    timedOut,
    cancelled,
    terminationStage,
    stdout: stdoutCapture.finish(),
    stderr: stderrCapture.finish(),
  };
}

/**
 * Creates the benchmark-task acceptance command runner, also used to run
 * repository setup commands. Secret values are read per launch so the
 * adapter can be constructed before the run-level parent environment
 * snapshot exists.
 */
export function createEvaluatorProcessAdapter(
  readSecretValues: () => readonly string[],
): EvaluatorProcessAdapter {
  return {
    async run(request: EvaluatorProcessRequest): Promise<EvaluatorProcessResult> {
      const outcome = await runManagedProcess({
        argv: request.argv,
        cwd: request.cwd,
        environment: request.environment,
        timeoutMs: request.timeoutMs,
        terminationGraceMs: request.terminationGraceMs,
        cancellation: request.cancellation,
        secretValues: readSecretValues(),
      });
      if (!outcome.launched) {
        return outcome;
      }
      return {
        launched: true,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        terminationStage: outcome.terminationStage,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
      };
    },
  };
}

/**
 * Creates the environment boundary: one immutable run-level snapshot of the
 * parent PATH and configured variable values, and per-case agent and
 * evaluator replacement environments with private home, XDG, and temporary
 * directories under the case runtime directory.
 */
export function createEnvironmentAdapter(): EnvironmentAdapter {
  return {
    snapshotParent(config: TevuConfig): TevuResult<ParentEnvironmentSnapshot, 'PrerequisiteError'> {
      return snapshotParentEnvironment(config);
    },
    async createCaseEnvironments(
      workspace: CaseWorkspace,
      snapshot: ParentEnvironmentSnapshot,
      config: TevuConfig,
      agent: string,
    ): Promise<TevuResult<CaseEnvironments, 'IsolationError'>> {
      const agentSettings = config.agents[agent];
      if (agentSettings === undefined) {
        return {
          ok: false,
          error: {
            kind: 'IsolationError',
            caseId: workspace.caseId,
            reason: `no agent block is configured for agent "${agent}"`,
          },
        };
      }
      try {
        const agentValues = snapshot.agentValues;
        const agentEnvironment = await buildIsolatedEnvironment({
          caseId: workspace.caseId,
          recipient: 'agent',
          baseDirectory: join(workspace.runtimeDirectory, 'agent'),
          path: snapshot.path,
          additions: [
            ...agentSettings.secrets.map((name) => ({
              name,
              classification: 'secret' as const,
              value: agentValues[name],
            })),
            ...agentSettings.env.map((name) => ({
              name,
              classification: 'ordinary' as const,
              value: agentValues[name],
            })),
          ],
        });
        const evaluator = await buildIsolatedEnvironment({
          caseId: workspace.caseId,
          recipient: 'evaluator',
          baseDirectory: join(workspace.runtimeDirectory, 'evaluator'),
          path: snapshot.path,
          // Ordinary evaluator values are added per check by the evaluation
          // module from its declared allowlist, so only their names enter the
          // manifest here and no value enters the fixed base.
          additions: evaluatorEnvironmentNames(config).map((name) => ({
            name,
            classification: 'ordinary' as const,
          })),
        });
        return { ok: true, value: { agent: agentEnvironment, evaluator } };
      } catch (cause) {
        return {
          ok: false,
          error: {
            kind: 'IsolationError',
            caseId: workspace.caseId,
            reason: describeCause(cause),
          },
        };
      }
    },
  };
}

/** Creates the host, environment-presence, and artifact-writability probes. */
export function createPrerequisiteAdapter(): PrerequisiteAdapter {
  return {
    async probeHost(): Promise<TevuResult<HostProbe, 'PrerequisiteError'>> {
      const platform = process.platform;
      if (platform !== 'linux' && platform !== 'darwin') {
        return prerequisiteError('platform', 'linux or darwin', platform);
      }
      const bunVersion = await probeToolVersion('bun');
      if (!bunVersion.ok) {
        return bunVersion;
      }
      const gitVersion = await probeToolVersion('git');
      if (!gitVersion.ok) {
        return gitVersion;
      }
      return {
        ok: true,
        value: {
          platform,
          nodeVersion: process.version,
          bunVersion: bunVersion.value,
          gitVersion: gitVersion.value,
        },
      };
    },
    hasEnvironmentVariable(name: string): boolean {
      return process.env[name] !== undefined;
    },
    async probeWritableDirectory(
      directory: string,
    ): Promise<TevuResult<void, 'PrerequisiteError'>> {
      try {
        const anchor = await nearestExistingAncestor(resolve(directory));
        const probeDirectory = await mkdtemp(join(anchor, '.tevu-write-probe-'));
        await rm(probeDirectory, { recursive: true, force: true });
        return { ok: true, value: undefined };
      } catch (cause) {
        return prerequisiteError(
          'artifact-directory',
          `writable directory at ${directory}`,
          describeCause(cause),
        );
      }
    },
  };
}

type StreamCapture = {
  onData: (chunk: Buffer) => void;
  finish: () => RedactedCapture;
};

function createStreamCapture(
  secretValues: readonly string[],
  maxCaptureBytes: number,
  sink: ((text: string) => void) | undefined,
): StreamCapture {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const redactor = createStreamingRedactor(secretValues);
  let text = '';
  let capturedBytes = 0;
  let totalBytes = 0;
  let truncated = false;

  const accept = (emitted: string): void => {
    if (emitted.length === 0) {
      return;
    }
    totalBytes += Buffer.byteLength(emitted, 'utf8');
    if (!truncated) {
      const kept = utf8Prefix(emitted, maxCaptureBytes - capturedBytes);
      text += kept;
      capturedBytes += Buffer.byteLength(kept, 'utf8');
      if (kept.length < emitted.length) {
        truncated = true;
      }
    }
    sink?.(emitted);
  };

  return {
    onData(chunk) {
      accept(redactor.push(decoder.decode(chunk, { stream: true })));
    },
    finish() {
      accept(redactor.push(decoder.decode()));
      accept(redactor.flush());
      return { text, totalBytes, truncated };
    },
  };
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    end += character.length;
  }
  return text.slice(0, end);
}

function normalizeSecrets(secretValues: readonly string[]): string[] {
  return [...new Set(secretValues.filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
}

/** Extracts a Node.js-specific error code (e.g. `ENOENT`) from a caught value, when present. */
function describeErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return undefined;
  }
  const code = (cause as { code: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : undefined;
}

function launchFailure(reason: string, code: string | undefined): ManagedProcessLaunchFailure {
  return code === undefined ? { launched: false, reason } : { launched: false, reason, code };
}

function describeSpawnFailure(result: {
  shortMessage?: unknown;
  originalMessage?: unknown;
  message?: unknown;
}): string {
  for (const candidate of [result.originalMessage, result.shortMessage, result.message]) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return 'process could not be started';
}

function snapshotParentEnvironment(
  config: TevuConfig,
): TevuResult<ParentEnvironmentSnapshot, 'PrerequisiteError'> {
  const path = process.env.PATH;
  if (path === undefined || path.length === 0) {
    return prerequisiteError('environment', 'non-empty parent PATH', 'empty');
  }

  const agentValues: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const settings of Object.values(config.agents)) {
    for (const name of settings.secrets) {
      const value = process.env[name];
      if (value === undefined) {
        return missingVariableError(name);
      }
      agentValues[name] = value;
      secretValues.push(value);
    }
    for (const name of settings.env) {
      const value = process.env[name];
      if (value === undefined) {
        return missingVariableError(name);
      }
      agentValues[name] = value;
    }
  }

  const ordinaryEvaluatorValues: Record<string, string> = {};
  for (const name of evaluatorEnvironmentNames(config)) {
    const value = process.env[name];
    if (value === undefined) {
      return missingVariableError(name);
    }
    ordinaryEvaluatorValues[name] = value;
  }

  const jira = config.trackers?.jira;
  if (jira !== undefined) {
    const token = process.env[referencedVariableName(jira.token)];
    if (token !== undefined) {
      secretValues.push(token);
    }
  }

  return {
    ok: true,
    value: {
      path,
      agentValues,
      ordinaryEvaluatorValues,
      secretValues: [...new Set(secretValues.filter((value) => value.length > 0))],
    },
  };
}

type EnvironmentAddition = {
  name: string;
  classification: 'secret' | 'ordinary';
  value?: string;
};

type IsolatedEnvironmentInput = {
  caseId: string;
  recipient: 'agent' | 'evaluator';
  baseDirectory: string;
  path: string;
  additions: EnvironmentAddition[];
};

async function buildIsolatedEnvironment(
  input: IsolatedEnvironmentInput,
): Promise<IsolatedEnvironment> {
  const homeDirectory = join(input.baseDirectory, 'home');
  const temporaryDirectory = join(input.baseDirectory, 'tmp');
  const xdgDirectories = {
    XDG_CONFIG_HOME: join(homeDirectory, '.config'),
    XDG_DATA_HOME: join(homeDirectory, '.local', 'share'),
    XDG_CACHE_HOME: join(homeDirectory, '.cache'),
    XDG_STATE_HOME: join(homeDirectory, '.local', 'state'),
  };
  for (const directory of [temporaryDirectory, ...Object.values(xdgDirectories)]) {
    await mkdir(directory, { recursive: true });
  }

  const variables: Record<string, string> = {
    PATH: input.path,
    HOME: homeDirectory,
    ...xdgDirectories,
    TMPDIR: temporaryDirectory,
    LANG: FIXED_LOCALE,
    LC_ALL: FIXED_LOCALE,
    CI: '1',
  };
  const variableManifest: EnvironmentVariableRecord[] = Object.keys(variables).map((name) => ({
    name,
    classification: 'fixed',
    recipient: input.recipient,
  }));

  for (const addition of input.additions) {
    variableManifest.push({
      name: addition.name,
      classification: addition.classification,
      recipient: input.recipient,
    });
    if (addition.value !== undefined) {
      variables[addition.name] = addition.value;
    }
  }

  return {
    caseId: input.caseId,
    recipient: input.recipient,
    homeDirectory,
    temporaryDirectory,
    variables,
    variableManifest,
  };
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let candidate = target;
  for (;;) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new Error(`no existing ancestor directory for ${target}`);
      }
      candidate = parent;
    }
  }
}

async function probeToolVersion(
  tool: 'bun' | 'git',
): Promise<TevuResult<string, 'PrerequisiteError'>> {
  // Version probes are local prerequisite checks, not case processes, so they
  // inherit the parent environment: version-manager shims (asdf, mise) need
  // HOME and friends to resolve the pinned tool. No value is persisted.
  const result = await execa(tool, ['--version'], {
    stdin: 'ignore',
    reject: false,
    timeout: PROBE_TIMEOUT_MS,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.failed || result.exitCode !== 0 || stdout.length === 0) {
    return prerequisiteError(
      tool,
      `${tool} --version succeeds on the parent PATH`,
      describeSpawnFailure(result),
    );
  }
  const version = /\d+\.\d+[^\s]*/.exec(stdout);
  return { ok: true, value: version === null ? stdout : version[0] };
}

function prerequisiteError(
  tool: string,
  expected: string,
  actual: string,
): {
  ok: false;
  error: { kind: 'PrerequisiteError'; tool: string; expected: string; actual: string };
} {
  return { ok: false, error: { kind: 'PrerequisiteError', tool, expected, actual } };
}

function missingVariableError(name: string): {
  ok: false;
  error: { kind: 'PrerequisiteError'; tool: string; expected: string; actual: string };
} {
  return prerequisiteError('environment', `environment variable ${name} set`, 'unset');
}
