/**
 * Reads the provider definitions an agent block names from the operator's
 * OpenCode global configuration, merges them the way OpenCode itself does,
 * checks every copied definition against tevu's credential rules, and
 * prepares the case agent's own copied configuration file. Never writes a
 * file and never starts a process.
 *
 * Entry point: {@link readOpenCodeProviders}.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse, printParseErrorCode } from 'jsonc-parser';

import { describeCause } from '@/domain/describe-cause';

import type { OpenCodeAdapterDependencies, OpenCodeAdapterSettings } from './opencode';
import type { ProviderSnapshot, TevuResult, ValidationFinding } from '@/domain/types';
import type { ParseError } from 'jsonc-parser';

/** OpenCode's own file names and load order for its global configuration directory. */
const CONFIG_FILE_NAMES = ['config.json', 'opencode.json', 'opencode.jsonc'] as const;

/** OpenCode's own reference substitution syntax: `{env:NAME}`. */
const REFERENCE_PATTERN = /\{env:([^}]+)\}/g;
const WHOLE_REFERENCE_PATTERN = /^\{env:([^}]+)\}$/;

/** OpenCode's own secret-masking key pattern, matched case-insensitively anywhere in a key. */
const CREDENTIAL_KEY =
  /api.?key|secret|password|token$|authorization$|cookie$|credential|private.?key/i;

/**
 * Resolves the operator's OpenCode global configuration directory: the same
 * order, and the same set/non-empty/absolute test, OpenCode's own config
 * loader applies to `XDG_CONFIG_HOME` and `HOME`.
 */
export function operatorOpenCodeDirectory(
  directories: OpenCodeAdapterDependencies['operatorDirectories'],
): string | undefined {
  if (isUsableBase(directories.xdgConfigHome)) {
    return path.join(directories.xdgConfigHome, 'opencode');
  }
  if (isUsableBase(directories.home)) {
    return path.join(directories.home, '.config', 'opencode');
  }
  return undefined;
}

function isUsableBase(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && path.isAbsolute(value);
}

/**
 * Reads the providers `settings.providers` names from the operator's
 * OpenCode global configuration, merges their definitions across
 * `config.json`, `opencode.json`, and `opencode.jsonc` the way OpenCode
 * itself does, substitutes a configured `api_key`, and checks every
 * definition against tevu's credential rules.
 *
 * Reads no host file and returns immediately when `settings.providers` is
 * empty. Every message is built only from IDs, paths, variable names, file
 * paths, and error codes: never from a host-file value.
 */
export async function readOpenCodeProviders(
  settings: OpenCodeAdapterSettings,
  operatorDirectories: OpenCodeAdapterDependencies['operatorDirectories'],
): Promise<TevuResult<ProviderSnapshot, 'ConfigValidationError'>> {
  const { agent, providers, declaredVariables } = settings;
  if (providers.length === 0) {
    return { ok: true, value: { agent, configurationFiles: [], findings: [] } };
  }

  const blockIdentifier = `agents.${agent}.providers`;
  const directory = operatorOpenCodeDirectory(operatorDirectories);
  if (directory === undefined) {
    return configValidationError([
      {
        severity: 'error',
        identifier: blockIdentifier,
        message:
          'no OpenCode configuration directory to copy providers from: XDG_CONFIG_HOME and HOME are both unset, empty, or relative',
      },
    ]);
  }

  const collected = new Map<string, unknown>();
  const readFindings: ValidationFinding[] = [];
  for (const fileName of CONFIG_FILE_NAMES) {
    const filePath = path.join(directory, fileName);
    readFindings.push(
      ...(await readOneConfigFile(filePath, blockIdentifier, providers, collected)),
    );
  }
  if (readFindings.length > 0) {
    return configValidationError(readFindings);
  }

  const findings: ValidationFinding[] = [];
  const warnings: ValidationFinding[] = [];
  const listed: Array<[string, Record<string, unknown>]> = [];
  for (const entry of providers) {
    const idIdentifier = `${blockIdentifier}.${entry.id}`;
    const raw = collected.get(entry.id);
    if (raw === undefined) {
      findings.push({
        severity: 'error',
        identifier: idIdentifier,
        message: `provider "${entry.id}" is not defined in config.json, opencode.json, or opencode.jsonc under "${directory}"`,
      });
      continue;
    }
    if (!isPlainObject(raw)) {
      findings.push({
        severity: 'error',
        identifier: idIdentifier,
        message: `the definition of provider "${entry.id}" is not an object`,
      });
      continue;
    }
    let definition = raw;
    if (entry.api_key !== undefined) {
      const options = definition['options'];
      if (options !== undefined && !isPlainObject(options)) {
        findings.push({
          severity: 'error',
          identifier: idIdentifier,
          message: `the options of provider "${entry.id}" is not an object`,
        });
        continue;
      }
      definition = {
        ...definition,
        options: { ...(isPlainObject(options) ? options : {}), apiKey: `{env:${entry.api_key}}` },
      };
    }
    const checked = checkDefinition(agent, entry.id, definition, declaredVariables);
    findings.push(...checked.findings);
    if (checked.findings.length === 0 && !checked.namesSecret) {
      warnings.push({
        severity: 'warning',
        identifier: idIdentifier,
        message: `provider "${entry.id}" names no variable listed in agents.${agent}.secrets, so a case receives it without a credential; if its key is in the OpenCode login store, set api_key`,
      });
    }
    listed.push([entry.id, definition]);
  }
  if (findings.length > 0) {
    return configValidationError(findings);
  }

  const document = { provider: Object.fromEntries(listed) };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  return {
    ok: true,
    value: {
      agent,
      configurationFiles: [{ relativePath: 'opencode/opencode.json', text }],
      findings: warnings,
    },
  };
}

