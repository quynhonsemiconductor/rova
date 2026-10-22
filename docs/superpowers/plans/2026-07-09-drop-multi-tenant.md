# Drop Multi-Tenancy — Merge `tenant` into `workspace` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Physically remove the `tenant` concept from rova, making `workspace` the switchable root, with users belonging to one or many workspaces.

**Architecture:** Merge `tenant` into `workspace` (Approach A). Rename the scope column `tenant_id`→`workspace_id` on all scoped tables; delete tenant tables, the RLS layer, and the `DEPLOYMENT_MODE` apparatus. Greenfield — dev DBs are reset, no data backfill. App-layer `workspace_id` filtering is the only isolation boundary.

**Tech Stack:** NestJS 11 (Fastify), Drizzle ORM + drizzle-kit (Postgres 17), React + TanStack Router/Query, Vitest, Terraform.

**Spec:** `docs/superpowers/specs/2026-07-09-drop-multi-tenant-merge-into-workspace-design.md`

---

## Ground Rules

- **Migration source of truth is the Drizzle schema** (`db/schema/*.ts`). Structural DDL is produced with `pnpm db:generate`. RLS teardown is hand-written (Drizzle does not model RLS).
- **Order matters:** RLS policies reference `tenant_id`; drop them BEFORE renaming/dropping columns.
- **The rename sweep will not typecheck until schema + all references change together.** Phases 1→4 land as one coherent backend branch; do not expect green typecheck mid-phase. The gate is at the END of Phase 4.
- **Verification commands** (run from repo root `rova/`):
  - Typecheck: `pnpm -w exec tsc --noEmit` (or `pnpm typecheck` in `apps/web` for FE)
  - Tests: `pnpm test` (Vitest)
  - Migrate a fresh DB: `pnpm db:migrate` ; seed: `pnpm db:seed`
- **Commit** after each task. No `Co-Authored-By` trailer (workspace rule).

---

## File Structure (what changes and why)

**Schema (source of truth):**
- `db/schema/tenancy.ts` — drop `tenants`, `tenant_members`, `tenant_domains`, `subscriptions`; rework `workspaces`/`workspace_members`/`workspace_invitations`/`workspace_settings` to drop `tenant_id`.
- `db/schema/work.ts`, `access.ts`, `audit.ts`, `notifications.ts`, `messaging.ts`, `identity.ts` — rename `tenant_id`→`workspace_id`; rebuild indexes.
- `db/schema/enums.ts` — drop `tenant_status`, `subscription_plan`.

**Migrations:**
- `db/migrations/0025_drop_rls_tenant_isolation.sql` — hand-written RLS teardown (runs first).
- `db/migrations/0026_*` — drizzle-generated structural diff.

**Platform:**
- Delete `libs/platform/src/database/tenant-rls.service.ts`.
- `libs/platform/src/auth/{jwt.strategy,jwt.guard,decorators}.ts` — `tenantId`→`workspaceId`.
- `libs/platform/src/context/*` — `setAuthContext` rename.
- `libs/platform/src/config/{env.schema,app-config.service}.ts` — remove `DEPLOYMENT_MODE`, `SINGLE_TENANT_*`, `isSingleTenant()`.
- `libs/platform/src/observability/health.controller.ts` — drop `deploymentMode`/`signupEnabled`.
- `libs/shared-kernel/src/domain/domain-event.ts` — `tenantId`→`workspaceId`.

**Modules (`libs/modules/*`):** rename sweep across ~131 files; `tenancy` module becomes the workspace module; `auth.service.ts` login/switch/SSO rewrite; fold in reachable audit fixes.

**Frontend (`apps/web/src`):** `auth.store.ts`, `login-page.tsx`, `app-shell.tsx`, `auth-bootstrap.ts`, `app-config.ts`, regenerated `shared/api/generated/api.ts`.

**Infra:** `infra/live/{develop,prod}/{main,variables}.tf`, tfvars.

---

## Phase 0 — Branch & Baseline

### Task 0: Create branch and capture green baseline

**Files:** none (git + verification only)

- [ ] **Step 1: Create a feature branch**

```bash
cd rova
git checkout -b feat/drop-multi-tenant
```

- [ ] **Step 2: Confirm the suite is green BEFORE changes**

Run: `pnpm test`
Expected: all pass (record the count — this is the regression baseline).

- [ ] **Step 3: Confirm a fresh migrate+seed works today**

