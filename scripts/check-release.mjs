// Decides whether the ref a release run started from may be released: a
// signed v<semver> tag, signed by a key in .github/release-keys/, naming a
// commit on main whose package.json carries the same version.
//
// Run from the root of a full clone with origin/main fetched:
//   GITHUB_REF=refs/tags/v1.2.3 GITHUB_SHA=<commit> node scripts/check-release.mjs
// Writes version, tag, and channel to $GITHUB_OUTPUT when it is set.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const KEYS_DIRECTORY = join('.github', 'release-keys');
const MAIN = 'refs/remotes/origin/main';
// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

class ReleaseRefError extends Error {}

function fail(message) {
  throw new ReleaseRefError(message);
}

function git(args, env) {
  return spawnSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

function gitOut(args) {
  const result = git(args);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function releaseTag(ref) {
  if (!ref?.startsWith('refs/tags/'))
    fail(`${ref || 'an empty ref'} is not a tag; releases start only from a v<version> tag`);
  const tag = ref.slice('refs/tags/'.length);
  const match = tag.startsWith('v') ? SEMVER.exec(tag.slice(1)) : null;
  if (!match) fail(`tag ${tag} is not v followed by a semantic version`);
  return { tag, prerelease: match[4] !== undefined };
}

async function verifySignature(tag) {
  const keys = readdirSync(KEYS_DIRECTORY).filter((name) => name.endsWith('.asc'));
  if (keys.length === 0) fail(`${KEYS_DIRECTORY} holds no .asc key`);
  const keyring = await mkdtemp(join(tmpdir(), 'tevu-release-keyring-'));
  try {
    for (const key of keys) {
      const imported = spawnSync(
        'gpg',
        ['--homedir', keyring, '--batch', '--import', join(KEYS_DIRECTORY, key)],
        {
          encoding: 'utf8',
        },
      );
      if (imported.status !== 0) fail(`gpg could not import ${key}: ${imported.stderr.trim()}`);
    }
    // The keyring holds only the trusted keys, so any good signature is a trusted one.
    const verified = git(['-c', 'gpg.format=openpgp', 'verify-tag', tag], { GNUPGHOME: keyring });
    if (verified.status !== 0)
      fail(`tag ${tag} has no valid signature from a key in ${KEYS_DIRECTORY}`);
  } finally {
    await rm(keyring, { recursive: true, force: true });
  }
}

async function main() {
  const { tag, prerelease } = releaseTag(process.env.GITHUB_REF);
  const version = tag.slice(1);
  const commit = process.env.GITHUB_SHA;
  if (!commit) fail('GITHUB_SHA is not set');

  if (gitOut(['cat-file', '-t', `refs/tags/${tag}`]) !== 'tag') {
    fail(`tag ${tag} is lightweight; release tags are signed annotated tags`);
  }
  const tagged = gitOut(['rev-parse', `refs/tags/${tag}^{commit}`]);
  if (tagged !== commit) fail(`tag ${tag} names ${tagged}, but the run is for ${commit}`);
  await verifySignature(tag);

  if (git(['merge-base', '--is-ancestor', commit, MAIN]).status !== 0) {
    fail(`commit ${commit} is not on main`);
  }

  const manifest = JSON.parse(gitOut(['show', `${commit}:package.json`]));
  if (manifest.name !== '@serghei/tevu')
    fail(`package.json names ${manifest.name}, not @serghei/tevu`);
  if (manifest.version !== version)
    fail(`package.json has version ${manifest.version}, but the tag is ${tag}`);

  const channel = prerelease ? 'next' : 'latest';
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version}\ntag=${tag}\nchannel=${channel}\n`,
    );
  }
  process.stdout.write(
    `ok: ${tag} is signed by a trusted key, on main, and matches package.json; channel ${channel}\n`,
  );
}

try {
  await main();
} catch (error) {
  if (!(error instanceof ReleaseRefError)) throw error;
  process.stderr.write(`error: ${error.message}\n`);
  process.exitCode = 1;
}
