/**
 * Canonical permission catalogue — the SINGLE source of truth for RBAC.
 *
 * This file lives in db/ (not libs/) on purpose: it is the ONE place both the
 * standalone migrator/seed image (which only bundles db/**) and the NestJS app
 * (via @shared-kernel, which re-exports this) can import. Keeping it here is
 * what stops the seed's role definitions, the backend @RequirePermission
 * decorators, and the frontend hasPermission() gating from drifting apart.
 *
 * Guard semantics: `workspace:*` grants everything; a `ns:*` wildcard grants
 * that namespace; otherwise an exact code match is required. Deny by default.
 *
 * ⚠️  Dependency-free by design — do NOT import from libs/ here, or the migrator
 *     Docker image (db/** only) will fail to build.
 */

export const SYSTEM_ROLE = {
  WORKSPACE_ADMIN: 'workspace_admin',
  PROJECT_ADMIN: 'project_admin',
  PROJECT_MEMBER: 'project_member',
} as const;

export const PERMISSION = {
  // ── workspace namespace ────────────────────────────────────────────────────
  WORKSPACE_ALL: 'workspace:*',
  WORKSPACE_VIEW: 'workspace:view',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_EDIT: 'workspace:edit',
  WORKSPACE_DELETE: 'workspace:delete',

  // ── users namespace (company member + invitation management) ────────────────
  // Split out of the former coarse `workspace:manage_members` for least-privilege
  // + audit clarity; each is an independent action.
  //
  // THERE IS STILL NO `users:view`, BUT THE REASON CHANGED (RBE-07). It used to be
  // "roster READS stay open to any authenticated member — owner pickers need them",
  // and that was the premise under which the company directory (with `phone`,
  // `lastLoginAt` and every role id) was readable by an Editor and by a No Access
  // principal alike. The roster is now two routes by AUDIENCE:
  //   * `GET workspaces/:id/member-options`       the picker feed — id, name, email,
  //     avatar — scoped in the service by `listReadableProjectIds`;
  //   * `GET workspaces/:id/members-with-profile` the User Management roster, gated
  //     `workspace:view` (Workspace Admin), which is the code that already gates
  //     `GET workspaces/:id/settings`.
  // So the gate exists; it is an EXISTING code rather than a new one, which also means
  // no backfill migration was needed to reach an already-seeded workspace.
  USERS_INVITE: 'users:invite',
  USERS_REMOVE: 'users:remove',
  USERS_ASSIGN_ROLE: 'users:assign_role',

  // ── api tokens namespace ───────────────────────────────────────────────────
  //
  // ONE code, and it is the ADMIN one. Minting, listing and revoking your OWN tokens
  // needs no permission at all — it is `me/*` surface, self-scoped by the principal,
  // exactly like `me/avatar`. Real Rally works this way too: any user may create an
  // API Key, and only a subscription administrator can see or reset everyone's.
  //
  // What this code grants is the administrator's view: every token in the workspace,
  // whose it is, when it was last used, and the ability to revoke it. That is an
  // offboarding and incident-response capability, not a convenience — a workspace
  // admin who cannot enumerate live machine credentials cannot answer "what still has
  // access" after someone leaves.
  API_TOKEN_MANAGE_ALL: 'api_token:manage_all',

  // ── roles namespace (the Roles & Permissions surface itself) ────────────────
  // Managing WHAT a role can do is a distinct concern from managing PEOPLE —
  // previously conflated under `workspace:manage_members`.
  ROLES_VIEW: 'roles:view',
  ROLES_EDIT: 'roles:edit',

  // ── teams namespace (split out of the former `workspace:manage_teams`) ───────
  // Only WRITES have a code here, and team reads still have none — but they are no
  // longer OPEN (RBE-08 / PRJ-07). §3.1 makes "View Project Details and Teams" a
  // per-Project row, and a team is reached through its project links, so the three
  // read routes (`GET workspaces/:id/teams`, `GET teams/:id`, `GET teams/:id/members`)
  // are scoped in `TeamService` by `listReadableProjectIds` — a cross-project list
  // whose `null` / `[]` sentinels a decorator cannot carry. A workspace-tier code
  // would have been wrong in both directions: an Editor holds none, and holding one
  // would grant every team in the workspace.
  TEAMS_CREATE: 'teams:create',
  TEAMS_EDIT: 'teams:edit',
  TEAMS_MANAGE_MEMBERS: 'teams:manage_members',

  // ── audit + scm (workspace-tier) ─────────────────────────────────────────────
  AUDIT_VIEW: 'audit:view',
  // Managing SCM installations/repositories is an integrations concern — NOT
  // people management (was wrongly gated by workspace:manage_members).
  SCM_MANAGE: 'scm:manage',

  // ── project namespace ──────────────────────────────────────────────────────
  PROJECT_VIEW: 'project:view',
  PROJECT_CREATE: 'project:create',
  PROJECT_EDIT: 'project:edit',
  PROJECT_ARCHIVE: 'project:archive',
  PROJECT_RESTORE: 'project:restore',
  PROJECT_DELETE: 'project:delete',
  PROJECT_MANAGE_MEMBERS: 'project:manage_members',

  // ── work_item namespace ────────────────────────────────────────────────────
  WORK_ITEM_VIEW: 'work_item:view',
  WORK_ITEM_CREATE: 'work_item:create',
  WORK_ITEM_EDIT: 'work_item:edit',
  WORK_ITEM_DELETE: 'work_item:delete',

  // ── iteration namespace ────────────────────────────────────────────────────
  /**
   * READ the project's iterations as REFERENCE data: the `/options` reference feed
   * (every state — a filter and an id→name label must be able to name an accepted
   * timebox), the `/assignable` eligibility feed (`planning | committed`) and
   * `Track > Iteration Status`.
   *
   * Held by EVERY level, Editor included, and it has to be. §3.2 gives the Editor
   * `Iteration Status | View and update in assigned Teams`, and that screen's own picker
   * reads it — as do the Backlog's iteration filter, Team Status's picker and Quality's.
   * Revoking it would 403 four surfaces the same matrix grants.
   *
   * It does NOT cover `GET /iterations`, the PAGED RECORD behind the `Plan > Timeboxes`
   * grid: that carries `TIMEBOX_VIEW`. It used to carry this code, because it was also the
   * only feed those four surfaces had — so the surface was split and the feed was not, and
   * the Editor kept reading `goal`, `theme`, `notes` and `plannedVelocity`. The reference
   * feed is what closed it.
   *
   * Do NOT gate the `Plan > Timeboxes` surface on this code. That is `TIMEBOX_VIEW`
   * below, and conflating the two is the defect that code was added to fix.
   */
  ITERATION_VIEW: 'iteration:view',
  ITERATION_CREATE: 'iteration:create',
  ITERATION_EDIT: 'iteration:edit',
  ITERATION_DELETE: 'iteration:delete',

  // ── timebox namespace (the `Plan > Timeboxes` SURFACE) ──────────────────────
  /**
   * Open the `Plan > Timeboxes` administration surface: a timebox as a managed record
   * (goal, theme, notes, planned velocity) and its revision history.
   *
   * WHY IT EXISTS
   * §3.2 marks `Timeboxes / Iterations` **Hidden** for an Editor and `Create, View, Edit,
   * Delete` for Admin and WA — while the row directly above it gives the Editor
   * `Iteration Status | View and update`. One code cannot answer two different questions,
   * and `iteration:view` was being asked both: it gated the Timeboxes nav entry, the
   * timebox grid, the timebox record and its revision history AND Iteration Status. So an
   * Editor read the entire timebox inventory — names, dates, states, commitment — on a
   * screen the BA hides, and was additionally offered a `Releases` TYPE that then 403'd
   * (RBE-09 / P23-08 / P01-11, audit of 2026-08-14).
   *
   * The split ADDS the narrower capability rather than subtracting the broad one, because
   * subtracting was not available: `iteration:view` is load-bearing for four Editor
   * surfaces (see its docblock). That also means no role loses a permission here —
   * migration 0120 is purely additive, the only shape that cannot undo a decision.
   *
   * WHY A NAMESPACE OF ITS OWN, AND WHY *NOT* `iteration:manage`
   * Two reasons, and the second is the decisive one:
   *   1. §3.2's row is a SURFACE, not an entity. That one screen hosts Iterations,
   *      Releases and Milestones behind a TYPE switcher, so a code in the `iteration`
   *      namespace could not honestly gate it. (The other two types are already Hidden for
   *      an Editor through `release:view` / `milestone:view`, neither of which the Editor
   *      holds — Iterations was the single type whose view code an Editor legitimately
   *      needs, which is exactly why it was the one that needed splitting.)
   *   2. `iteration:manage` is a RETIRED CODE STRING. It used to be the coarse
   *      create+edit+delete bundle, and migration `0048_split_manage_permissions.sql`
   *      deleted it from every stored role — global templates, per-workspace copies and
   *      custom roles — replacing it with the three leaves. Re-using the string for a new,
   *      narrower meaning would make any pre-0048 role, backup or hand-authored export
   *      silently grant this surface, and it would read to every future maintainer as the
   *      bundle 0048 unbundled. A retired code must not be recycled.
   *
   * A single-code namespace is the house pattern for a surface-shaped gate: `quality:view`
   * (the defect dashboard), `audit:view`, `scm:manage`. The trade-off is that `iteration:*`
   * no longer implies this one — deliberate, and the safer direction: a namespace wildcard
   * quietly opening an administration surface is the worse failure.
   */
  TIMEBOX_VIEW: 'timebox:view',

  // ── release namespace ──────────────────────────────────────────────────────
  RELEASE_VIEW: 'release:view',
  RELEASE_CREATE: 'release:create',
  RELEASE_EDIT: 'release:edit',
  RELEASE_DELETE: 'release:delete',

  // ── team-status namespace (P3.1) ───────────────────────────────────────────
  TEAM_STATUS_VIEW: 'team_status:view',
  TEAM_STATUS_EDIT: 'team_status:edit',

  // ── quality namespace (P3.4) ───────────────────────────────────────────────
  // Quality is a read-only reporting surface (defect dashboard + metrics).
  // Defects ARE work items, so their create/edit/delete flows through the
  // work_item namespace — there is no separate quality write permission.
  QUALITY_VIEW: 'quality:view',

  // ── milestone namespace (P3.3) ─────────────────────────────────────────────
  MILESTONE_VIEW: 'milestone:view',
  MILESTONE_CREATE: 'milestone:create',
  MILESTONE_EDIT: 'milestone:edit',
  MILESTONE_DELETE: 'milestone:delete',

  // ── portfolio namespace (P5.1 — Epic + Feature) ────────────────────────────
  // The BA spec calls the gate `manageFeatures`; translated to the house
  // <entity>:<action> convention. One namespace covers both types: Epic and
  // Feature share a table, a list and a create flow, so a separate epic:* set
  // would be four codes nobody could explain the difference of.
  PORTFOLIO_VIEW: 'portfolio:view',
  PORTFOLIO_CREATE: 'portfolio:create',
  PORTFOLIO_EDIT: 'portfolio:edit',
  // Archive, not delete — the spec has no hard delete for portfolio items.
  PORTFOLIO_ARCHIVE: 'portfolio:archive',

  // ── capacity namespace (P5.2) ──────────────────────────────────────────────
  CAPACITY_VIEW: 'capacity:view',
  CAPACITY_MANAGE: 'capacity:manage',
  // Separate from MANAGE on purpose: publishing WRITES BACK to Feature release and
  // planned dates, so it changes records outside the plan. Editing a draft does not.
  // Different blast radius, different grant.
  CAPACITY_PUBLISH: 'capacity:publish',
  /**
   * See DRAFT plans without being able to change them.
   *
   * The BA has ONE permission (`capacity_planning:manage`) with two settings where we have three
   * codes, and that mismatch made two of its acceptance criteria unsatisfiable at once:
   *
   *   • AC-012 — a Project Admin set to `Read-only` keeps "opening Draft and Published plans while
   *     changing nothing";
   *   • AC-013 — a Project Member does not see Drafts at all.
   *
   * Draft visibility was `capacity:manage || capacity:publish`, so both roles were refused Drafts:
   * AC-013 held and AC-012 did not, and no combination of the three existing codes could tell a
   * read-only Project Admin from a Project Member. This is the fourth code that can. It grants
   * READ only — every write still requires `capacity:manage` or `capacity:publish`.
   */
  CAPACITY_VIEW_DRAFT: 'capacity:view_draft',

  // ── report namespace (P6) ──────────────────────────────────────────────────
  // Iteration Burndown, Velocity and Team Capacity, plus Release Tracking's
  // classification and burnup. ONE read code for the whole surface rather than one
  // per report: the three reports are a single page with a Type selector, and the
  // SRS gives them one authorization boundary ("Enforce Project/Team authorization
  // before returning aggregates"). Splitting it would create three grants nobody
  // could explain the difference between.
  //
  // Not folded into `iteration:view` — which is what the legacy reporting controller
  // reused. A report aggregates ACROSS iterations, releases, tasks and member
  // capacity, so an admin restricting who may read team-level performance data has to
  // be able to do that without also revoking the iteration list.
  //
  // Read-only by design. Nothing in Phase 6 writes through a report: the daily
  // snapshot jobs are internal scheduled work with no HTTP surface, and capacity is
  // still edited through `team_status:edit` on Team Status.
  REPORT_VIEW: 'report:view',

  // ── test_case / test_result namespaces (Phase 7) ───────────────────────────
  // Split from `work_item:*` rather than reused, even though a Test Case is delivery
  // artifact of the same class as a Story/Defect/Task: reusing `work_item:*` would make
  // `work_item:edit` imply editing every Test Case, and a later "QA writes tests, not
  // stories" ruling needs the split anyway (Phase 7 plan D3). Granted to every role that
  // holds `work_item:*` today — see ROLE_PERMISSIONS — so nothing narrows on landing.
  TEST_CASE_VIEW: 'test_case:view',
  TEST_CASE_CREATE: 'test_case:create',
  TEST_CASE_EDIT: 'test_case:edit',
  TEST_CASE_DELETE: 'test_case:delete',
  TEST_RESULT_VIEW: 'test_result:view',
  TEST_RESULT_CREATE: 'test_result:create',
  TEST_RESULT_EDIT: 'test_result:edit',
  TEST_RESULT_DELETE: 'test_result:delete',
} as const;

