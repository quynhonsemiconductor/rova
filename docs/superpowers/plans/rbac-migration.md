# RBAC Migration — Project Access Levels (Admin / Editor)

> **⚠️ HISTORICAL. Do not read the phase table below as status.** Kept for the rationale and the
> architect rulings; it is wrong about two things and was misleading enough to cost real time during
> the 2026-08-14 audit.
>
> 1. **There is no `Viewer` level and no named `No Access`.** The title said both. `Viewer` was
>    removed by the BA, restored by ruling, and removed again on the BA's instruction (migrations
>    0113 then 0115); `No Access` was never a stored value — it is the absence of a
>    `project_members` row. Current model and the reasoning behind it: `CLAUDE.md` →
>    "Declared divergences from the BA, in the access model".
> 2. **The phase table understates what shipped.** #412 landed phases 1–3 *and* the phase-10
>    contract migration; #424 landed most of 4–9 (No-Access URL deny, `assertTeamScoped`, migrations
>    0109/0110/0111). Verify against `db/migrations/**` and the code, never against this table.
>
> Known still-outstanding work is tracked as audit findings, not here — `RBE-04` (team-scoped Editor
> covers 3 of ~14 writes), `RBE-05` (custom-role CRUD still live), `RBE-03` (WA is a project member).

**Status:** superseded 2026-08-14. Historical record of an approved plan (2026-08-11) that has since
been delivered in parts and amended twice by ruling.
**Source spec:** `product-docs/projects/mini-rally/Phase 4/02_Roles_Permissions/SRS.md` (2026-08-10 model); architecture source of truth `product-docs/.../05_Architecture/DATABASE_SCHEMA.md` §1.1 / R1.

## Goal
Collapse the 3-tier system-role ladder (`WORKSPACE_ADMIN` / `PROJECT_ADMIN` / `PROJECT_MEMBER`) into **one** workspace role (`workspace_admin`) plus a **per-Project access level** carried on `work.project_members.access_level` (`admin` | `editor` | `viewer`; no active row = `No Access`).

## Keystone insight
This is a **data-source swap, not a rewrite.** Every existing permission code, `permissionGrants()`, `PolicyGuard`, the `@RequirePermission` decorators, `ProjectScopeResolver`, the `effectiveAssignments` Valkey cache, and the `IProjectMemberRepository` port **stay**. Only the source feeding project-tier resolution moves: `access.user_role_assignments(scopeType='project')` → `work.project_members.access_level`.

## Architect rulings (the 3 open questions — decided)

1. **Workspace Admin = implicit full access via `workspace:*`, NOT a project member.**
   WA carries no `project_members` row and no `access_level`. Its `workspace:*` grant is the global anchor and covers every delivery action in every project (the existing `listReadableProjectIds` null-fast-path stays). WA is naturally excluded from project rosters / owner pickers / team candidates because it has no `project_members` row. This matches the SRS ("full company, Project and delivery authority" + "not added as a Project user or Team member").

2. **Permission timing = next-request (cache invalidation), not next sign-in.**
   The SRS says project-access/team changes land at next sign-in. We keep the **stricter** next-request guarantee already implemented via `AccessService.invalidateUser` after commit (the `authz:assign:<ws>:<user>` cache, 5-min TTL). Stricter is safer: a revoked Editor cannot keep editing until logout. Company disable/removal is added to the same invalidation path (today it is not invalidated at all). Recorded as an intentional over-delivery in `docs/DIVERGENCE.md`.

3. **Backfill mapping (role slug → access_level):**
   - `project_admin` → `admin` (full delivery admin, All Teams).
   - `project_member` → `editor` (write, team-scoped — preserves their current write capability).
   - active row with no role → `viewer` (read-only).
   - `status='removed'` (or no active row) → `No Access`.
   Editor requires ≥1 team; existing `team_members` rows satisfy that, an editor with no team is "pending team assignment" (WA grants later).

## Phased plan (expand-contract, zero-downtime)

