# Benchmark a repository you have not cloned

Let tevu clone a GitHub repository for you, so a task can start from any of its commits without a local checkout.

## Prerequisites

Log in with the GitHub CLI before you run `tevu task add`:

```sh
gh auth login
```

For GitHub Enterprise Server, add `--hostname <host>`.

## Add the repository

In `tevu task add`, choose **GitHub, cloned by tevu** at the `Repository source` question and enter `OWNER/REPO`, or `https://HOST/OWNER/REPO` for another host. The wizard reads the repository with your `gh` login as soon as you enter it and asks again when it cannot.

It clones the repository into a directory it owns and fetches every reference-solution and base-commit answer as you type it. When a base commit's tree holds Git LFS pointers, the wizard also fetches the objects it needs, which requires Git LFS from https://git-lfs.com.

In a configuration file, use `github` instead of `path`:

```yaml
repositories:
  - id: app
    github: your-org/your-app
```

## Resolve missing commits

`tevu validate` never clones or fetches. With no clone yet, or a clone missing a commit, it prints a finding that names `tevu run --dry-run` as the fix, without contacting GitHub.

```sh
tevu run --dry-run
```

`run --dry-run` clones and fetches whatever the configured tasks still need before validation runs, so it is usually enough to resolve the finding. It starts no model session.

## Clear the clones

Delete the managed-clone root to reclaim disk space. The next `tevu run --dry-run` or `tevu task add` clones again. The root and the clone layout are in [Repositories](../reference/repositories.md#managed-clone).

If a clone or fetch fails, see [Troubleshoot common failures](troubleshoot.md#clone-or-fetch-fails).
