/**
 * DB migration runner — called by CI as a gated job BEFORE deploying a new app version.
 * Uses the DATABASE_MIGRATION_URL (privileged role that bypasses RLS).
 * Never run by the app process itself.
 */
// Load .env for local dev; in CI the env vars are injected directly.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — CI mode */
}

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { seed, seedSystemRoles, seedTenantBootstrap } from './seeds/seed';
import { assertNoMissingMigrations, strandedMigrations } from './stranded-migrations';
import { resolveDatabaseUrl } from './database-url';
import { resolveMigrationPoolConfig } from './pg-pool-config';
import { log } from './script-log';
import { runBackfillIfRequested } from './identity-v8/on-deploy';

// Resolves DATABASE_MIGRATION_URL, else DATABASE_URL, else composes from the
// DATABASE_* parts (the deployed path — credentials come straight from the
// RDS-managed secret, never a hand-maintained copy). Throws with a precise
// message listing what is missing.
// The role is `<product>_migrate`, set by the deployment — never the application role, whose
// statement_timeout would kill a long migration and whose rights do not include DDL.
let poolConfig: ReturnType<typeof resolveMigrationPoolConfig>;
try {
  poolConfig = resolveMigrationPoolConfig();
} catch (err) {
  log.error({ err }, (err as Error).message);
  process.exit(1);
}

const pool = new Pool({ ...poolConfig, max: 1 });

/** Whatever string the migration connection was built from. */
function resolveMigrationUrlFallback(): string {
  return poolConfig.connectionString ?? '';
}
const db = drizzle(pool);

/**
 * Prove every migration in the journal actually RAN — because "Migrations applied" does not.
 *
 * Drizzle records the journal's `when` as `created_at` and applies only entries past the newest
 * recorded value. So a file whose `when` is not strictly greater than its predecessor's — two branches
 * numbering in parallel, a copied timestamp, an abandoned branch migration applied on this database
 * first — is SKIPPED, silently, and the run still reports success. CLAUDE.md has documented the manual
 * recovery for a while ("verify with `select count(*) from drizzle.__drizzle_migrations` against the
 * journal's entry count"); this makes it automatic, because a manual check nobody is prompted to run is
 * the one that gets skipped exactly when it matters.
 *
 * It bit for real: `0125_api_tokens` never created `identity.api_tokens` on a developer database whose
 * `0125` slot was already taken by a discarded branch file carrying the same `when`. Seven e2e specs
 * failed with `relation "identity.api_tokens" does not exist`, which reads as broken code rather than
 * an unapplied migration.
 *
 * TWO SIGNALS, AND THEY DESERVE DIFFERENT ANSWERS — the first version of this failed on both and was
 * unusable locally, because it flagged five files whose objects plainly existed:
 *
 *   • NO ROW at an entry's `when` → the file may never have run, OR it ran and was recorded under a
 *     different timestamp (a renumbered journal does exactly that; CLAUDE.md notes two historical
 *     pairs whose `when` values are non-ascending and which ARE applied).
 *   • A row at that `when` whose HASH is not the file's → the file was edited after it ran (ordinary
 *     on a long-lived developer database, harmless in CI, which always starts empty), OR its slot is
 *     occupied by a DIFFERENT file and the real one was skipped, which is the incident above.
 *
 * `mismatched` WARNS, `missing` FAILS. The first version failed on both and broke `pnpm db:migrate` on a
 * real developer database for five files whose objects plainly existed; that was before the hash
 * fallback below (and the `knownEdits` allow-list) removed those false positives. What `missing` holds
 * now is an entry found neither at its own `when` nor by its file's hash: it ran nowhere. A deploy that
 * exits 0 with a schema change skipped is the failure this exists to stop, so the Job fails (the old
 * pods keep serving) instead of logging a warning nobody reads. `mismatched` is still ambiguous from
 * here (an edited file is harmless, a slot taken by another file is not), so it only warns; proving it
 * properly means diffing the live schema against the migrations, which is a different tool.
 *
 * A MISSING ROW AT AN ENTRY'S `when` IS NOT YET "STRANDED": the entry's file may be recorded under an EARLIER
 * `when` (this is what a corrected journal timestamp looks like on a database that ran the file before the
 * correction — 0006 and 0019). The match falls back to the file's hash, see `db/stranded-migrations.ts`; only an
 * entry found neither way is reported.
 *
 * Hashes are compared rather than counted: a count matches by coincidence whenever an abandoned branch
 * row occupies a real one's slot, which is precisely the case that produced the incident and precisely
 * the one a count cannot see. Drizzle hashes the file's raw text.
 *
 * It REPORTS (and fails on `missing`); it never repairs. Applying a stranded file out of order is a decision about a database
 * that may not be a developer's, and the safe recovery differs between a laptop (recreate it) and a
 * deployed environment (apply the one file, deliberately, having read it).
 */
