/**
 * identity schema — users, auth_sessions
 * Canonical DDL: 05_Architecture/DATABASE_SCHEMA.md §9
 */
import {
  pgSchema,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  userStatusEnum,
  ssoProviderEnum,
  ssoConnectionStatusEnum,
  ssoConnectionKindEnum,
} from './enums';

export const identitySchema = pgSchema('identity');

// ── users ─────────────────────────────────────────────────────────────────

export const users = identitySchema.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 255 }).notNull(),
    avatarUrl: varchar('avatar_url', { length: 2048 }),
    status: userStatusEnum('status').notNull().default('active'),
    emailVerified: boolean('email_verified').notNull().default(false),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaSecret: text('mfa_secret'),
    locale: varchar('locale', { length: 10 }).notNull().default('en'),
    timezone: varchar('timezone', { length: 64 }).notNull().default('UTC'),
    phone: varchar('phone', { length: 32 }),
    sessionVersion: integer('session_version').notNull().default(1),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    emailIdx: uniqueIndex('uq_users_email')
      .on(t.email)
      .where(sql`deleted_at IS NULL`),
  }),
);

// ── auth_sessions ─────────────────────────────────────────────────────────

export const authSessions = identitySchema.table(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(), // active workspace for this session
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    deviceInfo: jsonb('device_info'),
    ipAddress: varchar('ip_address', { length: 45 }),
    isRevoked: boolean('is_revoked').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set for SSO sessions — used to re-derive authMethod on token refresh. */
    ssoProvider: ssoProviderEnum('sso_provider'),
    /** Double-submit cookie CSRF protection — set for all sessions created after migration. */
    csrfToken: varchar('csrf_token', { length: 64 }),
  },
  (t) => ({
    workspaceIdx: index('ix_auth_sessions_workspace').on(t.workspaceId),
    tokenHashIdx: uniqueIndex('uq_auth_sessions_token_hash').on(t.tokenHash),
    userIdx: index('ix_auth_sessions_user').on(t.userId),
    familyIdx: index('ix_auth_sessions_family').on(t.familyId),
    // Partial index — most lookups only need active sessions; halves index size
    activeUserIdx: index('ix_auth_sessions_active_user')
      .on(t.userId)
      .where(sql`is_revoked = false`),
  }),
);

import { sql } from 'drizzle-orm';

// ── sso_identities ───────────────────────────────────────────────────────────
// Links an external SSO identity (e.g. Microsoft Entra) to a rova user.
// One user may have at most one identity per provider.

// ── api_tokens ────────────────────────────────────────────────────────────
//
// Long-lived credentials for MACHINE clients (CI, scripts, the agent platform).
// Real Rally's equivalent is the API Key a user mints in My Settings; this follows
// that shape with the three things that model lacks and every current product has
// converged on — mandatory expiry, an optional scope narrowing, and an audit trail.
//
// The token itself is never stored. `token_hash` is `sha256(plaintext)`, NOT a slow
// KDF: the value is 32 bytes of CSPRNG output, so there is nothing to brute-force
// that a work factor would slow, and this hash is computed on EVERY authenticated
// request. `prefix` is the first 12 characters (`rly_` + 8), stored so the UI, the
// audit rows and a leaked-secret search can identify a token without holding it.
//
// `scopes` NARROWS, it never grants. Effective permissions are the principal's
// database assignments INTERSECTED with this array — an empty/absent array means "no
// narrowing", and a token can therefore never exceed the user behind it. This is why
// it does not contradict "permissions are NEVER in the token": authorization still
// resolves from the database on every request (see PolicyGuard), and the token only
// subtracts.
export const apiTokens = identitySchema.table(
  'api_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id').notNull(),
    /** Human label, shown in the token list. Not unique — people reuse names. */
    name: varchar('name', { length: 100 }).notNull(),
    /** `rly_` + first 8 chars of the secret. Identifies a token without holding it. */
    prefix: varchar('prefix', { length: 16 }).notNull(),
    tokenHash: text('token_hash').notNull(),
    /** Narrowing only; NULL means "inherit the user's permissions unchanged". */
    scopes: text('scopes').array(),
    /** Mandatory, unlike Rally's never-expiring keys. Capped in the service. */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /**
     * Touched on use, throttled to once a minute in the repository: a write on every
     * request would turn a read path into a write path for no operational gain.
     */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Lookup is by prefix, then a constant-time hash comparison. Unique so a prefix
    // collision cannot make authentication ambiguous.
    prefixIdx: uniqueIndex('uq_api_tokens_prefix').on(t.prefix),
    tokenHashIdx: uniqueIndex('uq_api_tokens_token_hash').on(t.tokenHash),
    userIdx: index('ix_api_tokens_user').on(t.userId),
    workspaceIdx: index('ix_api_tokens_workspace').on(t.workspaceId),
  }),
);

