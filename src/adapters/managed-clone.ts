/**
 * Managed-clone boundary: clones and fetches a GitHub repository entry's
 * bare clone through the local git CLI, with gh as git's credential helper.
 * tevu runs git itself; gh is used only to probe its presence and to hand
 * git a credential on demand.
 *
 * Entry point: {@link createManagedCloneAdapter}.
 */

import { lstat, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describeCause } from '@/domain/describe-cause';
import { GIT_COMMAND_TIMEOUT_MS, ISOLATED_GIT_SETTINGS } from '@/domain/git-environment';
import { authenticationReason, ghEnvironment, stderrExcerpt } from '@/domain/github-cli';
import { formatGitHubRepository, isPlainHost } from '@/domain/github-reference';

import type { ParsedGitHubRepository } from '@/domain/github-reference';
import type {
  CloneState,
  ManagedCloneAdapter,
  ManagedCloneOperation,
  ManagedProcessRunner,
  TevuResult,
} from '@/domain/types';

/** Construction inputs for the managed-clone adapter. */
export type ManagedCloneAdapterOptions = {
  runProcess: ManagedProcessRunner;
  parentEnvironment: Readonly<Record<string, string | undefined>>;
  secretValues: () => readonly string[];
  cancellation: AbortSignal;
  /** Defaults to `https://HOST/OWNER/REPO.git`; tests pass the URL of a local bare repository. */
  remoteUrl?: (repository: ParsedGitHubRepository) => string;
};

/** Names starting with `GIT_` that survive the network environment's stripping step. */
const KEPT_GIT_PREFIXES = ['GIT_SSL_', 'GIT_HTTP_', 'GIT_PROXY_SSL_'];
const GH_PROBE_TIMEOUT_MS = 30_000;
const LFS_PROBE_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 3_000;
const LFS_RETRY_TEXT = 'retry once the cause is fixed; objects already fetched are kept';
const LFS_MISSING_OBJECT_LINE = /^\[[0-9a-f]{64}\] .*: \[404\] /;

/** Whether this adapter instance has already probed gh successfully. */
type GhProbeState = { probed: boolean };

/** Whether this adapter instance has already probed `git lfs version` successfully. */
type LfsProbeState = { probed: boolean };

/**
 * Creates the {@link ManagedCloneAdapter} implementation over the local git
 * CLI and gh. Probes gh at most once per instance, on the first `clone`,
 * `fetchCommits`, `fetchBranchesAndTags`, `fetchLfsObjects`, or `checkRemote`
 * call, and `git lfs version` at most once per instance, on the first
 * `fetchLfsObjects` call; `inspectClone` never probes a tool or contacts the
 * network.
 */
export function createManagedCloneAdapter(
  options: ManagedCloneAdapterOptions,
): ManagedCloneAdapter {
  const ghProbeState: GhProbeState = { probed: false };
  const lfsProbeState: LfsProbeState = { probed: false };
  return {
    inspectClone: (directory) => inspectCloneState(options, directory),
    clone: (directory, repository) => clone(options, ghProbeState, directory, repository),
    fetchCommits: (directory, source, commits) =>
      fetchCommits(options, ghProbeState, directory, source, commits),
    fetchBranchesAndTags: (directory, repository) =>
      fetchBranchesAndTags(options, ghProbeState, directory, repository),
    checkRemote: (repository) => checkRemote(options, ghProbeState, repository),
    fetchLfsObjects: (directory, repository, commit) =>
      fetchLfsObjects(
        options,
        { gh: ghProbeState, lfs: lfsProbeState },
        directory,
        repository,
        commit,
      ),
  };
}

async function inspectCloneState(
  options: ManagedCloneAdapterOptions,
  directory: string,
): Promise<CloneState> {
  try {
    await lstat(directory);
  } catch (cause) {
    return isErrnoCode(cause, 'ENOENT') ? 'missing' : 'not-a-repository';
  }
  const result = await options.runProcess({
    argv: ['git', 'rev-parse', '--absolute-git-dir'],
    cwd: directory,
    environment: networkGitEnvironment(options.parentEnvironment),
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    cancellation: options.cancellation,
  });
  if (!result.launched || result.exitCode !== 0) {
    return 'not-a-repository';
  }
  let real: string;
  try {
    real = await realpath(directory);
  } catch {
    return 'not-a-repository';
  }
  return result.stdout.text.trim() === real ? 'repository' : 'not-a-repository';
}

