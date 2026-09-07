import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

export default defineConfig({
  plugins: [
    // SWC must come first — emits decorator metadata that NestJS DI relies on
    swc.vite(),
    tsconfigPaths(),
  ],
  resolve: {
    // Prefer TypeScript source over compiled JS so stale build artefacts
    // living alongside .ts files don't shadow the real source.
    extensions: ['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.json'],
  },
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    setupFiles: ['./test/setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_KEY_PREFIX: 'test:',
      // EC P-256 (ES256) test-only placeholder keys — never used for real signing.
      // Must match algorithm: 'ES256' in platform.module.ts.
      JWT_PRIVATE_KEY:
        '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguroUP5ujCG9PaA7F\n+53M+ZEtNeuIunGs3mI6EEuD5qKhRANCAASZgAZjNEMAVYuVFiV1KfKFDRLVoJki\nokvGm4Kv+GReUvPaxoZPolxDcDmmdUfVHKrRxNbN7Kw8/x1o+2BibAO+\n-----END PRIVATE KEY-----',
      JWT_PUBLIC_KEY:
        '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmYAGYzRDAFWLlRYldSnyhQ0S1aCZ\nIqJLxpuCr/hkXlLz2saGT6JcQ3A5pnVH1Ryq0cTWzeysPP8daPtgYmwDvg==\n-----END PUBLIC KEY-----',
      JWT_ACCESS_EXPIRY: '15m',
      JWT_REFRESH_EXPIRY: '30d',
      JWT_ISSUER: 'rally-test',
      JWT_AUDIENCE: 'rally-test-app',
      JWT_REFRESH_TOKEN_MAX_FAMILY_SIZE: '10',
      CSRF_SECRET: 'test-csrf-secret-at-least-32-chars!!',
      COOKIE_SECRET: 'test-cookie-secret-at-least-32-chars!',
      INVITATION_TTL_DAYS: '7',
      LOG_LEVEL: 'error',
      OTEL_ENABLED: 'false',
      OTEL_SERVICE_NAME: 'rally-api-test',
      OTEL_WORKER_SERVICE_NAME: 'rally-worker-test',
      APP_BASE_URL: 'http://localhost:5173',
      // Entra BFF OIDC — test-only placeholders. Never used for real auth.
      ENTRA_TENANT_ID: 'test-tenant',
      ENTRA_CLIENT_ID: 'test-client',
      ENTRA_CLIENT_SECRET: 'test-secret',
      ENTRA_REDIRECT_URI: 'http://localhost:3000/v1/bff/callback',
    },
    // `test/*.spec.ts` (top level only) picks up repo-wide guard specs such as
    // coverage-include.spec.ts. Deliberately NOT `test/**` — that would drag in
    // test/e2e/*.e2e.spec.ts, which need a live Postgres + Valkey and run under
    // test/vitest.e2e.config.ts instead.
    // `test/acceptance/**` is where agent-forge writes a story's acceptance tests, and it needs the
    // recursive glob: `test/*.spec.ts` matches one level only, so an acceptance test would be ignored
    // by `pnpm test` while every gate still passed — the story would merge having never run the test
    // that defines it.
    include: [
      'libs/**/*.spec.ts',
      'apps/**/*.spec.ts',
      'db/**/*.spec.ts',
      'test/*.spec.ts',
      'test/acceptance/**/*.spec.ts',
    ],
    // Bare 'node_modules' only matches a top-level segment, not nested ones —
    // apps/**/*.spec.ts otherwise pulls in package-internal specs like
    // apps/web/node_modules/@tiptap/react/src/*.spec.ts, which need jsdom and
    // fail under this config's environment: 'node'.
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      // `json-summary` writes coverage/coverage-summary.json, which
      // `pnpm check:coverage-floors` reads to enforce the ratchet described below.
      reporter: ['text', 'lcov', 'json-summary'],
      // Coverage ratchet: measure every file that HAS a unit spec — kept in sync
      // by test/coverage-include.spec.ts, which fails when a spec's subject is
      // missing from this list. It previously named four files by hand, one of
      // which (libs/modules/planning/...) had been deleted, so the gate measured
      // three files while 27 had specs.
      include: [
        'db/database-url.ts',
        'libs/shared-kernel/src/health.ts',
        'libs/modules/portfolio/src/domain/portfolio-rollup.ts',
        'libs/modules/portfolio/src/application/portfolio-items.service.ts',
        'libs/modules/portfolio/src/application/preliminary-estimate-map.service.ts',
        'libs/modules/capacity/src/application/capacity-plans.service.ts',
        'libs/modules/capacity/src/domain/capacity-forecast.ts',
        'libs/modules/access/src/application/access.service.ts',
        'libs/modules/access/src/interface/http/policy.guard.ts',
        'libs/modules/api-tokens/src/application/api-tokens.service.ts',
        'libs/modules/api-tokens/src/domain/api-token.ts',
        'libs/modules/activity/src/application/activity-logger.service.ts',
        'libs/modules/activity/src/domain/activity-diff.ts',
        'libs/modules/attachments/src/application/attachments.service.ts',
        'libs/modules/audit/src/interface/http/audit.controller.ts',
        'libs/modules/collaboration/src/application/collaboration.service.ts',
        'libs/modules/identity/src/infrastructure/secrets-manager-secret-resolver.ts',
        'libs/platform/src/config/env.schema.ts',
        'libs/platform/src/email/email-delivery.service.ts',
        'libs/modules/iterations/src/application/iteration-status.service.ts',
        'libs/modules/iterations/src/application/iterations.service.ts',
        'libs/modules/iterations/src/domain/timebox-group.ts',
        'libs/modules/milestones/src/application/milestones.service.ts',
        'libs/modules/notifications/src/interface/http/notification-preferences.controller.ts',
        'libs/modules/projects/src/application/projects.service.ts',
        'libs/modules/quality/src/application/quality.service.ts',
        'libs/modules/releases/src/application/releases.service.ts',
        'libs/modules/reporting/src/application/reporting.service.ts',
        'libs/modules/reporting/src/infrastructure/persistence/team-scope.sql.ts',
        'libs/modules/reporting/src/domain/report-scope.ts',
        'libs/modules/reporting/src/domain/burndown.ts',
        'libs/modules/reporting/src/domain/velocity.ts',
        'libs/modules/reporting/src/domain/team-capacity.ts',
        'libs/modules/reporting/src/domain/release-tracking.ts',
        'libs/modules/scm/src/application/scm-backfill.service.ts',
        'libs/modules/scm/src/application/scm-installation.service.ts',
        'libs/modules/scm/src/infrastructure/github/github-app-auth.service.ts',
        'libs/modules/scm/src/infrastructure/github/github-rest.mapper.ts',
        'libs/modules/team-status/src/application/team-status.service.ts',
        'libs/modules/test-cases/src/application/test-cases.service.ts',
        'libs/modules/work-items/src/application/work-items.service.ts',
        'libs/modules/work-items/src/domain/team-read-scope.ts',
        'libs/modules/workspace/src/application/team.service.ts',
        'libs/modules/workspace/src/application/workspace.service.ts',
        'libs/modules/workspace/src/application/guest-invite-scheduler.service.ts',
        'libs/modules/workspace/src/infrastructure/entra/entra-guest-invite.client.ts',
        // First apps/worker entry. The relay has an ordinary unit spec, and
        // test/coverage-include.spec.ts excludes only test/ and apps/web — so it must be measured.
        // NOTE for whoever comments in this array next: it is parsed by regex, so an apostrophe
        // re-pairs every quote after it and a closing square bracket truncates the whole list.
        // Both fail the ratchet with a diff full of fragments rather than a filename.
        'apps/worker/src/email/bounce-feedback.service.ts',
        'apps/worker/src/identity/entra-guest-invite-relay.service.ts',
        'libs/platform/src/auth/jwt.guard.ts',
        'libs/platform/src/context/request-context.ts',
        'libs/platform/src/http/csrf.ts',
        'libs/modules/access/src/interface/http/route-authz-audit.ts',
        'libs/platform/src/scheduling/exclusive-job.service.ts',
        'libs/platform/src/http/request-timing.ts',
        'libs/platform/src/outbox/abstract-outbox-relay.ts',
        'libs/platform/src/storage/storage.service.ts',
        'libs/platform/src/utils/lexorank.util.ts',
        'libs/shared-kernel/src/permissions.ts',
      ],
      exclude: ['**/*.spec.ts'],
      // Ratchet: raise these incrementally as coverage improves, NEVER lower them.
      // Measured 2026-07-26 across all 27 spec'd files: stmts 71.27, branches
      // 63.98, funcs 67.80, lines 72.21 — floors sat just underneath.
      //
      // RE-MEASURED 2026-08-02: stmts 82.22, branch 76.84, funcs 81.39, lines 82.86. Phase 5 and
      // Phase 6 raised real coverage by ~10 points and nobody moved the floors with it, so a
      // ten-point regression would have passed unnoticed — a ratchet that trails this far behind
      // measures nothing. Floors sit ~1 point under the measurement: close enough to catch a
      // regression, loose enough that one refactor of a well-covered file is not a red build.
      //
      // The stated target (stmts/funcs/lines 80, branches 70) is now MET, so the next move is to
      // hold this line rather than to keep climbing.
      //
      // RE-MEASURED 2026-08-16: stmts 86.11, branch 79.78, funcs 85.12, lines 86.85. The guest-invite
      // work added four well-covered files and the floors again trailed by 4-5 points, which is the
      // same drift the 2026-08-02 note describes — so they move with the measurement rather than
      // being left as a number nobody re-derives. Branches keep a wider margin (79.78 -> 78) because
      // that metric swings most on a single added conditional; the other three sit ~1 point under.
      //
      // RE-MEASURED again the same day, after the invitation email moved behind guest provisioning:
      // stmts 86.06, branch 79.79, funcs 84.84, lines 86.84. All four still clear the floors, so they
      // stay where they are — funcs is the tightest at 0.84 over, which is the margin the note above
      // deliberately leaves for a single added branch.
      //
      // This used to be manual discipline only, and it slipped: the floors sat ~11 points under real
      // coverage for two phases (70/66/62/70 against 82/77/81/83), which would have let a ten-point
      // regression pass unnoticed. `pnpm check:coverage-floors` (ported from opshub's
      // test/check-coverage-floors.ts) now fails CI when any floor sits more than 3 points behind
      // measured coverage, so raising these is enforced rather than remembered.
      // RE-MEASURED 2026-09-07 (Phase 7 Phase A — Test Cases): stmts 86.03, branch 79.56, funcs
      // 84.34, lines 86.94. `test-cases.service.spec.ts` and the drizzle-repository predicates spec
      // added well-covered new files; raised in step with the measurement, per the rule above.
      thresholds: {
        lines: 86,
        functions: 84,
        branches: 79,
        statements: 86,
      },
    },
  },
});
