import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import {
  NotFoundException,
  ConflictException,
  PreconditionFailedException,
  PermissionDeniedException,
  UnitOfWork,
  InjectDrizzle,
  AuditProducer,
  AUDIT_ACTION,
  AUDIT_RESOURCE,
} from '@platform';
import type { JwtPayload, CursorPayload, PagedResult, DrizzleDB } from '@platform';
import { and, eq } from 'drizzle-orm';
import { capacityPlanTeams, capacityPlans, projectSettings } from '../../../../../db/schema/work';
import { IProjectRepository, PROJECT_REPOSITORY } from '../domain/ports/project.repository';
import {
  IWorkflowStatusRepository,
  WORKFLOW_STATUS_REPOSITORY,
} from '../domain/ports/workflow-status.repository';
import { ILabelRepository, LABEL_REPOSITORY } from '../domain/ports/label.repository';
import {
  IProjectTeamRepository,
  PROJECT_TEAM_REPOSITORY,
} from '../domain/ports/project-team.repository';
import {
  IProjectMemberRepository,
  PROJECT_MEMBER_REPOSITORY,
} from '../domain/ports/project-member.repository';
import {
  IWorkspaceMemberRepository,
  WORKSPACE_MEMBER_REPOSITORY,
  TeamService,
} from '@modules/workspace';
import type {
  Project,
  ProjectWithStats,
  ProjectHealth,
  WorkflowStatus,
  WorkflowTransition,
  ProjectTeamLink,
  ProjectMember,
  CreateProjectRequest,
  UpdateProjectInput,
  CreateWorkflowStatusInput,
  CreateWorkflowTransitionInput,
  UpdateProjectMemberInput,
  ProjectEstimationSettings,
} from '../domain/project.types';
import type { ProjectAccessLevel } from '@shared-kernel';
import { AccessService, assertTeamAssignmentForLevel, grantsAllTeams } from '@modules/access';
import {
  DEFAULT_WORKFLOW_STATUSES,
  DEFAULT_TEST_CASE_TYPE_NAMES,
} from '../domain/project.constants';
// Deep-import (see `projects.module.ts`'s own comment for why): `TestCasesModule` already
// imports `ProjectsModule`, so a service-level dependency the other way would close a cycle.
import type { ITestCaseTypeRepository } from '@modules/test-cases/domain/ports/test-case-type.repository';
import { TEST_CASE_TYPE_REPOSITORY } from '@modules/test-cases/domain/ports/test-case-type.repository';
import type { Label } from '../domain/label.types';
import type { WorkItemType } from '../domain/ports/project.repository';
import { ActivityLogger, type ActivityLog } from '@modules/activity';
import { PROJECT_ACTIVITY_CONFIG } from './project-activity-diff';

// Declared in the domain because `CreateProjectRequest` carries it; re-exported here because
// the controller and other modules import it from the service.
export type { ProjectEstimationSettings };

/**
 * The values a project starts with, and the read-side fallback.
 *
 * Mirrors the column DEFAULTs in migration 0106 AND the points in
 * `DEFAULT_PRELIMINARY_ESTIMATE_MAP` — the three must stay in step or "M" means a different
 * number on the settings form, the progress bar and the capacity plan.
 *
 * Since migration 0117 every project HAS a `project_settings` row: `createProject` writes one
 * in its own transaction, and a trigger writes one for the raw-SQL writers that bypass the
 * service (`db/seeds/**` inserts `work.projects` directly, the same reason
 * `trg_task_iteration_from_parent` and `timebox_group_id` are triggers). The fallback in
 * `getEstimationSettings` therefore stops being load-bearing, but it stays: it is what the
 * method's contract promises, and a read must not 500 on a row a future writer has not created
 * yet.
 */
