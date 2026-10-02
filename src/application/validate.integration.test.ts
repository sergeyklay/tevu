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

import type {
  AgentAdapter,
  AgentConfigurationFile,
  EnvironmentAdapter,
  TevuConfig,
  ToolDenialProbe,
  ValidationDependencies,
  ValidationFinding,
} from '@/domain/types';

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

/** Initializes a Git repository with one commit holding `README.md` and `extraFiles`, and returns its full commit hash. */
async function createSourceRepository(
  directory: string,
  extraFiles: readonly string[] = [],
): Promise<string> {
  await mkdir(directory, { recursive: true });
  await runGit(directory, ['init', '--quiet', '-b', 'main']);
  await writeFile(join(directory, 'README.md'), 'synthetic\n');
  for (const file of extraFiles) {
    await writeFile(join(directory, file), '{}\n');
  }
  await runGit(directory, ['add', '-A']);
  await runGit(directory, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'base']);
  const { stdout } = await execa('git', ['rev-parse', 'HEAD'], { cwd: directory });
  return stdout.trim();
}

type FakeAgent = { adapter: AgentAdapter; probe: ReturnType<typeof vi.fn> };

/**
 * An agent adapter whose `probe` is tracked; `readProviders` answers with an
 * empty snapshot, since `validateConfig` calls it for every probed agent;
 * every other method is unused by `validateConfig`. Either can be overridden
 * for a scenario that depends on its own provider snapshot or model listing.
 */
function buildFakeAgentAdapter(
  overrides: {
    readProviders?: AgentAdapter['readProviders'];
    listModels?: AgentAdapter['listModels'];
    probeToolDenial?: AgentAdapter['probeToolDenial'];
    repositoryConfigurationEntries?: readonly string[];
  } = {},
): FakeAgent {
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
      readProviders:
        overrides.readProviders ??
        vi.fn(async () => ({
          ok: true as const,
          value: { agent: 'opencode', configurationFiles: [], findings: [], copiedProviders: [] },
        })),
      inspectOperatorProvider: vi.fn(async () => ({
        ok: true as const,
        value: { defined: false as const },
      })),
      // Lists exactly what buildValidatableConfig's fixed `models` entries name,
      // with the variants their efforts request, so the model-resolution and
      // effort stages report nothing new for these fixtures.
      listModels:
        overrides.listModels ??
        vi.fn(async () => ({
          outcome: 'listed' as const,
          models: ['openai/gpt-5', 'anthropic/claude-4'],
          variants: new Map([
            ['openai/gpt-5', ['high']],
            ['anthropic/claude-4', ['max']],
          ]),
        })),
      probeToolDenial:
        overrides.probeToolDenial ?? vi.fn(async () => ({ outcome: 'denied' as const })),
      repositoryConfigurationEntries: vi.fn(
        () => overrides.repositoryConfigurationEntries ?? ['.opencode', 'opencode.json'],
      ),
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
  checkCommands: Array<string | [string, ...string[]]>;
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

    describe('a command check with a shell string', () => {
      async function validateShimCheck(check: string | [string, ...string[]]): Promise<{
        findings: ValidationFinding[];
        valid: boolean;
        binDirectory: string;
        agentScript: string;
        probedExecutables: string[];
      }> {
        const { binDirectory, operatorHome, repositoryPath, baseCommit } = await setUp();
        await writeFile(join(operatorHome, 'synthetic-pin'), 'v1\n');
        const agentScript = join(workspace, 'agent-ok.sh');
        await writeExecutable(agentScript, shellScript('exit 0\n'));
        const config = buildValidatableConfig({
          agentCommand: agentScript,
          repositoryPath,
          baseCommit,
          outputDirectory: join(workspace, 'artifacts'),
          checkCommands: [check],
        });
        const { adapter } = buildFakeAgentAdapter();
        const realProbe = createCaseExecutableAdapter();
        const probedExecutables: string[] = [];

        const outcome = await validateConfig(config, {
          ...buildDependencies(adapter),
          caseExecutables: {
            probe: async (request) => {
              probedExecutables.push(request.executable);
              return realProbe.probe(request);
            },
          },
        });

        if (!outcome.ok) {
          throw new Error(`expected validateConfig to succeed: ${JSON.stringify(outcome.error)}`);
        }
        return { ...outcome.value, binDirectory, agentScript, probedExecutables };
      }

      it.each([
        { form: 'a string', check: 'toolx test -- --run' },
        { form: 'a string with leading spaces', check: '  toolx test' },
        { form: 'an array', check: ['toolx', 'test', '--', '--run'] as [string, ...string[]] },
      ])(
        'probes the shim and reports the parent-only finding at the check for $form',
        async ({ check }) => {
          const { findings, valid, binDirectory, agentScript, probedExecutables } =
            await validateShimCheck(check);

          expect(probedExecutables).toEqual([agentScript, 'toolx']);
          expect(findings).toEqual([
            {
              severity: 'error',
              identifier: 'tasks.write-report.checks.acceptance.check-0.run',
              message:
                `"toolx" (${join(binDirectory, 'toolx')}) exits 0 for --version in tevu's environment, secrets withheld, but ` +
                `exits with code 126 in a case environment, which has its own HOME and XDG directories ` +
                `and receives from tevu's environment only PATH and the variables declared in tasks.write-report.checks.acceptance.check-0.env: ` +
                `if it reads another variable, declare that variable there; if it is, or runs through, a ` +
                `version-manager shim, put the real executable's directory before the shim directory on ` +
                `PATH when starting tevu`,
            },
          ]);
          expect(valid).toBe(false);
        },
      );

      it.each([
        { description: 'an environment assignment', command: 'CI=1 toolx test' },
        { description: 'a subshell', command: '(cd app && toolx test)' },
        { description: 'a quoted expansion', command: '"$NODE" test.js' },
      ])('probes only the agent for a string starting with $description', async ({ command }) => {
        const { findings, valid, agentScript, probedExecutables } =
          await validateShimCheck(command);

        expect(probedExecutables).toEqual([agentScript]);
        expect(findings).toEqual([]);
        expect(valid).toBe(true);
      });
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

/**
 * A configuration for the model-resolution tests: a real, always-successful
 * agent command (so the case-executable probe never interferes), two model
 * entries, and optional declared roles and a graded check, for
 * `checkModelsListed`'s D8 severity split.
 */
function buildModelResolutionConfig(options: {
  agentCommand: string;
  repositoryPath: string;
  baseCommit: string;
  outputDirectory: string;
  models: Array<{ id: string; model: `${string}/${string}`; effort?: string }>;
  roles?: {
    criteria?: `${string}/${string}`;
    grader?: `${string}/${string}`;
    summary?: `${string}/${string}`;
  };
  roleEffort?: string;
  gradedCheck?: boolean;
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
    repositories: [{ id: 'sample-repo', path: options.repositoryPath }],
    models: options.models.map((entry) => ({
      id: entry.id,
      model: entry.model,
      effort: entry.effort ?? 'high',
      agent: 'opencode',
    })),
    ...(options.roles === undefined
      ? {}
      : {
          roles: {
            ...(options.roles.criteria === undefined
              ? {}
              : {
                  criteria: {
                    agent: 'opencode',
                    model: options.roles.criteria,
                    effort: options.roleEffort ?? 'high',
                  },
                }),
            ...(options.roles.grader === undefined
              ? {}
              : {
                  grader: {
                    agent: 'opencode',
                    model: options.roles.grader,
                    effort: options.roleEffort ?? 'high',
                  },
                }),
            ...(options.roles.summary === undefined
              ? {}
              : {
                  summary: {
                    agent: 'opencode',
                    model: options.roles.summary,
                    effort: options.roleEffort ?? 'high',
                  },
                }),
          },
        }),
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
          acceptance:
            options.gradedCheck === true
              ? [{ id: 'graded-1', description: 'graded check description', required: true }]
              : [{ id: 'manual-1', description: 'Manual review', manual: true }],
          done: [{ id: 'manual-done', description: 'Manual review', manual: true }],
        },
      },
    ],
  });
}

