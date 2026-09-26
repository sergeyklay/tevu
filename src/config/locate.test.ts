// @vitest-environment node
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConfigStore } from '@/adapters/artifact-store';

import { loadConfig } from './load';
import { locateConfig } from './locate';

import type { ConfigStore, TevuError, TevuResult } from '@/domain/types';

type Environment = { cwd: string; home: string | undefined; xdgConfigHome: string | undefined };

function buildEnvironment(overrides: Partial<Environment> = {}): Environment {
  return { cwd: '/work', home: undefined, xdgConfigHome: undefined, ...overrides };
}

type ReadTextResult = TevuResult<string, 'ConfigReadError'>;

function okResult(): ReadTextResult {
  return { ok: true, value: 'version: 1\n' };
}

function readErrorResult(
  path: string,
  cause: Extract<TevuError, { kind: 'ConfigReadError' }>['cause'],
): ReadTextResult {
  return { ok: false, error: { kind: 'ConfigReadError', path, requestedPath: path, cause } };
}

/**
 * Fakes `ConfigStore.readText` over a fixed route table keyed by candidate
 * path; a call for an unrouted path throws, which fails the test and so
 * enforces that `locateConfig` reads no candidate beyond what each test
 * scripts.
 */
function buildConfigStore(routes: Record<string, ReadTextResult>): Pick<ConfigStore, 'readText'> {
  return {
    readText: vi.fn(async (candidatePath: string) => {
      const route = routes[candidatePath];
      if (route === undefined) {
        throw new Error(`unscripted readText call for ${candidatePath}`);
      }
      return route;
    }),
  };
}

