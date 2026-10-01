// @vitest-environment node
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createConfigStore } from '@/adapters/artifact-store';
import { createTask } from '@/application/create-task';

import { appendToConfigText, renderConfigDocument } from './document';
import { parseConfigText, resolveConfig } from './load';

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

  it('writes {id, path} for a path repository entry', () => {
    const rendered = renderConfigDocument(buildConfig({ repositories: [buildRepository()] }), {
      redact: (text) => text,
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('repositories:\n  - id: app\n    path: ../app\n');
  });

  it('writes {id, github} for a GitHub repository entry, omitting path', () => {
    const config = buildConfig({
      repositories: [{ id: 'upstream', github: 'octo/app' }],
    });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('repositories:\n  - id: upstream\n    github: octo/app\n');
    expect(rendered.value).not.toContain('path: github.com');
  });

  it('redacts a GitHub repository entry before it becomes YAML', () => {
    const config = buildConfig({ repositories: [{ id: 'upstream', github: 'SECRET_REPO' }] });
    const redact = (text: string): string => text.replaceAll('SECRET_REPO', '[REDACTED]');

    const rendered = renderConfigDocument(config, { redact });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('github: "[REDACTED]"');
    expect(rendered.value).not.toContain('SECRET_REPO');
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

  it('renders and reloads a commit reference unchanged, with the hash double-quoted', () => {
    const config = buildConfig({
      tasks: [
        buildTask({
          reference: {
            kind: 'commit',
            identifier: 'HEAD~3',
            commits: ['0123456789abcdef0123456789abcdef01234567'],
          },
        }),
      ],
    });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain(
      'commits:\n        - "0123456789abcdef0123456789abcdef01234567"',
    );

    const reparsed = parseConfigText(rendered.value);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.tasks[0]?.reference).toEqual({
      kind: 'commit',
      identifier: 'HEAD~3',
      commits: ['0123456789abcdef0123456789abcdef01234567'],
    });
  });

  it('renders and reloads a pull-request reference unchanged, including a merge commit', () => {
    const reference = {
      kind: 'pull-request' as const,
      identifier: 'octo/app#128',
      commits: [
        '0123456789abcdef0123456789abcdef01234567',
        'fedcba9876543210fedcba9876543210fedcba98',
      ],
      merge_commit: '1111111111111111111111111111111111111111',
    };
    const config = buildConfig({ tasks: [buildTask({ reference })] });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('merge_commit: "1111111111111111111111111111111111111111"');

    const reparsed = parseConfigText(rendered.value);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.tasks[0]?.reference).toEqual(reference);
  });

  it('redacts the reference identifier before it becomes YAML', () => {
    const config = buildConfig({
      tasks: [
        buildTask({
          reference: {
            kind: 'commit',
            identifier: 'secret-token-branch',
            commits: ['0123456789abcdef0123456789abcdef01234567'],
          },
        }),
      ],
    });
    const redact = (text: string): string => text.replaceAll('secret-token', '[REDACTED]');

    const rendered = renderConfigDocument(config, { redact });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).not.toContain('secret-token');

    const reparsed = parseConfigText(rendered.value);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.tasks[0]?.reference).toMatchObject({ identifier: '[REDACTED]-branch' });
  });

  it('returns an ArtifactError when redaction returns a non-string value', () => {
    const redact = (): string => 42 as unknown as string;

    const rendered = renderConfigDocument(buildConfig(), { redact });

    const error = expectFailure(rendered, 'ArtifactError');
    expect(error.operation).toBe('render-configuration');
    expect(error.reason).toBe('redaction returned no text while rendering the configuration');
  });
});

