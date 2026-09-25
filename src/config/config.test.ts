// @vitest-environment node
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createConfigStore } from '@/adapters/artifact-store';
import { createGitWorkspaceAdapter } from '@/adapters/git';
import { createTask } from '@/application/create-task';
import { validateConfig } from '@/application/validate';

import { renderConfigDocument } from './document';
import { canonicalConfigSerialization, loadConfig, parseConfigText } from './load';
import { AGENT_NAMES, agentNamesInUse, agentSettingsSchema, TevuConfigSchema } from './schema';

import type {
  AgentName,
  CheckInput,
  ModelDefinitionInput,
  RepositoryDefinition,
  TaskInput,
  TevuConfig,
  TevuConfigInput,
} from './schema';
import type { TaskDependencies, TaskWizardInput } from '@/application/create-task';
import type {
  AgentAdapter,
  AgentCapabilityReport,
  ConfigStore,
  EnvironmentAdapter,
  GitWorkspaceAdapter,
  PrerequisiteAdapter,
  TevuError,
  TevuResult,
  ValidationDependencies,
} from '@/domain/types';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    readFile: vi.fn(actual.readFile),
  };
});

function expectOk<T>(outcome: { ok: true; value: T } | { ok: false; error: TevuError }): T {
  if (outcome.ok) {
    return outcome.value;
  }
  throw new Error(`expected success, got ${JSON.stringify(outcome.error)}`);
}

function expectFailure<K extends TevuError['kind']>(
  outcome: { ok: true; value: unknown } | { ok: false; error: TevuError },
  kind: K,
): Extract<TevuError, { kind: K }> {
  if (outcome.ok) {
    throw new Error(`expected a ${kind} failure, got success`);
  }
  if (outcome.error.kind !== kind) {
    throw new Error(`expected error kind ${kind}, got ${JSON.stringify(outcome.error)}`);
  }
  return outcome.error as Extract<TevuError, { kind: K }>;
}

function expectSchemaAcceptance(config: unknown): TevuConfig {
  const parsed = TevuConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`expected schema acceptance: ${JSON.stringify(parsed.error.issues)}`);
  }
  return parsed.data;
}

function expectSchemaRejection(config: unknown): Array<{ path: string; message: string }> {
  const parsed = TevuConfigSchema.safeParse(config);
  if (parsed.success) {
    throw new Error('expected the schema to reject this configuration');
  }
  return parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

function buildRepository(overrides: Partial<RepositoryDefinition> = {}): RepositoryDefinition {
  return { id: 'sample-repo', path: '/tmp/tevu/sample-repo', ...overrides };
}

function buildModel(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return { id: 'alpha', model: 'openai/gpt-5', effort: 'high', ...overrides };
}

function buildManualCheck(overrides: Partial<CheckInput> = {}): CheckInput {
  return { id: 'api-returns-200', description: 'The API returns 200', manual: true, ...overrides };
}

function buildCommandCheck(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    id: 'tests-pass',
    description: 'The tests pass',
    run: ['npm', 'test'],
    timeout: '1m',
    ...overrides,
  };
}

function buildTaskDefinition(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'write-report',
    title: 'Write the report',
    repo: 'sample-repo',
    base_commit: '0123456789abcdef0123456789abcdef01234567',
    description: 'Write a report',
    prompt: 'Write the report',
    readiness: ['The spec is approved'],
    checks: {
      acceptance: [buildManualCheck()],
      done: [buildCommandCheck()],
    },
    ...overrides,
  };
}

function buildRunSettings(overrides: Partial<TevuConfigInput['run']> = {}): TevuConfigInput['run'] {
  return {
    output_dir: '/tmp/tevu/runs',
    concurrency: 2,
    timeout: '10m',
    stop_grace: '3s',
    ...overrides,
  };
}

function buildAgents(
  overrides: Partial<TevuConfigInput['agents']['opencode']> = {},
): TevuConfigInput['agents'] {
  return { opencode: { command: 'opencode', secrets: [], env: [], ...overrides } };
}

function buildConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfigInput {
  return {
    version: 1,
    run: buildRunSettings(),
    agents: buildAgents(),
    repositories: [buildRepository()],
    models: [buildModel(), buildModel({ id: 'beta', model: 'anthropic/claude-4', effort: 'max' })],
    tasks: [buildTaskDefinition()],
    ...overrides,
  };
}

function buildTaskWizardInput(overrides: Partial<TaskWizardInput> = {}): TaskWizardInput {
  return {
    configPath: '/tmp/tevu/tevu.yaml',
    task: buildTaskDefinition({ id: 'new-task', title: 'New task', base_commit: 'abc123' }),
    ...overrides,
  };
}

/** A fully valid, rendered base document, used as the default existing-file text in `createTask` tests. */
function validBaseText(): string {
  const rendered = renderConfigDocument(buildConfig(), { redact: (text) => text });
  if (!rendered.ok) {
    throw new Error('expected the fixture configuration to render');
  }
  return rendered.value;
}

function buildConfigStore(overrides: Partial<ConfigStore> = {}): ConfigStore {
  return {
    exists: vi.fn(async () => true),
    requireDirectory: vi.fn(async () => ({ ok: true as const, value: undefined })),
    readText: vi.fn(async () => ({ ok: true as const, value: validBaseText() })),
    replaceText: vi.fn(async () => ({ ok: true as const, value: undefined })),
    ...overrides,
  };
}

function buildGit(
  overrides: Partial<Pick<GitWorkspaceAdapter, 'validateSource'>> = {},
): Pick<GitWorkspaceAdapter, 'validateSource'> {
  return {
    validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
      ok: true as const,
      value: {
        repositoryId: repository.id,
        requestedCommit: commit,
        resolvedCommit: `resolved-${commit}`,
      },
    })),
    ...overrides,
  };
}

function buildFullGit(overrides: Partial<GitWorkspaceAdapter> = {}): GitWorkspaceAdapter {
  return {
    ...buildGit(),
    snapshotPatchBase: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'ArtifactError' as const,
        operation: 'snapshot-patch-base',
        reason: 'not used in these tests',
      },
    })),
    createIsolatedCase: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'IsolationError' as const,
        caseId: 'unused',
        reason: 'not used in these tests',
      },
    })),
    capturePatch: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'ArtifactError' as const,
        operation: 'capture-patch',
        reason: 'not used in these tests',
      },
    })),
    readOverlay: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'CheckStateError' as const,
        step: 'overlay' as const,
        reason: 'not used in these tests',
      },
    })),
    applyCheckState: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'CheckStateError' as const,
        step: 'restore' as const,
        reason: 'not used in these tests',
      },
    })),
    dispose: vi.fn(async () => ({ ok: true as const, value: undefined })),
    ...overrides,
  };
}

function buildTaskDependencies(overrides: Partial<TaskDependencies> = {}): TaskDependencies {
  return {
    configStore: buildConfigStore(),
    git: buildGit(),
    registerSecrets: vi.fn(),
    redact: (text: string) => text,
    ...overrides,
  };
}

function buildAgentCapabilityReport(executable: string): AgentCapabilityReport {
  return {
    executable,
    detectedVersion: '1.0.0',
    capabilities: [
      { name: 'run command', required: true, availability: 'available' },
      { name: 'export command', required: true, availability: 'available' },
      { name: 'run --format json', required: true, availability: 'available' },
      { name: 'run --model', required: true, availability: 'available' },
      { name: 'run --variant', required: true, availability: 'available' },
    ],
    isolation: { denyOutsideWorktree: 'available' },
  };
}

function buildPrerequisites(overrides: Partial<PrerequisiteAdapter> = {}): PrerequisiteAdapter {
  return {
    probeHost: vi.fn(async () => ({
      ok: true as const,
      value: {
        platform: 'linux' as const,
        nodeVersion: '24.21.0',
        gitVersion: '2.45.0',
      },
    })),
    hasEnvironmentVariable: vi.fn(() => true),
    probeWritableDirectory: vi.fn(async () => ({ ok: true as const, value: undefined })),
    ...overrides,
  };
}

function buildFakeAgentAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    probe: vi.fn(async () => ({
      ok: true as const,
      value: buildAgentCapabilityReport('opencode'),
    })),
    run: vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'CancellationError' as const, activeCaseIds: [] },
    })),
    exportSession: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'AgentProtocolError' as const,
        agent: 'opencode',
        context: { phase: 'probe' as const },
        reason: 'not used in these tests',
      },
    })),
    normalizeMetrics: vi.fn(() => ({
      ok: false as const,
      error: {
        kind: 'AgentProtocolError' as const,
        agent: 'opencode',
        context: { phase: 'probe' as const },
        reason: 'not used in these tests',
      },
    })),
    ...overrides,
  };
}

function buildEnvironments(overrides: Partial<EnvironmentAdapter> = {}): EnvironmentAdapter {
  return {
    snapshotParent: vi.fn(() => ({
      ok: true as const,
      value: {
        path: '/usr/bin:/bin',
        agentValues: {},
        ordinaryEvaluatorValues: {},
        secretValues: [],
      },
    })),
    createCaseEnvironments: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'IsolationError' as const,
        caseId: 'unused',
        reason: 'not used in these tests',
      },
    })),
    ...overrides,
  };
}

