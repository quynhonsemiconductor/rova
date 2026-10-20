-- 0040: Align defect_severity enum to the BA taxonomy (mini-rally).
-- Previously the tokens were priority-flavoured (high/medium/low) while the app
-- layer remapped labels (high→"Major Problem", etc.). We now make the DB tokens
-- equal the business vocabulary so there is a single source of truth and no
-- label-remap layer. Pure value renames — existing rows are preserved.
--
-- critical → critical (unchanged)
-- high     → major
-- medium   → minor
-- low      → trivial
-- none     → none (unchanged)
ALTER TYPE "work"."defect_severity" RENAME VALUE 'high' TO 'major';
--> statement-breakpoint
ALTER TYPE "work"."defect_severity" RENAME VALUE 'medium' TO 'minor';
--> statement-breakpoint
ALTER TYPE "work"."defect_severity" RENAME VALUE 'low' TO 'trivial';