/**
 * Bare-clones `repository` into `directory`, refusing to write inside a Git
 * working tree, landing the clone in a temporary directory renamed into
 * place, and releasing its lock on every exit path.
 */
async function clone(
  options: ManagedCloneAdapterOptions,
  ghProbeState: GhProbeState,
  directory: string,
  repository: ParsedGitHubRepository,
): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>> {
  const display = formatGitHubRepository(repository);
  if (!isPlainHost(repository.host)) {
    return managedCloneFailure('clone', display, hostRuleReason(repository.host));
  }
  if (options.cancellation.aborted) {
    return cancellationFailure();
  }

  const ancestor = await nearestExistingAncestor(directory);
  const toplevel = await detectWorkingTree(options, ancestor, display);
  if (!toplevel.ok) {
    return toplevel;
  }
  if (toplevel.value !== null) {
    return managedCloneFailure(
      'clone',
      display,
      `"${ancestor}" is inside the Git working tree "${toplevel.value}"; set XDG_CACHE_HOME to an absolute directory outside every working copy`,
    );
  }

  const parentDirectory = path.dirname(directory);
  try {
    await mkdir(parentDirectory, { recursive: true });
  } catch (cause) {
    return managedCloneFailure(
      'clone',
      display,
      `cannot create "${parentDirectory}": ${describeCause(cause)}`,
    );
  }

  const lockPath = `${directory}.lock`;
  const locked = await acquireLock(lockPath, 'clone', display);
  if (!locked.ok) {
    return locked;
  }
  let temporaryDirectory: string | undefined;
  try {
    const state = await inspectCloneState(options, directory);
    if (state !== 'missing') {
      if (state === 'repository') {
        return { ok: true, value: undefined };
      }
      return managedCloneFailure('clone', display, notAClonReason(directory));
    }

    const probed = await probeGh(options, ghProbeState, 'clone', display);
    if (!probed.ok) {
      return probed;
    }

    try {
      temporaryDirectory = await mkdtemp(
        path.join(parentDirectory, `.${repository.repo}.git.tmp-`),
      );
    } catch (cause) {
      return managedCloneFailure(
        'clone',
        display,
        `cannot create "${parentDirectory}": ${describeCause(cause)}`,
      );
    }

    const remote = (options.remoteUrl ?? defaultRemoteUrl)(repository);
    const cloned = await runGitForOperation(
      options,
      parentDirectory,
      [
        ...credentialHelperArgs(repository.host),
        'clone',
        '--bare',
        '--quiet',
        '-c',
        'gc.auto=0',
        '-c',
        'maintenance.auto=false',
        remote,
        temporaryDirectory,
      ],
      'clone',
      display,
      repository.host,
    );
    if (!cloned.ok) {
      return cloned;
    }

    try {
      await rename(temporaryDirectory, directory);
    } catch (cause) {
      return managedCloneFailure(
        'clone',
        display,
        `cannot move "${temporaryDirectory}" to "${directory}": ${describeCause(cause)}`,
      );
    }
    temporaryDirectory = undefined;
    return { ok: true, value: undefined };
  } finally {
    if (temporaryDirectory !== undefined) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    await releaseLock(lockPath);
  }
}

/** Fetches full commit hashes from `source`, each into `refs/tevu/fetched/<hash>`. */
async function fetchCommits(
  options: ManagedCloneAdapterOptions,
  ghProbeState: GhProbeState,
  directory: string,
  source: ParsedGitHubRepository,
  hashes: readonly string[],
): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>> {
  const display = formatGitHubRepository(source);
  if (!isPlainHost(source.host)) {
    return managedCloneFailure('fetch', display, hostRuleReason(source.host));
  }
  const refspecs = hashes.map((hash) => `${hash}:refs/tevu/fetched/${hash}`);
  return withLockedFetch(options, ghProbeState, directory, source, display, refspecs);
}

