/**
 * Repair `work_items.accepted_date` for rows that were accepted BEFORE the trigger existed.
 *
 * Velocity classifies a point as During / After / Not Accepted from `accepted_date`, and refuses to
 * guess: an accepted row with no timestamp is reported as `unclassified` rather than silently placed in
 * a bucket. `trg_sync_accepted_date` (migration 0087) maintains the column from then on, but it
 * deliberately invents nothing for rows that were already accepted — Velocity SRS §3 assigns DEV a
 * backfill "from auditable history", and this is it.
 *
 * The history is `work.activity_logs`: every schedule-state change writes
 * `{ field: 'scheduleState', old, new }` with a `created_at`. The acceptance moment is the LATEST
 * transition INTO an accepted-equivalent state — latest, not earliest, because an item can be accepted,
 * reopened and accepted again, and the current state was established by the most recent one.
 *
 * What it will NOT do:
 *   • touch a row that already has a timestamp — the trigger owns those, and overwriting audited data
 *     to make a chart tidier is exactly the fabrication the SRS forbids;
 *   • invent a date for a row with no such history. Those are REPORTED and left NULL, so they keep
 *     showing as `unclassified`, which is true. A synthesised date would move real points into a real
 *     bucket on no evidence.
 *
 * Run: `pnpm db:backfill:accepted-date` (add `--dry-run` to report without writing).
 */
import { Pool } from 'pg';

import { pgOptions } from './pg-ssl';
import { log } from './script-log';

export interface BackfillResult {
  /** Rows that are accepted-equivalent and still have no timestamp. */
  candidates: number;
  /** Rows a transition in `activity_logs` could date. */
  repaired: number;
  /** Item keys with no usable history — left NULL on purpose, and listed so they can be chased. */
  unresolved: string[];
}

/** `{accepted, release}` — `Release` stays accepted-equivalent, which is why both count. */
const ACCEPTED_STATES = ['accepted', 'release'] as const;

export async function backfillAcceptedDate(options: {
  connectionUrl?: string;
  dryRun?: boolean;
}): Promise<BackfillResult> {
  const url =
    options.connectionUrl ?? process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('backfill needs DATABASE_URL (or DATABASE_MIGRATION_URL).');

  const pool = new Pool(pgOptions(url));
  try {
    /**
     * Candidates and their best available evidence, in one query.
     *
     * A LATERAL join rather than a group-by: it takes the most recent qualifying transition per item
     * and stops, which is both the rule and the cheaper plan on the `(entity_type, entity_id,
     * created_at)` index.
     */
    const { rows } = await pool.query<{
      id: string;
      item_key: string;
      accepted_at: Date | null;
    }>(
      `
      select w.id,
             w.item_key,
             evidence.created_at as accepted_at
        from work.work_items w
        left join lateral (
              select a.created_at
                from work.activity_logs a
               where a.entity_type = 'work_item'
                 and a.entity_id = w.id
                 and a.action = 'work_item.schedule_state_changed'
                 and a.changes ->> 'field' = 'scheduleState'
                 and a.changes ->> 'new' = any($1::text[])
               order by a.created_at desc
               limit 1
             ) as evidence on true
       where w.schedule_state = any($1::work_item_schedule_state[])
         and w.accepted_date is null
         and w.deleted_at is null
      `,
      [ACCEPTED_STATES],
    );

    const datable = rows.filter((row) => row.accepted_at !== null);
    const unresolved = rows.filter((row) => row.accepted_at === null).map((row) => row.item_key);

    if (!options.dryRun && datable.length > 0) {
      // One statement, not a loop: the pairs are already known, and a per-row update would hold the
      // connection open for as long as the population is large.
      await pool.query(
        `
        update work.work_items w
           set accepted_date = v.accepted_at
          from (select unnest($1::uuid[]) as id, unnest($2::timestamptz[]) as accepted_at) as v
         where w.id = v.id
           and w.accepted_date is null
        `,
        [datable.map((row) => row.id), datable.map((row) => row.accepted_at)],
      );
    }

    return {
      candidates: rows.length,
      repaired: options.dryRun ? 0 : datable.length,
      unresolved,
    };
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.includes('backfill-accepted-date')) {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* CI injects env directly */
  }
  const dryRun = process.argv.includes('--dry-run');
  backfillAcceptedDate({ dryRun })
    .then((result) => {
      const verb = dryRun ? 'would repair' : 'repaired';
      log.info(
        `accepted_date backfill: ${result.candidates} candidate(s), ${verb} ${dryRun ? result.candidates - result.unresolved.length : result.repaired}.`,
      );
      if (result.unresolved.length > 0) {
        // Named, not counted: these stay `unclassified` in Velocity, and that is the correct answer
        // until someone can say when they were accepted.
        log.info(
          `  no auditable transition for ${result.unresolved.length}: ${result.unresolved.slice(0, 20).join(', ')}${result.unresolved.length > 20 ? ', …' : ''}`,
        );
      }
    })
    .catch((error) => {
      log.error({ err: error }, 'accepted_date backfill failed');
      process.exit(1);
    });
}
