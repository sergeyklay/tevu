// @vitest-environment node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createCaseExecutableAdapter,
  createEnvironmentAdapter,
  createPrerequisiteAdapter,
  runManagedProcess,
} from './process';

import type {
  CaseExecutableProbeRequest,
  ManagedProcessCompletion,
  ManagedProcessLaunchFailure,
  ManagedProcessRequest,
  ManagedProcessResult,
} from '@/domain/types';

const SYNTHETIC_GIT_SCRIPT = '#!/bin/sh\necho "git version 2.45.0-synthetic"\nexit 0\n';

describe('probeHost (P1)', () => {
  let binDirectory = '';
  let originalPath: string | undefined;

  beforeEach(async () => {
    binDirectory = await mkdtemp(join(tmpdir(), 'tevu-probe-host-'));
    const gitPath = join(binDirectory, 'git');
    await writeFile(gitPath, SYNTHETIC_GIT_SCRIPT);
    await chmod(gitPath, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = binDirectory;
  });

  afterEach(async () => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (binDirectory.length > 0) {
      await rm(binDirectory, { recursive: true, force: true });
      binDirectory = '';
    }
  });

  it('resolves the host probe from a PATH holding only a synthetic git script', async () => {
    const result = await createPrerequisiteAdapter().probeHost();

    expect(result).toEqual({
      ok: true,
      value: {
        platform: process.platform,
        nodeVersion: process.version,
        gitVersion: '2.45.0-synthetic',
      },
    });
  });
});

/** UTF-8 encodes to exactly 200,000 bytes: 50,000 copies of `я` (2 bytes each) then 100,000 copies of `a`. */
const FIDELITY_PAYLOAD = 'я'.repeat(50_000) + 'a'.repeat(100_000);
const FIDELITY_PAYLOAD_SHA256 = createHash('sha256')
  .update(Buffer.from(FIDELITY_PAYLOAD, 'utf8'))
  .digest('hex');
const EMPTY_STDIN_SHA256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');

/** Far above the stdin channel buffer measured on this host, so a write is still pending at exit or kill. */
const PENDING_WRITE_PAYLOAD = 'a'.repeat(1_000_000);

/** Reads fd 0 to end-of-file and prints its byte count and SHA-256, space-separated. */
const READER_SCRIPT =
  'const d=require("fs").readFileSync(0);' +
  'process.stdout.write(d.length+" "+require("crypto").createHash("sha256").update(d).digest("hex"));';

function readerRequest(stdinText: string | undefined) {
  return {
    argv: [process.execPath, '-e', READER_SCRIPT] as [string, ...string[]],
    cwd: process.cwd(),
    environment: {},
    timeoutMs: 10_000,
    terminationGraceMs: 250,
    stdinText,
  };
}

describe('runManagedProcess stdin', () => {
  it('delivers the 200,000-byte fidelity payload to the child unchanged', async () => {
    const result = await runManagedProcess(readerRequest(FIDELITY_PAYLOAD));

    expect(result.launched).toBe(true);
    if (!result.launched) return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`200000 ${FIDELITY_PAYLOAD_SHA256}`);
  });

  it('gives the child closed, empty stdin when stdinText is absent', async () => {
    const result = await runManagedProcess(readerRequest(undefined));

    expect(result.launched).toBe(true);
    if (!result.launched) return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.text).toBe(`0 ${EMPTY_STDIN_SHA256}`);
  });

  it('ignores EPIPE on an exit-before-read child and preserves its exit status', async () => {
    const result = await runManagedProcess({
      argv: [process.execPath, '-e', 'process.exit(3);'],
      cwd: process.cwd(),
      environment: {},
      timeoutMs: 10_000,
      terminationGraceMs: 250,
      stdinText: PENDING_WRITE_PAYLOAD,
    });

    expect(result).toMatchObject({
      launched: true,
      exitCode: 3,
      signal: null,
      timedOut: false,
      cancelled: false,
      terminationStage: 'none',
    });
  });

  it('a pending write delays neither timeout nor its grace escalation', async () => {
    const result = await runManagedProcess({
      argv: [process.execPath, '-e', 'setInterval(() => {}, 1000);'],
      cwd: process.cwd(),
      environment: {},
      timeoutMs: 1000,
      terminationGraceMs: 250,
      stdinText: PENDING_WRITE_PAYLOAD,
    });

    expect(result).toMatchObject({
      launched: true,
      timedOut: true,
      terminationStage: 'graceful',
      signal: 'SIGTERM',
    });
  });
});

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