describe('validateConfig model resolution (AC-3, AC-4)', () => {
  /** Answers `listModels` from the given agent's own written configuration file, without a real process. */
  function buildDependentListModels(listedModels: readonly string[]): AgentAdapter['listModels'] {
    return vi.fn(async (environment) => {
      const configPath = join(
        environment.variables.XDG_CONFIG_HOME ?? '',
        'opencode',
        'opencode.json',
      );
      const text = await readFile(configPath, 'utf8').catch(() => '');
      return text.includes('"acme"')
        ? {
            outcome: 'listed' as const,
            models: [...listedModels],
            variants: new Map(listedModels.map((model) => [model, ['high', 'low', 'turbo']])),
          }
        : { outcome: 'listed' as const, models: [], variants: new Map<string, string[]>() };
    });
  }

  function acmeConfigurationFiles(): AgentConfigurationFile[] {
    return [{ relativePath: 'opencode/opencode.json', text: '{"provider":{"acme":{}}}\n' }];
  }

  it('reports an unlisted model entry as an error, nothing for a listed one, and never starts run', async () => {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath);
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const config = buildModelResolutionConfig({
      agentCommand: agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      models: [
        { id: 'alpha', model: 'acme/model-a' },
        { id: 'beta', model: 'acme/model-missing' },
      ],
    });
    const { adapter } = buildFakeAgentAdapter({
      readProviders: vi.fn(async () => ({
        ok: true as const,
        value: {
          agent: 'opencode',
          configurationFiles: acmeConfigurationFiles(),
          findings: [],
          copiedProviders: [],
        },
      })),
      listModels: buildDependentListModels(['acme/model-a']),
    });

    const outcome = await validateConfig(config, buildDependencies(adapter));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const beta = outcome.value.findings.find(
      (finding) => finding.identifier === 'models.beta.model',
    );
    expect(beta?.severity).toBe('error');
    expect(beta?.message).toContain(
      `"acme/model-missing" is not among the models "${agentScript} models --verbose" lists`,
    );
    expect(
      outcome.value.findings.some((finding) => finding.identifier === 'models.alpha.model'),
    ).toBe(false);
    expect(outcome.value.valid).toBe(false);
    expect(adapter.run).not.toHaveBeenCalled();
  });

  it('reports an unlisted, non-required role model as a warning and leaves the configuration valid', async () => {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath);
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const config = buildModelResolutionConfig({
      agentCommand: agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      models: [
        { id: 'alpha', model: 'acme/model-a' },
        { id: 'beta', model: 'acme/model-b' },
      ],
      roles: { criteria: 'acme/model-missing-role' },
    });
    const { adapter } = buildFakeAgentAdapter({
      readProviders: vi.fn(async () => ({
        ok: true as const,
        value: {
          agent: 'opencode',
          configurationFiles: acmeConfigurationFiles(),
          findings: [],
          copiedProviders: [],
        },
      })),
      listModels: buildDependentListModels(['acme/model-a', 'acme/model-b']),
    });

    const outcome = await validateConfig(config, buildDependencies(adapter));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', identifier: 'roles.criteria.model' }),
    );
    expect(outcome.value.valid).toBe(true);
  });

  it('reports an unlisted grader model as an error when a task declares a graded check', async () => {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath);
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const config = buildModelResolutionConfig({
      agentCommand: agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      models: [
        { id: 'alpha', model: 'acme/model-a' },
        { id: 'beta', model: 'acme/model-b' },
      ],
      roles: { grader: 'acme/model-missing-grader' },
      gradedCheck: true,
    });
    const { adapter } = buildFakeAgentAdapter({
      readProviders: vi.fn(async () => ({
        ok: true as const,
        value: {
          agent: 'opencode',
          configurationFiles: acmeConfigurationFiles(),
          findings: [],
          copiedProviders: [],
        },
      })),
      listModels: buildDependentListModels(['acme/model-a', 'acme/model-b']),
    });

    const outcome = await validateConfig(config, buildDependencies(adapter));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.findings).toContainEqual(
      expect.objectContaining({ severity: 'error', identifier: 'roles.grader.model' }),
    );
    expect(outcome.value.valid).toBe(false);
  });

  it('reports an unlisted summary model as a warning even when a task declares a graded check', async () => {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath);
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const config = buildModelResolutionConfig({
      agentCommand: agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      models: [
        { id: 'alpha', model: 'acme/model-a' },
        { id: 'beta', model: 'acme/model-b' },
      ],
      roles: { grader: 'acme/model-a', summary: 'acme/model-missing-summary' },
      gradedCheck: true,
    });
    const { adapter } = buildFakeAgentAdapter({
      readProviders: vi.fn(async () => ({
        ok: true as const,
        value: {
          agent: 'opencode',
          configurationFiles: acmeConfigurationFiles(),
          findings: [],
          copiedProviders: [],
        },
      })),
      listModels: buildDependentListModels(['acme/model-a', 'acme/model-b']),
    });

    const outcome = await validateConfig(config, buildDependencies(adapter));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', identifier: 'roles.summary.model' }),
    );
    expect(outcome.value.findings.filter((finding) => finding.severity === 'error')).toEqual([]);
    expect(outcome.value.valid).toBe(true);
  });

  it('stays valid on a provider snapshot carrying only a P-NOKEY warning', async () => {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath);
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const config = buildModelResolutionConfig({
      agentCommand: agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      models: [
        { id: 'alpha', model: 'acme/model-a' },
        { id: 'beta', model: 'acme/model-b' },
      ],
    });
    const { adapter } = buildFakeAgentAdapter({
      readProviders: vi.fn(async () => ({
        ok: true as const,
        value: {
          agent: 'opencode',
          configurationFiles: acmeConfigurationFiles(),
          findings: [
            {
              severity: 'warning' as const,
              identifier: 'agents.opencode.providers.acme',
              message: 'provider "acme" names no variable listed in agents.opencode.secrets',
            },
          ],
          copiedProviders: [],
        },
      })),
      listModels: buildDependentListModels(['acme/model-a', 'acme/model-b']),
    });

    const outcome = await validateConfig(config, buildDependencies(adapter));

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.findings).toContainEqual({
      severity: 'warning',
      identifier: 'agents.opencode.providers.acme',
      message: 'provider "acme" names no variable listed in agents.opencode.secrets',
    });
    expect(outcome.value.valid).toBe(true);
  });
});

