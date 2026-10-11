import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  decodeEvent,
  decodeExport,
  decodeModelListing,
  decodeToolDenial,
  eventIdentity,
  isRootSessionErrorEvent,
  listMalformedOptionalMetricFields,
} from './protocol';

import type { OpenCodeRunEvent, ProtocolContext } from './protocol';

const CASE_CONTEXT: ProtocolContext = { phase: 'case', caseId: 'task-1--alpha' };
const FIXTURE_DIRECTORY = new URL('./fixtures/', import.meta.url);

function readTextFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIRECTORY), 'utf8');
}

function readJsonFixture(name: string): unknown {
  return JSON.parse(readTextFixture(name)) as unknown;
}

function validFixtureEvents(): OpenCodeRunEvent[] {
  const events: OpenCodeRunEvent[] = [];
  for (const [index, line] of readTextFixture('events-valid.jsonl').trim().split('\n').entries()) {
    const decoded = decodeEvent(JSON.parse(line) as unknown, CASE_CONTEXT, index + 1);
    if (!decoded.ok) {
      throw new Error(`valid fixture line ${index + 1} must decode: ${decoded.error.reason}`);
    }
    if (decoded.value !== null) {
      events.push(decoded.value);
    }
  }
  return events;
}

function buildErrorEvent(sessionID: string, error: unknown): OpenCodeRunEvent {
  return { type: 'error', timestamp: 1, sessionID, error };
}

function malformedFixtureLines(): string[] {
  return readTextFixture('events-malformed.jsonl').trim().split('\n');
}

describe('decodeEvent', () => {
  it('decodes every consumed event line in the valid fixture and drops the additive unknown type', () => {
    const lines = readTextFixture('events-valid.jsonl').trim().split('\n');

    const decoded = lines.map((line, index) =>
      decodeEvent(JSON.parse(line) as unknown, CASE_CONTEXT, index + 1),
    );

    for (const [index, outcome] of decoded.entries()) {
      expect(outcome.ok, `fixture line ${index + 1} must decode`).toBe(true);
    }
    expect(decoded.filter((outcome) => outcome.ok && outcome.value !== null)).toHaveLength(8);
    expect(decoded[8]).toMatchObject({ ok: true, value: null });
  });

  it('preserves additive event and part fields as evidence on decoded records', () => {
    const events = validFixtureEvents();

    expect(events[0]).toMatchObject({ type: 'step_start', additiveEventField: 'tolerated' });
    const textEvent = events[1] as { part: Record<string, unknown> };
    expect(textEvent.part['additivePartField']).toBe(true);
  });

  it.each([
    { number: 1, path: 'part.id' },
    { number: 2, path: 'sessionID' },
    { number: 3, path: 'part.sessionID' },
    { number: 4, path: 'part.messageID' },
    { number: 5, path: 'type' },
    { number: 6, path: 'sessionID' },
    { number: 8, path: 'part' },
  ])(
    'rejects malformed fixture line $number as a required-identity protocol error',
    ({ number, path }) => {
      const lines = malformedFixtureLines();
      const decoded = decodeEvent(JSON.parse(lines[number - 1]) as unknown, CASE_CONTEXT, number);

      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.error.kind).toBe('OpenCodeProtocolError');
      expect(decoded.error.context).toEqual(CASE_CONTEXT);
      expect(decoded.error.line).toBe(number);
      expect(decoded.error.reason).toBe(
        `event record does not match the consumed event layout at ${path}`,
      );
    },
  );

  it('accepts the tool part with an absent optional tool name instead of failing the protocol', () => {
    const lines = malformedFixtureLines();
    const decoded = decodeEvent(JSON.parse(lines[6]) as unknown, CASE_CONTEXT, 7);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).not.toBeNull();
    const event = decoded.value as { part: Record<string, unknown> };
    expect(event.part['id']).toBe('prt-b6');
    expect(event.part['tool']).toBeUndefined();
  });

  it('rejects non-object event records', () => {
    for (const input of [42, 'text', [1, 2], null]) {
      const decoded = decodeEvent(input, CASE_CONTEXT, 1);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.error.reason).toBe(
        'event record does not match the consumed event layout at (root)',
      );
    }
  });

  it('rejects non-finite timestamps as malformed framing', () => {
    const decoded = decodeEvent(
      JSON.parse(
        '{"type":"text","timestamp":1e999,"sessionID":"ses-1","part":{"id":"p1","sessionID":"ses-1","messageID":"m1","type":"text"}}',
      ) as unknown,
      CASE_CONTEXT,
      1,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'event record does not match the consumed event layout at timestamp',
    );
  });

  it('reports probe-phase context without a line number', () => {
    const decoded = decodeEvent(42, { phase: 'probe' });

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.context).toEqual({ phase: 'probe' });
    expect(decoded.error.line).toBeUndefined();
  });
});

