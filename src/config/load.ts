import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parseDocument } from 'yaml';

import { TevuConfigSchema } from './schema';

import type {
  ConfigStore,
  LoadConfigErrorKind,
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
 * Resolves a parsed configuration's relative paths against `configPath`'s
 * directory and enforces real-path separation between the run output
 * directory and every configured repository.
 */
export async function resolveConfig(
  config: TevuConfig,
  configPath: string,
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
        {
          ...settings,
          command: settings.command.includes(path.sep)
            ? resolveConfigPath(configDirectory, settings.command)
            : settings.command,
        },
      ]),
    ),
    repositories: config.repositories.map((repository) => ({
      ...repository,
      path: resolveConfigPath(configDirectory, repository.path),
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

  const separationFindings = await collectSeparationFindings(resolved);
  if (separationFindings.length > 0) {
    return {
      ok: false,
      error: { kind: 'ConfigValidationError', findings: separationFindings },
    };
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
): Promise<TevuResult<TevuConfig, LoadConfigErrorKind>> {
  const text = await configStore.readText(configPath);
  if (!text.ok) {
    return text;
  }
  const parsed = parseConfigText(text.value);
  if (!parsed.ok) {
    return parsed;
  }
  return resolveConfig(parsed.value, configPath);
}

/** Resolves a configuration-relative path against the configuration file directory. */
export function resolveConfigPath(configDirectory: string, target: string): string {
  return path.resolve(configDirectory, target);
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
        identifier: `repositories.${repository.id}.path`,
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
