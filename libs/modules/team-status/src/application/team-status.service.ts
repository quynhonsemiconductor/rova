import { Inject, Injectable, Logger } from '@nestjs/common';
import { PreconditionFailedException, ValidationException, type JwtPayload } from '@platform';
import { IterationsService } from '@modules/iterations';
import { WorkItemsService, type UpdateWorkItemInput } from '@modules/work-items';
import { ProjectsService } from '@modules/projects';
import { AccessService } from '@modules/access';
import {
  ITeamStatusRepository,
  TEAM_STATUS_REPOSITORY,
} from '../domain/ports/team-status.repository';
import type { WorkItemScheduleState } from '../../../../../db/schema/enums';
import type {
  TeamStatusResponse,
  TeamStatusMemberGroup,
  TeamStatusOwner,
  TeamStatusTaskRow,
  TeamTaskState,
  UpdateCapacityInput,
  UpdateTaskFromTeamStatusInput,
  RawTeamStatusTaskRow,
} from '../domain/team-status.types';

/**
 * schedule_state (D1) → Team Status display bucket (SRS §8.5). Exhaustively
 * keyed on WorkItemScheduleState so a future state addition/rename is a compile
 * error. The three task_state values (defined/in_progress/completed) are a
 * subset of these keys, so the same map covers dedicated-task rows too.
 */
const STATE_NORMALIZE: Record<WorkItemScheduleState, TeamTaskState> = {
  idea: 'Defined',
  defined: 'Defined',
  in_progress: 'In-Progress',
  completed: 'Completed',
  accepted: 'Completed',
  release: 'Completed',
};

@Injectable()
export class TeamStatusService {
  private readonly logger = new Logger(TeamStatusService.name);

  constructor(
    @Inject(TEAM_STATUS_REPOSITORY)
    private readonly repo: ITeamStatusRepository,
    private readonly iterationsService: IterationsService,
    private readonly workItemsService: WorkItemsService,
    // For `assertProjectWritable` in `updateCapacity`. `updateTask` needs nothing here: it writes
    // through `WorkItemsService.updateWorkItem`, which already carries the rule.
    private readonly projectsService: ProjectsService,
    // The Editor Team scope (BA ruling 2026-08-17) — `editor` holds `team_status:view`, so this
    // surface has to narrow like every other read.
    private readonly access: AccessService,
  ) {}

