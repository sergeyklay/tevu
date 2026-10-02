// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOpenCodeAdapter } from '@/adapters/agents/opencode/opencode';
import { createGitWorkspaceAdapter } from '@/adapters/git';
import {
  createEnvironmentAdapter,
  createRedactor,
  createSecretRedactor,
  runManagedProcess,
} from '@/adapters/process';

import { checkModelAccess, inspectModelProvider, probeAgent } from './model-access';

import type { AgentDraft, ModelAccessDependencies } from './model-access';
import type { AgentAdapter, EnvironmentAdapter, TevuConfig } from '@/domain/types';

const LITERAL_KEY = 'sk-test-literal';
const SET_VARIABLE = 'TEVU_MODEL_ACCESS_SET_KEY';
const SET_VALUE = 'sk-model-access-set-value-778899';
const UNSET_VARIABLE = 'TEVU_MODEL_ACCESS_UNSET_KEY';

type ModelsBehavior = 'list' | 'exit-3' | 'sleep';

const FAKE_OPENCODE_SCRIPT = (
  behavior: ModelsBehavior,
  recordPath: string,
): string => `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.0.0-model-access-fake'); process.exit(0); }
if (args[0] === '--help') { console.log('usage: fake-opencode <command>'); process.exit(0); }
if (args[0] === 'run' && args[1] === '--help') {
  console.log('usage: opencode run --format json --model <model> --variant <variant>');
  process.exit(0);
}
if (args[0] === 'export' && args[1] === '--help') {
  console.log('usage: opencode export <session-id>');
  process.exit(0);
}
if (args[0] === 'models' && args[1] === '--help') {
  console.log('usage: opencode models [provider] --verbose');
  process.exit(0);
}
if (args[0] === 'models' && args[1] !== '--verbose') {
  process.exit(3);
}
if (args[0] === 'models') {
  const xdg = process.env.XDG_CONFIG_HOME ?? '';
  let providers = [];
  try {
    providers = Object.keys(JSON.parse(readFileSync(join(xdg, 'opencode', 'opencode.json'), 'utf8')).provider ?? {});
  } catch {}
  writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
    pid: process.pid,
    argv: args,
    xdg,
    cwd: process.cwd(),
    hasGit: existsSync(join(process.cwd(), '.git')),
    env: process.env,
  }));
  ${
    behavior === 'sleep'
      ? 'setInterval(() => {}, 1000);'
      : behavior === 'exit-3'
        ? "console.error('synthetic listing failure'); process.exit(3);"
        : "console.log(['builtin/model-z', ...providers.flatMap((id) => [id + '/model-a', JSON.stringify({ id: 'model-a', variants: { low: {}, high: {} } }, null, 2), id + '/model-empty', JSON.stringify({ id: 'model-empty', variants: {} }, null, 2)])].join('\\n')); process.exit(0);"
  }
} else {
  process.exit(3);
}
`;

type ModelsRecord = {
  pid: number;
  argv: string[];
  xdg: string;
  cwd: string;
  hasGit: boolean;
  env: Record<string, string>;
};

let tempRoot: string;
let counter = 0;

function nextName(prefix: string, extension: string): string {
  counter += 1;
  return `${prefix}-${String(counter)}${extension}`;
}

async function writeFakeExecutable(
  behavior: ModelsBehavior = 'list',
  directory: string = tempRoot,
): Promise<{ executable: string; recordPath: string }> {
  await mkdir(directory, { recursive: true });
  const recordPath = join(tempRoot, nextName('record', '.json'));
  const executable = join(directory, nextName('fake-opencode', '.mjs'));
  await writeFile(executable, FAKE_OPENCODE_SCRIPT(behavior, recordPath), { mode: 0o755 });
  await chmod(executable, 0o755);
  return { executable, recordPath };
}

function readRecord(recordPath: string): ModelsRecord {
  return JSON.parse(readFileSync(recordPath, 'utf8')) as ModelsRecord;
}

async function createOperatorRoot(document?: unknown): Promise<string> {
  const root = await mkdtemp(join(tempRoot, 'operator-'));
  if (document !== undefined) {
    await writeOperatorFile(root, JSON.stringify(document));
  }
  return root;
}

