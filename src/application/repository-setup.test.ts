// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { runSetupPhase } from './repository-setup';

import type { SetupPhaseInput } from './repository-setup';
import type {
  EvaluatorProcessAdapter,
  EvaluatorProcessRequest,
  EvaluatorProcessResult,
  RedactedCapture,
  SetupCommand,
} from '@/domain/types';

const EMPTY_CAPTURE: RedactedCapture = { text: '', totalBytes: 0, truncated: false };

function buildCapture(overrides: Partial<RedactedCapture> = {}): RedactedCapture {
  return { ...EMPTY_CAPTURE, ...overrides };
}

function buildLaunched(
  overrides: Partial<Extract<EvaluatorProcessResult, { launched: true }>> = {},
): EvaluatorProcessResult {
  return {
    launched: true,
    exitCode: 0,
    signal: null,
    durationMs: 10,
    timedOut: false,
    terminationStage: 'none',
    stdout: EMPTY_CAPTURE,
    stderr: EMPTY_CAPTURE,
    ...overrides,
  };
}

function buildProcesses(
  run: (request: EvaluatorProcessRequest) => Promise<EvaluatorProcessResult>,
): EvaluatorProcessAdapter {
  return { run };
}

function buildInput(overrides: Partial<SetupPhaseInput> = {}): SetupPhaseInput {
  return {
    phase: 'before_agent',
    commands: [['/synthetic/setup'] as SetupCommand],
    timeoutMs: 5_000,
    terminationGraceMs: 250,
    worktreeDirectory: '/synthetic/worktree',
    environment: {},
    processes: buildProcesses(async () => buildLaunched()),
    cancellation: new AbortController().signal,
    ...overrides,
  };
}