describe('eventIdentity', () => {
  it('identifies part events by (sessionID, part.id) regardless of the ordinal', () => {
    const events = validFixtureEvents();
    const stepStart = events[0];

    expect(eventIdentity(stepStart, 0)).toBe(eventIdentity(stepStart, 99));
    expect(eventIdentity(stepStart, 0)).toBe(`${stepStart.sessionID}\u0000prt-0001`);
  });

  it('separates identical part identities across different sessions', () => {
    const events = validFixtureEvents();
    const stepStart = events[0];
    const sibling: OpenCodeRunEvent = {
      type: 'step_start',
      timestamp: 1,
      sessionID: 'ses-sibling-0001',
      part: {
        id: 'prt-0001',
        sessionID: 'ses-sibling-0001',
        messageID: 'msg-x',
        type: 'step-start',
      },
    };

    expect(eventIdentity(stepStart, 0)).not.toBe(eventIdentity(sibling, 0));
  });

  it('identifies error events by session and ordinal so identical error records stay distinct', () => {
    const events = validFixtureEvents();
    const errorEvent = events[7];

    expect(eventIdentity(errorEvent, 0)).not.toBe(eventIdentity(errorEvent, 1));
    expect(eventIdentity(errorEvent, 2)).toBe(`${errorEvent.sessionID}\u0000error\u00002`);
  });
});

describe('isRootSessionErrorEvent', () => {
  const ROOT_SESSION = 'ses-root-0001';

  it.each([
    { payload: 'an object', error: { name: 'UnknownError', data: { message: 'boom' } } },
    { payload: 'a string', error: 'boom' },
    { payload: 'null', error: null },
  ])('detects an error event of the root session whose error is $payload', ({ error }) => {
    const event = buildErrorEvent(ROOT_SESSION, error);

    expect(isRootSessionErrorEvent(event, ROOT_SESSION)).toBe(true);
  });

  it('does not detect an error event of another session', () => {
    const event = buildErrorEvent('ses-sibling-0001', { name: 'UnknownError' });

    expect(isRootSessionErrorEvent(event, ROOT_SESSION)).toBe(false);
  });

  it('does not detect a non-error event of the root session', () => {
    const event: OpenCodeRunEvent = {
      type: 'step_start',
      timestamp: 1,
      sessionID: ROOT_SESSION,
      part: { id: 'prt-0001', sessionID: ROOT_SESSION, messageID: 'msg-1', type: 'step-start' },
    };

    expect(isRootSessionErrorEvent(event, ROOT_SESSION)).toBe(false);
  });
});

describe('decodeExport', () => {
  it('decodes the valid fixture export and retains additive fields', () => {
    const decoded = decodeExport(readJsonFixture('session-valid.json'), CASE_CONTEXT);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.view.info.id).toBe('ses-root-0001');
    expect(decoded.value.view.messages).toHaveLength(4);
    for (const serialized of [
      JSON.stringify(decoded.value.record),
      JSON.stringify(decoded.value.view),
    ]) {
      expect(serialized).toContain('additiveTopLevelField');
      expect(serialized).toContain('additiveInfoField');
      expect(serialized).toContain('additiveAssistantField');
      expect(serialized).toContain('additivePartField');
    }
  });

  it('rejects the malformed fixture export as a child session', () => {
    const decoded = decodeExport(readJsonFixture('session-malformed.json'), CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.context).toEqual(CASE_CONTEXT);
    expect(decoded.error.reason).toBe(
      'child session export "ses-child-0001" rejected: schema version 1 consumes only the root session',
    );
  });

  it('rejects exports without a session identity', () => {
    const decoded = decodeExport({ info: { id: '' }, messages: [] }, CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'export record does not match the consumed export layout at info.id',
    );
  });

  it('rejects exports whose messages are not an array', () => {
    const decoded = decodeExport({ info: { id: 'ses-1' }, messages: 'not-an-array' }, CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'export record does not match the consumed export layout at messages',
    );
  });

  it('rejects exports with a malformed message identity', () => {
    const decoded = decodeExport(
      { info: { id: 'ses-1' }, messages: [{ info: { id: 'msg-1', sessionID: '' }, parts: [] }] },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'export record does not match the consumed export layout at messages.0.info.sessionID',
    );
  });

  it('rejects exports whose message parts are not an array', () => {
    const decoded = decodeExport(
      {
        info: { id: 'ses-1' },
        messages: [{ info: { id: 'm1', sessionID: 'ses-1', role: 'user' }, parts: 'nope' }],
      },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'export record does not match the consumed export layout at messages.0.parts',
    );
  });

  it('rejects exports with a malformed part identity', () => {
    const decoded = decodeExport(
      {
        info: { id: 'ses-1' },
        messages: [
          {
            info: { id: 'm1', sessionID: 'ses-1', role: 'user' },
            parts: [{ id: 'p1', sessionID: 'ses-1', messageID: '', type: 'text' }],
          },
        ],
      },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'export record does not match the consumed export layout at messages.0.parts.0.messageID',
    );
  });

  it('rejects non-object export records', () => {
    const decoded = decodeExport([1, 2, 3], CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'export record does not match the consumed export layout at (root)',
    );
  });
});