/** Union of every valid permission code. */
export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION];

/** Union of every valid system-role slug. */
export type SystemRoleSlug = (typeof SYSTEM_ROLE)[keyof typeof SYSTEM_ROLE];

/**
 * The SCOPE TIER of every permission — the single fact that decides how it is
 * enforced, so a permission can never be checked at the wrong scope by accident:
 *
 *   - `workspace` — resolved against the workspace-wide baseline baked into the
 *     JWT (the flat `@RequirePermission` guard). It isn't tied to a single
 *     project instance: administering the workspace, or minting a new project.
 *   - `project`  — resolved PER PROJECT at request time as
 *     `baseline ∪ project-scoped role` (the `@RequireProjectPermission` guard,
 *     or `AccessService.assertProjectPermission` when the project id is only
 *     known after loading a resource). Everything that acts on an EXISTING
 *     project is project-tier — including `project:delete` (it targets a
 *     specific project; only workspace_admin holds it, so `workspace:*`
 *     fast-paths the check regardless of tier).
 *
 * The derived `WorkspacePermission` / `ProjectPermission` types below feed the
 * two decorators' signatures, which is what makes a mis-scoped guard a COMPILE
 * error rather than a silent authorization gap.
 */
export const PERMISSION_TIER = {
  [PERMISSION.WORKSPACE_ALL]: 'workspace',
  [PERMISSION.WORKSPACE_VIEW]: 'workspace',
  [PERMISSION.WORKSPACE_CREATE]: 'workspace',
  [PERMISSION.WORKSPACE_EDIT]: 'workspace',
  [PERMISSION.WORKSPACE_DELETE]: 'workspace',
  [PERMISSION.USERS_INVITE]: 'workspace',
  [PERMISSION.USERS_REMOVE]: 'workspace',
  [PERMISSION.USERS_ASSIGN_ROLE]: 'workspace',
  [PERMISSION.API_TOKEN_MANAGE_ALL]: 'workspace',
  [PERMISSION.ROLES_VIEW]: 'workspace',
  [PERMISSION.ROLES_EDIT]: 'workspace',
  [PERMISSION.TEAMS_CREATE]: 'workspace',
  [PERMISSION.TEAMS_EDIT]: 'workspace',
  [PERMISSION.TEAMS_MANAGE_MEMBERS]: 'workspace',
  [PERMISSION.AUDIT_VIEW]: 'workspace',
  [PERMISSION.SCM_MANAGE]: 'workspace',
  [PERMISSION.PROJECT_CREATE]: 'workspace',

  [PERMISSION.PROJECT_VIEW]: 'project',
  [PERMISSION.PROJECT_EDIT]: 'project',
  [PERMISSION.PROJECT_ARCHIVE]: 'project',
  [PERMISSION.PROJECT_RESTORE]: 'project',
  [PERMISSION.PROJECT_DELETE]: 'project',
  [PERMISSION.PROJECT_MANAGE_MEMBERS]: 'project',
  [PERMISSION.WORK_ITEM_VIEW]: 'project',
  [PERMISSION.WORK_ITEM_CREATE]: 'project',
  [PERMISSION.WORK_ITEM_EDIT]: 'project',
  [PERMISSION.WORK_ITEM_DELETE]: 'project',
  [PERMISSION.ITERATION_VIEW]: 'project',
  [PERMISSION.ITERATION_CREATE]: 'project',
  [PERMISSION.ITERATION_EDIT]: 'project',
  [PERMISSION.ITERATION_DELETE]: 'project',
  // Project tier: `Plan > Timeboxes` shows one project's timeboxes, so a grant on one
  // project must not open another's.
  [PERMISSION.TIMEBOX_VIEW]: 'project',
  [PERMISSION.RELEASE_VIEW]: 'project',
  [PERMISSION.RELEASE_CREATE]: 'project',
  [PERMISSION.RELEASE_EDIT]: 'project',
  [PERMISSION.RELEASE_DELETE]: 'project',
  [PERMISSION.TEAM_STATUS_VIEW]: 'project',
  [PERMISSION.TEAM_STATUS_EDIT]: 'project',
  [PERMISSION.QUALITY_VIEW]: 'project',
  [PERMISSION.MILESTONE_VIEW]: 'project',
  [PERMISSION.MILESTONE_CREATE]: 'project',
  [PERMISSION.MILESTONE_EDIT]: 'project',
  [PERMISSION.MILESTONE_DELETE]: 'project',
  // Project tier: a portfolio item and a capacity plan both belong to a Project, and
  // the spec scopes visibility by the Projects a user administers or is a member of.
  [PERMISSION.PORTFOLIO_VIEW]: 'project',
  [PERMISSION.PORTFOLIO_CREATE]: 'project',
  [PERMISSION.PORTFOLIO_EDIT]: 'project',
  [PERMISSION.PORTFOLIO_ARCHIVE]: 'project',
  [PERMISSION.CAPACITY_VIEW]: 'project',
  [PERMISSION.CAPACITY_VIEW_DRAFT]: 'project',
  [PERMISSION.CAPACITY_MANAGE]: 'project',
  [PERMISSION.CAPACITY_PUBLISH]: 'project',
  // Project tier: every report is bounded by one Project, and Team is a filter inside
  // it. A workspace-tier report code would let a grant on one project read another's
  // velocity.
  [PERMISSION.REPORT_VIEW]: 'project',
  // Project tier: a Test Case belongs to a Project (D2 — optionally to one Work Item),
  // same tier as work_item:* beside it.
  [PERMISSION.TEST_CASE_VIEW]: 'project',
  [PERMISSION.TEST_CASE_CREATE]: 'project',
  [PERMISSION.TEST_CASE_EDIT]: 'project',
  [PERMISSION.TEST_CASE_DELETE]: 'project',
  [PERMISSION.TEST_RESULT_VIEW]: 'project',
  [PERMISSION.TEST_RESULT_CREATE]: 'project',
  [PERMISSION.TEST_RESULT_EDIT]: 'project',
  [PERMISSION.TEST_RESULT_DELETE]: 'project',
} as const satisfies Record<Permission, 'workspace' | 'project'>;