const DEFAULT_PROJECT_ESTIMATION_SETTINGS: ProjectEstimationSettings = {
  xsPoints: 1,
  sPoints: 3,
  mPoints: 5,
  lPoints: 8,
  xlPoints: 13,
  hoursPerPoint: 8,
};

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projectRepo: IProjectRepository,
    @Inject(WORKFLOW_STATUS_REPOSITORY) private readonly statusRepo: IWorkflowStatusRepository,
    @Inject(LABEL_REPOSITORY) private readonly labelRepo: ILabelRepository,
    @Inject(PROJECT_TEAM_REPOSITORY) private readonly projectTeamRepo: IProjectTeamRepository,
    @Inject(PROJECT_MEMBER_REPOSITORY) private readonly projectMemberRepo: IProjectMemberRepository,
    @Inject(WORKSPACE_MEMBER_REPOSITORY)
    private readonly workspaceMemberRepo: IWorkspaceMemberRepository,
    @Inject(TEST_CASE_TYPE_REPOSITORY)
    private readonly testCaseTypeRepo: ITestCaseTypeRepository,
    private readonly teamService: TeamService,
    private readonly uow: UnitOfWork,
    private readonly audit: AuditProducer,
    private readonly activity: ActivityLogger,
    private readonly access: AccessService,
    @InjectDrizzle() private readonly db: DrizzleDB,
  ) {}

  // ── Revision History (activity log) ─────────────────────────────────────────

  /** Newest-first revision history for one project (workspace-view gated). */
  async getProjectActivity(
    actor: JwtPayload,
    projectId: string,
    args: { limit: number; offset: number },
  ): Promise<{ items: ActivityLog[]; total: number }> {
    await this.getProject(actor.workspaceId, projectId);
    const page = Math.floor(args.offset / args.limit) + 1;
    const res = await this.activity.listFor(projectId, actor.workspaceId, page, args.limit);
    return { items: res.data, total: res.total };
  }

  private projectSubject(p: Project) {
    return {
      workspaceId: p.workspaceId,
      projectId: p.id,
      entityType: 'project' as const,
      entityId: p.id,
    };
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  async listProjects(
    actor: JwtPayload,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<ProjectWithStats>> {
    /**
     * Only the projects this caller may READ.
     *
     * The query filtered on `workspace_id` + `deleted_at IS NULL` and nothing else, and the route
     * carried no `@RequirePermission` — so every project's key, name, description, owner, dates and
     * counts was readable by any authenticated principal, including one with zero role assignments.
     * PRJ-FR-001 says "List chỉ project user được phép truy cập trong workspace hiện tại", and §10 is
     * explicit that workspace membership alone does not confer project visibility.
     *
     * `listReadableProjectIds` is the primitive built for exactly this — its own docblock calls it "the
     * authorization fact behind every CROSS-PROJECT list" and Portfolio already uses it. `null` means
     * UNRESTRICTED (a workspace-wide grant, i.e. Workspace Admin); an empty array is a legitimate
     * "no projects" and must not be confused with it, which is why the sentinel exists.
     */
    const readable = await this.access.listReadableProjectIds(
      actor.workspaceId,
      actor.sub,
      'project:view',
    );
    return this.projectRepo.listByWorkspaceWithStats(actor.workspaceId, args, readable);
  }

  /**
   * Home "Project Health" widget — bounded, attention-sorted per-project rollup.
   *
   * Scoped by the same `listReadableProjectIds` fact as `listProjects`, which its route decorator
   * already claimed and the code did not do: the widget read the whole workspace, so a principal
   * with access to no project still received every project's key, name, lead, active sprint,
   * open-defect and blocked counts and progress. A rollup is not less sensitive than the list it
   * rolls up.
   */
  async listProjectHealth(actor: JwtPayload, limit: number): Promise<ProjectHealth[]> {
    const readable = await this.access.listReadableProjectIds(
      actor.workspaceId,
      actor.sub,
      'project:view',
    );
    return this.projectRepo.listHealthByWorkspace(actor.workspaceId, { limit }, readable);
  }

  /**
   * An archived project is read-only end to end (PRJ-FR-010): the project record and
   * key-gen were guarded, but its CONTENT (work items, iterations, releases, milestones)
   * stayed fully writable, so archiving stopped nothing inside the project. Shared by
   * every content service's write path — also validates existence like getProject.
   *
   * It RETURNS the project so a caller that needs the row does not fetch it twice; the
   * alternative was `getProject` followed by this method, which is two identical queries and
   * the reason the projects module's own writes went unguarded for as long as they did.
   *
   * The one deliberate exception is `updateProject`, which has to admit `status: 'active'` —
   * restoring is the only write an archived project accepts. Everything else in this class
   * routes through here.
   */
  async assertProjectWritable(workspaceId: string, projectId: string): Promise<Project> {
    const project = await this.getProject(workspaceId, projectId);
    if (project.status === 'archived') {
      throw new PreconditionFailedException(
        'PROJECT_ARCHIVED',
        'This project is archived and read-only. Restore it to active before changing its content.',
      );
    }
    return project;
  }

  async createProject(actor: JwtPayload, input: CreateProjectRequest): Promise<Project> {
    const normalizedKey = input.key.toUpperCase().trim();

    const existing = await this.projectRepo.findByKey(actor.workspaceId, normalizedKey);
    if (existing) {
      throw new ConflictException(
        'PROJECT_KEY_TAKEN',
        `Project key "${normalizedKey}" is already taken`,
      );
    }

    // PRJ-FR-002/006: owner is required; default to the authenticated actor
    const resolvedLeadId = input.leadId ?? actor.sub;

    // PRJ-FR-006: validate that the resolved lead is an active workspace member
    const lead = await this.workspaceMemberRepo.findMember(actor.workspaceId, resolvedLeadId);
    if (!lead || lead.status !== 'active') {
      throw new PreconditionFailedException(
        'PROJECT_LEAD_NOT_MEMBER',
        'The project lead must be an active member of this workspace',
      );
    }

    // SRS §9: a project's end date must not precede its start date. ISO date
    // strings (YYYY-MM-DD) compare chronologically as plain strings.
    if (input.startDate && input.endDate && input.endDate < input.startDate) {
      throw new PreconditionFailedException(
        'PROJECT_INVALID_DATE_RANGE',
        'End date must be on or after start date',
      );
    }

    // Validate any teams to link on create belong to this workspace (mirrors the
    // leadId scope check). Dedupe so a repeated id can't violate the unique link.
    const teamIds = [...new Set(input.teamIds ?? [])];
    if (teamIds.length > 0) {
      const workspaceTeams = await this.teamService.listTeams(actor.workspaceId);
      const validTeamIds = new Set(workspaceTeams.map((t) => t.id));
      const missing = teamIds.filter((id) => !validTeamIds.has(id));
      if (missing.length > 0) {
        throw new PreconditionFailedException(
          'PROJECT_TEAM_NOT_FOUND',
          'One or more teams do not belong to this workspace',
        );
      }
    }

    const projectId = uuidv7();

    // The scale to persist: the caller's values, or the documented defaults. Resolved BEFORE
    // the transaction so the row written is a complete, explicit set of six numbers rather
    // than six column DEFAULTs a later reader has to know about.
    const estimation: ProjectEstimationSettings = {
      ...DEFAULT_PROJECT_ESTIMATION_SETTINGS,
      ...input.estimationSettings,
    };

    // PRJ-FR-003: create the project and seed its counter, owner membership,
    // default workflow statuses, estimation settings and team links in ONE transaction. A
    // partial failure here would otherwise leave a project with no statuses or no owner —
    // an unusable state.
    const project = await this.uow.run(async (tx) => {
      const created = await this.projectRepo.create(
        {
          id: projectId,
          workspaceId: actor.workspaceId,
          key: normalizedKey,
          name: input.name,
          description: input.description,
          leadId: resolvedLeadId,
          startDate: input.startDate ?? null,
          endDate: input.endDate ?? null,
        },
        tx,
      );

      await this.projectRepo.initCounter(actor.workspaceId, tx);
      // RBAC migration Phase 4: no auto-lead project membership. The lead is a
      // display field; Project access (admin/editor/viewer) is granted
      // separately by Workspace Admin. The WA creator sees the project via
      // workspace:* regardless. SRS: "All normal users remain No Access until
      // Workspace Admin grants Project access."
      for (const s of DEFAULT_WORKFLOW_STATUSES) {
        await this.statusRepo.create(
          {
            id: uuidv7(),
            workspaceId: actor.workspaceId,
            projectId,
            name: s.name,
            category: s.category,
            color: s.color,
            position: s.position,
            isDefault: s.isDefault,
          },
          tx,
        );
      }

      // BR18/G3: every new project starts with the five default Test Case Types, in the SAME
      // transaction as the project — mirrors the workflow-status loop immediately above. This is
      // the CREATE-time half only; migration 0129 already backfilled every project that existed
      // before this hook shipped, and that one-time backfill is not re-run here.
      for (const [position, name] of DEFAULT_TEST_CASE_TYPE_NAMES.entries()) {
        await this.testCaseTypeRepo.create(
          { id: uuidv7(), workspaceId: actor.workspaceId, projectId, name, position },
          tx,
        );
      }

      /**
       * §4.2/§6.2: the Estimation Settings are CREATE fields, so the row is written here — in
       * the same transaction as the project — and not by a follow-up request.
       *
       * What this replaces: the SPA POSTed the project, then fired a best-effort
       * `PATCH :id/estimation-settings` which it SKIPPED whenever the six values still equalled
       * the defaults and merely toasted on failure. So the common path wrote no
       * `work.project_settings` row at all, a required setting was optional in practice, and a
       * project could exist with none for every later reader to fall back around. One
       * transaction, one write path.
       *
       * `onConflictDoUpdate` rather than a plain insert because migration 0117's trigger has
       * already inserted a DEFAULTS row for this project by the time this statement runs (it
       * fires on the `work.projects` insert above, inside this transaction). The trigger is the
       * floor for writers that never reach this service; this statement is what applies the
       * caller's choice on top.
       */
      await tx
        .insert(projectSettings)
        .values({
          workspaceId: actor.workspaceId,
          projectId,
          xsPoints: estimation.xsPoints,
          sPoints: estimation.sPoints,
          mPoints: estimation.mPoints,
          lPoints: estimation.lPoints,
          xlPoints: estimation.xlPoints,
          hoursPerPoint: String(estimation.hoursPerPoint),
        })
        .onConflictDoUpdate({
          target: projectSettings.projectId,
          set: {
            xsPoints: estimation.xsPoints,
            sPoints: estimation.sPoints,
            mPoints: estimation.mPoints,
            lPoints: estimation.lPoints,
            xlPoints: estimation.xlPoints,
            hoursPerPoint: String(estimation.hoursPerPoint),
            updatedAt: new Date(),
          },
        });

      for (const teamId of teamIds) {
        await this.projectTeamRepo.linkTeam(uuidv7(), actor.workspaceId, projectId, teamId, tx);
      }

      await this.audit.emit(
        {
          action: AUDIT_ACTION.PROJECT_CREATED,
          resourceType: AUDIT_RESOURCE.PROJECT,
          resourceId: projectId,
          workspaceId: actor.workspaceId,
          actor: { id: actor.sub },
          projectId,
          changes: {
            after: {
              key: normalizedKey,
              name: input.name,
              leadId: resolvedLeadId,
              startDate: input.startDate ?? null,
              teamIds,
              // Part of the create now, so part of what the create is audited as.
              estimationSettings: estimation,
            },
          },
        },
        tx,
      );

      return created;
    });

    this.logger.log(
      { projectId, key: normalizedKey, leadId: resolvedLeadId, teamCount: teamIds.length },
      'Project created',
    );
    await this.activity.logSafe([
      this.activity.build(this.projectSubject(project), actor.sub, 'project.created', null),
    ]);
    return project;
  }

  async getProject(workspaceId: string, projectId: string): Promise<Project> {
    const project = await this.projectRepo.findById(projectId, workspaceId);
    if (!project || project.deletedAt || project.workspaceId !== workspaceId) {
      throw new NotFoundException('PROJECT_NOT_FOUND', 'Project not found');
    }
    return project;
  }

  async updateProject(
    actor: JwtPayload,
    projectId: string,
    input: UpdateProjectInput,
  ): Promise<Project> {
    const project = await this.getProject(actor.workspaceId, projectId);

    // PRJ-FR-010: archived projects are read-only; only a status restore is allowed
    if (project.status === 'archived' && input.status !== 'active') {
      throw new PreconditionFailedException(
        'PROJECT_ARCHIVED',
        'This project is archived and read-only. Only restoring it to active is permitted.',
      );
    }

    // SRS §9: end date must not precede start date, checked against the merged
    // (post-patch) values so changing either side alone is validated too.
    const nextStart = input.startDate !== undefined ? input.startDate : project.startDate;
    const nextEnd = input.endDate !== undefined ? input.endDate : project.endDate;
    if (nextStart && nextEnd && nextEnd < nextStart) {
      throw new PreconditionFailedException(
        'PROJECT_INVALID_DATE_RANGE',
        'End date must be on or after start date',
      );
    }

    // G-6 (per audit + role-mapping §4): archive/restore is WA-ONLY. Project
    // lifecycle is company-level structure — "Create/edit/archive/restore/delete
    // Project: Workspace Admin" — and the old any-active-member branch was an
    // archive path around the WA-only POST /:id/archive (an Editor could flip
    // status through this PATCH). WA is company-level and never has a
    // project_members row (§2), so the check is the workspace permission, not
    // membership.
    const isStatusChange =
      input.status === 'archived' || (project.status === 'archived' && input.status === 'active');
    if (isStatusChange) {
      const isWorkspaceAdmin = await this.access.hasPermission(
        actor.workspaceId,
        actor.sub,
        'workspace:edit',
      );
      if (!isWorkspaceAdmin) {
        throw new PermissionDeniedException(
          'PROJECT_PERMISSION_DENIED',
          'Only a Workspace Admin can archive or restore a project',
        );
      }
    }

    // PRJ-FR-006: if changing leadId, validate new lead is an active workspace member
    if (input.leadId !== undefined && input.leadId !== null) {
      const lead = await this.workspaceMemberRepo.findMember(project.workspaceId, input.leadId);
      if (!lead || lead.status !== 'active') {
        throw new PreconditionFailedException(
          'PROJECT_LEAD_NOT_MEMBER',
          'The project lead must be an active member of this workspace',
        );
      }
    }

    const isArchiving = project.status !== 'archived' && input.status === 'archived';
    /**
     * §8 makes archive AND restore administrative audit events, and restore was landing as
     * `project.updated` — indistinguishable in the Audit Log from a rename, on the one write
     * that brings a read-only project back into use. It is a distinct action, so it gets the
     * distinct code rather than a second row alongside the update one.
     */
    const isRestoring = project.status === 'archived' && input.status === 'active';

    const after = await this.uow.run(async (tx) => {
      const updated = await this.projectRepo.update(projectId, input, actor.workspaceId, tx);
      await this.audit.emit(
        {
          action: isArchiving
            ? AUDIT_ACTION.PROJECT_ARCHIVED
            : isRestoring
              ? AUDIT_ACTION.PROJECT_RESTORED
              : AUDIT_ACTION.PROJECT_UPDATED,
          resourceType: AUDIT_RESOURCE.PROJECT,
          resourceId: projectId,
          workspaceId: actor.workspaceId,
          actor: { id: actor.sub },
          projectId,
          changes: { before: project, after: updated },
        },
        tx,
      );
      return updated;
    });

    await this.activity.logSafe(
      this.activity.buildDiff(
        this.projectSubject(after),
        actor.sub,
        project as unknown as Record<string, unknown>,
        input as Record<string, unknown>,
        PROJECT_ACTIVITY_CONFIG,
        'project.updated',
      ),
    );
    return after;
  }

  /**
   * Soft-delete, audited.
   *
   * §8 makes deleting a project an administrative audit event and `project.deleted` did not
   * exist as an action at all — so the most destructive write in this module was the one
   * mutation the Audit Log could not show, on a record that is only recoverable by clearing
   * `deleted_at` in SQL. The emit is INSIDE the transaction with the delete, like every other
   * emit here: `AuditProducer.emit` writes the transactional outbox, so sharing the
   * transaction is what makes it impossible for the row and the event to disagree.
   *
   * Takes the actor rather than a bare workspace id because an audit entry with no actor is
   * not an audit entry — `changes.before` carries the deleted project so the trail records
   * WHAT was deleted, not just that something was.
   */
  async deleteProject(actor: JwtPayload, projectId: string): Promise<void> {
    const project = await this.getProject(actor.workspaceId, projectId);
    await this.uow.run(async (tx) => {
      await this.projectRepo.softDelete(projectId, actor.workspaceId, tx);
      await this.audit.emit(
        {
          action: AUDIT_ACTION.PROJECT_DELETED,
          resourceType: AUDIT_RESOURCE.PROJECT,
          resourceId: projectId,
          workspaceId: actor.workspaceId,
          actor: { id: actor.sub },
          projectId,
          changes: { before: project },
        },
        tx,
      );
    });
    this.logger.log({ projectId, actorId: actor.sub }, 'Project soft-deleted');
  }

  // ── Estimation Settings (SRS §6.2) ────────────────────────────────────────

  /**
   * Read the per-project estimate scale. Falls back to the defaults when no row exists,
   * so the settings form, the progress bars and `forProject()` all agree before a WA
   * has configured anything. Existence is checked first — a bad or cross-workspace id
   * is a 404, not silently the default scale for a project that does not exist.
   */
  async getEstimationSettings(
    workspaceId: string,
    projectId: string,
  ): Promise<ProjectEstimationSettings> {
    await this.getProject(workspaceId, projectId);
    const rows = await this.db
      .select()
      .from(projectSettings)
      .where(
        and(eq(projectSettings.projectId, projectId), eq(projectSettings.workspaceId, workspaceId)),
      )
      .limit(1);
    const s = rows[0];
    if (!s) return { ...DEFAULT_PROJECT_ESTIMATION_SETTINGS };
    return {
      xsPoints: s.xsPoints,
      sPoints: s.sPoints,
      mPoints: s.mPoints,
      lPoints: s.lPoints,
      xlPoints: s.xlPoints,
      // numeric(8,2) returns a string; the wire type is a number.
      hoursPerPoint: Number(s.hoursPerPoint),
    };
  }

  /**
   * Partial update of the estimate scale. Merges onto the current values (PATCH, not
   * replace) so a WA editing one size does not reset the others, then upserts the single
   * `project_settings` row in one transaction with the audit event. `workspace:edit` on
   * the route already proved the actor is a Workspace Admin — the BA scope for this
   * setting — so there is no second authorisation check here.
   */
  async updateEstimationSettings(
    actor: JwtPayload,
    projectId: string,
    input: Partial<ProjectEstimationSettings>,
  ): Promise<ProjectEstimationSettings> {
    // Resolves existence + workspace scope (404 on miss/cross-workspace), refuses an archived
    // project (PRJ-FR-010) and carries workspaceId into the upsert row — one query for all
    // three, which is why the guard returns the row.
    const project = await this.assertProjectWritable(actor.workspaceId, projectId);
    const before = await this.getEstimationSettings(actor.workspaceId, projectId);
    const after = { ...before, ...input };

    return this.uow.run(async (tx) => {
      await tx
        .insert(projectSettings)
        .values({
          workspaceId: project.workspaceId,
          projectId: project.id,
          xsPoints: after.xsPoints,
          sPoints: after.sPoints,
          mPoints: after.mPoints,
          lPoints: after.lPoints,
          xlPoints: after.xlPoints,
          hoursPerPoint: String(after.hoursPerPoint),
        })
        .onConflictDoUpdate({
          target: projectSettings.projectId,
          set: {
            xsPoints: after.xsPoints,
            sPoints: after.sPoints,
            mPoints: after.mPoints,
            lPoints: after.lPoints,
            xlPoints: after.xlPoints,
            hoursPerPoint: String(after.hoursPerPoint),
            updatedAt: new Date(),
          },
        });
      await this.audit.emit(
        {
          action: AUDIT_ACTION.PROJECT_UPDATED,
          resourceType: AUDIT_RESOURCE.PROJECT,
          resourceId: projectId,
          workspaceId: actor.workspaceId,
          actor: { id: actor.sub },
          projectId,
          changes: { before, after },
        },
        tx,
      );
      return after;
    });
  }

  // ── Workflow statuses ─────────────────────────────────────────────────────

  async listStatuses(workspaceId: string, projectId: string): Promise<WorkflowStatus[]> {
    await this.getProject(workspaceId, projectId);
    return this.statusRepo.listByProject(projectId);
  }

  async listTransitions(workspaceId: string, projectId: string): Promise<WorkflowTransition[]> {
    await this.getProject(workspaceId, projectId);
    return this.statusRepo.listTransitions(projectId);
  }

  /** Used by work-items to validate a status transition is permitted. */
  async assertTransitionAllowed(
    projectId: string,
    fromStatusId: string,
    toStatusId: string,
  ): Promise<void> {
    const allowed = await this.statusRepo.canTransition(projectId, fromStatusId, toStatusId);
    if (!allowed) {
      throw new PreconditionFailedException(
        'WORKFLOW_TRANSITION_NOT_ALLOWED',
        'This status transition is not permitted',
      );
    }
  }

  /**
   * Used by work-items to validate that a proposed assignee is an active member
   * of the workspace that owns the project (P1-15 scope validation).
   */
  async assertWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    const member = await this.workspaceMemberRepo.findMember(workspaceId, userId);
    if (!member || member.status !== 'active') {
      throw new PreconditionFailedException(
        'ASSIGNEE_NOT_WORKSPACE_MEMBER',
        'The assigned user is not an active member of this workspace',
      );
    }
  }

  /**
   * Used by work-items to validate that a label belongs to the project (P1-15
   * scope validation).
   */
  async assertLabelBelongsToProject(projectId: string, labelId: string): Promise<void> {
    const label = await this.labelRepo.findById(labelId);
    if (!label || label.projectId !== projectId) {
      throw new NotFoundException(
        'LABEL_NOT_FOUND',
        'Label not found or does not belong to this project',
      );
    }
  }

  /** Used by work-items to generate the next sequential item key (e.g. "US-42"). */
  // `IN`/`FE` are gone with the initiative/feature work-item types. Portfolio items
  // mint their own `EP-`/`FE-` keys from work.portfolio_items (P5.1).
  private static readonly TYPE_PREFIX: Record<WorkItemType, string> = {
    story: 'US',
    task: 'TA',
    defect: 'DE',
  };

  async generateItemKey(
    workspaceId: string,
    projectId: string,
    type: WorkItemType,
  ): Promise<string> {
    // PRJ-FR-010: archived projects are read-only; block new work item creation. This was an
    // inline copy of `assertProjectWritable`'s body — a second home for one rule, and the
    // reason `projectId` is fetched here at all. It now calls the guard, so the rule has one
    // implementation and one message across the module.
    await this.assertProjectWritable(workspaceId, projectId);
    const prefix = ProjectsService.TYPE_PREFIX[type];
    // Rally FormattedID: the sequence is per-(workspace, type), so US-42 is unique
    // across the whole workspace (not per project). projectId is still used above
    // only to enforce the archived-project guard.
    const seq = await this.projectRepo.incrementCounter(workspaceId, type);
    // Type-prefix + hyphen convention (e.g. US-42, DE-1); no zero-padding.
    return `${prefix}-${seq}`;
  }

  // ── Workflow status mutations ──────────────────────────────────────────────
  //
  // Every mutation below opens with `assertProjectWritable`, not `getProject`.
  //
  // "Archived Projects are read-only regardless of access level" (PRJ-FR-010) held in four
  // modules and in NONE of this one's own writes — workflow statuses, transitions, labels,
  // team links and the estimation scale were all editable on an archived project by anyone
  // holding `project:edit`, and the guard enforcing the rule everywhere else is a sibling
  // method in this very class. The reads (`listStatuses`, `listLabels`, `listProjectTeams`, …)
  // deliberately keep `getProject`: archived means read-only, not invisible.
  //
  // The deliberate exceptions are the three Project MEMBER writes further down. Revoking
  // someone's access to an archived project must stay possible — refusing it would make
  // archiving a one-way door that freezes a stale access list — and access is not the project's
  // content. Each carries its own note.

  async createStatus(
    workspaceId: string,
    projectId: string,
    input: Omit<CreateWorkflowStatusInput, 'id' | 'workspaceId' | 'projectId'>,
  ): Promise<WorkflowStatus> {
    await this.assertProjectWritable(workspaceId, projectId);
    const statuses = await this.statusRepo.listByProject(projectId);
    return this.statusRepo.create({
      id: uuidv7(),
      workspaceId,
      projectId,
      name: input.name,
      category: input.category,
      color: input.color,
      position: input.position ?? statuses.length,
      isDefault: input.isDefault ?? false,
    });
  }

  async deleteStatus(workspaceId: string, projectId: string, statusId: string): Promise<void> {
    await this.assertProjectWritable(workspaceId, projectId);
    const status = await this.statusRepo.findById(statusId);
    if (!status || status.projectId !== projectId) {
      throw new NotFoundException('WORKFLOW_STATUS_NOT_FOUND', 'Workflow status not found');
    }
    await this.statusRepo.delete(statusId);
  }

  async reorderStatuses(
    workspaceId: string,
    projectId: string,
    orderedIds: string[],
  ): Promise<void> {
    await this.assertProjectWritable(workspaceId, projectId);
    await this.statusRepo.updatePositions(projectId, orderedIds);
  }

  // ── Workflow transition mutations ─────────────────────────────────────────

  async createTransition(
    workspaceId: string,
    projectId: string,
    input: Omit<CreateWorkflowTransitionInput, 'id' | 'workspaceId' | 'projectId'>,
  ): Promise<WorkflowTransition> {
    await this.assertProjectWritable(workspaceId, projectId);
    // Both endpoints must be statuses of THIS project (mirrors deleteStatus's
    // project-scope check) so a transition can never reference a status from
    // another project/workspace. `fromStatusId` is nullable — null means "from
    // any status" (a global transition), so it is only validated when provided.
    const [from, to] = await Promise.all([
      input.fromStatusId ? this.statusRepo.findById(input.fromStatusId) : Promise.resolve(null),
      this.statusRepo.findById(input.toStatusId),
    ]);
    if (input.fromStatusId && (!from || from.projectId !== projectId)) {
      throw new NotFoundException(
        'WORKFLOW_STATUS_NOT_FOUND',
        'Transition references a status that does not belong to this project',
      );
    }
    if (!to || to.projectId !== projectId) {
      throw new NotFoundException(
        'WORKFLOW_STATUS_NOT_FOUND',
        'Transition references a status that does not belong to this project',
      );
    }
    return this.statusRepo.createTransition({
      id: uuidv7(),
      workspaceId,
      projectId,
      fromStatusId: input.fromStatusId,
      toStatusId: input.toStatusId,
      name: input.name,
    });
  }

  async deleteTransition(
    workspaceId: string,
    projectId: string,
    transitionId: string,
  ): Promise<void> {
    await this.assertProjectWritable(workspaceId, projectId);
    const transition = await this.statusRepo.findTransitionById(transitionId);
    if (!transition || transition.projectId !== projectId) {
      throw new NotFoundException('WORKFLOW_STATUS_NOT_FOUND', 'Workflow transition not found');
    }
    await this.statusRepo.deleteTransition(transitionId);
  }

  // ── Labels ────────────────────────────────────────────────────────────────

  async listLabels(workspaceId: string, projectId: string): Promise<Label[]> {
    await this.getProject(workspaceId, projectId);
    return this.labelRepo.listByProject(projectId, workspaceId);
  }

  async createLabel(
    workspaceId: string,
    projectId: string,
    name: string,
    color?: string,
  ): Promise<Label> {
    await this.assertProjectWritable(workspaceId, projectId);
    return this.labelRepo.create({ id: uuidv7(), workspaceId, projectId, name, color });
  }

  async updateLabel(
    workspaceId: string,
    projectId: string,
    labelId: string,
    input: { name?: string; color?: string },
  ): Promise<Label> {
    await this.assertProjectWritable(workspaceId, projectId);
    const label = await this.labelRepo.findById(labelId);
    if (!label || label.projectId !== projectId || label.workspaceId !== workspaceId) {
      throw new NotFoundException('LABEL_NOT_FOUND', 'Label not found');
    }
    return this.labelRepo.update(labelId, input);
  }

  async deleteLabel(workspaceId: string, projectId: string, labelId: string): Promise<void> {
    await this.assertProjectWritable(workspaceId, projectId);
    const label = await this.labelRepo.findById(labelId);
    if (!label || label.projectId !== projectId || label.workspaceId !== workspaceId) {
      throw new NotFoundException('LABEL_NOT_FOUND', 'Label not found');
    }
    await this.labelRepo.delete(labelId);
    this.logger.log({ labelId, projectId }, 'Label deleted');
  }

  // ── Project Teams ─────────────────────────────────────────────────────────

  async listProjectTeams(workspaceId: string, projectId: string): Promise<ProjectTeamLink[]> {
    await this.getProject(workspaceId, projectId);
    return this.projectTeamRepo.listByProject(projectId);
  }

  /**
   * {@link listProjectTeams} as a READER sees it — an Editor sees only their own Teams
   * (`GAP-P4-RBAC-003` AC2, §2.2 "works only within assigned Teams").
   *
   * A separate method rather than an actor parameter on the one above, because that one is also the
   * single home of the "team must be linked to this project" RULE
   * ({@link assertTeamLinkedToProject}) and of the Team picker's own write-side validation. Narrowing
   * it by the caller would make a legitimate link invisible to a rule that has to see every link, and
   * an Editor could then no longer be given work in their own team.
   *
   * A per-project `admin` and a Workspace Admin both keep All Teams (§3.1). An Editor with no active
   * Team gets an EMPTY list, which is AC1's "no delivery scope" expressed in the feed — the SPA must
   * not synthesize an `All Teams` entry over it.
   */
  async listProjectTeamsForReader(
    workspaceId: string,
    projectId: string,
    actorId: string,
  ): Promise<ProjectTeamLink[]> {
    const links = await this.listProjectTeams(workspaceId, projectId);
    if (await this.access.isWorkspaceAdmin(workspaceId, actorId)) return links;
    const level = await this.access.getProjectAccessLevel(workspaceId, actorId, projectId);
    if (level !== 'editor') return links;
    const scoped = await this.access.listScopedTeamIds(workspaceId, actorId, projectId);
    return links.filter((l) => scoped.includes(l.teamId));
  }

  /**
   * Single source of truth for the "team must be linked to this project" rule
   * (SRS P1-MANAGE-ORG). Other modules (work items, iterations) delegate here
   * instead of re-implementing the check, so the rule — and any future
   * extension of it (e.g. status filters, effective-dating) — lives in exactly
   * one place. Throws PROJECT_TEAM_LINK_NOT_FOUND when the team is not actively
   * linked to the project.
   */
  async assertTeamLinkedToProject(
    workspaceId: string,
    projectId: string,
    teamId: string,
  ): Promise<void> {
    const links = await this.listProjectTeams(workspaceId, projectId);
    const linked = links.some((l) => l.teamId === teamId && l.status === 'active');
    if (!linked) {
      throw new PreconditionFailedException(
        'PROJECT_TEAM_LINK_NOT_FOUND',
        'Team is not linked to this project',
      );
    }
  }

  async linkTeam(workspaceId: string, projectId: string, teamId: string): Promise<ProjectTeamLink> {
    await this.assertProjectWritable(workspaceId, projectId);

    // The team must belong to the same workspace (mirrors the create-project
    // team validation) — prevents linking a team from another workspace/tenant.
    const workspaceTeams = await this.teamService.listTeams(workspaceId);
    if (!workspaceTeams.some((t) => t.id === teamId)) {
      throw new PreconditionFailedException(
        'PROJECT_TEAM_NOT_FOUND',
        'Team does not belong to this workspace',
      );
    }

    const existing = await this.projectTeamRepo.findLink(projectId, teamId);
    if (existing) {
      throw new ConflictException(
        'PROJECT_TEAM_ALREADY_LINKED',
        'Team is already linked to this project',
      );
    }

    const link = await this.projectTeamRepo.linkTeam(uuidv7(), workspaceId, projectId, teamId);
    this.logger.log({ projectId, teamId }, 'Team linked to project');
    return link;
  }

  async unlinkTeam(workspaceId: string, projectId: string, teamId: string): Promise<void> {
    await this.assertProjectWritable(workspaceId, projectId);

    const existing = await this.projectTeamRepo.findLink(projectId, teamId);
    if (!existing) {
      throw new NotFoundException(
        'PROJECT_TEAM_LINK_NOT_FOUND',
        'Team is not linked to this project',
      );
    }

    /**
     * REFUSED while the team is on one of this project's capacity plans, naming the plans.
     *
     * `project_teams` is a soft status flip, so `fk_capacity_plan_teams_team ON DELETE RESTRICT`
     * never fires and nothing stopped an unlink from leaving the team's plan row and its allocations
     * behind — precisely the state migration 0085 had to clean up. Releases already refuse deletion
     * for a plan that depends on them (`RELEASE_HAS_CAPACITY_PLAN`); this is the same rule for the
     * other reference.
     *
     * `Remove Team` on the plan is the deliberate action, and it re-parks the demand as unassigned
     * (AC-005) rather than losing it — which is why refusing here costs the planner nothing.
     */
    const plans = await this.db
      .select({ planKey: capacityPlans.planKey, name: capacityPlans.name })
      .from(capacityPlanTeams)
      .innerJoin(capacityPlans, eq(capacityPlans.id, capacityPlanTeams.planId))
      .where(
        and(
          eq(capacityPlanTeams.teamId, teamId),
          eq(capacityPlans.projectId, projectId),
          eq(capacityPlans.workspaceId, workspaceId),
        ),
      )
      // `id` breaks the tie: `plan_key` is unique per project, not per workspace, and the
      // ordering ratchet requires the last column to be unique so two runs cannot disagree.
      .orderBy(capacityPlans.planKey, capacityPlans.id)
      .limit(3);
    if (plans.length > 0) {
      const named = plans.map((row) => `${row.planKey} (${row.name})`).join(', ');
      throw new PreconditionFailedException(
        'PROJECT_TEAM_HAS_CAPACITY_PLAN',
        `This team is on ${named} — remove it from the plan before unlinking it from the project`,
      );
    }

    await this.projectTeamRepo.unlinkTeam(projectId, teamId);
    this.logger.log({ projectId, teamId }, 'Team unlinked from project');
  }

  // ── Project Members ───────────────────────────────────────────────────────

  /**
   * The users whose project authority IS the workspace-wide grant, so §2.1 keeps them out of
   * the roster and out of the candidate list.
   *
   * AC-8 / §2.1: "a Workspace Admin is not added as a Project user or Team member." Nothing
   * anti-joined them anywhere — `db/seeds/demo.ts` writes the row and migration 0104 promoted
   * it to `access_level = 'admin'` — so a WA was listed as a project member on every project in
   * the workspace, and offerable again as one.
   *
   * ONE named home, read by the roster AND by `addProjectMember`, because a rule enforced in two
   * places is a rule that eventually disagrees with itself: hiding the row on read while the POST
   * still creates it would leave an INVISIBLE grant. That is not theoretical — a
   * `project_members` row is what `AccessService.effectiveAssignments` synthesizes a
   * project-scoped grant from, so a WA's row is dormant only for as long as they are a WA. Demote
   * them and it becomes live Project Admin on that project, with nothing on screen to say so.
   * Migration 0118 clears the rows that already exist for the same reason.
   *
   * `getProjectAccessLevel` is untouched by this: it resolves from `effectiveAssignments`, and
   * `null` still means "Workspace Admin, or No Access" exactly as its callers assume — removing
   * the row makes that MORE true for a WA, not less.
   */
  private async workspaceAdminIds(workspaceId: string): Promise<Set<string>> {
    return new Set(await this.projectMemberRepo.listWorkspaceAdminUserIds(workspaceId));
  }

  async listProjectMembers(
    workspaceId: string,
    projectId: string,
    actorId: string,
  ): Promise<ProjectMember[]> {
    await this.getProject(workspaceId, projectId);
    /**
     * SRS §3.1 "View Project `Users & Permissions`": Workspace Admin Edit, Admin Read-only,
     * Editor Hidden. The route can only carry `project:view`, which every level holds, so the
     * LEVEL check has to live here.
     *
     * Written as an allow-list, not `!== 'editor'`. The deny-list form names the levels to REFUSE, so
     * every level added later is admitted by default — which is the wrong default for a screen §3.1
     * hides from all but two principals. That is not hypothetical: a third level was added and removed
     * again within one week (migrations 0113, 0115), and under the deny-list form it would have been
     * able to read this roster the whole time.
     * Workspace Admin resolves NO level (its authority is the workspace-wide grant, not a
     * `project_members` row), and a principal with no access at all cannot reach this method
     * because the route's `project:view` gate refuses them first — so `null` is WA here, and it is
     * allowed.
     */
    const level = await this.access.getProjectAccessLevel(workspaceId, actorId, projectId);
    if (level !== null && level !== 'admin') {
      throw new PermissionDeniedException(
        'PROJECT_PERMISSION_DENIED',
        'Only a Workspace Admin or a Project Admin can view the project user roster',
      );
    }
    // §2.1 — filtered here rather than in the repository so the explicit rows AND the
    // team-derived ones go through the same test; a WA who is also on a linked team would
    // otherwise reappear through the second branch.
    const admins = await this.workspaceAdminIds(workspaceId);
    const members = await this.projectMemberRepo.listByProject(projectId);
    const real = members.filter((m) => !admins.has(m.userId));

    /**
     * Then the Workspace Admins are added BACK, as synthesized read-only rows.
     *
     * BA report 2026-08-21: "Every Project Users & Permissions list always displays the active
     * Workspace Admin as a system-generated, read-only row … independent of Project Access and Team
     * membership … No project_members record is created and the row is excluded from Project-member
     * metrics." Before this the screen read "No members in this project yet." on a project whose only
     * authority was a WA, which is the least true sentence available: the person reading it was
     * usually that admin.
     *
     * This REVERSES one SRS sentence and keeps the rest. §5.2:138 says "Workspace Admin is excluded
     * from rows and candidates" — rows now include them, CANDIDATES still do not
     * (`listProjectMemberOptions` and the Add-Existing-User feed are untouched), and §2.1's "not added
     * as a Project user" is intact because nothing is written.
     *
     * The filter above is not redundant: it drops any REAL row a WA might still hold — a pre-0118
     * leftover, or one a seed wrote back — so the person appears exactly once, and as the synthesized
     * row rather than as a member with an editable access level.
     *
     * `accessLevel: null` is deliberately NOT how a caller should recognise these: a null level
     * already means "team-derived row" elsewhere in this module. `isWorkspaceAdmin` is the flag.
     */
    const now = new Date();
    const synthesized: ProjectMember[] = (
      await this.projectMemberRepo.listWorkspaceAdminProfiles(workspaceId)
    ).map((a) => ({
      // Its own userId: the response schema types `id` as a uuid, and a synthesized row has no
      // `project_members` id to give. Nothing addresses it — `PATCH`/`DELETE :id/members/*` resolve a
      // real row and 404 — and no client may branch on this value: `isWorkspaceAdmin` is the flag.
      id: a.userId,
      workspaceId,
      projectId,
      userId: a.userId,
      accessLevel: null,
      status: 'active',
      joinedAt: now,
      updatedAt: now,
      displayName: a.displayName,
      email: a.email,
      avatarUrl: a.avatarUrl,
      teamCount: 0,
      isWorkspaceAdmin: true,
    }));

    return [...synthesized, ...real];
  }

  /**
   * The ASSIGNEE feed — who this project's work can be owned by.
   *
   * Split out from {@link listProjectMembers} because that roster is `Workspace Admin or Project Admin`
   * only (§3.1:71), and it was ALSO the only owner-picker feed. So closing that hole (correctly) left
   * every Editor's Backlog and Iteration Status with an empty member list — and both surfaces derive
   * the displayed owner NAME from that same list, so every owned item read `Unassigned` and no owner
   * could be set. §3.2:79 grants an Editor exactly that write. Silent wrong data on the two screens an
   * Editor lives in, caused by a permission fix: the check was right and the FEED was the defect.
   *
   * Carries only what a picker needs — id, name, email, avatar. None of `accessLevel`, `status`,
   * `teamCount` or the timestamps, which are the administrative facts §3.1 restricts. A separate
   * projection rather than a `.pick()` of the roster type, for the same reason the workspace-level
   * split (`GET /workspaces/:id/member-options`) is a separate query: a field added to the admin shape
   * later must not silently join the feed every participant reads.
   *
   * Workspace Admins stay excluded, which is the §2.1 rule the roster already applies AND what
   * `AC-16` wants ("No Access and Workspace Admin are not assignable owners") — one filter, both
   * requirements. No actor gate here: the route carries `project:view` scoped to the path id, so
   * anyone who reaches this can already see the project.
   *
   * `teamId` NARROWS IT TO THAT TEAM'S ACTIVE ROSTER (GAP-P1-WID-007)
   *
   * "Work Item and Task Owner default to Unassigned. Selected Team offers Unassigned plus its ACTIVE
   * MEMBERS; No Team offers only Unassigned. Do not add No Team or unrelated Workspace users to Owner
   * options." So this is ONE feed with one gate rather than a second endpoint: the audience, the
   * fields and the permission are identical, only the population moves. Omitting `teamId` keeps the
   * project-wide list, which is what every id→name lookup on a grid still needs (a row's owner may
   * have left the team, and a name that resolves is not the same question as an option that may be
   * offered).
   *
   * The team must be actively LINKED to the project — `assertTeamLinkedToProject`, the one home of
   * that rule — or this route would read any team's roster through any project the caller can view.
   * Team STATUS is deliberately not checked: an archived team keeps its work (DB design §488), so
   * refusing here would make the Owner field unusable on every item that team still owns.
   *
   * RULED — the Workspace Admin exclusion applies to the PROJECT-WIDE branch ONLY (2026-08-17).
   * ---------------------------------------------------------------------------
   * This used to subtract Workspace Admins from BOTH populations, on the reading that `AC-16`
   * ("Workspace Admin is not an assignable owner") is the narrower statement. It is what MADE
   * `GAP-P1-WID-007` a Confirmed Fail on the 2026-08-17 retest: the selected team's only active
   * member held the workspace grant, so the Owner dropdown for a Story WITH a team offered nothing
   * but `Unassigned` and no owner could be set at all. The retest ACs name exactly two exclusions —
   * a member outside the selected Team (AC3) and an inactive one (AC3) — and AC1 requires "every
   * active member of that Team".
   *
   * So a `team_members` row is what decides the team branch, whatever else its holder is: they ARE
   * an active member of that Team, which is the only question `WID-FR-016` / `TASK-FR-017` ask.
   * `TeamService.grantTeamRosterProjectAccess` running with `onWorkspaceAdmin: 'skip'` is not the
   * absence of membership — it is a grant a WA does not NEED.
   *
   * The project-wide branch keeps the filter, because §2.1 and migration 0118 mean a WA holds no
   * `project_members` row in the first place; subtracting them there states the rule rather than
   * changing the result. That branch stays the id→name resolver as well, so an owner who has since
   * left the team still renders under their own name.
   */
  async listProjectMemberOptions(
    workspaceId: string,
    projectId: string,
    teamId?: string,
  ): Promise<
    Array<{
      userId: string;
      displayName: string | null;
      email: string | null;
      avatarUrl: string | null;
    }>
  > {
    await this.getProject(workspaceId, projectId);
    const rows = await this.assignmentCandidates(workspaceId, projectId, teamId ?? null);
    return rows.map((m) => ({
      userId: m.userId,
      displayName: m.displayName ?? null,
      email: m.email ?? null,
      avatarUrl: m.avatarUrl ?? null,
    }));
  }

  /** The Workspace Admins as picker rows — profile from the same query the synthesized roster uses. */
  private async workspaceAdminOptionRows(
    workspaceId: string,
    ids: Set<string>,
  ): Promise<
    Array<{
      userId: string;
      displayName?: string | null;
      email?: string | null;
      avatarUrl?: string | null;
    }>
  > {
    if (ids.size === 0) return [];
    return (await this.projectMemberRepo.listWorkspaceAdminProfiles(workspaceId)).filter((a) =>
      ids.has(a.userId),
    );
  }

  /**
   * The WRITE side of {@link listProjectMemberOptions}'s rule — the same population, asserted.
   *
   * "`assigneeId` … With a selected Team: active Project Admin, active Editor assigned to that Team,
   * or active WA member of that Team. With blank Team: active Project Admin only" — and `devOwnerId`
   * "uses the same candidate and validation rule as `assigneeId`" (BA `c42df59`). One method for both
   * so a picker cannot offer what the write refuses, or the write accept what no picker offered: the
   * property this repo keeps re-learning.
   */
  async assertAssignable(
    workspaceId: string,
    projectId: string,
    teamId: string | null,
    userId: string,
  ): Promise<void> {
    const candidates = await this.assignmentCandidates(workspaceId, projectId, teamId);
    if (!candidates.some((c) => c.userId === userId)) {
      throw new PreconditionFailedException(
        'WORK_ITEM_ASSIGNEE_NOT_ELIGIBLE',
        teamId
          ? 'The selected user is not eligible in this project and team'
          : 'Only a Project Admin can be assigned while no Team is selected',
      );
    }
  }

  /**
   * THE ONE ASSIGNMENT-ELIGIBILITY RULE, for `Owner` and for `Dev Owner`.
   *
   * The BA states it as one source used by both fields (`c42df59`, 2026-08-22 — `WID-FR-017`,
   * `WIC-FR-006A`, and the Project/Team assignment addendum):
   *
   *   • a Team is selected  → active **Admin** of the project (project-wide), active **Editor**
   *     assigned to THAT team, and an active **Workspace Admin** who is a member of that team
   *   • no Team selected    → active **Admin** only; Editors and WA team members are NOT offered
   *   • `Team Lead` has no bypass — a lead is an ordinary member here
   *
   * Two things it replaces, and both were wrong in a way that showed on screen. The team branch read
   * `team_members` ALONE, so a project Admin who is not on the team was withheld even though their
   * authority spans every team (§3.1's `All Teams`). The project-wide branch offered every member,
   * so with no Team chosen an Editor was offered as Owner for work their own team scope would then
   * refuse them.
   *
   * The Workspace Admin case is why the level and the roster are read separately rather than joined:
   * a WA holds NO `project_members` row at all (§2.1, migration 0118), so they can only be recognised
   * by the admin predicate, and they qualify only through the team roster.
   */
  private async assignmentCandidates(
    workspaceId: string,
    projectId: string,
    teamId: string | null,
  ): Promise<
    Array<{
      userId: string;
      displayName?: string | null;
      email?: string | null;
      avatarUrl?: string | null;
    }>
  > {
    const workspaceAdmins = await this.workspaceAdminIds(workspaceId);
    const members = (await this.projectMemberRepo.listByProject(projectId)).filter(
      (m) => m.status === 'active' && !workspaceAdmins.has(m.userId),
    );
    // Project Admins, in every branch: their authority is All Teams (§3.1), so a Team filter must not
    // narrow them out.
    const admins = members.filter((m) => m.accessLevel === 'admin');
    if (!teamId) {
      /**
       * WITH NO TEAM: project Admins, plus WORKSPACE Admins — a DECLARED READING.
       *
       * `WIC-FR-006A` says "With blank Team, Editor/WA **Team members** are not offered", which reads
       * as excluding the TEAM-DERIVED qualification rather than the principal: a Workspace Admin has
       * project authority by the workspace grant and holds no `project_members` row to be an "Admin"
       * row with (§2.1). The team-scope ruling points the same way — team-less work IS the Project
       * Backlog, "accessible only to Workspace Admin and Project Admin" — so the people who may own it
       * are exactly those two.
       *
       * Excluding them would also refuse the ordinary case the same commit encourages: a Workspace
       * Admin filing backlog work and being defaulted as its Owner (`WIC-FR-006`). Put to the BA; if
       * they mean the narrow reading, this branch drops the second half and nothing else changes.
       */
      return [...admins, ...(await this.workspaceAdminOptionRows(workspaceId, workspaceAdmins))];
    }

    const roster = (await this.teamRosterOptionSource(workspaceId, projectId, teamId)).filter(
      (m) => m.status === 'active',
    );
    const rosterIds = new Set(roster.map((m) => m.userId));
    // Editors qualify through the SELECTED team only, and a Workspace Admin through the roster alone —
    // they have no level to qualify with.
    const editorsOnTeam = members.filter(
      (m) => m.accessLevel === 'editor' && rosterIds.has(m.userId),
    );
    const adminsOnWorkspace = roster.filter((m) => workspaceAdmins.has(m.userId));

    const byUser = new Map<
      string,
      {
        userId: string;
        displayName?: string | null;
        email?: string | null;
        avatarUrl?: string | null;
      }
    >();
    for (const m of [...admins, ...editorsOnTeam, ...adminsOnWorkspace]) {
      if (!byUser.has(m.userId)) byUser.set(m.userId, m);
    }
    return [...byUser.values()];
  }

  /**
   * The selected Team's roster, in the shape {@link listProjectMemberOptions} filters and maps.
   *
   * `team_members` and not `project_members` narrowed by team: `RBE-06` grants `editor` FROM a team
   * roster row, so a team member is a participant whether or not an explicit `project_members` row
   * was ever written for them — intersecting the two would withhold exactly those people.
   */
  private async teamRosterOptionSource(
    workspaceId: string,
    projectId: string,
    teamId: string,
  ): Promise<
    Array<{
      userId: string;
      status: string;
      displayName?: string | null;
      email?: string | null;
      avatarUrl?: string | null;
    }>
  > {
    await this.assertTeamLinkedToProject(workspaceId, projectId, teamId);
    return this.teamService.listTeamMembers(teamId, workspaceId);
  }

  /**
   * The two facts PRJ-08's rule is evaluated against: the project's teams, and the user's teams
   * among them.
   *
   * One helper because BOTH level writes need them — the combined
   * {@link setProjectAccess} and {@link updateProjectMember} — and the rule itself
   * (`assertTeamAssignmentForLevel`) takes them as data so it can stay a pure function in the access
   * domain rather than a second query in each caller.
   *
   * "The project's teams" is the ACTIVE project↔team links, which is exactly the set
   * `GET /projects/:id/teams` feeds the SPA's Team picker from. Deliberately the same set: a server
   * that counted a different population than the picker offers would refuse a Team the admin was
   * just invited to choose.
   */
  private async projectTeamContext(
    projectId: string,
    userId: string,
  ): Promise<{ projectTeamIds: string[]; currentTeamIds: string[] }> {
    const links = await this.projectTeamRepo.listByProject(projectId);
    const projectTeamIds = links.map((l) => l.teamId);
    return {
      projectTeamIds,
      currentTeamIds: await this.teamService.listUserTeamIds(userId, projectTeamIds),
    };
  }

  /**
   * Set a user's per-Project access level AND their Teams in that project — ONE write, ONE
   * transaction (PRJ-08, §5.1/§5.2).
   *
   * This is the COMBINED endpoint PRJ-08 needs, and the combination is the point rather than a
   * convenience. The level and the Teams used to be two requests — grant, then one
   * `POST /teams/:id/members` per team — so "an Editor must have at least one Team" (§2.2) could not
   * be refused at grant time without rejecting the first of two calls the screen legitimately makes.
   * That is why the guard did not exist. With both halves in one body the invariant is decidable
   * before anything is written, and `assertTeamAssignmentForLevel` in `@modules/access` is the ONE
   * place it is decided; see its docblock for the two exemptions (an Admin needs no Team; a project
   * with no Teams still accepts an Editor).
   *
   * The level itself still goes through `AccessService.grantProjectAccess`, the ONE writer of a
   * `work.project_members` grant (§5's closing sentence, AC-9): the existence check, the
   * active-workspace-member rule, the §2.1 Workspace Admin refusal, the upsert-not-409 rule and both
   * audit events all live there, and the other two journeys — an invitation's initial access (§6.4)
   * and a team roster row (P4-RBAC-010) — reach the same writer from `WorkspaceModule`.
   * `onWorkspaceAdmin: 'refuse'` is this journey's answer specifically: an admin used a permissions
   * screen to ask for a grant, so a 201 that writes nothing would be a lie.
   *
   * ATOMIC, deliberately. The SPA previously wrote the level and then the team rows as separate
   * requests, and its own comment recorded what that cost: one failed team write left the level
   * ALREADY landed with no team rows behind it — §2.2's forbidden state, reached through a dropped
   * connection instead of a click. It mitigated that by ordering the writes (teams first, level last)
   * so a failure left the PREVIOUS level standing. One transaction removes the need for the
   * mitigation: if the team write fails, the level did not land.
   *
   * `teamIds` OMITTED means "leave the memberships alone", and the rule is then evaluated against the
   * ones the user already holds — so a bare level change is still refused if it would leave an Editor
   * with nothing. Absent is not empty here, the same distinction the SPA's draft relies on: `[]`
   * means "remove them all", which for an Editor is exactly what PRJ-08 refuses.
   *
   * A level that `grantsAllTeams` reconciles NOTHING. Existing memberships carry delivery meaning
   * (assignment, Team Status, capacity) and §5.1's journey shows no Team control for an Admin at all,
   * so promoting an Editor keeps their rows and a later demotion is lossless. Only `Remove` clears
   * them (§5.2), through `removeProjectMember`.
   */
  async setProjectAccess(
    workspaceId: string,
    projectId: string,
    userId: string,
    actorId: string,
    input: { accessLevel?: ProjectAccessLevel; teamIds?: string[] },
  ): Promise<ProjectMember> {
    // Existence, not writability — access writes stay open on an ARCHIVED project, because revoking
    // or correcting a grant must never require unarchiving. Same rule as the other member writes.
    await this.getProject(workspaceId, projectId);

    const { projectTeamIds, currentTeamIds } = await this.projectTeamContext(projectId, userId);

    // A team id from OUTSIDE this project is a mistake, not a request to link it: linking is
    // `POST /projects/:id/teams`, a `workspace:edit` action, and silently linking here would let a
    // permissions write reshape the project's delivery model.
    const requested = input.teamIds ? [...new Set(input.teamIds)] : undefined;
    if (requested) {
      const outside = requested.filter((id) => !projectTeamIds.includes(id));
      if (outside.length > 0) {
        throw new PreconditionFailedException(
          'PROJECT_TEAM_NOT_FOUND',
          'One or more teams are not linked to this project',
        );
      }
    }

    const target = grantsAllTeams(input.accessLevel)
      ? currentTeamIds
      : (requested ?? currentTeamIds);

    assertTeamAssignmentForLevel({
      level: input.accessLevel,
      teamIds: target,
      projectHasTeams: projectTeamIds.length > 0,
    });

    const grant = await this.uow.run(async (tx) => {
      await this.teamService.applyTeamMembershipDiff(tx, {
        workspaceId,
        userId,
        actorId,
        add: target.filter((id) => !currentTeamIds.includes(id)),
        remove: currentTeamIds.filter((id) => !target.includes(id)),
      });
      return this.access.grantProjectAccess(
        {
          workspaceId,
          projectId,
          userId,
          ...(input.accessLevel !== undefined && { accessLevel: input.accessLevel }),
          actorId,
          onWorkspaceAdmin: 'refuse',
        },
        tx,
      );
    });
    // The caller owns the invalidation when `grantProjectAccess` runs inside a transaction — it
    // cannot know when that transaction committed. After commit, so a concurrent request cannot
    // repopulate the cache from pre-commit state.
    await this.access.invalidateUser(workspaceId, userId);
    return grant;
  }

  async updateProjectMember(
    workspaceId: string,
    projectId: string,
    memberId: string,
    input: UpdateProjectMemberInput,
    actorId: string,
  ): Promise<ProjectMember> {
    // Deliberately not `assertProjectWritable` — see `addProjectMember`.
    await this.getProject(workspaceId, projectId);

    const member = await this.projectMemberRepo.findMemberById(memberId);
    if (!member || member.projectId !== projectId) {
      throw new NotFoundException('PROJECT_MEMBER_NOT_FOUND', 'Project member not found');
    }

    /**
     * PRJ-08 on the level-ONLY write, against the teams the member already holds.
     *
     * This route carries no team list, so there is nothing to combine — but a bare level change can
     * still reach §2.2's forbidden state, and the SAME named rule decides it (never a second copy
     * here). {@link setProjectAccess} is where a caller supplies Teams alongside the level; this is
     * the surface that says "you already have none, so this level is not available yet".
     */
    if (input.accessLevel !== undefined) {
      const { projectTeamIds, currentTeamIds } = await this.projectTeamContext(
        projectId,
        member.userId,
      );
      assertTeamAssignmentForLevel({
        level: input.accessLevel,
        teamIds: currentTeamIds,
        projectHasTeams: projectTeamIds.length > 0,
      });
    }

    const updated = await this.uow.run(async (tx) => {
      const next = await this.projectMemberRepo.updateMember(memberId, input, tx);
      // Level changes (Admin ⇄ Editor) are the core RBAC administrative write — the
      // Audit Log must show who granted what, when. Same tx as the mutation.
      if (input.accessLevel !== undefined && input.accessLevel !== member.accessLevel) {
        await this.audit.emit(
          {
            action: AUDIT_ACTION.PROJECT_MEMBER_UPDATED,
            resourceType: AUDIT_RESOURCE.PROJECT,
            resourceId: projectId,
            workspaceId,
            actor: { id: actorId },
            projectId,
            changes: {
              before: { userId: member.userId, accessLevel: member.accessLevel },
              after: { userId: member.userId, accessLevel: input.accessLevel },
            },
          },
          tx,
        );
      }
      return next;
    });
    await this.access.invalidateUser(workspaceId, member.userId);
    return updated;
  }

  async removeProjectMember(
    workspaceId: string,
    projectId: string,
    userId: string,
    actorId: string,
  ): Promise<void> {
    // Deliberately not `assertProjectWritable`: REVOKING access must stay possible on an
    // archived project — see `addProjectMember`.
    await this.getProject(workspaceId, projectId);

    const existing = await this.projectMemberRepo.findMember(projectId, userId);
    if (!existing) {
      throw new NotFoundException(
        'PROJECT_MEMBER_NOT_FOUND',
        'User is not a member of this project',
      );
    }

    await this.uow.run(async (tx) => {
      // Also clears the user's team_members rows in this project's teams (repo does
      // both) — same tx as the audit row below.
      await this.projectMemberRepo.removeMember(projectId, userId, actorId, tx);
      await this.audit.emit(
        {
          action: AUDIT_ACTION.PROJECT_MEMBER_REMOVED,
          resourceType: AUDIT_RESOURCE.PROJECT,
          resourceId: projectId,
          workspaceId,
          actor: { id: actorId },
          projectId,
          changes: { before: { userId, accessLevel: existing.accessLevel } },
        },
        tx,
      );
    });
    // RBAC migration Phase 4: invalidate so the removal (No Access) lands on the
    // user's next request.
    await this.access.invalidateUser(workspaceId, userId);
    this.logger.log({ projectId, userId }, 'Project member removed');
  }
}
