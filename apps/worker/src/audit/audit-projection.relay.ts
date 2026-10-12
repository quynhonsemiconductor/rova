/**
 * AuditProjectionRelay — polls `messaging.outbox_events` and projects each domain
 * event into an `audit.audit_logs` row.
 *
 * Extends AbstractOutboxRelay (lease-and-fence), which owns the polling loop, the coalescing guard,
 * the claim and finish transactions, backoff and dead-letter logging. This class provides
 * only the projection: what to SELECT, how to map an event onto an audit row, and
 * how to mark rows.
 *
 * WHY THIS IS NO LONGER SNS → SQS
 * -------------------------------
 * This relay used to publish to an SNS topic that fanned out to four SQS queues,
 * and a worker `AuditConsumer` long-polled the audit queue to write the same row.
 * That pipeline was broken in every deployed environment, in three independent
 * ways, and no metric or alarm showed it:
 *
 *   1. Only ONE subscription existed (domain-events → notifications). The audit
 *      queue was never subscribed, so the consumer polled an empty queue forever.
 *   2. That subscription filtered on `eventType ∈ {notification.created,
 *      notification.updated}` — values this codebase never emits. Measured on
 *      develop: 12 published, 12 FilteredOut, 0 delivered, 0 failed.
 *   3. The messaging module set no `raw_message_delivery`, so SQS would have
 *      delivered the SNS envelope while the consumer parsed it as the bare event,
 *      reading `undefined` for every field.
 *
 * Local dev worked, which is what kept it hidden: `scripts/localstack/01-bootstrap.sh`
 * subscribed all four queues, unfiltered, with raw delivery on. It was more generous
 * than the Terraform, so dev could not reproduce prod.
 *
 * A DB-to-DB projection removes all three failure modes instead of fixing them one
 * at a time: no filter policy to mismatch, no delivery mode to disagree about, and
 * no local topology that can drift from the deployed one. The transactional outbox
 * already provided the durability the queue was adding.
 *
 * If a genuine second consumer appears (a cross-product subscriber, a search
 * indexer), reintroduce the topic THEN — with an end-to-end test that runs against
 * the deployed topology rather than a hand-written local approximation.
 *
 * Delivery guarantee: at-least-once, made idempotent by `sourceEventId` and the
 * `uq_audit_source_event_id` unique index, so a redelivered row is a no-op.
 */
import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { InjectDrizzle, Span } from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { AbstractOutboxRelay } from '@platform/outbox';
import type { Claimed, OutboxLeaseTable } from '@platform/outbox';
import { AUDIT_REPOSITORY, type IAuditRepository } from '@modules/audit';
import { outboxEvents } from '../../../../db/schema/messaging';

type OutboxEventRow = {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  workspaceId: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
  traceparent: string | null;
};

/** The fields AuditProducer puts in an event payload — see `AuditEvent`. */
type AuditEventPayload = {
  actorId?: string;
  projectId?: string;
  changes?: { before?: unknown; after?: unknown };
};

/** A projection is one indexed insert: the lease only has to cover waiting behind earlier rows of the batch. */
const AUDIT_LEASE_MS = 30_000;

@Injectable()
export class AuditProjectionRelay extends AbstractOutboxRelay<OutboxEventRow> {
  /** Held for the SUM of the batch's leases (30 s each): 20 rows is 10 minutes if a worker dies. */
  protected override readonly batchSize = 20;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    /**
     * The REPOSITORY, deliberately — not AuditService.
     *
     * `AuditService.record()` catches and logs every error ("Audit must never crash
     * the caller"), which is right for a request-path caller and wrong here. A relay
     * needs the throw: it is how a failed write becomes a retry and then a
     * dead-lettered row. Routed through the service, a failed insert would return
     * normally, the row would be marked `published`, and the event would be lost
     * silently — the same class of bug this change exists to remove.
     *
     * The old AuditConsumer had exactly that defect from the other side: it kept the
     * SQS message only inside a `catch`, and no error could ever reach it.
     */
    @Inject(AUDIT_REPOSITORY) private readonly auditRepo: IAuditRepository,
  ) {
    super(db);
  }

  /** Runs every 5 seconds. */
  @Cron('*/5 * * * * *', { name: 'audit-projection' })
  @Span('audit.projection')
  override async relay(): Promise<void> {
    return super.relay();
  }

  // ── AbstractOutboxRelay implementation ────────────────────────────────────

  protected readonly outbox: OutboxLeaseTable = {
    table: outboxEvents,
    id: outboxEvents.id,
    status: outboxEvents.status,
    attempts: outboxEvents.attempts,
    lastError: outboxEvents.lastError,
    leaseToken: outboxEvents.leaseToken,
    lockedUntil: outboxEvents.lockedUntil,
    seq: outboxEvents.seq,
  };

  protected override leaseMsFor(): number {
    return AUDIT_LEASE_MS;
  }

  protected async selectDue(tx: DrizzleTx, limit: number, now: Date): Promise<OutboxEventRow[]> {
    return tx
      .select({
        id: outboxEvents.id,
        eventType: outboxEvents.eventType,
        aggregateType: outboxEvents.aggregateType,
        aggregateId: outboxEvents.aggregateId,
        workspaceId: outboxEvents.workspaceId,
        payload: outboxEvents.payload,
        occurredAt: outboxEvents.occurredAt,
        attempts: outboxEvents.attempts,
        traceparent: outboxEvents.traceparent,
      })
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.status, 'pending'),
          lt(outboxEvents.attempts, this.maxAttempts),
          lte(outboxEvents.scheduledAt, now),
          this.notLeased(now),
        ),
      )
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.seq), asc(outboxEvents.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  protected async deliver(row: Claimed<OutboxEventRow>): Promise<void> {
    const payload = (row.payload ?? {}) as AuditEventPayload;

    await this.auditRepo.create({
      id: uuidv7(),
      workspaceId: row.workspaceId,
      action: row.eventType,
      resourceType: row.aggregateType,
      resourceId: row.aggregateId,
      actorId: payload.actorId,
      projectId: payload.projectId,
      changes: payload.changes,
      metadata: { source: 'domain-event', occurredAt: row.occurredAt.toISOString() },
      // The OUTBOX ROW id, not the event's own `eventId`: this is the value the
      // unique index sees, so a row reprojected after a crash collides with itself
      // and is skipped rather than duplicated.
      sourceEventId: row.id,
      // actorEmail is deliberately absent. AuditProducer's AuditActor carries only an
      // id, so the value the old consumer read was always undefined; the read model
      // resolves it with `coalesce(audit_logs.actor_email, users.email)` over a
      // leftJoin on actorId. Leaving this null keeps that join authoritative.
    });
  }

  protected async markSent(tx: DrizzleTx, row: Claimed<OutboxEventRow>): Promise<void> {
    await tx
      .update(outboxEvents)
      .set({ status: 'published', publishedAt: new Date() })
      .where(eq(outboxEvents.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<OutboxEventRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    // `attempts` was spent at claim time. Only a retry moves scheduledAt forward (the backoff).
    await tx
      .update(outboxEvents)
      .set({
        status: newStatus,
        lastError,
        ...(newStatus === 'pending' ? { scheduledAt: nextAttemptAt } : {}),
      })
      .where(eq(outboxEvents.id, row.id));
  }
}
