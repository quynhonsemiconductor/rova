import { z } from 'zod';

/** An empty string counts as unset (a variable blanked in a task definition or `.env`). */
const emptyToUndefined = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), schema);

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .default(String(defaultValue))
    .transform((v) => v === 'true');

/**
 * A documented placeholder such as `<ROVA_PROD_SERVICE_APP_ID>`: a value a release template leaves for the owner to replace. It is
 * refused for the Graph mail settings so that an unreplaced template fails closed at start-up instead of reaching Entra.
 */
export const PLACEHOLDER_VALUE = /^<[^<>\s]+>$/;

/**
 * Validated environment schema.
 * Process refuses to start if any required variable is missing or malformed.
 */
export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    CORS_ORIGINS: z.string().default('http://localhost:5173'),
    /** Set to 'true' in local dev / CI to bypass all rate limiting. Never set in production. */
    DISABLE_RATE_LIMIT: booleanish(false),

    // ── Database ───────────────────────────────────────────────────────────────
    // Supply EITHER a complete DATABASE_URL (local dev, CI) OR the discrete parts
    // (deployed). See db/database-url.ts for why the deployed path composes from
    // parts rather than storing a URL: the password belongs to the RDS-managed
    // secret that AWS rotates, and any copy of it goes stale silently.
    /**
     * REMOVED: `DATABASE_AUTH=iam` (RDS IAM authentication). The on-prem estate runs CloudNativePG with ordinary
     * role passwords, so the mode had no consumer and was deleted along with `db/pg-iam.ts`. Accepted here only as
     * unset or `password` (a no-op); `iam` is a boot error that says so, instead of being ignored: a deployment
     * that still sets it would otherwise start in password mode and fail on its first query.
     */
    DATABASE_AUTH: z
      .string()
      .optional()
      .refine(
        (v) => v === undefined || v.trim() === '' || v.trim().toLowerCase() === 'password',
        'DATABASE_AUTH=iam is no longer supported (RDS IAM authentication was removed). Unset it and supply DATABASE_URL, or DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER and DATABASE_PASSWORD.',
      ),
    DATABASE_URL: z.string().url().optional(),
    DATABASE_HOST: z.string().optional(),
    DATABASE_PORT: z.coerce.number().int().positive().optional(),
    DATABASE_NAME: z.string().optional(),
    DATABASE_USER: z.string().optional(),
    DATABASE_PASSWORD: z.string().optional(),
    DATABASE_SSLMODE: z.string().default('require'),
    // Path to the CA bundle database certificates must chain to (RDS global bundle in the
    // image today, the CNPG ca.crt on-prem). REQUIRED in production: without it the
    // process refuses to connect (see db/pg-ssl.ts) instead of encrypting unverified.
    DATABASE_SSL_CA: emptyToUndefined(z.string().optional()),

    DATABASE_POOL_MIN: z.coerce.number().int().positive().default(2),
    DATABASE_POOL_MAX: z.coerce.number().int().positive().default(20),
    DATABASE_MIGRATION_URL: z.string().url().optional(),

    // Redis / Valkey
    //
    // REQUIRED, with no default, and that is the whole point. It used to default to
    // `redis://localhost:6379`, which is harmless locally and dangerous everywhere
    // else: a deployed task whose REDIS_URL injection went missing did not fail to
    // boot — it silently connected to nothing on its own loopback.
    //
    // That is not a degraded cache. Sessions live ONLY in Valkey, so every browser
    // session breaks; and the token denylist and the rate limiter both FAIL OPEN when
    // it is unreachable, so a revoked token keeps working and rate limiting stops. The
    // task meanwhile answers `/v1/healthz` with 200, because that probe deliberately
    // touches no dependency, so the ALB keeps it registered and nothing reports it.
    //
    // `JWT_PRIVATE_KEY` has no default for the same reason: absent config should fail
    // the deploy and roll back, not silently downgrade the service. A localhost
    // fallback is a local-development convenience, so it belongs in `.env`, where
    // `.env.example` already sets it — not in the schema every deployed task shares.
    REDIS_URL: z
      .string()
      .url('REDIS_URL must be a URL — rediss:// against the deployed cache, redis:// locally')
      .min(1, 'REDIS_URL is required: there is deliberately no localhost fallback'),
    REDIS_KEY_PREFIX: z.string().default('rova:'),

    // ── Auth: identity 8 (Better Auth, the `staff` preset, Microsoft Entra) ──────────────────────────────────────────
    // Sessions are database rows behind an HttpOnly cookie: there is no JWT, no refresh token and no key pair.
    /**
     * Signs identity's cookies and encrypts what it stores (identity README, "Environment"): 32+ characters, its own
     * secret (not COOKIE_SECRET, not CSRF_SECRET). Rotating it signs everyone out. API ONLY: the worker never signs
     * anyone in and is not given it; identity refuses to start the API without it.
     */
    BETTER_AUTH_SECRET: emptyToUndefined(z.string().min(32).optional()),
    /**
     * `IDENTITY_TEST_LOGIN=enabled` loads identity's passwordless `/api/auth/test-login` for the end-to-end suites.
     * Identity itself refuses it unless NODE_ENV is `test` or `development`; this schema ALSO refuses it in production.
     */
    IDENTITY_TEST_LOGIN: emptyToUndefined(z.enum(['enabled']).optional()),

    // Cookie signing. Distinct from CSRF_SECRET on purpose: this one signs every
    // cookie rova sets, so rotating it invalidates all of them. Sharing one value
    // between the two made a cookie-hygiene rotation read as a CSRF change (and
    // vice versa) in the audit trail.
    COOKIE_SECRET: z.string().min(32),

    // CSRF — HMAC key binding a token to the session that requested it, so a
    // token lifted from one session cannot be replayed in another.
    CSRF_SECRET: z.string().min(32),

    /**
     * Serve the OpenAPI document + Swagger UI at /api/docs. Defaults to OFF and
     * must be turned on explicitly: this used to be derived from
     * `NODE_ENV !== 'production'`, so any future environment that isn't literally
     * "production" (staging, preview, a mis-set task definition) would have
     * published the endpoint inventory without anyone choosing to.
     */
    SWAGGER_ENABLED: booleanish(false),

    /**
     * The MCP endpoint (`/mcp`). Defaults OFF everywhere and must be turned on explicitly. The
     * route is raw (outside `/v1`, the session guards and Swagger), verifies the Cloudflare
     * Access JWT per request, and composes the product's own REST routes in-process with the
     * person as principal. Until the app-platform `identity/access-jwt` verifier is wired in,
     * an enabled endpoint answers every call 503.
     */
    MCP_ENABLED: booleanish(false),

    /**
     * Whether `/mcp` exposes WRITE tools (create/update/delete) at all. Default OFF in every
     * environment: a host that turns MCP_ENABLED on still gets the read-only catalogue until this
     * is set. It is enforced TWICE — register.ts mounts no write tool while it is false, and the
     * global McpWriteGuard refuses any MCP-bridged non-GET request whose route is not on the
     * write allowlist — so a bug in a tool cannot reach a route the list does not name. Rollout:
     * dev first, prod only on the owner's go.
     */
    MCP_WRITES_ENABLED: booleanish(false),

    // The MCP Access application's origin settings (MCP-PLAN §5). Required only when MCP_ENABLED
    // is true (asserted at boot); test fixtures only until the owner sets the real values.
    // `iss` of the Access JWT must equal this origin. DEPLOYMENT REQUIREMENT: the /mcp Access
    // application must allow ONLY the Entra IdP — no One-time PIN, no social IdPs — because the
    // adapter maps by email and guests (unverified addresses) are refused.
    MCP_CF_TEAM_DOMAIN: z
      .string()
      .regex(/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/)
      .optional(),
    // The AUD tag of the "/mcp" Access application. A token minted for another app is rejected.
    MCP_ACCESS_AUD: z.string().min(1).optional(),

    // SCM webhooks (GitHub/GHE) — HMAC shared secret for X-Hub-Signature-256.
    // Optional so the app boots without SCM configured; the webhook endpoint
    // returns 503 until it is set (prod should source it from Secrets Manager).
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    // SCM Phase 2 — GitHub App (backfill + authenticated REST). All optional so
    // the app boots without them; backfill no-ops until configured.
    GITHUB_APP_ID: z.string().optional(),
    // App private key (PEM), injected from the secret store as an env var.
    GITHUB_APP_PRIVATE_KEY: z.string().optional(),
    // REST API base — github.com is https://api.github.com; a GHE host would be
    // https://<host>/api/v3. Defaults to github.com.
    GITHUB_API_BASE_URL: z.string().url().default('https://api.github.com'),

    /** PRIVATE bucket — every permission-gated upload. Served only via presigned GET. */
    S3_ATTACHMENTS_BUCKET: z.string().default('rova-attachments'),

    /**
     * PUBLIC bucket — non-sensitive assets only (avatars, workspace logos). World-
     * readable by key. Optional: when unset, any attempt to store a public asset
     * throws rather than silently falling back to the private bucket.
     */
    S3_PUBLIC_ASSETS_BUCKET: z.string().optional(),

    /**
     * CDN origin for the PUBLIC bucket. MUST NOT point at the private bucket —
     * doing so makes every attachment readable by key, bypassing authorization
     * entirely. StorageService.cdnUrl() has no private-bucket path for this reason.
     */
    CDN_PUBLIC_ASSETS_BASE_URL: z.string().url().optional(),

    // Object storage: an S3-compatible backend (Cloudflare R2, Garage locally). StorageService refuses to
    // start without STORAGE_ENDPOINT (no plain-AWS mode). R2 requires STORAGE_ENDPOINT + STORAGE_ACCESS_KEY_ID + STORAGE_SECRET_ACCESS_KEY
    // + STORAGE_FORCE_PATH_STYLE=true. Bucket names stay S3_ATTACHMENTS_BUCKET /
    // S3_PUBLIC_ASSETS_BUCKET; both buckets share the one endpoint.
    STORAGE_ENDPOINT: z.string().url().optional(),
    STORAGE_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_SECRET_ACCESS_KEY: z.string().optional(),

    /**
     * OPTIONAL credentials scoped to the PUBLIC bucket only.
     *
     * When set, StorageService builds a second S3 client for public-asset operations,
     * so the credential that can write world-readable avatars and logos is NOT the
     * credential that can read every permission-gated attachment. One leaked token
     * then costs one bucket instead of both.
     *
     * When unset, public operations reuse STORAGE_ACCESS_KEY_ID/SECRET — identical to
     * the previous behaviour, so this can be adopted without a flag day: set these,
     * deploy, then re-mint the primary token scoped to attachments alone.
     *
     * Both must be set together; one alone is a configuration error and is rejected
     * below rather than silently ignored.
     */
    STORAGE_PUBLIC_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_PUBLIC_SECRET_ACCESS_KEY: z.string().optional(),
    STORAGE_FORCE_PATH_STYLE: booleanish(false),

    // ── Email ──────────────────────────────────────────────────────────────────
    /**
     * Which email transport to use. Defaults to 'dev' (logs to stdout).
     * 'graph' sends through Microsoft 365 (Graph sendMail) from the environment's shared mailbox: needs MAIL_GRAPH_SENDER and
     * MAIL_GRAPH_CLIENT_ID (the "Rova <Dev|Prod> Service" app, NOT the sign-in app), and in the WORKER the file at
     * AZURE_CLIENT_CERTIFICATE_PATH (the ONE Graph credential mechanism, ONPREM-PLAN §7.3).
     * See docs/runbooks/mail-graph.md.
     */
    EMAIL_PROVIDER: z.enum(['graph', 'smtp', 'dev']).default('dev'),
    /**
     * 'smtp' sends through a plain SMTP relay: Mailpit in development (`MAIL_SMTP_HOST`/`MAIL_SMTP_PORT`, sender `MAIL_FROM_EMAIL`).
     * Development only: refused when NODE_ENV=production here and by platform-mail's smtp-guard.
     */

    /**
     * The shared mailbox mail goes out as (`noreply-rova@qnsc.vn`). Required for 'graph'; not a secret. Graph sends as this mailbox and no
     * other (the Exchange role assignment is scoped to it); the display name is the mailbox's own, so no From name is configured.
     */
    MAIL_GRAPH_SENDER: emptyToUndefined(z.string().email().optional()),
    /**
     * The "Rova <Dev|Prod> Service" Entra app: certificate only, worker only, no client secret. NOT `ENTRA_CLIENT_ID`, the sign-in app (delegated,
     * client secret, API): a compromised API process must not hold a credential that can send mail. The Exchange RBAC role "Application
     * Mail.Send" is assigned to THIS app, scoped to this environment's mailbox. A public identifier.
     */
    MAIL_GRAPH_CLIENT_ID: emptyToUndefined(z.string().uuid().optional()),
    /**
     * Credential for the 'graph' provider: PATH of the worker-only file holding the Service app's ONE PEM (private key first, then the
     * certificate, `cat mail.key mail.crt`), synced from the standalone secret `rova-<env>-graph-cert` and mounted INTO THE WORKER only
     * (the API never sends; the API task is never given the file). platform-mail reads it under its standard name
     * AZURE_CLIENT_CERTIFICATE_PATH (ONPREM-PLAN §7.3) — a path, never a PEM env value.
     */
    AZURE_CLIENT_CERTIFICATE_PATH: emptyToUndefined(z.string().min(1).optional()),
    /**
     * Credential for the 'graph' provider, k3s (later): the projected ServiceAccount token a federated credential on the app exchanges. Wins over
     * the certificate, so the move is: mount the token, set this, delete the certificate.
     */
    MAIL_GRAPH_FEDERATED_TOKEN_FILE: emptyToUndefined(z.string().min(1).optional()),
    /** SMTP relay host for EMAIL_PROVIDER=smtp: Mailpit's compose service name in a container, `localhost` on the host. */
    MAIL_SMTP_HOST: emptyToUndefined(z.string().min(1).optional()),
    /** SMTP relay port for EMAIL_PROVIDER=smtp: Mailpit's SMTP port (1025 in the container). */
    MAIL_SMTP_PORT: emptyToUndefined(z.coerce.number().int().min(1).max(65535).optional()),
    /** Display name that appears in the From header, e.g. "Mini Rova". */
    MAIL_FROM_NAME: z.string().default('Mini Rova'),
    /** Verified sender address for the smtp relay (graph sends as the mailbox, so it does not need it). */
    MAIL_FROM_EMAIL: z.string().email().optional(),

    /** Reply-To address shown in email clients. Defaults to a no-reply alias. */
    MAIL_REPLY_TO: z.string().email().optional(),
    /** Public base URL used to build password-reset and invitation links (e.g. https://app.rova.io). */
    APP_BASE_URL: z.string().url().default('http://localhost:5173'),

    // Observability
    OTEL_ENABLED: booleanish(false),
    OTEL_SERVICE_NAME: z.string().default('rova-api'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default('http://localhost:4318'),
    /** 0.0–1.0 fraction of root spans to sample. Defaults: 1.0 dev, 0.1 prod. */
    OTEL_SAMPLING_PROBABILITY: z.coerce.number().min(0).max(1).optional(),
    /** The release (image tag), injected into the OTEL resource, Pino logs and the MCP server version. */
    SERVICE_VERSION: z.string().default('dev'),
    /**
     * Deployment identity for telemetry (`deployment.environment.name`) — NOT the
     * same thing as `NODE_ENV`.
     *
     * `NODE_ENV` is a runtime mode, and DEVELOP deliberately runs it as
     * `production` so `/v1/bff/dev-login` stays disabled on a public host (see the
     * env-flag notes in CLAUDE.md). Deriving deployment identity from it labelled
     * every develop span, metric and log as `production` — indistinguishable from
     * real production — and silently applied the production sampling ratio there.
     *
     * The deployment sets this to `dev` / `prod` (on-prem) or `develop` / `production` (AWS era);
     * observability treats `prod` and `production` alike. Left unset, `@quynhonsemiconductor/observability`
     * falls back to `NODE_ENV`, which is why this is optional rather than required.
     */
    DEPLOYMENT_ENV: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    LOG_PRETTY: booleanish(false),
    LOG_SQL: booleanish(false),
    LOG_HTTP_BODIES: booleanish(false),
    LOG_DEV_EMAIL_CONTENT: booleanish(false),

    // Resilience
    RESILIENCE_ENABLED: booleanish(true),

    // TTL knobs — defaults match SRS but allow ops to tune without code change
    INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(7),
    SESSION_CLEANUP_OLDER_THAN_DAYS: z.coerce.number().int().positive().default(7),

    // SSO — Microsoft Entra ID. The sign-in app registration (a confidential client, single-tenant). The API signs
    // people in with it (`ENTRA_CLIENT_SECRET` in the code exchange); the worker reuses the same registration for the
    // Graph guest-invite call until that moves to the certificate-only Service app. Mandatory in every environment.
    ENTRA_TENANT_ID: z.string().min(1),
    ENTRA_CLIENT_ID: z.string().min(1),
    ENTRA_CLIENT_SECRET: z.string().min(1),
    /**
     * Provision an invited external collaborator as a Microsoft Entra B2B GUEST.
     *
     * When true, `WorkspaceService.inviteMember` writes a `messaging.guest_invite_outbox` row in
     * the invite transaction and the worker relay calls
     * `POST https://graph.microsoft.com/v1.0/invitations` app-only, on the "Rova <Env> Service"
     * app's certificate (`MAIL_GRAPH_CLIENT_ID` + the worker-only file
     * `AZURE_CLIENT_CERTIFICATE_PATH`) — no client secret anywhere (ONPREM-PLAN §7.3).
     *
     * DEFAULT FALSE, and load-bearing. The registration needs the `User.Invite.All` APPLICATION
     * permission with admin consent before any of it can work; without it every Graph call is a
     * 403, and an invitation must not break because a directory grant has not landed yet. Off, no
     * outbox row is written and `inviteMember` behaves exactly as it did before.
     *
     * `booleanish`, not `z.coerce.boolean()` — the latter turns the string "false" into `true`.
     */
    ENTRA_GUEST_INVITE_ENABLED: booleanish(false),
    /**
     * Comma-separated list of email domains that are INTERNAL to this deployment's
     * identity tenant (e.g. `qnsc.vn`). An invited address on one of these domains is
     * a directory member already — they sign in with the workspace SSO connection —
     * so `inviteMember` skips the Entra B2B GUEST provisioning queue for them: the
     * guest relay would only answer the same-tenant collision as "nothing to do",
     * and making the invitation email wait on that no-op buys nothing. The invitation
     * itself is unchanged — it is still the authorization grant, and it still emails;
     * internal domains additionally get the copy-link path, which does not depend on
     * mail deliverability at all. Empty (default) disables the distinction and every
     * address is treated as it was before this existed.
     */
    INTERNAL_EMAIL_DOMAINS: z.string().default(''),
    /**
     * Staff email domains (comma-separated, exact; `*.x.y` opts into sub-domains): identity's `staff` preset refuses a
     * Microsoft sign-in whose address is outside them. Also read by the migrator's tenant bootstrap.
     */
    SSO_ALLOWED_EMAIL_DOMAINS: z.string().default('qnsc.vn'),
    /**
     * Whether a staff-domain address may create its own account at first sign-in (`true`) or only when it already has
     * a profile or a live invitation (`false`: invite-only, how every deployed environment runs). B2B guests are always
     * invite-only. Also read by the migrator's tenant bootstrap.
     *
     * DEFAULT false (changed 2026-11-01, pre-prod security review): the safe value must be the one an environment gets
     * by omission. Every deployed environment already sets it explicitly; a new one that forgets the key is now
     * invite-only rather than open to any address the tenant vouches for in `qnsc.vn`.
     */
    SSO_JIT_ENABLED: booleanish(false),
    /**
     * Comma-separated SSO (Entra) emails auto-granted workspace_admin on first login.
     * Example: "alice@example.test,bob@example.test"
     */
    PLATFORM_ADMIN_EMAILS: z.string().default(''),
    // No schema-level requirement here ON PURPOSE: the worker shares this schema and
    // never sees the roster (the bundle key is injected into the API only), and it must
    // boot without it. The API asserts its own copy at boot — apps/api/bootstrap.
  })
  .superRefine((env, ctx) => {
    /**
     * Database credentials must arrive by exactly one of the two routes. Checked here so a
     * misconfigured task dies at boot with a precise message, rather than surviving startup and
     * failing on the first query — which is how the stale db-url secret presented: a healthy-looking
     * deploy, then 28P01.
     *
     * `DATABASE_URL` short-circuits THIS check only. It used to `return` out of the whole
     * `superRefine`, which silently disabled every rule written after it — the storage-credential
     * pairing below never ran for any deploy that used a database URL, which is every deploy we
     * have. A refinement block that grows more rules cannot early-return.
     */
    const credentialKeys = [
      'DATABASE_HOST',
      'DATABASE_PORT',
      'DATABASE_NAME',
      'DATABASE_USER',
      'DATABASE_PASSWORD',
    ] as const;

    const missing = env.DATABASE_URL ? [] : credentialKeys.filter((k) => !env[k]);

    // Half a credential pair is a misconfiguration, not a partial feature: an id
    // without a secret silently falls back to the private-bucket credential, which is
    // the separation this pair exists to create.
    const pubId = Boolean(env.STORAGE_PUBLIC_ACCESS_KEY_ID);
    const pubSecret = Boolean(env.STORAGE_PUBLIC_SECRET_ACCESS_KEY);
    if (pubId !== pubSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [pubId ? 'STORAGE_PUBLIC_SECRET_ACCESS_KEY' : 'STORAGE_PUBLIC_ACCESS_KEY_ID'],
        message:
          'STORAGE_PUBLIC_ACCESS_KEY_ID and STORAGE_PUBLIC_SECRET_ACCESS_KEY must be set ' +
          'together, or both left unset to reuse the primary storage credential.',
      });
    }

    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message:
          `Database not configured. Set DATABASE_URL, or all of DATABASE_HOST, DATABASE_PORT, ` +
          `DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD. Missing: ${missing.join(', ')}.`,
      });
    }

    /**
     * A real email provider needs a SENDER, and the absence of one is silent otherwise. Graph
     * sends as the configured mailbox, so the mailbox is required: without it every message would
     * be refused and the task would still report healthy. Failing at boot is the rule this repo
     * follows for the database credentials above.
     */
    if (env.EMAIL_PROVIDER === 'graph' && !env.MAIL_GRAPH_SENDER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_GRAPH_SENDER'],
        message:
          'MAIL_GRAPH_SENDER is required when EMAIL_PROVIDER is "graph": it is the shared mailbox Graph sends as ' +
          '(noreply-rova@qnsc.vn in production, noreply-rova-dev@qnsc.vn in develop), and the Exchange role ' +
          'assignment names exactly that mailbox.',
      });
    }
    if (env.EMAIL_PROVIDER === 'graph' && !env.MAIL_GRAPH_CLIENT_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_GRAPH_CLIENT_ID'],
        message:
          'MAIL_GRAPH_CLIENT_ID is required when EMAIL_PROVIDER is "graph": the "Rova <Dev|Prod> Service" app that holds the ' +
          'Exchange "Application Mail.Send" role for the mailbox (not the sign-in app, ENTRA_CLIENT_ID).',
      });
    }
    if (env.EMAIL_PROVIDER === 'smtp' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message:
          'EMAIL_PROVIDER=smtp is for development only (Mailpit): an unauthenticated relay must never send in production. ' +
          'Use graph in production.',
      });
    }
    if (env.EMAIL_PROVIDER === 'smtp' && (!env.MAIL_SMTP_HOST || !env.MAIL_SMTP_PORT)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAIL_SMTP_HOST'],
        message:
          'MAIL_SMTP_HOST and MAIL_SMTP_PORT are required when EMAIL_PROVIDER is "smtp" (Mailpit: localhost and 1120 on the host, mailpit and 1025 in a container).',
      });
    }
    if (env.EMAIL_PROVIDER === 'graph') {
      for (const key of ['ENTRA_TENANT_ID', 'MAIL_GRAPH_SENDER', 'MAIL_GRAPH_CLIENT_ID'] as const) {
        const value = env[key];
        if (value !== undefined && PLACEHOLDER_VALUE.test(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message:
              `${key} is still the placeholder "${value}" from the release template: replace it with the real value ` +
              'before EMAIL_PROVIDER=graph can start.',
          });
        }
      }
    }
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== 'production') return;
    if (env.IDENTITY_TEST_LOGIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['IDENTITY_TEST_LOGIN'],
        message:
          'IDENTITY_TEST_LOGIN cannot be set when NODE_ENV=production: it is a passwordless sign-in for end-to-end suites only.',
      });
    }
    if (!env.APP_BASE_URL.startsWith('https://')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_BASE_URL'],
        message:
          'APP_BASE_URL must be https when NODE_ENV=production: it is the origin Entra redirects the browser to (/api/auth/callback/microsoft) and the origin of the session cookie.',
      });
    }
    // Pre-prod security review (2026-11-01): switches that are useful locally and are a hole in production.
    // Refused rather than warned, because each one is a single environment variable away from shipping and
    // none of them has a legitimate production use here.
    for (const key of [
      'DISABLE_RATE_LIMIT',
      'SWAGGER_ENABLED',
      'LOG_HTTP_BODIES',
      'LOG_DEV_EMAIL_CONTENT',
    ] as const) {
      if (env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} cannot be true when NODE_ENV=production: it exists for local work and is a hole on a public host.`,
        });
      }
    }
    if (env.EMAIL_PROVIDER === 'dev') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_PROVIDER'],
        message:
          'EMAIL_PROVIDER=dev cannot be set when NODE_ENV=production: it logs messages instead of sending them, so every invitation would be marked sent and lost.',
      });
    }
    // `CORS_ORIGINS` defaults to the dev server. A production task that keeps it (or a copied tfvars) would
    // let a page on the operator's own machine read the API with a session cookie attached.
    const localOrigins = env.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => {
        try {
          const host = new URL(origin).hostname;
          return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
        } catch {
          return false;
        }
      });
    if (localOrigins.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message:
          `CORS_ORIGINS must not contain a localhost origin when NODE_ENV=production (found ${localOrigins.join(', ')}): ` +
          "it would let a page on the operator's machine read the API with the reader's cookie.",
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;