Run: `pnpm db:migrate && pnpm db:seed`
Expected: exits 0. (Establishes the DB pipeline works pre-change.)

- [ ] **Step 4: Commit the plan+spec**

```bash
git add docs/superpowers
git commit -m "docs: add drop-multi-tenant spec and plan"
```

---

## Phase 1 — Database Schema & Migrations

### Task 1: Hand-write the RLS teardown migration (0025)

**Files:**
- Create: `db/migrations/0025_drop_rls_tenant_isolation.sql`
- Modify: `db/migrations/meta/_journal.json` (add entry idx 25)

- [ ] **Step 1: Write the teardown SQL**

Reverse of `0005`. Drop every `tenant_isolation` policy, disable RLS, drop the helper. Full list of tables from `0005` + `0019`:

```sql
-- 0025: Remove RLS tenant isolation (tenancy is being dropped entirely).
-- Must run BEFORE columns are renamed/dropped, since policies reference tenant_id.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename FROM pg_policies WHERE policyname = 'tenant_isolation'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I.%I', r.schemaname, r.tablename);
    EXECUTE format('ALTER TABLE %I.%I DISABLE ROW LEVEL SECURITY', r.schemaname, r.tablename);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS set_tenant_context(uuid);
```

- [ ] **Step 2: Register the migration in the journal**

Add to `db/migrations/meta/_journal.json` `entries` array (keep ascending `idx`/`when`):

```json
{ "idx": 25, "version": "7", "when": 1783000003000, "tag": "0025_drop_rls_tenant_isolation", "breakpoints": true }
```

- [ ] **Step 3: Verify it applies on a fresh DB**

Run: `pnpm db:migrate`
Expected: exits 0, log shows migration `0025` applied.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0025_drop_rls_tenant_isolation.sql db/migrations/meta/_journal.json
git commit -m "feat(db): drop RLS tenant isolation policies"
```

### Task 2: Edit `tenancy.ts` schema — drop tenant tables, rework workspace

**Files:**
- Modify: `db/schema/tenancy.ts`

- [ ] **Step 1: Delete the dropped tables**

Remove the `tenants`, `tenantMembers`, `tenantDomains`, and `subscriptions` table exports entirely.

- [ ] **Step 2: Rework `workspaces`**

- Remove the `tenantId` column and `tenantIdx`.
- Change the slug unique index to global:

```ts
slugIdx: uniqueIndex('uq_workspaces_slug').on(t.slug).where(sql`deleted_at IS NULL`),
```

- Add a `status` column (reuse a small enum):

```ts
status: workspaceStatusEnum('status').notNull().default('active'),
```

(Add `workspaceStatusEnum = pgEnum('workspace_status', ['active','archived'])` in `enums.ts` — see Task 6.)

- [ ] **Step 3: Rework `workspace_members`**

- Remove `tenantId` and `tenantIdx`.
- Add `lastActiveAt` (migrated concept from `tenant_members`):

```ts
lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
```

- [ ] **Step 4: Rework `workspace_invitations` and `workspace_settings`**

Remove their `tenantId` columns + any `tenant`-named indexes; key by `workspace_id` only.

- [ ] **Step 5: Commit (schema-only; do not generate yet)**

```bash
git add db/schema/tenancy.ts
git commit -m "feat(db): rework tenancy schema — workspace as root, drop tenant tables"
```

### Task 3: Rename `tenant_id`→`workspace_id` in `work.ts`

**Files:**
- Modify: `db/schema/work.ts`

- [ ] **Step 1: Rename the column and its indexes**

For every table in `work.ts` (projects, project_counters, work_items, workflow_statuses, workflow_transitions, sprints, sprint_daily_snapshots, releases, comments, attachments, labels, teams, team_members, project_teams, project_members):
- `tenantId: uuid('tenant_id')` → `workspaceId: uuid('workspace_id')`
- Rename index builders and names: `tenantIdx`/`ix_*_tenant` → `workspaceIdx`/`ix_*_workspace`; composite indexes (`ix_wi_board`, `ix_wi_backlog`, `ix_wi_assignee`, `ix_wi_created`) swap `t.tenantId`→`t.workspaceId` as the leading column, rename to `ix_wi_*` unchanged content.
- **Special case `projects`:** it had BOTH columns. Delete the old `tenantId` field + `tenantIdx` + the `(tenantId, key)` unique index; keep `workspaceId`; make the key unique per workspace: `uniqueIndex('uq_projects_workspace_key').on(t.workspaceId, t.key)`.

- [ ] **Step 2: Verify no `tenant` remains in the file**

Run: `grep -n "tenant" db/schema/work.ts`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add db/schema/work.ts
git commit -m "feat(db): rename tenant_id to workspace_id in work schema"
```

