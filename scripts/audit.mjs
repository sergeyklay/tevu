// Audits the dependency tree locked in bun.lock and the production tree npm
// installs from a packed tevu tarball, failing on any high or critical
// advisory that .github/audit-exceptions.json does not excuse.
//
// Run from the project root: node scripts/audit.mjs <tarball>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const projectRoot = process.cwd();
const exceptionsPath = join(projectRoot, '.github', 'audit-exceptions.json');
const BLOCKING = new Set(['high', 'critical']);
const ADVISORY_ID = /^GHSA(-[0-9a-z]{4}){3}$/;

class AuditFailure extends Error {}

function fail(message) {
  throw new AuditFailure(message);
}

function run(argv, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`${argv.join(' ')} did not run: ${result.error.message}`);
  return result;
}

/** A tool's JSON report, or a failure: unparsable output means the audit did not happen. */
function parseReport(argv, result, isReport) {
  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    report = undefined;
  }
  if (!isReport(report)) {
    fail(
      `${argv.join(' ')} exited ${result.status} without a report\n${result.stdout}${result.stderr}`,
    );
  }
  return report;
}

function advisoryId(url) {
  return String(url ?? '')
    .split('/')
    .pop();
}

function loadExceptions(today) {
  const exceptions = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
  if (!Array.isArray(exceptions)) fail(`${exceptionsPath} must hold a JSON array`);
  for (const [index, entry] of exceptions.entries()) {
    const where = `${exceptionsPath} entry ${index}`;
    if (!ADVISORY_ID.test(entry.advisory ?? ''))
      fail(`${where}: advisory must be a GHSA identifier`);
    for (const field of ['package', 'owner', 'reason']) {
      if (typeof entry[field] !== 'string' || entry[field].trim() === '')
        fail(`${where}: ${field} is required`);
    }
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '') ||
      Number.isNaN(Date.parse(entry.expires))
    ) {
      fail(`${where}: expires must be a YYYY-MM-DD date`);
    }
    if (entry.expires < today) {
      fail(
        `${where}: the exception for ${entry.advisory} expired on ${entry.expires}; fix or renew it`,
      );
    }
  }
  return exceptions;
}

function lockfileAdvisories() {
  const argv = ['bun', 'audit', '--json', '--audit-level=high'];
  const result = run(argv, projectRoot);
  const report = parseReport(argv, result, (value) => value !== null && typeof value === 'object');
  const advisories = Object.entries(report).flatMap(([name, entries]) =>
    entries.map((entry) => ({
      package: name,
      advisory: advisoryId(entry.url),
      severity: entry.severity,
      title: entry.title,
    })),
  );
  if (result.status !== 0 && advisories.length === 0) {
    fail(`${argv.join(' ')} exited ${result.status} with an empty report\n${result.stderr}`);
  }
  return advisories;
}

async function runtimeAdvisories(tarball) {
  const consumer = await realpath(await mkdtemp(join(tmpdir(), 'tevu-audit-')));
  try {
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({ name: 'tevu-audit', version: '0.0.0', private: true }),
    );
    const install = [
      'npm',
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      tarball,
    ];
    const installed = run(install, consumer);
    if (installed.status !== 0)
      fail(`${install.join(' ')} exited ${installed.status}\n${installed.stderr}`);

    const argv = ['npm', 'audit', '--omit=dev', '--json'];
    const report = parseReport(
      argv,
      run(argv, consumer),
      (value) => typeof value?.vulnerabilities === 'object',
    );
    return Object.values(report.vulnerabilities).flatMap((vulnerability) =>
      vulnerability.via
        .filter((via) => typeof via === 'object')
        .map((via) => ({
          package: via.name,
          advisory: advisoryId(via.url),
          severity: via.severity,
          title: via.title,
        })),
    );
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

function describe(advisory) {
  return `${advisory.severity} ${advisory.advisory} in ${advisory.package}: ${advisory.title}`;
}

async function main(argv) {
  const [tarballArgument] = argv;
  if (!tarballArgument) fail('usage: node scripts/audit.mjs <tarball>');
  const today = new Date().toISOString().slice(0, 10);
  const exceptions = loadExceptions(today);

  const sources = [
    ['bun.lock', lockfileAdvisories()],
    ['runtime install', await runtimeAdvisories(resolve(tarballArgument))],
  ];
  const excused = new Set();
  const blocking = [];
  for (const [source, advisories] of sources) {
    const unique = new Map(advisories.map((item) => [`${item.package} ${item.advisory}`, item]));
    for (const advisory of unique.values()) {
      if (!BLOCKING.has(advisory.severity)) continue;
      const exception = exceptions.find(
        (entry) => entry.advisory === advisory.advisory && entry.package === advisory.package,
      );
      if (exception) {
        excused.add(exception);
        process.stdout.write(
          `excused until ${exception.expires} by ${exception.owner}: ${describe(advisory)}\n`,
        );
      } else {
        blocking.push(`${source}: ${describe(advisory)}`);
      }
    }
    process.stdout.write(`ok: audited ${source}\n`);
  }
  for (const exception of exceptions.filter((entry) => !excused.has(entry))) {
    process.stdout.write(
      `warning: ${exception.advisory} in ${exception.package} is no longer reported; remove its exception\n`,
    );
  }
  if (blocking.length > 0) fail(`blocking advisories:\n${blocking.join('\n')}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (!(error instanceof AuditFailure)) throw error;
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
