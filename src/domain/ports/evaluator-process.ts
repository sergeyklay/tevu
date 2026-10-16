/** The `EvaluatorProcessAdapter` contract, with the request and result shapes only it uses. */

import type { RedactedCapture } from './managed-process-runner';
import type { TerminationStage } from '@/domain/run-records';

/** Evaluator process request: argv started as given, with an explicit replacement environment. */
export type EvaluatorProcessRequest = {
  argv: [string, ...string[]];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  terminationGraceMs: number;
  cancellation?: AbortSignal | undefined;
};

/** Evaluator process evidence; launch failure is evidence for a failed check, not an error. */
export type EvaluatorProcessResult =
  | {
      launched: true;
      exitCode: number | null;
      signal: string | null;
      durationMs: number;
      timedOut: boolean;
      terminationStage: TerminationStage;
      stdout: RedactedCapture;
      stderr: RedactedCapture;
    }
  | { launched: false; reason: string };

/** Runs one benchmark-task acceptance command, or one repository setup command, as the argv of its request. */
export interface EvaluatorProcessAdapter {
  run(request: EvaluatorProcessRequest): Promise<EvaluatorProcessResult>;
}
