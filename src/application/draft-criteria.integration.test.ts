// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createOpenCodeAdapter } from '@/adapters/agents/opencode/opencode';
import { createGitWorkspaceAdapter } from '@/adapters/git';
import {
  createEnvironmentAdapter,
  createRedactor,
  createSecretRedactor,
  runManagedProcess,
} from '@/adapters/process';

import { draftCriteria } from './draft-criteria';

import type { CriteriaDraftDependencies, CriteriaDraftRequest } from './draft-criteria';
import type { ResolvedReferenceSolution } from './reference-solution';
import type { OpenCodeAdapterDependencies } from '@/adapters/agents/opencode/opencode';
import type { TevuConfigInput } from '@/config/schema';
import type {
  AgentAdapter,
  EnvironmentAdapter,
  PullRequestReader,
  RepositoryDefinition,
  SecretRedactor,
  TevuConfig,
  TevuResult,
} from '@/domain/types';

const SECRET_VARIABLE_NAME = 'TEVU_DRAFT_CRITERIA_SECRET';
const SECRET_VALUE = 'sk-live-draft-criteria-secret-445566';
const SESSION_ID = 'ses-draft-1';
const DRAFTED_REPLY = JSON.stringify({
  acceptance: ['The export button appears on the table view.'],
  done: ['The change is documented for users.'],
});
const MALFORMED_REPLY = JSON.stringify({ acceptance: ['The export button appears.'] });

function buildSecretRedactor(secretValues: readonly string[]): SecretRedactor {
  return createSecretRedactor(() => secretValues, createRedactor(secretValues));
}

type RunBehavior = 'ok' | 'error-exit-1' | 'sleep';
type ModelsBehavior =
  | 'fail'
  | 'lists-role-model'
  | 'omits-role-model'
  | 'reports-matching-variant'
  | 'reports-other-variants'
  | 'reports-no-variants'
  | 'sleep';
type ExportBehavior = 'reply' | 'garbage' | 'finish-length' | 'tool-call';

type FakeBehavior = {
  run: RunBehavior;
  models?: ModelsBehavior;
  export?: ExportBehavior;
  replyText: string;
  /** Every `run` and `models` invocation appends its name here, so a test can tell what was started. */
  invocationsPath: string;
};

const PROBE_PREAMBLE = `
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.0-draft-criteria-fake"); process.exit(0); }
if (args[0] === "--help") { console.log("usage: fake-opencode <command> [options]"); process.exit(0); }
if (args[0] === "run" && args[1] === "--help") {
  console.log("usage: opencode run --format json --model <model> --variant <variant>");
  process.exit(0);
}
if (args[0] === "export" && args[1] === "--help") {
  console.log("usage: opencode export <session-id>");
  process.exit(0);
}
if (args[0] === "models" && args[1] === "--help") {
  console.log("usage: opencode models [provider] --verbose");
  process.exit(0);
}
`;

function renderRunSection(behavior: RunBehavior, invocationsPath: string): string {
  const log = `appendFileSync(${JSON.stringify(invocationsPath)}, "run\\n");`;
  if (behavior === 'sleep') {
    return `
if (args[0] === "run") {
  ${log}
  setInterval(function () {}, 1000);
}
`;
  }
  if (behavior === 'error-exit-1') {
    return `
if (args[0] === "run") {
  ${log}
  console.log(JSON.stringify({ type: "error", timestamp: 1, sessionID: "${SESSION_ID}", error: { data: { message: "Synthetic failure" } } }));
  process.exit(1);
}
`;
  }
  return `
if (args[0] === "run") {
  ${log}
  console.log(JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "${SESSION_ID}", part: { id: "prt-0", sessionID: "${SESSION_ID}", messageID: "msg-0", type: "step-start" } }));
  process.exit(0);
}
`;
}

const CRITERIA_MODEL = 'openai/criteria-model';