function nodeScript(body: string): string {
  return `#!${process.execPath}\n${body}`;
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

function buildRequest(
  overrides: Partial<CaseExecutableProbeRequest> &
    Pick<CaseExecutableProbeRequest, 'executable' | 'path'>,
): CaseExecutableProbeRequest {
  return { additions: {}, withheldNames: [], ...overrides };
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

/** One committed file, `tracked.txt`, and nothing else pending. */
async function createRepositoryWithOneTrackedFile(root: string): Promise<string> {
  const repository = join(root, 'repo');
  await mkdir(repository, { recursive: true });
  await runGit(repository, ['init', '--quiet', '-b', 'main']);
  await writeFile(join(repository, 'tracked.txt'), 'tracked\n');
  await runGit(repository, ['add', '-A']);
  await runGit(repository, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'base']);
  return repository;
}

/**
 * A committed `.gitignore` (naming `ignored/`), `drop.txt`, `edit.txt`, and
 * `dirty.txt`, with `dirty.txt` already modified and `loose.txt` untracked
 * on top of that commit.
 */
async function createRepositoryWithPendingChanges(root: string): Promise<string> {
  const repository = join(root, 'repo');
  await mkdir(repository, { recursive: true });
  await runGit(repository, ['init', '--quiet', '-b', 'main']);
  await writeFile(join(repository, '.gitignore'), 'ignored/\n');
  await writeFile(join(repository, 'drop.txt'), 'drop\n');
  await writeFile(join(repository, 'edit.txt'), 'edit\n');
  await writeFile(join(repository, 'dirty.txt'), 'dirty\n');
  await runGit(repository, ['add', '-A']);
  await runGit(repository, [...GIT_IDENTITY_FLAGS, 'commit', '--quiet', '-m', 'base']);
  await writeFile(join(repository, 'dirty.txt'), 'dirty\nlocal edit\n');
  await writeFile(join(repository, 'loose.txt'), 'loose\n');
  return repository;
}

type FileFingerprint = { sha256: string; mtimeMs: number };

/** Every regular file under `root`, keyed by its path relative to `root`, with its bytes hashed and its `mtime` read through `lstat`. */
async function snapshotTree(root: string): Promise<Map<string, FileFingerprint>> {
  const entries = new Map<string, FileFingerprint>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const [content, info] = await Promise.all([readFile(full), lstat(full)]);
        entries.set(relative(root, full), {
          sha256: createHash('sha256').update(content).digest('hex'),
          mtimeMs: info.mtimeMs,
        });
      }
    }
  }
  await walk(root);
  return entries;
}

