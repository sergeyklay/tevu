// @vitest-environment node
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createGitWorkspaceAdapter } from '@/adapters/git';
import {
  createCaseExecutableAdapter,
  createEnvironmentAdapter,
  createPrerequisiteAdapter,
} from '@/adapters/process';
import { validateConfig } from '@/application/validate';
import { TevuConfigSchema } from '@/config/schema';

import type { AgentAdapter, TevuConfig, ValidationDependencies } from '@/domain/types';

const GIT_IDENTITY_FLAGS = ['-c', 'user.name=tevu', '-c', 'user.email=tevu@localhost'];

/**
 * A synthetic version-manager shim's body: it reads a version name from
 * `synthetic-pin` in its working directory, or else from
 * `$HOME/synthetic-pin`, and execs `$HOME/installs/<version>/<its own name>`
 * with its arguments, exiting 126 when neither pin file exists or that
 * target is not executable.
 */
const SYNTHETIC_SHIM_BODY = `pin="$(pwd)/synthetic-pin"
if [ ! -f "$pin" ]; then
  pin="$HOME/synthetic-pin"
fi
if [ ! -f "$pin" ]; then
  exit 126
fi
version=$(cat "$pin")
name=$(basename "$0")
target="$HOME/installs/$version/$name"
if [ -x "$target" ]; then
  exec "$target" "$@"
fi
exit 126
`;

function shellScript(body: string): string {
  return `#!/bin/sh\n${body}`;
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
  await execa('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdin: 'ignore',
  });
}

/** Initializes a Git repository with one commit and returns its full commit hash. */
async function createSourceRepository(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  await runGit(directory, ['init', '--quiet', '-b', 'main']);
  await writeFile(join(directory, 'README.md'), 'synthetic\n');
  await runGit(directory, ['add', '-A']);
  await runGit(directory, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'base']);
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: directory });
  return stdout.trim();
}

type FakeAgent = { adapter: AgentAdapter; probe: ReturnType<typeof vi.fn> };

/** An agent adapter whose `probe` is tracked; every other method is unused by `validateConfig`. */
function buildFakeAgentAdapter(): FakeAgent {
  const probe = vi.fn(async () => ({
    ok: true as const,
    value: {
      executable: 'opencode',
      detectedVersion: null,
      capabilities: [],
      isolation: { denyOutsideWorktree: 'available' as const },
    },
  }));
  const unused = () => {
    throw new Error('not used by validateConfig');
  };
  return {
    probe,
    adapter: {
      probe,
      run: vi.fn(unused),
      exportSession: vi.fn(unused),
      normalizeMetrics: vi.fn(unused),
      callModel: vi.fn(unused),
    },
  };
}