function listingText(behavior: Exclude<ModelsBehavior, 'fail' | 'sleep'>): string {
  const withVariants = (variants: Record<string, object>): string =>
    [CRITERIA_MODEL, JSON.stringify({ id: 'criteria-model', variants }, null, 2)].join('\n');
  switch (behavior) {
    case 'lists-role-model':
      return CRITERIA_MODEL;
    case 'omits-role-model':
      return 'openai/other-model';
    case 'reports-matching-variant':
      return withVariants({ low: {}, high: {} });
    case 'reports-other-variants':
      return withVariants({ medium: {}, low: {} });
    case 'reports-no-variants':
      return withVariants({});
  }
}

function renderModelsSection(behavior: ModelsBehavior, invocationsPath: string): string {
  if (behavior === 'fail') {
    return '';
  }
  const listing =
    behavior === 'sleep'
      ? 'setInterval(function () {}, 1000); await new Promise(function () {});'
      : `console.log(${JSON.stringify(listingText(behavior))}); process.exit(0);`;
  return `
if (args[0] === "models") {
  appendFileSync(${JSON.stringify(invocationsPath)}, "models\\n");
  if (args[1] !== "--verbose") { process.exit(3); }
  ${listing}
}
`;
}

function renderExportSection(behavior: ExportBehavior, replyText: string): string {
  if (behavior === 'garbage') {
    return `
if (args[0] === "export") {
  console.log("this is not a session export");
  process.exit(0);
}
`;
  }
  if (behavior === 'finish-length' || behavior === 'tool-call') {
    const finish = behavior === 'tool-call' ? 'tool-calls' : 'length';
    const toolPart =
      behavior === 'tool-call'
        ? ', parts: [{ id: "prt-1", sessionID: requested, messageID: "msg-1", type: "tool", callID: "call-1", tool: "read", state: { status: "error" } }]'
        : ', parts: []';
    return `
if (args[0] === "export") {
  var requested = args[1] || "";
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-1", sessionID: requested, role: "assistant", parentID: "msg-0", finish: "${finish}", cost: 0.1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }${toolPart} }] }));
  process.exit(0);
}
`;
  }
  return `
if (args[0] === "export") {
  var requested = args[1] || "";
  console.log(JSON.stringify({ info: { id: requested }, messages: [{ info: { id: "msg-1", sessionID: requested, role: "assistant", parentID: "msg-0", finish: "stop", cost: 0.1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }, parts: [{ id: "prt-1", sessionID: requested, messageID: "msg-1", type: "text", text: ${JSON.stringify(replyText)} }] }] }));
  process.exit(0);
}
`;
}

let tempRoot: string;
let scriptCounter = 0;

function nextScriptName(): string {
  scriptCounter += 1;
  return `fake-opencode-${String(scriptCounter)}.mjs`;
}

async function writeFakeExecutable(behavior: FakeBehavior): Promise<string> {
  const body =
    '#!/usr/bin/env node\nimport { appendFileSync } from "node:fs";\n' +
    PROBE_PREAMBLE +
    renderRunSection(behavior.run, behavior.invocationsPath) +
    renderModelsSection(behavior.models ?? 'fail', behavior.invocationsPath) +
    renderExportSection(behavior.export ?? 'reply', behavior.replyText) +
    '\nif (args[0] !== "run" && args[0] !== "export") { process.exit(3); }\n';
  const filePath = join(tempRoot, nextScriptName());
  await writeFile(filePath, body, { mode: 0o755 });
  await chmod(filePath, 0o755);
  return filePath;
}

const GIT_IDENTITY_FLAGS = ['-c', 'user.name=tevu', '-c', 'user.email=tevu@localhost'];

function runGitSync(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
    encoding: 'utf8',
  }).trim();
}

/** A synthetic repository with a base commit and a second commit that adds `feature.txt`. */
let repositoryCounter = 0;

async function createSyntheticRepository(): Promise<{ path: string; commit: string }> {
  repositoryCounter += 1;
  const path = join(tempRoot, `source-repository-${String(repositoryCounter)}`);
  await mkdir(path, { recursive: true });
  runGitSync(path, ['init', '--quiet', '-b', 'main']);
  await writeFile(join(path, 'README.md'), 'synthetic source\n');
  runGitSync(path, ['add', '-A']);
  runGitSync(path, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'base commit']);
  await writeFile(join(path, 'feature.txt'), 'feature content\n');
  runGitSync(path, ['add', '-A']);
  runGitSync(path, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'add feature']);
  const commit = runGitSync(path, ['rev-parse', 'HEAD']);
  return { path, commit };
}

