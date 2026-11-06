-- Bind each account to the first verified Cloudflare Access `sub` it sees.
--
-- An Access token is mapped by email (the Entra `oid` claim does not reach the origin), and an
-- email can be reassigned. Recording the first `sub` means a later token for the same mailbox
-- with a different Access identity is refused instead of inheriting the account.
--
-- Prod-safe: nullable column with no default = metadata-only ALTER, near-instant and no rewrite.
-- The unique index is built on a handful of rows; it holds SHARE lock (blocks writes, not reads)
-- for its duration. Expected lock time on the current table (2 users): well under 50 ms; the
-- ADD COLUMN is sub-millisecond. No backfill: NULL means "not bound yet".
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "access_subject" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_access_subject"
  ON "identity"."users" ("access_subject")
  WHERE "access_subject" IS NOT NULL;
