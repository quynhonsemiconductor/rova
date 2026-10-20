-- Milestones become assignable to a portfolio item, not just a work item.
--
-- `SRS.md:104` requires a Milestone multi-select in the Feature detail right rail, scoped to
-- the Feature's Project plus any already-selected Milestones, and `SRS.md:392` requires the
-- same on an Epic. `milestone_artifacts` was keyed by a plain `work_item_id`, so there was
-- nowhere to record it.
--
-- Third table to take the `(entity_type, entity_id)` shape `activity_logs` set, and it reuses
-- the SAME `entity_ref_type` enum that 0082 (comments) and 0083 (attachments) use. That enum
-- exists to list the things that own child records; a milestone assignment is one.
--
-- The table KEEPS its name, unlike 0083's rename of `work_item_attachments`. "Artifact" is
-- already the entity-agnostic word — Rally itself calls the things a milestone tracks its
-- artifacts — so the name was never work-item-specific. Only the column was.
--
-- Statement order IS the safety argument, as in 0082 and 0083: the backfill runs while
-- `work_item_id` still exists, and the column is dropped only afterwards, so every existing
-- assignment keeps its subject.
--
-- The PRIMARY KEY moves from (milestone_id, work_item_id) to
-- (milestone_id, entity_type, entity_id). It stays a natural key rather than gaining a
-- surrogate id: assigning the same milestone to the same item twice is still one assignment,
-- and that constraint is what enforces it.

ALTER TABLE "work"."milestone_artifacts"
  ADD COLUMN "entity_type" "entity_ref_type" NOT NULL DEFAULT 'work_item',
  ADD COLUMN "entity_id" uuid;--> statement-breakpoint

-- Every existing assignment is on a work item, by construction.
UPDATE "work"."milestone_artifacts" SET "entity_id" = "work_item_id" WHERE "entity_id" IS NULL;--> statement-breakpoint

ALTER TABLE "work"."milestone_artifacts"
  ALTER COLUMN "entity_id" SET NOT NULL,
  -- The default existed only to let ADD COLUMN succeed on a populated table. Leaving it would
  -- silently absorb a caller that forgot to say what it was assigning.
  ALTER COLUMN "entity_type" DROP DEFAULT;--> statement-breakpoint

-- Dropping work_item_id takes the old PK and its FK with it, so the PK is rebuilt below.
ALTER TABLE "work"."milestone_artifacts" DROP CONSTRAINT "milestone_artifacts_pkey";--> statement-breakpoint
DROP INDEX IF EXISTS "work"."ix_ma_work_item";--> statement-breakpoint
ALTER TABLE "work"."milestone_artifacts" DROP COLUMN "work_item_id";--> statement-breakpoint

ALTER TABLE "work"."milestone_artifacts"
  ADD CONSTRAINT "milestone_artifacts_pkey" PRIMARY KEY ("milestone_id", "entity_type", "entity_id");--> statement-breakpoint

-- Replaces ix_ma_work_item. Reads go both ways — "the milestones on THIS item" (the detail
-- rail) and "the items on THIS milestone" (the milestone page), so both directions are indexed:
-- the PK's leading column serves the second, this index serves the first.
CREATE INDEX "ix_ma_entity" ON "work"."milestone_artifacts" ("entity_type", "entity_id");
