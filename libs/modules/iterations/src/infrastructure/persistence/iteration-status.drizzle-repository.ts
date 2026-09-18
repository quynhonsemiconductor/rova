import { Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { InjectDrizzle, buildPageResult, keysetCondition } from '@platform';
import type { DrizzleDB, CursorPayload, PagedResult } from '@platform';
import {
  workItems,
  tasks,
  milestones,
  milestoneArtifacts,
  portfolioItems,
} from '../../../../../../db/schema/work';
import { users } from '../../../../../../db/schema/identity';
import { acceptedScheduleStatesSql } from '../../../../../../db/schema/enums';
import { UNASSIGNED_FILTER } from '@modules/work-items';
import type {
  IterationStatusItem,
  IterationStatusFilters,
} from '../../domain/iteration-status.types';
import {
  IIterationStatusRepository,
  type RawIterationMetrics,
} from '../../domain/ports/iteration-status.repository';
import { scopeIsEmpty, type TeamReadScope } from '../../domain/team-read-scope';

/** What an out-of-scope caller measures: nothing. Never `undefined`, so the strip still renders. */
const NO_METRICS: RawIterationMetrics = {
  totalPlanEstimate: 0,
  acceptedPoints: 0,
  defectCount: 0,
  taskCount: 0,
  activeTaskCount: 0,
};

@Injectable()
export class IterationStatusDrizzleRepository implements IIterationStatusRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  /**
   * The team predicate for a WORK ROW: `team_id IN (…)`, with NO `OR IS NULL`.
   *
   * A story or defect carrying no team is the PROJECT BACKLOG, which the BA ruling of 2026-08-17
   * makes readable by a Workspace Admin or Project Admin only — so an absent team EXCLUDES the row
   * here. That is the exact opposite of `IterationDrizzleRepository.teamOrSharedTimebox`, where a
   * team-less ITERATION is a SHARED timebox and stays visible: the timebox says which window, the
   * work says whose it is. Keep the two straight — one admits NULL, one refuses it.
   *
   * It takes the COLUMN so one rule covers both places a work row's team is read: the row itself in
   * `listItems` / the points aggregate, and the aliased PARENT in the task aggregate.
   *
   * Returns `undefined` for an unrestricted caller so the condition list stays literally unchanged
   * (no predicate at all, not a tautology), and never emits `inArray(col, [])`: the empty scope is
   * short-circuited by the callers below, because `IN ()` is not portable as "match nothing".
   */
  private teamScope(scope: TeamReadScope, column: AnyPgColumn): SQL | undefined {
    if (scope.unrestricted) return undefined;
    return inArray(column, scope.teamIds);
  }

  async getMetrics(
    iterationId: string,
    workspaceId: string,
    scope: TeamReadScope,
  ): Promise<RawIterationMetrics> {
    // An editor with no active Team in this project has no delivery scope at all. Short-circuited
    // rather than filtered: `IN ()` is not portable, and flattening `[]` into "no filter" would fail
    // OPEN — the whole strip would report the project's numbers to a caller who may read no row.
    if (scopeIsEmpty(scope)) return NO_METRICS;
    // Single pass over the iteration's non-deleted items. story_points is a
    // nullable numeric (fractional points); sums coalesce to 0. "Accepted" is
    // the canonical ACCEPTED_SCHEDULE_STATES set (accepted OR release) — a story
    // stays accepted once it advances to the terminal 'release' state — so this
    // shares the exact same definition as every other roll-up (SRS §8).
    const rows = await this.db
      .select({
        totalPlanEstimate: sql<number>`coalesce(sum(${workItems.storyPoints}), 0)::numeric`,
        /**
         * SU-08 8.1 — the `[Unfinished]` Split placeholder is excluded from DELIVERED points.
         *
         * `split_id IS NULL` sits inside the `filter`, not in the WHERE clause, and that split is the
         * whole point: the placeholder is still one of the iteration's items, so it stays in
         * `totalPlanEstimate` and in the grid below — SRS §10.2's "it remains visible through the
         * compact Split/Carryover context". What it must not do is count as delivery, here or in
         * `measureIterationDay`'s snapshot sum, which is the other half of AC3.
         */
        acceptedPoints: sql<number>`coalesce(sum(${workItems.storyPoints}) filter (where ${workItems.scheduleState} in (${acceptedScheduleStatesSql()}) and ${workItems.splitId} is null), 0)::numeric`,
        defectCount: sql<number>`(count(*) filter (where ${workItems.type} = 'defect'))::int`,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.iterationId, iterationId),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
          this.teamScope(scope, workItems.teamId),
        ),
      );

    // Task metrics are STATE-based (SRS/BA 2026-07-20): the "active" count is
    // every child task NOT in the Completed task-state — the SAME definition the
    // Team Status screen uses — so the two screens always agree. A separate
    // aggregate over `tasks` joined to the iteration's items (a correlated
    // subquery cannot live beside the ungrouped work-item aggregate above).
    //
    // The team predicate goes on the PARENT, not on the task. `getScopedTaskHours` and Team Status
    // resolve a TASK's team as `coalesce(task, parent, iteration)` because there a task IS the row;
    // here it is not — every task rolls up into the parent story/defect shown in the grid below, and
    // the per-row `taskEstimate` / `toDo` / `taskTotal` subqueries in `listItems` sum ALL of a
    // visible row's children. Counting tasks by their own resolved team would therefore make this
    // strip disagree with the very rows it sits above (a task of another team under a visible story
    // would leave the count while staying inside that row's rollup), and would count tasks whose
    // parent is a Project Backlog item the caller may not open. So: a task is measured exactly when
    // its parent row is visible — same population, one predicate.
    const parent = alias(workItems, 'wi_task_parent');
    const [taskAgg] = await this.db
      .select({
        taskCount: sql<number>`count(*)::int`,
        activeTaskCount: sql<number>`(count(*) filter (where ${tasks.state} <> 'completed'))::int`,
      })
      .from(tasks)
      .innerJoin(parent, eq(parent.id, tasks.parentId))
      .where(
        and(
          eq(parent.iterationId, iterationId),
          eq(parent.workspaceId, workspaceId),
          isNull(parent.deletedAt),
          isNull(tasks.deletedAt),
          this.teamScope(scope, parent.teamId),
        ),
      );

    const r = rows[0];
    return {
      totalPlanEstimate: Number(r?.totalPlanEstimate ?? 0),
      acceptedPoints: Number(r?.acceptedPoints ?? 0),
      defectCount: Number(r?.defectCount ?? 0),
      taskCount: Number(taskAgg?.taskCount ?? 0),
      activeTaskCount: Number(taskAgg?.activeTaskCount ?? 0),
    };
  }

  async listItems(
    iterationId: string,
    workspaceId: string,
    filters: IterationStatusFilters,
    { limit, cursor }: { limit: number; cursor: CursorPayload | null },
    scope: TeamReadScope,
  ): Promise<PagedResult<IterationStatusItem>> {
    // No team, no rows — and no query. Same short-circuit as `getMetrics`, so the strip and the grid
    // cannot answer an out-of-scope caller differently.
    if (scopeIsEmpty(scope)) {
      return buildPageResult<IterationStatusItem>([], limit, (i) => [i.rank]);
    }

    // The list shows the backlog-shaped items (story/defect) assigned to the
    // iteration. Tasks roll up into their parent's Task Est / To Do columns.
    const conditions: SQL[] = [
      eq(workItems.iterationId, iterationId),
      eq(workItems.workspaceId, workspaceId),
      isNull(workItems.deletedAt),
      inArray(workItems.type, ['story', 'defect']),
    ];
    // The SAME predicate `getMetrics` applies, from the one helper: the strip is a metric over these
    // rows, and a metric over a wider population than the rows below it is the defect CLAUDE.md
    // records twice ("Eligibility must be counted in the SAME scope as the measurement").
    const team = this.teamScope(scope, workItems.teamId);
    if (team) conditions.push(team);

    // Task rollups via correlated subqueries over the dedicated `tasks` table.
    //
    // Declared BEFORE the filter block because the Manage Filters "Task Est" and
    // "To Do" predicates reuse the very same expressions in the WHERE clause —
    // one definition, so a filter can never test a different number than the
    // column displays (the property whose absence produced the zero-point
    // Velocity bars; see CLAUDE.md "Eligibility must be counted in the SAME
    // scope as the measurement").
    const taskEstimate = sql<string>`(
      select coalesce(sum(t.estimate_hours), 0)
      from ${tasks} t
      where t.parent_id = ${workItems.id}
        and t.deleted_at is null
    )`;
    const toDo = sql<string>`(
      select coalesce(sum(t.todo_hours), 0)
      from ${tasks} t
      where t.parent_id = ${workItems.id}
        and t.deleted_at is null
    )`;

    if (filters.type) conditions.push(eq(workItems.type, filters.type));
    if (filters.scheduleState) conditions.push(eq(workItems.scheduleState, filters.scheduleState));
    if (filters.isBlocked !== undefined)
      conditions.push(eq(workItems.isBlocked, filters.isBlocked));
    if (filters.assigneeId) {
      // `unassigned` is a sentinel, not a user id: SQL equality never matches
      // NULL, so an "Unassigned" option built as `assignee_id = 'unassigned'`
      // would return nothing. Same rule as the Backlog Owner filter.
      conditions.push(
        filters.assigneeId === UNASSIGNED_FILTER
          ? isNull(workItems.assigneeId)
          : eq(workItems.assigneeId, filters.assigneeId),
      );
    }
    if (filters.devOwnerId) {
      conditions.push(
        filters.devOwnerId === UNASSIGNED_FILTER
          ? isNull(workItems.devOwnerId)
          : eq(workItems.devOwnerId, filters.devOwnerId),
      );
    }
    if (filters.q) {
      const term = filters.q.trim();
      if (term) {
        conditions.push(
          or(ilike(workItems.itemKey, `%${term}%`), ilike(workItems.title, `%${term}%`))!,
        );
      }
    }
    // ── Manage Filters column predicates (P2-IS-FR-022/023/024) ───────────────
    // Whitelisted columns, bound parameters — never interpolated SQL.
    if (filters.itemKey?.trim()) {
      conditions.push(ilike(workItems.itemKey, `%${filters.itemKey.trim()}%`));
    }
    if (filters.title?.trim()) {
      conditions.push(ilike(workItems.title, `%${filters.title.trim()}%`));
    }
    if (filters.planEstimate !== undefined) {
      conditions.push(eq(workItems.storyPoints, filters.planEstimate));
    }
    if (filters.taskEstimate !== undefined) {
      conditions.push(sql`${taskEstimate} = ${filters.taskEstimate}::numeric`);
    }
    if (filters.toDo !== undefined) {
      conditions.push(sql`${toDo} = ${filters.toDo}::numeric`);
    }
    // Actual = roll-up of child task actual_hours (parity with To Do / Task Est,
    // which also sum from the child tasks). Actual is a manual per-task input.
    const actual = sql<string>`(
      select coalesce(sum(t.actual_hours), 0)
      from ${tasks} t
      where t.parent_id = ${workItems.id}
        and t.deleted_at is null
    )`;

    // State-based task rollup (SRS/BA 2026-07-20): Task % = done/total tasks,
    // where "done" is the Completed task-state — NOT derived from To Do hours —
    // so the Iteration Status "Tasks" column matches the Team Status screen.
    const taskTotal = sql<number>`(
      select count(*)::int
      from ${tasks} t
      where t.parent_id = ${workItems.id}
        and t.deleted_at is null
    )`;
    const taskDone = sql<number>`(
      select count(*)::int
      from ${tasks} t
      where t.parent_id = ${workItems.id}
        and t.deleted_at is null
        and t.state = 'completed'
    )`;

    // The Feature this row belongs to — Rally's "Feature" column.
    //
    // Read from work_items.feature_id → work.portfolio_items, which is where a
    // Feature actually lives (P5.1). This previously walked parent_id looking for a
    // work_items row of type 'feature': a Feature was a work item, found one or two
    // levels up (story→feature, defect→story→feature).
    //
    // That model is gone. In both Rally and the BA spec a Feature is a PORTFOLIO
    // ITEM, not a schedulable artifact — Rally keeps PortfolioItem and
    // HierarchicalRequirement as separate object families joined by a field, and only
    // the lowest portfolio level attaches to the story hierarchy. Keeping the old
    // walk would have meant two tables both minting `FE-` keys and both meaning
    // Feature, so `feature` has been removed from work_item_type.
    //
    // A defect no longer inherits its parent story's Feature implicitly: it carries
    // its own feature_id. Simpler, and it matches Rally, where the association is an
    // explicit field on each artifact rather than something inferred from ancestry.
    const featureItem = alias(portfolioItems, 'pi_feature');
    const featureId = featureItem.id;
    const featureKey = featureItem.itemKey;
    const featureTitle = featureItem.name;

    /**
     * OWNER AND DEV OWNER NAMES, joined here rather than resolved by the client.
     *
     * The grid used to hold ids only and look the name up in a PICKER feed, and both feeds narrow on
     * purpose: `GET /projects/:id/member-options` excludes Workspace Admins (AC-16 — they are not
     * assignable owners), and the workspace directory narrows a non-admin caller to the members and
     * leads of their own readable projects. A Workspace Admin holds no `project_members` row at all
     * (§2.1, migration 0118), so an item they own had no name source: the column read `No Entry` for an
     * Editor while the value sat in the database, and an absent name is indistinguishable from an unset
     * field. Reported 2026-08-22; reproduced with an Editor whose projects name no admin as lead.
     *
     * A name is a property of the ROW, not of what the reader may assign — which is why the four
     * modules that already do this (Portfolio, Releases, Milestones, Quality) all carry it. The picker
     * feeds keep narrowing; only naming moves.
     */
    const assigneeUser = alias(users, 'u_assignee');
    const devOwnerUser = alias(users, 'u_dev_owner');
    const assigneeName = sql<
      string | null
    >`coalesce(${assigneeUser.displayName}, ${assigneeUser.email})`;
    const devOwnerName = sql<
      string | null
    >`coalesce(${devOwnerUser.displayName}, ${devOwnerUser.email})`;

    // Child-defect rollup — Rally "Defects" (count) + "Defect Status" (open summary).
    const defectCount = sql<number>`(
      select count(*)::int from ${workItems} d
      where d.parent_id = ${workItems.id} and d.type = 'defect' and d.deleted_at is null
    )`;
    const openDefectCount = sql<number>`(
      select count(*)::int from ${workItems} d
      where d.parent_id = ${workItems.id} and d.type = 'defect' and d.deleted_at is null
        and d.schedule_state not in (${acceptedScheduleStatesSql()})
    )`;

    // Milestones directly assigned to the work item — Rally "Milestones" column.
    // Returns {id,name} objects so the grid can render names AND edit by id.
    const milestoneList = sql<Array<{ id: string; name: string }>>`coalesce((
      select json_agg(json_build_object('id', m.id, 'name', m.name) order by m.name)
      from ${milestoneArtifacts} ma
      join ${milestones} m on m.id = ma.milestone_id
      where ma.entity_type = 'work_item' and ma.entity_id = ${workItems.id}
    ), '[]'::json)`;

    // Keyset pagination on (rank, id) — the pair the ORDER BY below uses.
    //
    // `rank` is NOT unique here. It is a LexoRank assigned per SCOPE — the
    // top-level items of a project, or the children of one parent — so it is only
    // unique within a scope. This grid deliberately flattens that: an iteration
    // contains a story and its child defect side by side, and each was ranked
    // first in its own scope, so both legitimately hold the same value.
    //
    // Ordering by a non-unique column leaves tied rows in an order SQL does not
    // define, so Postgres returns whatever the scan yields — and an UPDATE that
    // relocates a tuple to a new page silently changes it. That is what made a
    // work item jump below its neighbour after nothing but a schedule-state edit.
    //
    // The previous predicate was also inverted: `rank < cursor` under ORDER BY
    // rank ASC walks backwards, so page 2 re-served rows from page 1.
    //
    // Both are fixed by using the same helper the backlog already uses
    // (work-item.drizzle-repository.ts), which compares (sort, id) as a pair.
    if (cursor) {
      conditions.push(keysetCondition(workItems.rank, workItems.id, cursor));
    }

    const rows = await this.db
      .select({
        id: workItems.id,
        itemKey: workItems.itemKey,
        type: workItems.type,
        title: workItems.title,
        scheduleState: workItems.scheduleState,
        iterationId: workItems.iterationId,
        teamId: workItems.teamId,
        isBlocked: workItems.isBlocked,
        blockedReason: workItems.blockedReason,
        planEstimate: sql<number | null>`${workItems.storyPoints}::float8`,
        assigneeId: workItems.assigneeId,
        assigneeName,
        devOwnerId: workItems.devOwnerId,
        devOwnerName,
        rank: workItems.rank,
        taskEstimate,
        toDo,
        actual,
        taskTotal,
        taskDone,
        featureId,
        featureKey,
        featureTitle,
        defectCount,
        openDefectCount,
        milestoneList,
      })
      .from(workItems)
      // Not archived: an archived Feature must stop labelling live work rather than
      // keep showing a key nobody can open.
      .leftJoin(
        featureItem,
        and(eq(featureItem.id, workItems.featureId), isNull(featureItem.archivedAt)),
      )
      // LEFT joins, and on the user table directly: an owner who has left the workspace or been
      // deactivated must still be NAMED (the row states who owns it, which is true regardless), the
      // same reason `member-options` returns inactive members.
      .leftJoin(assigneeUser, eq(assigneeUser.id, workItems.assigneeId))
      .leftJoin(devOwnerUser, eq(devOwnerUser.id, workItems.devOwnerId))
      .where(and(...conditions))
      // `id` is the tiebreaker that makes this total rather than partial. Without
      // it, rows sharing a rank come back in physical-tuple order, which changes
      // whenever one of them is updated.
      .orderBy(asc(workItems.rank), asc(workItems.id))
      .limit(limit + 1);

    const items: IterationStatusItem[] = rows.map((r) => ({
      id: r.id,
      itemKey: r.itemKey,
      type: r.type,
      title: r.title,
      scheduleState: r.scheduleState,
      iterationId: r.iterationId,
      teamId: r.teamId,
      isBlocked: r.isBlocked,
      blockedReason: r.blockedReason,
      planEstimate: r.planEstimate,
      taskEstimate: Number(r.taskEstimate ?? 0),
      toDo: Number(r.toDo ?? 0),
      actual: Number(r.actual ?? 0),
      taskTotal: Number(r.taskTotal ?? 0),
      taskDone: Number(r.taskDone ?? 0),
      assigneeId: r.assigneeId,
      assigneeName: r.assigneeName,
      devOwnerId: r.devOwnerId,
      devOwnerName: r.devOwnerName,
      rank: r.rank,
      featureId: r.featureId,
      featureKey: r.featureKey,
      featureTitle: r.featureTitle,
      defectCount: Number(r.defectCount ?? 0),
      openDefectCount: Number(r.openDefectCount ?? 0),
      milestones: r.milestoneList ?? [],
    }));

    return buildPageResult(items, limit, (i) => [i.rank]);
  }
}
