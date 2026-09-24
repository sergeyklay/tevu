// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildTaskPrompt, createOpenCodeAdapter } from "./opencode.ts";
import {
  decodeEvent,
  decodeExport,
  eventIdentity,
  exportMessageIdentity,
  exportPartIdentity,
  listMalformedOptionalMetricFields,
} from "./opencode-protocol.ts";
import { TevuConfigSchema } from "../config/schema.ts";

import type { ProtocolContext } from "./opencode-protocol.ts";
import type { ModelDefinitionInput, TaskDefinition, TaskInput } from "../config/schema.ts";
import type {
  IsolatedEnvironment,
  OpenCodeAdapter,
  OpenCodeRunEvent,
  OpenCodeRunResult,
  TevuError,
} from "../domain/types.ts";

type ProtocolFailure = Extract<TevuError, { kind: "OpenCodeProtocolError" }>;
type RunOutcome = Awaited<ReturnType<OpenCodeAdapter["run"]>>;
type ExportOutcome = Awaited<ReturnType<OpenCodeAdapter["exportSession"]>>;

function expectRunProtocolError(outcome: RunOutcome): ProtocolFailure {
  if (outcome.ok) {
    throw new Error(`expected a run protocol failure, got success: ${JSON.stringify(outcome.value)}`);
  }
  if (outcome.error.kind !== "OpenCodeProtocolError") {
    throw new Error(`expected OpenCodeProtocolError, got ${JSON.stringify(outcome.error)}`);
  }
  return outcome.error;
}

function expectExportProtocolError(outcome: ExportOutcome): ProtocolFailure {
  if (outcome.ok) {
    throw new Error(`expected an export protocol failure, got success: ${JSON.stringify(outcome.value)}`);
  }
  if (outcome.error.kind !== "OpenCodeProtocolError") {
    throw new Error(`expected OpenCodeProtocolError, got ${JSON.stringify(outcome.error)}`);
  }
  return outcome.error;
}

const CASE_CONTEXT: ProtocolContext = { phase: "case", caseId: "task-1--alpha" };
const FIXTURE_DIRECTORY = new URL("./opencode-protocol.fixtures/", import.meta.url);

function readTextFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURE_DIRECTORY), "utf8");
}

function readJsonFixture(name: string): unknown {
  return JSON.parse(readTextFixture(name)) as unknown;
}

function validFixtureEvents(): OpenCodeRunEvent[] {
  const events: OpenCodeRunEvent[] = [];
  for (const [index, line] of readTextFixture("events-valid.jsonl").trim().split("\n").entries()) {
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
  return readTextFixture("events-malformed.jsonl").trim().split("\n");
}

function expectProtocolError(
  decoded: { ok: boolean; error?: { kind: string; context?: unknown; line?: number; reason: string } },
  reason: string,
): void {
  expect(decoded.ok).toBe(false);
  if (decoded.ok) return;
  expect(decoded.error?.kind).toBe("OpenCodeProtocolError");
  expect(decoded.error?.reason).toBe(reason);
}

const SYNTHETIC_SESSION = "ses-synth-0001";

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
  tempRoot = await mkdtemp(join(tmpdir(), "tevu-opencode-protocol-"));
  syntheticExecutable = await writeExecutable("synthetic-opencode.mjs", SYNTHETIC_OPENCODE_SCRIPT);
  missingVariantExecutable = await writeExecutable(
    "synthetic-opencode-missing-variant.mjs",
    SYNTHETIC_MISSING_VARIANT_SCRIPT,
  );
  exitFourExecutable = await writeExecutable(
    "synthetic-opencode-exit-four.mjs",
    SYNTHETIC_EXIT_FOUR_SCRIPT,
  );
  await mkdir(join(tempRoot, "synthetic-home"), { recursive: true });
  await mkdir(join(tempRoot, "synthetic-tmp"), { recursive: true });
  process.env["TEVU_PARENT_SENTINEL"] = "parent-only-value";
});

afterAll(async () => {
  delete process.env["TEVU_PARENT_SENTINEL"];
  await rm(tempRoot, { recursive: true, force: true });
});

