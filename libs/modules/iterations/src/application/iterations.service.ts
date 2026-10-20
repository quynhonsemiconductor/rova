import { Inject, Injectable, Logger } from '@nestjs/common';
import { uuidv7 } from 'uuidv7';
import { and, eq, isNull, inArray, sql } from 'drizzle-orm';
import {
  NotFoundException,
  PreconditionFailedException,
  InjectDrizzle,
  isDuplicateKeyError,
} from '@platform';
import type { JwtPayload, CursorPayload, PagedResult, DrizzleDB } from '@platform';
import { ProjectsService } from '@modules/projects';
import { WorkItemsService } from '@modules/work-items';
import { AccessService } from '@modules/access';
import { workItems, iterationDailySnapshots } from '../../../../../db/schema/work';
import { acceptedScheduleStatesSql } from '../../../../../db/schema/enums';
import { IIterationRepository, ITERATION_REPOSITORY } from '../domain/ports/iteration.repository';
import {
  classifyIterationStateChange,
  isCreatableIterationState,
  type IterationStateChange,
} from '../domain/iteration-state';
import {
  ActivityLogger,
  type ActivityChange,
  type ActivityLog,
  type CreateActivityInput,
} from '@modules/activity';
import { diffIteration } from './iteration-activity-diff';
import type {
  Iteration,
  IterationState,
  IterationOption,
  IterationReference,
  IterationFilters,
  UpdateIterationInput,
} from '../domain/iteration.types';
import type { TeamReadScope } from '../domain/team-read-scope';

/** One revision-log action per state change, so the Timeboxes history names what happened. */
const STATE_CHANGE_ACTION: Record<IterationStateChange, string> = {
  commit: 'iteration.committed',
  accept: 'iteration.accepted',
  reopen: 'iteration.reopened',
};

@Injectable()
export class IterationsService {
  private readonly logger = new Logger(IterationsService.name);

  constructor(
    @Inject(ITERATION_REPOSITORY) private readonly iterationRepo: IIterationRepository,
    private readonly activity: ActivityLogger,
    @InjectDrizzle() private readonly db: DrizzleDB,
    private readonly projectsService: ProjectsService,
    private readonly accessService: AccessService,
    private readonly workItemsService: WorkItemsService,
  ) {}

  // ── Revision History (activity log) ─────────────────────────────────────────

  private buildActivity(
    iteration: Iteration,
    actorId: string | null,
    action: string,
    changes: ActivityChange | null,
  ): CreateActivityInput {
    return this.activity.build(
      {
        workspaceId: iteration.workspaceId,
        projectId: iteration.projectId,
        entityType: 'iteration',
        entityId: iteration.id,
      },
      actorId,
      action,
      changes,
    );
  }

  /** Best-effort append — a revision-log failure must never fail the mutation. */
  private async appendActivity(inputs: CreateActivityInput[]): Promise<void> {
    await this.activity.logSafe(inputs);
  }

  /** Newest-first revision history for one iteration (project-view gated). */
  async getIterationActivity(
    actor: JwtPayload,
    id: string,
    args: { limit: number; offset: number },
  ): Promise<{ items: ActivityLog[]; total: number }> {
    await this.getIterationForView(actor, id);
    const page = Math.floor(args.offset / args.limit) + 1;
    const res = await this.activity.listFor(id, actor.workspaceId, page, args.limit);
    return { items: res.data, total: res.total };
  }

  // ── List ──────────────────────────────────────────────────────────────────

