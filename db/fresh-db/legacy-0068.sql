-- FROZEN HISTORY, not code to keep in sync: 0068 as it ran on AWS, and the
-- runbook's cutover step that gave the roles LOGIN. The legacy-database half of
-- the fresh-DB rebuild gate applies this after 0000..0067 so the rest of the
-- journal meets a database that still has `rally_*` roles — the state every
-- pre-0128 database was in.
--
-- Deliberately not fetched from git: this is the fixture that represents the
-- past, and a fixture that silently follows the file it simulates proves
-- nothing. Run as a superuser (the RDS master, which held CREATEROLE).

DO $$
DECLARE
  app_schemas CONSTANT text[] := ARRAY[
    'identity', 'workspace', 'access', 'work', 'messaging',
    'notifications', 'audit', 'storage', 'scm'
  ];
  s text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_app') THEN
    CREATE ROLE rally_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_worker') THEN
    CREATE ROLE rally_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_migrate') THEN
    CREATE ROLE rally_migrate NOLOGIN;
  END IF;

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
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I '
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rally_app, rally_worker', s
    );
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO rally_app, rally_worker', s
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'drizzle') THEN
    EXECUTE 'GRANT ALL ON SCHEMA drizzle TO rally_migrate';
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA drizzle TO rally_migrate';
  END IF;
END $$;

-- docs/runbooks/db-role-least-privilege.md step 2 (enable-least-privilege-roles),
-- which the AWS environments ran as a one-off migrator task.
ALTER ROLE rally_app LOGIN PASSWORD 'rova_app';
ALTER ROLE rally_worker LOGIN PASSWORD 'rova_worker';
