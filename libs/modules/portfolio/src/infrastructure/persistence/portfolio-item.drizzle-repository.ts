import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { InjectDrizzle, buildPageResult, keysetCondition } from '@platform';
import type { DrizzleDB, CursorPayload, DbExecutor, PagedResult } from '@platform';
import {
  portfolioItems,
  workItems,
  releases,
  teams,
  projects,
  milestones,
  milestoneArtifacts,
  iterations,
} from '../../../../../../db/schema/work';
import { users } from '../../../../../../db/schema/identity';
import {
  acceptedScheduleStatesSql,
  completedScheduleStatesSql,
} from '../../../../../../db/schema/enums';
import type {
  CreatePortfolioItemInput,
  PortfolioFeatureOption,
  PortfolioItem,
  PortfolioItemView,
  PortfolioListFilter,
  PortfolioRankScope,
  PortfolioRollupRow,
  UpdatePortfolioItemInput,
} from '../../domain/portfolio-item.types';
import type {
  IPortfolioItemRepository,
  PortfolioChildItem,
} from '../../domain/ports/portfolio-item.repository';

@Injectable()
export class PortfolioItemDrizzleRepository implements IPortfolioItemRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  /**
   * Child rollups for a set of portfolio items, as correlated subqueries.
   *
   * ONE query for the whole page. A 50-row list showing four progress indicators each
   * would otherwise be 200 round trips; the aggregate has to travel with the row.
   *
   * An EPIC aggregates through its child Features — a story is never linked to an Epic
   * directly (only the lowest portfolio level attaches to the story hierarchy, in both
   * Rally and the BA spec), so the subquery matches any work item whose feature_id is
   * one of this Epic's active Features.
   *
   * TWO "done" definitions, and both are used here on purpose:
   *   accepted*  → ACCEPTED_SCHEDULE_STATES  (accepted, release)   — Percent Done
   *   completed* → COMPLETED_SCHEDULE_STATES (completed, accepted, release) — capacity
   * `db/schema/enums.ts` documents this as the D1 distinction. Collapsing them would
   * silently change both numbers.
   */
  private rollupSubqueries() {
    // Matches the linked leaf items for either type in one predicate, so Feature and
    // Epic rows can share a single select list.
    const linked = sql`(
      ${workItems.featureId} = ${portfolioItems.id}
      or ${workItems.featureId} in (
        select c.id from ${portfolioItems} c
        where c.parent_id = ${portfolioItems.id} and c.archived_at is null
      )
    )`;

    const scoped = (metric: SQL) => sql<number>`(
      select coalesce(${metric}, 0)
      from ${workItems}
      where ${linked} and ${workItems.deletedAt} is null
    )`;

    return {
      rollupPoints: scoped(sql`sum(${workItems.storyPoints})`),
      rollupCount: scoped(sql`count(*)`),
      acceptedPoints: scoped(
        sql`sum(${workItems.storyPoints}) filter (where ${workItems.scheduleState} in (${acceptedScheduleStatesSql()}))`,
      ),
      acceptedCount: scoped(
        sql`count(*) filter (where ${workItems.scheduleState} in (${acceptedScheduleStatesSql()}))`,
      ),
      completedPoints: scoped(
        sql`sum(${workItems.storyPoints}) filter (where ${workItems.scheduleState} in (${completedScheduleStatesSql()}))`,
      ),
      completedCount: scoped(
        sql`count(*) filter (where ${workItems.scheduleState} in (${completedScheduleStatesSql()}))`,
      ),
    };
  }

  /**
   * The accepted-children rollup SPLIT BY child type, for the detail page's
   * "Total Accepted Children" panel.
   *
   * A separate query rather than eight more columns on `rollupSubqueries()`. Those are
   * correlated scalar subqueries evaluated per returned row, and the grid returns up to 200
   * — the panel exists only on the detail page, so the list path must not pay for it. This
   * is ONE grouped pass over the same linked-leaf predicate.
   *
   * The predicate is deliberately identical to `rollupSubqueries()`, including how an Epic
   * reaches through its child Features to the leaf Stories and Defects. That is what makes
   * the panel's total agree with Percent Done on the same page; a second definition of
   * "this item's children" would put two different numbers next to each other.
   */
  async childRollupByType(
    id: string,
    workspaceId: string,
  ): Promise<
    {
      type: 'story' | 'defect';
      points: number;
      count: number;
      acceptedPoints: number;
      acceptedCount: number;
    }[]
  > {
    const rows = await this.db
      .select({
        type: workItems.type,
        points: sql<number>`coalesce(sum(${workItems.storyPoints}), 0)`,
        count: sql<number>`count(*)`,
        acceptedPoints: sql<number>`coalesce(sum(${workItems.storyPoints}) filter (where ${workItems.scheduleState} in (${acceptedScheduleStatesSql()})), 0)`,
        acceptedCount: sql<number>`count(*) filter (where ${workItems.scheduleState} in (${acceptedScheduleStatesSql()}))`,
      })
      .from(workItems)
      .where(
        and(
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
          or(
            eq(workItems.featureId, id),
            sql`${workItems.featureId} in (
              select c.id from ${portfolioItems} c
              where c.parent_id = ${id} and c.archived_at is null
            )`,
          ),
        ),
      )
      // No ORDER BY: the caller indexes these by `type` into a fixed
      // ['story', 'defect'] sequence, so row order here carries no meaning. Sorting by the
      // grouping key would also read as a partial ordering to the query-ordering ratchet,
      // which is right to be suspicious — a bare `ORDER BY type` on a NON-grouped query
      // would be exactly the unstable-pagination bug it exists to catch.
      .groupBy(workItems.type);

    return rows
      .filter((r): r is typeof r & { type: 'story' | 'defect' } => r.type !== 'task')
      .map((r) => ({
        type: r.type,
        points: Number(r.points ?? 0),
        count: Number(r.count ?? 0),
        acceptedPoints: Number(r.acceptedPoints ?? 0),
        acceptedCount: Number(r.acceptedCount ?? 0),
      }));
  }

  /**
   * The Milestones assigned to this item, for the detail rail's multi-select (SRS §5.1, §11.4).
   *
   * `milestone_artifacts` became polymorphic in 0084, so both columns are matched — an id alone
   * no longer identifies a subject.
   */
  async listMilestones(id: string, workspaceId: string): Promise<{ id: string; name: string }[]> {
    return (
      this.db
        .select({ id: milestones.id, name: milestones.name })
        .from(milestoneArtifacts)
        .innerJoin(milestones, eq(milestones.id, milestoneArtifacts.milestoneId))
        .where(
          and(
            eq(milestoneArtifacts.entityType, 'portfolio_item'),
            eq(milestoneArtifacts.entityId, id),
            // `milestone_artifacts` carries no workspace_id, so the tenant predicate has to
            // ride on the joined `milestones` row — otherwise a leaked link id would resolve
            // a name from another workspace.
            eq(milestones.workspaceId, workspaceId),
          ),
        )
        // Name is not unique, so id is the tiebreaker that makes the order total.
        .orderBy(asc(milestones.name), asc(milestones.id))
    );
  }

  /**
   * Replaces this item's Milestone assignments wholesale.
   *
   * Delete-then-insert in ONE transaction rather than diffing: the multi-select sends the whole
   * set, and a partial failure that left the row half-assigned would be worse than either
   * outcome. The `entity_type` predicate keeps a work item's assignments to the same milestones
   * untouched.
   */
  async setMilestones(id: string, milestoneIds: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(milestoneArtifacts)
        .where(
          and(
            eq(milestoneArtifacts.entityType, 'portfolio_item'),
            eq(milestoneArtifacts.entityId, id),
          ),
        );
      if (milestoneIds.length > 0) {
        await tx.insert(milestoneArtifacts).values(
          milestoneIds.map((milestoneId) => ({
            milestoneId,
            entityType: 'portfolio_item' as const,
            entityId: id,
          })),
        );
      }
    });
  }

  /**
   * The SUBSET of `milestoneIds` that belongs to `projectId` — one query serving two callers.
   *
   * The write path compares lengths to reject an out-of-project id; the project-move path keeps
   * what survives and drops the rest. A count could only answer the first question, and adding
   * a second near-identical query would let the two definitions of "in project" drift.
   *
   * Workspace-scoped as well as project-scoped: project ids are not guessable, but matching on
   * project alone would be one leaked id away from attaching another tenant's milestone.
   */
  async filterMilestonesInProject(
    milestoneIds: string[],
    projectId: string,
    workspaceId: string,
  ): Promise<string[]> {
    if (milestoneIds.length === 0) return [];
    const rows = await this.db
      .select({ id: milestones.id })
      .from(milestones)
      .where(
        and(
          inArray(milestones.id, milestoneIds),
          eq(milestones.projectId, projectId),
          eq(milestones.workspaceId, workspaceId),
        ),
      );
    return rows.map((r) => r.id);
  }

  /** Active child Features of an Epic. 0 for a Feature — the hierarchy is two levels. */
  private childFeatureCountSql() {
    return sql<number>`(
      select count(*)::int from ${portfolioItems} c
      where c.parent_id = ${portfolioItems.id} and c.archived_at is null
    )`;
  }

  async findById(id: string, workspaceId: string): Promise<PortfolioItem | null> {
    const rows = await this.db
      .select()
      .from(portfolioItems)
      .where(and(eq(portfolioItems.id, id), eq(portfolioItems.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? this.mapRow(rows[0]) : null;
  }

  async findViewById(id: string, workspaceId: string): Promise<PortfolioItemView | null> {
    const page = await this.selectViews(
      and(eq(portfolioItems.id, id), eq(portfolioItems.workspaceId, workspaceId)),
      { limit: 1, cursor: null },
    );
    return page[0] ?? null;
  }

  async listByFilter(
    workspaceId: string,
    filter: PortfolioListFilter,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PagedResult<PortfolioItemView>> {
    const conditions: SQL[] = [
      eq(portfolioItems.workspaceId, workspaceId),
      eq(portfolioItems.type, filter.type),
    ];

    if (!filter.includeArchived) conditions.push(isNull(portfolioItems.archivedAt));
    if (filter.projectId) conditions.push(eq(portfolioItems.projectId, filter.projectId));
    // The authorization filter. `null` means a workspace-wide grant, so no restriction;
    // otherwise the caller sees only projects they may read. An empty list is handled by
    // the service before it gets here (it short-circuits to an empty page), so an empty
    // `inArray` — which Postgres would treat as always-false anyway — cannot arise.
    if (filter.readableProjectIds !== null) {
      conditions.push(inArray(portfolioItems.projectId, filter.readableProjectIds));
    }
    // Epic has no Team, so a team filter can only ever match Features. The service
    // returns the spec's explicit empty message rather than an empty grid.
    if (filter.teamId) conditions.push(eq(portfolioItems.teamId, filter.teamId));
    if (filter.search) {
      const like = `%${filter.search}%`;
      conditions.push(
        or(ilike(portfolioItems.name, like), ilike(portfolioItems.itemKey, like)) as SQL,
      );
    }
    // Snapshot the filters BEFORE the cursor is applied. The count must describe the
    // whole result set, not the remainder after the current page — otherwise the grid's
    // "of N" shrinks as the reader pages forward. Same split as the work-item list.
    const baseConditions = [...conditions];

    // Rank + id, matching the Backlog convention: `id` is the tiebreaker that makes
    // the order TOTAL. Without it, rows sharing a rank come back in physical-tuple
    // order, which changes whenever one of them is updated — and a keyset cursor over
    // an unstable order silently skips or repeats rows.
    if (args.cursor) {
      conditions.push(keysetCondition(portfolioItems.rank, portfolioItems.id, args.cursor));
    }

    const items = await this.selectViews(and(...conditions), args);

    // No joins: every filter above constrains `portfolio_items` alone, and the view's
    // joins are all LEFT, so they cannot change the row count. Counting the bare table
    // keeps this cheap enough to run on every page.
    const [countRow] = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(portfolioItems)
      .where(and(...baseConditions));

    return buildPageResult(items, args.limit, (i) => [i.rank], 'asc', Number(countRow?.total ?? 0));
  }

  async rollupsFor(ids: string[], workspaceId: string): Promise<PortfolioRollupRow[]> {
    if (ids.length === 0) return [];
    const r = this.rollupSubqueries();
    const rows = await this.db
      .select({ portfolioItemId: portfolioItems.id, ...r })
      .from(portfolioItems)
      .where(and(inArray(portfolioItems.id, ids), eq(portfolioItems.workspaceId, workspaceId)));
    return rows.map((x) => this.mapRollup(x));
  }

  async listChildFeatures(epicId: string, workspaceId: string): Promise<PortfolioItemView[]> {
    return this.selectViews(
      and(
        eq(portfolioItems.parentId, epicId),
        eq(portfolioItems.workspaceId, workspaceId),
        isNull(portfolioItems.archivedAt),
      ),
      { limit: 200, cursor: null },
    );
  }

  async listFeatureOptions(
    workspaceId: string,
    projectId: string,
  ): Promise<PortfolioFeatureOption[]> {
    return (
      this.db
        .select({
          id: portfolioItems.id,
          itemKey: portfolioItems.itemKey,
          name: portfolioItems.name,
          projectId: portfolioItems.projectId,
        })
        .from(portfolioItems)
        .where(
          and(
            eq(portfolioItems.workspaceId, workspaceId),
            eq(portfolioItems.projectId, projectId),
            eq(portfolioItems.type, 'feature'),
            isNull(portfolioItems.archivedAt),
          ),
        )
        // By key, not rank: rank orders a planning grid, while a picker is scanned for a known
        // `FE-<n>`. Total order, so an unpaged read is stable.
        .orderBy(asc(portfolioItems.itemKey), asc(portfolioItems.id))
    );
  }

  /**
   * The Stories and Defects linked to one Feature — the detail Children tab.
   *
   * The predicate set is deliberate, and it does NOT match `listFeatureOptions` above. Three
   * of the four conditions are the obvious ones; the missing fourth is the interesting one:
   *
   *   • `feature_id = ?` — the link itself, and the ONLY thing that defines membership. It is
   *     the same predicate `rollupSubqueries()` and `childRollupByType()` aggregate on, which
   *     is what makes this tab list exactly the rows Percent Done counted.
   *   • `workspace_id = ?` — tenancy.
   *   • `deleted_at is null` — a soft-deleted child is gone from every other work-item surface
   *     (Backlog, Iteration Status, the Phase 6 projections), so listing it here would make this
   *     the one grid that resurrects it.
   *   • `type in ('story','defect')` — a Task is never linked to a Feature directly
   *     (`assertFeatureLinkable` refuses one, and `createTask` writes `feature_id: null`), and
   *     the mapping below ALREADY casts every row to `'story' | 'defect'`. The filter makes the
   *     cast true instead of assumed; `childRollupByType` filters the same rows out in JS.
   *
   * **NO project filter, on purpose.** `listFeatureOptions` is project-scoped because it is a
   * write-eligibility feed for one project (§5.3:133) and its route's guard checks that one
   * project. Membership is not scoped that way: `assertFeatureLinkable` deliberately PERMITS a
   * cross-project link ("Rally lets a team project's Story roll up to a portfolio project's
   * Feature"), and `rollupSubqueries()` matches `feature_id` alone. Adding `project_id` here
   * would hide a legitimately linked child from the tab while the Percent Done bar on the same
   * page still counted it — one row, two answers, in the same viewport. The disagreement the
   * picker creates is a LABEL problem on the work-item side, not a membership problem here.
   */
  async listChildren(
    featureId: string,
    workspaceId: string,
    args: { limit: number; cursor: CursorPayload | null; search?: string },
  ): Promise<PagedResult<PortfolioChildItem>> {
    const owner = alias(users, 'wi_owner');
    const conditions: SQL[] = [
      eq(workItems.featureId, featureId),
      eq(workItems.workspaceId, workspaceId),
      isNull(workItems.deletedAt),
      inArray(workItems.type, ['story', 'defect']),
    ];
    if (args.search) {
      const like = `%${args.search}%`;
      conditions.push(or(ilike(workItems.title, like), ilike(workItems.itemKey, like)) as SQL);
    }
    if (args.cursor) {
      conditions.push(keysetCondition(workItems.rank, workItems.id, args.cursor));
    }

    const rows = await this.db
      .select({
        id: workItems.id,
        itemKey: workItems.itemKey,
        type: workItems.type,
        title: workItems.title,
        scheduleState: workItems.scheduleState,
        storyPoints: workItems.storyPoints,
        rank: workItems.rank,
        // The IDs, not just the display names. Every one of these joins was already here;
        // only the names were selected, which left the grid unable to bind a picker to
        // anything and forced the disclosed Story/Defect rows to be read-only.
        projectId: workItems.projectId,
        releaseId: workItems.releaseId,
        teamId: workItems.teamId,
        assigneeId: workItems.assigneeId,
        // `priority` and the ITERATION are columns the BA's Children tab lists ("Type, ID, Name,
        // Priority, Est, Owner, Schedule State, Iteration, Release"); the child rows could not show
        // them because the query never read them.
        priority: workItems.priority,
        iterationId: workItems.iterationId,
        iterationName: iterations.name,
        releaseName: releases.name,
        projectName: projects.name,
        teamName: teams.name,
        ownerName: owner.displayName,
      })
      .from(workItems)
      .leftJoin(releases, eq(releases.id, workItems.releaseId))
      .leftJoin(projects, eq(projects.id, workItems.projectId))
      .leftJoin(teams, eq(teams.id, workItems.teamId))
      // LEFT, like the others: a child in no iteration still has to render.
      .leftJoin(iterations, eq(iterations.id, workItems.iterationId))
      .leftJoin(owner, eq(owner.id, workItems.assigneeId))
      .where(and(...conditions))
      .orderBy(asc(workItems.rank), asc(workItems.id))
      .limit(args.limit + 1);

    const items = rows.map((r) => ({
      id: r.id,
      itemKey: r.itemKey,
      // Safe by the `type in ('story','defect')` predicate above, not by assumption.
      type: r.type as 'story' | 'defect',
      title: r.title,
      scheduleState: r.scheduleState,
      storyPoints: r.storyPoints,
      priority: r.priority,
      iterationId: r.iterationId,
      iterationName: r.iterationName,
      projectId: r.projectId,
      releaseId: r.releaseId,
      teamId: r.teamId,
      assigneeId: r.assigneeId,
      releaseName: r.releaseName,
      projectName: r.projectName,
      teamName: r.teamName,
      ownerName: r.ownerName,
      rank: r.rank,
    }));

    return buildPageResult(items, args.limit, (i) => [i.rank]);
  }

  async findByIds(ids: string[], workspaceId: string): Promise<PortfolioItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(portfolioItems)
      .where(and(inArray(portfolioItems.id, ids), eq(portfolioItems.workspaceId, workspaceId)));
    return rows.map((r) => this.mapRow(r));
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async nextKeyNumber(scope: PortfolioRankScope, executor?: DbExecutor): Promise<number> {
    const exec = executor ?? this.db;
    // '[0-9]+$' with no backslash: Drizzle's sql template drops a bare '\' before it
    // reaches Postgres, so '\d' would silently match nothing and every key would be 1.
    const rows = await exec
      .select({
        n: sql<number>`COALESCE(MAX(substring(${portfolioItems.itemKey} from '[0-9]+$')::int), 0)::int`,
      })
      .from(portfolioItems)
      .where(
        and(eq(portfolioItems.workspaceId, scope.workspaceId), eq(portfolioItems.type, scope.type)),
      );
    return (rows[0]?.n ?? 0) + 1;
  }

  /**
   * Serialise rank assignment for one (workspace, type) scope.
   *
   * `pg_advisory_xact_lock` is held until the surrounding transaction commits or rolls
   * back, so it cannot leak, and it is keyed on the scope rather than the table — Epic
   * and Feature creates never contend with each other. `hashtext` returns int4 and the
   * two-argument lock form takes two, so the scope maps on directly; a hash collision
   * only makes two unrelated scopes serialise, which is harmless.
   */
  async lockRankScope(scope: PortfolioRankScope, executor: DbExecutor): Promise<void> {
    await executor.execute(
      sql`select pg_advisory_xact_lock(hashtext(${scope.workspaceId}), hashtext(${scope.type}))`,
    );
  }

  async findMaxRank(scope: PortfolioRankScope, executor?: DbExecutor): Promise<string | null> {
    const exec = executor ?? this.db;
    const rows = await exec
      .select({ rank: portfolioItems.rank })
      .from(portfolioItems)
      .where(
        and(eq(portfolioItems.workspaceId, scope.workspaceId), eq(portfolioItems.type, scope.type)),
      )
      // `id` as tiebreaker keeps the pick deterministic when two rows share a rank —
      // which is exactly the state a lock-free create can leave behind, and what
      // `query-ordering.ratchet.spec.ts` enforces repo-wide.
      .orderBy(desc(portfolioItems.rank), asc(portfolioItems.id))
      .limit(1);
    // Archived items are INCLUDED deliberately: they keep their rank, so excluding them
    // could hand a new item a rank equal to an archived one and break `between()` if it
    // were ever restored.
    return rows[0]?.rank ?? null;
  }

  async create(
    input: CreatePortfolioItemInput & { id: string; itemKey: string; rank: string },
    executor?: DbExecutor,
  ): Promise<PortfolioItem> {
    const exec = executor ?? this.db;
    const rows = await exec
      .insert(portfolioItems)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        itemKey: input.itemKey,
        type: input.type,
        name: input.name,
        description: input.description ?? null,
        /**
         * The three rich-text blocks beside Description.
         *
         * `notes` and `releaseNotes` were accepted by `CreatePortfolioItemSchema` and then
         * dropped here, so a create that supplied either got a 201 with the field silently
         * empty — an update was the only way to set them. `whatSuccessLooksLike` (0086) is
         * listed with them rather than after them for that reason.
         */
        notes: input.notes ?? null,
        releaseNotes: input.releaseNotes ?? null,
        whatSuccessLooksLike: input.whatSuccessLooksLike ?? null,
        ...(input.state ? { state: input.state } : {}),
        ...(input.preliminaryEstimate ? { preliminaryEstimate: input.preliminaryEstimate } : {}),
        // NOT NULL DEFAULT 0 (0081): 0 is the "not forecast" value, so an omitted
        // forecast is stored as 0 rather than null.
        refinedEstimate: input.refinedEstimate ?? '0',
        refinedItemCountEstimate: input.refinedItemCountEstimate ?? 0,
        parentId: input.parentId ?? null,
        teamId: input.teamId ?? null,
        releaseId: input.releaseId ?? null,
        ownerId: input.ownerId ?? null,
        plannedStartDate: input.plannedStartDate ?? null,
        plannedEndDate: input.plannedEndDate ?? null,
        marketReleaseDate: input.marketReleaseDate ?? null,
        rank: input.rank,
      })
      .returning();
    return this.mapRow(rows[0]);
  }

  async update(
    id: string,
    input: UpdatePortfolioItemInput & { rank?: string },
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<PortfolioItem> {
    const exec = executor ?? this.db;
    // Built key-by-key rather than spread: `undefined` means "leave alone" and `null`
    // means "clear", and spreading the input would write nulls over untouched columns.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const assign = <K extends keyof (UpdatePortfolioItemInput & { rank?: string })>(
      key: K,
      column = key as string,
    ) => {
      if (input[key] !== undefined) set[column] = input[key];
    };

    assign('name');
    assign('description');
    assign('notes');
    assign('releaseNotes');
    assign('whatSuccessLooksLike');
    // A project MOVE. Listed here because this `assign` list is explicit: a field absent
    // from it is silently dropped, so the PATCH would 200 with nothing changed.
    assign('projectId');
    assign('state');
    assign('preliminaryEstimate');
    assign('refinedEstimate');
    assign('refinedItemCountEstimate');
    assign('parentId');
    assign('teamId');
    assign('releaseId');
    assign('ownerId');
    assign('plannedStartDate');
    assign('plannedEndDate');
    assign('marketReleaseDate');
    assign('rank');

    const rows = await exec
      .update(portfolioItems)
      .set(set)
      .where(and(eq(portfolioItems.id, id), eq(portfolioItems.workspaceId, workspaceId)))
      .returning();
    return this.mapRow(rows[0]);
  }

  async setArchived(
    id: string,
    archived: boolean,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<PortfolioItem> {
    const exec = executor ?? this.db;
    const rows = await exec
      .update(portfolioItems)
      .set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() })
      .where(and(eq(portfolioItems.id, id), eq(portfolioItems.workspaceId, workspaceId)))
      .returning();
    return this.mapRow(rows[0]);
  }

  async countActiveChildFeatures(epicId: string, workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(portfolioItems)
      .where(
        and(
          eq(portfolioItems.parentId, epicId),
          eq(portfolioItems.workspaceId, workspaceId),
          isNull(portfolioItems.archivedAt),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Active (non-deleted) Story/Defect work items linked to a FEATURE.
   *
   * The mirror of `countActiveChildFeatures` one level down, for the same reason: archiving a Feature
   * that still has children leaves them pointing at a hidden parent — visible in the Backlog with a
   * Feature column referencing something the reader cannot open, and still feeding that Feature's own
   * rollup.
   *
   * The link is `work_items.feature_id`, NOT `parent_id`: a Story's parent is another work item
   * (`ix_wi_feature` indexes the Feature link separately). Soft-deleted rows do not count — a deleted
   * Story is not work anyone is going to lose track of.
   */
  async countActiveChildWorkItems(featureId: string, workspaceId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(workItems)
      .where(
        and(
          eq(workItems.featureId, featureId),
          eq(workItems.workspaceId, workspaceId),
          isNull(workItems.deletedAt),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /** The one select every read surface shares, so the shapes cannot drift. */
  private async selectViews(
    where: SQL | undefined,
    args: { limit: number; cursor: CursorPayload | null },
  ): Promise<PortfolioItemView[]> {
    const owner = alias(users, 'pi_owner');
    const parent = alias(portfolioItems, 'pi_parent');
    const r = this.rollupSubqueries();

    const rows = await this.db
      .select({
        item: portfolioItems,
        ownerName: owner.displayName,
        teamName: teams.name,
        releaseName: releases.name,
        projectName: projects.name,
        parentKey: parent.itemKey,
        childFeatureCount: this.childFeatureCountSql(),
        ...r,
      })
      .from(portfolioItems)
      .leftJoin(owner, eq(owner.id, portfolioItems.ownerId))
      .leftJoin(teams, eq(teams.id, portfolioItems.teamId))
      .leftJoin(releases, eq(releases.id, portfolioItems.releaseId))
      .leftJoin(projects, eq(projects.id, portfolioItems.projectId))
      .leftJoin(parent, eq(parent.id, portfolioItems.parentId))
      .where(where)
      .orderBy(asc(portfolioItems.rank), asc(portfolioItems.id))
      .limit(args.limit + 1);

    return rows.map((row) => ({
      ...this.mapRow(row.item),
      ownerName: row.ownerName,
      teamName: row.teamName,
      releaseName: row.releaseName,
      projectName: row.projectName,
      parentKey: row.parentKey,
      childFeatureCount: Number(row.childFeatureCount ?? 0),
      rollup: this.mapRollup({ portfolioItemId: row.item.id, ...row }),
    }));
  }

  private mapRow(row: typeof portfolioItems.$inferSelect): PortfolioItem {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      itemKey: row.itemKey,
      type: row.type,
      name: row.name,
      description: row.description,
      notes: row.notes,
      releaseNotes: row.releaseNotes,
      whatSuccessLooksLike: row.whatSuccessLooksLike,
      state: row.state,
      preliminaryEstimate: row.preliminaryEstimate,
      refinedEstimate: row.refinedEstimate,
      refinedItemCountEstimate: row.refinedItemCountEstimate,
      parentId: row.parentId,
      teamId: row.teamId,
      releaseId: row.releaseId,
      ownerId: row.ownerId,
      plannedStartDate: row.plannedStartDate,
      plannedEndDate: row.plannedEndDate,
      marketReleaseDate: row.marketReleaseDate,
      rank: row.rank,
      archivedAt: row.archivedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Postgres returns numeric aggregates as strings; the domain wants numbers. */
  private mapRollup(row: {
    portfolioItemId: string;
    rollupPoints: unknown;
    rollupCount: unknown;
    acceptedPoints: unknown;
    acceptedCount: unknown;
    completedPoints: unknown;
    completedCount: unknown;
  }): PortfolioRollupRow {
    return {
      portfolioItemId: row.portfolioItemId,
      rollupPoints: Number(row.rollupPoints ?? 0),
      rollupCount: Number(row.rollupCount ?? 0),
      acceptedPoints: Number(row.acceptedPoints ?? 0),
      acceptedCount: Number(row.acceptedCount ?? 0),
      completedPoints: Number(row.completedPoints ?? 0),
      completedCount: Number(row.completedCount ?? 0),
    };
  }
}
