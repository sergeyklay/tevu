import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDocument } from 'yaml';

import { TevuConfigSchema } from './schema';

import type { ModelRoleInput, RepositoryInput, TevuConfigInput } from './schema';
import type {
  ConfigStore,
  LoadConfigErrorKind,
  ModelRole,
  ModelRoleCallConfig,
  ModelRoleName,
  RepositoryDefinition,
  TevuConfig,
  TevuResult,
  ValidationFinding,
} from '@/domain/types';

/**
 * Parses and validates one configuration document's text against the
 * authoritative schema. Performs no filesystem or path-resolution work.
 */
export function parseConfigText(
  text: string,
): TevuResult<TevuConfig, 'ConfigParseError' | 'ConfigValidationError'> {
  const document = parseDocument(text, { version: '1.2', schema: 'core' });
  if (document.errors.length > 0) {
    return {
      ok: false,
      error: {
        kind: 'ConfigParseError',
        findings: document.errors.map((error) => ({
          severity: 'error',
          identifier: `line ${error.linePos?.[0]?.line ?? 0}`,
          message: `Invalid YAML (${error.code})`,
        })),
      },
    };
  }

  let value: unknown;
  try {
    value = document.toJS();
  } catch {
    return {
      ok: false,
      error: {
        kind: 'ConfigParseError',
        findings: [
          { severity: 'error', identifier: 'config', message: 'Cannot resolve YAML aliases' },
        ],
      },
    };
  }
  const parsed = TevuConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: 'ConfigValidationError',
        findings: parsed.error.issues.map((issue) => ({
          severity: 'error',
          identifier: issuePathIdentifier(issue.path),
          message:
            issue.code === 'unrecognized_keys' ? 'Unknown configuration field' : issue.message,
        })),
      },
    };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Resolves a repository entry's directory: a local `path` against
 * `configDirectory`, or a GitHub entry's managed-clone location (already
 * materialized onto `path` by the schema transform) against
 * `managedCloneRoot`. Returns `undefined` only for a GitHub entry with no
 * managed-clone root.
 */
export function resolveRepositoryPath(
  repository: Pick<RepositoryInput, 'path' | 'github'>,
  configDirectory: string,
  managedCloneRoot: string | undefined,
): string | undefined {
  const { path: repositoryPath, github } = repository;
  if (github !== undefined) {
    return managedCloneRoot === undefined || repositoryPath === undefined
      ? undefined
      : path.resolve(managedCloneRoot, repositoryPath);
  }
  return repositoryPath === undefined
    ? undefined
    : resolveConfigPath(configDirectory, repositoryPath);
}

/**
 * Resolves a parsed configuration's relative paths against `configPath`'s
 * directory and `managedCloneRoot`, and enforces real-path separation
 * between the run output directory, every configured repository, and every
 * managed clone.
 */
export async function resolveConfig(
  config: TevuConfig,
  configPath: string,
  managedCloneRoot: string | undefined,
): Promise<TevuResult<TevuConfig, 'ConfigValidationError'>> {
  const configDirectory = path.dirname(path.resolve(configPath));
  const resolved: TevuConfig = {
    ...config,
    run: {
      ...config.run,
      output_dir: resolveConfigPath(configDirectory, config.run.output_dir),
    },
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([name, settings]) => [
        name,
        { ...settings, command: resolveAgentCommand(settings.command, configDirectory) },
      ]),
    ),
    repositories: config.repositories.map((repository) => ({
      ...repository,
      path: resolveRepositoryPath(repository, configDirectory, managedCloneRoot) ?? repository.path,
    })),
    tasks: config.tasks.map((task) =>
      task.checks.overlay === undefined
        ? task
        : {
            ...task,
            checks: {
              ...task.checks,
              overlay: resolveConfigPath(configDirectory, task.checks.overlay),
            },
          },
    ),
  };

  const findings = [
    ...missingManagedCloneRootFindings(config, managedCloneRoot),
    ...(await collectSeparationFindings(resolved)),
    ...(await collectManagedCloneOverlapFindings(resolved, managedCloneRoot)),
  ];
  if (findings.length > 0) {
    return { ok: false, error: { kind: 'ConfigValidationError', findings } };
  }

  return { ok: true, value: resolved };
}

