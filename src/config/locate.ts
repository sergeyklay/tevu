/**
 * Configuration file search: locates the file `--config` names, or the
 * first readable candidate of the current-directory and user configuration
 * files when no path was given.
 *
 * Entry point: {@link locateConfig}.
 */

import * as path from 'node:path';

import type { ConfigStore, TevuResult } from '@/domain/types';

/**
 * Process-derived facts the search needs; callers pass an object literal so
 * no process global is read inside this module.
 */
type ConfigSearchEnvironment = {
  /** Absolute working directory. */
  cwd: string;
  /** HOME as the process received it; undefined when unset. */
  home: string | undefined;
  /** XDG_CONFIG_HOME as the process received it; undefined when unset. */
  xdgConfigHome: string | undefined;
};

/**
 * Locates the configuration file: the explicit `--config` path when given,
 * otherwise the first readable candidate of the current-directory file and
 * the user configuration file.
 *
 * Explicit mode never calls `configStore.readText` and resolves `requestedPath`
 * against `environment.cwd` without probing the filesystem. Search mode reads
 * each candidate in order, stopping at the first successful read or the first
 * read error whose cause is not `not-found`; when every candidate is
 * `not-found`, the search fails with `ConfigNotFoundError`.
 */
export async function locateConfig(
  requestedPath: string | undefined,
  environment: ConfigSearchEnvironment,
  configStore: Pick<ConfigStore, 'readText'>,
): Promise<TevuResult<string, 'ConfigReadError' | 'ConfigNotFoundError'>> {
  if (requestedPath !== undefined) {
    return { ok: true, value: path.resolve(environment.cwd, requestedPath) };
  }

  const candidates = buildCandidates(environment);
  for (const candidate of candidates) {
    const read = await configStore.readText(candidate);
    if (read.ok) {
      return { ok: true, value: candidate };
    }
    if (read.error.cause !== 'not-found') {
      return read;
    }
  }
  return { ok: false, error: { kind: 'ConfigNotFoundError', searchedPaths: candidates } };
}

/** Builds the search candidate list, dropping a user file identical to the current-directory file. */
function buildCandidates(
  environment: ConfigSearchEnvironment,
): [currentDirectoryFile: string] | [currentDirectoryFile: string, userFile: string] {
  const currentDirectoryFile = path.join(environment.cwd, 'tevu.yaml');
  const userFile = userConfigFile(environment);
  if (userFile === undefined || userFile === currentDirectoryFile) {
    return [currentDirectoryFile];
  }
  return [currentDirectoryFile, userFile];
}

/** Resolves the user configuration file from `XDG_CONFIG_HOME`, falling back to `$HOME/.config`. */
function userConfigFile(environment: ConfigSearchEnvironment): string | undefined {
  if (isUsableBase(environment.xdgConfigHome)) {
    return path.join(environment.xdgConfigHome, 'tevu', 'tevu.yaml');
  }
  if (isUsableBase(environment.home)) {
    return path.join(environment.home, '.config', 'tevu', 'tevu.yaml');
  }
  return undefined;
}

function isUsableBase(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && path.isAbsolute(value);
}
