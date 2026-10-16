// @vitest-environment node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import {
  buildJiraTrackerSettings,
  buildParentEnvironmentSnapshot,
} from '@/__fixtures__/host.fixtures';
import { createSyntheticRepository } from '@/adapters/__fixtures__/git.fixtures';
import { TevuConfigSchema } from '@/config/schema';
import { GH_CREDENTIAL_ENVIRONMENT_VARIABLES } from '@/domain/github-cli';
import { runProgram } from '@/interface/program';

import { composeProgramDependencies, createHostEnvironment, ignoreClosedReader } from './index';

import type { AgentDraft } from '@/application/model-access';
import type { TevuConfigInput } from '@/config/schema';
import type { TevuConfig } from '@/domain/config';
import type { BenchmarkPlan } from '@/domain/use-cases';
import type { RunOperations } from '@/interface/commands/run';

type TevuTaskInput = NonNullable<TevuConfigInput['tasks']>[number];

function writeError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`write ${code}`), { code, syscall: 'write' });
}

/** A stdout whose reader has gone away, like the pipe `tevu --help | head -2` leaves behind. */
function closedPipe(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback(writeError('EPIPE'));
    },
  });
}

/** Plans a run with the effort checks of the validation `tevu run` performs first. */
async function planThroughValidation(
  operations: Pick<RunOperations, 'validateConfig' | 'planBenchmark'>,
  config: TevuConfig,
  configPath: string,
): Promise<BenchmarkPlan> {
  const validation = await operations.validateConfig(config);
  if (!validation.ok) {
    throw new Error(`validation failed: ${JSON.stringify(validation.error)}`);
  }
  return operations.planBenchmark(config, configPath, validation.value.efforts);
}