### Task 4: Rename in `access.ts`, `audit.ts`, `notifications.ts`, `messaging.ts`

**Files:**
- Modify: `db/schema/access.ts`, `db/schema/audit.ts`, `db/schema/notifications.ts`, `db/schema/messaging.ts`

- [ ] **Step 1: Rename column + indexes in each**

In each file rename `tenantId`/`tenant_id`→`workspaceId`/`workspace_id` and any `*_tenant` index name→`*_workspace`. In `access.ts`: `system_roles.workspace_id` stays nullable (NULL = global role); `user_role_assignments.workspace_id` notNull; the `(workspace_id, scope_type, scope_id)` unique index keeps its columns (renamed leading col).

- [ ] **Step 2: Verify**

Run: `for f in access audit notifications messaging; do echo "$f:"; grep -c tenant db/schema/$f.ts; done`
Expected: `0` for each.

- [ ] **Step 3: Commit**

```bash
git add db/schema/access.ts db/schema/audit.ts db/schema/notifications.ts db/schema/messaging.ts
git commit -m "feat(db): rename tenant_id to workspace_id in access/audit/notifications/messaging"
```

### Task 5: Rename in `identity.ts` (sessions + SSO)

**Files:**
- Modify: `db/schema/identity.ts`

- [ ] **Step 1: Rename `auth_sessions.tenant_id`→`workspace_id`, make it nullable**

```ts
workspaceId: uuid('workspace_id'), // active workspace; null until user selects one
```

- [ ] **Step 2: Drop tenant linkage from SSO connection tables**

Remove `tenant_id` from the SSO connection/provider tables in `identity.ts`; SSO is install-global. Remove any `*_tenant` index.

- [ ] **Step 3: Verify + commit**

Run: `grep -n tenant db/schema/identity.ts` → expect no matches.

```bash
git add db/schema/identity.ts
git commit -m "feat(db): rename/drop tenant_id in identity schema, install-global SSO"
```

### Task 6: Clean enums + generate the structural migration

**Files:**
- Modify: `db/schema/enums.ts`
- Create: `db/migrations/0026_*` (generated)

- [ ] **Step 1: Add `workspace_status`, drop dead enums**

In `enums.ts`: add `export const workspaceStatusEnum = pgEnum('workspace_status', ['active','archived']);` and its type export. Remove `tenantStatusEnum` + `subscriptionPlanEnum` + their type exports (`TenantStatus`, `SubscriptionPlan`).

- [ ] **Step 2: Generate the migration from the schema diff**

Run: `pnpm db:generate`
Expected: creates `db/migrations/0026_<name>.sql` + updates `meta/`. Inspect the SQL — it should DROP the tenant tables, RENAME COLUMN `tenant_id TO workspace_id` (or drop+add — verify it is a rename, not data-losing drop; since greenfield either is fine), and adjust indexes/enums.

- [ ] **Step 3: Reset the dev DB and run the full pipeline**

```bash
# reset: drop & recreate the dev database, then migrate + seed (seed rewritten in Task 15)
pnpm db:migrate
```

Expected: `0025` then `0026` apply cleanly, exit 0.

- [ ] **Step 4: Commit**

```bash
git add db/schema/enums.ts db/migrations
git commit -m "feat(db): generate structural migration for workspace merge"
```

---

## Phase 2 — Platform Types & Config

### Task 7: Rename the auth/JWT context type `tenantId`→`workspaceId`

**Files:**
- Modify: `libs/platform/src/auth/jwt.strategy.ts:10`, `libs/platform/src/auth/jwt.guard.ts:59,75`, `libs/platform/src/auth/decorators.ts`, `libs/platform/src/context/als.middleware.ts` (+ any `setAuthContext` def)

- [ ] **Step 1: Rename in the JWT payload + strategy**

`jwt.strategy.ts`: `tenantId: string;` → `workspaceId: string | null;` (nullable — no active workspace right after login).

- [ ] **Step 2: Rename in the guard + auth context**