describe('renderConfigDocument with agent providers', () => {
  function buildAgentWithProviders(
    overrides: Partial<TevuConfigInput['agents']['opencode']> = {},
  ): TevuConfigInput {
    return buildConfig({
      agents: {
        opencode: {
          command: 'opencode',
          secrets: ['LITELLM_API_KEY', 'LITELLM_BASE'],
          env: [],
          providers: [{ id: 'litellm', api_key: 'LITELLM_API_KEY' }, { id: 'acme' }],
          ...overrides,
        },
      },
    });
  }

  it('renders output that parses and resolves with the providers and secrets intact', async () => {
    const rendered = renderConfigDocument(buildAgentWithProviders(), { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const parsed = parseConfigText(rendered.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const resolved = await resolveConfig(parsed.value, join(tmpdir(), 'tevu.yaml'), undefined);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.agents.opencode).toMatchObject({
      secrets: ['LITELLM_API_KEY', 'LITELLM_BASE'],
      providers: [{ id: 'litellm', api_key: 'LITELLM_API_KEY' }, { id: 'acme' }],
    });
  });

  it('renders the providers after env with id before api_key', () => {
    const config = buildAgentWithProviders({ env: ['NODE_ENV'] });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain(
      'env:\n      - NODE_ENV\n' +
        '    providers:\n' +
        '      - id: litellm\n' +
        '        api_key: LITELLM_API_KEY\n' +
        '      - id: acme\n',
    );
  });

  it.each([
    { name: 'an empty list', providers: [] },
    { name: 'an absent list', providers: undefined },
  ])('omits the providers key for $name', ({ providers }) => {
    const config = buildConfig({
      agents: {
        opencode: {
          command: 'opencode',
          secrets: [],
          env: [],
          ...(providers === undefined ? {} : { providers }),
        },
      },
    });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).not.toContain('providers');
  });

  it('rejects a provider api_key that is absent from secrets when the text is parsed', () => {
    const config = buildAgentWithProviders({ secrets: ['LITELLM_BASE'] });
    const rendered = renderConfigDocument(config, { redact: (text) => text });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;

    const parsed = parseConfigText(rendered.value);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatchObject({
      kind: 'ConfigValidationError',
      findings: [
        {
          severity: 'error',
          message: 'api_key "LITELLM_API_KEY" must be listed in agents.opencode.secrets',
        },
      ],
    });
  });

  it('redacts a secret value in a provider id and api_key before it becomes YAML', () => {
    const config = buildAgentWithProviders({
      providers: [{ id: 'SECRET_ID', api_key: 'LITELLM_API_KEY' }],
    });
    const redact = (text: string): string => text.replaceAll('SECRET_ID', '[REDACTED]');

    const rendered = renderConfigDocument(config, { redact });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).not.toContain('SECRET_ID');
    expect(rendered.value).toContain('[REDACTED]');
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
            message: 'task add appends only to a block-style list; rewrite tasks in block style',
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
              'task add appends only to a block-style list; rewrite repositories in block style',
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
          rootEntries: [],
        },
      }),
      resolveCommit: async () => ({ kind: 'not-found' }),
    } satisfies Pick<GitWorkspaceAdapter, 'validateSource' | 'resolveCommit'>,
    registerSecrets: () => undefined,
    redact: (text) => text,
    managedCloneRoot: undefined,
    ...overrides,
  };
}

describe('a command check with a string run', () => {
  const TRICKY_COMMANDS = [
    'npm test -- --run',
    'echo "a: #b" && npm test',
    "FOO=$KEY_A npm test -- --run && echo 'x: y'",
    '  padded with spaces  ',
    '[npm, test]',
    '{ a: b }',
    '- not a list item',
    'true',
    '42',
  ];

  function checksWithRun(run: string): TaskInput['checks'] {
    return {
      acceptance: [buildCommandCheck({ id: 'a1', run })],
      done: [buildCommandCheck({ id: 'd1', run: ['npm', 'test'] })],
    };
  }

  it.each(TRICKY_COMMANDS)('renders %j as text that loads back to the same string', (run) => {
    const config = buildConfig({ tasks: [buildTask({ checks: checksWithRun(run) })] });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const reparsed = parseConfigText(rendered.value);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.tasks[0]?.checks.acceptance[0]).toMatchObject({ run });
  });

  it('keeps an array run in flow style beside a string run', () => {
    const config = buildConfig({
      tasks: [buildTask({ checks: checksWithRun('npm test -- --run') })],
    });

    const rendered = renderConfigDocument(config, { redact: (text) => text });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).toContain('run: npm test -- --run\n');
    expect(rendered.value).toContain('run: [npm, test]');
  });

  it.each(TRICKY_COMMANDS)('appends %j so it loads back to the same string', (run) => {
    const base = renderConfigDocument(buildConfig(), { redact: (text) => text });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const task = buildTask({ id: 'added', checks: checksWithRun(run) });

    const appended = appendToConfigText(base.value, { task }, { redact: (text) => text });

    expect(appended.ok).toBe(true);
    if (!appended.ok) return;
    const reparsed = parseConfigText(appended.value);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.tasks[1]?.checks.acceptance[0]).toMatchObject({ run });
  });

  it('redacts a secret value inside the string as it redacts an array token', () => {
    const redact = (text: string): string => text.replaceAll('SECRET_VALUE', '[REDACTED]');
    const config = buildConfig({
      tasks: [buildTask({ checks: checksWithRun('curl -H "token: SECRET_VALUE" host') })],
    });

    const rendered = renderConfigDocument(config, { redact });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value).not.toContain('SECRET_VALUE');
    expect(rendered.value).toContain('[REDACTED]');
  });
});

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
        resolveCommit: async () => ({ kind: 'not-found' }),
      } satisfies Pick<GitWorkspaceAdapter, 'validateSource' | 'resolveCommit'>,
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