  /**
   * Build the full Team Status response (P3-TS-FR-001 … P3-TS-FR-015).
   */
  async getTeamStatus(
    actor: JwtPayload,
    projectId: string,
    teamId: string | undefined | null,
    iterationId: string,
  ): Promise<TeamStatusResponse> {
    // Validate iteration exists and belongs to the project.
    const iteration = await this.iterationsService.getIteration(actor.workspaceId, iterationId);
    if (iteration.projectId !== projectId) {
      throw new PreconditionFailedException(
        'ITERATION_PROJECT_MISMATCH',
        'Iteration does not belong to this project',
      );
    }

    /**
     * The Editor Team scope reaches this screen too (BA ruling 2026-08-17: enforce it "consistently in
     * API queries, lists, reports, search, pickers and direct URLs").
     *
     * `editor` DOES hold `team_status:view`, and this service passed the query's `teamId` straight
     * through — so an Editor could name any team, or omit it for All Teams, and the repository's
     * three-tier `coalesce(task, parent, iteration)` predicate then admitted other teams' tasks AND
     * team-less ones, which are now the Project Backlog.
     *
     * A requested team is ASSERTED rather than quietly narrowed: answering about team B with team A's
     * rows would read as "team B logged no hours", which is worse than a refusal. All Teams is narrowed
     * to the caller's own teams instead, because for an Editor that is what All Teams means.
     */
    const teamScope = await this.access.resolveTeamScope(
      actor.workspaceId,
      actor.sub,
      iteration.projectId,
    );
    if (teamId) {
      await this.access.assertTeamInScope(
        actor.workspaceId,
        actor.sub,
        iteration.projectId,
        teamId,
      );
    }

    // Fetch raw task rows (type=task, assigned to this iteration).
    const rows = await this.repo.getTaskRows(iterationId, actor.workspaceId, teamId, teamScope);

    /**
     * Full member roster — Rally lists every team member for the iteration, including those with
     * zero tasks (rendered with an empty load bar). Source is the iteration's team; falls back to
     * project members when the iteration is not team-scoped.
     *
     * THE ROSTER IS THE COMPLETE LIST OF NAMED GROUPS (GAP-P3-TS-008, P0)
     *
     * Read BEFORE the tasks are grouped, because it decides how they are grouped. Any task assignee
     * NOT on it used to be folded in here (`if (!memberInfo.has(userId)) memberInfo.set(...)`), which
     * gave an outside-team owner their own named group carrying 0h capacity — the BA's rule is
     * "Team Status shows only ACTIVE members of the Team selected in the top filter … no
     * outside-Team member group appears".
     *
     * Their WORK still counts. `getTaskRows` scopes tasks by
     * `coalesce(task, parent, iteration).team_id`, with no owner predicate, and that scope is
     * correct: the task IS this team's commitment whoever happens to own it. Dropping the row would
     * make this surface understate the team's hours and would put it back out of step with Team
     * Capacity, which the two read as one population
     * (`test/e2e/team-status-agreement.e2e.spec.ts` pins the totals).
     *
     * So an off-roster owner's task lands in the UNASSIGNED bucket — the same 0h-capacity residual
     * group the AC already gives a null-owner task. Nothing is hidden by that: FR-027's Owner column
     * on each task row still prints the real owner's name, so "who owns this" stays on screen; what
     * the row no longer gets is a ROSTER entry with a capacity to plan against, which is exactly the
     * distinction the AC draws. Deliberately not a synthetic "outside this Team" group either — that
     * needs response shape and copy the BA has not written, and a bucket keyed on non-membership is
     * the thing the second half of the rule refuses.
     */
    const rosterTeamId = teamId ?? iteration.teamId ?? null;
    const roster = await this.repo.getRosterMembers({
      workspaceId: actor.workspaceId,
      projectId,
      teamId: rosterTeamId,
    });

    const memberInfo = new Map<string, TeamStatusOwner>();
    for (const member of roster) {
      memberInfo.set(member.id, {
        id: member.id,
        displayName: member.displayName,
        avatarUrl: member.avatarUrl,
      });
    }

    // Group tasks by assignee — 'unassigned' for a null assignee AND for an owner who is not an
    // active member of the roster above. Bucketed in ONE pass over the rank-ordered rows rather than
    // re-homed afterwards, so the residual group stays in rank order too.
    const tasksByUser = new Map<string, TeamStatusTaskRow[]>();
    for (const row of rows) {
      const key = row.assigneeId && memberInfo.has(row.assigneeId) ? row.assigneeId : 'unassigned';
      const bucket = tasksByUser.get(key) ?? [];
      bucket.push(this.toTaskRow(row));
      tasksByUser.set(key, bucket);
    }

    // Capacities for every roster member (not just those who own tasks).
    const memberIds = [...memberInfo.keys()];
    const capacities =
      memberIds.length > 0
        ? // `rosterTeamId`, the same key the roster and `upsertCapacity` use — so the number shown is
          // the number an edit will write.
          await this.repo.getCapacities(iterationId, memberIds, rosterTeamId)
        : new Map<string, number>();

    // One group per member (empty task list when they have none), plus an
    // Unassigned group when unassigned tasks exist.
    const groups: TeamStatusMemberGroup[] = [];
    for (const [userId, owner] of memberInfo) {
      groups.push(
        this.buildMemberGroup(owner, capacities.get(userId) ?? 0, tasksByUser.get(userId) ?? []),
      );
    }
    const unassignedTasks = tasksByUser.get('unassigned');
    if (unassignedTasks && unassignedTasks.length > 0) {
      groups.push(
        this.buildMemberGroup(
          { id: 'unassigned', displayName: 'Unassigned', avatarUrl: null },
          0,
          unassignedTasks,
        ),
      );
    }

    // Sort members alphabetically by displayName; Unassigned pinned to the bottom.
    groups.sort((a, b) => {
      if (a.owner.id === 'unassigned') return 1;
      if (b.owner.id === 'unassigned') return -1;
      return a.owner.displayName.localeCompare(b.owner.displayName);
    });

    // Totals span the whole roster (capacity includes zero-task members).
    const totals = groups.reduce(
      (acc, g) => ({
        capacityHours: acc.capacityHours + g.capacityHours,
        estimateHours: acc.estimateHours + g.estimateHours,
        todoHours: acc.todoHours + g.todoHours,
        actualHours: acc.actualHours + g.actualHours,
      }),
      { capacityHours: 0, estimateHours: 0, todoHours: 0, actualHours: 0 },
    );

    return {
      projectId,
      teamId,
      iteration: {
        id: iteration.id,
        name: iteration.name,
        startDate: iteration.startDate,
        endDate: iteration.endDate,
      },
      totals,
      groups,
    };
  }