describe('listMalformedOptionalMetricFields', () => {
  it('reports no findings for the fully populated valid fixture', () => {
    const decoded = decodeExport(readJsonFixture('session-valid.json'), CASE_CONTEXT);
    if (!decoded.ok) throw new Error('valid fixture must decode');

    expect(listMalformedOptionalMetricFields(decoded.value.view)).toEqual([]);
  });

  it('reports each absent or malformed optional metric field with its message identity', () => {
    const decoded = decodeExport(
      {
        info: { id: 'ses-root-0001' },
        messages: [
          {
            info: { id: 'msg-u1', sessionID: 'ses-root-0001', role: 'user' },
            parts: [],
          },
          {
            info: {
              id: 'msg-a1',
              sessionID: 'ses-root-0001',
              role: 'assistant',
              finish: 'stop',
              cost: 'not-a-number',
              tokens: { output: 4, reasoning: 0, cache: { write: 0 } },
            },
            parts: [
              {
                id: 'prt-x',
                sessionID: 'ses-root-0001',
                messageID: 'msg-a1',
                type: 'tool',
                state: { status: 'completed' },
              },
            ],
          },
        ],
      },
      CASE_CONTEXT,
    );
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const findings = listMalformedOptionalMetricFields(decoded.value.view);

    expect(findings).toContain('field "cost" is absent or malformed in export message "msg-a1"');
    expect(findings).toContain(
      'field "tokens.input" is absent or malformed in export message "msg-a1"',
    );
    expect(findings).toContain(
      'field "tokens.cache.read" is absent or malformed in export message "msg-a1"',
    );
    expect(findings).toContain('tool name is absent or malformed on tool part "prt-x"');
    expect(findings).toHaveLength(4);
  });

  it('stays informative for decoded exports that metric normalization will degrade, never a protocol failure', () => {
    const decoded = decodeExport(
      {
        info: { id: 'ses-1' },
        messages: [{ info: { id: 'm1', sessionID: 'ses-1', role: 'user' }, parts: [] }],
      },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(listMalformedOptionalMetricFields(decoded.value.view)).toEqual([]);
  });
});

describe('decodeModelListing', () => {
  const FIXTURE_MODELS = [
    'alpha/with-variants',
    'alpha/empty-variants',
    'alpha/no-variants',
    'alpha/array-variants',
    'alpha/unparsable',
    'alpha/unterminated',
    'beta/after-unterminated',
    'beta/bare-identifier',
    'beta/one-line',
    'beta/last',
  ];

  it('lists every identifier of the verbose fixture in order', () => {
    const decoded = decodeModelListing(readTextFixture('models-verbose.txt'));

    expect(decoded.models).toEqual(FIXTURE_MODELS);
  });

  it('reports exactly the variants the fixture records declare, sorted by code unit', () => {
    const decoded = decodeModelListing(readTextFixture('models-verbose.txt'));

    expect([...decoded.variants]).toEqual([
      ['alpha/with-variants', ['high', 'low', 'medium']],
      ['alpha/empty-variants', []],
      ['beta/after-unterminated', ['xhigh']],
      ['beta/one-line', ['alpha', 'zeta']],
      ['beta/last', ['max']],
    ]);
  });

  it.each([
    'alpha/no-variants',
    'alpha/array-variants',
    'alpha/unparsable',
    'alpha/unterminated',
    'beta/bare-identifier',
  ])('reports no variant data for %s', (model) => {
    const decoded = decodeModelListing(readTextFixture('models-verbose.txt'));

    expect(decoded.variants.has(model)).toBe(false);
  });

  it('decodes CRLF line ends exactly as LF line ends', () => {
    const lf = readTextFixture('models-verbose.txt');

    const decoded = decodeModelListing(lf.replaceAll('\n', '\r\n'));

    expect(decoded).toEqual(decodeModelListing(lf));
    expect(decoded.models).toEqual(FIXTURE_MODELS);
  });

  it('returns no record content, only identifiers and variant names', () => {
    const decoded = decodeModelListing(readTextFixture('models-verbose.txt'));

    const serialized = JSON.stringify({ models: decoded.models, variants: [...decoded.variants] });

    expect(serialized).not.toContain('tenant-marker-value');
    expect(serialized).not.toContain('reasoningEffort');
  });

  it('keeps the first record that yields variant data for a repeated identifier', () => {
    const text = [
      'a/m',
      '{',
      '  "variants": {',
      '    "first": {}',
      '  }',
      '}',
      'a/m',
      '{',
      '  "variants": {',
      '    "second": {}',
      '  }',
      '}',
    ].join('\n');

    const decoded = decodeModelListing(text);

    expect(decoded.models).toEqual(['a/m']);
    expect([...decoded.variants]).toEqual([['a/m', ['first']]]);
  });

  it('lets a later record set the variants when the first record yields none', () => {
    const text = ['a/m', '{', '  "id": "m"', '}', 'a/m', '{"variants":{"late":{}}}'].join('\n');

    const decoded = decodeModelListing(text);

    expect([...decoded.variants]).toEqual([['a/m', ['late']]]);
  });

  it('never reads an indented or brace-led line as an identifier', () => {
    const text = [
      'a/m',
      '{',
      '  "variants": {',
      '    "low": {}',
      '  }',
      '}',
      '',
      '\tstray',
      '  stray',
      '}',
    ].join('\n');

    const decoded = decodeModelListing(text);

    expect(decoded.models).toEqual(['a/m']);
  });

  it('trims trailing spaces and tabs from an identifier but keeps inner characters', () => {
    const decoded = decodeModelListing('a/m \t\nb/n o');

    expect(decoded.models).toEqual(['a/m', 'b/n o']);
  });

  it('resumes at the line that ended an unterminated record', () => {
    const text = ['a/m', '{', '  "variants": {', 'b/n', '{"variants":{"low":{}}}'].join('\n');

    const decoded = decodeModelListing(text);

    expect(decoded.models).toEqual(['a/m', 'b/n']);
    expect([...decoded.variants]).toEqual([['b/n', ['low']]]);
  });

  it.each([
    { name: 'empty text', text: '' },
    { name: 'only blank lines', text: '\n\n\r\n' },
    { name: 'a lone brace', text: '{' },
    { name: 'a lone closing brace', text: '}' },
    { name: 'an identifier followed by a lone brace', text: 'a/m\n{' },
    { name: 'a null record', text: 'a/m\n{"variants":null}' },
    { name: 'an empty one-line record', text: 'a/m\n{}' },
    { name: 'binary garbage', text: '\u0000\u0001\ufffd{\n"\n}}{{' },
  ])('does not throw on $name', ({ text }) => {
    expect(() => decodeModelListing(text)).not.toThrow();
  });

  it('lists nothing and reports no variants for empty text', () => {
    const decoded = decodeModelListing('');

    expect(decoded).toEqual({ models: [], variants: new Map() });
  });
});

describe('decodeToolDenial', () => {
  const NOT_A_JSON_OBJECT = 'prints no JSON object';
  const NO_PERMISSION = 'shows no "permission", so OPENCODE_PERMISSION is not in force';
  const NO_WILDCARD = 'shows no "*" rule in "permission", so OPENCODE_PERMISSION is not in force';
  const WILDCARD_NOT_DENY = 'shows "*" in "permission" as something other than "deny"';
  const grantedAfterWildcard = (key: string): string =>
    `lists "${key}" after "*" in "permission" with a value other than "deny"`;
  const UNKNOWN_RUN_AGENT =
    'shows the "build" agent disabled, hidden, or as a subagent and no "default_agent", so the agent of a model call is unknown';
  const grantedByRunAgent = (key: string, agent: string): string =>
    `lists "${key}" in the permission of agent "${agent}" with a value other than "deny"`;
  const unread = (field: string): string => `shows ${field} in a shape tevu does not read`;

  it.each([
    { name: 'the plain denial', text: '{"agent":{},"permission":{"*":"deny"}}' },
    {
      name: 'a grant listed before the wildcard',
      text: '{"permission":{"bash":"allow","*":"deny"}}',
    },
    {
      name: 'a pattern object listed before the wildcard',
      text: '{"permission":{"bash":{"*":"deny","git status":"allow"},"*":"deny"}}',
    },
    {
      name: 'legacy tools folded in beneath the denial',
      text: '{"tools":{"bash":true,"edit":false},"permission":{"bash":"allow","edit":"deny","*":"deny"}}',
    },
    {
      name: 'a repeated denial after the wildcard',
      text: '{"permission":{"*":"deny","bash":"deny"}}',
    },
    {
      name: 'a disabled build agent with a default agent that has no rules',
      text: '{"default_agent":"plan","agent":{"build":{"disable":true,"options":{},"permission":{}}},"permission":{"*":"deny"}}',
    },
    {
      name: 'an agent block without the selected agent',
      text: '{"agent":{"plan":{"permission":{"bash":"allow"}}},"permission":{"*":"deny"}}',
    },
    {
      name: 'a selected agent without a permission',
      text: '{"agent":{"build":{"options":{}}},"permission":{"*":"deny"}}',
    },
    {
      name: 'a selected agent whose permission only denies',
      text: '{"agent":{"build":{"permission":{"bash":"deny"}}},"permission":{"*":"deny"}}',
    },
    {
      name: 'an empty default agent that falls back to build',
      text: '{"default_agent":"","permission":{"*":"deny"}}',
    },
    {
      name: 'a visible build agent',
      text: '{"agent":{"build":{"mode":"primary","hidden":false}},"permission":{"*":"deny"}}',
    },
  ])('decodes $name as denied', ({ text }) => {
    expect(decodeToolDenial(text)).toEqual({ denied: true });
  });

  it.each([
    {
      name: 'output without a permission',
      text: '{"agent":{},"mode":{},"username":"u"}',
      reason: NO_PERMISSION,
    },
    {
      name: 'a grant after the wildcard',
      text: '{"permission":{"*":"deny","bash":"allow"}}',
      reason: grantedAfterWildcard('bash'),
    },
    {
      name: 'a masked value after the wildcard',
      text: '{"permission":{"*":"deny","get_token":"***"}}',
      reason: grantedAfterWildcard('get_token'),
    },
    {
      name: 'a plugin grant after the wildcard',
      text: '{"permission":{"*":"deny","webfetch":"allow"}}',
      reason: grantedAfterWildcard('webfetch'),
    },
    {
      name: 'an object value after the wildcard',
      text: '{"permission":{"*":"deny","bash":{"git *":"deny"}}}',
      reason: grantedAfterWildcard('bash'),
    },
    {
      name: 'an ask value after the wildcard',
      text: '{"permission":{"*":"deny","bash":"ask"}}',
      reason: grantedAfterWildcard('bash'),
    },
    {
      name: 'a grant in the permission of the build agent',
      text: '{"permission":{"*":"deny"},"agent":{"build":{"tools":{"bash":true},"options":{},"permission":{"bash":"allow"}}}}',
      reason: grantedByRunAgent('bash', 'build'),
    },
    {
      name: 'a grant in the permission of the default agent',
      text: '{"default_agent":"plan","permission":{"*":"deny"},"agent":{"build":{"permission":{"bash":"allow"}},"plan":{"permission":{"edit":"allow"}}}}',
      reason: grantedByRunAgent('edit', 'plan'),
    },
    {
      name: 'a disabled build agent without a default agent',
      text: '{"permission":{"*":"deny"},"agent":{"build":{"disable":true,"options":{},"permission":{}}}}',
      reason: UNKNOWN_RUN_AGENT,
    },
    {
      name: 'a hidden build agent without a default agent',
      text: '{"permission":{"*":"deny"},"agent":{"build":{"hidden":true}}}',
      reason: UNKNOWN_RUN_AGENT,
    },
    {
      name: 'a build agent demoted to a subagent',
      text: '{"permission":{"*":"deny"},"agent":{"build":{"mode":"subagent"}}}',
      reason: UNKNOWN_RUN_AGENT,
    },
    {
      name: 'a document array',
      text: '[{"type":"document","info":{}}]',
      reason: NOT_A_JSON_OBJECT,
    },
    { name: 'the empty string', text: '', reason: NOT_A_JSON_OBJECT },
    { name: 'text that is not JSON', text: 'not json', reason: NOT_A_JSON_OBJECT },
    { name: 'a JSON string', text: '"x"', reason: NOT_A_JSON_OBJECT },
    { name: 'a JSON null', text: 'null', reason: NOT_A_JSON_OBJECT },
    {
      name: 'a permission without a wildcard',
      text: '{"permission":{"read":"allow"}}',
      reason: NO_WILDCARD,
    },
    {
      name: 'a wildcard that allows',
      text: '{"permission":{"*":"allow"}}',
      reason: WILDCARD_NOT_DENY,
    },
    {
      name: 'a wildcard that masks its value',
      text: '{"permission":{"*":"***"}}',
      reason: WILDCARD_NOT_DENY,
    },
    {
      name: 'a wildcard that holds an object',
      text: '{"permission":{"*":{"*":"deny"}}}',
      reason: WILDCARD_NOT_DENY,
    },
  ])('reports the clause for $name', ({ text, reason }) => {
    expect(decodeToolDenial(text)).toEqual({ denied: false, reason });
  });

  it.each([
    { name: 'a null permission', text: '{"permission":null}', field: '"permission"' },
    { name: 'an array permission', text: '{"permission":[]}', field: '"permission"' },
    { name: 'a string permission', text: '{"permission":"deny"}', field: '"permission"' },
    {
      name: 'a numeric default agent',
      text: '{"permission":{"*":"deny"},"default_agent":3}',
      field: '"default_agent"',
    },
    {
      name: 'a null default agent',
      text: '{"permission":{"*":"deny"},"default_agent":null}',
      field: '"default_agent"',
    },
    {
      name: 'an array agent block',
      text: '{"permission":{"*":"deny"},"agent":[]}',
      field: '"agent"',
    },
    {
      name: 'a null agent block',
      text: '{"permission":{"*":"deny"},"agent":null}',
      field: '"agent"',
    },
    {
      name: 'a non-object build agent',
      text: '{"permission":{"*":"deny"},"agent":{"build":"x"}}',
      field: 'the agent "build"',
    },
    {
      name: 'a non-object selected agent',
      text: '{"default_agent":"x","permission":{"*":"deny"},"agent":{"x":[]}}',
      field: 'the agent "x"',
    },
    {
      name: 'a non-object agent permission',
      text: '{"default_agent":"x","permission":{"*":"deny"},"agent":{"x":{"permission":"deny"}}}',
      field: 'the permission of agent "x"',
    },
    {
      name: 'a null agent permission',
      text: '{"permission":{"*":"deny"},"agent":{"build":{"permission":null}}}',
      field: 'the permission of agent "build"',
    },
  ])('reports a shape tevu does not read for $name', ({ text, field }) => {
    expect(decodeToolDenial(text)).toEqual({ denied: false, reason: unread(field) });
  });

  it('reads only the permission of the agent a model call uses', () => {
    const text =
      '{"permission":{"*":"deny"},"agent":{"build":{"permission":{"bash":"deny"}},"plan":{"permission":{"bash":"allow"}}}}';

    expect(decodeToolDenial(text)).toEqual({ denied: true });
  });

  it('judges the keys after the wildcard in key order, so an integer-like key counts as before it', () => {
    const text = '{"permission":{"*":"deny","7":"allow"}}';

    expect(decodeToolDenial(text)).toEqual({ denied: true });
  });

  it('names the first offending key after the wildcard', () => {
    const text = '{"permission":{"*":"deny","a":"deny","b":"allow","c":"allow"}}';

    expect(decodeToolDenial(text)).toEqual({ denied: false, reason: grantedAfterWildcard('b') });
  });

  it('enters a key and an agent name into a clause as written, without escaping', () => {
    const keyed = decodeToolDenial('{"permission":{"*":"deny","a\\"b\\\\c":"allow"}}');
    const agent = decodeToolDenial(
      '{"default_agent":"x\\"y","permission":{"*":"deny"},"agent":{"x\\"y":{"permission":{"k\\"":"allow"}}}}',
    );

    expect(keyed).toEqual({ denied: false, reason: grantedAfterWildcard('a"b\\c') });
    expect(agent).toEqual({ denied: false, reason: grantedByRunAgent('k"', 'x"y') });
  });

  it('treats a permission key named like an object prototype member as an ordinary key', () => {
    expect(decodeToolDenial('{"permission":{"*":"deny","__proto__":"allow"}}')).toEqual({
      denied: false,
      reason: grantedAfterWildcard('__proto__'),
    });
    expect(decodeToolDenial('{"default_agent":"constructor","permission":{"*":"deny"}}')).toEqual({
      denied: true,
    });
  });

  it.each([
    { name: 'a JSON null', text: 'null' },
    { name: 'a JSON string', text: '"x"' },
    { name: 'an empty array', text: '[]' },
    { name: 'a null permission', text: '{"permission":null}' },
    { name: 'an empty array permission', text: '{"permission":[]}' },
    { name: 'a non-object agent block', text: '{"permission":{"*":"deny"},"agent":[]}' },
    { name: 'a numeric default agent', text: '{"permission":{"*":"deny"},"default_agent":3}' },
    { name: 'a deeply nested array', text: `${'['.repeat(200_000)}${']'.repeat(200_000)}` },
    { name: 'a one megabyte string', text: `"${'x'.repeat(1024 * 1024)}"` },
    { name: 'binary garbage', text: '\u0000\u0001�{\n"\n}}{{' },
  ])('never throws for $name', ({ text }) => {
    expect(() => decodeToolDenial(text)).not.toThrow();
  });
});

const SECRET = 'synthetic-acme-secret-value';

function buildExport(messageInfo: Record<string, unknown>, part: Record<string, unknown> = {}) {
  return {
    info: { id: 'ses-1', additiveInfoField: 1 },
    messages: [
      {
        info: { id: 'm1', sessionID: 'ses-1', ...messageInfo },
        parts: [{ id: 'p1', sessionID: 'ses-1', messageID: 'm1', type: 'tool', ...part }],
        additiveMessageField: 1,
      },
    ],
    additiveTopLevelField: 1,
  };
}

describe('decoders keep additive fields in the record and the view', () => {
  it('keeps additive event and part fields at every level of a decoded event', () => {
    const input = {
      type: 'tool_use',
      timestamp: 5,
      sessionID: 'ses-1',
      additiveEventField: 1,
      part: { id: 'p1', sessionID: 'ses-1', messageID: 'm1', type: 'tool', additivePartField: 2 },
    };

    const decoded = decodeEvent(input, CASE_CONTEXT, 1);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toMatchObject({ additiveEventField: 1, part: { additivePartField: 2 } });
  });

  it('keeps additive export fields at every level in the view and returns the input as the record', () => {
    const input = buildExport({
      role: 'assistant',
      additiveInfoField: 1,
      tokens: { input: 1, additiveTokensField: 1, cache: { read: 1, additiveCacheField: 1 } },
    });

    const decoded = decodeExport(input, CASE_CONTEXT);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.record).toBe(input);
    const view = decoded.value.view;
    expect(view).toMatchObject({ additiveTopLevelField: 1, info: { additiveInfoField: 1 } });
    expect(view.messages[0]).toMatchObject({
      additiveMessageField: 1,
      info: {
        additiveInfoField: 1,
        tokens: { additiveTokensField: 1, cache: { additiveCacheField: 1 } },
      },
    });
  });
});

