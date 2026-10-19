/**
 * Runs the identity v8 SQL files (`backfill.sql`, `rollback.sql`) in ONE transaction each, with the settings they read.
 * Exported for the tests and driven by `cli.ts`. Both go through the MIGRATION role: they write `identity."user"` /
 * `identity.account` or drop tables, which the application roles must not do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Anything with `query`: a `pg.Client`, a `PoolClient`. The caller owns the connection. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

const sqlFile = (name: string): string => readFileSync(join(__dirname, name), 'utf8');

export interface BackfillOptions {
  /** The home Entra tenant (ENTRA_TENANT_ID). */
  tenantId: string;
  /** Staff email domains, each matched exactly (`qnsc.vn`). */
  staffDomains: string[];
  /** Persist. Default false: do everything, check everything, then roll back. */
  commit?: boolean;
  /**
   * With `commit`, REQUIRED and must equal the database the connection is on. A write to the wrong database is the one mistake a
   * dry run cannot catch, so the operator has to say which one they mean.
   */
  database?: string | undefined;
}

export type BackfillSummary = Record<string, number>;

/**
 * Runs `backfill.sql`. Rejects with the database's own message (every assertion names ids and counts, never an
 * address) and leaves nothing behind: the transaction is rolled back. Returns the summary the SQL ends with.
 */
export async function runBackfill(
  client: Queryable,
  options: BackfillOptions,
): Promise<BackfillSummary> {
  const domains = options.staffDomains.map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (!options.tenantId.trim()) throw new Error('identity v8 backfill: tenantId is required');
  if (domains.length === 0)
    throw new Error('identity v8 backfill: at least one staff domain is required');
  if (domains.some((d) => !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(d))) {
    throw new Error('identity v8 backfill: a staff domain is not a domain name');
  }
  if (options.commit) {
    const actual = (
      (await client.query('select current_database() as d')) as { rows: Array<{ d: string }> }
    ).rows[0].d;
    if (options.database !== actual) {
      throw new Error(
        `identity v8 backfill: --commit needs --database ${actual} (the database this connection is on); got ${options.database ?? 'nothing'}`,
      );
    }
  }
  // One snapshot for the preflight, the writes and the assertions: a v7 write landing between them must not be seen by some and not others.
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  try {
    await client.query(
      "SELECT set_config('rova.v8_tenant_id', $1, true), set_config('rova.v8_staff_domains', $2, true)",
      [options.tenantId.trim(), domains.join(',')],
    );
    const results = (await client.query(sqlFile('backfill.sql'))) as Array<{
      rows: Array<{ what: string; n: number }>;
    }>;
    const summary: BackfillSummary = {};
    for (const row of results[results.length - 1]?.rows ?? []) summary[row.what] = Number(row.n);
    await client.query(options.commit ? 'COMMIT' : 'ROLLBACK');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export interface RollbackOptions {
  /** Drop the v8 tables even if they hold rows (they are rebuildable from the v7 tables). */
  allowDataLoss?: boolean;
}

/** Runs `rollback.sql`: drops exactly the tables migration 0136 created and forgets that it ran. One transaction. */
export async function runRollback(client: Queryable, options: RollbackOptions = {}): Promise<void> {
  await client.query('BEGIN');
  try {
    if (options.allowDataLoss)
      await client.query("SELECT set_config('rova.allow_drop_identity_v8', 'yes', true)");
    await client.query(sqlFile('rollback.sql'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export interface MirrorBansOptions {
  /** Persist. Default false: do it, count it, then roll back. */
  commit?: boolean;
  /** With `commit`, REQUIRED and must equal the database the connection is on (as for the backfill). */
  database?: string | undefined;
}

/**
 * Runs `mirror-bans.sql`: marks `suspended` in v7's `identity.users.status` everyone banned in identity 8, so that a rollback to the
 * v7 image does not reinstate them. Returns the summary the SQL ends with.
 */
export async function runMirrorBans(
  client: Queryable,
  options: MirrorBansOptions = {},
): Promise<BackfillSummary> {
  if (options.commit) {
    const actual = (
      (await client.query('select current_database() as d')) as { rows: Array<{ d: string }> }
    ).rows[0].d;
    if (options.database !== actual) {
      throw new Error(
        `identity v8 mirror-bans: --commit needs --database ${actual} (the database this connection is on); got ${options.database ?? 'nothing'}`,
      );
    }
  }
  await client.query('BEGIN');
  try {
    // One statement answers with a single result, several with a list: the LAST one is the summary either way.
    const answer = (await client.query(sqlFile('mirror-bans.sql'))) as
      | { rows: Array<{ what: string; n: number }> }
      | Array<{ rows: Array<{ what: string; n: number }> }>;
    const results = Array.isArray(answer) ? answer : [answer];
    const summary: BackfillSummary = {};
    for (const row of results[results.length - 1]?.rows ?? []) summary[row.what] = Number(row.n);
    await client.query(options.commit ? 'COMMIT' : 'ROLLBACK');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