function buildValidationDependencies(
  overrides: Partial<ValidationDependencies> = {},
): ValidationDependencies {
  return {
    git: buildFullGit(),
    // `validateConfig` re-validates the strict schema, whose only agent key
    // is `opencode`, so this test registry keeps that schema-declared name.
    agents: new Map([['opencode', buildFakeAgentAdapter()]]),
    environments: buildEnvironments(),
    prerequisites: buildPrerequisites(),
    ...overrides,
  };
}

function configYaml(options: {
  outputDirectory: string;
  repositoryPath: string;
  command: string;
  /** Extra `checks.*` lines, indented to six spaces, inserted before `acceptance:`. */
  checksExtra?: string;
}): string {
  return `version: 1
run:
  output_dir: ${options.outputDirectory}
  concurrency: 2
  timeout: 10m
  stop_grace: 3s
agents:
  opencode:
    command: ${options.command}
    secrets: []
    env: []
repositories:
  - id: sample-repo
    path: ${options.repositoryPath}
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
${options.checksExtra ?? ''}      acceptance:
        - id: api-returns-200
          description: The API returns 200
          manual: true
      done:
        - id: tests-pass
          description: The tests pass
          run: [npm, test]
          timeout: 1m
`;
}

describe('agentSettingsSchema', () => {
  it('accepts a minimal agent block and defaults secrets and env to empty arrays', () => {
    const parsed = agentSettingsSchema('opencode').safeParse({ command: 'opencode' });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ command: 'opencode', secrets: [], env: [] });
  });

  it('names the given agent in the both-lists message', () => {
    const parsed = agentSettingsSchema('claude').safeParse({
      command: 'claude',
      secrets: ['SHARED'],
      env: ['SHARED'],
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.message)).toContain(
      'environment variable "SHARED" appears in both agents.claude.secrets and agents.claude.env',
    );
  });
});

describe('AGENT_NAMES', () => {
  it("lists exactly the strict object's own keys", () => {
    expect(AGENT_NAMES).toEqual(['opencode']);
    const name: AgentName = 'opencode';
    expect(AGENT_NAMES).toContain(name);
  });
});

describe('agentNamesInUse', () => {
  it('returns the distinct models[].agent values in configuration order', () => {
    const config = expectSchemaAcceptance(
      buildConfig({
        models: [
          buildModel({ id: 'alpha', agent: 'opencode' }),
          buildModel({ id: 'beta', model: 'anthropic/claude-4', effort: 'max', agent: 'opencode' }),
        ],
      }),
    );

    expect(agentNamesInUse(config)).toEqual(['opencode']);
  });
});

