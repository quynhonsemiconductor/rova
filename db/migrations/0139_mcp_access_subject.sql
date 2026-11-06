-- Bind each account to the first verified Cloudflare Access `sub` it sees.
--
-- An Access token is mapped by email (the Entra `oid` claim does not reach the origin), and an
-- email can be reassigned. Recording the first `sub` means a later token for the same mailbox
-- with a different Access identity is refused instead of inheriting the account.
--
-- LOCKING. ADD COLUMN is metadata-only (nullable, no default: no table rewrite), but it still
-- takes ACCESS EXCLUSIVE for the instant it runs, so every read and write waits behind it. The
-- unique index then holds SHARE (blocks writes, not reads) while it builds on a handful of rows.
-- `lock_timeout` below makes a blocked migration FAIL FAST and roll back instead of queueing
-- every later request behind it (the 0135 precedent). Expected duration on the current table
-- (2 users): sub-100 ms total. No backfill: NULL means "not bound yet".
--
-- ROLLBACK: db/rollbacks/0139_mcp_access_subject.sql (index, then column).
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "access_subject" varchar(255);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_access_subject"
  ON "identity"."users" ("access_subject")
  WHERE "access_subject" IS NOT NULL;
