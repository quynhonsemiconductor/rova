-- ============================================================================
-- Drop the last two `tenant_isolation` RLS policies.
--
-- WHY: they contradict a settled architecture decision, and they are actively
-- breaking storage.
--
-- `docs/superpowers/specs/2026-07-09-drop-multi-tenant-merge-into-workspace-design.md`
-- records the business decision — "Rally is single-tenant only. No SaaS
-- multi-tenancy" — and states the consequence explicitly: "with no multi-tenant
-- isolation requirement, the entire RLS apparatus is deleted rather than fixed",
-- with "No RLS / DB-level isolation. Workspace scoping is enforced in the app
-- layer" listed as a non-goal. Migration 0025 carried that out, dropping every
-- `tenant_isolation` policy in a dynamic loop.
--
-- 0053 then re-added RLS to these two tables, reasoning that it "mirrors the
-- policy every other workspace-scoped table carries (0005)". That was already
-- untrue when written: 0025 had removed it everywhere. So the policies came back
-- on two tables and nowhere else.
--
-- The result was 2 of 41 workspace-scoped tables covered. A backstop over 5% of
-- the surface is not defence in depth — if a query ever forgot its workspace
-- predicate, the other 39 tables would leak anyway.
--
-- They were harmless only while the application connected as the table OWNER,
-- because Postgres exempts the owner from row-level security. `db_least_privilege`
-- moved api and worker onto `rally_app` / `rally_worker`, which are not owners, so
-- the policies executed for the first time. Nothing in the application sets
-- `app.workspace_id` — both `file.repository.ts` and `attachment.repository.ts`
-- say so in their docblocks — so the check compared against NULL and denied
-- everything. Every avatar, workspace-logo and work-item-attachment write failed:
--
--   POST /v1/auth/me/avatar/presign
--   new row violates row-level security policy for table "files"
--
-- Dropping them completes 0025's teardown and unblocks least privilege, which is
-- the control that actually matters here: it protects all 52 tables from an
-- injection or a bad migration path, rather than 2 from a threat this product
-- decided it does not have.
--
-- Workspace isolation is unchanged. It is enforced in the repository layer, by
-- construction: every method takes a workspaceId, there is deliberately no
-- `findById(id)` overload without one, and `test/workspace-scope.ratchet.spec.ts`
-- holds that line.
--
-- Written as a dynamic loop rather than two explicit statements so it is
-- idempotent and cannot miss a table that a later migration re-enables — the exact
-- failure mode 0053 introduced.
-- ============================================================================

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename FROM pg_policies WHERE policyname = 'tenant_isolation'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', r.schemaname, r.tablename);
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
    RAISE NOTICE 'dropped tenant_isolation on %.%', r.schemaname, r.tablename;
  END LOOP;
END $$;
--> statement-breakpoint

-- Belt and braces: a table can have RLS ENABLED with no policy at all, which for a
-- non-owner denies everything and is even harder to diagnose than a failing policy.
-- 0053 enabled RLS and created the policy in separate statements, so guard against
-- the half-applied shape too.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename FROM pg_tables
    WHERE rowsecurity = TRUE AND schemaname NOT IN ('pg_catalog', 'information_schema')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
    RAISE NOTICE 'disabled leftover RLS on %.%', r.schemaname, r.tablename;
  END LOOP;
END $$;
