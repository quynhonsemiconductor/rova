-- ============================================================================
-- Migration 0073: per-role statement and idle-in-transaction timeouts
-- ============================================================================
-- Nothing bounded how long a query could run. `drizzle.provider.ts` sets a
-- `connectionTimeoutMillis` (how long to WAIT for a pool slot) but no
-- `statement_timeout`, so a single pathological query held its pool connection
-- indefinitely. With the pool now sized to the instance (see local.api_pool_max
-- in infra/modules/stack/main.tf), a handful of stuck queries is enough to
-- exhaust a service's whole allowance, and the symptom is not "slow query" —
-- it is every OTHER request queueing for five seconds and then erroring, with
-- nothing pointing at the query responsible.
--
-- Set on the ROLE rather than in the parameter group on purpose. A cluster-wide
-- `statement_timeout` would also apply to `rally_migrate`, and DDL on a large
-- table legitimately runs for minutes — a migration killed halfway is a far worse
-- failure than a slow request. Per-role settings are applied by Postgres at
-- connection time, so the migrator keeps no limit while the two application
-- roles get one.
--
-- Depends on 0068 (which creates the roles) and takes effect only where the
-- least-privilege cutover has happened — both environments, as of the api/worker
-- master-credential removals. Where a service still connects as the RDS master
-- these settings are inert rather than wrong: the master is not one of the roles
-- named here.
--
-- Existing connections keep the old (absent) setting until they are recycled, so
-- this takes full effect on the next deploy.
--
-- Idempotent: ALTER ROLE … SET overwrites, and the guard tolerates a database
-- where the roles do not exist yet.
-- ============================================================================

DO $$
BEGIN
  -- Request path. 30s is a ceiling, not a target: every real query here is
  -- single-digit milliseconds (measured: 2ms writes, 1ms reads on t4g.micro), so
  -- anything approaching this is a bug, and the value is chosen to be far outside
  -- normal variance rather than to trim the tail.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_app') THEN
    ALTER ROLE rally_app SET statement_timeout = '30s';
    -- A transaction left open holds its row locks and pins the connection, and it
    -- also blocks VACUUM from reclaiming anything newer than it. 60s is generous
    -- for a request-scoped transaction and still bounds a leaked one.
    ALTER ROLE rally_app SET idle_in_transaction_session_timeout = '60s';
  END IF;

  -- Background path gets a longer ceiling. The daily cleanup sweeps up to 5000
  -- rows and the snapshot cron aggregates across a workspace, both legitimately
  -- slower than any request.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rally_worker') THEN
    ALTER ROLE rally_worker SET statement_timeout = '300s';
    -- Deliberately looser than rally_app, because AbstractOutboxRelay's claim
    -- transaction is IDLE by design: it holds the batch's row locks on one
    -- connection while processRow does its work on another. A batch of 50 rows
    -- sits idle-in-transaction for as long as that work takes, so a tight limit
    -- here would kill healthy relay ticks.
    ALTER ROLE rally_worker SET idle_in_transaction_session_timeout = '300s';
  END IF;

  -- rally_migrate is deliberately absent. DDL must not be interruptible.
END $$;