async function writeOperatorFile(root: string, text: string): Promise<void> {
  await mkdir(join(root, 'opencode'), { recursive: true });
  await writeFile(join(root, 'opencode', 'opencode.json'), text);
}

type DependencyOptions = {
  operatorRoot?: string;
  cancellation?: AbortSignal;
  environments?: EnvironmentAdapter;
  wrapAdapter?: (adapter: AgentAdapter) => AgentAdapter;
  git?: ModelAccessDependencies['git'];
  blocks?: TevuConfig['agents']['opencode'][];
};

function buildDependencies(options: DependencyOptions = {}): ModelAccessDependencies {
  const secretValues = [SET_VALUE];
  return {
    agentsFor: (config) => {
      const block = config.agents.opencode;
      options.blocks?.push(block);
      const adapter = createOpenCodeAdapter(
        {
          agent: 'opencode',
          executable: block.command,
          providers: block.providers,
          declaredVariables: { secrets: block.secrets, env: block.env },
        },
        {
          runProcess: runManagedProcess,
          secrets: createSecretRedactor(() => secretValues, createRedactor(secretValues)),
          probeEnvironment: { PATH: process.env['PATH'] ?? '' },
          probeDirectory: process.cwd(),
          operatorDirectories: { home: undefined, xdgConfigHome: options.operatorRoot },
        },
      );
      return new Map([['opencode', options.wrapAdapter?.(adapter) ?? adapter]]);
    },
    environments: options.environments ?? createEnvironmentAdapter(),
    git:
      options.git ??
      createGitWorkspaceAdapter({ workspacesDirectory: join(tempRoot, 'workspaces') }),
    cancellation: options.cancellation ?? new AbortController().signal,
  };
}

function buildAgent(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return { command: 'opencode', secrets: [], env: [], providers: [], ...overrides };
}

/** Wraps the real environment adapter so every removal deletes the call directory and then fails, recording each root. */
function buildRetainingEnvironments(): { environments: EnvironmentAdapter; roots: string[] } {
  const real = createEnvironmentAdapter();
  const roots: string[] = [];
  const environments: EnvironmentAdapter = {
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
      roots.push(created.value.rootDirectory);
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
  };
  return { environments, roots };
}

const CONFIG_PATH = () => join(tempRoot, 'tevu.yaml');

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'tevu-model-access-it-'));
  process.env[SET_VARIABLE] = SET_VALUE;
  delete process.env[UNSET_VARIABLE];
});

afterAll(async () => {
  delete process.env[SET_VARIABLE];
  await rm(tempRoot, { recursive: true, force: true });
});

describe('probeAgent', () => {
  it('reports a capability report for a command that starts', async () => {
    const { executable } = await writeFakeExecutable();

    const outcome = await probeAgent(
      { configPath: CONFIG_PATH(), command: executable },
      buildDependencies(),
    );

    expect(outcome.ok).toBe(true);
  });

  it('reports a prerequisite failure for a command that does not start', async () => {
    const outcome = await probeAgent(
      { configPath: CONFIG_PATH(), command: join(tempRoot, 'no-such-agent') },
      buildDependencies(),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('PrerequisiteError');
  });

  it("resolves a relative command against the configuration file's directory", async () => {
    const configDirectory = join(tempRoot, 'project');
    const { executable } = await writeFakeExecutable('list', join(configDirectory, 'bin'));
    const relative = `./bin/${basename(executable)}`;
    const blocks: DependencyOptions['blocks'] = [];

    const outcome = await probeAgent(
      { configPath: join(configDirectory, 'tevu.yaml'), command: relative },
      buildDependencies({ blocks }),
    );

    expect(outcome.ok).toBe(true);
    expect(blocks).toEqual([{ command: executable, secrets: [], env: [], providers: [] }]);
  });
});

describe('inspectModelProvider', () => {
  it('names the text before the first slash as the provider and keeps the rest as the model', async () => {
    const operatorRoot = await createOperatorRoot({
      provider: { litellm: { options: { apiKey: '{env:LITELLM_KEY}' } } },
    });

    const outcome = await inspectModelProvider(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent(),
        model: 'litellm/anthropic/claude-opus-5',
      },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome).toEqual({
      ok: true,
      value: {
        provider: 'litellm',
        definition: {
          defined: true,
          keyVariables: ['LITELLM_KEY'],
          otherVariables: [],
          apiKey: 'reference',
        },
      },
    });
  });

  it('reports a provider the operator configuration does not define as undefined', async () => {
    const operatorRoot = await createOperatorRoot({ provider: { acme: {} } });

    const outcome = await inspectModelProvider(
      { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'openai/gpt-5' },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome).toEqual({
      ok: true,
      value: { provider: 'openai', definition: { defined: false } },
    });
  });

  it('reports a configuration failure for an invalid operator file', async () => {
    const operatorRoot = await createOperatorRoot();
    await writeOperatorFile(operatorRoot, '{ "provider": ');

    const outcome = await inspectModelProvider(
      { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'acme/model-a' },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.kind).toBe('ConfigValidationError');
  });

  it('carries no value from the operator file in the result', async () => {
    const operatorRoot = await createOperatorRoot({
      provider: {
        acme: { options: { apiKey: LITERAL_KEY, baseURL: 'https://acme.example.test' } },
      },
    });

    const outcome = await inspectModelProvider(
      { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'acme/model-a' },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome).toMatchObject({ ok: true, value: { definition: { apiKey: 'value' } } });
    expect(JSON.stringify(outcome)).not.toContain(LITERAL_KEY);
    expect(JSON.stringify(outcome)).not.toContain('acme.example.test');
  });
});

