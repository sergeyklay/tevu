/**
 * Fixed Git settings and the command time limit shared by every adapter that
 * runs the local git CLI, isolating it from the operator's own
 * configuration and keeping its output stable under a fixed locale.
 *
 * Entry point: {@link ISOLATED_GIT_SETTINGS}.
 */

const FIXED_LOCALE = 'C.UTF-8';

/**
 * Environment variables every isolated git command sets: user and system
 * configuration reads are disabled, prompts and optional locks are off, and
 * output is stable under a fixed locale. Spread these last so they override
 * any variable of the same name inherited from the parent environment.
 */
export const ISOLATED_GIT_SETTINGS: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  LANG: FIXED_LOCALE,
  LC_ALL: FIXED_LOCALE,
};

/** Time limit for one local git command, matching the limit source validation already used. */
export const GIT_COMMAND_TIMEOUT_MS = 600_000;