describe('TevuConfigSchema', () => {
  it('accepts a minimal valid configuration and materializes its defaults', () => {
    const config = buildConfig();

    const accepted = expectSchemaAcceptance(config);
    expect(accepted.tasks[0]?.repo).toBe('sample-repo');
    expect(accepted.models[0]?.agent).toBe('opencode');
  });

  it.each([
    { level: 'top-level', config: { ...buildConfig(), telemetry: true } },
    {
      level: 'task',
      config: { ...buildConfig(), tasks: [{ ...buildTaskDefinition(), notes: 'extra' }] },
    },
  ])('rejects an unknown field at the $level', ({ config }) => {
    expect(TevuConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects a version other than 1', () => {
    expect(
      expectSchemaRejection({ ...buildConfig(), version: 2 }).map((issue) => issue.path),
    ).toContain('version');
  });

  it.each(['Bad-id', 'bad_id', '1bad', 'a'.repeat(65)])('rejects the invalid id %s', (id) => {
    expect(
      TevuConfigSchema.safeParse(buildConfig({ repositories: [buildRepository({ id })] })).success,
    ).toBe(false);
  });

  it.each(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'XDG_DATA_HOME'])(
    'rejects the fixed environment name %s',
    (name) => {
      const config = buildConfig({ agents: buildAgents({ secrets: [name] }) });

      expect(TevuConfigSchema.safeParse(config).success).toBe(false);
    },
  );

  it('rejects duplicate environment names within one collection', () => {
    const config = buildConfig({ agents: buildAgents({ secrets: ['SHARED', 'SHARED'] }) });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'duplicate environment variable name "SHARED"',
    );
  });

  it('rejects an environment variable declared for both secrets and env', () => {
    const config = buildConfig({ agents: buildAgents({ secrets: ['SHARED'], env: ['SHARED'] }) });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'environment variable "SHARED" appears in both agents.opencode.secrets and agents.opencode.env',
    );
  });

  it.each([
    { collection: 'repositories', config: { ...buildConfig(), repositories: [] } },
    { collection: 'models', config: { ...buildConfig(), models: [buildModel()] } },
    { collection: 'tasks', config: { ...buildConfig(), tasks: [] } },
  ])('rejects an empty or undersized $collection collection', ({ config }) => {
    expect(TevuConfigSchema.safeParse(config).success).toBe(false);
  });

  it.each([
    {
      collection: 'repositories',
      config: buildConfig({
        repositories: [buildRepository({ id: 'dup' }), buildRepository({ id: 'dup' })],
      }),
      path: 'repositories.1.id',
      message: 'duplicate repositories id "dup"',
    },
    {
      collection: 'models',
      config: buildConfig({
        models: [buildModel({ id: 'dup' }), buildModel({ id: 'dup', model: 'other/model' })],
      }),
      path: 'models.1.id',
      message: 'duplicate models id "dup"',
    },
    {
      collection: 'tasks',
      config: buildConfig({ tasks: [buildTaskDefinition(), buildTaskDefinition()] }),
      path: 'tasks.1.id',
      message: 'duplicate tasks id "write-report"',
    },
  ])('rejects duplicate $collection ids', ({ config, path, message }) => {
    expect(expectSchemaRejection(config)).toContainEqual({ path, message });
  });

  it('rejects a task referencing an unconfigured repository', () => {
    const config = buildConfig({ tasks: [buildTaskDefinition({ repo: 'ghost' })] });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'tasks.0.repo',
      message: 'repo must reference a configured repository',
    });
  });

  it("rejects a Jira credential variable listed in a check's env", () => {
    const config = buildConfig({
      trackers: {
        jira: { url: 'https://jira.example.com', email: '$JIRA_EMAIL', token: '$JIRA_TOKEN' },
      },
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ env: ['JIRA_TOKEN'] })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'tasks.0.checks.done.0.env.0',
      message: 'Jira credential variable "JIRA_TOKEN" must not be passed to a check',
    });
  });

  it('requires at least one required acceptance check', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck({ required: false })],
            done: [buildCommandCheck()],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'at least one acceptance check must be required',
    );
  });

  it('requires at least one required done check', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ required: false })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'at least one done check must be required',
    );
  });

  it('rejects duplicate check ids across acceptance and done', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck({ id: 'shared' })],
            done: [buildCommandCheck({ id: 'shared' })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'duplicate check id "shared" across checks.acceptance and checks.done',
    );
  });

  it.each([
    {
      field: 'imported_at',
      source: {
        kind: 'jira',
        key: 'PROJ-1',
        url: 'https://jira.example.com/browse/PROJ-1',
        imported_at: '2026-01-01',
        title: 's',
        body: 'd',
      },
      path: 'tasks.0.source.imported_at',
    },
    {
      field: 'url',
      source: {
        kind: 'jira',
        key: 'PROJ-1',
        url: 'not-a-url',
        imported_at: '2026-01-01T00:00:00Z',
        title: 's',
        body: 'd',
      },
      path: 'tasks.0.source.url',
    },
  ])('rejects an invalid imported task source $field', ({ source, path }) => {
    const config = buildConfig({
      tasks: [buildTaskDefinition({ source: source as TaskInput['source'] })],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(path);
  });

  it.each([
    { field: 'description', value: '   ' },
    { field: 'prompt', value: '\t ' },
  ])('rejects a whitespace-only task $field', ({ field, value }) => {
    const config = buildConfig({ tasks: [{ ...buildTaskDefinition(), [field]: value }] });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(`tasks.0.${field}`);
  });

  it('rejects a model without a namespace separator', () => {
    const config = {
      ...buildConfig(),
      models: [{ ...buildModel(), model: 'gpt-5' }, buildModel({ id: 'beta' })],
    };

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain('models.0.model');
  });

  it('rejects a non-positive command timeout', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ timeout: '0m' })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(
      'tasks.0.checks.done.0.timeout',
    );
  });

  it('rejects an empty exit_codes list', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ exit_codes: [] })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(
      'tasks.0.checks.done.0.exit_codes',
    );
  });

  it('rejects a non-HTTPS Jira base URL', () => {
    const config = buildConfig({
      trackers: {
        jira: { url: 'http://jira.example.com', email: '$JIRA_EMAIL', token: '$JIRA_TOKEN' },
      },
    });

    expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain('trackers.jira.url');
  });

  it('accepts a manual check without a command definition', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: { acceptance: [buildManualCheck()], done: [buildManualCheck({ id: 'docs' })] },
        }),
      ],
    });

    expect(expectSchemaAcceptance(config).tasks[0]?.checks.acceptance[0]).toEqual({
      id: 'api-returns-200',
      description: 'The API returns 200',
      manual: true,
      required: true,
    });
  });

  it('accepts a task with a github source', () => {
    const source: TaskInput['source'] = {
      kind: 'github',
      key: 'octo/repo#42',
      url: 'https://github.com/octo/repo/issues/42',
      imported_at: '2026-05-01T10:00:00.000Z',
      title: 'Export table as CSV',
      body: 'Users need an export button',
    };
    const config = buildConfig({ tasks: [buildTaskDefinition({ source })] });

    expect(expectSchemaAcceptance(config).tasks[0]?.source).toEqual(source);
  });

  it('rejects an unknown field inside a github task source', () => {
    const config = {
      ...buildConfig(),
      tasks: [
        {
          ...buildTaskDefinition(),
          source: {
            kind: 'github',
            key: 'octo/repo#42',
            url: 'https://github.com/octo/repo/issues/42',
            imported_at: '2026-05-01T10:00:00.000Z',
            title: 'Export table as CSV',
            body: 'Users need an export button',
            extra: 'field',
          },
        },
      ],
    };

    expect(TevuConfigSchema.safeParse(config).success).toBe(false);
  });

  it('accepts an explicit agent value naming a configured agent', () => {
    const config = buildConfig({
      models: [
        buildModel({ agent: 'opencode' }),
        buildModel({ id: 'beta', model: 'anthropic/claude-4', effort: 'max' }),
      ],
    });

    expect(expectSchemaAcceptance(config).models[0]?.agent).toBe('opencode');
  });

  it('rejects a model agent that does not name a configured agent', () => {
    const config = buildConfig({
      models: [
        buildModel({ agent: 'claude' }),
        buildModel({ id: 'beta', model: 'anthropic/claude-4', effort: 'max' }),
      ],
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'models.0.agent',
      message: 'agent must name a configured agent: opencode',
    });
  });

  it("defaults a task's repo to the sole configured repository", () => {
    const config = buildConfig({ tasks: [{ ...buildTaskDefinition(), repo: undefined }] });

    expect(expectSchemaAcceptance(config).tasks[0]?.repo).toBe('sample-repo');
  });

  it('requires repo when more than one repository is configured', () => {
    const config = buildConfig({
      repositories: [buildRepository(), buildRepository({ id: 'second-repo' })],
      tasks: [{ ...buildTaskDefinition(), repo: undefined }],
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'tasks.0.repo',
      message: 'repo is required when more than one repository is configured',
    });
  });

  it('rejects a check with neither run nor manual', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [{ id: 'no-form', description: 'x' }],
            done: [buildCommandCheck()],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'a check needs run (a command) or manual: true',
    );
  });

  it('rejects a check with both run and manual', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [{ ...buildCommandCheck(), manual: true }],
            done: [buildCommandCheck()],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'a check has either run or manual: true, not both',
    );
  });

  it('rejects manual: false', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [{ id: 'bad-manual', description: 'x', manual: false }],
            done: [buildCommandCheck()],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'manual must be true; omit it for a command check',
    );
  });

  it.each(['timeout', 'exit_codes', 'env'] as const)(
    'rejects %s specified on a manual check',
    (key) => {
      const overSpecified = {
        id: 'over-specified',
        description: 'x',
        manual: true,
        [key]: key === 'timeout' ? '1m' : key === 'exit_codes' ? [0] : ['NAME'],
      };
      const config = buildConfig({
        tasks: [
          buildTaskDefinition({
            checks: { acceptance: [overSpecified], done: [buildCommandCheck()] },
          }),
        ],
      });

      expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
        `only a command check (with run) accepts ${key}`,
      );
    },
  );

  it("resolves a command check's timeout from run.check_timeout when omitted", () => {
    const config = buildConfig({
      run: buildRunSettings({ check_timeout: '5m' }),
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ timeout: undefined })],
          },
        }),
      ],
    });

    expect(expectSchemaAcceptance(config).tasks[0]?.checks.done[0]).toMatchObject({
      timeout: '5m',
    });
  });

  it('rejects a command check with no timeout and no run.check_timeout', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ timeout: undefined })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config).map((issue) => issue.message)).toContain(
      'set timeout on this check or run.check_timeout',
    );
  });

  it('rejects a check env variable also passed to the agent', () => {
    const config = buildConfig({
      agents: buildAgents({ secrets: ['OPENAI_API_KEY'] }),
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ env: ['OPENAI_API_KEY'] })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'tasks.0.checks.done.0.env.0',
      message:
        'environment variable "OPENAI_API_KEY" is passed to the agent and cannot also be passed to a check',
    });
  });

  it("rejects a Jira email variable listed in a check's env", () => {
    const config = buildConfig({
      trackers: {
        jira: { url: 'https://jira.example.com', email: '$JIRA_EMAIL', token: '$JIRA_TOKEN' },
      },
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ env: ['JIRA_EMAIL'] })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'tasks.0.checks.done.0.env.0',
      message: 'Jira credential variable "JIRA_EMAIL" must not be passed to a check',
    });
  });

  it("rejects duplicate variable names within one check's env", () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ env: ['NODE_OPTIONS', 'NODE_OPTIONS'] })],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'tasks.0.checks.done.0.env.1',
      message: 'duplicate environment variable name "NODE_OPTIONS" in check env',
    });
  });

  it('re-parses its own materialized output to a deeply equal value', () => {
    const parsedOnce = expectSchemaAcceptance(buildConfig());

    const parsedTwice = expectSchemaAcceptance(parsedOnce);

    expect(parsedTwice).toEqual(parsedOnce);
  });

  it('accepts a duration at the 2147483647ms bound', () => {
    const config = buildConfig({ run: buildRunSettings({ timeout: '2147483647ms' }) });

    expect(TevuConfigSchema.safeParse(config).success).toBe(true);
  });

  it.each(['2147483648ms', '900h'])(
    'rejects the duration %s for exceeding the 2147483647ms bound',
    (value) => {
      const config = buildConfig({ run: buildRunSettings({ timeout: value }) });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'run.timeout',
        message: 'must be at most 2147483647ms',
      });
    },
  );

  it.each(['0s', '01s', '10x', 'abc', '5'])(
    'rejects the malformed duration %s with the grammar message',
    (value) => {
      const config = buildConfig({ run: buildRunSettings({ timeout: value }) });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'run.timeout',
        message:
          'must be a positive whole number followed by ms, s, m, or h, for example 30s or 10m',
      });
    },
  );

  it.each(['1bad', 'bad-name', 'name!', ''])(
    'rejects the malformed variable name %s with the grammar message',
    (name) => {
      const config = buildConfig({ agents: buildAgents({ secrets: [name] }) });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'agents.opencode.secrets.0',
        message: 'must be a letter or underscore followed by letters, digits, or underscores',
      });
    },
  );

  it.each(['JIRA_EMAIL', '$JIRA-EMAIL', '$1BAD', ''])(
    'rejects the Jira email value %s that is not a $VARIABLE reference',
    (value) => {
      const config = buildConfig({
        trackers: { jira: { url: 'https://jira.example.com', email: value, token: '$JIRA_TOKEN' } },
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'trackers.jira.email',
        message:
          'must be a $VARIABLE reference, for example $JIRA_API_TOKEN; secret values are never written here',
      });
    },
  );

  describe('run.repeat', () => {
    it('defaults to 1 when omitted', () => {
      const config = expectSchemaAcceptance(buildConfig());

      expect(config.run.repeat).toBe(1);
    });

    it.each([3, 3.0, 100])('accepts %s', (value) => {
      const config = buildConfig({ run: buildRunSettings({ repeat: value }) });

      expect(TevuConfigSchema.safeParse(config).success).toBe(true);
    });

    it.each([
      { value: 0, message: 'Too small: expected number to be >=1' },
      { value: -1, message: 'Too small: expected number to be >=1' },
      { value: 1.5, message: 'Invalid input: expected int, received number' },
      { value: 101, message: 'Too big: expected number to be <=100' },
    ])('rejects $value with the message $message', ({ value, message }) => {
      const config = buildConfig({ run: buildRunSettings({ repeat: value }) });

      expect(expectSchemaRejection(config)).toContainEqual({ path: 'run.repeat', message });
    });

    it('rejects the string "3"', () => {
      const config = buildConfig({ run: buildRunSettings({ repeat: '3' as unknown as number }) });

      expect(TevuConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects null', () => {
      const config = buildConfig({ run: buildRunSettings({ repeat: null as unknown as number }) });

      expect(TevuConfigSchema.safeParse(config).success).toBe(false);
    });

    it('passes at the MAX_REPEAT bound of 100 and rejects 101 over it (AC-14)', () => {
      expect(
        TevuConfigSchema.safeParse(buildConfig({ run: buildRunSettings({ repeat: 100 }) })).success,
      ).toBe(true);
      expect(
        expectSchemaRejection(buildConfig({ run: buildRunSettings({ repeat: 101 }) })),
      ).toContainEqual({ path: 'run.repeat', message: 'Too big: expected number to be <=100' });
    });
  });

  describe('run.repeat as a YAML scalar', () => {
    function yamlWithRepeat(repeatLiteral: string): string {
      const base = configYaml({
        outputDirectory: './runs',
        repositoryPath: './repo',
        command: 'opencode',
      });
      return base.replace('  concurrency: 2\n', `  concurrency: 2\n  repeat: ${repeatLiteral}\n`);
    }

    it.each(['3', '03', '3.0', '+3'])('accepts the YAML scalar %s, resolving to 3', (literal) => {
      const parsed = parseConfigText(yamlWithRepeat(literal));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.run.repeat).toBe(3);
    });

    it('accepts the YAML scalar 1e2, resolving to 100', () => {
      const parsed = parseConfigText(yamlWithRepeat('1e2'));

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.run.repeat).toBe(100);
    });

    it.each(['1e3', '"3"', 'null'])('rejects the YAML scalar %s', (literal) => {
      const parsed = parseConfigText(yamlWithRepeat(literal));

      expect(parsed.ok).toBe(false);
    });
  });

  describe('repository setup', () => {
    function buildSetupRepository(
      setup: Partial<NonNullable<RepositoryDefinition['setup']>>,
    ): RepositoryDefinition {
      return buildRepository({
        setup: { before_agent: [['npm', 'ci']], timeout: '1m', env: [], ...setup },
      });
    }

    it('rejects an empty setup block for both R1 and R3', () => {
      const config = buildConfig({
        repositories: [buildRepository({ setup: {} as RepositoryDefinition['setup'] })],
      });

      const issues = expectSchemaRejection(config);

      expect(issues).toContainEqual({
        path: 'repositories.0.setup',
        message: 'setup must declare a command in before_agent, before_checks, or both',
      });
      expect(issues).toContainEqual({
        path: 'repositories.0.setup.timeout',
        message: 'timeout is required when setup is declared',
      });
    });

    it('rejects a setup block whose phases are both absent or empty (R1)', () => {
      const config = buildConfig({
        repositories: [buildSetupRepository({ before_agent: [], before_checks: [] })],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'repositories.0.setup',
        message: 'setup must declare a command in before_agent, before_checks, or both',
      });
    });

    it.each([
      { label: 'an empty command array', command: [] },
      { label: 'a command with an empty-string executable', command: [''] },
    ])('rejects $label (R2)', ({ command }) => {
      const config = buildConfig({
        repositories: [
          buildSetupRepository({ before_agent: [command as unknown as [string, ...string[]]] }),
        ],
      });

      expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(
        'repositories.0.setup.before_agent.0.0',
      );
    });

    it('rejects a setup block with no timeout (R3)', () => {
      const config = buildConfig({
        repositories: [
          buildRepository({
            setup: { before_agent: [['npm', 'ci']] } as unknown as RepositoryDefinition['setup'],
          }),
        ],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'repositories.0.setup.timeout',
        message: 'timeout is required when setup is declared',
      });
    });

    it('rejects a setup.env name also passed to the agent (R4)', () => {
      const config = buildConfig({
        agents: buildAgents({ secrets: ['AGENT_SECRET'] }),
        repositories: [buildSetupRepository({ env: ['AGENT_SECRET'] })],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'repositories.0.setup.env.0',
        message:
          'environment variable "AGENT_SECRET" is passed to the agent and cannot also be passed to a setup command',
      });
    });

    it.each(['email', 'token'] as const)(
      'rejects a setup.env name that is the Jira %s credential variable',
      (field) => {
        const variableName = field === 'email' ? 'JIRA_EMAIL' : 'JIRA_TOKEN';
        const config = buildConfig({
          trackers: {
            jira: { url: 'https://jira.example.com', email: '$JIRA_EMAIL', token: '$JIRA_TOKEN' },
          },
          repositories: [buildSetupRepository({ env: [variableName] })],
        });

        expect(expectSchemaRejection(config)).toContainEqual({
          path: 'repositories.0.setup.env.0',
          message: `Jira credential variable "${variableName}" must not be passed to a setup command`,
        });
      },
    );

    it('rejects a duplicate name within setup.env', () => {
      const config = buildConfig({
        repositories: [buildSetupRepository({ env: ['SHARED', 'SHARED'] })],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'repositories.0.setup.env.1',
        message: 'duplicate environment variable name "SHARED"',
      });
    });

    it('rejects a fixed environment name within setup.env', () => {
      const config = buildConfig({
        repositories: [buildSetupRepository({ env: ['PATH'] })],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'repositories.0.setup.env.0',
        message:
          'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract and cannot be configured',
      });
    });

    it('rejects setup: null', () => {
      const config = buildConfig({
        repositories: [
          buildRepository({ setup: null as unknown as RepositoryDefinition['setup'] }),
        ],
      });

      expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(
        'repositories.0.setup',
      );
    });

    it('rejects an unknown key inside setup', () => {
      const config = buildConfig({
        repositories: [
          buildRepository({
            setup: {
              before_agent: [['npm', 'ci']],
              timeout: '1m',
              extra: true,
            } as unknown as RepositoryDefinition['setup'],
          }),
        ],
      });

      expect(TevuConfigSchema.safeParse(config).success).toBe(false);
    });

    it('materializes before_agent: [] as an absent key when before_checks holds a command', () => {
      const config = buildConfig({
        repositories: [buildSetupRepository({ before_agent: [], before_checks: [['npm', 'ci']] })],
      });

      const accepted = expectSchemaAcceptance(config);

      expect(accepted.repositories[0]?.setup).toEqual({
        before_checks: [['npm', 'ci']],
        timeout: '1m',
        env: [],
      });
    });
  });
});

