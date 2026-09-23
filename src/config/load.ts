import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseDocument } from "yaml";

import { TevuConfigSchema } from "./schema.ts";

import type { TevuConfig } from "./schema.ts";
import type { TevuResult, ValidationFinding } from "../domain/types.ts";

/** Error kinds a configuration load can produce. */
type LoadConfigErrorKind = "ConfigParseError" | "ConfigValidationError" | "ArtifactError";

/**
 * Loads and validates the UTF-8 YAML configuration at the given path.
 *
 * Parses with YAML 1.2 core semantics, validates through the strict
 * authoritative schema, resolves relative paths against the configuration file
 * directory, and enforces real-path separation between the artifact directory
 * and every configured repository. Performs no Git, OpenCode, Jira, wizard, or
 * artifact mutation work.
 */
export async function loadConfig(
  configPath: string,
): Promise<TevuResult<TevuConfig, LoadConfigErrorKind>> {
  const absoluteConfigPath = path.resolve(configPath);

  let text: string;
  try {
    text = await fs.readFile(absoluteConfigPath, "utf8");
  } catch {
    return {
      ok: false,
      error: {
        kind: "ArtifactError",
        operation: "read-configuration",
        reason: "Cannot read configuration file; check the path and access permissions",
      },
    };
  }

  const document = parseDocument(text, { version: "1.2", schema: "core" });
  if (document.errors.length > 0) {
    return {
      ok: false,
      error: {
        kind: "ConfigParseError",
        findings: document.errors.map((error) => ({
          severity: "error",
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
        kind: "ConfigParseError",
        findings: [{ severity: "error", identifier: "config", message: "Cannot resolve YAML aliases" }],
      },
    };
  }
  const parsed = TevuConfigSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "ConfigValidationError",
        findings: parsed.error.issues.map((issue) => ({
          severity: "error",
          identifier: issuePathIdentifier(issue.path),
          message: issue.code === "unrecognized_keys" ? "Unknown configuration field" : issue.message,
        })),
      },
    };
  }

  const configDirectory = path.dirname(absoluteConfigPath);
  const resolved: TevuConfig = {
    ...parsed.data,
    artifacts: {
      directory: resolveConfigPath(configDirectory, parsed.data.artifacts.directory),
    },
    opencode: {
      executable: parsed.data.opencode.executable.includes(path.sep)
        ? resolveConfigPath(configDirectory, parsed.data.opencode.executable)
        : parsed.data.opencode.executable,
    },
    repositories: parsed.data.repositories.map((repository) => ({
      ...repository,
      path: resolveConfigPath(configDirectory, repository.path),
    })),
  };

  const separationFindings = await collectSeparationFindings(resolved);
  if (separationFindings.length > 0) {
    return {
      ok: false,
      error: { kind: "ConfigValidationError", findings: separationFindings },
    };
  }

  return { ok: true, value: resolved };
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
  if (value !== null && typeof value === "object") {
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
  const artifactReal = await canonicalRealPath(config.artifacts.directory);
  for (const repository of config.repositories) {
    const repositoryReal = await canonicalRealPath(repository.path);
    if (isSamePathOrInside(repositoryReal, artifactReal)) {
      findings.push({
        severity: "error",
        identifier: "artifacts.directory",
        message: `artifacts.directory must be outside repository "${repository.id}" after real-path resolution`,
      });
    } else if (isSamePathOrInside(artifactReal, repositoryReal)) {
      findings.push({
        severity: "error",
        identifier: `repositories.${repository.id}.path`,
        message: `repository "${repository.id}" overlaps the artifact directory after real-path resolution`,
      });
    }
  }
  return findings;
}

/**
 * Resolves symlinks through the nearest existing ancestor so separation holds
 * even when the artifact directory does not exist yet.
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
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function issuePathIdentifier(issuePath: ReadonlyArray<PropertyKey>): string {
  if (issuePath.length === 0) {
    return "config";
  }
  return issuePath
    .map((segment) => (typeof segment === "symbol" ? String(segment.description ?? "symbol") : String(segment)))
    .join(".");
}