describe('decoders never turn a lenient field into a protocol error', () => {
  it.each([
    { name: 'an absent cost', info: { role: 'assistant' } },
    { name: 'a malformed cost', info: { role: 'assistant', cost: 'free' } },
    { name: 'a malformed role', info: { role: 7 } },
    { name: 'a malformed error', info: { role: 'assistant', error: 3 } },
    { name: 'a malformed finish', info: { role: 'assistant', finish: false } },
    { name: 'tokens that is not an object', info: { role: 'assistant', tokens: 5 } },
    { name: 'tokens that is a list', info: { role: 'assistant', tokens: [1] } },
    { name: 'a cache that is not an object', info: { role: 'assistant', tokens: { cache: 'x' } } },
    {
      name: 'malformed token counts',
      info: { role: 'assistant', tokens: { input: 'a', output: null, reasoning: {}, cache: {} } },
    },
  ])('decodes an export with $name', ({ info }) => {
    const decoded = decodeExport(buildExport(info), CASE_CONTEXT);

    expect(decoded.ok).toBe(true);
  });

  it('reads a container that is not an object as absent in the view and keeps it in the record', () => {
    const decoded = decodeExport(
      buildExport({ role: 'assistant', tokens: { input: 1, cache: 'x' } }),
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.view.messages[0]?.info.tokens).toMatchObject({ input: 1 });
    expect(decoded.value.view.messages[0]?.info.tokens?.cache).toBeUndefined();
    expect(JSON.stringify(decoded.value.record)).toContain('"cache":"x"');
  });

  it.each([{ tool: 7 }, { tool: null }, {}])('decodes a tool part holding %j', (part) => {
    const decoded = decodeExport(buildExport({ role: 'assistant' }, part), CASE_CONTEXT);

    expect(decoded.ok).toBe(true);
  });

  it.each([
    { name: 'a numeric text', part: { type: 'text', text: 5 } },
    { name: 'a null text', part: { type: 'text', text: null } },
    { name: 'a string synthetic flag', part: { type: 'text', synthetic: 'yes' } },
    { name: 'a numeric ignored flag', part: { type: 'text', ignored: 0 } },
  ])('decodes an export and an event holding a part with $name', ({ part }) => {
    const decodedExport = decodeExport(buildExport({ role: 'assistant' }, part), CASE_CONTEXT);
    const decodedEvent = decodeEvent(
      {
        type: 'text',
        timestamp: 1,
        sessionID: 'ses-1',
        part: { id: 'p1', sessionID: 'ses-1', messageID: 'm1', ...part },
      },
      CASE_CONTEXT,
    );

    expect(decodedExport.ok).toBe(true);
    expect(decodedEvent.ok).toBe(true);
  });

  it.each([3, 'boom', null, { message: 'x' }])(
    'decodes an error event whose error holds %j',
    (error) => {
      const decoded = decodeEvent(
        { type: 'error', timestamp: 1, sessionID: 'ses-1', error },
        CASE_CONTEXT,
      );

      expect(decoded.ok).toBe(true);
    },
  );

  it('decodes an error event without an error value and a tool event without a tool name', () => {
    const errorEvent = decodeEvent(
      { type: 'error', timestamp: 1, sessionID: 'ses-1' },
      CASE_CONTEXT,
    );
    const toolEvent = decodeEvent(
      {
        type: 'tool_use',
        timestamp: 1,
        sessionID: 'ses-1',
        part: { id: 'p1', sessionID: 'ses-1', messageID: 'm1', type: 'tool', tool: 3 },
      },
      CASE_CONTEXT,
    );

    expect(errorEvent.ok).toBe(true);
    expect(toolEvent.ok).toBe(true);
  });
});

