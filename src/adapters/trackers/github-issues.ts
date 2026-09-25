/**
 * Read-only, one-time GitHub issue importer over the operator's installed
 * `gh`. tevu never talks to the GitHub API directly and never reads, stores,
 * or forwards a GitHub token; every credential decision is gh's own.
 *
 * Entry point: {@link createGitHubIssuesAdapter}.
 */

import type { IssueSnapshot, IssueTrackerAdapter, TevuResult } from '@/domain/types';

/** Literal-argv `gh` invocation request; a subset of the process adapter's own request shape. */
export type GhRunRequest = {
  argv: [string, ...string[]];
  environment: Record<string, string>;
  timeoutMs: number;
  terminationGraceMs: number;
  maxCaptureBytes: number;
  cancellation: AbortSignal;
};

/** One bounded, possibly truncated output stream captured from `gh`. */
export type GhCapture = { text: string; truncated: boolean };

/** Outcome of one `gh` invocation; launch failure is evidence, not an exception. */
export type GhRunResult =
  | { launched: false; code?: string; reason: string }
  | {
      launched: true;
      exitCode: number | null;
      signal: string | null;
      timedOut: boolean;
      cancelled: boolean;
      stdout: GhCapture;
      stderr: GhCapture;
    };

/** Injected `gh` launcher: stdout arrives unredacted, stderr after value-based secret redaction. */
export type GhRun = (request: GhRunRequest) => Promise<GhRunResult>;

/** Effects injected into the GitHub issue importer. */
export type GitHubIssuesDependencies = {
  runGh: GhRun;
  /** Operator environment that gh inherits; values pass through and are never recorded. */
  parentEnvironment: Readonly<Record<string, string | undefined>>;
  cancellation: AbortSignal;
};

/** Token variables gh 2.86.0 reads (`gh help environment`); registered as secrets before every import. */
export const GH_CREDENTIAL_ENVIRONMENT_VARIABLES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

const TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 3_000;
const MAX_CAPTURE_BYTES = 1_048_576;
const EXCERPT_MAX_CODE_POINTS = 200;

const MALFORMED_REFERENCE_REASON =
  'reference must be OWNER/REPO#NUMBER or https://HOST/OWNER/REPO/issues/NUMBER';
const PULL_REQUEST_REASON = 'the reference points to a pull request, not an issue';
const GH_READ_FAILURE_REASON =
  'gh could not read the issue (not found, no access, or no connection)';

const MAX_ISSUE_NUMBER = 2_147_483_647;

const SHORT_FORM_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]*)$/;
const ISSUE_PATH_PATTERN =
  /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/([1-9][0-9]*)$/;