/**
 * Reads and parses one candidate configuration file, merging every named
 * provider's definition it defines into `collected`. A missing file (ENOENT)
 * contributes nothing; every other failure becomes a finding and the file
 * contributes nothing.
 */
async function readOneConfigFile(
  filePath: string,
  blockIdentifier: string,
  providers: OpenCodeAdapterSettings['providers'],
  collected: Map<string, unknown>,
): Promise<ValidationFinding[]> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch (cause) {
    if (nodeErrorCode(cause) === 'ENOENT') {
      return [];
    }
    return [
      {
        severity: 'error',
        identifier: blockIdentifier,
        message: `cannot read "${filePath}": ${nodeErrorCode(cause) ?? describeCause(cause)}`,
      },
    ];
  }

  const errors: ParseError[] = [];
  const document: unknown = parse(text, errors, { allowTrailingComma: true });
  const [firstError] = errors;
  if (firstError !== undefined) {
    const { line, column } = lineAndColumn(text, firstError.offset);
    return [
      {
        severity: 'error',
        identifier: blockIdentifier,
        message: `"${filePath}" is not valid JSON with comments: ${printParseErrorCode(firstError.error)} at line ${line}, column ${column}`,
      },
    ];
  }
  if (!isPlainObject(document)) {
    return [
      {
        severity: 'error',
        identifier: blockIdentifier,
        message: `"${filePath}": the top level is not an object`,
      },
    ];
  }
  if (!Object.prototype.hasOwnProperty.call(document, 'provider')) {
    return [];
  }
  const providerMap = document['provider'];
  if (!isPlainObject(providerMap)) {
    return [
      {
        severity: 'error',
        identifier: blockIdentifier,
        message: `"${filePath}": provider is not an object`,
      },
    ];
  }
  for (const entry of providers) {
    if (Object.prototype.hasOwnProperty.call(providerMap, entry.id)) {
      collected.set(entry.id, merge(collected.get(entry.id), providerMap[entry.id]));
    }
  }
  return [];
}

/**
 * Merges one provider's earlier and later definitions the way OpenCode
 * merges its configuration files: a deep merge of plain objects, keyed by
 * own enumerable property so a `__proto__` key in a host file never becomes
 * an own key; any other pairing (an array or scalar on either side) lets
 * `later` replace `earlier` entirely.
 */
function merge(earlier: unknown, later: unknown): unknown {
  if (!isPlainObject(earlier) || !isPlainObject(later)) {
    return later;
  }
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(earlier)) {
    merged[key] = Object.prototype.hasOwnProperty.call(later, key)
      ? merge(earlier[key], later[key])
      : earlier[key];
  }
  for (const key of Object.keys(later)) {
    if (!Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = later[key];
    }
  }
  return merged;
}

