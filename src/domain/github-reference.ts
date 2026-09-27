/**
 * GitHub short-form and URL reference grammar, shared by every reader that
 * accepts a GitHub issue or pull-request reference from an operator.
 *
 * Entry point: {@link parseGitHubReference}.
 */

const SHORT_FORM_PATTERN =
  /^([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([A-Za-z0-9._-]{1,100})#([1-9][0-9]*)$/;
const REFERENCE_PATH_PATTERN =
  /^\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/([1-9][0-9]*)$/;
const MAX_REFERENCE_NUMBER = 2_147_483_647;

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
