import { configDefaults, defineConfig } from 'vitest/config';

import manifest from './package.json' with { type: 'json' };

export default defineConfig({
  resolve: { tsconfigPaths: true },
  define: { __TEVU_VERSION__: JSON.stringify(manifest.version) },
  test: {
    exclude: [...configDefaults.exclude, '.stryker-tmp/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__fixtures__/**'],
      reporter: ['text', 'html', 'lcovonly'],
    },
  },
});
