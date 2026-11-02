-- ============================================================================
-- Migration 0068: least-privilege database roles — grants only
-- ============================================================================
-- History: the API, the worker AND the migrator used to connect with the RDS
-- master credential, which owns every object in the database — so an ordinary
-- request ran with rights to DROP the schema it was reading, and any row-level
-- policy would silently exempt the owner. This migration created `rally_app`,
-- `rally_worker` and `rally_migrate` and granted DML to the first two. Cutover
-- (LOGIN + passwords from Secrets Manager) stayed a separate, reviewed step;
-- see docs/runbooks/db-role-least-privilege.md. 0128 later renamed the roles to
-- `rova_*`.
--
-- 2026-10-30 — on-prem rebuild-from-zero gate. CNPG now creates the roles
-- (`rova_app`, `rova_worker`, `rova_migrator`; passwords from Key Vault) and
-- `rova_migrator` deliberately has NO CREATEROLE. A migration that runs
-- `CREATE ROLE` therefore aborts the very first migration on a fresh on-prem
-- database, and — even where it succeeded — it granted the legacy `rally_*`
-- roles, which on-prem do not exist. The roles are the platform's job; what is
-- left here is the grant half, and it targets the roles the platform creates.
--
-- Role CREATION survives only as a GUARDED convenience for databases with no
-- CNPG in front of them (CI, a developer's own Postgres), which run migrations
-- as a SUPERUSER and expect `db:roles:enable` to find the role afterwards. It
-- is skipped whenever the connecting role lacks CREATEROLE, which is exactly
-- the on-prem case, and it never touches `rally_*`.
--
-- Idempotent: safe to re-run, and safe on a database where the roles already
-- exist.
--
-- EDITED IN PLACE on 2026-10-30, deliberately. Drizzle compares only the
-- journal's `when` against `__drizzle_migrations` (`drizzle-orm` 0.45.4,
-- pg-core/dialect.js:57-68) and never the recorded hash, so this file does not
-- re-run where it already has; the only trace is migrate.ts's hash-mismatch
-- warning, which it documents as "the file was edited after it ran (harmless)".
-- An environment that ran the old 0068 keeps its grants (0128 renamed them in
-- place) and a fresh one gets the rova_* grants here; 0137 re-states the full
-- set, so both converge on the same end state rather than on this entry.
-- ============================================================================

DO $$
DECLARE
  app_schemas CONSTANT text[] := ARRAY[
    'identity', 'workspace', 'access', 'work', 'messaging',
    'notifications', 'audit', 'storage', 'scm'
  ];
  runtime_roles CONSTANT text[] := ARRAY['rova_app', 'rova_worker'];
  present_roles text[] := ARRAY[]::text[];
  may_create_role boolean := (
    SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user
  );
  s text;
  r text;
BEGIN
  -- ── Roles: platform-owned, creation only as a guarded convenience ─────────
  FOREACH r IN ARRAY runtime_roles LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) AND may_create_role THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN', r);
    END IF;

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      present_roles := present_roles || r;
    END IF;
  END LOOP;

  -- A database with neither role is one the platform has not provisioned. Fail
  -- with the reason rather than applying nothing and leaving the app unable to
  -- read its own tables.
  IF cardinality(present_roles) = 0 THEN
    RAISE EXCEPTION
      'Migration 0068 found none of the runtime roles % and the connecting role % cannot create them. '
      'They are provisioned by the platform (CNPG managed roles on-prem, docs/runbooks/db-role-least-privilege.md on AWS).',
      runtime_roles, current_user;
  END IF;

  -- ── Grants ────────────────────────────────────────────────────────────────
  -- DML only for the runtime roles: no CREATE, no DROP, no TRUNCATE, and
  -- crucially no ownership — so a future FORCE ROW LEVEL SECURITY would apply
  -- to them rather than being silently skipped.

  FOREACH s IN ARRAY app_schemas LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = s) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'GRANT USAGE ON SCHEMA %I TO %s',
      s, array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ')
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %s',
      s, array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ')
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %s',
      s, array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ')
    );

    -- Tables created LATER must be reachable too, or the first migration after
    -- this one silently leaves the app unable to read its own new table.
    --
    -- Default privileges are per GRANTOR: the role running the migration. On a
    -- fresh on-prem database that role IS rova_migrator (the owner of every
    -- object it creates), so `FOR ROLE` is unnecessary — and hardcoding a role
    -- name here would fail on a database where the platform named it
    -- differently, or where the migrator is still the RDS master.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %s',
      s, array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ')
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %s',
      s, array_to_string(ARRAY(SELECT quote_ident(u) FROM unnest(present_roles) AS u), ', ')
    );
  END LOOP;
END $$;