/** Fetches every branch and tag of `repository`, force-updating `refs/heads/*` and `refs/tags/*`. */
async function fetchBranchesAndTags(
  options: ManagedCloneAdapterOptions,
  ghProbeState: GhProbeState,
  directory: string,
  repository: ParsedGitHubRepository,
): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>> {
  const display = formatGitHubRepository(repository);
  if (!isPlainHost(repository.host)) {
    return managedCloneFailure('fetch', display, hostRuleReason(repository.host));
  }
  return withLockedFetch(options, ghProbeState, directory, repository, display, [
    '+refs/heads/*:refs/heads/*',
    '+refs/tags/*:refs/tags/*',
  ]);
}

/**
 * Fetches every Git LFS object of `commit` into the clone in `directory`,
 * under the clone lock. The endpoint is pinned to the clone URL so a tracked
 * `.lfsconfig` cannot send the operator's credentials to another host, and
 * the empty include and exclude filters keep a tracked `fetchexclude` from
 * turning the fetch into a no-op.
 */
async function fetchLfsObjects(
  options: ManagedCloneAdapterOptions,
  probeStates: { gh: GhProbeState; lfs: LfsProbeState },
  directory: string,
  repository: ParsedGitHubRepository,
  commit: string,
): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>> {
  const display = formatGitHubRepository(repository);
  if (!isPlainHost(repository.host)) {
    return managedCloneFailure('lfs-fetch', display, hostRuleReason(repository.host));
  }
  if (options.cancellation.aborted) {
    return cancellationFailure();
  }
  const lfsProbed = await probeGitLfs(options, probeStates.lfs, display);
  if (!lfsProbed.ok) {
    return lfsProbed;
  }

  const lockPath = `${directory}.lock`;
  const locked = await acquireLock(lockPath, 'lfs-fetch', display);
  if (!locked.ok) {
    return locked;
  }
  try {
    const ghProbed = await probeGh(options, probeStates.gh, 'lfs-fetch', display);
    if (!ghProbed.ok) {
      return ghProbed;
    }
    const remote = (options.remoteUrl ?? defaultRemoteUrl)(repository);
    const result = await options.runProcess({
      argv: [
        'git',
        ...credentialHelperArgs(repository.host),
        '-c',
        `lfs.url=${remote}/info/lfs`,
        'lfs',
        'fetch',
        '-I',
        '',
        '-X',
        '',
        remote,
        commit,
      ],
      cwd: directory,
      environment: networkGitEnvironment(options.parentEnvironment),
      timeoutMs: GIT_COMMAND_TIMEOUT_MS,
      terminationGraceMs: TERMINATION_GRACE_MS,
      cancellation: options.cancellation,
      secretValues: options.secretValues(),
    });
    if (options.cancellation.aborted || (result.launched && result.cancelled)) {
      return cancellationFailure();
    }
    if (!result.launched) {
      return managedCloneFailure(
        'lfs-fetch',
        display,
        `git could not be started: ${result.code ?? result.reason}`,
      );
    }
    if (result.timedOut) {
      return managedCloneFailure(
        'lfs-fetch',
        display,
        `git lfs fetch did not finish within 10 minutes; ${LFS_RETRY_TEXT}`,
      );
    }
    if (result.exitCode === 0) {
      return { ok: true, value: undefined };
    }
    if (result.exitCode === null) {
      return managedCloneFailure(
        'lfs-fetch',
        display,
        `git lfs fetch exited unexpectedly (signal ${result.signal ?? 'unknown'}); ${LFS_RETRY_TEXT}`,
      );
    }
    return managedCloneFailure(
      'lfs-fetch',
      display,
      describeLfsFetchFailure(result.exitCode, result.stderr.text, repository.host, display),
    );
  } finally {
    await releaseLock(lockPath);
  }
}

