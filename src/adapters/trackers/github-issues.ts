/**
 * Read-only, one-time GitHub issue and pull-request readers over the
 * operator's installed `gh`. tevu never talks to the GitHub API directly and
 * never reads, stores, or forwards a GitHub token; every credential decision
 * is gh's own.
 *
 * Entry points: {@link createGitHubIssuesAdapter}, {@link createGitHubPullRequestReader}.
 */

import { z } from 'zod';

import { describePath } from '@/domain/describe-path';
import { authenticationReason, ghEnvironment, stderrExcerpt } from '@/domain/github-cli';
import { parseGitHubReference } from '@/domain/github-reference';

import type { ParsedGitHubReference } from '@/domain/github-reference';
import type {
  IssueSnapshot,
  IssueTrackerAdapter,
  PullRequestCommit,
  PullRequestMergeability,
  PullRequestReader,
  PullRequestSnapshot,
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

const TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 3_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;

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
const PULL_REQUEST_DIFF_READ_FAILURE_REASON =
  'gh could not read the pull request diff (not found, no access, too large, or no connection)';

/** A full commit hash: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters. */
const COMMIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const issueResponseSchema = z.looseObject({
  number: z.number().int().min(1),
  title: z.string(),
  body: z.string(),
  url: z.string(),
});

const commitHashSchema = z.string().regex(COMMIT_HASH_PATTERN);

const commitsSchema = z.looseObject({
  totalCount: z.number().int().min(0),
  nodes: z.array(
    z.looseObject({
      commit: z.looseObject({
        oid: commitHashSchema,
        parents: z
          .looseObject({
            totalCount: z.number(),
            nodes: z.array(z.looseObject({ oid: commitHashSchema })),
          })
          .refine((parents) => parents.totalCount === parents.nodes.length, { path: ['nodes'] }),
      }),
    }),
  ),
});

/** The pull request of one page; lenient fields stay unchecked and every other unknown field is tolerated. */
function pageSchemaOf<T extends z.ZodType>(pullRequest: T) {
  return z.looseObject({
    data: z.looseObject({ repository: z.looseObject({ pullRequest }) }),
  });
}

const firstPageSchema = pageSchemaOf(
  z.looseObject({
    number: z.number().int().min(1),
    url: z.string(),
    state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    headRefOid: commitHashSchema,
    baseRefName: z.string().min(1),
    baseRef: z.looseObject({ target: z.looseObject({ oid: commitHashSchema }) }).nullable(),
    mergeCommit: z.looseObject({ oid: commitHashSchema }).nullable(),
    mergeable: z.unknown().optional(),
    commits: commitsSchema,
  }),
);

const laterPageSchema = pageSchemaOf(
  z.looseObject({ headRefOid: z.unknown().optional(), commits: commitsSchema }),
);

const pagesSchema = z.tuple([firstPageSchema], laterPageSchema);

const PULL_REQUEST_STATES = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' } as const;

const PAGE_PULL_REQUEST_PATH: readonly PropertyKey[] = ['data', 'repository', 'pullRequest'];

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

/** Outcome of one `gh` invocation made on behalf of a pull-request read, before its caller's own success handling. */
type PullRequestGhOutcome =
  | { kind: 'cancelled' }
  | { kind: 'failure'; reason: string }
  | { kind: 'exit-one'; stderrText: string }
  | { kind: 'success'; stdout: GhCapture };

/**
 * Runs one `gh` invocation under the pull-request reader's shared timeout,
 * termination grace, and capture bound, mapping every outcome but a
 * successful exit and an exit-1 failure, which each caller decodes for its
 * own read.
 */
async function runPullRequestGh(
  argv: [string, ...string[]],
  parsed: ParsedGitHubReference,
  dependencies: GitHubIssuesDependencies,
): Promise<PullRequestGhOutcome> {
  if (dependencies.cancellation.aborted) {
    return { kind: 'cancelled' };
  }

  const result = await dependencies.runGh({
    argv,
    environment: ghEnvironment(dependencies.parentEnvironment),
    timeoutMs: TIMEOUT_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    maxCaptureBytes: MAX_CAPTURE_BYTES,
    cancellation: dependencies.cancellation,
  });

  if (dependencies.cancellation.aborted || (result.launched && result.cancelled)) {
    return { kind: 'cancelled' };
  }
  if (!result.launched) {
    return {
      kind: 'failure',
      reason:
        result.code === 'ENOENT'
          ? 'GitHub CLI (gh) is not installed or not on PATH; install it from https://cli.github.com or enter a commit reference instead'
          : `GitHub CLI (gh) could not be started: ${result.code ?? result.reason}`,
    };
  }
  if (result.timedOut) {
    return { kind: 'failure', reason: `gh did not respond within ${TIMEOUT_MS / 1000} seconds` };
  }

  switch (result.exitCode) {
    case 0:
      return { kind: 'success', stdout: result.stdout };
    case 4:
      return { kind: 'failure', reason: authenticationReason(parsed.host) };
    case 1:
      return { kind: 'exit-one', stderrText: result.stderr.text };
    case 2:
      return { kind: 'failure', reason: 'read cancelled (gh exited with code 2)' };
    default:
      return {
        kind: 'failure',
        reason: withExcerptSuffix(
          unexpectedExitReason(result.exitCode, result.signal),
          result.stderr.text,
        ),
      };
  }
}

/** Parses and rejects `input` exactly as `readPullRequest` and `readPullRequestDiff` both require. */
function parsePullRequestReference(
  input: string,
):
  | { ok: true; value: ParsedGitHubReference }
  | { ok: false; error: TevuResult<never, 'ReferenceResolutionError'> } {
  const reference = input.trim();
  const parsed = parseGitHubReference(reference);
  if (parsed === null) {
    return { ok: false, error: referenceFailure(PULL_REQUEST_MALFORMED_REFERENCE_REASON) };
  }
  if (parsed.path === 'issues') {
    return { ok: false, error: referenceFailure(ISSUE_REFERENCE_REASON) };
  }
  return { ok: true, value: parsed };
}

/**
 * Creates the read-only, one-time GitHub pull-request reader: one paginated
 * `gh api graphql` read of state, merge commit, target tip, mergeability, and
 * every commit with its parents, plus an on-demand unified-diff read.
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
      const parsed = parsePullRequestReference(input);
      if (!parsed.ok) {
        return parsed.error;
      }

      const outcome = await runPullRequestGh(
        [
          'gh',
          'api',
          'graphql',
          '--hostname',
          parsed.value.host,
          '--paginate',
          '--slurp',
          '-f',
          `query=${PULL_REQUEST_QUERY}`,
          '-f',
          `owner=${parsed.value.owner}`,
          '-f',
          `repo=${parsed.value.repo}`,
          '-F',
          `number=${parsed.value.number}`,
        ],
        parsed.value,
        dependencies,
      );

      if (outcome.kind === 'cancelled') {
        return cancellationFailure();
      }
      if (outcome.kind === 'failure') {
        return referenceFailure(outcome.reason);
      }
      if (outcome.kind === 'exit-one') {
        return referenceFailure(
          withExcerptSuffix(PULL_REQUEST_READ_FAILURE_REASON, outcome.stderrText),
        );
      }
      return decodePullRequestResponse(parsed.value, outcome.stdout);
    },

    async readPullRequestDiff(
      input: string,
    ): Promise<TevuResult<string, 'ReferenceResolutionError' | 'CancellationError'>> {
      const parsed = parsePullRequestReference(input);
      if (!parsed.ok) {
        return parsed.error;
      }

      const outcome = await runPullRequestGh(
        [
          'gh',
          'api',
          '--hostname',
          parsed.value.host,
          '-H',
          'Accept: application/vnd.github.diff',
          `repos/${parsed.value.owner}/${parsed.value.repo}/pulls/${String(parsed.value.number)}`,
        ],
        parsed.value,
        dependencies,
      );

      if (outcome.kind === 'cancelled') {
        return cancellationFailure();
      }
      if (outcome.kind === 'failure') {
        return referenceFailure(outcome.reason);
      }
      if (outcome.kind === 'exit-one') {
        return referenceFailure(
          withExcerptSuffix(PULL_REQUEST_DIFF_READ_FAILURE_REASON, outcome.stderrText),
        );
      }
      if (outcome.stdout.truncated) {
        return referenceFailure(`the pull request diff exceeds ${MAX_CAPTURE_BYTES} bytes`);
      }
      return { ok: true, value: outcome.stdout.text };
    },
  };
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

function pullRequestFieldError(name: string): TevuResult<never, 'ReferenceResolutionError'> {
  return referenceFailure(`unexpected response from gh: field "${name}" is missing or invalid`);
}

/**
 * Names the field of a page defect for the operator: the path inside the
 * page's pull request, or the pull request itself when the page does not hold
 * one.
 */
function pullRequestField(path: readonly PropertyKey[]): string {
  const rest = path.slice(1);
  const isWithinPullRequestPath =
    rest.length <= PAGE_PULL_REQUEST_PATH.length &&
    rest.every((segment, index) => segment === PAGE_PULL_REQUEST_PATH[index]);
  return isWithinPullRequestPath
    ? PAGE_PULL_REQUEST_PATH.join('.')
    : describePath(rest.slice(PAGE_PULL_REQUEST_PATH.length));
}

type PullRequestPages = z.output<typeof pagesSchema>;

/** Reads gh's `api graphql --paginate --slurp` output as the pages of one pull request. */
function readPullRequestPages(
  stdout: GhCapture,
): TevuResult<PullRequestPages, 'ReferenceResolutionError'> {
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
  const pages = pagesSchema.safeParse(value);
  if (!pages.success) {
    const firstIssue = pages.error.issues[0];
    return pullRequestFieldError(
      firstIssue === undefined ? '(root)' : pullRequestField(firstIssue.path),
    );
  }
  return { ok: true, value: pages.data };
}

/** Joins every page's commits and refuses a pull request that changed between pages or lists fewer commits than it has. */
function collectCommits(
  key: string,
  pages: PullRequestPages,
): TevuResult<PullRequestCommit[], 'ReferenceResolutionError'> {
  const [firstPage, ...laterPages] = pages;
  const first = firstPage.data.repository.pullRequest;
  const connections = [first.commits];
  for (const page of laterPages) {
    const { headRefOid, commits } = page.data.repository.pullRequest;
    if (commits.totalCount !== first.commits.totalCount || headRefOid !== first.headRefOid) {
      return referenceFailure(`pull request ${key} changed while tevu read it; enter it again`);
    }
    connections.push(commits);
  }
  const commits = connections.flatMap((connection) =>
    connection.nodes.map(({ commit }) => ({
      hash: commit.oid,
      parents: commit.parents.nodes.map((parent) => parent.oid),
    })),
  );
  if (commits.length !== first.commits.totalCount) {
    return referenceFailure(
      `GitHub returned ${commits.length} of the ${first.commits.totalCount} commits of pull request ${key} and lists at most 250; tevu records a pull request only with its complete commit list`,
    );
  }
  return { ok: true, value: commits };
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
  const pages = readPullRequestPages(stdout);
  if (!pages.ok) {
    return pages;
  }
  const first = pages.value[0].data.repository.pullRequest;
  if (first.number !== parsed.number) {
    return pullRequestFieldError('number');
  }
  const target = parseIssueUrlOnHost(first.url, parsed.host);
  if (target === null || target.number !== first.number) {
    return referenceFailure(
      `unexpected response from gh: field "url" is not a pull request URL on ${parsed.host}`,
    );
  }
  if (target.path === 'issues') {
    return referenceFailure(ISSUE_REFERENCE_REASON);
  }

  const key = `${target.owner}/${target.repo}#${first.number}`;
  if (first.commits.totalCount === 0) {
    return referenceFailure(`pull request ${key} has no commits`);
  }
  const commits = collectCommits(key, pages.value);
  if (!commits.ok) {
    return commits;
  }
  if (!commits.value.some((commit) => commit.hash === first.headRefOid)) {
    return pullRequestFieldError('headRefOid');
  }

  return {
    ok: true,
    value: {
      key,
      url: first.url,
      state: PULL_REQUEST_STATES[first.state],
      targetBranch: first.baseRefName,
      targetTip: first.baseRef === null ? null : first.baseRef.target.oid,
      headCommit: first.headRefOid,
      mergeCommit:
        first.state === 'MERGED' && first.mergeCommit !== null ? first.mergeCommit.oid : null,
      mergeability: decodeMergeability(first.mergeable),
      commits: commits.value,
    },
  };
}

function referenceFailure(reason: string): TevuResult<never, 'ReferenceResolutionError'> {
  return { ok: false, error: { kind: 'ReferenceResolutionError', reason } };
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
  const issue = issueResponseSchema.safeParse(value);
  if (!issue.success) {
    const firstIssue = issue.error.issues[0];
    return firstIssue === undefined || firstIssue.path.length === 0
      ? decodeError(reference, 'output is not a JSON object')
      : decodeError(reference, `field "${describePath(firstIssue.path)}" is missing or invalid`);
  }
  const { number, title, body, url } = issue.data;

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

function withExcerptSuffix(reason: string, stderrText: string): string {
  const text = stderrExcerpt(stderrText);
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
