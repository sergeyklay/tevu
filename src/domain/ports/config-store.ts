import type { TevuResult } from '@/domain/errors';

/** Reads and atomically replaces the raw configuration document text. */
export interface ConfigStore {
  /**
   * Resolves `false` only when probing the resolved absolute path fails with
   * `ENOENT`. Every other failure resolves `true`, so `readText` reports the
   * precise `ConfigReadError`.
   */
  exists(path: string): Promise<boolean>;
  /**
   * Fails with `PrerequisiteError` only when probing the directory of the
   * resolved absolute path fails with `ENOENT`; every other outcome succeeds.
   */
  requireDirectory(path: string): Promise<TevuResult<void, 'PrerequisiteError'>>;
  readText(path: string): Promise<TevuResult<string, 'ConfigReadError'>>;
  replaceText(path: string, text: string): Promise<TevuResult<void, 'ArtifactError'>>;
}
