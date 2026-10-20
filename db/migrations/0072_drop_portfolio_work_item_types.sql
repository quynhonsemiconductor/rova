-- ============================================================================
-- Remove `initiative` and `feature` from work_item_type.
--
-- A Feature is a PORTFOLIO ITEM, not a schedulable work item. Migration 0071 added
-- `work.portfolio_items`, so leaving these values in place meant two tables both
-- minting `FE-` keys and both meaning "Feature" — a collision waiting for the first
-- duplicate key.
--
-- Both Rally and the BA spec model it the same way. Rally keeps `PortfolioItem` and
-- `HierarchicalRequirement` (User Story) as SEPARATE object families joined by a
-- field, where only the lowest portfolio level attaches to the story hierarchy; the
-- BA spec gives a Feature an 11-value portfolio state, its own Preliminary/Refined
-- estimates and rollups FROM linked stories. None of that fits a work item, which
-- already carries schedule state and lives in the Backlog.
--
-- `task` STAYS. Tasks live in `work.tasks` (P3 refactor), but the work-items
-- repository still projects a task row into a WorkItem shape with type 'task' for
-- service compatibility (`mapTaskRow`), so the value is load-bearing even though
-- nothing inserts a task into work_items.
--
-- SAFE TO DROP: zero rows of either type exist. Verified against both environments
-- on 2026-07-29 — develop held 1 story + 1 defect, production was empty. Nothing in
-- the codebase created them either; the two values were vestigial from a portfolio
-- model that predated Phase 5.
--
-- Recreate rather than a hypothetical `ALTER TYPE ... DROP VALUE` (which Postgres
-- does not support at all), following the pattern established in 0063: drizzle runs
-- every pending migration in ONE transaction, and a fresh CREATE TYPE has all its
-- values usable immediately in that same transaction.
-- ============================================================================

-- Fail loudly rather than silently discarding data if this ever runs somewhere the
-- assumption does not hold. The USING cast below would raise its own error on an
-- unmappable value, but this says WHY.
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
  FROM "work"."work_items"
  WHERE "type"::text IN ('initiative', 'feature');

  IF offending > 0 THEN
    RAISE EXCEPTION
      'Cannot drop initiative/feature from work_item_type: % row(s) still use them. '
      'Migrate them into work.portfolio_items first (see migration 0071).', offending;
  END IF;
END $$;--> statement-breakpoint

-- FOUR partial indexes carry `type = '…'` in their PREDICATE, which stores a literal
-- bound to the enum type. Renaming the type leaves those literals bound to
-- `work_item_type_old` while the column becomes the new `work_item_type`, and the
-- rebuild fails with:
--
--   operator does not exist: work_item_type = work_item_type_old
--
-- 0063 did not hit this because `activity_logs.entity_type` has no predicate index.
-- Dropping them first and recreating them afterwards is the whole fix — ALTER COLUMN
-- rebuilds every index on the table regardless, so nothing is lost either way.
--
--   ix_wi_tasks              type = 'task'    (0035, schema work.ts)
--   ix_wi_found_in_release   type = 'defect'  (0031)
--   ix_wi_defect_severity    type = 'defect'  (0031)
--   ix_wi_defect_root_cause  type = 'defect'  (0032)
--   ix_wi_defect_resolution  type = 'defect'  (0032)
DROP INDEX IF EXISTS "work"."ix_wi_tasks";--> statement-breakpoint
DROP INDEX IF EXISTS "work"."ix_wi_found_in_release";--> statement-breakpoint
DROP INDEX IF EXISTS "work"."ix_wi_defect_severity";--> statement-breakpoint
DROP INDEX IF EXISTS "work"."ix_wi_defect_root_cause";--> statement-breakpoint
DROP INDEX IF EXISTS "work"."ix_wi_defect_resolution";--> statement-breakpoint

ALTER TYPE "public"."work_item_type" RENAME TO "work_item_type_old";--> statement-breakpoint
CREATE TYPE "public"."work_item_type" AS ENUM ('story', 'task', 'defect');--> statement-breakpoint
ALTER TABLE "work"."work_items"
  ALTER COLUMN "type" TYPE "public"."work_item_type"
  USING "type"::text::"public"."work_item_type";--> statement-breakpoint

-- Second consumer of the type: the per-workspace key sequence
-- (`workspace_item_counters.item_type` → `US-42`, `DE-7`, `TA-3`). It must be swapped
-- too or DROP TYPE fails with "column item_type ... depends on type
-- work_item_type_old".
--
-- Any `initiative`/`feature` counter rows are dropped rather than cast: those
-- prefixes (IN/FE) no longer exist, a counter for a type nothing can create is dead
-- weight, and portfolio items mint their own keys from work.portfolio_items.
DELETE FROM "work"."workspace_item_counters" WHERE "item_type"::text IN ('initiative', 'feature');--> statement-breakpoint
ALTER TABLE "work"."workspace_item_counters"
  ALTER COLUMN "item_type" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "work"."workspace_item_counters"
  ALTER COLUMN "item_type" TYPE "public"."work_item_type"
  USING "item_type"::text::"public"."work_item_type";--> statement-breakpoint
ALTER TABLE "work"."workspace_item_counters"
  ALTER COLUMN "item_type" SET DEFAULT 'story';--> statement-breakpoint

DROP TYPE "public"."work_item_type_old";--> statement-breakpoint

-- Recreated identically to their original definitions, now bound to the new type.
CREATE INDEX "ix_wi_tasks" ON "work"."work_items" ("parent_id", "rank")
  WHERE "type" = 'task' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_wi_found_in_release" ON "work"."work_items" ("found_in_release_id")
  WHERE "type" = 'defect' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_wi_defect_severity" ON "work"."work_items" ("workspace_id", "severity")
  WHERE "type" = 'defect' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_wi_defect_root_cause" ON "work"."work_items" ("root_cause")
  WHERE "type" = 'defect' AND "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_wi_defect_resolution" ON "work"."work_items" ("resolution")
  WHERE "type" = 'defect' AND "deleted_at" IS NULL;
