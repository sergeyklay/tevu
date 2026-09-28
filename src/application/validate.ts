import {
  agentNamesInUse,
  evaluatorEnvironmentNames,
  repositoryInputOf,
  TevuConfigSchema,
} from '@/config/schema';
import { GH_CREDENTIAL_ENVIRONMENT_VARIABLES } from '@/domain/github-cli';
import {
  formatGitHubRepository,
  parseGitHubReference,
  parseGitHubRepository,
} from '@/domain/github-reference';
import { gradedChecksOf } from '@/evaluation/grading';

import { buildEnvironmentVariableNames } from './environment-variable-names';
import {
  describePullRequestInPrompt,
  describeReferenceCommitInPrompt,
  describeSourceCommitInPrompt,
} from './source-commit-in-prompt';
import { buildTaskPrompt } from './task-prompt';

import type {
  AgentCapabilityReport,
  CaseExecutableAdapter,
  CaseExecutableVerdict,
  ParentEnvironmentSnapshot,
  RepositoryDefinition,
  SourceValidation,
  TaskDefinition,
  TevuConfig,
  TevuError,
  TevuResult,
  ValidationDependencies,
  ValidationFinding,
  ValidationReport,
  WorkingDirectoryChanges,
} from '@/domain/types';

/** A full commit hash: 40 (SHA-1) or 64 (SHA-256) lowercase hexadecimal characters. */
const FULL_COMMIT_HASH_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Error kinds the validation contract declares. */
type ValidateConfigErrorKind =
  | 'ConfigValidationError'
  | 'PrerequisiteError'
  | 'SourceMaterializationError'
  | 'IsolationError'
  | 'AgentProtocolError';

/**
 * Aggregates static and local prerequisite validation for one configuration.
 *
 * Applies the ordered validation stages over injected adapter contracts and
 * retains every independent finding in one invocation instead of stopping at
 * the first failure. Findings carry stable field, task, or variable-name
 * identifiers and never environment values. No Jira call, model session, run
 * artifact, or retained probe file is involved; the configuration is invalid
 * when any error-severity finding exists.
 */
export async function validateConfig(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): Promise<TevuResult<ValidationReport, ValidateConfigErrorKind>> {
  const agents = dependencies.agents;
  const environmentResult = collectEnvironmentFindings(config, dependencies);
  const findings: ValidationFinding[] = [
    ...collectSchemaFindings(config),
    ...collectGraderRoleFindings(config),
    ...(await collectHostFindings(dependencies)),
    ...environmentResult.findings,
    ...(await collectSourceFindings(config, dependencies)),
    ...(await collectOverlayFindings(config, dependencies)),
    ...(await collectArtifactFindings(config, dependencies)),
  ];

  const probeNames = agentNamesInUse(config);
  const probeNamesSeen = new Set(probeNames);
  for (const role of Object.values(config.roles ?? {})) {
    if (!probeNamesSeen.has(role.agent)) {
      probeNamesSeen.add(role.agent);
      probeNames.push(role.agent);
    }
  }

  let reportedAgents: ReadonlySet<string> = new Set();
  if (environmentResult.snapshot !== undefined) {
    const caseExecutableResult = await collectCaseExecutableFindings(
      config,
      environmentResult.snapshot,
      probeNames,
      dependencies.caseExecutables,
    );
    findings.push(...caseExecutableResult.findings);
    reportedAgents = caseExecutableResult.reportedAgents;
  }

  const capabilities: Record<string, AgentCapabilityReport> = {};
  for (const name of probeNames) {
    if (reportedAgents.has(name)) {
      // Its case-executable finding already names the same failing command;
      // probing its capabilities would either repeat that failure or pass
      // while every case using it still fails.
      continue;
    }
    const adapter = agents.get(name);
    if (adapter === undefined) {
      findings.push({
        severity: 'error',
        identifier: `agents.${name}`,
        message: 'no agent adapter is registered under this name',
      });
      continue;
    }
    const probe = await adapter.probe();
    if (probe.ok) {
      capabilities[name] = probe.value;
    } else if (probe.error.kind === 'PrerequisiteError') {
      findings.push(prerequisiteFinding(probe.error));
    } else {
      findings.push({
        severity: 'error',
        identifier: `agents.${name}.command`,
        message: probe.error.reason,
      });
    }
  }

  return {
    ok: true,
    value: {
      valid: !findings.some((finding) => finding.severity === 'error'),
      findings,
      capabilities,
    },
  };
}

