import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  decodeEvent,
  decodeExport,
  eventIdentity,
  listMalformedOptionalMetricFields,
} from './opencode-protocol';

import type { OpenCodeRunEvent, ProtocolContext } from './opencode-protocol';

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
    {
      number: 1,
      reason: 'part identity (sessionID, messageID, id) is missing or malformed',
    },
    {
      number: 2,
      reason: 'event session identity (sessionID) is missing or malformed',
    },
    {
      number: 3,
      reason: 'part identity (sessionID, messageID, id) is missing or malformed',
    },
    {
      number: 4,
      reason: 'part identity (sessionID, messageID, id) is missing or malformed',
    },
    {
      number: 5,
      reason: 'event framing is malformed: missing type',
    },
    {
      number: 6,
      reason: 'event session identity (sessionID) is missing or malformed',
    },
    {
      number: 8,
      reason: 'part record is missing or not a JSON object',
    },
  ])(
    'rejects malformed fixture line $number as a required-identity protocol error',
    ({ number, reason }) => {
      const lines = malformedFixtureLines();
      const decoded = decodeEvent(JSON.parse(lines[number - 1]) as unknown, CASE_CONTEXT, number);

      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.error.kind).toBe('OpenCodeProtocolError');
      expect(decoded.error.context).toEqual(CASE_CONTEXT);
      expect(decoded.error.line).toBe(number);
      expect(decoded.error.reason).toBe(reason);
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
      expect(decoded.error.reason).toBe('event record is not a JSON object');
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
    expect(decoded.error.reason).toBe('event framing is malformed: missing or malformed timestamp');
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

describe('decodeExport', () => {
  it('decodes the valid fixture export and retains additive fields', () => {
    const decoded = decodeExport(readJsonFixture('session-valid.json'), CASE_CONTEXT);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.info.id).toBe('ses-root-0001');
    expect(decoded.value.messages).toHaveLength(4);
    const serialized = JSON.stringify(decoded.value);
    expect(serialized).toContain('additiveTopLevelField');
    expect(serialized).toContain('additiveInfoField');
    expect(serialized).toContain('additiveAssistantField');
    expect(serialized).toContain('additivePartField');
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
    expect(decoded.error.reason).toBe('export session identity (info.id) is missing or malformed');
  });

  it('rejects exports whose messages are not an array', () => {
    const decoded = decodeExport({ info: { id: 'ses-1' }, messages: 'not-an-array' }, CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe('export is malformed: messages is not an array');
  });

  it('rejects exports with a malformed message identity', () => {
    const decoded = decodeExport(
      { info: { id: 'ses-1' }, messages: [{ info: { id: 'msg-1', sessionID: '' }, parts: [] }] },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe(
      'export message identity (sessionID, id) is missing or malformed',
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
    expect(decoded.error.reason).toBe('export message "m1" is malformed: parts is not an array');
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
      'part identity (sessionID, messageID, id) is missing or malformed',
    );
  });

  it('rejects non-object export records', () => {
    const decoded = decodeExport([1, 2, 3], CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe('export record is not a JSON object with an info record');
  });
});

describe('listMalformedOptionalMetricFields', () => {
  it('reports no findings for the fully populated valid fixture', () => {
    const decoded = decodeExport(readJsonFixture('session-valid.json'), CASE_CONTEXT);
    if (!decoded.ok) throw new Error('valid fixture must decode');

    expect(listMalformedOptionalMetricFields(decoded.value)).toEqual([]);
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

    const findings = listMalformedOptionalMetricFields(decoded.value);

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
    expect(listMalformedOptionalMetricFields(decoded.value)).toEqual([]);
  });
});
