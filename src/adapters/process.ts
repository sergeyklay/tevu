/**
 * Execa-backed process boundary: managed literal-argv process supervision with
 * detached process groups, streaming credential-secret redaction, bounded
 * output capture, isolated replacement environments, and local prerequisite
 * probes. Every managed subprocess starts without a shell and with an explicit
 * replacement environment; only the read-only local tool-version probes
 * inherit the parent environment so version-manager shims keep working.
 */

import { Buffer } from 'node:buffer';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';

import { describeCause } from '@/domain/describe-cause';
import { ISOLATED_GIT_SETTINGS } from '@/domain/git-environment';
import { redactDecodedValue } from '@/domain/redaction';

import type {
  CaseEnvironments,
  CaseExecutableAdapter,
  CaseExecutableProbe,
  CaseExecutableProbeRequest,
  CaseExecutableVerdict,
  CaseWorkspace,
  EnvironmentAdapter,
  EnvironmentVariableNames,
  EnvironmentVariableRecord,
  EvaluatorProcessAdapter,
  EvaluatorProcessRequest,
  EvaluatorProcessResult,
  HostProbe,
  IsolatedEnvironment,
  ManagedProcessLaunchFailure,
  ManagedProcessRequest,
  ManagedProcessResult,
  ModelCallEnvironment,
  ParentEnvironmentSnapshot,
  PrerequisiteAdapter,
  RedactedCapture,
  Redactor,
  SecretRedactor,
  TerminationStage,
  TevuResult,
  WorkingDirectoryChanges,
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
/** Matches OpenCode's private grace period so a case executable and an agent are torn down alike. */
const CASE_EXECUTABLE_TERMINATION_GRACE_MS = 2_000;
/** Above this many `git status` entries a directory snapshot is treated as unreadable rather than scanned in full. */
const DIRECTORY_SNAPSHOT_ENTRY_LIMIT = 10_000;

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
 * supervised process settles. When `request.stdinText` is set, the child's
 * stdin carries that text and is closed after it; otherwise stdin is
 * `/dev/null`. A child that exits before reading all of the text is reported
 * by its exit status, not as a write failure, and a pending write delays
 * neither timeout nor cancellation.
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
      // `input` needs a piped stdin: combining it with 'ignore' throws at spawn.
      ...(request.stdinText === undefined
        ? { stdin: 'ignore' }
        : { stdin: 'pipe', input: request.stdinText }),
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
    snapshotParent(
      names: EnvironmentVariableNames,
    ): TevuResult<ParentEnvironmentSnapshot, 'PrerequisiteError'> {
      return snapshotParentEnvironment(names);
    },
    async createCaseEnvironments(
      workspace: CaseWorkspace,
      snapshot: ParentEnvironmentSnapshot,
      names: EnvironmentVariableNames,
      agent: string,
    ): Promise<TevuResult<CaseEnvironments, 'IsolationError'>> {
      const agentSettings = names.agents[agent];
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
          additions: names.ordinaryEvaluator.map((name) => ({
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
    async createModelCallEnvironment(
      snapshot: ParentEnvironmentSnapshot,
      agentVariables: { secrets: readonly string[]; env: readonly string[] },
    ): Promise<TevuResult<ModelCallEnvironment, 'ArtifactError'>> {
      let root: string;
      try {
        root = await mkdtemp(join(tmpdir(), 'tevu-call-'));
      } catch (cause) {
        return artifactError('create-model-call-directory', describeCause(cause));
      }
      try {
        const workingDirectory = join(root, 'work');
        await mkdir(workingDirectory);
        const base = await createEnvironmentBase(join(root, 'agent'), snapshot.path);
        const variables: Record<string, string> = { ...base.variables };
        for (const name of [...agentVariables.secrets, ...agentVariables.env]) {
          const value = snapshot.agentValues[name];
          if (value !== undefined) {
            variables[name] = value;
          }
        }
        return {
          ok: true,
          value: {
            rootDirectory: root,
            workingDirectory,
            homeDirectory: base.homeDirectory,
            variables,
            async dispose(): Promise<TevuResult<void, 'ArtifactError'>> {
              try {
                await rm(root, { recursive: true, force: true });
                return { ok: true, value: undefined };
              } catch (cause) {
                return artifactError('remove-model-call-directory', describeCause(cause));
              }
            },
          },
        };
      } catch (cause) {
        await rm(root, { recursive: true, force: true }).catch(() => undefined);
        return artifactError('create-model-call-directory', describeCause(cause));
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
      const gitVersion = await probeGitVersion();
      if (!gitVersion.ok) {
        return gitVersion;
      }
      return {
        ok: true,
        value: {
          platform,
          nodeVersion: process.version,
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

/**
 * Creates the case-executable probe adapter: for each request, starts
 * `[executable, "--version"]` once in a replica of its case environment and,
 * only when that run does not exit 0 before the time limit, once more in
 * tevu's own environment (the withheld names omitted), so a shim that only
 * resolves through the operator's home is reported rather than run inside a
 * case. When the request carries a working directory, also compares its Git
 * status before and after each run and reports what changed there, without
 * ever reverting it.
 */
export function createCaseExecutableAdapter(): CaseExecutableAdapter {
  return {
    async probe(
      request: CaseExecutableProbeRequest,
    ): Promise<TevuResult<CaseExecutableProbe, 'PrerequisiteError'>> {
      let root: string;
      try {
        root = await mkdtemp(join(tmpdir(), 'tevu-probe-'));
      } catch (cause) {
        return newProbeDirectoryError(cause);
      }

      let outcome: TevuResult<CaseExecutableProbe, 'PrerequisiteError'>;
      try {
        outcome = { ok: true, value: await runCaseExecutableProbe(request, root) };
      } catch (cause) {
        outcome = newProbeDirectoryError(cause);
      }

      try {
        await rm(root, { recursive: true, force: true });
      } catch (cause) {
        // Overrides any verdict, changes, or earlier error of this same call:
        // a retained probe directory is itself a prerequisite failure.
        return prerequisiteError(
          'case-executable',
          `probe directory ${root} removed`,
          describeCause(cause),
        );
      }
      return outcome;
    },
  };
}

function newProbeDirectoryError(
  cause: unknown,
): TevuResult<CaseExecutableProbe, 'PrerequisiteError'> {
  return prerequisiteError(
    'case-executable',
    `a new probe directory under ${tmpdir()}`,
    describeCause(cause),
  );
}

async function runCaseExecutableProbe(
  request: CaseExecutableProbeRequest,
  root: string,
): Promise<CaseExecutableProbe> {
  const watcher =
    request.workingDirectory === undefined
      ? undefined
      : createDirectorySnapshotWatcher(request.workingDirectory);
  const work = request.workingDirectory ?? (await createEmptyProbeWorkDirectory(root));
  if (watcher !== undefined) {
    await watcher.start();
  }

  const base = await createEnvironmentBase(join(root, 'env'), request.path);
  const replica = buildReplicaEnvironment(base.variables, request.additions);
  const argv: [string, ...string[]] = [request.executable, '--version'];

  const replicaResult = await runManagedProcess({
    argv,
    cwd: work,
    environment: replica,
    timeoutMs: PROBE_TIMEOUT_MS,
    terminationGraceMs: CASE_EXECUTABLE_TERMINATION_GRACE_MS,
  });
  if (watcher !== undefined) {
    await watcher.afterRun('replica');
  }

  if (exitedZero(replicaResult)) {
    return withChanges({ verdict: 'runs' }, watcher);
  }
  if (replicaResult.launched && replicaResult.timedOut) {
    // The replica may still be downloading a toolchain into its empty home;
    // a case with a longer limit could finish where this probe cannot.
    return withChanges({ verdict: 'undetermined' }, watcher);
  }

  const parentResult = await runManagedProcess({
    argv,
    cwd: work,
    environment: buildParentEnvironment(request.withheldNames),
    timeoutMs: PROBE_TIMEOUT_MS,
    terminationGraceMs: CASE_EXECUTABLE_TERMINATION_GRACE_MS,
  });
  if (watcher !== undefined) {
    await watcher.afterRun('parent');
  }

  if (exitedZero(parentResult)) {
    return withChanges(
      {
        verdict: 'parent-only',
        resolvedPath: await resolveOnPath(request.executable, request.path),
        replicaFailure: failureOf(replicaResult),
      },
      watcher,
    );
  }
  return withChanges({ verdict: 'undetermined' }, watcher);
}

function withChanges(
  verdict: CaseExecutableVerdict,
  watcher: DirectorySnapshotWatcher | undefined,
): CaseExecutableProbe {
  return watcher === undefined ? { verdict } : { verdict, changes: watcher.changes };
}

async function createEmptyProbeWorkDirectory(root: string): Promise<string> {
  const work = join(root, 'work');
  await mkdir(work);
  return work;
}

function buildReplicaEnvironment(
  base: Readonly<Record<string, string>>,
  additions: Readonly<Record<string, string>>,
): Record<string, string> {
  const replica: Record<string, string> = { ...base };
  for (const [name, value] of Object.entries(additions)) {
    if (!(name in replica)) {
      replica[name] = value;
    }
  }
  return replica;
}

/** Every defined `process.env` entry except the names a case never gives an evaluator or setup command. */
function buildParentEnvironment(withheldNames: readonly string[]): Record<string, string> {
  const withheld = new Set(withheldNames);
  const parent: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !withheld.has(name)) {
      parent[name] = value;
    }
  }
  return parent;
}

function exitedZero(result: ManagedProcessResult): boolean {
  return result.launched && !result.timedOut && result.exitCode === 0;
}

/**
 * Reduces a settled, non-zero replica outcome to the shape a `parent-only`
 * finding carries; never reads process output.
 */
function failureOf(result: ManagedProcessResult):
  | { kind: 'exited'; exitCode: number }
  | { kind: 'signaled'; signal: string }
  | {
      kind: 'not-started';
      code: string | null;
    } {
  if (!result.launched) {
    return { kind: 'not-started', code: result.code ?? null };
  }
  if (result.exitCode !== null) {
    return { kind: 'exited', exitCode: result.exitCode };
  }
  return { kind: 'signaled', signal: result.signal ?? 'unknown' };
}

/**
 * Resolves a bare executable name against one PATH the way a shell would,
 * without following the target of a matched symbolic link: an absolute-path
 * `executable` resolves to itself, and a `stat`/`access` failure on a
 * candidate just skips that PATH entry rather than failing the lookup.
 */
async function resolveOnPath(executable: string, path: string): Promise<string | null> {
  if (executable.startsWith('/')) {
    return executable;
  }
  for (const entry of path.split(':')) {
    if (entry.length === 0 || !entry.startsWith('/')) {
      continue;
    }
    const candidate = join(entry, executable);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) {
        continue;
      }
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** Explicit replacement environment for a directory snapshot's git commands, isolated from the operator's own configuration. */
function caseExecutableGitEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...ISOLATED_GIT_SETTINGS,
  };
  const home = process.env.HOME;
  if (home !== undefined) {
    environment.HOME = home;
  }
  return environment;
}

/**
 * Runs one git command for a directory snapshot with stdout captured as raw
 * bytes, so a byte-exact path survives even when it is not valid UTF-8.
 *
 * `label` names the command in a failure reason (`rev-parse --show-prefix`
 * or `status`), never the full argument list, so a failure reason never
 * exposes an isolation flag such as `core.fsmonitor=false`.
 */
async function runCaseExecutableGit(
  work: string,
  args: readonly string[],
  label: string,
): Promise<{ ok: true; stdout: Buffer } | { ok: false; reason: string }> {
  try {
    const result = await execa('git', [...args], {
      cwd: work,
      env: caseExecutableGitEnvironment(),
      extendEnv: false,
      stdin: 'ignore',
      encoding: 'buffer',
      reject: false,
      timeout: PROBE_TIMEOUT_MS,
    });
    if (result.timedOut) {
      return { ok: false, reason: `git ${label} did not finish within 10 s` };
    }
    if (typeof result.exitCode === 'number') {
      return result.exitCode === 0
        ? { ok: true, stdout: Buffer.from(result.stdout) }
        : { ok: false, reason: `git ${label} exited with code ${result.exitCode}` };
    }
    if (typeof result.signal === 'string') {
      return { ok: false, reason: `git ${label} was terminated by signal ${result.signal}` };
    }
    return { ok: false, reason: `git ${label} could not be started` };
  } catch {
    return { ok: false, reason: `git ${label} could not be started` };
  }
}

/** One path's type, size, and modification and status-change times; absence is a distinct, comparable state. */
type PathFingerprint = { mode: number; size: number; mtimeNs: bigint; ctimeNs: bigint };

/**
 * One moment's Git status for a working directory: every path it lists, and
 * the `lstat` state of each of those paths plus every path a caller carries
 * forward from an earlier snapshot.
 */
type DirectorySnapshot = {
  listed: Map<string, 'tracked' | 'untracked'>;
  states: Map<string, PathFingerprint | 'absent'>;
};

/**
 * Reads one moment's Git status of `work` and the `lstat` state of every path
 * it lists plus every `carried` path, so a path that stops being listed
 * (because it was deleted) can still be recognized as removed. Path keys are
 * raw bytes stored as a Latin-1 string, which round-trips every byte value
 * exactly and so stays safe to use for lookup and comparison even when a
 * path is not valid UTF-8.
 */
async function directorySnapshot(
  work: string,
  prefix: Buffer,
  carried: readonly string[],
): Promise<{ ok: true; value: DirectorySnapshot } | { ok: false; reason: string }> {
  const status = await runCaseExecutableGit(
    work,
    [
      '-c',
      'core.fsmonitor=false',
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--no-renames',
      '--',
      '.',
    ],
    'status',
  );
  if (!status.ok) {
    return status;
  }
  const entries = splitOnNulByte(status.stdout).filter((entry) => entry.length > 0);
  if (entries.length > DIRECTORY_SNAPSHOT_ENTRY_LIMIT) {
    return { ok: false, reason: 'git status listed more than 10000 paths' };
  }

  const listed = new Map<string, 'tracked' | 'untracked'>();
  for (const entry of entries) {
    if (entry.length < 4 || !startsWithBytes(entry.subarray(3), prefix)) {
      return { ok: false, reason: 'git status printed an unreadable entry' };
    }
    const key = entry.subarray(3 + prefix.length).toString('latin1');
    const statusCode = entry.subarray(0, 2).toString('latin1');
    listed.set(key, statusCode === '??' ? 'untracked' : 'tracked');
  }

  const states = new Map<string, PathFingerprint | 'absent'>();
  for (const key of new Set([...listed.keys(), ...carried])) {
    const target = Buffer.concat([
      Buffer.from(work, 'utf8'),
      Buffer.from('/', 'utf8'),
      Buffer.from(key, 'latin1'),
    ]);
    try {
      const info = await lstat(target, { bigint: true });
      states.set(key, {
        mode: Number(info.mode),
        size: Number(info.size),
        mtimeNs: info.mtimeNs,
        ctimeNs: info.ctimeNs,
      });
    } catch (cause) {
      const code = describeErrorCode(cause);
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        states.set(key, 'absent');
      } else {
        return { ok: false, reason: `a listed path could not be inspected (${code ?? 'unknown'})` };
      }
    }
  }
  return { ok: true, value: { listed, states } };
}

function splitOnNulByte(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      parts.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start < buffer.length) {
    parts.push(buffer.subarray(start));
  }
  return parts;
}

function startsWithBytes(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

/** Decodes a Latin-1 path key back to the text a finding shows, an invalid UTF-8 sequence becoming U+FFFD. */
function decodeRawPathKey(key: string): string {
  return Buffer.from(key, 'latin1').toString('utf8');
}

/**
 * Classifies every path either snapshot listed against the fixed-point table
 * of what "listed" and "lstat" combine to mean: none, added, modified, or
 * removed.
 */
function classifyDirectorySnapshots(
  previous: DirectorySnapshot,
  current: DirectorySnapshot,
): { added: string[]; modified: string[]; removed: string[] } {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const path of new Set([...previous.listed.keys(), ...current.listed.keys()])) {
    const change = classifyDirectorySnapshotPath(previous, current, path);
    if (change === 'added') {
      added.push(path);
    } else if (change === 'modified') {
      modified.push(path);
    } else if (change === 'removed') {
      removed.push(path);
    }
  }
  return { added, modified, removed };
}

function classifyDirectorySnapshotPath(
  previous: DirectorySnapshot,
  current: DirectorySnapshot,
  path: string,
): 'none' | 'added' | 'modified' | 'removed' {
  if (previous.listed.has(path)) {
    const before = previous.states.get(path);
    const after = current.states.get(path);
    if (before === undefined || before === 'absent') {
      return after === undefined || after === 'absent' ? 'none' : 'added';
    }
    if (after === undefined || after === 'absent') {
      return 'removed';
    }
    return fingerprintsEqual(before, after) ? 'none' : 'modified';
  }
  // Not listed before: current.states has an entry only because `path` is
  // one of current.listed's own keys, since it cannot have been carried
  // forward from a snapshot that never listed it.
  const after = current.states.get(path);
  if (after === undefined || after === 'absent') {
    return 'removed';
  }
  return current.listed.get(path) === 'untracked' ? 'added' : 'modified';
}

function fingerprintsEqual(a: PathFingerprint, b: PathFingerprint): boolean {
  return (
    a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}

type DirectorySnapshotWatcher = {
  start(): Promise<void>;
  afterRun(run: 'replica' | 'parent'): Promise<void>;
  changes: WorkingDirectoryChanges;
};

/**
 * Takes a directory snapshot before and after each run of one probe and
 * accumulates the difference as `changes`, never touching a file itself.
 * Every method after the first failure is a no-op, so `changes.failure`
 * always names the first snapshot that could not be taken.
 */
function createDirectorySnapshotWatcher(work: string): DirectorySnapshotWatcher {
  const changes: WorkingDirectoryChanges = { runs: [] };
  let prefix: Buffer | undefined;
  let previous: DirectorySnapshot | undefined;

  const fail = (reason: string): void => {
    changes.failure ??= reason;
  };

  return {
    async start(): Promise<void> {
      const prefixResult = await runCaseExecutableGit(
        work,
        ['rev-parse', '--show-prefix'],
        'rev-parse --show-prefix',
      );
      if (!prefixResult.ok) {
        fail(prefixResult.reason);
        return;
      }
      const bytes = prefixResult.stdout;
      prefix =
        bytes.length > 0 && bytes[bytes.length - 1] === 0x0a
          ? bytes.subarray(0, bytes.length - 1)
          : bytes;
      const snapshot = await directorySnapshot(work, prefix, []);
      if (!snapshot.ok) {
        fail(snapshot.reason);
        return;
      }
      previous = snapshot.value;
    },
    async afterRun(run: 'replica' | 'parent'): Promise<void> {
      if (changes.failure !== undefined || previous === undefined || prefix === undefined) {
        return;
      }
      const snapshot = await directorySnapshot(work, prefix, [...previous.listed.keys()]);
      if (!snapshot.ok) {
        fail(snapshot.reason);
        return;
      }
      const current = snapshot.value;
      const diff = classifyDirectorySnapshots(previous, current);
      changes.runs.push({
        run,
        added: diff.added.sort().map(decodeRawPathKey),
        modified: diff.modified.sort().map(decodeRawPathKey),
        removed: diff.removed.sort().map(decodeRawPathKey),
      });
      previous = current;
    },
    changes,
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
  names: EnvironmentVariableNames,
): TevuResult<ParentEnvironmentSnapshot, 'PrerequisiteError'> {
  const path = process.env.PATH;
  if (path === undefined || path.length === 0) {
    return prerequisiteError('environment', 'non-empty parent PATH', 'empty');
  }

  const agentValues: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const entry of Object.values(names.agents)) {
    for (const name of entry.secrets) {
      const value = process.env[name];
      if (value === undefined) {
        return missingVariableError(name);
      }
      agentValues[name] = value;
      secretValues.push(value);
    }
    for (const name of entry.env) {
      const value = process.env[name];
      if (value === undefined) {
        return missingVariableError(name);
      }
      agentValues[name] = value;
    }
  }

  const ordinaryEvaluatorValues: Record<string, string> = {};
  for (const name of names.ordinaryEvaluator) {
    const value = process.env[name];
    if (value === undefined) {
      return missingVariableError(name);
    }
    ordinaryEvaluatorValues[name] = value;
  }

  if (names.jiraTokenVariable !== undefined) {
    const token = process.env[names.jiraTokenVariable];
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

/** One private home, XDG, and temporary directory layout with its fixed replacement variables. */
type EnvironmentBase = {
  homeDirectory: string;
  temporaryDirectory: string;
  variables: Record<string, string>;
};

/**
 * Creates one private home, XDG, and temporary directory layout under
 * `baseDirectory`, and its fixed replacement variables (`PATH`, `HOME`,
 * `XDG_*`, `TMPDIR`, `LANG`, `LC_ALL`, `CI`). Shared by the per-case agent and
 * evaluator environments and by one model call's agent environment, so a
 * later change to this layout reaches every caller.
 */
async function createEnvironmentBase(
  baseDirectory: string,
  path: string,
): Promise<EnvironmentBase> {
  const homeDirectory = join(baseDirectory, 'home');
  const temporaryDirectory = join(baseDirectory, 'tmp');
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
    PATH: path,
    HOME: homeDirectory,
    ...xdgDirectories,
    TMPDIR: temporaryDirectory,
    LANG: FIXED_LOCALE,
    LC_ALL: FIXED_LOCALE,
    CI: '1',
  };
  return { homeDirectory, temporaryDirectory, variables };
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
  const base = await createEnvironmentBase(input.baseDirectory, input.path);
  const variables: Record<string, string> = { ...base.variables };
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
    homeDirectory: base.homeDirectory,
    temporaryDirectory: base.temporaryDirectory,
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

async function probeGitVersion(): Promise<TevuResult<string, 'PrerequisiteError'>> {
  // Version probes are local prerequisite checks, not case processes, so they
  // inherit the parent environment: version-manager shims (asdf, mise) need
  // HOME and friends to resolve the pinned tool. No value is persisted.
  const result = await execa('git', ['--version'], {
    stdin: 'ignore',
    reject: false,
    timeout: PROBE_TIMEOUT_MS,
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (result.failed || result.exitCode !== 0 || stdout.length === 0) {
    return prerequisiteError(
      'git',
      'git --version succeeds on the parent PATH',
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

function artifactError(
  operation: string,
  reason: string,
): { ok: false; error: { kind: 'ArtifactError'; operation: string; reason: string } } {
  return { ok: false, error: { kind: 'ArtifactError', operation, reason } };
}

function missingVariableError(name: string): {
  ok: false;
  error: { kind: 'PrerequisiteError'; tool: string; expected: string; actual: string };
} {
  return prerequisiteError('environment', `environment variable ${name} set`, 'unset');
}
