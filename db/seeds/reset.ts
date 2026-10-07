/**
 * Truncate the delivery tables so the FIXTURE seed lands on a known database.
 *
 * Why a reset rather than idempotent upserts. The fixtures use fixed UUIDs and `onConflictDoNothing`,
 * which is safe against re-running the seed — but not against a database that other things have
 * written to. Item keys are unique per WORKSPACE (`uq_portfolio_item_key`, `uq_work_item_key`), and
 * tests mint them from a counter, so a leftover `US-3` from a previous Playwright run makes the seed's
 * `US-3` conflict and vanish. Silently: `onConflictDoNothing` reports nothing, so the fixture is simply
 * absent and whatever depended on it fails somewhere else entirely. That happened twice while this was
 * being written — once for `EP-1`/`FE-1` (the whole second project's portfolio disappeared, surfacing
 * as a foreign-key error on an allocation) and once for `US-3`.
 *
 * So the fixture path resets first. That also makes a developer's local database identical to the one
 * the e2e suite runs against, which is the only way "it passes locally" means anything.
 *
 * NOT called by `pnpm db:migrate` or the prod-safe baseline seed — only by the explicit fixture
 * entrypoints (`pnpm db:seed:test` and the e2e global setup). Truncating a deployed database because a
 * migration ran would be catastrophic, and that is exactly the kind of blast radius a shared helper
 * invites, so the gate is that this is never wired into `seed()` itself.
 */
import { Pool } from 'pg';

import { pgOptions } from '../pg-ssl';

/**
 * Every table holding delivery or activity data, in dependency-free order.
 *
 * `TRUNCATE ... CASCADE` follows the foreign keys itself, which is the point — hand-maintaining a safe
 * delete order across 40+ tables is the discipline that never holds. Listed EXPLICITLY rather than
 * discovered from the catalogue: a new table nobody adds here keeps its rows, which is a visible bug,
 * where auto-discovery would silently wipe a table someone meant to keep.
 *
 * Deliberately absent: `identity.*`, `access.*`, `workspace.*`. Users, roles, grants and the workspace
 * are the ground the fixtures stand on; `bootstrap.ts` reconciles them idempotently, and dropping a
 * role would take its assignments with it — including the ones the e2e viewer fixtures rely on.
 */
export const FIXTURE_TABLES = [
  'work.capacity_plan_allocations',
  'work.capacity_plan_teams',
  'work.capacity_plans',
  'work.iteration_daily_snapshots',
  'work.release_daily_snapshots',
  'work.member_capacity',
  'work.attachments',
  'work.time_logs',
  // Phase 7 Carryover events (0133). Listed EXPLICITLY although `TRUNCATE … CASCADE` from
  // work_items would reach them through the FK dependency: an unlisted table is a visible bug, not a
  // silent one. NOTE for a future DELETE-based reset: these FKs are NO ACTION and the immutability
  // trigger refuses row-level DELETE, so per-table DELETEs cannot clear them — only TRUNCATE can.
  'work.iteration_transition_tasks',
  'work.iteration_transitions',
  'work.work_item_watchers',
  'work.work_item_labels',
  'work.work_item_relations',
  'work.comments',
  'work.tasks',
  'work.work_items',
  'work.portfolio_items',
  'work.milestone_artifacts',
  'work.milestone_releases',
  'work.milestone_teams',
  'work.milestone_projects',
  'work.milestones',
  'work.iterations',
  'work.releases',
  'work.labels',
  'work.workflow_transitions',
  'work.workflow_statuses',
  'work.project_teams',
  'work.project_members',
  'work.team_members',
  'work.teams',
  'work.projects',
  'work.workspace_item_counters',
  'work.activity_logs',
  'messaging.notification_outbox',
  'messaging.email_outbox',
  // Truncating the CHILD of workspace.workspace_invitations is safe — an FK restricts truncating a
  // parent, never a child — and `workspace.*` stays deliberately absent from this list, so the
  // invitations themselves survive a reset exactly as they did before this table existed.
  'messaging.guest_invite_outbox',
  'messaging.outbox_events',
  'notifications.in_app_notifications',
  'notifications.notification_preferences',
  'audit.audit_logs',
  'storage.files',
  'scm.changesets',
  'scm.connections',
  'scm.backfill_jobs',
  'scm.repositories',
  'scm.installations',
  'scm.webhook_inbox',
] as const;

/** Truncate every fixture table. Takes a URL rather than a pool so callers need no drizzle setup. */
export async function resetFixtureTables(connectionUrl?: string): Promise<void> {
  const url = connectionUrl ?? process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Fixture reset needs DATABASE_URL (or DATABASE_MIGRATION_URL).');

  const pool = new Pool(pgOptions(url));
  try {
    await pool.query(`TRUNCATE TABLE ${FIXTURE_TABLES.join(', ')} CASCADE`);
  } finally {
    await pool.end();
  }
}
