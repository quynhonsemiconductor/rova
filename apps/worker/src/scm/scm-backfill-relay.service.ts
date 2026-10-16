/**
 * ScmBackfillRelayService — drains scm.backfill_jobs and pulls each repo's
 * existing PRs/commits via the GitHub App REST API (ScmBackfillService), linking
 * the ones that reference work-item keys through the SAME idempotent path as the
 * webhook relay. Re-running (or overlapping with a live webhook) never dups.
 *
 * Extends AbstractOutboxRelay (lease-and-fence: owns polling, retry/backoff and the claim/finish
 * transactions). Backfill hits the network + rate limits, so it runs on a slower 30s cron with a small
 * batch (one repo at a time) — history is not latency-critical. The run's counts are the delivery result,
 * handed to markSent so they land in the same write that marks the job done.
 *
 * NO TRANSACTION IS OPEN DURING THE RUN. A backfill is up to ~300 GitHub calls; it used to run inside the
 * relay's transaction, and past the worker role's idle_in_transaction_session_timeout (300 s) the session was
 * killed, the attempt counter rolled back, and the job retried for ever. The run now has a hard network
 * budget (`BACKFILL_RUN_BUDGET_MS`) and the lease is derived from it.
 */
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte, sql } from 'drizzle-orm';
import { InjectDrizzle, Span } from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { AbstractOutboxRelay, LEASE_MARGIN_MS } from '@platform/outbox';
import type { Claimed, OutboxLeaseTable } from '@platform/outbox';
import { BACKFILL_RUN_BUDGET_MS, GITHUB_CALL_TIMEOUT_MS, ScmBackfillService } from '@modules/scm';
import type { BackfillCounts } from '@modules/scm';
import { scmBackfillJobs } from '../../../../db/schema/scm';

type BackfillJobRow = {
  id: string;
  attempts: number;
  repositoryId: string;
};

/** The run budget, the call in flight when it expires, and the usual margin. */
export const SCM_BACKFILL_LEASE_MS =
  BACKFILL_RUN_BUDGET_MS + GITHUB_CALL_TIMEOUT_MS + LEASE_MARGIN_MS;

@Injectable()
export class ScmBackfillRelayService extends AbstractOutboxRelay<BackfillJobRow, BackfillCounts> {
  /** One repo at a time: a run is minutes of network, and the batch is held for the sum of its leases. */
  protected override readonly batchSize = 1;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly backfill: ScmBackfillService,
  ) {
    super(db);
  }

  @Cron('*/30 * * * * *', { name: 'scm-backfill-relay' })
  @Span('scm.backfill.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  protected readonly outbox: OutboxLeaseTable = {
    table: scmBackfillJobs,
    id: scmBackfillJobs.id,
    status: scmBackfillJobs.status,
    attempts: scmBackfillJobs.attempts,
    lastError: scmBackfillJobs.lastError,
    leaseToken: scmBackfillJobs.leaseToken,
    lockedUntil: scmBackfillJobs.lockedUntil,
    seq: scmBackfillJobs.seq,
  };

  protected override leaseMsFor(): number {
    return SCM_BACKFILL_LEASE_MS;
  }

  /** A dead-lettered job has `finished_at`, like one that failed through `markFailed`; the reaper bypasses it. */
  protected override reapColumns(): Record<string, unknown> {
    return { finishedAt: sql`now()` };
  }

  protected async selectDue(tx: DrizzleTx, limit: number, now: Date): Promise<BackfillJobRow[]> {
    return tx
      .select({
        id: scmBackfillJobs.id,
        attempts: scmBackfillJobs.attempts,
        repositoryId: scmBackfillJobs.repositoryId,
      })
      .from(scmBackfillJobs)
      .where(
        and(
          eq(scmBackfillJobs.status, 'pending'),
          lt(scmBackfillJobs.attempts, this.maxAttempts),
          lte(scmBackfillJobs.scheduledAt, now),
          this.notLeased(now),
        ),
      )
      .orderBy(asc(scmBackfillJobs.scheduledAt), asc(scmBackfillJobs.seq), asc(scmBackfillJobs.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  protected async deliver(row: Claimed<BackfillJobRow>): Promise<BackfillCounts> {
    return this.backfill.run(row.repositoryId, {
      signal: AbortSignal.timeout(BACKFILL_RUN_BUDGET_MS),
    });
  }

  protected async markSent(
    tx: DrizzleTx,
    row: Claimed<BackfillJobRow>,
    counts: BackfillCounts,
  ): Promise<void> {
    await tx
      .update(scmBackfillJobs)
      .set({ status: 'done', counts, finishedAt: new Date() })
      .where(eq(scmBackfillJobs.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<BackfillJobRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    // `attempts` was spent at claim time.
    await tx
      .update(scmBackfillJobs)
      .set({
        status: newStatus,
        lastError,
        ...(newStatus === 'failed' ? { finishedAt: new Date() } : {}),
        ...(newStatus === 'pending' ? { scheduledAt: nextAttemptAt } : {}),
      })
      .where(eq(scmBackfillJobs.id, row.id));
  }
}
