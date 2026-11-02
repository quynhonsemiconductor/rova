# RBAC / PBAC Architecture — Recommendation

**Author:** Nghia-VanTrong (SA lead)
**Date:** 2026-07-26
**Status:** Proposal for review (BA + eng)
**Scope:** Rova authorization model + code approach; convergence with sibling `opshub`.

---

## 1. TL;DR

- The **decorator approach is not the problem** — declaring authz as route metadata read by a guard is the correct, idiomatic NestJS pattern. The real problem is there are **three parallel enforcement mechanisms** (`PermissionGuard`, `ProjectPermissionGuard`, service-level `assertProjectPermission`) applied inconsistently, which has already produced **real read-enforcement gaps** (releases / milestones / reports readable across projects in the same workspace).
- **Model:** keep **RBAC + per-scope assignment** (which the DB already supports) with a **thin ABAC scope layer**. Do **not** build the SRS's user-editable Screen×Action×Role matrix — it is *more complex than Rally* (which uses fixed per-project levels) and is over-engineering for a single-product, small-company MVP.
- **Converge onto `opshub`'s authorization design** (one `PolicyGuard` + `scopeFrom` resolver, resolve-and-cache per request, fail-closed, attribute scopes). The two repos are meant to stay in lockstep and opshub is already the better pattern. This is the DRY, long-term win.
- **Flip fail-open → fail-closed** for authz decisions (security).

---

## 2. Where we are (evidence)

### 2.1 Enforcement — three mechanisms, one job
| Mechanism | Where | Used for |
|---|---|---|
| `PermissionGuard` (`@RequirePermission`) | `@quynhonsemiconductor/identity` pkg, bound in `platform.module.ts:103` | workspace-tier codes, from JWT snapshot |
| `ProjectPermissionGuard` (`@RequireProjectPermission`) | `libs/modules/access/.../project-permission.guard.ts` | project-tier, JWT fast-path then DB |
| `AccessService.assertProjectPermission` | `access.service.ts:474` | project-tier when id known only after a load |

Guard order is safely bundled in one `@UseGuards` via `@AuthProjectScoped()` / `@Auth()`. **Tier mis-scoping is a compile error** (`PERMISSION_TIER` + conditional types, `permissions.catalog.ts:102,138`) — a genuinely good property to keep.

### 2.2 Model + storage
- `access.user_role_assignments` (`userId, roleId, scopeType ∈ {global,workspace,project}, scopeId`) ⋈ `access.system_roles.permissions (jsonb)`.
- **Baseline** (global+workspace) is **snapshotted into the JWT** at mint (`claims.provider.ts:26`); **project tier resolved per request** (no cache).
- **Invalidation** via a per-user **authz epoch** counter in Valkey; project-scope changes deliberately don't bump (not in the token).
- **Fails open**: unreadable epoch/denylist ⇒ allow (`authz-epoch.service.ts`, `jwt.guard.ts:172`).
- Scope is **additive** (project role can only add, never subtract a workspace grant) — documented limitation (R3).

### 2.3 opshub (sibling, `../opshub`) — the more advanced pattern
- **One** `PolicyGuard` + `@RequirePermission(code, scopeFrom?)`; `scopeFrom(req)` yields resource attrs; `authz.check()` decides (`opshub/libs/platform/src/auth/{policy.guard,authz.service}.ts`).
- **Resolve-and-cache per request**: DB join → `Record<code, Scope[]>`, Valkey key `authz:perms:<userId>` TTL 300s + explicit `invalidate`.
- **Fail-closed** (resolution error ⇒ deny).
- **Attribute scopes** `global|self|team|dept|region` with a `ScopeEvaluator`.
- **Expiring grants** (`expiresAt`) + delegation / access-requests (PIM-style).
- Normalized `role_permissions` table (not a jsonb array).

### 2.4 Broadcom Rally — for product fidelity
- Fixed **per-project levels**: No Access · Viewer · Editor · Team Member (=Editor+flag) · Project Admin; workspace tier No Access · User · Workspace Admin (+ Subscription Admin).
- Permissions assigned **per project**; what each level can do is **fixed by the product, not editable per company**. → classic RBAC + per-scope assignment, **not** an editable matrix.

### 2.5 Industry best practice (2025)
RBAC base → add ABAC conditions when context creeps in → ReBAC (Zanzibar/OpenFGA/SpiceDB) only for user-driven sharing → PBAC (OPA/Cedar) only when policy is duplicated across many services. Our case (project+team scope, no arbitrary sharing) = **RBAC + thin ABAC**. Anything heavier is premature.

---

## 3. Concrete problems to fix (from audit §e)

**Security / correctness**
1. **Read-enforcement drift** — releases `GET :id/*` (`releases.service.ts:198,298`), milestones `GET :id/*` (`milestones.service.ts:331`), reporting burndown/velocity (`reporting.service.ts:16,35`), scm connections (`scm.controller.ts:88` uses workspace-tier) only check workspace, not project `:view`. A user scoped to Project X can read Project Y's data. **This is the headline bug.**
2. **Fail-open** authz on cache outage.
3. **`ensureDefaultRole` tier mismatch** — default `PROJECT_MEMBER` assigned at `scopeType:'workspace'` (`access.service.ts:335,349`) — a project role applied workspace-wide.