/** Permissions enforced against the workspace-wide JWT baseline. */
export type WorkspacePermission = {
  [K in Permission]: (typeof PERMISSION_TIER)[K] extends 'workspace' ? K : never;
}[Permission];

/** Permissions resolved per-project (baseline ∪ project-scoped role). */
export type ProjectPermission = {
  [K in Permission]: (typeof PERMISSION_TIER)[K] extends 'project' ? K : never;
}[Permission];

/** Runtime tier lookup — mirror of the compile-time split for guard internals. */
export function isProjectTierPermission(permission: string): permission is ProjectPermission {
  return (PERMISSION_TIER as Record<string, 'workspace' | 'project'>)[permission] === 'project';
}

/**
 * The one wildcard-aware permission check, shared by every guard and service so
 * the semantics can't drift. A caller holding `permissions` is granted `required`
 * when any of these is true:
 *   - `workspace:*`  — the global wildcard grants everything
 *   - an exact match of `required`
 *   - `ns:*`         — the namespace wildcard (e.g. `work_item:*` grants
 *                      `work_item:edit`)
 */
export function permissionGrants(
  permissions: readonly string[] | undefined,
  required: string,
): boolean {
  if (!permissions?.length) return false;
  if (permissions.includes(PERMISSION.WORKSPACE_ALL) || permissions.includes(required)) {
    return true;
  }
  const ns = required.split(':')[0];
  return !!ns && permissions.includes(`${ns}:*`);
}

