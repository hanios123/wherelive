import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import unusedImports from 'eslint-plugin-unused-imports';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist', 'node_modules', 'coverage']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // Autofixable: `eslint --fix` (the pre-commit hook) deletes unused imports.
      'unused-imports/no-unused-imports': 'error',
      // Same check as `@typescript-eslint/no-unused-vars`, minus imports, which the rule above owns.
      // A leading underscore marks a deliberately unused binding, e.g. `for (const _ of rows) n++`.
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // The generic plumbing uses `any` on purpose (defaults like `Selection<T = any>`, and `(id: any) => SchemaNode`,
      // where `unknown` would break parameter contravariance). Kept visible without failing the build.
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // The benchmarks and the emulator runner are plain Node scripts.
    files: ['bench/**/*.mjs', 'emulator/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['test/**/*.ts', 'test-emulator/**/*.ts'],
    rules: {
      // Fakes and mocks lean on `any`.
      '@typescript-eslint/no-explicit-any': 'off',
      // Schema fixtures spell out the `(id: string) => ...` segment signature even when the body ignores `id`.
      'unused-imports/no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
      // Type tests use a bare expression under `@ts-expect-error`; the expression is the test.
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
);