function capture(): { stream: Writable; text: () => string } {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

describe('closed output reader', () => {
  it('finishes a command quietly when stdout fails with EPIPE', async () => {
    const stdout = closedPipe();
    const stderr = capture();
    ignoreClosedReader(stdout);
    const dependencies = composeProgramDependencies({
      io: { stdin: Readable.from([]), stdout, stderr: stderr.stream },
    });

    const code = await runProgram(['--help'], dependencies);
    await setImmediate();

    expect(code).toBe(0);
    expect(stdout.destroyed).toBe(true);
    expect(stderr.text()).toBe('');
  });

  it('rethrows a write error other than EPIPE', () => {
    const stdout = capture().stream;
    ignoreClosedReader(stdout);

    expect(() => stdout.emit('error', writeError('ENOSPC'))).toThrow('write ENOSPC');
  });
});

type Host = ReturnType<typeof createHostEnvironment>;

describe('createHostEnvironment', () => {
  const TOKEN = 'synthetic-host-token-value';

  it('lists and masks the value secret returns', () => {
    const host = createHostEnvironment({ SYNTHETIC_TOKEN: TOKEN });

    const value = host.secret('SYNTHETIC_TOKEN');

    expect(value).toBe(TOKEN);
    expect(host.secretValues()).toEqual([TOKEN]);
    expect(host.redact(`Authorization: ${TOKEN}`)).toBe('Authorization: [REDACTED]');
  });

  it('registers every non-empty member of a snapshot and skips the empty ones', () => {
    const host = createHostEnvironment({});

    host.registerSnapshotSecrets(
      buildParentEnvironmentSnapshot({
        secretValues: ['synthetic-first-value', '', 'synthetic-second-value'],
      }),
    );

    expect(host.secretValues()).toEqual(['synthetic-first-value', 'synthetic-second-value']);
    expect(host.redact('synthetic-first-value and synthetic-second-value')).toBe(
      '[REDACTED] and [REDACTED]',
    );
  });

  it('lists a value once however many times and ways it is registered', () => {
    const host = createHostEnvironment({ FIRST: TOKEN, SECOND: TOKEN });

    host.secret('FIRST');
    host.secret('SECOND');
    host.secret('FIRST');
    host.registerSnapshotSecrets(buildParentEnvironmentSnapshot({ secretValues: [TOKEN, TOKEN] }));

    expect(host.secretValues()).toEqual([TOKEN]);
  });

  it.each(GH_CREDENTIAL_ENVIRONMENT_VARIABLES)('registers %s at creation', (name) => {
    const host = createHostEnvironment({ [name]: TOKEN });

    expect(host.secretValues()).toEqual([TOKEN]);
    expect(host.redact(TOKEN)).toBe('[REDACTED]');
  });

  it.each([
    {
      label: 'secret of an unset variable',
      read: (host: Host) => host.secret('MISSING'),
    },
    {
      label: 'secret of an empty variable',
      read: (host: Host) => host.secret('EMPTY'),
    },
    {
      label: 'ordinary of a set variable',
      read: (host: Host) => host.ordinary('PLAIN'),
    },
    {
      label: 'ordinary of an unset variable',
      read: (host: Host) => host.ordinary('MISSING'),
    },
  ])('leaves the registered values unchanged after $label', ({ read }) => {
    const host = createHostEnvironment({ PLAIN: 'synthetic-plain-value', EMPTY: '' });

    read(host);

    expect(host.secretValues()).toEqual([]);
    expect(host.redact('synthetic-plain-value')).toBe('synthetic-plain-value');
  });

  it('returns the same values from ordinary and secret as the variables hold', () => {
    const host = createHostEnvironment({ PLAIN: 'synthetic-plain-value', EMPTY: '' });

    expect(host.ordinary('PLAIN')).toBe('synthetic-plain-value');
    expect(host.secret('EMPTY')).toBe('');
    expect(host.secret('MISSING')).toBeUndefined();
  });

  it('ignores writes to the source map after creation', () => {
    const source: Record<string, string | undefined> = {
      KEPT: 'synthetic-kept-value',
      CHANGED: 'synthetic-original-value',
      REMOVED: 'synthetic-removed-value',
    };
    const host = createHostEnvironment(source);

    source['CHANGED'] = 'synthetic-changed-value';
    source['ADDED'] = 'synthetic-added-value';
    delete source['REMOVED'];

    expect(host.secret('CHANGED')).toBe('synthetic-original-value');
    expect(host.secret('ADDED')).toBeUndefined();
    expect(host.ordinary('REMOVED')).toBe('synthetic-removed-value');
    expect(host.parentEnvironment).toEqual({
      KEPT: 'synthetic-kept-value',
      CHANGED: 'synthetic-original-value',
      REMOVED: 'synthetic-removed-value',
    });
    expect(host.secretValues()).toEqual(['synthetic-original-value']);
  });

  it('works when every method is called detached from the host', () => {
    const host = createHostEnvironment({ SYNTHETIC_TOKEN: TOKEN, PLAIN: 'synthetic-plain-value' });
    const { secret, ordinary, registerSnapshotSecrets, secretValues, redact } = host;

    const secretResult = secret('SYNTHETIC_TOKEN');
    const ordinaryResult = ordinary('PLAIN');
    registerSnapshotSecrets(
      buildParentEnvironmentSnapshot({ secretValues: ['synthetic-snapshot-value'] }),
    );

    expect(secretResult).toBe(TOKEN);
    expect(ordinaryResult).toBe('synthetic-plain-value');
    expect(secretValues()).toEqual([TOKEN, 'synthetic-snapshot-value']);
    expect(redact(`${TOKEN} synthetic-snapshot-value`)).toBe('[REDACTED] [REDACTED]');
  });

  it('masks a value registered after redact was taken', () => {
    const host = createHostEnvironment({ SYNTHETIC_TOKEN: TOKEN });
    const { redact } = host;

    host.secret('SYNTHETIC_TOKEN');

    expect(redact(TOKEN)).toBe('[REDACTED]');
  });
});

describe('composeProgramDependencies credential registration', () => {
  const EMAIL_VARIABLE = 'TEVU_TEST_JIRA_EMAIL';
  const TOKEN_VARIABLE = 'TEVU_TEST_JIRA_TOKEN';
  const EMAIL = 'synthetic.user@example.test';
  const TOKEN = 'synthetic-jira-token-value';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each(GH_CREDENTIAL_ENVIRONMENT_VARIABLES)(
    'redacts the value of %s before any operations factory runs',
    (name) => {
      vi.stubEnv(name, 'synthetic-gh-credential-value');

      const dependencies = composeProgramDependencies();

      expect(dependencies.redact('token synthetic-gh-credential-value')).toBe('token [REDACTED]');
    },
  );

  it('registers the Jira token and sends no request when the email variable is unset', async () => {
    vi.stubEnv(EMAIL_VARIABLE, undefined);
    vi.stubEnv(TOKEN_VARIABLE, TOKEN);
    const fetchStub = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchStub);
    const dependencies = composeProgramDependencies();

    const outcome = await dependencies.commands
      .taskAdd()
      .importJiraIssue(buildJiraTrackerSettings(), 'ABC-1');

    expect(outcome).toMatchObject({ ok: false, error: { kind: 'IssueImportError' } });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(dependencies.redact(`token ${TOKEN}`)).toBe('token [REDACTED]');
  });

  it('leaves the Jira email unredacted after the import reads it', async () => {
    vi.stubEnv(EMAIL_VARIABLE, EMAIL);
    vi.stubEnv(TOKEN_VARIABLE, TOKEN);
    const fetchStub = vi.fn<typeof fetch>(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchStub);
    const dependencies = composeProgramDependencies();

    await dependencies.commands.taskAdd().importJiraIssue(buildJiraTrackerSettings(), 'ABC-1');

    expect(fetchStub).toHaveBeenCalledOnce();
    expect(dependencies.redact(`${EMAIL} ${TOKEN}`)).toBe(`${EMAIL} [REDACTED]`);
  });
});

async function createReadmeRepository(directory: string): Promise<string> {
  return createSyntheticRepository(directory, { 'README.md': 'synthetic\n' }, { message: 'base' });
}

/** What the fake's `debug config` prints: the permission it received, as OpenCode resolves it. */
const DEBUG_CONFIG_DOCUMENT_SOURCE =
  'permission === undefined ? {} : { permission: JSON.parse(permission) }';

const FAKE_OPENCODE_SCRIPT = readFileSync(
  join(import.meta.dirname, '__fixtures__', 'fake-opencode.mjs'),
  'utf8',
);

const LATE_EXPORT_SESSION_BYTES = 1_000_000;