/**
 * Role → permission grants. Authoritative definition consumed by the DB seed.
 *
 * Two invariants keep this table sane and enterprise-safe — preserve them when
 * editing:
 *   1. MONOTONIC TIERS — project_member ⊆ project_admin, and workspace_admin
 *      (via `workspace:*`) ⊇ everything. A higher role is always a strict
 *      superset of the one below it.
 *   2. MANAGE IMPLIES VIEW — any role holding an `X:manage` / `X:edit` grant also
 *      holds the matching `X:view`. You can't manage what you can't see.
 *
 * `workspace_admin` also carries `workspace:*`, so it implicitly grants
 * everything; the explicit codes are still listed so the catalogue reads
 * honestly and no admin endpoint depends on the wildcard alone.
 *
 * Scope note: `project:create` / `project:delete` are WORKSPACE-tier actions
 * (mint / destroy a project) — only workspace_admin holds them. A project-scoped
 * role governs projects that already exist, it does not create new ones.
 */
export const ROLE_PERMISSIONS: Record<SystemRoleSlug, Permission[]> = {
  [SYSTEM_ROLE.WORKSPACE_ADMIN]: [
    PERMISSION.WORKSPACE_ALL,
    PERMISSION.WORKSPACE_VIEW,
    PERMISSION.WORKSPACE_CREATE,
    PERMISSION.WORKSPACE_EDIT,
    PERMISSION.WORKSPACE_DELETE,
    PERMISSION.USERS_INVITE,
    PERMISSION.USERS_REMOVE,
    PERMISSION.USERS_ASSIGN_ROLE,
    PERMISSION.API_TOKEN_MANAGE_ALL,
    PERMISSION.ROLES_VIEW,
    PERMISSION.ROLES_EDIT,
    PERMISSION.TEAMS_CREATE,
    PERMISSION.TEAMS_EDIT,
    PERMISSION.TEAMS_MANAGE_MEMBERS,
    PERMISSION.AUDIT_VIEW,
    PERMISSION.SCM_MANAGE,
    PERMISSION.PROJECT_VIEW,
    PERMISSION.PROJECT_CREATE,
    PERMISSION.PROJECT_EDIT,
    PERMISSION.PROJECT_ARCHIVE,
    PERMISSION.PROJECT_RESTORE,
    PERMISSION.PROJECT_DELETE,
    PERMISSION.PROJECT_MANAGE_MEMBERS,
    PERMISSION.WORK_ITEM_VIEW,
    PERMISSION.WORK_ITEM_CREATE,
    PERMISSION.WORK_ITEM_EDIT,
    PERMISSION.WORK_ITEM_DELETE,
    PERMISSION.ITERATION_VIEW,
    PERMISSION.ITERATION_CREATE,
    PERMISSION.ITERATION_EDIT,
    PERMISSION.ITERATION_DELETE,
    // §3.2 `Timeboxes / Iterations` is `Create, View, Edit, Delete` here and Hidden for an
    // Editor, so this is the code that separates the two — see its docblock.
    PERMISSION.TIMEBOX_VIEW,
    PERMISSION.RELEASE_VIEW,
    PERMISSION.RELEASE_CREATE,
    PERMISSION.RELEASE_EDIT,
    PERMISSION.RELEASE_DELETE,
    PERMISSION.TEAM_STATUS_VIEW,
    PERMISSION.TEAM_STATUS_EDIT,
    PERMISSION.QUALITY_VIEW,
    PERMISSION.MILESTONE_VIEW,
    PERMISSION.MILESTONE_CREATE,
    PERMISSION.MILESTONE_EDIT,
    PERMISSION.MILESTONE_DELETE,
    PERMISSION.PORTFOLIO_VIEW,
    PERMISSION.PORTFOLIO_CREATE,
    PERMISSION.PORTFOLIO_EDIT,
    PERMISSION.PORTFOLIO_ARCHIVE,
    PERMISSION.CAPACITY_VIEW,
    // A Project Admin turned Read-only keeps this and loses the two write codes, which is what
    // makes AC-012 ("still opening Draft and Published plans") expressible at all.
    PERMISSION.CAPACITY_VIEW_DRAFT,
    PERMISSION.CAPACITY_MANAGE,
    PERMISSION.CAPACITY_PUBLISH,
    PERMISSION.REPORT_VIEW,
    PERMISSION.TEST_CASE_VIEW,
    PERMISSION.TEST_CASE_CREATE,
    PERMISSION.TEST_CASE_EDIT,
    PERMISSION.TEST_CASE_DELETE,
    PERMISSION.TEST_RESULT_VIEW,
    PERMISSION.TEST_RESULT_CREATE,
    PERMISSION.TEST_RESULT_EDIT,
    PERMISSION.TEST_RESULT_DELETE,
  ],
  // Full DELIVERY control of an assigned project, but NOT its lifecycle or
  // membership. Per SRS Phase 4.2: project create/archive/restore/delete and
  // member management are workspace_admin-only (moved off project_admin).
  [SYSTEM_ROLE.PROJECT_ADMIN]: [
    PERMISSION.PROJECT_VIEW,
    PERMISSION.PROJECT_EDIT,
    PERMISSION.WORK_ITEM_VIEW,
    PERMISSION.WORK_ITEM_CREATE,
    PERMISSION.WORK_ITEM_EDIT,
    PERMISSION.WORK_ITEM_DELETE,
    PERMISSION.ITERATION_VIEW,
    PERMISSION.ITERATION_CREATE,
    PERMISSION.ITERATION_EDIT,
    PERMISSION.ITERATION_DELETE,
    // §3.2 `Timeboxes / Iterations` is `Create, View, Edit, Delete` here and Hidden for an
    // Editor, so this is the code that separates the two — see its docblock.
    PERMISSION.TIMEBOX_VIEW,
    PERMISSION.RELEASE_VIEW,
    PERMISSION.RELEASE_CREATE,
    PERMISSION.RELEASE_EDIT,
    PERMISSION.RELEASE_DELETE,
    PERMISSION.TEAM_STATUS_VIEW,
    PERMISSION.TEAM_STATUS_EDIT,
    PERMISSION.QUALITY_VIEW,
    PERMISSION.MILESTONE_VIEW,
    PERMISSION.MILESTONE_CREATE,
    PERMISSION.MILESTONE_EDIT,
    PERMISSION.MILESTONE_DELETE,
    PERMISSION.PORTFOLIO_VIEW,
    PERMISSION.PORTFOLIO_CREATE,
    PERMISSION.PORTFOLIO_EDIT,
    PERMISSION.PORTFOLIO_ARCHIVE,
    PERMISSION.CAPACITY_VIEW,
    // A Project Admin turned Read-only keeps this and loses the two write codes, which is what
    // makes AC-012 ("still opening Draft and Published plans") expressible at all.
    PERMISSION.CAPACITY_VIEW_DRAFT,
    PERMISSION.CAPACITY_MANAGE,
    PERMISSION.CAPACITY_PUBLISH,
    PERMISSION.REPORT_VIEW,
    PERMISSION.TEST_CASE_VIEW,
    PERMISSION.TEST_CASE_CREATE,
    PERMISSION.TEST_CASE_EDIT,
    PERMISSION.TEST_CASE_DELETE,
    PERMISSION.TEST_RESULT_VIEW,
    PERMISSION.TEST_RESULT_CREATE,
    PERMISSION.TEST_RESULT_EDIT,
    PERMISSION.TEST_RESULT_DELETE,
  ],
  // Delivery contributor inside ONE assigned project. Per SRS Phase 4.2 the
  // member can create AND delete US/DE + tasks (delete added); no iteration/
  // release/milestone management, no team capacity, no project settings.
  [SYSTEM_ROLE.PROJECT_MEMBER]: [
    PERMISSION.PROJECT_VIEW,
    PERMISSION.WORK_ITEM_VIEW,
    PERMISSION.WORK_ITEM_CREATE,
    PERMISSION.WORK_ITEM_EDIT,
    PERMISSION.WORK_ITEM_DELETE,
    // The timebox READ Iteration Status, the Backlog filter, Team Status and Quality all
    // depend on — NOT the `Plan > Timeboxes` surface, which §3.2 marks Hidden for an Editor
    // and which `TIMEBOX_VIEW` (deliberately absent here) gates.
    PERMISSION.ITERATION_VIEW,
    // §5 Editor rows: Quality Defects View = Assigned Teams and Team Status View =
    // the Editor's own teams' hours — both are Editor surfaces (the nav shows them,
    // gated on work_item:view), and without these codes every Editor 403'd the whole
    // Quality surface and Team Status (P4-RBAC-006). Edit/write still flows through
    // work_item:* + quality's own write path.
    PERMISSION.QUALITY_VIEW,
    PERMISSION.TEAM_STATUS_VIEW,
    // Editor is delivery-only and Team-scoped. Per the 3-level access matrix (§5),
    // Portfolio Items, Capacity Planning, Reports and — per §3.2 — `Plan > Timeboxes`
    // (Iterations, Releases and Milestones alike) are admin surfaces the Editor does NOT
    // see; only Admin and WA do. (assertTeamScoped enforces the Team boundary on the
    // delivery CRUD below.)
    //
    // Test Cases are the same class of delivery artifact as the Story/Defect/Task above,
    // and the SRS gives the tab no role restriction — all eight granted (Phase 7 plan §4,
    // a deliberate choice, not an omission). `assertTeamInScope` on the parent Work Item
    // still applies (D7): a Test Case is reachable exactly when its Work Item is.
    PERMISSION.TEST_CASE_VIEW,
    PERMISSION.TEST_CASE_CREATE,
    PERMISSION.TEST_CASE_EDIT,
    PERMISSION.TEST_CASE_DELETE,
    PERMISSION.TEST_RESULT_VIEW,
    PERMISSION.TEST_RESULT_CREATE,
    PERMISSION.TEST_RESULT_EDIT,
    PERMISSION.TEST_RESULT_DELETE,
  ],
};

