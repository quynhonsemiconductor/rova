import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { uuidv7 } from 'uuidv7';

/**
 * Deterministic UUID (v5-style, SHA-1) from an arbitrary business-event key.
 * Used for notification idempotency: the same event → same UUID → the relay's
 * source_event_id unique index de-dupes, while satisfying the UUID column type.
 */
function stableEventId(name: string): string {
  const b = createHash('sha1').update(name).digest().subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC-4122 variant
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
import {
  NotFoundException,
  PermissionDeniedException,
  PreconditionFailedException,
  Span,
  UnitOfWork,
  between,
} from '@platform';
import type { JwtPayload, CursorPayload, PagedResult, DbExecutor } from '@platform';
import { PERMISSION, permissionGrants } from '@shared-kernel';
import {
  isAcceptedScheduleState,
  isCompletedScheduleState,
  type DefectState,
} from '../../../../../db/schema/enums';
import { NotificationSchedulerService } from '@platform/notifications/notification-scheduler.service';
import type {
  NotificationTemplateName,
  NotificationTemplateVars,
} from '@platform/notifications/notification.templates';
import { ProjectsService } from '@modules/projects';
import { AccessService } from '@modules/access';
import { MilestonesService } from '@modules/milestones';
import { IWorkItemRepository, WORK_ITEM_REPOSITORY } from '../domain/ports/work-item.repository';
import {
  ActivityLogger,
  type ActivityChange,
  type ActivityEntityType,
  type ActivityLog,
  type CreateActivityInput,
} from '@modules/activity';
import { ITimeLogRepository, TIME_LOG_REPOSITORY } from '../domain/ports/time-log.repository';
import { IWatcherRepository, WATCHER_REPOSITORY } from '../domain/ports/watcher.repository';
import {
  IWorkItemRelationRepository,
  WORK_ITEM_RELATION_REPOSITORY,
} from '../domain/ports/work-item-relation.repository';
import {
  isAcyclicRelationType,
  type WorkItemRelationView,
} from '../domain/work-item-relation.types';
import type { WorkItemRelationType } from '../../../../../db/schema/enums';
import type {
  WorkItem,
  WorkItemType,
  WorkItemPriority,
  WorkItemScheduleState,
  WorkItemFilters,
  UpdateWorkItemInput,
  TaskTotals,
  MyWorkItem,
  WorkspaceSummary,
  StoryOption,
} from '../domain/work-item.types';
import { teamScopeAdmits } from '../domain/team-read-scope';
import type { TeamReadScope, ProjectTeamScope } from '../domain/team-read-scope';
import type { TimeLog } from '../domain/time-log.types';
import type { Watcher } from '../domain/watcher.types';
import { diffWorkItem } from './activity-diff';
import { EntityAttachmentsService } from '@modules/attachments';
import type { AttachmentRef, EntityAttachment } from '@modules/attachments';
// Repo-level deep-imports for F1/F4's Test Case cascade — see the module's own comment for why
// this is not `TestCasesService`.
import {
  ITestCaseRepository,
  TEST_CASE_REPOSITORY,
} from '@modules/test-cases/domain/ports/test-case.repository';
import {
  ITestResultRepository,
  TEST_RESULT_REPOSITORY,
} from '@modules/test-cases/domain/ports/test-result.repository';

/** Walk an error's `.cause` chain looking for a PG unique-violation (code 23505). */
function isDuplicateKeyError(err: unknown): boolean {
  let current: unknown = err;

  while (true) {
    if (current && typeof current === 'object' && 'code' in current) {
      const c = (current as Record<string, unknown>).code;
      if (c === '23505') return true;
    }
    if (current && typeof current === 'object' && 'cause' in current) {
      current = current.cause;
    } else {
      return false;
    }
  }
}

interface CreateWorkItemOpts {
  description?: string;
  statusId?: string;
  scheduleState?: WorkItemScheduleState;
  priority?: WorkItemPriority;
  assigneeId?: string;
  reporterId?: string;
  parentId?: string;
  teamId?: string;
  iterationId?: string;
  releaseId?: string;
  storyPoints?: string;
  estimateHours?: string;
  todoHours?: string;
  actualHours?: string;
  acceptanceCriteria?: string;
  notes?: string;
  releaseNotes?: string;
  // P3.4 — Defect-specific fields
  severity?: string | null;
  foundInEnvironment?: string | null;
  foundInReleaseId?: string | null;
  rootCause?: string | null;
  resolution?: string | null;
  devOwnerId?: string | null;
  defectState?: string | null;
  fixedInBuild?: string | null;
}

@Injectable()
export class WorkItemsService {
  private readonly logger = new Logger(WorkItemsService.name);

  constructor(
    @Inject(WORK_ITEM_REPOSITORY) private readonly workItemRepo: IWorkItemRepository,
    private readonly activity: ActivityLogger,
    @Inject(TIME_LOG_REPOSITORY) private readonly timeLogRepo: ITimeLogRepository,
    @Inject(WATCHER_REPOSITORY) private readonly watcherRepo: IWatcherRepository,
    @Inject(WORK_ITEM_RELATION_REPOSITORY)
    private readonly relationRepo: IWorkItemRelationRepository,
    private readonly notificationScheduler: NotificationSchedulerService,
    private readonly entityAttachments: EntityAttachmentsService,
    private readonly projectsService: ProjectsService,
    private readonly accessService: AccessService,
    // Owns the milestone-artifact scope rule; see setWorkItemMilestones.
    private readonly milestonesService: MilestonesService,
    private readonly uow: UnitOfWork,
    // F1/F4's Test Case cascade (plan §8 Q1, RULED): repo-level, not `TestCasesService` —
    // `TestCasesModule` imports `WorkItemsModule`, so a service-to-service dependency the other way
    // would be a genuine NestJS module cycle. These two set-based writes carry no authorization
    // logic of their own (the Work Item delete above has already authorised the whole operation).
    @Inject(TEST_CASE_REPOSITORY) private readonly testCaseRepo: ITestCaseRepository,
    @Inject(TEST_RESULT_REPOSITORY) private readonly testResultRepo: ITestResultRepository,
  ) {}

  // ── Activity helpers ────────────────────────────────────────────────────────

  /**
   * Build a single activity input record (does NOT yet persist).
   * Call appendActivity / appendActivityBatch to actually write.
   */
  private buildActivityInput(
    item: WorkItem,
    entityType: ActivityEntityType,
    actorId: string,
    action: string,
    changes: ActivityChange | null,
    metadata: Record<string, unknown> = {},
  ): CreateActivityInput {
    return this.activity.build(
      {
        workspaceId: item.workspaceId,
        projectId: item.projectId,
        entityType,
        entityId: item.id,
        // Anchor task entries to the parent so the item history shows them too.
        contextId: entityType === 'task' ? (item.parentId ?? item.id) : item.id,
      },
      actorId,
      action,
      changes,
      metadata,
    );
  }

  /** Batched append participating in the caller's transaction (shared logger). */
  private appendMany(inputs: CreateActivityInput[], tx?: DbExecutor): Promise<void> {
    return this.activity.log(inputs, { tx });
  }

  /** Single entry — used for created/deleted events where there is only one entry. */
  private async appendActivity(
    tx: DbExecutor,
    item: WorkItem,
    entityType: ActivityEntityType,
    actorId: string,
    action: string,
    changes: ActivityChange | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.appendMany(
      [this.buildActivityInput(item, entityType, actorId, action, changes, metadata)],
      tx,
    );
  }

  // ── List ──────────────────────────────────────────────────────────────────

  async listWorkItems(
    actor: JwtPayload,
    projectId: string,
    filters: WorkItemFilters,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<WorkItem>> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    return this.workItemRepo.listByProject(
      projectId,
      actor.workspaceId,
      filters,
      args,
      await this.teamScopeFor(actor, projectId),
    );
  }

  /**
   * The EDITOR Team scope for one project's READS — the list/count half of {@link assertTeamScope}.
   *
   * Delegated to `AccessService.resolveTeamScope`, which is its single home, so a list and the
   * per-record refusal cannot answer differently for the same caller (BA ruling 2026-08-17: "enforce
   * this consistently in API queries, lists, reports, search, pickers and direct URLs"). A restricted
   * answer of `[]` is passed through as `[]`: the read then returns NOTHING, and flattening it into
   * "unrestricted" is the leak `listReadableProjectIds` documents for its own sentinel.
   */
  private async teamScopeFor(actor: JwtPayload, projectId: string): Promise<TeamReadScope> {
    return this.accessService.resolveTeamScope(actor.workspaceId, actor.sub, projectId);
  }

  /**
   * The project scope BOTH Home aggregates are measured in.
   *
   * `project:view` and not `work_item:view`, matching `ProjectsService.listProjectHealth` — this is
   * the code that answers "may this user see this project at all" (nav.ts states that reading), and
   * the strip counts projects and iterations as well as work items, so one code has to cover the
   * whole tile row. Every current access level that holds one holds the other, and the principal the
   * scope exists for is the one holding NEITHER: with no active `project_members` row, No Access is
   * implicit (SRS §1) and the answer is an empty array, not `null`.
   *
   * It rides `AccessService`'s 5-minute assignment cache, so a revocation lands on the reader's next
   * request after `invalidateUser` — the same latency every other authorization read on this surface
   * has. SRS §8 puts effect at next sign-in, so that is well inside contract.
   */
  private async readableProjectScope(actor: JwtPayload): Promise<string[] | null> {
    return this.accessService.listReadableProjectIds(
      actor.workspaceId,
      actor.sub,
      PERMISSION.PROJECT_VIEW,
    );
  }

  /**
   * Home "My Work" widget — top-N items assigned to the actor, within the projects they may read.
   *
   * `@SelfScoped` on the route is TRUE and was never sufficient: "assigned to me" bounds WHOSE items
   * these are, not which projects they may be read from, and the two are independent. An item stays
   * assigned to a user after their access to its project is removed, so the widget kept naming that
   * project, its key and the item's title on the reader's Home page.
   */
  async listMyWork(actor: JwtPayload, limit: number): Promise<MyWorkItem[]> {
    const readable = await this.readableProjectScope(actor);
    return this.workItemRepo.listMyWork(
      actor.workspaceId,
      actor.sub,
      { limit },
      readable,
      await this.crossProjectTeamScope(actor, readable),
    );
  }

  /**
   * The Team scope for a CROSS-project read, resolved PER PROJECT — because it is per project.
   *
   * A team belongs to projects, and a caller's level differs between them: they may be a per-project
   * `admin` in one (All Teams) and an `editor` in the next (their own Teams only). One workspace-wide
   * set of team ids would therefore be wrong in both directions, so this asks
   * `AccessService.resolveTeamScope` for each readable project and returns only the RESTRICTED answers.
   * Everything absent from the result is unrestricted, which keeps the common case (an admin) free of
   * any predicate at all.
   *
   * `readable === null` is the `listReadableProjectIds` UNRESTRICTED sentinel, and it is returned only
   * for a WORKSPACE-WIDE grant of `project:view`. The only role holding one is `workspace_admin`
   * (`workspace:*`), whom `resolveTeamScope` answers unrestricted for anyway, and custom
   * workspace-tier roles are deleted by ruling — so there is no project list to iterate and no scope to
   * apply. If a future workspace-tier role grants `project:view` to someone who is ALSO a per-project
   * editor, this shortcut becomes wrong and the fix is a project list, not a wider team scope.
   *
   * Cost: one `resolveTeamScope` per readable project, resolved in parallel. The level comes from
   * `effectiveAssignments`' 5-minute cache; only an `editor` project costs a query (its team roster).
   */
  private async crossProjectTeamScope(
    actor: JwtPayload,
    readable: string[] | null,
  ): Promise<ProjectTeamScope[]> {
    if (readable === null || readable.length === 0) return [];
    const scopes = await Promise.all(
      readable.map(async (projectId) => ({
        projectId,
        scope: await this.teamScopeFor(actor, projectId),
      })),
    );
    return scopes.flatMap(({ projectId, scope }) =>
      scope.unrestricted ? [] : [{ projectId, teamIds: scope.teamIds }],
    );
  }

  /**
   * Home summary strip — exact counts over the projects the caller may read (one batched query set).
   *
   * The route's `@AuthorizedInService` decorator has always CLAIMED this ("scoped by
   * listReadableProjectIds") and it was not true: the counts were workspace-wide, so a reader whose
   * access to a project had just been removed still read that project's active-sprint, open-work-item,
   * blocked and open-defect totals — the "Unassigned metadata leak" of GAP-P4-RBAC-003 (AC4). Exactly
   * the same false citation that `listProjectHealth` carried until `project-authz.e2e.spec.ts` was
   * written; a decorator is a note, not a check.
   */
  async getWorkspaceSummary(actor: JwtPayload): Promise<WorkspaceSummary> {
    const readable = await this.readableProjectScope(actor);
    return this.workItemRepo.getWorkspaceSummary(
      actor.workspaceId,
      actor.sub,
      readable,
      await this.crossProjectTeamScope(actor, readable),
    );
  }

  /** Backlog list — story + defect only, server-side filter/search/pagination. */
  async listBacklog(
    actor: JwtPayload,
    projectId: string,
    filters: WorkItemFilters,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<WorkItem>> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    return this.workItemRepo.listBacklog(
      projectId,
      actor.workspaceId,
      filters,
      args,
      await this.teamScopeFor(actor, projectId),
    );
  }

  /**
   * The Story REFERENCE feed — the picker behind a Defect's `Parent Story` field.
   *
   * It answers exactly the question the write path asks ("may this Defect name this Story as its
   * parent?"), which is why it is a route of its own rather than `listBacklog(type: 'story')`:
   * that list is the Backlog SCREEN, defined by `iteration_id IS NULL`, so every Story in a sprint
   * was withheld from a picker whose own server-side rule (`WORK_ITEM_PARENT_SCOPE_MISMATCH` /
   * `WORK_ITEM_INVALID_PARENT_TYPE`) accepts it. A feed that offers less than the write accepts is
   * the same class of fault as `listAssignmentOptions`' old lifecycle filter, recorded in
   * `CLAUDE.md`: "An iteration is assignable by SCOPE, never by LIFECYCLE."
   *
   * The project is resolved (and so authorised as existing/readable) exactly as `listBacklog`
   * does; the guard has already checked `work_item:view` against this same `projectId`, which is
   * what the required query parameter is for.
   */
  async listStoryOptions(actor: JwtPayload, projectId: string): Promise<StoryOption[]> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    return this.workItemRepo.listStoryOptions(
      projectId,
      actor.workspaceId,
      await this.teamScopeFor(actor, projectId),
    );
  }

  // ── Create ────────────────────────────────────────────────────────────────

  /**
   * An archived project is read-only end to end (PRJ-FR-010). The project record and key-gen were
   * guarded, but its CONTENT stayed fully writable — archive then did nothing to stop edits inside
   * the project. Every write path resolves the project anyway, so this check costs no extra query.
   *
   * A DELEGATION, not an implementation. This used to be a copy of
   * `ProjectsService.assertProjectWritable`'s body, and a second home for one rule is why the rule
   * kept drifting: the copy was reached by three methods here while ~19 secondary writes in the
   * same class reached neither it nor the original, and five other modules had no check at all. The
   * wrapper stays only so the call sites below read the same as they did — the code and the message
   * now live in exactly one place, and `void` is deliberate because nothing here wants the row.
   */
  private async assertProjectWritable(workspaceId: string, projectId: string): Promise<void> {
    await this.projectsService.assertProjectWritable(workspaceId, projectId);
  }

  @Span('work-items.create')
  async createWorkItem(
    actor: JwtPayload,
    projectId: string,
    type: WorkItemType,
    title: string,
    opts: CreateWorkItemOpts = {},
  ): Promise<WorkItem> {
    await this.assertProjectWritable(actor.workspaceId, projectId);
    /**
     * "Editor must SELECT one of their assigned Teams when creating a Work Item" (BA ruling
     * 2026-08-17). Omitting the Team is therefore not the Project Backlog's refusal on this path — it
     * is a missing required choice, and the message has to say which choice, so it gets its own code
     * rather than `PROJECT_BACKLOG_ADMIN_ONLY` (which reads as "you may not open that", true of a
     * READ and useless on a form).
     */
    if (opts.teamId === undefined || opts.teamId === null) {
      const scope = await this.accessService.resolveTeamScope(
        actor.workspaceId,
        actor.sub,
        projectId,
      );
      if (!scope.unrestricted) {
        throw new PreconditionFailedException(
          'WORK_ITEM_TEAM_REQUIRED',
          'Select one of your Teams — only a Workspace Admin or Project Admin can file into the Project Backlog',
        );
      }
    }
    // The Team that WAS chosen must be one of theirs, and an Editor with no Team has no scope at all.
    await this.assertTeamScope(actor, { projectId, teamId: opts.teamId ?? null });

    // P1-15: parentId must belong to the same project
    if (opts.parentId) {
      const parent = await this.getWorkItem(actor.workspaceId, opts.parentId);
      if (parent.projectId !== projectId) {
        throw new PreconditionFailedException(
          'WORK_ITEM_PARENT_SCOPE_MISMATCH',
          'Parent work item does not belong to the same project',
        );
      }
      // ...and it must be a row this caller may READ. Naming a parent discloses it: the child then
      // renders the parent's key and title, `listTasks`/child-defect feeds reach it from the other
      // side, and the link is a claim about work the caller may not be able to open. The picker feed
      // (`listStoryOptions`) narrows to the same scope, so this is the server counting exactly the
      // population the screen offers — the property `projectTeamContext` states, and the inverse of
      // the defect that made this feed too NARROW.
      //
      // AFTER the project check on purpose: a cross-project parent must stay
      // `WORK_ITEM_PARENT_SCOPE_MISMATCH` rather than becoming a team refusal about another
      // project's roster.
      await this.assertTeamScope(actor, parent);
      // Defects can only have story parents
      if (type === 'defect' && parent.type !== 'story') {
        throw new PreconditionFailedException(
          'WORK_ITEM_INVALID_PARENT_TYPE',
          'A defect can only be created under a user story',
        );
      }
      // Tasks can only sit under a Work Product — a story or defect (DB design
      // §Work item hierarchy: Story → Task, and task.parent_id → Story/Defect).
      if (type === 'task' && parent.type !== 'story' && parent.type !== 'defect') {
        throw new PreconditionFailedException(
          'WORK_ITEM_INVALID_PARENT_TYPE',
          'A task can only be created under a user story or defect',
        );
      }
      /**
       * A Task carries NO iteration into the write at all (P1-TASK-011, P2-IS-024).
       *
       * Not "must equal the parent's" — that would still be a value the caller owns, and the
       * contract is that it owns none. `trg_task_iteration_from_parent` fills the column from
       * `parent_id` on insert, and the insert uses `RETURNING`, so the created row comes back
       * already carrying the parent's iteration.
       *
       * The guard is here as well as in `createTask` because this method is reachable on its own:
       * `POST /work-items` with `type: 'task'` skips that wrapper entirely, so a refusal only there
       * would be a front door with a lock beside a side door without one.
       */
      if (type === 'task' && opts.iterationId !== undefined) {
        throw new PreconditionFailedException(
          'TASK_ITERATION_DERIVED',
          "A task's iteration follows its parent story or defect and cannot be set directly.",
        );
      }
      // Non-defect, non-task items cannot have a parent (only tasks and defects)
      if (type !== 'defect' && type !== 'task') {
        throw new PreconditionFailedException(
          'WORK_ITEM_INVALID_PARENT_TYPE',
          'Only defects and tasks can have a parent work item',
        );
      }
    }

    // A task ALWAYS belongs to a Work Product (parent_id is NOT NULL for tasks).
    // Reject a missing parent with a clean 422 instead of letting the repo hit a
    // NOT-NULL violation downstream.
    if (type === 'task' && !opts.parentId) {
      throw new PreconditionFailedException(
        'WORK_ITEM_INVALID_PARENT_TYPE',
        'A task must be created under a user story or defect',
      );
    }

    const statusId = await this.resolveStatusId(actor.workspaceId, projectId, opts.statusId);

    // Every scoped reference (team, iteration, release, foundInRelease and the
    // assignee/reporter/dev-owner person refs) is validated through the ONE
    // assignment-scope guard — the same funnel the update and bulk paths use —
    // so a create can't seed an item with a team/iteration/release that belongs
    // to a different project or (for team-scoped iterations) a different team,
    // nor a person from another workspace. Reachable e.g. via the task create
    // flow, which accepts an explicit iteration and inherits the parent's
    // iteration/team. reporterId defaults to the actor (always a member) so only
    // an explicitly-provided reporter is validated.
    await this.assertAssignmentScope(actor.workspaceId, {
      projectId,
      teamId: opts.teamId ?? null,
      iterationId: opts.iterationId ?? null,
      releaseId: opts.releaseId ?? null,
      foundInReleaseId: opts.foundInReleaseId ?? null,
      memberIds: [opts.assigneeId, opts.reporterId, opts.devOwnerId],
      // Owner and Dev Owner go through the shared assignment rule as well; the reporter does not.
      assignableIds: [opts.assigneeId, opts.devOwnerId],
    });
    // An `AccessService.assertTeamScoped` call sat here (and on update and delete). Team scope was
    // deleted as an authorization boundary by ruling — see that method's former home in
    // `access.service.ts` for the reasoning. `assertAssignmentScope` above still validates that the
    // team, iteration and release BELONG to this project; what is gone is the separate question of
    // whether the ACTOR is on the team.

    // Rank is assigned INSIDE the transaction below, under a per-scope advisory
    // lock — see the `create` call. It used to be computed here, on the pool
    // connection, before the transaction opened: a plain read-modify-write with
    // no lock, so two creates in the same project could both read the same max
    // and derive the same rank. That is not hypothetical — this database holds 22
    // scopes where a story and a defect share rank 'i', and equal neighbours make
    // `between()` throw LEXORANK_NEIGHBOURS_OUT_OF_ORDER on the next drag-reorder.

    // item_key reservation is atomic (advisory-locked counter). A failed insert
    // after this point only leaves a numbering gap, which is acceptable.
    // If the counter is out of sync with existing data (e.g. seeded records),
    // retry once with a fresh key.
    const MAX_KEY_RETRIES = 2;
    let workItem: WorkItem | undefined;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
      const itemKey = await this.projectsService.generateItemKey(
        actor.workspaceId,
        projectId,
        type,
      );

      try {
        workItem = await this.uow.run(async (tx) => {
          // Serialise rank assignment for this (project, parent) scope. The lock
          // is transaction-scoped, so it releases on commit or rollback, and it
          // only blocks other creates in the SAME scope. Both the read and the
          // insert now happen on `tx`, so the max cannot go stale between them.
          const rankScope = { projectId, parentId: opts.parentId ?? null };
          await this.workItemRepo.lockRankScope(rankScope, tx);
          const maxRank = await this.workItemRepo.findMaxRank(rankScope, actor.workspaceId, tx);
          // New items append to the end of their scope's order (top-level
          // backlog, or the parent's task list). A degenerate '' rank would sort
          // correctly once but corrupt subsequent between() math on drag-reorder.
          const rank = between(maxRank, null);

          const created = await this.workItemRepo.create(
            {
              id: uuidv7(),
              workspaceId: actor.workspaceId,
              projectId,
              itemKey,
              type,
              title,
              description: opts.description,
              statusId,
              // SoT §2.4: a new Story/Defect defaults Schedule=Flow='idea'
              // (Tasks have their own lifecycle starting at 'defined'). Flow
              // mirrors Schedule at create (BR-WI-01) so the pair is never split.
              scheduleState: opts.scheduleState ?? (type === 'task' ? 'defined' : 'idea'),
              flowState: opts.scheduleState ?? (type === 'task' ? 'defined' : 'idea'),
              priority: opts.priority ?? 'none',
              assigneeId: opts.assigneeId,
              reporterId: opts.reporterId ?? actor.sub,
              parentId: opts.parentId,
              teamId: opts.teamId,
              iterationId: opts.iterationId,
              releaseId: opts.releaseId,
              storyPoints: opts.storyPoints,
              // Real-Rally task time: Estimate is an independent planned value
              // (client-set, never derived). To Do defaults to the Estimate on
              // create until edited (Rally: remaining = planned before work
              // starts). Actuals is a separate manual input. To Do auto-zeroes
              // on completion (see updateWorkItem).
              estimateHours: opts.estimateHours,
              todoHours: type === 'task' ? (opts.todoHours ?? opts.estimateHours) : opts.todoHours,
              actualHours: opts.actualHours,
              acceptanceCriteria: opts.acceptanceCriteria,
              notes: opts.notes,
              releaseNotes: opts.releaseNotes,
              rank,
              createdBy: actor.sub,
              // P3.4 — Defect-specific fields
              severity: opts.severity,
              foundInEnvironment: opts.foundInEnvironment,
              foundInReleaseId: opts.foundInReleaseId,
              rootCause: opts.rootCause,
              resolution: opts.resolution,
              devOwnerId: opts.devOwnerId,
              defectState: opts.defectState,
              fixedInBuild: opts.fixedInBuild,
            },
            tx,
          );

          const isTask = type === 'task';
          await this.appendActivity(
            tx,
            created,
            isTask ? 'task' : 'work_item',
            actor.sub,
            isTask ? 'task.created' : 'work_item.created',
            null,
            isTask
              ? { parentId: created.parentId, title }
              : { title, type, projectId, teamId: opts.teamId ?? null },
          );

          /**
           * "Assign on create" must notify exactly like "assign after create".
           *
           * `updateWorkItem` emitted `WORK_ITEM_ASSIGNED` on an assignee change and this path
           * emitted nothing, so an item created ALREADY assigned — which every Add-Item dialog
           * and the Tasks tab do, and which `createTask` does implicitly by inheriting the
           * parent's assignee — told the assignee nothing at all. Same event, same taxonomy
           * (SRS §5: `assigned` + `mention`), reached by a different verb; the notification is a
           * property of the assignment, not of the endpoint.
           *
           * On the same `tx` as the insert, so a rolled-back create leaves no ghost
           * notification — and inside the retry loop, so a duplicate-key retry re-emits with
           * the row that actually committed.
           */
          await this.notifyAssignment(actor, created, created.assigneeId, tx);
          await this.notifyAssignment(actor, created, created.devOwnerId, tx);

          /**
           * A new task changes the SET the parent is derived from, and Rally says so in its own
           * examples: "adding a task to a story in Idea will make the story Defined" and "adding a
           * task to a story in Completed will make the story In Progress". No trigger covered either,
           * because both are CREATES and every trigger keyed on a state transition.
           */
          if (isTask && created.parentId) {
            await this.reconcileParentScheduleState(actor, created.parentId, tx);
          }

          return created;
        });
        break; // success — exit retry loop
      } catch (err: unknown) {
        lastErr = err;
        if (isDuplicateKeyError(err) && attempt < MAX_KEY_RETRIES - 1) {
          this.logger.warn(
            { itemKey, projectId, attempt: attempt + 1 },
            'Duplicate item key on create — retrying with next key',
          );
          continue;
        }
        throw err; // not a duplicate-key error or last attempt — re-throw
      }
    }

    if (!workItem) throw lastErr;

    this.logger.log(
      { workItemId: workItem.id, itemKey: workItem.itemKey, projectId, type, userId: actor.sub },
      'Work item created',
    );

    // Auto-watch: creator is automatically subscribed (non-blocking, best-effort).
    const autoWatchers = [actor.sub];
    if (workItem.assigneeId && workItem.assigneeId !== actor.sub) {
      autoWatchers.push(workItem.assigneeId);
    }
    this.watcherRepo
      .watchMany(workItem.id, autoWatchers, actor.workspaceId)
      .catch((err: unknown) => {
        this.logger.warn(
          { err, workItemId: workItem.id, watchers: autoWatchers },
          'Auto-watch failed — proceeding without watch',
        );
      });

    return workItem;
  }

  // ── Create task (now writes to tasks table) ────────────────────────

  /**
   * Create a child task under a story/defect (Tasks tab).
   * P3 refactor: tasks now go to the dedicated `tasks` table.
   */
  @Span('work-items.create-task')
  async createTask(
    actor: JwtPayload,
    parentId: string,
    title: string,
    opts: {
      description?: string;
      state?: string;
      assigneeId?: string;
      devOwnerId?: string;
      teamId?: string;
      // No `iterationId`: a Task inherits it through its parent (P1-TASK-011), so passing one is a
      // compile error rather than a runtime refusal. `teamId` stays — a Task's team only DEFAULTS to
      // its parent's and is genuinely settable (SRS P1-04).
      estimateHours?: string;
      todoHours?: string;
      actualHours?: string;
    } = {},
  ): Promise<WorkItem> {
    const parent = await this.getWorkItem(actor.workspaceId, parentId);
    // A task's parent must be a Work Product — a story or defect (never another
    // task, and never an initiative/feature). Matches the generic create guard.
    if (parent.type !== 'story' && parent.type !== 'defect') {
      throw new PreconditionFailedException(
        'WORK_ITEM_INVALID_PARENT_TYPE',
        'A task can only be created under a user story or defect',
      );
    }

    // Delegate to the work-item create flow — the task is created in the
    // dedicated tasks table by the repository layer when type='task'.
    // For now, we still write through the work_items table for backward
    // compatibility, but the service interface accepts the new shape.
    //
    // No `iterationId` is passed and none is accepted: this was
    // `opts.iterationId ?? parent.iterationId`, so a caller's value simply won and the Task started
    // life in a different sprint from its Story — the state P1-TASK-011 and P2-IS-024 both rule out.
    // `createWorkItem` refuses one for a task and the trigger fills the column from the parent.
    return this.createWorkItem(actor, parent.projectId, 'task', title, {
      ...opts,
      parentId: parent.id,
      // Owner is NOT inherited from the parent, and that absence is the point.
      // GAP-P1-WID-007 states the rule without a carve-out — "Work Item and Task Owner default to
      // Unassigned" — and where the BA wants a field derived from the parent it says so in words:
      // three times for Iteration (P1-TASK-011, P2-IS-024), explicitly for Team (P1-04, just below).
      // It wrote no such sentence for Owner.
      //
      // This used to be `opts.assigneeId ?? parent.assigneeId`, and because `CreateTaskSchema`'s
      // `assigneeId` is `.optional()` and NOT `.nullable()` (unlike the update DTO), there was NO WAY
      // through the API to create a genuinely unowned task under an owned Story. So Team Capacity's
      // `Unassigned` row and Team Status's Unassigned group could never show a real planning gap —
      // which is exactly what P6-TC-007 reported as "a null-owner Task attributed to a named member".
      // The projection was innocent; every task simply had an owner nobody chose.
      //
      // It is also unlike the two fields it sat between. Team and Iteration decide WHICH timebox and
      // roster the work belongs to, and the app actively keeps them in step (ITERATION_TEAM_MISMATCH,
      // trg_task_iteration_from_parent, trg_cascade_iteration_to_tasks). Nothing ties a task's owner
      // to its parent's, so the two diverged one edit later — a derived value with no maintainer.
      // Splitting a Story into five tasks assigned all five to whoever owned the Story, who is
      // usually the person breaking the work down rather than the person doing it.
      //
      // The convenience it bought is better spent as a VISIBLE prefill in the Add Task modal, where
      // the reader can see it and change it, than as a server default they can neither see nor refuse.
      // SRS P1-04 (Task Management): team defaults to the parent's team unless
      // explicitly provided, keeping the task's project/team compatible with
      // its parent. createWorkItem still validates a provided team is linked.
      teamId: opts.teamId ?? parent.teamId ?? undefined,
    });
  }

  // ── Get ───────────────────────────────────────────────────────────────────

  async getWorkItem(workspaceId: string, id: string): Promise<WorkItem> {
    const item = await this.workItemRepo.findById(id, workspaceId);
    if (!item || item.deletedAt || item.workspaceId !== workspaceId) {
      throw new NotFoundException('WORK_ITEM_NOT_FOUND', 'Work item not found');
    }
    return item;
  }

  /**
   * An EDITOR reaches only their own Teams' records (`GAP-P4-RBAC-003` AC1/AC3, §2.2/§3.2).
   *
   * One line here rather than the rule itself: `AccessService.assertTeamInScope` is its single home
   * and documents exactly what it does and does not fence. A Workspace Admin and a per-project
   * `admin` are unaffected (All Teams, §3.1), and an Editor with no active Team in the project is
   * refused outright rather than per row.
   *
   * A Task's own `team_id` is what is checked, not its parent's: the column only DEFAULTS to the
   * parent's (SRS P1-04) and stays settable, so the row's own value is the claim about which team
   * owns it. A null stays admitted — see the boundary's own docblock for why that is stated rather
   * than quietly closed.
   */
  private async assertTeamScope(
    actor: JwtPayload,
    item: {
      projectId: string;
      teamId: string | null;
      type?: WorkItemType;
      parentId?: string | null;
    },
  ): Promise<void> {
    await this.accessService.assertTeamInScope(
      actor.workspaceId,
      actor.sub,
      item.projectId,
      await this.resolveRowTeam(actor.workspaceId, item),
    );
  }

  /**
   * WHOSE work a row is, for the access decision — `coalesce(task, parent, iteration)` for a TASK and
   * its own column for a Story/Defect.
   *
   * A Task's team only DEFAULTS to its parent's (SRS P1-04) and is nullable, so a task under a teamed
   * Story ordinarily carries no team of its own. Reading the row's own column alone made the Tasks tab
   * and the record disagree: the grid LISTED such a row (it narrows by the three-tier expression, like
   * `getScopedTaskHours` and Team Status) while `GET /work-items/:taskId` refused it as the Project
   * Backlog. A grid that offers a row nobody can open is the two-call-sites bug this repo keeps
   * re-learning, so the reads share one resolution.
   *
   * The third tier costs a query and is asked for LAST, only when the first two are null — which is
   * also the only case where it can change the answer.
   */
  private async resolveRowTeam(
    workspaceId: string,
    item: { teamId: string | null; type?: WorkItemType; parentId?: string | null },
  ): Promise<string | null> {
    if (item.teamId) return item.teamId;
    if (item.type !== 'task' || !item.parentId) return null;

    const parent = await this.workItemRepo.findById(item.parentId, workspaceId);
    if (parent?.teamId) return parent.teamId;
    if (!parent?.iterationId) return null;
    const scope = await this.workItemRepo.findIterationScope(parent.iterationId, workspaceId);
    return scope?.teamId ?? null;
  }

  /**
   * A Team move takes a named Owner with it, or drops them (`GAP-P1-WID-007` AC5/AC6).
   *
   * "If the Work Item moves to another Team and the old Owner does not belong to the new Team, the
   * system must return Owner to `Unassigned` rather than keep an invalid Owner", and "`No Team` means
   * the Owner returns to `Unassigned` and the dropdown offers only `Unassigned`".
   *
   * IN THE SAME PATCH, and on the SERVER, for two reasons. The rule has to hold on every surface that
   * can move a Team — the detail sidebar, the Backlog cell, a bulk edit, a machine client — and a
   * client that cleared the field itself would be deciding it from a roster it may not have fetched
   * yet. Leaving the stale Owner would also survive as data that no picker on any screen would offer.
   *
   * Conditional, not unconditional: an Owner who is on BOTH teams is a legitimate Owner of the moved
   * item, and clearing them would discard a true value. Membership is asked of
   * `listProjectMemberOptions` — the picker's OWN feed — so the server cannot count a different
   * population than the screen offers, the rule `projectTeamContext` already states.
   *
   * A patch that names an Owner AND a Team at once is judged on what it asks for: the incoming
   * `assigneeId` is the one checked, so setting both in one request works if they agree and clears
   * only when they do not.
   */
  private async resetOwnerOutsideTeam(
    actor: JwtPayload,
    item: WorkItem,
    input: UpdateWorkItemInput,
  ): Promise<void> {
    const nextOwner = input.assigneeId !== undefined ? input.assigneeId : item.assigneeId;
    if (!nextOwner) return;

    const nextTeam = input.teamId ?? null;
    if (nextTeam === null) {
      input.assigneeId = null;
      return;
    }

    const options = await this.projectsService.listProjectMemberOptions(
      actor.workspaceId,
      item.projectId,
      nextTeam,
    );
    if (!options.some((o) => o.userId === nextOwner)) {
      input.assigneeId = null;
    }
  }

  /**
   * THE read path for a route that names a work item — load it, then apply the Team scope.
   *
   * `getWorkItem` is the internal loader and deliberately stays unscoped: `updateWorkItem`,
   * `deleteWorkItem` and other modules need a row in hand BEFORE deciding anything, and some of those
   * decisions are what produce a better error than a scope refusal would. So the scope lives one level
   * up, in the path a READ handler takes.
   *
   * It has to be here rather than only on `GET /work-items/:id`, and that was a live leak: every
   * per-item SUB-RESOURCE read (`:id/activity`, `:id/labels`, `:id/relations`, `:id/milestones`,
   * `:id/time-logs`, `:id/watchers`, `:id/attachments` and the two attachment-download routes, plus
   * `:id/tasks` and its totals) loaded the row through `getWorkItem` and never asked the question.
   * `PolicyGuard`'s `resource: 'work_item'` resolves the row's PROJECT and nothing else, so an Editor on
   * Team Alpha was refused a Team Beta Story and could still read its Revision History, its links, its
   * logged hours, its watchers and — worst, because a signed URL outlives the request — its
   * attachments' bytes. §7 is about the DISCLOSURE, not about the record's own endpoint.
   *
   * `checkProjectPermission` adds the `work_item:view` check for a SECONDARY target the route-scoped
   * guard cannot see (the far end of a relation link). One method with one switch rather than two
   * variants, so a third read path cannot be written that skips the scope.
   */
  private async requireReadable(
    actor: JwtPayload,
    id: string,
    { checkProjectPermission = false }: { checkProjectPermission?: boolean } = {},
  ): Promise<WorkItem> {
    const item = await this.getWorkItem(actor.workspaceId, id);
    if (checkProjectPermission) {
      await this.accessService.assertProjectPermission(
        actor,
        item.projectId,
        PERMISSION.WORK_ITEM_VIEW,
      );
    }
    await this.assertTeamScope(actor, item);
    return item;
  }

  /**
   * Load a work item for a READ and authorize the actor against the item's OWN
   * project via `work_item:view`. Now that the PolicyGuard authorizes the route
   * id up-front, this remains only for SECONDARY targets a route-scoped guard
   * cannot see — e.g. the far end of a relation link, where the actor must be
   * able to view the target too or linking would leak its key/title/state.
   */
  async getWorkItemForView(actor: JwtPayload, id: string): Promise<WorkItem> {
    return this.requireReadable(actor, id, { checkProjectPermission: true });
  }

  /**
   * Resolve a work item by its human item key within a project. Enables the
   * `/item/:itemKey` detail route to open any type — including tasks, whose rows
   * live in `work.tasks` since the Phase 3 split and are therefore invisible to
   * the work_items search used previously.
   */
  async getWorkItemByKey(actor: JwtPayload, itemKey: string): Promise<WorkItem> {
    // Keys are workspace-unique (Rally FormattedID): resolve across the workspace,
    // then enforce view permission on the item's OWN project below.
    const item = await this.workItemRepo.findByKey(itemKey, actor.workspaceId);
    if (!item) {
      throw new NotFoundException('WORK_ITEM_NOT_FOUND', `Work item ${itemKey} not found`);
    }
    await this.accessService.assertProjectPermission(
      actor,
      item.projectId,
      PERMISSION.WORK_ITEM_VIEW,
    );
    // The BA's own repro: an Editor with no Team opened `/item/US-17`, a Pegasus Story, in full.
    await this.assertTeamScope(actor, item);
    return item;
  }

  // ── Tasks (list + totals) ───────────────────────────────────────────────────

  /**
   * The Tasks tab. Two scopes, and both are needed: the PARENT must be readable (a Team Beta Story's
   * tasks are Team Beta's work), and the rows are narrowed again by their own resolved team, because a
   * task's `team_id` is settable independently of its parent's (SRS P1-04).
   */
  async listTasks(actor: JwtPayload, parentId: string): Promise<WorkItem[]> {
    const parent = await this.requireReadable(actor, parentId);
    return this.workItemRepo.listTasksByParent(
      parentId,
      actor.workspaceId,
      await this.teamScopeFor(actor, parent.projectId),
    );
  }

  /** The totals row under {@link listTasks}, measured in the SAME scope as the rows above it. */
  async getTaskTotals(actor: JwtPayload, parentId: string): Promise<TaskTotals> {
    const parent = await this.requireReadable(actor, parentId);
    return this.workItemRepo.getTaskTotals(
      parentId,
      actor.workspaceId,
      await this.teamScopeFor(actor, parent.projectId),
    );
  }

  // ── Activity (Revision History) ──────────────────────────────────────────────

  async getActivity(
    actor: JwtPayload,
    workItemId: string,
    args: { limit: number; offset: number },
  ): Promise<{ items: ActivityLog[]; total: number }> {
    await this.requireReadable(actor, workItemId);
    const page = Math.floor(args.offset / args.limit) + 1;
    const res = await this.activity.listFor(workItemId, actor.workspaceId, page, args.limit);
    return { items: res.data, total: res.total };
  }

  // ── Update ────────────────────────────────────────────────────────────────

  @Span('work-items.update')
  async updateWorkItem(
    actor: JwtPayload,
    id: string,
    input: UpdateWorkItemInput,
  ): Promise<WorkItem> {
    const item = await this.getWorkItem(actor.workspaceId, id);
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    // The record as it stands, BEFORE the patch: an Editor may not edit another Team's item, and may
    // not move one INTO their scope either, so the destination team is checked below as well.
    await this.assertTeamScope(actor, item);
    if (input.teamId !== undefined && input.teamId !== item.teamId) {
      await this.assertTeamScope(actor, {
        projectId: item.projectId,
        teamId: input.teamId ?? null,
      });
      await this.resetOwnerOutsideTeam(actor, item, input);
    }

    // BL §8:294 — an Editor "cannot assign Release". Field-level, because the route is gated on
    // `work_item:edit`, which an Editor holds for every other field in the same body. Only when the
    // patch actually MOVES the release: an unrelated edit on an item that already sits in one must not
    // be refused. See `assertMayAssignRelease` for why this lands now rather than earlier.
    if (input.releaseId !== undefined && input.releaseId !== item.releaseId) {
      await this.assertMayAssignRelease(actor, item.projectId);
    }

    // TASK-FR-012: a task's Work Product (parent) can be reassigned, but the new
    // parent must be a valid work product (US/DE, never a task) in the SAME
    // project — the same scope rules enforced at task creation. A task always
    // belongs to a Work Product, so clearing the parent is rejected.
    if (item.type === 'task' && input.parentId !== undefined && input.parentId !== item.parentId) {
      if (input.parentId === null) {
        throw new PreconditionFailedException(
          'WORK_ITEM_INVALID_PARENT_TYPE',
          'A task must belong to a work product',
        );
      }
      const newParent = await this.getWorkItem(actor.workspaceId, input.parentId);
      if (newParent.projectId !== item.projectId) {
        throw new PreconditionFailedException(
          'WORK_ITEM_PARENT_SCOPE_MISMATCH',
          'Work product does not belong to the same project',
        );
      }
      // Reparenting reaches the DESTINATION row, so it takes the destination's team scope — the same
      // reason `updateWorkItem` re-checks a moving Team rather than only the current one.
      await this.assertTeamScope(actor, newParent);
      if (newParent.type !== 'story' && newParent.type !== 'defect') {
        throw new PreconditionFailedException(
          'WORK_ITEM_INVALID_PARENT_TYPE',
          'A task can only belong to a user story or defect',
        );
      }
    }

    // A defect's User Story (parent_id) can be (re)assigned or cleared. Unlike a
    // task, a defect MAY be unparented (null), but when set the parent must be a
    // user story in the SAME project — mirrors the create-time rule so the
    // "User Story" association can never drift to a non-story or cross-project
    // item (work item hierarchy: Story → Defect).
    if (
      item.type === 'defect' &&
      input.parentId !== undefined &&
      input.parentId !== item.parentId &&
      input.parentId !== null
    ) {
      const newParent = await this.getWorkItem(actor.workspaceId, input.parentId);
      if (newParent.projectId !== item.projectId) {
        throw new PreconditionFailedException(
          'WORK_ITEM_PARENT_SCOPE_MISMATCH',
          'User story does not belong to the same project',
        );
      }
      // The Parent Story the picker offers is team-scoped (`listStoryOptions`); so is the one this
      // write accepts. Without this an Editor could name a Story from another Team — or from the
      // Project Backlog — by passing its id, and the Defect would then render a key and title from a
      // record they cannot open.
      await this.assertTeamScope(actor, newParent);
      if (newParent.type !== 'story') {
        throw new PreconditionFailedException(
          'WORK_ITEM_INVALID_PARENT_TYPE',
          'A defect can only be linked to a user story',
        );
      }
    }

    // Only tasks and defects carry a parent (DB design §Work item hierarchy).
    // Reject any attempt to SET a parent on an initiative / feature / story via
    // the API — mirrors the create-path rule so update can't back-door a parent
    // (or a self-parent / cross-project parent) that create forbids. Portfolio
    // hierarchy editing for these types is out of Phase 1 scope.
    if (
      item.type !== 'task' &&
      item.type !== 'defect' &&
      input.parentId !== undefined &&
      input.parentId !== null &&
      input.parentId !== item.parentId
    ) {
      throw new PreconditionFailedException(
        'WORK_ITEM_INVALID_PARENT_TYPE',
        'Only defects and tasks can have a parent work item',
      );
    }

    // Validate status transition if statusId is changing
    if (input.statusId && input.statusId !== item.statusId) {
      await this.projectsService.assertTransitionAllowed(
        item.projectId,
        item.statusId,
        input.statusId,
      );
    }

    // P2-BL-02: Story items have no editable priority in the backlog.
    if (input.priority && input.priority !== 'none' && item.type === 'story') {
      throw new PreconditionFailedException(
        'WORK_ITEM_STORY_HAS_NO_PRIORITY',
        'Priority is only editable on defects',
      );
    }

    /**
     * A Task has NO Iteration of its own to set (P1-TASK-011, P2-IS-024).
     *
     * The BA says it three times and real Rally shows the field read-only: a Task inherits its
     * Iteration through its parent Story/Defect, and has "no independent Iteration selector". The
     * value is maintained by `trg_task_iteration_from_parent`, so this patch could not take effect
     * anyway — which is precisely why it REFUSES rather than ignores. An endpoint that accepts a
     * field and silently discards it teaches a caller that the write worked; the next read would say
     * otherwise and the trigger would look like the bug.
     *
     * Move the parent instead: `trg_cascade_iteration_to_tasks` takes the tasks with it.
     */
    if (item.type === 'task' && input.iterationId !== undefined) {
      throw new PreconditionFailedException(
        'TASK_ITERATION_DERIVED',
        "A task's iteration follows its parent story or defect and cannot be set directly. Move the parent instead.",
      );
    }

    // Work Item Project and Team must be a valid pair (SRS P1-MANAGE-ORG). All
    // scoped references funnel through the ONE assignment-scope guard, using the
    // team the item WILL have after this patch (input.teamId when changing, else
    // the current team) so a simultaneous team+iteration change is validated
    // against the new team. A null teamId clears the team; the team-link re-check
    // only runs when a team is actually being (re)assigned. Person refs
    // (assignee/reporter/dev-owner) and a defect's foundInRelease are validated
    // here too — only the ones actually changing, so unchanged members aren't
    // re-queried.
    if (input.featureId) {
      await this.assertFeatureLinkable(actor.workspaceId, item.type, input.featureId);
    }

    const effectiveTeamId = input.teamId !== undefined ? input.teamId : item.teamId;
    // The `assertTeamScoped` call that sat here is gone (ruling, 2026-08-14 — see its former home in
    // `access.service.ts`). `effectiveTeamId` is still needed below: it is what
    // `assertIterationAssignable` validates the iteration against.
    /**
     * A TEAM change revalidates the iteration the item already sits in.
     *
     * `iterationId: input.iterationId ?? null` skipped `assertIterationAssignable` whenever the
     * patch did not mention an iteration, so moving an item to another team left it parked in the
     * old team's iteration — the exact state `ITERATION_TEAM_MISMATCH` exists to refuse, reachable
     * in two steps instead of one. The seeded database already contains one (`US-D2`, Team Beta,
     * in Team Alpha's Sprint 26.1) and the Phase 6 reports attribute its points by the iteration,
     * so it counted as Alpha's.
     *
     * Only when the team is actually changing. Re-checking on every unrelated patch would start
     * refusing a title edit on an item whose team and iteration already disagree — a real state
     * in existing data, and not this patch's fault to reject.
     */
    const effectiveIterationId =
      input.iterationId ?? (input.teamId !== undefined ? item.iterationId : null);
    const changedMemberIds: Array<string | null | undefined> = [];
    // Owner and Dev Owner also go through the shared assignment rule; a reporter does not.
    const changedAssignableIds: Array<string | null | undefined> = [];
    if (input.assigneeId && input.assigneeId !== item.assigneeId) {
      changedMemberIds.push(input.assigneeId);
      changedAssignableIds.push(input.assigneeId);
    }
    if (input.reporterId && input.reporterId !== item.reporterId) {
      changedMemberIds.push(input.reporterId);
    }
    if (input.devOwnerId && input.devOwnerId !== item.devOwnerId) {
      changedMemberIds.push(input.devOwnerId);
      changedAssignableIds.push(input.devOwnerId);
    }
    await this.assertAssignmentScope(
      actor.workspaceId,
      {
        projectId: item.projectId,
        teamId: effectiveTeamId,
        iterationId: effectiveIterationId,
        releaseId: input.releaseId ?? null,
        foundInReleaseId: input.foundInReleaseId ?? null,
        memberIds: changedMemberIds,
        assignableIds: changedAssignableIds,
      },
      { validateTeamLink: Boolean(input.teamId) },
    );

    // P3.4 — Validate defect state transitions.
    // SRS §6 (Quality/Defect) confirmed lifecycle:
    //   Submitted → Open → Fixed → Closed, and Submitted/Open → Closed Declined.
    // FR-017: reopen from Closed / Closed Declined is DEFERRED and must be
    // rejected in Phase 3.4 until BA confirms permission + reason + audit rules.
    if (input.defectState !== undefined && input.defectState !== null && item.defectState) {
      const validTransitions: Record<DefectState, DefectState[]> = {
        submitted: ['open', 'closed_declined'],
        open: ['fixed', 'closed_declined'],
        fixed: ['closed'],
        closed: [],
        closed_declined: [],
      };
      const allowed = validTransitions[item.defectState as DefectState] ?? [];
      if (!allowed.includes(input.defectState as DefectState)) {
        throw new PreconditionFailedException(
          'WORK_ITEM_INVALID_TRANSITION',
          `Invalid defect state transition: ${item.defectState} → ${input.defectState}. Allowed: ${allowed.join(', ') || 'none'}`,
        );
      }
    }

    // ── BR-WI-01: Schedule State and Flow State mirror ──
    // Accept a change to EITHER field and apply it to BOTH, so every downstream
    // rule (roll-up, auto-accept, activity log) sees one coherent state. A
    // request that sets the two to conflicting values is rejected.
    if (
      input.scheduleState !== undefined &&
      input.flowState !== undefined &&
      input.scheduleState !== input.flowState
    ) {
      throw new PreconditionFailedException(
        'WORK_ITEM_STATE_MIRROR_CONFLICT',
        'Schedule State and Flow State must match',
      );
    }
    const nextState = input.scheduleState ?? input.flowState;
    if (nextState !== undefined) {
      input.scheduleState = nextState;
      input.flowState = nextState;
    }

    const isTask = item.type === 'task';
    // The parent's own state is reconciled from the whole task set after the write (see
    // `reconcileParentScheduleState`); no per-transition flag decides it any more.

    // Real-Rally task time: Estimate and Actuals are independent, user-owned
    // values — never derived/overwritten. A task reaching a done state has no
    // remaining work, so To Do auto-zeroes (unless the same patch sets it
    // explicitly). Reopening does NOT restore To Do (Rally parity).
    if (isTask) {
      const completing =
        input.scheduleState !== undefined && isCompletedScheduleState(input.scheduleState);
      if (completing && input.todoHours === undefined) {
        input.todoHours = '0';
      }

      /**
       * The FIRST Estimate copies itself to To Do — once, and only while To Do is unset.
       *
       * "If the Owner enters `Estimate` first, the system copies the same number of hours to `To Do`
       * once. After that first copy, `Estimate`, `To Do` and `Actual` do not auto-recalculate each
       * other" (Portfolio SRS:143-144). The create path did this (`todoHours ?? estimateHours`) and
       * the update path did not, so estimating a task that already existed left To Do empty and the
       * planner had to type the same number twice.
       *
       * `null` is the gate, not falsiness: a To Do of `0` is a real answer — a completed task has
       * exactly that — and re-copying the estimate over it would undo the auto-zero above, or
       * silently overwrite a planner who deliberately typed 0.
       */
      const firstEstimate =
        input.estimateHours !== undefined &&
        input.todoHours === undefined &&
        item.todoHours === null;
      if (firstEstimate) {
        input.todoHours = input.estimateHours;
      }
    }

    const entries = diffWorkItem(item, input, isTask);

    const updated = await this.uow.run(async (tx) => {
      // Re-parenting moves the item into a DIFFERENT rank scope, and a rank only
      // orders items within one scope. Carrying the old value across means it
      // lands at an arbitrary position, and usually collides: a defect ranked
      // first under story A keeps that rank when re-parented to story B or back
      // to top level, where the first item already holds it. Re-append it to the
      // end of the destination scope instead, under the same per-scope lock the
      // create path uses.
      const reparenting = input.parentId !== undefined && input.parentId !== item.parentId;
      let rerank: { rank: string } | Record<string, never> = {};
      if (reparenting) {
        const destination = { projectId: item.projectId, parentId: input.parentId ?? null };
        await this.workItemRepo.lockRankScope(destination, tx);
        const maxRank = await this.workItemRepo.findMaxRank(destination, actor.workspaceId, tx);
        rerank = { rank: between(maxRank, null) };
      }

      const updatedInTx = await this.workItemRepo.update(
        id,
        { ...input, ...rerank, ...clearReasonOnUnblock(input), updatedBy: actor.sub },
        actor.workspaceId,
        tx,
      );
      const updated = updatedInTx;

      // Build all diff entries then flush in ONE multi-row INSERT — avoids N
      // sequential round-trips for edits that touch multiple fields at once.
      const entityType = isTask ? ('task' as const) : ('work_item' as const);
      const activityInputs = entries.map((e) =>
        this.buildActivityInput(updated, entityType, actor.sub, e.action, e.change),
      );
      await this.appendMany(activityInputs, tx);

      /**
       * ── Auto-accept: re-evaluate the RULE, not just the write that used to trigger it ──
       *
       * "A non-empty Iteration auto-changes to `Accepted` when all ASSIGNED Story/Defect items are
       * `Accepted`" (BUSINESS_BASELINE:12, BR-IT-02). That is a condition over an iteration's
       * MEMBERSHIP, so every write that can change membership has to re-check it — not only a write
       * that changes a status.
       *
       * This used to require `input.scheduleState` to transition into an accepted state, which left
       * two reachable holes: move the last open Story OUT of an otherwise-accepted iteration, or move
       * an already-accepted Story IN. Both end in exactly the state the rule describes with the
       * iteration still Committed — Timeboxes saying Committed while the Iteration Status tile says
       * ACCEPTED 100%. The BA logged that pairing as DEV-021; the status path was fixed and the scope
       * path was not.
       *
       * BOTH iterations are re-checked on a move: the one the item left may now be complete, and the
       * one it joined may be. `autoAcceptIterationIfComplete` owns the guards (non-empty, all
       * accepted, `planning|committed → accepted` only), so this never auto-REVERSES — which
       * BUSINESS_BASELINE:12 also requires, and which is what makes it safe to run on every move.
       */
      const acceptedTransition =
        input.scheduleState !== undefined &&
        isAcceptedScheduleState(input.scheduleState) &&
        !isAcceptedScheduleState(item.scheduleState);
      const iterationChanged =
        input.iterationId !== undefined && input.iterationId !== item.iterationId;

      if (!isTask && (acceptedTransition || iterationChanged)) {
        const affected = new Set(
          [item.iterationId, input.iterationId !== undefined ? input.iterationId : item.iterationId]
            // `null` is the Backlog, which has no acceptance state of its own.
            .filter((id): id is string => typeof id === 'string'),
        );
        for (const iterationId of affected) {
          const flipped = await this.workItemRepo.autoAcceptIterationIfComplete(
            iterationId,
            actor.workspaceId,
            tx,
          );
          if (flipped) {
            this.logger.log(
              { iterationId },
              'Iteration auto-accepted — all assigned Story/Defect items are accepted',
            );
          }
        }
      }

      /**
       * The parent Story/Defect's Schedule State is DERIVED FROM ITS TASKS, and it is reconciled from
       * the whole set rather than nudged by whichever transition happened. See
       * {@link reconcileParentScheduleState}: three separate trigger branches lived here, one per
       * event, and that shape is what let a third trigger go missing for a year.
       */
      if (isTask && item.parentId && input.scheduleState !== undefined) {
        await this.reconcileParentScheduleState(actor, item.parentId, tx);
      }

      // ── F7 notifications ──
      // Enqueued on the same `tx` as the business write, so the outbox row
      // commits/rolls back atomically with it — no ghost notification, no
      // silent drop on a post-commit crash. Recipient resolution (watchers +
      // permission checks) reads already-committed data off the pool; only
      // the outbox insert itself needs the transaction.

      /**
       * Assignment: notify (and auto-watch) whoever was NEWLY named — Owner or Dev Owner.
       *
       * `P4-NOTIF-DC-012` covers both fields, so both are checked the same way and through one loop:
       * a third responsibility later cannot pick up only half of the behaviour, which is how Dev Owner
       * came to notify nobody at all.
       */
      const newlyAssigned = (
        [
          [input.assigneeId, updated.assigneeId, item.assigneeId],
          [input.devOwnerId, updated.devOwnerId, item.devOwnerId],
        ] as const
      )
        .filter(([patched, next, before]) => patched !== undefined && !!next && next !== before)
        .map(([, next]) => next as string);
      for (const recipientId of [...new Set(newlyAssigned)]) {
        await this.watcherRepo
          .watch(updated.id, recipientId, actor.workspaceId)
          .catch(() => undefined);
        await this.notifyAssignment(actor, updated, recipientId, tx);
      }

      // NOTE: schedule-state changes intentionally do NOT notify. The Phase 4.1
      // notification taxonomy is `assigned` + `mention` only (SRS §5); status
      // changes are explicitly out of scope.

      return updated;
    });

    return updated;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  @Span('work-items.delete')

  /**
   * Reconcile a parent Story/Defect's Schedule State from the CURRENT state of its live tasks.
   *
   * Rally derives the parent from the whole task SET, not from whichever transition just happened
   * (Broadcom, "Task State Updates Parent Schedule State"):
   *
   *   • all tasks `Defined`   → parent `Defined`
   *   • all tasks `Completed` → parent `Completed`
   *   • otherwise             → parent `In Progress`
   *
   * WHY A RECOMPUTE AND NOT MORE TRIGGERS. This replaced three per-event branches — all-complete,
   * task-reopened, task-started — and that shape is the defect: `TASK-FR-016` states the first two, the
   * third was only ever a comment quoting Rally, and a Story sat at `Defined` with a task under it
   * In-Progress for as long as the code existed. A set-derived rule has no third trigger to forget, and
   * it picks up the two cases no trigger covered at all: Rally's own examples "adding a task to a story
   * in Idea will make the story Defined" and "adding a task to a story in Completed will make the story
   * In Progress" are task CREATES, and deleting the last open task is a DELETE.
   *
   * `accepted` AND `release` ARE RECONCILED LIKE ANY OTHER STATE, and this was very nearly built the
   * other way. Guarding a sign-off reads as the safe choice — Broadcom's page is silent on those two
   * states, so the literal rule un-accepts a Story because somebody added a task. The repo had already
   * decided it: `P3-TS-FR-041`, BA-confirmed 2026-07-24, moves a parent back "from ANY at-or-past-
   * completed state — `completed`, `accepted` OR `release`" when a child task reopens, and
   * `work-items.service.spec.ts` has asserted exactly that since. A guard here would have contradicted
   * a confirmed rule and its own test, so the set-derived form keeps the ruling instead of quietly
   * narrowing it. Reversing it later means exempting those states HERE and retiring that case.
   *
   * ONE DELIBERATE DIVERGENCE FROM RALLY, recorded in CLAUDE.md and put to the BA: Rally gates the
   * whole behaviour behind a project/subscription `Auto State Updates` setting, which is how it
   * reconciles automation with `TASK-FR-016`'s "user may still change the parent status manually". We
   * have no such switch, so a manual parent state survives only until the next task write. If the BA
   * wants the manual edit to win, that switch is the answer, not weakening this rule.
   *
   * A parent with NO live tasks is left untouched: there is nothing to derive from, and a Story whose
   * last task was deleted must not be pulled back to `Defined` on that evidence.
   */
  private async reconcileParentScheduleState(
    actor: JwtPayload,
    parentId: string,
    tx?: DbExecutor,
  ): Promise<void> {
    const counts = await this.workItemRepo.taskStateCounts(parentId, actor.workspaceId, tx);
    if (counts.total === 0) return;

    const parent = await this.workItemRepo.findById(parentId, actor.workspaceId, tx);
    if (!parent) return;

    const derived: WorkItemScheduleState =
      counts.completed === counts.total
        ? 'completed'
        : counts.defined === counts.total
          ? 'defined'
          : 'in_progress';
    if (derived === parent.scheduleState) return;

    await this.workItemRepo.update(
      parentId,
      { scheduleState: derived, updatedBy: actor.sub },
      actor.workspaceId,
      tx,
    );
    const fresh = await this.workItemRepo.findById(parentId, actor.workspaceId, tx);
    if (fresh) {
      // `auto: true` is how a reader tells a roll-up from someone editing the Story by hand, and the
      // first thing to check when the rule is reported as not firing.
      await this.appendMany(
        [
          this.buildActivityInput(
            fresh,
            'work_item',
            actor.sub,
            'work_item.schedule_state_changed',
            { field: 'scheduleState', old: parent.scheduleState, new: derived },
            { auto: true },
          ),
        ],
        tx,
      );
    }
  }

  async deleteWorkItem(actor: JwtPayload, id: string): Promise<void> {
    const item = await this.getWorkItem(actor.workspaceId, id);
    await this.assertTeamScope(actor, item);
    /**
     * A DEFECT IS DELETABLE (BA report, 2026-08-20), and this reverses Phase 3.4.
     *
     * `DEFECT_DELETE_FORBIDDEN` used to be thrown here for every principal, Workspace Admin included,
     * on Phase 3.4's rule that a defect is resolved by moving it to `closed` / `closed_declined` "so
     * the audit trail survives". That was already a mismatch INSIDE the BA's own documents —
     * §3.2:81 gives `Quality / Defects` the verb `Delete` in all three granted columns — and
     * `server-role-matrix.e2e.spec.ts` has been recording it as one, unresolved, with a note not to fix
     * either side without a ruling. The BA reporting "cannot delete defect in Backlog and Iteration
     * Status" is that ruling, so §3.2:81 wins.
     *
     * The audit argument does not survive the reading either way: this is a SOFT delete (`deleted_at`),
     * so the row and its `activity` history are still there — a deleted defect is invisible, not
     * erased, and it is recoverable in the database. Nothing about the closed states changes; resolving
     * a defect remains the ordinary path, and deleting is now available where the matrix said it was.
     */
    // An `assertTeamScoped` call sat here too, and is gone by the same ruling (2026-08-14).
    await this.assertProjectWritable(actor.workspaceId, item.projectId);

    /**
     * The delete RECORDS ITSELF, and it RETAINS everything hanging off the row.
     *
     * `P3-QA-FR-020`: "Soft delete retains child Tasks, attachments, comments and relations, records
     * the actor/action and performs no physical cascade delete."
     *
     * Relations used to be physically deleted here, to stop a dangling link surviving on the OTHER
     * item — but `WorkItemRelationDrizzleRepository.listForItem` already filters
     * `isNull(other.deletedAt)` in BOTH directions, so the read hides them anyway. The cascade was
     * therefore doing nothing a reader could see, while making the soft delete PARTLY
     * irreversible: restoring the row in the database brought back a defect whose links were gone
     * for good. Retaining them is what makes `deleted_at` the only thing a delete changes.
     *
     * The activity row is the "records the actor/action" half. `activity_logs.action` is a free
     * varchar, so this needs no migration, and the entry lands in the item's own Revision History —
     * which the item keeps, because nothing here erases history either.
     *
     * Test Cases are the ONE thing that IS cascaded (Phase 7 plan §8 Q1, RULED 2026-09-08) — a
     * Test Case with no reachable Work Product would be invisible and unreachable in the UI (D2's
     * standalone surface is not scheduled), unlike Tasks/attachments/comments/relations which stay
     * reachable through the retained parent. `test_results.test_case_id` carries `ON DELETE
     * cascade`, but that FK never fires for a SOFT delete (an UPDATE, not a DELETE) — the app does
     * explicitly, as one set-based UPDATE per table, what the FK cannot. All four writes — the Work
     * Item's own soft delete, its activity row, the Test Case cascade and the Results cascade — run
     * on the SAME transaction, so a Work Item deleted with its Test Cases left live (or the reverse,
     * on a rollback) can never happen.
     */
    await this.uow.run(async (tx) => {
      await this.workItemRepo.softDelete(id, actor.workspaceId, tx);

      const testCaseIds = await this.testCaseRepo.listLiveIdsByWorkItem(id, actor.workspaceId, tx);
      if (testCaseIds.length > 0) {
        await this.testResultRepo.softDeleteByTestCaseIds(testCaseIds, actor.workspaceId, tx);
        await this.testCaseRepo.softDeleteByWorkItem(id, actor.workspaceId, tx);
      }

      await this.appendMany(
        [
          this.buildActivityInput(
            item,
            item.type === 'task' ? 'task' : 'work_item',
            actor.sub,
            item.type === 'task' ? 'task.deleted' : 'work_item.deleted',
            null,
          ),
        ],
        tx,
      );
      // Deleting a task changes the set its parent is derived from — deleting the last OPEN one
      // completes the parent, exactly as completing it would have. Runs after the delete, on the
      // SAME tx, so the census counts live rows only and the whole thing commits together.
      if (item.type === 'task' && item.parentId) {
        await this.reconcileParentScheduleState(actor, item.parentId, tx);
      }
    });
    this.logger.log({ workItemId: id }, 'Work item soft-deleted');
  }

  // ── Notifications (F7) ──────────────────────────────────────────────────────
  // Producers enqueue in-app notifications for the item's watchers + assignee
  // (minus the actor). The Worker relay applies each recipient's preference and
  // handles delivery/SSE — this layer only fans out candidates.

  /**
   * FR-019 — restrict notification recipients to users allowed to access the
   * item's project. Effective per-project permissions are resolved from role
   * assignments (a workspace-scoped role grants access without a membership
   * row), so this is NOT a project_members lookup. Users lacking
   * `work_item:view` on the project are dropped.
   */
  private async filterByProjectAccess(
    workspaceId: string,
    projectId: string,
    userIds: string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const results = await Promise.all(
      userIds.map(async (userId) => {
        const perms = await this.accessService.getProjectPermissions(
          userId,
          workspaceId,
          projectId,
        );
        return permissionGrants(perms, PERMISSION.WORK_ITEM_VIEW) ? userId : null;
      }),
    );
    return results.filter((id): id is string => id !== null);
  }

  /**
   * The ONE place an assignment notification is produced — both the create and the update path
   * call this, because "assigned on create" and "assigned later" are the same event and had
   * already drifted into being two different products.
   *
   * Two rules are enforced here rather than at either call site, so a third write path cannot
   * lose one of them:
   *
   *   • BOTH RESPONSIBILITIES notify, on a Story, a Defect AND a Task. `P4-NOTIF-DC-012` (BA
   *     `c42df59`, 2026-08-22): an assignment notification is created when the user "is newly assigned
   *     as `Owner` or `Dev Owner` of a US/DE/Task". One template and one business event for both, per
   *     `P4-NOTIF-DC-015` — "inline edit and Detail Page assignment use the same
   *     assignment-notification business event" — so the surface never changes what the recipient gets.
   *   • the ACTOR is never notified of their own assignment. Self-assignment is the normal way
   *     someone picks up work, and a notification about a click you just made is noise.
   *   • FR-019 applies to an ASSIGNMENT, not only to a mention. The assignee is validated as an
   *     active WORKSPACE member (`assertAssignmentScope` → `assertWorkspaceMember`), never as
   *     someone who can SEE this project — so an item may legitimately be assigned to a colleague
   *     with No Access, and an unfiltered notification would name the item, its key and its title
   *     on the one surface §7 says must disclose nothing.
   *
   * Filtered rather than refused: assigning across an access boundary is a real thing an admin may
   * do deliberately (they may be about to grant access), and failing the whole write because of a
   * notification would be worse than not sending one. The assignment stands; the notification does
   * not.
   */
  private async notifyAssignment(
    actor: JwtPayload,
    item: WorkItem,
    recipientId: string | null | undefined,
    tx: DbExecutor,
  ): Promise<void> {
    if (!recipientId) return;
    const notifiable = await this.filterByProjectAccess(
      item.workspaceId,
      item.projectId,
      recipientId === actor.sub ? [] : [recipientId],
    );
    if (notifiable.length === 0) return;
    await this.emitWorkItemNotification(
      'WORK_ITEM_ASSIGNED',
      item,
      actor.sub,
      notifiable,
      { itemKey: item.itemKey, itemTitle: item.title, projectId: item.projectId },
      // The RECIPIENT is the discriminator, not the Owner field: it makes the notification unique per
      // person, so one patch naming the same user as both Owner and Dev Owner tells them once.
      recipientId,
      tx,
    );
  }

  /**
   * Pass `tx` when called from inside an open business transaction (e.g. the
   * update path) so the outbox insert commits/rolls back atomically with the
   * business write — no ghost notification, no silent drop on a post-commit
   * crash. Callers outside a transaction (e.g. comment notifications) may
   * omit it; the scheduler falls back to its own best-effort transaction.
   */
  private async emitWorkItemNotification<K extends NotificationTemplateName>(
    template: K,
    item: WorkItem,
    actorId: string,
    recipientIds: string[],
    vars: NotificationTemplateVars[K],
    discriminator: string,
    tx?: DbExecutor,
  ): Promise<void> {
    await Promise.all(
      recipientIds.map((recipientId) =>
        this.notificationScheduler
          .schedule(
            {
              workspaceId: item.workspaceId,
              recipientId,
              actorId,
              template,
              vars,
              resourceId: item.id,
              // The relay writes idempotencyKey into in_app_notifications.source_event_id
              // (a UUID). Derive a deterministic UUID from the business-event key so
              // dedup still holds while satisfying the column type.
              idempotencyKey: stableEventId(
                `${template}:${item.id}:${recipientId}:${discriminator}`,
              ),
            },
            tx,
          )
          .catch((err: unknown) =>
            this.logger.warn(
              { err, template, workItemId: item.id, recipientId },
              'Failed to enqueue work-item notification',
            ),
          ),
      ),
    );
  }

  /**
   * F7 — fan out comment + mention notifications. Called by CollaborationService
   * after a comment is persisted. Auto-watches the commenter (BA rule).
   */
  async notifyCommentAdded(
    actor: JwtPayload,
    workItemId: string,
    mentionedUserIds: string[] = [],
  ): Promise<void> {
    const item = await this.getWorkItem(actor.workspaceId, workItemId);
    // Commenter auto-watches the item so they receive follow-up activity.
    await this.watcherRepo.watch(workItemId, actor.sub, actor.workspaceId).catch(() => undefined);

    const vars = { itemKey: item.itemKey, itemTitle: item.title, projectId: item.projectId };
    // FR-019: mentions may name anyone; keep only users who can access the project.
    const mentioned = await this.filterByProjectAccess(
      item.workspaceId,
      item.projectId,
      mentionedUserIds.filter((id) => id && id !== actor.sub),
    );

    // Only @-mentions notify. A generic comment with no mention must NOT create
    // any notification (SRS FR-018; the taxonomy is `assigned` + `mention` only).
    if (mentioned.length > 0) {
      await this.emitWorkItemNotification(
        'WORK_ITEM_MENTIONED',
        item,
        actor.sub,
        mentioned,
        vars,
        workItemId,
      );
    }
  }

  // ── Relations (F6 — work-item linking) ──────────────────────────────────────

  @Span('work-items.list-relations')
  async listRelations(actor: JwtPayload, id: string): Promise<WorkItemRelationView[]> {
    // Authorize a read on the item's own project AND its Team (project isolation + the Editor scope).
    await this.requireReadable(actor, id);
    return this.admitRelationEnds(
      actor,
      await this.relationRepo.listForItem(id, actor.workspaceId),
    );
  }

  /**
   * A relation VIEW is mostly its far end — `relatedItem` carries that item's key, title, type and
   * schedule state — so the list has to be filtered by what the reader may see at the OTHER end, not
   * only at this one. `linkWorkItem` checks the target through `getWorkItemForView` when the link is
   * CREATED, and that check does not survive: access is removed, Teams change, and the row stays.
   *
   * Two facts per far end, both resolved once per distinct project:
   *   • `work_item:view` on its project — cross-project links are legal (see `linkWorkItem`), so the
   *     far end may sit in a project this reader has no access to at all;
   *   • the Editor Team scope, via the same `resolveTeamScope` every list here uses.
   *
   * FILTERED, not refused: the relation belongs to the item being read, and failing the whole request
   * because one link points somewhere private would make an unrelated item unreadable — the same
   * reasoning `notifyAssignee` states for dropping a recipient rather than rejecting the write. A
   * far end that cannot be resolved at all is dropped too (fail closed).
   *
   * A far end that is a TASK is judged on its own `team_id`, which is what `assertTeamInScope` does for
   * a task record; the three-tier `coalesce` is used only where the parent is already in hand (the
   * Tasks tab). A task under a teamed Story with no team of its own is therefore dropped here — a
   * narrower answer than the Tasks tab gives, never a wider one.
   */
  private async admitRelationEnds(
    actor: JwtPayload,
    relations: WorkItemRelationView[],
  ): Promise<WorkItemRelationView[]> {
    if (relations.length === 0) return relations;
    const farEnds = await this.workItemRepo.findByIds(
      [...new Set(relations.map((r) => r.relatedItem.id))],
      actor.workspaceId,
    );
    const byId = new Map(farEnds.map((item) => [item.id, item]));
    const projectIds = [...new Set(farEnds.map((item) => item.projectId))];
    const scopes = new Map(
      await Promise.all(
        projectIds.map(
          async (projectId) =>
            [
              projectId,
              {
                readable: await this.canReadProject(actor, projectId),
                team: await this.teamScopeFor(actor, projectId),
              },
            ] as const,
        ),
      ),
    );
    return relations.filter((relation) => {
      const farEnd = byId.get(relation.relatedItem.id);
      if (!farEnd) return false;
      const scope = scopes.get(farEnd.projectId);
      if (!scope?.readable) return false;
      return teamScopeAdmits(scope.team, farEnd.teamId);
    });
  }

  /** `work_item:view` on one project, as a boolean — the filtering half of `assertProjectPermission`. */
  private async canReadProject(actor: JwtPayload, projectId: string): Promise<boolean> {
    const permissions = await this.accessService.getProjectPermissions(
      actor.sub,
      actor.workspaceId,
      projectId,
    );
    return permissionGrants(permissions, PERMISSION.WORK_ITEM_VIEW);
  }

  @Span('work-items.link')
  async linkWorkItem(
    actor: JwtPayload,
    sourceId: string,
    targetId: string,
    relationType: WorkItemRelationType,
  ): Promise<WorkItemRelationView[]> {
    // Editing the source item's links requires edit on its project.
    const sourceItem = await this.requireReadable(actor, sourceId);
    /**
     * The SOURCE's project only — the relation row belongs to the item that owns it.
     *
     * Cross-project links are legal (see the target check below), so the target may well sit in an
     * archived project. Refusing on that would make an archived project able to block edits in
     * projects that are still live, which is not what "read-only" means (PRJ-FR-010).
     */
    await this.assertProjectWritable(actor.workspaceId, sourceItem.projectId);

    if (sourceId === targetId) {
      throw new PreconditionFailedException(
        'WORK_ITEM_RELATION_SELF',
        'A work item cannot be linked to itself',
      );
    }

    // Target must exist AND the actor must be allowed to view it. Cross-project
    // links are allowed, but only to items the actor can already see — otherwise
    // linking would leak a target's key/title/type/state via GET :id/relations.
    await this.getWorkItemForView(actor, targetId);

    if (await this.relationRepo.exists(sourceId, targetId, relationType, actor.workspaceId)) {
      throw new PreconditionFailedException(
        'WORK_ITEM_RELATION_EXISTS',
        'This relation already exists',
      );
    }

    // Reject the same relation in the REVERSE direction too (target → source):
    // for symmetric types (relates_to) it is a duplicate, for directional ones
    // (blocks / depends_on / duplicates) it is a contradiction. The unique index
    // only guards the exact source→target→type triple, so check the mirror here.
    if (await this.relationRepo.exists(targetId, sourceId, relationType, actor.workspaceId)) {
      throw new PreconditionFailedException(
        'WORK_ITEM_RELATION_EXISTS',
        'This relation already exists in the opposite direction',
      );
    }

    // Guard against dependency cycles for ordering relations (blocks/depends_on).
    if (isAcyclicRelationType(relationType)) {
      const cycle = await this.relationRepo.wouldCreateCycle(
        sourceId,
        targetId,
        relationType,
        actor.workspaceId,
      );
      if (cycle) {
        throw new PreconditionFailedException(
          'WORK_ITEM_RELATION_CYCLE',
          `Adding this ${relationType} relation would create a dependency cycle`,
        );
      }
    }

    /**
     * The link and its history are ONE write.
     *
     * This was a bare `create` followed by a `void`-ed best-effort append: the row landed and the
     * `work_item.relation_added` entry was fire-and-forget outside any transaction, so a failed
     * append left a relation with no trace of who added it or when — on the surface (Revision
     * History) whose entire purpose is to answer that. Every other activity write in this service
     * takes the transaction handle; these two were the exceptions.
     */
    const source = await this.requireReadable(actor, sourceId);
    await this.uow.run(async (tx) => {
      await this.relationRepo.create(
        { sourceItemId: sourceId, targetItemId: targetId, relationType, createdBy: actor.sub },
        actor.workspaceId,
        tx,
      );
      await this.appendActivity(
        tx,
        source,
        'work_item',
        actor.sub,
        'work_item.relation_added',
        null,
        { relationType, targetId },
      );
    });

    return this.relationRepo.listForItem(sourceId, actor.workspaceId);
  }

  @Span('work-items.unlink')
  async unlinkWorkItem(actor: JwtPayload, sourceId: string, relationId: string): Promise<void> {
    const sourceItem = await this.requireReadable(actor, sourceId);
    // Same scope as `linkWorkItem` — the source's project owns the relation row.
    await this.assertProjectWritable(actor.workspaceId, sourceItem.projectId);
    const relation = await this.relationRepo.findById(relationId, actor.workspaceId);
    if (!relation) {
      throw new NotFoundException('WORK_ITEM_RELATION_NOT_FOUND', 'Relation not found');
    }
    // The relation must actually touch the source item (either end).
    if (relation.sourceItemId !== sourceId && relation.targetItemId !== sourceId) {
      throw new NotFoundException(
        'WORK_ITEM_RELATION_NOT_FOUND',
        'Relation does not belong to this work item',
      );
    }
    // Unlink + history in one transaction, for the reason given in `linkWorkItem`.
    const source = await this.requireReadable(actor, sourceId);
    await this.uow.run(async (tx) => {
      await this.relationRepo.delete(relationId, actor.workspaceId, tx);
      await this.appendActivity(
        tx,
        source,
        'work_item',
        actor.sub,
        'work_item.relation_removed',
        null,
        { relationType: relation.relationType, relationId },
      );
    });
  }

  // ── Move (board transition) ───────────────────────────────────────────────

  @Span('work-items.move')
  async moveWorkItem(actor: JwtPayload, id: string, toStatusId: string): Promise<WorkItem> {
    return this.updateWorkItem(actor, id, { statusId: toStatusId });
  }

  // ── Reorder (backlog drag-and-drop) ───────────────────────────────────────

  async reorderWorkItems(
    actor: JwtPayload,
    items: Array<{ id: string; rank: string }>,
  ): Promise<void> {
    if (items.length === 0) return;
    // Validate all items belong to this workspace before updating
    const existing = await Promise.all(
      items.map(({ id }) => this.getWorkItem(actor.workspaceId, id)),
    );
    if (existing.some((w) => w.workspaceId !== actor.workspaceId)) {
      throw new Error('Workspace mismatch');
    }
    // Authorize edit on every project the batch touches (usually one backlog), and refuse the
    // whole reorder if any of them is archived (PRJ-FR-010). All-or-nothing, like the permission
    // check above and like the transaction below: a partially applied reorder is a corrupted order.
    for (const projectId of new Set(existing.map((w) => w.projectId))) {
      await this.accessService.assertProjectPermission(actor, projectId, PERMISSION.WORK_ITEM_EDIT);
      await this.assertProjectWritable(actor.workspaceId, projectId);
    }
    // And every ROW must be one the caller can reach (BA ruling 2026-08-17). Rank is order, which is
    // planning data: reordering another Team's backlog — or the Project Backlog's — changes what their
    // grid says without touching a field. Per row rather than per project, because the project check
    // above is exactly the one that cannot see a team.
    for (const item of existing) {
      await this.assertTeamScope(actor, item);
    }
    // Wrap in UoW so all rank UPDATEs are one atomic transaction with RLS active.
    await this.uow.run((tx) => this.workItemRepo.reorderItems(items, actor.workspaceId, tx));
  }

  // ── Neighbour-based reorder (P2-BL-05) ────────────────────────────────────

  /**
   * Reorder a single backlog item between two neighbours by computing a
   * LexoRank strictly between their ranks — a single-row UPDATE, no full
   * re-numbering. `beforeId`/`afterId` are the items immediately above/below
   * the target's new position (either may be null at a list boundary).
   */
  @Span('work-items.rank')
  async rankWorkItem(
    actor: JwtPayload,
    id: string,
    opts: { projectId: string; beforeId?: string | null; afterId?: string | null },
  ): Promise<WorkItem> {
    const item = await this.requireReadable(actor, id);
    if (item.projectId !== opts.projectId) {
      throw new PreconditionFailedException(
        'WORK_ITEM_PARENT_SCOPE_MISMATCH',
        'Work item does not belong to the given project',
      );
    }
    // Rank is backlog order, which is project content (PRJ-FR-010). Checked after the scope
    // mismatch above so the item's OWN project is the one guarded, not the caller's claim.
    await this.assertProjectWritable(actor.workspaceId, item.projectId);

    // Resolve neighbour ranks; each neighbour must be in the same project/backlog.
    const neighbourIds = [opts.beforeId, opts.afterId].filter(
      (n): n is string => typeof n === 'string',
    );
    const neighbours = await this.workItemRepo.findByIds(neighbourIds, actor.workspaceId);
    const byId = new Map(neighbours.map((w) => [w.id, w]));

    const rankOf = (nid: string | null | undefined): string | null => {
      if (!nid) return null;
      const n = byId.get(nid);
      if (!n || n.projectId !== opts.projectId) {
        throw new PreconditionFailedException(
          'WORK_ITEM_PARENT_SCOPE_MISMATCH',
          'Neighbour item is not in the same project backlog',
        );
      }
      return n.rank;
    };

    const lowRank = rankOf(opts.beforeId);
    const highRank = rankOf(opts.afterId);

    let newRank: string;
    try {
      newRank = between(lowRank, highRank);
    } catch {
      // Neighbours out of order (stale client view) — reject rather than corrupt order.
      throw new PreconditionFailedException(
        'WORK_ITEM_RANK_CONFLICT',
        'Backlog order changed; refresh and retry',
      );
    }

    return this.uow.run((tx) =>
      this.workItemRepo.update(id, { rank: newRank, updatedBy: actor.sub }, actor.workspaceId, tx),
    );
  }

  // ── Bulk assignment (P2-BL-03 / P2-BL-04) ─────────────────────────────────

  /**
   * Assign (or unassign, when releaseId is null) a release to many items in one
   * all-or-nothing transaction. Every item must be in the given workspace/project;
   * the release must belong to that project. Any violation fails the whole call.
   */
  @Span('work-items.bulk-release')
  async bulkAssignRelease(
    actor: JwtPayload,
    projectId: string,
    itemIds: string[],
    releaseId: string | null,
  ): Promise<number> {
    const items = await this.loadBulkItems(actor, projectId, itemIds);
    // Before the project scope check, and for a CLEAR as well as an assign — see
    // `assertMayAssignRelease`.
    await this.assertMayAssignRelease(actor, projectId);
    if (releaseId) {
      await this.assertReleaseAssignable(actor.workspaceId, projectId, releaseId);
    }
    await this.uow.run((tx) =>
      this.workItemRepo.assignRelease(
        items.map((i) => i.id),
        releaseId,
        actor.workspaceId,
        actor.sub,
        tx,
      ),
    );
    this.logger.log({ projectId, count: items.length, releaseId }, 'Bulk release assigned');
    return items.length;
  }

  /**
   * Assign (or unassign, when iterationId is null) an iteration to many items in
   * one all-or-nothing transaction. Every item must be a story/defect in the
   * given workspace/project; the iteration must share that project and, when the
   * iteration is team-scoped, the same team. Any violation fails the whole call.
   */
  @Span('work-items.bulk-iteration')
  async bulkAssignIteration(
    actor: JwtPayload,
    projectId: string,
    itemIds: string[],
    iterationId: string | null,
  ): Promise<number> {
    const items = await this.loadBulkItems(actor, projectId, itemIds);

    // P2.1 scope: only stories and defects can be scheduled into an iteration.
    const nonBacklog = items.find((i) => i.type !== 'story' && i.type !== 'defect');
    if (nonBacklog) {
      throw new PreconditionFailedException(
        'WORK_ITEM_NOT_BACKLOG_TYPE',
        'Only stories and defects can be assigned to an iteration',
      );
    }

    if (iterationId) {
      for (const item of items) {
        await this.assertIterationAssignable(actor.workspaceId, item, iterationId);
      }
    }

    // Every iteration this batch touches: the ones the items are LEAVING and the one they are joining.
    // Bulk-assigning accepted work into a committed iteration satisfies the auto-accept rule just as a
    // status change does, and this path never checked it at all.
    const affectedIterations = new Set(
      [...items.map((i) => i.iterationId), iterationId].filter(
        (id): id is string => typeof id === 'string',
      ),
    );

    await this.uow.run(async (tx) => {
      await this.workItemRepo.assignIteration(
        items.map((i) => i.id),
        iterationId,
        actor.workspaceId,
        actor.sub,
        tx,
      );
      for (const affected of affectedIterations) {
        const flipped = await this.workItemRepo.autoAcceptIterationIfComplete(
          affected,
          actor.workspaceId,
          tx,
        );
        if (flipped) {
          this.logger.log(
            { iterationId: affected },
            'Iteration auto-accepted after bulk assignment',
          );
        }
      }
    });
    this.logger.log({ projectId, count: items.length, iterationId }, 'Bulk iteration assigned');
    return items.length;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  /**
   * Load and validate a set of item ids for a bulk operation: all must exist,
   * be non-deleted, and belong to the given workspace/project. Fails the whole
   * request (all-or-nothing) if any id is missing or out of scope.
   *
   * Both callers are WRITES (`bulkAssignRelease`, `bulkAssignIteration`) and both reach the
   * archived-project rule through here rather than each stating it, for the same reason
   * `CapacityPlansService` puts it in `requireDraft`: a bulk path added later is guarded by
   * construction. Every item is proven to be in `projectId` below, so one check covers the batch.
   */
  private async loadBulkItems(
    actor: JwtPayload,
    projectId: string,
    itemIds: string[],
  ): Promise<WorkItem[]> {
    // Authorization (work_item:edit on projectId) is enforced by the PolicyGuard
    // on the bulk routes; here we only validate the selection is in-scope.
    await this.assertProjectWritable(actor.workspaceId, projectId);
    const ids = [...new Set(itemIds)];
    if (ids.length === 0) {
      throw new PreconditionFailedException('WORK_ITEM_EMPTY_SELECTION', 'No items selected');
    }
    const items = await this.workItemRepo.findByIds(ids, actor.workspaceId);
    if (items.length !== ids.length) {
      throw new NotFoundException('WORK_ITEM_NOT_FOUND', 'One or more work items were not found');
    }
    const outOfProject = items.find((i) => i.projectId !== projectId);
    if (outOfProject) {
      throw new PreconditionFailedException(
        'WORK_ITEM_PARENT_SCOPE_MISMATCH',
        'All items must belong to the same project',
      );
    }
    /**
     * EVERY item in the selection, not the project it names (BA ruling 2026-08-17).
     *
     * A bulk write is the cheapest way to reach a row a reader cannot open: the guard authorises the
     * PROJECT in the body, so without this an Editor could bulk-assign another Team's Stories — or the
     * Project Backlog's — a release or an iteration, one request, no UI needed. All-or-nothing, like
     * every other rule on these two routes: a partial success would leave the caller guessing which
     * ids landed.
     *
     * Sequential rather than `Promise.all` on purpose: the first refusal is the answer, and the team
     * scope is served from one cached assignment read per (workspace, user) anyway.
     */
    for (const item of items) {
      await this.assertTeamScope(actor, item);
    }
    return items;
  }

  /**
   * An iteration is assignable to a work item when it exists in the same workspace,
   * shares the item's project, and — if the iteration is team-scoped — shares
   * the item's team. Team-agnostic iterations (teamId null) accept any team.
   */
  private async assertIterationAssignable(
    workspaceId: string,
    item: Pick<WorkItem, 'projectId' | 'teamId'>,
    iterationId: string,
  ): Promise<void> {
    const scope = await this.workItemRepo.findIterationScope(iterationId, workspaceId);
    if (!scope) {
      throw new NotFoundException('ITERATION_NOT_FOUND', 'Iteration not found');
    }
    if (scope.projectId !== item.projectId) {
      throw new PreconditionFailedException(
        'ITERATION_PROJECT_MISMATCH',
        'Iteration must belong to the same project as the work item',
      );
    }
    if (scope.teamId && item.teamId && scope.teamId !== item.teamId) {
      throw new PreconditionFailedException(
        'ITERATION_TEAM_MISMATCH',
        'Iteration must belong to the same team as the work item',
      );
    }
  }

  /** A release is assignable when it exists in the same workspace and project. */
  /**
   * A Story/Defect may link to exactly one active FEATURE.
   *
   * Three refusals, each for a different reason:
   *   • a TASK carries no portfolio link — its Work Product does, and letting a Task hold one
   *     would double-count it in every rollup that walks `feature_id`;
   *   • an EPIC is not a link target. Rally attaches the story hierarchy to the LOWEST portfolio
   *     level only, and our rollup counts an Epic's children through its Features — a story
   *     pointed straight at an Epic would be counted by the Epic and by nothing else;
   *   • an ARCHIVED Feature is hidden from every portfolio surface, so work linked to it would
   *     roll up into a row nobody can see.
   *
   * The Feature does NOT have to be in the same project. Rally lets a team project's Story roll up
   * to a portfolio project's Feature, and `rollupSubqueries` matches on `feature_id` alone; the
   * project+release filter is Rally's CAPACITY rule, not its portfolio rule.
   */
  private async assertFeatureLinkable(
    workspaceId: string,
    itemType: WorkItemType,
    featureId: string,
  ): Promise<void> {
    if (itemType === 'task') {
      throw new PreconditionFailedException(
        'WORK_ITEM_FEATURE_LINK_NOT_ALLOWED',
        'A task inherits its Feature from its work product',
      );
    }
    const target = await this.workItemRepo.findPortfolioItemLinkTarget(featureId, workspaceId);
    if (!target) {
      throw new NotFoundException('PORTFOLIO_ITEM_NOT_FOUND', 'Portfolio item not found');
    }
    if (target.type !== 'feature') {
      throw new PreconditionFailedException(
        'WORK_ITEM_FEATURE_LINK_NOT_FEATURE',
        'Work items link to a Feature; an Epic rolls up through its Features',
      );
    }
    if (target.archived) {
      throw new PreconditionFailedException(
        'WORK_ITEM_FEATURE_LINK_ARCHIVED',
        'That Feature is archived',
      );
    }
  }

  /**
   * Assigning — or clearing — a Release is an ADMIN action, per BL §8:294: "Editor may manage
   * US/DE/Task only in explicitly assigned Teams and **cannot assign Release**."
   *
   * The route can't express this: `PATCH /work-items/:id` and `PATCH /work-items/bulk-release` are
   * gated on `work_item:edit`, which an Editor legitimately holds for every other field in the same
   * body. So the rule is a FIELD-level check, and it lives here in one place rather than at each of the
   * three call sites that can move a release.
   *
   * **This was failing closed BY ACCIDENT until now**, and that is why it is being added at this moment
   * rather than earlier: `GET /releases` required `release:view`, which an Editor does not hold, so the
   * release picker resolved to `[]` and the UI could not produce a `releaseId` to send. Splitting off
   * `GET /releases/options` (a reference feed an Editor CAN read, so a released item stops rendering as
   * unscheduled) removed that accident and made the write reachable. A fix that turns a latent
   * over-permissive write into a live one has to close it in the same change.
   *
   * `release:view` is the code, not a new one: the authority to schedule work into a release is the
   * authority to see releases at all, and `ACCESS_LEVEL_PERMISSIONS` already gives it to `admin` and
   * withholds it from `editor` — which is exactly §294's line. Clearing is gated too: §294 says an
   * Editor does not decide release membership, and removing an item from a release decides it just as
   * much as adding one.
   */
  private async assertMayAssignRelease(actor: JwtPayload, projectId: string): Promise<void> {
    await this.accessService.assertProjectPermission(actor, projectId, PERMISSION.RELEASE_VIEW);
  }

  private async assertReleaseAssignable(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<void> {
    const releaseProjectId = await this.workItemRepo.findReleaseProject(releaseId, workspaceId);
    if (!releaseProjectId) {
      throw new NotFoundException('RELEASE_NOT_FOUND', 'Release not found');
    }
    if (releaseProjectId !== projectId) {
      throw new PreconditionFailedException(
        'RELEASE_PROJECT_MISMATCH',
        'Release must belong to the same project as the work item',
      );
    }
  }

  private async resolveStatusId(
    workspaceId: string,
    projectId: string,
    requested?: string,
  ): Promise<string> {
    const statuses = await this.projectsService.listStatuses(workspaceId, projectId);
    if (requested) {
      const found = statuses.find((s) => s.id === requested);
      if (!found) {
        throw new NotFoundException(
          'WORKFLOW_STATUS_NOT_FOUND',
          'Status not found for this project',
        );
      }
      return requested;
    }
    const defaultStatus = statuses.find((s) => s.isDefault) ?? statuses[0];
    if (!defaultStatus) {
      throw new PreconditionFailedException(
        'WORKFLOW_STATUS_NOT_FOUND',
        'No workflow status configured for this project',
      );
    }
    return defaultStatus.id;
  }

  /**
   * The ONE guard every create/update path funnels its scoped references
   * through, so no mutation can silently skip validation and no rule is
   * duplicated per call site. Given the item's authoritative project and the
   * team it effectively has, it validates each *provided* reference:
   *   - team         → must be actively linked to the project (SRS P1-MANAGE-ORG)
   *   - iteration    → must share the project and, if team-scoped, the team
   *   - release      → must share the project
   *   - foundInRelease (defect) → must share the project (same rule as release)
   *   - member ids (assignee/reporter/devOwner) → must be active workspace members
   * `validateTeamLink` lets the update path pass the effective team for the
   * iteration match without re-checking a team that isn't changing. Callers pass
   * only the member ids that are new/changed so an unchanged assignee isn't
   * re-queried. Add a new scoped field here once and every mutation path is
   * covered.
   */
  private async assertAssignmentScope(
    workspaceId: string,
    scope: {
      projectId: string;
      teamId?: string | null;
      iterationId?: string | null;
      releaseId?: string | null;
      foundInReleaseId?: string | null;
      memberIds?: Array<string | null | undefined>;
      /** Owner / Dev Owner — the subset the shared assignment rule applies to. */
      assignableIds?: Array<string | null | undefined>;
    },
    opts: { validateTeamLink?: boolean } = {},
  ): Promise<void> {
    const validateTeamLink = opts.validateTeamLink ?? true;
    if (validateTeamLink && scope.teamId) {
      await this.projectsService.assertTeamLinkedToProject(
        workspaceId,
        scope.projectId,
        scope.teamId,
      );
    }
    if (scope.iterationId) {
      await this.assertIterationAssignable(
        workspaceId,
        { projectId: scope.projectId, teamId: scope.teamId ?? null },
        scope.iterationId,
      );
    }
    if (scope.releaseId) {
      await this.assertReleaseAssignable(workspaceId, scope.projectId, scope.releaseId);
    }
    if (scope.foundInReleaseId) {
      await this.assertReleaseAssignable(workspaceId, scope.projectId, scope.foundInReleaseId);
    }
    const memberIds = [
      ...new Set((scope.memberIds ?? []).filter((id): id is string => Boolean(id))),
    ];
    for (const userId of memberIds) {
      await this.projectsService.assertWorkspaceMember(workspaceId, userId);
    }
    /**
     * OWNER AND DEV OWNER ALSO SATISFY THE ASSIGNMENT RULE, not just workspace membership.
     *
     * The BA states the candidate list and the validation as one rule (`c42df59`, 2026-08-22): with a
     * Team, an active Project Admin, an Editor assigned to THAT team, or a Workspace Admin who is a
     * member of it; with no Team, a Project Admin only. Until now the write checked only that the
     * person was an active member of the workspace — two orders of magnitude wider than the picker,
     * so any user id in the body was accepted for work no picker would have offered them.
     *
     * `reporterId` is deliberately NOT included: a reporter records who raised the item, not who may
     * be given it, and narrowing it would refuse a legitimate filer.
     */
    const assignableIds = [
      ...new Set((scope.assignableIds ?? []).filter((id): id is string => Boolean(id))),
    ];
    for (const userId of assignableIds) {
      await this.projectsService.assertAssignable(
        workspaceId,
        scope.projectId,
        scope.teamId ?? null,
        userId,
      );
    }
  }

  // ── Labels ────────────────────────────────────────────────────────────────

  async getWorkItemLabels(
    actor: JwtPayload,
    id: string,
  ): Promise<Array<{ id: string; name: string; color: string }>> {
    await this.requireReadable(actor, id);
    return this.workItemRepo.listLabels(id);
  }

  async addLabelToWorkItem(actor: JwtPayload, id: string, labelId: string): Promise<void> {
    const item = await this.requireReadable(actor, id);
    // The label CATALOGUE is already guarded on an archived project
    // (`ProjectsService.createLabel`); the ASSIGNMENT was not, so labels could not be created on an
    // archived project but could still be applied and removed.
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    // P1-15: label must belong to the same project as the work item
    await this.projectsService.assertLabelBelongsToProject(item.projectId, labelId);
    await this.workItemRepo.addLabel(id, labelId, actor.workspaceId);
  }

  async removeLabelFromWorkItem(actor: JwtPayload, id: string, labelId: string): Promise<void> {
    const item = await this.requireReadable(actor, id);
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    await this.workItemRepo.removeLabel(id, labelId, actor.workspaceId);
  }

  // ── Milestones ──────────────────────────────────────────────────────────────

  async getWorkItemMilestones(
    actor: JwtPayload,
    id: string,
  ): Promise<Array<{ id: string; name: string }>> {
    await this.requireReadable(actor, id);
    return this.workItemRepo.listMilestones(id);
  }

  /**
   * Replace-set of the milestones assigned to a work item.
   *
   * The TWIN write is `PUT /milestones/:id/artifacts`, and it writes the same `milestone_artifacts`
   * rows from the other end. It enforced three conditions; this one enforced a weaker version of
   * the first and neither of the other two — so a Task could become a Milestone artifact, and any
   * item could join a Team-scoped Milestone, purely by choosing this endpoint. The rule now has one
   * home (`assertArtifactsInMilestoneScope`, reached through `MilestonesService`), so the two
   * endpoints cannot answer differently again.
   */
  async setWorkItemMilestones(
    actor: JwtPayload,
    id: string,
    milestoneIds: string[],
  ): Promise<Array<{ id: string; name: string }>> {
    const item = await this.requireReadable(actor, id);
    // The ITEM's project. The MILESTONE's project is checked by `assertArtifactsAssignable` — the
    // two can differ, because a milestone's scope spans `milestone_projects`, and one row written
    // from this end touches both.
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    const uniqueIds = [...new Set(milestoneIds)];
    if (uniqueIds.length > 0) {
      await this.milestonesService.assertArtifactsAssignable(actor.workspaceId, uniqueIds, [item]);
    }
    await this.workItemRepo.setMilestones(id, uniqueIds);
    return this.workItemRepo.listMilestones(id);
  }

  // ── Time Logging ──────────────────────────────────────────────────────────

  @Span('work-items.list-time-logs')
  async listTimeLogs(
    actor: JwtPayload,
    workItemId: string,
    args: { page: number; pageSize: number },
  ): Promise<{ items: TimeLog[]; total: number }> {
    await this.requireReadable(actor, workItemId);
    return this.timeLogRepo.listByWorkItem(workItemId, actor.workspaceId, {
      limit: args.pageSize,
      offset: (args.page - 1) * args.pageSize,
    });
  }

  @Span('work-items.log-time')
  async logTime(
    actor: JwtPayload,
    workItemId: string,
    input: { loggedDate: string; hours: string; description?: string },
  ): Promise<TimeLog> {
    const item = await this.requireReadable(actor, workItemId);
    /**
     * Logged hours are project content, so all three time-log writes are guarded (PRJ-FR-010).
     *
     * Worth stating because "I did this work, let me record it" reads like it should survive an
     * archive: it does not, because Actual hours feed Team Status, Team Capacity and the Iteration
     * Status totals, and a project someone is still booking time against has not been archived. The
     * remedy is to restore the project, which is one action.
     */
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    const log = await this.timeLogRepo.create({
      id: uuidv7(),
      workspaceId: actor.workspaceId,
      workItemId,
      userId: actor.sub,
      loggedDate: input.loggedDate,
      hours: input.hours,
      description: input.description,
    });
    // Auto-watch the user who logs time so they receive future notifications.
    this.watcherRepo.watch(workItemId, actor.sub, actor.workspaceId).catch((err: unknown) => {
      this.logger.warn({ err, workItemId }, 'Auto-watch on time-log failed — proceeding');
    });
    this.logger.log({ workItemId, logId: log.id, userId: actor.sub }, 'Time logged');
    return log;
  }

  @Span('work-items.update-time-log')
  async updateTimeLog(
    actor: JwtPayload,
    workItemId: string,
    logId: string,
    input: { loggedDate?: string; hours?: string; description?: string | null },
  ): Promise<TimeLog> {
    const item = await this.requireReadable(actor, workItemId);
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    const log = await this.timeLogRepo.findById(logId, actor.workspaceId);
    if (!log || log.workItemId !== workItemId) {
      throw new NotFoundException('TIME_LOG_NOT_FOUND', 'Time log entry not found');
    }
    // Only the log owner may edit their entry.
    if (log.userId !== actor.sub) {
      throw new PermissionDeniedException(
        'TIME_LOG_NOT_OWNER',
        'Only the log owner may edit this entry',
      );
    }
    return this.timeLogRepo.update(logId, input);
  }

  @Span('work-items.delete-time-log')
  async deleteTimeLog(actor: JwtPayload, workItemId: string, logId: string): Promise<void> {
    const item = await this.requireReadable(actor, workItemId);
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    const log = await this.timeLogRepo.findById(logId, actor.workspaceId);
    if (!log || log.workItemId !== workItemId) {
      throw new NotFoundException('TIME_LOG_NOT_FOUND', 'Time log entry not found');
    }
    // Workspace admins can retract any log; regular users only their own.
    const isAdmin = permissionGrants(
      await this.accessService.getWorkspacePermissions(actor.sub, actor.workspaceId),
      PERMISSION.WORKSPACE_EDIT,
    );
    if (!isAdmin && log.userId !== actor.sub) {
      throw new PermissionDeniedException(
        'TIME_LOG_NOT_OWNER',
        'Only the log owner or a workspace admin may delete this entry',
      );
    }
    await this.timeLogRepo.softDelete(logId);
    this.logger.log({ workItemId, logId, userId: actor.sub }, 'Time log deleted');
  }

  // ── Watchers ──────────────────────────────────────────────────────────────
  //
  // `watch` and `unwatch` are deliberately NOT guarded by `assertProjectWritable`.
  //
  // A watcher row is the READER'S OWN subscription, not the project's content — the same
  // judgement `ProjectsService` already made for its three member writes ("access is not the
  // project's content"), and for the same decisive reason: the withdrawal has to keep working.
  // A user who cannot unwatch an archived project's items is stuck receiving its notifications
  // with no way to stop, and nothing about being archived makes that acceptable. `watch` stays
  // open with it, because guarding one half and not the other is a trap: `logTime`'s auto-watch
  // aside, a person who wants to follow an item until the project is restored is asking for
  // nothing the project can be harmed by.

  @Span('work-items.list-watchers')
  async listWatchers(actor: JwtPayload, workItemId: string): Promise<Watcher[]> {
    await this.requireReadable(actor, workItemId);
    return this.watcherRepo.listByWorkItem(workItemId, actor.workspaceId);
  }

  @Span('work-items.watch')
  async watch(actor: JwtPayload, workItemId: string): Promise<void> {
    await this.requireReadable(actor, workItemId);
    await this.watcherRepo.watch(workItemId, actor.sub, actor.workspaceId);
  }

  @Span('work-items.unwatch')
  async unwatch(actor: JwtPayload, workItemId: string): Promise<void> {
    await this.requireReadable(actor, workItemId);
    await this.watcherRepo.unwatch(workItemId, actor.sub);
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  //
  // Thin delegations to `EntityAttachmentsService`. The mechanics — quota, presign,
  // confirm, the reaper contract, the delete-owner rule — are identical for every entity
  // that can own files and moved to `@modules/attachments` with migration 0083. What stays
  // here is what is genuinely work-item-specific: proving the item exists, which also
  // resolves the `projectId` the activity log needs.
  //
  // Route authorization is unchanged: `WorkItemsController` still gates these on
  // `work_item:edit` / `work_item:view` for the path item's project.
  //
  // The file id is the public attachment id. Callers never see the link row.

  private static attachmentRef(workItemId: string): AttachmentRef {
    return { entityType: 'work_item', entityId: workItemId };
  }

  @Span('work-items.presign-attachment')
  async presignAttachment(
    actor: JwtPayload,
    workItemId: string,
    input: { filename: string; mimeType: string; sizeBytes: number; checksumSha256: string },
  ): Promise<{ attachmentId: string; uploadUrl: string; requiredHeaders: Record<string, string> }> {
    const item = await this.requireReadable(actor, workItemId);
    /**
     * Refused at PRESIGN, not only at confirm.
     *
     * Presign reserves a `storage.files` row and hands out a signed PUT, so letting it through and
     * refusing the confirm would put bytes in the bucket for a project that accepts no content and
     * leave the row to the reaper. Guarded here rather than inside `EntityAttachmentsService`
     * because that service states its own rule — it "never loads a work item or a portfolio item"
     * and takes its `projectId` from the caller — and an `entityType → project` lookup in there is
     * exactly the owner-type registry its docblock refuses.
     */
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    return this.entityAttachments.presign(actor, WorkItemsService.attachmentRef(workItemId), input);
  }

  @Span('work-items.confirm-attachment')
  async confirmAttachment(
    actor: JwtPayload,
    workItemId: string,
    attachmentId: string,
  ): Promise<EntityAttachment> {
    const item = await this.requireReadable(actor, workItemId);
    // Checked again at confirm: presign and confirm are two requests, and a project archived
    // between them must not gain a visible attachment. Same reason the quota is re-checked there.
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    return this.entityAttachments.confirm(
      actor,
      WorkItemsService.attachmentRef(workItemId),
      attachmentId,
      item.projectId,
    );
  }

  @Span('work-items.list-attachments')
  async listAttachments(actor: JwtPayload, workItemId: string): Promise<EntityAttachment[]> {
    await this.requireReadable(actor, workItemId);
    return this.entityAttachments.list(actor, WorkItemsService.attachmentRef(workItemId));
  }

  @Span('work-items.get-attachment-download-url')
  async getAttachmentDownloadUrl(
    actor: JwtPayload,
    workItemId: string,
    attachmentId: string,
  ): Promise<{ downloadUrl: string }> {
    // Both `:aid/download` and `:aid/content` land here, and a signed URL OUTLIVES the request that
    // minted it — so this is the one read where a missing scope keeps leaking after the refusal.
    await this.requireReadable(actor, workItemId);
    return this.entityAttachments.downloadUrl(
      actor,
      WorkItemsService.attachmentRef(workItemId),
      attachmentId,
    );
  }

  @Span('work-items.delete-attachment')
  async deleteAttachment(
    actor: JwtPayload,
    workItemId: string,
    attachmentId: string,
  ): Promise<void> {
    const item = await this.requireReadable(actor, workItemId);
    await this.assertProjectWritable(actor.workspaceId, item.projectId);
    await this.entityAttachments.delete(
      actor,
      WorkItemsService.attachmentRef(workItemId),
      attachmentId,
      item.projectId,
    );
  }
}

/**
 * Unblocking an item clears its Blocked Reason.
 *
 * Rally: "When a blocked status is removed, the Blocked Reason field is cleared"
 * (Broadcom TechDocs, Task Board app). A reason that outlives its block is not history — it
 * is a claim that the item is blocked for that reason, sitting next to a flag that says it is
 * not. The UI made this visible: the reason cell is only editable WHILE blocked, so a stale
 * reason could be read but never removed.
 *
 * Applied in the SERVICE rather than the DTO or the client, so every caller gets it — the
 * inline cell, the detail pane, and any future bulk path — and applied even when the same
 * patch also sends a reason: `isBlocked: false` wins, because the two cannot both be true.
 *
 * The old reason is not lost. `activity-diff.ts` tracks `isBlocked` and `blockedReason`, so
 * the transition and the text it replaced are both in the activity log.
 */
function clearReasonOnUnblock(input: UpdateWorkItemInput): { blockedReason?: null } {
  return input.isBlocked === false ? { blockedReason: null } : {};
}
