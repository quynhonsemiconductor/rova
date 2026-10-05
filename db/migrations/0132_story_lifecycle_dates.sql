-- Phase 7 (Story Date Tracking and Carryover) — lifecycle dates and Target End Date.
--
-- CO-01 / CO-02 (plan D2). Five new `date` columns:
--
--   work_items.start_date       first entry of a STORY into `in_progress`   (CO-BR-06) — system managed
--   work_items.actual_end_date  first entry of a STORY into `accepted`      (CO-BR-07) — system managed
--   work_items.target_end_date  the Story editor's forecast                 (CO-BR-12) — user managed,
--                               validated in WorkItemsService (plan D7); no trigger touches it
--   tasks.start_date            first entry of a TASK into `in_progress`    (CO-BR-08) — system managed
--   tasks.actual_end_date       first entry of a TASK into `completed`      (CO-BR-09) — system managed
--
-- WHY NOT `accepted_date`. That column is the CURRENT acceptance (0087): `trg_sync_accepted_date`
-- clears it on reopen and re-stamps it on re-acceptance. CO-BR-07/10 want the FIRST acceptance, never
-- cleared — a different fact, so a different column (ruling R2).
--
-- R2: ONLY `accepted` stamps a Story's Actual End Date. A Story moved straight to `release` without
-- passing through `accepted` keeps it blank. Defects get none of these (plan D12).
--
-- WHY TRIGGERS AND NOT ONLY THE SERVICE — the 0087 / 0095 reasoning, unchanged: `db/seeds/**` and raw
-- SQL write these tables directly, and "set once, never rewritten" is a floor the database must hold.
-- The two lifecycle columns are in NO Create*/Update* request schema; the trigger additionally forces
-- an already-set value back on every UPDATE, so even a direct write cannot move it (CO-BR-10).
--
-- STAMPED ON A TRANSITION, NOT ON "STATE IS X AND DATE IS NULL". A Story that was already
-- `in_progress` before this migration and has no auditable history must not acquire TODAY's date the
-- next time someone edits its title — that would be a guess, and R5 forbids guessing. So a date is
-- stamped only on INSERT into the state or on an UPDATE that changes INTO it.
--
-- THE DATE IS WORKSPACE-LOCAL (`workspace_settings.timezone`, 'UTC' when unset), the same convention
-- the Split marker dates use: a Story started at 01:00 in Asia/Ho_Chi_Minh started on that local day.
--
-- Hand-written (`drizzle-kit generate` needs a TTY, docs/lessons/tooling.md). Mirrored into
-- `db/schema/work.ts` in the same commit.

-- ── 1. Columns ────────────────────────────────────────────────────────────────
ALTER TABLE "work"."work_items" ADD COLUMN IF NOT EXISTS "start_date" date;--> statement-breakpoint
ALTER TABLE "work"."work_items" ADD COLUMN IF NOT EXISTS "actual_end_date" date;--> statement-breakpoint
ALTER TABLE "work"."work_items" ADD COLUMN IF NOT EXISTS "target_end_date" date;--> statement-breakpoint
ALTER TABLE "work"."tasks" ADD COLUMN IF NOT EXISTS "start_date" date;--> statement-breakpoint
ALTER TABLE "work"."tasks" ADD COLUMN IF NOT EXISTS "actual_end_date" date;--> statement-breakpoint

-- ── 2. The workspace-local "today" ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION "work"."workspace_local_date"(p_workspace_id uuid, p_at timestamptz)
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (p_at AT TIME ZONE COALESCE(
            (SELECT s."timezone" FROM "workspace"."workspace_settings" s
              WHERE s."workspace_id" = p_workspace_id),
            'UTC'))::date;
$$;--> statement-breakpoint

-- ── 3. Backfill from the audit trail (ruling R5) ────────────────────────────
--
-- The FIRST logged transition into each state — unlike 0087, which wants the LATEST (the current
-- outcome). Rows with no such log entry stay NULL: there is no evidence, and none is invented.
--
-- A function rather than four bare UPDATEs so the e2e suite can run the SAME code against fixtures
-- it builds (`test/e2e/story-lifecycle-dates.e2e.spec.ts`). It only ever fills NULLs, so calling it
-- again is a no-op on anything already dated — including anything the trigger below has stamped.
--
-- Task state transitions are logged as `task.state_changed` with the SCHEDULE-state value the caller
-- sent (`activity-diff.ts` TASK_ACTIONS); the repository projects `accepted`/`release` onto the task's
-- `completed`, so all three count as "entered Completed".
--
-- LOCK WINDOW, accepted deliberately (PR #653 review). Each UPDATE is one statement over the matching
-- rows, the shape 0087's accepted-date backfill set. Rova is single-tenant with one seeded workspace,
-- so `workspace_local_date`'s settings lookup resolves the same row every time (planner-cached STABLE
-- function), and `activity_logs` has no `(entity_type, action)` index — each CTE is one sequential
-- scan. Measured locally: 200,008 activity rows → the whole function runs in 0.51 s, so the lock
-- window is sub-second. Batch it by PK range only if a deployment's activity history grows by
-- orders of magnitude beyond that.
CREATE OR REPLACE FUNCTION "work"."backfill_lifecycle_dates"()
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  touched integer := 0;
  n integer;