describe('loadConfig', () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), 'tevu-config-'));
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function writeConfigFile(content: string): Promise<string> {
    const filePath = join(tempDirectory, 'tevu.yaml');
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  it('reads a valid configuration and resolves relative paths against its directory', async () => {
    const configPath = await writeConfigFile(
      configYaml({
        outputDirectory: './runs',
        repositoryPath: './repo',
        command: './bin/opencode',
      }),
    );

    const config = expectOk(await loadConfig(configPath));

    expect(config.run.output_dir).toBe(join(tempDirectory, 'runs'));
    expect(config.repositories[0]?.path).toBe(join(tempDirectory, 'repo'));
    expect(config.agents.opencode.command).toBe(join(tempDirectory, 'bin/opencode'));
    expect(config.tasks).toHaveLength(1);
    expect(config.models).toHaveLength(2);
  });

  it('keeps a bare command name unresolved', async () => {
    const configPath = await writeConfigFile(
      configYaml({ outputDirectory: './runs', repositoryPath: './repo', command: 'opencode' }),
    );

    const config = expectOk(await loadConfig(configPath));

    expect(config.agents.opencode.command).toBe('opencode');
  });

  const isRoot = process.getuid?.() === 0;

  it.each([
    {
      description: 'a missing file',
      buildPath: async (dir: string) => join(dir, 'missing.yaml'),
    },
    {
      description: 'a file under a missing directory',
      buildPath: async (dir: string) => join(dir, 'nonexistent-dir', 'tevu.yaml'),
    },
    {
      description: 'a path through a regular file',
      buildPath: async (dir: string) => {
        const regularFile = join(dir, 'regular-file');
        await fs.writeFile(regularFile, 'not a directory', 'utf8');
        return join(regularFile, 'tevu.yaml');
      },
    },
  ])('reports not-found for $description', async ({ buildPath }) => {
    const requestedPath = await buildPath(tempDirectory);

    const error = expectFailure(await loadConfig(requestedPath), 'ConfigReadError');

    expect(error).toEqual({
      kind: 'ConfigReadError',
      path: resolve(requestedPath),
      requestedPath,
      cause: 'not-found',
    });
  });

  it.each([
    { description: 'a directory', buildPath: async (dir: string) => dir },
    { description: 'a character device', buildPath: async () => '/dev/null' },
  ])('reports not-a-file for $description', async ({ buildPath }) => {
    const requestedPath = await buildPath(tempDirectory);

    const error = expectFailure(await loadConfig(requestedPath), 'ConfigReadError');

    expect(error).toEqual({
      kind: 'ConfigReadError',
      path: resolve(requestedPath),
      requestedPath,
      cause: 'not-a-file',
    });
  });

  it.skipIf(isRoot)('reports permission-denied for a file at mode 000', async () => {
    const requestedPath = join(tempDirectory, 'no-read.yaml');
    await fs.writeFile(requestedPath, 'version: 1\n', 'utf8');
    await fs.chmod(requestedPath, 0o000);

    try {
      const error = expectFailure(await loadConfig(requestedPath), 'ConfigReadError');

      expect(error).toEqual({
        kind: 'ConfigReadError',
        path: resolve(requestedPath),
        requestedPath,
        cause: 'permission-denied',
      });
    } finally {
      await fs.chmod(requestedPath, 0o644);
    }
  });

  it.skipIf(isRoot)(
    'reports permission-denied for a file under a directory at mode 000',
    async () => {
      const lockedDirectory = join(tempDirectory, 'locked');
      await fs.mkdir(lockedDirectory);
      const requestedPath = join(lockedDirectory, 'tevu.yaml');
      await fs.writeFile(requestedPath, 'version: 1\n', 'utf8');
      await fs.chmod(lockedDirectory, 0o000);

      try {
        const error = expectFailure(await loadConfig(requestedPath), 'ConfigReadError');

        expect(error).toEqual({
          kind: 'ConfigReadError',
          path: resolve(requestedPath),
          requestedPath,
          cause: 'permission-denied',
        });
      } finally {
        await fs.chmod(lockedDirectory, 0o700);
      }
    },
  );

  it('reports unreadable for a symbolic link loop', async () => {
    await fs.symlink('loop-b', join(tempDirectory, 'loop-a'));
    await fs.symlink('loop-a', join(tempDirectory, 'loop-b'));
    const requestedPath = join(tempDirectory, 'loop-a');

    const error = expectFailure(await loadConfig(requestedPath), 'ConfigReadError');

    expect(error).toEqual({
      kind: 'ConfigReadError',
      path: resolve(requestedPath),
      requestedPath,
      cause: 'unreadable',
    });
  });

  it('classifies an injected EPERM stat failure as permission-denied', async () => {
    const requestedPath = join(tempDirectory, 'tevu.yaml');
    vi.mocked(fs.stat).mockRejectedValueOnce(
      Object.assign(new Error('blocked'), { code: 'EPERM' }),
    );

    const error = expectFailure(await loadConfig(requestedPath), 'ConfigReadError');

    expect(error).toEqual({
      kind: 'ConfigReadError',
      path: resolve(requestedPath),
      requestedPath,
      cause: 'permission-denied',
    });
  });

  it('classifies an injected EISDIR readFile failure after a successful regular-file stat as not-a-file', async () => {
    const requestedPath = await writeConfigFile('version: 1\n');
    vi.mocked(fs.readFile).mockRejectedValueOnce(
      Object.assign(new Error('is a directory'), { code: 'EISDIR' }),
    );

    const error = expectFailure(await loadConfig(requestedPath), 'ConfigReadError');

    expect(error).toEqual({
      kind: 'ConfigReadError',
      path: resolve(requestedPath),
      requestedPath,
      cause: 'not-a-file',
    });
  });

  it('classifies an injected failure without a string code as unreadable', async () => {
    const requestedPath = join(tempDirectory, 'tevu.yaml');
    vi.mocked(fs.stat).mockRejectedValueOnce('boom');

    const error = expectFailure(await loadConfig(requestedPath), 'ConfigReadError');

    expect(error).toEqual({
      kind: 'ConfigReadError',
      path: resolve(requestedPath),
      requestedPath,
      cause: 'unreadable',
    });
  });

  it('reports a ConfigParseError with a line identifier for malformed YAML', async () => {
    const configPath = await writeConfigFile('version: 1\nbroken: [1, 2');

    const error = expectFailure(await loadConfig(configPath), 'ConfigParseError');

    expect(error.findings.length).toBeGreaterThan(0);
    expect(error.findings[0]?.severity).toBe('error');
    expect(error.findings[0]?.identifier).toBe('line 2');
    expect(error.findings[0]?.message).toMatch(/^Invalid YAML \(/);
  });

  it('reports ConfigParseError when YAML aliases cannot be resolved', async () => {
    const configPath = await writeConfigFile('m:\n  <<: *missing\n');

    const error = expectFailure(await loadConfig(configPath), 'ConfigParseError');

    expect(error.findings).toEqual([
      { severity: 'error', identifier: 'config', message: 'Cannot resolve YAML aliases' },
    ]);
  });

  it('reports field identifiers for schema violations', async () => {
    const configPath = await writeConfigFile('version: 2\n');

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    const identifiers = error.findings.map((finding) => finding.identifier);
    expect(identifiers).toContain('version');
    expect(identifiers).toContain('models');
    expect(identifiers).toContain('tasks');
  });

  it('reports unknown top-level fields as unknown configuration fields', async () => {
    const configPath = await writeConfigFile(
      `${configYaml({ outputDirectory: './runs', repositoryPath: './repo', command: 'opencode' })}\nunknownSection: {}\n`,
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toContainEqual({
      severity: 'error',
      identifier: 'config',
      message: 'Unknown configuration field',
    });
  });

  it('rejects a run output directory inside a repository after real-path resolution', async () => {
    await fs.mkdir(join(tempDirectory, 'repo'), { recursive: true });
    const configPath = await writeConfigFile(
      configYaml({
        outputDirectory: './repo/.tevu',
        repositoryPath: './repo',
        command: 'opencode',
      }),
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toEqual([
      {
        severity: 'error',
        identifier: 'run.output_dir',
        message:
          'run.output_dir must be outside repository "sample-repo" after real-path resolution',
      },
    ]);
  });

  it('rejects a repository inside the run output directory after real-path resolution', async () => {
    await fs.mkdir(join(tempDirectory, 'runs', 'repo'), { recursive: true });
    const configPath = await writeConfigFile(
      configYaml({ outputDirectory: './runs', repositoryPath: './runs/repo', command: 'opencode' }),
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toEqual([
      {
        severity: 'error',
        identifier: 'repositories.sample-repo.path',
        message:
          'repository "sample-repo" overlaps the run output directory after real-path resolution',
      },
    ]);
  });

  it('rejects a run output directory that symlinks into a repository', async () => {
    await fs.mkdir(join(tempDirectory, 'repo'), { recursive: true });
    await fs.symlink(join(tempDirectory, 'repo'), join(tempDirectory, 'runs-link'));
    const configPath = await writeConfigFile(
      configYaml({ outputDirectory: './runs-link', repositoryPath: './repo', command: 'opencode' }),
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toEqual([
      {
        severity: 'error',
        identifier: 'run.output_dir',
        message:
          'run.output_dir must be outside repository "sample-repo" after real-path resolution',
      },
    ]);
  });

  it('round-trips a github task source through ConfigStore.replaceText and readText', async () => {
    const configPath = join(tempDirectory, 'tevu.yaml');
    const source: TaskInput['source'] = {
      kind: 'github',
      key: 'octo/repo#42',
      url: 'https://github.com/octo/repo/issues/42',
      imported_at: '2026-05-01T10:00:00.000Z',
      title: 'Export table as CSV',
      body: 'Users need an export button',
    };
    const config = buildConfig({
      run: buildRunSettings({ output_dir: join(tempDirectory, 'artifacts') }),
      repositories: [buildRepository({ path: join(tempDirectory, 'repo') })],
      tasks: [buildTaskDefinition({ source })],
    });
    const configStore = createConfigStore({ redact: (text) => text });
    const { renderConfigDocument } = await import('./document');
    const rendered = renderConfigDocument(config, { redact: (text) => text });
    if (!rendered.ok) throw new Error('render failed');

    const replaced = await configStore.replaceText(configPath, rendered.value);
    expect(replaced.ok).toBe(true);
    const loaded = await configStore.readText(configPath);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value).toBe(rendered.value);
  });
});

describe('createConfigStore.exists', () => {
  const configStore = createConfigStore({ redact: (text) => text });
  const isRoot = process.getuid?.() === 0;
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), 'tevu-config-store-'));
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it('resolves false for a missing file', async () => {
    await expect(configStore.exists(join(tempDirectory, 'missing.yaml'))).resolves.toBe(false);
  });

  it('resolves false for a file under a missing directory', async () => {
    await expect(
      configStore.exists(join(tempDirectory, 'nonexistent-dir', 'tevu.yaml')),
    ).resolves.toBe(false);
  });

  it('resolves true for an existing file', async () => {
    const filePath = join(tempDirectory, 'tevu.yaml');
    await fs.writeFile(filePath, 'version: 1\n', 'utf8');

    await expect(configStore.exists(filePath)).resolves.toBe(true);
  });

  it('resolves true for a directory', async () => {
    await expect(configStore.exists(tempDirectory)).resolves.toBe(true);
  });

  it('resolves true for a path through a regular file', async () => {
    const regularFile = join(tempDirectory, 'regular-file');
    await fs.writeFile(regularFile, 'not a directory', 'utf8');

    await expect(configStore.exists(join(regularFile, 'tevu.yaml'))).resolves.toBe(true);
  });

  it.skipIf(isRoot)('resolves true for a file under a directory at mode 000', async () => {
    const lockedDirectory = join(tempDirectory, 'locked');
    await fs.mkdir(lockedDirectory);
    const filePath = join(lockedDirectory, 'tevu.yaml');
    await fs.writeFile(filePath, 'version: 1\n', 'utf8');
    await fs.chmod(lockedDirectory, 0o000);

    try {
      await expect(configStore.exists(filePath)).resolves.toBe(true);
    } finally {
      await fs.chmod(lockedDirectory, 0o700);
    }
  });

  it('resolves true for a trailing-slash path and a redundant-segment path when the file exists', async () => {
    const filePath = join(tempDirectory, 'tevu.yaml');
    await fs.writeFile(filePath, 'version: 1\n', 'utf8');

    await expect(configStore.exists(`${filePath}/`)).resolves.toBe(true);
    await expect(configStore.exists(join(tempDirectory, 'nodir', '..', 'tevu.yaml'))).resolves.toBe(
      true,
    );
  });
});

