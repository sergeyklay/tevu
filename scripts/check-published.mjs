// Checks a release before its GitHub Release is published, in two phases.
//
//   node scripts/check-published.mjs run
//     TAG and RELEASE_RUN_ID name a successful release.yml run of this
//     repository for that tag's commit, whose package was attested and staged.
//     Writes version, commit, and prerelease to $GITHUB_OUTPUT.
//
//   node scripts/check-published.mjs package
//     The run's release-evidence in EVIDENCE_DIR holds the tarball its
//     checksums name; npm serves the same bytes as tag VERSION on its channel,
//     with provenance from this repository's release.yml at COMMIT; the public
//     package installs and runs. Copies the Release assets and notes to
//     ASSETS_DIR.
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const RELEASE_WORKFLOW = '.github/workflows/release.yml';
const SLSA_PROVENANCE = 'https://slsa.dev/provenance/v1';

class PublishedCheckFailure extends Error {}

function fail(message) {
  throw new PublishedCheckFailure(message);
}

function pass(message) {
  process.stdout.write(`ok: ${message}\n`);
}

function env(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is not set`);
  return value;
}

function run(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error) fail(`${argv.join(' ')} did not run: ${result.error.message}`);
  return result;
}

function runOk(argv, options) {
  const result = run(argv, options);
  if (result.status !== 0)
    fail(`${argv.join(' ')} exited ${result.status}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

function output(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

function parseTag() {
  const tag = env('TAG');
  const match = tag.startsWith('v') ? SEMVER.exec(tag.slice(1)) : null;
  if (!match) fail(`tag ${tag} is not v followed by a semantic version`);
  return { tag, version: tag.slice(1), prerelease: match[4] !== undefined };
}

async function github(path) {
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await globalThis.fetch(`${api}${path}`, {
    headers: {
      authorization: `Bearer ${env('GITHUB_TOKEN')}`,
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) fail(`GET ${path} answered ${response.status}`);
  return response.json();
}

async function checkRun() {
  if (process.env.GITHUB_REF && process.env.GITHUB_REF !== 'refs/heads/main') {
    fail(`finalization runs only from main, not ${process.env.GITHUB_REF}`);
  }
  const { tag, version, prerelease } = parseTag();
  const runId = env('RELEASE_RUN_ID');
  if (!/^\d+$/.test(runId)) fail(`release run ID ${runId} is not a number`);
  const repository = env('GITHUB_REPOSITORY');

  const commit = runOk(['git', 'rev-parse', `refs/tags/${tag}^{commit}`]).trim();
  const releaseRun = await github(`/repos/${repository}/actions/runs/${runId}`);
  const expected = {
    repository: [releaseRun.repository?.full_name, repository],
    workflow: [releaseRun.path, RELEASE_WORKFLOW],
    ref: [releaseRun.head_branch, tag],
    commit: [releaseRun.head_sha, commit],
    status: [releaseRun.status, 'completed'],
    conclusion: [releaseRun.conclusion, 'success'],
  };
  for (const [field, [actual, wanted]] of Object.entries(expected)) {
    if (actual !== wanted) fail(`release run ${runId} has ${field} ${actual}, expected ${wanted}`);
  }
  if (!['push', 'workflow_dispatch'].includes(releaseRun.event))
    fail(`release run ${runId} was started by ${releaseRun.event}`);

  const { jobs } = await github(`/repos/${repository}/actions/runs/${runId}/jobs?per_page=100`);
  for (const name of ['Attest package', 'Stage on npm']) {
    const job = jobs.find((item) => item.name === name);
    if (job?.conclusion !== 'success')
      fail(
        `release run ${runId} did not run ${name} successfully (${job?.conclusion ?? 'absent'})`,
      );
  }
  output({ version, commit, prerelease });
  pass(`release run ${runId} built, attested, and staged ${tag} at ${commit}`);
}

function digests(file) {
  const bytes = readFileSync(file);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha512: createHash('sha512').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

function checksum(file, name) {
  const line = readFileSync(file, 'utf8')
    .split('\n')
    .find((entry) => entry.endsWith(`  ${name}`));
  if (!line) fail(`${file} has no checksum for ${name}`);
  return line.split(' ')[0];
}

function releaseNotes(commit, version) {
  const lines = runOk(['git', 'show', `${commit}:CHANGELOG.md`]).split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) fail(`CHANGELOG.md at ${commit} has no section for ${version}`);
  const end = lines.findIndex(
    (line, index) => index > start && (line.startsWith('## [') || /^\[[^\]]+\]: /.test(line)),
  );
  const notes = lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
  if (notes === '') fail(`the CHANGELOG.md section for ${version} is empty`);
  return `${notes}\n`;
}

async function checkProvenance(dist, tag, commit, sha512) {
  if (dist.attestations?.provenance?.predicateType !== SLSA_PROVENANCE)
    fail('npm lists no SLSA provenance for this version');
  const response = await globalThis.fetch(dist.attestations.url);
  if (!response.ok) fail(`GET ${dist.attestations.url} answered ${response.status}`);
  const { attestations } = await response.json();
  const statement = attestations
    .filter((item) => item.predicateType === SLSA_PROVENANCE)
    .map((item) =>
      JSON.parse(Buffer.from(item.bundle.dsseEnvelope.payload, 'base64').toString('utf8')),
    )[0];
  if (!statement) fail('the npm attestations hold no SLSA provenance statement');
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  const builtFrom =
    statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit;
  const repositoryUrl = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env('GITHUB_REPOSITORY')}`;
  const expected = {
    subject: [statement.subject?.[0]?.digest?.sha512, sha512],
    repository: [workflow.repository, repositoryUrl],
    workflow: [workflow.path, RELEASE_WORKFLOW],
    ref: [workflow.ref, `refs/tags/${tag}`],
    commit: [builtFrom, commit],
  };
  for (const [field, [actual, wanted]] of Object.entries(expected)) {
    if (actual !== wanted) fail(`npm provenance has ${field} ${actual}, expected ${wanted}`);
  }
}

async function checkPublicInstall(version) {
  const parent = await mkdtemp(join(tmpdir(), 'tevu-finalize-'));
  const consumer = join(parent, 'tevu-finalize-consumer');
  try {
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'tevu-finalize-consumer', version: '1.0.0', private: true }),
    );
    runOk(
      [
        'npm',
        'install',
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `@serghei/tevu@${version}`,
      ],
      { cwd: consumer },
    );
    const printed = runOk([join(consumer, 'node_modules', '.bin', 'tevu'), '--version'], {
      cwd: consumer,
    }).trim();
    if (printed !== version) fail(`the public @serghei/tevu@${version} prints version ${printed}`);
    runOk(['npm', 'audit', 'signatures'], { cwd: consumer });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

async function checkPackage() {
  const { tag, version, prerelease } = parseTag();
  const commit = env('COMMIT');
  const evidence = env('EVIDENCE_DIR');
  const assets = env('ASSETS_DIR');
  const filename = `serghei-tevu-${version}.tgz`;
  const tarball = join(evidence, 'package', filename);

  const manifest = JSON.parse(readFileSync(join(evidence, 'manifest.json'), 'utf8'));
  if (manifest.tag !== tag || manifest.commit !== commit || manifest.version !== version) {
    fail(
      `release-evidence describes ${manifest.tag} at ${manifest.commit}, not ${tag} at ${commit}`,
    );
  }
  const local = digests(tarball);
  if (checksum(join(evidence, 'build-evidence', 'SHA256SUMS'), filename) !== local.sha256)
    fail(`${filename} differs from its SHA-256`);
  if (checksum(join(evidence, 'build-evidence', 'SHA512SUMS'), filename) !== local.sha512)
    fail(`${filename} differs from its SHA-512`);
  const staged = JSON.parse(
    readFileSync(join(evidence, 'stage-evidence', 'stage-evidence.json'), 'utf8'),
  );
  if (staged.integrity !== local.integrity)
    fail(`the run staged ${staged.integrity}, not ${local.integrity}`);
  pass(`${filename} matches its checksums and the staged integrity`);

  const view = run(['npm', 'view', `@serghei/tevu@${version}`, 'dist', 'dist-tags', '--json']);
  if (view.status !== 0)
    fail(`npm does not serve @serghei/tevu@${version}; approve its stage first\n${view.stderr}`);
  const published = JSON.parse(view.stdout);
  if (published.dist?.integrity !== local.integrity)
    fail(`npm serves ${published.dist?.integrity}, not ${local.integrity}`);
  const channel = prerelease ? 'next' : 'latest';
  if (published['dist-tags']?.[channel] !== version) {
    fail(`npm channel ${channel} points at ${published['dist-tags']?.[channel]}, not ${version}`);
  }
  if (prerelease && published['dist-tags']?.latest === version)
    fail(`npm channel latest points at prerelease ${version}`);
  await checkProvenance(published.dist, tag, commit, local.sha512);
  pass(
    `npm serves the same bytes on ${channel} with provenance from ${RELEASE_WORKFLOW} at ${commit}`,
  );

  await checkPublicInstall(version);
  pass(
    `@serghei/tevu@${version} installs from npm, prints its version, and passes npm audit signatures`,
  );

  mkdirSync(assets, { recursive: true });
  copyFileSync(tarball, join(assets, filename));
  for (const name of ['SHA256SUMS', 'SHA512SUMS'])
    copyFileSync(join(evidence, 'build-evidence', name), join(assets, name));
  copyFileSync(
    join(evidence, 'sbom', `tevu-${version}.cdx.json`),
    join(assets, `tevu-${version}.cdx.json`),
  );
  writeFileSync(join(assets, 'release-notes.md'), releaseNotes(commit, version));
  output({ filename });
  pass(`Release assets and notes written to ${assets}`);
}

const phases = { run: checkRun, package: checkPackage };

try {
  const phase = phases[process.argv[2]];
  if (!phase) fail('usage: node scripts/check-published.mjs run|package');
  await phase();
} catch (error) {
  if (!(error instanceof PublishedCheckFailure)) throw error;
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