/** Environment variables gh 2.86.0 must never see, per gh's own documented behavior. */
const GH_ENVIRONMENT_EXCLUSIONS = new Set([
  'CLICOLOR_FORCE',
  'GH_FORCE_TTY',
  'GH_DEBUG',
  'DEBUG',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

/** GitHub token shapes masked from a stderr excerpt before line selection and truncation. */
const TOKEN_SHAPE_PATTERN = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g;

/** Repository path segment parsed out of a short-form reference or an issue URL. */
type IssuePath = { owner: string; repo: string; kind: 'issues' | 'pull'; number: number };

/** Fully parsed reference, including the host the short form implies. */
type ParsedReference = IssuePath & { host: string };

/**
 * Creates the read-only, one-time GitHub issue importer.
 *
 * Calls `runGh` at most once per import: never for a malformed reference, a
 * pull-request reference, or a signal already aborted before launch. Reads no
 * clock and no process global; every effect arrives through
 * {@link GitHubIssuesDependencies}.
 */
export function createGitHubIssuesAdapter(
  dependencies: GitHubIssuesDependencies,
): IssueTrackerAdapter {
  return {
    async readIssue(
      input: string,
    ): Promise<TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>> {
      const reference = input.trim();
      const parsed = parseReference(reference);
      if (parsed === null) {
        return trackerError(reference, MALFORMED_REFERENCE_REASON);
      }
      if (parsed.kind === 'pull') {
        return trackerError(reference, PULL_REQUEST_REASON);
      }
      if (dependencies.cancellation.aborted) {
        return cancellationFailure();
      }

      const result = await dependencies.runGh({
        argv: ['gh', 'issue', 'view', canonicalIssueUrl(parsed), '--json', 'number,title,body,url'],
        environment: ghEnvironment(dependencies.parentEnvironment),
        timeoutMs: TIMEOUT_MS,
        terminationGraceMs: TERMINATION_GRACE_MS,
        maxCaptureBytes: MAX_CAPTURE_BYTES,
        cancellation: dependencies.cancellation,
      });

      if (dependencies.cancellation.aborted || (result.launched && result.cancelled)) {
        return cancellationFailure();
      }
      if (!result.launched) {
        return result.code === 'ENOENT'
          ? trackerError(
              reference,
              'GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com or enter the task manually',
            )
          : trackerError(
              reference,
              `GitHub CLI (gh) could not be started: ${result.code ?? result.reason}`,
            );
      }
      if (result.timedOut) {
        return trackerError(reference, `gh did not respond within ${TIMEOUT_MS / 1000} seconds`);
      }

      switch (result.exitCode) {
        case 0:
          return decodeResponse(reference, parsed.host, result.stdout);
        case 4:
          return trackerError(reference, authenticationReason(parsed.host));
        case 1:
          return trackerError(
            reference,
            withExcerptSuffix(GH_READ_FAILURE_REASON, result.stderr.text),
          );
        case 2:
          return trackerError(reference, 'import cancelled (gh exited with code 2)');
        default:
          return trackerError(
            reference,
            withExcerptSuffix(
              unexpectedExitReason(result.exitCode, result.signal),
              result.stderr.text,
            ),
          );
      }
    },
  };
}

function authenticationReason(host: string): string {
  return host === 'github.com'
    ? 'gh is not authenticated; run gh auth login'
    : `gh is not authenticated for ${host}; run gh auth login --hostname ${host}`;
}

function unexpectedExitReason(exitCode: number | null, signal: string | null): string {
  return exitCode !== null
    ? `gh exited unexpectedly (exit code ${exitCode})`
    : `gh exited unexpectedly (signal ${signal ?? 'unknown'})`;
}

/** Parses the short form `OWNER/REPO#NUMBER` or an issue/pull-request URL; returns `null` when malformed. */
function parseReference(reference: string): ParsedReference | null {
  const shortForm = SHORT_FORM_PATTERN.exec(reference);
  if (shortForm !== null) {
    const [, owner, repo, numberText] = shortForm;
    if (isReservedRepoName(repo)) {
      return null;
    }
    const number = toIssueNumber(numberText);
    return number === null ? null : { host: 'github.com', owner, repo, kind: 'issues', number };
  }

  let url: URL;
  try {
    url = new URL(reference);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }
  const path = parseIssuePath(url.pathname);
  return path === null ? null : { host: url.hostname, ...path };
}

/** Builds gh's canonical issue URL from a parsed reference, always under the `issues` path. */
function canonicalIssueUrl(parsed: ParsedReference): string {
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
}

function parseIssuePath(pathname: string): IssuePath | null {
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const match = ISSUE_PATH_PATTERN.exec(path);
  if (match === null) {
    return null;
  }
  const [, owner, repo, kind, numberText] = match;
  if (isReservedRepoName(repo)) {
    return null;
  }
  const number = toIssueNumber(numberText);
  return number === null ? null : { owner, repo, kind: kind as 'issues' | 'pull', number };
}

function isReservedRepoName(repo: string): boolean {
  return repo === '.' || repo === '..';
}

function toIssueNumber(numberText: string): number | null {
  const value = Number.parseInt(numberText, 10);
  return value <= MAX_ISSUE_NUMBER ? value : null;
}

/**
 * Builds gh's complete replacement environment: every defined parent
 * variable except the excluded set, plus the fixed non-interactive settings
 * gh always receives.
 */
function ghEnvironment(
  parentEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnvironment)) {
    if (value !== undefined && !GH_ENVIRONMENT_EXCLUSIONS.has(name)) {
      environment[name] = value;
    }
  }
  environment['GH_PROMPT_DISABLED'] = '1';
  environment['GH_NO_UPDATE_NOTIFIER'] = '1';
  environment['NO_COLOR'] = '1';
  return environment;
}

