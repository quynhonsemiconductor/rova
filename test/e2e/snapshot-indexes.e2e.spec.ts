/**
 * The snapshot tables' unique indexes, asserted against the LIVE database.
 *
 * `db/schema/*` and `db/migrations/*.sql` are maintained by hand and must agree (CLAUDE.md). They did
 * not: both snapshot tables are created with a `COALESCE(team_id, nil)` unique index — because
 * `team_id IS NULL` is the All Teams row and a plain unique index does not dedupe NULLs — while the
 * schema declared three plain columns. A regenerated migration would have "corrected" the database to
 * the plain form and silently broken the daily job's idempotent upsert: two ticks, two All Teams rows,
 * and a chart that double-counts every day.
 *
 * Comparing the declaration to the database is the only check that catches that. A spec over the
 * schema file alone would just assert that the file says what the file says.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { bootRovaApp } from './support/flow-harness';

/** The nil UUID both migrations coalesce a null team into. */
const NIL = '00000000-0000-0000-0000-000000000000';

describe('snapshot unique indexes (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;

  beforeAll(async () => {
    app = await bootRovaApp();
    db = app.get<DrizzleDB>(DRIZZLE);
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each([
    ['uq_ids_iteration_team_date', 'iteration_daily_snapshots', 'iteration_id'],
    ['uq_rds_release_team_date', 'release_daily_snapshots', 'release_id'],
  ])(
    '%s coalesces the nullable team, so the All Teams row is deduped',
    async (indexName, tableName, ownerColumn) => {
      const rows = await db.execute<{ indexdef: string }>(
        sql`select indexdef from pg_indexes
          where schemaname = 'work' and tablename = ${tableName} and indexname = ${indexName}`,
      );

      expect(rows.rows, `${indexName} must exist`).toHaveLength(1);
      const definition = rows.rows[0].indexdef.toLowerCase();

      expect(definition).toContain('unique');
      expect(definition).toContain(ownerColumn);
      expect(definition).toContain('snapshot_date');
      // The whole point: the nullable column is wrapped, not listed bare.
      expect(definition).toContain(`coalesce(team_id, '${NIL}'::uuid)`);
    },
  );

  it('lets the All Teams row be upserted twice without duplicating it', async () => {
    /**
     * The behaviour the index exists for, proven rather than inferred from its definition. Two inserts
     * with `ON CONFLICT` on the coalesced expression must leave ONE row — which is exactly what the
     * hourly job does when it ticks twice in a day.
     */
    const iterationId = (
      await db.execute<{ id: string }>(sql`select id from work.iterations limit 1`)
    ).rows[0]?.id;
    expect(iterationId, 'seeded iteration required').toBeTruthy();

    const workspaceId = (
      await db.execute<{ workspace_id: string }>(
        sql`select workspace_id from work.iterations where id = ${iterationId}::uuid`,
      )
    ).rows[0].workspace_id;

    const probeDate = '2000-01-04'; // far outside any fixture window, so nothing else touches it
    for (const todo of ['10', '7']) {
      await db.execute(sql`
        insert into work.iteration_daily_snapshots
          (workspace_id, iteration_id, team_id, snapshot_date, remaining_todo, accepted_points)
        values (${workspaceId}::uuid, ${iterationId}::uuid, null, ${probeDate}::date, ${todo}, '0')
        on conflict (iteration_id, coalesce(team_id, ${NIL}::uuid), snapshot_date)
        do update set remaining_todo = excluded.remaining_todo
      `);
    }

    const after = await db.execute<{ n: number; remaining_todo: string }>(sql`
      select count(*)::int as n, max(remaining_todo) as remaining_todo
      from work.iteration_daily_snapshots
      where iteration_id = ${iterationId}::uuid and snapshot_date = ${probeDate}::date
    `);
    expect(after.rows[0].n).toBe(1);
    // The SECOND write won, which is what "rewrite today, never duplicate it" means.
    expect(Number(after.rows[0].remaining_todo)).toBe(7);

    await db.execute(sql`
      delete from work.iteration_daily_snapshots
      where iteration_id = ${iterationId}::uuid and snapshot_date = ${probeDate}::date
    `);
  });
});