/**
 * Strict schema validation, covering duplicate IDs and cross-references.
 *
 * The config is re-validated defensively because validateConfig owns schema
 * truth for callers that did not arrive through loadConfig; the schema's
 * refinements cover duplicates, classifications, and cross-references.
 */
function collectSchemaFindings(config: TevuConfig): ValidationFinding[] {
  const input = { ...config, repositories: config.repositories.map(repositoryInputOf) };
  const parsed = TevuConfigSchema.safeParse(input);
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map((issue): ValidationFinding => ({
    severity: 'error',
    identifier:
      issue.path.length === 0 ? 'config' : issue.path.map((segment) => String(segment)).join('.'),
    message: issue.code === 'unrecognized_keys' ? 'Unknown configuration field' : issue.message,
  }));
}

/**
 * Requires `roles.grader` when at least one task declares a graded check;
 * the loader itself does not require the role, per configuration.md#model-roles.
 */
function collectGraderRoleFindings(config: TevuConfig): ValidationFinding[] {
  if (config.roles?.grader !== undefined) {
    return [];
  }
  const taskIds = config.tasks
    .filter((task) => gradedChecksOf(task).length > 0)
    .map((task) => task.id);
  if (taskIds.length === 0) {
    return [];
  }
  return [
    {
      severity: 'error',
      identifier: 'roles.grader',
      message: `graded checks need the grader role; declare roles.grader (tasks with graded checks: ${taskIds.join(', ')})`,
    },
  ];
}

/** Checks the local platform and that `git --version` succeeds on the parent PATH. */
async function collectHostFindings(
  dependencies: ValidationDependencies,
): Promise<ValidationFinding[]> {
  const host = await dependencies.prerequisites.probeHost();
  return host.ok ? [] : [prerequisiteFinding(host.error)];
}

/**
 * Checks configured variable presence by name, plus the non-empty parent
 * PATH, and takes the run's one parent-environment snapshot.
 *
 * `snapshot` is present exactly when `findings` is empty, so the
 * case-executable stage can reuse it without a second `snapshotParent` call.
 */
function collectEnvironmentFindings(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): { findings: ValidationFinding[]; snapshot?: ParentEnvironmentSnapshot } {
  const findings: ValidationFinding[] = [];
  const names = new Set<string>();
  for (const settings of Object.values(config.agents)) {
    for (const name of [...settings.secrets, ...settings.env]) {
      names.add(name);
    }
  }
  for (const name of evaluatorEnvironmentNames(config)) {
    names.add(name);
  }
  for (const name of names) {
    if (!dependencies.prerequisites.hasEnvironmentVariable(name)) {
      findings.push({
        severity: 'error',
        identifier: `environment.${name}`,
        message: 'required environment variable is not set',
      });
    }
  }
  // snapshotParent also rejects missing variables, which are already reported
  // by name above; it runs only for its non-empty parent PATH check here.
  if (findings.length > 0) {
    return { findings };
  }
  const snapshot = dependencies.environments.snapshotParent(buildEnvironmentVariableNames(config));
  if (!snapshot.ok) {
    return { findings: [prerequisiteFinding(snapshot.error)] };
  }
  return { findings: [], snapshot: snapshot.value };
}

