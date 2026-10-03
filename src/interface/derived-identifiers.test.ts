// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  buildGitHubRepository,
  buildLocalRepositoryNaming,
} from './__fixtures__/derived-identifiers.fixtures';
import {
  deriveCheckId,
  deriveGitHubRepositoryId,
  deriveLocalRepositoryId,
  deriveModelEntryId,
  deriveTaskId,
} from './derived-identifiers';

const ID_GRAMMAR = /^[a-z][a-z0-9-]{0,63}$/;
const NO_TAKEN_IDS: ReadonlySet<string> = new Set();
const LONG_NAME = 'a'.repeat(70);
const DEGENERATE_INPUTS = [
  '',
  '???',
  '   ',
  'Café',
  '日本語',
  '-- leading and trailing --',
  '9 starts with a digit',
  LONG_NAME,
];

function taken(...ids: string[]): ReadonlySet<string> {
  return new Set(ids);
}

function expectWellFormed(id: string): void {
  expect(id).toMatch(ID_GRAMMAR);
  expect(id).not.toContain('--');
  expect(id).not.toMatch(/-$/);
}

function local(directoryName: string, originUrl?: string): string {
  return deriveLocalRepositoryId(
    buildLocalRepositoryNaming({
      directoryName,
      ...(originUrl === undefined ? {} : { originUrl }),
    }),
    NO_TAKEN_IDS,
  );
}

