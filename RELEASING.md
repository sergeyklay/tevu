# Releasing tevu

How a maintainer publishes a tevu version to npm and GitHub, and how to recover when a release stops halfway. The procedure is the same for every version; the one-time setup runs before the first.

> [!IMPORTANT]
> The release automation this procedure relies on is not in the repository yet: the `release.yml` and `finalize-release.yml` workflows, the `npm-release` environment, and the ruleset that protects `v*` tags. Until they exist, only [Prepare the release pull request](#1-prepare-the-release-pull-request), [Rehearse without publishing](#rehearse-without-publishing), and the npm commands in [Recover a release](#recover-a-release) can run.

## How a release flows

A version moves through four places, and each one has its own guard:

1. A reviewed pull request on `main` sets the version in `package.json` and its section in [CHANGELOG.md](CHANGELOG.md).
2. The maintainer signs a tag on that merge commit and pushes it. The push starts `release.yml`, which checks the tag, builds one tarball, tests it, and stages it on npm. CI can stage a version but never make it public.
3. The maintainer downloads the staged tarball, checks it, and approves it with npm 2FA. Only then is the version public.
4. `finalize-release.yml` checks the public npm version and creates the GitHub Release from the same tarball and the changelog section.

## Access

| Who | Holds | Used for |
| --- | --- | --- |
| Release owner: [@sergeyklay](https://github.com/sergeyklay) | GitHub admin on `sergeyklay/tevu`; npm owner of `tevu` with 2FA; the PGP key that signs release tags | Merging the release pull request, signing tags, approving and rejecting stages, `npm deprecate` and `npm dist-tag` |
| `release.yml` stage job | A short-lived npm OIDC token through the `npm-release` environment | `npm stage publish` only |
| `finalize-release.yml` final job | `contents: write` on the repository | Creating the GitHub Release |

No npm token is stored in repository secrets, and the signing key never enters GitHub Actions. Recovery codes for GitHub and npm stay outside the repository. The release owner watches failures of the release and docs workflows and the private vulnerability reports described in [SECURITY.md](SECURITY.md).

## Tools

| Tool | Version | Why |
| --- | --- | --- |
| Node.js | 24, from `engines` in [package.json](package.json) | Runs the build and the packed CLI |
| Bun | From `packageManager` in [package.json](package.json) | Installs and builds with the frozen lockfile |
| npm | 11.21.0 | Has `npm stage` and `npm trust`; install it in the release environment with `npm install --global npm@11.21.0` |
| Git and GnuPG | Any current | Signed annotated tags |
| GitHub CLI (`gh`) | Any current | Watching runs and dispatching `finalize-release.yml` |

Change a pinned version through a pull request that updates this table.

## Versions and channels

tevu follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until `1.0.0`:

- A change that breaks the CLI, the configuration contract (`version: 1`), or the layout of saved run artifacts raises the minor version and carries a `Migration` section in the changelog.
- A fix or addition that breaks nothing raises the patch version.

| Version | Example | npm channel | GitHub Release |
| --- | --- | --- | --- |
| Release candidate | `0.1.0-rc.1` | `next` | Marked as a prerelease |
| Release | `0.1.0` | `latest` | Marked as the latest release |

The tag is `v` followed by the version, for example `v0.1.0-rc.1`. A release candidate is never renamed into a release: `0.1.0` is a new pull request, tag, and tarball. A tag that names a published version never moves.

Supported platforms are Linux and macOS with Node.js 24. A new Node.js major enters `engines` only after CI tests it.

## Changelog

[CHANGELOG.md](CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and is the only source of release notes.

- Every pull request that changes what a user can observe adds an entry under `## [Unreleased]` and describes the outcome for a user, not the commits.
- The release pull request renames `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, adds an empty `## [Unreleased]` above it, and updates the comparison links at the bottom.
- Next to the standard categories, a version may have three more sections. `Requirements` lists what a user must install or run. `Migration` lists what a user must change after upgrading. `Known limitations` lists what the version does not do that a user could expect. Release notes keep all three.
- A release that changes behavior without a changelog entry does not ship. The reviewer of the release pull request blocks it.
- Links in a version's section are absolute GitHub URLs at that version's tag, because the section becomes the GitHub Release body.

The GitHub Release body is the version's section, extracted unchanged:

```sh
version="$(node -p "require('./package.json').version")"
awk -v heading="## [$version]" '
  index($0, heading) == 1 { found = 1; next }
  found && /^## \[/ { exit }
  found && /^\[[^]]+\]: / { exit }
  found { print }
' CHANGELOG.md > release-notes.md
test -s release-notes.md
```

## Signing key

`release.yml` accepts a tag only when its signature verifies against a public key in `.github/release-keys/`. That directory is the release trust root: anyone whose key is in it can cut a release, so it changes only through a reviewed pull request.

| File | Owner | Primary key fingerprint | Signing subkey | Expires |
| --- | --- | --- | --- | --- |
| `maintainer.asc` | [@sergeyklay](https://github.com/sergeyklay) | `EDAC 8D91 F82C 0BBD 261C 1329 1E0B 5331 219B EA88` | `C6AF1016BBDEA800` | 2027-01-03 |

The secret primary key stays offline; only the subkeys live on the signing machine, and no secret key enters the repository or GitHub Actions. A tag signed before the key expires still verifies afterwards, but an expired key signs no new tag. After extending the expiry or adding a subkey, export the public key again and open a pull request before the next release:

```sh
gpg --armor --export-options export-minimal --output .github/release-keys/maintainer.asc --export EDAC8D91F82C0BBD261C13291E0B5331219BEA88
```

To check the file before committing it, import it into an empty keyring and verify a signed tag against it:

```sh
keyring="$(mktemp -d)"
gpg --homedir "$keyring" --import .github/release-keys/maintainer.asc
GNUPGHOME="$keyring" git verify-tag <signed-tag>
```

To add a maintainer, commit their exported public key as a new file in the same directory and add a row to the table.

## One-time setup

These steps run once, before the first release. npm can configure a trusted publisher only for a package that already exists, and staging a new package creates it; see [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) and [npm stage](https://docs.npmjs.com/cli/v11/commands/npm-stage/). So the owner stages the first candidate locally to create the package, configures trust, and rejects that local stage, so the version can be staged again from CI with provenance.

1. Configure git in your checkout to sign with the key in [Signing key](#signing-key):

   ```sh
   git config user.signingkey C6AF1016BBDEA800
   ```

2. In the repository settings, create the `npm-release` environment and a ruleset that lets only the release owner create, update, or delete `v*` tags.
3. Merge the release pull request for the first candidate (step 1 of [Release a version](#release-a-version)), build its tarball with `npm pack --ignore-scripts` from that merge commit, and stage it from your machine. This makes the name `tevu` and a `0.0.0-stage` placeholder public; the candidate itself stays unpublished.

   ```sh
   npm login --registry=https://registry.npmjs.org/
   npm whoami --registry=https://registry.npmjs.org/
   npm stage publish /absolute/path/to/tevu-<version>.tgz --ignore-scripts --access public --tag next --registry=https://registry.npmjs.org/
   npm stage list tevu
   ```

   Don't approve this stage. If `tevu` already exists under your account, skip this step and the last one.

4. Trust `release.yml` for staging only, and read the setting back:

   ```sh
   npm trust github tevu --file release.yml --repository sergeyklay/tevu --environment npm-release --allow-stage-publish
   npm trust list tevu --json
   ```

   In the package settings on npmjs.com, require 2FA and disallow tokens for publishing.

5. Reject the local stage with `npm stage reject <stage-id>`, and check with `npm stage list tevu` that the version is free again. Don't unpublish the placeholder.

The trust setting is proven only by the first real staging run in step 2 of the release.

## Release a version

### 1. Prepare the release pull request

On a branch from `main`:

```sh
npm version <version> --no-git-tag-version --ignore-scripts
```

Then, in the same pull request:

- Move the `[Unreleased]` entries under the new version in [CHANGELOG.md](CHANGELOG.md), as [Changelog](#changelog) describes.
- Point every repository link in [README.md](README.md) at the new tag, `blob/v<version>/…`. The Docs workflow rejects links to any other tag.
- Update documents that describe the version or the install channel.

Check, and merge only when everything passes:

```sh
bun install --frozen-lockfile
bun run check
test "$(node dist/index.js --version)" = "$(node -p "require('./package.json').version")"
grep -F "## [$(node -p "require('./package.json').version")]" CHANGELOG.md
```

`git status` must show changes only to files you meant to change; `npm version` must not create a `package-lock.json`. Record the merge commit SHA.

### 2. Sign and push the tag

```sh
git fetch origin main
git tag -s v<version> <merge-sha> -m 'tevu <version>'
git verify-tag v<version>
git push origin refs/tags/v<version>
gh run list --workflow release.yml --limit 5
gh run watch <release-run-id> --exit-status
```

Always pass the merge SHA; a bare `git tag -s` signs whatever `HEAD` is. Push only this tag, never `--tags`. A run started by hand does not prove the tag trigger works.

`release.yml` rejects an unsigned tag, a tag signed by a key outside `.github/release-keys/`, a commit that is not on `main`, and a version that differs from the tag. It stages the tarball on `next` for a prerelease and on `latest` for a release, and writes the stage ID and the tarball digest to the job summary.

### 3. Check the staged tarball and approve it

```sh
npm stage view <stage-id>
npm stage download <stage-id>
```

Compare the downloaded tarball's digest with the one in the job summary, and check it from a checkout of the release tag with `node scripts/check-package.mjs <tarball> <version>`. Then approve exactly that stage and enter the one-time password at the prompt, never on the command line:

```sh
npm stage approve <stage-id>
```

The channel is fixed when the version is staged. A wrong channel needs `npm stage reject <stage-id>` and a new staging run before approval.

Outside any tevu checkout, so `npm exec` cannot pick a local executable:

```sh
npm view tevu@<version> name version dist.integrity dist.attestations --json
npm view tevu dist-tags --json
npm exec --yes --package=tevu@<version> -- tevu --version
npm exec --yes --package=tevu@<version> -- tevu --help
```

On the package page on npmjs.com, check that provenance names this repository, commit, and workflow.

### 4. Publish the GitHub Release

```sh
gh workflow run finalize-release.yml --ref main -f tag=v<version> -f release_run_id=<release-run-id>
gh release view v<version> --json tagName,isPrerelease,url,assets
```

`finalize-release.yml` refuses a version that is still staged, a registry integrity that differs from the release run's tarball, and a run from another repository. It attaches the tarball, its checksums, and the SBOM, and takes the body from the changelog section.

### 5. Confirm the result

Install the release the way a user does, `npm install --global tevu@<channel>` in a clean environment on Linux and macOS, and run `tevu --version`, `tevu --help`, and `tevu run --help`. A green workflow alone does not finish a release.

The GitHub Release is the record of the release: it names the commit and the npm version and channel, and carries the tarball digest. Check that npm provenance and the release body agree with it.

### From release candidate to release

After at least one clean install of the candidate by someone other than its author and no open blocking issue, repeat steps 1 to 5 with `X.Y.Z`. The release stages on `latest`, and `npm install --global tevu` installs it.

## Rehearse without publishing

These commands run every check that does not need the registry or the release workflows, on the current checkout, and publish nothing:

```sh
bun install --frozen-lockfile
bun run check
version="$(node -p "require('./package.json').version")"
test "$(node dist/index.js --version)" = "$version"
grep -F "## [$version]" CHANGELOG.md || echo "CHANGELOG.md has no section for $version yet"

dir="$(mktemp -d)"
npm pack --ignore-scripts --pack-destination "$dir"
node scripts/check-package.mjs "$dir/tevu-$version.tgz" "$version"
node scripts/audit.mjs "$dir/tevu-$version.tgz"
npm stage publish "$dir/tevu-$version.tgz" --dry-run --ignore-scripts --access public --tag next
```

Use `--tag latest` in the last command for a release. Before the release pull request renames the changelog section, the `grep` reports a missing section; after it, the same command must find one.

## Recover a release

Find where the release stopped, then follow that row. A published version and its tag never change.

| Where it stopped | What to do |
| --- | --- |
| A check failed before anything was staged | Fix it through a pull request. Delete the tag (`git push origin :refs/tags/v<version>` and `git tag -d v<version>`), sign it again on the fixed merge commit, verify it, and push it. |
| A stage exists but is not approved | Read the stage ID from the run's job summary. Approve it if its tarball is right; otherwise `npm stage reject <stage-id>` and fix. CI cannot inspect or remove a stage, and staging the same version again fails while one is pending. |
| npm has the version, GitHub has no Release | Run `finalize-release.yml` again with the same tag and release run ID. It reuses the release run's tarball and never publishes to npm. |
| A defect is found after the release | Release a fixed patch version. Deprecate the broken one, and point `latest` back at a good version if the broken one holds it. |

```sh
npm deprecate 'tevu@<bad-version>' 'Use <fixed-version>; see the release notes'
npm dist-tag add tevu@<good-version> latest
```

Both commands need the npm owner and 2FA; check the exact version before running them. `npm unpublish` is not a rollback. See [npm deprecate](https://docs.npmjs.com/cli/v11/commands/npm-deprecate/) and [npm dist-tag](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/).

## Workflows

| Workflow | Starts on | Role in a release |
| --- | --- | --- |
| [ci.yml](.github/workflows/ci.yml) | Pull requests and pushes to `main` | Gates the release pull request, and checks that the built CLI reports the `package.json` version |
| [docs.yml](.github/workflows/docs.yml) | Changes to Markdown or `package.json` | Checks links, and that README links name the tag of the current version |
| [security.yml](.github/workflows/security.yml) | Pull requests, pushes to `main`, and weekly | Scans commits for secrets, audits dependencies, and checks workflows; a failure blocks the release pull request |
| `release.yml` | Push of a `v*` tag | Checks the tag and commit, builds and tests one tarball, stages it on npm |
| `finalize-release.yml` | Manual dispatch from `main` | Checks the public npm version and creates the GitHub Release |
