import { defineConfig, devices } from '@playwright/test'

/**
 * Playwright config for Rova web e2e.
 *
 * Assumes the backend API is running on :3000 (docker stack + `nest start api`)
 * and the seed data is loaded. Playwright starts the Vite dev server itself.
 *
 * Run:  pnpm --filter rova-web test:e2e
 */
export default defineConfig({
  testDir: './src/test/e2e',
  testMatch: '**/*.e2e.ts',
  // Phase 2 specs mutate data and each logs in fresh (rotating refresh tokens
  // can't be shared across contexts); run serially for determinism.
  fullyParallel: false,
  workers: 1,
  // One retry in CI, and it stays — a container blip or a cold first paint is not a product
  // defect and should not fail a build. What was wrong is that the retry was SILENT: a spec
  // that failed and passed on the second attempt made the check green, so five genuinely
  // unstable specs sat behind a permanent SUCCESS. The `Flaky tests` step in web-ci.yml now
  // reports every test that only passed on retry.
  //
  // Once those specs are stable, add `--fail-on-flaky-tests` to the CI command to lock it in.
  // It is deliberately NOT on yet: E2E is a required check, so turning it on before the specs
  // are fixed would block every merge.
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  // `list` for humans reading the log; `json` so CI can tell "passed" from "passed on the
  // second try" — the distinction the check was previously unable to make.
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'playwright-results.json' }]]
    : [['list']],
  // Each test logs in fresh (see helpers.login). No shared storageState — the
  // backend rotates + reuse-protects refresh tokens, so a shared session breaks.
  // Requires the API to run with DISABLE_RATE_LIMIT=true so per-test login is OK.
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev --port 5173',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
