import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import {
  capacityPlanStatusEnum,
  capacityPlanUnitEnum,
  portfolioItemStateEnum,
} from '../../../../../../../db/schema/enums';

const STATUSES = capacityPlanStatusEnum.enumValues;
const UNITS = capacityPlanUnitEnum.enumValues;
const PORTFOLIO_ITEM_STATES = portfolioItemStateEnum.enumValues;

/**
 * The four numbers every capacity row shows, plus advisory warnings.
 *
 * `complete` uses COMPLETED_SCHEDULE_STATES while the Portfolio's Percent Done uses
 * ACCEPTED_SCHEDULE_STATES — the deliberate D1 distinction. `capacity` is null on a Feature
 * row (it has none of its own) and on a team that has not entered one.
 *
 * Rollup/Complete follow `P5-CAP-AC-016`: EVERY linked Story/Defect counts, with no Project or
 * Release qualifier (the BA reversed Rally's qualifier on 2026-08-17 — see `capacity-metrics.sql.ts`).
 * A team row's numbers are the SUM of its own allocation rows, so the tabs reconcile by construction.
 */
/**
 * Every warning code, in one place: the team metrics and the Features tab's item rows report from the
 * SAME rule function, so a second literal list would be free to drift from it.
 */
const CapacityWarningEnum = z.enum([
  'feature_missing_estimate',
  'team_missing_capacity',
  'rollup_exceeds_estimated',
  'rollup_exceeds_capacity',
  'estimated_exceeds_capacity',
]);

const CapacityMetricsSchema = z.object({
  complete: z.number(),
  rollup: z.number(),
  estimated: z.number(),
  capacity: z.number().nullable(),
  // Ordered CAUSE-FIRST, and the client renders them in the order it receives: a missing
  // estimate or a missing capacity is why the comparison rules fired, so leading with the
  // consequence would send a planner to fix the wrong thing.
  warnings: z.array(CapacityWarningEnum),
});

const CapacityAllocationSchema = z.object({
  id: z.string().uuid(),
  portfolioItemId: z.string().uuid(),
  itemKey: z.string(),
  name: z.string(),
  /** Null = the Unallocated bucket. */
  teamId: z.string().uuid().nullable(),
  /**
   * This team is the Feature's PRIMARY assignment on this plan — Rally's Planned Team Assignment.
   *
   * At most one per Feature, and never true for an Unallocated row. The other allocations are
   * contributors: Rally assigns the item to one team, then allocates points to the rest.
   */
  isPrimary: z.boolean(),
  value: z
    .number()
    .describe('The FIXED committed value on this row (SRS §11) — never resolved on read'),
  source: z
    .enum(['feature_estimate', 'manual'])
    .describe(
      "Where `value` came from: copied from the Feature's top-down estimate (§185) or typed by a planner (§186)",
    ),
  tier: z
    .enum(['allocated', 'refined', 'preliminary', 'none'])
    .describe(
      "Which of Rally's three Estimate candidates this row's number corresponds to — the tooltip ticks it and strikes the other two",
    ),
  rank: z.string().describe("The Feature's LexoRank — the nested table shows the plan's Rank too"),
  state: z.enum(PORTFOLIO_ITEM_STATES).describe("The Feature's own workflow state"),
  projectId: z.string().uuid(),
  projectName: z
    .string()
    .nullable()
    .describe(
      "The Feature's own project — Rally prints `← from <project>` when it is not the plan's",
    ),
  archived: z
    .boolean()
    .describe(
      'The Feature is archived: this row contributes nothing to any total, and is returned only so a planner can see the stale commitment and remove it',
    ),
  estimateBreakdown: z
    .object({
      refined: z.number().nullable(),
      preliminary: z.number().nullable(),
    })
    .describe(
      "The Feature's two top-down candidates: what a blank Estimate would copy, and what a `feature_estimate` row can be compared against once the forecast has moved",
    ),
  metrics: CapacityMetricsSchema,
});

const CapacityPlanTeamSchema = z.object({
  id: z.string().uuid(),
  teamId: z.string().uuid(),
  teamName: z.string().nullable(),
  /**
   * `null` means the planner has not entered a capacity yet — NOT zero capacity. The grid
   * renders blank, and no warning rule may treat it as a real ceiling.
   */
  capacity: z.number().nullable(),
  metrics: CapacityMetricsSchema,
});

/**
 * One Feature on the plan — Rally's Items tab row.
 *
 * A Feature shared between teams appears ONCE here with its allocations summed, and is listed
 * per team in `allocations`. Rally's Items tab does the same: one row, nested allocation rows.
 */
