import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  // ESLint does not read .gitignore or .git/info/exclude.
  globalIgnores(['dist/**']),

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
      // A default clause must not count as handling a union member; the explicit false keeps a later typescript-eslint default change from weakening the gate.
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: false },
      ],
    },
  },

  // Each threshold is the measured maximum of production code, so code cannot grow past today's largest function or file; a change that lowers a measured maximum lowers its threshold in the same change.
  // noInlineConfig stops a directive comment from exempting a function or file instead of lowering a threshold; raising a threshold or exempting a file is an AGENTS.md "Ask first" change.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/__fixtures__/**'],
    linterOptions: { noInlineConfig: true },
    rules: {
      complexity: ['error', { max: 32, variant: 'modified' }],
      'max-lines-per-function': ['error', { max: 173, skipBlankLines: true, skipComments: true }],
      'max-lines': ['error', { max: 1743, skipBlankLines: true, skipComments: true }],
    },
  },

  prettierConfig,
]);
