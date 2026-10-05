# Security policy

## Report a vulnerability

Report privately through [GitHub private vulnerability reporting](https://github.com/sergeyklay/tevu/security/advisories/new). Never open a public issue, pull request, or comment for a vulnerability.

Include the tevu version (`tevu --version`), the Node.js version, the operating system, the command, and the smallest configuration that reproduces the problem. Replace every credential, private task text, and private repository content with a placeholder; a report never needs the real value.

If a real credential was already posted anywhere public, revoke it at its provider first. Deleting the text does not revoke the credential.

## Response

The maintainer acknowledges a report within 7 calendar days. A confirmed vulnerability is fixed on `main`, released, and disclosed in a GitHub security advisory that credits the reporter unless they ask otherwise.

## Supported versions

| Version | Receives security fixes |
| --- | --- |
| Latest release on the npm `latest` channel | Yes |
| Latest prerelease on the npm `next` channel | Yes, until a newer release or prerelease replaces it |
| Any older version | No. Upgrade with `npm install --global tevu@latest` |

## Threat model

tevu runs on the operator's host, with the operator's permissions. A report is a tevu vulnerability when tevu breaks a guarantee it documents, without the attacker first controlling something tevu trusts.

### Trusted

- The operator, the host, its operating system, Node.js, Git, and Git LFS.
- The configuration file, its check and setup commands, and the case executables it names.
- The source repositories and the OpenCode executable the configuration points to, and the model providers it declares.

### In scope

- **Credential exposure.** A configured credential value (a variable named in `agents.opencode.secrets`, a copied provider credential, or the Jira token) reaches an artifact, a log, the terminal, or an error message. tevu redacts these values and aborts the write when redaction fails; see [Data handling](docs/reference/artifacts.md#data-handling).
- **Context isolation failure.** A case receives commits after its base commit, another case's output, the overlay before checks start, or host agent state other than the provider definitions the configuration names. An evaluator receives the agent's home directory or credentials, or a check environment receives a variable the [environment rules](docs/reference/environment.md) exclude. The solution patch is captured after checks have run. See [Isolation](docs/concepts/isolation.md).
- **Reference solution exposure** through a path tevu documents as guarded: the recorded reference identifiers in an agent prompt that passed prompt screening, or reference commits inside a sealed repository. See [Reference solutions](docs/concepts/reference-solutions.md).

### Out of scope

These are documented limits, not vulnerabilities. A report that shows a limit is broader than documented is in scope.

- An agent with shell access reading host paths outside its worktree, including the overlay directory, a managed clone, the configuration, and `run.json`. Isolation controls context; it is not a sandbox. See [Where isolation stops](docs/concepts/isolation.md#where-isolation-stops).
- A tool that OpenCode reports as denied but still runs, or configuration that changes between the tool denial check and the model call. See [Tool denial check](docs/reference/agents-and-models.md#tool-denial-check).
- Drafted acceptance criteria that describe the reference solution's method, or name it in a form the screen does not match. See [Where the guards stop](docs/concepts/reference-solutions.md#where-the-guards-stop).
- Private task text, repository content, and model output stored in configuration and run files. They are kept by design and protected by host file permissions.
- Anything that requires control of a trusted input, and vulnerabilities in OpenCode, model providers, Node.js, Git, or the operating system. Report those to their maintainers.