const CapacityPlanItemSchema = z.object({
  portfolioItemId: z.string().uuid(),
  itemKey: z.string(),
  name: z.string(),
  rank: z.string().describe('LexoRank — the order the cutline accumulates down'),
  projectId: z
    .string()
    .uuid()
    .describe(
      "The Feature's OWN project. No column shows it — the eligibility rules and `Move To Another Plan` are expressed in it",
    ),
  projectName: z.string().nullable(),
  teamId: z
    .string()
    .uuid()
    .nullable()
    .describe(
      "The team that OWNS the Feature — the BA's `Team` column. Not `primaryTeamId`, which is ownership INSIDE this plan",
    ),
  teamName: z.string().nullable(),
  releaseId: z
    .string()
    .uuid()
    .nullable()
    .describe(
      "The Feature's OWN release — `Move To Another Plan` reads it to decide whether the move must also write the Release",
    ),
  estimated: z.number().describe('Committed demand summed over this Feature’s allocations'),
  rollup: z.number().describe('The Feature’s OWN rollup, across every team'),
  complete: z.number(),
  archived: z
    .boolean()
    .describe(
      'The Feature is archived, so it charges 0 here as it already does on the team grid — the two tabs must not disagree about the same Feature',
    ),
  tier: z.enum(['allocated', 'refined', 'preliminary', 'none']),
  warnings: z
    .array(CapacityWarningEnum)
    .describe(
      'The Feature-level rules the BA specifies for this tab: rollup exceeds estimated, and no estimate at all. A Feature has no capacity of its own, so the capacity comparisons cannot fire here',
    ),
  estimateBreakdown: z
    .object({
      allocated: z
        .number()
        .nullable()
        .describe('Total Allocated — SUM over TEAM-ASSIGNED rows; null when the Feature has none'),
      refined: z.number().nullable(),
      preliminary: z.number().nullable(),
    })
    .describe("All three candidates behind AC-014's Feature Estimated, for the tier tooltip"),
  teamIds: z.array(z.string().uuid()),
  primaryTeamId: z
    .string()
    .uuid()
    .nullable()
    .describe("Rally's Planned Team Assignment — the team that owns this Feature in the plan"),
  unallocated: z.boolean().describe('Any allocation has no team — Rally’s unassigned warning'),
});

export const CapacityPlanSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string().nullable(),
  releaseId: z.string().uuid(),
  releaseName: z.string().nullable(),
  planKey: z.string().nullable().describe('CP-<n>, per project — the list\u2019s ID column'),
  name: z.string(),
  status: z.enum(STATUSES),
  unit: z.enum(UNITS).describe('Fixed at creation — every number on the plan uses it'),
  plannedStartDate: z.string().nullable().describe('YYYY-MM-DD'),
  plannedEndDate: z.string().nullable().describe('YYYY-MM-DD'),
  // `z.date()` cannot be converted by zod's JSON-Schema emitter, which breaks Swagger
  // generation and therefore app boot — these are ISO strings, as everywhere else.
  publishedAt: z.string().datetime().nullable(),
  publishedBy: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  teams: z.array(CapacityPlanTeamSchema),
  /** Sum of the capacities ENTERED so far; null when none has been. */
  totalCapacity: z.number().nullable(),
  items: z.array(CapacityPlanItemSchema).describe('One row per Feature, in RANK order'),
  /**
   * The Capacity Cutline: the index of the last ITEM that FITS inside the plan's total capacity.
   *
   * Rally's rule, from the capacity plan's Items tab: "Items above the cutline fit within the defined
   * plan capacity. Items below the line exceed the capacity of the plan." A declared divergence from SRS
   * §189, which puts the overflowing Feature above the line — see `computeCutlineIndex`.
   *
   * Plan-wide and on the item list, which is where Rally draws it. An index rather than a per-row
   * boolean, because the line sits BETWEEN two rows and a per-row flag would let a client render a
   * "fits" row below a "does not fit" one.
   */
  itemCutlineIndex: z
    .number()
    .int()
    .nullable()
    .describe('-1 = the first item already exceeds capacity; null = no capacity entered'),
  allocations: z.array(CapacityAllocationSchema),
  /**
   * Demand parked without a team.
   *
   * Reported separately and deliberately excluded from every team's Estimated: an
   * unallocated placeholder must not outrank a Refined or Preliminary forecast.
   */
  unallocated: z.number(),
  /**
   * The advisory warnings for the PLAN as a whole, from the same rule function every row uses.
   *
   * The plan-level bars — the summary strip and the Breakdown overlay — showed totals with no
   * warnings at all, so a plan whose combined demand exceeded its combined capacity read as clean
   * while the rows beneath it flagged. Served rather than derived client-side because the rules live
   * in one place (`computeCapacityWarnings`) and the frontend has no copy of them; it only maps codes
   * to sentences.
   *
   * Evaluated over EVERY team, like `totalCapacity` and `itemCutlineIndex`, even for a reader whose
   * team rows are narrowed: these are facts about the plan, and a reader shown the plan's totals is
   * entitled to know whether they are in trouble.
   */
  warnings: z.array(CapacityWarningEnum).describe("The plan's own advisory warnings"),
});
export class CapacityPlanResponseDto extends createZodDto(CapacityPlanSchema) {}

