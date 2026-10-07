// Checks a packed tevu tarball the way a user receives it: installed from the
// archive alone into a directory outside the checkout, with production
// dependencies only, and run with a PATH that holds Node.js and Git but no Bun.
//
// Usage: node scripts/check-package.mjs <tarball> <expected-version>
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import process from 'node:process';

const checkoutRoot = resolve(import.meta.dirname, '..');
const fakeAgentSource = join(checkoutRoot, 'src', '__fixtures__', 'fake-opencode.mjs');

// npm always packs package.json, README, and LICENSE; `files` adds dist.
const EXPECTED_FILES = ['LICENSE', 'README.md', 'dist/index.js', 'package.json'];
const EXPECTED_BIN = { tevu: 'dist/index.js' };
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall'];

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message);
}

function pass(message) {
  process.stdout.write(`ok: ${message}\n`);
}

function run(argv, options) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
    ...options,
  });
  if (result.error) fail(`${argv.join(' ')} did not run: ${result.error.message}`);
  return result;
}

function runOk(argv, options) {
  const result = run(argv, options);
  if (result.status !== 0) {
    fail(`${argv.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function digests(file) {
  const bytes = readFileSync(file);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

function listFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`],
  );
}

function findExecutable(name, searchPath) {
  for (const directory of searchPath.split(delimiter)) {
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return undefined;
}

/** Every package installed under `node_modules`, nested trees included. */
function installedPackages(nodeModules) {
  if (!existsSync(nodeModules)) return [];
  return readdirSync(nodeModules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const directory = join(nodeModules, entry.name);
      if (entry.name.startsWith('@')) return installedPackages(directory);
      const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      return [{ manifest, directory }, ...installedPackages(join(directory, 'node_modules'))];
    });
}

async function checkArchive(tarball, expectedVersion, scratch) {
  const extracted = join(scratch, 'extracted');
  await mkdir(extracted);
  runOk(['tar', '-xzf', tarball, '-C', extracted]);
  const packageDirectory = join(extracted, 'package');
  const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));

  if (manifest.name !== '@serghei/tevu')
    fail(`archive name is ${manifest.name}, expected @serghei/tevu`);
  if (manifest.version !== expectedVersion) {
    fail(`archive version is ${manifest.version}, expected ${expectedVersion}`);
  }
  if (JSON.stringify(manifest.bin) !== JSON.stringify(EXPECTED_BIN)) {
    fail(
      `archive bin is ${JSON.stringify(manifest.bin)}, expected ${JSON.stringify(EXPECTED_BIN)}`,
    );
  }
  const files = listFiles(packageDirectory).sort();
  if (JSON.stringify(files) !== JSON.stringify(EXPECTED_FILES)) {
    fail(`archive holds ${files.join(', ')}; expected ${EXPECTED_FILES.join(', ')}`);
  }
  const entry = await readFile(join(packageDirectory, EXPECTED_BIN.tevu), 'utf8');
  if (!entry.startsWith('#!/usr/bin/env node\n'))
    fail('dist/index.js does not start with a node shebang');
  pass(`archive is tevu ${manifest.version} with ${files.join(', ')}`);
  return manifest;
}

/** The PATH the installed CLI runs with: this Node.js, Git, and the system directories. */
function consumerPath() {
  const git = findExecutable('git', process.env.PATH ?? '');
  if (!git) fail('git is not on PATH');
  const directories = [dirname(process.execPath), dirname(git), '/usr/bin', '/bin'];
  const searchPath = [...new Set(directories)].join(delimiter);
  const bun = findExecutable('bun', searchPath);
  if (bun)
    fail(
      `bun is reachable on the consumer PATH at ${bun}; cannot prove the package runs without it`,
    );
  return searchPath;
}

