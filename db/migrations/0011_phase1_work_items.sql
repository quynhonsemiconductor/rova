-- ============================================================================
-- Migration 0011: Phase 1 — Core Work Item Management
-- ============================================================================
-- Adds the Phase 1 fields to work.work_items, remaps the priority enum to the
-- Rally vocabulary, introduces the schedule_state dimension, and creates the
-- work.activity_logs revision-history table (synchronous, same-transaction).
--
-- Online-safe: all new columns are nullable or have safe defaults; the enum
-- swap uses an explicit USING remap so existing rows convert deterministically.
-- ============================================================================

-- ── 1. Priority enum → Rally vocabulary (none/low/normal/high/urgent) ────────
-- Legacy values (critical/high/medium/low) are remapped: critical→urgent,
-- medium→normal. Full type swap keeps the enum clean (no orphan values).

ALTER TYPE "work_item_priority" RENAME TO "work_item_priority_old";

CREATE TYPE "work_item_priority" AS ENUM ('none', 'low', 'normal', 'high', 'urgent');

ALTER TABLE "work"."work_items" ALTER COLUMN "priority" DROP DEFAULT;

ALTER TABLE "work"."work_items"
  ALTER COLUMN "priority" TYPE "work_item_priority"
  USING (
    CASE "priority"::text
      WHEN 'critical' THEN 'urgent'
      WHEN 'high'     THEN 'high'
      WHEN 'medium'   THEN 'normal'
      WHEN 'low'      THEN 'low'
      ELSE 'none'
    END
  )::"work_item_priority";

ALTER TABLE "work"."work_items" ALTER COLUMN "priority" SET DEFAULT 'none';

DROP TYPE "work_item_priority_old";

-- ── 2. schedule_state enum + column ─────────────────────────────────────────

CREATE TYPE "work_item_schedule_state" AS ENUM (
  'idea', 'defined', 'in_progress', 'completed', 'accepted', 'released'
);

ALTER TABLE "work"."work_items"
  ADD COLUMN "schedule_state" "work_item_schedule_state" NOT NULL DEFAULT 'defined';

-- ── 3. New work_items columns ───────────────────────────────────────────────

ALTER TABLE "work"."work_items"
  ADD COLUMN "team_id"        uuid,
  ADD COLUMN "estimate_hours" numeric(8, 2),
  ADD COLUMN "todo_hours"     numeric(8, 2),
  ADD COLUMN "actual_hours"   numeric(8, 2),
  ADD COLUMN "notes"          text,
  ADD COLUMN "release_notes"  text,
  ADD COLUMN "updated_by"     uuid;

-- Hours are never negative (defence-in-depth alongside Zod validation).
ALTER TABLE "work"."work_items"
  ADD CONSTRAINT "ck_wi_hours_nonneg" CHECK (
    ("estimate_hours" IS NULL OR "estimate_hours" >= 0) AND
    ("todo_hours"     IS NULL OR "todo_hours"     >= 0) AND
    ("actual_hours"   IS NULL OR "actual_hours"   >= 0)
  );

-- ── 4. Indexes ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS "ix_wi_team" ON "work"."work_items" USING btree ("team_id");

-- Task-list-under-parent hot path (Tasks tab + totals aggregation).
CREATE INDEX IF NOT EXISTS "ix_wi_tasks"
  ON "work"."work_items" USING btree ("parent_id", "rank")
  WHERE "type" = 'task' AND "deleted_at" IS NULL;

-- ── 5. activity_logs (Revision History) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS "work"."activity_logs" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"    uuid NOT NULL,
  "project_id"   uuid NOT NULL,
  "work_item_id" uuid NOT NULL,
  "entity_type"  varchar(30) NOT NULL,
  "entity_id"    uuid NOT NULL,
  "actor_id"     uuid,
  "action"       varchar(60) NOT NULL,
  "changes"      jsonb,
  "metadata"     jsonb NOT NULL DEFAULT '{}',
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "ix_activity_tenant"
  ON "work"."activity_logs" USING btree ("tenant_id");
CREATE INDEX IF NOT EXISTS "ix_activity_work_item"
  ON "work"."activity_logs" USING btree ("work_item_id", "created_at");
CREATE INDEX IF NOT EXISTS "ix_activity_project"
  ON "work"."activity_logs" USING btree ("project_id");

-- RLS: tenant isolation (consistent with migration 0005). Append-only is
-- enforced at the application layer (no UPDATE/DELETE paths exposed).
ALTER TABLE "work"."activity_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "work"."activity_logs"
  AS PERMISSIVE FOR ALL
  USING      ("tenant_id" = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);
