/** Commented configuration template that `tevu config example` prints; `loadConfig` accepts it. */
export const CONFIG_TEMPLATE = `# tevu configuration template, printed by: tevu config example
# Replace the illustrative values (paths, the credential variable, models, and
# the example task), then check the file with: tevu validate
# Optional fields are commented out; delete the leading "# " to enable one.
# tevu task add rewrites this file without comments and with absolute paths.

# configuration format; must be 1
version: 1

# where tevu saves run evidence
artifacts:
  # outside every repository; relative to this file
  directory: ../tevu-runs

# limits for every benchmark run
execution:
  # cases that run at the same time, 1 to 32
  concurrency: 2
  # time limit for one agent run, in milliseconds
  caseTimeoutMs: 600000
  # wait before a forced stop, in milliseconds
  terminationGraceMs: 3000
  # variables passed to the agent; names only, never values
  opencodeEnvironment:
    # replace with your provider's credential variable
    # Possible values for classification: provider-credential, secret, or ordinary
    - name: OPENAI_API_KEY
      classification: provider-credential
  # ordinary variables that command checks may receive
  evaluatorEnvironment: []

# the coding agent that tevu runs
opencode:
  # command name on PATH, or a path relative to this file
  executable: opencode

# Jira Cloud connection for tevu task add --jira
# jira:
#   # HTTPS site URL
#   baseUrl: https://your-site.atlassian.net
#   # variable that holds the account email
#   emailEnvironmentVariable: JIRA_EMAIL
#   # variable that holds the API token
#   tokenEnvironmentVariable: JIRA_API_TOKEN

# local Git repositories that tasks start from
repositories:
  # lowercase letters, digits, and hyphens; starts with a letter
  - id: app
    path: ../your-app

# Should be at least two model and effort combinations to compare
contenders:
  - id: low
    model: openai/your-model
    variant: low
  - id: high
    model: openai/your-model
    variant: high

# at least one task; tevu task add appends more
tasks:
  - id: csv-export
    # id of an entry in repositories
    repositoryId: app
    # a commit from before the fix
    startCommit: "0123456789abcdef0123456789abcdef01234567"
    # where the task comes from
    source:
      # tevu task add --jira or --github records imported issues
      kind: manual
      # issue key or URL for your records
      # reference: PROJ-123
      # short task title
      title: Export the current view as CSV
    # sent to the model
    description: Users need to download the visible table as a CSV file.
    # instructions for the model
    prompt: Add a CSV export button to the table view.
    # prerequisites you confirmed before the run
    definitionOfReady:
      - id: requirements
        description: The expected columns and escaping rules are defined.
        # must be true
        confirmed: true
    # checks for the solution; the model sees their descriptions
    acceptanceCriteria:
      - id: csv-content
        description: The CSV contains the visible rows and correctly escapes values.
        # at least one check in each list must be required
        required: true
        # manual, or command as in the commented-out check below
        evaluator:
          # you record the verdict with tevu assess
          kind: manual
      # a command check runs in the case workspace, without a shell
      # - id: tests
      #   description: The target repository's test suite passes.
      #   required: true
      #   evaluator:
      #     kind: command
      #     # executable, then literal arguments
      #     argv: [npm, test]
      #     # time limit for the command, in milliseconds
      #     timeoutMs: 120000
      #     # exit codes that count as a pass
      #     successExitCodes: [0]
      #     # names from execution.evaluatorEnvironment
      #     environmentAllowlist: []
    # completion checks; the model sees their descriptions
    definitionOfDone:
      - id: docs
        description: The export action is documented for users.
        required: true
        evaluator:
          kind: manual
`;
