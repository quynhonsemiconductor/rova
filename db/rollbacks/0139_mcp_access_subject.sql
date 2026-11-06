-- Rollback for 0139_mcp_access_subject.sql.
-- Run as the migration role, OUTSIDE drizzle's migrator (which is forward-only).
--
-- Dropping the column destroys every first-bind. Reapplying 0139 after a rollback leaves the
-- accounts unbound, so the next MCP call binds whoever presents that mailbox first. That is the
-- intended "administrator clears access_subject to rebind" path — but it is a security decision,
-- not routine maintenance.

SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DROP INDEX IF EXISTS "identity"."uq_users_access_subject";
--> statement-breakpoint
ALTER TABLE "identity"."users" DROP COLUMN IF EXISTS "access_subject";
