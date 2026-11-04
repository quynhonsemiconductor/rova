import { Inject, Injectable } from '@nestjs/common';
import type { JwtPayload, CursorPayload, PagedResult } from '@platform';
import { PreconditionFailedException, workspaceLocalDate } from '@platform';
import { iterationDayCount } from '../domain/iteration-calendar';
import { WorkItemsService } from '@modules/work-items';
import type { WorkItemType } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { IterationsService } from './iterations.service';
import type { Iteration } from '../domain/iteration.types';
import {
  IIterationStatusRepository,
  ITERATION_STATUS_REPOSITORY,
} from '../domain/ports/iteration-status.repository';
import type {
  IterationStatusItem,
  IterationStatusFilters,
  IterationStatusMetrics,
} from '../domain/iteration-status.types';

export interface IterationStatusResult {
  iteration: Iteration;
  metrics: IterationStatusMetrics;
  items: PagedResult<IterationStatusItem>;
}

@Injectable()
export class IterationStatusService {
  constructor(
    @Inject(ITERATION_STATUS_REPOSITORY)
    private readonly statusRepo: IIterationStatusRepository,
    private readonly iterationsService: IterationsService,
    private readonly workItemsService: WorkItemsService,
    private readonly accessService: AccessService,
  ) {}

  /** Percent helper — guards divide-by-zero (SRS §8: show 0% when denominator is 0). */
  private percent(numerator: number, denominator: number): number {
    if (!denominator) return 0;
    return Math.round((numerator / denominator) * 100);
  }

  // ── Status read-model (P2-IS-03 / P2-IS-04) ───────────────────────────────