/**
 * Validates gh's successful `issue view --json` output against the expected
 * shape and rejects a decoded pull-request URL as a pull request, not an
 * issue.
 */
function decodeResponse(
  reference: string,
  host: string,
  stdout: GhCapture,
): TevuResult<IssueSnapshot, 'IssueImportError'> {
  if (stdout.truncated) {
    return decodeError(reference, `output exceeds ${MAX_CAPTURE_BYTES} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout.text);
  } catch {
    return decodeError(reference, 'output is not valid JSON');
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return decodeError(reference, 'output is not a JSON object');
  }
  const record = value as Record<string, unknown>;

  const number = record['number'];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return decodeError(reference, 'field "number" is missing or not a positive integer');
  }
  const title = record['title'];
  if (typeof title !== 'string') {
    return decodeError(reference, 'field "title" is missing or not a string');
  }
  const body = record['body'];
  if (typeof body !== 'string') {
    return decodeError(reference, 'field "body" is missing or not a string');
  }
  const url = record['url'];
  if (typeof url !== 'string') {
    return decodeError(reference, 'field "url" is missing or not a string');
  }

  const target = parseIssueUrlOnHost(url, host);
  if (target === null || target.number !== number) {
    return decodeError(reference, `field "url" is not an issue URL on ${host}`);
  }
  if (target.kind === 'pull') {
    return trackerError(reference, PULL_REQUEST_REASON);
  }
  return {
    ok: true,
    value: {
      issueKey: `${target.owner}/${target.repo}#${number}`,
      issueUrl: url,
      summary: title,
      description: body,
    },
  };
}

function decodeError(reference: string, detail: string): TevuResult<never, 'IssueImportError'> {
  return trackerError(reference, `unexpected response from gh: ${detail}`);
}

/** Parses gh's decoded `url` field, requiring it to name an issue or pull request on `host` exactly. */
function parseIssueUrlOnHost(urlText: string, host: string): IssuePath | null {
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== host.toLowerCase() ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  return parseIssuePath(url.pathname);
}

/**
 * Masks every GitHub token shape in stderr, then returns the first non-empty
 * trimmed line, truncated to 200 code points. Masking runs before line
 * selection and truncation so no cut leaves a partial token the pattern no
 * longer matches.
 */
function excerpt(stderrText: string): string {
  const masked = stderrText.replace(TOKEN_SHAPE_PATTERN, '[REDACTED]');
  for (const line of masked.split('\n')) {
    const candidate = line.trim();
    if (candidate.length === 0) {
      continue;
    }
    const codePoints = [...candidate];
    return codePoints.length <= EXCERPT_MAX_CODE_POINTS
      ? candidate
      : `${codePoints.slice(0, EXCERPT_MAX_CODE_POINTS).join('')}...`;
  }
  return '';
}

function withExcerptSuffix(reason: string, stderrText: string): string {
  const text = excerpt(stderrText);
  return text.length === 0 ? reason : `${reason}: ${text}`;
}

function cancellationFailure(): TevuResult<never, 'CancellationError'> {
  return { ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } };
}

function trackerError(
  reference: string,
  reason: string,
): {
  ok: false;
  error: { kind: 'IssueImportError'; tracker: 'github-issue'; reference: string; reason: string };
} {
  return {
    ok: false,
    error: { kind: 'IssueImportError', tracker: 'github-issue', reference, reason },
  };
}
