import { defineConfig } from 'vitest/config';

import manifest from './package.json' with { type: 'json' };

export default defineConfig({
  resolve: { tsconfigPaths: true },
  define: { __TEVU_VERSION__: JSON.stringify(manifest.version) },
  // Knip derives the test entry files only when a `test` block is present.
  test: {},
});
