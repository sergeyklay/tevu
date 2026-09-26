import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRedactor, createSecretRedactor, runManagedProcess } from '@/adapters/process';

import { createOpenCodeAdapter } from './opencode';
import { exportMessageIdentity, exportPartIdentity, normalizeMetrics } from './opencode-metrics';

import type { OpenCodeAdapterDependencies } from './opencode';
import type { OpenCodeExport, OpenCodePart } from './opencode-protocol';
import type {
  AgentRunResult,
  IsolatedEnvironment,
  ManagedProcessRequest,
  ManagedProcessResult,
  ManagedProcessRunner,
  SecretRedactor,
} from '@/domain/types';

const CASE_ID = 'task-1--alpha--1';
const FIXTURE_DIRECTORY = new URL('./fixtures/', import.meta.url);

function readTextFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIRECTORY), 'utf8');
}

function readJsonFixture(name: string): unknown {
  return JSON.parse(readTextFixture(name)) as unknown;
}

/** Raw, undecoded event records so `normalizeMetrics` exercises its own decode-first path. */
function readRawFixtureEvents(name: string): unknown[] {
  return readTextFixture(name)
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown);
}

function buildSecretRedactor(secretValues: readonly string[]): SecretRedactor {
  return createSecretRedactor(() => secretValues, createRedactor(secretValues));
}

function buildAlwaysFailingSecretRedactor(): SecretRedactor {
  return {
    secretValues: () => [],
    redactText: (text) => text,
    redactValue: () => ({
      ok: false,
      error: {
        kind: 'ArtifactError',
        operation: 'redact-record',
        reason: 'record redaction failed',
      },
    }),
  };
}

function buildDependencies(
  overrides: Partial<OpenCodeAdapterDependencies> = {},
): OpenCodeAdapterDependencies {
  return {
    runProcess: runManagedProcess,
    secrets: buildSecretRedactor([]),
    probeEnvironment: { PATH: process.env['PATH'] ?? '' },
    probeDirectory: process.cwd(),
    ...overrides,
  };
}

