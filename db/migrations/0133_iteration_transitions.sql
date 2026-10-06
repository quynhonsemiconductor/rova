-- Phase 7 (Story Date Tracking and Carryover) — the Iteration Transition event log.
--
-- CO-05 / CO-06 (plan D3). One enum, two tables:
--
--   work.iteration_transitions       one row per user-initiated Story Iteration change — either a
--                                    confirmed CARRYOVER (CO-BR-22/30) or a MANUAL MOVE (CO-BR-27,
--                                    ruling R8: `updateWorkItem` + `bulkAssignIteration`, Stories only).
--   work.iteration_transition_tasks  the per-Task effort SNAPSHOT at a Carryover (CO-BR-30). Written for
--                                    `carryover` only — a Manual Move captures no snapshot and is NOT an
--                                    Actual-attribution boundary (ruling R3, declared limitation).
--
-- WHY A CHILD TABLE (the 0131 reasoning): Team Capacity is a LIVE query and reads per-Task Actual at
-- the move BY TASK ID (`ix_itt_task`); a jsonb blob would force an unnest inside that query.
--
-- IMMUTABLE (CO-BR-46). Both tables refuse UPDATE and DELETE by trigger. An event is history; a
-- correction is a new event. The `ON DELETE CASCADE` on the child FK therefore never fires in practice
-- — the parent cannot be deleted — and is kept only so the pair stays one aggregate in the DDL.
--
-- NAMES ARE NOT STORED. Ids only (CO-BR-45): Iteration names are display data and live in the activity
-- entry's metadata, where the Revision History reads them.
--
-- Hand-written (`drizzle-kit generate` needs a TTY). Mirrored into `db/schema/work.ts` +
-- `db/schema/enums.ts` in the same commit.

CREATE TYPE "public"."iteration_transition_type" AS ENUM ('carryover', 'manual_move');--> statement-breakpoint

