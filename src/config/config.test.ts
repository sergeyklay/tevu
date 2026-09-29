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
import { GH_CREDENTIAL_ENVIRONMENT_VARIABLES } from '@/domain/github-cli';

import { renderConfigDocument } from './document';
import {
  canonicalConfigSerialization,
  checkRepositoryPlacement,
  loadConfig,
  parseConfigText,
  resolveBootstrapModelCallConfig,
  resolveRepositoryPath,
} from './load';
import {
  AGENT_NAMES,
  agentNamesInUse,
  agentSettingsSchema,
  repositoryInputOf,
  TevuConfigSchema,
} from './schema';
import { CONFIG_TEMPLATE } from './template';

import type {
  AgentName,
  CheckInput,
  ModelDefinitionInput,
  ModelRoleInput,
  TaskInput,
  TevuConfigInput,
} from './schema';
import type { TaskDependencies, TaskWizardInput } from '@/application/create-task';
import type {
  AgentAdapter,
  AgentCapabilityReport,
  CaseExecutableAdapter,
  CaseExecutableProbeRequest,
  ConfigStore,
  EnvironmentAdapter,
  GitWorkspaceAdapter,
  PrerequisiteAdapter,
  RepositoryDefinition,
  TaskDefinition,
  TevuConfig,
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

function buildModelRole(overrides: Partial<ModelRoleInput> = {}): ModelRoleInput {
  return { model: 'openai/grader-model', effort: 'high', ...overrides };
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
  overrides: Partial<Pick<GitWorkspaceAdapter, 'validateSource' | 'resolveCommit'>> = {},
): Pick<GitWorkspaceAdapter, 'validateSource' | 'resolveCommit'> {
  return {
    validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
      ok: true as const,
      value: {
        repositoryId: repository.id,
        requestedCommit: commit,
        resolvedCommit: `resolved-${commit}`,
      },
    })),
    resolveCommit: vi.fn(async () => ({ kind: 'not-found' as const })),
    ...overrides,
  };
}

function buildFullGit(overrides: Partial<GitWorkspaceAdapter> = {}): GitWorkspaceAdapter {
  return {
    ...buildGit(),
    resolveCommit: vi.fn(async () => ({ kind: 'not-found' as const })),
    isAncestor: vi.fn(async () => null),
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
    initializeEmptyRepository: vi.fn(async () => ({ ok: true as const, value: undefined })),
    diffCommit: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'ArtifactError' as const,
        operation: 'diff-reference-commit',
        reason: 'not used in these tests',
      },
    })),
    ...overrides,
  };
}

function buildTaskDependencies(overrides: Partial<TaskDependencies> = {}): TaskDependencies {
  return {
    configStore: buildConfigStore(),
    git: buildGit(),
    registerSecrets: vi.fn(),
    redact: (text: string) => text,
    managedCloneRoot: undefined,
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
    readProviders: vi.fn(async () => ({
      ok: true as const,
      value: { agent: 'opencode', configurationFiles: [], findings: [] },
    })),
    inspectOperatorProvider: vi.fn(async () => ({
      ok: true as const,
      value: { defined: false as const },
    })),
    // Every `model` string this file's fixtures declare, so the model-resolution
    // stage reports nothing new for a test that does not override this stub.
    listModels: vi.fn(async () => ({
      outcome: 'listed' as const,
      models: [
        'anthropic/claude-4',
        'anthropic/criteria-model',
        'openai/criteria-model',
        'openai/gpt-5',
        'openai/grader-model',
        'openai/your-criteria-model',
        'openai/your-grader-model',
        'other/model',
      ],
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
    callModel: vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'CancellationError' as const, activeCaseIds: [] },
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
    unsetVariables: vi.fn(() => []),
    createCaseEnvironments: vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'IsolationError' as const,
        caseId: 'unused',
        reason: 'not used in these tests',
      },
    })),
    createModelCallEnvironment: vi.fn(async () => ({
      ok: true as const,
      value: {
        rootDirectory: '/synthetic/model-call',
        workingDirectory: '/synthetic/model-call/work',
        homeDirectory: '/synthetic/model-call/home',
        variables: {},
        dispose: vi.fn(async () => ({ ok: true as const, value: undefined })),
      },
    })),
    ...overrides,
  };
}

