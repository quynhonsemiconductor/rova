import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { InjectDrizzle } from '@platform';
import type { DrizzleDB } from '@platform';
import {
  iterationTeamBaselines,
  releaseTeamTargets,
  iterationDailySnapshots,
  iterations,
  memberCapacity,
  portfolioItems,
  projects,
  releaseDailySnapshots,
  releases,
  storySplits,
  tasks,
  teams,
  workItems,
} from '../../../../../../db/schema/work';
import { users } from '../../../../../../db/schema/identity';
import { workspaceSettings } from '../../../../../../db/schema/workspace';
import { acceptedScheduleStatesSql } from '../../../../../../db/schema/enums';
import type { StoredSnapshot, StoredSplitEvent } from '../../domain/burndown';
import type { ReleaseChild, ReleaseFeature, StoredBurnupRow } from '../../domain/release-tracking';
import {
  DEFAULT_WORKING_DAYS,
  frozenSeriesScope,
  isEmptyTeamScope,
  isEndOfDayCapture,
  type TeamScope,
} from '../../domain/report-scope';
// The one home of "how a TeamScope becomes SQL", asserted without a database in
// `team-scope.sql.spec.ts`. No `scope.kind === 'team' ? … : undefined` ternary survives in this
// file: that shape treats an unhandled scope kind as "read everything".
import { inList, teamMatches, timeboxInScope } from './team-scope.sql';
import type { CapacityRecord, ScopedTaskHours } from '../../domain/team-capacity';
import type { VelocityItem } from '../../domain/velocity';
import {
  IReportingRepository,
  type ActiveIterationRow,
  type ActiveReleaseRow,
  type IterationRow,
  type IterationSnapshotWrite,
  type ReleaseRow,
  type ReleaseSnapshotWrite,
  type TimeboxGroup,
  type WorkspaceReportSettings,
} from '../../domain/ports/reporting.repository';

/** Story and Defect only. Features are portfolio items; Tasks live in `tasks`. */
const LEAF_TYPES = ['story', 'defect'] as const;

const num = (v: string | null): number => (v === null ? 0 : Number(v));
const nullableNum = (v: string | null): number | null => (v === null ? null : Number(v));

