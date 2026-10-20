-- ============================================================================
-- Migration 0005: PostgreSQL Row-Level Security — tenant isolation
-- ============================================================================
-- Purpose:
--   Add DB-level tenant isolation as a defence-in-depth layer.
--   The application already filters every query by tenant_id; RLS makes
--   cross-tenant leaks physically impossible even if a query is written
--   without an explicit WHERE tenant_id = :id filter (bug, raw SQL, etc.).
--
-- Strategy:
--   All tenant-scoped tables get ENABLE ROW LEVEL SECURITY + a permissive
--   policy that reads the current tenant from the GUC "app.tenant_id".
--   Application code sets this via:
--     SELECT set_config('app.tenant_id', '<uuid>', true)  -- LOCAL = per-tx
--   The TenantRlsService (libs/platform/src/database/tenant-rls.service.ts)
--   wraps any transaction that needs enforcement.
--
-- BYPASSRLS note:
--   Postgres superusers always bypass RLS automatically.
--   If DATABASE_URL connects as a superuser (common in dev/Docker), policies
--   exist but are NOT enforced until you switch to a non-superuser role.
--   Before tenant #2 goes live:
--     1. Create / use a non-superuser role for DATABASE_URL (e.g. rally_app)
--     2. Grant that role table privileges (SELECT/INSERT/UPDATE/DELETE on all
--        tables in all schemas below)
--     3. Remove BYPASSRLS from that role
--     4. Policies will then enforce automatically on every query
-- ============================================================================

-- ── Helper function ──────────────────────────────────────────────────────────
-- Convenience wrapper so app code can call set_tenant_context(:tenantId)
-- instead of the verbose set_config(). Always LOCAL (transaction-scoped).
CREATE OR REPLACE FUNCTION set_tenant_context(p_tenant_id uuid)
RETURNS void LANGUAGE sql AS $$
  SELECT set_config('app.tenant_id', p_tenant_id::text, true);
$$;

-- ── identity schema ──────────────────────────────────────────────────────────

ALTER TABLE identity.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.users
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE identity.auth_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON identity.auth_sessions
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

-- password_reset_tokens: no tenant_id column — accessed by opaque token hash
-- only; no RLS required (the token hash itself is the access control).

-- ── tenancy schema ───────────────────────────────────────────────────────────
-- tenancy.tenants: id IS the tenant_id (self-referential root entity)

ALTER TABLE tenancy.tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.tenants
  AS PERMISSIVE FOR ALL
  USING  (id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE tenancy.workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.workspaces
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE tenancy.workspace_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.workspace_members
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE tenancy.workspace_invitations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.workspace_invitations
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE tenancy.workspace_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.workspace_settings
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE tenancy.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenancy.subscriptions
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

-- ── work schema ──────────────────────────────────────────────────────────────

ALTER TABLE work.projects ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.projects
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.project_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.project_counters
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.work_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.work_items
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.workflow_statuses ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.workflow_statuses
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.workflow_transitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.workflow_transitions
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.sprints ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.sprints
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.sprint_daily_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.sprint_daily_snapshots
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.releases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.releases
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.comments
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.attachments
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.labels ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.labels
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.work_item_labels ENABLE ROW LEVEL SECURITY;
-- work_item_labels is a junction table with no tenant_id;
-- isolation is enforced through the parent work_items RLS policy (FK).
CREATE POLICY tenant_isolation ON work.work_item_labels
  AS PERMISSIVE FOR ALL
  USING (EXISTS (
    SELECT 1 FROM work.work_items wi
    WHERE wi.id = work_item_labels.work_item_id
      AND wi.tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid
  ));

ALTER TABLE work.teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.teams
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.team_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.team_members
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.project_teams ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.project_teams
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE work.project_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work.project_members
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

-- ── access schema ────────────────────────────────────────────────────────────
-- system_roles: tenant_id IS NULL = global built-in role (readable by everyone)

ALTER TABLE access.system_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.system_roles
  AS PERMISSIVE FOR ALL
  USING  (tenant_id IS NULL
       OR tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id IS NULL
           OR tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

ALTER TABLE access.user_role_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.user_role_assignments
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

-- ── audit schema ─────────────────────────────────────────────────────────────

ALTER TABLE audit.audit_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit.audit_logs
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

-- ── notifications schema ─────────────────────────────────────────────────────

ALTER TABLE notifications.in_app_notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications.in_app_notifications
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

-- ── messaging schema ─────────────────────────────────────────────────────────

ALTER TABLE messaging.outbox_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messaging.outbox_events
  AS PERMISSIVE FOR ALL
  USING  (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);
