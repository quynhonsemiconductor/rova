import type {
  WorkItemType,
  WorkItemPriority,
  WorkItemScheduleState,
} from '../../../../../db/schema/enums';
export type { WorkItemType, WorkItemPriority, WorkItemScheduleState };

/**
 * Sentinel value for {@link WorkItemFilters.assigneeId} that matches work items
 * with no assignee (owner IS NULL). Not a UUID, so it never collides with a
 * real user id.
 */
export const UNASSIGNED_FILTER = 'unassigned';

export interface WorkItem {
  id: string;
  workspaceId: string;
  projectId: string;
  itemKey: string;
  type: WorkItemType;
  title: string;
  description: string | null;
  statusId: string;
  scheduleState: WorkItemScheduleState;
  // BR-WI-01 — always mirrors scheduleState (enforced in the repository).
  flowState: WorkItemScheduleState;
  priority: WorkItemPriority;
  assigneeId: string | null;
  /**
   * Owner display name, joined by the GRID queries (`listByProject`, `listBacklog`,
   * `listTasksByParent`) and undefined elsewhere.
   *
   * Optional because it is a read-model convenience, not a column: the write paths neither accept nor
   * return it. It exists because every picker feed narrows — a Workspace Admin holds no
   * `project_members` row (§2.1) and is excluded from the project feed by AC-16 — so a client that
   * resolves the name from a feed cannot name them, and an absent name looks exactly like an unset
   * field. See `ownerNameJoins`.
   */
  assigneeName?: string | null;
  /** As `assigneeName`, for the Dev Owner column. */
  devOwnerName?: string | null;
  reporterId: string | null;
  parentId: string | null;
  teamId: string | null;
  iterationId: string | null;
  releaseId: string | null;
  /**
   * The Feature this Story/Defect rolls up to — Rally's portfolio link.
   *
   * Every portfolio rollup and capacity metric aggregates by this column, and until now nothing
   * but the demo seed could set it: the field was readable through the Iteration Status read model
   * and writable nowhere, so real rollups were only ever demonstrable on seeded data.
   *
   * Always null for a Task: a Task belongs to its Work Product, which carries the link.
   */
  featureId: string | null;
  // Drizzle returns numeric columns as strings to preserve precision.
  storyPoints: string | null;
  estimateHours: string | null;
  todoHours: string | null;
  actualHours: string | null;
  acceptanceCriteria: string | null;
  notes: string | null;
  releaseNotes: string | null;
  isBlocked: boolean;
  blockedReason: string | null;
  rank: string;
  customFields: Record<string, unknown>;
  createdBy: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  // P3.4 — Defect-specific fields
  severity: string | null;
  foundInEnvironment: string | null;
  foundInReleaseId: string | null;
  rootCause: string | null;
  resolution: string | null;
  devOwnerId: string | null;
  defectState: string | null;
  fixedInBuild: string | null;
}

export interface WorkItemFilters {
  type?: WorkItemType;
  statusId?: string;
  scheduleState?: WorkItemScheduleState;
  priority?: WorkItemPriority;
  /**
   * Filter by assignee. A UUID matches that user; the {@link UNASSIGNED_FILTER}
   * sentinel matches work items with no owner (assignee IS NULL).
   */
  assigneeId?: string;
  /**
   * Filter by Dev Owner, the same way as {@link WorkItemFilters.assigneeId} including the
   * {@link UNASSIGNED_FILTER} sentinel — `P2-BL-FR-004` and `P2-IS-FR-024` (BA `c42df59`) add Dev
   * Owner beside Owner in both grids' filter sets. Independent of `assigneeId`: an item can be
   * narrowed by either or both.
   */
  devOwnerId?: string;
  teamId?: string;
  iterationId?: string;
  releaseId?: string;
  parentId?: string;
  /** Free-text search: item_key exact (case-insensitive) or title ILIKE. */
  q?: string;
  /**
   * Manage Filters (P2-BL-FR-005/006, AC-8) — the "ID" column's text filter.
   * Case-insensitive substring on `item_key`. Deliberately SEPARATE from `q`:
   * P2-BL-TS-015 requires quick search to keep working independently of the
   * Manage Filters set, so the two are ANDed rather than sharing one param.
   */
  itemKey?: string;
  /** Manage Filters — the "Name" column's text filter (substring on `title`). */
  title?: string;
  /**
   * Manage Filters — the "Est" column's number filter: exact match on
   * `story_points`. Carried as the same fixed(2) string Drizzle uses for the
   * numeric column, so the comparison never round-trips through a float.
   */
  planEstimate?: string;
  /** Explicit backlog sort column. Omit to use the default rank order. */
  sortBy?: WorkItemSortBy;
  sortDirection?: 'asc' | 'desc';
}

/**
 * Sortable backlog columns. Mirrors the Iteration Status list
 * ({@link IterationStatusSortBy}) so the two work-item grids stay consistent.
 * `planEstimate` maps to `story_points`. Enum columns (`scheduleState`,
 * `priority`) sort by their semantic Postgres enum declaration order.
 */
export type WorkItemSortBy =
  | 'rank'
  | 'itemKey'
  | 'type'
  | 'title'
  | 'scheduleState'
  | 'priority'
  | 'planEstimate'
  | 'assignee'
  | 'devOwner';