/** Result of checking one merged provider definition against the credential and reference rules. */
type CheckedDefinition = { findings: ValidationFinding[]; namesSecret: boolean };

/**
 * Walks one provider definition depth-first in key order, checking every
 * credential and reference against `declared.secrets` and `declared.env`,
 * and reporting whether the definition names a variable listed in
 * `declared.secrets`.
 */
function checkDefinition(
  agent: string,
  id: string,
  definition: Record<string, unknown>,
  declared: { secrets: readonly string[]; env: readonly string[] },
): CheckedDefinition {
  const findings: ValidationFinding[] = [];
  const reported = new Set<string>();
  let namesSecret = false;

  const noteSecretName = (name: string): void => {
    if (declared.secrets.includes(name)) {
      namesSecret = true;
    }
  };

  const pushOnce = (key: string, finding: ValidationFinding): void => {
    if (!reported.has(key)) {
      reported.add(key);
      findings.push(finding);
    }
  };

  const checkGenericString = (segments: readonly (string | number)[], value: string): void => {
    const pathText = segments.join('.');
    if (value.includes('{file:')) {
      findings.push(fileFinding(agent, id, pathText));
    }
    for (const name of extractReferenceNames(value)) {
      noteSecretName(name);
      if (!declared.secrets.includes(name) && !declared.env.includes(name)) {
        pushOnce(`env\u0000${pathText}\u0000${name}`, envFinding(agent, id, pathText, name));
      }
    }
  };

  const checkHeaderValue = (segments: readonly (string | number)[], value: unknown): void => {
    const pathText = segments.join('.');
    const lastKey = segments[segments.length - 1];
    const isCredentialHeader = typeof lastKey === 'string' && CREDENTIAL_KEY.test(lastKey);
    const text = typeof value === 'string' ? value : undefined;
    const names = text === undefined ? [] : extractReferenceNames(text);
    if (names.length === 0) {
      findings.push(headerFinding(agent, id, pathText, isCredentialHeader));
    }
    for (const name of names) {
      noteSecretName(name);
      if (isCredentialHeader) {
        if (!declared.secrets.includes(name)) {
          pushOnce(
            `secret\u0000${pathText}\u0000${name}`,
            secretHeaderFinding(agent, id, pathText, name),
          );
        }
      } else if (!declared.secrets.includes(name) && !declared.env.includes(name)) {
        pushOnce(`env\u0000${pathText}\u0000${name}`, envFinding(agent, id, pathText, name));
      }
    }
    if (text !== undefined && text.includes('{file:')) {
      findings.push(fileFinding(agent, id, pathText));
    }
  };

  const checkApiKeyLike = (segments: readonly (string | number)[], value: unknown): void => {
    const pathText = segments.join('.');
    const text = typeof value === 'string' ? value : undefined;
    const name = text === undefined ? undefined : wholeReferenceName(text);
    if (name === undefined) {
      findings.push(apiKeyNotReferenceFinding(agent, id, pathText));
      return;
    }
    noteSecretName(name);
    if (!declared.secrets.includes(name)) {
      findings.push(apiKeyUndeclaredFinding(agent, id, pathText, name));
    }
  };

  const walk = (value: unknown, segments: readonly (string | number)[]): void => {
    if (segments.length > 0 && isHeaderPath(segments)) {
      checkHeaderValue(segments, value);
      return;
    }
    const lastKey = segments[segments.length - 1];
    const isApiKeyPath =
      segments.length > 0 &&
      typeof lastKey === 'string' &&
      (lastKey === 'apiKey' || (CREDENTIAL_KEY.test(lastKey) && typeof value === 'string'));
    if (isApiKeyPath) {
      checkApiKeyLike(segments, value);
      return;
    }
    if (typeof value === 'string') {
      checkGenericString(segments, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...segments, index]));
      return;
    }
    if (isPlainObject(value)) {
      for (const key of Object.keys(value)) {
        checkGenericString([...segments, key], key);
        walk(value[key], [...segments, key]);
      }
    }
  };

  walk(definition, []);

  const rootEnv = definition['env'];
  if (Array.isArray(rootEnv)) {
    for (const item of rootEnv) {
      if (typeof item !== 'string') {
        continue;
      }
      noteSecretName(item);
      if (declared.env.includes(item)) {
        pushOnce(`rootenv\u0000${item}`, rootEnvSecretFinding(agent, id, item));
      }
    }
  }

  return { findings, namesSecret };
}

