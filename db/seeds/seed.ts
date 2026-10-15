// Load .env for local dev; in CI the env vars are injected directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI mode */
}

/**
 * Seed entrypoint (barrel) for the tiered seed system:
 *
 *   reference.ts  → seedSystemRoles      RBAC catalogue — prod-safe, EVERY env
 *   bootstrap.ts  → seedTenantBootstrap  workspace + SSO  — prod-safe, EVERY env
 *   demo.ts       → seed                 ONE-project E2E/dev fixture — gated by
 *                                        SEED_ON_DEPLOY, NEVER real production
 *
 * Two local commands:
 *   pnpm db:seed        → seedBaseline  — CLEAN develop DB: roles + QNSC
 *                         workspace + SSO + a single platform-admin (dev-login).
 *                         NO demo projects/work items.
 *   pnpm db:seed:test   → seed (--fixtures) — baseline PLUS the one-project
 *                         end-to-end fixture (NXP), for E2E + manual testing.
 *
 * db/migrate.ts imports { seed, seedSystemRoles, seedTenantBootstrap } from here,
 * so this barrel keeps that import surface stable.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { and, eq, isNull, or } from 'drizzle-orm';
import { pgOptions } from '../pg-ssl';
import { log } from '../script-log';
import * as schema from '../schema';
import { userRoleAssignments } from '../schema/access';
import { ADMIN_USER_ID, WORKSPACE_ID } from './constants';
import { seed } from './demo';
import { seedSystemRolesInto } from './reference';
import { seedTenantBootstrapInto } from './bootstrap';
import { resetFixtureTables } from './reset';

export { seed } from './demo';
export { seedSystemRoles } from './reference';
export { seedTenantBootstrap } from './bootstrap';

/**
 * Dev baseline: RBAC catalogue + QNSC workspace + SSO + a single platform-admin
 * user so dev-login works. NO demo projects/work items — a clean develop DB.
 * Prod-safe pieces (roles + workspace) mirror the deploy path; the admin row is
 * a dev convenience (in prod the admin JIT-provisions on first SSO login).
 * Idempotent (fixed UUIDs + onConflictDoNothing).
 */
export async function seedBaseline(connectionUrl?: string): Promise<void> {
  const url = connectionUrl ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL or connectionUrl required');

  const pool = new Pool({ ...pgOptions(url), max: 1 });
  const db = drizzle(pool, { schema });
  try {
    log.info('Seeding baseline (roles + workspace + admin)…');
    await seedSystemRolesInto(db);
    await seedTenantBootstrapInto(db);

    // Platform-admin user + workspace membership (dev-login target).
    const adminEmail = process.env['ADMIN_EMAIL'] ?? 'admin@qnsc.dev';
    await db
      .insert(schema.users)
      .values({
        id: ADMIN_USER_ID,
        email: adminEmail,
        displayName: 'Admin User',
        emailVerified: true,
        locale: 'en',
        timezone: 'Asia/Ho_Chi_Minh',
      })
      .onConflictDoNothing();
    await db
      .insert(schema.workspaceMembers)
      .values({ workspaceId: WORKSPACE_ID, userId: ADMIN_USER_ID })
      .onConflictDoNothing();

    // workspace_admin role (prefer the workspace-owned copy over the global template).
    const rows = await db
      .select({ id: schema.systemRoles.id, workspaceId: schema.systemRoles.workspaceId })
      .from(schema.systemRoles)
      .where(
        and(
          eq(schema.systemRoles.slug, 'workspace_admin'),
          or(
            isNull(schema.systemRoles.workspaceId),
            eq(schema.systemRoles.workspaceId, WORKSPACE_ID),
          ),
        ),
      );
    const adminRoleId = (rows.find((r) => r.workspaceId === WORKSPACE_ID) ?? rows[0])?.id;
    if (adminRoleId) {
      await db
        .insert(userRoleAssignments)
        .values({
          workspaceId: WORKSPACE_ID,
          userId: ADMIN_USER_ID,
          roleId: adminRoleId,
          scopeType: 'workspace',
          scopeId: WORKSPACE_ID,
          grantedBy: ADMIN_USER_ID,
        })
        .onConflictDoNothing();
    }

    log.info('✅  Baseline seeded — roles + QNSC workspace + admin. No fixtures.');
  } finally {
    await pool.end();
  }
}

/**
 * Run directly. Default = the prod-safe baseline; `--fixtures` (pnpm db:seed:test) RESETS the delivery
 * tables and loads the two-project fixture on top.
 *
 * The reset is here rather than inside `seed()` on purpose. `db/migrate.ts` calls `seed()` when
 * `SEED_ON_DEPLOY` is set, and truncating a deployed database because a migration ran would be
 * catastrophic — so the destructive step belongs to the explicit fixture ENTRYPOINT, never to the
 * function a deploy can reach.
 *
 * Why reset at all: the fixtures use fixed UUIDs with `onConflictDoNothing`, which survives a re-run
 * but NOT a database other things have written to. Item keys are unique per workspace and tests mint
 * them from a counter, so a leftover `US-3` makes the fixture's `US-3` conflict and silently vanish —
 * observed twice, once taking an entire project's portfolio with it.
 */
if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  const withFixtures = process.argv.includes('--fixtures') || process.argv.includes('--test');
  const run = withFixtures ? resetFixtureTables().then(() => seed()) : seedBaseline();
  run.catch((e) => {
    log.error({ err: e }, 'Seed failed');
    process.exit(1);
  });
}
