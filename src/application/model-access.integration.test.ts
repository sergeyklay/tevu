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
    git: createGitWorkspaceAdapter({ workspacesDirectory: join(tempRoot, 'workspaces') }),
    cancellation: options.cancellation ?? new AbortController().signal,
  };
}

function buildAgent(overrides: Partial<AgentDraft> = {}): AgentDraft {
  return { command: 'opencode', secrets: [], env: [], providers: [], ...overrides };
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

    expect(outcome).toEqual({ status: 'cancelled' });
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

    expect(outcome).toEqual({ status: 'cancelled' });
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
      });
    });
  });
});
