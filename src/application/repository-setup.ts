/**
 * Repository setup phase runner: executes one `before_agent` or
 * `before_checks` phase's commands sequentially, classifies each started
 * command's outcome, and builds the phase's log text. Reads no clock and has
 * effects only through the injected {@link EvaluatorProcessAdapter}.
 *
 * Entry point: {@link runSetupPhase}.
 */

import { describeCause } from '@/domain/describe-cause';

import type {
  EvaluatorProcessAdapter,
  EvaluatorProcessResult,
  RedactedCapture,
  SetupCommand,
  SetupCommandRecord,
  SetupPhase,
  TevuError,
} from '@/domain/types';

/** Everything one setup phase's commands need to run. */
export type SetupPhaseInput = {
  phase: SetupPhase;
  commands: readonly SetupCommand[];
  timeoutMs: number;
  terminationGraceMs: number;
  worktreeDirectory: string;
  environment: Record<string, string>;
  processes: EvaluatorProcessAdapter;
  cancellation: AbortSignal;
};

/** Terminal outcome of one setup phase, with every started command's record and the phase log text. */
export type SetupPhaseOutcome =
  | { status: 'passed'; commands: SetupCommandRecord[]; log: string }
  | {
      status: 'failed';
      commands: SetupCommandRecord[];
      log: string;
      error: Extract<TevuError, { kind: 'SetupError' }>;
    }
  | { status: 'cancelled'; commands: SetupCommandRecord[]; log: string };

/**
 * Runs one phase's commands sequentially in declared order, stopping at the
 * first command that does not pass.
 *
 * A command that was already running when `input.cancellation` fires is
 * classified as `cancelled`, and no later command starts; a value thrown by
 * `input.processes.run` becomes a launch failure through {@link describeCause},
 * exactly as `runCommandCheck` in `src/evaluation/checks.ts` does.
 */
export async function runSetupPhase(input: SetupPhaseInput): Promise<SetupPhaseOutcome> {
  const records: SetupCommandRecord[] = [];
  const sections: string[] = [];

  for (const argv of input.commands) {
    if (input.cancellation.aborted) {
      return { status: 'cancelled', commands: records, log: buildLog(sections) };
    }

    let execution: EvaluatorProcessResult;
    try {
      execution = await input.processes.run({
        argv,
        cwd: input.worktreeDirectory,
        environment: input.environment,
        timeoutMs: input.timeoutMs,
        terminationGraceMs: input.terminationGraceMs,
        cancellation: input.cancellation,
      });
    } catch (cause) {
      execution = { launched: false, reason: describeCause(cause) };
    }

    const classified = classify(
      input.phase,
      argv,
      execution,
      input.timeoutMs,
      input.cancellation.aborted,
    );
    records.push(classified.record);
    sections.push(buildSection(argv, classified.statusLine, execution));

    if (classified.record.outcome === 'cancelled') {
      return { status: 'cancelled', commands: records, log: buildLog(sections) };
    }
    if (classified.record.outcome !== 'passed') {
      return {
        status: 'failed',
        commands: records,
        log: buildLog(sections),
        error: {
          kind: 'SetupError',
          phase: input.phase,
          argv: [...argv],
          reason: classified.reason,
        },
      };
    }
  }

  return { status: 'passed', commands: records, log: buildLog(sections) };
}

type Classification = { record: SetupCommandRecord; statusLine: string; reason: string };

/**
 * Classifies one command's execution into its record and phase-log status
 * line, following the classification table of the setup phase runner: the
 * first matching row wins.
 */
function classify(
  phase: SetupPhase,
  argv: readonly string[],
  execution: EvaluatorProcessResult,
  timeoutMs: number,
  aborted: boolean,
): Classification {
  const commandArgv = [...argv];
  if (!execution.launched) {
    if (aborted) {
      return {
        record: {
          phase,
          argv: commandArgv,
          exitCode: null,
          durationMs: null,
          outcome: 'cancelled',
        },
        statusLine: 'cancelled before launch',
        reason: '',
      };
    }
    return {
      record: {
        phase,
        argv: commandArgv,
        exitCode: null,
        durationMs: null,
        outcome: 'launch-failed',
      },
      statusLine: `launch failed: ${execution.reason}`,
      reason: `could not be started: ${execution.reason}`,
    };
  }

  const { exitCode, durationMs, signal, timedOut, terminationStage } = execution;
  if (timedOut) {
    return {
      record: { phase, argv: commandArgv, exitCode, durationMs, outcome: 'timed-out' },
      statusLine: `timed out after ${timeoutMs}ms (termination: ${terminationStage})`,
      reason: `timed out after ${timeoutMs}ms`,
    };
  }
  if (exitCode === 0) {
    return {
      record: { phase, argv: commandArgv, exitCode, durationMs, outcome: 'passed' },
      statusLine: 'exit code 0',
      reason: '',
    };
  }
  if (aborted) {
    return {
      record: { phase, argv: commandArgv, exitCode, durationMs, outcome: 'cancelled' },
      statusLine: `cancelled (termination: ${terminationStage})`,
      reason: '',
    };
  }
  if (exitCode !== null) {
    return {
      record: { phase, argv: commandArgv, exitCode, durationMs, outcome: 'failed' },
      statusLine: `exit code ${exitCode}`,
      reason: `exited with code ${exitCode}`,
    };
  }
  return {
    record: { phase, argv: commandArgv, exitCode, durationMs, outcome: 'failed' },
    statusLine: `terminated by signal ${signal ?? 'unknown'}`,
    reason: `terminated by signal ${signal ?? 'unknown'}`,
  };
}

/** Builds one command's phase-log section: header, status, and, when launched, stdout and stderr. */
function buildSection(
  argv: readonly string[],
  statusLine: string,
  execution: EvaluatorProcessResult,
): string {
  const parts = [`$ ${JSON.stringify(argv)}`, statusLine];
  if (execution.launched) {
    parts.push(captureLine('stdout', execution.stdout), captureLine('stderr', execution.stderr));
  }
  return parts.join('\n');
}

/** Renders one captured stream as its own log line(s), trimmed of a trailing blank line. */
function captureLine(stream: 'stdout' | 'stderr', capture: RedactedCapture): string {
  const size = `${capture.totalBytes} bytes${capture.truncated ? ', truncated' : ''}`;
  const header = `${stream} (${size}):`;
  if (capture.text.length === 0) {
    return header;
  }
  return `${header}\n${capture.text.replace(/\n+$/, '')}`;
}

/** Joins every started command's section with one empty line, ending with a trailing newline. */
function buildLog(sections: readonly string[]): string {
  return `${sections.join('\n\n')}\n`;
}
