import { describe, expect, it } from 'vitest';

import {
  describePullRequestInPrompt,
  describeReferenceCommitInPrompt,
  describeReferenceIdentityInText,
  describeSourceCommitInPrompt,
} from './source-commit-in-prompt';

import type { ParsedGitHubReference } from '@/domain/github-reference';
import type { TaskReference } from '@/domain/types';

const SOURCE_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';

describe('describeSourceCommitInPrompt', () => {
  it.each([
    { label: 'the lowercase prefix', prompt: 'text abcdef0 more text' },
    { label: 'the uppercase prefix', prompt: 'text ABCDEF0 more text' },
    { label: 'a longer mixed-case prefix', prompt: 'text AbCdEf012345 more text' },
    { label: 'the full SHA', prompt: `text ${SOURCE_COMMIT} more text` },
  ])('returns the reason when the prompt contains $label', ({ prompt }) => {
    expect(describeSourceCommitInPrompt(prompt, SOURCE_COMMIT)).toBe(
      'agent prompt contains resolved base commit abcdef0',
    );
  });

  it.each([
    { label: 'the first 6 characters only', prompt: 'text abcdef more text' },
    { label: 'characters 2 to 8 only', prompt: 'text bcdef01 more text' },
    {
      label: 'an unrelated 40-character SHA',
      prompt: 'text fedcba9876543210fedcba9876543210fedcba98 more text',
    },
    { label: 'the hex word deadbeef', prompt: 'text deadbeef more text' },
  ])('returns undefined when the prompt contains only $label', ({ prompt }) => {
    expect(describeSourceCommitInPrompt(prompt, SOURCE_COMMIT)).toBeUndefined();
  });
});

const REFERENCE_COMMIT = 'fedcba9876543210fedcba9876543210fedcba98';

describe('describeReferenceCommitInPrompt', () => {
  it.each([
    { label: 'the lowercase prefix', prompt: 'text fedcba9 more text' },
    { label: 'the uppercase prefix', prompt: 'text FEDCBA9 more text' },
    { label: 'a mixed-case prefix', prompt: 'text FedCba9876 more text' },
  ])('returns the reason when the prompt contains $label', ({ prompt }) => {
    expect(describeReferenceCommitInPrompt(prompt, REFERENCE_COMMIT)).toBe(
      'agent prompt contains resolved reference commit fedcba9',
    );
  });

  it.each([
    { label: 'the first 6 characters only', prompt: 'text fedcba more text' },
    {
      label: 'an unrelated substring',
      prompt: 'text abcdef0123456789abcdef0123456789abcdef01 more text',
    },
  ])('returns undefined when the prompt contains only $label', ({ prompt }) => {
    expect(describeReferenceCommitInPrompt(prompt, REFERENCE_COMMIT)).toBeUndefined();
  });
});

const PULL_REQUEST: ParsedGitHubReference = {
  host: 'github.com',
  owner: 'octo',
  repo: 'app',
  number: 128,
};

describe('describePullRequestInPrompt', () => {
  it.each([
    { label: 'the lowercase key', prompt: 'text octo/app#128 more text' },
    { label: 'the uppercase key', prompt: 'text OCTO/APP#128 more text' },
    { label: 'the lowercase URL form', prompt: 'text github.com/octo/app/pull/128 more text' },
    {
      label: 'the URL form inside an https URL',
      prompt: 'see https://github.com/octo/app/pull/128 for details',
    },
    {
      label: 'the URL form inside an http URL',
      prompt: 'see http://GITHUB.COM/octo/app/pull/128 for details',
    },
    { label: 'the key inside a longer run of characters', prompt: 'text octo/app#1283 more text' },
  ])('returns the reason when the prompt contains $label', ({ prompt }) => {
    expect(describePullRequestInPrompt(prompt, PULL_REQUEST)).toBe(
      'agent prompt contains pull request octo/app#128',
    );
  });

  it('returns undefined for a bare issue-style number', () => {
    expect(describePullRequestInPrompt('see #128 for details', PULL_REQUEST)).toBeUndefined();
  });

  it('returns undefined for an unrelated key', () => {
    expect(
      describePullRequestInPrompt('text octo/other#128 more text', PULL_REQUEST),
    ).toBeUndefined();
  });

  it("builds the URL form's host as github.com for a short-form identifier", () => {
    expect(
      describePullRequestInPrompt('see github.com/octo/app/pull/128', {
        host: 'github.com',
        owner: 'octo',
        repo: 'app',
        number: 128,
      }),
    ).toBe('agent prompt contains pull request octo/app#128');
  });
});

describe('describeReferenceIdentityInText', () => {
  const COMMIT_REFERENCE: TaskReference = {
    kind: 'commit',
    identifier: 'HEAD~3',
    commits: ['abcdef0123456789abcdef0123456789abcdef01'],
  };
  const PULL_REQUEST_REFERENCE: TaskReference = {
    kind: 'pull-request',
    identifier: 'octo/app#128',
    commits: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
    merge_commit: 'ffffffffffffffffffffffffffffffffffffffff',
  };
  const BASE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

  it('detects text naming a reference commit', () => {
    expect(describeReferenceIdentityInText('see abcdef0 for the fix', COMMIT_REFERENCE)).toBe(
      'reference commit abcdef0',
    );
  });

  it('detects text naming the merge commit of a pull-request reference', () => {
    expect(describeReferenceIdentityInText('see fffffff for the fix', PULL_REQUEST_REFERENCE)).toBe(
      'reference commit fffffff',
    );
  });

  it.each([
    { label: 'the key', text: 'see octo/app#128 for the fix' },
    { label: 'the URL form', text: 'see github.com/octo/app/pull/128 for the fix' },
    { label: 'the key, case-insensitively', text: 'see OCTO/APP#128 for the fix' },
  ])('detects text naming a pull request through $label', ({ text }) => {
    expect(describeReferenceIdentityInText(text, PULL_REQUEST_REFERENCE)).toBe(
      'pull request octo/app#128',
    );
  });

  it('returns undefined for text naming none of the reference identities', () => {
    expect(
      describeReferenceIdentityInText('nothing relevant here', COMMIT_REFERENCE),
    ).toBeUndefined();
    expect(
      describeReferenceIdentityInText('nothing relevant here', PULL_REQUEST_REFERENCE),
    ).toBeUndefined();
  });

  it('returns undefined for text naming only the task base commit, which is not part of the reference', () => {
    expect(
      describeReferenceIdentityInText(
        `see ${BASE_COMMIT.slice(0, 7)} for the fix`,
        COMMIT_REFERENCE,
      ),
    ).toBeUndefined();
  });
});
