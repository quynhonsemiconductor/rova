-- Phase 7 (Phase A) — Test Case & Test Result.
--
-- New module: a Test Case is a project artifact, OPTIONALLY attached to one Work Item
-- (D2: `work_item_id` stays nullable so a future standalone `Quality > Test Cases` surface
-- needs no migration). Phase A exposes only the work-item-scoped routes.
--
-- `last_verdict` / `last_run` / `last_result_id` on `test_cases` are a DENORMALISED,
-- TRIGGER-maintained mirror of the latest live Result (D6) — the same reason
-- `trg_sync_accepted_date` and `trg_task_iteration_from_parent` are triggers: `db/seeds/**`
-- and raw SQL write `test_results` directly, so a rule enforced only in the service is a
-- rule the seeds walk around.
--
-- Per-project Test Case Type catalog (`work.test_case_types`, modelled on `work.labels`) is
-- also created here (D8) even though its admin routes are Phase G, because `test_cases.type`
-- is a required text SNAPSHOT of a Type name and every Test Case needs a value to default to
-- from day one — the five defaults are backfilled for every existing project below.

-- ── 1. New enums ─────────────────────────────────────────────────────────────
CREATE TYPE "public"."test_case_method" AS ENUM ('manual', 'automated');--> statement-breakpoint
CREATE TYPE "public"."test_case_priority" AS ENUM ('low', 'normal', 'high', 'urgent');--> statement-breakpoint

-- All six members live on ONE enum even though a Test Result can never be `not_run`
-- (SRS: a Result records what happened, so "not run" is not an outcome). `not_run` is
-- reserved for `test_cases.last_verdict` alone, and a CHECK constraint on
-- `test_results.verdict` is what actually excludes it there — a single enum used two
-- ways with one member excluded from one of them is exactly the kind of thing a later
-- writer gets wrong without the CHECK.
CREATE TYPE "public"."test_verdict" AS ENUM ('pass', 'fail', 'blocked', 'error', 'inconclusive', 'not_run');--> statement-breakpoint

-- ── 2. Widen the two polymorphic-subject enums ──────────────────────────────
-- `ALTER TYPE ... ADD VALUE` is non-transactional and cannot be USED in the same
-- transaction it is added in (see migration 0063's note) — safe here because Phase A
-- inserts no `test_case` / `test_result` row into either column; the first write
-- lands in Phase C (attachments) and is refused entirely for comments (§2.6).
ALTER TYPE "entity_ref_type" ADD VALUE IF NOT EXISTS 'test_case';--> statement-breakpoint
ALTER TYPE "entity_ref_type" ADD VALUE IF NOT EXISTS 'test_result';--> statement-breakpoint
ALTER TYPE "activity_entity_type" ADD VALUE IF NOT EXISTS 'test_case';--> statement-breakpoint
ALTER TYPE "activity_entity_type" ADD VALUE IF NOT EXISTS 'test_result';--> statement-breakpoint

-- ── 3. work.test_case_types ──────────────────────────────────────────────────
CREATE TABLE "work"."test_case_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "name" varchar(60) NOT NULL,
  "position" integer DEFAULT 0 NOT NULL,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "ix_test_case_types_project" ON "work"."test_case_types" ("project_id");--> statement-breakpoint

-- Case-insensitive duplicate check (SRS §3.3, BR16) — the constraint must match the
-- service's own check or the two disagree about what "duplicate" means.
CREATE UNIQUE INDEX "uq_test_case_types_name" ON "work"."test_case_types" ("project_id", lower("name"));--> statement-breakpoint

-- ── 4. work.test_cases ───────────────────────────────────────────────────────
CREATE TABLE "work"."test_cases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  -- Inherited, read-only (SRS §6.3); NULL = "Project backlog", same reading as
  -- `work_items.team_id` / `iterations.team_id`.
  "team_id" uuid,
  -- NULLABLE (D2). No `ON DELETE cascade`: a Work Item delete is SOFT, so a cascade
  -- would never fire anyway (the same reason CLAUDE.md records for `work.tasks`), and
  -- Phase F is what decides whether a deleted Work Item's Test Cases follow it.
  "work_item_id" uuid REFERENCES "work"."work_items"("id"),
  "test_case_key" varchar(30) NOT NULL,
  "name" varchar(500) NOT NULL,
  "description" text,
  "objective" text,
  "preconditions" text,
  "validation_input" text,
  "validation_expected_result" text,
  "postconditions" text,
  "notes" text,
  -- Text SNAPSHOT of the Type name (D8, BR2) — a removed Type must still render on a
  -- historical Test Case, which a snapshot gives for free.
  "type" varchar(60) NOT NULL,
  "method" "test_case_method" DEFAULT 'manual' NOT NULL,
  "priority" "test_case_priority" DEFAULT 'normal' NOT NULL,
  -- No FK on owner_id / assignee_id, matching `work.tasks.assignee_id`: eligibility
  -- depends on project AND team (no constraint expresses that), and a user delete
  -- must not cascade into test history.
  "owner_id" uuid,
  "assignee_id" uuid,
  "rank" varchar(255) DEFAULT '' NOT NULL,
  -- Maintained by trg_test_case_last_result (D6) — never written by the service.
  "last_verdict" "test_verdict",
  "last_run" date,
  "last_result_id" uuid,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE UNIQUE INDEX "uq_test_case_key" ON "work"."test_cases" ("workspace_id", "test_case_key");--> statement-breakpoint
CREATE INDEX "ix_test_cases_work_item" ON "work"."test_cases" ("work_item_id") WHERE "deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_test_cases_project" ON "work"."test_cases" ("project_id");--> statement-breakpoint
CREATE INDEX "ix_test_cases_workspace" ON "work"."test_cases" ("workspace_id");--> statement-breakpoint
CREATE INDEX "ix_test_cases_work_item_rank" ON "work"."test_cases" ("work_item_id", "rank");--> statement-breakpoint

-- ── 5. work.test_results ─────────────────────────────────────────────────────
CREATE TABLE "work"."test_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "test_case_id" uuid NOT NULL REFERENCES "work"."test_cases"("id") ON DELETE CASCADE,
  -- SNAPSHOT of the Test Case's Work Product at result-entry time (Rally: "the work
  -- product to which the test case result was associated when you entered the
  -- result") — not editable, and not re-derived from the Test Case's current link.
  "work_item_id" uuid,
  "test_result_key" varchar(30) NOT NULL,
  "build" varchar(255) NOT NULL,
  "run_date" date NOT NULL,
  "verdict" "test_verdict" NOT NULL,
  "duration_minutes" integer DEFAULT 0 NOT NULL,
  "tester_id" uuid NOT NULL,
  "notes" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "ck_test_results_duration_non_negative" CHECK ("duration_minutes" >= 0),
  -- `not_run` is a Test Case-only concept (D6) — a Result records an outcome, never
  -- its absence. One enum, two audiences, one excluded member: see the enum's comment.
  CONSTRAINT "ck_test_results_verdict_not_not_run" CHECK ("verdict" <> 'not_run')
);--> statement-breakpoint