/** Runs `git lfs version` at most once per adapter instance, before the first Git LFS fetch. */
async function probeGitLfs(
  options: ManagedCloneAdapterOptions,
  state: LfsProbeState,
  display: string,
): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>> {
  if (state.probed) {
    return { ok: true, value: undefined };
  }
  const result = await options.runProcess({
    argv: ['git', 'lfs', 'version'],
    cwd: tmpdir(),
    environment: networkGitEnvironment(options.parentEnvironment),
    timeoutMs: LFS_PROBE_TIMEOUT_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    cancellation: options.cancellation,
    secretValues: options.secretValues(),
  });
  if (options.cancellation.aborted || (result.launched && result.cancelled)) {
    return cancellationFailure();
  }
  if (result.launched && result.timedOut) {
    return managedCloneFailure(
      'lfs-fetch',
      display,
      'git lfs version did not finish within 30 seconds',
    );
  }
  if (!result.launched || result.exitCode !== 0 || !result.stdout.text.startsWith('git-lfs/')) {
    return managedCloneFailure(
      'lfs-fetch',
      display,
      'Git LFS is not installed or not on PATH; install it from https://git-lfs.com',
    );
  }
  state.probed = true;
  return { ok: true, value: undefined };
}

/**
 * Builds the reason for a `git lfs fetch` that exited nonzero: the exit code,
 * the most telling stderr line, and the next step the stderr calls for.
 */
function describeLfsFetchFailure(
  exitCode: number,
  stderr: string,
  host: string,
  display: string,
): string {
  let reason = `git lfs fetch exited with code ${exitCode}`;
  // git-lfs 3.8 opens stderr with a "Fetching reference <sha>" progress line.
  const withoutProgress = stderr
    .split('\n')
    .filter((line) => !line.trim().startsWith('Fetching reference '))
    .join('\n');
  const excerpt = stderrExcerpt(withoutProgress, 'batch response: ');
  if (excerpt.length > 0) {
    reason += `: ${excerpt}`;
  }
  const lines = stderr.split('\n');
  if (
    lines.some(
      (line) => line.includes('Authorization error:') || line.includes('Git credentials for '),
    )
  ) {
    return `${reason}; ${authenticationReason(host)}`;
  }
  if (
    lines.some(
      (line) =>
        LFS_MISSING_OBJECT_LINE.test(line.trim()) || line.includes('remote missing object '),
    )
  ) {
    return `${reason}; ${display} does not have every Git LFS object of this commit; choose another base commit`;
  }
  return `${reason}; ${LFS_RETRY_TEXT}`;
}

/** Runs one `git ls-remote` for `repository`'s HEAD, with gh as the credential helper. */
async function checkRemote(
  options: ManagedCloneAdapterOptions,
  ghProbeState: GhProbeState,
  repository: ParsedGitHubRepository,
): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>> {
  const display = formatGitHubRepository(repository);
  if (!isPlainHost(repository.host)) {
    return managedCloneFailure('ls-remote', display, hostRuleReason(repository.host));
  }
  if (options.cancellation.aborted) {
    return cancellationFailure();
  }
  const probed = await probeGh(options, ghProbeState, 'ls-remote', display);
  if (!probed.ok) {
    return probed;
  }
  const remote = (options.remoteUrl ?? defaultRemoteUrl)(repository);
  const listed = await runGitForOperation(
    options,
    tmpdir(),
    [...credentialHelperArgs(repository.host), 'ls-remote', '--quiet', remote, 'HEAD'],
    'ls-remote',
    display,
    repository.host,
  );
  return listed.ok ? { ok: true, value: undefined } : listed;
}