`jwt.guard.ts`: `handleRequest<TUser extends { sub: string; workspaceId: string | null; sessionId: string }>` and `this.ctx.setAuthContext(user.workspaceId, user.sub, user.sessionId)`. Rename the context method param `tenantId`→`workspaceId` in `als.middleware.ts`/context service.

- [ ] **Step 3: Rename the `CurrentUser` actor type**

In `decorators.ts`, rename the actor's `tenantId` field to `workspaceId`.

- [ ] **Step 4: Commit** (typecheck will still fail globally — expected)

```bash
git add libs/platform/src/auth libs/platform/src/context
git commit -m "refactor(platform): rename auth context tenantId to workspaceId"
```

### Task 8: Delete the RLS service

**Files:**
- Delete: `libs/platform/src/database/tenant-rls.service.ts`
- Modify: its DI registration (platform module) + any import sites

- [ ] **Step 1: Remove the file and provider registration**

```bash
git rm libs/platform/src/database/tenant-rls.service.ts
grep -rn "TenantRlsService\|withTenantContext" libs apps --include="*.ts"
```

- [ ] **Step 2: Replace the 3 `withTenantContext` call sites with direct `this.db.transaction`**

In `tenancy.service.ts` and `auth.service.ts`, replace `rls.withTenantContext(tenantId, fn)` with `this.db.transaction(fn)` (RLS is gone; no `set_tenant_context`).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor(platform): remove TenantRlsService and withTenantContext"
```

### Task 9: Remove the `DEPLOYMENT_MODE` apparatus

**Files:**
- Modify: `libs/platform/src/config/env.schema.ts:139-145`, `libs/platform/src/config/app-config.service.ts:18-20`, `libs/platform/src/observability/health.controller.ts:42-46`

- [ ] **Step 1: Remove env vars**

Delete `DEPLOYMENT_MODE`, `SINGLE_TENANT_NAME`, `SINGLE_TENANT_SLUG` from `env.schema.ts` (and their doc comment block).

- [ ] **Step 2: Remove `isSingleTenant()`**

Delete the method from `app-config.service.ts`.

- [ ] **Step 3: Fix the health `/config` endpoint**

In `health.controller.ts`, drop `deploymentMode` and replace `signupEnabled: !singleTenant` with `workspaceCreationOpen: true` (any authed user can create a workspace — spec §12.3). Update the Swagger schema block accordingly.

- [ ] **Step 4: Commit**

```bash
git add libs/platform/src/config libs/platform/src/observability/health.controller.ts
git commit -m "refactor(platform): remove DEPLOYMENT_MODE single-tenant apparatus"
```

### Task 10: Rename `tenantId` in shared-kernel domain events

**Files:**
- Modify: `libs/shared-kernel/src/domain/domain-event.ts:15,28`

- [ ] **Step 1: Rename the field**

`readonly tenantId: string;` → `readonly workspaceId: string;` in both the interface and constructor.

- [ ] **Step 2: Commit**

```bash
git add libs/shared-kernel/src/domain/domain-event.ts
git commit -m "refactor(shared-kernel): rename domain event tenantId to workspaceId"
```

---

## Phase 3 — Backend Rename Sweep (per module)

> Each task renames `tenantId`→`workspaceId` (and `tenant_id` string literals in raw SQL) within one module, then verifies that module's tests. Because cross-module types are still mid-rename, run the module's own test file, not the whole suite, until Phase 4's gate.

### Task 11: Rename sweep — `access`, `audit`, `reporting`, `collaboration`

**Files:** `libs/modules/{access,audit,reporting,collaboration}/**/*.ts`

- [ ] **Step 1: Mechanical rename within these modules**

```bash
cd rova
grep -rl "tenantId\|tenant_id" libs/modules/access libs/modules/audit libs/modules/reporting libs/modules/collaboration --include="*.ts" \
  | xargs sed -i 's/tenantId/workspaceId/g; s/tenant_id/workspace_id/g'