function syntheticEnvironment(extra: Record<string, string>): IsolatedEnvironment {
  const home = join(tempRoot, "synthetic-home");
  return {
    caseId: "task-1--alpha",
    recipient: "opencode",
    homeDirectory: home,
    temporaryDirectory: join(tempRoot, "synthetic-tmp"),
    variables: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_CACHE_HOME: join(home, ".cache"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      TMPDIR: join(tempRoot, "synthetic-tmp"),
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
      CI: "1",
      ...extra,
    },
    variableManifest: [],
  };
}

function buildTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: "task-1",
    title: "Synthetic welcome-route task",
    repo: "repo-1",
    base_commit: "0123456789abcdef0123456789abcdef01234567",
    description: "synthetic task description for the welcome route",
    prompt: "TEVU-PROMPT-BODY implement the welcome route",
    readiness: ["synthetic ready item"],
    checks: {
      acceptance: [
        {
          id: "acc-acceptance-command",
          description: "acceptance command exits zero",
          run: ["/synthetic/acceptance-probe", "--suite", "synthetic"],
          timeout: "5s",
          exit_codes: [0],
        },
      ],
      done: [
        {
          id: "dod-manual-review",
          description: "manual Definition of Done review",
          manual: true,
        },
      ],
    },
    ...overrides,
  };
}

function buildModel(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return { id: "alpha", model: "vendor/model-alpha-synth", effort: "effort-high", ...overrides };
}

/** Materializes one task through the schema so `buildTaskPrompt` sees every default resolved. */
function materializeTask(overrides: Partial<TaskInput> = {}): TaskDefinition {
  const config = TevuConfigSchema.parse({
    version: 1,
    run: { output_dir: "/synthetic/artifacts", concurrency: 1, timeout: "1m", stop_grace: "1s" },
    agents: { opencode: { command: "/synthetic/opencode" } },
    repositories: [{ id: "repo-1", path: "/synthetic/source" }],
    models: [buildModel(), buildModel({ id: "beta" })],
    tasks: [buildTask(overrides)],
  });
  const task = config.tasks[0];
  if (task === undefined) {
    throw new Error("expected the fixture configuration to materialize its task");
  }
  return task;
}

describe("decodeEvent", () => {
  it("decodes every consumed event line in the valid fixture and drops the additive unknown type", () => {
    const lines = readTextFixture("events-valid.jsonl").trim().split("\n");

    const decoded = lines.map((line, index) => decodeEvent(JSON.parse(line) as unknown, CASE_CONTEXT, index + 1));

    for (const [index, outcome] of decoded.entries()) {
      expect(outcome.ok, `fixture line ${index + 1} must decode`).toBe(true);
    }
    expect(decoded.filter((outcome) => outcome.ok && outcome.value !== null)).toHaveLength(8);
    expect(decoded[8]).toMatchObject({ ok: true, value: null });
  });

  it("preserves additive event and part fields as evidence on decoded records", () => {
    const events = validFixtureEvents();

    expect(events[0]).toMatchObject({ type: "step_start", additiveEventField: "tolerated" });
    const textEvent = events[1] as { part: Record<string, unknown> };
    expect(textEvent.part["additivePartField"]).toBe(true);
  });

  it.each([
    {
      number: 1,
      reason: "part identity (sessionID, messageID, id) is missing or malformed",
    },
    {
      number: 2,
      reason: "event session identity (sessionID) is missing or malformed",
    },
    {
      number: 3,
      reason: "part identity (sessionID, messageID, id) is missing or malformed",
    },
    {
      number: 4,
      reason: "part identity (sessionID, messageID, id) is missing or malformed",
    },
    {
      number: 5,
      reason: "event framing is malformed: missing type",
    },
    {
      number: 6,
      reason: "event session identity (sessionID) is missing or malformed",
    },
    {
      number: 8,
      reason: "part record is missing or not a JSON object",
    },
  ])(
    "rejects malformed fixture line $number as a required-identity protocol error",
    ({ number, reason }) => {
      const lines = malformedFixtureLines();
      const decoded = decodeEvent(JSON.parse(lines[number - 1]) as unknown, CASE_CONTEXT, number);

      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.error.kind).toBe("OpenCodeProtocolError");
      expect(decoded.error.context).toEqual(CASE_CONTEXT);
      expect(decoded.error.line).toBe(number);
      expect(decoded.error.reason).toBe(reason);
    },
  );

  it("accepts the tool part with an absent optional tool name instead of failing the protocol", () => {
    const lines = malformedFixtureLines();
    const decoded = decodeEvent(JSON.parse(lines[6]) as unknown, CASE_CONTEXT, 7);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).not.toBeNull();
    const event = decoded.value as { part: Record<string, unknown> };
    expect(event.part["id"]).toBe("prt-b6");
    expect(event.part["tool"]).toBeUndefined();
  });

  it("rejects non-object event records", () => {
    for (const input of [42, "text", [1, 2], null]) {
      const decoded = decodeEvent(input, CASE_CONTEXT, 1);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) continue;
      expect(decoded.error.reason).toBe("event record is not a JSON object");
    }
  });

  it("rejects non-finite timestamps as malformed framing", () => {
    const decoded = decodeEvent(JSON.parse('{"type":"text","timestamp":1e999,"sessionID":"ses-1","part":{"id":"p1","sessionID":"ses-1","messageID":"m1","type":"text"}}') as unknown, CASE_CONTEXT, 1);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe("event framing is malformed: missing or malformed timestamp");
  });

  it("reports probe-phase context without a line number", () => {
    const decoded = decodeEvent(42, { phase: "probe" });

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.context).toEqual({ phase: "probe" });
    expect(decoded.error.line).toBeUndefined();
  });
});