function buildResolvedCommitReference(commit: string): ResolvedReferenceSolution {
  return { reference: { kind: 'commit', identifier: commit, commits: [commit] } };
}

function buildResolvedPullRequestReference(): ResolvedReferenceSolution {
  return {
    reference: { kind: 'pull-request', identifier: 'octo/app#42', commits: ['a'.repeat(40)] },
    pullRequest: {
      key: 'octo/app#42',
      state: 'open',
      targetBranch: 'main',
    },
  };
}

function buildConfig(overrides: Partial<TevuConfig> = {}): TevuConfig {
  return {
    version: 1,
    run: {
      output_dir: join(tempRoot, 'runs'),
      concurrency: 1,
      repeat: 1,
      timeout: '30s',
      stop_grace: '200ms',
    },
    agents: {
      opencode: {
        command: 'unused-fake-opencode-command',
        secrets: [SECRET_VARIABLE_NAME],
        env: [],
        providers: [],
      },
    },
    repositories: [],
    models: [],
    roles: { criteria: { model: 'openai/criteria-model', effort: 'high', agent: 'opencode' } },
    tasks: [],
    ...overrides,
  };
}

function failingPullRequestReader(): Pick<PullRequestReader, 'readPullRequestDiff'> {
  return {
    readPullRequestDiff: async () => {
      throw new Error('unexpected pull-request diff read for a commit reference');
    },
  };
}

type BuildOptions = {
  run: RunBehavior;
  models?: ModelsBehavior;
  export?: ExportBehavior;
  invocationsPath?: string;
  replyText?: string;
  config?: TevuConfig;
  configuration?: CriteriaDraftRequest['configuration'];
  reference?: ResolvedReferenceSolution;
  prompt?: string;
  repository?: RepositoryDefinition;
  pullRequests?: Pick<PullRequestReader, 'readPullRequestDiff'>;
  redact?: (text: string) => string;
  registerSecrets?: (names: readonly string[]) => void;
  cancellation?: AbortSignal;
  git?: CriteriaDraftDependencies['git'];
  environments?: EnvironmentAdapter;
  wrapAdapter?: (adapter: AgentAdapter) => AgentAdapter;
};

function buildBootstrapAnswers(): Omit<TevuConfigInput, 'version' | 'tasks'> {
  return {
    run: {
      output_dir: join(tempRoot, 'runs'),
      concurrency: 1,
      repeat: 1,
      timeout: '30s',
      stop_grace: '200ms',
    },
    agents: {
      opencode: {
        command: 'unused-fake-opencode-command',
        secrets: [SECRET_VARIABLE_NAME],
        env: [],
      },
    },
    repositories: [],
    models: [],
    roles: { criteria: { model: 'openai/criteria-model', effort: 'high', agent: 'opencode' } },
  };
}

async function draftWithFakeAgent(
  options: BuildOptions,
): Promise<ReturnType<typeof draftCriteria> extends Promise<infer T> ? T : never> {
  const executable = await writeFakeExecutable({
    run: options.run,
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.export === undefined ? {} : { export: options.export }),
    replyText: options.replyText ?? DRAFTED_REPLY,
    invocationsPath: options.invocationsPath ?? join(tempRoot, nextScriptName()),
  });
  const dependencies: OpenCodeAdapterDependencies = {
    runProcess: runManagedProcess,
    secrets: buildSecretRedactor([SECRET_VALUE]),
    probeEnvironment: { PATH: process.env['PATH'] ?? '' },
    probeDirectory: process.cwd(),
    operatorDirectories: { home: undefined, xdgConfigHome: undefined },
  };
  const created: AgentAdapter = createOpenCodeAdapter(
    { agent: 'opencode', executable, providers: [], declaredVariables: { secrets: [], env: [] } },
    dependencies,
  );
  const adapter = options.wrapAdapter?.(created) ?? created;
  const config = options.config ?? buildConfig();
  const repository = options.repository ?? { id: 'repo-1', path: '/unused' };
  const request: CriteriaDraftRequest = {
    configPath: join(tempRoot, 'tevu.yaml'),
    configuration: options.configuration ?? { kind: 'loaded', config },
    repository,
    reference: options.reference ?? buildResolvedCommitReference('f'.repeat(40)),
    prompt: options.prompt ?? 'Implement CSV export for the current view.',
    description: 'Users need to download the table as CSV.',
  };
  const criteriaDependencies: CriteriaDraftDependencies = {
    agentsFor: () => new Map([['opencode', adapter]]),
    environments: options.environments ?? createEnvironmentAdapter(),
    git:
      options.git ??
      createGitWorkspaceAdapter({ workspacesDirectory: join(tempRoot, 'workspaces') }),
    pullRequests: options.pullRequests ?? failingPullRequestReader(),
    managedCloneRoot: undefined,
    registerSecrets: options.registerSecrets ?? (() => undefined),
    redact: options.redact ?? ((text) => text),
    cancellation: options.cancellation ?? new AbortController().signal,
  };
  return draftCriteria(request, criteriaDependencies);
}

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'tevu-draft-criteria-it-'));
  process.env[SECRET_VARIABLE_NAME] = SECRET_VALUE;
});

