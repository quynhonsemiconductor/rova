-- ============================================================================
-- Migration 0137: runtime grants and default privileges for rova_app / rova_worker
-- ============================================================================
-- On-prem, CNPG creates `rova_app`, `rova_worker` and `rova_migrator` (managed
-- roles, passwords from Key Vault) and `rova_migrator` owns the `rova` database
-- with NO CREATEROLE. Migrations run as `rova_migrator`, which owns every object
-- it creates, but ownership is not access: the two runtime roles had grants on a
-- FRESH database only because 0068 granted them at the time it ran, and 0128 —
-- the rename — skips itself when the `rova_*` roles already exist, so a database
-- whose roles the platform created never received them.
--
-- This migration re-states the whole runtime grant set, idempotently, so the
-- end state does not depend on which of 0068/0128 ran first or whether they
-- created the roles themselves. The set is the same one the data-move runbook's
-- `post-restore-grants.sql` applies after a restore.
--
-- Default privileges are set FOR the role that grants them — the role running
-- this migration, which on-prem is `rova_migrator` (the owner, and so the
-- creator of every future table). Naming `rova_migrator` explicitly would fail
-- on the AWS-era path, where that role does not exist and the RDS master still
-- owns the objects; `current_user` is the same role there.
--
-- Additive only: GRANT and ALTER DEFAULT PRIVILEGES add rights and revoke
-- nothing. No DDL, no role creation, nothing destructive — safe to run on the
-- production database (AWS RDS, PG 17) at whatever head it holds.
-- ============================================================================

DO $$
DECLARE
  app_schemas CONSTANT text[] := ARRAY[
    'identity', 'workspace', 'access', 'work', 'messaging',
    'notifications', 'audit', 'storage', 'scm'
  ];
  runtime_roles CONSTANT text[] := ARRAY['rova_app', 'rova_worker'];
  present_roles text[] := ARRAY[]::text[];
  role_list text;
  s text;
  r text;
BEGIN
  FOREACH r IN ARRAY runtime_roles LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      present_roles := present_roles || r;
    END IF;
  END LOOP;

  IF cardinality(present_roles) = 0 THEN
    RAISE EXCEPTION
      'Migration 0137 found none of the runtime roles %. They are provisioned by the platform '
      '(CNPG managed roles on-prem; db/runbooks/db-role-least-privilege.md on AWS).',
      runtime_roles;
  END IF;

  role_list := array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ');

  FOREACH s IN ARRAY app_schemas LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s) THEN
      CONTINUE;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %s', s, role_list);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %s', s, role_list);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %s', s, role_list);

    -- Future tables and sequences: covered for whatever creates them from here
    -- on. Idempotent — re-running replaces the same rows in pg_default_acl.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %s',
      s, role_list
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %s',
      s, role_list
    );
  END LOOP;
END $$;
