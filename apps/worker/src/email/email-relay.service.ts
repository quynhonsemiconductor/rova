/**
 * EmailRelayService — polls email_outbox and dispatches via EmailService (IEmailProvider).
 *
 * Extends AbstractOutboxRelay (lease-and-fence): a short claim transaction, the provider call with NO
 * transaction open, a fenced finish. This class provides only the email-specific behaviour: what to SELECT,
 * how to send, and how to mark rows.
 *
 * LEASE. One send is a `ResiliencePreset.EMAIL` call: up to six executions of 30 s each (cockatiel's
 * `maxAttempts` counts RETRIES). `leaseMsFor` derives the lease from that preset, so it always outlasts the
 * call. A batch is held for the SUM of its rows' leases, hence the small batch.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte, sql } from 'drizzle-orm';
import { InjectDrizzle, Span, ResiliencePreset, leaseForResilience } from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { AbstractOutboxRelay, dbDelay } from '@platform/outbox';
import type { Claimed, OutboxLeaseTable } from '@platform/outbox';
import { EmailService } from '@platform/email';
import type { EmailTemplateName, EmailTemplateVars } from '@platform/email';
import { NotificationPubSubService } from '@platform/notifications';
import { NotificationPreferencesService } from '@modules/notifications';
import { emailOutbox } from '../../../../db/schema/messaging';

type EmailOutboxRow = {
  id: string;
  to: string;
  template: string;
  vars: unknown;
  attempts: number;
  idempotencyKey: string | null;
  /** Set for notification emails; null for transactional (password-reset, invitations). */
  recipientId: string | null;
  workspaceId: string | null;
};

/** The provider's message id, or null when the send was suppressed by the recipient's preference. */
type EmailResult = { messageId: string | null };

@Injectable()
export class EmailRelayService
  extends AbstractOutboxRelay<EmailOutboxRow, EmailResult>
  implements OnModuleInit, OnModuleDestroy
{
  /** Held for the SUM of the batch's leases (4 min each): 3 rows is 12 minutes if a worker dies. */
  protected override readonly batchSize = 3;

  private unsubscribeRelayWake?: () => Promise<void>;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly emailService: EmailService,
    private readonly pubSub: NotificationPubSubService,
    private readonly prefs: NotificationPreferencesService,
  ) {
    super(db);
  }

  async onModuleInit(): Promise<void> {
    // Fail the deploy, not the first invitation, if the configured transport cannot work (a missing Graph variable).
    this.emailService.assertReady();
    this.logger.log('Email relay started — polling email_outbox every 5s');
    this.unsubscribeRelayWake = await this.pubSub.subscribeEmailRelayWake(() => {
      this.relay().catch((err: unknown) =>
        this.logger.error({ err }, 'Email relay triggered by wake signal failed'),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.unsubscribeRelayWake?.();
  }

  @Cron('*/5 * * * * *', { name: 'email-relay' })
  @Span('email.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  // ── AbstractOutboxRelay implementation ────────────────────────────────────

  protected readonly outbox: OutboxLeaseTable = {
    table: emailOutbox,
    id: emailOutbox.id,
    status: emailOutbox.status,
    attempts: emailOutbox.attempts,
    lastError: emailOutbox.lastError,
    leaseToken: emailOutbox.leaseToken,
    lockedUntil: emailOutbox.lockedUntil,
    seq: emailOutbox.seq,
  };

  /** One provider send: ResiliencePreset.EMAIL (six executions of 30 s) plus the margin. */
  protected override leaseMsFor(): number {
    return leaseForResilience(ResiliencePreset.EMAIL);
  }

  protected async selectDue(tx: DrizzleTx, limit: number): Promise<EmailOutboxRow[]> {
    return tx
      .select({
        id: emailOutbox.id,
        to: emailOutbox.to,
        template: emailOutbox.template,
        vars: emailOutbox.vars,
        attempts: emailOutbox.attempts,
        idempotencyKey: emailOutbox.idempotencyKey,
        recipientId: emailOutbox.recipientId,
        workspaceId: emailOutbox.workspaceId,
      })
      .from(emailOutbox)
      .where(
        and(
          eq(emailOutbox.status, 'pending'),
          lt(emailOutbox.attempts, this.maxAttempts),
          lte(emailOutbox.scheduledAt, sql`now()`),
          this.notLeased(),
        ),
      )
      .orderBy(asc(emailOutbox.scheduledAt), asc(emailOutbox.seq), asc(emailOutbox.id))
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  protected async deliver(row: Claimed<EmailOutboxRow>): Promise<EmailResult> {
    // If this email is linked to an internal user, check their email preference.
    // Transactional emails (password reset, invitations) have no recipientId and always send.
    if (row.recipientId && row.workspaceId) {
      const emailEnabled = await this.prefs.isEmailEnabled(
        row.workspaceId,
        row.recipientId,
        row.template,
      );
      if (!emailEnabled) {
        this.logger.debug(
          { recipientId: row.recipientId, template: row.template },
          'Email suppressed by preference',
        );
        return { messageId: null }; // the row is marked sent: there is nothing to deliver
      }
    }

    // The provider's message id is returned so markSent persists it in the SAME transaction that flips the
    // row to sent: it is the feedback loop's only exact match key, and storing it anywhere looser than the
    // status write risks a `sent` row that can never be bounce-matched.
    const sent = await this.emailService.sendTemplate(
      row.to,
      row.template as EmailTemplateName,
      row.vars as EmailTemplateVars[EmailTemplateName],
      // row.idempotencyKey ?? row.id is a stable key across all retries for this outbox row — Resend
      // deduplicates by this so a provider send that succeeded but whose finish failed will NOT produce a
      // duplicate email.
      row.idempotencyKey ?? row.id,
    );
    return { messageId: sent.messageId };
  }

  protected async markSent(
    tx: DrizzleTx,
    row: Claimed<EmailOutboxRow>,
    result: EmailResult,
  ): Promise<void> {
    await tx
      .update(emailOutbox)
      .set({ status: 'sent', sentAt: sql`now()`, messageId: result.messageId })
      .where(eq(emailOutbox.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<EmailOutboxRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    delayMs: number,
  ): Promise<void> {
    // `attempts` was spent at claim time. Only a retry pushes scheduledAt forward; a terminal row keeps its
    // last one, which is fine since selectDue() never selects 'failed' rows again.
    await tx
      .update(emailOutbox)
      .set({
        status: newStatus,
        lastError,
        ...(newStatus === 'pending' ? { scheduledAt: dbDelay(delayMs) } : {}),
      })
      .where(eq(emailOutbox.id, row.id));
  }
}
