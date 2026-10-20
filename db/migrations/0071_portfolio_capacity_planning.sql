-- ============================================================================
-- P5 — Portfolio Items + Capacity Planning (schema only)
--
-- Adds hierarchy ABOVE Story/Defect (Epic → Feature) and the single-Release
-- capacity plan that allocates Features to Teams. No behaviour ships here: no
-- endpoint reads these tables yet, and every existing query is untouched, so
-- applying this migration changes nothing a user can see.
--
-- Hand-written, per CLAUDE.md — `drizzle-kit generate` needs a TTY and cannot run
-- unattended, so db/migrations/*.sql are authored by hand and must match
-- db/schema/*.
--
-- Two decisions are encoded here and are expensive to reverse later, so they are
-- stated rather than implied:
--
--   1. Epic and Feature share ONE table, discriminated by `type`. The BA spec
--      gives them one list, one state enum, one create template, one rank column
--      and one archive rule; their only differences are three nullable columns.
--      The CHECK constraints below are what keep the two shapes honest.
--
--   2. The Preliminary Estimate size→points/count mapping is workspace
--      CONFIGURATION, not a constant. The BA spec calls the mockup values
--      "temporary mockup data" and defers the real scale to
--      Settings > Workspace > Project Management; Rally makes the equivalent
--      mapping a workspace-admin setting.
-- ============================================================================

-- ── enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "public"."portfolio_item_type" AS ENUM ('epic', 'feature');--> statement-breakpoint

-- 11 values, BA-confirmed. Deliberately NOT work_item_schedule_state: a portfolio
-- item's lifecycle is an intake/discovery funnel, a story's is a delivery flow.
CREATE TYPE "public"."portfolio_item_state" AS ENUM (
  'no_entry', 'intake', 'idea_prioritization', 'problem_discovery',
  'solution_discovery', 'feature_prioritization', 'developing',
  'accepted', 'measuring', 'done', 'cancelled'
);--> statement-breakpoint

CREATE TYPE "public"."preliminary_estimate_size" AS ENUM ('no_entry', 'xs', 's', 'm', 'l', 'xl');--> statement-breakpoint

CREATE TYPE "public"."capacity_plan_status" AS ENUM ('draft', 'published');--> statement-breakpoint

CREATE TYPE "public"."capacity_plan_unit" AS ENUM ('points', 'count');--> statement-breakpoint

-- ── portfolio_items ─────────────────────────────────────────────────────────

CREATE TABLE "work"."portfolio_items" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"                uuid NOT NULL,
  "project_id"                  uuid NOT NULL,
  "item_key"                    varchar(30) NOT NULL,
  "type"                        "public"."portfolio_item_type" NOT NULL,
  "name"                        varchar(255) NOT NULL,
  "description"                 text,
  "state"                       "public"."portfolio_item_state" DEFAULT 'no_entry' NOT NULL,
  "preliminary_estimate"        "public"."preliminary_estimate_size" DEFAULT 'no_entry' NOT NULL,
  "refined_estimate"            numeric(8,2),
  "refined_item_count_estimate" integer,
  "parent_id"                   uuid,
  "team_id"                     uuid,
  "release_id"                  uuid,
  "owner_id"                    uuid,
  "planned_start_date"          date,
  "planned_end_date"            date,
  "market_release_date"         date,
  "rank"                        varchar(255) DEFAULT '' NOT NULL,
  "archived_at"                 timestamptz,
  "created_at"                  timestamptz DEFAULT now() NOT NULL,
  "updated_at"                  timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Type shape, enforced in the DATABASE on purpose.
--
-- db/seeds/** writes rows without going through the service layer, so an
-- invariant that lives only in a service is not an invariant — the same lesson
-- as flow=schedule. An Epic is a project-level grouping: it has no Team, no
-- Release and no parent (Theme and deeper hierarchy are out of scope).
ALTER TABLE "work"."portfolio_items"
  ADD CONSTRAINT "ck_portfolio_epic_shape" CHECK (
    "type" <> 'epic'
    OR ("team_id" IS NULL AND "release_id" IS NULL AND "parent_id" IS NULL)
  );--> statement-breakpoint

-- Cheap guard against the one-row cycle. Deeper cycles cannot occur while the
-- hierarchy is two levels and only a Feature may carry a parent.
ALTER TABLE "work"."portfolio_items"
  ADD CONSTRAINT "ck_portfolio_no_self_parent" CHECK ("parent_id" IS NULL OR "parent_id" <> "id");--> statement-breakpoint

-- A forecast is a positive number or absent. Zero would be indistinguishable from
-- "not forecast" in the estimate tier chain, where `refined > 0` selects the tier.
ALTER TABLE "work"."portfolio_items"
  ADD CONSTRAINT "ck_portfolio_refined_positive" CHECK (
    ("refined_estimate" IS NULL OR "refined_estimate" > 0)
    AND ("refined_item_count_estimate" IS NULL OR "refined_item_count_estimate" > 0)
  );--> statement-breakpoint

CREATE INDEX "ix_portfolio_workspace" ON "work"."portfolio_items" ("workspace_id");--> statement-breakpoint
CREATE INDEX "ix_portfolio_project"   ON "work"."portfolio_items" ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_portfolio_item_key" ON "work"."portfolio_items" ("workspace_id", "item_key");--> statement-breakpoint
-- The list query: filter (workspace, type), hide archived, order by rank.
CREATE INDEX "ix_portfolio_list"   ON "work"."portfolio_items" ("workspace_id", "type", "archived_at", "rank");--> statement-breakpoint
-- Children-of-Epic preview + the Epic rollup.
CREATE INDEX "ix_portfolio_parent" ON "work"."portfolio_items" ("parent_id", "rank");--> statement-breakpoint
CREATE INDEX "ix_portfolio_team"    ON "work"."portfolio_items" ("team_id");--> statement-breakpoint
CREATE INDEX "ix_portfolio_release" ON "work"."portfolio_items" ("release_id");--> statement-breakpoint

-- ── work_items.feature_id ───────────────────────────────────────────────────
--
-- The link every Percent Done and Capacity metric aggregates over. Nullable: most
-- work items belong to no Feature and the Backlog must behave exactly as before.
--
-- No FK: Postgres cannot reference a filtered subset, and "must point at a
-- portfolio item of type 'feature', never an epic" is asserted in the portfolio
-- service on write.
ALTER TABLE "work"."work_items" ADD COLUMN "feature_id" uuid;--> statement-breakpoint

-- Partial: the column is null for most rows, so a full index would be mostly
-- dead entries.
CREATE INDEX "ix_wi_feature" ON "work"."work_items" ("feature_id")
  WHERE "feature_id" IS NOT NULL AND "deleted_at" IS NULL;--> statement-breakpoint

-- ── capacity_plans ──────────────────────────────────────────────────────────

CREATE TABLE "work"."capacity_plans" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id"       uuid NOT NULL,
  "project_id"         uuid NOT NULL,
  "release_id"         uuid NOT NULL,
  "name"               varchar(255) NOT NULL,
  "status"             "public"."capacity_plan_status" DEFAULT 'draft' NOT NULL,
  "unit"               "public"."capacity_plan_unit" NOT NULL,
  "planned_start_date" date,
  "planned_end_date"   date,
  "target_load_pct"    integer DEFAULT 80 NOT NULL,
  "published_at"       timestamptz,
  "published_by"       uuid,
  "created_at"         timestamptz DEFAULT now() NOT NULL,
  "updated_at"         timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Advisory ceiling below 100%, so a team at 95% still warns. Rally's guidance is
-- to leave roughly 20% of a team's capacity for unplanned work. 100 is allowed —
-- it disables the extra warning without disabling the over-capacity ones.
ALTER TABLE "work"."capacity_plans"
  ADD CONSTRAINT "ck_capacity_target_load_range" CHECK ("target_load_pct" BETWEEN 1 AND 100);--> statement-breakpoint

CREATE INDEX "ix_capacity_plans_workspace" ON "work"."capacity_plans" ("workspace_id");--> statement-breakpoint
CREATE INDEX "ix_capacity_plans_project"   ON "work"."capacity_plans" ("project_id");--> statement-breakpoint
-- One plan per Project+Release (BA spec §3.3). The rule the whole feature rests
-- on, so it is a constraint rather than a service check.
CREATE UNIQUE INDEX "uq_capacity_plan_project_release" ON "work"."capacity_plans" ("project_id", "release_id");--> statement-breakpoint

-- ── capacity_plan_teams ─────────────────────────────────────────────────────

CREATE TABLE "work"."capacity_plan_teams" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id"    uuid NOT NULL,
  "team_id"    uuid NOT NULL,
  -- NULL means "not entered yet", which must render blank rather than 0 —
  -- zero capacity is a deliberate planner statement and reads differently.
  "capacity"   numeric(10,2),
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "work"."capacity_plan_teams"
  ADD CONSTRAINT "fk_capacity_plan_teams_plan" FOREIGN KEY ("plan_id")
  REFERENCES "work"."capacity_plans"("id") ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "work"."capacity_plan_teams"
  ADD CONSTRAINT "ck_capacity_non_negative" CHECK ("capacity" IS NULL OR "capacity" >= 0);--> statement-breakpoint

CREATE INDEX "ix_capacity_plan_teams_plan" ON "work"."capacity_plan_teams" ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_capacity_plan_team" ON "work"."capacity_plan_teams" ("plan_id", "team_id");--> statement-breakpoint

-- ── capacity_plan_allocations ───────────────────────────────────────────────

CREATE TABLE "work"."capacity_plan_allocations" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id"           uuid NOT NULL,
  "portfolio_item_id" uuid NOT NULL,
  -- NULL = the Unallocated bucket. Modelling it this way avoids a second table and
  -- is why "Total Allocated" counts only rows WHERE team_id IS NOT NULL: an
  -- unallocated placeholder must not outrank a Refined or Preliminary estimate.
  "team_id"           uuid,
  -- THE ONLY stored number in P5. Everything else is aggregated on read.
  -- Fixed at planning time so committed demand does not drift when the Feature's
  -- child estimates change later. Do not turn this into a rollup.
  "value"             numeric(10,2) DEFAULT '0' NOT NULL,
  "created_at"        timestamptz DEFAULT now() NOT NULL,
  "updated_at"        timestamptz DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "work"."capacity_plan_allocations"
  ADD CONSTRAINT "fk_capacity_allocations_plan" FOREIGN KEY ("plan_id")
  REFERENCES "work"."capacity_plans"("id") ON DELETE CASCADE;--> statement-breakpoint

-- Removing a Feature from the portfolio must not leave an allocation pointing at
-- nothing. Archiving (the normal path) does not delete the row, so this fires only
-- on a genuine hard delete.
ALTER TABLE "work"."capacity_plan_allocations"
  ADD CONSTRAINT "fk_capacity_allocations_item" FOREIGN KEY ("portfolio_item_id")
  REFERENCES "work"."portfolio_items"("id") ON DELETE CASCADE;--> statement-breakpoint

ALTER TABLE "work"."capacity_plan_allocations"
  ADD CONSTRAINT "ck_capacity_allocation_non_negative" CHECK ("value" >= 0);--> statement-breakpoint

CREATE INDEX "ix_capacity_allocations_plan"      ON "work"."capacity_plan_allocations" ("plan_id");--> statement-breakpoint
CREATE INDEX "ix_capacity_allocations_item"      ON "work"."capacity_plan_allocations" ("portfolio_item_id");--> statement-breakpoint
CREATE INDEX "ix_capacity_allocations_plan_team" ON "work"."capacity_plan_allocations" ("plan_id", "team_id");--> statement-breakpoint

-- ── workspace_settings.preliminary_estimate_map ─────────────────────────────
--
-- Seeded with the BA's documented defaults so Phase 5 has a working fallback
-- before the Settings > Workspace > Project Management UI exists. Every read goes
-- through this column, never a code constant, so an operator's change is honoured
-- the moment it is made.
ALTER TABLE "workspace"."workspace_settings"
  ADD COLUMN "preliminary_estimate_map" jsonb DEFAULT '{
    "no_entry": {"points": 0,  "count": 0},
    "xs":       {"points": 1,  "count": 1},
    "s":        {"points": 3,  "count": 2},
    "m":        {"points": 5,  "count": 3},
    "l":        {"points": 8,  "count": 5},
    "xl":       {"points": 13, "count": 8}
  }'::jsonb NOT NULL;--> statement-breakpoint

-- Existing rows take the default above rather than '{}', so no workspace is left
-- without a mapping. Explicit because ADD COLUMN ... DEFAULT backfills, but a
-- future re-run against a partially migrated database must converge too.
UPDATE "workspace"."workspace_settings"
SET "preliminary_estimate_map" = '{
  "no_entry": {"points": 0,  "count": 0},
  "xs":       {"points": 1,  "count": 1},
  "s":        {"points": 3,  "count": 2},
  "m":        {"points": 5,  "count": 3},
  "l":        {"points": 8,  "count": 5},
  "xl":       {"points": 13, "count": 8}
}'::jsonb
WHERE "preliminary_estimate_map" = '{}'::jsonb;
