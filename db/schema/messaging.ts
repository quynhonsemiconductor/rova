/**
 * messaging schema — outbox_events, email_outbox, notification_outbox, guest_invite_outbox
 * Canonical DDL: 05_Architecture/DATABASE_SCHEMA.md §9
 */
import {
  pgSchema,
  uuid,
  varchar,
  integer,
  timestamp,
  jsonb,
  text,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { outboxLease } from './outbox-lease';
import {
  outboxStatusEnum,
  emailJobStatusEnum,
  notificationJobStatusEnum,
  guestInviteJobStatusEnum,
} from './enums';

export const messagingSchema = pgSchema('messaging');

export const outboxEvents = messagingSchema.table(
  'outbox_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id').notNull(),
    eventType: varchar('event_type', { length: 255 }).notNull(),
    version: integer('version').notNull().default(1),
    aggregateType: varchar('aggregate_type', { length: 100 }).notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    payload: jsonb('payload').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When a failed projection may be retried (the relay's backoff). The other outboxes have always had a
     * column for this; this one re-read a failed row on the very next tick, which the lease-and-fence relay
     * would turn into five attempts inside one pass. Migration 0135.
     */
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * W3C traceparent of the request that enqueued this event, so the relay can
     * continue that trace rather than starting an unrelated one. NULL when nothing
     * was tracing (pre-column rows, or a writer with no active span).
     */
    traceparent: varchar('traceparent', { length: 64 }),
    ...outboxLease(),
    // Partition column — see DATABASE_SCHEMA.md §8 for monthly range partitioning
    partitionKey: timestamp('partition_key', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index('ix_outbox_status')
      .on(t.status, t.createdAt)
      .where(sql`status = 'pending'`),
    workspaceIdx: index('ix_outbox_workspace').on(t.workspaceId),
    eventIdIdx: index('ix_outbox_event_id').on(t.eventId),
  }),
);

/**
 * email_outbox — transactional email job queue.
 *
 * API-side services INSERT rows in the SAME DB transaction that writes the
 * business data (e.g. password_reset_tokens). The worker EmailRelayService
 * polls this table, renders the named template, and dispatches via
 * IEmailProvider. Guarantees at-least-once delivery with no dual-write.
 *
 *   template — key into EmailTemplateRegistry ('password-reset', 'workspace-invitation', …)
 *   vars     — opaque JSONB passed to the template renderer
 *   attempts — incremented on send failure; relay stops at MAX_ATTEMPTS
 */
export const emailOutbox = messagingSchema.table(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Recipient address (RFC 5321 max 320 chars). */
    to: varchar('to', { length: 320 }).notNull(),
    template: varchar('template', { length: 100 }).notNull(),
    vars: jsonb('vars').notNull().default({}),
    status: emailJobStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Caller-supplied deduplication key (nullable for legacy rows).
     * UNIQUE constraint prevents the same business event from producing two
     * email_outbox rows even under concurrent API retries.
     *
     * Convention:
     *   password-reset       → sha256('password-reset:' + tokenHash)
     *   workspace-invitation → invitation.id
     *   future notifications → notification.id
     *
     * Insert uses ON CONFLICT (idempotency_key) DO NOTHING so a duplicate
     * schedule() call is silently swallowed within the same DB transaction.
     */
    idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),
    /**
     * Optional: the internal user ID this email was scheduled for.
     * Populated for notification emails (e.g. access_request.approved).
     * NULL for transactional emails without a known recipient user
     * (e.g. password reset sent to an external address).
     * Used by EmailRelayService to check notification_preferences.
     */
    recipientId: uuid('recipient_id'),
    workspaceId: uuid('workspace_id'),
    /**
     * The provider's message id, stored by the relay at the moment of acceptance so the
     * asynchronous feedback loop can match a bounce/complaint event back to this row
     * (SES echoes it as `mail.messageId` in every event notification). NULL for rows
     * sent before this column existed, and for providers without an id (dev).
     */
    messageId: varchar('message_id', { length: 255 }),
    /** When the feedback loop recorded a bounce or complaint. NULL unless it did. */
    feedbackAt: timestamp('feedback_at', { withTimezone: true }),
    ...outboxLease(),
  },
  (t) => ({
    statusIdx: index('ix_email_outbox_status')
      .on(t.status, t.scheduledAt)
      .where(sql`status = 'pending'`),
    // The feedback loop's only lookup: match an inbound SES event to its row. Partial
    // because only `sent` rows carry a message id worth matching.
    messageIdIdx: index('ix_email_outbox_message_id')
      .on(t.messageId)
      .where(sql`message_id IS NOT NULL`),
  }),
);

