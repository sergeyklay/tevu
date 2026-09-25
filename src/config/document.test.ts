// @vitest-environment node
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfigStore } from '@/adapters/artifact-store';
import { createTask } from '@/application/create-task';

import { appendToConfigText, renderConfigDocument } from './document';

import type {
  CheckInput,
  ModelDefinitionInput,
  RepositoryInput,
  TaskInput,
  TevuConfigInput,
} from './schema';
import type { TaskDependencies, TaskWizardInput } from '@/application/create-task';
import type { GitWorkspaceAdapter, TevuError } from '@/domain/types';

function buildRepository(overrides: Partial<RepositoryInput> = {}): RepositoryInput {
  return { id: 'app', path: '../app', ...overrides };
}

function buildModel(overrides: Partial<ModelDefinitionInput> = {}): ModelDefinitionInput {
  return { id: 'gpt-low', model: 'openai/model', effort: 'low', ...overrides };
}

function buildManualCheck(overrides: Partial<CheckInput> = {}): CheckInput {
  return { id: 'a1', description: 'd1', manual: true, ...overrides };
}

function buildCommandCheck(overrides: Partial<CheckInput> = {}): CheckInput {
  return { id: 'd1', description: 'd2', run: ['npm', 'test'], timeout: '1m', ...overrides };
}

function buildTask(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 't1',
    title: 'Title',
    repo: 'app',
    base_commit: '0123456789abcdef0123456789abcdef01234567',
    prompt: 'p',
    description: 'd',
    readiness: ['r'],
    checks: { acceptance: [buildManualCheck()], done: [buildCommandCheck()] },
    ...overrides,
  };
}