**Consistency / DRY**
4. `workspace:*` wildcard used as a *route gate* (`workspace.controller.ts:186,205,389`; `audit.controller.ts:39`) — un-delegatable by accident; needs real codes (`workspace:manage`, `workspace:delete`, `audit:view`).
5. No `scm:*` namespace — integrations reuse `workspace:manage_members`.
6. `*:manage_members` conflates invite / role-change / remove.
7. Singular permission surfaces vs plural REST resources — mapping trap.
8. `permissionGrants` wildcard logic duplicated in `access.service.ts:312`.
9. Split re-export surface in `@shared-kernel`; `PRESET_WORKSPACE_ROLES` not surfaced.
10. UI/API drift only guarded by code-parity specs, not "FE hides exactly what API denies" — so (1) is invisible to tests.

---

## 4. Target architecture

### 4.1 Model — RBAC + scope (keep it boring)
- **Fixed roles** = the SRS 3 (`workspace_admin`, `project_admin`, `project_member`). Drop `project_viewer`, `workspace_member`, and the 4 persona presets. (Optionally keep a per-project **Viewer** if BA wants Rally parity — cheap.)
- **Permission catalog = data**, one code per (surface, action), plural surfaces, no `*:manage`, no wildcard-as-gate.
- **Assignment is the editable thing**, not the role's permission set. WA assigns a role to a user **per project** (`scopeType:'project'`). This is exactly Rally's model + what the DB already models.
- **Matrix screen = read-only inspector** rendering the fixed catalog (documentation, not an editor). If BA insists on editability, allow it **only for custom (non-canonical) roles** via the existing `system_roles.permissions` jsonb — the 3 canonical roles stay immutable (recovery anchor).

> Recommendation: push back on the editable E/R/D/H matrix. It exceeds Rally, and "WA can broaden a role via override" (SRS §2) is a standing security foot-gun for a small-company MVP.

### 4.2 Enforcement — collapse 3 → 1 (adopt opshub's `PolicyGuard`)
- One guard: `@RequirePermission(code, scopeFrom?)`. `scopeFrom(req)` resolves the resource's scope (project id from param/query/body, or attrs after a load). Guard resolves effective permissions and decides. Removes the `PermissionGuard` + `ProjectPermissionGuard` + `assertProjectPermission` split that caused §3.1.
- **Keep** the compile-time tier safety (codes typed workspace vs project).
- **Resolve-and-cache per request** (opshub style): DB join → `Record<code, Scope[]>`, Valkey TTL + explicit invalidate on assignment change. Drop the JWT-snapshot-plus-epoch dance (or keep epoch only as a cache-bust signal). One mental model, no stale-token edge cases, project changes invalidate correctly.
- **Fail-closed.**

### 4.3 Scope semantics — project access as the primary gate
- For non-admins, **project access is the gate** (SRS §3.1): no role on Project Y ⇒ cannot read Y. Requires the §3.1 read fixes + making the workspace baseline NOT implicitly grant project reads for non-admins.
- Scopes: `global | workspace | project | team` (add `team`; opshub already has the evaluator pattern to copy). No `dept/region` unless the product grows.

### 4.4 DRY / lockstep — one authz library
Since boilerplate must stay identical with opshub and opshub is ahead: **converge rova onto opshub's authz module** (`PolicyGuard`, `AuthzService`, `ScopeEvaluator`, normalized `role_permissions`), adapting scope types. Long-term, promote it into the shared `@qnsc-vn` platform package so both products share one implementation + one test suite.

---

## 5. Phased plan (each phase shippable)

- **P0 — security hardening (small, do first).** Close read-enforcement gaps (§3.1) with project `:view` asserts + a contract test asserting every project-scoped route has a project-tier gate; flip fail-closed; fix `ensureDefaultRole` tier; replace `workspace:*`-as-gate with real codes; add `audit:view`. *No model change.*
- **P1 — catalog cleanup.** Plural surfaces, per-action codes, `scm:*`, split `manage_members` where it matters, dedupe `permissionGrants`, single `@shared-kernel` surface. Data migration for stored `system_roles.permissions`.
- **P2 — collapse enforcement to one guard.** Port opshub's `PolicyGuard` + `scopeFrom`; migrate controllers; delete the 3-way split; keep tier compile-safety. Add resolve-and-cache; fail-closed.
- **P3 — model reconcile (with BA).** Roles 9→3, canonical roles immutable, matrix screen read-only inspector, project-as-primary-gate, migrate existing assignments. Add `team` scope if needed.
- **P4 — optional.** Expiring grants + delegation / access-requests from opshub, if governance needs them.

---

## 6. Decisions needed

1. **Editable matrix vs fixed roles?** — Recommend **fixed roles + read-only matrix inspector** (BA call; contradicts SRS §2 editability).
2. **Converge onto opshub's authz (single guard, resolve+cache, fail-closed)?** — Recommend **yes**; bigger refactor, but the DRY long-term target and fixes the read gaps by construction.
3. **Project access as the primary gate for non-admins?** — Recommend **yes** (matches Rally + SRS §3.1); it's the most behaviour-visible change.
4. **Ship P0 now regardless?** — Recommend **yes** — it's a live cross-project read leak.