afterAll(async () => {
  delete process.env[SECRET_VARIABLE_NAME];
  await rm(tempRoot, { recursive: true, force: true });
});

describe('draftCriteria against a fake OpenCode executable and a synthetic repository', () => {
  it('drafts successfully for a commit reference', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      models: 'reports-matching-variant',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'drafted',
      draft: {
        acceptance: ['The export button appears on the table view.'],
        done: ['The change is documented for users.'],
      },
      effort: { status: 'verified' },
      retainedDirectories: [],
    });
  });

  it('drafts successfully from bootstrap answers, resolving the call configuration through resolveBootstrapModelCallConfig', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      models: 'reports-matching-variant',
      configuration: { kind: 'bootstrap', answers: buildBootstrapAnswers() },
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'drafted',
      draft: {
        acceptance: ['The export button appears on the table view.'],
        done: ['The change is documented for users.'],
      },
      effort: { status: 'verified' },
      retainedDirectories: [],
    });
  });

  it('fails as unredactable when redact returns a non-string value', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
      redact: (text) => {
        void text;
        // Simulates a redactor whose implementation misbehaves and returns a
        // non-string value at runtime, despite the type signature.
        return 42 as unknown as string;
      },
    });

    expect(outcome).toEqual({
      status: 'failed',
      failure: { cause: 'prompt-unredactable' },
      retainedDirectories: [],
    });
  });

  it('drafts successfully for a pull-request reference, reading its diff through the fake reader', async () => {
    const readPullRequestDiff = async (): Promise<
      TevuResult<string, 'ReferenceResolutionError' | 'CancellationError'>
    > => ({ ok: true, value: 'diff --git a/x b/x\n+line\n' });

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedPullRequestReference(),
      pullRequests: { readPullRequestDiff },
    });

    expect(outcome.status).toBe('drafted');
  });

  it('fails as unreadable changes when the reference changes cannot be read', async () => {
    const repository = await createSyntheticRepository();
    const rootCommit = runGitSync(repository.path, ['rev-list', '--max-parents=0', 'HEAD']);

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedCommitReference(rootCommit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure).toEqual({ cause: 'changes-unreadable', detail: expect.any(String) });
    expect(outcome.retainedDirectories).toEqual([]);
  });

  it('fails as unredactable when the redactor throws', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
      redact: () => {
        throw new Error('redaction failure');
      },
    });

    expect(outcome).toEqual({
      status: 'failed',
      failure: { cause: 'prompt-unredactable' },
      retainedDirectories: [],
    });
  });

  it('fails as call-failed with the agent message and the call reason when the call fails and no listing settles it', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'error-exit-1',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure).toEqual({
      cause: 'call-failed',
      agentMessage: 'Synthetic failure',
      detail: 'run process exited with code 1: Synthetic failure',
    });
    expect(outcome.retainedDirectories).toEqual([]);
  });

  it('fails as an invalid reply when the reply is malformed', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      replyText: MALFORMED_REPLY,
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'failed',
      failure: { cause: 'reply-invalid', defect: 'done is not an array' },
      retainedDirectories: [],
    });
  });

  it('returns cancelled without calling the model when cancellation is set before the call', async () => {
    const controller = new AbortController();
    controller.abort();

    const outcome = await draftWithFakeAgent({ run: 'ok', cancellation: controller.signal });

    expect(outcome).toEqual({ status: 'cancelled' });
  });

  it('returns cancelled when the pull-request diff read reports cancellation', async () => {
    const readPullRequestDiff = async (): Promise<
      TevuResult<string, 'ReferenceResolutionError' | 'CancellationError'>
    > => ({ ok: false, error: { kind: 'CancellationError', activeCaseIds: [] } });

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedPullRequestReference(),
      pullRequests: { readPullRequestDiff },
    });

    expect(outcome).toEqual({ status: 'cancelled' });
  });

  it('sends the task prompt and description to the model for a pull-request reference', async () => {
    const readPullRequestDiff = async (): Promise<
      TevuResult<string, 'ReferenceResolutionError' | 'CancellationError'>
    > => ({ ok: true, value: 'diff --git a/x b/x\n+line\n' });
    const redacted: string[] = [];

    await draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedPullRequestReference(),
      pullRequests: { readPullRequestDiff },
      prompt: 'SENTINEL-PROMPT',
      redact: (text) => {
        redacted.push(text);
        return text;
      },
    });

    expect(redacted).toHaveLength(1);
    expect(redacted[0]).toContain('\nTask instructions:\nSENTINEL-PROMPT\n');
    expect(redacted[0]).toContain(
      '\nTask description:\nUsers need to download the table as CSV.\n',
    );
  });

  it('runs registerSecrets before redact', async () => {
    const repository = await createSyntheticRepository();
    const order: string[] = [];

    await draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
      registerSecrets: () => order.push('registerSecrets'),
      redact: (text) => {
        order.push('redact');
        return text;
      },
    });

    expect(order).toEqual(['registerSecrets', 'redact']);
  });
});

