import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

// Load .env before the config (and the AppModule it boots) reads process.env —
// Node does not auto-load .env files, and nothing else in the e2e path did
// this, so ConfigModule's Zod validation failed on any machine without these
// vars already exported in the shell (e.g. ENTRA_* — commented out by default
// in .env.example for local dev-login-only setups).
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI injects vars directly */
}

// E2E config: runs tests against a live API + real DB.
// E2E tests live in test/e2e/**/*.e2e.spec.ts.
export default defineConfig({
  plugins: [swc.vite(), tsconfigPaths()],
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.e2e.spec.ts'],
    passWithNoTests: true,
    setupFiles: ['./test/setup.ts'],
    /**
     * ONE database reset for the whole run — truncate the delivery tables, then re-seed the two
     * fixture projects. The suite used to leak ~84 projects per pass with no teardown anywhere,
     * which twice pushed `portfolio_items.rank` into its `varchar(255)` ceiling and stopped the
     * suite dead. `E2E_SKIP_RESET=true` opts out when bisecting one file.
     */
    globalSetup: ['./test/e2e/support/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run spec FILES one at a time. These specs share ONE Postgres and ONE
    // Valkey; by default vitest runs files in parallel workers, so a spec that
    // creates an assignment publishes a notification wake-signal on the shared
    // Valkey channel that fires a DIFFERENT spec's live worker-relay
    // subscription mid-assertion (attempts/status shift under it). It also lets
    // two specs mutate overlapping rows. Both are cross-spec interference, not
    // real product flake — the notification specs pass 11/11 in isolation.
    // Serial execution removes the whole class; tests within a file still run in
    // order. Slower, but a shared stateful backend cannot be driven in parallel
    // safely without per-spec DB/channel isolation, which this suite does not do.
    fileParallelism: false,
    env: {
      // Entra — test-only placeholders, same values as vitest.config.ts.
      // .env intentionally leaves these commented out for local dev-login-only
      // setups (no real SSO configured); the e2e AppModule still needs
      // ConfigModule's Zod schema to validate, so supply harmless placeholders
      // here rather than requiring every local run to configure real Entra.
      //
      // ENTRA_TENANT_ID falls back to 'test-tenant' rather than always
      // overriding it: sso-rbac.e2e.spec.ts asserts against the SSO connection
      // db:migrate/db:seed created using the environment's REAL
      // ENTRA_TENANT_ID (e.g. CI's 'dev-tenant'). An unconditional override
      // here silently made the test process see a different tenant id than
      // what got seeded, so ssoConnectionRepo.findByExternalTenantId always
      // missed and every SSO login failed with SSO_NO_ACCESS — a seed/test
      // mismatch that read exactly like a real product bug.
      ENTRA_TENANT_ID: process.env['ENTRA_TENANT_ID'] ?? 'test-tenant',
      ENTRA_CLIENT_ID: 'test-client',
      ENTRA_CLIENT_SECRET: 'test-secret',
      // identity 8: the passwordless sign-in the suites use (identity itself refuses it unless NODE_ENV is test/development)
      // and the secret that signs its cookies. Test-only values.
      IDENTITY_TEST_LOGIN: 'enabled',
      BETTER_AUTH_SECRET: 'e2e-better-auth-secret-at-least-32-chars!',
      // Override .env's EMAIL_PROVIDER=ses: the email relay e2e coverage
      // exercises the real EmailRelayService/ResilienceService code path, but
      // must not depend on SES/LocalStack actually being reachable — the
      // 'dev' provider logs instead of sending, keeping the suite hermetic.
      EMAIL_PROVIDER: 'dev',
    },
  },
});