describe('createCaseExecutableAdapter', () => {
  let workspace = '';
  let savedEnvironment: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    savedEnvironment = { ...process.env };
    workspace = await mkdtemp(join(tmpdir(), 'tevu-case-executable-'));
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

  describe('probe', () => {
    it('reports a shim that only resolves through the operator home as parent-only', async () => {
      const binDirectory = join(workspace, 'bin');
      const operatorHome = join(workspace, 'operator-home');
      await mkdir(binDirectory, { recursive: true });
      await mkdir(join(operatorHome, 'installs', 'v1'), { recursive: true });
      await writeExecutable(join(binDirectory, 'toolx'), shellScript(SYNTHETIC_SHIM_BODY));
      await writeExecutable(join(operatorHome, 'installs', 'v1', 'toolx'), shellScript('exit 0\n'));
      await writeFile(join(operatorHome, 'synthetic-pin'), 'v1\n');
      process.env.HOME = operatorHome;
      process.env.PATH = `${binDirectory}:${process.env.PATH ?? ''}`;

      const result = await createCaseExecutableAdapter().probe(
        buildRequest({ executable: 'toolx', path: process.env.PATH }),
      );

      expect(result).toEqual({
        ok: true,
        value: {
          verdict: {
            verdict: 'parent-only',
            resolvedPath: join(binDirectory, 'toolx'),
            replicaFailure: { kind: 'exited', exitCode: 126 },
          },
        },
      });
    });

    it('reports undetermined when neither the replica nor the parent run finds a version pin', async () => {
      const binDirectory = join(workspace, 'bin');
      const operatorHome = join(workspace, 'operator-home');
      await mkdir(binDirectory, { recursive: true });
      await mkdir(join(operatorHome, 'installs', 'v1'), { recursive: true });
      await writeExecutable(join(binDirectory, 'toolx'), shellScript(SYNTHETIC_SHIM_BODY));
      await writeExecutable(join(operatorHome, 'installs', 'v1', 'toolx'), shellScript('exit 0\n'));
      process.env.HOME = operatorHome;
      process.env.PATH = `${binDirectory}:${process.env.PATH ?? ''}`;

      const result = await createCaseExecutableAdapter().probe(
        buildRequest({ executable: 'toolx', path: process.env.PATH }),
      );

      expect(result).toEqual({ ok: true, value: { verdict: { verdict: 'undetermined' } } });
    });

    it('reports parent-only when only the shared working directory carries the version pin', async () => {
      const binDirectory = join(workspace, 'bin');
      const operatorHome = join(workspace, 'operator-home');
      const work = join(workspace, 'work');
      await mkdir(binDirectory, { recursive: true });
      await mkdir(join(operatorHome, 'installs', 'v1'), { recursive: true });
      await mkdir(work, { recursive: true });
      await writeExecutable(join(binDirectory, 'toolx'), shellScript(SYNTHETIC_SHIM_BODY));
      await writeExecutable(join(operatorHome, 'installs', 'v1', 'toolx'), shellScript('exit 0\n'));
      await writeFile(join(work, 'synthetic-pin'), 'v1\n');
      process.env.HOME = operatorHome;
      process.env.PATH = `${binDirectory}:${process.env.PATH ?? ''}`;

      const result = await createCaseExecutableAdapter().probe(
        buildRequest({ executable: 'toolx', path: process.env.PATH, workingDirectory: work }),
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.verdict).toEqual({
          verdict: 'parent-only',
          resolvedPath: join(binDirectory, 'toolx'),
          replicaFailure: { kind: 'exited', exitCode: 126 },
        });
      }
    });

    it('starts a self-contained executable exactly once when it exits 0 without reading HOME', async () => {
      const script = join(workspace, 'runs.sh');
      const startsFile = join(workspace, 'starts.log');
      await writeExecutable(script, shellScript('echo start >> "$STARTS_FILE"\nexit 0\n'));

      const result = await createCaseExecutableAdapter().probe(
        buildRequest({
          executable: script,
          path: '/usr/bin:/bin',
          additions: { STARTS_FILE: startsFile },
        }),
      );

      expect(result).toEqual({ ok: true, value: { verdict: { verdict: 'runs' } } });
      const starts = await readFile(startsFile, 'utf8');
      expect(starts.trim().split('\n')).toEqual(['start']);
    });

    describe('an executable that only succeeds when one variable is set', () => {
      const NEEDS_VARIABLE_SCRIPT = shellScript(
        'if [ -n "$NEEDED_VARIABLE" ]; then\n  exit 0\nfi\nexit 1\n',
      );

      it('runs when the request additions carry the needed variable', async () => {
        const script = join(workspace, 'needs-var.sh');
        await writeExecutable(script, NEEDS_VARIABLE_SCRIPT);

        const result = await createCaseExecutableAdapter().probe(
          buildRequest({
            executable: script,
            path: '/usr/bin:/bin',
            additions: { NEEDED_VARIABLE: 'set' },
          }),
        );

        expect(result).toEqual({ ok: true, value: { verdict: { verdict: 'runs' } } });
      });

      it('reports parent-only when additions omit a variable the parent environment sets', async () => {
        const script = join(workspace, 'needs-var.sh');
        await writeExecutable(script, NEEDS_VARIABLE_SCRIPT);
        process.env.NEEDED_VARIABLE = 'set';

        const result = await createCaseExecutableAdapter().probe(
          buildRequest({ executable: script, path: '/usr/bin:/bin' }),
        );

        expect(result).toEqual({
          ok: true,
          value: {
            verdict: {
              verdict: 'parent-only',
              resolvedPath: script,
              replicaFailure: { kind: 'exited', exitCode: 1 },
            },
          },
        });
      });

      it('reports undetermined when withheldNames excludes that variable from the parent run too', async () => {
        const script = join(workspace, 'needs-var.sh');
        await writeExecutable(script, NEEDS_VARIABLE_SCRIPT);
        process.env.NEEDED_VARIABLE = 'set';

        const result = await createCaseExecutableAdapter().probe(
          buildRequest({
            executable: script,
            path: '/usr/bin:/bin',
            withheldNames: ['NEEDED_VARIABLE'],
          }),
        );

        expect(result).toEqual({ ok: true, value: { verdict: { verdict: 'undetermined' } } });
      });
    });

    it('gives a replica run exactly the fixed and addition variable names, with HOME under the probe directory', async () => {
      const script = join(workspace, 'report-env.js');
      const outputFile = join(workspace, 'env-report.json');
      await writeExecutable(
        script,
        nodeScript(
          "const fs = require('fs');" +
            'fs.writeFileSync(process.env.OUTPUT_FILE, JSON.stringify(' +
            '{ keys: Object.keys(process.env).sort(), home: process.env.HOME }));' +
            'process.exit(0);',
        ),
      );
      const parentHome = join(workspace, 'parent-home');
      await mkdir(parentHome, { recursive: true });
      process.env.HOME = parentHome;

      const result = await createCaseExecutableAdapter().probe(
        buildRequest({
          executable: script,
          path: '/usr/bin:/bin',
          additions: { OUTPUT_FILE: outputFile, EXTRA_VARIABLE: 'value' },
        }),
      );

      expect(result).toEqual({ ok: true, value: { verdict: { verdict: 'runs' } } });
      const report = JSON.parse(await readFile(outputFile, 'utf8')) as {
        keys: string[];
        home: string;
      };
      expect(report.keys).toEqual([
        'CI',
        'EXTRA_VARIABLE',
        'HOME',
        'LANG',
        'LC_ALL',
        'OUTPUT_FILE',
        'PATH',
        'TMPDIR',
        'XDG_CACHE_HOME',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_STATE_HOME',
      ]);
      expect(report.home).not.toBe(parentHome);
      expect(report.home).toMatch(/tevu-probe-/);
    });

    describe('probe directory cleanup', () => {
      it.each([
        {
          label: 'a run that exits 0',
          build: async (): Promise<CaseExecutableProbeRequest> => {
            const script = join(workspace, 'ok.sh');
            await writeExecutable(script, shellScript('exit 0\n'));
            return buildRequest({ executable: script, path: '/usr/bin:/bin' });
          },
        },
        {
          label: 'a run that exits 0 only in the parent environment',
          build: async (): Promise<CaseExecutableProbeRequest> => {
            const script = join(workspace, 'needs-var.sh');
            await writeExecutable(
              script,
              shellScript('if [ -n "$P6_VARIABLE" ]; then\n  exit 0\nfi\nexit 1\n'),
            );
            process.env.P6_VARIABLE = 'set';
            return buildRequest({ executable: script, path: '/usr/bin:/bin' });
          },
        },
        {
          label: 'a run that cannot start',
          build: async (): Promise<CaseExecutableProbeRequest> =>
            buildRequest({ executable: 'tevu-test-no-such-executable', path: '/usr/bin:/bin' }),
        },
      ])('leaves no tevu-probe- entry under TMPDIR after $label', async ({ build }) => {
        const probeTmp = join(workspace, 'probe-tmp');
        await mkdir(probeTmp, { recursive: true });
        process.env.TMPDIR = probeTmp;
        const request = await build();

        await createCaseExecutableAdapter().probe(request);

        const remaining = (await readdir(probeTmp)).filter((name) =>
          name.startsWith('tevu-probe-'),
        );
        expect(remaining).toEqual([]);
      });
    });

    it('withholds a name from the parent run while the replica run still sees it through additions', async () => {
      const script = join(workspace, 'report-env.js');
      const outputDirectory = join(workspace, 'reports');
      await mkdir(outputDirectory, { recursive: true });
      // The parent run never receives `additions` (only `process.env` minus
      // the withheld names), so the output directory is baked into the
      // script text itself rather than read from an addition.
      await writeExecutable(
        script,
        nodeScript(
          "const fs = require('fs');" +
            "const path = require('path');" +
            `const dir = ${JSON.stringify(outputDirectory)};` +
            'const target = path.join(dir, `${fs.readdirSync(dir).length}.json`);' +
            'fs.writeFileSync(target, JSON.stringify({' +
            '  keep: process.env.KEEP_VARIABLE ?? null,' +
            '  drop: process.env.DROP_VARIABLE ?? null,' +
            '  secret: process.env.REPLICA_SECRET ?? null,' +
            '}));' +
            'process.exit(1);',
        ),
      );
      process.env.KEEP_VARIABLE = 'keep-value';
      process.env.DROP_VARIABLE = 'drop-value';

      await createCaseExecutableAdapter().probe(
        buildRequest({
          executable: script,
          path: '/usr/bin:/bin',
          additions: { REPLICA_SECRET: 'shhh-value' },
          withheldNames: ['DROP_VARIABLE', 'REPLICA_SECRET'],
        }),
      );

      const replicaReport = JSON.parse(await readFile(join(outputDirectory, '0.json'), 'utf8'));
      const parentReport = JSON.parse(await readFile(join(outputDirectory, '1.json'), 'utf8'));
      expect(replicaReport).toEqual({ keep: null, drop: null, secret: 'shhh-value' });
      expect(parentReport).toEqual({ keep: 'keep-value', drop: null, secret: null });
    });

    describe('working directory reuse', () => {
      it('runs both starts in the requested working directory without touching its existing files', async () => {
        const work = join(workspace, 'work');
        await mkdir(work, { recursive: true });
        await writeFile(join(work, 'marker.txt'), 'hello\n');
        const script = join(workspace, 'report-cwd.js');
        const outputDirectory = join(workspace, 'cwd-reports');
        await mkdir(outputDirectory, { recursive: true });
        // The output directory is baked into the script text (see the
        // comment above the equivalent probe in the withheld-name test):
        // the parent run does not receive `additions`.
        await writeExecutable(
          script,
          nodeScript(
            "const fs = require('fs');" +
              "const path = require('path');" +
              `const dir = ${JSON.stringify(outputDirectory)};` +
              'fs.writeFileSync(path.join(dir, `${fs.readdirSync(dir).length}.txt`), process.cwd());' +
              'process.exit(1);',
          ),
        );

        await createCaseExecutableAdapter().probe(
          buildRequest({ executable: script, path: '/usr/bin:/bin', workingDirectory: work }),
        );

        const replicaCwd = await readFile(join(outputDirectory, '0.txt'), 'utf8');
        const parentCwd = await readFile(join(outputDirectory, '1.txt'), 'utf8');
        expect(replicaCwd).toBe(work);
        expect(parentCwd).toBe(work);
        expect(await readFile(join(work, 'marker.txt'), 'utf8')).toBe('hello\n');
      });

      it('runs both starts in one shared empty directory when no working directory is requested', async () => {
        const script = join(workspace, 'report-cwd.js');
        const outputDirectory = join(workspace, 'cwd-reports');
        await mkdir(outputDirectory, { recursive: true });
        await writeExecutable(
          script,
          nodeScript(
            "const fs = require('fs');" +
              "const path = require('path');" +
              `const dir = ${JSON.stringify(outputDirectory)};` +
              'fs.writeFileSync(path.join(dir, `${fs.readdirSync(dir).length}.txt`), process.cwd());' +
              'process.exit(1);',
          ),
        );

        await createCaseExecutableAdapter().probe(
          buildRequest({ executable: script, path: '/usr/bin:/bin' }),
        );

        const replicaCwd = await readFile(join(outputDirectory, '0.txt'), 'utf8');
        const parentCwd = await readFile(join(outputDirectory, '1.txt'), 'utf8');
        expect(replicaCwd).toBe(parentCwd);
        expect(replicaCwd).toMatch(/tevu-probe-.*\/work$/);
      });
    });

    describe('directory snapshot of a path entry working directory', () => {
      it('reports added, modified, and removed paths from one run, ignoring the ignored directory', async () => {
        const repository = await createRepositoryWithPendingChanges(workspace);
        const executable = join(workspace, 'edit-tree.sh');
        await writeExecutable(
          executable,
          shellScript(
            'printf "more\\n" >> edit.txt\n' +
              'printf "more\\n" >> dirty.txt\n' +
              'rm -f drop.txt loose.txt\n' +
              'mkdir -p new\n' +
              'printf "content\\n" > new/file.txt\n' +
              'mkdir -p ignored\n' +
              'printf "content\\n" > ignored/cache.txt\n' +
              'exit 0\n',
          ),
        );

        const result = await createCaseExecutableAdapter().probe(
          buildRequest({ executable, path: '/usr/bin:/bin', workingDirectory: repository }),
        );

        expect(result).toEqual({
          ok: true,
          value: {
            verdict: { verdict: 'runs' },
            changes: {
              runs: [
                {
                  run: 'replica',
                  added: ['new/file.txt'],
                  modified: ['dirty.txt', 'edit.txt'],
                  removed: ['drop.txt', 'loose.txt'],
                },
              ],
            },
          },
        });
        expect(await readFile(join(repository, 'edit.txt'), 'utf8')).toBe('edit\nmore\n');
        expect(await readFile(join(repository, 'dirty.txt'), 'utf8')).toBe(
          'dirty\nlocal edit\nmore\n',
        );
        expect(existsSync(join(repository, 'drop.txt'))).toBe(false);
        expect(existsSync(join(repository, 'loose.txt'))).toBe(false);
        expect(await readFile(join(repository, 'new/file.txt'), 'utf8')).toBe('content\n');
        expect(await readFile(join(repository, 'ignored/cache.txt'), 'utf8')).toBe('content\n');
      });

      it('leaves every file and the index untouched, and never starts core.fsmonitor, when nothing changes', async () => {
        const repository = await createRepositoryWithOneTrackedFile(workspace);
        const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
        await utimes(join(repository, 'tracked.txt'), future, future);
        const fsmonitorLog = join(workspace, 'fsmonitor.log');
        const fsmonitorScript = join(workspace, 'fsmonitor.sh');
        await writeExecutable(
          fsmonitorScript,
          shellScript(`echo start >> ${fsmonitorLog}\nexit 1\n`),
        );
        await runGit(repository, ['config', 'core.fsmonitor', fsmonitorScript]);
        const before = await snapshotTree(repository);
        const executable = join(workspace, 'no-op.sh');
        await writeExecutable(executable, shellScript('exit 0\n'));

        const result = await createCaseExecutableAdapter().probe(
          buildRequest({ executable, path: '/usr/bin:/bin', workingDirectory: repository }),
        );

        expect(result).toEqual({
          ok: true,
          value: {
            verdict: { verdict: 'runs' },
            changes: { runs: [{ run: 'replica', added: [], modified: [], removed: [] }] },
          },
        });
        expect(existsSync(fsmonitorLog)).toBe(false);
        expect(await snapshotTree(repository)).toEqual(before);
      });

      it('reports one changes entry per run when a file appears only in the parent run', async () => {
        const repository = await createRepositoryWithOneTrackedFile(workspace);
        const operatorHome = join(workspace, 'operator-home');
        await mkdir(operatorHome, { recursive: true });
        await writeFile(join(operatorHome, 'synthetic-pin'), 'present\n');
        process.env.HOME = operatorHome;
        const executable = join(workspace, 'parent-writes.sh');
        await writeExecutable(
          executable,
          shellScript(
            'if [ -f "$HOME/synthetic-pin" ]; then\n' +
              '  printf "parent\\n" > parent.txt\n' +
              '  exit 0\n' +
              'fi\n' +
              'exit 126\n',
          ),
        );

        const result = await createCaseExecutableAdapter().probe(
          buildRequest({ executable, path: '/usr/bin:/bin', workingDirectory: repository }),
        );

        expect(result).toEqual({
          ok: true,
          value: {
            verdict: {
              verdict: 'parent-only',
              resolvedPath: executable,
              replicaFailure: { kind: 'exited', exitCode: 126 },
            },
            changes: {
              runs: [
                { run: 'replica', added: [], modified: [], removed: [] },
                { run: 'parent', added: ['parent.txt'], modified: [], removed: [] },
              ],
            },
          },
        });
      });

      it('reports a could-not-check failure naming git status for a bare repository', async () => {
        const bareRepository = join(workspace, 'bare.git');
        await mkdir(bareRepository, { recursive: true });
        await runGit(bareRepository, ['init', '--quiet', '--bare']);
        const executable = join(workspace, 'ok.sh');
        await writeExecutable(executable, shellScript('exit 0\n'));

        const result = await createCaseExecutableAdapter().probe(
          buildRequest({ executable, path: '/usr/bin:/bin', workingDirectory: bareRepository }),
        );

        expect(result).toEqual({
          ok: true,
          value: {
            verdict: { verdict: 'runs' },
            changes: { runs: [], failure: 'git status exited with code 128' },
          },
        });
      });
    });
  });
});