/** One case executable to probe, as `collectCaseExecutableFindings` derives it from configuration. */
type CaseExecutableLocation = {
  identifier: string;
  executable: string;
  additions: Readonly<Record<string, string>>;
  /** A path entry's directory; absent for an agent location and a GitHub entry's location. */
  workingDirectory?: string;
  /** Names of the fields that added this executable's `additions`, for the finding message. */
  declared: string;
  /** Set only for an agent location, so its case-executable error can also skip that agent's capability probe. */
  agentName?: string;
};

/**
 * Orders every case executable `tevu validate` probes before any case
 * starts: each in-use agent's command, then each named repository's setup
 * commands, then each task's command checks.
 */
function buildCaseExecutableLocations(
  config: TevuConfig,
  snapshot: ParentEnvironmentSnapshot,
  agentNames: readonly string[],
): CaseExecutableLocation[] {
  const locations: CaseExecutableLocation[] = [];

  for (const name of agentNames) {
    const settings = config.agents[name];
    if (settings === undefined) {
      continue;
    }
    locations.push({
      identifier: `agents.${name}.command`,
      executable: settings.command,
      additions: pickValues(snapshot.agentValues, [...settings.secrets, ...settings.env]),
      declared: `agents.${name}.secrets and agents.${name}.env`,
      agentName: name,
    });
  }

  const namedRepositoryIds = new Set(config.tasks.map((task) => task.repo));
  for (const repository of config.repositories) {
    if (!namedRepositoryIds.has(repository.id)) {
      continue;
    }
    const workingDirectory = repository.github === undefined ? repository.path : undefined;
    for (const phase of ['before_agent', 'before_checks'] as const) {
      (repository.setup?.[phase] ?? []).forEach((command, index) => {
        locations.push({
          identifier: `repositories.${repository.id}.setup.${phase}.${index}`,
          executable: command[0],
          additions: pickValues(snapshot.ordinaryEvaluatorValues, repository.setup?.env ?? []),
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
          declared: `repositories.${repository.id}.setup.env`,
        });
      });
    }
  }

  const repositoriesById = new Map(
    config.repositories.map((repository) => [repository.id, repository]),
  );
  for (const task of config.tasks) {
    const repository = repositoriesById.get(task.repo);
    if (repository === undefined) {
      continue;
    }
    const workingDirectory = repository.github === undefined ? repository.path : undefined;
    for (const category of ['acceptance', 'done'] as const) {
      for (const check of task.checks[category]) {
        if (!('run' in check)) {
          continue;
        }
        locations.push({
          identifier: `tasks.${task.id}.checks.${category}.${check.id}.run`,
          executable: check.run[0],
          additions: pickValues(snapshot.ordinaryEvaluatorValues, check.env),
          ...(workingDirectory === undefined ? {} : { workingDirectory }),
          declared: `tasks.${task.id}.checks.${category}.${check.id}.env`,
        });
      }
    }
  }

  return locations;
}

function pickValues(
  source: Readonly<Record<string, string>>,
  names: readonly string[],
): Readonly<Record<string, string>> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) {
      picked[name] = value;
    }
  }
  return picked;
}

/** Every name the parent run of a case-executable probe omits even when `process.env` sets it. */
function withheldEnvironmentVariableNames(config: TevuConfig): string[] {
  const names = buildEnvironmentVariableNames(config);
  const withheld = new Set<string>(GH_CREDENTIAL_ENVIRONMENT_VARIABLES);
  for (const entry of Object.values(names.agents)) {
    for (const name of entry.secrets) {
      withheld.add(name);
    }
  }
  if (names.jiraTokenVariable !== undefined) {
    withheld.add(names.jiraTokenVariable);
  }
  return [...withheld];
}

function caseExecutableProbeKey(location: CaseExecutableLocation): string {
  const additionNames = Object.keys(location.additions).sort().join('\0');
  return [location.executable, location.workingDirectory ?? '', additionNames].join('\0');
}