describe('normalizeMetrics from the root session export', () => {
  it('sums tokens, cost, and activity exactly once by message and part identity from the valid fixture', () => {
    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: readJsonFixture('session-valid.json') as never,
      events: [],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.inputTokens).toEqual({
      value: 130,
      unit: 'token',
      availability: { status: 'available', source: 'root-session export' },
      scope: 'root-session',
    });
    expect(normalized.value.outputTokens).toMatchObject({ value: 45 });
    expect(normalized.value.reasoningTokens).toMatchObject({ value: 16 });
    expect(normalized.value.cacheReadTokens).toMatchObject({ value: 30 });
    expect(normalized.value.cacheWriteTokens).toMatchObject({ value: 10 });
    expect(normalized.value.turns).toMatchObject({ value: 1 });
    expect(normalized.value.apiCalls).toMatchObject({ value: 2 });
    expect(normalized.value.apiErrors).toMatchObject({ value: 1 });
    expect(normalized.value.toolCalls).toMatchObject({ value: 2 });
    expect(normalized.value.skillCalls).toMatchObject({ value: 1 });
    expect(normalized.value.cost).toEqual({
      value: 0.0125,
      unit: 'USD',
      availability: { status: 'available', source: 'root-session export' },
      scope: 'root-session',
    });
  });

  it('retains root-session scope on every normalized metric and never claims session-tree scope', () => {
    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: readJsonFixture('session-valid.json') as never,
      events: [],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    for (const metric of Object.values(normalized.value)) {
      expect(metric.scope).toBe('root-session');
    }
  });

  it('measures a genuine zero when the export has no assistant records', () => {
    const sessionExport = {
      info: { id: 'ses-root-0001' },
      messages: [{ info: { id: 'msg-u1', sessionID: 'ses-root-0001', role: 'user' }, parts: [] }],
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: sessionExport as never,
      events: [],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    for (const metric of Object.values(normalized.value)) {
      expect(metric).toMatchObject({ value: 0, availability: { status: 'available' } });
    }
  });

  it('never adds event error counts to export error counts', () => {
    const rootError = {
      type: 'error',
      timestamp: 9000,
      sessionID: 'ses-root-0001',
      error: { message: 'synthetic error' },
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: readJsonFixture('session-valid.json') as never,
      events: [rootError, rootError],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.apiErrors).toMatchObject({
      value: 1,
      availability: { status: 'available', source: 'root-session export' },
    });
  });

  it('marks absent optional token fields unavailable while other metrics stay measured', () => {
    const sessionExport = {
      info: { id: 'ses-root-0001' },
      messages: [
        {
          info: {
            id: 'msg-a1',
            sessionID: 'ses-root-0001',
            role: 'assistant',
            finish: 'stop',
            cost: 0.5,
          },
          parts: [],
        },
      ],
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: sessionExport as never,
      events: [],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    for (const name of [
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ]) {
      expect(normalized.value[name as keyof typeof normalized.value]).toMatchObject({
        value: null,
        availability: { status: 'unavailable' },
      });
    }
    const inputAvailability = normalized.value.inputTokens.availability;
    expect(inputAvailability.status).toBe('unavailable');
    if (inputAvailability.status !== 'unavailable') return;
    expect(inputAvailability.reason).toBe(
      'field "tokens.input" is absent in export message "msg-a1"',
    );
    const cacheAvailability = normalized.value.cacheReadTokens.availability;
    expect(cacheAvailability.status).toBe('unavailable');
    if (cacheAvailability.status !== 'unavailable') return;
    expect(cacheAvailability.reason).toBe(
      'field "tokens.cache.read" is absent in export message "msg-a1"',
    );
    expect(normalized.value.cost).toMatchObject({
      value: 0.5,
      availability: { status: 'available' },
    });
    expect(normalized.value.turns).toMatchObject({ value: 1 });
  });

  it('marks a malformed cost field unavailable without inventing zero or an estimate', () => {
    const sessionExport = {
      info: { id: 'ses-root-0001' },
      messages: [
        {
          info: {
            id: 'msg-a1',
            sessionID: 'ses-root-0001',
            role: 'assistant',
            finish: 'stop',
            cost: 'not-a-number',
            tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [],
        },
      ],
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: sessionExport as never,
      events: [],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.cost).toEqual({
      value: null,
      unit: 'USD',
      availability: {
        status: 'unavailable',
        reason: 'field "cost" is malformed in export message "msg-a1"',
      },
      scope: 'root-session',
    });
    expect(normalized.value.inputTokens).toMatchObject({
      value: 3,
      availability: { status: 'available' },
    });
  });

  it('marks skill calls unavailable when a tool part has no tool name', () => {
    const sessionExport = {
      info: { id: 'ses-root-0001' },
      messages: [
        {
          info: {
            id: 'msg-a1',
            sessionID: 'ses-root-0001',
            role: 'assistant',
            finish: 'stop',
            cost: 0,
            tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
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
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: sessionExport as never,
      events: [],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.toolCalls).toMatchObject({
      value: 1,
      availability: { status: 'available' },
    });
    expect(normalized.value.skillCalls).toEqual({
      value: null,
      unit: 'count',
      availability: {
        status: 'unavailable',
        reason: 'tool name is absent or malformed on tool part "prt-x"',
      },
      scope: 'root-session',
    });
  });

  it('counts each message and part once when duplicates share identity', () => {
    const message = {
      info: {
        id: 'msg-a1',
        sessionID: 'ses-root-0001',
        role: 'assistant',
        finish: 'stop',
        cost: 0.25,
        tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      parts: [
        {
          id: 'prt-1',
          sessionID: 'ses-root-0001',
          messageID: 'msg-a1',
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed' },
        },
      ],
    };
    const sessionExport = {
      info: { id: 'ses-root-0001' },
      messages: [
        message,
        {
          info: {
            ...message.info,
            cost: 999,
            tokens: { input: 999, output: 999, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: message.parts,
        },
      ],
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: sessionExport as never,
      events: [],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.inputTokens).toMatchObject({ value: 100 });
    expect(normalized.value.cost).toMatchObject({ value: 0.25 });
    expect(normalized.value.turns).toMatchObject({ value: 1 });
    expect(normalized.value.toolCalls).toMatchObject({ value: 1 });
  });

  it.each([
    {
      scenario: 'the export session identity is missing',
      info: { id: '' },
      reason: 'export session identity (info.id) is missing or malformed',
    },
    {
      scenario: 'a message identity is missing',
      info: { id: 'ses-root-0001' },
      reason: 'export message identity (sessionID, id) is missing or malformed',
    },
  ])('returns a protocol failure when $scenario', ({ info, reason }) => {
    const sessionExport = {
      info,
      messages: [{ info: { id: '', sessionID: 'ses-root-0001', role: 'assistant' }, parts: [] }],
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: sessionExport as never,
      events: [],
    });

    expect(normalized.ok).toBe(false);
    if (normalized.ok) return;
    expect(normalized.error.kind).toBe('OpenCodeProtocolError');
    expect(normalized.error.context).toEqual({ phase: 'case', caseId: CASE_ID });
    expect(normalized.error.reason).toBe(reason);
  });

  it("returns a protocol failure when an undecoded export's part identity is malformed", () => {
    const sessionExport = {
      info: { id: 'ses-root-0001' },
      messages: [
        {
          info: { id: 'msg-u1', sessionID: 'ses-root-0001', role: 'user' },
          parts: [{ id: 'prt-1', sessionID: 'ses-root-0001', messageID: '', type: 'text' }],
        },
      ],
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: sessionExport as never,
      events: [],
    });

    expect(normalized.ok).toBe(false);
    if (normalized.ok) return;
    expect(normalized.error.reason).toBe(
      'part identity (sessionID, messageID, id) is missing or malformed',
    );
  });
});

describe('normalizeMetrics event fallback', () => {
  it('supplies only event-derived metrics when the export is unavailable and never fabricates the rest', () => {
    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: null,
      events: readRawFixtureEvents('events-valid.jsonl'),
      exportUnavailableReason: 'root session export unavailable: process failure',
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.apiErrors).toEqual({
      value: 1,
      unit: 'count',
      availability: { status: 'available', source: 'run events' },
      scope: 'root-session',
    });
    expect(normalized.value.toolCalls).toEqual({
      value: 2,
      unit: 'count',
      availability: { status: 'available', source: 'run events' },
      scope: 'root-session',
    });
    expect(normalized.value.skillCalls).toEqual({
      value: 1,
      unit: 'count',
      availability: { status: 'available', source: 'run events' },
      scope: 'root-session',
    });
    for (const name of [
      'inputTokens',
      'outputTokens',
      'reasoningTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'turns',
      'apiCalls',
      'cost',
    ]) {
      expect(normalized.value[name as keyof typeof normalized.value]).toMatchObject({
        value: null,
        availability: {
          status: 'unavailable',
          reason: 'root session export unavailable: process failure',
        },
        scope: 'root-session',
      });
    }
  });

  it('deduplicates repeated event part representations by (sessionID, part.id)', () => {
    const toolUse = {
      type: 'tool_use',
      timestamp: 1,
      sessionID: 'ses-root-0001',
      part: {
        id: 'prt-1',
        sessionID: 'ses-root-0001',
        messageID: 'msg-1',
        type: 'tool',
        callID: 'call-1',
        tool: 'bash',
        state: { status: 'completed' },
      },
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: null,
      events: [toolUse, toolUse, { ...toolUse, timestamp: 2 }],
      exportUnavailableReason: 'root session export unavailable',
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.toolCalls).toMatchObject({ value: 1 });
  });

  it('ignores events from sessions other than the identified root session', () => {
    const childToolUse = {
      type: 'tool_use',
      timestamp: 1,
      sessionID: 'ses-child-0001',
      part: {
        id: 'prt-c1',
        sessionID: 'ses-child-0001',
        messageID: 'msg-c1',
        type: 'tool',
        callID: 'call-c1',
        tool: 'bash',
        state: { status: 'completed' },
      },
    };
    const rootError = {
      type: 'error',
      timestamp: 2,
      sessionID: 'ses-root-0001',
      error: { message: 'root error only' },
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: null,
      events: [childToolUse, rootError],
      exportUnavailableReason: 'root session export unavailable',
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.toolCalls).toMatchObject({
      value: 0,
      availability: { status: 'available' },
    });
    expect(normalized.value.apiErrors).toMatchObject({ value: 1 });
  });

  it('marks every export-derived metric unavailable when no root session could be identified', () => {
    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: null,
      sessionExport: null,
      events: [],
      exportUnavailableReason: 'root session export unavailable: process failure',
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    for (const metric of Object.values(normalized.value)) {
      expect(metric).toMatchObject({
        value: null,
        availability: {
          status: 'unavailable',
          reason:
            'root session export unavailable: process failure; root session could not be identified',
        },
        scope: 'root-session',
      });
    }
  });

  it('marks skill calls unavailable from events when a tool part lacks its tool name', () => {
    const toolUse = {
      type: 'tool_use',
      timestamp: 1,
      sessionID: 'ses-root-0001',
      part: {
        id: 'prt-1',
        sessionID: 'ses-root-0001',
        messageID: 'msg-1',
        type: 'tool',
        state: { status: 'completed' },
      },
    };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: null,
      events: [toolUse],
      exportUnavailableReason: 'root session export unavailable',
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(normalized.value.toolCalls).toMatchObject({
      value: 1,
      availability: { status: 'available' },
    });
    expect(normalized.value.skillCalls).toMatchObject({
      value: null,
      availability: {
        status: 'unavailable',
        reason: 'tool name is absent or malformed on tool part "prt-1"',
      },
    });
  });

  it('returns a protocol failure when an event lacks session identity', () => {
    const malformed = { type: 'error', timestamp: 1, error: {} };

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: 'ses-root-0001',
      sessionExport: null,
      events: [malformed],
    });

    expect(normalized.ok).toBe(false);
    if (normalized.ok) return;
    expect(normalized.error.context).toEqual({ phase: 'case', caseId: CASE_ID });
    expect(normalized.error.reason).toBe(
      'event session identity (sessionID) is missing or malformed',
    );
  });
});

describe('export identity extractors', () => {
  it('identifies export messages by (sessionID, id)', () => {
    const first = exportMessageIdentity({ sessionID: 'ses-root-0001', id: 'msg-a1' });
    const sameSessionOtherMessage = exportMessageIdentity({
      sessionID: 'ses-root-0001',
      id: 'msg-a2',
    });
    const otherSessionSameMessage = exportMessageIdentity({
      sessionID: 'ses-root-0002',
      id: 'msg-a1',
    });

    expect(first).toBe('ses-root-0001\u0000msg-a1');
    expect(first).not.toBe(sameSessionOtherMessage);
    expect(first).not.toBe(otherSessionSameMessage);
  });

  it('identifies export parts by (sessionID, messageID, id)', () => {
    const part: OpenCodePart = {
      sessionID: 'ses-root-0001',
      messageID: 'msg-a1',
      id: 'prt-a1',
      type: 'text',
    };
    const same = { ...part };
    const otherMessage = { ...part, messageID: 'msg-a2' };

    expect(exportPartIdentity(part)).toBe(exportPartIdentity(same));
    expect(exportPartIdentity(part)).not.toBe(exportPartIdentity(otherMessage));
  });
});

const SYNTHETIC_SESSION = 'ses-synth-0001';

const SYNTHETIC_OPENCODE_SCRIPT = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const recordPath = process.env["TEVU_SYNTH_RECORD"] ?? "";
if (recordPath.length > 0) {
  writeFileSync(recordPath, JSON.stringify({ argv: args, cwd: process.cwd(), env: process.env }) + "\\n");
}
if (args[0] === "--version") { console.log("9.9.9-synthetic"); process.exit(0); }
if (args[0] === "--help") { console.log("usage: synthetic-opencode <command> [options]"); process.exit(0); }
if (args[0] === "run" && args[1] === "--help") {
  console.log("usage: opencode run --format json --model <model> --variant <variant> <prompt>");
  process.exit(0);
}
if (args[0] === "export" && args[1] === "--help") {
  console.log("usage: opencode export <session-id>");
  process.exit(0);
}
if (args[0] === "run") {
  const session = "${SYNTHETIC_SESSION}";
  const emit = (value) => console.log(JSON.stringify(value));
  const mode = process.env["TEVU_SYNTH_MODE"] ?? "events";
  if (mode === "empty") {
    // no output: the process identifies no root session
  } else if (mode === "nonjson") {
    console.log("this stdout line is not JSON at all");
  } else if (mode === "malformed-event") {
    emit({ type: "tool_use", timestamp: 10, sessionID: session, part: { sessionID: session, messageID: "msg-s1", type: "tool", callID: "call-1", tool: "bash", state: { status: "completed" } } });
  } else if (mode === "secret-string") {
    emit({ type: "error", timestamp: 1, sessionID: session, error: { message: "prefix " + process.env["TEVU_SYNTH_SECRET"] + " suffix" } });
  } else if (mode === "secret-number") {
    emit({ type: "error", timestamp: 45, sessionID: session, error: { message: "synthetic" } });
  } else if (mode === "ignores-stdin") {
    process.stderr.write("Error: You must provide a message or a command\\n");
    process.exit(1);
  } else if (mode === "self-kill") {
    process.kill(process.pid, "SIGKILL");
  } else {
    emit({ type: "step_start", timestamp: 1, sessionID: session, part: { id: "prt-s1", sessionID: session, messageID: "msg-s1", type: "step-start" } });
    emit({ type: "tool_use", timestamp: 2, sessionID: session, part: { id: "prt-s2", sessionID: session, messageID: "msg-s1", type: "tool", callID: "call-1", tool: "bash", state: { status: "completed" } } });
    emit({ type: "error", timestamp: 3, sessionID: session, error: { name: "SyntheticProviderError", message: "synthetic rate limit" } });
  }
  process.exit(Number(process.env["TEVU_SYNTH_EXIT"] ?? "0"));
}
if (args[0] === "export") {
  const requested = args[1] ?? "";
  const mode = process.env["TEVU_SYNTH_EXPORT"] ?? "root";
  if (mode === "mismatch") {
    console.log(JSON.stringify({ info: { id: "ses-other-9999" }, messages: [] }));
  } else if (mode === "child") {
    console.log(JSON.stringify({ info: { id: "ses-child-0001", parentID: requested }, messages: [] }));
  } else if (mode === "malformed") {
    console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "", sessionID: requested }, parts: [] }] }));
  } else if (mode === "nonjson") {
    console.log("export output is not JSON at all");
  } else if (mode === "secret-string") {
    console.log(JSON.stringify({
      info: { id: requested },
      messages: [{
        info: { id: "msg-e1", sessionID: requested, role: "assistant", parentID: "msg-e0", finish: "stop", cost: 0.5, tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } }, additiveNote: "prefix " + process.env["TEVU_SYNTH_SECRET"] + " suffix" },
        parts: [],
      }],
    }));
  } else if (mode === "secret-number") {
    console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-e1", sessionID: requested, role: "assistant", parentID: "msg-e0", finish: "stop", cost: 0.5, tokens: { input: 45, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [] }] }));
  } else {
    console.log(JSON.stringify({
      info: { id: requested, title: "synthetic session", additiveInfoField: true },
      additiveTopLevelField: { note: "tolerated" },
      messages: [{
        info: { id: "msg-e1", sessionID: requested, role: "assistant", parentID: "msg-e0", finish: "stop", cost: 0.5, tokens: { input: 3, output: 4, reasoning: 0, cache: { read: 0, write: 0 } } },
        parts: [{ id: "prt-e1", sessionID: requested, messageID: "msg-e1", type: "text", additivePartField: 1 }],
      }],
    }));
  }
  process.exit(0);
}
process.exit(3);
`;

const SYNTHETIC_MISSING_VARIANT_SCRIPT = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("8.8.8-missing-variant"); process.exit(0); }
if (args[0] === "--help") { console.log("usage: missing-variant-opencode <command>"); process.exit(0); }
if (args[0] === "run" && args[1] === "--help") {
  console.log("usage: opencode run --format json --model <model> <prompt>");
  process.exit(0);
}
if (args[0] === "export" && args[1] === "--help") {
  console.log("usage: opencode export <session-id>");
  process.exit(0);
}
process.exit(0);
`;

