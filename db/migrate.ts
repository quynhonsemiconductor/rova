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
import { resolveDatabaseUrl } from './database-url';
import { resolveAuthMode, resolveIamUrl, resolveMigrationPoolConfig } from './pg-pool-config';

// Resolves DATABASE_MIGRATION_URL, else DATABASE_URL, else composes from the
// DATABASE_* parts (the deployed path — credentials come straight from the
// RDS-managed secret, never a hand-maintained copy). Throws with a precise
// message listing what is missing.
// UNDER DATABASE_AUTH=iam THIS CARRIES NO PASSWORD. `resolveMigrationPoolConfig`
// returns `password` as a FUNCTION that pg calls per connection, so a migration that
// outlives a 15-minute token still reconnects successfully. The role is
// `<product>_migrator`, set by the chart — never the application role, whose 30s
// statement_timeout would kill the 600s migration this file exists to run.
let poolConfig: ReturnType<typeof resolveMigrationPoolConfig>;
try {
  poolConfig = resolveMigrationPoolConfig();
} catch (err) {
  console.error(`❌  ${(err as Error).message}`);
  process.exit(1);
}

const pool = new Pool({ ...poolConfig, max: 1 });

/** The pre-IAM fallback: whatever string the migration connection was built from. */
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
 * WARNS, NEVER FAILS, and that is a deliberate retreat from the first version. Both signals above are
 * ambiguous from here, and a hard failure on either broke `pnpm db:migrate` on a real developer
 * database for five files whose objects plainly existed. A gate that cries wolf gets bypassed, and a
 * bypassed gate protects nothing — whereas a named file and a specific question ("do its objects
 * exist?") is exactly what the silent success failed to give anyone. Proving it properly means
 * diffing the live schema against the migrations, which is a different tool and a different change.
 *
 * Hashes are compared rather than counted: a count matches by coincidence whenever an abandoned branch
 * row occupies a real one's slot, which is precisely the case that produced the incident and precisely
 * the one a count cannot see. Drizzle hashes the file's raw text.
 *
 * It REPORTS; it never repairs. Applying a stranded file out of order is a decision about a database
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
  // `created_at` is a bigint column, so the driver hands it back as a string.
  const hashByWhen = new Map(recorded.rows.map((r) => [String(r.created_at), r.hash]));

  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const entry of journal.entries) {
    const file = path.join(folder, `${entry.tag}.sql`);
    if (!fs.existsSync(file)) continue;
    const recordedHash = hashByWhen.get(String(entry.when));
    if (recordedHash === undefined) {
      missing.push(`${entry.tag} (when=${entry.when})`);
      continue;
    }
    const hash = createHash('sha256').update(fs.readFileSync(file, 'utf8')).digest('hex');
    if (hash !== recordedHash) mismatched.push(`${entry.tag} (when=${entry.when})`);
  }

  if (mismatched.length > 0) {
    console.warn(
      `⚠️   ${mismatched.length} migration(s) recorded with a DIFFERENT hash than the file on disk: ` +
        `${mismatched.join(', ')}. Either the file was edited after it ran (harmless), or its ` +
        'timestamp slot belongs to another file and this one never ran — check that the objects it ' +
        'creates actually exist before trusting this database.',
    );
  }
  if (missing.length > 0) {
    console.warn(
      `⚠️   ${missing.length} migration(s) in the journal have NO recorded row at their own ` +
        `timestamp: ${missing.join(', ')}. Drizzle applies only entries past the newest recorded ` +
        '`when`, so a non-ascending or duplicated timestamp strands a file while the run still ' +
        'reports success — check that the objects each one creates exist, and recreate the database ' +
        'or apply the file by hand if they do not.',
    );
  }
}

async function run() {
  try {
    console.log('Running migrations...');
    const migrationsFolder = path.join(__dirname, 'migrations');
    await migrate(db, { migrationsFolder });
    // Before the seeds, so a stranded schema change is named ahead of the failure it would otherwise
    // cause against a table that was never created.
    await assertNoStrandedMigrations(migrationsFolder);
    console.log('✅  Migrations applied');

    // Seed uses the app connection, not the migration URL (admin role).
    // Falls back to the migration URL when no separate app credential is set.
    // The seed helpers take a connection STRING and build their own pool, so this is
    // the one place a URL is still required. Under IAM that means minting a token and
    // embedding it — safe here because seeding is seconds, not hours, and this is
    // inside the async flow so it can await. See resolveIamUrl's warning about pools.
    //
    // Under IAM the migrator cannot mint a token for the APPLICATION role — its IRSA
    // identity is scoped to its own — so it seeds as itself. That is correct rather
    // than a compromise: the migrator already holds the DDL rights seeding needs.
    const seedUrl = await (async () => {
      if (resolveAuthMode() === 'iam') return resolveIamUrl();
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
    console.log('Seeding system role catalogue...');
    await seedSystemRoles(seedUrl);

    // Tenant bootstrap — the primary workspace + Entra SSO connection. Prod-safe
    // config (no demo fixtures): required for real users to JIT-provision and for
    // PLATFORM_ADMIN_EMAILS elevation on first login. Runs in EVERY environment.
    console.log('Seeding tenant bootstrap (workspace + SSO connection)...');
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
    if (process.env['SEED_ON_DEPLOY'] === 'true') {
      if (process.env['NODE_ENV'] === 'production') {
        console.warn(
          '⚠️  SEED_ON_DEPLOY=true but NODE_ENV=production — demo seed REFUSED. ' +
            'Deployed environments run the role catalogue and tenant bootstrap only; ' +
            'fixtures are for local development (pnpm db:seed:test) and CI.',
        );
      } else {
        console.log('SEED_ON_DEPLOY=true — running demo seed...');
        await seed(seedUrl);
      }
    }
  } catch (err) {
    console.error('❌  Migration failed', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void run();
