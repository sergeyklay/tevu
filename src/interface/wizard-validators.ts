/**
 * Answer validators and the list splitter they share.
 */

import {
  DurationSchema,
  HttpsUrlSchema,
  ModelIdentifierSchema,
  VariableNameSchema,
} from '@/config/schema';
import { FIXED_ENVIRONMENT_NAME_MESSAGE, isFixedEnvironmentName } from '@/domain/fixed-environment';

/** Splits a list answer on commas, whitespace, or both, dropping empty tokens. */
export function splitNames(raw: string): string[] {
  return raw.split(/[\s,]+/).filter((token) => token.length > 0);
}

export type TextValidator = (value: string | undefined) => string | undefined;

export function validateNonWhitespace(value: string | undefined): string | undefined {
  return (value ?? '').trim().length === 0 ? 'a non-empty value is required' : undefined;
}

export function validateModel(value: string | undefined): string | undefined {
  return ModelIdentifierSchema.safeParse(value ?? '').success
    ? undefined
    : 'model must be "<provider>/<model>"';
}

export function validateHttpsUrl(value: string | undefined): string | undefined {
  return HttpsUrlSchema.safeParse(value ?? '').success ? undefined : 'an https:// URL is required';
}

/** Reuses the schema's Duration grammar (including the E1 bound) rather than a second regex. */
export function validateDuration(value: string | undefined): string | undefined {
  const result = DurationSchema.safeParse((value ?? '').trim());
  if (result.success) {
    return undefined;
  }
  return result.error.issues[0]?.message ?? 'invalid duration';
}

export function validateVariableNameGrammar(value: string): string | undefined {
  const result = VariableNameSchema.safeParse(value);
  if (result.success) {
    return undefined;
  }
  return result.error.issues[0]?.message ?? 'invalid variable name';
}

export function unsetVariableProblem(name: string): string {
  return `"${name}" isn't set in this terminal`;
}

export function validateVariableName(
  takenNames: ReadonlySet<string>,
  isVariableSet: (name: string) => boolean,
): TextValidator {
  return (raw) => {
    const value = raw ?? '';
    const grammar = validateVariableNameGrammar(value);
    if (grammar !== undefined) {
      return grammar;
    }
    if (isFixedEnvironmentName(value)) {
      return FIXED_ENVIRONMENT_NAME_MESSAGE;
    }
    if (takenNames.has(value)) {
      return `"${value}" is already configured`;
    }
    return isVariableSet(value) ? undefined : unsetVariableProblem(value);
  };
}

export function validateCheckVariableList(
  excludedNames: ReadonlySet<string>,
  isVariableSet: (name: string) => boolean,
): TextValidator {
  return (raw) => {
    const names = splitNames(raw ?? '');
    const seen = new Set<string>();
    for (const name of names) {
      const grammar = validateVariableNameGrammar(name);
      if (grammar !== undefined) {
        return `"${name}": ${grammar}`;
      }
      if (isFixedEnvironmentName(name)) {
        return FIXED_ENVIRONMENT_NAME_MESSAGE;
      }
      if (excludedNames.has(name)) {
        return `"${name}" is passed to the agent or Jira and cannot also be passed to a check`;
      }
      if (seen.has(name)) {
        return `"${name}" is listed more than once`;
      }
      if (!isVariableSet(name)) {
        return unsetVariableProblem(name);
      }
      seen.add(name);
    }
    return undefined;
  };
}

export function validateExitCodes(value: string | undefined): string | undefined {
  const tokens = (value ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return undefined;
  }
  if (tokens.some((token) => !/^-?\d+$/.test(token))) {
    return 'enter one or more comma-separated integers, e.g. 0';
  }
  return undefined;
}
