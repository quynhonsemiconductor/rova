-- The advisory load ceiling goes away, with the warning it fed.
--
-- `capacity_plans.target_load_pct` (NOT NULL DEFAULT 80) existed for exactly one rule:
-- `load_above_target`, raised when a team's committed demand passed `capacity * target/100` while still
-- inside capacity. It was ours, not the BA's — the specified advisory set is the three comparisons Rally
-- raises by name plus the missing-estimate rule, and none of them rations headroom.
--
-- It also could not be read. Every surface drew warnings with the same red `AlertTriangle`, so a team at
-- 85% of capacity — healthy, and the state Rally's own guidance recommends — was indistinguishable from
-- one that had blown through its ceiling. A warning that cannot be told apart from a breach spends the
-- planner's attention without directing it.
--
-- Three inconsistent upper bounds were also live at once, which is its own evidence that nothing depended
-- on the exact value: the CHECK allowed 100, the domain rule required < 100, and the edit field capped at
-- 99.
--
-- Dropping the column drops its CHECK with it, but the constraint is dropped explicitly first so the
-- intent is stated rather than inferred from a cascade.
ALTER TABLE "work"."capacity_plans"
  DROP CONSTRAINT IF EXISTS "ck_capacity_target_load_range";--> statement-breakpoint

ALTER TABLE "work"."capacity_plans"
  DROP COLUMN IF EXISTS "target_load_pct";