/**
 * Probes every case executable a resolved configuration would start, in
 * location order and deduplicated by probe key, and reports a `parent-only`
 * verdict as an error finding, preceded by the change and could-not-check
 * warnings its probe's directory snapshot produced.
 *
 * Stops after the first probe that fails with `PrerequisiteError`, since
 * that failure is evidence about tevu's own environment rather than about
 * any one executable.
 */
async function collectCaseExecutableFindings(
  config: TevuConfig,
  snapshot: ParentEnvironmentSnapshot,
  agentNames: readonly string[],
  adapter: CaseExecutableAdapter,
): Promise<{ findings: ValidationFinding[]; reportedAgents: ReadonlySet<string> }> {
  const findings: ValidationFinding[] = [];
  const reportedAgents = new Set<string>();
  const withheldNames = withheldEnvironmentVariableNames(config);
  const verdicts = new Map<string, CaseExecutableVerdict>();

  for (const location of buildCaseExecutableLocations(config, snapshot, agentNames)) {
    if (location.executable.includes('/') && !location.executable.startsWith('/')) {
      continue;
    }
    const key = caseExecutableProbeKey(location);
    let verdict = verdicts.get(key);
    if (verdict === undefined) {
      const result = await adapter.probe({
        executable: location.executable,
        path: snapshot.path,
        additions: location.additions,
        ...(location.workingDirectory === undefined
          ? {}
          : { workingDirectory: location.workingDirectory }),
        withheldNames,
      });
      if (!result.ok) {
        findings.push(prerequisiteFinding(result.error));
        return { findings, reportedAgents };
      }
      verdict = result.value.verdict;
      verdicts.set(key, verdict);
      findings.push(...changeWarnings(result.value.changes, location));
    }
    if (verdict.verdict === 'parent-only') {
      findings.push({
        severity: 'error',
        identifier: location.identifier,
        message: formatCaseExecutableMessage(location.executable, location.declared, verdict),
      });
      if (location.agentName !== undefined) {
        reportedAgents.add(location.agentName);
      }
    }
  }

  return { findings, reportedAgents };
}

/**
 * Builds the one-line `parent-only` finding message: names the executable,
 * why the replica run failed, and both remedies. Carries no process output,
 * git output, file content, or variable value beyond the PATH entry a
 * resolved path may add.
 */
function formatCaseExecutableMessage(
  executable: string,
  declared: string,
  verdict: Extract<CaseExecutableVerdict, { verdict: 'parent-only' }>,
): string {
  const { resolvedPath, replicaFailure } = verdict;
  const resolved = resolvedPath !== null && resolvedPath !== executable ? ` (${resolvedPath})` : '';
  return (
    `"${executable}"${resolved} exits 0 for --version in tevu's environment, secrets withheld, ` +
    `but ${formatReplicaFailure(replicaFailure)} in a case environment, which has its own HOME ` +
    `and XDG directories and receives from tevu's environment only PATH and the variables ` +
    `declared in ${declared}: if it reads another variable, declare that variable there; if it ` +
    `is, or runs through, a version-manager shim, put the real executable's directory before ` +
    `the shim directory on PATH when starting tevu`
  );
}

function formatReplicaFailure(
  failure: Extract<CaseExecutableVerdict, { verdict: 'parent-only' }>['replicaFailure'],
): string {
  switch (failure.kind) {
    case 'exited':
      return `exits with code ${failure.exitCode}`;
    case 'signaled':
      return `is terminated by signal ${failure.signal}`;
    case 'not-started':
      return failure.code === null ? 'cannot be started' : `cannot be started (${failure.code})`;
  }
}

/** Element type of `WorkingDirectoryChanges.runs`, named here since the domain module keeps it unexported. */
type CaseExecutableRunChanges = WorkingDirectoryChanges['runs'][number];

/**
 * Builds the change and could-not-check warnings of a probe's directory
 * snapshot, at the identifier of the location whose probe produced them:
 * one change warning per run that changed a path, in run order, then one
 * could-not-check warning when the snapshot itself failed.
 */
