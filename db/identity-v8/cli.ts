/**
 * pnpm db:identity-v8:backfill  --tenant-id <ENTRA_TENANT_ID> --staff-domains qnsc.vn [--commit --database <name>]
 * pnpm db:identity-v8:rollback  [--allow-data-loss]
 *
 * See backfill.sql and rollback.sql. Neither runs as part of `pnpm db:migrate`.
 */
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — deployed mode */
}

import { Client } from 'pg';
import { resolveMigrationPoolConfig } from '../pg-pool-config';
import { log } from '../script-log';
import { runBackfill, runRollback } from './run';

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== 'backfill' && command !== 'rollback') {
    process.stderr.write(
      'usage: cli.ts backfill --tenant-id <id> --staff-domains <a,b> [--commit] | rollback [--allow-data-loss]\n',
    );
    process.exit(2);
  }
  const client = new Client(resolveMigrationPoolConfig());
  await client.connect();
  try {
    if (command === 'rollback') {
      await runRollback(client, { allowDataLoss: flag('allow-data-loss') });
      log.info(
        'identity v8 tables dropped and migration 0136 forgotten; the v7 tables were not touched',
      );
      return;
    }
    const tenantId = option('tenant-id') ?? process.env['ENTRA_TENANT_ID'] ?? '';
    const staffDomains = (option('staff-domains') ?? '').split(',');
    const commit = flag('commit');
    const summary = await runBackfill(client, {
      tenantId,
      staffDomains,
      commit,
      database: option('database'),
    });
    for (const [what, n] of Object.entries(summary))
      process.stdout.write(`${String(n).padStart(8)}  ${what}\n`);
    log.info(
      commit
        ? 'identity v8 backfill COMMITTED: every preflight check and assertion passed'
        : 'identity v8 backfill DRY RUN: every preflight check and assertion passed; nothing was written (pass --commit)',
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  log.error({ err }, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