describe("eventIdentity", () => {
  it("identifies part events by (sessionID, part.id) regardless of the ordinal", () => {
    const events = validFixtureEvents();
    const stepStart = events[0];

    expect(eventIdentity(stepStart, 0)).toBe(eventIdentity(stepStart, 99));
    expect(eventIdentity(stepStart, 0)).toBe(`${stepStart.sessionID}\u0000prt-0001`);
  });

  it("separates identical part identities across different sessions", () => {
    const events = validFixtureEvents();
    const stepStart = events[0];
    const sibling: OpenCodeRunEvent = {
      type: "step_start",
      timestamp: 1,
      sessionID: "ses-sibling-0001",
      part: { id: "prt-0001", sessionID: "ses-sibling-0001", messageID: "msg-x", type: "step-start" },
    };

    expect(eventIdentity(stepStart, 0)).not.toBe(eventIdentity(sibling, 0));
  });

  it("identifies error events by session and ordinal so identical error records stay distinct", () => {
    const events = validFixtureEvents();
    const errorEvent = events[7];

    expect(eventIdentity(errorEvent, 0)).not.toBe(eventIdentity(errorEvent, 1));
    expect(eventIdentity(errorEvent, 2)).toBe(`${errorEvent.sessionID}\u0000error\u00002`);
  });
});