function changeWarnings(
  changes: WorkingDirectoryChanges | undefined,
  location: CaseExecutableLocation,
): ValidationFinding[] {
  const directory = location.workingDirectory;
  if (changes === undefined || directory === undefined) {
    return [];
  }
  const findings: ValidationFinding[] = [];
  for (const entry of changes.runs) {
    if (entry.added.length === 0 && entry.modified.length === 0 && entry.removed.length === 0) {
      continue;
    }
    const environment =
      entry.run === 'replica' ? 'a case environment' : "tevu's environment, secrets withheld";
    findings.push({
      severity: 'warning',
      identifier: location.identifier,
      message: formatChangeWarningMessage(directory, location.executable, environment, entry),
    });
  }
  if (changes.failure !== undefined) {
    findings.push({
      severity: 'warning',
      identifier: location.identifier,
      message: formatCouldNotCheckMessage(directory, location.executable, changes.failure),
    });
  }
  return findings;
}

function formatChangeWarningMessage(
  directory: string,
  executable: string,
  environment: string,
  entry: CaseExecutableRunChanges,
): string {
  return (
    `files in "${directory}" changed while "${executable}" was running with --version in ` +
    `${environment}: ${renderChanges(entry)}; tevu did not revert them`
  );
}

function formatCouldNotCheckMessage(directory: string, executable: string, reason: string): string {
  return (
    `could not check whether files in "${directory}" changed while "${executable}" was ` +
    `running with --version: ${reason}`
  );
}

/** Groups a run's changed paths by label, capped at the first 10 across all three lists. */
function renderChanges(entry: CaseExecutableRunChanges): string {
  const labeled = [
    ...entry.added.map((path) => ({ label: 'added', path })),
    ...entry.modified.map((path) => ({ label: 'modified', path })),
    ...entry.removed.map((path) => ({ label: 'removed', path })),
  ];
  const shown = labeled.slice(0, 10);
  const groups = (['added', 'modified', 'removed'] as const)
    .map((label) => {
      const paths = shown
        .filter((item) => item.label === label)
        .map((item) => escapeControlCharacters(item.path));
      return paths.length === 0 ? undefined : `${label} ${paths.join(', ')}`;
    })
    .filter((group): group is string => group !== undefined);
  const remaining = labeled.length - shown.length;
  return remaining > 0 ? `${groups.join('; ')}; +${remaining} more` : groups.join('; ');
}

/** Escapes each C0 control character, DEL, and C1 control character as a JSON-style `\\uNNNN` sequence. */
function escapeControlCharacters(path: string): string {
  let escaped = '';
  for (const character of path) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl =
      codePoint <= 0x1f || codePoint === 0x7f || (codePoint >= 0x80 && codePoint <= 0x9f);
    escaped += isControl ? `\\u${codePoint.toString(16).padStart(4, '0')}` : character;
  }
  return escaped;
}

/**
 * Resolves each task's start commit, inspects its source tree, rejects a task
 * whose agent prompt names the resolved commit, a reference commit, or a
 * pull-request reference, and enforces the reference containment and
 * precedence rules against an available base.
 */