/** Shared fetch plumbing: lock, gh probe, one `git fetch` with the given refspecs, then release. */
async function withLockedFetch(
  options: ManagedCloneAdapterOptions,
  ghProbeState: GhProbeState,
  directory: string,
  source: ParsedGitHubRepository,
  display: string,
  refspecs: readonly string[],
): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>> {
  if (options.cancellation.aborted) {
    return cancellationFailure();
  }
  const lockPath = `${directory}.lock`;
  const locked = await acquireLock(lockPath, 'fetch', display);
  if (!locked.ok) {
    return locked;
  }
  try {
    const probed = await probeGh(options, ghProbeState, 'fetch', display);
    if (!probed.ok) {
      return probed;
    }
    const remote = (options.remoteUrl ?? defaultRemoteUrl)(source);
    const fetched = await runGitForOperation(
      options,
      directory,
      [...credentialHelperArgs(source.host), 'fetch', '--quiet', '--no-tags', remote, ...refspecs],
      'fetch',
      display,
      source.host,
    );
    return fetched.ok ? { ok: true, value: undefined } : fetched;
  } finally {
    await releaseLock(lockPath);
  }
}

/** Runs `gh --version` at most once per adapter instance, before the first network git command. */
async function probeGh(
  options: ManagedCloneAdapterOptions,
  state: GhProbeState,
  operation: ManagedCloneOperation,
  display: string,
): Promise<TevuResult<void, 'ManagedCloneError' | 'CancellationError'>> {
  if (state.probed) {
    return { ok: true, value: undefined };
  }
  if (options.cancellation.aborted) {
    return cancellationFailure();
  }
  const result = await options.runProcess({
    argv: ['gh', '--version'],
    cwd: tmpdir(),
    environment: ghEnvironment(options.parentEnvironment),
    timeoutMs: GH_PROBE_TIMEOUT_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    cancellation: options.cancellation,
    secretValues: options.secretValues(),
  });
  if (options.cancellation.aborted || (result.launched && result.cancelled)) {
    return cancellationFailure();
  }
  if (!result.launched) {
    const reason =
      result.code === 'ENOENT'
        ? 'GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com'
        : `GitHub CLI (gh) could not be started: ${result.code ?? result.reason}`;
    return managedCloneFailure(operation, display, reason);
  }
  if (result.timedOut) {
    return managedCloneFailure(operation, display, 'gh --version did not finish within 30 seconds');
  }
  if (result.exitCode === 0) {
    state.probed = true;
    return { ok: true, value: undefined };
  }
  if (result.exitCode === null) {
    return managedCloneFailure(
      operation,
      display,
      `gh --version exited unexpectedly (signal ${result.signal ?? 'unknown'})`,
    );
  }
  return managedCloneFailure(
    operation,
    display,
    `gh --version exited with code ${result.exitCode}`,
  );
}

/**
 * Runs one network git invocation and interprets its outcome
 * into a `ManagedCloneError`, or the trimmed stdout on success.
 */
async function runGitForOperation(
  options: ManagedCloneAdapterOptions,
  cwd: string,
  args: readonly string[],
  operation: ManagedCloneOperation,
  display: string,
  host: string,
): Promise<TevuResult<string, 'ManagedCloneError' | 'CancellationError'>> {
  const result = await options.runProcess({
    argv: ['git', ...args],
    cwd,
    environment: networkGitEnvironment(options.parentEnvironment),
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    cancellation: options.cancellation,
    secretValues: options.secretValues(),
  });
  if (options.cancellation.aborted || (result.launched && result.cancelled)) {
    return cancellationFailure();
  }
  if (!result.launched) {
    return managedCloneFailure(
      operation,
      display,
      `git could not be started: ${result.code ?? result.reason}`,
    );
  }
  if (result.timedOut) {
    return managedCloneFailure(
      operation,
      display,
      `git ${operation} did not finish within 10 minutes`,
    );
  }
  if (result.exitCode === 0) {
    return { ok: true, value: result.stdout.text.trim() };
  }
  if (result.exitCode === null) {
    return managedCloneFailure(
      operation,
      display,
      `git ${operation} exited unexpectedly (signal ${result.signal ?? 'unknown'})`,
    );
  }
  const excerpt = stderrExcerpt(result.stderr.text, 'fatal: ');
  let reason = `git ${operation} exited with code ${result.exitCode}`;
  if (excerpt.length > 0) {
    reason += `: ${excerpt}`;
    if (excerpt.includes('could not read Username')) {
      reason += `; ${authenticationReason(host)}`;
    }
  }
  return managedCloneFailure(operation, display, reason);
}