/**
 * A capacity forecast for one team.
 *
 * Three numbers rather than one, because that is the answer: Rally reports the amount
 * delivered 85% of the time (Min), 50% (Median) and 15% (Max), and a planner choosing a
 * commitment needs the spread. A single number would hide whether the team is steady or
 * erratic — the whole reason the forecast samples history instead of averaging it.
 *
 * `insufficientData` is a REPORT, not an error: a new team with no finished iterations is a
 * normal state, and the dialog explains it rather than failing.
 */
const ForecastSchema = z.object({
  min: z.number().describe('Delivered 85% of the time — the conservative commitment'),
  median: z.number().describe('Delivered 50% of the time'),
  max: z.number().describe('Delivered 15% of the time — optimistic, not a target'),
  iterationsModelled: z.number().int().describe("Plan window ÷ the team's average cadence"),
  samplesUsed: z.number().int().describe('Finished iterations that fed the sampler'),
  historyDays: z.number().int().describe('Calendar days of history behind the forecast'),
  basis: z
    .enum(['history', 'supplied'])
    .describe('Whether the velocity was sampled from history or supplied by the planner'),
  insufficientData: z
    .enum(['no_history', 'too_little_history', 'no_window', 'no_cadence'])
    .nullable(),
});
export class CapacityForecastResponseDto extends createZodDto(ForecastSchema) {}

/**
 * The result of a publish.
 *
 * `skipped` is the whole reason this is not just the plan: a publish that wrote 3 of 5
 * Features succeeded, and the planner still has to know which two did not take the Release
 * field and why. Throwing would roll back a publish that is otherwise correct.
 *
 * At most ONE entry per `portfolioItemId`, and `featuresUpdated` counts unique Features too: a Feature
 * split across two teams has two allocation rows and one publish decision (`P5-CP-035`).
 */
const PublishResultSchema = z.object({
  plan: CapacityPlanSchema,
  fieldsUpdated: z.boolean().describe('False for Rally\'s "Publish Without Updating Fields"'),
  featuresUpdated: z.number().int().describe('Features whose planned dates were written'),
  skipped: z.array(
    z.object({
      portfolioItemId: z.string().uuid(),
      itemKey: z.string(),
      reason: z
        .enum(['unallocated', 'no_window', 'release_span_mismatch', 'archived', 'other_release'])
        .describe(
          'unallocated: no team, so no plan to inherit. no_window: the plan states no planned start/end, so nothing was written — a publish does not write emptiness, and with no window AC-019 refuses the Release field too. release_span_mismatch: the plan window does not EXACTLY match the release start and end dates, so the dates are written but not the Release (equality, not containment — a plan narrower than its release also lands here). archived: the Feature is not actionable demand. other_release: the Feature already belongs to a different release (§226 allows the allocation; publish must not move it).',
        ),
    }),
  ),
});
export class PublishResultResponseDto extends createZodDto(PublishResultSchema) {}

/**
 * The result of a move.
 *
 * The SOURCE plan plus what happened elsewhere: the planner stays on this page, but the move may
 * have parked demand on the target, moved the Feature's Release, and unpublished a published target.
 * None of that is visible in a refreshed source grid.
 */
const MoveItemResultSchema = z.object({
  plan: CapacityPlanSchema,
  targetPlanId: z.string().uuid(),
  targetPlanKey: z.string().nullable(),
  carried: z.number().int().describe('Allocations recreated on the target against the same team'),
  parked: z
    .number()
    .int()
    .describe('1 when teams missing from the target were collapsed into one unassigned row'),
  releaseUpdated: z.boolean().describe("Rally's `Update the Release to match the selected plan`"),
  targetUnpublished: z.boolean().describe('The move reverted a published target to draft'),
  targetRepublished: z.boolean().describe('`Move and Republish the Plan` published it again'),
});
export class MoveItemResultResponseDto extends createZodDto(MoveItemResultSchema) {}

/**
 * The result of a revert.
 *
 * `fieldsRolledBack` is always false and is returned ANYWAY: Rally makes "no changes to the
 * field values in the portfolio items" when a plan reverts, so the Release and dates a publish
 * wrote stay on the Features. "Revert" reads like an undo, and this is the field that says it
 * is not one.
 */
const RevertResultSchema = z.object({
  plan: CapacityPlanSchema,
  fieldsRolledBack: z.literal(false),
});
export class RevertResultResponseDto extends createZodDto(RevertResultSchema) {}
