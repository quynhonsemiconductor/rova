import type { EstimateTier } from '@modules/portfolio';
import type {
  CapacityAllocationSource,
  PortfolioItemState,
  PreliminaryEstimateSize,
} from '../../../../../db/schema/enums';
import type { CapacityWarning } from '@modules/portfolio';

/**
 * One committed allocation: this much of this Feature, to this Team, in this plan.
 *
 * `value` is THE ONLY stored number in Phase 5 (see `db/schema/work.ts`). Everything else
 * on these surfaces is aggregated on read, deliberately: a plan records what was
 * COMMITTED, so it must not drift when the Feature's child estimates change afterwards.
 *
 * `teamId === null` is the Unallocated bucket — demand a planner has parked on the plan
 * without choosing a team yet. It is modelled as a null team rather than a second table.
 */
export interface CapacityAllocation {
  id: string;
  planId: string;
  portfolioItemId: string;
  teamId: string | null;
  /**
   * This allocation's team is the Feature's PRIMARY assignment on this plan — the agile ALM tool's "Planned
   * Project Assignment". At most one per (plan, Feature), enforced by a partial unique index, and
   * never true for an Unallocated row.
   */
  isPrimary: boolean;
  /**
   * The committed demand on this row — a FIXED value, never resolved on read (SRS §11).
   *
   * It was nullable between 0077 and 0101, with null meaning "charge the Feature's estimate here",
   * resolved per read. That made a planner's commitment move whenever someone edited the Feature's
   * Refined Estimate, and made `SUM(allocation.value)` (§337) unusable. The value is now copied in
   * at allocation time and {@link source} says whether it was copied or typed.
   */
  value: string;
  /**
   * Whether {@link value} was COPIED from the Feature's top-down estimate or typed by a planner.
   *
   * §185-186. This is what lets the value be fixed: 0077 went nullable precisely because "a
   * defaulted 8 and a deliberate 8 were indistinguishable", and this label is that distinction
   * without a resolving read.
   */
  source: CapacityAllocationSource;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The four numbers every capacity row shows, plus the advisory warnings derived from them.
 *
 * `rollup` and `complete` follow the agile ALM tool's definition: a child story counts only when its
 * Project AND Release match the plan (Broadcom TechDocs, "View Capacity Plan Details").
 * The agile ALM tool's model treats Project as the team, so the per-team split translates here to
 * `work_items.team_id`. Without the release filter a Feature whose children span releases
 * would inflate every plan that touches it.
 *
 * `complete` uses COMPLETED_SCHEDULE_STATES while the Portfolio's Percent Done uses
 * ACCEPTED_SCHEDULE_STATES — the D1 distinction in `db/schema/enums.ts`. Do not unify them.
 */
export interface CapacityMetrics {
  /** Child points finished: COMPLETED_SCHEDULE_STATES, not ACCEPTED. */
  complete: number;
  /** Live child points, whatever their state. */
  rollup: number;
  /** Committed demand — SUM(allocation.value), read from the stored rows (§337). */
  estimated: number;
  /** Entered ceiling, or null when the planner has not entered one. Null ≠ 0. */
  capacity: number | null;
  warnings: CapacityWarning[];
}

/**
 * What the REPOSITORY returns: the row plus the raw numbers needed to resolve a tier.
 *
 * Tier resolution is deliberately NOT done here. `resolveEstimate` needs the Preliminary
 * Estimate mapped into the plan's unit, and that mapping lives in workspace settings which
 * only the service reads — a repository that guessed a preliminary of 0 would report tier
 * "none" for every Feature that has only a T-shirt size.
 */
export interface CapacityAllocationRow extends CapacityAllocation {
  itemKey: string;
  name: string;
  /** Top-down points forecast, already numeric. */
  refined: number | null;
  /** The T-shirt size; the service maps it through workspace settings. */
  preliminarySize: PreliminaryEstimateSize;
  rollup: number;
  complete: number;
  /** The Feature's LexoRank — the order the agile ALM tool's cutline accumulates down. */
  rank: string;
  /** The Feature's own workflow state — the agile ALM tool's `State` column on the nested table. */
  state: PortfolioItemState;
  /** The Feature's own rollup/complete across every team, for the item-level row. */
  itemRollup: number;
  itemComplete: number;
  /** The project the Feature itself belongs to. */
  itemProjectId: string;
  itemProjectName: string | null;
  /**
   * The team that OWNS the Feature outside the plan — the BA's `Team` column.
   *
   * "The Feature's current Portfolio Item Team ownership… this column is the Feature's original/current
   * Team, not the Plan assignment." Distinct from `primaryTeamId`, which is who owns it INSIDE this
   * plan: the two diverge as soon as a planner assigns the work elsewhere, and that divergence is the
   * thing the column exists to show.
   */
  itemTeamId: string | null;
  itemTeamName: string | null;
  /** Set when the Feature has been archived — an archived item is not planning demand. */
  itemArchivedAt: Date | null;
  /**
   * The Feature's OWN release, which is not always the plan's.
   *
   * Read by `Move To Another Plan`: a Feature committed to another release cannot be planned
   * against this one, so the dialog has to know before it offers the move.
   */
  itemReleaseId: string | null;
}

/** An allocated Feature as it appears under a team (or in the Unallocated bucket). */
export interface CapacityAllocationView extends CapacityAllocation {
  itemKey: string;
  name: string;
  /**
   * The Feature's LexoRank, so the nested table can show the same `Rank` column the plan's item
   * list does. The agile ALM tool's sub-table leads with it: a planner reading one team's Features still wants
   * to know where each sits in the plan's priority order.
   */
  rank: string;
  /** The Feature's own workflow state (the agile ALM tool's `State` column on the sub-table). */
  state: PortfolioItemState;
  /**
   * The Feature's OWN project, for the agile ALM tool's `Allocation` column: it prints `← from <project>` when
   * the Feature belongs somewhere other than the plan's project, and nothing when it is native.
   */
  projectId: string;
  projectName: string | null;
  /**
   * The Feature is ARCHIVED, so this row contributes nothing to the plan's numbers.
   *
   * The row is still returned rather than hidden: it is the only way a planner can see the stale
   * commitment and remove it. The BA says an archived item is not planning demand — which is about
   * the arithmetic, not about concealing the row.
   */
  archived: boolean;
  /**
   * Which of the three candidates this row's number came from — the agile ALM tool's `Estimate` tooltip ticks it.
   *
   * `allocated` whenever the row commits a positive value, else the Feature's Refined forecast, else
   * its Preliminary mapping, else `none`. Distinct from {@link CapacityAllocation.source}, which says
   * how the stored value was PRODUCED (typed, or copied from the Feature); this says which candidate it
   * corresponds to, which is the vocabulary the agile ALM tool's panel uses.
   */
  tier: EstimateTier;
  /**
   * The Feature's two TOP-DOWN candidates, for the Allocate dialog's read-only header (§175) and for
   * the row's Estimate tooltip.
   *
   * Still sent even though the row's own number is now stored: a planner deciding whether to leave
   * Estimate blank needs to see what blank would copy, and a `feature_estimate` row that no longer
   * matches the Feature's current forecast is worth being able to see — that gap IS the fixed
   * snapshot doing its job.
   */
  estimateBreakdown: {
    /** Top-down forecast on the Feature, in the plan's unit. */
    refined: number | null;
    /** T-shirt size mapped through workspace settings, in the plan's unit. */
    preliminary: number | null;
  };
  metrics: CapacityMetrics;
}

export interface CreateCapacityAllocationInput {
  portfolioItemId: string;
  /** Null parks the demand in the Unallocated bucket. */
  teamId?: string | null;
  /**
   * Points to commit to this team. OMIT to copy the Feature's top-down estimate (Refined, else the
   * Preliminary size mapping) into the row and label it `feature_estimate` — §185.
   */
  value?: number;
}

export interface UpdateCapacityAllocationInput {
  /**
   * `null` RE-COPIES the Feature's current top-down estimate into the row and relabels it
   * `feature_estimate` — the emptied-cell gesture, which used to clear the value to NULL and hand
   * the row back to a resolving read. `undefined` leaves both alone.
   */
  value?: number | null;
  /** Moving demand between teams, or into/out of the Unallocated bucket. */
  teamId?: string | null;
}
