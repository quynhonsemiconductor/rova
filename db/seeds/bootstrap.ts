// Load .env for local dev; in CI the env vars are injected directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI mode */
}

/**
 * Bootstrap tier — the primary tenant (workspace + Entra SSO connection) plus the
 * editable workspace-scoped role copies.
 *
 * This is prod-safe CONFIG (no demo fixtures): it is what lets real users
 * JIT-provision and lets a PLATFORM_ADMIN_EMAILS admin be elevated on first SSO
 * login. Driven entirely by env so the same routine runs identically in dev,
 * staging and production. Runs in EVERY environment, independent of
 * SEED_ON_DEPLOY.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { pgOptions } from '../pg-ssl';
import { log } from '../script-log';
import { inArray, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { ssoConnections, ssoConnectionDomains } from '../schema/identity';
import {
  ROLE_PERMISSIONS,
  ROLE_NAMES,
  SYSTEM_ROLE,
  PRESET_WORKSPACE_ROLES,
} from '../permissions.catalog';
import { type Db, WORKSPACE_ID } from './constants';

/**
 * Bootstrap the primary tenant — the workspace and its Entra SSO connection —
 * into the given db handle. This is prod-safe CONFIG (no demo fixtures): it is
 * what lets real users JIT-provision and lets a PLATFORM_ADMIN_EMAILS admin be
 * elevated on first SSO login. Driven entirely by env so the same routine runs
 * identically in dev, staging and production:
 *   BOOTSTRAP_WORKSPACE_NAME  — display name (default "ACME Corp")
 *   BOOTSTRAP_WORKSPACE_SLUG  — url slug     (default "main")
 *   ENTRA_TENANT_ID           — Entra directory to federate (skips SSO if unset)
 *   SSO_ALLOWED_EMAIL_DOMAINS — comma-separated JIT allow-list (default "qnsc.vn")
 *   SSO_JIT_ENABLED           — "false" = invite-only (only pre-provisioned users
 *                               + platform admins may sign in); default "true"
 * Idempotent: workspace + connection use onConflictDoUpdate so config edits
 * reconcile on every run.
 */
