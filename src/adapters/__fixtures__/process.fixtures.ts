import { chmod, writeFile } from 'node:fs/promises';

import { createRedactor, createSecretRedactor } from '@/adapters/process';

import type { SecretRedactor } from '@/domain/ports/secret-redactor';

/** Writes `contents` to `path` and marks the file executable. */
export async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

/** Builds a redactor that masks every value of `secretValues`. */
export function buildSecretRedactor(secretValues: readonly string[]): SecretRedactor {
  return createSecretRedactor(() => secretValues, createRedactor(secretValues));
}
