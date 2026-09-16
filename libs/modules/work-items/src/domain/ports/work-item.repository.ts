import type { CursorPayload, PagedResult, DbExecutor } from '@platform';
import type { IterationState } from '../../../../../../db/schema/enums';
import type {
  WorkItem,
  CreateWorkItemInput,
  UpdateWorkItemInput,
  WorkItemFilters,
  TaskTotals,
  MyWorkItem,
  WorkspaceSummary,
  StoryOption,
} from '../work-item.types';
import type { TeamReadScope, ProjectTeamScope } from '../team-read-scope';

export const WORK_ITEM_REPOSITORY = Symbol('WORK_ITEM_REPOSITORY');

/** Project/team scope of an iteration — used to validate assignment. */
export interface IterationScope {
  projectId: string;
  teamId: string | null;
}

/**
 * One row of {@link IWorkItemRepository.listProjectIterations}.
 *
 * Structurally the same shape as `SplitTargetCandidate` in `application/split-story.ts` and
 * deliberately declared there as well: the pure helper must not import a persistence port to state
 * what it needs, and the port must not import an application module. TypeScript's structural typing
 * makes the two compatible without either depending on the other, and `getSplitPreview` passes rows
 * straight from one to the other — so a field added here and not there is a compile error at that
 * call site rather than a silent divergence.
 */
export interface SplitIterationCandidateRow {
  id: string;
  name: string;
  iterationKey: string | null;
  state: IterationState;
  startDate: string | null;
  endDate: string | null;
  projectId: string;
  teamId: string | null;
}

export interface IWorkItemRepository {
  findById(id: string, workspaceId: string, executor?: DbExecutor): Promise<WorkItem | null>;
  /** Resolve a work item by its workspace-unique item key (work_items→tasks fallback). */
  findByKey(itemKey: string, workspaceId: string): Promise<WorkItem | null>;
  /** Non-deleted work items for the given ids, scoped to a workspace. */
  findByIds(ids: string[], workspaceId: string): Promise<WorkItem[]>;
  /** Project/team scope of an iteration (any workspace guard is applied by caller). */
  findIterationScope(iterationId: string, workspaceId: string): Promise<IterationScope | null>;
  /**
   * Every Iteration in one project, with the window and state Split's Target-Iteration filter needs
   * (`filterSplitTargets`). Unpaged and unfiltered by state deliberately: the ELIGIBILITY rule lives
   * in one pure function, and a repository that pre-narrowed the set would be a second, invisible
   * copy of it — the fault class `listStoryOptions`' docblock describes one entity over.
   *
   * Ordered `start_date` then `id` so the earliest-first contract {@link earliestTarget} relies on is
   * a TOTAL order (query-ordering ratchet: the last key must be unique). A dateless iteration sorts
   * with the NULLs and is refused by the filter, not here.
   */
  listProjectIterations(
    projectId: string,
    workspaceId: string,
  ): Promise<SplitIterationCandidateRow[]>;
  /**
   * A release's display NAME, for the Split preview's read-only Release line.
   *
   * A NAME source, not an offer list — `CLAUDE.md`'s feeds rule: "An OFFER list and a NAME source are
   * two different feeds. Offers narrow on purpose; names must not." The Story already holds the
   * `release_id`, so resolving its name must not depend on the caller being able to READ releases
   * (`release:view`, which an Editor does not hold) — that is exactly how a released item came to
   * render as unscheduled.
   */
  findReleaseName(releaseId: string, workspaceId: string): Promise<string | null>;
  /** Project id owning a release, or null if not found for this workspace. */
  /**
   * A portfolio item's type + archived state, for validating a Story's Feature link.
   *
   * Not scoped by project on purpose: Rally lets a Story roll up to a Feature in another project,
   * and the portfolio rollup matches on `feature_id` alone.
   */
  findPortfolioItemLinkTarget(
    portfolioItemId: string,
    workspaceId: string,
  ): Promise<{ type: string; archived: boolean } | null>;