/**
 * Whitelist of backlog sort fields accepted from the `sort` query param — Phase 2/01 §167.
 *
 * `assignee` and `devOwner` sort by the OWNER'S NAME, joined, not by the uuid the row stores: a
 * uuid order is arbitrary to every reader, which is why they were withheld until the read models
 * joined the name (`ownerNameJoins`). The keyset therefore seeks on the same
 * `coalesce(display_name, email)` expression the grid renders, so paging cannot disagree with the
 * order on a user who has no display name.
 *
 * Two fields the BA lists there are still absent, for reasons rather than by omission:
 *  - `iteration` — the Backlog is DEFINED by `iteration_id IS NULL` (`listBacklog`), so every row's
 *    value is the same and the sort could only ever be a no-op.
 *  - `release` — needs a `releases` join this query does not carry; it is a real gap, not a rule.
 */
export const BACKLOG_SORT_FIELDS = [
  'rank',
  'itemKey',
  'type',
  'title',
  'scheduleState',
  'priority',
  'planEstimate',
  'assignee',
  'devOwner',
] as const satisfies readonly WorkItemSortBy[];

export interface CreateWorkItemInput {
  id: string;
  workspaceId: string;
  projectId: string;
  itemKey: string;
  type: WorkItemType;
  title: string;
  description?: string;
  statusId: string;
  scheduleState?: WorkItemScheduleState;
  flowState?: WorkItemScheduleState;
  priority: WorkItemPriority;
  assigneeId?: string;
  reporterId?: string;
  parentId?: string;
  teamId?: string;
  iterationId?: string;
  releaseId?: string;
  storyPoints?: string;
  /**
   * SU-06 only, and the ONE path that may set it at birth.
   *
   * `trg_sync_accepted_date` stamps `now()` when an item BECOMES accepted and COALESCEs an explicit
   * value, so passing the Split timestamp here is what makes SU-BR-09's "`[Unfinished]`'s
   * `accepted_date` IS the Split timestamp" true rather than "within a few milliseconds of it". Every
   * other create leaves it undefined and lets the trigger decide.
   */
  acceptedDate?: Date;
  estimateHours?: string;
  todoHours?: string;
  actualHours?: string;
  acceptanceCriteria?: string;
  notes?: string;
  releaseNotes?: string;
  rank: string;
  createdBy: string;
  // P3.4 — Defect-specific fields
  severity?: string | null;
  foundInEnvironment?: string | null;
  foundInReleaseId?: string | null;
  rootCause?: string | null;
  resolution?: string | null;
  devOwnerId?: string | null;
  defectState?: string | null;
  fixedInBuild?: string | null;
}

export interface UpdateWorkItemInput {
  title?: string;
  description?: string | null;
  statusId?: string;
  scheduleState?: WorkItemScheduleState;
  flowState?: WorkItemScheduleState;
  priority?: WorkItemPriority;
  assigneeId?: string | null;
  reporterId?: string | null;
  parentId?: string | null;
  teamId?: string | null;
  iterationId?: string | null;
  releaseId?: string | null;
  /** Link (or `null` to unlink) this Story/Defect to a Feature. */
  featureId?: string | null;
  storyPoints?: string | null;
  estimateHours?: string | null;
  todoHours?: string | null;
  actualHours?: string | null;
  acceptanceCriteria?: string | null;
  notes?: string | null;
  releaseNotes?: string | null;
  isBlocked?: boolean;
  blockedReason?: string | null;
  rank?: string;
  customFields?: Record<string, unknown>;
  /** Set by the service on every mutation for audit/activity attribution. */
  updatedBy?: string;
  // P3.4 — Defect-specific fields
  severity?: string | null;
  foundInEnvironment?: string | null;
  foundInReleaseId?: string | null;
  rootCause?: string | null;
  resolution?: string | null;
  devOwnerId?: string | null;
  defectState?: string | null;
  fixedInBuild?: string | null;
}

/** Aggregated task time totals for the Tasks-tab totals row. */
export interface TaskTotals {
  taskCount: number;
  estimateHours: number;
  todoHours: number;
  actualHours: number;
}

/** A single row for the Home "My Work" widget — an item assigned to the actor,
 *  with its project key/name resolved. Bounded + priority-ordered server-side. */
export interface MyWorkItem {
  id: string;
  itemKey: string;
  type: WorkItemType;
  title: string;
  scheduleState: WorkItemScheduleState;
  priority: WorkItemPriority;
  projectId: string;
  projectKey: string;
  projectName: string;
}

/** Workspace-wide counts for the Home summary strip — computed in one batched
 *  query set (no per-project fan-out), so totals are exact regardless of scale. */
export interface WorkspaceSummary {
  activeProjects: number;
  openWorkItems: number;
  activeSprints: number;
  blockedItems: number;
  openDefects: number;
  assignedToMe: number;
}

/**
 * One row of the Story REFERENCE feed — the picker behind a Defect's `Parent Story` field.
 *
 * Deliberately NOT a `WorkItem`: a picker needs a key, a title and the project it binds in, and
 * shipping the whole record would put every Story field (estimates, owner, dates) into a feed whose
 * audience is only "may I link to this?".
 */
export interface StoryOption {
  id: string;
  itemKey: string;
  title: string;
  projectId: string;
}

/**
 * Cap on that feed, because it is unpaged.
 *
 * A picker is read whole (`SearchableSelect` filters client-side), so there is no cursor to hand
 * back; the cap is a memory guard, not a page. Ordered by `item_key`, so the truncation — if a
 * project ever grows past it — is at the far end of a total order rather than arbitrary.
 */
export const STORY_OPTIONS_LIMIT = 500;
