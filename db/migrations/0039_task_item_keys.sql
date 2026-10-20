-- 0039: Give tasks a real-Rally TA-prefixed FormattedID (item_key).
-- Tasks live in their own table (work.tasks) and previously had no item_key,
-- so the grid showed empty IDs for child tasks. This mirrors the work_items
-- keying model: type prefix (TA) + zero-padded sequential number, unique per project.

ALTER TABLE "work"."tasks" ADD COLUMN IF NOT EXISTS "item_key" varchar(30) NOT NULL DEFAULT '';
--> statement-breakpoint
-- Backfill existing rows: number tasks per project by their board order
-- (rank, then creation time) so the sequence is stable and deterministic.
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY rank ASC, created_at ASC) AS seq
  FROM "work"."tasks"
  WHERE item_key = ''
)
UPDATE "work"."tasks" t
SET item_key = 'TA' || LPAD(n.seq::text, 6, '0')
FROM numbered n
WHERE t.id = n.id;
--> statement-breakpoint
-- Advance the per-project task counter so newly created tasks continue the sequence
-- instead of colliding with backfilled keys.
UPDATE "work"."project_counters" pc
SET "last_item_number" = GREATEST(pc.last_item_number, mk.max_num), "updated_at" = now()
FROM (
  SELECT project_id,
         MAX(CASE WHEN item_key ~ '^TA[0-9]+$' THEN CAST(SUBSTRING(item_key FROM 3) AS INTEGER) ELSE 0 END) AS max_num
  FROM "work"."tasks"
  GROUP BY project_id
) mk
WHERE pc.project_id = mk.project_id AND pc.item_type = 'task';
--> statement-breakpoint
-- All rows populated — drop the temporary default so the column is explicit on insert.
ALTER TABLE "work"."tasks" ALTER COLUMN "item_key" DROP DEFAULT;
--> statement-breakpoint
-- Keys are unique per project (same model as work_items.uq_wi_item_key).
CREATE UNIQUE INDEX IF NOT EXISTS "uq_task_item_key" ON "work"."tasks" ("project_id", "item_key");