/**
 * Per-Project ACCESS LEVELS. Carried on `work.project_members.access_level`; no active row = No
 * Access, which is the only level with no name because it is the absence of a grant.
 *
 * admin  = full delivery administration in one Project. NOT structural authority: creating,
 *          renaming, archiving or deleting a Project, linking Teams to it and assigning access
 *          are Workspace Admin's alone (SRS §3.1 marks every one of those rows Hidden for Admin).
 *          Project CONFIGURATION that shapes delivery — labels, workflow statuses and transitions
 *          — stays here, because §3.1's own summary is that "`Admin` is powerful for delivery
 *          management".
 * editor = team-scoped delivery contributor. Writes are additionally narrowed to the Teams the
 *          user is assigned to (`AccessService.assertTeamScoped`).
 *
 * THERE IS NO `viewer`, AND THAT IS A DECISION, NOT AN OMISSION.
 * ------------------------------------------------------------
 * The BA removed the level (`product-docs` `55e7dbb`, 2026-08-14). It was restored by architect
 * ruling the same day and REMOVED AGAIN on the BA's instruction — migrations 0113 then 0115. The
 * three-level model is the BA's and it stands.
 *
 * The disagreement is recorded because it will come up again, and because the next person to read
 * Rally's docs will reach for it. Real Rally's `ProjectPermission.Role` is No Access / Viewer /
 * Editor / Project Admin, and its Viewer is load-bearing five ways: the documented answer to "make
 * this user read-only", the PROVISIONING DEFAULT for a new user, one of four Quick Filter Toggles on
 * the admin permission grid, the demotion target in the team-membership state machine, and a
 * full-licence consumer whose only purpose is access control. So with `admin`/`editor`/absent alone,
 * a read-only stakeholder or auditor is either invisible or a full Editor. If that turns out to be a
 * problem in practice, the fix is a new ruling — not a quiet re-add, because the CHECK constraint,
 * this map, the DTO enums, the SPA's mirror and the generated client all have to move together.
 *
 * Sourced evidence: `09_Gap_Audit/research/RALLY_PERMISSIONS_MODEL.md`. Divergence recorded in
 * `CLAUDE.md` → "Declared divergences from the BA, in the access model".
 *
 * Both levels DERIVE from the tier sets above so they cannot drift from them.
 */