describe("decodeExport", () => {
  it("decodes the valid fixture export and retains additive fields", () => {
    const decoded = decodeExport(readJsonFixture("session-valid.json"), CASE_CONTEXT);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.info.id).toBe("ses-root-0001");
    expect(decoded.value.messages).toHaveLength(4);
    const serialized = JSON.stringify(decoded.value);
    expect(serialized).toContain("additiveTopLevelField");
    expect(serialized).toContain("additiveInfoField");
    expect(serialized).toContain("additiveAssistantField");
    expect(serialized).toContain("additivePartField");
  });

  it("rejects the malformed fixture export as a child session", () => {
    const decoded = decodeExport(readJsonFixture("session-malformed.json"), CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.context).toEqual(CASE_CONTEXT);
    expect(decoded.error.reason).toBe(
      'child session export "ses-child-0001" rejected: schema version 1 consumes only the root session',
    );
  });

  it("rejects exports without a session identity", () => {
    const decoded = decodeExport({ info: { id: "" }, messages: [] }, CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe("export session identity (info.id) is missing or malformed");
  });

  it("rejects exports whose messages are not an array", () => {
    const decoded = decodeExport({ info: { id: "ses-1" }, messages: "not-an-array" }, CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe("export is malformed: messages is not an array");
  });

  it("rejects exports with a malformed message identity", () => {
    const decoded = decodeExport(
      { info: { id: "ses-1" }, messages: [{ info: { id: "msg-1", sessionID: "" }, parts: [] }] },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe("export message identity (sessionID, id) is missing or malformed");
  });

  it("rejects exports whose message parts are not an array", () => {
    const decoded = decodeExport(
      {
        info: { id: "ses-1" },
        messages: [{ info: { id: "m1", sessionID: "ses-1", role: "user" }, parts: "nope" }],
      },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe('export message "m1" is malformed: parts is not an array');
  });

  it("rejects exports with a malformed part identity", () => {
    const decoded = decodeExport(
      {
        info: { id: "ses-1" },
        messages: [
          {
            info: { id: "m1", sessionID: "ses-1", role: "user" },
            parts: [{ id: "p1", sessionID: "ses-1", messageID: "", type: "text" }],
          },
        ],
      },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe("part identity (sessionID, messageID, id) is missing or malformed");
  });

  it("rejects non-object export records", () => {
    const decoded = decodeExport([1, 2, 3], CASE_CONTEXT);

    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error.reason).toBe("export record is not a JSON object with an info record");
  });
});

describe("export identity extractors", () => {
  it("identifies export messages by (sessionID, id)", () => {
    const first = exportMessageIdentity({ sessionID: "ses-root-0001", id: "msg-a1" });
    const sameSessionOtherMessage = exportMessageIdentity({ sessionID: "ses-root-0001", id: "msg-a2" });
    const otherSessionSameMessage = exportMessageIdentity({ sessionID: "ses-root-0002", id: "msg-a1" });

    expect(first).toBe("ses-root-0001\u0000msg-a1");
    expect(first).not.toBe(sameSessionOtherMessage);
    expect(first).not.toBe(otherSessionSameMessage);
  });

  it("identifies export parts by (sessionID, messageID, id)", () => {
    const part = { sessionID: "ses-root-0001", messageID: "msg-a1", id: "prt-a1", type: "text" };
    const same = { ...part };
    const otherMessage = { ...part, messageID: "msg-a2" };

    expect(exportPartIdentity(part)).toBe(exportPartIdentity(same));
    expect(exportPartIdentity(part)).not.toBe(exportPartIdentity(otherMessage));
  });
});

describe("listMalformedOptionalMetricFields", () => {
  it("reports no findings for the fully populated valid fixture", () => {
    const decoded = decodeExport(readJsonFixture("session-valid.json"), CASE_CONTEXT);
    if (!decoded.ok) throw new Error("valid fixture must decode");

    expect(listMalformedOptionalMetricFields(decoded.value)).toEqual([]);
  });

  it("reports each absent or malformed optional metric field with its message identity", () => {
    const decoded = decodeExport(
      {
        info: { id: "ses-root-0001" },
        messages: [
          {
            info: { id: "msg-u1", sessionID: "ses-root-0001", role: "user" },
            parts: [],
          },
          {
            info: {
              id: "msg-a1",
              sessionID: "ses-root-0001",
              role: "assistant",
              finish: "stop",
              cost: "not-a-number",
              tokens: { output: 4, reasoning: 0, cache: { write: 0 } },
            },
            parts: [
              {
                id: "prt-x",
                sessionID: "ses-root-0001",
                messageID: "msg-a1",
                type: "tool",
                state: { status: "completed" },
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
    expect(findings).toContain('field "tokens.input" is absent or malformed in export message "msg-a1"');
    expect(findings).toContain('field "tokens.cache.read" is absent or malformed in export message "msg-a1"');
    expect(findings).toContain('tool name is absent or malformed on tool part "prt-x"');
    expect(findings).toHaveLength(4);
  });

  it("stays informative for decoded exports that metric normalization will degrade, never a protocol failure", () => {
    const decoded = decodeExport(
      { info: { id: "ses-1" }, messages: [{ info: { id: "m1", sessionID: "ses-1", role: "user" }, parts: [] }] },
      CASE_CONTEXT,
    );

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(listMalformedOptionalMetricFields(decoded.value)).toEqual([]);
  });
});

describe("buildTaskPrompt", () => {
  it("builds identical prompt bytes for every contender on the same task", () => {
    const task = materializeTask();

    const prompt = buildTaskPrompt(task);

    expect(prompt).toBe(buildTaskPrompt(task));
  });

  it("includes the prompt, description, check descriptions, and repository boundary instruction", () => {
    const task = materializeTask();

    const prompt = buildTaskPrompt(task);

    expect(prompt).toBe(
      [
        task.prompt,
        task.description,
        `Acceptance criteria:\n- ${task.checks.acceptance[0]?.description}`,
        `Definition of Done:\n- ${task.checks.done[0]?.description}`,
        "Work only inside the current repository. Do not read or modify any path outside this repository's working tree.",
      ].join("\n\n"),
    );
    expect(prompt).not.toContain("Pinned source commit");
    expect(prompt.toLowerCase()).not.toContain("0123456");
  });

  it("omits evaluator commands, contender identity, and Jira identity from the prompt", () => {
    const jiraTask = materializeTask({
      source: {
        kind: "jira",
        key: "TEVU-999",
        url: "https://jira.example.com/browse/TEVU-999",
        imported_at: "2026-09-22T12:00:00.000Z",
        title: "TEVU-JIRA-SUMMARY",
        body: "TEVU-JIRA-DESCRIPTION",
      },
    });
    const model: ModelDefinitionInput = buildModel();

    const prompt = buildTaskPrompt(jiraTask);

    expect(prompt).not.toContain("/synthetic/acceptance-probe");
    expect(prompt).not.toContain("TEVU-999");
    expect(prompt).not.toContain("TEVU-JIRA-DESCRIPTION");
    expect(prompt).not.toContain(model.model);
    expect(prompt).not.toContain(model.effort);
  });

  it("omits GitHub issue identity and imported body from the prompt", () => {
    const githubTask = materializeTask({
      source: {
        kind: "github",
        key: "octo/repo#42",
        url: "https://github.com/octo/repo/issues/42",
        imported_at: "2026-09-22T12:00:00.000Z",
        title: "TEVU-GITHUB-SUMMARY",
        body: "TEVU-GITHUB-DESCRIPTION",
      },
    });

    const prompt = buildTaskPrompt(githubTask);

    expect(prompt).not.toContain("octo/repo#42");
    expect(prompt).not.toContain("https://github.com/octo/repo/issues/42");
    expect(prompt).not.toContain("TEVU-GITHUB-SUMMARY");
    expect(prompt).not.toContain("TEVU-GITHUB-DESCRIPTION");
  });

  it("does not read the task's base commit", () => {
    const first = materializeTask({ base_commit: "0123456789abcdef0123456789abcdef01234567" });
    const second = materializeTask({ base_commit: "fedcba9876543210fedcba9876543210fedcba98" });

    expect(buildTaskPrompt(first)).toBe(buildTaskPrompt(second));
  });
});

describe("OpenCode adapter over a synthetic executable", () => {
  it("reports runtime-probed capabilities with version provenance and an unenforceable isolation control", async () => {
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const probe = await adapter.probe(syntheticExecutable);

    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.executable).toBe(syntheticExecutable);
    expect(probe.value.detectedVersion).toBe("9.9.9-synthetic");
    expect(probe.value.commands).toEqual({ run: "available", export: "available" });
    expect(probe.value.runOptions).toEqual({
      jsonFormat: "available",
      model: "available",
      variant: "available",
    });
    expect(probe.value.isolation.denyOutsideWorktree).toBe("unavailable");
  });

  it("fails capability probing with a probe-phase protocol error when a required option is missing", async () => {
    const adapter = createOpenCodeAdapter({
      executable: missingVariantExecutable,
      readSecretValues: () => [],
    });

    const probe = await adapter.probe(missingVariantExecutable);

    expect(probe.ok).toBe(false);
    if (probe.ok || probe.error.kind !== "OpenCodeProtocolError") {
      throw new Error(`expected a probe-phase protocol error, got ${JSON.stringify(probe)}`);
    }
    expect(probe.error.context).toEqual({ phase: "probe" });
    expect(probe.error.reason).toContain("missing required capabilities");
    expect(probe.error.reason).toContain("run --variant");
  });

  it("fails capability probing with a prerequisite error for a nonexistent executable", async () => {
    const adapter = createOpenCodeAdapter({ executable: "definitely-not-installed", readSecretValues: () => [] });

    const probe = await adapter.probe("definitely-not-installed");

    expect(probe.ok).toBe(false);
    if (probe.ok || probe.error.kind !== "PrerequisiteError") {
      throw new Error(`expected a prerequisite error, got ${JSON.stringify(probe)}`);
    }
    expect(probe.error.tool).toBe("opencode");
    expect(probe.error.expected).toContain("starts");
  });

  it("fails capability probing when the executable help invocation exits nonzero", async () => {
    const adapter = createOpenCodeAdapter({ executable: exitFourExecutable, readSecretValues: () => [] });

    const probe = await adapter.probe(exitFourExecutable);

    expect(probe.ok).toBe(false);
    if (probe.ok || probe.error.kind !== "PrerequisiteError") {
      throw new Error(`expected a prerequisite error, got ${JSON.stringify(probe)}`);
    }
    expect(probe.error.expected).toContain('--help" exits 0');
  });

  it("runs exactly one managed process with literal argv, the worktree cwd, and a replacement environment", async () => {
    const worktree = join(tempRoot, "worktree-run");
    await mkdir(worktree, { recursive: true });
    const recordPath = join(tempRoot, `record-run-${scriptCounter()}.json`);
    const delivered: OpenCodeRunEvent[] = [];
    const diagnostics: string[] = [];
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const outcome = await adapter.run({
      identity: {
        caseId: "task-1--alpha",
        taskId: "task-1",
        modelId: "alpha",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        model: "vendor/model-alpha-synth",
        effort: "effort-high",
      },
      executable: syntheticExecutable,
      prompt: "synthetic benchmark prompt",
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({
        TEVU_SYNTH_MODE: "events",
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
    expect(outcome.value.process.terminationStage).toBe("none");
    expect(delivered.map((event) => event.type)).toEqual(["step_start", "tool_use", "error"]);
    expect(diagnostics).toEqual([]);

    const recorded = JSON.parse(await readFile(recordPath, "utf8")) as {
      argv: string[];
      cwd: string;
      env: Record<string, string>;
    };
    expect(recorded.argv).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "vendor/model-alpha-synth",
      "--variant",
      "effort-high",
      "synthetic benchmark prompt",
    ]);
    expect(recorded.cwd).toBe(worktree);
    expect(Object.keys(recorded.env).sort()).toEqual([
      "CI",
      "HOME",
      "LANG",
      "LC_ALL",
      "PATH",
      "TEVU_SYNTH_MODE",
      "TEVU_SYNTH_RECORD",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ]);
    expect(recorded.env["TEVU_PARENT_SENTINEL"]).toBeUndefined();
    expect(recorded.env["TEVU_SYNTH_MODE"]).toBe("events");
  });

  it("reports a case-context protocol error when the run output identifies no root session", async () => {
    const worktree = join(tempRoot, "worktree-empty");
    await mkdir(worktree, { recursive: true });
    let onProcessResult: OpenCodeRunResult | undefined;
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const outcome = await adapter.run({
      identity: {
        caseId: "task-1--alpha",
        taskId: "task-1",
        modelId: "alpha",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        model: "vendor/model-alpha-synth",
        effort: "effort-high",
      },
      executable: syntheticExecutable,
      prompt: "synthetic benchmark prompt",
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: "empty" }),
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
    const error = expectRunProtocolError(outcome);
    expect(error.context).toEqual({ phase: "case", caseId: "task-1--alpha" });
    expect(error.reason).toBe("run output did not identify a root session");
    expect(onProcessResult).toBeDefined();
    expect(onProcessResult?.sessionId).toBeNull();
  });

  it("routes non-JSON stdout to diagnostics and fails with a protocol error carrying the line number", async () => {
    const worktree = join(tempRoot, "worktree-nonjson");
    await mkdir(worktree, { recursive: true });
    const diagnostics: string[] = [];
    const delivered: OpenCodeRunEvent[] = [];
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const outcome = await adapter.run({
      identity: {
        caseId: "task-1--alpha",
        taskId: "task-1",
        modelId: "alpha",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        model: "vendor/model-alpha-synth",
        effort: "effort-high",
      },
      executable: syntheticExecutable,
      prompt: "synthetic benchmark prompt",
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: "nonjson" }),
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
    const error = expectRunProtocolError(outcome);
    expect(error.line).toBe(1);
    expect(error.reason).toBe("run output contains malformed JSON event framing");
    expect(delivered).toEqual([]);
    expect(diagnostics).toEqual(["this stdout line is not JSON at all"]);
  });

  it("fails with the decoded event identity error and preserves the parse finding", async () => {
    const worktree = join(tempRoot, "worktree-malformed");
    await mkdir(worktree, { recursive: true });
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const outcome = await adapter.run({
      identity: {
        caseId: "task-1--alpha",
        taskId: "task-1",
        modelId: "alpha",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        model: "vendor/model-alpha-synth",
        effort: "effort-high",
      },
      executable: syntheticExecutable,
      prompt: "synthetic benchmark prompt",
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: "malformed-event" }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    expect(outcome.ok).toBe(false);
    const error = expectRunProtocolError(outcome);
    expect(error.line).toBe(1);
    expect(error.reason).toBe("part identity (sessionID, messageID, id) is missing or malformed");
  });

  it("returns a process error with the exit code for a nonzero run while keeping the session evidence", async () => {
    const worktree = join(tempRoot, "worktree-exit");
    await mkdir(worktree, { recursive: true });
    let onProcessResult: OpenCodeRunResult | undefined;
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const outcome = await adapter.run({
      identity: {
        caseId: "task-1--alpha",
        taskId: "task-1",
        modelId: "alpha",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        model: "vendor/model-alpha-synth",
        effort: "effort-high",
      },
      executable: syntheticExecutable,
      prompt: "synthetic benchmark prompt",
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: "events", TEVU_SYNTH_EXIT: "7" }),
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
      kind: "OpenCodeProcessError",
      caseId: "task-1--alpha",
      exitCode: 7,
      signal: null,
    });
    expect(onProcessResult).toBeDefined();
    expect(onProcessResult?.sessionId).toBe(SYNTHETIC_SESSION);
    expect(onProcessResult?.process.exitCode).toBe(7);
  });

  it("exports the requested root session with additive fields retained", async () => {
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: "root" }),
    );

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value.info.id).toBe(SYNTHETIC_SESSION);
    const serialized = JSON.stringify(exported.value);
    expect(serialized).toContain("additiveInfoField");
    expect(serialized).toContain("additiveTopLevelField");
    expect(exported.value.messages[0].info).toMatchObject({ role: "assistant", finish: "stop" });
  });

  it("rejects an export whose identity does not match the requested root session", async () => {
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: "mismatch" }),
    );

    expect(exported.ok).toBe(false);
    const error = expectExportProtocolError(exported);
    expect(error.context).toEqual({ phase: "case", caseId: "task-1--alpha" });
    expect(error.reason).toBe("export identity does not match the requested root session");
  });

  it("rejects a child-session export because schema version 1 consumes only the root session", async () => {
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: "child" }),
    );

    expect(exported.ok).toBe(false);
    const error = expectExportProtocolError(exported);
    expect(error.reason).toBe(
      'child session export "ses-child-0001" rejected: schema version 1 consumes only the root session',
    );
  });

  it("rejects an export whose message identity is malformed", async () => {
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: "malformed" }),
    );

    expect(exported.ok).toBe(false);
    const error = expectExportProtocolError(exported);
    expect(error.reason).toBe("export message identity (sessionID, id) is missing or malformed");
  });

  it("rejects a non-JSON export output with a protocol error", async () => {
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: "nonjson" }),
    );

    expect(exported.ok).toBe(false);
    const error = expectExportProtocolError(exported);
    expect(error.reason).toBe("export output is not valid JSON");
  });

  it("never leaks a parent-environment sentinel into the synthetic process environment", async () => {
    const worktree = join(tempRoot, "worktree-sentinel");
    await mkdir(worktree, { recursive: true });
    const recordPath = join(tempRoot, `record-sentinel-${scriptCounter()}.json`);
    const adapter = createOpenCodeAdapter({ executable: syntheticExecutable, readSecretValues: () => [] });

    await adapter.run({
      identity: {
        caseId: "task-1--alpha",
        taskId: "task-1",
        modelId: "alpha",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        model: "vendor/model-alpha-synth",
        effort: "effort-high",
      },
      executable: syntheticExecutable,
      prompt: "synthetic benchmark prompt",
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: "events", TEVU_SYNTH_RECORD: recordPath }),
      timeoutMs: 10000,
      terminationGraceMs: 250,
      cancellation: new AbortController().signal,
      onEvent: async () => ({ ok: true, value: undefined }),
      onDiagnostic: async () => ({ ok: true, value: undefined }),
    });

    const recorded = JSON.parse(await readFile(recordPath, "utf8")) as { env: Record<string, string> };
    expect(recorded.env["TEVU_PARENT_SENTINEL"]).toBeUndefined();
    expect(existsSync(recordPath)).toBe(true);
  });
});

