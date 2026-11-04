import type { CursorPayload, PagedResult } from '@platform';
import type {
  IterationStatusMetrics,
  IterationStatusItem,
  IterationStatusFilters,
} from '../iteration-status.types';
import type { TeamReadScope } from '../team-read-scope';

export const ITERATION_STATUS_REPOSITORY = Symbol('ITERATION_STATUS_REPOSITORY');

/**
 * Read-model over `work_items` for the Iteration Status screen. All queries are
 * scoped to a single iteration and workspace; nothing here mutates work items.
 */
/** Metrics computed directly from work items (before iteration-derived fields). */
export type RawIterationMetrics = Pick<
  IterationStatusMetrics,
  'totalPlanEstimate' | 'acceptedPoints' | 'defectCount' | 'taskCount' | 'activeTaskCount'
>;

/**
 * `scope` is REQUIRED on both methods, not optional with an "unrestricted" default.
 *
 * The strip above the grid and the grid itself are two queries over one population, and a metric
 * computed over a wider population than the rows below it is the defect this repo keeps re-learning
 * (CLAUDE.md: "Eligibility must be counted in the SAME scope as the measurement"). An optional
 * parameter makes forgetting it a silent widening on whichever of the two the next caller misses; a
 * required one makes it a compile error.
 */
export interface IIterationStatusRepository {
  /** Aggregate metrics across the non-deleted items assigned to the iteration that `scope` admits. */
  getMetrics(
    iterationId: string,
    workspaceId: string,
    scope: TeamReadScope,
  ): Promise<RawIterationMetrics>;
  /** Paginated story/defect list assigned to the iteration, with task rollups, narrowed by `scope`. */
  listItems(
    iterationId: string,
    workspaceId: string,
    filters: IterationStatusFilters,
    args: { limit: number; cursor: CursorPayload | null },
    scope: TeamReadScope,
  ): Promise<PagedResult<IterationStatusItem>>;
  /**
   * The workspace's calendar: its time zone (for "today") and its working days (ISO 1 = Mon …
   * 7 = Sun). A workspace with no settings row gets the column defaults, UTC and Mon–Fri.
   */
  getWorkspaceCalendar(workspaceId: string): Promise<WorkspaceCalendar>;
}

export interface WorkspaceCalendar {
  timeZone: string;
  workingDays: number[];
}