describe('validateConfig model listing outcomes', () => {
  async function validateWith(options: {
    listModels?: AgentAdapter['listModels'];
    environments?: (real: EnvironmentAdapter) => EnvironmentAdapter;
  }): Promise<ValidationFinding[]> {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath);
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const config = buildModelResolutionConfig({
      agentCommand: agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      models: [
        { id: 'alpha', model: 'acme/model-a' },
        { id: 'beta', model: 'acme/model-b' },
      ],
    });
    const { adapter } = buildFakeAgentAdapter(
      options.listModels === undefined ? {} : { listModels: options.listModels },
    );
    const dependencies = buildDependencies(adapter);

    const outcome = await validateConfig(config, {
      ...dependencies,
      environments: options.environments?.(dependencies.environments) ?? dependencies.environments,
    });

    if (!outcome.ok) {
      throw new Error(`expected validateConfig to succeed: ${JSON.stringify(outcome.error)}`);
    }
    return outcome.value.findings.filter((finding) => finding.identifier === 'agents.opencode');
  }

  function expectedFinding(message: string): ValidationFinding {
    return { severity: 'error', identifier: 'agents.opencode', message };
  }

  it.each([
    {
      name: 'a timeout',
      listing: { outcome: 'timed-out' as const, limitMs: 120_000 },
      message: (command: string) =>
        `"${command} models --verbose" did not finish within 120s in an environment built like a case agent's; the models of agent "opencode" were not checked`,
    },
    {
      name: 'a failure',
      listing: { outcome: 'failed' as const, reason: 'exits with code 4' },
      message: (command: string) =>
        `"${command} models --verbose" exits with code 4 in an environment built like a case agent's, so the models of agent "opencode" could not be checked`,
    },
    {
      name: 'a cancellation',
      listing: { outcome: 'cancelled' as const },
      message: (command: string) =>
        `"${command} models --verbose" is cancelled in an environment built like a case agent's, so the models of agent "opencode" could not be checked`,
    },
  ])('reports $name of the listing as one error at the agent', async ({ listing, message }) => {
    const command = join(workspace, 'agent-ok.sh');

    const findings = await validateWith({ listModels: vi.fn(async () => listing) });

    expect(findings).toEqual([expectedFinding(message(command))]);
  });

  it('reports an environment that cannot be created as one error and never lists', async () => {
    const listModels = vi.fn<AgentAdapter['listModels']>();

    const findings = await validateWith({
      listModels,
      environments: (real) => ({
        ...real,
        createModelCallEnvironment: async () => ({
          ok: false,
          error: {
            kind: 'ArtifactError',
            operation: 'create-model-call-directory',
            reason: 'disk full',
          },
        }),
      }),
    });

    expect(findings).toEqual([
      expectedFinding(
        'the model listing environment could not be prepared: create-model-call-directory: disk full',
      ),
    ]);
    expect(listModels).not.toHaveBeenCalled();
  });

  it('reports the listing finding before the warning about a directory it could not remove', async () => {
    const findings = await validateWith({
      listModels: vi.fn(async () => ({ outcome: 'failed' as const, reason: 'exits with code 4' })),
      environments: (real) => ({
        ...real,
        createModelCallEnvironment: async (snapshot, agentVariables, configurationFiles) => {
          const created = await real.createModelCallEnvironment(
            snapshot,
            agentVariables,
            configurationFiles,
          );
          if (!created.ok) {
            return created;
          }
          return {
            ok: true,
            value: {
              ...created.value,
              dispose: async () => {
                await created.value.dispose();
                return {
                  ok: false,
                  error: { kind: 'ArtifactError', operation: 'remove', reason: 'busy' },
                };
              },
            },
          };
        },
      }),
    });

    expect(findings.map((finding) => finding.severity)).toEqual(['error', 'warning']);
    expect(findings[1]?.message).toMatch(
      /^model listing directory could not be removed; retained at ".+"$/,
    );
  });
});

