import { createEnvironmentAdapter } from '@/adapters/process';

import type { EnvironmentAdapter } from '@/domain/ports/environment';

/** The variable names a child process reports, without the one macOS adds to every child environment. */
export function withoutPlatformVariables(names: readonly string[]): string[] {
  // macOS adds __CF_USER_TEXT_ENCODING to a child's environment even when the
  // parent omits it, so its presence says nothing about what tevu passed.
  return process.platform === 'darwin'
    ? names.filter((name) => name !== '__CF_USER_TEXT_ENCODING')
    : [...names];
}

/** Wraps the real environment adapter so every removal deletes the call directory and then fails, recording each root. */
export function buildRetainingEnvironments(): {
  environments: EnvironmentAdapter;
  roots: string[];
} {
  const real = createEnvironmentAdapter();
  const roots: string[] = [];
  const environments: EnvironmentAdapter = {
    ...real,
    createModelCallEnvironment: async (snapshot, agentVariables, configurationFiles) => {
      const created = await real.createModelCallEnvironment(
        snapshot,
        agentVariables,
        configurationFiles,
      );
      if (!created.ok) {
        return created;
      }
      roots.push(created.value.rootDirectory);
      return {
        ok: true,
        value: {
          ...created.value,
          dispose: async () => {
            await created.value.dispose();
            return {
              ok: false,
              error: { kind: 'ArtifactError', operation: 'remove', reason: 'busy' },
            };
          },
        },
      };
    },
  };
  return { environments, roots };
}
