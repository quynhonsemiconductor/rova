-- Optimistic concurrency for work items (MCP v2 G1).
--
-- A monotonic counter is the precondition token. The timestamp alternative is not safe: two
-- writes inside the same millisecond share `updated_at`, so a stale ETag would compare equal
-- and the second write would silently win. Expand-only: existing rows start at 0.
ALTER TABLE work.work_items ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;
-- Tasks are work items on the API surface (their own table), and a task response carries its
-- own version, so the counter is part of that table too.
ALTER TABLE work.tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 0;

-- ONE mechanism, in the database. Every writer of either table bumps the counter: the app's
-- UPDATE, a raw SQL script, a backfill, a foreign-key ON DELETE SET NULL that rewrites a child
-- (iteration_id, release_id, dev_owner_id, split_id, found_in_release_id ...), or an older pod
-- during a rollout. An app-side SET version = version + 1 cannot see the writers it does not run.
CREATE OR REPLACE FUNCTION work.bump_version() RETURNS trigger AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_bump_version" ON "work"."work_items";
CREATE TRIGGER "trg_bump_version"
  BEFORE UPDATE ON "work"."work_items"
  FOR EACH ROW EXECUTE FUNCTION "work"."bump_version"();

DROP TRIGGER IF EXISTS "trg_bump_version" ON "work"."tasks";
CREATE TRIGGER "trg_bump_version"
  BEFORE UPDATE ON "work"."tasks"
  FOR EACH ROW EXECUTE FUNCTION "work"."bump_version"();