BEGIN
  WITH first_start AS (
    SELECT l.entity_id, MIN(l.created_at) AS at
      FROM "work"."activity_logs" l
     WHERE l.entity_type = 'work_item'
       AND l.action = 'work_item.schedule_state_changed'
       AND l.changes->>'new' = 'in_progress'
     GROUP BY l.entity_id
  )
  UPDATE "work"."work_items" w
     SET "start_date" = "work"."workspace_local_date"(w."workspace_id", f.at)
    FROM first_start f
   WHERE w."id" = f.entity_id AND w."type" = 'story' AND w."start_date" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  WITH first_accept AS (
    SELECT l.entity_id, MIN(l.created_at) AS at
      FROM "work"."activity_logs" l
     WHERE l.entity_type = 'work_item'
       AND l.action = 'work_item.schedule_state_changed'
       AND l.changes->>'new' = 'accepted'
     GROUP BY l.entity_id
  )
  UPDATE "work"."work_items" w
     SET "actual_end_date" = "work"."workspace_local_date"(w."workspace_id", f.at)
    FROM first_accept f
   WHERE w."id" = f.entity_id AND w."type" = 'story' AND w."actual_end_date" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  WITH first_start AS (
    SELECT l.entity_id, MIN(l.created_at) AS at
      FROM "work"."activity_logs" l
     WHERE l.entity_type = 'task'
       AND l.action = 'task.state_changed'
       AND l.changes->>'new' = 'in_progress'
     GROUP BY l.entity_id
  )
  UPDATE "work"."tasks" t
     SET "start_date" = "work"."workspace_local_date"(t."workspace_id", f.at)
    FROM first_start f
   WHERE t."id" = f.entity_id AND t."start_date" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  WITH first_complete AS (
    SELECT l.entity_id, MIN(l.created_at) AS at
      FROM "work"."activity_logs" l
     WHERE l.entity_type = 'task'
       AND l.action = 'task.state_changed'
       AND l.changes->>'new' IN ('completed', 'accepted', 'release')
     GROUP BY l.entity_id
  )
  UPDATE "work"."tasks" t
     SET "actual_end_date" = "work"."workspace_local_date"(t."workspace_id", f.at)
    FROM first_complete f
   WHERE t."id" = f.entity_id AND t."actual_end_date" IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

  RETURN touched;
END;
$$;--> statement-breakpoint

-- Runs BEFORE the triggers exist, exactly as 0087 does, so the backfilled values are the ones kept.
SELECT "work"."backfill_lifecycle_dates"();--> statement-breakpoint

-- ── 4. Story trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "work"."stamp_story_lifecycle_dates"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Defects (and every other work_items type) carry no lifecycle dates (plan D12).
  IF NEW."type" <> 'story' THEN
    NEW."start_date" := NULL;
    NEW."actual_end_date" := NULL;
    RETURN NEW;
  END IF;

  -- Set once, never rewritten or cleared (CO-BR-10) — whatever the statement asked for.
  IF TG_OP = 'UPDATE' THEN
    IF OLD."start_date" IS NOT NULL THEN NEW."start_date" := OLD."start_date"; END IF;
    IF OLD."actual_end_date" IS NOT NULL THEN NEW."actual_end_date" := OLD."actual_end_date"; END IF;
  END IF;

  IF NEW."start_date" IS NULL AND NEW."schedule_state" = 'in_progress'
     AND (TG_OP = 'INSERT' OR OLD."schedule_state" IS DISTINCT FROM 'in_progress') THEN
    NEW."start_date" := "work"."workspace_local_date"(NEW."workspace_id", now());
  END IF;

  -- R2: `accepted` only. `release` without passing through `accepted` leaves it blank.
  IF NEW."actual_end_date" IS NULL AND NEW."schedule_state" = 'accepted'
     AND (TG_OP = 'INSERT' OR OLD."schedule_state" IS DISTINCT FROM 'accepted') THEN
    NEW."actual_end_date" := "work"."workspace_local_date"(NEW."workspace_id", now());
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_stamp_story_lifecycle_dates" ON "work"."work_items";--> statement-breakpoint

CREATE TRIGGER "trg_stamp_story_lifecycle_dates"
  BEFORE INSERT OR UPDATE ON "work"."work_items"
  FOR EACH ROW EXECUTE FUNCTION "work"."stamp_story_lifecycle_dates"();--> statement-breakpoint

-- ── 5. Task trigger ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "work"."stamp_task_lifecycle_dates"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."start_date" IS NOT NULL THEN NEW."start_date" := OLD."start_date"; END IF;
    IF OLD."actual_end_date" IS NOT NULL THEN NEW."actual_end_date" := OLD."actual_end_date"; END IF;
  END IF;

  IF NEW."start_date" IS NULL AND NEW."state" = 'in_progress'
     AND (TG_OP = 'INSERT' OR OLD."state" IS DISTINCT FROM 'in_progress') THEN
    NEW."start_date" := "work"."workspace_local_date"(NEW."workspace_id", now());
  END IF;

  IF NEW."actual_end_date" IS NULL AND NEW."state" = 'completed'
     AND (TG_OP = 'INSERT' OR OLD."state" IS DISTINCT FROM 'completed') THEN
    NEW."actual_end_date" := "work"."workspace_local_date"(NEW."workspace_id", now());
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_stamp_task_lifecycle_dates" ON "work"."tasks";--> statement-breakpoint

CREATE TRIGGER "trg_stamp_task_lifecycle_dates"
  BEFORE INSERT OR UPDATE ON "work"."tasks"
  FOR EACH ROW EXECUTE FUNCTION "work"."stamp_task_lifecycle_dates"();