// The corpus below exercises the JSON value grammar: a secret containing
// newline, quote, and backslash reaches stdout escaped inside the
// executable's JSON output, so chunk-level literal redaction before parsing
// can never match it; a digit-only secret equal to a numeric field is
// byte-replaced before parsing and corrupts the record framing. No real
// OpenCode is involved.
describe("credential-secret redaction on OpenCode stdout streams", () => {
  it("removes an escape-serialized secret from decoded run-event string content", async () => {
    const worktree = join(tempRoot, "worktree-secret-string");
    await mkdir(worktree, { recursive: true });
    const QUOTED_SECRET = 'tevu"sec\\ret\nx';
    const delivered: OpenCodeRunEvent[] = [];
    const adapter = createOpenCodeAdapter({
      executable: syntheticExecutable,
      readSecretValues: () => [QUOTED_SECRET],
    });

    const outcome = await adapter.run({
      identity: {
        caseId: "task-1--alpha",
        taskId: "task-1",
        modelId: "alpha",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        model: "vendor/model-alpha-synth",
        effort: "effort-high",
      },
      executable: syntheticExecutable,
      prompt: "synthetic benchmark prompt",
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({
        TEVU_SYNTH_MODE: "secret-string",
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
    const message = String((errorEvent.error as { message?: unknown })["message"]);
    expect(message).not.toContain(QUOTED_SECRET);
    expect(message).toContain("[REDACTED]");
  });

  it("leaves a digit-only secret appearing as a bare numeric field intact in run output", async () => {
    const worktree = join(tempRoot, "worktree-secret-number");
    await mkdir(worktree, { recursive: true });
    const delivered: OpenCodeRunEvent[] = [];
    const diagnostics: string[] = [];
    const adapter = createOpenCodeAdapter({
      executable: syntheticExecutable,
      readSecretValues: () => ["45"],
    });

    const outcome = await adapter.run({
      identity: {
        caseId: "task-1--alpha",
        taskId: "task-1",
        modelId: "alpha",
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        model: "vendor/model-alpha-synth",
        effort: "effort-high",
      },
      executable: syntheticExecutable,
      prompt: "synthetic benchmark prompt",
      worktreeDirectory: worktree,
      environment: syntheticEnvironment({ TEVU_SYNTH_MODE: "secret-number" }),
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
    expect(delivered[0].type).toBe("error");
    expect((delivered[0] as { timestamp: number }).timestamp).toBe(45);
  });

  it("removes an escape-serialized secret from the decoded export content", async () => {
    const QUOTED_SECRET = 'tevu"sec\\ret\nx';
    const adapter = createOpenCodeAdapter({
      executable: syntheticExecutable,
      readSecretValues: () => [QUOTED_SECRET],
    });

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: "secret-string", TEVU_SYNTH_SECRET: QUOTED_SECRET }),
    );

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const note = (exported.value.messages[0].info as Record<string, unknown>)["additiveNote"];
    expect(typeof note).toBe("string");
    expect(String(note)).not.toContain(QUOTED_SECRET);
    expect(String(note)).toContain("[REDACTED]");
  });

  it("leaves a digit-only token metric intact in the exported root session", async () => {
    const adapter = createOpenCodeAdapter({
      executable: syntheticExecutable,
      readSecretValues: () => ["45"],
    });

    const exported = await adapter.exportSession(
      SYNTHETIC_SESSION,
      syntheticEnvironment({ TEVU_SYNTH_EXPORT: "secret-number" }),
    );

    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    const assistant = exported.value.messages[0].info as {
      tokens?: { input?: unknown; output?: unknown };
      cost?: unknown;
    };
    expect(assistant.tokens?.input).toBe(45);
    expect(assistant.tokens?.output).toBe(4);
    expect(assistant.cost).toBe(0.5);
  });
});
