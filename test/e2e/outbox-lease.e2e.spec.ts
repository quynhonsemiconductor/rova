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
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NonRetryableError, RetryAfterError, MAX_RETRY_AFTER_MS } from '@platform/outbox';
import type { DrizzleDB, DrizzleTx } from '@platform';
import type { BackfillCounts, ScmBackfillService } from '@modules/scm';
import * as schema from '../../db/schema';
import {
  ScmBackfillRelayService,
  SCM_BACKFILL_LEASE_MS,
} from '../../apps/worker/src/scm/scm-backfill-relay.service';
import { EntraGuestInviteRelayService } from '../../apps/worker/src/identity/entra-guest-invite-relay.service';

const { scmBackfillJobs, guestInviteOutbox } = schema;

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
    .values({
      workspaceId: randomUUID(),
      repositoryId: randomUUID(),
      // Due a few seconds ago, by the TEST's clock: the column default is the DATABASE's now(), and a container
      // whose clock runs ahead of the host's would make the row "not yet due" to a relay that reads Date.now().
      scheduledAt: new Date(Date.now() - 5_000),
      ...extra,
    })
    .returning();
  return row;
}

/** A real invitation row: guest_invite_outbox.invitation_id is a foreign key (fk_gio_invitation). */
async function insertInvitation() {
  const [row] = await db
    .insert(schema.workspaceInvitations)
    .values({
      workspaceId: (
        await observer.query<{ id: string }>('SELECT id FROM workspace.workspaces LIMIT 1')
      ).rows[0].id,
      email: 'dana@partner.example',
      tokenHash: `hash-${randomUUID()}`,
      invitedBy: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
    })
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
  await observer.query('DELETE FROM messaging.guest_invite_outbox');
  // The invitation rows this file inserts (the outbox row cascades from them).
  await observer.query(
    "DELETE FROM workspace.workspace_invitations WHERE token_hash LIKE 'hash-%'",
  );
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

describe('the reaper does what markFailed does for a terminal row, against PostgreSQL', () => {
  const lapsed = () => ({
    attempts: 5,
    leaseToken: '00000000-0000-4000-8000-0000000000aa',
    lockedUntil: new Date(Date.now() - 60_000),
  });

  it('a reaped guest invitation LOSES ITS RAW BEARER TOKEN (migration 0124: no terminal row keeps a live credential)', async () => {
    const invitation = await insertInvitation();
    const [abandoned] = await db
      .insert(guestInviteOutbox)
      .values({
        invitationId: invitation.id,
        workspaceId: invitation.workspaceId,
        email: 'dana@partner.example',
        inviteToken: 'raw-bearer-token-must-not-survive',
        ...lapsed(),
      })
      .returning();
    const relay = new EntraGuestInviteRelayService(
      db,
      { invite: vi.fn() } as never,
      { get: () => 'https://rova.example' } as never,
      { schedule: vi.fn() } as never,
      { subscribeGuestInviteRelayWake: vi.fn() } as never,
    );

    await relay.relay();

    const [row] = await db
      .select()
      .from(guestInviteOutbox)
      .where(eq(guestInviteOutbox.id, abandoned.id));
    expect(row.status).toBe('failed');
    expect(row.lastError).toMatch(/abandoned/);
    expect(row.inviteToken, 'a dead-lettered row kept a live bearer credential').toBeNull();
  });

  it('a reaped backfill job gets finished_at, like one that failed through markFailed', async () => {
    const abandoned = await insertJob(lapsed());
    expect(abandoned.finishedAt).toBeNull();
    const { relay } = makeRelay(() => Promise.resolve(COUNTS));

    await relay.relay();

    const row = await load(abandoned.id);
    expect(row.status).toBe('failed');
    expect(row.finishedAt).not.toBeNull();
  });
});

/** An advisory lock key. The claim takes it in beforeSelect, so a test can hold the claim up for a known time. */
const CLAIM_LOCK_KEY = 917_341;

/** The backfill relay with its claim serialized on an advisory lock, and the lease the claim stored recorded. */
class SerializedClaimRelay extends ScmBackfillRelayService {
  claimedUntil: Date | undefined;

  protected override async beforeSelect(tx: DrizzleTx): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${CLAIM_LOCK_KEY})`);
  }

  protected override async stampLeases(
    tx: DrizzleTx,
    ids: string[],
    token: string,
    leaseMs: number,
  ): Promise<Map<string, { attempts: number; lockedUntil: Date }>> {
    const stamped = await super.stampLeases(tx, ids, token, leaseMs);
    this.claimedUntil = [...stamped.values()][0]?.lockedUntil;
    return stamped;
  }
}

describe('the lease is measured from AFTER the claim lock was acquired, against PostgreSQL', () => {
  it('a claim that waited for its lock still holds the row a full lease from the moment it got the lock', async () => {
    const job = await insertJob();
    const backfill = { run: vi.fn(() => Promise.resolve(COUNTS)) } as unknown as ScmBackfillService;
    const relay = new SerializedClaimRelay(db, backfill);
    const holder = new Client({ connectionString: process.env['DATABASE_URL'] });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1)', [CLAIM_LOCK_KEY]);
      const running = relay.relay();
      // Wait until the claim is queued behind the lock, then keep it waiting for a known time.
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await observer.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`,
        );
        if (Number(rows[0].n) > 0) break;
        await sleep(50);
      }
      await sleep(1_500);
      // The database's clock at the moment the lock is released. The claim cannot take the lock before this.
      const { rows: released } = await holder.query<{ t: Date }>('SELECT clock_timestamp() AS t');
      await holder.query('COMMIT');
      await running;

      // Counted from the claim's transaction start (now()), the 1.5 s wait would come off the hold: the lease
      // would expire ~1.5 s early. Counted from statement_timestamp(), it runs a full lease from the lock.
      const heldFromLock = relay.claimedUntil!.getTime() - released[0].t.getTime();
      expect(
        heldFromLock,
        'the lock wait came off the lease: it was counted from the transaction start, not the lock',
      ).toBeGreaterThanOrEqual(SCM_BACKFILL_LEASE_MS - 500);
      expect((await load(job.id)).status).toBe('done');
    } finally {
      await holder.end();
    }
  }, 30_000);
});

