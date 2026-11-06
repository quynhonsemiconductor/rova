/**
 * CleanupCronService — periodic housekeeping for stale / soft-deleted rows.
 *
 * Runs daily at 01:00 UTC (stagger from snapshot cron at 00:00).
 * Purges:
 *   1. identity.auth_sessions that are revoked and expired >N days ago
 *   2. workspace.workspace_invitations that are still 'pending' but expired >N days ago
 *   3. storage.files that are unreachable — either presigned but never confirmed
 *      (older than 24 h), or soft-deleted, or no longer referenced by any link
 *      table. Deletes the object, then the row.
 *   4. scm.webhook_inbox rows that have been dealt with, past their retention
 *      window. Terminal rows are the whole table over time — see the constants.
 *
 * N is configured via SESSION_CLEANUP_OLDER_THAN_DAYS (default 7).
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { InjectDrizzle, AppConfigService, StorageService, ExclusiveJob } from '@platform';
import type { DrizzleDB } from '@platform';

@Injectable()
export class CleanupCronService {
  private readonly logger = new Logger(CleanupCronService.name);
  /** Lock TTL: 55 min — slightly less than the 1h cron interval to avoid overlap. */
  private readonly LOCK_TTL_MS = 55 * 60 * 1_000;

  /**
   * SCM inbox retention. Constants rather than env vars: this is housekeeping with
   * no per-environment decision behind it, and a new env var costs four touchpoints
   * (env.schema.ts, .env.example, CI, infra/live/*) for a number nobody will tune.
   *
   * `processed`/`ignored` rows are kept 30 days purely to answer "did we receive
   * that delivery?" during an incident. `failed` rows are kept far longer because
   * they are the dead-letter queue — each one is a link that never happened, and
   * deleting it destroys the only record. They are also self-limiting: a row only
   * reaches `failed` after 5 attempts, so healthy periods produce none.
   *
   * Bounded per run because each row carries the full webhook payload as jsonb
   * (~25 KB observed), so a first sweep over a long-neglected table would otherwise
   * be one very large transaction.
   */
  private readonly SCM_INBOX_HANDLED_RETENTION_DAYS = 30;
  private readonly SCM_INBOX_FAILED_RETENTION_DAYS = 180;
  private readonly SCM_INBOX_SWEEP_LIMIT = 5_000;

  /**
   * Retention for the other append-only tables.
   *
   * Owner decision 2026-11-06: audit and activity history are NOT capped. Volumes are
   * tiny today; revisit with the counts from the dry-run reports, not a guess. Terminal
   * messaging rows and read notifications go sooner; expired credentials get the same
   * seven-day grace as sessions. `failed` outbox rows are dead-letter records and are
   * kept far longer than successful ones.
   */
  private readonly EMAIL_OUTBOX_RETENTION_DAYS = 30;
  private readonly EMAIL_OUTBOX_FAILED_RETENTION_DAYS = 90;
  private readonly NOTIFICATION_OUTBOX_RETENTION_DAYS = 30;
  private readonly GUEST_INVITE_RETENTION_DAYS = 30;
  private readonly GUEST_INVITE_FAILED_RETENTION_DAYS = 180;
  private readonly IN_APP_READ_RETENTION_DAYS = 90;
  private readonly IN_APP_ANY_RETENTION_DAYS = 365;
  private readonly CREDENTIAL_GRACE_DAYS = 7;
  private readonly SCM_BACKFILL_RETENTION_DAYS = 90;
  private readonly RETENTION_SWEEP_LIMIT = 5_000;
  private readonly RETENTION_MAX_PASSES = 20;
  /** Set by runCleanup; purgeBatched stops cleanly before the ExclusiveJob lock expires. */
  private deadline = 0;

  constructor(
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly config: AppConfigService,
    private readonly storageService: StorageService,
    private readonly exclusive: ExclusiveJob,
  ) {}

  @Cron('0 1 * * *', { name: 'daily-cleanup', timeZone: 'UTC' })
  async runCleanup(): Promise<void> {
    if (!this.config.get('RETENTION_SWEEP_ENABLED')) {
      this.logger.log('Retention sweep disabled');
      return;
    }
    // Stop well before the ExclusiveJob lock expires, even if a table needs more passes.
    this.deadline = Date.now() + this.LOCK_TTL_MS - 5 * 60 * 1_000;
    const dryRun = this.config.get('RETENTION_DRY_RUN');
    // ExclusiveJob owns the lock, the job context (a correlationId, which cron work has
    // nothing to inherit) and the duration/outcome metrics. This class used to hand-roll
    // all three, as did SnapshotCronService — identically, which is why they now share it.
    await this.exclusive.run('daily-cleanup', this.LOCK_TTL_MS, () =>
      dryRun ? this.reportOnly() : this.purgeStaleData(),
    );
  }

  /** Count-only first run: no writes, no object deletion, no status changes. */
  private async reportOnly(): Promise<void> {
    const count = async (statement: ReturnType<typeof sql>): Promise<number> => {
      const result = await this.db.execute(statement);
      const rows = (result as unknown as { rows?: Array<{ n: number | string }> }).rows ?? [];
      return Number(rows[0]?.n ?? 0);
    };
    const older = this.config.get('SESSION_CLEANUP_OLDER_THAN_DAYS');
    const counts = {
      auth_sessions: await count(sql`
        SELECT count(*) AS n FROM identity.auth_sessions
        WHERE is_revoked = true
          AND expires_at < NOW() - (${older} || ' days')::interval
      `),
      invitations: await count(sql`
        SELECT count(*) AS n FROM workspace.workspace_invitations
        WHERE status = 'pending' AND expires_at < NOW()
      `),
      scm_inbox: await count(sql`
        SELECT count(*) AS n FROM scm.webhook_inbox
        WHERE (status IN ('processed', 'ignored')
          AND COALESCE(processed_at, received_at)
            < NOW() - (${this.SCM_INBOX_HANDLED_RETENTION_DAYS} || ' days')::interval)
        OR (status = 'failed'
          AND received_at
            < NOW() - (${this.SCM_INBOX_FAILED_RETENTION_DAYS} || ' days')::interval)
      `),
      email_outbox: await count(sql`
        SELECT count(*) AS n FROM messaging.email_outbox
        WHERE (status = 'sent'
          AND COALESCE(sent_at, created_at)
            < NOW() - (${this.EMAIL_OUTBOX_RETENTION_DAYS} || ' days')::interval)
        OR (status = 'failed'
          AND created_at
            < NOW() - (${this.EMAIL_OUTBOX_FAILED_RETENTION_DAYS} || ' days')::interval)
      `),
      notification_outbox: await count(sql`
        SELECT count(*) AS n FROM messaging.notification_outbox
        WHERE status IN ('sent', 'failed')
          AND COALESCE(dispatched_at, created_at)
            < NOW() - (${this.NOTIFICATION_OUTBOX_RETENTION_DAYS} || ' days')::interval
      `),
      guest_invite_outbox: await count(sql`
        SELECT count(*) AS n FROM messaging.guest_invite_outbox
        WHERE (status = 'sent'
          AND COALESCE(sent_at, created_at)
            < NOW() - (${this.GUEST_INVITE_RETENTION_DAYS} || ' days')::interval)
        OR (status = 'failed'
          AND created_at
            < NOW() - (${this.GUEST_INVITE_FAILED_RETENTION_DAYS} || ' days')::interval)
      `),
      in_app_notifications: await count(sql`
        SELECT count(*) AS n FROM notifications.in_app_notifications
        WHERE (is_read = true
          AND created_at < NOW() - (${this.IN_APP_READ_RETENTION_DAYS} || ' days')::interval)
        OR created_at < NOW() - (${this.IN_APP_ANY_RETENTION_DAYS} || ' days')::interval
      `),
      api_tokens: await count(sql`
        SELECT count(*) AS n FROM identity.api_tokens
        WHERE expires_at < NOW() - (${this.CREDENTIAL_GRACE_DAYS} || ' days')::interval
           OR revoked_at < NOW() - (${this.CREDENTIAL_GRACE_DAYS} || ' days')::interval
      `),
      identity_sessions: await count(sql`
        SELECT count(*) AS n FROM identity."session"
        WHERE expires_at < NOW() - (${this.CREDENTIAL_GRACE_DAYS} || ' days')::interval
      `),
      scm_backfill_jobs: await count(sql`
        SELECT count(*) AS n FROM scm.backfill_jobs
        WHERE status IN ('done', 'failed')
          AND COALESCE(finished_at, requested_at)
            < NOW() - (${this.SCM_BACKFILL_RETENTION_DAYS} || ' days')::interval
      `),
    };
    this.logger.log({ dryRun: true, counts }, 'Retention sweep (count-only)');
  }

  private async purgeStaleData(): Promise<void> {
    const olderThanDays = this.config.get('SESSION_CLEANUP_OLDER_THAN_DAYS');
    this.logger.log(`Running daily cleanup (session retention=${olderThanDays}d)`);

    // 1. Revoked sessions past retention window
    const sessionResult = await this.db.execute(
      sql`
        DELETE FROM identity.auth_sessions
        WHERE is_revoked = true
          AND expires_at < NOW() - (${olderThanDays} || ' days')::interval
      `,
    );
    this.logger.log(
      { deleted: (sessionResult as { rowCount?: number }).rowCount },
      'Purged stale auth sessions',
    );

    // 2. Expired pending invitations
    const invResult = await this.db.execute(
      sql`
        UPDATE workspace.workspace_invitations
        SET status = 'expired', updated_at = NOW()
        WHERE status = 'pending'
          AND expires_at < NOW()
      `,
    );
    this.logger.log(
      { updated: (invResult as { rowCount?: number }).rowCount },
      'Expired stale workspace invitations',
    );

    // 3. Unreachable storage.files — the single place objects are deleted.
    //
    // Three ways a file becomes unreachable, all handled by one sweep so a file
    // cannot slip between them:
    //   a) pending  — presigned but /confirm never called (client abandoned)
    //   b) soft-deleted — the owner called DELETE
    //   c) unreferenced — every link row is gone (e.g. its work item was
    //      deleted, which cascaded the link but not the file)
    //
    // (c) is why deletion lives here rather than in the request path: a file may
    // be referenced by more than one link row, and only a sweep can see that the
    // last reference has gone. Add a NOT EXISTS clause per new link table.
    //
    // Objects are deleted BEFORE the rows: a failed object delete leaves the row
    // for the next run to retry. The reverse order would drop the only record of
    // the key and leak the object permanently.
    const unreachable = await this.db.execute<{
      id: string;
      storage_key: string;
      visibility: string;
    }>(
      sql`
        SELECT f.id, f.storage_key, f.visibility
        FROM storage.files f
        WHERE
          (f.status = 'pending' AND f.created_at < NOW() - INTERVAL '24 hours')
          OR f.deleted_at IS NOT NULL
          OR (
            f.status = 'completed'
            -- Grace period: a file is legitimately unreferenced between /confirm
            -- and the caller writing its link row. Without this the sweep would
            -- race an in-flight upload.
            AND f.confirmed_at < NOW() - INTERVAL '1 hour'
            AND NOT EXISTS (
              -- work.attachments (renamed from work_item_attachments in 0083) is the ONLY
              -- link table pointing at storage.files. If a second one is ever added, it
              -- must be OR-ed in here or this sweep will delete live blobs.
              SELECT 1 FROM work.attachments l WHERE l.file_id = f.id
            )
          )
        LIMIT 1000
      `,
    );
    const rows =
      (
        unreachable as unknown as {
          rows: { id: string; storage_key: string; visibility: string }[];
        }
      ).rows ?? [];

    if (rows.length > 0) {
      const results = await Promise.allSettled(
        rows.map((r) =>
          this.storageService.deleteObject(
            r.storage_key,
            r.visibility === 'public' ? 'public' : 'private',
          ),
        ),
      );
      // deleteObject swallows its own errors, so a rejection here is unexpected —
      // keep those rows for the next run rather than dropping the key.
      const deletedIds = rows.filter((_, i) => results[i].status === 'fulfilled').map((r) => r.id);

      if (deletedIds.length > 0) {
        await this.db.execute(
          sql`DELETE FROM storage.files WHERE id = ANY(${sql.param(deletedIds)}::uuid[])`,
        );
      }
      this.logger.log(
        { swept: rows.length, deleted: deletedIds.length },
        'Purged unreachable storage files',
      );
    }

    // 4. Terminal scm.webhook_inbox rows past retention.
    //
    // The inbox is an append-only log of every delivery GitHub sends — one row per
    // push and per pull_request event, each holding the raw payload as jsonb. Nothing
    // deleted them, so the table and its TOAST storage grew without bound on an
    // instance sized for 30 GB. It is bounded by activity, not by users: a busy repo
    // generates rows whether or not anyone opens rova.
    //
    // Only TERMINAL rows are eligible. `pending` is excluded no matter how old,
    // because a row waiting on backoff is still work owed — the relay retries with
    // exponentially increasing delays and a stalled queue must not be silently
    // truncated. `status` is the whole filter, not age alone.
    //
    // COALESCE because processed_at is nullable and only the relay's markSent
    // populates it: any other path to a terminal status would leave it NULL, and a
    // NULL comparison is false, so those rows would be retained forever by an
    // omission nobody would notice. received_at always has a default.
    //
    // Deliberately unindexed. ix_scm_inbox_pending is PARTIAL (WHERE status =
    // 'pending'), so this scans — which is the right trade for a once-daily sweep
    // over a table this keeps small, rather than paying index maintenance on every
    // webhook insert to speed up a job nothing waits on.
    const inboxResult = await this.db.execute(
      sql`
        DELETE FROM scm.webhook_inbox
        WHERE id IN (
          SELECT id FROM scm.webhook_inbox
          WHERE (
              status IN ('processed', 'ignored')
              AND COALESCE(processed_at, received_at) < NOW() - (${this.SCM_INBOX_HANDLED_RETENTION_DAYS} || ' days')::interval
            )
            OR (
              status = 'failed'
              AND received_at < NOW() - (${this.SCM_INBOX_FAILED_RETENTION_DAYS} || ' days')::interval
            )
          LIMIT ${this.SCM_INBOX_SWEEP_LIMIT}
        )
      `,
    );
    this.logger.log(
      { deleted: (inboxResult as { rowCount?: number }).rowCount },
      'Purged terminal SCM webhook inbox rows',
    );

    // 5. The other append-only tables. Each statement is bounded by a primary-key
    // subquery and the terminal timestamp is the clock, not created_at.
    await this.purgeBatched(
      'Purged terminal email outbox rows',
      (limit) => sql`
        DELETE FROM messaging.email_outbox
        WHERE id IN (
          SELECT id FROM messaging.email_outbox
          WHERE (
              status = 'sent'
              AND COALESCE(sent_at, created_at)
                < NOW() - (${this.EMAIL_OUTBOX_RETENTION_DAYS} || ' days')::interval
            )
            OR (
              status = 'failed'
              AND created_at
                < NOW() - (${this.EMAIL_OUTBOX_FAILED_RETENTION_DAYS} || ' days')::interval
            )
          LIMIT ${limit}
        )
      `,
    );
    // bounced/complained are never deleted: the workspace invitation status reads them.
    await this.purgeBatched(
      'Purged terminal notification outbox rows',
      (limit) => sql`
        DELETE FROM messaging.notification_outbox
        WHERE id IN (
          SELECT id FROM messaging.notification_outbox
          WHERE status IN ('sent', 'failed')
            AND COALESCE(dispatched_at, created_at)
              < NOW() - (${this.NOTIFICATION_OUTBOX_RETENTION_DAYS} || ' days')::interval
          LIMIT ${limit}
        )
      `,
    );
    await this.purgeBatched(
      'Purged terminal guest-invite outbox rows',
      (limit) => sql`
        DELETE FROM messaging.guest_invite_outbox
        WHERE id IN (
          SELECT id FROM messaging.guest_invite_outbox
          WHERE (
              status = 'sent'
              AND COALESCE(sent_at, created_at)
                < NOW() - (${this.GUEST_INVITE_RETENTION_DAYS} || ' days')::interval
            )
            OR (
              status = 'failed'
              AND created_at
                < NOW() - (${this.GUEST_INVITE_FAILED_RETENTION_DAYS} || ' days')::interval
            )
          LIMIT ${limit}
        )
      `,
    );
    await this.purgeBatched(
      'Purged old in-app notifications',
      (limit) => sql`
        DELETE FROM notifications.in_app_notifications
        WHERE id IN (
          SELECT id FROM notifications.in_app_notifications
          WHERE (
              is_read = true
              AND COALESCE(read_at, created_at)
                < NOW() - (${this.IN_APP_READ_RETENTION_DAYS} || ' days')::interval
            )
            OR created_at < NOW() - (${this.IN_APP_ANY_RETENTION_DAYS} || ' days')::interval
          LIMIT ${limit}
        )
      `,
    );
    await this.purgeBatched(
      'Purged expired API tokens',
      (limit) => sql`
        DELETE FROM identity.api_tokens
        WHERE id IN (
          SELECT id FROM identity.api_tokens
          WHERE expires_at < NOW() - (${this.CREDENTIAL_GRACE_DAYS} || ' days')::interval
             OR revoked_at < NOW() - (${this.CREDENTIAL_GRACE_DAYS} || ' days')::interval
          LIMIT ${limit}
        )
      `,
    );
    // identity 8's session table is unused until the cutover; clean it anyway so the
    // first logged-in day after cutover does not inherit an unbounded table.
    await this.purgeBatched(
      'Purged expired identity sessions',
      (limit) => sql`
        DELETE FROM identity."session"
        WHERE id IN (
          SELECT id FROM identity."session"
          WHERE expires_at < NOW() - (${this.CREDENTIAL_GRACE_DAYS} || ' days')::interval
          LIMIT ${limit}
        )
      `,
    );
    await this.purgeBatched(
      'Purged finished SCM backfill jobs',
      (limit) => sql`
        DELETE FROM scm.backfill_jobs
        WHERE id IN (
          SELECT id FROM scm.backfill_jobs
          WHERE status IN ('done', 'failed')
            AND COALESCE(finished_at, requested_at)
              < NOW() - (${this.SCM_BACKFILL_RETENTION_DAYS} || ' days')::interval
          LIMIT ${limit}
        )
      `,
    );
  }

  /**
   * Delete in bounded passes until a pass removes fewer than the limit, the pass cap is
   * reached, or the ExclusiveJob deadline is close. Stopping early is a clean partial
   * sweep: the next daily run starts where this one left off.
   */
  private async purgeBatched(
    message: string,
    statement: (limit: number) => ReturnType<typeof sql>,
  ): Promise<void> {
    let total = 0;
    for (let pass = 0; pass < this.RETENTION_MAX_PASSES; pass += 1) {
      if (Date.now() >= this.deadline) {
        this.logger.warn({ deleted: total }, `${message}: stopped at the lock deadline`);
        break;
      }
      const result = await this.db.execute(statement(this.RETENTION_SWEEP_LIMIT));
      const deleted = (result as { rowCount?: number }).rowCount ?? 0;
      total += deleted;
      if (deleted < this.RETENTION_SWEEP_LIMIT) break;
    }
    if (total > 0) this.logger.log({ deleted: total }, message);
  }
}
