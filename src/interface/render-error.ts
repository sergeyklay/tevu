import { describeManagedCloneError } from '@/application/managed-clone';

import type { TevuError, ValidationFinding } from '@/domain/types';

/** Renders one typed failure as the lines the program prints for it. */
export function renderTevuError(error: TevuError, redact: (text: string) => string): string[] {
  switch (error.kind) {
    case 'ConfigParseError':
      return [
        'error: the configuration could not be parsed',
        ...renderFindingLines(error.findings),
      ];
    case 'ConfigValidationError':
      return ['error: the configuration is invalid', ...renderFindingLines(error.findings)];
    case 'ConfigReadError':
      return renderConfigReadError(error, redact);
    case 'ConfigNotFoundError':
      return [
        'error: configuration file not found',
        ...error.searchedPaths.map((searchedPath) => `  searched: ${searchedPath}`),
        '  create one interactively: tevu task add',
        '  or start from the template: tevu config example > tevu.yaml',
      ];
    case 'PrerequisiteError':
      return [
        `error: prerequisite "${error.tool}" is not satisfied; expected ${error.expected}${error.actual === undefined ? '' : `, actual ${error.actual}`}`,
      ];
    case 'SourceMaterializationError':
      return [`error: task "${error.taskId}" source cannot be materialized: ${error.reason}`];
    case 'IsolationError':
      return [`error: case "${error.caseId}" isolation failed: ${error.reason}`];
    case 'IssueImportError':
      return [
        `error: ${error.tracker === 'jira-cloud' ? 'Jira' : 'GitHub'} issue "${error.reference}" import failed${error.status === undefined ? '' : ` (status ${error.status})`}: ${error.reason}`,
      ];
    case 'AgentProcessError':
      return [
        `error: agent "${error.agent}" process for case "${error.caseId}" failed (exit code ${error.exitCode ?? 'none'}, signal ${error.signal ?? 'none'})`,
      ];
    case 'AgentProtocolError':
      return [
        `error: agent "${error.agent}" protocol failure (${describeProtocolPhase(error.context)}): ${error.reason}`,
      ];
    case 'ModelCallError':
      return [
        `error: model call for role "${error.role}" through agent "${error.agent}" failed: ${error.reason}`,
      ];
    case 'CaseTimeoutError':
      return [`error: case "${error.caseId}" exceeded its ${error.timeoutMs}ms timeout`];
    case 'EvaluationError':
      return [
        `error: check "${error.checkId}" of case "${error.caseId}" could not be evaluated: ${error.reason}`,
      ];
    case 'AssessmentConflictError':
      return [
        `error: assessment for run "${error.runId}" case "${error.caseId}" is locked: ${error.reason}`,
      ];
    case 'ArtifactError':
      return [`error: artifact operation "${error.operation}" failed: ${error.reason}`];
    case 'RedactionError':
      return [`error: redaction failed: ${error.reason}`];
    case 'CancellationError':
      return ['Cancelled.'];
    case 'CheckStateError':
      return [`error: check-state ${error.step} failed: ${error.reason}`];
    case 'SetupError':
      return [
        `error: setup ${error.phase} command ${JSON.stringify(error.argv)} failed: ${error.reason}`,
      ];
    case 'ReferenceResolutionError':
      return [`error: reference solution cannot be resolved: ${error.reason}`];
    case 'ManagedCloneError':
      return [`error: ${describeManagedCloneError(error)}`];
  }
}

function describeProtocolPhase(
  context: Extract<TevuError, { kind: 'AgentProtocolError' }>['context'],
): string {
  switch (context.phase) {
    case 'probe':
      return 'probe';
    case 'case':
      return `case ${context.caseId}`;
    case 'call':
      return `model call for role ${context.role}`;
  }
}

function renderFindingLines(findings: readonly ValidationFinding[]): string[] {
  return findings.map(
    (finding) => `  ${finding.severity} ${finding.identifier}: ${finding.message}`,
  );
}

/** Renders the cause line and, for a missing file, the two redacted, shell-safe creation hints. */
function renderConfigReadError(
  error: Extract<TevuError, { kind: 'ConfigReadError' }>,
  redact: (text: string) => string,
): string[] {
  const firstLine = configReadErrorLine(error);
  if (error.cause !== 'not-found') {
    return [firstLine];
  }
  const word = shellWord(redact(error.requestedPath));
  return [
    firstLine,
    `  create one interactively: tevu task add --config ${word}`,
    `  or start from the template: tevu config example > ${word}`,
  ];
}

function configReadErrorLine(error: Extract<TevuError, { kind: 'ConfigReadError' }>): string {
  switch (error.cause) {
    case 'not-found':
      return `error: configuration file not found: ${error.path}`;
    case 'permission-denied':
      return `error: cannot read configuration file ${error.path}: permission denied`;
    case 'not-a-file':
      return `error: configuration path is not a file: ${error.path}`;
    case 'unreadable':
      return `error: cannot read configuration file ${error.path}`;
  }
}

const SHELL_SAFE_WORD_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quotes text for safe pasting into a POSIX shell, per the project's shell-word rule. */
function shellWord(text: string): string {
  if (SHELL_SAFE_WORD_PATTERN.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}
