-- ============================================================================
-- Migration 0068: least-privilege database roles
-- ============================================================================
-- Today the API, the worker AND the migrator all connect with the RDS master
-- credential (infra/modules/stack/main.tf — DATABASE_USER/PASSWORD are wired to
-- `module.rds.master_secret_arn` for all three). That single credential owns
-- every object in the database, so an ordinary request runs with rights to DROP
-- the schema it is reading, and any future row-level policy would be bypassed
-- silently: a table's owner is exempt from RLS unless FORCE ROW LEVEL SECURITY
-- is also set. That exemption is exactly what made the RLS layer added in 0005
-- inert, and it is recorded as the audit's top finding in
-- docs/superpowers/specs/2026-07-09-drop-multi-tenant-merge-into-workspace-design.md.
--
-- This migration creates the roles and the grants. It deliberately does NOT
-- switch anything over:
--
--   * The roles are created NOLOGIN. They cannot connect, cannot be used, and
--     cannot lock anyone out. Applying this migration changes the behaviour of
--     exactly nothing that is running.
--   * Cutover — generating passwords, storing them in Secrets Manager, pointing
--     DATABASE_USER/PASSWORD at the app secret, and granting LOGIN — is a
--     deliberate, separately reviewed step. See
--     docs/runbooks/db-role-least-privilege.md.
--
-- `db/migrate.ts` already reads DATABASE_MIGRATION_URL in preference to
-- DATABASE_URL, and `.env.example` already names `rally_app` / `rally_migrate`,
-- so the application side of the split needs no code change — only the two
-- credentials it is handed.
--
-- Idempotent: safe to re-run, and safe on a database where the roles already
-- exist (e.g. a developer who created them by hand from the runbook).
-- ============================================================================

DO $$
DECLARE
  app_schemas CONSTANT text[] := ARRAY[
    'identity', 'workspace', 'access', 'work', 'messaging',
    'notifications', 'audit', 'storage', 'scm'
  ];
  s text;
BEGIN
  -- ── Roles ─────────────────────────────────────────────────────────────────
  -- NOLOGIN until the cutover grants LOGIN with a password from Secrets Manager.

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_app') THEN
    CREATE ROLE rally_app NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_worker') THEN
    CREATE ROLE rally_worker NOLOGIN;
  END IF;

  -- The migrator keeps DDL rights. It is the role that should own the schema
  -- once ownership is transferred at cutover; until then the master role still
  -- owns everything and this role is simply unused.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_migrate') THEN
    CREATE ROLE rally_migrate NOLOGIN;
  END IF;

  -- ── Grants ────────────────────────────────────────────────────────────────
  -- DML only for the runtime roles: no CREATE, no DROP, no TRUNCATE, and
  -- crucially no ownership — so a future FORCE ROW LEVEL SECURITY would apply
  -- to them rather than being silently skipped.

  FOREACH s IN ARRAY app_schemas LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = s) THEN
      CONTINUE;
    END IF;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO rally_app, rally_worker, rally_migrate', s);
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO rally_app, rally_worker',
      s
    );
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO rally_app, rally_worker', s);
    EXECUTE format('GRANT ALL ON SCHEMA %I TO rally_migrate', s);
    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO rally_migrate', s);
    EXECUTE format('GRANT ALL ON ALL SEQUENCES IN SCHEMA %I TO rally_migrate', s);

    -- Tables created LATER must be reachable too, or the first migration after this
    -- one silently leaves the app unable to read its own new table.
    --
    -- Default privileges are per GRANTOR, and the grantor here is the role running
    -- this migration — the RDS master user, which still owns every object until
    -- cutover. So these two cover everything the migrator creates today.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rally_app, rally_worker', s
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I '
      'GRANT USAGE, SELECT ON SEQUENCES TO rally_app, rally_worker', s
    );

    -- The equivalent `... FOR ROLE rally_migrate ...` pair belongs to the CUTOVER
    -- migration, not here, and was removed because it made this one fail with
    -- "permission denied to change default privileges", aborting the whole
    -- migration and breaking the develop deploy.
    --
    -- Postgres only lets you set another role's default privileges if you hold
    -- ADMIN OPTION on it. Whether the master user does depends on who created
    -- rally_migrate — the creator gets it implicitly — so the statement's success
    -- varied by environment. Granting membership first is possible but equally
    -- conditional, and buys nothing yet: rally_migrate is NOLOGIN and creates no
    -- objects until cutover, so it has no default privileges to apply.
    --
    -- Set them in the migration that transfers ownership to rally_migrate. That one
    -- necessarily runs as, or as a member of, rally_migrate, so it can do it without
    -- any membership gymnastics.
  END LOOP;

  -- Drizzle's own bookkeeping table lives in `drizzle`; only the migrator needs it.
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle') THEN
    EXECUTE 'GRANT ALL ON SCHEMA drizzle TO rally_migrate';
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA drizzle TO rally_migrate';
  END IF;
END $$;
