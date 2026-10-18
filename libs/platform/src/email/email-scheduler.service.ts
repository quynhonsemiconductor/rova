/**
 * EmailSchedulerService — API-side email scheduler.
 *
 * Writes an email_outbox row in the caller's DB transaction, guaranteeing
 * atomicity: if the transaction rolls back, the email job is also rolled back.
 *
 * USAGE (in a service method):
 *   await this.db.transaction(async (tx) => {
 *     await someRepo.create(data, tx);
 *     await this.emailScheduler.schedule({ template: 'password-reset', to, vars }, tx);
 *   });
 *
 * Without tx: the job is written in its own transaction (best-effort).
 *
 * DEDUPLICATION:
 *   Callers should supply `idempotencyKey` — a stable, deterministic string
 *   scoped to the business event.  The column has a UNIQUE constraint; a
 *   duplicate schedule() call with the same key is silently swallowed via
 *   ON CONFLICT DO NOTHING.  Without a key the insert always proceeds (legacy
 *   behaviour / one-off emails).
 *
 *   Convention:
 *     password-reset       → sha256('password-reset:' + tokenHash)
 *     workspace-invitation → invitation.id
 *     future notifications → notification.id
 */
import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '../database/drizzle.provider';
import type { DrizzleDB, DbExecutor } from '../database/drizzle.provider';
import { emailOutbox } from '../../../../db/schema/messaging';
import type { EmailTemplateName, EmailTemplateVars } from './templates';
import { NotificationPubSubService } from '../notifications/notification-pubsub.service';

type AnyDb = DbExecutor;

export interface ScheduleEmailOptions<K extends EmailTemplateName> {
  to: string;
  template: K;
  vars: EmailTemplateVars[K];
  /** ISO 8601 datetime — default now() (send immediately on next relay tick). */
  scheduledAt?: Date;
  /**
   * Deduplication key.  When set, a second schedule() call with the same key
   * is a no-op (ON CONFLICT DO NOTHING).  Strongly recommended for all
   * transactional emails tied to a business entity.
   */
  idempotencyKey?: string;
}

@Injectable()
export class EmailSchedulerService {
  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly pubSub: NotificationPubSubService,
  ) {}

  async schedule<K extends EmailTemplateName>(
    options: ScheduleEmailOptions<K>,
    tx?: AnyDb,
  ): Promise<void> {
    const db = tx ?? this.db;
    await db
      .insert(emailOutbox)
      .values({
        to: options.to,
        template: options.template,
        vars: options.vars,
        status: 'pending',
        ...(options.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
      })
      // Silently swallow duplicate inserts — the email was already scheduled
      // (or sent) for this business event.  No error, no second email.
      .onConflictDoNothing({ target: emailOutbox.idempotencyKey });

    // Wake the Worker relay immediately so email delivery latency is ~ms rather
    // than ≤5s (the cron fallback).  Best-effort — same semantics as notification wake.
    this.pubSub.wakeEmailRelay().catch(() => {
      /* cron fallback handles it */
    });
  }
}
