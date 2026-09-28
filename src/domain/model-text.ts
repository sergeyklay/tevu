/**
 * Pure text helpers shared by every one-shot model-role call: fencing text
 * against its own backtick runs and decoding a reply's fenced JSON object.
 *
 * Entry points: {@link codeFenceFor}, {@link decodeReplyObject}.
 */

/** A run of backticks one longer than the longest run of consecutive backticks in `text`, at least 3. */
export function codeFenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

/**
 * Strips a reply's optional code fence, parses the remaining text as JSON,
 * and validates it decodes to a plain object.
 *
 * Stops before any key-specific validation, which each caller applies to the
 * decoded object for its own reply grammar.
 */
export function decodeReplyObject(
  reply: string,
): { ok: true; value: Record<string, unknown> } | { ok: false; defect: string } {
  const trimmed = reply.trim();
  let jsonText: string;
  if (trimmed.startsWith('```')) {
    const lines = trimmed.split('\n').map((line) => line.replace(/\r$/, ''));
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];
    const isCompleteFence =
      lines.length >= 3 &&
      firstLine !== undefined &&
      /^```[A-Za-z]*$/.test(firstLine) &&
      lastLine === '```';
    if (!isCompleteFence) {
      return {
        ok: false,
        defect: 'the reply opens a code fence that is not one complete fenced block',
      };
    }
    jsonText = lines.slice(1, -1).join('\n');
  } else {
    jsonText = trimmed;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, defect: 'the reply is not valid JSON' };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, defect: 'the reply is not a JSON object' };
  }
  return { ok: true, value: parsed };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
