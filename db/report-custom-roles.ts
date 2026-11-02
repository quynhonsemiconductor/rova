/**
 * REPORT every custom role, everyone holding one, and every workspace-scoped tier assignment.
 *
 * This writes NOTHING, ever, and that is the point. Custom roles and the editable permission matrix
 * were deleted by ruling (2026-08-14, AC-11): `db/permissions.catalog.ts` is the single source of truth
 * a custom matrix would fork, and custom-role CRUD plus WORKSPACE-scoped tier-role assignment together
 * re-create exactly the company-wide over-grant migration 0111 removed. The editing routes and the dead
 * UI are already gone.
 *
 * The DATA is a separate, gated step, because **deleting a role a user currently HOLDS revokes their
 * access**. So the sequence is: remove the routes (done), read this report against a real database, and
 * only then write the migration that removes the rows — converting any real assignment to its
 * per-project equivalent. Guessing at that conversion from an empty local database is how a migration
 * silently takes someone's access away; the `pnpm db:backfill:accepted-date` precedent is the same
 * discipline (report, never guess).
 *
 * **`is_system = false` is NOT the custom-role predicate, and getting that wrong is dangerous.**
 * `db/seeds/bootstrap.ts` creates a workspace-owned, EDITABLE copy of each tier role, and those rows
 * carry `is_system = false` too — on a seeded database `project_admin` (31 permissions) and
 * `project_member` (8) sit right beside the genuine customs. A report keyed on that flag would list the
 * two roles the entire access model depends on as deletable, and a migration acting on it would remove
 * them. The discriminator is the SLUG: anything outside `SYSTEM_ROLE` is custom.
 *
 * Two things this report is looking for, and they are not the same:
 *   • A CUSTOM role — a slug the catalogue does not define. Its permission set exists nowhere in
 *     `db/permissions.catalog.ts`, so nothing can re-derive it after deletion; if anyone holds one, its
 *     codes have to be read here and mapped by hand.
 *   • A WORKSPACE-scoped assignment of any role, custom or not. That is the over-grant shape itself: a
 *     project-tier code held across every project in the workspace, which the per-project model
 *     (`work.project_members.access_level`) expresses per project or not at all.
 *
 * An empty report is the expected result on a seeded database and is NOT proof the migration is safe on
 * a deployed one — run it against every environment before writing that migration.
 *
 * Run: `pnpm db:report:custom-roles`
 */
import { Pool } from 'pg';

import { pgOptions, tlsFromEnv } from './pg-ssl';
import { SYSTEM_ROLE } from './permissions.catalog';

/** A report is output a person reads, not a log: it goes to stdout as plain lines. */
function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

export interface CustomRoleHolder {
  userId: string;
  email: string | null;
  /** NULL for a workspace-scoped assignment — that absence IS the finding. */
  scopeId: string | null;
  scopeType: string;
}

export interface CustomRoleReportRow {
  roleId: string;
  workspaceId: string | null;
  slug: string;
  name: string;
  permissions: string[];
  holders: CustomRoleHolder[];
}

export interface CustomRoleReport {
  /** Roles whose slug the catalogue does not define, whether or not anyone holds them. */
  customRoles: CustomRoleReportRow[];
  /** Workspace-scoped assignments of ANY role — the over-grant shape, custom or not. */
  workspaceScopedAssignments: Array<CustomRoleHolder & { roleSlug: string; roleName: string }>;
  /** True when nothing has to be converted before the removal migration. */
  safeToRemove: boolean;
}