```

- [ ] **Step 2: Fold in reachable audit fixes (same files, so do them now)**

- `reporting.controller.ts`: add `@RequirePermission('report:view')` (or `@AuthProjectScoped` + project assert) to burndown/velocity routes.
- `audit.controller.ts`: add an admin permission decorator to the audit-log query route.
- `collaboration.service.ts` `createComment`: load the work item by `(workItemId, actor.workspaceId)` and throw NotFound before insert; validate `parentId` belongs to the same work item.

- [ ] **Step 3: Verify these modules compile in isolation + tests**

Run: `pnpm test -- libs/modules/access libs/modules/audit libs/modules/reporting libs/modules/collaboration`
Expected: pass (update any fixture using `tenantId`).

- [ ] **Step 4: Commit**

```bash
git add libs/modules/access libs/modules/audit libs/modules/reporting libs/modules/collaboration
git commit -m "refactor(modules): rename tenant to workspace in access/audit/reporting/collaboration + authz fixes"
```

### Task 12: Rename sweep — `work-items`, `iterations`, `releases`, `workflow`, `projects`

**Files:** `libs/modules/{work-items,iterations,releases,workflow,projects}/**/*.ts`

- [ ] **Step 1: Mechanical rename**

```bash
grep -rl "tenantId\|tenant_id" libs/modules/work-items libs/modules/iterations libs/modules/releases libs/modules/workflow libs/modules/projects --include="*.ts" \
  | xargs sed -i 's/tenantId/workspaceId/g; s/tenant_id/workspace_id/g'
```

- [ ] **Step 2: Fold in touched-file audit fixes**

- `iterations.service.ts` `acceptIteration`: wrap the bulk work-item move + iteration state update in one `this.db.transaction`.
- `iterations.service.ts` `commitIteration`: add a `FOR UPDATE` on the committed-check or change `ix_iterations_committed` to a partial `uniqueIndex` in the schema + regenerate (only if you accept a schema follow-up; otherwise leave a `// TODO(concurrency)` — **decision: do it**, add the partial unique index in `work.ts` and regenerate a follow-up migration).
- `work-items.service.ts` attachment activity: add `.catch(err => this.logger.warn(...))` to the two `void this.activityRepo.append(...)` calls.

- [ ] **Step 3: Verify**

Run: `pnpm test -- libs/modules/work-items libs/modules/iterations libs/modules/releases libs/modules/workflow libs/modules/projects`
Expected: pass.

- [ ] **Step 4: Commit**

```bash
git add libs/modules/work-items libs/modules/iterations libs/modules/releases libs/modules/workflow libs/modules/projects
git commit -m "refactor(modules): rename tenant to workspace in work/iterations/releases/workflow/projects + fixes"
```

### Task 13: Rename sweep — `notifications` (+ SSE tenant filter fix)

**Files:** `libs/modules/notifications/**/*.ts`

- [ ] **Step 1: Mechanical rename**

```bash
grep -rl "tenantId\|tenant_id" libs/modules/notifications --include="*.ts" | xargs sed -i 's/tenantId/workspaceId/g; s/tenant_id/workspace_id/g'
```

- [ ] **Step 2: Fix the SSE scope**

In `notification-sse.controller.ts`, filter delivered payloads by the connection's active `workspaceId` (payloads now carry `workspaceId`), so a multi-workspace user only receives the active workspace's events.

- [ ] **Step 3: Verify + commit**

Run: `pnpm test -- libs/modules/notifications` → pass.

```bash
git add libs/modules/notifications
git commit -m "refactor(notifications): rename to workspace + scope SSE by active workspace"
```

---

## Phase 4 — Workspace Module & Auth Rewrite (backend gate)

### Task 14: Convert the `tenancy` module into the workspace module

**Files:** `libs/modules/tenancy/**/*.ts` (28 files)

- [ ] **Step 1: Mechanical rename**

```bash
grep -rl "tenantId\|tenant_id" libs/modules/tenancy --include="*.ts" | xargs sed -i 's/tenantId/workspaceId/g; s/tenant_id/workspace_id/g'
```

- [ ] **Step 2: Delete tenant CRUD + single-tenant bootstrap**

Remove `Tenant` entity/DTOs, tenant CRUD service+controller methods, `ensureSingleTenant()`, `ensureDefaultRole`'s tenant coupling, and `tenant_members` repository code (superseded by `workspace_members`).

- [ ] **Step 3: Fix the dead sole-admin guard (audit finding)**

Rewrite the last-admin check (was `member.roleId === 'admin'`) to count active admins via `user_role_assignments` joined to `system_roles.slug='admin'` at workspace scope; block removing/suspending the last workspace admin.

- [ ] **Step 4: Fix team-key case dedupe (audit finding)**

In `team.service.ts` `createTeam`, store `key.toUpperCase()` (matching the uniqueness check).

- [ ] **Step 5: Verify + commit**

Run: `pnpm test -- libs/modules/tenancy` → pass.