function buildFakeCaseExecutablesAdapter(
  overrides: Partial<CaseExecutableAdapter> = {},
): CaseExecutableAdapter {
  return {
    probe: vi.fn(async () => ({
      ok: true as const,
      value: { verdict: { verdict: 'runs' as const } },
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
    clones: { inspectClone: vi.fn(async () => 'repository' as const) },
    caseExecutables: buildFakeCaseExecutablesAdapter(),
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

/** A single-repository configuration whose repository is a `github` entry, and an optional second repository. */
function githubRepositoryConfigYaml(options: {
  outputDirectory: string;
  github: string;
  command: string;
  /** Extra repository entries, indented to two spaces, appended after the GitHub entry. */
  extraRepositories?: string;
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
    github: ${options.github}
${options.extraRepositories ?? ''}models:
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
`;
}

describe('agentSettingsSchema', () => {
  it('accepts a minimal agent block and defaults secrets and env to empty arrays', () => {
    const parsed = agentSettingsSchema('opencode').safeParse({ command: 'opencode' });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data).toEqual({ command: 'opencode', secrets: [], env: [], providers: [] });
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

  it('defaults agents.opencode.providers to an empty array when absent', () => {
    const config = expectSchemaAcceptance(buildConfig());

    expect(config.agents.opencode.providers).toEqual([]);
  });

  it.each(['', 'acme/proxy'])('rejects the provider id %j', (id) => {
    const config = buildConfig({ agents: buildAgents({ providers: [{ id }] }) });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'agents.opencode.providers.0.id',
      message: 'provider id must be non-empty and contain no "/"',
    });
  });

  it('rejects a duplicate provider id', () => {
    const config = buildConfig({
      agents: buildAgents({ providers: [{ id: 'acme' }, { id: 'acme' }] }),
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'agents.opencode.providers.1.id',
      message: 'duplicate provider id "acme"',
    });
  });

  it("rejects a provider api_key not listed in the block's secrets", () => {
    const config = buildConfig({
      agents: buildAgents({ providers: [{ id: 'acme', api_key: 'ACME_KEY' }] }),
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'agents.opencode.providers.0.api_key',
      message: 'api_key "ACME_KEY" must be listed in agents.opencode.secrets',
    });
  });

  it("accepts a provider api_key listed in the block's secrets", () => {
    const config = expectSchemaAcceptance(
      buildConfig({
        agents: buildAgents({
          secrets: ['ACME_KEY'],
          providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
        }),
      }),
    );

    expect(config.agents.opencode.providers).toEqual([{ id: 'acme', api_key: 'ACME_KEY' }]);
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

  it('accepts a task timeout and materializes it verbatim', () => {
    const config = buildConfig({ tasks: [buildTaskDefinition({ timeout: '20m' })] });

    const accepted = expectSchemaAcceptance(config);

    expect(accepted.tasks[0]?.timeout).toBe('20m');
  });

  it('materializes a task with no timeout property when the file declares none', () => {
    const config = buildConfig({ tasks: [buildTaskDefinition()] });

    const accepted = expectSchemaAcceptance(config);

    expect('timeout' in (accepted.tasks[0] ?? {})).toBe(false);
  });

  it.each([
    { value: 20, message: 'Invalid input: expected string, received number' },
    {
      value: '20',
      message: 'must be a positive whole number followed by ms, s, m, or h, for example 30s or 10m',
    },
    {
      value: 'abc',
      message: 'must be a positive whole number followed by ms, s, m, or h, for example 30s or 10m',
    },
  ])('rejects a task timeout of $value at tasks.0.timeout', ({ value, message }) => {
    const config = buildConfig({
      tasks: [{ ...buildTaskDefinition(), timeout: value } as unknown as TaskInput],
    });

    expect(expectSchemaRejection(config)).toContainEqual({ path: 'tasks.0.timeout', message });
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

  it('accepts a task with a commit reference and materializes it', () => {
    const reference: TaskInput['reference'] = {
      kind: 'commit',
      identifier: 'HEAD~3',
      commits: ['0123456789abcdef0123456789abcdef01234567'],
    };
    const config = buildConfig({ tasks: [buildTaskDefinition({ reference })] });

    expect(expectSchemaAcceptance(config).tasks[0]?.reference).toEqual(reference);
  });

  it('materializes a task with no reference property when the file declares none', () => {
    const config = buildConfig({ tasks: [buildTaskDefinition()] });

    const accepted = expectSchemaAcceptance(config);

    expect('reference' in (accepted.tasks[0] ?? {})).toBe(false);
  });

  it('rejects an unknown field inside a commit reference', () => {
    const config = {
      ...buildConfig(),
      tasks: [
        {
          ...buildTaskDefinition(),
          reference: {
            kind: 'commit',
            identifier: 'HEAD~3',
            commits: ['0123456789abcdef0123456789abcdef01234567'],
            extra: 'field',
          },
        },
      ],
    };

    expect(TevuConfigSchema.safeParse(config).success).toBe(false);
  });

  it('rejects a malformed reference commit hash', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          reference: { kind: 'commit', identifier: 'HEAD~3', commits: ['not-a-hash'] },
        }),
      ],
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'tasks.0.reference.commits.0',
      message: 'must be a full commit hash: 40 or 64 lowercase hexadecimal characters',
    });
  });

  describe('pull-request reference', () => {
    const COMMIT_A = '0123456789abcdef0123456789abcdef01234567';
    const COMMIT_B = 'fedcba9876543210fedcba9876543210fedcba98';
    const MERGE_COMMIT = '1111111111111111111111111111111111111111';

    it('accepts a pull-request reference and materializes it', () => {
      const reference: TaskInput['reference'] = {
        kind: 'pull-request',
        identifier: 'octo/app#128',
        commits: [COMMIT_A, COMMIT_B],
        merge_commit: MERGE_COMMIT,
      };
      const config = buildConfig({ tasks: [buildTaskDefinition({ reference })] });

      expect(expectSchemaAcceptance(config).tasks[0]?.reference).toEqual(reference);
    });

    it('accepts a pull-request reference given as a URL', () => {
      const reference: TaskInput['reference'] = {
        kind: 'pull-request',
        identifier: 'https://github.com/octo/app/pull/128',
        commits: [COMMIT_A],
      };
      const config = buildConfig({ tasks: [buildTaskDefinition({ reference })] });

      expect(expectSchemaAcceptance(config).tasks[0]?.reference).toEqual(reference);
    });

    it('rejects a duplicate reference commit', () => {
      const config = buildConfig({
        tasks: [
          buildTaskDefinition({
            reference: {
              kind: 'pull-request',
              identifier: 'octo/app#128',
              commits: [COMMIT_A, COMMIT_A],
            },
          }),
        ],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'tasks.0.reference.commits.1',
        message: `duplicate reference commit "${COMMIT_A}"`,
      });
    });

    it('rejects a merge commit that repeats a listed commit', () => {
      const config = buildConfig({
        tasks: [
          buildTaskDefinition({
            reference: {
              kind: 'pull-request',
              identifier: 'octo/app#128',
              commits: [COMMIT_A],
              merge_commit: COMMIT_A,
            },
          }),
        ],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'tasks.0.reference.merge_commit',
        message: 'merge commit repeats a pull request commit',
      });
    });

    it.each([
      { description: 'user info', identifier: 'https://user:pass@github.com/octo/app/pull/128' },
      { description: 'a port', identifier: 'https://github.com:8443/octo/app/pull/128' },
      { description: 'path issues', identifier: 'https://github.com/octo/app/issues/128' },
    ])('rejects an identifier with $description', ({ identifier }) => {
      const config = buildConfig({
        tasks: [
          buildTaskDefinition({
            reference: { kind: 'pull-request', identifier, commits: [COMMIT_A] },
          }),
        ],
      });

      expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(
        'tasks.0.reference.identifier',
      );
    });
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

  describe('roles', () => {
    it('parses CONFIG_TEMPLATE with roles.criteria and roles.grader declared', () => {
      const parsed = expectOk(parseConfigText(CONFIG_TEMPLATE));

      expect(parsed.roles).toEqual({
        criteria: { model: 'openai/your-criteria-model', effort: 'high', agent: 'opencode' },
        grader: { model: 'openai/your-grader-model', effort: 'medium', agent: 'opencode' },
      });
    });

    it('materializes roles as absent when the file declares none', () => {
      const accepted = expectSchemaAcceptance(buildConfig());

      expect(accepted.roles).toBeUndefined();
    });

    it('accepts roles: {} and materializes it as {}', () => {
      const accepted = expectSchemaAcceptance(buildConfig({ roles: {} }));

      expect(accepted.roles).toEqual({});
    });

    it('reports an unknown field inside roles.grader as an unknown configuration field', () => {
      const text =
        configYaml({ outputDirectory: './runs', repositoryPath: './repo', command: 'opencode' }) +
        'roles:\n  grader:\n    model: openai/grader-model\n    effort: high\n    extra: nope\n';

      const parsed = expectFailure(parseConfigText(text), 'ConfigValidationError');

      expect(parsed.findings).toContainEqual({
        severity: 'error',
        identifier: 'roles.grader',
        message: 'Unknown configuration field',
      });
    });

    it('rejects a role agent that does not name a configured agent', () => {
      const config = buildConfig({ roles: { grader: buildModelRole({ agent: 'claude' }) } });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'roles.grader.agent',
        message: 'agent must name a configured agent: opencode',
      });
    });

    it('re-parses a materialized configuration with both model roles to a deeply equal value', () => {
      const config = buildConfig({
        roles: {
          criteria: buildModelRole({ model: 'anthropic/criteria-model', effort: 'medium' }),
          grader: buildModelRole(),
        },
      });

      const parsedOnce = expectSchemaAcceptance(config);
      const parsedTwice = expectSchemaAcceptance(parsedOnce);

      expect(parsedTwice).toEqual(parsedOnce);
    });

    it("defaults a model role's agent to the sole configured agent", () => {
      const config = buildConfig({ roles: { grader: buildModelRole() } });

      expect(expectSchemaAcceptance(config).roles?.grader?.agent).toBe('opencode');
    });

    it('accepts a model role with the same model and effort as a model entry', () => {
      const config = buildConfig({
        roles: { grader: buildModelRole({ model: 'openai/gpt-5', effort: 'high' }) },
      });

      expect(TevuConfigSchema.safeParse(config).success).toBe(true);
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

  it('parses a check with neither run nor manual as a graded check', () => {
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

    const parsed = expectSchemaAcceptance(config);
    expect(parsed.tasks[0]?.checks.acceptance[0]).toEqual({
      id: 'no-form',
      description: 'x',
      required: true,
    });
  });

  it('rejects a graded check whose description holds no non-whitespace text', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [{ id: 'no-description', description: '   ' }],
            done: [buildCommandCheck()],
          },
        }),
      ],
    });

    expect(expectSchemaRejection(config)).toContainEqual({
      path: 'tasks.0.checks.acceptance.0.description',
      message:
        'a graded check needs a description with non-whitespace text; the grader grades against it',
    });
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
      'manual must be true; omit it for a command check or a graded check',
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

  it.each(['PATH', 'XDG_CACHE_HOME'])(
    'rejects the fixed environment name %s in a command check env',
    (name) => {
      const config = buildConfig({
        tasks: [
          buildTaskDefinition({
            checks: {
              acceptance: [buildManualCheck()],
              done: [buildCommandCheck({ env: [name] })],
            },
          }),
        ],
      });

      expect(expectSchemaRejection(config)).toEqual([
        {
          path: 'tasks.0.checks.done.0.env.0',
          message:
            'PATH, HOME, TMPDIR, LANG, LC_ALL, CI, and XDG_* names are fixed by the isolation contract and cannot be configured',
        },
      ]);
    },
  );

  it('accepts an ordinary environment variable name in a command check env', () => {
    const config = buildConfig({
      tasks: [
        buildTaskDefinition({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ env: ['NODE_OPTIONS'] })],
          },
        }),
      ],
    });

    expect(expectSchemaAcceptance(config).tasks[0]?.checks.done[0]).toEqual({
      id: 'tests-pass',
      description: 'The tests pass',
      run: ['npm', 'test'],
      timeout: '1m',
      exit_codes: [0],
      env: ['NODE_OPTIONS'],
      required: true,
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

  describe('command check run', () => {
    const RUN_MESSAGE =
      'run must be a non-blank command string or an array starting with a non-empty executable';

    function buildConfigWithDoneCheck(check: CheckInput): TevuConfigInput {
      return buildConfig({
        tasks: [
          buildTaskDefinition({ checks: { acceptance: [buildManualCheck()], done: [check] } }),
        ],
      });
    }

    it.each([
      { form: 'a command string', run: 'npm test' },
      { form: 'an executable and arguments', run: ['npm', 'test'] as [string, ...string[]] },
    ])('accepts $form', ({ run }) => {
      const config = buildConfigWithDoneCheck(buildCommandCheck({ run }));

      const accepted = expectSchemaAcceptance(config);

      expect(accepted.tasks[0]?.checks.done[0]).toMatchObject({ run });
    });

    it('keeps a command string exactly as written', () => {
      const run = '  CI=1 npm test -- --run | tee "out log" && echo "a: #b"  ';
      const config = buildConfigWithDoneCheck(buildCommandCheck({ run }));

      const accepted = expectSchemaAcceptance(config);

      expect(accepted.tasks[0]?.checks.done[0]).toMatchObject({ run });
    });

    it.each([
      { description: 'a blank string', run: '  ' },
      { description: 'an empty array', run: [] },
      { description: 'an array with an empty executable', run: [''] },
      { description: 'a number', run: 42 },
    ])('rejects $description with one finding at run', ({ run }) => {
      const config = buildConfigWithDoneCheck(
        buildCommandCheck({ run: run as unknown as [string, ...string[]] }),
      );

      expect(expectSchemaRejection(config)).toEqual([
        { path: 'tasks.0.checks.done.0.run', message: RUN_MESSAGE },
      ]);
    });

    it('still rejects an unknown check field', () => {
      const config = buildConfigWithDoneCheck({
        ...buildCommandCheck({ run: 'npm test' }),
        bogus: true,
      } as CheckInput);

      expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(
        'tasks.0.checks.done.0',
      );
    });

    it('still rejects a command string in a repository setup command', () => {
      const config = buildConfig({
        repositories: [
          buildRepository({
            setup: {
              before_agent: ['npm ci' as unknown as [string, ...string[]]],
              timeout: '1m',
              env: [],
            },
          }),
        ],
      });

      expect(expectSchemaRejection(config).map((issue) => issue.path)).toContain(
        'repositories.0.setup.before_agent.0',
      );
    });
  });

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

  describe('github repository entry (AC-1, AC-15, V1)', () => {
    it('rejects a repository entry declaring neither path nor github', () => {
      const config = buildConfig({
        repositories: [{ id: 'sample-repo' } as unknown as RepositoryDefinition],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'repositories.0',
        message: 'a repository declares path (a local repository) or github (a GitHub repository)',
      });
    });

    it('rejects a repository entry declaring both path and github', () => {
      const config = buildConfig({
        repositories: [
          {
            id: 'sample-repo',
            path: '../app',
            github: 'octo/app',
          } as unknown as RepositoryDefinition,
        ],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'repositories.0',
        message: 'a repository declares either path or github, not both',
      });
    });

    const GITHUB_GRAMMAR_MESSAGE =
      'github must be OWNER/REPO or https://HOST/OWNER/REPO, with a HOST of letters, digits, hyphens, and dots, and without surrounding spaces, user info, a port, a query, or a fragment';

    it.each([
      { description: 'no slash', github: 'octo-app' },
      { description: 'leading whitespace', github: '  octo/app' },
      { description: 'a URL with user info', github: 'https://user:pass@github.com/octo/app' },
      { description: 'a URL with a port', github: 'https://github.com:8443/octo/app' },
      {
        description: 'an IPv6-literal host, which fails the plain-host rule',
        github: 'https://[::1]/octo/app',
      },
    ])('rejects github with $description', ({ github }) => {
      const config = buildConfig({
        repositories: [{ id: 'sample-repo', github } as unknown as RepositoryDefinition],
      });

      expect(expectSchemaRejection(config)).toContainEqual({
        path: 'repositories.0.github',
        message: GITHUB_GRAMMAR_MESSAGE,
      });
    });

    it('accepts the short form and materializes an absolute-clone-location path, lowercased', () => {
      const config = buildConfig({
        repositories: [{ id: 'upstream', github: 'Octo/App' } as unknown as RepositoryDefinition],
        tasks: [buildTaskDefinition({ repo: 'upstream' })],
      });

      const accepted = expectSchemaAcceptance(config);

      expect(accepted.repositories[0]).toEqual({
        id: 'upstream',
        github: 'Octo/App',
        path: 'github.com/octo/app.git',
      });
    });

    it('accepts a GitHub Enterprise Server URL naming its own host', () => {
      const config = buildConfig({
        repositories: [
          {
            id: 'upstream',
            github: 'https://ghe.example.com/platform/api',
          } as unknown as RepositoryDefinition,
        ],
        tasks: [buildTaskDefinition({ repo: 'upstream' })],
      });

      const accepted = expectSchemaAcceptance(config);

      expect(accepted.repositories[0]?.path).toBe('ghe.example.com/platform/api.git');
    });

    it('keeps setup on a GitHub entry', () => {
      const config = buildConfig({
        repositories: [
          {
            id: 'upstream',
            github: 'octo/app',
            setup: { before_agent: [['npm', 'ci']], timeout: '1m', env: [] },
          } as unknown as RepositoryDefinition,
        ],
        tasks: [buildTaskDefinition({ repo: 'upstream' })],
      });

      const accepted = expectSchemaAcceptance(config);

      expect(accepted.repositories[0]?.setup).toEqual({
        before_agent: [['npm', 'ci']],
        timeout: '1m',
        env: [],
      });
    });

    it('re-parses a materialized GitHub entry through repositoryInputOf to a deeply equal value', () => {
      const config = buildConfig({
        repositories: [{ id: 'upstream', github: 'octo/app' } as unknown as RepositoryDefinition],
        tasks: [buildTaskDefinition({ repo: 'upstream' })],
      });
      const parsedOnce = expectSchemaAcceptance(config);

      const reparsedInput = {
        ...parsedOnce,
        repositories: parsedOnce.repositories.map(repositoryInputOf),
      };
      const parsedTwice = expectSchemaAcceptance(reparsedInput);

      expect(parsedTwice).toEqual(parsedOnce);
    });
  });
});

describe('loadConfig', () => {
  let tempDirectory: string;
  const configStore = createConfigStore({ redact: (text) => text });

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

    const config = expectOk(await loadConfig(configPath, configStore, undefined));

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

    const config = expectOk(await loadConfig(configPath, configStore, undefined));

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

    const error = expectFailure(
      await loadConfig(requestedPath, configStore, undefined),
      'ConfigReadError',
    );

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

    const error = expectFailure(
      await loadConfig(requestedPath, configStore, undefined),
      'ConfigReadError',
    );

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
      const error = expectFailure(
        await loadConfig(requestedPath, configStore, undefined),
        'ConfigReadError',
      );

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
        const error = expectFailure(
          await loadConfig(requestedPath, configStore, undefined),
          'ConfigReadError',
        );

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

    const error = expectFailure(
      await loadConfig(requestedPath, configStore, undefined),
      'ConfigReadError',
    );

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

    const error = expectFailure(
      await loadConfig(requestedPath, configStore, undefined),
      'ConfigReadError',
    );

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

    const error = expectFailure(
      await loadConfig(requestedPath, configStore, undefined),
      'ConfigReadError',
    );

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

    const error = expectFailure(
      await loadConfig(requestedPath, configStore, undefined),
      'ConfigReadError',
    );

    expect(error).toEqual({
      kind: 'ConfigReadError',
      path: resolve(requestedPath),
      requestedPath,
      cause: 'unreadable',
    });
  });

  it('reports a ConfigParseError with a line identifier for malformed YAML', async () => {
    const configPath = await writeConfigFile('version: 1\nbroken: [1, 2');

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigParseError',
    );

    expect(error.findings.length).toBeGreaterThan(0);
    expect(error.findings[0]?.severity).toBe('error');
    expect(error.findings[0]?.identifier).toBe('line 2');
    expect(error.findings[0]?.message).toMatch(/^Invalid YAML \(/);
  });

  it('reports ConfigParseError when YAML aliases cannot be resolved', async () => {
    const configPath = await writeConfigFile('m:\n  <<: *missing\n');

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigParseError',
    );

    expect(error.findings).toEqual([
      { severity: 'error', identifier: 'config', message: 'Cannot resolve YAML aliases' },
    ]);
  });

  it('reports field identifiers for schema violations', async () => {
    const configPath = await writeConfigFile('version: 2\n');

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

    const identifiers = error.findings.map((finding) => finding.identifier);
    expect(identifiers).toContain('version');
    expect(identifiers).toContain('models');
    expect(identifiers).toContain('tasks');
  });

  it('reports unknown top-level fields as unknown configuration fields', async () => {
    const configPath = await writeConfigFile(
      `${configYaml({ outputDirectory: './runs', repositoryPath: './repo', command: 'opencode' })}\nunknownSection: {}\n`,
    );

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

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

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

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

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

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

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

    expect(error.findings).toEqual([
      {
        severity: 'error',
        identifier: 'run.output_dir',
        message:
          'run.output_dir must be outside repository "sample-repo" after real-path resolution',
      },
    ]);
  });

  describe('GitHub repository entry findings (AC-15, section 3.3.5)', () => {
    it('reports the missing-managed-clone-root finding when a GitHub entry has no root', async () => {
      const configPath = await writeConfigFile(
        githubRepositoryConfigYaml({
          outputDirectory: './runs',
          github: 'octo/app',
          command: 'opencode',
        }),
      );

      const error = expectFailure(
        await loadConfig(configPath, configStore, undefined),
        'ConfigValidationError',
      );

      expect(error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'repositories.sample-repo.github',
          message:
            'a GitHub repository entry needs XDG_CACHE_HOME or HOME set to an absolute path for its managed clone',
        },
      ]);
    });

    it('resolves a GitHub entry clone path against the managed-clone root', async () => {
      const configPath = await writeConfigFile(
        githubRepositoryConfigYaml({
          outputDirectory: './runs',
          github: 'octo/app',
          command: 'opencode',
        }),
      );
      const root = join(tempDirectory, 'cache');

      const config = expectOk(await loadConfig(configPath, configStore, root));

      expect(config.repositories[0]).toEqual({
        id: 'sample-repo',
        github: 'octo/app',
        path: join(root, 'github.com/octo/app.git'),
      });
    });

    it('rejects a managed clone overlapping the run output directory, naming repositories.<id>.github', async () => {
      const root = join(tempDirectory, 'cache');
      await fs.mkdir(root, { recursive: true });
      const configPath = await writeConfigFile(
        githubRepositoryConfigYaml({
          outputDirectory: './cache',
          github: 'octo/app',
          command: 'opencode',
        }),
      );

      const error = expectFailure(
        await loadConfig(configPath, configStore, root),
        'ConfigValidationError',
      );

      expect(error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'repositories.sample-repo.github',
          message:
            'repository "sample-repo" overlaps the run output directory after real-path resolution',
        },
      ]);
    });

    it('flags a path entry whose real path equals the managed-clone root, when a GitHub entry is present', async () => {
      const root = join(tempDirectory, 'cache');
      const configPath = await writeConfigFile(
        githubRepositoryConfigYaml({
          outputDirectory: './runs',
          github: 'octo/app',
          command: 'opencode',
          extraRepositories: '  - id: local-repo\n    path: ./cache\n',
        }),
      );

      const error = expectFailure(
        await loadConfig(configPath, configStore, root),
        'ConfigValidationError',
      );

      expect(error.findings).toEqual([
        {
          severity: 'error',
          identifier: 'repositories.local-repo.path',
          message: `repository "local-repo" overlaps the managed-clone directory "${root}" after real-path resolution`,
        },
      ]);
    });

    it('reports the placement findings before the overlay findings', async () => {
      const root = join(tempDirectory, 'cache');
      const configPath = await writeConfigFile(
        githubRepositoryConfigYaml({
          outputDirectory: './runs',
          github: 'octo/app',
          command: 'opencode',
          extraRepositories: '  - id: local-repo\n    path: ./cache\n',
        }).replace('    checks:\n', '    checks:\n      overlay: ./cache/hidden-checks\n'),
      );

      const error = expectFailure(
        await loadConfig(configPath, configStore, root),
        'ConfigValidationError',
      );

      expect(error.findings.map(({ identifier }) => identifier)).toEqual([
        'repositories.local-repo.path',
        'tasks.write-report.checks.overlay',
      ]);
    });

    it('does not flag a path entry overlapping the managed-clone root directory when no GitHub entry is present', async () => {
      const root = join(tempDirectory, 'cache');
      const configPath = await writeConfigFile(
        configYaml({ outputDirectory: './runs', repositoryPath: './cache', command: 'opencode' }),
      );

      const config = expectOk(await loadConfig(configPath, configStore, root));

      expect(config.repositories[0]?.path).toBe(root);
    });
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

describe('checkRepositoryPlacement', () => {
  const GITHUB_APP = { id: 'app', github: 'octo/app', path: 'github.com/octo/app.git' };
  let tempDirectory: string;
  let configPath: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), 'tevu-placement-'));
    configPath = join(tempDirectory, 'tevu.yaml');
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  it('returns no findings for a relative output directory beside path entries outside it', async () => {
    const findings = await checkRepositoryPlacement(
      { outputDirectory: 'runs', repositories: [{ id: 'app', path: './repo' }] },
      configPath,
      undefined,
    );

    expect(findings).toEqual([]);
  });

  it('returns no findings for a GitHub entry when a managed-clone root exists', async () => {
    const findings = await checkRepositoryPlacement(
      { outputDirectory: 'runs', repositories: [GITHUB_APP] },
      configPath,
      join(tempDirectory, 'cache'),
    );

    expect(findings).toEqual([]);
  });

  it('resolves a relative output directory against the configuration file directory', async () => {
    const findings = await checkRepositoryPlacement(
      { outputDirectory: 'runs', repositories: [{ id: 'app', path: './runs/repo' }] },
      configPath,
      undefined,
    );

    expect(findings).toEqual([
      {
        severity: 'error',
        identifier: 'repositories.app.path',
        message: 'repository "app" overlaps the run output directory after real-path resolution',
      },
    ]);
  });

  it('reports an output directory inside a path entry under run.output_dir', async () => {
    const findings = await checkRepositoryPlacement(
      { outputDirectory: './repo/runs', repositories: [{ id: 'app', path: './repo' }] },
      configPath,
      undefined,
    );

    expect(findings).toEqual([
      {
        severity: 'error',
        identifier: 'run.output_dir',
        message: 'run.output_dir must be outside repository "app" after real-path resolution',
      },
    ]);
  });

  it('accepts an absolute output directory', async () => {
    const findings = await checkRepositoryPlacement(
      {
        outputDirectory: join(tempDirectory, 'repo', 'runs'),
        repositories: [{ id: 'app', path: './repo' }],
      },
      configPath,
      undefined,
    );

    expect(findings.map(({ identifier }) => identifier)).toEqual(['run.output_dir']);
  });

  it('reports a GitHub entry without a managed-clone root under its github identifier', async () => {
    const findings = await checkRepositoryPlacement(
      { outputDirectory: 'runs', repositories: [GITHUB_APP] },
      configPath,
      undefined,
    );

    expect(findings).toEqual([
      {
        severity: 'error',
        identifier: 'repositories.app.github',
        message:
          'a GitHub repository entry needs XDG_CACHE_HOME or HOME set to an absolute path for its managed clone',
      },
    ]);
  });

  it('flags a path entry that equals the managed-clone root beside a GitHub entry', async () => {
    const root = join(tempDirectory, 'cache');

    const findings = await checkRepositoryPlacement(
      {
        outputDirectory: 'runs',
        repositories: [GITHUB_APP, { id: 'local', path: './cache' }],
      },
      configPath,
      root,
    );

    expect(findings).toEqual([
      {
        severity: 'error',
        identifier: 'repositories.local.path',
        message: `repository "local" overlaps the managed-clone directory "${root}" after real-path resolution`,
      },
    ]);
  });

  it('does not flag a path entry on the managed-clone root when no GitHub entry is present', async () => {
    const findings = await checkRepositoryPlacement(
      { outputDirectory: 'runs', repositories: [{ id: 'local', path: './cache' }] },
      configPath,
      join(tempDirectory, 'cache'),
    );

    expect(findings).toEqual([]);
  });

  it('reports the missing root first, then the output separation finding', async () => {
    const findings = await checkRepositoryPlacement(
      {
        outputDirectory: 'runs',
        repositories: [GITHUB_APP, { id: 'local', path: './runs/repo' }],
      },
      configPath,
      undefined,
    );

    expect(findings.map(({ identifier }) => identifier)).toEqual([
      'repositories.app.github',
      'repositories.local.path',
    ]);
  });

  it('reports the output separation findings before the managed-clone overlap findings', async () => {
    const root = join(tempDirectory, 'cache');

    const findings = await checkRepositoryPlacement(
      {
        outputDirectory: 'cache',
        repositories: [GITHUB_APP, { id: 'local', path: './cache' }],
      },
      configPath,
      root,
    );

    expect(findings.map(({ identifier }) => identifier)).toEqual([
      'repositories.app.github',
      'run.output_dir',
      'repositories.local.path',
    ]);
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
    const fromLoad = await loadConfig(requestedPath, configStore, undefined);

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

describe('resolveRepositoryPath (AC-15, P11)', () => {
  it('returns a GitHub entry path unchanged when resolveConfig already resolved it', () => {
    const managedCloneRoot = '/cache/tevu';
    const resolvedPath = join(managedCloneRoot, 'github.com/octo/app.git');

    expect(
      resolveRepositoryPath(
        { path: resolvedPath, github: 'octo/app' },
        '/config/dir',
        managedCloneRoot,
      ),
    ).toBe(resolvedPath);
  });

  it('still resolves a relative managed-clone location against the managed-clone root', () => {
    const managedCloneRoot = '/cache/tevu';

    expect(
      resolveRepositoryPath(
        { path: 'github.com/octo/app.git', github: 'octo/app' },
        '/config/dir',
        managedCloneRoot,
      ),
    ).toBe(join(managedCloneRoot, 'github.com/octo/app.git'));
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

  it('resolveBootstrapModelCallConfig matches what loadConfig resolves for the file createTask writes (P10)', async () => {
    const configPath = '/tmp/tevu/tevu.yaml';
    const bootstrap: Omit<TevuConfigInput, 'version' | 'tasks'> = {
      run: buildRunSettings(),
      agents: buildAgents(),
      repositories: [buildRepository()],
      models: [
        buildModel(),
        buildModel({ id: 'beta', model: 'anthropic/claude-4', effort: 'max' }),
      ],
      roles: {
        criteria: buildModelRole({ model: 'openai/criteria-model', effort: 'high' }),
        grader: buildModelRole({
          model: 'openai/grader-model',
          effort: 'medium',
          agent: 'opencode',
        }),
      },
    };
    let writtenText: string | undefined;
    const dependencies = buildTaskDependencies({
      configStore: buildConfigStore({
        exists: vi.fn(async () => false),
        replaceText: vi.fn(async (_path: string, text: string) => {
          writtenText = text;
          return { ok: true as const, value: undefined };
        }),
      }),
    });

    await createTask(buildTaskWizardInput({ configPath, bootstrap }), dependencies);
    if (writtenText === undefined) {
      throw new Error('expected createTask to write a configuration');
    }
    const text = writtenText;

    const loaded = expectOk(
      await loadConfig(
        configPath,
        buildConfigStore({ readText: vi.fn(async () => ({ ok: true as const, value: text })) }),
        undefined,
      ),
    );
    const resolved = resolveBootstrapModelCallConfig(bootstrap, configPath);

    expect(resolved.agents).toEqual(loaded.agents);
    expect(resolved.roles).toEqual(loaded.roles);
    expect(resolved.run.timeout).toBe(loaded.run.timeout);
    expect(resolved.run.stop_grace).toBe(loaded.run.stop_grace);
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

  describe('a pull-request reference', () => {
    const FULL_HASH = '0123456789abcdef0123456789abcdef01234567';

    function buildPullRequestTask(overrides: Partial<TaskInput> = {}): TaskInput {
      return buildTaskDefinition({
        id: 'new-task',
        base_commit: FULL_HASH,
        reference: { kind: 'pull-request', identifier: 'octo/repo#42', commits: [FULL_HASH] },
        ...overrides,
      });
    }

    it('saves an unavailable full-hash base unchanged without calling validateSource', async () => {
      const validateSource = vi.fn();
      const resolveCommit = vi.fn(async () => ({ kind: 'not-found' as const }));
      const dependencies = buildTaskDependencies({
        git: buildGit({ validateSource, resolveCommit }),
      });

      const task = expectOk(
        await createTask(buildTaskWizardInput({ task: buildPullRequestTask() }), dependencies),
      );

      expect(task.base_commit).toBe(FULL_HASH);
      expect(validateSource).not.toHaveBeenCalled();
      expect(resolveCommit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: 'sample-repo' }),
        FULL_HASH,
      );
    });

    it('still pins the base through validateSource when the lookup finds no repository', async () => {
      const resolveCommit = vi.fn(async () => ({ kind: 'no-repository' as const }));
      const dependencies = buildTaskDependencies({ git: buildGit({ resolveCommit }) });

      const task = expectOk(
        await createTask(buildTaskWizardInput({ task: buildPullRequestTask() }), dependencies),
      );

      expect(task.base_commit).toBe(`resolved-${FULL_HASH}`);
    });

    it('pins the base through validateSource as today when the base is not a full hash', async () => {
      const validateSource = vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
        ok: true as const,
        value: {
          repositoryId: repository.id,
          requestedCommit: commit,
          resolvedCommit: 'resolved-head',
        },
      }));
      const resolveCommit = vi.fn();
      const dependencies = buildTaskDependencies({
        git: buildGit({ validateSource, resolveCommit }),
      });

      const task = expectOk(
        await createTask(
          buildTaskWizardInput({ task: buildPullRequestTask({ base_commit: 'HEAD' }) }),
          dependencies,
        ),
      );

      expect(task.base_commit).toBe('resolved-head');
      expect(resolveCommit).not.toHaveBeenCalled();
    });
  });

  describe('GitHub repository entry (AC-15, P11)', () => {
    it('locates the managed clone once for an existing GitHub-entry configuration file', async () => {
      const managedCloneRoot = '/cache/tevu';
      const configText = githubRepositoryConfigYaml({
        outputDirectory: './runs',
        github: 'octo/app',
        command: 'opencode',
      });
      const validateSource = vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
        ok: true as const,
        value: {
          repositoryId: repository.id,
          requestedCommit: commit,
          resolvedCommit: `resolved-${commit}`,
        },
      }));
      const dependencies = buildTaskDependencies({
        configStore: buildConfigStore({
          readText: vi.fn(async () => ({ ok: true as const, value: configText })),
        }),
        git: buildGit({ validateSource }),
        managedCloneRoot,
      });

      const task = expectOk(await createTask(buildTaskWizardInput(), dependencies));

      expect(task.repo).toBe('sample-repo');
      expect(validateSource).toHaveBeenCalledExactlyOnceWith(
        {
          id: 'sample-repo',
          path: join(managedCloneRoot, 'github.com/octo/app.git'),
          github: 'octo/app',
        },
        'abc123',
      );
    });
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

  describe('a task with a commit reference', () => {
    const BASE = 'abcdef0123456789abcdef0123456789abcdef01';
    const REFERENCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';

    function buildTaskWithReference(overrides: Partial<TaskInput> = {}): TaskInput {
      return buildTaskDefinition({
        reference: { kind: 'commit', identifier: 'HEAD~3', commits: [REFERENCE_COMMIT] },
        ...overrides,
      });
    }

    function buildDependenciesResolvingBaseTo(
      resolvedCommit: string,
      overrides: Partial<GitWorkspaceAdapter> = {},
    ): ValidationDependencies {
      return buildValidationDependencies({
        git: buildFullGit({
          validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
            ok: true as const,
            value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit },
          })),
          ...overrides,
        }),
      });
    }

    it('rejects a base commit equal to the reference commit', async () => {
      const task = buildTaskWithReference({ base_commit: REFERENCE_COMMIT });
      const dependencies = buildDependenciesResolvingBaseTo(REFERENCE_COMMIT, {
        resolveCommit: vi.fn(async () => ({ kind: 'found' as const, commit: REFERENCE_COMMIT })),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual([
        {
          severity: 'error',
          identifier: `tasks.${task.id}.base_commit`,
          message: `base commit ${REFERENCE_COMMIT.slice(0, 7)} is reference commit ${REFERENCE_COMMIT.slice(0, 7)}`,
        },
      ]);
    });

    it('rejects a base commit that does not precede the reference commit', async () => {
      const task = buildTaskWithReference({ base_commit: BASE });
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async () => ({ kind: 'found' as const, commit: REFERENCE_COMMIT })),
        isAncestor: vi.fn(async () => false),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual([
        {
          severity: 'error',
          identifier: `tasks.${task.id}.base_commit`,
          message: `base commit ${BASE.slice(0, 7)} does not precede reference commit ${REFERENCE_COMMIT.slice(0, 7)}`,
        },
      ]);
    });

    it('rejects a base commit that could not be compared with the reference commit', async () => {
      const task = buildTaskWithReference({ base_commit: BASE });
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async () => ({ kind: 'found' as const, commit: REFERENCE_COMMIT })),
        isAncestor: vi.fn(async () => null),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual([
        {
          severity: 'error',
          identifier: `tasks.${task.id}.base_commit`,
          message: `base commit ${BASE.slice(0, 7)} could not be compared with reference commit ${REFERENCE_COMMIT.slice(0, 7)}`,
        },
      ]);
    });

    it('warns once when the reference commit is unavailable, and skips the comparison', async () => {
      const task = buildTaskWithReference({ base_commit: BASE });
      const isAncestor = vi.fn();
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async () => ({ kind: 'not-found' as const })),
        isAncestor,
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(true);
      expect(report.findings).toEqual([
        {
          severity: 'warning',
          identifier: `tasks.${task.id}.reference`,
          message:
            'reference commits not available in repository "sample-repo": 1 of 1; the base commit was not compared with them',
        },
      ]);
      expect(isAncestor).not.toHaveBeenCalled();
    });

    it('rejects a task whose prompt names its reference commit', async () => {
      const task = buildTaskWithReference({
        base_commit: BASE,
        prompt: `follow the same approach as ${REFERENCE_COMMIT.slice(0, 7)}`,
      });
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async () => ({ kind: 'found' as const, commit: REFERENCE_COMMIT })),
        isAncestor: vi.fn(async () => true),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual([
        {
          severity: 'error',
          identifier: `tasks.${task.id}`,
          message: `agent prompt contains resolved reference commit ${REFERENCE_COMMIT.slice(0, 7)}`,
        },
      ]);
    });
  });

  describe('a task with a pull-request reference', () => {
    const BASE = 'abcdef0123456789abcdef0123456789abcdef01';
    const PR_COMMIT = '0123456789abcdef0123456789abcdef01234567';
    const MERGE_COMMIT = '1111111111111111111111111111111111111111';

    function buildTaskWithReference(overrides: Partial<TaskInput> = {}): TaskInput {
      return buildTaskDefinition({
        reference: { kind: 'pull-request', identifier: 'octo/app#128', commits: [PR_COMMIT] },
        ...overrides,
      });
    }

    function buildDependenciesResolvingBaseTo(
      resolvedCommit: string,
      overrides: Partial<GitWorkspaceAdapter> = {},
    ): ValidationDependencies {
      return buildValidationDependencies({
        git: buildFullGit({
          validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
            ok: true as const,
            value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit },
          })),
          ...overrides,
        }),
      });
    }

    it('rejects a base commit that descends from a recorded pull-request commit', async () => {
      const task = buildTaskWithReference({ base_commit: 'main' });
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async () => ({ kind: 'found' as const, commit: PR_COMMIT })),
        isAncestor: vi.fn(async () => true),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual([
        {
          severity: 'error',
          identifier: `tasks.${task.id}.base_commit`,
          message: `base commit ${BASE.slice(0, 7)} contains reference commit ${PR_COMMIT.slice(0, 7)}`,
        },
      ]);
    });

    it('accepts an unmerged target tip that neither equals nor descends from a pull-request commit', async () => {
      const task = buildTaskWithReference({ base_commit: 'main' });
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async () => ({ kind: 'found' as const, commit: PR_COMMIT })),
        isAncestor: vi.fn(async () => false),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(true);
      expect(report.findings).toEqual([]);
    });

    it('names the fetch when the full-hash base is not available locally', async () => {
      const task = buildTaskWithReference({ base_commit: BASE });
      const validateSource = vi.fn();
      const dependencies = buildValidationDependencies({
        git: buildFullGit({
          validateSource,
          resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) =>
            commit === BASE
              ? { kind: 'not-found' as const }
              : { kind: 'found' as const, commit: PR_COMMIT },
          ),
        }),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: `tasks.${task.id}.base_commit`,
        message: `base commit ${BASE} is not in repository "sample-repo" ("/tmp/tevu/sample-repo"); fetch it there first, for example: git fetch https://github.com/octo/app.git ${BASE}`,
      });
      expect(validateSource).not.toHaveBeenCalled();
    });

    it('still validates through validateSource when the full-hash base lookup finds no repository', async () => {
      const task = buildTaskWithReference({ base_commit: BASE });
      const validateSource = vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: 'SourceMaterializationError' as const,
          taskId: task.id,
          reason: `repository "sample-repo": "/tmp/tevu/sample-repo" is not a Git repository`,
        },
      }));
      const dependencies = buildValidationDependencies({
        git: buildFullGit({
          validateSource,
          resolveCommit: vi.fn(async () => ({ kind: 'no-repository' as const })),
        }),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(validateSource).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: 'sample-repo' }),
        BASE,
      );
      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: `tasks.${task.id}.base_commit`,
        message: `repository "sample-repo": "/tmp/tevu/sample-repo" is not a Git repository`,
      });
    });

    it('reports only the first violation in recorded order and stops comparing further commits', async () => {
      const secondCommit = '2222222222222222222222222222222222222222';
      const task = buildTaskWithReference({
        base_commit: 'main',
        reference: {
          kind: 'pull-request',
          identifier: 'octo/app#128',
          commits: [PR_COMMIT, secondCommit],
        },
      });
      const isAncestor = vi.fn(async () => true);
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) => ({
          kind: 'found' as const,
          commit,
        })),
        isAncestor,
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toEqual([
        {
          severity: 'error',
          identifier: `tasks.${task.id}.base_commit`,
          message: `base commit ${BASE.slice(0, 7)} contains reference commit ${PR_COMMIT.slice(0, 7)}`,
        },
      ]);
      expect(isAncestor).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: 'sample-repo' }),
        PR_COMMIT,
        BASE,
      );
    });

    it('also checks the raw base text against the agent prompt when the base is missing', async () => {
      const task = buildTaskWithReference({
        base_commit: BASE,
        prompt: `use commit ${BASE.slice(0, 7)} as a starting point`,
      });
      const dependencies = buildValidationDependencies({
        git: buildFullGit({
          resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) =>
            commit === BASE
              ? { kind: 'not-found' as const }
              : { kind: 'found' as const, commit: PR_COMMIT },
          ),
        }),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: `tasks.${task.id}`,
        message: `agent prompt contains resolved base commit ${BASE.slice(0, 7)}`,
      });
    });

    it('rejects a task whose prompt names its pull-request key', async () => {
      const task = buildTaskWithReference({
        base_commit: 'main',
        prompt: 'follow octo/app#128 exactly',
      });
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async () => ({ kind: 'found' as const, commit: PR_COMMIT })),
        isAncestor: vi.fn(async () => false),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: `tasks.${task.id}`,
        message: 'agent prompt contains pull request octo/app#128',
      });
    });

    it('counts the merge commit together with the pull-request commits in the Summary warning', async () => {
      const task = buildTaskWithReference({
        base_commit: 'main',
        reference: {
          kind: 'pull-request',
          identifier: 'octo/app#128',
          commits: [PR_COMMIT],
          merge_commit: MERGE_COMMIT,
        },
      });
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async () => ({ kind: 'not-found' as const })),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'warning',
        identifier: `tasks.${task.id}.reference`,
        message:
          'reference commits not available in repository "sample-repo": 2 of 2; the base commit was not compared with them',
      });
    });

    it('warns about the merge commit separately exactly when it is unavailable', async () => {
      const task = buildTaskWithReference({
        base_commit: 'main',
        reference: {
          kind: 'pull-request',
          identifier: 'octo/app#128',
          commits: [PR_COMMIT],
          merge_commit: MERGE_COMMIT,
        },
      });
      const dependencies = buildDependenciesResolvingBaseTo(BASE, {
        resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) =>
          commit === MERGE_COMMIT
            ? { kind: 'not-found' as const }
            : { kind: 'found' as const, commit: PR_COMMIT },
        ),
        isAncestor: vi.fn(async () => false),
      });

      const config = expectSchemaAcceptance(buildConfig({ tasks: [task] }));
      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'warning',
        identifier: `tasks.${task.id}.reference.merge_commit`,
        message: `merge commit ${MERGE_COMMIT.slice(0, 7)} is not available in repository "sample-repo"; the base commit was not checked to precede it`,
      });
      expect(report.findings).toContainEqual({
        severity: 'warning',
        identifier: `tasks.${task.id}.reference`,
        message:
          'reference commits not available in repository "sample-repo": 1 of 2; the base commit was not compared with them',
      });
    });
  });

  describe('a task on a GitHub entry (AC-10, AC-19, section 3.3.5)', () => {
    const CLONE_DIRECTORY = '/cache/tevu/repositories/github.com/octo/app.git';

    function buildGitHubRepository(
      overrides: Partial<RepositoryDefinition> = {},
    ): RepositoryDefinition {
      return { id: 'sample-repo', github: 'octo/app', path: CLONE_DIRECTORY, ...overrides };
    }

    /** A schema-accepted base config with its sole repository swapped for a GitHub entry. */
    function buildGitHubTaskConfig(
      tasks: TaskInput[],
      repositoryOverrides: Partial<RepositoryDefinition> = {},
    ): TevuConfig {
      return {
        ...expectSchemaAcceptance(buildConfig({ tasks })),
        repositories: [buildGitHubRepository(repositoryOverrides)],
      };
    }

    it('reports a missing-clone finding and skips commit resolution entirely', async () => {
      const inspectClone = vi.fn(async () => 'missing' as const);
      const dependencies = buildValidationDependencies({ clones: { inspectClone } });
      const config = buildGitHubTaskConfig([buildTaskDefinition()]);

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: 'repositories.sample-repo.github',
        message: `repository "sample-repo" has no clone of github.com/octo/app at "${CLONE_DIRECTORY}"; tevu run --dry-run clones it`,
      });
      expect(inspectClone).toHaveBeenCalledExactlyOnceWith(CLONE_DIRECTORY);
      expect(dependencies.git.validateSource).not.toHaveBeenCalled();
      expect(dependencies.git.resolveCommit).not.toHaveBeenCalled();
    });

    it('reports a not-a-repository finding naming the removal-and-reclone hint', async () => {
      const inspectClone = vi.fn(async () => 'not-a-repository' as const);
      const dependencies = buildValidationDependencies({ clones: { inspectClone } });
      const config = buildGitHubTaskConfig([buildTaskDefinition()]);

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: 'repositories.sample-repo.github',
        message: `"${CLONE_DIRECTORY}" is not a clone tevu made for repository "sample-repo"; remove it, then tevu run --dry-run clones github.com/octo/app there`,
      });
    });

    it('inspects the clone exactly once even when several tasks name the same entry', async () => {
      const inspectClone = vi.fn(async () => 'missing' as const);
      const dependencies = buildValidationDependencies({ clones: { inspectClone } });
      const config = buildGitHubTaskConfig([
        buildTaskDefinition({ id: 'task-one' }),
        buildTaskDefinition({ id: 'task-two' }),
      ]);

      await validateConfig(config, dependencies);

      expect(inspectClone).toHaveBeenCalledOnce();
    });

    it('leaves today\'s checks unaffected when the clone state is "repository"', async () => {
      const inspectClone = vi.fn(async () => 'repository' as const);
      const dependencies = buildValidationDependencies({
        clones: { inspectClone },
        git: buildFullGit({
          ...buildGit(),
          resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) => ({
            kind: 'found' as const,
            commit,
          })),
        }),
      });
      const config = buildGitHubTaskConfig([buildTaskDefinition()]);

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(true);
      expect(report.findings).toEqual([]);
      expect(dependencies.git.validateSource).toHaveBeenCalledOnce();
    });

    it("names the tevu run --dry-run fetch when a pull-request task's full-hash base is not in the clone", async () => {
      const BASE = 'abcdef0123456789abcdef0123456789abcdef01';
      const PR_COMMIT = '0123456789abcdef0123456789abcdef01234567';
      const task = buildTaskDefinition({
        base_commit: BASE,
        reference: { kind: 'pull-request', identifier: 'octo/app#128', commits: [PR_COMMIT] },
      });
      const validateSource = vi.fn();
      const dependencies = buildValidationDependencies({
        clones: { inspectClone: vi.fn(async () => 'repository' as const) },
        git: buildFullGit({
          validateSource,
          resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) =>
            commit === BASE
              ? { kind: 'not-found' as const }
              : { kind: 'found' as const, commit: PR_COMMIT },
          ),
        }),
      });
      const config = buildGitHubTaskConfig([task]);

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: `tasks.${task.id}.base_commit`,
        message: `base commit "${BASE}" is not in the clone of repository "sample-repo"; tevu run --dry-run fetches it from github.com/octo/app`,
      });
      expect(validateSource).not.toHaveBeenCalled();
    });

    it('names the tevu run --dry-run fetch when a branch base of a task without a reference is not in the clone', async () => {
      const task = buildTaskDefinition({ base_commit: 'release-2' });
      const validateSource = vi.fn();
      const dependencies = buildValidationDependencies({
        clones: { inspectClone: vi.fn(async () => 'repository' as const) },
        git: buildFullGit({
          validateSource,
          resolveCommit: vi.fn(async () => ({ kind: 'not-found' as const })),
        }),
      });
      const config = buildGitHubTaskConfig([task]);

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: `tasks.${task.id}.base_commit`,
        message:
          'base commit "release-2" is not in the clone of repository "sample-repo"; tevu run --dry-run fetches it from github.com/octo/app',
      });
      expect(validateSource).not.toHaveBeenCalled();
    });

    it('appends the tevu run --dry-run hint to the reference-commits-unavailable warning', async () => {
      const BASE = 'abcdef0123456789abcdef0123456789abcdef01';
      const REFERENCE_COMMIT = '0123456789abcdef0123456789abcdef01234567';
      const task = buildTaskDefinition({
        base_commit: BASE,
        reference: { kind: 'commit', identifier: 'HEAD~3', commits: [REFERENCE_COMMIT] },
      });
      const dependencies = buildValidationDependencies({
        clones: { inspectClone: vi.fn(async () => 'repository' as const) },
        git: buildFullGit({
          validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
            ok: true as const,
            value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit: BASE },
          })),
          resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) =>
            commit === BASE
              ? { kind: 'found' as const, commit: BASE }
              : { kind: 'not-found' as const },
          ),
        }),
      });
      const config = buildGitHubTaskConfig([task]);

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'warning',
        identifier: `tasks.${task.id}.reference`,
        message:
          'reference commits not available in repository "sample-repo": 1 of 1; the base commit was not compared with them; tevu run --dry-run fetches them',
      });
    });

    it('appends the tevu run --dry-run hint to the merge-commit-unavailable warning', async () => {
      const BASE = 'abcdef0123456789abcdef0123456789abcdef01';
      const PR_COMMIT = '0123456789abcdef0123456789abcdef01234567';
      const MERGE_COMMIT = '1111111111111111111111111111111111111111';
      const task = buildTaskDefinition({
        base_commit: BASE,
        reference: {
          kind: 'pull-request',
          identifier: 'octo/app#128',
          commits: [PR_COMMIT],
          merge_commit: MERGE_COMMIT,
        },
      });
      const dependencies = buildValidationDependencies({
        clones: { inspectClone: vi.fn(async () => 'repository' as const) },
        git: buildFullGit({
          validateSource: vi.fn(async (repository: RepositoryDefinition, commit: string) => ({
            ok: true as const,
            value: { repositoryId: repository.id, requestedCommit: commit, resolvedCommit: BASE },
          })),
          resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) =>
            commit === MERGE_COMMIT
              ? { kind: 'not-found' as const }
              : { kind: 'found' as const, commit: PR_COMMIT },
          ),
          isAncestor: vi.fn(async () => false),
        }),
      });
      const config = buildGitHubTaskConfig([task]);

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'warning',
        identifier: `tasks.${task.id}.reference.merge_commit`,
        message: `merge commit ${MERGE_COMMIT.slice(0, 7)} is not available in repository "sample-repo"; the base commit was not checked to precede it; tevu run --dry-run fetches it`,
      });
    });
  });

  describe('with declared model roles', () => {
    it('probes the single configured agent once even when both model roles declare it', async () => {
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: buildAgentCapabilityReport('opencode'),
      }));
      const dependencies = buildValidationDependencies({
        agents: new Map([['opencode', buildFakeAgentAdapter({ probe })]]),
      });
      const config = expectSchemaAcceptance(
        buildConfig({ roles: { criteria: buildModelRole(), grader: buildModelRole() } }),
      );

      const report = expectOk(await validateConfig(config, dependencies));

      expect(probe).toHaveBeenCalledTimes(1);
      expect(report.capabilities).toEqual({ opencode: buildAgentCapabilityReport('opencode') });
    });

    it('yields the same findings for a probe failure whether or not model roles are declared', async () => {
      const buildFailingDependencies = (): ValidationDependencies =>
        buildValidationDependencies({
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
      const withoutRoles = expectSchemaAcceptance(buildConfig());
      const withRoles = expectSchemaAcceptance(
        buildConfig({ roles: { criteria: buildModelRole(), grader: buildModelRole() } }),
      );

      const reportWithoutRoles = expectOk(
        await validateConfig(withoutRoles, buildFailingDependencies()),
      );
      const reportWithRoles = expectOk(await validateConfig(withRoles, buildFailingDependencies()));

      expect(reportWithRoles.findings).toEqual(reportWithoutRoles.findings);
    });
  });

  describe('graded checks require roles.grader (P12)', () => {
    function buildGradedTaskDefinition(overrides: Partial<TaskInput> = {}): TaskInput {
      return buildTaskDefinition({
        checks: {
          acceptance: [{ id: 'csv-content', description: 'The CSV looks right.' }],
          done: [buildManualCheck()],
        },
        ...overrides,
      });
    }

    it('yields the roles.grader finding naming the task when a graded check exists without the role', async () => {
      const config = expectSchemaAcceptance(buildConfig({ tasks: [buildGradedTaskDefinition()] }));
      const dependencies = buildValidationDependencies();

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.valid).toBe(false);
      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: 'roles.grader',
        message:
          'graded checks need the grader role; declare roles.grader (tasks with graded checks: write-report)',
      });
    });

    it('names every task with a graded check, in configuration order, joined by ", "', async () => {
      const config = expectSchemaAcceptance(
        buildConfig({
          tasks: [
            buildGradedTaskDefinition({ id: 'first-task' }),
            buildGradedTaskDefinition({ id: 'second-task' }),
          ],
        }),
      );
      const dependencies = buildValidationDependencies();

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: 'roles.grader',
        message:
          'graded checks need the grader role; declare roles.grader (tasks with graded checks: first-task, second-task)',
      });
    });

    it('yields no roles.grader finding when the role is declared', async () => {
      const config = expectSchemaAcceptance(
        buildConfig({
          tasks: [buildGradedTaskDefinition()],
          roles: { grader: buildModelRole() },
        }),
      );
      const dependencies = buildValidationDependencies();

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings.map((finding) => finding.identifier)).not.toContain('roles.grader');
    });

    it('yields no roles.grader finding when no task declares a graded check', async () => {
      const config = expectSchemaAcceptance(buildConfig());
      const dependencies = buildValidationDependencies();

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings.map((finding) => finding.identifier)).not.toContain('roles.grader');
    });
  });
});