  async getStatus(
    actor: JwtPayload,
    iterationId: string,
    filters: IterationStatusFilters,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<IterationStatusResult> {
    // Loads the iteration and authorizes the actor to view its project
    // (throws ITERATION_NOT_FOUND / 403 for a project the actor can't see).
    const iteration = await this.iterationsService.getIterationForView(actor, iterationId);

    /**
     * ONE scope, resolved ONCE, passed to BOTH queries (BA ruling 2026-08-17, read half).
     *
     * §3.2 gives an Editor `Iteration Status | View and update in assigned Teams`, and this is the
     * surface the `iteration:view` / `timebox:view` split exists to keep open for them — so the
     * narrowing has to happen in the read model rather than at the gate. Resolved here and not inside
     * the repository so the strip and the grid are provably measured over the SAME population: two
     * resolutions could differ (the assignment cache expires between them), and one metric computed
     * over a wider population than its own rows is the fault CLAUDE.md records for Velocity's
     * eligibility join and again for `countScheduledWork`.
     *
     * The ITERATION itself is deliberately NOT refused when it names another team: a team-less
     * iteration is a SHARED timebox every team works inside (195 of 206 local iterations name no
     * team), so there is no honest refusal to make on the timebox — the WORK rows are what carry the
     * team, and they narrow below. An Editor opening a foreign team's sprint by URL therefore sees its
     * window and an empty grid with a zeroed strip, which is the true answer: none of that work is
     * theirs.
     */
    const scope = await this.accessService.resolveTeamScope(
      actor.workspaceId,
      actor.sub,
      iteration.projectId,
    );

    const [raw, items, calendar] = await Promise.all([
      this.statusRepo.getMetrics(iterationId, actor.workspaceId, scope),
      this.statusRepo.listItems(iterationId, actor.workspaceId, filters, args, scope),
      this.statusRepo.getWorkspaceCalendar(actor.workspaceId),
    ]);
    // Working days, in the workspace's own calendar — see `iteration-calendar.ts`. "Today" is the
    // workspace-local date, not the UTC one: at 06:00 in Ho Chi Minh City it is still yesterday in
    // UTC, which would hand back a day the team has already started.
    const days = iterationDayCount({
      startDate: iteration.startDate,
      endDate: iteration.endDate,
      today: workspaceLocalDate(new Date(), calendar.timeZone),
      workingDays: calendar.workingDays,
    });

    /**
     * Passed through UNCHANGED, including null.
     *
     * This used to be `?? 0`, which flattened "no target set" into "target of zero" — the
     * response then carried `plannedVelocity: 0` while its own DTO declared the field
     * nullable, and the header rendered "PLANNED VELOCITY / 0% / 16 of 0 Points". The
     * percent is null for the same reason: attainment against a target that does not exist
     * is not 0%, it is unanswerable. A REAL target of 0 still yields 0% via `percent()`,
     * which SRS §8 requires.
     *
     * The NUMERATOR is the iteration's total Plan Estimate, NOT its accepted points (BA ruling
     * 2026-11-04, reversing P2-IS-FR-012's "accepted points compared with the planned velocity").
     * Planned Velocity answers "how full is this sprint against its target", so a Story counts the
     * moment it is in the iteration with an estimate, whatever its schedule state. Delivery
     * against plan is the ACCEPTED tile's job; dividing accepted by velocity here made the two
     * tiles measure the same thing and left Planned Velocity at 0% for a fully planned sprint
     * until something was accepted. It is the same `totalPlanEstimate` the grid's Totals row
     * prints, so the tile and the column cannot disagree.
     */
    const plannedVelocity = iteration.plannedVelocity;
    const metrics: IterationStatusMetrics = {
      plannedVelocity,
      acceptedPoints: raw.acceptedPoints,
      totalPlanEstimate: raw.totalPlanEstimate,
      plannedVelocityPercent:
        plannedVelocity === null ? null : this.percent(raw.totalPlanEstimate, plannedVelocity),
      acceptedPercent: this.percent(raw.acceptedPoints, raw.totalPlanEstimate),
      daysLeft: days.daysLeft,
      totalDays: days.totalDays,
      defectCount: raw.defectCount,
      taskCount: raw.taskCount,
      activeTaskCount: raw.activeTaskCount,
    };

    return { iteration, metrics, items };
  }

  // ── Create Story/Defect into the iteration (P2-IS-06) ─────────────────────

  /**
   * Create a new story or defect directly in the given iteration. The item is
   * created in the iteration's project (and team, when the iteration is
   * team-scoped) with the iteration already assigned — all in the SINGLE
   * transaction owned by `createWorkItem`.
   *
   * This is deliberately a create-and-assign in one step rather than
   * create-then-bulk-assign: creating an item inside an iteration is a *create*
   * action, so it requires only `work_item:create`. The previous two-step flow
   * additionally required `work_item:edit` (via the bulk-assignment path) and
   * was non-atomic — a caller with create-but-not-edit would leave an orphaned
   * backlog item and then fail, surfacing a confusing error. Because the item
   * inherits the iteration's own project (and team), iteration scope is
   * satisfied by construction, so no separate scope re-validation is needed.
   */
  async createItemInIteration(
    actor: JwtPayload,
    iterationId: string,
    input: {
      type: WorkItemType;
      title: string;
      assigneeId?: string;
      devOwnerId?: string;
      planEstimate?: string;
      teamId?: string;
    },
  ): Promise<{ workItemId: string; itemKey: string }> {
    // Only stories and defects can live in an iteration (SRS P2.1). Enforced at
    // the DTO too; kept here as a service-layer invariant (defense in depth).
    if (input.type !== 'story' && input.type !== 'defect') {
      throw new PreconditionFailedException(
        'WORK_ITEM_NOT_BACKLOG_TYPE',
        'Only stories and defects can be assigned to an iteration',
      );
    }

    const iteration = await this.iterationsService.getIteration(actor.workspaceId, iterationId);

    const created = await this.workItemsService.createWorkItem(
      actor,
      iteration.projectId,
      input.type,
      input.title,
      {
        /**
         * A CHOSEN team wins over the inherited one (BA ruling 2026-08-17).
         *
         * The inheritance is right for a team-scoped sprint and cannot work for a SHARED one, where
         * `iteration.teamId` is null and an Editor must still name one of their teams. The order is
         * chosen-then-inherited rather than the reverse so a team-scoped iteration keeps its default
         * while remaining overridable by an admin filing for another team in that same window —
         * `createWorkItem` refuses anything the caller may not do, so this cannot widen a scope.
         */
        teamId: input.teamId ?? iteration.teamId ?? undefined,
        assigneeId: input.assigneeId,
        devOwnerId: input.devOwnerId,
        storyPoints: input.planEstimate,
        iterationId,
        // scheduleState defaults to 'defined' in the work-items service (SRS §9.4).
      },
    );

    return { workItemId: created.id, itemKey: created.itemKey };
  }
}