export const PROJECT_ACCESS_LEVEL = ['admin', 'editor'] as const;
export type ProjectAccessLevel = (typeof PROJECT_ACCESS_LEVEL)[number];

export const ACCESS_LEVEL_PERMISSIONS: Record<ProjectAccessLevel, readonly Permission[]> = {
  admin: ROLE_PERMISSIONS[SYSTEM_ROLE.PROJECT_ADMIN],
  editor: ROLE_PERMISSIONS[SYSTEM_ROLE.PROJECT_MEMBER],
};

/**
 * Is this value one of the per-Project access levels?
 *
 * A guard rather than an inline comparison, and worth keeping even though the set is two values
 * again. `AccessService` filtered its synthesized assignments with `x === 'admin' || x === 'editor'`
 * in two places, so ADDING a level left both silently ignoring it — a granted row that reads as No
 * Access, which is the failure direction nobody notices until someone cannot see a project they were
 * given. That is exactly what happened when a third level was briefly added, and the guard is what
 * makes the next attempt safe.
 */
export function isProjectAccessLevel(value: unknown): value is ProjectAccessLevel {
  return typeof value === 'string' && (PROJECT_ACCESS_LEVEL as readonly string[]).includes(value);
}

/** Human-readable role names for the seed / admin UI. */
export const ROLE_NAMES: Record<SystemRoleSlug, string> = {
  [SYSTEM_ROLE.WORKSPACE_ADMIN]: 'Workspace Admin',
  [SYSTEM_ROLE.PROJECT_ADMIN]: 'Project Admin',
  [SYSTEM_ROLE.PROJECT_MEMBER]: 'Project Member',
};

