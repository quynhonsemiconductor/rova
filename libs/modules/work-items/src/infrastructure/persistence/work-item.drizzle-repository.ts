import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNull,
  notInArray,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { InjectDrizzle, buildPageResult, keysetCondition } from '@platform';
import type { DrizzleDB, DbExecutor, CursorPayload, PagedResult } from '@platform';
import {
  portfolioItems,
  workItems,
  workItemLabels,
  labels,
  iterations,
  releases,
  tasks,
  milestones,
  milestoneArtifacts,
  projects,
  workflowStatuses,
} from '../../../../../../db/schema/work';
import { users } from '../../../../../../db/schema/identity';
import type {
  DefectSeverity,
  DefectEnvironment,
  DefectRootCause,
  DefectResolution,
  DefectState,
  WorkItemScheduleState,
  TaskState,
} from '../../../../../../db/schema/enums';
import { acceptedScheduleStatesSql } from '../../../../../../db/schema/enums';
import type {
  WorkItem,
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItemFilters,
  WorkItemSortBy,
  TaskTotals,
  MyWorkItem,
  WorkspaceSummary,
  StoryOption,
} from '../../domain/work-item.types';
import { UNASSIGNED_FILTER, STORY_OPTIONS_LIMIT } from '../../domain/work-item.types';
import { teamRowFilter } from '../../domain/team-read-scope';
import type { TeamReadScope, ProjectTeamScope } from '../../domain/team-read-scope';
import { IWorkItemRepository, IterationScope } from '../../domain/ports/work-item.repository';
import type { SplitIterationCandidateRow } from '../../domain/ports/work-item.repository';

/**
 * Canonical projection of a work-item schedule_state (D1) onto the task_state
 * (D3) lifecycle used by the `tasks` table. Exhaustively keyed on the enum so a
 * future schedule-state addition/rename is a compile error (no silent fallback).
 * `idea`/`defined` → defined, `in_progress` → in_progress, and every completed
 * state (`completed`/`accepted`/`release`) → completed.
 */
const SCHEDULE_STATE_TO_TASK_STATE: Record<WorkItemScheduleState, TaskState> = {
  idea: 'defined',
  defined: 'defined',
  in_progress: 'in_progress',
  completed: 'completed',
  accepted: 'completed',
  release: 'completed',
};

/**
 * Single source of truth pairing each sortable backlog column with the cursor
 * value extracted from a row. Keeping the ORDER BY column and the keyset cursor
 * key defined together guarantees they can never drift apart — the bug that
 * previously left every non-rank sort paginating by rank. `planEstimate` maps to
 * the nullable `story_points`; {@link keysetCondition} handles its NULL ordering.
 */
/**
 * The owner-name join aliases, and the expression each renders — module-level, so the ORDER BY,
 * the keyset predicate and the SELECT cannot be built from different definitions of one name.
 *
 * `coalesce(display_name, email)` is what the grids display (a user may have no display name), so
 * it is also what a sort and its cursor must compare.
 */
const WI_ASSIGNEE_USER = alias(users, 'wi_assignee');
const WI_DEV_OWNER_USER = alias(users, 'wi_dev_owner');
const BACKLOG_OWNER_NAME = {
  assignee: sql<
    string | null
  >`coalesce(${WI_ASSIGNEE_USER.displayName}, ${WI_ASSIGNEE_USER.email})`,
  devOwner: sql<
    string | null
  >`coalesce(${WI_DEV_OWNER_USER.displayName}, ${WI_DEV_OWNER_USER.email})`,
};

/**
 * The sortable backlog columns, and the cursor key each produces.
 *
 * `column` is a stored column for most fields and a NAME EXPRESSION for the two owner fields — the
 * grid renders `coalesce(display_name, email)`, so ordering on `display_name` alone would place a
 * user with no display name by a value nobody can see. `keysetCondition` takes either.
 */
const BACKLOG_SORT_COLUMNS: Record<
  WorkItemSortBy,
  { column: AnyColumn | SQL; value: (w: WorkItem) => unknown }
> = {
  rank: { column: workItems.rank, value: (w) => w.rank },
  itemKey: { column: workItems.itemKey, value: (w) => w.itemKey },
  type: { column: workItems.type, value: (w) => w.type },
  title: { column: workItems.title, value: (w) => w.title },
  scheduleState: { column: workItems.scheduleState, value: (w) => w.scheduleState },
  priority: { column: workItems.priority, value: (w) => w.priority },
  planEstimate: { column: workItems.storyPoints, value: (w) => w.storyPoints },
  assignee: { column: BACKLOG_OWNER_NAME.assignee, value: (w) => w.assigneeName ?? null },
  devOwner: { column: BACKLOG_OWNER_NAME.devOwner, value: (w) => w.devOwnerName ?? null },
};

/**
 * A `work_items` row as a `WorkItem`.
 *
 * `WorkItem` is a UNION shape: the same interface describes a Story/Defect (from
 * `work_items`) and a Task (from `tasks`). Its hours fields belong to the TASK side —
 * migration 0074 dropped them from `work_items` because a Story's Estimate/To Do/Actual are
 * derived by summing its child tasks, which is how Iteration Status always read them.
 *
 * So a row from `work_items` reports null hours, and the task read paths keep selecting
 * `tasks.estimate_hours` and friends. Centralised here so the nine call sites cannot drift.
 */
function toWorkItem(row: typeof workItems.$inferSelect): WorkItem {
  return { ...row, estimateHours: null, todoHours: null, actualHours: null } as WorkItem;
}