describe('createEnvironmentAdapter unsetVariables', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the unset names in input order and skips a set name and an empty one', () => {
    vi.stubEnv('TEVU_TEST_SET', 'value');
    vi.stubEnv('TEVU_TEST_EMPTY', '');
    vi.stubEnv('TEVU_TEST_UNSET_B', undefined);
    vi.stubEnv('TEVU_TEST_UNSET_A', undefined);

    const unset = createEnvironmentAdapter().unsetVariables([
      'TEVU_TEST_UNSET_B',
      'TEVU_TEST_SET',
      'TEVU_TEST_UNSET_A',
      'TEVU_TEST_EMPTY',
    ]);

    expect(unset).toEqual(['TEVU_TEST_UNSET_B', 'TEVU_TEST_UNSET_A']);
  });

  it('returns nothing for no names', () => {
    expect(createEnvironmentAdapter().unsetVariables([])).toEqual([]);
  });
});

const POST_EXIT_GRACE_MS = 1_500;

/**
 * The direct child starts the descendant in its own process group, shares its
 * stdout, and exits at once. The descendant shares stderr too, unless
 * `stderrStdio` is `'ignore'`, which leaves the file-backed stdout as the only
 * channel that still reaches it.
 */
function scriptWithDescendant(
  descendantBody: string,
  stderrStdio: 'inherit' | 'ignore' = 'inherit',
): string {
  return (
    "const { spawn } = require('node:child_process');" +
    `spawn(process.execPath, ['-e', ${JSON.stringify(descendantBody)}], ` +
    `{ stdio: ${JSON.stringify(['ignore', 'inherit', stderrStdio])} }).unref();`
  );
}

