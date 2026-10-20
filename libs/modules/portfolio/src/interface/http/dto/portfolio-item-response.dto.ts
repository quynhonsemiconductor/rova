import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  portfolioItemTypeEnum,
  portfolioItemStateEnum,
  preliminaryEstimateSizeEnum,
  workItemPriorityEnum,
} from '../../../../../../../db/schema/enums';

const TYPES = portfolioItemTypeEnum.enumValues;
const STATES = portfolioItemStateEnum.enumValues;
const SIZES = preliminaryEstimateSizeEnum.enumValues;
const PRIORITIES = workItemPriorityEnum.enumValues;

/**
 * The four read-only indicators.
 *
 * Each is `null` when its denominator is zero, NOT 0. "No work linked" and "none of the
 * work is done" both render as an empty meter, but only the first is a data-entry gap —
 * the client needs to tell them apart to warn about missing estimates the way Rally's
 * hover callout does.
 */
const ProgressSchema = z.object({
  percentDoneByPlanEstimate: z
    .number()
    .nullable()
    .describe('Accepted points / all linked points. Null when nothing is linked.'),
  percentDoneByCount: z
    .number()
    .nullable()
    .describe('Accepted item count / all linked count. Null when nothing is linked.'),
  estimatedProgressByPoints: z
    .number()
    .nullable()
    .describe('Accepted points / refined-or-preliminary points forecast. May exceed 1.'),
  estimatedProgressByCount: z
    .number()
    .nullable()
    .describe('Accepted count / refined-or-preliminary count forecast. May exceed 1.'),
});

/**
 * The RESOLVED top-down estimate per unit, and which tier produced it.
 *
 * `Refined > 0` → `refined`, else the workspace's Preliminary size mapping → `preliminary`, else 0 and
 * `none`. The same chain the progress ratios divide by, and the same one a capacity plan copies from
 * for a blank Estimate — served so no client has to re-derive it. The Epic Children tab did not, and
 * rendered `refinedEstimate` raw: that column is NOT NULL DEFAULT 0 where 0 means "not forecast", so
 * a Feature sized only by a T-shirt reported 0 in the column and in its totals row.
 *
 * Both units travel because the portfolio shows both, and no tier is `allocated`: an allocation belongs
 * to a capacity plan, not to the item.
 */
const EstimateSchema = z.object({
  points: z.object({
    value: z.number(),
    tier: z.enum(['allocated', 'refined', 'preliminary', 'none']),
  }),
  count: z.object({
    value: z.number(),
    tier: z.enum(['allocated', 'refined', 'preliminary', 'none']),
  }),
});

/** Raw child aggregates, so a client can show the underlying numbers beside the bars. */
const RollupSchema = z.object({
  rollupPoints: z.number(),
  rollupCount: z.number(),
  acceptedPoints: z.number().describe('ACCEPTED_SCHEDULE_STATES: accepted, release'),
  acceptedCount: z.number(),
  completedPoints: z
    .number()
    .describe(
      'COMPLETED_SCHEDULE_STATES: completed, accepted, release — capacity, not Percent Done',
    ),
  completedCount: z.number(),
});

/**
 * Rally's portfolio-item status colour, computed against the planned window.
 *
 * `indeterminate` says WHY no verdict was possible, which Rally surfaces as a
 * "missing estimates or dates" hover note rather than a misleading green.
 */
const HealthSchema = z.object({
  state: z.enum(['complete', 'on_track', 'at_risk', 'late', 'not_started']),
  percentDone: z.number().nullable(),
  percentElapsed: z.number().nullable(),
  indeterminate: z.enum(['no_dates', 'no_work']).nullable(),
});

const PortfolioItemSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string().nullable().describe('Resolved server-side — this list is cross-project'),
  itemKey: z.string().describe('EP-101 or FE-318'),
  type: z.enum(TYPES),
  name: z.string(),
  description: z.string().nullable(),
  notes: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  whatSuccessLooksLike: z.string().nullable(),
  state: z.enum(STATES),
  preliminaryEstimate: z.enum(SIZES),
  refinedEstimate: z
    .number()
    .describe('Top-down points forecast. 0 means not forecast — see migration 0081.'),
  refinedItemCountEstimate: z
    .number()
    .describe('Top-down child-count forecast. 0 means not forecast.'),
  parentId: z.string().uuid().nullable().describe('Feature → Epic. Always null for an Epic.'),
  parentKey: z.string().nullable(),
  teamId: z.string().uuid().nullable().describe('Feature only'),
  teamName: z.string().nullable(),
  releaseId: z.string().uuid().nullable().describe('Feature only'),
  releaseName: z.string().nullable(),
  ownerId: z.string().uuid().nullable(),
  ownerName: z.string().nullable(),
  plannedStartDate: z.string().nullable().describe('YYYY-MM-DD'),
  plannedEndDate: z.string().nullable().describe('YYYY-MM-DD'),
  marketReleaseDate: z.string().nullable().describe('YYYY-MM-DD'),
  rank: z.string(),
  // ISO strings, not z.date(): zod's toJSONSchema cannot represent a Date, so a
  // z.date() here makes Swagger generation throw "Date cannot be represented in JSON
  // Schema" and the whole app fails to boot. Matches every other response DTO.
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  childFeatureCount: z.number().describe('Active child Features. Epic only; 0 for a Feature.'),
  rollup: RollupSchema,
  progress: ProgressSchema,
  health: HealthSchema,
  estimate: EstimateSchema,
});
export class PortfolioItemResponseDto extends createZodDto(PortfolioItemSchema) {}

/**
 * "Total Accepted Children" — the detail page's panel, which Rally shows where this app
 * previously listed four bare progress meters.
 *
 * Both metrics travel together rather than the client picking one, because the panel's unit
 * toggle switches between them without a refetch. `total` is the item's own rollup, so it is
 * the same pair of numbers Percent Done is computed from.
 */
const AcceptedChildrenGroupSchema = z.object({
  type: z.enum(['story', 'defect']),
  points: z.number(),
  count: z.number(),
  acceptedPoints: z.number(),
  acceptedCount: z.number(),
});

const AcceptedChildrenSchema = z.object({
  total: z.object({
    points: z.number(),
    count: z.number(),
    acceptedPoints: z.number(),
    acceptedCount: z.number(),
  }),
  byType: z
    .array(AcceptedChildrenGroupSchema)
    .describe('Always one entry per child type, zero-filled when there are none.'),
});

/** The detail response: the grid row plus the accepted-children breakdown. */
const PortfolioItemDetailSchema = PortfolioItemSchema.extend({
  acceptedChildren: AcceptedChildrenSchema,
  milestones: z
    .array(z.object({ id: z.string().uuid(), name: z.string() }))
    .describe('Assigned Milestones, name-ordered. Detail only — the grid does not show them.'),
});
export class PortfolioItemDetailResponseDto extends createZodDto(PortfolioItemDetailSchema) {}

/** A linked Story/Defect on the Children tab. */
const PortfolioChildSchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string(),
  type: z.enum(['story', 'defect']),
  title: z.string(),
  scheduleState: z.string(),
  storyPoints: z.number().nullable(),
  priority: z.enum(PRIORITIES).describe("The BA's `Priority` column on the Children tab"),
  iterationId: z.string().uuid().nullable(),
  iterationName: z.string().nullable().describe("The BA's `Iteration` column"),
  /**
   * The stored LexoRank. Already the query's ORDER BY, so the rows arrive in it — exposing it lets
   * the Children tab drag-to-rank through `PATCH /v1/work-items/{id}/rank`, the same endpoint the
   * Backlog uses. Without it the client received an ordered list it could not reorder.
   */
  rank: z.string(),
  /** IDs alongside the names, so the disclosed child rows can edit in place. */
  projectId: z.string().uuid(),
  releaseId: z.string().uuid().nullable(),
  teamId: z.string().uuid().nullable(),
  assigneeId: z.string().uuid().nullable(),
  releaseName: z.string().nullable(),
  projectName: z.string().nullable(),
  teamName: z.string().nullable(),
  ownerName: z.string().nullable(),
});
export class PortfolioChildResponseDto extends createZodDto(PortfolioChildSchema) {}

/**
 * The Feature REFERENCE feed's row. A separate schema, not a `.pick()` of
 * {@link PortfolioItemSchema} — a field added to the record shape must not silently join the
 * feed a wider audience reads, which is the whole point of splitting the two.
 */
export const PortfolioFeatureOptionSchema = z.object({
  id: z.string().uuid(),
  itemKey: z.string().describe('FE-<n>, unique across the workspace'),
  name: z.string(),
  projectId: z.string().uuid().describe('Always the requested project; echoed for binding'),
});
export class PortfolioFeatureOptionResponseDto extends createZodDto(PortfolioFeatureOptionSchema) {}
