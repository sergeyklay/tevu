import { describe, expect, it, vi } from 'vitest';

import { createJiraCloudAdapter } from './jira-cloud';

import type { JiraCloudDependencies, JiraCloudSettings } from './jira-cloud';
import type { IssueSnapshot, TevuResult } from '@/domain/types';

type ReadIssueResult = TevuResult<IssueSnapshot, 'IssueImportError' | 'CancellationError'>;

type AdfNode = Record<string, unknown>;

const SPEC = 'https://example.invalid/specification';

const ISSUE_URL = 'https://jira.example.invalid/rest/api/3/issue/TEST-1?fields=summary,description';

const SETTINGS: JiraCloudSettings = {
  baseUrl: 'https://jira.example.invalid',
  emailEnvironmentVariable: 'JIRA_EMAIL',
  tokenEnvironmentVariable: 'JIRA_TOKEN',
};

function expectOk(result: ReadIssueResult): IssueSnapshot {
  if (!result.ok) {
    throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

function doc(...content: AdfNode[]): AdfNode {
  return { type: 'doc', version: 1, content };
}

function paragraph(...content: AdfNode[]): AdfNode {
  return { type: 'paragraph', content };
}

function text(value: string, marks?: unknown): AdfNode {
  return marks === undefined ? { type: 'text', text: value } : { type: 'text', text: value, marks };
}

function linkMark(href: unknown): AdfNode {
  return { type: 'link', attrs: { href } };
}

function linked(value: string, href: string): AdfNode {
  return text(value, [linkMark(href)]);
}

function card(type: string, attrs?: unknown): AdfNode {
  return attrs === undefined ? { type } : { type, attrs };
}

function inlineCard(url: string): AdfNode {
  return card('inlineCard', { url });
}

const hardBreak: AdfNode = { type: 'hardBreak' };

const strongMark: AdfNode = { type: 'strong' };

function buildDependencies(description: unknown) {
  const fetch = vi.fn<JiraCloudDependencies['fetch']>(async () => ({
    status: 200,
    headers: { get: () => null },
    json: async () => ({ key: 'TEST-1', fields: { summary: 'Summary', description } }),
  }));
  const sleep = vi.fn<JiraCloudDependencies['sleep']>(async () => undefined);
  const getEnvironmentVariable = vi.fn<JiraCloudDependencies['getEnvironmentVariable']>(
    (name) => `synthetic-${name}`,
  );

  return { fetch, sleep, getEnvironmentVariable };
}

async function importDescription(description: unknown): Promise<string> {
  const adapter = createJiraCloudAdapter(SETTINGS, buildDependencies(description));

  return expectOk(await adapter.readIssue('TEST-1')).description;
}

describe('createJiraCloudAdapter description projection', () => {
  it('keeps the destination of a smart link and of a labeled link in separate paragraphs', async () => {
    const description = doc(
      paragraph(text('Implement '), inlineCard(SPEC)),
      paragraph(linked('Reference', SPEC)),
    );

    const projected = await importDescription(description);

    expect(projected).toBe(`Implement ${SPEC}\nReference (${SPEC})`);
  });

  it.each([
    {
      description: 'an inline smart link after text',
      content: doc(paragraph(text('Implement '), inlineCard(SPEC))),
      expected: `Implement ${SPEC}`,
    },
    {
      description: 'linked text whose label differs from the destination',
      content: doc(paragraph(linked('Reference', SPEC))),
      expected: `Reference (${SPEC})`,
    },
    {
      description: 'a label split across marks that share one destination',
      content: doc(
        paragraph(
          text('Read '),
          linked('the ', SPEC),
          text('spec', [strongMark, linkMark(SPEC)]),
          text(' now'),
        ),
      ),
      expected: `Read the spec (${SPEC}) now`,
    },
    {
      description: 'a label ending in whitespace before plain text',
      content: doc(paragraph(text('Read '), linked('the spec ', SPEC), text('now'))),
      expected: `Read the spec (${SPEC}) now`,
    },
    {
      description: 'a label that shows a different URL than it links to',
      content: doc(paragraph(linked('https://example.invalid/a', 'https://example.invalid/b'))),
      expected: 'https://example.invalid/a (https://example.invalid/b)',
    },
    {
      description: 'two linked runs separated by a hard break',
      content: doc(paragraph(linked('one', SPEC), hardBreak, linked('two', SPEC))),
      expected: `one (${SPEC})\ntwo (${SPEC})`,
    },
    {
      description: 'a whitespace-only label',
      content: doc(paragraph(text('See'), linked(' ', SPEC))),
      expected: `See ${SPEC}`,
    },
    {
      description: 'a destination padded with whitespace',
      content: doc(paragraph(linked('Reference', `  ${SPEC} `))),
      expected: `Reference (${SPEC})`,
    },
    {
      description: 'list items holding linked text and an inline smart link',
      content: doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph(linked('Spec', SPEC))] },
          { type: 'listItem', content: [paragraph(inlineCard(SPEC))] },
        ],
      }),
      expected: `Spec (${SPEC})\n${SPEC}`,
    },
  ])('imports $description with its destination once', async ({ content, expected }) => {
    const projected = await importDescription(content);

    expect(projected).toBe(expected);
  });

  it.each([
    { description: 'a block smart link', type: 'blockCard', attrs: { url: SPEC } },
    {
      description: 'an embedded smart link',
      type: 'embedCard',
      attrs: { url: SPEC, layout: 'center' },
    },
  ])('puts $description on its own line between paragraphs', async ({ type, attrs }) => {
    const description = doc(paragraph(text('Before')), card(type, attrs), paragraph(text('After')));

    const projected = await importDescription(description);

    expect(projected).toBe(`Before\n${SPEC}\nAfter`);
  });

  it.each([
    {
      description: 'a URL that is also the link label',
      content: doc(paragraph(text('Implement '), linked(SPEC, SPEC))),
      expected: `Implement ${SPEC}`,
    },
    {
      description: 'a label that is the URL without its http scheme',
      content: doc(paragraph(linked('www.example.invalid', 'http://www.example.invalid'))),
      expected: 'www.example.invalid',
    },
    {
      description: 'a label that is the address without its mailto scheme',
      content: doc(paragraph(linked('dev@example.invalid', 'mailto:dev@example.invalid'))),
      expected: 'dev@example.invalid',
    },
    {
      description: 'a URL typed as plain text',
      content: doc(paragraph(text(`Implement ${SPEC}`))),
      expected: `Implement ${SPEC}`,
    },
    {
      description: 'a link mark without an href',
      content: doc(paragraph(text('Reference', [{ type: 'link', attrs: {} }]))),
      expected: 'Reference',
    },
    {
      description: 'a link mark with a blank href',
      content: doc(paragraph(linked('Reference', '  '))),
      expected: 'Reference',
    },
    {
      description: 'an inline smart link that carries only data',
      content: doc(paragraph(text('See '), card('inlineCard', { data: { url: SPEC } }))),
      expected: 'See',
    },
    {
      description: 'a hard break inside a paragraph',
      content: doc(paragraph(text('line one'), hardBreak, text('line two'))),
      expected: 'line one\nline two',
    },
    {
      description: 'mentions and emoji through their attribute fallback',
      content: doc(
        paragraph(text('Ask '), { type: 'mention', attrs: { text: '@Dana' } }),
        paragraph(text('Done '), { type: 'emoji', attrs: { shortName: ':tada:' } }),
      ),
      expected: 'Ask @Dana\nDone :tada:',
    },
    {
      description: 'text inside layout nodes',
      content: doc({
        type: 'layoutSection',
        content: [{ type: 'layoutColumn', content: [paragraph(text('Column text'))] }],
      }),
      expected: 'Column text',
    },
  ])('imports $description unchanged', async ({ content, expected }) => {
    const projected = await importDescription(content);

    expect(projected).toBe(expected);
  });

  describe('malformed link data', () => {
    it.each([
      { description: 'without attrs', attrs: undefined },
      { description: 'with attrs that is not a record', attrs: 'https://example.invalid/x' },
      { description: 'without a url', attrs: {} },
      { description: 'with a url that is not a string', attrs: { url: 42 } },
      { description: 'with a blank url', attrs: { url: '   ' } },
      { description: 'with a datasource and no url', attrs: { datasource: { id: 'query' } } },
    ])('imports an inline smart link $description as nothing', async ({ attrs }) => {
      const description = doc(paragraph(text('See '), card('inlineCard', attrs)));

      const projected = await importDescription(description);

      expect(projected).toBe('See');
    });

    it.each([
      { description: 'a block smart link', type: 'blockCard' },
      { description: 'an embedded smart link', type: 'embedCard' },
    ])('imports $description without a url as nothing', async ({ type }) => {
      const description = doc(paragraph(text('Before')), card(type, {}), paragraph(text('After')));

      const projected = await importDescription(description);

      expect(projected).toBe('Before\nAfter');
    });

    it.each([
      { description: 'no marks', marks: undefined },
      { description: 'marks that are not an array', marks: 'link' },
      {
        description: 'a link mark whose attrs is not a record',
        marks: [{ type: 'link', attrs: 'x' }],
      },
      { description: 'a link mark whose href is not a string', marks: [linkMark(7)] },
      {
        description: 'a first link mark without a destination followed by one with a destination',
        marks: [{ type: 'link', attrs: {} }, linkMark(SPEC)],
      },
    ])('imports text with $description as plain text', async ({ marks }) => {
      const description = doc(paragraph(text('Plain', marks)));

      const projected = await importDescription(description);

      expect(projected).toBe('Plain');
    });

    it('renders adjacent linked text with different destinations as separate runs', async () => {
      const description = doc(
        paragraph(
          linked('A', 'https://example.invalid/a'),
          linked('B', 'https://example.invalid/b'),
        ),
      );

      const projected = await importDescription(description);

      expect(projected).toBe('A (https://example.invalid/a)B (https://example.invalid/b)');
    });
  });

  describe('side effects', () => {
    it.each([
      {
        description: 'an inline smart link and linked text',
        content: doc(
          paragraph(text('Implement '), inlineCard(SPEC)),
          paragraph(linked('Reference', SPEC)),
        ),
      },
      {
        description: 'a block smart link',
        content: doc(paragraph(text('Before')), card('blockCard', { url: SPEC })),
      },
      {
        description: 'an embedded smart link',
        content: doc(
          paragraph(text('Before')),
          card('embedCard', { url: SPEC, layout: 'center' }),
          paragraph(text('After')),
        ),
      },
    ])('issues one issue request and no retry delay for $description', async ({ content }) => {
      const dependencies = buildDependencies(content);
      const adapter = createJiraCloudAdapter(SETTINGS, dependencies);

      expectOk(await adapter.readIssue('TEST-1'));

      expect(dependencies.fetch).toHaveBeenCalledExactlyOnceWith(ISSUE_URL, expect.anything());
      expect(dependencies.sleep).not.toHaveBeenCalled();
    });
  });
});