  /**
   * Update member capacity (P3-TS-FR-017/018).
   * Upserts by (projectId, teamId, iterationId, userId).
   * If teamId is not provided (e.g. "All teams" view), resolves it from the iteration.
   */
  async updateCapacity(
    actor: JwtPayload,
    input: UpdateCapacityInput,
  ): Promise<{ userId: string; capacityHours: number }> {
    // team_status:edit on input.projectId is enforced by the PolicyGuard.
    //
    // The archived-project rule is not (PRJ-FR-010). This is the one write on this service that
    // does not go through `WorkItemsService`, so it was the one that escaped: `member_capacity` is
    // planning data for an iteration in this project, and it is the denominator Team Status and
    // Team Capacity both render — see the note in CLAUDE.md on the two being one population.
    await this.projectsService.assertProjectWritable(actor.workspaceId, input.projectId);
    if (input.capacityHours < 0) {
      throw new ValidationException('TEAM_STATUS_INVALID_CAPACITY', 'capacityHours must be >= 0');
    }

    // Resolve teamId from iteration when not provided (e.g. "All teams" view)
    let teamId = input.teamId;
    if (!teamId) {
      const iteration = await this.iterationsService.getIteration(
        actor.workspaceId,
        input.iterationId,
      );
      teamId = iteration.teamId ?? undefined;
      if (!teamId) {
        throw new ValidationException(
          'TEAM_STATUS_TEAM_REQUIRED',
          'Cannot determine team for capacity update — iteration is not team-scoped and no teamId was provided',
        );
      }
    }

    /**
     * The team is only decided NOW, which is why the check is here and not at the top: an omitted
     * `teamId` is resolved from the iteration above, so validating the input alone would have let an
     * Editor write another team's capacity row by leaving the field out (BA ruling 2026-08-17).
     * `member_capacity` is unique per (project, team, iteration, user), so this row is that team's
     * denominator on both Team Status and Team Capacity.
     */
    await this.access.assertTeamInScope(
      actor.workspaceId,
      actor.sub,
      input.projectId,
      teamId ?? null,
    );

    return this.repo.upsertCapacity({
      workspaceId: actor.workspaceId,
      projectId: input.projectId,
      teamId,
      iterationId: input.iterationId,
      userId: input.userId,
      capacityHours: input.capacityHours,
    });
  }

