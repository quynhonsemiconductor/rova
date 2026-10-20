import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import {
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
  UnitOfWork,
  AuditProducer,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
} from '@platform';
import {
  SYSTEM_ROLE,
  permissionGrants,
  isProjectAccessLevel,
  ACCESS_LEVEL_PERMISSIONS,
  type ProjectPermission,
  type ProjectAccessLevel,
} from '@shared-kernel';
import type { JwtPayload, DrizzleDB, DbExecutor, DrizzleTx } from '@platform';
import { InjectDrizzle } from '@platform';
import { and, eq } from 'drizzle-orm';
import { projectMembers, projectTeams, teamMembers } from '../../../../../db/schema/work';
import { workspaceMembers } from '../../../../../db/schema/workspace';
import type { ScopeType } from '../domain/access.types';
import { IRoleRepository, ROLE_REPOSITORY } from '../domain/ports/role.repository';
import {
  IRoleAssignmentRepository,
  ROLE_ASSIGNMENT_REPOSITORY,
} from '../domain/ports/role-assignment.repository';
import {
  IProjectAccessRepository,
  PROJECT_ACCESS_REPOSITORY,
} from '../domain/ports/project-access.repository';
import type { ProjectAccessGrant } from '../domain/project-access';
import type { SystemRole, UserRoleAssignment } from '../domain/access.types';

/**
 * WHICH rows a caller may see in one project — the ceiling every list, report, search and picker
 * narrows by (BA ruling 2026-08-17), produced by {@link AccessService.resolveTeamScope}.
 *
 * Exported from here because four modules were each deriving or re-declaring it locally within a day
 * of the rule landing, and four copies of one decision table is the drift the rule exists to prevent.
 *
 * `unrestricted: true` is All Teams AND the Project Backlog. An empty `teamIds` is a REAL answer —
 * no delivery scope, therefore no rows — and must never be read as "no filter"; that is the same
 * `null`-versus-`[]` distinction {@link AccessService.listReadableProjectIds} documents.
 */
export type TeamReadScope = { unrestricted: true } | { unrestricted: false; teamIds: string[] };

/** The one shape every per-Project grant journey passes to {@link AccessService.grantProjectAccess}. */
export interface GrantProjectAccessInput {
  workspaceId: string;
  projectId: string;
  userId: string;
  /** Omitted lands a NULL level — "a member, no level yet" — never a defaulted one. */
  accessLevel?: ProjectAccessLevel;
  actorId: string;
  /** No default: every caller decides. See {@link AccessService.grantProjectAccess}. */
  onWorkspaceAdmin: 'refuse' | 'skip';
}

@Injectable()
export class AccessService {
  private readonly logger = new Logger(AccessService.name);