  /**
   * NOT narrowed by team scope, and that is a decision rather than an omission.
   *
   * This is the `Plan > Timeboxes` RECORD grid, gated on `timebox:view` — a code no per-project
   * `editor` holds (`ACCESS_LEVEL_PERMISSIONS` in `db/permissions.catalog.ts` grants it to `admin`
   * only, because §3.2 marks that surface Hidden for an Editor), so `resolveTeamScope` would answer
   * `unrestricted` for every caller who can reach this route at all. Its `taskEstimate` rollup reads
   * task hours across the whole project for the same reason. If `timebox:view` is ever granted to an
   * Editor, this method and `taskEstimatesByIteration` both need the scope the two compact feeds take.
   */
  async listIterations(
    actor: JwtPayload,
    projectId: string,
    filters: IterationFilters,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<Iteration>> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    const page = await this.iterationRepo.listByProject(
      projectId,
      actor.workspaceId,
      filters,
      args,
    );
    // Enrich each iteration with its task-estimate rollup (IT-001).
    const estimates = await this.iterationRepo.taskEstimatesByIteration(
      actor.workspaceId,
      page.data.map((i) => i.id),
    );
    return {
      ...page,
      data: page.data.map((i) => ({ ...i, taskEstimate: estimates.get(i.id) ?? 0 })),
    };
  }

  // ── Create ────────────────────────────────────────────────────────────────

  async createIteration(
    actor: JwtPayload,
    projectId: string,
    name: string,
    opts: {
      teamId?: string;
      goal?: string;
      theme?: string;
      notes?: string;
      state?: import('../domain/iteration.types').IterationState;
      startDate?: string;
      endDate?: string;
      plannedVelocity?: number;
    } = {},
  ): Promise<Iteration> {
    await this.projectsService.assertProjectWritable(actor.workspaceId, projectId);

    if (opts.teamId) {
      await this.projectsService.assertTeamLinkedToProject(
        actor.workspaceId,
        projectId,
        opts.teamId,
      );
    }
    this.assertDateRange(opts.startDate, opts.endDate);

    /**
     * The state machine cannot be bypassed at BIRTH.
     *
     * `state` was passed straight through, so `POST /iterations` with `state: 'accepted'` created a
     * row in the one state the rule that owns acceptance can never produce: acceptance is a
     * condition over MEMBERSHIP (§10.1 — "Auto-accept requires at least one assigned Story/Defect
     * item; an empty Iteration must not auto-accept") and a new iteration has no members. Nothing
     * would have corrected it either, because `autoAcceptIterationIfComplete` only ever moves
     * `planning|committed → accepted`. It also skipped the accept-gate every other path pays, so
     * Velocity would count a sprint nobody worked and `deleteIteration` would refuse to remove it.
     *
     * The code is the accept-gate's own `ITERATION_EMPTY`, deliberately: this is that rule, seen
     * from the create path, and the frontend should branch on it the same way.
     */
    if (opts.state !== undefined && !isCreatableIterationState(opts.state)) {
      throw new PreconditionFailedException(
        'ITERATION_EMPTY',
        'Cannot create an iteration in the Accepted state — an iteration can only be accepted once it has assigned Story or Defect items and every one of them is accepted',
      );
    }

    // iterationKey reservation reads MAX(existing) + 1 (not atomic under
    // concurrent creates) and iterations can be hard-deleted, so a collision
    // on uq_iterations_key is possible; retry once with a freshly computed key.
    const MAX_KEY_RETRIES = 2;
    let iteration: Iteration | undefined;
    let lastErr: unknown;

    for (let attempt = 0; attempt < MAX_KEY_RETRIES; attempt++) {
      const keyNumber = await this.iterationRepo.nextKeyNumber(projectId, actor.workspaceId);

      try {
        iteration = await this.iterationRepo.create({
          id: uuidv7(),
          workspaceId: actor.workspaceId,
          projectId,
          teamId: opts.teamId ?? null,
          iterationKey: `IT-${keyNumber}`,
          name,
          goal: opts.goal,
          theme: opts.theme,
          notes: opts.notes,
          state: opts.state,
          startDate: opts.startDate,
          endDate: opts.endDate,
          plannedVelocity: opts.plannedVelocity,
        });
        break; // success — exit retry loop
      } catch (err: unknown) {
        lastErr = err;
        if (isDuplicateKeyError(err) && attempt < MAX_KEY_RETRIES - 1) {
          this.logger.warn(
            { projectId, attempt: attempt + 1 },
            'Duplicate iteration key on create — retrying with next key',
          );
          continue;
        }
        throw err; // not a duplicate-key error or last attempt — re-throw
      }
    }

    if (!iteration) throw lastErr;

    this.logger.log(
      { iterationId: iteration.id, projectId, userId: actor.sub },
      'Iteration created',
    );
    await this.appendActivity([
      this.buildActivity(iteration, actor.sub, 'iteration.created', null),
    ]);
    return iteration;
  }

