/** Commented configuration template that `tevu config example` prints; `loadConfig` accepts it. */
export const CONFIG_TEMPLATE = `# tevu.yaml: compare coding models on tasks from your own backlog.
#
# Conventions used throughout this file:
#   - durations are strings with a unit: 500ms, 30s, 10m, 1h;
#   - relative paths resolve against the directory of this file;
#   - secrets are never written here: a credential is a $VARIABLE reference or a
#     variable name, and its value is read from the environment at run time;
#   - a block keyed by an adapter kind (agents.opencode, trackers.jira) holds the
#     settings of that adapter only, so a new agent or tracker adds a block and
#     changes nothing else.

version: 1

# --- Run --------------------------------------------------------------------
# Settings shared by every case, so every model works under the same rules.
run:
  output_dir: ../tevu-runs        # run evidence; must lie outside every repository
  concurrency: 2                  # cases running at once, 1 to 32
  timeout: 10m                    # limit for one agent attempt; checks are skipped after it
  stop_grace: 3s                  # time to exit after a graceful stop before a forced kill
  check_timeout: 5m               # default limit for a command check without its own timeout

# --- Agents -----------------------------------------------------------------
# One block per coding agent, keyed by adapter kind. Only opencode exists today.
agents:
  opencode:
    command: opencode             # name on PATH, or a path relative to this file
    secrets:                      # passed to the agent, redacted from every artifact
      - OPENAI_API_KEY
    env: []                       # ordinary variables passed to the agent as-is

# --- Trackers ---------------------------------------------------------------
# Used once, by \`tevu task add --jira\` or \`--github\`, to import an issue.
# GitHub import goes through the \`gh\` CLI and its own login; it needs no block.
trackers:
  jira:
    url: https://your-site.atlassian.net
    email: $JIRA_EMAIL
    token: $JIRA_API_TOKEN

# --- Repositories -----------------------------------------------------------
repositories:
  - id: app
    path: ../your-app

# --- Models -----------------------------------------------------------------
# What the benchmark compares: at least two entries.
models:
  - id: gpt-low
    model: openai/your-model      # as the agent names it
    effort: low                   # the agent's reasoning effort or variant
    # agent: opencode             # needed only when more than one agent is configured
  - id: gpt-high
    model: openai/your-model
    effort: high

# --- Tasks ------------------------------------------------------------------
tasks:
  - id: csv-export
    title: Export the current view as CSV
    repo: app                     # may be omitted while there is one repository
    base_commit: "0123456789abcdef0123456789abcdef01234567"   # a commit from before the fix

    # Sent to the agent, together with the check descriptions below.
    prompt: Add a CSV export button to the table view.
    description: Users need to download the visible table as a CSV file.

    # Where the task came from. Omit for a task written by hand.
    # \`tevu task add --jira\` or \`--github\` fills this block once;
    # later edits in the tracker never change the task.
    # source:
    #   kind: jira                # jira or github
    #   key: PROJ-123             # owner/repo#123 for GitHub
    #   url: https://your-site.atlassian.net/browse/PROJ-123
    #   imported_at: 2026-09-24T09:00:00Z
    #   title: Export table as CSV
    #   body: The imported issue text, kept for the record.

    # Confirmed by you before the task was added; never sent to the agent.
    readiness:
      - The expected columns and escaping rules are defined.

    checks:
      # Does the change solve the task? At least one check must be required.
      acceptance:
        - id: csv-content
          description: The CSV contains the visible rows and correctly escapes values.
          manual: true            # you record the verdict with \`tevu assess\`
        - id: tests
          description: The repository's test suite passes.
          run: [npm, test]        # executable and literal arguments, no shell
          # timeout: 2m           # defaults to run.check_timeout
          # exit_codes: [0]       # exit codes that count as a pass; defaults to [0]
          # env: [NODE_OPTIONS]   # ordinary variables this check receives
          # required: false       # checks are required unless stated otherwise
      # Is the work complete beyond the fix itself? At least one check must be required.
      done:
        - id: docs
          description: The export action is documented for users.
          manual: true
`;
