# Drop Multi-Tenancy — Merge `tenant` into `workspace`

**Date:** 2026-07-09
**Status:** Design — pending review
**Author:** brainstormed with Claude Code

## 1. Context & Goal

Rova was built as a multi-tenant SaaS: `tenant` is the top-level isolation
boundary, denormalized as a `tenant_id` column on nearly every table, backstopped
(on paper) by Postgres RLS. A `DEPLOYMENT_MODE=single` flag lets it run the full
multi-tenant model with N=1.

Business decision: **Rova is single-tenant only. No SaaS multi-tenancy.**
We physically remove the `tenant` concept. Users still want **multiple
workspaces**, each holding multiple projects, with team members belonging to one
or many workspaces.

**Insight that shapes this design:** the current hierarchy is
`tenant → workspace → project → work items`. `workspace` already exists as a real
intermediate layer with its own membership table. Removing `tenant` is therefore a
**merge of `tenant` into `workspace`** — `workspace` becomes the switchable root —
not a flatten. This preserves every existing query pattern and index (they just
change the scope column name), which is the lowest-risk path.

This also resolves the audit's top finding (RLS backstop is inert because the app
connects as the table-owning `rallyadmin`): with no multi-tenant isolation
requirement, the entire RLS apparatus is deleted rather than fixed.

### Preconditions
- **Greenfield.** No production data to preserve; dev/develop data is throwaway.
  Migration can drop columns/tables in place and reset dev DBs — no backfill.

## 2. Decision

Adopt **Approach A — merge `tenant` → `workspace`**:
- Rename the scope column `tenant_id` → `workspace_id` on all scoped tables; the
  value becomes the row's owning workspace.
- `workspace` is the new root. Users belong to workspaces via `workspace_members`
  (many-to-many, already exists). Active workspace replaces active tenant.
- Delete the tenant tables, the RLS layer, and the `DEPLOYMENT_MODE` apparatus.

### Non-goals
- No RLS / DB-level isolation. Workspace scoping is enforced in the app layer
  (as tenant scoping is today).
- No billing/subscriptions (dropped with tenants).
- No self-serve tenant signup. Workspaces are created by authenticated users.
- Not flattening away `workspace` (Approach B/C rejected — perf + loses the
  membership boundary the product needs).

## 3. Target Data Model

**Before:** `tenant (root) → workspace(s) → project(s) → work items`
Membership: `tenant_members` (user↔tenant) + `workspace_members` (user↔workspace).
Active context: `tenantId` (JWT claim), switchable via `switchTenant`.

**After:** `workspace (root) → project(s) → work items`
Membership: `workspace_members` only (user↔workspace, many-to-many).
Active context: `workspaceId` (JWT claim), switchable via `switchWorkspace`.
Users remain global (unchanged since migration 0019 dropped `users.tenant_id`).

## 4. Schema Changes

Scope-column footprint today (`tenant_id`/`tenantId` refs per schema file):
`work.ts` 42, `tenancy.ts` 16, `identity.ts` 7, `access.ts` 4, `messaging.ts` 4,
`notifications.ts` 4, `audit.ts` 3.

### 4.1 Rename scope column `tenant_id` → `workspace_id`
On every scoped table that is **below the workspace level**:
- `work.*` — `projects` (already has both `tenant_id` and `workspace_id`; **drop
  `tenant_id`, keep `workspace_id`**), `work_items`, `project_counters`,
  `workflow_statuses`, `workflow_transitions`, `sprints`, `sprint_daily_snapshots`,
  `releases`, `comments`, `attachments`, `labels`, `teams`, `team_members`,
  `project_teams`, `project_members`. Rename `tenant_id` → `workspace_id`.
- `audit.audit_logs` — rename → `workspace_id`.
- `notifications.in_app_notifications` — rename → `workspace_id`.
- `messaging.outbox_events` — rename → `workspace_id`.
- Rebuild composite indexes with the renamed column (e.g. `ix_wi_board`,
  `ix_wi_backlog`, `ix_wi_assignee`) — same columns, `workspace_id` first.

> `work_items` etc. currently store the tenant as their top scope; the owning
> workspace equals their project's `workspace_id`. After the rename the app stamps
> `workspace_id` from the active-workspace context (exactly as it stamped
> `tenant_id`), and `work_item.workspace_id == project.workspace_id`.

### 4.2 Merge tenant fields into `workspaces`
`tenants` had: `slug, name, status, plan, settings`. `workspaces` has:
`slug, name, description, avatarUrl, settings`. Actions:
- Drop `workspaces.tenant_id` (workspace is now root).
- `slug` uniqueness changes from per-tenant (`uq_workspaces_tenant_slug`) to
  **global** (`uq_workspaces_slug`, where `deleted_at IS NULL`).