/**
 * Loads and validates the UTF-8 YAML configuration at the given path.
 *
 * Reads the text through `configStore.readText`, so the result agrees with
 * `readText` by construction, then parses and validates it against the strict
 * authoritative schema, then resolves relative paths against the
 * configuration file directory and enforces real-path separation between the
 * run output directory and every configured repository. Performs no Git,
 * agent, Jira, wizard, or artifact mutation work.
 */
export async function loadConfig(
  configPath: string,
  configStore: Pick<ConfigStore, 'readText'>,
  managedCloneRoot: string | undefined,
): Promise<TevuResult<TevuConfig, LoadConfigErrorKind>> {
  const text = await configStore.readText(configPath);
  if (!text.ok) {
    return text;
  }
  const parsed = parseConfigText(text.value);
  if (!parsed.ok) {
    return parsed;
  }
  return resolveConfig(parsed.value, configPath, managedCloneRoot);
}

/** Resolves a configuration-relative path against the configuration file directory. */
function resolveConfigPath(configDirectory: string, target: string): string {
  return path.resolve(configDirectory, target);
}

/** Resolves one agent's `command`: a value containing a path separator resolves against `configDirectory`; any other value is a bare executable name, left unchanged. */
export function resolveAgentCommand(command: string, configDirectory: string): string {
  return command.includes(path.sep) ? resolveConfigPath(configDirectory, command) : command;
}

/**
 * Resolves a `tevu task add` bootstrap answer set into a {@link ModelRoleCallConfig},
 * the same fields `loadConfig` would produce for the file `createTask` writes
 * from the same answers.
 *
 * Defaults every agent block's `secrets` and `env` to `[]`, resolves each
 * agent's `command` by the same rule {@link resolveConfig} applies, and
 * defaults each declared role's `agent` to the first configured agent key.
 */
export function resolveBootstrapModelCallConfig(
  answers: Omit<TevuConfigInput, 'version' | 'tasks'>,
  configPath: string,
): ModelRoleCallConfig {
  const configDirectory = path.dirname(path.resolve(configPath));
  const agents = Object.fromEntries(
    Object.entries(answers.agents).map(([name, settings]) => [
      name,
      {
        command: resolveAgentCommand(settings.command, configDirectory),
        secrets: settings.secrets ?? [],
        env: settings.env ?? [],
        providers: settings.providers ?? [],
      },
    ]),
  );
  const firstAgentKey = Object.keys(agents)[0];
  if (firstAgentKey === undefined) {
    throw new Error('unreachable: the bootstrap answers always declare at least one agent');
  }
  const rolesInput = answers.roles;
  const roles: Partial<Record<ModelRoleName, ModelRole>> | undefined =
    rolesInput === undefined
      ? undefined
      : {
          ...(rolesInput.criteria === undefined
            ? {}
            : { criteria: resolveBootstrapModelRole(rolesInput.criteria, firstAgentKey) }),
          ...(rolesInput.grader === undefined
            ? {}
            : { grader: resolveBootstrapModelRole(rolesInput.grader, firstAgentKey) }),
        };
  return {
    agents,
    ...(roles === undefined ? {} : { roles }),
    run: { timeout: answers.run.timeout, stop_grace: answers.run.stop_grace },
  };
}

/** Resolves one declared model role's `agent` default, exactly as `schema.ts`'s `materializeModelRole` does. */
function resolveBootstrapModelRole(role: ModelRoleInput, firstAgentKey: string): ModelRole {
  return { model: role.model, effort: role.effort, agent: role.agent ?? firstAgentKey };
}

/**
 * Serializes a validated configuration deterministically for digest input.
 *
 * Sorts every object key recursively; the configuration carries environment
 * variable names only, never secret values, so the serialization is safe to
 * digest and compare.
 */
export function canonicalConfigSerialization(config: TevuConfig): string {
  return JSON.stringify(sortKeysDeep(config));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    );
  }
  return value;
}

/** `repositories.<id>.github` for a GitHub entry; `repositories.<id>.path` for a path entry. */
function repositoryPathIdentifier(repository: RepositoryDefinition): string {
  return repository.github === undefined
    ? `repositories.${repository.id}.path`
    : `repositories.${repository.id}.github`;
}