async function install(consumer, tarball, ignoreScripts) {
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'tevu-package-check', version: '0.0.0', private: true }),
  );
  const npm = findExecutable('npm', process.env.PATH ?? '');
  if (!npm) fail('npm is not on PATH');
  const flags = [
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    ...(ignoreScripts ? ['--ignore-scripts'] : []),
  ];
  runOk([npm, 'install', ...flags, tarball], { cwd: consumer });
  pass(`installed with npm install ${flags.join(' ')}`);
}

function checkInstalledTree(consumer, manifest) {
  const packages = installedPackages(join(consumer, 'node_modules'));
  const devDependencies = Object.keys(manifest.devDependencies ?? {});
  const leaked = packages.filter((item) => devDependencies.includes(item.manifest.name));
  if (leaked.length > 0) {
    fail(`devDependencies installed: ${leaked.map((item) => item.manifest.name).join(', ')}`);
  }
  pass(`${packages.length} installed packages, none of ${devDependencies.length} devDependencies`);
  return packages
    .filter((item) => LIFECYCLE_SCRIPTS.some((name) => item.manifest.scripts?.[name]))
    .map((item) => item.manifest.name);
}

async function checkCommands(consumer, expectedVersion, environment) {
  const tevu = join(consumer, 'node_modules', '.bin', 'tevu');
  const real = await realpath(tevu);
  if (relative(consumer, real).startsWith('..'))
    fail(`tevu resolves outside the consumer: ${real}`);
  const options = { cwd: consumer, env: environment };

  const version = runOk([tevu, '--version'], options).stdout.trim();
  if (version !== expectedVersion)
    fail(`tevu --version printed ${version}, expected ${expectedVersion}`);
  if (!runOk([tevu, '--help'], options).stdout.includes('Usage:'))
    fail('tevu --help printed no usage');
  if (!runOk([tevu, 'run', '--help'], options).stdout.includes('--dry-run')) {
    fail('tevu run --help did not list --dry-run');
  }
  pass('tevu --version, --help, and run --help');
  return tevu;
}

