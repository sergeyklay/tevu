/**
 * Shared `gh` helpers used by every module that runs the GitHub CLI as a
 * credential helper or a direct reader: the token variables to register for
 * redaction, gh's non-interactive replacement environment, the
 * authentication hint for a failed gh exit, and stderr excerpting with token
 * masking.
 *
 * Entry points: {@link ghEnvironment}, {@link stderrExcerpt}.
 */

/** Token variables gh 2.86.0 reads (`gh help environment`); registered as secrets before every gh invocation. */
export const GH_CREDENTIAL_ENVIRONMENT_VARIABLES: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
];

/** Environment variables gh 2.86.0 must never see, per gh's own documented behavior. */
const GH_ENVIRONMENT_EXCLUSIONS = new Set([
  'CLICOLOR_FORCE',
  'GH_FORCE_TTY',
  'GH_DEBUG',
  'DEBUG',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
]);

/** GitHub token shapes masked from a stderr excerpt before line selection and truncation. */
const TOKEN_SHAPE_PATTERN = /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/g;

const EXCERPT_MAX_CODE_POINTS = 200;

/**
 * Builds gh's complete replacement environment: every defined parent
 * variable except the excluded set, plus the fixed non-interactive settings
 * gh always receives.
 */
export function ghEnvironment(
  parentEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnvironment)) {
    if (value !== undefined && !GH_ENVIRONMENT_EXCLUSIONS.has(name)) {
      environment[name] = value;
    }
  }
  environment['GH_PROMPT_DISABLED'] = '1';
  environment['GH_NO_UPDATE_NOTIFIER'] = '1';
  environment['NO_COLOR'] = '1';
  return environment;
}

/** The hint gh's own authentication failure gives, naming the host for a non-`github.com` server. */
export function authenticationReason(host: string): string {
  return host === 'github.com'
    ? 'gh is not authenticated; run gh auth login'
    : `gh is not authenticated for ${host}; run gh auth login --hostname ${host}`;
}

/**
 * Masks every GitHub token shape in `stderr`, then selects the first trimmed
 * line starting with `preferredPrefix` when it is given and present,
 * otherwise the first non-empty trimmed line, and truncates it to 200 code
 * points plus `...`.
 *
 * Masking runs before line selection and truncation so no cut leaves a
 * partial token the pattern no longer matches. Without `preferredPrefix`
 * this returns exactly what issue import's own excerpting always returned.
 */
export function stderrExcerpt(stderr: string, preferredPrefix?: string): string {
  const masked = stderr.replace(TOKEN_SHAPE_PATTERN, '[REDACTED]');
  const lines = masked.split('\n').map((line) => line.trim());
  const preferred =
    preferredPrefix === undefined
      ? undefined
      : lines.find((line) => line.startsWith(preferredPrefix));
  const selected = preferred ?? lines.find((line) => line.length > 0);
  if (selected === undefined) {
    return '';
  }
  const codePoints = [...selected];
  return codePoints.length <= EXCERPT_MAX_CODE_POINTS
    ? selected
    : `${codePoints.slice(0, EXCERPT_MAX_CODE_POINTS).join('')}...`;
}
