/**
 * Read-only, one-time GitHub issue and pull-request readers over the
 * operator's installed `gh`. tevu never talks to the GitHub API directly and
 * never reads, stores, or forwards a GitHub token; every credential decision
 * is gh's own.
 *
 * Entry points: {@link createGitHubIssuesAdapter}, {@link createGitHubPullRequestReader}.
 */

import { parseGitHubReference } from '@/domain/github-reference';

import type { ParsedGitHubReference } from '@/domain/github-reference';
import type {
  IssueSnapshot,
  IssueTrackerAdapter,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestReader,
  PullRequestSnapshot,
  PullRequestState,
  TevuResult,
} from '@/domain/types';

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

const PULL_REQUEST_MALFORMED_REFERENCE_REASON =
  'reference must be OWNER/REPO#NUMBER or https://HOST/OWNER/REPO/pull/NUMBER';
const ISSUE_REFERENCE_REASON = 'the reference points to an issue, not a pull request';
const PULL_REQUEST_READ_FAILURE_REASON =
  'gh could not read the pull request (not found, no access, or no connection)';

/** A full commit hash: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters. */
const COMMIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Selection set the pull-request reader depends on; every page repeats the full pull request object. */
const PULL_REQUEST_QUERY = `query($owner: String!, $repo: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number url state headRefOid baseRefName mergeable
      baseRef { target { oid } }
      mergeCommit { oid }
      commits(first: 100, after: $endCursor) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes { commit { oid parents(first: 100) { totalCount nodes { oid } } } }
      }
    }
  }
}`;

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
      const parsed = parseGitHubReference(reference);
      if (parsed === null) {
        return trackerError(reference, MALFORMED_REFERENCE_REASON);
      }
      if (parsed.path === 'pull') {
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

/**
 * Creates the read-only, one-time GitHub pull-request reader: one paginated
 * `gh api graphql` read of state, merge commit, target tip, mergeability, and
 * every commit with its parents.
 *
 * Calls `runGh` at most once per read: never for a malformed reference, an
 * issue reference, or a signal already aborted before launch. Issues no Git
 * command.
 */
export function createGitHubPullRequestReader(
  dependencies: GitHubIssuesDependencies,
): PullRequestReader {
  return {
    async readPullRequest(
      input: string,
    ): Promise<TevuResult<PullRequestSnapshot, 'ReferenceResolutionError' | 'CancellationError'>> {
      const reference = input.trim();
      const parsed = parseGitHubReference(reference);
      if (parsed === null) {
        return referenceFailure(PULL_REQUEST_MALFORMED_REFERENCE_REASON);
      }
      if (parsed.path === 'issues') {
        return referenceFailure(ISSUE_REFERENCE_REASON);
      }
      if (dependencies.cancellation.aborted) {
        return cancellationFailure();
      }

      const result = await dependencies.runGh({
        argv: [
          'gh',
          'api',
          'graphql',
          '--hostname',
          parsed.host,
          '--paginate',
          '--slurp',
          '-f',
          `query=${PULL_REQUEST_QUERY}`,
          '-f',
          `owner=${parsed.owner}`,
          '-f',
          `repo=${parsed.repo}`,
          '-F',
          `number=${parsed.number}`,
        ],
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
          ? referenceFailure(
              'GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com or enter a commit reference instead',
            )
          : referenceFailure(
              `GitHub CLI (gh) could not be started: ${result.code ?? result.reason}`,
            );
      }
      if (result.timedOut) {
        return referenceFailure(`gh did not respond within ${TIMEOUT_MS / 1000} seconds`);
      }

      switch (result.exitCode) {
        case 0:
          return decodePullRequestResponse(parsed, result.stdout);
        case 4:
          return referenceFailure(authenticationReason(parsed.host));
        case 1:
          return referenceFailure(
            withExcerptSuffix(PULL_REQUEST_READ_FAILURE_REASON, result.stderr.text),
          );
        case 2:
          return referenceFailure('read cancelled (gh exited with code 2)');
        default:
          return referenceFailure(
            withExcerptSuffix(
              unexpectedExitReason(result.exitCode, result.signal),
              result.stderr.text,
            ),
          );
      }
    },
  };
}

/** Sentinel a private decoder returns in place of throwing when a field breaks its rule. */
const INVALID_PULL_REQUEST_FIELD = Symbol('invalid-pull-request-field');

function isCommitHash(value: unknown): value is string {
  return typeof value === 'string' && COMMIT_HASH_PATTERN.test(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads `data.repository.pullRequest` from one decoded page, or `null` when the shape is wrong. */
function extractPullRequestObject(page: unknown): Record<string, unknown> | null {
  const pageRecord = asRecord(page);
  const data = pageRecord === null ? null : asRecord(pageRecord['data']);
  const repository = data === null ? null : asRecord(data['repository']);
  const pullRequest = repository === null ? null : asRecord(repository['pullRequest']);
  return pullRequest;
}

function decodePullRequestState(value: unknown): PullRequestState | null {
  if (value === 'OPEN') {
    return 'open';
  }
  if (value === 'CLOSED') {
    return 'closed';
  }
  if (value === 'MERGED') {
    return 'merged';
  }
  return null;
}

function decodeMergeability(value: unknown): PullRequestMergeability {
  if (value === 'MERGEABLE') {
    return 'mergeable';
  }
  if (value === 'CONFLICTING') {
    return 'conflicting';
  }
  return 'unknown';
}

/** Decodes `baseRef.target.oid`; `null` when GitHub reports no target (the branch was deleted). */
function decodeTargetTip(value: unknown): string | null | typeof INVALID_PULL_REQUEST_FIELD {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  const target = record === null ? null : asRecord(record['target']);
  const oid = target === null ? undefined : target['oid'];
  return isCommitHash(oid) ? oid : INVALID_PULL_REQUEST_FIELD;
}

/** Decodes `mergeCommit.oid`; kept only when `state` is `merged`, per the field contract. */
function decodeMergeCommitOid(
  value: unknown,
  state: PullRequestState,
): string | null | typeof INVALID_PULL_REQUEST_FIELD {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  const oid = record === null ? undefined : record['oid'];
  if (!isCommitHash(oid)) {
    return INVALID_PULL_REQUEST_FIELD;
  }
  return state === 'merged' ? oid : null;
}

/** Reads one page's `commits.totalCount` and raw `nodes` array without decoding the nodes yet. */
function readCommitsConnection(
  pullRequest: Record<string, unknown>,
): { totalCount: number; nodes: unknown[] } | typeof INVALID_PULL_REQUEST_FIELD {
  const commits = asRecord(pullRequest['commits']);
  if (commits === null) {
    return INVALID_PULL_REQUEST_FIELD;
  }
  const totalCount = commits['totalCount'];
  const nodes = commits['nodes'];
  if (
    typeof totalCount !== 'number' ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 0 ||
    !Array.isArray(nodes)
  ) {
    return INVALID_PULL_REQUEST_FIELD;
  }
  return { totalCount, nodes };
}

function decodeCommitNode(node: unknown): PullRequestCommit | typeof INVALID_PULL_REQUEST_FIELD {
  const nodeRecord = asRecord(node);
  const commit = nodeRecord === null ? null : asRecord(nodeRecord['commit']);
  if (commit === null) {
    return INVALID_PULL_REQUEST_FIELD;
  }
  const oid = commit['oid'];
  if (!isCommitHash(oid)) {
    return INVALID_PULL_REQUEST_FIELD;
  }
  const parents = asRecord(commit['parents']);
  if (parents === null) {
    return INVALID_PULL_REQUEST_FIELD;
  }
  const totalCount = parents['totalCount'];
  const parentNodes = parents['nodes'];
  if (
    typeof totalCount !== 'number' ||
    !Array.isArray(parentNodes) ||
    parentNodes.length !== totalCount
  ) {
    return INVALID_PULL_REQUEST_FIELD;
  }
  const parentHashes: string[] = [];
  for (const parentNode of parentNodes) {
    const parentRecord = asRecord(parentNode);
    const parentOid = parentRecord === null ? undefined : parentRecord['oid'];
    if (!isCommitHash(parentOid)) {
      return INVALID_PULL_REQUEST_FIELD;
    }
    parentHashes.push(parentOid);
  }
  return { hash: oid, parents: parentHashes };
}

function pullRequestFieldError(name: string): TevuResult<never, 'ReferenceResolutionError'> {
  return referenceFailure(`unexpected response from gh: field "${name}" is missing or invalid`);
}

/**
 * Decodes and validates gh's successful `api graphql --paginate --slurp`
 * output against the field contract of the GraphQL selection set, checking
 * E-NO-COMMITS, then E-TRUNCATED, then that the head commit is listed.
 */
function decodePullRequestResponse(
  parsed: ParsedGitHubReference,
  stdout: GhCapture,
): TevuResult<PullRequestSnapshot, 'ReferenceResolutionError'> {
  if (stdout.truncated) {
    return referenceFailure(
      `unexpected response from gh: output exceeds ${MAX_CAPTURE_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout.text);
  } catch {
    return referenceFailure('unexpected response from gh: output is not valid JSON');
  }
  if (!Array.isArray(value) || value.length === 0) {
    return referenceFailure(
      'unexpected response from gh: output is not a non-empty JSON array of pages',
    );
  }

  const pullRequestObjects: Record<string, unknown>[] = [];
  for (const page of value) {
    const pullRequest = extractPullRequestObject(page);
    if (pullRequest === null) {
      return pullRequestFieldError('data.repository.pullRequest');
    }
    pullRequestObjects.push(pullRequest);
  }
  const first = pullRequestObjects[0];
  if (first === undefined) {
    return referenceFailure(
      'unexpected response from gh: output is not a non-empty JSON array of pages',
    );
  }

  const number = first['number'];
  if (
    typeof number !== 'number' ||
    !Number.isSafeInteger(number) ||
    number <= 0 ||
    number !== parsed.number
  ) {
    return pullRequestFieldError('number');
  }
  const url = first['url'];
  if (typeof url !== 'string') {
    return pullRequestFieldError('url');
  }
  const target = parseIssueUrlOnHost(url, parsed.host);
  if (target === null || target.number !== number) {
    return referenceFailure(
      `unexpected response from gh: field "url" is not a pull request URL on ${parsed.host}`,
    );
  }
  if (target.path === 'issues') {
    return referenceFailure(ISSUE_REFERENCE_REASON);
  }

  const state = decodePullRequestState(first['state']);
  if (state === null) {
    return pullRequestFieldError('state');
  }
  const headRefOid = first['headRefOid'];
  if (!isCommitHash(headRefOid)) {
    return pullRequestFieldError('headRefOid');
  }
  const baseRefName = first['baseRefName'];
  if (typeof baseRefName !== 'string' || baseRefName.length === 0) {
    return pullRequestFieldError('baseRefName');
  }
  const targetTip = decodeTargetTip(first['baseRef']);
  if (targetTip === INVALID_PULL_REQUEST_FIELD) {
    return pullRequestFieldError('baseRef');
  }
  const mergeCommitOid = decodeMergeCommitOid(first['mergeCommit'], state);
  if (mergeCommitOid === INVALID_PULL_REQUEST_FIELD) {
    return pullRequestFieldError('mergeCommit');
  }
  const mergeability = decodeMergeability(first['mergeable']);
  const firstConnection = readCommitsConnection(first);
  if (firstConnection === INVALID_PULL_REQUEST_FIELD) {
    return pullRequestFieldError('commits.totalCount');
  }
  const { totalCount } = firstConnection;

  const key = `${target.owner}/${target.repo}#${number}`;
  if (totalCount === 0) {
    return referenceFailure(`pull request ${key} has no commits`);
  }

  const commits: PullRequestCommit[] = [];
  for (const [pageIndex, pullRequest] of pullRequestObjects.entries()) {
    const connection = pageIndex === 0 ? firstConnection : readCommitsConnection(pullRequest);
    if (connection === INVALID_PULL_REQUEST_FIELD) {
      return pullRequestFieldError('commits.totalCount');
    }
    if (
      pageIndex > 0 &&
      (connection.totalCount !== totalCount || pullRequest['headRefOid'] !== headRefOid)
    ) {
      return referenceFailure(`pull request ${key} changed while tevu read it; enter it again`);
    }
    for (const node of connection.nodes) {
      const commit = decodeCommitNode(node);
      if (commit === INVALID_PULL_REQUEST_FIELD) {
        return pullRequestFieldError('commits.nodes');
      }
      commits.push(commit);
    }
  }

  if (commits.length !== totalCount) {
    return referenceFailure(
      `GitHub returned ${commits.length} of the ${totalCount} commits of pull request ${key} and lists at most 250; tevu records a pull request only with its complete commit list`,
    );
  }
  if (!commits.some((commit) => commit.hash === headRefOid)) {
    return pullRequestFieldError('headRefOid');
  }

  return {
    ok: true,
    value: {
      key,
      url,
      state,
      targetBranch: baseRefName,
      targetTip,
      headCommit: headRefOid,
      mergeCommit: mergeCommitOid,
      mergeability,
      commits,
    },
  };
}

function referenceFailure(reason: string): TevuResult<never, 'ReferenceResolutionError'> {
  return { ok: false, error: { kind: 'ReferenceResolutionError', reason } };
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

/** Builds gh's canonical issue URL from a parsed reference, always under the `issues` path. */
function canonicalIssueUrl(parsed: ParsedGitHubReference): string {
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`;
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
  if (target.path === 'pull') {
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

/**
 * Parses gh's decoded `url` field, requiring it to name an issue or pull
 * request on `host` exactly: this module's own host, scheme, user-info, port,
 * query, and fragment checks, with the path segments read through
 * {@link parseGitHubReference}.
 */
function parseIssueUrlOnHost(urlText: string, host: string): ParsedGitHubReference | null {
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
  return parseGitHubReference(urlText);
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
