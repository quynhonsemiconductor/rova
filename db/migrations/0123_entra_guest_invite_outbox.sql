-- An invited external collaborator is provisioned as a Microsoft Entra B2B GUEST, through a
-- transactional outbox.
--
-- Rally's invitation is the authorization gate and stays exactly that. What was missing is the
-- IDENTITY half: a collaborator on a non-staff mailbox has no object in our tenant, so the BFF
-- login they are sent to cannot authenticate them at all. Entra B2B fixes that without Rally
-- holding a password — the guest proves the mailbox through their own Microsoft work account,
-- Google federation, or an emailed one-time passcode — and their `oid` in OUR tenant is what
-- every later login carries.
--
-- WHY AN OUTBOX AND NOT AN INLINE CALL. The provisioning call is HTTP to Microsoft Graph, and
-- `libs/modules/attachments/src/application/entity-attachments.service.ts:106-110` states this
-- repo's rule for exactly this shape: "holding a Postgres transaction open across a network
-- round-trip to object storage is worse than the gap it would close". A fire-and-forget call after
-- commit is not the alternative either — a failure there leaves a Rally invitation whose Entra
-- guest was never created, and the only symptom is the invitee's login being refused as
-- `AUTH_TOKEN_INVALID`, which names nothing. So the INTENT is written in the invite transaction
-- (it cannot exist without the invitation, and cannot be lost if the invitation rolls back) and a
-- worker relay owns the call, its retries and its dead-lettering.
--
-- Modelled column-for-column on `messaging.email_outbox` (migration 0007) — same status enum,
-- same `attempts` / `last_error` / `sent_at` / `scheduled_at`, same UNIQUE `idempotency_key`, same
-- partial index on the relay's polling predicate. Deliberately not "reuse email_outbox with a
-- different template": the payload is not an email, the relay target is not IEmailProvider, and a
-- second consumer of that table would compete with the email relay for its rows.
--
-- NO BACKFILL IS OWED, and that is a statement rather than an omission — the same one migration
-- 0119 makes. The ABSENCE of a guest object IS today's behaviour for every invitation ever sent:
-- no guest was created for any of them, so there is nothing to preserve and nothing to invent.
-- Compare `0101_capacity_allocation_fixed_value.sql`, where a grain change over existing rows had
-- to freeze today's resolved value in the same migration; that rule applies when a read path
-- changes meaning, and here it does not.

-- ── Enum ──────────────────────────────────────────────────────────────────────
--
-- Its own type, matching the other three outboxes (`outbox_status`, `email_job_status`,
-- `notification_job_status`) rather than borrowing one of theirs: the values happen to coincide
-- today, and a queue that has to add a state must be able to without moving another queue's type.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'guest_invite_job_status') THEN
    CREATE TYPE guest_invite_job_status AS ENUM ('pending', 'sent', 'failed');
  END IF;
END
$$;

-- ── Table ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS messaging.guest_invite_outbox (
  id               UUID                     PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The invitation this provisioning intent belongs to. A REAL foreign key, unlike
  -- `email_outbox`, because there is a row to point at and cascading is the right answer: an
  -- invitation that no longer exists must not still be provisioning a directory guest for the
  -- address it named. (Invitations are status-flipped rather than deleted on every path we have
  -- today, so in practice this is an integrity guarantee, not a live cleanup path.)
  invitation_id    UUID                     NOT NULL,
  -- Denormalised like `email_outbox.workspace_id`, so a log line or a triage query has the
  -- workspace without a join.
  workspace_id     UUID                     NOT NULL,
  -- The invited address, RFC 5321 max — the same width and the same normalised (lowercased,
  -- trimmed) value the invitation carries. Copied rather than joined so the relay sends the
  -- address that was INVITED even if the invitation row is later rotated by a resend.
  email            VARCHAR(320)             NOT NULL,
  -- Optional `invitedUserDisplayName` for Graph. NULL when the inviter supplied no name, which is
  -- every path we have today; Entra then derives one from the address.
  display_name     VARCHAR(255),
  status           guest_invite_job_status  NOT NULL DEFAULT 'pending',
  attempts         INTEGER                  NOT NULL DEFAULT 0,
  -- Carries the Graph refusal verbatim (its `error.code` + message) on a failure. It ALSO records
  -- a non-fatal explanation on a row that ended `sent` with no guest created — the address
  -- already resolving to a directory object is the ordinary case for a staff mailbox, and without
  -- a note here "sent, but the invitation has no guest id" has no answer on the row itself.
  last_error       TEXT,
  sent_at          TIMESTAMPTZ,
  scheduled_at     TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ              NOT NULL DEFAULT NOW(),
  -- Deduplication, same convention as `email_outbox`: the caller supplies `invitation.id`, so a
  -- retried POST /workspaces/:id/invitations cannot enqueue two Graph invitations for one
  -- invitation. Written with ON CONFLICT DO NOTHING inside the invite transaction.
  idempotency_key  VARCHAR(255)             UNIQUE,
  CONSTRAINT fk_gio_invitation FOREIGN KEY (invitation_id)
    REFERENCES workspace.workspace_invitations (id) ON DELETE CASCADE
);

-- The relay's polling query, verbatim: status = 'pending' ORDER BY scheduled_at.
CREATE INDEX IF NOT EXISTS ix_guest_invite_outbox_status
  ON messaging.guest_invite_outbox (status, scheduled_at)
  WHERE status = 'pending';

-- Triage reads are always "the rows for this invitation".
CREATE INDEX IF NOT EXISTS ix_guest_invite_outbox_invitation
  ON messaging.guest_invite_outbox (invitation_id);

-- ── The guest's object id, on the invitation ──────────────────────────────────
--
-- `invitedUser.id` from the Graph response: the guest's `oid` in our tenant, which is the claim
-- every subsequent login of theirs carries.
--
-- NOTHING READS IT FOR AUTHORIZATION YET, deliberately. `WorkspaceService.acceptInvitation` binds
-- on the email claim (`INVITATION_EMAIL_MISMATCH`) and must keep doing so while provisioning is
-- ASYNCHRONOUS: the relay may not have run when the invitee clicks their link, so the oid can
-- legitimately still be NULL at accept time and a binding on it would refuse a valid acceptance.
-- Binding on the oid is the security-correct end state — Microsoft is explicit that "apps should
-- never use the email claim for authorization purposes" — and it needs a follow-up once
-- provisioning is synchronous or the accept path is gated on the row being present.
ALTER TABLE workspace.workspace_invitations
  ADD COLUMN IF NOT EXISTS entra_guest_object_id UUID;