describe('decodeExport root-session rules', () => {
  it('rejects an export whose info holds a parentID with the child-session reason', () => {
    const decoded = decodeExport(
      { info: { id: 'ses-child', parentID: 'ses-root' }, messages: [] },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'child session export "ses-child" rejected: schema version 1 consumes only the root session',
    );
  });

  it.each([5, ''])('names info.parentID when it holds %j', (parentID) => {
    const decoded = decodeExport({ info: { id: 'ses-1', parentID }, messages: [] }, CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'export record does not match the consumed export layout at info.parentID',
    );
  });
});

describe('decoder reasons carry no value', () => {
  it('keeps a secret out of an event reason when a field expecting a number holds it', () => {
    const decoded = decodeEvent(
      { type: 'error', timestamp: SECRET, sessionID: 'ses-1' },
      CASE_CONTEXT,
      4,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'event record does not match the consumed event layout at timestamp',
    );
    expect(JSON.stringify(decoded.error)).not.toContain(SECRET);
  });

  it.each([
    { name: 'messages', input: { info: { id: 'ses-1' }, messages: SECRET }, path: 'messages' },
    { name: 'info', input: { info: SECRET, messages: [] }, path: 'info' },
    {
      name: 'a part',
      input: buildExportWithPart(SECRET),
      path: 'messages.0.parts.0',
    },
  ])('keeps a secret out of an export reason when $name holds it', ({ input, path }) => {
    const decoded = decodeExport(input, CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      `export record does not match the consumed export layout at ${path}`,
    );
    expect(JSON.stringify(decoded.error)).not.toContain(SECRET);
  });
});

function buildExportWithPart(part: unknown) {
  return {
    info: { id: 'ses-1' },
    messages: [{ info: { id: 'm1', sessionID: 'ses-1' }, parts: [part] }],
  };
}