async function collectSourceFindings(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const repositories = new Map(
    config.repositories.map((repository) => [repository.id, repository]),
  );
  const cloneProblems = await collectGitHubCloneProblems(config, dependencies, findings);
  // Tasks sharing a repository and commit reuse one probe so a large source
  // tree is scanned once per pinned commit.
  const validated = new Map<string, TevuResult<SourceValidation, 'SourceMaterializationError'>>();
  for (const task of config.tasks) {
    const repository = repositories.get(task.repo);
    if (repository === undefined) {
      // A broken reference is already an error finding from the schema stage.
      continue;
    }
    const prompt = buildTaskPrompt(task);
    // A GitHub entry with a clone-state problem cannot resolve any commit
    // locally: skip the resolution calls and keep only the text-only checks.
    const resolvedBase = cloneProblems.has(repository.id)
      ? undefined
      : await resolveTaskBaseForValidation(
          task,
          repository,
          prompt,
          findings,
          validated,
          dependencies,
        );

    const recorded = recordedReferenceCommits(task.reference);
    for (const commit of recorded) {
      const reason = describeReferenceCommitInPrompt(prompt, commit.hash);
      if (reason !== undefined) {
        findings.push({ severity: 'error', identifier: `tasks.${task.id}`, message: reason });
      }
    }
    if (task.reference?.kind === 'pull-request') {
      const parsed = parseGitHubReference(task.reference.identifier);
      if (parsed !== null) {
        const reason = describePullRequestInPrompt(prompt, parsed);
        if (reason !== undefined) {
          findings.push({ severity: 'error', identifier: `tasks.${task.id}`, message: reason });
        }
      }
    }
    if (resolvedBase === undefined) {
      continue;
    }
    findings.push(
      ...(await collectReferenceCommitFindings(
        task,
        repository,
        resolvedBase,
        recorded,
        dependencies,
      )),
    );
  }
  return findings;
}

/**
 * Inspects, once per GitHub entry named by at least one task, whether its
 * managed clone exists and is one tevu made; pushes the matching error
 * finding for a missing or foreign clone and returns the repository IDs that
 * failed, so their tasks skip commit resolution entirely (`validateConfig`
 * never reaches the network).
 */
async function collectGitHubCloneProblems(
  config: TevuConfig,
  dependencies: ValidationDependencies,
  findings: ValidationFinding[],
): Promise<Set<string>> {
  const namedRepositoryIds = new Set(config.tasks.map((task) => task.repo));
  const problems = new Set<string>();
  for (const repository of config.repositories) {
    if (repository.github === undefined || !namedRepositoryIds.has(repository.id)) {
      continue;
    }
    const parsed = parseGitHubRepository(repository.github);
    if (parsed === null) {
      // The schema stage already reports the grammar failure.
      continue;
    }
    const state = await dependencies.clones.inspectClone(repository.path);
    if (state === 'repository') {
      continue;
    }
    problems.add(repository.id);
    const display = formatGitHubRepository(parsed);
    const message =
      state === 'missing'
        ? `repository "${repository.id}" has no clone of ${display} at "${repository.path}"; tevu run --dry-run clones it`
        : `"${repository.path}" is not a clone tevu made for repository "${repository.id}"; remove it, then tevu run --dry-run clones ${display} there`;
    findings.push({
      severity: 'error',
      identifier: `repositories.${repository.id}.github`,
      message,
    });
  }
  return problems;
}

/**
 * Resolves one task's base commit: names the fetch to run when the base of a
 * GitHub-entry task, or a pull-request task's full-hash base, is not
 * available locally (MISSING-BASE), otherwise pins it through the cached
 * `validateSource` call as today. Either way, checks the base text itself
 * against the agent prompt.
 */
async function resolveTaskBaseForValidation(
  task: TaskDefinition,
  repository: RepositoryDefinition,
  prompt: string,
  findings: ValidationFinding[],
  validated: Map<string, TevuResult<SourceValidation, 'SourceMaterializationError'>>,
  dependencies: ValidationDependencies,
): Promise<string | undefined> {
  const isFullHash = FULL_COMMIT_HASH_PATTERN.test(task.base_commit);
  if (repository.github !== undefined || (task.reference?.kind === 'pull-request' && isFullHash)) {
    const lookup = await dependencies.git.resolveCommit(repository, task.base_commit);
    if (lookup.kind === 'not-found') {
      findings.push({
        severity: 'error',
        identifier: `tasks.${task.id}.base_commit`,
        message: missingBaseMessage(task, repository),
      });
      const reason = isFullHash
        ? describeSourceCommitInPrompt(prompt, task.base_commit)
        : undefined;
      if (reason !== undefined) {
        findings.push({ severity: 'error', identifier: `tasks.${task.id}`, message: reason });
      }
      return undefined;
    }
  }
  const key = `${repository.id}\u0000${task.base_commit}`;
  let result = validated.get(key);
  if (result === undefined) {
    result = await dependencies.git.validateSource(repository, task.base_commit);
    validated.set(key, result);
  }
  if (!result.ok) {
    findings.push({
      severity: 'error',
      identifier: `tasks.${task.id}.base_commit`,
      message: result.error.reason,
    });
    return undefined;
  }
  const reason = describeSourceCommitInPrompt(prompt, result.value.resolvedCommit);
  if (reason !== undefined) {
    findings.push({ severity: 'error', identifier: `tasks.${task.id}`, message: reason });
  }
  return result.value.resolvedCommit;
}

