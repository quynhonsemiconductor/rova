-- Migration: 0018_users_membership_rls
-- Updates the RLS policy on identity.users to allow cross-tenant visibility via
-- tenancy.tenant_members ("keycards"). This is the database enforcement of the
-- real-Rally global-identity model.
--
-- Before: a user row was only visible in the tenant that OWNS them (users.tenant_id).
--         A member from tenant A was invisible to tenant B even after being invited,
--         causing "ghost member" rows whose profile JOIN silently returned no data.
--
-- After: a user row is visible to ANY tenant for which the user holds an active
--        keycard in tenant_members. This lets tenant B list members with profiles
--        for users whose identity was originally created in tenant A.
--
-- The original tenant_id clause is preserved during the transition period (Phases
-- 2–3) so any code path that has not yet written a tenant_members row still works.
-- It will be removed when users.tenant_id is dropped in Phase 4.

ALTER POLICY tenant_isolation ON identity.users
  USING (
    tenant_id = current_setting('app.tenant_id')::uuid
    OR EXISTS (
      SELECT 1
      FROM tenancy.tenant_members tm
      WHERE tm.user_id = users.id
        AND tm.tenant_id = current_setting('app.tenant_id')::uuid
        AND tm.status = 'active'
    )
  );