CREATE TABLE "work"."iteration_transitions" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  -- The Story's team AT THE MOVE; NULL = project backlog.
  "team_id" uuid,
  -- NO ACTION, deliberately (PR #653 review): history outlives its Story. Stories are SOFT-deleted
  -- (`deleted_at`) on every product path, so this never fires in practice; it is the floor that stops
  -- a raw hard DELETE from orphaning an immutable event. Mirrored in db/schema/work.ts.
  "story_id" uuid NOT NULL REFERENCES "work"."work_items"("id"),
  "type" "iteration_transition_type" NOT NULL,
  -- NULL on a Manual Move to/from Unscheduled.
  --
  -- ON DELETE SET NULL, because Iterations ARE hard-deleted (`DELETE /iterations/:id`, after the
  -- timebox-delete unscheduling). Without an action, the first Manual Move into a sprint would make
  -- that sprint undeletable. The immutability trigger below admits exactly this one UPDATE shape.
  "source_iteration_id" uuid REFERENCES "work"."iterations"("id") ON DELETE SET NULL,
  "target_iteration_id" uuid REFERENCES "work"."iterations"("id") ON DELETE SET NULL,
  "target_end_date" date,
  "actor_id" uuid,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "ix_it_story" ON "work"."iteration_transitions" ("story_id", "occurred_at");--> statement-breakpoint
CREATE INDEX "ix_it_source" ON "work"."iteration_transitions" ("source_iteration_id", "occurred_at");--> statement-breakpoint
CREATE INDEX "ix_it_target" ON "work"."iteration_transitions" ("target_iteration_id", "occurred_at");--> statement-breakpoint

CREATE TABLE "work"."iteration_transition_tasks" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "transition_id" uuid NOT NULL REFERENCES "work"."iteration_transitions"("id") ON DELETE CASCADE,
  -- NO ACTION, deliberately, for the same reason as `story_id`: Tasks are SOFT-deleted on every
  -- product path (`WorkItemsService.deleteWorkItem` → `softDelete`), so a routine "remove a task"
  -- never reaches this FK. CASCADE is not an option (the immutability trigger refuses the cascaded
  -- delete) and SET NULL would erase which Task an Actual boundary belonged to. Mirrored in schema.
  "task_id" uuid NOT NULL REFERENCES "work"."tasks"("id"),
  "state" "work"."task_state" NOT NULL,
  "estimate_hours_at_move" numeric(8, 2),
  "todo_hours_at_move" numeric(8, 2),
  -- The CUMULATIVE Actual at the move — the attribution boundary Team Capacity reads (plan D10).
  "actual_hours_at_move" numeric(8, 2),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- LOAD-BEARING: the Team Capacity attribution join.
CREATE INDEX "ix_itt_task" ON "work"."iteration_transition_tasks" ("task_id");--> statement-breakpoint
CREATE INDEX "ix_itt_transition" ON "work"."iteration_transition_tasks" ("transition_id");--> statement-breakpoint

-- ── Completeness + immutability (D3, CO-BR-46) ───────────────────────────────
--
-- "A carryover names its source, target and Target End Date" is enforced AT INSERT by trigger rather
-- than by a table CHECK: a CHECK is re-evaluated on every UPDATE, so the FK's own `SET NULL` after an
-- Iteration delete would violate it and make the Iteration undeletable after all.
CREATE OR REPLACE FUNCTION "work"."guard_iteration_transition"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."type" = 'carryover' AND (NEW."source_iteration_id" IS NULL
        OR NEW."target_iteration_id" IS NULL OR NEW."target_end_date" IS NULL) THEN
      RAISE EXCEPTION 'a carryover transition needs source, target and target_end_date'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The documented shape, held by the database rather than by the writer (PR #653 review): a
    -- Manual Move records no forecast, so a stray value cannot be misread as a confirmed one.
    IF NEW."type" = 'manual_move' AND NEW."target_end_date" IS NOT NULL THEN
      RAISE EXCEPTION 'a manual move records no target_end_date'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- The ONE permitted UPDATE: the FK's ON DELETE SET NULL after an Iteration is deleted. Every other
  -- column must be unchanged, and EXACTLY ONE iteration reference moves to NULL (PR #653 review,
  -- round 3): each FK's SET NULL is its own statement and only ever nulls its own column, so an
  -- UPDATE that nulls BOTH at once (erasing the attribution pair) is not the FK and is refused.
  IF TG_OP = 'UPDATE'
     AND (
       (NEW."source_iteration_id" IS NULL AND OLD."source_iteration_id" IS NOT NULL
          AND NEW."target_iteration_id" IS NOT DISTINCT FROM OLD."target_iteration_id")
       OR
       (NEW."target_iteration_id" IS NULL AND OLD."target_iteration_id" IS NOT NULL
          AND NEW."source_iteration_id" IS NOT DISTINCT FROM OLD."source_iteration_id")
     )
     AND (to_jsonb(NEW) - 'source_iteration_id' - 'target_iteration_id')
         = (to_jsonb(OLD) - 'source_iteration_id' - 'target_iteration_id') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'iteration transition events are immutable (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "work"."refuse_iteration_transition_change"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'iteration transition events are immutable (% on %)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER "trg_iteration_transitions_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "work"."iteration_transitions"
  FOR EACH ROW EXECUTE FUNCTION "work"."guard_iteration_transition"();--> statement-breakpoint

CREATE TRIGGER "trg_iteration_transition_tasks_immutable"
  BEFORE UPDATE OR DELETE ON "work"."iteration_transition_tasks"
  FOR EACH ROW EXECUTE FUNCTION "work"."refuse_iteration_transition_change"();--> statement-breakpoint

-- Ruling R3, held by the DATABASE (PR #653 review, round 2): a Task snapshot belongs to a CARRYOVER
-- only. A Manual Move is not an attribution boundary, so a snapshot row under one — from a seed, raw
-- SQL or a writer bug — would silently make it one in Team Capacity.
CREATE OR REPLACE FUNCTION "work"."guard_iteration_transition_task"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "work"."iteration_transitions" t
     WHERE t."id" = NEW."transition_id" AND t."type" = 'carryover'
  ) THEN
    RAISE EXCEPTION 'a task snapshot belongs to a carryover transition only (transition %)', NEW."transition_id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "trg_iteration_transition_tasks_carryover_only"
  BEFORE INSERT ON "work"."iteration_transition_tasks"
  FOR EACH ROW EXECUTE FUNCTION "work"."guard_iteration_transition_task"();