/**
 * THE DATABASE CLOCK DECIDES. Every stored timestamp the claim, lease, reaper and back-off read or write is
 * compared with, or computed from, `now()` inside the SQL statement. A test that skews the HOST clock must
 * therefore see no change in which rows are claimed, and every stamp must be the DATABASE's time.
 *
 * Host skew is faked with `vi.useFakeTimers({ toFake: ['Date'] })` only: timers stay real, so the relay's
 * own awaits are untouched, and nothing reaches the database clock. The DATABASE times are set with SQL
 * (`now() + interval ...`), never with the host's `Date.now()`.
 */
describe('the database clock decides, not the host clock (skew)', () => {
  const HOUR = 3_600_000;

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Move the HOST clock only. The database clock is untouched. */
  function skewHostBy(ms: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + ms);
  }

  /** The database's own `now()`, read from another connection. */
  async function dbNow(): Promise<Date> {
    const { rows } = await observer.query<{ t: Date }>('SELECT now() AS t');
    return rows[0].t;
  }

  /** Set a backfill job's lease and due time by DATABASE arithmetic. */
  async function setDbTimes(id: string, sets: { scheduledAt?: string; lockedUntil?: string }) {
    if (sets.scheduledAt)
      await observer.query(
        `UPDATE scm.backfill_jobs SET scheduled_at = ${sets.scheduledAt} WHERE id = $1`,
        [id],
      );
    if (sets.lockedUntil)
      await observer.query(
        `UPDATE scm.backfill_jobs SET locked_until = ${sets.lockedUntil} WHERE id = $1`,
        [id],
      );
  }

  it('host 1 h AHEAD: a row due in 5 minutes by the database is NOT claimed', async () => {
    const job = await insertJob();
    await setDbTimes(job.id, { scheduledAt: "now() + interval '5 minutes'" });
    skewHostBy(HOUR);
    const { relay, run } = makeRelay(() => Promise.resolve(COUNTS));

    await relay.relay();

    expect(run, 'the host clock made a not-yet-due row due').not.toHaveBeenCalled();
    const row = await load(job.id);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  it('host 1 h AHEAD: a live lease by the database is NOT lapsed, NOT re-claimed and NOT dead-lettered', async () => {
    const held = await insertJob({
      attempts: 5,
      leaseToken: '00000000-0000-4000-8000-0000000000b1',
    });
    await setDbTimes(held.id, { lockedUntil: "now() + interval '2 minutes'" });
    skewHostBy(HOUR);
    const { relay, run } = makeRelay(() => Promise.resolve(COUNTS));

    await relay.relay();

    expect(run).not.toHaveBeenCalled();
    const row = await load(held.id);
    expect(row.status, 'the host clock reaped a row whose database lease is live').toBe('pending');
    expect(row.lastError).toBeNull();
  });

  it('host 1 h AHEAD: a failed attempt backs off from the DATABASE clock, not the host clock', async () => {
    const job = await insertJob();
    const { relay } = makeRelay(() => Promise.reject(new Error('boom')));
    const before = await dbNow();
    skewHostBy(HOUR);

    await relay.relay();

    const after = await dbNow();
    const row = await load(job.id);
    expect(row.status).toBe('pending');
    // Attempt 1 backs off 30 s from the database's now(). Host time would land an hour late.
    expect(row.scheduledAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 25_000);
    expect(row.scheduledAt.getTime()).toBeLessThanOrEqual(after.getTime() + 35_000);
  });

  it('host 1 h AHEAD: the lease the claim and the renewal stamp expire the relay lease length after the DATABASE now()', async () => {
    const job = await insertJob();
    let leaseSecondsAhead = Number.NaN;
    const { relay } = makeRelay(async () => {
      // Read the lease from another connection while the call is in flight.
      const { rows } = await observer.query<{ s: string }>(
        'SELECT extract(epoch FROM (locked_until - now())) AS s FROM scm.backfill_jobs WHERE id = $1',
        [job.id],
      );
      leaseSecondsAhead = Number(rows[0].s);
      return COUNTS;
    });
    skewHostBy(HOUR);

    await relay.relay();

    // The lease is the relay's own length, counted from the database clock. Host time would add the hour.
    const leaseSeconds = SCM_BACKFILL_LEASE_MS / 1000;
    expect(leaseSecondsAhead, 'the lease was stamped from the host clock').toBeGreaterThan(
      leaseSeconds - 15,
    );
    expect(leaseSecondsAhead).toBeLessThan(leaseSeconds + 15);
    expect((await load(job.id)).status).toBe('done');
  });

  it('host 1 h BEHIND: a row due by the database IS claimed', async () => {
    const job = await insertJob();
    await setDbTimes(job.id, { scheduledAt: "now() - interval '1 minute'" });
    skewHostBy(-HOUR);
    const { relay, run } = makeRelay(() => Promise.resolve(COUNTS));

    await relay.relay();

    expect(run, 'the host clock hid a row the database says is due').toHaveBeenCalledTimes(1);
    expect((await load(job.id)).status).toBe('done');
  });

  it('host 1 h BEHIND: a lease lapsed by the database is re-claimed', async () => {
    const lapsed = await insertJob({
      attempts: 1,
      leaseToken: '00000000-0000-4000-8000-0000000000b2',
    });
    await setDbTimes(lapsed.id, { lockedUntil: "now() - interval '1 minute'" });
    skewHostBy(-HOUR);
    const { relay, run } = makeRelay(() => Promise.resolve(COUNTS));

    await relay.relay();

    expect(run, 'the host clock kept a lapsed database lease alive').toHaveBeenCalledTimes(1);
    expect((await load(lapsed.id)).status).toBe('done');
  });

  it('the guest-invite relay uses the same database clock for its due check', async () => {
    const invitation = await insertInvitation();
    const [row] = await db
      .insert(guestInviteOutbox)
      .values({
        invitationId: invitation.id,
        workspaceId: invitation.workspaceId,
        email: 'dana@partner.example',
        inviteToken: 'skew-token',
      })
      .returning();
    await observer.query(
      "UPDATE messaging.guest_invite_outbox SET scheduled_at = now() + interval '5 minutes' WHERE id = $1",
      [row.id],
    );
    skewHostBy(HOUR);
    const invite = vi.fn();
    const relay = new EntraGuestInviteRelayService(
      db,
      { invite } as never,
      { get: () => 'https://rova.example' } as never,
      { schedule: vi.fn() } as never,
      { subscribeGuestInviteRelayWake: vi.fn() } as never,
    );

    await relay.relay();

    expect(invite, 'the host clock made a not-yet-due invitation due').not.toHaveBeenCalled();
    const [after] = await db
      .select()
      .from(guestInviteOutbox)
      .where(eq(guestInviteOutbox.id, row.id));
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
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
