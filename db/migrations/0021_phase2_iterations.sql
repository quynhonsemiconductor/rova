-- ============================================================================
-- Migration 0021: Phase 2 — Iterations (rename sprints → iterations)
-- ============================================================================
-- Adopts the Rally "Iteration" ubiquitous language as the canonical domain term.
-- Renames work.sprints → work.iterations and the sprint_status enum → the
-- Rally iteration State vocabulary (Planning / Committed / Accepted), and adds
-- the Phase 2 planning fields: team_id, theme, notes, planned_velocity and the
-- per-project display key (iteration_key).
--
-- Dev-phase rename (no production data contract to preserve): a full big-bang
-- rename keeps the schema domain-correct with a single, deterministic USING
-- remap of the old lifecycle states onto Rally states.
-- ============================================================================

-- ── 1. State enum → Rally Iteration vocabulary ──────────────────────────────
-- Old sprint lifecycle (planned/active/completed) maps onto Rally iteration
-- State: planned→planning, active→committed, completed→accepted.

-- Drop the partial index first: its predicate (status = 'active') references the
-- old enum, and ALTER COLUMN ... TYPE would try to rebuild it against the new
-- type, failing with "operator does not exist: iteration_state = sprint_status".
DROP INDEX IF EXISTS "work"."ix_sprints_active";

ALTER TYPE "sprint_status" RENAME TO "sprint_status_old";

CREATE TYPE "iteration_state" AS ENUM ('planning', 'committed', 'accepted');

ALTER TABLE "work"."sprints" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "work"."sprints"
  ALTER COLUMN "status" TYPE "iteration_state"
  USING (
    CASE "status"::text
      WHEN 'planned'   THEN 'planning'
      WHEN 'active'    THEN 'committed'
      WHEN 'completed' THEN 'accepted'
      ELSE 'planning'
    END
  )::"iteration_state";

ALTER TABLE "work"."sprints" ALTER COLUMN "status" SET DEFAULT 'planning';

DROP TYPE "sprint_status_old";

-- ── 2. New Phase 2 planning columns ─────────────────────────────────────────
-- All nullable / safe-default: online-safe additive change.

ALTER TABLE "work"."sprints"
  ADD COLUMN "team_id"          uuid,
  ADD COLUMN "theme"            text,
  ADD COLUMN "notes"            text,
  ADD COLUMN "planned_velocity" integer,
  ADD COLUMN "iteration_key"    varchar(30);

-- Rename the domain field goal → theme is unnecessary: Rally keeps both.
-- (goal stays as the short objective; theme is the rich planning context.)

-- ── 3. Rename table + state column to Iteration vocabulary ──────────────────

ALTER TABLE "work"."sprints" RENAME COLUMN "status" TO "state";
ALTER TABLE "work"."sprints" RENAME TO "iterations";

-- Rename the burndown read-model to match.
ALTER TABLE "work"."sprint_daily_snapshots" RENAME COLUMN "sprint_id" TO "iteration_id";
ALTER TABLE "work"."sprint_daily_snapshots" RENAME TO "iteration_daily_snapshots";

-- ── 4. Indexes: rename to iteration_* and add team + key ────────────────────

ALTER INDEX "work"."ix_sprints_tenant"  RENAME TO "ix_iterations_tenant";
ALTER INDEX "work"."ix_sprints_project" RENAME TO "ix_iterations_project";
-- Committed iteration is the "active" one per project (Rally: one committed at a time is optional; keep partial index on committed).
-- (ix_sprints_active was dropped in step 1, before the enum retype.)
CREATE INDEX "ix_iterations_committed"
  ON "work"."iterations" ("project_id", "state")
  WHERE "state" = 'committed';

CREATE INDEX "ix_iterations_team" ON "work"."iterations" ("team_id");

ALTER INDEX "work"."ix_sds_tenant"        RENAME TO "ix_ids_tenant";
ALTER INDEX "work"."ix_sds_sprint"        RENAME TO "ix_ids_iteration";
ALTER INDEX "work"."uq_sds_sprint_date"   RENAME TO "uq_ids_iteration_date";

-- ── 5. iteration_key: per-project display key (IT-<n>) ──────────────────────
-- Backfill existing rows deterministically by creation order, then enforce
-- uniqueness per project. New keys are minted by the application via
-- project_counters (same pattern as work_item item_key).

WITH numbered AS (
  SELECT id,
         'IT-' || ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at, id) AS k
  FROM "work"."iterations"
)
UPDATE "work"."iterations" i
SET "iteration_key" = n.k
FROM numbered n
WHERE i.id = n.id;

CREATE UNIQUE INDEX "uq_iterations_key"
  ON "work"."iterations" ("project_id", "iteration_key");
