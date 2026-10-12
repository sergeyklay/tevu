/** Pieces every command handler shares: its context, config loading, output, and exit codes. */

import { renderTevuError } from '@/interface/render-error';

import type { RebuiltReport } from '@/application/assess';
import type {
  LoadConfigErrorKind,
  TevuConfig,
  TevuError,
  TevuResult,
  ValidationFinding,
  ValidationReport,
} from '@/domain/types';
import type { WaitInterrupt } from '@/interface/wait-interrupt';
import type { Readable, Writable } from 'node:stream';

/** Standard streams the commands read and write; wizards additionally require TTY stdin and stdout. */
export type ProgramIo = {
  stdin: Readable & { isTTY?: boolean };
  stdout: Writable & { isTTY?: boolean };
  stderr: Writable & { isTTY?: boolean };
};

/** What a command handler needs besides its operations; injected by the composition root. */
export type CommandContext = {
  io: ProgramIo;
  now(): Date;
  redact(text: string): string;
  cancellation: AbortSignal;
  /** Lets a `task add` wait take the first SIGINT before the command signal aborts. */
  waitInterrupt: WaitInterrupt;
};

export type ConfigOptionValues = { config?: string };

export type LineWriter = (line: string) => void;

export const EXIT_COMPLETED = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CANCELLED = 130;

/**
 * Effectful operations the command handlers route to. Each command declares
 * its own type from these parts; the composition root binds them to the real
 * application use cases and adapters, and product tests bind fakes at the
 * same boundary.
 */
export type ConfigOperations = {
  /** Locates the configuration file per the `--config` search; see `@/config/locate`. */
  locateConfig(
    requestedPath: string | undefined,
  ): Promise<TevuResult<string, 'ConfigReadError' | 'ConfigNotFoundError'>>;
  loadConfig(configPath: string): Promise<TevuResult<TevuConfig, LoadConfigErrorKind>>;
};

export type ConfigValidation = {
  validateConfig(
    config: TevuConfig,
  ): Promise<
    TevuResult<
      ValidationReport,
      | 'ConfigValidationError'
      | 'PrerequisiteError'
      | 'SourceMaterializationError'
      | 'IsolationError'
      | 'AgentProtocolError'
    >
  >;
};

export type RunReportRebuild = {
  rebuildRunReport(
    config: TevuConfig,
    runId: string,
    conclusions: 'write' | 'saved',
  ): Promise<TevuResult<RebuiltReport, 'AgentProtocolError' | 'ArtifactError'>>;
};

export function createLineWriters(context: CommandContext): {
  out: LineWriter;
  err: LineWriter;
} {
  return {
    out: (line) => {
      context.io.stdout.write(`${context.redact(line)}\n`);
    },
    err: (line) => {
      context.io.stderr.write(`${context.redact(line)}\n`);
    },
  };
}

/**
 * Locates and loads the configuration for `validate`, `run`, `assess`, and
 * `report`, printing the `Configuration:` line once the search has resolved
 * an absolute path and the load result is not a read failure.
 */
export async function loadCommandConfig(
  operations: ConfigOperations,
  requestedPath: string | undefined,
  out: LineWriter,
): Promise<
  TevuResult<
    { config: TevuConfig; configPath: string },
    LoadConfigErrorKind | 'ConfigNotFoundError'
  >
> {
  const located = await operations.locateConfig(requestedPath);
  if (!located.ok) {
    return located;
  }
  const loaded = await operations.loadConfig(requestedPath ?? located.value);
  if (loaded.ok || loaded.error.kind !== 'ConfigReadError') {
    out(`Configuration: ${located.value}`);
  }
  if (!loaded.ok) {
    return loaded;
  }
  return { ok: true, value: { config: loaded.value, configPath: located.value } };
}

export function printFindings(out: LineWriter, findings: readonly ValidationFinding[]): void {
  for (const finding of findings) {
    out(`${finding.severity} ${finding.identifier}: ${finding.message}`);
  }
}

/** Prints one typed failure and returns its mapped exit code. */
export function reportFailure(
  err: LineWriter,
  error: TevuError,
  redact: (text: string) => string,
): number {
  for (const line of renderTevuError(error, redact)) {
    err(line);
  }
  return error.kind === 'CancellationError' ? EXIT_CANCELLED : EXIT_FAILURE;
}