  constructor(
    @Inject(ROLE_REPOSITORY) private readonly roleRepo: IRoleRepository,
    @Inject(ROLE_ASSIGNMENT_REPOSITORY)
    private readonly assignmentRepo: IRoleAssignmentRepository,
    @Inject(PROJECT_ACCESS_REPOSITORY)
    private readonly projectAccessRepo: IProjectAccessRepository,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditProducer,
    private readonly cache: CacheService,
    // Read-only, for `listReadableProjectIds`: project membership is the roster
    // equivalent of the agile ALM tool's ProjectPermission and has no repository port of its own.
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  // ── Effective-assignment resolution (the one read every check goes through) ──

  private static readonly ASSIGNMENTS_TTL_SECONDS = 300;

  private assignmentsKey(workspaceId: string, userId: string): string {
    return `authz:assign:${workspaceId}:${userId}`;
  }

  /**
   * Every authorization decision in rova reduces to this one read: the user's
   * role assignments in a workspace, each with its permission codes. Baseline
   * (global + workspace) and per-project sets are then filtered out of it in
   * memory, so one cached read serves both tiers.
   *
   * Cached in Valkey for 5 minutes under a per-(workspace, user) key, which the
   * write paths delete explicitly — so a role change lands on the user's NEXT
   * request, on every replica, rather than when their token happens to rotate.
   * The TTL is only the backstop for a missed invalidation.
   *
   * Fails OPEN to the database, not to deny: a cache outage must degrade
   * latency, not authorization. A read error means every check does the join it
   * used to do before this cache existed.
   */
  private async effectiveAssignments(
    workspaceId: string,
    userId: string,
  ): Promise<
    Array<{
      scopeType: ScopeType;
      scopeId: string | null;
      roleSlug: string | null;
      permissions: string[];
    }>
  > {
    const key = this.assignmentsKey(workspaceId, userId);
    try {
      const cached = await this.cache.getJson<
        Array<{
          scopeType: ScopeType;
          scopeId: string | null;
          roleSlug: string | null;
          permissions: string[];
        }>
      >(key);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(
        { err, userId },
        'Effective-assignment cache read failed; using the database',
      );
    }

    const rows = await this.assignmentRepo.listEffectiveForUser(workspaceId, userId);

    // RBAC migration Phase 3 — synthesize project-scoped assignments from the
    // per-Project access_level (the new model on work.project_members). The
    // legacy scopeType='project' rows from listEffectiveForUser still appear too
    // (safety net until Phase 10 deletes them); they overlap during the
    // transition, which is consistent and never over-grants because the Phase 1
    // backfill mapped slugs to the same permission sets.
    // The workspace-member row gates the synthesis too: a suspended/removed
    // company member must lose ALL project delivery access on their next request
    // (§8), not just the workspace-granted baseline — gating only
    // listEffectiveForUser left admin/editor levels fully live indefinitely.
    const accessRows = await this.db
      .select({
        projectId: projectMembers.projectId,
        accessLevel: projectMembers.accessLevel,
      })
      .from(projectMembers)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, projectMembers.workspaceId),
          eq(workspaceMembers.userId, projectMembers.userId),
          eq(workspaceMembers.status, 'active'),
        ),
      )
      .where(
        and(
          eq(projectMembers.workspaceId, workspaceId),
          eq(projectMembers.userId, userId),
          eq(projectMembers.status, 'active'),
        ),
      );
    const synthesized: Array<{
      scopeType: ScopeType;
      scopeId: string;
      roleSlug: string | null;
      permissions: string[];
    }> = accessRows
      // Against the catalogue, not a hand-written pair: `viewer` was invisible here for the whole
      // time it existed as a CHECK value, so a viewer row synthesized nothing and read as No Access.
      .filter((r) => isProjectAccessLevel(r.accessLevel))
      .map((r) => ({
        scopeType: 'project',
        scopeId: r.projectId,
        roleSlug: r.accessLevel,
        permissions: [...ACCESS_LEVEL_PERMISSIONS[r.accessLevel as ProjectAccessLevel]],
      }));
    const all = [...rows, ...synthesized];

    try {
      await this.cache.setJson(key, all, AccessService.ASSIGNMENTS_TTL_SECONDS);
    } catch (err) {
      this.logger.warn({ err, userId }, 'Effective-assignment cache write failed; continuing');
    }
    return all;
  }

  /**
   * Drop a user's cached assignments so their next request re-resolves.
   *
   * Call AFTER the write commits: invalidating first lets a concurrent request
   * repopulate the cache from pre-commit state, which is the staleness this
   * exists to remove. Never throws — the write already succeeded, and the TTL
   * bounds the damage of a failed delete.
   */
  async invalidateUser(workspaceId: string, userId: string): Promise<void> {
    try {
      await this.cache.del(this.assignmentsKey(workspaceId, userId));
    } catch (err) {
      this.logger.error(
        { err, userId, workspaceId },
        'Failed to invalidate cached permissions; the change takes effect within the cache TTL',
      );
    }
  }

  /** Fan-out invalidation — e.g. a team roster edit changes several members' levels at once. */
  async invalidateUsers(workspaceId: string, userIds: readonly string[]): Promise<void> {
    await Promise.all([...new Set(userIds)].map((id) => this.invalidateUser(workspaceId, id)));
  }

  // ── Roles — READ ONLY ─────────────────────────────────────────────────────
  //
  // CUSTOM ROLES AND THE EDITABLE PERMISSION MATRIX WERE DELETED BY RULING
  // (2026-08-14). `createRole`, `updateRolePermissions`, `deleteRole`,
  // `getPermissionCatalog` and `assignRole` used to live here, behind
  // `POST /roles`, `PATCH /roles/:roleId/permissions`, `DELETE /roles/:roleId`,
  // `GET /permissions` and `POST /role-assignments`. Do not restore them.
  //
  // Three reasons, in the order they decide it:
  //
  //   1. AC-11 makes the Permission Model READ-ONLY — "no editable matrix". The
  //      UI that edited it was already dead code when this was removed
  //      (`role-editor-dialog.tsx` was unreferenced, and its capability model in
  //      `pages/settings/model/role-capabilities.ts` had no live consumer), so
  //      the writers were reachable only from a URL.
  //   2. `db/permissions.catalog.ts` is the SINGLE SOURCE OF TRUTH for permission
  //      codes and role→permission mappings, and a per-workspace editable matrix
  //      forks it. Nothing then reconciles the fork: `db/seeds/bootstrap.ts`
  //      upserts tier roles with `set: { name }` precisely so it cannot clobber
  //      an edit, which is also why a catalogue addition needs a backfill
  //      migration to reach an existing workspace.
  //   3. Custom-role CRUD plus workspace-scoped tier-role assignment together
  //      re-created the company-wide over-grant migration 0111 removed: a role
  //      holding any project-tier code, assigned at `scope_type='workspace'`,
  //      is that code granted in EVERY project at once. `assignRole` already
  //      refused `scope_type='project'` for a related reason; the workspace
  //      scope was the wider hole of the two.
  //
  // What deliberately REMAINS:
  //   • `listRoles` / `findRole` — the read-only Permission Model tab, the audit
  //     log's role-name lookup and `WorkspaceService.acceptInvitation` all read
  //     the catalogue.
  //   • `revokeRole` / `getUserAssignments` — you can no longer GRANT a
  //     workspace-scoped assignment, but you must still be able to see and
  //     REMOVE the ones that already exist. The removal migration is deliberately
  //     deferred (deleting a role a user holds revokes their access), so the rows
  //     are still live; retiring the un-grant path while the grants remain would
  //     be exactly backwards. `pnpm db:report:custom-roles` is the dry-run that
  //     the destructive step is gated on.
  //   • `elevateToWorkspaceAdmin` — writes a workspace-scoped assignment of the
  //     ONE canonical role whose grant is not project-tier, from
  //     `PLATFORM_ADMIN_EMAILS`, with no caller-supplied role id.

  async listRoles(workspaceId: string): Promise<SystemRole[]> {
    return this.roleRepo.listForWorkspace(workspaceId);
  }

  /** One workspace-visible role by id — null when missing or another workspace's. */
  async findRole(workspaceId: string, roleId: string): Promise<SystemRole | null> {
    const role = await this.roleRepo.findById(roleId);
    if (!role || (role.workspaceId !== null && role.workspaceId !== workspaceId)) return null;
    return role;
  }

  // ── Per-Project access grants ─────────────────────────────────────────────

  /**
   * Whether the user's project authority IS the workspace-wide grant (§2.1).
   *
   * Public because two callers legitimately need to SKIP a grant rather than be refused one — see
   * `onWorkspaceAdmin` on {@link grantProjectAccess}. Takes an executor so it can be asked inside
   * a transaction that has just written the user's `workspace_members` row.
   */
  /**
   * Every Workspace Admin in one workspace — the plural of {@link isWorkspaceAdmin}, for a caller that
   * has a LIST to label rather than one user to check.
   *
   * A team roster needs this since the BA made a Workspace Admin an eligible Team member (2026-08-20):
   * the row is badged `Workspace Admin` instead of an access level, and asking per row would be one
   * query per member. Delegates to the same repository method `isWorkspaceAdmin` uses, so there is
   * still one home for "who holds the workspace grant".
   */
  async listWorkspaceAdminIds(workspaceId: string, exec?: DbExecutor): Promise<string[]> {
    return this.projectAccessRepo.listWorkspaceAdminUserIds(workspaceId, exec);
  }

  async isWorkspaceAdmin(workspaceId: string, userId: string, exec?: DbExecutor): Promise<boolean> {
    const admins = await this.projectAccessRepo.listWorkspaceAdminUserIds(workspaceId, exec);
    return admins.includes(userId);
  }

  /**
   * Grant a user per-Project access — the ONE writer of a `work.project_members` grant.
   *
   * It lives here, and not in `ProjectsService` where it used to, because THREE journeys grant
   * project access and §5's closing sentence (AC-9) is that all three update the same source:
   * the Users & Permissions screen, an invitation's initial access (§6.4) and team setup
   * (P4-RBAC-010). `ProjectsModule` imports `WorkspaceModule` — `ProjectsService` resolves
   * `TeamService` and `WORKSPACE_MEMBER_REPOSITORY` from it — so workspace and teams cannot
   * import projects back, and a `forwardRef` cannot help: the failure is a JS module cycle, which
   * surfaces at module-evaluation time (a partially-initialised `@modules/identity` reached
   * through the cycle threw `TypeError: CurrentUser is not a function` when this was attempted the
   * other way round). `AccessModule` imports nothing, so it is the one place every caller can
   * reach.
   *
   * `tx` optional, and absent it opens its own — so the Users & Permissions journey is unchanged
   * while the other two join the transaction they already hold. Every check reads through the
   * SAME executor as the writes: `acceptInvitation` writes the `workspace_members` row in its own
   * transaction moments before granting, and a membership check on `this.db` could not see it,
   * so the grant would be refused with `ASSIGNEE_NOT_WORKSPACE_MEMBER`. Skipping the check for
   * transactional callers was the other option and it is not acceptable — it is what stops a user
   * from another workspace/tenant becoming a project member.
   *
   * CACHE INVALIDATION IS THE CALLER'S when `tx` is supplied, and it must happen AFTER commit:
   * invalidating first lets a concurrent request repopulate from pre-commit state, which is the
   * staleness the cache exists to remove. With no `tx` this method owns the transaction and does
   * it itself.
   *
   * `onWorkspaceAdmin` has no default on purpose — a caller must decide. `refuse` is the
   * Users & Permissions answer: the admin asked for a grant, and a 201 that writes nothing is how
   * a UI comes to show a member who is not there. `skip` is the answer where the grant is a side
   * effect of another action (accepting an invitation, joining a team): a Workspace Admin already
   * has access to every project, so writing nothing is CORRECT there — §2.1 says they are not
   * added as a Project user — while refusing would make the invitation permanently unredeemable
   * or the team uncreatable.
   */
  async grantProjectAccess(
    input: GrantProjectAccessInput & { onWorkspaceAdmin: 'refuse' },
    tx?: DrizzleTx,
  ): Promise<ProjectAccessGrant>;
  async grantProjectAccess(
    input: GrantProjectAccessInput & { onWorkspaceAdmin: 'skip' },
    tx?: DrizzleTx,
  ): Promise<ProjectAccessGrant | null>;
  async grantProjectAccess(
    input: GrantProjectAccessInput,
    // `DrizzleTx`, not `DbExecutor`: `AuditProducer.emit` will only enlist on a real transaction,
    // and every write here emits one. A caller with only a plain connection has no transaction to
    // join, which is the no-`tx` case below.
    tx?: DrizzleTx,
  ): Promise<ProjectAccessGrant | null> {
    const { workspaceId, projectId, userId, accessLevel, actorId, onWorkspaceAdmin } = input;

    // Existence, not writability: access is not the project's content, so the member writes stay
    // open on an ARCHIVED project — revoking or correcting a grant must never require unarchiving.
    if (!(await this.projectAccessRepo.findLiveProject(workspaceId, projectId, tx))) {
      throw new NotFoundException('PROJECT_NOT_FOUND', 'Project not found');
    }

    // A project member must first be an active member of the owning workspace — the same rule
    // enforced for a project's lead (PRJ-FR-006) and a work item's assignee (P1-15). This is what
    // prevents adding a user from another workspace/tenant.
    if (!(await this.projectAccessRepo.isActiveWorkspaceMember(workspaceId, userId, tx))) {
      throw new PreconditionFailedException(
        'ASSIGNEE_NOT_WORKSPACE_MEMBER',
        'The assigned user is not an active member of this workspace',
      );
    }

    // §2.1 — see `onWorkspaceAdmin` above, and `selectWorkspaceAdminUserIds` for the predicate.
    // Enforced here rather than in the SPA's candidate filter (`roleSlug !== 'workspace_admin'`),
    // which is a client-side courtesy, and because `listProjectMembers` HIDES these rows — so a
    // row created through any of these paths would be an invisible grant rather than a visible
    // mistake, live Project Admin the moment the user stops being a Workspace Admin.
    if (await this.isWorkspaceAdmin(workspaceId, userId, tx)) {
      if (onWorkspaceAdmin === 'skip') {
        this.logger.log(
          { projectId, userId },
          'Project access not granted: the user is a Workspace Admin and already has every project (§2.1)',
        );
        return null;
      }
      throw new PreconditionFailedException(
        'PROJECT_MEMBER_IS_WORKSPACE_ADMIN',
        'A Workspace Admin already has access to every project and cannot be added as a project user',
      );
    }

    const existing = await this.projectAccessRepo.findGrant(projectId, userId, tx);

    const write = async (exec: DrizzleTx): Promise<ProjectAccessGrant | 'unchanged'> => {
      if (existing) {
        // UPSERT, not 409: a grant row can legitimately pre-exist with a NULL access_level (rows
        // created before add-with-level, and every "team-derived" roster row — a user on a linked
        // team with no explicit grant). Refusing the POST meant the UI could show the user in the
        // project yet be unable to give them a level. With a level supplied, set it; without one,
        // stay idempotent.
        if (accessLevel === undefined || accessLevel === existing.accessLevel) return 'unchanged';
        const next = await this.projectAccessRepo.setGrantLevel(existing.id, accessLevel, exec);
        await this.audit.emit(
          {
            action: AUDIT_ACTION.PROJECT_MEMBER_UPDATED,
            resourceType: AUDIT_RESOURCE.PROJECT,
            resourceId: projectId,
            workspaceId,
            actor: { id: actorId },
            projectId,
            changes: {
              before: { userId, accessLevel: existing.accessLevel },
              after: { userId, accessLevel },
            },
          },
          exec,
        );
        return next;
      }

      const created = await this.projectAccessRepo.createGrant(
        {
          id: uuidv7(),
          workspaceId,
          projectId,
          userId,
          // Persist the chosen level up front rather than landing a NULL row the caller must
          // immediately PATCH. Repo treats undefined as NULL.
          ...(accessLevel !== undefined && { accessLevel }),
        },
        exec,
      );
      // Access grants are administrative events — a grant of Admin/Editor is at least as
      // sensitive as the team-membership writes that ARE logged. Same tx as the mutation: the
      // outbox row can never diverge from the grant it records.
      await this.audit.emit(
        {
          action: AUDIT_ACTION.PROJECT_MEMBER_ADDED,
          resourceType: AUDIT_RESOURCE.PROJECT,
          resourceId: projectId,
          workspaceId,
          actor: { id: actorId },
          projectId,
          changes: { after: { userId, accessLevel: accessLevel ?? null } },
        },
        exec,
      );
      return created;
    };

    if (tx) {
      // The caller owns the transaction AND the post-commit invalidation (see the docblock).
      const result = await write(tx);
      return result === 'unchanged' ? existing! : result;
    }

    const result = await this.uow.run(write);
    if (result === 'unchanged') return existing!;
    // Invalidate so the level lands on the user's next request rather than at the 5-min cache TTL.
    await this.invalidateUser(workspaceId, userId);
    this.logger.log({ projectId, userId, accessLevel }, 'Project access granted');
    return result;
  }

  // ── Assignments ───────────────────────────────────────────────────────────

  async getUserAssignments(workspaceId: string, userId: string): Promise<UserRoleAssignment[]> {
    return this.assignmentRepo.listForUser(workspaceId, userId);
  }

  /**
   * A workspace-scoped tier-role assignment can no longer be CREATED.
   *
   * `assignRole` lived here and was reachable through `POST /v1/role-assignments`; both were
   * deleted by ruling (2026-08-14). A role holding any project-tier code, assigned at
   * `scope_type='workspace'`, grants that code in EVERY project at once — the company-wide
   * over-grant migration 0111 removed. It already refused `scope_type='project'`
   * (`PROJECT_SCOPE_RETIRED`, migration 0105); the workspace scope was the wider of the two holes.
   *
   * The supported grants are exactly two: `grantProjectAccess` above (per-Project `admin` /
   * `editor` on `work.project_members`) and {@link elevateToWorkspaceAdmin} below (one canonical
   * role, driven by `PLATFORM_ADMIN_EMAILS`, with no caller-supplied role id).
   *
   * {@link revokeRole} deliberately survives — see the Roles section above for why the un-grant
   * path has to outlive the grant path.
   */
  async revokeRole(actor: JwtPayload, assignmentId: string): Promise<void> {
    const assignment = await this.assignmentRepo.findById(assignmentId, actor.workspaceId);
    if (!assignment) {
      throw new NotFoundException('ROLE_ASSIGNMENT_NOT_FOUND', 'Role assignment not found');
    }
    await this.uow.run(async (tx) => {
      await this.assignmentRepo.delete(assignmentId, tx);
      await this.audit.emit(
        {
          action: AUDIT_ACTION.ROLE_REVOKED,
          resourceType: AUDIT_RESOURCE.ROLE_ASSIGNMENT,
          resourceId: assignmentId,
          workspaceId: actor.workspaceId,
          actor: { id: actor.sub },
          ...(assignment.scopeType === 'project' && assignment.scopeId
            ? { projectId: assignment.scopeId }
            : {}),
          changes: {
            before: {
              userId: assignment.userId,
              roleId: assignment.roleId,
              scopeType: assignment.scopeType,
              scopeId: assignment.scopeId,
            },
          },
        },
        tx,
      );
    });
    await this.invalidateUser(assignment.workspaceId, assignment.userId);
    this.logger.log({ assignmentId, revokedBy: actor.sub }, 'Role revoked');
  }

  /** Check if a user has a specific permission in any scope. Used by guards.
   * Wildcard expansion: `workspace:*` matches any `workspace:<action>`.
   * NOTE: assumes 2-segment permission strings (namespace:action). If 3-segment
   * permissions are added in future, expand this to check prefix wildcards at
   * each segment boundary (e.g. `workspace:admin:*` matches `workspace:admin:write`).
   */
  async hasPermission(workspaceId: string, userId: string, permission: string): Promise<boolean> {
    const effective = await this.effectiveAssignments(workspaceId, userId);
    if (!effective.length) return false;

    const [reqNs] = permission.split(':');
    return effective.some(
      (a) => a.permissions.includes(`${reqNs}:*`) || a.permissions.includes(permission),
    );
  }

  /**
   * The user's per-Project access level (RBAC migration Phase 9). Resolved from
   * the synthesized project-scoped entry in effectiveAssignments (roleSlug =
   * 'admin' | 'editor'). null when the user has no project entry
   * (Workspace Admin via workspace:*, or No Access).
   */
  async getProjectAccessLevel(
    workspaceId: string,
    userId: string,
    projectId: string,
  ): Promise<ProjectAccessLevel | null> {
    const eff = await this.effectiveAssignments(workspaceId, userId);
    const entry = eff.find(
      (a) =>
        a.scopeType === 'project' && a.scopeId === projectId && isProjectAccessLevel(a.roleSlug),
    );
    return (entry?.roleSlug as ProjectAccessLevel | undefined) ?? null;
  }

  /**
   * The Teams an EDITOR may work inside, in one project — their active rosters among that project's
   * active team links.
   *
   * REINSTATED BY BA RULING, 2026-08-17 (`GAP-P4-RBAC-003`, Confirmed Fail, P0), which supersedes the
   * 2026-08-14 removal recorded below. §2.2 requires an Editor to hold at least one active Team and to
   * work only inside their assigned Teams; the retest found an Editor with NO team reading another
   * team's Work Item in full and being offered `All Teams`, Pegasus and RTCAP in the selector.
   *
   * The 2026-08-14 objection is still true and is answered rather than ignored — see
   * {@link assertTeamInScope}. Two facts, one query: the roster row must be active AND the team must
   * still be linked to the project, or an unlinked team's roster would keep granting scope inside a
   * project it left (`project_teams` is a soft status flip, so the link row survives).
   */
  async listScopedTeamIds(
    workspaceId: string,
    userId: string,
    projectId: string,
  ): Promise<string[]> {
    const rows = await this.db
      .select({ teamId: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(
        projectTeams,
        and(
          eq(projectTeams.teamId, teamMembers.teamId),
          eq(projectTeams.projectId, projectId),
          eq(projectTeams.status, 'active'),
        ),
      )
      .where(
        and(
          eq(teamMembers.workspaceId, workspaceId),
          eq(teamMembers.userId, userId),
          eq(teamMembers.status, 'active'),
        ),
      );
    return [...new Set(rows.map((r) => r.teamId))];
  }

  /**
   * Refuse a delivery record an EDITOR's Teams do not cover (`GAP-P4-RBAC-003` AC1/AC3).
   *
   * Applies to a per-project `editor` ONLY. A Workspace Admin and a per-project `admin` both hold
   * All Teams by §3.1, so they pass; a caller with no level at all is not this method's business —
   * `assertProjectPermission` is what refuses them, and calling this first would answer the wrong
   * question with the wrong error.
   *
   * `team_id IS NULL` IS THE PROJECT BACKLOG, AND IT IS ADMIN-ONLY (BA ruling, 2026-08-17)
   * -------------------------------------------------------------------------------------
   * The 2026-08-14 removal note below is kept in full because its objection was right: a scope that
   * can only restrict rows CARRYING a team admits the ordinary case, since `work_items.team_id` is
   * nullable and mostly unset. This first shipped answering that by making only the ZERO-TEAM case
   * total, and admitting a team-less row — which left exactly the hole that note described, and it was
   * put to the BA. Their answer closes it without a migration:
   *
   *   "Keep `team_id` nullable. Null means Project Backlog, accessible only to Workspace Admin and
   *    Project Admin. Editor must select one of their assigned Teams when creating a Work Item and
   *    cannot access team-less items. Enforce this consistently in API queries, lists, reports, search,
   *    pickers and direct URLs. No DB migration or backfill is required."
   *
   * So for an `editor` there are now three refusals and no admitted case:
   *
   *   • no active Team in the project at all → `EDITOR_NO_TEAM_SCOPE` (AC1);
   *   • a record owned by another Team → `TEAM_NOT_IN_SCOPE` (AC3);
   *   • a record owned by NO Team → `PROJECT_BACKLOG_ADMIN_ONLY`, a named refusal rather than the
   *     other one, because "this is the Project Backlog" and "this is someone else's Team" are
   *     different facts and the reader can act on only one of them.
   *
   * The nullable column is therefore no longer a gap — it is a THIRD population with its own audience,
   * which is why no `team_id` had to become mandatory. Enforcement is not only here: every list,
   * report, search and picker narrows through {@link resolveTeamScope}, because a boundary the reads
   * do not share is a filter with a security-sounding name, which is what the note below is about.
   */
  async assertTeamInScope(
    workspaceId: string,
    userId: string,
    projectId: string,
    teamId: string | null,
  ): Promise<void> {
    const scope = await this.resolveTeamScope(workspaceId, userId, projectId);
    if (scope.unrestricted) return;

    if (scope.teamIds.length === 0) {
      throw new PermissionDeniedException(
        'EDITOR_NO_TEAM_SCOPE',
        'An Editor must belong to at least one active Team in this project',
      );
    }
    if (teamId === null) {
      throw new PermissionDeniedException(
        'PROJECT_BACKLOG_ADMIN_ONLY',
        'Items with no Team belong to the Project Backlog, which only a Workspace Admin or Project Admin can open',
      );
    }
    if (!scope.teamIds.includes(teamId)) {
      throw new PermissionDeniedException(
        'TEAM_NOT_IN_SCOPE',
        'This record belongs to a Team you are not assigned to',
      );
    }
  }

  /**
   * The team scope every READ must narrow by — the one home of "which rows may this caller see in
   * this project", so a list, a report, a search and a picker cannot disagree with
   * {@link assertTeamInScope} or with each other (BA ruling 2026-08-17: "enforce this consistently in
   * API queries, lists, reports, search, pickers and direct URLs").
   *
   * `unrestricted: true` means All Teams AND the Project Backlog — a Workspace Admin, a per-project
   * `admin`, or a principal with no level at all (whose refusal belongs to
   * `assertProjectPermission`, not here: answering it with an empty team scope would turn a
   * permission failure into an empty grid, which reads as "this project has no work").
   *
   * For an `editor` the answer is their own active Teams, and a caller MUST read it as
   * "`team_id IN (…)`", never "`IN (…) OR IS NULL`". An empty array is a real answer — no delivery
   * scope — and must produce NO rows rather than being flattened into "unrestricted", the same
   * `null`-versus-`[]` distinction `listReadableProjectIds` documents.
   */
  async resolveTeamScope(
    workspaceId: string,
    userId: string,
    projectId: string,
  ): Promise<TeamReadScope> {
    if (await this.isWorkspaceAdmin(workspaceId, userId)) return { unrestricted: true };
    const level = await this.getProjectAccessLevel(workspaceId, userId, projectId);
    if (level !== 'editor') return { unrestricted: true };
    return {
      unrestricted: false,
      teamIds: await this.listScopedTeamIds(workspaceId, userId, projectId),
    };
  }

  /**
   * TEAM SCOPE WAS NOT AN AUTHORIZATION BOUNDARY HERE. DELETED BY RULING, 2026-08-14 — AND
   * REINSTATED, IN THE NARROWER FORM ABOVE, BY THE BA ON 2026-08-17. Kept because its reasoning is
   * what shaped the replacement, and because the next person to widen that scope needs to read it.
   *
   * `assertTeamScoped(actor, projectId, teamId)` used to live at this spot and threw
   * `TEAM_NOT_IN_SCOPE` when an `editor` wrote a work item belonging to a Team they held no
   * `team_members` row for. It was called from exactly three places — `WorkItemsService`'s create,
   * update and delete — and it is gone. **This is a removal, not a regression: do not restore it as
   * a missing feature.**
   *
   * Why it could never be the control it read as:
   *
   *   • A team scope can only restrict rows that CARRY a team, and in this schema
   *     `portfolio_items.team_id` and `work_items.team_id` are both nullable and mostly unset —
   *     195 of 206 local iterations name no team either. The method's own first line was
   *     `if (!teamId) return;`, so the boundary admitted the ordinary case BY DESIGN. A filter
   *     whose default answer is "allow" is a filter with a security-sounding name.
   *   • It covered 3 of roughly 14 Editor-reachable writes and NO reads. That is the worst
   *     available state: enough to read as a boundary in review, nowhere near enough to be one.
   *     Nothing in the suite asserted the refusal either — the only `assertTeamScoped` mentions in
   *     any spec were `vi.fn().mockResolvedValue(undefined)` mocks, so the whole feature was
   *     covered by zero tests for its entire life.
   *   • The real agile ALM tool has no `Team` object and no team authorization scope at all: its
   *     `ProjectPermission` is per (user, project, workspace), and "Team Member" is a
   *     presentational checkbox beside the Permission field that auto-promotes to Editor. That
   *     auto-promotion is what this repo now implements instead — a `team_members` row IMPLIES a
   *     level (`teamRosterAccessLevel` in `../domain/project-access.ts`). A roster row grants; it
   *     does not fence.
   *
   * Teams remain first-class DELIVERY-MODEL data and a display FILTER. Nothing about `teams`,
   * `team_members`, team assignment, Team Status, Team Capacity or the reports' team scoping
   * changed with this, and `getProjectAccessLevel` above is untouched — it has four other callers.
   * The authorization model is: Workspace Admin, per-Project `admin` or `editor`, and No Access as
   * the absence of a `work.project_members` row.
   *
   * This note supersedes the "Team-scoped Editor is KEPT, against the real agile ALM tool" divergence that
   * CLAUDE.md recorded up to this date.
   */

  /**
   * Resolve the primary role + effective permissions for a user.
   * Workspace-scoped assignments take precedence over workspace/project scope.
   * Falls back to 'workspace_member' defaults when the user has no assignments.
   */
  /**
   * Ensures a JIT-provisioned user has at least the default workspace role.
   * Called after SSO creates a new user — no actor needed (system operation).
   * Idempotent: does nothing if the user already has an assignment.
   */
  ensureDefaultRole(
    _userId: string,
    _workspaceId: string,
    _defaultRoleSlug: string = SYSTEM_ROLE.PROJECT_MEMBER,
  ): Promise<void> {
    // RBAC migration Phase 4: a JIT-provisioned (first SSO sign-in) user lands
    // with ZERO project access — no automatic workspace-scoped role, because
    // that would grant project delivery access company-wide. The user is still
    // an authenticated company member (workspace_members row from SSO) and can
    // sign in; the shell renders from the `/bff/me` profile and `memberships`,
    // neither of which needs a permission. They hold NOTHING else until
    // Workspace Admin grants a per-Project access_level — that is the BA's
    // implicit No Access, and it is why `getUserRoleAndPermissions` returns an
    // empty permission array rather than a `workspace:view` floor. No-op until a
    // non-project default role exists.
    return Promise.resolve();
  }

  /**
   * Forcibly assigns workspace_admin to a PLATFORM_ADMIN_EMAILS user.
   * Replaces any existing role assignment for the user in this workspace.
   * Idempotent: skips if workspace_admin is already assigned.
   */
  async elevateToWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
    const roles = await this.roleRepo.listForWorkspace(workspaceId);
    const adminRole = roles.find((r) => r.slug === SYSTEM_ROLE.WORKSPACE_ADMIN);
    if (!adminRole) {
      this.logger.warn({ userId, workspaceId }, 'workspace_admin role not found — cannot elevate');
      return false;
    }

    const existing = await this.assignmentRepo.listForUser(workspaceId, userId);
    const alreadyAdmin = existing.some((a) => a.roleId === adminRole.id);
    if (alreadyAdmin) return false;

    // Revoke workspace-scoped assignments only — preserve project-level roles.
    // workspace_admin has workspace:* so it supersedes them functionally,
    // but keeping project assignments means a manual downgrade restores them.
    for (const assignment of existing.filter((a) => a.scopeType === 'workspace')) {
      await this.assignmentRepo.delete(assignment.id);
    }

    await this.assignmentRepo.create({
      id: uuidv7(),
      workspaceId,
      userId,
      roleId: adminRole.id,
      scopeType: 'workspace',
      scopeId: undefined,
      grantedBy: userId,
    });
    await this.invalidateUser(workspaceId, userId);
    this.logger.log({ userId }, 'User elevated to workspace_admin via PLATFORM_ADMIN_EMAILS');
    return true;
  }

  /**
   * The user's BASELINE permissions — the union of every global- and
   * workspace-scoped role they hold in this workspace. This is what gets embedded
   * in the JWT: it's workspace-wide and stable for the token's lifetime.
   *
   * Project-scoped assignments are deliberately NOT included here — they're
   * resolved per-request by getProjectPermissions() so the token stays small
   * and per-project grants take effect immediately (no wait for token expiry).
   *
   * `role` is the single most-representative role slug (highest baseline scope),
   * kept for display / audit; authorization decisions use `permissions`.
   */
  /**
   * The user's workspace-tier permissions, resolved (and cached) from the
   * database. This is what `PolicyGuard` checks a workspace-tier code against,
   * and what an escalation check judges an actor by.
   *
   * Deliberately a thin projection of {@link getUserRoleAndPermissions} rather
   * than a second resolution path — two ways to compute a baseline is exactly how
   * a guard and a UI end up disagreeing about what a user can do.
   */
  async getWorkspacePermissions(userId: string, workspaceId: string): Promise<string[]> {
    const { permissions } = await this.getUserRoleAndPermissions(userId, workspaceId);
    return permissions;
  }

  async getUserRoleAndPermissions(
    userId: string,
    workspaceId: string,
  ): Promise<{ role: string; permissions: string[] }> {
    const effective = await this.effectiveAssignments(workspaceId, userId);
    const baseline = effective.filter(
      (a) => a.scopeType === 'global' || a.scopeType === 'workspace',
    );

    if (!baseline.length) {
      // No workspace/global assignment means NO workspace-tier permission. Not one, not a
      // "minimal" one.
      //
      // This used to return `[PERMISSION.WORKSPACE_VIEW]` as a floor "so the app shell +
      // workspace read work". Two things made that untenable:
      //
      //   1. Migration 0111 deleted the workspace-scoped tier assignments, so EVERY normal user
      //      — per-Project Admin, Editor and No Access alike — now lands in this branch. The
      //      floor stopped being an edge case and became the baseline for the whole company.
      //   2. `workspace:view` is not a harmless code. It gates `GET /workspaces/:id/settings`
      //      (timezone, locale, working days) and the two SCM inventory routes
      //      (`scm/installations`, `scm/repositories`) — all three admin-only surfaces, and the
      //      settings read was given that decorator specifically to close this hole. Granting it
      //      here re-opened it from the other side, to a principal with no access to anything.
      //
      // The app shell does not need it: the workspace name it renders comes from `memberships`
      // on the `/bff/me` payload, and `workspaceDefaults` is already `.catch(() => null)` at the
      // call site. Delivery access is per-Project via `work.project_members.access_level`, read
      // through `getProjectPermissions` — which unions this baseline, so an empty one subtracts
      // nothing a project grant confers.
      //
      // Pinned by `test/e2e/project-authz.e2e.spec.ts`, both directions.
      return { role: '', permissions: [] };
    }

    const permissions = [...new Set(baseline.flatMap((a) => a.permissions))];

    // Representative role: prefer a global assignment, else the first workspace one.
    const primary = baseline.find((a) => a.scopeType === 'global') ?? baseline[0];

    return {
      role: primary.roleSlug ?? '',
      permissions,
    };
  }

  /**
   * Effective permissions for a specific PROJECT: the user's workspace-wide
   * baseline (global + workspace) unioned with any role they hold that is
   * scoped to exactly this project. Used by the PolicyGuard at request time so
   * "admin of Project X, editor of Project Y" is actually enforced.
   */
  async getProjectPermissions(
    userId: string,
    workspaceId: string,
    projectId: string,
  ): Promise<string[]> {
    const effective = await this.effectiveAssignments(workspaceId, userId);
    const relevant = effective.filter(
      (a) =>
        a.scopeType === 'global' ||
        a.scopeType === 'workspace' ||
        (a.scopeType === 'project' && a.scopeId === projectId),
    );

    return [...new Set(relevant.flatMap((a) => a.permissions))];
  }

  /**
   * Project ids the user may READ in this workspace.
   *
   * The authorization fact behind every CROSS-PROJECT list. It belongs here, not in a
   * feature repository, because more than one surface needs it (portfolio items now,
   * capacity plans next) and because getting it wrong leaks another project's data.
   *
   * Mirrors the agile ALM tool, where access to an artifact follows from permission on its PROJECT
   * rather than from any per-artifact grant: the agile ALM tool stores one `ProjectPermission` row
   * per (user, project, workspace) and a Viewer sees everything in that project.
   *
   * Two sources, unioned:
   *   1. a workspace-wide grant (`workspace:*` or an explicit workspace-tier `:view`)
   *      sees every project — the agile ALM tool's Workspace Admin;
   *   2. project-scoped assignments that GRANT `permission` — which covers per-project
   *      membership too, because {@link effectiveAssignments} synthesizes a project-scoped
   *      entry from every active `project_members` row using `ACCESS_LEVEL_PERMISSIONS`.
   *
   * Returns `null` to mean UNRESTRICTED, deliberately: an empty array is a legitimate
   * answer ("no projects"), so a sentinel is needed to distinguish it from "all". A
   * caller that treats `null` as empty fails closed, which is the safe direction.
   *
   * THE `permission` ARGUMENT IS THE POINT, AND A THIRD SOURCE USED TO IGNORE IT.
   * ---------------------------------------------------------------------------
   * A raw `project_members` query sat below, unioned in unconditionally: every project the
   * caller held an active row for became readable REGARDLESS of whether that row's access
   * level granted the permission being asked about. It was written when membership was the
   * only per-project fact, and it survived the move to `access_level` — by which point
   * `effectiveAssignments` was already synthesizing the same rows, correctly filtered. So
   * for a permission the level DOES grant it was pure duplication (hence the union's
   * de-duplication), and for one it does NOT it was a silent over-grant that could not be
   * seen from any call site: the argument was passed, looked authoritative, and decided
   * nothing.
   *
   * What it actually opened: `PortfolioItemsService.listItems` asks for `portfolio:view`, a
   * code the `editor` level deliberately withholds (§3.2 marks Portfolio Items Hidden for
   * an Editor). Every project Editor therefore read every field of every Epic and Feature
   * in each of their projects — the one surface the access matrix hides from them. No other
   * caller was affected, because the rest ask for `project:view` or `work_item:view`, which
   * `editor` holds; that is exactly why this stayed invisible.
   *
   * The lesson generalises past this method: a boundary that takes a permission and then
   * unions in a source not filtered by it is not a boundary, and it reads like one in
   * review. Any new source added here MUST be filtered by `permissionGrants`.
   */
  async listReadableProjectIds(
    workspaceId: string,
    userId: string,
    permission: ProjectPermission,
  ): Promise<string[] | null> {
    const effective = await this.effectiveAssignments(workspaceId, userId);

    // Workspace-wide grant → every project. Wildcards honoured the same way the guard
    // honours them, so `workspace:*` behaves consistently in both places.
    const workspaceWide = effective.some(
      (a) =>
        (a.scopeType === 'global' || a.scopeType === 'workspace') &&
        permissionGrants(a.permissions, permission),
    );
    if (workspaceWide) return null;

    const fromAssignments = effective
      .filter(
        (a) =>
          a.scopeType === 'project' &&
          a.scopeId !== null &&
          permissionGrants(a.permissions, permission),
      )
      .map((a) => a.scopeId as string);

    // Membership needs no query of its own: the synthesis above already turned every
    // active `project_members` row into a project-scoped assignment, under the same two
    // conditions the deleted query re-implemented by hand — an active workspace member
    // row, and a level `isProjectAccessLevel` recognises (stricter than the old
    // `isNotNull`, which admitted a level the catalogue does not know). One writer of that
    // rule, so a picker and the guard can no longer disagree about one row.
    //
    // One second-order consequence, deliberate: the deleted query was an uncached live read,
    // while the synthesis rides `effectiveAssignments`' 5-minute cache. So a membership row
    // written OUTSIDE `AccessService` — raw SQL, a seed, a fixture — is invisible to every
    // cross-project list until the TTL expires. Every real writer goes through
    // `grantProjectAccess`, which invalidates; a test that inserts directly must call
    // `invalidateUser` rather than expect a live read.
    return [...new Set(fromAssignments)];
  }

  /**
   * Service-layer per-project check, kept for the few authorizations a
   * route-scoped guard cannot express: a project id known only after loading a
   * resource, a multi-project batch, or a secondary target. Throws
   * PermissionDeniedException (403) when the caller lacks `required` for
   * `projectId`. Wildcards are honoured.
   *
   * Guard-based routes (project id resolvable from the request) use
   * @RequirePermission + PolicyGuard instead — don't double-check.
   */
  async assertProjectPermission(
    user: JwtPayload,
    projectId: string,
    required: ProjectPermission,
  ): Promise<void> {
    if (await this.hasProjectPermission(user, projectId, required)) return;

    throw new PermissionDeniedException(
      'PROJECT_PERMISSION_DENIED',
      'You do not have permission to perform this action on this project',
    );
  }

  /**
   * The same check as `assertProjectPermission`, as a QUESTION rather than a demand.
   *
   * Some rules branch on a permission instead of refusing without it: a capacity plan in Draft is
   * hidden from a reader who cannot plan, which means the list has to ASK whether this caller is a
   * planner and filter — throwing there would deny the whole list over one row.
   *
   * Deliberately not a second implementation: catching the exception from the assert would work and
   * would also make an ordinary branch look like an error path in every log and trace.
   */
  async hasProjectPermission(
    user: JwtPayload,
    projectId: string,
    required: ProjectPermission,
  ): Promise<boolean> {
    // No token fast path: `getProjectPermissions` already unions the workspace
    // baseline, and it reads through the cache, so the old shortcut only added a
    // way to answer from a stale snapshot.
    const effective = await this.getProjectPermissions(user.sub, user.workspaceId, projectId);
    return permissionGrants(effective, required);
  }

  /** Wildcard-aware membership check: workspace:* / ns:* / exact match. */
}
