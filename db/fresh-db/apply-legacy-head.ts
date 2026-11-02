/**
 * Put a database in the state every pre-0128 environment was in, so the REST of
 * the journal can be applied on top of it (the legacy half of the fresh-DB
 * rebuild gate).
 *
 * Three steps, in this order:
 *
 *  1. Apply journal entries numbered below 0068, by running Drizzle's own
 *     migrator against a copy of `db/migrations` whose journal lists only them.
 *     Using the real migrator — not `psql -f` on each file — is what records the
 *     rows in `drizzle.__drizzle_migrations` the same way a deployed run does, so
 *     the second half starts from the spot a real upgrade starts from.
 *  2. Apply `legacy-0068.sql`, the frozen copy of 0068 as it ran on AWS: it
 *     creates `rally_app`, `rally_worker` and `rally_migrate` and grants them.
 *  3. Record 0068 in `drizzle.__drizzle_migrations` at its journal `when`, with
 *     the hash of the SQL that actually ran. The migrator compares only
 *     `created_at` (`drizzle-orm` 0.45.4, pg-core/dialect.js:57-68), so this is
 *     what makes the next `pnpm db:migrate` start at 0069.
 *
 * `db/migrate.ts` will report 0068 as "recorded with a DIFFERENT hash than the
 * file on disk" on the next run — expected and harmless here: the file was
 * rewritten on 2026-10-30 and this database ran the version before it. That is
 * exactly the condition the warning exists to describe.
 *
 * Usage: DATABASE_MIGRATION_URL=postgresql://… node/tsx db/fresh-db/apply-legacy-head.ts
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { log } from '../script-log';

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

const MIGRATIONS = path.resolve(__dirname, '..', 'migrations');
const LEGACY_0068 = path.resolve(__dirname, 'legacy-0068.sql');

/** The number a migration's tag starts with: `0128_rename…` → 128. */
const numberOf = (tag: string): number => Number.parseInt(tag.slice(0, 4), 10);

async function run(): Promise<void> {
  const url = process.env['DATABASE_MIGRATION_URL'];
  if (!url) {
    log.error({}, 'DATABASE_MIGRATION_URL is required (the superuser, as the RDS master was).');
    process.exit(1);
  }

  const journal = JSON.parse(
    readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8'),
  ) as Journal;

  const head = journal.entries.filter((e) => numberOf(e.tag) < 68);
  const at0068 = journal.entries.find((e) => numberOf(e.tag) === 68);
  if (head.length === 0 || !at0068) {
    log.error(
      {},
      'The journal has no entries below 0068, or no 0068 — cannot build a legacy head.',
    );
    process.exit(1);
  }

  const folder = mkdtempSync(path.join(tmpdir(), 'rova-legacy-head-'));
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    // Re-running is a no-op once the legacy head is in place: re-applying
    // legacy-0068.sql would RE-CREATE `rally_*` on a database 0128 has already
    // renamed them on, which is the opposite of the state this script produces.
    // Two statements rather than one: a brand-new database has no bookkeeping
    // table yet, which is the normal first run — referencing it in FROM would
    // error however the row is filtered.
    const present = await pool.query<{ present: boolean }>(
      `select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
    );
    const done = present.rows[0]?.present
      ? await pool.query(
          'select 1 from drizzle.__drizzle_migrations where created_at = $1 limit 1',
          [at0068.when],
        )
      : { rowCount: 0 };
    if ((done.rowCount ?? 0) > 0) {
      log.info(`Already at the legacy head (0068 recorded at when=${at0068.when}). Nothing to do.`);
      return;
    }

    mkdirSync(path.join(folder, 'meta'), { recursive: true });
    for (const entry of head) {
      copyFileSync(
        path.join(MIGRATIONS, `${entry.tag}.sql`),
        path.join(folder, `${entry.tag}.sql`),
      );
    }
    writeFileSync(
      path.join(folder, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: head }, null, 2),
    );

    log.info(
      `Applying ${head.length} journal entries below 0068 (last: ${head[head.length - 1]?.tag})…`,
    );
    await migrate(drizzle(pool), { migrationsFolder: folder });

    const legacySql = readFileSync(LEGACY_0068, 'utf8');
    const hash = createHash('sha256').update(legacySql).digest('hex');
    log.info('Applying legacy-0068.sql (creates rally_app / rally_worker / rally_migrate)…');
    await pool.query(legacySql);

    // Re-runnable: a retried step re-applies legacy-0068.sql (it is idempotent by
    // construction), but a SECOND row at this `created_at` would be stray state
    // for `db/migrate.ts`'s stranded-migration reasoning to explain — 0068's slot
    // must hold exactly one row.
    await pool.query(
      `insert into drizzle.__drizzle_migrations ("hash", "created_at")
       select $1, $2
        where not exists (
          select 1 from drizzle.__drizzle_migrations where created_at = $2
        )`,
      [hash, at0068.when],
    );
    log.info(
      `✅  0068 recorded at when=${at0068.when}; the rest of the journal applies from 0069.`,
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
    await pool.end();
  }
}

void run();