| # | Effort | Work | Key files |
|---|---|---|---|
| 1 | **L** | **DB schema expand + data backfill** (FIRST — no code change, ships green). Add nullable `access_level VARCHAR(10) CHECK IN ('admin','editor','viewer')` to `work.project_members` (keep `role_id`, `status`). Backfill in the same migration via the slug→level map + mirror `user_role_assignments(scopeType='project')`. | `db/migrations/0104_project_members_access_level.sql` (new); `db/schema/work.ts` (projectMembers — add `accessLevel`) |
| 2 | S | **Catalog:** add `PROJECT_ACCESS_LEVEL` + `ACCESS_LEVEL_PERMISSIONS: Record<'admin'\|'editor'\|'viewer', Permission[]>` (admin = today's PROJECT_ADMIN delivery set; editor = write + team-scoped; viewer = read-only subset). Keep `PROJECT_ADMIN`/`PROJECT_MEMBER` in `SYSTEM_ROLE`/`ROLE_PERMISSIONS` marked `@deprecated` until the contract phase. Re-export via `libs/shared-kernel`. | `db/permissions.catalog.ts`; `libs/shared-kernel/src/permissions.ts` |
| 3 | **L** | **Engine (keystone):** add `IProjectMemberRepository.listActiveAccessLevelsForUser(ws,user)`. In `effectiveAssignments`, after loading `user_role_assignments`, ALSO load `access_level` rows and synthesize `EffectiveAssignment` entries (`scopeType='project'`, `permissions=ACCESS_LEVEL_PERMISSIONS[level]`). Signatures of `getProjectPermissions`/`listReadableProjectIds`/`assertProjectPermission`/`hasProjectPermission` unchanged — only the upstream source flips. Synthesis lives INSIDE the cached `effectiveAssignments` so the existing cache + `invalidateUser` cover it. | `libs/modules/access/src/application/access.service.ts`; `project-member.repository.ts` (port); `project-member.drizzle-repository.ts` |
| 4 | L | **Engine completion:** drop `project:view` from the empty-baseline fallback (no-row users get No Access); make `ensureDefaultRole` a no-op for project access (JIT users land with zero project access until WA grants); remove the auto-lead-membership seed in `createProject`; inject `AccessService` into `ProjectsService` + call `invalidateUser` after every add/update/remove member; in `removeProjectMember`, cascade-delete `team_members` for teams linked to that project; add `AUDIT_ACTION.PROJECT_ACCESS_GRANTED/REVOKED/CHANGED`. | `access.service.ts`; `projects.service.ts`; `projects.module.ts`; `libs/platform/src/audit/audit-event.ts` |
| 5 | M | **Guards/routes:** delete `assignProjectRole`/`revokeProjectRole` + `POST/DELETE /access/projects/:projectId/role-assignments`; move `POST/PATCH/DELETE /projects/:id/members` off `project:manage_members` (held by no role now) onto a workspace-tier code so only WA can administer access. | `access.service.ts`; `access.controller.ts`; `projects.controller.ts` |
| 6 | M | **No Access URL-deny + WA exclusion:** add `assertProjectPermission('project:view')` at the top of `ProjectsService.getProject` and every project-scoped read (`/:id/activity`, `/statuses`, `/labels`, `/teams`) — today a known id is a 200, defeating No Access. Exclude WA from project rosters/pickers (anti-join on `user_role_assignments(scope='workspace')`). | `projects.service.ts`; `access.service.ts`; owner feeds |
| 7 | **XL** | **FE:** `pnpm codegen`; mechanically replace `.roleId` → `.accessLevel` (~20 consumers); owner pickers add `accessLevel !== 'viewer'` + WA-exclusion; add ONE primitive `useProjectAccessLevel(projectId) → 'admin'\|'editor'\|'viewer'\|'none'`; **delete the Roles tab + role-editor** (no referent under R1); rework Members tab (roster = read-only identity + company-status lever); build the NEW per-project access surface (admin/editor/viewer + team membership); remove the FE additive-baseline fallback for project-tier codes (a viewer would otherwise see editor buttons during load — cut `staleTime` to 0). | `apps/web/src/features/{teams,access}/api.ts`; `pages/settings/ui/{members,roles,teams}-tab.tsx`; new per-project access surface |
| 8 | M | **Shipped-fix rework:** confirm TS-008's goal (every legitimate owner appears) now holds via the `access_level` gate (drop the team-derived UNION + dedupe); reuse SET-004's typed-confirm `ConfirmDialog` on the new per-project Remove Access (cascade team purge) and on company-disable; confirm the #401 next-request invalidation is wired into the new write paths. Add e2e pins. | `project-member.drizzle-repository.ts`; `access.service.ts`; `members-tab.tsx` |
| 9 | **L** | **Team-scoped Editor enforcement (largest NEW logic):** extend `ProjectScopeResolver` (or add `TeamScopeResolver`) so Editor write actions (`work_item:create/edit/delete`, iteration-status update) additionally verify the item's team is one of the user's assigned teams. Admin (`access_level='admin'`) bypasses — auto All Teams; Viewer denied all writes. | `project-scope.resolver.ts`; `policy.guard.ts`; new team-scope helper |
| 10 | S | **Contract migration (LAST):** after every reader is off `role_id`/`status`/`scopeType='project'` — `DROP project_members.role_id` (+ `status` if dropped); `DELETE` all `scopeType='project'` rows from `user_role_assignments`; `DELETE` per-workspace `PROJECT_ADMIN`/`PROJECT_MEMBER` from `system_roles`; tighten `scope_type` enum. | `db/migrations/0105_contract.sql` (new); `db/schema/work.ts`; `db/schema/enums.ts`; `db/schema/access.ts`; `db/permissions.catalog.ts` |

## Reuse vs replace

| Component | Verdict |
|---|---|
| PolicyGuard + `@RequirePermission` overload + mode decorators | **REUSE** (byte-for-byte) |
| `ProjectScopeResolver` | **REUSE** |
| `AccessService` (`effectiveAssignments`, cache, `invalidateUser`, `getProjectPermissions`, `listReadableProjectIds`) | **EXTEND** (swap source; delete `assignProjectRole`/`revokeProjectRole`/custom-role methods; add `setProjectAccessLevel`/`removeProjectAccess`) |
| `permissions.catalog.ts` (codes, tiers, `permissionGrants`) | **EXTEND** (add `ACCESS_LEVEL_PERMISSIONS`; retire PROJECT_ADMIN/MEMBER entries last) |
| `work.project_members` table | **EXTEND** (add `access_level`; drop `role_id`/`status` in contract) |
| Owner dropdown / candidate feeds (`listByProject`, `members-with-profile`, `useProjectMembers`) | **EXTEND** (invert TS-008: access_level-gated single query + WA anti-join) |
| Settings members/teams UI + Roles tab + role-editor | **REPLACE** (delete Roles tab + role editor; rework Members; new per-project access surface) |
| `ConfirmDialog` typed-confirmation | **REUSE** (new per-project Remove Access + company-disable) |

## Shipped-fix survival (from the 2026-08 audit fix sweep)

| Fix | Verdict |
|---|---|
| **TS-008** project members UNION | **REWORK** — goal survives (every owner appears) but mechanism replaced: `WHERE access_level IN ('admin','editor')`, no UNION |
| **SET-004** Members-tab role-change + Role column | **REMOVE** — no choosable workspace role under R1 |
| **SET-004** Remove-Access typed `ConfirmDialog` | **REWORK** — component reused; semantics split: company-disable (next-refresh) vs per-project No Access (next-request + team purge), different copy |
| **#401** `revokeProjectRole` cache-invalidate | **SURVIVES** — principle (prompt invalidation, not TTL) generalized to every `access_level`/team write; the methods/routes are deleted |
| Owner-dropdown candidate feeds | **REWORK** — goal survives; filter `accessLevel≠viewer` + WA-exclude |

## Data migration (zero-downtime, expand-contract)

1. **Expand** (same migration, ships green, no code change): `ALTER work.project_members ADD access_level VARCHAR(10) NULLABLE CHECK IN ('admin','editor','viewer')`. Keep `role_id`, `status`.
2. **Backfill** (same migration): `UPDATE work.project_members SET access_level = CASE WHEN role_id IN (SELECT id FROM access.system_roles WHERE slug='project_admin') THEN 'admin' WHEN slug='project_member' THEN 'editor' ELSE 'viewer' END WHERE status='active'`. Then mirror `user_role_assignments(scopeType='project')` into `project_members` via `INSERT ... ON CONFLICT (project_id,user_id) DO UPDATE`. Leave `status='removed'` rows (No Access). Old paths still deployed keep working — additive only.
3. **Engine swap** (Phase 3 deploy): `effectiveAssignments` reads `access_level` (now populated) and synthesizes project assignments; `scopeType='project'` branch unreachable but not deleted. Valkey cache ages out live-safe (5-min TTL + `invalidateUser`). Sessions unbroken: admin stays admin, member → editor, plain → viewer.
4. **Contract** (Phase 10): `DELETE scopeType='project'` rows; `DROP role_id/status`; tighten enum. Rollback safety net removed last.

## Risks

- **Data backfill correctness:** a partially-backfilled workspace silently under-grants. The Phase 1 migration backfills in-statement so this cannot happen on a single deploy.
- **No Access URL-deny missing today:** `ProjectsService.getProject` never asserts — a known id returns 200. Highest-severity gap (Phase 6); defeats the whole No Access model until fixed.
- **WA exclusion absent today:** WA appears in rosters/pickers; the `listReadableProjectIds` null-fast-path auto-grants WA every project. Phase 6 filters WA out of rosters; the null-fast-path stays (WA needs all-project read).
- **FE additive-fallback over-grants viewers:** `useProjectPermissions` falls back to the additive JWT baseline — a viewer would see editor buttons during load. Phase 7 removes the fallback for project-tier codes + cuts `staleTime`.
- **Cache coverage:** the Phase 3 synthesis must live INSIDE the cached `effectiveAssignments` (not beside it), or project reads go stale.
- **Contract cutover ordering:** Phase 10 must run only after Phases 3–7 are confirmed deployed with no `roleId`/`scopeType='project'` reads remaining. Expand-contract, never big-bang.

## Verification

- Tenant-isolation / authz e2e suite (`test/e2e/*-authz.e2e.spec.ts`) extended: Admin/Editor/Viewer/No Access scenarios per project; No Access URL-deny; WA exclusion; editor team-scoped write enforcement.
- Backfill idempotency check (re-running the UPDATE is a no-op).
- `permissions.spec.ts` + `fe-permission-contract.spec.ts` updated for `ACCESS_LEVEL_PERMISSIONS`.