describe('derivation table', () => {
  it.each<{ name: string; derive: () => string; expected: string }>([
    {
      name: 'a provider prefix and dots in a model',
      derive: () => deriveModelEntryId('acme/vendor/model-5.6', 'high', NO_TAKEN_IDS),
      expected: 'model-5-6-high',
    },
    {
      name: 'a model that normalizes to a taken ID',
      derive: () => deriveModelEntryId('other/model_5.6', 'high', taken('model-5-6-high')),
      expected: 'model-5-6-high-2',
    },
    {
      name: 'a model name that starts with a digit',
      derive: () => deriveModelEntryId('openai/4o', 'low', NO_TAKEN_IDS),
      expected: 'model-4o-low',
    },
    {
      name: 'a model with a colon and an effort with spaces and capitals',
      derive: () => deriveModelEntryId('ollama/llama3.1:8b', ' High ', NO_TAKEN_IDS),
      expected: 'llama3-1-8b-high',
    },
    {
      name: 'a model and effort with no usable characters',
      derive: () => deriveModelEntryId('acme/???', '???', NO_TAKEN_IDS),
      expected: 'model',
    },
    {
      name: 'a 70-character model name',
      derive: () => deriveModelEntryId(`acme/${LONG_NAME}`, 'high', NO_TAKEN_IDS),
      expected: 'a'.repeat(64),
    },
    {
      name: 'a 70-character model name whose 64-character ID is taken',
      derive: () => deriveModelEntryId(`acme/${LONG_NAME}`, 'high', taken('a'.repeat(64))),
      expected: `${'a'.repeat(62)}-2`,
    },
    {
      name: 'a GitHub repository with a dot in its name',
      derive: () =>
        deriveGitHubRepositoryId(
          buildGitHubRepository({ owner: 'octo', repo: 'App.js' }),
          NO_TAKEN_IDS,
        ),
      expected: 'octo-app-js',
    },
    {
      name: 'a GitHub owner that starts with a digit',
      derive: () =>
        deriveGitHubRepositoryId(
          buildGitHubRepository({ owner: '1password', repo: 'cli' }),
          NO_TAKEN_IDS,
        ),
      expected: 'repo-1password-cli',
    },
    {
      name: 'a GitHub repository on another host with a taken ID',
      derive: () =>
        deriveGitHubRepositoryId(
          buildGitHubRepository({ host: 'ghe.example.com', owner: 'octo', repo: 'app' }),
          taken('octo-app'),
        ),
      expected: 'octo-app-2',
    },
    {
      name: 'an scp-like origin',
      derive: () => local('alpha', 'git@github.com:Acme/Web_App.git'),
      expected: 'acme-web-app',
    },
    {
      name: 'an https origin with user info and a nested group',
      derive: () => local('alpha', 'https://ci:s3cret@gitlab.com/group/sub/app.git'),
      expected: 'sub-app',
    },
    {
      name: 'an ssh origin with a port and a trailing slash',
      derive: () => local('alpha', 'ssh://git@host.example:2222/acme/app.git/'),
      expected: 'acme-app',
    },
    {
      name: 'an scp-like origin whose user info holds a credential and whose path has two segments',
      derive: () => local('alpha', 'user:s3cret@host.example:acme/app.git'),
      expected: 'alpha',
    },
    {
      name: 'a local-path origin',
      derive: () => local('alpha', '/srv/git/app.git'),
      expected: 'alpha',
    },
    {
      name: 'a file URL origin',
      derive: () => local('alpha', 'file:///srv/git/app.git'),
      expected: 'alpha',
    },
    {
      name: 'an scp-like origin with one path segment',
      derive: () => local('alpha', 'git@host.example:app.git'),
      expected: 'alpha',
    },
    {
      name: 'no origin and a directory that starts with a digit',
      derive: () => local('2024 Q3'),
      expected: 'repo-2024-q3',
    },
    {
      name: 'no origin and a directory with a non-ASCII letter',
      derive: () => local('Café'),
      expected: 'caf',
    },
    {
      name: 'no origin and an empty directory name',
      derive: () => local(''),
      expected: 'repo',
    },
    {
      name: 'tasks with a gap',
      derive: () => deriveTaskId(taken('task-1', 'task-3')),
      expected: 'task-2',
    },
    {
      name: 'a task ID with a leading zero',
      derive: () => deriveTaskId(taken('task-01')),
      expected: 'task-1',
    },
    {
      name: 'a new configuration with no tasks',
      derive: () => deriveTaskId(NO_TAKEN_IDS),
      expected: 'task-1',
    },
    {
      name: 'an acceptance check after two drafted items',
      derive: () => deriveCheckId('acceptance', 3),
      expected: 'acceptance-3',
    },
    {
      name: 'a done check after one drafted item',
      derive: () => deriveCheckId('done', 2),
      expected: 'done-2',
    },
  ])('derives the expected ID for $name', ({ derive, expected }) => {
    expect(derive()).toBe(expected);
  });
});

describe('origin parsing', () => {
  it.each([
    { name: 'a scheme in capitals on a file URL', url: 'FILE:///srv/git/app.git' },
    { name: 'a URL without a path', url: 'https://host.example' },
    {
      name: 'a segment with a character outside the grammar',
      url: 'git@host.example:ac me/app.git',
    },
    { name: 'a segment without a letter or digit', url: 'git@host.example:acme/...' },
    { name: 'a slash before the first colon', url: 'srv/git:acme/app.git' },
  ])('falls back to the directory name for $name', ({ url }) => {
    expect(local('alpha', url)).toBe('alpha');
  });

  it('ignores a query and a fragment after the path', () => {
    expect(local('alpha', 'https://host.example/acme/app.git?ref=main#readme')).toBe('acme-app');
  });

  it('keeps a credential in the user info out of the ID', () => {
    const id = local('alpha', 'https://user:SENTINEL@host.example/acme/app.git');

    expect(id).toBe('acme-app');
    expect(id).not.toContain('sentinel');
  });
});