- Keep `status` on workspace? **Decision:** add `workspaces.status`
  (`active|archived`) — cheap, useful for lifecycle. Drop `plan` (no billing).

### 4.3 `workspace_members` becomes the sole membership
- Drop `workspace_members.tenant_id`.
- Add `last_active_at timestamptz` (migrated from `tenant_members.lastActiveAt`) to
  drive "drop into your last-active workspace" at login.
- `uq_workspace_member` (`workspace_id, user_id`) unchanged.
- Related member tables lose `tenant_id`: `workspace_invitations`,
  `workspace_settings` → keyed by `workspace_id` only.

### 4.4 Tables dropped entirely
- `tenancy.tenants`
- `tenancy.tenant_members` (replaced by `workspace_members`)
- `tenancy.tenant_domains` (SSO domain→tenant map; SSO becomes install-global)
- `tenancy.subscriptions` (no billing)
- Enums no longer referenced: `tenant_status`, `subscription_plan` — drop.

### 4.5 Access schema
`scope_type` enum is already `['global','workspace','project']` — no change needed.
- `access.system_roles.tenant_id` → `workspace_id` (NULL = global system role).
- `access.user_role_assignments.tenant_id` → `workspace_id`; role scope is
  `(workspace_id, scope_type, scope_id)` where `scope_id` is a project for
  project-scoped roles.

### 4.6 Identity schema
`identity.ts` has 7 `tenant_id` refs. `users.tenant_id` is already gone (0019).
Remaining refs are `auth_sessions.tenant_id` and SSO connection tables.
- `auth_sessions.tenant_id` → `workspace_id` **nullable** — a session's active
  workspace, set after the user selects/defaults one. Login itself is
  workspace-agnostic.
- SSO connection tables: drop the tenant linkage; SSO connection is **install-global**
  (one identity provider for the whole install). Confirm exact tables in the plan.

### 4.7 RLS teardown
- New migration drops every `tenant_isolation` policy and the `set_tenant_context`
  function created in `0005`, and runs `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`
  on all previously-enabled tables.
- Delete `libs/platform/src/database/tenant-rls.service.ts` and its DI registration.

## 5. Auth / JWT / Session Changes

**File:** `libs/modules/identity/src/application/auth.service.ts` (+ controller).

- **JWT claim:** `tenantId` → `workspaceId` (the active workspace; nullable until a
  workspace is selected). Update `jwt.strategy.ts`, guards, and every `actor.tenantId`
  read across the backend to `actor.workspaceId`.
- **Login flow:** authenticate the global user by email (unchanged), then resolve
  their workspaces via `workspace_members`. Drop into `last_active_at` workspace if
  present, else first active membership, else no active workspace (empty state →
  create/join a workspace). Removes the "resolve to the one configured tenant"
  single-tenant fallback (`auth.service.ts:264,799`).
- **`switchTenant` → `switchWorkspace`:** re-mint the access token with the new
  `workspaceId`, update `last_active_at`. Same rotation/denylist semantics.