export const ssoIdentities = identitySchema.table(
  'sso_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull(),
    /** Provider identifier — currently only 'entra' (Microsoft Entra ID). */
    provider: ssoProviderEnum('provider').notNull(),
    /** Stable subject ID from the provider (Entra: `oid` claim). */
    providerSub: varchar('provider_sub', { length: 255 }).notNull(),
    /** Email address from the provider token at the time of linking. */
    providerEmail: varchar('provider_email', { length: 320 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // A single Entra OID maps to exactly one rova user globally
    providerSubIdx: uniqueIndex('uq_sso_identities_provider_sub').on(t.provider, t.providerSub),
    userIdx: index('ix_sso_identities_user').on(t.userId),
  }),
);

// ── sso_connections ──────────────────────────────────────────────────────────
// Maps an external identity provider (identified by its directory/tenant id or
// issuer) to this install. SSO is install-global — one identity provider for the
// whole install — so a connection is not bound to a workspace for routing.
//
// During SSO login the Entra `tid` claim is matched against `external_tenant_id`
// to validate the connection. A default workspace, domain allow-list and a JIT
// toggle give admins control over auto-provisioning.

export const ssoConnections = identitySchema.table(
  'sso_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Default workspace JIT-provisioned users join. */
    workspaceId: uuid('workspace_id').notNull(),
    /** Federation protocol/provider. */
    provider: ssoProviderEnum('provider').notNull().default('entra'),
    /** IdP directory id — Entra `tid` claim (the primary match key). */
    externalTenantId: varchar('external_tenant_id', { length: 255 }).notNull(),
    /** Full token issuer URL — optional secondary match key (SAML/OIDC). */
    issuer: varchar('issuer', { length: 512 }),
    // ── Multi-IdP OIDC broker fields (nullable for legacy rows; a row is only
    // broker-usable once fully configured — see isBrokerConfigured). ───────────
    /** Routing model: `directory` (owns its domains) vs `shared` (consumer IdP, invite-gated). */
    kind: ssoConnectionKindEnum('kind').notNull().default('directory'),
    /** OIDC issuer base for mandatory `.well-known` discovery. */
    authorityUrl: varchar('authority_url', { length: 512 }),
    /** Optional JWKS override; otherwise taken from discovery. */
    jwksUri: varchar('jwks_uri', { length: 512 }),
    /** Extra accepted issuers (e.g. Entra v1 + v2). Empty ⇒ [discovery issuer]. */
    acceptedIssuers: jsonb('accepted_issuers').$type<string[]>().notNull().default([]),
    /** OAuth scopes. */
    scopes: varchar('scopes', { length: 255 }).notNull().default('openid profile email'),
    /** Public IdP client id (also the expected token audience). */
    clientId: varchar('client_id', { length: 255 }),
    /** Reference (Secrets Manager name/ARN) to the client secret — never the secret itself. */
    clientSecretRef: varchar('client_secret_ref', { length: 512 }),
    /** Human label for the login button + logs/audit. */
    displayName: varchar('display_name', { length: 255 }),
    /** System-role slug assigned to JIT-provisioned users (e.g. 'project_member'). */
    defaultRoleSlug: varchar('default_role_slug', { length: 64 })
      .notNull()
      .default('project_member'),
    /** Email domains permitted to provision via this connection. Empty = any. */
    allowedEmailDomains: jsonb('allowed_email_domains').$type<string[]>().notNull().default([]),
    /** When false, new users are NOT auto-created — they must be invited first. */
    jitEnabled: boolean('jit_enabled').notNull().default(true),
    status: ssoConnectionStatusEnum('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One IdP directory maps to exactly one connection per provider (install-global).
    providerExternalIdx: uniqueIndex('uq_sso_connections_provider_external').on(
      t.provider,
      t.externalTenantId,
    ),
  }),
);

/**
 * Owned email domains for `directory` connections — source of truth for
 * email-first routing AND the provisioning domain gate. `UNIQUE(domain)`
 * guarantees a domain maps to at most one connection (no ambiguous routing).
 * `shared` (consumer-IdP) connections have no rows here — they are invite-gated.
 */
export const ssoConnectionDomains = identitySchema.table(
  'sso_connection_domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => ssoConnections.id, { onDelete: 'cascade' }),
    /** Lower-cased email domain (e.g. "vendor.com"). */
    domain: varchar('domain', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    domainIdx: uniqueIndex('uq_sso_connection_domains_domain').on(t.domain),
    connectionIdx: index('ix_sso_connection_domains_connection').on(t.connectionId),
  }),
);