const SYNTHETIC_EXIT_FOUR_SCRIPT = `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("7.7.7-exit-four"); process.exit(0); }
process.exit(4);
`;

let tempRoot: string;
let syntheticExecutable: string;
let missingVariantExecutable: string;
let exitFourExecutable: string;
let scriptCounterValue = 0;

function scriptCounter(): number {
  scriptCounterValue += 1;
  return scriptCounterValue;
}

async function writeExecutable(name: string, body: string): Promise<string> {
  const filePath = join(tempRoot, name);
  await writeFile(filePath, body, { mode: 0o755 });
  await chmod(filePath, 0o755);
  return filePath;
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'tevu-opencode-metrics-'));
  syntheticExecutable = await writeExecutable('synthetic-opencode.mjs', SYNTHETIC_OPENCODE_SCRIPT);
  missingVariantExecutable = await writeExecutable(
    'synthetic-opencode-missing-variant.mjs',
    SYNTHETIC_MISSING_VARIANT_SCRIPT,
  );
  exitFourExecutable = await writeExecutable(
    'synthetic-opencode-exit-four.mjs',
    SYNTHETIC_EXIT_FOUR_SCRIPT,
  );
  await mkdir(join(tempRoot, 'synthetic-home'), { recursive: true });
  await mkdir(join(tempRoot, 'synthetic-tmp'), { recursive: true });
  process.env['TEVU_PARENT_SENTINEL'] = 'parent-only-value';
});