async function createSyntheticRepository(directory, environment) {
  await mkdir(directory);
  // The host's system Git configuration could sign or hook the commit.
  const gitEnvironment = {
    ...environment,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const git = (args) => runOk(['git', ...args], { cwd: directory, env: gitEnvironment });
  git(['init', '--quiet', '-b', 'main']);
  await writeFile(join(directory, 'README.md'), 'synthetic\n');
  git(['add', '-A']);
  git([
    '-c',
    'user.name=tevu',
    '-c',
    'user.email=tevu@localhost',
    'commit',
    '--quiet',
    '-m',
    'base',
  ]);
  return git(['rev-parse', 'HEAD']).stdout.trim();
}

/** Every file under `directory` with its SHA-256, for comparing a run before and after `tevu report`. */
async function snapshot(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return Object.fromEntries(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort()
      .map((file) => [relative(directory, file), digests(file).sha256]),
  );
}

async function checkOfflineBenchmark(consumer, tevu, environment) {
  const fixture = join(consumer, 'fixture');
  await mkdir(join(fixture, 'config', 'opencode'), { recursive: true });
  const agent = join(fixture, 'fake-opencode.mjs');
  await cp(fakeAgentSource, agent);
  await chmod(agent, 0o755);
  await writeFile(
    join(fixture, 'config', 'opencode', 'opencode.json'),
    JSON.stringify({ provider: { acme: { baseURL: 'https://acme.example.test', options: {} } } }),
  );
  const baseCommit = await createSyntheticRepository(join(fixture, 'repo'), environment);
  const readmeCheck = (id) => ({
    id,
    description: 'The README is present',
    run: 'test -f README.md',
    timeout: '10s',
  });
  const config = {
    version: 1,
    run: { output_dir: join(fixture, 'runs'), concurrency: 1, timeout: '30s', stop_grace: '500ms' },
    agents: {
      opencode: {
        command: agent,
        secrets: ['ACME_KEY'],
        providers: [{ id: 'acme', api_key: 'ACME_KEY' }],
      },
    },
    repositories: [{ id: 'repo', path: join(fixture, 'repo') }],
    models: [
      { id: 'alpha', model: 'acme/synthetic-model-a', effort: 'high' },
      { id: 'beta', model: 'acme/synthetic-model-b', effort: 'high' },
    ],
    tasks: [
      {
        id: 'task',
        title: 'Package check task',
        repo: 'repo',
        base_commit: baseCommit,
        description: 'synthetic task description',
        prompt: 'synthetic task prompt',
        readiness: ['synthetic ready item'],
        checks: { acceptance: [readmeCheck('readme-present')], done: [readmeCheck('readme-kept')] },
      },
    ],
  };
  // YAML is a superset of JSON, so the configuration needs no YAML writer.
  const configPath = join(fixture, 'tevu.yaml');
  await writeFile(configPath, JSON.stringify(config, null, 2));
  const options = {
    cwd: fixture,
    env: {
      ...environment,
      XDG_CONFIG_HOME: join(fixture, 'config'),
      ACME_KEY: 'synthetic-acme-secret-value',
    },
  };

  runOk([tevu, 'validate', '--config', configPath], options);
  runOk([tevu, 'run', '--config', configPath], options);
  const [runId, ...others] = await readdir(join(fixture, 'runs'));
  if (!runId || others.length > 0)
    fail(`expected one run directory, found ${[runId, ...others].join(', ')}`);
  const runDirectory = join(fixture, 'runs', runId);
  const result = JSON.parse(await readFile(join(runDirectory, 'result.json'), 'utf8'));
  const passed = result.pairs.reduce((sum, pair) => sum + pair.outcomes.passed, 0);
  if (result.pairs.length !== 2 || !result.pairs.every((pair) => pair.allPassed)) {
    fail(`expected both model settings to pass, got ${JSON.stringify(result.pairs)}`);
  }

  const before = await snapshot(runDirectory);
  runOk([tevu, 'report', runId, '--config', configPath], options);
  const after = await snapshot(runDirectory);
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('tevu report changed the saved run');
  pass(`offline benchmark: validate, run (${passed} cases passed), and an identical report`);
}

async function checkConsumer(consumer, tarball, manifest, expectedVersion, ignoreScripts) {
  await install(consumer, tarball, ignoreScripts);
  const scripted = checkInstalledTree(consumer, manifest);
  const home = join(consumer, 'home');
  await mkdir(home);
  const environment = { PATH: consumerPath(), HOME: home };
  const tevu = await checkCommands(consumer, expectedVersion, environment);
  await checkOfflineBenchmark(consumer, tevu, environment);
  return scripted;
}

async function main(argv) {
  const [tarballArgument, expectedVersion] = argv;
  if (!tarballArgument || !expectedVersion)
    fail('usage: node scripts/check-package.mjs <tarball> <expected-version>');
  const tarball = resolve(tarballArgument);
  const digest = digests(tarball);

  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'tevu-package-check-')));
  try {
    if (!relative(await realpath(checkoutRoot), scratch).startsWith('..')) {
      fail(`the temporary directory ${scratch} is inside the checkout`);
    }
    const manifest = await checkArchive(tarball, expectedVersion, scratch);
    const scripted = await checkConsumer(
      join(scratch, 'ignore-scripts'),
      tarball,
      manifest,
      expectedVersion,
      true,
    );
    if (scripted.length > 0) {
      process.stdout.write(
        `install scripts declared by ${scripted.join(', ')}; checking a plain install\n`,
      );
      await checkConsumer(join(scratch, 'with-scripts'), tarball, manifest, expectedVersion, false);
    }
    const after = digests(tarball);
    if (after.sha256 !== digest.sha256) fail('the archive changed while it was checked');
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  process.stdout.write(`sha256 ${digest.sha256}\nintegrity ${digest.integrity}\n`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof CheckFailure)) throw error;
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
