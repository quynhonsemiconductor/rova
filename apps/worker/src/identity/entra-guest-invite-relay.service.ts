/**
 * EntraGuestInviteRelayService — drains `messaging.guest_invite_outbox` and provisions each invited
 * external collaborator as a Microsoft Entra B2B guest via Graph, then writes the returned guest
 * `oid` back onto the invitation.
 *
 * Extends AbstractOutboxRelay (lease-and-fence), which owns the polling loop, the claim and fenced
 * finish transactions, the attempt counter, the exponential backoff and the dead-letter log. Modelled
 * on `EmailRelayService`; the one thing it adds is that a Graph REFUSAL (a malformed address, B2B
 * invitations switched off, a missing `User.Invite.All` grant) answers the same on all five tries and
 * belongs in `status = 'failed'` immediately rather than after fifteen minutes of retries: `deliver`
 * rethrows `PermanentGuestInviteError` as the base class's `NonRetryableError`.
 *
 * THE GRAPH CALL RUNS WITH NO TRANSACTION OPEN. (This file used to say it did, and it did not: the call
 * ran inside the relay's `FOR UPDATE SKIP LOCKED` transaction, which sat idle in transaction for as long
 * as Graph took. Past the worker role's idle_in_transaction_session_timeout the session was killed, the
 * attempt counter rolled back, and the row was retried for ever.) The call is a `ResiliencePreset.EXTERNAL_API`
 * call — four executions of at most 30 s, each with an `AbortSignal` — and the lease is derived from that
 * preset, so it always outlasts the call.
 *
 * IT ALSO SCHEDULES THE INVITATION EMAIL (migration 0124), which is the ordering the invitee
 * depends on. `inviteMember` used to write both outbox rows and two independent relays drained them:
 * the email relay every 5s AND woken instantly, this one on a 30s cron with no wake signal. So the
 * link arrived in under a second and the Entra guest object up to 30s later, plus Microsoft's
 * directory replication — and an invitee who clicks immediately has nothing to authenticate against
 * (`NO_CONNECTION` from our login box, `AADSTS50020` from Microsoft's). The email is therefore
 * scheduled HERE, by the only component that knows the guest is ready, in the same transaction that
 * marks the row `sent`. That is why the docblock this replaced was wrong to call a directory write
 * "not latency-critical" on the grounds that "the invitee has a Rally email to act on either way":
 * the Rally email is UNUSABLE until the guest exists, so it must not exist any earlier.
 *
 * Cadence is 10s, not the SCM backfill's 30s, for that same reason — the wait is now the invitee's,
 * not a background job's — and `wakeGuestInviteRelay` makes the ordinary case immediate, with the
 * cron as the fallback for a missed publish. Still slower than the email relay's 5s because Graph is
 * rate-limited and a batch here is 10 directory writes.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHash } from 'node:crypto';
import { and, asc, eq, lt, lte, sql } from 'drizzle-orm';
import {
  InjectDrizzle,
  Span,
  AppConfigService,
  ResiliencePreset,
  leaseForResilience,
} from '@platform';
import type { DrizzleDB, DrizzleTx } from '@platform';
import { EmailSchedulerService } from '@platform/email';
import { NotificationPubSubService } from '@platform/notifications';
import { AbstractOutboxRelay, NonRetryableError, dbDelay } from '@platform/outbox';
import type { Claimed, OutboxLeaseTable } from '@platform/outbox';
import { EntraGuestInviteClient, PermanentGuestInviteError } from '@modules/workspace';
import type { GuestInviteOutcome } from '@modules/workspace';
import { guestInviteOutbox } from '../../../../db/schema/messaging';
import { workspaceInvitations, workspaces } from '../../../../db/schema/workspace';

type GuestInviteRow = {
  id: string;
  attempts: number;
  invitationId: string;
  workspaceId: string;
  email: string;
  displayName: string | null;
  /** RAW invite token — present only when this row owes the invitation email. See migration 0124. */
  inviteToken: string | null;
};