describe('createConfigStore.requireDirectory', () => {
  const configStore = createConfigStore({ redact: (text) => text });
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), 'tevu-config-store-dir-'));
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it('resolves a PrerequisiteError naming the absolute missing directory for a file under it', async () => {
    const missingDirectory = join(tempDirectory, 'nonexistent-dir');
    const filePath = join(missingDirectory, 'tevu.yaml');

    const result = await configStore.requireDirectory(filePath);

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'PrerequisiteError',
        tool: 'configuration directory',
        expected: 'an existing directory',
        actual: `${resolve(missingDirectory)} does not exist`,
      },
    });
  });

  it('resolves success for a missing file in an existing directory', async () => {
    const result = await configStore.requireDirectory(join(tempDirectory, 'missing.yaml'));

    expect(result).toEqual({ ok: true, value: undefined });
  });

  it('resolves success for an existing file', async () => {
    const filePath = join(tempDirectory, 'tevu.yaml');
    await fs.writeFile(filePath, 'version: 1\n', 'utf8');

    const result = await configStore.requireDirectory(filePath);

    expect(result).toEqual({ ok: true, value: undefined });
  });
});

describe('ConfigStore.readText and loadConfig ConfigReadError parity', () => {
  let tempDirectory: string;
  const isRoot = process.getuid?.() === 0;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), 'tevu-config-parity-'));
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function expectAgreement(requestedPath: string): Promise<void> {
    const configStore = createConfigStore({ redact: (text) => text });

    const fromStore = await configStore.readText(requestedPath);
    const fromLoad = await loadConfig(requestedPath);

    expect(fromStore.ok).toBe(false);
    expect(fromLoad.ok).toBe(false);
    if (fromStore.ok || fromLoad.ok) return;
    expect(fromStore.error).toEqual(fromLoad.error);
  }

  it('agree for a missing file', async () => {
    await expectAgreement(join(tempDirectory, 'missing.yaml'));
  });

  it('agree for a file under a missing directory', async () => {
    await expectAgreement(join(tempDirectory, 'nonexistent-dir', 'tevu.yaml'));
  });

  it('agree for a directory', async () => {
    await expectAgreement(tempDirectory);
  });

  it('agree for a FIFO', async () => {
    const requestedPath = join(tempDirectory, 'config.fifo');
    execFileSync('mkfifo', [requestedPath]);

    await expectAgreement(requestedPath);
  });

  it.skipIf(isRoot)('agree for a file without read permission', async () => {
    const requestedPath = join(tempDirectory, 'no-read.yaml');
    await fs.writeFile(requestedPath, 'version: 1\n', 'utf8');
    await fs.chmod(requestedPath, 0o000);

    try {
      await expectAgreement(requestedPath);
    } finally {
      await fs.chmod(requestedPath, 0o644);
    }
  });
});

