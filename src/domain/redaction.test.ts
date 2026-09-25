import { describe, expect, it } from "vitest";

import { redactDecodedValue } from "./redaction.ts";

import type { Redactor } from "./types.ts";

// The secret is a literal backslash followed by "n", not a real newline. It
// only appears in the text once the payload's real newlines are JSON-escaped,
// so it is absent from the decoded strings below and present only in their
// serialized form.
const ESCAPED_NEWLINE_SECRET = "line1\\nline2";
const REAL_NEWLINE_VALUE = "line1\nline2";

function buildRedactor(secret: string): Redactor {
  return (text) => text.split(secret).join("[redacted]");
}

function buildThrowingRedactor(cause: unknown): Redactor {
  return () => {
    throw cause;
  };
}

describe("redactDecodedValue", () => {
  it("redacts a secret that matches only the JSON-escaped form of a string value", () => {
    const result = redactDecodedValue(buildRedactor(ESCAPED_NEWLINE_SECRET), {
      message: `x ${REAL_NEWLINE_VALUE} y`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(ESCAPED_NEWLINE_SECRET);
    expect(serialized).toContain("[redacted]");
    expect(result.value).toEqual({ message: "x [redacted] y" });
  });

  it("redacts a secret that matches only the JSON-escaped form of an object key", () => {
    const result = redactDecodedValue(buildRedactor(ESCAPED_NEWLINE_SECRET), {
      [REAL_NEWLINE_VALUE]: "value",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.value);
    expect(serialized).not.toContain(ESCAPED_NEWLINE_SECRET);
    expect(result.value).toEqual({ "[redacted]": "value" });
  });

  it("leaves numbers, booleans, and null untouched next to redacted strings", () => {
    const result = redactDecodedValue(buildRedactor(ESCAPED_NEWLINE_SECRET), {
      [REAL_NEWLINE_VALUE]: [`x ${REAL_NEWLINE_VALUE} y`, 42, true, null],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      "[redacted]": ["x [redacted] y", 42, true, null],
    });
    expect(JSON.stringify(result.value)).toBe('{"[redacted]":["x [redacted] y",42,true,null]}');
  });

  it("returns a RedactionError carrying the message of a thrown Error verbatim", () => {
    const result = redactDecodedValue(buildThrowingRedactor(new Error("synthetic redactor failure")), "value");

    expect(result).toEqual({
      ok: false,
      error: { kind: "RedactionError", reason: "synthetic redactor failure" },
    });
  });

  it("returns a RedactionError carrying the string form of a thrown non-Error value", () => {
    const result = redactDecodedValue(buildThrowingRedactor("boom"), "value");

    expect(result).toEqual({
      ok: false,
      error: { kind: "RedactionError", reason: "boom" },
    });
  });

  it("returns a RedactionError when the redactor returns a non-string", () => {
    const nonStringRedactor = ((_text: string) => 42) as unknown as Redactor;

    const result = redactDecodedValue(nonStringRedactor, "value");

    expect(result).toEqual({
      ok: false,
      error: { kind: "RedactionError", reason: "redaction returned no text" },
    });
  });

  it("returns a RedactionError when the value contains a circular reference", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    const result = redactDecodedValue(buildRedactor(ESCAPED_NEWLINE_SECRET), circular);

    expect(result).toEqual({
      ok: false,
      error: { kind: "RedactionError", reason: "value contains a circular reference" },
    });
  });

  it("falls back to the fixed reason when the thrown value cannot be converted to text", () => {
    const result = redactDecodedValue(buildThrowingRedactor(Object.create(null)), "value");

    expect(result).toEqual({
      ok: false,
      error: { kind: "RedactionError", reason: "thrown value cannot be converted to text" },
    });
  });
});