```bash
git add libs/modules/tenancy
git commit -m "refactor(workspace): convert tenancy module to workspace, fix sole-admin + team-key"
```

### Task 15: Rewrite auth login/switch/SSO for workspace context

**Files:** `libs/modules/identity/src/application/auth.service.ts`, `.../interface/http/auth.controller.ts`, `db/seeds/seed.ts`

- [ ] **Step 1: Mechanical rename in identity module**

```bash
grep -rl "tenantId\|tenant_id" libs/modules/identity --include="*.ts" | xargs sed -i 's/tenantId/workspaceId/g; s/tenant_id/workspace_id/g'
```

- [ ] **Step 2: Rewrite workspace resolution at login**

Replace tenant resolution: after authenticating the global user, load active `workspace_members`; pick `lastActiveAt` workspace, else first active, else `null`. Mint the access token with `workspaceId` (nullable). Delete the `isSingleTenant()` SSO fallback branches (`:264`, `:799`) and domain→tenant resolution.

- [ ] **Step 3: Rename `switchTenant`→`switchWorkspace`**

Endpoint + service: validate the target workspace membership, update `workspace_members.last_active_at`, re-mint the token with the new `workspaceId` (same rotation/denylist semantics).

- [ ] **Step 4: Fix SSO existing-identity re-check (audit finding)**

On the existing-identity SSO path, re-validate connection `status` (+ email-domain allowlist) — not only on new-identity provisioning.

- [ ] **Step 5: Fix forgotPassword token leak + enumeration (audit findings)**

Gate `devResetUrl` on `NODE_ENV === 'development'` (not `!== 'production'`). Return the silent `{}` for the active-user-no-membership branch instead of throwing 404.

- [ ] **Step 6: Rewrite the seed for workspaces**

`seed.ts`: create a default workspace + break-glass admin as a `workspace_member` (owner/admin role); remove tenant creation and hardcoded non-admin passwords; abort hard if `NODE_ENV==='production'`.

- [ ] **Step 7: Verify + commit**

Run: `pnpm test -- libs/modules/identity` → pass.

```bash
git add libs/modules/identity db/seeds/seed.ts
git commit -m "feat(auth): workspace-context login/switch, install-global SSO, seed rewrite + fixes"
```

### Task 16: Add default-workspace bootstrap

**Files:**
- Create: `libs/modules/tenancy/src/application/ensure-default-workspace.ts` (or method on the workspace service)
- Modify: the module's `OnApplicationBootstrap` hook

- [ ] **Step 1: Write the failing test**

`ensure-default-workspace.spec.ts`:

```ts
it('creates exactly one default workspace when none exist', async () => {
  await service.ensureDefaultWorkspace()
  const all = await repo.listAll()
  expect(all).toHaveLength(1)
  expect(all[0].slug).toBe('default')
})

it('is idempotent when a workspace already exists', async () => {
  await service.ensureDefaultWorkspace()
  await service.ensureDefaultWorkspace()
  expect(await repo.count()).toBe(1)
})
```

- [ ] **Step 2: Run it — fails** (`ensureDefaultWorkspace` undefined).

Run: `pnpm test -- ensure-default-workspace` → FAIL.

- [ ] **Step 3: Implement**

```ts
async ensureDefaultWorkspace(): Promise<void> {
  const count = await this.repo.count()
  if (count > 0) return
  await this.repo.create({ slug: 'default', name: 'Default Workspace', status: 'active' })
  this.logger.log('Default workspace provisioned on bootstrap')
}
```

Wire it into the module's `onApplicationBootstrap()`.

- [ ] **Step 4: Run it — passes.** Run: `pnpm test -- ensure-default-workspace` → PASS.

- [ ] **Step 5: BACKEND GATE — full typecheck + suite must now be green**

