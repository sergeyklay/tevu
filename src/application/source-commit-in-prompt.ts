/**
 * Detects whether an agent prompt names its resolved source commit, so a
 * curator-authored prompt cannot leak the pinned commit that the sealed
 * repository itself withholds.
 */

/**
 * Reports whether `prompt` contains the resolved source commit.
 *
 * Compares the first 7 characters of `sourceCommit` against `prompt` as a
 * case-insensitive substring, matching every abbreviation Git can emit down
 * to its shortest default form. Returns the reason string when a match is
 * found, `undefined` otherwise. Total and pure: never throws, performs no
 * I/O, and reads no clock or randomness.
 */
export function describeSourceCommitInPrompt(
  prompt: string,
  sourceCommit: string,
): string | undefined {
  const prefix = sourceCommit.slice(0, 7);
  if (prompt.toLowerCase().includes(prefix.toLowerCase())) {
    return `agent prompt contains resolved base commit ${prefix}`;
  }
  return undefined;
}