  // ── The two compact feeds (P2-IT-10) ────────────────────────────────────────
  //
  // TWO QUESTIONS, TWO ROUTES, and that is the design rather than an accident:
  //   • ELIGIBILITY — "which iterations may I assign work INTO?" → every iteration the write path
  //     accepts: same project, team-or-shared timebox. NOT narrowed by state — see P6-VEL-004 and
  //     `IterationDrizzleRepository.listAssignmentOptions`.
  //   • REFERENCE   — "what is this iteration called, and when was it?" → the same rows plus
  //     `team_id`, the projection every filter, label and scope picker needs.
  // One endpoint with a boolean would let a caller measure one population while a sibling caller
  // enumerates another; that conflation is exactly what produced the zero-point Velocity bars.

  /**
   * The team scope BOTH compact feeds narrow by — a PICKER is named in the BA ruling of 2026-08-17
   * ("enforce this consistently in API queries, lists, reports, search, pickers and direct URLs"),
   * and a picker that offers what the write path refuses is the shape this repo has fixed three times.
   *
   * Two halves, because a picker takes an explicit team AND has an All Teams position:
   *
   *   • an explicitly REQUESTED team is asserted, not silently ignored. `teamId` here is a real team
   *     id, so `assertTeamInScope` can never reach its `PROJECT_BACKLOG_ADMIN_ONLY` branch — it
   *     answers `TEAM_NOT_IN_SCOPE` for another team's timeboxes and `EDITOR_NO_TEAM_SCOPE` for an
   *     Editor holding none. Narrowing instead of refusing would answer a question about team B with
   *     team A's rows, which reads as "team B has no sprints".
   *   • the UNFILTERED (All Teams) call is narrowed, or All Teams would be the way around the first
   *     half — the same reason CLAUDE.md requires `teamName === null` to mean All Teams *within the
   *     caller's scope*.
   */
  private async resolveTimeboxScope(
    actor: JwtPayload,
    projectId: string,
    teamId?: string,
  ): Promise<TeamReadScope> {
    if (teamId) {
      await this.accessService.assertTeamInScope(actor.workspaceId, actor.sub, projectId, teamId);
    }
    return this.accessService.resolveTeamScope(actor.workspaceId, actor.sub, projectId);
  }