describe('validateConfig effort check', () => {
  const VARIANT_MODEL = 'acme/model-a';

  function listVariants(variants: readonly string[]): AgentAdapter['listModels'] {
    return vi.fn(async () => ({
      outcome: 'listed' as const,
      models: [VARIANT_MODEL],
      variants: new Map([[VARIANT_MODEL, [...variants]]]),
    }));
  }

  async function validateEfforts(options: {
    efforts: readonly string[];
    listModels: AgentAdapter['listModels'];
    baseFiles?: readonly string[];
    configurationEntries?: readonly string[];
    roles?: {
      criteria?: `${string}/${string}`;
      grader?: `${string}/${string}`;
      summary?: `${string}/${string}`;
    };
    roleEffort?: string;
    gradedCheck?: boolean;
  }) {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath, options.baseFiles);
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const config = buildModelResolutionConfig({
      agentCommand: agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      models: options.efforts.map((effort, index) => ({
        id: index === 0 ? 'known' : 'typo',
        model: VARIANT_MODEL,
        effort,
      })),
      ...(options.roles === undefined ? {} : { roles: options.roles }),
      ...(options.roleEffort === undefined ? {} : { roleEffort: options.roleEffort }),
      ...(options.gradedCheck === undefined ? {} : { gradedCheck: options.gradedCheck }),
    });
    const { adapter } = buildFakeAgentAdapter({
      readProviders: vi.fn(async () => ({
        ok: true as const,
        value: {
          agent: 'opencode',
          configurationFiles: [
            { relativePath: 'opencode/opencode.json', text: '{"provider":{"acme":{}}}\n' },
          ],
          findings: [],
          copiedProviders: [],
        },
      })),
      listModels: options.listModels,
      ...(options.configurationEntries === undefined
        ? {}
        : { repositoryConfigurationEntries: options.configurationEntries }),
    });

    const outcome = await validateConfig(config, buildDependencies(adapter));

    if (!outcome.ok) {
      throw new Error(`expected validateConfig to succeed: ${JSON.stringify(outcome.error)}`);
    }
    return { report: outcome.value, adapter, command: agentScript };
  }

  function effortFindings(findings: readonly ValidationFinding[]): ValidationFinding[] {
    return findings.filter((finding) => finding.identifier.endsWith('.effort'));
  }

  it('refuses the misspelled effort with one error naming the variants, before any paid call', async () => {
    const { report, adapter, command } = await validateEfforts({
      efforts: ['high', 'hihg'],
      listModels: listVariants(['high', 'low']),
    });

    const reason = `"hihg" is not among the variants "${command} models --verbose" reports for "${VARIANT_MODEL}" (high, low), and these tasks have no agent configuration at the root of their base commit: write-report; their cases would run "${VARIANT_MODEL}" with its default options`;
    expect(report.valid).toBe(false);
    expect(effortFindings(report.findings)).toEqual([
      { severity: 'error', identifier: 'models.typo.effort', message: reason },
    ]);
    expect(report.efforts).toEqual({
      models: { known: { status: 'verified' }, typo: { status: 'unsupported', reason } },
      roles: {},
    });
    expect(adapter.run).not.toHaveBeenCalled();
    expect(adapter.callModel).not.toHaveBeenCalled();
  });

  it('keeps the configuration valid for a built-in variant', async () => {
    const { report } = await validateEfforts({
      efforts: ['high', 'low'],
      listModels: listVariants(['high', 'low']),
    });

    expect(report.valid).toBe(true);
    expect(effortFindings(report.findings)).toEqual([]);
    expect(report.efforts.models).toEqual({
      known: { status: 'verified' },
      typo: { status: 'verified' },
    });
  });

  it('keeps the configuration valid for a variant reported only because a copied provider defines it', async () => {
    const { report } = await validateEfforts({
      efforts: ['high', 'turbo'],
      listModels: vi.fn(async (environment) => {
        const written = await readFile(
          join(environment.variables.XDG_CONFIG_HOME ?? '', 'opencode', 'opencode.json'),
          'utf8',
        ).catch(() => '');
        return {
          outcome: 'listed' as const,
          models: [VARIANT_MODEL],
          variants: new Map([
            [VARIANT_MODEL, written.includes('"acme"') ? ['high', 'turbo'] : ['high']],
          ]),
        };
      }),
    });

    expect(report.valid).toBe(true);
    expect(report.efforts.models['typo']).toEqual({ status: 'verified' });
  });

  it('only warns for a variant a task repository may define in its own configuration', async () => {
    const { report } = await validateEfforts({
      efforts: ['high', 'repo-defined'],
      listModels: listVariants(['high', 'low']),
      baseFiles: ['opencode.json'],
    });

    expect(report.valid).toBe(true);
    expect(effortFindings(report.findings)).toEqual([
      expect.objectContaining({ severity: 'warning', identifier: 'models.typo.effort' }),
    ]);
    expect(report.efforts.models['typo']).toMatchObject({
      status: 'unverified',
      reason: expect.stringContaining('task repository') as string,
    });
  });

  it('reads the configuration entries from the adapter, not from a fixed list', async () => {
    const { report } = await validateEfforts({
      efforts: ['high', 'hihg'],
      listModels: listVariants(['high', 'low']),
      baseFiles: ['custom.cfg'],
      configurationEntries: ['custom.cfg'],
    });

    expect(report.valid).toBe(true);
    expect(report.efforts.models['typo']?.status).toBe('unverified');
  });

  it('leaves every effort unverified without an effort finding when the listing failed', async () => {
    const { report } = await validateEfforts({
      efforts: ['high', 'hihg'],
      listModels: vi.fn(async () => ({ outcome: 'failed' as const, reason: 'exits with code 4' })),
    });

    expect(effortFindings(report.findings)).toEqual([]);
    expect(report.efforts.models).toEqual({
      known: expect.objectContaining({ status: 'unverified' }) as unknown,
      typo: expect.objectContaining({ status: 'unverified' }) as unknown,
    });
    expect(report.findings.filter((finding) => finding.severity === 'error')).toHaveLength(1);
  });

  it('records a grader effort outside the reported variants as a blocking error when a task declares a graded check', async () => {
    const { report } = await validateEfforts({
      efforts: ['high', 'low'],
      listModels: listVariants(['high', 'low']),
      roles: { grader: VARIANT_MODEL },
      roleEffort: 'hihg',
      gradedCheck: true,
    });

    expect(report.valid).toBe(false);
    expect(effortFindings(report.findings)).toEqual([
      expect.objectContaining({ severity: 'error', identifier: 'roles.grader.effort' }),
    ]);
    expect(report.efforts.roles.grader?.status).toBe('unsupported');
  });

  it('only warns for a summary effort outside the reported variants', async () => {
    const { report } = await validateEfforts({
      efforts: ['high', 'low'],
      listModels: listVariants(['high', 'low']),
      roles: { summary: VARIANT_MODEL },
      roleEffort: 'hihg',
    });

    expect(report.valid).toBe(true);
    expect(effortFindings(report.findings)).toEqual([
      expect.objectContaining({ severity: 'warning', identifier: 'roles.summary.effort' }),
    ]);
    expect(report.efforts.roles.summary?.status).toBe('unsupported');
  });

  it('only warns for a criteria effort outside the reported variants', async () => {
    const { report } = await validateEfforts({
      efforts: ['high', 'low'],
      listModels: listVariants(['high', 'low']),
      roles: { criteria: VARIANT_MODEL },
      roleEffort: 'hihg',
    });

    expect(report.valid).toBe(true);
    expect(effortFindings(report.findings)).toEqual([
      expect.objectContaining({ severity: 'warning', identifier: 'roles.criteria.effort' }),
    ]);
    expect(report.efforts.roles.criteria?.status).toBe('unsupported');
  });
});