describe('draftCriteria failure causes against a fake OpenCode executable', () => {
  const UNSET_VARIABLE = 'TEVU_DRAFT_CRITERIA_UNSET_A';
  const OTHER_UNSET_VARIABLE = 'TEVU_DRAFT_CRITERIA_UNSET_B';

  function buildConfigWithVariables(secrets: string[], env: string[] = []): TevuConfig {
    const config = buildConfig();
    return { ...config, agents: { opencode: { ...config.agents.opencode, secrets, env } } };
  }

  async function readInvocations(path: string): Promise<string[]> {
    return existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
      : [];
  }

  async function waitForInvocation(path: string, name: string): Promise<void> {
    while (!(await readInvocations(path)).includes(name)) {
      await delay(20);
    }
  }

  it('fails as model-unavailable before any call when the agent does not list the criteria model', async () => {
    const repository = await createSyntheticRepository();
    const invocationsPath = join(tempRoot, nextScriptName());

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      models: 'omits-role-model',
      invocationsPath,
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'failed',
      failure: { cause: 'model-unavailable', model: 'openai/criteria-model' },
      retainedDirectories: [],
    });
    expect(await readInvocations(invocationsPath)).toEqual(['models']);
  });

  it("fails as call-failed with the agent's own message when the call fails and the agent lists the model", async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'error-exit-1',
      models: 'lists-role-model',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'failed',
      failure: {
        cause: 'call-failed',
        agentMessage: 'Synthetic failure',
        detail: 'run process exited with code 1: Synthetic failure',
      },
      retainedDirectories: [],
    });
  });

  it('fails as call-failed without an agent message when the failure is not a failed run', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      export: 'garbage',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure).toEqual({
      cause: 'call-failed',
      detail: expect.stringMatching(/^AgentProtocolError: /),
    });
  });

  it.each([
    {
      name: 'a non-stop finish',
      behavior: 'finish-length' as const,
      detail: 'final assistant message finished with "length"',
    },
    {
      name: 'a session that called a tool',
      behavior: 'tool-call' as const,
      detail: 'the session called the tool "read" although every tool is denied to a model call',
    },
  ])('carries the reason of the call as the detail for $name', async ({ behavior, detail }) => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      export: behavior,
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'failed',
      failure: { cause: 'call-failed', detail },
      retainedDirectories: [],
    });
  });

  it('fails as variables-unset naming each unset declared variable, with no read and no call', async () => {
    const invocationsPath = join(tempRoot, nextScriptName());
    const git = createGitWorkspaceAdapter({ workspacesDirectory: join(tempRoot, 'workspaces') });
    const diffCommit = vi.spyOn(git, 'diffCommit');

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      invocationsPath,
      git,
      config: buildConfigWithVariables(
        [UNSET_VARIABLE, SECRET_VARIABLE_NAME],
        [OTHER_UNSET_VARIABLE],
      ),
    });

    expect(outcome).toEqual({
      status: 'failed',
      failure: { cause: 'variables-unset', names: [UNSET_VARIABLE, OTHER_UNSET_VARIABLE] },
      retainedDirectories: [],
    });
    expect(diffCommit).not.toHaveBeenCalled();
    expect(await readInvocations(invocationsPath)).toEqual([]);
  });

  it('fails as variables-unset for bootstrap answers that declare an unset variable', async () => {
    const answers = buildBootstrapAnswers();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      configuration: {
        kind: 'bootstrap',
        answers: {
          ...answers,
          agents: {
            opencode: {
              command: 'unused-fake-opencode-command',
              secrets: [UNSET_VARIABLE],
              env: [],
            },
          },
        },
      },
    });

    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { cause: 'variables-unset', names: [UNSET_VARIABLE] },
    });
  });

  it('fails as timed-out with the configured run limit when the model does not answer in time', async () => {
    const repository = await createSyntheticRepository();
    const config = buildConfig();

    const outcome = await draftWithFakeAgent({
      run: 'sleep',
      config: { ...config, run: { ...config.run, timeout: '400ms' } },
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'failed',
      failure: { cause: 'timed-out', limit: '400ms' },
      retainedDirectories: [],
    });
  });

  it('is cancelled before any call when the signal aborts during the model listing', async () => {
    const repository = await createSyntheticRepository();
    const invocationsPath = join(tempRoot, nextScriptName());
    const controller = new AbortController();

    const pending = draftWithFakeAgent({
      run: 'ok',
      models: 'sleep',
      invocationsPath,
      cancellation: controller.signal,
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });
    await waitForInvocation(invocationsPath, 'models');
    controller.abort();

    expect(await pending).toEqual({ status: 'cancelled' });
    expect(await readInvocations(invocationsPath)).toEqual(['models']);
  });
});

