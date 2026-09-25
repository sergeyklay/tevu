import type { Redactor } from "./types.ts";

/**
 * Applies the redactor to every string inside a decoded JSON-like value while
 * leaving numbers, booleans, and null untouched, so metric counters, schema
 * versions, and configured durations survive redaction unchanged. Each string
 * (including object keys) is redacted in raw decoded form and then in its
 * JSON-serialized token form, giving the injected redactor visibility of the
 * exact escaped shape the string takes inside a serialized sink.
 *
 * @throws when the redactor throws, returns a non-string, produces a token
 * that no longer decodes to one string, or the value is circular.
 */
export function redactDecodedValue(redact: Redactor, value: unknown): unknown {
  return redactDecodedNode(redact, value, new WeakSet());
}

function redactDecodedNode(redact: Redactor, value: unknown, path: WeakSet<object>): unknown {
  if (typeof value === "string") {
    return redactDecodedString(redact, value);
  }
  if (Array.isArray(value)) {
    guardAgainstCycle(path, value);
    const redacted = value.map((entry) => redactDecodedNode(redact, entry, path));
    path.delete(value);
    return redacted;
  }
  if (typeof value === "object" && value !== null) {
    guardAgainstCycle(path, value);
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[redactDecodedString(redact, key)] = redactDecodedNode(redact, entry, path);
    }
    path.delete(value);
    return redacted;
  }
  return value;
}

function guardAgainstCycle(path: WeakSet<object>, value: object): void {
  if (path.has(value)) {
    throw new Error("value contains a circular reference");
  }
  path.add(value);
}

function redactDecodedString(redact: Redactor, raw: string): string {
  const direct = ensureRedactedString(redact(raw));
  const token = ensureRedactedString(redact(JSON.stringify(direct)));
  const decoded: unknown = JSON.parse(token);
  if (typeof decoded !== "string") {
    throw new Error("redaction returned no text");
  }
  return decoded;
}

function ensureRedactedString(candidate: string): string {
  // The redactor is injected; a non-string result must fail closed upstream.
  if (typeof (candidate as unknown) !== "string") {
    throw new Error("redaction returned no text");
  }
  return candidate;
}