export async function seedTenantBootstrapInto(database: Db): Promise<void> {
  const workspaceName = process.env['BOOTSTRAP_WORKSPACE_NAME'] ?? 'QNSC';
  const workspaceSlug = process.env['BOOTSTRAP_WORKSPACE_SLUG'] ?? 'main';

  await database
    .insert(schema.workspaces)
    .values({ id: WORKSPACE_ID, slug: workspaceSlug, name: workspaceName })
    .onConflictDoUpdate({
      target: schema.workspaces.id,
      set: { name: workspaceName },
    });

  // Seed the workspace's default formatting (QNSC is Vietnam-based). Members
  // inherit this timezone/locale until they override it in their own Profile;
  // an admin can change it in Workspace Settings. onConflictDoNothing so that
  // later admin edit is never reset on redeploy.
  await database
    .insert(schema.workspaceSettings)
    .values({ workspaceId: WORKSPACE_ID, timezone: 'Asia/Ho_Chi_Minh', defaultLocale: 'en' })
    .onConflictDoNothing({ target: schema.workspaceSettings.workspaceId });

  // Preset persona roles were removed in the Phase 4.2 baseline (3 canonical
  // roles only). PRESET_WORKSPACE_ROLES is empty; guard the insert since an
  // empty VALUES list is a SQL error. Custom roles authored later are untouched.
  if (PRESET_WORKSPACE_ROLES.length > 0) {
    await database
      .insert(schema.systemRoles)
      .values(
        PRESET_WORKSPACE_ROLES.map((role) => ({
          workspaceId: WORKSPACE_ID,
          name: role.name,
          slug: role.slug,
          description: role.description,
          isSystem: false,
          permissions: role.permissions,
        })),
      )
      .onConflictDoNothing({
        target: [schema.systemRoles.workspaceId, schema.systemRoles.slug],
      });
  }

  // Per-workspace copy of the two operational tiers (Project Admin / Member).
  // These are the roles actually ASSIGNED to users. They SEED from the catalogue
  // but are now WORKSPACE-EDITABLE (a workspace admin can tune them in Roles &
  // Permissions), so re-seeding must NOT clobber those edits — it only keeps the
  // display NAME in sync and inserts the defaults for a brand-new workspace.
  // Workspace Admin stays the global immutable anchor.
  const CANONICAL_TIER_SLUGS = [SYSTEM_ROLE.PROJECT_ADMIN, SYSTEM_ROLE.PROJECT_MEMBER] as const;
  await database
    .insert(schema.systemRoles)
    .values(
      CANONICAL_TIER_SLUGS.map((slug) => ({
        workspaceId: WORKSPACE_ID,
        name: ROLE_NAMES[slug],
        slug,
        isSystem: false,
        permissions: ROLE_PERMISSIONS[slug],
      })),
    )
    .onConflictDoUpdate({
      // Preserve any workspace edits to the tier role's permissions — only the
      // display name tracks the catalogue on re-seed.
      target: [schema.systemRoles.workspaceId, schema.systemRoles.slug],
      set: { name: sql`excluded.name` },
    });

  // Re-point any EXISTING assignment that still references a global tier
  // template onto this workspace's editable copy, so a workspace admin's later
  // permission edits actually take effect for already-provisioned users (and so
  // re-seeding never leaves a user holding both the template and the copy).
  // Idempotent: once re-pointed there are no template-scoped rows left to move.
  const tierRoleRows = await database
    .select({
      id: schema.systemRoles.id,
      slug: schema.systemRoles.slug,
      workspaceId: schema.systemRoles.workspaceId,
    })
    .from(schema.systemRoles)
    .where(inArray(schema.systemRoles.slug, [...CANONICAL_TIER_SLUGS]));
  for (const slug of CANONICAL_TIER_SLUGS) {
    const globalId = tierRoleRows.find((r) => r.slug === slug && r.workspaceId === null)?.id;
    const copyId = tierRoleRows.find((r) => r.slug === slug && r.workspaceId === WORKSPACE_ID)?.id;
    if (!globalId || !copyId) continue;
    // Drop template-scoped assignments that already have a copy twin (would
    // otherwise collide on the (user, role, scope) unique key), then move the rest.
    await database.execute(sql`
      DELETE FROM access.user_role_assignments a
      WHERE a.role_id = ${globalId}
        AND a.workspace_id = ${WORKSPACE_ID}
        AND EXISTS (
          SELECT 1 FROM access.user_role_assignments b
          WHERE b.user_id = a.user_id
            AND b.role_id = ${copyId}
            AND b.scope_type = a.scope_type
            AND b.scope_id IS NOT DISTINCT FROM a.scope_id
        )
    `);
    await database.execute(sql`
      UPDATE access.user_role_assignments
      SET role_id = ${copyId}
      WHERE role_id = ${globalId}
        AND workspace_id = ${WORKSPACE_ID}
    `);
  }

  const entraTid = process.env['ENTRA_TENANT_ID'];
  if (!entraTid) {
    log.info(
      `\u2705  Tenant bootstrap: workspace "${workspaceName}" + ${PRESET_WORKSPACE_ROLES.length} preset roles ` +
        `+ ${CANONICAL_TIER_SLUGS.length} editable tier roles ensured ` +
        `(no ENTRA_TENANT_ID \u2014 SSO connection skipped, dev-login only)`,
    );
    return;
  }

  // Restrict JIT provisioning to the corporate domain(s). Empty list = any
  // directory user could self-provision; default to qnsc.vn so only company
  // accounts auto-create. NOTE: only gates NEW users \u2014 already-linked SSO
  // identities skip the domain check on subsequent logins.
  const ssoAllowedDomains = (process.env['SSO_ALLOWED_EMAIL_DOMAINS'] ?? 'qnsc.vn')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  // Invite-only toggle. Default true = open JIT: any allowed-domain user self-
  // provisions on first SSO login. Set SSO_JIT_ENABLED=false to require pre-
  // provisioning — only seeded/invited users (matched by email) and
  // PLATFORM_ADMIN_EMAILS admins may sign in; everyone else is rejected until an
  // admin invites them. The invited-user allow path needs @quynhonsemiconductor/identity
  // >= 5.5.0 (older versions treat jitEnabled=false as block-everyone).
  const jitEnabled = (process.env['SSO_JIT_ENABLED'] ?? 'true').toLowerCase() !== 'false';

  // Multi-IdP broker (>= 5.5.0): configure the home connection as a `directory`
  // connection so the home tenant also works through the generic broker path.
  // authority drives OIDC discovery; acceptedIssuers covers the Entra v2 + legacy
  // v1 issuers; the client secret lives in Secrets Manager (ref only, never here).
  const authorityUrl = `https://login.microsoftonline.com/${entraTid}/v2.0`;
  const acceptedIssuers = [
    `https://login.microsoftonline.com/${entraTid}/v2.0`,
    `https://sts.windows.net/${entraTid}/`,
  ];
  const homeClientId = process.env['ENTRA_CLIENT_ID'] ?? null;
  const homeSecretRef = process.env['IDENTITY_HOME_SECRET_REF'] ?? null;

  const brokerFields = {
    kind: 'directory' as const,
    authorityUrl,
    acceptedIssuers,
    clientId: homeClientId,
    clientSecretRef: homeSecretRef,
    displayName: 'QNSC (home)',
  };

  const [homeConn] = await database
    .insert(ssoConnections)
    .values({
      workspaceId: WORKSPACE_ID,
      provider: 'entra',
      externalTenantId: entraTid,
      defaultRoleSlug: 'project_member',
      allowedEmailDomains: ssoAllowedDomains,
      jitEnabled,
      status: 'active',
      ...brokerFields,
    })
    // Reconcile config on every run so allow-list / default-role / JIT / broker
    // fields take effect on the existing connection.
    .onConflictDoUpdate({
      target: [ssoConnections.provider, ssoConnections.externalTenantId],
      set: {
        workspaceId: WORKSPACE_ID,
        defaultRoleSlug: 'project_member',
        allowedEmailDomains: ssoAllowedDomains,
        jitEnabled,
        status: 'active',
        updatedAt: new Date(),
        ...brokerFields,
      },
    })
    .returning({ id: ssoConnections.id });

  // Populate the home connection's owned domains (routing + gate source of truth).
  // Idempotent via the UNIQUE(domain) constraint.
  if (homeConn && ssoAllowedDomains.length > 0) {
    await database
      .insert(ssoConnectionDomains)
      .values(ssoAllowedDomains.map((domain) => ({ connectionId: homeConn.id, domain })))
      .onConflictDoNothing({ target: ssoConnectionDomains.domain });
  }

  /**
   * The SAME Entra tenant, reached by INVITATION instead of by domain.
   *
   * This row is what lets an invited external type their own address in the `Email address` box.
   * `ConnectionRegistry.resolveForEmail` asks two questions in order — does a `directory`
   * connection OWN this domain (true for staff, never true for `gmail.com`, which no organisation
   * owns), and failing that, is there a `shared` connection this address holds a LIVE pending
   * invitation to. Without a `shared` row the second question could never match, so an invited
   * vendor got `NO_CONNECTION` from the box whose label invited them to type, and the only path
   * that worked was a button saying "Sign in with Microsoft" — which the people it serves are the
   * least likely to press, since they have no Microsoft account and cannot know Entra will simply
   * email them a code.
   *
   * WHY A SENTINEL `externalTenantId`. `uq_sso_connections_provider_external` is UNIQUE on
   * (provider, external_tenant_id), so a second `provider: 'entra'` row cannot repeat the real
   * tenant id — and because the home upsert above targets that exact pair, doing so would not add a
   * sibling, it would OVERWRITE the staff connection: `kind` flipped to `shared`, the domain
   * allow-list emptied, the display name and client replaced. Staff email-first routing would die
   * silently. `WORKSPACE_ID` is used as the sentinel because nothing on the broker path reads this
   * column — it is absent from `ResolvedConnection`, and the `tid` claim is documented as
   * descriptive metadata only, with routing driven by the connection.
   *
   * WHY IT IS SAFE that this row shares a tenant, a client and a secret with the home connection:
   * the guest is a member of OUR tenant, so their token's `iss`/`tid`/audience are identical to a
   * staff member's and the same `acceptedIssuers` verify both. `sso_identities` is keyed on
   * (provider, provider_sub), so both rows being `entra` means a person arriving through either
   * resolves to ONE identity rather than two — which a different `provider` value would have broken.
   *
   * WHAT GATES IT: `jitEnabled: false`, so `assertConnectionAllows` admits only a platform admin, an
   * already-provisioned user, or the holder of a live pending invitation. `allowedEmailDomains` is
   * empty and deliberately never consulted anyway — `assertConnectionAllows` skips the domain check
   * for a `shared` connection, because we cannot claim to own a consumer IdP's domains. So the
   * invitation is the entire authorization boundary for an external, which is the intent.
   *
   * NO `sso_connection_domains` ROWS. A row here would assert that we own that domain and would
   * make the connection domain-routed for everyone on it, invited or not.
   */
  const sharedFields = {
    kind: 'shared' as const,
    authorityUrl,
    acceptedIssuers,
    clientId: homeClientId,
    clientSecretRef: homeSecretRef,
    displayName: 'QNSC (guest)',
    defaultRoleSlug: 'project_member' as const,
    allowedEmailDomains: [] as string[],
    // Invitation-gated by construction. A `true` here would let any address Entra can verify in
    // this tenant provision itself, which is the opposite of the rule this row exists to enforce.
    jitEnabled: false,
    status: 'active' as const,
  };

  await database
    .insert(ssoConnections)
    .values({
      workspaceId: WORKSPACE_ID,
      provider: 'entra',
      externalTenantId: WORKSPACE_ID,
      ...sharedFields,
    })
    .onConflictDoUpdate({
      target: [ssoConnections.provider, ssoConnections.externalTenantId],
      set: { workspaceId: WORKSPACE_ID, updatedAt: new Date(), ...sharedFields },
    });

  log.info(
    `\u2705  Tenant bootstrap: workspace "${workspaceName}" + ${PRESET_WORKSPACE_ROLES.length} preset roles ` +
      `+ ${CANONICAL_TIER_SLUGS.length} editable tier roles + 2 Entra SSO connections ` +
      `reconciled (tid ${entraTid}, domains: ${ssoAllowedDomains.join(', ') || 'any'}, ` +
      `jit: ${jitEnabled ? 'open' : 'invite-only'}; ` +
      `guest connection invite-only, no owned domains)`,
  );
}

/**
 * Standalone entrypoint that bootstraps ONLY the primary tenant (workspace + SSO
 * connection). Prod-safe — contains no demo fixtures. Exported so db/migrate.ts
 * can run it on real production deploys.
 */
export async function seedTenantBootstrap(connectionUrl?: string): Promise<void> {
  const url = connectionUrl ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL or connectionUrl required');

  const pool = new Pool({ ...pgOptions(url), max: 1 });
  const database = drizzle(pool, { schema });
  try {
    await seedTenantBootstrapInto(database);
  } finally {
    await pool.end();
  }
}
