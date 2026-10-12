/**
 * The lease-and-fence relay against a REAL PostgreSQL, using the SCM backfill relay as the vehicle.
 *
 * The unit spec (libs/platform/src/outbox/abstract-outbox-relay.spec.ts) tests the loop with the SQL steps
 * replaced. These are the assertions only a database can make:
 *
 *   - THE REGRESSION: a relay call that outlasts `idle_in_transaction_session_timeout` no longer kills the
 *     session. The worker role has that timeout at 300 s (migration 0073); the old relay held ONE transaction
 *     across every external call, so a slow batch had its session killed, rolling back the rows AND their
 *     attempt counters — the row was retried for ever and never dead-lettered. Here the timeout is 1.5 s and
 *     the call takes 3.5 s.
 *   - NO SESSION IS "idle in transaction" while the external call runs;
 *   - the claim spends the attempt in SQL, a lapsed lease with every attempt used is dead-lettered, and a live
 *     lease hides the row;
 *   - the fence: a relay that lost its lease writes nothing;
 *   - two relays claiming at once never both take a row;
 *   - migration 0135 put the lease columns on all six tables the relays drain.
 *
 * Prereqs: a PostgreSQL with `pnpm db:migrate` applied (migration 0135), DATABASE_URL set.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NonRetryableError, RetryAfterError, MAX_RETRY_AFTER_MS } from '@platform/outbox';
import type { DrizzleDB } from '@platform';
import type { BackfillCounts, ScmBackfillService } from '@modules/scm';
import * as schema from '../../db/schema';
import { ScmBackfillRelayService } from '../../apps/worker/src/scm/scm-backfill-relay.service';

const { scmBackfillJobs } = schema;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const COUNTS: BackfillCounts = { prs: 1, commits: 2, connections: 3, changesets: 4 };

let pool: Pool;
let observer: Pool;
let db: DrizzleDB;

/** A relay over a fake backfill service whose `run` is whatever the test says. */
function makeRelay(
  run: (repositoryId: string, opts?: { signal?: AbortSignal }) => Promise<BackfillCounts>,
) {
  const backfill = { run: vi.fn(run) } as unknown as ScmBackfillService & {
    run: ReturnType<typeof vi.fn>;
  };
  return { relay: new ScmBackfillRelayService(db, backfill), run: backfill.run };
}

async function insertJob(extra: Partial<typeof scmBackfillJobs.$inferInsert> = {}) {
  const [row] = await db
    .insert(scmBackfillJobs)
    .values({ workspaceId: randomUUID(), repositoryId: randomUUID(), ...extra })
    .returning();
  return row;
}

const load = async (id: string) =>
  (await db.select().from(scmBackfillJobs).where(eq(scmBackfillJobs.id, id)))[0];

beforeAll(() => {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  // The relay's own connections carry a SHORT idle-in-transaction timeout, standing in for the worker role's
  // 300 s: the production failure needs a call longer than the timeout, and 300 s is too long for a test.
  pool = new Pool({
    connectionString: url,
    max: 4,
    options: '-c idle_in_transaction_session_timeout=1500',
  });
  observer = new Pool({ connectionString: url, max: 1 });
  db = drizzle(pool, { schema });
});
afterAll(async () => {
  await pool?.end();
  await observer?.end();
});
beforeEach(async () => {
  await observer.query('DELETE FROM scm.backfill_jobs');
});