describe('locateConfig', () => {
  describe('explicit mode', () => {
    it('resolves the requested path against cwd without calling readText (V1)', async () => {
      const configStore = buildConfigStore({});

      const result = await locateConfig(
        'sub/tevu.yaml',
        buildEnvironment({ cwd: '/work' }),
        configStore,
      );

      expect(result).toEqual({ ok: true, value: '/work/sub/tevu.yaml' });
      expect(configStore.readText).not.toHaveBeenCalled();
    });

    it('leaves an already-absolute requested path unchanged', async () => {
      const configStore = buildConfigStore({});

      const result = await locateConfig(
        '/elsewhere/tevu.yaml',
        buildEnvironment({ cwd: '/work' }),
        configStore,
      );

      expect(result).toEqual({ ok: true, value: '/elsewhere/tevu.yaml' });
    });

    it('performs no search even when the current-directory file would resolve ok (AC-1f)', async () => {
      const configStore = buildConfigStore({ '/work/tevu.yaml': okResult() });

      const result = await locateConfig(
        'missing.yaml',
        buildEnvironment({ cwd: '/work' }),
        configStore,
      );

      expect(result).toEqual({ ok: true, value: '/work/missing.yaml' });
      expect(configStore.readText).not.toHaveBeenCalled();
    });
  });

  describe('search mode', () => {
    it('chooses the current-directory file when both it and the user file resolve ok, reading no further candidate (AC-1a, V2)', async () => {
      const environment = buildEnvironment({ cwd: '/work', home: '/home/user' });
      const configStore = buildConfigStore({
        '/work/tevu.yaml': okResult(),
        '/home/user/.config/tevu/tevu.yaml': okResult(),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual({ ok: true, value: '/work/tevu.yaml' });
      expect(configStore.readText).toHaveBeenCalledExactlyOnceWith('/work/tevu.yaml');
    });

    it('falls back to $HOME/.config/tevu/tevu.yaml when only the user file resolves ok and XDG_CONFIG_HOME is unset (AC-1b)', async () => {
      const environment = buildEnvironment({ cwd: '/work', home: '/home/user' });
      const configStore = buildConfigStore({
        '/work/tevu.yaml': readErrorResult('/work/tevu.yaml', 'not-found'),
        '/home/user/.config/tevu/tevu.yaml': okResult(),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual({ ok: true, value: '/home/user/.config/tevu/tevu.yaml' });
      expect(vi.mocked(configStore.readText).mock.calls).toEqual([
        ['/work/tevu.yaml'],
        ['/home/user/.config/tevu/tevu.yaml'],
      ]);
    });

    it('prefers an absolute XDG_CONFIG_HOME over $HOME/.config (AC-1c)', async () => {
      const environment = buildEnvironment({
        cwd: '/work',
        home: '/home/user',
        xdgConfigHome: '/home/user/xdg-config',
      });
      const configStore = buildConfigStore({
        '/work/tevu.yaml': readErrorResult('/work/tevu.yaml', 'not-found'),
        '/home/user/xdg-config/tevu/tevu.yaml': okResult(),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual({ ok: true, value: '/home/user/xdg-config/tevu/tevu.yaml' });
    });

    it('ignores a relative XDG_CONFIG_HOME and falls back to $HOME/.config (AC-1d)', async () => {
      const environment = buildEnvironment({
        cwd: '/work',
        home: '/home/user',
        xdgConfigHome: 'relative/xdg-config',
      });
      const configStore = buildConfigStore({
        '/work/tevu.yaml': readErrorResult('/work/tevu.yaml', 'not-found'),
        '/home/user/.config/tevu/tevu.yaml': okResult(),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual({ ok: true, value: '/home/user/.config/tevu/tevu.yaml' });
    });

    it.each([
      { label: 'an empty string', xdgConfigHome: '' },
      { label: 'undefined', xdgConfigHome: undefined },
    ])('falls back to $HOME/.config when XDG_CONFIG_HOME is $label', async ({ xdgConfigHome }) => {
      const environment = buildEnvironment({ cwd: '/work', home: '/home/user', xdgConfigHome });
      const configStore = buildConfigStore({
        '/work/tevu.yaml': readErrorResult('/work/tevu.yaml', 'not-found'),
        '/home/user/.config/tevu/tevu.yaml': okResult(),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual({ ok: true, value: '/home/user/.config/tevu/tevu.yaml' });
    });

    it('drops the user file from the candidate list when it is string-equal to the current-directory file', async () => {
      const environment = buildEnvironment({
        cwd: '/home/user/.config/tevu',
        xdgConfigHome: '/home/user/.config',
      });
      const configStore = buildConfigStore({
        '/home/user/.config/tevu/tevu.yaml': readErrorResult(
          '/home/user/.config/tevu/tevu.yaml',
          'not-found',
        ),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ConfigNotFoundError',
          searchedPaths: ['/home/user/.config/tevu/tevu.yaml'],
        },
      });
      expect(configStore.readText).toHaveBeenCalledOnce();
    });

    it('stops at a faked permission-denied cause on the current-directory file without reading the user file (AC-1e, V4 faked variant)', async () => {
      const environment = buildEnvironment({ cwd: '/work', home: '/home/user' });
      const failure = readErrorResult('/work/tevu.yaml', 'permission-denied');
      const configStore = buildConfigStore({
        '/work/tevu.yaml': failure,
        '/home/user/.config/tevu/tevu.yaml': okResult(),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual(failure);
      expect(configStore.readText).toHaveBeenCalledExactlyOnceWith('/work/tevu.yaml');
    });

    it('stops at a real permission-denied file without reading the user file (AC-1e, V4 real-file variant)', async () => {
      const isRoot = process.getuid?.() === 0;
      if (isRoot) {
        return;
      }
      const root = await mkdtemp(join(tmpdir(), 'tevu-locate-'));
      try {
        const homeDirectory = join(root, 'home');
        await mkdir(join(homeDirectory, '.config', 'tevu'), { recursive: true });
        await writeFile(
          join(homeDirectory, '.config', 'tevu', 'tevu.yaml'),
          'version: 1\n',
          'utf8',
        );
        const currentDirectoryFile = join(root, 'tevu.yaml');
        await writeFile(currentDirectoryFile, 'version: 1\n', 'utf8');
        await chmod(currentDirectoryFile, 0o000);
        const configStore = createConfigStore({ redact: (text) => text });

        const result = await locateConfig(
          undefined,
          { cwd: root, home: homeDirectory, xdgConfigHome: undefined },
          configStore,
        );

        expect(result).toEqual({
          ok: false,
          error: {
            kind: 'ConfigReadError',
            path: currentDirectoryFile,
            requestedPath: currentDirectoryFile,
            cause: 'permission-denied',
          },
        });
      } finally {
        await chmod(join(root, 'tevu.yaml'), 0o644);
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reports ConfigNotFoundError with both searched paths in order when every candidate is not-found (AC-1g)', async () => {
      const environment = buildEnvironment({ cwd: '/work', home: '/home/user' });
      const configStore = buildConfigStore({
        '/work/tevu.yaml': readErrorResult('/work/tevu.yaml', 'not-found'),
        '/home/user/.config/tevu/tevu.yaml': readErrorResult(
          '/home/user/.config/tevu/tevu.yaml',
          'not-found',
        ),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual({
        ok: false,
        error: {
          kind: 'ConfigNotFoundError',
          searchedPaths: ['/work/tevu.yaml', '/home/user/.config/tevu/tevu.yaml'],
        },
      });
    });

    it('reports ConfigNotFoundError with only the current-directory file when no user file candidate exists', async () => {
      const environment = buildEnvironment({ cwd: '/work' });
      const configStore = buildConfigStore({
        '/work/tevu.yaml': readErrorResult('/work/tevu.yaml', 'not-found'),
      });

      const result = await locateConfig(undefined, environment, configStore);

      expect(result).toEqual({
        ok: false,
        error: { kind: 'ConfigNotFoundError', searchedPaths: ['/work/tevu.yaml'] },
      });
    });
  });
});

describe('loadConfig over a user-configuration-directory path (V11)', () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'tevu-locate-load-'));
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it('resolves a relative run.output_dir against the directory of a <dir>/tevu/tevu.yaml configuration path', async () => {
    const userConfigDirectory = join(tempDirectory, 'tevu');
    await mkdir(userConfigDirectory, { recursive: true });
    const configPath = join(userConfigDirectory, 'tevu.yaml');
    await writeFile(
      configPath,
      `version: 1
run:
  output_dir: ./runs
  concurrency: 2
  timeout: 10m
  stop_grace: 3s
agents:
  opencode:
    command: opencode
    secrets: []
    env: []
repositories:
  - id: sample-repo
    path: ./repo
models:
  - id: alpha
    model: openai/gpt-5
    effort: high
  - id: beta
    model: anthropic/claude-4
    effort: max
tasks:
  - id: write-report
    title: Write the report
    repo: sample-repo
    base_commit: "0123456789abcdef0123456789abcdef01234567"
    description: Write a report
    prompt: Write the report
    readiness:
      - The spec is approved
    checks:
      acceptance:
        - id: api-returns-200
          description: The API returns 200
          manual: true
      done:
        - id: tests-pass
          description: The tests pass
          run: [npm, test]
          timeout: 1m
`,
      'utf8',
    );
    const configStore = createConfigStore({ redact: (text) => text });

    const loaded = await loadConfig(configPath, configStore);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.run.output_dir).toBe(join(userConfigDirectory, 'runs'));
    expect(loaded.value.repositories[0]?.path).toBe(join(userConfigDirectory, 'repo'));
  });
});