function isHeaderPath(segments: readonly (string | number)[]): boolean {
  return segments.length >= 2 && segments[segments.length - 2] === 'headers';
}

function extractReferenceNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(REFERENCE_PATTERN)) {
    const name = match[1];
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
}

function wholeReferenceName(value: string): string | undefined {
  return WHOLE_REFERENCE_PATTERN.exec(value)?.[1];
}

function providerIdentifier(agent: string, id: string): string {
  return `agents.${agent}.providers.${id}`;
}

function apiKeyNotReferenceFinding(agent: string, id: string, pathText: string): ValidationFinding {
  const suffix =
    pathText === 'options.apiKey'
      ? `set api_key to a variable listed in agents.${agent}.secrets`
      : 'reference such a variable there';
  return {
    severity: 'error',
    identifier: providerIdentifier(agent, id),
    message: `${pathText} of provider "${id}" is not a {env:NAME} reference; tevu copies no credential value into a case: ${suffix}`,
  };
}

function apiKeyUndeclaredFinding(
  agent: string,
  id: string,
  pathText: string,
  name: string,
): ValidationFinding {
  return {
    severity: 'error',
    identifier: providerIdentifier(agent, id),
    message: `${pathText} of provider "${id}" references ${name}, which is not listed in agents.${agent}.secrets`,
  };
}

function headerFinding(
  agent: string,
  id: string,
  pathText: string,
  isCredentialHeader: boolean,
): ValidationFinding {
  const suffix = isCredentialHeader ? '' : ` or agents.${agent}.env`;
  return {
    severity: 'error',
    identifier: providerIdentifier(agent, id),
    message: `${pathText} of provider "${id}" holds no {env:NAME} reference; tevu copies no literal header value into a case: reference a variable listed in agents.${agent}.secrets${suffix}`,
  };
}

function fileFinding(agent: string, id: string, pathText: string): ValidationFinding {
  return {
    severity: 'error',
    identifier: providerIdentifier(agent, id),
    message: `${pathText} of provider "${id}" holds a {file:...} reference; tevu copies no host file into a case`,
  };
}

function envFinding(agent: string, id: string, pathText: string, name: string): ValidationFinding {
  return {
    severity: 'error',
    identifier: providerIdentifier(agent, id),
    message: `${pathText} of provider "${id}" references ${name}, which is listed in neither agents.${agent}.secrets nor agents.${agent}.env, so a case would receive an empty value`,
  };
}

function secretHeaderFinding(
  agent: string,
  id: string,
  pathText: string,
  name: string,
): ValidationFinding {
  return {
    severity: 'error',
    identifier: providerIdentifier(agent, id),
    message: `${pathText} of provider "${id}" references ${name}, which is not listed in agents.${agent}.secrets; a credential header takes only a secret variable`,
  };
}

function rootEnvSecretFinding(agent: string, id: string, name: string): ValidationFinding {
  return {
    severity: 'error',
    identifier: providerIdentifier(agent, id),
    message: `env entry ${name} of provider "${id}" is listed in agents.${agent}.env, and OpenCode reads the provider's key from it: list it in agents.${agent}.secrets instead`,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nodeErrorCode(cause: unknown): string | undefined {
  if (typeof cause !== 'object' || cause === null || !('code' in cause)) {
    return undefined;
  }
  const code = (cause as { code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Computes a 1-based line and column for a parse-error offset into `text`. */
function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let columnStart = 0;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n') {
      line += 1;
      columnStart = index + 1;
    }
  }
  return { line, column: offset - columnStart + 1 };
}

function configValidationError(
  findings: readonly ValidationFinding[],
): TevuResult<ProviderSnapshot, 'ConfigValidationError'> {
  return { ok: false, error: { kind: 'ConfigValidationError', findings: [...findings] } };
}