/**
 * The missing-base text: for a GitHub entry, names `tevu run --dry-run` as
 * the fix; for a path entry, keeps today's fetch example from the pull
 * request's own repository when it parses, byte for byte.
 */
function missingBaseMessage(task: TaskDefinition, repository: RepositoryDefinition): string {
  const base = task.base_commit;
  if (repository.github !== undefined) {
    const parsed = parseGitHubRepository(repository.github);
    const inClone = `base commit "${base}" is not in the clone of repository "${repository.id}"`;
    return parsed === null
      ? inClone
      : `${inClone}; tevu run --dry-run fetches it from ${formatGitHubRepository(parsed)}`;
  }
  const prefix = `base commit ${base} is not in repository "${repository.id}" ("${repository.path}"); fetch it there first`;
  const identifier =
    task.reference?.kind === 'pull-request' ? task.reference.identifier : undefined;
  const parsed = identifier === undefined ? null : parseGitHubReference(identifier);
  if (parsed === null) {
    return prefix;
  }
  return `${prefix}, for example: git fetch https://${parsed.host}/${parsed.owner}/${parsed.repo}.git ${base}`;
}

/** One reference commit as validation must check it: containment only for a pull request's own commits. */
type RecordedReferenceCommit = { hash: string; checkContainment: boolean };

/** `commits`, then `merge_commit` when present; empty without a reference. */
function recordedReferenceCommits(
  reference: TaskDefinition['reference'],
): RecordedReferenceCommit[] {
  if (reference === undefined) {
    return [];
  }
  if (reference.kind === 'commit') {
    const [hash] = reference.commits;
    return [{ hash, checkContainment: false }];
  }
  const commits = reference.commits.map((hash) => ({ hash, checkContainment: true }));
  return reference.merge_commit === undefined
    ? commits
    : [...commits, { hash: reference.merge_commit, checkContainment: false }];
}

/**
 * Checks which reference commits are available locally, warns once about the
 * rest, warns again when an unavailable merge commit could not be checked,
 * and rejects the first available commit the base violates.
 */