@Injectable()
export class WorkItemDrizzleRepository implements IWorkItemRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async findById(id: string, workspaceId: string, executor?: DbExecutor): Promise<WorkItem | null> {
    const exec = executor ?? this.db;
    // Try work_items first, then fall back to tasks table (P3).
    const rows = await exec
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.id, id),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
        ),
      )
      .limit(1);
    if (rows.length > 0) return toWorkItem(rows[0]);

    const tRows = await exec
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
      .limit(1);
    if (tRows.length > 0) {
      return this.mapTaskRow(tRows[0]);
    }
    return null;
  }

  /**
   * Resolve a work item by its human item key within a project. Mirrors
   * {@link findById}'s work_items→tasks fallback so task detail pages (whose
   * rows live in `work.tasks` since the Phase 3 split) are reachable by key.
   */
  async findByKey(itemKey: string, workspaceId: string): Promise<WorkItem | null> {
    // Keys are workspace-unique (Rally FormattedID), so (itemKey, workspaceId)
    // resolves a single artifact — no projectId needed.
    const rows = await this.db
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.itemKey, itemKey),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
        ),
      )
      .limit(1);
    if (rows.length > 0) return toWorkItem(rows[0]);

    const tRows = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.itemKey, itemKey),
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.deletedAt),
        ),
      )
      .limit(1);
    return tRows.length > 0 ? this.mapTaskRow(tRows[0]) : null;
  }

  /** Project a `work.tasks` row onto the unified WorkItem shape. */
  private mapTaskRow(t: typeof tasks.$inferSelect): WorkItem {
    return {
      id: t.id,
      workspaceId: t.workspaceId,
      projectId: t.projectId,
      itemKey: t.itemKey,
      type: 'task',
      // A Task has no portfolio link of its own: its Work Product carries it.
      featureId: null,
      title: t.title,
      description: t.description,
      statusId: '',
      scheduleState:
        t.state === 'in_progress'
          ? 'in_progress'
          : t.state === 'completed'
            ? 'completed'
            : 'defined',
      // Tasks have a single state; Flow State mirrors it for shape compatibility.
      flowState:
        t.state === 'in_progress'
          ? 'in_progress'
          : t.state === 'completed'
            ? 'completed'
            : 'defined',
      priority: 'normal',
      assigneeId: t.assigneeId,
      reporterId: null,
      parentId: t.parentId,
      teamId: t.teamId,
      iterationId: t.iterationId,
      releaseId: null,
      storyPoints: null,
      estimateHours: t.estimateHours,
      todoHours: t.todoHours,
      actualHours: t.actualHours,
      acceptanceCriteria: null,
      notes: t.notes,
      releaseNotes: null,
      isBlocked: false,
      blockedReason: null,
      rank: t.rank,
      customFields: {},
      createdBy: t.createdBy,
      updatedBy: t.updatedBy,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      deletedAt: t.deletedAt,
      severity: null,
      foundInEnvironment: null,
      foundInReleaseId: null,
      rootCause: null,
      resolution: null,
      devOwnerId: null,
      defectState: null,
      fixedInBuild: null,
    };
  }

  async findByIds(ids: string[], workspaceId: string): Promise<WorkItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(workItems)
      .where(
        and(
          inArray(workItems.id, ids),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
        ),
      );
    // Fall back to the tasks table for any ids not in work_items (Phase 3 split),
    // mirroring findById — so task-neighbour lookups (e.g. rank reorder) resolve.
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      const tRows = await this.db
        .select()
        .from(tasks)
        .where(
          and(
            inArray(tasks.id, missing),
            eq(tasks.workspaceId, workspaceId),
            isNull(tasks.deletedAt),
          ),
        );
      return [...rows.map(toWorkItem), ...tRows.map((r) => this.mapTaskRow(r))];
    }
    return rows.map(toWorkItem);
  }

  async findIterationScope(
    iterationId: string,
    workspaceId: string,
  ): Promise<IterationScope | null> {
    const rows = await this.db
      .select({ projectId: iterations.projectId, teamId: iterations.teamId })
      .from(iterations)
      .where(and(eq(iterations.id, iterationId), eq(iterations.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Every Iteration in one project — Split's Target-Iteration candidate set.
   *
   * No state predicate here on purpose: the eligibility rule is one pure function
   * (`filterSplitTargets`), and narrowing in SQL as well would be a second copy of it that nothing
   * tests. `orderBy(asc(startDate), asc(id))` — the `id` terminator is what the query-ordering
   * ratchet requires, and it is what makes "earliest valid target" deterministic when two sprints
   * open on the same day.
   */
  async listProjectIterations(
    projectId: string,
    workspaceId: string,
  ): Promise<SplitIterationCandidateRow[]> {
    return this.db
      .select({
        id: iterations.id,
        name: iterations.name,
        iterationKey: iterations.iterationKey,
        state: iterations.state,
        startDate: iterations.startDate,
        endDate: iterations.endDate,
        projectId: iterations.projectId,
        teamId: iterations.teamId,
      })
      .from(iterations)
      .where(and(eq(iterations.projectId, projectId), eq(iterations.workspaceId, workspaceId)))
      .orderBy(asc(iterations.startDate), asc(iterations.id));
  }

  async findReleaseProject(releaseId: string, workspaceId: string): Promise<string | null> {
    const rows = await this.db
      .select({ projectId: releases.projectId })
      .from(releases)
      .where(and(eq(releases.id, releaseId), eq(releases.workspaceId, workspaceId)))
      .limit(1);
    return rows[0]?.projectId ?? null;
  }

  /** A release's display name — a NAME source, so it carries no `release:view` audience of its own. */
  async findReleaseName(releaseId: string, workspaceId: string): Promise<string | null> {
    const rows = await this.db
      .select({ name: releases.name })
      .from(releases)
      .where(and(eq(releases.id, releaseId), eq(releases.workspaceId, workspaceId)))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  /**
   * A portfolio item's type and archived state, for validating a Story's Feature link.
   *
   * Deliberately NOT the project: Rally lets a Story in a team project roll up to a Feature in a
   * portfolio project, and the portfolio rollup matches on `feature_id` alone. Requiring the same
   * project here would forbid links the rollup would happily count.
   */
  async findPortfolioItemLinkTarget(
    portfolioItemId: string,
    workspaceId: string,
  ): Promise<{ type: string; archived: boolean } | null> {
    const rows = await this.db
      .select({ type: portfolioItems.type, archivedAt: portfolioItems.archivedAt })
      .from(portfolioItems)
      .where(
        and(eq(portfolioItems.id, portfolioItemId), eq(portfolioItems.workspaceId, workspaceId)),
      )
      .limit(1);
    const row = rows[0];
    return row ? { type: row.type, archived: row.archivedAt !== null } : null;
  }

  async assignIteration(
    ids: string[],
    iterationId: string | null,
    workspaceId: string,
    updatedBy: string,
    executor?: DbExecutor,
  ): Promise<void> {
    if (ids.length === 0) return;
    const exec = executor ?? this.db;
    await exec
      .update(workItems)
      .set({ iterationId, updatedBy, updatedAt: new Date() })
      .where(
        and(
          inArray(workItems.id, ids),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
        ),
      );
  }

  async assignRelease(
    ids: string[],
    releaseId: string | null,
    workspaceId: string,
    updatedBy: string,
    executor?: DbExecutor,
  ): Promise<void> {
    if (ids.length === 0) return;
    const exec = executor ?? this.db;
    await exec
      .update(workItems)
      .set({ releaseId, updatedBy, updatedAt: new Date() })
      .where(
        and(
          inArray(workItems.id, ids),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
        ),
      );
  }

  /** Shared filter builder for list/backlog queries. */
  private buildFilters(
    projectId: string,
    workspaceId: string,
    filters: WorkItemFilters,
  ): ReturnType<typeof and>[] {
    const conditions = [
      eq(workItems.projectId, projectId),
      eq(workItems.workspaceId, workspaceId),
      isNull(workItems.deletedAt),
    ];

    if (filters.type) conditions.push(eq(workItems.type, filters.type));
    if (filters.statusId) conditions.push(eq(workItems.statusId, filters.statusId));
    if (filters.scheduleState) conditions.push(eq(workItems.scheduleState, filters.scheduleState));
    if (filters.priority) {
      // Priority is a Defect-only attribute (Stories/Tasks carry no priority), so
      // the Priority filter must never surface a Story even when one stores a legacy
      // literal value. Constrain to Defects (BL-002 / SoT priority contract).
      conditions.push(eq(workItems.priority, filters.priority));
      conditions.push(eq(workItems.type, 'defect'));
    }
    if (filters.assigneeId) {
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
    if (filters.teamId) {
      conditions.push(eq(workItems.teamId, filters.teamId));
    }
    // ── Manage Filters column predicates (P2-BL-FR-005/006) ──────────────────
    //
    // Whitelisted columns only — each value is a bound parameter, never
    // interpolated. `itemKey`/`title` are substring matches so the text inputs
    // behave like the Rally column filters they mirror; `planEstimate` is an
    // exact numeric match (the SRS calls Est a number input, not a range).
    //
    // These are ANDed with `q`, not folded into it: P2-BL-TS-015 makes quick
    // search independent of the Manage Filters set.
    if (filters.itemKey?.trim()) {
      conditions.push(ilike(workItems.itemKey, `%${filters.itemKey.trim()}%`));
    }
    if (filters.title?.trim()) {
      conditions.push(ilike(workItems.title, `%${filters.title.trim()}%`));
    }
    if (filters.planEstimate !== undefined) {
      conditions.push(eq(workItems.storyPoints, filters.planEstimate));
    }
    if (filters.iterationId) conditions.push(eq(workItems.iterationId, filters.iterationId));
    if (filters.releaseId) conditions.push(eq(workItems.releaseId, filters.releaseId));
    if (filters.parentId) conditions.push(eq(workItems.parentId, filters.parentId));
    if (filters.q) {
      const term = filters.q.trim();
      if (term) {
        // Use Postgres full-text search (GIN index on search_vector, migration 0012).
        // ILIKE with % wildcards on item_key for prefix/substring key lookups (e.g. "US", "DE", "US-1").
        // plainto_tsquery handles multi-word title searches.
        conditions.push(
          or(
            ilike(workItems.itemKey, `%${term}%`),
            ilike(workItems.title, `%${term}%`),
            sql`${workItems.searchVector} @@ plainto_tsquery('english', ${term})`,
          )!,
        );
      }
    }
    return conditions;
  }

  /**
   * The EDITOR Team boundary as a `work_items` predicate — `team_id IN (…)`, never `OR IS NULL`.
   *
   * Returns `null` for "this read has no rows at all", which the caller must answer by returning an
   * empty result WITHOUT querying: `inArray(col, [])` is not portable as "match nothing", and turning
   * an empty scope into no predicate is the `null`-versus-`[]` leak `listReadableProjectIds` documents.
   * `[]` means "no predicate needed" (an unrestricted caller).
   */
  private teamConditions(scope: TeamReadScope): SQL[] | null {
    const filter = teamRowFilter(scope);
    switch (filter.kind) {
      case 'all':
        return [];
      case 'none':
        return null;
      case 'in':
        return [inArray(workItems.teamId, filter.teamIds)];
    }
  }

  /** The same three-way decision over a task's RESOLVED team (`coalesce(task, parent, iteration)`). */
  private resolvedTeamConditions(scope: TeamReadScope, resolvedTeam: SQL): SQL[] | null {
    const filter = teamRowFilter(scope);
    switch (filter.kind) {
      case 'all':
        return [];
      case 'none':
        return null;
      case 'in':
        return [
          sql`${resolvedTeam} in (${sql.join(
            filter.teamIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        ];
    }
  }

  async listByProject(
    projectId: string,
    workspaceId: string,
    filters: WorkItemFilters,
    { limit, cursor }: { limit: number; cursor: CursorPayload | null },
    teamScope: TeamReadScope,
  ): Promise<PagedResult<WorkItem>> {
    const team = this.teamConditions(teamScope);
    // An Editor with no active Team in this project reads NOTHING — no query, no rows.
    if (team === null) return buildPageResult<WorkItem>([], limit, () => [], 'desc');
    const conditions = [...this.buildFilters(projectId, workspaceId, filters), ...team];
    if (cursor) {
      conditions.push(keysetCondition(workItems.createdAt, workItems.id, cursor));
    }

    const names = this.ownerNameJoins(workItems.assigneeId, workItems.devOwnerId);
    const rows = await this.db
      .select({ ...getTableColumns(workItems), ...names.columns })
      .from(workItems)
      .leftJoin(names.assigneeUser, eq(names.assigneeUser.id, workItems.assigneeId))
      .leftJoin(names.devOwnerUser, eq(names.devOwnerUser.id, workItems.devOwnerId))
      .where(and(...conditions))
      .orderBy(desc(workItems.createdAt), asc(workItems.id))
      .limit(limit + 1);

    // 'desc' is required, not cosmetic: keysetCondition reads cursor.d to pick gt
    // vs lt, and buildPageResult defaults it to 'asc'. Omitting it here would
    // page the wrong way against this DESC order.
    return buildPageResult(rows.map(toWorkItem), limit, (w) => [w.createdAt.toISOString()], 'desc');
  }

  async listBacklog(
    projectId: string,
    workspaceId: string,
    filters: WorkItemFilters,
    { limit, cursor }: { limit: number; cursor: CursorPayload | null },
    teamScope: TeamReadScope,
  ): Promise<PagedResult<WorkItem>> {
    const team = this.teamConditions(teamScope);
    // No Team in this project → no Backlog. `total` is 0 because that IS the count in scope, and the
    // direction only shapes a cursor, which an empty page does not have.
    if (team === null) return buildPageResult<WorkItem>([], limit, () => [], 'asc', 0);
    const conditions = [...this.buildFilters(projectId, workspaceId, filters), ...team];
    // Backlog shows only story + defect (tasks live under their parent item).
    conditions.push(inArray(workItems.type, ['story', 'defect']));

    /**
     * …and only UNSCHEDULED ones. This is the rule that defines the screen, and it was missing.
     *
     * `RECONCILED_SOURCE_OF_TRUTH.md:42`: "Plan > Backlog shows only Story/Defect items whose
     * Iteration is `Unscheduled`. Assigning a Story/Defect to an Iteration removes it from Backlog
     * and makes it visible in that Iteration's execution/status views; moving it back to
     * `Unscheduled` returns it to Backlog." Rally says the same: "Once the item is scheduled into a
     * release or iteration, it is removed from the Backlog page."
     *
     * ITERATION ONLY, deliberately — not release. Rally's sentence names both; the reconciled BA
     * layer names only the iteration, and it is the newer and more specific decision, so a Story
     * targeted at a Release but not yet pulled into a sprint stays in the Backlog. That is also the
     * behaviour the screen needs: a release is a months-long container, and hiding everything
     * assigned to one would empty the Backlog long before the work is planned.
     *
     * Because this is unconditional, the `iterationId` FILTER can no longer mean anything here — a
     * value would contradict it and the absence of one is now the only possible state. The filter
     * was removed from the Backlog toolbar for that reason; `buildFilters` still honours
     * `iterationId` for `listWorkItems`, which is a different, unrestricted list.
     */
    conditions.push(isNull(workItems.iterationId));

    // Keyset ("seek") pagination keyed on the ACTIVE sort column, with the row
    // id as a stable unique tie-breaker. This keeps paging correct for every
    // sort — non-unique columns (title/type/priority), the nullable
    // planEstimate, and the default rank — instead of always seeking by rank.
    const sort = BACKLOG_SORT_COLUMNS[filters.sortBy ?? 'rank'];
    const direction: 'asc' | 'desc' = filters.sortBy ? (filters.sortDirection ?? 'asc') : 'asc';
    const orderDir = direction === 'desc' ? desc : asc;

    // Total matching the filters (before the cursor/limit) so the backlog
    // footer can show an accurate count — SRS BL-FR-007 ("total đúng").
    const baseConditions = [...conditions];

    if (cursor) {
      conditions.push(keysetCondition(sort.column, workItems.id, cursor));
    }

    const backlogNames = this.ownerNameJoins(workItems.assigneeId, workItems.devOwnerId);
    const rows = await this.db
      .select({ ...getTableColumns(workItems), ...backlogNames.columns })
      .from(workItems)
      .leftJoin(backlogNames.assigneeUser, eq(backlogNames.assigneeUser.id, workItems.assigneeId))
      .leftJoin(backlogNames.devOwnerUser, eq(backlogNames.devOwnerUser.id, workItems.devOwnerId))
      .where(and(...conditions))
      .orderBy(orderDir(sort.column), asc(workItems.id))
      .limit(limit + 1);

    const [countRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(workItems)
      .where(and(...baseConditions));

    return buildPageResult(
      rows.map(toWorkItem),
      limit,
      (w) => [sort.value(w)],
      direction,
      Number(countRow?.total ?? 0),
    );
  }

  /**
   * The Story REFERENCE feed for one project — see the port's docblock for why it is not
   * `listBacklog`.
   *
   * The predicate set is exactly the write path's own eligibility rule (`createWorkItem` /
   * `updateWorkItem`): same project, `type = 'story'`, not soft-deleted. Nothing else. In
   * particular there is NO `iteration_id` predicate (that one belongs to the Backlog screen) and
   * no `schedule_state` predicate — a Defect is most often raised AGAINST accepted work, so
   * hiding accepted Stories would withhold the commonest parent while the API kept accepting it.
   *
   * Ordered by `item_key`, not rank: rank orders a planning grid, while a picker is scanned for a
   * known `US-<n>`. A total order also makes the `STORY_OPTIONS_LIMIT` cut deterministic.
   */
  async listStoryOptions(
    projectId: string,
    workspaceId: string,
    teamScope: TeamReadScope,
  ): Promise<StoryOption[]> {
    const team = this.teamConditions(teamScope);
    // An Editor with no active Team in this project reads no work rows at all, so the picker is
    // empty — the same short-circuit every other read takes, never `inArray(col, [])`.
    if (team === null) return [];
    return this.db
      .select({
        id: workItems.id,
        itemKey: workItems.itemKey,
        title: workItems.title,
        projectId: workItems.projectId,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.projectId, projectId),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
          eq(workItems.type, 'story'),
          ...team,
        ),
      )
      .orderBy(asc(workItems.itemKey), asc(workItems.id))
      .limit(STORY_OPTIONS_LIMIT);
  }

  /**
   * A Task's team, three tiers, most specific first — the rule `getScopedTaskHours` and Team Status
   * already share (`coalesce(task.team_id, parent.team_id, iteration.team_id)`).
   *
   * A Task's own `team_id` only DEFAULTS to its parent's (SRS P1-04) and is commonly unset on a Story
   * that carries one, so the task table alone cannot answer whose work this is. The parent and the
   * iteration are LEFT-joined: with an unrestricted caller no predicate is added, so the joins can
   * never change which rows come back.
   */
  /**
   * OWNER AND DEV OWNER NAMES for a grid row, joined here rather than resolved by the client.
   *
   * Every picker feed narrows on purpose — `GET /projects/:id/member-options` excludes Workspace
   * Admins (AC-16: not assignable owners) and the workspace directory narrows a non-admin caller to
   * the members and leads of their own readable projects. A Workspace Admin holds no
   * `project_members` row at all (§2.1, migration 0118), so a row they own had NO name source: the
   * column read `No Entry` while the id sat in the database, and an absent name is indistinguishable
   * from an unset field. Reported 2026-08-22 by an Editor; the same gap hits a Workspace Admin on any
   * surface that consults only the project feed.
   *
   * A name is a property of the ROW, not of whom the reader may assign — which is why Portfolio,
   * Releases, Milestones and Quality already carry theirs. The feeds keep narrowing; naming moves
   * here. LEFT joins on `users` directly, so a deactivated or departed owner is still NAMED: the row
   * states who owns it, which stays true.
   */
  private ownerNameJoins(assigneeCol: AnyPgColumn, devOwnerCol: AnyPgColumn) {
    return {
      assigneeUser: WI_ASSIGNEE_USER,
      devOwnerUser: WI_DEV_OWNER_USER,
      assigneeCol,
      devOwnerCol,
      columns: {
        assigneeName: BACKLOG_OWNER_NAME.assignee,
        devOwnerName: BACKLOG_OWNER_NAME.devOwner,
      },
    };
  }

  private taskTeamJoins() {
    const parent = alias(workItems, 'task_parent');
    const iteration = alias(iterations, 'task_iteration');
    return {
      parent,
      iteration,
      resolvedTeam: sql`coalesce(${tasks.teamId}, ${parent.teamId}, ${iteration.teamId})`,
    };
  }

  async listTasksByParent(
    parentId: string,
    workspaceId: string,
    teamScope: TeamReadScope,
  ): Promise<WorkItem[]> {
    const { parent, iteration, resolvedTeam } = this.taskTeamJoins();
    const team = this.resolvedTeamConditions(teamScope, resolvedTeam);
    if (team === null) return [];
    // A task's owner is named the same way a story's is: the Tasks tab reads only the project feed,
    // which excludes Workspace Admins, so a WA-owned task read `No Entry` for every role. Both
    // responsibilities are joined now — `work.tasks.dev_owner_id` exists as of migration 0127.
    const taskNames = this.ownerNameJoins(tasks.assigneeId, tasks.devOwnerId);
    const rows = await this.db
      .select({
        id: tasks.id,
        workspaceId: tasks.workspaceId,
        projectId: tasks.projectId,
        itemKey: tasks.itemKey,
        type: sql<string>`'task'`.as('type'),
        title: tasks.title,
        description: tasks.description,
        statusId: sql<string>`''`.as('status_id'),
        scheduleState: tasks.state,
        flowState: tasks.state,
        priority: sql<string>`'normal'`.as('priority'),
        assigneeId: tasks.assigneeId,
        ...taskNames.columns,
        reporterId: sql<string | null>`null`.as('reporter_id'),
        parentId: tasks.parentId,
        teamId: tasks.teamId,
        iterationId: tasks.iterationId,
        releaseId: sql<string | null>`null`.as('release_id'),
        storyPoints: sql<string | null>`null`.as('story_points'),
        estimateHours: tasks.estimateHours,
        todoHours: tasks.todoHours,
        actualHours: tasks.actualHours,
        acceptanceCriteria: sql<string | null>`null`.as('acceptance_criteria'),
        notes: tasks.notes,
        releaseNotes: sql<string | null>`null`.as('release_notes'),
        isBlocked: sql<boolean>`false`.as('is_blocked'),
        blockedReason: sql<string | null>`null`.as('blocked_reason'),
        rank: tasks.rank,
        customFields: sql<Record<string, unknown>>`'{}'`.as('custom_fields'),
        createdBy: tasks.createdBy,
        updatedBy: tasks.updatedBy,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        deletedAt: tasks.deletedAt,
        severity: sql<string | null>`null`.as('severity'),
        foundInEnvironment: sql<string | null>`null`.as('found_in_environment'),
        foundInReleaseId: sql<string | null>`null`.as('found_in_release_id'),
        rootCause: sql<string | null>`null`.as('root_cause'),
        resolution: sql<string | null>`null`.as('resolution'),
        devOwnerId: tasks.devOwnerId,
        defectState: sql<string | null>`null`.as('defect_state'),
        fixedInBuild: sql<string | null>`null`.as('fixed_in_build'),
      })
      .from(tasks)
      .leftJoin(parent, eq(parent.id, tasks.parentId))
      .leftJoin(iteration, eq(iteration.id, tasks.iterationId))
      .leftJoin(taskNames.assigneeUser, eq(taskNames.assigneeUser.id, tasks.assigneeId))
      .leftJoin(taskNames.devOwnerUser, eq(taskNames.devOwnerUser.id, tasks.devOwnerId))
      .where(
        and(
          eq(tasks.parentId, parentId),
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.deletedAt),
          ...team,
        ),
      )
      .orderBy(tasks.rank, tasks.createdAt, asc(tasks.id));
    // Already the union shape WITH real hours from `tasks` — not a `work_items` row, so it
    // must not go through `toWorkItem` (which nulls them).
    return rows as WorkItem[];
  }

  /**
   * Serialise rank assignment for one (project, parent) scope.
   *
   * `pg_advisory_xact_lock` is held until the surrounding transaction commits or
   * rolls back, so it cannot leak, and it is keyed on the scope rather than the
   * table — concurrent creates in different projects never contend. Callers MUST
   * take this before {@link findMaxRank} and pass the same `tx` to both, or the
   * read-modify-write is unprotected again.
   *
   * `hashtext` returns int4 and the two-argument lock form takes two, so the
   * scope maps onto the key directly. A hash collision only means two unrelated
   * scopes serialise against each other, which is harmless.
   */
  async lockRankScope(
    scope: { projectId: string; parentId?: string | null },
    executor: DbExecutor,
  ): Promise<void> {
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtext(${scope.projectId}), hashtext(${scope.parentId ?? 'root'}))`,
    );
  }

  async findMaxRank(
    scope: { projectId: string; parentId?: string | null },
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<string | null> {
    const exec = executor ?? this.db;
    // P3: When parentId is set, this is for a task — query the `tasks` table.
    if (scope.parentId) {
      const rows = await exec
        .select({ rank: tasks.rank })
        .from(tasks)
        .where(
          and(
            eq(tasks.parentId, scope.parentId),
            eq(tasks.workspaceId, workspaceId),
            isNull(tasks.deletedAt),
          ),
        )
        .orderBy(desc(tasks.rank), asc(tasks.id))
        .limit(1);
      return rows[0]?.rank ?? null;
    }

    const conditions = [eq(workItems.workspaceId, workspaceId), isNull(workItems.deletedAt)];
    conditions.push(eq(workItems.projectId, scope.projectId), isNull(workItems.parentId));
    const rows = await exec
      .select({ rank: workItems.rank })
      .from(workItems)
      .where(and(...conditions))
      .orderBy(desc(workItems.rank), asc(workItems.id))
      .limit(1);
    return rows[0]?.rank ?? null;
  }

  async taskStateCounts(
    parentId: string,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<{ total: number; defined: number; completed: number }> {
    const exec = executor ?? this.db;
    const rows = await exec
      .select({
        total: sql<number>`count(*)::int`,
        defined: sql<number>`count(*) filter (where state = 'defined')::int`,
        completed: sql<number>`count(*) filter (where state = 'completed')::int`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.parentId, parentId),
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.deletedAt),
        ),
      );
    const r = rows[0];
    if (!r) return { total: 0, defined: 0, completed: 0 };
    return {
      total: Number(r.total),
      defined: Number(r.defined),
      completed: Number(r.completed),
    };
  }

  async autoAcceptIterationIfComplete(
    iterationId: string,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<boolean> {
    const exec = executor ?? this.db;
    // Are all assigned Story/Defect items accepted, with at least one present?
    const rows = await exec
      .select({
        total: sql<number>`count(*)::int`,
        allAccepted: sql<boolean>`bool_and(${workItems.scheduleState} in (${acceptedScheduleStatesSql()}))`,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.iterationId, iterationId),
          eq(workItems.workspaceId, workspaceId),
          inArray(workItems.type, ['story', 'defect']),
          isNull(workItems.deletedAt),
        ),
      );
    const r = rows[0];
    if (!r || Number(r.total) === 0 || r.allAccepted !== true) return false;

    // Idempotent transition — a planning or committed iteration flips to
    // accepted (BR-IT-02: auto-accept when every assigned US/DE is accepted,
    // regardless of whether the iteration was manually committed first). An
    // already-accepted iteration is left untouched, so this never auto-reverses.
    const updated = await exec
      .update(iterations)
      .set({ state: 'accepted', completedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(iterations.id, iterationId),
          eq(iterations.workspaceId, workspaceId),
          inArray(iterations.state, ['planning', 'committed']),
        ),
      )
      .returning({ id: iterations.id });
    return updated.length > 0;
  }

  async getTaskTotals(
    parentId: string,
    workspaceId: string,
    teamScope: TeamReadScope,
  ): Promise<TaskTotals> {
    const EMPTY: TaskTotals = { taskCount: 0, estimateHours: 0, todoHours: 0, actualHours: 0 };
    const { parent, iteration, resolvedTeam } = this.taskTeamJoins();
    const team = this.resolvedTeamConditions(teamScope, resolvedTeam);
    // Zeros, in the SAME scope the grid above is drawn in — not the project-wide sum.
    if (team === null) return EMPTY;
    // P3: Query the dedicated `tasks` table.
    const rows = await this.db
      .select({
        taskCount: sql<number>`count(*)::int`,
        estimateHours: sql<string>`coalesce(sum(${tasks.estimateHours}), 0)`,
        todoHours: sql<string>`coalesce(sum(${tasks.todoHours}), 0)`,
        actualHours: sql<string>`coalesce(sum(${tasks.actualHours}), 0)`,
      })
      .from(tasks)
      .leftJoin(parent, eq(parent.id, tasks.parentId))
      .leftJoin(iteration, eq(iteration.id, tasks.iterationId))
      .where(
        and(
          eq(tasks.parentId, parentId),
          eq(tasks.workspaceId, workspaceId),
          isNull(tasks.deletedAt),
          ...team,
        ),
      );
    const r = rows[0];
    return {
      taskCount: Number(r?.taskCount ?? 0),
      estimateHours: Number(r?.estimateHours ?? 0),
      todoHours: Number(r?.todoHours ?? 0),
      actualHours: Number(r?.actualHours ?? 0),
    };
  }

  // ── Home dashboard aggregates ─────────────────────────────────────────────
  // Bounded / workspace-scoped queries that replace the old per-project fan-out.

  /**
   * The EDITOR Team boundary for a CROSS-project read, where the scope differs per project.
   *
   * One predicate: a row is admitted if its project is NOT one of the narrowed ones, or if it is and
   * the row carries one of that project's teams. A narrowed project with no teams contributes no term
   * at all, which is how "an Editor with no Team in that project sees none of its work" is expressed
   * without an `inArray(col, [])`. Returns `[]` when nothing is narrowed — never a predicate that
   * would silently exclude everything.
   */
  private crossProjectTeamConditions(
    projectColumn: AnyColumn,
    teamColumn: AnyColumn,
    teamScoped: ProjectTeamScope[],
  ): SQL[] {
    if (teamScoped.length === 0) return [];
    const narrowed = teamScoped.map((s) => s.projectId);
    const terms: SQL[] = [notInArray(projectColumn, narrowed)];
    for (const scope of teamScoped) {
      if (scope.teamIds.length === 0) continue;
      terms.push(and(eq(projectColumn, scope.projectId), inArray(teamColumn, scope.teamIds))!);
    }
    return [or(...terms)!];
  }

  /** Top-N work items assigned to the actor across the workspace, ordered by
   *  priority (urgent→none) then rank. One query, project key/name joined. */
  async listMyWork(
    workspaceId: string,
    userId: string,
    { limit }: { limit: number },
    readableProjectIds: string[] | null,
    teamScoped: ProjectTeamScope[],
  ): Promise<MyWorkItem[]> {
    // `null` = UNRESTRICTED; an array restricts, and the EMPTY one short-circuits because
    // `inArray(col, [])` is not portable as "match nothing". See the port for why this widget needs
    // the scope at all: "assigned to me" says whose the item is, not which project it may be read in.
    if (readableProjectIds !== null && readableProjectIds.length === 0) return [];
    const rows = await this.db
      .select({
        id: workItems.id,
        itemKey: workItems.itemKey,
        type: workItems.type,
        title: workItems.title,
        scheduleState: workItems.scheduleState,
        priority: workItems.priority,
        projectId: workItems.projectId,
        projectKey: projects.key,
        projectName: projects.name,
      })
      .from(workItems)
      .innerJoin(projects, eq(projects.id, workItems.projectId))
      .where(
        and(
          eq(workItems.workspaceId, workspaceId),
          eq(workItems.assigneeId, userId),
          isNull(workItems.deletedAt),
          ...(readableProjectIds === null
            ? []
            : [inArray(workItems.projectId, readableProjectIds)]),
          // An item assigned to an Editor is still another Team's item, or the Project Backlog's, and
          // Home is a "results" surface under §6 exactly like a list.
          ...this.crossProjectTeamConditions(workItems.projectId, workItems.teamId, teamScoped),
        ),
      )
      .orderBy(
        desc(
          sql`case ${workItems.priority} when 'urgent' then 4 when 'high' then 3 when 'normal' then 2 when 'low' then 1 else 0 end`,
        ),
        asc(workItems.rank),
        asc(workItems.id),
      )
      .limit(limit);
    return rows;
  }

  /**
   * Exact counts for the Home summary strip, over the projects the caller may READ. "Open" = the work
   * item's workflow-status category is not `done`.
   *
   * All three queries take the same scope, and they have to: the strip is one row of tiles about one
   * population, so scoping the work-item counts while leaving `activeProjects` or `activeSprints`
   * workspace-wide would put a project count next to item counts drawn from a different set — the
   * mismatch CLAUDE.md records for Velocity's zero-point bars ("eligibility must be counted in the
   * SAME scope as the measurement").
   *
   * An EMPTY scope returns zeros, and zero is a MEASUREMENT here, not an absence: the reader has no
   * readable project, so nothing is genuinely in scope. The SPA renders `--` only for a value it never
   * received (`EMPTY_VALUE`), which keeps the two distinguishable on screen.
   *
   * THE TEAM SCOPE NARROWS THE WORK-ITEM TILES ONLY, AND THAT IS DELIBERATE.
   * `openWorkItems`, `blockedItems`, `openDefects` and `assignedToMe` count WORK, which the BA ruling
   * of 2026-08-17 scopes by Team. `activeProjects` and `activeSprints` count CONTAINERS, and neither is
   * a work item: an Editor holds `project:view` on a project whose work they may only partly see, and
   * an iteration's `team_id` is optional and unset on the large majority of rows (195 of 206 locally),
   * so `iterations.team_id = ANY(…)` would drop exactly the SHARED sprints an Editor works inside —
   * the `teamOrSharedTimebox` mistake the reporting module already made and fixed. Narrowing these two
   * honestly needs the same two-tier rule over the work in them, which is a reporting-side change, not
   * a predicate on this table.
   */
  async getWorkspaceSummary(
    workspaceId: string,
    userId: string,
    readableProjectIds: string[] | null,
    teamScoped: ProjectTeamScope[],
  ): Promise<WorkspaceSummary> {
    const EMPTY: WorkspaceSummary = {
      activeProjects: 0,
      activeSprints: 0,
      openWorkItems: 0,
      blockedItems: 0,
      openDefects: 0,
      assignedToMe: 0,
    };
    // `inArray(col, [])` is not portable as "match nothing", so the empty scope short-circuits.
    if (readableProjectIds !== null && readableProjectIds.length === 0) return EMPTY;
    const inScope = (column: AnyColumn) =>
      readableProjectIds === null ? [] : [inArray(column, readableProjectIds)];

    const [projRow] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(projects)
      .where(
        and(
          eq(projects.workspaceId, workspaceId),
          eq(projects.status, 'active'),
          isNull(projects.deletedAt),
          ...inScope(projects.id),
        ),
      );
    const [iterRow] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(iterations)
      .where(
        and(
          eq(iterations.workspaceId, workspaceId),
          eq(iterations.state, 'committed'),
          ...inScope(iterations.projectId),
        ),
      );
    const [wiRow] = await this.db
      .select({
        open: sql<number>`sum(case when ${workflowStatuses.category} <> 'done' then 1 else 0 end)::int`,
        blocked: sql<number>`sum(case when ${workItems.isBlocked} and ${workflowStatuses.category} <> 'done' then 1 else 0 end)::int`,
        defects: sql<number>`sum(case when ${workItems.type} = 'defect' and ${workflowStatuses.category} <> 'done' then 1 else 0 end)::int`,
        mine: sql<number>`sum(case when ${workItems.assigneeId} = ${userId} and ${workflowStatuses.category} <> 'done' then 1 else 0 end)::int`,
      })
      .from(workItems)
      .innerJoin(workflowStatuses, eq(workflowStatuses.id, workItems.statusId))
      .where(
        and(
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
          ...inScope(workItems.projectId),
          ...this.crossProjectTeamConditions(workItems.projectId, workItems.teamId, teamScoped),
        ),
      );
    return {
      activeProjects: projRow?.c ?? 0,
      activeSprints: iterRow?.c ?? 0,
      openWorkItems: wiRow?.open ?? 0,
      blockedItems: wiRow?.blocked ?? 0,
      openDefects: wiRow?.defects ?? 0,
      assignedToMe: wiRow?.mine ?? 0,
    };
  }

  async create(input: CreateWorkItemInput, executor?: DbExecutor): Promise<WorkItem> {
    const exec = executor ?? this.db;

    // P3: Route task-type items to the dedicated `tasks` table.
    if (input.type === 'task') {
      const rows = await exec
        .insert(tasks)
        .values({
          id: input.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          parentId: input.parentId!,
          itemKey: input.itemKey,
          title: input.title,
          description: input.description,
          state: SCHEDULE_STATE_TO_TASK_STATE[input.scheduleState ?? 'defined'],
          assigneeId: input.assigneeId,
          // Its own column since migration 0127. Offered at birth like `assigneeId`, and never copied
          // from it — the BA forbids reusing `assignee_id` for this responsibility.
          devOwnerId: input.devOwnerId,
          teamId: input.teamId,
          iterationId: input.iterationId,
          estimateHours: input.estimateHours,
          todoHours: input.todoHours,
          actualHours: input.actualHours,
          rank: input.rank,
          createdBy: input.createdBy,
        })
        .returning();
      const t = rows[0];
      // Return a WorkItem-shaped object for service compatibility.
      return {
        id: t.id,
        workspaceId: t.workspaceId,
        projectId: t.projectId,
        itemKey: t.itemKey,
        type: 'task',
        // A Task has no portfolio link of its own: its Work Product carries it.
        featureId: null,
        title: t.title,
        description: t.description,
        statusId: '',
        scheduleState:
          t.state === 'in_progress'
            ? 'in_progress'
            : t.state === 'completed'
              ? 'completed'
              : 'defined',
        // Tasks have a single state; Flow State mirrors it for shape compatibility.
        flowState:
          t.state === 'in_progress'
            ? 'in_progress'
            : t.state === 'completed'
              ? 'completed'
              : 'defined',
        priority: 'normal',
        assigneeId: t.assigneeId,
        // Echoed back, or the create response reports `null` for a value it just wrote — the shape
        // this method returns is what the client renders immediately after the POST.
        devOwnerId: t.devOwnerId,
        reporterId: null,
        parentId: t.parentId,
        teamId: t.teamId,
        iterationId: t.iterationId,
        releaseId: null,
        storyPoints: null,
        estimateHours: t.estimateHours,
        todoHours: t.todoHours,
        actualHours: t.actualHours,
        acceptanceCriteria: null,
        notes: t.notes,
        releaseNotes: null,
        isBlocked: false,
        blockedReason: null,
        rank: t.rank,
        customFields: {},
        createdBy: t.createdBy,
        updatedBy: t.updatedBy,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        deletedAt: t.deletedAt,
        severity: null,
        foundInEnvironment: null,
        foundInReleaseId: null,
        rootCause: null,
        resolution: null,
        defectState: null,
        fixedInBuild: null,
      };
    }

    const rows = await exec
      .insert(workItems)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        itemKey: input.itemKey,
        type: input.type,
        title: input.title,
        description: input.description,
        statusId: input.statusId,
        scheduleState: input.scheduleState ?? 'defined',
        // BR-WI-01 — Flow State mirrors Schedule State on create.
        flowState: input.flowState ?? input.scheduleState ?? 'defined',
        priority: input.priority,
        assigneeId: input.assigneeId,
        reporterId: input.reporterId,
        parentId: input.parentId,
        teamId: input.teamId,
        iterationId: input.iterationId,
        releaseId: input.releaseId,
        storyPoints: input.storyPoints,
        // No hours: dropped from `work_items` by migration 0074. A Story/Defect derives them
        // from its child tasks, and a Task's own values are written to `tasks` by the task
        // branch of `update()` / `createTask`.
        acceptanceCriteria: input.acceptanceCriteria,
        notes: input.notes,
        releaseNotes: input.releaseNotes,
        rank: input.rank,
        createdBy: input.createdBy,
        // P3.4 — Defect-specific fields
        severity: input.severity as DefectSeverity | null,
        foundInEnvironment: input.foundInEnvironment as DefectEnvironment | null,
        foundInReleaseId: input.foundInReleaseId,
        rootCause: input.rootCause as DefectRootCause | null,
        resolution: input.resolution as DefectResolution | null,
        devOwnerId: input.devOwnerId,
        defectState: input.defectState as DefectState | null,
        fixedInBuild: input.fixedInBuild,
      })
      .returning();
    return toWorkItem(rows[0]);
  }

  async update(
    id: string,
    input: UpdateWorkItemInput,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<WorkItem> {
    const exec = executor ?? this.db;

    // P3: If this is a task (exists in tasks table), update there instead.
    const taskCheck = await exec
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId), isNull(tasks.deletedAt)))
      .limit(1);

    if (taskCheck.length > 0) {
      const setFields: Record<string, unknown> = { updatedAt: new Date() };
      if (input.title !== undefined) setFields.title = input.title;
      if (input.description !== undefined) setFields.description = input.description;
      // Writable since migration 0096 gave `work.tasks` the column. Omitting it was what made a
      // Task's Notes a write-only field: the PATCH returned 200, the diff logged a Notes change,
      // and the text was gone on the next read.
      if (input.notes !== undefined) setFields.notes = input.notes;
      // TASK-FR-012: Work Product (parent) reassignment. tasks.parent_id is NOT
      // NULL, so only a concrete new parent is written; the service rejects null.
      if (input.parentId !== undefined && input.parentId !== null)
        setFields.parentId = input.parentId;
      // BR-WI-01 mirror: a task's single state is driven by whichever of
      // scheduleState / flowState the caller sent (they always agree).
      const taskMirroredState = input.scheduleState ?? input.flowState;
      if (taskMirroredState !== undefined)
        setFields.state = SCHEDULE_STATE_TO_TASK_STATE[taskMirroredState];
      if (input.assigneeId !== undefined) setFields.assigneeId = input.assigneeId;
      // Its own column since migration 0127; it used to have nowhere to go, so a Dev Owner set on a
      // task was accepted by the API and silently dropped.
      if (input.devOwnerId !== undefined) setFields.devOwnerId = input.devOwnerId;
      if (input.teamId !== undefined) setFields.teamId = input.teamId;
      if (input.iterationId !== undefined) setFields.iterationId = input.iterationId;
      if (input.estimateHours !== undefined) setFields.estimateHours = input.estimateHours;
      if (input.todoHours !== undefined) setFields.todoHours = input.todoHours;
      if (input.actualHours !== undefined) setFields.actualHours = input.actualHours;
      if (input.rank !== undefined) setFields.rank = input.rank;
      if (input.updatedBy !== undefined) setFields.updatedBy = input.updatedBy;

      await exec
        .update(tasks)
        .set(setFields)
        .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)));

      // Re-fetch and return as WorkItem (use exec/tx for transaction consistency)
      return (await this.findById(id, workspaceId, exec))!;
    }

    // BR-WI-01 mirror: any change to either Schedule or Flow State writes BOTH
    // columns, so they can never drift. The service rejects a conflicting pair.
    const mirroredState = input.scheduleState ?? input.flowState;
    const rows = await exec
      .update(workItems)
      .set({
        ...(input.title !== undefined && { title: input.title }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.statusId !== undefined && { statusId: input.statusId }),
        ...(mirroredState !== undefined && {
          scheduleState: mirroredState,
          flowState: mirroredState,
        }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
        ...(input.reporterId !== undefined && { reporterId: input.reporterId }),
        ...(input.parentId !== undefined && { parentId: input.parentId }),
        ...(input.teamId !== undefined && { teamId: input.teamId }),
        ...(input.iterationId !== undefined && { iterationId: input.iterationId }),
        ...(input.releaseId !== undefined && { releaseId: input.releaseId }),
        ...(input.storyPoints !== undefined && { storyPoints: input.storyPoints }),
        // Hours are NOT settable on a Story/Defect: migration 0074 dropped the columns, so
        // spreading them here would emit `set estimate_hours = …` against a column that no
        // longer exists. `tsc` does not catch that — Drizzle's `.set()` accepts the wider
        // object — so it would have failed only at runtime. The TASK branch above still
        // writes them to `tasks`, which is where a task's own hours live.
        ...(input.acceptanceCriteria !== undefined && {
          acceptanceCriteria: input.acceptanceCriteria,
        }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.releaseNotes !== undefined && { releaseNotes: input.releaseNotes }),
        ...(input.isBlocked !== undefined && { isBlocked: input.isBlocked }),
        ...(input.blockedReason !== undefined && { blockedReason: input.blockedReason }),
        // `undefined` leaves the link alone; `null` unlinks the Story from its Feature.
        ...(input.featureId !== undefined && { featureId: input.featureId }),
        ...(input.rank !== undefined && { rank: input.rank }),
        ...(input.customFields !== undefined && { customFields: input.customFields }),
        ...(input.updatedBy !== undefined && { updatedBy: input.updatedBy }),
        // P3.4 — Defect-specific fields
        ...(input.severity !== undefined && { severity: input.severity as DefectSeverity | null }),
        ...(input.foundInEnvironment !== undefined && {
          foundInEnvironment: input.foundInEnvironment as DefectEnvironment | null,
        }),
        ...(input.foundInReleaseId !== undefined && { foundInReleaseId: input.foundInReleaseId }),
        ...(input.rootCause !== undefined && {
          rootCause: input.rootCause as DefectRootCause | null,
        }),
        ...(input.resolution !== undefined && {
          resolution: input.resolution as DefectResolution | null,
        }),
        ...(input.devOwnerId !== undefined && { devOwnerId: input.devOwnerId }),
        ...(input.defectState !== undefined && {
          defectState: input.defectState as DefectState | null,
        }),
        ...(input.fixedInBuild !== undefined && { fixedInBuild: input.fixedInBuild }),
        updatedAt: new Date(),
      })
      .where(and(eq(workItems.id, id), eq(workItems.workspaceId, workspaceId)))
      .returning();
    return toWorkItem(rows[0]);
  }

  async softDelete(id: string, workspaceId: string, executor?: DbExecutor): Promise<void> {
    const exec = executor ?? this.db;
    // P3: Check tasks table first
    const taskCheck = await exec
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
      .limit(1);
    if (taskCheck.length > 0) {
      await exec
        .update(tasks)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)));
      return;
    }
    await exec
      .update(workItems)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(workItems.id, id), eq(workItems.workspaceId, workspaceId)));
  }

  async reorderItems(
    items: Array<{ id: string; rank: string }>,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<void> {
    if (items.length === 0) return;
    const exec = executor ?? this.db;
    // Single transaction — caller (service) wraps this in uow.run() for
    // atomicity + RLS activation. The workspace_id guard here is belt-and-
    // suspenders: even if called outside UoW it cannot write across workspaces.
    await Promise.all(
      items.map(({ id, rank }) =>
        exec
          .update(workItems)
          .set({ rank, updatedAt: new Date() })
          .where(and(eq(workItems.id, id), eq(workItems.workspaceId, workspaceId))),
      ),
    );
  }

  async addLabel(workItemId: string, labelId: string, _workspaceId: string): Promise<void> {
    await this.db.insert(workItemLabels).values({ workItemId, labelId }).onConflictDoNothing();
  }

  async removeLabel(workItemId: string, labelId: string, _workspaceId: string): Promise<void> {
    await this.db
      .delete(workItemLabels)
      .where(and(eq(workItemLabels.workItemId, workItemId), eq(workItemLabels.labelId, labelId)));
  }

  async listLabels(
    workItemId: string,
  ): Promise<Array<{ id: string; name: string; color: string }>> {
    const rows = await this.db
      .select({ id: labels.id, name: labels.name, color: labels.color })
      .from(workItemLabels)
      .innerJoin(labels, eq(workItemLabels.labelId, labels.id))
      .where(eq(workItemLabels.workItemId, workItemId))
      .orderBy(labels.name, asc(labels.id));
    return rows;
  }

  async listMilestones(workItemId: string): Promise<Array<{ id: string; name: string }>> {
    const rows = await this.db
      .select({ id: milestones.id, name: milestones.name })
      .from(milestoneArtifacts)
      .innerJoin(milestones, eq(milestoneArtifacts.milestoneId, milestones.id))
      .where(
        and(
          eq(milestoneArtifacts.entityType, 'work_item'),
          eq(milestoneArtifacts.entityId, workItemId),
        ),
      )
      .orderBy(milestones.name, asc(milestones.id));
    return rows;
  }

  async setMilestones(workItemId: string, milestoneIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      // Both columns, always: since 0084 an id alone no longer identifies a subject, and a
      // delete that omitted `entity_type` would clear a portfolio item's assignments too if
      // the two id spaces ever collided.
      await tx
        .delete(milestoneArtifacts)
        .where(
          and(
            eq(milestoneArtifacts.entityType, 'work_item'),
            eq(milestoneArtifacts.entityId, workItemId),
          ),
        );
      if (milestoneIds.length > 0) {
        await tx.insert(milestoneArtifacts).values(
          milestoneIds.map((milestoneId) => ({
            milestoneId,
            entityType: 'work_item' as const,
            entityId: workItemId,
          })),
        );
      }
    });
  }
}