/**
 * One user message padded past a pipe buffer and one assistant message carrying
 * the metrics the tests assert. Reads `sessionID` from the enclosing script.
 */
const EXPORT_DOCUMENT_SOURCE = `
const doc = {
  info: { id: sessionID },
  messages: [
    {
      info: { id: 'msg-u1', sessionID, role: 'user' },
      parts: [{ id: 'prt-u1', sessionID, messageID: 'msg-u1', type: 'text', text: 'x'.repeat(${String(LATE_EXPORT_SESSION_BYTES)}) }],
    },
    {
      info: {
        id: 'msg-a1', sessionID, role: 'assistant', parentID: 'msg-u1', finish: 'stop', cost: 0.0125,
        tokens: { input: 1200, output: 450, reasoning: 16, cache: { read: 30, write: 10 } },
      },
      parts: [],
    },
  ],
};
`;

const LATE_EXPORT_WRITER_SCRIPT = `
const sessionID = process.argv[1];
${EXPORT_DOCUMENT_SOURCE}
setTimeout(() => process.stdout.write(JSON.stringify(doc)), 200);
`;

/**
 * The fake agent with an `export` that hands the document to a descendant
 * sharing its stdout and exits at once, so the document arrives after the
 * direct child is gone.
 */
const LATE_EXPORT_OPENCODE_SCRIPT = FAKE_OPENCODE_SCRIPT.replace(
  "if (args[0] === 'export') {\n",
  () =>
    "if (args[0] === 'export') {\n" +
    "  const { spawn } = await import('node:child_process');\n" +
    `  spawn(process.execPath, ['-e', ${JSON.stringify(LATE_EXPORT_WRITER_SCRIPT)}, args[1] ?? ''], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();\n` +
    '  process.exit(0);\n',
);

/**
 * The fake agent running under Bun, whose `export` writes the whole document in
 * one call and exits in the next statement, as OpenCode does. The interpreter
 * is named by absolute path because a case has its own `HOME`, where a
 * version-manager shim may not resolve.
 */
function buildBunExportOpencodeScript(bunExecutable: string): string {
  return FAKE_OPENCODE_SCRIPT.replace(
    '#!/usr/bin/env node\n',
    () => `#!${bunExecutable}\n`,
  ).replace(
    "if (args[0] === 'export') {\n",
    () =>
      "if (args[0] === 'export') {\n" +
      "  const sessionID = args[1] ?? '';\n" +
      `${EXPORT_DOCUMENT_SOURCE}\n` +
      '  process.stdout.write(JSON.stringify(doc));\n' +
      '  process.exit(0);\n',
  );
}

/** Starts `bun` from the test's own environment and reports the real executable it runs as. */
async function resolveBunExecutable(): Promise<string> {
  const result = await execa('bun', ['--eval', 'console.log(process.execPath)'], {
    stdin: 'ignore',
  });
  return result.stdout.trim();
}

/** The fake agent with an `export` that returns a session holding one user message. */
const EXPORTING_OPENCODE_SCRIPT = FAKE_OPENCODE_SCRIPT.replace(
  'messages: [] }',
  () => "messages: [{ info: { id: 'msg-u1', sessionID: requested, role: 'user' }, parts: [] }] }",
);

/** The exporting fake agent whose `run` also emits one root-session `error` event and still exits 0. */
const SESSION_ERROR_OPENCODE_SCRIPT = EXPORTING_OPENCODE_SCRIPT.replace(
  "  process.exit(0);\n}\nif (args[0] === 'export') {\n",
  () =>
    "  console.log(JSON.stringify({ type: 'error', timestamp: 2, sessionID: 'ses-composition-1', error: { name: 'UnknownError', data: { message: 'synthetic provider failure' } } }));\n" +
    "  process.exit(0);\n}\nif (args[0] === 'export') {\n",
);

/** Every required check is a command check that passes on the starting tree, so a case can reach `passed`. */
const COMMAND_CHECKS = {
  acceptance: [
    {
      id: 'readme-present',
      description: 'The README is present',
      run: 'test -f README.md',
      timeout: '10s',
    },
  ],
  done: [
    {
      id: 'readme-kept',
      description: 'The README is kept',
      run: 'test -f README.md',
      timeout: '10s',
    },
  ],
};