describe('draftCriteria effort check against a fake OpenCode executable', () => {
  function readInvocationLog(path: string): string[] {
    return existsSync(path)
      ? readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => line.length > 0)
      : [];
  }

  async function draft(options: Partial<BuildOptions> & { invocationsPath?: string }) {
    const repository = await createSyntheticRepository();
    return draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
      ...options,
    });
  }

  /** Wraps the environment adapter so every disposal fails, and records each root it created in order. */
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

  it('fails as effort-unsupported before any call when the reported variants exclude the effort', async () => {
    const invocationsPath = join(tempRoot, nextScriptName());

    const outcome = await draft({ models: 'reports-other-variants', invocationsPath });

    expect(outcome).toEqual({
      status: 'failed',
      failure: {
        cause: 'effort-unsupported',
        model: 'openai/criteria-model',
        effort: 'high',
        variants: ['low', 'medium'],
      },
      retainedDirectories: [],
    });
    expect(readInvocationLog(invocationsPath)).toEqual(['models']);
  });

  it('drafts with an unverified check when the listing carries no variant data for the model', async () => {
    const outcome = await draft({ models: 'lists-role-model' });

    expect(outcome).toMatchObject({
      status: 'drafted',
      effort: {
        status: 'unverified',
        reason: expect.stringContaining(
          'reports no variant data for "openai/criteria-model", so effort "high" is used as requested without verification',
        ) as string,
      },
    });
  });

  it('drafts with an unsupported check when the model reports no variants at all', async () => {
    const outcome = await draft({ models: 'reports-no-variants' });

    expect(outcome).toMatchObject({
      status: 'drafted',
      effort: {
        status: 'unsupported',
        reason: expect.stringContaining(
          'reports no variants for "openai/criteria-model", so effort "high" selects none, so a criteria call runs "openai/criteria-model" with its default options',
        ) as string,
      },
    });
  });

  it('drafts with an unverified check when the model listing failed', async () => {
    const outcome = await draft({});

    expect(outcome).toMatchObject({
      status: 'drafted',
      effort: {
        status: 'unverified',
        reason:
          'the variants of "openai/criteria-model" were not read because agent "opencode" produced no model listing',
      },
      retainedDirectories: [],
    });
  });

  it('drafts with an unverified check when the provider snapshot was rejected for the listing', async () => {
    let reads = 0;

    const outcome = await draft({
      models: 'reports-matching-variant',
      wrapAdapter: (adapter) => ({
        ...adapter,
        readProviders: async () => {
          reads += 1;
          return reads === 1
            ? {
                ok: false,
                error: {
                  kind: 'ConfigValidationError',
                  findings: [
                    {
                      severity: 'error',
                      identifier: 'agents.opencode.providers.acme',
                      message: 'rejected',
                    },
                  ],
                },
              }
            : adapter.readProviders();
        },
      }),
    });

    expect(outcome).toMatchObject({
      status: 'drafted',
      effort: {
        status: 'unverified',
        reason: expect.stringContaining('produced no model listing'),
      },
    });
  });

  it('keeps the call-failed text unchanged for a failed call after a listing without variant data', async () => {
    const outcome = await draft({ run: 'error-exit-1', models: 'lists-role-model' });

    expect(outcome).toEqual({
      status: 'failed',
      failure: {
        cause: 'call-failed',
        agentMessage: 'Synthetic failure',
        detail: 'run process exited with code 1: Synthetic failure',
      },
      retainedDirectories: [],
    });
  });

  it('lists the retained directory of the listing, then of the call, on a drafted outcome', async () => {
    const { environments, roots } = buildRetainingEnvironments();

    const outcome = await draft({ models: 'reports-matching-variant', environments });

    expect(roots).toHaveLength(2);
    expect(outcome).toMatchObject({ status: 'drafted', retainedDirectories: roots });
  });

  it('lists the retained directory of the listing, then of the call, when the reply is invalid', async () => {
    const { environments, roots } = buildRetainingEnvironments();

    const outcome = await draft({
      models: 'reports-matching-variant',
      replyText: MALFORMED_REPLY,
      environments,
    });

    expect(roots).toHaveLength(2);
    expect(outcome).toMatchObject({ status: 'failed', retainedDirectories: roots });
  });

  it('carries the retained directory of the listing on a failure before the call', async () => {
    const { environments, roots } = buildRetainingEnvironments();

    const outcome = await draft({
      models: 'reports-matching-variant',
      environments,
      redact: () => {
        throw new Error('redaction failure');
      },
    });

    expect(roots).toHaveLength(1);
    expect(outcome).toEqual({
      status: 'failed',
      failure: { cause: 'prompt-unredactable' },
      retainedDirectories: roots,
    });
  });

  it.each([
    { name: 'effort-unsupported', models: 'reports-other-variants' as const },
    { name: 'model-unavailable', models: 'omits-role-model' as const },
  ])('carries the retained directory of the listing on $name', async ({ models }) => {
    const { environments, roots } = buildRetainingEnvironments();

    const outcome = await draft({ models, environments });

    expect(roots).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'failed', retainedDirectories: roots });
  });

  it('carries the retained directory of the listing when the call times out', async () => {
    const { environments, roots } = buildRetainingEnvironments();
    const config = buildConfig();

    const outcome = await draft({
      run: 'sleep',
      models: 'reports-matching-variant',
      environments,
      config: { ...config, run: { ...config.run, timeout: '400ms' } },
    });

    expect(roots).toHaveLength(2);
    expect(outcome).toMatchObject({
      status: 'failed',
      failure: { cause: 'timed-out' },
      retainedDirectories: [roots[0]],
    });
  });
});
