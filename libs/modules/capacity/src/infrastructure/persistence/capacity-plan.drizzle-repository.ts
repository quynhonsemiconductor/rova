import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';
import { InjectDrizzle } from '@platform';
import type { DbExecutor, DrizzleDB } from '@platform';
import {
  capacityPlanAllocations,
  capacityPlanTeams,
  capacityPlans,
  iterations,
  portfolioItems,
  projects,
  releases,
  teams,
  workItems,
} from '../../../../../../db/schema/work';
import {
  completedMeasureSql,
  featureChildScope,
  measureSql,
  teamSliceChildScope,
} from './capacity-metrics.sql';
import {
  acceptedScheduleStatesSql,
  type CapacityAllocationSource,
} from '../../../../../../db/schema/enums';
import type { VelocitySample } from '../../domain/capacity-forecast';
import type {
  CapacityAllocation,
  CapacityAllocationRow,
} from '../../domain/capacity-allocation.types';
import type {
  CapacityPlan,
  CapacityPlanTeam,
  CapacityPlanTeamView,
  CapacityPlanView,
  CreateCapacityPlanInput,
  PlanWindow,
  UpdateCapacityPlanInput,
} from '../../domain/capacity-plan.types';
import type { ICapacityPlanRepository } from '../../domain/ports/capacity-plan.repository';

@Injectable()
export class CapacityPlanDrizzleRepository implements ICapacityPlanRepository {
  constructor(@InjectDrizzle() private readonly db: DrizzleDB) {}

