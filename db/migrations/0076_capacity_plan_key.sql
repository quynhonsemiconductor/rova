-- Capacity plans get a human key, as every other planning entity already has.
--
-- Rally's Capacity Planning list leads with an ID column (`PN1915`) that links to the plan, and
-- ours had no key at all: the list keyed rows on a UUID, so a plan could not be cited in a
-- conversation or a ticket. `CP-<n>` follows the family already in use (IT-/RE-/MS-/PR-), minted
-- per project like `iterations.iteration_key`.
--
-- Nullable + backfilled rather than NOT NULL: existing rows predate the column, and the minting
-- path is MAX(existing)+1 with a retry, which needs the unique index below to be the guarantee.
ALTER TABLE "work"."capacity_plans" ADD COLUMN IF NOT EXISTS "plan_key" varchar(30);--> statement-breakpoint

-- Backfill in creation order, per project, so the numbers read as the order the plans were made.
WITH numbered AS (
  SELECT "id", 'CP-' || row_number() OVER (
           PARTITION BY "project_id" ORDER BY "created_at", "id"
         ) AS k
  FROM "work"."capacity_plans"
  WHERE "plan_key" IS NULL
)
UPDATE "work"."capacity_plans" p
SET "plan_key" = numbered.k
FROM numbered
WHERE p."id" = numbered."id";--> statement-breakpoint

-- Per PROJECT, matching `uq_iterations_key`: the key is minted from a per-project counter, so two
-- projects each having a CP-1 is correct and expected.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_capacity_plans_key"
  ON "work"."capacity_plans" ("project_id", "plan_key");
