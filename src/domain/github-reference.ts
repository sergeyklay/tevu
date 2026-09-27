/**
 * GitHub short-form and URL reference grammar, shared by every reader that
 * accepts a GitHub issue or pull-request reference from an operator, and the
 * GitHub repository entry grammar a repository declaration accepts in place
 * of a local path.
 *
 * Entry points: {@link parseGitHubReference}, {@link parseGitHubRepository}.
 */

const OWNER_PATTERN = '[A-Za-z0-9][A-Za-z0-9_-]{0,99}';
const REPO_PATTERN = '[A-Za-z0-9._-]{1,100}';
const SHORT_FORM_PATTERN = new RegExp(`^(${OWNER_PATTERN})\\/(${REPO_PATTERN})#([1-9][0-9]*)$`);
const REFERENCE_PATH_PATTERN = new RegExp(
  `^\\/(${OWNER_PATTERN})\\/(${REPO_PATTERN})\\/(issues|pull)\\/([1-9][0-9]*)$`,
);
const MAX_REFERENCE_NUMBER = 2_147_483_647;

const OWNER_ONLY_PATTERN = new RegExp(`^${OWNER_PATTERN}$`);
const REPO_ONLY_PATTERN = new RegExp(`^${REPO_PATTERN}$`);
const PLAIN_HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const TRAILING_DOT_GIT_PATTERN = /\.git$/;

/** A GitHub reference, parsed into the parts every reader needs. */
export type ParsedGitHubReference = {
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** `issues` or `pull` for a URL; absent for the short form `OWNER/REPO#NUMBER`. */
  path?: 'issues' | 'pull';
};

/**
 * Parses `OWNER/REPO#NUMBER` on `github.com`, or an `https:` issue or
 * pull-request URL without user info or a port, an optional trailing `/`,
 * ignoring any query and fragment.
 *
 * Returns `null` when `text` matches neither grammar. Pure: performs no I/O
 * and reads no clock.
 */
export function parseGitHubReference(text: string): ParsedGitHubReference | null {
  const shortForm = SHORT_FORM_PATTERN.exec(text);
  if (shortForm !== null) {
    const [, owner, repo, numberText] = shortForm;
    if (isReservedRepoName(repo)) {
      return null;
    }
    const number = toReferenceNumber(numberText);
    return number === null ? null : { host: 'github.com', owner, repo, number };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return null;
  }
  const parsed = parseReferencePath(url.pathname);
  return parsed === null ? null : { host: url.hostname, ...parsed };
}

type ReferencePath = { owner: string; repo: string; number: number; path: 'issues' | 'pull' };

function parseReferencePath(pathname: string): ReferencePath | null {
  const path = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const match = REFERENCE_PATH_PATTERN.exec(path);
  if (match === null) {
    return null;
  }
  const [, owner, repo, kind, numberText] = match;
  if (isReservedRepoName(repo)) {
    return null;
  }
  const number = toReferenceNumber(numberText);
  return number === null ? null : { owner, repo, number, path: kind as 'issues' | 'pull' };
}

function isReservedRepoName(repo: string): boolean {
  return repo === '.' || repo === '..';
}

function toReferenceNumber(numberText: string): number | null {
  const value = Number.parseInt(numberText, 10);
  return value <= MAX_REFERENCE_NUMBER ? value : null;
}

/** A GitHub repository, parsed into the parts a managed clone needs. */
export type ParsedGitHubRepository = { host: string; owner: string; repo: string };

/**
 * Reports whether `host` holds only letters, digits, hyphens, and dots.
 *
 * A host that fails this rule cannot become part of a git credential-helper
 * configuration key (`credential.https://<host>.helper`), where `=`, `!`,
 * `;`, and `$` would be misinterpreted; an IPv6-literal host, which is
 * bracketed and colon-separated, always fails.
 */
export function isPlainHost(host: string): boolean {
  return PLAIN_HOST_PATTERN.test(host);
}

/**
 * Parses `OWNER/REPO` on `github.com`, or an `https:` repository URL naming
 * `/OWNER/REPO` on any host that passes {@link isPlainHost}.
 *
 * Rejects leading or trailing whitespace, user info, a port, a query, or a
 * fragment. One trailing `.git` is stripped from `REPO` before the REPO
 * grammar applies. Returns `null` when `text` matches neither grammar. Pure:
 * performs no I/O and reads no clock.
 */
export function parseGitHubRepository(text: string): ParsedGitHubRepository | null {
  if (text !== text.trim()) {
    return null;
  }
  return parseRepositoryShortForm(text) ?? parseRepositoryUrl(text);
}

/** Display form: `<host>/<owner>/<repo>`, owner and repository as written. */
export function formatGitHubRepository(repository: ParsedGitHubRepository): string {
  return `${repository.host}/${repository.owner}/${repository.repo}`;
}

/** Managed-clone directory suffix, relative to the managed-clone root, with every part lowercased. */
export function managedCloneLocation(repository: ParsedGitHubRepository): string {
  return `${repository.host.toLowerCase()}/${repository.owner.toLowerCase()}/${repository.repo.toLowerCase()}.git`;
}

function parseRepositoryShortForm(text: string): ParsedGitHubRepository | null {
  const slashIndex = text.indexOf('/');
  if (slashIndex <= 0) {
    return null;
  }
  const owner = text.slice(0, slashIndex);
  const rest = text.slice(slashIndex + 1);
  if (rest.length === 0 || rest.includes('/')) {
    return null;
  }
  const repo = parseRepoSegment(rest);
  return OWNER_ONLY_PATTERN.test(owner) && repo !== null
    ? { host: 'github.com', owner, repo }
    : null;
}

function parseRepositoryUrl(text: string): ParsedGitHubRepository | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!isPlainHost(host)) {
    return null;
  }
  const pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  const segments = pathname.startsWith('/') ? pathname.slice(1).split('/') : null;
  if (segments === null || segments.length !== 2) {
    return null;
  }
  const [owner, rawRepo] = segments;
  const repo = parseRepoSegment(rawRepo);
  return OWNER_ONLY_PATTERN.test(owner) && repo !== null ? { host, owner, repo } : null;
}

/** Strips one trailing `.git`, then validates the result against the REPO grammar. */
function parseRepoSegment(rawRepo: string): string | null {
  const repo = rawRepo.replace(TRAILING_DOT_GIT_PATTERN, '');
  return REPO_ONLY_PATTERN.test(repo) && !isReservedRepoName(repo) ? repo : null;
}
