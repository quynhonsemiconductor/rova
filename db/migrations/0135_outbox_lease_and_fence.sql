-- Every outbox relay stops holding a transaction across its external call.
--
-- LEASE-AND-FENCE columns on the six tables the relays drain: seq (claim order), lease_token (who holds
-- the row), locked_until (when the hold lapses). A relay claims rows in a short transaction
-- (attempts = attempts + 1, a fresh lease_token), calls out with NO transaction open, and finishes in a new
-- one fenced on lease_token.
--
-- Why: AbstractOutboxRelay opened ONE transaction, locked a batch FOR UPDATE SKIP LOCKED, made every external
-- call inside it (Microsoft Graph for entra-guest-invite, GitHub for scm-backfill, the mail provider) and
-- committed at the end. rova_worker has idle_in_transaction_session_timeout = 300s (migrations 0073, 0128); a
-- batch whose calls outlasted it had its SESSION killed, which rolled back the batch AND its attempt counters, so
-- the row never reached maxAttempts, never dead-lettered, and was retried for ever with nothing in the logs.
--
-- NO BACKFILL. `seq` is assigned to existing rows in physical order by ADD COLUMN ... bigserial; their ordering
-- was never meaningful. lease_token and locked_until start NULL, i.e. "nobody holds it".
--
-- LOCKING — READ THIS BEFORE DEPLOYING.
--   Each ADD COLUMN ... bigserial REWRITES its table under an ACCESS EXCLUSIVE lock, and drizzle runs every pending
--   migration in ONE transaction, so the six locks are acquired one after another and ALL are held until the end.
--   The previous worker holds FOR UPDATE transactions on these tables for up to idle_in_transaction_session_timeout
--   (300 s), and an ALTER queued behind one blocks every later reader and writer of that table, the API's
--   included. So:
--     1. `lock_timeout = 5s` below: if a lock cannot be taken, the migration FAILS FAST and rolls back instead of
--        queueing API writes behind it. The deploy retries (re-run the migrator).
--     2. The tables are altered from the least to the most API-hot, `outbox_events` (every business write inserts
--        into it) LAST, so it is locked for the shortest time.
--     3. The WORKER MUST BE STOPPED (desired count 0) BEFORE the migrator runs, and started after. The old worker
--        is also what would double-deliver during a rolling deploy: its fetchBatch has no lease filter, so it
--        re-reads rows the new worker has leased, and SES has no idempotency key. The migrator-then-roll order of
--        backend-deploy.yml does not do this; it is a required manual step until the reusable workflow gains one
--        (see the PR description).
--
-- ROW COUNTS / RETENTION. Only scm.webhook_inbox is swept (apps/worker/src/cron/cleanup.cron.ts). The other five
-- tables (outbox_events, email_outbox, notification_outbox, guest_invite_outbox, scm.backfill_jobs) keep their
-- `sent`/`published`/`done` rows for ever, so the rewrite grows with the deployment's age. Retention for them is
-- tracked in a separate issue.

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "messaging"."guest_invite_outbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scm"."backfill_jobs"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "scm"."webhook_inbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messaging"."notification_outbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "messaging"."email_outbox"
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
-- outbox_events LAST (see LOCKING). It also gets scheduled_at, the retry backoff the other outboxes have always
-- had: it had none, so the audit projection re-read a failed row on the very next tick, and with attempts now spent
-- at claim and a pass that keeps claiming, that would burn all five attempts inside one pass. DEFAULT now() is a
-- metadata-only change.
ALTER TABLE "messaging"."outbox_events"
  ADD COLUMN IF NOT EXISTS "scheduled_at" timestamp with time zone NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "seq" bigserial NOT NULL,
  ADD COLUMN IF NOT EXISTS "lease_token" uuid,
  ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
--> statement-breakpoint
-- The setting was transaction-local, but the same transaction carries any later pending migration: give it back.
RESET lock_timeout;