describe('ConfigStore.replaceText permission preservation', () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), 'tevu-config-permissions-'));
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function replaceAndReadMode(configPath: string, content: string): Promise<number> {
    const configStore = createConfigStore({ redact: (text) => text });

    const replaced = await configStore.replaceText(configPath, content);

    expect(replaced.ok).toBe(true);
    const stats = await fs.stat(configPath);
    return stats.mode & 0o777;
  }

  it("keeps a replaced file's mode 0600 unchanged", async () => {
    const originalUmask = process.umask(0o022);
    try {
      const configPath = join(tempDirectory, 'tevu.yaml');
      await fs.writeFile(configPath, 'version: 1\n', 'utf8');
      await fs.chmod(configPath, 0o600);

      expect(await replaceAndReadMode(configPath, 'version: 1\nupdated: true\n')).toBe(0o600);
    } finally {
      process.umask(originalUmask);
    }
  });

  // Documents a known production gap: `atomicReplaceFile` opens the temporary
  // file with the preserved mode but never bypasses the process umask, so the
  // kernel still masks a group-write bit the original file carried. See the
  // testing summary for reproduction evidence; production code is out of
  // this suite's scope to fix.
  it("keeps a replaced file's mode 0664 unchanged under umask 022", async () => {
    const originalUmask = process.umask(0o022);
    try {
      const configPath = join(tempDirectory, 'tevu.yaml');
      await fs.writeFile(configPath, 'version: 1\n', 'utf8');
      await fs.chmod(configPath, 0o664);

      expect(await replaceAndReadMode(configPath, 'version: 1\nupdated: true\n')).toBe(0o664);
    } finally {
      process.umask(originalUmask);
    }
  });

  it('gives a newly created configuration file mode 0644 under umask 022', async () => {
    const originalUmask = process.umask(0o022);
    try {
      const configPath = join(tempDirectory, 'tevu.yaml');

      expect(await replaceAndReadMode(configPath, 'version: 1\n')).toBe(0o644);
    } finally {
      process.umask(originalUmask);
    }
  });
});

describe('canonicalConfigSerialization', () => {
  it('produces identical output for equivalent configurations with different key insertion order', () => {
    const ordered = expectSchemaAcceptance(buildConfig());
    const reordered = {
      tasks: ordered.tasks,
      models: ordered.models,
      repositories: ordered.repositories.map((repository) => ({
        path: repository.path,
        id: repository.id,
      })),
      agents: ordered.agents,
      run: ordered.run,
      version: ordered.version,
    };

    expect(canonicalConfigSerialization(reordered as unknown as TevuConfig)).toBe(
      canonicalConfigSerialization(ordered),
    );
    expect(JSON.parse(canonicalConfigSerialization(ordered))).toEqual(ordered);
  });

  it('serializes environment variable names without any environment values', () => {
    const config = expectSchemaAcceptance(
      buildConfig({ agents: buildAgents({ secrets: ['SYNTHETIC_OC_VAR'] }) }),
    );

    const serialized = canonicalConfigSerialization(config);
    const parsed = JSON.parse(serialized) as Pick<TevuConfig, 'agents'>;

    expect(serialized).toContain('"SYNTHETIC_OC_VAR"');
    expect(parsed.agents.opencode.secrets).toEqual(['SYNTHETIC_OC_VAR']);
    expect(parsed.agents.opencode.env).toEqual([]);
  });
});

describe('createTask', () => {
  it('appends the task text and performs exactly one configuration replacement', async () => {
    const dependencies = buildTaskDependencies();

    const input = buildTaskWizardInput();
    const task = expectOk(await createTask(input, dependencies));

    expect(task.id).toBe('new-task');
    expect(task.repo).toBe('sample-repo');
    expect(task.base_commit).toBe('resolved-abc123');
    const replaceText = vi.mocked(dependencies.configStore.replaceText);
    expect(replaceText).toHaveBeenCalledTimes(1);
    expect(replaceText.mock.calls[0]?.[0]).toBe(input.configPath);
    expect(replaceText.mock.calls[0]?.[1]).toContain('new-task');
  });

  it("registers every agent block's secrets and the Jira token as secret variable names", async () => {
    const config = buildConfig({
      agents: buildAgents({ secrets: ['OC_API_KEY'] }),
      trackers: {
        jira: { url: 'https://jira.example.com', email: '$JIRA_EMAIL', token: '$JIRA_TOKEN' },
      },
    });
    const rendered = renderConfigDocument(config, { redact: (text) => text });
    if (!rendered.ok) throw new Error('expected the fixture configuration to render');
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({
        readText: vi.fn(async () => ({ ok: true as const, value: rendered.value })),
      }),
    });

    await createTask(buildTaskWizardInput(), dependencies);

    expect(dependencies.registerSecrets).toHaveBeenCalledExactlyOnceWith([
      'OC_API_KEY',
      'JIRA_TOKEN',
    ]);
  });

  it('pins the task to a newly added repository when one is supplied', async () => {
    const dependencies = buildTaskDependencies();
    const newRepository = buildRepository({ id: 'extra-repo', path: '/repos/extra' });

    const task = expectOk(
      await createTask(
        buildTaskWizardInput({
          task: buildTaskDefinition({ id: 'new-task', repo: 'extra-repo' }),
          newRepository,
        }),
        dependencies,
      ),
    );

    expect(task.repo).toBe('extra-repo');
    const replaceText = vi.mocked(dependencies.configStore.replaceText);
    expect(replaceText.mock.calls[0]?.[1]).toContain('extra-repo');
  });

  it('rejects a repo that matches no configured or new repository', async () => {
    const input = buildTaskWizardInput({
      task: buildTaskDefinition({ id: 'new-task', repo: 'ghost' }),
    });
    const dependencies = buildTaskDependencies();

    const error = expectFailure(await createTask(input, dependencies), 'ConfigValidationError');

    expect(error.findings).toContainEqual({
      severity: 'error',
      identifier: 'tasks.new-task.repo',
      message: 'repo "ghost" does not reference a configured or newly added repository',
    });
    expect(dependencies.configStore.replaceText).not.toHaveBeenCalled();
  });

  it('returns CancellationError with no reads or writes when already cancelled', async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const dependencies = buildTaskDependencies({ cancellation: cancellation.signal });

    const error = expectFailure(
      await createTask(buildTaskWizardInput(), dependencies),
      'CancellationError',
    );

    expect(error.activeCaseIds).toEqual([]);
    expect(dependencies.configStore.exists).not.toHaveBeenCalled();
    expect(dependencies.configStore.replaceText).not.toHaveBeenCalled();
  });

  it('returns SourceMaterializationError with the task id when the commit cannot be resolved', async () => {
    const dependencies = buildTaskDependencies({
      git: buildGit({
        validateSource: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'SourceMaterializationError' as const,
            taskId: 'substituted',
            reason: 'commit not found',
          },
        })),
      }),
    });

    const error = expectFailure(
      await createTask(buildTaskWizardInput(), dependencies),
      'SourceMaterializationError',
    );

    expect(error.taskId).toBe('new-task');
    expect(error.reason).toBe('commit not found');
    expect(dependencies.configStore.replaceText).not.toHaveBeenCalled();
  });

  it('propagates a base configuration read failure without any write', async () => {
    const readFailure: TevuResult<string, 'ConfigReadError'> = {
      ok: false,
      error: {
        kind: 'ConfigReadError',
        path: '/tmp/tevu/tevu.yaml',
        requestedPath: 'tevu.yaml',
        cause: 'not-found',
      },
    };
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({ readText: vi.fn(async () => readFailure) }),
    });

    const error = expectFailure(
      await createTask(buildTaskWizardInput(), dependencies),
      'ConfigReadError',
    );

    expect(error).toEqual(readFailure.error);
    expect(dependencies.configStore.replaceText).not.toHaveBeenCalled();
  });

  it('rejects a candidate that violates the schema and writes nothing', async () => {
    const dependencies = buildTaskDependencies();

    const error = expectFailure(
      await createTask(
        buildTaskWizardInput({ task: buildTaskDefinition({ id: 'write-report' }) }),
        dependencies,
      ),
      'ConfigValidationError',
    );

    expect(error.findings).toContainEqual(
      expect.objectContaining({ message: 'duplicate tasks id "write-report"' }),
    );
    expect(dependencies.configStore.replaceText).not.toHaveBeenCalled();
  });

  it('bootstraps a new configuration when the file is missing and answers were captured', async () => {
    const bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> = {
      run: buildRunSettings(),
      agents: buildAgents(),
      repositories: [buildRepository()],
      models: [
        buildModel(),
        buildModel({ id: 'beta', model: 'anthropic/claude-4', effort: 'max' }),
      ],
    };
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({ exists: vi.fn(async () => false) }),
    });

    const task = expectOk(await createTask(buildTaskWizardInput({ bootstrap }), dependencies));

    expect(task.id).toBe('new-task');
    const replaceText = vi.mocked(dependencies.configStore.replaceText);
    expect(replaceText).toHaveBeenCalledTimes(1);
    expect(replaceText.mock.calls[0]?.[1]).toContain('new-task');
  });

  it('reports a missing configuration when no bootstrap answers were captured', async () => {
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({ exists: vi.fn(async () => false) }),
    });

    const error = expectFailure(
      await createTask(buildTaskWizardInput(), dependencies),
      'ConfigValidationError',
    );

    expect(error.findings).toContainEqual({
      severity: 'error',
      identifier: 'config',
      message: 'configuration file is missing and no bootstrap answers were captured',
    });
    expect(dependencies.configStore.replaceText).not.toHaveBeenCalled();
  });

  it('propagates a replacement failure as the final write attempt', async () => {
    const replaceFailure: TevuResult<void, 'ArtifactError'> = {
      ok: false,
      error: { kind: 'ArtifactError', operation: 'replace-configuration', reason: 'disk full' },
    };
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({ replaceText: vi.fn(async () => replaceFailure) }),
    });

    const error = expectFailure(
      await createTask(buildTaskWizardInput(), dependencies),
      'ArtifactError',
    );

    expect(error).toEqual(replaceFailure.error);
    expect(vi.mocked(dependencies.configStore.replaceText)).toHaveBeenCalledTimes(1);
  });
});

