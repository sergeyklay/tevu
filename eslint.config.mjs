import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // ESLint does not read .gitignore or .git/info/exclude.
  globalIgnores([
    'dist/**',
    '.claude/**',
    'kb/**',
    '.findings/**',
    '.issues/**',
    '.plans/**',
    '.research/**',
    '.reviews/**',
    '.specs/**',
    '.tasks/**',
  ]),

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ['bun.ts', 'vitest.config.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Output goes through the standard streams injected by src/index.ts.
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-deprecated': 'warn',
    },
  },

  prettierConfig,
]);