  /**
   * ELIGIBILITY. Feeds the bulk-assign bar and the inline/sidebar assignment pickers.
   *
   * Includes ACCEPTED iterations since P6-VEL-004: Velocity attributes points by an item's CURRENT
   * iteration, so a closed sprint has to be selectable or that rule only works in one direction.
   */
  async getAssignmentOptions(
    actor: JwtPayload,
    projectId: string,
    teamId?: string,
  ): Promise<IterationOption[]> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    const scope = await this.resolveTimeboxScope(actor, projectId, teamId);
    return this.iterationRepo.listAssignmentOptions(projectId, actor.workspaceId, teamId, scope);
  }

  /**
   * REFERENCE. Feeds every filter, id→name label and report scope picker on the four surfaces §3.2
   * grants an Editor (Iteration Status, the Backlog filter, Team Status, Quality) plus the two
   * report pickers — none of which may read the timebox RECORD.
   */
  async getIterationReferences(
    actor: JwtPayload,
    projectId: string,
    teamId?: string,
  ): Promise<IterationReference[]> {
    await this.projectsService.getProject(actor.workspaceId, projectId);
    const scope = await this.resolveTimeboxScope(actor, projectId, teamId);
    return this.iterationRepo.listReferences(projectId, actor.workspaceId, teamId, scope);
  }

  // ── Get ───────────────────────────────────────────────────────────────────

  async getIteration(workspaceId: string, id: string): Promise<Iteration> {
    const iteration = await this.iterationRepo.findById(id);
    if (!iteration || iteration.workspaceId !== workspaceId) {
      throw new NotFoundException('ITERATION_NOT_FOUND', 'Iteration not found');
    }
    return iteration;
  }

  /**
   * Load an iteration for a read. Project-scoped `timebox:view` is enforced by
   * the PolicyGuard at the route (resource-resolved from :id); this just loads.
   *
   * `timebox:view`, NOT `iteration:view`: §3.2 hides the `Plan > Timeboxes` SURFACE from an Editor
   * while giving it view-and-update on `Track > Iteration Status`, and one code cannot serve both.
   * `iteration:view` stays with the Editor because the iteration LIST feeds Iteration Status, Backlog,
   * Team Status and Quality; only this detail read and its activity tab moved.
   */
  async getIterationForView(actor: JwtPayload, id: string): Promise<Iteration> {
    return this.getIteration(actor.workspaceId, id);
  }

  // ── Update ────────────────────────────────────────────────────────────────

  async updateIteration(
    actor: JwtPayload,
    id: string,
    input: UpdateIterationInput,
  ): Promise<Iteration> {
    const current = await this.getIteration(actor.workspaceId, id);
    await this.projectsService.assertProjectWritable(actor.workspaceId, current.projectId);

    // Team must remain linked to the iteration's project.
    if (input.teamId) {
      await this.projectsService.assertTeamLinkedToProject(
        actor.workspaceId,
        current.projectId,
        input.teamId,
      );
    }

    // Validate the resulting date range (fall back to current values).
    const startDate = input.startDate !== undefined ? input.startDate : current.startDate;
    const endDate = input.endDate !== undefined ? input.endDate : current.endDate;
    this.assertDateRange(startDate ?? undefined, endDate ?? undefined);

    /**
     * State is a lifecycle change, not a free-form field, so it goes through `applyStateChange` —
     * the SAME home `POST /:id/commit` and `POST /:id/accept` use, which is what stops a PATCH from
     * bypassing the accept-gate (`state: 'accepted'` while items are still open).
     *
     * It used to allow exactly two pairs — `planning → committed` and `committed → accepted` — and
     * refuse the other four. That is stricter than the BA in both directions that matter: §10.1
     * settles a reverse with "user manages Iteration status manually", so an iteration the auto rule
     * accepted could never be reopened when one of its items was; and the AUTO path already
     * performs `planning → accepted` (`autoAcceptIterationIfComplete` selects
     * `state IN ('planning','committed')`), so the manual path was less capable than the convenience
     * behaviour that "does not remove manual status control". See `domain/iteration-state.ts`.
     */
    let stateResult: Iteration | undefined;
    if (input.state !== undefined && input.state !== current.state) {
      stateResult = await this.applyStateChange(actor, current, input.state);
    }

    // Apply the remaining (non-state) field updates, if any.
    const fields = { ...input };
    delete fields.state;
    if (Object.keys(fields).length > 0) {
      const updated = await this.iterationRepo.update(id, fields);
      await this.appendActivity(
        diffIteration(current, fields).map((e) =>
          this.buildActivity(updated, actor.sub, 'iteration.updated', e.change),
        ),
      );
      return updated;
    }
    return stateResult ?? current;
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async deleteIteration(actor: JwtPayload, id: string): Promise<void> {
    const iteration = await this.getIteration(actor.workspaceId, id);
    await this.projectsService.assertProjectWritable(actor.workspaceId, iteration.projectId);
    if (iteration.state !== 'planning') {
      throw new PreconditionFailedException(
        'ITERATION_NOT_PLANNING',
        'Only iterations in the Planning state can be deleted',
      );
    }
    /**
     * FROZEN report history is never deletable — the rule is now STATED, not coincidental.
     *
     * `fk_ids_iteration` is `ON DELETE CASCADE` (migration 0093) because "history describes an
     * iteration", and that history cannot be recreated: the snapshot cron only ever writes TODAY,
     * so a deleted day is gone for good (see CLAUDE.md, "Time-series history cannot be backfilled,
     * ever"). 0093's own note says orphan snapshots were "unreachable through the API today"
     * because a delete needs `planning` while only a `committed` iteration is snapshotted — and
     * then adds: "unreachable today is not an invariant, it is a coincidence of two unrelated
     * rules." Allowing the manual reverse transitions §10.1 requires spends that coincidence: a
     * snapshotted iteration can now legally re-enter `planning`. This guard is what pays for it.
     *
     * It cannot refuse anything that used to be allowed: before the reverse existed, no `planning`
     * iteration had ever been committed, so none had snapshots.
     */
    const [history] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(iterationDailySnapshots)
      .where(
        and(
          eq(iterationDailySnapshots.iterationId, id),
          eq(iterationDailySnapshots.workspaceId, iteration.workspaceId),
        ),
      );
    if (Number(history?.total ?? 0) > 0) {
      throw new PreconditionFailedException(
        'ITERATION_HAS_REPORT_HISTORY',
        'This iteration has recorded Burndown history, which cannot be recreated once deleted',
      );
    }
    /**
     * Deleting the row UNSCHEDULES its work; it does not orphan it and it does not cascade.
     *
     * `work_items.iteration_id` and `work.tasks.iteration_id` carry `ON DELETE SET NULL` as of
     * migration 0114, so the items survive and become unscheduled in the same statement as this
     * DELETE. That is Rally's documented behaviour — "If you delete an iteration that stories and
     * defects are scheduled in, they will all be updated to unscheduled" — and it is enforced in the
     * database rather than here because `db/seeds/**` and raw SQL write those tables directly.
     *
     * Before 0114 neither column had a key and this method was exactly the two lines below, so every
     * scheduled item was left pointing at a row that no longer existed. The 2026-08-04 audit called
     * it the highest-value fix it found.
     */
    await this.iterationRepo.delete(id);
    this.logger.log({ iterationId: id }, 'Iteration deleted; its work items are now unscheduled');
  }

  // ── Commit ─────────────────────────────────────────────────────────────────

  /** `POST /:id/commit` — the explicit scope commitment (P2-IT-FR-023). */
  async commitIteration(actor: JwtPayload, id: string): Promise<Iteration> {
    const iteration = await this.getIteration(actor.workspaceId, id);
    return this.applyStateChange(actor, iteration, 'committed');
  }

  // ── Accept ─────────────────────────────────────────────────────────────────
  // BA F1: manual-first. An iteration can be accepted ONLY when it has at least
  // one assigned Story/Defect and EVERY assigned Story/Defect is in an accepted
  // state. Accept does NOT move unfinished items — use rolloverUnfinished() for
  // that, as a separate, explicit action.

  /** `POST /:id/accept` — content-gated by `assertAcceptable`, from planning or committed. */
  async acceptIteration(actor: JwtPayload, id: string): Promise<Iteration> {
    const iteration = await this.getIteration(actor.workspaceId, id);
    return this.applyStateChange(actor, iteration, 'accepted');
  }

  // ── The one home for a state change ─────────────────────────────────────────

  /**
   * Every write that moves `iterations.state` lands here — `PATCH /:id`, `POST /:id/commit` and
   * `POST /:id/accept` — so the three routes cannot answer the same `from → to` pair differently.
   * They used to: the PATCH allowed two pairs and refused four, `commit` demanded `planning` and
   * `accept` demanded `committed`, which between them made the manual reverse §10.1 hands to the
   * user unreachable on every surface. `domain/iteration-state.ts` carries the BA quotes.
   *
   * The archived-project rule (PRJ-FR-010) is asserted here rather than at each call site: state
   * changes were the two writes in this service that once skipped it, which is exactly what a
   * call-site convention decays into. Committing matters more than it looks —
   * `SnapshotCronService.findActiveIterations` selects on `state = 'committed'` and nothing else, so
   * a commit also starts the hourly Burndown job writing rows for that iteration.
   */
  private async applyStateChange(
    actor: JwtPayload,
    iteration: Iteration,
    target: IterationState,
  ): Promise<Iteration> {
    const from = iteration.state;
    await this.projectsService.assertProjectWritable(actor.workspaceId, iteration.projectId);

    // A no-op is refused rather than reported as a change: `POST /:id/commit` on a committed
    // iteration did nothing before either, and a route that answers 200 to a request that moved
    // nothing is how a UI comes to show a state the database does not hold. (`updateIteration`
    // filters this out first — a PATCH that resends the current state is genuinely a no-op.)
    if (from === target) {
      throw new PreconditionFailedException(
        'ITERATION_INVALID_STATE_TRANSITION',
        `Iteration is already ${target}`,
      );
    }

    const change = classifyIterationStateChange(from, target);
    if (change === 'accept') await this.assertAcceptable(actor.workspaceId, iteration.id);

    const updated = await this.iterationRepo.update(iteration.id, {
      state: target,
      // `completedAt` is the ACCEPTANCE stamp, so it is written on an accept and cleared on any
      // move out of `accepted`. A reopened iteration carrying an accepted-at timestamp is the
      // "invisible state" smell CLAUDE.md warns about — a row whose two columns disagree, where
      // nothing on screen would show it.
      completedAt: change === 'accept' ? new Date() : null,
    });
    this.logger.log({ iterationId: iteration.id, from, to: target }, `Iteration ${change}`);
    await this.appendActivity([
      this.buildActivity(updated, actor.sub, STATE_CHANGE_ACTION[change], {
        field: 'state',
        old: from,
        new: target,
      }),
    ]);
    return updated;
  }

  /**
   * The accept-gate (BA F1 / §10.1): at least one assigned Story/Defect, and every one of them
   * accepted. This is the same predicate `autoAcceptIterationIfComplete` applies, and the same D1
   * acceptance set `rolloverUnfinished` moves out — the three must never diverge.
   */
  private async assertAcceptable(workspaceId: string, id: string): Promise<void> {
    const [agg] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        allAccepted: sql<boolean>`bool_and(${workItems.scheduleState} in (${acceptedScheduleStatesSql()}))`,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.iterationId, id),
          eq(workItems.workspaceId, workspaceId),
          inArray(workItems.type, ['story', 'defect']),
          isNull(workItems.deletedAt),
        ),
      );

    if (Number(agg?.total ?? 0) === 0) {
      throw new PreconditionFailedException(
        'ITERATION_EMPTY',
        'Cannot accept an iteration with no assigned Story or Defect items',
      );
    }
    if (agg?.allAccepted !== true) {
      throw new PreconditionFailedException(
        'ITERATION_NOT_ALL_ACCEPTED',
        'All assigned Story and Defect items must be Accepted before the iteration can be accepted',
      );
    }
  }

  // ── Rollover — move unfinished items out (explicit, separate from accept) ────
  // Rollover is the mirror of the accept-gate: it moves out exactly the items
  // that BLOCK acceptance — the Story/Defect items NOT yet accepted
  // (schedule_state ∉ {accepted, release}, the SAME D1 predicate the accept-gate
  // uses). After a rollover only accepted items remain, so the iteration can be
  // accepted. (Burndown's board-'done' D2 dimension is a reporting concern and
  // is deliberately NOT used here — the two definitions of "finished" must not
  // diverge.) Moves to a target iteration (same project) or back to the backlog
  // (null). Returns the number of items moved.

  async rolloverUnfinished(
    actor: JwtPayload,
    id: string,
    opts: { moveToIterationId?: string } = {},
  ): Promise<{ movedCount: number }> {
    const workspaceId = actor.workspaceId;
    const iteration = await this.getIteration(workspaceId, id);
    // An archived project is read-only end to end, and rollover is a write on its work items.
    await this.projectsService.assertProjectWritable(workspaceId, iteration.projectId);

    if (opts.moveToIterationId) {
      const target = await this.getIteration(workspaceId, opts.moveToIterationId);
      if (target.projectId !== iteration.projectId) {
        throw new PreconditionFailedException(
          'ITERATION_PROJECT_MISMATCH',
          'Target iteration must belong to the same project',
        );
      }
    }

    /**
     * SELECT the ids, then move each through `WorkItemsService.updateWorkItem`.
     *
     * This used to be a single `db.update(workItems)`, which is faster and wrong. It wrote the
     * column directly and so skipped every rule the ordinary iteration-assignment path applies —
     * the same rules this repo has fixed one at a time elsewhere:
     *
     *   • `assertIterationAssignable` / `ITERATION_TEAM_MISMATCH`. Nothing keeps
     *     `work_items.team_id` and its iteration's team in step by itself, so a bulk move could
     *     park Team Beta's story inside Team Alpha's sprint — exactly the state the update path
     *     refuses one item at a time.
     *   • Iteration AUTO-ACCEPT. CLAUDE.md: "Iteration auto-accept is a condition over
     *     MEMBERSHIP … Every membership write now re-evaluates BOTH affected iterations (the one
     *     left and the one joined)." Rollover is a membership write on up to two iterations and
     *     re-evaluated neither, so moving the last unfinished story out left the source iteration
     *     Committed while its tile read ACCEPTED 100% — the precise defect
     *     `derived-invariants.e2e.spec.ts` was written to pin.
     *   • ACTIVITY. The items' Revision History showed nothing at all, though their iteration had
     *     changed. A value that moves with no entry is unauditable.
     *   • the Editor team check that used to sit on that path. (Team scope was dropped as an
     *     authorization boundary by ruling on 2026-08-14 — see CLAUDE.md — so this line is history
     *     now, kept because it is part of why this method routes through `updateWorkItem` at all.)
     *
     * Per item rather than in bulk, and that trade is deliberate: an iteration holds tens of
     * stories, not thousands, and correctness on a membership change is worth more than one
     * round trip. `updateWorkItem` opens its own transaction per item, so a mid-way failure leaves
     * the already-moved items moved — reported honestly in `movedCount` rather than rolled back
     * silently.
     */
    const unfinished = await this.db
      .select({ id: workItems.id })
      .from(workItems)
      .where(
        and(
          eq(workItems.iterationId, id),
          eq(workItems.workspaceId, workspaceId),
          inArray(workItems.type, ['story', 'defect']),
          isNull(workItems.deletedAt),
          sql`${workItems.scheduleState} not in (${acceptedScheduleStatesSql()})`,
        ),
      );

    let movedCount = 0;
    for (const row of unfinished) {
      await this.workItemsService.updateWorkItem(actor, row.id, {
        iterationId: opts.moveToIterationId ?? null,
      });
      movedCount += 1;
    }

    this.logger.log(
      {
        iterationId: id,
        moveToIterationId: opts.moveToIterationId ?? null,
        movedCount,
      },
      'Iteration unfinished items rolled over',
    );
    return { movedCount };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private assertDateRange(startDate?: string, endDate?: string): void {
    if (startDate && endDate && startDate > endDate) {
      throw new PreconditionFailedException(
        'ITERATION_INVALID_DATE_RANGE',
        'Start date must be before or equal to end date',
      );
    }
  }
}
