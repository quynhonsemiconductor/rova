import { runBackfill, type BackfillSummary, type Queryable } from './run';

/** The one thing it needs from a pool: a client, to be released. */
export interface ClientPool {
  connect(): Promise<Queryable & { release(): void }>;
}

export const BACKFILL_ON_DEPLOY_ENV = 'IDENTITY_V8_BACKFILL';

/**
 * The identity v8 backfill, committed by the migrator as part of a deploy, when (and only when) the environment opts in.
 *
 * WHY HERE. The release path (`quynhonsemiconductor/ci` `backend-deploy.yml`) runs the migrator and only then rolls the API, and a
 * migrator that exits non-zero stops the deploy while the previous (v7) tasks keep serving. That is exactly the slot the production
 * cutover needs: after the schema, before the v8 API, failing closed. Prod's migrator image only ever comes from a release tag, so
 * the backfill cannot be run from a "pre-cutover" image there; the cutover tag's own migrator runs it.
 *
 * OPT-IN PER ENVIRONMENT: `IDENTITY_V8_BACKFILL=commit` on the migrator task definition (Terraform `identity_v8_backfill_on_deploy`,
 * default false, set true only by the production cutover change; develop runs the backfill by hand). Any other value, or none, does
 * nothing. It is idempotent, so a deploy that runs it twice is fine; once the cutover has landed the flag goes back to false, because
 * every later deploy would otherwise re-run the preflight against live data and could be failed by it.
 *
 * Inputs come from what the migrator already has: `ENTRA_TENANT_ID` (required) and `SSO_ALLOWED_EMAIL_DOMAINS` (default `qnsc.vn`).
 * `--database` safety is satisfied by reading the name from the same connection: there is no operator typing it here.
 * Throws on any preflight RAISE or assertion; the caller must let that fail the migrator.
 */
export async function runBackfillIfRequested(
  pool: ClientPool,
  env: Record<string, string | undefined>,
  log: { info(message: string): void } = { info: () => undefined },
): Promise<BackfillSummary | null> {
  const mode = env[BACKFILL_ON_DEPLOY_ENV];
  if (mode === undefined || mode === '') return null;
  if (mode !== 'commit') {
    throw new Error(`${BACKFILL_ON_DEPLOY_ENV} must be "commit" or unset, got "${mode}"`);
  }
  const tenantId = env['ENTRA_TENANT_ID'] ?? '';
  const staffDomains = (env['SSO_ALLOWED_EMAIL_DOMAINS'] ?? 'qnsc.vn').split(',');
  log.info('Running the identity v8 backfill (IDENTITY_V8_BACKFILL=commit)...');
  const client = await pool.connect();
  try {
    const database = (
      (await client.query('select current_database() as d')) as { rows: Array<{ d: string }> }
    ).rows[0].d;
    const summary = await runBackfill(client, { tenantId, staffDomains, commit: true, database });
    log.info(
      `identity v8 backfill COMMITTED: ${Object.entries(summary)
        .map(([what, n]) => `${n} ${what}`)
        .join('; ')}`,
    );
    return summary;
  } finally {
    client.release();
  }
}