  async findById(id: string, workspaceId: string): Promise<CapacityPlan | null> {
    const rows = await this.db
      .select()
      .from(capacityPlans)
      .where(and(eq(capacityPlans.id, id), eq(capacityPlans.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? this.mapPlan(rows[0]) : null;
  }

  async findByProjectRelease(
    projectId: string,
    releaseId: string,
    workspaceId: string,
  ): Promise<CapacityPlan | null> {
    const rows = await this.db
      .select()
      .from(capacityPlans)
      .where(
        and(
          eq(capacityPlans.projectId, projectId),
          eq(capacityPlans.releaseId, releaseId),
          eq(capacityPlans.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    return rows[0] ? this.mapPlan(rows[0]) : null;
  }

  async findViewById(id: string, workspaceId: string): Promise<CapacityPlanView | null> {
    const views = await this.selectViews(
      and(eq(capacityPlans.id, id), eq(capacityPlans.workspaceId, workspaceId)),
    );
    return views[0] ?? null;
  }

  async listByProject(projectId: string, workspaceId: string): Promise<CapacityPlanView[]> {
    return this.selectViews(
      and(eq(capacityPlans.projectId, projectId), eq(capacityPlans.workspaceId, workspaceId)),
    );
  }

  async nextKeyNumber(projectId: string, workspaceId: string): Promise<number> {
    // MAX(existing suffix) + 1, mirroring `iterations.nextKeyNumber` — including its
    // `substring(... from '[0-9]+$')`: Drizzle's sql template drops a bare backslash before it
    // reaches Postgres, so a `\d`-based pattern silently matches nothing and always yields 0.
    const rows = await this.db
      .select({
        n: sql<number>`COALESCE(MAX(substring(${capacityPlans.planKey} from '[0-9]+$')::int), 0)::int`,
      })
      .from(capacityPlans)
      .where(
        and(eq(capacityPlans.projectId, projectId), eq(capacityPlans.workspaceId, workspaceId)),
      );
    return Number(rows[0]?.n ?? 0) + 1;
  }

  async delete(id: string, workspaceId: string, executor?: DbExecutor): Promise<void> {
    const exec = executor ?? this.db;
    // Teams and allocations cascade (`fk_capacity_plan_teams_plan`,
    // `fk_capacity_plan_allocations_plan`), so this is one statement, not three.
    await exec
      .delete(capacityPlans)
      .where(and(eq(capacityPlans.id, id), eq(capacityPlans.workspaceId, workspaceId)));
  }

  async create(input: CreateCapacityPlanInput, executor?: DbExecutor): Promise<CapacityPlan> {
    const exec = executor ?? this.db;
    const rows = await exec
      .insert(capacityPlans)
      .values({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        releaseId: input.releaseId,
        planKey: input.planKey,
        name: input.name,
        unit: input.unit,
        plannedStartDate: input.plannedStartDate ?? null,
        plannedEndDate: input.plannedEndDate ?? null,
      })
      .returning();
    return this.mapPlan(rows[0]);
  }

  async update(
    id: string,
    input: UpdateCapacityPlanInput,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<CapacityPlan> {
    const exec = executor ?? this.db;
    // Assigned key-by-key: `undefined` means "leave alone" while `null` clears a date, so
    // spreading the input would write nulls over columns the caller never mentioned.
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name;
    if (input.plannedStartDate !== undefined) set.plannedStartDate = input.plannedStartDate;
    if (input.plannedEndDate !== undefined) set.plannedEndDate = input.plannedEndDate;

    const rows = await exec
      .update(capacityPlans)
      .set(set)
      .where(and(eq(capacityPlans.id, id), eq(capacityPlans.workspaceId, workspaceId)))
      .returning();
    return this.mapPlan(rows[0]);
  }

  // ── Teams ─────────────────────────────────────────────────────────────────

  async findTeam(planId: string, teamId: string): Promise<CapacityPlanTeam | null> {
    const rows = await this.db
      .select()
      .from(capacityPlanTeams)
      .where(and(eq(capacityPlanTeams.planId, planId), eq(capacityPlanTeams.teamId, teamId)))
      .limit(1);
    return rows[0] ? this.mapTeam(rows[0]) : null;
  }

  async addTeam(planId: string, teamId: string, executor?: DbExecutor): Promise<CapacityPlanTeam> {
    const exec = executor ?? this.db;
    // Capacity is left NULL: joining a plan is not the same as having a capacity of zero,
    // and the grid renders the difference.
    const rows = await exec.insert(capacityPlanTeams).values({ planId, teamId }).returning();
    return this.mapTeam(rows[0]);
  }

  async setTeamCapacity(
    planId: string,
    teamId: string,
    capacity: string | null,
    executor?: DbExecutor,
  ): Promise<CapacityPlanTeam> {
    const exec = executor ?? this.db;
    const rows = await exec
      .update(capacityPlanTeams)
      .set({ capacity, updatedAt: new Date() })
      .where(and(eq(capacityPlanTeams.planId, planId), eq(capacityPlanTeams.teamId, teamId)))
      .returning();
    return this.mapTeam(rows[0]);
  }

  async removeTeam(planId: string, teamId: string, executor?: DbExecutor): Promise<void> {
    const exec = executor ?? this.db;
    await exec
      .delete(capacityPlanTeams)
      .where(and(eq(capacityPlanTeams.planId, planId), eq(capacityPlanTeams.teamId, teamId)));
  }

  // ── Allocations ───────────────────────────────────────────────────────────

  async listAllocations(plan: CapacityPlan): Promise<CapacityAllocationRow[]> {
    // ONE round trip. Each metric is a correlated subquery — the same shape the portfolio
    // repository uses for its rollups — because the architecture doc is explicit that a
    // per-row fetch here would make the page unusable.
    //
    // The child filter is AC-016's: EVERY linked Story/Defect, with no Project or Release
    // qualifier (see `capacity-metrics.sql.ts` for the reversed divergence). `teamSliceChildScope`
    // is that same population attributed to exactly one of the Feature's team allocations, so the
    // slices sum to the Feature's own totals below.
    const childScope = teamSliceChildScope();
    const featureScope = featureChildScope();

    const rows = await this.db
      .select({
        alloc: capacityPlanAllocations,
        itemKey: portfolioItems.itemKey,
        name: portfolioItems.name,
        // Rally's "Project" column: where the Feature lives OUTSIDE the plan. Not the same as the
        // plan's project — a Story-to-Feature link may cross projects, so a plan can carry a
        // Feature owned elsewhere, and the planner needs to see that before allocating to it.
        itemProjectId: portfolioItems.projectId,
        itemProjectName: projects.name,
        // The Feature's OWN team, for the BA's `Team` column.
        itemTeamId: portfolioItems.teamId,
        itemTeamName: teams.name,
        itemArchivedAt: portfolioItems.archivedAt,
        itemReleaseId: portfolioItems.releaseId,
        itemState: portfolioItems.state,
        refinedEstimate: portfolioItems.refinedEstimate,
        preliminaryEstimate: portfolioItems.preliminaryEstimate,
        // Measured in the PLAN's unit: points, or the COUNT of child items. Everything these feed —
        // bars, warnings, the cutline — is compared against a Capacity entered in that same unit.
        rollup: sql<string>`(
          select ${measureSql(plan.unit)}
          from ${workItems} where ${childScope}
        )`,
        complete: sql<string>`(
          select ${completedMeasureSql(plan.unit)}
          from ${workItems} where ${childScope}
        )`,
        rank: portfolioItems.rank,
        // The Feature's OWN totals, across every team — the same child population WITHOUT the team
        // attribution. Rally's Items tab reports a Feature's rollup once, not once per team, and
        // `teamSliceChildScope` partitions exactly this set, so the team slices sum back to it.
        itemRollup: sql<string>`(
          select ${measureSql(plan.unit)}
          from ${workItems}
          where ${featureScope}
        )`,
        itemComplete: sql<string>`(
          select ${completedMeasureSql(plan.unit)}
          from ${workItems}
          where ${featureScope}
        )`,
      })
      .from(capacityPlanAllocations)
      .innerJoin(portfolioItems, eq(portfolioItems.id, capacityPlanAllocations.portfolioItemId))
      // LEFT, not INNER: the name is decoration on a row that must render regardless. An inner
      // join here would make a Feature disappear from the plan if its project row were missing.
      .leftJoin(projects, eq(projects.id, portfolioItems.projectId))
      // LEFT, like `projects`: a Feature with no team still has to render.
      .leftJoin(teams, eq(teams.id, portfolioItems.teamId))
      .where(eq(capacityPlanAllocations.planId, plan.id))
      // Unallocated last, then by the Feature's own RANK — not its key.
      //
      // Rank order is what makes the cutline meaningful: it is a running total down the
      // priority order, so in any other order the accumulation answers nothing. Key order was
      // effectively creation order, which is arbitrary. `id` is the unique tiebreaker the
      // ordering ratchet requires.
      .orderBy(
        asc(sql`${capacityPlanAllocations.teamId} is null`),
        asc(portfolioItems.rank),
        asc(capacityPlanAllocations.id),
      );

    return rows.map((row) => ({
      ...this.mapAllocation(row.alloc),
      itemKey: row.itemKey,
      name: row.name,
      itemProjectId: row.itemProjectId,
      itemProjectName: row.itemProjectName,
      itemTeamId: row.itemTeamId,
      itemTeamName: row.itemTeamName,
      itemArchivedAt: row.itemArchivedAt,
      itemReleaseId: row.itemReleaseId,
      state: row.itemState,
      refined: row.refinedEstimate === null ? null : Number(row.refinedEstimate),
      preliminarySize: row.preliminaryEstimate,
      rank: row.rank,
      itemRollup: Number(row.itemRollup),
      itemComplete: Number(row.itemComplete),
      rollup: Number(row.rollup),
      complete: Number(row.complete),
    }));
  }

  async findAllocation(id: string, planId: string): Promise<CapacityAllocation | null> {
    const rows = await this.db
      .select()
      .from(capacityPlanAllocations)
      .where(and(eq(capacityPlanAllocations.id, id), eq(capacityPlanAllocations.planId, planId)))
      .limit(1);
    return rows[0] ? this.mapAllocation(rows[0]) : null;
  }

  async listAllocationsForTeam(planId: string, teamId: string): Promise<CapacityAllocation[]> {
    const rows = await this.db
      .select()
      .from(capacityPlanAllocations)
      .where(
        and(eq(capacityPlanAllocations.planId, planId), eq(capacityPlanAllocations.teamId, teamId)),
      )
      // `id` last so the order is total: two rows written in one statement share a `created_at`.
      .orderBy(capacityPlanAllocations.createdAt, capacityPlanAllocations.id);
    return rows.map((row) => this.mapAllocation(row));
  }

  async listAllocationsForItem(
    planId: string,
    portfolioItemId: string,
  ): Promise<CapacityAllocation[]> {
    const rows = await this.db
      .select()
      .from(capacityPlanAllocations)
      .where(
        and(
          eq(capacityPlanAllocations.planId, planId),
          eq(capacityPlanAllocations.portfolioItemId, portfolioItemId),
        ),
      )
      // Primary first: a move recreates the rows on the target, and the Feature's owning team
      // should land as the owner there too rather than by whichever row the database returned first.
      // `id` last: two rows written in the same statement share a `created_at`, and a tie then
      // resolves to physical-tuple order, which the next UPDATE changes.
      .orderBy(
        desc(capacityPlanAllocations.isPrimary),
        capacityPlanAllocations.createdAt,
        capacityPlanAllocations.id,
      );
    return rows.map((row) => this.mapAllocation(row));
  }

  async findAllocationFor(
    planId: string,
    portfolioItemId: string,
    teamId: string | null,
  ): Promise<CapacityAllocation | null> {
    const rows = await this.db
      .select()
      .from(capacityPlanAllocations)
      .where(
        and(
          eq(capacityPlanAllocations.planId, planId),
          eq(capacityPlanAllocations.portfolioItemId, portfolioItemId),
          // `= null` never matches in SQL, so the Unallocated bucket needs IS NULL.
          teamId === null
            ? isNull(capacityPlanAllocations.teamId)
            : eq(capacityPlanAllocations.teamId, teamId),
        ),
      )
      .limit(1);
    return rows[0] ? this.mapAllocation(rows[0]) : null;
  }

  async createAllocation(
    input: {
      planId: string;
      portfolioItemId: string;
      teamId: string | null;
      value: string;
      source: CapacityAllocationSource;
      isPrimary?: boolean;
    },
    executor?: DbExecutor,
  ): Promise<CapacityAllocation> {
    const exec = executor ?? this.db;
    const rows = await exec.insert(capacityPlanAllocations).values(input).returning();
    return this.mapAllocation(rows[0]);
  }

  async updateAllocation(
    id: string,
    input: {
      value?: string;
      source?: CapacityAllocationSource;
      teamId?: string | null;
      isPrimary?: boolean;
    },
    executor?: DbExecutor,
  ): Promise<CapacityAllocation> {
    const exec = executor ?? this.db;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (input.value !== undefined) set.value = input.value;
    if (input.source !== undefined) set.source = input.source;
    // `undefined` leaves the team alone; `null` moves the row to the Unallocated bucket.
    if (input.teamId !== undefined) set.teamId = input.teamId;
    if (input.isPrimary !== undefined) set.isPrimary = input.isPrimary;

    const rows = await exec
      .update(capacityPlanAllocations)
      .set(set)
      .where(eq(capacityPlanAllocations.id, id))
      .returning();
    return this.mapAllocation(rows[0]);
  }

  async deleteAllocation(id: string, executor?: DbExecutor): Promise<void> {
    const exec = executor ?? this.db;
    await exec.delete(capacityPlanAllocations).where(eq(capacityPlanAllocations.id, id));
  }

  // ── Primary team assignment ───────────────────────────────────────────────

  /** Does this Feature already have a primary team on this plan? */
  async hasPrimaryAllocation(planId: string, portfolioItemId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: capacityPlanAllocations.id })
      .from(capacityPlanAllocations)
      .where(
        and(
          eq(capacityPlanAllocations.planId, planId),
          eq(capacityPlanAllocations.portfolioItemId, portfolioItemId),
          eq(capacityPlanAllocations.isPrimary, true),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Clear the primary flag for one Feature on one plan.
   *
   * Runs before setting the new one, inside the caller's transaction:
   * `uq_capacity_allocation_primary` rejects a second primary outright, so the order is not a
   * style choice.
   */
  async clearPrimaryAllocations(
    planId: string,
    portfolioItemId: string,
    executor?: DbExecutor,
  ): Promise<void> {
    const exec = executor ?? this.db;
    await exec
      .update(capacityPlanAllocations)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(
        and(
          eq(capacityPlanAllocations.planId, planId),
          eq(capacityPlanAllocations.portfolioItemId, portfolioItemId),
          eq(capacityPlanAllocations.isPrimary, true),
        ),
      );
  }

  /**
   * The oldest TEAM-assigned allocation for a Feature — the one that inherits the assignment
   * when the primary is removed or parked.
   *
   * Oldest rather than largest: the first team to receive work is the one Rally's assign-then-
   * allocate order treats as the owner, and "biggest allocation wins" would hand ownership around
   * on every estimate edit.
   */
  async oldestTeamAllocation(
    planId: string,
    portfolioItemId: string,
    executor?: DbExecutor,
  ): Promise<{ id: string } | null> {
    const exec = executor ?? this.db;
    const rows = await exec
      .select({ id: capacityPlanAllocations.id })
      .from(capacityPlanAllocations)
      .where(
        and(
          eq(capacityPlanAllocations.planId, planId),
          eq(capacityPlanAllocations.portfolioItemId, portfolioItemId),
          isNotNull(capacityPlanAllocations.teamId),
        ),
      )
      // `id` breaks ties so two rows created in the same transaction still order deterministically
      // — the ordering ratchet requires that last column anyway.
      .orderBy(asc(capacityPlanAllocations.createdAt), asc(capacityPlanAllocations.id))
      .limit(1);
    return rows[0] ?? null;
  }

  // ── Publish ───────────────────────────────────────────────────────────────

  /**
   * The release's own window, for the span check publishing depends on.
   *
   * `capacity_plans.release_id` carries no foreign key (see the schema comment), so this
   * reads by id + workspace rather than joining.
   */
  async releaseWindow(
    releaseId: string,
    workspaceId: string,
  ): Promise<{ startDate: string | null; endDate: string | null } | null> {
    const rows = await this.db
      .select({ startDate: releases.startDate, endDate: releases.releaseDate })
      .from(releases)
      .where(and(eq(releases.id, releaseId), eq(releases.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async setFeatureRelease(
    portfolioItemId: string,
    workspaceId: string,
    releaseId: string,
    executor?: DbExecutor,
  ): Promise<void> {
    const exec = executor ?? this.db;
    await exec
      .update(portfolioItems)
      .set({ releaseId, updatedAt: new Date() })
      .where(
        and(
          eq(portfolioItems.id, portfolioItemId),
          eq(portfolioItems.workspaceId, workspaceId),
          isNull(portfolioItems.archivedAt),
        ),
      );
  }

  /**
   * Write what the publish was GIVEN onto one Feature, and nothing else.
   *
   * Both keys are additive: an omitted one leaves its column alone. That is why this is a built-up
   * `set` and not a spread of the argument — a spread would put `undefined` in the object, which
   * Drizzle also skips, but it would let a `null` reach the column just as easily. Publish stamping
   * the plan's own nullable dates unconditionally is exactly how it came to ERASE the planned window
   * of every allocated Feature on a plan that had none of its own.
   */
  async applyPlanToFeature(
    portfolioItemId: string,
    workspaceId: string,
    projectId: string,
    fields: { window?: PlanWindow; releaseId?: string },
    executor?: DbExecutor,
  ): Promise<boolean> {
    const exec = executor ?? this.db;
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (fields.window !== undefined) {
      set.plannedStartDate = fields.window.start;
      set.plannedEndDate = fields.window.end;
    }
    if (fields.releaseId !== undefined) set.releaseId = fields.releaseId;

    // `returning` so the caller can tell a WRITE from a no-op: the `archivedAt` filter means an
    // archived Feature matches nothing, and publish used to count that as updated.
    const written = await exec
      .update(portfolioItems)
      .set(set)
      .where(
        and(
          eq(portfolioItems.id, portfolioItemId),
          eq(portfolioItems.workspaceId, workspaceId),
          /**
           * The PLAN's project, so a publish can never write across projects.
           *
           * A Feature moved to another project used to leave its allocation rows behind, and this
           * update filtered on id + workspace only — so publish wrote the old project's `release_id`
           * onto a Feature that now lives elsewhere, producing exactly the state
           * `assertReferences` rejects with `PORTFOLIO_ITEM_PROJECT_MISMATCH`. The move is refused
           * outright now; this makes the write itself incapable of it, including for rows that
           * predate the guard.
           */
          eq(portfolioItems.projectId, projectId),
          isNull(portfolioItems.archivedAt),
        ),
      )
      .returning({ id: portfolioItems.id });
    return written.length > 0;
  }

  /**
   * Flip a plan between draft and published.
   *
   * `publishedAt`/`publishedBy` are STAMPED on publish and deliberately left in place on
   * revert: they record that a publish happened, which is what lets a re-publish of an
   * emptied plan be allowed (Rally blocks only a plan that has never been published, holds
   * no items and has no projects).
   */
  async setStatus(
    id: string,
    workspaceId: string,
    status: 'draft' | 'published',
    publishedBy: string | null,
    executor?: DbExecutor,
  ): Promise<CapacityPlan> {
    const exec = executor ?? this.db;
    const set: Record<string, unknown> = { status, updatedAt: new Date() };
    if (status === 'published') {
      set.publishedAt = new Date();
      set.publishedBy = publishedBy;
    }

    const rows = await exec
      .update(capacityPlans)
      .set(set)
      .where(and(eq(capacityPlans.id, id), eq(capacityPlans.workspaceId, workspaceId)))
      .returning();
    return this.mapPlan(rows[0]);
  }

  /**
   * A team's delivery history: accepted totals per FINISHED iteration.
   *
   * Attributed by the STORY's own `team_id`, not the iteration's. An iteration is optionally
   * team-scoped in this schema and real Rally uses project-as-team, so an iteration row is
   * an unreliable owner; the work item always names the team that delivered it. That also
   * makes a shared iteration contribute correctly to each team that worked in it.
   *
   * ACCEPTED, not completed — the D1 distinction. Forecasting from `completed` would predict
   * capacity from work that was never signed off, which is exactly the optimism a forecast
   * exists to remove.
   *
   * Finished means `end_date < today`: state is a workflow signal a team may forget to
   * advance, while a past end date is a fact. One row per iteration, so the caller receives
   * the sample set the sampler needs without a second query.
   */
  async teamVelocitySamples(
    projectId: string,
    teamId: string,
    workspaceId: string,
    historyDays: number,
  ): Promise<VelocitySample[]> {
    const accepted = acceptedScheduleStatesSql();
    const rows = await this.db
      .select({
        iterationId: iterations.id,
        iterationName: iterations.name,
        startDate: iterations.startDate,
        endDate: iterations.endDate,
        points: sql<string>`coalesce(sum(${workItems.storyPoints}), 0)`,
        count: sql<string>`count(${workItems.id})`,
      })
      .from(iterations)
      // INNER join: an iteration in which this team accepted nothing is not a zero-velocity
      // sample, it is an iteration the team did not take part in. Counting it as 0 would
      // drag every forecast down for work someone else owned.
      .innerJoin(
        workItems,
        and(
          eq(workItems.iterationId, iterations.id),
          eq(workItems.teamId, teamId),
          isNull(workItems.deletedAt),
          // Parentheses belong to the caller: the helper returns a bare comma list.
          sql`${workItems.scheduleState} in (${accepted})`,
          /**
           * SU-08 8.1 — the `[Unfinished]` Split placeholder is not a delivery sample.
           *
           * It is `accepted` in a finished iteration, which is exactly this query's population, so
           * without the predicate every Split would raise the team's historical velocity by points
           * nobody delivered — and this is a FORECAST input, so the error propagates into planned
           * capacity rather than sitting in one chart. Same rule as `measureIterationDay` and the
           * Iteration Status strip; `split_id IS NULL` is the D6 predicate.
           */
          isNull(workItems.splitId),
        ),
      )
      .where(
        and(
          eq(iterations.workspaceId, workspaceId),
          eq(iterations.projectId, projectId),
          isNotNull(iterations.startDate),
          isNotNull(iterations.endDate),
          sql`${iterations.endDate} < current_date`,
          sql`${iterations.endDate} >= current_date - ${historyDays} * interval '1 day'`,
        ),
      )
      .groupBy(iterations.id, iterations.name, iterations.startDate, iterations.endDate)
      // Newest first, tie-broken on the unique id so the page is deterministic — the
      // query-ordering ratchet requires that last column.
      .orderBy(desc(iterations.endDate), asc(iterations.id));

    return rows.map((row) => ({
      iterationId: row.iterationId,
      iterationName: row.iterationName,
      points: Number(row.points),
      count: Number(row.count),
      // Inclusive of both endpoints: a Mon–Fri iteration is 5 days of delivery, not 4.
      days: daysInclusive(row.startDate, row.endDate),
    }));
  }

  async projectIterationCadenceDays(
    projectId: string,
    workspaceId: string,
  ): Promise<number | null> {
    const rows = await this.db
      .select({
        // Inclusive of both endpoints, matching `daysInclusive` on the velocity samples — a
        // Mon–Fri iteration is 5 days of delivery, not 4.
        days: sql<string | null>`avg(${iterations.endDate} - ${iterations.startDate} + 1)`,
      })
      .from(iterations)
      .where(
        and(
          eq(iterations.workspaceId, workspaceId),
          eq(iterations.projectId, projectId),
          isNotNull(iterations.startDate),
          isNotNull(iterations.endDate),
        ),
      );

    // `avg` over no rows is NULL, which is the "this project runs no dated iterations" answer
    // rather than a cadence of zero.
    const days = rows[0]?.days;
    if (days === null || days === undefined) return null;
    const parsed = Number(days);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private mapAllocation(row: typeof capacityPlanAllocations.$inferSelect): CapacityAllocation {
    return {
      id: row.id,
      planId: row.planId,
      portfolioItemId: row.portfolioItemId,
      teamId: row.teamId,
      isPrimary: row.isPrimary,
      value: row.value,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async countTeamAllocations(planId: string, teamId: string): Promise<number> {
    const rows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(capacityPlanAllocations)
      .where(
        and(eq(capacityPlanAllocations.planId, planId), eq(capacityPlanAllocations.teamId, teamId)),
      );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * The one select both read surfaces share, so list and detail cannot drift.
   *
   * Teams come back in a SECOND query keyed by the plan ids rather than as a join: a join
   * would repeat every plan column per team and force de-duplication in JS, and the team
   * count per plan is small enough that two round trips beat that.
   */
  private async selectViews(where: SQL | undefined): Promise<CapacityPlanView[]> {
    const planRows = await this.db
      .select({
        plan: capacityPlans,
        releaseName: releases.name,
        projectName: projects.name,
      })
      .from(capacityPlans)
      .leftJoin(releases, eq(releases.id, capacityPlans.releaseId))
      .leftJoin(projects, eq(projects.id, capacityPlans.projectId))
      .where(where)
      // Newest first, with `id` as the tiebreaker that makes the order total —
      // `query-ordering.ratchet.spec.ts` enforces a unique final column repo-wide.
      .orderBy(desc(capacityPlans.createdAt), asc(capacityPlans.id));

    if (planRows.length === 0) return [];

    const planIds = planRows.map((r) => r.plan.id);
    const teamRows = await this.db
      .select({ team: capacityPlanTeams, teamName: teams.name })
      .from(capacityPlanTeams)
      .leftJoin(teams, eq(teams.id, capacityPlanTeams.teamId))
      .where(inArray(capacityPlanTeams.planId, planIds))
      .orderBy(asc(capacityPlanTeams.createdAt), asc(capacityPlanTeams.id));

    const byPlan = new Map<string, CapacityPlanTeamView[]>();
    for (const row of teamRows) {
      const list = byPlan.get(row.team.planId) ?? [];
      list.push({ ...this.mapTeam(row.team), teamName: row.teamName });
      byPlan.set(row.team.planId, list);
    }

    return planRows.map((row) => {
      const planTeams = byPlan.get(row.plan.id) ?? [];
      return {
        ...this.mapPlan(row.plan),
        releaseName: row.releaseName,
        projectName: row.projectName,
        teams: planTeams,
        totalCapacity: sumCapacity(planTeams),
      };
    });
  }

  private mapPlan(row: typeof capacityPlans.$inferSelect): CapacityPlan {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      releaseId: row.releaseId,
      planKey: row.planKey,
      name: row.name,
      status: row.status,
      unit: row.unit,
      plannedStartDate: row.plannedStartDate,
      plannedEndDate: row.plannedEndDate,
      publishedAt: row.publishedAt,
      publishedBy: row.publishedBy,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private mapTeam(row: typeof capacityPlanTeams.$inferSelect): CapacityPlanTeam {
    return {
      id: row.id,
      planId: row.planId,
      teamId: row.teamId,
      capacity: row.capacity,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

/**
 * Sum of the team capacities that have actually been entered.
 *
 * Returns null when NONE has been, rather than 0: "nobody has typed a capacity" and
 * "every team has zero capacity" are different states, and only the second one means the
 * plan is genuinely full. Kept out of SQL so the null-vs-zero rule lives in one readable
 * place instead of a `sum(...) filter (...)` expression.
 */
function sumCapacity(planTeams: CapacityPlanTeamView[]): string | null {
  const entered = planTeams.filter((t) => t.capacity !== null);
  if (entered.length === 0) return null;
  const total = entered.reduce((sum, t) => sum + Number(t.capacity), 0);
  return total.toFixed(2);
}

/**
 * Calendar length of a date range in whole days, both endpoints counted.
 *
 * `date` columns arrive as `YYYY-MM-DD` strings, so this parses rather than subtracting
 * Dates — and being UTC-anchored means it cannot drift by one across a DST boundary the way
 * local-time arithmetic does.
 */
function daysInclusive(start: string | null, end: string | null): number {
  if (start === null || end === null) return 0;
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, Math.round((to - from) / 86_400_000) + 1);
}
