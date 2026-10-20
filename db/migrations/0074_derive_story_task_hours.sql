-- ============================================================================
-- Drop the three hours columns from work.work_items.
--
-- Story/Defect hours are DERIVED from child tasks, which is what both Rally and the
-- BA SRS specify (P1-TASK-01: "Actual is a manual per-task input"). Two facts made
-- these columns safe to remove rather than backfill:
--
--   1. Iteration Status ALREADY derives To Do and Actual with
--      `coalesce(sum(t.todo_hours), 0)` over child tasks, so the stored columns were
--      only ever read by the work-item list/detail — two surfaces that could report
--      different hours for the same story.
--
--   2. Every value was NULL. The create/update DTOs accepted these fields, so the
--      write path existed, but no row in any environment ever carried a value. There
--      is nothing to preserve.
--
-- The `tasks` table keeps its own estimate_hours/todo_hours/actual_hours — those are
-- the real per-task inputs and the source the sums read from.
--
-- Verified before writing this: `select ... where estimate_hours is not null or
-- todo_hours is not null or actual_hours is not null` returned 0 rows.
-- ============================================================================

ALTER TABLE "work"."work_items" DROP COLUMN IF EXISTS "estimate_hours";--> statement-breakpoint
ALTER TABLE "work"."work_items" DROP COLUMN IF EXISTS "todo_hours";--> statement-breakpoint
ALTER TABLE "work"."work_items" DROP COLUMN IF EXISTS "actual_hours";
