// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

type RunBehavior = 'ok' | 'error-exit-1';

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
`;

function renderRunSection(behavior: RunBehavior): string {
  if (behavior === 'error-exit-1') {
    return `
if (args[0] === "run") {
  console.log(JSON.stringify({ type: "error", timestamp: 1, sessionID: "${SESSION_ID}", error: { data: { message: "Synthetic failure" } } }));
  process.exit(1);
}
`;
  }
  return `
if (args[0] === "run") {
  console.log(JSON.stringify({ type: "step_start", timestamp: 1, sessionID: "${SESSION_ID}", part: { id: "prt-0", sessionID: "${SESSION_ID}", messageID: "msg-0", type: "step-start" } }));
  process.exit(0);
}
`;
}

function renderExportSection(replyText: string): string {
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

async function writeFakeExecutable(run: RunBehavior, replyText: string): Promise<string> {
  const body =
    '#!/usr/bin/env node\n' +
    PROBE_PREAMBLE +
    renderRunSection(run) +
    renderExportSection(replyText) +
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
      title: 'Add export button',
      body: 'Implements CSV export for the current view.',
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
  replyText?: string;
  config?: TevuConfig;
  configuration?: CriteriaDraftRequest['configuration'];
  reference?: ResolvedReferenceSolution;
  repository?: RepositoryDefinition;
  pullRequests?: Pick<PullRequestReader, 'readPullRequestDiff'>;
  redact?: (text: string) => string;
  registerSecrets?: (names: readonly string[]) => void;
  cancellation?: AbortSignal;
  git?: CriteriaDraftDependencies['git'];
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
  const executable = await writeFakeExecutable(options.run, options.replyText ?? DRAFTED_REPLY);
  const dependencies: OpenCodeAdapterDependencies = {
    runProcess: runManagedProcess,
    secrets: buildSecretRedactor([SECRET_VALUE]),
    probeEnvironment: { PATH: process.env['PATH'] ?? '' },
    probeDirectory: process.cwd(),
  };
  const adapter: AgentAdapter = createOpenCodeAdapter(
    { agent: 'opencode', executable },
    dependencies,
  );
  const config = options.config ?? buildConfig();
  const repository = options.repository ?? { id: 'repo-1', path: '/unused' };
  const request: CriteriaDraftRequest = {
    configPath: join(tempRoot, 'tevu.yaml'),
    configuration: options.configuration ?? { kind: 'loaded', config },
    repository,
    reference: options.reference ?? buildResolvedCommitReference('f'.repeat(40)),
    description: 'Users need to download the table as CSV.',
  };
  const criteriaDependencies: CriteriaDraftDependencies = {
    agentsFor: () => new Map([['opencode', adapter]]),
    environments: createEnvironmentAdapter(),
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
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'drafted',
      draft: {
        acceptance: ['The export button appears on the table view.'],
        done: ['The change is documented for users.'],
      },
      retainedDirectory: null,
    });
  });

  it('drafts successfully from bootstrap answers, resolving the call configuration through resolveBootstrapModelCallConfig', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
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
      retainedDirectory: null,
    });
  });

  it('yields F3 when redact returns a non-string value', async () => {
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
      reason: 'the criteria prompt could not be redacted; the criteria model was not called',
      retainedDirectory: null,
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

  it('yields F1 when the reference changes cannot be read', async () => {
    const repository = await createSyntheticRepository();
    const rootCommit = runGitSync(repository.path, ['rev-list', '--max-parents=0', 'HEAD']);

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      reference: buildResolvedCommitReference(rootCommit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.reason).toMatch(/^the reference solution's changes cannot be read: /);
    expect(outcome.retainedDirectory).toBeNull();
  });

  it('yields F3 when the prompt could not be redacted', async () => {
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
      reason: 'the criteria prompt could not be redacted; the criteria model was not called',
      retainedDirectory: null,
    });
  });

  it('yields F4 whose reason carries the ModelCallError reason when the call fails', async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'error-exit-1',
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.reason).toBe(
      'the criteria call failed: ModelCallError (failed): run process exited with code 1: Synthetic failure',
    );
    expect(outcome.retainedDirectory).toBeNull();
  });

  it("yields F5 with the call's retained directory when the reply is malformed", async () => {
    const repository = await createSyntheticRepository();

    const outcome = await draftWithFakeAgent({
      run: 'ok',
      replyText: MALFORMED_REPLY,
      reference: buildResolvedCommitReference(repository.commit),
      repository: { id: 'repo-1', path: repository.path },
    });

    expect(outcome).toEqual({
      status: 'failed',
      reason: 'the criteria reply is not valid: done is not an array',
      retainedDirectory: null,
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

  it('runs registerSecrets before redact (P9)', async () => {
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