async function assertNoStrandedMigrations(folder: string): Promise<void> {
  const journalPath = path.join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string; when: number }>;
  };

  const recorded = await db.execute<{ created_at: string; hash: string }>(
    sql`select created_at, hash from drizzle.__drizzle_migrations`,
  );
  const { missing, mismatched, recordedUnderOtherTimestamp, knownEdits } = strandedMigrations(
    journal.entries,
    recorded.rows,
    (tag) => {
      const file = path.join(folder, `${tag}.sql`);
      if (!fs.existsSync(file)) return undefined;
      return createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');
    },
  );
  if (knownEdits.length > 0) {
    // A rewrite that is on the allow-list (db/stranded-migrations.ts), with both hashes named there. Said at info
    // and separately from `mismatched`, so the mismatch warning keeps meaning "look at this database".
    log.info(
      `ℹ️   ${knownEdits.length} migration(s) were edited after they ran, as documented: ` +
        `${knownEdits.join(', ')}.`,
    );
  }
  if (recordedUnderOtherTimestamp.length > 0) {
    // Not a problem: the file ran, under the `when` it had then. Said once, at info, so the next reader knows why a
    // journal entry has no row at its own timestamp.
    log.info(
      `ℹ️   ${recordedUnderOtherTimestamp.length} migration(s) ran under an earlier timestamp than the journal now ` +
        `gives them (found by their file's hash): ${recordedUnderOtherTimestamp.join(', ')}.`,
    );
  }

  if (mismatched.length > 0) {
    log.warn(
      `⚠️   ${mismatched.length} migration(s) recorded with a DIFFERENT hash than the file on disk: ` +
        `${mismatched.join(', ')}. Either the file was edited after it ran (harmless), or its ` +
        'timestamp slot belongs to another file and this one never ran — check that the objects it ' +
        'creates actually exist before trusting this database.',
    );
  }
  // Throws: `run()` logs it and exits 1, before the seeds and the backfill.
  assertNoMissingMigrations({ missing });
}

async function run() {
  try {
    log.info('Running migrations...');
    const migrationsFolder = path.join(__dirname, 'migrations');
    await migrate(db, { migrationsFolder });
    // Before the seeds, so a stranded schema change is named ahead of the failure it would otherwise
    // cause against a table that was never created.
    await assertNoStrandedMigrations(migrationsFolder);
    log.info('✅  Migrations applied');

    // Seed uses the app connection, not the migration URL (admin role).
    // Falls back to the migration URL when no separate app credential is set.
    // The seed helpers take a connection STRING and build their own pool, so this is
    // the one place a URL is still required.
    const seedUrl = (() => {
      try {
        return resolveDatabaseUrl();
      } catch {
        return resolveMigrationUrlFallback();
      }
    })();

    // Reference data — the RBAC role catalogue — is required for authz to work
    // (JIT SSO provisioning assigns these role slugs). It contains no demo
    // fixtures, so it runs on EVERY deploy in EVERY environment, including real
    // production. Idempotent.
    log.info('Seeding system role catalogue...');
    await seedSystemRoles(seedUrl);

    // Tenant bootstrap — the primary workspace + Entra SSO connection. Prod-safe
    // config (no demo fixtures): required for real users to JIT-provision and for
    // PLATFORM_ADMIN_EMAILS elevation on first login. Runs in EVERY environment.
    log.info('Seeding tenant bootstrap (workspace + SSO connection)...');
    await seedTenantBootstrap(seedUrl);

    /**
     * Demo fixtures (demo users, projects, work items, teams, releases) — LOCAL AND CI ONLY.
     *
     * Two gates, not one. `SEED_ON_DEPLOY` is the switch; `NODE_ENV` is the floor.
     *
     * The switch alone was a Terraform variable nobody must ever set wrong: develop had it `true`, so a
     * deployed database people read as real was carrying a fixture project, a capacity plan and a frozen
     * report history. Copying that stanza to another environment was all it would have taken to do the
     * same to production. Deployed migrator tasks run with `NODE_ENV=production`
     * (`infra/modules/stack/main.tf`), and nothing else does — CI's ephemeral Postgres and a developer's
     * own database do not — so this refuses the demo seed on exactly the databases that must never have
     * it, whatever the switch says.
     *
     * Refused LOUDLY rather than silently skipped: a deploy that expected fixtures should say why it has
     * none, or the next person debugs an empty environment instead of reading a log line.
     */
    // The identity v8 backfill, when this environment opted in (`IDENTITY_V8_BACKFILL=commit`): after the schema, before the API rolls,
    // failing the deploy (the previous tasks keep serving) if any preflight or assertion raises. Nothing otherwise.
    await runBackfillIfRequested(pool, process.env, log);

    if (process.env['SEED_ON_DEPLOY'] === 'true') {
      if (process.env['NODE_ENV'] === 'production') {
        log.warn(
          '⚠️  SEED_ON_DEPLOY=true but NODE_ENV=production — demo seed REFUSED. ' +
            'Deployed environments run the role catalogue and tenant bootstrap only; ' +
            'fixtures are for local development (pnpm db:seed:test) and CI.',
        );
      } else {
        log.info('SEED_ON_DEPLOY=true — running demo seed...');
        await seed(seedUrl);
      }
    }
  } catch (err) {
    log.error({ err }, 'Migration failed');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void run();