describe('checkModelAccess against a fake OpenCode executable', () => {
  const ACME_DEFINITION = {
    provider: { acme: { options: { baseURL: 'https://acme.example.test' } } },
  };

  it('reports a model as listed when the copied provider file reaches the fake listing', async () => {
    const { executable, recordPath } = await writeFakeExecutable();
    const operatorRoot = await createOperatorRoot(ACME_DEFINITION);

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable, providers: [{ id: 'acme' }] }),
        model: 'acme/model-a',
      },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome).toEqual({
      status: 'listed',
      variants: ['high', 'low'],
      unsetVariables: [],
      retainedDirectory: null,
    });
    expect(existsSync(recordPath)).toBe(true);
  });

  it('reports an empty variant list for a listed model whose record declares no variants', async () => {
    const { executable } = await writeFakeExecutable();
    const operatorRoot = await createOperatorRoot(ACME_DEFINITION);

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable, providers: [{ id: 'acme' }] }),
        model: 'acme/model-empty',
      },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome).toMatchObject({ status: 'listed', variants: [] });
  });

  it('reports no variant data for a listed model the listing prints without a record', async () => {
    const { executable } = await writeFakeExecutable();

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable }),
        model: 'builtin/model-z',
      },
      buildDependencies(),
    );

    expect(outcome).toMatchObject({ status: 'listed', variants: null });
  });

  it('asks the executable for the verbose listing', async () => {
    const { executable, recordPath } = await writeFakeExecutable();

    await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable }),
        model: 'builtin/model-z',
      },
      buildDependencies(),
    );

    expect(readRecord(recordPath).argv).toEqual(['models', '--verbose']);
  });

  it('reports a model the fake listing omits as not listed', async () => {
    const { executable } = await writeFakeExecutable();
    const operatorRoot = await createOperatorRoot(ACME_DEFINITION);

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable, providers: [{ id: 'acme' }] }),
        model: 'acme/model-other',
      },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome).toEqual({ status: 'not-listed', unsetVariables: [], retainedDirectory: null });
  });

  it('does not list a provider that was not copied into the environment', async () => {
    const { executable } = await writeFakeExecutable();
    const operatorRoot = await createOperatorRoot(ACME_DEFINITION);

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable }),
        model: 'acme/model-a',
      },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome).toMatchObject({ status: 'not-listed' });
  });

  it('reports a listing that exits with a failure code as a failed listing', async () => {
    const { executable } = await writeFakeExecutable('exit-3');

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable }),
        model: 'acme/model-a',
      },
      buildDependencies(),
    );

    expect(outcome).toEqual({
      status: 'listing-failed',
      detail: `"${executable} models --verbose" exits with code 3`,
      retainedDirectory: null,
    });
  });

  it('rejects a provider definition the credential rules refuse and names it without the literal', async () => {
    const { executable } = await writeFakeExecutable();
    const operatorRoot = await createOperatorRoot({
      provider: { acme: { options: { apiKey: LITERAL_KEY } } },
    });

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable, providers: [{ id: 'acme' }] }),
        model: 'acme/model-a',
      },
      buildDependencies({ operatorRoot }),
    );

    expect(outcome).toMatchObject({
      status: 'provider-rejected',
      findings: [{ severity: 'error', identifier: 'agents.opencode.providers.acme' }],
    });
    expect(outcome).not.toHaveProperty('retainedDirectory');
    expect(JSON.stringify(outcome)).not.toContain(LITERAL_KEY);
  });

  it('reports a cancellation without listing when the signal is already aborted', async () => {
    const { executable, recordPath } = await writeFakeExecutable();

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable }),
        model: 'acme/model-a',
      },
      buildDependencies({ cancellation: AbortSignal.abort() }),
    );

    expect(outcome).toEqual({ status: 'cancelled', retainedDirectory: null });
    expect(existsSync(recordPath)).toBe(false);
  });

  it('ends a running listing and removes its call directory when the signal aborts', async () => {
    const { executable, recordPath } = await writeFakeExecutable('sleep');
    const controller = new AbortController();

    const pending = checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable }),
        model: 'acme/model-a',
      },
      buildDependencies({ cancellation: controller.signal }),
    );
    while (!existsSync(recordPath) || readFileSync(recordPath, 'utf8').length === 0) {
      await delay(20);
    }
    const record = readRecord(recordPath);
    controller.abort();
    const outcome = await pending;

    expect(outcome).toEqual({ status: 'cancelled', retainedDirectory: null });
    expect(() => process.kill(record.pid, 0)).toThrow();
    expect(existsSync(dirname(record.cwd))).toBe(false);
  });

  it('reports a declared but unset variable while the listing still runs without it', async () => {
    const { executable, recordPath } = await writeFakeExecutable();

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable, secrets: [UNSET_VARIABLE, SET_VARIABLE] }),
        model: 'builtin/model-z',
      },
      buildDependencies(),
    );

    expect(outcome).toEqual({
      status: 'listed',
      variants: null,
      unsetVariables: [UNSET_VARIABLE],
      retainedDirectory: null,
    });
    const { env } = readRecord(recordPath);
    expect(env[SET_VARIABLE]).toBe(SET_VALUE);
    expect(env).not.toHaveProperty(UNSET_VARIABLE);
    expect(JSON.stringify(outcome)).not.toContain(SET_VALUE);
  });

  it('runs the listing in an empty repository and removes the environment afterwards', async () => {
    const { executable, recordPath } = await writeFakeExecutable();

    const outcome = await checkModelAccess(
      {
        configPath: CONFIG_PATH(),
        agent: buildAgent({ command: executable }),
        model: 'builtin/model-z',
      },
      buildDependencies(),
    );

    const record = readRecord(recordPath);
    expect(outcome).toMatchObject({ status: 'listed', retainedDirectory: null });
    expect(record.hasGit).toBe(true);
    expect(existsSync(record.cwd)).toBe(false);
  });

  describe('listing failures reported by the adapter and the environment', () => {
    it('reports a listing that timed out with its limit', async () => {
      const outcome = await checkModelAccess(
        { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'acme/model-a' },
        buildDependencies({
          wrapAdapter: (adapter) => ({
            ...adapter,
            listModels: async () => ({ outcome: 'timed-out', limitMs: 120_000 }),
          }),
        }),
      );

      expect(outcome).toEqual({
        status: 'listing-failed',
        detail: '"opencode models --verbose" did not finish within 120s',
        retainedDirectory: null,
      });
    });

    it('reports an environment that cannot be created as a failed listing', async () => {
      const environments: EnvironmentAdapter = {
        ...createEnvironmentAdapter(),
        createModelCallEnvironment: async () => ({
          ok: false,
          error: {
            kind: 'ArtifactError',
            operation: 'create-model-call-directory',
            reason: 'disk full',
          },
        }),
      };

      const outcome = await checkModelAccess(
        { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'acme/model-a' },
        buildDependencies({ environments }),
      );

      expect(outcome).toEqual({
        status: 'listing-failed',
        detail: 'create-model-call-directory: disk full',
        retainedDirectory: null,
      });
    });

    it('reports an unusable parent environment as a failed listing', async () => {
      const environments: EnvironmentAdapter = {
        ...createEnvironmentAdapter(),
        snapshotParent: () => ({
          ok: false,
          error: {
            kind: 'PrerequisiteError',
            tool: 'environment',
            expected: 'non-empty parent PATH',
            actual: 'empty',
          },
        }),
      };

      const outcome = await checkModelAccess(
        { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'acme/model-a' },
        buildDependencies({ environments }),
      );

      expect(outcome).toEqual({
        status: 'listing-failed',
        detail:
          'prerequisite "environment" is not satisfied; expected non-empty parent PATH, actual empty',
        retainedDirectory: null,
      });
    });

    it('reports a missing adapter as a failed listing with no directory', async () => {
      const dependencies = {
        ...buildDependencies(),
        agentsFor: () => new Map<string, AgentAdapter>(),
      };

      const outcome = await checkModelAccess(
        { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'acme/model-a' },
        dependencies,
      );

      expect(outcome).toEqual({
        status: 'listing-failed',
        detail: 'no adapter is registered for the agent',
        retainedDirectory: null,
      });
    });
  });

  describe('retained call directory of the listing', () => {
    const failingGit: ModelAccessDependencies['git'] = {
      initializeEmptyRepository: async () => ({
        ok: false,
        error: {
          kind: 'ArtifactError',
          operation: 'initialize-repository',
          reason: 'git init exited with code 1',
        },
      }),
    };

    function listsAs(listing: Awaited<ReturnType<AgentAdapter['listModels']>>) {
      return (adapter: AgentAdapter): AgentAdapter => ({
        ...adapter,
        listModels: async () => listing,
      });
    }

    const scenarios = [
      {
        name: 'a listing that timed out',
        options: (): DependencyOptions => ({
          wrapAdapter: listsAs({ outcome: 'timed-out', limitMs: 120_000 }),
        }),
        expected: (retainedDirectory: string | null) => ({
          status: 'listing-failed',
          detail: '"opencode models --verbose" did not finish within 120s',
          retainedDirectory,
        }),
      },
      {
        name: 'a listing that failed',
        options: (): DependencyOptions => ({
          wrapAdapter: listsAs({ outcome: 'failed', reason: 'exits with code 3' }),
        }),
        expected: (retainedDirectory: string | null) => ({
          status: 'listing-failed',
          detail: '"opencode models --verbose" exits with code 3',
          retainedDirectory,
        }),
      },
      {
        name: 'a listing cancelled while the adapter lists',
        options: (): DependencyOptions => {
          const controller = new AbortController();
          return {
            cancellation: controller.signal,
            wrapAdapter: (adapter) => ({
              ...adapter,
              listModels: async () => {
                controller.abort();
                return { outcome: 'cancelled' };
              },
            }),
          };
        },
        expected: (retainedDirectory: string | null) => ({
          status: 'cancelled',
          retainedDirectory,
        }),
      },
      {
        name: 'a repository that cannot be initialized',
        options: (): DependencyOptions => ({ git: failingGit }),
        expected: (retainedDirectory: string | null) => ({
          status: 'listing-failed',
          detail: 'initialize-repository: git init exited with code 1',
          retainedDirectory,
        }),
      },
    ];

    it.each(scenarios)(
      'keeps the status and detail and reports the root for $name when its removal fails',
      async ({ options, expected }) => {
        const { environments, roots } = buildRetainingEnvironments();

        const outcome = await checkModelAccess(
          { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'acme/model-a' },
          buildDependencies({ ...options(), environments }),
        );

        expect(roots).toHaveLength(1);
        expect(outcome).toEqual(expected(roots[0]!));
      },
    );

    it.each(scenarios)(
      'reports no directory for $name when its removal succeeds',
      async ({ options, expected }) => {
        const outcome = await checkModelAccess(
          { configPath: CONFIG_PATH(), agent: buildAgent(), model: 'acme/model-a' },
          buildDependencies(options()),
        );

        expect(outcome).toEqual(expected(null));
      },
    );
  });
});
