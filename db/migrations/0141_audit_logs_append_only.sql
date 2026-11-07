-- audit_logs is APPEND-ONLY for BOTH runtime roles.
--
-- Migration 0068 granted SELECT, INSERT, UPDATE, DELETE on every table in every app
-- schema to both runtime roles, and 0140 revoked DELETE from rova_worker only. The
-- API meanwhile held UPDATE and DELETE it never uses: audit.drizzle-repository only
-- INSERTs, and the worker relay projects outbox events into the table. So those were
-- unused privileges on the audit trail — an injection or a bug in the API could
-- rewrite or erase it.
--
-- Revoke both from both roles. SELECT and INSERT stay: readers query the trail, and
-- both the API-side producer and the worker's projection write to it.
--
-- The fixture reset TRUNCATEs as the database owner (db/seeds/reset.ts resolves
-- DATABASE_MIGRATION_URL first and refuses the runtime roles), and TRUNCATE is a
-- separate privilege no runtime role holds, so nothing needs DELETE back here.
--
-- Metadata-only: no table rewrite, no lock beyond the catalogue entry.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['rova_app', 'rova_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE UPDATE, DELETE ON audit.audit_logs FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
