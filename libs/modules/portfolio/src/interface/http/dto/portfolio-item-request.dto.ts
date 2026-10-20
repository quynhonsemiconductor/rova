import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { ISO_DATE, PageQuerySchema } from '@platform';
import {
  portfolioItemTypeEnum,
  portfolioItemStateEnum,
  preliminaryEstimateSizeEnum,
} from '../../../../../../../db/schema/enums';

// Derived from the DB enums rather than re-listed, so a schema change cannot leave the
// API accepting a value the column rejects (or vice versa).
const PORTFOLIO_ITEM_TYPES = portfolioItemTypeEnum.enumValues;
const PORTFOLIO_ITEM_STATES = portfolioItemStateEnum.enumValues;
const PRELIMINARY_SIZES = preliminaryEstimateSizeEnum.enumValues;

export const PortfolioListQuerySchema = PageQuerySchema.extend({
  /**
   * REQUIRED. The spec's Type selector has exactly two choices and no combined "All",
   * so there is no sensible default — a caller that omits it is asking the wrong
   * question rather than asking for everything.
   */
  type: z.enum(PORTFOLIO_ITEM_TYPES),
  projectId: z.string().uuid().optional(),
  teamId: z.string().uuid().optional(),
  search: z.string().max(255).trim().optional(),
  /** Archived items are hidden by default; the list has no Active/Archived selector. */
  includeArchived: z.coerce.boolean().optional(),
});
export class PortfolioListQueryDto extends createZodDto(PortfolioListQuerySchema) {}

/**
 * The Feature picker's query. `projectId` is REQUIRED, which is what lets the route be gated by
 * the guard rather than narrowed in the service — see the route's own docblock. §5.3:133 scopes
 * the selectable list to the Work Item's Project, so there is no "all projects" form to ask for.
 *
 * Not a `PageQuerySchema` extension: a project's active Features are a bounded set a picker reads
 * whole, and a paged picker silently omits options past the first page.
 */
export const PortfolioFeatureOptionsQuerySchema = z.object({
  projectId: z.string().uuid(),
});
export class PortfolioFeatureOptionsQueryDto extends createZodDto(
  PortfolioFeatureOptionsQuerySchema,
) {}

export const PortfolioChildrenQuerySchema = PageQuerySchema.extend({
  search: z.string().max(255).trim().optional(),
});
export class PortfolioChildrenQueryDto extends createZodDto(PortfolioChildrenQuerySchema) {}

// Exported so the enum-derived unions have one home.
export const PORTFOLIO_ENUMS = {
  types: PORTFOLIO_ITEM_TYPES,
  states: PORTFOLIO_ITEM_STATES,
  sizes: PRELIMINARY_SIZES,
} as const;

/**
 * Fields common to create and update.
 *
 * The three Feature-only ids are accepted on BOTH shapes rather than being split into
 * separate Epic/Feature schemas: the service rejects them for an Epic with a named
 * error, and duplicating the schema per type would mean two places to keep in step
 * with the DB CHECK.
 */
const portfolioWritableFields = {
  name: z.string().min(1).max(255).trim(),
  description: z.string().max(20000).nullable(),
  /** Rich text, same limit and nullability as a work item's (0080). */
  notes: z.string().max(20000).nullable(),
  releaseNotes: z.string().max(20000).nullable(),
  /** The BA's fourth rich-text block (SRS §5.1, §11.4) — same editor, same limit. */
  whatSuccessLooksLike: z.string().max(20000).nullable(),
  state: z.enum(PORTFOLIO_ITEM_STATES),
  preliminaryEstimate: z.enum(PRELIMINARY_SIZES),
  /**
   * Top-down forecasts. NON-NEGATIVE and never null — 0 IS the "not forecast" value.
   *
   * Real Rally shows these as 0 rather than blank and accepts a typed 0; Broadcom
   * documents no rule either way. So 0 is the absent state (migration 0081) and the tier
   * chain already reads it that way: "Refined Estimate = Feature.refinedEstimate |
   * refinedWorkItemCountEstimate -> if > 0" (Capacity Planning SRS), so 0 falls through to
   * the Preliminary Estimate mapping exactly as a blank used to.
   *
   * Not `.nullable()`: with a NOT NULL column there is nothing for null to mean, and
   * accepting it would just be a second spelling of 0. Send 0 to clear a forecast.
   */
  refinedEstimate: z.number().nonnegative(),
  refinedItemCountEstimate: z.number().int().nonnegative(),
  parentId: z.string().uuid().nullable(),
  teamId: z.string().uuid().nullable(),
  releaseId: z.string().uuid().nullable(),
  ownerId: z.string().uuid().nullable(),
  plannedStartDate: ISO_DATE.nullable(),
  plannedEndDate: ISO_DATE.nullable(),
  marketReleaseDate: ISO_DATE.nullable(),
};

