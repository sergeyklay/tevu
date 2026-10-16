/** The `ManagedProcessRunner` contract, with the request and result shapes only it uses. */

import type { TerminationStage } from '@/domain/run-records';

/** Redacted, bounded process output capture with its true total size. */
export type RedactedCapture = {
  text: string;
  totalBytes: number;
  truncated: boolean;
  /**
   * Whether the capture may lack bytes the process wrote: a tevu signal
   * reached the process group while this stream was still open, so a writer
   * may have been stopped mid-output, or a file-backed capture could not be
   * read to its end; `totalBytes` then counts only what was captured.
   */
  incomplete: boolean;
};

/** Input for one supervised literal-argv process with a replacement environment. */
export type ManagedProcessRequest = {
  argv: [string, ...string[]];
  cwd: string;
  environment: Record<string, string>;
  timeoutMs: number;
  terminationGraceMs: number;
  cancellation?: AbortSignal | undefined;
  secretValues?: readonly string[];
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
  maxCaptureBytes?: number;
  /**
   * With "structured", stdout bypasses the generic chunk-level text redaction
   * so structured records can be parsed from unmangled bytes; the caller then
   * owns redacting every decoded record before any persistent, terminal, or
   * callback sink. The bounded capture and byte totals stay truthful to the
   * raw stream. Defaults to "text".
   */
  stdoutRedaction?: 'text' | 'structured';
  /**
   * Text the process reads on stdin, UTF-8 encoded and followed by
   * end-of-file; delivered unredacted and never copied into the result.
   * Text the process leaves unread is discarded without an error. When
   * absent, stdin is `/dev/null`.
   */
  stdinText?: string;
  /**
   * Where the child's stdout goes. "pipe" (the default) streams it to tevu
   * while the child runs. "file" gives the child a regular file without a
   * name, because a child that exits right after writing can lose a pending
   * pipe write; tevu reads the file once the process group is empty or the
   * post-exit window has ended, so `onStdout` receives the text after the
   * child settles. Bound, byte totals, and redaction behave as for "pipe".
   */
  stdoutTarget?: 'pipe' | 'file';
};

/**
 * Evidence that a process could not be started; the reason is already
 * redacted. `code` carries the Node.js-specific error code (e.g. `ENOENT`)
 * when one is available; the `cancelled before launch` result never sets it.
 */
export type ManagedProcessLaunchFailure = { launched: false; reason: string; code?: string };

/** Complete evidence for one launched and settled process. */
export type ManagedProcessCompletion = {
  launched: true;
  exitCode: number | null;
  signal: string | null;
  startedAt: string;
  /** Wall-clock instant the direct child exited, ISO 8601; excludes the post-exit window. */
  endedAt: string;
  /** Milliseconds from launch to the direct child's exit on a monotonic clock; excludes the post-exit window. */
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  terminationStage: TerminationStage;
  stdout: RedactedCapture;
  stderr: RedactedCapture;
};

/** Outcome of one managed process; launch failure is evidence, not an exception. */
export type ManagedProcessResult = ManagedProcessCompletion | ManagedProcessLaunchFailure;

/** Supervises one literal-argv process; launch failure is evidence, never an exception. */
export type ManagedProcessRunner = (
  request: ManagedProcessRequest,
) => Promise<ManagedProcessResult>;