afterAll(async () => {
  delete process.env['TEVU_PARENT_SENTINEL'];
  await rm(tempRoot, { recursive: true, force: true });
});

function syntheticEnvironment(extra: Record<string, string>) {
  const home = join(tempRoot, 'synthetic-home');
  return {
    caseId: CASE_ID,
    recipient: 'agent' as const,
    homeDirectory: home,
    temporaryDirectory: join(tempRoot, 'synthetic-tmp'),
    variables: {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      TMPDIR: join(tempRoot, 'synthetic-tmp'),
      LANG: 'C.UTF-8',
      LC_ALL: 'C.UTF-8',
      CI: '1',
      ...extra,
    },
    variableManifest: [],
  };
}

const IDENTITY = {
  caseId: CASE_ID,
  taskId: 'task-1',
  modelId: 'alpha',
  attempt: 1,
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  model: 'vendor/model-alpha-synth',
  effort: 'effort-high',
  agent: 'opencode',
};

describe('OpenCode adapter over a synthetic executable', () => {
  it('reports runtime-probed capabilities with version provenance and an unenforceable isolation control', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const probe = await adapter.probe();

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.executable).toBe(syntheticExecutable);
    expect(probe.value.detectedVersion).toBe('9.9.9-synthetic');
    expect(probe.value.capabilities).toEqual([
      { name: 'run command', required: true, availability: 'available' },
      { name: 'export command', required: true, availability: 'available' },
      { name: 'run --format json', required: true, availability: 'available' },
      { name: 'run --model', required: true, availability: 'available' },
      { name: 'run --variant', required: true, availability: 'available' },
    ]);
    expect(probe.value.isolation.denyOutsideWorktree).toBe('unavailable');
  });

  it('fails capability probing with a probe-phase protocol error when a required option is missing', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: missingVariantExecutable },
      buildDependencies(),
    );

    const probe = await adapter.probe();

    expect(probe.ok).toBe(false);
    if (probe.ok || probe.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a probe-phase protocol error, got ${JSON.stringify(probe)}`);
    }
    expect(probe.error.context).toEqual({ phase: 'probe' });
    expect(probe.error.reason).toContain('missing required capabilities');
    expect(probe.error.reason).toContain('run --variant');
  });

  it('fails capability probing with a prerequisite error for a nonexistent executable', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: 'definitely-not-installed' },
      buildDependencies(),
    );

    const probe = await adapter.probe();

    expect(probe.ok).toBe(false);
    if (probe.ok || probe.error.kind !== 'PrerequisiteError') {
      throw new Error(`expected a prerequisite error, got ${JSON.stringify(probe)}`);
    }
    expect(probe.error.tool).toBe('opencode');
    expect(probe.error.expected).toContain('starts');
  });

  it('fails capability probing when the executable help invocation exits nonzero', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: exitFourExecutable },
      buildDependencies(),
    );

    const probe = await adapter.probe();

    expect(probe.ok).toBe(false);
    if (probe.ok || probe.error.kind !== 'PrerequisiteError') {
      throw new Error(`expected a prerequisite error, got ${JSON.stringify(probe)}`);
    }
    expect(probe.error.expected).toContain('--help" exits 0');
  });

  it('runs exactly one managed process with literal argv, the worktree cwd, and a replacement environment', async () => {
    const worktree = join(tempRoot, 'worktree-run');
    await mkdir(worktree, { recursive: true });
    const recordPath = join(tempRoot, `record-run-${scriptCounter()}.json`);
    const delivered: unknown[] = [];
    const diagnostics: string[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({
        TEVU_SYNTH_MODE: 'events',
        TEVU_SYNTH_RECORD: recordPath,
      }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async (event) => {
        delivered.push(event);
        return { ok: true, value: undefined };
      },
      onDiagnostic: async (line) => {
        diagnostics.push(line);
        return { ok: true, value: undefined };
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.sessionId).toBe(SYNTHETIC_SESSION);
    expect(outcome.value.parseFindings).toEqual([]);
    expect(outcome.value.process.exitCode).toBe(0);
    expect(outcome.value.process.terminationStage).toBe('none');
    expect(delivered.map((event) => (event as { type: string }).type)).toEqual([
      'step_start',
      'tool_use',
      'error',
    ]);
    expect(diagnostics).toEqual([]);

    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: outcome.value.sessionId,
      sessionExport: null,
      events: delivered,
    });
    expect(normalized.ok).toBe(true);

    const recorded = JSON.parse(await readFile(recordPath, 'utf8')) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
    expect(recorded.argv).toEqual([
      'run',
      '--format',
      'json',
      '--model',
      'vendor/model-alpha-synth',
      '--variant',
      'effort-high',
    ]);
    expect(recorded.cwd).toBe(worktree);
    expect(recorded.env['TEVU_PARENT_SENTINEL']).toBeUndefined();
    expect(recorded.env['TEVU_SYNTH_MODE']).toBe('events');
  });

  it('reports a case-context protocol error when the run output identifies no root session', async () => {
    const worktree = join(tempRoot, 'worktree-empty');
    await mkdir(worktree, { recursive: true });
    let onProcessResult: AgentRunResult | undefined;
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'empty' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async () => ({ ok: true, value: undefined }),
      onProcess: (result) => {
        onProcessResult = result;
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.error.context).toEqual({ phase: 'case', caseId: CASE_ID });
    expect(outcome.error.reason).toBe('run output did not identify a root session');
    expect(onProcessResult).toBeDefined();
    expect(onProcessResult?.sessionId).toBeNull();
  });

  it('routes non-JSON stdout to diagnostics and fails with a protocol error carrying the line number', async () => {
    const worktree = join(tempRoot, 'worktree-nonjson');
    await mkdir(worktree, { recursive: true });
    const diagnostics: string[] = [];
    const delivered: unknown[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'nonjson' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async (event) => {
        delivered.push(event);
        return { ok: true, value: undefined };
      },
      onDiagnostic: async (line) => {
        diagnostics.push(line);
        return { ok: true, value: undefined };
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.error.line).toBe(1);
    expect(outcome.error.reason).toBe('run output contains malformed JSON event framing');
    expect(delivered).toEqual([]);
    expect(diagnostics).toEqual(['this stdout line is not JSON at all']);
  });

  it('a protocol failure still outranks a nonzero exit', async () => {
    const worktree = join(tempRoot, 'worktree-nonjson-nonzero-exit');
    await mkdir(worktree, { recursive: true });
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'nonjson', TEVU_SYNTH_EXIT: '7' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.error.reason).toBe('run output contains malformed JSON event framing');
  });

  it('a signal-only death without a session resolves as a process error', async () => {
    const worktree = join(tempRoot, 'worktree-self-kill');
    await mkdir(worktree, { recursive: true });
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'self-kill' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: 'AgentProcessError',
        agent: 'opencode',
        caseId: CASE_ID,
        exitCode: null,
        signal: 'SIGKILL',
      },
    });
  });

  it('fails with the decoded event identity error and delivers no record', async () => {
    const worktree = join(tempRoot, 'worktree-malformed');
    await mkdir(worktree, { recursive: true });
    const delivered: unknown[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'malformed-event' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async (event) => {
        delivered.push(event);
        return { ok: true, value: undefined };
      },
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.error.line).toBe(1);
    expect(outcome.error.reason).toBe(
      'part identity (sessionID, messageID, id) is missing or malformed',
    );
    expect(delivered).toEqual([]);
  });

  it('returns a process error with the exit code for a nonzero run while keeping the session evidence', async () => {
    const worktree = join(tempRoot, 'worktree-exit');
    await mkdir(worktree, { recursive: true });
    let onProcessResult: AgentRunResult | undefined;
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'events', TEVU_SYNTH_EXIT: '7' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async () => ({ ok: true, value: undefined }),
      onProcess: (result) => {
        onProcessResult = result;
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toEqual({
      kind: 'AgentProcessError',
      agent: 'opencode',
      caseId: CASE_ID,
      exitCode: 7,
      signal: null,
    });
    expect(onProcessResult).toBeDefined();
    expect(onProcessResult?.sessionId).toBe(SYNTHETIC_SESSION);
    expect(onProcessResult?.process.exitCode).toBe(7);
  });

  it('an OpenCode build that ignores stdin resolves AgentProcessError with its stderr line as a diagnostic', async () => {
    const worktree = join(tempRoot, 'worktree-ignores-stdin');
    await mkdir(worktree, { recursive: true });
    const diagnostics: string[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'ignores-stdin' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async (line) => {
        diagnostics.push(line);
        return { ok: true, value: undefined };
      },
    });

    expect(outcome).toEqual({
      ok: false,
      error: {
        kind: 'AgentProcessError',
        agent: 'opencode',
        caseId: CASE_ID,
        exitCode: 1,
        signal: null,
      },
    });
    expect(
      diagnostics.some((line) => line.includes('You must provide a message or a command')),
    ).toBe(true);
  });

  it('exports the requested root session with additive fields retained, decodable by normalizeMetrics', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: 'root' }),
    );

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const serialized = JSON.stringify(exported.value);
    expect(serialized).toContain('additiveInfoField');
    expect(serialized).toContain('additiveTopLevelField');
    const normalized = normalizeMetrics({
      caseId: CASE_ID,
      sessionId: SYNTHETIC_SESSION,
      sessionExport: exported.value,
      events: [],
    });
    expect(normalized.ok).toBe(true);
  });

  it('rejects an export whose identity does not match the requested root session', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: 'mismatch' }),
    );

    expect(exported.ok).toBe(false);
    if (exported.ok || exported.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(exported)}`);
    }
    expect(exported.error.context).toEqual({ phase: 'case', caseId: CASE_ID });
    expect(exported.error.reason).toBe('export identity does not match the requested root session');
  });

  it('rejects a child-session export because schema version 1 consumes only the root session', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: 'child' }),
    );

    expect(exported.ok).toBe(false);
    if (exported.ok || exported.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(exported)}`);
    }
    expect(exported.error.reason).toBe(
      'child session export "ses-child-0001" rejected: schema version 1 consumes only the root session',
    );
  });

  it('rejects an export whose message identity is malformed', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: 'malformed' }),
    );

    expect(exported.ok).toBe(false);
    if (exported.ok || exported.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(exported)}`);
    }
    expect(exported.error.reason).toBe(
      'export message identity (sessionID, id) is missing or malformed',
    );
  });

  it('rejects a non-JSON export output with a protocol error', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: 'nonjson' }),
    );

    expect(exported.ok).toBe(false);
    if (exported.ok || exported.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(exported)}`);
    }
    expect(exported.error.reason).toBe('export output is not valid JSON');
  });

  it('never leaks a parent-environment sentinel into the synthetic process environment', async () => {
    const worktree = join(tempRoot, 'worktree-sentinel');
    await mkdir(worktree, { recursive: true });
    const recordPath = join(tempRoot, `record-sentinel-${scriptCounter()}.json`);
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies(),
    );

    await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({
        TEVU_SYNTH_MODE: 'events',
        TEVU_SYNTH_RECORD: recordPath,
      }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    const recorded = JSON.parse(await readFile(recordPath, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(recorded.env['TEVU_PARENT_SENTINEL']).toBeUndefined();
    expect(existsSync(recordPath)).toBe(true);
  });
});

/**
 * A fake `ManagedProcessRunner` that hands one fixed stdout payload to
 * `onStdout`, reports a clean exit, and records every request it receives
 * into `requests` so a test can inspect what the adapter built.
 */
function buildFakeRunner(
  stdout: string,
  requests: ManagedProcessRequest[] = [],
): ManagedProcessRunner {
  return async (request) => {
    requests.push(request);
    request.onStdout?.(stdout);
    const completion: ManagedProcessResult = {
      launched: true,
      exitCode: 0,
      signal: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      durationMs: 1000,
      timedOut: false,
      cancelled: false,
      terminationStage: 'none',
      stdout: { text: stdout, totalBytes: stdout.length, truncated: false },
      stderr: { text: '', totalBytes: 0, truncated: false },
    };
    return completion;
  };
}

function buildBareEnvironment(): IsolatedEnvironment {
  return {
    caseId: CASE_ID,
    recipient: 'agent',
    homeDirectory: '/synthetic/home',
    temporaryDirectory: '/synthetic/tmp',
    variables: {},
    variableManifest: [],
  };
}

describe('OpenCode adapter run request over an injected fake process', () => {
  it('carries the prompt as stdinText and puts no prompt text in argv', async () => {
    const events = [{ type: 'error', timestamp: 1, sessionID: SYNTHETIC_SESSION, error: 'boom' }];
    const stdout = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    const requests: ManagedProcessRequest[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: 'fake-opencode' },
      buildDependencies({ runProcess: buildFakeRunner(stdout, requests) }),
    );

    await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: '/synthetic/worktree',
      environment: buildBareEnvironment(),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.argv).toEqual([
      'fake-opencode',
      'run',
      '--format',
      'json',
      '--model',
      'vendor/model-alpha-synth',
      '--variant',
      'effort-high',
    ]);
    expect(request.argv.join(' ')).not.toContain('synthetic benchmark prompt');
    expect(request.stdinText).toBe('synthetic benchmark prompt');
  });
});

describe('OpenCode adapter delivery stopping over an injected fake process', () => {
  it('stops delivering further records after a failed onEvent delivery and reports no protocol failure', async () => {
    const events = [
      { type: 'error', timestamp: 1, sessionID: SYNTHETIC_SESSION, error: 'boom-one' },
      { type: 'error', timestamp: 2, sessionID: SYNTHETIC_SESSION, error: 'boom-two' },
    ];
    const stdout = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
    const delivered: unknown[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: 'fake-opencode' },
      buildDependencies({ runProcess: buildFakeRunner(stdout) }),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: '/synthetic/worktree',
      environment: buildBareEnvironment(),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async (event) => {
        delivered.push(event);
        return {
          ok: false,
          error: { kind: 'ArtifactError', operation: 'append-event', reason: 'disk full' },
        };
      },
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(delivered).toHaveLength(1);
    expect(outcome.value.sessionId).toBe(SYNTHETIC_SESSION);
    expect(outcome.value.process.exitCode).toBe(0);
  });
});

// The corpus below exercises the JSON value grammar: a secret containing
// newline, quote, and backslash reaches stdout escaped inside the
// executable's JSON output, so chunk-level literal redaction before parsing
// can never match it; a digit-only secret equal to a numeric field is
// byte-replaced before parsing and corrupts the record framing. No real
// OpenCode is involved.
describe('credential-secret redaction on OpenCode stdout streams', () => {
  it('removes an escape-serialized secret from decoded run-event string content', async () => {
    const worktree = join(tempRoot, 'worktree-secret-string');
    await mkdir(worktree, { recursive: true });
    const QUOTED_SECRET = 'tevu"sec\\ret\nx';
    const delivered: unknown[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies({ secrets: buildSecretRedactor([QUOTED_SECRET]) }),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({
        TEVU_SYNTH_MODE: 'secret-string',
        TEVU_SYNTH_SECRET: QUOTED_SECRET,
      }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async (event) => {
        delivered.push(event);
        return { ok: true, value: undefined };
      },
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(outcome.ok).toBe(true);
    const errorEvent = delivered[0] as { error?: { message?: unknown } };
    const message = String((errorEvent.error as { message?: unknown })['message']);
    expect(message).not.toContain(QUOTED_SECRET);
    expect(message).toContain('[REDACTED]');
  });

  it('leaves a digit-only secret appearing as a bare numeric field intact in run output', async () => {
    const worktree = join(tempRoot, 'worktree-secret-number');
    await mkdir(worktree, { recursive: true });
    const delivered: unknown[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies({ secrets: buildSecretRedactor(['45']) }),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'secret-number' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async (event) => {
        delivered.push(event);
        return { ok: true, value: undefined };
      },
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.parseFindings).toEqual([]);
    expect(delivered).toHaveLength(1);
    expect((delivered[0] as { type: string }).type).toBe('error');
    expect((delivered[0] as { timestamp: number }).timestamp).toBe(45);
  });

  it('removes an escape-serialized secret from the decoded export content', async () => {
    const QUOTED_SECRET = 'tevu"sec\\ret\nx';
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies({ secrets: buildSecretRedactor([QUOTED_SECRET]) }),
    );

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({
        TEVU_SYNTH_EXPORT: 'secret-string',
        TEVU_SYNTH_SECRET: QUOTED_SECRET,
      }),
    );

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const exportRecord = exported.value as unknown as OpenCodeExport;
    const note = (exportRecord.messages[0]?.info as Record<string, unknown>)['additiveNote'];
    expect(typeof note).toBe('string');
    expect(String(note)).not.toContain(QUOTED_SECRET);
    expect(String(note)).toContain('[REDACTED]');
  });

  it('leaves a digit-only token metric intact in the exported root session', async () => {
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies({ secrets: buildSecretRedactor(['45']) }),
    );

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: 'secret-number' }),
    );

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const exportRecord = exported.value as unknown as OpenCodeExport;
    const assistant = exportRecord.messages[0]?.info as {
      tokens?: { input?: unknown; output?: unknown };
      cost?: unknown;
    };
    expect(assistant.tokens?.input).toBe(45);
    expect(assistant.tokens?.output).toBe(4);
    expect(assistant.cost).toBe(0.5);
  });

  it('withholds every record and returns a fixed protocol failure when redaction always fails', async () => {
    const worktree = join(tempRoot, 'worktree-redaction-fails');
    await mkdir(worktree, { recursive: true });
    const delivered: unknown[] = [];
    const adapter = createOpenCodeAdapter(
      { agent: 'opencode', executable: syntheticExecutable },
      buildDependencies({ secrets: buildAlwaysFailingSecretRedactor() }),
    );

    const outcome = await adapter.run({
      identity: IDENTITY,
      prompt: 'synthetic benchmark prompt',
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: 'events' }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async (event) => {
        delivered.push(event);
        return { ok: true, value: undefined };
      },
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(outcome)}`);
    }
    expect(outcome.error.reason).toBe('record redaction failed; record withheld');
    expect(delivered).toEqual([]);

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: 'root' }),
    );
    expect(exported.ok).toBe(false);
    if (exported.ok || exported.error.kind !== 'AgentProtocolError') {
      throw new Error(`expected a protocol failure, got ${JSON.stringify(exported)}`);
    }
    expect(exported.error.reason).toBe('record redaction failed; record withheld');
  });
});

describe('createSecretRedactor', () => {
  it('returns ArtifactError instead of throwing for a circular value', () => {
    const redactor = buildSecretRedactor([]);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    const result = redactor.redactValue(circular);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'ArtifactError',
        operation: 'redact-record',
        reason: 'record redaction failed',
      },
    });
  });
});