describe('validateConfig', () => {
  it('returns a valid report with the probed capability report when everything passes', async () => {
    const dependencies = buildValidationDependencies();

    const report = expectOk(
      await validateConfig(expectSchemaAcceptance(buildConfig()), dependencies),
    );

    expect(report.valid).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.capabilities).toEqual({ opencode: buildAgentCapabilityReport('opencode') });
  });

  it('retains every independent finding instead of stopping at the first failure', async () => {
    const config = expectSchemaAcceptance(
      buildConfig({
        tasks: [
          buildTaskDefinition({ id: 'broken-ref' }),
          buildTaskDefinition({
            id: 'write-report',
            checks: {
              acceptance: [buildManualCheck()],
              done: [buildCommandCheck({ env: ['EVAL_TOKEN'] })],
            },
          }),
        ],
      }),
    );
    const dependencies = buildValidationDependencies({
      git: buildFullGit({
        validateSource: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'SourceMaterializationError' as const,
            taskId: 'substitute',
            reason: 'commit missing',
          },
        })),
      }),
      prerequisites: buildPrerequisites({
        probeHost: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'PrerequisiteError' as const,
            tool: 'node',
            expected: '>=24 <25',
            actual: '18.0.0',
          },
        })),
        hasEnvironmentVariable: vi.fn(() => false),
        probeWritableDirectory: vi.fn(async () => ({
          ok: false as const,
          error: {
            kind: 'PrerequisiteError' as const,
            tool: 'artifacts-directory',
            expected: 'a writable directory',
            actual: '/tmp/tevu/artifacts',
          },
        })),
      }),
      agents: new Map([
        [
          'opencode',
          buildFakeAgentAdapter({
            probe: vi.fn(async () => ({
              ok: false as const,
              error: {
                kind: 'AgentProtocolError' as const,
                agent: 'opencode',
                context: { phase: 'probe' as const },
                reason: 'probe timed out',
              },
            })),
          }),
        ],
      ]),
    });

    // The schema cannot itself produce an unresolvable repo reference, so the
    // first task's repo is patched to "ghost" after acceptance to exercise
    // validateConfig's own defensive re-validation.
    const invalidConfig: TevuConfig = {
      ...config,
      tasks: [{ ...config.tasks[0]!, repo: 'ghost' }, config.tasks[1]!],
    };

    const outcome = await validateConfig(invalidConfig, dependencies);

    expect(outcome.ok).toBe(true);
    const report = expectOk(outcome);
    expect(report.valid).toBe(false);
    expect(report.findings.map((finding) => finding.identifier)).toEqual([
      'tasks.0.repo',
      'prerequisites.node',
      'environment.EVAL_TOKEN',
      'tasks.write-report.base_commit',
      'prerequisites.artifacts-directory',
      'agents.opencode.command',
    ]);
    expect(
      report.findings.find((finding) => finding.identifier === 'prerequisites.node')?.message,
    ).toBe('expected >=24 <25, actual 18.0.0');
    expect(report.capabilities).toEqual({});
  });

  it('reports a finding naming the agent when no adapter is registered for it, without probing', async () => {
    const dependencies = buildValidationDependencies({ agents: new Map() });

    const report = expectOk(
      await validateConfig(expectSchemaAcceptance(buildConfig()), dependencies),
    );

    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      severity: 'error',
      identifier: 'agents.opencode',
      message: 'no agent adapter is registered under this name',
    });
    expect(report.capabilities).toEqual({});
  });

  it('reports a prerequisite finding when the agent probe fails with a PrerequisiteError', async () => {
    const dependencies = buildValidationDependencies({
      agents: new Map([
        [
          'opencode',
          buildFakeAgentAdapter({
            probe: vi.fn(async () => ({
              ok: false as const,
              error: {
                kind: 'PrerequisiteError' as const,
                tool: 'opencode',
                expected: 'configured executable "opencode" starts',
                actual: 'ENOENT',
              },
            })),
          }),
        ],
      ]),
    });

    const report = expectOk(
      await validateConfig(expectSchemaAcceptance(buildConfig()), dependencies),
    );

    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      severity: 'error',
      identifier: 'prerequisites.opencode',
      message: 'expected configured executable "opencode" starts, actual ENOENT',
    });
    expect(report.capabilities).toEqual({});
  });

  it('surfaces schema findings when revalidating an invalid configuration', async () => {
    const config = {
      ...expectSchemaAcceptance(buildConfig()),
      models: [expectSchemaAcceptance(buildConfig()).models[0]!],
    };

    const report = expectOk(await validateConfig(config, buildValidationDependencies()));

    expect(report.findings.map((finding) => finding.identifier)).toContain('models');
    expect(report.valid).toBe(false);
  });

  it('checks every agent and check variable by name and skips the snapshot when one is missing', async () => {
    const config = expectSchemaAcceptance(
      buildConfig({
        agents: buildAgents({ env: ['OC_VAR'] }),
        trackers: {
          jira: { url: 'https://jira.example.com', email: '$JIRA_EMAIL', token: '$JIRA_TOKEN' },
        },
      }),
    );
    const dependencies = buildValidationDependencies({
      prerequisites: buildPrerequisites({
        hasEnvironmentVariable: vi.fn((name: string) => name !== 'OC_VAR'),
      }),
    });

    const report = expectOk(await validateConfig(config, dependencies));

    expect(report.findings.map((finding) => finding.identifier)).toEqual(['environment.OC_VAR']);
    expect(dependencies.environments.snapshotParent).not.toHaveBeenCalled();
  });

  it('reports a failed parent environment snapshot when all variables are set', async () => {
    const dependencies = buildValidationDependencies({
      environments: buildEnvironments({
        snapshotParent: vi.fn(() => ({
          ok: false as const,
          error: {
            kind: 'PrerequisiteError' as const,
            tool: 'path',
            expected: 'a non-empty PATH',
            actual: 'empty',
          },
        })),
      }),
    });

    const report = expectOk(
      await validateConfig(expectSchemaAcceptance(buildConfig()), dependencies),
    );

    expect(report.findings).toContainEqual({
      severity: 'error',
      identifier: 'prerequisites.path',
      message: 'expected a non-empty PATH, actual empty',
    });
    expect(report.valid).toBe(false);
  });

  it('validates each distinct repository-and-commit pair once', async () => {
    const first = buildTaskDefinition({ id: 'task-one' });
    const second = buildTaskDefinition({ id: 'task-two' });
    const third = buildTaskDefinition({
      id: 'task-three',
      base_commit: 'ffffff0123456789abcdef0123456789abcdef01',
    });
    const dependencies = buildValidationDependencies();

    const config = expectSchemaAcceptance(buildConfig({ tasks: [first, second, third] }));
    const report = expectOk(await validateConfig(config, dependencies));

    expect(report.valid).toBe(true);
    expect(vi.mocked(dependencies.git.validateSource)).toHaveBeenCalledTimes(2);
    expect(
      vi
        .mocked(dependencies.git.validateSource)
        .mock.calls.map(([repository, commit]) => [repository.id, commit]),
    ).toEqual([
      ['sample-repo', first.base_commit],
      ['sample-repo', third.base_commit],
    ]);
  });

  it('rejects a task whose prompt names its resolved base commit, including one resolved from the cache', async () => {
    const resolvedCommit = 'abcdef0123456789abcdef0123456789abcdef01';
    const first = buildTaskDefinition({
      id: 'task-one',
      base_commit: 'main',
      prompt: 'unrelated fedcba9876543210fedcba9876543210fedcba98 and deadbeef',
    });
    const second = buildTaskDefinition({
      id: 'task-two',
      base_commit: 'main',
      prompt: 'the agent should pin the commit ABCDEF0 for this task',
    });
    const dependencies = buildValidationDependencies({
      git: buildFullGit({
        validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
          ok: true as const,
          value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit },
        })),
      }),
    });

    const config = expectSchemaAcceptance(buildConfig({ tasks: [first, second] }));
    const report = expectOk(await validateConfig(config, dependencies));

    expect(report.valid).toBe(false);
    expect(report.findings).toEqual([
      {
        severity: 'error',
        identifier: `tasks.${second.id}`,
        message: 'agent prompt contains resolved base commit abcdef0',
      },
    ]);
  });

  it('rejects a task whose prompt names its resolved base commit on the first, uncached lookup', async () => {
    const resolvedCommit = 'abcdef0123456789abcdef0123456789abcdef01';
    const first = buildTaskDefinition({
      id: 'task-one',
      base_commit: 'main',
      prompt: 'the agent should pin the commit ABCDEF0 for this task',
    });
    const second = buildTaskDefinition({
      id: 'task-two',
      base_commit: 'main',
      prompt: 'unrelated fedcba9876543210fedcba9876543210fedcba98 and deadbeef',
    });
    const dependencies = buildValidationDependencies({
      git: buildFullGit({
        validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
          ok: true as const,
          value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit },
        })),
      }),
    });

    const config = expectSchemaAcceptance(buildConfig({ tasks: [first, second] }));
    const report = expectOk(await validateConfig(config, dependencies));

    expect(report.valid).toBe(false);
    expect(report.findings).toEqual([
      {
        severity: 'error',
        identifier: `tasks.${first.id}`,
        message: 'agent prompt contains resolved base commit abcdef0',
      },
    ]);
  });
});

