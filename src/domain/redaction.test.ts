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

describe("redactDecodedValue", () => {
  it("redacts a secret that matches only the JSON-escaped form of a string value", () => {
    const redacted = redactDecodedValue(buildRedactor(ESCAPED_NEWLINE_SECRET), {
      message: `x ${REAL_NEWLINE_VALUE} y`,
    });

    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(ESCAPED_NEWLINE_SECRET);
    expect(serialized).toContain("[redacted]");
    expect(redacted).toEqual({ message: "x [redacted] y" });
  });

  it("redacts a secret that matches only the JSON-escaped form of an object key", () => {
    const redacted = redactDecodedValue(buildRedactor(ESCAPED_NEWLINE_SECRET), {
      [REAL_NEWLINE_VALUE]: "value",
    });

    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain(ESCAPED_NEWLINE_SECRET);
    expect(redacted).toEqual({ "[redacted]": "value" });
  });

  it("leaves numbers, booleans, and null untouched next to redacted strings", () => {
    const redacted = redactDecodedValue(buildRedactor(ESCAPED_NEWLINE_SECRET), {
      [REAL_NEWLINE_VALUE]: [`x ${REAL_NEWLINE_VALUE} y`, 42, true, null],
    });

    expect(redacted).toEqual({
      "[redacted]": ["x [redacted] y", 42, true, null],
    });
    expect(JSON.stringify(redacted)).toBe('{"[redacted]":["x [redacted] y",42,true,null]}');
  });
});
