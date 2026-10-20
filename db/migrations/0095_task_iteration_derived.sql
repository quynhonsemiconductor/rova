-- A Task's Iteration is DERIVED from its parent Story/Defect, and cannot diverge.
--
-- ── the rule, and where it comes from ───────────────────────────────────────
-- The BA is explicit and says it three times:
--   • "A Task inherits Project, Team, Iteration and Release/Milestone context THROUGH ITS
--     PARENT Story/Defect."                                    (BUSINESS_BASELINE.md)
--   • "Task inherits parent Iteration … the Task is counted in the parent's new Iteration
--     and has NO INDEPENDENT ITERATION SELECTOR."              (P1-TASK-011, marked Pass)
--   • "All child Tasks contribute to the new Iteration metrics WITHOUT AN INDEPENDENT
--     TASK ITERATION ASSIGNMENT."                              (P2-IS-024)
-- Real Rally agrees: a Task's Iteration is read-only and shown from its parent.
--
-- That is stronger than "cascade the value when the parent moves". A cascade implies the
-- Task owns a value that is kept in step; the contract is that it owns no value at all.
-- `work.tasks.iteration_id` therefore stops being independently writable and becomes a
-- maintained mirror.
--
-- ── why a trigger, and not the service ──────────────────────────────────────
-- Two paths wrote this column and neither propagated a parent move:
-- `createTask` (`opts.iterationId ?? parent.iterationId` — an explicit value simply won)
-- and the task branch of `update()` (`if (input.iterationId !== undefined) …`). Nothing
-- read the parent again afterwards.
--
-- The service is also demonstrably not the only writer. `db/seeds/**` inserts tasks
-- directly, so a fixture could produce a Task sitting in a different sprint from its
-- Story with no code path involved — which is exactly how `US-D2` came to be Team Beta's
-- story inside Team Alpha's Sprint 26.1 (see `trg_sync_accepted_date` and
-- `timebox_group_id`, both triggers for the same reason). A guard that only the service
-- enforces is a guard the seeds walk around.
--
-- ── what this does NOT do ───────────────────────────────────────────────────
-- It does not touch `team_id`. A Task's team DEFAULTS to its parent's but stays settable
-- (SRS P1-04), and Team Status reads `coalesce(task.team_id, …)` deliberately. Only the
-- Iteration is contractually derived.

-- ── 1. Realign what has already diverged ────────────────────────────────────
-- No local row is diverged today (3 tasks, 0 mismatched) — the invariant held by luck.
-- This runs anyway because a deployed database has had months of the two writable paths,
-- and the triggers below would otherwise leave old divergence frozen in place while
-- refusing all new divergence. Reported by the `WHERE`, so a no-op costs nothing.
UPDATE "work"."tasks" t
   SET "iteration_id" = p."iteration_id"
  FROM "work"."work_items" p
 WHERE p."id" = t."parent_id"
   AND COALESCE(t."iteration_id"::text, '') <> COALESCE(p."iteration_id"::text, '');--> statement-breakpoint

-- ── 2. A Task takes its parent's Iteration, on every write ───────────────────
-- BEFORE INSERT OR UPDATE, unconditionally: the column is a mirror, so whatever a caller
-- supplies for it is discarded rather than merged. Covers reparenting for free — a Task
-- moved to a Story in another sprint follows that Story, because the value is read from
-- NEW.parent_id every time.
CREATE OR REPLACE FUNCTION "work"."task_iteration_from_parent"()
RETURNS trigger AS $$
BEGIN
  SELECT p."iteration_id" INTO NEW."iteration_id"
    FROM "work"."work_items" p
   WHERE p."id" = NEW."parent_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_task_iteration_from_parent" ON "work"."tasks";--> statement-breakpoint

CREATE TRIGGER "trg_task_iteration_from_parent"
  BEFORE INSERT OR UPDATE OF "parent_id", "iteration_id" ON "work"."tasks"
  FOR EACH ROW EXECUTE FUNCTION "work"."task_iteration_from_parent"();--> statement-breakpoint

-- ── 3. Moving a parent moves its Tasks ──────────────────────────────────────
-- AFTER UPDATE, because the parent's own row must be settled before the children read it.
-- `WHEN` on the column means an unrelated patch — a title edit, a state change — does not
-- touch a single task row.
--
-- The child UPDATE fires trigger (2), which re-reads the parent and arrives at the same
-- value. That is one extra read per task and no recursion: (2) is BEFORE UPDATE on
-- `tasks` and writes nothing to `work_items`.
CREATE OR REPLACE FUNCTION "work"."cascade_iteration_to_tasks"()
RETURNS trigger AS $$
BEGIN
  UPDATE "work"."tasks"
     SET "iteration_id" = NEW."iteration_id",
         "updated_at" = now()
   WHERE "parent_id" = NEW."id"
     AND "deleted_at" IS NULL
     AND COALESCE("iteration_id"::text, '') <> COALESCE(NEW."iteration_id"::text, '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_cascade_iteration_to_tasks" ON "work"."work_items";--> statement-breakpoint

CREATE TRIGGER "trg_cascade_iteration_to_tasks"
  AFTER UPDATE OF "iteration_id" ON "work"."work_items"
  FOR EACH ROW
  WHEN (OLD."iteration_id" IS DISTINCT FROM NEW."iteration_id")
  EXECUTE FUNCTION "work"."cascade_iteration_to_tasks"();
