// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';

import {
  artifactError,
  buildCliConfig,
  configNotFoundError,
  configReadError,
  createOperations,
  registerCliTestHooks,
  runCli,
} from './__fixtures__/program.fixtures';

import type { TevuConfig } from '@/domain/config';

vi.mock('@clack/prompts', async () => {
  const { clackPromptsModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return clackPromptsModule;
});
vi.mock('./wizard-prompts', async () => {
  const { wizardPromptsModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return wizardPromptsModule;
});
vi.mock('./sectioned-select', async () => {
  const { sectionedSelectModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return sectionedSelectModule;
});
vi.mock('yocto-spinner', async () => {
  const { yoctoSpinnerModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return yoctoSpinnerModule;
});
vi.mock('stdin-discarder', async () => {
  const { stdinDiscarderModule } = await import('./__fixtures__/scripted-prompts.fixtures');
  return stdinDiscarderModule;
});

describe('tevu CLI', () => {
  registerCliTestHooks();

  describe('report', () => {
    it('regenerates the report from loadConfig and rebuildRunReport only', async () => {
      let loadedConfig: TevuConfig | undefined;
      const operations = createOperations({
        loadConfig: vi.fn(async () => {
          const config = buildCliConfig();
          loadedConfig = config;
          return { ok: true as const, value: config };
        }),
      });

      const { code, out, err } = await runCli(['report', 'run-1'], { operations });

      expect(code).toBe(0);
      expect(out).toEqual([
        'Configuration: tevu.yaml',
        'Summary regenerated: /tmp/artifacts/run-1/summary.md',
        'Report regenerated: /tmp/artifacts/run-1/report.md',
      ]);
      expect(err).toEqual([]);
      expect(vi.mocked(operations.rebuildRunReport)).toHaveBeenCalledExactlyOnceWith(
        loadedConfig,
        'run-1',
        'saved',
      );
      expect(operations.validateConfig).not.toHaveBeenCalled();
      expect(operations.planBenchmark).not.toHaveBeenCalled();
      expect(operations.executeBenchmark).not.toHaveBeenCalled();
      expect(operations.readAssessmentContext).not.toHaveBeenCalled();
      expect(operations.applyAssessment).not.toHaveBeenCalled();
      expect(operations.importJiraIssue).not.toHaveBeenCalled();
      expect(operations.importGitHubIssue).not.toHaveBeenCalled();
      expect(operations.createTask).not.toHaveBeenCalled();
    });

    it('maps a rebuild failure to exit 1', async () => {
      const operations = createOperations({
        rebuildRunReport: vi.fn(async () => ({
          ok: false as const,
          error: artifactError('rebuild-report', 'missing result.json'),
        })),
      });

      const { code, out, err } = await runCli(['report', 'run-1'], { operations });

      expect(code).toBe(1);
      expect(err[0]).toBe('error: artifact operation "rebuild-report" failed: missing result.json');
      expect(out).toEqual(['Configuration: tevu.yaml']);
    });

    it('maps a not-found configuration load failure to exit 1', async () => {
      const operations = createOperations({
        loadConfig: vi.fn(async () => ({
          ok: false as const,
          error: configReadError('not-found', '/work/tevu.yaml', 'tevu.yaml'),
        })),
      });

      const { code, out, err } = await runCli(['report', 'run-1'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found: /work/tevu.yaml',
        '  create one interactively: tevu task add --config tevu.yaml',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.rebuildRunReport).not.toHaveBeenCalled();
    });

    it('maps a search-exhausted configuration failure to exit 1 with both searched paths and calls nothing else (V7)', async () => {
      const operations = createOperations({
        locateConfig: vi.fn(async () => ({
          ok: false as const,
          error: configNotFoundError(['/work/tevu.yaml', '/home/u/.config/tevu/tevu.yaml']),
        })),
      });

      const { code, out, err } = await runCli(['report', 'run-1'], { operations });

      expect(code).toBe(1);
      expect(err).toEqual([
        'error: configuration file not found',
        '  searched: /work/tevu.yaml',
        '  searched: /home/u/.config/tevu/tevu.yaml',
        '  create one interactively: tevu task add',
        '  or start from the template: tevu config example > tevu.yaml',
      ]);
      expect(out).toEqual([]);
      expect(operations.loadConfig).not.toHaveBeenCalled();
      expect(operations.rebuildRunReport).not.toHaveBeenCalled();
    });
  });
});