Run: `pnpm -w exec tsc --noEmit`
Expected: no errors (rename complete across backend).
Run: `grep -rn "tenantId\|tenant_id\|isSingleTenant\|DEPLOYMENT_MODE" libs apps/api apps/worker --include="*.ts" | grep -v spec`
Expected: no matches.
Run: `pnpm test`
Expected: all pass (≥ baseline from Task 0).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(workspace): default-workspace bootstrap; backend rename gate green"
```

---

## Phase 5 — Frontend

### Task 17: Rename tenant→workspace in FE state + API layer

**Files:** `apps/web/src/shared/lib/stores/auth.store.ts`, `apps/web/src/shared/api/auth-bootstrap.ts`, `apps/web/src/shared/api/app-config.ts`

- [ ] **Step 1: Regenerate API types from the updated backend**

Start the API locally, then:
Run: `cd apps/web && pnpm codegen`
Expected: `src/shared/api/generated/api.ts` updated (no `tenantId`).

- [ ] **Step 2: Rename store concepts**

`auth.store.ts`: `memberships`→`workspaces`, `activeTenantId`→`activeWorkspaceId`, `switchTenant`→`switchWorkspace` (+ its `catch` for error toast — audit finding). Update `auth-bootstrap.ts` and `app-config.ts` (drop `deploymentMode`; switcher always on).

- [ ] **Step 3: Update the store test**

`auth.store.test.ts`: rename fixtures/assertions.

- [ ] **Step 4: Verify + commit**

Run: `cd apps/web && pnpm typecheck && pnpm test`
Expected: pass.

```bash
git add apps/web/src/shared && git commit -m "refactor(web): rename tenant to workspace in state + api"
```

### Task 18: Convert the header org-switcher into a workspace switcher

**Files:** `apps/web/src/widgets/app-shell/app-shell.tsx`, `apps/web/src/pages/login/login-page.tsx`

- [ ] **Step 1: Rework the switcher**

Replace org/tenant labels with workspace; list the user's workspaces; selecting one calls `switchWorkspace`; nest the existing project/team context under it. Remove `deploymentMode`-gated hiding.

- [ ] **Step 2: Guard the empty tenantName crash (audit finding)**

`m.tenantName[0]` → `m.name?.[0]?.toUpperCase() ?? '?'` on the renamed workspace field.

- [ ] **Step 3: Verify + commit**

Run: `cd apps/web && pnpm typecheck`
Expected: pass. Manually verify switcher renders + switches (see Phase 7 smoke test).

```bash
git add apps/web/src/widgets apps/web/src/pages/login
git commit -m "feat(web): workspace switcher replaces org switcher"
```

---

## Phase 6 — Infra

### Task 19: Remove `DEPLOYMENT_MODE`/single-tenant from Terraform

**Files:** `infra/live/develop/main.tf:59-61,240-243`, `infra/live/prod/main.tf` (matching lines), both `variables.tf`, tfvars

- [ ] **Step 1: Remove locals + task-def env var**

Delete `deployment_mode`, `single_tenant_name`, `single_tenant_slug` locals and the `{ name = "DEPLOYMENT_MODE", value = ... }` (and SINGLE_TENANT_* if injected) from the api/worker container env blocks, in both develop and prod.

- [ ] **Step 2: Remove the matching variables + tfvars entries**

Delete `variable "deployment_mode"` etc. from `variables.tf` and any assignment in `terraform.tfvars`/`.example`.

- [ ] **Step 3: Verify Terraform is valid**

Run: `cd infra/live/develop && terraform validate`
Expected: `Success! The configuration is valid.` (repeat for `prod`).

- [ ] **Step 4: Commit**

```bash
git add infra && git commit -m "chore(infra): remove DEPLOYMENT_MODE and single-tenant vars"
```

---

## Phase 7 — Tests & Verification

### Task 20: Workspace-isolation integration tests

**Files:**
- Create: `libs/modules/work-items/src/application/workspace-isolation.spec.ts`

- [ ] **Step 1: Write failing isolation tests**

App-layer filtering is now the ONLY boundary — test it hard:

```ts
describe('workspace isolation', () => {
  it('cannot read another workspace\'s work items', async () => {
    const a = await createWorkspaceWithItem('WS-A')
    const b = await createWorkspace('WS-B')
    const res = await workItemsService.list({ workspaceId: b.id }, {})
    expect(res.items.find(i => i.id === a.itemId)).toBeUndefined()
  })

  it('cannot fetch a foreign work item by id', async () => {
    const a = await createWorkspaceWithItem('WS-A')
    const b = await createWorkspace('WS-B')
    await expect(workItemsService.get({ workspaceId: b.id }, a.itemId))
      .rejects.toThrow(/not found/i)
  })

  it('cannot update a foreign work item', async () => {
    const a = await createWorkspaceWithItem('WS-A')
    const b = await createWorkspace('WS-B')
    await expect(workItemsService.update({ workspaceId: b.id }, a.itemId, { title: 'x' }))
      .rejects.toThrow(/not found/i)
  })
})
```

- [ ] **Step 2: Run — expect pass** (the `workspace_id` filters already enforce this after the rename). If any fails, that endpoint has a missing filter — fix it.

Run: `pnpm test -- workspace-isolation`
Expected: PASS. Investigate + fix any failure (that is a real isolation bug).

- [ ] **Step 3: Commit**

```bash
git add libs/modules/work-items/src/application/workspace-isolation.spec.ts
git commit -m "test: workspace isolation across work-item read/write"
```

### Task 21: Membership + auth-flow tests

**Files:**
- Create/modify: `libs/modules/identity/src/application/auth.service.spec.ts`

- [ ] **Step 1: Write tests**

```ts
it('drops the user into their last-active workspace at login', async () => {
  const u = await seedUserInWorkspaces(['WS-A','WS-B'], { lastActive: 'WS-B' })
  const { accessToken } = await auth.login(u.email, u.password)
  expect(decode(accessToken).workspaceId).toBe(u.workspaces['WS-B'])
})

