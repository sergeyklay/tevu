/**
 * Derives the configuration IDs `tevu task add` writes, so the operator is
 * never asked to invent one. Every function is pure and total: no I/O, clock,
 * or randomness, and none throws.
 */

import { ID_MAX_LENGTH } from '@/config/schema';

import type { ParsedGitHubRepository } from '@/domain/github-reference';

/** What a local repository answer is named by, for its derived ID. */
export type LocalRepositoryNaming = {
  /** Last component of the answer resolved against the configuration file's directory; empty only for the filesystem root. */
  directoryName: string;
  /** First fetch URL of the repository's `origin` remote; absent when Git reports none. Never printed, logged, or saved. */
  originUrl?: string;
};

const NON_ID_CHARACTERS = /[^a-z0-9]+/g;
const EDGE_HYPHENS = /^-+|-+$/g;
const TRAILING_HYPHENS = /-+$/;
const TRAILING_SLASHES = /\/+$/;
const URL_SEGMENT = /^[A-Za-z0-9._-]+$/;
const LETTER_OR_DIGIT = /[A-Za-z0-9]/;

/** Derives the ID of a GitHub repository from its owner and name; the host is not part of it. */
export function deriveGitHubRepositoryId(
  repository: ParsedGitHubRepository,
  takenIds: ReadonlySet<string>,
): string {
  return uniqueId(normalizeId(`${repository.owner}-${repository.repo}`, 'repo'), takenIds);
}

/**
 * Derives the ID of a local repository from the owner and name of its
 * `origin` remote, or from its directory name when the remote yields none.
 */
export function deriveLocalRepositoryId(
  naming: LocalRepositoryNaming,
  takenIds: ReadonlySet<string>,
): string {
  const pair = naming.originUrl === undefined ? undefined : ownerAndName(naming.originUrl);
  const raw = pair === undefined ? naming.directoryName : `${pair.owner}-${pair.name}`;
  return uniqueId(normalizeId(raw, 'repo'), takenIds);
}

/** Derives the ID of a model entry from the last `/` segment of the model and the reasoning effort. */
export function deriveModelEntryId(
  model: `${string}/${string}`,
  effort: string,
  takenIds: ReadonlySet<string>,
): string {
  const name = model.slice(model.lastIndexOf('/') + 1);
  return uniqueId(normalizeId(`${name}-${effort}`, 'model'), takenIds);
}

/** Derives `task-{n}` with the smallest positive `n` whose whole ID is absent from `taskIds`. */
export function deriveTaskId(taskIds: ReadonlySet<string>): string {
  let number = 1;
  while (taskIds.has(`task-${String(number)}`)) {
    number += 1;
  }
  return `task-${String(number)}`;
}

/** Derives `acceptance-{n}` or `done-{n}` for a 1-based `position` in its collection. */
export function deriveCheckId(collection: 'acceptance' | 'done', position: number): string {
  return `${collection}-${String(position)}`;
}

function normalizeId(raw: string, fallbackWord: string): string {
  let text = raw.toLowerCase().replace(NON_ID_CHARACTERS, '-').replace(EDGE_HYPHENS, '');
  if (text === '') {
    text = fallbackWord;
  } else if (/^[0-9]/.test(text)) {
    text = `${fallbackWord}-${text}`;
  }
  return text.slice(0, ID_MAX_LENGTH).replace(TRAILING_HYPHENS, '');
}

function uniqueId(base: string, takenIds: ReadonlySet<string>): string {
  if (!takenIds.has(base)) {
    return base;
  }
  for (let number = 2; ; number += 1) {
    const suffix = `-${String(number)}`;
    const head = base.slice(0, ID_MAX_LENGTH - suffix.length).replace(TRAILING_HYPHENS, '');
    if (!takenIds.has(`${head}${suffix}`)) {
      return `${head}${suffix}`;
    }
  }
}

/**
 * Reads the last two path segments of a remote URL. `parseGitHubRepository`
 * is not reused because it rejects scp-like URLs and user info, the common
 * `origin` forms. Only segments that pass a conservative grammar are kept, so
 * a credential in the user info never reaches the result.
 */
function ownerAndName(url: string): { owner: string; name: string } | undefined {
  const path = remotePath(url.trim());
  if (path === undefined) {
    return undefined;
  }
  const segments = path
    .replace(TRAILING_SLASHES, '')
    .replace(/\.git$/, '')
    .split('/')
    .filter((segment) => segment !== '');
  const owner = segments.at(-2);
  const name = segments.at(-1);
  if (owner === undefined || name === undefined || !isUrlSegment(owner) || !isUrlSegment(name)) {
    return undefined;
  }
  return { owner, name };
}

function remotePath(text: string): string | undefined {
  const schemeEnd = text.indexOf('://');
  if (schemeEnd !== -1) {
    if (text.slice(0, schemeEnd).toLowerCase() === 'file') {
      return undefined;
    }
    const rest = text.slice(schemeEnd + 3);
    const pathStart = rest.indexOf('/');
    if (pathStart === -1) {
      return undefined;
    }
    return rest.slice(pathStart + 1).split(/[?#]/, 1)[0];
  }
  // Git recognizes the scp-like form only when no slash precedes the first colon.
  const colon = text.indexOf(':');
  const slash = text.indexOf('/');
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    return text.slice(colon + 1);
  }
  return undefined;
}

function isUrlSegment(segment: string): boolean {
  return URL_SEGMENT.test(segment) && LETTER_OR_DIGIT.test(segment);
}