  /**
   * Update a task from Team Status (P3-TS-FR-019 … P3-TS-FR-023).
   *
   * Task Name and Task State, and NOTHING else — SRS §9.3 ("Accept partial patch for `title`
   * and/or `state`") and §11, whose editable columns for this surface are Capacity, Task Name and
   * Task State. Estimate / ToDo / Actuals / Owner are reads here (FR-026, FR-027) and are edited on
   * the Task Dashboard, which writes through `WorkItemsService` directly.
   *
   * That is also what retires this method's own trap, worth keeping in view because the rule it
   * bypassed still exists: an `estimateHours` branch here used to set `todoHours` whenever the
   * caller had not, which DEFINED the field before `WorkItemsService` saw it and so bypassed the
   * once-only copy gate (`input.todoHours === undefined && item.todoHours === null`). The copy then
   * happened on every estimate edit instead of the first, re-inflating a completed task's
   * auto-zeroed To Do and moving the Iteration Status total, the Tasks-tab total and the next
   * Burndown snapshot with it. The gate lives in `WorkItemsService` — the three hour fields are
   * independent — and any surface that edits Estimate must send it alone.
   *
   * Parent roll-up (P3-TS-05) is owned by WorkItemsService.updateWorkItem, which
   * auto-completes the parent US/DE ONLY when every child task is completed; this
   * method never force-completes the parent. It re-reads the parent afterwards so
   * the returned workProduct reflects the parent's actual status.
   * P3 refactor: updates the `tasks` table via work-items service.
   */
  async updateTask(
    actor: JwtPayload,
    taskId: string,
    input: UpdateTaskFromTeamStatusInput,
  ): Promise<{
    id: string;
    taskKey: string;
    title: string;
    state: TeamTaskState;
    workProduct?: { id: string; key: string; status: string };
  }> {
    // team_status:edit on the task's project is enforced by the PolicyGuard,
    // which resolves the project from taskId (a work_item) up-front.
    const updateInput: UpdateWorkItemInput = {};
    if (input.title !== undefined) {
      const trimmed = input.title.trim();
      if (!trimmed) {
        throw new ValidationException('TEAM_STATUS_INVALID_TITLE', 'Title must not be empty');
      }
      updateInput.title = trimmed;
    }
    if (input.state !== undefined) {
      // Map Team Status state to task_state enum
      const stateMap: Record<TeamTaskState, string> = {
        Defined: 'defined',
        'In-Progress': 'in_progress',
        Completed: 'completed',
      };
      updateInput.scheduleState = stateMap[input.state] as 'defined' | 'in_progress' | 'completed';
    }

    const updated = await this.workItemsService.updateWorkItem(actor, taskId, updateInput);

    const result: {
      id: string;
      taskKey: string;
      title: string;
      state: TeamTaskState;
      workProduct?: { id: string; key: string; status: string };
    } = {
      id: updated.id,
      taskKey: updated.itemKey,
      title: updated.title,
      state: STATE_NORMALIZE[updated.scheduleState] ?? 'Defined',
    };

    // Parent roll-up (BA P3-TS-05) is owned centrally by
    // WorkItemsService.updateWorkItem, which auto-completes the parent US/DE
    // ONLY when every child task is completed. We must NOT force-complete the
    // parent here — a single completed task does not complete the work product.
    // Re-read the parent so the UI reflects its actual resulting status.
    if (updated.parentId) {
      try {
        const parent = await this.workItemsService.getWorkItem(actor.workspaceId, updated.parentId);
        result.workProduct = {
          id: parent.id,
          key: parent.itemKey,
          status: parent.scheduleState,
        };
      } catch {
        this.logger.warn(
          { taskId, parentId: updated.parentId },
          'Failed to read parent work product status after task update',
        );
      }
    }

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /** Aggregate a member's tasks into a group row (works for zero-task members). */
  private buildMemberGroup(
    owner: TeamStatusOwner,
    capacityHours: number,
    tasks: TeamStatusTaskRow[],
  ): TeamStatusMemberGroup {
    const estimateHours = tasks.reduce((s, t) => s + t.estimateHours, 0);
    const todoHours = tasks.reduce((s, t) => s + t.todoHours, 0);
    const actualHours = tasks.reduce((s, t) => s + t.actualHours, 0);
    // Completion percentage per Team_Status SRS §10: actual / estimate * 100,
    // capped at 100; 0 when there is no estimate to measure against. Capacity is
    // a planning number (member availability), not a progress denominator.
    const progressPercent =
      estimateHours > 0 ? Math.min(100, Math.round((actualHours / estimateHours) * 100)) : 0;
    return {
      owner,
      capacityHours,
      taskCount: tasks.length,
      estimateHours,
      todoHours,
      actualHours,
      progressPercent,
      tasks,
    };
  }

  private toTaskRow(row: RawTeamStatusTaskRow): TeamStatusTaskRow {
    return {
      id: row.id,
      taskKey: row.itemKey,
      title: row.title,
      displayName: row.title,
      workProduct: {
        id: row.parentId ?? '',
        key: row.parentKey ?? '',
        type: (row.parentType as TeamStatusTaskRow['workProduct']['type']) ?? 'Story',
        title: row.parentTitle ?? '',
        status: row.parentScheduleState ?? '',
      },
      release: row.releaseId ? { id: row.releaseId, name: row.releaseName ?? '' } : null,
      state: STATE_NORMALIZE[row.scheduleState as WorkItemScheduleState] ?? 'Defined',
      estimateHours: Number(row.estimateHours ?? 0),
      todoHours: Number(row.todoHours ?? 0),
      actualHours: Number(row.actualHours ?? 0),
      owner: {
        id: row.assigneeId ?? '',
        displayName: row.assigneeDisplayName ?? 'Unassigned',
        avatarUrl: row.assigneeAvatarUrl,
      },
      rank: row.rank,
    };
  }
}