describe('THE REGRESSION: a slow external call no longer loses the row', () => {
  it('survives a call longer than idle_in_transaction_session_timeout, counts the attempt, and finishes', async () => {
    const job = await insertJob();
    const { relay } = makeRelay(async () => {
      await sleep(3_500); // > the 1.5 s timeout the relay's connections carry
      return COUNTS;
    });

    await relay.relay();

    const row = await load(job.id);
    // The old relay held a transaction across the call: its session was killed here, the status write and
    // the attempt counter rolled back, and the row stayed `pending` with attempts = 0, to be retried for ever.
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
    expect(row.counts).toEqual(COUNTS);
    expect(row.leaseToken).toBeNull();
  }, 20_000);

  it('holds NO transaction open while the external call runs', async () => {
    const job = await insertJob();
    let idleInTransaction = -1;
    const { relay } = makeRelay(async () => {
      // Look from a different connection while the call is in flight.
      const { rows } = await observer.query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
            AND state IN ('idle in transaction', 'idle in transaction (aborted)')`,
      );
      idleInTransaction = Number(rows[0].n);
      await sleep(250);
      return COUNTS;
    });

    await relay.relay();

    expect(idleInTransaction, 'a session sat idle in transaction across the GitHub call').toBe(0);
    expect((await load(job.id)).status).toBe('done');
  });
});

describe('lease-and-fence relay, against PostgreSQL', () => {
  it('spends the attempt at claim, so a failure is recorded with the attempt counted', async () => {
    const job = await insertJob();
    const { relay } = makeRelay(() => Promise.reject(new Error('boom')));
    const before = Date.now();

    await relay.relay();

    const row = await load(job.id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('boom');
    // Backed off ~30 s, and the lease is released so the retry can be claimed when due.
    expect(row.scheduledAt.getTime()).toBeGreaterThan(before + 25_000);
    expect(row.leaseToken).toBeNull();
    expect(row.lockedUntil).toBeNull();
  });

  it('dead-letters at once on a NonRetryableError (a refusal that will not heal)', async () => {
    const job = await insertJob();
    const { relay } = makeRelay(() => Promise.reject(new NonRetryableError('403 Forbidden')));

    await relay.relay();

    const row = await load(job.id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/403/);
    expect(row.finishedAt).not.toBeNull();
  });

  it('dead-letters when the attempts are spent, not before', async () => {
    const job = await insertJob({ attempts: 4 });
    const { relay } = makeRelay(() => Promise.reject(new Error('still down')));

    await relay.relay();

    const row = await load(job.id);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(5);
  });

  it('clamps a hostile Retry-After instead of parking the row for ever or throwing', async () => {
    const job = await insertJob();
    const { relay } = makeRelay(() => Promise.reject(new RetryAfterError('throttled', 1e13)));
    const before = Date.now();

    await relay.relay();

    const row = await load(job.id);
    expect(row.status).toBe('pending');
    expect(row.scheduledAt.getTime()).toBeLessThanOrEqual(before + MAX_RETRY_AFTER_MS + 5_000);
    expect(row.scheduledAt.getTime()).toBeGreaterThan(before + MAX_RETRY_AFTER_MS - 5_000);
  });

  it('dead-letters a row whose lease lapsed with every attempt used (the process died mid-call)', async () => {
    const abandoned = await insertJob({
      attempts: 5,
      leaseToken: '00000000-0000-4000-8000-000000000001',
      lockedUntil: new Date(Date.now() - 60_000),
    });
    const { relay, run } = makeRelay(() => Promise.resolve(COUNTS));

    await relay.relay();

    const row = await load(abandoned.id);
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/abandoned/);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not touch a row whose lease is still live', async () => {
    const held = await insertJob({
      attempts: 1,
      leaseToken: '00000000-0000-4000-8000-000000000002',
      lockedUntil: new Date(Date.now() + 5 * 60_000),
    });
    const { relay, run } = makeRelay(() => Promise.resolve(COUNTS));

    await relay.relay();

    expect(run).not.toHaveBeenCalled();
    expect((await load(held.id)).status).toBe('pending');
  });

  it('re-claims a row whose lease lapsed with attempts left', async () => {
    const lapsed = await insertJob({
      attempts: 1,
      leaseToken: '00000000-0000-4000-8000-000000000003',
      lockedUntil: new Date(Date.now() - 1_000),
    });
    const { relay, run } = makeRelay(() => Promise.resolve(COUNTS));

    await relay.relay();

    expect(run).toHaveBeenCalledWith(lapsed.repositoryId, expect.anything());
    const row = await load(lapsed.id);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(2);
  });

  it('THE FENCE: a relay that lost its lease mid-call writes nothing', async () => {
    const job = await insertJob();
    const takeover = '00000000-0000-4000-8000-0000000000ff';
    const { relay } = makeRelay(async () => {
      // Another relay claims the row while this one is still calling out.
      await observer.query('UPDATE scm.backfill_jobs SET lease_token = $1 WHERE id = $2', [
        takeover,
        job.id,
      ]);
      return COUNTS;
    });

    await relay.relay();

    const row = await load(job.id);
    expect(row.status, 'a relay that lost its lease overwrote the new holder').toBe('pending');
    expect(row.leaseToken).toBe(takeover);
    expect(row.finishedAt).toBeNull();
  });

  it('hands the run a deadline: the backfill gets an AbortSignal that is not yet aborted', async () => {
    await insertJob();
    let seen: AbortSignal | undefined;
    const { relay } = makeRelay((_repo, opts) => {
      seen = opts?.signal;
      return Promise.resolve(COUNTS);
    });

    await relay.relay();

    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen!.aborted).toBe(false);
  });

  it('two relays claiming at the same instant never both take the row', async () => {
    const job = await insertJob();
    const a = makeRelay(async () => {
      await sleep(300);
      return COUNTS;
    });
    const b = makeRelay(async () => {
      await sleep(300);
      return COUNTS;
    });

    await Promise.all([a.relay.relay(), b.relay.relay()]);

    expect(a.run.mock.calls.length + b.run.mock.calls.length).toBe(1);
    const row = await load(job.id);
    expect(row.status).toBe('done');
    expect(row.attempts).toBe(1);
  });
});

describe('migration 0135, against PostgreSQL', () => {
  it.each([
    ['messaging', 'outbox_events'],
    ['messaging', 'email_outbox'],
    ['messaging', 'notification_outbox'],
    ['messaging', 'guest_invite_outbox'],
    ['scm', 'webhook_inbox'],
    ['scm', 'backfill_jobs'],
  ])('%s.%s has seq, lease_token and locked_until', async (schemaName, table) => {
    const { rows } = await observer.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
          AND column_name IN ('seq', 'lease_token', 'locked_until')`,
      [schemaName, table],
    );
    expect(rows.map((r) => r.column_name).sort()).toEqual(['lease_token', 'locked_until', 'seq']);
  });
});
