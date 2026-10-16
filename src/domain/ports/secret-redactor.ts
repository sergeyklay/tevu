/** The `SecretRedactor` contract, with the redactor shape only it uses. */

import type { TevuResult } from '@/domain/errors';

/** Replaces every configured credential-secret value before a sink; injected by composition. */
export type Redactor = (text: string) => string;

/**
 * Credential-secret redaction over the current secret values; injected into
 * agent adapters. `redactText` passes through any exception the injected
 * redactor throws; `redactValue` never throws. Implementations of
 * `secretValues` must not throw.
 */
export interface SecretRedactor {
  secretValues(): readonly string[];
  redactText(text: string): string;
  /** Redacts every string, keys included, of a decoded JSON value; a cycle or a failed redactor yields `ArtifactError` whose reason carries no value. */
  redactValue(value: unknown): TevuResult<unknown, 'ArtifactError'>;
}