describe('totality', () => {
  it.each(DEGENERATE_INPUTS)('returns a well-formed ID for the text %j', (input) => {
    const github = deriveGitHubRepositoryId(
      buildGitHubRepository({ owner: input, repo: input }),
      NO_TAKEN_IDS,
    );
    const directory = local(input);
    const origin = local('alpha', input);
    const model = deriveModelEntryId(`${input}/${input}`, input, NO_TAKEN_IDS);

    for (const id of [github, directory, origin, model]) {
      expectWellFormed(id);
    }
  });

  it.each(DEGENERATE_INPUTS)('returns a well-formed suffixed ID for the taken text %j', (input) => {
    const base = deriveModelEntryId(`acme/${input}`, input, NO_TAKEN_IDS);

    const id = deriveModelEntryId(`acme/${input}`, input, taken(base));

    expectWellFormed(id);
    expect(id).not.toBe(base);
  });

  it('returns a well-formed ID for a task ID set holding unrelated IDs', () => {
    expectWellFormed(deriveTaskId(taken('alpha', 'task-', 'task-x')));
  });

  it.each([1, 2, 10, 100])('returns a well-formed ID for check position %i', (position) => {
    expectWellFormed(deriveCheckId('acceptance', position));
    expectWellFormed(deriveCheckId('done', position));
  });
});

describe('uniqueness', () => {
  it('skips a suffixed candidate that is also taken', () => {
    const id = deriveModelEntryId('acme/model', 'high', taken('model-high', 'model-high-2'));

    expect(id).toBe('model-high-3');
  });

  it('keeps a free base unchanged', () => {
    expect(deriveModelEntryId('acme/model', 'high', taken('model-low'))).toBe('model-high');
  });

  it('suffixes a taken local repository ID', () => {
    const naming = buildLocalRepositoryNaming({ directoryName: 'alpha' });

    expect(deriveLocalRepositoryId(naming, taken('alpha', 'alpha-2'))).toBe('alpha-3');
  });

  it('suffixes a taken GitHub repository ID', () => {
    const repository = buildGitHubRepository();

    expect(deriveGitHubRepositoryId(repository, taken('octo-app', 'octo-app-2'))).toBe(
      'octo-app-3',
    );
  });

  it('returns a task ID absent from the loaded tasks', () => {
    const existing = taken('task-1', 'task-2', 'task-4');

    const id = deriveTaskId(existing);

    expect(id).toBe('task-3');
    expect(existing.has(id)).toBe(false);
  });

  it('drops a trailing hyphen exposed by shortening the base for the suffix', () => {
    const base = `${'a'.repeat(61)}-bb`;

    const id = deriveLocalRepositoryId(
      buildLocalRepositoryNaming({ directoryName: base }),
      taken(base),
    );

    expect(id).toBe(`${'a'.repeat(61)}-2`);
  });

  it('keeps the result within 64 characters when the suffix is added', () => {
    const base = 'a'.repeat(64);

    const id = deriveLocalRepositoryId(
      buildLocalRepositoryNaming({ directoryName: base }),
      taken(base, `${'a'.repeat(62)}-2`),
    );

    expect(id).toBe(`${'a'.repeat(62)}-3`);
    expect(id).toHaveLength(64);
  });
});

describe('determinism', () => {
  it('gives equal IDs for equal inputs', () => {
    const naming = buildLocalRepositoryNaming({ originUrl: 'git@github.com:Acme/Web_App.git' });
    const repository = buildGitHubRepository();

    expect(deriveLocalRepositoryId(naming, taken('x'))).toBe(
      deriveLocalRepositoryId(naming, taken('x')),
    );
    expect(deriveGitHubRepositoryId(repository, NO_TAKEN_IDS)).toBe(
      deriveGitHubRepositoryId(repository, NO_TAKEN_IDS),
    );
    expect(deriveModelEntryId('a/b', 'c', NO_TAKEN_IDS)).toBe(
      deriveModelEntryId('a/b', 'c', NO_TAKEN_IDS),
    );
    expect(deriveTaskId(taken('task-1'))).toBe(deriveTaskId(taken('task-1')));
    expect(deriveCheckId('done', 4)).toBe(deriveCheckId('done', 4));
  });
});
