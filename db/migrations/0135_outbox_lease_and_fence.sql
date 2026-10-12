-- Every outbox relay stops holding a transaction across its external call.
--
-- LEASE-AND-FENCE columns on the six tables the relays drain: seq (claim order), lease_token (who holds
-- the row), locked_until (when the hold lapses). A relay claims rows in a short transaction
-- (attempts = attempts + 1, a fresh lease_token), calls out with NO transaction open, and finishes in a new
-- one fenced on lease_token.
--
-- Why: AbstractOutboxRelay opened ONE transaction, locked a batch FOR UPDATE SKIP LOCKED, made every external
-- call inside it (Microsoft Graph for entra-guest-invite, GitHub for scm-backfill, the mail provider) and
-- committed at the end. rally_worker has idle_in_transaction_session_timeout = 300s (migration 0073); a batch
-- whose calls outlasted it had its SESSION killed, which rolled back the batch AND its attempt counters, so the
-- row never reached maxAttempts, never dead-lettered, and was retried for ever with nothing in the logs.
--
-- NO BACKFILL. `seq` is assigned to existing rows in physical order by ADD COLUMN ... bigserial; their ordering
-- was never meaningful. lease_token and locked_until start NULL, i.e. "nobody holds it".
--
-- ADD COLUMN bigserial rewrites each table once (an ACCESS EXCLUSIVE lock for the duration). These outboxes are
-- small: sent rows are swept by the cleanup cron.

-- outbox_events also gets scheduled_at, the retry backoff the other outboxes have always had. It had none, so the
-- audit projection re-read a failed row on the very next tick; with attempts now spent at claim and a pass that
-- keeps claiming, that would burn all five attempts inside one pass. DEFAULT now() is a metadata-only change.
ALTER TABLE "messaging"."outbox_events"
  ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messaging"."email_outbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messaging"."notification_outbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messaging"."guest_invite_outbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scm"."webhook_inbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scm"."backfill_jobs"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
