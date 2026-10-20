-- Refined Estimate becomes NOT NULL DEFAULT 0, matching real Rally.
--
-- 0071 added `ck_portfolio_refined_positive` (`IS NULL OR > 0`) on the reasoning that
-- "zero would be indistinguishable from 'not forecast'". That is true, and it is also
-- exactly what we want: real Rally shows these fields as 0 rather than blank, and lets a
-- planner type 0. Broadcom documents no rule either way, so the observed product wins.
--
-- Making 0 the ABSENT state instead of NULL keeps every downstream rule intact, because
-- the estimate tier chain already treats 0 as "not forecast":
--
--   Capacity Planning SRS: "Refined Estimate = Feature.refinedEstimate |
--   refinedWorkItemCountEstimate -> if > 0"
--
-- So `> 0` still selects the refined tier and 0 still falls through to the Preliminary
-- Estimate mapping — the behaviour Portfolio Items SRS §5 calls "blank falls back to
-- Preliminary Estimate mapping". What changes is only how "no forecast" is REPRESENTED:
-- one value (0) instead of two (NULL and, formerly, an illegal 0). That removes the
-- nullable/positive ambiguity rather than trading it for a new one.
--
-- Existing NULLs backfill to 0, which is behaviour-preserving: both resolve to the
-- preliminary tier.

ALTER TABLE "work"."portfolio_items"
  DROP CONSTRAINT IF EXISTS "ck_portfolio_refined_positive";--> statement-breakpoint

UPDATE "work"."portfolio_items" SET "refined_estimate" = 0 WHERE "refined_estimate" IS NULL;--> statement-breakpoint
UPDATE "work"."portfolio_items"
  SET "refined_item_count_estimate" = 0 WHERE "refined_item_count_estimate" IS NULL;--> statement-breakpoint

ALTER TABLE "work"."portfolio_items"
  ALTER COLUMN "refined_estimate" SET DEFAULT 0,
  ALTER COLUMN "refined_estimate" SET NOT NULL,
  ALTER COLUMN "refined_item_count_estimate" SET DEFAULT 0,
  ALTER COLUMN "refined_item_count_estimate" SET NOT NULL;--> statement-breakpoint

-- Negative is still nonsense for a forecast; 0 is now the floor rather than excluded.
ALTER TABLE "work"."portfolio_items"
  ADD CONSTRAINT "ck_portfolio_refined_non_negative" CHECK (
    "refined_estimate" >= 0 AND "refined_item_count_estimate" >= 0
  );