describe('validateConfig tool denial check', () => {
  const BASH_GRANTED_REASON =
    'lists "bash" after "*" in "permission" with a value other than "deny"';
  const MODELS = ['acme/model-a', 'acme/model-b'];

  type Roles = {
    criteria?: `${string}/${string}`;
    grader?: `${string}/${string}`;
    summary?: `${string}/${string}`;
  };

  function listsAcmeModels(): AgentAdapter['listModels'] {
    return vi.fn(async () => ({
      outcome: 'listed' as const,
      models: MODELS,
      variants: new Map(MODELS.map((model) => [model, ['high']])),
    }));
  }

  function notShownBash(command: string): ToolDenialProbe {
    return { outcome: 'not-shown', reason: `"${command} debug config" ${BASH_GRANTED_REASON}` };
  }

  async function validateToolDenial(
    options: {
      roles?: Roles;
      gradedCheck?: boolean;
      probeToolDenial?: AgentAdapter['probeToolDenial'];
      listModels?: AgentAdapter['listModels'];
      readProviders?: AgentAdapter['readProviders'];
      adapter?: (adapter: AgentAdapter) => AgentAdapter;
      config?: (config: TevuConfig) => TevuConfig;
      environments?: (real: EnvironmentAdapter) => EnvironmentAdapter;
      agentCommand?: string;
      extraAgents?: Record<string, AgentAdapter>;
    } = {},
  ) {
    const repositoryPath = join(workspace, 'repo');
    const baseCommit = await createSourceRepository(repositoryPath);
    const agentScript = join(workspace, 'agent-ok.sh');
    await writeExecutable(agentScript, shellScript('exit 0\n'));
    const built = buildModelResolutionConfig({
      agentCommand: options.agentCommand ?? agentScript,
      repositoryPath,
      baseCommit,
      outputDirectory: join(workspace, 'artifacts'),
      models: [
        { id: 'alpha', model: 'acme/model-a' },
        { id: 'beta', model: 'acme/model-b' },
      ],
      ...(options.roles === undefined ? {} : { roles: options.roles }),
      ...(options.gradedCheck === true ? { gradedCheck: true } : {}),
    });
    const config = options.config?.(built) ?? built;
    const { adapter: fake } = buildFakeAgentAdapter({
      listModels: options.listModels ?? listsAcmeModels(),
      ...(options.probeToolDenial === undefined
        ? {}
        : { probeToolDenial: options.probeToolDenial }),
      ...(options.readProviders === undefined ? {} : { readProviders: options.readProviders }),
    });
    const adapter = options.adapter?.(fake) ?? fake;
    const dependencies = buildDependencies(adapter);
    const outcome = await validateConfig(config, {
      ...dependencies,
      agents: new Map([...dependencies.agents, ...Object.entries(options.extraAgents ?? {})]),
      environments: options.environments?.(dependencies.environments) ?? dependencies.environments,
    });
    if (!outcome.ok) {
      throw new Error(`expected validateConfig to succeed: ${JSON.stringify(outcome.error)}`);
    }
    return { report: outcome.value, adapter, agentScript };
  }

  function toolDenialFindings(findings: readonly ValidationFinding[]): ValidationFinding[] {
    return findings.filter(
      (finding) =>
        finding.message.includes('model call tool denial') ||
        finding.message.startsWith('tool denial check directory'),
    );
  }

  it.each<{ name: string; roles: Roles; gradedCheck: boolean; severity: 'error' | 'warning' }>([
    {
      name: 'the grader with a graded check',
      roles: { grader: 'acme/model-a' },
      gradedCheck: true,
      severity: 'error',
    },
    {
      name: 'the grader without a graded check',
      roles: { grader: 'acme/model-a' },
      gradedCheck: false,
      severity: 'warning',
    },
    {
      name: 'the criteria role alone',
      roles: { criteria: 'acme/model-a' },
      gradedCheck: false,
      severity: 'warning',
    },
    {
      name: 'the summary role alone',
      roles: { summary: 'acme/model-a' },
      gradedCheck: false,
      severity: 'warning',
    },
  ])(
    'reports a missing denial of $name as a $severity at the agent',
    async ({ roles, gradedCheck, severity }) => {
      const { report, agentScript } = await validateToolDenial({
        roles,
        gradedCheck,
        probeToolDenial: vi.fn(async () => notShownBash(join(workspace, 'agent-ok.sh'))),
      });

      const [finding, ...rest] = toolDenialFindings(report.findings);
      expect(rest).toEqual([]);
      expect(finding?.severity).toBe(severity);
      expect(finding?.identifier).toBe('agents.opencode');
      expect(finding?.message).toContain(
        `capability "model call tool denial" is missing: "${agentScript} debug config" ${BASH_GRANTED_REASON}; every call of roles.`,
      );
      expect(report.valid).toBe(severity === 'warning');
    },
  );

  it.each<{ roles: Roles; list: string }>([
    { roles: { criteria: 'acme/model-a' }, list: 'roles.criteria' },
    {
      roles: { criteria: 'acme/model-a', summary: 'acme/model-a' },
      list: 'roles.criteria and roles.summary',
    },
    {
      roles: { summary: 'acme/model-a', grader: 'acme/model-a', criteria: 'acme/model-a' },
      list: 'roles.criteria, roles.grader, and roles.summary',
    },
  ])('lists the roles $list in the order criteria, grader, summary', async ({ roles, list }) => {
    const { report } = await validateToolDenial({
      roles,
      probeToolDenial: vi.fn(async () => notShownBash('agent')),
    });

    expect(toolDenialFindings(report.findings).map((finding) => finding.message)).toEqual([
      `capability "model call tool denial" is missing: "agent debug config" ${BASH_GRANTED_REASON}; every call of ${list} is refused before it starts`,
    ]);
  });

  it('ends a missing-denial finding with the refusal before the call starts', async () => {
    const { report } = await validateToolDenial({
      roles: { grader: 'acme/model-a' },
      probeToolDenial: vi.fn(async () => notShownBash('agent')),
    });

    const [finding] = toolDenialFindings(report.findings);
    expect(finding?.message).toContain('is missing: "');
    expect(finding?.message.endsWith('is refused before it starts')).toBe(true);
  });

  it('reports a failed check as unchecked and ends with the repeated check', async () => {
    const { report } = await validateToolDenial({
      roles: { summary: 'acme/model-a' },
      probeToolDenial: vi.fn(async () => ({
        outcome: 'failed' as const,
        reason: '"agent debug config" exits with code 1',
      })),
    });

    expect(toolDenialFindings(report.findings)).toEqual([
      {
        severity: 'warning',
        identifier: 'agents.opencode',
        message:
          'capability "model call tool denial" could not be checked: "agent debug config" exits with code 1; every call of roles.summary repeats the check and is refused unless the check shows the denial',
      },
    ]);
  });

  it('reports a cancelled check as unchecked with the configured command', async () => {
    const { report, agentScript } = await validateToolDenial({
      roles: { summary: 'acme/model-a' },
      probeToolDenial: vi.fn(async () => ({ outcome: 'cancelled' as const })),
    });

    expect(toolDenialFindings(report.findings).map((finding) => finding.message)).toEqual([
      `capability "model call tool denial" could not be checked: "${agentScript} debug config" is cancelled; every call of roles.summary repeats the check and is refused unless the check shows the denial`,
    ]);
  });

  it('reports an environment that cannot be prepared as unchecked and never probes', async () => {
    const probeToolDenial = vi.fn<AgentAdapter['probeToolDenial']>();

    const { report } = await validateToolDenial({
      roles: { grader: 'acme/model-a' },
      gradedCheck: true,
      probeToolDenial,
      environments: (real) => ({
        ...real,
        createModelCallEnvironment: async () => ({
          ok: false,
          error: {
            kind: 'ArtifactError',
            operation: 'create-model-call-directory',
            reason: 'disk full',
          },
        }),
      }),
    });

    expect(toolDenialFindings(report.findings)).toEqual([
      {
        severity: 'error',
        identifier: 'agents.opencode',
        message:
          'capability "model call tool denial" could not be checked: a model call environment could not be prepared: create-model-call-directory: disk full; every call of roles.grader repeats the check and is refused unless the check shows the denial',
      },
    ]);
    expect(probeToolDenial).not.toHaveBeenCalled();
  });

  it('adds no finding and keeps the configuration valid when the denial is shown', async () => {
    const probeToolDenial = vi.fn(async () => ({ outcome: 'denied' as const }));

    const { report } = await validateToolDenial({
      roles: { grader: 'acme/model-a', summary: 'acme/model-b' },
      gradedCheck: true,
      probeToolDenial,
    });

    expect(probeToolDenial).toHaveBeenCalledTimes(1);
    expect(toolDenialFindings(report.findings)).toEqual([]);
    expect(report.valid).toBe(true);
  });

  it('starts no check for a configuration without roles', async () => {
    const probeToolDenial = vi.fn(async () => ({ outcome: 'denied' as const }));

    await validateToolDenial({ probeToolDenial });

    expect(probeToolDenial).not.toHaveBeenCalled();
  });

  /** Adds a second agent, `other`, and gives it the criteria role; `opencode` keeps the models and the grader. */
  function withOtherAgentOnCriteria(config: TevuConfig): TevuConfig {
    return {
      ...config,
      agents: { ...config.agents, other: { ...config.agents['opencode']! } },
      roles: {
        ...config.roles,
        criteria: { agent: 'other', model: 'acme/model-a', effort: 'high' },
      },
    };
  }

  it("reports one finding per agent a role names, each after that agent's model-resolution findings", async () => {
    const otherProbe = vi.fn(async () => notShownBash('other'));

    const { report } = await validateToolDenial({
      roles: { grader: 'acme/model-a' },
      probeToolDenial: vi.fn(async () => notShownBash('opencode')),
      listModels: vi.fn(async () => ({
        outcome: 'listed' as const,
        models: ['acme/model-a'],
        variants: new Map([['acme/model-a', ['high']]]),
      })),
      config: withOtherAgentOnCriteria,
      extraAgents: {
        other: buildFakeAgentAdapter({ probeToolDenial: otherProbe, listModels: listsAcmeModels() })
          .adapter,
      },
    });

    const identifiers = report.findings
      .map((finding) => finding.identifier)
      .filter((identifier) =>
        ['models.beta.model', 'agents.opencode', 'agents.other'].includes(identifier),
      );
    expect(identifiers).toEqual(['models.beta.model', 'agents.opencode', 'agents.other']);
    expect(otherProbe).toHaveBeenCalledTimes(1);
  });

  it('starts no check for an agent only a model entry names', async () => {
    const opencodeProbe = vi.fn(async () => ({ outcome: 'denied' as const }));
    const otherProbe = vi.fn(async () => ({ outcome: 'denied' as const }));

    await validateToolDenial({
      roles: { grader: 'acme/model-a' },
      probeToolDenial: opencodeProbe,
      config: (config) => ({
        ...config,
        agents: { ...config.agents, other: { ...config.agents['opencode']! } },
        models: config.models.map((entry) => ({ ...entry, agent: 'other' })),
      }),
      extraAgents: {
        other: buildFakeAgentAdapter({ probeToolDenial: otherProbe, listModels: listsAcmeModels() })
          .adapter,
      },
    });

    expect(opencodeProbe).toHaveBeenCalledTimes(1);
    expect(otherProbe).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'times out', listing: { outcome: 'timed-out' as const, limitMs: 120_000 } },
    { name: 'fails', listing: { outcome: 'failed' as const, reason: 'exits with code 4' } },
  ])('still runs the check when the model listing $name', async ({ listing }) => {
    const probeToolDenial = vi.fn(async () => notShownBash('agent'));

    const { report } = await validateToolDenial({
      roles: { summary: 'acme/model-a' },
      probeToolDenial,
      listModels: vi.fn(async () => listing),
    });

    expect(probeToolDenial).toHaveBeenCalledTimes(1);
    expect(toolDenialFindings(report.findings)).toHaveLength(1);
  });

  it('starts no check when the providers cannot be read', async () => {
    const probeToolDenial = vi.fn(async () => ({ outcome: 'denied' as const }));

    await validateToolDenial({
      roles: { summary: 'acme/model-a' },
      probeToolDenial,
      readProviders: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'ConfigValidationError' as const,
          findings: [
            {
              severity: 'error' as const,
              identifier: 'agents.opencode.providers',
              message: 'unreadable',
            },
          ],
        },
      })),
    });

    expect(probeToolDenial).not.toHaveBeenCalled();
  });

  it('starts no check when the capability probe fails', async () => {
    const probeToolDenial = vi.fn(async () => ({ outcome: 'denied' as const }));

    await validateToolDenial({
      roles: { summary: 'acme/model-a' },
      probeToolDenial,
      adapter: (adapter) => ({
        ...adapter,
        probe: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'PrerequisiteError' as const,
            tool: 'opencode',
            expected: 'the executable starts',
            actual: 'it does not',
          },
        })),
      }),
    });

    expect(probeToolDenial).not.toHaveBeenCalled();
  });

  it('starts no check when the parent environment snapshot cannot be taken', async () => {
    const probeToolDenial = vi.fn(async () => ({ outcome: 'denied' as const }));
    delete process.env['TEVU_TOOL_DENIAL_UNSET_VARIABLE'];

    await validateToolDenial({
      roles: { summary: 'acme/model-a' },
      probeToolDenial,
      config: (config) => ({
        ...config,
        agents: {
          opencode: { ...config.agents['opencode']!, env: ['TEVU_TOOL_DENIAL_UNSET_VARIABLE'] },
        },
      }),
    });

    expect(probeToolDenial).not.toHaveBeenCalled();
  });

  it('starts no check for an agent whose case-executable finding is already reported', async () => {
    const probeToolDenial = vi.fn(async () => ({ outcome: 'denied' as const }));
    const binDirectory = join(workspace, 'bin');
    const operatorHome = join(workspace, 'operator-home');
    await mkdir(binDirectory, { recursive: true });
    await mkdir(join(operatorHome, 'installs', 'v1'), { recursive: true });
    await writeExecutable(join(binDirectory, 'toolx'), shellScript(SYNTHETIC_SHIM_BODY));
    await writeExecutable(join(operatorHome, 'installs', 'v1', 'toolx'), shellScript('exit 0\n'));
    await writeFile(join(operatorHome, 'synthetic-pin'), 'v1\n');
    process.env.HOME = operatorHome;
    process.env.PATH = `${binDirectory}:${process.env.PATH ?? ''}`;

    const { report } = await validateToolDenial({
      roles: { summary: 'acme/model-a' },
      probeToolDenial,
      agentCommand: 'toolx',
    });

    expect(report.findings.map((finding) => finding.identifier)).toContain(
      'agents.opencode.command',
    );
    expect(probeToolDenial).not.toHaveBeenCalled();
  });

  it('adds a warning about a directory it could not remove after the finding of the check', async () => {
    const { report } = await validateToolDenial({
      roles: { grader: 'acme/model-a' },
      gradedCheck: true,
      probeToolDenial: vi.fn(async () => notShownBash('agent')),
      environments: (real) => ({
        ...real,
        createModelCallEnvironment: async (snapshot, agentVariables, configurationFiles) => {
          const created = await real.createModelCallEnvironment(
            snapshot,
            agentVariables,
            configurationFiles,
          );
          if (!created.ok) {
            return created;
          }
          return {
            ok: true,
            value: {
              ...created.value,
              dispose: async () => {
                await created.value.dispose();
                return {
                  ok: false,
                  error: { kind: 'ArtifactError', operation: 'remove', reason: 'busy' },
                };
              },
            },
          };
        },
      }),
    });

    const findings = report.findings.filter((finding) => finding.identifier === 'agents.opencode');
    expect(findings.map((finding) => finding.severity)).toContain('warning');
    const toolDenial = toolDenialFindings(report.findings);
    expect(toolDenial.map((finding) => finding.severity)).toEqual(['error', 'warning']);
    expect(toolDenial[1]?.message).toMatch(
      /^tool denial check directory could not be removed; retained at ".+"$/,
    );
  });
});
