-- Optimistic concurrency for work items (MCP v2 G1).
--
-- A monotonic counter is the precondition token. The timestamp alternative is not safe: two
-- writes inside the same millisecond share `updated_at`, so a stale ETag would compare equal
-- and the second write would silently win. Expand-only: existing rows start at 0, and every
-- UPDATE of the row increments the counter in the same statement.
ALTER TABLE work.work_items ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
-- Tasks are work items on the API surface (their own table), and a task response carries its
-- own version, so the counter is part of that table too.
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

-- Triggers that write a versioned row must bump the counter too, or their change would be
-- invisible to If-Match (and a stale token could still win). Same functions, +1 added.
CREATE OR REPLACE FUNCTION work.sync_actual_hours()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_work_item_id uuid;
  v_total        numeric(8, 2);
BEGIN
  v_work_item_id := COALESCE(NEW.work_item_id, OLD.work_item_id);

  SELECT COALESCE(SUM(hours), 0)
    INTO v_total
    FROM work.time_logs
   WHERE work_item_id = v_work_item_id
     AND deleted_at   IS NULL;

  UPDATE work.work_items
     SET actual_hours = v_total,
         updated_at   = now(),
         version      = version + 1
   WHERE id = v_work_item_id;

  UPDATE work.tasks
     SET actual_hours = v_total,
         updated_at   = now(),
         version      = version + 1
   WHERE id = v_work_item_id;

  RETURN NULL;
END;
$$;

-- Moving a parent's iteration cascades into its tasks (0095); each task row is a write.
CREATE OR REPLACE FUNCTION work.cascade_iteration_to_tasks()
RETURNS trigger AS $$
BEGIN
  UPDATE work.tasks
     SET iteration_id = NEW.iteration_id,
         updated_at   = now(),
         version      = version + 1
   WHERE parent_id = NEW.id
     AND deleted_at IS NULL
     AND COALESCE(iteration_id::text, '') <> COALESCE(NEW.iteration_id::text, '');
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