/**
 * Runs `git rev-parse --show-toplevel` in `ancestor`: `value` is the
 * printed toplevel when `ancestor` lies inside a working tree, `null`
 * otherwise. A nonzero exit is the expected, non-error outcome here.
 */
async function detectWorkingTree(
  options: ManagedCloneAdapterOptions,
  ancestor: string,
  display: string,
): Promise<TevuResult<string | null, 'ManagedCloneError' | 'CancellationError'>> {
  const result = await options.runProcess({
    argv: ['git', 'rev-parse', '--show-toplevel'],
    cwd: ancestor,
    environment: networkGitEnvironment(options.parentEnvironment),
    timeoutMs: GIT_COMMAND_TIMEOUT_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    cancellation: options.cancellation,
    secretValues: options.secretValues(),
  });
  if (options.cancellation.aborted || (result.launched && result.cancelled)) {
    return cancellationFailure();
  }
  if (!result.launched) {
    return managedCloneFailure(
      'clone',
      display,
      `git could not be started: ${result.code ?? result.reason}`,
    );
  }
  if (result.timedOut) {
    return managedCloneFailure('clone', display, 'git clone did not finish within 10 minutes');
  }
  return { ok: true, value: result.exitCode === 0 ? result.stdout.text.trim() : null };
}

/** Walks up from `target` to the nearest directory that exists. */
async function nearestExistingAncestor(target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

async function acquireLock(
  lockPath: string,
  operation: ManagedCloneOperation,
  display: string,
): Promise<TevuResult<void, 'ManagedCloneError'>> {
  try {
    await mkdir(lockPath);
    return { ok: true, value: undefined };
  } catch (cause) {
    if (isErrnoCode(cause, 'EEXIST')) {
      return managedCloneFailure(
        operation,
        display,
        `clone lock already exists at "${lockPath}"; another tevu command may be updating this clone, or the lock is stale and must be removed by the operator`,
      );
    }
    return managedCloneFailure(
      operation,
      display,
      `cannot create "${lockPath}": ${describeCause(cause)}`,
    );
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Builds the network environment for a git command: gh's own environment,
 * minus `SSH_ASKPASS` and every `GIT_*` name except the SSL/HTTP/proxy
 * settings a GitHub Enterprise Server host may need, then the fixed
 * isolated Git settings, overriding any variable of the same name.
 */
function networkGitEnvironment(
  parentEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const base = ghEnvironment(parentEnvironment);
  const stripped: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (name === 'SSH_ASKPASS') {
      continue;
    }
    if (name.startsWith('GIT_') && !KEPT_GIT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      continue;
    }
    stripped[name] = value;
  }
  return { ...stripped, ...ISOLATED_GIT_SETTINGS };
}

/** The reset-then-helper `-c` pair `gh auth setup-git` writes, scoped to one command. */
function credentialHelperArgs(host: string): string[] {
  return [
    '-c',
    `credential.https://${host}.helper=`,
    '-c',
    `credential.https://${host}.helper=!gh auth git-credential`,
  ];
}

function defaultRemoteUrl(repository: ParsedGitHubRepository): string {
  return `https://${repository.host}/${repository.owner}/${repository.repo}.git`;
}

function hostRuleReason(host: string): string {
  return `host "${host}" holds characters other than letters, digits, hyphens, and dots`;
}

function notAClonReason(directory: string): string {
  return `"${directory}" exists but is not a clone tevu made; remove it and run the command again`;
}

function isErrnoCode(cause: unknown, code: string): boolean {
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    (cause as { code: unknown }).code === code
  );
}

function managedCloneFailure(
  operation: ManagedCloneOperation,
  repository: string,
  reason: string,
): TevuResult<never, 'ManagedCloneError'> {
  return { ok: false, error: { kind: 'ManagedCloneError', operation, repository, reason } };
}

function cancellationFailure(): TevuResult<never, 'CancellationError'> {
  return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
}