export const CreatePortfolioItemSchema = z.object({
  projectId: z.string().uuid(),
  /** Immutable after create — an Epic cannot become a Feature (see the update schema). */
  type: z.enum(PORTFOLIO_ITEM_TYPES),
  name: portfolioWritableFields.name,
  description: portfolioWritableFields.description.optional(),
  notes: portfolioWritableFields.notes.optional(),
  releaseNotes: portfolioWritableFields.releaseNotes.optional(),
  whatSuccessLooksLike: portfolioWritableFields.whatSuccessLooksLike.optional(),
  state: portfolioWritableFields.state.optional(),
  preliminaryEstimate: portfolioWritableFields.preliminaryEstimate.optional(),
  refinedEstimate: portfolioWritableFields.refinedEstimate.optional(),
  refinedItemCountEstimate: portfolioWritableFields.refinedItemCountEstimate.optional(),
  parentId: portfolioWritableFields.parentId.optional(),
  teamId: portfolioWritableFields.teamId.optional(),
  releaseId: portfolioWritableFields.releaseId.optional(),
  ownerId: portfolioWritableFields.ownerId.optional(),
  plannedStartDate: portfolioWritableFields.plannedStartDate.optional(),
  plannedEndDate: portfolioWritableFields.plannedEndDate.optional(),
  marketReleaseDate: portfolioWritableFields.marketReleaseDate.optional(),
});
export class CreatePortfolioItemDto extends createZodDto(CreatePortfolioItemSchema) {}

/**
 * Every field optional: omitted means "leave alone", explicit `null` means "clear".
 *
 * `type` is absent deliberately: changing it would have to re-key the item, move its
 * child links and re-rank it into the other scope. Rally does not offer that.
 *
 * `projectId` IS ABSENT — a record's Project is chosen once, at creation, and never again
 * (`P5-PI-003`, BA DEV Handoff retest 2026-08-17, Confirmed Fail). `WID-FR-017` and the
 * report's own rule 4 say the move "is not supported"; §3.1's inline-edit line says
 * "Project is read-only for both types", and AC5 forbids changing it from detail or inline
 * edit. So the contract no longer advertises what the service refuses, the same shape as
 * `CreateTaskSchema` dropping `iterationId` for `TASK_ITERATION_DERIVED`.
 *
 * This field was writable on the opposite reading, and the note here argued for it from
 * Broadcom's project-hierarchy guide ("Rally recommends you update the project field to
 * reflect which team is handling the work"). Recorded rather than deleted: real Rally DOES
 * offer the move, so this is a declared divergence and the next person to read those docs
 * will reach for it again. `applyProjectMove` and the three cross-project references it
 * reconciled (Team reset, Release clear, cross-project Epic unlink) are gone with it.
 */
export const UpdatePortfolioItemSchema = z
  .object({
    name: portfolioWritableFields.name.optional(),
    description: portfolioWritableFields.description.optional(),
    notes: portfolioWritableFields.notes.optional(),
    releaseNotes: portfolioWritableFields.releaseNotes.optional(),
    whatSuccessLooksLike: portfolioWritableFields.whatSuccessLooksLike.optional(),
    state: portfolioWritableFields.state.optional(),
    preliminaryEstimate: portfolioWritableFields.preliminaryEstimate.optional(),
    refinedEstimate: portfolioWritableFields.refinedEstimate.optional(),
    refinedItemCountEstimate: portfolioWritableFields.refinedItemCountEstimate.optional(),
    parentId: portfolioWritableFields.parentId.optional(),
    teamId: portfolioWritableFields.teamId.optional(),
    releaseId: portfolioWritableFields.releaseId.optional(),
    ownerId: portfolioWritableFields.ownerId.optional(),
    /**
     * The COMPLETE Milestone set. Omit to leave assignments alone; `[]` clears them.
     *
     * A whole-set replace rather than add/remove verbs, because the rail's multi-select
     * always knows the full selection — two verbs would let the client and the row drift
     * apart when a checkbox click is lost. The service refuses any Milestone outside the
     * item's Project (`MILESTONE_PROJECT_MISMATCH`), per SRS §5.1.
     */
    milestoneIds: z.array(z.string().uuid()).optional(),
    plannedStartDate: portfolioWritableFields.plannedStartDate.optional(),
    plannedEndDate: portfolioWritableFields.plannedEndDate.optional(),
    marketReleaseDate: portfolioWritableFields.marketReleaseDate.optional(),
  })
  // An empty body would otherwise bump `updated_at` and return 200 having changed
  // nothing, which reads as a successful save in the UI.
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' });
export class UpdatePortfolioItemDto extends createZodDto(UpdatePortfolioItemSchema) {}

/**
 * Move an item between two neighbours.
 *
 * Both are optional because either can be a list edge, but the service rejects a body
 * with NEITHER: "between nothing and nothing" has no meaning in a rank order, and
 * `between(null, null)` would silently return a mid-range rank unrelated to the list.
 */
export const RankPortfolioItemSchema = z.object({
  /** The item immediately ABOVE the drop position (lower rank). Null at the top. */
  beforeId: z.string().uuid().nullable().optional(),
  /** The item immediately BELOW the drop position (higher rank). Null at the bottom. */
  afterId: z.string().uuid().nullable().optional(),
});
export class RankPortfolioItemDto extends createZodDto(RankPortfolioItemSchema) {}
