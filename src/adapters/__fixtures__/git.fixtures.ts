import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execa } from 'execa';

/** The author and committer identity of every commit a test makes, passed ahead of the git subcommand. */
export const GIT_IDENTITY_FLAGS: readonly string[] = [
  '-c',
  'user.name=tevu',
  '-c',
  'user.email=tevu@localhost',
];

const GIT_TIMEOUT_MS = 60_000;

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Runs `git` in `cwd` against an environment without user or system configuration.
 *
 * @returns The standard output. Rejects on a non-zero exit, a timeout, or a spawn failure.
 */
export async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa('git', [...args], {
    cwd,
    env: gitEnvironment(),
    stdin: 'ignore',
    timeout: GIT_TIMEOUT_MS,
  });
  return typeof result.stdout === 'string' ? result.stdout : '';
}

/** Runs `git` as {@link runGit} does, but resolves a failed command with its exit code and output. */
export async function tryGit(
  cwd: string,
  args: readonly string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const result = await execa('git', [...args], {
    cwd,
    env: gitEnvironment(),
    reject: false,
    stdin: 'ignore',
    timeout: GIT_TIMEOUT_MS,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
}

/**
 * Creates a repository on `main` at `path` whose single commit holds `files`.
 *
 * File modes, symlinks, further commits, and edits after the commit stay with the calling test.
 *
 * @param files - Contents by path relative to `path`; parent directories are created.
 * @param options.message - The commit message; defaults to `synthetic base commit`.
 * @returns The hash of the commit.
 */
export async function createSyntheticRepository(
  path: string,
  files: Readonly<Record<string, string | Uint8Array>>,
  options: { message?: string } = {},
): Promise<string> {
  await mkdir(path, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const file = join(path, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
  await runGit(path, ['init', '--quiet', '-b', 'main']);
  await runGit(path, ['add', '-A']);
  await runGit(path, [
    ...GIT_IDENTITY_FLAGS,
    'commit',
    '--quiet',
    '-m',
    options.message ?? 'synthetic base commit',
  ]);
  return (await runGit(path, ['rev-parse', 'HEAD'])).trim();
}