function parseConfig(input: unknown): TevuConfig {
  const parsed = TevuConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`expected schema acceptance: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

function buildValidatableConfig(options: {
  agentCommand: string;
  repositoryPath: string;
  baseCommit: string;
  outputDirectory: string;
  setupCommand?: [string, ...string[]];
  checkCommands: Array<[string, ...string[]]>;
}): TevuConfig {
  return parseConfig({
    version: 1,
    run: {
      output_dir: options.outputDirectory,
      concurrency: 1,
      timeout: '10m',
      stop_grace: '3s',
    },
    agents: { opencode: { command: options.agentCommand, secrets: [], env: [] } },
    repositories: [
      {
        id: 'sample-repo',
        path: options.repositoryPath,
        ...(options.setupCommand === undefined
          ? {}
          : { setup: { before_agent: [options.setupCommand], timeout: '1m', env: [] } }),
      },
    ],
    models: [
      { id: 'alpha', model: 'openai/gpt-5', effort: 'high' },
      { id: 'beta', model: 'anthropic/claude-4', effort: 'max' },
    ],
    tasks: [
      {
        id: 'write-report',
        title: 'Write the report',
        repo: 'sample-repo',
        base_commit: options.baseCommit,
        description: 'Write a report',
        prompt: 'Write the report',
        readiness: ['The spec is approved'],
        checks: {
          acceptance: options.checkCommands.map((run, index) => ({
            id: `check-${index}`,
            description: `Check ${index}`,
            run,
            timeout: '1m',
          })),
          done: [{ id: 'manual-done', description: 'Manual review', manual: true }],
        },
      },
    ],
  });
}

let workspace = '';
let savedEnvironment: NodeJS.ProcessEnv = {};

beforeEach(async () => {
  savedEnvironment = { ...process.env };
  workspace = await mkdtemp(join(tmpdir(), 'tevu-validate-it-'));
});

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnvironment)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnvironment);
  if (workspace.length > 0) {
    await rm(workspace, { recursive: true, force: true });
    workspace = '';
  }
});

function buildDependencies(agent: AgentAdapter): ValidationDependencies {
  return {
    git: createGitWorkspaceAdapter({ workspacesDirectory: join(workspace, 'workspaces') }),
    agents: new Map([['opencode', agent]]),
    environments: createEnvironmentAdapter(),
    prerequisites: createPrerequisiteAdapter(),
    clones: { inspectClone: vi.fn(async () => 'repository' as const) },
    caseExecutables: createCaseExecutableAdapter(),
  };
}

describe('validateConfig with the real case-executable adapter', () => {
  describe('a shim resolving only through the operator home', () => {
    async function setUp(): Promise<{
      binDirectory: string;
      operatorHome: string;
      repositoryPath: string;
      baseCommit: string;
    }> {
      const binDirectory = join(workspace, 'bin');
      const operatorHome = join(workspace, 'operator-home');
      await mkdir(binDirectory, { recursive: true });
      await mkdir(join(operatorHome, 'installs', 'v1'), { recursive: true });
      await writeExecutable(join(binDirectory, 'toolx'), shellScript(SYNTHETIC_SHIM_BODY));
      await writeExecutable(join(operatorHome, 'installs', 'v1', 'toolx'), shellScript('exit 0\n'));
      const repositoryPath = join(workspace, 'repo');
      const baseCommit = await createSourceRepository(repositoryPath);
      process.env.HOME = operatorHome;
      process.env.PATH = `${binDirectory}:${process.env.PATH ?? ''}`;
      return { binDirectory, operatorHome, repositoryPath, baseCommit };
    }

    it('reports every location naming the shim, in order, and skips the agent capability probe, when the operator home itself pins a version', async () => {
      const { binDirectory, operatorHome, repositoryPath, baseCommit } = await setUp();
      await writeFile(join(operatorHome, 'synthetic-pin'), 'v1\n');
      const config = buildValidatableConfig({
        agentCommand: 'toolx',
        repositoryPath,
        baseCommit,
        outputDirectory: join(workspace, 'artifacts'),
        setupCommand: ['toolx'],
        checkCommands: [['toolx']],
      });
      const { adapter, probe } = buildFakeAgentAdapter();

      const outcome = await validateConfig(config, buildDependencies(adapter));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const declaredAgent = 'agents.opencode.secrets and agents.opencode.env';
      const declaredSetup = 'repositories.sample-repo.setup.env';
      const declaredCheck = 'tasks.write-report.checks.acceptance.check-0.env';
      const resolved = ` (${join(binDirectory, 'toolx')})`;
      const template = (declared: string): string =>
        `"toolx"${resolved} exits 0 for --version in tevu's environment, secrets withheld, but ` +
        `exits with code 126 in a case environment, which has its own HOME and XDG directories ` +
        `and receives from tevu's environment only PATH and the variables declared in ${declared}: ` +
        `if it reads another variable, declare that variable there; if it is, or runs through, a ` +
        `version-manager shim, put the real executable's directory before the shim directory on ` +
        `PATH when starting tevu`;
      expect(outcome.value.findings).toEqual([
        {
          severity: 'error',
          identifier: 'agents.opencode.command',
          message: template(declaredAgent),
        },
        {
          severity: 'error',
          identifier: 'repositories.sample-repo.setup.before_agent.0',
          message: template(declaredSetup),
        },
        {
          severity: 'error',
          identifier: 'tasks.write-report.checks.acceptance.check-0.run',
          message: template(declaredCheck),
        },
      ]);
      expect(outcome.value.valid).toBe(false);
      expect(probe).not.toHaveBeenCalled();
    });

    it('reports only the setup and check locations, and still runs the agent capability probe, when only the working directory pins a version', async () => {
      const { repositoryPath, baseCommit } = await setUp();
      await writeFile(join(repositoryPath, 'synthetic-pin'), 'v1\n');
      const config = buildValidatableConfig({
        agentCommand: 'toolx',
        repositoryPath,
        baseCommit,
        outputDirectory: join(workspace, 'artifacts'),
        setupCommand: ['toolx'],
        checkCommands: [['toolx']],
      });
      const { adapter, probe } = buildFakeAgentAdapter();

      const outcome = await validateConfig(config, buildDependencies(adapter));

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.findings.map((finding) => finding.identifier)).toEqual([
        'repositories.sample-repo.setup.before_agent.0',
        'tasks.write-report.checks.acceptance.check-0.run',
      ]);
      expect(outcome.value.valid).toBe(false);
      expect(probe).toHaveBeenCalledOnce();
    });
  });

  it('reports one change warning for the check that wrote a file, none for the check that did not, and leaves the configuration valid', async () => {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath);
    const creatorScript = join(workspace, 'creator.sh');
    const quietScript = join(workspace, 'quiet.sh');
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(
      creatorScript,
      shellScript('printf "created\\n" > probe-output.txt\nexit 0\n'),
    );
    await writeExecutable(quietScript, shellScript('exit 0\n'));
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const config = buildValidatableConfig({
      agentCommand: agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      checkCommands: [[creatorScript], [quietScript]],
    });
    const { adapter } = buildFakeAgentAdapter();

    const outcome = await validateConfig(config, buildDependencies(adapter));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.valid).toBe(true);
    expect(outcome.value.findings).toEqual([
      {
        severity: 'warning',
        identifier: 'tasks.write-report.checks.acceptance.check-0.run',
        message:
          `files in "${repositoryPath}" changed while "${creatorScript}" was running with ` +
          `--version in a case environment: added probe-output.txt; tevu did not revert them`,
      },
    ]);
    expect(
      outcome.value.findings.some(
        (finding) => finding.identifier === 'tasks.write-report.checks.acceptance.check-1.run',
      ),
    ).toBe(false);
    expect(await readFile(join(repositoryPath, 'probe-output.txt'), 'utf8')).toBe('created\n');
  });
});