describe('check-state configuration rules (P13, AC-3)', () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), 'tevu-config-check-state-'));
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function writeConfigFile(content: string): Promise<string> {
    const filePath = join(tempDirectory, 'tevu.yaml');
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }

  it('rejects an empty restore pattern from loadConfig (R1)', async () => {
    const configPath = await writeConfigFile(
      configYaml({
        outputDirectory: './runs',
        repositoryPath: './repo',
        command: 'opencode',
        checksExtra: '      restore: [""]\n',
      }),
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toContainEqual({
      severity: 'error',
      identifier: 'tasks.0.checks.restore.0',
      message: 'restore pattern must not be empty',
    });
  });

  it('rejects a restore pattern with a leading / or a .. segment from loadConfig (R2)', async () => {
    const configPath = await writeConfigFile(
      configYaml({
        outputDirectory: './runs',
        repositoryPath: './repo',
        command: 'opencode',
        checksExtra: '      restore: ["/etc/passwd"]\n',
      }),
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toContainEqual({
      severity: 'error',
      identifier: 'tasks.0.checks.restore.0',
      message:
        'restore pattern must be relative to the repository root, without a leading / or a .. segment',
    });
  });

  it("rejects an empty overlay string with Zod's own minimum-length message from loadConfig (O1)", async () => {
    const configPath = await writeConfigFile(
      configYaml({
        outputDirectory: './runs',
        repositoryPath: './repo',
        command: 'opencode',
        checksExtra: '      overlay: ""\n',
      }),
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toContainEqual({
      severity: 'error',
      identifier: 'tasks.0.checks.overlay',
      message: 'Too small: expected string to have >=1 characters',
    });
  });

  it('rejects an overlay directory inside a configured repository after real-path resolution from loadConfig (V2)', async () => {
    await fs.mkdir(join(tempDirectory, 'repo', 'hidden-checks'), { recursive: true });
    const configPath = await writeConfigFile(
      configYaml({
        outputDirectory: './runs',
        repositoryPath: './repo',
        command: 'opencode',
        checksExtra: '      overlay: ./repo/hidden-checks\n',
      }),
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toEqual([
      {
        severity: 'error',
        identifier: 'tasks.write-report.checks.overlay',
        message: 'overlay must be outside repository "sample-repo" after real-path resolution',
      },
    ]);
  });

  it('rejects an overlay directory that overlaps run.output_dir after real-path resolution from loadConfig (V5)', async () => {
    await fs.mkdir(join(tempDirectory, 'repo'), { recursive: true });
    await fs.mkdir(join(tempDirectory, 'runs', 'hidden-checks'), { recursive: true });
    const configPath = await writeConfigFile(
      configYaml({
        outputDirectory: './runs',
        repositoryPath: './repo',
        command: 'opencode',
        checksExtra: '      overlay: ./runs/hidden-checks\n',
      }),
    );

    const error = expectFailure(await loadConfig(configPath), 'ConfigValidationError');

    expect(error.findings).toEqual([
      {
        severity: 'error',
        identifier: 'tasks.write-report.checks.overlay',
        message: 'overlay must not overlap run.output_dir after real-path resolution',
      },
    ]);
  });

  it('rejects a missing overlay directory through validateConfig with the real Git adapter (V1)', async () => {
    const overlayDirectory = join(tempDirectory, 'missing-overlay');
    const config = expectSchemaAcceptance(
      buildConfig({
        tasks: [
          buildTaskDefinition({
            checks: { ...buildTaskDefinition().checks, overlay: overlayDirectory },
          }),
        ],
      }),
    );
    const git = createGitWorkspaceAdapter({
      config,
      workspacesDirectory: join(tempDirectory, 'workspaces'),
    });
    const dependencies = buildValidationDependencies({ git });

    const report = expectOk(await validateConfig(config, dependencies));

    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      severity: 'error',
      identifier: 'tasks.write-report.checks.overlay',
      message: `overlay directory "${overlayDirectory}" does not exist`,
    });
  });

  it('rejects an overlay directory holding a symbolic link through validateConfig with the real Git adapter (V3)', async () => {
    const overlayDirectory = join(tempDirectory, 'overlay-with-link');
    await fs.mkdir(overlayDirectory, { recursive: true });
    await fs.symlink(tempDirectory, join(overlayDirectory, 'escape-link'));
    const config = expectSchemaAcceptance(
      buildConfig({
        tasks: [
          buildTaskDefinition({
            checks: { ...buildTaskDefinition().checks, overlay: overlayDirectory },
          }),
        ],
      }),
    );
    const git = createGitWorkspaceAdapter({
      config,
      workspacesDirectory: join(tempDirectory, 'workspaces'),
    });
    const dependencies = buildValidationDependencies({ git });

    const report = expectOk(await validateConfig(config, dependencies));

    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      severity: 'error',
      identifier: 'tasks.write-report.checks.overlay',
      message: `overlay directory "${overlayDirectory}" must contain only regular files and directories; "escape-link" is a symbolic link`,
    });
  });

  it('rejects an overlay directory containing an entry named .git through validateConfig (V4)', async () => {
    const overlayDirectory = join(tempDirectory, 'overlay-with-git');
    await fs.mkdir(join(overlayDirectory, '.git'), { recursive: true });
    const config = expectSchemaAcceptance(
      buildConfig({
        tasks: [
          buildTaskDefinition({
            checks: { ...buildTaskDefinition().checks, overlay: overlayDirectory },
          }),
        ],
      }),
    );
    const git = createGitWorkspaceAdapter({
      config,
      workspacesDirectory: join(tempDirectory, 'workspaces'),
    });
    const dependencies = buildValidationDependencies({ git });

    const report = expectOk(await validateConfig(config, dependencies));

    expect(report.valid).toBe(false);
    expect(report.findings).toContainEqual({
      severity: 'error',
      identifier: 'tasks.write-report.checks.overlay',
      message: `overlay directory "${overlayDirectory}" must not contain an entry named .git; found ".git"`,
    });
  });
});
