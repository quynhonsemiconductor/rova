import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@shared-kernel/ids/uuid';
import type { DomainEvent } from '@shared-kernel/domain/domain-event';
import { InjectDrizzle } from '../database/drizzle.provider';
import type { DrizzleDB, DrizzleTx } from '../database/drizzle.provider';
import { outboxEvents } from '../../../../db/schema/messaging';
import { currentTraceparent } from '@quynhonsemiconductor/observability';

/**
 * Outbox writer — inserts domain events into outbox_events in the SAME transaction
 * as the aggregate state change. `AuditProjectionRelay` (worker) claims each row and projects it into
 * `audit.audit_logs`; there is no topic or queue (see docs/DIVERGENCE.md).
 *
 * This is the transactional outbox pattern: no dual-write, no lost events.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  // Inject DB for type reference — actual writes always use the tx passed from UoW
  constructor(@InjectDrizzle() private readonly _db: DrizzleDB) {}

  /**
   * Write events to outbox_events within the provided transaction.
   * Called by application layer after aggregate.pullEvents().
   */
  async writeEvents(events: DomainEvent[], tx: DrizzleTx): Promise<void> {
    if (events.length === 0) return;

    const rows = events.map((e) => ({
      id: generateId(),
      eventId: e.eventId,
      eventType: e.eventType,
      version: e.version,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      workspaceId: e.workspaceId,
      payload: e.payload,
      occurredAt: e.occurredAt,
      status: 'pending' as const,
      attempts: 0,
      // created_at is left to the column default (now(), the database clock): a host-stamped value would
      // drift from the database clock the relay's due checks use.
      // Capture the producing request's trace so the relay can continue it. Null
      // when nothing is tracing, which the relay treats as "start a root span".
      traceparent: currentTraceparent(),
    }));

    await tx.insert(outboxEvents).values(rows);

    this.logger.debug(
      `Wrote ${rows.length} outbox event(s): ${events.map((e) => e.eventType).join(', ')}`,
    );
  }
}
