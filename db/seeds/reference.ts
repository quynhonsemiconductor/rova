// Load .env for local dev; in CI the env vars are injected directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI mode */
}

/**
 * Reference tier — the RBAC role catalogue (system_roles).
 *
 * This is REFERENCE data, not demo fixtures. The backend @RequirePermission
 * decorators and the frontend gating derive their codes from the same catalogue
 * (db/permissions.catalog.ts), and JIT SSO provisioning assigns these role slugs
 * on first login. It must exist in EVERY environment (dev, staging AND
 * production), independent of SEED_ON_DEPLOY. Idempotent.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { pgOptions } from '../pg-ssl';
import { log } from '../script-log';
import * as schema from '../schema';
import { ROLE_PERMISSIONS, ROLE_NAMES, type SystemRoleSlug } from '../permissions.catalog';
import type { Db } from './constants';

/**
 * Seed the RBAC role catalogue (system_roles) into the given db handle.
 * Idempotent: onConflictDoUpdate backfills newly-granted permissions on re-run.
 */
export async function seedSystemRolesInto(database: Db): Promise<void> {
  const roleSlugs = Object.keys(ROLE_PERMISSIONS) as SystemRoleSlug[];
  for (const slug of roleSlugs) {
    const permissions = ROLE_PERMISSIONS[slug];
    const name = ROLE_NAMES[slug];
    await database
      .insert(schema.systemRoles)
      .values({
        name,
        slug,
        isSystem: true,
        permissions,
      })
      .onConflictDoUpdate({
        target: [schema.systemRoles.workspaceId, schema.systemRoles.slug],
        set: { permissions, name },
      });
  }
  log.info(`✅  System roles catalogue seeded (${roleSlugs.length} roles)`);
}

/**
 * Standalone entrypoint that seeds ONLY the reference role catalogue.
 * Safe to run on every deploy in every environment — including real production —
 * because it contains no demo fixtures (no workspace, users, projects, etc.).
 * Exported so db/migrate.ts can run it unconditionally after migrations.
 */
export async function seedSystemRoles(connectionUrl?: string): Promise<void> {
  const url = connectionUrl ?? process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL or connectionUrl required');

  const pool = new Pool({ ...pgOptions(url), max: 1 });
  const database = drizzle(pool, { schema });
  try {
    await seedSystemRolesInto(database);
  } finally {
    await pool.end();
  }
}
