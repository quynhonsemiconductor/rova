/**
 * Local dev helper: TRUNCATE every data table (all schemas) except the drizzle
 * migration bookkeeping, so `db:migrate` stays a no-op and `db:seed` runs onto
 * an empty database. Guards against non-local hosts.
 */
try {
  process.loadEnvFile('.env');
} catch {
  /* CI mode */
}

import { Pool } from 'pg';
import { resolveMigrationUrl } from './database-url';
import { pgOptions } from './pg-ssl';
import { log } from './script-log';

const url = resolveMigrationUrl();
const host = new URL(url).hostname;
if (!['localhost', '127.0.0.1'].includes(host)) {
  log.error(`Refusing to truncate non-local host: ${host}`);
  process.exit(1);
}

const pool = new Pool({ ...pgOptions(url), max: 1 });

async function run() {
  const { rows } = await pool.query<{ fq: string }>(`
    select format('%I.%I', schemaname, tablename) as fq
    from pg_tables
    where schemaname not in ('pg_catalog', 'information_schema', 'drizzle')
  `);
  if (rows.length === 0) {
    log.info('No tables to truncate.');
    return;
  }
  const list = rows.map((r) => r.fq).join(', ');
  log.info(`Truncating ${rows.length} tables...`);
  await pool.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  log.info('✅  All data tables truncated.');
}

run()
  .catch((e) => {
    log.error({ err: e }, 'Truncate failed');
    process.exit(1);
  })
  .finally(() => pool.end());