/**
 * PRESET FUNCTIONAL roles — seeded PER WORKSPACE as ordinary, EDITABLE custom
 * roles (`isSystem: false`, `workspaceId` set), NOT part of the enforcement
 * backbone above.
 *
 * Why they exist: the five SYSTEM roles are capability TIERS (viewer ⊆ member ⊆
 * admin) — the drift-proof authorization ladder. Real teams, however, think in
 * JOB FUNCTIONS. The BA role model (mini_rally_usecase_role_mapping) enumerates
 * Scrum Master / Product Owner / Developer / QA, so every workspace is seeded
 * with matching ready-to-assign roles. Because they are plain custom roles they:
 *   - appear in Settings → Roles & Permissions as EDITABLE rows (admins tune them),
 *   - carry ONLY concrete project-tier permissions (no wildcards) — deny-by-default,
 *   - never affect the tier ladder or any guard's fast-path.
 *
 * Each permission set is derived directly from the BA use-case matrix and obeys
 * the catalogue's "manage/edit implies view" invariant. Workspace Admin, PM and
 * Viewer are intentionally omitted — they map 1:1 onto the existing system tiers
 * (`workspace_admin`, `project_admin`, `project_viewer`).
 *
 * Slugs are globally unique (matching the `uq_system_roles_slug` constraint) and
 * seeded with onConflictDoNothing, so they are created once and never clobber a
 * workspace admin's later edits.
 */
export type PresetWorkspaceRole = {
  slug: string;
  name: string;
  description: string;
  permissions: Permission[];
};

/**
 * No preset persona roles in the Phase 4.2 baseline. The BA reconciliation
 * removed Scrum Master / Product Owner / Developer / QA (and Viewer) — the
 * product ships exactly three canonical roles (workspace_admin, project_admin,
 * project_member). Custom roles can still be authored per workspace later; this
 * list stays empty so nothing is seeded by default.
 */
export const PRESET_WORKSPACE_ROLES: readonly PresetWorkspaceRole[] = [];
