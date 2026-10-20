import { sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { capacityPlanAllocations, workItems } from '../../../../../../db/schema/work';
import { completedScheduleStatesSql } from '../../../../../../db/schema/enums';
import type { CapacityPlanUnit } from '../../../../../../db/schema/enums';

/**
 * The child-work predicate every capacity number is built from: EVERY linked Story/Defect.
 *
 * `P5-CAP-AC-016`, stated twice more in SRS §11: "Feature Rollup is the live sum of every linked
 * Story/Defect Plan Estimate", `SUM(child.planEstimate WHERE child belongs to Feature)`. The only
 * qualifier is the link itself, plus the soft-delete filter — a deleted row is not work.
 *
 * REVERSED DIVERGENCE (BA retest 2026-08-17, `P5-CP-029`, P0). This used to add `work_items.project_id
 * = plan.project_id AND work_items.release_id = plan.release_id`, following Broadcom's own sentence for
 * Rally ("If a portfolio item includes allocated points/counts, the Project and Release fields in the
 * story must match the plan for that story to be included in the Rollup calculation"). The BA has ruled
 * against it: the release filter is what made a Feature with one Completed 3-point child report
 * `Rollup = 0, Complete = 0` on the plan header, on the Team row and on the Features tab, because an
 * ordinary Story carries no Release of its own. Do not re-add the qualifier without a fresh ruling —
 * and see `CLAUDE.md`, "Declared divergences from the BA, in Capacity Planning".
 *
 * Correlated: it references `capacity_plan_allocations` from the enclosing query, so it is only valid
 * inside a subquery whose outer FROM is that table.
 */
export function featureChildScope(): SQL {
  return sql`${workItems.featureId} = ${capacityPlanAllocations.portfolioItemId}
    and ${workItems.deletedAt} is null`;
}

/** The alias the peer-allocation lookup runs under — one constant so the FROM and the columns agree. */
const PEER_ALLOC = 'peer_alloc';

/**
 * The same population, split across the Feature's TEAM allocation rows — one slice per row.
 *
 * Two properties the BA requires together (`P5-CAP-AC-016`/`AC-017`, and SRS §341: "Team Rollup =
 * SUM(Feature/Team Rollup for allocation rows in Team)"): a child must land in EXACTLY ONE slice, and
 * the slices must SUM to the Feature's own total. So the rule is a two-tier attribution, the same shape
 * `getScopedTaskHours` and Team Status already use for a task's team:
 *
 *  1. The child names a team that holds an allocation of this Feature on this plan → that team's slice.
 *  2. Otherwise — no team at all, or a team nobody planned this Feature with — it falls to the
 *     Feature's OWNER on the plan, which is Rally's Planned Team Assignment (`is_primary`). That row is
 *     unique per (plan, Feature) by `uq_capacity_allocation_primary`, so the fallback cannot duplicate.
 *
 * A strict `work_items.team_id = allocation.team_id` was tier 1 alone, and SQL equality never matches
 * NULL — `work_items.team_id` is nullable and mostly unset — so every unteamed child fell out of every
 * team slice. The plan header is the SUM of the team rows (`planTotals`), which is why the BA saw 0
 * there too.
 *
 * An UNALLOCATED row (`team_id is null`) counts the whole Feature: it is not part of any team's total,
 * so it cannot double-count, and it has to report what is parked rather than nothing.
 */
export function teamSliceChildScope(): SQL {
  /**
   * Aliased because the enclosing query already has `capacity_plan_allocations` in its FROM; without
   * an alias the peer lookup would correlate to the outer row and always find itself.
   *
   * The FROM clause is spelled out — `${table} as ${sql.identifier(...)}` — rather than interpolating
   * the aliased table object: inside a `sql` template drizzle renders an alias as the bare name
   * (`from "peer_alloc"`), which is a relation that does not exist. `alias()` is still used for the
   * COLUMN references, which do render as `"peer_alloc"."plan_id"`.
   */
  const peer = alias(capacityPlanAllocations, PEER_ALLOC);
  return sql`${featureChildScope()}
    and (
      ${capacityPlanAllocations.teamId} is null
      or ${workItems.teamId} = ${capacityPlanAllocations.teamId}
      or (
        ${capacityPlanAllocations.isPrimary}
        and not exists (
          select 1 from ${capacityPlanAllocations} as ${sql.identifier(PEER_ALLOC)}
          where ${peer.planId} = ${capacityPlanAllocations.planId}
            and ${peer.portfolioItemId} = ${capacityPlanAllocations.portfolioItemId}
            and ${peer.teamId} = ${workItems.teamId}
        )
      )
    )`;
}

/**
 * The measure a plan is counted in — POINTS or the number of child items.
 *
 * Rally plans in one of two units ("View Work Items by Points or Count") and the BA states the
 * arithmetic for both: `SUM(child.planEstimate)` for points, `COUNT(child)` for count. Everything
 * downstream — Rollup, Complete, the bars, every warning, the cutline — has to be expressed in the
 * SAME unit as the team's Capacity, or a count-unit plan compares points against a headcount.
 *
 * `count(*)` rather than `sum(1)` so a child with no estimate still counts: in count mode the item
 * IS the unit, and an unestimated story is still one story.
 */
export function measureSql(unit: CapacityPlanUnit) {
  return unit === 'count' ? sql`count(*)` : sql`coalesce(sum(${workItems.storyPoints}), 0)`;
}

/**
 * The same measure, restricted to finished children — the `filter` clause differs by unit.
 *
 * COMPLETED_SCHEDULE_STATES (`completed`, `accepted`, `release`) is AC-016's list, and it is
 * deliberately NOT the Portfolio's Percent Done list (ACCEPTED_SCHEDULE_STATES): a capacity plan
 * reports what a team has FINISHED, the portfolio reports what the business has SIGNED OFF. That is
 * the D1 distinction documented in `db/schema/enums.ts`.
 */
export function completedMeasureSql(unit: CapacityPlanUnit) {
  const finished = sql`filter (where ${workItems.scheduleState} in (${completedScheduleStatesSql()}))`;
  return unit === 'count'
    ? sql`count(*) ${finished}`
    : sql`coalesce(sum(${workItems.storyPoints}) ${finished}, 0)`;
}
