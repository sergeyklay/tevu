# Trackers reference

The issue sources `tevu task add` can import from: Jira Cloud and GitHub issues. An import is a one-time read that produces the task's `source` snapshot; see [Tasks](tasks.md#source).

## Jira Cloud

| Field | Contract |
| --- | --- |
| `trackers.jira.url` | HTTPS site URL |
| `trackers.jira.email` | `$VARIABLE` reference to the account email |
| `trackers.jira.token` | `$VARIABLE` reference to the API token |

- `trackers.jira` is optional. `tevu validate` and `tevu run` check its structure only: an HTTPS URL and two `$VARIABLE` references. They do not check that the variables are set.
- `tevu task add --jira` needs both variables at import time and needs `trackers.jira` in an existing configuration. Without it the command exits `1`. A new configuration takes the Jira settings during the setup interview.
- Neither credential variable may appear in a check's `env` or in `setup.env`.
- The import is read-only. It uses at most three requests, shared across redirects and retries, against the Jira Cloud REST API version 3.
- The description is imported once as plain text, without its formatting.
- Each paragraph, heading, list item, table cell, block card, and embedded card ends its line. A hard break starts a new line.
- A smart link, shown inline, as a card, or embedded, is imported as its URL.
- Linked text is imported as `text (URL)`, or as the text alone when the text is the URL itself or the URL without a leading `http://`, `https://`, or `mailto:`.
- The import opens no linked page, and attachments and images are not imported.

## GitHub issues

GitHub issues has no configuration fields.

- `tevu task add --github <reference>` needs the GitHub CLI (`gh`) on `PATH`, authenticated for the issue's host: `gh auth login` for `github.com`, or `gh auth login --hostname <host>` for a GitHub Enterprise Server host. gh never receives `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN`, so gh's own login must cover an Enterprise host.
- tevu reads and stores no GitHub token. gh owns authentication.
- `<reference>` is `OWNER/REPO#NUMBER` or an issue URL, `https://HOST/OWNER/REPO/issues/NUMBER`.
- An import makes one `gh issue view` call with a 30-second limit and no retries beyond gh's own.

### Pull request and commit references

The reference-solution question of `tevu task add` uses the same gh setup.

| Operation | Calls |
| --- | --- |
| Resolving a pull request reference | One `gh api graphql` call with a 30-second limit. GitHub lists at most 250 commits of a pull request, and tevu records a pull request only when it can read the complete commit list |
| Drafting criteria from a pull request | One more `gh api` call reading the unified diff through GitHub's diff media type, with the same 30-second limit |
| Drafting criteria from a commit | No gh call. The diff comes from the repository |

See the [CLI reference](cli.md#network-use) for network use per command.
