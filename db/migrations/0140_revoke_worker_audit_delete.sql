-- audit_logs is append-only from the worker's side.
--
-- Migration 0068 granted SELECT, INSERT, UPDATE, DELETE on every table in every app
-- schema to both runtime roles, which is wider than the audit contract: the worker writes
-- audit rows (outbox consumer) but must never delete them. The retention sweep deliberately
-- does not touch audit, and this REVOKE makes that structural rather than a promise in code.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rova_worker') THEN
    REVOKE DELETE ON audit.audit_logs FROM rova_worker;
  END IF;
END $$;
