-- Phase 7 (Split Unfinished) — the Split Event.
--
-- SU-06 (plan §2). Two new tables plus ONE new column on `work.work_items`:
--
--   work.story_splits       one row per Split — who split what, when, from where to where, and the
--                           before/after point picture (SU-BR-29: "one Split Event connects
--                           everything").
--   work.story_split_items  one row per distributed Task / Defect / Test Case, carrying the
--                           PER-ITEM effort snapshot.
--   work_items.split_id     "this Story IS the historical placeholder of that Split" (plan D6).
--
-- WHY A CHILD TABLE AND NOT A JSONB PAYLOAD (plan D5). SRS §10.1 needs the report layer to look up
-- per-Task Actual captured AT SPLIT TIME, by Task id, and Team Capacity is a LIVE query
-- (`getScopedTaskHours` → `rollUpTeamCapacity`, re-run on every render). A jsonb blob forces a
-- lateral `jsonb_to_recordset` unnest inside that live query for every row; an indexed child table
-- is a plain join on `ix_ssi_task`. `audit.audit_logs` is the precedent for the SHAPE (actor +
-- occurredAt + payload), `work_item_relations` for the child-row indexing.
--
-- WHY THE MARKER DATES ARE STORED, NOT COMPUTED (plan §2.1). A Split confirmed after the source
-- sprint's end date has no x-position on the source burndown otherwise, and a Split before the
-- target sprint opens must land on the target's opening day (SRS §10.3). Clamping needs the
-- workspace time zone, which the report read path must not re-resolve per row.
--
-- CIRCULAR FK ORDERING (plan §2.4). `story_splits` references `work_items` and
-- `work_items.split_id` references `story_splits`, so the tables are created FIRST and the column
-- is added LAST, in this one migration. The runtime insert order inside the Split transaction is
-- the same shape: `[Unfinished]` Story (`split_id` NULL) → `story_splits` row → UPDATE the Story's
-- `split_id`. A DEFERRABLE constraint would save the third statement and is not worth the
-- surprise.
--
-- Hand-written, like every migration here: `drizzle-kit generate` needs a TTY
-- (docs/lessons/tooling.md:11-24). Mirrored into `db/schema/work.ts` + `db/schema/enums.ts` in the
-- same commit.

-- ── 1. New enums ─────────────────────────────────────────────────────────────
-- Two members, and `story_split_side` is the SOURCE OF TRUTH the domain union now derives from:
-- `split-story.ts`'s `SPLIT_SIDES` was a hand-written `as const` array in SU-01 precisely because
-- this type did not exist yet, and its docblock says to invert the derivation the moment it does
-- (§6 PR 1.1's review note). Three copies of one vocabulary is what that note exists to prevent.
CREATE TYPE "public"."story_split_side" AS ENUM ('unfinished', 'continued');--> statement-breakpoint
CREATE TYPE "public"."story_split_item_kind" AS ENUM ('task', 'defect', 'test_case');--> statement-breakpoint

-- ── 2. work.story_splits ─────────────────────────────────────────────────────
CREATE TABLE "work"."story_splits" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  -- The Story's team AT SPLIT TIME; NULL = project backlog, the same reading as
  -- `work_items.team_id` and `iterations.team_id`.
  "team_id" uuid,
  -- SU-BR-08 — the ORIGINAL id. The original row is UPDATEd, never re-created, so this is also
  -- the Story that keeps its history, comments, attachments and watchers.
  "continued_story_id" uuid NOT NULL REFERENCES "work"."work_items"("id"),
  -- SU-BR-07 — the NEW placeholder, minted with a fresh `US-n` key.
  "unfinished_story_id" uuid NOT NULL REFERENCES "work"."work_items"("id"),
  "source_iteration_id" uuid NOT NULL REFERENCES "work"."iterations"("id"),
  "target_iteration_id" uuid NOT NULL REFERENCES "work"."iterations"("id"),
  -- The Split timestamp. `[Unfinished].accepted_date` is set from this (SU-BR-09).
  "split_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- `split_at`'s workspace-local date, CLAMPED into each iteration's window (see the header).
  "source_marker_date" date NOT NULL,
  "target_marker_date" date NOT NULL,
  -- SU-BR-13's before/after. NULL is legal and is NOT 0: an unpointed Story has no estimate.
  "original_plan_estimate" numeric(6, 2),
  "unfinished_plan_estimate" numeric(6, 2),
  "continued_plan_estimate" numeric(6, 2),
  -- Σ To Do of the Tasks that went to `[Continued]`, and Σ Actual across ALL distributed Tasks.
  -- Both are snapshots for the report layer, never a rollup anything reads back as current truth.
  "moved_todo_hours" numeric(10, 2) DEFAULT 0 NOT NULL,
  "actual_hours_at_split" numeric(10, 2) DEFAULT 0 NOT NULL,
  -- `created_by` semantics. NULL = system (no such path today; a future automatic carryover).
  "actor_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- A Story can be the placeholder of EXACTLY ONE Split. This is the constraint that makes two
-- concurrent confirms of the same modal impossible to both succeed, together with the service's
-- `expectedSourceIterationId` check (plan D9) — belt and braces, because the service check is a
-- read-then-write and this one is not.
CREATE UNIQUE INDEX "uq_story_splits_unfinished" ON "work"."story_splits" ("unfinished_story_id");--> statement-breakpoint
-- A `[Continued]` Story may legitimately be split again, so this one is NOT unique: it is the
-- "show me this Story's split history, newest last" index the banner and SU-10's windowing read.
CREATE INDEX "ix_story_splits_continued" ON "work"."story_splits" ("continued_story_id", "split_at");--> statement-breakpoint
CREATE INDEX "ix_story_splits_source" ON "work"."story_splits" ("source_iteration_id", "source_marker_date");--> statement-breakpoint
CREATE INDEX "ix_story_splits_target" ON "work"."story_splits" ("target_iteration_id", "target_marker_date");--> statement-breakpoint

-- ── 3. work.story_split_items ────────────────────────────────────────────────
-- The polymorphic-column pattern `0083_attachments_polymorphic.sql` uses: one nullable FK per
-- subject kind, plus a CHECK that exactly one is set AND that it matches `item_kind`. A single
-- `subject_id uuid` with no FK would be cheaper to write and would let a deleted Task leave a
-- dangling snapshot the report layer then joins to nothing.
CREATE TABLE "work"."story_split_items" (
  "id" uuid PRIMARY KEY NOT NULL,
  "workspace_id" uuid NOT NULL,
  "split_id" uuid NOT NULL REFERENCES "work"."story_splits"("id") ON DELETE CASCADE,
  "item_kind" "story_split_item_kind" NOT NULL,
  "task_id" uuid REFERENCES "work"."tasks"("id"),
  "work_item_id" uuid REFERENCES "work"."work_items"("id"),
  "test_case_id" uuid REFERENCES "work"."test_cases"("id"),
  "split_side" "story_split_side" NOT NULL,
  -- Tasks only. `actual_hours_at_split` is what SU-10 AC4/AC5's arithmetic reads:
  -- `targetActual = max(0, tasks.actual_hours − actual_hours_at_split)`.
  "estimate_hours_at_split" numeric(8, 2),
  "todo_hours_at_split" numeric(8, 2),
  "actual_hours_at_split" numeric(8, 2),
  -- Defects only — the Iteration Split did NOT touch (SU-BR-18). Recorded so a report can say
  -- "this Defect kept its own Iteration through the Split" without re-reading a mutable column.
  "explicit_iteration_id" uuid REFERENCES "work"."iterations"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ck_ssi_subject_matches_kind" CHECK (
    ("item_kind" = 'task'      AND "task_id" IS NOT NULL AND "work_item_id" IS NULL     AND "test_case_id" IS NULL) OR
    ("item_kind" = 'defect'    AND "task_id" IS NULL     AND "work_item_id" IS NOT NULL AND "test_case_id" IS NULL) OR
    ("item_kind" = 'test_case' AND "task_id" IS NULL     AND "work_item_id" IS NULL     AND "test_case_id" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE INDEX "ix_ssi_split" ON "work"."story_split_items" ("split_id", "item_kind");--> statement-breakpoint
-- LOAD-BEARING: this is the Team Capacity join (SU-10 10.4). Partial, because two thirds of the
-- rows are Defects and Test Cases that this join never wants.
CREATE INDEX "ix_ssi_task" ON "work"."story_split_items" ("task_id") WHERE "task_id" IS NOT NULL;--> statement-breakpoint

-- ── 4. work.work_items.split_id ──────────────────────────────────────────────
-- `split_id IS NOT NULL` ⇔ "this Story is a Split/Carryover historical placeholder; it never earns
-- delivery credit" (plan D6). It is an index-friendly predicate, which is why the flag lives here
-- rather than being a join to `story_splits` inside the hourly snapshot loop and the live Velocity
-- classifier.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a Split Event must not delete a Story.
--
-- It is added to NO `Create*`/`Update*` zod schema — the contract must not advertise a column only
-- the Split path may write (the `last_verdict` precedent, CLAUDE.md:1020).
ALTER TABLE "work"."work_items"
  ADD COLUMN "split_id" uuid REFERENCES "work"."story_splits"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX "ix_wi_split_id" ON "work"."work_items" ("split_id") WHERE "split_id" IS NOT NULL;