function buildConfig(overrides: Partial<TevuConfigInput> = {}): TevuConfigInput {
  return {
    version: 1,
    run: { output_dir: '../runs', concurrency: 2, timeout: '10m', stop_grace: '3s' },
    agents: { opencode: { command: 'opencode', secrets: [], env: [] } },
    repositories: [buildRepository()],
    models: [buildModel(), buildModel({ id: 'gpt-high', effort: 'high' })],
    tasks: [buildTask()],
    ...overrides,
  };
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

describe('renderConfigDocument', () => {
  it('renders top-level keys in canonical order separated by one blank line, ending with one LF', () => {
    const rendered = renderConfigDocument(buildConfig(), { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const blocks = rendered.value.split('\n\n');
    expect(blocks.map((block) => block.split('\n')[0])).toEqual([
      'version: 1',
      'run:',
      'agents:',
      'repositories:',
      'models:',
      'tasks:',
    ]);
    expect(rendered.value.endsWith('\n')).toBe(true);
    expect(rendered.value.endsWith('\n\n')).toBe(false);
  });

  it('renders trackers between agents and repositories when present', () => {
    const config = buildConfig({
      trackers: {
        jira: { url: 'https://jira.example.com', email: '$JIRA_EMAIL', token: '$JIRA_TOKEN' },
      },
    });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const blocks = rendered.value.split('\n\n').map((block) => block.split('\n')[0]);
    expect(blocks.indexOf('agents:')).toBeLessThan(blocks.indexOf('trackers:'));
    expect(blocks.indexOf('trackers:')).toBeLessThan(blocks.indexOf('repositories:'));
    expect(rendered.value).toContain('trackers:\n  jira:\n    url: https://jira.example.com\n');
  });

  it('omits empty agents.opencode.secrets and env, and omits an absent trackers block', () => {
    const rendered = renderConfigDocument(buildConfig(), { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).not.toContain('secrets:');
    expect(rendered.value).not.toContain('env:');
    expect(rendered.value).not.toContain('trackers:');
  });

  it('renders non-empty agents.opencode.secrets and env as block lists', () => {
    const config = buildConfig({
      agents: { opencode: { command: 'opencode', secrets: ['OPENAI_API_KEY'], env: ['NODE_ENV'] } },
    });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('secrets:\n      - OPENAI_API_KEY\n');
    expect(rendered.value).toContain('env:\n      - NODE_ENV\n');
  });

  it("double-quotes base_commit and omits a command check's default exit_codes and empty env", () => {
    const rendered = renderConfigDocument(buildConfig(), { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('base_commit: "0123456789abcdef0123456789abcdef01234567"');
    expect(rendered.value).toContain('run: [npm, test]');
    expect(rendered.value).not.toContain('exit_codes:');
    expect(rendered.value).not.toContain('env: [');
  });

  it("renders a command check's run, non-default exit_codes, and env in flow style without padding", () => {
    const config = buildConfig({
      tasks: [
        buildTask({
          checks: {
            acceptance: [buildManualCheck()],
            done: [buildCommandCheck({ exit_codes: [1, 2], env: ['NODE_OPTIONS'] })],
          },
        }),
      ],
    });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('exit_codes: [1, 2]');
    expect(rendered.value).toContain('env: [NODE_OPTIONS]');
  });

  it.each([
    { required: undefined, expectPresent: false },
    { required: true, expectPresent: false },
    { required: false, expectPresent: true },
  ])('renders required: false but omits required: $required', ({ required, expectPresent }) => {
    const config = buildConfig({
      tasks: [
        buildTask({
          checks: { acceptance: [buildManualCheck()], done: [buildCommandCheck({ required })] },
        }),
      ],
    });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.includes('required: false')).toBe(expectPresent);
  });

  it('redacts every decoded string value before it becomes YAML', () => {
    const config = buildConfig({
      run: { output_dir: 'SECRET_PATH', concurrency: 2, timeout: '10m', stop_grace: '3s' },
    });
    const redact = (text: string): string => text.replaceAll('SECRET_PATH', '[REDACTED]');

    const rendered = renderConfigDocument(config, { redact });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('output_dir: "[REDACTED]"');
    expect(rendered.value).not.toContain('SECRET_PATH');
  });

  it('returns an ArtifactError with no text when redaction throws', () => {
    const redact = (): string => {
      throw new Error('redaction backend unavailable');
    };

    const rendered = renderConfigDocument(buildConfig(), { redact });

    const error = expectFailure(rendered, 'ArtifactError');
    expect(error.operation).toBe('render-configuration');
    expect(error.reason).toContain('redaction backend unavailable');
  });

  it('returns an ArtifactError when redaction returns a non-string value', () => {
    const redact = (): string => 42 as unknown as string;

    const rendered = renderConfigDocument(buildConfig(), { redact });

    const error = expectFailure(rendered, 'ArtifactError');
    expect(error.operation).toBe('render-configuration');
    expect(error.reason).toBe('redaction returned no text while rendering the configuration');
  });
});

describe('appendToConfigText', () => {
  const newTask = buildTask({
    id: 'new-task',
    title: 'New task',
    base_commit: '1111111111111111111111111111111111111111',
    checks: {
      acceptance: [buildManualCheck({ id: 'a1' })],
      done: [buildManualCheck({ id: 'd1' })],
    },
  });

  const RENDERED_NEW_TASK_LF =
    '  - id: new-task\n    title: New task\n    repo: app\n' +
    '    base_commit: "1111111111111111111111111111111111111111"\n' +
    '    prompt: p\n    description: d\n    readiness:\n      - r\n' +
    '    checks:\n      acceptance:\n        - id: a1\n          description: d1\n          manual: true\n' +
    '      done:\n        - id: d1\n          description: d1\n          manual: true\n';

  const EXISTING_TASK_LF =
    'version: 1\ntasks:\n  - id: t1\n    title: Title\n    repo: app\n' +
    '    base_commit: "0000000000000000000000000000000000000000"\n' +
    '    prompt: p\n    description: d\n    readiness:\n      - r\n' +
    '    checks:\n      acceptance:\n        - id: a1\n          description: d1\n          manual: true\n' +
    '      done:\n        - id: d1\n          description: d2\n          manual: true\n';

  it('inserts the new task right after the last item when nothing follows it', () => {
    const result = appendToConfigText(
      EXISTING_TASK_LF,
      { task: newTask },
      { redact: (value) => value },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(EXISTING_TASK_LF + RENDERED_NEW_TASK_LF);
  });

  it('inserts the new task right after a trailing indented comment when nothing follows it', () => {
    const text = `${EXISTING_TASK_LF}          # trailing comment on the last check\n`;

    const result = appendToConfigText(text, { task: newTask }, { redact: (value) => value });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(text + RENDERED_NEW_TASK_LF);
  });

  it('inserts the new task before a blank line and a column-zero comment that follow a trailing indented comment', () => {
    const beforeInsertion = `${EXISTING_TASK_LF}          # trailing comment on the last check\n`;
    const trailer = '\n# a column-zero comment after a blank line\n';
    const text = beforeInsertion + trailer;

    const result = appendToConfigText(text, { task: newTask }, { redact: (value) => value });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(beforeInsertion + RENDERED_NEW_TASK_LF + trailer);
  });

  it('preserves the blank line separating the list from the next top-level section', () => {
    const repositoriesBlock = 'repositories:\n  - id: app\n    path: ../app\n';
    const separator = '\nmodels:\n  - id: m1\n    model: a/b\n    effort: high\n';
    const text = repositoriesBlock + separator + EXISTING_TASK_LF.replace('version: 1\n', '');
    const newRepository = buildRepository({ id: 'extra', path: '../extra' });

    const result = appendToConfigText(
      text,
      { task: newTask, repository: newRepository },
      { redact: (value) => value },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = `${repositoriesBlock}  - id: extra\n    path: ../extra\n${separator}${EXISTING_TASK_LF.replace('version: 1\n', '')}${RENDERED_NEW_TASK_LF}`;
    expect(result.value).toBe(expected);
  });

  it('uses CRLF line breaks when the existing text contains CRLF', () => {
    const text = EXISTING_TASK_LF.replace(/\n/g, '\r\n');

    const result = appendToConfigText(text, { task: newTask }, { redact: (value) => value });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(text + RENDERED_NEW_TASK_LF.replace(/\n/g, '\r\n'));
  });

  it('rejects a flow-style tasks list with a finding and returns no text', () => {
    const text =
      'tasks: [{id: t1, title: Title, repo: app, base_commit: "0000000000000000000000000000000000000000", prompt: p, description: d, readiness: [r], checks: {acceptance: [{id: a1, description: d1, manual: true}], done: [{id: d1, description: d2, manual: true}]}}]\n';

    const result = appendToConfigText(text, { task: newTask }, { redact: (value) => value });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'ConfigValidationError',
        findings: [
          {
            severity: 'error',
            identifier: 'tasks',
            message:
              'task add appends only to a block-style list; rewrite tasks in block style and run task add again',
          },
        ],
      },
    });
  });

  it('rejects a flow-style repositories list with a finding and returns no text', () => {
    const text = `repositories: [{id: app, path: ../app}]\n${EXISTING_TASK_LF.replace('version: 1\n', '')}`;

    const result = appendToConfigText(
      text,
      { task: newTask, repository: buildRepository({ id: 'extra', path: '../extra' }) },
      { redact: (value) => value },
    );

    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'ConfigValidationError',
        findings: [
          {
            severity: 'error',
            identifier: 'repositories',
            message:
              'task add appends only to a block-style list; rewrite repositories in block style and run task add again',
          },
        ],
      },
    });
  });
});

function buildTaskDependencies(overrides: Partial<TaskDependencies> = {}): TaskDependencies {
  return {
    configStore: createConfigStore({ redact: (text) => text }),
    git: {
      validateSource: async (repository, commit) => ({
        ok: true,
        value: {
          repositoryId: repository.id,
          requestedCommit: commit,
          resolvedCommit: `resolved-${commit}`,
        },
      }),
    } satisfies Pick<GitWorkspaceAdapter, 'validateSource'>,
    registerSecrets: () => undefined,
    redact: (text) => text,
    ...overrides,
  };
}

describe('createTask leaves the configuration file byte-identical on failure', () => {
  let tempDirectory: string;
  let configPath: string;
  let originalText: string;

  beforeEach(async () => {
    tempDirectory = await fs.mkdtemp(join(tmpdir(), 'tevu-document-p6-'));
    configPath = join(tempDirectory, 'tevu.yaml');
    const rendered = renderConfigDocument(buildConfig(), { redact: (text) => text });
    if (!rendered.ok) throw new Error('expected the fixture configuration to render');
    originalText = rendered.value;
    await fs.writeFile(configPath, originalText, 'utf8');
  });

  afterEach(async () => {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  });

  async function expectFileUnchanged(): Promise<void> {
    expect(await fs.readFile(configPath, 'utf8')).toBe(originalText);
  }

  it('rejects a repo naming no configured or new repository', async () => {
    const input: TaskWizardInput = {
      configPath,
      task: buildTask({ id: 'new-task', repo: 'ghost' }),
    };

    const result = await createTask(input, buildTaskDependencies());

    expectFailure(result, 'ConfigValidationError');
    await expectFileUnchanged();
  });

  it('rejects a candidate that violates the schema', async () => {
    const input: TaskWizardInput = { configPath, task: buildTask({ id: 't1' }) };

    const result = await createTask(input, buildTaskDependencies());

    expectFailure(result, 'ConfigValidationError');
    await expectFileUnchanged();
  });

  it('propagates a source materialization failure', async () => {
    const input: TaskWizardInput = { configPath, task: buildTask({ id: 'new-task' }) };
    const dependencies = buildTaskDependencies({
      git: {
        validateSource: async () => ({
          ok: false,
          error: {
            kind: 'SourceMaterializationError',
            taskId: 'substituted',
            reason: 'commit not found',
          },
        }),
      } satisfies Pick<GitWorkspaceAdapter, 'validateSource'>,
    });

    const result = await createTask(input, dependencies);

    expectFailure(result, 'SourceMaterializationError');
    await expectFileUnchanged();
  });

  it('returns CancellationError with no read when already cancelled', async () => {
    const cancellation = new AbortController();
    cancellation.abort();
    const input: TaskWizardInput = { configPath, task: buildTask({ id: 'new-task' }) };

    const result = await createTask(
      input,
      buildTaskDependencies({ cancellation: cancellation.signal }),
    );

    expectFailure(result, 'CancellationError');
    await expectFileUnchanged();
  });

  it('leaves a missing configuration file absent when there is no bootstrap', async () => {
    await fs.rm(configPath);
    const input: TaskWizardInput = { configPath, task: buildTask({ id: 'new-task' }) };

    const result = await createTask(input, buildTaskDependencies());

    expectFailure(result, 'ConfigValidationError');
    await expect(fs.access(configPath)).rejects.toThrow();
  });
});