describe('runSetupPhase', () => {
  describe('classification', () => {
    it('classifies a launch that never started while cancelled as cancelled, with no error', async () => {
      const controller = new AbortController();
      const processes = buildProcesses(async () => {
        controller.abort();
        return { launched: false, reason: 'irrelevant once cancelled' };
      });

      const outcome = await runSetupPhase(
        buildInput({ processes, cancellation: controller.signal }),
      );

      expect(outcome.status).toBe('cancelled');
      expect(outcome.commands).toEqual([
        {
          phase: 'before_agent',
          argv: ['/synthetic/setup'],
          exitCode: null,
          durationMs: null,
          outcome: 'cancelled',
        },
      ]);
    });

    it('classifies a launch that never started while not cancelled as launch-failed', async () => {
      const processes = buildProcesses(async () => ({
        launched: false,
        reason: 'ENOENT: not found',
      }));

      const outcome = await runSetupPhase(buildInput({ processes }));

      expect(outcome.status).toBe('failed');
      expect(outcome.commands).toEqual([
        {
          phase: 'before_agent',
          argv: ['/synthetic/setup'],
          exitCode: null,
          durationMs: null,
          outcome: 'launch-failed',
        },
      ]);
      if (outcome.status === 'failed') {
        expect(outcome.error).toEqual({
          kind: 'SetupError',
          phase: 'before_agent',
          argv: ['/synthetic/setup'],
          reason: 'could not be started: ENOENT: not found',
        });
      }
    });

    it('converts a thrown launch value into a launch failure through describeCause', async () => {
      const processes = buildProcesses(async () => {
        throw new Error('boom');
      });

      const outcome = await runSetupPhase(buildInput({ processes }));

      expect(outcome.status).toBe('failed');
      expect(outcome.commands[0]).toMatchObject({ outcome: 'launch-failed' });
      if (outcome.status === 'failed') {
        expect(outcome.error.reason).toBe('could not be started: boom');
      }
    });

    it.each([{ aborted: false }, { aborted: true }])(
      'classifies a timed-out launch as timed-out regardless of cancellation (aborted: $aborted)',
      async ({ aborted }) => {
        const controller = new AbortController();
        const processes = buildProcesses(async () => {
          if (aborted) {
            controller.abort();
          }
          return buildLaunched({
            exitCode: null,
            signal: 'SIGTERM',
            timedOut: true,
            terminationStage: 'graceful',
          });
        });

        const outcome = await runSetupPhase(
          buildInput({ processes, timeoutMs: 1_000, cancellation: controller.signal }),
        );

        expect(outcome.status).toBe('failed');
        expect(outcome.commands[0]).toMatchObject({ outcome: 'timed-out', exitCode: null });
        if (outcome.status === 'failed') {
          expect(outcome.error.reason).toBe('timed out after 1000ms');
        }
      },
    );

    it('classifies exit code 0 as passed', async () => {
      const processes = buildProcesses(async () => buildLaunched({ exitCode: 0 }));

      const outcome = await runSetupPhase(buildInput({ processes }));

      expect(outcome.status).toBe('passed');
      expect(outcome.commands).toEqual([
        {
          phase: 'before_agent',
          argv: ['/synthetic/setup'],
          exitCode: 0,
          durationMs: 10,
          outcome: 'passed',
        },
      ]);
    });

    it('classifies a launched command that ended abnormally while cancelled as cancelled', async () => {
      const controller = new AbortController();
      const processes = buildProcesses(async () => {
        controller.abort();
        return buildLaunched({ exitCode: null, signal: 'SIGTERM', terminationStage: 'graceful' });
      });

      const outcome = await runSetupPhase(
        buildInput({ processes, cancellation: controller.signal }),
      );

      expect(outcome.status).toBe('cancelled');
      expect(outcome.commands[0]).toMatchObject({ outcome: 'cancelled', exitCode: null });
    });

    it('classifies a nonzero exit code as failed', async () => {
      const processes = buildProcesses(async () => buildLaunched({ exitCode: 3 }));

      const outcome = await runSetupPhase(buildInput({ processes }));

      expect(outcome.status).toBe('failed');
      expect(outcome.commands[0]).toMatchObject({ outcome: 'failed', exitCode: 3 });
      if (outcome.status === 'failed') {
        expect(outcome.error.reason).toBe('exited with code 3');
      }
    });

    it('classifies a launched command with no exit code and not cancelled as failed by signal', async () => {
      const processes = buildProcesses(async () =>
        buildLaunched({ exitCode: null, signal: 'SIGSEGV' }),
      );

      const outcome = await runSetupPhase(buildInput({ processes }));

      expect(outcome.status).toBe('failed');
      expect(outcome.commands[0]).toMatchObject({ outcome: 'failed', exitCode: null });
      if (outcome.status === 'failed') {
        expect(outcome.error.reason).toBe('terminated by signal SIGSEGV');
      }
    });
  });

  it('stops at the first command that does not pass and never starts the next one', async () => {
    const runSpy = vi.fn(async (request: EvaluatorProcessRequest) =>
      request.argv[0] === '/synthetic/first'
        ? buildLaunched({ exitCode: 1 })
        : buildLaunched({ exitCode: 0 }),
    );

    const outcome = await runSetupPhase(
      buildInput({
        commands: [['/synthetic/first'], ['/synthetic/second']],
        processes: buildProcesses(runSpy),
      }),
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.commands).toHaveLength(1);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling once cancellation fires between two passing commands', async () => {
    const controller = new AbortController();
    const runSpy = vi.fn(async (request: EvaluatorProcessRequest) => {
      if (request.argv[0] === '/synthetic/first') {
        controller.abort();
      }
      return buildLaunched({ exitCode: 0 });
    });

    const outcome = await runSetupPhase(
      buildInput({
        commands: [['/synthetic/first'], ['/synthetic/second']],
        processes: buildProcesses(runSpy),
        cancellation: controller.signal,
      }),
    );

    expect(outcome.status).toBe('cancelled');
    expect(outcome.commands).toHaveLength(1);
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("passes each command's argv, cwd, environment, timeout, grace, and cancellation to the process adapter unchanged", async () => {
    const runSpy = vi.fn(async () => buildLaunched());
    const cancellation = new AbortController().signal;

    await runSetupPhase(
      buildInput({
        commands: [['npm', 'ci']],
        timeoutMs: 12_345,
        terminationGraceMs: 999,
        worktreeDirectory: '/synthetic/worktree',
        environment: { FOO: 'bar' },
        processes: buildProcesses(runSpy),
        cancellation,
      }),
    );

    expect(runSpy).toHaveBeenCalledWith({
      argv: ['npm', 'ci'],
      cwd: '/synthetic/worktree',
      environment: { FOO: 'bar' },
      timeoutMs: 12_345,
      terminationGraceMs: 999,
      cancellation,
    });
  });

  it("builds a passing phase's log with one header, status, stdout, and stderr section ending in a newline", async () => {
    const processes = buildProcesses(async () =>
      buildLaunched({
        stdout: buildCapture({ text: 'built\n', totalBytes: 6 }),
        stderr: buildCapture(),
      }),
    );

    const outcome = await runSetupPhase(buildInput({ commands: [['npm', 'ci']], processes }));

    expect(outcome.log).toBe(
      '$ ["npm","ci"]\nexit code 0\nstdout (6 bytes):\nbuilt\nstderr (0 bytes):\n',
    );
  });

  it("joins two commands' log sections with one blank line", async () => {
    const runSpy = vi.fn(async () => buildLaunched());

    const outcome = await runSetupPhase(
      buildInput({
        commands: [
          ['npm', 'ci'],
          ['npm', 'test'],
        ],
        processes: buildProcesses(runSpy),
      }),
    );

    expect(outcome.log).toBe(
      '$ ["npm","ci"]\nexit code 0\nstdout (0 bytes):\nstderr (0 bytes):\n\n$ ["npm","test"]\nexit code 0\nstdout (0 bytes):\nstderr (0 bytes):\n',
    );
  });
});
