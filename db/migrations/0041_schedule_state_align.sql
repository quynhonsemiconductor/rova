-- 0041: Align work_item_schedule_state enum to the BA flow-state vocabulary.
-- BA (mini-rally) defines 6 states with the terminal state spelled 'release':
--   idea, defined, in_progress, completed, accepted, release
-- Rally had drifted to 7 states (extra 'ready') with terminal 'released'.
--
-- Step 1 — rename the terminal value 'released' → 'release' (in place, safe).
ALTER TYPE "public"."work_item_schedule_state" RENAME VALUE 'released' TO 'release';
--> statement-breakpoint
-- Step 2 — collapse the removed 'ready' state onto 'defined' so no row uses it
-- before we drop the value. 'ready' was a Rally-only intermediate that BA does
-- not model; 'defined' is its nearest BA equivalent.
--
-- Compares via ::text rather than the enum value directly: on a from-scratch DB,
-- drizzle-orm's migrator runs every pending migration in ONE transaction, so
-- 'ready' (added by 0034_ready_state_dev_owner_p3_fixes, a separate migration
-- file, but still uncommitted from Postgres's point of view here) would trip
-- "unsafe use of new value" if compared as the enum type in that same
-- transaction. A text comparison never touches the enum's pg_enum catalog
-- entry, so the safety check doesn't apply — behaviourally identical, safe in
-- both the from-scratch (single-transaction) and already-migrated (separate,
-- already-committed transactions) cases.
UPDATE "work"."work_items" SET "schedule_state" = 'defined' WHERE "schedule_state"::text = 'ready';
--> statement-breakpoint
-- Step 3 — Postgres cannot DROP an enum value, so swap the type. Drop the column
-- default first, recreate the enum without 'ready', cast the column across, then
-- restore the default. No row references 'ready' at this point so the cast is total.
ALTER TABLE "work"."work_items" ALTER COLUMN "schedule_state" DROP DEFAULT;
--> statement-breakpoint
CREATE TYPE "public"."work_item_schedule_state_new" AS ENUM (
  'idea', 'defined', 'in_progress', 'completed', 'accepted', 'release'
);
--> statement-breakpoint
ALTER TABLE "work"."work_items"
  ALTER COLUMN "schedule_state" TYPE "public"."work_item_schedule_state_new"
  USING ("schedule_state"::text::"public"."work_item_schedule_state_new");
--> statement-breakpoint
DROP TYPE "public"."work_item_schedule_state";
--> statement-breakpoint
ALTER TYPE "public"."work_item_schedule_state_new" RENAME TO "work_item_schedule_state";
--> statement-breakpoint
ALTER TABLE "work"."work_items" ALTER COLUMN "schedule_state" SET DEFAULT 'defined';