describe('composeProgramDependencies wires providers into the real OpenCode adapter (AC-1)', () => {
  let testDirectory: string;
  let savedHome: string | undefined;
  let savedXdgConfigHome: string | undefined;
  let savedAcmeKey: string | undefined;

  beforeEach(async () => {
    testDirectory = await mkdtemp(join(tmpdir(), 'tevu-index-it-'));
    savedHome = process.env['HOME'];
    savedXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    savedAcmeKey = process.env['ACME_KEY'];
  });

  afterEach(async () => {
    if (savedHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = savedHome;
    }
    if (savedXdgConfigHome === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = savedXdgConfigHome;
    }
    if (savedAcmeKey === undefined) {
      delete process.env['ACME_KEY'];
    } else {
      process.env['ACME_KEY'] = savedAcmeKey;
    }
    await rm(testDirectory, { recursive: true, force: true });
  });

  async function writeFakeExecutable(): Promise<string> {
    const filePath = join(testDirectory, 'fake-opencode.mjs');
    await writeFile(filePath, FAKE_OPENCODE_SCRIPT, { mode: 0o755 });
    return filePath;
  }

  async function writeLateExportExecutable(): Promise<string> {
    const filePath = join(testDirectory, 'fake-opencode-late-export.mjs');
    await writeFile(filePath, LATE_EXPORT_OPENCODE_SCRIPT, { mode: 0o755 });
    return filePath;
  }

  async function writeBunExportExecutable(): Promise<string> {
    const filePath = join(testDirectory, 'fake-opencode-bun-export.mjs');
    await writeFile(filePath, buildBunExportOpencodeScript(await resolveBunExecutable()), {
      mode: 0o755,
    });
    return filePath;
  }

  async function writeExportingExecutable(): Promise<string> {
    const filePath = join(testDirectory, 'fake-opencode-exporting.mjs');
    await writeFile(filePath, EXPORTING_OPENCODE_SCRIPT, { mode: 0o755 });
    return filePath;
  }

  async function writeSessionErrorExecutable(): Promise<string> {
    const filePath = join(testDirectory, 'fake-opencode-session-error.mjs');
    await writeFile(filePath, SESSION_ERROR_OPENCODE_SCRIPT, { mode: 0o755 });
    return filePath;
  }

  /** Points `XDG_CONFIG_HOME` at a fresh operator fixture naming one provider, `acme`. */
  async function writeOperatorFixture(): Promise<void> {
    const operatorDirectory = join(testDirectory, 'operator-config');
    await mkdir(join(operatorDirectory, 'opencode'), { recursive: true });
    await writeFile(
      join(operatorDirectory, 'opencode', 'opencode.json'),
      JSON.stringify({
        provider: {
          acme: { baseURL: 'https://acme.example.test', options: { apiKey: 'placeholder' } },
        },
      }),
    );
    delete process.env['HOME'];
    process.env['XDG_CONFIG_HOME'] = operatorDirectory;
    process.env['ACME_KEY'] = 'synthetic-acme-secret-value';
  }

  function buildConfigInput(options: {
    executable: string;
    repositoryPath: string;
    baseCommit: string;
    outputDirectory: string;
    checks?: TevuTaskInput['checks'];
  }): TevuConfigInput {
    return {
      version: 1,
      run: {
        output_dir: options.outputDirectory,
        concurrency: 1,
        timeout: '30s',
        stop_grace: '500ms',
      },
      agents: {
        opencode: {
          command: options.executable,
          secrets: ['ACME_KEY'],
          env: [],
          providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
        },
      },
      repositories: [{ id: 'repo-1', path: options.repositoryPath }],
      models: [
        { id: 'alpha', model: 'acme/synthetic-model-a', effort: 'high' },
        { id: 'beta', model: 'acme/synthetic-model-b', effort: 'high' },
      ],
      tasks: [
        {
          id: 'task-1',
          title: 'Composition root task',
          repo: 'repo-1',
          base_commit: options.baseCommit,
          description: 'synthetic task description',
          prompt: 'synthetic task prompt',
          readiness: ['synthetic ready item'],
          checks: options.checks ?? {
            acceptance: [{ id: 'manual-1', description: 'Manual review', manual: true }],
            done: [{ id: 'manual-done', description: 'Manual review', manual: true }],
          },
        },
      ],
    };
  }

  it('threads agents.opencode.providers, its declared secrets, and the operator directories into validateConfig, with no host secret or sibling state ever copied', async () => {
    const executable = await writeFakeExecutable();
    await writeOperatorFixture();
    const repositoryPath = join(testDirectory, 'repo');
    const baseCommit = await createReadmeRepository(repositoryPath);
    const config = TevuConfigSchema.parse(
      buildConfigInput({
        executable,
        repositoryPath,
        baseCommit,
        outputDirectory: join(testDirectory, 'artifacts'),
      }),
    );
    const operations = composeProgramDependencies().commands.validate();

    const outcome = await operations.validateConfig(config);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const providerFindings = outcome.value.findings.filter((finding) =>
      finding.identifier.startsWith('agents.opencode.providers'),
    );
    expect(providerFindings).toEqual([]);
    const modelFindings = outcome.value.findings.filter((finding) =>
      finding.identifier.startsWith('models.'),
    );
    expect(modelFindings).toEqual([]);
    expect(outcome.value.valid).toBe(true);
  });

  describe('model call tool denial check', () => {
    const GRADED_CHECKS: TevuTaskInput['checks'] = {
      acceptance: [{ id: 'graded-1', description: 'graded check description', required: true }],
      done: [{ id: 'manual-done', description: 'Manual review', manual: true }],
    };

    /** A fake whose `debug config` shows no permission at all, as an executable that ignores the variable does. */
    const IGNORING_OPENCODE_SCRIPT = FAKE_OPENCODE_SCRIPT.replace(
      DEBUG_CONFIG_DOCUMENT_SOURCE,
      '{ agent: {} }',
    );

    async function validateWithGrader(options: { script: string }) {
      const directory = await mkdtemp(join(testDirectory, 'denial-'));
      const executable = join(directory, 'fake-opencode-denial.mjs');
      await writeFile(executable, options.script, { mode: 0o755 });
      await writeOperatorFixture();
      const repositoryPath = join(directory, 'repo');
      const baseCommit = await createReadmeRepository(repositoryPath);
      const config = TevuConfigSchema.parse({
        ...buildConfigInput({
          executable,
          repositoryPath,
          baseCommit,
          outputDirectory: join(directory, 'artifacts'),
          checks: GRADED_CHECKS,
        }),
        roles: { grader: { agent: 'opencode', model: 'acme/synthetic-model-a', effort: 'high' } },
      });
      const outcome = await composeProgramDependencies().commands.validate().validateConfig(config);
      if (!outcome.ok) {
        throw new Error(`expected validateConfig to succeed: ${JSON.stringify(outcome.error)}`);
      }
      return { ...outcome.value, directory };
    }

    function toolDenialFindingsOf(findings: readonly { message: string }[]) {
      return findings.filter((finding) => finding.message.includes('model call tool denial'));
    }

    it('reports no tool denial finding and a valid configuration when debug config shows the denial it was given', async () => {
      const report = await validateWithGrader({ script: FAKE_OPENCODE_SCRIPT });

      expect(toolDenialFindingsOf(report.findings)).toEqual([]);
      expect(report.valid).toBe(true);
    });

    it('reports one missing-denial error at the agent when debug config shows no permission', async () => {
      const report = await validateWithGrader({ script: IGNORING_OPENCODE_SCRIPT });

      const findings = toolDenialFindingsOf(report.findings);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: 'error', identifier: 'agents.opencode' });
      expect(
        findings[0]?.message.startsWith('capability "model call tool denial" is missing: "'),
      ).toBe(true);
      expect(findings[0]?.message).toContain('shows no "permission"');
      expect(report.valid).toBe(false);
    });

    it('keeps a declared secret that debug config prints out of every finding', async () => {
      const secret = 'synthetic-acme-secret-value';
      const leakingScript = FAKE_OPENCODE_SCRIPT.replace(
        DEBUG_CONFIG_DOCUMENT_SOURCE,
        `{ provider: { acme: { options: { organization: '${secret}' } } }, permission: { '*': 'deny', '${secret}': 'allow' } }`,
      );
      expect(leakingScript).not.toBe(FAKE_OPENCODE_SCRIPT);

      const report = await validateWithGrader({ script: leakingScript });

      const findings = toolDenialFindingsOf(report.findings);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.message).toContain('lists "[REDACTED]" after "*"');
      expect(JSON.stringify(report)).not.toContain(secret);
    });

    it('reports the same findings whatever version the executable prints', async () => {
      const versioned = IGNORING_OPENCODE_SCRIPT.replace('1.0.0-composition-fake', '2.0.0');
      expect(versioned).not.toBe(IGNORING_OPENCODE_SCRIPT);

      const report = await validateWithGrader({ script: IGNORING_OPENCODE_SCRIPT });
      const versionedReport = await validateWithGrader({ script: versioned });

      const textOf = (result: typeof report): string =>
        JSON.stringify(result.findings).replaceAll(result.directory, '<directory>');
      expect(textOf(versionedReport)).toBe(textOf(report));
    });
  });

  describe('effort check', () => {
    async function buildMisspelledConfig(executable: string) {
      const repositoryPath = join(testDirectory, 'repo');
      const baseCommit = await createReadmeRepository(repositoryPath);
      const input = buildConfigInput({
        executable,
        repositoryPath,
        baseCommit,
        outputDirectory: join(testDirectory, 'artifacts'),
      });
      const models = input.models ?? [];
      return { ...input, models: [models[0], { ...models[1], effort: 'hihg' }] };
    }

    it('refuses an effort outside the reported variants before any case starts', async () => {
      const executable = await writeFakeExecutable();
      await writeOperatorFixture();
      const input = await buildMisspelledConfig(executable);
      const configPath = join(testDirectory, 'tevu.yaml');
      await writeFile(configPath, stringify(input));
      const stdout = capture();
      const stderr = capture();
      const dependencies = composeProgramDependencies({
        io: { stdin: Readable.from([]), stdout: stdout.stream, stderr: stderr.stream },
      });

      const code = await runProgram(['run', '--config', configPath], dependencies);

      expect(code).toBe(1);
      expect(stdout.text() + stderr.text()).toContain('models.beta.effort');
      expect(stdout.text() + stderr.text()).toContain(
        `"hihg" is not among the variants "${executable} models --verbose" reports for "acme/synthetic-model-b" (high, low)`,
      );
      expect(existsSync(join(testDirectory, 'artifacts'))).toBe(false);
    });

    it('reports valid false with one error at the misspelled entry through validateConfig', async () => {
      const executable = await writeFakeExecutable();
      await writeOperatorFixture();
      const config = TevuConfigSchema.parse(await buildMisspelledConfig(executable));
      const operations = composeProgramDependencies().commands.validate();

      const outcome = await operations.validateConfig(config);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.value.valid).toBe(false);
      expect(
        outcome.value.findings.filter((finding) => finding.identifier.endsWith('.effort')),
      ).toEqual([expect.objectContaining({ severity: 'error', identifier: 'models.beta.effort' })]);
      expect(outcome.value.efforts.models['alpha']).toEqual({ status: 'verified' });
      expect(outcome.value.efforts.models['beta']?.status).toBe('unsupported');
    });

    it('records the checks of the validation in run.json', async () => {
      const executable = await writeFakeExecutable();
      await writeOperatorFixture();
      const repositoryPath = join(testDirectory, 'repo');
      const baseCommit = await createReadmeRepository(repositoryPath);
      const config = TevuConfigSchema.parse(
        buildConfigInput({
          executable,
          repositoryPath,
          baseCommit,
          outputDirectory: join(testDirectory, 'artifacts'),
        }),
      );
      const operations = composeProgramDependencies().commands.run();
      const plan = await planThroughValidation(
        operations,
        config,
        join(testDirectory, 'tevu.yaml'),
      );

      const result = await operations.executeBenchmark(plan, {
        cancellation: new AbortController().signal,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const stored = JSON.parse(
        await readFile(
          join(testDirectory, 'artifacts', result.value.manifest.runId, 'run.json'),
          'utf8',
        ),
      ) as { manifest: { efforts: unknown } };
      expect(stored.manifest.efforts).toEqual({
        models: { alpha: { status: 'verified' }, beta: { status: 'verified' } },
        grader: null,
      });
    });
  });

  describe('model access operations', () => {
    const UNSET_VARIABLE = 'TEVU_INDEX_UNSET_KEY';
    const OPERATOR_LITERAL = 'placeholder';
    const HOST_SECRET = 'synthetic-acme-secret-value';

    function buildAgent(executable: string, overrides: Partial<AgentDraft> = {}): AgentDraft {
      return { command: executable, secrets: [], env: [], providers: [], ...overrides };
    }

    it('reports a command that starts as usable and a missing one as a prerequisite failure', async () => {
      const executable = await writeFakeExecutable();
      const operations = composeProgramDependencies().commands.taskAdd();
      const configPath = join(testDirectory, 'tevu.yaml');

      const good = await operations.probeAgent(configPath, executable);
      const missing = await operations.probeAgent(configPath, join(testDirectory, 'no-such-agent'));

      expect(good.ok).toBe(true);
      expect(missing).toMatchObject({ ok: false, error: { kind: 'PrerequisiteError' } });
    });

    it('reads the operator directory from the environment and reports names and states only', async () => {
      const executable = await writeFakeExecutable();
      await writeOperatorFixture();
      const operations = composeProgramDependencies().commands.taskAdd();
      const configPath = join(testDirectory, 'tevu.yaml');

      const defined = await operations.inspectModelProvider(
        configPath,
        buildAgent(executable),
        'acme/synthetic-model-a',
      );
      const undefinedProvider = await operations.inspectModelProvider(
        configPath,
        buildAgent(executable),
        'other/synthetic-model-a',
      );

      expect(defined).toEqual({
        ok: true,
        value: {
          provider: 'acme',
          definition: { defined: true, keyVariables: [], otherVariables: [], apiKey: 'value' },
        },
      });
      expect(undefinedProvider).toEqual({
        ok: true,
        value: { provider: 'other', definition: { defined: false } },
      });
      expect(JSON.stringify(defined)).not.toContain(OPERATOR_LITERAL);
      expect(JSON.stringify(defined)).not.toContain(HOST_SECRET);
    });

    it('lists a copied provider model, refuses one the listing omits, and leaks no value', async () => {
      const executable = await writeFakeExecutable();
      await writeOperatorFixture();
      const operations = composeProgramDependencies().commands.taskAdd();
      const configPath = join(testDirectory, 'tevu.yaml');
      const agent = buildAgent(executable, {
        secrets: ['ACME_KEY'],
        providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
      });

      const listed = await operations.checkModelAccess(configPath, agent, 'acme/synthetic-model-a');
      const notListed = await operations.checkModelAccess(configPath, agent, 'acme/unknown-model');

      expect(listed).toEqual({
        status: 'listed',
        variants: ['high', 'low'],
        unsetVariables: [],
        retainedDirectory: null,
      });
      expect(notListed).toEqual({
        status: 'not-listed',
        unsetVariables: [],
        retainedDirectory: null,
      });
      expect(JSON.stringify([listed, notListed])).not.toContain(HOST_SECRET);
      expect(JSON.stringify([listed, notListed])).not.toContain(OPERATOR_LITERAL);
    });

    it('does not list a provider the agent block leaves out', async () => {
      const executable = await writeFakeExecutable();
      await writeOperatorFixture();
      const operations = composeProgramDependencies().commands.taskAdd();

      const outcome = await operations.checkModelAccess(
        join(testDirectory, 'tevu.yaml'),
        buildAgent(executable),
        'acme/synthetic-model-a',
      );

      expect(outcome).toMatchObject({ status: 'not-listed' });
    });

    it("names a declared variable that tevu's own environment leaves unset", async () => {
      const executable = await writeFakeExecutable();
      await writeOperatorFixture();
      delete process.env[UNSET_VARIABLE];
      const operations = composeProgramDependencies().commands.taskAdd();

      const outcome = await operations.checkModelAccess(
        join(testDirectory, 'tevu.yaml'),
        buildAgent(executable, {
          secrets: ['ACME_KEY', UNSET_VARIABLE],
          providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
        }),
        'acme/synthetic-model-a',
      );

      expect(outcome).toEqual({
        status: 'listed',
        variants: ['high', 'low'],
        unsetVariables: [UNSET_VARIABLE],
        retainedDirectory: null,
      });
    });
  });

  it("passes the real SHA-256 digest function as executeBenchmark's textDigest", async () => {
    const executable = await writeFakeExecutable();
    await writeOperatorFixture();
    const repositoryPath = join(testDirectory, 'repo');
    const baseCommit = await createReadmeRepository(repositoryPath);
    const config = TevuConfigSchema.parse(
      buildConfigInput({
        executable,
        repositoryPath,
        baseCommit,
        outputDirectory: join(testDirectory, 'artifacts'),
      }),
    );
    const operations = composeProgramDependencies().commands.run();
    const plan = await planThroughValidation(operations, config, join(testDirectory, 'tevu.yaml'));

    const result = await operations.executeBenchmark(plan, {
      cancellation: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const written = result.value.manifest.tools.agentConfigurationFiles['opencode'];
    expect(written).toHaveLength(1);
    const expectedDocument = {
      provider: {
        acme: { baseURL: 'https://acme.example.test', options: { apiKey: '{env:ACME_KEY}' } },
      },
    };
    const expectedText = `${JSON.stringify(expectedDocument, null, 2)}\n`;
    const expectedDigest = createHash('sha256').update(expectedText, 'utf8').digest('hex');
    expect(written?.[0]).toEqual({ path: 'opencode/opencode.json', sha256: expectedDigest });
  });

  it('records export-derived metrics from a document a descendant writes after the fake exits', async () => {
    const executable = await writeLateExportExecutable();
    await writeOperatorFixture();
    const repositoryPath = join(testDirectory, 'repo');
    const baseCommit = await createReadmeRepository(repositoryPath);
    const config = TevuConfigSchema.parse(
      buildConfigInput({
        executable,
        repositoryPath,
        baseCommit,
        outputDirectory: join(testDirectory, 'artifacts'),
      }),
    );
    const operations = composeProgramDependencies().commands.run();
    const plan = await planThroughValidation(operations, config, join(testDirectory, 'tevu.yaml'));

    const result = await operations.executeBenchmark(plan, {
      cancellation: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fromExport = (value: number, unit: 'token' | 'USD') => ({
      value,
      unit,
      availability: { status: 'available', source: 'root-session export' },
      scope: 'root-session',
    });
    const expectedCase = {
      failure: null,
      hasSessionExport: true,
      inputTokens: fromExport(1200, 'token'),
      outputTokens: fromExport(450, 'token'),
      cost: fromExport(0.0125, 'USD'),
    };
    const observedCases = result.value.cases.map((caseResult) => ({
      failure: caseResult.failure,
      hasSessionExport: caseResult.artifacts.sessionExport !== null,
      inputTokens: caseResult.metrics.inputTokens,
      outputTokens: caseResult.metrics.outputTokens,
      cost: caseResult.metrics.cost,
    }));
    expect(observedCases).toEqual([expectedCase, expectedCase]);
  });

  it('records export-derived metrics from an export a Bun process writes right before exiting', async () => {
    const executable = await writeBunExportExecutable();
    await writeOperatorFixture();
    const repositoryPath = join(testDirectory, 'repo');
    const baseCommit = await createReadmeRepository(repositoryPath);
    const config = TevuConfigSchema.parse(
      buildConfigInput({
        executable,
        repositoryPath,
        baseCommit,
        outputDirectory: join(testDirectory, 'artifacts'),
      }),
    );
    const operations = composeProgramDependencies().commands.run();
    const plan = await planThroughValidation(operations, config, join(testDirectory, 'tevu.yaml'));

    const result = await operations.executeBenchmark(plan, {
      cancellation: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fromExport = (value: number, unit: 'token' | 'USD' | 'count') => ({
      value,
      unit,
      availability: { status: 'available', source: 'root-session export' },
      scope: 'root-session',
    });
    const expectedCase = {
      failure: null,
      hasSessionExport: true,
      inputTokens: fromExport(1200, 'token'),
      outputTokens: fromExport(450, 'token'),
      reasoningTokens: fromExport(16, 'token'),
      cacheReadTokens: fromExport(30, 'token'),
      cacheWriteTokens: fromExport(10, 'token'),
      cost: fromExport(0.0125, 'USD'),
      apiCalls: fromExport(1, 'count'),
      turns: fromExport(1, 'count'),
    };
    const observedCases = result.value.cases.map((caseResult) => ({
      failure: caseResult.failure,
      hasSessionExport: caseResult.artifacts.sessionExport !== null,
      inputTokens: caseResult.metrics.inputTokens,
      outputTokens: caseResult.metrics.outputTokens,
      reasoningTokens: caseResult.metrics.reasoningTokens,
      cacheReadTokens: caseResult.metrics.cacheReadTokens,
      cacheWriteTokens: caseResult.metrics.cacheWriteTokens,
      cost: caseResult.metrics.cost,
      apiCalls: caseResult.metrics.apiCalls,
      turns: caseResult.metrics.turns,
    }));
    expect(observedCases).toEqual([expectedCase, expectedCase]);
  });

  describe('a zero-exit run that delivered a root-session error event', () => {
    async function runTwoCases(executable: string, checks = COMMAND_CHECKS) {
      await writeOperatorFixture();
      const repositoryPath = join(testDirectory, 'repo');
      const baseCommit = await createReadmeRepository(repositoryPath);
      const config = TevuConfigSchema.parse(
        buildConfigInput({
          executable,
          repositoryPath,
          baseCommit,
          outputDirectory: join(testDirectory, 'artifacts'),
          checks,
        }),
      );
      const operations = composeProgramDependencies().commands.run();
      const plan = await planThroughValidation(
        operations,
        config,
        join(testDirectory, 'tevu.yaml'),
      );

      return operations.executeBenchmark(plan, {
        cancellation: new AbortController().signal,
      });
    }

    it('records an AgentSessionError on a passed case and exits with code 2', async () => {
      const executable = await writeSessionErrorExecutable();

      const result = await runTwoCases(executable);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const observedCases = result.value.cases.map((caseResult) => ({
        lifecycle: caseResult.lifecycle,
        outcome: caseResult.outcome,
        verdicts: caseResult.checks.map((check) => check.verdict),
        errorKind: caseResult.failure?.error.kind,
        apiErrors: caseResult.metrics.apiErrors,
      }));
      const expectedCase = {
        lifecycle: 'completed',
        outcome: 'passed',
        verdicts: ['passed', 'passed'],
        errorKind: 'AgentSessionError',
        apiErrors: {
          value: 1,
          unit: 'count',
          availability: { status: 'available', source: 'root-session export and run events' },
          scope: 'root-session',
        },
      };
      expect(observedCases).toEqual([expectedCase, expectedCase]);
      expect(result.value.exitCode).toBe(2);
    });

    it('keeps an error-free run passed with no failure, zero API errors, and exit code 0', async () => {
      const executable = await writeExportingExecutable();

      const result = await runTwoCases(executable);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const observedCases = result.value.cases.map((caseResult) => ({
        lifecycle: caseResult.lifecycle,
        outcome: caseResult.outcome,
        failure: caseResult.failure,
        apiErrors: caseResult.metrics.apiErrors,
      }));
      const expectedCase = {
        lifecycle: 'completed',
        outcome: 'passed',
        failure: null,
        apiErrors: {
          value: 0,
          unit: 'count',
          availability: { status: 'available', source: 'root-session export and run events' },
          scope: 'root-session',
        },
      };
      expect(observedCases).toEqual([expectedCase, expectedCase]);
      expect(result.value.exitCode).toBe(0);
    });
  });

  describe('secret registration', () => {
    const OPERATOR_FIXTURE_SECRET = 'synthetic-acme-secret-value';
    const JIRA_TOKEN_VARIABLE = 'TEVU_TEST_JIRA_TOKEN';
    const JIRA_TOKEN = 'synthetic-jira-token-value';

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function prepareRepository(): Promise<{ repositoryPath: string; baseCommit: string }> {
      const repositoryPath = join(testDirectory, 'repo');
      return { repositoryPath, baseCommit: await createReadmeRepository(repositoryPath) };
    }

    it.each(['taskAdd', 'validate', 'run', 'assess', 'report'] as const)(
      'redacts the agent secrets and the Jira token once the %s factory loads a configuration',
      async (factory) => {
        const executable = await writeFakeExecutable();
        await writeOperatorFixture();
        vi.stubEnv(JIRA_TOKEN_VARIABLE, JIRA_TOKEN);
        const { repositoryPath, baseCommit } = await prepareRepository();
        const configPath = join(testDirectory, 'tevu.yaml');
        await writeFile(
          configPath,
          stringify({
            ...buildConfigInput({
              executable,
              repositoryPath,
              baseCommit,
              outputDirectory: join(testDirectory, 'artifacts'),
            }),
            trackers: { jira: buildJiraTrackerSettings() },
          }),
        );
        const dependencies = composeProgramDependencies();
        const text = `${OPERATOR_FIXTURE_SECRET} ${JIRA_TOKEN}`;
        const redactedBeforeLoad = dependencies.redact(text);

        const loaded = await dependencies.commands[factory]().loadConfig(configPath);

        expect(loaded.ok).toBe(true);
        expect(redactedBeforeLoad).toBe(text);
        expect(dependencies.redact(text)).toBe('[REDACTED] [REDACTED]');
      },
    );

    it('redacts a secret variable first set after composition once validateConfig snapshots it', async () => {
      const lateSecret = 'synthetic-late-secret-value';
      const executable = await writeFakeExecutable();
      await writeOperatorFixture();
      const { repositoryPath, baseCommit } = await prepareRepository();
      const config = TevuConfigSchema.parse(
        buildConfigInput({
          executable,
          repositoryPath,
          baseCommit,
          outputDirectory: join(testDirectory, 'artifacts'),
        }),
      );
      const dependencies = composeProgramDependencies();
      vi.stubEnv('ACME_KEY', lateSecret);
      const redactedBeforeValidation = dependencies.redact(lateSecret);

      const outcome = await dependencies.commands.validate().validateConfig(config);

      expect(outcome.ok).toBe(true);
      expect(redactedBeforeValidation).toBe(lateSecret);
      expect(dependencies.redact(lateSecret)).toBe('[REDACTED]');
    });
  });
});