/**
 * notification_outbox — transactional outbox for in-app notifications.
 *
 * API-side services INSERT rows in the SAME DB transaction as their business
 * data (NotificationSchedulerService). The worker NotificationRelayService
 * polls this table, renders the notification template, and dispatches via
 * NotificationsService.send() → in_app_notifications.
 *
 * Guarantees at-least-once delivery, no dual-write, deduplication via
 * idempotency_key + source_event_id on the in_app_notifications table.
 *
 *   type     — key into NotificationTemplateRegistry ('WORKSPACE_INVITATION', …)
 *   vars     — opaque JSONB passed to the template renderer
 *   resource_id — UUID of the resource this notification links to (nullable)
 */
export const notificationOutbox = messagingSchema.table(
  'notification_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    recipientId: uuid('recipient_id').notNull(),
    actorId: uuid('actor_id'),
    type: varchar('type', { length: 100 }).notNull(),
    vars: jsonb('vars').notNull().default({}),
    /** UUID of the resource this notification links to (work item, workspace, etc.) */
    resourceId: uuid('resource_id'),
    status: notificationJobStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    ...outboxLease(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Caller-supplied deduplication key (nullable for rows without a stable key).
     * UNIQUE constraint prevents duplicate outbox rows for the same business event.
     *
     * Convention (mirror of email_outbox):
     *   workspace-invitation → invitation.id
     *   work-item-assigned   → sha256('assigned:' + assignmentId)
     *
     * This same value is passed as sourceEventId to in_app_notifications for
     * end-to-end idempotency across relay retries.
     */
    idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),
  },
  (t) => ({
    statusIdx: index('ix_notification_outbox_status')
      .on(t.status, t.scheduledAt)
      .where(sql`status = 'pending'`),
  }),
);

/**
 * guest_invite_outbox — transactional outbox for Microsoft Entra B2B GUEST provisioning
 * (migration 0123).
 *
 * `WorkspaceService.inviteMember` INSERTs a row in the SAME transaction that creates the
 * invitation, so the provisioning intent cannot outlive a rolled-back invite and cannot be lost by
 * one that committed. The worker's `EntraGuestInviteRelayService` polls it and calls
 * `POST https://graph.microsoft.com/v1.0/invitations` app-only, writing the returned
 * `invitedUser.id` onto `workspace.workspace_invitations.entra_guest_object_id`.
 *
 * WHY NOT AN INLINE CALL: Graph is a network round-trip, and this repo's rule against holding a
 * Postgres transaction across one is stated at
 * `libs/modules/attachments/src/application/entity-attachments.service.ts:106-110`. A
 * fire-and-forget call after commit is not the alternative either — a failure there leaves a Rally
 * invitation whose Entra guest was never created, and the invitee's login refusal surfaces only as
 * `AUTH_TOKEN_INVALID`.
 *
 * Gated by `ENTRA_GUEST_INVITE_ENABLED` (default false): until the tenant grants the app
 * registration `User.Invite.All`, every Graph call would be refused, and an invitation must not
 * break because of it. Flag off → no row is written at all.
 *
 *   email        — the invited address, already normalised (lowercased, trimmed)
 *   display_name — optional Graph `invitedUserDisplayName`; NULL on every path today
 *   last_error   — the Graph refusal verbatim on failure, AND a non-fatal note on a `sent` row
 *                  that created no guest (an address that already resolves to a directory object,
 *                  which is the ordinary case for a staff mailbox)
 */
export const guestInviteOutbox = messagingSchema.table(
  'guest_invite_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** FK → workspace.workspace_invitations, ON DELETE cascade (`fk_gio_invitation`). */
    invitationId: uuid('invitation_id').notNull(),
    workspaceId: uuid('workspace_id').notNull(),
    /** Recipient address (RFC 5321 max 320 chars), same width as `email_outbox.to`. */
    email: varchar('email', { length: 320 }).notNull(),
    displayName: varchar('display_name', { length: 255 }),
    status: guestInviteJobStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Caller-supplied deduplication key — `invitation.id`, the same convention `email_outbox`
     * already uses for `workspace-invitation`. UNIQUE, and inserted with
     * ON CONFLICT DO NOTHING, so a retried invite request cannot enqueue two Graph invitations.
     */
    idempotencyKey: varchar('idempotency_key', { length: 255 }).unique(),
    /**
     * The RAW (unhashed) invitation token, so the relay can build `inviteUrl` for the invitation
     * email it schedules AFTER provisioning resolves (migration 0124). Only the sha256 is kept on
     * `workspace_invitations.token_hash`, so the relay could not otherwise rebuild the link.
     *
     * NULLed by the relay in the same write that schedules the email, and on a terminal failure —
     * a row holds a live credential only between enqueue and the Graph call. NULL also MEANS "this
     * row owes no email": `resendInvitation` re-enqueues provisioning under the same key and has
     * already emailed its own rotated token inline. See migration 0124 for the security assessment.
     */
    inviteToken: varchar('invite_token', { length: 255 }),
    ...outboxLease(),
  },
  (t) => ({
    statusIdx: index('ix_guest_invite_outbox_status')
      .on(t.status, t.scheduledAt)
      .where(sql`status = 'pending'`),
    invitationIdx: index('ix_guest_invite_outbox_invitation').on(t.invitationId),
  }),
);
