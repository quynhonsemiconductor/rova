/**
 * NotificationRelayService — polls notification_outbox and dispatches via
 * NotificationsService (writes to in_app_notifications).
 *
 * Extends AbstractOutboxRelay (lease-and-fence) which owns the polling loop, concurrency guard,
 * claim/finish transactions, and retry/fail logic.  This class provides only the
 * notification-specific behaviour: what to SELECT, how to render + send, and
 * how to mark rows.
 *
 * Adaptive polling:
 *   NotificationSchedulerService.schedule() publishes a relay:wake signal to
 *   Valkey immediately after writing to notification_outbox.  onModuleInit()
 *   subscribes and calls super.relay() directly — delivery latency drops from
 *   ≤5s (cron) to ~ms (wake signal).  The 5s cron is the catch-all fallback.
 *
 * Post-commit tasks (3rd layer of the real-time pipeline):
 *   settle() returns a PostCommitTask that runs AFTER the finish transaction
 *   commits.  It does two things in parallel:
 *     1. Publishes to Valkey → SSE push (in-app real-time).
 *     2. Checks the template's email channel policy (EMAIL_CHANNEL_BY_TEMPLATE)
 *        and then the user's email preference; if both allow it, looks up the
 *        recipient's email address and writes an email_outbox row via
 *        EmailSchedulerService so the email relay delivers it asynchronously.
 *        The policy is asked first and a preference can only narrow it — an
 *        in-app-only template is never mailed, whatever the preference says.
 *   Email scheduling uses a deterministic idempotency key so relay retries
 *   never produce duplicate emails.  Only non-null (new) notifications trigger
 *   either post-commit task; deduplicated rows are silent no-ops.
 *
 * End-to-end idempotency (3 layers):
 *   1. notification_outbox.idempotency_key UNIQUE — prevents duplicate outbox rows.
 *   2. row.idempotencyKey ?? row.id passed as sourceEventId.
 *   3. in_app_notifications.source_event_id UNIQUE — safe no-op on relay retry.
 */
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, asc, eq, lt, lte } from 'drizzle-orm';
import { InjectDrizzle, Span } from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { AbstractOutboxRelay } from '@platform/outbox';
import type { Claimed, OutboxLeaseTable, PostCommitTask } from '@platform/outbox';
import { NotificationsService, NotificationPreferencesService } from '@modules/notifications';
import {
  renderNotification,
  emailChannelAvailable,
  NotificationPubSubService,
} from '@platform/notifications';
import type { NotificationTemplateName, NotificationTemplateVars } from '@platform/notifications';
import { EmailSchedulerService, AppConfigService } from '@platform';
import { notificationOutbox } from '../../../../db/schema/messaging';
import { users } from '../../../../db/schema/identity';

type NotificationOutboxRow = {
  id: string;
  workspaceId: string;
  recipientId: string;
  actorId: string | null;
  type: string;
  vars: unknown;
  resourceId: string | null;
  attempts: number;
  idempotencyKey: string | null;
};

/** What deliver() produced and settle() needs; null when nothing was written (suppressed or a duplicate). */
type NotificationDelivery = {
  notificationId: string;
  rendered: { title: string; body?: string; resourceType?: string };
  emailEnabled: boolean;
} | null;

/** Per-row lease: database writes and a Valkey publish take milliseconds; the lease only has to cover waiting. */
const NOTIFICATION_LEASE_MS = 30_000;