@Injectable()
export class ReportingDrizzleRepository implements IReportingRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  // ── shared ────────────────────────────────────────────────────────────────

  async getWorkspaceSettings(workspaceId: string): Promise<WorkspaceReportSettings> {
    const rows = await this.db
      .select({ timeZone: workspaceSettings.timezone, workingDays: workspaceSettings.workingDays })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    // A workspace with no settings row gets the column defaults rather than an error or an
    // empty axis: UTC and Mon–Fri behave identically to a freshly seeded workspace.
    return {
      timeZone: rows[0]?.timeZone ?? 'UTC',
      workingDays: rows[0]?.workingDays?.length ? rows[0].workingDays : [...DEFAULT_WORKING_DAYS],
    };
  }

  async getProjectName(workspaceId: string, projectId: string): Promise<string | null> {
    const rows = await this.db
      .select({ name: projects.name })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.workspaceId, workspaceId),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);
    return rows[0]?.name ?? null;
  }

  async getTeamName(workspaceId: string, teamId: string): Promise<string | null> {
    const rows = await this.db
      .select({ name: teams.name })
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  async findIteration(workspaceId: string, iterationId: string): Promise<IterationRow | null> {
    const rows = await this.db
      .select(ITERATION_COLUMNS)
      .from(iterations)
      .where(and(eq(iterations.id, iterationId), eq(iterations.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findTimeboxSiblings(
    workspaceId: string,
    projectId: string,
    timeboxGroupId: string | null,
    scope: TeamScope,
    fallbackIterationId: string,
  ): Promise<IterationRow[]> {
    // A reader with no Team has no scope at all, and this is the query every iteration report's
    // scope flows from — so it is also where their empty state begins.
    if (isEmptyTeamScope(scope)) return [];
    // A dateless iteration belongs to no timebox, so there is nothing to fuse and the
    // selected iteration IS the scope. Grouping on a null key would pool every unscheduled
    // iteration in the project into one bar.
    const where =
      timeboxGroupId === null
        ? and(eq(iterations.id, fallbackIterationId), eq(iterations.workspaceId, workspaceId))
        : and(
            eq(iterations.workspaceId, workspaceId),
            eq(iterations.projectId, projectId),
            eq(iterations.timeboxGroupId, timeboxGroupId),
            timeboxInScope(scope),
          );

    const rows = await this.db
      .select(ITERATION_COLUMNS)
      .from(iterations)
      .where(where)
      .orderBy(asc(iterations.name), asc(iterations.id));
    return rows;
  }

  // ── Iteration Burndown ────────────────────────────────────────────────────

  async getIterationSnapshots(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
    /** The workspace's calendar — needed to say whether a capture closed its own local day. */
    timeZone: string,
  ): Promise<StoredSnapshot[]> {
    if (iterationIds.length === 0) return [];
    /**
     * ONE series, or none — `frozenSeriesScope` owns that decision (see its docblock).
     *
     * A team-restricted reader holding several Teams asked for an aggregate that was never
     * measured: the `team_id IS NULL` row spans Teams they may not see, and summing their team rows
     * is forbidden here. Returning no rows makes the report say the history is unavailable for this
     * scope, which is true, instead of fabricating or leaking one.
     */
    const frozen = frozenSeriesScope(scope);
    if (frozen === null) return [];
    const rows = await this.db
      .select({
        date: iterationDailySnapshots.snapshotDate,
        remainingToDo: iterationDailySnapshots.remainingTodo,
        acceptedPoints: iterationDailySnapshots.acceptedPoints,
        capturedAt: iterationDailySnapshots.capturedAt,
      })
      .from(iterationDailySnapshots)
      .where(
        and(
          eq(iterationDailySnapshots.workspaceId, workspaceId),
          inArray(iterationDailySnapshots.iterationId, iterationIds),
          /**
           * Exactly ONE series per iteration: the team's own rows, or the All Teams row.
           *
           * Not a filter that can match both — `team_id IS NULL` is a MEASURED total over the
           * whole scope, so including it alongside a team's rows would double every day the two
           * overlap. Team rows only exist from migration 0093 onwards, so a team-scoped chart of
           * older history is a legitimate gap rather than a silent fallback to All Teams.
           */
          frozen.kind === 'team'
            ? eq(iterationDailySnapshots.teamId, frozen.teamId)
            : isNull(iterationDailySnapshots.teamId),
        ),
      )
      .orderBy(asc(iterationDailySnapshots.snapshotDate), asc(iterationDailySnapshots.id));
    // One flat list across every fused iteration; `combineTeamSnapshots` sums per date.
    // Summing in SQL would hide which Teams contributed a day.
    return rows.map((r) => ({
      date: r.date,
      remainingToDo: num(r.remainingToDo),
      acceptedPoints: num(r.acceptedPoints),
      capturedAt: r.capturedAt,
      // Whether this row is the day's CLOSING figure or a reading the job left behind when it stopped
      // early. `finalizeSnapshotsBefore` freezes a closed day either way — it cannot be re-measured —
      // so the difference has to travel with the number instead of being lost.
      endOfDay: isEndOfDayCapture(r.capturedAt, r.date, timeZone),
    }));
  }

  async countScheduledWork(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<number> {
    if (iterationIds.length === 0) return 0;
    const iteration = alias(iterations, 'scheduled_iteration');
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workItems)
      // Joined only so the team can be resolved the two-tier way; the membership predicate is still
      // the item's own `iteration_id`.
      .leftJoin(iteration, eq(iteration.id, workItems.iterationId))
      .where(
        and(
          eq(workItems.workspaceId, workspaceId),
          inArray(workItems.iterationId, iterationIds),
          inArray(workItems.type, [...LEAF_TYPES]),
          isNull(workItems.deletedAt),
          /**
           * The SAME scope the series was measured in.
           *
           * Counted project-wide, a Team with no work in a SHARED iteration still saw
           * `hasScheduledWork: true` — because the count saw the other teams' items — so instead of
           * "no scheduled work" the reader was told the snapshot history was missing and sent to look
           * for a broken cron job.
           *
           * For a team-restricted reader the same clause also excludes the Project Backlog: an item
           * with no team anywhere resolves to NULL, which no `IN (…)` matches.
           */
          teamMatches(scope, sql`coalesce(${workItems.teamId}, ${iteration.teamId})`),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /**
   * The `SPLIT OUT` / `CARRY IN` events for a set of iterations (SU-08 8.2).
   *
   * ONE query with the side as a parameter, rather than two near-identical ones: the only difference
   * between "left this iteration" and "arrived in this iteration" is WHICH column is matched and which
   * iteration resolves the team, and the four joins, the workspace predicate and the ordering are
   * common. Two copies of that is how one of them comes to be missing a predicate.
   *
   * Both Stories are `innerJoin`ed and must be LIVE. A marker names a Story by key and the reader is
   * expected to be able to find it; a deleted end makes the annotation unfollowable, and its numbers
   * are already in the frozen series either way.
   *
   * ORDER BY the marker date then the split id — the id is what makes it TOTAL (query-ordering
   * ratchet), and two Splits on the same day are otherwise returned in scan order, which would
   * reorder the compact context strip between two renders of the same chart.
   */
  private async findSplits(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
    side: 'source' | 'target',
  ): Promise<StoredSplitEvent[]> {
    if (iterationIds.length === 0) return [];
    const unfinished = alias(workItems, 'split_out_story');
    const continued = alias(workItems, 'carry_in_story');
    const iteration = alias(iterations, 'split_marker_iteration');
    const matchedIterationId =
      side === 'source' ? storySplits.sourceIterationId : storySplits.targetIterationId;

    const rows = await this.db
      .select({
        splitId: storySplits.id,
        sourceIterationId: storySplits.sourceIterationId,
        targetIterationId: storySplits.targetIterationId,
        sourceMarkerDate: storySplits.sourceMarkerDate,
        targetMarkerDate: storySplits.targetMarkerDate,
        unfinishedStoryId: unfinished.id,
        unfinishedStoryKey: unfinished.itemKey,
        unfinishedPlanEstimate: storySplits.unfinishedPlanEstimate,
        continuedStoryId: continued.id,
        continuedStoryKey: continued.itemKey,
        continuedPlanEstimate: storySplits.continuedPlanEstimate,
        movedTodoHours: storySplits.movedTodoHours,
        actualHoursAtSplit: storySplits.actualHoursAtSplit,
      })
      .from(storySplits)
      .innerJoin(
        unfinished,
        and(eq(unfinished.id, storySplits.unfinishedStoryId), isNull(unfinished.deletedAt)),
      )
      .innerJoin(
        continued,
        and(eq(continued.id, storySplits.continuedStoryId), isNull(continued.deletedAt)),
      )
      // Joined only to resolve the team the two-tier way; membership is the matched column above.
      .leftJoin(iteration, eq(iteration.id, matchedIterationId))
      .where(
        and(
          eq(storySplits.workspaceId, workspaceId),
          inArray(matchedIterationId, iterationIds),
          /**
           * The SAME two-tier rule the series is measured with — the Split's own team, falling back
           * to the matched iteration's.
           *
           * `story_splits.team_id` is the Story's team AS AT the Split, which is the honest owner: the
           * `[Continued]` Story's team is mutable afterwards, and a marker describing a past event
           * must not move between team charts when someone re-assigns the Story today.
           */
          teamMatches(scope, sql`coalesce(${storySplits.teamId}, ${iteration.teamId})`),
        ),
      )
      .orderBy(
        asc(side === 'source' ? storySplits.sourceMarkerDate : storySplits.targetMarkerDate),
        asc(storySplits.id),
      );

    return rows.map((row) => ({
      splitId: row.splitId,
      sourceIterationId: row.sourceIterationId,
      targetIterationId: row.targetIterationId,
      sourceMarkerDate: row.sourceMarkerDate,
      targetMarkerDate: row.targetMarkerDate,
      unfinishedStoryId: row.unfinishedStoryId,
      unfinishedStoryKey: row.unfinishedStoryKey,
      // `numeric` arrives as a string, and `null` is "unpointed" rather than "worth nothing".
      unfinishedPlanEstimate: nullableNum(row.unfinishedPlanEstimate),
      continuedStoryId: row.continuedStoryId,
      continuedStoryKey: row.continuedStoryKey,
      continuedPlanEstimate: nullableNum(row.continuedPlanEstimate),
      movedTodoHours: num(row.movedTodoHours),
      actualHoursAtSplit: num(row.actualHoursAtSplit),
    }));
  }

  async findSplitsBySourceIteration(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<StoredSplitEvent[]> {
    return this.findSplits(workspaceId, iterationIds, scope, 'source');
  }

  async findSplitsByTargetIteration(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<StoredSplitEvent[]> {
    return this.findSplits(workspaceId, iterationIds, scope, 'target');
  }

  // ── Velocity ──────────────────────────────────────────────────────────────

  async findEligibleTimeboxes(
    workspaceId: string,
    projectId: string,
    scope: TeamScope,
    todayLocalDate: string,
  ): Promise<TimeboxGroup[]> {
    // Eligibility is both halves of Velocity §2: the local end date is already past, AND at
    // least one Story/Defect is currently assigned. The inner join enforces the second half,
    // so an empty iteration never becomes a bar.
    //
    // Grouped by timebox_group_id so two Teams' iterations for one window collapse into ONE
    // bar — the defect the approved mockup exhibits (two adjacent bars both labelled 25.1).
    // COALESCE to the iteration id keeps an ungrouped iteration as its own bar instead of
    // pooling every ungrouped one together.
    const groupKey = sql`coalesce(${iterations.timeboxGroupId}::text, ${iterations.id}::text)`;
    const rows = await this.db
      .select({
        groupId: sql<string | null>`max(${iterations.timeboxGroupId}::text)`,
        name: sql<string>`min(${iterations.name})`,
        startDate: sql<string | null>`min(${iterations.startDate})`,
        endDate: sql<string | null>`max(${iterations.endDate})`,
        iterationIds: sql<string[]>`array_agg(distinct ${iterations.id}::text)`,
      })
      .from(iterations)
      .innerJoin(
        workItems,
        and(
          eq(workItems.iterationId, iterations.id),
          inArray(workItems.type, [...LEAF_TYPES]),
          isNull(workItems.deletedAt),
          /**
           * Eligibility is decided over the SAME population the bar is later measured from.
           *
           * Velocity SRS §2: an iteration is eligible only when "at least one Story or Defect is
           * currently assigned to it", and "for a selected Team, use that Team only". This join
           * carried no team predicate at all, while `getVelocityItems` narrows by
           * `coalesce(item.team_id, iteration.team_id)` — so a shared timebox admitted by
           * `teamOrSharedTimebox` became an eligible bar for a team whose work was then filtered out
           * of it. The result was a zero-point bar for a sprint the team never worked in, and those
           * zeros divided Trend, Last 3, Best 3 and Worst 3.
           *
           * The property holds for the restricted scope too: `getVelocityItems` narrows by the same
           * `IN (…)` over the same coalesce, so a bar exists only where that reader has work.
           */
          teamMatches(scope, sql`coalesce(${workItems.teamId}, ${iterations.teamId})`),
        ),
      )
      .where(
        and(
          eq(iterations.workspaceId, workspaceId),
          eq(iterations.projectId, projectId),
          sql`${iterations.endDate} < ${todayLocalDate}`,
          timeboxInScope(scope),
        ),
      )
      .groupBy(groupKey)
      // Total order: two timeboxes can share an end date, so the tiebreaker is the smallest
      // iteration id in the group — unique per group, and stable across ticks.
      .orderBy(sql`max(${iterations.endDate}) asc`, sql`min(${iterations.id}::text) asc`);

    return rows.map((r) => ({
      timeboxGroupId: r.groupId,
      name: r.name,
      startDate: r.startDate,
      endDate: r.endDate,
      iterationIds: r.iterationIds,
    }));
  }

  async getVelocityItems(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<Array<VelocityItem & { iterationId: string }>> {
    if (iterationIds.length === 0) return [];
    const iteration = alias(iterations, 'velocity_iteration');
    /**
     * Whose points these are: the ITEM's team, falling back to its iteration's.
     *
     * The same two-tier rule `getScopedTaskHours` uses, and it has to be here too — this query
     * had no team predicate at all, so team scope came only from which iterations were selected.
     * That attributed work by the TIMEBOX's team, and nothing keeps the two in step: the seeded
     * database already holds Team Beta's `US-D2` sitting in Team Alpha's Sprint 26.1, counted as
     * Alpha's 8 points and absent from Beta's chart entirely.
     */
    const resolvedTeam = sql`coalesce(${workItems.teamId}, ${iteration.teamId})`;
    const rows = await this.db
      .select({
        id: workItems.id,
        iterationId: workItems.iterationId,
        planEstimate: workItems.storyPoints,
        // {accepted, release}. `Completed` is NOT accepted-equivalent.
        acceptedEquivalent: sql<boolean>`${workItems.scheduleState} in (${acceptedScheduleStatesSql()})`,
        acceptedDate: workItems.acceptedDate,
        /**
         * Phase 7 SU-09 9.2 — is this row a Split's `[Unfinished]` placeholder (plan D6)?
         *
         * A PREDICATE, not the id: the classifier asks one yes/no question, and `split_id` itself
         * would tempt a later reader into resolving the Split here, inside a query that runs once per
         * velocity render.
         *
         * NOT an exclusion, which is what separates this call site from SU-08 8.1's three. There the
         * placeholder had to leave a delivered-points SUM; here it earns its own visible segment, so
         * filtering it out in SQL would delete the segment instead of building it — recorded in 8.1's
         * own "left alone, with reasons" list for exactly this reason.
         */
        splitCarryover: sql<boolean>`${workItems.splitId} is not null`,
      })
      .from(workItems)
      .leftJoin(iteration, eq(iteration.id, workItems.iterationId))
      .where(
        and(
          eq(workItems.workspaceId, workspaceId),
          inArray(workItems.iterationId, iterationIds),
          inArray(workItems.type, [...LEAF_TYPES]),
          isNull(workItems.deletedAt),
          teamMatches(scope, resolvedTeam),
        ),
      );
    return rows.map((r) => ({
      id: r.id,
      iterationId: r.iterationId as string,
      planEstimate: nullableNum(r.planEstimate),
      acceptedEquivalent: r.acceptedEquivalent,
      acceptedDate: r.acceptedDate,
      splitCarryover: r.splitCarryover,
    }));
  }

  // ── Team Capacity ─────────────────────────────────────────────────────────

  async getCapacityRecords(
    workspaceId: string,
    projectId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<CapacityRecord[]> {
    if (iterationIds.length === 0) return [];
    const rows = await this.db
      .select({
        teamId: memberCapacity.teamId,
        teamName: teams.name,
        teamStatus: teams.status,
        memberId: memberCapacity.userId,
        memberName: users.displayName,
        capacityHours: memberCapacity.capacityHours,
      })
      .from(memberCapacity)
      .innerJoin(teams, eq(teams.id, memberCapacity.teamId))
      .innerJoin(users, eq(users.id, memberCapacity.userId))
      .where(
        and(
          eq(memberCapacity.workspaceId, workspaceId),
          eq(memberCapacity.projectId, projectId),
          inArray(memberCapacity.iterationId, iterationIds),
          // `member_capacity.team_id` is NOT NULL, so there is no Project Backlog row to exclude
          // here — the exclusion that matters for this report is in `getScopedTaskHours` below.
          teamMatches(scope, memberCapacity.teamId),
        ),
      );
    return rows.map((r) => ({
      teamId: r.teamId,
      teamName: r.teamName,
      teamArchived: r.teamStatus === 'archived',
      memberId: r.memberId,
      memberName: r.memberName,
      capacityHours: num(r.capacityHours),
    }));
  }

  async getScopedTaskHours(
    workspaceId: string,
    projectId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<ScopedTaskHours[]> {
    if (iterationIds.length === 0) return [];
    const parent = alias(workItems, 'parent');
    const team = alias(teams, 'task_team');
    const iteration = alias(iterations, 'task_iteration');
    // Three tiers, most specific first. The iteration is the last resort because a
    // team-scoped iteration IS a statement about whose work this is — and without that tier a
    // project that assigns Teams only at the iteration level would show hours on Team Status
    // and nothing at all here, which is precisely the disagreement this projection exists to
    // prevent. Still null after all three (no Team anywhere) groups under `No Team` rather
    // than being dropped.
    const resolvedTeam = sql`coalesce(${tasks.teamId}, ${parent.teamId}, ${iteration.teamId})`;

    // The scoping predicate is Team Status's, not a new one: a task is in scope when the
    // task OR its parent Story/Defect is assigned to the iteration. The SRS requires
    // "Totals use the same Team Status source", and `TeamStatusDrizzleRepository.getTaskRows`
    // uses exactly this rule — a parent-only variant would show different totals on the two
    // screens for the same iteration, which is the one thing this projection must not do.
    //
    // Parent status does not exclude its tasks (§3): accepted or released work still
    // contributes hours while it remains assigned to the iteration.
    const rows = await this.db
      .select({
        taskId: tasks.id,
        teamId: sql<string | null>`${resolvedTeam}`,
        teamName: team.name,
        teamStatus: team.status,
        ownerId: tasks.assigneeId,
        ownerName: users.displayName,
        estimateHours: tasks.estimateHours,
        todoHours: tasks.todoHours,
        actualHours: tasks.actualHours,
      })
      .from(tasks)
      .innerJoin(parent, and(eq(parent.id, tasks.parentId), isNull(parent.deletedAt)))
      .leftJoin(
        iteration,
        sql`${iteration.id} = coalesce(${tasks.iterationId}, ${parent.iterationId})`,
      )
      .leftJoin(team, sql`${team.id} = ${resolvedTeam}`)
      .leftJoin(users, eq(users.id, tasks.assigneeId))
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          eq(tasks.projectId, projectId),
          isNull(tasks.deletedAt),
          sql`(${tasks.iterationId} in ${inList(iterationIds)} or ${parent.iterationId} in ${inList(iterationIds)})`,
          /**
           * For a team-restricted reader this also drops the `No Team` bucket.
           *
           * A task with no team on itself, its parent or its iteration is Project Backlog work, which
           * the 2026-08-17 ruling makes admin-only — so it must not reach that reader's Capacity
           * totals, even though it groups under `No Team` for an admin.
           */
          teamMatches(scope, resolvedTeam),
        ),
      );

    return rows.map((r) => ({
      taskId: r.taskId,
      teamId: r.teamId,
      teamName: r.teamName,
      teamArchived: r.teamStatus === 'archived',
      ownerId: r.ownerId,
      ownerName: r.ownerName,
      estimateHours: num(r.estimateHours),
      todoHours: num(r.todoHours),
      actualHours: num(r.actualHours),
    }));
  }

  // ── Release Tracking ──────────────────────────────────────────────────────

  async findRelease(workspaceId: string, releaseId: string): Promise<ReleaseRow | null> {
    const rows = await this.db
      .select({
        id: releases.id,
        workspaceId: releases.workspaceId,
        projectId: releases.projectId,
        name: releases.name,
        startDate: releases.startDate,
        releaseDate: releases.releaseDate,
      })
      .from(releases)
      .where(and(eq(releases.id, releaseId), eq(releases.workspaceId, workspaceId)))
      .limit(1);
    // The Ideal target is no longer a column here: it is per team in `release_team_targets`, read via
    // `findReleaseTeamTarget` in the SAME scope the measured series is read in.
    return rows[0] ?? null;
  }

  async getReleaseFeatures(
    workspaceId: string,
    projectId: string,
    preliminaryPoints: (size: string) => number,
    preliminaryCount: (size: string) => number,
  ): Promise<Array<ReleaseFeature & { state: string }>> {
    const rows = await this.db
      .select({
        id: portfolioItems.id,
        itemKey: portfolioItems.itemKey,
        name: portfolioItems.name,
        state: portfolioItems.state,
        releaseId: portfolioItems.releaseId,
        teamId: portfolioItems.teamId,
        teamName: teams.name,
        rank: portfolioItems.rank,
        plannedStartDate: portfolioItems.plannedStartDate,
        plannedEndDate: portfolioItems.plannedEndDate,
        refinedPoints: portfolioItems.refinedEstimate,
        refinedCount: portfolioItems.refinedItemCountEstimate,
        preliminaryEstimate: portfolioItems.preliminaryEstimate,
      })
      .from(portfolioItems)
      .leftJoin(teams, eq(teams.id, portfolioItems.teamId))
      .where(
        and(
          eq(portfolioItems.workspaceId, workspaceId),
          eq(portfolioItems.projectId, projectId),
          eq(portfolioItems.type, 'feature'),
          // Archived Features are out of sight on every other Feature surface; a report that
          // resurrected them would contradict all of them.
          isNull(portfolioItems.archivedAt),
        ),
      )
      .orderBy(asc(portfolioItems.rank), asc(portfolioItems.itemKey), asc(portfolioItems.id));

    return rows.map((r) => ({
      id: r.id,
      itemKey: r.itemKey,
      name: r.name,
      state: r.state,
      releaseId: r.releaseId,
      teamId: r.teamId,
      teamName: r.teamName,
      rank: r.rank,
      plannedStartDate: r.plannedStartDate,
      plannedEndDate: r.plannedEndDate,
      refinedPoints: num(r.refinedPoints),
      refinedCount: r.refinedCount,
      preliminaryPoints: preliminaryPoints(r.preliminaryEstimate),
      preliminaryCount: preliminaryCount(r.preliminaryEstimate),
    }));
  }

  async getReleaseChildren(
    workspaceId: string,
    projectId: string,
    releaseId: string,
  ): Promise<ReleaseChild[]> {
    const release = alias(releases, 'child_release');
    const team = alias(teams, 'child_team');

    // Two populations in one pass, because both are needed and neither contains the other:
    //   • items assigned to THIS release — the tracked leaves, the Derived causes and the
    //     Unparented bucket;
    //   • items linked to ANY Feature in the project — a Direct Feature's Status counts every
    //     direct child, including children in another release or none (RT-BR-05).
    // Filtering to one of them would silently change a Status denominator.
    const rows = await this.db
      .select({
        id: workItems.id,
        itemKey: workItems.itemKey,
        type: workItems.type,
        title: workItems.title,
        featureId: workItems.featureId,
        releaseId: workItems.releaseId,
        releaseName: release.name,
        teamId: workItems.teamId,
        teamName: team.name,
        planEstimate: workItems.storyPoints,
        acceptedEquivalent: sql<boolean>`${workItems.scheduleState} in (${acceptedScheduleStatesSql()})`,
        scheduleState: workItems.scheduleState,
      })
      .from(workItems)
      .leftJoin(release, eq(release.id, workItems.releaseId))
      .leftJoin(team, eq(team.id, workItems.teamId))
      .where(
        and(
          eq(workItems.workspaceId, workspaceId),
          eq(workItems.projectId, projectId),
          inArray(workItems.type, [...LEAF_TYPES]),
          isNull(workItems.deletedAt),
          sql`(${workItems.releaseId} = ${releaseId}::uuid or ${workItems.featureId} is not null)`,
        ),
      )
      /**
       * Backlog rank order, and a total one.
       *
       * This query had NO `ORDER BY` at all, so the Unparented bucket's order — and with it the
       * Rank column and which rows land on which page — was whatever Postgres returned. Two
       * requests for the same page could legitimately disagree, dropping or repeating a row at the
       * boundary. `rank` is the same lexorank the Backlog and Iteration Status order by, so the
       * bucket now reads in the order every other list shows these items in, and `item_key`/`id`
       * make the order total for the rows that share a rank (the column defaults to `''`).
       */
      .orderBy(asc(workItems.rank), asc(workItems.itemKey), asc(workItems.id));

    return rows.map((r) => ({
      id: r.id,
      itemKey: r.itemKey,
      type: r.type as 'story' | 'defect',
      title: r.title,
      featureId: r.featureId,
      releaseId: r.releaseId,
      releaseName: r.releaseName,
      teamId: r.teamId,
      teamName: r.teamName,
      planEstimate: nullableNum(r.planEstimate),
      acceptedEquivalent: r.acceptedEquivalent,
      scheduleState: r.scheduleState,
    }));
  }

  async getReleaseBurnupRows(
    workspaceId: string,
    releaseId: string,
    scope: TeamScope,
    unit: 'points' | 'count',
  ): Promise<StoredBurnupRow[]> {
    // One series or none, exactly as `getIterationSnapshots` — and here a sum would be wrong on its
    // own terms as well as forbidden: a team-agnostic child counts inside EVERY team's row (see
    // `inScope`), so adding two team rows double-counts it.
    const frozen = frozenSeriesScope(scope);
    if (frozen === null) return [];
    const rows = await this.db
      .select({
        date: releaseDailySnapshots.snapshotDate,
        acceptedPoints: releaseDailySnapshots.acceptedPoints,
        acceptedCount: releaseDailySnapshots.acceptedCount,
        plannedPoints: releaseDailySnapshots.plannedPoints,
        plannedCount: releaseDailySnapshots.plannedCount,
        preliminaryPoints: releaseDailySnapshots.preliminaryPoints,
        preliminaryCount: releaseDailySnapshots.preliminaryCount,
      })
      .from(releaseDailySnapshots)
      .where(
        and(
          // Redundant with release_id in practice, and kept anyway: every read of a
          // workspace-bearing table states the workspace, so a mistaken id cannot cross a
          // tenant boundary.
          eq(releaseDailySnapshots.workspaceId, workspaceId),
          eq(releaseDailySnapshots.releaseId, releaseId),
          // The All Teams row is STORED (`team_id IS NULL`) rather than summed from the Team
          // rows: an item two Teams both touch must be counted once, which a SUM cannot do.
          frozen.kind === 'team'
            ? eq(releaseDailySnapshots.teamId, frozen.teamId)
            : isNull(releaseDailySnapshots.teamId),
        ),
      )
      .orderBy(asc(releaseDailySnapshots.snapshotDate), asc(releaseDailySnapshots.id));

    return rows.map((r) => ({
      date: r.date,
      accepted: unit === 'points' ? num(r.acceptedPoints) : r.acceptedCount,
      planned: unit === 'points' ? num(r.plannedPoints) : r.plannedCount,
      preliminary: unit === 'points' ? num(r.preliminaryPoints) : r.preliminaryCount,
    }));
  }

  async findIterationsInWindow(
    workspaceId: string,
    projectId: string,
    scope: TeamScope,
    startDate: string,
    endDate: string,
  ): Promise<IterationRow[]> {
    const rows = await this.db
      .select(ITERATION_COLUMNS)
      .from(iterations)
      .where(
        and(
          eq(iterations.workspaceId, workspaceId),
          eq(iterations.projectId, projectId),
          // Overlap, not containment: an iteration straddling the release start belongs under
          // the axis just as much as one fully inside it.
          sql`${iterations.startDate} <= ${endDate} and ${iterations.endDate} >= ${startDate}`,
          /**
           * `teamOrSharedTimebox`, not a strict equality.
           *
           * This was the ONE team-scoped iteration query in this file that did not use the helper two
           * functions below, and SQL equality never matches NULL — so every shared (team-less)
           * iteration was dropped. Measured locally: release `v2.0` is crossed only by `Sprint 26.2`,
           * whose `team_id` is NULL, so All Teams showed the burnup's secondary iteration band and
           * selecting ANY team made the whole row vanish — telling the reader the release crosses no
           * sprints. `findTimeboxSiblings` and `findEligibleTimeboxes` already got this right.
           *
           * `timeboxInScope` is now the single home of that rule, for the same reason: the ternary
           * this replaced treated any new scope kind as "no filter".
           */
          timeboxInScope(scope),
        ),
      )
      .orderBy(asc(iterations.startDate), asc(iterations.id));
    return rows;
  }

  // ── the daily snapshot job ────────────────────────────────────────────────

  async findActiveIterations(): Promise<ActiveIterationRow[]> {
    const rows = await this.db
      .select({ ...ITERATION_COLUMNS, workspaceId: iterations.workspaceId })
      .from(iterations)
      // Committed only, matching what the product calls an active iteration. A `planning`
      // iteration has no execution to burn down, and an `accepted` one is finished — writing
      // rows for either would put flat lines on charts nobody is looking at.
      .where(eq(iterations.state, 'committed'));
    return rows;
  }

  async findActiveReleases(): Promise<ActiveReleaseRow[]> {
    const rows = await this.db
      .select({
        id: releases.id,
        workspaceId: releases.workspaceId,
        projectId: releases.projectId,
        startDate: releases.startDate,
        releaseDate: releases.releaseDate,
      })
      .from(releases)
      // A release with no window has no burnup axis, so there is nothing to snapshot against.
      // The service filters by the workspace's own local today.
      .where(sql`${releases.startDate} is not null and ${releases.releaseDate} is not null`);
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      projectId: r.projectId,
      startDate: r.startDate as string,
      releaseDate: r.releaseDate as string,
    }));
  }

  async findWorkspacesWithOpenSnapshots(): Promise<string[]> {
    /**
     * Both snapshot tables, unioned and de-duplicated.
     *
     * Asks about the ROWS rather than about what is currently active: a workspace whose last iteration
     * has closed has nothing active, so it never reappeared in the snapshot loop's workspace set and
     * its final day stayed unfinalized forever. Indexed on `finalized` in both tables, so this is a
     * partial-index scan rather than a table walk.
     */
    const [iterationRows, releaseRows] = await Promise.all([
      this.db
        .selectDistinct({ workspaceId: iterationDailySnapshots.workspaceId })
        .from(iterationDailySnapshots)
        .where(eq(iterationDailySnapshots.finalized, false)),
      this.db
        .selectDistinct({ workspaceId: releaseDailySnapshots.workspaceId })
        .from(releaseDailySnapshots)
        .where(eq(releaseDailySnapshots.finalized, false)),
    ]);

    return [...new Set([...iterationRows, ...releaseRows].map((row) => row.workspaceId))];
  }

  async sumTaskEstimateByTeam(
    workspaceId: string,
    iterationId: string,
  ): Promise<Array<{ teamId: string | null; total: number }>> {
    const parent = alias(workItems, 'parent');
    const iteration = alias(iterations, 'baseline_iteration');
    /**
     * The SAME three-tier team resolution the hours are measured with
     * (`coalesce(task, parent, iteration)`), so the baseline and the bars it is compared against can
     * never be scoped differently. A row with no resolvable team groups under `NULL` and is summed
     * into All Teams rather than dropped.
     */
    const resolvedTeam = sql<
      string | null
    >`coalesce(${tasks.teamId}, ${parent.teamId}, ${iteration.teamId})`;
    const rows = await this.db
      .select({
        teamId: resolvedTeam.as('team_id'),
        total: sql<number>`coalesce(sum(${tasks.estimateHours}), 0)::float8`,
      })
      .from(tasks)
      .innerJoin(parent, and(eq(parent.id, tasks.parentId), isNull(parent.deletedAt)))
      .leftJoin(
        iteration,
        sql`${iteration.id} = coalesce(${tasks.iterationId}, ${parent.iterationId})`,
      )
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.deletedAt),
          sql`(${tasks.iterationId} = ${iterationId}::uuid or ${parent.iterationId} = ${iterationId}::uuid)`,
        ),
      )
      .groupBy(resolvedTeam);
    return rows.map((r) => ({ teamId: r.teamId, total: Number(r.total) }));
  }

  async captureTeamBaselines(
    workspaceId: string,
    iterationId: string,
    rows: Array<{ teamId: string | null; total: number }>,
    at: Date,
  ): Promise<void> {
    if (rows.length === 0) return;
    /**
     * `onConflictDoNothing`, which is what makes this a ONE-TIME capture per scope.
     *
     * The Ideal line must not move when tasks are added or re-estimated after the iteration starts, so
     * a second tick inserts nothing rather than overwriting. This replaces the old `IS NULL` predicate
     * on `iterations.total_task_estimate_at_start`, which could only express one baseline per
     * iteration.
     */
    await this.db
      .insert(iterationTeamBaselines)
      .values(
        rows.map((row) => ({
          workspaceId,
          iterationId,
          teamId: row.teamId,
          totalTaskEstimateAtStart: String(row.total),
          capturedAt: at,
        })),
      )
      .onConflictDoNothing();
  }

  async sumTeamBaselines(
    workspaceId: string,
    iterationIds: string[],
    scope: TeamScope,
  ): Promise<number | null> {
    if (iterationIds.length === 0) return null;
    /**
     * IB §4: "For All Teams, the baseline is the SUM of the participating Team baselines."
     *
     * Returns `null` — not 0 — when no row exists for the scope, because "no baseline was recorded"
     * and "the recorded baseline was zero" are different facts and only the first may hide the Ideal
     * line. A pre-0098 iteration has one no-team row, so All Teams keeps its old number while a
     * team-scoped read honestly finds nothing.
     *
     * Scoped through `frozenSeriesScope` so the baseline and the bars it is compared against can
     * never be scoped differently — §6 compares `remainingToDo(d)` with `ideal(d)`, so a baseline
     * served for a scope whose bars are unavailable would draw a plan over an empty chart. A
     * multi-Team restricted reader gets `null`: no Ideal, exactly as they get no series.
     */
    const frozen = frozenSeriesScope(scope);
    if (frozen === null) return null;
    const rows = await this.db
      .select({
        total: sql<number | null>`sum(${iterationTeamBaselines.totalTaskEstimateAtStart})::float8`,
      })
      .from(iterationTeamBaselines)
      .where(
        and(
          eq(iterationTeamBaselines.workspaceId, workspaceId),
          inArray(iterationTeamBaselines.iterationId, iterationIds),
          // All Teams SUMS every row (IB §4), including the no-team one; a single Team reads its own.
          frozen.kind === 'team' ? eq(iterationTeamBaselines.teamId, frozen.teamId) : undefined,
        ),
      );
    const total = rows[0]?.total;
    return total === null || total === undefined ? null : Number(total);
  }

  async captureReleaseTeamTarget(input: {
    workspaceId: string;
    releaseId: string;
    teamId: string | null;
    plannedPoints: number;
    plannedCount: number;
    at: Date;
  }): Promise<void> {
    /**
     * `onConflictDoNothing`, which is what makes this a ONE-TIME capture PER SCOPE.
     *
     * RT-BR-09 forbids deriving the Ideal from today's mutable Planned value, so a second tick must add
     * nothing rather than move the target as scope changes. This replaces an `UPDATE … WHERE
     * ideal_target_points IS NULL` on two `releases` columns, which could only ever express one target
     * per release — the reason every team's burnup was drawn against the whole release's plan.
     */
    await this.db
      .insert(releaseTeamTargets)
      .values({
        workspaceId: input.workspaceId,
        releaseId: input.releaseId,
        teamId: input.teamId,
        idealTargetPoints: String(input.plannedPoints),
        idealTargetCount: Math.round(input.plannedCount),
        capturedAt: input.at,
      })
      .onConflictDoNothing();
  }

  async findReleaseTeamTarget(
    workspaceId: string,
    releaseId: string,
    scope: TeamScope,
  ): Promise<{ points: number; count: number } | null> {
    /**
     * The ONE row for this scope — never a sum.
     *
     * All Teams reads the `team_id IS NULL` row, which was MEASURED over the whole release, exactly as
     * `getReleaseBurnupRows` reads its Accepted series. Summing the team rows instead would double a
     * Feature whose children span two teams, because it lands in both teams' derived buckets (RT §4.1),
     * and would leave the Ideal measured over a different population than the line beneath it.
     * `iteration_team_baselines` sums because IB §4 says to; this table must not.
     *
     * Returns `null`, not zeros, when the scope has no row: "no approved target" and "a target of zero"
     * are different facts and only the first may hide the Ideal line. A pre-0099 release carries only
     * the no-team row, so All Teams keeps exactly its old number while a team-scoped burnup honestly
     * finds nothing.
     *
     * A multi-Team restricted reader has no series here either, so it has no target: an Ideal drawn
     * over an unavailable Accepted line is a plan with nothing to judge it against.
     */
    const frozen = frozenSeriesScope(scope);
    if (frozen === null) return null;
    const rows = await this.db
      .select({
        points: releaseTeamTargets.idealTargetPoints,
        count: releaseTeamTargets.idealTargetCount,
      })
      .from(releaseTeamTargets)
      .where(
        and(
          eq(releaseTeamTargets.workspaceId, workspaceId),
          eq(releaseTeamTargets.releaseId, releaseId),
          frozen.kind === 'team'
            ? eq(releaseTeamTargets.teamId, frozen.teamId)
            : isNull(releaseTeamTargets.teamId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { points: Number(row.points), count: row.count };
  }

  async measureIterationDay(
    workspaceId: string,
    iterationId: string,
    endOfDay: Date,
    teamId: string | null = null,
  ): Promise<{ remainingTodo: number; acceptedPoints: number }> {
    const parent = alias(workItems, 'parent');
    const iteration = alias(iterations, 'measured_iteration');
    /**
     * Whose work this is — the same two-tier rule the live reports use.
     *
     * `teamId === null` MEASURES the whole iteration scope (the All Teams row), it does not sum
     * the team rows: a task two teams both touch has to be counted once, and summing would count
     * it twice. `release_daily_snapshots` already works this way.
     */
    const taskTeam = sql`coalesce(${tasks.teamId}, ${parent.teamId}, ${iteration.teamId})`;
    const itemTeam = sql`coalesce(${workItems.teamId}, ${iteration.teamId})`;

    const [todo] = await this.db
      .select({ total: sql<number>`coalesce(sum(${tasks.todoHours}), 0)::float8` })
      .from(tasks)
      .innerJoin(parent, and(eq(parent.id, tasks.parentId), isNull(parent.deletedAt)))
      .leftJoin(
        iteration,
        sql`${iteration.id} = coalesce(${tasks.iterationId}, ${parent.iterationId})`,
      )
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.deletedAt),
          // Same scoping rule as Team Status and the Team Capacity projection.
          sql`(${tasks.iterationId} = ${iterationId}::uuid or ${parent.iterationId} = ${iterationId}::uuid)`,
          teamId === null ? undefined : sql`${taskTeam} = ${teamId}::uuid`,
        ),
      );

    const [accepted] = await this.db
      .select({ total: sql<number>`coalesce(sum(${workItems.storyPoints}), 0)::float8` })
      .from(workItems)
      .leftJoin(iteration, eq(iteration.id, workItems.iterationId))
      .where(
        and(
          eq(workItems.workspaceId, workspaceId),
          eq(workItems.iterationId, iterationId),
          inArray(workItems.type, [...LEAF_TYPES]),
          isNull(workItems.deletedAt),
          sql`${workItems.scheduleState} in (${acceptedScheduleStatesSql()})`,
          /**
           * SU-08 AC3 — the `[Unfinished]` placeholder never adds to Accepted Points.
           *
           * It is `accepted` with a real `accepted_date` (BR-09), so without this predicate it walks
           * straight into the sum and the source sprint appears to have delivered the points that
           * were carried forward. `split_id IS NOT NULL` means "this Story IS a Split placeholder"
           * (D6) and is an index-friendly predicate on `ix_wi_split_id` — which is why the marker is
           * a column here rather than a join to `story_splits`.
           *
           * The points are not hidden, only re-labelled: they surface as the `SPLIT OUT` marker
           * beside this series (8.2) and, in SU-09, as Velocity's own excluded segment.
           */
          isNull(workItems.splitId),
          // Cumulative BY DATE (IB-BR-02): an item accepted after this day's local boundary
          // does not count towards it, even though it is accepted right now.
          sql`${workItems.acceptedDate} is not null and ${workItems.acceptedDate} <= ${endOfDay}`,
          teamId === null ? undefined : sql`${itemTeam} = ${teamId}::uuid`,
        ),
      );

    return { remainingTodo: todo?.total ?? 0, acceptedPoints: accepted?.total ?? 0 };
  }

  async teamsInIterationScope(workspaceId: string, iterationId: string): Promise<string[]> {
    /**
     * The teams that actually have work in this iteration — tasks OR leaf items.
     *
     * Snapshotting every team in the project would write a row of zeros for teams that never
     * touched the iteration, and a zero is indistinguishable from a team that delivered nothing.
     * Same rule `teamsInvolved` applies to the release burnup.
     */
    const parent = alias(workItems, 'parent');
    const iteration = alias(iterations, 'scope_iteration');
    const taskTeams = await this.db
      .selectDistinct({
        teamId: sql<
          string | null
        >`coalesce(${tasks.teamId}, ${parent.teamId}, ${iteration.teamId})`,
      })
      .from(tasks)
      .innerJoin(parent, and(eq(parent.id, tasks.parentId), isNull(parent.deletedAt)))
      .leftJoin(
        iteration,
        sql`${iteration.id} = coalesce(${tasks.iterationId}, ${parent.iterationId})`,
      )
      .where(
        and(
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.deletedAt),
          sql`(${tasks.iterationId} = ${iterationId}::uuid or ${parent.iterationId} = ${iterationId}::uuid)`,
        ),
      );

    const itemTeams = await this.db
      .selectDistinct({
        teamId: sql<string | null>`coalesce(${workItems.teamId}, ${iteration.teamId})`,
      })
      .from(workItems)
      .leftJoin(iteration, eq(iteration.id, workItems.iterationId))
      .where(
        and(
          eq(workItems.workspaceId, workspaceId),
          eq(workItems.iterationId, iterationId),
          inArray(workItems.type, [...LEAF_TYPES]),
          isNull(workItems.deletedAt),
        ),
      );

    const ids = new Set<string>();
    for (const row of [...taskTeams, ...itemTeams]) {
      if (row.teamId !== null) ids.add(row.teamId);
    }
    return [...ids];
  }

  async upsertIterationSnapshot(row: IterationSnapshotWrite): Promise<void> {
    /**
     * Idempotent by (iteration, team, date): a retry, a second pod, or an extra tick rewrites the
     * same row rather than creating a duplicate (IB §4). Only TODAY's date is ever passed, so this
     * can never rewrite a closed day.
     *
     * Raw SQL, exactly like `upsertReleaseSnapshot` and for the same reason: the unique index is
     * on `(iteration_id, COALESCE(team_id, nil), snapshot_date)` — a nullable team needs the
     * COALESCE so one ON CONFLICT predicate serves the team rows AND the All Teams row — and
     * Drizzle's `onConflictDoUpdate` target accepts columns only, not an expression. Every value
     * is still a bind parameter.
     */
    await this.db.execute(sql`
      insert into "work"."iteration_daily_snapshots"
        (workspace_id, iteration_id, team_id, snapshot_date,
         remaining_todo, accepted_points, captured_at)
      values
        (${row.workspaceId}::uuid, ${row.iterationId}::uuid, ${row.teamId}::uuid,
         ${row.snapshotDate}::date, ${String(row.remainingTodo)}, ${String(row.acceptedPoints)}, now())
      on conflict (iteration_id, coalesce(team_id, ${NIL_UUID}::uuid), snapshot_date)
      do update set
        remaining_todo  = excluded.remaining_todo,
        accepted_points = excluded.accepted_points,
        captured_at     = now()
      -- Defence in depth: a finalized day stays put even if a caller passed a past date.
      where "work"."iteration_daily_snapshots".finalized = false
    `);
  }

  async upsertReleaseSnapshot(row: ReleaseSnapshotWrite): Promise<void> {
    // Raw SQL for this one write. The unique index is on
    // `(release_id, COALESCE(team_id, nil), snapshot_date)` — a nullable Team needs a COALESCE
    // so ON CONFLICT can match one predicate for both the Team rows and the All Teams row —
    // and Drizzle's `onConflictDoUpdate` target only accepts columns, not an expression.
    // Every value is still a bind parameter.
    await this.db.execute(sql`
      insert into "work"."release_daily_snapshots"
        (workspace_id, release_id, team_id, snapshot_date,
         accepted_points, accepted_count, planned_points, planned_count,
         preliminary_points, preliminary_count, captured_at)
      values
        (${row.workspaceId}::uuid, ${row.releaseId}::uuid, ${row.teamId}::uuid, ${row.snapshotDate}::date,
         ${row.acceptedPoints}, ${row.acceptedCount}, ${row.plannedPoints}, ${row.plannedCount},
         ${row.preliminaryPoints}, ${row.preliminaryCount}, now())
      on conflict (release_id, coalesce(team_id, ${NIL_UUID}::uuid), snapshot_date)
      do update set
        accepted_points    = excluded.accepted_points,
        accepted_count     = excluded.accepted_count,
        planned_points     = excluded.planned_points,
        planned_count      = excluded.planned_count,
        preliminary_points = excluded.preliminary_points,
        preliminary_count  = excluded.preliminary_count,
        captured_at        = now()
      -- Defence in depth: a finalized day stays put even if a caller passed a past date.
      where "work"."release_daily_snapshots".finalized = false
    `);
  }

  async finalizeSnapshotsBefore(workspaceId: string, localDate: string): Promise<void> {
    await Promise.all([
      this.db
        .update(iterationDailySnapshots)
        .set({ finalized: true })
        .where(
          and(
            eq(iterationDailySnapshots.workspaceId, workspaceId),
            sql`${iterationDailySnapshots.snapshotDate} < ${localDate}`,
            eq(iterationDailySnapshots.finalized, false),
          ),
        ),
      this.db
        .update(releaseDailySnapshots)
        .set({ finalized: true })
        .where(
          and(
            eq(releaseDailySnapshots.workspaceId, workspaceId),
            sql`${releaseDailySnapshots.snapshotDate} < ${localDate}`,
            eq(releaseDailySnapshots.finalized, false),
          ),
        ),
    ]);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/** The nil UUID the unique index COALESCEs a null team_id to (migration 0088). */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const ITERATION_COLUMNS = {
  id: iterations.id,
  projectId: iterations.projectId,
  teamId: iterations.teamId,
  timeboxGroupId: iterations.timeboxGroupId,
  name: iterations.name,
  startDate: iterations.startDate,
  endDate: iterations.endDate,
} as const;