@Injectable()
export class EntraGuestInviteRelayService
  extends AbstractOutboxRelay<GuestInviteRow, GuestInviteOutcome>
  implements OnModuleInit, OnModuleDestroy
{
  /**
   * Graph throttles, and a batch is held for the SUM of its rows' leases (3 min each): 5 rows is 15 minutes if
   * a worker dies holding them.
   */
  protected override readonly batchSize = 5;

  private unsubscribeRelayWake?: () => Promise<void>;

  constructor(
    @InjectDrizzle() db: DrizzleDB,
    private readonly client: EntraGuestInviteClient,
    private readonly config: AppConfigService,
    private readonly emailScheduler: EmailSchedulerService,
    private readonly pubSub: NotificationPubSubService,
  ) {
    super(db);
  }

  /**
   * Woken by `GuestInviteSchedulerService`, exactly as the email relay is woken by
   * `EmailSchedulerService`. Not an optimisation any more: the invitation email is scheduled by this
   * relay, so a 10s cron tick would be latency the INVITEE waits through.
   */
  async onModuleInit(): Promise<void> {
    this.logger.log('Entra guest-invite relay started — polling guest_invite_outbox every 10s');
    this.unsubscribeRelayWake = await this.pubSub.subscribeGuestInviteRelayWake(() => {
      this.relay().catch((err: unknown) =>
        this.logger.error({ err }, 'Guest-invite relay triggered by wake signal failed'),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.unsubscribeRelayWake?.();
  }

  /**
   * THE FLAG GATES ENQUEUEING, NOT DRAINING — so there is no flag check here any more.
   *
   * This used to return before polling while `ENTRA_GUEST_INVITE_ENABLED` was off, on the grounds
   * that rows queued before it flipped should be "left alone rather than failed". That was defensible
   * while a queued row only owed a directory write; it is not now that the row also owes the
   * invitation EMAIL. Leaving it alone would strand both for ever and the invitee would never hear
   * anything at all — the worst of the three outcomes, and a silent one.
   *
   * So a committed intent is always drained. The flag's job is to stop NEW Graph traffic
   * (`GuestInviteSchedulerService` still writes nothing while it is off, which is what keeps a
   * pre-consent deployment from dead-lettering every invitation), and if a drained row now fails
   * because consent was revoked, it dead-letters LOUDLY: `DEAD_LETTER_FIELD` is what the CloudWatch
   * alarm matches, and cancel-and-re-invite is the operator's fix. Silence with an alarm beats silence
   * without one. The cost is one indexed partial-index lookup per 10s per worker for a dormant
   * feature, which is what the other five relays already pay.
   */
  @Cron('*/10 * * * * *', { name: 'entra-guest-invite-relay' })
  @Span('entra.guestInvite.relay')
  override async relay(): Promise<void> {
    return super.relay();
  }

  // ── AbstractOutboxRelay implementation ────────────────────────────────────

  protected readonly outbox: OutboxLeaseTable = {
    table: guestInviteOutbox,
    id: guestInviteOutbox.id,
    status: guestInviteOutbox.status,
    attempts: guestInviteOutbox.attempts,
    lastError: guestInviteOutbox.lastError,
    leaseToken: guestInviteOutbox.leaseToken,
    lockedUntil: guestInviteOutbox.lockedUntil,
    seq: guestInviteOutbox.seq,
  };

  /** One Graph invitation: ResiliencePreset.EXTERNAL_API (four executions of 30 s) plus the margin. */
  protected override leaseMsFor(): number {
    return leaseForResilience(ResiliencePreset.EXTERNAL_API);
  }

  /**
   * A reaped (abandoned) row is dead-lettered WITHOUT `markFailed`, so it must lose its raw bearer token the same
   * way a terminal failure does (migration 0124: a row holds a live credential only between enqueue and the Graph
   * call). Merged into the reaper's UPDATE; without it the token of an abandoned invitation stayed in the table.
   */
  protected override reapColumns(): Record<string, unknown> {
    return { inviteToken: null };
  }

  protected async selectDue(tx: DrizzleTx, limit: number): Promise<GuestInviteRow[]> {
    return tx
      .select({
        id: guestInviteOutbox.id,
        attempts: guestInviteOutbox.attempts,
        invitationId: guestInviteOutbox.invitationId,
        workspaceId: guestInviteOutbox.workspaceId,
        email: guestInviteOutbox.email,
        displayName: guestInviteOutbox.displayName,
        inviteToken: guestInviteOutbox.inviteToken,
      })
      .from(guestInviteOutbox)
      .where(
        and(
          eq(guestInviteOutbox.status, 'pending'),
          lt(guestInviteOutbox.attempts, this.maxAttempts),
          lte(guestInviteOutbox.scheduledAt, sql`now()`),
          this.notLeased(),
        ),
      )
      .orderBy(
        asc(guestInviteOutbox.scheduledAt),
        asc(guestInviteOutbox.seq),
        asc(guestInviteOutbox.id),
      )
      .limit(limit)
      .for('update', { skipLocked: true });
  }

  /**
   * The Graph call. NO transaction is open. A Graph refusal is rethrown as `NonRetryableError`, which the
   * base class dead-letters on the FIRST attempt — by ERROR TYPE, never by message text: the client raises
   * `PermanentGuestInviteError` for a status Graph cannot answer differently next time (a rejected address —
   * `+` and ~25 other characters are refused outright — B2B invitations disabled tenant-wide, or a missing
   * `User.Invite.All` consent), and throws a plain `Error` for 5xx / 429 / 408 / network faults, which keep
   * the full retry budget.
   */
  protected async deliver(row: Claimed<GuestInviteRow>): Promise<GuestInviteOutcome> {
    let outcome: GuestInviteOutcome;
    try {
      outcome = await this.client.invite({ email: row.email, displayName: row.displayName });
    } catch (err) {
      if (err instanceof PermanentGuestInviteError) throw new NonRetryableError(err.message);
      throw err;
    }

    if (outcome.outcome === 'already-in-directory') {
      this.logger.log(
        { invitationId: row.invitationId, workspaceId: row.workspaceId },
        'No Entra guest created — the invited address already resolves to a directory object',
      );
    }
    return outcome;
  }

  /**
   * The writes that must commit atomically with the row going to `sent`, in the fenced finish transaction:
   * the guest's `oid` on the invitation and the invitation EMAIL (migration 0124).
   */
  protected async settle(
    row: Claimed<GuestInviteRow>,
    outcome: GuestInviteOutcome,
    tx: DrizzleTx,
  ): Promise<void> {
    if (outcome.outcome === 'invited' && outcome.guestObjectId) {
      /**
       * The guest's `oid` in OUR tenant, on the invitation, in the SAME transaction as the sent
       * marker — the two facts must not be able to disagree.
       *
       * NOTHING BINDS AUTHORIZATION TO IT YET, deliberately. `WorkspaceService.acceptInvitation`
       * keeps binding on the email claim (`INVITATION_EMAIL_MISMATCH`), which is the only fact that
       * always exists at accept time: the column is NULL for every staff invitation and for every
       * one sent while the flag was off. Binding on the oid is the security-correct end state —
       * Microsoft is explicit that apps should never use the email claim for authorization purposes
       * — and it needs a follow-up. It is closer than it was: with the email now scheduled here, an
       * invitee cannot normally hold a link whose provisioning has not run.
       */
      await tx
        .update(workspaceInvitations)
        .set({ entraGuestObjectId: outcome.guestObjectId, updatedAt: sql`now()` })
        .where(eq(workspaceInvitations.id, row.invitationId));
    }

    /**
     * BOTH success outcomes schedule the invitation email, in this transaction (migration 0124):
     *
     *   - `invited` — the guest object exists, so the link is usable. A null `guestObjectId` is
     *     still this case: Graph accepted the invitation and merely did not echo the id.
     *   - `already-in-directory` — the invited address is a directory MEMBER already (the ordinary
     *     outcome for a staff mailbox), so they can authenticate without a guest and needed nothing
     *     provisioned.
     *
     * A FAILURE deliberately schedules nothing; `markFailed` says why.
     */
    await this.scheduleInviteEmail(tx, row);
  }

  protected async markSent(
    tx: DrizzleTx,
    row: Claimed<GuestInviteRow>,
    outcome: GuestInviteOutcome,
  ): Promise<void> {
    await tx
      .update(guestInviteOutbox)
      .set({
        status: 'sent',
        sentAt: sql`now()`,
        /**
         * A non-fatal explanation on a SENT row: without it, "sent, yet the invitation carries no
         * guest id" has no answer on the row itself, and that is the ordinary outcome for a staff
         * mailbox. Cleared on the success path so a retry that finally worked does not keep an
         * earlier note.
         */
        lastError: outcome.outcome === 'already-in-directory' ? outcome.detail : null,
        /**
         * Scrubbed the moment it can no longer be needed. The email is scheduled in this same
         * transaction (`settle`), so a `sent` row never keeps a live bearer credential — see
         * migration 0124's security assessment, of which this is the load-bearing half.
         */
        inviteToken: null,
      })
      .where(eq(guestInviteOutbox.id, row.id));
  }

  /**
   * Enqueue the invitation email now that the invitee can actually sign in.
   *
   * `EmailSchedulerService` is reused rather than reimplemented, with `invitation.id` as the
   * idempotency key — the SAME key `WorkspaceService` uses on the flag-off path. `email_outbox`
   * dedups on it with `ON CONFLICT DO NOTHING`, so a flag flipped between enqueue and this pass, or
   * a retried Graph call, cannot produce two invitation emails for one invitation.
   *
   * Two refusals, both of which mean the link this row holds is no longer the live one:
   *
   *   - `status !== 'pending'` — cancelled, already accepted, or superseded by
   *     `cancelExistingForEmail` when the same address was re-invited.
   *   - a token hash that no longer matches — `resendInvitation` ROTATED the token and mailed the
   *     new one inline, so mailing this one would send a dead link (and a second email).
   *
   * Both are checked against the invitation row rather than assumed, because this pass runs after an
   * unbounded network call and up to five backoff windows.
   */
  private async scheduleInviteEmail(tx: DrizzleTx, row: GuestInviteRow): Promise<void> {
    // No token means this row owes no email: a `resendInvitation` re-enqueue (which mailed inline),
    // or a row queued before migration 0124.
    if (!row.inviteToken) return;

    const [invitation] = await tx
      .select({
        status: workspaceInvitations.status,
        tokenHash: workspaceInvitations.tokenHash,
        // Days remaining, computed by the database's own now() in this statement (not the host clock).
        expiresInDays: sql<number>`greatest(1, ceil(extract(epoch from (${workspaceInvitations.expiresAt} - now())) / 86400))::int`,
      })
      .from(workspaceInvitations)
      .where(eq(workspaceInvitations.id, row.invitationId))
      .limit(1);

    const tokenHash = createHash('sha256').update(row.inviteToken).digest('hex');
    if (!invitation || invitation.status !== 'pending' || invitation.tokenHash !== tokenHash) {
      this.logger.warn(
        {
          invitationId: row.invitationId,
          status: invitation?.status ?? 'missing',
          tokenCurrent: invitation?.tokenHash === tokenHash,
        },
        'Guest provisioned, but the invitation link it carried is no longer the live one — no email scheduled',
      );
      return;
    }

    const [workspace] = await tx
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, row.workspaceId))
      .limit(1);
    if (!workspace) return;

    /**
     * Days REMAINING, from the invitation's own `expires_at` — not `INVITATION_TTL_DAYS`. The mail
     * leaves after provisioning and possibly after several backoff windows, so the configured TTL
     * would overstate the window the invitee actually has. Floored at 1: a "0 days" invitation reads
     * as already dead, and an invitation whose window has closed is refused at accept time anyway.
     */
    await this.emailScheduler.schedule(
      {
        to: row.email,
        template: 'workspace-invitation',
        vars: {
          inviteUrl: `${this.config.get('APP_BASE_URL')}/accept-invitation?token=${row.inviteToken}`,
          workspaceName: workspace.name,
          expiresInDays: String(invitation.expiresInDays),
          recipientEmail: row.email,
        },
        // Identical to `WorkspaceService.inviteMember`'s key, on purpose — see above.
        idempotencyKey: row.invitationId,
      },
      tx,
    );
  }

  /**
   * A FAILURE SCHEDULES NO EMAIL — neither a retryable one nor a terminal one, and the reason
   * differs for each.
   *
   * Terminal (an address Graph rejects, `User.Invite.All` unconsented, B2B invitations disabled
   * tenant-wide): the invitee has no object in our tenant and never will under the current
   * configuration, so they cannot authenticate. A link would be a dead end that reads as a broken
   * product, and worse, it would consume the invitation's one-shot token on a login that cannot
   * complete. The dead-letter log (`DEAD_LETTER_FIELD`, which the CloudWatch alarm matches) and
   * `last_error` are the signal. The operator action is CANCEL AND RE-INVITE: `resendInvitation`
   * schedules under the same `idempotencyKey` (`invitation.id`) with `onConflictDoNothing`, so it
   * cannot revive a row already at `failed` — only a new invitation id mints a new key.
   *
   * Retryable (5xx / 429 / 408 / network): the email simply WAITS. Scheduling it on a non-final
   * attempt would race the very ordering this relay exists to guarantee.
   */
  protected async markFailed(
    tx: DrizzleTx,
    row: Claimed<GuestInviteRow>,
    newStatus: 'pending' | 'failed',
    lastError: string,
    delayMs: number,
  ): Promise<void> {
    // `attempts` was spent at claim time.
    await tx
      .update(guestInviteOutbox)
      .set({
        status: newStatus,
        lastError,
        // Only a retry moves scheduledAt forward; a terminal row keeps its last one, and
        // selectDue never selects 'failed' again.
        ...(newStatus === 'pending' ? { scheduledAt: dbDelay(delayMs) } : {}),
        // A retry still needs the token to build the email it may yet send; a terminal row never
        // will, so it must not keep a live credential (migration 0124).
        ...(newStatus === 'failed' ? { inviteToken: null } : {}),
      })
      .where(eq(guestInviteOutbox.id, row.id));
  }
}