async function collectReferenceCommitFindings(
  task: TaskDefinition,
  repository: RepositoryDefinition,
  resolvedBase: string,
  recorded: readonly RecordedReferenceCommit[],
  dependencies: ValidationDependencies,
): Promise<ValidationFinding[]> {
  if (recorded.length === 0) {
    return [];
  }
  const findings: ValidationFinding[] = [];
  const available: RecordedReferenceCommit[] = [];
  const missing: string[] = [];
  for (const commit of recorded) {
    const lookup = await dependencies.git.resolveCommit(repository, commit.hash);
    if (lookup.kind === 'found' && lookup.commit === commit.hash) {
      available.push(commit);
    } else {
      missing.push(commit.hash);
    }
  }
  if (missing.length > 0) {
    const fetchHint = repository.github === undefined ? '' : '; tevu run --dry-run fetches them';
    findings.push({
      severity: 'warning',
      identifier: `tasks.${task.id}.reference`,
      message: `reference commits not available in repository "${repository.id}": ${missing.length} of ${recorded.length}; the base commit was not compared with them${fetchHint}`,
    });
  }
  const mergeCommit =
    task.reference?.kind === 'pull-request' ? task.reference.merge_commit : undefined;
  if (mergeCommit !== undefined && missing.includes(mergeCommit)) {
    const fetchHint = repository.github === undefined ? '' : '; tevu run --dry-run fetches it';
    findings.push({
      severity: 'warning',
      identifier: `tasks.${task.id}.reference.merge_commit`,
      message: `merge commit ${mergeCommit.slice(0, 7)} is not available in repository "${repository.id}"; the base commit was not checked to precede it${fetchHint}`,
    });
  }
  for (const commit of available) {
    const violation = await describeReferenceCommitViolation(
      resolvedBase,
      commit,
      repository,
      dependencies,
    );
    if (violation !== undefined) {
      findings.push({
        severity: 'error',
        identifier: `tasks.${task.id}.base_commit`,
        message: violation,
      });
      break;
    }
  }
  return findings;
}

/**
 * Reports the base's violation against one available reference commit, or
 * `undefined` when the base satisfies the rule that commit draws: containment
 * for a pull request's own commit, precedence for its merge commit or a
 * commit reference's commit.
 */
async function describeReferenceCommitViolation(
  base: string,
  commit: RecordedReferenceCommit,
  repository: RepositoryDefinition,
  dependencies: ValidationDependencies,
): Promise<string | undefined> {
  const basePrefix = base.slice(0, 7);
  const commitPrefix = commit.hash.slice(0, 7);
  if (commit.hash === base) {
    return `base commit ${basePrefix} is reference commit ${commitPrefix}`;
  }
  if (commit.checkContainment) {
    const contains = await dependencies.git.isAncestor(repository, commit.hash, base);
    if (contains === true) {
      return `base commit ${basePrefix} contains reference commit ${commitPrefix}`;
    }
    if (contains === null) {
      return `base commit ${basePrefix} could not be compared with reference commit ${commitPrefix}`;
    }
    return undefined;
  }
  const precedes = await dependencies.git.isAncestor(repository, base, commit.hash);
  if (precedes === false) {
    return `base commit ${basePrefix} does not precede reference commit ${commitPrefix}`;
  }
  if (precedes === null) {
    return `base commit ${basePrefix} could not be compared with reference commit ${commitPrefix}`;
  }
  return undefined;
}

/**
 * Reads each distinct configured overlay directory once, discards the
 * snapshot, and emits one error finding per task, in configuration order,
 * whose overlay directory failed.
 */
async function collectOverlayFindings(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const read = new Map<string, TevuResult<unknown, 'CheckStateError'>>();
  for (const task of config.tasks) {
    const directory = task.checks.overlay;
    if (directory === undefined) {
      continue;
    }
    let result = read.get(directory);
    if (result === undefined) {
      result = await dependencies.git.readOverlay(directory);
      read.set(directory, result);
    }
    if (!result.ok) {
      findings.push({
        severity: 'error',
        identifier: `tasks.${task.id}.checks.overlay`,
        message: result.error.reason,
      });
    }
  }
  return findings;
}

/** Checks artifact destination writability without retained probe files. */
async function collectArtifactFindings(
  config: TevuConfig,
  dependencies: ValidationDependencies,
): Promise<ValidationFinding[]> {
  const writable = await dependencies.prerequisites.probeWritableDirectory(config.run.output_dir);
  return writable.ok ? [] : [prerequisiteFinding(writable.error)];
}

function prerequisiteFinding(
  error: Extract<TevuError, { kind: 'PrerequisiteError' }>,
): ValidationFinding {
  return {
    severity: 'error',
    identifier: `prerequisites.${error.tool}`,
    message:
      error.actual === undefined
        ? `expected ${error.expected}`
        : `expected ${error.expected}, actual ${error.actual}`,
  };
}
