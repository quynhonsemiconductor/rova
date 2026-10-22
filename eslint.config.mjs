import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { loggingLintConfig } from '@quynhonsemiconductor/observability/eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'db/migrations/**', '**/*.js'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // NestJS + RxJS patterns use async callbacks in void-return contexts (tap, setImmediate).
      // Allowing checksVoidReturn: false matches the previous config intent.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      'no-console': 'warn',
    },
  },
  // spec files use vi.fn() mocks that are inherently untyped — relax unsafe rules
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/require-await': 'off',
      // expect(mock.method).toHaveBeenCalled() is the standard Vitest assertion pattern
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  // One log shape, one bootstrap (@quynhonsemiconductor/observability/eslint): no `console` in app code or in db/ scripts (use
  // `createScriptLogger`, or `process.stdout.write` for a human-facing report), and no `NestFactory.create*` outside tests (use
  // `createHttpApp` / `createWorkerApp`). The coverage-floor checker and the flaky-e2e reporter are CI tooling, not app code.
  ...loggingLintConfig({
    consoleAllowedIn: ['test/check-coverage-floors.ts', 'scripts/report-flaky-e2e.mjs'],
  }),
);
