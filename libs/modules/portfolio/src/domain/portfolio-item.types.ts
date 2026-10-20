import type {
  PortfolioItemState,
  PortfolioItemType,
  PreliminaryEstimateSize,
} from '../../../../../db/schema/enums';

/**
 * A portfolio item — an Epic or a Feature.
 *
 * ONE type for both, mirroring the single `work.portfolio_items` table. The BA spec
 * gives them one list, one state enum, one create template and one archive rule; the
 * differences are three nullable fields and which rollup applies. The DB CHECK
 * constraints (`ck_portfolio_epic_shape`) are what hold the two shapes apart:
 *
 *   epic    → parentId, teamId, releaseId are ALL null
 *   feature → may carry parentId (its Epic), teamId and releaseId
 *
 * Numeric DB columns arrive as STRINGS (Drizzle preserves numeric precision), so
 * `refinedEstimate` is a string while `refinedItemCountEstimate` is an integer.
 * Converting happens at the DTO boundary, not here.
 */
export interface PortfolioItem {
  id: string;
  workspaceId: string;
  projectId: string;
  /**
   * `EP-101` / `FE-318`.
   *
   * WORKSPACE-wide sequence per type, not per project — `uq_portfolio_item_key` is
   * on (workspace_id, item_key), so a per-project sequence would make two projects
   * both mint `EP-1` and collide. Matches Rally, where a FormattedID is unique
   * across the workspace, and the work-item counter, which is workspace-scoped too.
   * (Releases differ deliberately: `uq_releases_key` is per-project.)
   */
  itemKey: string;
  type: PortfolioItemType;
  name: string;
  description: string | null;
  notes: string | null;
  releaseNotes: string | null;
  /** The BA's fourth rich-text block on Feature and Epic detail (SRS §5.1, §11.4). */
  whatSuccessLooksLike: string | null;
  state: PortfolioItemState;
  preliminaryEstimate: PreliminaryEstimateSize;
  /** Top-down points forecast. Feeds Estimated Progress only, never Percent Done. */
  refinedEstimate: string;
  /** Top-down child-count forecast. */
  refinedItemCountEstimate: number;
  /** Feature → Epic. Always null for an Epic. */
  parentId: string | null;
  /** Feature only. */
  teamId: string | null;
  /** Feature only — Rally allows Release on the lowest portfolio level only. */
  releaseId: string | null;
  ownerId: string | null;
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  marketReleaseDate: string | null;
  rank: string;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregated child facts for one portfolio item, produced by ONE SQL query per list
 * page — never per row.
 *
 * Note the two different "done" definitions, both deliberate and both already
 * modelled in `db/schema/enums.ts`:
 *   • `accepted*` uses ACCEPTED_SCHEDULE_STATES  (accepted, release)
 *   • `completed*` uses COMPLETED_SCHEDULE_STATES (completed, accepted, release)
 * Portfolio Percent Done reports what the business has SIGNED OFF; a capacity plan's
 * Complete reports what the team has FINISHED. Do not collapse them.
 */
export interface PortfolioRollupRow {
  portfolioItemId: string;
  rollupPoints: number;
  rollupCount: number;
  acceptedPoints: number;
  acceptedCount: number;
  completedPoints: number;
  completedCount: number;
}

/** A portfolio item plus everything the list and detail surfaces render. */
export interface PortfolioItemView extends PortfolioItem {
  ownerName: string | null;
  teamName: string | null;
  releaseName: string | null;
  /**
   * Resolved here rather than on the client because this list is CROSS-project —
   * the grid carries a Project column, so the name is row data, not page context.
   */
  projectName: string | null;
  /** Parent Epic's key, for the Feature row's context. Null for an Epic. */
  parentKey: string | null;
  rollup: PortfolioRollupRow;
  /** Count of active child Features. Epic only; 0 for a Feature. */
  childFeatureCount: number;
}

/**
 * The FEATURE REFERENCE feed: what a picker needs to name a Feature, and nothing else.
 *
 * A separate type rather than a `Pick<PortfolioItemView, …>`, for the same reason
 * `ReleaseOption` and `MilestoneOption` are separate: a field added to the record shape must
 * not silently join the feed a wider audience reads. There is no rollup, no owner, no
 * estimate and no team here — those belong to the Portfolio SURFACE, which
 * `P5-PI-FR-017` hides from an Editor.
 */
export interface PortfolioFeatureOption {
  id: string;
  itemKey: string;
  name: string;
  /**
   * Echoed back so a client cannot bind options from one project to an item in another. The
   * feed is single-project by contract (P5-PI-FR-023, §5.3:133), unlike the grid, which is
   * cross-project and carries a Project column.
   */
  projectId: string;
}

/** What a CALLER may ask for. Deliberately carries no authorization field. */
export interface PortfolioListRequest {
  /** Epic or Feature — the spec's Type selector has no combined "All". */
  type: PortfolioItemType;
  projectId?: string;
  teamId?: string;
  search?: string;
  /** Archived items are hidden by default; the list has no Active/Archived selector. */
  includeArchived?: boolean;
}

/**
 * What the REPOSITORY executes: a caller's request plus the authorization filter the
 * service resolves.
 *
 * Split from `PortfolioListRequest` on purpose. `readableProjectIds` is required and
 * non-optional here, so a caller cannot construct a repository filter without deciding
 * it, and a controller cannot supply its own. Making it optional would mean a forgotten
 * field silently lists every project.
 *
 * `null` = unrestricted (a workspace-wide grant). `[]` = nothing readable; the service
 * short-circuits that case before reaching SQL.
 */
export interface PortfolioListFilter extends PortfolioListRequest {
  readableProjectIds: string[] | null;
}

/**
 * The rank scope for a portfolio item: (workspace, type).
 *
 * NOT (project, parent) as work items use. The Portfolio list is cross-project and
 * flat per type — `ix_portfolio_list` is on (workspace_id, type, archived_at, rank)
 * and the list orders by rank alone — so Epics are ranked among Epics and Features
 * among Features, regardless of project or parent Epic. Ranking per parent instead
 * would leave the flat list with interleaved, non-comparable ranks, and the capacity
 * cutline (which reads rank order) would be meaningless.
 */
export interface PortfolioRankScope {
  workspaceId: string;
  type: PortfolioItemType;
}

/** Fields accepted when creating a portfolio item. Key and rank are server-assigned. */
export interface CreatePortfolioItemInput {
  workspaceId: string;
  projectId: string;
  type: PortfolioItemType;
  name: string;
  description?: string | null;
  notes?: string | null;
  releaseNotes?: string | null;
  whatSuccessLooksLike?: string | null;
  state?: PortfolioItemState;
  preliminaryEstimate?: PreliminaryEstimateSize;
  refinedEstimate?: string;
  refinedItemCountEstimate?: number;
  /** Feature only — an Epic must leave these null (`ck_portfolio_epic_shape`). */
  parentId?: string | null;
  teamId?: string | null;
  releaseId?: string | null;
  ownerId?: string | null;
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  marketReleaseDate?: string | null;
}

/**
 * Fields a caller may change. Every one is optional, and `undefined` means "leave
 * alone" while `null` means "clear" — so the repository must distinguish the two
 * rather than spreading the object.
 *
 * `type` is absent on purpose: changing an Epic into a Feature (or back) would have to
 * move child links, re-key the item and re-rank it into another scope. Rally does not
 * offer it either.
 */
export interface UpdatePortfolioItemInput {
  name?: string;
  description?: string | null;
  notes?: string | null;
  releaseNotes?: string | null;
  whatSuccessLooksLike?: string | null;
  /**
   * Move the item to another project. Not nullable — an item always has one.
   *
   * Setting it is not a plain column write: `project_id` is the scope for `team_id`,
   * `release_id` and `parent_id`, so the service reconciles those (see
   * `applyProjectMove`) before the update lands.
   */
  projectId?: string;
  state?: PortfolioItemState;
  preliminaryEstimate?: PreliminaryEstimateSize;
  refinedEstimate?: string;
  refinedItemCountEstimate?: number;
  parentId?: string | null;
  teamId?: string | null;
  releaseId?: string | null;
  ownerId?: string | null;
  /**
   * The item's Milestones, as a COMPLETE set — omit to leave them alone, send `[]` to clear.
   *
   * Not a column: these live in `milestone_artifacts`, so the service strips this out of the
   * patch before the repository writes columns, and calls `setMilestones` separately.
   */
  milestoneIds?: string[];
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  marketReleaseDate?: string | null;
}