describe('the case-executable stage of validateConfig', () => {
  function expectedCaseExecutableMessage(params: {
    executable: string;
    resolved: string;
    failure: string;
    declared: string;
  }): string {
    return (
      `"${params.executable}"${params.resolved} exits 0 for --version in tevu's environment, ` +
      `secrets withheld, but ${params.failure} in a case environment, which has its own HOME and ` +
      `XDG directories and receives from tevu's environment only PATH and the variables declared ` +
      `in ${params.declared}: if it reads another variable, declare that variable there; if it is, ` +
      `or runs through, a version-manager shim, put the real executable's directory before the ` +
      `shim directory on PATH when starting tevu`
    );
  }

  it('skips the whole stage, calling probe zero times, when a required environment variable is missing', async () => {
    const dependencies = buildValidationDependencies({
      prerequisites: buildPrerequisites({ hasEnvironmentVariable: vi.fn(() => false) }),
    });
    const config = expectSchemaAcceptance(
      buildConfig({ agents: buildAgents({ env: ['OC_VAR'] }) }),
    );

    await validateConfig(config, dependencies);

    expect(dependencies.caseExecutables.probe).not.toHaveBeenCalled();
  });

  it('probes once per distinct probe key, skipping a relative-path executable, an unnamed repository, and non-command checks, and reports a parent-only key at every location sharing it', async () => {
    const pathRepository = buildRepository({
      id: 'path-repo',
      path: '/tmp/tevu/path-repo',
      setup: {
        before_agent: [['nested/tool'], ['setup-tool', 'arg']],
        timeout: '1m',
        env: ['SETUP_ENV'],
      },
    });
    const githubRepository = {
      id: 'github-repo',
      github: 'octo/app',
      path: '/cache/tevu/repositories/github.com/octo/app.git',
      setup: { before_agent: [['setup-tool']], timeout: '1m', env: ['SETUP_ENV'] },
    } as unknown as RepositoryDefinition;
    const unusedRepository = buildRepository({
      id: 'unused-repo',
      path: '/tmp/tevu/unused-repo',
      setup: { before_agent: [['ghost-tool']], timeout: '1m', env: [] },
    });
    const taskPath = buildTaskDefinition({
      id: 'task-path',
      repo: 'path-repo',
      checks: {
        acceptance: [
          buildCommandCheck({ id: 'check-path', run: ['setup-tool', 'arg2'], env: ['SETUP_ENV'] }),
        ],
        done: [
          buildManualCheck({ id: 'manual-done' }),
          { id: 'graded-done', description: 'graded' },
        ],
      },
    });
    const taskGithub = buildTaskDefinition({
      id: 'task-github',
      repo: 'github-repo',
      checks: {
        acceptance: [
          buildCommandCheck({ id: 'check-github', run: ['setup-tool'], env: ['SETUP_ENV'] }),
        ],
        done: [buildManualCheck({ id: 'manual-done-2' })],
      },
    });
    const withheldNames = [...GH_CREDENTIAL_ENVIRONMENT_VARIABLES, 'AGENT_SECRET'];
    const probe = vi.fn(async (request: CaseExecutableProbeRequest) =>
      request.executable === 'setup-tool' && request.workingDirectory === pathRepository.path
        ? {
            ok: true as const,
            value: {
              verdict: {
                verdict: 'parent-only' as const,
                resolvedPath: null,
                replicaFailure: { kind: 'exited' as const, exitCode: 1 },
              },
            },
          }
        : { ok: true as const, value: { verdict: { verdict: 'runs' as const } } },
    );
    const dependencies = buildValidationDependencies({
      environments: buildEnvironments({
        snapshotParent: vi.fn(() => ({
          ok: true as const,
          value: {
            path: '/usr/bin:/bin',
            agentValues: { AGENT_SECRET: 'agent-secret-value', AGENT_ENV: 'agent-env-value' },
            ordinaryEvaluatorValues: { SETUP_ENV: 'setup-env-value' },
            secretValues: ['agent-secret-value'],
          },
        })),
      }),
      // The GitHub entry's base commit needs to resolve so the source stage
      // adds no finding unrelated to the case-executable stage under test.
      git: buildFullGit({
        resolveCommit: vi.fn(async (_repository: RepositoryDefinition, commit: string) => ({
          kind: 'found' as const,
          commit,
        })),
      }),
      caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
    });
    // `githubRepository` carries both `path` and `github`, the materialized
    // shape `loadConfig` produces; `expectSchemaAcceptance` parses the file
    // shape directly, so it is spliced in afterward rather than parsed.
    const config: TevuConfig = {
      ...expectSchemaAcceptance(
        buildConfig({
          agents: buildAgents({ secrets: ['AGENT_SECRET'], env: ['AGENT_ENV'] }),
          repositories: [pathRepository, unusedRepository],
          tasks: [taskPath],
          roles: { grader: buildModelRole() },
        }),
      ),
      repositories: [pathRepository, githubRepository, unusedRepository],
      tasks: [taskPath, taskGithub] as unknown as TaskDefinition[],
    };

    const report = expectOk(await validateConfig(config, dependencies));

    expect(dependencies.environments.snapshotParent).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(report.findings.filter((finding) => finding.severity === 'error')).toEqual([
      {
        severity: 'error',
        identifier: 'repositories.path-repo.setup.before_agent.1',
        message: expectedCaseExecutableMessage({
          executable: 'setup-tool',
          resolved: '',
          failure: 'exits with code 1',
          declared: 'repositories.path-repo.setup.env',
        }),
      },
      {
        severity: 'error',
        identifier: 'tasks.task-path.checks.acceptance.check-path.run',
        message: expectedCaseExecutableMessage({
          executable: 'setup-tool',
          resolved: '',
          failure: 'exits with code 1',
          declared: 'tasks.task-path.checks.acceptance.check-path.env',
        }),
      },
    ]);

    const requests = probe.mock.calls.map(([request]) => request);
    const agentRequest = requests.find((request) => request.executable === 'opencode');
    expect(agentRequest).not.toHaveProperty('workingDirectory');
    expect(agentRequest).toMatchObject({
      additions: { AGENT_SECRET: 'agent-secret-value', AGENT_ENV: 'agent-env-value' },
    });
    expect(new Set(agentRequest?.withheldNames)).toEqual(new Set(withheldNames));

    const pathRequest = requests.find(
      (request) => request.executable === 'setup-tool' && 'workingDirectory' in request,
    );
    expect(pathRequest).toMatchObject({
      workingDirectory: pathRepository.path,
      additions: { SETUP_ENV: 'setup-env-value' },
    });
    expect(new Set(pathRequest?.withheldNames)).toEqual(new Set(withheldNames));

    const githubRequest = requests.find(
      (request) => request.executable === 'setup-tool' && !('workingDirectory' in request),
    );
    expect(githubRequest).not.toHaveProperty('workingDirectory');
    expect(githubRequest).toMatchObject({
      additions: { SETUP_ENV: 'setup-env-value' },
    });
    expect(new Set(githubRequest?.withheldNames)).toEqual(new Set(withheldNames));
  });

  it('stops probing after the first PrerequisiteError and reports it exactly once', async () => {
    const probe = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: 'PrerequisiteError' as const,
        tool: 'case-executable',
        expected: 'a new probe directory under /tmp',
        actual: 'ENOSPC',
      },
    }));
    const dependencies = buildValidationDependencies({
      caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
    });

    const report = expectOk(
      await validateConfig(expectSchemaAcceptance(buildConfig()), dependencies),
    );

    expect(report.valid).toBe(false);
    expect(
      report.findings.filter((finding) => finding.identifier === 'prerequisites.case-executable'),
    ).toEqual([
      {
        severity: 'error',
        identifier: 'prerequisites.case-executable',
        message: 'expected a new probe directory under /tmp, actual ENOSPC',
      },
    ]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'a resolved path different from the configured executable',
      resolvedPath: '/usr/local/bin/opencode',
      resolved: ' (/usr/local/bin/opencode)',
      replicaFailure: { kind: 'exited' as const, exitCode: 126 },
      failure: 'exits with code 126',
    },
    {
      label: 'a resolved path equal to the configured executable',
      resolvedPath: 'opencode',
      resolved: '',
      replicaFailure: { kind: 'exited' as const, exitCode: 1 },
      failure: 'exits with code 1',
    },
    {
      label: 'no resolved path and a signal',
      resolvedPath: null,
      resolved: '',
      replicaFailure: { kind: 'signaled' as const, signal: 'SIGSEGV' },
      failure: 'is terminated by signal SIGSEGV',
    },
    {
      label: 'a launch failure with a Node.js error code',
      resolvedPath: null,
      resolved: '',
      replicaFailure: { kind: 'not-started' as const, code: 'ENOENT' },
      failure: 'cannot be started (ENOENT)',
    },
    {
      label: 'a launch failure without an error code',
      resolvedPath: null,
      resolved: '',
      replicaFailure: { kind: 'not-started' as const, code: null },
      failure: 'cannot be started',
    },
  ])(
    'renders the fixed parent-only template exactly for $label',
    async ({ resolvedPath, resolved, replicaFailure, failure }) => {
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: { verdict: { verdict: 'parent-only' as const, resolvedPath, replicaFailure } },
      }));
      const dependencies = buildValidationDependencies({
        caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
      });

      const report = expectOk(
        await validateConfig(expectSchemaAcceptance(buildConfig()), dependencies),
      );

      expect(report.findings).toContainEqual({
        severity: 'error',
        identifier: 'agents.opencode.command',
        message: expectedCaseExecutableMessage({
          executable: 'opencode',
          resolved,
          failure,
          declared: 'agents.opencode.secrets and agents.opencode.env',
        }),
      });
    },
  );

  it('never lets an addition value reach a finding, only the executable and the resolved PATH entry', async () => {
    const dependencies = buildValidationDependencies({
      environments: buildEnvironments({
        snapshotParent: vi.fn(() => ({
          ok: true as const,
          value: {
            path: '/usr/bin:/bin',
            agentValues: { AGENT_SECRET_VALUE: 'sensitive-secret-9f2' },
            ordinaryEvaluatorValues: {},
            secretValues: ['sensitive-secret-9f2'],
          },
        })),
      }),
      caseExecutables: buildFakeCaseExecutablesAdapter({
        probe: vi.fn(async () => ({
          ok: true as const,
          value: {
            verdict: {
              verdict: 'parent-only' as const,
              resolvedPath: '/usr/local/bin/opencode',
              replicaFailure: { kind: 'exited' as const, exitCode: 1 },
            },
          },
        })),
      }),
    });
    const config = expectSchemaAcceptance(
      buildConfig({ agents: buildAgents({ secrets: ['AGENT_SECRET_VALUE'] }) }),
    );

    const report = expectOk(await validateConfig(config, dependencies));

    const messages = report.findings.map((finding) => finding.message).join('\n');
    expect(messages).not.toContain('sensitive-secret-9f2');
    expect(messages).toContain('/usr/local/bin/opencode');
  });

  describe('directory-snapshot warnings', () => {
    function buildRepositoryConfig(): TevuConfigInput {
      return buildConfig({
        repositories: [
          buildRepository({ setup: { before_agent: [['tool']], timeout: '1m', env: [] } }),
        ],
      });
    }

    it('caps a change warning at the first 10 paths and counts the rest', async () => {
      const added = Array.from(
        { length: 12 },
        (_unused, index) => `p${String(index).padStart(2, '0')}`,
      );
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: {
          verdict: { verdict: 'runs' as const },
          changes: { runs: [{ run: 'replica' as const, added, modified: [], removed: [] }] },
        },
      }));
      const dependencies = buildValidationDependencies({
        caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
      });

      const report = expectOk(
        await validateConfig(expectSchemaAcceptance(buildRepositoryConfig()), dependencies),
      );

      expect(report.findings).toContainEqual({
        severity: 'warning',
        identifier: 'repositories.sample-repo.setup.before_agent.0',
        message:
          'files in "/tmp/tevu/sample-repo" changed while "tool" was running with --version in ' +
          'a case environment: added p00, p01, p02, p03, p04, p05, p06, p07, p08, p09; +2 more; ' +
          'tevu did not revert them',
      });
    });

    it('reports the could-not-check warning, and only that warning, when a directory snapshot fails', async () => {
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: {
          verdict: { verdict: 'runs' as const },
          changes: {
            runs: [{ run: 'replica' as const, added: [], modified: [], removed: [] }],
            failure: 'git status exited with code 128',
          },
        },
      }));
      const dependencies = buildValidationDependencies({
        caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
      });

      const report = expectOk(
        await validateConfig(expectSchemaAcceptance(buildRepositoryConfig()), dependencies),
      );

      expect(
        report.findings.filter(
          (finding) => finding.identifier === 'repositories.sample-repo.setup.before_agent.0',
        ),
      ).toEqual([
        {
          severity: 'warning',
          identifier: 'repositories.sample-repo.setup.before_agent.0',
          message:
            'could not check whether files in "/tmp/tevu/sample-repo" changed while "tool" was ' +
            'running with --version: git status exited with code 128',
        },
      ]);
    });

    it('reports a change warning only at the first location sharing a probe key', async () => {
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: {
          verdict: { verdict: 'runs' as const },
          changes: {
            runs: [{ run: 'replica' as const, added: ['file.txt'], modified: [], removed: [] }],
          },
        },
      }));
      const dependencies = buildValidationDependencies({
        caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
      });
      const repository = buildRepository({
        setup: { before_agent: [['tool']], timeout: '1m', env: [] },
      });
      const config = expectSchemaAcceptance(
        buildConfig({
          repositories: [repository],
          tasks: [
            buildTaskDefinition({
              checks: {
                acceptance: [buildCommandCheck({ id: 'reuses-tool', run: ['tool'], env: [] })],
                done: [buildManualCheck({ id: 'manual-done' })],
              },
            }),
          ],
        }),
      );

      const report = expectOk(await validateConfig(config, dependencies));

      expect(report.findings.filter((finding) => finding.severity === 'warning')).toEqual([
        {
          severity: 'warning',
          identifier: 'repositories.sample-repo.setup.before_agent.0',
          message:
            'files in "/tmp/tevu/sample-repo" changed while "tool" was running with --version in ' +
            'a case environment: added file.txt; tevu did not revert them',
        },
      ]);
      // Once for the shared "tool" key (before_agent.0 and the acceptance
      // check), once more for the agent's own, distinct probe key.
      expect(probe).toHaveBeenCalledTimes(2);
    });

    it("orders a location's change warnings before its parent-only error", async () => {
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: {
          verdict: {
            verdict: 'parent-only' as const,
            resolvedPath: null,
            replicaFailure: { kind: 'exited' as const, exitCode: 1 },
          },
          changes: {
            runs: [{ run: 'replica' as const, added: ['file.txt'], modified: [], removed: [] }],
          },
        },
      }));
      const dependencies = buildValidationDependencies({
        caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
      });

      const report = expectOk(
        await validateConfig(expectSchemaAcceptance(buildRepositoryConfig()), dependencies),
      );

      const atLocation = report.findings.filter(
        (finding) => finding.identifier === 'repositories.sample-repo.setup.before_agent.0',
      );
      expect(atLocation.map((finding) => finding.severity)).toEqual(['warning', 'error']);
    });

    it('escapes a control character in a changed path', async () => {
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: {
          verdict: { verdict: 'runs' as const },
          changes: {
            runs: [
              { run: 'replica' as const, added: ['line\none.txt'], modified: [], removed: [] },
            ],
          },
        },
      }));
      const dependencies = buildValidationDependencies({
        caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
      });

      const report = expectOk(
        await validateConfig(expectSchemaAcceptance(buildRepositoryConfig()), dependencies),
      );

      expect(report.findings).toContainEqual({
        severity: 'warning',
        identifier: 'repositories.sample-repo.setup.before_agent.0',
        message:
          'files in "/tmp/tevu/sample-repo" changed while "tool" was running with --version in ' +
          'a case environment: added line\\u000aone.txt; tevu did not revert them',
      });
    });

    it('stays valid when every finding the stage produces is a warning', async () => {
      const probe = vi.fn(async () => ({
        ok: true as const,
        value: {
          verdict: { verdict: 'runs' as const },
          changes: {
            runs: [{ run: 'replica' as const, added: ['file.txt'], modified: [], removed: [] }],
          },
        },
      }));
      const dependencies = buildValidationDependencies({
        caseExecutables: buildFakeCaseExecutablesAdapter({ probe }),
      });

      const report = expectOk(
        await validateConfig(expectSchemaAcceptance(buildRepositoryConfig()), dependencies),
      );

      expect(report.findings.length).toBeGreaterThan(0);
      expect(report.findings.every((finding) => finding.severity === 'warning')).toBe(true);
      expect(report.valid).toBe(true);
    });
  });
});

describe('check-state configuration rules (P13, AC-3)', () => {
  let tempDirectory: string;
  const configStore = createConfigStore({ redact: (text) => text });

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

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

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

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

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

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

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

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

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

    const error = expectFailure(
      await loadConfig(configPath, configStore, undefined),
      'ConfigValidationError',
    );

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