it('login succeeds with null workspaceId when user has no membership', async () => {
  const u = await seedUser({ workspaces: [] })
  const { accessToken } = await auth.login(u.email, u.password)
  expect(decode(accessToken).workspaceId).toBeNull()
})

it('switchWorkspace re-mints token and updates last_active_at', async () => {
  const u = await seedUserInWorkspaces(['WS-A','WS-B'])
  const { accessToken } = await auth.switchWorkspace(u.id, u.workspaces['WS-A'])
  expect(decode(accessToken).workspaceId).toBe(u.workspaces['WS-A'])
})

it('rejects switchWorkspace to a workspace the user is not a member of', async () => {
  const u = await seedUserInWorkspaces(['WS-A'])
  const foreign = await createWorkspace('WS-X')
  await expect(auth.switchWorkspace(u.id, foreign.id)).rejects.toThrow(/forbidden|not a member/i)
})
```

- [ ] **Step 2: Run — pass.** Run: `pnpm test -- auth.service` → PASS.

- [ ] **Step 3: Commit**

```bash
git add libs/modules/identity/src/application/auth.service.spec.ts
git commit -m "test: workspace login resolution + switch membership guard"
```

### Task 22: Full verification + manual smoke

**Files:** none (verification)

- [ ] **Step 1: Reset DB, migrate, seed**

Run: `pnpm db:migrate && pnpm db:seed`
Expected: exit 0; exactly one default workspace + break-glass admin membership.

- [ ] **Step 2: Full backend typecheck + lint + test**

Run: `pnpm -w exec tsc --noEmit && pnpm lint && pnpm test`
Expected: all clean/green.

- [ ] **Step 3: FE typecheck + build + test**

Run: `cd apps/web && pnpm typecheck && pnpm build && pnpm test`
Expected: all pass.

- [ ] **Step 4: Manual smoke (use the `run`/`verify` skill)**

Start API + web. Verify: login lands in default workspace; create a second workspace; switch between them; a project/work item in WS-A is not visible under WS-B; header workspace-switcher works; no `/config` `deploymentMode` reference errors.

- [ ] **Step 5: Final residue scan**

Run: `grep -rn "tenant" libs apps db infra --include="*.ts" --include="*.tsx" --include="*.sql" --include="*.tf" | grep -viE "workspace|// |/\*|node_modules|\.terraform"`
Expected: no meaningful `tenant` references remain (only incidental words, if any).

- [ ] **Step 6: Commit + open PR**

```bash
git add -A && git commit -m "chore: final verification for drop-multi-tenant"
```

---

## Self-Review Notes (spec coverage)

- Spec §4 (schema) → Tasks 1–6. §5 (auth/JWT) → Tasks 7, 15. §6 (config/infra) → Tasks 9, 19. §7 (backend sweep + audit fixes) → Tasks 8, 11–16. §8 (FE) → Tasks 17–18. §9 (migration) → Tasks 1, 6, 15(seed). §10 (tests) → Tasks 16, 20–22. §11 (risks: gate) → Task 16 Step 5. §12 decisions (archive status, install-global SSO, workspace creation open, keep global role scope) → Tasks 2, 5, 9, 14.
- Reachable audit fixes folded into the files already being touched: reporting/audit authz (11), collaboration validation (11), iteration atomicity/TOCTOU + fire-and-forget catch (12), SSE scope (13), sole-admin + team-key (14), SSO recheck + forgotPassword (15), FE switchTenant catch + tenantName crash (17–18).
