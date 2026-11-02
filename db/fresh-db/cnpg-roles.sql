-- The FRESH half of the fresh-DB rebuild gate, provisioned the way the platform
-- provisions it on-prem: CNPG creates the roles and the database owner BEFORE any
-- migration runs, and the migrator holds no CREATEROLE. Run as a superuser (CI's
-- `postgres`), once per cluster.
--
--   rova_fresh — "rebuild from zero": roles exist, no objects, migrator cannot
--                create roles. Every migration must apply as rova_migrator.
--
-- The legacy half runs on its OWN cluster (roles are cluster-wide, so a `rally_*`
-- fixture must not share one with these `rova_*` roles): the workflow creates
-- `rova_legacy` there itself, owned by the superuser, and leaves the roles to
-- `legacy-0068.sql`.
--
-- Passwords are test-only literals, same convention as the CI `postgres`
-- superuser the other jobs already connect with.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rova_migrator') THEN
    CREATE ROLE rova_migrator LOGIN PASSWORD 'rova_migrator' NOCREATEROLE NOCREATEDB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rova_app') THEN
    CREATE ROLE rova_app LOGIN PASSWORD 'rova_app';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rova_worker') THEN
    CREATE ROLE rova_worker LOGIN PASSWORD 'rova_worker';
  END IF;
END $$;

SELECT 'CREATE DATABASE rova_fresh OWNER rova_migrator'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'rova_fresh')
\gexec
