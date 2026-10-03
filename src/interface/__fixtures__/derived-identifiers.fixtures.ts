import type { LocalRepositoryNaming } from '../derived-identifiers';
import type { ParsedGitHubRepository } from '@/domain/github-reference';

export function buildGitHubRepository(
  overrides: Partial<ParsedGitHubRepository> = {},
): ParsedGitHubRepository {
  return { host: 'github.com', owner: 'octo', repo: 'app', ...overrides };
}

export function buildLocalRepositoryNaming(
  overrides: Partial<LocalRepositoryNaming> = {},
): LocalRepositoryNaming {
  return { directoryName: 'alpha', ...overrides };
}
