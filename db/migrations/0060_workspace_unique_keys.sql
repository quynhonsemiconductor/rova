-- 0060: workspace-unique work-item keys (Rally FormattedID).
--
-- Move item_key uniqueness + the numbering sequence from per-PROJECT to
-- per-WORKSPACE, so a key like US-42 is unique across the whole workspace. This
-- makes SCM linking org-level (resolve by (key, workspace), no repo→project map).
--
-- Clean renumber: existing per-project keys collide across projects, so we
-- renumber every work item + task to a workspace-wide sequence per type (ordered
-- by created_at) and seed the new counter from the result. SCM links are by
-- work_item_id (uuid), not key, so renumbering cannot break existing links.

-- 1. Workspace-grain counter (replaces work.project_counters).
CREATE TABLE IF NOT EXISTS "work"."workspace_item_counters" (
  "workspace_id"     uuid NOT NULL,
  "item_type"        "public"."work_item_type" NOT NULL DEFAULT 'story',
  "last_item_number" integer NOT NULL DEFAULT 0,
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "workspace_item_counters_pk" PRIMARY KEY ("workspace_id", "item_type")
);
--> statement-breakpoint

-- 2. Drop the per-project unique indexes before renumbering.
DROP INDEX IF EXISTS "work"."uq_wi_item_key";
--> statement-breakpoint
DROP INDEX IF EXISTS "work"."uq_task_item_key";
--> statement-breakpoint

-- 3a. Renumber work_items workspace-wide per type (IN/FE/US/DE).
WITH renum AS (
  SELECT
    id,
    CASE "type"
      WHEN 'initiative' THEN 'IN'
      WHEN 'feature'    THEN 'FE'
      WHEN 'story'      THEN 'US'
      WHEN 'defect'     THEN 'DE'
      ELSE 'US'
    END AS prefix,
    ROW_NUMBER() OVER (PARTITION BY "workspace_id", "type" ORDER BY "created_at", "id") AS n
  FROM "work"."work_items"
)
UPDATE "work"."work_items" w
SET "item_key" = renum.prefix || '-' || renum.n
FROM renum
WHERE w."id" = renum."id";
--> statement-breakpoint

-- 3b. Renumber tasks workspace-wide (all TA).
WITH renum AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY "workspace_id" ORDER BY "created_at", "id") AS n
  FROM "work"."tasks"
)
UPDATE "work"."tasks" t
SET "item_key" = 'TA-' || renum.n
FROM renum
WHERE t."id" = renum."id";
--> statement-breakpoint

-- 4. New workspace-unique indexes.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_wi_item_key"
  ON "work"."work_items" USING btree ("workspace_id", "item_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_task_item_key"
  ON "work"."tasks" USING btree ("workspace_id", "item_key");
--> statement-breakpoint

-- 5. Seed the workspace counter from the renumbered max per (workspace, type).
INSERT INTO "work"."workspace_item_counters" ("workspace_id", "item_type", "last_item_number")
SELECT "workspace_id", "type", MAX(CAST(split_part("item_key", '-', 2) AS integer))
FROM "work"."work_items"
GROUP BY "workspace_id", "type"
ON CONFLICT ("workspace_id", "item_type")
  DO UPDATE SET "last_item_number" = EXCLUDED."last_item_number", "updated_at" = now();
--> statement-breakpoint
INSERT INTO "work"."workspace_item_counters" ("workspace_id", "item_type", "last_item_number")
SELECT "workspace_id", 'task'::"public"."work_item_type", MAX(CAST(split_part("item_key", '-', 2) AS integer))
FROM "work"."tasks"
GROUP BY "workspace_id"
ON CONFLICT ("workspace_id", "item_type")
  DO UPDATE SET "last_item_number" = EXCLUDED."last_item_number", "updated_at" = now();
--> statement-breakpoint

-- 6. Drop the now-unused per-project counter + the SCM repo→project mapping
--    (SCM is workspace-scoped now).
DROP TABLE IF EXISTS "work"."project_counters";
--> statement-breakpoint
DROP TABLE IF EXISTS "scm"."repository_projects";
