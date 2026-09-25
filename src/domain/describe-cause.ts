/**
 * Converts any thrown value into human-readable text without ever throwing
 * itself, so a `catch` block can build an error message from an unknown cause.
 */

/**
 * Describes a thrown value as text: an `Error`'s `message` for an `Error`
 * instance, or `String(cause)` otherwise. Returns the fallback text
 * `thrown value cannot be converted to text` instead of throwing when reading
 * or converting `cause` itself fails.
 */
export function describeCause(cause: unknown): string {
  try {
    return String(cause instanceof Error ? cause.message : cause);
  } catch {
    return 'thrown value cannot be converted to text';
  }
}