/** Records its pid, writes `early` and then holds the inherited pipes open without writing again. */
function lingeringDescendant(pidFile: string): string {
  return (
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));` +
    "process.stdout.write('early');" +
    'setInterval(() => {}, 1000);'
  );
}

function expectLaunched(result: ManagedProcessResult): ManagedProcessCompletion {
  if (!result.launched) {
    throw new Error(`expected a launched process, got: ${result.reason}`);
  }
  return result;
}

function expectLaunchFailure(result: ManagedProcessResult): ManagedProcessLaunchFailure {
  if (result.launched) {
    throw new Error('expected a launch failure, got a launched process');
  }
  return result;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const statText = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    const state = statText.slice(statText.lastIndexOf(')') + 2)[0];
    return state !== 'Z';
  } catch {
    return false;
  }
}

describe('runManagedProcess post-exit window', () => {
  let directory = '';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tevu-post-exit-'));
  });

  afterEach(async () => {
    const pidFile = join(directory, 'descendant.pid');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // The descendant is already gone, which is the expected outcome.
      }
    }
    await rm(directory, { recursive: true, force: true });
  });

  function windowRequest(
    script: string,
    overrides: Partial<ManagedProcessRequest> = {},
  ): ManagedProcessRequest {
    return {
      argv: [process.execPath, '-e', script],
      cwd: directory,
      environment: {},
      timeoutMs: 30_000,
      terminationGraceMs: POST_EXIT_GRACE_MS,
      ...overrides,
    };
  }

  async function expectDescendantKilled(): Promise<void> {
    const descendantPid = Number(readFileSync(join(directory, 'descendant.pid'), 'utf8'));
    const deadline = performance.now() + 5_000;
    while (isRunning(descendantPid)) {
      if (performance.now() > deadline) {
        throw new Error(`descendant ${String(descendantPid)} was still running after 5s`);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }

  describe('a descendant that finishes inside the window', () => {
    it('captures every byte a descendant writes after the direct child exits', async () => {
      const payloadBytes = 1_000_000;
      const script = scriptWithDescendant(
        `setTimeout(() => process.stdout.write('x'.repeat(${String(payloadBytes)})), 200);`,
      );
      const streamed: string[] = [];

      const outcome = expectLaunched(
        await runManagedProcess(
          windowRequest(script, {
            maxCaptureBytes: 2_000_000,
            terminationGraceMs: 5_000,
            onStdout: (text) => streamed.push(text),
          }),
        ),
      );

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toMatchObject({
        totalBytes: payloadBytes,
        truncated: false,
        incomplete: false,
      });
      expect(outcome.stdout.text).toHaveLength(payloadBytes);
      expect(streamed.join('')).toHaveLength(payloadBytes);
    });

    it('reports incomplete false on both captures for a process with no descendants', async () => {
      const script = "process.stdout.write('out'); process.stderr.write('err');";

      const outcome = expectLaunched(await runManagedProcess(windowRequest(script)));

      expect(outcome.stdout).toEqual({
        text: 'out',
        totalBytes: 3,
        truncated: false,
        incomplete: false,
      });
      expect(outcome.stderr).toEqual({
        text: 'err',
        totalBytes: 3,
        truncated: false,
        incomplete: false,
      });
    });
  });

  describe('a file-backed stdout that only a descendant holds', () => {
    it('keeps every byte a descendant writes after the direct child exits and stops at the empty group', async () => {
      const payloadBytes = 1_000_000;
      const terminationGraceMs = 5_000;
      const script = scriptWithDescendant(
        `setTimeout(() => process.stdout.write('x'.repeat(${String(payloadBytes)})), 200);`,
        'ignore',
      );
      const streamed: string[] = [];
      const startedAtMs = performance.now();

      const outcome = expectLaunched(
        await runManagedProcess(
          windowRequest(script, {
            stdoutTarget: 'file',
            maxCaptureBytes: 2_000_000,
            terminationGraceMs,
            onStdout: (text) => streamed.push(text),
          }),
        ),
      );
      const elapsedMs = performance.now() - startedAtMs;

      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout).toMatchObject({
        totalBytes: payloadBytes,
        truncated: false,
        incomplete: false,
      });
      expect(outcome.stdout.text).toHaveLength(payloadBytes);
      expect(streamed.join('')).toHaveLength(payloadBytes);
      expect(elapsedMs).toBeLessThan(terminationGraceMs);
    });

    it('force-kills a descendant still holding the file after the grace and marks stdout incomplete', async () => {
      const script = scriptWithDescendant(
        lingeringDescendant(join(directory, 'descendant.pid')),
        'ignore',
      );
      const startedAtMs = performance.now();

      const outcome = expectLaunched(
        await runManagedProcess(windowRequest(script, { stdoutTarget: 'file' })),
      );
      const elapsedMs = performance.now() - startedAtMs;

      expect(elapsedMs).toBeGreaterThanOrEqual(POST_EXIT_GRACE_MS);
      expect(outcome).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationStage: 'none',
      });
      expect(outcome.durationMs).toBeLessThan(POST_EXIT_GRACE_MS);
      expect(outcome.stdout).toMatchObject({
        text: 'early',
        totalBytes: 5,
        truncated: false,
        incomplete: true,
      });
      await expectDescendantKilled();
    });
  });

  describe('a descendant that outlives the window', () => {
    it('force-kills a descendant still holding stdout after the grace and marks stdout incomplete', async () => {
      const script = scriptWithDescendant(lingeringDescendant(join(directory, 'descendant.pid')));
      const startedAtMs = performance.now();

      const outcome = expectLaunched(await runManagedProcess(windowRequest(script)));
      const elapsedMs = performance.now() - startedAtMs;

      expect(elapsedMs).toBeGreaterThanOrEqual(POST_EXIT_GRACE_MS);
      expect(outcome).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationStage: 'none',
      });
      expect(outcome.stdout).toMatchObject({
        text: 'early',
        totalBytes: 5,
        truncated: false,
        incomplete: true,
      });
      expect(outcome.stderr.incomplete).toBe(true);
      await expectDescendantKilled();
    });

    it("stops durationMs and endedAt at the direct child's exit", async () => {
      const terminationGraceMs = 2_000;
      const script = scriptWithDescendant(lingeringDescendant(join(directory, 'descendant.pid')));
      const startedAtMs = performance.now();

      const outcome = expectLaunched(
        await runManagedProcess(windowRequest(script, { terminationGraceMs })),
      );
      const elapsedMs = performance.now() - startedAtMs;

      expect(elapsedMs).toBeGreaterThanOrEqual(terminationGraceMs);
      expect(outcome.durationMs).toBeLessThan(terminationGraceMs);
      expect(Date.parse(outcome.endedAt) - Date.parse(outcome.startedAt)).toBeLessThan(
        terminationGraceMs,
      );
    });
  });

  describe('a timeout or cancellation that arrives after the direct child exited', () => {
    it('does not relabel a finished process when timeoutMs elapses inside the window', async () => {
      const terminationGraceMs = 2_500;
      const script = scriptWithDescendant(lingeringDescendant(join(directory, 'descendant.pid')));
      const startedAtMs = performance.now();

      const outcome = expectLaunched(
        await runManagedProcess(windowRequest(script, { timeoutMs: 1_200, terminationGraceMs })),
      );
      const elapsedMs = performance.now() - startedAtMs;

      expect(outcome).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationStage: 'none',
      });
      expect(elapsedMs).toBeGreaterThanOrEqual(terminationGraceMs);
      await expectDescendantKilled();
    });

    it('does not relabel a finished process when cancellation aborts inside the window', async () => {
      const controller = new AbortController();
      const abortShortlyAfterOutput = (): void => {
        setTimeout(() => controller.abort(), 300);
      };
      const script = scriptWithDescendant(lingeringDescendant(join(directory, 'descendant.pid')));
      const startedAtMs = performance.now();

      const outcome = expectLaunched(
        await runManagedProcess(
          windowRequest(script, {
            cancellation: controller.signal,
            onStdout: abortShortlyAfterOutput,
          }),
        ),
      );
      const elapsedMs = performance.now() - startedAtMs;

      expect(controller.signal.aborted).toBe(true);
      expect(outcome).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
        cancelled: false,
        terminationStage: 'none',
      });
      expect(elapsedMs).toBeGreaterThanOrEqual(POST_EXIT_GRACE_MS);
      await expectDescendantKilled();
    });
  });
});

const CAPTURE_SECRET = 'tevu-test-secret-value';

describe('runManagedProcess stdout file mode', () => {
  let workspace = '';
  let originalTmpdir: string | undefined;

  beforeEach(async () => {
    originalTmpdir = process.env.TMPDIR;
    workspace = await mkdtemp(join(tmpdir(), 'tevu-file-mode-'));
  });

  afterEach(async () => {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    await rm(workspace, { recursive: true, force: true });
  });

  function captureRequest(
    script: string,
    overrides: Partial<ManagedProcessRequest> = {},
  ): ManagedProcessRequest {
    return {
      argv: [process.execPath, '-e', script],
      cwd: workspace,
      environment: {},
      timeoutMs: 30_000,
      terminationGraceMs: 1_000,
      ...overrides,
    };
  }

  /** Runs a child that loses nothing: it exits only after its write drained, so any difference between modes comes from tevu. */
  async function captureInBothModes(
    outputExpression: string,
    overrides: Partial<ManagedProcessRequest>,
  ) {
    const script = `process.stdout.write(${outputExpression}, () => process.exit(0));`;
    const run = async (stdoutTarget: 'pipe' | 'file') => {
      const streamed: string[] = [];
      const outcome = expectLaunched(
        await runManagedProcess(
          captureRequest(script, {
            ...overrides,
            stdoutTarget,
            onStdout: (text) => streamed.push(text),
          }),
        ),
      );
      return { capture: outcome.stdout, streamed: streamed.join('') };
    };
    return { piped: await run('pipe'), filed: await run('file') };
  }

  it('hands the child a regular file without a name as stdout', async () => {
    const script =
      "const info = require('node:fs').fstatSync(1);" +
      'process.stdout.write(JSON.stringify({ isFile: info.isFile(), links: info.nlink }));';

    const outcome = expectLaunched(
      await runManagedProcess(captureRequest(script, { stdoutTarget: 'file' })),
    );

    expect(JSON.parse(outcome.stdout.text)).toEqual({ isFile: true, links: 0 });
  });

  describe('capture equivalence with pipe mode', () => {
    it.each([
      {
        label: 'a multibyte payload that a read boundary splits mid-character',
        outputExpression: "'a' + 'я'.repeat(100_000)",
        overrides: { maxCaptureBytes: 1_000_000 },
        expected: { totalBytes: 200_001, truncated: false, incomplete: false },
      },
      {
        label: 'output past maxCaptureBytes',
        outputExpression: "'z'.repeat(100_000)",
        overrides: { maxCaptureBytes: 1_000 },
        expected: { totalBytes: 100_000, truncated: true, incomplete: false },
      },
    ])('captures $label as pipe mode does', async ({ outputExpression, overrides, expected }) => {
      const { piped, filed } = await captureInBothModes(outputExpression, overrides);

      expect(filed.capture).toEqual(piped.capture);
      expect(filed.streamed).toBe(piped.streamed);
      expect(filed.capture).toMatchObject(expected);
    });

    it('redacts a secret value that straddles a read boundary as pipe mode does', async () => {
      const outputExpression = `'x'.repeat(65_530) + ${JSON.stringify(CAPTURE_SECRET)} + 'y'.repeat(1_000)`;

      const { piped, filed } = await captureInBothModes(outputExpression, {
        maxCaptureBytes: 1_000_000,
        secretValues: [CAPTURE_SECRET],
        stdoutRedaction: 'text',
      });

      expect(filed.capture).toEqual(piped.capture);
      expect(filed.streamed).toBe(piped.streamed);
      expect(filed.capture.text).toContain('[REDACTED]');
      expect(filed.capture.text).not.toContain(CAPTURE_SECRET);
      expect(filed.streamed).not.toContain(CAPTURE_SECRET);
    });
  });

  describe('temporary directory', () => {
    it('stays empty while the child runs and after the call resolves', async () => {
      const privateTmp = join(workspace, 'private-tmp');
      await mkdir(privateTmp);
      process.env.TMPDIR = privateTmp;
      const script = `process.stdout.write(JSON.stringify(require('node:fs').readdirSync(${JSON.stringify(privateTmp)})));`;

      const outcome = expectLaunched(
        await runManagedProcess(captureRequest(script, { stdoutTarget: 'file' })),
      );

      expect(outcome.stdout.text).toBe('[]');
      expect(await readdir(privateTmp)).toEqual([]);
    });

    it('stays empty when the executable does not exist', async () => {
      const privateTmp = join(workspace, 'private-tmp');
      await mkdir(privateTmp);
      process.env.TMPDIR = privateTmp;

      const failure = expectLaunchFailure(
        await runManagedProcess(
          captureRequest('', {
            argv: [join(workspace, 'tevu-test-no-such-executable')],
            stdoutTarget: 'file',
          }),
        ),
      );

      expect(failure.code).toBe('ENOENT');
      expect(failure.reason).not.toContain('stdout capture file');
      expect(await readdir(privateTmp)).toEqual([]);
    });

    it('reports a launch failure and never starts the command when the directory does not exist', async () => {
      process.env.TMPDIR = join(workspace, 'missing-tmp');
      const marker = join(workspace, 'ran.marker');
      const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`;

      const failure = expectLaunchFailure(
        await runManagedProcess(captureRequest(script, { stdoutTarget: 'file' })),
      );

      expect(failure.code).toBe('ENOENT');
      expect(failure.reason).toMatch(/^stdout capture file could not be prepared: /);
      expect(existsSync(marker)).toBe(false);
    });

    it.each([
      { label: 'file mode with an existing directory', stdoutTarget: 'file', isPresent: true },
      { label: 'pipe mode with a missing directory', stdoutTarget: 'pipe', isPresent: false },
    ] as const)('starts the command in $label', async ({ stdoutTarget, isPresent }) => {
      const privateTmp = join(workspace, 'private-tmp');
      if (isPresent) {
        await mkdir(privateTmp);
      }
      process.env.TMPDIR = privateTmp;
      const marker = join(workspace, 'ran.marker');
      const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`;

      const outcome = expectLaunched(
        await runManagedProcess(captureRequest(script, { stdoutTarget })),
      );

      expect(outcome.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(true);
    });
  });
});
