import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

const sizeBudget = { lines: 300, functionLines: 50, complexity: 10 };

// Files that exceeded sizeBudget when it was introduced, held at their measured maxima. A change that shrinks one lowers its numbers in the same change, and a file leaves the list once it fits sizeBudget.
const oversizedFiles = {
  'src/adapters/agents/opencode/metrics.ts': { functionLines: 97, complexity: 29 },
  'src/adapters/agents/opencode/opencode.ts': { lines: 1133, functionLines: 160, complexity: 22 },
  'src/adapters/agents/opencode/protocol.ts': { lines: 329, functionLines: 75, complexity: 27 },
  'src/adapters/agents/opencode/providers.ts': { lines: 558, functionLines: 88, complexity: 13 },
  'src/adapters/artifact-schemas.ts': { lines: 766 },
  'src/adapters/artifact-store.ts': { lines: 1323, functionLines: 73, complexity: 13 },
  'src/adapters/git.ts': { lines: 1743, functionLines: 173, complexity: 26 },
  'src/adapters/managed-clone.ts': { lines: 656, functionLines: 105, complexity: 16 },
  'src/adapters/process.ts': { lines: 1212, functionLines: 158, complexity: 32 },
  'src/adapters/trackers/github-issues.ts': { lines: 555, functionLines: 83, complexity: 12 },
  'src/adapters/trackers/jira-cloud.ts': { lines: 350, functionLines: 130, complexity: 26 },
  'src/application/assess.ts': { lines: 793, functionLines: 130, complexity: 23 },
  'src/application/create-task.ts': { functionLines: 83, complexity: 14 },
  'src/application/draft-criteria.ts': { lines: 345, functionLines: 109, complexity: 32 },
  'src/application/grade-case.ts': { functionLines: 90, complexity: 19 },
  'src/application/managed-clone.ts': { functionLines: 67, complexity: 14 },
  'src/application/model-access.ts': { functionLines: 83 },
  'src/application/model-call.ts': { functionLines: 127, complexity: 16 },
  'src/application/reference-solution.ts': { lines: 308, functionLines: 70, complexity: 12 },
  'src/application/repository-setup.ts': { functionLines: 69 },
  'src/application/run-benchmark.ts': { lines: 1540, functionLines: 148, complexity: 23 },
  'src/application/validate.ts': { lines: 1016, functionLines: 97, complexity: 18 },
  'src/application/write-conclusions.ts': { functionLines: 71 },
  'src/config/document.ts': { lines: 441, functionLines: 65, complexity: 13 },
  'src/config/load.ts': { lines: 376 },
  'src/config/schema.ts': { lines: 818, functionLines: 114, complexity: 11 },
  'src/domain/github-reference.ts': { complexity: 17 },
  'src/domain/run-records.ts': { lines: 405 },
  'src/evaluation/checks.ts': { functionLines: 53, complexity: 11 },
  'src/evaluation/grading.ts': { functionLines: 51 },
  'src/evaluation/report.ts': { lines: 1346, functionLines: 92, complexity: 23 },
  'src/evaluation/summary.ts': { lines: 792, functionLines: 58, complexity: 19 },
  'src/evaluation/wording.ts': { lines: 794, functionLines: 61, complexity: 17 },
  'src/index.ts': { lines: 625, functionLines: 57 },
  'src/interface/assessment-wizard.ts': { functionLines: 169, complexity: 18 },
  'src/interface/commands/run.ts': { functionLines: 95, complexity: 14 },
  'src/interface/commands/task-add.ts': { functionLines: 83 },
  'src/interface/program.ts': { functionLines: 72 },
  'src/interface/render-error.ts': { functionLines: 74 },
  'src/interface/sectioned-select.ts': { functionLines: 55 },
  'src/interface/task-wizard/base-commit.ts': { functionLines: 62, complexity: 12 },
  'src/interface/task-wizard/bootstrap.ts': { functionLines: 120, complexity: 12 },
  'src/interface/task-wizard/checks.ts': { functionLines: 64, complexity: 14 },
  'src/interface/task-wizard/criteria.ts': { lines: 440, functionLines: 110, complexity: 19 },
  'src/interface/task-wizard/models.ts': { lines: 304, functionLines: 109, complexity: 27 },
  'src/interface/task-wizard/reference-solution.ts': { functionLines: 58 },
  'src/interface/task-wizard/repositories.ts': { functionLines: 93, complexity: 17 },
  'src/interface/task-wizard/review.ts': { functionLines: 94, complexity: 21 },
  'src/interface/task-wizard/source.ts': { functionLines: 60 },
  'src/interface/task-wizard/task-wizard.ts': { functionLines: 106, complexity: 32 },
};

const testSizeBudget = { lines: 1500 };

// Test files that exceeded testSizeBudget when it was introduced, held at their measured counts. A change that shrinks one lowers its count in the same change, and a file leaves the list once it fits testSizeBudget.
const oversizedTestFiles = {
  'src/adapters/agents/opencode/metrics.test.ts': { lines: 3901 },
  'src/adapters/agents/opencode/report.test.ts': { lines: 1838 },
  'src/adapters/isolation.integration.test.ts': { lines: 2912 },
  'src/application/model-call.integration.test.ts': { lines: 1726 },
  'src/application/run-benchmark.test.ts': { lines: 4024 },
  'src/config/config.test.ts': { lines: 4503 },
  'src/evaluation/evaluation.test.ts': { lines: 6633 },
};

function sizeRules({ lines, functionLines, complexity }) {
  const length = { skipBlankLines: true, skipComments: true };
  return {
    ...(complexity && { complexity: ['error', { max: complexity, variant: 'modified' }] }),
    ...(functionLines && {
      'max-lines-per-function': ['error', { max: functionLines, ...length }],
    }),
    ...(lines && { 'max-lines': ['error', { max: lines, ...length }] }),
  };
}

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

  // Limits follow ESLint's defaults for file and function length and McCabe's limit of 10 for complexity.
  // noInlineConfig stops a directive comment from exempting a function or file; raising a limit or adding to oversizedFiles is an AGENTS.md "Ask first" change.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/__fixtures__/**'],
    linterOptions: { noInlineConfig: true },
    rules: sizeRules(sizeBudget),
  },
  ...Object.entries(oversizedFiles).map(([file, limits]) => ({
    files: [file],
    rules: sizeRules(limits),
  })),

  // A describe callback is a function, so the function-length and complexity limits would measure whole suites; test files and fixture modules are limited by file length only. Raising testSizeBudget, adding to oversizedTestFiles, or raising a listed count needs the maintainers' approval first.
  {
    files: ['src/**/*.test.ts', 'src/**/__fixtures__/**/*.ts'],
    // A directive comment must not exempt a test file or fixture module from the limit.
    linterOptions: { noInlineConfig: true },
    rules: sizeRules(testSizeBudget),
  },
  ...Object.entries(oversizedTestFiles).map(([file, limits]) => ({
    files: [file],
    rules: sizeRules(limits),
  })),

  prettierConfig,
]);
