/**
 * The `accepted_date` backfill, against real rows and real history.
 *
 * Velocity refuses to guess: an accepted row with no timestamp is reported as `unclassified` rather
 * than placed in a bucket. `trg_sync_accepted_date` maintains the column from migration 0087 onward and
 * deliberately invents nothing for rows accepted before it, so Velocity SRS §3 assigns DEV a backfill
 * "from auditable history". This proves the tool does that — and, just as importantly, that it leaves
 * alone what it cannot evidence.
 *
 * Both fixtures are built here because the seed has no undated accepted rows (the trigger sees to
 * that), and a test for a repair tool needs something broken.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { DRIZZLE } from '@platform';
import type { DrizzleDB } from '@platform';

import { backfillAcceptedDate } from '../../db/backfill-accepted-date';
import { ADMIN_USER_ID, SEEDED, bootRallyApp, uniqueKey } from './support/flow-harness';

describe('accepted_date backfill (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DrizzleDB;
  /** `US-1`'s acceptance columns as SEEDED, so `afterAll` can put them back verbatim. */
  let seededStoryState:
    { schedule_state: string; flow_state: string; accepted_date: string | null } | undefined;

  /** An accepted work item with `accepted_date` forced to NULL — the pre-0087 shape. */
  async function undatedAcceptedItem(key: string): Promise<string> {
    const rows = await db.execute<{ id: string; workspace_id: string; project_id: string }>(sql`
      insert into work.work_items
        (workspace_id, project_id, item_key, type, title, schedule_state, flow_state, story_points,
         status_id, created_by, rank)
      select i.workspace_id, i.project_id, ${key}, 'story', ${`Backfill ${key}`},
             'accepted', 'accepted', '5',
             (select id from work.workflow_statuses where project_id = i.project_id limit 1),
             ${ADMIN_USER_ID}::uuid, ${`z${key}:`}
        from work.iterations i
       where i.id = ${SEEDED.nxp.iterationCurrentId}::uuid
      returning id, workspace_id, project_id
    `);
    const id = rows.rows[0].id;
    // The trigger stamps `accepted_date` on the way in; clearing it afterwards is how a pre-trigger row
    // looks, and is the only way to build one now.
    await db.execute(sql`update work.work_items set accepted_date = null where id = ${id}::uuid`);
    return id;
  }

  beforeAll(async () => {
    app = await bootRallyApp();
    db = app.get<DrizzleDB>(DRIZZLE);
    const rows = await db.execute<{
      schedule_state: string;
      flow_state: string;
      accepted_date: string | null;
    }>(
      sql`select schedule_state, flow_state, accepted_date from work.work_items
           where id = ${SEEDED.nxp.storyId}::uuid`,
    );
    seededStoryState = rows.rows[0];
  });

  /**
   * THIS SPEC MUTATES SHARED SEEDED STATE, AND IT NOW PUTS IT BACK.
   *
   * Two leaks, both of which made OTHER specs fail depending on the order vitest happened to pick —
   * and vitest orders files by cached duration, so that order moves whenever any spec's runtime does.
   * Each surfaced as a confident, wrong-looking failure somewhere else:
   *
   *  • the `BF-*` rows above are `type = 'story'` in the seeded NXP project, so
   *    `parent-story-feed.e2e.spec.ts`'s "every option's key starts with `US-`" failed with
   *    `BF-… is not a User Story` — a claim about the FEED, broken by a fixture three files away.
   *  • the second test below forces the seeded `US-1` to `accepted` to prove the trigger owns dated
   *    rows, which leaves it in a FINISHED state — so `split-story-authz.e2e.spec.ts`'s "reports the
   *    Story as splittable" failed on `eligible: false`, which is the correct answer to a question it
   *    did not mean to ask.
   *
   * Cleaning up here rather than loosening those two specs: they assert the right things, and a suite
   * whose global-setup comment already records leaking ~84 projects per pass does not need another
   * spec that only tidies up when it is run last.
   */
  afterAll(async () => {
    if (db && seededStoryState) {
      await db.execute(sql`delete from work.work_items where item_key like 'BF-%'`);
      // Both state columns are the SAME enum (`public.work_item_schedule_state` — `flow_state` reuses
      // it), and the type lives in `public`, not in `work`. Verified against the live catalogue rather
      // than assumed: an `::work.work_item_flow_state` cast fails at runtime inside `afterAll`, which
      // reports as "the FILE failed" with every test green and no assertion named.
      await db.execute(sql`
        update work.work_items
           set schedule_state = ${seededStoryState.schedule_state}::work_item_schedule_state,
               flow_state = ${seededStoryState.flow_state}::work_item_schedule_state,
               accepted_date = ${seededStoryState.accepted_date}::timestamptz
         where id = ${SEEDED.nxp.storyId}::uuid
      `);
    }
    await app?.close();
  });

  it('dates a row from its LATEST transition into an accepted state, and reports one it cannot', async () => {
    const withHistory = await undatedAcceptedItem(`BF-${uniqueKey()}`);
    const withoutHistory = await undatedAcceptedItem(`BF-${uniqueKey()}`);

    const project = await db.execute<{ workspace_id: string; project_id: string }>(
      sql`select workspace_id, project_id from work.work_items where id = ${withHistory}::uuid`,
    );
    const { workspace_id: workspaceId, project_id: projectId } = project.rows[0];

    /**
     * Two transitions into accepted, with a reopen between them.
     *
     * The LATEST is the one that established the current state — an item accepted in June, reopened,
     * and accepted again in July was not accepted in June for the purposes of the chart.
     */
    for (const [at, to] of [
      ['2026-06-10T09:00:00Z', 'accepted'],
      ['2026-06-15T09:00:00Z', 'in_progress'],
      ['2026-06-20T14:30:00Z', 'accepted'],
    ] as const) {
      await db.execute(sql`
        insert into work.activity_logs
          (workspace_id, project_id, entity_type, entity_id, action, changes, created_at)
        values (${workspaceId}::uuid, ${projectId}::uuid, 'work_item', ${withHistory}::uuid,
                'work_item.schedule_state_changed',
                ${JSON.stringify({ field: 'scheduleState', old: 'in_progress', new: to })}::jsonb,
                ${at}::timestamptz)
      `);
    }

    // A dry run must change nothing while reporting the same picture.
    const preview = await backfillAcceptedDate({ dryRun: true });
    expect(preview.candidates).toBeGreaterThanOrEqual(2);
    expect(preview.repaired).toBe(0);
    const stillNull = await db.execute<{ accepted_date: string | null }>(
      sql`select accepted_date from work.work_items where id = ${withHistory}::uuid`,
    );
    expect(stillNull.rows[0].accepted_date).toBeNull();

    const result = await backfillAcceptedDate({});
    expect(result.repaired).toBeGreaterThanOrEqual(1);

    const repaired = await db.execute<{ accepted_date: string }>(
      sql`select accepted_date from work.work_items where id = ${withHistory}::uuid`,
    );
    // `db.execute` returns a raw driver row, so timestamps arrive as STRINGS rather than Dates —
    // normalised here instead of asserted as one, which is how this test first failed.
    expect(new Date(repaired.rows[0].accepted_date).toISOString()).toBe('2026-06-20T14:30:00.000Z');

    // The row with no history is REPORTED and left NULL: it keeps reading as `unclassified`, which is
    // true, where a synthesised date would move real points into a real bucket on no evidence.
    const untouched = await db.execute<{ item_key: string; accepted_date: string | null }>(
      sql`select item_key, accepted_date from work.work_items where id = ${withoutHistory}::uuid`,
    );
    expect(untouched.rows[0].accepted_date).toBeNull();
    expect(result.unresolved).toContain(untouched.rows[0].item_key);
  });

  it('never overwrites a timestamp the trigger already set', async () => {
    // The trigger owns dated rows. Overwriting audited data to make a chart tidier is the fabrication
    // the SRS forbids, so a dated row must not even be a candidate.
    const before = await db.execute<{ accepted_date: string | null }>(
      sql`select accepted_date from work.work_items where id = ${SEEDED.nxp.storyId}::uuid`,
    );
    await db.execute(
      sql`update work.work_items set schedule_state = 'accepted', flow_state = 'accepted'
          where id = ${SEEDED.nxp.storyId}::uuid`,
    );

    const dated = await db.execute<{ accepted_date: string }>(
      sql`select accepted_date from work.work_items where id = ${SEEDED.nxp.storyId}::uuid`,
    );
    expect(dated.rows[0].accepted_date, 'trigger should have stamped it').not.toBeNull();

    await backfillAcceptedDate({});

    const after = await db.execute<{ accepted_date: string }>(
      sql`select accepted_date from work.work_items where id = ${SEEDED.nxp.storyId}::uuid`,
    );
    expect(new Date(after.rows[0].accepted_date).toISOString()).toBe(
      new Date(dated.rows[0].accepted_date).toISOString(),
    );
    expect(before.rows[0]).toBeDefined();
  });
});
