/**
 * ScmWebhookRelayService — drains scm.webhook_inbox and links PRs/commits to
 * work items via ScmLinkerService.
 *
 * Extends AbstractOutboxRelay (lease-and-fence: a short claim transaction, the work with no
 * transaction open, a fenced finish; it owns the polling loop, concurrency guard and retry/backoff). This class provides only
 * the SCM-specific behaviour: what to SELECT, how to process a row, and how to
 * mark it. Linking is idempotent (unique constraints), so retries/redelivery
 * never duplicate. The 5s cron is the delivery mechanism (no wake signal —
 * SCM connections are not latency-critical).
 */
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte } from 'drizzle-orm';
import { InjectDrizzle, Span } from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { AbstractOutboxRelay } from '@platform/outbox';
import type { Claimed, OutboxLeaseTable } from '@platform/outbox';
import { ScmLinkerService, ScmInstallationService } from '@modules/scm';
import type { ScmProvider } from '@modules/scm';
import { scmWebhookInbox } from '../../../../db/schema/scm';

// Management events drive org-level auto-discovery (register/deregister repos),
// not artifact linking — routed to ScmInstallationService instead of the linker.
const MANAGEMENT_EVENTS = new Set(['installation', 'installation_repositories', 'repository']);

type ScmInboxRow = {
  id: string;
  attempts: number;
  provider: string;
  eventType: string;
  payload: unknown;
};

/**
 * Linking is database work. The slowest event is an `installation` that registers every repository of an
 * organisation (two statements each), so the lease is generous for a database call and still short enough
 * that `batchSize × lease` stays well inside the 15-minute strand bound.
 */
const SCM_WEBHOOK_LEASE_MS = 60_000;

@Injectable()
export class ScmWebhookRelayService extends AbstractOutboxRelay<ScmInboxRow> {
  /** Held for the SUM of the batch's leases (60 s each): 10 rows is 10 minutes if a worker dies. */
  protected override readonly batchSize = 10;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly linker: ScmLinkerService,
    private readonly installations: ScmInstallationService,
  ) {
    super(db);
  }

  @Cron('*/5 * * * * *', { name: 'scm-webhook-relay' })
  @Span('scm.webhook.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  protected readonly outbox: OutboxLeaseTable = {
    table: scmWebhookInbox,
    id: scmWebhookInbox.id,
    status: scmWebhookInbox.status,
    attempts: scmWebhookInbox.attempts,
    lastError: scmWebhookInbox.lastError,
    leaseToken: scmWebhookInbox.leaseToken,
    lockedUntil: scmWebhookInbox.lockedUntil,
    seq: scmWebhookInbox.seq,
  };

  protected override leaseMsFor(): number {
    return SCM_WEBHOOK_LEASE_MS;
  }

  protected async selectDue(tx: DrizzleTx, limit: number, now: Date): Promise<ScmInboxRow[]> {
    return tx
      .select({
        id: scmWebhookInbox.id,
        attempts: scmWebhookInbox.attempts,
        provider: scmWebhookInbox.provider,
        eventType: scmWebhookInbox.eventType,
        payload: scmWebhookInbox.payload,
      })
      .from(scmWebhookInbox)
      .where(
        and(
          eq(scmWebhookInbox.status, 'pending'),
          lt(scmWebhookInbox.attempts, this.maxAttempts),
          lte(scmWebhookInbox.scheduledAt, now),
          this.notLeased(now),
        ),
      )
      .orderBy(asc(scmWebhookInbox.scheduledAt), asc(scmWebhookInbox.seq), asc(scmWebhookInbox.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  protected async deliver(row: Claimed<ScmInboxRow>): Promise<void> {
    // Both 'processed' and 'ignored' (unmapped repo / no keys) mean "handled";
    // markSent records completion. Idempotent upserts (linker) + upsert/dedup
    // (installation) make a retry after a mid-batch failure a safe no-op.
    if (MANAGEMENT_EVENTS.has(row.eventType)) {
      await this.installations.handleWebhook(row.eventType, row.payload);
      return;
    }
    await this.linker.linkEvent(row.provider as ScmProvider, row.eventType, row.payload);
  }

  protected async markSent(tx: DrizzleTx, row: Claimed<ScmInboxRow>): Promise<void> {
    await tx
      .update(scmWebhookInbox)
      .set({ status: 'processed', processedAt: new Date() })
      .where(eq(scmWebhookInbox.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<ScmInboxRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    // `attempts` was spent at claim time.
    await tx
      .update(scmWebhookInbox)
      .set({
        status: newStatus,
        lastError,
        ...(newStatus === 'pending' ? { scheduledAt: nextAttemptAt } : {}),
      })
      .where(eq(scmWebhookInbox.id, row.id));
  }
}