/** A GitHub entry with no managed-clone root: `resolveRepositoryPath` cannot locate its clone. */
function missingManagedCloneRootFindings(
  config: TevuConfig,
  managedCloneRoot: string | undefined,
): ValidationFinding[] {
  if (managedCloneRoot !== undefined) {
    return [];
  }
  return config.repositories
    .filter((repository) => repository.github !== undefined)
    .map((repository) => ({
      severity: 'error' as const,
      identifier: `repositories.${repository.id}.github`,
      message:
        'a GitHub repository entry needs XDG_CACHE_HOME or HOME set to an absolute path for its managed clone',
    }));
}

/**
 * With at least one GitHub entry present, flags a path entry whose real path
 * equals, lies inside, or contains the managed-clone root after real-path
 * resolution: tevu never writes to a repository declared by `path`.
 */
async function collectManagedCloneOverlapFindings(
  config: TevuConfig,
  managedCloneRoot: string | undefined,
): Promise<ValidationFinding[]> {
  const hasGitHubEntry = config.repositories.some((repository) => repository.github !== undefined);
  if (!hasGitHubEntry || managedCloneRoot === undefined) {
    return [];
  }
  const rootReal = await canonicalRealPath(managedCloneRoot);
  const findings: ValidationFinding[] = [];
  for (const repository of config.repositories) {
    if (repository.github !== undefined) {
      continue;
    }
    const repositoryReal = await canonicalRealPath(repository.path);
    if (
      isSamePathOrInside(repositoryReal, rootReal) ||
      isSamePathOrInside(rootReal, repositoryReal)
    ) {
      findings.push({
        severity: 'error',
        identifier: `repositories.${repository.id}.path`,
        message: `repository "${repository.id}" overlaps the managed-clone directory "${managedCloneRoot}" after real-path resolution`,
      });
    }
  }
  return findings;
}

async function collectSeparationFindings(config: TevuConfig): Promise<ValidationFinding[]> {
  const findings: ValidationFinding[] = [];
  const outputReal = await canonicalRealPath(config.run.output_dir);
  const repositoryReals: { id: string; real: string }[] = [];
  for (const repository of config.repositories) {
    const repositoryReal = await canonicalRealPath(repository.path);
    repositoryReals.push({ id: repository.id, real: repositoryReal });
    if (isSamePathOrInside(repositoryReal, outputReal)) {
      findings.push({
        severity: 'error',
        identifier: 'run.output_dir',
        message: `run.output_dir must be outside repository "${repository.id}" after real-path resolution`,
      });
    } else if (isSamePathOrInside(outputReal, repositoryReal)) {
      findings.push({
        severity: 'error',
        identifier: repositoryPathIdentifier(repository),
        message: `repository "${repository.id}" overlaps the run output directory after real-path resolution`,
      });
    }
  }

  for (const task of config.tasks) {
    if (task.checks.overlay === undefined) {
      continue;
    }
    const overlayReal = await canonicalRealPath(task.checks.overlay);
    for (const repository of repositoryReals) {
      if (isSamePathOrInside(repository.real, overlayReal)) {
        findings.push({
          severity: 'error',
          identifier: `tasks.${task.id}.checks.overlay`,
          message: `overlay must be outside repository "${repository.id}" after real-path resolution`,
        });
      } else if (isSamePathOrInside(overlayReal, repository.real)) {
        findings.push({
          severity: 'error',
          identifier: `tasks.${task.id}.checks.overlay`,
          message: `overlay contains repository "${repository.id}" after real-path resolution`,
        });
      }
    }
    if (
      isSamePathOrInside(outputReal, overlayReal) ||
      isSamePathOrInside(overlayReal, outputReal)
    ) {
      findings.push({
        severity: 'error',
        identifier: `tasks.${task.id}.checks.overlay`,
        message: 'overlay must not overlap run.output_dir after real-path resolution',
      });
    }
  }
  return findings;
}

/**
 * Resolves symlinks through the nearest existing ancestor so separation holds
 * even when the run output directory does not exist yet.
 */
async function canonicalRealPath(target: string): Promise<string> {
  let current = path.resolve(target);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return suffix.length === 0 ? real : path.join(real, ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return suffix.length === 0 ? current : path.join(current, ...suffix);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isSamePathOrInside(ancestor: string, candidate: string): boolean {
  const relative = path.relative(ancestor, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function issuePathIdentifier(issuePath: ReadonlyArray<PropertyKey>): string {
  if (issuePath.length === 0) {
    return 'config';
  }
  return issuePath
    .map((segment) =>
      typeof segment === 'symbol' ? String(segment.description ?? 'symbol') : String(segment),
    )
    .join('.');
}
