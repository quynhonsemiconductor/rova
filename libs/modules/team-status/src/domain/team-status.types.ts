/**
 * Team Status domain types — P3.1
 *
 * Dense grouped table of task-level rows per iteration, grouped by
 * owner/member. Sourced from Mini_Rally_pj Phase 3 SRS §8.2 (legacy physical path, do not rename).
 */

/** Normalized task-state values used in Team Status UI. */
export type TeamTaskState = 'Defined' | 'In-Progress' | 'Completed';

/** Work product parent type. */
export type WorkProductType = 'Story' | 'Defect' | 'Feature';

/** Owner info embedded in response. */
export interface TeamStatusOwner {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Work product (parent work item) reference. */
export interface TeamStatusWorkProduct {
  id: string;
  key: string;
  type: WorkProductType;
  title: string;
  status: string;
}

/** Release reference. */
export interface TeamStatusRelease {
  id: string;
  name: string;
}

/** One task row inside a member group. */
export interface TeamStatusTaskRow {
  id: string;
  taskKey: string;
  title: string;
  displayName: string;
  workProduct: TeamStatusWorkProduct;
  release: TeamStatusRelease | null;
  state: TeamTaskState;
  /**
   * `null` = never entered, which is a different claim from `0` (the repo-wide rule for typed
   * numbers — `useFieldCommit.saveNumber` clears a blank cell to `null`). The row passes it
   * through so a cleared cell reads `--` rather than a zero nobody typed; only the GROUP and
   * TOTALS sums treat it as 0, because a sum has to be a number.
   */
  estimateHours: number | null;
  todoHours: number | null;
  actualHours: number | null;
  owner: TeamStatusOwner;
  rank: string | null;
}

/**
 * Roster member identity — every active member of the iteration's team (or the
 * project when the iteration is not team-scoped). Used to render zero-task
 * members alongside members who have tasks (Rally parity).
 */
export interface TeamStatusRosterMember {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** One member group (aggregated over that member's tasks). */
export interface TeamStatusMemberGroup {
  owner: TeamStatusOwner;
  capacityHours: number;
  taskCount: number;
  estimateHours: number;
  todoHours: number;
  actualHours: number;
  progressPercent: number;
  tasks: TeamStatusTaskRow[];
}

/** Totals row for the table. */
export interface TeamStatusTotals {
  capacityHours: number;
  estimateHours: number;
  todoHours: number;
  actualHours: number;
}

/** Top-level response DTO shape. */
export interface TeamStatusResponse {
  projectId: string;
  teamId?: string | null;
  iteration: {
    id: string;
    name: string;
    startDate: string | null;
    endDate: string | null;
  };
  totals: TeamStatusTotals;
  groups: TeamStatusMemberGroup[];
}

/** Input for updating member capacity. */
export interface UpdateCapacityInput {
  projectId: string;
  teamId?: string;
  iterationId: string;
  userId: string;
  capacityHours: number;
}

/** Input for updating a task from Team Status. */
/**
 * The Team Status TASK route writes Task Name and Task State only (SRS §9.3). Hours are edited on
 * this screen too (US-145), but through `PATCH /v1/work-items/:id` and `WorkItemsService` — never
 * here — so the once-only Estimate → To Do copy stays in one place. Passing hours or an owner here
 * is a compile error rather than a silently-dropped field. See `UpdateTeamTaskSchema`.
 */
export interface UpdateTaskFromTeamStatusInput {
  title?: string;
  state?: TeamTaskState;
}

/** Raw DB row shape for task-level query (internal). */
export interface RawTeamStatusTaskRow {
  id: string;
  itemKey: string;
  title: string;
  type: string;
  scheduleState: string;
  parentId: string | null;
  parentKey: string | null;
  parentType: string | null;
  parentTitle: string | null;
  parentScheduleState: string | null;
  releaseId: string | null;
  releaseName: string | null;
  assigneeId: string | null;
  assigneeDisplayName: string | null;
  assigneeAvatarUrl: string | null;
  estimateHours: string | null;
  todoHours: string | null;
  actualHours: string | null;
  rank: string;
}
