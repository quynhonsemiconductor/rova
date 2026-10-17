/**
 * identity v8 tables (Better Auth, `staff` preset + the admin plugin + the session context) — the product OWNS
 * these, in its own `identity` schema (identity README, "Tables").
 *
 * ADDITIVE, AND UNUSED. rova runs identity 7.x. Nothing reads or writes these tables until the cutover (the
 * identity v8 plan, §8.5); they exist so the schema is on every environment, soaked, before any code depends on it.
 * No v7 table is touched.
 *
 * Generated shape: `auth generate` against the createIdentity call rova will make (presets `['staff']`,
 * `staff.allowGuests: true`, `context`), then the house adjustments the package documents: tables in the `identity`
 * pg schema, native `uuid` ids (identity generates uuidv7 in the application, so there is no database default),
 * `timestamptz`. Only the tables the `staff` preset uses: no `organization`, `member`, `sso_provider`, `invitation`
 * or `two_factor` (those belong to presets rova does not run; partner SSO is deferred by decision).
 *
 * NAMES. These are Better Auth's own model names (`user`, `session`, `account`, `verification`), because the drizzle
 * adapter looks a model up by key. They are SINGULAR on purpose: rova's own `identity.users` (plural, defined in
 * ./identity.ts) stays as the product's PROFILE table — status, locale, timezone, phone, last_login_at, deleted_at.
 *
 *   identity.users   rova's profile table (v7, kept)        identity."user"   Better Auth's login identity (v8)
 *
 * They are linked by VALUE, not by foreign key: `identity.users.id = identity."user".id`, one-to-one. No FK because
 * a soft-deleted or never-signed-in profile row has no login identity, and an FK from either side to the other
 * would force one to exist for the other. The invariant is asserted by the backfill and by a test, not by the database.
 *
 * `session.context_id` is identity 8.4's active context (rova: the workspace). No FK to workspace.workspaces for
 * now: the column is written only by identity, and the cutover decides whether to add one.
 *
 * Mapping at cutover (docs/runbooks/identity-v8-data-model.md):
 *   identity.users            -> identity."user"      same id, lower(email), display_name -> name, avatar_url -> image,
 *                                                      email_verified = v7 value OR Entra identity OR staff domain, inactive|suspended -> banned
 *   identity.sso_identities   -> identity.account     provider 'entra' -> provider_id 'microsoft', provider_sub -> account_id
 *   identity.auth_sessions    -> (not migrated)        everyone signs in once
 *   workspace_members         -> session.context_id    set at sign-in by identity's `initial`
 */
import { relations, sql } from 'drizzle-orm';
import { boolean, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { identitySchema } from './identity';

export const user = identitySchema.table('user', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
  // admin plugin
  role: text('role'),
  banned: boolean('banned').default(false),
  banReason: text('ban_reason'),
  banExpires: timestamp('ban_expires', { withTimezone: true }),
});

export const session = identitySchema.table(
  'session',
  {
    id: uuid('id').primaryKey(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    // admin plugin
    impersonatedBy: uuid('impersonated_by'),
    // identity 8.4: the active context (rova: the workspace)
    contextId: uuid('context_id'),
  },
  (table) => [
    index('session_userId_idx').on(table.userId),
    // identity's clearContext* look sessions up by context_id; partial, most sessions have none.
    index('session_context_id_idx')
      .on(table.contextId)
      .where(sql`context_id IS NOT NULL`),
  ],
);

export const account = identitySchema.table(
  'account',
  {
    id: uuid('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('account_userId_idx').on(table.userId),
    // Better Auth looks an account up by (provider_id, account_id) on every Microsoft sign-in.
    index('account_provider_account_idx').on(table.providerId, table.accountId),
  ],
);

export const verification = identitySchema.table(
  'verification',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
