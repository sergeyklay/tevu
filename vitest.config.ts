import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  // Knip derives the test entry files only when a `test` block is present.
  test: {},
});