@Injectable()
export class NotificationRelayService
  extends AbstractOutboxRelay<NotificationOutboxRow, NotificationDelivery>
  implements OnModuleInit, OnModuleDestroy
{
  /** Held for the SUM of the batch's leases (30 s each): 10 rows is 5 minutes if a worker dies. */
  protected override readonly batchSize = 10;

  private unsubscribeRelayWake?: () => Promise<void>;
  private readonly emailLogger = new Logger(NotificationRelayService.name + '.email');
  private readonly appUrl: string;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly notificationsService: NotificationsService,
    private readonly pubSub: NotificationPubSubService,
    private readonly prefs: NotificationPreferencesService,
    private readonly emailScheduler: EmailSchedulerService,
    config: AppConfigService,
  ) {
    super(db);
    this.appUrl = config.get('APP_BASE_URL') ?? 'http://localhost:5173';
  }

  async onModuleInit(): Promise<void> {
    this.logger.log('Notification relay started — polling notification_outbox every 5s');
    // Subscribe to relay:wake signals published by the API after schedule().
    // This gives near-zero delivery latency; the 5s cron is the catch-all fallback.
    this.unsubscribeRelayWake = await this.pubSub.subscribeRelayWake(() => {
      this.relay().catch((err: unknown) =>
        this.logger.error({ err }, 'Relay triggered by wake signal failed'),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.unsubscribeRelayWake?.();
  }

  /** Cron runs every 5 seconds as the catch-all fallback. */
  @Cron('*/5 * * * * *', { name: 'notification-relay' })
  @Span('notification.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  // ── AbstractOutboxRelay implementation ────────────────────────────────────

  protected readonly outbox: OutboxLeaseTable = {
    table: notificationOutbox,
    id: notificationOutbox.id,
    status: notificationOutbox.status,
    attempts: notificationOutbox.attempts,
    lastError: notificationOutbox.lastError,
    leaseToken: notificationOutbox.leaseToken,
    lockedUntil: notificationOutbox.lockedUntil,
    seq: notificationOutbox.seq,
  };

  protected override leaseMsFor(): number {
    return NOTIFICATION_LEASE_MS;
  }

  protected async selectDue(
    tx: DrizzleTx,
    limit: number,
    now: Date,
  ): Promise<NotificationOutboxRow[]> {
    return tx
      .select({
        id: notificationOutbox.id,
        workspaceId: notificationOutbox.workspaceId,
        recipientId: notificationOutbox.recipientId,
        actorId: notificationOutbox.actorId,
        type: notificationOutbox.type,
        vars: notificationOutbox.vars,
        resourceId: notificationOutbox.resourceId,
        attempts: notificationOutbox.attempts,
        idempotencyKey: notificationOutbox.idempotencyKey,
      })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, 'pending'),
          lt(notificationOutbox.attempts, this.maxAttempts),
          lte(notificationOutbox.scheduledAt, now),
          this.notLeased(now),
        ),
      )
      .orderBy(
        asc(notificationOutbox.scheduledAt),
        asc(notificationOutbox.seq),
        asc(notificationOutbox.id),
      )
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /**
   * Render the template and write to in_app_notifications. The write is idempotent
   * (`source_event_id` ON CONFLICT DO NOTHING), so a retry after a failed finish is a safe no-op.
   *
   * Resolves to null when nothing needs doing after the commit: the user opted out, or the notification
   * was deduplicated (it already exists).
   */
  protected async deliver(row: Claimed<NotificationOutboxRow>): Promise<NotificationDelivery> {
    // Skip in-app delivery if user has opted out (preference check uses a pool connection).
    const inAppEnabled = await this.prefs.isInAppEnabled(
      row.workspaceId,
      row.recipientId,
      row.type,
    );
    if (!inAppEnabled) {
      this.logger.debug(
        { recipientId: row.recipientId, type: row.type },
        'In-app notification suppressed by preference',
      );
      return null; // the row is marked sent
    }

    const rendered = renderNotification(
      row.type as NotificationTemplateName,
      row.vars as NotificationTemplateVars[NotificationTemplateName],
    );

    const notification = await this.notificationsService.send({
      workspaceId: row.workspaceId,
      recipientId: row.recipientId,
      actorId: row.actorId ?? undefined,
      type: row.type,
      title: rendered.title,
      body: rendered.body,
      resourceType: rendered.resourceType,
      resourceId: row.resourceId ?? undefined,
      // Structured deep-link payload (e.g. { itemKey, projectId }) so the client
      // can open the resource in its own context, not the active one.
      metadata: rendered.metadata,
      // Stable deduplication key: same UUID on every retry for this outbox row.
      // ON CONFLICT DO NOTHING on source_event_id makes retries safe no-ops.
      sourceEventId: row.idempotencyKey ?? row.id,
    });

    if (!notification) return null; // deduplicated — no post-commit work needed

    // The template's own channel policy is asked FIRST, and it is not a preference: a type that
    // is in-app only (WORK_ITEM_ASSIGNED) can never be mailed, so no `email: true` row and no
    // default can widen it back. Also saves the preference query on the highest-volume type.
    const emailEnabled =
      emailChannelAvailable(row.type) &&
      (await this.prefs.isEmailEnabled(row.workspaceId, row.recipientId, row.type));

    return { notificationId: notification.id, rendered, emailEnabled };
  }

  /**
   * Returns the PostCommitTask that runs AFTER the finish transaction commits:
   *   1. Publishes the SSE push signal to Valkey.
   *   2. If the user has email notifications enabled, schedules an email via
   *      EmailSchedulerService (looks up recipient email from identity.users).
   */
  protected settle(
    row: Claimed<NotificationOutboxRow>,
    delivery: NotificationDelivery,
  ): Promise<PostCommitTask | void> {
    if (!delivery) return Promise.resolve();
    const { notificationId, rendered, emailEnabled } = delivery;

    return Promise.resolve(async () => {
      // 1. SSE real-time push via Valkey.
      await this.pubSub.notifyUser({
        notificationId,
        recipientId: row.recipientId,
        type: row.type,
        title: rendered.title,
        body: rendered.body,
        resourceType: rendered.resourceType,
        resourceId: row.resourceId ?? undefined,
      });

      // 2. Email delivery (if enabled).
      if (emailEnabled) {
        await this.scheduleNotificationEmail(row, rendered, notificationId);
      }
    });
  }

  /**
   * Looks up the recipient's email address and schedules a `notification` email
   * via the email outbox.  Uses a deterministic idempotency key so relay retries
   * and the PostCommitTask being called more than once (e.g., on crash-recovery)
   * never produce a duplicate email.
   *
   * Errors here are logged and swallowed — email is best-effort; in-app delivery
   * is already durable and the SSE push has already fired.
   */
  private async scheduleNotificationEmail(
    row: NotificationOutboxRow,
    rendered: { title: string; body?: string; resourceType?: string },
    notificationId: string,
  ): Promise<void> {
    try {
      const recipientRows = await this.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, row.recipientId))
        .limit(1);
      const recipientEmail = recipientRows[0]?.email;
      if (!recipientEmail) {
        this.emailLogger.warn(
          { recipientId: row.recipientId },
          'Recipient not found — skipping notification email',
        );
        return;
      }

      const appUrl = row.resourceId ? `${this.appUrl}/notifications` : this.appUrl;

      await this.emailScheduler.schedule({
        to: recipientEmail,
        template: 'notification',
        vars: {
          title: rendered.title,
          body: rendered.body,
          resourceType: rendered.resourceType,
          appUrl,
        },
        // Deterministic key scoped to the notification: same key on every retry.
        idempotencyKey: `notification-email:${notificationId}`,
      });
    } catch (err) {
      this.emailLogger.error({ err, notificationId }, 'Failed to schedule notification email');
    }
  }

  protected async markSent(tx: DrizzleTx, row: Claimed<NotificationOutboxRow>): Promise<void> {
    await tx
      .update(notificationOutbox)
      .set({ status: 'sent', dispatchedAt: new Date() })
      .where(eq(notificationOutbox.id, row.id));
  }

  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<NotificationOutboxRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    // `attempts` was spent at claim time. Only a retry pushes scheduledAt forward; a terminal row keeps its
    // last one, which is fine since selectDue() never selects 'failed' rows again.
    await tx
      .update(notificationOutbox)
      .set({
        status: newStatus,
        lastError,
        ...(newStatus === 'pending' ? { scheduledAt: nextAttemptAt } : {}),
      })
      .where(eq(notificationOutbox.id, row.id));
  }
}