export async function reportCustomRoles(options: {
  databaseUrl: string;
}): Promise<CustomRoleReport> {
  const pool = new Pool(pgOptions(options.databaseUrl, tlsFromEnv()));
  try {
    // Keyed on the SLUG, not on `is_system` — see the header. `SYSTEM_ROLE` is the catalogue's own
    // list, so a tier role added there later is automatically excluded here rather than becoming a
    // false positive nobody notices until a migration deletes it.
    const tierSlugs = Object.values(SYSTEM_ROLE);
    const roles = await pool.query<{
      id: string;
      workspace_id: string | null;
      slug: string;
      name: string;
      permissions: string[] | null;
      is_system: boolean;
    }>(
      `SELECT id, workspace_id, slug, name, permissions, is_system
         FROM access.system_roles
        WHERE slug <> ALL($1::text[])
        ORDER BY workspace_id NULLS FIRST, slug`,
      [tierSlugs],
    );

    const customRoles: CustomRoleReportRow[] = [];
    for (const role of roles.rows) {
      const holders = await pool.query<{
        user_id: string;
        email: string | null;
        scope_id: string | null;
        scope_type: string;
      }>(
        `SELECT a.user_id, u.email, a.scope_id, a.scope_type
           FROM access.user_role_assignments a
           LEFT JOIN identity.users u ON u.id = a.user_id
          WHERE a.role_id = $1
          ORDER BY u.email NULLS LAST`,
        [role.id],
      );
      customRoles.push({
        roleId: role.id,
        workspaceId: role.workspace_id,
        slug: role.slug,
        name: role.name,
        permissions: role.permissions ?? [],
        holders: holders.rows.map((h) => ({
          userId: h.user_id,
          email: h.email,
          scopeId: h.scope_id,
          scopeType: h.scope_type,
        })),
      });
    }

    // Deliberately NOT filtered to custom roles: a workspace-scoped assignment of a TIER role is the
    // same over-grant, and migration 0111/0112 removed exactly those rows. A new one means something
    // re-created it.
    const wsScoped = await pool.query<{
      user_id: string;
      email: string | null;
      scope_id: string | null;
      scope_type: string;
      slug: string;
      name: string;
    }>(
      `SELECT a.user_id, u.email, a.scope_id, a.scope_type, r.slug, r.name
         FROM access.user_role_assignments a
         JOIN access.system_roles r ON r.id = a.role_id
         LEFT JOIN identity.users u ON u.id = a.user_id
        WHERE a.scope_type = 'workspace'
          AND r.slug <> $1
        ORDER BY r.slug, u.email NULLS LAST`,
      [SYSTEM_ROLE.WORKSPACE_ADMIN],
    );

    const workspaceScopedAssignments = wsScoped.rows.map((r) => ({
      userId: r.user_id,
      email: r.email,
      scopeId: r.scope_id,
      scopeType: r.scope_type,
      roleSlug: r.slug,
      roleName: r.name,
    }));

    return {
      customRoles,
      workspaceScopedAssignments,
      safeToRemove:
        customRoles.every((r) => r.holders.length === 0) && workspaceScopedAssignments.length === 0,
    };
  } finally {
    await pool.end();
  }
}

/* c8 ignore start -- CLI entrypoint; the reporting logic above is what tests cover. */
async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    process.stderr.write('DATABASE_URL is required\n');
    process.exit(1);
  }

  const report = await reportCustomRoles({ databaseUrl });

  out('\n── Custom roles ────────────────────────────────────────────────');
  if (report.customRoles.length === 0) {
    out('  none');
  }
  for (const role of report.customRoles) {
    const scope = role.workspaceId ? `workspace ${role.workspaceId}` : 'GLOBAL template';
    out(`\n  ${role.name} (${role.slug}) — ${scope}`);
    out(`    permissions: ${role.permissions.join(', ') || '(none)'}`);
    if (role.holders.length === 0) {
      out('    holders: none — safe to delete');
    } else {
      out(`    holders: ${role.holders.length}`);
      for (const h of role.holders) {
        const where = h.scopeId ? `${h.scopeType}:${h.scopeId}` : h.scopeType;
        out(`      • ${h.email ?? h.userId} @ ${where}`);
      }
    }
  }

  out('\n── Workspace-scoped assignments (excluding workspace_admin) ────');
  if (report.workspaceScopedAssignments.length === 0) {
    out('  none');
  }
  for (const a of report.workspaceScopedAssignments) {
    out(`  • ${a.email ?? a.userId} holds ${a.roleName} (${a.roleSlug}) workspace-wide`);
  }

  out(
    `\n${report.safeToRemove ? '✅' : '⚠️ '} ${
      report.safeToRemove
        ? 'Nothing is held. The removal migration can delete these rows with no conversion.'
        : 'Rows ARE held. Each holder above needs a per-project equivalent BEFORE the removal migration.'
    }`,
  );
  out(
    'This report wrote nothing. Run it against every environment — an empty local result proves nothing.\n',
  );
}

if (require.main === module) {
  void main();
}
/* c8 ignore stop */