- **SSO:** install-global connection; remove domain→tenant resolution
  (`tenant_domains`) and the single-tenant SSO fallback. Existing-identity path
  should still re-validate connection status (see related audit finding — fix in
  the same pass since we're already here).

## 6. Config & Infra Removal

Delete the `DEPLOYMENT_MODE` apparatus entirely:
- `env.schema.ts`: remove `DEPLOYMENT_MODE`, `SINGLE_TENANT_NAME`,
  `SINGLE_TENANT_SLUG`.
- `app-config.service.ts`: remove `isSingleTenant()`.
- Terraform `infra/live/{develop,prod}/main.tf`: remove `deployment_mode`,
  `single_tenant_name`, `single_tenant_slug` locals + the `DEPLOYMENT_MODE` env var
  injected into the task defs; remove matching `variables.tf` entries and tfvars.
- Health `/config` endpoint (`health.controller.ts`): drop `deploymentMode`; replace
  `signupEnabled: !singleTenant` with a workspace-appropriate flag (or remove).
- FE `app-config.ts`: drop `deploymentMode`; workspace-switcher is always on.

## 7. Backend App-Layer Changes

- **Rename sweep:** `tenantId` → `workspaceId` across ~131 backend files. Mostly
  mechanical (repos stamp/filter by `workspaceId`, services thread `actor.workspaceId`).
- **Repositories (34 files):** swap `tenant_id` filters for `workspace_id`. No
  `withTenantContext` wrapping (RLS is gone) — keep direct `this.db` access.
- **Tenancy module** (`libs/modules/tenancy`, 28 files): becomes the **workspace
  module**. Delete tenant CRUD + `ensureSingleTenant`; keep/adapt workspace CRUD,
  membership, invitations, settings.
- **Bootstrap:** replace `ensureSingleTenant()` with `ensureDefaultWorkspace()` — on
  first boot, if zero workspaces exist, create a default one so the install isn't
  empty. Idempotent.
- **Fix the dead sole-admin guard** (audit finding, `tenancy.service.ts:397`) while
  rewriting membership: base the last-admin check on `user_role_assignments` +
  `system_roles.slug='admin'` at workspace scope, not the never-matching
  `roleId === 'admin'`.
- **Reachable authz gaps** surfaced by the audit that live in touched files — fix in
  the same pass: reporting/audit-log missing permission decorators; SSE keyed by user
  only (now filter by active workspace).

## 8. Frontend Changes

**Files:** `auth.store.ts`, `login-page.tsx`, `app-shell.tsx`, `auth-bootstrap.ts`,
`app-config.ts`, generated API types.
- `memberships`/`activeTenantId`/`switchTenant` → `workspaces`/`activeWorkspaceId`/
  `switchWorkspace`.
- Header "organization" selector → **workspace switcher** (always visible; lists the
  user's workspaces; the current per-project/team context nests under it).
- Remove `deploymentMode`-driven hiding of the switcher/signup.
- Regenerate `shared/api/generated/api.ts` from the updated OpenAPI once the backend
  contract changes.
- (Not in scope but noted: the header "Plan/Track" dropdown UX fix already landed.)

## 9. Migration Strategy (greenfield)

Single new forward migration `00NN_drop_tenancy_merge_workspace.sql` that:
1. Drops all `tenant_isolation` RLS policies + `set_tenant_context()`, disables RLS.
2. Renames `tenant_id` → `workspace_id` on all scoped tables (§4.1, §4.5, §4.6);
   rebuilds affected indexes.
3. Alters `workspaces` (drop `tenant_id`, global slug unique, add `status`),
   `workspace_members` (drop `tenant_id`, add `last_active_at`), and the other
   member tables.
4. Drops `tenants`, `tenant_members`, `tenant_domains`, `subscriptions` + orphaned
   enums.

Because it's greenfield, dev/develop DBs are **reset** (drop + re-migrate + re-seed).
No down-migration needed for prod (prod not live). Seed script rewritten to create a
default workspace + users as workspace members (no tenant).

## 10. Testing

- **Workspace isolation tests:** user in workspace A cannot read/write workspace B's
  projects/work items via the API (app-layer scoping is now the only boundary — test
  it hard, per-endpoint).
- **Membership:** user in multiple workspaces sees only their workspaces; switch
  re-scopes all data; `last_active_at` drives default on next login.
- **Auth:** login with no `workspaceId` claim works; `switchWorkspace` re-mints token;
  SSO login resolves to a workspace.
- **Bootstrap:** fresh DB yields exactly one default workspace; idempotent on restart.
- **Regression:** existing module test suites pass after the rename (update fixtures
  from `tenantId` → `workspaceId`).
- Typecheck + lint clean across the rename.

## 11. Risks & Rollout

- **Largest risk:** the rename touches the auth-critical path (JWT claim, session,
  guards). Mitigate: do schema + backend rename + auth together on a branch, run full
  test suite, verify login/switch end-to-end before merge.
- **App-layer is the only isolation now.** Every list/read/write must filter by
  `workspaceId`. The isolation test suite (§10) is the guard against a missed filter.
- **OpenAPI/type drift:** regenerate FE types after backend contract changes; FE won't
  compile against stale `tenantId` types — a useful forcing function.
- **Rollout:** verify on `develop` (reset DB) first; prod has no data so cutover is a
  deploy, not a data migration.

## 12. Decisions (resolved 2026-07-09)

1. **Workspace `status`/lifecycle** — **KEEP** archive support. `workspaces.status`
   (`active|archived`) added in §4.2.
2. **SSO scope** — **install-global** (one identity provider for the whole install).
   `tenant_domains` dropped; no per-workspace SSO.
3. **Signup story** — first user provisioned via seed/break-glass (single admin).
   Any **authenticated user can create a workspace** and becomes its admin; not
   admin-gated. No self-serve public signup.
4. **Roles** — **keep `global` scope** (used by break-glass/platform admin); normal
   assignments use `workspace` + `project` scope. Enum unchanged.