CREATE UNIQUE INDEX "uq_test_result_key" ON "work"."test_results" ("workspace_id", "test_result_key");--> statement-breakpoint
-- This IS the SRS §7 ordering (BR14) and the trigger's own "latest result" lookup —
-- one index serves both.
CREATE INDEX "ix_test_results_case_run_date" ON "work"."test_results" ("test_case_id", "run_date" DESC, "created_at" DESC);--> statement-breakpoint

-- ── 6. Trigger: trg_test_case_last_result (D6, BR9) ─────────────────────────
-- AFTER INSERT OR UPDATE OR DELETE on test_results, recompute the owning Test
-- Case's last_verdict / last_run / last_result_id from the latest live Result
-- (run_date desc, created_at desc — same tie-break the list uses). Must fire on
-- UPDATE of run_date, verdict and deleted_at (a soft delete is an UPDATE), and on a
-- test_case_id move must recompute BOTH the old and the new Test Case — the same
-- both-sides rule iteration auto-accept needs (CLAUDE.md).
CREATE OR REPLACE FUNCTION "work"."recompute_test_case_last_result"(p_test_case_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE "work"."test_cases" tc
     SET "last_verdict" = latest."verdict",
         "last_run" = latest."run_date",
         "last_result_id" = latest."id",
         "updated_at" = now()
    FROM (
      SELECT "id", "verdict", "run_date"
        FROM "work"."test_results"
       WHERE "test_case_id" = p_test_case_id AND "deleted_at" IS NULL
       ORDER BY "run_date" DESC, "created_at" DESC
       LIMIT 1
    ) latest
   WHERE tc."id" = p_test_case_id;

  -- No live result remains: clear all three rather than leaving a stale winner.
  UPDATE "work"."test_cases"
     SET "last_verdict" = NULL,
         "last_run" = NULL,
         "last_result_id" = NULL,
         "updated_at" = now()
   WHERE "id" = p_test_case_id
     AND NOT EXISTS (
       SELECT 1 FROM "work"."test_results"
        WHERE "test_case_id" = p_test_case_id AND "deleted_at" IS NULL
     );
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE OR REPLACE FUNCTION "work"."test_case_last_result_trigger"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "work"."recompute_test_case_last_result"(OLD."test_case_id");
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' AND OLD."test_case_id" IS DISTINCT FROM NEW."test_case_id" THEN
    PERFORM "work"."recompute_test_case_last_result"(OLD."test_case_id");
    PERFORM "work"."recompute_test_case_last_result"(NEW."test_case_id");
    RETURN NEW;
  ELSE
    PERFORM "work"."recompute_test_case_last_result"(NEW."test_case_id");
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS "trg_test_case_last_result" ON "work"."test_results";--> statement-breakpoint

CREATE TRIGGER "trg_test_case_last_result"
  AFTER INSERT OR UPDATE OF "run_date", "verdict", "deleted_at", "test_case_id" OR DELETE
  ON "work"."test_results"
  FOR EACH ROW EXECUTE FUNCTION "work"."test_case_last_result_trigger"();--> statement-breakpoint

-- ── 7. Backfill: five default Types for every existing project (BR18) ──────
INSERT INTO "work"."test_case_types" ("workspace_id", "project_id", "name", "position")
SELECT p."workspace_id", p."id", d."name", d."position"
  FROM "work"."projects" p
 CROSS JOIN (VALUES
    ('Acceptance', 0),
    ('Functional', 1),
    ('Regression', 2),
    ('Performance', 3),
    ('Usability', 4)
 ) AS d("name", "position")
 WHERE p."deleted_at" IS NULL;
