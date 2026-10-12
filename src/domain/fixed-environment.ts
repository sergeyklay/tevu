/**
 * The environment names the isolation contract fixes for every agent and
 * evaluator process, with the refusal sentence that names them.
 *
 * Entry point: {@link isFixedEnvironmentName}.
 */

const EXACT_NAMES = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI'];
const PREFIX = 'XDG_';

/** Reports whether the isolation contract fixes `name`; the match is case-sensitive. */
export function isFixedEnvironmentName(name: string): boolean {
  return EXACT_NAMES.includes(name) || name.startsWith(PREFIX);
}

/** The refusal sentence that restates the fixed names, built from the same list the predicate uses. */
export const FIXED_ENVIRONMENT_NAME_MESSAGE = `${EXACT_NAMES.join(', ')}, and ${PREFIX}* names are fixed by the isolation contract`;
