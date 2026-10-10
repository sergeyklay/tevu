import { describe, expect, it, vi } from 'vitest';

import { createJiraCloudAdapter } from './jira-cloud';

import type { JiraCloudDependencies, JiraCloudSettings } from './jira-cloud';

const SECRET = 'synthetic-acme-secret-value';

const SETTINGS: JiraCloudSettings = {
  baseUrl: 'https://jira.example.invalid',
  emailEnvironmentVariable: 'JIRA_EMAIL',
  tokenEnvironmentVariable: 'JIRA_TOKEN',
};

function readIssueWithBody(body: unknown) {
  const dependencies: JiraCloudDependencies = {
    fetch: vi.fn<JiraCloudDependencies['fetch']>(async () => ({
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    })),
    sleep: vi.fn<JiraCloudDependencies['sleep']>(async () => undefined),
    getEnvironmentVariable: (name) => `synthetic-${name}`,
  };

  return createJiraCloudAdapter(SETTINGS, dependencies).readIssue('TEST-1');
}

describe('createJiraCloudAdapter response decoding', () => {
  it.each([
    { description: 'null', body: null },
    { description: 'a number', body: 5 },
    { description: 'a list', body: [] },
    { description: 'an object without fields', body: { key: 'TEST-1' } },
    { description: 'fields that is a string', body: { key: 'TEST-1', fields: 'text' } },
    { description: 'fields that is a list', body: { key: 'TEST-1', fields: [] } },
    { description: 'fields that is null', body: { key: 'TEST-1', fields: null } },
  ])('reports a malformed shape for $description', async ({ body }) => {
    const result = await readIssueWithBody(body);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'IssueImportError',
        tracker: 'jira-cloud',
        reference: 'TEST-1',
        status: 200,
        reason: 'issue response shape is malformed',
      },
    });
  });

  it.each([
    { description: 'absent', fields: {} },
    { description: 'a number', fields: { summary: 5 } },
    { description: 'null', fields: { summary: null } },
    { description: 'an object', fields: { summary: { text: 'x' } } },
  ])('reports a missing summary when summary is $description', async ({ fields }) => {
    const result = await readIssueWithBody({ key: 'TEST-1', fields });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'IssueImportError',
        tracker: 'jira-cloud',
        reference: 'TEST-1',
        status: 200,
        reason: 'issue response is missing a summary field',
      },
    });
  });

  it.each([
    { description: 'summary', body: { key: 'TEST-1', fields: { summary: [SECRET] } } },
    { description: 'fields', body: { key: 'TEST-1', fields: SECRET } },
  ])('keeps a secret held by $description out of the reason', async ({ body }) => {
    const result = await readIssueWithBody(body);

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it.each([
    { description: 'absent', body: { fields: { summary: 'S' } } },
    { description: 'an empty string', body: { key: '', fields: { summary: 'S' } } },
    { description: 'a number', body: { key: 7, fields: { summary: 'S' } } },
    { description: 'null', body: { key: null, fields: { summary: 'S' } } },
  ])('falls back to the requested key when the response key is $description', async ({ body }) => {
    const result = await readIssueWithBody(body);

    expect(result).toMatchObject({
      ok: true,
      value: {
        issueKey: 'TEST-1',
        issueUrl: 'https://jira.example.invalid/browse/TEST-1',
        summary: 'S',
      },
    });
  });

  it('uses the key the response names', async () => {
    const result = await readIssueWithBody({ key: 'MOVED-9', fields: { summary: 'S' } });

    expect(result).toMatchObject({
      ok: true,
      value: { issueKey: 'MOVED-9', issueUrl: 'https://jira.example.invalid/browse/MOVED-9' },
    });
  });

  it.each([
    { description: 'absent', fields: { summary: 'S' } },
    { description: 'null', fields: { summary: 'S', description: null } },
  ])('imports an empty description when the description is $description', async ({ fields }) => {
    const result = await readIssueWithBody({ key: 'TEST-1', fields });

    expect(result).toMatchObject({ ok: true, value: { description: '' } });
  });
});