  findReleaseProject(releaseId: string, workspaceId: string): Promise<string | null>;
  /** Bulk-assign iteration (null unassigns) to the given ids. All-or-nothing via caller UoW. */
  assignIteration(
    ids: string[],
    iterationId: string | null,
    workspaceId: string,
    updatedBy: string,
    executor?: DbExecutor,
  ): Promise<void>;
  /** Bulk-assign release (null unassigns) to the given ids. All-or-nothing via caller UoW. */
  assignRelease(
    ids: string[],
    releaseId: string | null,
    workspaceId: string,
    updatedBy: string,
    executor?: DbExecutor,
  ): Promise<void>;
  /**
   * `teamScope` is the EDITOR Team boundary and is REQUIRED on every one of these reads, deliberately:
   * an optional scope is one a new call site forgets, and this module's own history is what that costs
   * (see `team-read-scope.ts`). It is NOT `filters.teamId` — that is the reader's own display filter,
   * which may narrow the boundary and can never widen it.
   */
  listByProject(
    projectId: string,
    workspaceId: string,
    filters: WorkItemFilters,
    args: { limit: number; cursor: CursorPayload | null },
    teamScope: TeamReadScope,
  ): Promise<PagedResult<WorkItem>>;
  /** Backlog: story + defect only (tasks excluded), keyset paginated. */
  listBacklog(
    projectId: string,
    workspaceId: string,
    filters: WorkItemFilters,
    args: { limit: number; cursor: CursorPayload | null },
    teamScope: TeamReadScope,
  ): Promise<PagedResult<WorkItem>>;
  /**
   * The Story REFERENCE feed — every Story in one project a Defect may name as its Parent Story.
   *
   * NOT `listBacklog` with `type: 'story'`, which is what the three pickers used to call: that
   * list is defined by `iteration_id IS NULL` (the Backlog SCREEN's own rule), so every Story
   * pulled into a sprint vanished from the picker while `updateWorkItem` went on accepting it —
   * a feed that offered strictly less than the server allows. Unpaged and unfiltered by schedule
   * state for the same reason: the picker must offer exactly what the write path accepts.
   *
   * Team-scoped like every other read over work rows (BA ruling 2026-08-17 names pickers
   * explicitly): an Editor cannot READ another team's Story, so offering one would produce a link
   * whose target their own detail page then refuses.
   */
  listStoryOptions(
    projectId: string,
    workspaceId: string,
    teamScope: TeamReadScope,
  ): Promise<StoryOption[]>;
  /**
   * Direct child tasks of a parent work item, ordered by rank.
   *
   * A Task's team is resolved `coalesce(task, parent, iteration)` here — the three tiers
   * `getScopedTaskHours` and Team Status already use — because a Task's own `team_id` only DEFAULTS to
   * its parent's (SRS P1-04) and is commonly unset on a Story that carries one.
   */
  listTasksByParent(
    parentId: string,
    workspaceId: string,
    teamScope: TeamReadScope,
  ): Promise<WorkItem[]>;
  /**
   * Take a transaction-scoped advisory lock on one (project, parent) rank scope.
   *
   * Deriving a new rank is a read-modify-write, so it is only safe if the read
   * and the insert are serialised against other creates in the same scope. Call
   * this first, then {@link findMaxRank} with the SAME executor.
   */
  lockRankScope(
    scope: { projectId: string; parentId?: string | null },
    executor: DbExecutor,
  ): Promise<void>;
  /**
   * Highest existing rank in the given scope (siblings under a parent task
   * list, or top-level project items when parentId is omitted). Null if the
   * scope is empty. Used to append newly-created items at the end of order.
   *
   * Pass the caller's transaction as `executor`: read on the pool while the
   * insert happens in a transaction and the max is stale by construction.
   */
  findMaxRank(
    scope: { projectId: string; parentId?: string | null },
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<string | null>;
  /**
   * Server-side aggregated totals for a parent's tasks (totals row).
   *
   * Same `coalesce(task, parent, iteration)` team scope as {@link listTasksByParent}, and it has to be
   * the same: a totals row summing tasks the grid above it does not show is the disagreement
   * "eligibility must be counted in the SAME scope as the measurement" names.
   */
  getTaskTotals(
    parentId: string,
    workspaceId: string,
    teamScope: TeamReadScope,
  ): Promise<TaskTotals>;
  /**
   * The two Home aggregates, and the ONE sentinel both share with every other cross-project read:
   * `readableProjectIds` is `null` for UNRESTRICTED and an array — possibly EMPTY — for restricted.
   * The distinction is the whole point: a caller that flattens `null` to `[]` fails closed, and one
   * that flattens `[]` to "all" leaks the workspace. See `AccessService.listReadableProjectIds`.
   *
   * Both were scoped by `workspace_id` alone, which is what made Home the one surface that still
   * reported a project after a Workspace Admin removed the reader's access to it (GAP-P4-RBAC-003,
   * AC4) — against Phase 4 `02_Roles_Permissions/SRS.md` §2.2 and §6, which put an unassigned
   * project out of navigation, selectors, search AND results. `listHealthByWorkspace` in the projects
   * module already took the sentinel for exactly this reason and is the model.
   *
   * `teamScoped` is the SECOND boundary, added by the BA ruling of 2026-08-17. These two reads are
   * CROSS-project, so the Team scope cannot be one answer: it is resolved per project, and only the
   * projects the caller is an `editor` in appear in the array. A row from a project named there must
   * carry one of that project's listed teams (`teamIds: []` therefore contributes nothing); a row from
   * any other readable project is unrestricted. An EMPTY array means no project is narrowed at all —
   * an admin or a caller who is an editor nowhere — never "narrow everything".
   */
  listMyWork(
    workspaceId: string,
    userId: string,
    args: { limit: number },
    readableProjectIds: string[] | null,
    teamScoped: ProjectTeamScope[],
  ): Promise<MyWorkItem[]>;
  getWorkspaceSummary(
    workspaceId: string,
    userId: string,
    readableProjectIds: string[] | null,
    teamScoped: ProjectTeamScope[],
  ): Promise<WorkspaceSummary>;
  /**
   * Census of a parent's LIVE child task states, for the parent schedule-state reconciliation.
   *
   * A census rather than the `areAllTasksComplete` boolean it replaced: Rally derives the parent from
   * the whole set — all Defined, all Completed, otherwise In Progress — so "are they all complete"
   * cannot answer two of the three cases. `total` is 0 for a parent with no tasks, which the caller
   * treats as "nothing to derive from" rather than as an empty truth.
   */
  taskStateCounts(
    parentId: string,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<{ total: number; defined: number; completed: number }>;
  /**
   * BA F1 — auto-accept an iteration when EVERY assigned Story/Defect is in an
   * accepted state and there is at least one such item. Idempotent: only a
   * 'committed' iteration transitions to 'accepted'. Returns true if it flipped.
   */
  autoAcceptIterationIfComplete(
    iterationId: string,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<boolean>;
  create(input: CreateWorkItemInput, executor?: DbExecutor): Promise<WorkItem>;
  update(
    id: string,
    input: UpdateWorkItemInput,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<WorkItem>;
  softDelete(id: string, workspaceId: string, executor?: DbExecutor): Promise<void>;
  reorderItems(
    items: Array<{ id: string; rank: string }>,
    workspaceId: string,
    executor?: DbExecutor,
  ): Promise<void>;
  addLabel(workItemId: string, labelId: string, workspaceId: string): Promise<void>;
  removeLabel(workItemId: string, labelId: string, workspaceId: string): Promise<void>;
  listLabels(workItemId: string): Promise<Array<{ id: string; name: string; color: string }>>;
  listMilestones(workItemId: string): Promise<Array<{ id: string; name: string }>>;
  setMilestones(workItemId: string, milestoneIds: string[]): Promise<void>;
}
